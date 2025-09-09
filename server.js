// 📌 Import required modules
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

// 🔐 Firebase Admin Initialization
const {
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  GOOGLE_APPLICATION_CREDENTIALS_JSON, // full JSON string stored in env
  PLAY_PACKAGE_NAME, // must be set in Render env vars
  PORT = 3000,
} = process.env;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("❌ Missing Firebase Admin SDK environment variables.");
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 🔹 Google API Setup (using JSON from env variable)
if (!GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  throw new Error("❌ Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env variable.");
}

const serviceAccount = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);

// 🔹 Auth clients
const billingAuth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/androidpublisher"],
});

const integrityAuth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/playintegrity"],
});

const playdeveloper = google.androidpublisher("v3");
const playIntegrity = google.playintegrity("v1");

// 🔧 Firestore updater for Google Play subscriptions
async function updateFirestoreWithGooglePlay(uid, productId, purchaseToken, status) {
  const userRef = admin.firestore().collection("users").doc(uid);
  const tier =
    productId === "genevolut_grandmaster"
      ? "Grandmaster"
      : productId === "genevolut_champ"
      ? "Champ"
      : "Free";

  const normalizedTier = status === "active" ? tier : "Free";

  await userRef.set(
    {
      subscription_tier: normalizedTier,
      subscriptionStatus: status,
      provider: "google_play",
      productId,
      purchaseToken,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await userRef.collection("subscriptions").doc("current").set({
    tier: normalizedTier,
    status,
    productId,
    purchaseToken,
    timestamp: Date.now(),
  });
}

// ✅ Verify subscription with Google Play Developer API + Play Integrity
app.post("/api/googleplay/verify", async (req, res) => {
  const { packageName, productId, purchaseToken, userId, integrityToken } = req.body;

  if (!packageName || !productId || !purchaseToken || !userId || !integrityToken) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    // 1️⃣ Verify Play Integrity token
    const integrityClient = await integrityAuth.getClient();
    const integrityResponse = await playIntegrity.v1.decodeIntegrityToken({
      packageName,
      resource: { integrityToken },
      auth: integrityClient,
    });

    const decoded = integrityResponse.data.tokenPayloadExternal || {};
    const deviceIntegrity = decoded.deviceIntegrity?.deviceRecognitionVerdict || [];
    const appIntegrity = decoded.appIntegrity?.appRecognitionVerdict || [];
    const licensingVerdict = decoded.accountDetails?.appLicensingVerdict;

    const isTrusted =
      deviceIntegrity.includes("MEETS_DEVICE_INTEGRITY") &&
      appIntegrity.includes("PLAY_RECOGNIZED") &&
      licensingVerdict === "LICENSED";

    if (!isTrusted) {
      console.warn("⚠️ Integrity check failed:", { deviceIntegrity, appIntegrity, licensingVerdict });
      return res.status(403).json({ error: "Device or app integrity check failed." });
    }

    // 2️⃣ Verify subscription with Play Developer API
    const billingClient = await billingAuth.getClient();
    const result = await playdeveloper.purchases.subscriptions.get({
      packageName,
      subscriptionId: productId,
      token: purchaseToken,
      auth: billingClient,
    });

    const data = result.data;
    const expiryTime = parseInt(data.expiryTimeMillis || "0", 10);
    const paymentState = data.paymentState; // 0: pending, 1: received
    const cancelReason = data.cancelReason; // 0: user canceled, 1: system, etc.

    let status = "cancelled";
    if (expiryTime > Date.now()) {
      status = paymentState === 1 && !cancelReason ? "active" : "pending";
    }

    await updateFirestoreWithGooglePlay(userId, productId, purchaseToken, status);

    res.json({
      status,
      expiryTimeMillis: expiryTime,
      paymentState,
      cancelReason,
      integrity: { deviceIntegrity, appIntegrity, licensingVerdict },
    });
  } catch (err) {
    console.error("❌ Google Play verify error:", err.response?.data || err.message);
    res.status(500).json({ error: "Verification failed." });
  }
});

// ✅ Cancel subscription via Google Play
app.post("/api/googleplay/cancel", async (req, res) => {
  const { productId, purchaseToken, userId } = req.body;

  if (!productId || !purchaseToken || !userId) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    const authClient = await billingAuth.getClient();
    await playdeveloper.purchases.subscriptions.cancel({
      packageName: PLAY_PACKAGE_NAME,
      subscriptionId: productId,
      token: purchaseToken,
      auth: authClient,
    });

    // Update Firestore immediately
    await updateFirestoreWithGooglePlay(userId, productId, purchaseToken, "cancelled");

    res.json({ status: "cancelled" });
  } catch (err) {
    console.error("❌ Cancel subscription error:", err.response?.data || err.message);
    res.status(500).json({ error: "Cancellation failed." });
  }
});

// ✅ RTDN (Real-time Developer Notifications) webhook
app.post("/api/googleplay/rtnd", async (req, res) => {
  try {
    const message = JSON.parse(
      Buffer.from(req.body.message.data, "base64").toString("utf8")
    );
    console.log("📬 RTDN message:", message);

    const { subscriptionNotification } = message;
    if (!subscriptionNotification) return res.sendStatus(200);

    const { subscriptionId, purchaseToken } = subscriptionNotification;

    // Map purchaseToken -> userId
    const subsRef = admin.firestore().collectionGroup("subscriptions");
    const snapshot = await subsRef.where("purchaseToken", "==", purchaseToken).get();

    if (!snapshot.empty) {
      const userId = snapshot.docs[0].ref.parent.parent.id;

      // Re-verify with Play Developer API
      const billingClient = await billingAuth.getClient();
      const result = await playdeveloper.purchases.subscriptions.get({
        packageName: PLAY_PACKAGE_NAME,
        subscriptionId,
        token: purchaseToken,
        auth: billingClient,
      });

      const data = result.data;
      const expiryTime = parseInt(data.expiryTimeMillis || "0", 10);
      const paymentState = data.paymentState;
      const cancelReason = data.cancelReason;

      let status = "cancelled";
      if (expiryTime > Date.now()) {
        status = paymentState === 1 && !cancelReason ? "active" : "pending";
      }

      await updateFirestoreWithGooglePlay(userId, subscriptionId, purchaseToken, status);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ RTDN handler error:", err.message);
    res.sendStatus(200); // Always ACK
  }
});

// ✅ Serve assetlinks.json for Android App Links
app.use(
  "/.well-known",
  express.static(path.join(__dirname, "public", ".well-known"))
);

// ✅ Root route
app.get("/", (req, res) => {
  res.send("🚀 Server is running. Google Play Billing API + Play Integrity ready.");
});

// ✅ Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
