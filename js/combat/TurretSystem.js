/**
 * AdLands - Turret System
 * Client-side rendering and synchronization for stationary tactical turrets.
 */

class TurretSystem {
  constructor(scene, sphereRadius, hexGroup) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.hexGroup = hexGroup || scene;
    this.turrets = new Map();
    this.dustShockwave = null;
    this.cannonSystem = null;
    this.surfaceVisible = false;
    this._hpReferenceWidth = 128;
    this._hpReferenceHp = 100;
    this._hpBarSurfaceOffset = 4.2;
    this._hpBarScreenYOffset = 28;
    this._turretTurnRate = 8;

    this._entity = {
      theta: 0,
      phi: Math.PI / 2,
      heading: 0,
      group: null,
      bodyGroup: null,
      speed: 0,
      wigglePhase: 0,
      currentRollAngle: 0,
      hp: 50,
      maxHp: 50,
      isDead: false,
      lean: null,
    };

    this._muzzleLocal = new THREE.Vector3(0, 0.85, -1.65);
    this._muzzleWorld = new THREE.Vector3();
    this._directionLocal = new THREE.Vector3(0, 0, -1);
    this._directionWorld = new THREE.Vector3();
    this._surfaceNormal = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._barWorld = new THREE.Vector3();
    this._barProjected = new THREE.Vector3();
    this._cameraToTarget = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
  }

  setDustShockwave(dustShockwave) {
    this.dustShockwave = dustShockwave;
  }

  setCannonSystem(cannonSystem) {
    this.cannonSystem = cannonSystem;
  }

  syncFromState(arr) {
    const seen = new Set();
    const factions = ["rust", "cobalt", "viridian"];
    const stride = 10;

    for (let i = 0; i + stride - 1 < arr.length; i += stride) {
      const id = arr[i];
      const faction = factions[arr[i + 1]] || "rust";
      const data = {
        id,
        faction,
        ownerId: arr[i + 2] || "",
        theta: arr[i + 3],
        phi: arr[i + 4],
        heading: arr[i + 5],
        turretAngle: arr[i + 6],
        hp: arr[i + 7],
        maxHp: arr[i + 8],
        level: arr[i + 9] || 1,
      };
      seen.add(id);
      this.upsertTurret(data, { emitDeployEffect: false });
    }

    for (const [id, turret] of this.turrets) {
      if (!seen.has(id)) {
        this._removeTurret(id, false);
      }
    }
  }

  upsertTurret(data, options = {}) {
    if (!data || !data.id) return null;
    let turret = this.turrets.get(data.id);
    if (!turret) {
      turret = this._createTurret(data);
      this.turrets.set(data.id, turret);
      if (options.emitDeployEffect) {
        this._emitDeployEffect(turret);
      }
    }

    turret.ownerId = data.ownerId || turret.ownerId || "";
    turret.faction = data.faction || turret.faction || "rust";
    turret.theta = Number.isFinite(data.theta) ? data.theta : turret.theta;
    turret.phi = Number.isFinite(data.phi) ? data.phi : turret.phi;
    turret.heading = Number.isFinite(data.heading) ? data.heading : turret.heading;
    if (Number.isFinite(data.turretAngle)) {
      turret.targetTurretAngle = this._normalizeAngle(data.turretAngle);
    }
    turret.hp = Number.isFinite(data.hp) ? data.hp : turret.hp;
    turret.maxHp = Number.isFinite(data.maxHp) ? data.maxHp : turret.maxHp;
    turret.level = data.level || turret.level || 1;
    turret.isDead = turret.hp <= 0;
    this._applyFactionColors(turret);
    this._updateHpBarMeter(turret);
    this._updateTurretTransform(turret);
    return turret;
  }

  handleDeployed(data) {
    const turret = this.upsertTurret(data, { emitDeployEffect: false });
    if (turret) this._emitDeployEffect(turret);
    return turret;
  }

  handleFired(data) {
    const turret = this.turrets.get(data?.id);
    if (turret) {
      if (Number.isFinite(data.turretAngle)) {
        turret.turretAngle = this._normalizeAngle(data.turretAngle);
        turret.targetTurretAngle = turret.turretAngle;
      }
      this._updateTurretTransform(turret);
      this._triggerRecoil(turret);
      this._emitFiringDustwave(turret);
      this._spawnProjectileFromTurret(turret, data);
      return;
    }

    if (this.shouldRenderEffects() && this.cannonSystem && data) {
      this._emitFiringDustwaveFromData(data);
      this._spawnProjectileFromData(data, data.faction || "rust");
    }
  }

  handleHit(data) {
    const turret = this.turrets.get(data?.id);
    if (!turret) return;
    if (Number.isFinite(data.hp)) turret.hp = data.hp;
    turret.isDead = turret.hp <= 0;
    this._updateHpBarMeter(turret);
    this._flashTurret(turret);
  }

  handleDestroyed(data) {
    this._removeTurret(data?.id, true);
  }

  update(deltaTime, frustum, camera, surfaceVisible = true) {
    this.surfaceVisible = !!surfaceVisible;
    for (const [, turret] of this.turrets) {
      if (!turret.group) continue;
      this._updateTurretAim(turret, deltaTime);
      this._updateTurretTransform(turret);
      this._updateRecoil(turret, deltaTime);

      if (!this.surfaceVisible) {
        turret.group.visible = false;
        this._hideHpBar(turret);
        continue;
      }

      let visible = true;
      if (frustum && camera) {
        turret.group.updateWorldMatrix(true, false);
        turret.group.getWorldPosition(this._target);
        visible = frustum.containsPoint(this._target);
      }
      turret.group.visible = visible;
      this._updateHpBarPosition(turret, camera, visible);
    }
  }

  shouldRenderEffects() {
    return !!this.surfaceVisible;
  }

  getTurret(id) {
    return this.turrets.get(id) || null;
  }

  getActiveTurrets() {
    return Array.from(this.turrets.values()).filter((t) => !t.isDead);
  }

  _createTurret(data) {
    const group = new THREE.Group();
    group.visible = this.surfaceVisible;
    const bodyGroup = new THREE.Group();
    const turretGroup = new THREE.Group();
    turretGroup.position.y = 0.55;

    const materials = {
      primary: new THREE.MeshStandardMaterial({ color: 0x2f6fed, roughness: 0.58, metalness: 0.25, flatShading: true }),
      secondary: new THREE.MeshStandardMaterial({ color: 0x15335f, roughness: 0.62, metalness: 0.2, flatShading: true }),
      barrel: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.5, metalness: 0.65, flatShading: true }),
      dark: new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.8, metalness: 0.2, flatShading: true }),
    };

    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.35, 0.35, 8), materials.secondary);
    base.position.y = 0.18;
    base.castShadow = true;
    base.receiveShadow = true;
    bodyGroup.add(base);

    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.82, 0.65, 8), materials.primary);
    pedestal.position.y = 0.58;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    bodyGroup.add(pedestal);

    const head = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.78, 1.25), materials.primary);
    head.position.y = 0.25;
    head.castShadow = true;
    head.receiveShadow = true;
    turretGroup.add(head);

    const face = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.44, 0.28), materials.secondary);
    face.position.set(0, 0.22, -0.72);
    face.castShadow = true;
    face.receiveShadow = true;
    turretGroup.add(face);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.14, 1.55, 8), materials.barrel);
    barrel.rotation.x = -Math.PI / 2;
    barrel.position.set(0, 0.22, -1.35);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    turretGroup.add(barrel);

    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.22, 8), materials.dark);
    muzzle.rotation.x = -Math.PI / 2;
    muzzle.position.set(0, 0.22, -2.16);
    muzzle.castShadow = true;
    turretGroup.add(muzzle);

    bodyGroup.add(turretGroup);

    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.8, 2.2),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitbox.position.y = 0.75;
    bodyGroup.add(hitbox);

    group.add(bodyGroup);
    this.hexGroup.add(group);

    const initialTurretAngle = Number.isFinite(data.turretAngle)
      ? this._normalizeAngle(data.turretAngle)
      : Math.PI;

    const turret = {
      id: data.id,
      ownerId: data.ownerId || "",
      faction: data.faction || "rust",
      theta: data.theta || 0,
      phi: data.phi || Math.PI / 2,
      heading: data.heading || 0,
      turretAngle: initialTurretAngle,
      targetTurretAngle: initialTurretAngle,
      hp: data.hp || 50,
      maxHp: data.maxHp || 50,
      level: data.level || 1,
      isDead: false,
      group,
      bodyGroup,
      turretGroup,
      barrelMesh: barrel,
      muzzleMesh: muzzle,
      hitbox,
      materials,
      _recoil: 0,
      _recoilTarget: 0,
      _baseBarrelZ: barrel.position.z,
      _baseMuzzleZ: muzzle.position.z,
      hpBarEl: null,
      hpFillEl: null,
      _hpBarWidth: -1,
      _hpPercent: -1,
    };
    hitbox.userData.tankRef = turret;
    hitbox.userData.type = "turret";

    this._ensureHpBar(turret);
    this._applyFactionColors(turret);
    this._updateHpBarMeter(turret);
    this._updateTurretTransform(turret);
    return turret;
  }

  _applyFactionColors(turret) {
    if (!turret?.materials || typeof FACTION_COLORS === "undefined") return;
    const factionData = FACTION_COLORS[turret.faction];
    const palette = factionData?.vehicle;
    if (!palette) return;
    turret.materials.primary.color.setHex(palette.primary);
    turret.materials.secondary.color.setHex(palette.secondary || palette.tracks || palette.primary);
  }

  _updateTurretTransform(turret) {
    this._entity.theta = turret.theta;
    this._entity.phi = turret.phi;
    this._entity.heading = turret.heading;
    this._entity.group = turret.group;
    this._entity.bodyGroup = turret.bodyGroup;
    this._entity.hp = turret.hp;
    this._entity.maxHp = turret.maxHp;
    this._entity.isDead = turret.isDead;
    Tank.updateEntityVisual(this._entity, this.sphereRadius);
    turret.turretGroup.quaternion.setFromAxisAngle(this._yAxis, turret.turretAngle);
  }

  _updateTurretAim(turret, dt) {
    if (!turret || !Number.isFinite(turret.targetTurretAngle)) return;
    const current = Number.isFinite(turret.turretAngle) ? turret.turretAngle : turret.targetTurretAngle;
    const delta = this._angleDelta(turret.targetTurretAngle, current);
    const maxStep = Math.max(0, dt || 0) * this._turretTurnRate;
    if (maxStep <= 0 || Math.abs(delta) <= maxStep) {
      turret.turretAngle = turret.targetTurretAngle;
      return;
    }
    turret.turretAngle = this._normalizeAngle(current + Math.sign(delta) * maxStep);
  }

  _angleDelta(target, current) {
    let delta = target - current;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
  }

  _normalizeAngle(angle) {
    let value = angle;
    while (value < 0) value += Math.PI * 2;
    while (value >= Math.PI * 2) value -= Math.PI * 2;
    return value;
  }

  _spawnProjectileFromTurret(turret, data) {
    if (!this.shouldRenderEffects() || !this.cannonSystem || !turret?.group) return;

    turret.group.updateWorldMatrix(true, false);

    this._muzzleLocal.set(0, 0.55 + 0.22, -2.16);
    this._muzzleLocal.applyAxisAngle(this._yAxis, turret.turretAngle);
    this._muzzleWorld.copy(this._muzzleLocal).applyMatrix4(turret.group.matrixWorld);

    this._surfaceNormal.copy(this._muzzleWorld).normalize();
    this._muzzleWorld.addScaledVector(this._surfaceNormal, 2.0);

    this._directionLocal.set(0, 0, -1);
    this._directionLocal.applyAxisAngle(this._yAxis, turret.turretAngle);
    this._directionWorld.copy(this._directionLocal).transformDirection(turret.group.matrixWorld);
    const dot = this._directionWorld.dot(this._surfaceNormal);
    this._directionWorld.addScaledVector(this._surfaceNormal, -dot).normalize();

    this.cannonSystem.spawnProjectileFromServer(
      {
        wx: this._muzzleWorld.x,
        wy: this._muzzleWorld.y,
        wz: this._muzzleWorld.z,
        dvx: this._directionWorld.x,
        dvy: this._directionWorld.y,
        dvz: this._directionWorld.z,
        power: 0,
        sizeScale: data?.sizeScale || 0.5,
        maxDistance: data?.maxDistance,
        projectileId: data?.projectileId,
        sourceType: data?.sourceType || "turret",
        surfaceGraceTime: 0.25,
      },
      turret.faction
    );
  }

  _spawnProjectileFromData(data, faction) {
    if (!this.shouldRenderEffects() || !this.cannonSystem || !data) return;
    const hasServerVector = ["wx", "wy", "wz", "dvx", "dvy", "dvz"].every((key) =>
      Number.isFinite(data?.[key])
    );
    if (!hasServerVector) return;

    this._muzzleWorld.set(data.wx, data.wy, data.wz);
    this._directionWorld.set(data.dvx, data.dvy, data.dvz);
    if (this.hexGroup?.matrixWorld) {
      this.hexGroup.updateWorldMatrix?.(true, false);
      this._muzzleWorld.applyMatrix4(this.hexGroup.matrixWorld);
      this._directionWorld.transformDirection(this.hexGroup.matrixWorld);
    }

    this.cannonSystem.spawnProjectileFromServer(
      {
        ...data,
        wx: this._muzzleWorld.x,
        wy: this._muzzleWorld.y,
        wz: this._muzzleWorld.z,
        dvx: this._directionWorld.x,
        dvy: this._directionWorld.y,
        dvz: this._directionWorld.z,
        power: 0,
        sizeScale: data.sizeScale || 0.5,
        surfaceGraceTime: data.surfaceGraceTime || 0.25,
      },
      faction
    );
  }

  _triggerRecoil(turret) {
    turret._recoilTarget = 1;
  }

  _updateRecoil(turret, dt) {
    if (!turret.barrelMesh || !turret.muzzleMesh) return;
    if (turret._recoilTarget > 0) {
      turret._recoil += (1 - turret._recoil) * Math.min(1, dt * 22);
      if (turret._recoil > 0.85) turret._recoilTarget = 0;
    } else {
      turret._recoil += (0 - turret._recoil) * Math.min(1, dt * 10);
    }
    const offset = turret._recoil * 0.72;
    turret.barrelMesh.position.z = turret._baseBarrelZ + offset;
    turret.muzzleMesh.position.z = turret._baseMuzzleZ + offset;
  }

  _emitDeployEffect(turret) {
    if (!this.shouldRenderEffects() || !this.dustShockwave || !turret?.group) return;
    turret.group.updateWorldMatrix(true, false);
    turret.group.getWorldPosition(this._target);
    this._emitScaledDustwave(this._target, 0.5);
  }

  _emitFiringDustwave(turret) {
    if (!this.shouldRenderEffects() || !turret?.group) return;
    turret.group.updateWorldMatrix(true, false);
    turret.group.getWorldPosition(this._target);
    this._emitScaledDustwave(this._target, 0.5, true);
  }

  _emitFiringDustwaveFromData(data) {
    if (!this.shouldRenderEffects() || !data) return;
    if (!["wx", "wy", "wz"].every((key) => Number.isFinite(data?.[key]))) return;
    this._target.set(data.wx, data.wy, data.wz);
    if (this.hexGroup?.matrixWorld) {
      this.hexGroup.updateWorldMatrix?.(true, false);
      this._target.applyMatrix4(this.hexGroup.matrixWorld);
    }
    this._emitScaledDustwave(this._target, 0.5, true);
  }

  _emitScaledDustwave(position, scale, spriteOnly = false) {
    if (!this.dustShockwave || !position) return;
    if (spriteOnly && typeof this.dustShockwave.emitDustwaveSpriteOnly === "function") {
      this.dustShockwave.emitDustwaveSpriteOnly(position.clone(), scale);
      return;
    }
    const sprites = this.dustShockwave.dustwaveSprites;
    const beforeSpriteCount = sprites ? sprites.length : 0;
    if (spriteOnly && typeof this.dustShockwave._emitDustwaveSprite === "function") {
      this.dustShockwave._emitDustwaveSprite(position.clone(), scale);
    } else {
      this.dustShockwave.emit(position.clone(), scale);
    }
    if (sprites && sprites.length > beforeSpriteCount) {
      const last = sprites[sprites.length - 1];
      const scaledSize = last.baseSize * scale;
      last.sprite.scale.set(scaledSize, scaledSize, 1);
      last.baseSize = scaledSize;
      if (last.shadowSprite) {
        last.shadowSprite.scale.multiplyScalar(scale);
      }
    }
  }

  _emitImpactEffect(turret, scale) {
    if (!this.shouldRenderEffects() || !turret?.group) return;
    turret.group.updateWorldMatrix(true, false);
    turret.group.getWorldPosition(this._target);
    this.cannonSystem?._spawnExplosion?.(this._target, turret.faction, scale);
    this.dustShockwave?.emit(this._target, scale * 0.7);
  }

  _flashTurret(turret) {
    if (!this.shouldRenderEffects() || !turret?.group) return;
    const meshes = [];
    turret.group.traverse((child) => {
      if (child.isMesh && child.material?.color && child !== turret.hitbox) {
        if (child.userData._hitFlashOrigColor === undefined) {
          child.userData._hitFlashOrigColor = child.material.color.getHex();
        }
        meshes.push(child);
      }
    });
    for (const mesh of meshes) {
      mesh.material.color.setHex(0xffffff);
      clearTimeout(mesh.userData._hitFlashTimer);
      mesh.userData._hitFlashTimer = setTimeout(() => {
        if (mesh.material?.color && mesh.userData._hitFlashOrigColor !== undefined) {
          mesh.material.color.setHex(mesh.userData._hitFlashOrigColor);
          delete mesh.userData._hitFlashOrigColor;
          delete mesh.userData._hitFlashTimer;
        }
      }, 120);
    }
  }

  _ensureHpBar(turret) {
    if (!turret || turret.hpBarEl || typeof document === "undefined") return;
    const bar = document.createElement("div");
    bar.className = "turret-hp-bar tag-healthbar";
    const fill = document.createElement("div");
    fill.className = "turret-hp-fill tag-healthbar-fill hp-high";
    bar.appendChild(fill);
    document.body.appendChild(bar);
    turret.hpBarEl = bar;
    turret.hpFillEl = fill;
  }

  _updateHpBarMeter(turret) {
    if (!turret) return;
    this._ensureHpBar(turret);
    const maxHpValue = Number(turret.maxHp);
    const maxHp = Number.isFinite(maxHpValue) && maxHpValue > 0 ? maxHpValue : 50;
    const hpValue = Number(turret.hp);
    const hp = Number.isFinite(hpValue) ? Math.max(0, Math.min(maxHp, hpValue)) : 0;
    const hpPercent = Math.round((hp / maxHp) * 1000) / 10;
    const barWidth = Math.max(
      16,
      Math.round((maxHp / this._hpReferenceHp) * this._hpReferenceWidth)
    );

    if (turret.hpBarEl && turret._hpBarWidth !== barWidth) {
      turret.hpBarEl.style.setProperty("--turret-hp-width", `${barWidth}px`);
      turret._hpBarWidth = barWidth;
    }

    if (turret.hpFillEl && turret._hpPercent !== hpPercent) {
      turret.hpFillEl.style.width = `${hpPercent}%`;
      turret.hpFillEl.classList.remove("hp-high", "hp-medium", "hp-low");
      if (hpPercent > 50) {
        turret.hpFillEl.classList.add("hp-high");
      } else if (hpPercent > 25) {
        turret.hpFillEl.classList.add("hp-medium");
      } else {
        turret.hpFillEl.classList.add("hp-low");
      }
      turret._hpPercent = hpPercent;
    }
  }

  _updateHpBarPosition(turret, camera, visible) {
    this._ensureHpBar(turret);
    if (!turret?.hpBarEl) return;
    if (!visible || !camera || !this.surfaceVisible || turret.isDead || !turret.group) {
      this._hideHpBar(turret);
      return;
    }

    turret.group.updateWorldMatrix(true, false);
    turret.group.getWorldPosition(this._barWorld);
    this._surfaceNormal.copy(this._barWorld).normalize();
    this._cameraToTarget.copy(this._barWorld).sub(camera.position).normalize();
    if (this._surfaceNormal.dot(this._cameraToTarget) > 0.2) {
      this._hideHpBar(turret);
      return;
    }

    this._barWorld.addScaledVector(this._surfaceNormal, this._hpBarSurfaceOffset);
    this._barProjected.copy(this._barWorld).project(camera);
    if (
      this._barProjected.z < -1 ||
      this._barProjected.z > 1 ||
      typeof window === "undefined"
    ) {
      this._hideHpBar(turret);
      return;
    }

    const x = Math.round((this._barProjected.x * 0.5 + 0.5) * window.innerWidth);
    const y =
      Math.round((this._barProjected.y * -0.5 + 0.5) * window.innerHeight) -
      this._hpBarScreenYOffset;
    if (x < -40 || x > window.innerWidth + 40 || y < -40 || y > window.innerHeight + 40) {
      this._hideHpBar(turret);
      return;
    }

    turret.hpBarEl.style.display = "block";
    turret.hpBarEl.style.left = `${x}px`;
    turret.hpBarEl.style.top = `${y}px`;
  }

  _hideHpBar(turret) {
    if (turret?.hpBarEl) {
      turret.hpBarEl.style.display = "none";
    }
  }

  _removeHpBar(turret) {
    if (turret?.hpBarEl) {
      turret.hpBarEl.remove();
      turret.hpBarEl = null;
      turret.hpFillEl = null;
    }
  }

  _removeTurret(id, withExplosion) {
    if (!id) return;
    const turret = this.turrets.get(id);
    if (!turret) return;
    if (withExplosion) this._emitImpactEffect(turret, 0.8);
    this._removeHpBar(turret);
    if (turret.group?.parent) turret.group.parent.remove(turret.group);
    turret.group?.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
    this.turrets.delete(id);
  }
}
