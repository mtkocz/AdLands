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
function createStripeRoutes(sponsorStore, gameRoom, { reExtractImages, reloadIfLive, cleanupSponsorImages, moonSponsorStore, billboardSponsorStore } = {}) {
  const router = Router();

  // Webhook endpoint — must use raw body for signature verification
  router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
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

    try {
      switch (event.type) {
        case "invoice.paid":
        case "invoice.payment_succeeded":
          await handleInvoicePaid(event.data.object, sponsorStore, gameRoom, { reExtractImages, reloadIfLive, moonSponsorStore, billboardSponsorStore });
          break;
        case "invoice_payment.paid": {
          // API v2026+: event.data.object is InvoicePayment, invoice is nested
          const inv = event.data.object.invoice || event.data.object;
          await handleInvoicePaid(inv, sponsorStore, gameRoom, { reExtractImages, reloadIfLive, moonSponsorStore, billboardSponsorStore });
          break;
        }

        case "customer.subscription.deleted":
          await handleSubscriptionDeleted(event.data.object, sponsorStore, gameRoom, { reloadIfLive, cleanupSponsorImages, moonSponsorStore, billboardSponsorStore });
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
async function handleInvoicePaid(invoice, sponsorStore, gameRoom, { reExtractImages, reloadIfLive, moonSponsorStore, billboardSponsorStore }) {
  // API v2026+: subscription moved from invoice.subscription to invoice.parent.subscription_details
  const subscriptionId = invoice.subscription
    || invoice.parent?.subscription_details?.subscription;
  if (!subscriptionId) return;

  // Find all sponsors sharing this subscription (group invoicing stores the same ID on all members)
  const sponsors = findSponsorsBySubscription(sponsorStore, subscriptionId);
  if (sponsors.length === 0) {
    console.warn("[Stripe] invoice.paid — no sponsor found for subscription:", subscriptionId);
    return;
  }

  // Skip if already active (idempotency for recurring payments)
  const pending = sponsors.filter(s => s.submissionStatus !== "active" && s.paymentStatus !== "active");
  if (pending.length === 0) {
    console.log("[Stripe] All territories already active, skipping:", subscriptionId);
    return;
  }

  for (const sponsor of pending) {
    const territoryId = sponsor._territoryId || sponsor.id;

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
      updateFields._approvedTitle = null;
      updateFields._approvedTagline = null;
      updateFields._approvedUrl = null;
      updateFields._approvedImage = null;
    }

    await sponsorStore.update(sponsor.id, updateFields);

    // Assign deferred moon/billboard slots now that payment is confirmed
    if (sponsor._pendingMoonIndex != null && moonSponsorStore) {
      try {
        await moonSponsorStore.assign(sponsor._pendingMoonIndex, {
          name: sponsor.name, tagline: sponsor.tagline || "", websiteUrl: sponsor.websiteUrl || "",
        });
        await sponsorStore.update(sponsor.id, { _pendingMoonIndex: null });
      } catch (e) {
        console.warn("[Stripe] Moon slot assignment failed:", e.message);
      }
    }
    if (sponsor._pendingBillboardIndex != null && billboardSponsorStore) {
      try {
        await billboardSponsorStore.assign(sponsor._pendingBillboardIndex, {
          name: sponsor.name, tagline: sponsor.tagline || "", websiteUrl: sponsor.websiteUrl || "",
        });
        await sponsorStore.update(sponsor.id, { _pendingBillboardIndex: null });
      } catch (e) {
        console.warn("[Stripe] Billboard slot assignment failed:", e.message);
      }
    }

    if (reExtractImages) {
      try { await reExtractImages(sponsor.id); } catch (e) {
        console.warn("[Stripe] Image re-extraction failed:", e.message);
      }
    }

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
    }
  }

  // Broadcast payment received and reload once (after all members activated)
  if (gameRoom) {
    gameRoom.io.to(gameRoom.roomId).emit("territory-payment-received", {
      sponsorId: pending.map(s => s.id).join(","),
      territoryId: pending[0]._territoryId || pending[0].id,
      sponsorName: pending[0].name || pending[0].title,
      count: pending.length,
    });
  }

  if (reloadIfLive) reloadIfLive();
  console.log(`[Stripe] ${pending.length} territor${pending.length === 1 ? "y" : "ies"} activated after payment (subscription: ${subscriptionId})`);
}

/**
 * Handle customer.subscription.deleted — deactivate the territory.
 * This fires when all retries exhausted or subscription manually cancelled.
 */
async function handleSubscriptionDeleted(subscription, sponsorStore, gameRoom, { reloadIfLive, cleanupSponsorImages, moonSponsorStore, billboardSponsorStore }) {
  const sponsors = findSponsorsBySubscription(sponsorStore, subscription.id);
  if (sponsors.length === 0) {
    console.warn("[Stripe] subscription.deleted — no sponsor found:", subscription.id);
    return;
  }

  for (const sponsor of sponsors) {
    const territoryId = sponsor._territoryId || sponsor.id;
    const sponsorId = sponsor.id;

    if (sponsor.ownerType === "player" && territoryId) {
      try {
        const db = getFirestore();
        await db.collection("territories").doc(territoryId).delete();
      } catch (e) {
        console.warn("[Stripe] Firestore territory delete failed:", e.message);
      }
    }

    await sponsorStore.delete(sponsorId);

    // Clear associated moon/billboard slots
    const sponsorName = sponsor.name || "";
    if (sponsorName) {
      const nameLower = sponsorName.toLowerCase();
      if (moonSponsorStore) {
        const moons = moonSponsorStore.getAll();
        for (let i = 0; i < moons.length; i++) {
          if (moons[i] && moons[i].name && moons[i].name.toLowerCase() === nameLower) {
            await moonSponsorStore.clear(i);
          }
        }
      }
      if (billboardSponsorStore) {
        const bbs = billboardSponsorStore.getAll();
        for (let i = 0; i < bbs.length; i++) {
          if (bbs[i] && bbs[i].name && bbs[i].name.toLowerCase() === nameLower) {
            await billboardSponsorStore.clear(i);
          }
        }
      }
    }

    if (cleanupSponsorImages) {
      try { await cleanupSponsorImages(sponsorId); } catch (e) {
        console.warn("[Stripe] Image cleanup failed:", e.message);
      }
    }

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
  }

  if (gameRoom) {
    gameRoom.io.to(gameRoom.roomId).emit("territory-payment-expired", {
      sponsorId: sponsors.map(s => s.id).join(","),
      territoryId: sponsors[0]._territoryId || sponsors[0].id,
      sponsorName: sponsors[0].name || sponsors[0].title,
      count: sponsors.length,
    });
  }

  if (reloadIfLive) reloadIfLive();
  console.log(`[Stripe] ${sponsors.length} territor${sponsors.length === 1 ? "y" : "ies"} removed — subscription ended: ${subscription.id}`);
}

/**
 * Find all sponsors sharing a Stripe subscription ID.
 */
function findSponsorsBySubscription(sponsorStore, subscriptionId) {
  return sponsorStore.getAll().filter(s => s.stripeSubscriptionId === subscriptionId);
}

module.exports = { createStripeRoutes };
