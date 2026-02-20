/**
 * AdLands - Tank Collision System (Optimized for MMO)
 *
 * Performance optimizations:
 * - Spatial hashing using spherical coordinates (phi/theta grid)
 * - Preallocated temp vectors (zero GC pressure)
 * - Direct spherical coordinate collision (no world-space transforms)
 * - Staggered collision checks for distant tanks
 * - Simple separation response (no complex physics)
 */

// Preallocated temp spheres for frustum culling (avoid per-frame clone())
const _colDustSphere = new THREE.Sphere();
const _colSparkSphere = new THREE.Sphere();
// Preallocated vectors for far-side (backface) culling
const _colCullNormal = new THREE.Vector3();
const _colCullDir = new THREE.Vector3();
const _colCameraWorldPos = new THREE.Vector3();

class TankCollision {
    constructor(scene, sphereRadius) {
        this.scene = scene;
        this.sphereRadius = sphereRadius;

        // Collision configuration
        // Tank dimensions: 5.5 x 3 x 1.5 units (length x width x height)
        // Collision radius ~= half of longest dimension for circle approximation
        this.config = {
            collisionRadius: 3.0,           // World units (fits tank footprint: 5.5 length, 3 width)
            collisionRadiusSq: 9.0,         // Squared for fast distance check
            // Convert collision radius to angular distance on sphere surface
            // angularRadius = collisionRadius / sphereRadius (in radians)
            angularRadius: 3.0 / sphereRadius,
            angularRadiusSq: (3.0 / sphereRadius) ** 2,

            minCollisionSpeed: 0.00005,
            collisionCooldown: 500,

            // Spatial hash grid settings
            // Grid cell size should be ~2x collision radius in angular units
            gridCellSize: (6.0 / sphereRadius),  // ~2x collision radius (kept for grid efficiency)
            gridPhiCells: 32,                     // Cells along phi (0 to PI)
            gridThetaCells: 64,                   // Cells along theta (0 to 2PI)
        };

        // Spatial hash grid for fast neighbor lookups
        // Key: "phi_theta" cell index, Value: Set of tank IDs
        this.spatialGrid = new Map();

        // Collision cooldowns
        this.collisionCooldowns = new Map();

        // Registered tanks with spherical coordinates
        this.tanks = new Map();

        // Planet reference for terrain collision checks
        this.planet = null;

        // Preallocated temp vectors (avoid GC)
        this._temp = {
            collisionPoint: new THREE.Vector3(),
            pushDir: new THREE.Vector3(),
            posA: new THREE.Vector3(),
            posB: new THREE.Vector3(),
            terrainLocal: new THREE.Vector3()
        };

        // Particle systems
        this._createDustSystem();
        this._createSparkSystem();

        // Frame counter for staggered updates
        this._frameCount = 0;

    }

    // ========================
    // PUBLIC API
    // ========================

    registerTank(tankId, tankData) {
        // Store with spherical coordinate cache
        const entry = {
            ...tankData,
            // Cache spherical coords for fast lookup
            _cachedPhi: 0,
            _cachedTheta: 0,
            _gridKey: null
        };
        this.tanks.set(tankId, entry);
    }

    updateTank(tankId, tankData) {
        const existing = this.tanks.get(tankId);
        if (existing) {
            Object.assign(existing, tankData);
        } else {
            this.registerTank(tankId, tankData);
        }
    }

    unregisterTank(tankId) {
        const tank = this.tanks.get(tankId);
        if (tank && tank._gridKey) {
            const cell = this.spatialGrid.get(tank._gridKey);
            if (cell) cell.delete(tankId);
        }
        this.tanks.delete(tankId);
    }

    setPlanet(planet) {
        this.planet = planet;
    }

    _isOnElevatedTerrain(worldPos) {
        if (!this.planet?.terrainElevation) return false;
        this._temp.terrainLocal.copy(worldPos);
        this.planet.hexGroup.worldToLocal(this._temp.terrainLocal);
        // Check both elevated terrain AND polar holes
        if (this.planet.terrainElevation.getElevationAtPosition(this._temp.terrainLocal) > 0) return true;
        if (this.planet.isInsidePolarHole && this.planet.isInsidePolarHole(this._temp.terrainLocal)) return true;
        return false;
    }

