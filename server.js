// 📌 Import required modules
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

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
  PAYPAL_API = "https://api-m.paypal.com",
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

// 🔧 Utility: Save Stripe subscription to Firestore
async function updateSubscriptionInFirestore(uid, subscriptionId, tier, status, platform, customerIdentifier = null) {
  const userRef = admin.firestore().collection("users").doc(uid);
  const isActive = status === "active" && subscriptionId;
  const normalizedTier = isActive ? tier : "Free";

  const userData = {
    subscription_tier: normalizedTier,
    subscriptionStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (platform === "stripe") {
    userData.stripeSubscriptionId = subscriptionId || null;
    userData.payerEmail = customerIdentifier || null;
    userData.platform = "stripe";
    userData.provider = "stripe";
  }

  // 🟢 Set credits appropriately for premium tiers
  if (normalizedTier.toLowerCase() === "grandmaster") {
    userData.credits = 100; // -1 indicates unlimited in app logic
  } else if (normalizedTier.toLowerCase() === "champ") {
    userData.credits = 10; // Example: allocate fixed credits for Champ
  } else {
    userData.credits = 2;
  }

  await userRef.set(userData, { merge: true });

  await userRef.collection("subscriptions").doc("current").set({
    tier: normalizedTier,
    status: status,
    platform: platform,
    provider: platform,
    subscriptionId: subscriptionId || null,
    payerEmail: customerIdentifier || null,
    timestamp: Date.now()
  });
}

// ✅ Stripe Webhook Handler (must use raw body)
app.post("/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("⚠️ Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ Immediately acknowledge to avoid timeout
  res.status(200).json({ received: true });

  // 🔄 Handle in background
  (async () => {
    const db = admin.firestore();
    const data = event.data.object;

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const subId = data.subscription;
          const uid = data.metadata?.uid;
          const tier = data.metadata?.tier;
          const customerId = data.customer;

          if (uid && subId && tier) {
            const customer = await stripe.customers.retrieve(customerId);
            const payerEmail = customer.email;

            const conflictQuery = await admin.firestore().collection("users")
              .where("payerEmail", "==", payerEmail)
              .get();

            if (!conflictQuery.empty && conflictQuery.docs.some(doc => doc.id !== uid)) {
              await stripe.subscriptions.del(subId); // cancel duplicate subscription
              console.warn(`🚫 Duplicate email ${payerEmail}. Subscription ${subId} cancelled.`);
              return;
            }

            await updateSubscriptionInFirestore(uid, subId, tier, "active", "stripe", payerEmail);
            console.log(`✅ Stripe checkout.session.completed processed for user ${uid}`);
          }
          break;
        }

        case "invoice.paid":
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const sub = data;
          const uid = sub.metadata?.uid;
          const tier = sub.metadata?.tier;
          const status = sub.status;
          const customer = sub.customer;

          if (uid && tier && customer) {
            await updateSubscriptionInFirestore(uid, sub.id, tier, status, "stripe", customer);
            console.log(`✅ Stripe subscription updated: user=${uid}, status=${status}`);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const sub = data;
          const uid = sub.metadata?.uid;

          if (uid) {
            await updateSubscriptionInFirestore(uid, null, "Free", "cancelled", "stripe");
            console.log(`🔄 Stripe subscription cancelled for user ${uid}`);
          }
          break;
        }

        case "invoice.payment_failed": {
              const sub = data.subscription;
              const customer = data.customer;

              const subscription = await stripe.subscriptions.retrieve(sub);
              const uid = subscription.metadata?.uid;
              const tier = subscription.metadata?.tier;

              if (uid && tier && sub) {
                await updateSubscriptionInFirestore(uid, sub, tier, "payment_failed", "stripe", customer);
                console.log(`❌ Stripe payment failed: user=${uid}`);
              }
              break;
            }

        default:
          console.log(`ℹ️ Unhandled Stripe event: ${event.type}`);
      }
    } catch (error) {
      console.error("❌ Stripe webhook handling failed:", error);
    }

  })();
});

app.use(bodyParser.json());

// ✅ Serve assetlinks.json
app.use(
  "/.well-known",
  express.static(path.join(__dirname, "public", ".well-known"))
);

