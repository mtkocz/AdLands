/**
 * AdLands - Moon Sponsor REST API Routes
 * Express router for /api/moon-sponsors CRUD operations.
 * Mutations trigger live reload to broadcast changes to connected game clients.
 */

const { Router } = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

/**
 * Extract base64 moon sponsor images to static PNG files on disk.
 * Returns a map of moonIndex → { patternUrl }.
 */
async function extractMoonSponsorImages(moonSponsorStore, gameDir) {
  const texDir = path.join(gameDir, "sponsor-textures");
  if (!fs.existsSync(texDir)) await fsp.mkdir(texDir, { recursive: true });

  const urlMap = {};
  const sponsors = moonSponsorStore.getAll();
  for (let i = 0; i < sponsors.length; i++) {
    const s = sponsors[i];
    if (!s || !s.patternImage) continue;

    const match = s.patternImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const filePath = path.join(texDir, `moon_${i}.${ext}`);
      await fsp.writeFile(filePath, Buffer.from(match[2], "base64"));
      urlMap[i] = { patternUrl: `/sponsor-textures/moon_${i}.${ext}` };
    }
  }
  return urlMap;
}

function createMoonSponsorRoutes(moonSponsorStore, gameRoom, { imageUrls, gameDir } = {}) {
  const router = Router();

  let _imageUrls = imageUrls || {};

  function reloadIfLive() {
    if (gameRoom && typeof gameRoom.reloadMoonSponsors === "function") {
      gameRoom.reloadMoonSponsors();
    }
  }

  async function reExtractImages() {
    if (!gameDir) return;
    _imageUrls = await extractMoonSponsorImages(moonSponsorStore, gameDir);
    if (gameRoom) gameRoom.moonSponsorImageUrls = _imageUrls;
  }

  /**
   * Strip heavy base64 fields from a moon sponsor for responses.
   * Replaces patternImage with static URL when available.
   */
  function toLite(sponsor, moonIndex) {
    if (!sponsor) return null;
    const lite = { ...sponsor };
    const urls = _imageUrls[moonIndex];

    delete lite.patternImage;
    if (urls?.patternUrl) lite.patternUrl = urls.patternUrl;

    return lite;
  }

  // GET /api/moon-sponsors — list all 3 moon sponsor slots
  router.get("/", (req, res) => {
    const full = req.query.full === "1";
    const sponsors = moonSponsorStore.getAll();
    const data = full
      ? sponsors
      : sponsors.map((s, i) => toLite(s, i));
    res.json(data);
  });

  // GET /api/moon-sponsors/:moonIndex — get one moon sponsor
  router.get("/:moonIndex", (req, res) => {
    const moonIndex = parseInt(req.params.moonIndex, 10);
    if (isNaN(moonIndex) || moonIndex < 0 || moonIndex > 2) {
      return res.status(400).json({ errors: ["moonIndex must be 0, 1, or 2"] });
    }
    const sponsor = moonSponsorStore.getByIndex(moonIndex);
    res.json(sponsor);
  });

  // PUT /api/moon-sponsors/:moonIndex — assign sponsor to a moon
  router.put("/:moonIndex", async (req, res) => {
    const moonIndex = parseInt(req.params.moonIndex, 10);
    if (isNaN(moonIndex) || moonIndex < 0 || moonIndex > 2) {
      return res.status(400).json({ errors: ["moonIndex must be 0, 1, or 2"] });
    }

    const result = await moonSponsorStore.assign(moonIndex, req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });

    await reExtractImages();
    reloadIfLive();
    res.json(result.sponsor);
  });

  // DELETE /api/moon-sponsors/:moonIndex — clear a moon's sponsor
  router.delete("/:moonIndex", async (req, res) => {
    const moonIndex = parseInt(req.params.moonIndex, 10);
    if (isNaN(moonIndex) || moonIndex < 0 || moonIndex > 2) {
      return res.status(400).json({ errors: ["moonIndex must be 0, 1, or 2"] });
    }

    const cleared = await moonSponsorStore.clear(moonIndex);
    if (!cleared) return res.status(404).json({ errors: ["Moon has no sponsor to clear"] });

    await reExtractImages();
    reloadIfLive();
    res.json({ success: true });
  });

  return router;
}

module.exports = { createMoonSponsorRoutes, extractMoonSponsorImages };
