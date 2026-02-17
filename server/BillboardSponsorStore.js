/**
 * AdLands - Server-Side Billboard Sponsor Store
 * Reads/writes data/billboardSponsors.json with in-memory cache.
 * Syncs to Firestore for persistence across container restarts.
 * Manages 18 fixed billboard slots (index 0-17) across 2 orbit tiers:
 *   LOW (0-11), HIGH (12-17)
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

const SLOT_COUNT = 18;

/** Fields to strip when a Firestore document exceeds the 1MB size limit */
const IMAGE_FIELDS = ["patternImage", "logoImage", "pendingImage"];

class BillboardSponsorStore {
  /**
   * @param {string} filePath - Path to billboardSponsors.json
   * @param {{ getFirestore?: Function }} [opts]
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this._cache = null;
    this._getFirestore = opts.getFirestore || null;
    this._firestoreCollection = "billboard_sponsor_store";
  }

  /**
   * Load billboard sponsors from disk, then merge with Firestore data.
   */
  async load() {
    this._loadFromDisk();
    await this._mergeFromFirestore();
  }

  /**
   * Read billboardSponsors.json into memory cache.
   */
  _loadFromDisk() {
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
   * Merge Firestore data into in-memory cache.
   * Firestore slots take precedence. Seeds Firestore on first run.
   */
  async _mergeFromFirestore() {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const snap = await db.collection(this._firestoreCollection).get();

      if (snap.empty) {
        // First run: seed Firestore from JSON data
        const hasData = this._cache.billboardSponsors.some(Boolean);
        if (hasData) {
          console.log("[BillboardSponsorStore] Firestore empty — seeding from disk");
          await this._seedFirestore();
        }
        return;
      }

      // Override slots from Firestore
      let loaded = 0;
      for (const doc of snap.docs) {
        const idx = parseInt(doc.id, 10);
        if (idx >= 0 && idx < SLOT_COUNT) {
          const data = doc.data();
          this._cache.billboardSponsors[idx] = data.empty ? null : data;
          if (!data.empty) loaded++;
        }
      }

      await this._saveToDisk();
      console.log(`[BillboardSponsorStore] Merged ${loaded} billboard sponsors from Firestore`);
    } catch (err) {
      console.warn("[BillboardSponsorStore] Firestore merge failed, using disk data:", err.message);
    }
  }

  /**
   * Seed Firestore with current slot data.
   */
  async _seedFirestore() {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      const batch = db.batch();
      for (let i = 0; i < SLOT_COUNT; i++) {
        const ref = db.collection(this._firestoreCollection).doc(String(i));
        const data = this._cache.billboardSponsors[i];
        batch.set(ref, data || { empty: true });
      }
      await batch.commit();
      console.log(`[BillboardSponsorStore] Seeded ${SLOT_COUNT} slots to Firestore`);
    } catch (err) {
      console.warn("[BillboardSponsorStore] Firestore seed failed:", err.message);
    }
  }

  /**
   * Sync a single slot to Firestore.
   */
  async _syncSlotToFirestore(billboardIndex, data) {
    if (!this._getFirestore) return;

    try {
      const db = this._getFirestore();
      await db.collection(this._firestoreCollection).doc(String(billboardIndex)).set(data || { empty: true });
    } catch (err) {
      // Retry without images if too large
      if (data && !data.empty && (err.code === 3 || (err.message && err.message.includes("exceeds the maximum")))) {
        try {
          const stripped = { ...data };
          for (const f of IMAGE_FIELDS) delete stripped[f];
          const db = this._getFirestore();
          await db.collection(this._firestoreCollection).doc(String(billboardIndex)).set(stripped);
          console.warn(`[BillboardSponsorStore] Slot ${billboardIndex} too large — saved without images`);
        } catch (retryErr) {
          console.warn(`[BillboardSponsorStore] Firestore sync failed for slot ${billboardIndex}:`, retryErr.message);
        }
      } else {
        console.warn(`[BillboardSponsorStore] Firestore sync failed for slot ${billboardIndex}:`, err.message);
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

  /** Get all 18 billboard sponsor slots */
  getAll() {
    return this._cache ? this._cache.billboardSponsors : new Array(SLOT_COUNT).fill(null);
  }

  /** Get a billboard sponsor by index (0-17) */
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
   * @param {number} billboardIndex - 0 through 17
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
    this._syncSlotToFirestore(billboardIndex, sponsor);
    return { sponsor };
  }

  /**
   * Clear a billboard's sponsor.
   * @param {number} billboardIndex - 0 through 17
   * @returns {boolean}
   */
  async clear(billboardIndex) {
    if (billboardIndex < 0 || billboardIndex >= SLOT_COUNT) return false;
    if (this._cache.billboardSponsors[billboardIndex] === null) return false;
    this._cache.billboardSponsors[billboardIndex] = null;
    await this._saveToDisk();
    this._syncSlotToFirestore(billboardIndex, null);
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
