/**
 * AdLands - Commander Bodyguards
 * Two AI-controlled bodyguard bots that protect the commander
 * Defense-only: follow, engage threats, respawn with commander
 */

const BODYGUARD_STATES = {
    FOLLOWING: 'following',
    ENGAGING: 'engaging',
    RETURNING: 'returning'
};

const BODYGUARD_CONFIG = {
    count: 2,
    followDistance: 0.04,           // Angular distance from commander (in radians)
    maxLeashDistance: 0.08,         // Max distance from commander before returning
    respawnDelay: 5000,             // ms after commander respawns
    formationAngle: Math.PI / 3,    // 60 degrees offset from commander heading
    names: ['Guard Alpha', 'Guard Beta'],

    // GTA1-style vehicle physics (same as botTanks)
    maxSpeed: 0.00024,              // Slightly faster than regular bots
    acceleration: 0.000028,         // Snappy response
    deceleration: 0.000018,         // Responsive braking
    baseTurnRate: 0.038,            // Turn rate when slow
    minTurnRate: 0.01,              // Turn rate at max speed
    turnSpeedFactor: 0.7,           // How much speed affects turning
    pivotOffset: 0.6,               // Rear-pivot feel

    // Collision avoidance
    avoidDistance: 0.06,            // Angular distance to start avoiding
    avoidAngle: Math.PI / 3,        // Cone angle for forward sensing
    avoidStrength: 0.8              // How strongly to steer away
};

// Preallocated temp vectors for per-frame orientation updates (avoid GC pressure)
const _bgUp = new THREE.Vector3();
const _bgEast = new THREE.Vector3();
const _bgNorth = new THREE.Vector3();
const _bgForward = new THREE.Vector3();
const _bgRight = new THREE.Vector3();
const _bgTarget = new THREE.Vector3();
const _bgWorldUp = new THREE.Vector3(0, 1, 0);
const _bgZAxis = new THREE.Vector3(0, 0, 1);
const _bgRotMatrix = new THREE.Matrix4();
const _bgRollQuat = new THREE.Quaternion();
const _bgPitchAxis = new THREE.Vector3(1, 0, 0);
const _bgPitchQuat = new THREE.Quaternion();
const _bgSteerQuat = new THREE.Quaternion();

class CommanderBodyguards {
    constructor(scene, sphereRadius, planet) {
        this.scene = scene;
        this.sphereRadius = sphereRadius;
        this.planet = planet;

        // External system references
        this.cannonSystem = null;
        this.treadDust = null;
        this.tankCollision = null;
        this.dustShockwave = null;
        this.playerTags = null;
        this.tankDamageEffects = null;
        this.tankHeadlights = null;

        // Callbacks for external systems
        this.onGuardDamageStateChange = null;
        this.onGuardFadeUpdate = null;

        // Commander reference
        this.commander = null;          // { playerId, tankRef, faction }
        this.commanderFaction = null;

        // Bodyguard bots
        this.guards = [];               // Array of bodyguard objects
        this.guardStates = new Map();   // guardId -> BODYGUARD_STATES
        this.dyingGuards = [];          // Guards that are fading out after despawn

        // Shared geometry and materials (will be created on spawn)
        this._sharedGeom = null;
        this._materials = {};  // Cached per faction

        // Track if bodyguards are active
        this.active = false;

    }

    // ========================
    // DEPENDENCY INJECTION
    // ========================

    setCannonSystem(cannonSystem) {
        this.cannonSystem = cannonSystem;
    }

    setTreadDust(treadDust) {
        this.treadDust = treadDust;
    }

    setTankCollision(tankCollision) {
        this.tankCollision = tankCollision;
    }

    setDustShockwave(dustShockwave) {
        this.dustShockwave = dustShockwave;
    }

    setPlayerTags(playerTags) {
        this.playerTags = playerTags;
    }

    setTankDamageEffects(tankDamageEffects) {
        this.tankDamageEffects = tankDamageEffects;
    }

    setTankHeadlights(tankHeadlights) {
        this.tankHeadlights = tankHeadlights;
    }

    // ========================
    // LIFECYCLE
    // ========================

    /**
     * Spawn bodyguards for a commander
     */
    spawn(commander, faction) {
        if (this.active) {
            this.despawn();
        }

        // Clean up any dying guards from previous spawn (immediate removal)
        this._cleanupDyingGuards();

        this.commander = commander;
        this.commanderFaction = faction;
        this.active = true;

        // Create shared geometry and materials if not already done
        if (!this._sharedGeom) {
            this._createSharedAssets();
        }

        // Create materials for this faction
        this._createFactionMaterials(faction);

        // Spawn 2 bodyguards
        for (let i = 0; i < BODYGUARD_CONFIG.count; i++) {
            const side = i === 0 ? 'left' : 'right';
            const guard = this._createBodyguard(i, side);
            this.guards.push(guard);
            this.guardStates.set(i, BODYGUARD_STATES.FOLLOWING);

            // Register with treadDust for dust particle emission
            if (this.treadDust) {
                this.treadDust.registerTank(`bodyguard-${i}`, guard.group, guard.state);
            }

            // Register with tankHeadlights for night-time headlight cones
            if (this.tankHeadlights) {
                this.tankHeadlights.registerTank(`bodyguard-${i}`, guard.group, faction, guard);
            }

            // Register with playerTags for HP bar display
            // Remove any existing tag first (in case previous guards are still fading)
            if (this.playerTags) {
                this.playerTags.removeTag(`bodyguard-${i}`);
                this.playerTags.createTag(`bodyguard-${i}`, guard, {
                    name: guard.name,
                    level: 1,
                    avatar: null,
                    squad: null,
                    faction: faction
                });
            }

            // Spawn shockwave effect at bodyguard position
            this._spawnShockwaveAt(guard);
        }

    }

