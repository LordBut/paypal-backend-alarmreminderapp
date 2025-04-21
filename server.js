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

// 📌 Initialize Express
const app = express();

// 📌 Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Serve assetlinks.json from .well-known
app.use("/.well-known", express.static(path.join(__dirname, "public", ".well-known")));

// ✅ Routes to respond to deep link paths
app.get("/subscription/success", (req, res) => {
  res.send("✅ Subscription success callback received.");
});

app.get("/subscription/cancel", (req, res) => {
  res.send("❌ Subscription cancelled.");
});

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

  const returnUrl = `https://paypal-api-khmg.onrender.com/subscription/success?tier=${encodeURIComponent(tier)}&plan_id=${planId}`;
  const cancelUrl = `https://paypal-api-khmg.onrender.com/subscription/cancel`;

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
      const { id: subscriptionId, plan_id: planId, custom_id: userId } = event.resource;

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
