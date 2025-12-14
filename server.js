// ================================
// server.js — Google Play Billing (Audit-Only Backend)
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
app.use(bodyParser.json());

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
// Helper: Write AUDIT record ONLY
// ================================
async function writeAuditRecord({
  userId,
  productId,
  purchaseToken,
  status,
  source,
  extra = {},
}) {
  await db.collection("purchase_audits").add({
    userId,
    productId,
    purchaseToken,
    status,
    source,
    extra,
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ================================
// VERIFY ENDPOINT (Audit-Only)
// ================================
app.post("/api/googleplay/verify", async (req, res) => {
  const { packageName, productId, purchaseToken, userId, integrityToken } = req.body;

  if (!packageName || !productId || !purchaseToken || !userId || !integrityToken) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    // ----------------------------
    // 1️⃣ Play Integrity
    // ----------------------------
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
        extra: { deviceIntegrity, appIntegrity, licensingVerdict },
      });

      return res.status(403).json({ error: "Integrity check failed." });
    }

    // ----------------------------
    // 2️⃣ Play Developer API
    // ----------------------------
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
      status = paymentState === 1 && cancelReason == null ? "active" : "pending";
    }

    // ----------------------------
    // 3️⃣ AUDIT ONLY (NO ENTITLEMENT)
    // ----------------------------
    await writeAuditRecord({
      userId,
      productId,
      purchaseToken,
      status,
      source: "verify",
      extra: {
        expiry,
        paymentState,
        cancelReason,
        deviceIntegrity,
        appIntegrity,
        licensingVerdict,
      },
    });

    return res.json({
      status,
      expiryTimeMillis: expiry,
      paymentState,
      cancelReason,
    });
  } catch (err) {
    console.error("❌ Verify error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Verification failed." });
  }
});

// ================================
// RTDN (Audit-Only)
// ================================
app.post("/api/googleplay/rtnd", async (req, res) => {
  try {
    const message = JSON.parse(
      Buffer.from(req.body.message.data, "base64").toString("utf8")
    );

    const sub = message.subscriptionNotification;
    if (!sub) return res.sendStatus(200);

    const { subscriptionId, purchaseToken, notificationType } = sub;

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
      status = paymentState === 1 && cancelReason == null ? "active" : "pending";
    }

    await writeAuditRecord({
      userId: null, // optional lookup later
      productId: subscriptionId,
      purchaseToken,
      status,
      source: "rtdn",
      extra: {
        notificationType,
        expiry,
        paymentState,
        cancelReason,
      },
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
  res.send("🚀 Google Play Billing backend (audit-only) running.");
});

// ================================
// Start Server
// ================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
