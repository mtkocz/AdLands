/**
 * AdLands - RemoteTank
 * A lightweight tank representation for other players in multiplayer.
 * 
 * Uses the same mesh construction as Tank (so it looks identical)
 * but does NOT process local input. Instead, it interpolates toward
 * target positions received from the server.
 */

class RemoteTank {
  constructor(scene, sphereRadius, playerData) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.playerId = playerData.id;
    this.playerName = playerData.name;
    this.faction = playerData.faction;
    this.avatarColor = playerData.avatarColor || null;

    // Current interpolated state (what we render)
    this.state = {
      theta: playerData.theta || 0,
      phi: playerData.phi || Math.PI / 2,
      heading: playerData.heading || 0,
      speed: 0,
      turretAngle: playerData.turretAngle || 0,
      turretTargetAngle: 0,
      turretAngularVelocity: 0,
      keys: { w: false, a: false, s: false, d: false },
      isDead: false,
      wigglePhase: Math.random() * Math.PI * 2,
      lean: {
        pitchAngle: 0, pitchVelocity: 0,
        steerAngle: 0, steerVelocity: 0,
        prevSpeed: 0, prevHeading: 0,
        initialized: false,
      },
    };

    // Target state (latest from server, used as fallback for dead-reckoning)
    this.targetState = {
      theta: this.state.theta,
      phi: this.state.phi,
      heading: this.state.heading,
      speed: 0,
      turretAngle: 0,
    };

    // Snapshot interpolation ring buffer — stores timestamped server states.
    // Instead of lerping toward one jittery target, we buffer 2-3 snapshots
    // and interpolate between them at a fixed rate for smooth motion.
    // Fixed-size ring buffer avoids Array.shift() reindexing (600 calls/sec with 60 tanks at 10Hz).
    this._snapCap = 8;
    this._snapBuf = new Array(this._snapCap);
    this._snapHead = 0;  // next write position
    this._snapCount = 0; // valid entries (0 to _snapCap)
    this.interpolationDelay = 200; // ms — render 200ms behind real-time (2 server ticks at 10Hz)

    // Health
    this.hp = playerData.hp || 100;
    this.maxHp = playerData.maxHp || 100;
    this.isDead = playerData.isDead || false;

    this.level = playerData.level || 1;
    this.rank = playerData.rank || 0;

    // Build the tank mesh (reuses Tank's build method via a temporary Tank)
    this._buildMesh();

