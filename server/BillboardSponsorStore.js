/**
 * AdLands - Server-Side Billboard Sponsor Store
 * Manages 18 fixed billboard slots (index 0-17) across 2 orbit tiers:
 *   LOW (0-11), HIGH (12-17)
 * Extends FixedSlotSponsorStore with billboard-specific configuration.
 */

const FixedSlotSponsorStore = require("./FixedSlotSponsorStore");

class BillboardSponsorStore extends FixedSlotSponsorStore {
  constructor(filePath, opts = {}) {
    super(filePath, {
      slotCount: 18,
      arrayKey: "billboardSponsors",
      firestoreCollection: "billboard_sponsor_store",
      idPrefix: "bsponsor_",
      logTag: "[BillboardSponsorStore]",
    }, opts);
  }
}

module.exports = BillboardSponsorStore;
