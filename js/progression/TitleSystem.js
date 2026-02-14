/**
 * AdLands - Dynamic Title System
 * Calculates player titles based on 24-hour playstyle metrics
 * Titles update when dominant behavior shifts
 */

class TitleSystem {
  constructor() {
    // Title definitions organized by category and intensity
    this.titles = {
      // ===== COMBAT TITLES =====
      combat: {
        metric: "killsPerHour",
        tiers: [
          { min: 30, title: "Terminator", priority: 1 },
          { min: 20, title: "Apex Predator", priority: 2 },
          { min: 10, title: "Predator", priority: 3 },
          { min: 5, title: "Hunter", priority: 4 },
        ],
      },
      accuracy: {
        metric: "accuracy",
        tiers: [
          { min: 0.7, title: "Surgical", priority: 2 },
          { min: 0.5, title: "Sharpshooter", priority: 3 },
          { min: 0.3, title: "Precision", priority: 4 },
        ],
      },
      lowAccuracy: {
        metric: "accuracy",
        tiers: [
          { max: 0.15, title: "Spray & Pray", priority: 5 },
          { max: 0.2, title: "Suppressive Fire", priority: 6 },
        ],
        inverted: true,
      },
      damage: {
        metric: "damagePerHour",
        tiers: [
          { min: 50000, title: "Powerhouse", priority: 3 },
          { min: 25000, title: "Heavy Hitter", priority: 4 },
          { min: 10000, title: "Bruiser", priority: 5 },
        ],
      },
      killstreak: {
        metric: "avgKillstreak",
        tiers: [
          { min: 10, title: "Unstoppable", priority: 1 },
          { min: 5, title: "Rampage", priority: 2 },
          { min: 3, title: "Hot Streak", priority: 3 },
        ],
      },

      // ===== SURVIVAL TITLES =====
      lowDeaths: {
        metric: "deathsPerHour",
        tiers: [
          { max: 0.5, title: "Ghost", priority: 2 },
          { max: 1, title: "Untouchable", priority: 3 },
          { max: 2, title: "Survivor", priority: 4 },
        ],
        inverted: true,
      },
      highDeaths: {
        metric: "deathsPerHour",
        tiers: [
          { min: 10, title: "Kamikaze", priority: 4 },
          { min: 6, title: "Fearless", priority: 5 },
          { min: 4, title: "First In", priority: 6 },
        ],
      },
      longLife: {
        metric: "avgLifespan",
        tiers: [
          { min: 1800, title: "Cockroach", priority: 3 },
          { min: 900, title: "Enduring", priority: 4 },
          { min: 600, title: "Marathon", priority: 5 },
        ],
      },

      // ===== TERRITORY TITLES =====
      captures: {
        metric: "hexesPerHour",
        tiers: [
          { min: 20, title: "Conquistador", priority: 2 },
          { min: 10, title: "Liberator", priority: 3 },
          { min: 5, title: "Flag Planter", priority: 4 },
        ],
      },
      clusters: {
        metric: "clustersPerHour",
        tiers: [
          { min: 2, title: "Kingpin", priority: 1 },
          { min: 1, title: "Big Game Hunter", priority: 2 },
          { min: 0.5, title: "Whale Hunter", priority: 3 },
        ],
      },
      tics: {
        metric: "ticsPerHour",
        tiers: [
          { min: 500, title: "Land Baron", priority: 3 },
          { min: 200, title: "Expansionist", priority: 4 },
          { min: 100, title: "Imperialist", priority: 5 },
        ],
      },
      defense: {
        metric: "defenseTicRatio",
        tiers: [
          { min: 0.7, title: "Fortress", priority: 3 },
          { min: 0.5, title: "Sentinel", priority: 4 },
          { min: 0.4, title: "Anchor", priority: 5 },
        ],
      },
      attack: {
        metric: "attackTicRatio",
        tiers: [
          { min: 0.7, title: "Raider", priority: 3 },
          { min: 0.5, title: "Invader", priority: 4 },
          { min: 0.4, title: "Aggressor", priority: 5 },
        ],
      },

      // ===== MOVEMENT TITLES =====
      speed: {
        metric: "avgSpeed",
        tiers: [
          { min: 40, title: "Hyperdrive", priority: 4 },
          { min: 30, title: "Speed Demon", priority: 5 },
          { min: 25, title: "Roadrunner", priority: 6 },
        ],
      },
      distance: {
        metric: "distancePerHour",
        tiers: [
          { min: 10000, title: "Globe Trotter", priority: 5 },
          { min: 5000, title: "Explorer", priority: 6 },
          { min: 2500, title: "Wanderer", priority: 7 },
        ],
      },
      enemyTerritory: {
        metric: "enemyTerritoryRatio",
        tiers: [
          { min: 0.6, title: "Behind Enemy Lines", priority: 3 },
          { min: 0.4, title: "Infiltrator", priority: 4 },
          { min: 0.3, title: "Daredevil", priority: 5 },
        ],
      },
      friendlyTerritory: {
        metric: "friendlyTerritoryRatio",
        tiers: [
          { min: 0.8, title: "Homeland Security", priority: 5 },
          { min: 0.6, title: "Defender", priority: 6 },
          { min: 0.5, title: "Patriot", priority: 7 },
        ],
      },

      // ===== SOCIAL TITLES =====
      proximity: {
        metric: "avgDistanceToAllies",
        tiers: [
          { max: 30, title: "Pack Animal", priority: 5 },
          { max: 50, title: "Team Player", priority: 6 },
        ],
        inverted: true,
      },
      loneWolf: {
        metric: "avgDistanceToAllies",
        tiers: [
          { min: 150, title: "Lone Wolf", priority: 4 },
          { min: 100, title: "Maverick", priority: 5 },
          { min: 80, title: "Ronin", priority: 6 },
        ],
      },
      squadTime: {
        metric: "squadTimeRatio",
        tiers: [
          { min: 0.8, title: "Ride or Die", priority: 4 },
          { min: 0.5, title: "Squad Goals", priority: 5 },
        ],
      },
      soloTime: {
        metric: "squadTimeRatio",
        tiers: [
          { max: 0.1, title: "One-Man Show", priority: 5 },
          { max: 0.3, title: "Self-Reliant", priority: 6 },
        ],
        inverted: true,
      },

      // ===== EQUIPMENT TITLES =====
      shieldHeavy: {
        metric: "shieldActivationsPerHour",
        tiers: [
          { min: 20, title: "Iron Wall", priority: 5 },
          { min: 10, title: "Deflector", priority: 6 },
          { min: 5, title: "Turtle", priority: 7 },
        ],
      },
      deployables: {
        metric: "deployablesPerHour",
        tiers: [
          { min: 5, title: "Architect", priority: 5 },
          { min: 3, title: "Engineer", priority: 6 },
          { min: 1, title: "Trapper", priority: 7 },
        ],
      },

      // ===== COMMUNICATION TITLES =====
      chatty: {
        metric: "messagesPerHour",
        tiers: [
          { min: 30, title: "Chatterbox", priority: 6 },
          { min: 15, title: "Social Butterfly", priority: 7 },
          { min: 8, title: "Diplomat", priority: 8 },
        ],
      },
      silent: {
        metric: "messagesPerHour",
        tiers: [
          { max: 0.5, title: "Strong Silent Type", priority: 6 },
          { max: 1, title: "Mysterious", priority: 7 },
        ],
        inverted: true,
      },
      pings: {
        metric: "pingsPerHour",
        tiers: [
          { min: 10, title: "Shot Caller", priority: 5 },
          { min: 5, title: "Director", priority: 6 },
          { min: 3, title: "Coordinator", priority: 7 },
        ],
      },

      // ===== META TITLES =====
      screenshots: {
        metric: "screenshotsPerHour",
        tiers: [
          { min: 3, title: "Content Creator", priority: 6 },
          { min: 1, title: "Photographer", priority: 7 },
        ],
      },
      shares: {
        metric: "sharesPerHour",
        tiers: [
          { min: 2, title: "Evangelist", priority: 5 },
          { min: 1, title: "Brand Ambassador", priority: 6 },
        ],
      },
      longSession: {
        metric: "sessionLength",
        tiers: [
          { min: 14400, title: "Dedicated", priority: 6 },
          { min: 7200, title: "Marathon Runner", priority: 7 },
        ],
      },
      efficiency: {
        metric: "cryptoPerHour",
        tiers: [
          { min: 10000, title: "Min-Maxer", priority: 5 },
          { min: 5000, title: "Optimizer", priority: 6 },
          { min: 2500, title: "Grinder", priority: 7 },
        ],
      },
      casual: {
        metric: "cryptoPerHour",
        tiers: [
          { max: 500, title: "Tourist", priority: 8 },
          { max: 1000, title: "Zen Master", priority: 9 },
        ],
        inverted: true,
      },

      // ===== FACTION LOYALTY TITLES =====
      factionSwitcher: {
        metric: "factionSwitchesPerHour",
        tiers: [
          { min: 3, title: "Turncoat", priority: 2 },
          { min: 2, title: "Double Agent", priority: 3 },
          { min: 1, title: "Opportunist", priority: 4 },
          { min: 0.5, title: "Free Agent", priority: 5 },
        ],
      },
    };

    // Special titles that override normal calculation
    this.specialTitles = {
      newPlayer: {
        title: "Fresh Recruit",
        condition: (stats) => stats.totalPlaytime < 60,
      }, // 1 minute
      returning: {
        title: "Comeback Kid",
        condition: (stats) => stats.daysSinceLastPlay >= 7,
      },
      balanced: {
        title: "Renaissance Contractor",
        condition: (stats) => stats.isBalanced,
      },
    };

    // Fallback title
    this.defaultTitle = "Contractor";

    // Current player stats (last 24 hours)
    this.stats24h = this._getDefaultStats();

    // Current title
    this.currentTitle = this.defaultTitle;

    // Callbacks
    this.onTitleChange = null;

    // Load from localStorage
    this._loadStats();

  }

