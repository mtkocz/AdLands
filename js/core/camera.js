/**
 * AdLands - Camera Module
 * Multi-mode camera: Surface, Orbital, FastTravel, and PortalPreview
 * Quick, smooth transitions with dynamic animations
 */

// Preallocated temp vectors to avoid per-frame GC
const _camTempPos = new THREE.Vector3();
const _camTempNormal = new THREE.Vector3();
const _camPortalWorld = new THREE.Vector3();

class GameCamera {
  constructor(camera, renderer, sphereRadius) {
    this.camera = camera;
    this.renderer = renderer;
    this.sphereRadius = sphereRadius;

    // Camera distances
    this.orbitalDistance = 960; // Closer orbital view
    this.surfaceDistance = sphereRadius + 40; // Base surface view distance
    this.fastTravelDistance = 960; // Same as orbital view
    this.previewDistance = sphereRadius + 60; // Close surface view for preview

    // Speed-based zoom (camera pulls back when moving fast)
    this.speedZoom = {
      maxExtraDistance: 15, // Maximum extra distance when at max speed
      smoothing: 0.04, // How fast the zoom adjusts (lower = smoother)
    };
    this.currentSpeedZoom = 0; // Current smoothed zoom offset

    // Charge-based pullback (camera pulls back while charging cannon)
    this.chargePullback = {
      target: 0, // Target pullback ratio (0-1)
      current: 0, // Smoothed current value
      maxExtraDistance: 30, // Maximum extra distance at full charge
      easeIn: 0.03, // How fast to pull back (gentle ease in)
      easeOut: 0.015, // Slow, smooth ease out for satisfying return
    };

    // Territory preview pullback (camera pulls back to show claimed cluster)
    this.territoryPreviewPullback = {
      target: 0, // 0 = no pullback, 1 = full pullback
      current: 0,
      maxExtraDistance: 55, // Max extra distance at full pullback (frames 19-hex cluster)
      easeIn: 1.5, // Smooth pull-out speed (per second)
      easeOut: 2.5, // Faster snap-back when canceling (per second)
    };

    // Mode state: 'surface', 'orbital', 'fastTravel', 'portalPreview'
    this.mode = "orbital"; // Start in orbital view before first deployment
    this.transitioning = false;
    this.transitionProgress = 0;
    this.transitionType = null;
    this.transitionSpeed = 0.7; // Progress per second (reaches 1.0 in ~1.4s)

    // Orbital view state - start at random position, avoid poles (stay near equator)
    this.orbitalTheta = Math.random() * Math.PI * 2; // Random azimuth (0 to 2π)
    // Phi = 0 is north pole, π/2 is equator, π is south pole
    // Constrain to 60°-120° from north pole (±30° from equator)
    this.orbitalPhi = Math.PI / 3 + (Math.random() * Math.PI) / 3; // 60° to 120° (equatorial band)

    // Surface view state
    this.smoothedPosition = null; // Lagged tank position
    this.followLerp = 3.5; // Smooth follow speed per second (frame-rate independent)

    // Fast travel state
    this.fastTravelEnabled = false; // Blocks normal scroll transitions
    this.previewTheta = 0; // Preview target angles
    this.previewPhi = 0;

    // Transition state
    this.transitionStart = {
      theta: 0,
      phi: 0,
      distance: 0,
    };
    this.transitionTarget = {
      theta: 0,
      phi: 0,
      distance: 0,
    };

    // Mouse drag state (orbital/fastTravel mode only)
    this.isDragging = false;
    this.previousMouse = { x: 0, y: 0 };
    this.lastMoveTime = 0;

    // Orbital momentum state
    this.orbitalVelocity = { theta: 0, phi: 0 };
    this.orbitalFriction = 0.95; // Velocity decay per frame (lower = faster stop)

    // Screen shake state
    this.shake = {
      intensity: 0, // Current shake intensity (decays over time)
      decay: 0.7, // How fast shake decays per second
      maxOffset: 2.109, // Maximum position offset at full intensity
      offset: new THREE.Vector3(), // Current frame's shake offset
    };

    // Transition completion callback
    this.onTransitionComplete = null;

    // Wheel gesture classification state (trackpad vs mouse wheel)
    this._wheelGesture = {
      active: false,
      device: null, // 'mouse' | 'trackpad' | null
      lastEventTime: 0,
      eventCount: 0,
      totalDeltaX: 0,
      timeoutId: null,
    };

    this._setupControls();

    // Initialize camera in orbital view at random position (before first deployment)
    this._positionCamera(
      this.orbitalDistance,
      this.orbitalTheta,
      this.orbitalPhi,
    );
  }

  // ========================
  // PUBLIC METHODS
  // ========================

