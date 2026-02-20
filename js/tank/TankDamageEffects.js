/**
 * AdLands - Tank Damage Effects
 * Visual smoke and fire effects for damaged tanks
 *
 * - Gray smoke: 25-50% HP (damaged state)
 * - Black smoke + fire: <25% HP (critical state)
 * - Black smoke only: dead tanks (no fire)
 */

// Preallocated temp spheres for frustum culling (avoid per-frame clone())
const _dmgSmokeSphere = new THREE.Sphere();
const _dmgFireSphere = new THREE.Sphere();
// Preallocated vectors for emission (avoid per-particle GC pressure)
const _emitOffset = new THREE.Vector3();
const _emitNormal = new THREE.Vector3();

class TankDamageEffects {
    constructor(scene, sphereRadius) {
        this.scene = scene;
        this.sphereRadius = sphereRadius;

        // Track effects per tank
        this.tankEffects = new Map();  // tankId -> { smoke, fire }

        // Shared particle systems (pooled)
        this.smokeSystem = null;
        this.fireSystem = null;

        this._createSmokeSystem();
        this._createFireSystem();
    }

    // ========================
    // PUBLIC API
    // ========================

    /**
     * Set damage state for a tank
     * @param {string} tankId - Unique tank identifier
     * @param {THREE.Group} tankGroup - Tank's THREE.Group for positioning
     * @param {string} state - 'healthy', 'damaged', 'critical', 'dead'
     */
    setDamageState(tankId, tankGroup, state) {
        if (state !== 'healthy') {
            console.warn('[TankDmgFX] setDamageState:', tankId, state, 'group:', !!tankGroup);
        }

        let effects = this.tankEffects.get(tankId);

        if (!effects) {
            effects = { smoke: false, fire: false, tankGroup, opacity: 1.0 };
            this.tankEffects.set(tankId, effects);
        }

        effects.tankGroup = tankGroup;

        switch (state) {
            case 'healthy':
                effects.smoke = false;
                effects.fire = false;
                effects.opacity = 1.0;
                this._clearParticlesForTank(tankId);
                break;
            case 'damaged':
                effects.smoke = 'gray';
                effects.fire = false;
                break;
            case 'critical':
                effects.smoke = 'black';
                effects.fire = true;
                break;
            case 'dead':
                effects.smoke = 'black';
                effects.fire = false;
                break;
        }
    }

    /**
     * Remove all effects for a tank
     */
    removeTank(tankId) {
        this.tankEffects.delete(tankId);
    }

    /**
     * Immediately remove all active particles belonging to a tank
     */
    _clearParticlesForTank(tankId) {
        let removed = false;
        for (let i = this.smoke.activeCount - 1; i >= 0; i--) {
            if (this.smoke.tankIds[i] === tankId) {
                this._removeSmokeParticle(i);
                removed = true;
            }
        }
        if (removed) {
            this.smokeSystem.geometry.setDrawRange(0, this.smoke.activeCount);
            this._markSmokeBuffersDirty();
        }
    }

    /**
     * Set opacity for a tank's effects (for fading with dead tank)
     * @param {string} tankId - Unique tank identifier
     * @param {number} opacity - Opacity value 0-1
     */
    setOpacity(tankId, opacity) {
        const effects = this.tankEffects.get(tankId);
        if (effects) {
            effects.opacity = opacity;
        }
    }

    setLightingConfig(lightConfig) {
        // Update smoke shader uniforms for terminator-aware coloring
        if (this.smokeSystem && this.smokeSystem.material.uniforms) {
            const uniforms = this.smokeSystem.material.uniforms;
            const sunColor = lightConfig.sun.color;
            const fillColor = lightConfig.fill.color;

            uniforms.uSunDirection.value.copy(lightConfig.sun.direction);
            uniforms.uSunColor.value.set(sunColor.r, sunColor.g, sunColor.b);
            uniforms.uFillColor.value.set(fillColor.r, fillColor.g, fillColor.b);
        }
    }

