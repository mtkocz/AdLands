/**
 * AdLands - Tread Dust Particles
 * Dust kicked up from tank treads when moving
 *
 * - Light gray square particles
 * - Spawn from tread positions (left and right tracks)
 * - Rotate as they rise and fade
 * - Two separate particle pools: player (maxPlayerParticles) and others (maxParticles)
 */

// Preallocated spheres for frustum culling (avoid per-frame GC)
const _dustPlayerCullSphere = new THREE.Sphere();
const _dustOtherCullSphere = new THREE.Sphere();
const _dustCameraPos = new THREE.Vector3();

class TreadDust {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;

    // ========================
    // CONFIGURATION - Adjust these to change dust appearance
    // ========================
    this.config = {
      // --- PARTICLE POOLS (SEPARATE) ---
      maxParticles: 500, // Max particles for all OTHER tanks (not player)
      maxPlayerParticles: 400, // Max particles for player tank ONLY (separate pool)

      // --- EMISSION RATE ---
      // Controls how often dust spawns. Higher values = more dust clouds
      speedThreshold: 0.00001, // Min tank speed to start emitting (lower = dust at slower speeds)
      speedMultiplier: 2000, // Emission rate scaling (higher = more particles at speed)
      turnEmitChance: 0.2, // Bonus emission chance when turning in place
      maxEmitChance: 16, // Cap on emission probability per frame

      // --- PARTICLE LOOK ---
      // Visual appearance of each dust particle
      color: { r: 0.8, g: 0.8, b: 0.8 }, // RGB 0-1 (20% darker dust)
      sizeMin: 1, // Smallest particle size in world units
      sizeMax: 2.0, // Largest particle size in world units
      opacity: 0.15, // Peak opacity (0 = invisible, 1 = solid)
      growthFactor: 2.5, // How much particles grow as they age (0 = no growth)

      // --- PARTICLE LIFETIME ---
      // How long particles exist before fading away
      lifetimeMin: 0.5, // Shortest lifetime in seconds
      lifetimeMax: 1.5, // Longest lifetime in seconds

      // --- PARTICLE MOVEMENT ---
      // Controls how dust moves after spawning
      velocityMin: 1.0, // Min upward/outward speed (higher = faster rise)
      velocityMax: 2.0, // Max upward/outward speed
      lateralKick: 0.5, // Sideways velocity - dust kicked outward from treads
      randomSpread: 0.5, // Random velocity variation (higher = more chaotic)
      drag: 0.985, // Slowdown per frame (1 = no drag, 0.9 = heavy drag)
      spawnOffset: 0.0, // Height above surface to spawn (0 = ground level)

      // --- PARTICLE SPIN ---
      // Rotation of square particles as they float
      rotationSpeedMin: -1.5, // Slowest spin (negative = counter-clockwise)
      rotationSpeedMax: 1.5, // Fastest spin (positive = clockwise)

      // --- SPAWN AREA ---
      // Where particles appear relative to tank treads
      trackSpreadZ: 5.0, // Spread along track length (front to back)
      trackSpreadX: 0.5, // Spread perpendicular to tracks (side to side)
    };

    // Track offsets in tank local space (matching treadTracks.js)
    this.trackOffsets = {
      left: new THREE.Vector3(-1.3, 0.0, 0),
      right: new THREE.Vector3(1.3, 0.0, 0),
    };

    // Tracked tanks (player and bots)
    this.trackedTanks = new Map(); // tankId -> { group, state }

