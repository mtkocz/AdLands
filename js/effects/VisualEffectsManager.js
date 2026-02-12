/**
 * AdLands - Visual Effects Manager
 * Coordinates post-processing effects and camera effects.
 *
 * Phase 1: Lens Dirt
 * Phase 2: Vignette (cinematic base + damage/heal overlay)
 * Phase 3: Chromatic Aberration (cinematic base + damage spikes)
 * Phase 4: Damage Effects (scanlines, noise, glitch, signal loss)
 * Future phases: Camera Effects
 *
 * Dependencies: THREE.js
 */

class VisualEffectsManager {
  constructor() {
    // Post-processing pass references (set by main.js during init)
    this.lensDirtPass = null;
    this.damageEffectsPass = null;
    this.vignettePass = null;
    this.chromaticPass = null;

    // Vignette overlay state
    this.overlayTargetIntensity = 0;
    this.overlayTargetColor = new THREE.Color(0x000000);
    this.healPulseTime = 0;
    this.isBeingHealed = false;
    this.currentHealthPercent = 1.0;

    // Chromatic aberration damage state
    this.damageChromaticIntensity = 0;

    // Damage effects state
    this.damageTime = 0;
    this.signalLossTimeouts = [];
    this.factionColor = new THREE.Color(0x000000);
    this.signalLostOverlay = document.getElementById("signal-lost-overlay");
    this.onSignalLostComplete = null; // callback when progress bar finishes
    this.hudVisible = true; // tracks HUD toggle state (H key)

    // Configuration defaults
    this.config = {
      lensDirt: {
        enabled: true,
        intensity: 1.0,
        bloomThreshold: 0.005,
        dirtMinLevel: 0.15,
        bloomSpread: 8.0,
      },
      vignette: {
        enabled: true,
        baseIntensity: 0.5,
        damageVignetteEnabled: true,
        healVignetteEnabled: true,
      },
      chromatic: {
        enabled: true,
        baseIntensity: 0.003,
        falloff: 0.6,
        damageEnabled: true,
      },
      damageEffects: {
        enabled: true,
        scanlines: true,
        noise: true,
        glitch: true,
        signalLoss: true,
      },
    };
  }

  // ========================
  // PASS SETUP (called by main.js)
  // ========================

  setLensDirtPass(pass) {
    this.lensDirtPass = pass;
    this._applyLensDirtConfig();
  }

  setVignettePass(pass) {
    this.vignettePass = pass;
    this._applyVignetteConfig();
  }

  setChromaticPass(pass) {
    this.chromaticPass = pass;
    this._applyChromaticConfig();
  }

  setDamageEffectsPass(pass) {
    this.damageEffectsPass = pass;
    this._applyDamageEffectsConfig();
  }

  setFactionColor(hex) {
    this.factionColor.setHex(hex);
  }

  // ========================
  // SETTINGS API — Lens Dirt
  // ========================

  setLensDirtEnabled(enabled) {
    this.config.lensDirt.enabled = enabled;
    if (this.lensDirtPass) {
      this.lensDirtPass.enabled = enabled;
    }
  }

  setLensDirtIntensity(intensity) {
    this.config.lensDirt.intensity = intensity;
    if (this.lensDirtPass) {
      this.lensDirtPass.uniforms.intensity.value = intensity;
    }
  }

  setLensDirtMinLevel(level) {
    this.config.lensDirt.dirtMinLevel = level;
    if (this.lensDirtPass) {
      this.lensDirtPass.uniforms.dirtMinLevel.value = level;
    }
  }

  setLensDirtBloomSpread(spread) {
    this.config.lensDirt.bloomSpread = spread;
    if (this.lensDirtPass) {
      this.lensDirtPass.uniforms.bloomSpread.value = spread;
    }
  }

  // ========================
  // SETTINGS API — Vignette
  // ========================

  setVignetteEnabled(enabled) {
    this.config.vignette.enabled = enabled;
    if (this.vignettePass) {
      this.vignettePass.enabled = enabled;
    }
  }

  setVignetteIntensity(intensity) {
    this.config.vignette.baseIntensity = intensity;
    if (this.vignettePass) {
      this.vignettePass.uniforms.baseIntensity.value = intensity;
    }
  }

  // ========================
  // SETTINGS API — Chromatic Aberration
  // ========================

