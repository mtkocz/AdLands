/**
 * AdLands - Tread Tracks Module
 * Oil tracks left by tanks after driving through oil puddles
 * Tracks match puddle material/opacity exactly and fade with the source puddle
 */

// Preallocated spheres for frustum culling (avoid per-frame GC)
const _playerCullSphere = new THREE.Sphere();
const _otherCullSphere = new THREE.Sphere();

// Preallocated temp objects for update loops (avoid per-frame GC)
const _trackSegmentMatrix = new THREE.Matrix4();
const _trackSegmentPos = new THREE.Vector3();
const _trackWorldPos = new THREE.Vector3();
const _trackZeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _trackForward = new THREE.Vector3();
const _trackRight = new THREE.Vector3();
const _trackTempMatrix = new THREE.Matrix4();
const _trackTempColor = new THREE.Color();

class TreadTracks {
  constructor(parentGroup, sphereRadius) {
    this.parentGroup = parentGroup;
    this.sphereRadius = sphereRadius;

    // Configuration
    this.config = {
      // Segment pools
      maxSegments: 2000, // Max segments for all OTHER tanks
      maxPlayerSegments: 1000, // Max segments for player tank (separate pool)

      segmentLength: 0.3,
      segmentWidth: 0.5,
      fadeTime: 60.0, // Safety timeout for segment cleanup
      minDistance: 0.15, // Min distance between track segments
      surfaceOffset: 0.001,
    };

    // Tracked tanks (player and bots)
    this.trackedTanks = new Map();

    // Reference to cannon system for oil puddle positions
    this.cannonSystem = null;

    // 6 independent track spawners - front/center/rear per tread
    // Each spawner creates its own track line
    this.trackSpawners = {
      frontLeft: { x: -1.3, z: -1.5 },
      midLeft: { x: -1.3, z: 0 },
      rearLeft: { x: -1.3, z: 1.5 },
      frontRight: { x: 1.3, z: -1.5 },
      midRight: { x: 1.3, z: 0 },
      rearRight: { x: 1.3, z: 1.5 },
    };

    // Maximum distance tracks can travel from pickup point (in meters)
    this.maxTrackDistance = 20;

    // Frame counter for performance optimization
    this.frameCounter = 0;

    this._createTrackTexture();
    this._createTrackSystems();
  }

  // ========================
  // PUBLIC API
  // ========================

  /**
   * Set reference to cannon system for oil puddle collision
   */
  setCannonSystem(cannonSystem) {
    this.cannonSystem = cannonSystem;
  }

  /**
   * Register a tank to leave tracks
   */
  registerTank(tankId, group, state) {
    this.trackedTanks.set(tankId, {
      group,
      state,
      spawners: this._createSpawnerState(),
    });
  }

  /**
   * Update tank reference (for bots that may change)
   */
  updateTank(tankId, group, state) {
    const existing = this.trackedTanks.get(tankId);
    this.trackedTanks.set(tankId, {
      group,
      state,
      spawners: existing ? existing.spawners : this._createSpawnerState(),
    });
  }

  /**
   * Remove a tank from track emission
   */
  unregisterTank(tankId) {
    this.trackedTanks.delete(tankId);
  }

