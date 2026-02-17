/**
 * AdLands - Crypto System
 * Handles crypto earnings (¢), leveling, and stat tracking
 */

class CryptoSystem {
    constructor() {
        // Crypto values by action
        this.cryptoValues = {
            // Passive/Constant
            ticContribution: 10,        // Per tic contributed to capture/hold
            defendingPerMinute: 100,    // Per minute of defending a hex

            // Combat
            damageDealt: 1,             // Per 1 HP damage
            killBonus: 250,             // Finishing blow bonus

            // Territory
            hexCaptured: 100,           // Individual hex captured
            holdingExponent: 1.05,      // Exponential base for adjacency bonus (1.05^neighbors)

            // Rare/Major Events
            squadObjective: 5000,
            sessionMVP: 25000
        };

        // Player stats
        this.stats = {
            totalCrypto: 0,
            level: 1,
            sessionCrypto: 0,

            // Combat
            kills: 0,
            deaths: 0,
            damageDealt: 0,

            // Territory
            hexesCaptured: 0,
            clustersCaptured: 0,
            ticsContributed: 0,
            timeDefending: 0  // in seconds
        };

        // Combo system
        this.combo = {
            count: 0,
            lastGainTime: 0,
            timeout: 2000,  // 2 seconds to maintain combo
            minForCombo: 3  // Need 3+ gains to show combo
        };

        // Defending tracking
        this.defendingState = {
            isDefending: false,
            currentClusterId: null,
            startTime: 0,
            accumulatedTime: 0  // ms
        };

        // Visual feedback callback (set by cryptoVisuals.js)
        this.onCryptoGain = null;
        this.onLevelUp = null;
        this.onCombo = null;
        this.onSessionCryptoChange = null;  // For commander system ranking updates

        // Crypto gain enabled flag (disabled during fast travel / before deployment)
        this.enabled = false;

        // Load saved stats
        this._loadStats();

    }

    // ========================
    // LEVEL CALCULATIONS
    // ========================

    /**
     * Get crypto required to reach a specific level
     */
    getCryptoRequiredForLevel(level) {
        if (level <= 1) return 0;
        if (level <= 5) return level * 10000;
        if (level <= 10) return 50000 + (level - 5) * 20000;
        if (level <= 20) return 150000 + (level - 10) * 35000;
        return 500000 + (level - 20) * 50000;
    }

    /**
     * Get total crypto required from level 1 to target level
     */
    getTotalCryptoForLevel(level) {
        let total = 0;
        for (let i = 2; i <= level; i++) {
            total += this.getCryptoRequiredForLevel(i);
        }
        return total;
    }

    /**
     * Calculate level from total crypto
     */
    getLevelFromCrypto(totalCrypto) {
        let level = 1;
        let cryptoNeeded = 0;
        while (true) {
            const nextLevelCrypto = this.getCryptoRequiredForLevel(level + 1);
            if (cryptoNeeded + nextLevelCrypto > totalCrypto) break;
            cryptoNeeded += nextLevelCrypto;
            level++;
        }
        return level;
    }

    /**
     * Get progress toward next level (0-1)
     */
    getLevelProgress() {
        const currentLevelTotalCrypto = this.getTotalCryptoForLevel(this.stats.level);
        const nextLevelCrypto = this.getCryptoRequiredForLevel(this.stats.level + 1);
        const cryptoIntoLevel = this.stats.totalCrypto - currentLevelTotalCrypto;
        return Math.min(1, Math.max(0, cryptoIntoLevel / nextLevelCrypto));
    }

    /**
     * Get crypto needed for next level
     */
    getCryptoToNextLevel() {
        const currentLevelTotalCrypto = this.getTotalCryptoForLevel(this.stats.level);
        const nextLevelTotalCrypto = this.getTotalCryptoForLevel(this.stats.level + 1);
        return nextLevelTotalCrypto - this.stats.totalCrypto;
    }

    // ========================
    // CLUSTER CAPTURE CRYPTO
    // ========================

    /**
     * Calculate crypto for capturing a cluster based on hex count
     * Formula: Linear with 50% bonus (hexCount × 1.5)
     * Example: 10-hex = 15 ¢, 20-hex = 30 ¢, 50-hex = 75 ¢
     */
    getClusterCaptureCrypto(hexCount) {
        return hexCount * 1.5;
    }