    /**
     * Set lighting configuration for dust color tinting
     * @param {Object} lightConfig - Light colors/directions from environment.getLightingConfig()
     */
    setLightingConfig(lightConfig) {
        const sunColor = lightConfig.sun.color;
        const fillColor = lightConfig.fill.color;
        const ambientColor = lightConfig.ambient.color;

        const uniforms = this.dustSystem.material.uniforms;
        uniforms.uSunColor.value.set(sunColor.r, sunColor.g, sunColor.b);
        uniforms.uSunDirection.value.copy(lightConfig.sun.direction);
        uniforms.uFillColor.value.set(fillColor.r, fillColor.g, fillColor.b);
        uniforms.uFillDirection.value.copy(lightConfig.fill.direction);
        uniforms.uAmbientColor.value.set(ambientColor.r, ambientColor.g, ambientColor.b);
        uniforms.uAmbientIntensity.value = lightConfig.ambient.intensity;
    }

    update(deltaTime, frustum = null, camera = null) {
        this._frameCount++;

        // Update spatial grid (staggered - not every frame for distant tanks)
        this._updateSpatialGrid();

        // Check collisions using spatial hash
        this._checkCollisionsSpatial();

        // Cache camera world position for backface culling
        if (camera) camera.getWorldPosition(_colCameraWorldPos);

        // Backface + frustum culling for particle systems (with 10 unit margin for smooth visibility)
        if (frustum) {
            // Cull dust system
            if (this.dustSystem && this.dust.activeCount > 0) {
                this.dustSystem.geometry.computeBoundingSphere();
                _colDustSphere.copy(this.dustSystem.geometry.boundingSphere);
                _colDustSphere.applyMatrix4(this.dustSystem.matrixWorld);
                _colDustSphere.radius += 10;
                _colCullNormal.copy(_colDustSphere.center).normalize();
                _colCullDir.copy(_colDustSphere.center).sub(_colCameraWorldPos).normalize();
                if (_colCullNormal.dot(_colCullDir) > 0.15) {
                    this.dustSystem.visible = false;
                } else {
                    this.dustSystem.visible = frustum.intersectsSphere(_colDustSphere);
                }
            }

            // Cull spark system
            if (this.sparkSystem && this.sparks.activeCount > 0) {
                this.sparkSystem.geometry.computeBoundingSphere();
                _colSparkSphere.copy(this.sparkSystem.geometry.boundingSphere);
                _colSparkSphere.applyMatrix4(this.sparkSystem.matrixWorld);
                _colSparkSphere.radius += 10;
                _colCullNormal.copy(_colSparkSphere.center).normalize();
                _colCullDir.copy(_colSparkSphere.center).sub(_colCameraWorldPos).normalize();
                if (_colCullNormal.dot(_colCullDir) > 0.15) {
                    this.sparkSystem.visible = false;
                } else {
                    this.sparkSystem.visible = frustum.intersectsSphere(_colSparkSphere);
                }
            }
        }

        // Update particles
        this._updateDust(deltaTime);
        this._updateSparks(deltaTime);
    }

    // ========================
    // SPATIAL HASHING
    // ========================

    _getGridKey(phi, theta) {
        // Normalize phi to [0, PI] and theta to [0, 2PI]
        const cfg = this.config;
        const phiCell = Math.floor((phi / Math.PI) * cfg.gridPhiCells) % cfg.gridPhiCells;
        const thetaCell = Math.floor((theta / (Math.PI * 2)) * cfg.gridThetaCells) % cfg.gridThetaCells;
        return `${phiCell}_${thetaCell}`;
    }

    _getNeighborKeys(phi, theta) {
        // Get current cell and all 8 neighbors (for edge cases)
        const cfg = this.config;
        const phiCell = Math.floor((phi / Math.PI) * cfg.gridPhiCells);
        const thetaCell = Math.floor((theta / (Math.PI * 2)) * cfg.gridThetaCells);

        const keys = [];
        for (let dp = -1; dp <= 1; dp++) {
            for (let dt = -1; dt <= 1; dt++) {
                const p = (phiCell + dp + cfg.gridPhiCells) % cfg.gridPhiCells;
                const t = (thetaCell + dt + cfg.gridThetaCells) % cfg.gridThetaCells;
                keys.push(`${p}_${t}`);
            }
        }
        return keys;
    }

