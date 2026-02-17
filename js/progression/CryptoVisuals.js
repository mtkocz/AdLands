/**
 * AdLands - Crypto Visual Feedback System
 * Floating numbers, color coding, combo display, and HUD bar
 */

// Preallocated temp vector for occlusion ray direction
const _cryptoRayDir = new THREE.Vector3();
const _cryptoScreenTemp = new THREE.Vector3();

class CryptoVisuals {
  constructor(camera, cryptoSystem, planet = null) {
    this.camera = camera;
    this.cryptoSystem = cryptoSystem;
    this.planet = planet; // Planet reference for occlusion checking

    // Whether floating crypto popups are enabled (controlled via settings)
    this.enabled = true;

    // Container for floating numbers
    this.container = document.createElement("div");
    this.container.id = "crypto-visuals-container";
    this.container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 100;
            overflow: hidden;
        `;
    document.body.appendChild(this.container);

    // Active floating numbers
    this.floatingNumbers = [];

    // Stacking system for rapid gains
    this.pendingStack = {
      amount: 0,
      position: null,
      timeout: null,
      stackWindow: 150, // ms to stack gains
    };

    // Combo display element
    this.comboElement = null;
    this.comboTimeout = null;
    this._createComboElement();

    // HUD bar
    this._createHUDBar();

    // Connect to crypto system callbacks
    this.cryptoSystem.onCryptoGain = (amount, reason, worldPos) => {
      this._onCryptoGain(amount, reason, worldPos);

      if (window.dashboard) {
        // Flash the dashboard crypto bar
        window.dashboard.flashCryptoBar?.(amount);
        // Immediately update the crypto counter (roller animation)
        window.dashboard.incrementCrypto?.(amount);
      }
    };
    this.cryptoSystem.onLevelUp = (newLevel, oldLevel) => {
      this._onLevelUp(newLevel, oldLevel);
    };

    // Initial HUD update
    this._updateHUDBar();
  }

  // ========================
  // FLOATING NUMBERS
  // ========================

  _onCryptoGain(amount, reason, worldPosition) {
    // Always update HUD bar regardless of popup setting
    this._updateHUDBar();

    // Skip floating numbers if disabled
    if (!this.enabled) {
      return;
    }

    // For cluster captures and holding crypto, spawn immediately without stacking (show individual hex crypto)
    if (reason === "cluster" || reason === "holding") {
      this._spawnFloatingNumber(amount, worldPosition);
      return;
    }

    // Stack rapid gains but always use the latest position
    if (this.pendingStack.timeout) {
      this.pendingStack.amount += amount;
      clearTimeout(this.pendingStack.timeout);
    } else {
      this.pendingStack.amount = amount;
    }
    // Always update to latest position so crypto appears above current target
    this.pendingStack.position = worldPosition;

    this.pendingStack.timeout = setTimeout(() => {
      // Check enabled again in case it changed during timeout
      if (this.enabled) {
        this._spawnFloatingNumber(
          this.pendingStack.amount,
          this.pendingStack.position,
        );
      }
      this.pendingStack.amount = 0;
      this.pendingStack.position = null;
      this.pendingStack.timeout = null;
    }, this.pendingStack.stackWindow);
  }

  /**
   * Check if a world position is occluded by the planet using ray-sphere intersection.
   * Returns true if the position IS OCCLUDED (hidden behind planet).
   *
   * Algorithm: Cast a ray from camera to the crypto position.
   * If the ray intersects the planet sphere AND the intersection point is
   * closer than the crypto position, then the position is occluded.
   */
  _isOccludedByPlanet(worldPosition) {
    if (!worldPosition || !this.camera || !this.planet) return false;

    const cameraPos = this.camera.position;
    const planetRadius = this.planet.radius;

    // Ray from camera to crypto position (reuse preallocated vector)
    const rayDir = _cryptoRayDir.copy(worldPosition).sub(cameraPos).normalize();

    // Ray-sphere intersection: solve |cameraPos + t*rayDir|^2 = planetRadius^2
    // Let oc = cameraPos (planet center is origin)
    const a = 1; // rayDir is normalized
    const b = 2.0 * cameraPos.dot(rayDir);
    const c = cameraPos.dot(cameraPos) - planetRadius * planetRadius;
    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) {
      // Ray misses planet sphere - position is visible
      return false;
    }

    // Ray intersects sphere - find closest intersection
    const sqrtDisc = Math.sqrt(discriminant);
    const t1 = (-b - sqrtDisc) / 2;
    const t2 = (-b + sqrtDisc) / 2;

    // Get closest positive t (intersection in front of camera)
    let tHit = -1;
    if (t1 > 0.001 && t2 > 0.001) {
      tHit = Math.min(t1, t2);
    } else if (t1 > 0.001) {
      tHit = t1;
    } else if (t2 > 0.001) {
      tHit = t2;
    }

    if (tHit < 0) {
      // Both intersections behind camera - position is visible
      return false;
    }

    // Compare intersection distance to crypto position distance
    const distToCrypto = cameraPos.distanceTo(worldPosition);

    // If planet intersection is closer than crypto position, it's occluded
    // Small buffer prevents z-fighting at surface
    return tHit < distToCrypto - 0.5;
  }

  /**
   * Calculate opacity based on distance from camera.
   * Closer = full opacity, farther = faded (for depth perception).
   */
  _calculateDistanceOpacity(distance) {
    const FADE_START = 400; // Full opacity within this distance
    const FADE_END = 800; // Minimum opacity beyond this
    const MIN_OPACITY = 0.4;

    if (distance <= FADE_START) return 1.0;
    if (distance >= FADE_END) return MIN_OPACITY;

    // Linear interpolation
    const t = (distance - FADE_START) / (FADE_END - FADE_START);
    return 1.0 - t * (1.0 - MIN_OPACITY);
  }

  _spawnFloatingNumber(amount, worldPosition) {
    if (amount === 0) return;

    const isSpend = amount < 0;

    // Spend amounts spawn from the dashboard crypto counter instead of the tank
    if (isSpend) {
      this._spawnDashboardFloatingNumber(amount);
      return;
    }

    // Skip if no valid world position
    if (!worldPosition) return;

    // Check if position is occluded by planet at spawn time
    if (this._isOccludedByPlanet(worldPosition)) {
      return;
    }

    const absAmount = Math.abs(amount);

    const element = document.createElement("div");
    element.className = "crypto-floating-number";

    // Size varies by magnitude
    let sizeClass = "crypto-small";
    let text = `+¢ ${absAmount.toLocaleString()}`;

    if (absAmount >= 5000) {
      sizeClass = "crypto-massive";
    } else if (absAmount >= 1000) {
      sizeClass = "crypto-large";
    } else if (absAmount >= 100) {
      sizeClass = "crypto-medium";
    }

    element.classList.add(sizeClass);
    element.textContent = text;
    element.style.opacity = "0.8"; // Set initial opacity before appending

    this.container.appendChild(element);

    // Duration based on amount
    const duration = 1500 + (amount >= 1000 ? 500 : 0);

    // Store 3D position data for continuous tracking
    const worldPos = worldPosition.clone();
    const radialDirection = worldPos.clone().normalize(); // Direction from planet center (origin)
    const startDistance = worldPos.length();

    // Create floater with 3D tracking data
    const floater = {
      element,
      worldPosition: worldPos,
      radialDirection,
      startDistance,
      radialSpeed: 8.0, // World units per second - higher for more drift
      startTime: performance.now(),
      duration,
    };

    this.floatingNumbers.push(floater);

    // Set initial screen position
    const screen = this._worldToScreen(worldPos);
    if (screen) {
      element.style.left = `${Math.round(screen.x)}px`;
      element.style.top = `${Math.round(screen.y)}px`;
    }
  }

  /**
   * Spawn a floating spend number from the dashboard crypto counter.
   * Pure 2D screen-space animation — drifts downward from the counter.
   */
  _spawnDashboardFloatingNumber(amount) {
    const counterEl = document.querySelector(".header-crypto-amount");
    if (!counterEl) return;

    const absAmount = Math.abs(amount);
    const rect = counterEl.getBoundingClientRect();

    // Position at the crypto counter
    const startX = rect.left + rect.width / 2;
    const startY = rect.bottom + 4;

    // Use inline styles only (no crypto-floating-number class) to avoid
    // CSS conflicts (position:absolute, opacity:0) and match counter font
    const counterStyle = window.getComputedStyle(counterEl);
    const element = document.createElement("div");
    element.textContent = `-¢${absAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    element.style.cssText = `
      position: fixed;
      left: ${Math.round(startX)}px;
      top: ${Math.round(startY)}px;
      z-index: 251;
      pointer-events: none;
      white-space: nowrap;
      transform: translateX(-50%);
      opacity: 0.8;
      color: #ff4444;
      font-family: ${counterStyle.fontFamily};
      font-size: ${counterStyle.fontSize};
      text-shadow:
        -1px -1px 0 #000, 1px -1px 0 #000,
        -1px 1px 0 #000, 1px 1px 0 #000,
        0 0 6px rgba(255, 68, 68, 0.5);
    `;

    document.body.appendChild(element);

    const duration = 1500;
    const floater = {
      element,
      screenMode: true, // Flag: pure 2D, no 3D tracking
      startX,
      startY,
      startTime: performance.now(),
      duration,
    };

    this.floatingNumbers.push(floater);
  }

  _worldToScreen(worldPosition) {
    if (!this.camera || !worldPosition) return null;

    const vector = _cryptoScreenTemp.copy(worldPosition);
    vector.project(this.camera);

    // Check if behind camera
    if (vector.z > 1) return null;

    const x = (vector.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-vector.y * 0.5 + 0.5) * window.innerHeight;

    return { x, y };
  }

  // ========================
  // COMBO DISPLAY
  // ========================

  _createComboElement() {
    this.comboElement = document.createElement("div");
    this.comboElement.id = "crypto-combo";
    this.comboElement.className = "hidden";
    this.comboElement.style.cssText = `
            position: fixed;
            top: 50%;
            right: 48px;
            transform: translateY(-50%);
            font-family: 'Atari ST 8x16', monospace;
            font-size: 16px;
            color: #FFD700;
            text-shadow: 0 0 8px #FFD700, 0 0 16px #FFD700;
            pointer-events: none;
            z-index: 101;
            transition: opacity 0.3s, transform 0.3s;
        `;
    document.body.appendChild(this.comboElement);
  }

  _showCombo(count) {
    if (count < 3) return;

    this.comboElement.textContent = `COMBO x${count}!`;
    this.comboElement.classList.remove("hidden");
    this.comboElement.style.opacity = "1";
    this.comboElement.style.transform = "translateY(-50%) scale(1.2)";

    // Animate back
    setTimeout(() => {
      this.comboElement.style.transform = "translateY(-50%) scale(1)";
    }, 100);

    // Hide after timeout
    if (this.comboTimeout) clearTimeout(this.comboTimeout);
    this.comboTimeout = setTimeout(() => {
      this.comboElement.style.opacity = "0";
      setTimeout(() => {
        this.comboElement.classList.add("hidden");
      }, 300);
    }, 2000);
  }

  // ========================
  // HUD BAR
  // ========================

  _createHUDBar() {
    // Create crypto bar container
    this.hudBar = document.createElement("div");
    this.hudBar.id = "crypto-hud-bar";
    this.hudBar.innerHTML = `
            <div class="crypto-level-badge">
                <span class="crypto-level-number">1</span>
            </div>
            <div class="crypto-bar-container">
                <div class="crypto-bar-fill"></div>
                <div class="crypto-bar-text">
                    ¢ <span class="crypto-current">0</span> / <span class="crypto-needed">10,000</span>
                </div>
            </div>
        `;
    document.body.appendChild(this.hudBar);

    // Cache elements
    this.hudElements = {
      levelNumber: this.hudBar.querySelector(".crypto-level-number"),
      barFill: this.hudBar.querySelector(".crypto-bar-fill"),
      currentCrypto: this.hudBar.querySelector(".crypto-current"),
      neededCrypto: this.hudBar.querySelector(".crypto-needed"),
    };
  }

  _updateHUDBar() {
    const stats = this.cryptoSystem.getStats();
    const progress = this.cryptoSystem.getLevelProgress();
    const currentLevelTotalCrypto = this.cryptoSystem.getTotalCryptoForLevel(stats.level);
    const cryptoIntoLevel = stats.totalCrypto - currentLevelTotalCrypto;

    // Update level badge
    this.hudElements.levelNumber.textContent = stats.level;

    // Update bar fill with animation
    this.hudElements.barFill.style.width = `${progress * 100}%`;

    // Update text
    this.hudElements.currentCrypto.textContent = cryptoIntoLevel.toLocaleString();
    this.hudElements.neededCrypto.textContent = this.cryptoSystem
      .getCryptoRequiredForLevel(stats.level + 1)
      .toLocaleString();
  }

  // ========================
  // LEVEL UP CELEBRATION
  // ========================

  _onLevelUp(newLevel, oldLevel) {
    // Create level up overlay
    const overlay = document.createElement("div");
    overlay.className = "crypto-level-up-overlay";
    overlay.innerHTML = `
            <div class="level-up-content">
                <div class="level-up-text">LEVEL UP!</div>
                <div class="level-up-number">${newLevel}</div>
            </div>
        `;
    document.body.appendChild(overlay);

    // Animate
    requestAnimationFrame(() => {
      overlay.classList.add("animate");
    });

    // Remove after animation
    setTimeout(() => {
      overlay.classList.add("fade-out");
      setTimeout(() => {
        overlay.remove();
      }, 500);
    }, 2500);

    // Update HUD
    this._updateHUDBar();
  }

  // ========================
  // UPDATE LOOP
  // ========================

  update(deltaTime = 1 / 60) {
    const now = performance.now();
    const cameraPos = this.camera ? this.camera.position : null;

    // Update floating numbers - track 3D position each frame
    for (let i = this.floatingNumbers.length - 1; i >= 0; i--) {
      const floater = this.floatingNumbers[i];
      const elapsed = now - floater.startTime;
      const progress = elapsed / floater.duration;

      if (progress >= 1) {
        // Remove completed
        floater.element.remove();
        this.floatingNumbers.splice(i, 1);
        continue;
      }

      // Screen-mode floaters (spend amounts from dashboard counter)
      if (floater.screenMode) {
        const driftY = 40 * progress; // Drift 40px downward
        let opacity = 0.8;
        if (progress > 0.6) {
          opacity *= 1 - (progress - 0.6) / 0.4;
        }
        floater.element.style.left = `${Math.round(floater.startX)}px`;
        floater.element.style.top = `${Math.round(floater.startY + driftY)}px`;
        floater.element.style.opacity = opacity;
        continue;
      }

      // Update 3D position (move radially outward from planet center)
      const elapsedSeconds = elapsed / 1000;
      const currentDistance =
        floater.startDistance + floater.radialSpeed * elapsedSeconds;
      floater.worldPosition
        .copy(floater.radialDirection)
        .multiplyScalar(currentDistance);

      // Check planet occlusion
      if (this._isOccludedByPlanet(floater.worldPosition)) {
        floater.element.style.display = "none";
        continue;
      }

      // Project to screen
      const screen = this._worldToScreen(floater.worldPosition);
      if (!screen) {
        floater.element.style.display = "none";
        continue;
      }

      // Calculate distance-based opacity
      let finalOpacity = 0.8; // Base opacity (more visible)
      if (cameraPos) {
        const distToCamera = floater.worldPosition.distanceTo(cameraPos);
        const distanceOpacity = this._calculateDistanceOpacity(distToCamera);
        finalOpacity = 0.8 * distanceOpacity;
      }

      // Lifetime fade (last 30% of duration)
      if (progress > 0.7) {
        const fadeProgress = (progress - 0.7) / 0.3;
        finalOpacity *= 1 - fadeProgress;
      }

      // Apply position and opacity
      floater.element.style.display = "block";
      floater.element.style.left = `${Math.round(screen.x)}px`;
      floater.element.style.top = `${Math.round(screen.y)}px`;
      floater.element.style.opacity = finalOpacity;
    }
  }

  // ========================
  // CLEANUP
  // ========================

  dispose() {
    this.container.remove();
    this.comboElement.remove();
    this.hudBar.remove();
    this.floatingNumbers = [];
  }
}
