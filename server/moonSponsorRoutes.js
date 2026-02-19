/**
 * AdLands - Moon Sponsor REST API Routes
 * Express router for /api/moon-sponsors CRUD operations.
 * Thin wrapper around shared fixedSlotSponsorRoutes.
 */

const { createFixedSlotSponsorRoutes, extractSlotSponsorImages } = require("./fixedSlotSponsorRoutes");

function extractMoonSponsorImages(moonSponsorStore, gameDir) {
  return extractSlotSponsorImages(moonSponsorStore, gameDir, "moon_");
}

function createMoonSponsorRoutes(moonSponsorStore, gameRoom, opts = {}) {
  return createFixedSlotSponsorRoutes(moonSponsorStore, gameRoom, {
    maxIndex: 2,
    filePrefix: "moon_",
    reloadMethod: "reloadMoonSponsors",
    imageUrlsKey: "moonSponsorImageUrls",
    entityName: "Moon",
  }, opts);
}

module.exports = { createMoonSponsorRoutes, extractMoonSponsorImages };
