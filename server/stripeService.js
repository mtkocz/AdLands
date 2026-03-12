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
 * Build pre-discounted line items for a single territory.
 * Discount is baked into unit prices so Stripe total matches portal exactly.
 * @param {Object} sponsor - Sponsor record from SponsorStore
 * @param {Map} tierMap - Tile index → tier ID map
 * @param {Map} [adjacencyMap] - Tile adjacency map
 * @returns {{ lineItems: Array<{name: string, unitAmountCents: number, quantity: number}>, discountDescription: string }}
 */
function buildInvoiceLineItems(sponsor, tierMap, adjacencyMap) {
  if (sponsor.territoryType === "moon") {
    const moonIndex = sponsor.inquiryData?.moonIndex ?? 0;
    const price = HexTierSystem.MOON_PRICES[moonIndex] || HexTierSystem.MOON_PRICES[0];
    const label = HexTierSystem.MOON_LABELS[moonIndex] || `Moon ${moonIndex + 1}`;
    return { lineItems: [{ name: label, unitAmountCents: Math.round(price * 100), quantity: 1 }], discountDescription: "" };
  }

  if (sponsor.territoryType === "billboard") {
    const bbIndex = sponsor.inquiryData?.billboardIndex ?? 0;
    const price = HexTierSystem.getBillboardPrice(bbIndex);
    const label = HexTierSystem.getBillboardLabel(bbIndex);
    return { lineItems: [{ name: label, unitAmountCents: Math.round(price * 100), quantity: 1 }], discountDescription: "" };
  }

  const tiles = sponsor.cluster?.tileIndices || [];
  if (tiles.length === 0 || !tierMap) return { lineItems: [], discountDescription: "" };

  const pricing = HexTierSystem.calculatePricing(tiles, tierMap, adjacencyMap);
  const multiplier = pricing.discount > 0 ? (100 - pricing.discount) / 100 : 1;
  const lineItems = [];

  for (const tierId of HexTierSystem.RENTABLE_TIERS) {
    const count = pricing.byTier[tierId];
    if (!count) continue;
    const tier = HexTierSystem.TIERS[tierId];
    lineItems.push({
      name: `Territory (${pricing.totalHexes} hexes): ${tier.name}`,
      unitAmountCents: Math.round(tier.price * 100 * multiplier),
      quantity: count,
    });
  }

  const discountDescription = pricing.discount > 0
    ? `${pricing.totalHexes}-hex cluster: ${pricing.discount}% ${pricing.label || "discount"}`
    : "";

  return { lineItems, discountDescription };
}

/**
 * Build per-cluster line items for a group of sponsors (single subscription).
 * Each sponsor's territory is a separate cluster with its own discount.
 * @param {Object[]} sponsors - Array of sponsor records
 * @param {Map} tierMap - Tile index → tier ID map
 * @param {Map} [adjacencyMap] - Tile adjacency map
 * @returns {{ lineItems: Array<{name: string, unitAmountCents: number, quantity: number}>, discountDescription: string }}
 */
function buildGroupInvoiceLineItems(sponsors, tierMap, adjacencyMap) {
  const lineItems = [];
  const discountParts = [];
  let clusterNum = 0;

  for (const sponsor of sponsors) {
    if (sponsor.territoryType === "moon") {
      const moonIndex = sponsor.inquiryData?.moonIndex ?? 0;
      const price = HexTierSystem.MOON_PRICES[moonIndex] || HexTierSystem.MOON_PRICES[0];
      const label = HexTierSystem.MOON_LABELS[moonIndex] || `Moon ${moonIndex + 1}`;
      lineItems.push({ name: label, unitAmountCents: Math.round(price * 100), quantity: 1 });
      continue;
    }

    if (sponsor.territoryType === "billboard") {
      const bbIndex = sponsor.inquiryData?.billboardIndex ?? 0;
      const price = HexTierSystem.getBillboardPrice(bbIndex);
      const label = HexTierSystem.getBillboardLabel(bbIndex);
      lineItems.push({ name: label, unitAmountCents: Math.round(price * 100), quantity: 1 });
      continue;
    }

    const tiles = sponsor.cluster?.tileIndices || [];
    if (tiles.length === 0 || !tierMap) continue;

    clusterNum++;
    const pricing = HexTierSystem.calculatePricing(tiles, tierMap, adjacencyMap);
    const multiplier = pricing.discount > 0 ? (100 - pricing.discount) / 100 : 1;

    for (const tierId of HexTierSystem.RENTABLE_TIERS) {
      const count = pricing.byTier[tierId];
      if (!count) continue;
      const tier = HexTierSystem.TIERS[tierId];
      lineItems.push({
        name: `Cluster ${clusterNum} (${pricing.totalHexes} hexes): ${tier.name}`,
        unitAmountCents: Math.round(tier.price * 100 * multiplier),
        quantity: count,
      });
    }

    if (pricing.discount > 0) {
      discountParts.push(`Cluster ${clusterNum}: ${pricing.discount}% ${pricing.label || "discount"} (${pricing.totalHexes} hexes)`);
    }
  }

  return { lineItems, discountDescription: discountParts.join("; ") };
}

