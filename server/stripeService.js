/**
 * AdLands - Stripe Service
 * Handles customer creation, subscriptions, and webhook processing.
 * Uses Stripe Invoicing for monthly territory sponsorship billing.
 */

const { getFirestore } = require("./firebaseAdmin");
const HexTierSystem = require("../js/admin/hexTierSystem");

/** @type {import('stripe').default | null} */
let stripe = null;

function init() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn("[Stripe] STRIPE_SECRET_KEY not set — Stripe disabled");
    return null;
  }
  stripe = require("stripe")(key);
  console.log("[Stripe] Initialized");
  return stripe;
}

function getStripe() {
  return stripe;
}

function isEnabled() {
  return stripe !== null;
}

/**
 * Calculate monthly price for a territory in cents.
 * Uses HexTierSystem for accurate per-tile tier pricing and cluster discounts.
 * @param {Object} sponsor - Sponsor record from SponsorStore
 * @param {Map} tierMap - Tile index → tier ID map (from WorldGenerator)
 * @returns {number} Total monthly price in cents
 */
function calculateMonthlyPriceCents(sponsor, tierMap) {
  // Moon territories — price by moon index
  if (sponsor.territoryType === "moon") {
    const moonIndex = sponsor.inquiryData?.moonIndex ?? 0;
    const price = HexTierSystem.MOON_PRICES[moonIndex] || HexTierSystem.MOON_PRICES[0];
    return Math.round(price * 100);
  }

  // Billboard territories — price by orbit tier
  if (sponsor.territoryType === "billboard") {
    const bbIndex = sponsor.inquiryData?.billboardIndex ?? 0;
    const price = HexTierSystem.getBillboardPrice(bbIndex);
    return Math.round(price * 100);
  }

  // Hex territories — per-tile tier pricing with cluster discount
  const tiles = sponsor.cluster?.tileIndices || [];
  if (tiles.length === 0 || !tierMap) return 0;

  const pricing = HexTierSystem.calculatePricing(tiles, tierMap);
  return Math.round(pricing.total * 100);
}

/**
 * Find or create a Stripe customer for the given email.
 * @param {string} email
 * @param {string} [name]
 * @returns {Promise<string>} Stripe customer ID
 */
async function findOrCreateCustomer(email, name) {
  if (!stripe) throw new Error("Stripe not initialized");

  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0].id;

  const customer = await stripe.customers.create({
    email,
    name: name || undefined,
  });
  return customer.id;
}

/**
 * Create a Stripe subscription for a territory.
 * Sends an invoice email to the customer automatically.
 * @param {Object} params
 * @param {string} params.customerId - Stripe customer ID
 * @param {string} params.sponsorId - SponsorStore ID
 * @param {string} params.territoryId - Firestore territory ID (for player territories)
 * @param {string} params.description - Human-readable territory description
 * @param {number} params.amountCents - Monthly price in cents
 * @returns {Promise<import('stripe').Stripe.Subscription>}
 */
async function createSubscription({ customerId, sponsorId, territoryId, description, amountCents }) {
  if (!stripe) throw new Error("Stripe not initialized");

  const product = await stripe.products.create({
    name: `AdLands Territory: ${description}`,
    metadata: { sponsorId, territoryId: territoryId || "" },
  });

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: 7,
    items: [{
      price_data: {
        currency: "usd",
        product: product.id,
        unit_amount: amountCents,
        recurring: { interval: "month" },
      },
    }],
    metadata: { sponsorId, territoryId: territoryId || "" },
  });

  return subscription;
}

/**
 * Cancel a Stripe subscription (e.g. when admin deactivates territory).
 * @param {string} subscriptionId
 */
async function cancelSubscription(subscriptionId) {
  if (!stripe || !subscriptionId) return;
  try {
    await stripe.subscriptions.cancel(subscriptionId);
  } catch (e) {
    console.warn("[Stripe] Cancel subscription failed:", e.message);
  }
}

/**
 * Construct and verify a Stripe webhook event.
 * @param {Buffer} rawBody - Raw request body
 * @param {string} signature - stripe-signature header
 * @returns {import('stripe').Stripe.Event}
 */
function constructWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error("Stripe not initialized");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not set");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/**
 * Save Stripe IDs to Firestore territory record.
 */
async function saveStripeIds(territoryId, stripeCustomerId, stripeSubscriptionId) {
  if (!territoryId) return;
  try {
    const db = getFirestore();
    await db.collection("territories").doc(territoryId).update({
      stripeCustomerId,
      stripeSubscriptionId,
    });
  } catch (e) {
    console.warn("[Stripe] Failed to save Stripe IDs to Firestore:", e.message);
  }
}

module.exports = {
  init,
  getStripe,
  isEnabled,
  calculateMonthlyPriceCents,
  findOrCreateCustomer,
  createSubscription,
  cancelSubscription,
  constructWebhookEvent,
  saveStripeIds,
};
