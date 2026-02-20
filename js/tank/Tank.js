/**
 * AdLands - Tank Module
 * Cobalt Faction player controller
 * 5 units long tank body with WASD controls and mouse-aimed turret
 */

class Tank {
  constructor(scene, sphereRadius, options = {}) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;

    // Default to cobalt faction colors from global FACTION_COLORS
    this.colors = {
      primary: FACTION_COLORS.cobalt.vehicle.primary,
      secondary: FACTION_COLORS.cobalt.vehicle.secondary,
      tracks: 0x222222, // Dark gray
      barrel: 0x333333, // Gunmetal
    };

    // Physics configuration (scaled for doubled world size)
    this.physics = {
      maxSpeed: 0.0004, // Units per frame (forward and reverse)
      acceleration: 0.00001, // Units per frame² (~30 frames to max)
      deceleration: 0.00001, // Units per frame² (slightly faster stop)
      turnRate: 0.015, // Radians per frame (~1.7°)
    };

    // Health
    this.hp = 100;
    this.maxHp = 100;
    this.isDead = false;
    this.faction = "cobalt"; // Default faction, set via setFactionColors
    this.lastSpawnTime = Date.now(); // Track spawn time for title system lifespan

    // Damage state
    this.damageState = "healthy"; // 'healthy', 'damaged', 'critical', 'dead'

    // State
    this.state = {
      // Position on sphere (spherical coordinates)
      theta: 0, // Longitude (0 to 2π)
      phi: Math.PI / 2, // Latitude (π/2 = equator)

      // Movement
      speed: 0, // Current speed (positive = forward, negative = reverse)
      heading: 0, // Direction facing in tangent plane

      // Turret
      turretAngle: 0,
      turretTargetAngle: 0,
      turretAngularVelocity: 0,

      // Input
      keys: { w: false, a: false, s: false, d: false, shift: false },

      // Death state (for tread dust/tracks to check)
      isDead: false,

      // Wiggle animation phase
      wigglePhase: 0,

      // Momentum lean state (spring-based pitch + steer lean)
      lean: {
        pitchAngle: 0, pitchVelocity: 0,
        steerAngle: 0, steerVelocity: 0,
        prevSpeed: 0, prevHeading: 0,
        initialized: false,
      },
    };

    // Mouse tracking for turret aim
    this.mousePosition = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();

    // Control state (can be disabled during fast travel)
    this.controlsEnabled = true;

    // Multiplayer mode: when true, skip local physics (server is authoritative)
    this.multiplayerMode = false;

    // Create tank mesh
    this.group = new THREE.Group();
    this.turretGroup = null;
    this.barrelMesh = null;
    this.muzzleMesh = null;

    // LOD references
    this.lodMesh = null;
    this.shadowBlob = null;
    this.detailedMeshes = [];

    // Barrel recoil state
    this.recoil = {
      current: 0, // Current recoil offset (0 = resting, 1 = max recoil)
      target: 0, // Target recoil (set to 1 on fire, 0 to recover)
      maxOffset: 0.8, // Maximum backward offset in units
      fireSpeed: 0.5, // How fast to recoil back (lower = faster snap)
      recoverSpeed: 0.08, // How fast to return to resting position
    };

    // Turret rotation physics (critically-damped spring)
    this.turretPhysics = {
      maxAngularSpeed: Math.PI * 1.5, // 270 deg/s cap
      stiffness: 25,
      damping: 10,
    };

    this._buildTank();
    this._createHitbox();
    this._createLOD();
    if (!options.skipInput) {
      this._setupInput();
      this._createGhostReticle();
    }