    // ========================
    // CRYPTO GAIN METHODS
    // ========================

    /**
     * Award crypto and trigger visual feedback
     * @param {number} amount - Crypto amount
     * @param {string} reason - Reason for crypto gain
     * @param {THREE.Vector3} worldPosition - Optional position for floating number
     */
    awardCrypto(amount, reason, worldPosition = null) {
        if (amount <= 0) return;
        if (!this.enabled) {
            console.warn(`[CryptoSystem] Crypto BLOCKED - System is DISABLED! Would have awarded ¢${amount} for ${reason}. Player must spawn via Fast Travel (press E near a portal) first.`);
            return;
        }

        this.stats.totalCrypto += amount;
        this.stats.sessionCrypto += amount;

        // Notify commander system of session crypto change
        if (this.onSessionCryptoChange) {
            this.onSessionCryptoChange('player', this.stats.sessionCrypto);
        }

        // Level-up is now purchased manually (no auto level-up)

        // Trigger visual feedback
        if (this.onCryptoGain) {
            this.onCryptoGain(amount, reason, worldPosition);
        } else {
            console.warn('[CryptoSystem] No onCryptoGain callback registered!');
        }

        // Auto-save periodically
        this._saveStats();
    }

    // ========================
    // SPECIFIC CRYPTO ACTIONS
    // ========================

    /**
     * Award crypto for dealing damage
     */
    awardDamageCrypto(damageAmount, targetPosition) {
        const crypto = Math.floor(damageAmount * this.cryptoValues.damageDealt);
        this.stats.damageDealt += damageAmount;
        this.awardCrypto(crypto, 'damage', targetPosition);
        return crypto;
    }

    /**
     * Award crypto for getting a kill
     */
    awardKillCrypto(targetPosition) {
        this.stats.kills++;
        this.awardCrypto(this.cryptoValues.killBonus, 'kill', targetPosition);
        return this.cryptoValues.killBonus;
    }

    /**
     * Award crypto for contributing a tic
     */
    awardTicCrypto(position) {
        this.stats.ticsContributed++;
        this.awardCrypto(this.cryptoValues.ticContribution, 'tic', position);
        return this.cryptoValues.ticContribution;
    }

    /**
     * Award crypto for capturing a hex
     */
    awardHexCaptureCrypto(position) {
        this.stats.hexesCaptured++;
        this.awardCrypto(this.cryptoValues.hexCaptured, 'hex', position);
        return this.cryptoValues.hexCaptured;
    }

    /**
     * Award crypto for holding territories (called once per minute)
     * @param {number} totalCrypto - Total crypto to award
     * @param {THREE.Vector3} position - Fallback position for visual
     * @param {Array<{pos: THREE.Vector3, crypto: number}>} hexData - Per-hex position and crypto values
     */
    awardHoldingCrypto(totalCrypto, position, hexData = null) {
        if (totalCrypto <= 0) return 0;

        if (hexData && hexData.length > 0) {
            this.stats.totalCrypto += totalCrypto;
            this.stats.sessionCrypto += totalCrypto;

            // Level-up is now purchased manually (no auto level-up)

            // Each hex has its own crypto value based on adjacency
            hexData.forEach(({ pos, crypto }) => {
                if (this.onCryptoGain) {
                    this.onCryptoGain(Math.round(crypto * 10) / 10, 'holding', pos);
                }
            });

            this._saveStats();
        } else {
            this.awardCrypto(totalCrypto, 'holding', position);
        }

        return totalCrypto;
    }

    /**
     * Award crypto for capturing a cluster
     */
    awardClusterCaptureCrypto(hexCount, position, hexCenters = null) {
        const totalCrypto = this.getClusterCaptureCrypto(hexCount);
        this.stats.clustersCaptured++;

        // If hex centers are provided, spawn crypto at each hex; otherwise use single position
        if (hexCenters && hexCenters.length > 0) {
            const cryptoPerHex = Math.floor(totalCrypto / hexCenters.length);
            const remainder = totalCrypto % hexCenters.length;

            // Award crypto without visual (we'll spawn individual hex crypto numbers)
            this.stats.totalCrypto += totalCrypto;
            this.stats.sessionCrypto += totalCrypto;

            // Level-up is now purchased manually (no auto level-up)

            // Spawn individual crypto numbers at each hex center
            hexCenters.forEach((hexCenter, index) => {
                // Add 1 extra to first N hexes to distribute remainder
                const hexCrypto = cryptoPerHex + (index < remainder ? 1 : 0);
                if (this.onCryptoGain) {
                    this.onCryptoGain(hexCrypto, 'cluster', hexCenter);
                }
            });

            this._saveStats();
        } else {
            // Fallback to single crypto award at position
            this.awardCrypto(totalCrypto, 'cluster', position);
        }

        return totalCrypto;
    }