    /**
     * Despawn all bodyguards (with explosion effect when losing commander status)
     * @param {boolean} withExplosion - Whether to show death sequence (explosion + fade) instead of immediate removal
     */
    despawn(withExplosion = true) {
        // Store guards to process before clearing
        const guardsToProcess = [...this.guards];
        const guardCount = guardsToProcess.length;

        // Save faction before clearing (needed for explosion colors)
        const savedFaction = this.commanderFaction;

        // Clear state immediately to prevent double-despawn
        this.guards = [];
        this.guardStates.clear();
        this.commander = null;
        this.commanderFaction = null;
        this.active = false;

        // Defer expensive operations to next frame to prevent lag spike
        requestAnimationFrame(() => {
            guardsToProcess.forEach((guard, index) => {
                if (withExplosion && !guard.isDead) {
                    // Trigger death sequence - explosion + fade out like regular tanks
                    // Note: _triggerDeathSequence handles treadDust unregistration
                    try {
                        this._triggerDeathSequence(guard, savedFaction);
                        // Move to dying guards list so they continue to fade
                        this.dyingGuards.push(guard);
                    } catch (error) {
                        console.error(`[CommanderBodyguards] Error in death sequence for ${guard.name}:`, error);
                    }
                } else {
                    // Unregister from treadDust (only needed for immediate removal)
                    if (this.treadDust) {
                        this.treadDust.unregisterTank(`bodyguard-${index}`);
                    }
                    if (this.tankHeadlights) {
                        this.tankHeadlights.unregisterTank(`bodyguard-${index}`);
                    }
                    // Immediate removal (cleanup or already dead)
                    if (guard.group && guard.group.parent) {
                        guard.group.parent.remove(guard.group);
                    }
                    // Remove player tag immediately
                    if (this.playerTags) {
                        this.playerTags.removeTag(`bodyguard-${index}`);
                    }
                }
            });
        });

    }

    /**
     * Trigger death sequence for a guard (matches botTanks._onBotDeath)
     * Full sequence: explosion, oil puddle, charred material, smoke, 3-phase fade
     * @param {Object} guard - The guard object
     * @param {string} faction - Faction for explosion color (optional, uses this.commanderFaction if not provided)
     */
    _triggerDeathSequence(guard, faction = null) {
        if (guard.isDead) return;

        const explosionFaction = faction || this.commanderFaction;

        // Mark as dead
        guard.isDead = true;
        guard.state.isDead = true;
        guard.damageState = 'dead';

        // Notify damage effects system (black smoke only, no fire)
        if (this.onGuardDamageStateChange) {
            this.onGuardDamageStateChange(guard, 'dead');
        } else {
            console.warn(`[CommanderBodyguards] onGuardDamageStateChange callback not set!`);
        }

        // Fade out player tag over 3 seconds (matches bot behavior)
        if (this.playerTags) {
            this.playerTags.fadeOutTag(`bodyguard-${guard.index}`, 3000);
        }

        // Spawn explosion effect
        this._spawnExplosionAt(guard, explosionFaction);

        // Spawn oil puddle
        if (this.cannonSystem) {
            const worldPos = this._getGuardWorldPosition(guard);
            this.cannonSystem.spawnOilPuddle(worldPos);
        } else {
            console.warn(`[CommanderBodyguards] cannonSystem not set!`);
        }

        // Set charred material (dark gray)
        this._setGuardDeadMaterial(guard);

        // Unregister from treadDust (dead tanks don't emit dust)
        if (this.treadDust) {
            this.treadDust.unregisterTank(`bodyguard-${guard.index}`);
        } else {
            console.warn(`[CommanderBodyguards] treadDust not set!`);
        }
        if (this.tankHeadlights) {
            this.tankHeadlights.unregisterTank(`bodyguard-${guard.index}`);
        }

        // Start 3-phase fade
        this._startDeathFade(guard);

    }

    /**
     * Called when commander dies - kills all bodyguards with full death sequence
     */
    onCommanderDeath() {
        if (!this.active) return;

        // Kill all bodyguards with full death sequence
        this.guards.forEach((guard) => {
            if (!guard.isDead) {
                this._triggerDeathSequence(guard);
            }
        });

    }

    /**
     * Called when commander respawns — bodyguards stay dead (no respawn)
     */
    onCommanderRespawn() {
        // Bodyguards do not respawn; new ones are only created
        // when a player freshly gains commander status via spawn()
    }

    // ========================
    // BODYGUARD CREATION
    // ========================

    _createSharedAssets() {
        this._sharedGeom = {
            hull: new THREE.BoxGeometry(2.5, 0.8, 5),
            frontSlope: new THREE.BoxGeometry(2.2, 0.5, 1.0),
            rear: new THREE.BoxGeometry(2.2, 1.0, 0.8),
            track: new THREE.BoxGeometry(0.6, 0.6, 5.2),
            turret: new THREE.BoxGeometry(1.5, 0.6, 1.8),
            barrel: new THREE.CylinderGeometry(0.15, 0.2, 2.5, 8),
            muzzle: new THREE.BoxGeometry(0.4, 0.3, 0.3),
            hitbox: new THREE.BoxGeometry(3, 1.5, 5.5),
            // Accent trim geometries (cached to avoid creating per bodyguard)
            frontAccent: new THREE.BoxGeometry(2.7, 0.15, 0.2),
            rearAccent: new THREE.BoxGeometry(2.7, 0.15, 0.2),
            trackAccent: new THREE.BoxGeometry(0.12, 0.7, 5.4),
            sideAccent: new THREE.BoxGeometry(0.1, 0.12, 4.8),
            turretRing: new THREE.TorusGeometry(0.85, 0.1, 8, 16),
            barrelTipRing: new THREE.TorusGeometry(0.2, 0.06, 8, 12),
            midBarrelRing: new THREE.TorusGeometry(0.18, 0.05, 8, 12)
        };
    }