  setChromaticEnabled(enabled) {
    this.config.chromatic.enabled = enabled;
    if (this.chromaticPass) {
      this.chromaticPass.enabled = enabled;
    }
  }

  setChromaticIntensity(intensity) {
    this.config.chromatic.baseIntensity = intensity;
    if (this.chromaticPass) {
      this.chromaticPass.uniforms.intensity.value = intensity;
    }
  }

  // ========================
  // SETTINGS API — Damage Effects
  // ========================

  setDamageEffectsEnabled(enabled) {
    this.config.damageEffects.enabled = enabled;
    if (this.damageEffectsPass) {
      this.damageEffectsPass.enabled = enabled;
    }
  }

  setDamageScanlinesEnabled(enabled) {
    this.config.damageEffects.scanlines = enabled;
    if (!enabled && this.damageEffectsPass) {
      this.damageEffectsPass.uniforms.scanlineIntensity.value = 0;
    }
  }

  setDamageNoiseEnabled(enabled) {
    this.config.damageEffects.noise = enabled;
    if (!enabled && this.damageEffectsPass) {
      this.damageEffectsPass.uniforms.noiseIntensity.value = 0;
    }
  }

  setDamageGlitchEnabled(enabled) {
    this.config.damageEffects.glitch = enabled;
    if (!enabled && this.damageEffectsPass) {
      this.damageEffectsPass.uniforms.glitchIntensity.value = 0;
    }
  }

  setDamageSignalLossEnabled(enabled) {
    this.config.damageEffects.signalLoss = enabled;
    if (!enabled && this.damageEffectsPass) {
      this.damageEffectsPass.uniforms.signalLoss.value = 0;
    }
  }

  // ========================
  // GAME EVENT API (called from main.js callbacks)
  // ========================

  triggerDamageFlash(amount, maxHp) {
    // Scale impact severity: 0-1 based on damage relative to max HP
    // A hit dealing 50%+ of max HP is a "hard impact" (severity 1.0)
    const severity =
      amount && maxHp ? Math.min(amount / (maxHp * 0.5), 1.0) : 0.3;

    // Vignette red flash (scales with severity)
    if (this.vignettePass && this.config.vignette.damageVignetteEnabled) {
      this.vignettePass.uniforms.overlayIntensity.value = 0.3 + severity * 0.4;
      this.vignettePass.uniforms.overlayColor.value.set(0x330000);
    }
    // Chromatic aberration spike (scales with severity)
    if (this.config.chromatic.damageEnabled) {
      this.damageChromaticIntensity = 0.01 + severity * 0.02;
    }
    // Damage effects: noise + glitch spike (scales with severity)
    if (this.damageEffectsPass && this.config.damageEffects.enabled) {
      if (this.config.damageEffects.noise) {
        this.damageEffectsPass.uniforms.noiseIntensity.value =
          0.1 + severity * 0.3;
      }
      if (this.config.damageEffects.glitch) {
        this.damageEffectsPass.uniforms.glitchIntensity.value =
          0.15 + severity * 0.65;
      }
    }
  }

  onNearbyExplosion(intensity) {
    // Nearby explosion (not a direct hit) — lighter noise/glitch scaled by proximity
    if (this.damageEffectsPass && this.config.damageEffects.enabled) {
      const u = this.damageEffectsPass.uniforms;
      if (this.config.damageEffects.noise) {
        u.noiseIntensity.value = Math.max(
          u.noiseIntensity.value,
          intensity * 0.15,
        );
      }
      if (this.config.damageEffects.glitch) {
        u.glitchIntensity.value = Math.max(
          u.glitchIntensity.value,
          intensity * 0.25,
        );
      }
    }
    // Lighter chromatic spike from nearby blast
    if (this.config.chromatic.damageEnabled) {
      this.damageChromaticIntensity = Math.max(
        this.damageChromaticIntensity,
        intensity * 0.01,
      );
    }
  }

