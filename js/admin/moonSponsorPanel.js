/**
 * AdLands - Moon Sponsor Panel (Inline Form)
 * Renders inside the hex selector panel when a moon is clicked.
 * Each of the 3 moons can be assigned to one sponsor with a pattern texture.
 */

class MoonSponsorPanel {
  constructor(options = {}) {
    this.container = document.getElementById("moon-sponsor-form-container");
    this.apiBase = "";
    this.activeMoon = null; // which moon index is being edited (or null)
    this._patternData = null;
    this.sponsors = [null, null, null]; // cached sponsor data per moon
    this.hexSelector = options.hexSelector || null;
    this.moonLabels = ["Moon 1 (Large)", "Moon 2 (Small)", "Moon 3 (Medium)"];
  }

  async init() {
    const loc = window.location;
    this.apiBase = loc.protocol + "//" + loc.host;

    // Load all moon sponsor data from server
    await this._loadAll();

    // Push sponsor data to hex selector so moons show correct colors
    if (this.hexSelector) {
      for (let i = 0; i < 3; i++) {
        this.hexSelector.setMoonSponsorData(i, this.sponsors[i]);
      }
    }
  }

  async _loadAll() {
    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors");
      if (!res.ok) throw new Error("Failed to load moon sponsors");
      const data = await res.json();
      data.forEach((sponsor, i) => {
        if (i < 3) this.sponsors[i] = sponsor;
      });
    } catch (e) {
      console.warn("[MoonSponsorPanel] Could not load:", e.message);
    }
  }

  /**
   * Called when a moon is clicked in the hex selector
   * @param {number} moonIndex
   */
  async showForm(moonIndex) {
    if (!this.container) return;

    this.activeMoon = moonIndex;

    // Fetch full data (including base64 pattern) for editing
    try {
      const res = await fetch(this.apiBase + "/api/moon-sponsors/" + moonIndex + "?full=1");
      if (res.ok) {
        const full = await res.json();
        this.sponsors[moonIndex] = full;
      }
    } catch (e) {
      // Use cached lite data
    }

    this._patternData = this.sponsors[moonIndex]?.patternImage || null;
    this._buildForm();
    this.container.style.display = "block";
  }

  /**
   * Hide the form
   */
  hideForm() {
    if (!this.container) return;
    this.container.style.display = "none";
    this.container.innerHTML = "";
    this.activeMoon = null;
    this._patternData = null;
  }

  _buildForm() {
    const mi = this.activeMoon;
    const s = this.sponsors[mi] || {};
    const label = this.moonLabels[mi] || `Moon ${mi + 1}`;

    this.container.innerHTML = `
      <div class="moon-inline-form">
        <div class="moon-inline-header">
          <span class="moon-inline-title">${this._esc(label)}</span>
          <span class="moon-inline-status ${s.name ? "sponsored" : ""}">${s.name ? this._esc(s.name) : "Unsponsored"}</span>
          <button class="close-btn moon-inline-close" title="Close">&times;</button>
        </div>
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
      </div>
    `;

    // Wire close button
    this.container.querySelector(".moon-inline-close").addEventListener("click", () => {
      this.hideForm();
      if (this.hexSelector) this.hexSelector._deselectMoon();
    });

    // Wire file input
    const fileInput = document.getElementById(`moon-pattern-${mi}`);
    const previewEl = document.getElementById(`moon-pattern-preview-${mi}`);
    const adjGroup = document.getElementById(`moon-adj-${mi}`);

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._patternData = ev.target.result;
        previewEl.innerHTML = `<img src="${ev.target.result}" alt="Pattern" />`;
        adjGroup.style.display = "block";
      };
      reader.readAsDataURL(file);
    });

    // Wire sliders
    this._wireSlider(`moon-scale-${mi}`, `moon-scale-val-${mi}`, "x");
    this._wireSlider(`moon-sat-${mi}`, `moon-sat-val-${mi}`);
    this._wireSlider(`moon-inblack-${mi}`, `moon-inblack-val-${mi}`);
    this._wireSlider(`moon-gamma-${mi}`, `moon-gamma-val-${mi}`);
    this._wireSlider(`moon-inwhite-${mi}`, `moon-inwhite-val-${mi}`);
    this._wireSlider(`moon-outblack-${mi}`, `moon-outblack-val-${mi}`);
    this._wireSlider(`moon-outwhite-${mi}`, `moon-outwhite-val-${mi}`);

    // Wire save
    document.getElementById(`moon-save-${mi}`).addEventListener("click", () => {
      this._saveMoon(mi);
    });

    // Wire clear
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
    const name = document.getElementById(`moon-name-${mi}`).value.trim();
    if (!name) {
      this._toast("Name is required", "error");
      return;
    }

    const body = {
      name,
      tagline: document.getElementById(`moon-tagline-${mi}`).value.trim(),
      websiteUrl: document.getElementById(`moon-website-${mi}`).value.trim(),
      patternImage: this._patternData || null,
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
      this.sponsors[mi] = saved;

      // Update hex selector moon visual
      if (this.hexSelector) {
        this.hexSelector.setMoonSponsorData(mi, saved);
      }

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
      this.sponsors[moonIndex] = null;
      this._patternData = null;

      // Update hex selector moon visual
      if (this.hexSelector) {
        this.hexSelector.setMoonSponsorData(moonIndex, null);
      }

      this.hideForm();
      if (this.hexSelector) this.hexSelector._deselectMoon();
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
