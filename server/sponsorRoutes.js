/**
 * AdLands - Sponsor REST API Routes
 * Express router for /api/sponsors CRUD operations.
 * Mutations trigger live reload to broadcast changes to connected clients.
 */

const { Router } = require("express");
const crypto = require("crypto");
const fsp = require("fs").promises;
const path = require("path");
let sharp;
try { sharp = require("sharp"); } catch (e) { /* optional — sharp not installed */ }
let applyPixelArtFilter;
try { applyPixelArtFilter = require("./pixelArtFilter").applyPixelArtFilter; } catch (e) { /* optional — needs sharp */ }
const { getFirestore } = require("./firebaseAdmin");
const { sendViaResend } = require("./inquiryRoutes");
const stripeService = require("./stripeService");

/**
 * Find an existing file on disk matching a prefix (e.g. "sponsor_123." or "sponsor_123_logo.").
 * Returns the filename if found, null otherwise.
 */
async function findExistingFile(texDir, prefix) {
  try {
    const files = await fsp.readdir(texDir);
    return files.find(f => f.startsWith(prefix)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Extract a single sponsor's base64 images to static PNG files on disk.
 * Falls back to existing files on disk when base64 data is missing.
 * @returns {{ patternUrl?: string, logoUrl?: string }}
 */
async function extractSponsorImage(sponsor, texDir) {
  const urls = {};
  const tileCount = sponsor.cluster?.tileIndices?.length || 20;

  /** Append file mtime as cache-buster query param so browsers re-fetch after re-baking. */
  async function withMtime(urlPath, filePath) {
    try {
      const stat = await fsp.stat(filePath);
      return urlPath + "?v=" + Math.floor(stat.mtimeMs);
    } catch (e) {
      return urlPath;
    }
  }

  if (sponsor.patternImage) {
    const match = sponsor.patternImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const raw = Buffer.from(match[2], "base64");
      if (applyPixelArtFilter) {
        // Apply pixel art filter: resolution scales with territory size
        const baked = await applyPixelArtFilter(raw, tileCount);
        const pngPath = path.join(texDir, `${sponsor.id}.png`);
        await fsp.writeFile(pngPath, baked);
        urls.patternUrl = await withMtime(`/sponsor-textures/${sponsor.id}.png`, pngPath);
      } else {
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const filePath = path.join(texDir, `${sponsor.id}.${ext}`);
        await fsp.writeFile(filePath, raw);
        urls.patternUrl = await withMtime(`/sponsor-textures/${sponsor.id}.${ext}`, filePath);
      }
    }
  } else {
    // No base64 data — check for previously extracted file on disk
    const existing = await findExistingFile(texDir, sponsor.id + ".");
    if (existing && !existing.includes("_logo")) {
      const filePath = path.join(texDir, existing);
      // Re-bake oversized files through pixel art filter on startup
      if (applyPixelArtFilter) {
        try {
          const stat = await fsp.stat(filePath);
          if (stat.size > 5000) {
            const raw = await fsp.readFile(filePath);
            const baked = await applyPixelArtFilter(raw, tileCount);
            const pngPath = path.join(texDir, `${sponsor.id}.png`);
            await fsp.writeFile(pngPath, baked);
            urls.patternUrl = await withMtime(`/sponsor-textures/${sponsor.id}.png`, pngPath);
          } else {
            urls.patternUrl = await withMtime(`/sponsor-textures/${existing}`, filePath);
          }
        } catch (e) {
          urls.patternUrl = await withMtime(`/sponsor-textures/${existing}`, filePath);
        }
      } else {
        urls.patternUrl = await withMtime(`/sponsor-textures/${existing}`, filePath);
      }
    }
  }
  if (sponsor.logoImage) {
    const match = sponsor.logoImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const raw = Buffer.from(match[2], "base64");
      const pngPath = path.join(texDir, `${sponsor.id}_logo.png`);
      if (sharp) {
        // Resize logo to 128px (displayed at 64px CSS / 128px retina)
        const optimized = await sharp(raw)
          .resize(128, 128, { fit: "inside", withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        await fsp.writeFile(pngPath, optimized);
      } else {
        await fsp.writeFile(pngPath, raw);
      }
      urls.logoUrl = await withMtime(`/sponsor-textures/${sponsor.id}_logo.png`, pngPath);
    }
  } else {
    // No base64 data — check for previously extracted logo file on disk
    const existing = await findExistingFile(texDir, sponsor.id + "_logo.");
    if (existing) {
      urls.logoUrl = await withMtime(`/sponsor-textures/${existing}`, path.join(texDir, existing));
    }
  }
  return urls;
}

/**
 * Extract base64 sponsor images to static PNG files on disk.
 * If onlyId is provided, only re-extracts that single sponsor's images.
 * Returns a map of sponsorId → { patternUrl, logoUrl }.
 */
async function extractSponsorImages(sponsorStore, gameDir, onlyId) {
  const texDir = path.join(gameDir, "sponsor-textures");
  await fsp.mkdir(texDir, { recursive: true });

  const urlMap = {};
  const sponsors = onlyId
    ? [sponsorStore.getById(onlyId)].filter(Boolean)
    : sponsorStore.getAll();

  for (const s of sponsors) {
    const urls = await extractSponsorImage(s, texDir);
    if (urls.patternUrl || urls.logoUrl) {
      urlMap[s.id] = urls;
    }
  }

  // Deduplicate: sponsors with byte-identical textures share one URL.
  // This cuts ~44 client HTTP requests down to ~20 (one per unique brand image).
  // Returns { urlMap, contentHashes } so single-sponsor edits can dedup cheaply.
  if (!onlyId) {
    const contentHashes = { patternUrl: new Map(), logoUrl: new Map() };
    for (const urlKey of ["patternUrl", "logoUrl"]) {
      const hashToUrl = contentHashes[urlKey];
      for (const [, urls] of Object.entries(urlMap)) {
        const urlPath = urls[urlKey];
        if (!urlPath) continue;
        const filePath = path.join(gameDir, urlPath.split("?")[0]);
        try {
          const buf = await fsp.readFile(filePath);
          const hash = crypto.createHash("md5").update(buf).digest("hex");
          if (hashToUrl.has(hash)) {
            urls[urlKey] = hashToUrl.get(hash);
          } else {
            hashToUrl.set(hash, urlPath);
          }
        } catch (e) { /* file missing — skip */ }
      }
    }
    return { urlMap, contentHashes };
  }

  return { urlMap, contentHashes: null };
}

/**
 * Remove orphaned image files for a deleted sponsor.
 */
async function cleanupSponsorImageFiles(sponsorId, texDir) {
  if (!texDir) return;
  try {
    const files = await fsp.readdir(texDir);
    const prefix = sponsorId + ".";
    const logoPrefix = sponsorId + "_logo.";
    for (const file of files) {
      if (file.startsWith(prefix) || file.startsWith(logoPrefix)) {
        await fsp.unlink(path.join(texDir, file));
      }
    }
  } catch (e) {
    console.warn("[SponsorRoutes] Cleanup failed for", sponsorId, e.message);
  }
}

function createSponsorRoutes(sponsorStore, gameRoom, { imageUrls, contentHashes, gameDir, moonSponsorStore, billboardSponsorStore, tierMap } = {}) {
  const router = Router();

  // Resend email config (reuses SMTP_PASS as API key)
  const resendApiKey = process.env.SMTP_PASS || null;
  const fromAddress = process.env.SMTP_FROM || "AdLands - A Limited Liability Company <noreply@adlands.gg>";

  // Mutable reference so we can update after re-extraction
  let _imageUrls = imageUrls || {};
  // hash→url maps for O(1) dedup on single-sponsor edits (built at startup, updated incrementally)
  let _contentHashes = contentHashes || { patternUrl: new Map(), logoUrl: new Map() };

  function reloadIfLive() {
    if (gameRoom && typeof gameRoom.reloadSponsors === "function") {
      gameRoom.reloadSponsors();
      // Also reload moon/billboard sponsors (pause state affects them)
      if (typeof gameRoom.reloadMoonSponsors === "function") gameRoom.reloadMoonSponsors();
      if (typeof gameRoom.reloadBillboardSponsors === "function") gameRoom.reloadBillboardSponsors();
    }
  }

  /**
   * Re-extract sponsor images and update the URL map.
   * If onlyId is provided, only re-extracts that sponsor (faster for single edits).
   * Called after mutations so static files stay in sync.
   */
  async function reExtractImages(onlyId) {
    if (!gameDir) return;
    const { urlMap: newUrls, contentHashes: newHashes } = await extractSponsorImages(sponsorStore, gameDir, onlyId);
    if (onlyId) {
      // Merge single sponsor's URLs, deduplicating via the cached hash→url maps
      if (newUrls[onlyId]) {
        const urls = newUrls[onlyId];
        for (const urlKey of ["patternUrl", "logoUrl"]) {
          const urlPath = urls[urlKey];
          if (!urlPath) continue;
          try {
            const buf = await fsp.readFile(path.join(gameDir, urlPath.split("?")[0]));
            const hash = crypto.createHash("md5").update(buf).digest("hex");
            const existing = _contentHashes[urlKey].get(hash);
            if (existing) {
              urls[urlKey] = existing;
            } else {
              _contentHashes[urlKey].set(hash, urlPath);
            }
          } catch (e) { /* skip */ }
        }
        _imageUrls[onlyId] = urls;
      }
    } else {
      _imageUrls = newUrls;
      _contentHashes = newHashes || { patternUrl: new Map(), logoUrl: new Map() };
    }
  }

  /**
   * Remove orphaned image files for a deleted sponsor.
   */
  async function cleanupSponsorImages(sponsorId) {
    if (!gameDir) return;
    const texDir = path.join(gameDir, "sponsor-textures");
    await cleanupSponsorImageFiles(sponsorId, texDir);
    delete _imageUrls[sponsorId];
  }

  /**
   * Strip heavy base64 fields from a sponsor for list responses.
   * Replaces patternImage/logoImage with static URLs when available.
   */
  function toLite(sponsor) {
    const lite = { ...sponsor };
    const urls = _imageUrls[sponsor.id];

    // Replace patternImage with URL (always strip base64 from list)
    delete lite.patternImage;
    if (urls?.patternUrl) lite.patternUrl = urls.patternUrl;

    // Replace logoImage with URL
    if (urls?.logoUrl) {
      lite.logoUrl = urls.logoUrl;
      delete lite.logoImage;
    }
    // If no extracted logo URL, keep logoImage base64 as fallback

    return lite;
  }

  // GET /api/sponsors — list all sponsors (lite by default, ?full=1 for base64)
  router.get("/", async (req, res) => {
    const full = req.query.full === "1";
    const sponsors = sponsorStore.getAll();
    const out = full ? sponsors : sponsors.map(toLite);

    // Enrich player territories with ownerEmail and profile picture
    const playerSponsors = out.filter(s => s.ownerType === "player" && s.ownerUid);
    const needsEmail = playerSponsors.filter(s => !s.ownerEmail);
    const needsProfilePic = playerSponsors.filter(s => !s.ownerProfilePicture);
    if (needsEmail.length > 0 || needsProfilePic.length > 0) {
      const admin = require("firebase-admin");
      const db = getFirestore();
      const uids = [...new Set(playerSponsors.filter(s => !s.ownerEmail || !s.ownerProfilePicture).map(s => s.ownerUid))];
      const emailMap = new Map();
      const profilePicMap = new Map();
      for (const uid of uids) {
        try {
          if (needsEmail.some(s => s.ownerUid === uid)) {
            const userRecord = await admin.auth().getUser(uid);
            if (userRecord.email) emailMap.set(uid, userRecord.email);
          }
          if (needsProfilePic.some(s => s.ownerUid === uid)) {
            const accDoc = await db.collection("accounts").doc(uid).get();
            if (accDoc.exists) {
              const profileIdx = accDoc.data().activeProfileIndex || 0;
              const profileDoc = await db.collection("accounts").doc(uid).collection("profiles").doc(String(profileIdx)).get();
              if (profileDoc.exists && profileDoc.data().profilePicture) {
                profilePicMap.set(uid, profileDoc.data().profilePicture);
              }
            }
          }
        } catch (e) {
          console.warn(`[SponsorRoutes] Failed to enrich uid ${uid}:`, e.message || e);
        }
      }
      for (const s of playerSponsors) {
        const persist = {};
        const email = emailMap.get(s.ownerUid);
        if (email && !s.ownerEmail) {
          s.ownerEmail = email;
          persist.ownerEmail = email;
        }
        const pic = profilePicMap.get(s.ownerUid);
        if (pic && !s.ownerProfilePicture) {
          s.ownerProfilePicture = pic;
          persist.ownerProfilePicture = pic;
        }
        if (Object.keys(persist).length > 0) {
          sponsorStore.update(s.id, persist).catch(() => {});
        }
      }
    }

    const data = {
      version: 1,
      sponsors: out,
      lastModified: sponsorStore._cache?.lastModified || "",
    };
    res.json(data);
  });

  // GET /api/sponsors/export — download as JSON file
  router.get("/export", (req, res) => {
    const json = sponsorStore.exportJSON();
    const date = new Date().toISOString().split("T")[0];
    res.setHeader("Content-Disposition", `attachment; filename="adlands_sponsors_${date}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(json);
  });

  // GET /api/sponsors/:id — get one sponsor
  router.get("/:id", async (req, res) => {
    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor) return res.status(404).json({ errors: ["Sponsor not found"] });
    // Enrich player territory with ownerEmail if missing
    if (sponsor.ownerType === "player" && sponsor.ownerUid && !sponsor.ownerEmail) {
      try {
        const acc = await getFirestore().collection("accounts").doc(sponsor.ownerUid).get();
        if (acc.exists && acc.data().email) sponsor.ownerEmail = acc.data().email;
      } catch (e) {
        console.warn(`[SponsorRoutes] Failed to look up email for uid ${sponsor.ownerUid}:`, e.message || e);
      }
    }
    res.json(sponsor);
  });

  // POST /api/sponsors — create new sponsor
  router.post("/", async (req, res) => {
    // Override name with account email for player territories
    if (req.body.ownerType === "player" && req.body.ownerUid) {
      try {
        const acc = await getFirestore().collection("accounts").doc(req.body.ownerUid).get();
        if (acc.exists && acc.data().email) {
          req.body.name = acc.data().email;
          req.body.ownerEmail = acc.data().email;
        }
      } catch (_) {}
    }
    const result = await sponsorStore.create(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    await reExtractImages(result.sponsor.id);
    reloadIfLive();

    // Fire-and-forget notification for player territory claims
    if (result.sponsor.ownerType === "player" && resendApiKey) {
      const s = result.sponsor;
      const tileCount = s.cluster?.tileIndices?.length || 0;
      sendViaResend(resendApiKey, {
        from: fromAddress,
        to: ["matt@mattmatters.com"],
        subject: `Territory Claimed: ${s.ownerEmail || s.name || "Unknown"} (${tileCount} hex${tileCount !== 1 ? "es" : ""})`,
        html: buildClaimNotificationEmail(s),
      }).then(() => {
        console.log(`[Sponsors] Claim notification sent for ${s.id}`);
      }).catch((err) => {
        console.error(`[Sponsors] Claim notification failed:`, err.message);
      });
    }

    res.status(201).json(result.sponsor);
  });

  // POST /api/sponsors/import — bulk import
  router.post("/import", async (req, res) => {
    const merge = req.body.merge !== false; // default true
    const result = await sponsorStore.importJSON(req.body, merge);
    await reExtractImages();
    reloadIfLive();
    res.json(result);
  });

  // PUT /api/sponsors/:id — update existing sponsor
  router.put("/:id", async (req, res) => {
    const result = await sponsorStore.update(req.params.id, req.body);
    if (result.errors) {
      const status = result.errors.includes("Sponsor not found") ? 404 : 400;
      return res.status(status).json({ errors: result.errors });
    }
    await reExtractImages(req.params.id);
    reloadIfLive();
    res.json(result.sponsor);
  });

  // POST /api/sponsors/:id/remove-tiles — strip specific tiles from a sponsor's cluster
  router.post("/:id/remove-tiles", async (req, res) => {
    const { tiles } = req.body || {};
    if (!Array.isArray(tiles) || tiles.length === 0) {
      return res.status(400).json({ errors: ["tiles array required"] });
    }
    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor) return res.status(404).json({ errors: ["Sponsor not found"] });

    const currentTiles = sponsor.cluster?.tileIndices || [];
    const removeSet = new Set(tiles);
    const remaining = currentTiles.filter(t => !removeSet.has(t));

    await sponsorStore.update(req.params.id, {
      cluster: { ...sponsor.cluster, tileIndices: remaining },
    });
    reloadIfLive();
    res.json({ success: true, remaining: remaining.length });
  });

  // DELETE /api/sponsors/:id — delete sponsor
  router.delete("/:id", async (req, res) => {
    const deletedId = req.params.id;
    const { reason } = req.body || {};

    // Capture sponsor data before deleting so we can notify the owner
    // Look up by SponsorStore ID first, then fall back to _territoryId
    let sponsor = sponsorStore.getById(deletedId);
    if (!sponsor) {
      sponsor = sponsorStore.getAll().find((s) => s._territoryId === deletedId);
    }
    if (!sponsor) return res.status(404).json({ errors: ["Sponsor not found"] });

    // Cancel Stripe subscription if one exists
    if (sponsor.stripeSubscriptionId && stripeService.isEnabled()) {
      await stripeService.cancelSubscription(sponsor.stripeSubscriptionId);
    }

    // Deactivate in Firestore FIRST — prevents reconcilePlayerTerritories() from
    // re-creating the territory even if the server crashes before SponsorStore delete
    if (sponsor.ownerType === "player") {
      const territoryId = sponsor._territoryId;

      if (!territoryId) {
        console.warn(`[sponsorRoutes] Player territory ${sponsor.id} missing _territoryId — cannot clean up Firestore`);
      } else {
        try {
          const db = getFirestore();
          await db.collection("territories").doc(territoryId).update({ active: false });
        } catch (e) {
          console.warn(`[sponsorRoutes] Firestore deactivation failed for ${territoryId}:`, e.message);
        }
      }
    }

    const deleted = await sponsorStore.delete(sponsor.id);
    if (!deleted) return res.status(404).json({ errors: ["Sponsor not found"] });
    // Remove orphaned image files for deleted sponsor
    await cleanupSponsorImages(sponsor.id);

    // Delete Firestore document (already deactivated above as safety net)
    if (sponsor.ownerType === "player") {
      const territoryId = sponsor._territoryId;
      if (territoryId) {
        try {
          const db = getFirestore();
          await db.collection("territories").doc(territoryId).delete();
        } catch (e) {
          console.warn(`[sponsorRoutes] Firestore territory delete failed for ${territoryId}:`, e.message);
        }
      }

      // Notify the owning player via socket (include deletion reason if provided)
      if (sponsor.ownerUid && gameRoom) {
        const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
        for (const s of sockets) {
          if (s.uid === sponsor.ownerUid) {
            s.emit("territory-deleted", {
              territoryId,
              sponsorStorageId: sponsor.id,
              reason: reason || "Territory removed by admin",
            });
          }
        }
      }
    }

    reloadIfLive();
    res.json({ success: true });
  });

  // POST /api/sponsors/:id/review — admin approves or rejects a pending territory submission (all fields)
  router.post("/:id/review", async (req, res) => {
    const { action, rejectionReason, overrides } = req.body || {};
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ errors: ["Invalid action. Must be 'approve' or 'reject'."] });
    }

    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor || sponsor.ownerType !== "player") {
      return res.status(404).json({ errors: ["Player territory not found"] });
    }
    // Check for any pending content (image or text fields)
    const hasPending = sponsor.submissionStatus === "pending" || sponsor.imageStatus === "pending";
    if (!hasPending) {
      return res.status(400).json({ errors: ["No pending submission to review"] });
    }

    const territoryId = sponsor._territoryId || sponsor.id;

    try {
      if (action === "approve") {
        // Admin can override any field before approving
        const approvedTitle = overrides?.title ?? sponsor.pendingTitle ?? sponsor.name ?? "";
        const approvedTagline = overrides?.tagline ?? sponsor.pendingTagline ?? sponsor.tagline ?? "";
        const approvedUrl = overrides?.websiteUrl ?? sponsor.pendingWebsiteUrl ?? sponsor.websiteUrl ?? "";
        const approvedImage = overrides?.patternImage ?? sponsor.pendingImage ?? sponsor.patternImage ?? null;

        // === STRIPE INVOICING PATH ===
        // When Stripe is enabled: stage approved content, send invoice, wait for payment.
        // When Stripe is disabled: activate immediately (legacy behavior).
        if (stripeService.isEnabled()) {
          let customerEmail = sponsor.ownerEmail || sponsor.inquiryData?.contactEmail;

          // Fetch email from Firebase Auth if not cached on sponsor record
          if (!customerEmail && sponsor.ownerUid) {
            try {
              const db = getFirestore();
              const acc = await db.collection("accounts").doc(sponsor.ownerUid).get();
              if (acc.exists && acc.data().email) {
                customerEmail = acc.data().email;
              } else {
                const userRecord = await require("firebase-admin").auth().getUser(sponsor.ownerUid);
                customerEmail = userRecord.email;
              }
            } catch (e) {
              console.warn("[Territory] Failed to fetch owner email:", e.message);
            }
          }

          if (!customerEmail) {
            return res.status(400).json({ errors: ["No email found for this territory owner — cannot send invoice"] });
          }

          // Stage approved content (not yet visible to players — activated by webhook)
          const updateFields = {
            active: false,
            _approvedTitle: approvedTitle,
            _approvedTagline: approvedTagline,
            _approvedUrl: approvedUrl,
            _approvedImage: approvedImage,
            pendingTitle: null,
            pendingTagline: null,
            pendingWebsiteUrl: null,
            pendingImage: null,
            patternImage: approvedImage,
            submissionStatus: "invoiced",
            imageStatus: "approved",
            reviewedAt: new Date().toISOString(),
            rejectionReason: null,
          };
          if (sponsor.ownerType === "player") updateFields.logoImage = null;

          // Calculate price breakdown and create Stripe subscription
          const { lineItems, discountPercent } = stripeService.buildInvoiceLineItems(sponsor, tierMap);
          const description = approvedTitle || sponsor.name || `Territory ${territoryId}`;
          const customerName = sponsor.inquiryData?.contactName || sponsor.playerName || null;

          const customerId = await stripeService.findOrCreateCustomer(customerEmail, customerName);
          const subscription = await stripeService.createSubscription({
            customerId,
            sponsorId: req.params.id,
            territoryId,
            description,
            lineItems,
            discountPercent,
          });

          updateFields.stripeCustomerId = customerId;
          updateFields.stripeSubscriptionId = subscription.id;
          updateFields.paymentStatus = "invoiced";

          await sponsorStore.update(req.params.id, updateFields);

          // Re-extract image so it's ready when payment arrives
          if (approvedImage) await reExtractImages(req.params.id);

          // Save Stripe IDs to Firestore
          try {
            const db = getFirestore();
            await db.collection("territories").doc(territoryId).update({
              pendingTitle: null,
              pendingTagline: null,
              pendingWebsiteUrl: null,
              pendingImage: null,
              submissionStatus: "invoiced",
              paymentStatus: "invoiced",
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscription.id,
              reviewedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
              rejectionReason: null,
            });
          } catch (e) {
            console.warn("[Territory] Firestore invoiced update failed:", e.message);
          }

          // Notify the player that invoice has been sent
          if (gameRoom && sponsor.ownerUid) {
            const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
            for (const s of sockets) {
              if (s.uid === sponsor.ownerUid) {
                s.emit("territory-review-result", {
                  territoryId,
                  status: "invoiced",
                  message: "Your territory has been approved! Check your email for the payment invoice.",
                });
              }
            }
          }

          // No reloadSponsors here — approval only updates metadata (status, staged fields),
          // not cluster geometry. Reloading would shift cluster IDs and break client mappings.
          // The visual update happens later when the Stripe webhook confirms payment.

          const subtotalCents = lineItems.reduce((sum, li) => sum + li.unitAmountCents * li.quantity, 0);
          const totalCents = Math.round(subtotalCents * (1 - (discountPercent || 0) / 100));
          console.log(`[Territory] Approved & invoiced for ${territoryId} ($${(totalCents / 100).toFixed(2)}/mo)`);
          return res.json({ success: true, action: "invoiced", amountCents: totalCents, subscriptionId: subscription.id });
        }

        // === LEGACY PATH (Stripe disabled) — immediate activation ===
        const updateFields = {
          name: sponsor.ownerType === "player" ? sponsor.name : (approvedTitle || sponsor.name),
          title: approvedTitle,
          tagline: approvedTagline,
          websiteUrl: approvedUrl,
          patternImage: approvedImage,
          pendingTitle: null,
          pendingTagline: null,
          pendingWebsiteUrl: null,
          pendingImage: null,
          submissionStatus: "approved",
          imageStatus: "approved",
          reviewedAt: new Date().toISOString(),
          rejectionReason: null,
        };
        if (sponsor.ownerType === "player") updateFields.logoImage = null;
        await sponsorStore.update(req.params.id, updateFields);

        if (approvedImage) await reExtractImages(req.params.id);

        try {
          const db = getFirestore();
          await db.collection("territories").doc(territoryId).update({
            title: approvedTitle,
            tagline: approvedTagline,
            websiteUrl: approvedUrl,
            patternImage: approvedImage,
            pendingTitle: null,
            pendingTagline: null,
            pendingWebsiteUrl: null,
            pendingImage: null,
            submissionStatus: "approved",
            reviewedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
            rejectionReason: null,
          });
        } catch (e) {
          console.warn("[Territory] Firestore approve update failed:", e.message);
        }

        const urls = _imageUrls[req.params.id] || {};
        if (gameRoom) {
          gameRoom.io.to(gameRoom.roomId).emit("territory-submission-approved", {
            territoryId,
            title: approvedTitle,
            tagline: approvedTagline,
            websiteUrl: approvedUrl,
            patternImage: urls.patternUrl || approvedImage,
            patternAdjustment: sponsor.patternAdjustment || {},
            tileIndices: sponsor.cluster?.tileIndices || [],
          });

          if (sponsor.ownerUid) {
            const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
            for (const s of sockets) {
              if (s.uid === sponsor.ownerUid) {
                s.emit("territory-review-result", {
                  territoryId,
                  status: "approved",
                  title: approvedTitle,
                  tagline: approvedTagline,
                  websiteUrl: approvedUrl,
                  patternImage: urls.patternUrl || approvedImage,
                });
              }
            }
          }
        }

        reloadIfLive();

        console.log(`[Territory] Submission approved for ${territoryId}`);
        res.json({ success: true, action: "approved" });
      } else {
        // Reject: delete the territory entirely and notify the player
        const reason = rejectionReason || "Submission rejected by admin";

        // Deactivate in Firestore FIRST — prevents reconciliation from re-creating
        if (territoryId && territoryId !== sponsor.id) {
          try {
            const db = getFirestore();
            await db.collection("territories").doc(territoryId).update({ active: false });
          } catch (e) {
            console.warn("[Territory] Firestore deactivation failed:", e.message);
          }
        }

        // Delete from SponsorStore
        await sponsorStore.delete(req.params.id);
        await cleanupSponsorImages(req.params.id);

        // Update Firestore document with rejection status (keep doc so player sees reason on next login)
        if (territoryId && territoryId !== sponsor.id) {
          try {
            const db = getFirestore();
            await db.collection("territories").doc(territoryId).update({
              active: false,
              submissionStatus: "rejected",
              rejectionReason: reason,
              reviewedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
            });
          } catch (e) {
            console.warn("[Territory] Firestore reject update failed:", e.message);
          }
        }

        // Notify the owning player with rejection reason
        if (gameRoom && sponsor.ownerUid) {
          const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
          for (const s of sockets) {
            if (s.uid === sponsor.ownerUid) {
              s.emit("territory-review-result", {
                territoryId,
                sponsorStorageId: req.params.id,
                status: "rejected",
                reason,
              });
            }
          }
        }

        reloadIfLive();
        console.log(`[Territory] Submission rejected & deleted for ${territoryId}`);
        res.json({ success: true, action: "rejected" });
      }
    } catch (err) {
      console.error("[Territory] Review failed:", err);
      res.status(500).json({ errors: ["Review failed: " + err.message] });
    }
  });

  // POST /api/sponsors/activate-inquiry-group — activate a group of inquiry territories with one combined invoice
  router.post("/activate-inquiry-group", async (req, res) => {
    const { ids, force } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ errors: ["ids array required"] });
    }

    const sponsors = ids.map(id => sponsorStore.getById(id)).filter(Boolean);
    if (sponsors.length === 0) {
      return res.status(404).json({ errors: ["No sponsors found"] });
    }
    if (sponsors.some(s => s.ownerType !== "inquiry")) {
      return res.status(400).json({ errors: ["All sponsors must be pending inquiries"] });
    }

    try {
      // Check tile conflicts across all members
      for (const sponsor of sponsors) {
        const tiles = sponsor.cluster?.tileIndices || [];
        if (tiles.length > 0 && !force) {
          const conflict = sponsorStore.areTilesUsed(tiles, sponsor.id);
          if (conflict.isUsed) {
            const idSet = new Set(ids);
            const conflicts = [];
            const tileSet = new Set(tiles);
            for (const s of sponsorStore.getAll()) {
              if (idSet.has(s.id)) continue;
              if (!s.cluster?.tileIndices) continue;
              const overlapping = s.cluster.tileIndices.filter(t => tileSet.has(t));
              if (overlapping.length > 0) {
                conflicts.push({ sponsorId: s.id, sponsorName: s.name, overlappingTiles: overlapping });
              }
            }
            if (conflicts.length > 0) {
              return res.status(409).json({ conflicts });
            }
          }
        }
      }

      // Force mode: strip overlapping tiles and clear conflicting moon/billboard slots
      if (force) {
        const idSet = new Set(ids);
        for (const sponsor of sponsors) {
          const tiles = sponsor.cluster?.tileIndices || [];
          if (tiles.length > 0) {
            const tileSet = new Set(tiles);
            for (const s of sponsorStore.getAll()) {
              if (idSet.has(s.id)) continue;
              if (!s.cluster?.tileIndices) continue;
              const remaining = s.cluster.tileIndices.filter(t => !tileSet.has(t));
              if (remaining.length < s.cluster.tileIndices.length) {
                await sponsorStore.update(s.id, { cluster: { ...s.cluster, tileIndices: remaining } });
              }
            }
          }
          if (sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null && moonSponsorStore) {
            const slot = moonSponsorStore.getAll()[sponsor.inquiryData.moonIndex];
            if (slot) await moonSponsorStore.clear(sponsor.inquiryData.moonIndex);
          }
          if (sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null && billboardSponsorStore) {
            const slot = billboardSponsorStore.getAll()[sponsor.inquiryData.billboardIndex];
            if (slot) await billboardSponsorStore.clear(sponsor.inquiryData.billboardIndex);
          }
        }
      }

      // === STRIPE INVOICING: single combined subscription ===
      // When Stripe is enabled, defer moon/billboard slot assignment until payment (webhook).
      if (stripeService.isEnabled()) {
        const contactSponsor = sponsors[0];
        const customerEmail = contactSponsor.inquiryData?.contactEmail;
        if (!customerEmail) {
          return res.status(400).json({ errors: ["No contact email found — cannot send invoice"] });
        }

        const { lineItems, discountPercent } = stripeService.buildGroupInvoiceLineItems(sponsors, tierMap);
        if (lineItems.length === 0) {
          return res.status(400).json({ errors: ["No billable items found"] });
        }

        const customerName = contactSponsor.inquiryData?.contactName || null;
        const description = contactSponsor.name || "Territory Group";
        const customerId = await stripeService.findOrCreateCustomer(customerEmail, customerName);
        const subscription = await stripeService.createSubscription({
          customerId,
          sponsorId: ids.join(","),
          territoryId: ids[0],
          description,
          lineItems,
          discountPercent,
        });

        for (const sponsor of sponsors) {
          const updateFields = {
            ownerType: "sponsor",
            active: false,
            paymentStatus: "invoiced",
            submissionStatus: "invoiced",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscription.id,
            ownerEmail: sponsor.inquiryData?.contactEmail || null,
            ownerContactName: sponsor.inquiryData?.contactName || null,
          };

          // Store pending slot index so the webhook can assign after payment
          if (sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null) {
            updateFields._pendingMoonIndex = sponsor.inquiryData.moonIndex;
          }
          if (sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null) {
            updateFields._pendingBillboardIndex = sponsor.inquiryData.billboardIndex;
          }

          await sponsorStore.update(sponsor.id, updateFields);
          await reExtractImages(sponsor.id);
        }

        const subtotalCents = lineItems.reduce((sum, li) => sum + li.unitAmountCents * li.quantity, 0);
        const totalCents = Math.round(subtotalCents * (1 - (discountPercent || 0) / 100));
        console.log(`[Inquiry] Group approved & invoiced (${sponsors.length} territories, ${contactSponsor.name}) — $${(totalCents / 100).toFixed(2)}/mo`);
        return res.json({ success: true, action: "invoiced", amountCents: totalCents, subscriptionId: subscription.id });
      }

      // === LEGACY PATH (Stripe disabled) — assign slots and activate immediately ===
      for (const sponsor of sponsors) {
        if (sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null && moonSponsorStore) {
          await moonSponsorStore.assign(sponsor.inquiryData.moonIndex, {
            name: sponsor.name, tagline: sponsor.tagline || "", websiteUrl: sponsor.websiteUrl || "",
          });
        }
        if (sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null && billboardSponsorStore) {
          await billboardSponsorStore.assign(sponsor.inquiryData.billboardIndex, {
            name: sponsor.name, tagline: sponsor.tagline || "", websiteUrl: sponsor.websiteUrl || "",
          });
        }

        await sponsorStore.update(sponsor.id, {
          ownerType: "sponsor",
          active: true,
          ownerEmail: sponsor.inquiryData?.contactEmail || null,
          ownerContactName: sponsor.inquiryData?.contactName || null,
        });
        await reExtractImages(sponsor.id);
      }
      reloadIfLive();
      console.log(`[Inquiry] Group activated (${sponsors.length} territories, ${sponsors[0].name})`);
      res.json({ success: true });
    } catch (err) {
      console.error("[Inquiry] Group activation failed:", err);
      res.status(500).json({ errors: ["Activation failed: " + err.message] });
    }
  });

  // POST /api/sponsors/:id/activate-inquiry — activate a pending inquiry territory
  router.post("/:id/activate-inquiry", async (req, res) => {
    const { force } = req.body || {};
    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor || sponsor.ownerType !== "inquiry") {
      return res.status(404).json({ errors: ["Pending inquiry territory not found"] });
    }

    try {
      // Check tile conflicts for hex territories
      const tiles = sponsor.cluster?.tileIndices || [];
      if (tiles.length > 0 && !force) {
        const conflict = sponsorStore.areTilesUsed(tiles, req.params.id);
        if (conflict.isUsed) {
          // Find all conflicting sponsors and their overlapping tiles
          const conflicts = [];
          const tileSet = new Set(tiles);
          for (const s of sponsorStore.getAll()) {
            if (s.id === req.params.id) continue;
            if (!s.cluster?.tileIndices) continue;
            const overlapping = s.cluster.tileIndices.filter(t => tileSet.has(t));
            if (overlapping.length > 0) {
              conflicts.push({ sponsorId: s.id, sponsorName: s.name, overlappingTiles: overlapping });
            }
          }
          return res.status(409).json({ conflicts });
        }
      }

      // Force mode: strip overlapping tiles from conflicting sponsors (not delete them)
      if (tiles.length > 0 && force) {
        const tileSet = new Set(tiles);
        let stripped = 0;
        for (const s of sponsorStore.getAll()) {
          if (s.id === req.params.id) continue;
          if (!s.cluster?.tileIndices) continue;
          const remaining = s.cluster.tileIndices.filter(t => !tileSet.has(t));
          if (remaining.length < s.cluster.tileIndices.length) {
            await sponsorStore.update(s.id, {
              cluster: { ...s.cluster, tileIndices: remaining },
            });
            stripped++;
          }
        }
        if (stripped > 0) {
          console.log(`[Inquiry] Stripped conflicting tiles from ${stripped} sponsors for activation`);
        }
      }

      // Force mode: clear conflicting moon/billboard slots
      if (force && sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null && moonSponsorStore) {
        const slot = moonSponsorStore.getAll()[sponsor.inquiryData.moonIndex];
        if (slot) await moonSponsorStore.clear(sponsor.inquiryData.moonIndex);
      }
      if (force && sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null && billboardSponsorStore) {
        const slot = billboardSponsorStore.getAll()[sponsor.inquiryData.billboardIndex];
        if (slot) await billboardSponsorStore.clear(sponsor.inquiryData.billboardIndex);
      }

      // === STRIPE INVOICING PATH for inquiries ===
      // When Stripe is enabled, defer moon/billboard slot assignment until payment (webhook).
      if (stripeService.isEnabled()) {
        const customerEmail = sponsor.inquiryData?.contactEmail;
        if (!customerEmail) {
          return res.status(400).json({ errors: ["No contact email found for this inquiry — cannot send invoice"] });
        }

        const { lineItems, discountPercent } = stripeService.buildInvoiceLineItems(sponsor, tierMap);
        const description = sponsor.name || `Territory ${req.params.id}`;
        const customerName = sponsor.inquiryData?.contactName || null;

        const customerId = await stripeService.findOrCreateCustomer(customerEmail, customerName);
        const subscription = await stripeService.createSubscription({
          customerId,
          sponsorId: req.params.id,
          territoryId: req.params.id,
          description,
          lineItems,
          discountPercent,
        });

        const updateFields = {
          ownerType: "sponsor",
          active: false,
          paymentStatus: "invoiced",
          submissionStatus: "invoiced",
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscription.id,
          ownerEmail: sponsor.inquiryData?.contactEmail || null,
          ownerContactName: sponsor.inquiryData?.contactName || null,
        };

        // Store pending slot index so the webhook can assign after payment
        if (sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null) {
          updateFields._pendingMoonIndex = sponsor.inquiryData.moonIndex;
        }
        if (sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null) {
          updateFields._pendingBillboardIndex = sponsor.inquiryData.billboardIndex;
        }

        await sponsorStore.update(req.params.id, updateFields);

        await reExtractImages(req.params.id);

        const subtotalCents = lineItems.reduce((sum, li) => sum + li.unitAmountCents * li.quantity, 0);
        const totalCents = Math.round(subtotalCents * (1 - (discountPercent || 0) / 100));
        console.log(`[Inquiry] Approved & invoiced ${req.params.id} (${sponsor.name}) — $${(totalCents / 100).toFixed(2)}/mo`);
        return res.json({ success: true, action: "invoiced", amountCents: totalCents, subscriptionId: subscription.id });
      }

      // === LEGACY PATH (Stripe disabled) — assign slots and activate immediately ===
      if (sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null && moonSponsorStore) {
        await moonSponsorStore.assign(sponsor.inquiryData.moonIndex, {
          name: sponsor.name, tagline: sponsor.tagline || "", websiteUrl: sponsor.websiteUrl || "",
        });
      }
      if (sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null && billboardSponsorStore) {
        await billboardSponsorStore.assign(sponsor.inquiryData.billboardIndex, {
          name: sponsor.name, tagline: sponsor.tagline || "", websiteUrl: sponsor.websiteUrl || "",
        });
      }

      await sponsorStore.update(req.params.id, {
        ownerType: "sponsor",
        active: true,
        ownerEmail: sponsor.inquiryData?.contactEmail || null,
        ownerContactName: sponsor.inquiryData?.contactName || null,
      });

      await reExtractImages(req.params.id);
      reloadIfLive();

      console.log(`[Inquiry] Activated inquiry territory ${req.params.id} (${sponsor.name})`);
      res.json({ success: true });
    } catch (err) {
      console.error("[Inquiry] Activation failed:", err);
      res.status(500).json({ errors: ["Activation failed: " + err.message] });
    }
  });

  // POST /api/sponsors/:id/reject-inquiry — reject and delete a pending inquiry territory
  router.post("/:id/reject-inquiry", async (req, res) => {
    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor || sponsor.ownerType !== "inquiry") {
      return res.status(404).json({ errors: ["Pending inquiry territory not found"] });
    }

    try {
      await sponsorStore.delete(req.params.id);
      await cleanupSponsorImages(req.params.id);
      reloadIfLive();

      console.log(`[Inquiry] Rejected inquiry territory ${req.params.id} (${sponsor.name})`);
      res.json({ success: true });
    } catch (err) {
      console.error("[Inquiry] Rejection failed:", err);
      res.status(500).json({ errors: ["Rejection failed: " + err.message] });
    }
  });

  // Backward compat: old endpoint name still works
  router.post("/:id/review-image", (req, res, next) => {
    req.url = req.url.replace("/review-image", "/review");
    router.handle(req, res, next);
  });

  return router;
}

/**
 * Build HTML email for player territory claim notification
 */
function buildClaimNotificationEmail(sponsor) {
  const tileIndices = sponsor.cluster?.tileIndices || [];
  const tileCount = tileIndices.length;
  const territoryId = sponsor._territoryId || sponsor.id;

  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background: #ffffff; color: #222222; padding: 24px; max-width: 600px; margin: 0 auto;">
      <div style="background: #111111; padding: 16px 20px; margin: -24px -24px 20px -24px;">
        <h1 style="color: #00cccc; font-size: 22px; margin: 0; font-family: monospace;">
          AdLands <span style="color: #999999; font-size: 14px;">Territory Claimed</span>
        </h1>
      </div>

      <p style="color: #333333; margin: 0 0 16px 0;">A player has claimed territory and is pending your review.</p>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; font-size: 13px;">Player:</td>
          <td style="color: #222222; padding: 4px 0; font-size: 13px;">${sponsor.ownerEmail || sponsor.name || "Unknown"}</td>
        </tr>
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; font-size: 13px;">Territory ID:</td>
          <td style="color: #222222; padding: 4px 0; font-size: 13px; font-family: monospace;">${territoryId}</td>
        </tr>
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; font-size: 13px;">Hexes:</td>
          <td style="color: #222222; padding: 4px 0; font-size: 13px;">${tileCount} hex${tileCount !== 1 ? "es" : ""}</td>
        </tr>
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; font-size: 13px;">Status:</td>
          <td style="padding: 4px 0; font-size: 13px;"><span style="color: #d97706; font-weight: bold;">Pending Review</span></td>
        </tr>
        <tr>
          <td style="color: #888888; padding: 4px 8px 4px 0; font-size: 13px;">Time:</td>
          <td style="color: #222222; padding: 4px 0; font-size: 13px;">${new Date().toUTCString()}</td>
        </tr>
      </table>

      ${tileCount > 0 ? `
      <div style="background: #f5f5f5; border: 1px solid #dddddd; padding: 12px; margin-bottom: 16px;">
        <div style="color: #888888; font-size: 11px; margin-bottom: 4px; text-transform: uppercase;">Hex Indices</div>
        <div style="color: #555555; font-size: 13px; font-family: monospace; word-break: break-all;">${tileIndices.join(", ")}</div>
      </div>
      ` : ""}

      <div style="color: #aaaaaa; font-size: 11px; border-top: 1px solid #eeeeee; padding-top: 12px; margin-top: 16px;">
        Open the Admin Portal to review this submission.
      </div>
    </div>
  `;
}

module.exports = { createSponsorRoutes, extractSponsorImages, cleanupSponsorImageFiles };
