/**
 * AdLands - Settings Manager
 * Handles settings persistence and application to game systems
 */

class SettingsManager {
  constructor() {
    // Default settings
    this.defaults = {
      graphics: {
        resolutionScale: 1.0,
        quality: "medium",
        fpsCap: 60,
        particleDensity: 0.8,
        shadows: true,
        lensDirt: true,
        lensDirtIntensity: 1.0,
        vignette: true,
        vignetteIntensity: 0.5,
        chromatic: true,
        chromaticIntensity: 0.003,
        damageEffects: true,
        damageScanlines: true,
        damageNoise: true,
        damageGlitch: true,
        damageSignalLoss: true,
      },
      audio: {
        master: 0.8,
        sfx: 0.8,
        music: 0.5,
        uiSounds: true,
      },
      controls: {
        keybinds: {
          moveForward: "KeyW",
          moveBack: "KeyS",
          moveLeft: "KeyA",
          moveRight: "KeyD",
          fire: "Mouse0",
          ability1: "Digit1",
          ability2: "Digit2",
          ability3: "Digit3",
          dashboard: "KeyH",
          chat: "Enter",
          ping: "KeyG",
        },
        mouseSensitivity: 0.5,
        invertY: false,
      },
      gameplay: {
        showDamageNumbers: true,
        showCryptoPopups: true,
        minimapScale: 1.0,
        chatFilter: true,
        colorblindMode: "off",
        tuskCommentary: "full", // 'full' | 'important' | 'off'
      },
      privacy: {
        profileVisibility: "public", // 'public' | 'faction' | 'friends'
      },
      testing: {
        commanderOverride: false, // Force human player to be commander (for testing)
      },
    };

    // Current settings (deep clone of defaults)
    this.settings = JSON.parse(JSON.stringify(this.defaults));

    // External system references (set by main.js)
    this.renderer = null;
    this.tuskCommentary = null;
    this.cryptoVisuals = null;
    this.cannonSystem = null;
    this.dustShockwave = null;
    this.treadDust = null;
    this.environment = null;
    this.gameCamera = null;

    // Change callbacks
    this.changeCallbacks = new Map();

    this._loadSettings();
  }

  // ========================
  // PERSISTENCE
  // ========================

  _loadSettings() {
    try {
      const saved = localStorage.getItem("adlands_settings");
      if (saved) {
        const data = JSON.parse(saved);
        // Deep merge with defaults to handle new settings added in updates
        this.settings = this._deepMerge(this.defaults, data);
      }
    } catch (e) {
      console.warn("[SettingsManager] Failed to load settings:", e);
    }
  }

  _saveSettings() {
    try {
      localStorage.setItem("adlands_settings", JSON.stringify(this.settings));
    } catch (e) {
      console.warn("[SettingsManager] Failed to save settings:", e);
    }
  }

