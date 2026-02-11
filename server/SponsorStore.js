/**
 * AdLands - Server-Side Sponsor Store
 * Reads/writes data/sponsors.json with in-memory cache.
 * Mirrors the client SponsorStorage API for consistency.
 */

const fs = require("fs");
const path = require("path");

class SponsorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._cache = null;
  }

  /**
   * Load sponsors from disk into memory cache.
   * Auto-creates directory and file if missing.
   */
  load() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      this._cache = { version: 1, sponsors: [], lastModified: "" };
      this._saveToDisk();
      console.log(`[SponsorStore] Created empty ${this.filePath}`);
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this._cache = JSON.parse(raw);
      console.log(`[SponsorStore] Loaded ${this._cache.sponsors.length} sponsors from disk`);
    } catch (e) {
      console.error("[SponsorStore] Failed to read sponsors file:", e.message);
      this._cache = { version: 1, sponsors: [], lastModified: "" };
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

  /** Get all sponsors */
  getAll() {
    return this._cache ? this._cache.sponsors : [];
  }

  /** Get a sponsor by ID */
  getById(id) {
    return this.getAll().find((s) => s.id === id) || null;
  }

  /** Generate a unique sponsor ID */
  generateId() {
    return "sponsor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Create a new sponsor.
   * @returns {{ sponsor?: Object, errors?: string[] }}
   */
  create(sponsor) {
    // Validate name only — tiles may be empty for duplicated/draft sponsors
    if (!sponsor.name || sponsor.name.trim().length === 0) {
      return { errors: ["Name is required"] };
    }

    const tiles = sponsor.cluster?.tileIndices || [];
    if (tiles.length > 0) {
      const tileCheck = this.areTilesUsed(tiles, null);
      if (tileCheck.isUsed) {
        return { errors: [`Tiles conflict with sponsor "${tileCheck.sponsorName}"`] };
      }
    }

    const newSponsor = {
      ...sponsor,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      active: sponsor.active !== undefined ? sponsor.active : true,
    };
    this._cache.sponsors.push(newSponsor);
    this._saveToDisk();
    return { sponsor: newSponsor };
  }

  /**
   * Update an existing sponsor.
   * @returns {{ sponsor?: Object, errors?: string[] }}
   */
  update(id, updates) {
    const index = this._cache.sponsors.findIndex((s) => s.id === id);
    if (index === -1) return { errors: ["Sponsor not found"] };

    const merged = { ...this._cache.sponsors[index], ...updates, id };
    const { valid, errors } = this.validate(merged);
    if (!valid) return { errors };

    if (merged.cluster && merged.cluster.tileIndices) {
      const tileCheck = this.areTilesUsed(merged.cluster.tileIndices, id);
      if (tileCheck.isUsed) {
        return { errors: [`Tiles conflict with sponsor "${tileCheck.sponsorName}"`] };
      }
    }

    merged.updatedAt = new Date().toISOString();
    this._cache.sponsors[index] = merged;
    this._saveToDisk();
    return { sponsor: merged };
  }

  /**
   * Delete a sponsor by ID.
   * @returns {boolean}
   */
  delete(id) {
    const initialLength = this._cache.sponsors.length;
    this._cache.sponsors = this._cache.sponsors.filter((s) => s.id !== id);
    if (this._cache.sponsors.length < initialLength) {
      this._saveToDisk();
      return true;
    }
    return false;
  }

  /**
   * Check if any sponsor is using the given tile indices.
   * @param {number[]} tileIndices
   * @param {string|null} excludeId - Sponsor ID to exclude (for updates)
   * @returns {{ isUsed: boolean, sponsorName: string|null }}
   */
  areTilesUsed(tileIndices, excludeId) {
    const tileSet = new Set(tileIndices);
    for (const sponsor of this.getAll()) {
      if (sponsor.id === excludeId) continue;
      if (!sponsor.cluster || !sponsor.cluster.tileIndices) continue;
      for (const tileIndex of sponsor.cluster.tileIndices) {
        if (tileSet.has(tileIndex)) {
          return { isUsed: true, sponsorName: sponsor.name };
        }
      }
    }
    return { isUsed: false, sponsorName: null };
  }

  /**
   * Validate a sponsor object.
   * Mirrors client-side sponsorStorage.js validate().
   */
  validate(sponsor) {
    const errors = [];

    if (!sponsor.name || sponsor.name.trim().length === 0) {
      errors.push("Name is required");
    }

    if (
      !sponsor.cluster ||
      !sponsor.cluster.tileIndices ||
      sponsor.cluster.tileIndices.length === 0
    ) {
      errors.push("At least one tile must be selected");
    }

    if (sponsor.websiteUrl && sponsor.websiteUrl.trim().length > 0) {
      try {
        new URL(sponsor.websiteUrl);
      } catch (e) {
        errors.push("Invalid website URL");
      }
    }

    if (sponsor.rewards && Array.isArray(sponsor.rewards)) {
      const accomplishments = new Set();
      for (let i = 0; i < sponsor.rewards.length; i++) {
        const reward = sponsor.rewards[i];
        if (!reward.accomplishment) {
          errors.push(`Reward ${i + 1}: accomplishment type is required`);
        }
        if (!reward.rewardType) {
          errors.push(`Reward ${i + 1}: reward type is required`);
        }
        if (accomplishments.has(reward.accomplishment)) {
          errors.push(`Reward ${i + 1}: duplicate accomplishment "${reward.accomplishment}"`);
        }
        accomplishments.add(reward.accomplishment);

        if (reward.rewardType === "crypto" && (reward.rewardValue === undefined || reward.rewardValue < 1)) {
          errors.push(`Reward ${i + 1}: Crypto value must be at least 1`);
        }
        if (reward.rewardType === "coupon") {
          if (!reward.rewardDetails || !reward.rewardDetails.code) {
            errors.push(`Reward ${i + 1}: coupon code is required`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** Export all sponsors as JSON string */
  exportJSON() {
    return JSON.stringify(this._cache, null, 2);
  }

  /**
   * Import sponsors from parsed JSON data.
   * @param {{ sponsors: Object[] }} imported
   * @param {boolean} merge - If true, merge with existing; if false, replace all.
   * @returns {{ success: boolean, imported: number, errors: string[] }}
   */
  importJSON(imported, merge = true) {
    const errors = [];
    let importedCount = 0;

    if (!imported.sponsors || !Array.isArray(imported.sponsors)) {
      return { success: false, imported: 0, errors: ["Invalid format: missing sponsors array"] };
    }

    if (!merge) {
      this._cache.sponsors = [];
    }
    const existingIds = new Set(this._cache.sponsors.map((s) => s.id));

    for (const sponsor of imported.sponsors) {
      if (!sponsor.name) {
        errors.push("Sponsor missing name, skipped");
        continue;
      }
      if (!sponsor.cluster || !sponsor.cluster.tileIndices) {
        errors.push(`Sponsor "${sponsor.name}" missing cluster data, skipped`);
        continue;
      }

      if (merge && existingIds.has(sponsor.id)) {
        const index = this._cache.sponsors.findIndex((s) => s.id === sponsor.id);
        this._cache.sponsors[index] = {
          ...this._cache.sponsors[index],
          ...sponsor,
          updatedAt: new Date().toISOString(),
        };
      } else {
        this._cache.sponsors.push({
          ...sponsor,
          id: merge ? this.generateId() : sponsor.id,
          createdAt: sponsor.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          active: sponsor.active !== undefined ? sponsor.active : true,
        });
      }
      importedCount++;
    }

    this._saveToDisk();
    return { success: true, imported: importedCount, errors };
  }
}

module.exports = SponsorStore;
