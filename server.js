// 📌 Import required modules
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config(); // Load environment variables

// 📌 Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// 📌 Middleware
app.use(cors()); // Enable cross-origin requests
app.use(bodyParser.json()); // Parse JSON request body

// 📌 Load PayPal credentials from .env
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_API = process.env.PAYPAL_API || "https://api-m.sandbox.paypal.com"; // Default to Sandbox

// 🔍 Debugging: Log environment variable status
console.log("🔍 PayPal Client ID:", PAYPAL_CLIENT_ID ? "Loaded ✅" : "Not Found ❌");
console.log("🔍 PayPal Secret:", PAYPAL_SECRET ? "Loaded ✅" : "Not Found ❌");
console.log("🔍 PayPal API:", PAYPAL_API);
console.log("✅ Active PayPal Credentials:");
console.log("PAYPAL_CLIENT_ID:", process.env.PAYPAL_CLIENT_ID);
console.log("PAYPAL_SECRET:", process.env.PAYPAL_SECRET ? "Loaded ✅" : "Not Found ❌");
console.log("PAYPAL_API:", process.env.PAYPAL_API);

// 🔹 Function to get PayPal Access Token
async function getPayPalAccessToken() {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
        console.error("❌ Missing PayPal credentials in .env file!");
        throw new Error("Missing PayPal credentials");
    }

    try {
        console.log("🔄 Requesting PayPal Access Token...");

        const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");

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

        console.log("✅ PayPal Access Token Retrieved Successfully");
        return response.data.access_token;
    } catch (error) {
        console.error("❌ Failed to get PayPal access token:", error.response?.data || error.message);
        throw new Error("PayPal authentication failed");
    }
}

// 🔹 Function to create a PayPal Subscription
async function createPayPalSubscription(planId) {
    if (!planId) {
        throw new Error("planId is required");
    }

    const accessToken = await getPayPalAccessToken();
    console.log("🔑 PayPal Access Token Retrieved");

    try {
        const response = await axios.post(
            `${PAYPAL_API}/v1/billing/subscriptions`,
            {
                plan_id: planId,
                application_context: {
                    return_url: "https://paypal-api-khmg.onrender.com/subscription/success",
                    cancel_url: "https://paypal-api-khmg.onrender.com/subscription/cancel"
                },
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );

        console.log("✅ PayPal Subscription Created Successfully");
        return response.data.links.find((link) => link.rel === "approve").href;
    } catch (error) {
        console.error("❌ PayPal Subscription Error:", error.response?.data || error.message);
        throw new Error("Failed to create subscription");
    }
}

// ✅ Default Route (Fixes 'Cannot GET /' issue)
app.get("/", (req, res) => {
    res.send("🚀 Server is running! PayPal API is ready.");
});

// ✅ POST request to create a subscription
app.post("/create-subscription", async (req, res) => {
    console.log("📩 Received POST request to create subscription");

    try {
        const { planId } = req.body;
        if (!planId) {
            return res.status(400).json({ error: "planId is required" });
        }

        const approvalUrl = await createPayPalSubscription(planId);
        res.json({ approvalUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ GET request to create a subscription (Alternative)
app.get("/create-subscription", async (req, res) => {
    console.log("📩 Received GET request to create subscription");

    try {
        const planId = req.query.planId;
        if (!planId) {
            return res.status(400).json({ error: "planId is required" });
        }

        const approvalUrl = await createPayPalSubscription(planId);
        res.json({ approvalUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ✅ Handle PayPal Success Redirect
app.get("/subscription/success", (req, res) => {
    const { subscription_id, plan_id, tier } = req.query;

    if (!subscription_id || !plan_id) {
        return res.status(400).json({ error: "Missing subscription_id or plan_id" });
    }

    console.log("🎉 PayPal Subscription Successful:", { subscription_id, plan_id, tier });

    res.json({
        message: "Subscription successful!",
        subscription_id,
        plan_id,
        tier: tier || "Not Provided"
    });
});

// ✅ Handle PayPal Cancellation Redirect
app.get("/subscription/cancel", (req, res) => {
    console.log("❌ PayPal Subscription Canceled");
    res.json({ message: "Subscription canceled." });
});

// ✅ Start the Express server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