    _updateSpatialGrid() {
        // Update tank positions in spatial grid
        for (const [tankId, tank] of this.tanks) {
            // Skip fading or deploying tanks
            if (tank.botRef?.isFading || tank.botRef?.isDeploying || tank.playerRef?.state?.isFading) continue;

            // Get current spherical coordinates
            let phi, theta;
            if (tank.isBot && tank.botRef) {
                phi = tank.botRef.phi;
                theta = tank.botRef.theta;
            } else if (tank.playerRef) {
                phi = tank.playerRef.state.phi;
                theta = tank.playerRef.state.theta;
            } else {
                continue;
            }

            // Normalize theta to [0, 2PI]
            while (theta < 0) theta += Math.PI * 2;
            while (theta >= Math.PI * 2) theta -= Math.PI * 2;

            const newKey = this._getGridKey(phi, theta);

            // Update grid if cell changed
            if (newKey !== tank._gridKey) {
                // Remove from old cell
                if (tank._gridKey) {
                    const oldCell = this.spatialGrid.get(tank._gridKey);
                    if (oldCell) oldCell.delete(tankId);
                }

                // Add to new cell
                if (!this.spatialGrid.has(newKey)) {
                    this.spatialGrid.set(newKey, new Set());
                }
                this.spatialGrid.get(newKey).add(tankId);
                tank._gridKey = newKey;
            }

            // Cache spherical coords
            tank._cachedPhi = phi;
            tank._cachedTheta = theta;
        }
    }

    // ========================
    // COLLISION DETECTION (World-space for accuracy)
    // ========================

    _checkCollisionsSpatial() {
        const now = performance.now();
        const cfg = this.config;
        const checkedPairs = new Set();

        // Use spatial grid for broad phase, then world-space for narrow phase
        for (const [tankId, tank] of this.tanks) {
            // Skip fading/dead/deploying tanks
            if (tank.botRef?.isFading || tank.botRef?.isDeploying || tank.playerRef?.state?.isFading) continue;
            if (tank.botRef?.isDead || tank.playerRef?.state?.isDead) continue;
            if (!tank._gridKey) continue;

            // Get world position for this tank
            this._getWorldPositionCached(tank, this._temp.posA);

            // Get neighbor cells
            const neighborKeys = this._getNeighborKeys(tank._cachedPhi, tank._cachedTheta);

            // Check tanks in neighboring cells
            for (const key of neighborKeys) {
                const cell = this.spatialGrid.get(key);
                if (!cell) continue;

                for (const otherTankId of cell) {
                    if (otherTankId === tankId) continue;

                    // Create unique pair key to avoid double-checking
                    const pairKey = tankId < otherTankId ? `${tankId}|${otherTankId}` : `${otherTankId}|${tankId}`;
                    if (checkedPairs.has(pairKey)) continue;
                    checkedPairs.add(pairKey);

                    const otherTank = this.tanks.get(otherTankId);
                    if (!otherTank) continue;
                    if (otherTank.botRef?.isFading || otherTank.botRef?.isDeploying || otherTank.playerRef?.state?.isFading) continue;
                    if (otherTank.botRef?.isDead || otherTank.playerRef?.state?.isDead) continue;

                    // Get world position for other tank
                    this._getWorldPositionCached(otherTank, this._temp.posB);

                    // World-space distance check (simple and accurate)
                    const dist = this._temp.posA.distanceTo(this._temp.posB);
                    const minDist = cfg.collisionRadius * 2;

                    if (dist < minDist) {
                        this._handleCollisionWorldSpace(
                            tankId, tank,
                            otherTankId, otherTank,
                            dist, minDist,
                            now
                        );
                    }
                }
            }
        }
    }

    _handleCollisionWorldSpace(idA, tankA, idB, tankB, dist, minDist, now) {
        const cfg = this.config;

        // Calculate overlap in world units
        const overlap = minDist - dist;
        if (overlap <= 0) return;

        // Calculate relative speed for effect intensity
        const speedA = Math.abs(tankA.state?.speed || tankA.botRef?.state?.speed || 0);
        const speedB = Math.abs(tankB.state?.speed || tankB.botRef?.state?.speed || 0);
        const relativeSpeed = speedA + speedB;

        // --- Soft prediction push (local player only) ---
        // Server is authoritative for collision resolution. Client only applies
        // a gentle push to the local player for immediate visual feedback.
        // Remote tanks are interpolating toward server positions — don't touch them.
        const localId = "player";
        if (idA === localId) {
            this._softPushLocal(tankA, overlap);
            this._dampenVelocity(tankA, 0.5);
        } else if (idB === localId) {
            this._softPushLocal(tankB, overlap);
            this._dampenVelocity(tankB, 0.5);
        }
        // Remote-to-remote: no push, no velocity change (server handles it)

        // Check cooldown for visual effects (unchanged — instant client feedback)
        const pairKey = idA < idB ? `${idA}-${idB}` : `${idB}-${idA}`;
        const lastCollision = this.collisionCooldowns.get(pairKey) || 0;

        if (now - lastCollision > cfg.collisionCooldown && relativeSpeed > cfg.minCollisionSpeed) {
            // Collision point is midpoint between tanks
            this._temp.collisionPoint.copy(this._temp.posA).add(this._temp.posB).multiplyScalar(0.5);
            this._emitCollisionEffects(this._temp.collisionPoint, relativeSpeed);
            this.collisionCooldowns.set(pairKey, now);
        }
    }