    /**
     * Update all active effects (call each frame)
     */
    update(deltaTime, frustum = null, camera = null) {
        const dt = deltaTime || 1 / 60;

        // DEBUG: check how many tanks should emit
        if (!this._dbgFrame) this._dbgFrame = 0;
        if (++this._dbgFrame % 60 === 1) {
            let smokers = 0;
            for (const [, fx] of this.tankEffects) { if (fx.smoke) smokers++; }
            if (smokers > 0 || this.smoke.activeCount > 0) {
                console.error('[TankDmgFX] UPDATE: emitters=' + smokers +
                    ' smokeActive=' + this.smoke.activeCount +
                    ' fireActive=' + this.fire.activeCount +
                    ' smokeVisible=' + this.smokeSystem.visible +
                    ' drawRange=' + this.smokeSystem.geometry.drawRange.count);
            }
        }

        // 1. Emit particles for each active tank
        for (const [tankId, effects] of this.tankEffects) {
            if (effects.smoke) {
                this._emitSmoke(effects.tankGroup, effects.smoke, tankId, effects.opacity);
            }
            if (effects.fire) {
                this._emitFire(effects.tankGroup);
            }
        }

        // 2. Update particle systems (ages, positions, draw range)
        this._updateSmoke(dt);
        this._updateFire(dt);

        // 3. Frustum culling AFTER update so bounding spheres use current data
        if (frustum) {
            if (this.smokeSystem && this.smoke.activeCount > 0) {
                if (!this.smoke.boundingSphereValid) {
                    this.smokeSystem.geometry.computeBoundingSphere();
                    this.smoke.boundingSphereValid = true;
                }
                _dmgSmokeSphere.copy(this.smokeSystem.geometry.boundingSphere);
                _dmgSmokeSphere.applyMatrix4(this.smokeSystem.matrixWorld);
                _dmgSmokeSphere.radius += 10;
                this.smokeSystem.visible = frustum.intersectsSphere(_dmgSmokeSphere);
            } else if (this.smokeSystem) {
                // No active particles — keep visible so new emissions render immediately
                this.smokeSystem.visible = true;
            }

            if (this.fireSystem && this.fire.activeCount > 0) {
                if (!this.fire.boundingSphereValid) {
                    this.fireSystem.geometry.computeBoundingSphere();
                    this.fire.boundingSphereValid = true;
                }
                _dmgFireSphere.copy(this.fireSystem.geometry.boundingSphere);
                _dmgFireSphere.applyMatrix4(this.fireSystem.matrixWorld);
                _dmgFireSphere.radius += 10;
                this.fireSystem.visible = frustum.intersectsSphere(_dmgFireSphere);
            } else if (this.fireSystem) {
                this.fireSystem.visible = true;
            }
        }
    }

    // ========================
    // SMOKE SYSTEM
    // ========================