  // ========================
  // STATS TRACKING
  // ========================

  _getDefaultStats() {
    return {
      // Time tracking
      hoursPlayed: 0,
      sessionLength: 0,
      totalPlaytime: 0,
      daysSinceLastPlay: 0,

      // Combat
      kills: 0,
      deaths: 0,
      damageDealt: 0,
      shotsFired: 0,
      shotsHit: 0,
      maxKillstreak: 0,
      totalKillstreaks: 0,
      killstreakCount: 0,

      // Territory
      ticsContributed: 0,
      defenseTics: 0,
      attackTics: 0,
      hexesCaptured: 0,
      clustersCaptured: 0,

      // Movement
      distanceTraveled: 0,
      avgSpeed: 0,
      speedSamples: 0,
      timeInEnemyTerritory: 0,
      timeInFriendlyTerritory: 0,
      totalTerritoryTime: 0,

      // Social
      avgDistanceToAllies: 0,
      distanceSamples: 0,
      shieldActivations: 0,
      deployablesPlaced: 0,
      messagesSent: 0,
      pingsSent: 0,
      squadTime: 0,
      totalTime: 0,

      // Meta
      screenshotsTaken: 0,
      socialShares: 0,
      cryptoGained: 0,

      // Tracking timestamps
      lastUpdate: Date.now(),
      statsStart: Date.now(),

      // Life tracking
      totalLifespan: 0,
      lifeCount: 0,

      // Faction switching
      factionSwitches: 0,
    };
  }

