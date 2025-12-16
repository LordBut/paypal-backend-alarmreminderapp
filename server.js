// ================================
// server.js — Google Play Billing (RTDN Entitlement Backend)
// ================================

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

// ================================
// Environment
// ================================
const {
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  GOOGLE_APPLICATION_CREDENTIALS_JSON,
  PLAY_PACKAGE_NAME,
  PORT = 3000,
} = process.env;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  throw new Error("❌ Missing Firebase Admin SDK environment variables.");
}
if (!GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  throw new Error("❌ Missing GOOGLE_APPLICATION_CREDENTIALS_JSON.");
}

// ================================
// Firebase Admin Init
// ================================
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// ================================
// Express Setup
// ================================
const app = express();
app.use(cors());
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ================================
// Google API Clients
// ================================
const serviceAccount = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);

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

// ================================
// Helper: Update Firestore Entitlement
// ================================
async function updateFirestoreEntitlement({
  userId,
  productId,
  purchaseToken,
  status,
}) {
  const userRef = db.collection("users").doc(userId);

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

  await userRef
    .collection("subscriptions")
    .doc("current")
    .set(
      {
        tier: normalizedTier,
        status,
        productId,
        purchaseToken,
        timestamp: Date.now(),
      },
      { merge: true }
    );
}

// ================================
// Helper: Write Audit Record
// ================================
async function writeAuditRecord(data) {
  await db.collection("purchase_audits").add({
    ...data,
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ================================
// VERIFY ENDPOINT (Integrity + Audit ONLY — NO ENTITLEMENT)
// ================================
app.post("/api/googleplay/verify", async (req, res) => {
  const { packageName, productId, purchaseToken, userId, integrityToken } = req.body;

  if (!packageName || !productId || !purchaseToken || !userId || !integrityToken) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    // 1️⃣ Integrity
    const integrityClient = await integrityAuth.getClient();
    const integrityResp = await playIntegrity.v1.decodeIntegrityToken({
      packageName,
      resource: { integrityToken },
      auth: integrityClient,
    });

    const payload = integrityResp.data.tokenPayloadExternal || {};
    const deviceIntegrity = payload.deviceIntegrity?.deviceRecognitionVerdict || [];
    const appIntegrity = payload.appIntegrity?.appRecognitionVerdict || [];
    const licensingVerdict = payload.accountDetails?.appLicensingVerdict;

    const trusted =
      deviceIntegrity.includes("MEETS_DEVICE_INTEGRITY") &&
      appIntegrity.includes("PLAY_RECOGNIZED") &&
      licensingVerdict === "LICENSED";

    if (!trusted) {
      await writeAuditRecord({
        userId,
        productId,
        purchaseToken,
        status: "integrity_failed",
        source: "verify",
      });
      return res.status(403).json({ error: "Integrity check failed." });
    }

    // 2️⃣ Play Billing
    const billingClient = await billingAuth.getClient();
    const result = await playdeveloper.purchases.subscriptions.get({
      packageName: PLAY_PACKAGE_NAME,
      subscriptionId: productId,
      token: purchaseToken,
      auth: billingClient,
    });

    const data = result.data;
    const expiry = parseInt(data.expiryTimeMillis || "0", 10);
    const paymentState = data.paymentState;
    const cancelReason = data.cancelReason;

    let status = "cancelled";
    if (expiry > Date.now()) {
      status = paymentState === 1 && cancelReason == null
        ? "active"
        : "pending";
    }

    await writeAuditRecord({
      userId,
      productId,
      purchaseToken,
      status,
      source: "verify",
    });

    res.json({ status, expiryTimeMillis: expiry });
  } catch (err) {
    console.error("❌ Verify error:", err.message);
    res.status(500).json({ error: "Verification failed." });
  }
});

// ================================
// RTDN — ENTITLEMENT AUTHORITY
// ================================
app.post("/api/googleplay/rtnd", async (req, res) => {
  try {
    const message = JSON.parse(
      Buffer.from(req.body.message.data, "base64").toString("utf8")
    );

    const sub = message.subscriptionNotification;
    if (!sub) return res.sendStatus(200);

    const { subscriptionId, purchaseToken, notificationType } = sub;

    console.log("📬 RTDN received:", {
      subscriptionId,
      purchaseToken,
      notificationType,
    });

    // 🔁 IDEMPOTENCY CHECK
    const alreadyProcessed = await db
      .collection("purchase_audits")
      .where("purchaseToken", "==", purchaseToken)
      .where("source", "==", "rtdn")
      .limit(1)
      .get();

    if (!alreadyProcessed.empty) {
      console.log("🔁 RTDN already processed:", purchaseToken);
      return res.sendStatus(200);
    }

    // 🔎 Find user by purchaseToken
    const snap = await db
      .collectionGroup("subscriptions")
      .where("purchaseToken", "==", purchaseToken)
      .limit(1)
      .get();

    if (snap.empty) {
      console.warn("RTDN: No user found for token", purchaseToken);
      return res.sendStatus(200);
    }

    const userId = snap.docs[0].ref.parent.parent.id;

    // 🔁 Re-verify with Play
    const billingClient = await billingAuth.getClient();
    const result = await playdeveloper.purchases.subscriptions.get({
      packageName: PLAY_PACKAGE_NAME,
      subscriptionId,
      token: purchaseToken,
      auth: billingClient,
    });

    const data = result.data;
    const expiry = parseInt(data.expiryTimeMillis || "0", 10);
    const paymentState = data.paymentState;
    const cancelReason = data.cancelReason;

    let status = "cancelled";
    if (expiry > Date.now()) {
      status = paymentState === 1 && cancelReason == null
        ? "active"
        : "pending";
    }

    // ✅ UPDATE FIRESTORE (AUTHORITY)
    await updateFirestoreEntitlement({
      userId,
      productId: subscriptionId,
      purchaseToken,
      status,
    });

    // ✅ AUDIT (AFTER update)
    await writeAuditRecord({
      userId,
      productId: subscriptionId,
      purchaseToken,
      status,
      source: "rtdn",
      extra: { notificationType },
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ RTDN error:", err.message);
    res.sendStatus(200); // Always ACK
  }
});

// ================================
// Static & Root
// ================================
app.use(
  "/.well-known",
  express.static(path.join(__dirname, "public", ".well-known"))
);

app.get("/", (_, res) => {
  res.send("🚀 Google Play Billing RTDN backend running.");
});

// ================================
// Start Server
// ================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
