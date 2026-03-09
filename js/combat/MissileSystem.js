/**
 * AdLands - Missile System
 * Homing missiles that lock onto the closest enemy, launch vertically,
 * cruise at altitude, then dive to impact. Bypasses shields.
 *
 * Dependencies: THREE.js, FACTION_COLORS, MathUtils (must be loaded before this file)
 */

class MissileSystem {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;

    // References (set from main.js)
    this.playerTank = null;
    this.botTanks = null;
    this.cannonSystem = null;
    this.dustShockwave = null;
    this.gameCamera = null;
    this.planet = null;
    this.weaponSlotSystem = null;
    this.cryptoSystem = null;
    this.flareSystem = null;

    // Config
    this.config = {
      cooldown: 2,             // Seconds between shots
      cost: 5,                 // Crypto cost per missile (same as cannon base)
      damage: 38,              // 25 * 1.5 missile multiplier
      missileSpeed: 0.1536,    // World units per frame (80% of tank top speed: 0.0004 * 480 * 0.8)
      launchDuration: 0.5,     // Seconds in vertical launch phase
      cruiseAltitude: 8,       // World units above surface
      diveDistance: 10,         // Start dive when within this distance
      turnRate: 1.5,           // Radians/sec — lower = wider turning arc
      searchRadiusMin: 20,     // Starting lock-on range (world units)
      searchRadiusMax: 120,    // Max lock-on range (world units)
      searchExpandTime: 3,     // Seconds to reach max range
    };

    // Lock-on state
    this._missileEquipped = false;
    this._locking = false;
    this._lockStartTime = 0;
    this._currentSearchRadius = 0;
    this._lockedTarget = null;
    this._lastLockedTank = null;
    this._lockFlashTime = 0;

    // Cooldown
    this._lastFireTime = 0;

    // Active missiles (local visual)
    this.missiles = [];

    // Missile mesh pool
    this._pool = [];
    this._poolMax = 30;
    this._sharedGeometry = null;
    this._materials = {};
    this._createMissileAssets();

    // Lock-on reticle (DOM) — shows what the player is locking onto
    this._createLockOnReticle();

    // Missile-tracking reticles (DOM pool) — one per active missile
    this._trackingReticles = [];
    this._trackingReticlePool = [];

    // Incoming missile warning (DOM)
    this._incomingMissileCount = 0;
    this._createIncomingWarning();

    // Afterburner particle system
    this._createAfterburnerSystem();

    // Smoke trail particle system
    this._createSmokeTrailSystem();

    // Preallocated temp vectors
    this._tempVec = new THREE.Vector3();
    this._tempVec2 = new THREE.Vector3();
    this._tempVec3 = new THREE.Vector3();
    this._tempQuat = new THREE.Quaternion();
    this._tempQuat2 = new THREE.Quaternion();
    this._upVec = new THREE.Vector3(0, 1, 0);

