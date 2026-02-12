/**
 * AdLands - Moon Sponsor Panel
 * Admin UI for managing moon sponsor ad spaces.
 * Each of the 3 moons can be assigned to one sponsor with a pattern texture.
 */

class MoonSponsorPanel {
  constructor() {
    this.slots = [];
    this.apiBase = "";
    this.expandedMoon = null; // which moon index is expanded (or null)
  }

  async init() {
    // Detect API base URL (same origin)
    const loc = window.location;
    this.apiBase = loc.protocol + "//" + loc.host;

    // Build slot references
    const slotEls = document.querySelectorAll("#moon-sponsors-list .moon-slot");
    slotEls.forEach((el) => {
      const moonIndex = parseInt(el.dataset.moon, 10);
      this.slots[moonIndex] = {
        el,
        moonIndex,
        header: el.querySelector(".moon-slot-header"),
        statusEl: el.querySelector(".moon-slot-status"),
        formEl: el.querySelector(".moon-slot-form"),
        sponsor: null, // loaded data
      };
    });

    // Wire up click handlers on headers
    this.slots.forEach((slot) => {
      slot.header.addEventListener("click", () => this._toggleSlot(slot.moonIndex));
    });

    // Load data from server
    await this._loadAll();
  }

  async _loadAll() {
    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors");
      if (!res.ok) throw new Error("Failed to load moon sponsors");
      const data = await res.json();

      data.forEach((sponsor, i) => {
        if (i < this.slots.length) {
          this.slots[i].sponsor = sponsor;
          this._updateSlotDisplay(i);
        }
      });
    } catch (e) {
      console.warn("[MoonSponsorPanel] Could not load:", e.message);
    }
  }

  _updateSlotDisplay(moonIndex) {
    const slot = this.slots[moonIndex];
    if (!slot) return;
    const s = slot.sponsor;

    if (s && s.name) {
      slot.statusEl.textContent = s.name;
      slot.statusEl.classList.add("sponsored");
    } else {
      slot.statusEl.textContent = "Unsponsored";
      slot.statusEl.classList.remove("sponsored");
    }
  }

  _toggleSlot(moonIndex) {
    if (this.expandedMoon === moonIndex) {
      // Collapse
      this._collapseSlot(moonIndex);
      this.expandedMoon = null;
    } else {
      // Collapse any open slot
      if (this.expandedMoon !== null) {
        this._collapseSlot(this.expandedMoon);
      }
      // Expand this one
      this._expandSlot(moonIndex);
      this.expandedMoon = moonIndex;
    }
  }

  _collapseSlot(moonIndex) {
    const slot = this.slots[moonIndex];
    slot.formEl.style.display = "none";
    slot.formEl.innerHTML = "";
    slot.el.classList.remove("expanded");
  }

  async _expandSlot(moonIndex) {
    const slot = this.slots[moonIndex];

    // Fetch full data (including base64 pattern) for editing
    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors/" + moonIndex + "?full=1");
      if (res.ok) {
        const full = await res.json();
        slot.sponsor = full;
      }
    } catch (e) {
      // Use cached lite data
    }

    slot.el.classList.add("expanded");
    slot.formEl.style.display = "block";
    this._buildForm(slot);
  }

  _buildForm(slot) {
    const s = slot.sponsor || {};
    const mi = slot.moonIndex;

    slot.formEl.innerHTML = `
      <div class="moon-form-fields">
        <div class="form-group">
          <label for="moon-name-${mi}">Sponsor Name *</label>
          <input type="text" id="moon-name-${mi}" value="${this._esc(s.name || "")}" placeholder="e.g., Acme Corp" />
        </div>
        <div class="form-group">
          <label for="moon-tagline-${mi}">Tagline</label>
          <input type="text" id="moon-tagline-${mi}" value="${this._esc(s.tagline || "")}" placeholder="e.g., Building Tomorrow" />
        </div>
        <div class="form-group">
          <label for="moon-website-${mi}">Website URL</label>
          <input type="url" id="moon-website-${mi}" value="${this._esc(s.websiteUrl || "")}" placeholder="https://example.com" />
        </div>
        <div class="form-group">
          <label>Pattern Image (PNG)</label>
          <div class="file-input-group">
            <input type="file" id="moon-pattern-${mi}" accept="image/png,image/jpeg" />
            <label for="moon-pattern-${mi}" class="file-input-label">Choose File</label>
            <div class="image-preview" id="moon-pattern-preview-${mi}">
              ${s.patternImage || s.patternUrl
                ? `<img src="${s.patternImage || s.patternUrl}" alt="Pattern" />`
                : '<span class="image-preview-placeholder">No image</span>'
              }
            </div>
          </div>
        </div>
        <div class="moon-pattern-adjustments" id="moon-adj-${mi}" style="display:${s.patternImage || s.patternUrl ? "block" : "none"}">
          <label>Scale</label>
          <div class="slider-group">
            <input type="range" id="moon-scale-${mi}" min="0.1" max="8" step="0.01" value="${(s.patternAdjustment?.scale || 1).toFixed(2)}" />
            <span class="slider-value" id="moon-scale-val-${mi}">${(s.patternAdjustment?.scale || 1).toFixed(2)}x</span>
          </div>
          <label>Saturation</label>
          <div class="slider-group">
            <input type="range" id="moon-sat-${mi}" min="0" max="2" step="0.01" value="${(s.patternAdjustment?.saturation !== undefined ? s.patternAdjustment.saturation : 1).toFixed(2)}" />
            <span class="slider-value" id="moon-sat-val-${mi}">${(s.patternAdjustment?.saturation !== undefined ? s.patternAdjustment.saturation : 1).toFixed(2)}</span>
          </div>
          <label>Input Levels</label>
          <div class="levels-group">
            <div class="levels-input">
              <span class="levels-label">Black</span>
              <input type="range" id="moon-inblack-${mi}" min="0" max="255" step="1" value="${s.patternAdjustment?.inputBlack || 0}" />
              <span class="slider-value" id="moon-inblack-val-${mi}">${s.patternAdjustment?.inputBlack || 0}</span>
            </div>
            <div class="levels-input">
              <span class="levels-label">Gamma</span>
              <input type="range" id="moon-gamma-${mi}" min="0.1" max="3.0" step="0.01" value="${(s.patternAdjustment?.inputGamma || 1).toFixed(2)}" />
              <span class="slider-value" id="moon-gamma-val-${mi}">${(s.patternAdjustment?.inputGamma || 1).toFixed(2)}</span>
            </div>
            <div class="levels-input">
              <span class="levels-label">White</span>
              <input type="range" id="moon-inwhite-${mi}" min="0" max="255" step="1" value="${s.patternAdjustment?.inputWhite !== undefined ? s.patternAdjustment.inputWhite : 255}" />
              <span class="slider-value" id="moon-inwhite-val-${mi}">${s.patternAdjustment?.inputWhite !== undefined ? s.patternAdjustment.inputWhite : 255}</span>
            </div>
          </div>
          <label>Output Levels</label>
          <div class="levels-group">
            <div class="levels-input">
              <span class="levels-label">Black</span>
              <input type="range" id="moon-outblack-${mi}" min="0" max="255" step="1" value="${s.patternAdjustment?.outputBlack || 0}" />
              <span class="slider-value" id="moon-outblack-val-${mi}">${s.patternAdjustment?.outputBlack || 0}</span>
            </div>
            <div class="levels-input">
              <span class="levels-label">White</span>
              <input type="range" id="moon-outwhite-${mi}" min="0" max="255" step="1" value="${s.patternAdjustment?.outputWhite !== undefined ? s.patternAdjustment.outputWhite : 255}" />
              <span class="slider-value" id="moon-outwhite-val-${mi}">${s.patternAdjustment?.outputWhite !== undefined ? s.patternAdjustment.outputWhite : 255}</span>
            </div>
          </div>
        </div>
        <div class="moon-form-actions">
          <button class="btn btn-primary btn-small" id="moon-save-${mi}">Save</button>
          <button class="btn btn-secondary btn-small" id="moon-clear-${mi}">Clear Sponsor</button>
        </div>
      </div>
    `;

    // Wire up file input
    const fileInput = document.getElementById(`moon-pattern-${mi}`);
    const previewEl = document.getElementById(`moon-pattern-preview-${mi}`);
    const adjGroup = document.getElementById(`moon-adj-${mi}`);

    // Store pattern data on the slot
    slot._patternData = s.patternImage || null;

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        slot._patternData = ev.target.result;
        previewEl.innerHTML = `<img src="${ev.target.result}" alt="Pattern" />`;
        adjGroup.style.display = "block";
      };
      reader.readAsDataURL(file);
    });

    // Wire up slider value displays
    this._wireSlider(`moon-scale-${mi}`, `moon-scale-val-${mi}`, "x");
    this._wireSlider(`moon-sat-${mi}`, `moon-sat-val-${mi}`);
    this._wireSlider(`moon-inblack-${mi}`, `moon-inblack-val-${mi}`);
    this._wireSlider(`moon-gamma-${mi}`, `moon-gamma-val-${mi}`);
    this._wireSlider(`moon-inwhite-${mi}`, `moon-inwhite-val-${mi}`);
    this._wireSlider(`moon-outblack-${mi}`, `moon-outblack-val-${mi}`);
    this._wireSlider(`moon-outwhite-${mi}`, `moon-outwhite-val-${mi}`);

    // Wire up save button
    document.getElementById(`moon-save-${mi}`).addEventListener("click", () => {
      this._saveMoon(mi);
    });

    // Wire up clear button
    document.getElementById(`moon-clear-${mi}`).addEventListener("click", () => {
      this._clearMoon(mi);
    });
  }

  _wireSlider(sliderId, valueId, suffix) {
    const slider = document.getElementById(sliderId);
    const valueEl = document.getElementById(valueId);
    if (!slider || !valueEl) return;
    slider.addEventListener("input", () => {
      valueEl.textContent = slider.value + (suffix || "");
    });
  }

  async _saveMoon(moonIndex) {
    const mi = moonIndex;
    const slot = this.slots[mi];

    const name = document.getElementById(`moon-name-${mi}`).value.trim();
    if (!name) {
      this._toast("Name is required", "error");
      return;
    }

    const body = {
      name,
      tagline: document.getElementById(`moon-tagline-${mi}`).value.trim(),
      websiteUrl: document.getElementById(`moon-website-${mi}`).value.trim(),
      patternImage: slot._patternData || null,
      patternAdjustment: {
        scale: parseFloat(document.getElementById(`moon-scale-${mi}`).value) || 1,
        offsetX: 0,
        offsetY: 0,
        saturation: parseFloat(document.getElementById(`moon-sat-${mi}`).value) || 1,
        inputBlack: parseInt(document.getElementById(`moon-inblack-${mi}`).value, 10) || 0,
        inputGamma: parseFloat(document.getElementById(`moon-gamma-${mi}`).value) || 1,
        inputWhite: parseInt(document.getElementById(`moon-inwhite-${mi}`).value, 10) || 255,
        outputBlack: parseInt(document.getElementById(`moon-outblack-${mi}`).value, 10) || 0,
        outputWhite: parseInt(document.getElementById(`moon-outwhite-${mi}`).value, 10) || 255,
      },
    };

    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors/" + mi, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error((err.errors || ["Failed to save"]).join(". "));
      }
      const saved = await res.json();
      slot.sponsor = saved;
      this._updateSlotDisplay(mi);
      this._toast(`Moon ${mi + 1} sponsor saved`, "success");
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  async _clearMoon(moonIndex) {
    if (!confirm(`Clear sponsor from Moon ${moonIndex + 1}?`)) return;

    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors/" + moonIndex, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error("Failed to clear moon sponsor");
      }
      this.slots[moonIndex].sponsor = null;
      this.slots[moonIndex]._patternData = null;
      this._updateSlotDisplay(moonIndex);
      this._collapseSlot(moonIndex);
      this.expandedMoon = null;
      this._toast(`Moon ${moonIndex + 1} sponsor cleared`, "success");
    } catch (e) {
      this._toast(e.message, "error");
    }
  }

  _toast(message, type) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  _esc(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
