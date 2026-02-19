/**
 * AdLands - Server-Side Sponsor Store
 * Reads/writes data/sponsors.json with in-memory cache.
 * Syncs to Firestore for persistence across container restarts.
 * Mirrors the client SponsorStorage API for consistency.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

/** Image fields always stripped before writing to Firestore (metadata-only). */
const IMAGE_FIELDS = ["patternImage", "logoImage", "pendingImage"];

/** Timeout for Firestore operations during startup (ms) */
const FIRESTORE_TIMEOUT = 15000;

/** Race a promise against a timeout. Resolves to null on timeout. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

/** Strip undefined values from an object (Firestore rejects undefined). */
function stripUndefined(obj) {
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v;
  }
  return clean;
}

class SponsorStore {
  /**
   * @param {string} filePath - Path to sponsors.json
   * @param {{ getFirestore?: Function }} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this._cache = null;
    this._getFirestore = opts.getFirestore || null;
    this._firestoreCollection = "sponsor_store";
  }

  /**
   * Load sponsors from disk, then merge/override with Firestore data.
   * On first run (Firestore empty), seeds Firestore from JSON data.
   */
  async load() {
    // 1. Read JSON file (local fallback)
    this._loadFromDisk();

    // 2. Merge with Firestore (source of truth)
    await this._mergeFromFirestore();

    // 3. Clean up duplicate player territory entries (same _territoryId)
    this._deduplicatePlayerTerritories();

    // 4. Migrate isPlayerTerritory → ownerType
    this._migrateOwnerType();
  }

