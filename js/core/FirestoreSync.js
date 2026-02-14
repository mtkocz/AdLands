/**
 * AdLands - FirestoreSync
 * Debounced Firestore read/write helper for client-side systems.
 * Batches writes, provides offline queue via Firestore's built-in persistence.
 */

class FirestoreSync {
  constructor() {
    /** @type {Map<string, { timer: number, data: Object }>} Pending debounced writes */
    this._pendingWrites = new Map();

    /** @type {boolean} Whether user is authenticated */
    this._active = false;

    /** @type {string|null} Firebase UID */
    this._uid = null;

    /** @type {number|null} Active profile index */
    this._profileIndex = null;
  }

  /**
   * Activate sync for an authenticated user.
   * @param {string} uid - Firebase UID
   * @param {number} profileIndex - Active profile index (0-2)
   */
  activate(uid, profileIndex) {
    this._uid = uid;
    this._profileIndex = profileIndex;
    this._active = true;
  }

  /**
   * Deactivate sync (user signed out).
   */
  deactivate() {
    // Flush all pending writes before deactivating
    this.flushAll();
    this._active = false;
    this._uid = null;
    this._profileIndex = null;
  }

  /**
   * Update the active profile index (after profile switch).
   * @param {number} profileIndex
   */
  setProfileIndex(profileIndex) {
    this._profileIndex = profileIndex;
  }

  /** @returns {boolean} Whether sync is active */
  get isActive() {
    return this._active && this._uid !== null;
  }

  // ========================
  // PROFILE DOCUMENT
  // ========================

  /**
   * Get a reference to the current profile document.
   * @returns {firebase.firestore.DocumentReference|null}
   */
  getProfileRef() {
    if (!this.isActive || this._profileIndex === null) return null;
    return firebaseDb
      .collection("accounts").doc(this._uid)
      .collection("profiles").doc(String(this._profileIndex));
  }

  /**
   * Get a reference to the account document.
   * @returns {firebase.firestore.DocumentReference|null}
   */
  getAccountRef() {
    if (!this.isActive) return null;
    return firebaseDb.collection("accounts").doc(this._uid);
  }

  /**
   * Read the current profile document.
   * @returns {Promise<Object|null>}
   */
  async readProfile() {
    const ref = this.getProfileRef();
    if (!ref) return null;
    try {
      const doc = await ref.get();
      return doc.exists ? doc.data() : null;
    } catch (err) {
      console.warn("[FirestoreSync] Failed to read profile:", err.message);
      return null;
    }
  }

  /**
   * Read the account document.
   * @returns {Promise<Object|null>}
   */
  async readAccount() {
    const ref = this.getAccountRef();
    if (!ref) return null;
    try {
      const doc = await ref.get();
      return doc.exists ? doc.data() : null;
    } catch (err) {
      console.warn("[FirestoreSync] Failed to read account:", err.message);
      return null;
    }
  }

  // ========================
  // DEBOUNCED WRITES
  // ========================

  /**
   * Write fields to the profile document with debouncing.
   * Multiple calls within the debounce window are merged.
   * @param {Object} fields - Fields to update
   * @param {number} [debounceMs=30000] - Debounce interval (default 30s)
   */
  writeProfile(fields, debounceMs = 30000) {
    this._debouncedWrite("profile", fields, debounceMs);
  }

  /**
   * Write fields to the account document with debouncing.
   * @param {Object} fields - Fields to update
   * @param {number} [debounceMs=30000] - Debounce interval
   */
  writeAccount(fields, debounceMs = 30000) {
    this._debouncedWrite("account", fields, debounceMs);
  }

  /**
   * Write fields to the profile document immediately (no debounce).
   * Use for rare, high-value events like badge unlocks.
   * @param {Object} fields - Fields to update
   */
  async writeProfileNow(fields) {
    const ref = this.getProfileRef();
    if (!ref) return;
    try {
      await ref.update(fields);
    } catch (err) {
      console.warn("[FirestoreSync] Immediate profile write failed:", err.message);
    }
  }

  /**
   * Flush all pending debounced writes immediately.
   * Called on sign-out and page unload.
   */
  flushAll() {
    for (const [key, pending] of this._pendingWrites) {
      clearTimeout(pending.timer);
      this._executeWrite(key, pending.data);
    }
    this._pendingWrites.clear();
  }

  // ========================
  // INTERNALS
  // ========================

  _debouncedWrite(key, fields, debounceMs) {
    if (!this.isActive) return;

    const existing = this._pendingWrites.get(key);
    if (existing) {
      // Merge new fields into pending write
      Object.assign(existing.data, fields);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => {
        this._executePendingWrite(key);
      }, debounceMs);
    } else {
      const timer = setTimeout(() => {
        this._executePendingWrite(key);
      }, debounceMs);
      this._pendingWrites.set(key, { timer, data: { ...fields } });
    }
  }

  _executePendingWrite(key) {
    const pending = this._pendingWrites.get(key);
    if (!pending) return;
    this._pendingWrites.delete(key);
    this._executeWrite(key, pending.data);
  }

  _executeWrite(key, data) {
    if (!this.isActive || !data || Object.keys(data).length === 0) return;

    let ref;
    if (key === "profile") {
      ref = this.getProfileRef();
    } else if (key === "account") {
      ref = this.getAccountRef();
    }

    if (!ref) return;

    ref.update(data).catch((err) => {
      console.warn(`[FirestoreSync] Write to ${key} failed:`, err.message);
    });
  }
}