    _createFactionMaterials(faction) {
        // Skip if already created for this faction (materials are cached and reused)
        if (this._materials[faction]) return;

        // Black base with faction-colored accents for elite bodyguard look
        const factionData = FACTION_COLORS[faction];
        if (!factionData) return;

        // Faction accent color (full saturation for visibility on black)
        const accentColor = new THREE.Color(factionData.vehicle.primary);

        this._materials[faction] = {
            // Black hull
            hull: new THREE.MeshStandardMaterial({
                color: 0x0a0a0a,
                roughness: 0.4,
                metalness: 0.6,
                flatShading: true
            }),
            // Black turret
            turret: new THREE.MeshStandardMaterial({
                color: 0x0f0f0f,
                roughness: 0.3,
                metalness: 0.7,
                flatShading: true
            }),
            // Dark tracks
            track: new THREE.MeshStandardMaterial({
                color: 0x1a1a1a,
                roughness: 0.9,
                metalness: 0.2,
                flatShading: true
            }),
            // Dark barrel
            barrel: new THREE.MeshStandardMaterial({
                color: 0x151515,
                roughness: 0.4,
                metalness: 0.7,
                flatShading: true
            }),
            // Faction-colored accent material (for trim pieces)
            // High emissive for strong visibility on black tank
            accent: new THREE.MeshStandardMaterial({
                color: accentColor,
                roughness: 0.2,
                metalness: 0.9,
                emissive: accentColor,
                emissiveIntensity: 0.6,
                flatShading: true
            })
        };
    }

    _createBodyguard(index, side) {
        const mat = this._materials[this.commanderFaction];
        const geom = this._sharedGeom;
        const group = new THREE.Group();

        // Body group — lean/wiggle applied here, not on outer group
        const bodyGroup = new THREE.Group();
        group.add(bodyGroup);

        // Hull
        const hull = new THREE.Mesh(geom.hull, mat.hull);
        hull.position.y = 0.4;
        hull.castShadow = true;
        hull.receiveShadow = true;
        bodyGroup.add(hull);

        // Front slope
        const frontSlope = new THREE.Mesh(geom.frontSlope, mat.hull);
        frontSlope.position.set(0, 0.7, -2.5);
        frontSlope.rotation.x = 0.3;
        frontSlope.castShadow = true;
        frontSlope.receiveShadow = true;
        bodyGroup.add(frontSlope);

        // Rear
        const rear = new THREE.Mesh(geom.rear, mat.hull);
        rear.position.set(0, 0.5, 2.6);
        rear.castShadow = true;
        rear.receiveShadow = true;
        bodyGroup.add(rear);

        // Tracks
        const leftTrack = new THREE.Mesh(geom.track, mat.track);
        leftTrack.position.set(-1.3, 0.3, 0);
        leftTrack.castShadow = true;
        leftTrack.receiveShadow = true;
        bodyGroup.add(leftTrack);

        const rightTrack = new THREE.Mesh(geom.track, mat.track);
        rightTrack.position.set(1.3, 0.3, 0);
        rightTrack.castShadow = true;
        rightTrack.receiveShadow = true;
        bodyGroup.add(rightTrack);

        // ========================
        // FACTION ACCENT TRIM (prominent stripes) - use shared geometries
        // ========================

        // Hull front accent stripe (wider, taller)
        const frontAccent = new THREE.Mesh(geom.frontAccent, mat.accent);
        frontAccent.position.set(0, 0.85, -2.55);
        bodyGroup.add(frontAccent);

        // Hull rear accent stripe (wider, taller)
        const rearAccent = new THREE.Mesh(geom.rearAccent, mat.accent);
        rearAccent.position.set(0, 0.85, 2.55);
        bodyGroup.add(rearAccent);

        // Left track accent stripe (thicker)
        const leftTrackAccent = new THREE.Mesh(geom.trackAccent, mat.accent);
        leftTrackAccent.position.set(-1.66, 0.35, 0);
        bodyGroup.add(leftTrackAccent);

        // Right track accent stripe (thicker)
        const rightTrackAccent = new THREE.Mesh(geom.trackAccent, mat.accent);
        rightTrackAccent.position.set(1.66, 0.35, 0);
        bodyGroup.add(rightTrackAccent);

        // Hull side accent stripes (new - run along hull length)
        const leftSideAccent = new THREE.Mesh(geom.sideAccent, mat.accent);
        leftSideAccent.position.set(-1.28, 0.85, 0);
        bodyGroup.add(leftSideAccent);

        const rightSideAccent = new THREE.Mesh(geom.sideAccent, mat.accent);
        rightSideAccent.position.set(1.28, 0.85, 0);
        bodyGroup.add(rightSideAccent);

        // Turret group
        const turretGroup = new THREE.Group();
        turretGroup.position.y = 0.8;

        const turret = new THREE.Mesh(geom.turret, mat.turret);
        turret.position.y = 0.3;
        turret.castShadow = true;
        turret.receiveShadow = true;
        turretGroup.add(turret);

        // Turret accent ring (thicker, more visible)
        const turretRing = new THREE.Mesh(geom.turretRing, mat.accent);
        turretRing.rotation.x = Math.PI / 2;
        turretRing.position.set(0, 0.02, 0);
        turretRing.castShadow = false; // Decorative element - no shadows
        turretRing.receiveShadow = false;
        turretGroup.add(turretRing);

        // Barrel
        const barrelMesh = new THREE.Mesh(geom.barrel, mat.barrel);
        barrelMesh.rotation.x = -Math.PI / 2;
        barrelMesh.position.set(0, 0.4, -2.0);
        barrelMesh.castShadow = true;
        barrelMesh.receiveShadow = true;
        turretGroup.add(barrelMesh);

        // Muzzle brake
        const muzzle = new THREE.Mesh(geom.muzzle, mat.barrel);
        muzzle.position.set(0, 0.4, -3.2);
        muzzle.castShadow = true;
        muzzle.receiveShadow = true;
        turretGroup.add(muzzle);

        // Barrel tip accent ring (thicker)
        const barrelTipRing = new THREE.Mesh(geom.barrelTipRing, mat.accent);
        barrelTipRing.rotation.x = Math.PI / 2;
        barrelTipRing.position.set(0, 0.4, -3.38);
        barrelTipRing.castShadow = false; // Decorative element - no shadows
        barrelTipRing.receiveShadow = false;
        turretGroup.add(barrelTipRing);

        // Mid-barrel accent ring (new - adds more faction color)
        const midBarrelRing = new THREE.Mesh(geom.midBarrelRing, mat.accent);
        midBarrelRing.rotation.x = Math.PI / 2;
        midBarrelRing.position.set(0, 0.4, -1.5);
        midBarrelRing.castShadow = false; // Decorative element - no shadows
        midBarrelRing.receiveShadow = false;
        turretGroup.add(midBarrelRing);

        bodyGroup.add(turretGroup);

        // Enable layer 1 on body meshes so SpotLights illuminate them
        bodyGroup.traverse((child) => {
          if (child.isMesh) child.layers.enable(1);
        });

        // Hitbox
        const hitbox = new THREE.Mesh(geom.hitbox, new THREE.MeshBasicMaterial({ visible: false }));
        hitbox.position.set(0, 0.75, 0);
        hitbox.userData.type = 'bodyguard';
        group.add(hitbox);

        // Get commander position
        const cmdPos = this._getCommanderPosition();
        const cmdHeading = this._getCommanderHeading();

        // Calculate flank position
        const angleOffset = side === 'left' ? -BODYGUARD_CONFIG.formationAngle : BODYGUARD_CONFIG.formationAngle;
        const flankAngle = cmdHeading + angleOffset + Math.PI; // Behind commander
        const theta = cmdPos.theta + Math.cos(flankAngle) * BODYGUARD_CONFIG.followDistance;
        const phi = cmdPos.phi + Math.sin(flankAngle) * BODYGUARD_CONFIG.followDistance;

        // Position on sphere
        const r = this.sphereRadius;
        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.cos(phi);
        const z = r * Math.sin(phi) * Math.sin(theta);

        group.position.set(x, y, z);

        // Orient to surface (reuse preallocated vectors)
        _bgUp.set(x, y, z).normalize();

        if (Math.abs(_bgUp.y) > 0.999) {
            _bgEast.crossVectors(_bgZAxis, _bgUp).normalize();
        } else {
            _bgEast.crossVectors(_bgWorldUp, _bgUp).normalize();
        }

        _bgNorth.crossVectors(_bgUp, _bgEast).normalize();
        const heading = cmdHeading; // Face same direction as commander

        _bgForward.set(0, 0, 0);
        _bgForward.addScaledVector(_bgNorth, Math.cos(heading));
        _bgForward.addScaledVector(_bgEast, Math.sin(heading));
        _bgForward.normalize();

        _bgTarget.copy(group.position).add(_bgForward);
        group.up.copy(_bgUp);
        group.lookAt(_bgTarget);

        // Add to planet
        this.planet.hexGroup.add(group);

        // Create guard object
        const guard = {
            group,
            bodyGroup,
            turretGroup,
            hitbox,
            index,
            side,
            name: BODYGUARD_CONFIG.names[index],
            faction: this.commanderFaction,
            theta,
            phi,
            heading,
            // Health
            hp: 100,
            maxHp: 100,
            isDead: false,
            damageState: 'healthy',
            // Movement state (like botTanks)
            state: {
                speed: 0,
                keys: { w: false, a: false, s: false, d: false },
                isDead: false,
                wigglePhase: Math.random() * Math.PI * 2,
                lean: {
                    pitchAngle: 0, pitchVelocity: 0,
                    steerAngle: 0, steerVelocity: 0,
                    prevSpeed: 0, prevHeading: 0,
                    initialized: false,
                },
            },
            // AI state
            aiState: BODYGUARD_STATES.FOLLOWING,
            // Target position (updated each frame to stay near commander)
            targetTheta: theta,
            targetPhi: phi,
            wanderDirection: heading,
            // Fade state (3-phase death like botTanks)
            isFading: false,
            fadeStartTime: 0,
            originalFadePosition: null,
            fadeState: null
        };

        hitbox.userData.tankRef = guard;

        return guard;
    }

