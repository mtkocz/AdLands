/**
 * AdLands - Cosmetics Shop
 * Dashboard panel for browsing, purchasing, and equipping cosmetic items.
 *
 * Cosmetics are account-level purchases (shared across all 3 profiles).
 * Equipping is per-profile (different profiles can wear different skins).
 *
 * Categories: tankSkin, turretSkin, trackTrail, deathEffect, nameplate
 */

class CosmeticsShop {
  constructor() {
    /** Currently selected category tab */
    this.activeCategory = "tankSkin";

    /** Cosmetic categories */
    this.categories = [
      { id: "tankSkin", label: "Tank", icon: "\u{1F6E1}" },
      { id: "turretSkin", label: "Turret", icon: "\u{1F52B}" },
      { id: "trackTrail", label: "Trail", icon: "\u{1F4A8}" },
      { id: "deathEffect", label: "Effect", icon: "\u{1F4A5}" },
      { id: "nameplate", label: "Name", icon: "\u{1F3F7}" },
    ];

    /** Rarity tiers with colors */
    this.rarities = {
      common: { label: "Common", color: "#888888" },
      uncommon: { label: "Uncommon", color: "#4a9e4a" },
      rare: { label: "Rare", color: "#4a7abe" },
      epic: { label: "Epic", color: "#9b59b6" },
      legendary: { label: "Legendary", color: "#e6a817" },
    };

    /**
     * Built-in cosmetics catalog (static, no server needed for MVP).
     * In production, these would come from Firestore `cosmetics/` collection.
     * @type {Array<Object>}
     */
    this.catalog = this._buildDefaultCatalog();

    /**
     * Account-level purchased cosmetic IDs.
     * Loaded from Firestore account doc `cosmeticsPurchased`.
     * @type {Set<string>}
     */
    this.purchased = new Set();

    /**
     * Profile-level equipped cosmetics.
     * Loaded from Firestore profile doc `equippedCosmetics`.
     * @type {Object}
     */
    this.equipped = {
      tankSkin: null,
      turretSkin: null,
      trackTrail: null,
      deathEffect: null,
      nameplate: null,
    };

    /** Whether the catalog has been loaded from Firestore */
    this._catalogLoaded = false;
  }

  /**
   * Build default cosmetic items (built-in catalog).
   * Each item has: id, name, description, category, rarity, priceUSD
   */
  _buildDefaultCatalog() {
    return [
      // Tank Skins
      { id: "ts_desert_camo", name: "Desert Camo", description: "Sandy desert camouflage pattern", category: "tankSkin", rarity: "common", priceUSD: 0.99 },
      { id: "ts_arctic_white", name: "Arctic White", description: "Clean white winter finish", category: "tankSkin", rarity: "common", priceUSD: 0.99 },
      { id: "ts_midnight_black", name: "Midnight Black", description: "Stealth matte black coating", category: "tankSkin", rarity: "uncommon", priceUSD: 1.99 },
      { id: "ts_chrome", name: "Chrome", description: "Reflective chrome plating", category: "tankSkin", rarity: "rare", priceUSD: 2.99 },
      { id: "ts_neon_grid", name: "Neon Grid", description: "Glowing cyberpunk wireframe", category: "tankSkin", rarity: "epic", priceUSD: 4.99 },
      { id: "ts_golden_commander", name: "Golden Commander", description: "Prestigious gold-plated armor", category: "tankSkin", rarity: "legendary", priceUSD: 9.99 },

      // Turret Skins
      { id: "tu_carbon_fiber", name: "Carbon Fiber", description: "Lightweight carbon weave finish", category: "turretSkin", rarity: "common", priceUSD: 0.99 },
      { id: "tu_battle_scarred", name: "Battle Scarred", description: "Worn and weathered veteran look", category: "turretSkin", rarity: "uncommon", priceUSD: 1.99 },
      { id: "tu_plasma_core", name: "Plasma Core", description: "Glowing energy barrel effect", category: "turretSkin", rarity: "rare", priceUSD: 2.99 },
      { id: "tu_dragon_barrel", name: "Dragon Barrel", description: "Dragon-themed ornamental barrel", category: "turretSkin", rarity: "epic", priceUSD: 4.99 },

      // Track Trails
      { id: "tt_dust", name: "Heavy Dust", description: "Extra thick dust clouds behind your tank", category: "trackTrail", rarity: "common", priceUSD: 0.99 },
      { id: "tt_sparks", name: "Sparks", description: "Metal sparks trail from your treads", category: "trackTrail", rarity: "uncommon", priceUSD: 1.99 },
      { id: "tt_fire_trail", name: "Fire Trail", description: "Blazing fire trail behind your tank", category: "trackTrail", rarity: "rare", priceUSD: 2.99 },
      { id: "tt_rainbow", name: "Rainbow Trail", description: "Colorful rainbow streak", category: "trackTrail", rarity: "epic", priceUSD: 4.99 },

      // Death Effects
      { id: "de_confetti", name: "Confetti Pop", description: "Burst of confetti on destruction", category: "deathEffect", rarity: "common", priceUSD: 0.99 },
      { id: "de_nuke", name: "Mini Nuke", description: "Mushroom cloud explosion", category: "deathEffect", rarity: "rare", priceUSD: 2.99 },
      { id: "de_black_hole", name: "Black Hole", description: "Imploding singularity effect", category: "deathEffect", rarity: "legendary", priceUSD: 9.99 },

      // Nameplates
      { id: "np_clean", name: "Clean", description: "Simple white text nameplate", category: "nameplate", rarity: "common", priceUSD: 0.49 },
      { id: "np_gradient", name: "Gradient", description: "Faction-colored gradient plate", category: "nameplate", rarity: "uncommon", priceUSD: 0.99 },
      { id: "np_fire", name: "Flame", description: "Animated fire border effect", category: "nameplate", rarity: "rare", priceUSD: 1.99 },
      { id: "np_holographic", name: "Holographic", description: "Shimmering holographic border", category: "nameplate", rarity: "epic", priceUSD: 3.99 },
    ];
  }

