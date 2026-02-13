/**
 * AdLands - Server-Side Billboard Sponsor Store
 * Reads/writes data/billboardSponsors.json with in-memory cache.
 * Manages 21 fixed billboard slots (index 0-20) across 3 orbit tiers:
 *   LOW (0-11), MID (12-17), HIGH (18-20)
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const SLOT_COUNT = 21;

class BillboardSponsorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._cache = null;
  }

  /**
   * Load billboard sponsors from disk into memory cache.
   * Auto-creates directory and file if missing.
   */
  load() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this._cache = { version: 1, billboardSponsors: new Array(SLOT_COUNT).fill(null), lastModified: "" };
      this._saveToDisk();
      console.log(`[BillboardSponsorStore] Created empty ${this.filePath}`);
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this._cache = JSON.parse(raw);
      // Ensure correct slot count
      while (this._cache.billboardSponsors.length < SLOT_COUNT) this._cache.billboardSponsors.push(null);
      const active = this._cache.billboardSponsors.filter(Boolean).length;
      console.log(`[BillboardSponsorStore] Loaded ${active} billboard sponsors from disk`);
    } catch (e) {
      console.error("[BillboardSponsorStore] Failed to read billboard sponsors file:", e.message);
      this._cache = { version: 1, billboardSponsors: new Array(SLOT_COUNT).fill(null), lastModified: "" };
    }
  }

  /**
   * Atomic write: write to .tmp then rename to prevent corruption.
   */
  async _saveToDisk() {
    this._cache.lastModified = new Date().toISOString();
    const tmp = this.filePath + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(this._cache, null, 2), "utf8");
    await fsp.rename(tmp, this.filePath);
  }

  /** Get all 21 billboard sponsor slots */
  getAll() {
    return this._cache ? this._cache.billboardSponsors : new Array(SLOT_COUNT).fill(null);
  }

  /** Get a billboard sponsor by index (0-20) */
  getByIndex(billboardIndex) {
    if (billboardIndex < 0 || billboardIndex >= SLOT_COUNT) return null;
    return this.getAll()[billboardIndex] || null;
  }

  /** Generate a unique billboard sponsor ID */
  generateId() {
    return "bsponsor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Assign a sponsor to a billboard slot.
   * @param {number} billboardIndex - 0 through 20
   * @param {Object} sponsorData - Sponsor data (name, tagline, etc.)
   * @returns {{ sponsor?: Object, errors?: string[] }}
   */
  async assign(billboardIndex, sponsorData) {
    if (billboardIndex < 0 || billboardIndex >= SLOT_COUNT) {
      return { errors: [`billboardIndex must be 0 through ${SLOT_COUNT - 1}`] };
    }

    const { valid, errors } = this.validate(sponsorData);
    if (!valid) return { errors };

    const existing = this._cache.billboardSponsors[billboardIndex];
    const now = new Date().toISOString();

    const sponsor = {
      ...sponsorData,
      id: existing ? existing.id : this.generateId(),
      billboardIndex,
      active: sponsorData.active !== undefined ? sponsorData.active : true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this._cache.billboardSponsors[billboardIndex] = sponsor;
    await this._saveToDisk();
    return { sponsor };
  }

  /**
   * Clear a billboard's sponsor.
   * @param {number} billboardIndex - 0 through 20
   * @returns {boolean}
   */
  async clear(billboardIndex) {
    if (billboardIndex < 0 || billboardIndex >= SLOT_COUNT) return false;
    if (this._cache.billboardSponsors[billboardIndex] === null) return false;
    this._cache.billboardSponsors[billboardIndex] = null;
    await this._saveToDisk();
    return true;
  }

  /**
   * Validate a billboard sponsor object.
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

module.exports = BillboardSponsorStore;