    _respawnGuard(guard, index) {
        guard.isDead = false;
        guard.state.isDead = false;
        guard.hp = guard.maxHp;
        guard.damageState = 'healthy';
        guard.isFading = false;
        guard.fadeStartTime = 0;
        guard.originalFadePosition = null;
        guard.fadeState = null;
        guard.smokeFullyFaded = false;
        guard.tankFadeStarted = false;
        guard.aiState = BODYGUARD_STATES.FOLLOWING;
        guard.targetEnemy = null;

        // Restore original materials (matches botTanks.respawnBot)
        guard.group.traverse((child) => {
            if (child.isMesh && child.material && child !== guard.hitbox) {
                if (child.userData.originalMaterial) {
                    child.material.dispose();
                    child.material = child.userData.originalMaterial;
                    delete child.userData.originalMaterial;
                }
                child.material.transparent = false;
                child.material.opacity = 1;
            }
        });

        // Reset damage state in external system
        if (this.onGuardDamageStateChange) {
            this.onGuardDamageStateChange(guard, 'healthy');
        }

        // Re-register with treadDust for dust particle emission
        if (this.treadDust) {
            this.treadDust.registerTank(`bodyguard-${index}`, guard.group, guard.state);
        }

        // Re-register headlights
        if (this.tankHeadlights) {
            this.tankHeadlights.registerTank(`bodyguard-${index}`, guard.group, guard.faction, guard);
        }

        // Re-create player tag for HP bar
        if (this.playerTags) {
            this.playerTags.createTag(`bodyguard-${index}`, guard, {
                name: guard.name,
                level: 1,
                avatar: null,
                squad: null,
                faction: guard.faction
            });
        }

        // Reposition near commander
        const cmdPos = this._getCommanderPosition();
        const cmdHeading = this._getCommanderHeading();
        const side = guard.side;

        const angleOffset = side === 'left' ? -BODYGUARD_CONFIG.formationAngle : BODYGUARD_CONFIG.formationAngle;
        const flankAngle = cmdHeading + angleOffset + Math.PI;
        guard.theta = cmdPos.theta + Math.cos(flankAngle) * BODYGUARD_CONFIG.followDistance;
        guard.phi = cmdPos.phi + Math.sin(flankAngle) * BODYGUARD_CONFIG.followDistance;
        guard.heading = cmdHeading;

        // Reset visibility
        guard.group.visible = true;
        guard.group.traverse(child => {
            if (child.material && child.material.opacity !== undefined) {
                child.material.opacity = 1;
                child.material.transparent = false;
            }
        });

        this._updateGuardVisual(guard);
        this.guardStates.set(index, BODYGUARD_STATES.FOLLOWING);
    }

    // ========================
    // UPDATE LOOP (matches bot AI pattern)
    // ========================