    /**
     * Record a death
     */
    recordDeath() {
        this.stats.deaths++;
        this._saveStats();
    }

    // ========================
    // DEFENDING SYSTEM
    // ========================

    /**
     * Update defending state (call each frame or second)
     * @param {number} clusterId - Current cluster player is in
     * @param {string} clusterOwner - Faction that owns the cluster
     * @param {string} playerFaction - Player's faction
     * @param {THREE.Vector3} playerPosition - Player's world position
     * @param {number} deltaTime - Time since last update in seconds
     */
    updateDefending(clusterId, clusterOwner, playerFaction, playerPosition, deltaTime) {
        const isDefending = clusterOwner === playerFaction && clusterId !== undefined;

        if (isDefending) {
            if (!this.defendingState.isDefending || this.defendingState.currentClusterId !== clusterId) {
                // Started defending new cluster
                this.defendingState.isDefending = true;
                this.defendingState.currentClusterId = clusterId;
                this.defendingState.startTime = performance.now();
            }

            // Accumulate time
            this.defendingState.accumulatedTime += deltaTime * 1000;

            // Award crypto every minute
            const minuteMs = 60 * 1000;
            if (this.defendingState.accumulatedTime >= minuteMs) {
                const minutesDefended = Math.floor(this.defendingState.accumulatedTime / minuteMs);
                const crypto = minutesDefended * this.cryptoValues.defendingPerMinute;
                this.stats.timeDefending += minutesDefended * 60;
                this.awardCrypto(crypto, 'defend', playerPosition);
                this.defendingState.accumulatedTime -= minutesDefended * minuteMs;
            }
        } else {
            // Stopped defending
            this.defendingState.isDefending = false;
            this.defendingState.currentClusterId = null;
        }
    }

    // ========================
    // PERSISTENCE
    // ========================

    _saveStats() {
        try {
            const profileKey = window.activeProfileIndex !== undefined
                ? `adlands_player_stats_${window.activeProfileIndex}`
                : 'adlands_player_stats';
            localStorage.setItem(profileKey, JSON.stringify(this.stats));
        } catch (e) {
            console.warn('[CryptoSystem] Failed to save stats:', e);
        }
        // Also sync to Firestore via ProfileManager (debounced)
        if (window.profileManager && window.profileManager.loaded) {
            window.profileManager.saveProfile();
        }
    }

    _loadStats() {
        // Crypto resets to zero on each page refresh - no persistence
        // If authenticated, ProfileManager.loadProfile() will overwrite stats
        // with Firestore data after auth completes.
    }

    /**
     * Recalculate level from totalCrypto (legacy migration only).
     * Level is now purchased manually, so this only runs if no level is stored.
     * Called by ProfileManager after loading persistent data.
     */
    _recalculateLevel() {
        // Only auto-calculate for legacy players who have no stored level yet
        if (!this.stats.level || this.stats.level < 1) {
            this.stats.level = this.getLevelFromCrypto(this.stats.totalCrypto);
        }
    }

    /**
     * Reset all stats (for testing)
     */
    resetStats() {
        this.stats = {
            totalCrypto: 0,
            level: 1,
            sessionCrypto: 0,
            kills: 0,
            deaths: 0,
            damageDealt: 0,
            hexesCaptured: 0,
            clustersCaptured: 0,
            ticsContributed: 0,
            timeDefending: 0
        };
        this._saveStats();
    }

    // ========================
    // GETTERS
    // ========================

    getStats() {
        return { ...this.stats };
    }

    getKDRatio() {
        return this.stats.deaths > 0 ? (this.stats.kills / this.stats.deaths).toFixed(2) : this.stats.kills;
    }
}