    // Mesh orientation offset: missile is built along +Y, lookAt points -Z.
    // Rotate -90° around X so +Y aligns with -Z (nose faces travel direction).
    this._meshOrientQuat = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  }

  // ========================
  // ASSET CREATION
  // ========================

  _createMissileAssets() {
    // Missile body: cylinder + cone nose
    const bodyGeo = new THREE.CylinderGeometry(0.15, 0.15, 1.2, 6);
    const noseGeo = new THREE.ConeGeometry(0.15, 0.4, 6);
    noseGeo.translate(0, 1.0, 0); // Attach at top of body

    // Fins: four small planes at the tail
    const finGeo = new THREE.BoxGeometry(0.02, 0.3, 0.2);

    // Merge into a single geometry group
    const group = new THREE.Group();
    const tempMat = new THREE.MeshBasicMaterial();
    const bodyMesh = new THREE.Mesh(bodyGeo, tempMat);
    const noseMesh = new THREE.Mesh(noseGeo, tempMat);
    group.add(bodyMesh);
    group.add(noseMesh);

    // Add fins at 4 cardinal positions
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeo, tempMat);
      const angle = (i * Math.PI) / 2;
      fin.position.set(Math.cos(angle) * 0.15, -0.5, Math.sin(angle) * 0.15);
      fin.rotation.y = angle;
      group.add(fin);
    }

    // Store component geometries for per-faction mesh building
    this._bodyGeo = bodyGeo;
    this._noseGeo = noseGeo;
    this._finGeo = finGeo;

    // Create faction materials — same color as tank hull
    for (const faction of ["rust", "cobalt", "viridian"]) {
      this._materials[faction] = new THREE.MeshBasicMaterial({
        color: FACTION_COLORS[faction].vehicle.primary,
      });
    }

    // Pre-populate pool
    for (let i = 0; i < 10; i++) {
      this._pool.push(this._createPoolItem());
    }
  }

  _createPoolItem() {
    const group = new THREE.Group();

    // Will be assigned faction material on acquire
    const bodyMesh = new THREE.Mesh(this._bodyGeo, this._materials.rust);
    const noseMesh = new THREE.Mesh(this._noseGeo, this._materials.rust);
    group.add(bodyMesh);
    group.add(noseMesh);

    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(this._finGeo, this._materials.rust);
      const angle = (i * Math.PI) / 2;
      fin.position.set(Math.cos(angle) * 0.15, -0.5, Math.sin(angle) * 0.15);
      fin.rotation.y = angle;
      group.add(fin);
    }

    // Point light for glow
    const light = new THREE.PointLight(0xffffff, 1, 15);
    light.position.set(0, -0.6, 0); // At tail
    group.add(light);
    group.position.set(0, -9999, 0);

    return { group, bodyMesh, noseMesh, light, inUse: false };
  }

  _acquirePoolItem(faction) {
    let item = this._pool.find((p) => !p.inUse);
    if (!item) {
      if (this._pool.length < this._poolMax) {
        item = this._createPoolItem();
        this._pool.push(item);
      } else {
        // Recycle oldest — find the in-use item and invalidate any missile referencing it
        item = this._pool.find((p) => p.inUse);
        if (item) {
          // Invalidate any missile still referencing this pool item
          for (const m of this.missiles) {
            if (m.poolItem === item) {
              m.poolItem = null; // Mark as orphaned
            }
          }
          this._releasePoolItem(item);
        }
      }
    }
    if (!item) return null;

    item.inUse = true;
    const mat = this._materials[faction] || this._materials.rust;
    // Update all child mesh materials
    item.group.traverse((child) => {
      if (child.isMesh) child.material = mat;
    });
    item.light.color.setHex(FACTION_COLORS[faction]?.hex || 0xff4444);
    this.scene.add(item.group);
    return item;
  }

  _releasePoolItem(item) {
    item.inUse = false;
    this.scene.remove(item.group);
    item.group.position.set(0, -9999, 0);
  }

  // ========================
  // LOCK-ON RETICLE (DOM)
  // ========================

  _createLockOnReticle() {
    this.lockOnReticle = document.createElement("div");
    this.lockOnReticle.id = "missile-lock-reticle";
    this.lockOnReticle.style.cssText =
      "position:fixed;width:48px;height:48px;pointer-events:none;z-index:50;" +
      "will-change:transform;transform:translate(-50%,-50%);display:none;";

    // Four corner brackets
    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    for (const corner of corners) {
      const el = document.createElement("div");
      el.className = "lock-corner lock-" + corner;
      this.lockOnReticle.appendChild(el);
    }

    document.body.appendChild(this.lockOnReticle);
  }

  _acquireTrackingReticle() {
    if (this._trackingReticlePool.length > 0) {
      const el = this._trackingReticlePool.pop();
      el.style.display = "none";
      return el;
    }
    const el = document.createElement("div");
    el.className = "missile-tracking-reticle";
    el.style.cssText =
      "position:fixed;width:28px;height:28px;pointer-events:none;z-index:50;" +
      "will-change:transform;transform:translate(-50%,-50%);display:none;";
    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    for (const corner of corners) {
      const c = document.createElement("div");
      c.className = "track-corner track-" + corner;
      el.appendChild(c);
    }
    document.body.appendChild(el);
    return el;
  }

  _releaseTrackingReticle(el) {
    el.style.display = "none";
    this._trackingReticlePool.push(el);
  }

  _updateTrackingReticles(camera) {
    // Collect local missiles that have a target (phases 1 and 2)
    const activeMissiles = [];
    for (let i = 0; i < this.missiles.length; i++) {
      const m = this.missiles[i];
      if (!m.isRemote && m.targetTank && (m.phase === 1 || m.phase === 2)) {
        activeMissiles.push(m);
      }
    }

    // Return excess reticles to pool
    while (this._trackingReticles.length > activeMissiles.length) {
      this._releaseTrackingReticle(this._trackingReticles.pop());
    }
    // Acquire more if needed
    while (this._trackingReticles.length < activeMissiles.length) {
      this._trackingReticles.push(this._acquireTrackingReticle());
    }

    // Update positions
    for (let i = 0; i < activeMissiles.length; i++) {
      const m = activeMissiles[i];
      const el = this._trackingReticles[i];

      if (this.hideReticle) {
        el.style.display = "none";
        continue;
      }

      const worldPos = this._getTargetWorldPos(m.targetTank);
      if (!worldPos) {
        el.style.display = "none";
        continue;
      }

      this._tempVec.copy(worldPos).project(camera);
      if (this._tempVec.z > 1) {
        el.style.display = "none";
        continue;
      }

      const screenX = (this._tempVec.x * 0.5 + 0.5) * window.innerWidth;
      const screenY = (-this._tempVec.y * 0.5 + 0.5) * window.innerHeight;

      el.style.left = screenX + "px";
      el.style.top = screenY + "px";
      el.style.display = "";

      const pulse = Math.sin(performance.now() * 0.008) * 0.12 + 1.0;
      el.style.transform = `translate(-50%,-50%) rotate(45deg) scale(${pulse})`;
    }
  }

  _createIncomingWarning() {
    this._incomingWarning = document.createElement("div");
    this._incomingWarning.id = "missile-incoming-warning";
    this._incomingWarning.textContent = "MISSILE INCOMING";
    this._incomingWarning.style.display = "none";
    document.body.appendChild(this._incomingWarning);
  }

  showIncomingWarning() {
    this._incomingMissileCount++;
    if (this._incomingWarning && !this.hideReticle) {
      this._incomingWarning.style.display = "";
    }
  }

  hideIncomingWarning() {
    this._incomingMissileCount = Math.max(0, this._incomingMissileCount - 1);
    if (this._incomingMissileCount === 0 && this._incomingWarning) {
      this._incomingWarning.style.display = "none";
    }
  }

  _updateLockOnReticle(camera) {
    if (!this.lockOnReticle) return;

    // Hide reticle when not in surface combat view
    if (this.hideReticle) {
      this.lockOnReticle.style.display = "none";
      return;
    }

    if (!this._lockedTarget) {
      this.lockOnReticle.style.display = "none";
      return;
    }

    const targetTank = this._lockedTarget.tank;
    if (!targetTank) {
      this.lockOnReticle.style.display = "none";
      return;
    }

    // Get target world position
    const worldPos = this._getTargetWorldPos(targetTank);
    if (!worldPos) {
      this.lockOnReticle.style.display = "none";
      return;
    }

    // Project to screen
    this._tempVec.copy(worldPos).project(camera);

    // Behind camera check
    if (this._tempVec.z > 1) {
      this.lockOnReticle.style.display = "none";
      return;
    }

    const screenX = (this._tempVec.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-this._tempVec.y * 0.5 + 0.5) * window.innerHeight;

    this.lockOnReticle.style.left = screenX + "px";
    this.lockOnReticle.style.top = screenY + "px";
    this.lockOnReticle.style.display = "";

    // Continuous size pulse while locked
    const pulse = Math.sin(performance.now() * 0.006) * 0.15 + 1.0;
    this.lockOnReticle.style.transform = `translate(-50%,-50%) scale(${pulse})`;
  }

  _getTargetWorldPos(tank) {
    // Bot tank
    if (tank.hitbox) {
      tank.hitbox.updateWorldMatrix(true, false);
      return tank.hitbox.getWorldPosition(this._tempVec2);
    }
    // Remote tank
    if (tank.group) {
      return tank.group._cachedWorldPos || tank.group.position;
    }
    return null;
  }

  // ========================
  // TARGET ACQUISITION
  // ========================

  _findClosestEnemyTank(searchRadius) {
    if (!this.playerTank) return null;
    const playerPos =
      this.playerTank.group._cachedWorldPos || this.playerTank.group.position;
    const playerFaction = this.playerTank.faction;
    let closest = null;
    let closestDist = Infinity;

    // Check bots
    if (this.botTanks) {
      const bots = this.botTanks.bots;
      if (bots) {
        for (let i = 0; i < bots.length; i++) {
          const bot = bots[i];
          if (!bot || bot.isDead || bot.isDeploying || bot.faction === playerFaction) continue;
          if (!bot.hitbox) continue;
          bot.hitbox.updateWorldMatrix(true, false);
          const pos = bot.hitbox.getWorldPosition(this._tempVec3);
          const dist = pos.distanceTo(playerPos);
          if (dist < closestDist && dist <= searchRadius) {
            closest = { tank: bot, worldPos: pos.clone(), distance: dist };
            closestDist = dist;
          }
        }
      }
    }

    // Check remote tanks (multiplayer)
    if (window._mpState?.remoteTanks) {
      for (const [, remoteTank] of window._mpState.remoteTanks) {
        if (remoteTank.isDead || remoteTank.faction === playerFaction) continue;
        const pos = this._getTargetWorldPos(remoteTank);
        if (!pos) continue;
        const dist = pos.distanceTo(playerPos);
        if (dist < closestDist && dist <= searchRadius) {
          closest = {
            tank: remoteTank,
            worldPos: pos.clone(),
            distance: dist,
          };
          closestDist = dist;
        }
      }
    }

    return closest;
  }

  // Find closest enemy from a missile's world position (for in-flight retargeting)
  // missileDir: current travel direction (if provided, only targets in forward hemisphere)
  // maxRange: maximum distance in world units (default: searchRadiusMax = 120)
  _findClosestEnemyFromPos(missilePos, ownerFaction, missileDir, maxRange) {
    const range = maxRange || this.config.searchRadiusMax;
    let closest = null;
    let closestDist = Infinity;

    if (this.botTanks?.bots) {
      for (let i = 0; i < this.botTanks.bots.length; i++) {
        const bot = this.botTanks.bots[i];
        if (!bot || bot.isDead || bot.isDeploying || bot.faction === ownerFaction) continue;
        if (!bot.hitbox) continue;
        bot.hitbox.updateWorldMatrix(true, false);
        const pos = bot.hitbox.getWorldPosition(this._tempVec3);
        // Skip targets behind the missile (prevents U-turns back toward owner)
        if (missileDir) {
          const toTarget = this._tempVec.copy(pos).sub(missilePos);
          if (toTarget.dot(missileDir) < 0) continue;
        }
        const dist = pos.distanceTo(missilePos);
        if (dist < closestDist && dist <= range) {
          closest = { tank: bot, worldPos: pos.clone(), distance: dist };
          closestDist = dist;
        }
      }
    }

    if (window._mpState?.remoteTanks) {
      for (const [, remoteTank] of window._mpState.remoteTanks) {
        if (remoteTank.isDead || remoteTank.faction === ownerFaction) continue;
        const pos = this._getTargetWorldPos(remoteTank);
        if (!pos) continue;
        // Skip targets behind the missile
        if (missileDir) {
          const toTarget = this._tempVec.copy(pos).sub(missilePos);
          if (toTarget.dot(missileDir) < 0) continue;
        }
        const dist = pos.distanceTo(missilePos);
        if (dist < closestDist && dist <= range) {
          closest = {
            tank: remoteTank,
            worldPos: pos.clone(),
            distance: dist,
          };
          closestDist = dist;
        }
      }
    }

    // Local player is a valid target for remote (enemy) missiles
    if (this.playerTank && !this.playerTank.isDead &&
        this.playerTank.faction !== ownerFaction) {
      const pos = this._getTargetWorldPos(this.playerTank);
      if (pos) {
        if (!missileDir || this._tempVec.copy(pos).sub(missilePos).dot(missileDir) >= 0) {
          const dist = pos.distanceTo(missilePos);
          if (dist < closestDist && dist <= range) {
            closest = { tank: this.playerTank, worldPos: pos.clone(), distance: dist };
            closestDist = dist;
          }
        }
      }
    }

    // Flares as decoy targets (attract missiles from any faction)
    if (window.flareSystem) {
      const flares = window.flareSystem.getActiveFlares();
      for (let i = 0; i < flares.length; i++) {
        const flare = flares[i];
        const pos = flare.position;
        const dist = pos.distanceTo(missilePos);
        if (dist < closestDist && dist <= range) {
          closest = { tank: null, worldPos: pos.clone(), distance: dist, isFlare: true };
          closestDist = dist;
        }
      }
    }

    return closest;
  }

  // ========================
  // LOCK-ON / FIRING
  // ========================

  startLockOn() {
    const now = performance.now() / 1000;
    if (now - this._lastFireTime < this.config.cooldown) return;

    this._locking = true;
    this._lockStartTime = now;
    this._currentSearchRadius = this.config.searchRadiusMin;
    this._lockedTarget = null;
    this._lastLockedTank = null;
  }

  isLocking() {
    return this._locking;
  }

  setMissileEquipped(active) {
    this._missileEquipped = active;
    if (!active) {
      this._lockedTarget = null;
      if (this.lockOnReticle) this.lockOnReticle.style.display = "none";
    }
  }

  cancelLockOn() {
    this._locking = false;
    this._lockedTarget = null;
    if (this.lockOnReticle) this.lockOnReticle.style.display = "none";
    if (this.gameCamera) this.gameCamera.setChargePullback(0);
    // Don't clear missileMode here — it's managed by weapon slot changes
  }

  releaseLockOn(tank, faction) {
    if (!this._locking) return;
    this._locking = false;

    // Camera reset
    if (this.gameCamera) this.gameCamera.setChargePullback(0);

    // Fire if we have a target
    if (this._lockedTarget) {
      this._fire(tank, faction, this._lockedTarget);
    }

    this._lockedTarget = null;
    this.lockOnReticle.style.display = "none";
  }

  _fire(tank, faction, target) {
    const now = performance.now() / 1000;

    // Economy check
    if (this.cryptoSystem) {
      const stats = this.cryptoSystem.stats;
      if (stats.totalCrypto < this.config.cost) return;
    }

    this._lastFireTime = now;

    // Spawn local visual missile
    const tankPos =
      tank.group._cachedWorldPos || tank.group.position;
    const surfaceNormal = this._tempVec.copy(tankPos).normalize();

    const startPos = tankPos
      .clone()
      .addScaledVector(surfaceNormal, 1.5); // Start slightly above tank

    const poolItem = this._acquirePoolItem(faction);
    if (!poolItem) return;

    // Shadow billboard at launch point
    let shadowBB = null;
    if (this.flareSystem) {
      shadowBB = this.flareSystem._acquireShadowBillboard(
        tankPos.clone(), surfaceNormal.clone(), this.config.cruiseAltitude
      );
    }

    const missile = {
      poolItem,
      position: startPos.clone(),
      surfaceNormal: surfaceNormal.clone(),
      faction,
      phase: 0, // 0=launch, 1=cruise, 2=dive
      age: 0,
      launchSpeed: 5,
      cruiseAltitude: this.config.cruiseAltitude,
      targetTank: target.tank,
      targetFaction: target.tank.faction,
      direction: null,  // Initialized when entering phase 1
      isRemote: false,
      serverId: null,
      shadowBB,
    };

    this.missiles.push(missile);
    poolItem.group.position.copy(startPos);

    // Dust wave on launch
    if (this.dustShockwave) {
      this.dustShockwave.emit(tankPos, 0.4);
    }

    // Camera shake
    if (this.gameCamera) {
      this.gameCamera.triggerShake(tankPos, tankPos, 0.3, 100);
    }

    // Recoil
    if (tank.triggerRecoil) tank.triggerRecoil();

    // Notify server
    if (window._mp && window._mp.onMissileFire) {
      window._mp.onMissileFire(
        tank.state.turretAngle,
        this._currentSearchRadius
      );
    }

    // Show red spend floater for missile fire cost
    if (window.cryptoVisuals && tank.group) {
      tank.group.getWorldPosition(this._tempVec);
      window.cryptoVisuals._spawnFloatingNumber(-this.config.cost, this._tempVec);
    }
  }

  // Spawn visual-only missile from remote player
  spawnRemoteMissile(data, remoteTank) {
    const faction = data.faction || remoteTank?.faction || "rust";
    const poolItem = this._acquirePoolItem(faction);
    if (!poolItem) return;

    // Compute start position from server data
    const startPos = new THREE.Vector3(data.wx, data.wy, data.wz);
    const surfaceNormal = startPos.clone().normalize();
    const surfacePos = surfaceNormal.clone().multiplyScalar(this.sphereRadius);

    // Shadow billboard at launch point
    let shadowBB = null;
    if (this.flareSystem) {
      shadowBB = this.flareSystem._acquireShadowBillboard(
        surfacePos, surfaceNormal, this.config.cruiseAltitude
      );
    }

    const missile = {
      poolItem,
      position: startPos.clone(),
      surfaceNormal,
      faction,
      phase: 0,
      age: 0,
      launchSpeed: 5,
      cruiseAltitude: this.config.cruiseAltitude,
      targetTank: null, // Will find target each frame
      targetFaction: null,
      direction: null,  // Initialized when entering phase 1
      isRemote: true,
      ownerFaction: faction,
      serverId: data.projectileId,
      shadowBB,
    };

    this.missiles.push(missile);
    poolItem.group.position.copy(startPos);

    // Dust wave
    if (this.dustShockwave) {
      this.dustShockwave.emit(startPos, 0.4);
    }
  }

  // Remove a missile by server projectile ID (when server reports hit)
  removeByServerId(projectileId) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      if (this.missiles[i].serverId === projectileId) {
        this._destroyMissile(i, this.missiles[i].position);
        return;
      }
    }
  }

  // Force a missile into crash-dive (phase 4) by server projectile ID
  crashByServerId(projectileId, theta, phi) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (m.serverId === projectileId) {
        m.phase = 4;
        m.targetTank = null;
        // Compute crash point on planet surface from server coords
        const sp = Math.sin(phi), cp = Math.cos(phi);
        const st = Math.sin(theta), ct = Math.cos(theta);
        const R = this.sphereRadius;
        m.diveTarget = new THREE.Vector3(R * sp * st, R * cp, R * sp * ct);
        return;
      }
    }
  }

  // Force a missile into wobble phase (phase 3) by server projectile ID
  wobbleByServerId(projectileId) {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (m.serverId === projectileId) {
        if (m.phase < 3) {
          m.phase = 3;
          m.isLost = true;
          m.lostAge = 0;
          m.targetTank = null;
        }
        return;
      }
    }
  }

  // Remove the local player's missile (serverId is null — can't match by ID)
  removeLocalMissile() {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      if (!this.missiles[i].isRemote) {
        this._destroyMissile(i, this.missiles[i].position);
        return;
      }
    }
  }

  // ========================
  // UPDATE LOOP
  // ========================

  update(deltaTime, frustum, camera) {
    // Suppress incoming warning when not deployed
    if (this.hideReticle && this._incomingWarning) {
      this._incomingWarning.style.display = "none";
    }

    // Update lock-on search while holding fire (expands radius + camera pullback)
    if (this._locking) {
      this._updateLockOnSearch(deltaTime, camera);
    }

    // Update active missiles
    const camPos = camera ? camera.position : null;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.age += deltaTime;

      // Remove orphaned missiles (pool item recycled)
      if (!m.poolItem) {
        if (m.shadowBB && this.flareSystem) {
          m.shadowBB.age = m.age;
          this.flareSystem._orphanedShadows.push(m.shadowBB);
        }
        this.missiles.splice(i, 1);
        continue;
      }

      // Safety timeout
      if (m.age > 15) {
        this._destroyMissile(i, m.position);
        continue;
      }

      // NaN position guard — destroy corrupted missiles
      if (isNaN(m.position.x)) {
        if (m.poolItem) this._releasePoolItem(m.poolItem);
        this.missiles.splice(i, 1);
        continue;
      }

      // Cache camera distance for visibility checks
      m._camDist = camPos ? camPos.distanceTo(m.position) : 0;

      // Update shadow billboard spritesheet — play once then orphan (no loop)
      if (m.shadowBB && this.flareSystem) {
        const fs = this.flareSystem;
        const rawFrame = Math.floor(m.age * fs._smokeBBFps);
        if (rawFrame >= fs._smokeBBFrames) {
          // Animation finished — orphan so it fades out
          m.shadowBB.age = m.age;
          fs._orphanedShadows.push(m.shadowBB);
          m.shadowBB = null;
        } else {
          const bbFar = m._camDist > 260;
          m.shadowBB.group.visible = !bbFar;
          if (!bbFar) {
            fs._setShadowBillboardFrame(m.shadowBB, rawFrame);
          }
        }
      }

      this._updateMissile(m, deltaTime);
    }

    // Lock-on reticle: only shows what the PLAYER is locking onto (not in-flight missiles)
    if (!this._locking && camera) {
      if (this._missileEquipped) {
        // Passive tracking — show reticle on nearest enemy
        const target = this._findClosestEnemyTank(this.config.searchRadiusMin);
        this._lockedTarget = target;
        this._updateLockOnReticle(camera);
      } else {
        this._lockedTarget = null;
        if (this.lockOnReticle) this.lockOnReticle.style.display = "none";
      }
    }

    // Missile-tracking reticles: one per active in-flight missile
    if (camera) {
      this._updateTrackingReticles(camera);
    }

    // Always update particle ages (prevents stale burst on zoom-in);
    // hide Points meshes when camera beyond 260 from surface
    this._updateAfterburner(deltaTime, camera);
    this._updateSmokeTrail(deltaTime, camera);
    const camSurfDist = camera ? camera.position.length() - this.sphereRadius : 0;
    const particlesVisible = camSurfDist <= 260;
    if (this._abPoints) this._abPoints.visible = particlesVisible;
    if (this._smokePoints) this._smokePoints.visible = particlesVisible;
  }

  _updateLockOnSearch(deltaTime, camera) {
    const now = performance.now() / 1000;
    const holdDuration = now - this._lockStartTime;

    // Expand search radius over time
    const expandRatio = Math.min(holdDuration / this.config.searchExpandTime, 1);
    this._currentSearchRadius = MathUtils.lerp(
      this.config.searchRadiusMin,
      this.config.searchRadiusMax,
      expandRatio
    );

    // Camera pullback (same visual as cannon charge)
    if (this.gameCamera) {
      this.gameCamera.setChargePullback(expandRatio * 0.8);
    }

    // Find target within current radius
    const target = this._findClosestEnemyTank(this._currentSearchRadius);
    this._lockedTarget = target;

    // Detect target switch — trigger flash
    const currentTank = target?.tank || null;
    if (currentTank !== this._lastLockedTank) {
      this._lastLockedTank = currentTank;
      this._lockFlashTime = performance.now();

      // Point turret at locked target
      if (currentTank && this.playerTank) {
        const targetPos = this._getTargetWorldPos(currentTank);
        if (targetPos) {
          this._pointTurretAt(targetPos);
        }
      }
    }

    // Keep turret tracking locked target
    if (currentTank && this.playerTank) {
      const targetPos = this._getTargetWorldPos(currentTank);
      if (targetPos) {
        this._pointTurretAt(targetPos);
      }
    }

    // Update reticle display
    this._updateLockOnReticle(camera);
  }

  _pointTurretAt(targetWorldPos) {
    const tank = this.playerTank;
    if (!tank) return;

    // Save target coordinates BEFORE reusing temp vectors (targetWorldPos may alias _tempVec2)
    const tx = targetWorldPos.x, ty = targetWorldPos.y, tz = targetWorldPos.z;

    const tankPos = tank.group._cachedWorldPos || tank.group.position;
    const normal = this._tempVec.copy(tankPos).normalize();

    // Build stable orientation basis (mirrors Tank._updateTurret logic)
    const east = this._tempVec2;
    if (Math.abs(normal.y) > 0.999) {
      east.set(0, 0, 1).cross(normal).normalize();
    } else {
      east.set(0, 1, 0).cross(normal).normalize();
    }
    const north = this._tempVec3.crossVectors(normal, east).normalize();

    // Forward direction from heading
    const forward = new THREE.Vector3()
      .addScaledVector(north, Math.cos(tank.state.heading))
      .addScaledVector(east, Math.sin(tank.state.heading))
      .normalize();

    const right = new THREE.Vector3().crossVectors(forward, normal).normalize();

    // Build rotation matrix + position (same pattern as Tank._updateTurret)
    const rotMatrix = new THREE.Matrix4().makeBasis(right, normal, forward);
    rotMatrix.setPosition(tankPos);
    const invMatrix = rotMatrix.clone().invert();

    // Direction from tank to target in local space (using saved coordinates)
    const toTarget = new THREE.Vector3(tx - tankPos.x, ty - tankPos.y, tz - tankPos.z);
    toTarget.applyMatrix4(invMatrix);

    // Compute turret target angle (same formula as Tank._updateTurret)
    tank.state.turretTargetAngle =
      Math.atan2(-toTarget.x, toTarget.z) + Math.PI;
  }

  _getSurfaceRadius(worldPos) {
    if (!this.planet?.terrainElevation || !this.planet.hexGroup) return this.sphereRadius;
    this._tempVec3.copy(worldPos);
    this.planet.hexGroup.worldToLocal(this._tempVec3);
    const elevation = this.planet.terrainElevation.getElevationAtPosition(this._tempVec3);
    if (elevation <= 0) return this.sphereRadius;
    return this.sphereRadius + elevation * this.planet.terrainElevation.config.EXTRUSION_HEIGHT;
  }

  // ========================
  // MISSILE TRAJECTORY
  // ========================

  _updateMissile(m, dt) {
    const dt60 = dt * 60;
    const farAway = m._camDist > 260;

    // Skip if missile was forced to a post-launch phase before direction was initialized
    if (m.phase > 0 && !m.direction) {
      m.direction = m.surfaceNormal ? m.surfaceNormal.clone() : null;
      if (!m.direction) return;
    }

    // Hide mesh when camera is far (orbital view) — simulation still runs
    m.poolItem.group.visible = !farAway;

    if (m.phase === 0) {
      // VERTICAL LAUNCH: Rise along surface normal
      m.launchSpeed += 30 * dt; // Accelerate upward
      m.position.addScaledVector(m.surfaceNormal, m.launchSpeed * dt);

      // Check altitude
      const altitude = m.position.length() - this.sphereRadius;
      if (m.age > this.config.launchDuration || altitude > m.cruiseAltitude) {
        m.phase = 1;
        m.cruiseAltitude = altitude;
        m.phase1Age = 0;
        // Start with surface normal direction — steering will smoothly curve toward target
        m.direction = m.surfaceNormal.clone();
      }

      // Sync mesh position and orient nose (+Y) along surface normal (upward)
      m.poolItem.group.position.copy(m.position);
      const upQuat = this._tempQuat;
      upQuat.setFromUnitVectors(this._upVec, m.surfaceNormal);
      m.poolItem.group.quaternion.copy(upQuat);
    } else if (m.phase === 1) {
      // CRUISE / HOMING: Steer toward target at altitude
      m.phase1Age = (m.phase1Age || 0) + dt;
      const ownerFaction = m.faction || m.ownerFaction;
      // Skip forward-hemisphere filter during first 1s (missile is still curving from vertical)
      const useHemisphere = m.phase1Age > 1.0;
      const target = this._findClosestEnemyFromPos(
        m.position, ownerFaction, useHemisphere ? m.direction : null
      );

      if (target) {
        m.targetTank = target.tank;

        // Compute elevated target position (same altitude as missile)
        const targetSurface = target.worldPos;
        const targetNormal = this._tempVec.copy(targetSurface).normalize();
        const targetElevated = this._tempVec2
          .copy(targetNormal)
          .multiplyScalar(this.sphereRadius + m.cruiseAltitude);

        // Desired direction to target
        const desired = this._tempVec3
          .copy(targetElevated)
          .sub(m.position)
          .normalize();

        // Smoothly steer toward target (limited turn rate)
        const maxSteer = this.config.turnRate * dt;
        m.direction.lerp(desired, Math.min(maxSteer, 1.0)).normalize();

        // Check if close enough to dive (distance to SURFACE target)
        const groundDist = m.position.distanceTo(targetSurface);
        if (groundDist < this.config.diveDistance) {
          m.phase = 2;
          m.diveTarget = targetSurface.clone();
        }
      } else if (!m.isLost) {
        // No target in range — enter wobble phase
        m.phase = 3;
        m.isLost = true;
        m.lostAge = 0;
        m.targetTank = null;
      }

      // Move along current direction
      const moveSpeed = this.config.missileSpeed * dt60;
      m.position.addScaledVector(m.direction, moveSpeed);

      // Maintain altitude above actual terrain (not base sphere)
      const surfaceR = this._getSurfaceRadius(m.position);
      const currentNormal = this._tempVec.copy(m.position).normalize();
      const currentAlt = m.position.length() - surfaceR;
      if (currentAlt < m.cruiseAltitude - 0.5) {
        const correctedAlt = MathUtils.lerp(currentAlt, m.cruiseAltitude, Math.min(8 * dt, 1));
        m.position.copy(currentNormal).multiplyScalar(surfaceR + correctedAlt);
      } else if (currentAlt > m.cruiseAltitude + 0.5) {
        const correctedAlt = MathUtils.lerp(currentAlt, m.cruiseAltitude, Math.min(5 * dt, 1));
        m.position.copy(currentNormal).multiplyScalar(surfaceR + correctedAlt);
      }

      // Orient mesh to face travel direction (lookAt + offset for Y-axis mesh)
      const lookTarget = this._tempVec2.copy(m.position).add(m.direction);
      m.poolItem.group.position.copy(m.position);
      m.poolItem.group.lookAt(lookTarget);
      m.poolItem.group.quaternion.multiply(this._meshOrientQuat);

      // Terrain collision check (steep terrain can rise faster than altitude correction)
      const cruiseAlt = m.position.length() - this._getSurfaceRadius(m.position);
      if (cruiseAlt < 1.5) {
        const idx = this.missiles.indexOf(m);
        if (idx >= 0) this._destroyMissile(idx, m.position);
        return;
      }
    } else if (m.phase === 2) {
      // TERMINAL DIVE: Steer downward toward ground target (no forward filter — committed to dive)
      const ownerFaction = m.faction || m.ownerFaction;
      const target = this._findClosestEnemyFromPos(m.position, ownerFaction, null);
      const diveTarget = target ? target.worldPos : m.diveTarget;
      if (!diveTarget) { m.phase = 3; m.isLost = true; m.lostAge = 0; return; }

      const desired = this._tempVec3
        .copy(diveTarget)
        .sub(m.position)
        .normalize();

      const maxSteer = this.config.turnRate * 2 * dt;
      m.direction.lerp(desired, Math.min(maxSteer, 1.0)).normalize();

      const dist = this._tempVec.copy(diveTarget).sub(m.position).length();
      const moveSpeed = this.config.missileSpeed * 1.2 * dt60;
      m.position.addScaledVector(m.direction, Math.min(moveSpeed, dist));

      const lookTarget = this._tempVec2.copy(m.position).add(m.direction);
      m.poolItem.group.position.copy(m.position);
      m.poolItem.group.lookAt(lookTarget);
      m.poolItem.group.quaternion.multiply(this._meshOrientQuat);

      const altAboveTerrain = m.position.length() - this._getSurfaceRadius(m.position);
      if (altAboveTerrain < 1.5 || dist < 1.5) {
        const idx = this.missiles.indexOf(m);
        if (idx >= 0) {
          this._destroyMissile(idx, m.position);
        }
        return;
      }
    } else if (m.phase === 3) {
      // WOBBLE: No target in range — missile wobbles erratically at cruise altitude
      m.lostAge = (m.lostAge || 0) + dt;
      const ownerFaction = m.faction || m.ownerFaction;

      // Scan for nearby targets to re-lock (short range only — prevents infinite re-lock cycles)
      const reLocks = m.reLockCount || 0;
      const target = reLocks < 2
        ? this._findClosestEnemyFromPos(m.position, ownerFaction, null, 30)
        : null;
      if (target) {
        // Target re-acquired — back to cruise (max 2 re-locks)
        m.phase = 1;
        m.phase1Age = 0;
        m.isLost = false;
        m.lostAge = 0;
        m.targetTank = target.tank;
        m.reLockCount = reLocks + 1;
      } else if (m.lostAge >= 5) {
        // Wobble time expired — crash dive
        m.phase = 4;
        const crashNormal = this._tempVec.copy(m.position).normalize();
        m.diveTarget = crashNormal.multiplyScalar(this.sphereRadius).clone();
      }

      // Wobble: perturb direction with increasing intensity
      const wobbleIntensity = Math.min(m.lostAge / 5, 1.0); // 0→1 over 5s
      const wobbleFreq = 3 + wobbleIntensity * 5; // Speed up wobble over time
      const wobbleAmp = 0.3 + wobbleIntensity * 1.2; // Wider arcs over time
      const wobbleX = Math.sin(m.lostAge * wobbleFreq) * wobbleAmp;
      const wobbleY = Math.cos(m.lostAge * wobbleFreq * 1.3) * wobbleAmp * 0.7;

      // Build perpendicular axes to current direction for wobble offset
      const up = this._tempVec.copy(m.position).normalize();
      const right = this._tempVec2.crossVectors(m.direction, up).normalize();
      const localUp = this._tempVec3.crossVectors(right, m.direction).normalize();

      m.direction.addScaledVector(right, wobbleX);
      m.direction.addScaledVector(localUp, wobbleY);
      m.direction.normalize();

      // Slow down over time (engine sputtering)
      const speedFactor = 1.0 - wobbleIntensity * 0.5;
      const moveSpeed = this.config.missileSpeed * speedFactor * dt60;
      m.position.addScaledVector(m.direction, moveSpeed);

      // Maintain altitude above actual terrain (gradually lose altitude as wobble intensifies)
      const altitudeLoss = wobbleIntensity * 2;
      const targetAlt = m.cruiseAltitude - altitudeLoss;
      const surfaceR = this._getSurfaceRadius(m.position);
      const currentNormal = this._tempVec.copy(m.position).normalize();
      const currentAlt = m.position.length() - surfaceR;
      if (Math.abs(currentAlt - targetAlt) > 0.5) {
        const correctedAlt = MathUtils.lerp(currentAlt, targetAlt, Math.min(5 * dt, 1));
        m.position.copy(currentNormal).multiplyScalar(surfaceR + correctedAlt);
      }

      // Orient mesh
      const lookTarget = this._tempVec2.copy(m.position).add(m.direction);
      m.poolItem.group.position.copy(m.position);
      m.poolItem.group.lookAt(lookTarget);
      m.poolItem.group.quaternion.multiply(this._meshOrientQuat);

      // Terrain collision check (wobble can push missile into terrain)
      const wobbleAlt = m.position.length() - this._getSurfaceRadius(m.position);
      if (wobbleAlt < 1.5) {
        const idx = this.missiles.indexOf(m);
        if (idx >= 0) this._destroyMissile(idx, m.position);
        return;
      }
    } else if (m.phase === 4) {
      // CRASH DIVE: Wobble expired — dive to ground, no damage
      const diveTarget = m.diveTarget;
      if (!diveTarget) {
        const idx = this.missiles.indexOf(m);
        if (idx >= 0) this._destroyMissile(idx, m.position);
        return;
      }

      const desired = this._tempVec3
        .copy(diveTarget)
        .sub(m.position)
        .normalize();

      const maxSteer = this.config.turnRate * 2 * dt;
      m.direction.lerp(desired, Math.min(maxSteer, 1.0)).normalize();

      const dist = this._tempVec.copy(diveTarget).sub(m.position).length();
      const moveSpeed = this.config.missileSpeed * 1.2 * dt60;
      m.position.addScaledVector(m.direction, Math.min(moveSpeed, dist));

      // Orient mesh
      const lookTarget = this._tempVec2.copy(m.position).add(m.direction);
      m.poolItem.group.position.copy(m.position);
      m.poolItem.group.lookAt(lookTarget);
      m.poolItem.group.quaternion.multiply(this._meshOrientQuat);

      // Check impact (close to terrain surface)
      const altAboveTerrain = m.position.length() - this._getSurfaceRadius(m.position);
      if (altAboveTerrain < 1.5 || dist < 1.5) {
        const idx = this.missiles.indexOf(m);
        if (idx >= 0) {
          this._destroyMissile(idx, m.position);
        }
        return;
      }
    }

    // Update mesh position
    m.poolItem.group.position.copy(m.position);

    // Skip particle emission when camera is far (orbital view)
    if (farAway) return;

    // Emit particles (phases 0-3, but most visible during 1+)
    if (m.phase >= 0) {
      this._emitAfterburner(m);
      if (m.phase >= 1) {
        this._emitSmoke(m);
      }
    }
  }

  _destroyMissile(index, impactPos) {
    const m = this.missiles[index];

    // Visual effects at impact point
    if (this.cannonSystem) {
      this.cannonSystem._spawnExplosion?.(impactPos, m.faction, 1.2);
      this.cannonSystem._spawnImpactDecal?.(impactPos, 1.0);
    }
    if (this.dustShockwave) {
      this.dustShockwave.emit(impactPos, 1.0);
    }
    if (this.gameCamera) {
      const playerPos = this.playerTank?.group?._cachedWorldPos || this.playerTank?.group?.position;
      if (playerPos) {
        this.gameCamera.triggerShake(impactPos, playerPos, 0.8, 100);
      }
    }

    // Nearby explosion visual effects
    if (this.cannonSystem?.onNearbyExplosion) {
      const playerPos = this.playerTank?.group?._cachedWorldPos;
      if (playerPos) {
        const dist = impactPos.distanceTo(playerPos);
        if (dist < 80) {
          const intensity = (1 - dist / 80) * 1.2;
          this.cannonSystem.onNearbyExplosion(intensity);
        }
      }
    }

    // Orphan shadow billboard to finish its animation
    if (m.shadowBB && this.flareSystem) {
      m.shadowBB.age = m.age;
      this.flareSystem._orphanedShadows.push(m.shadowBB);
    }

    if (m.poolItem) this._releasePoolItem(m.poolItem);
    this.missiles.splice(index, 1);
  }

  // ========================
  // AFTERBURNER PARTICLES
  // ========================

  _createAfterburnerSystem() {
    const max = 300;
    this._ab = {
      maxParticles: max,
      activeCount: 0,
      positions: new Float32Array(max * 3),
      ages: new Float32Array(max),
      lifetimes: new Float32Array(max),
      sizes: new Float32Array(max),
      rotations: new Float32Array(max),
      rotationSpeeds: new Float32Array(max),
      velocities: new Float32Array(max * 3),
    };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._ab.positions, 3));
    geo.setAttribute("aAge", new THREE.BufferAttribute(this._ab.ages, 1));
    geo.setAttribute("aLifetime", new THREE.BufferAttribute(this._ab.lifetimes, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this._ab.sizes, 1));
    geo.setAttribute("aRotation", new THREE.BufferAttribute(this._ab.rotations, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
      },
      vertexShader: `
        uniform vec3 uCameraPos;
        attribute float aAge;
        attribute float aLifetime;
        attribute float aSize;
        attribute float aRotation;
        varying float vAlpha;
        varying float vRotation;
        varying float vLifeRatio;
        void main() {
          float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
          vRotation = aRotation;
          vLifeRatio = lifeRatio;
          float fadeIn = smoothstep(0.0, 0.1, lifeRatio);
          float fadeOut = 1.0 - smoothstep(0.4, 1.0, lifeRatio);
          float distToCamera = distance(position, uCameraPos);
          float distanceFade = 1.0 - smoothstep(100.0, 260.0, distToCamera);
          vAlpha = fadeIn * fadeOut * distanceFade;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (1.0 + lifeRatio * 0.5) * (400.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vRotation;
        varying float vLifeRatio;
        void main() {
          if (vAlpha < 0.001) discard;
          vec2 coord = gl_PointCoord - vec2(0.5);
          float c = cos(vRotation);
          float s = sin(vRotation);
          vec2 rotatedCoord = vec2(
            coord.x * c - coord.y * s,
            coord.x * s + coord.y * c
          );
          if (abs(rotatedCoord.x) > 0.5 || abs(rotatedCoord.y) > 0.5) discard;
          // Warm color gradient: yellow core -> orange -> red
          vec3 coreColor = vec3(1.0, 0.9, 0.3);
          vec3 outerColor = vec3(1.0, 0.3, 0.05);
          vec3 color = mix(coreColor, outerColor, vLifeRatio) * 0.8;
          gl_FragColor = vec4(color, vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._abPoints = new THREE.Points(geo, mat);
    this._abPoints.frustumCulled = false;
    this._abPoints.renderOrder = 15;
    // No bloom layer — keeps flame subtle
    this.scene.add(this._abPoints);
  }

  _emitAfterburner(missile) {
    const ab = this._ab;
    // Emit 2-3 particles per frame from missile tail
    const count = 2 + Math.floor(Math.random() * 2);
    for (let n = 0; n < count; n++) {
      if (ab.activeCount >= ab.maxParticles) break;
      const i = ab.activeCount;

      // Tail position (behind missile body) — use actual travel direction, not getWorldDirection
      // (getWorldDirection returns group -Z which is wrong after _meshOrientQuat multiply)
      const travelDir = missile.direction || missile.surfaceNormal;
      const tailOffset = this._tempVec.copy(travelDir).multiplyScalar(-0.8);
      const pos = this._tempVec2.copy(missile.position).add(tailOffset);

      // Random spread
      pos.x += (Math.random() - 0.5) * 0.3;
      pos.y += (Math.random() - 0.5) * 0.3;
      pos.z += (Math.random() - 0.5) * 0.3;

      ab.positions[i * 3] = pos.x;
      ab.positions[i * 3 + 1] = pos.y;
      ab.positions[i * 3 + 2] = pos.z;

      // Random outward velocity
      ab.velocities[i * 3] = (Math.random() - 0.5) * 2;
      ab.velocities[i * 3 + 1] = (Math.random() - 0.5) * 2;
      ab.velocities[i * 3 + 2] = (Math.random() - 0.5) * 2;

      ab.ages[i] = 0;
      ab.lifetimes[i] = 0.25 + Math.random() * 0.35; // 0.25-0.6s
      ab.sizes[i] = 0.4 + Math.random() * 0.4;
      ab.rotations[i] = Math.random() * Math.PI * 2;
      ab.rotationSpeeds[i] = (Math.random() - 0.5) * 3;

      ab.activeCount++;
    }
  }

  _updateAfterburner(dt, camera) {
    const ab = this._ab;

    for (let i = ab.activeCount - 1; i >= 0; i--) {
      ab.ages[i] += dt;
      if (ab.ages[i] >= ab.lifetimes[i]) {
        // Swap-remove
        const last = ab.activeCount - 1;
        if (i !== last) {
          ab.positions[i * 3] = ab.positions[last * 3];
          ab.positions[i * 3 + 1] = ab.positions[last * 3 + 1];
          ab.positions[i * 3 + 2] = ab.positions[last * 3 + 2];
          ab.velocities[i * 3] = ab.velocities[last * 3];
          ab.velocities[i * 3 + 1] = ab.velocities[last * 3 + 1];
          ab.velocities[i * 3 + 2] = ab.velocities[last * 3 + 2];
          ab.ages[i] = ab.ages[last];
          ab.lifetimes[i] = ab.lifetimes[last];
          ab.sizes[i] = ab.sizes[last];
          ab.rotations[i] = ab.rotations[last];
          ab.rotationSpeeds[i] = ab.rotationSpeeds[last];
        }
        ab.activeCount--;
        continue;
      }

      // Apply velocity with drag
      const drag = Math.pow(0.95, dt * 60);
      ab.positions[i * 3] += ab.velocities[i * 3] * dt;
      ab.positions[i * 3 + 1] += ab.velocities[i * 3 + 1] * dt;
      ab.positions[i * 3 + 2] += ab.velocities[i * 3 + 2] * dt;
      ab.velocities[i * 3] *= drag;
      ab.velocities[i * 3 + 1] *= drag;
      ab.velocities[i * 3 + 2] *= drag;

      // Update rotation
      ab.rotations[i] += ab.rotationSpeeds[i] * dt;
    }

    // Update GPU buffers
    const geo = this._abPoints.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAge.needsUpdate = true;
    geo.attributes.aLifetime.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotation.needsUpdate = true;
    geo.setDrawRange(0, ab.activeCount);

    // Update camera pos uniform
    if (camera) {
      this._abPoints.material.uniforms.uCameraPos.value.copy(camera.position);
    }
  }

  // ========================
  // SMOKE TRAIL PARTICLES
  // ========================

  _createSmokeTrailSystem() {
    const max = 500;
    this._smoke = {
      maxParticles: max,
      activeCount: 0,
      positions: new Float32Array(max * 3),
      ages: new Float32Array(max),
      lifetimes: new Float32Array(max),
      sizes: new Float32Array(max),
      rotations: new Float32Array(max),
      rotationSpeeds: new Float32Array(max),
      velocities: new Float32Array(max * 3),
    };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._smoke.positions, 3));
    geo.setAttribute("aAge", new THREE.BufferAttribute(this._smoke.ages, 1));
    geo.setAttribute("aLifetime", new THREE.BufferAttribute(this._smoke.lifetimes, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this._smoke.sizes, 1));
    geo.setAttribute("aRotation", new THREE.BufferAttribute(this._smoke.rotations, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Vector3(0.7, 0.7, 0.7) },
      },
      vertexShader: `
        uniform vec3 uCameraPos;
        attribute float aAge;
        attribute float aLifetime;
        attribute float aSize;
        attribute float aRotation;
        varying float vAlpha;
        varying float vRotation;
        void main() {
          float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
          vRotation = aRotation;
          float sizeFactor = 1.0 + lifeRatio * 2.0;
          float fadeIn = smoothstep(0.0, 0.05, lifeRatio);
          float fadeOut = 1.0 - smoothstep(0.5, 1.0, lifeRatio);
          float distToCamera = distance(position, uCameraPos);
          float distanceFade = 1.0 - smoothstep(100.0, 260.0, distToCamera);
          vAlpha = fadeIn * fadeOut * 0.25 * distanceFade;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * sizeFactor * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vRotation;
        void main() {
          if (vAlpha < 0.001) discard;
          vec2 coord = gl_PointCoord - vec2(0.5);
          float c = cos(vRotation);
          float s = sin(vRotation);
          vec2 rotatedCoord = vec2(
            coord.x * c - coord.y * s,
            coord.x * s + coord.y * c
          );
          if (abs(rotatedCoord.x) > 0.4 || abs(rotatedCoord.y) > 0.4) discard;
          float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
          float alpha = vAlpha * (1.0 - dist * 1.5);
          gl_FragColor = vec4(uColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this._smokePoints = new THREE.Points(geo, mat);
    this._smokePoints.frustumCulled = false;
    this._smokePoints.renderOrder = 12;
    this.scene.add(this._smokePoints);
  }

  _emitSmoke(missile) {
    const smoke = this._smoke;
    // 1-2 particles per frame
    const count = 1 + Math.floor(Math.random() * 2);
    for (let n = 0; n < count; n++) {
      if (smoke.activeCount >= smoke.maxParticles) break;
      const i = smoke.activeCount;

      // Use actual travel direction (not getWorldDirection — wrong after _meshOrientQuat)
      const travelDir = missile.direction || missile.surfaceNormal;
      const tailOffset = this._tempVec.copy(travelDir).multiplyScalar(-1.0);
      const pos = this._tempVec2.copy(missile.position).add(tailOffset);

      pos.x += (Math.random() - 0.5) * 0.5;
      pos.y += (Math.random() - 0.5) * 0.5;
      pos.z += (Math.random() - 0.5) * 0.5;

      smoke.positions[i * 3] = pos.x;
      smoke.positions[i * 3 + 1] = pos.y;
      smoke.positions[i * 3 + 2] = pos.z;

      smoke.velocities[i * 3] = (Math.random() - 0.5) * 0.5;
      smoke.velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.5;
      smoke.velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.5;

      smoke.ages[i] = 0;
      smoke.lifetimes[i] = 1.0 + Math.random() * 1.5; // 1-2.5s
      smoke.sizes[i] = 1.5 + Math.random() * 1.5;
      smoke.rotations[i] = Math.random() * Math.PI * 2;
      smoke.rotationSpeeds[i] = (Math.random() - 0.5) * 1.5;

      smoke.activeCount++;
    }
  }

  _updateSmokeTrail(dt, camera) {
    const smoke = this._smoke;

    for (let i = smoke.activeCount - 1; i >= 0; i--) {
      smoke.ages[i] += dt;
      if (smoke.ages[i] >= smoke.lifetimes[i]) {
        const last = smoke.activeCount - 1;
        if (i !== last) {
          smoke.positions[i * 3] = smoke.positions[last * 3];
          smoke.positions[i * 3 + 1] = smoke.positions[last * 3 + 1];
          smoke.positions[i * 3 + 2] = smoke.positions[last * 3 + 2];
          smoke.velocities[i * 3] = smoke.velocities[last * 3];
          smoke.velocities[i * 3 + 1] = smoke.velocities[last * 3 + 1];
          smoke.velocities[i * 3 + 2] = smoke.velocities[last * 3 + 2];
          smoke.ages[i] = smoke.ages[last];
          smoke.lifetimes[i] = smoke.lifetimes[last];
          smoke.sizes[i] = smoke.sizes[last];
          smoke.rotations[i] = smoke.rotations[last];
          smoke.rotationSpeeds[i] = smoke.rotationSpeeds[last];
        }
        smoke.activeCount--;
        continue;
      }

      const drag = Math.pow(0.985, dt * 60);
      smoke.positions[i * 3] += smoke.velocities[i * 3] * dt;
      smoke.positions[i * 3 + 1] += smoke.velocities[i * 3 + 1] * dt;
      smoke.positions[i * 3 + 2] += smoke.velocities[i * 3 + 2] * dt;
      smoke.velocities[i * 3] *= drag;
      smoke.velocities[i * 3 + 1] *= drag;
      smoke.velocities[i * 3 + 2] *= drag;

      smoke.rotations[i] += smoke.rotationSpeeds[i] * dt;
    }

    const geo = this._smokePoints.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAge.needsUpdate = true;
    geo.attributes.aLifetime.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotation.needsUpdate = true;
    geo.setDrawRange(0, smoke.activeCount);

    if (camera) {
      this._smokePoints.material.uniforms.uCameraPos.value.copy(camera.position);
    }
  }

  // ========================
  // CLEANUP
  // ========================

  dispose() {
    // Remove all active missiles
    for (const m of this.missiles) {
      this._releasePoolItem(m.poolItem);
    }
    this.missiles.length = 0;

    // Remove particle systems
    if (this._abPoints) this.scene.remove(this._abPoints);
    if (this._smokePoints) this.scene.remove(this._smokePoints);

    // Remove reticles
    if (this.lockOnReticle?.parentNode) {
      this.lockOnReticle.parentNode.removeChild(this.lockOnReticle);
    }
    for (const el of this._trackingReticles) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    for (const el of this._trackingReticlePool) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    this._trackingReticles.length = 0;
    this._trackingReticlePool.length = 0;

    // Dispose pool items
    for (const item of this._pool) {
      this.scene.remove(item.group);
    }
  }
}