    update(timestamp) {
        const deltaTime = 1 / 60; // Assume 60fps for now

        // Update active guards (only when active)
        if (this.active && this.commander) {
            this.guards.forEach((guard, index) => {
                if (guard.isDead) {
                    this._updateDeathFade(guard);
                    return;
                }

                // 1. AI decides target position (always near commander)
                this._updateGuardTarget(guard);

                // 2. Input simulation - set virtual keys based on AI (like botTanks._updateBotInput)
                this._updateGuardInput(guard);

                // 3. Physics - apply keys to heading and speed (like botTanks._updateBotPhysics)
                this._updateGuardPhysics(guard, deltaTime);

                // 4. Movement - move on sphere (like botTanks._moveOnSphere)
                this._moveGuardOnSphere(guard, deltaTime);

                // 5. Visual - update position and orientation
                Tank.updateLeanState(guard.state.lean, guard.state.speed, guard.heading, deltaTime, guard.isDead);
                this._updateGuardVisual(guard, deltaTime);
            });
        }

        // Always update dying guards (they fade out even after despawn)
        this._updateDyingGuards();
    }

    /**
     * Update dying guards that are fading out after despawn
     * Remove them from scene once fully faded
     */
    _updateDyingGuards() {
        for (let i = this.dyingGuards.length - 1; i >= 0; i--) {
            const guard = this.dyingGuards[i];

            // Update fade
            this._updateDeathFade(guard);

            // Remove from scene once fully faded
            if (guard.fadeState === 'faded') {
                if (guard.group && guard.group.parent) {
                    guard.group.parent.remove(guard.group);
                }
                // Note: Player tag already fading via fadeOutTag() called in _triggerDeathSequence
                // No need to remove here - it fades independently over 3 seconds
                this.dyingGuards.splice(i, 1);
            }
        }
    }

    /**
     * Immediately clean up all dying guards (used when spawning new guards)
     */
    _cleanupDyingGuards() {
        for (const guard of this.dyingGuards) {
            if (guard.group && guard.group.parent) {
                guard.group.parent.remove(guard.group);
            }
            if (this.playerTags) {
                this.playerTags.removeTag(`bodyguard-${guard.index}`);
            }
            // Clear damage effects
            if (this.onGuardDamageStateChange) {
                this.onGuardDamageStateChange(guard, 'healthy');
            }
        }
        this.dyingGuards = [];
    }

    // ========================
    // AI TARGET (keep close to commander)
    // ========================

    _updateGuardTarget(guard) {
        const cmdPos = this._getCommanderPosition();
        const cmdHeading = this._getCommanderHeading();
        const side = guard.side;

        // Calculate target flank position (behind and to the side of commander)
        const angleOffset = side === 'left' ? -BODYGUARD_CONFIG.formationAngle : BODYGUARD_CONFIG.formationAngle;
        const flankAngle = cmdHeading + angleOffset + Math.PI;

        guard.targetTheta = cmdPos.theta + Math.cos(flankAngle) * BODYGUARD_CONFIG.followDistance;
        guard.targetPhi = cmdPos.phi + Math.sin(flankAngle) * BODYGUARD_CONFIG.followDistance;

        // Calculate wander direction toward target
        const dTheta = guard.targetTheta - guard.theta;
        const dPhi = guard.targetPhi - guard.phi;
        guard.wanderDirection = Math.atan2(-dTheta, -dPhi);
    }

    _getDistanceToCommander(guard) {
        const cmdPos = this._getCommanderPosition();
        const dTheta = guard.theta - cmdPos.theta;
        const dPhi = guard.phi - cmdPos.phi;
        return Math.sqrt(dTheta * dTheta + dPhi * dPhi);
    }

    _getDistanceToTarget(guard) {
        const dTheta = guard.targetTheta - guard.theta;
        const dPhi = guard.targetPhi - guard.phi;
        return Math.sqrt(dTheta * dTheta + dPhi * dPhi);
    }

    // ========================
    // INPUT SIMULATION (like botTanks._updateBotInput)
    // ========================

    _updateGuardInput(guard) {
        // Clear all keys each frame
        guard.state.keys = { w: false, a: false, s: false, d: false };

        // Check for nearby tanks to avoid
        const avoidance = this._detectCollisionThreat(guard);

        // Calculate heading difference to target
        let headingDiff = guard.wanderDirection - guard.heading;
        while (headingDiff > Math.PI) headingDiff -= Math.PI * 2;
        while (headingDiff < -Math.PI) headingDiff += Math.PI * 2;

        // GTA1-style AI: tight thresholds for instant steering
        const steerDeadZone = 0.05;
        const driveAngleLimit = 0.4;

        // Distance to target position
        const distToTarget = this._getDistanceToTarget(guard);

        // Apply collision avoidance steering (overrides normal steering when threat detected)
        if (avoidance.threat > 0.1) {
            // Steer away from threat
            if (avoidance.steerDirection > 0) {
                guard.state.keys.d = true;
            } else {
                guard.state.keys.a = true;
            }

            // Slow down proportional to threat level
            if (avoidance.threat > 0.5) {
                if (guard.state.speed > BODYGUARD_CONFIG.maxSpeed * 0.2) {
                    guard.state.keys.s = true;
                }
            } else if (avoidance.threat > 0.3) {
                // Coast
            } else {
                if (Math.abs(headingDiff) < driveAngleLimit * 1.5) {
                    guard.state.keys.w = true;
                }
            }
        } else {
            // Normal steering toward target
            if (headingDiff > steerDeadZone) {
                guard.state.keys.d = true;
            } else if (headingDiff < -steerDeadZone) {
                guard.state.keys.a = true;
            }

            // Drive forward when aligned, unless very close to target
            if (distToTarget < 0.008) {
                // Very close - stop and match commander heading
                const cmdHeading = this._getCommanderHeading();
                guard.wanderDirection = cmdHeading;
            } else if (Math.abs(headingDiff) < driveAngleLimit) {
                guard.state.keys.w = true;
            } else if (Math.abs(headingDiff) > Math.PI * 0.75) {
                // Very wrong direction - brake to help turn
                if (guard.state.speed < BODYGUARD_CONFIG.maxSpeed * 0.3) {
                    guard.state.keys.s = true;
                }
            }
        }
    }

