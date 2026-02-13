/**
 * AdLands - RemoteBodyguard
 * A lightweight bodyguard representation synced from the server.
 * Uses bodyguard visuals (black hull + faction accent trim) with
 * RemoteTank-style dead-reckoning interpolation.
 */

class RemoteBodyguard {
  constructor(scene, sphereRadius, bgData) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.id = bgData.id;
    this.faction = bgData.faction || bgData.f;
    this.index = bgData.index != null ? bgData.index : parseInt(bgData.id.split("-")[2]);
    this.side = bgData.side || (this.index === 0 ? "left" : "right");
    this.name = bgData.name || (this.index === 0 ? "Guard Alpha" : "Guard Beta");

    // Current interpolated state
    this.state = {
      theta: bgData.theta || bgData.t || 0,
      phi: bgData.phi || bgData.p || Math.PI / 2,
      heading: bgData.heading || bgData.h || 0,
      speed: bgData.speed || bgData.s || 0,
      keys: { w: false, a: false, s: false, d: false },
      isDead: false,
      wigglePhase: Math.random() * Math.PI * 2,
      lean: {
        pitchAngle: 0,
        pitchVelocity: 0,
        steerAngle: 0,
        steerVelocity: 0,
        prevSpeed: 0,
        prevHeading: 0,
        initialized: false,
      },
    };

    // Target state from server
    this.targetState = {
      theta: this.state.theta,
      phi: this.state.phi,
      heading: this.state.heading,
      speed: this.state.speed,
    };

    // Health
    this.hp = bgData.hp || 100;
    this.maxHp = bgData.maxHp || 100;
    this.isDead = bgData.isDead || false;
    this.damageState = "healthy";

    // Fade state
    this.isFading = false;
    this.fadeStartTime = 0;
    this.smokeFullyFaded = false;
    this.tankFadeStarted = false;
    this.onSmokeFadeUpdate = null;
    this.onFadeComplete = null;