  update(tankPosition, tankSpeed = 0, deltaTime = 1 / 60) {
    // Initialize smoothed position on first call
    if (!this.smoothedPosition) {
      this.smoothedPosition = tankPosition.clone();
    }

    // Calculate frame-rate independent lerp factor
    // Using 1 - e^(-rate * dt) for smooth exponential decay
    const lerpFactor = 1 - Math.exp(-this.followLerp * deltaTime);

    // Always update smoothed position (for surface mode)
    this.smoothedPosition.lerp(tankPosition, lerpFactor);

    // Update speed-based zoom (smooth interpolation)
    this._updateSpeedZoom(tankSpeed, deltaTime);

    if (this.transitioning) {
      this._updateTransition(tankPosition, deltaTime);
    } else if (this.mode === "orbital") {
      this._updateOrbital();
    } else if (this.mode === "fastTravel") {
      this._updateFastTravel();
    } else if (this.mode === "portalPreview") {
      this._updatePortalPreview();
    } else {
      this._updateSurface(deltaTime);
    }

    // Apply screen shake (only in surface mode for gameplay feel)
    if (this.mode === "surface" && this.shake.intensity > 0) {
      this._applyShake(deltaTime);
    }

    // Always look at planet center with Y-up
    this.camera.lookAt(0, 0, 0);
    this.camera.up.set(0, 1, 0);
  }