    _softPushLocal(localTank, overlap) {
        // Gentle push: 30% of overlap for immediate visual feedback.
        // Server will send the full authoritative correction next tick.
        const posA = this._temp.posA;
        const posB = this._temp.posB;

        if (!isFinite(posA.x) || !isFinite(posB.x)) return;

        this._temp.pushDir.copy(posA).sub(posB);
        const len = this._temp.pushDir.length();
        if (len < 0.0001) return;
        this._temp.pushDir.divideScalar(len);

        const pushAmount = overlap * 0.3;
        const newPos = posA.clone().addScaledVector(this._temp.pushDir, pushAmount);

        if (!this._isOnElevatedTerrain(newPos)) {
            this._applyWorldPositionToTank(localTank, newPos);
        }
    }

    _pushTanksWorldSpace(tankA, tankB, overlap) {
        // Get current world positions (already in _temp from collision check)
        const posA = this._temp.posA;
        const posB = this._temp.posB;

        // Safety check: ensure positions are valid
        if (!isFinite(posA.x) || !isFinite(posB.x)) {
            return;
        }

        // Calculate push direction in world space (from B toward A)
        this._temp.pushDir.copy(posA).sub(posB);
        const len = this._temp.pushDir.length();
        if (len < 0.0001) {
            // Tanks exactly overlapping - push along surface tangent instead of random
            // Use the tank's forward direction as a fallback
            const normal = posA.clone().normalize();
            this._temp.pushDir.set(1, 0, 0);
            // Make it perpendicular to surface normal
            this._temp.pushDir.sub(normal.multiplyScalar(this._temp.pushDir.dot(normal)));
            if (this._temp.pushDir.length() < 0.001) {
                this._temp.pushDir.set(0, 0, 1);
            }
            this._temp.pushDir.normalize();
        } else {
            this._temp.pushDir.divideScalar(len);
        }

        // Push amount: half the overlap plus a larger buffer to ensure clear separation
        const pushAmount = overlap / 2 + 1.5;

        // Calculate new world positions
        const newPosA = posA.clone().addScaledVector(this._temp.pushDir, pushAmount);
        const newPosB = posB.clone().addScaledVector(this._temp.pushDir, -pushAmount);

        // Terrain check: don't push tanks into elevated terrain
        const aBlocked = this._isOnElevatedTerrain(newPosA);
        const bBlocked = this._isOnElevatedTerrain(newPosB);

        if (!aBlocked && !bBlocked) {
            this._applyWorldPositionToTank(tankA, newPosA);
            this._applyWorldPositionToTank(tankB, newPosB);
        } else if (!aBlocked) {
            // B blocked by terrain - push A the full distance
            const fullPosA = posA.clone().addScaledVector(this._temp.pushDir, overlap + 1.5);
            if (!this._isOnElevatedTerrain(fullPosA)) {
                this._applyWorldPositionToTank(tankA, fullPosA);
            }
        } else if (!bBlocked) {
            // A blocked by terrain - push B the full distance
            const fullPosB = posB.clone().addScaledVector(this._temp.pushDir, -(overlap + 1.5));
            if (!this._isOnElevatedTerrain(fullPosB)) {
                this._applyWorldPositionToTank(tankB, fullPosB);
            }
        }
        // Both blocked: skip push entirely, velocity kill + bounce will separate over time
    }

