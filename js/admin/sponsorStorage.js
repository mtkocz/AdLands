/**
 * AdLands - Sponsor Storage Module
 * IndexedDB-backed CRUD operations for sponsor configurations
 * with in-memory cache for synchronous reads.
 */

const SponsorStorage = {
  STORAGE_KEY: "adlands_sponsors",
  DB_NAME: "adlands_db",
  DB_VERSION: 1,
  STORE_NAME: "data",
  RECORD_KEY: "sponsors",
  VERSION: 1,

  // Internal state
  _db: null,
  _cache: null,
  _ready: null,
  _useLocalStorage: false,
  _useAPI: false,
  _apiBase: "/api/sponsors",

  /**
   * Initialize storage — opens IndexedDB, migrates localStorage if needed,
   * populates in-memory cache. Idempotent.
   * @returns {Promise<void>}
   */
  init() {
    if (this._ready) return this._ready;
    this._ready = this._doInit();
    return this._ready;
  },

  async _doInit() {
    // Try REST API first (server may be running)
    try {
      const res = await fetch(this._apiBase);
      if (res.ok) {
        const data = await res.json();
        this._cache = data;
        this._useAPI = true;
        console.log("[SponsorStorage] Connected to server API");
        return;
      }
    } catch (e) {
      // Server not available — fall through to IndexedDB
    }

    try {
      this._db = await this._openDB();

      // Try reading from IndexedDB first
      let data = await this._readFromIDB();

      // Migrate from localStorage if IndexedDB is empty
      if (!data) {
        try {
          const lsRaw = localStorage.getItem(this.STORAGE_KEY);
          if (lsRaw) {
            data = JSON.parse(lsRaw);
            await this._writeToIDB(data);
            localStorage.removeItem(this.STORAGE_KEY);
          }
        } catch (e) {
          console.warn("[SponsorStorage] localStorage migration failed:", e);
        }
      }

      this._cache = data || {
        version: this.VERSION,
        sponsors: [],
        lastModified: new Date().toISOString(),
      };
    } catch (e) {
      console.warn(
        "[SponsorStorage] IndexedDB unavailable, falling back to localStorage:",
        e,
      );
      this._useLocalStorage = true;
      this._cache = this._readFromLocalStorage();
    }
  },

  /**
   * Open (or create) the IndexedDB database
   * @returns {Promise<IDBDatabase>}
   */
  _openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME);
        }
      };

      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = (event) => reject(event.target.error);
    });
  },

  /**
   * Read the sponsor data record from IndexedDB
   * @returns {Promise<Object|null>}
   */
  _readFromIDB() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this.STORE_NAME, "readonly");
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.get(this.RECORD_KEY);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Write the sponsor data record to IndexedDB
   * @param {Object} data
   * @returns {Promise<void>}
   */
  _writeToIDB(data) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(this.STORE_NAME, "readwrite");
      const store = tx.objectStore(this.STORE_NAME);
      const request = store.put(data, this.RECORD_KEY);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  },

  /**
   * Read from localStorage (fallback only)
   * @returns {Object}
   */
  _readFromLocalStorage() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.error("[SponsorStorage] Error reading localStorage:", e);
    }
    return {
      version: this.VERSION,
      sponsors: [],
      lastModified: new Date().toISOString(),
    };
  },

  /**
   * Write to localStorage (fallback only)
   * @param {Object} data
   */
  _writeToLocalStorage(data) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("[SponsorStorage] Failed to save to localStorage:", e);
      if (e.name === "QuotaExceededError" || e.code === 22) {
        throw new Error(
          "Storage full — localStorage quota exceeded. Try reducing image sizes or removing unused sponsors.",
        );
      }
      throw e;
    }
  },

  /**
   * Generate a unique ID for a sponsor
   * @returns {string}
   */
  generateId() {
    return (
      "sponsor_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9)
    );
  },

  /**
   * Get all stored data (synchronous, from cache)
   * @returns {{ version: number, sponsors: Array, lastModified: string }}
   */
  _getData() {
    if (!this._cache) {
      console.warn(
        "[SponsorStorage] Accessed before init — returning empty data",
      );
      return {
        version: this.VERSION,
        sponsors: [],
        lastModified: new Date().toISOString(),
      };
    }
    return this._cache;
  },

  /**
   * Save all data (updates cache and persists)
   * @param {Object} data
   * @returns {Promise<void>}
   */
  async _setData(data) {
    data.lastModified = new Date().toISOString();
    this._cache = data;

    if (this._useLocalStorage) {
      this._writeToLocalStorage(data);
    } else {
      await this._writeToIDB(data);
    }
  },

  /**
   * Get all sponsors
   * @returns {Array}
   */
  getAll() {
    return this._getData().sponsors;
  },

  /**
   * Get a sponsor by ID
   * @param {string} id
   * @returns {Object|null}
   */
  getById(id) {
    const sponsors = this.getAll();
    return sponsors.find((s) => s.id === id) || null;
  },

  /**
   * Fetch full sponsor data (including base64 images) from the server.
   * Updates the in-memory cache entry so subsequent getById calls return full data.
   * No-op when not connected to the API or when the sponsor already has patternImage.
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async fetchFull(id) {
    if (!this._useAPI) return this.getById(id);

    // Already have full data cached
    const cached = this.getById(id);
    if (cached && cached.patternImage !== undefined) return cached;

    try {
      const res = await fetch(`${this._apiBase}/${encodeURIComponent(id)}`);
      if (!res.ok) return cached;
      const full = await res.json();
      // Merge full data into cache
      const index = this._cache.sponsors.findIndex((s) => s.id === id);
      if (index !== -1) this._cache.sponsors[index] = full;
      return full;
    } catch (e) {
      console.warn("[SponsorStorage] fetchFull failed:", e);
      return cached;
    }
  },

  /**
   * Save a new sponsor
   * @param {Object} sponsor
   * @returns {Promise<Object>} The saved sponsor with generated ID
   */
  async create(sponsor) {
    if (this._useAPI) {
      const res = await fetch(this._apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sponsor),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.errors?.join(". ") || "Failed to create sponsor");
      }
      const created = await res.json();
      this._cache.sponsors.push(created);
      return created;
    }

    const data = this._getData();
    const newSponsor = {
      ...sponsor,
      id: this.generateId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      active: true,
    };
    data.sponsors.push(newSponsor);
    await this._setData(data);
    return newSponsor;
  },

  /**
   * Update an existing sponsor
   * @param {string} id
   * @param {Object} updates
   * @returns {Promise<Object|null>} The updated sponsor or null if not found
   */
  async update(id, updates) {
    if (this._useAPI) {
      const res = await fetch(`${this._apiBase}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.errors?.join(". ") || "Failed to update sponsor");
      }
      const updated = await res.json();
      const index = this._cache.sponsors.findIndex((s) => s.id === id);
      if (index !== -1) this._cache.sponsors[index] = updated;
      return updated;
    }

    const data = this._getData();
    const index = data.sponsors.findIndex((s) => s.id === id);
    if (index === -1) return null;

    data.sponsors[index] = {
      ...data.sponsors[index],
      ...updates,
      id: id,
      updatedAt: new Date().toISOString(),
    };
    await this._setData(data);
    return data.sponsors[index];
  },

  /**
   * Delete a sponsor
   * @param {string} id
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async delete(id) {
    if (this._useAPI) {
      const res = await fetch(`${this._apiBase}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.errors?.join(". ") || "Failed to delete sponsor");
      }
      this._cache.sponsors = this._cache.sponsors.filter((s) => s.id !== id);
      return true;
    }

    const data = this._getData();
    const initialLength = data.sponsors.length;
    data.sponsors = data.sponsors.filter((s) => s.id !== id);
    if (data.sponsors.length < initialLength) {
      await this._setData(data);
      return true;
    }
    return false;
  },

  /**
   * Check if any sponsor is using the given tile indices
   * @param {Array<number>} tileIndices
   * @param {string|null} excludeSponsorId
   * @returns {{ isUsed: boolean, sponsorName: string|null }}
   */
  areTilesUsed(tileIndices, excludeSponsorId = null) {
    const sponsors = this.getAll();
    const tileSet = new Set(tileIndices);

    for (const sponsor of sponsors) {
      if (sponsor.id === excludeSponsorId) continue;
      if (!sponsor.cluster || !sponsor.cluster.tileIndices) continue;

      for (const tileIndex of sponsor.cluster.tileIndices) {
        if (tileSet.has(tileIndex)) {
          return { isUsed: true, sponsorName: sponsor.name };
        }
      }
    }
    return { isUsed: false, sponsorName: null };
  },

  /**
   * Get all tile indices that are assigned to sponsors
   * @param {string|null} excludeSponsorId
   * @returns {Set<number>}
   */
  getAssignedTiles(excludeSponsorId = null) {
    const sponsors = this.getAll();
    const assigned = new Set();

    for (const sponsor of sponsors) {
      if (sponsor.id === excludeSponsorId) continue;
      if (!sponsor.cluster || !sponsor.cluster.tileIndices) continue;

      for (const tileIndex of sponsor.cluster.tileIndices) {
        assigned.add(tileIndex);
      }
    }
    return assigned;
  },

  /**
   * Get assigned tile map with sponsor pattern data for preview
   * @param {string|null} excludeSponsorId
   * @returns {Map<number, {sponsorId: string, patternImage: string|null, patternAdjustment: Object}>}
   */
  getAssignedTileMap(excludeSponsorId = null) {
    const sponsors = this.getAll();
    const tileMap = new Map();

    for (const sponsor of sponsors) {
      if (sponsor.id === excludeSponsorId) continue;
      if (!sponsor.cluster || !sponsor.cluster.tileIndices) continue;

      const info = {
        sponsorId: sponsor.id,
        patternImage: sponsor.patternImage || sponsor.patternUrl || null,
        patternAdjustment: sponsor.patternAdjustment || {},
      };

      for (const tileIndex of sponsor.cluster.tileIndices) {
        tileMap.set(tileIndex, info);
      }
    }
    return tileMap;
  },

  /**
   * Export all sponsors to JSON string
   * @returns {string}
   */
  exportJSON() {
    const data = this._getData();
    return JSON.stringify(data, null, 2);
  },

  /**
   * Import sponsors from JSON string
   * @param {string} jsonString
   * @param {boolean} merge
   * @returns {Promise<{ success: boolean, imported: number, errors: Array }>}
   */
  async importJSON(jsonString, merge = true) {
    try {
      const imported = JSON.parse(jsonString);

      if (this._useAPI) {
        const res = await fetch(`${this._apiBase}/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sponsors: imported.sponsors, merge }),
        });
        const result = await res.json();
        // Refresh cache from server
        if (result.success) {
          const refresh = await fetch(this._apiBase);
          if (refresh.ok) this._cache = await refresh.json();
        }
        return result;
      }

      const errors = [];
      let importedCount = 0;

      if (!imported.sponsors || !Array.isArray(imported.sponsors)) {
        return {
          success: false,
          imported: 0,
          errors: ["Invalid JSON format: missing sponsors array"],
        };
      }

      const data = merge
        ? this._getData()
        : { version: this.VERSION, sponsors: [], lastModified: "" };
      const existingIds = new Set(data.sponsors.map((s) => s.id));

      for (const sponsor of imported.sponsors) {
        if (!sponsor.name) {
          errors.push(`Sponsor missing name, skipped`);
          continue;
        }
        if (!sponsor.cluster || !sponsor.cluster.tileIndices) {
          errors.push(
            `Sponsor "${sponsor.name}" missing cluster data, skipped`,
          );
          continue;
        }

        if (merge && existingIds.has(sponsor.id)) {
          const index = data.sponsors.findIndex((s) => s.id === sponsor.id);
          data.sponsors[index] = {
            ...data.sponsors[index],
            ...sponsor,
            updatedAt: new Date().toISOString(),
          };
        } else {
          const newSponsor = {
            ...sponsor,
            id: merge ? this.generateId() : sponsor.id,
            createdAt: sponsor.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            active: sponsor.active !== undefined ? sponsor.active : true,
          };
          data.sponsors.push(newSponsor);
        }
        importedCount++;
      }

      await this._setData(data);
      return { success: true, imported: importedCount, errors };
    } catch (e) {
      return {
        success: false,
        imported: 0,
        errors: ["Failed to parse JSON: " + e.message],
      };
    }
  },

  /**
   * Clear all sponsors
   * @returns {Promise<void>}
   */
  async clearAll() {
    if (this._useAPI) {
      const res = await fetch(`${this._apiBase}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sponsors: [], merge: false }),
      });
      if (res.ok) {
        this._cache = { version: this.VERSION, sponsors: [], lastModified: "" };
      }
      return;
    }

    await this._setData({
      version: this.VERSION,
      sponsors: [],
      lastModified: "",
    });
  },

  /**
   * Validate a sponsor object
   * @param {Object} sponsor
   * @returns {{ valid: boolean, errors: Array }}
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
          errors.push(
            `Reward ${i + 1}: duplicate accomplishment "${reward.accomplishment}"`,
          );
        }
        accomplishments.add(reward.accomplishment);

        if (
          reward.rewardType === "crypto" &&
          (reward.rewardValue === undefined || reward.rewardValue < 1)
        ) {
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
  },
};
