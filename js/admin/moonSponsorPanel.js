/**
 * AdLands - Moon Sponsor Manager (API utility)
 * Manages moon-sponsor assignments via the REST API.
 * Moons are selected in the hex selector like tiles; this class handles persistence.
 */

class MoonSponsorManager {
  constructor() {
    const loc = window.location;
    this.apiBase = loc.protocol + "//" + loc.host;
    this.sponsors = [null, null, null]; // cached sponsor data per moon
  }

  /**
   * Load all moon sponsor data from server
   */
  async load() {
    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors");
      if (!res.ok) throw new Error("Failed to load moon sponsors");
      const data = await res.json();
      data.forEach((sponsor, i) => {
        if (i < 3) this.sponsors[i] = sponsor;
      });
    } catch (e) {
      console.warn("[MoonSponsorManager] Could not load:", e.message);
    }
  }

  /**
   * Get which moons are assigned to a given sponsor (matched by name, case-insensitive)
   * @param {string} sponsorName
   * @returns {number[]} array of moon indices
   */
  getMoonsForSponsor(sponsorName) {
    if (!sponsorName) return [];
    const nameLower = sponsorName.toLowerCase();
    const result = [];
    for (let i = 0; i < 3; i++) {
      const s = this.sponsors[i];
      if (s && s.name && s.name.toLowerCase() === nameLower) {
        result.push(i);
      }
    }
    return result;
  }

  /**
   * Build a map of assigned moons (for other sponsors), excluding a given sponsor name
   * @param {string|null} excludeName - Sponsor name to exclude (currently editing)
   * @returns {Map<number, string>} moonIndex → sponsorName
   */
  getAssignedMoons(excludeName = null) {
    const map = new Map();
    const excludeLower = excludeName ? excludeName.toLowerCase() : null;
    for (let i = 0; i < 3; i++) {
      const s = this.sponsors[i];
      if (s && s.name) {
        if (excludeLower && s.name.toLowerCase() === excludeLower) continue;
        map.set(i, s.name);
      }
    }
    return map;
  }

  /**
   * Assign moons to a sponsor. Saves via API.
   * Also clears any moons that were previously assigned to this sponsor but aren't in the new list.
   * @param {number[]} moonIndices - Moon indices to assign
   * @param {Object} sponsorData - { name, tagline, websiteUrl, patternImage, patternAdjustment }
   */
  async saveMoonsForSponsor(moonIndices, sponsorData) {
    const moonSet = new Set(moonIndices);
    const nameLower = sponsorData.name.toLowerCase();

    // Clear moons that were ours but aren't anymore
    for (let i = 0; i < 3; i++) {
      const s = this.sponsors[i];
      if (s && s.name && s.name.toLowerCase() === nameLower && !moonSet.has(i)) {
        await this._clearMoon(i);
      }
    }

    // Assign selected moons
    for (const mi of moonIndices) {
      await this._saveMoon(mi, sponsorData);
    }
  }

  /**
   * Clear all moons belonging to a sponsor (by name)
   * @param {string} sponsorName
   */
  async clearMoonsForSponsor(sponsorName) {
    if (!sponsorName) return;
    const nameLower = sponsorName.toLowerCase();
    for (let i = 0; i < 3; i++) {
      const s = this.sponsors[i];
      if (s && s.name && s.name.toLowerCase() === nameLower) {
        await this._clearMoon(i);
      }
    }
  }

  async _saveMoon(moonIndex, sponsorData) {
    const body = {
      name: sponsorData.name,
      tagline: sponsorData.tagline || "",
      websiteUrl: sponsorData.websiteUrl || "",
      patternImage: sponsorData.patternImage || null,
      patternAdjustment: sponsorData.patternAdjustment || {
        scale: 1, offsetX: 0, offsetY: 0, saturation: 1,
        inputBlack: 0, inputGamma: 1, inputWhite: 255,
        outputBlack: 0, outputWhite: 255,
      },
    };

    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors/" + moonIndex, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err.errors || ["Failed to save moon"]).join(". "));
      }
      const saved = await res.json();
      this.sponsors[moonIndex] = saved;
    } catch (e) {
      console.warn("[MoonSponsorManager] Save failed for moon", moonIndex, e.message);
    }
  }

  async _clearMoon(moonIndex) {
    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors/" + moonIndex, {
        method: "DELETE",
      });
      if (res.ok || res.status === 404) {
        this.sponsors[moonIndex] = null;
      }
    } catch (e) {
      console.warn("[MoonSponsorManager] Clear failed for moon", moonIndex, e.message);
    }
  }
}