  getEffectiveDistance() {
    return this.camera.position.length();
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Trigger screen shake from an impact
   * @param {THREE.Vector3} impactPosition - World position of the impact
   * @param {THREE.Vector3} playerPosition - Player tank position
   * @param {number} baseIntensity - Base shake intensity (0-1)
   * @param {number} maxRange - Maximum distance for shake effect
   */
  triggerShake(
    impactPosition,
    playerPosition,
    baseIntensity = 1,
    maxRange = 100,
  ) {
    const distance = impactPosition.distanceTo(playerPosition);
    if (distance > maxRange) return;

    // Intensity falls off with distance (inverse square feels natural)
    const falloff = 1 - distance / maxRange;
    const intensity = baseIntensity * falloff * falloff;

    // Stack with existing shake (capped at 1)
    this.shake.intensity = Math.min(1, this.shake.intensity + intensity);
  }

  /**
   * Set charge pullback amount (called by cannon system while charging)
   * @param {number} ratio - Charge ratio (0-1)
   */
  setChargePullback(ratio) {
    this.chargePullback.target = Math.max(0, Math.min(1, ratio));
  }

  setTerritoryPreviewPullback(ratio) {
    this.territoryPreviewPullback.target = Math.max(0, Math.min(1, ratio));
  }

  // ========================
  // MODE UPDATES
  // ========================

  _updateOrbital() {
    this._applyOrbitalMomentum();
    this._positionCamera(
      this.orbitalDistance,
      this.orbitalTheta,
      this.orbitalPhi,
    );
  }

  _updateFastTravel() {
    // Similar to orbital but at fastTravelDistance
    this._applyOrbitalMomentum();
    this._positionCamera(
      this.fastTravelDistance,
      this.orbitalTheta,
      this.orbitalPhi,
    );
  }

  _updatePortalPreview() {
    // Track current portal position (planet rotates)
    if (this.previewPlanet && this.previewPortalIndex !== null) {
      const portalPosLocal = this.previewPlanet.getPortalPosition(
        this.previewPortalIndex,
      );
      if (portalPosLocal) {
        const portalPosWorld = _camPortalWorld.copy(portalPosLocal);
        this.previewPlanet.hexGroup.localToWorld(portalPosWorld);

        const normal = _camTempNormal.copy(portalPosWorld).normalize();
        this.previewTheta = Math.atan2(normal.z, normal.x);
        this.previewPhi = Math.acos(normal.y);
      }
    }

    this._positionCamera(
      this.previewDistance,
      this.previewTheta,
      this.previewPhi,
    );
  }

  _updateSurface(deltaTime) {
    // Smooth the dynamic pullbacks
    this._updateChargePullback(deltaTime);
    this._updateTerritoryPreviewPullback(deltaTime);

    // Position camera above the smoothed tank position
    // Add speed-based zoom offset + charge pullback + territory preview for dynamic distance
    const chargePullbackDistance =
      this.chargePullback.current * this.chargePullback.maxExtraDistance;
    const territoryPullbackDistance =
      this.territoryPreviewPullback.current * this.territoryPreviewPullback.maxExtraDistance;
    const effectiveDistance =
      this.surfaceDistance + this.currentSpeedZoom + chargePullbackDistance + territoryPullbackDistance;
    const targetCameraPos = _camTempNormal.copy(this.smoothedPosition).normalize().multiplyScalar(effectiveDistance);

    // Smooth camera position with frame-rate independent easing
    const lerpFactor = 1 - Math.exp(-this.followLerp * deltaTime);
    this.camera.position.lerp(targetCameraPos, lerpFactor);
  }

  _updateChargePullback(deltaTime) {
    const target = this.chargePullback.target;
    const current = this.chargePullback.current;

    if (current < target) {
      // Pulling back - use gentle ease in (frame-rate independent)
      const easeInRate = 1.8; // Per second
      const factor = 1 - Math.exp(-easeInRate * deltaTime);
      this.chargePullback.current += (target - current) * factor;
    } else if (current > target) {
      // Returning - use slow, smooth ease out (frame-rate independent)
      const easeOutRate = 0.9; // Per second
      const factor = 1 - Math.exp(-easeOutRate * deltaTime);
      this.chargePullback.current += (target - current) * factor;
    }

    // Clamp to valid range
    this.chargePullback.current = Math.max(
      0,
      Math.min(1, this.chargePullback.current),
    );
  }

  _updateTerritoryPreviewPullback(deltaTime) {
    const target = this.territoryPreviewPullback.target;
    const current = this.territoryPreviewPullback.current;

    if (current < target) {
      // Pulling back - smooth ease in
      const factor = 1 - Math.exp(-this.territoryPreviewPullback.easeIn * deltaTime);
      this.territoryPreviewPullback.current += (target - current) * factor;
    } else if (current > target) {
      // Returning - faster snap-back
      const factor = 1 - Math.exp(-this.territoryPreviewPullback.easeOut * deltaTime);
      this.territoryPreviewPullback.current += (target - current) * factor;
    }

    this.territoryPreviewPullback.current = Math.max(
      0,
      Math.min(1, this.territoryPreviewPullback.current),
    );
  }

  _updateSpeedZoom(tankSpeed, deltaTime) {
    // Calculate target zoom based on speed
    // Tank max speed is ~0.002 (sprint speed)
    const maxSpeed = 0.002;
    const speedRatio = Math.min(Math.abs(tankSpeed) / maxSpeed, 1.0);

    // Calculate target zoom offset
    const targetZoom = speedRatio * this.speedZoom.maxExtraDistance;

    // Frame-rate independent smooth interpolation
    const smoothingRate = 2.5; // Per second
    const factor = 1 - Math.exp(-smoothingRate * deltaTime);
    this.currentSpeedZoom += (targetZoom - this.currentSpeedZoom) * factor;
  }

  _updateTransition(tankPos, deltaTime) {
    // Advance transition (frame-rate independent)
    this.transitionProgress += this.transitionSpeed * deltaTime;

    if (this.transitionProgress >= 1) {
      // Transition complete
      this.transitionProgress = 1;
      this.transitioning = false;

      // Determine final mode based on transition type
      switch (this.transitionType) {
        case "toOrbital":
          this.mode = "orbital";
          this._updateOrbital();
          break;
        case "toFastTravel":
          this.mode = "fastTravel";
          this._updateFastTravel();
          break;
        case "toPortalPreview":
          this.mode = "portalPreview";
          this._updatePortalPreview();
          break;
        case "toSurface":
        default:
          this.mode = "surface";
          // Clear any residual shake when arriving at surface
          this.shake.intensity = 0;
          this._updateSurface(deltaTime);
          break;
      }

      // Fire transition complete callback
      if (this.onTransitionComplete) {
        this.onTransitionComplete(this.transitionType);
        this.onTransitionComplete = null;
      }
      return;
    }

    // Smoothstep easing
    const t = this._smoothstep(this.transitionProgress);

    if (this.transitionType === "toOrbital") {
      // Simple zoom out - lerp from current position outward
      const currentDist = this._lerp(
        this.transitionStart.distance,
        this.orbitalDistance,
        t,
      );
      const currentTheta = this._lerpAngle(
        this.transitionStart.theta,
        this.transitionTarget.theta,
        t,
      );
      const currentPhi = this._lerp(
        this.transitionStart.phi,
        this.transitionTarget.phi,
        t,
      );

      this._positionCamera(currentDist, currentTheta, currentPhi);
    } else if (this.transitionType === "toFastTravel") {
      // Pull out first (0-0.7), then orbit (0.3-1.0) with slight overlap
      const pullProgress = Math.min(this.transitionProgress / 0.7, 1.0);
      const orbitProgress = Math.max(
        (this.transitionProgress - 0.3) / 0.7,
        0.0,
      );

      const pullT = this._smoothstep(pullProgress);
      const orbitT = this._smoothstep(orbitProgress);

      // Phase 1: Pull out to fast travel distance
      const currentDist = this._lerp(
        this.transitionStart.distance,
        this.fastTravelDistance,
        pullT,
      );

      // Phase 2: Orbit to face target (starts after pull begins)
      const currentTheta = this._lerpAngle(
        this.transitionStart.theta,
        this.transitionTarget.theta,
        orbitT,
      );
      const currentPhi = this._lerp(
        this.transitionStart.phi,
        this.transitionTarget.phi,
        orbitT,
      );

      this._positionCamera(currentDist, currentTheta, currentPhi);
    } else if (this.transitionType === "toPortalPreview") {
      // Update target to track current portal position (planet rotates)
      if (this.previewPlanet && this.previewPortalIndex !== null) {
        const portalPosLocal = this.previewPlanet.getPortalPosition(
          this.previewPortalIndex,
        );
        if (portalPosLocal) {
          const portalPosWorld = portalPosLocal.clone();
          this.previewPlanet.hexGroup.localToWorld(portalPosWorld);

          const normal = portalPosWorld.clone().normalize();
          this.transitionTarget.theta = Math.atan2(normal.z, normal.x);
          this.transitionTarget.phi = Math.acos(normal.y);
        }
      }

      // Orbit first (0-0.7), then push in (0.3-1.0) with slight overlap
      const orbitProgress = Math.min(this.transitionProgress / 0.7, 1.0);
      const pushProgress = Math.max((this.transitionProgress - 0.3) / 0.7, 0.0);

      const orbitT = this._smoothstep(orbitProgress);
      const pushT = this._smoothstep(pushProgress);

      // Phase 1: Orbit to find portal (mostly at fast travel distance)
      const currentTheta = this._lerpAngle(
        this.transitionStart.theta,
        this.transitionTarget.theta,
        orbitT,
      );
      const currentPhi = this._lerp(
        this.transitionStart.phi,
        this.transitionTarget.phi,
        orbitT,
      );

      // Phase 2: Push in toward preview distance (starts after orbit begins)
      const currentDist = this._lerp(
        this.transitionStart.distance,
        this.previewDistance,
        pushT,
      );

      this._positionCamera(currentDist, currentTheta, currentPhi);
    } else {
      // toSurface: Orbit first (0-0.7), then push in (0.3-1.0) with slight overlap
      const orbitProgress = Math.min(this.transitionProgress / 0.7, 1.0);
      const pushProgress = Math.max((this.transitionProgress - 0.3) / 0.7, 0.0);

      const orbitT = this._smoothstep(orbitProgress);
      const pushT = this._smoothstep(pushProgress);

      // Calculate target position above tank
      const tankNormal = _camTempNormal.copy(tankPos).normalize();
      const targetTheta = Math.atan2(tankNormal.z, tankNormal.x);
      const targetPhi = Math.acos(tankNormal.y);

      // Phase 1: Orbit to find tank (mostly at orbital distance)
      const currentTheta = this._lerpAngle(
        this.transitionStart.theta,
        targetTheta,
        orbitT,
      );
      const currentPhi = this._lerp(
        this.transitionStart.phi,
        targetPhi,
        orbitT,
      );

      // Phase 2: Push in toward surface (starts after orbit begins)
      const currentDist = this._lerp(
        this.transitionStart.distance,
        this.surfaceDistance,
        pushT,
      );

      this._positionCamera(currentDist, currentTheta, currentPhi);
    }
  }

  // ========================
  // TRANSITIONS
  // ========================

  _startTransition(toMode) {
    if (this.transitioning) return;
    if (this.mode === toMode) return;

    this.transitioning = true;
    this.transitionProgress = 0;
    this.transitionType = toMode === "orbital" ? "toOrbital" : "toSurface";

    // Capture current camera state
    const pos = this.camera.position;
    const dist = pos.length();
    const theta = Math.atan2(pos.z, pos.x);
    const phi = Math.acos(pos.y / dist);

    this.transitionStart = {
      distance: dist,
      theta: theta,
      phi: phi,
    };

    if (this.transitionType === "toOrbital") {
      // Target: maintain current angle, zoom out
      this.transitionTarget = {
        distance: this.orbitalDistance,
        theta: theta,
        phi: Math.max(0.2, Math.min(Math.PI - 0.2, phi)), // Clamp phi
      };
      // Update orbital state for when we arrive
      this.orbitalTheta = theta;
      this.orbitalPhi = this.transitionTarget.phi;
    }
    // For toSurface, target is calculated dynamically in _updateTransition
  }

  // ========================
  // FAST TRAVEL TRANSITIONS
  // ========================

  startFastTravelTransition() {
    // Enter fast travel view from current position
    if (this.transitioning) return;

    this.transitioning = true;
    this.transitionProgress = 0;
    this.transitionType = "toFastTravel";
    this.fastTravelEnabled = true;

    // Capture current camera state
    const pos = this.camera.position;
    const dist = pos.length();
    const theta = Math.atan2(pos.z, pos.x);
    const phi = Math.acos(pos.y / dist);

    this.transitionStart = {
      distance: dist,
      theta: theta,
      phi: phi,
    };

    // Target: maintain angle, zoom out to fast travel distance
    this.transitionTarget = {
      distance: this.fastTravelDistance,
      theta: theta,
      phi: Math.max(0.2, Math.min(Math.PI - 0.2, phi)),
    };

    // Update orbital state for when we arrive
    this.orbitalTheta = theta;
    this.orbitalPhi = this.transitionTarget.phi;
  }

  /**
   * Instantly enter fast travel mode (no transition)
   * Used for starting the game in fast travel view
   */
  enterFastTravelImmediate() {
    this.mode = "fastTravel";
    this.fastTravelEnabled = true;
    this.transitioning = false;

    // Keep current orbital angles (preserves random position on initial load)
    // Only reset if needed for respawn transitions
    // this.orbitalTheta and this.orbitalPhi already set from init or previous view

    // Position camera immediately at current angles
    this._positionCamera(
      this.fastTravelDistance,
      this.orbitalTheta,
      this.orbitalPhi,
    );
  }

  startPortalPreviewTransition(portalPosition, planet, portalIndex) {
    // Transition from fast travel to preview a specific portal
    if (this.transitioning) return;

    this.transitioning = true;
    this.transitionProgress = 0;
    this.transitionType = "toPortalPreview";

    // Store for tracking portal position during transition (planet rotates)
    this.previewPlanet = planet;
    this.previewPortalIndex = portalIndex;

    // Capture current camera state
    const pos = this.camera.position;
    const dist = pos.length();
    const theta = Math.atan2(pos.z, pos.x);
    const phi = Math.acos(pos.y / dist);

    this.transitionStart = {
      distance: dist,
      theta: theta,
      phi: phi,
    };

    // Calculate target angles from portal position
    const normal = portalPosition.clone().normalize();
    const targetTheta = Math.atan2(normal.z, normal.x);
    const targetPhi = Math.acos(normal.y);

    this.transitionTarget = {
      distance: this.previewDistance,
      theta: targetTheta,
      phi: targetPhi,
    };

    // Store preview state
    this.previewTheta = targetTheta;
    this.previewPhi = targetPhi;
  }

  returnToFastTravel(originPortalPosition) {
    // Return from preview to fast travel view, facing origin portal (or current view if no origin)
    if (this.transitioning) return;

    this.transitioning = true;
    this.transitionProgress = 0;
    this.transitionType = "toFastTravel";

    // Capture current camera state
    const pos = this.camera.position;
    const dist = pos.length();
    const theta = Math.atan2(pos.z, pos.x);
    const phi = Math.acos(pos.y / dist);

    this.transitionStart = {
      distance: dist,
      theta: theta,
      phi: phi,
    };

    let targetTheta, targetPhi;

    if (originPortalPosition) {
      // Calculate target angles to face the origin portal
      const normal = originPortalPosition.clone().normalize();
      targetTheta = Math.atan2(normal.z, normal.x);
      targetPhi = Math.acos(normal.y);
    } else {
      // No origin portal (initial deployment) - keep current orbital angles
      targetTheta = theta;
      targetPhi = phi;
    }

    // Return facing origin portal (or current view), zoom out
    this.transitionTarget = {
      distance: this.fastTravelDistance,
      theta: targetTheta,
      phi: Math.max(0.2, Math.min(Math.PI - 0.2, targetPhi)),
    };

    // Update orbital state for when we arrive
    this.orbitalTheta = targetTheta;
    this.orbitalPhi = this.transitionTarget.phi;
  }

  exitFastTravel() {
    // Exit fast travel mode and return to surface
    this.fastTravelEnabled = false;

    // Force-interrupt any current transition (e.g., toPortalPreview)
    // so we can immediately start the toSurface transition
    this.transitioning = false;

    this._startTransition("surface");
  }

  isFastTravelEnabled() {
    return this.fastTravelEnabled;
  }

  /**
   * Check if user is actively orbiting or just finished orbiting
   * Used to block profile/sponsor card popups during orbit
   * @returns {boolean} True if camera is being orbited (right-click drag or trackpad swipe)
   */
  isOrbiting() {
    // Block if:
    // - User moved while right-click dragging (_wasRightClickDrag stays true briefly after mouseup)
    // - User is currently orbiting via trackpad swipe
    return this._wasRightClickDrag || this._isTrackpadOrbiting;
  }

  // Alias for backwards compatibility
  wasRightClickDragging() {
    return this.isOrbiting();
  }

  // ========================
  // CONTROLS
  // ========================

  _setupControls() {
    const el = this.renderer.domElement;

    // Prevent context menu on right-click (we use it for camera orbit)
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    // ====== MOUSE CONTROLS ======
    // Right-click + drag = orbit camera
    // Track if user actually dragged to block profile cards on drag-release
    this._rightClickDragStart = null;
    this._wasRightClickDrag = false;

    el.addEventListener("mousedown", (e) => {
      if (window._authScreenInstance?.isVisible) return;
      if (e.button !== 2) return; // Only right-click

      const canDrag =
        (this.mode === "orbital" || this.mode === "fastTravel") &&
        !this.transitioning;
      if (canDrag) {
        this.isDragging = true;
        this._rightClickDragStart = { x: e.clientX, y: e.clientY };
        this._wasRightClickDrag = false;
        this.previousMouse = { x: e.clientX, y: e.clientY };
        this.lastMoveTime = performance.now();
        this.orbitalVelocity.theta = 0;
        this.orbitalVelocity.phi = 0;
      }
    });

    // Use window for mousemove/mouseup so dragging works even when mouse goes over UI elements
    window.addEventListener("mousemove", (e) => {
      if (window._authScreenInstance?.isVisible) return;
      const canDrag =
        (this.mode === "orbital" || this.mode === "fastTravel") &&
        !this.transitioning;
      if (this.isDragging && canDrag) {
        const dx = e.clientX - this.previousMouse.x;
        const dy = e.clientY - this.previousMouse.y;

        // Check if user has dragged enough to count as a real drag (blocks context menu actions)
        if (!this._wasRightClickDrag && this._rightClickDragStart) {
          const totalDx = e.clientX - this._rightClickDragStart.x;
          const totalDy = e.clientY - this._rightClickDragStart.y;
          if (Math.abs(totalDx) > 5 || Math.abs(totalDy) > 5) {
            this._wasRightClickDrag = true;
          }
        }

        const now = performance.now();
        const deltaTime = now - this.lastMoveTime;

        if (deltaTime > 0 && deltaTime < 100) {
          const thetaDelta = dx * 0.005;
          const phiDelta = -dy * 0.005;
          this.orbitalVelocity.theta = (thetaDelta / deltaTime) * 16;
          this.orbitalVelocity.phi = (phiDelta / deltaTime) * 16;
        }

        this.orbitalTheta += dx * 0.005;
        this.orbitalPhi -= dy * 0.005;

        const minPhi = (10 * Math.PI) / 180;
        const maxPhi = (170 * Math.PI) / 180;
        this.orbitalPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitalPhi));

        this.previousMouse = { x: e.clientX, y: e.clientY };
        this.lastMoveTime = now;
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) {
        this.isDragging = false;
        // Keep _wasRightClickDrag true briefly so contextmenu handler can check it
        // (contextmenu fires after mouseup)
        setTimeout(() => {
          this._wasRightClickDrag = false;
        }, 100);
      }
    });

