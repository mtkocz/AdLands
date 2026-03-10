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
 * Build detailed invoice line items for a territory.
 * @param {Object} sponsor - Sponsor record from SponsorStore
 * @param {Map} tierMap - Tile index → tier ID map (from WorldGenerator)
 * @returns {{ lineItems: Array<{name: string, unitAmountCents: number, quantity: number}>, discountPercent: number }}
 */
function buildInvoiceLineItems(sponsor, tierMap) {
  // Moon territories
  if (sponsor.territoryType === "moon") {
    const moonIndex = sponsor.inquiryData?.moonIndex ?? 0;
    const price = HexTierSystem.MOON_PRICES[moonIndex] || HexTierSystem.MOON_PRICES[0];
    const label = HexTierSystem.MOON_LABELS[moonIndex] || `Moon ${moonIndex + 1}`;
    return {
      lineItems: [{ name: label, unitAmountCents: Math.round(price * 100), quantity: 1 }],
      discountPercent: 0,
    };
  }

  // Billboard territories
  if (sponsor.territoryType === "billboard") {
    const bbIndex = sponsor.inquiryData?.billboardIndex ?? 0;
    const price = HexTierSystem.getBillboardPrice(bbIndex);
    const label = HexTierSystem.getBillboardLabel(bbIndex);
    return {
      lineItems: [{ name: label, unitAmountCents: Math.round(price * 100), quantity: 1 }],
      discountPercent: 0,
    };
  }

  // Hex territories — per-tier line items with cluster discount
  const tiles = sponsor.cluster?.tileIndices || [];
  if (tiles.length === 0 || !tierMap) return { lineItems: [], discountPercent: 0 };

  const pricing = HexTierSystem.calculatePricing(tiles, tierMap);
  const lineItems = [];

  for (const tierId of HexTierSystem.RENTABLE_TIERS) {
    const count = pricing.byTier[tierId];
    if (!count) continue;
    const tier = HexTierSystem.TIERS[tierId];
    lineItems.push({
      name: `${tier.name} Hex`,
      unitAmountCents: Math.round(tier.price * 100),
      quantity: count,
    });
  }

  return { lineItems, discountPercent: pricing.discount };
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
 * Create a Stripe subscription for a territory with itemized line items.
 * @param {Object} params
 * @param {string} params.customerId - Stripe customer ID
 * @param {string} params.sponsorId - SponsorStore ID
 * @param {string} params.territoryId - Firestore territory ID (for player territories)
 * @param {string} params.description - Human-readable territory description
 * @param {Array<{name: string, unitAmountCents: number, quantity: number}>} params.lineItems
 * @param {number} [params.discountPercent] - Cluster discount percentage (0-30)
 * @returns {Promise<import('stripe').Stripe.Subscription>}
 */
async function createSubscription({ customerId, sponsorId, territoryId, description, lineItems, discountPercent }) {
  if (!stripe) throw new Error("Stripe not initialized");

  // Create a product per line item
  const items = [];
  for (const item of lineItems) {
    const product = await stripe.products.create({
      name: `AdLands: ${item.name}`,
      metadata: { sponsorId, territoryId: territoryId || "" },
    });
    items.push({
      price_data: {
        currency: "usd",
        product: product.id,
        unit_amount: item.unitAmountCents,
        recurring: { interval: "month" },
      },
      quantity: item.quantity,
    });
  }

  // Create a coupon for cluster discount if applicable
  const subscriptionParams = {
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: 7,
    items,
    description: `AdLands Territory: ${description}`,
    metadata: { sponsorId, territoryId: territoryId || "" },
  };

  if (discountPercent > 0) {
    const coupon = await stripe.coupons.create({
      percent_off: discountPercent,
      duration: "forever",
      name: HexTierSystem.getDiscountLabel(discountPercent) || "Cluster Discount",
    });
    subscriptionParams.discounts = [{ coupon: coupon.id }];
  }

  return stripe.subscriptions.create(subscriptionParams);
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
  buildInvoiceLineItems,
  findOrCreateCustomer,
  createSubscription,
  cancelSubscription,
  constructWebhookEvent,
  saveStripeIds,
};