  setHealth(hp, maxHp) {
    this.currentHealthPercent = hp / maxHp;
    if (
      this.config.vignette.damageVignetteEnabled &&
      this.currentHealthPercent < 0.3
    ) {
      this.overlayTargetIntensity = 0.3;
      this.overlayTargetColor.set(0x220000);
    } else {
      this.overlayTargetIntensity = 0;
      this.overlayTargetColor.set(0x000000);
    }
    // Sustained scanlines at low HP
    if (
      this.damageEffectsPass &&
      this.config.damageEffects.enabled &&
      this.config.damageEffects.scanlines &&
      this.currentHealthPercent < 0.4
    ) {
      const severity = (0.4 - this.currentHealthPercent) / 0.4;
      this.damageEffectsPass.uniforms.scanlineIntensity.value = severity * 0.3;
    }
  }

  onDeath() {
    // Hide UI elements immediately (before signal loss flicker completes)
    this._hideUIElements();

    // Vignette death overlay
    if (this.vignettePass && this.config.vignette.damageVignetteEnabled) {
      this.vignettePass.uniforms.overlayIntensity.value = 0.6;
      this.vignettePass.uniforms.overlayColor.value.set(0x330000);
      this.overlayTargetIntensity = 0.6;
      this.overlayTargetColor.set(0x330000);
    }
    // Chromatic aberration max spike
    if (this.config.chromatic.damageEnabled) {
      this.damageChromaticIntensity = 0.03;
    }
    // Damage effects: max out all sub-effects + signal loss sequence
    if (this.damageEffectsPass && this.config.damageEffects.enabled) {
      const u = this.damageEffectsPass.uniforms;
      if (this.config.damageEffects.scanlines) u.scanlineIntensity.value = 0.8;
      if (this.config.damageEffects.noise) u.noiseIntensity.value = 0.6;
      if (this.config.damageEffects.glitch) u.glitchIntensity.value = 0.8;
      // Signal loss timeline (flickering faction-color fill over 900ms)
      if (this.config.damageEffects.signalLoss) {
        // Set faction color on the shader uniform
        u.signalLossColor.value.copy(this.factionColor);
        const timeline = [
          { time: 0, signalLoss: 0.3 },
          { time: 100, signalLoss: 0.1 },
          { time: 200, signalLoss: 0.5 },
          { time: 300, signalLoss: 0.2 },
          { time: 500, signalLoss: 0.7 },
          { time: 700, signalLoss: 0.4 },
          { time: 900, signalLoss: 1.0 },
        ];
        for (const step of timeline) {
          const id = setTimeout(() => {
            if (this.damageEffectsPass) {
              this.damageEffectsPass.uniforms.signalLoss.value =
                step.signalLoss;
            }
            // Start terminal sequence on final step
            if (step.signalLoss >= 1.0) {
              this.startSignalLostSequence();
            }
          }, step.time);
          this.signalLossTimeouts.push(id);
        }
      }
    }
  }

  onRespawn() {
    this.currentHealthPercent = 1.0;
    this.overlayTargetIntensity = 0;
    this.overlayTargetColor.set(0x000000);
    this.healPulseTime = 0;
    this.isBeingHealed = false;
    this.damageChromaticIntensity = 0;
    if (this.vignettePass) {
      this.vignettePass.uniforms.overlayIntensity.value = 0;
      this.vignettePass.uniforms.overlayColor.value.set(0x000000);
    }
    // Reset all damage effects and clear signal loss timeouts
    for (const id of this.signalLossTimeouts) {
      clearTimeout(id);
    }
    this.signalLossTimeouts = [];
    if (this.damageEffectsPass) {
      const u = this.damageEffectsPass.uniforms;
      u.scanlineIntensity.value = 0;
      u.noiseIntensity.value = 0;
      u.glitchIntensity.value = 0;
      u.signalLoss.value = 0;
    }
    // Hide overlay and reset terminal text/progress
    this._removeTerminalEffectLayers();
    if (this.signalLostOverlay) {
      this.signalLostOverlay.style.display = "none";
      // Move cursor back to terminal container before wiping lines
      // (textContent = "" destroys all children, including the cursor if inside)
      const terminal = document.getElementById("signal-lost-terminal");
      const cursor = document.getElementById("signal-lost-cursor");
      if (terminal && cursor) terminal.appendChild(cursor);
      const lineOs = document.getElementById("term-line-os");
      const lineSignal = document.getElementById("term-line-signal");
      const lineCloning = document.getElementById("term-line-cloning");
      const lineStandby = document.getElementById("term-line-standby");
      const lineComplete = document.getElementById("term-line-complete");
      const lineBar = document.getElementById("term-line-bar");
      const progressFill = document.getElementById("term-progress-fill");
      if (lineOs) lineOs.textContent = "";
      if (lineSignal) lineSignal.textContent = "";
      if (lineCloning) lineCloning.textContent = "";
      if (lineStandby) lineStandby.textContent = "";
      if (lineComplete) lineComplete.textContent = "";
      if (lineBar) lineBar.style.visibility = "hidden";
      if (progressFill) progressFill.style.width = "0%";
    }
  }

