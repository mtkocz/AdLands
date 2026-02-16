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

/**
 * Extract a single sponsor's base64 images to static PNG files on disk.
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
  }
  if (sponsor.logoImage) {
    const match = sponsor.logoImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const filePath = path.join(texDir, `${sponsor.id}_logo.${ext}`);
      await fsp.writeFile(filePath, Buffer.from(match[2], "base64"));
      urls.logoUrl = `/sponsor-textures/${sponsor.id}_logo.${ext}`;
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

function createSponsorRoutes(sponsorStore, gameRoom, { imageUrls, gameDir } = {}) {
  const router = Router();

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
  router.get("/", (req, res) => {
    const full = req.query.full === "1";
    const sponsors = sponsorStore.getAll();
    const data = {
      version: 1,
      sponsors: full ? sponsors : sponsors.map(toLite),
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
  router.get("/:id", (req, res) => {
    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor) return res.status(404).json({ errors: ["Sponsor not found"] });
    res.json(sponsor);
  });

  // POST /api/sponsors — create new sponsor
  router.post("/", async (req, res) => {
    const result = await sponsorStore.create(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    await reExtractImages(result.sponsor.id);
    reloadIfLive();
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

    // Capture sponsor data before deleting so we can notify the owner
    const sponsor = sponsorStore.getById(deletedId);

    const deleted = await sponsorStore.delete(deletedId);
    if (!deleted) return res.status(404).json({ errors: ["Sponsor not found"] });
    // Remove orphaned image files for deleted sponsor
    await cleanupSponsorImages(deletedId);

    // Clean up player territory: notify owner and remove Firestore document
    if (sponsor && sponsor.isPlayerTerritory) {
      const territoryId = sponsor._territoryId || sponsor.id;

      // Remove the territory document from Firestore
      try {
        const db = getFirestore();
        await db.collection("territories").doc(territoryId).delete();
      } catch (e) {
        console.warn(`[sponsorRoutes] Firestore territory cleanup failed for ${territoryId}:`, e.message);
      }

      // Notify the owning player via socket
      if (sponsor.ownerUid && gameRoom) {
        const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
        for (const s of sockets) {
          if (s.uid === sponsor.ownerUid) {
            s.emit("territory-deleted", { territoryId, sponsorStorageId: deletedId });
          }
        }
      }
    }

    reloadIfLive();
    res.json({ success: true });
  });

  // POST /api/sponsors/:id/review-image — admin approves or rejects a pending territory image
  router.post("/:id/review-image", async (req, res) => {
    const { action, rejectionReason } = req.body || {};
    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ errors: ["Invalid action. Must be 'approve' or 'reject'."] });
    }

    const sponsor = sponsorStore.getById(req.params.id);
    if (!sponsor || !sponsor.isPlayerTerritory) {
      return res.status(404).json({ errors: ["Player territory not found"] });
    }
    if (sponsor.imageStatus !== "pending" || !sponsor.pendingImage) {
      return res.status(400).json({ errors: ["No pending image to review"] });
    }

    const territoryId = sponsor._territoryId || sponsor.id;

    try {
      if (action === "approve") {
        // Move pending image to approved pattern in SponsorStorage
        const approvedImage = sponsor.pendingImage;
        await sponsorStore.update(req.params.id, {
          patternImage: approvedImage,
          pendingImage: null,
          imageStatus: "approved",
          reviewedAt: new Date().toISOString(),
          rejectionReason: null,
        });

        // Re-extract image to static file
        await reExtractImages(req.params.id);

        // Update Firestore
        try {
          const db = getFirestore();
          await db.collection("territories").doc(territoryId).update({
            patternImage: approvedImage,
            pendingImage: null,
            imageStatus: "approved",
            reviewedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
            rejectionReason: null,
          });
        } catch (e) {
          console.warn("[Territory] Firestore approve update failed:", e.message);
        }

        // Broadcast approved image to all connected players
        const urls = _imageUrls[req.params.id] || {};
        if (gameRoom) {
          gameRoom.io.to(gameRoom.roomId).emit("territory-image-approved", {
            territoryId,
            patternImage: urls.patternUrl || approvedImage,
            patternAdjustment: sponsor.patternAdjustment || {},
            tileIndices: sponsor.cluster?.tileIndices || [],
            playerName: sponsor.name,
          });

          // Notify the owning player specifically
          if (sponsor.ownerUid) {
            const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
            for (const s of sockets) {
              if (s.uid === sponsor.ownerUid) {
                s.emit("territory-image-review-result", { territoryId, status: "approved" });
              }
            }
          }
        }

        console.log(`[Territory] Image approved for ${territoryId}`);
        res.json({ success: true, action: "approved" });
      } else {
        // Reject: clear pending image, set status
        await sponsorStore.update(req.params.id, {
          pendingImage: null,
          imageStatus: "rejected",
          reviewedAt: new Date().toISOString(),
          rejectionReason: rejectionReason || "Image rejected by admin",
        });

        // Update Firestore
        try {
          const db = getFirestore();
          await db.collection("territories").doc(territoryId).update({
            pendingImage: null,
            imageStatus: "rejected",
            reviewedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
            rejectionReason: rejectionReason || "Image rejected by admin",
          });
        } catch (e) {
          console.warn("[Territory] Firestore reject update failed:", e.message);
        }

        // Notify the owning player
        if (gameRoom && sponsor.ownerUid) {
          const sockets = await gameRoom.io.in(gameRoom.roomId).fetchSockets();
          for (const s of sockets) {
            if (s.uid === sponsor.ownerUid) {
              s.emit("territory-image-review-result", {
                territoryId,
                status: "rejected",
                reason: rejectionReason || "Image rejected by admin",
              });
            }
          }
        }

        console.log(`[Territory] Image rejected for ${territoryId}`);
        res.json({ success: true, action: "rejected" });
      }
    } catch (err) {
      console.error("[Territory] Review failed:", err);
      res.status(500).json({ errors: ["Review failed: " + err.message] });
    }
  });

  return router;
}

module.exports = { createSponsorRoutes, extractSponsorImages };