  _loadStats() {
    try {
      const saved = localStorage.getItem("adlands_title_stats");
      if (saved) {
        const data = JSON.parse(saved);

        // Check if stats are from last 1 minute (for fast title updates)
        const age = Date.now() - (data.statsStart || 0);
        if (age < 60 * 1000) {
          // 1 minute window
          this.stats24h = { ...this._getDefaultStats(), ...data };
        } else {
          // Stats are old, reset but keep totalPlaytime
          this.stats24h = this._getDefaultStats();
          this.stats24h.totalPlaytime = data.totalPlaytime || 0;
          this.stats24h.daysSinceLastPlay = Math.floor(
            age / (24 * 60 * 60 * 1000),
          );
        }

        // Load current title
        this.currentTitle = data.currentTitle || this.defaultTitle;
      }
    } catch (e) {
      console.warn("[TitleSystem] Failed to load stats:", e);
    }
  }

  _saveStats() {
    // Debounce localStorage writes to avoid frame drops
    // Only actually write every 5 seconds max
    if (this._saveTimeout) return;

    this._saveTimeout = setTimeout(() => {
      this._saveTimeout = null;
      try {
        const data = {
          ...this.stats24h,
          currentTitle: this.currentTitle,
        };
        localStorage.setItem("adlands_title_stats", JSON.stringify(data));
      } catch (e) {
        console.warn("[TitleSystem] Failed to save stats:", e);
      }
      // Also sync to Firestore via ProfileManager (debounced)
      if (window.profileManager && window.profileManager.loaded) {
        window.profileManager.saveProfile();
      }
    }, 5000);
  }

