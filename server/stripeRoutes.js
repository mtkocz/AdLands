/**
 * AdLands - Stripe Webhook Routes
 * Handles Stripe webhook events for territory payment processing.
 *
 * POST /api/stripe/webhook — receives Stripe events (invoice.paid, subscription.deleted)
 *
 * IMPORTANT: The webhook endpoint must receive the raw body (not JSON-parsed)
 * for signature verification. This is handled in index.js by mounting the route
 * before the global express.json() middleware.
 */

const { Router } = require("express");
const express = require("express");
const stripeService = require("./stripeService");
const { getFirestore } = require("./firebaseAdmin");

/**
 * @param {Object} sponsorStore - SponsorStore instance
 * @param {Object} gameRoom - GameRoom instance (for broadcasting)
 * @param {Object} opts
 * @param {Function} opts.reExtractImages - Re-extract sponsor images after activation
 * @param {Function} opts.reloadIfLive - Reload world data for connected clients
 * @param {Function} opts.cleanupSponsorImages - Remove orphaned image files for a sponsor
 */
function createStripeRoutes(sponsorStore, gameRoom, { reExtractImages, reloadIfLive, cleanupSponsorImages } = {}) {
  const router = Router();

  // Webhook endpoint — must use raw body for signature verification
  router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    console.log("[Stripe] Webhook hit — content-type:", req.headers["content-type"], "body length:", req.body?.length || 0);
    if (!stripeService.isEnabled()) {
      return res.status(503).json({ error: "Stripe not configured" });
    }

    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).json({ error: "Missing stripe-signature header" });

    let event;
    try {
      event = stripeService.constructWebhookEvent(req.body, sig);
    } catch (err) {
      console.error("[Stripe] Webhook signature verification failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }

    console.log("[Stripe] Webhook event received:", event.type);
    try {
      switch (event.type) {
        case "invoice.paid":
        case "invoice.payment_succeeded":
          await handleInvoicePaid(event.data.object, sponsorStore, gameRoom, { reExtractImages, reloadIfLive });
          break;
        case "invoice_payment.paid": {
          // API v2026+: event.data.object is InvoicePayment, invoice is nested
          const inv = event.data.object.invoice || event.data.object;
          await handleInvoicePaid(inv, sponsorStore, gameRoom, { reExtractImages, reloadIfLive });
          break;
        }

        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(event.data.object, sponsorStore, gameRoom, { reloadIfLive, cleanupSponsorImages });
          break;

        default:
          // Ignore other events
          break;
      }
    } catch (err) {
      console.error(`[Stripe] Error handling ${event.type}:`, err);
      // Still return 200 — Stripe retries on non-2xx and we don't want infinite retries
      // for bugs in our handler
    }

    res.json({ received: true });
  });

  return router;
}

/**
 * Handle invoice.paid — activate the territory.
 * This fires on first payment and every subsequent monthly payment.
 */
