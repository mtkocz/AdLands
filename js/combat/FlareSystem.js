/**
 * AdLands - Flare Countermeasure System
 * Faction-colored decoy flares that lure homing missiles.
 * Visual: glowing tip with fire + smoke trail (same style as missile afterburner).
 *
 * Dependencies: THREE.js, FACTION_COLORS (factionColors.js)
 */

class FlareSystem {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.R = sphereRadius || 480;

    this.flares = [];
    this.lastFireTime = 0;
    this.cooldown = 5;

    this._tempVec = new THREE.Vector3();
    this._tempVec2 = new THREE.Vector3();

    this._createFireSystem();
    this._createSmokeSystem();
    this._createFlareMeshPool();
  }

  // ========================
  // FIRE PARTICLES (afterburner style — yellow core → orange → red)
  // ========================

  _createFireSystem() {
    const max = 200;
    this._fire = {
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
    geo.setAttribute("position", new THREE.BufferAttribute(this._fire.positions, 3));
    geo.setAttribute("aAge", new THREE.BufferAttribute(this._fire.ages, 1));
    geo.setAttribute("aLifetime", new THREE.BufferAttribute(this._fire.lifetimes, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this._fire.sizes, 1));
    geo.setAttribute("aRotation", new THREE.BufferAttribute(this._fire.rotations, 1));

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
          if (abs(rotatedCoord.x) > 0.4 || abs(rotatedCoord.y) > 0.4) discard;
          // Warm color gradient: yellow core -> orange -> red (same as missile)
          vec3 coreColor = vec3(1.0, 0.9, 0.3);
          vec3 outerColor = vec3(1.0, 0.3, 0.05);
          vec3 color = mix(coreColor, outerColor, vLifeRatio) * 0.8;
          float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
          float alpha = vAlpha * (1.0 - dist * 1.5);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._firePoints = new THREE.Points(geo, mat);
    this._firePoints.frustumCulled = false;
    this._firePoints.renderOrder = 15;
    this.scene.add(this._firePoints);
  }

  // ========================
  // SMOKE PARTICLES (grey, expanding, same as missile smoke)
  // ========================

  _createSmokeSystem() {
    const max = 150;
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

  // ---- Flare core mesh pool ----

  _createFlareMeshPool() {
    this._meshPool = [];
    this._flareGeo = new THREE.SphereGeometry(0.4, 4, 4);
    this._flareMats = {};
    for (const faction of ["rust", "cobalt", "viridian"]) {
      this._flareMats[faction] = new THREE.MeshBasicMaterial({
        color: FACTION_COLORS[faction].vehicle.primary,
      });
    }
  }

  _acquireMesh(faction) {
    let item = this._meshPool.find(m => !m.inUse);
    if (!item) {
      const mesh = new THREE.Mesh(this._flareGeo, this._flareMats.rust);
      const light = new THREE.PointLight(0xffaa33, 1.5, 20);
      const group = new THREE.Group();
      group.add(mesh);
      group.add(light);
      group.position.set(0, -9999, 0);
      this.scene.add(group);
      item = { group, mesh, light, inUse: false };
      this._meshPool.push(item);
    }
    item.inUse = true;
    item.mesh.material = this._flareMats[faction] || this._flareMats.rust;
    item.light.color.setHex(0xffaa33);
    item.group.visible = true;
    return item;
  }

  _releaseMesh(item) {
    item.inUse = false;
    item.group.visible = false;
    item.group.position.set(0, -9999, 0);
  }

  // ---- Fire a flare (local player) ----

  fire(tank, faction) {
    const now = performance.now() / 1000;
    if (now - this.lastFireTime < this.cooldown) return false;
    if (this.flares.some(f => f.isLocal)) return false;

    this.lastFireTime = now;

    const surfacePos = tank.group.getWorldPosition(this._tempVec);
    const normal = this._tempVec2.copy(surfacePos).normalize();

    const flare = this._createFlareVisual(surfacePos, normal, faction, true);
    this.flares.push(flare);

    if (window._mp && window._mp.socket) {
      window._mp.socket.emit("fire", { type: "flare" });
    }

    return true;
  }

  // ---- Spawn a remote flare ----

  spawnRemoteFlare(data) {
    const R = this.R + 2;
    const sp = Math.sin(data.phi), cp = Math.cos(data.phi);
    const st = Math.sin(data.theta), ct = Math.cos(data.theta);
    const pos = new THREE.Vector3(R * sp * st, R * cp, R * sp * ct);
    const normal = pos.clone().normalize();

    const flare = this._createFlareVisual(pos, normal, data.ownerFaction, false);
    flare.serverId = data.id;
    flare.ownerId = data.ownerId;
    this.flares.push(flare);
  }

  _createFlareVisual(surfacePos, normal, faction, isLocal) {
    const meshItem = this._acquireMesh(faction);
    meshItem.group.position.copy(surfacePos);

    return {
      isLocal,
      faction,
      surfacePos: surfacePos.clone(),
      normal: normal.clone(),
      altitude: 0,
      targetAltitude: 8,
      launchDuration: 0.4,
      age: 0,
      maxAge: 3,
      meshItem,
      serverId: null,
      ownerId: null,
    };
  }

  // ---- Update all flares ----

  update(dt, camera) {
    const camPos = camera ? camera.position : null;
    let anyVisible = false;

    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.age += dt;

      if (f.age >= f.maxAge) {
        this._releaseMesh(f.meshItem);
        this.flares.splice(i, 1);
        continue;
      }

      // Rise: fast launch then hover
      if (f.age < f.launchDuration) {
        const t = f.age / f.launchDuration;
        f.altitude = f.targetAltitude * (1 - (1 - t) * (1 - t));
      } else {
        f.altitude = f.targetAltitude;
      }

      // Position = surfacePos + normal * altitude
      const pos = this._tempVec.copy(f.normal).multiplyScalar(f.altitude).add(f.surfacePos);
      f.meshItem.group.position.copy(pos);

      const farAway = camPos ? camPos.distanceTo(pos) > 260 : false;
      f.meshItem.group.visible = !farAway;

      if (f.meshItem.light) {
        f.meshItem.light.intensity = 1.2 + Math.random() * 0.6;
      }

      if (!farAway) {
        anyVisible = true;
        this._emitFire(f);
        this._emitSmoke(f);
      }
    }

    // Update both particle systems
    const hasFireParticles = anyVisible || this._fire.activeCount > 0;
    const hasSmokeParticles = anyVisible || this._smoke.activeCount > 0;

    if (hasFireParticles) {
      this._firePoints.visible = true;
      this._updateParticles(this._fire, this._firePoints, dt, camera);
    } else {
      this._firePoints.visible = false;
      this._firePoints.geometry.setDrawRange(0, 0);
    }

    if (hasSmokeParticles) {
      this._smokePoints.visible = true;
      this._updateParticles(this._smoke, this._smokePoints, dt, camera);
    } else {
      this._smokePoints.visible = false;
      this._smokePoints.geometry.setDrawRange(0, 0);
    }
  }

  // ---- Fire emission (identical to MissileSystem._emitAfterburner) ----

  _emitFire(flare) {
    const ab = this._fire;
    const count = 2 + Math.floor(Math.random() * 2);
    for (let n = 0; n < count; n++) {
      if (ab.activeCount >= ab.maxParticles) break;
      const i = ab.activeCount;

      // Flare "travels" along normal (upward), so tail is behind = -normal
      const travelDir = flare.normal;
      const tailOffset = this._tempVec.copy(travelDir).multiplyScalar(-0.8);
      const pos = this._tempVec2.copy(flare.meshItem.group.position).add(tailOffset);

      pos.x += (Math.random() - 0.5) * 0.3;
      pos.y += (Math.random() - 0.5) * 0.3;
      pos.z += (Math.random() - 0.5) * 0.3;

      ab.positions[i * 3] = pos.x;
      ab.positions[i * 3 + 1] = pos.y;
      ab.positions[i * 3 + 2] = pos.z;

      ab.velocities[i * 3] = (Math.random() - 0.5) * 2;
      ab.velocities[i * 3 + 1] = (Math.random() - 0.5) * 2;
      ab.velocities[i * 3 + 2] = (Math.random() - 0.5) * 2;

      ab.ages[i] = 0;
      ab.lifetimes[i] = 0.25 + Math.random() * 0.35;
      ab.sizes[i] = 0.4 + Math.random() * 0.4;
      ab.rotations[i] = Math.random() * Math.PI * 2;
      ab.rotationSpeeds[i] = (Math.random() - 0.5) * 3;

      ab.activeCount++;
    }
  }

  // ---- Smoke emission (identical to MissileSystem._emitSmoke) ----

  _emitSmoke(flare) {
    const smoke = this._smoke;
    const count = 1 + Math.floor(Math.random() * 2);
    for (let n = 0; n < count; n++) {
      if (smoke.activeCount >= smoke.maxParticles) break;
      const i = smoke.activeCount;

      const travelDir = flare.normal;
      const tailOffset = this._tempVec.copy(travelDir).multiplyScalar(-1.0);
      const pos = this._tempVec2.copy(flare.meshItem.group.position).add(tailOffset);

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
      smoke.lifetimes[i] = 1.0 + Math.random() * 1.5;
      smoke.sizes[i] = 1.5 + Math.random() * 1.5;
      smoke.rotations[i] = Math.random() * Math.PI * 2;
      smoke.rotationSpeeds[i] = (Math.random() - 0.5) * 1.5;

      smoke.activeCount++;
    }
  }

  // ---- Shared particle update (works for both fire and smoke) ----

  _updateParticles(ps, points, dt, camera) {
    for (let i = ps.activeCount - 1; i >= 0; i--) {
      ps.ages[i] += dt;
      if (ps.ages[i] >= ps.lifetimes[i]) {
        const last = ps.activeCount - 1;
        if (i !== last) {
          ps.positions[i * 3] = ps.positions[last * 3];
          ps.positions[i * 3 + 1] = ps.positions[last * 3 + 1];
          ps.positions[i * 3 + 2] = ps.positions[last * 3 + 2];
          ps.velocities[i * 3] = ps.velocities[last * 3];
          ps.velocities[i * 3 + 1] = ps.velocities[last * 3 + 1];
          ps.velocities[i * 3 + 2] = ps.velocities[last * 3 + 2];
          ps.ages[i] = ps.ages[last];
          ps.lifetimes[i] = ps.lifetimes[last];
          ps.sizes[i] = ps.sizes[last];
          ps.rotations[i] = ps.rotations[last];
          ps.rotationSpeeds[i] = ps.rotationSpeeds[last];
        }
        ps.activeCount--;
        continue;
      }

      const drag = Math.pow(0.95, dt * 60);
      ps.positions[i * 3] += ps.velocities[i * 3] * dt;
      ps.positions[i * 3 + 1] += ps.velocities[i * 3 + 1] * dt;
      ps.positions[i * 3 + 2] += ps.velocities[i * 3 + 2] * dt;
      ps.velocities[i * 3] *= drag;
      ps.velocities[i * 3 + 1] *= drag;
      ps.velocities[i * 3 + 2] *= drag;

      ps.rotations[i] += ps.rotationSpeeds[i] * dt;
    }

    const geo = points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAge.needsUpdate = true;
    geo.attributes.aLifetime.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotation.needsUpdate = true;
    geo.setDrawRange(0, ps.activeCount);

    if (camera) {
      points.material.uniforms.uCameraPos.value.copy(camera.position);
    }
  }

  // ---- Public API ----

  getActiveFlares() {
    return this.flares.map(f => ({
      position: f.meshItem.group.position,
      faction: f.faction,
      ownerId: f.ownerId,
    }));
  }

  removeFlareById(flareId) {
    const idx = this.flares.findIndex(f => f.serverId === flareId);
    if (idx !== -1) {
      this._releaseMesh(this.flares[idx].meshItem);
      this.flares.splice(idx, 1);
    }
  }

  removeLocalFlare() {
    const idx = this.flares.findIndex(f => f.isLocal);
    if (idx !== -1) {
      this._releaseMesh(this.flares[idx].meshItem);
      this.flares.splice(idx, 1);
    }
  }

  dispose() {
    for (const f of this.flares) this._releaseMesh(f.meshItem);
    this.flares.length = 0;

    if (this._firePoints) {
      this.scene.remove(this._firePoints);
      this._firePoints.geometry.dispose();
      this._firePoints.material.dispose();
    }
    if (this._smokePoints) {
      this.scene.remove(this._smokePoints);
      this._smokePoints.geometry.dispose();
      this._smokePoints.material.dispose();
    }
    for (const item of this._meshPool) this.scene.remove(item.group);
    this._meshPool.length = 0;
  }
}