  startHealing() {
    this.isBeingHealed = true;
  }

  stopHealing() {
    this.isBeingHealed = false;
    this.healPulseTime = 0;
  }

  // ========================
  // SIGNAL LOST TERMINAL SEQUENCE
  // ========================

  startSignalLostSequence() {
    if (!this.signalLostOverlay) return;

    // Show the overlay (transparent — real shader effects visible beneath)
    this.signalLostOverlay.style.display = "";

    // Create effect layers (vignette + animated noise) on top of terminal text
    this._createTerminalEffectLayers();

    // Hide UI elements that would show through transparent overlay
    this._hideUIElements();

    // Get DOM elements
    const lineOs = document.getElementById("term-line-os");
    const lineSignal = document.getElementById("term-line-signal");
    const lineCloning = document.getElementById("term-line-cloning");
    const lineStandby = document.getElementById("term-line-standby");
    const lineBar = document.getElementById("term-line-bar");
    const lineComplete = document.getElementById("term-line-complete");
    const progressFill = document.getElementById("term-progress-fill");
    const cursor = document.getElementById("signal-lost-cursor");

    // Move cursor back to terminal container before wiping lines
    // (textContent = "" destroys all children, including the cursor if nested inside)
    const terminal = document.getElementById("signal-lost-terminal");
    if (terminal && cursor) terminal.appendChild(cursor);

    // Reset all text and hide elements that appear later
    if (lineOs) lineOs.textContent = "";
    if (lineSignal) lineSignal.textContent = "";
    if (lineCloning) lineCloning.textContent = "";
    if (lineStandby) lineStandby.textContent = "";
    if (lineComplete) lineComplete.textContent = "";
    if (progressFill) progressFill.style.width = "0%";
    if (lineBar) lineBar.style.visibility = "hidden";

    // Helper: move cursor after a given element
    const moveCursor = (afterEl) => {
      if (!cursor || !afterEl) return;
      afterEl.appendChild(cursor);
    };

    // T+0ms: "ADLANDS OS 1.0" + cursor
    const id1 = setTimeout(() => {
      if (lineOs) lineOs.textContent = "ADLANDS OS 1.0";
      moveCursor(lineOs);
    }, 0);
    this.signalLossTimeouts.push(id1);

    // T+500ms: "SIGNAL LOST" + cursor
    const id2 = setTimeout(() => {
      if (lineSignal) lineSignal.textContent = "SIGNAL LOST";
      moveCursor(lineSignal);
    }, 500);
    this.signalLossTimeouts.push(id2);

    // T+1000ms: "INITIALIZING CLONING PROTOCOL" + cursor
    const id3 = setTimeout(() => {
      if (lineCloning)
        lineCloning.textContent = "INITIALIZING CLONING PROTOCOL";
      moveCursor(lineCloning);
    }, 1000);
    this.signalLossTimeouts.push(id3);

    // T+1500ms: "PLEASE STAND BY FOR REDEPLOYMENT" + cursor
    const id4 = setTimeout(() => {
      if (lineStandby)
        lineStandby.textContent = "PLEASE STAND BY FOR REDEPLOYMENT";
      moveCursor(lineStandby);
    }, 1500);
    this.signalLossTimeouts.push(id4);

    // T+2000ms: Show progress bar, start choppy fill over 3500ms
    const PROGRESS_DURATION = 3500;
    const PROGRESS_INTERVAL = 50;

    // Pre-generate choppy waypoints (target pct + time to reach it)
    const waypoints = this._generateChoppyWaypoints(PROGRESS_DURATION);

    const id5 = setTimeout(() => {
      if (lineBar) lineBar.style.visibility = "visible";
      moveCursor(lineBar);

      let elapsed = 0;
      let wpIndex = 0;
      let displayPct = 0;

      const intervalId = setInterval(() => {
        elapsed += PROGRESS_INTERVAL;

        // Advance through waypoints
        while (
          wpIndex < waypoints.length &&
          elapsed >= waypoints[wpIndex].time
        ) {
          wpIndex++;
        }

        // Interpolate toward current waypoint target
        const target =
          wpIndex < waypoints.length
            ? waypoints[wpIndex]
            : { pct: 1, time: PROGRESS_DURATION };
        const prevWp =
          wpIndex > 0 ? waypoints[wpIndex - 1] : { pct: 0, time: 0 };
        const wpDuration = target.time - prevWp.time;
        const wpElapsed = elapsed - prevWp.time;
        if (wpDuration > 0) {
          displayPct =
            prevWp.pct +
            (target.pct - prevWp.pct) * Math.min(wpElapsed / wpDuration, 1);
        }

        displayPct = Math.min(displayPct, 1);
        if (progressFill) progressFill.style.width = displayPct * 100 + "%";

        if (elapsed >= PROGRESS_DURATION) {
          clearInterval(intervalId);
          if (progressFill) progressFill.style.width = "100%";
          // Progress complete — show completion message then glitch away
          this._onProgressComplete(lineComplete, cursor);
        }
      }, PROGRESS_INTERVAL);
      this.signalLossTimeouts.push(intervalId);
    }, 2000);
    this.signalLossTimeouts.push(id5);
  }