    _applyWorldPositionToTank(tankData, worldPos) {
        // Safety check: ensure worldPos is valid
        if (!worldPos || !isFinite(worldPos.x) || !isFinite(worldPos.y) || !isFinite(worldPos.z)) {
            return;  // Don't apply invalid position
        }

        const len = worldPos.length();
        if (len < 0.001) {
            return;  // Position too close to origin, skip
        }

        // Bots are children of hexGroup - convert world pos to hexGroup-local
        // so spherical coords match bot's local coordinate space
        let pos = worldPos;
        if (tankData.isBot && this.planet) {
            pos = worldPos.clone();
            this.planet.hexGroup.worldToLocal(pos);
        }

        // Project position onto sphere surface
        const surfacePos = pos.clone().normalize().multiplyScalar(this.sphereRadius);

        // Convert to spherical coordinates
        // Clamp y/radius to [-1, 1] to prevent NaN from acos
        const yRatio = Math.max(-1, Math.min(1, surfacePos.y / this.sphereRadius));
        const phi = Math.acos(yRatio);
        let theta = Math.atan2(surfacePos.z, surfacePos.x);
        if (theta < 0) theta += Math.PI * 2;

        // Final validation: ensure phi and theta are valid numbers
        if (!isFinite(phi) || !isFinite(theta)) {
            return;  // Don't apply invalid coordinates
        }

        // Safety: check if position change is reasonable (prevent teleportation)
        const MAX_ANGULAR_CHANGE = 0.3;  // Max ~17 degrees change per collision (relaxed for reliable separation)
        const currentPhi = tankData._cachedPhi || phi;
        const currentTheta = tankData._cachedTheta || theta;

        let dPhi = phi - currentPhi;
        let dTheta = theta - currentTheta;
        // Normalize theta difference
        if (dTheta > Math.PI) dTheta -= Math.PI * 2;
        if (dTheta < -Math.PI) dTheta += Math.PI * 2;

        // If change is too large, this is likely an error - skip it
        if (Math.abs(dPhi) > MAX_ANGULAR_CHANGE || Math.abs(dTheta) > MAX_ANGULAR_CHANGE) {
            // Suppressed verbose logging
            return;
        }

        // Apply to the appropriate tank reference
        if (tankData.isBot && tankData.botRef && !tankData.botRef.isDead) {
            tankData.botRef.phi = phi;
            tankData.botRef.theta = theta;
            // Update cached coords immediately
            tankData._cachedPhi = phi;
            tankData._cachedTheta = theta;
        } else if (tankData.playerRef && !tankData.playerRef.state.isDead) {
            tankData.playerRef.state.phi = phi;
            tankData.playerRef.state.theta = theta;
            // Update cached coords immediately
            tankData._cachedPhi = phi;
            tankData._cachedTheta = theta;
        }
    }

    _dampenVelocity(tankData, factor) {
        // Apply velocity reduction to prevent immediate re-collision
        if (tankData.isBot && tankData.botRef && tankData.botRef.state) {
            tankData.botRef.state.speed *= factor;
        } else if (tankData.playerRef && tankData.playerRef.state) {
            tankData.playerRef.state.speed *= factor;
        }
    }

    _applyBounceVelocity(tankData, bounceSpeed) {
        // Apply a brief reverse velocity to make tanks bounce apart
        if (tankData.isBot && tankData.botRef && tankData.botRef.state) {
            tankData.botRef.state.speed = bounceSpeed;
        } else if (tankData.playerRef && tankData.playerRef.state) {
            tankData.playerRef.state.speed = bounceSpeed;
        }
    }

    _getWorldPositionCached(tankData, outVector) {
        if (tankData.group) {
            tankData.group.getWorldPosition(outVector);
        }
        return outVector;
    }

    // ========================
    // COLLISION EFFECTS
    // ========================

    _emitCollisionEffects(position, intensity) {
        // Cap particle counts for performance
        const dustCount = Math.min(8, Math.floor(3 + intensity * 3000));
        const sparkCount = Math.min(5, Math.floor(2 + intensity * 2000));

        for (let i = 0; i < dustCount; i++) {
            this._emitDustParticle(position, intensity);
        }
        for (let i = 0; i < sparkCount; i++) {
            this._emitSparkParticle(position, intensity);
        }
    }

    // ========================
    // DUST PARTICLE SYSTEM
    // ========================