  _deepMerge(target, source) {
    const output = { ...target };
    for (const key in source) {
      if (
        source[key] &&
        typeof source[key] === "object" &&
        !Array.isArray(source[key])
      ) {
        output[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  // ========================
  // GETTERS/SETTERS
  // ========================

  /**
   * Get a setting value by path (e.g., 'graphics.shadows')
   */
  get(path) {
    const parts = path.split(".");
    let value = this.settings;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }

  /**
   * Set a setting value by path (e.g., 'graphics.shadows', false)
   */
  set(path, value) {
    const parts = path.split(".");
    let obj = this.settings;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]];
    }
    const oldValue = obj[parts[parts.length - 1]];
    obj[parts[parts.length - 1]] = value;

    this._saveSettings();
    this._applySettingChange(path, value, oldValue);
    this._notifyChange(path, value, oldValue);
  }

  /**
   * Get all settings
   */
  getAll() {
    return JSON.parse(JSON.stringify(this.settings));
  }

  // ========================
  // APPLY SETTINGS TO SYSTEMS
  // ========================

  _applySettingChange(path, value, oldValue) {
    switch (path) {
      // Graphics
      case "graphics.resolutionScale":
        this._applyResolutionScale(value);
        break;
      case "graphics.quality":
        this._applyQualityPreset(value);
        break;
      case "graphics.particleDensity":
        this._applyParticleDensity(value);
        break;
      case "graphics.shadows":
        this._applyShadows(value);
        break;
      case "graphics.fpsCap":
        // FPS cap would require frame limiting in animation loop
        // Currently not implemented - placeholder for future
        break;
      case "graphics.lensDirt":
        if (this.visualEffects) {
          this.visualEffects.setLensDirtEnabled(value);
        }
        break;
      case "graphics.lensDirtIntensity":
        if (this.visualEffects) {
          this.visualEffects.setLensDirtIntensity(value);
        }
        break;
      case "graphics.vignette":
        if (this.visualEffects) {
          this.visualEffects.setVignetteEnabled(value);
        }
        break;
      case "graphics.vignetteIntensity":
        if (this.visualEffects) {
          this.visualEffects.setVignetteIntensity(value);
        }
        break;
      case "graphics.chromatic":
        if (this.visualEffects) {
          this.visualEffects.setChromaticEnabled(value);
        }
        break;
      case "graphics.chromaticIntensity":
        if (this.visualEffects) {
          this.visualEffects.setChromaticIntensity(value);
        }
        break;
      case "graphics.damageEffects":
        if (this.visualEffects) {
          this.visualEffects.setDamageEffectsEnabled(value);
        }
        break;
      case "graphics.damageScanlines":
        if (this.visualEffects) {
          this.visualEffects.setDamageScanlinesEnabled(value);
        }
        break;
      case "graphics.damageNoise":
        if (this.visualEffects) {
          this.visualEffects.setDamageNoiseEnabled(value);
        }
        break;
      case "graphics.damageGlitch":
        if (this.visualEffects) {
          this.visualEffects.setDamageGlitchEnabled(value);
        }
        break;
      case "graphics.damageSignalLoss":
        if (this.visualEffects) {
          this.visualEffects.setDamageSignalLossEnabled(value);
        }
        break;

      // Audio (placeholder - no audio system yet)
      case "audio.master":
      case "audio.sfx":
      case "audio.music":
      case "audio.uiSounds":
        // TODO: Implement when audio system is added
        break;

      // Controls
      case "controls.mouseSensitivity":
        if (this.gameCamera) {
          this.gameCamera.sensitivity = value;
        }
        break;
      case "controls.invertY":
        if (this.gameCamera) {
          this.gameCamera.invertY = value;
        }
        break;
      // Gameplay
      case "gameplay.showDamageNumbers":
        if (this.cannonSystem) {
          this.cannonSystem.showDamageNumbers = value;
        }
        break;
      case "gameplay.showCryptoPopups":
        if (this.cryptoVisuals) {
          this.cryptoVisuals.enabled = value;
        }
        break;
      case "gameplay.tuskCommentary":
        this._applyTuskCommentary(value, oldValue);
        break;
      case "gameplay.colorblindMode":
        this._applyColorblindMode(value);
        break;
      case "gameplay.chatFilter":
        // Chat filter is read directly from settings when needed
        break;
      case "gameplay.minimapScale":
        // Minimap not yet implemented
        break;

      // Privacy
      case "privacy.profileVisibility":
        // Privacy settings are read when needed, no immediate application
        break;

      // Testing/Developer
      case "testing.commanderOverride":
        if (window.commanderSystem) {
          window.commanderSystem.setCommanderOverride(value);
        }
        break;
    }
  }

  _applyResolutionScale(scale) {
    if (this.renderer) {
      const basePixelRatio = window.devicePixelRatio || 1;
      this.renderer.setPixelRatio(basePixelRatio * scale);
      // Need to resize to apply new pixel ratio
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
  }

  _applyQualityPreset(quality) {
    const presets = {
      low: {
        shadows: false,
        particles: 0.3,
        lensDirt: false,
        vignette: true,
        chromatic: false,
        damageEffects: false,
      },
      medium: {
        shadows: true,
        particles: 0.7,
        lensDirt: true,
        vignette: true,
        chromatic: true,
        damageEffects: true,
      },
      high: {
        shadows: true,
        particles: 1.0,
        lensDirt: true,
        vignette: true,
        chromatic: true,
        damageEffects: true,
      },
    };

    const preset = presets[quality] || presets.medium;

    // Apply preset values (update internal state too)
    this.settings.graphics.shadows = preset.shadows;
    this.settings.graphics.particleDensity = preset.particles;
    this.settings.graphics.lensDirt = preset.lensDirt;
    this.settings.graphics.vignette = preset.vignette;
    this.settings.graphics.chromatic = preset.chromatic;
    this.settings.graphics.damageEffects = preset.damageEffects;

    this._applyShadows(preset.shadows);
    this._applyParticleDensity(preset.particles);
    if (this.visualEffects) {
      this.visualEffects.setLensDirtEnabled(preset.lensDirt);
      this.visualEffects.setVignetteEnabled(preset.vignette);
      this.visualEffects.setChromaticEnabled(preset.chromatic);
      this.visualEffects.setDamageEffectsEnabled(preset.damageEffects);
    }
  }

  _applyParticleDensity(density) {
    // Apply to particle systems
    if (this.dustShockwave) {
      this.dustShockwave.particleDensity = density;
    }
    if (this.treadDust) {
      this.treadDust.particleDensity = density;
    }
    if (this.cannonSystem) {
      this.cannonSystem.particleDensity = density;
    }
  }

  _applyShadows(enabled) {
    if (this.renderer) {
      this.renderer.shadowMap.enabled = enabled;
      // Mark all materials as needing update
      if (this.renderer.shadowMap.needsUpdate !== undefined) {
        this.renderer.shadowMap.needsUpdate = true;
      }
    }
    if (this.environment && this.environment.setShadowsEnabled) {
      this.environment.setShadowsEnabled(enabled);
    }
  }

  _applyTuskCommentary(mode, oldMode) {
    if (this.tuskCommentary) {
      this.tuskCommentary.setCommentaryMode(mode);

      // Special messages when changing Tusk setting
      if (oldMode !== undefined && oldMode !== mode) {
        if (mode === "off") {
          this.tuskCommentary._showImmediate(
            "Your feedback has been noted, contractor. " +
              "Corporate communications suspended. " +
              "Productivity metrics will continue to be monitored in silence.",
          );
        } else if (oldMode === "off") {
          this.tuskCommentary._showImmediate(
            "Welcome back to the AdLands family! Your engagement is valued.",
          );
        }
      }
    }
  }

  _applyColorblindMode(mode) {
    // Remove any existing colorblind classes
    document.body.classList.remove(
      "colorblind-deuteranopia",
      "colorblind-protanopia",
      "colorblind-tritanopia",
    );
    // Add new class if not 'off'
    if (mode !== "off") {
      document.body.classList.add(`colorblind-${mode}`);
    }
  }

  // ========================
  // APPLY ALL SETTINGS
  // ========================

  /**
   * Apply all current settings to their respective systems
   * Call this after all system references are set
   */
  applyAll() {
    // Graphics
    this._applyResolutionScale(this.settings.graphics.resolutionScale);
    this._applyShadows(this.settings.graphics.shadows);
    this._applyParticleDensity(this.settings.graphics.particleDensity);
    if (this.visualEffects) {
      this.visualEffects.setLensDirtEnabled(this.settings.graphics.lensDirt);
      this.visualEffects.setLensDirtIntensity(
        this.settings.graphics.lensDirtIntensity,
      );
      this.visualEffects.setVignetteEnabled(this.settings.graphics.vignette);
      this.visualEffects.setVignetteIntensity(
        this.settings.graphics.vignetteIntensity,
      );
      this.visualEffects.setChromaticEnabled(this.settings.graphics.chromatic);
      this.visualEffects.setChromaticIntensity(
        this.settings.graphics.chromaticIntensity,
      );
      this.visualEffects.setDamageEffectsEnabled(
        this.settings.graphics.damageEffects,
      );
      this.visualEffects.setDamageScanlinesEnabled(
        this.settings.graphics.damageScanlines,
      );
      this.visualEffects.setDamageNoiseEnabled(
        this.settings.graphics.damageNoise,
      );
      this.visualEffects.setDamageGlitchEnabled(
        this.settings.graphics.damageGlitch,
      );
      this.visualEffects.setDamageSignalLossEnabled(
        this.settings.graphics.damageSignalLoss,
      );
    }

    // Gameplay
    this._applyTuskCommentary(this.settings.gameplay.tuskCommentary, undefined);
    this._applyColorblindMode(this.settings.gameplay.colorblindMode);

    if (this.cannonSystem) {
      this.cannonSystem.showDamageNumbers =
        this.settings.gameplay.showDamageNumbers;
    }
    if (this.cryptoVisuals) {
      this.cryptoVisuals.enabled = this.settings.gameplay.showCryptoPopups;
    }

    // Controls
    if (this.gameCamera) {
      this.gameCamera.sensitivity = this.settings.controls.mouseSensitivity;
      this.gameCamera.invertY = this.settings.controls.invertY;
    }

    // Testing/Developer - Commander Override
    if (window.commanderSystem && this.settings.testing.commanderOverride) {
      window.commanderSystem.setCommanderOverride(true);
    }
  }

  // ========================
  // CHANGE CALLBACKS
  // ========================

  /**
   * Register a callback for when a setting changes
   */
  onChange(path, callback) {
    if (!this.changeCallbacks.has(path)) {
      this.changeCallbacks.set(path, []);
    }
    this.changeCallbacks.get(path).push(callback);
  }

  _notifyChange(path, value, oldValue) {
    const callbacks = this.changeCallbacks.get(path);
    if (callbacks) {
      callbacks.forEach((cb) => cb(value, oldValue));
    }
  }

  // ========================
  // UI BINDING
  // ========================

  /**
   * Bind settings UI elements to their settings
   * Call this after the Dashboard UI is created
   */
  bindToUI() {
    // Sliders with value display
    this._bindSlider(
      "setting-master-volume",
      "audio.master",
      (v) => Math.round(v * 100) + "%",
    );
    this._bindSlider(
      "setting-sfx-volume",
      "audio.sfx",
      (v) => Math.round(v * 100) + "%",
    );
    this._bindSlider(
      "setting-music-volume",
      "audio.music",
      (v) => Math.round(v * 100) + "%",
    );
    this._bindSlider(
      "setting-mouse-sensitivity",
      "controls.mouseSensitivity",
      (v) => v.toFixed(2),
    );

    // Dropdowns
    this._bindSelect("setting-colorblind", "gameplay.colorblindMode");
    this._bindSelect("setting-tusk-commentary", "gameplay.tuskCommentary");
    this._bindSelect("setting-profile-visibility", "privacy.profileVisibility");

    // Toggles
    this._bindToggle("setting-shadows", "graphics.shadows");
    this._bindToggle("setting-lens-dirt", "graphics.lensDirt");
    this._bindToggle("setting-vignette", "graphics.vignette");
    this._bindToggle("setting-chromatic", "graphics.chromatic");
    this._bindToggle("setting-damage-effects", "graphics.damageEffects");
    this._bindToggle("setting-damage-scanlines", "graphics.damageScanlines");
    this._bindToggle("setting-damage-noise", "graphics.damageNoise");
    this._bindToggle("setting-damage-glitch", "graphics.damageGlitch");
    this._bindToggle("setting-damage-signal-loss", "graphics.damageSignalLoss");
    this._bindToggle("setting-ui-sounds", "audio.uiSounds");
    this._bindToggle("setting-crypto-popups", "gameplay.showCryptoPopups");
    this._bindToggle("setting-invert-y", "controls.invertY");
    // Note: Commander override is now handled by a button in dashboard, not a setting toggle
  }

  _bindSlider(elementId, settingPath, formatter) {
    const slider = document.getElementById(elementId);
    const valueEl = document.getElementById(
      "val-" + elementId.replace("setting-", ""),
    );

    if (!slider) return;

    // Set initial value
    const value = this.get(settingPath);
    slider.value = value;
    if (valueEl && formatter) {
      valueEl.textContent = formatter(value);
    }

    // Bind change
    slider.addEventListener("input", () => {
      const newValue = parseFloat(slider.value);
      this.set(settingPath, newValue);
      if (valueEl && formatter) {
        valueEl.textContent = formatter(newValue);
      }
    });
  }

  _bindSelect(elementId, settingPath) {
    const select = document.getElementById(elementId);
    if (!select) return;

    // Set initial value
    const value = this.get(settingPath);
    select.value = value;

    // Bind change
    select.addEventListener("change", () => {
      let newValue = select.value;
      // Convert numeric strings to numbers
      if (!isNaN(newValue) && newValue !== "") {
        newValue = parseFloat(newValue);
      }
      this.set(settingPath, newValue);
    });
  }

  _bindToggle(elementId, settingPath) {
    const toggle = document.getElementById(elementId);
    if (!toggle) return;

    // Set initial value
    toggle.checked = this.get(settingPath);

    // Bind change
    toggle.addEventListener("change", () => {
      this.set(settingPath, toggle.checked);
    });
  }

  // ========================
  // RESET
  // ========================

  /**
   * Reset a specific settings section to defaults
   */
  resetSection(section) {
    if (this.defaults[section]) {
      this.settings[section] = JSON.parse(
        JSON.stringify(this.defaults[section]),
      );
      this._saveSettings();
      this.applyAll();
      // Re-bind UI to reflect reset values
      this.bindToUI();
    }
  }

  /**
   * Reset all settings to defaults
   */
  resetAll() {
    this.settings = JSON.parse(JSON.stringify(this.defaults));
    this._saveSettings();
    this.applyAll();
    // Re-bind UI to reflect reset values
    this.bindToUI();
  }
}