    /**
     * Detect tanks ahead that pose a collision threat
     */
    _detectCollisionThreat(guard) {
        let maxThreat = 0;
        let steerDirection = 0;

        const avoidDist = BODYGUARD_CONFIG.avoidDistance;
        const avoidAngle = BODYGUARD_CONFIG.avoidAngle;
        const guardHeading = guard.heading;

        // Check other bodyguards
        for (const otherGuard of this.guards) {
            if (otherGuard === guard) continue;
            if (otherGuard.isDead) continue;

            const threat = this._calculateThreat(
                guard.theta, guard.phi, guardHeading,
                otherGuard.theta, otherGuard.phi,
                avoidDist, avoidAngle
            );

            if (threat.level > maxThreat) {
                maxThreat = threat.level;
                steerDirection = threat.steerDirection;
            }
        }

        // Check commander tank
        if (this.commander && this.commander.tankRef) {
            const cmdPos = this._getCommanderPosition();
            const threat = this._calculateThreat(
                guard.theta, guard.phi, guardHeading,
                cmdPos.theta, cmdPos.phi,
                avoidDist * 0.7, avoidAngle // Smaller range for commander
            );

            if (threat.level > maxThreat) {
                maxThreat = threat.level;
                steerDirection = threat.steerDirection;
            }
        }

        return {
            threat: maxThreat * BODYGUARD_CONFIG.avoidStrength,
            steerDirection: steerDirection
        };
    }

    /**
     * Calculate threat level from a single obstacle
     */
    _calculateThreat(guardTheta, guardPhi, guardHeading, obstacleTheta, obstaclePhi, avoidDist, avoidAngle) {
        let dTheta = obstacleTheta - guardTheta;
        while (dTheta > Math.PI) dTheta -= Math.PI * 2;
        while (dTheta < -Math.PI) dTheta += Math.PI * 2;

        const dPhi = obstaclePhi - guardPhi;
        const angularDist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

        if (angularDist > avoidDist) {
            return { level: 0, steerDirection: 0 };
        }

        const angleToObstacle = Math.atan2(-dTheta, -dPhi);
        let relativeAngle = angleToObstacle - guardHeading;
        while (relativeAngle > Math.PI) relativeAngle -= Math.PI * 2;
        while (relativeAngle < -Math.PI) relativeAngle += Math.PI * 2;

        if (Math.abs(relativeAngle) > avoidAngle) {
            return { level: 0, steerDirection: 0 };
        }

        const distanceFactor = 1 - (angularDist / avoidDist);
        const angleFactor = 1 - (Math.abs(relativeAngle) / avoidAngle);
        const threatLevel = distanceFactor * angleFactor;

        let steerDir;
        if (Math.abs(relativeAngle) < 0.1) {
            steerDir = (dTheta > 0) ? -1 : 1;
        } else {
            steerDir = (relativeAngle < 0) ? 1 : -1;
        }

        return { level: threatLevel, steerDirection: steerDir };
    }

    // ========================
    // PHYSICS (GTA1-style like botTanks)
    // ========================

    _updateGuardPhysics(guard, deltaTime) {
        const keys = guard.state.keys;
        const dt60 = deltaTime * 60;

        // Speed-dependent steering (like botTanks)
        const speedRatio = Math.abs(guard.state.speed) / BODYGUARD_CONFIG.maxSpeed;
        const turnReduction = speedRatio * BODYGUARD_CONFIG.turnSpeedFactor;
        const currentTurnRate = BODYGUARD_CONFIG.baseTurnRate * (1 - turnReduction) +
                               BODYGUARD_CONFIG.minTurnRate * turnReduction;

        // Apply steering
        let steerInput = 0;
        if (keys.a) steerInput = -1;
        if (keys.d) steerInput = 1;

        if (steerInput !== 0) {
            const turnAmount = steerInput * currentTurnRate * dt60;
            const pivotMultiplier = 1.0 + (speedRatio * BODYGUARD_CONFIG.pivotOffset);
            guard.heading += turnAmount * pivotMultiplier;
        }

        // Normalize heading
        while (guard.heading < 0) guard.heading += Math.PI * 2;
        while (guard.heading >= Math.PI * 2) guard.heading -= Math.PI * 2;

        // Acceleration (like botTanks)
        if (keys.w) {
            guard.state.speed += BODYGUARD_CONFIG.acceleration * dt60;
            if (guard.state.speed > BODYGUARD_CONFIG.maxSpeed) {
                guard.state.speed = BODYGUARD_CONFIG.maxSpeed;
            }
        } else if (keys.s) {
            if (guard.state.speed > 0) {
                guard.state.speed -= BODYGUARD_CONFIG.deceleration * 2.5 * dt60;
                if (guard.state.speed < 0) guard.state.speed = 0;
            } else {
                guard.state.speed -= BODYGUARD_CONFIG.acceleration * 0.6 * dt60;
                if (guard.state.speed < -BODYGUARD_CONFIG.maxSpeed * 0.5) {
                    guard.state.speed = -BODYGUARD_CONFIG.maxSpeed * 0.5;
                }
            }
        } else {
            // Coast to stop
            if (guard.state.speed > 0) {
                guard.state.speed -= BODYGUARD_CONFIG.deceleration * dt60;
                if (guard.state.speed < 0) guard.state.speed = 0;
            } else if (guard.state.speed < 0) {
                guard.state.speed += BODYGUARD_CONFIG.deceleration * dt60;
                if (guard.state.speed > 0) guard.state.speed = 0;
            }
        }
    }

    // ========================
    // MOVEMENT (like botTanks._moveOnSphere)
    // ========================

    _moveGuardOnSphere(guard, deltaTime) {
        const speed = guard.state.speed;
        const heading = guard.heading;
        const phi = guard.phi;

        const dt60 = deltaTime * 60;

        // Convert speed to velocity components
        const velocityNorth = Math.cos(heading) * speed * dt60;
        const velocityEast = -Math.sin(heading) * speed * dt60;

        // Convert to spherical coordinate changes
        const sinPhi = Math.sin(phi);
        const safeSinPhi = Math.max(0.1, sinPhi);

        const dPhi = -velocityNorth;
        const dTheta = velocityEast / safeSinPhi;

        guard.phi += dPhi;
        guard.theta += dTheta;

        // Clamp phi (avoid poles)
        guard.phi = Math.max(0.25, Math.min(Math.PI - 0.25, guard.phi));

        // Wrap theta
        while (guard.theta > Math.PI * 2) guard.theta -= Math.PI * 2;
        while (guard.theta < 0) guard.theta += Math.PI * 2;
    }