// ✅ PayPal return & cancel URLs
// ✅ PayPal success redirect handler (unchanged)
app.get("/paypal/subscription/success", (req, res) => {
  const { subscription_id = "", tier = "", plan_id = "" } = req.query;

  console.log("✅ PayPal success redirect triggered");
  console.log(`👉 Received query params: subscription_id=${subscription_id}, tier=${tier}, plan_id=${plan_id}`);

  const redirectUrl = `alarmreminderapp://subscription/success?subscription_id=${encodeURIComponent(
    subscription_id
  )}&tier=${encodeURIComponent(tier)}&plan_id=${encodeURIComponent(plan_id)}`;

  console.log(`➡️ Redirecting to app (PayPal): ${redirectUrl}`);

  res.redirect(302, redirectUrl);
});

// ✅ New POST route for notifying backend of success (required for Android to succeed)
app.post("/api/paypal/subscription/:subscriptionId/success", (req, res) => {
  const { subscriptionId } = req.params;
  const { planId, tier } = req.body;

  if (!planId || !tier) {
    console.warn(`⚠️ Missing planId or tier in body. planId=${planId}, tier=${tier}`);
    return res.status(400).json({ error: "Missing planId or tier" });
  }

  console.log(`✅ Success notification received for subscription ${subscriptionId}`);
  console.log(`📦 Tier: ${tier}, Plan ID: ${planId}`);

  // 🔁 Optionally update internal state, log to DB, etc.

  res.sendStatus(200);
});

app.get("/subscription/cancel", (req, res) => {
  console.log("➡️ Redirecting to cancel deep link.");
  res.redirect(302, "alarmreminderapp://subscription/cancel");
});

app.post("/api/paypal/subscription/:subscriptionId/cancel", async (req, res) => {
  const { subscriptionId } = req.params;
  const { reason = "User requested cancellation" } = req.body;

  try {
    const accessToken = await getPayPalAccessToken();

    const response = await axios.post(
      `${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}/cancel`,
      { reason },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (response.status === 204) {
      console.log(`✅ Subscription ${subscriptionId} successfully canceled.`);
      res.sendStatus(204);
    } else {
      console.warn(`⚠️ Unexpected response status: ${response.status}`);
      res.status(response.status).json({ error: "Unexpected response from PayPal." });
    }
  } catch (error) {
    console.error("❌ Error canceling subscription:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to cancel subscription." });
  }
});


// 🔹 PayPal Access Token
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString(
    "base64"
  );
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
    console.error(
      "❌ Failed to get PayPal token:",
      error.response?.data || error.message
    );
    throw new Error("PayPal authentication failed");
  }
}

// 🔹 Create PayPal Subscription
async function createPayPalSubscription(planId, userId, tier, userEmail) {
  console.log("📦 Creating PayPal subscription...");
  console.log(
    `📨 Input: planId=${planId}, userId=${userId}, tier=${tier}, userEmail=${userEmail}`
  );

  const accessToken = await getPayPalAccessToken();

  const returnUrl = `https://paypal-api-khmg.onrender.com/paypal/subscription/success?tier=${encodeURIComponent(tier)}&plan_id=${encodeURIComponent(planId)}`;
  const cancelUrl = `https://paypal-api-khmg.onrender.com/subscription/cancel`;

  console.log(`🔁 returnUrl: ${returnUrl}`);
  console.log(`🔁 cancelUrl: ${cancelUrl}`);

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
    const approvalUrl = response.data.links.find(
      (link) => link.rel === "approve"
    )?.href;
    console.log(
      `✅ Subscription created: id=${response.data.id}, approvalUrl=${approvalUrl}`
    );

    return {
      subscriptionId: response.data.id,
      approvalUrl,
    };
  } catch (error) {
    console.error(
      "❌ Failed to create PayPal subscription:",
      error.response?.data || error.message
    );
    throw new Error("Failed to create subscription");
  }
}

// ✅ Routes
app.get("/", (req, res) => {
  res.send("🚀 Server is running. PayPal API ready.");
});

// Define valid plan IDs
const validPlanIds = {
  "Champ": "P-86R0994779441710RM65UV3A",
  "Grandmaster": "P-7WC176265L221313GM7Y3DXI"
};

