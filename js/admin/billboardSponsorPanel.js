/**
 * AdLands - Billboard Sponsor Manager (API utility)
 * Manages billboard-sponsor assignments via the REST API.
 * Billboards are selected in the hex selector; this class handles persistence.
 * 21 fixed slots: indices 0-11 (low orbit), 12-17 (mid orbit), 18-20 (high orbit).
 */

const BILLBOARD_SLOT_COUNT = 21;

class BillboardSponsorManager {
  constructor() {
    const loc = window.location;
    this.apiBase = loc.protocol + "//" + loc.host;
    this.sponsors = new Array(BILLBOARD_SLOT_COUNT).fill(null);
  }

  /**
   * Load all billboard sponsor data from server
   */
  async load() {
    try {
      const res = await fetch(this.apiBase + "/api/billboard-sponsors");
      if (!res.ok) throw new Error("Failed to load billboard sponsors");
      const data = await res.json();
      data.forEach((sponsor, i) => {
        if (i < BILLBOARD_SLOT_COUNT) this.sponsors[i] = sponsor;
      });
    } catch (e) {
      console.warn("[BillboardSponsorManager] Could not load:", e.message);
    }
  }

  /**
   * Get which billboards are assigned to a given sponsor (matched by name, case-insensitive)
   * @param {string} sponsorName
   * @returns {number[]} array of billboard indices
   */
  getBillboardsForSponsor(sponsorName) {
    if (!sponsorName) return [];
    const nameLower = sponsorName.toLowerCase();
    const result = [];
    for (let i = 0; i < BILLBOARD_SLOT_COUNT; i++) {
      const s = this.sponsors[i];
      if (s && s.name && s.name.toLowerCase() === nameLower) {
        result.push(i);
      }
    }
    return result;
  }

  /**
   * Build a map of assigned billboards (for other sponsors), excluding a given sponsor name
   * @param {string|null} excludeName - Sponsor name to exclude (currently editing)
   * @returns {Map<number, string>} billboardIndex → sponsorName
   */
  getAssignedBillboards(excludeName = null) {
    const map = new Map();
    const excludeLower = excludeName ? excludeName.toLowerCase() : null;
    for (let i = 0; i < BILLBOARD_SLOT_COUNT; i++) {
      const s = this.sponsors[i];
      if (s && s.name) {
        if (excludeLower && s.name.toLowerCase() === excludeLower) continue;
        map.set(i, s.name);
      }
    }
    return map;
  }

  /**
   * Assign billboards to a sponsor. Saves via API.
   * Also clears any billboards that were previously assigned to this sponsor but aren't in the new list.
   * @param {number[]} billboardIndices - Billboard indices to assign
   * @param {Object} sponsorData - { name, tagline, websiteUrl, patternImage, patternAdjustment }
   */
  async saveBillboardsForSponsor(billboardIndices, sponsorData) {
    const bbSet = new Set(billboardIndices);
    const nameLower = sponsorData.name.toLowerCase();

    // Clear billboards that were ours but aren't anymore (in parallel)
    const clearOps = [];
    for (let i = 0; i < BILLBOARD_SLOT_COUNT; i++) {
      const s = this.sponsors[i];
      if (s && s.name && s.name.toLowerCase() === nameLower && !bbSet.has(i)) {
        clearOps.push(this._clearBillboard(i));
      }
    }
    await Promise.all(clearOps);

    // Assign selected billboards (in parallel)
    await Promise.all(billboardIndices.map(bi => this._saveBillboard(bi, sponsorData)));
  }

  /**
   * Clear all billboards belonging to a sponsor (by name)
   * @param {string} sponsorName
   */
  async clearBillboardsForSponsor(sponsorName) {
    if (!sponsorName) return;
    const nameLower = sponsorName.toLowerCase();
    const ops = [];
    for (let i = 0; i < BILLBOARD_SLOT_COUNT; i++) {
      const s = this.sponsors[i];
      if (s && s.name && s.name.toLowerCase() === nameLower) {
        ops.push(this._clearBillboard(i));
      }
    }
    await Promise.all(ops);
  }

  async _saveBillboard(billboardIndex, sponsorData) {
    const body = {
      name: sponsorData.name,
      tagline: sponsorData.tagline || "",
      websiteUrl: sponsorData.websiteUrl || "",
      logoImage: sponsorData.logoImage || null,
      patternImage: sponsorData.patternImage || null,
      patternAdjustment: sponsorData.patternAdjustment || {
        scale: 1, offsetX: 0, offsetY: 0, saturation: 1,
        inputBlack: 0, inputGamma: 1, inputWhite: 255,
        outputBlack: 0, outputWhite: 255,
      },
    };

    try {
      const res = await fetch(this.apiBase + "/api/billboard-sponsors/" + billboardIndex, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err.errors || ["Failed to save billboard"]).join(". "));
      }
      const saved = await res.json();
      this.sponsors[billboardIndex] = saved;
    } catch (e) {
      console.warn("[BillboardSponsorManager] Save failed for billboard", billboardIndex, e.message);
    }
  }

  async _clearBillboard(billboardIndex) {
    try {
      const res = await fetch(this.apiBase + "/api/billboard-sponsors/" + billboardIndex, {
        method: "DELETE",
      });
      if (res.ok || res.status === 404) {
        this.sponsors[billboardIndex] = null;
      }
    } catch (e) {
      console.warn("[BillboardSponsorManager] Clear failed for billboard", billboardIndex, e.message);
    }
  }
}