    _updateGuardVisual(guard, deltaTime = 0) {
        const r = this.sphereRadius;
        const theta = guard.theta;
        const phi = guard.phi;

        // Update wiggle phase based on speed (like botTanks)
        const speed = Math.abs(guard.state.speed);
        if (speed > 0.00001 && deltaTime > 0) {
            const speedRatio = Math.min(speed / 0.00025, 1);
            guard.state.wigglePhase += deltaTime * (12 + speedRatio * 18);
        }

        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.cos(phi);
        const z = r * Math.sin(phi) * Math.sin(theta);

        guard.group.position.set(x, y, z);

        // Orient to surface (reuse preallocated vectors)
        _bgUp.set(x, y, z).normalize();

        if (Math.abs(_bgUp.y) > 0.999) {
            _bgEast.crossVectors(_bgZAxis, _bgUp).normalize();
        } else {
            _bgEast.crossVectors(_bgWorldUp, _bgUp).normalize();
        }

        _bgNorth.crossVectors(_bgUp, _bgEast).normalize();

        _bgForward.set(0, 0, 0);
        _bgForward.addScaledVector(_bgNorth, Math.cos(guard.heading));
        _bgForward.addScaledVector(_bgEast, Math.sin(guard.heading));
        _bgForward.normalize();

        // Build rotation matrix (like botTanks)
        _bgRight.crossVectors(_bgForward, _bgUp).normalize();
        _bgTarget.copy(_bgForward).negate();
        _bgRotMatrix.makeBasis(_bgRight, _bgUp, _bgTarget);
        guard.group.quaternion.setFromRotationMatrix(_bgRotMatrix);

        // Apply lean + wiggle to bodyGroup (so headlights, hitbox on outer group are unaffected)
        const leanTarget = guard.bodyGroup || guard.group;
        if (guard.bodyGroup) guard.bodyGroup.quaternion.identity();

        // Apply momentum lean (pitch + steer) before wiggle
        if (guard.state.lean) {
            if (guard.state.lean.pitchAngle !== 0) {
                _bgPitchQuat.setFromAxisAngle(_bgPitchAxis, guard.state.lean.pitchAngle);
                leanTarget.quaternion.multiply(_bgPitchQuat);
            }
            if (guard.state.lean.steerAngle !== 0) {
                _bgSteerQuat.setFromAxisAngle(_bgZAxis, guard.state.lean.steerAngle);
                leanTarget.quaternion.multiply(_bgSteerQuat);
            }
        }

        // Apply roll wiggle when moving (like botTanks)
        if (speed > 0.00001 && !guard.isDead) {
            const hpPercent = Math.max(guard.hp / guard.maxHp, 0);
            const wiggleMultiplier = 1 + (1 - hpPercent) * 3;
            const baseMaxWiggle = 0.035;
            const maxWiggle = baseMaxWiggle * wiggleMultiplier;
            const speedRatio = Math.min(speed / 0.0004, 1);
            const wiggleAmount = speedRatio * maxWiggle;
            const rollAngle = Math.sin(guard.state.wigglePhase) * wiggleAmount;

            _bgRollQuat.setFromAxisAngle(_bgZAxis, rollAngle);
            leanTarget.quaternion.multiply(_bgRollQuat);
        }
    }

    // ========================
    // DEATH & FADE (3-phase like botTanks)
    // ========================

    /**
     * Start 3-phase death fade (matches botTanks._startBotFadeOut)
     * Phase 1 (0-5s): Smoke fades
     * Phase 2 (5-6.5s): Tank sits charred
     * Phase 3 (6.5-9.5s): Tank fades + sinks, oil fades
     */
    _startDeathFade(guard) {
        guard.isFading = true;
        guard.fadeStartTime = performance.now();
        guard.originalFadePosition = guard.group.position.clone();
        // State tracking flags (matches botTanks)
        guard.smokeFullyFaded = false;
        guard.tankFadeStarted = false;
    }

    /**
     * Update 3-phase death fade (matches botTanks._updateBotFade)
     * Returns true when fade is complete
     */
    _updateDeathFade(guard) {
        if (!guard.isFading) return false;

        const elapsed = performance.now() - guard.fadeStartTime;
        const smokeFadeDuration = 5000;  // 5s (updated from 3s per user request)
        const sinkDelay = 1500;          // 1.5s
        const tankFadeDuration = 3000;   // 3s

        // Phase 1: Smoke fades (0-5s)
        if (elapsed < smokeFadeDuration) {
            const smokeProgress = elapsed / smokeFadeDuration;
            const smokeOpacity = 1 - smokeProgress;
            if (this.onGuardFadeUpdate) {
                this.onGuardFadeUpdate(guard, smokeOpacity, 'smoke');
            }
            return false;
        }

        // Mark smoke as fully faded (do this once)
        if (!guard.smokeFullyFaded) {
            guard.smokeFullyFaded = true;
            // Ensure smoke is at 0 opacity
            if (this.onGuardFadeUpdate) {
                this.onGuardFadeUpdate(guard, 0, 'smoke');
            }
        }

        // Phase 2: Charred delay (3-4.5s) - tank just sits there
        const delayElapsed = elapsed - smokeFadeDuration;
        if (delayElapsed < sinkDelay) {
            return false;
        }

        // Phase 3: Tank fades + sinks (4.5-7.5s)
        const fadeElapsed = delayElapsed - sinkDelay;
        const fadeProgress = Math.min(1, fadeElapsed / tankFadeDuration);

        if (fadeProgress >= 1) {
            guard.fadeState = 'faded';
            guard.group.visible = false;
            return true; // Complete - ready for removal
        }

        // Start fade setup (once) - clone materials so fading doesn't affect other tanks
        if (!guard.tankFadeStarted) {
            guard.tankFadeStarted = true;
            guard.group.traverse((child) => {
                if (child.isMesh && child.material && child !== guard.hitbox) {
                    // Clone material to avoid affecting other tanks using shared materials
                    child.material = child.material.clone();
                    child.material.transparent = true;
                }
            });
        }

        // Calculate opacity (ease-in for gradual start)
        const easedProgress = fadeProgress * fadeProgress;  // Quadratic ease-in
        const opacity = 1 - easedProgress;

        // Sink into ground (3 units over duration)
        const sinkDistance = 3 * easedProgress;
        const surfaceNormal = guard.originalFadePosition.clone().normalize();
        guard.group.position.copy(guard.originalFadePosition);
        guard.group.position.addScaledVector(surfaceNormal, -sinkDistance);

        // Apply opacity to all tank meshes
        guard.group.traverse((child) => {
            if (child.isMesh && child.material && child !== guard.hitbox) {
                child.material.opacity = opacity;
            }
        });

        return false;
    }

