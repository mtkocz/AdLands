/**
 * AdLands - Billboard Sponsor REST API Routes
 * Express router for /api/billboard-sponsors CRUD operations.
 * Thin wrapper around shared fixedSlotSponsorRoutes.
 */

const { createFixedSlotSponsorRoutes, extractSlotSponsorImages } = require("./fixedSlotSponsorRoutes");

function extractBillboardSponsorImages(billboardSponsorStore, gameDir) {
  return extractSlotSponsorImages(billboardSponsorStore, gameDir, "billboard_");
}

function createBillboardSponsorRoutes(billboardSponsorStore, gameRoom, opts = {}) {
  return createFixedSlotSponsorRoutes(billboardSponsorStore, gameRoom, {
    maxIndex: 17,
    filePrefix: "billboard_",
    reloadMethod: "reloadBillboardSponsors",
    imageUrlsKey: "billboardSponsorImageUrls",
    entityName: "Billboard",
  }, opts);
}

module.exports = { createBillboardSponsorRoutes, extractBillboardSponsorImages };
