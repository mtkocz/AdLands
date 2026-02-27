/**
 * AdLands - Loadout HUD (HL1-style weapon selector)
 * Top-center HUD showing 3 loadout categories (Offense, Defense, Tactical).
 * Keys [1][2][3] cycle the active slot per category.
 * Only the active slot's modifiers apply during combat.
 */

class LoadoutHUD {
  /**
   * @param {WeaponSlotSystem} weaponSlotSystem
   */
  constructor(weaponSlotSystem) {
    this.wss = weaponSlotSystem;

    /** Which category is currently expanded (or null) */
    this.expandedCategory = null;

    /** Whether the HUD strip is visible */
    this.visible = false;

    /** Auto-hide timer ID */
    this._hideTimer = null;

    /** Auto-hide delay in ms */
    this._hideDelay = 3000;

    /** Category key mapping */
    this._keyMap = { "1": "offense", "2": "defense", "3": "tactical" };

    /** Category display labels */
    this._labels = { offense: "Offense", defense: "Defense", tactical: "Tactical" };

    /** DOM references per category */
    this._tabs = {}; // category → { el, slotsEl, activeNameEl, slot1El, slot2El }

    this._container = document.getElementById("loadout-hud");
    console.log("[LoadoutHUD] container:", this._container);
    if (this._container) {
      this._buildDOM();
      this._bindKeys();
      console.log("[LoadoutHUD] initialized, keys [1][2][3] bound");
    } else {
      console.warn("[LoadoutHUD] #loadout-hud element not found in DOM");
    }
  }

  // ── DOM ──────────────────────────────────────────────

  _buildDOM() {
    const categories = ["offense", "defense", "tactical"];
    const keys = ["1", "2", "3"];

    for (let i = 0; i < 3; i++) {
      const cat = categories[i];
      const key = keys[i];

      const tab = document.createElement("div");
      tab.className = "loadout-hud-tab";
      tab.dataset.category = cat;

      // Header row: key badge + label + active item name
      const header = document.createElement("div");
      header.className = "tab-header";

      const keyBadge = document.createElement("span");
      keyBadge.className = "tab-key";
      keyBadge.textContent = key;

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = this._labels[cat];

      header.appendChild(keyBadge);
      header.appendChild(label);
      tab.appendChild(header);

      // Dropdown slots
      const slotsEl = document.createElement("div");
      slotsEl.className = "tab-slots";

      const slot1 = document.createElement("div");
      slot1.className = "tab-slot";
      slot1.dataset.slot = `${cat}-1`;

      const slot2 = document.createElement("div");
      slot2.className = "tab-slot";
      slot2.dataset.slot = `${cat}-2`;

      slotsEl.appendChild(slot1);
      slotsEl.appendChild(slot2);
      tab.appendChild(slotsEl);

      this._container.appendChild(tab);
      this._tabs[cat] = { el: tab, slotsEl, slot1El: slot1, slot2El: slot2 };
    }
  }

  // ── Input ────────────────────────────────────────────