    // ========================
    // HELPERS
    // ========================

    _getCommanderPosition() {
        if (!this.commander || !this.commander.tankRef) {
            return { theta: 0, phi: Math.PI / 2 };
        }

        const tank = this.commander.tankRef;

        // Player tank has state.theta/phi, bots have theta/phi directly
        if (tank.state) {
            return { theta: tank.state.theta, phi: tank.state.phi };
        } else {
            return { theta: tank.theta || 0, phi: tank.phi || Math.PI / 2 };
        }
    }

    _getCommanderHeading() {
        if (!this.commander || !this.commander.tankRef) {
            return 0;
        }

        const tank = this.commander.tankRef;

        if (tank.state) {
            return tank.state.heading || 0;
        } else {
            return tank.heading || 0;
        }
    }

    _getEntitySphericalPosition(entity) {
        if (!entity || !entity.group) {
            return { theta: 0, phi: Math.PI / 2 };
        }

        // Try state first (player tank), then direct properties (bots)
        if (entity.state && entity.state.theta !== undefined) {
            return { theta: entity.state.theta, phi: entity.state.phi };
        } else if (entity.theta !== undefined) {
            return { theta: entity.theta, phi: entity.phi };
        }

        // Fallback: calculate from world position
        const pos = entity.group.position;
        const r = pos.length();
        const phi = Math.acos(pos.y / r);
        const theta = Math.atan2(pos.z, pos.x);
        return { theta, phi };
    }

    /**
     * Get world position from a guard's spherical coordinates
     */
    _getGuardWorldPosition(guard) {
        const worldPos = new THREE.Vector3();
        guard.group.getWorldPosition(worldPos);
        return worldPos;
    }

    /**
     * Spawn a shockwave effect at a bodyguard's position
     */
    _spawnShockwaveAt(guard) {
        if (!this.dustShockwave) return;

        const worldPos = this._getGuardWorldPosition(guard);
        // Larger scale for dramatic spawn effect
        this.dustShockwave.emit(worldPos, 1.5);
    }

    /**
     * Spawn explosion effect at a bodyguard's position
     */
    _spawnExplosionAt(guard, faction) {
        if (!this.cannonSystem) {
            console.warn(`[CommanderBodyguards] cannonSystem not set!`);
            return;
        }

        const worldPos = this._getGuardWorldPosition(guard);
        // Use faction color for explosion, larger scale for dramatic death
        this.cannonSystem.spawnExplosion(worldPos, faction, 1.5);

        // Shockwave (same scale as player/bot death)
        if (this.dustShockwave) {
            this.dustShockwave.emit(worldPos, 1.5);
        }
    }

    // ========================
    // PUBLIC API
    // ========================

    /**
     * Get all bodyguards
     */
    getGuards() {
        return this.guards;
    }

    /**
     * Check if bodyguards are active
     */
    isActive() {
        return this.active;
    }

    /**
     * Apply damage to a bodyguard (matches botTanks.applyDamage)
     */
    applyDamage(guard, amount, attackerFaction) {
        if (!guard || guard.isDead) return;

        guard.hp = Math.max(0, guard.hp - amount);
        this._updateGuardDamageState(guard);
        this._flashGuardHit(guard);

        // Update HP bar
        if (this.playerTags) {
            this.playerTags.updateHP(`bodyguard-${guard.index}`, guard.hp, guard.maxHp);
        }

        if (guard.hp <= 0) {
            this._triggerDeathSequence(guard);
        }
    }

    /**
     * Update damage state based on HP (matches botTanks._updateBotDamageState)
     * healthy > 50%, damaged 25-50%, critical < 25%
     */
    _updateGuardDamageState(guard) {
        const hpPercent = guard.hp / guard.maxHp;
        const oldState = guard.damageState;
        let newState = 'healthy';

        if (hpPercent > 0.5) {
            newState = 'healthy';
        } else if (hpPercent > 0.25) {
            newState = 'damaged';    // Gray smoke
        } else if (hpPercent > 0) {
            newState = 'critical';   // Fire + black smoke
        }

        if (newState !== oldState) {
            guard.damageState = newState;
            if (this.onGuardDamageStateChange) {
                this.onGuardDamageStateChange(guard, newState);
            }
        }
    }

    /**
     * Flash effect on hit (matches botTanks._flashBotHit)
     */
    _flashGuardHit(guard) {
        const originalScale = guard.group.scale.clone();
        guard.group.scale.multiplyScalar(1.15);
        setTimeout(() => {
            guard.group.scale.copy(originalScale);
        }, 30);
    }

    /**
     * Set charred material on death (matches botTanks._setBotDeadMaterial)
     * Clones materials to avoid affecting shared faction materials
     */
    _setGuardDeadMaterial(guard) {
        const charredColor = 0x3a3a3a;  // Dark gray - charred look
        guard.group.traverse((child) => {
            if (child.isMesh && child.material && child !== guard.hitbox) {
                // Only modify materials that have a color property
                if (!child.material.color) return;
                // Clone material to avoid affecting shared faction materials
                if (!child.userData.originalMaterial) {
                    child.userData.originalMaterial = child.material;
                    child.material = child.material.clone();
                }
                child.material.color.setHex(charredColor);
            }
        });
    }
}