    _createDustSystem() {
        this.dustConfig = {
            maxParticles: 100,  // Reduced for performance
            color: { r: 0.9, g: 0.88, b: 0.85 },  // Light tan dust
            sizeMin: 1.5,
            sizeMax: 4.0,
            opacity: 0.15,
            growthFactor: 3.0,
            lifetimeMin: 0.3,
            lifetimeMax: 0.8,
            velocityMin: 3.0,
            velocityMax: 8.0,
            drag: 0.95
        };

        const cfg = this.dustConfig;

        this.dust = {
            maxParticles: cfg.maxParticles,
            activeCount: 0,
            positions: new Float32Array(cfg.maxParticles * 3),
            velocities: new Float32Array(cfg.maxParticles * 3),
            ages: new Float32Array(cfg.maxParticles),
            lifetimes: new Float32Array(cfg.maxParticles),
            sizes: new Float32Array(cfg.maxParticles),
            rotations: new Float32Array(cfg.maxParticles),
            rotationSpeeds: new Float32Array(cfg.maxParticles)
        };

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.dust.positions, 3));
        geometry.setAttribute('aAge', new THREE.BufferAttribute(this.dust.ages, 1));
        geometry.setAttribute('aLifetime', new THREE.BufferAttribute(this.dust.lifetimes, 1));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.dust.sizes, 1));
        geometry.setAttribute('aRotation', new THREE.BufferAttribute(this.dust.rotations, 1));

        const material = new THREE.ShaderMaterial({
            uniforms: {
                uOpacity: { value: cfg.opacity },
                uGrowth: { value: cfg.growthFactor },
                uColor: { value: new THREE.Vector3(cfg.color.r, cfg.color.g, cfg.color.b) },
                // Lighting uniforms for subtle tinting
                uSunColor: { value: new THREE.Vector3(1.0, 0.85, 0.72) },      // 0xffd9b7
                uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
                uFillColor: { value: new THREE.Vector3(0.42, 0.56, 0.6) },     // 0x6B8E99
                uFillDirection: { value: new THREE.Vector3(-1, 0, 0) },
                uAmbientColor: { value: new THREE.Vector3(0.2, 0.4, 0.67) },   // 0x3366aa
                uAmbientIntensity: { value: 0.4 }
            },
            vertexShader: `
                uniform float uOpacity;
                uniform float uGrowth;
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
                    vWorldPosition = position;
                    float sizeFactor = 1.0 + lifeRatio * uGrowth;
                    float fadeIn = smoothstep(0.0, 0.1, lifeRatio);
                    float fadeOut = 1.0 - smoothstep(0.5, 1.0, lifeRatio);
                    vAlpha = fadeIn * fadeOut * uOpacity;
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
                    if (vAlpha < 0.01) discard;
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float c = cos(vRotation);
                    float s = sin(vRotation);
                    vec2 rotatedCoord = vec2(coord.x * c - coord.y * s, coord.x * s + coord.y * c);
                    if (abs(rotatedCoord.x) > 0.4 || abs(rotatedCoord.y) > 0.4) discard;

                    // Flat color - no directional lighting to avoid emissive appearance
                    vec3 litColor = uColor * 0.7;

                    float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
                    float alpha = vAlpha * (1.0 - dist * 1.5);
                    gl_FragColor = vec4(litColor, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending
        });

        this.dustSystem = new THREE.Points(geometry, material);
        this.dustSystem.frustumCulled = false;
        this.dustSystem.renderOrder = 10;
        this.dustSystem.userData.skipBloomCache = true;  // Exclude from bloom material caching
        geometry.setDrawRange(0, 0);
        this.scene.add(this.dustSystem);
    }

    _emitDustParticle(position, intensity) {
        const cfg = this.dustConfig;
        const dust = this.dust;

        if (dust.activeCount >= dust.maxParticles) {
            this._recycleDustParticle();
        }

        const idx = dust.activeCount;
        const i3 = idx * 3;

        dust.positions[i3] = position.x + (Math.random() - 0.5) * 2;
        dust.positions[i3 + 1] = position.y + (Math.random() - 0.5) * 2;
        dust.positions[i3 + 2] = position.z + (Math.random() - 0.5) * 2;

        const speed = cfg.velocityMin + Math.random() * (cfg.velocityMax - cfg.velocityMin);
        const vx = (Math.random() - 0.5);
        const vy = (Math.random() - 0.5);
        const vz = (Math.random() - 0.5);
        const vLen = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
        const scale = speed * (0.5 + intensity * 1000) / vLen;

        dust.velocities[i3] = vx * scale;
        dust.velocities[i3 + 1] = vy * scale;
        dust.velocities[i3 + 2] = vz * scale;

        dust.ages[idx] = 0;
        dust.lifetimes[idx] = cfg.lifetimeMin + Math.random() * (cfg.lifetimeMax - cfg.lifetimeMin);
        dust.sizes[idx] = cfg.sizeMin + Math.random() * (cfg.sizeMax - cfg.sizeMin);
        dust.rotations[idx] = Math.random() * Math.PI * 2;
        dust.rotationSpeeds[idx] = (Math.random() - 0.5) * 3;

        dust.activeCount++;
    }

    _updateDust(deltaTime) {
        const dust = this.dust;
        if (dust.activeCount === 0) return;

        const cfg = this.dustConfig;
        const dt = deltaTime || 1/60;
        const dragFactor = Math.pow(cfg.drag, dt * 60);

        for (let i = dust.activeCount - 1; i >= 0; i--) {
            dust.ages[i] += dt;

            if (dust.ages[i] >= dust.lifetimes[i]) {
                this._removeDustParticle(i);
                continue;
            }

            dust.rotations[i] += dust.rotationSpeeds[i] * dt;

            const i3 = i * 3;
            dust.velocities[i3] *= dragFactor;
            dust.velocities[i3 + 1] *= dragFactor;
            dust.velocities[i3 + 2] *= dragFactor;
            dust.positions[i3] += dust.velocities[i3] * dt;
            dust.positions[i3 + 1] += dust.velocities[i3 + 1] * dt;
            dust.positions[i3 + 2] += dust.velocities[i3 + 2] * dt;
        }

        this._markDustBuffersDirty();
        this.dustSystem.geometry.setDrawRange(0, dust.activeCount);
    }

    _removeDustParticle(index) {
        const dust = this.dust;
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

    _recycleDustParticle() {
        // Remove oldest particle
        let oldestIdx = 0;
        let oldestRatio = 0;
        for (let i = 0; i < this.dust.activeCount; i++) {
            const ratio = this.dust.ages[i] / this.dust.lifetimes[i];
            if (ratio > oldestRatio) {
                oldestRatio = ratio;
                oldestIdx = i;
            }
        }
        this._removeDustParticle(oldestIdx);
    }

    _markDustBuffersDirty() {
        const geo = this.dustSystem.geometry;
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aAge.needsUpdate = true;
        geo.attributes.aLifetime.needsUpdate = true;
        geo.attributes.aSize.needsUpdate = true;
        geo.attributes.aRotation.needsUpdate = true;
    }

    // ========================
    // SPARK PARTICLE SYSTEM
    // ========================

    _createSparkSystem() {
        this.sparkConfig = {
            maxParticles: 50,  // Reduced for performance
            colors: [
                { r: 1.0, g: 0.9, b: 0.3 },
                { r: 1.0, g: 0.7, b: 0.2 },
                { r: 1.0, g: 0.5, b: 0.1 }
            ],
            sizeMin: 0.3,
            sizeMax: 0.8,
            lifetimeMin: 0.15,
            lifetimeMax: 0.4,
            velocityMin: 8.0,
            velocityMax: 20.0,
            drag: 0.96
        };

        const cfg = this.sparkConfig;

        this.sparks = {
            maxParticles: cfg.maxParticles,
            activeCount: 0,
            positions: new Float32Array(cfg.maxParticles * 3),
            velocities: new Float32Array(cfg.maxParticles * 3),
            ages: new Float32Array(cfg.maxParticles),
            lifetimes: new Float32Array(cfg.maxParticles),
            sizes: new Float32Array(cfg.maxParticles),
            colors: new Float32Array(cfg.maxParticles * 3)
        };

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.sparks.positions, 3));
        geometry.setAttribute('aAge', new THREE.BufferAttribute(this.sparks.ages, 1));
        geometry.setAttribute('aLifetime', new THREE.BufferAttribute(this.sparks.lifetimes, 1));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sparks.sizes, 1));
        geometry.setAttribute('aColor', new THREE.BufferAttribute(this.sparks.colors, 3));

        const material = new THREE.ShaderMaterial({
            uniforms: {},
            vertexShader: `
                attribute float aAge;
                attribute float aLifetime;
                attribute float aSize;
                attribute vec3 aColor;
                varying float vAlpha;
                varying vec3 vColor;

                void main() {
                    float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
                    float sizeFactor = 1.0 - lifeRatio * 0.5;
                    float fadeIn = smoothstep(0.0, 0.05, lifeRatio);
                    float fadeOut = 1.0 - smoothstep(0.3, 1.0, lifeRatio);
                    vAlpha = fadeIn * fadeOut;
                    vColor = aColor;
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = aSize * sizeFactor * (200.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                varying vec3 vColor;

                void main() {
                    if (vAlpha < 0.01) discard;
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float dist = length(coord);
                    if (dist > 0.5) discard;
                    float glow = 1.0 - dist * 2.0;
                    glow = glow * glow;
                    vec3 finalColor = vColor * (1.0 + glow * 2.0);
                    float alpha = vAlpha * glow;
                    gl_FragColor = vec4(finalColor, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        this.sparkSystem = new THREE.Points(geometry, material);
        this.sparkSystem.frustumCulled = false;
        this.sparkSystem.renderOrder = 15;
        this.sparkSystem.userData.skipBloomCache = true;  // Exclude from bloom material caching
        geometry.setDrawRange(0, 0);
        this.scene.add(this.sparkSystem);
    }

    _emitSparkParticle(position, intensity) {
        const cfg = this.sparkConfig;
        const sparks = this.sparks;

        if (sparks.activeCount >= sparks.maxParticles) {
            this._recycleSparkParticle();
        }

        const idx = sparks.activeCount;
        const i3 = idx * 3;

        sparks.positions[i3] = position.x + (Math.random() - 0.5);
        sparks.positions[i3 + 1] = position.y + (Math.random() - 0.5);
        sparks.positions[i3 + 2] = position.z + (Math.random() - 0.5);

        const speed = cfg.velocityMin + Math.random() * (cfg.velocityMax - cfg.velocityMin);
        const vx = (Math.random() - 0.5);
        const vy = (Math.random() - 0.5);
        const vz = (Math.random() - 0.5);
        const vLen = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
        const scale = speed * (0.5 + intensity * 500) / vLen;

        sparks.velocities[i3] = vx * scale;
        sparks.velocities[i3 + 1] = vy * scale;
        sparks.velocities[i3 + 2] = vz * scale;

        sparks.ages[idx] = 0;
        sparks.lifetimes[idx] = cfg.lifetimeMin + Math.random() * (cfg.lifetimeMax - cfg.lifetimeMin);
        sparks.sizes[idx] = cfg.sizeMin + Math.random() * (cfg.sizeMax - cfg.sizeMin);

        const color = cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
        sparks.colors[i3] = color.r;
        sparks.colors[i3 + 1] = color.g;
        sparks.colors[i3 + 2] = color.b;

        sparks.activeCount++;
    }

    _updateSparks(deltaTime) {
        const sparks = this.sparks;
        if (sparks.activeCount === 0) return;

        const cfg = this.sparkConfig;
        const dt = deltaTime || 1/60;
        const dragFactor = Math.pow(cfg.drag, dt * 60);

        // No gravity - just drag and movement (simpler, faster)
        for (let i = sparks.activeCount - 1; i >= 0; i--) {
            sparks.ages[i] += dt;

            if (sparks.ages[i] >= sparks.lifetimes[i]) {
                this._removeSparkParticle(i);
                continue;
            }

            const i3 = i * 3;
            sparks.velocities[i3] *= dragFactor;
            sparks.velocities[i3 + 1] *= dragFactor;
            sparks.velocities[i3 + 2] *= dragFactor;
            sparks.positions[i3] += sparks.velocities[i3] * dt;
            sparks.positions[i3 + 1] += sparks.velocities[i3 + 1] * dt;
            sparks.positions[i3 + 2] += sparks.velocities[i3 + 2] * dt;
        }

        this._markSparkBuffersDirty();
        this.sparkSystem.geometry.setDrawRange(0, sparks.activeCount);
    }

    _removeSparkParticle(index) {
        const sparks = this.sparks;
        const lastIdx = sparks.activeCount - 1;

        if (index !== lastIdx) {
            const i3 = index * 3;
            const l3 = lastIdx * 3;
            sparks.positions[i3] = sparks.positions[l3];
            sparks.positions[i3 + 1] = sparks.positions[l3 + 1];
            sparks.positions[i3 + 2] = sparks.positions[l3 + 2];
            sparks.velocities[i3] = sparks.velocities[l3];
            sparks.velocities[i3 + 1] = sparks.velocities[l3 + 1];
            sparks.velocities[i3 + 2] = sparks.velocities[l3 + 2];
            sparks.colors[i3] = sparks.colors[l3];
            sparks.colors[i3 + 1] = sparks.colors[l3 + 1];
            sparks.colors[i3 + 2] = sparks.colors[l3 + 2];
            sparks.ages[index] = sparks.ages[lastIdx];
            sparks.lifetimes[index] = sparks.lifetimes[lastIdx];
            sparks.sizes[index] = sparks.sizes[lastIdx];
        }
        sparks.activeCount--;
    }

    _recycleSparkParticle() {
        let oldestIdx = 0;
        let oldestRatio = 0;
        for (let i = 0; i < this.sparks.activeCount; i++) {
            const ratio = this.sparks.ages[i] / this.sparks.lifetimes[i];
            if (ratio > oldestRatio) {
                oldestRatio = ratio;
                oldestIdx = i;
            }
        }
        this._removeSparkParticle(oldestIdx);
    }

    _markSparkBuffersDirty() {
        const geo = this.sparkSystem.geometry;
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aAge.needsUpdate = true;
        geo.attributes.aLifetime.needsUpdate = true;
        geo.attributes.aSize.needsUpdate = true;
        geo.attributes.aColor.needsUpdate = true;
    }

    // ========================
    // CLEANUP
    // ========================

    dispose() {
        if (this.dustSystem) {
            this.scene.remove(this.dustSystem);
            this.dustSystem.geometry.dispose();
            this.dustSystem.material.dispose();
        }
        if (this.sparkSystem) {
            this.scene.remove(this.sparkSystem);
            this.sparkSystem.geometry.dispose();
            this.sparkSystem.material.dispose();
        }
        this.tanks.clear();
        this.spatialGrid.clear();
        this.collisionCooldowns.clear();
    }
}
