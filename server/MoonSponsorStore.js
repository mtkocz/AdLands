/**
 * AdLands - Server-Side Moon Sponsor Store
 * Reads/writes data/moonSponsors.json with in-memory cache.
 * Manages 3 fixed moon slots (index 0, 1, 2) — each can hold one sponsor.
 */

const fs = require("fs");
const path = require("path");

class MoonSponsorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._cache = null;
  }

  /**
   * Load moon sponsors from disk into memory cache.
   * Auto-creates directory and file if missing.
   */
  load() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this._cache = { version: 1, moonSponsors: [null, null, null], lastModified: "" };
      this._saveToDisk();
      console.log(`[MoonSponsorStore] Created empty ${this.filePath}`);
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this._cache = JSON.parse(raw);
      // Ensure 3 slots
      while (this._cache.moonSponsors.length < 3) this._cache.moonSponsors.push(null);
      const active = this._cache.moonSponsors.filter(Boolean).length;
      console.log(`[MoonSponsorStore] Loaded ${active} moon sponsors from disk`);
    } catch (e) {
      console.error("[MoonSponsorStore] Failed to read moon sponsors file:", e.message);
      this._cache = { version: 1, moonSponsors: [null, null, null], lastModified: "" };
    }
  }

  /**
   * Atomic write: write to .tmp then rename to prevent corruption.
   */
  _saveToDisk() {
    this._cache.lastModified = new Date().toISOString();
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }

  /** Get all 3 moon sponsor slots */
  getAll() {
    return this._cache ? this._cache.moonSponsors : [null, null, null];
  }

  /** Get a moon sponsor by index (0, 1, 2) */
  getByIndex(moonIndex) {
    if (moonIndex < 0 || moonIndex > 2) return null;
    return this.getAll()[moonIndex] || null;
  }

  /** Generate a unique moon sponsor ID */
  generateId() {
    return "msponsor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Assign a sponsor to a moon slot.
   * @param {number} moonIndex - 0, 1, or 2
   * @param {Object} sponsorData - Sponsor data (name, tagline, etc.)
   * @returns {{ sponsor?: Object, errors?: string[] }}
   */
  assign(moonIndex, sponsorData) {
    if (moonIndex < 0 || moonIndex > 2) {
      return { errors: ["moonIndex must be 0, 1, or 2"] };
    }

    const { valid, errors } = this.validate(sponsorData);
    if (!valid) return { errors };

    const existing = this._cache.moonSponsors[moonIndex];
    const now = new Date().toISOString();

    const sponsor = {
      ...sponsorData,
      id: existing ? existing.id : this.generateId(),
      moonIndex,
      active: sponsorData.active !== undefined ? sponsorData.active : true,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this._cache.moonSponsors[moonIndex] = sponsor;
    this._saveToDisk();
    return { sponsor };
  }

  /**
   * Clear a moon's sponsor.
   * @param {number} moonIndex - 0, 1, or 2
   * @returns {boolean}
   */
  clear(moonIndex) {
    if (moonIndex < 0 || moonIndex > 2) return false;
    if (this._cache.moonSponsors[moonIndex] === null) return false;
    this._cache.moonSponsors[moonIndex] = null;
    this._saveToDisk();
    return true;
  }

  /**
   * Validate a moon sponsor object.
   */
  validate(sponsor) {
    const errors = [];

    if (!sponsor.name || sponsor.name.trim().length === 0) {
      errors.push("Name is required");
    }

    if (sponsor.websiteUrl && sponsor.websiteUrl.trim().length > 0) {
      try {
        new URL(sponsor.websiteUrl);
      } catch (e) {
        errors.push("Invalid website URL");
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

module.exports = MoonSponsorStore;
