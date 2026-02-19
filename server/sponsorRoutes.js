/**
 * AdLands - Sponsor REST API Routes
 * Express router for /api/sponsors CRUD operations.
 * Mutations trigger live reload to broadcast changes to connected clients.
 */

const { Router } = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const { getFirestore } = require("./firebaseAdmin");
const { sendViaResend } = require("./inquiryRoutes");

/**
 * Find an existing file on disk matching a prefix (e.g. "sponsor_123." or "sponsor_123_logo.").
 * Returns the filename if found, null otherwise.
 */
function findExistingFile(texDir, prefix) {
  try {
    const files = fs.readdirSync(texDir);
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
  if (sponsor.patternImage) {
    const match = sponsor.patternImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const filePath = path.join(texDir, `${sponsor.id}.${ext}`);
      await fsp.writeFile(filePath, Buffer.from(match[2], "base64"));
      urls.patternUrl = `/sponsor-textures/${sponsor.id}.${ext}`;
    }
  } else {
    // No base64 data — check for previously extracted file on disk
    const existing = findExistingFile(texDir, sponsor.id + ".");
    if (existing && !existing.includes("_logo")) {
      urls.patternUrl = `/sponsor-textures/${existing}`;
    }
  }
  if (sponsor.logoImage) {
    const match = sponsor.logoImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const filePath = path.join(texDir, `${sponsor.id}_logo.${ext}`);
      await fsp.writeFile(filePath, Buffer.from(match[2], "base64"));
      urls.logoUrl = `/sponsor-textures/${sponsor.id}_logo.${ext}`;
    }
  } else {
    // No base64 data — check for previously extracted logo file on disk
    const existing = findExistingFile(texDir, sponsor.id + "_logo.");
    if (existing) {
      urls.logoUrl = `/sponsor-textures/${existing}`;
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
  if (!fs.existsSync(texDir)) await fsp.mkdir(texDir, { recursive: true });

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
  return urlMap;
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

function createSponsorRoutes(sponsorStore, gameRoom, { imageUrls, gameDir, moonSponsorStore, billboardSponsorStore } = {}) {
  const router = Router();

  // Resend email config (reuses SMTP_PASS as API key)
  const resendApiKey = process.env.SMTP_PASS || null;
  const fromAddress = process.env.SMTP_FROM || "AdLands <noreply@adlands.gg>";

  // Mutable reference so we can update after re-extraction
  let _imageUrls = imageUrls || {};

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
    const newUrls = await extractSponsorImages(sponsorStore, gameDir, onlyId);
    if (onlyId) {
      // Merge single sponsor's URLs into the map
      if (newUrls[onlyId]) {
        _imageUrls[onlyId] = newUrls[onlyId];
      }
    } else {
      _imageUrls = newUrls;
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

    // Enrich player territories with ownerEmail from Firestore accounts
    const playerSponsors = out.filter(s => s.ownerType === "player" && s.ownerUid && !s.ownerEmail);
    if (playerSponsors.length > 0) {
      const uids = [...new Set(playerSponsors.map(s => s.ownerUid))];
      const emailMap = new Map();
      for (const uid of uids) {
        try {
          const acc = await getFirestore().collection("accounts").doc(uid).get();
          if (acc.exists && acc.data().email) emailMap.set(uid, acc.data().email);
        } catch (e) {
          console.warn(`[SponsorRoutes] Failed to look up email for uid ${uid}:`, e.message || e);
        }
      }
      for (const s of playerSponsors) {
        const email = emailMap.get(s.ownerUid);
        if (email) {
          s.ownerEmail = email;
          // Persist back to store so future requests don't need the lookup
          sponsorStore.update(s.id, { ownerEmail: email }).catch(() => {});
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

  // DELETE /api/sponsors/:id — delete sponsor
  router.delete("/:id", async (req, res) => {
    const deletedId = req.params.id;
    const { reason } = req.body || {};

    // Capture sponsor data before deleting so we can notify the owner
    const sponsor = sponsorStore.getById(deletedId);
    if (!sponsor) return res.status(404).json({ errors: ["Sponsor not found"] });

    // Deactivate in Firestore FIRST — prevents reconcilePlayerTerritories() from
    // re-creating the territory even if the server crashes before SponsorStore delete
    if (sponsor.ownerType === "player") {
      const territoryId = sponsor._territoryId;

      if (!territoryId) {
        console.warn(`[sponsorRoutes] Player territory ${deletedId} missing _territoryId — cannot clean up Firestore`);
      } else {
        try {
          const db = getFirestore();
          await db.collection("territories").doc(territoryId).update({ active: false });
        } catch (e) {
          console.warn(`[sponsorRoutes] Firestore deactivation failed for ${territoryId}:`, e.message);
        }
      }
    }

    const deleted = await sponsorStore.delete(deletedId);
    if (!deleted) return res.status(404).json({ errors: ["Sponsor not found"] });
    // Remove orphaned image files for deleted sponsor
    await cleanupSponsorImages(deletedId);

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
              sponsorStorageId: deletedId,
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

        // Move all pending fields to active in SponsorStore
        await sponsorStore.update(req.params.id, {
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
        });

        // Re-extract image to static file
        if (approvedImage) {
          await reExtractImages(req.params.id);
        }

        // Update Firestore
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

        // Broadcast approved submission to all connected players
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

          // Notify the owning player specifically
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

        // Update world payload so future joiners see approved content
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

      // Force mode: delete conflicting sponsors entirely
      if (tiles.length > 0 && force) {
        const tileSet = new Set(tiles);
        const toDelete = [];
        for (const s of sponsorStore.getAll()) {
          if (s.id === req.params.id) continue;
          if (!s.cluster?.tileIndices) continue;
          const overlapping = s.cluster.tileIndices.filter(t => tileSet.has(t));
          if (overlapping.length > 0) toDelete.push(s.id);
        }
        for (const id of toDelete) {
          await sponsorStore.delete(id);
          await cleanupSponsorImages(id);
        }
        if (toDelete.length > 0) {
          console.log(`[Inquiry] Deleted ${toDelete.length} conflicting sponsors for activation`);
        }
      }

      // Assign moon if this is a moon territory
      if (sponsor.territoryType === "moon" && sponsor.inquiryData?.moonIndex != null && moonSponsorStore) {
        await moonSponsorStore.assign(sponsor.inquiryData.moonIndex, {
          name: sponsor.name,
          tagline: sponsor.tagline || "",
          websiteUrl: sponsor.websiteUrl || "",
        });
      }

      // Assign billboard if this is a billboard territory
      if (sponsor.territoryType === "billboard" && sponsor.inquiryData?.billboardIndex != null && billboardSponsorStore) {
        await billboardSponsorStore.assign(sponsor.inquiryData.billboardIndex, {
          name: sponsor.name,
          tagline: sponsor.tagline || "",
          websiteUrl: sponsor.websiteUrl || "",
        });
      }

      // Activate: change ownerType to admin, set active
      await sponsorStore.update(req.params.id, {
        ownerType: "admin",
        active: true,
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

module.exports = { createSponsorRoutes, extractSponsorImages };
