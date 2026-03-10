/**
 * AdLands - Stripe Service
 * Handles customer creation, subscriptions, and webhook processing.
 * Uses Stripe Invoicing for monthly territory sponsorship billing.
 */

const { getFirestore } = require("./firebaseAdmin");

/** @type {import('stripe').default | null} */
let stripe = null;

/** Monthly price per hex by tier (in USD cents) */
const TIER_PRICES_CENTS = {
  HOTZONE: 1500,
  PRIME: 700,
  FRONTIER: 300,
};

/** Monthly price for moons and billboards (in USD cents) */
const MOON_PRICE_CENTS = 5000;
const BILLBOARD_PRICE_CENTS = 2500;

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
 * Calculate monthly price for a territory based on its tier breakdown.
 * @param {Object} sponsor - Sponsor record from SponsorStore
 * @param {Map|Object} [tierMap] - Tile index → tier ID map (optional, for hex pricing)
 * @returns {number} Total monthly price in cents
 */
function calculateMonthlyPriceCents(sponsor, tierMap) {
  // Moon territories
  if (sponsor.territoryType === "moon") return MOON_PRICE_CENTS;

  // Billboard territories
  if (sponsor.territoryType === "billboard") return BILLBOARD_PRICE_CENTS;

  // Hex territories — price by tier
  const tiles = sponsor.cluster?.tileIndices || [];
  if (tiles.length === 0) return 0;

  // If we have a tier map, calculate per-tile
  if (tierMap) {
    let total = 0;
    for (const idx of tiles) {
      const tier = tierMap.get ? tierMap.get(idx) : tierMap[idx];
      total += TIER_PRICES_CENTS[tier] || TIER_PRICES_CENTS.FRONTIER;
    }
    return total;
  }

  // Fallback: use sponsor's tierName for all tiles
  const pricePerTile = TIER_PRICES_CENTS[sponsor.tierName] || TIER_PRICES_CENTS.FRONTIER;
  return pricePerTile * tiles.length;
}

/**
 * Find or create a Stripe customer for the given email.
 * Stores the Stripe customer ID in Firestore for reuse.
 * @param {string} email
 * @param {string} [name]
 * @returns {Promise<string>} Stripe customer ID
 */
async function findOrCreateCustomer(email, name) {
  if (!stripe) throw new Error("Stripe not initialized");

  // Check if customer already exists in Stripe
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0].id;

  // Create new customer
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

  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: 7,
    items: [{
      price_data: {
        currency: "usd",
        product_data: {
          name: `AdLands Territory: ${description}`,
          metadata: { sponsorId, territoryId: territoryId || "" },
        },
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
  TIER_PRICES_CENTS,
  MOON_PRICE_CENTS,
  BILLBOARD_PRICE_CENTS,
};
