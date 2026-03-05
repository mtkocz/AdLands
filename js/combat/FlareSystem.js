/**
 * AdLands - Flare Countermeasure System
 * Faction-colored decoy flares that lure homing missiles.
 *
 * Activation: Spacebar tap (when flares are active defense weapon)
 * Visual: Faction-colored square particles shooting upward, sparks falling
 * Lifetime: 3 seconds, 5-second cooldown, one active flare per player
 *
 * Dependencies: THREE.js, FACTION_COLORS (factionColors.js)
 */

class FlareSystem {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.R = sphereRadius || 480;

    /** Active flare visuals */
    this.flares = [];

    /** Cooldown tracking (local player only) */
    this.lastFireTime = 0;
    this.cooldown = 5; // seconds

    /** Temp vectors */
    this._tempVec = new THREE.Vector3();
    this._tempVec2 = new THREE.Vector3();

    this._createParticleSystem();
    this._createFlareMeshPool();
  }

  // ---- Particle system (shared across all flares) ----

  _createParticleSystem() {
    const max = 200;
    this._ps = {
      maxParticles: max,
      activeCount: 0,
      positions: new Float32Array(max * 3),
      ages: new Float32Array(max),
      lifetimes: new Float32Array(max),
      sizes: new Float32Array(max),
      rotations: new Float32Array(max),
      rotationSpeeds: new Float32Array(max),
      velocities: new Float32Array(max * 3),
      colors: new Float32Array(max * 3), // Per-particle RGB
    };

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this._ps.positions, 3));
    geo.setAttribute("aAge", new THREE.BufferAttribute(this._ps.ages, 1));
    geo.setAttribute("aLifetime", new THREE.BufferAttribute(this._ps.lifetimes, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this._ps.sizes, 1));
    geo.setAttribute("aRotation", new THREE.BufferAttribute(this._ps.rotations, 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this._ps.colors, 3));

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
        attribute vec3 aColor;
        varying float vAlpha;
        varying float vRotation;
        varying vec3 vColor;
        void main() {
          float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
          vRotation = aRotation;
          vColor = aColor;
          float fadeIn = smoothstep(0.0, 0.1, lifeRatio);
          float fadeOut = 1.0 - smoothstep(0.5, 1.0, lifeRatio);
          float distToCamera = distance(position, uCameraPos);
          float distanceFade = 1.0 - smoothstep(100.0, 260.0, distToCamera);
          vAlpha = fadeIn * fadeOut * distanceFade * 0.9;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (1.0 + lifeRatio * 0.3) * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vRotation;
        varying vec3 vColor;
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
          float alpha = vAlpha * (1.0 - dist * 1.2);
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this._points = new THREE.Points(geo, mat);
    this._points.frustumCulled = false;
    this._points.renderOrder = 16;
    this.scene.add(this._points);
  }

  // ---- Flare core mesh pool ----

  _createFlareMeshPool() {
    this._meshPool = [];
    this._flareGeo = new THREE.SphereGeometry(0.3, 4, 4);
    this._flareMats = {};
    for (const faction of ["rust", "cobalt", "viridian"]) {
      const col = FACTION_COLORS[faction].threeLight;
      this._flareMats[faction] = new THREE.MeshBasicMaterial({
        color: col,
      });
    }
  }

  _acquireMesh(faction) {
    // Reuse from pool or create new
    let item = this._meshPool.find(m => !m.inUse);
    if (!item) {
      const mesh = new THREE.Mesh(this._flareGeo, this._flareMats.rust);
      const light = new THREE.PointLight(0xffffff, 0.8, 12);
      const group = new THREE.Group();
      group.add(mesh);
      group.add(light);
      group.position.set(0, -9999, 0);
      this.scene.add(group);
      item = { group, mesh, light, inUse: false };
      this._meshPool.push(item);
    }
    item.inUse = true;
    const mat = this._flareMats[faction] || this._flareMats.rust;
    item.mesh.material = mat;
    item.light.color.copy(mat.color);
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

    // Only 1 active local flare
    if (this.flares.some(f => f.isLocal)) return false;

    this.lastFireTime = now;

    // Get tank surface position + normal
    const surfacePos = this._tempVec.copy(tank.group.position);
    const normal = this._tempVec2.copy(surfacePos).normalize();

    const flare = this._createFlareVisual(surfacePos, normal, faction, true);
    this.flares.push(flare);

    // Emit to server
    if (window._mp && window._mp.socket) {
      window._mp.socket.emit("fire", { type: "flare" });
    }

    return true;
  }

  // ---- Spawn a remote flare ----

  spawnRemoteFlare(data) {
    // Compute surface position from theta/phi
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
      targetAltitude: 8, // Cruise altitude (same as missiles)
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

      // Expired
      if (f.age >= f.maxAge) {
        this._releaseMesh(f.meshItem);
        this.flares.splice(i, 1);
        continue;
      }

      // Rise phase: 0 to launchDuration
      if (f.age < f.launchDuration) {
        const t = f.age / f.launchDuration;
        // Smooth ease-out rise
        f.altitude = f.targetAltitude * (1 - (1 - t) * (1 - t));
      } else {
        f.altitude = f.targetAltitude;
      }

      // Position = surfacePos + normal * altitude
      const pos = this._tempVec.copy(f.normal).multiplyScalar(f.altitude).add(f.surfacePos);
      f.meshItem.group.position.copy(pos);

      // Hide in orbital view (camera > 260 units from flare)
      const farAway = camPos ? camPos.distanceTo(pos) > 260 : false;
      f.meshItem.group.visible = !farAway;

      // Flicker the light intensity
      if (f.meshItem.light) {
        f.meshItem.light.intensity = 0.6 + Math.random() * 0.4;
      }

      // Emit particles (skip in orbital view)
      if (!farAway) {
        anyVisible = true;
        this._emitParticles(f, dt);
      }
    }

    // Update existing particles
    if (anyVisible || this._ps.activeCount > 0) {
      this._points.visible = true;
      this._updateParticles(dt, camera);
    } else {
      this._points.visible = false;
      this._points.geometry.setDrawRange(0, 0);
    }
  }

  // ---- Particle emission (sparks falling from flare) ----

  _emitParticles(flare, dt) {
    const ps = this._ps;
    const factionColor = FACTION_COLORS[flare.faction]?.threeLight || FACTION_COLORS.rust.threeLight;

    // 2-3 sparks per frame
    const count = 2 + Math.floor(Math.random() * 2);
    for (let n = 0; n < count; n++) {
      if (ps.activeCount >= ps.maxParticles) break;
      const idx = ps.activeCount;

      // Emit from flare position with slight random spread
      const pos = flare.meshItem.group.position;
      ps.positions[idx * 3] = pos.x + (Math.random() - 0.5) * 0.4;
      ps.positions[idx * 3 + 1] = pos.y + (Math.random() - 0.5) * 0.4;
      ps.positions[idx * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.4;

      // Downward drift along -normal (sparks falling) + random spread
      const n_x = flare.normal.x, n_y = flare.normal.y, n_z = flare.normal.z;
      ps.velocities[idx * 3] = -n_x * 3 + (Math.random() - 0.5) * 2;
      ps.velocities[idx * 3 + 1] = -n_y * 3 + (Math.random() - 0.5) * 2;
      ps.velocities[idx * 3 + 2] = -n_z * 3 + (Math.random() - 0.5) * 2;

      ps.ages[idx] = 0;
      ps.lifetimes[idx] = 0.5 + Math.random() * 0.5; // 0.5-1.0s
      ps.sizes[idx] = 0.3 + Math.random() * 0.3; // 0.3-0.6
      ps.rotations[idx] = Math.random() * Math.PI * 2;
      ps.rotationSpeeds[idx] = (Math.random() - 0.5) * 4;

      // Faction color with slight brightness variation
      const bright = 0.7 + Math.random() * 0.3;
      ps.colors[idx * 3] = factionColor.r * bright;
      ps.colors[idx * 3 + 1] = factionColor.g * bright;
      ps.colors[idx * 3 + 2] = factionColor.b * bright;

      ps.activeCount++;
    }
  }

  // ---- Particle update ----

  _updateParticles(dt, camera) {
    const ps = this._ps;

    for (let i = ps.activeCount - 1; i >= 0; i--) {
      ps.ages[i] += dt;
      if (ps.ages[i] >= ps.lifetimes[i]) {
        // Swap-remove
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
          ps.colors[i * 3] = ps.colors[last * 3];
          ps.colors[i * 3 + 1] = ps.colors[last * 3 + 1];
          ps.colors[i * 3 + 2] = ps.colors[last * 3 + 2];
        }
        ps.activeCount--;
        continue;
      }

      // Apply velocity with drag
      const drag = Math.pow(0.92, dt * 60);
      ps.positions[i * 3] += ps.velocities[i * 3] * dt;
      ps.positions[i * 3 + 1] += ps.velocities[i * 3 + 1] * dt;
      ps.positions[i * 3 + 2] += ps.velocities[i * 3 + 2] * dt;
      ps.velocities[i * 3] *= drag;
      ps.velocities[i * 3 + 1] *= drag;
      ps.velocities[i * 3 + 2] *= drag;

      // Update rotation
      ps.rotations[i] += ps.rotationSpeeds[i] * dt;
    }

    // Update GPU buffers
    const geo = this._points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAge.needsUpdate = true;
    geo.attributes.aLifetime.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotation.needsUpdate = true;
    geo.attributes.aColor.needsUpdate = true;
    geo.setDrawRange(0, ps.activeCount);

    // Update camera pos uniform
    if (camera) {
      this._points.material.uniforms.uCameraPos.value.copy(camera.position);
    }
  }

  // ---- Public API for missile targeting ----

  getActiveFlares() {
    return this.flares.map(f => ({
      position: f.meshItem.group.position,
      faction: f.faction,
      ownerId: f.ownerId,
    }));
  }

  // ---- Remove flare by server ID (on flare-hit event) ----

  removeFlareById(flareId) {
    const idx = this.flares.findIndex(f => f.serverId === flareId);
    if (idx !== -1) {
      this._releaseMesh(this.flares[idx].meshItem);
      this.flares.splice(idx, 1);
    }
  }

  // ---- Remove local flare (when server confirms hit) ----

  removeLocalFlare() {
    const idx = this.flares.findIndex(f => f.isLocal);
    if (idx !== -1) {
      this._releaseMesh(this.flares[idx].meshItem);
      this.flares.splice(idx, 1);
    }
  }

  // ---- Cleanup ----

  dispose() {
    for (const f of this.flares) {
      this._releaseMesh(f.meshItem);
    }
    this.flares.length = 0;

    if (this._points) {
      this.scene.remove(this._points);
      this._points.geometry.dispose();
      this._points.material.dispose();
    }

    for (const item of this._meshPool) {
      this.scene.remove(item.group);
    }
    this._meshPool.length = 0;
  }
}
