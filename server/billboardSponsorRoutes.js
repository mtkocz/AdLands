/**
 * AdLands - Billboard Sponsor REST API Routes
 * Express router for /api/billboard-sponsors CRUD operations.
 * Mutations trigger live reload to broadcast changes to connected game clients.
 */

const { Router } = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const MAX_INDEX = 17; // 0-17 = 18 slots

/**
 * Extract base64 billboard sponsor images to static PNG files on disk.
 * Returns a map of billboardIndex → { patternUrl }.
 */
async function extractBillboardSponsorImages(billboardSponsorStore, gameDir) {
  const texDir = path.join(gameDir, "sponsor-textures");
  if (!fs.existsSync(texDir)) await fsp.mkdir(texDir, { recursive: true });

  const urlMap = {};
  const sponsors = billboardSponsorStore.getAll();
  for (let i = 0; i < sponsors.length; i++) {
    const s = sponsors[i];
    if (!s || !s.patternImage) continue;

    const match = s.patternImage.match(/^data:image\/(\w+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const filePath = path.join(texDir, `billboard_${i}.${ext}`);
      await fsp.writeFile(filePath, Buffer.from(match[2], "base64"));
      urlMap[i] = { patternUrl: `/sponsor-textures/billboard_${i}.${ext}` };
    }
  }
  return urlMap;
}

function createBillboardSponsorRoutes(billboardSponsorStore, gameRoom, { imageUrls, gameDir } = {}) {
  const router = Router();

  let _imageUrls = imageUrls || {};

  function reloadIfLive() {
    if (gameRoom && typeof gameRoom.reloadBillboardSponsors === "function") {
      gameRoom.reloadBillboardSponsors();
    }
  }

  async function reExtractImages() {
    if (!gameDir) return;
    _imageUrls = await extractBillboardSponsorImages(billboardSponsorStore, gameDir);
    if (gameRoom) gameRoom.billboardSponsorImageUrls = _imageUrls;
  }

  /**
   * Strip heavy base64 fields from a billboard sponsor for responses.
   * Replaces patternImage with static URL when available.
   */
  function toLite(sponsor, billboardIndex) {
    if (!sponsor) return null;
    const lite = { ...sponsor };
    const urls = _imageUrls[billboardIndex];

    delete lite.patternImage;
    if (urls?.patternUrl) lite.patternUrl = urls.patternUrl;

    return lite;
  }

  // GET /api/billboard-sponsors — list all 18 billboard sponsor slots
  router.get("/", (req, res) => {
    const full = req.query.full === "1";
    const sponsors = billboardSponsorStore.getAll();
    const data = full
      ? sponsors
      : sponsors.map((s, i) => toLite(s, i));
    res.json(data);
  });

  // GET /api/billboard-sponsors/:billboardIndex — get one billboard sponsor
  router.get("/:billboardIndex", (req, res) => {
    const billboardIndex = parseInt(req.params.billboardIndex, 10);
    if (isNaN(billboardIndex) || billboardIndex < 0 || billboardIndex > MAX_INDEX) {
      return res.status(400).json({ errors: [`billboardIndex must be 0 through ${MAX_INDEX}`] });
    }
    const sponsor = billboardSponsorStore.getByIndex(billboardIndex);
    res.json(sponsor);
  });

  // PUT /api/billboard-sponsors/:billboardIndex — assign sponsor to a billboard
  router.put("/:billboardIndex", async (req, res) => {
    const billboardIndex = parseInt(req.params.billboardIndex, 10);
    if (isNaN(billboardIndex) || billboardIndex < 0 || billboardIndex > MAX_INDEX) {
      return res.status(400).json({ errors: [`billboardIndex must be 0 through ${MAX_INDEX}`] });
    }

    const result = await billboardSponsorStore.assign(billboardIndex, req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });

    await reExtractImages();
    reloadIfLive();
    res.json(result.sponsor);
  });

  // DELETE /api/billboard-sponsors/:billboardIndex — clear a billboard's sponsor
  router.delete("/:billboardIndex", async (req, res) => {
    const billboardIndex = parseInt(req.params.billboardIndex, 10);
    if (isNaN(billboardIndex) || billboardIndex < 0 || billboardIndex > MAX_INDEX) {
      return res.status(400).json({ errors: [`billboardIndex must be 0 through ${MAX_INDEX}`] });
    }

    const cleared = await billboardSponsorStore.clear(billboardIndex);
    if (!cleared) return res.status(404).json({ errors: ["Billboard has no sponsor to clear"] });

    await reExtractImages();
    reloadIfLive();
    res.json({ success: true });
  });

  return router;
}

module.exports = { createBillboardSponsorRoutes, extractBillboardSponsorImages };