  /**
   * Update all track systems (call each frame)
   */
  update(
    tank,
    deltaTime,
    camera = null,
    isOrbitalView = false,
    frustum = null,
  ) {
    // Hard cutoff distance for track visibility
    const TRACK_CUTOFF_DISTANCE = 120;

    // Get camera distance above planet surface
    let cameraDistanceFromSurface = 0;
    if (camera) {
      const cameraPos = camera.getWorldPosition(
        this._tempCameraPos || (this._tempCameraPos = new THREE.Vector3()),
      );
      cameraDistanceFromSurface = cameraPos.length() - this.sphereRadius;
      this.playerMesh.material.uniforms.uCameraPos.value.copy(cameraPos);
      this.otherMesh.material.uniforms.uCameraPos.value.copy(cameraPos);
    }

    // Hide tracks in orbital view or when camera is beyond cutoff
    if (isOrbitalView || cameraDistanceFromSurface > TRACK_CUTOFF_DISTANCE) {
      this.playerMesh.visible = false;
      this.otherMesh.visible = false;
      this._updatePool(this.playerPool, this.playerMesh);
      this._updatePool(this.otherPool, this.otherMesh);
      return;
    }

    // Frustum culling for track meshes (with 10 unit margin for smooth visibility)
    if (frustum) {
      // Compute bounding spheres only when dirty (match TreadDust pattern)
      if (!this.playerBoundingSphereValid) {
        this.playerMesh.geometry.computeBoundingSphere();
        this.playerBoundingSphereValid = true;
      }
      if (!this.otherBoundingSphereValid) {
        this.otherMesh.geometry.computeBoundingSphere();
        this.otherBoundingSphereValid = true;
      }

      if (!this.playerMesh.geometry.boundingSphere || !this.otherMesh.geometry.boundingSphere) {
        this.playerMesh.visible = true;
        this.otherMesh.visible = true;
      } else {
        _playerCullSphere.copy(this.playerMesh.geometry.boundingSphere);
        _otherCullSphere.copy(this.otherMesh.geometry.boundingSphere);

        _playerCullSphere.applyMatrix4(this.playerMesh.matrixWorld);
        _otherCullSphere.applyMatrix4(this.otherMesh.matrixWorld);

        _playerCullSphere.radius += 10;
        _otherCullSphere.radius += 10;

        this.playerMesh.visible = frustum.intersectsSphere(_playerCullSphere);
        this.otherMesh.visible = frustum.intersectsSphere(_otherCullSphere);
      }
    } else {
      this.playerMesh.visible = true;
      this.otherMesh.visible = true;
    }

    // Get camera position for distance checks
    const cameraPos = camera
      ? camera.getWorldPosition(
          this._tempCameraPos2 || (this._tempCameraPos2 = new THREE.Vector3()),
        )
      : null;
    const TRACK_SPAWN_DISTANCE = 165;

    // Process each tracked tank
    for (const [tankId, tankData] of this.trackedTanks) {
      const { group, state, spawners } = tankData;

      // Skip dead tanks
      if (state.isDead) continue;

      // Distance-based spawning check (skip tanks far from camera)
      const tankPos = group.getWorldPosition(
        this._tempTankPos || (this._tempTankPos = new THREE.Vector3()),
      );
      if (cameraPos) {
        const distToCamera = tankPos.distanceTo(cameraPos);
        if (distToCamera > TRACK_SPAWN_DISTANCE) continue;
      }

      // Update world matrix for spawner calculations
      group.updateMatrixWorld();

      // Process each of the 6 independent spawners
      for (const [spawnerName, spawnerData] of Object.entries(spawners)) {
        const spawnPoint = this.trackSpawners[spawnerName];

        // Get spawner world position
        const worldPos = new THREE.Vector3(spawnPoint.x, 0, spawnPoint.z);
        worldPos.applyMatrix4(group.matrixWorld);

        // Check if THIS SPECIFIC spawner is currently over a puddle
        const puddle = this._getOilPuddleAt(worldPos);

        // Only spawn tracks if this wheel is actively touching a puddle
        if (puddle) {
          // Update source puddle and pickup position for this wheel
          spawnerData.sourcePuddle = puddle;
          spawnerData.pickupPos = worldPos.clone();

          // Get puddle opacity
          const puddleOpacity = puddle.material.opacity;

          // Check if we've moved enough to spawn a new segment
          let shouldSpawn = false;
          if (!spawnerData.lastSegmentPos) {
            shouldSpawn = true;
          } else {
            const distFromLastSegment = worldPos.distanceTo(
              spawnerData.lastSegmentPos,
            );
            shouldSpawn = distFromLastSegment >= this.config.minDistance;
          }

          if (shouldSpawn && puddleOpacity > 0.05) {
            // Convert to parent group's local space for rendering
            this.parentGroup.updateMatrixWorld();
            const localPos = this.parentGroup.worldToLocal(worldPos.clone());

            // Spawn track segment with reference to source puddle
            this._addSegment(
              tankId,
              tankData,
              spawnerName,
              localPos,
              spawnerData.sourcePuddle,
              spawnerData,
            );

            // Update last segment position
            spawnerData.lastSegmentPos = worldPos.clone();
          }
        } else if (spawnerData.sourcePuddle) {
          // Tread left the puddle but still has oil residue - track it around
          const puddleExists =
            this.cannonSystem &&
            this.cannonSystem.oilPuddles.includes(spawnerData.sourcePuddle);
          const puddleOpacity = puddleExists
            ? spawnerData.sourcePuddle.material.opacity
            : 0;

          // Calculate distance-based fade from last pickup point
          const distFromPickup = worldPos.distanceTo(spawnerData.pickupPos);
          const distanceOpacity =
            1.0 - Math.min(distFromPickup / this.maxTrackDistance, 1.0);
          const combinedOpacity = Math.min(puddleOpacity, distanceOpacity);

          if (combinedOpacity < 0.02) {
            // Oil has faded completely - clear state
            spawnerData.sourcePuddle = null;
            spawnerData.lastSegmentPos = null;
            spawnerData.pickupPos = null;
          } else {
            // Continue spawning track segments with fading opacity
            let shouldSpawn = false;
            if (!spawnerData.lastSegmentPos) {
              shouldSpawn = true;
            } else {
              const distFromLastSegment = worldPos.distanceTo(
                spawnerData.lastSegmentPos,
              );
              shouldSpawn = distFromLastSegment >= this.config.minDistance;
            }

            if (shouldSpawn) {
              this.parentGroup.updateMatrixWorld();
              const localPos = this.parentGroup.worldToLocal(worldPos.clone());

              this._addSegment(
                tankId,
                tankData,
                spawnerName,
                localPos,
                spawnerData.sourcePuddle,
                spawnerData,
              );

              spawnerData.lastSegmentPos = worldPos.clone();
            }
          }
        } else {
          // No oil on treads - clear state
          spawnerData.sourcePuddle = null;
          spawnerData.lastSegmentPos = null;
          spawnerData.pickupPos = null;
        }
      }
    }

    // Update both pools (time-based cleanup)
    this._updatePool(this.playerPool, this.playerMesh);
    this._updatePool(this.otherPool, this.otherMesh);
  }

