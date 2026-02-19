/**
 * AdLands - Server-Side Moon Sponsor Store
 * Manages 3 fixed moon slots (index 0, 1, 2) — each can hold one sponsor.
 * Extends FixedSlotSponsorStore with moon-specific configuration.
 */

const FixedSlotSponsorStore = require("./FixedSlotSponsorStore");

class MoonSponsorStore extends FixedSlotSponsorStore {
  constructor(filePath, opts = {}) {
    super(filePath, {
      slotCount: 3,
      arrayKey: "moonSponsors",
      firestoreCollection: "moon_sponsor_store",
      idPrefix: "msponsor_",
      logTag: "[MoonSponsorStore]",
    }, opts);
  }
}

module.exports = MoonSponsorStore;