    // Build mesh
    RemoteBodyguard._ensureSharedAssets();
    this._buildMesh();
  }

  // ========================
  // SHARED ASSETS (cached across all instances)
  // ========================

  static _ensureSharedAssets() {
    if (RemoteBodyguard._sharedGeom) return;

    RemoteBodyguard._sharedGeom = {
      hull: new THREE.BoxGeometry(2.5, 0.8, 5),
      frontSlope: new THREE.BoxGeometry(2.2, 0.5, 1.0),
      rear: new THREE.BoxGeometry(2.2, 1.0, 0.8),
      track: new THREE.BoxGeometry(0.6, 0.6, 5.2),
      turret: new THREE.BoxGeometry(1.5, 0.6, 1.8),
      barrel: new THREE.CylinderGeometry(0.15, 0.2, 2.5, 8),
      muzzle: new THREE.BoxGeometry(0.4, 0.3, 0.3),
      hitbox: new THREE.BoxGeometry(3, 1.5, 5.5),
      frontAccent: new THREE.BoxGeometry(2.7, 0.15, 0.2),
      rearAccent: new THREE.BoxGeometry(2.7, 0.15, 0.2),
      trackAccent: new THREE.BoxGeometry(0.12, 0.7, 5.4),
      sideAccent: new THREE.BoxGeometry(0.1, 0.12, 4.8),
      turretRing: new THREE.TorusGeometry(0.85, 0.1, 8, 16),
      barrelTipRing: new THREE.TorusGeometry(0.2, 0.06, 8, 12),
      midBarrelRing: new THREE.TorusGeometry(0.18, 0.05, 8, 12),
    };

    RemoteBodyguard._materials = {};
  }

  static _getFactionMaterials(faction) {
    if (RemoteBodyguard._materials[faction]) return RemoteBodyguard._materials[faction];

    const factionData = FACTION_COLORS[faction];
    if (!factionData) return null;

    const accentColor = new THREE.Color(factionData.vehicle.primary);

    RemoteBodyguard._materials[faction] = {
      hull: new THREE.MeshStandardMaterial({
        color: 0x0a0a0a,
        roughness: 0.4,
        metalness: 0.6,
        flatShading: true,
      }),
      turret: new THREE.MeshStandardMaterial({
        color: 0x0f0f0f,
        roughness: 0.3,
        metalness: 0.7,
        flatShading: true,
      }),
      track: new THREE.MeshStandardMaterial({
        color: 0x1a1a1a,
        roughness: 0.9,
        metalness: 0.2,
        flatShading: true,
      }),
      barrel: new THREE.MeshStandardMaterial({
        color: 0x151515,
        roughness: 0.4,
        metalness: 0.7,
        flatShading: true,
      }),
      accent: new THREE.MeshStandardMaterial({
        color: accentColor,
        roughness: 0.2,
        metalness: 0.9,
        emissive: accentColor,
        emissiveIntensity: 0.6,
        flatShading: true,
      }),
    };

    return RemoteBodyguard._materials[faction];
  }

  // ========================
  // MESH CONSTRUCTION (matches CommanderBodyguards._createBodyguard)
  // ========================

  _buildMesh() {
    const mat = RemoteBodyguard._getFactionMaterials(this.faction);
    const geom = RemoteBodyguard._sharedGeom;
    if (!mat || !geom) return;

    this.group = new THREE.Group();
    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);

    // Hull
    const hull = new THREE.Mesh(geom.hull, mat.hull);
    hull.position.y = 0.4;
    hull.castShadow = true;
    hull.receiveShadow = true;
    this.bodyGroup.add(hull);

    // Front slope
    const frontSlope = new THREE.Mesh(geom.frontSlope, mat.hull);
    frontSlope.position.set(0, 0.7, -2.5);
    frontSlope.rotation.x = 0.3;
    frontSlope.castShadow = true;
    frontSlope.receiveShadow = true;
    this.bodyGroup.add(frontSlope);

    // Rear
    const rear = new THREE.Mesh(geom.rear, mat.hull);
    rear.position.set(0, 0.5, 2.6);
    rear.castShadow = true;
    rear.receiveShadow = true;
    this.bodyGroup.add(rear);

    // Tracks
    const leftTrack = new THREE.Mesh(geom.track, mat.track);
    leftTrack.position.set(-1.3, 0.3, 0);
    leftTrack.castShadow = true;
    leftTrack.receiveShadow = true;
    this.bodyGroup.add(leftTrack);

    const rightTrack = new THREE.Mesh(geom.track, mat.track);
    rightTrack.position.set(1.3, 0.3, 0);
    rightTrack.castShadow = true;
    rightTrack.receiveShadow = true;
    this.bodyGroup.add(rightTrack);

    // Accent trim
    const frontAccent = new THREE.Mesh(geom.frontAccent, mat.accent);
    frontAccent.position.set(0, 0.85, -2.55);
    this.bodyGroup.add(frontAccent);

    const rearAccent = new THREE.Mesh(geom.rearAccent, mat.accent);
    rearAccent.position.set(0, 0.85, 2.55);
    this.bodyGroup.add(rearAccent);

    const leftTrackAccent = new THREE.Mesh(geom.trackAccent, mat.accent);
    leftTrackAccent.position.set(-1.66, 0.35, 0);
    this.bodyGroup.add(leftTrackAccent);

    const rightTrackAccent = new THREE.Mesh(geom.trackAccent, mat.accent);
    rightTrackAccent.position.set(1.66, 0.35, 0);
    this.bodyGroup.add(rightTrackAccent);

    const leftSideAccent = new THREE.Mesh(geom.sideAccent, mat.accent);
    leftSideAccent.position.set(-1.28, 0.85, 0);
    this.bodyGroup.add(leftSideAccent);

    const rightSideAccent = new THREE.Mesh(geom.sideAccent, mat.accent);
    rightSideAccent.position.set(1.28, 0.85, 0);
    this.bodyGroup.add(rightSideAccent);

    // Turret group
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.y = 0.8;

    const turret = new THREE.Mesh(geom.turret, mat.turret);
    turret.position.y = 0.3;
    turret.castShadow = true;
    turret.receiveShadow = true;
    this.turretGroup.add(turret);

    const turretRing = new THREE.Mesh(geom.turretRing, mat.accent);
    turretRing.rotation.x = Math.PI / 2;
    turretRing.position.set(0, 0.02, 0);
    this.turretGroup.add(turretRing);

    const barrelMesh = new THREE.Mesh(geom.barrel, mat.barrel);
    barrelMesh.rotation.x = -Math.PI / 2;
    barrelMesh.position.set(0, 0.4, -2.0);
    barrelMesh.castShadow = true;
    barrelMesh.receiveShadow = true;
    this.turretGroup.add(barrelMesh);

    const muzzle = new THREE.Mesh(geom.muzzle, mat.barrel);
    muzzle.position.set(0, 0.4, -3.2);
    muzzle.castShadow = true;
    muzzle.receiveShadow = true;
    this.turretGroup.add(muzzle);

    const barrelTipRing = new THREE.Mesh(geom.barrelTipRing, mat.accent);
    barrelTipRing.rotation.x = Math.PI / 2;
    barrelTipRing.position.set(0, 0.4, -3.38);
    this.turretGroup.add(barrelTipRing);

    const midBarrelRing = new THREE.Mesh(geom.midBarrelRing, mat.accent);
    midBarrelRing.rotation.x = Math.PI / 2;
    midBarrelRing.position.set(0, 0.4, -1.5);
    this.turretGroup.add(midBarrelRing);

    this.bodyGroup.add(this.turretGroup);

    // Enable layer 1 for spotlights
    this.bodyGroup.traverse((child) => {
      if (child.isMesh) child.layers.enable(1);
    });

    // Hitbox
    this.hitbox = new THREE.Mesh(
      geom.hitbox,
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.hitbox.position.set(0, 0.75, 0);
    this.hitbox.userData.type = "bodyguard";
    this.hitbox.userData.tankRef = this;
    this.group.add(this.hitbox);

    this.group.visible = true;
    this.scene.add(this.group);
  }

  // ========================
  // SERVER STATE
  // ========================

  setTargetState(serverState) {
    // Dead bodyguards ignore server position updates — the client-side
    // update() loop handles planet rotation counter-rotation only.
    if (this.isDead) return;

    this.targetState.theta = serverState.t;
    this.targetState.phi = serverState.p;
    this.targetState.heading = serverState.h;
    this.targetState.speed = serverState.s;
    this.hp = serverState.hp;
  }

  // ========================
  // INTERPOLATION + UPDATE (matches RemoteTank.update)
  // ========================

  update(deltaTime) {
    if (!this.group) return;

    const dt60 = deltaTime * 60;

    if (this.isDead) {
      // Dead bodyguards: no interpolation, no dead-reckoning — only counter
      // planet rotation so the wreck stays fixed on the surface.
      this.state.theta -= (SharedPhysics.PLANET_ROTATION_SPEED * dt60) / 60;
      while (this.state.theta < 0) this.state.theta += Math.PI * 2;
      while (this.state.theta >= Math.PI * 2) this.state.theta -= Math.PI * 2;
      // Keep target in sync so there's no snap if revived
      this.targetState.theta = this.state.theta;
      this.targetState.phi = this.state.phi;

      this.state.speed = 0;

      // Settle lean springs to zero
      Tank.updateLeanState(this.state.lean, 0, this.state.heading, deltaTime, true);

      // Update visual (keeps mesh positioned correctly on rotating planet)
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

    // Dead-reckon the target forward using speed + heading
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

    // Counter planet rotation (scene children, not hexGroup)
    this.targetState.theta -= (SharedPhysics.PLANET_ROTATION_SPEED * dt60) / 60;
    while (this.targetState.theta < 0) this.targetState.theta += Math.PI * 2;
    while (this.targetState.theta >= Math.PI * 2) this.targetState.theta -= Math.PI * 2;

    // Interpolate toward target
    const lerpSpeed = 10;
    const t = Math.min(1, lerpSpeed * deltaTime);

    this.state.theta = this._lerpAngle2Pi(this.state.theta, this.targetState.theta, t);
    this.state.phi = this.state.phi + (this.targetState.phi - this.state.phi) * t;
    this.state.heading = this._lerpAnglePi(this.state.heading, this.targetState.heading, t);
    this.state.speed = this.state.speed + (this.targetState.speed - this.state.speed) * t;

    // Wiggle phase
    const speed = Math.abs(this.state.speed);
    if (speed > 0.00001 && deltaTime > 0) {
      const speedRatio = Math.min(speed / 0.00025, 1);
      this.state.wigglePhase += deltaTime * (12 + speedRatio * 18);
    }

    // Lean springs
    Tank.updateLeanState(this.state.lean, this.state.speed, this.state.heading, deltaTime, false);

    // Position on sphere
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
  }

  // ========================
  // DEATH SEQUENCE (matches RemoteTank)
  // ========================

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

    this._setDeadMaterial();

    this.fadeStartTime = performance.now();
    this.smokeFadeDuration = 5000; // Bodyguards use 5s smoke (matches client)
    this.sinkDelay = 1500;
    this.fadeDuration = 3000;
    this.isFading = true;
    this.smokeFullyFaded = false;
    this.tankFadeStarted = false;
  }

  _setDeadMaterial() {
    const charredColor = 0x3a3a3a;
    this.group.traverse((child) => {
      if (child.isMesh && child.material && child !== this.hitbox) {
        if (!child.material.color) return;
        if (!child.userData.originalMaterial) {
          child.userData.originalMaterial = child.material;
          child.material = child.material.clone();
        }
        child.material.color.setHex(charredColor);
        if (child.material.emissive) {
          child.material.emissive.setHex(0x000000);
          child.material.emissiveIntensity = 0;
        }
      }
    });
  }

  updateFade() {
    if (!this.isFading) return false;

    const elapsed = performance.now() - this.fadeStartTime;

    // Phase 1: Smoke fades
    if (elapsed < this.smokeFadeDuration) {
      const smokeOpacity = 1 - elapsed / this.smokeFadeDuration;
      if (this.onSmokeFadeUpdate) this.onSmokeFadeUpdate(this, smokeOpacity);
      return false;
    }

    if (!this.smokeFullyFaded) {
      this.smokeFullyFaded = true;
      if (this.onSmokeFadeUpdate) this.onSmokeFadeUpdate(this, 0);
    }

    // Phase 2: Delay
    const delayElapsed = elapsed - this.smokeFadeDuration;
    if (delayElapsed < this.sinkDelay) return false;

    // Phase 3: Tank fades + sinks
    const fadeElapsed = delayElapsed - this.sinkDelay;
    const fadeProgress = Math.min(1, fadeElapsed / this.fadeDuration);

    if (fadeProgress >= 1) {
      if (this.onFadeComplete) this.onFadeComplete(this);
      return true;
    }

    if (!this.tankFadeStarted) {
      this.tankFadeStarted = true;
      this.group.traverse((child) => {
        if (child.isMesh && child.material && child !== this.hitbox) {
          child.material = child.material.clone();
          child.material.transparent = true;
        }
      });
    }

    const easedProgress = fadeProgress * fadeProgress;
    const opacity = 1 - easedProgress;

    const sinkDistance = 3 * easedProgress;
    const normal = this.group.position.clone().normalize();
    this.group.position.addScaledVector(normal, -sinkDistance);

    this.group.traverse((child) => {
      if (child.isMesh && child.material && child !== this.hitbox) {
        child.material.opacity = opacity;
      }
    });

    return false;
  }

  revive() {
    this.isDead = false;
    this.state.isDead = false;
    if (this.state.lean) this.state.lean.initialized = false;
    this.isFading = false;
    this.damageState = "healthy";
    this.smokeFullyFaded = false;
    this.tankFadeStarted = false;

    this.group.traverse((child) => {
      if (child.isMesh && child.userData.originalMaterial) {
        child.material = child.userData.originalMaterial;
        delete child.userData.originalMaterial;
      }
    });
    this.group.visible = true;
  }

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

  // ========================
  // INTERPOLATION HELPERS
  // ========================

  _lerpAngle2Pi(a, b, t) {
    let delta = b - a;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    let result = a + delta * t;
    while (result < 0) result += Math.PI * 2;
    while (result >= Math.PI * 2) result -= Math.PI * 2;
    return result;
  }

  _lerpAnglePi(a, b, t) {
    let delta = b - a;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return a + delta * t;
  }
}

// Static shared assets
RemoteBodyguard._sharedGeom = null;
RemoteBodyguard._materials = {};