    // ====== WHEEL CONTROLS ======
    // deltaX → trackpad horizontal orbit.
    // deltaY → trackpad vertical orbit OR mouse wheel zoom.
    // Device detection via gesture-level state machine (_classifyWheelDevice).
    // Pinch gesture (ctrlKey) → zoom.
    // Keyboard +/- → zoom.
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (window._authScreenInstance?.isVisible) return;

        // Pinch gesture (ctrlKey) = zoom between surface/orbital
        if (e.ctrlKey) {
          if (this.transitioning) return;
          if (this.fastTravelEnabled) return;

          this._pinchAccumulator = (this._pinchAccumulator || 0) + e.deltaY;

          if (Math.abs(this._pinchAccumulator) > 60) {
            if (this._pinchAccumulator > 0) {
              this._startTransition("orbital");
            } else {
              this._startTransition("surface");
            }
            this._pinchAccumulator = 0;
          }
          return;
        }

        this._pinchAccumulator = 0;

        // Classify input device for this gesture
        const device = this._classifyWheelDevice(e);

        // deltaX → orbit (horizontal only)
        if (Math.abs(e.deltaX) > 0) {
          const canDrag =
            (this.mode === "orbital" || this.mode === "fastTravel") &&
            !this.transitioning;

          if (canDrag) {
            this._isTrackpadOrbiting = true;
            clearTimeout(this._trackpadOrbitTimeout);
            this._trackpadOrbitTimeout = setTimeout(() => {
              this._isTrackpadOrbiting = false;
            }, 150);

            const sensitivity = 0.001;
            this.orbitalTheta -= e.deltaX * sensitivity;
            this.orbitalVelocity.theta = -e.deltaX * sensitivity * 0.3;
          }
        }