  /**
   * Read sponsors.json into memory cache.
   */
  _loadFromDisk() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      // Bootstrap from seed file on fresh deploy
      const seedPath = this.filePath.replace('.json', '.seed.json');
      if (fs.existsSync(seedPath)) {
        const raw = fs.readFileSync(seedPath, 'utf8');
        this._cache = JSON.parse(raw);
        this._saveToDisk();
        console.log(`[SponsorStore] Bootstrapped ${this._cache.sponsors.length} sponsors from seed file`);
      } else {
        this._cache = { version: 1, sponsors: [], lastModified: "" };
        this._saveToDisk();
        console.log(`[SponsorStore] Created empty ${this.filePath}`);
      }
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
   * Load from Firestore and merge with in-memory cache.
   * Firestore data takes precedence over JSON for matching IDs.
   * If Firestore is empty (first run), seed it from JSON data.
   */
  async _mergeFromFirestore() {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const snap = await withTimeout(
        db.collection(this._firestoreCollection).get(),
        FIRESTORE_TIMEOUT,
      );

      if (!snap) {
        console.warn("[SponsorStore] Firestore read timed out, using disk data");
        // Seed in background so next restart has data
        this._seedFirestore();
        return;
      }

      if (snap.empty) {
        // First run: seed Firestore from JSON data (background, don't block startup)
        if (this._cache.sponsors.length > 0) {
          console.log(`[SponsorStore] Firestore empty — seeding ${this._cache.sponsors.length} sponsors in background`);
          this._seedFirestore();
        }
        return;
      }

      // Build map of Firestore sponsors by ID (skip internal metadata docs)
      const firestoreSponsors = new Map();
      for (const doc of snap.docs) {
        if (doc.id.startsWith("__")) continue;
        firestoreSponsors.set(doc.id, doc.data());
      }

      // Build lookup of local sponsors for image preservation
      const localById = new Map();
      for (const s of this._cache.sponsors) {
        if (s.id) localById.set(s.id, s);
      }

      // Load deleted IDs from Firestore (survives container rebuilds / fresh deploys)
      await this._loadDeletedIdsFromFirestore();

      // Merge: Firestore wins for matching IDs, new Firestore entries are added
      const merged = [];
      const seen = new Set();
      const deletedSet = new Set(this._cache.deletedIds || []);

      // First pass: all Firestore sponsors (source of truth for metadata)
      for (const [id, fsData] of firestoreSponsors) {
        // Skip sponsors that were intentionally deleted
        if (deletedSet.has(id)) {
          this._deleteFromFirestore(id); // clean up stale Firestore entry
          continue;
        }
        // Preserve local image fields that Firestore doesn't store
        const local = localById.get(id);
        if (local) {
          for (const f of IMAGE_FIELDS) {
            if (local[f] && !fsData[f]) {
              fsData[f] = local[f];
            }
          }
        }
        merged.push(fsData);
        seen.add(id);
      }

      // Second pass: JSON-only sponsors (not in Firestore yet — sync them up)
      let synced = 0;
      for (const s of this._cache.sponsors) {
        if (!seen.has(s.id)) {
          if (deletedSet.has(s.id)) continue; // skip deleted sponsors (e.g. Dropbox-reverted JSON)
          merged.push(s);
          this._syncToFirestore(s); // fire-and-forget
          synced++;
        }
      }

      this._cache.sponsors = merged;
      await this._saveToDisk();

      const fsCount = firestoreSponsors.size;
      console.log(`[SponsorStore] Merged ${fsCount} from Firestore` + (synced > 0 ? `, synced ${synced} new to Firestore` : ""));
    } catch (err) {
      console.warn("[SponsorStore] Firestore merge failed, using disk data:", err.message);
    }
  }

  /**
   * Seed Firestore with all current in-memory sponsors (first-run migration).
   * Uses individual writes so large-image sponsors can fall back gracefully.
   */
  async _seedFirestore() {
    if (!this._getFirestore) return;

    let count = 0;
    for (const sponsor of this._cache.sponsors) {
      await this._syncToFirestore(sponsor);
      count++;
    }
    console.log(`[SponsorStore] Seeded ${count} sponsors to Firestore`);
  }

  /**
   * Sync a single sponsor to Firestore. On document-too-large error,
   * retries without image fields so metadata still persists.
   */
  async _syncToFirestore(sponsor) {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const clean = stripUndefined(sponsor);
      // Always strip image fields — Firestore is metadata-only; images live in local JSON
      for (const f of IMAGE_FIELDS) delete clean[f];
      await db.collection(this._firestoreCollection).doc(sponsor.id).set(clean);
    } catch (err) {
      console.warn(`[SponsorStore] Firestore sync failed for ${sponsor.id}:`, err.message);
    }
  }

  /**
   * Delete a sponsor document from Firestore.
   */
  async _deleteFromFirestore(id) {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      await db.collection(this._firestoreCollection).doc(id).delete();
    } catch (err) {
      console.warn(`[SponsorStore] Firestore delete failed for ${id}:`, err.message);
    }
  }

  /**
   * Persist deletedIds to Firestore so they survive container rebuilds.
   * Stored as a single document in the sponsor_store collection.
   */
  async _saveDeletedIdsToFirestore() {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      await db.collection(this._firestoreCollection).doc("__deletedIds").set({
        ids: this._cache.deletedIds || [],
      });
    } catch (err) {
      console.warn("[SponsorStore] Failed to save deletedIds to Firestore:", err.message);
    }
  }

  /**
   * Load deletedIds from Firestore and merge with local cache.
   * Called during _mergeFromFirestore to recover deletion records after fresh deploys.
   */
  async _loadDeletedIdsFromFirestore() {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const doc = await db.collection(this._firestoreCollection).doc("__deletedIds").get();
      if (doc.exists) {
        const firestoreIds = doc.data().ids || [];
        const localIds = this._cache.deletedIds || [];
        // Merge both sets (Firestore may have IDs the local cache doesn't after a fresh deploy)
        const merged = [...new Set([...localIds, ...firestoreIds])];
        this._cache.deletedIds = merged;
      }
    } catch (err) {
      console.warn("[SponsorStore] Failed to load deletedIds from Firestore:", err.message);
    }
  }

  /**
   * Remove duplicate player territory entries that share the same _territoryId.
   * Keeps the entry with pendingImage (if any) or the most recent updatedAt.
   */
  _deduplicatePlayerTerritories() {
    const byTerritory = new Map();
    for (const s of this._cache.sponsors) {
      if (s.ownerType !== "player" && !s.isPlayerTerritory) continue;
      if (!s._territoryId) continue;
      const existing = byTerritory.get(s._territoryId);
      if (!existing) {
        byTerritory.set(s._territoryId, s);
      } else {
        // Prefer the entry with pendingImage, otherwise the most recently updated
        const keepNew = (s.pendingImage && !existing.pendingImage) ||
          (!existing.pendingImage && s.updatedAt > existing.updatedAt);
        if (keepNew) byTerritory.set(s._territoryId, s);
      }
    }
    const keepIds = new Set([...byTerritory.values()].map(s => s.id));
    const before = this._cache.sponsors.length;
    this._cache.sponsors = this._cache.sponsors.filter(s => {
      if (s.ownerType !== "player" && !s.isPlayerTerritory) return true;
      if (!s._territoryId) return true;
      return keepIds.has(s.id);
    });
    const removed = before - this._cache.sponsors.length;
    if (removed > 0) {
      console.log(`[SponsorStore] Cleaned up ${removed} duplicate player territory entries`);
      this._saveToDisk();
    }
  }

  /**
   * Migrate legacy isPlayerTerritory boolean to ownerType string.
   * Sets ownerType: "player" or "admin" on entries that lack it.
   */
  _migrateOwnerType() {
    let migrated = 0;
    for (const s of this._cache.sponsors) {
      if (s.ownerType) continue;
      s.ownerType = s.isPlayerTerritory ? "player" : "admin";
      migrated++;
    }
    if (migrated > 0) {
      console.log(`[SponsorStore] Migrated ${migrated} sponsors to ownerType field`);
      this._saveToDisk();
    }
  }

  /**
   * Save cache to disk. Writes directly to avoid Dropbox sync race conditions
   * with tmp+rename pattern.
   */
  async _saveToDisk() {
    this._cache.lastModified = new Date().toISOString();
    await fsp.writeFile(this.filePath, JSON.stringify(this._cache, null, 2), "utf8");
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
   * @returns {Promise<{ sponsor?: Object, errors?: string[] }>}
   */
  async create(sponsor) {
    // Dedup: prevent duplicate player territory entries for the same _territoryId
    if (sponsor.ownerType === "player" && sponsor._territoryId) {
      const existing = this.getAll().find(s => s._territoryId === sponsor._territoryId);
      if (existing) {
        return { sponsor: existing };
      }
    }

    // Validate name only — tiles may be empty for duplicated/draft sponsors
    if (!sponsor.name || sponsor.name.trim().length === 0) {
      return { errors: ["Name is required"] };
    }

    // Skip tile conflict check for player territories — they coexist with admin sponsors
    const tiles = sponsor.cluster?.tileIndices || [];
    if (tiles.length > 0 && sponsor.ownerType !== "player" && sponsor.ownerType !== "inquiry") {
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
    await this._saveToDisk();
    this._syncToFirestore(newSponsor);
    return { sponsor: newSponsor };
  }

  /**
   * Update an existing sponsor.
   * @returns {Promise<{ sponsor?: Object, errors?: string[] }>}
   */
  async update(id, updates) {
    const index = this._cache.sponsors.findIndex((s) => s.id === id);
    if (index === -1) return { errors: ["Sponsor not found"] };

    const merged = { ...this._cache.sponsors[index], ...updates, id };
    const { valid, errors } = this.validate(merged);
    if (!valid) return { errors };

    // Skip tile conflict check for player territories
    if (merged.cluster && merged.cluster.tileIndices && merged.ownerType !== "player") {
      const tileCheck = this.areTilesUsed(merged.cluster.tileIndices, id);
      if (tileCheck.isUsed) {
        return { errors: [`Tiles conflict with sponsor "${tileCheck.sponsorName}"`] };
      }
    }

    merged.updatedAt = new Date().toISOString();
    this._cache.sponsors[index] = merged;
    await this._saveToDisk();
    this._syncToFirestore(merged);
    return { sponsor: merged };
  }

  /**
   * Delete a sponsor by ID.
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    const initialLength = this._cache.sponsors.length;
    this._cache.sponsors = this._cache.sponsors.filter((s) => s.id !== id);
    if (this._cache.sponsors.length < initialLength) {
      // Track deleted IDs to prevent resurrection from Dropbox-reverted JSON, stale Firestore, or seed files
      if (!this._cache.deletedIds) this._cache.deletedIds = [];
      if (!this._cache.deletedIds.includes(id)) this._cache.deletedIds.push(id);
      await this._saveToDisk();
      await this._deleteFromFirestore(id);
      await this._saveDeletedIdsToFirestore();
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
  async importJSON(imported, merge = true) {
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
      if (!sponsor.cluster) {
        sponsor.cluster = { tileIndices: [] };
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

    await this._saveToDisk();

    // Sync all sponsors to Firestore after import
    for (const s of this._cache.sponsors) {
      this._syncToFirestore(s);
    }

    return { success: true, imported: importedCount, errors };
  }
}

module.exports = SponsorStore;
