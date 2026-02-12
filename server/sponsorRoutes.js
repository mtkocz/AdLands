/**
 * AdLands - Sponsor REST API Routes
 * Express router for /api/sponsors CRUD operations.
 * Mutations trigger live reload to broadcast changes to connected clients.
 */

const { Router } = require("express");
const fs = require("fs");
const path = require("path");

/**
 * Extract base64 sponsor images to static PNG files on disk.
 * Returns a map of sponsorId → { patternUrl, logoUrl }.
 */
function extractSponsorImages(sponsorStore, gameDir) {
  const texDir = path.join(gameDir, "sponsor-textures");
  if (!fs.existsSync(texDir)) fs.mkdirSync(texDir);

  const urlMap = {};
  for (const s of sponsorStore.getAll()) {
    const urls = {};
    if (s.patternImage) {
      const match = s.patternImage.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const filePath = path.join(texDir, `${s.id}.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
        urls.patternUrl = `/sponsor-textures/${s.id}.${ext}`;
      }
    }
    if (s.logoImage) {
      const match = s.logoImage.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const filePath = path.join(texDir, `${s.id}_logo.${ext}`);
        fs.writeFileSync(filePath, Buffer.from(match[2], "base64"));
        urls.logoUrl = `/sponsor-textures/${s.id}_logo.${ext}`;
      }
    }
    if (urls.patternUrl || urls.logoUrl) {
      urlMap[s.id] = urls;
    }
  }
  console.log(`[SponsorRoutes] Extracted ${Object.keys(urlMap).length} sponsor image sets to ${texDir}`);
  return urlMap;
}

function createSponsorRoutes(sponsorStore, gameRoom, { imageUrls, gameDir } = {}) {
  const router = Router();

  // Mutable reference so we can update after re-extraction
  let _imageUrls = imageUrls || {};

  function reloadIfLive() {
    if (gameRoom && typeof gameRoom.reloadSponsors === "function") {
      gameRoom.reloadSponsors();
    }
  }

  /**
   * Re-extract sponsor images and update the URL map.
   * Called after mutations so static files stay in sync.
   */
  function reExtractImages() {
    if (gameDir) {
      _imageUrls = extractSponsorImages(sponsorStore, gameDir);
    }
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
  router.post("/", (req, res) => {
    const result = sponsorStore.create(req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });
    reExtractImages();
    reloadIfLive();
    res.status(201).json(result.sponsor);
  });

  // POST /api/sponsors/import — bulk import
  router.post("/import", (req, res) => {
    const merge = req.body.merge !== false; // default true
    const result = sponsorStore.importJSON(req.body, merge);
    reExtractImages();
    reloadIfLive();
    res.json(result);
  });

  // PUT /api/sponsors/:id — update existing sponsor
  router.put("/:id", (req, res) => {
    const result = sponsorStore.update(req.params.id, req.body);
    if (result.errors) {
      const status = result.errors.includes("Sponsor not found") ? 404 : 400;
      return res.status(status).json({ errors: result.errors });
    }
    reExtractImages();
    reloadIfLive();
    res.json(result.sponsor);
  });

  // DELETE /api/sponsors/:id — delete sponsor
  router.delete("/:id", (req, res) => {
    const deleted = sponsorStore.delete(req.params.id);
    if (!deleted) return res.status(404).json({ errors: ["Sponsor not found"] });
    reExtractImages();
    reloadIfLive();
    res.json({ success: true });
  });

  return router;
}

module.exports = { createSponsorRoutes, extractSponsorImages };