  // ========================
  // STAT UPDATES
  // ========================

  /**
   * Track a kill
   */
  trackKill() {
    this.stats24h.kills++;
    this._saveStats();
  }

  /**
   * Track a death
   */
  trackDeath(lifespan) {
    this.stats24h.deaths++;
    this.stats24h.totalLifespan += lifespan;
    this.stats24h.lifeCount++;
    this._saveStats();
  }

  /**
   * Track damage dealt
   */
  trackDamage(amount) {
    this.stats24h.damageDealt += amount;
    this._saveStats();
  }

  /**
   * Track shots fired/hit
   */
  trackShots(fired, hit) {
    this.stats24h.shotsFired += fired;
    this.stats24h.shotsHit += hit;
    this._saveStats();
  }

  /**
   * Track killstreak
   */
  trackKillstreak(streak) {
    if (streak > this.stats24h.maxKillstreak) {
      this.stats24h.maxKillstreak = streak;
    }
    this.stats24h.totalKillstreaks += streak;
    this.stats24h.killstreakCount++;
    this._saveStats();
  }

  /**
   * Track tics contributed
   */
  trackTics(amount, isDefense) {
    this.stats24h.ticsContributed += amount;
    if (isDefense) {
      this.stats24h.defenseTics += amount;
    } else {
      this.stats24h.attackTics += amount;
    }
    this._saveStats();
  }

  /**
   * Track hex capture
   */
  trackHexCapture() {
    this.stats24h.hexesCaptured++;
    this._saveStats();
  }

  /**
   * Track cluster capture
   */
  trackClusterCapture() {
    this.stats24h.clustersCaptured++;
    this._saveStats();
  }

  /**
   * Track movement (call periodically)
   */
  trackMovement(distance, speed) {
    this.stats24h.distanceTraveled += distance;

    // Running average of speed
    const samples = this.stats24h.speedSamples || 0;
    this.stats24h.avgSpeed =
      (this.stats24h.avgSpeed * samples + speed) / (samples + 1);
    this.stats24h.speedSamples = samples + 1;

    this._saveStats();
  }

  /**
   * Track territory presence (call periodically)
   */
  trackTerritoryPresence(isEnemy, deltaTime) {
    this.stats24h.totalTerritoryTime += deltaTime;
    if (isEnemy) {
      this.stats24h.timeInEnemyTerritory += deltaTime;
    } else {
      this.stats24h.timeInFriendlyTerritory += deltaTime;
    }
    this._saveStats();
  }

  /**
   * Track distance to allies (call periodically)
   */
  trackAllyDistance(avgDistance) {
    const samples = this.stats24h.distanceSamples || 0;
    this.stats24h.avgDistanceToAllies =
      (this.stats24h.avgDistanceToAllies * samples + avgDistance) /
      (samples + 1);
    this.stats24h.distanceSamples = samples + 1;
    this._saveStats();
  }

  /**
   * Track shield activation
   */
  trackShieldActivation() {
    this.stats24h.shieldActivations++;
    this._saveStats();
  }

  /**
   * Track deployable placed
   */
  trackDeployable() {
    this.stats24h.deployablesPlaced++;
    this._saveStats();
  }

  /**
   * Track message sent
   */
  trackMessage() {
    this.stats24h.messagesSent++;
    this._saveStats();
  }

  /**
   * Track ping sent
   */
  trackPing() {
    this.stats24h.pingsSent++;
    this._saveStats();
  }

  /**
   * Track squad time (call periodically)
   */
  trackSquadTime(inSquad, deltaTime) {
    this.stats24h.totalTime += deltaTime;
    if (inSquad) {
      this.stats24h.squadTime += deltaTime;
    }
    this._saveStats();
  }

  /**
   * Track screenshot
   */
  trackScreenshot() {
    this.stats24h.screenshotsTaken++;
    this._saveStats();
  }

