/**
 * AdLands - Presence Tracker Module
 * Time-series tracking of cumulative seconds spent by each faction on sponsor cluster tiles
 * Data is stored in localStorage for persistence across sessions
 */

const PresenceTracker = {
  STORAGE_KEY: "adlands_presence_history",
  SAMPLE_INTERVAL_MS: 1000, // 1 second - track every second for accuracy
  RECORD_INTERVAL_MS: 30000, // Record a data point every 30 seconds for the chart
  VERSION: 2,

  // Reference to planet for tile lookups
  _planet: null,
  _intervalId: null,
  _lastRecordTime: 0,
  _cachedData: null, // In-memory cache to avoid localStorage reads every second

  /**
   * Initialize the presence tracker
   * @param {Planet} planet - Reference to the planet instance
   */
  init(planet) {
    this._planet = planet;
    this._lastRecordTime = Date.now();
  },

  /**
   * Start periodic sampling
   * @param {BotTanks} botTanks - Reference to bot tanks
   * @param {Tank} playerTank - Reference to player tank
   * @param {string} playerFaction - Player's current faction
   */
  startSampling(botTanks, playerTank, playerFaction) {
    if (this._intervalId) {
      clearInterval(this._intervalId);
    }

    // Store references for sampling
    this._botTanks = botTanks;
    this._playerTank = playerTank;
    this._playerFaction = playerFaction;

    // Sample every second to accumulate time (staggered 667ms to avoid frame spike)
    setTimeout(() => {
      this._intervalId = setInterval(
        () => this._doSample(),
        this.SAMPLE_INTERVAL_MS,
      );
    }, 667);
  },

  /**
   * Update player faction (when player switches factions)
   * @param {string} faction - New player faction
   */
  setPlayerFaction(faction) {
    this._playerFaction = faction;
  },

  /**
   * Internal: Perform a sample - accumulate seconds for factions present on tiles
   */
  _doSample() {
    if (!this._planet) return;

    const sponsorClusters = this._planet.getAllSponsorClusters();
    if (!sponsorClusters || sponsorClusters.size === 0) return;

    const now = Date.now();
    const shouldRecord = now - this._lastRecordTime >= this.RECORD_INTERVAL_MS;

    // Build cluster→faction presence map from cached IDs (O(bots), no tile scans)
    const clusterPresence = this._buildClusterPresence();

    for (const [sponsorId, sponsorCluster] of sponsorClusters) {
      const presence = clusterPresence.get(sponsorCluster.clusterId) ||
                        { rust: false, cobalt: false, viridian: false };
      this._accumulateTime(sponsorId, presence, shouldRecord);
    }

    if (shouldRecord) {
      this._lastRecordTime = now;
    }
  },

  /**
   * Build a map of clusterId → { rust, cobalt, viridian } presence
   * Uses cached bot.clusterId (updated every frame) instead of expensive tile lookups
   * @returns {Map<number, { rust: boolean, cobalt: boolean, viridian: boolean }>}
   */
  _buildClusterPresence() {
    const map = new Map();

    // Check player tank (single lookup is acceptable)
    if (this._playerTank && this._playerFaction) {
      const clusterId = this._playerTank.getCurrentClusterId(this._planet);
      if (clusterId !== undefined) {
        if (!map.has(clusterId)) {
          map.set(clusterId, { rust: false, cobalt: false, viridian: false });
        }
        map.get(clusterId)[this._playerFaction] = true;
      }
    }

    // Check bot tanks — use cached clusterId, no expensive tile scans
    if (this._botTanks && this._botTanks.bots) {
      for (const bot of this._botTanks.bots) {
        if (bot.isDead || bot.isDeploying || bot.clusterId === undefined) continue;
        if (!map.has(bot.clusterId)) {
          map.set(bot.clusterId, { rust: false, cobalt: false, viridian: false });
        }
        const p = map.get(bot.clusterId);
        if (p[bot.faction] !== undefined) {
          p[bot.faction] = true;
        }
      }
    }

    return map;
  },

  /**
   * Accumulate time for factions present on sponsor tiles
   * @param {string} sponsorId - Sponsor ID
   * @param {{ rust: boolean, cobalt: boolean, viridian: boolean }} presence - Which factions are present
   * @param {boolean} shouldRecord - Whether to record a data point for the chart
   */
  _accumulateTime(sponsorId, presence, shouldRecord) {
    const data = this._getData();

    if (!data.sponsors[sponsorId]) {
      data.sponsors[sponsorId] = {
        startTime: new Date().toISOString(),
        // Cumulative seconds for each faction
        totals: { rust: 0, cobalt: 0, viridian: 0 },
        // Time-series samples for charting (recorded every RECORD_INTERVAL_MS)
        samples: [],
      };
    }

    const sponsorData = data.sponsors[sponsorId];

    // Add 1 second for each faction that has presence
    if (presence.rust) sponsorData.totals.rust += 1;
    if (presence.cobalt) sponsorData.totals.cobalt += 1;
    if (presence.viridian) sponsorData.totals.viridian += 1;

    // Record a data point for the chart and save to localStorage
    // Only save when shouldRecord is true (every 30 seconds) to avoid frame drops
    if (shouldRecord) {
      const startTime = new Date(sponsorData.startTime).getTime();
      const relativeTime = Date.now() - startTime;

      sponsorData.samples.push({
        t: relativeTime,
        r: sponsorData.totals.rust,
        c: sponsorData.totals.cobalt,
        v: sponsorData.totals.viridian,
      });

      // Limit samples to prevent unbounded growth (keep last 500 samples = ~4 hours at 30s intervals)
      if (sponsorData.samples.length > 500) {
        sponsorData.samples = sponsorData.samples.slice(-500);
      }

      // Only write to localStorage when recording (every 30s), not every second
      this._setData(data);
    }
  },

  /**
   * Get history for a sponsor (cumulative seconds over time)
   * @param {string} sponsorId - Sponsor ID
   * @returns {Array<{ timestamp: Date, rust: number, cobalt: number, viridian: number }>}
   */
  getHistory(sponsorId) {
    const data = this._getData();
    const sponsorData = data.sponsors[sponsorId];

    if (
      !sponsorData ||
      !sponsorData.samples ||
      sponsorData.samples.length === 0
    ) {
      return [];
    }

    const startTime = new Date(sponsorData.startTime).getTime();

    return sponsorData.samples.map((s) => ({
      timestamp: new Date(startTime + s.t),
      rust: s.r,
      cobalt: s.c,
      viridian: s.v,
    }));
  },

  /**
   * Get rolling per-interval activity rates for a sponsor (derived from cumulative samples)
   * @param {string} sponsorId - Sponsor ID
   * @param {number} windowSize - Number of recent samples to include (default 60 = ~30 min)
   * @returns {Array<{ rust: number, cobalt: number, viridian: number }>}
   */
  getRollingRates(sponsorId, windowSize = 60) {
    const data = this._getData();
    const sponsorData = data.sponsors[sponsorId];

    if (
      !sponsorData ||
      !sponsorData.samples ||
      sponsorData.samples.length < 2
    ) {
      return [];
    }

    const samples = sponsorData.samples;
    const startIdx = Math.max(0, samples.length - windowSize);
    const windowed = samples.slice(startIdx);
    const rates = [];

    for (let i = 1; i < windowed.length; i++) {
      const prev = windowed[i - 1];
      const curr = windowed[i];
      rates.push({
        rust: curr.r - prev.r,
        cobalt: curr.c - prev.c,
        viridian: curr.v - prev.v,
      });
    }

    return rates;
  },

  /**
   * Get current totals for a sponsor
   * @param {string} sponsorId - Sponsor ID
   * @returns {{ rust: number, cobalt: number, viridian: number }}
   */
  getTotals(sponsorId) {
    const data = this._getData();
    const sponsorData = data.sponsors[sponsorId];

    if (!sponsorData || !sponsorData.totals) {
      return { rust: 0, cobalt: 0, viridian: 0 };
    }

    return { ...sponsorData.totals };
  },

  /**
   * Clear history for a sponsor (called when sponsor is deleted)
   * @param {string} sponsorId - Sponsor ID
   */
  clearHistory(sponsorId) {
    const data = this._getData();
    delete data.sponsors[sponsorId];
    this._setData(data);
  },

  /**
   * Clear all history
   */
  clearAll() {
    this._cachedData = null; // Clear cache
    this._setData({ version: this.VERSION, sponsors: {}, lastModified: "" });
  },

  /**
   * Get storage data (uses in-memory cache to avoid localStorage reads every second)
   * @returns {{ version: number, sponsors: Object, lastModified: string }}
   */
  _getData() {
    // Return cached data if available
    if (this._cachedData) {
      return this._cachedData;
    }

    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        // Migration from v1 to v2
        if (parsed.version === 1) {
          this._cachedData = {
            version: this.VERSION,
            sponsors: {},
            lastModified: new Date().toISOString(),
          };
          return this._cachedData;
        }
        this._cachedData = parsed;
        return this._cachedData;
      }
    } catch (e) {
      console.error("[PresenceTracker] Error reading data:", e);
    }
    this._cachedData = {
      version: this.VERSION,
      sponsors: {},
      lastModified: new Date().toISOString(),
    };
    return this._cachedData;
  },

  /**
   * Save storage data
   * @param {{ version: number, sponsors: Object, lastModified: string }} data
   */
  _setData(data) {
    data.lastModified = new Date().toISOString();
    // Update cache
    this._cachedData = data;
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("[PresenceTracker] Error saving data:", e);
      // If storage is full, try to trim old samples
      if (e.name === "QuotaExceededError") {
        this._trimOldSamples(data);
      }
    }
  },

  /**
   * Trim old samples when storage is full
   * @param {{ version: number, sponsors: Object }} data
   */
  _trimOldSamples(data) {
    console.warn("[PresenceTracker] Storage full, trimming old samples");
    for (const sponsorId in data.sponsors) {
      const sponsorData = data.sponsors[sponsorId];
      if (sponsorData.samples && sponsorData.samples.length > 100) {
        // Keep only last 100 samples
        sponsorData.samples = sponsorData.samples.slice(-100);
      }
    }

    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("[PresenceTracker] Still cannot save after trimming:", e);
    }
  },

  /**
   * Stop sampling
   */
  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  },
};