  _generateChoppyWaypoints(duration) {
    // Create waypoints that simulate stuttery/choppy loading
    // Each waypoint: { pct: 0-1, time: ms }
    return [
      { pct: 0.08, time: duration * 0.04 },
      { pct: 0.15, time: duration * 0.08 },
      { pct: 0.15, time: duration * 0.14 }, // stall
      { pct: 0.3, time: duration * 0.2 },
      { pct: 0.32, time: duration * 0.28 }, // stall
      { pct: 0.45, time: duration * 0.32 },
      { pct: 0.52, time: duration * 0.38 },
      { pct: 0.52, time: duration * 0.44 }, // stall
      { pct: 0.68, time: duration * 0.5 },
      { pct: 0.72, time: duration * 0.56 },
      { pct: 0.8, time: duration * 0.62 },
      { pct: 0.8, time: duration * 0.72 }, // long stall
      { pct: 0.88, time: duration * 0.78 },
      { pct: 0.9, time: duration * 0.82 },
      { pct: 0.9, time: duration * 0.92 }, // stall near end
      { pct: 0.97, time: duration * 0.96 },
      { pct: 1.0, time: duration },
    ];
  }

  _onProgressComplete(lineComplete, cursor) {
    // T+0ms after progress: show completion message
    const id1 = setTimeout(() => {
      if (lineComplete)
        lineComplete.textContent =
          "INITIALIZATION COMPLETE. WE APPRECIATE YOUR BUSINESS";
      if (cursor && lineComplete) lineComplete.appendChild(cursor);
    }, 200);
    this.signalLossTimeouts.push(id1);

    // T+2400ms: glitch-away transition (rapid flicker)
    const id2 = setTimeout(() => {
      this._glitchAway();
    }, 2400);
    this.signalLossTimeouts.push(id2);
  }

  _glitchAway() {
    if (!this.signalLostOverlay) {
      this._finishSignalLost();
      return;
    }
    // Rapid flicker: toggle visibility 4 times over 300ms
    const flickerSteps = [0, 60, 120, 180, 240, 300];
    flickerSteps.forEach((time, i) => {
      const id = setTimeout(() => {
        if (this.signalLostOverlay) {
          this.signalLostOverlay.style.display = i % 2 === 0 ? "none" : "";
        }
        // Final step: hide and finish
        if (i === flickerSteps.length - 1) {
          this._finishSignalLost();
        }
      }, time);
      this.signalLossTimeouts.push(id);
    });
  }

