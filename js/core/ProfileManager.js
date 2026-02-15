/**
 * AdLands - ProfileManager
 * Manages loading profile data into game systems and switching profiles mid-game.
 * Bridges Firestore profile data with CryptoSystem, BadgeSystem, TitleSystem, etc.
 */

class ProfileManager {
  constructor(firestoreSync) {
    /** @type {FirestoreSync} */
    this.sync = firestoreSync;

    /** @type {number} Active profile index */
    this.profileIndex = 0;

    /** @type {Object|null} Currently loaded profile data */
    this.profileData = null;

    /** @type {boolean} Whether a profile is loaded */
    this.loaded = false;

    // External system references (set by main.js)
    /** @type {CryptoSystem|null} */
    this.cryptoSystem = null;
    /** @type {BadgeSystem|null} */
    this.badgeSystem = null;
    /** @type {TitleSystem|null} */
    this.titleSystem = null;
    /** @type {Dashboard|null} */
    this.dashboard = null;
    /** @type {SettingsManager|null} */
    this.settingsManager = null;
    /** @type {WeaponSlotSystem|null} */
    this.weaponSlotSystem = null;
  }

  /**
   * Load a profile's data into all game systems.
   * Called after auth + profile selection, and after profile switch.
   * @param {number} profileIndex - 0, 1, or 2
   * @param {Object} profileData - Profile document data from Firestore
   */
  loadProfile(profileIndex, profileData) {
    this.profileIndex = profileIndex;
    this.profileData = profileData;
    this.loaded = true;

    // Activate Firestore sync for this profile
    if (this.sync && window.authManager?.uid) {
      this.sync.activate(window.authManager.uid, profileIndex);
    }

    // Load into CryptoSystem
    if (this.cryptoSystem && profileData) {
      this.cryptoSystem.stats.totalCrypto = profileData.totalCrypto || 0;
      this.cryptoSystem.stats.level = profileData.level || 1;
      this.cryptoSystem.stats.kills = profileData.kills || 0;
      this.cryptoSystem.stats.deaths = profileData.deaths || 0;
      this.cryptoSystem.stats.damageDealt = profileData.damageDealt || 0;
      this.cryptoSystem.stats.hexesCaptured = profileData.hexesCaptured || 0;
      this.cryptoSystem.stats.clustersCaptured = profileData.clustersCaptured || 0;
      this.cryptoSystem.stats.ticsContributed = profileData.ticsContributed || 0;
      this.cryptoSystem.stats.timeDefending = profileData.timeDefending || 0;
      // Recalculate level from totalCrypto
      this.cryptoSystem._recalculateLevel();
    }

    // Load into BadgeSystem
    if (this.badgeSystem && profileData) {
      if (profileData.unlockedBadges) {
        this.badgeSystem.importUnlockedBadges(profileData.unlockedBadges);
      }
      if (profileData.badgeProgress && Object.keys(profileData.badgeProgress).length > 0) {
        this.badgeSystem.importProgress(profileData.badgeProgress);
      }
    }

    // Load into TitleSystem
    if (this.titleSystem && profileData?.titleStats) {
      if (profileData.titleStats.currentTitle) {
        this.titleSystem.currentTitle = profileData.titleStats.currentTitle;
      }
    }

    // Load loadout into Dashboard
    if (this.dashboard && profileData?.loadout) {
      this.dashboard.equippedUpgrades = { ...profileData.loadout };
    }

    // Load loadout + tank upgrades into WeaponSlotSystem
    if (this.weaponSlotSystem) {
      this.weaponSlotSystem.loadFromProfile(
        profileData?.loadout,
        profileData?.tankUpgrades
      );
    }

  }

  /**
   * Save current game system state to Firestore.
   * Called periodically and on page unload.
   */
  saveProfile() {
    if (!this.sync?.isActive || !this.loaded) return;

    const fields = {};

    // Save CryptoSystem stats
    if (this.cryptoSystem) {
      fields.totalCrypto = this.cryptoSystem.stats.totalCrypto;
      fields.level = this.cryptoSystem.stats.level;
    }

    // Save BadgeSystem
    if (this.badgeSystem) {
      const badgeData = this.badgeSystem.exportData();
      if (badgeData.unlockedBadges) {
        fields.unlockedBadges = badgeData.unlockedBadges;
      }
      if (badgeData.progress) {
        fields.badgeProgress = badgeData.progress;
      }
    }

    // Save TitleSystem
    if (this.titleSystem) {
      fields.titleStats = {
        currentTitle: this.titleSystem.currentTitle || "Contractor",
      };
    }

    // Save loadout from Dashboard
    if (this.dashboard) {
      fields.loadout = this.dashboard.equippedUpgrades || {};
    }

    // Save weapon slot system (loadout + tank upgrades)
    if (this.weaponSlotSystem) {
      fields.loadout = this.weaponSlotSystem.equipped || fields.loadout;
      fields.tankUpgrades = { ...this.weaponSlotSystem.tankUpgrades };
    }

    this.sync.writeProfile(fields, 30000); // 30s debounce
  }

  /**
   * Force-save all data immediately (no debounce).
   * Called on page unload.
   */
  saveNow() {
    if (!this.sync?.isActive || !this.loaded) return;

    const fields = {};

    if (this.cryptoSystem) {
      fields.totalCrypto = this.cryptoSystem.stats.totalCrypto;
      fields.level = this.cryptoSystem.stats.level;
    }

    if (this.badgeSystem) {
      const badgeData = this.badgeSystem.exportData();
      if (badgeData.unlockedBadges) fields.unlockedBadges = badgeData.unlockedBadges;
      if (badgeData.progress) fields.badgeProgress = badgeData.progress;
    }

    if (this.titleSystem) {
      fields.titleStats = { currentTitle: this.titleSystem.currentTitle || "Contractor" };
    }

    if (this.dashboard) {
      fields.loadout = this.dashboard.equippedUpgrades || {};
    }

    // Save weapon slot system (loadout + tank upgrades)
    if (this.weaponSlotSystem) {
      fields.loadout = this.weaponSlotSystem.equipped || fields.loadout;
      fields.tankUpgrades = { ...this.weaponSlotSystem.tankUpgrades };
    }

    // Write immediately
    this.sync.writeProfileNow(fields);
  }

  /**
   * Handle switching to a different profile.
   * Saves current profile, loads new one.
   * @param {number} newIndex - New profile index
   * @param {Object} newProfileData - New profile document data
   */
  switchProfile(newIndex, newProfileData) {
    // Save current profile first
    this.saveNow();

    // Load new profile
    this.loadProfile(newIndex, newProfileData);
  }

  /**
   * Dispose and flush on sign-out or page close.
   */
  dispose() {
    this.saveNow();
    if (this.sync) {
      this.sync.flushAll();
      this.sync.deactivate();
    }
    this.loaded = false;
    this.profileData = null;
  }
}