  /**
   * Track social share
   */
  trackShare() {
    this.stats24h.socialShares++;
    this._saveStats();
  }

  /**
   * Track crypto gained
   */
  trackCrypto(amount) {
    this.stats24h.cryptoGained += amount;
    this._saveStats();
  }

  /**
   * Track faction switch
   */
  trackFactionSwitch() {
    this.stats24h.factionSwitches++;
    this._saveStats();
  }

  /**
   * Update session length (call periodically)
   */
  updateSessionTime(deltaTime) {
    this.stats24h.sessionLength += deltaTime;
    this.stats24h.hoursPlayed = this.stats24h.sessionLength / 3600;
    this.stats24h.totalPlaytime += deltaTime;
    this._saveStats();
  }

  // ========================
  // TITLE CALCULATION
  // ========================

  /**
   * Calculate derived metrics from raw stats
   */
  _calculateMetrics() {
    const stats = this.stats24h;
    const hours = Math.max(stats.hoursPlayed, 0.1); // Prevent divide by zero

    return {
      // Combat
      killsPerHour: stats.kills / hours,
      accuracy: stats.shotsFired > 0 ? stats.shotsHit / stats.shotsFired : 0,
      damagePerHour: stats.damageDealt / hours,
      avgKillstreak:
        stats.killstreakCount > 0
          ? stats.totalKillstreaks / stats.killstreakCount
          : 0,

      // Survival
      deathsPerHour: stats.deaths / hours,
      avgLifespan:
        stats.lifeCount > 0 ? stats.totalLifespan / stats.lifeCount : 0,

      // Territory
      hexesPerHour: stats.hexesCaptured / hours,
      clustersPerHour: stats.clustersCaptured / hours,
      ticsPerHour: stats.ticsContributed / hours,
      defenseTicRatio:
        stats.ticsContributed > 0
          ? stats.defenseTics / stats.ticsContributed
          : 0,
      attackTicRatio:
        stats.ticsContributed > 0
          ? stats.attackTics / stats.ticsContributed
          : 0,

      // Movement
      avgSpeed: stats.avgSpeed,
      distancePerHour: stats.distanceTraveled / hours,
      enemyTerritoryRatio:
        stats.totalTerritoryTime > 0
          ? stats.timeInEnemyTerritory / stats.totalTerritoryTime
          : 0,
      friendlyTerritoryRatio:
        stats.totalTerritoryTime > 0
          ? stats.timeInFriendlyTerritory / stats.totalTerritoryTime
          : 0,

      // Social
      avgDistanceToAllies: stats.avgDistanceToAllies,
      shieldActivationsPerHour: stats.shieldActivations / hours,
      deployablesPerHour: stats.deployablesPlaced / hours,
      messagesPerHour: stats.messagesSent / hours,
      pingsPerHour: stats.pingsSent / hours,
      squadTimeRatio:
        stats.totalTime > 0 ? stats.squadTime / stats.totalTime : 0,

      // Meta
      screenshotsPerHour: stats.screenshotsTaken / hours,
      sharesPerHour: stats.socialShares / hours,
      sessionLength: stats.sessionLength,
      cryptoPerHour: stats.cryptoGained / hours,

      // Faction loyalty
      factionSwitchesPerHour: stats.factionSwitches / hours,

      // Special
      totalPlaytime: stats.totalPlaytime,
      daysSinceLastPlay: stats.daysSinceLastPlay,
      isBalanced: this._checkBalanced(stats, hours),
    };
  }

  /**
   * Check if player stats are balanced (no dominant playstyle)
   */
  _checkBalanced(stats, hours) {
    // Check if multiple categories have moderate activity
    const combat = stats.kills / hours;
    const territory = stats.hexesCaptured / hours;
    const social = stats.messagesSent / hours;

    // Consider balanced if no extreme values and reasonable activity in multiple areas
    const hasModerateKills = combat >= 2 && combat <= 15;
    const hasModerateCaptures = territory >= 2 && territory <= 15;
    const hasModerateChat = social >= 2 && social <= 20;

    return hasModerateKills && hasModerateCaptures && hasModerateChat;
  }