  _finishSignalLost() {
    // Hide overlay
    this._removeTerminalEffectLayers();
    if (this.signalLostOverlay) {
      this.signalLostOverlay.style.display = "none";
    }
    // Brief residual damage burst before settling into deployment screen
    if (this.damageEffectsPass) {
      const u = this.damageEffectsPass.uniforms;
      u.signalLoss.value = 0;
      u.scanlineIntensity.value = 0.8;
      u.noiseIntensity.value = 0.6;
      u.glitchIntensity.value = 1.0;
    }
    if (this.vignettePass) {
      this.vignettePass.uniforms.overlayIntensity.value = 0.6;
      this.vignettePass.uniforms.overlayColor.value.set(0x330000);
    }
    this.damageChromaticIntensity = 0.03;
    // Set targets to zero so effects decay naturally via update loop
    this.overlayTargetIntensity = 0;
    this.overlayTargetColor.set(0x000000);
    this.currentHealthPercent = 1.0;
    // Restore hidden UI elements
    this._showUIElements();
    // Fire callback → deployment screen
    if (this.onSignalLostComplete) {
      this.onSignalLostComplete();
    }
  }

  _createTerminalEffectLayers() {
    if (!this.signalLostOverlay) return;

    // Remove any existing layers from a previous death
    this._removeTerminalEffectLayers();

    // Vignette layer
    const vignette = document.createElement("div");
    vignette.className = "terminal-vignette";
    this.signalLostOverlay.appendChild(vignette);

    // Noise layer (canvas with animated static)
    const noiseCanvas = document.createElement("canvas");
    noiseCanvas.className = "terminal-noise";
    noiseCanvas.width = 256;
    noiseCanvas.height = 256;
    this.signalLostOverlay.appendChild(noiseCanvas);

    // Pre-generate several noise frames and cycle through them
    const ctx = noiseCanvas.getContext("2d");
    const w = noiseCanvas.width;
    const h = noiseCanvas.height;
    const frameCount = 8;
    const noiseFrames = [];
    for (let f = 0; f < frameCount; f++) {
      const imageData = ctx.createImageData(w, h);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
      noiseFrames.push(imageData);
    }

    // Cycle frames at ~12fps (every ~83ms) for a choppy CRT static look
    let frameIndex = 0;
    const drawNoise = () => {
      ctx.putImageData(noiseFrames[frameIndex], 0, 0);
      frameIndex = (frameIndex + 1) % frameCount;
    };
    drawNoise();
    this._noiseIntervalId = setInterval(drawNoise, 83);
  }

  _removeTerminalEffectLayers() {
    // Stop noise animation
    if (this._noiseIntervalId) {
      clearInterval(this._noiseIntervalId);
      this._noiseIntervalId = null;
    }
    // Remove effect layer elements
    if (this.signalLostOverlay) {
      const vignette =
        this.signalLostOverlay.querySelector(".terminal-vignette");
      const noise = this.signalLostOverlay.querySelector(".terminal-noise");
      if (vignette) vignette.remove();
      if (noise) noise.remove();
    }
  }