async function handleInvoicePaid(invoice, sponsorStore, gameRoom, { reExtractImages, reloadIfLive }) {
  const subscriptionId = invoice.subscription;
  console.log("[Stripe] handleInvoicePaid — subscription:", subscriptionId, "keys:", Object.keys(invoice).join(","));
  if (!subscriptionId) {
    console.warn("[Stripe] invoice.paid — no subscription ID on invoice:", invoice.id);
    return;
  }

  // Find the sponsor by stripeSubscriptionId
  const sponsor = findSponsorBySubscription(sponsorStore, subscriptionId);
  if (!sponsor) {
    console.warn("[Stripe] invoice.paid — no sponsor found for subscription:", subscriptionId);
    return;
  }

  // Skip if already active (idempotency for recurring payments)
  if (sponsor.submissionStatus === "active" || sponsor.paymentStatus === "active") {
    console.log("[Stripe] Territory already active, skipping:", sponsor.id);
    return;
  }

  const territoryId = sponsor._territoryId || sponsor.id;

  // Activate territory — move pending fields to active
  const updateFields = {
    active: true,
    submissionStatus: "active",
    paymentStatus: "active",
    activatedAt: new Date().toISOString(),
  };

  // For player territories with pending content, promote to active
  if (sponsor.ownerType === "player") {
    if (sponsor._approvedTitle != null) updateFields.title = sponsor._approvedTitle;
    if (sponsor._approvedTagline != null) updateFields.tagline = sponsor._approvedTagline;
    if (sponsor._approvedUrl != null) updateFields.websiteUrl = sponsor._approvedUrl;
    if (sponsor._approvedImage != null) updateFields.patternImage = sponsor._approvedImage;

    // Clear staging fields
    updateFields._approvedTitle = null;
    updateFields._approvedTagline = null;
    updateFields._approvedUrl = null;
    updateFields._approvedImage = null;
  }

  await sponsorStore.update(sponsor.id, updateFields);

  // Re-extract images
  if (reExtractImages) {
    try { await reExtractImages(sponsor.id); } catch (e) {
      console.warn("[Stripe] Image re-extraction failed:", e.message);
    }
  }

  // Update Firestore
  try {
    const db = getFirestore();
    const firestoreUpdate = {
      paymentStatus: "active",
      activatedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
    };
    if (updateFields.title != null) firestoreUpdate.title = updateFields.title;
    if (updateFields.tagline != null) firestoreUpdate.tagline = updateFields.tagline;
    if (updateFields.websiteUrl != null) firestoreUpdate.websiteUrl = updateFields.websiteUrl;
    if (updateFields.patternImage != null) firestoreUpdate.patternImage = updateFields.patternImage;

    await db.collection("territories").doc(territoryId).update(firestoreUpdate);
  } catch (e) {
    console.warn("[Stripe] Firestore update failed:", e.message);
  }

  // Broadcast to game clients
  if (gameRoom) {
    gameRoom.io.to(gameRoom.roomId).emit("territory-submission-approved", {
      territoryId,
      title: updateFields.title || sponsor.title,
      tagline: updateFields.tagline || sponsor.tagline,
      websiteUrl: updateFields.websiteUrl || sponsor.websiteUrl,
      patternImage: sponsor.patternImage,
      patternAdjustment: sponsor.patternAdjustment || {},
      tileIndices: sponsor.cluster?.tileIndices || [],
    });

    // Notify the owning player
    if (sponsor.ownerUid) {
      const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
      for (const s of sockets) {
        if (s.uid === sponsor.ownerUid) {
          s.emit("territory-review-result", {
            territoryId,
            status: "active",
            message: "Payment received! Your territory is now live.",
          });
        }
      }
    }

    // Notify admin sockets
    gameRoom.io.to(gameRoom.roomId).emit("territory-payment-received", {
      sponsorId: sponsor.id,
      territoryId,
      sponsorName: sponsor.name || sponsor.title,
    });
  }

  if (reloadIfLive) reloadIfLive();
  console.log(`[Stripe] Territory activated after payment: ${territoryId}`);
}

/**
 * Handle customer.subscription.deleted — deactivate the territory.
 * This fires when all retries exhausted or subscription manually cancelled.
 */
async function handleSubscriptionDeleted(subscription, sponsorStore, gameRoom, { reloadIfLive, cleanupSponsorImages }) {
  const sponsor = findSponsorBySubscription(sponsorStore, subscription.id);
  if (!sponsor) {
    console.warn("[Stripe] subscription.deleted — no sponsor found:", subscription.id);
    return;
  }

  const territoryId = sponsor._territoryId || sponsor.id;
  const sponsorId = sponsor.id;

  // Delete from Firestore
  if (sponsor.ownerType === "player" && territoryId) {
    try {
      const db = getFirestore();
      await db.collection("territories").doc(territoryId).delete();
    } catch (e) {
      console.warn("[Stripe] Firestore territory delete failed:", e.message);
    }
  }

  // Delete from SponsorStore
  await sponsorStore.delete(sponsorId);

  // Clean up image files
  if (cleanupSponsorImages) {
    try { await cleanupSponsorImages(sponsorId); } catch (e) {
      console.warn("[Stripe] Image cleanup failed:", e.message);
    }
  }

  // Notify the owning player
  if (gameRoom && sponsor.ownerUid) {
    const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
    for (const s of sockets) {
      if (s.uid === sponsor.ownerUid) {
        s.emit("territory-deleted", {
          territoryId,
          sponsorStorageId: sponsorId,
          reason: "Subscription cancelled",
        });
      }
    }
  }

  // Notify admin
  if (gameRoom) {
    gameRoom.io.to(gameRoom.roomId).emit("territory-payment-expired", {
      sponsorId,
      territoryId,
      sponsorName: sponsor.name || sponsor.title,
    });
  }

  if (reloadIfLive) reloadIfLive();
  console.log(`[Stripe] Territory removed — subscription ended: ${territoryId}`);
}

/**
 * Find a sponsor by its Stripe subscription ID.
 */
function findSponsorBySubscription(sponsorStore, subscriptionId) {
  for (const s of sponsorStore.getAll()) {
    if (s.stripeSubscriptionId === subscriptionId) return s;
  }
  return null;
}

module.exports = { createStripeRoutes };
