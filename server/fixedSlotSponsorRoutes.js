/**
 * AdLands - Fixed-Slot Sponsor REST API Routes (Shared Factory)
 * Creates Express routers for fixed-slot sponsor stores (moons, billboards).
 * Mutations trigger live reload to broadcast changes to connected game clients.
 */

const { Router } = require("express");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
let applyPixelArtFilter;
try { applyPixelArtFilter = require("./pixelArtFilter").applyPixelArtFilter; } catch (e) { /* optional — needs sharp */ }

/** Find an existing file on disk matching a prefix. */
function findExistingFile(texDir, prefix) {
  try {
    const files = fs.readdirSync(texDir);
    return files.find(f => f.startsWith(prefix)) || null;
  } catch (e) { return null; }
}

/** Append file mtime as cache-buster query param. */
function withMtime(urlPath, filePath) {
  try { return urlPath + "?v=" + Math.floor(fs.statSync(filePath).mtimeMs); }
  catch (e) { return urlPath; }
}

/**
 * Extract base64 sponsor images to static PNG files on disk.
 * Applies pixel art filter (128px, 8 colors, Bayer dithering) when sharp is available.
 * @param {Object} store - FixedSlotSponsorStore instance
 * @param {string} gameDir - Root game directory
 * @param {string} filePrefix - Filename prefix (e.g. "moon_", "billboard_")
 * @returns {Promise<Object>} Map of index → { patternUrl }
 */
async function extractSlotSponsorImages(store, gameDir, filePrefix) {
  const texDir = path.join(gameDir, "sponsor-textures");
  if (!fs.existsSync(texDir)) await fsp.mkdir(texDir, { recursive: true });

  const urlMap = {};
  const sponsors = store.getAll();
  for (let i = 0; i < sponsors.length; i++) {
    const s = sponsors[i];
    if (!s) continue;

    if (s.patternImage) {
      const match = s.patternImage.match(/^data:image\/(\w+);base64,(.+)$/);
      if (match) {
        const raw = Buffer.from(match[2], "base64");
        if (applyPixelArtFilter) {
          const baked = await applyPixelArtFilter(raw);
          const pngPath = path.join(texDir, `${filePrefix}${i}.png`);
          await fsp.writeFile(pngPath, baked);
          urlMap[i] = { patternUrl: withMtime(`/sponsor-textures/${filePrefix}${i}.png`, pngPath) };
        } else {
          const ext = match[1] === "jpeg" ? "jpg" : match[1];
          const filePath = path.join(texDir, `${filePrefix}${i}.${ext}`);
          await fsp.writeFile(filePath, raw);
          urlMap[i] = { patternUrl: withMtime(`/sponsor-textures/${filePrefix}${i}.${ext}`, filePath) };
        }
      }
    } else {
      // No base64 — find existing file on disk, re-bake if oversized
      const existing = findExistingFile(texDir, `${filePrefix}${i}.`);
      if (existing) {
        const filePath = path.join(texDir, existing);
        if (applyPixelArtFilter) {
          try {
            const stat = fs.statSync(filePath);
            if (stat.size > 5000) {
              const raw = fs.readFileSync(filePath);
              const baked = await applyPixelArtFilter(raw);
              const pngPath = path.join(texDir, `${filePrefix}${i}.png`);
              await fsp.writeFile(pngPath, baked);
              urlMap[i] = { patternUrl: withMtime(`/sponsor-textures/${filePrefix}${i}.png`, pngPath) };
            } else {
              urlMap[i] = { patternUrl: withMtime(`/sponsor-textures/${existing}`, filePath) };
            }
          } catch (e) {
            urlMap[i] = { patternUrl: withMtime(`/sponsor-textures/${existing}`, filePath) };
          }
        } else {
          urlMap[i] = { patternUrl: withMtime(`/sponsor-textures/${existing}`, filePath) };
        }
      }
    }
  }
  return urlMap;
}

/**
 * Create Express router for a fixed-slot sponsor store.
 * @param {Object} store - FixedSlotSponsorStore instance
 * @param {Object} gameRoom - GameRoom instance
 * @param {Object} config
 * @param {number} config.maxIndex - Maximum slot index (slotCount - 1)
 * @param {string} config.filePrefix - File prefix for extracted images
 * @param {string} config.reloadMethod - GameRoom method to call on changes
 * @param {string} config.imageUrlsKey - GameRoom property for image URL map
 * @param {string} config.entityName - Human-readable name for error messages
 * @param {Object} [routeOpts] - { imageUrls, gameDir }
 */
function createFixedSlotSponsorRoutes(store, gameRoom, config, routeOpts = {}) {
  const router = Router();
  const { maxIndex, filePrefix, reloadMethod, imageUrlsKey, entityName } = config;

  let _imageUrls = routeOpts.imageUrls || {};

  function reloadIfLive() {
    if (gameRoom && typeof gameRoom[reloadMethod] === "function") {
      gameRoom[reloadMethod]();
    }
  }

  async function reExtractImages() {
    if (!routeOpts.gameDir) return;
    _imageUrls = await extractSlotSponsorImages(store, routeOpts.gameDir, filePrefix);
    if (gameRoom) gameRoom[imageUrlsKey] = _imageUrls;
  }

  function toLite(sponsor, index) {
    if (!sponsor) return null;
    const lite = { ...sponsor };
    const urls = _imageUrls[index];
    delete lite.patternImage;
    if (urls?.patternUrl) lite.patternUrl = urls.patternUrl;
    return lite;
  }

  router.get("/", (req, res) => {
    const full = req.query.full === "1";
    const sponsors = store.getAll();
    const data = full ? sponsors : sponsors.map((s, i) => toLite(s, i));
    res.json(data);
  });

  router.get("/:index", (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index > maxIndex) {
      return res.status(400).json({ errors: [`Index must be 0 through ${maxIndex}`] });
    }
    const sponsor = store.getByIndex(index);
    res.json(sponsor);
  });

  router.put("/:index", async (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index > maxIndex) {
      return res.status(400).json({ errors: [`Index must be 0 through ${maxIndex}`] });
    }

    const result = await store.assign(index, req.body);
    if (result.errors) return res.status(400).json({ errors: result.errors });

    await reExtractImages();
    reloadIfLive();
    res.json(result.sponsor);
  });

  router.delete("/:index", async (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index) || index < 0 || index > maxIndex) {
      return res.status(400).json({ errors: [`Index must be 0 through ${maxIndex}`] });
    }

    const cleared = await store.clear(index);
    if (!cleared) return res.status(404).json({ errors: [`${entityName} has no sponsor to clear`] });

    await reExtractImages();
    reloadIfLive();
    res.json({ success: true });
  });

  return router;
}

module.exports = { createFixedSlotSponsorRoutes, extractSlotSponsorImages };