  _bindKeys() {
    window.addEventListener("keydown", (e) => {
      // Only log for keys we care about
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const tag = document.activeElement?.tagName;
        const authEl = document.getElementById("auth-screen");
        const authHidden = authEl ? authEl.classList.contains("auth-hidden") : "no-el";
        console.log("[LoadoutHUD] key=" + e.key, "activeTag=" + tag, "authHidden=" + authHidden);
      }

      // Standard guards: skip if typing in input fields
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Skip if auth screen is showing (uses .auth-hidden class, not inline style)
      const authEl = document.getElementById("auth-screen");
      if (authEl && !authEl.classList.contains("auth-hidden")) return;

      const category = this._keyMap[e.key];
      if (!category) return;

      console.log("[LoadoutHUD] PASSED guards, showing:", category);
      e.preventDefault();

      if (!this.visible) this._show();
      this._cycleSlot(category);

      this._resetHideTimer();
    });
  }

  // ── Slot Cycling ─────────────────────────────────────

  _cycleSlot(category) {
    const slot1 = `${category}-1`;
    const slot2 = `${category}-2`;
    const equipped1 = this.wss.equipped[slot1];
    const equipped2 = this.wss.equipped[slot2];

    // Nothing to cycle if zero or one item equipped
    if (!equipped1 && !equipped2) return;
    if (!equipped2) { this._setActive(category, slot1); return; }
    if (!equipped1) { this._setActive(category, slot2); return; }

    // Both equipped: toggle
    const current = this.wss.activeSlots[category];
    const next = current === slot1 ? slot2 : slot1;
    this._setActive(category, next);
  }

  _setActive(category, slotId) {
    this.wss.setActiveSlot(category, slotId);

    // Notify server for persistence
    if (window.networkManager?.connected) {
      window.networkManager.socket.emit("active-slot-change", { category, slotId });
    }

    // Persist locally
    this.wss._saveToProfile();

    this._updateDisplay();
  }

  // ── Visibility ───────────────────────────────────────

  _show() {
    this.visible = true;
    this._container.classList.add("visible");
  }

  _hide() {
    this.visible = false;
    this.expandedCategory = null;
    this._container.classList.remove("visible");
    // Collapse all tabs
    for (const cat in this._tabs) {
      this._tabs[cat].el.classList.remove("expanded");
    }
  }

  _expand(category) {
    this.expandedCategory = category;
    for (const cat in this._tabs) {
      this._tabs[cat].el.classList.toggle("expanded", cat === category);
    }
    this._updateDisplay();
  }

  _resetHideTimer() {
    if (this._hideTimer) clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this._hide(), this._hideDelay);
  }

  // ── Display Update ───────────────────────────────────

  _updateDisplay() {
    for (const cat in this._tabs) {
      const { slot1El, slot2El } = this._tabs[cat];
      const activeSlot = this.wss.activeSlots[cat];

      const id1 = this.wss.equipped[`${cat}-1`];
      const id2 = this.wss.equipped[`${cat}-2`];
      const name1 = this._getUpgradeName(id1);
      const name2 = this._getUpgradeName(id2);

      // Slot 1
      slot1El.textContent = name1 || "-- Empty --";
      slot1El.className = "tab-slot";
      if (!name1) slot1El.classList.add("empty");
      if (activeSlot === `${cat}-1`) slot1El.classList.add("active");

      // Slot 2
      slot2El.textContent = name2 || "-- Empty --";
      slot2El.className = "tab-slot";
      if (!name2) slot2El.classList.add("empty");
      if (activeSlot === `${cat}-2`) slot2El.classList.add("active");
    }
  }

  /**
   * Look up display name for an upgrade ID using the global UPGRADES constant.
   * @param {string} upgradeId
   * @returns {string}
   */
  _getUpgradeName(upgradeId) {
    if (!upgradeId || typeof UPGRADES === "undefined") return "";
    for (const cat in UPGRADES) {
      const item = UPGRADES[cat].find((u) => u.id === upgradeId);
      if (item) return item.name;
    }
    return upgradeId; // fallback to raw ID
  }

  // ── External Sync ────────────────────────────────────

  /**
   * Called when loadout changes externally (e.g. Dashboard equip/unequip).
   * Validates active slots still point to equipped items.
   */
  syncFromLoadout() {
    for (const cat of ["offense", "defense", "tactical"]) {
      const activeSlot = this.wss.activeSlots[cat];
      // If active slot is now empty, try the other slot
      if (!this.wss.equipped[activeSlot]) {
        const other = activeSlot === `${cat}-1` ? `${cat}-2` : `${cat}-1`;
        if (this.wss.equipped[other]) {
          this.wss.setActiveSlot(cat, other);
        }
      }
    }
    if (this.visible) this._updateDisplay();
  }
}