    // Initialize position
    this._updateVisual(0);
    if (!options.skipScene) {
      scene.add(this.group);
    }
    // Start hidden — tank becomes visible only after deployment
    this._hidden = true;
    this.group.visible = false;
  }

  // ========================
  // PUBLIC METHODS
  // ========================

  update(camera, planetRotationSpeed, deltaTime = 1 / 60) {
    if (this.isDead) {
      // Counter planet rotation so dead tank stays fixed on surface
      // (in MP, server also counter-rotates; next state snap corrects any drift)
      this._moveOnSphere(planetRotationSpeed, deltaTime);
      // Always update visual from theta/phi so dead tank tracks planet rotation
      this._updateVisual(deltaTime);
      if (this.ghostReticle) this.ghostReticle.style.display = "none";
      return;
    }
    if (this.ghostReticle) {
      this.ghostReticle.style.display = this.isSurfaceView ? "" : "none";
    }
    // Local physics + terrain collision run in both SP and MP.
    // In MP, server reconciliation corrects any prediction drift each tick.
    this._updatePhysics(deltaTime);
    this._moveOnSphere(planetRotationSpeed, deltaTime);
    // Visual + turret always run
    this._updateVisual(deltaTime);
    this._updateTurret(camera);
    this._updateTurretSpring(deltaTime);
    this._updateGhostReticle(camera);
    this.updateRecoil(deltaTime);
  }

  getPosition() {
    return this.group.position.clone();
  }

  getCurrentClusterId(planet) {
    return planet.getClusterIdAtPosition(this.group.position);
  }

  setPlanet(planet) {
    this.planet = planet;
  }

  /**
   * Check if current position is on elevated terrain and revert if so.
   * Used by MP reconciliation replay to enforce terrain collision.
   * @param {number} prevTheta - theta before the move
   * @param {number} prevPhi - phi before the move
   * @param {number} planetRotationSpeed - for rotation compensation on revert
   * @param {number} deltaTime - frame delta
   * @returns {boolean} true if collision detected and position reverted
   */
  checkTerrainCollision(prevTheta, prevPhi, planetRotationSpeed, deltaTime) {
    if (!this.planet?.terrainElevation) {
      // Fallback: phi-based polar check when no terrain system
      const fallbackLimit = (10 * Math.PI) / 180; // 10° hard limit
      if (this.state.phi < fallbackLimit || this.state.phi > Math.PI - fallbackLimit) {
        const dt60 = deltaTime * 60;
        const rotDelta = (planetRotationSpeed * dt60) / 60;
        this.state.theta = prevTheta - rotDelta;
        if (this.state.theta < 0) this.state.theta += Math.PI * 2;
        if (this.state.theta > Math.PI * 2) this.state.theta -= Math.PI * 2;
        this.state.phi = prevPhi;
        this.state.speed = 0;
        return true;
      }
      return false;
    }

    const r = this.sphereRadius;
    const t = Tank._terrainTemp;
    const sinPhi = Math.sin(this.state.phi);
    const cosPhi = Math.cos(this.state.phi);
    const sinTheta = Math.sin(this.state.theta);
    const cosTheta = Math.cos(this.state.theta);

    // Check center position (no forward probe — reconcile already moved)
    t.testPos.set(
      r * sinPhi * cosTheta,
      r * cosPhi,
      r * sinPhi * sinTheta,
    );
    this.planet.hexGroup.worldToLocal(t.testPos);

    // Precise polar hole check using actual hex boundary polygon
    const inPolar = this.planet.isInsidePolarHole
      ? this.planet.isInsidePolarHole(t.testPos)
      : this.planet.polarTileIndices.has(
          this.planet.terrainElevation.getNearestTileIndex(t.testPos)
        );
    const tileIdx = this.planet.terrainElevation.getNearestTileIndex(t.testPos);
    if (inPolar || (tileIdx >= 0 &&
      this.planet.terrainElevation.getElevationAtTileIndex(tileIdx) > 0
    )) {
      const dt60 = deltaTime * 60;
      const rotDelta = (planetRotationSpeed * dt60) / 60;
      this.state.theta = prevTheta - rotDelta;
      if (this.state.theta < 0) this.state.theta += Math.PI * 2;
      if (this.state.theta > Math.PI * 2) this.state.theta -= Math.PI * 2;
      this.state.phi = prevPhi;
      this.state.speed = 0;
      return true;
    }
    return false;
  }

  setCannonSystem(cannonSystem) {
    this.cannonSystem = cannonSystem;
  }

  setControlsEnabled(enabled) {
    this.controlsEnabled = enabled;
    if (!enabled) {
      // Reset all keys and stop movement when disabling
      this.state.keys = {
        w: false,
        a: false,
        s: false,
        d: false,
        shift: false,
      };
      this.state.speed = 0;
      // Hide ghost reticle when controls disabled
      if (this.ghostReticle) this.ghostReticle.style.display = "none";
    }
  }

  setVisible(visible) {
    this._hidden = !visible;
    this.group.visible = visible;
  }

  // Teleport tank to spherical coordinates
  teleportTo(theta, phi) {
    this.state.theta = theta;
    this.state.phi = phi;
    this.state.speed = 0;
    this.state.turretAngularVelocity = 0;
    this._updateVisual(0);
  }

  setFactionColors(faction) {
    this.faction = faction; // Track faction for damage system

    // Use global FACTION_COLORS for vehicle palettes
    const factionData = FACTION_COLORS[faction];
    if (!factionData || !factionData.vehicle) return;

    const palette = factionData.vehicle;
    this.colors.primary = palette.primary;
    this.colors.secondary = palette.secondary;

    // Update existing materials
    this.group.traverse((child) => {
      if (child.isMesh && child.material) {
        const color = child.material.color?.getHex();
        if (!color) return;
        // Match old colors to update (hull and turret only)
        if (
          color === 0x3a5f7d ||
          color === 0x8b4444 ||
          color === 0x4a7a4a ||
          color === FACTION_COLORS.cobalt.vehicle.primary ||
          color === FACTION_COLORS.rust.vehicle.primary ||
          color === FACTION_COLORS.viridian.vehicle.primary
        ) {
          child.material.color.setHex(palette.primary);
        } else if (
          color === 0x2a4560 ||
          color === 0x6b3333 ||
          color === 0x3a5a3a ||
          color === FACTION_COLORS.cobalt.vehicle.secondary ||
          color === FACTION_COLORS.rust.vehicle.secondary ||
          color === FACTION_COLORS.viridian.vehicle.secondary
        ) {
          child.material.color.setHex(palette.secondary);
        }
      }
    });

    // Update LOD material color
    this._updateLODColor();
  }

  // ========================
  // BARREL RECOIL
  // ========================

  triggerRecoil() {
    this.recoil.current = 1; // Instantly snap to max recoil
    this.recoil.target = 0; // Then recover back to resting
  }

  updateRecoil(deltaTime) {
    if (this.recoil.current <= 0) return;

    // Smoothly return to resting position (frame-rate independent)
    const dt60 = deltaTime * 60;
    const lerpFactor = 1 - Math.pow(1 - this.recoil.recoverSpeed, dt60);
    this.recoil.current +=
      (this.recoil.target - this.recoil.current) * lerpFactor;

    // Clamp and apply offset
    if (this.recoil.current < 0.01) {
      this.recoil.current = 0;
    }

    // Apply recoil offset to barrel and muzzle (move backward = positive Z)
    const offset = this.recoil.current * this.recoil.maxOffset;
    this.barrelMesh.position.z = this.barrelBaseZ + offset;
    this.muzzleMesh.position.z = this.muzzleBaseZ + offset;
  }

  // ========================
  // PHYSICS
  // ========================

  _updatePhysics(deltaTime) {
    if (!this.controlsEnabled || window._modalOpen) return;

    const { keys } = this.state;
    const p = this.physics;

    // Scale physics by deltaTime (normalized to 60 FPS baseline)
    const dt60 = deltaTime * 60;

    // Apply weapon slot speed modifier
    let baseMaxSpeed = p.maxSpeed;
    if (window.weaponSlotSystem) {
      baseMaxSpeed *= window.weaponSlotSystem.getModifiers().speedMultiplier;
    }

    // Sprint mode (5x speed when holding shift)
    const currentMaxSpeed = keys.shift ? baseMaxSpeed * 5 : baseMaxSpeed;

    // Steering (only when keys pressed) - scaled by deltaTime
    if (keys.a) this.state.heading -= p.turnRate * dt60;
    if (keys.d) this.state.heading += p.turnRate * dt60;

    // Normalize heading to [0, 2π]
    while (this.state.heading < 0) this.state.heading += Math.PI * 2;
    while (this.state.heading >= Math.PI * 2) this.state.heading -= Math.PI * 2;

    // Acceleration / Deceleration - scaled by deltaTime
    if (keys.s) {
      // Accelerate forward
      this.state.speed += p.acceleration * dt60;
      if (this.state.speed > currentMaxSpeed) {
        this.state.speed = currentMaxSpeed;
      }
    } else if (keys.w) {
      // Accelerate reverse
      this.state.speed -= p.acceleration * dt60;
      if (this.state.speed < -currentMaxSpeed) {
        this.state.speed = -currentMaxSpeed;
      }
    } else {
      // No input - decelerate toward zero
      if (this.state.speed > 0) {
        this.state.speed -= p.deceleration * dt60;
        if (this.state.speed < 0) this.state.speed = 0;
      } else if (this.state.speed < 0) {
        this.state.speed += p.deceleration * dt60;
        if (this.state.speed > 0) this.state.speed = 0;
      }
    }
  }

  _moveOnSphere(planetRotationSpeed, deltaTime) {
    // Save previous position for terrain collision rollback
    const prevTheta = this.state.theta;
    const prevPhi = this.state.phi;

    // Use shared static helper with player-style entity shape
    const entity = {
      state: { speed: this.state.speed },
      heading: this.state.heading,
      theta: this.state.theta,
      phi: this.state.phi,
    };
    Tank.moveEntityOnSphere(
      entity,
      planetRotationSpeed,
      deltaTime,
    );
    this.state.theta = entity.theta;
    this.state.phi = entity.phi;

    // Collision with wall sliding
    if (this.planet && this.state.speed !== 0) {
      if (this._isTerrainBlocked(this.state.theta, this.state.phi)) {
        const dt60 = deltaTime * 60;
        const rotDelta = (planetRotationSpeed * dt60) / 60;
        let thetaRev = prevTheta - rotDelta;
        if (thetaRev < 0) thetaRev += Math.PI * 2;
        if (thetaRev > Math.PI * 2) thetaRev -= Math.PI * 2;

        // Wall sliding: try each axis independently before full revert
        if (!this._isTerrainBlocked(this.state.theta, prevPhi)) {
          // Slide along latitude (theta moved, phi reverted)
          this.state.phi = prevPhi;
          this.state.speed *= 0.85;
        } else if (!this._isTerrainBlocked(thetaRev, this.state.phi)) {
          // Slide along longitude (theta reverted, phi moved)
          this.state.theta = thetaRev;
          this.state.speed *= 0.85;
        } else {
          // Both axes blocked — full revert with speed decay
          this.state.theta = thetaRev;
          this.state.phi = prevPhi;
          this.state.speed *= 0.3;
        }
      }
    }
  }

  _isTerrainBlocked(theta, phi) {
    if (!this.planet || !this.planet.terrainElevation) return false;
    const r = this.sphereRadius;
    const t = Tank._terrainTemp;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const cosH = Math.cos(this.state.heading);
    const sinH = Math.sin(this.state.heading);
    const dir = Math.sign(this.state.speed);

    const cx = r * sinPhi * cosTheta;
    const cy = r * cosPhi;
    const cz = r * sinPhi * sinTheta;

    const fwd_x = -cosH * cosPhi * cosTheta + sinH * sinTheta;
    const fwd_y =  cosH * sinPhi;
    const fwd_z = -cosH * cosPhi * sinTheta - sinH * cosTheta;
    const rgt_x = -sinH * cosPhi * cosTheta - cosH * sinTheta;
    const rgt_y =  sinH * sinPhi;
    const rgt_z = -sinH * cosPhi * sinTheta + cosH * cosTheta;

    for (const [fwd, rgt] of Tank._collisionProbes) {
      const f = fwd * dir;
      t.testPos.set(
        cx + fwd_x * f + rgt_x * rgt,
        cy + fwd_y * f + rgt_y * rgt,
        cz + fwd_z * f + rgt_z * rgt,
      );
      this.planet.hexGroup.worldToLocal(t.testPos);

      const inPolar = this.planet.isInsidePolarHole
        ? this.planet.isInsidePolarHole(t.testPos)
        : this.planet.polarTileIndices.has(
            this.planet.terrainElevation.getNearestTileIndex(t.testPos)
          );
      if (inPolar) return true;

      const tileIdx = this.planet.terrainElevation.getNearestTileIndex(t.testPos);
      if (tileIdx >= 0 &&
        this.planet.terrainElevation.getElevationAtTileIndex(tileIdx) > 0
      ) {
        return true;
      }
    }
    return false;
  }

  // ========================
  // VISUAL UPDATE
  // ========================

  _updateVisual(deltaTime) {
    // Update wiggle phase based on speed
    const speed = Math.abs(this.state.speed);
    if (speed > 0.00001 && deltaTime > 0) {
      // Wiggle frequency: faster base rate + speed-dependent increase
      // At max speed (0.0004), frequency is about 20-30 rad/s (~4-5 Hz)
      const speedRatio = Math.min(speed / 0.0004, 1);
      this.state.wigglePhase += deltaTime * (12 + speedRatio * 18);
    }

    // Update momentum lean springs
    Tank.updateLeanState(this.state.lean, this.state.speed, this.state.heading, deltaTime, this.isDead);

    // Use shared static helper with player-style entity shape
    const entity = {
      theta: this.state.theta,
      phi: this.state.phi,
      heading: this.state.heading,
      group: this.group,
      bodyGroup: this.bodyGroup,
      speed: this.state.speed,
      wigglePhase: this.state.wigglePhase,
      currentRollAngle: 0,
      hp: this.hp,
      maxHp: this.maxHp,
      isDead: this.isDead,
      lean: this.state.lean,
    };
    Tank.updateEntityVisual(entity, this.sphereRadius);

    // Store roll angle for turret compensation
    this.state.currentRollAngle = entity.currentRollAngle || 0;
  }

  _updateTurret(camera) {
    this.raycaster.setFromCamera(this.mousePosition, camera);

    // Use preallocated turret temp objects
    const t = Tank._turretTemp;
    t.tankPos.copy(this.group.position);
    t.normal.copy(t.tankPos).normalize();
    t.plane.set(t.normal, -t.tankPos.length());

    const hit = this.raycaster.ray.intersectPlane(t.plane, t.intersection);

    if (hit) {
      t.toTarget.copy(t.intersection).sub(t.tankPos);

      // Build stable orientation matrix WITHOUT wiggle
      // (Same logic as updateEntityVisual before wiggle is applied)
      if (Math.abs(t.normal.y) > 0.999) {
        t.east.set(0, 0, 1).cross(t.normal).normalize();
      } else {
        t.east.set(0, 1, 0).cross(t.normal).normalize();
      }

      t.north.crossVectors(t.normal, t.east).normalize();

      // Forward direction from heading
      t.forward.set(0, 0, 0);
      t.forward.addScaledVector(t.north, Math.cos(this.state.heading));
      t.forward.addScaledVector(t.east, Math.sin(this.state.heading));
      t.forward.normalize();

      // Build rotation matrix from basis vectors (no wiggle)
      // THREE.js uses -Z as forward, so we use forward for Z column
      t.right.crossVectors(t.forward, t.normal).normalize();

      t.stableMatrix.makeBasis(t.right, t.normal, t.forward);
      t.stableMatrix.setPosition(t.tankPos);

      // Transform target direction through stable inverse matrix
      t.invMatrix.copy(t.stableMatrix).invert();
      t.toTarget.applyMatrix4(t.invMatrix);

      // In local space: +Z is forward, add PI to point barrel (not back) at target
      this.state.turretTargetAngle =
        Math.atan2(-t.toTarget.x, t.toTarget.z) + Math.PI;
    }
  }

  _updateTurretSpring(deltaTime) {
    const tp = this.turretPhysics;
    const s = this.state;

    // Shortest angular delta (wraps at +/-PI)
    let delta = s.turretTargetAngle - s.turretAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    // Critically-damped spring
    s.turretAngularVelocity +=
      (tp.stiffness * delta - tp.damping * s.turretAngularVelocity) * deltaTime;

    // Clamp to max angular speed
    if (s.turretAngularVelocity > tp.maxAngularSpeed) {
      s.turretAngularVelocity = tp.maxAngularSpeed;
    } else if (s.turretAngularVelocity < -tp.maxAngularSpeed) {
      s.turretAngularVelocity = -tp.maxAngularSpeed;
    }

    // Snap when very close
    if (Math.abs(delta) < 0.001 && Math.abs(s.turretAngularVelocity) < 0.01) {
      s.turretAngle = s.turretTargetAngle;
      s.turretAngularVelocity = 0;
    } else {
      s.turretAngle += s.turretAngularVelocity * deltaTime;
    }

    // Normalize to [0, 2PI]
    while (s.turretAngle < 0) s.turretAngle += Math.PI * 2;
    while (s.turretAngle >= Math.PI * 2) s.turretAngle -= Math.PI * 2;

    // Apply turret rotation
    const t = Tank._turretTemp;
    this.turretGroup.quaternion.setFromAxisAngle(t.yAxis, s.turretAngle);
  }

  _createGhostReticle() {
    this.ghostReticle = document.createElement("div");
    this.ghostReticle.id = "turret-ghost-reticle";
    this.ghostReticle.style.cssText =
      "position:fixed;width:32px;height:32px;pointer-events:none;z-index:9999;" +
      "will-change:transform;transform:translate(-50%,-50%);display:none;";
    document.body.appendChild(this.ghostReticle);
  }

  _updateGhostReticle(camera) {
    if (!this.ghostReticle) return;

    const t = Tank._turretTemp;

    // Barrel direction in local space, rotated by turretAngle
    t.aimDir.set(0, 0, -1);
    t.aimDir.applyAxisAngle(t.yAxis, this.state.turretAngle);

    // Transform to world-space direction
    t.aimDir.transformDirection(this.group.matrixWorld);

    // Place at cannon's current range (dynamic with charge level)
    const range = this.cannonSystem
      ? this.cannonSystem.getCurrentRange()
      : 20;
    t.aimPoint.copy(this.group.position).addScaledVector(t.aimDir, range);

    // Project to screen coordinates
    t.aimPoint.project(camera);
    const screenX = (t.aimPoint.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-t.aimPoint.y * 0.5 + 0.5) * window.innerHeight;

    this.ghostReticle.style.left = screenX + "px";
    this.ghostReticle.style.top = screenY + "px";

    // Color based on alignment: cyan when aligned, light gray when not
    let angleDiff = this.state.turretTargetAngle - this.state.turretAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    const aligned = Math.abs(angleDiff) < 0.035; // ~2 degrees

    // Trigger double flash on lock-on (rising edge)
    if (aligned && !this._ghostAligned) {
      this._ghostFlashCount = 0;
      this._ghostFlashTime = performance.now();
    }
    this._ghostAligned = aligned;

    // Double flash animation
    let flashOn = false;
    if (this._ghostFlashCount !== undefined && this._ghostFlashCount < 2) {
      const elapsed = performance.now() - this._ghostFlashTime;
      const pulseIndex = Math.floor(elapsed / 260);
      if (pulseIndex >= 2) {
        this._ghostFlashCount = 2; // Done
      } else {
        this._ghostFlashCount = pulseIndex;
        flashOn = (elapsed % 260) < 160;
      }
    }

    // During flash: blink on/off. After flash: follow aligned state.
    const flashing = this._ghostFlashCount !== undefined && this._ghostFlashCount < 2;
    const bright = flashing ? flashOn : aligned;
    const color = bright ? "#00ffff" : "#888";
    const outline = bright ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.3)";
    this.ghostReticle.style.boxShadow =
      `inset 0 0 0 2px ${color}, inset 0 0 0 4px ${outline}`;
  }

  // ========================
  // TANK CONSTRUCTION
  // ========================

  _buildTank() {
    const { primary, secondary, tracks, barrel } = this.colors;

    // Materials
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: primary,
      roughness: 0.7,
      metalness: 0.3,
      flatShading: true,
    });

    const turretMaterial = new THREE.MeshStandardMaterial({
      color: secondary,
      roughness: 0.6,
      metalness: 0.4,
      flatShading: true,
    });

    const trackMaterial = new THREE.MeshStandardMaterial({
      color: tracks,
      roughness: 0.9,
      metalness: 0.1,
      flatShading: true,
    });

    const barrelMaterial = new THREE.MeshStandardMaterial({
      color: barrel,
      roughness: 0.5,
      metalness: 0.6,
      flatShading: true,
    });

    // Body group — lean/wiggle applied here, not on outer group
    // Headlights, hitbox, LOD, shadow stay on outer group (unaffected by lean)
    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    // Hull (2.5 × 0.8 × 5)
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 0.8, 5),
      hullMaterial,
    );
    hull.position.y = 0.4;
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.bodyGroup.add(hull);

    // Front slope (2.2 × 0.5 × 1.0)
    const frontSlope = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.5, 1.0),
      hullMaterial,
    );
    frontSlope.position.set(0, 0.7, -2.5);
    frontSlope.rotation.x = 0.3;
    frontSlope.castShadow = true;
    frontSlope.receiveShadow = true;
    this.bodyGroup.add(frontSlope);

    // Rear (2.2 × 1.0 × 0.8)
    const rear = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.0, 0.8),
      hullMaterial,
    );
    rear.position.set(0, 0.5, 2.6);
    rear.castShadow = true;
    rear.receiveShadow = true;
    this.bodyGroup.add(rear);

    // Tracks (0.6 × 0.6 × 5.2)
    const trackGeom = new THREE.BoxGeometry(0.6, 0.6, 5.2);

    const leftTrack = new THREE.Mesh(trackGeom, trackMaterial);
    leftTrack.position.set(-1.3, 0.3, 0);
    leftTrack.castShadow = true;
    leftTrack.receiveShadow = true;
    this.bodyGroup.add(leftTrack);

    const rightTrack = new THREE.Mesh(trackGeom, trackMaterial);
    rightTrack.position.set(1.3, 0.3, 0);
    rightTrack.castShadow = true;
    rightTrack.receiveShadow = true;
    this.bodyGroup.add(rightTrack);

    // Turret group
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.y = 0.8;

    // Turret base (1.5 × 0.6 × 1.8)
    const turret = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.6, 1.8),
      turretMaterial,
    );
    turret.position.y = 0.3;
    turret.castShadow = true;
    turret.receiveShadow = true;
    this.turretGroup.add(turret);

    // Barrel (cylinder, radius 0.15→0.2, length 2.5)
    this.barrelMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.2, 2.5, 8),
      barrelMaterial,
    );
    this.barrelMesh.rotation.x = -Math.PI / 2;
    this.barrelMesh.position.set(0, 0.4, -2.0);
    this.barrelMesh.castShadow = true;
    this.barrelMesh.receiveShadow = true;
    this.turretGroup.add(this.barrelMesh);

    // Store base positions for recoil animation
    this.barrelBaseZ = -2.0;
    this.muzzleBaseZ = -3.2;

    // Muzzle brake
    this.muzzleMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.3, 0.3),
      barrelMaterial,
    );
    this.muzzleMesh.position.set(0, 0.4, -3.2);
    this.muzzleMesh.castShadow = true;
    this.muzzleMesh.receiveShadow = true;
    this.turretGroup.add(this.muzzleMesh);

    this.bodyGroup.add(this.turretGroup);

    // Enable layer 1 so body meshes receive spotlight illumination
    // (spotlights are on layer 1 only, hex ground stays on layer 0)
    this.bodyGroup.traverse((child) => {
      if (child.isMesh) child.layers.enable(1);
    });
  }

  // ========================
  // HITBOX
  // ========================

  _createHitbox() {
    // Invisible collision box for projectile detection
    const hitboxGeometry = new THREE.BoxGeometry(3, 1.5, 5.5);
    const hitboxMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.hitbox = new THREE.Mesh(hitboxGeometry, hitboxMaterial);
    this.hitbox.position.set(0, 0.75, 0); // Center on tank body
    this.hitbox.userData.tankRef = this;
    this.hitbox.userData.type = "tank";
    this.group.add(this.hitbox);
  }

  // ========================
  // LOD SYSTEM
  // ========================

  _createLOD() {
    // Store references to detailed meshes for LOD toggling
    this.group.traverse((child) => {
      if (child.isMesh && child !== this.hitbox) {
        this.detailedMeshes.push(child);
      }
    });

    // Create LOD box material with terminator-aware lighting
    const lodMaterial = this._createLODMaterial(this.colors.primary);

    // Create LOD box (same dimensions as hitbox for consistent silhouette)
    const lodGeometry = new THREE.BoxGeometry(3, 1.5, 5.5);
    this.lodMesh = new THREE.Mesh(lodGeometry, lodMaterial);
    this.lodMesh.position.set(0, 0.75, 0);
    this.lodMesh.visible = false;
    this.lodMesh.castShadow = false;
    this.lodMesh.receiveShadow = false;
    this.group.add(this.lodMesh);

    // Create fake shadow blob (shown only in orbital mode)
    // Rectangular shape matching tank proportions (width 4.5, depth 7)
    const shadowGeometry = new THREE.PlaneGeometry(4.5, 7);
    const shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: 0.5,
      transparent: true,
      depthWrite: false,
      alphaMap: this._createRectangularShadowTexture(),
    });
    this.shadowBlob = new THREE.Mesh(shadowGeometry, shadowMaterial);
    this.shadowBlob.position.set(0, -0.3, 0);
    this.shadowBlob.scale.set(1, 1, 1); // No scaling needed - geometry is correct size
    this.shadowBlob.rotation.x = -Math.PI / 2;
    this.shadowBlob.visible = false;
    this.shadowBlob.renderOrder = -1;
    this.group.add(this.shadowBlob);

    // Commander mode: billboarded colored dot to replace LOD box (Type 2 LOD)
    // Use pure faction color (not vehicle color which is darker)
    const pureFactionColor =
      typeof FACTION_COLORS !== "undefined" && this.faction
        ? FACTION_COLORS[this.faction].hex
        : this.colors?.primary || 0x888888;

    const dotSize = 11.25; // Visual size (50% larger than original 7.5)
    const dotRadius = dotSize / 2; // For outline calculations
    const dotGeometry = new THREE.PlaneGeometry(dotSize, dotSize);
    const dotMaterial = this._createLODDotMaterial(pureFactionColor);
    this.lodDot = new THREE.Mesh(dotGeometry, dotMaterial);
    this.lodDot.position.set(0, 3, 0); // Slightly above tank
    this.lodDot.visible = false;
    this.lodDot.castShadow = false; // Don't cast shadows
    this.lodDot.receiveShadow = false;
    this.group.add(this.lodDot);

    // Custom raycast for billboarded dot (shader moves geometry, so use sphere check)
    // Use larger hit radius for easier targeting at distance
    const hitRadius = dotRadius * 2;
    const _rcWorldPos = new THREE.Vector3();
    const _rcSphere = new THREE.Sphere(new THREE.Vector3(), hitRadius);
    const _rcIntersectPoint = new THREE.Vector3();
    this.lodDot.raycast = function (raycaster, intersects) {
      if (!this.visible) return;
      this.getWorldPosition(_rcWorldPos);
      _rcSphere.center.copy(_rcWorldPos);
      if (raycaster.ray.intersectSphere(_rcSphere, _rcIntersectPoint)) {
        const distance = raycaster.ray.origin.distanceTo(_rcWorldPos);
        const near = raycaster.near || 0;
        const far = raycaster.far || Infinity;
        if (distance >= near && distance <= far) {
          intersects.push({
            distance: distance,
            point: _rcIntersectPoint.clone(),
            object: this,
          });
        }
      }
    };

    // lodDotDarkOutline no longer needed - outline is drawn in shader
    this.lodDotDarkOutline = null;

    // Store player data for interactions
    this.lodDot.userData = {
      playerId: this.playerId || "player",
      faction: this.faction,
      username: window.playerName || "Player",
      squad: null,
      isCommander: false,
    };

    // Gold outline for commanders (3D torus ring)
    const commanderOutlineRadius = dotRadius + 2.25;
    const commanderOutlineGeometry = new THREE.TorusGeometry(
      commanderOutlineRadius,
      0.8,
      8,
      16,
    );
    const commanderOutlineMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.9,
    });
    this.lodDotOutline = new THREE.Mesh(
      commanderOutlineGeometry,
      commanderOutlineMaterial,
    );
    this.lodDotOutline.position.set(0, 3, 0);
    this.lodDotOutline.rotation.x = Math.PI / 2; // Flat ring
    this.lodDotOutline.visible = false;
    this.lodDotOutline.castShadow = false;
    this.lodDotOutline.receiveShadow = false;
    this.group.add(this.lodDotOutline);
  }

  _createLODMaterial(color) {
    // Custom shader material for LOD tank with proper lighting
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uSunColor: { value: new THREE.Color(0xffd9b7) },
        uSunIntensity: { value: 1.5 },
        uFillDirection: { value: new THREE.Vector3(-1, 0, 0) },
        uFillColor: { value: new THREE.Color(0x6b8e99) },
        uFillIntensity: { value: 0.75 },
        uAmbientColor: { value: new THREE.Color(0x3366aa) },
        uAmbientIntensity: { value: 0.4 },
      },
      vertexShader: `
                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;

                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPos.xyz;
                    vWorldNormal = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `,
      fragmentShader: `
                uniform vec3 uColor;
                uniform vec3 uSunDirection;
                uniform vec3 uSunColor;
                uniform float uSunIntensity;
                uniform vec3 uFillDirection;
                uniform vec3 uFillColor;
                uniform float uFillIntensity;
                uniform vec3 uAmbientColor;
                uniform float uAmbientIntensity;

                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;

                void main() {
                    vec3 normal = normalize(vWorldNormal);
                    vec3 surfaceNormal = normalize(vWorldPosition);

                    float sunFacing = dot(surfaceNormal, uSunDirection);
                    float terminatorShadow = smoothstep(-0.2, 0.2, sunFacing);

                    vec3 lighting = uAmbientColor * uAmbientIntensity;
                    float sunDiffuse = max(dot(normal, uSunDirection), 0.0);
                    lighting += uSunColor * uSunIntensity * sunDiffuse * terminatorShadow;

                    float fillDiffuse = max(dot(normal, uFillDirection), 0.0);
                    lighting += uFillColor * uFillIntensity * fillDiffuse;

                    vec3 finalColor = uColor * lighting;
                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `,
    });
  }

  /**
   * Create billboarded dot material for commander mode (Type 2 LOD)
   * Draws a filled circle with dark outline using fragment shader
   */
  _createLODDotMaterial(color) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOutlineColor: { value: new THREE.Color(0x111111) },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: `
                varying vec2 vUv;
                varying vec3 vWorldPosition;

                void main() {
                    vUv = uv;

                    // Get world position for shadow calculation
                    vec4 worldPos = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                    vWorldPosition = worldPos.xyz;

                    // Billboard: make the plane always face the camera
                    vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                    vec2 scale = vec2(
                        length(modelMatrix[0].xyz),
                        length(modelMatrix[1].xyz)
                    );
                    mvPosition.xy += position.xy * scale;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
      fragmentShader: `
                uniform vec3 uColor;
                uniform vec3 uOutlineColor;
                uniform vec3 uSunDirection;

                varying vec2 vUv;
                varying vec3 vWorldPosition;

                void main() {
                    // Distance from center (0.5, 0.5)
                    float dist = length(vUv - 0.5) * 2.0;

                    // Inner filled circle
                    float circle = 1.0 - smoothstep(0.7, 0.75, dist);

                    // Outline ring
                    float outline = (1.0 - smoothstep(0.9, 0.95, dist)) - circle;
                    outline = max(outline, 0.0);

                    // Calculate terminator shadow based on position on planet
                    vec3 surfaceNormal = normalize(vWorldPosition);
                    float sunFacing = dot(surfaceNormal, uSunDirection);
                    float shadow = smoothstep(-0.2, 0.2, sunFacing);
                    // Slightly darken on shadow side (0.6 minimum brightness)
                    float brightness = 0.6 + 0.4 * shadow;

                    // Combine colors with shadow
                    vec3 finalColor = uColor * circle * brightness + uOutlineColor * outline;
                    float alpha = circle + outline;

                    // Discard fully transparent pixels
                    if (alpha < 0.01) discard;

                    gl_FragColor = vec4(finalColor, alpha);
                }
            `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Create rectangular shadow texture matching tank proportions
   * Uses rounded rectangle with soft edges (same as dashboard preview)
   */
  _createRectangularShadowTexture() {
    const canvas = document.createElement("canvas");
    const width = 96; // Tank width
    const height = 144; // Tank length (longer)
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    // Draw rounded rectangle with soft edges using multiple passes
    const centerX = width / 2;
    const centerY = height / 2;
    const rectWidth = width * 0.7;
    const rectHeight = height * 0.7;
    const cornerRadius = 8;

    // Helper to draw rounded rect path
    const roundedRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    // Draw multiple layers to create soft edge falloff (white for alpha map)
    const layers = 8;
    for (let i = layers; i >= 0; i--) {
      const scale = 1 + (i / layers) * 0.5;
      const alpha = (1 - i / layers) * 1.0; // Full white at center
      const w = rectWidth * scale;
      const h = rectHeight * scale;
      const x = centerX - w / 2;
      const y = centerY - h / 2;
      const r = cornerRadius * scale;

      roundedRect(x, y, w, h, r);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    return texture;
  }

  /**
   * Update LOD visibility based on camera distance
   * Uses shared static helper for consistent behavior with bot tanks
   * @param {THREE.Camera} camera - The camera to check distance from
   * @param {THREE.Frustum} frustum - Optional frustum for culling (if null, no frustum culling)
   * @param {Object} options - Commander mode options for LOD dots
   */
  updateLOD(camera, frustum = null, options = {}) {
    if (!this.lodMesh || !camera) return;
    if (this._hidden) return;

    camera.getWorldPosition(Tank._lodTemp.cameraWorldPos);

    // Use shared LOD update logic
    Tank.updateTankLOD(
      {
        group: this.group,
        lodMesh: this.lodMesh,
        lodDot: this.lodDot,
        lodDotOutline: this.lodDotOutline,
        shadowBlob: this.shadowBlob,
        detailedMeshes: this.detailedMeshes,
        faction: this.faction,
      },
      Tank._lodTemp.cameraWorldPos,
      frustum,
      options,
    );
  }

  /**
   * Update LOD material color when faction changes
   */
  _updateLODColor() {
    if (this.lodMesh && this.lodMesh.material.uniforms) {
      this.lodMesh.material.uniforms.uColor.value.setHex(this.colors.primary);
    }

    // Update LOD dot color for commander mode (use pure faction color)
    if (this.lodDot && this.lodDot.material.uniforms) {
      const pureFactionColor =
        typeof FACTION_COLORS !== "undefined" && this.faction
          ? FACTION_COLORS[this.faction].hex
          : this.colors?.primary || 0x888888;
      this.lodDot.material.uniforms.uColor.value.setHex(pureFactionColor);

      // Also update userData faction
      if (this.lodDot.userData) {
        this.lodDot.userData.faction = this.faction;
      }
    }
  }

  /**
   * Update lighting uniforms for LOD dot shader
   * Called during initialization with environment.getLightingConfig()
   */
  setLightingConfig(lightConfig) {
    if (this.lodDot && this.lodDot.material && this.lodDot.material.uniforms) {
      this.lodDot.material.uniforms.uSunDirection.value.copy(
        lightConfig.sun.direction,
      );
    }
  }

  // ========================
  // DAMAGE SYSTEM
  // ========================

  takeDamage(amount, attackerFaction) {
    if (this.isDead) return;

    // Apply armor modifier from weapon slot system (reduces incoming damage)
    if (window.weaponSlotSystem) {
      const armorMult = window.weaponSlotSystem.getModifiers().armorMultiplier;
      if (armorMult > 1) {
        amount = Math.round(amount / armorMult);
      }
    }

    this.hp = Math.max(0, this.hp - amount);
    this._updateDamageState();

    // Flash tank white briefly on hit
    this._flashHit();
    // Notify UI callback
    if (this.onDamage) {
      this.onDamage(this.hp, this.maxHp, amount);
    }

    if (this.hp <= 0) {
      this._die(attackerFaction);
    }
  }

  _flashHit() {
    // Quick scale pulse effect
    const originalScale = this.group.scale.clone();
    this.group.scale.multiplyScalar(1.15);

    // Restore original scale after 30ms
    setTimeout(() => {
      this.group.scale.copy(originalScale);
    }, 30);
  }

  _updateDamageState() {
    const hpPercent = this.hp / this.maxHp;

    if (hpPercent > 0.5) {
      this._setDamageState("healthy");
    } else if (hpPercent > 0.25) {
      this._setDamageState("damaged"); // Gray smoke
    } else if (hpPercent > 0) {
      this._setDamageState("critical"); // Fire + black smoke
    }
  }

  _setDamageState(state) {
    if (this.damageState === state) return;
    this.damageState = state;

    // Damage effects will be handled by TankDamageEffects class
    // This method is called to notify external systems
    if (this.onDamageStateChange) {
      this.onDamageStateChange(state);
    }
  }

  _die(killerFaction) {
    this.isDead = true;
    this.state.isDead = true; // Also set on state for tread dust/tracks
    this.damageState = "dead";
    this.state.speed = 0;
    this.state.keys = { w: false, a: false, s: false, d: false, shift: false };

    // Notify damage state callback for smoke effects
    if (this.onDamageStateChange) {
      this.onDamageStateChange("dead");
    }

    // Turn tank dark gray
    this._setDeadMaterial();

    // Start fade timer (3 seconds)
    this._startFadeOut(3);

    // Notify death callback (for explosion, respawn flow, etc.)
    if (this.onDeath) {
      this.onDeath(this, killerFaction);
    }
  }

  /**
   * Check if a mesh belongs to commander trim (should be skipped by death/fade).
   * Commander trim uses a shared material managed by CommanderSkin — mutating it
   * during death fade would corrupt the material for future trim applications.
   */
  _isCommanderTrim(child) {
    let node = child;
    while (node) {
      if (node.name === 'commanderTrim' || node.name === 'barrelTrim') return true;
      node = node.parent;
    }
    return false;
  }

  _setDeadMaterial() {
    // Turn all tank meshes very dark - charred look
    const charredColor = 0x3a3a3a; // Dark gray - charred look
    this.group.traverse((child) => {
      if (child.isMesh && child.material && child !== this.hitbox && !this._isCommanderTrim(child)) {
        // Clone material to avoid affecting shared materials
        if (!child.userData.originalMaterial) {
          child.userData.originalMaterial = child.material;
          child.material = child.material.clone();
        }
        // Guard: some materials (ShaderMaterial, etc.) don't have .color
        if (child.material.color) {
          child.material.color.setHex(charredColor);
        }
      }
    });
  }

  _startFadeOut(duration) {
    this.fadeStartTime = performance.now();
    // Three-phase: smoke fades (3s), delay (2s), then tank fades (3s)
    this.smokeFadeDuration = 3 * 1000; // 3 seconds for smoke to fade
    this.sinkDelay = 2 * 1000; // 2 seconds delay before fading
    this.fadeDuration = duration * 1000; // Duration for tank to fade out
    this.isFading = true;
    this.smokeFullyFaded = false;
    this.tankFadeStarted = false;
  }

  updateFade() {
    if (!this.isFading) return false;

    const elapsed = performance.now() - this.fadeStartTime;

    // Phase 1: Smoke fades first (0 to smokeFadeDuration)
    if (elapsed < this.smokeFadeDuration) {
      const smokeProgress = elapsed / this.smokeFadeDuration;
      const smokeOpacity = 1 - smokeProgress;

      // Notify callback for smoke opacity only (tank stays visible)
      if (this.onSmokeFadeUpdate) {
        this.onSmokeFadeUpdate(this, smokeOpacity);
      }

      return false;
    }

    // Mark smoke as fully faded (do this once)
    if (!this.smokeFullyFaded) {
      this.smokeFullyFaded = true;
      // Ensure smoke is at 0 opacity
      if (this.onSmokeFadeUpdate) {
        this.onSmokeFadeUpdate(this, 0);
      }
    }

    // Phase 2: Delay before fading (tank sits charred)
    const delayElapsed = elapsed - this.smokeFadeDuration;
    if (delayElapsed < this.sinkDelay) {
      return false; // Still waiting
    }

    // Phase 3: Tank fades out (opacity reduces)
    const fadeElapsed = delayElapsed - this.sinkDelay;
    const fadeProgress = Math.min(1, fadeElapsed / this.fadeDuration);

    if (fadeProgress >= 1) {
      // Fully faded - notify for removal
      if (this.onFadeComplete) {
        this.onFadeComplete(this);
      }
      return true; // Signal fade complete
    }

    // Start fade setup (once)
    if (!this.tankFadeStarted) {
      this.tankFadeStarted = true;
      // Make materials transparent for fading (including shadow)
      // Skip commander trim — its shared material is managed by CommanderSkin
      this.group.traverse((child) => {
        if (child.isMesh && child.material && child !== this.hitbox && !this._isCommanderTrim(child)) {
          child.material.transparent = true;
          child.castShadow = true; // Keep shadow, it will fade with opacity
        }
      });
    }

    // Calculate opacity (ease-in for gradual start)
    const easedProgress = fadeProgress * fadeProgress;
    const opacity = 1 - easedProgress;

    // Apply opacity to all tank meshes (skip commander trim)
    this.group.traverse((child) => {
      if (child.isMesh && child.material && child !== this.hitbox && !this._isCommanderTrim(child)) {
        child.material.opacity = opacity;
      }
    });

    // Notify callback for fade progress
    if (this.onFadeUpdate) {
      this.onFadeUpdate(this, opacity);
    }

    return false; // Still fading
  }

  /**
   * Reset tank state for respawn
   */
  resetForRespawn() {
    // Reset health
    this.hp = this.maxHp;
    this.isDead = false;
    this.state.isDead = false; // Also reset on state for tread dust/tracks
    this.isFading = false;
    this.damageState = "healthy";
    this.lastSpawnTime = Date.now(); // Track spawn time for title system lifespan

    // Reset turret spring state
    this.state.turretAngle = 0;
    this.state.turretTargetAngle = 0;
    this.state.turretAngularVelocity = 0;

    // Restore original materials (skip commander trim — managed by CommanderSkin)
    this.group.traverse((child) => {
      if (child.isMesh && child.material && child !== this.hitbox && !this._isCommanderTrim(child)) {
        if (child.userData.originalMaterial) {
          child.material.dispose();
          child.material = child.userData.originalMaterial;
          delete child.userData.originalMaterial;
        }
        // Reset transparency
        child.material.transparent = false;
        child.material.opacity = 1;
      }
    });

    // Re-apply faction colors
    this.setFactionColors(this.faction);

    // Reset movement state
    this.state.speed = 0;
    this.state.keys = { w: false, a: false, s: false, d: false, shift: false };

    // Notify damage state change (to clear effects)
    if (this.onDamageStateChange) {
      this.onDamageStateChange("healthy");
    }
  }

  // ========================
  // INPUT
  // ========================

  _setupInput() {
    window.addEventListener("keydown", (e) => {
      if (window._authScreenInstance?.isVisible || window._modalOpen) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      if (!this.controlsEnabled || this.isDead) return;
      if (e.key === "Shift") {
        this.state.keys.shift = true;
        return;
      }
      const key = e.key.toLowerCase();
      if (key in this.state.keys) {
        this.state.keys[key] = true;
        e.preventDefault();
      }
    });

    window.addEventListener("keyup", (e) => {
      if (window._modalOpen) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
      if (e.key === "Shift") {
        this.state.keys.shift = false;
        return;
      }
      const key = e.key.toLowerCase();
      if (key in this.state.keys) {
        this.state.keys[key] = false;
      }
    });

    // Clear all keys when user focuses a text input (prevents stuck keys)
    window.addEventListener("focus", (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) {
        for (const k in this.state.keys) this.state.keys[k] = false;
      }
    }, true);

    // Throttle mousemove to ~60fps (16ms) - turret aiming doesn't need higher frequency
    let lastMouseMoveTime = 0;
    window.addEventListener("mousemove", (e) => {
      if (window._authScreenInstance?.isVisible || window._modalOpen) return;
      const now = performance.now();
      if (now - lastMouseMoveTime < 16) return;
      lastMouseMoveTime = now;
      this.mousePosition.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mousePosition.y = -(e.clientY / window.innerHeight) * 2 + 1;
    });
  }
}

// ========================
// STATIC HELPERS (shared with BotTanks)
// ========================

/**
 * Move an entity on a sphere using spherical coordinates
 * @param {Object} entity - Must have: state.speed, heading, theta, phi
 * @param {number} planetRotationSpeed - Planet rotation speed (per second)
 * @param {number} deltaTime - Time since last frame in seconds
 * @param {number} minPhi - Minimum latitude (polar opening boundary)
 * @param {number} maxPhi - Maximum latitude (polar opening boundary)
 */
Tank.POLAR_PHI_LIMIT = (3 * Math.PI) / 180; // 3° safety net (polygon collision is primary boundary)
Tank.moveEntityOnSphere = function (
  entity,
  planetRotationSpeed,
  deltaTime = 1 / 60,
  minPhi = Tank.POLAR_PHI_LIMIT,
  maxPhi = Math.PI - Tank.POLAR_PHI_LIMIT,
) {
  const speed = entity.state.speed;
  const heading = entity.heading;
  const phi = entity.phi;

  // Scale movement by deltaTime (normalized to 60 FPS baseline)
  // Speed is already a per-frame value tuned for 60fps, so we scale by dt60
  const dt60 = deltaTime * 60;

  // Convert speed in heading direction to north/east components
  const velocityNorth = Math.cos(heading) * speed * dt60;
  const velocityEast = -Math.sin(heading) * speed * dt60;

  // Convert tangent plane velocity to spherical coordinate changes
  const dPhi = -velocityNorth;
  // Prevent division by near-zero at poles (sin(phi) → 0)
  const sinPhi = Math.sin(phi);
  const safeSinPhi =
    Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
  const dTheta = velocityEast / safeSinPhi;

  // Safety: clamp dTheta to prevent pole-related teleportation
  const maxDTheta = 0.1; // Max ~6 degrees per frame
  const clampedDTheta = Math.max(-maxDTheta, Math.min(maxDTheta, dTheta));

  entity.phi += dPhi;
  entity.theta += clampedDTheta;

  // Clamp latitude
  entity.phi = Math.max(minPhi, Math.min(maxPhi, entity.phi));

  // Wrap longitude
  while (entity.theta > Math.PI * 2) entity.theta -= Math.PI * 2;
  while (entity.theta < 0) entity.theta += Math.PI * 2;

  // Counter planet rotation (entity stays fixed in world space)
  // planetRotationSpeed is per-frame at 60fps, so scale by dt60
  entity.theta -= (planetRotationSpeed * dt60) / 60;
  if (entity.theta < 0) entity.theta += Math.PI * 2;
};

/**
 * Update an entity's visual position and orientation on a sphere
 * @param {Object} entity - Must have: theta, phi, heading, group (THREE.Group)
 * @param {number} sphereRadius - Radius of the sphere
 */

// Preallocated objects for _updateTurret (called every frame for player)
Tank._turretTemp = {
  tankPos: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  plane: new THREE.Plane(),
  intersection: new THREE.Vector3(),
  toTarget: new THREE.Vector3(),
  east: new THREE.Vector3(),
  north: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  right: new THREE.Vector3(),
  stableMatrix: new THREE.Matrix4(),
  invMatrix: new THREE.Matrix4(),
  yAxis: new THREE.Vector3(0, 1, 0),
  aimDir: new THREE.Vector3(),
  aimPoint: new THREE.Vector3(),
};

// Preallocated vectors for updateEntityVisual (called per-tank per-frame)
Tank._visualTemp = {
  up: new THREE.Vector3(),
  east: new THREE.Vector3(),
  north: new THREE.Vector3(),
  forward: new THREE.Vector3(),
  target: new THREE.Vector3(),
  rollAxis: new THREE.Vector3(0, 0, 1),
  rollQuat: new THREE.Quaternion(),
  worldUp: new THREE.Vector3(0, 1, 0),
  poleEast: new THREE.Vector3(0, 0, 1),
  pitchAxis: new THREE.Vector3(1, 0, 0),
  pitchQuat: new THREE.Quaternion(),
  steerQuat: new THREE.Quaternion(),
};

// Lean configuration: momentum/inertia spring parameters
Tank.LEAN_CONFIG = {
  MAX_PITCH_ANGLE:    0.165,  // ~9.5 degrees max forward/back tilt
  PITCH_STIFFNESS:    20,     // Spring stiffness (zeta ~ 0.56, underdamped)
  PITCH_DAMPING:      5,
  PITCH_GAIN:         6000,   // Maps acceleration rate to target angle

  MAX_STEER_LEAN:     0.15,   // ~8.6 degrees max side lean
  STEER_STIFFNESS:    18,     // Spring stiffness (zeta ~ 0.53, underdamped)
  STEER_DAMPING:      4.5,
  STEER_LEAN_GAIN:    2.625,  // Maps turn rate * speed to target angle
};

/**
 * Update lean spring state for momentum/inertia animation.
 * Call once per frame BEFORE updateEntityVisual.
 * Mutates the lean state object in place.
 */
Tank.updateLeanState = function (lean, speed, heading, deltaTime, isDead) {
  const cfg = Tank.LEAN_CONFIG;

  // Guard: bad deltaTime or dead entity
  if (deltaTime <= 0 || deltaTime > 0.25) {
    lean.prevSpeed = speed;
    lean.prevHeading = heading;
    lean.initialized = true;
    return;
  }

  if (isDead) {
    lean.pitchAngle *= 0.9;
    lean.pitchVelocity *= 0.9;
    lean.steerAngle *= 0.9;
    lean.steerVelocity *= 0.9;
    lean.prevSpeed = speed;
    lean.prevHeading = heading;
    return;
  }

  // First frame: record prev values only (no deltas)
  if (!lean.initialized) {
    lean.prevSpeed = speed;
    lean.prevHeading = heading;
    lean.initialized = true;
    return;
  }

  // === PITCH LEAN (acceleration / deceleration) ===
  const accelRate = (speed - lean.prevSpeed) / deltaTime;
  let pitchTarget = -accelRate * cfg.PITCH_GAIN;
  pitchTarget = Math.max(-cfg.MAX_PITCH_ANGLE, Math.min(cfg.MAX_PITCH_ANGLE, pitchTarget));

  const pitchError = pitchTarget - lean.pitchAngle;
  lean.pitchVelocity += (cfg.PITCH_STIFFNESS * pitchError - cfg.PITCH_DAMPING * lean.pitchVelocity) * deltaTime;
  lean.pitchAngle += lean.pitchVelocity * deltaTime;
  lean.pitchAngle = Math.max(-cfg.MAX_PITCH_ANGLE * 1.2, Math.min(cfg.MAX_PITCH_ANGLE * 1.2, lean.pitchAngle));

  // === STEER LEAN (centrifugal roll from turning) ===
  let headingDelta = heading - lean.prevHeading;
  if (headingDelta > Math.PI) headingDelta -= Math.PI * 2;
  if (headingDelta < -Math.PI) headingDelta += Math.PI * 2;

  const turnRate = headingDelta / deltaTime;
  const speedFactor = Math.min(Math.abs(speed) / 0.0004, 1.0);
  let steerTarget = turnRate * speedFactor * cfg.STEER_LEAN_GAIN;
  steerTarget = Math.max(-cfg.MAX_STEER_LEAN, Math.min(cfg.MAX_STEER_LEAN, steerTarget));

  const steerError = steerTarget - lean.steerAngle;
  lean.steerVelocity += (cfg.STEER_STIFFNESS * steerError - cfg.STEER_DAMPING * lean.steerVelocity) * deltaTime;
  lean.steerAngle += lean.steerVelocity * deltaTime;
  lean.steerAngle = Math.max(-cfg.MAX_STEER_LEAN * 1.2, Math.min(cfg.MAX_STEER_LEAN * 1.2, lean.steerAngle));

  // Snap to zero when settled
  if (Math.abs(lean.pitchAngle) < 0.0005 && Math.abs(lean.pitchVelocity) < 0.001 && Math.abs(pitchTarget) < 0.0001) {
    lean.pitchAngle = 0;
    lean.pitchVelocity = 0;
  }
  if (Math.abs(lean.steerAngle) < 0.0005 && Math.abs(lean.steerVelocity) < 0.001 && Math.abs(steerTarget) < 0.0001) {
    lean.steerAngle = 0;
    lean.steerVelocity = 0;
  }

  lean.prevSpeed = speed;
  lean.prevHeading = heading;
};

Tank.updateEntityVisual = function (entity, sphereRadius) {
  const { theta, phi, heading } = entity;
  const t = Tank._visualTemp;

  // Lower tanks into the ground so tracks maintain contact with surface
  const r = sphereRadius - 0.4;

  // Spherical to Cartesian
  const x = r * Math.sin(phi) * Math.cos(theta);
  const y = r * Math.cos(phi);
  const z = r * Math.sin(phi) * Math.sin(theta);

  entity.group.position.set(x, y, z);

  // Surface normal (up vector) - reuse preallocated vector
  t.up.set(x, y, z).normalize();

  // Calculate tangent plane basis
  if (Math.abs(t.up.y) > 0.999) {
    t.east.crossVectors(t.poleEast, t.up).normalize();
  } else {
    t.east.crossVectors(t.worldUp, t.up).normalize();
  }

  t.north.crossVectors(t.up, t.east).normalize();

  // Forward direction based on heading
  t.forward.set(0, 0, 0);
  t.forward.addScaledVector(t.north, Math.cos(heading));
  t.forward.addScaledVector(t.east, Math.sin(heading));
  t.forward.normalize();

  // Orient entity
  t.target.copy(entity.group.position).add(t.forward);
  entity.group.up.copy(t.up);
  entity.group.lookAt(t.target);

  // Apply lean + wiggle to bodyGroup (so headlights, hitbox, projectile origin on outer group are unaffected)
  const leanTarget = entity.bodyGroup || entity.group;
  if (leanTarget !== entity.group) leanTarget.quaternion.identity();

  // Apply momentum lean (pitch + steer) before wiggle
  if (entity.lean) {
    if (entity.lean.pitchAngle !== 0) {
      t.pitchQuat.setFromAxisAngle(t.pitchAxis, entity.lean.pitchAngle);
      leanTarget.quaternion.multiply(t.pitchQuat);
    }
    if (entity.lean.steerAngle !== 0) {
      t.steerQuat.setFromAxisAngle(t.rollAxis, entity.lean.steerAngle);
      leanTarget.quaternion.multiply(t.steerQuat);
    }
  }

  // Apply roll wiggle around forward axis if entity has speed
  if (entity.speed !== undefined && entity.wigglePhase !== undefined) {
    const speed = Math.abs(entity.speed);
    // Skip wiggle for dead tanks
    if (speed > 0.00001 && !entity.isDead) {
      // HP-based wiggle intensity (1x at full HP, 4x at near-death)
      // Linear scaling: 2° at 100% HP, 8° at ~0% HP
      const hpPercent =
        entity.hp !== undefined && entity.maxHp !== undefined
          ? Math.max(entity.hp / entity.maxHp, 0)
          : 1;
      const wiggleMultiplier = 1 + (1 - hpPercent) * 3;

      // Base wiggle amplitude (~2 degrees), scaled by HP
      const baseMaxWiggle = 0.035; // ~2 degrees in radians at full HP
      const maxWiggle = baseMaxWiggle * wiggleMultiplier;

      // Speed-based wiggle amount
      const speedRatio = Math.min(speed / 0.0004, 1); // 0-1 based on max speed
      const wiggleAmount = speedRatio * maxWiggle;
      const rollAngle = Math.sin(entity.wigglePhase) * wiggleAmount;

      // Store roll angle for turret compensation
      entity.currentRollAngle = rollAngle;

      // Create rotation quaternion around local Z axis (forward)
      t.rollQuat.setFromAxisAngle(t.rollAxis, rollAngle);

      // Apply roll to lean target
      leanTarget.quaternion.multiply(t.rollQuat);
    } else {
      entity.currentRollAngle = 0;
    }
  }
};

// Preallocated temp vectors for LOD calculations (avoid GC pressure)
Tank._terrainTemp = {
  testPos: new THREE.Vector3(),
};

// Collision box probes: [forward_units, right_units]
// Center + 4 corners of the tank body (5.5 long × 3 wide)
Tank._collisionProbes = [
  [0, 0],          // center
  [2.75, -1.5],    // front-left
  [2.75,  1.5],    // front-right
  [-2.75, -1.5],   // rear-left
  [-2.75,  1.5],   // rear-right
];

Tank._lodTemp = {
  tankWorldPos: new THREE.Vector3(),
  surfaceNormal: new THREE.Vector3(),
  cameraToTank: new THREE.Vector3(),
  boundingSphere: new THREE.Sphere(new THREE.Vector3(), 5),
  worldDotPos: new THREE.Vector3(),
  inverseQuat: new THREE.Quaternion(),
  localDotOffset: new THREE.Vector3(),
  cameraWorldPos: new THREE.Vector3(),
};

/**
 * Shared LOD update for all tanks (player and bots)
 * Handles backface culling, frustum culling, screen-space culling, and LOD switching
 * @param {Object} tank - Must have: group, lodMesh, shadowBlob, detailedMeshes
 * @param {THREE.Vector3} cameraWorldPos - Camera world position
 * @param {THREE.Frustum|null} frustum - Optional frustum for culling
 * @param {Object} options - Commander mode options
 * @param {boolean} options.isOrbitalView - Whether camera is in orbital/fast travel mode
 * @param {boolean} options.isHumanCommander - Whether the human player is a commander
 * @param {Object} options.commanderSystem - Reference to commanderSystem for checking commanders
 * @returns {boolean} Whether tank is visible
 */
Tank.updateTankLOD = function (
  tank,
  cameraWorldPos,
  frustum = null,
  options = {},
) {
  const { isOrbitalView, isHumanCommander, commanderSystem } = options;
  const temp = Tank._lodTemp;
  const tankWorldPos = temp.tankWorldPos;
  const surfaceNormal = temp.surfaceNormal;
  const cameraToTank = temp.cameraToTank;
  const boundingSphere = temp.boundingSphere;

  // LOD thresholds
  const LOD_DISTANCE = 260;
  const MIN_SCREENSPACE = 2;

  // Get tank world position
  tank.group.getWorldPosition(tankWorldPos);
  const distanceToCamera = tankWorldPos.distanceTo(cameraWorldPos);

  // Backface culling - hide tanks on far side of planet
  surfaceNormal.copy(tankWorldPos).normalize();
  cameraToTank.copy(tankWorldPos).sub(cameraWorldPos).normalize();
  const dotProduct = surfaceNormal.dot(cameraToTank);

  // Threshold varies: more lenient for close tanks
  const backfaceThreshold = distanceToCamera > 260 ? 0.15 : 0.3;
  if (dotProduct > backfaceThreshold) {
    tank.group.visible = false;
    tank._lodState = -1;
    return false;
  }

  // Frustum culling (if frustum provided)
  if (frustum) {
    boundingSphere.center.copy(tankWorldPos);
    if (!frustum.intersectsSphere(boundingSphere)) {
      tank.group.visible = false;
      tank._lodState = -1;
      return false;
    }
  }

  // Screen-space size culling for very distant tanks
  const apparentSize = (5 / distanceToCamera) * 1000;
  if (distanceToCamera > LOD_DISTANCE && apparentSize < MIN_SCREENSPACE) {
    tank.group.visible = false;
    tank._lodState = -1;
    return false;
  }

  // Tank is visible
  tank.group.visible = true;

  // Faction check for LOD type selection
  const viewerFaction = options.viewerFaction;
  const isSameFaction =
    tank.faction && viewerFaction && tank.faction === viewerFaction;

  // LOD switching: use simple representation when camera is far
  const useLOD = distanceToCamera > LOD_DISTANCE;

  // Type 2 (dots): ALL tanks if viewer is commander, only friendlies otherwise
  // Type 1 (box): enemies when viewer is NOT commander
  const useDot = useLOD && (isHumanCommander || isSameFaction);

  // Store LOD state for instanced rendering (0=detail, 1=box, 2=dot, -1=hidden)
  tank._lodState = useLOD ? (useDot ? 2 : 1) : 0;

  // Toggle LOD dot visibility (Type 2 - friendly faction)
  if (tank.lodDot) {
    tank.lodDot.visible = useDot;

    // Fix lodDot position: keep it directly above tank in surface-normal direction
    // The dot's local position (0,3,0) rotates with the tank, causing visual mismatch.
    // Counter-rotate the offset so it always points in the surface-normal (planet-up) direction.
    if (useDot) {
      const dotHeight = 3;
      // Get inverse of tank's world quaternion
      const inverseQuat = temp.inverseQuat;
      tank.group.getWorldQuaternion(inverseQuat);
      inverseQuat.invert();

      // Surface normal in world space (planet-up at tank's position)
      // surfaceNormal is already computed as normalized tankWorldPos
      const localDotOffset = temp.localDotOffset;
      localDotOffset.copy(surfaceNormal).multiplyScalar(dotHeight);

      // Transform world-space offset to local-space by applying inverse quaternion
      localDotOffset.applyQuaternion(inverseQuat);

      tank.lodDot.position.copy(localDotOffset);
    }
  }

  // Toggle dark outline visibility (behind the dot)
  if (tank.lodDotDarkOutline) {
    tank.lodDotDarkOutline.visible = useDot;
  }

  // Gold outline for commanders (shown when dot is visible)
  if (tank.lodDotOutline) {
    if (useDot && commanderSystem) {
      const playerId = tank.lodDot?.userData?.playerId;
      const isCommander = commanderSystem.isCommander(playerId);
      tank.lodDotOutline.visible = isCommander;
      // Keep outline at same position as dot
      if (isCommander) {
        tank.lodDotOutline.position.copy(tank.lodDot.position);
      }
    } else {
      tank.lodDotOutline.visible = false;
    }
  }

  // Toggle LOD mesh visibility (Type 1 - enemies, hidden when showing dots)
  if (tank.lodMesh) {
    tank.lodMesh.visible = useLOD && !useDot;
  }

  // Toggle detailed meshes visibility
  if (tank.detailedMeshes) {
    for (const mesh of tank.detailedMeshes) {
      mesh.visible = !useLOD;
    }
  }

  // Show blob shadow for LOD tanks (replaces cast shadow)
  if (tank.shadowBlob) {
    tank.shadowBlob.visible = useLOD && !useDot;
  }

  // Update shadow casting based on LOD
  const shouldDetailedCastShadow = !useLOD;
  if (tank.detailedMeshes && tank.detailedMeshes.length > 0) {
    const currentlyCastingShadow = tank.detailedMeshes[0]?.castShadow ?? true;

    // Only update if changed (avoid unnecessary work)
    if (shouldDetailedCastShadow !== currentlyCastingShadow) {
      for (const mesh of tank.detailedMeshes) {
        if (mesh.isMesh) {
          mesh.castShadow = shouldDetailedCastShadow;
        } else if (mesh.isGroup) {
          mesh.traverse((child) => {
            if (child.isMesh) child.castShadow = shouldDetailedCastShadow;
          });
        }
      }
    }
  }

  // LOD mesh never casts shadow (uses blob shadow instead)
  if (tank.lodMesh) {
    tank.lodMesh.castShadow = false;
  }

  return true;
};