  /**
   * Load purchases and equipped data from Firestore.
   * Called after profile is loaded.
   */
  async loadFromFirestore() {
    if (!window.firestoreSync?.isActive || !window.authManager?.uid) return;

    try {
      const db = firebase.firestore();

      // Load account-level purchases
      const accountDoc = await db.collection("accounts").doc(window.authManager.uid).get();
      if (accountDoc.exists) {
        const data = accountDoc.data();
        if (Array.isArray(data.cosmeticsPurchased)) {
          this.purchased = new Set(data.cosmeticsPurchased);
        }
      }

      // Load profile-level equipped cosmetics
      const profileIndex = window.profileManager?.profileIndex ?? 0;
      const profileDoc = await db
        .collection("accounts").doc(window.authManager.uid)
        .collection("profiles").doc(String(profileIndex))
        .get();

      if (profileDoc.exists) {
        const data = profileDoc.data();
        if (data.equippedCosmetics) {
          this.equipped = {
            tankSkin: data.equippedCosmetics.tankSkin || null,
            turretSkin: data.equippedCosmetics.turretSkin || null,
            trackTrail: data.equippedCosmetics.trackTrail || null,
            deathEffect: data.equippedCosmetics.deathEffect || null,
            nameplate: data.equippedCosmetics.nameplate || null,
          };
        }
      }

      this._catalogLoaded = true;
      console.log(`[CosmeticsShop] Loaded ${this.purchased.size} purchases, equipped:`, this.equipped);
    } catch (e) {
      console.warn("[CosmeticsShop] Firestore load failed:", e);
    }
  }

  /**
   * Purchase a cosmetic (account-level).
   * In production this would go through a payment flow.
   * For now, just adds to the purchased set and saves to Firestore.
   * @param {string} cosmeticId
   * @returns {boolean} Whether purchase succeeded
   */
  async purchase(cosmeticId) {
    const item = this.catalog.find((c) => c.id === cosmeticId);
    if (!item) return false;
    if (this.purchased.has(cosmeticId)) return false;

    this.purchased.add(cosmeticId);

    // Save to Firestore (account-level)
    if (window.firestoreSync?.isActive && window.authManager?.uid) {
      try {
        const db = firebase.firestore();
        await db.collection("accounts").doc(window.authManager.uid).update({
          cosmeticsPurchased: firebase.firestore.FieldValue.arrayUnion(cosmeticId),
        });
      } catch (e) {
        console.warn("[CosmeticsShop] Purchase save failed:", e);
      }
    }

    return true;
  }

  /**
   * Equip a cosmetic to the current profile.
   * @param {string} cosmeticId - The cosmetic item ID
   * @returns {boolean} Whether equip succeeded
   */
  async equip(cosmeticId) {
    const item = this.catalog.find((c) => c.id === cosmeticId);
    if (!item) return false;
    if (!this.purchased.has(cosmeticId)) return false;

    this.equipped[item.category] = cosmeticId;

    // Save to Firestore (profile-level)
    if (window.firestoreSync?.isActive) {
      window.firestoreSync.writeProfile({
        equippedCosmetics: { ...this.equipped },
      }, 2000);
    }

    return true;
  }

  /**
   * Unequip a cosmetic category.
   * @param {string} category - e.g. "tankSkin"
   */
  async unequip(category) {
    if (!this.equipped.hasOwnProperty(category)) return;

    this.equipped[category] = null;

    if (window.firestoreSync?.isActive) {
      window.firestoreSync.writeProfile({
        equippedCosmetics: { ...this.equipped },
      }, 2000);
    }
  }

  /**
   * Get equipped cosmetic for a category.
   * @param {string} category
   * @returns {Object|null} Catalog item or null
   */
  getEquipped(category) {
    const id = this.equipped[category];
    if (!id) return null;
    return this.catalog.find((c) => c.id === id) || null;
  }

