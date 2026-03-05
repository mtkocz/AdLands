/**
 * AdLands - Flare Countermeasure System
 * Faction-colored decoy flares that lure homing missiles.
 * Visual style: fighter jet chaff/flare — bright white-hot core with
 * intense spark trail streaming downward.
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
    const max = 400; // More particles for dense spark trail
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
      colors: new Float32Array(max * 3),
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
        varying float vLifeRatio;
        void main() {
          float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
          vRotation = aRotation;
          vLifeRatio = lifeRatio;
          // Hot white core fades to faction color as spark cools
          vColor = mix(vec3(1.0, 0.95, 0.8), aColor, lifeRatio * 0.7);
          float fadeIn = smoothstep(0.0, 0.05, lifeRatio);
          float fadeOut = 1.0 - smoothstep(0.6, 1.0, lifeRatio);
          float distToCamera = distance(position, uCameraPos);
          float distanceFade = 1.0 - smoothstep(100.0, 260.0, distToCamera);
          vAlpha = fadeIn * fadeOut * distanceFade;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          // Shrink as they age (hot spark cooling off)
          float sizeMul = 1.0 - lifeRatio * 0.5;
          gl_PointSize = aSize * sizeMul * (400.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vRotation;
        varying vec3 vColor;
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
          float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
          // Bright core, sharp edge
          float core = 1.0 - smoothstep(0.0, 0.35, dist);
          float alpha = vAlpha * (0.5 + core * 0.5);
          // HDR boost for hot sparks
          vec3 color = vColor * (1.0 + core * 0.5);
          gl_FragColor = vec4(color, alpha);
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
    // Small bright core — the spark trail is the real visual
    this._flareGeo = new THREE.SphereGeometry(0.4, 4, 4);
    this._flareMats = {};
    for (const faction of ["rust", "cobalt", "viridian"]) {
      // White-hot core with faction tint
      const col = FACTION_COLORS[faction].threeLight.clone();
      col.lerp(new THREE.Color(1, 1, 1), 0.6); // Push toward white
      this._flareMats[faction] = new THREE.MeshBasicMaterial({ color: col });
    }
  }

  _acquireMesh(faction) {
    let item = this._meshPool.find(m => !m.inUse);
    if (!item) {
      const mesh = new THREE.Mesh(this._flareGeo, this._flareMats.rust);
      const light = new THREE.PointLight(0xffffff, 1.5, 25);
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
    item.light.color.set(0xffffff);
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

    // Get tank world position + normal
    const surfacePos = tank.group.getWorldPosition(this._tempVec);
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

    // Compute two tangent vectors for spread during rise
    const tangent1 = new THREE.Vector3();
    const tangent2 = new THREE.Vector3();
    const up = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    tangent1.crossVectors(normal, up).normalize();
    tangent2.crossVectors(normal, tangent1).normalize();

    return {
      isLocal,
      faction,
      surfacePos: surfacePos.clone(),
      normal: normal.clone(),
      tangent1,
      tangent2,
      altitude: 0,
      targetAltitude: 10,
      launchDuration: 0.6,
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

      // Rise phase: fast launch then slow drift
      if (f.age < f.launchDuration) {
        const t = f.age / f.launchDuration;
        // Quick launch: ease-out
        f.altitude = f.targetAltitude * (1 - (1 - t) * (1 - t));
      } else {
        // Slow upward drift after launch
        f.altitude = f.targetAltitude + (f.age - f.launchDuration) * 1.5;
      }

      // Position = surfacePos + normal * altitude
      const pos = this._tempVec.copy(f.normal).multiplyScalar(f.altitude).add(f.surfacePos);
      f.meshItem.group.position.copy(pos);

      // Hide in orbital view
      const farAway = camPos ? camPos.distanceTo(pos) > 260 : false;
      f.meshItem.group.visible = !farAway;

      // Flicker the light (rapid, like burning magnesium)
      if (f.meshItem.light) {
        const flicker = 0.8 + Math.random() * 0.4 + Math.sin(f.age * 40) * 0.2;
        f.meshItem.light.intensity = flicker * 1.5;
      }

      // Emit spark trail
      if (!farAway) {
        anyVisible = true;
        this._emitSparks(f, dt);
      }
    }

    // Update particles
    if (anyVisible || this._ps.activeCount > 0) {
      this._points.visible = true;
      this._updateParticles(dt, camera);
    } else {
      this._points.visible = false;
      this._points.geometry.setDrawRange(0, 0);
    }
  }

  // ---- Spark trail emission ----

  _emitSparks(flare, dt) {
    const ps = this._ps;
    const fc = FACTION_COLORS[flare.faction]?.threeLight || FACTION_COLORS.rust.threeLight;
    const flarePos = flare.meshItem.group.position;
    const n = flare.normal;

    // Dense spark shower: 4-6 sparks per frame
    const count = 4 + Math.floor(Math.random() * 3);
    for (let k = 0; k < count; k++) {
      if (ps.activeCount >= ps.maxParticles) break;
      const idx = ps.activeCount;

      // Emit from flare core with spread
      ps.positions[idx * 3] = flarePos.x + (Math.random() - 0.5) * 0.3;
      ps.positions[idx * 3 + 1] = flarePos.y + (Math.random() - 0.5) * 0.3;
      ps.positions[idx * 3 + 2] = flarePos.z + (Math.random() - 0.5) * 0.3;

      // Sparks fall downward (-normal) with lateral spread (like shower of sparks)
      const fallSpeed = 4 + Math.random() * 6;
      const spread = 2 + Math.random() * 3;
      const spreadAngle = Math.random() * Math.PI * 2;
      const sx = Math.cos(spreadAngle) * spread;
      const sy = Math.sin(spreadAngle) * spread;

      ps.velocities[idx * 3] = -n.x * fallSpeed + flare.tangent1.x * sx + flare.tangent2.x * sy;
      ps.velocities[idx * 3 + 1] = -n.y * fallSpeed + flare.tangent1.y * sx + flare.tangent2.y * sy;
      ps.velocities[idx * 3 + 2] = -n.z * fallSpeed + flare.tangent1.z * sx + flare.tangent2.z * sy;

      ps.ages[idx] = 0;
      ps.lifetimes[idx] = 0.3 + Math.random() * 0.5; // Short-lived hot sparks
      ps.sizes[idx] = 0.4 + Math.random() * 0.5;
      ps.rotations[idx] = Math.random() * Math.PI * 2;
      ps.rotationSpeeds[idx] = (Math.random() - 0.5) * 6;

      // White-hot to faction color
      const hot = 0.3 + Math.random() * 0.7; // How white vs faction-colored
      ps.colors[idx * 3] = fc.r + (1.0 - fc.r) * hot;
      ps.colors[idx * 3 + 1] = fc.g + (1.0 - fc.g) * hot;
      ps.colors[idx * 3 + 2] = fc.b + (1.0 - fc.b) * hot;

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

      // Apply velocity with drag (sparks slow as they cool)
      const drag = Math.pow(0.90, dt * 60);
      ps.positions[i * 3] += ps.velocities[i * 3] * dt;
      ps.positions[i * 3 + 1] += ps.velocities[i * 3 + 1] * dt;
      ps.positions[i * 3 + 2] += ps.velocities[i * 3 + 2] * dt;
      ps.velocities[i * 3] *= drag;
      ps.velocities[i * 3 + 1] *= drag;
      ps.velocities[i * 3 + 2] *= drag;

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
