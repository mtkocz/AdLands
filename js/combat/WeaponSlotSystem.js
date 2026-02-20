/**
 * AdLands - Weapon Slot System
 * Manages weapon/upgrade slot equipping and computes gameplay modifiers.
 *
 * Uses the UPGRADES and SLOT_UNLOCKS defined in Dashboard.js.
 * Loadout is persisted to Firestore profile.
 */

class WeaponSlotSystem {
  constructor() {
    /**
     * Currently equipped upgrades: slotId → upgradeId
     * Slot IDs: "offense-1", "offense-2", "defense-1", "defense-2", "tactical-1", "tactical-2"
     */
    this.equipped = {};

    /**
     * Upgrade stat definitions: upgradeId → { modifiers }
     * Modifiers are multipliers or flat bonuses applied during combat.
     */
    this.upgradeStats = {
      // Offense
      cannon: { damageMultiplier: 1.15, category: "offense" },
      gunner: { fireRateMultiplier: 1.25, category: "offense" },
      "50cal": { damageMultiplier: 1.3, rangeMultiplier: 0.8, category: "offense" },
      missile: { damageMultiplier: 1.5, fireRateMultiplier: 0.7, splashRadius: 5, category: "offense" },
      flamethrower: { damageMultiplier: 0.8, rangeMultiplier: 0.5, dotDamage: 5, category: "offense" },

      // Defense
      shield: { shieldHp: 25, category: "defense" },
      flares: { flareCooldown: 30, category: "defense" },
      barricades: { armorMultiplier: 1.2, speedMultiplier: 0.9, category: "defense" },

      // Tactical
      proximity_mine: { mineCooldown: 15, mineDamage: 40, category: "tactical" },
      foot_soldiers: { soldierCount: 3, category: "tactical" },
      turrets: { turretDamage: 10, turretRange: 15, category: "tactical" },
      welding_gun: { repairRate: 5, category: "tactical" },
    };

    /**
     * Tank upgrade tiers: upgradeType → tier (0-5)
     * Applied as persistent stat multipliers.
     */
    this.tankUpgrades = { armor: 0, speed: 0, fireRate: 0, damage: 0 };

    /** Tank upgrade multiplier per tier */
    this._tierMultiplier = 0.05; // 5% per tier
  }

  /**
   * Load loadout from a Firestore profile object.
   * @param {Object} loadout - { "offense-1": "cannon", ... }
   * @param {Object} [tankUpgrades] - { armor: 0, speed: 0, fireRate: 0, damage: 0 }
   */
  loadFromProfile(loadout, tankUpgrades) {
    this.equipped = loadout && typeof loadout === "object" ? { ...loadout } : {};
    if (tankUpgrades && typeof tankUpgrades === "object") {
      this.tankUpgrades = {
        armor: tankUpgrades.armor || 0,
        speed: tankUpgrades.speed || 0,
        fireRate: tankUpgrades.fireRate || 0,
        damage: tankUpgrades.damage || 0,
      };
    }
  }

  /**
   * Equip an upgrade into a slot.
   * @param {string} slotId - e.g. "offense-1"
   * @param {string} upgradeId - e.g. "cannon"
   * @param {number} playerLevel - Current player level (for slot unlock check)
   * @returns {boolean} Whether equip succeeded
   */
  equip(slotId, upgradeId, playerLevel) {
    // Validate slot exists in SLOT_UNLOCKS
    if (typeof SLOT_UNLOCKS === "undefined" || !(slotId in SLOT_UNLOCKS)) return false;

    // Check if slot is unlocked at player's level
    if (playerLevel < SLOT_UNLOCKS[slotId]) return false;

    // Validate upgrade exists
    if (!this.upgradeStats[upgradeId]) return false;

    // Validate category matches slot
    const slotCategory = slotId.split("-")[0]; // "offense", "defense", "tactical"
    if (this.upgradeStats[upgradeId].category !== slotCategory) return false;

    this.equipped[slotId] = upgradeId;

    // Notify server so it can persist authoritatively
    if (window.networkManager?.connected) {
      window.networkManager.socket.emit("equip-upgrade", { slotId, upgradeId });
    }

    this._saveToProfile();
    return true;
  }

  /**
   * Unequip from a slot.
   * @param {string} slotId
   */
  unequip(slotId) {
    delete this.equipped[slotId];

    // Notify server so it can persist authoritatively
    if (window.networkManager?.connected) {
      window.networkManager.socket.emit("unequip-upgrade", { slotId });
    }

    this._saveToProfile();
  }