  _hideUIElements() {
    const ids = [
      "player-tags-container",
      "debug-bar",
      "ui-hint",
      "left-panel-stack",
      "fast-travel-ui",
      "portal-prompt",
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
    // Tip panel fades via opacity to match Tusk panel
    const tipPanel = document.getElementById("commander-tip-panel");
    if (tipPanel) {
      tipPanel.style.opacity = "0";
      tipPanel.style.pointerEvents = "none";
    }
  }

  _showUIElements() {
    // Don't restore UI elements if HUD is toggled off (H key)
    if (!this.hudVisible) return;
    const ids = [
      "player-tags-container",
      "debug-bar",
      "ui-hint",
      "left-panel-stack",
      "fast-travel-ui",
      "portal-prompt",
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.style.display = "";
    }
    // Tip panel fades via opacity to match Tusk panel
    const tipPanel = document.getElementById("commander-tip-panel");
    if (tipPanel) {
      tipPanel.style.opacity = "";
      tipPanel.style.pointerEvents = "";
    }
  }

  // ========================
  // UPDATE (called every frame from animate loop)
  // ========================

  update(deltaTime) {
    this._updateVignette(deltaTime);
    this._updateChromatic(deltaTime);
    this._updateDamageEffects(deltaTime);
  }

  // ========================
  // INTERNAL
  // ========================

  _applyLensDirtConfig() {
    if (!this.lensDirtPass) return;
    this.lensDirtPass.enabled = this.config.lensDirt.enabled;
    this.lensDirtPass.uniforms.intensity.value = this.config.lensDirt.intensity;
    this.lensDirtPass.uniforms.bloomThreshold.value =
      this.config.lensDirt.bloomThreshold;
    this.lensDirtPass.uniforms.dirtMinLevel.value =
      this.config.lensDirt.dirtMinLevel;
    this.lensDirtPass.uniforms.bloomSpread.value =
      this.config.lensDirt.bloomSpread;
  }

  _applyVignetteConfig() {
    if (!this.vignettePass) return;
    this.vignettePass.enabled = this.config.vignette.enabled;
    this.vignettePass.uniforms.baseIntensity.value =
      this.config.vignette.baseIntensity;
  }

  _applyChromaticConfig() {
    if (!this.chromaticPass) return;
    this.chromaticPass.enabled = this.config.chromatic.enabled;
    this.chromaticPass.uniforms.intensity.value =
      this.config.chromatic.baseIntensity;
    this.chromaticPass.uniforms.falloff.value = this.config.chromatic.falloff;
  }

  _applyDamageEffectsConfig() {
    if (!this.damageEffectsPass) return;
    this.damageEffectsPass.enabled = this.config.damageEffects.enabled;
  }

  _updateVignette(deltaTime) {
    if (!this.vignettePass || !this.vignettePass.enabled) return;

    if (this.isBeingHealed && this.config.vignette.healVignetteEnabled) {
      // Green healing pulse (sine wave oscillation)
      this.healPulseTime += deltaTime * 4;
      const pulse = (Math.sin(this.healPulseTime) + 1) / 2;
      this.vignettePass.uniforms.overlayColor.value.set(0x003300);
      this.vignettePass.uniforms.overlayIntensity.value = 0.2 + pulse * 0.15;
    } else {
      this.healPulseTime = 0;
      // Decay overlay toward target (0 when healthy, 0.3 when low HP, 0.6 on death)
      const current = this.vignettePass.uniforms.overlayIntensity.value;
      this.vignettePass.uniforms.overlayIntensity.value = THREE.MathUtils.lerp(
        current,
        this.overlayTargetIntensity,
        deltaTime * 5,
      );
      this.vignettePass.uniforms.overlayColor.value.lerp(
        this.overlayTargetColor,
        deltaTime * 5,
      );
    }
  }

  _updateChromatic(deltaTime) {
    if (!this.chromaticPass || !this.chromaticPass.enabled) return;

    let total = this.config.chromatic.baseIntensity;

    // Damage spike (decays per frame)
    if (
      this.config.chromatic.damageEnabled &&
      this.damageChromaticIntensity > 0.0001
    ) {
      total += this.damageChromaticIntensity;
      this.damageChromaticIntensity *= 0.95;
    }

    // Low HP sustain: keep minimum chromatic aberration at low health
    if (
      this.config.chromatic.damageEnabled &&
      this.currentHealthPercent < 0.3
    ) {
      const severity = (0.3 - this.currentHealthPercent) / 0.3;
      total = Math.max(
        total,
        this.config.chromatic.baseIntensity + severity * 0.008,
      );
    }

    this.chromaticPass.uniforms.intensity.value = total;
  }

  _updateDamageEffects(deltaTime) {
    if (!this.damageEffectsPass || !this.damageEffectsPass.enabled) return;

    // Advance shader time
    this.damageTime += deltaTime;
    this.damageEffectsPass.uniforms.time.value = this.damageTime;

    const u = this.damageEffectsPass.uniforms;

    // Always decay glitch and noise (never sustain constant full-screen effects)
    u.glitchIntensity.value *= 0.88;
    u.noiseIntensity.value *= 0.9;

    // Scanlines decay when healthy, sustain at low HP
    if (this.currentHealthPercent > 0.4) {
      u.scanlineIntensity.value *= 0.95;
    }

    // Low HP: sporadic random glitch bursts instead of constant effect
    if (this.currentHealthPercent < 0.4 && this.config.damageEffects.glitch) {
      const severity = (0.4 - this.currentHealthPercent) / 0.4; // 0-1
      // Random chance to spike each frame — more frequent at lower HP
      if (Math.random() < severity * 0.03) {
        u.glitchIntensity.value = 0.2 + severity * 0.4;
      }
      // Occasional noise crackle
      if (this.config.damageEffects.noise && Math.random() < severity * 0.02) {
        u.noiseIntensity.value = 0.1 + severity * 0.15;
      }
    }
  }

}
