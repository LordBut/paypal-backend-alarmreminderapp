// 📌 Import required modules
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config(); // Load environment variables early

// 🔐 Firebase Admin Initialization using ENV JSON
if (!process.env.FIREBASE_ADMIN_SDK_JSON) {
  throw new Error("Missing FIREBASE_ADMIN_SDK_JSON in environment variables.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// 📌 Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// 📌 Middleware
app.use(cors());
app.use(bodyParser.json());

// 📌 Load PayPal credentials from .env
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_API = process.env.PAYPAL_API || "https://api-m.sandbox.paypal.com";

// 🧪 Debug log (for testing only, remove in production)
console.log("🟡 Loaded PayPal Credentials");
console.log("PAYPAL_CLIENT_ID:", PAYPAL_CLIENT_ID ? "[OK]" : "[MISSING]");
console.log("PAYPAL_SECRET:", PAYPAL_SECRET ? "[OK]" : "[MISSING]");
console.log("PAYPAL_API:", PAYPAL_API);

// 🔹 Get PayPal Access Token
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
async function createPayPalSubscription(planId, userId, tier) {
  const accessToken = await getPayPalAccessToken();

  const returnUrl = `alarmreminderapp://subscription/success?tier=${encodeURIComponent(tier)}&plan_id=${planId}`;
  const cancelUrl = `alarmreminderapp://subscription/cancel`;

  try {
    const response = await axios.post(
      `${PAYPAL_API}/v1/billing/subscriptions`,
      {
        plan_id: planId,
        custom_id: userId,
        application_context: {
          brand_name: "Alarm Reminder App",
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
    return approvalUrl;
  } catch (error) {
    console.error("❌ Failed to create PayPal subscription:", error.response?.data || error.message);
    throw new Error("Failed to create subscription");
  }
}

// ✅ Default route
app.get("/", (req, res) => {
  res.send("🚀 Server is running. PayPal API ready.");
});

// ✅ Create Subscription Route
app.post("/create-subscription", async (req, res) => {
  try {
    const { planId, userId, tier } = req.body;

    if (!planId || !userId || !tier) {
      return res.status(400).json({ error: "Missing planId, userId, or tier." });
    }

    const approvalUrl = await createPayPalSubscription(planId, userId, tier);
    res.json({ approvalUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ✅ PayPal Webhook Handler
app.post("/paypal/webhook", async (req, res) => {
  const event = req.body;
  console.log("📬 Webhook Event:", event.event_type);

  try {
    if (event.event_type === "BILLING.SUBSCRIPTION.ACTIVATED") {
      const subscriptionId = event.resource.id;
      const planId = event.resource.plan_id;
      const userId = event.resource.custom_id;

      if (userId) {
        await admin.firestore().collection("users").doc(userId).set({
          subscriptionId,
          planId,
          subscriptionStatus: "active",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`✅ Subscription stored for user: ${userId}`);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Error:", err.message);
    res.sendStatus(500);
  }
});

// ✅ Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