  /**
   * Build the shop panel HTML content for Dashboard.
   * @returns {string} HTML string
   */
  buildContent() {
    const categoryTabs = this.categories.map((cat) => {
      const active = cat.id === this.activeCategory ? "active" : "";
      return `<button class="shop-tab ${active}" data-category="${cat.id}">${cat.icon} ${cat.label}</button>`;
    }).join("");

    const items = this.catalog.filter((c) => c.category === this.activeCategory);
    const itemCards = items.map((item) => this._buildItemCard(item)).join("");

    return `
      <div class="panel-inner shop-panel">
        <div class="shop-description">Purchases are shared across all profiles.</div>
        <div class="shop-tabs">${categoryTabs}</div>
        <div class="shop-items" id="shop-items">${itemCards}</div>
      </div>
    `;
  }

  /**
   * Build HTML for a single cosmetic item card.
   * @param {Object} item - Catalog item
   * @returns {string} HTML string
   */
  _buildItemCard(item) {
    const owned = this.purchased.has(item.id);
    const equipped = this.equipped[item.category] === item.id;
    const rarity = this.rarities[item.rarity] || this.rarities.common;

    let actionBtn = "";
    if (equipped) {
      actionBtn = `<button class="shop-item-btn shop-item-unequip" data-id="${item.id}">Unequip</button>`;
    } else if (owned) {
      actionBtn = `<button class="shop-item-btn shop-item-equip" data-id="${item.id}">Equip</button>`;
    } else {
      actionBtn = `<button class="shop-item-btn shop-item-buy" data-id="${item.id}">$${item.priceUSD.toFixed(2)}</button>`;
    }

    return `
      <div class="shop-item-card ${owned ? "owned" : ""} ${equipped ? "equipped" : ""}" data-id="${item.id}">
        <div class="shop-item-preview">
          <span class="shop-item-icon">${this.categories.find((c) => c.id === item.category)?.icon || "?"}</span>
        </div>
        <div class="shop-item-info">
          <div class="shop-item-name">${item.name}</div>
          <div class="shop-item-rarity" style="color: ${rarity.color}">${rarity.label}</div>
          <div class="shop-item-desc">${item.description}</div>
        </div>
        <div class="shop-item-action">${actionBtn}</div>
      </div>
    `;
  }

  /**
   * Called when the shop panel is expanded in the Dashboard.
   * Attaches event listeners for tabs and item actions.
   */
  onPanelOpen() {
    // Load from Firestore if not yet loaded
    if (!this._catalogLoaded && window.firestoreSync?.isActive) {
      this.loadFromFirestore().then(() => this._refreshItems());
    }

    // Tab clicks
    const tabs = document.querySelectorAll(".shop-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        this.activeCategory = tab.dataset.category;
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        this._refreshItems();
      });
    });

    // Item action clicks (delegated)
    const itemsContainer = document.getElementById("shop-items");
    if (itemsContainer) {
      itemsContainer.addEventListener("click", (e) => {
        const buyBtn = e.target.closest(".shop-item-buy");
        if (buyBtn) {
          this._handleBuy(buyBtn.dataset.id);
          return;
        }

        const equipBtn = e.target.closest(".shop-item-equip");
        if (equipBtn) {
          this._handleEquip(equipBtn.dataset.id);
          return;
        }

        const unequipBtn = e.target.closest(".shop-item-unequip");
        if (unequipBtn) {
          const item = this.catalog.find((c) => c.id === unequipBtn.dataset.id);
          if (item) {
            this.unequip(item.category);
            this._refreshItems();
          }
          return;
        }
      });
    }
  }

  /**
   * Handle buy button click.
   * For MVP, just marks as purchased (no real payment).
   * @param {string} cosmeticId
   */
  async _handleBuy(cosmeticId) {
    const item = this.catalog.find((c) => c.id === cosmeticId);
    if (!item) return;

    // TODO: Integrate real payment flow (Stripe, in-app purchase)
    // For now, just purchase directly
    const success = await this.purchase(cosmeticId);
    if (success) {
      this._refreshItems();

      // Show notification via Dashboard
      if (window.dashboard) {
        window.dashboard.addNotification(
          `Purchased: ${item.name}`,
          "achievement",
          "loadout",
        );
      }
    }
  }

  /**
   * Handle equip button click.
   * @param {string} cosmeticId
   */
  async _handleEquip(cosmeticId) {
    const success = await this.equip(cosmeticId);
    if (success) {
      this._refreshItems();
    }
  }

  /**
   * Re-render the items grid for the current category.
   */
  _refreshItems() {
    const container = document.getElementById("shop-items");
    if (!container) return;

    const items = this.catalog.filter((c) => c.category === this.activeCategory);
    container.innerHTML = items.map((item) => this._buildItemCard(item)).join("");
  }
}