    this._createDustSystems();
  }

  // ========================
  // PUBLIC API
  // ========================

  /**
   * Register a tank to emit dust
   * @param {string} tankId - Unique identifier
   * @param {THREE.Group} group - Tank's group
   * @param {Object} state - Tank state with { speed, keys }
   */
  registerTank(tankId, group, state) {
    this.trackedTanks.set(tankId, { group, state });
  }

  /**
   * Update tank reference (for bots that may change)
   */
  updateTank(tankId, group, state) {
    this.trackedTanks.set(tankId, { group, state });
  }

  /**
   * Remove a tank from dust emission
   */
  unregisterTank(tankId) {
    this.trackedTanks.delete(tankId);
  }

  /**
   * Set lighting configuration for dust color tinting
   * @param {Object} lightConfig - Light colors/directions from environment.getLightingConfig()
   */
  setLightingConfig(lightConfig) {
    const sunColor = lightConfig.sun.color;
    const fillColor = lightConfig.fill.color;
    const ambientColor = lightConfig.ambient.color;

    // Update both particle systems
    [this.playerDustSystem, this.otherDustSystem].forEach((system) => {
      const uniforms = system.material.uniforms;
      uniforms.uSunColor.value.set(sunColor.r, sunColor.g, sunColor.b);
      uniforms.uSunDirection.value.copy(lightConfig.sun.direction);
      uniforms.uFillColor.value.set(fillColor.r, fillColor.g, fillColor.b);
      uniforms.uFillDirection.value.copy(lightConfig.fill.direction);
      uniforms.uAmbientColor.value.set(
        ambientColor.r,
        ambientColor.g,
        ambientColor.b,
      );
      uniforms.uAmbientIntensity.value = lightConfig.ambient.intensity;
    });
  }

  /**
   * Update dust system (call each frame)
   * @param {number} deltaTime - Time since last frame
   * @param {THREE.Camera} camera - Camera for distance-based fading (optional)
   * @param {boolean} isOrbitalView - If true, disable dust entirely for performance
   */
  update(deltaTime, camera = null, isOrbitalView = false, frustum = null) {
    const dt = deltaTime || 1 / 60;

    // Completely disable dust in orbital view for performance
    if (isOrbitalView) {
      this.playerDustSystem.visible = false;
      this.otherDustSystem.visible = false;
      return;
    }

    // Frustum culling for dust systems (with 10 unit margin for smooth visibility)
    if (frustum) {
      // Compute bounding spheres only if invalid (performance optimization)
      if (!this.playerDust.boundingSphereValid) {
        this.playerDustSystem.geometry.computeBoundingSphere();
        this.playerDust.boundingSphereValid = true;
      }
      if (!this.otherDust.boundingSphereValid) {
        this.otherDustSystem.geometry.computeBoundingSphere();
        this.otherDust.boundingSphereValid = true;
      }

      // Guard against null bounding spheres - but allow visible if we have particles
      if (
        !this.playerDustSystem.geometry.boundingSphere ||
        !this.otherDustSystem.geometry.boundingSphere
      ) {
        // If we have active particles, force visibility and continue
        this.playerDustSystem.visible = this.playerDust.activeCount > 0;
        this.otherDustSystem.visible = this.otherDust.activeCount > 0;

        // Continue execution instead of early return
      } else {
        // Normal frustum culling when bounding spheres exist (use preallocated spheres)
        _dustPlayerCullSphere.copy(
          this.playerDustSystem.geometry.boundingSphere,
        );
        _dustOtherCullSphere.copy(this.otherDustSystem.geometry.boundingSphere);

        _dustPlayerCullSphere.applyMatrix4(this.playerDustSystem.matrixWorld);
        _dustOtherCullSphere.applyMatrix4(this.otherDustSystem.matrixWorld);

        _dustPlayerCullSphere.radius += 10;
        _dustOtherCullSphere.radius += 10;

        this.playerDustSystem.visible = frustum.intersectsSphere(
          _dustPlayerCullSphere,
        );
        this.otherDustSystem.visible =
          frustum.intersectsSphere(_dustOtherCullSphere);
      }
    } else {
      this.playerDustSystem.visible = true;
      this.otherDustSystem.visible = true;
    }

    // Update camera position uniform for distance-based fading
    if (camera) {
      camera.getWorldPosition(_dustCameraPos);
      this.playerDustSystem.material.uniforms.uCameraPos.value.copy(
        _dustCameraPos,
      );
      this.otherDustSystem.material.uniforms.uCameraPos.value.copy(
        _dustCameraPos,
      );
    }

    // Get camera world position for distance checks (reuse vector to avoid GC)
    const cameraWorldPos = camera
      ? camera.getWorldPosition(
          this._tempCameraPos || (this._tempCameraPos = new THREE.Vector3()),
        )
      : null;
    const EMIT_DISTANCE_MAX = 150; // Don't emit dust for tanks beyond this distance

    // Emit dust for each tracked tank
    for (const [tankId, tankData] of this.trackedTanks) {
      const { group, state } = tankData;

      // Skip dust emission for culled (invisible) tanks to save performance
      // (off-screen tanks don't need dust particles)
      if (group.visible === false) continue;

      // Skip dead/destroyed tanks
      if (state.isDead || state.isDestroyed) continue;

      // Skip distant tanks (no point emitting dust that will be invisible)
      if (cameraWorldPos) {
        const tankWorldPos = group.getWorldPosition(
          this._tempTankPos || (this._tempTankPos = new THREE.Vector3()),
        );
        if (tankWorldPos.distanceTo(cameraWorldPos) > EMIT_DISTANCE_MAX)
          continue;
      }

      const speed = Math.abs(state.speed);
      const isTurning = state.keys && (state.keys.a || state.keys.d);

      // Only emit when moving or turning
      const cfg = this.config;
      if (speed > cfg.speedThreshold || isTurning) {
        const emitChance = Math.min(
          speed * cfg.speedMultiplier + (isTurning ? cfg.turnEmitChance : 0),
          cfg.maxEmitChance,
        );

        if (Math.random() < emitChance) {
          this._emitDust(tankId, group, "left");
        }
        if (Math.random() < emitChance) {
          this._emitDust(tankId, group, "right");
        }
      }
    }

    // Update both particle systems
    this._updateDust(this.playerDust, this.playerDustSystem, dt);
    this._updateDust(this.otherDust, this.otherDustSystem, dt);
  }

  // ========================
  // DUST SYSTEM
  // ========================

  _createDustSystems() {
    const cfg = this.config;

    // Create player dust pool (separate from others)
    this.playerDust = this._createDustPool(cfg.maxPlayerParticles);
    this.playerDustSystem = this._createDustPoints(this.playerDust, cfg);

    // Create other tanks dust pool (separate from player)
    this.otherDust = this._createDustPool(cfg.maxParticles);
    this.otherDustSystem = this._createDustPoints(this.otherDust, cfg);

    this.scene.add(this.playerDustSystem);
    this.scene.add(this.otherDustSystem);
  }

  _createDustPool(maxParticles) {
    return {
      maxParticles: maxParticles,
      activeCount: 0,
      positions: new Float32Array(maxParticles * 3),
      velocities: new Float32Array(maxParticles * 3),
      ages: new Float32Array(maxParticles),
      lifetimes: new Float32Array(maxParticles),
      sizes: new Float32Array(maxParticles),
      rotations: new Float32Array(maxParticles),
      rotationSpeeds: new Float32Array(maxParticles),

      // Dirty tracking for buffer optimization
      dirtyParticles: new Set(),
      framesSinceUpdate: 0,
      boundingSphereValid: true,
    };
  }

  _createDustPoints(dustPool, cfg) {
    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(dustPool.positions, 3),
    );
    geometry.setAttribute("aAge", new THREE.BufferAttribute(dustPool.ages, 1));
    geometry.setAttribute(
      "aLifetime",
      new THREE.BufferAttribute(dustPool.lifetimes, 1),
    );
    geometry.setAttribute(
      "aSize",
      new THREE.BufferAttribute(dustPool.sizes, 1),
    );
    geometry.setAttribute(
      "aRotation",
      new THREE.BufferAttribute(dustPool.rotations, 1),
    );

    // Shader material for dust - light gray rotating squares with distance fading
    // Supports subtle light tinting based on sun/fill light directions
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: cfg.opacity },
        uGrowth: { value: cfg.growthFactor },
        uColor: {
          value: new THREE.Vector3(cfg.color.r, cfg.color.g, cfg.color.b),
        },
        uCameraPos: { value: new THREE.Vector3() },
        uFadeStart: { value: 100.0 }, // Start fading at this distance
        uFadeEnd: { value: 260.0 }, // Fully invisible at this distance
        // Lighting uniforms for subtle tinting
        uSunColor: { value: new THREE.Vector3(1.0, 0.85, 0.72) }, // 0xffd9b7
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uFillColor: { value: new THREE.Vector3(0.42, 0.56, 0.6) }, // 0x6B8E99
        uFillDirection: { value: new THREE.Vector3(-1, 0, 0) },
        uAmbientColor: { value: new THREE.Vector3(0.2, 0.4, 0.67) }, // 0x3366aa
        uAmbientIntensity: { value: 0.4 },
      },
      vertexShader: `
                uniform float uOpacity;
                uniform float uGrowth;
                uniform vec3 uCameraPos;
                uniform float uFadeStart;
                uniform float uFadeEnd;

                attribute float aAge;
                attribute float aLifetime;
                attribute float aSize;
                attribute float aRotation;

                varying float vAlpha;
                varying float vRotation;
                varying vec3 vWorldPosition;

                void main() {
                    float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
                    vRotation = aRotation;

                    // Pass world position for lighting calculation
                    vWorldPosition = position;

                    // Dust grows slightly as it rises
                    float sizeFactor = 1.0 + lifeRatio * uGrowth;

                    // Fade in quickly, stay visible longer, then fade out
                    float fadeIn = smoothstep(0.0, 0.05, lifeRatio);
                    float fadeOut = 1.0 - smoothstep(0.6, 1.0, lifeRatio);

                    // Distance-based fade (particles fade as camera moves away)
                    float distToCamera = distance(position, uCameraPos);
                    float distanceFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, distToCamera);

                    vAlpha = fadeIn * fadeOut * uOpacity * distanceFade;

                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = aSize * sizeFactor * (300.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
      fragmentShader: `
                uniform vec3 uColor;
                uniform vec3 uSunColor;
                uniform vec3 uSunDirection;
                uniform vec3 uFillColor;
                uniform vec3 uFillDirection;
                uniform vec3 uAmbientColor;
                uniform float uAmbientIntensity;

                varying float vAlpha;
                varying float vRotation;
                varying vec3 vWorldPosition;

                void main() {
                    // Early discard for invisible particles
                    if (vAlpha < 0.001) discard;

                    // Rotate UV coordinates
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float c = cos(vRotation);
                    float s = sin(vRotation);
                    vec2 rotatedCoord = vec2(
                        coord.x * c - coord.y * s,
                        coord.x * s + coord.y * c
                    );

                    // Square particles (PS1 style)
                    if (abs(rotatedCoord.x) > 0.4 || abs(rotatedCoord.y) > 0.4) discard;

                    // Terminator-aware coloring: sun-tinted on day side, darker blue-tinted on night side
                    vec3 surfaceNormal = normalize(vWorldPosition);
                    float sunFacing = dot(surfaceNormal, uSunDirection);
                    float dayFactor = smoothstep(-0.2, 0.3, sunFacing);

                    // Base dust brightness
                    vec3 baseColor = uColor * 0.7;

                    // Day side: neutral/warm tint, Night side: blue fill light tint
                    vec3 dayColor = baseColor * mix(vec3(1.17), uSunColor, 0.15);
                    vec3 nightColor = baseColor * uFillColor * vec3(0.95, 1.0, 1.25);

                    vec3 litColor = mix(nightColor, dayColor, dayFactor);

                    // Dust color with soft edge
                    float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
                    float alpha = vAlpha * (1.0 - dist * 1.5);

                    gl_FragColor = vec4(litColor, alpha);
                }
            `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 10;
    points.visible = true; // Explicitly set visible
    points.userData.skipBloomCache = true; // Exclude from bloom material caching
    geometry.setDrawRange(0, 0);

    return points;
  }

  _emitDust(tankId, tankGroup, trackSide) {
    const cfg = this.config;

    // Select the appropriate dust pool based on tank type
    const isPlayer = tankId === "player";
    const dust = isPlayer ? this.playerDust : this.otherDust;

    // Check if pool is full
    if (dust.activeCount >= dust.maxParticles) {
      this._recycleDustParticle(dust);
    }

    const idx = dust.activeCount;
    const i3 = idx * 3;

    // Get world position of track
    tankGroup.updateMatrixWorld();
    const offset = this.trackOffsets[trackSide].clone();

    // Add some randomness to spawn position along track length
    offset.z += (Math.random() - 0.5) * cfg.trackSpreadZ;
    offset.x += (Math.random() - 0.5) * cfg.trackSpreadX;

    offset.applyMatrix4(tankGroup.matrixWorld);

    // Push spawn position up from surface to reduce z-fighting
    const spawnNormal = offset.clone().normalize();
    offset.addScaledVector(spawnNormal, cfg.spawnOffset);

    dust.positions[i3] = offset.x;
    dust.positions[i3 + 1] = offset.y;
    dust.positions[i3 + 2] = offset.z;

    // Velocity: mostly outward from surface with slight lateral spread
    const surfaceNormal = offset.clone().normalize();
    const speed =
      cfg.velocityMin + Math.random() * (cfg.velocityMax - cfg.velocityMin);

    // Add lateral velocity (kicked to the side)
    const sideDirection = trackSide === "left" ? -1 : 1;
    const tankRight = new THREE.Vector3(1, 0, 0).transformDirection(
      tankGroup.matrixWorld,
    );

    dust.velocities[i3] =
      surfaceNormal.x * speed +
      tankRight.x * sideDirection * cfg.lateralKick +
      (Math.random() - 0.5) * cfg.randomSpread;
    dust.velocities[i3 + 1] =
      surfaceNormal.y * speed +
      tankRight.y * sideDirection * cfg.lateralKick +
      (Math.random() - 0.5) * cfg.randomSpread;
    dust.velocities[i3 + 2] =
      surfaceNormal.z * speed +
      tankRight.z * sideDirection * cfg.lateralKick +
      (Math.random() - 0.5) * cfg.randomSpread;

    dust.ages[idx] = 0;
    dust.lifetimes[idx] =
      cfg.lifetimeMin + Math.random() * (cfg.lifetimeMax - cfg.lifetimeMin);
    dust.sizes[idx] = cfg.sizeMin + Math.random() * (cfg.sizeMax - cfg.sizeMin);
    dust.rotations[idx] = Math.random() * Math.PI * 2;
    dust.rotationSpeeds[idx] =
      cfg.rotationSpeedMin +
      Math.random() * (cfg.rotationSpeedMax - cfg.rotationSpeedMin);

    dust.activeCount++;

    // Mark the new particle as dirty
    dust.dirtyParticles.add(idx);

    // Invalidate bounding sphere when new particle added
    dust.boundingSphereValid = false;

    // Mark appropriate buffer dirty
    const dustSystem = isPlayer ? this.playerDustSystem : this.otherDustSystem;

    // Update draw range immediately when emitting new particle
    dustSystem.geometry.setDrawRange(0, dust.activeCount);

    this._markDustBuffersDirty(dustSystem, dust);
  }

  _updateDust(dust, dustSystem, dt) {
    if (dust.activeCount === 0) return;

    const cfg = this.config;
    const rotationsAttr = dustSystem.geometry.attributes.aRotation.array;

    // Clear dirty set from previous frame
    dust.dirtyParticles.clear();

    for (let i = 0; i < dust.activeCount; i++) {
      const prevAge = dust.ages[i];
      dust.ages[i] += dt;

      if (dust.ages[i] >= dust.lifetimes[i]) {
        this._removeDustParticle(dust, i);
        dust.dirtyParticles.add(i);
        i--;
        continue;
      }

      // Track if particle changed
      if (Math.abs(dust.ages[i] - prevAge) > 0.001) {
        dust.dirtyParticles.add(i);
      }

      // Update rotation
      dust.rotations[i] += dust.rotationSpeeds[i] * dt;
      rotationsAttr[i] = dust.rotations[i];
      dust.dirtyParticles.add(i);

      const i3 = i * 3;

      // Apply drag (dust slows down) - frame-rate independent
      // Convert per-frame drag to per-second: drag^(dt*60) for 60fps baseline
      const dragFactor = Math.pow(cfg.drag, dt * 60);
      dust.velocities[i3] *= dragFactor;
      dust.velocities[i3 + 1] *= dragFactor;
      dust.velocities[i3 + 2] *= dragFactor;

      // Update position
      const prevX = dust.positions[i3];
      dust.positions[i3] += dust.velocities[i3] * dt;
      dust.positions[i3 + 1] += dust.velocities[i3 + 1] * dt;
      dust.positions[i3 + 2] += dust.velocities[i3 + 2] * dt;

      // Mark dirty if position changed significantly
      if (Math.abs(dust.positions[i3] - prevX) > 0.01) {
        dust.dirtyParticles.add(i);
      }
    }

    // Invalidate bounding sphere if >10% of particles moved
    if (dust.dirtyParticles.size > dust.maxParticles * 0.1) {
      dust.boundingSphereValid = false;
    }

    this._markDustBuffersDirty(dustSystem, dust);
    dustSystem.geometry.setDrawRange(0, dust.activeCount);
  }

  _removeDustParticle(dust, index) {
    const lastIdx = dust.activeCount - 1;

    if (index !== lastIdx) {
      const i3 = index * 3;
      const l3 = lastIdx * 3;

      dust.positions[i3] = dust.positions[l3];
      dust.positions[i3 + 1] = dust.positions[l3 + 1];
      dust.positions[i3 + 2] = dust.positions[l3 + 2];

      dust.velocities[i3] = dust.velocities[l3];
      dust.velocities[i3 + 1] = dust.velocities[l3 + 1];
      dust.velocities[i3 + 2] = dust.velocities[l3 + 2];

      dust.ages[index] = dust.ages[lastIdx];
      dust.lifetimes[index] = dust.lifetimes[lastIdx];
      dust.sizes[index] = dust.sizes[lastIdx];
      dust.rotations[index] = dust.rotations[lastIdx];
      dust.rotationSpeeds[index] = dust.rotationSpeeds[lastIdx];
    }

    dust.activeCount--;
  }

  _recycleDustParticle(dust) {
    let oldestIdx = 0;
    let oldestRatio = 0;

    for (let i = 0; i < dust.activeCount; i++) {
      const ratio = dust.ages[i] / dust.lifetimes[i];
      if (ratio > oldestRatio) {
        oldestRatio = ratio;
        oldestIdx = i;
      }
    }

    this._removeDustParticle(dust, oldestIdx);
  }

  _markDustBuffersDirty(dustSystem, dust) {
    // Skip update if no particles changed and we updated recently (performance optimization)
    if (dust.dirtyParticles.size === 0 && dust.framesSinceUpdate < 5) {
      dust.framesSinceUpdate++;
      return; // Skip GPU upload!
    }

    const geo = dustSystem.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAge.needsUpdate = true;
    geo.attributes.aLifetime.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aRotation.needsUpdate = true;

    dust.framesSinceUpdate = 0;
  }

  // ========================
  // CLEANUP
  // ========================

  dispose() {
    if (this.playerDustSystem) {
      this.scene.remove(this.playerDustSystem);
      this.playerDustSystem.geometry.dispose();
      this.playerDustSystem.material.dispose();
    }
    if (this.otherDustSystem) {
      this.scene.remove(this.otherDustSystem);
      this.otherDustSystem.geometry.dispose();
      this.otherDustSystem.material.dispose();
    }
    this.trackedTanks.clear();
  }
}