/**
 * Find or create a Stripe customer for the given email.
 * @param {string} email
 * @param {string} [name]
 * @returns {Promise<string>} Stripe customer ID
 */
async function findOrCreateCustomer(email, name, metadata) {
  if (!stripe) throw new Error("Stripe not initialized");

  const updateFields = {};
  if (name) updateFields.name = name;
  if (metadata) updateFields.metadata = metadata;

  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) {
    if (Object.keys(updateFields).length > 0) {
      await stripe.customers.update(existing.data[0].id, updateFields);
    }
    return existing.data[0].id;
  }

  const customer = await stripe.customers.create({
    email,
    ...updateFields,
  });
  return customer.id;
}

/**
 * Create a Stripe subscription with pre-discounted line items.
 * @param {Object} params
 * @param {string} params.customerId - Stripe customer ID
 * @param {string} params.sponsorId - SponsorStore ID
 * @param {string} params.territoryId - Firestore territory ID (for player territories)
 * @param {string} params.description - Human-readable territory description
 * @param {Array<{name: string, unitAmountCents: number, quantity: number}>} params.lineItems - Pre-discounted line items
 * @param {string} [params.discountDescription] - Discount info for the invoice description
 * @param {string} [params.couponId] - Stripe coupon ID to apply to the subscription
 * @returns {Promise<import('stripe').Stripe.Subscription>}
 */
async function createSubscription({ customerId, sponsorId, territoryId, description, lineItems, discountDescription, couponId, category }) {
  if (!stripe) throw new Error("Stripe not initialized");

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

  const catLabel = category === "player" ? "User" : "Corporate";
  const desc = discountDescription
    ? `AdLands ${catLabel}: ${description} (${discountDescription})`
    : `AdLands ${catLabel}: ${description}`;

  const subParams = {
    customer: customerId,
    collection_method: "send_invoice",
    days_until_due: 7,
    items,
    description: desc,
    metadata: { sponsorId, territoryId: territoryId || "", category: catLabel },
  };
  if (couponId) subParams.discounts = [{ coupon: couponId }];

  const subscription = await stripe.subscriptions.create(subParams);

  // Finalize and send the first invoice (Stripe creates it as a draft for send_invoice subscriptions)
  let invoiceAmountCents = null;
  const invoices = await stripe.invoices.list({ subscription: subscription.id, status: "draft", limit: 1 });
  if (invoices.data.length > 0) {
    const finalized = await stripe.invoices.finalizeInvoice(invoices.data[0].id);
    invoiceAmountCents = finalized.amount_due;
    await stripe.invoices.sendInvoice(invoices.data[0].id);
  }

  return { subscription, invoiceAmountCents };
}

/**
 * Update an existing Stripe subscription's line items (no proration).
 * Replaces all current items with new ones. Preserves existing coupons/discounts.
 * @param {Object} params
 * @param {string} params.subscriptionId - Stripe subscription ID
 * @param {string} params.sponsorId - SponsorStore ID (for product metadata)
 * @param {string} params.description - Human-readable territory description
 * @param {Array<{name: string, unitAmountCents: number, quantity: number}>} params.lineItems
 * @param {string} [params.discountDescription]
 * @returns {Promise<import('stripe').Stripe.Subscription>}
 */
async function updateSubscription({ subscriptionId, sponsorId, description, lineItems, discountDescription, category, customerId, customerName, customerMeta }) {
  if (!stripe) throw new Error("Stripe not initialized");

  // Sync customer name and metadata if provided
  if (customerId) {
    const custUpdate = {};
    if (customerName) custUpdate.name = customerName;
    if (customerMeta) custUpdate.metadata = customerMeta;
    if (Object.keys(custUpdate).length > 0) {
      stripe.customers.update(customerId, custUpdate).catch(() => {});
    }
  }

  const sub = await stripe.subscriptions.retrieve(subscriptionId);

  const items = [];
  for (const existing of sub.items.data) {
    items.push({ id: existing.id, deleted: true });
  }
  for (const item of lineItems) {
    const product = await stripe.products.create({
      name: `AdLands: ${item.name}`,
      metadata: { sponsorId },
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

  const catLabel = category === "player" ? "User" : "Corporate";
  const desc = discountDescription
    ? `AdLands ${catLabel}: ${description} (${discountDescription})`
    : `AdLands ${catLabel}: ${description}`;

  const updated = await stripe.subscriptions.update(subscriptionId, {
    items,
    description: desc,
    metadata: { ...sub.metadata, category: catLabel },
    proration_behavior: "none",
  });

  for (const old of sub.items.data) {
    stripe.products.update(old.price.product, { active: false }).catch(() => {});
  }

  return updated;
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
  buildGroupInvoiceLineItems,
  findOrCreateCustomer,
  createSubscription,
  updateSubscription,
  cancelSubscription,
  constructWebhookEvent,
  saveStripeIds,
};
