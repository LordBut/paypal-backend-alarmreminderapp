// 📌 Import required modules
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

// 🔐 Firebase Admin Initialization
const {
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_API = "https://api-m.sandbox.paypal.com",
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

// ✅ Serve assetlinks.json
app.use("/.well-known", express.static(path.join(__dirname, "public", ".well-known")));

// ✅ PayPal return & cancel URLs
app.get("/paypal/subscription/success", (req, res) => {
  const { subscription_id = "", tier = "", plan_id = "" } = req.query;
  const redirectUrl = `alarmreminderapp://subscription/success?subscription_id=${encodeURIComponent(subscription_id)}&tier=${encodeURIComponent(tier)}&plan_id=${encodeURIComponent(plan_id)}`;
  console.log(`➡️ Redirecting to app (PayPal): ${redirectUrl}`);
  res.redirect(302, redirectUrl);
});

app.get("/subscription/cancel", (req, res) => {
  console.log("➡️ Redirecting to cancel deep link.");
  res.redirect(302, "alarmreminderapp://subscription/cancel");
});

// 🔹 PayPal Access Token
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");
  try {
    const response = await axios.post(
      `${PAYPAL_API}/v1/oauth2/token`,
      "grant_type=client_credentials",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${auth}`,
        },
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error("❌ Failed to get PayPal token:", error.response?.data || error.message);
    throw new Error("PayPal authentication failed");
  }
}

// 🔹 Create PayPal Subscription
async function createPayPalSubscription(planId, userId, tier, userEmail) {
  const accessToken = await getPayPalAccessToken();
  const returnUrl = `https://paypal-api-khmg.onrender.com/paypal/subscription/success?tier=${encodeURIComponent(tier)}&plan_id=${encodeURIComponent(planId)}`;
  const cancelUrl = `https://paypal-api-khmg.onrender.com/subscription/cancel`;

  try {
    const response = await axios.post(
      `${PAYPAL_API}/v1/billing/subscriptions`,
      {
        plan_id: planId,
        custom_id: userId,
        subscriber: {
          email_address: userEmail || "unknown@example.com",
        },
        application_context: {
          brand_name: "Alarm Reminder App",
          locale: "en-US",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const approvalUrl = response.data.links.find(link => link.rel === "approve")?.href;
    return {
      subscriptionId: response.data.id,
      approvalUrl,
    };
  } catch (error) {
    console.error("❌ Failed to create PayPal subscription:", error.response?.data || error.message);
    throw new Error("Failed to create subscription");
  }
}

// ✅ Routes
app.get("/", (req, res) => {
  res.send("🚀 Server is running. PayPal API ready.");
});

app.post("/api/paypal/subscription", async (req, res) => {
  try {
    const { planId, userId, tier, userEmail } = req.body;
    if (!planId || !userId || !tier) {
      return res.status(400).json({ error: "Missing planId, userId, or tier." });
    }
    const result = await createPayPalSubscription(planId, userId, tier, userEmail);
    res.json(result);
  } catch (error) {
    console.error("❌ Error in /create-subscription:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Webhook Handler
app.post("/paypal/webhook", async (req, res) => {
  try {
    const { event_type, resource } = req.body;
    if (!event_type || !resource || !resource.id) {
      console.warn("⚠️ Incomplete webhook payload.");
      return res.sendStatus(200);
    }

    const subscriptionId = resource.id;
    const planId = resource.plan_id || "";
    const userId = resource.custom_id || "";

    console.log(`📬 Webhook received: ${event_type} for subscription ${subscriptionId} (User: ${userId})`);

    const userRef = userId ? admin.firestore().collection("users").doc(userId) : null;

    switch (event_type) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
        if (userRef) {
          await userRef.set({
            subscriptionId,
            planId,
            subscriptionStatus: "active",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`✅ Subscription activated for user: ${userId}`);
        }
        break;

      case "BILLING.SUBSCRIPTION.CANCELLED":
        if (userRef) {
          await userRef.set({
            subscriptionStatus: "cancelled",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`🔄 Subscription cancelled for user: ${userId}`);
        }
        break;

      case "BILLING.SUBSCRIPTION.SUSPENDED":
        if (userRef) {
          await userRef.set({
            subscriptionStatus: "suspended",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`⏸️ Subscription suspended for user: ${userId}`);
        }
        break;

      case "BILLING.SUBSCRIPTION.EXPIRED":
        if (userRef) {
          await userRef.set({
            subscriptionStatus: "expired",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`⌛ Subscription expired for user: ${userId}`);
        }
        break;

      case "PAYMENT.SALE.COMPLETED":
        console.log(`💰 Payment completed for subscription: ${subscriptionId}`);
        break;

      default:
        console.log(`ℹ️ Unhandled event type: ${event_type}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Error:", err.stack || err.message);
    res.sendStatus(200);
  }
});

// ✅ Retrieve PayPal Access Token
app.get("/api/paypal/token", async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    res.json({ access_token: accessToken });
  } catch (error) {
    console.error("❌ Failed to retrieve PayPal token:", error.message);
    res.status(500).json({ error: "Failed to retrieve PayPal token" });
  }
});

// ✅ Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