  /**
   * Upgrade a tank stat by one tier (costs crypto, server-authoritative).
   * Sends request to server which validates and deducts crypto.
   * @param {string} type - "armor", "speed", "fireRate", or "damage"
   * @param {CryptoSystem} cryptoSystem - For local pre-check only
   * @returns {boolean} Whether request was sent (server confirms asynchronously)
   */
  upgradeTank(type, cryptoSystem) {
    if (!this.tankUpgrades.hasOwnProperty(type)) return false;
    if (this.tankUpgrades[type] >= 5) return false; // Max tier

    const tier = this.tankUpgrades[type] + 1;
    const cost = this._getUpgradeCost(tier);

    // Local pre-check (server is authoritative, this is just UX)
    if (!cryptoSystem || cryptoSystem.stats.totalCrypto < cost) return false;

    // Send to server for authoritative handling
    if (window.networkManager?.connected) {
      window.networkManager.socket.emit("tank-upgrade", { type });
      return true;
    }

    return false;
  }

  /**
   * Apply a server-confirmed tank upgrade.
   * Called when server sends "tank-upgrade-confirmed".
   * @param {string} type - "armor", "speed", "fireRate", or "damage"
   * @param {number} tier - New tier level
   */
  applyServerUpgrade(type, tier) {
    if (this.tankUpgrades.hasOwnProperty(type)) {
      this.tankUpgrades[type] = tier;
      this._saveToProfile();
    }
  }

  /**
   * Get the crypto cost for a tank upgrade tier.
   * @param {number} tier - 1-5
   * @returns {number}
   */
  _getUpgradeCost(tier) {
    // Exponential cost curve: 5k, 15k, 40k, 100k, 250k
    const costs = [0, 5000, 15000, 40000, 100000, 250000];
    return costs[tier] || 0;
  }

  /**
   * Compute aggregate combat modifiers from all equipped items + tank upgrades.
   * Called by CannonSystem before damage/fire-rate calculations.
   * @returns {Object} Modifier values
   */
  getModifiers() {
    const mods = {
      damageMultiplier: 1,
      fireRateMultiplier: 1,
      rangeMultiplier: 1,
      speedMultiplier: 1,
      armorMultiplier: 1,
      shieldHp: 0,
      splashRadius: 0,
      dotDamage: 0,
      repairRate: 0,
    };

    // Apply equipped weapon modifiers
    for (const slotId in this.equipped) {
      const upgradeId = this.equipped[slotId];
      const stats = this.upgradeStats[upgradeId];
      if (!stats) continue;

      if (stats.damageMultiplier) mods.damageMultiplier *= stats.damageMultiplier;
      if (stats.fireRateMultiplier) mods.fireRateMultiplier *= stats.fireRateMultiplier;
      if (stats.rangeMultiplier) mods.rangeMultiplier *= stats.rangeMultiplier;
      if (stats.speedMultiplier) mods.speedMultiplier *= stats.speedMultiplier;
      if (stats.armorMultiplier) mods.armorMultiplier *= stats.armorMultiplier;
      if (stats.shieldHp) mods.shieldHp += stats.shieldHp;
      if (stats.splashRadius) mods.splashRadius = Math.max(mods.splashRadius, stats.splashRadius);
      if (stats.dotDamage) mods.dotDamage += stats.dotDamage;
      if (stats.repairRate) mods.repairRate += stats.repairRate;
    }

    // Apply tank upgrades (each tier adds 5%)
    const tm = this._tierMultiplier;
    mods.damageMultiplier *= 1 + this.tankUpgrades.damage * tm;
    mods.fireRateMultiplier *= 1 + this.tankUpgrades.fireRate * tm;
    mods.speedMultiplier *= 1 + this.tankUpgrades.speed * tm;
    mods.armorMultiplier *= 1 + this.tankUpgrades.armor * tm;

    return mods;
  }

  /**
   * Save current loadout + tank upgrades to Firestore via ProfileManager.
   */
  _saveToProfile() {
    if (window.firestoreSync && window.firestoreSync.isActive) {
      window.firestoreSync.writeProfile({
        loadout: this.equipped,
        tankUpgrades: this.tankUpgrades,
      }, 5000); // 5s debounce
    }
    // Also update Dashboard's equippedUpgrades for UI sync
    if (window.dashboard) {
      window.dashboard.equippedUpgrades = { ...this.equipped };
    }
  }
}