    _createSmokeSystem() {
        const maxParticles = 100;

        this.smoke = {
            maxParticles,
            activeCount: 0,
            positions: new Float32Array(maxParticles * 3),
            velocities: new Float32Array(maxParticles * 3),
            ages: new Float32Array(maxParticles),
            lifetimes: new Float32Array(maxParticles),
            colors: new Float32Array(maxParticles),  // 0 = gray, 1 = black
            sizes: new Float32Array(maxParticles),
            rotations: new Float32Array(maxParticles),
            rotationSpeeds: new Float32Array(maxParticles),
            opacities: new Float32Array(maxParticles),  // Tank fade opacity
            tankIds: new Array(maxParticles).fill(null),  // Track which tank owns each particle
            boundingSphereValid: false
        };

        // Create geometry
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.smoke.positions, 3));
        geometry.setAttribute('aAge', new THREE.BufferAttribute(this.smoke.ages, 1));
        geometry.setAttribute('aLifetime', new THREE.BufferAttribute(this.smoke.lifetimes, 1));
        geometry.setAttribute('aColor', new THREE.BufferAttribute(this.smoke.colors, 1));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.smoke.sizes, 1));
        geometry.setAttribute('aRotation', new THREE.BufferAttribute(this.smoke.rotations, 1));
        geometry.setAttribute('aOpacity', new THREE.BufferAttribute(this.smoke.opacities, 1));

        // Shader material for smoke
        const material = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
                uSunColor: { value: new THREE.Vector3(1.0, 0.95, 0.9) },
                uFillColor: { value: new THREE.Vector3(0.4, 0.5, 0.8) }
            },
            vertexShader: `
                attribute float aAge;
                attribute float aLifetime;
                attribute float aColor;
                attribute float aSize;
                attribute float aRotation;
                attribute float aOpacity;

                varying float vAlpha;
                varying float vBrightness;
                varying float vRotation;
                varying vec3 vWorldPosition;

                void main() {
                    float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);

                    vRotation = aRotation;
                    vWorldPosition = position;

                    // Smoke grows as it rises
                    float sizeFactor = 1.0 + lifeRatio * 2.0;

                    // Fade in then out (peak at 20%)
                    float fadeIn = smoothstep(0.0, 0.2, lifeRatio);
                    float fadeOut = 1.0 - smoothstep(0.5, 1.0, lifeRatio);
                    vAlpha = fadeIn * fadeOut * 0.6 * aOpacity;

                    // Gray (0) or black (1) smoke - pass brightness to fragment
                    vBrightness = mix(0.5, 0.05, aColor);

                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = aSize * sizeFactor * (300.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                varying float vBrightness;
                varying float vRotation;
                varying vec3 vWorldPosition;

                uniform vec3 uSunDirection;
                uniform vec3 uSunColor;
                uniform vec3 uFillColor;

                void main() {
                    // Rotate UV coordinates
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float c = cos(vRotation);
                    float s = sin(vRotation);
                    vec2 rotatedCoord = vec2(
                        coord.x * c - coord.y * s,
                        coord.x * s + coord.y * c
                    );

                    // Square PS1-style particles (rotated)
                    if (abs(rotatedCoord.x) > 0.45 || abs(rotatedCoord.y) > 0.45) discard;

                    // Terminator-aware coloring: sun-tinted on day side, darker blue-tinted on night side
                    vec3 surfaceNormal = normalize(vWorldPosition);
                    float sunFacing = dot(surfaceNormal, uSunDirection);
                    float dayFactor = smoothstep(-0.2, 0.3, sunFacing);

                    // Base smoke color from brightness
                    vec3 baseColor = vec3(vBrightness);

                    // Day side: neutral/warm tint, Night side: blue fill light tint
                    vec3 dayColor = baseColor * mix(vec3(1.17), uSunColor, 0.15);
                    vec3 nightColor = baseColor * uFillColor * vec3(0.88, 0.94, 1.22);

                    vec3 smokeColor = mix(nightColor, dayColor, dayFactor);

                    // Soft smoky edge from center
                    float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
                    float alpha = vAlpha * (1.0 - dist * 1.8);
                    gl_FragColor = vec4(smokeColor, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.NormalBlending
        });

        this.smokeSystem = new THREE.Points(geometry, material);
        this.smokeSystem.frustumCulled = false;
        this.smokeSystem.renderOrder = 16;  // Smoke renders after fire to occlude it
        this.smokeSystem.userData.skipBloomCache = true;  // Exclude from bloom material caching
        geometry.setDrawRange(0, 0);

        this.scene.add(this.smokeSystem);
    }

    _emitSmoke(tankGroup, smokeType, tankId, tankOpacity) {
        // Don't emit new particles if tank is mostly faded
        if (tankOpacity < 0.3) return;

        // Safety: skip if tankGroup is missing or invalid
        if (!tankGroup || !tankGroup.matrixWorld) return;

        // Emit 2-3 particles per frame when active
        const emitCount = 2 + (Math.random() < 0.5 ? 1 : 0);

        for (let i = 0; i < emitCount; i++) {
            if (this.smoke.activeCount >= this.smoke.maxParticles) {
                this._recycleSmokeParticle();
            }

            const idx = this.smoke.activeCount;
            const i3 = idx * 3;

            // Get tank world position (rear engine area)
            tankGroup.updateMatrixWorld();
            _emitOffset.set(
                (Math.random() - 0.5) * 1.5,  // Spread across rear
                1.0 + Math.random() * 0.5,    // Above hull
                2.0 + Math.random() * 0.5     // Rear of tank
            );
            _emitOffset.applyMatrix4(tankGroup.matrixWorld);

            // Debug: log first particle per tank to verify positions
            if (i === 0 && !this._debugLoggedTanks) this._debugLoggedTanks = new Set();
            if (i === 0 && !this._debugLoggedTanks.has(tankId)) {
                this._debugLoggedTanks.add(tankId);
                const dist = Math.sqrt(_emitOffset.x * _emitOffset.x + _emitOffset.y * _emitOffset.y + _emitOffset.z * _emitOffset.z);
                console.warn('[TankDmgFX] _emitSmoke:', tankId, 'pos:', _emitOffset.x.toFixed(1), _emitOffset.y.toFixed(1), _emitOffset.z.toFixed(1),
                    'dist:', dist.toFixed(1), 'activeCount:', this.smoke.activeCount,
                    'visible:', this.smokeSystem.visible, 'drawRange:', this.smokeSystem.geometry.drawRange.count);
            }

            this.smoke.positions[i3] = _emitOffset.x;
            this.smoke.positions[i3 + 1] = _emitOffset.y;
            this.smoke.positions[i3 + 2] = _emitOffset.z;

            // Upward velocity (in world space, from surface normal)
            _emitNormal.copy(_emitOffset).normalize();
            const speed = 0.8 + Math.random() * 0.4;

            this.smoke.velocities[i3] = _emitNormal.x * speed + (Math.random() - 0.5) * 0.2;
            this.smoke.velocities[i3 + 1] = _emitNormal.y * speed + (Math.random() - 0.5) * 0.2;
            this.smoke.velocities[i3 + 2] = _emitNormal.z * speed + (Math.random() - 0.5) * 0.2;

            this.smoke.ages[idx] = 0;
            this.smoke.lifetimes[idx] = 1.5 + Math.random() * 1.0;  // 1.5-2.5 seconds
            this.smoke.colors[idx] = smokeType === 'black' ? 1.0 : 0.0;
            this.smoke.sizes[idx] = 3.0 + Math.random() * 2.0;
            this.smoke.rotations[idx] = Math.random() * Math.PI * 2;
            this.smoke.rotationSpeeds[idx] = (Math.random() - 0.5) * 2.0;  // -1 to +1 radians/sec
            this.smoke.opacities[idx] = tankOpacity;  // Initial opacity from tank
            this.smoke.tankIds[idx] = tankId;  // Track which tank owns this particle

            this.smoke.activeCount++;
        }

        // Ensure draw range and visibility are immediately correct
        this.smokeSystem.geometry.setDrawRange(0, this.smoke.activeCount);
        this.smokeSystem.visible = true;
        this.smoke.boundingSphereValid = false;
        this._markSmokeBuffersDirty();
    }

    _updateSmoke(dt) {
        if (this.smoke.activeCount === 0) return;

        for (let i = 0; i < this.smoke.activeCount; i++) {
            this.smoke.ages[i] += dt;

            if (this.smoke.ages[i] >= this.smoke.lifetimes[i]) {
                this._removeSmokeParticle(i);
                i--;
                continue;
            }

            // Update rotation
            this.smoke.rotations[i] += this.smoke.rotationSpeeds[i] * dt;

            const i3 = i * 3;

            // Slow down over time (drag) - frame-rate independent
            const dragFactor = Math.pow(0.98, dt * 60);
            this.smoke.velocities[i3] *= dragFactor;
            this.smoke.velocities[i3 + 1] *= dragFactor;
            this.smoke.velocities[i3 + 2] *= dragFactor;

            // Update position
            this.smoke.positions[i3] += this.smoke.velocities[i3] * dt;
            this.smoke.positions[i3 + 1] += this.smoke.velocities[i3 + 1] * dt;
            this.smoke.positions[i3 + 2] += this.smoke.velocities[i3 + 2] * dt;
        }

        this._markSmokeBuffersDirty();
        this.smokeSystem.geometry.setDrawRange(0, this.smoke.activeCount);
    }

    _removeSmokeParticle(index) {
        const lastIdx = this.smoke.activeCount - 1;

        if (index !== lastIdx) {
            const i3 = index * 3;
            const l3 = lastIdx * 3;

            this.smoke.positions[i3] = this.smoke.positions[l3];
            this.smoke.positions[i3 + 1] = this.smoke.positions[l3 + 1];
            this.smoke.positions[i3 + 2] = this.smoke.positions[l3 + 2];

            this.smoke.velocities[i3] = this.smoke.velocities[l3];
            this.smoke.velocities[i3 + 1] = this.smoke.velocities[l3 + 1];
            this.smoke.velocities[i3 + 2] = this.smoke.velocities[l3 + 2];

            this.smoke.ages[index] = this.smoke.ages[lastIdx];
            this.smoke.lifetimes[index] = this.smoke.lifetimes[lastIdx];
            this.smoke.colors[index] = this.smoke.colors[lastIdx];
            this.smoke.sizes[index] = this.smoke.sizes[lastIdx];
            this.smoke.rotations[index] = this.smoke.rotations[lastIdx];
            this.smoke.rotationSpeeds[index] = this.smoke.rotationSpeeds[lastIdx];
            this.smoke.opacities[index] = this.smoke.opacities[lastIdx];
            this.smoke.tankIds[index] = this.smoke.tankIds[lastIdx];
        }

        this.smoke.activeCount--;
    }

    _recycleSmokeParticle() {
        let oldestIdx = 0;
        let oldestRatio = 0;

        for (let i = 0; i < this.smoke.activeCount; i++) {
            const ratio = this.smoke.ages[i] / this.smoke.lifetimes[i];
            if (ratio > oldestRatio) {
                oldestRatio = ratio;
                oldestIdx = i;
            }
        }

        this._removeSmokeParticle(oldestIdx);
    }

    _markSmokeBuffersDirty() {
        const geo = this.smokeSystem.geometry;
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aAge.needsUpdate = true;
        geo.attributes.aLifetime.needsUpdate = true;
        geo.attributes.aRotation.needsUpdate = true;
        geo.attributes.aColor.needsUpdate = true;
        geo.attributes.aSize.needsUpdate = true;
        geo.attributes.aOpacity.needsUpdate = true;
        this.smoke.boundingSphereValid = false;
    }

    // ========================
    // FIRE SYSTEM
    // ========================

    _createFireSystem() {
        const maxParticles = 25;

        this.fire = {
            maxParticles,
            activeCount: 0,
            positions: new Float32Array(maxParticles * 3),
            velocities: new Float32Array(maxParticles * 3),
            ages: new Float32Array(maxParticles),
            lifetimes: new Float32Array(maxParticles),
            sizes: new Float32Array(maxParticles),
            rotations: new Float32Array(maxParticles),
            rotationSpeeds: new Float32Array(maxParticles),
            boundingSphereValid: false
        };

        // Create geometry
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.fire.positions, 3));
        geometry.setAttribute('aAge', new THREE.BufferAttribute(this.fire.ages, 1));
        geometry.setAttribute('aLifetime', new THREE.BufferAttribute(this.fire.lifetimes, 1));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.fire.sizes, 1));
        geometry.setAttribute('aRotation', new THREE.BufferAttribute(this.fire.rotations, 1));

        // Shader material for fire
        const material = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 }
            },
            vertexShader: `
                attribute float aAge;
                attribute float aLifetime;
                attribute float aSize;
                attribute float aRotation;

                varying float vAlpha;
                varying vec3 vColor;
                varying float vLifeRatio;
                varying float vRotation;

                void main() {
                    float lifeRatio = clamp(aAge / max(aLifetime, 0.01), 0.0, 1.0);
                    vLifeRatio = lifeRatio;
                    vRotation = aRotation;

                    // Fire shrinks as it rises
                    float sizeFactor = 1.0 - lifeRatio * 0.6;

                    // Fast fade
                    vAlpha = (1.0 - lifeRatio) * 0.85;

                    // Darker flame colors to reduce bloom washout
                    // Yellow-orange core -> orange -> red-brown -> dark
                    if (lifeRatio < 0.3) {
                        vColor = mix(vec3(0.7, 0.5, 0.15), vec3(0.65, 0.35, 0.08), lifeRatio / 0.3);
                    } else if (lifeRatio < 0.6) {
                        vColor = mix(vec3(0.65, 0.35, 0.08), vec3(0.5, 0.15, 0.03), (lifeRatio - 0.3) / 0.3);
                    } else {
                        vColor = mix(vec3(0.5, 0.15, 0.03), vec3(0.2, 0.06, 0.02), (lifeRatio - 0.6) / 0.4);
                    }

                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = aSize * sizeFactor * (300.0 / -mvPosition.z);
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                varying vec3 vColor;
                varying float vLifeRatio;
                varying float vRotation;

                void main() {
                    // Rotate UV coordinates
                    vec2 coord = gl_PointCoord - vec2(0.5);
                    float c = cos(vRotation);
                    float s = sin(vRotation);
                    vec2 rotatedCoord = vec2(
                        coord.x * c - coord.y * s,
                        coord.x * s + coord.y * c
                    );

                    // Square PS1-style particles (rotated)
                    if (abs(rotatedCoord.x) > 0.45 || abs(rotatedCoord.y) > 0.45) discard;

                    // Bright center, soft edge from center
                    float dist = max(abs(rotatedCoord.x), abs(rotatedCoord.y));
                    float alpha = vAlpha * (1.0 - dist * 1.5);

                    // Keep flame color visible (no HDR boost)
                    vec3 color = vColor * 0.9;

                    gl_FragColor = vec4(color, alpha);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        this.fireSystem = new THREE.Points(geometry, material);
        this.fireSystem.frustumCulled = false;
        this.fireSystem.renderOrder = 15;  // Fire renders before smoke so smoke can occlude it
        // Fire particles don't bloom (performance optimization per user request)
        // this.fireSystem.layers.set(1);  // Disabled - fire stays on default layer
        geometry.setDrawRange(0, 0);

        this.scene.add(this.fireSystem);
    }

    _emitFire(tankGroup) {
        // Safety: skip if tankGroup is missing or invalid
        if (!tankGroup || !tankGroup.matrixWorld) return;

        // Emit 3-5 particles per frame when active
        const emitCount = 3 + Math.floor(Math.random() * 3);

        for (let i = 0; i < emitCount; i++) {
            if (this.fire.activeCount >= this.fire.maxParticles) {
                this._recycleFireParticle();
            }

            const idx = this.fire.activeCount;
            const i3 = idx * 3;

            // Get tank world position (engine area, slightly lower than smoke)
            tankGroup.updateMatrixWorld();
            _emitOffset.set(
                (Math.random() - 0.5) * 1.0,  // Narrower spread
                0.8 + Math.random() * 0.3,    // Slightly lower
                1.8 + Math.random() * 0.4     // Rear of tank
            );
            _emitOffset.applyMatrix4(tankGroup.matrixWorld);

            this.fire.positions[i3] = _emitOffset.x;
            this.fire.positions[i3 + 1] = _emitOffset.y;
            this.fire.positions[i3 + 2] = _emitOffset.z;

            // Upward velocity with flickering motion
            _emitNormal.copy(_emitOffset).normalize();
            const speed = 1.5 + Math.random() * 1.0;

            this.fire.velocities[i3] = _emitNormal.x * speed + (Math.random() - 0.5) * 0.8;
            this.fire.velocities[i3 + 1] = _emitNormal.y * speed + (Math.random() - 0.5) * 0.8;
            this.fire.velocities[i3 + 2] = _emitNormal.z * speed + (Math.random() - 0.5) * 0.8;

            this.fire.ages[idx] = 0;
            this.fire.lifetimes[idx] = 0.3 + Math.random() * 0.4;  // 0.3-0.7 seconds (shorter than smoke)
            this.fire.sizes[idx] = 2.0 + Math.random() * 1.5;
            this.fire.rotations[idx] = Math.random() * Math.PI * 2;
            this.fire.rotationSpeeds[idx] = (Math.random() - 0.5) * 6.0;  // -3 to +3 radians/sec (faster for fire)

            this.fire.activeCount++;
        }

        // Ensure draw range and visibility are immediately correct
        this.fireSystem.geometry.setDrawRange(0, this.fire.activeCount);
        this.fireSystem.visible = true;
        this.fire.boundingSphereValid = false;
        this._markFireBuffersDirty();
    }

    _updateFire(dt) {
        if (this.fire.activeCount === 0) return;

        for (let i = 0; i < this.fire.activeCount; i++) {
            this.fire.ages[i] += dt;

            if (this.fire.ages[i] >= this.fire.lifetimes[i]) {
                this._removeFireParticle(i);
                i--;
                continue;
            }

            // Update rotation
            this.fire.rotations[i] += this.fire.rotationSpeeds[i] * dt;

            const i3 = i * 3;

            // Fire rises faster, less drag - frame-rate independent
            const dragFactor = Math.pow(0.95, dt * 60);
            this.fire.velocities[i3] *= dragFactor;
            this.fire.velocities[i3 + 1] *= dragFactor;
            this.fire.velocities[i3 + 2] *= dragFactor;

            // Add some flickering turbulence - scaled by dt
            const turbulence = 0.3 * dt * 60;
            this.fire.velocities[i3] += (Math.random() - 0.5) * turbulence;
            this.fire.velocities[i3 + 1] += (Math.random() - 0.5) * turbulence;
            this.fire.velocities[i3 + 2] += (Math.random() - 0.5) * turbulence;

            // Update position
            this.fire.positions[i3] += this.fire.velocities[i3] * dt;
            this.fire.positions[i3 + 1] += this.fire.velocities[i3 + 1] * dt;
            this.fire.positions[i3 + 2] += this.fire.velocities[i3 + 2] * dt;
        }

        this._markFireBuffersDirty();
        this.fireSystem.geometry.setDrawRange(0, this.fire.activeCount);
    }

    _removeFireParticle(index) {
        const lastIdx = this.fire.activeCount - 1;

        if (index !== lastIdx) {
            const i3 = index * 3;
            const l3 = lastIdx * 3;

            this.fire.positions[i3] = this.fire.positions[l3];
            this.fire.positions[i3 + 1] = this.fire.positions[l3 + 1];
            this.fire.positions[i3 + 2] = this.fire.positions[l3 + 2];

            this.fire.velocities[i3] = this.fire.velocities[l3];
            this.fire.velocities[i3 + 1] = this.fire.velocities[l3 + 1];
            this.fire.velocities[i3 + 2] = this.fire.velocities[l3 + 2];

            this.fire.ages[index] = this.fire.ages[lastIdx];
            this.fire.lifetimes[index] = this.fire.lifetimes[lastIdx];
            this.fire.sizes[index] = this.fire.sizes[lastIdx];
            this.fire.rotations[index] = this.fire.rotations[lastIdx];
            this.fire.rotationSpeeds[index] = this.fire.rotationSpeeds[lastIdx];
        }

        this.fire.activeCount--;
    }

    _recycleFireParticle() {
        let oldestIdx = 0;
        let oldestRatio = 0;

        for (let i = 0; i < this.fire.activeCount; i++) {
            const ratio = this.fire.ages[i] / this.fire.lifetimes[i];
            if (ratio > oldestRatio) {
                oldestRatio = ratio;
                oldestIdx = i;
            }
        }

        this._removeFireParticle(oldestIdx);
    }

    _markFireBuffersDirty() {
        const geo = this.fireSystem.geometry;
        geo.attributes.position.needsUpdate = true;
        geo.attributes.aAge.needsUpdate = true;
        geo.attributes.aLifetime.needsUpdate = true;
        geo.attributes.aSize.needsUpdate = true;
        geo.attributes.aRotation.needsUpdate = true;
        this.fire.boundingSphereValid = false;
    }

    // ========================
    // CLEANUP
    // ========================

    dispose() {
        if (this.smokeSystem) {
            this.scene.remove(this.smokeSystem);
            this.smokeSystem.geometry.dispose();
            this.smokeSystem.material.dispose();
        }

        if (this.fireSystem) {
            this.scene.remove(this.fireSystem);
            this.fireSystem.geometry.dispose();
            this.fireSystem.material.dispose();
        }

        this.tankEffects.clear();
    }
}
