/**
 * AdLands - Fixed-Slot Sponsor Store (Base Class)
 * Shared logic for sponsor stores with a fixed number of indexed slots
 * (e.g., moon sponsors = 3 slots, billboard sponsors = 18 slots).
 *
 * Reads/writes a JSON file with in-memory cache.
 * Syncs to Firestore for persistence across container restarts.
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

class FixedSlotSponsorStore {
  /**
   * @param {string} filePath - Path to JSON file
   * @param {Object} config
   * @param {number} config.slotCount - Number of fixed slots
   * @param {string} config.arrayKey - Key in JSON cache (e.g. "moonSponsors")
   * @param {string} config.firestoreCollection - Firestore collection name
   * @param {string} config.idPrefix - Prefix for generated IDs (e.g. "msponsor_")
   * @param {string} config.logTag - Log prefix (e.g. "[MoonSponsorStore]")
   * @param {{ getFirestore?: Function }} [opts]
   */
  constructor(filePath, config, opts = {}) {
    this.filePath = filePath;
    this._cache = null;
    this._getFirestore = opts.getFirestore || null;
    this._slotCount = config.slotCount;
    this._arrayKey = config.arrayKey;
    this._firestoreCollection = config.firestoreCollection;
    this._idPrefix = config.idPrefix;
    this._logTag = config.logTag;
  }

  async load() {
    this._loadFromDisk();
    await this._mergeFromFirestore();
  }

  _loadFromDisk() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      const seedPath = this.filePath.replace('.json', '.seed.json');
      if (fs.existsSync(seedPath)) {
        const raw = fs.readFileSync(seedPath, 'utf8');
        this._cache = JSON.parse(raw);
        while (this._cache[this._arrayKey].length < this._slotCount) this._cache[this._arrayKey].push(null);
        this._saveToDisk();
        console.log(`${this._logTag} Bootstrapped from seed file`);
      } else {
        this._cache = { version: 1, [this._arrayKey]: new Array(this._slotCount).fill(null), lastModified: "" };
        this._saveToDisk();
        console.log(`${this._logTag} Created empty ${this.filePath}`);
      }
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this._cache = JSON.parse(raw);
      while (this._cache[this._arrayKey].length < this._slotCount) this._cache[this._arrayKey].push(null);
      const active = this._cache[this._arrayKey].filter(Boolean).length;
      console.log(`${this._logTag} Loaded ${active} sponsors from disk`);
    } catch (e) {
      console.error(`${this._logTag} Failed to read file:`, e.message);
      this._cache = { version: 1, [this._arrayKey]: new Array(this._slotCount).fill(null), lastModified: "" };
    }
  }

  async _mergeFromFirestore() {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const snap = await withTimeout(
        db.collection(this._firestoreCollection).get(),
        FIRESTORE_TIMEOUT,
      );

      if (!snap) {
        console.warn(`${this._logTag} Firestore read timed out, using disk data`);
        this._seedFirestore();
        return;
      }

      if (snap.empty) {
        const hasData = this._cache[this._arrayKey].some(Boolean);
        if (hasData) {
          console.log(`${this._logTag} Firestore empty — seeding from disk`);
          this._seedFirestore();
        }
        return;
      }

      let loaded = 0;
      for (const doc of snap.docs) {
        const idx = parseInt(doc.id, 10);
        if (idx >= 0 && idx < this._slotCount) {
          const data = doc.data();
          if (data.empty) {
            this._cache[this._arrayKey][idx] = null;
          } else {
            const local = this._cache[this._arrayKey][idx];
            if (local) {
              for (const f of IMAGE_FIELDS) {
                if (local[f] && !data[f]) data[f] = local[f];
              }
            }
            this._cache[this._arrayKey][idx] = data;
            loaded++;
          }
        }
      }

      await this._saveToDisk();
      console.log(`${this._logTag} Merged ${loaded} sponsors from Firestore`);
    } catch (err) {
      console.warn(`${this._logTag} Firestore merge failed, using disk data:`, err.message);
    }
  }

  async _seedFirestore() {
    if (!this._getFirestore) return;

    for (let i = 0; i < this._slotCount; i++) {
      await this._syncSlotToFirestore(i, this._cache[this._arrayKey][i]);
    }
    console.log(`${this._logTag} Seeded ${this._slotCount} slots to Firestore`);
  }

  async _syncSlotToFirestore(index, data) {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      let payload;
      if (data) {
        payload = stripUndefined(data);
        for (const f of IMAGE_FIELDS) delete payload[f];
      } else {
        payload = { empty: true };
      }
      await db.collection(this._firestoreCollection).doc(String(index)).set(payload);
    } catch (err) {
      console.warn(`${this._logTag} Firestore sync failed for slot ${index}:`, err.message);
    }
  }

  async _saveToDisk() {
    this._cache.lastModified = new Date().toISOString();
    await fsp.writeFile(this.filePath, JSON.stringify(this._cache, null, 2), "utf8");
  }

  getAll() {
    return this._cache ? this._cache[this._arrayKey] : new Array(this._slotCount).fill(null);
  }

  getByIndex(index) {
    if (index < 0 || index >= this._slotCount) return null;
    return this.getAll()[index] || null;
  }

  generateId() {
    return this._idPrefix + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
  }

  async assign(index, sponsorData) {
    if (index < 0 || index >= this._slotCount) {
      return { errors: [`Index must be 0 through ${this._slotCount - 1}`] };
    }

    const { valid, errors } = this.validate(sponsorData);
    if (!valid) return { errors };

    const existing = this._cache[this._arrayKey][index];
    const now = new Date().toISOString();

    const sponsor = {
      ...sponsorData,
      id: existing ? existing.id : this.generateId(),
      active: sponsorData.active !== undefined ? sponsorData.active : true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this._cache[this._arrayKey][index] = sponsor;
    await this._saveToDisk();
    this._syncSlotToFirestore(index, sponsor);
    return { sponsor };
  }

  async clear(index) {
    if (index < 0 || index >= this._slotCount) return false;
    if (this._cache[this._arrayKey][index] === null) return false;
    this._cache[this._arrayKey][index] = null;
    await this._saveToDisk();
    await this._syncSlotToFirestore(index, null);
    return true;
  }

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

module.exports = FixedSlotSponsorStore;