        // deltaY → mouse wheel zooms, trackpad orbits vertically
        if (Math.abs(e.deltaY) > 0) {
          if (device === "mouse") {
            // Mouse wheel → zoom (mode transition)
            if (this.transitioning) return;
            if (this.fastTravelEnabled) return;

            this._scrollAccumulator =
              (this._scrollAccumulator || 0) + e.deltaY;

            if (Math.abs(this._scrollAccumulator) > 120) {
              if (this._scrollAccumulator > 0) {
                if (this.mode === "surface") {
                  this._startTransition("orbital");
                }
              } else {
                if (this.mode === "orbital") {
                  this._startTransition("surface");
                }
              }
              this._scrollAccumulator = 0;
            }
          } else {
            // Trackpad → orbit (vertical)
            const canDrag =
              (this.mode === "orbital" || this.mode === "fastTravel") &&
              !this.transitioning;

            if (canDrag) {
              this._isTrackpadOrbiting = true;
              clearTimeout(this._trackpadOrbitTimeout);
              this._trackpadOrbitTimeout = setTimeout(() => {
                this._isTrackpadOrbiting = false;
              }, 150);

              const sensitivity = 0.001;
              this.orbitalPhi += e.deltaY * sensitivity;

              const minPhi = (10 * Math.PI) / 180;
              const maxPhi = (170 * Math.PI) / 180;
              this.orbitalPhi = Math.max(
                minPhi,
                Math.min(maxPhi, this.orbitalPhi),
              );

              this.orbitalVelocity.phi = e.deltaY * sensitivity * 0.3;
            }
          }
        }
      },
      { passive: false },
    );

    // ====== KEYBOARD ZOOM ======
    // +/- keys zoom between surface/orbital (works regardless of scroll setting)
    window.addEventListener("keydown", (e) => {
      if (window._authScreenInstance?.isVisible || window._modalOpen) return;
      const _tag = document.activeElement?.tagName;
      if (_tag === "INPUT" || _tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      if (e.key === "+" || e.key === "=") {
        if (this.mode === "orbital" && !this.fastTravelEnabled) {
          this._startTransition("surface");
        }
      } else if (e.key === "-") {
        if (this.mode === "surface") {
          this._startTransition("orbital");
        }
      }
    });

    // ====== TOUCH CONTROLS (for actual touchscreens) ======
    let touchStartDistance = 0;
    let lastTouchCenter = { x: 0, y: 0 };

    el.addEventListener(
      "touchstart",
      (e) => {
        if (window._authScreenInstance?.isVisible) return;
        if (e.touches.length === 2) {
          const canDrag =
            (this.mode === "orbital" || this.mode === "fastTravel") &&
            !this.transitioning;
          if (canDrag) {
            e.preventDefault();
            this.isDragging = true;
            this.orbitalVelocity.theta = 0;
            this.orbitalVelocity.phi = 0;
            this.lastMoveTime = performance.now();

            const t1 = e.touches[0];
            const t2 = e.touches[1];
            lastTouchCenter = {
              x: (t1.clientX + t2.clientX) / 2,
              y: (t1.clientY + t2.clientY) / 2,
            };
            touchStartDistance = Math.hypot(
              t2.clientX - t1.clientX,
              t2.clientY - t1.clientY,
            );
          }
        }
      },
      { passive: false },
    );

    el.addEventListener(
      "touchmove",
      (e) => {
        if (window._authScreenInstance?.isVisible) return;
        if (e.touches.length === 2 && this.isDragging) {
          const canDrag =
            (this.mode === "orbital" || this.mode === "fastTravel") &&
            !this.transitioning;
          if (!canDrag) return;

          e.preventDefault();

          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const currentCenter = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2,
          };
          const currentDistance = Math.hypot(
            t2.clientX - t1.clientX,
            t2.clientY - t1.clientY,
          );

          const dx = currentCenter.x - lastTouchCenter.x;
          const dy = currentCenter.y - lastTouchCenter.y;

          const now = performance.now();
          const deltaTime = now - this.lastMoveTime;

          if (deltaTime > 0 && deltaTime < 100) {
            const thetaDelta = dx * 0.005;
            const phiDelta = -dy * 0.005;
            this.orbitalVelocity.theta = (thetaDelta / deltaTime) * 16;
            this.orbitalVelocity.phi = (phiDelta / deltaTime) * 16;
          }

          this.orbitalTheta += dx * 0.005;
          this.orbitalPhi -= dy * 0.005;

          const minPhi = (10 * Math.PI) / 180;
          const maxPhi = (170 * Math.PI) / 180;
          this.orbitalPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitalPhi));

          // Pinch = zoom
          if (!this.fastTravelEnabled) {
            const pinchDelta = currentDistance - touchStartDistance;
            if (Math.abs(pinchDelta) > 30) {
              if (pinchDelta < 0) {
                this._startTransition("orbital");
              } else {
                this._startTransition("surface");
              }
              touchStartDistance = currentDistance;
            }
          }

          lastTouchCenter = currentCenter;
          this.lastMoveTime = now;
        }
      },
      { passive: false },
    );

    el.addEventListener("touchend", () => {
      this.isDragging = false;
    });
  }

  // ========================
  // HELPERS
  // ========================

  _applyOrbitalMomentum() {
    // Apply momentum when not dragging
    if (!this.isDragging) {
      const minVelocity = 0.0001;

      if (
        Math.abs(this.orbitalVelocity.theta) > minVelocity ||
        Math.abs(this.orbitalVelocity.phi) > minVelocity
      ) {
        this.orbitalTheta += this.orbitalVelocity.theta;
        this.orbitalPhi += this.orbitalVelocity.phi;

        // Clamp phi to avoid gimbal lock (10° to 170°)
        const minPhi = (10 * Math.PI) / 180;
        const maxPhi = (170 * Math.PI) / 180;
        this.orbitalPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitalPhi));

        // Apply friction decay
        this.orbitalVelocity.theta *= this.orbitalFriction;
        this.orbitalVelocity.phi *= this.orbitalFriction;

        // Stop if below threshold
        if (Math.abs(this.orbitalVelocity.theta) < minVelocity) {
          this.orbitalVelocity.theta = 0;
        }
        if (Math.abs(this.orbitalVelocity.phi) < minVelocity) {
          this.orbitalVelocity.phi = 0;
        }
      }
    }
  }

  _classifyWheelDevice(e) {
    const now = performance.now();
    const gesture = this._wheelGesture;
    const timeSinceLast = now - gesture.lastEventTime;

    // After 400ms gap, start a new gesture
    if (!gesture.active || timeSinceLast > 400) {
      gesture.active = true;
      gesture.device = null;
      gesture.eventCount = 0;
      gesture.totalDeltaX = 0;
      this._scrollAccumulator = 0;
    }

    gesture.lastEventTime = now;
    gesture.eventCount++;
    gesture.totalDeltaX += Math.abs(e.deltaX);

    // Reset gesture-end timeout
    clearTimeout(gesture.timeoutId);
    gesture.timeoutId = setTimeout(() => {
      gesture.active = false;
      gesture.device = null;
      gesture.eventCount = 0;
      gesture.totalDeltaX = 0;
      this._scrollAccumulator = 0;
    }, 400);

    // Already classified — return cached result
    if (gesture.device !== null) {
      return gesture.device;
    }

    // Firefox line-mode = mouse wheel
    if (e.deltaMode === 1) {
      gesture.device = "mouse";
      return "mouse";
    }

    // Any horizontal delta = trackpad (mice don't produce deltaX)
    if (Math.abs(e.deltaX) > 0 || gesture.totalDeltaX > 0) {
      gesture.device = "trackpad";
      return "trackpad";
    }

    // Mouse wheel hardware sends wheelDeltaY in multiples of 120
    // Trackpad sends wheelDeltaY = deltaY * 3 (small, variable, not multiples of 120)
    if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 &&
        e.wheelDeltaY % 120 === 0) {
      gesture.device = "mouse";
      return "mouse";
    }

    // Rapid stream of events without a 120-multiple = trackpad
    if (gesture.eventCount >= 3 && timeSinceLast < 30) {
      gesture.device = "trackpad";
      return "trackpad";
    }

    // Default: trackpad (don't lock — let subsequent events re-evaluate)
    return "trackpad";
  }

  _applyShake(deltaTime) {
    // Generate random offset based on current intensity
    const offset = this.shake.maxOffset * this.shake.intensity;
    this.shake.offset.set(
      (Math.random() - 0.5) * 2 * offset,
      (Math.random() - 0.5) * 2 * offset,
      (Math.random() - 0.5) * 2 * offset,
    );

    // Apply offset to camera position
    this.camera.position.add(this.shake.offset);

    // Decay intensity
    this.shake.intensity -= this.shake.decay * deltaTime;
    if (this.shake.intensity < 0) {
      this.shake.intensity = 0;
    }
  }

  _positionCamera(distance, theta, phi) {
    // Spherical to Cartesian
    const x = distance * Math.sin(phi) * Math.cos(theta);
    const y = distance * Math.cos(phi);
    const z = distance * Math.sin(phi) * Math.sin(theta);

    this.camera.position.set(x, y, z);
  }

  // Delegate to shared MathUtils
  _smoothstep(t) {
    return MathUtils.smoothstep(t);
  }

  _lerp(a, b, t) {
    return MathUtils.lerp(a, b, t);
  }

  _lerpAngle(a, b, t) {
    return MathUtils.lerpAngle(a, b, t);
  }
}