  /**
   * Calculate the player's current title based on 24h stats
   */
  calculateTitle() {
    const metrics = this._calculateMetrics();
    const candidates = [];

    // Check special titles first
    for (const [key, special] of Object.entries(this.specialTitles)) {
      if (special.condition(metrics)) {
        return special.title;
      }
    }

    // Check all title categories
    for (const [category, config] of Object.entries(this.titles)) {
      const metricValue = metrics[config.metric];
      if (metricValue === undefined) continue;

      for (const tier of config.tiers) {
        let matches = false;

        if (config.inverted) {
          // For inverted metrics (lower is better)
          if (tier.max !== undefined && metricValue <= tier.max) {
            matches = true;
          }
        } else {
          // For normal metrics (higher is better)
          if (tier.min !== undefined && metricValue >= tier.min) {
            matches = true;
          }
        }

        if (matches) {
          candidates.push({
            title: tier.title,
            priority: tier.priority,
            category,
            metricValue,
          });
          break; // Only take highest tier match per category
        }
      }
    }

    // Sort by priority (lower = more important)
    candidates.sort((a, b) => a.priority - b.priority);

    // Return highest priority title, or default
    return candidates.length > 0 ? candidates[0].title : this.defaultTitle;
  }

  /**
   * Update title and trigger callback if changed
   */
  updateTitle() {
    const newTitle = this.calculateTitle();

    if (newTitle !== this.currentTitle) {
      const oldTitle = this.currentTitle;
      this.currentTitle = newTitle;
      this._saveStats();

      if (this.onTitleChange) {
        this.onTitleChange(newTitle, oldTitle);
      }

    }

    return this.currentTitle;
  }

  // ========================
  // GETTERS
  // ========================

  /**
   * Get current title
   */
  getTitle() {
    return this.currentTitle;
  }

  /**
   * Get formatted title with brackets
   */
  getFormattedTitle() {
    return `[${this.currentTitle}]`;
  }

  /**
   * Get all possible titles (for display)
   */
  getAllTitles() {
    const titles = new Set();

    for (const config of Object.values(this.titles)) {
      for (const tier of config.tiers) {
        titles.add(tier.title);
      }
    }

    for (const special of Object.values(this.specialTitles)) {
      titles.add(special.title);
    }

    titles.add(this.defaultTitle);

    return Array.from(titles);
  }

  /**
   * Get title explanation (what metric earned it)
   */
  getTitleExplanation() {
    const metrics = this._calculateMetrics();
    const currentTitle = this.currentTitle;

    // Find the category that matches current title
    for (const [category, config] of Object.entries(this.titles)) {
      for (const tier of config.tiers) {
        if (tier.title === currentTitle) {
          const metricValue = metrics[config.metric];
          return {
            title: currentTitle,
            category,
            metric: config.metric,
            value: metricValue,
            threshold: tier.min || tier.max,
          };
        }
      }
    }

    return {
      title: currentTitle,
      category: "default",
      metric: null,
      value: null,
    };
  }

  /**
   * Get current 24h stats summary
   */
  getStatsSummary() {
    const metrics = this._calculateMetrics();
    return {
      kills: this.stats24h.kills,
      deaths: this.stats24h.deaths,
      kd:
        this.stats24h.deaths > 0
          ? (this.stats24h.kills / this.stats24h.deaths).toFixed(2)
          : this.stats24h.kills,
      accuracy: (metrics.accuracy * 100).toFixed(1) + "%",
      hexesCaptured: this.stats24h.hexesCaptured,
      hoursPlayed: metrics.hoursPlayed ? metrics.hoursPlayed.toFixed(1) : "0",
    };
  }

  // ========================
  // RESET
  // ========================

  /**
   * Reset 24h stats (for new day)
   */
  resetStats() {
    const totalPlaytime = this.stats24h.totalPlaytime;
    this.stats24h = this._getDefaultStats();
    this.stats24h.totalPlaytime = totalPlaytime;
    this._saveStats();
  }

  // ========================
  // CLEANUP
  // ========================

  /**
   * Force immediate save (bypasses debounce) - use on page unload
   */
  _forceSaveStats() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    try {
      const data = {
        ...this.stats24h,
        currentTitle: this.currentTitle,
      };
      localStorage.setItem("adlands_title_stats", JSON.stringify(data));
    } catch (e) {
      console.warn("[TitleSystem] Failed to save stats:", e);
    }
  }

  dispose() {
    this._forceSaveStats();
  }
}