app.post("/api/paypal/subscription", async (req, res) => {
  try {
    const { planId, userId, tier, userEmail } = req.body;
    console.log("📨 Received /api/paypal/subscription request");
    console.log(`Body: planId=${planId}, userId=${userId}, tier=${tier}, userEmail=${userEmail}`);

    // Validate required fields
    if (!planId || !userId || !tier) {
      console.warn("⚠️ Missing required subscription data");
      return res.status(400).json({ error: "Missing planId, userId, or tier." });
    }

    // Validate that the planId matches the expected value for the tier
    if (validPlanIds[tier] !== planId) {
      console.warn(`⚠️ Invalid planId for tier ${tier}`);
      return res.status(400).json({ error: "Invalid planId for the specified tier." });
    }

    // Proceed to create the PayPal subscription
    const result = await createPayPalSubscription(planId, userId, tier, userEmail);
    res.json(result);
  } catch (error) {
    console.error("❌ Error in /api/paypal/subscription:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🔹 Webhook Handler
app.post("/paypal/webhook", async (req, res) => {
  try {
    const { event_type, resource } = req.body;

    // 🧾 Log entire payload for debugging
    console.log("📬 Full webhook payload:", JSON.stringify(req.body, null, 2));
    if (!event_type || !resource || !resource.id) {
      console.warn("⚠️ Incomplete webhook payload.");
      return res.sendStatus(200);
    }

    const subscriptionId = resource.id;
    const planId = resource.plan_id || "N/A";
    const userId = resource.custom_id || "N/A";
    const payerEmail = resource?.subscriber?.email_address;

    console.log(`📬 Webhook received: ${event_type}`);
    console.log(`🔍 Subscription ID: ${subscriptionId}`);
    console.log(`🔍 Plan ID: ${planId}`);
    console.log(`🔍 User ID: ${userId}`);
    console.log(`🔍 Payer Email: ${payerEmail}`);

    const db = admin.firestore();
    const userRef = userId !== "N/A" ? db.collection("users").doc(userId) : null;

    switch (event_type) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
        if (payerEmail && userRef) {
          // 🛑 Prevent duplicate PayPal email across accounts
          const existingUsers = await db.collection("users")
            .where("payerEmail", "==", payerEmail)
            .get();

          const conflict = existingUsers.docs.find(doc => doc.id !== userId);
          if (conflict) {
            console.warn(`🚫 PayPal email ${payerEmail} already used by user ${conflict.id}. Canceling subscription ${subscriptionId}.`);

            const token = await getPayPalAccessToken();
            await axios.post(
              `${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}/cancel`,
              { reason: "Duplicate PayPal email used by another account." },
              {
                headers: {
                  "Authorization": `Bearer ${token}`,
                  "Content-Type": "application/json"
                }
              }
            );

            return res.sendStatus(200);
          }

          // ✅ No conflict, save subscription
          const tier = planId.includes("GM") ? "Grandmaster" : "Champ";
          await userRef.set({
            subscriptionId,
            planId,
            subscriptionStatus: "active",
            payerEmail,
            subscription_tier: tier,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          await userRef.collection("subscriptions").doc("current").set({
            status: "active",
            tier,
            planId,
            subscriptionId,
            payerEmail,
            timestamp: Date.now()
          });

          console.log(`✅ Subscription activated and saved for user: ${userId}`);
        }
        break;

      case "BILLING.SUBSCRIPTION.CANCELLED":
        if (userRef) {
          await userRef.set({
            subscriptionStatus: "cancelled",
            subscription_tier: "Free",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          await userRef.collection("subscriptions").doc("current").set({
            status: "cancelled",
            tier: "Free",
            planId: null,
            subscriptionId: null,
            timestamp: Date.now()
          });

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

      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
        if (userRef) {
          await userRef.set({
            subscriptionStatus: "payment_failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });

          console.log(`❌ Payment failed for user: ${userId}`);

          // 🔁 Automatically cancel after failure
          try {
            const token = await getPayPalAccessToken();
            await axios.post(
              `${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}/cancel`,
              { reason: "Auto-cancelled after failed payment" },
              {
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json"
                }
              }
            );
            console.log(`🛑 Auto-cancelled PayPal subscription ${subscriptionId} after payment failure`);
          } catch (err) {
            console.error("❌ Failed to auto-cancel PayPal subscription:", err.message);
          }
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

// ✅ Stripe Checkout Session Creation
app.post("/api/stripe/create-subscription", async (req, res) => {
  const { uid, email, priceId, tier } = req.body || {};
  console.log("📩 Stripe subscription request body:", req.body);

  if (!uid || !email || !priceId || !tier) {
    console.warn("🛑 Missing Stripe subscription parameters:", { uid, email, priceId, tier });
    return res.status(400).json({ error: "Missing uid, email, priceId or tier" });
  }

  try {
    let customer;
    const customers = await stripe.customers.list({ email, limit: 1 });

    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({ email, metadata: { uid } });
    }

    const session = await stripe.checkout.sessions.create({
        customer: customer.id,
        payment_method_types: ["card"],
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        customer_update: { address: "auto" },
        subscription_data: { metadata: { uid, tier } },
        success_url: `https://paypal-api-khmg.onrender.com/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `https://paypal-api-khmg.onrender.com/stripe/cancel`,
      });

    console.log(`✅ Stripe session created for ${uid}: ${session.url}`);
    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error("❌ Stripe subscription error:", err);
    res.status(500).json({ error: "Failed to create Stripe subscription." });
  }
});

// ✅ Stripe Checkout Success Redirect
app.get("/stripe/success", (req, res) => {
  const sessionId = req.query.session_id;
  console.log("✅ Stripe Checkout succeeded. Session ID:", sessionId);

  const redirectUri = `alarmreminderapp://subscription/success?session_id=${encodeURIComponent(sessionId)}`;
  return res.redirect(302, redirectUri);
});

// ✅ Stripe Checkout Cancel Redirect
app.post("/api/stripe/subscription/:subscriptionId/cancel", async (req, res) => {
  const { subscriptionId } = req.params;
  if (!subscriptionId || !subscriptionId.startsWith("sub_")) {
    return res.status(400).json({ error: "Invalid or missing subscriptionId" });
  }
  try {
    const deleted = await stripe.subscriptions.del(subscriptionId, { prorate: false });
    console.log(`✅ Stripe subscription ${subscriptionId} canceled, status: ${deleted.status}`);
    return res.sendStatus(204);
  } catch (err) {
    console.error(`❌ Failed to cancel Stripe subscription ${subscriptionId}:`, err);
    return res.status(500).json({ error: "Failed to cancel subscription." });
  }
});

// 🔍 Retrieve Stripe subscription status (used by Android client)
app.get("/api/stripe/subscription/:subscriptionId", async (req, res) => {
  const { subscriptionId } = req.params;
  if (!subscriptionId || !subscriptionId.startsWith("sub_")) {
    return res.status(400).json({ error: "Invalid or missing subscriptionId" });
  }
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    res.json({
      id: subscription.id,
      status: subscription.status,
      metadata: subscription.metadata || {},
      current_period_end: subscription.current_period_end
    });
  } catch (error) {
    if (error.code === "resource_missing") {
      return res.status(404).json({ error: "Subscription not found in Stripe" });
    }
    console.error("❌ Failed to fetch Stripe subscription:", error);
    res.status(500).json({ error: "Could not fetch subscription details" });
  }
});

// 🔍 GET: Fetch Stripe subscriptions by customer email
app.get("/api/stripe/subscriptions/by-email", async (req, res) => {
  const { email } = req.query;

  console.log("📩 Incoming request to /api/stripe/subscriptions/by-email");
  if (!email) {
    console.warn("⚠️ Missing 'email' query parameter.");
    return res.status(400).json({ error: "Missing email parameter" });
  }

  console.log(`🔍 Searching for Stripe customer with email: ${email}`);

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });

    if (!customers.data.length) {
      console.warn(`⚠️ No Stripe customer found for email: ${email}`);
      return res.status(404).json({ error: "No customer found with this email" });
    }

    const customerId = customers.data[0].id;
    console.log(`✅ Found Stripe customer ID: ${customerId}`);

    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      expand: ["data.latest_invoice"]
    });

    console.log(`📦 Found ${subscriptions.data.length} subscriptions for customer ${customerId}`);

    const result = subscriptions.data.map((sub) => ({
      id: sub.id,
      status: sub.status,
      metadata: sub.metadata || {},
      latest_invoice: {
        status: sub.latest_invoice?.status || null,
        paid: sub.latest_invoice?.paid || false
      }
    }));

    console.log("✅ Subscription details prepared. Sending response.");
    res.json(result);
  } catch (err) {
    console.error("❌ Failed to get subscriptions by email:", err);
    res.status(500).json({ error: "Failed to retrieve subscriptions" });
  }
});

// ✅ Start Express Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
