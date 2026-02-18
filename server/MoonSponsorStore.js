/**
 * AdLands - Server-Side Moon Sponsor Store
 * Reads/writes data/moonSponsors.json with in-memory cache.
 * Syncs to Firestore for persistence across container restarts.
 * Manages 3 fixed moon slots (index 0, 1, 2) — each can hold one sponsor.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

/** Fields to strip when a Firestore document exceeds the 1MB size limit */
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

class MoonSponsorStore {
  /**
   * @param {string} filePath - Path to moonSponsors.json
   * @param {{ getFirestore?: Function }} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this._cache = null;
    this._getFirestore = opts.getFirestore || null;
    this._firestoreCollection = "moon_sponsor_store";
  }

  /**
   * Load moon sponsors from disk, then merge with Firestore data.
   */
  async load() {
    this._loadFromDisk();
    await this._mergeFromFirestore();
  }

  /**
   * Read moonSponsors.json into memory cache.
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
        while (this._cache.moonSponsors.length < 3) this._cache.moonSponsors.push(null);
        this._saveToDisk();
        console.log(`[MoonSponsorStore] Bootstrapped from seed file`);
      } else {
        this._cache = { version: 1, moonSponsors: [null, null, null], lastModified: "" };
        this._saveToDisk();
        console.log(`[MoonSponsorStore] Created empty ${this.filePath}`);
      }
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
   * Merge Firestore data into in-memory cache.
   * Firestore slots take precedence. Seeds Firestore on first run.
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
        console.warn("[MoonSponsorStore] Firestore read timed out, using disk data");
        this._seedFirestore();
        return;
      }

      if (snap.empty) {
        // First run: seed Firestore from JSON data (background)
        const hasData = this._cache.moonSponsors.some(Boolean);
        if (hasData) {
          console.log("[MoonSponsorStore] Firestore empty — seeding from disk");
          this._seedFirestore();
        }
        return;
      }

      // Override slots from Firestore
      let loaded = 0;
      for (const doc of snap.docs) {
        const idx = parseInt(doc.id, 10);
        if (idx >= 0 && idx < 3) {
          const data = doc.data();
          this._cache.moonSponsors[idx] = data.empty ? null : data;
          if (!data.empty) loaded++;
        }
      }

      await this._saveToDisk();
      console.log(`[MoonSponsorStore] Merged ${loaded} moon sponsors from Firestore`);
    } catch (err) {
      console.warn("[MoonSponsorStore] Firestore merge failed, using disk data:", err.message);
    }
  }

  /**
   * Seed Firestore with current slot data.
   */
  async _seedFirestore() {
    if (!this._getFirestore) return;

    for (let i = 0; i < 3; i++) {
      await this._syncSlotToFirestore(i, this._cache.moonSponsors[i]);
    }
    console.log("[MoonSponsorStore] Seeded 3 slots to Firestore");
  }

  /**
   * Sync a single slot to Firestore.
   */
  async _syncSlotToFirestore(moonIndex, data) {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const payload = data ? stripUndefined(data) : { empty: true };
      await db.collection(this._firestoreCollection).doc(String(moonIndex)).set(payload);
    } catch (err) {
      // Retry without images if too large
      if (data && (err.code === 3 || (err.message && err.message.includes("exceeds the maximum")))) {
        try {
          const stripped = stripUndefined(data);
          for (const f of IMAGE_FIELDS) delete stripped[f];
          const db = this._getFirestore();
          await db.collection(this._firestoreCollection).doc(String(moonIndex)).set(stripped);
          console.warn(`[MoonSponsorStore] Slot ${moonIndex} too large — saved without images`);
        } catch (retryErr) {
          console.warn(`[MoonSponsorStore] Firestore sync failed for slot ${moonIndex}:`, retryErr.message);
        }
      } else {
        console.warn(`[MoonSponsorStore] Firestore sync failed for slot ${moonIndex}:`, err.message);
      }
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
  async assign(moonIndex, sponsorData) {
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
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this._cache.moonSponsors[moonIndex] = sponsor;
    await this._saveToDisk();
    this._syncSlotToFirestore(moonIndex, sponsor);
    return { sponsor };
  }

  /**
   * Clear a moon's sponsor.
   * @param {number} moonIndex - 0, 1, or 2
   * @returns {boolean}
   */
  async clear(moonIndex) {
    if (moonIndex < 0 || moonIndex > 2) return false;
    if (this._cache.moonSponsors[moonIndex] === null) return false;
    this._cache.moonSponsors[moonIndex] = null;
    await this._saveToDisk();
    this._syncSlotToFirestore(moonIndex, null);
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