    // Set faction colors
    this._setFactionColors();
  }

  _buildMesh() {
    // Create a Tank instance without input handlers or scene attachment,
    // then take its mesh group. This avoids registering phantom keyboard
    // listeners and double-adding to the scene.
    const tempTank = new Tank(this.scene, this.sphereRadius, {
      skipInput: true,
      skipScene: true,
    });
    this.group = tempTank.group;
    this.bodyGroup = tempTank.bodyGroup;
    this.turretGroup = tempTank.turretGroup;
    this.barrelMesh = tempTank.barrelMesh;
    this.muzzleMesh = tempTank.muzzleMesh;
    this.lodMesh = tempTank.lodMesh;
    this.lodDot = tempTank.lodDot;
    this.lodDotOutline = tempTank.lodDotOutline;
    this.shadowBlob = tempTank.shadowBlob;
    this.detailedMeshes = tempTank.detailedMeshes;
    this.hitbox = tempTank.hitbox;
    this.hitbox.userData.tankRef = this; // Point to RemoteTank, not temp Tank
    this.barrelBaseZ = tempTank.barrelBaseZ;
    this.muzzleBaseZ = tempTank.muzzleBaseZ;

    // Set LOD dot userData for interaction system (hover tooltips, right-click)
    if (this.lodDot) {
      this.lodDot.userData = {
        playerId: this.playerId,
        faction: this.faction,
        username: this.playerName,
      };
    }

    // Tank constructor sets group.visible = false (hidden until deployment).
    // Remote tanks are visible immediately — LOD system will manage visibility.
    this.group.visible = true;

    // Add to scene
    this.scene.add(this.group);
  }

  /**
   * Change faction and recolor the tank mesh.
   * @param {string} newFaction - 'rust', 'cobalt', or 'viridian'
   */
  setFaction(newFaction) {
    if (!FACTION_COLORS[newFaction]) return;
    this.faction = newFaction;
    this._setFactionColors();
  }

  _setFactionColors() {
    if (!FACTION_COLORS[this.faction]) return;

    const palette = FACTION_COLORS[this.faction].vehicle;
    this.group.traverse((child) => {
      if (child.isMesh && child.material && child.material.color) {
        const color = child.material.color.getHex();
        // Match any faction's primary/secondary colors and replace
        for (const f of ["cobalt", "rust", "viridian"]) {
          const fp = FACTION_COLORS[f].vehicle;
          if (color === fp.primary || color === 0x3a5f7d) {
            child.material.color.setHex(palette.primary);
            break;
          } else if (color === fp.secondary || color === 0x2a4560) {
            child.material.color.setHex(palette.secondary);
            break;
          }
        }
      }
    });

    // Update LOD mesh color (ShaderMaterial uses uniforms, not .color)
    if (this.lodMesh && this.lodMesh.material) {
      if (this.lodMesh.material.uniforms) {
        this.lodMesh.material.uniforms.uColor.value.setHex(FACTION_COLORS[this.faction].hex);
      } else if (this.lodMesh.material.color) {
        this.lodMesh.material.color.setHex(FACTION_COLORS[this.faction].hex);
      }
    }

    // Update LOD dot color (billboarded plane for commander mode)
    if (this.lodDot && this.lodDot.material) {
      if (this.lodDot.material.uniforms) {
        this.lodDot.material.uniforms.uColor.value.setHex(FACTION_COLORS[this.faction].hex);
      } else if (this.lodDot.material.color) {
        this.lodDot.material.color.setHex(FACTION_COLORS[this.faction].hex);
      }
    }
  }

  /**
   * Set the target state from a server update.
   * Pushes a timestamped snapshot into the interpolation buffer.
   */
  setTargetState(serverState) {
    const wasDead = this.isDead;
    this.isDead = !!serverState.d;
    this.state.isDead = this.isDead;
    this.hp = serverState.hp;

    if (this.isDead) {
      if (!wasDead) {
        this.state.speed = 0;
        this.targetState.speed = 0;
        this._snapCount = 0;
      }
      return;
    }

    // Update targetState as fallback for dead-reckoning when buffer runs dry
    this.targetState.theta = serverState.t;
    this.targetState.phi = serverState.p;
    this.targetState.heading = serverState.h;
    this.targetState.speed = serverState.s;
    this.targetState.turretAngle = serverState.ta;

    // Push timestamped snapshot into ring buffer
    this._snapBuf[this._snapHead] = {
      t: performance.now(),
      theta: serverState.t,
      phi: serverState.p,
      heading: serverState.h,
      speed: serverState.s,
      turretAngle: serverState.ta,
    };
    this._snapHead = (this._snapHead + 1) % this._snapCap;
    if (this._snapCount < this._snapCap) this._snapCount++;
  }

  /**
   * Interpolate toward target state and update visuals.
   * Called every client frame from the game loop.
   */
  update(deltaTime) {
    if (!this.group) return;

    const dt60 = deltaTime * 60;

    if (this.isDead) {
      // Dead tanks: no interpolation, no dead-reckoning — only counter planet
      // rotation so the wreck stays fixed on the surface.
      this.state.theta -= (SharedPhysics.PLANET_ROTATION_SPEED * dt60) / 60;
      while (this.state.theta < 0) this.state.theta += Math.PI * 2;
      while (this.state.theta >= Math.PI * 2) this.state.theta -= Math.PI * 2;
      // Keep target in sync so there's no snap if respawned
      this.targetState.theta = this.state.theta;
      this.targetState.phi = this.state.phi;

      this.state.speed = 0;

      // Update lean springs (will settle to zero because isDead)
      Tank.updateLeanState(this.state.lean, 0, this.state.heading, deltaTime, true);

      // Update visual (keeps mesh on rotating planet)
      const entity = {
        theta: this.state.theta,
        phi: this.state.phi,
        heading: this.state.heading,
        group: this.group,
        bodyGroup: this.bodyGroup,
        speed: 0,
        wigglePhase: this.state.wigglePhase,
        currentRollAngle: 0,
        hp: this.hp,
        maxHp: this.maxHp,
        isDead: true,
        lean: this.state.lean,
      };
      Tank.updateEntityVisual(entity, this.sphereRadius);
      return;
    }

    // Snapshot interpolation: render at a fixed delay behind real-time.
    // Uses Hermite (cubic) interpolation for position — this produces smooth
    // velocity transitions at tick boundaries, eliminating the visible "kinks"
    // that linear interpolation creates at 10Hz update rate.
    const renderTime = performance.now() - this.interpolationDelay;
    const snapCount = this._snapCount;

    let interpolated = false;

    if (snapCount >= 2) {
      // Ring buffer index helper: i=0 is oldest, i=snapCount-1 is newest
      const oldest = (this._snapHead - snapCount + this._snapCap) % this._snapCap;

      // Find the two snapshots bracketing renderTime (search from newest backward)
      let fromSnap = null;
      let toSnap = null;
      for (let i = snapCount - 2; i >= 0; i--) {
        const snap = this._snapBuf[(oldest + i) % this._snapCap];
        if (snap.t <= renderTime) {
          fromSnap = snap;
          toSnap = this._snapBuf[(oldest + i + 1) % this._snapCap];
          break;
        }
      }

      if (fromSnap && toSnap) {
        const span = toSnap.t - fromSnap.t;
        const t = span > 0 ? Math.min(1, (renderTime - fromSnap.t) / span) : 1;

        // Hermite basis functions for cubic interpolation
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;  // from position weight
        const h10 = t3 - 2 * t2 + t;       // from tangent weight
        const h01 = -2 * t3 + 3 * t2;      // to position weight
        const h11 = t3 - t2;               // to tangent weight

        // Compute tangent vectors from each snapshot's speed + heading.
        // Tangent = velocity * span (Hermite tangent is scaled by the interval).
        const spanScale = span / 1000 * 60; // convert ms → dt60-equivalent
        const fromSinPhi = Math.max(0.01, Math.sin(fromSnap.phi));
        const toSinPhi = Math.max(0.01, Math.sin(toSnap.phi));

        const fromTanPhi = -Math.cos(fromSnap.heading) * fromSnap.speed * spanScale;
        const toTanPhi = -Math.cos(toSnap.heading) * toSnap.speed * spanScale;
        const fromTanTheta = -Math.sin(fromSnap.heading) * fromSnap.speed / fromSinPhi * spanScale;
        const toTanTheta = -Math.sin(toSnap.heading) * toSnap.speed / toSinPhi * spanScale;

        // Hermite interpolation for phi (no wrapping needed, bounded [0, π])
        this.state.phi = h00 * fromSnap.phi + h10 * fromTanPhi
                       + h01 * toSnap.phi + h11 * toTanPhi;

        // For theta: compute Hermite delta from fromSnap.theta, then wrap
        let thetaDelta = toSnap.theta - fromSnap.theta;
        while (thetaDelta > Math.PI) thetaDelta -= Math.PI * 2;
        while (thetaDelta < -Math.PI) thetaDelta += Math.PI * 2;
        // Hermite on the delta: h01*delta replaces h00*from + h01*to
        let thetaResult = fromSnap.theta
          + h10 * fromTanTheta
          + h01 * thetaDelta
          + h11 * toTanTheta;
        while (thetaResult < 0) thetaResult += Math.PI * 2;
        while (thetaResult >= Math.PI * 2) thetaResult -= Math.PI * 2;
        this.state.theta = thetaResult;

        // Smoothstep for speed/heading/turret — eliminates acceleration
        // discontinuities at tick boundaries that cause lean spring jitter
        const st = t * t * (3 - 2 * t);
        this.state.heading = MathUtils.lerpAngle(fromSnap.heading, toSnap.heading, st);
        this.state.speed = fromSnap.speed + (toSnap.speed - fromSnap.speed) * st;
        this.state.turretAngle = MathUtils.lerpAngle(fromSnap.turretAngle, toSnap.turretAngle, st);
        interpolated = true;
      }
    }

    if (!interpolated) {
      // Not enough snapshots or renderTime is ahead — fall back to
      // dead-reckoning: extrapolate position forward using current speed/heading,
      // then smoothly blend state toward the latest server target.
      if (this.targetState.speed !== 0) {
        const heading = this.targetState.heading;
        const phi = this.targetState.phi;
        const velocityNorth = Math.cos(heading) * this.targetState.speed * dt60;
        const velocityEast = -Math.sin(heading) * this.targetState.speed * dt60;
        const sinPhi = Math.sin(phi);
        const safeSinPhi = Math.abs(sinPhi) < 0.01 ? 0.01 : sinPhi;
        this.targetState.phi -= velocityNorth;
        this.targetState.theta += velocityEast / safeSinPhi;
      }
      this.targetState.theta -= (SharedPhysics.PLANET_ROTATION_SPEED * dt60) / 60;
      while (this.targetState.theta < 0) this.targetState.theta += Math.PI * 2;
      while (this.targetState.theta >= Math.PI * 2) this.targetState.theta -= Math.PI * 2;

      // Fresh spawn with <=1 snapshot: snap directly to target to avoid
      // lerp-chase jitter (the state hasn't diverged yet, so snapping is seamless)
      if (snapCount <= 1) {
        this.state.theta = this.targetState.theta;
        this.state.phi = this.targetState.phi;
        this.state.heading = this.targetState.heading;
        this.state.speed = this.targetState.speed;
        this.state.turretAngle = this.targetState.turretAngle;
      } else {
        const lerpSpeed = 10;
        const t = Math.min(1, lerpSpeed * deltaTime);
        this.state.theta = MathUtils.lerpAngle2Pi(this.state.theta, this.targetState.theta, t);
        this.state.phi = this.state.phi + (this.targetState.phi - this.state.phi) * t;
        this.state.heading = MathUtils.lerpAngle(this.state.heading, this.targetState.heading, t);
        this.state.speed = this.state.speed + (this.targetState.speed - this.state.speed) * t;
        this.state.turretAngle = MathUtils.lerpAngle(this.state.turretAngle, this.targetState.turretAngle, t);
      }
    }

    // Counter planet rotation: convert from planet-fixed coords to world coords.
    // Only needed for the interpolation path — dead-reckoning already applies
    // counter-rotation to targetState (which state was lerped/snapped toward).
    if (interpolated) {
      this.state.theta -= (SharedPhysics.PLANET_ROTATION_SPEED * dt60) / 60;
    }
    while (this.state.theta < 0) this.state.theta += Math.PI * 2;
    while (this.state.theta >= Math.PI * 2) this.state.theta -= Math.PI * 2;

    // Update wiggle phase based on speed
    const speed = Math.abs(this.state.speed);
    if (speed > 0.00001 && deltaTime > 0) {
      const speedRatio = Math.min(speed / 0.0004, 1);
      this.state.wigglePhase += deltaTime * (12 + speedRatio * 18);
    }

    // Update momentum lean springs
    Tank.updateLeanState(this.state.lean, this.state.speed, this.state.heading, deltaTime, false);

    // Update 3D position on sphere (reuse Tank's static method)
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
      isDead: false,
      lean: this.state.lean,
    };
    Tank.updateEntityVisual(entity, this.sphereRadius);

    // Update turret rotation
    if (this.turretGroup) {
      this.turretGroup.quaternion.setFromAxisAngle(
        RemoteTank._yAxis,
        this.state.turretAngle
      );
    }
  }

  // ========================
  // DEATH SEQUENCE
  // ========================

  /**
   * Full death sequence: charred material + start fade timer.
   * Mirrors BotTanks._killBot / Tank._die flow.
   */
  die() {
    this.isDead = true;
    this.state.isDead = true;
    this.state.speed = 0;
    this.targetState.speed = 0;
    // Snap target to current position so there's no residual interpolation drift
    this.targetState.theta = this.state.theta;
    this.targetState.phi = this.state.phi;
    this.targetState.heading = this.state.heading;
    this.damageState = "dead";
    this.isFading = false;

    // Turn all meshes charred (dark gray)
    this._setDeadMaterial();

    // Start sink (2s charred delay + 5s sink into ground)
    this.fadeStartTime = performance.now();
    this.sinkDelay = 3000;
    this.sinkDuration = 5000;
    this.sinkDepth = 3;
    this.isFading = true;
    this._smokeFadeDone = false;
    // Random tilt axis and direction for death sink rotation
    const angle = Math.random() * Math.PI * 2;
    this._sinkTiltAxis = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).normalize();
    this._sinkTiltMax = (0.3 + Math.random() * 0.4) * (Math.random() < 0.5 ? 1 : -1);
  }

  _setDeadMaterial() {
    const charredColor = 0x3a3a3a;
    this.group.traverse((child) => {
      if (child.isMesh && child.material && child !== this.hitbox) {
        if (!child.material.color) return;
        // Cancel any in-progress hit flash BEFORE saving original material,
        // otherwise the white flash color gets saved as the "original"
        if (child.userData._hitFlashOrigColor !== undefined) {
          clearTimeout(child.userData._hitFlashTimer);
          child.material.color.setHex(child.userData._hitFlashOrigColor);
          delete child.userData._hitFlashOrigColor;
          delete child.userData._hitFlashTimer;
        }
        if (!child.userData.originalMaterial) {
          child.userData.originalMaterial = child.material;
          child.material = child.material.clone();
        }
        child.material.color.setHex(charredColor);
      }
    });
  }

  /**
   * Restore original materials (on respawn).
   */
  _restoreMaterials() {
    this.group.traverse((child) => {
      if (child.isMesh && child.userData.originalMaterial) {
        child.material = child.userData.originalMaterial;
        delete child.userData.originalMaterial;
      }
    });
  }

  /**
   * Called every frame. Drives the sink sequence.
   * Returns true when sink is fully complete.
   */
  updateFade() {
    if (!this.isFading) return false;

    const elapsed = performance.now() - this.fadeStartTime;

    // Fade smoke over the first 5 seconds
    const smokeDuration = 5000;
    if (elapsed < smokeDuration) {
      const smokeOpacity = 1 - (elapsed / smokeDuration);
      if (this.onSmokeFadeUpdate) this.onSmokeFadeUpdate(this, smokeOpacity);
    } else if (!this._smokeFadeDone) {
      this._smokeFadeDone = true;
      if (this.onSmokeFadeUpdate) this.onSmokeFadeUpdate(this, 0);
    }

    // Wait for charred delay before sinking
    if (elapsed < this.sinkDelay) return false;

    const sinkElapsed = elapsed - this.sinkDelay;
    const sinkProgress = Math.min(1, sinkElapsed / this.sinkDuration);

    if (sinkProgress >= 1) {
      if (this.onFadeComplete) this.onFadeComplete(this);
      return true;
    }

    // Ease-in: slow start, accelerates into ground
    const eased = sinkProgress * sinkProgress;

    // Sink bodyGroup in local Y + tilt on random axis
    if (this.bodyGroup) {
      this.bodyGroup.position.y = -eased * this.sinkDepth;
      this.bodyGroup.quaternion.setFromAxisAngle(this._sinkTiltAxis, eased * this._sinkTiltMax);
    }

    return false;
  }

  /**
   * Reset death state for respawn.
   */
  revive() {
    this.isDead = false;
    this.state.isDead = false;
    this._snapCount = 0;
    if (this.state.lean) this.state.lean.initialized = false;
    this.isFading = false;
    this.damageState = "healthy";
    this.smokeFullyFaded = false;
    this.tankFadeStarted = false;
    // Reset sink offset and tilt from death
    if (this.bodyGroup) {
      this.bodyGroup.position.y = 0;
      this.bodyGroup.quaternion.identity();
    }
    // Clear any lingering hit flash state before restoring materials
    this.group.traverse((child) => {
      if (child.isMesh && child.userData._hitFlashOrigColor !== undefined) {
        clearTimeout(child.userData._hitFlashTimer);
        delete child.userData._hitFlashOrigColor;
        delete child.userData._hitFlashTimer;
      }
    });
    this._restoreMaterials();
    this.group.visible = true;
  }

  /**
   * Teleport to a position (no interpolation, used on spawn/respawn).
   */
  teleportTo(theta, phi, heading) {
    this.state.theta = theta;
    this.state.phi = phi;
    this.state.heading = heading;
    this.targetState.theta = theta;
    this.targetState.phi = phi;
    this.targetState.heading = heading;
    // Clear snapshot buffer so we don't interpolate from old positions
    this._snapCount = 0;
    // Reset lean to prevent false acceleration spike
    if (this.state.lean) this.state.lean.initialized = false;
  }

  /**
   * Clean up — remove from scene.
   */
  destroy() {
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this.group = null;
    }
  }

  /**
   * Update LOD visibility (detailed meshes vs LOD box vs commander dot).
   * Delegates to Tank.updateTankLOD() which handles all tank types.
   */
  updateLOD(camera, frustum, options) {
    if (!this.group || !camera) return;
    camera.getWorldPosition(RemoteTank._cameraWorldPos);
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
      RemoteTank._cameraWorldPos,
      frustum,
      options
    );
  }

}

// Preallocated temps to avoid GC
RemoteTank._cameraWorldPos = new THREE.Vector3();
RemoteTank._yAxis = new THREE.Vector3(0, 1, 0);