  // ========================
  // TRACK SYSTEM
  // ========================

  _createSpawnerState() {
    const state = {};
    for (const name of Object.keys(this.trackSpawners)) {
      state[name] = { sourcePuddle: null, lastSegmentPos: null, pickupPos: null };
    }
    return state;
  }

  _createTrackTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");

    // Clear background
    ctx.clearRect(0, 0, 64, 64);

    // Draw tread pattern - match oil puddle color exactly (0x080808)
    // Full alpha - opacity controlled by puddle at spawn time
    ctx.fillStyle = "rgb(8, 8, 8)";
    ctx.fillRect(4, 0, 56, 64);

    this.trackTexture = new THREE.CanvasTexture(canvas);
    this.trackTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.trackTexture.wrapT = THREE.RepeatWrapping;
    this.trackTexture.minFilter = THREE.NearestFilter;
    this.trackTexture.magFilter = THREE.NearestFilter;
  }

  _createTrackSystems() {
    // Create player pool
    this.playerPool = this._createPool(this.config.maxPlayerSegments);
    this.playerMesh = this._createInstancedMesh(this.config.maxPlayerSegments);
    this.playerBoundingSphereValid = false;

    // Create other tanks pool
    this.otherPool = this._createPool(this.config.maxSegments);
    this.otherMesh = this._createInstancedMesh(this.config.maxSegments);
    this.otherBoundingSphereValid = false;

    // Add to parentGroup
    this.parentGroup.add(this.playerMesh);
    this.parentGroup.add(this.otherMesh);
  }

  _createPool(maxSegments) {
    return {
      maxSegments: maxSegments,
      segments: new Array(maxSegments).fill(null),
      nextIndex: 0,
    };
  }

  _createInstancedMesh(maxSegments) {
    const geometry = new THREE.PlaneGeometry(
      this.config.segmentWidth,
      this.config.segmentLength,
    );
    geometry.rotateX(-Math.PI / 2);

    const instancedMesh = new THREE.InstancedMesh(geometry, null, maxSegments);

    // Per-instance color for opacity
    const colors = new Float32Array(maxSegments * 3);
    for (let i = 0; i < maxSegments; i++) {
      colors[i * 3] = 0;
      colors[i * 3 + 1] = 0;
      colors[i * 3 + 2] = 0;
    }
    instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    // Custom shader for per-instance opacity with distance fading
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.trackTexture },
        uCameraPos: { value: new THREE.Vector3() },
        uFadeStart: { value: 50.0 },
        uFadeEnd: { value: 110.0 },
      },
      vertexShader: `
                uniform vec3 uCameraPos;
                uniform float uFadeStart;
                uniform float uFadeEnd;

                varying vec2 vUv;
                varying float vOpacity;

                void main() {
                    vUv = uv;

                    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);

                    // Distance-based fade (camera to track)
                    float distToCamera = distance(worldPos.xyz, uCameraPos);
                    float distanceFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, distToCamera);

                    // Combine: baked opacity (instanceColor.r) * distance fade
                    vOpacity = instanceColor.r * distanceFade;

                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `,
      fragmentShader: `
                uniform sampler2D map;
                varying vec2 vUv;
                varying float vOpacity;
                void main() {
                    if (vOpacity < 0.01) discard;

                    vec4 texColor = texture2D(map, vUv);
                    gl_FragColor = vec4(texColor.rgb, texColor.a * vOpacity);
                    if (gl_FragColor.a < 0.01) discard;
                }
            `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    instancedMesh.material = material;
    instancedMesh.renderOrder = 5;
    instancedMesh.castShadow = false;
    instancedMesh.receiveShadow = false;

    // Initialize all instances as hidden
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < maxSegments; i++) {
      instancedMesh.setMatrixAt(i, zeroMatrix);
    }
    instancedMesh.instanceMatrix.needsUpdate = true;

    return instancedMesh;
  }

  _addSegment(
    tankId,
    tankData,
    spawnerName,
    localPos,
    sourcePuddle,
    spawnerData,
  ) {
    const { group } = tankData;

    // Select pool based on tank type
    const isPlayer = tankId === "player";
    const pool = isPlayer ? this.playerPool : this.otherPool;
    const mesh = isPlayer ? this.playerMesh : this.otherMesh;

    // Calculate surface normal (direction from planet center in local space)
    const surfaceNormal = localPos.clone().normalize();

    // Get tank's forward direction in local space
    _trackForward.set(0, 0, -1);
    _trackForward.transformDirection(group.matrixWorld);
    _trackTempMatrix.copy(this.parentGroup.matrixWorld).invert();
    _trackForward.transformDirection(_trackTempMatrix);

    // Project forward onto tangent plane (reuse _trackForward in-place)
    const tangentForward = _trackForward;
    tangentForward.addScaledVector(surfaceNormal, -_trackForward.dot(surfaceNormal));

    // Safety check for degenerate tangent
    const tangentLength = tangentForward.length();
    if (tangentLength < 0.001) {
      tangentForward.set(1, 0, 0);
      tangentForward.addScaledVector(
        surfaceNormal,
        -tangentForward.dot(surfaceNormal),
      );
      if (tangentForward.length() < 0.001) {
        tangentForward.set(0, 0, 1);
      }
    }
    tangentForward.normalize();

    // Position just above surface
    const segmentPos = localPos
      .clone()
      .normalize()
      .multiplyScalar(this.sphereRadius + this.config.surfaceOffset);

    // Build rotation matrix
    _trackRight.crossVectors(tangentForward, surfaceNormal).normalize();

    _trackTempMatrix.makeBasis(_trackRight, surfaceNormal, tangentForward);
    _trackTempMatrix.setPosition(segmentPos);

    // Ring buffer index
    const instanceIndex = pool.nextIndex;

    // Compute distance-based opacity (for segments spawned after leaving puddle)
    let initialDistanceOpacity = 1.0;
    if (spawnerData.pickupPos) {
      const segWorldPos = localPos.clone();
      this.parentGroup.localToWorld(segWorldPos);
      const dist = segWorldPos.distanceTo(spawnerData.pickupPos);
      initialDistanceOpacity =
        1.0 - Math.min(dist / this.maxTrackDistance, 1.0);
    }

    // Store segment data with reference to source puddle (for live fading)
    pool.segments[instanceIndex] = {
      birthTime: performance.now() / 1000,
      sourcePuddle: sourcePuddle,
      pickupPos: spawnerData.pickupPos ? spawnerData.pickupPos.clone() : null,
      cachedDistanceOpacity: initialDistanceOpacity,
    };

    // Advance ring buffer
    pool.nextIndex = (pool.nextIndex + 1) % pool.maxSegments;

    // Get current puddle opacity for initial color (combine with distance fade)
    let opacity = sourcePuddle ? sourcePuddle.material.opacity : 1.0;
    opacity = Math.min(opacity, initialDistanceOpacity);

    // Update instance
    mesh.setMatrixAt(instanceIndex, _trackTempMatrix);
    _trackTempColor.setRGB(opacity, opacity, opacity);
    mesh.setColorAt(instanceIndex, _trackTempColor);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
    // Invalidate bounding sphere when geometry changes
    if (isPlayer) {
      this.playerBoundingSphereValid = false;
    } else {
      this.otherBoundingSphereValid = false;
    }
  }

  _updatePool(pool, mesh) {
    const currentTime = performance.now() / 1000;
    let matrixChanged = false;
    let colorChanged = false;

    // Increment frame counter for performance optimization
    this.frameCounter++;
    const updateDistanceThisFrame = this.frameCounter % 3 === 0;

    // Update each segment - fade with source puddle AND distance
    for (let i = 0; i < pool.maxSegments; i++) {
      const segment = pool.segments[i];
      if (!segment) continue;

      const age = currentTime - segment.birthTime;

      // Get opacity from source puddle (live tracking)
      let puddleOpacity = 1.0;
      if (segment.sourcePuddle) {
        const puddleExists =
          this.cannonSystem &&
          this.cannonSystem.oilPuddles.includes(segment.sourcePuddle);
        puddleOpacity = puddleExists
          ? segment.sourcePuddle.material.opacity
          : 0;
      }

      // Calculate distance-based opacity (performance optimized)
      let distanceOpacity = segment.cachedDistanceOpacity || 1.0;
      if (segment.pickupPos && updateDistanceThisFrame) {
        // Get segment's current world position from instance matrix
        mesh.getMatrixAt(i, _trackSegmentMatrix);
        _trackSegmentPos.setFromMatrixPosition(_trackSegmentMatrix);

        // Convert to world space
        _trackWorldPos.copy(_trackSegmentPos);
        this.parentGroup.localToWorld(_trackWorldPos);

        // Calculate distance from pickup point
        const distanceFromPickup = _trackWorldPos.distanceTo(segment.pickupPos);

        // Linear fade from 1.0 at 0m to 0.0 at 20m
        distanceOpacity =
          1.0 - Math.min(distanceFromPickup / this.maxTrackDistance, 1.0);

        // Cache for next frames
        segment.cachedDistanceOpacity = distanceOpacity;
      }

      // Combine both fades (use minimum to ensure both can cause fading)
      const finalOpacity = Math.min(puddleOpacity, distanceOpacity);

      // Remove if opacity too low or timeout
      if (finalOpacity < 0.01 || age >= this.config.fadeTime) {
        mesh.setMatrixAt(i, _trackZeroMatrix);
        _trackTempColor.setRGB(0, 0, 0);
        mesh.setColorAt(i, _trackTempColor);
        pool.segments[i] = null;
        matrixChanged = true;
        colorChanged = true;
      } else {
        // Update opacity to combined value
        _trackTempColor.setRGB(finalOpacity, finalOpacity, finalOpacity);
        mesh.setColorAt(i, _trackTempColor);
        colorChanged = true;
      }
    }

    if (matrixChanged) {
      mesh.instanceMatrix.needsUpdate = true;
      // Invalidate bounding sphere when instances removed
      if (mesh === this.playerMesh) {
        this.playerBoundingSphereValid = false;
      } else {
        this.otherBoundingSphereValid = false;
      }
    }
    if (colorChanged && mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Check if a world position is over any oil puddle
   * Returns the puddle if found (so we can track its opacity), or null
   */
  _getOilPuddleAt(worldPos) {
    if (!this.cannonSystem || !this.cannonSystem.oilPuddles) return null;

    const oilPuddles = this.cannonSystem.oilPuddles;
    if (oilPuddles.length === 0) return null;

    // Temp vector for puddle world position
    const puddleWorldPos = new THREE.Vector3();

    for (const puddle of oilPuddles) {
      // Get puddle's actual world position (reliable method)
      puddle.mesh.getWorldPosition(puddleWorldPos);

      // Simple world-space distance check
      const dist = worldPos.distanceTo(puddleWorldPos);
      const puddleRadius = puddle.mesh.scale.x * 1.5;

      if (dist < puddleRadius) {
        return puddle;
      }
    }

    return null;
  }

  clear() {
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

    // Clear player pool
    for (let i = 0; i < this.config.maxPlayerSegments; i++) {
      this.playerMesh.setMatrixAt(i, zeroMatrix);
      this.playerPool.segments[i] = null;
    }
    this.playerPool.nextIndex = 0;
    this.playerMesh.instanceMatrix.needsUpdate = true;
    this.playerBoundingSphereValid = false;

    // Clear other pool
    for (let i = 0; i < this.config.maxSegments; i++) {
      this.otherMesh.setMatrixAt(i, zeroMatrix);
      this.otherPool.segments[i] = null;
    }
    this.otherPool.nextIndex = 0;
    this.otherMesh.instanceMatrix.needsUpdate = true;
    this.otherBoundingSphereValid = false;

    // Reset spawner state for all tanks
    for (const [tankId, tankData] of this.trackedTanks) {
      for (const spawnerName of Object.keys(tankData.spawners)) {
        tankData.spawners[spawnerName] = {
          sourcePuddle: null,
          lastSegmentPos: null,
          pickupPos: null,
        };
      }
    }
  }

  dispose() {
    if (this.playerMesh) {
      this.parentGroup.remove(this.playerMesh);
      this.playerMesh.geometry.dispose();
      this.playerMesh.material.dispose();
    }
    if (this.otherMesh) {
      this.parentGroup.remove(this.otherMesh);
      this.otherMesh.geometry.dispose();
      this.otherMesh.material.dispose();
    }
    this.trackedTanks.clear();
  }
}
