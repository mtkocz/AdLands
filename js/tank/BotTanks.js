/**
 * AdLands - Bot Tanks Module
 * Active AI tanks that capture territory with faction coordination
 * Uses same control model as player: accelerate, turn, reverse
 */

// Bot states
const BOT_STATES = {
  IDLE: "idle",
  MOVING: "moving",
  CAPTURING: "capturing",
  WANDERING: "wandering",
};

// Preallocated temps for bot lean/wiggle (avoid per-frame GC)
const _botPitchAxis = new THREE.Vector3(1, 0, 0);
const _botPitchQuat = new THREE.Quaternion();
const _botSteerQuat = new THREE.Quaternion();
const _botZAxis = new THREE.Vector3(0, 0, 1);
const _botRollQuat = new THREE.Quaternion();

// Faction Coordinator - handles strategic target assignment per faction
class FactionCoordinator {
  // Pole limits for target filtering (must match BotTanks limits)
  static BOT_POLE_SOFT_LIMIT = 0.5;

  constructor(planet, faction) {
    this.planet = planet;
    this.faction = faction;
    this.assignedBots = new Map();
    this.targetPriorities = [];
    this.updateInterval = 2000;
    this.lastUpdate = 0;
    this.pathfinder = null;

    this._clusterCenters = new Map();
    this.planet.clusterData.forEach((cluster) => {
      this._clusterCenters.set(cluster.id, this._computeClusterCenter(cluster));
    });
  }

  setPathfinder(pathfinder) {
    this.pathfinder = pathfinder;
  }

  _computeClusterCenter(cluster) {
    if (!cluster || cluster.tiles.length === 0) return null;

    let sumX = 0,
      sumY = 0,
      sumZ = 0;
    let count = 0;

    cluster.tiles.forEach((tileIdx) => {
      const tile = this.planet.tileCenters[tileIdx];
      if (tile) {
        sumX += tile.position.x;
        sumY += tile.position.y;
        sumZ += tile.position.z;
        count++;
      }
    });

    if (count === 0) return null;

    const avgX = sumX / count;
    const avgY = sumY / count;
    const avgZ = sumZ / count;

    const r = Math.sqrt(avgX * avgX + avgY * avgY + avgZ * avgZ);
    const phi = Math.acos(avgY / r);
    const theta = Math.atan2(avgZ, avgX);

    return { theta, phi };
  }

  update(factionBots, allCoordinators, timestamp) {
    if (timestamp - this.lastUpdate < this.updateInterval) return;
    this.lastUpdate = timestamp;

    this._calculatePriorities(factionBots, allCoordinators);
    this._assignBots(factionBots);
  }

  _calculatePriorities(factionBots, allCoordinators) {
    this.targetPriorities = [];

    this.planet.clusterData.forEach((cluster) => {
      const state = this.planet.clusterCaptureState.get(cluster.id);
      if (!state) return;

      // Skip clusters in polar regions or pathfinding-unreachable areas
      const clusterCenter = this._clusterCenters.get(cluster.id);
      if (!this._isClusterReachable(clusterCenter, cluster.id)) return;

      let priority = 0;
      const tileCount = cluster.tiles.length;
      const capacity = state.capacity;
      const myTics = state.tics[this.faction];
      const totalTics =
        state.tics.rust + state.tics.cobalt + state.tics.viridian;

      if (!state.owner && totalTics === 0) {
        // Unclaimed, no one capturing - high priority
        priority += 100;
      } else if (!state.owner && myTics > 0) {
        // We're capturing, keep going
        priority += 80 + (myTics / capacity) * 20;
      } else if (!state.owner && totalTics > 0 && myTics === 0) {
        // Enemy is capturing unclaimed - contest it
        priority += 70;
      } else if (state.owner && state.owner !== this.faction) {
        // Enemy territory - attack if we're gaining ground
        priority += 50 + (myTics > 0 ? 20 : 0);
      } else if (state.owner === this.faction) {
        // Our territory - low priority unless under attack
        const enemyTics = totalTics - myTics;
        priority += enemyTics > myTics * 0.5 ? 40 : 5;
      }

      priority += Math.max(0, 30 - tileCount * 0.3);

      const enemyPresence = this._countEnemyBots(cluster.id, allCoordinators);
      priority -= enemyPresence * 8;

      priority += Math.random() * 10;

      if (priority > 10) {
        this.targetPriorities.push({
          clusterId: cluster.id,
          priority,
          tileCount,
        });
      }
    });

    this.targetPriorities.sort((a, b) => b.priority - a.priority);
  }

  _assignBots(factionBots) {
    this.assignedBots.clear();

    const availableBots = factionBots.filter((b) => {
      if (b.aiState === BOT_STATES.CAPTURING) {
        const state = this.planet.clusterCaptureState.get(b.clusterId);
        if (state && state.owner === this.faction) return false;
      }
      return true;
    });

    const numTargets = Math.min(8, Math.ceil(availableBots.length / 4));
    let assignedCount = 0;

    for (
      let i = 0;
      i < Math.min(numTargets, this.targetPriorities.length);
      i++
    ) {
      const target = this.targetPriorities[i];
      if (assignedCount >= availableBots.length) break;

      const botsNeeded = Math.min(
        Math.max(3, Math.ceil(target.tileCount / 15) + 2),
        Math.ceil(availableBots.length / numTargets),
      );

      this.assignedBots.set(target.clusterId, new Set());
      const clusterCenter = this._clusterCenters.get(target.clusterId);
      if (!clusterCenter) continue;

      const unassigned = availableBots.filter(
        (b) => b.targetClusterId === null || b.targetClusterId === undefined,
      );

      // Pre-sort by sphere distance, then refine top candidates with A* path distance
      const targetTile = this.pathfinder
        ? this.pathfinder.getClusterCenterTile(target.clusterId)
        : -1;
      const candidateCount = Math.min(unassigned.length, botsNeeded * 3);

      let candidates = unassigned
        .map((b) => ({ bot: b, dist: this._sphereDistance(b, clusterCenter) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, candidateCount);

      // Refine with A* path distance for top candidates
      if (this.pathfinder && targetTile !== -1) {
        candidates = candidates.map(({ bot }) => {
          const botTile = this.pathfinder.getNearestTraversableTile(bot.theta, bot.phi);
          const dist = botTile !== -1
            ? this.pathfinder.getPathDistance(botTile, targetTile)
            : Infinity;
          return { bot, dist };
        }).sort((a, b) => a.dist - b.dist);
      }

      candidates
        .slice(0, botsNeeded)
        .forEach(({ bot }) => {
          bot.targetClusterId = target.clusterId;
          bot.targetPosition = { ...clusterCenter };
          this.assignedBots.get(target.clusterId).add(bot);
          assignedCount++;
        });
    }
  }

  _sphereDistance(bot, target) {
    if (!target) return Infinity;
    const dTheta = bot.theta - target.theta;
    const dPhi = bot.phi - target.phi;
    return Math.sqrt(dTheta * dTheta + dPhi * dPhi);
  }

  _isClusterReachable(clusterCenter, clusterId) {
    if (!clusterCenter) return false;
    const phi = clusterCenter.phi;
    // Cluster must be outside the soft pole limit zones
    if (
      phi <= FactionCoordinator.BOT_POLE_SOFT_LIMIT ||
      phi >= Math.PI - FactionCoordinator.BOT_POLE_SOFT_LIMIT
    ) {
      return false;
    }
    // Check pathfinding reachability (cluster center tile must be traversable)
    if (this.pathfinder) {
      const centerTile = this.pathfinder.getClusterCenterTile(clusterId);
      if (centerTile === -1) return false;
    }
    return true;
  }

  _countEnemyBots(clusterId, allCoordinators) {
    let count = 0;
    for (const [faction, coordinator] of Object.entries(allCoordinators)) {
      if (faction !== this.faction) {
        const assigned = coordinator.assignedBots.get(clusterId);
        if (assigned) count += assigned.size;
      }
    }
    return count;
  }

  getClusterCenter(clusterId) {
    return this._clusterCenters.get(clusterId);
  }
}

class BotTanks {
  constructor(scene, sphereRadius, planet, treadTracks, options = {}) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.planet = planet;
    this.treadTracks = treadTracks;
    this.bots = [];
    this.skipSpawn = !!options.skipSpawn;

    // Player population management
    this.TARGET_TOTAL_PLAYERS = 150;
    this.humanPlayers = []; // Array of {id, position: Vector3, faction: string, theta, phi}
    this.playerTankRef = null; // Reference to local player tank for collision avoidance

    // GTA1-style vehicle physics
    this.BOT_MAX_SPEED = 0.00022; // Faster top speed
    this.BOT_ACCELERATION = 0.000025; // 3x faster (snappy response)
    this.BOT_DECELERATION = 0.000015; // Responsive braking

    // GTA1 steering parameters
    this.BOT_BASE_TURN_RATE = 0.035; // Turn rate when slow (very responsive)
    this.BOT_MIN_TURN_RATE = 0.008; // Turn rate at max speed (wider turns)
    this.BOT_TURN_SPEED_FACTOR = 0.7; // How much speed affects turning
    this.BOT_PIVOT_OFFSET = 0.6; // Rear-pivot feel (0=center, 1=full rear)

    // Pole avoidance parameters
    this.BOT_POLE_SOFT_LIMIT = 0.5; // Phi where soft repulsion begins (radians from pole)
    this.BOT_POLE_HARD_LIMIT = 0.20; // Absolute minimum phi (hard clamp as safety net)
    this.BOT_POLE_REPULSION_STRENGTH = 0.005; // How strongly bots are pushed away from poles

    // Collision avoidance parameters
    this.BOT_AVOID_DISTANCE = 0.04; // Angular distance to start avoiding (radians)
    this.BOT_AVOID_ANGLE = Math.PI / 2.5; // Cone angle for forward sensing (72 degrees)
    this.BOT_AVOID_STRENGTH = 1.0; // How strongly to steer away (0-1)

    // Omnidirectional separation (anti-bunching)
    this.BOT_SEPARATION_RADIUS = 0.025; // All-direction repulsion radius
    this.BOT_SEPARATION_STRENGTH = 0.15; // Separation force strength

    // Terrain navigation parameters (relaxed — pathfinding handles routing around terrain)
    this.BOT_STUCK_CHECK_INTERVAL = 0.75; // Seconds between stuck checks
    this.BOT_STUCK_THRESHOLD = 3; // Consecutive stuck checks before recovery
    this.BOT_TERRAIN_BOUNCE_LIMIT = 1; // Bounces before drastic course change
    this.BOT_COLLISION_SPEED_RETAIN = 0.15; // 85% speed loss on terrain collision
    this.BOT_TERRAIN_AVOID_COOLDOWN = 2.5; // Longer pause to escape terrain

    // Bot turret rotation physics (slightly slower than player)
    this.botTurretPhysics = {
      maxAngularSpeed: Math.PI * 1.2, // 216 deg/s
      stiffness: 20,
      damping: 9,
    };

    this._updateIndex = 0;

    // Preallocated temp for terrain collision checks
    this._terrainTemp = { testPos: new THREE.Vector3() };

    // Preallocated Map for getBotsPerCluster (avoid per-call GC)
    this._botsPerClusterMap = new Map();

    // Pathfinder reference (set via setPathfinder)
    this.pathfinder = null;

    // Chat system
    this.proximityChat = null; // Set externally after initialization
    this.playerTags = null; // Set externally after initialization
    this.lastChatTime = 0;
    this.chatCooldown = 3000; // Minimum 3 seconds between any bot chat
    this.chatChanceBase = 0.0005; // Base chance when no enemies nearby
    this.chatChanceNearby = 0.006; // Boosted chance when enemies are close
    this.chatProximityRadius = 0.20; // Radius to detect nearby enemies (theta/phi)

    // Use global FACTION_COLORS for bot vehicle palettes
    this.factions = {
      viridian: {
        primary: FACTION_COLORS.viridian.vehicle.primary,
        secondary: FACTION_COLORS.viridian.vehicle.secondary,
        tracks: 0x222222,
        barrel: 0x333333,
      },
      cobalt: {
        primary: FACTION_COLORS.cobalt.vehicle.primary,
        secondary: FACTION_COLORS.cobalt.vehicle.secondary,
        tracks: 0x222222,
        barrel: 0x333333,
      },
      rust: {
        primary: FACTION_COLORS.rust.vehicle.primary,
        secondary: FACTION_COLORS.rust.vehicle.secondary,
        tracks: 0x222222,
        barrel: 0x333333,
      },
    };

    // Create shared geometries and materials for performance (reused across all bots)
    this._setupSharedAssets();

    // Create InstancedMesh pools for LOD rendering (lodBox + shadowBlob)
    this._setupInstancedMeshes();

    // Orbital phantom dots (server-reported positions for bots outside spatial filter)
    this._setupOrbitalPhantoms();

    // Preallocated temp objects for visibility culling (avoid GC pressure)
    this._cullTemp = {
      botWorldPos: new THREE.Vector3(),
      surfaceNormal: new THREE.Vector3(),
      cameraToBot: new THREE.Vector3(),
      boundingSphere: new THREE.Sphere(new THREE.Vector3(), 5),
      // Frustum culling objects (reused every frame)
      frustum: new THREE.Frustum(),
      projScreenMatrix: new THREE.Matrix4(),
      cameraWorldPos: new THREE.Vector3(),
    };

    // Cached faction arrays (updated when bots spawn/die, not every frame)
    this._factionBots = {
      viridian: [],
      cobalt: [],
      rust: [],
    };

    if (!this.skipSpawn) {
      this._spawnBots();
    }

    this.coordinators = {
      viridian: new FactionCoordinator(planet, "viridian"),
      cobalt: new FactionCoordinator(planet, "cobalt"),
      rust: new FactionCoordinator(planet, "rust"),
    };
  }

  _setupSharedAssets() {
    // Shared geometries (created once, reused by all bots)
    this._sharedGeom = {
      hull: new THREE.BoxGeometry(2.5, 0.8, 5),
      frontSlope: new THREE.BoxGeometry(2.2, 0.5, 1.0),
      rear: new THREE.BoxGeometry(2.2, 1.0, 0.8),
      track: new THREE.BoxGeometry(0.6, 0.6, 5.2),
      turret: new THREE.BoxGeometry(1.5, 0.6, 1.8),
      barrel: new THREE.CylinderGeometry(0.15, 0.2, 2.5, 8),
      muzzle: new THREE.BoxGeometry(0.4, 0.3, 0.3),
      hitbox: new THREE.BoxGeometry(3, 1.5, 5.5), // Collision hitbox
      // LOD box - same dimensions as hitbox for consistent silhouette
      lodBox: new THREE.BoxGeometry(3, 1.5, 5.5),
    };

    // Shared invisible hitbox material
    this._hitboxMaterial = new THREE.MeshBasicMaterial({ visible: false });

    // Shared materials per faction (created once, reused by all bots of same faction)
    this._sharedMat = {};
    for (const [factionName, colors] of Object.entries(this.factions)) {
      this._sharedMat[factionName] = {
        hull: new THREE.MeshStandardMaterial({
          color: colors.primary,
          roughness: 0.7,
          metalness: 0.3,
          flatShading: true,
        }),
        turret: new THREE.MeshStandardMaterial({
          color: colors.secondary,
          roughness: 0.6,
          metalness: 0.4,
          flatShading: true,
        }),
        track: new THREE.MeshStandardMaterial({
          color: colors.tracks,
          roughness: 0.9,
          metalness: 0.1,
          flatShading: true,
        }),
        barrel: new THREE.MeshStandardMaterial({
          color: colors.barrel,
          roughness: 0.5,
          metalness: 0.6,
          flatShading: true,
        }),
        // LOD material with terminator-aware lighting
        lod: this._createLODMaterial(colors.primary),
      };
    }

    // Shadow blob assets (fake shadows for orbital mode)
    // Rectangular shape matching tank proportions (width 4.5, depth 7)
    this._shadowGeometry = new THREE.PlaneGeometry(4.5, 7);
    this._shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: 0.5,
      transparent: true,
      depthWrite: false,
      alphaMap: this._createRectangularShadowTexture(),
    });

    // LOD dot assets (billboarded planes with shader-based outline)
    const dotSize = 8.44; // Visual size (75% of 11.25, shrunk 25% for orbital view)
    this._lodDotRadius = dotSize / 2; // For commander outline and raycasting
    this._lodDotGeometry = new THREE.PlaneGeometry(dotSize, dotSize);
    // 3D torus ring for commander outline
    this._lodDotCommanderOutlineGeometry = new THREE.TorusGeometry(
      this._lodDotRadius + 2.25,
      0.8,
      8,
      16,
    );
    this._lodDotMaterials = {};
    this._lodDotCommanderOutlineMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.9,
    });
    // Use pure faction colors with shader materials (includes dark outline)
    for (const factionName of Object.keys(this.factions)) {
      const pureFactionColor =
        typeof FACTION_COLORS !== "undefined"
          ? FACTION_COLORS[factionName].hex
          : this.factions[factionName].primary;
      this._lodDotMaterials[factionName] =
        this._createLODDotMaterial(pureFactionColor);
    }
  }

  /**
   * Create InstancedMesh pools for LOD box and shadow blob rendering.
   * Replaces per-bot individual meshes with batched instanced draws.
   * lodBox: 3 InstancedMesh (one per faction), shadowBlob: 1 InstancedMesh (shared material).
   */
  _setupInstancedMeshes() {
    const maxPerFaction = Math.ceil(this.TARGET_TOTAL_PLAYERS / 3) + 10; // ~60 per faction
    const factionNames = ["rust", "cobalt", "viridian"];

    // InstancedMesh pools for LOD boxes (one per faction for different materials)
    this._instancedLodBox = {};
    for (const faction of factionNames) {
      const im = new THREE.InstancedMesh(
        this._sharedGeom.lodBox,
        this._sharedMat[faction].lod,
        maxPerFaction,
      );
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = false;
      im.frustumCulled = false; // We handle culling per-bot
      this._instancedLodBox[faction] = im;
      this.planet.hexGroup.add(im);
    }

    // Single InstancedMesh for shadow blobs (same material for all factions)
    this._instancedShadowBlob = new THREE.InstancedMesh(
      this._shadowGeometry,
      this._shadowMaterial,
      this.TARGET_TOTAL_PLAYERS,
    );
    this._instancedShadowBlob.count = 0;
    this._instancedShadowBlob.castShadow = false;
    this._instancedShadowBlob.receiveShadow = false;
    this._instancedShadowBlob.frustumCulled = false;
    this._instancedShadowBlob.renderOrder = -1;
    this.planet.hexGroup.add(this._instancedShadowBlob);

    // Precomputed constant offset matrices (local to bot.group)
    this._lodBoxOffset = new THREE.Matrix4().makeTranslation(0, 0.75, 0);
    this._shadowBlobOffset = new THREE.Matrix4()
      .makeTranslation(0, -0.3, 0)
      .multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));

    // Preallocated temps for per-frame instance matrix computation
    this._instanceTemp = {
      matrix: new THREE.Matrix4(),
      botMatrix: new THREE.Matrix4(),
    };
  }

  /**
   * Create billboarded dot material for commander mode (Type 2 LOD)
   * Draws a filled circle with dark outline using fragment shader
   */
  _createLODDotMaterial(color) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        uOutlineColor: { value: new THREE.Color(0x111111) },
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      },
      vertexShader: `
                varying vec2 vUv;
                varying vec3 vWorldPosition;

                void main() {
                    vUv = uv;

                    // Get world position for shadow calculation
                    vec4 worldPos = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                    vWorldPosition = worldPos.xyz;

                    // Billboard: make the plane always face the camera
                    vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                    vec2 scale = vec2(
                        length(modelMatrix[0].xyz),
                        length(modelMatrix[1].xyz)
                    );
                    mvPosition.xy += position.xy * scale;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
      fragmentShader: `
                uniform vec3 uColor;
                uniform vec3 uOutlineColor;
                uniform vec3 uSunDirection;

                varying vec2 vUv;
                varying vec3 vWorldPosition;

                void main() {
                    // Distance from center (0.5, 0.5)
                    float dist = length(vUv - 0.5) * 2.0;

                    // Inner filled circle
                    float circle = 1.0 - smoothstep(0.7, 0.75, dist);

                    // Outline ring
                    float outline = (1.0 - smoothstep(0.9, 0.95, dist)) - circle;
                    outline = max(outline, 0.0);

                    // Calculate terminator shadow based on position on planet
                    vec3 surfaceNormal = normalize(vWorldPosition);
                    float sunFacing = dot(surfaceNormal, uSunDirection);
                    float shadow = smoothstep(-0.2, 0.2, sunFacing);
                    // Slightly darken on shadow side (0.6 minimum brightness)
                    float brightness = 0.6 + 0.4 * shadow;

                    // Combine colors with shadow
                    vec3 finalColor = uColor * circle * brightness + uOutlineColor * outline;
                    float alpha = circle + outline;

                    // Discard fully transparent pixels
                    if (alpha < 0.01) discard;

                    gl_FragColor = vec4(finalColor, alpha);
                }
            `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /**
   * Update lighting uniforms for all LOD dot shader materials
   * Called during initialization with environment.getLightingConfig()
   */
  setLightingConfig(lightConfig) {
    // Update all faction materials (shared by bots of same faction)
    for (const factionName of Object.keys(this._lodDotMaterials)) {
      const material = this._lodDotMaterials[factionName];
      if (material && material.uniforms) {
        material.uniforms.uSunDirection.value.copy(lightConfig.sun.direction);
      }
    }
  }

  /**
   * Create rectangular shadow texture matching tank proportions
   * Uses rounded rectangle with soft edges (same as dashboard preview)
   */
  _createRectangularShadowTexture() {
    const canvas = document.createElement("canvas");
    const width = 96; // Tank width
    const height = 144; // Tank length (longer)
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    // Draw rounded rectangle with soft edges using multiple passes
    const centerX = width / 2;
    const centerY = height / 2;
    const rectWidth = width * 0.7;
    const rectHeight = height * 0.7;
    const cornerRadius = 8;

    // Helper to draw rounded rect path
    const roundedRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    // Draw multiple layers to create soft edge falloff (white for alpha map)
    const layers = 8;
    for (let i = layers; i >= 0; i--) {
      const scale = 1 + (i / layers) * 0.5;
      const alpha = (1 - i / layers) * 1.0; // Full white at center
      const w = rectWidth * scale;
      const h = rectHeight * scale;
      const x = centerX - w / 2;
      const y = centerY - h / 2;
      const r = cornerRadius * scale;

      roundedRect(x, y, w, h, r);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fill();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    return texture;
  }

  _createLODMaterial(color) {
    // Custom shader material for LOD tanks with proper lighting
    // Responds to sun and fill lights like detailed tanks, plus terminator shadowing
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(color) },
        // Sun light (warm, from +X)
        uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
        uSunColor: { value: new THREE.Color(0xffd9b7) },
        uSunIntensity: { value: 1.5 },
        // Fill light (cool, from -X)
        uFillDirection: { value: new THREE.Vector3(-1, 0, 0) },
        uFillColor: { value: new THREE.Color(0x6b8e99) },
        uFillIntensity: { value: 0.75 },
        // Ambient light
        uAmbientColor: { value: new THREE.Color(0x3366aa) },
        uAmbientIntensity: { value: 0.4 },
      },
      vertexShader: `
                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;

                void main() {
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPos.xyz;
                    vWorldNormal = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * viewMatrix * worldPos;
                }
            `,
      fragmentShader: `
                uniform vec3 uColor;
                uniform vec3 uSunDirection;
                uniform vec3 uSunColor;
                uniform float uSunIntensity;
                uniform vec3 uFillDirection;
                uniform vec3 uFillColor;
                uniform float uFillIntensity;
                uniform vec3 uAmbientColor;
                uniform float uAmbientIntensity;

                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;

                void main() {
                    vec3 normal = normalize(vWorldNormal);

                    // Planet surface normal (for terminator calculation)
                    vec3 surfaceNormal = normalize(vWorldPosition);

                    // Terminator factor: only affects sun light (like real shadows would)
                    // Tanks on dark side don't receive sunlight
                    float sunFacing = dot(surfaceNormal, uSunDirection);
                    float terminatorShadow = smoothstep(-0.2, 0.2, sunFacing);

                    // Start with ambient light (always present, no terminator reduction)
                    vec3 lighting = uAmbientColor * uAmbientIntensity;

                    // Sun diffuse (blocked by terminator on dark side)
                    float sunDiffuse = max(dot(normal, uSunDirection), 0.0);
                    lighting += uSunColor * uSunIntensity * sunDiffuse * terminatorShadow;

                    // Fill light diffuse (not affected by terminator - it comes from opposite side)
                    float fillDiffuse = max(dot(normal, uFillDirection), 0.0);
                    lighting += uFillColor * uFillIntensity * fillDiffuse;

                    vec3 finalColor = uColor * lighting;
                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `,
    });
  }

  _spawnBots() {
    // Spawn bots to fill up to TARGET_TOTAL_PLAYERS minus human players
    // Initially spawn 299 (leaving room for local player = 300 total)
    const initialBotCount = this.TARGET_TOTAL_PLAYERS - 1; // 299 bots
    const botsPerFaction = Math.floor(initialBotCount / 3); // 99 each
    const remainder = initialBotCount % 3; // 2 extra bots to distribute
    const factionNames = ["viridian", "cobalt", "rust"];

    factionNames.forEach((faction, idx) => {
      // Distribute remainder across first factions (viridian gets +1, cobalt gets +1)
      const extra = idx < remainder ? 1 : 0;
      for (let i = 0; i < botsPerFaction + extra; i++) {
        this._createBot(faction);
      }
    });
  }

  _createBot(factionName) {
    const geom = this._sharedGeom;
    const mat = this._sharedMat[factionName];
    const group = new THREE.Group();

    // Body group — lean/wiggle applied here, not on outer group
    const bodyGroup = new THREE.Group();
    group.add(bodyGroup);

    // Hull (using shared geometry and material)
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

    // Turret group
    const turretGroup = new THREE.Group();
    turretGroup.position.y = 0.8;

    const turret = new THREE.Mesh(geom.turret, mat.turret);
    turret.position.y = 0.3;
    turret.castShadow = true;
    turret.receiveShadow = true;
    turretGroup.add(turret);

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

    bodyGroup.add(turretGroup);

    // Enable layer 1 on body meshes so SpotLights illuminate them
    bodyGroup.traverse((child) => {
      if (child.isMesh) child.layers.enable(1);
    });

    // Create hitbox for collision detection
    const hitbox = new THREE.Mesh(
      this._sharedGeom.hitbox,
      this._hitboxMaterial,
    );
    hitbox.position.set(0, 0.75, 0); // Center on tank body
    hitbox.userData.type = "tank";
    group.add(hitbox);

    // LOD box and shadow blob are rendered via InstancedMesh (see _setupInstancedMeshes)
    // No individual meshes created per bot — saves ~400 draw calls in orbital view

    // Commander mode: billboarded dot with shader-based dark outline
    const lodDot = new THREE.Mesh(
      this._lodDotGeometry,
      this._lodDotMaterials[factionName],
    );
    lodDot.position.set(0, 3, 0); // Slightly above tank
    lodDot.visible = false;
    lodDot.castShadow = false; // Don't cast shadows
    lodDot.receiveShadow = false;
    group.add(lodDot);

    // Custom raycast for billboarded dot (shader moves geometry, so use sphere check)
    // Use larger hit radius for easier targeting at distance
    const hitRadius = this._lodDotRadius * 2;
    lodDot.raycast = function (raycaster, intersects) {
      if (!this.visible) return;
      const worldPos = new THREE.Vector3();
      this.getWorldPosition(worldPos);
      const sphere = new THREE.Sphere(worldPos, hitRadius);
      const intersectPoint = new THREE.Vector3();
      if (raycaster.ray.intersectSphere(sphere, intersectPoint)) {
        // Use distance to dot center (not sphere edge) for proper sorting
        const distance = raycaster.ray.origin.distanceTo(worldPos);
        // Default near=0, far=Infinity if not set
        const near = raycaster.near || 0;
        const far = raycaster.far || Infinity;
        if (distance >= near && distance <= far) {
          intersects.push({
            distance: distance,
            point: intersectPoint.clone(),
            object: this,
          });
        }
      }
    };

    // Store bot data for interactions (name will be set by main.js when creating tags)
    const botIndex = this.bots.length;
    lodDot.userData = {
      playerId: `bot-${botIndex}`,
      faction: factionName,
      username: `Bot ${botIndex}`, // Default, updated when tag is created
      squad: null,
      isCommander: false,
    };

    // Gold outline for commanders (3D torus ring)
    const lodDotOutline = new THREE.Mesh(
      this._lodDotCommanderOutlineGeometry,
      this._lodDotCommanderOutlineMaterial,
    );
    lodDotOutline.position.set(0, 3, 0);
    lodDotOutline.rotation.x = Math.PI / 2; // Flat ring
    lodDotOutline.visible = false;
    lodDotOutline.castShadow = false;
    lodDotOutline.receiveShadow = false;
    group.add(lodDotOutline);

    // Store references to detailed meshes for LOD toggling
    const detailedMeshes = [
      hull,
      frontSlope,
      rear,
      leftTrack,
      rightTrack,
      turretGroup,
    ];

    // Random position on sphere (avoid poles and elevated terrain)
    let theta, phi;
    let spawnAttempts = 0;
    do {
      theta = Math.random() * Math.PI * 2;
      phi = 0.35 + Math.random() * (Math.PI - 0.7);
      spawnAttempts++;
    } while (
      spawnAttempts < 20 &&
      this.planet.terrainElevation &&
      this._isElevatedSphericalPos(theta, phi)
    );
    const heading = Math.random() * Math.PI * 2;

    // Position on sphere
    const r = this.sphereRadius;
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.sin(theta);

    group.position.set(x, y, z);

    // Orient to surface
    const up = new THREE.Vector3(x, y, z).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3();

    if (Math.abs(up.y) > 0.999) {
      east.crossVectors(new THREE.Vector3(0, 0, 1), up).normalize();
    } else {
      east.crossVectors(worldUp, up).normalize();
    }

    const north = new THREE.Vector3().crossVectors(up, east).normalize();

    const forward = new THREE.Vector3();
    forward.addScaledVector(north, Math.cos(heading));
    forward.addScaledVector(east, Math.sin(heading));
    forward.normalize();

    const target = group.position.clone().add(forward);
    group.up.copy(up);
    group.lookAt(target);

    const clusterId = this.planet.getClusterIdAtLocalPosition(group.position);

    this.planet.hexGroup.add(group);

    // Start hidden — bots deploy with staggered timers
    group.visible = false;

    // Store hitbox reference on bot object (set userData.tankRef after bot is created)
    const bot = {
      group,
      bodyGroup,
      turretGroup,
      hitbox,
      lodMesh: null, // Rendered via InstancedMesh
      lodDot,
      lodDotOutline,
      shadowBlob: null, // Rendered via InstancedMesh
      detailedMeshes,
      faction: factionName,
      theta,
      phi,
      heading,
      clusterId,
      // Deploy state — bot doesn't exist on planet until timer expires
      isDeploying: true,
      deployTimer: 1 + Math.random() * 12,
      // Health & damage state
      hp: 100,
      maxHp: 100,
      isDead: false,
      damageState: "healthy",
      // Player-compatible state object for dust/tracks systems
      state: {
        speed: 0,
        keys: { w: false, a: false, s: false, d: false },
        isDead: false,
        wigglePhase: Math.random() * Math.PI * 2, // Random starting phase
        turretAngle: Math.random() * Math.PI * 2,
        turretTargetAngle: 0,
        turretAngularVelocity: 0,
        lean: {
          pitchAngle: 0, pitchVelocity: 0,
          steerAngle: 0, steerVelocity: 0,
          prevSpeed: 0, prevHeading: 0,
          initialized: false,
        },
      },
      // AI state (separate from player-style state)
      aiState: BOT_STATES.IDLE,
      targetClusterId: null,
      targetPosition: null,
      maxSpeed: this.BOT_MAX_SPEED * (0.85 + Math.random() * 0.3),
      // turnRate is now calculated dynamically based on speed in _updateBotPhysics
      stateTimer: 0,
      personality: Math.random(),
      wanderDirection: Math.random() * Math.PI * 2,
      // Human-like behavior properties
      driftOffset: (Math.random() - 0.5) * 0.3, // Slight heading bias
      reactionDelay: Math.random() * 0.15, // Delayed steering response
      overcorrectChance: 0.02 + Math.random() * 0.03, // Occasional overcorrection
      pauseChance: 0.005 + Math.random() * 0.01, // Random micro-pauses
      isPaused: false,
      pauseTimer: 0,
      lastSteerDirection: 0, // Track last turn for smoothness
      steerMomentum: 0, // Smooths steering changes
      // Terrain navigation state
      _stuckCheckTheta: theta,
      _stuckCheckPhi: phi,
      _stuckCheckTimer: 0,
      _stuckCounter: 0,
      _terrainBounceCount: 0,
      _terrainAvoidTimer: 0,
      _centerBlocked: false,
      _terrainProbeFrame: 0,
      _lastTerrainThreat: null,
      // Pathfinding state
      pathWaypoints: [],
      currentWaypointIdx: 0,
      pathTargetCluster: null,
      _replanCount: 0,
    };

    // Store stable playerId on bot object (matches lodDot.userData.playerId)
    bot.playerId = lodDot.userData.playerId;

    // Set hitbox reference back to bot object
    hitbox.userData.tankRef = bot;

    this.bots.push(bot);
    this._factionBots[factionName].push(bot);

    // Register in TankCollision for physical push-apart
    if (this._tankCollision) {
      this._tankCollision.registerTank(`sbot-${bot.playerId}`, {
        group: bot.group,
        state: bot.state,
        isBot: true,
      });
    }
  }

  // ========================
  // MAIN UPDATE LOOP
  // ========================

  update(deltaTime, timestamp, camera = null) {
    // Deploy bots whose timers have expired
    for (const bot of this.bots) {
      if (!bot.isDeploying) continue;
      bot.deployTimer -= deltaTime;
      if (bot.deployTimer <= 0) {
        bot.isDeploying = false;
        bot.group.visible = true;
        if (this._dustShockwave) {
          const worldPos = new THREE.Vector3();
          bot.group.getWorldPosition(worldPos);
          this._dustShockwave.emit(worldPos, 0.4);
        }
      }
    }

    // Update faction coordinators (use cached faction arrays)
    for (const [faction, coordinator] of Object.entries(this.coordinators)) {
      coordinator.update(
        this._factionBots[faction],
        this.coordinators,
        timestamp,
      );
    }

    // Staggered AI state updates
    const botsPerFrame = 10;
    const startIdx = this._updateIndex;
    const endIdx = Math.min(startIdx + botsPerFrame, this.bots.length);

    for (let i = startIdx; i < endIdx; i++) {
      const bot = this.bots[i];
      if (bot.isDead || bot.isDeploying) continue;
      this._updateBotAIState(
        bot,
        deltaTime * (this.bots.length / botsPerFrame),
      );
    }

    this._updateIndex = endIdx >= this.bots.length ? 0 : endIdx;

    // Prepare frustum for visibility culling (reuse preallocated objects)
    const temp = this._cullTemp;
    let frustum = null;
    let cameraWorldPos = null;
    if (camera) {
      temp.projScreenMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      temp.frustum.setFromProjectionMatrix(temp.projScreenMatrix);
      camera.getWorldPosition(temp.cameraWorldPos);
      frustum = temp.frustum;
      cameraWorldPos = temp.cameraWorldPos;
    }

    // Update all bots every frame (matching player tank update order exactly)
    this.bots.forEach((bot) => {
      // Skip bots that haven't deployed yet
      if (bot.isDeploying) return;

      // Update fade for dead bots
      if (bot.isDead) {
        this._updateBotFade(bot);
        return; // Skip AI/movement for dead bots
      }

      // 1. AI decides which virtual keys to press
      this._updateBotInput(bot, deltaTime);

      // 2. Physics: apply keys to heading and speed (like player's _updatePhysics)
      this._updateBotPhysics(bot, deltaTime);

      // 3. Movement: move on sphere (like player's _moveOnSphere)
      this._moveOnSphere(bot, deltaTime);

      // 4. Visual: update position and orientation (like player's _updateVisual)
      Tank.updateLeanState(bot.state.lean, bot.state.speed, bot.heading, deltaTime, bot.isDead);
      this._updateBotVisual(bot, deltaTime);

      // 4b. Turret rotation (spring-based, matches player)
      this._updateBotTurret(bot, deltaTime);

      // 5. Visibility culling (sets bot._lodState for instanced rendering)
      if (camera && frustum) {
        this._updateBotVisibility(bot, frustum, cameraWorldPos);
      }
    });

    // 6. Batch-update InstancedMesh buffers for LOD boxes and shadow blobs
    this._updateInstancedLOD();
  }

  // ========================
  // VISIBILITY CULLING
  // ========================

  /**
   * Set LOD options for commander mode (colored dots instead of boxes)
   * Called from main.js each frame when in orbital view
   */
  setLODOptions(options) {
    this._lodOptions = options;
  }

  _updateBotVisibility(bot, frustum, cameraWorldPos) {
    // Use shared LOD update logic from Tank class
    // Sets bot._lodState: -1=hidden, 0=detail, 1=box, 2=dot
    Tank.updateTankLOD(bot, cameraWorldPos, frustum, this._lodOptions || {});
  }

  /**
   * Update InstancedMesh buffers for all bot LOD boxes and shadow blobs.
   * Called once per frame after all bot positions/visibility have been updated.
   * Reads bot._lodState (set by Tank.updateTankLOD) to determine which instances to write.
   */
  _updateInstancedLOD() {
    const temp = this._instanceTemp;

    // Reset instance counts
    const lodBoxCounts = { rust: 0, cobalt: 0, viridian: 0 };
    let shadowBlobCount = 0;

    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];

      // Only write instances for bots in "box" LOD state (state 1)
      // State -1: hidden (culled), 0: detail meshes, 2: dot (individual mesh)
      if (bot._lodState !== 1) continue;

      const faction = bot.faction;
      const boxIdx = lodBoxCounts[faction];
      const im = this._instancedLodBox[faction];

      if (boxIdx < im.instanceMatrix.count) {
        // Compose bot's local-to-hexGroup transform from current position/quaternion/scale
        temp.botMatrix.compose(bot.group.position, bot.group.quaternion, bot.group.scale);

        // LOD box: bot transform × offset (0, 0.75, 0)
        temp.matrix.copy(temp.botMatrix).multiply(this._lodBoxOffset);
        im.setMatrixAt(boxIdx, temp.matrix);
        lodBoxCounts[faction]++;

        // Shadow blob: bot transform × offset (0, -0.3, 0) + rotateX(-PI/2)
        temp.matrix.copy(temp.botMatrix).multiply(this._shadowBlobOffset);
        this._instancedShadowBlob.setMatrixAt(shadowBlobCount, temp.matrix);
        shadowBlobCount++;
      }
    }

    // Update instance counts and mark buffers dirty
    for (const faction of ["rust", "cobalt", "viridian"]) {
      const im = this._instancedLodBox[faction];
      im.count = lodBoxCounts[faction];
      if (im.count > 0) {
        im.instanceMatrix.needsUpdate = true;
      }
    }
    this._instancedShadowBlob.count = shadowBlobCount;
    if (shadowBlobCount > 0) {
      this._instancedShadowBlob.instanceMatrix.needsUpdate = true;
    }
  }

  // ========================
  // AI STATE MACHINE
  // ========================

  _updateBotAIState(bot, deltaTime) {
    bot.stateTimer += deltaTime;

    switch (bot.aiState) {
      case BOT_STATES.IDLE:
        if (bot.targetClusterId !== null && bot.targetClusterId !== undefined) {
          bot.pathWaypoints = []; // Force path computation in MOVING
          bot._replanCount = 0;
          bot.aiState = BOT_STATES.MOVING;
          bot.stateTimer = 0;
        } else if (bot.stateTimer > 1 + bot.personality * 2) {
          bot.aiState = BOT_STATES.WANDERING;
          bot.wanderDirection = bot.heading + (Math.random() - 0.5) * Math.PI;
          bot.stateTimer = 0;
        }
        break;

      case BOT_STATES.MOVING:
        // No target — wander
        if (
          bot.targetClusterId === null ||
          bot.targetClusterId === undefined
        ) {
          bot.pathWaypoints = [];
          bot.aiState = BOT_STATES.WANDERING;
          bot.stateTimer = 0;
          break;
        }

        // Reached target cluster
        if (bot.clusterId === bot.targetClusterId) {
          bot.pathWaypoints = [];
          bot.aiState = BOT_STATES.CAPTURING;
          bot.stateTimer = 0;
          break;
        }

        // Request path if we don't have one or target changed
        if (
          bot.pathWaypoints.length === 0 ||
          bot.pathTargetCluster !== bot.targetClusterId
        ) {
          this._requestPath(bot);
          if (bot.pathWaypoints.length === 0) {
            // No path found — abandon target
            bot.targetClusterId = null;
            bot.targetPosition = null;
            bot.aiState = BOT_STATES.IDLE;
            bot.stateTimer = 0;
            break;
          }
        }

        // Advance waypoints as bot reaches them
        if (bot.currentWaypointIdx < bot.pathWaypoints.length) {
          const wp = bot.pathWaypoints[bot.currentWaypointIdx];
          let dTheta = wp.theta - bot.theta;
          while (dTheta > Math.PI) dTheta -= Math.PI * 2;
          while (dTheta < -Math.PI) dTheta += Math.PI * 2;
          const dPhi = wp.phi - bot.phi;
          const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
          if (dist < 0.03) {
            bot.currentWaypointIdx++;
          }
        }

        // Stuck detection — re-plan path instead of random wandering
        if (this._checkStuck(bot)) {
          bot._stuckCounter = 0;
          bot._replanCount++;
          if (bot._replanCount >= 3) {
            // Too many re-plans — give up with aggressive escape heading
            bot._replanCount = 0;
            bot.pathWaypoints = [];
            bot.targetClusterId = null;
            bot.targetPosition = null;
            bot.wanderDirection = bot.heading + Math.PI * (0.5 + Math.random());
            bot.aiState = BOT_STATES.WANDERING;
            bot.stateTimer = 0;
            bot.state.speed = 0;
          } else {
            // Re-plan: reverse briefly to clear obstacle, then re-path
            bot.pathWaypoints = [];
            bot.wanderDirection = bot.heading + Math.PI;
            bot.state.speed = 0;
            bot._terrainAvoidTimer = 0.5;
          }
        }
        break;

      case BOT_STATES.CAPTURING: {
        const captureState = this.planet.clusterCaptureState.get(bot.clusterId);
        if (captureState && captureState.owner === bot.faction) {
          bot.targetClusterId = null;
          bot.targetPosition = null;
          bot.pathWaypoints = [];
          bot.aiState =
            bot.personality > 0.3 ? BOT_STATES.IDLE : BOT_STATES.WANDERING;
          bot.stateTimer = 0;
        } else if (
          bot.targetClusterId !== null &&
          bot.clusterId !== bot.targetClusterId
        ) {
          bot.pathWaypoints = []; // Force re-path
          bot.aiState = BOT_STATES.MOVING;
          bot.stateTimer = 0;
        }
        // Stuck detection while capturing — re-path to target
        if (this._checkStuck(bot)) {
          bot._stuckCounter = 0;
          bot.pathWaypoints = [];
          bot.wanderDirection = bot.heading + Math.PI + (Math.random() - 0.5) * 1.0;
          bot.state.speed = 0;
          bot._terrainAvoidTimer = 0.5;
          bot.aiState = BOT_STATES.MOVING;
          bot.stateTimer = 0;
        }
        break;
      }

      case BOT_STATES.WANDERING: {
        const wanderDuration = 3 + bot.personality * 5;
        if (bot.stateTimer > wanderDuration) {
          bot.aiState = BOT_STATES.IDLE;
          bot.stateTimer = 0;
        } else if (
          bot._terrainAvoidTimer <= 0 &&
          bot.targetClusterId !== null &&
          bot.targetClusterId !== undefined
        ) {
          bot.aiState = BOT_STATES.MOVING;
          bot.stateTimer = 0;
        }
        if (Math.random() < 0.01) {
          bot.wanderDirection += (Math.random() - 0.5) * 0.8;
        }
        // Stuck detection while wandering — pick new random direction
        if (this._checkStuck(bot)) {
          bot._stuckCounter = 0;
          bot.wanderDirection = bot.heading + Math.PI + (Math.random() - 0.5) * 1.0;
          bot.state.speed = 0;
          bot._terrainAvoidTimer = 0.5;
        }
        break;
      }
    }
  }

  // ========================
  // INPUT SIMULATION
  // ========================

  _updateBotInput(bot, deltaTime) {
    // Clear all keys each frame - just like player releasing all keys
    bot.state.keys = { w: false, a: false, s: false, d: false };

    // Tick down terrain avoidance cooldown
    if (bot._terrainAvoidTimer > 0) {
      bot._terrainAvoidTimer -= deltaTime;
    }

    // Omnidirectional separation force (anti-bunching, applied before all other steering)
    const separation = this._calculateSeparation(bot);
    if (separation !== 0) {
      bot.wanderDirection += separation;
    }

    // Target-directed steering: point wanderDirection toward current waypoint (or target)
    // Suppressed during terrain avoidance cooldown to prevent re-engagement
    if (bot._terrainAvoidTimer <= 0) {
      if (bot.aiState === BOT_STATES.MOVING) {
        const waypoint = this._getCurrentWaypoint(bot);
        if (waypoint) {
          const desiredHeading = this._computeDesiredHeadingTo(bot, waypoint);
          if (desiredHeading !== null) {
            let targetDiff = desiredHeading - bot.wanderDirection;
            while (targetDiff > Math.PI) targetDiff -= Math.PI * 2;
            while (targetDiff < -Math.PI) targetDiff += Math.PI * 2;
            // Personality-based blend rate: decisive bots track tighter
            const blendRate = 0.08 + bot.personality * 0.12;
            bot.wanderDirection += targetDiff * blendRate;
            bot.wanderDirection += bot.driftOffset * 0.06;
          }
        }
      } else if (bot.aiState === BOT_STATES.CAPTURING && bot.targetPosition) {
        const desiredHeading = this._computeDesiredHeading(bot);
        if (desiredHeading !== null) {
          let targetDiff = desiredHeading - bot.wanderDirection;
          while (targetDiff > Math.PI) targetDiff -= Math.PI * 2;
          while (targetDiff < -Math.PI) targetDiff += Math.PI * 2;
          bot.wanderDirection += targetDiff * 0.03;
        }
      }
    }

    // Check for nearby tanks to avoid
    const avoidance = this._detectCollisionThreat(bot);

    // Calculate heading difference to wander target
    let headingDiff = bot.wanderDirection - bot.heading;
    while (headingDiff > Math.PI) headingDiff -= Math.PI * 2;
    while (headingDiff < -Math.PI) headingDiff += Math.PI * 2;

    // GTA1-STYLE AI: tighter thresholds for instant steering
    const steerDeadZone = 0.05;
    const driveAngleLimit = 0.4;

    // Apply collision avoidance steering (overrides normal steering when threat detected)
    if (avoidance.threat > 0.1) {
      // High threat: forcefully redirect wanderDirection away from terrain
      // This prevents target attraction from pulling the bot back into terrain
      if (avoidance.threat > 0.3) {
        const avoidAngle = avoidance.steerDirection * (Math.PI / 2 + avoidance.threat * Math.PI / 4);
        bot.wanderDirection = bot.heading + avoidAngle;
      } else if (this._getCurrentWaypoint(bot) && bot._centerBlocked) {
        // Wall-following: slide along the wall in the direction closest to the goal
        const desired = this._computeDesiredHeadingTo(bot, this._getCurrentWaypoint(bot));
        if (desired !== null) {
          const avoidHeading = bot.heading + avoidance.steerDirection * (Math.PI / 2);
          const altHeading = bot.heading - avoidance.steerDirection * (Math.PI / 2);

          let diffAvoid = desired - avoidHeading;
          while (diffAvoid > Math.PI) diffAvoid -= Math.PI * 2;
          while (diffAvoid < -Math.PI) diffAvoid += Math.PI * 2;

          let diffAlt = desired - altHeading;
          while (diffAlt > Math.PI) diffAlt -= Math.PI * 2;
          while (diffAlt < -Math.PI) diffAlt += Math.PI * 2;

          const wallFollowHeading =
            Math.abs(diffAvoid) < Math.abs(diffAlt) ? avoidHeading : altHeading;

          bot.wanderDirection = wallFollowHeading;
        }
      }

      // Steer away from threat
      if (avoidance.steerDirection > 0) {
        bot.state.keys.d = true; // Turn right to avoid
      } else {
        bot.state.keys.a = true; // Turn left to avoid
      }

      // Slow down proportional to threat level
      if (avoidance.threat > 0.5) {
        // High threat - brake hard
        if (Math.abs(bot.state.speed) > this.BOT_MAX_SPEED * 0.2) {
          bot.state.keys.s = true;
        }
      } else if (avoidance.threat > 0.3) {
        // Medium threat - coast (don't accelerate)
        // Keys stay false, will naturally decelerate
      } else {
        // Low threat - slow down slightly but keep moving
        if (Math.abs(headingDiff) < driveAngleLimit * 1.5) {
          bot.state.keys.w = true;
        }
      }
    } else {
      // No collision threat - normal steering toward target
      if (headingDiff > steerDeadZone) {
        bot.state.keys.d = true; // Turn right
      } else if (headingDiff < -steerDeadZone) {
        bot.state.keys.a = true; // Turn left
      }

      // Drive forward when aligned
      if (Math.abs(headingDiff) < driveAngleLimit) {
        bot.state.keys.w = true;
      } else if (Math.abs(headingDiff) > Math.PI * 0.75) {
        // Very wrong direction - brake to help turn
        if (Math.abs(bot.state.speed) < this.BOT_MAX_SPEED * 0.3) {
          bot.state.keys.s = true;
        }
      }
    }

    // More frequent, smaller direction changes (smoother paths)
    if (Math.random() < 0.015) {
      bot.wanderDirection += (Math.random() - 0.5) * 1.2;
    }
  }

  /**
   * Omnidirectional separation force — repels from all nearby bots regardless of direction.
   * Returns a heading offset to blend into wanderDirection.
   */
  _calculateSeparation(bot) {
    let separationX = 0; // theta component
    let separationY = 0; // phi component
    const radius = this.BOT_SEPARATION_RADIUS;

    for (const other of this.bots) {
      if (other === bot || other.isDead || other.isDeploying) continue;

      let dTheta = bot.theta - other.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = bot.phi - other.phi;
      const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

      if (dist < radius && dist > 0.0001) {
        const weight = (1 - dist / radius);
        const factor = weight * weight; // quadratic falloff
        separationX += (dTheta / dist) * factor;
        separationY += (dPhi / dist) * factor;
      }
    }

    // Also repel from player tank
    if (this.playerTankRef && this.playerTankRef.state && !this.playerTankRef.state.isDead) {
      let dTheta = bot.theta - this.playerTankRef.state.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = bot.phi - this.playerTankRef.state.phi;
      const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

      if (dist < radius && dist > 0.0001) {
        const weight = (1 - dist / radius);
        const factor = weight * weight;
        separationX += (dTheta / dist) * factor;
        separationY += (dPhi / dist) * factor;
      }
    }

    if (separationX === 0 && separationY === 0) return 0;

    const repulsionHeading = Math.atan2(separationX * Math.max(0.1, Math.sin(bot.phi)), separationY);
    let offset = repulsionHeading - bot.wanderDirection;
    while (offset > Math.PI) offset -= Math.PI * 2;
    while (offset < -Math.PI) offset += Math.PI * 2;

    return offset * this.BOT_SEPARATION_STRENGTH;
  }

  /**
   * Detect tanks ahead that pose a collision threat
   * @param {Object} bot - The bot to check
   * @returns {Object} { threat: 0-1, steerDirection: -1 or 1 }
   */
  _detectCollisionThreat(bot) {
    let botThreat = 0;
    let botSteer = 0;

    const avoidDist = this.BOT_AVOID_DISTANCE;
    const avoidAngle = this.BOT_AVOID_ANGLE;
    const botHeading = bot.heading;

    // Check other bots
    for (const otherBot of this.bots) {
      if (otherBot === bot) continue;
      if (otherBot.isDead || otherBot.isDeploying) continue;

      const threat = this._calculateThreat(
        bot.theta,
        bot.phi,
        botHeading,
        otherBot.theta,
        otherBot.phi,
        avoidDist,
        avoidAngle,
      );

      if (threat.level > botThreat) {
        botThreat = threat.level;
        botSteer = threat.steerDirection;
      }
    }

    // Check player tank if registered
    if (
      this.playerTankRef &&
      this.playerTankRef.state &&
      !this.playerTankRef.state.isDead
    ) {
      const threat = this._calculateThreat(
        bot.theta,
        bot.phi,
        botHeading,
        this.playerTankRef.state.theta,
        this.playerTankRef.state.phi,
        avoidDist,
        avoidAngle,
      );

      if (threat.level > botThreat) {
        botThreat = threat.level;
        botSteer = threat.steerDirection;
      }
    }

    // Check terrain elevation threats (every 3rd frame to reduce probe overhead)
    let terrainThreat = 0;
    let terrainSteer = 0;
    if (this.planet.terrainElevation) {
      bot._terrainProbeFrame = (bot._terrainProbeFrame || 0) + 1;
      if (bot._terrainProbeFrame >= 3) {
        bot._terrainProbeFrame = 0;
        const t = this._detectTerrainThreat(bot);
        bot._lastTerrainThreat = t;
      }
      const cachedTerrain = bot._lastTerrainThreat;
      if (cachedTerrain) {
        terrainThreat = cachedTerrain.level;
        terrainSteer = cachedTerrain.steerDirection;
      }
    }

    // Additive blend: both threats contribute instead of winner-take-all
    const combinedThreat = Math.min(1.0, botThreat + terrainThreat);
    let steerDirection;
    if (botThreat > 0 && terrainThreat > 0) {
      const totalWeight = botThreat + terrainThreat;
      const blended = (botSteer * botThreat + terrainSteer * terrainThreat) / totalWeight;
      steerDirection = blended >= 0 ? 1 : -1;
    } else if (terrainThreat > 0) {
      steerDirection = terrainSteer;
    } else {
      steerDirection = botSteer;
    }

    return {
      threat: combinedThreat * this.BOT_AVOID_STRENGTH,
      steerDirection: steerDirection,
    };
  }

  /**
   * Calculate threat level from a single obstacle
   */
  _calculateThreat(
    botTheta,
    botPhi,
    botHeading,
    obstacleTheta,
    obstaclePhi,
    avoidDist,
    avoidAngle,
  ) {
    // Calculate angular distance
    let dTheta = obstacleTheta - botTheta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    const dPhi = obstaclePhi - botPhi;
    const angularDist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    // Too far away - no threat
    if (angularDist > avoidDist) {
      return { level: 0, steerDirection: 0 };
    }

    // Calculate angle to obstacle relative to bot's heading
    // Convert theta/phi offset to local heading-relative angle
    const angleToObstacle = Math.atan2(-dTheta, -dPhi);
    let relativeAngle = angleToObstacle - botHeading;
    while (relativeAngle > Math.PI) relativeAngle -= Math.PI * 2;
    while (relativeAngle < -Math.PI) relativeAngle += Math.PI * 2;

    // Check if obstacle is within forward cone
    if (Math.abs(relativeAngle) > avoidAngle) {
      return { level: 0, steerDirection: 0 };
    }

    // Calculate threat level (closer = higher threat, more centered = higher threat)
    const distanceFactor = 1 - angularDist / avoidDist;
    const angleFactor = 1 - Math.abs(relativeAngle) / avoidAngle;
    const threatLevel = distanceFactor * angleFactor;

    // Determine steer direction: steer away from obstacle
    // If obstacle is to our left (negative angle), steer right (+1)
    // If obstacle is to our right (positive angle), steer left (-1)
    // If dead center, pick based on a small bias to avoid oscillation
    let steerDir;
    if (Math.abs(relativeAngle) < 0.1) {
      // Nearly dead ahead - steer based on which side has more space
      steerDir = dTheta > 0 ? -1 : 1;
    } else {
      steerDir = relativeAngle < 0 ? 1 : -1;
    }

    return { level: threatLevel, steerDirection: steerDir };
  }

  // ========================
  // TERRAIN HELPERS
  // ========================

  /**
   * 5-probe oriented-box terrain collision check for bots.
   * Matches Tank._isTerrainBlocked and GameRoom._isTerrainBlockedAt.
   * @returns {boolean} true if any probe hits terrain or polar hole
   */
  _isBotTerrainBlocked(theta, phi, heading, speed) {
    const r = this.sphereRadius;
    const sinPhi = Math.sin(phi);
    const safeSinPhi = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
    const dir = speed > 0 ? 1 : speed < 0 ? -1 : 0;
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);

    // Forward/right unit vectors in (dPhi, dTheta) space
    const fwdPhi = -cosH;
    const fwdTh = -sinH / safeSinPhi;
    const rgtPhi = sinH;
    const rgtTh = -cosH / safeSinPhi;

    const HALF_LEN = 2.75;
    const HALF_WID = 1.5;
    const probes = [
      [0, 0],
      [HALF_LEN * dir, -HALF_WID],
      [HALF_LEN * dir, HALF_WID],
      [-HALF_LEN * dir, -HALF_WID],
      [-HALF_LEN * dir, HALF_WID],
    ];

    for (const [fwd, rgt] of probes) {
      const pPhi = phi + (fwdPhi * fwd + rgtPhi * rgt) / r;
      const pTh = theta + (fwdTh * fwd + rgtTh * rgt) / r;

      // Convert to Cartesian for client-side terrain lookup
      const pSinPhi = Math.sin(pPhi);
      this._terrainTemp.testPos.set(
        r * pSinPhi * Math.cos(pTh),
        r * Math.cos(pPhi),
        r * pSinPhi * Math.sin(pTh),
      );

      // Check polar hole
      if (this.planet.isInsidePolarHole) {
        const localPos = this._terrainTemp.testPos.clone();
        this.planet.hexGroup.worldToLocal(localPos);
        if (this.planet.isInsidePolarHole(localPos)) return true;
      }

      // Check terrain elevation
      if (this.planet.terrainElevation.getElevationAtPosition(this._terrainTemp.testPos) > 0) {
        return true;
      }
    }
    return false;
  }

  _isElevatedSphericalPos(theta, phi) {
    const r = this.sphereRadius;
    this._terrainTemp.testPos.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    // Check polar hole first
    if (this.planet.isInsidePolarHole) {
      const localPos = this._terrainTemp.testPos.clone();
      this.planet.hexGroup.worldToLocal(localPos);
      if (this.planet.isInsidePolarHole(localPos)) return true;
    }
    return (
      this.planet.terrainElevation.getElevationAtPosition(
        this._terrainTemp.testPos,
      ) > 0
    );
  }

  _detectTerrainThreat(bot) {
    // Wide probe cone: 7 angles spanning ±1.2 radians (69° each side)
    // Reduced probe distances (pathfinding handles long-range routing)
    const probeAngles = [-1.2, -0.7, -0.35, 0, 0.35, 0.7, 1.2];
    const probeDistances = [0.02, 0.04, 0.07];
    const maxProbeDist = 0.07;
    let maxThreat = 0;
    let leftThreat = 0;
    let rightThreat = 0;
    let centerBlocked = false;

    const r = this.sphereRadius;
    const botSinPhi = Math.max(0.1, Math.sin(bot.phi));

    for (const dist of probeDistances) {
      for (const angleOffset of probeAngles) {
        const probeHeading = bot.heading + Math.PI + angleOffset;
        const probePhi = bot.phi - Math.cos(probeHeading) * dist;
        const probeTheta =
          bot.theta - (Math.sin(probeHeading) * dist) / botSinPhi;

        this._terrainTemp.testPos.set(
          r * Math.sin(probePhi) * Math.cos(probeTheta),
          r * Math.cos(probePhi),
          r * Math.sin(probePhi) * Math.sin(probeTheta),
        );

        // Check both elevation AND polar holes
        let blocked = false;
        const elevation = this.planet.terrainElevation.getElevationAtPosition(
          this._terrainTemp.testPos,
        );
        if (elevation > 0) {
          blocked = true;
        } else if (this.planet.isInsidePolarHole) {
          const localPos = this._terrainTemp.testPos.clone();
          this.planet.hexGroup.worldToLocal(localPos);
          if (this.planet.isInsidePolarHole(localPos)) blocked = true;
        }

        if (blocked) {
          const distThreat = 1 - dist / maxProbeDist;
          const angleThreat = 1 - Math.abs(angleOffset) / 1.5;
          const threat = distThreat * angleThreat;

          if (threat > maxThreat) maxThreat = threat;

          if (angleOffset < -0.1) leftThreat += threat;
          else if (angleOffset > 0.1) rightThreat += threat;
          else {
            leftThreat += threat * 0.5;
            rightThreat += threat * 0.5;
            if (dist <= 0.04) centerBlocked = true;
          }
        }
      }
    }

    bot._centerBlocked = centerBlocked;

    let steerDir = leftThreat > rightThreat ? 1 : -1;

    // When left/right threat is nearly tied, break toward waypoint/target
    const tiebreakTarget = this._getCurrentWaypoint(bot);
    if (Math.abs(leftThreat - rightThreat) < 0.1 && tiebreakTarget) {
      const desired = this._computeDesiredHeadingTo(bot, tiebreakTarget);
      if (desired !== null) {
        let diff = desired - bot.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        steerDir = diff > 0 ? 1 : -1;
      }
    }

    return { level: maxThreat, steerDirection: steerDir };
  }

  _computeDesiredHeading(bot) {
    if (!bot.targetPosition) return null;
    return this._computeDesiredHeadingTo(bot, bot.targetPosition);
  }

  _computeDesiredHeadingTo(bot, target) {
    if (!target) return null;

    const dPhi = target.phi - bot.phi;
    let dTheta = target.theta - bot.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    // Heading points AWAY from target so the cannon (+Z) faces toward it.
    // With negative-speed-forward convention, the tank drives toward the target
    // while the cannon (visual front) aims at it.
    const sinPhi = Math.max(0.1, Math.sin(bot.phi));
    return Math.atan2(dTheta * sinPhi, dPhi);
  }

  _checkStuck(bot) {
    bot._stuckCheckTimer += 1 / 60;
    if (bot._stuckCheckTimer < this.BOT_STUCK_CHECK_INTERVAL) return false;

    bot._stuckCheckTimer = 0;

    let dTheta = bot.theta - bot._stuckCheckTheta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const dPhi = bot.phi - bot._stuckCheckPhi;
    const distMoved = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    bot._stuckCheckTheta = bot.theta;
    bot._stuckCheckPhi = bot.phi;

    // At max speed, bot covers ~0.00022 * 60 * 2 = 0.0264 radians in 2s
    const expectedDistance = bot.maxSpeed * 60 * this.BOT_STUCK_CHECK_INTERVAL * 0.2;
    if (distMoved < expectedDistance) {
      bot._stuckCounter++;
    } else {
      bot._stuckCounter = 0;
      bot._terrainBounceCount = 0;
    }

    return bot._stuckCounter >= this.BOT_STUCK_THRESHOLD;
  }

  // ========================
  // PATHFINDING
  // ========================

  setPathfinder(pathfinder) {
    this.pathfinder = pathfinder;
    // Also wire to faction coordinators
    if (this.coordinators) {
      for (const coordinator of Object.values(this.coordinators)) {
        coordinator.setPathfinder(pathfinder);
      }
    }
  }

  _requestPath(bot) {
    if (!this.pathfinder) return;

    const fromTile = this._getNearestTraversableTile(bot);
    if (fromTile === -1) return;

    const toTile = this.pathfinder.getClusterCenterTile(bot.targetClusterId);
    if (toTile === -1) return;

    const path = this.pathfinder.findPath(fromTile, toTile);
    if (path && path.length > 0) {
      bot.pathWaypoints = this.pathfinder.pathToWaypoints(path);
      // Add perpendicular jitter to intermediate waypoints to spread bots across corridor
      if (bot.pathWaypoints.length > 2) {
        const jitterSign = bot.driftOffset > 0 ? 1 : -1;
        const jitterAmount = 0.008 * (0.5 + Math.random() * 0.5) * jitterSign;
        for (let i = 1; i < bot.pathWaypoints.length - 1; i++) {
          const wp = bot.pathWaypoints[i];
          const prev = bot.pathWaypoints[i - 1];
          const dTheta = wp.theta - prev.theta;
          const dPhi = wp.phi - prev.phi;
          const len = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
          if (len > 0.001) {
            wp.theta += (-dPhi / len) * jitterAmount;
            wp.phi += (dTheta / len) * jitterAmount;
          }
        }
      }
      bot.currentWaypointIdx = 0;
      bot.pathTargetCluster = bot.targetClusterId;
      bot._replanCount = 0;
    } else {
      // No path — clear so bot gets reassigned
      bot.pathWaypoints = [];
      bot.currentWaypointIdx = 0;
      bot.pathTargetCluster = null;
    }
  }

  _getNearestTraversableTile(bot) {
    if (!this.pathfinder) return -1;
    return this.pathfinder.getNearestTraversableTile(bot.theta, bot.phi);
  }

  /**
   * Get the current steering waypoint for a bot.
   * Returns the next waypoint along the path, or falls back to targetPosition.
   */
  _getCurrentWaypoint(bot) {
    if (
      bot.pathWaypoints.length > 0 &&
      bot.currentWaypointIdx < bot.pathWaypoints.length
    ) {
      return bot.pathWaypoints[bot.currentWaypointIdx];
    }
    return bot.targetPosition;
  }

  // ========================
  // PHYSICS (Player-style)
  // ========================

  _updateBotPhysics(bot, deltaTime = 1 / 60) {
    const keys = bot.state.keys;

    // Scale physics by deltaTime (normalized to 60 FPS baseline)
    const dt60 = deltaTime * 60;

    // GTA1-STYLE SPEED-DEPENDENT STEERING
    const speedRatio = Math.abs(bot.state.speed) / bot.maxSpeed;
    const turnReduction = speedRatio * this.BOT_TURN_SPEED_FACTOR;
    const currentTurnRate = MathUtils.lerp(
      this.BOT_BASE_TURN_RATE,
      this.BOT_MIN_TURN_RATE,
      turnReduction,
    );

    // Apply steering (instant response like GTA1) - scaled by deltaTime
    let steerInput = 0;
    if (keys.a) steerInput = -1;
    if (keys.d) steerInput = 1;

    if (steerInput !== 0) {
      const turnAmount = steerInput * currentTurnRate * dt60;
      // Rear-pivot: turns are slightly more dramatic at speed
      const pivotMultiplier = 1.0 + speedRatio * this.BOT_PIVOT_OFFSET;
      bot.heading += turnAmount * pivotMultiplier;
    }

    // Normalize heading to [0, 2PI]
    while (bot.heading < 0) bot.heading += Math.PI * 2;
    while (bot.heading >= Math.PI * 2) bot.heading -= Math.PI * 2;

    // GTA1-STYLE ACCELERATION - scaled by deltaTime
    // Negative speed = forward (cannon faces heading, model drives opposite)
    if (keys.w) {
      bot.state.speed -= this.BOT_ACCELERATION * dt60;
      if (bot.state.speed < -bot.maxSpeed) {
        bot.state.speed = -bot.maxSpeed;
      }
    } else if (keys.s) {
      if (bot.state.speed < 0) {
        // Brake first (faster than deceleration)
        bot.state.speed += this.BOT_DECELERATION * 2.5 * dt60;
        if (bot.state.speed > 0) bot.state.speed = 0;
      } else {
        // Then reverse (positive speed = visual backward, slower than forward)
        bot.state.speed += this.BOT_ACCELERATION * 0.6 * dt60;
        if (bot.state.speed > bot.maxSpeed * 0.5) {
          bot.state.speed = bot.maxSpeed * 0.5;
        }
      }
    } else {
      // Coast to stop
      if (bot.state.speed > 0) {
        bot.state.speed -= this.BOT_DECELERATION * dt60;
        if (bot.state.speed < 0) bot.state.speed = 0;
      } else if (bot.state.speed < 0) {
        bot.state.speed += this.BOT_DECELERATION * dt60;
        if (bot.state.speed > 0) bot.state.speed = 0;
      }
    }
  }

  // ========================
  // MOVEMENT (custom pole-aware movement for bots)
  // ========================

  _moveOnSphere(bot, deltaTime = 1 / 60) {
    const prevTheta = bot.theta;
    const prevPhi = bot.phi;

    const speed = bot.state.speed;
    const heading = bot.heading;
    const phi = bot.phi;

    const dt60 = deltaTime * 60;

    // Calculate distance from each pole
    const distFromNorthPole = phi; // phi=0 is north pole
    const distFromSouthPole = Math.PI - phi; // phi=PI is south pole
    const distFromNearestPole = Math.min(distFromNorthPole, distFromSouthPole);

    // FIX 1: Smooth pole repulsion
    // Apply a gentle push away from poles when within soft limit
    let poleRepulsion = 0;
    if (distFromNearestPole < this.BOT_POLE_SOFT_LIMIT) {
      // Quadratic falloff - stronger as bot gets closer to pole
      const repulsionFactor =
        1 - distFromNearestPole / this.BOT_POLE_SOFT_LIMIT;
      const repulsionStrength =
        repulsionFactor * repulsionFactor * this.BOT_POLE_REPULSION_STRENGTH;

      // Push toward equator (positive repulsion for north pole, negative for south)
      if (distFromNorthPole < distFromSouthPole) {
        poleRepulsion = repulsionStrength; // Push south (increase phi)
      } else {
        poleRepulsion = -repulsionStrength; // Push north (decrease phi)
      }
    }

    // FIX 2: Scale east-west movement near poles to prevent theta explosion
    // As sin(phi) approaches 0, we reduce effective east-west movement
    const sinPhi = Math.sin(phi);
    const poleMovementScale = Math.min(
      1.0,
      sinPhi / Math.sin(this.BOT_POLE_SOFT_LIMIT),
    );

    // Convert speed in heading direction to north/east components
    const velocityNorth = Math.cos(heading) * speed * dt60;
    const velocityEast = -Math.sin(heading) * speed * dt60 * poleMovementScale;

    // Convert tangent plane velocity to spherical coordinate changes
    const dPhi = -velocityNorth + poleRepulsion * dt60;

    // Safe theta calculation - avoid division by very small numbers
    const safeSinPhi = Math.max(0.1, sinPhi); // Floor to prevent huge theta jumps
    const dTheta = velocityEast / safeSinPhi;

    bot.phi += dPhi;
    bot.theta += dTheta;

    // Hard clamp as safety net (tighter than before due to soft repulsion)
    bot.phi = Math.max(
      this.BOT_POLE_HARD_LIMIT,
      Math.min(Math.PI - this.BOT_POLE_HARD_LIMIT, bot.phi),
    );

    // Wrap longitude
    while (bot.theta > Math.PI * 2) bot.theta -= Math.PI * 2;
    while (bot.theta < 0) bot.theta += Math.PI * 2;

    // 5-probe terrain collision with wall-sliding
    if (this.planet.terrainElevation && bot.state.speed !== 0) {
      const blocked = this._isBotTerrainBlocked(bot.theta, bot.phi, heading, bot.state.speed);

      if (blocked) {
        // Try theta-only slide (keep new theta, revert phi)
        const thetaOnlyBlocked = this._isBotTerrainBlocked(bot.theta, prevPhi, heading, bot.state.speed);
        // Try phi-only slide (revert theta, keep new phi)
        const phiOnlyBlocked = this._isBotTerrainBlocked(prevTheta, bot.phi, heading, bot.state.speed);

        if (!thetaOnlyBlocked) {
          // Slide along theta (east-west)
          bot.phi = prevPhi;
          bot.state.speed *= 0.85;
        } else if (!phiOnlyBlocked) {
          // Slide along phi (north-south)
          bot.theta = prevTheta;
          bot.state.speed *= 0.85;
        } else {
          // Both axes blocked — full revert with speed decay
          bot.theta = prevTheta;
          bot.phi = prevPhi;
          bot.state.speed *= this.BOT_COLLISION_SPEED_RETAIN;
        }

        // Suppress target-seeking to prevent immediate re-engagement
        bot._terrainAvoidTimer = this.BOT_TERRAIN_AVOID_COOLDOWN;

        // Track bounce frequency for oscillation detection
        bot._terrainBounceCount++;

        if (bot._terrainBounceCount >= this.BOT_TERRAIN_BOUNCE_LIMIT) {
          // Oscillating — reverse to break the pattern
          bot.wanderDirection = bot.heading + Math.PI + (Math.random() - 0.5) * 0.5;
          bot._terrainBounceCount = 0;
        } else {
          // Normal redirect: steer 90-270° away
          bot.wanderDirection = bot.heading + Math.PI * (0.5 + Math.random());
        }
      }
    }
  }

  _updateBotTurret(bot, deltaTime) {
    // Bots aim turret forward along heading
    bot.state.turretTargetAngle = 0;

    const tp = this.botTurretPhysics;
    const s = bot.state;

    let delta = s.turretTargetAngle - s.turretAngle;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;

    s.turretAngularVelocity +=
      (tp.stiffness * delta - tp.damping * s.turretAngularVelocity) * deltaTime;

    if (s.turretAngularVelocity > tp.maxAngularSpeed) {
      s.turretAngularVelocity = tp.maxAngularSpeed;
    } else if (s.turretAngularVelocity < -tp.maxAngularSpeed) {
      s.turretAngularVelocity = -tp.maxAngularSpeed;
    }

    if (Math.abs(delta) < 0.001 && Math.abs(s.turretAngularVelocity) < 0.01) {
      s.turretAngle = s.turretTargetAngle;
      s.turretAngularVelocity = 0;
    } else {
      s.turretAngle += s.turretAngularVelocity * deltaTime;
    }

    while (s.turretAngle < 0) s.turretAngle += Math.PI * 2;
    while (s.turretAngle >= Math.PI * 2) s.turretAngle -= Math.PI * 2;

    bot.turretGroup.rotation.y = s.turretAngle;
  }

  _updateBotVisual(bot, deltaTime = 0) {
    // Custom visual update for bots (can't use Tank.updateEntityVisual because
    // bots are children of hexGroup which rotates, requiring quaternion-based orientation)
    const { theta, phi, heading } = bot;
    // Lower bots into the ground so tracks maintain contact with surface
    const r = this.sphereRadius - 0.4;

    // Update wiggle phase based on speed
    const speed = Math.abs(bot.state.speed);
    if (speed > 0.00001 && deltaTime > 0) {
      // Wiggle frequency: faster base rate + speed-dependent increase
      // At max speed (~0.00022), frequency is about 20-30 rad/s (~4-5 Hz)
      const speedRatio = Math.min(speed / 0.00025, 1);
      bot.state.wigglePhase += deltaTime * (12 + speedRatio * 18);
    }

    // Spherical to Cartesian (local to hexGroup)
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.sin(theta);

    bot.group.position.set(x, y, z);

    // Surface normal (up vector) - this is the direction away from planet center
    const up = new THREE.Vector3(x, y, z).normalize();

    // Calculate tangent plane basis vectors
    const worldUp = new THREE.Vector3(0, 1, 0);
    let east = new THREE.Vector3();

    if (Math.abs(up.y) > 0.999) {
      // Near poles - use Z axis as reference
      east.crossVectors(new THREE.Vector3(0, 0, 1), up).normalize();
    } else {
      // Standard case - east is perpendicular to up and world-up
      east.crossVectors(worldUp, up).normalize();
    }

    // North completes the orthonormal basis
    const north = new THREE.Vector3().crossVectors(up, east).normalize();

    // Forward direction based on heading in tangent plane
    const forward = new THREE.Vector3();
    forward.addScaledVector(north, Math.cos(heading));
    forward.addScaledVector(east, Math.sin(heading));
    forward.normalize();

    // Build rotation matrix from basis vectors (forward, up, right)
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();

    // Create rotation matrix: columns are right, up, -forward (THREE.js convention)
    const rotationMatrix = new THREE.Matrix4();
    rotationMatrix.makeBasis(right, up, forward.clone().negate());

    // Extract quaternion from matrix
    bot.group.quaternion.setFromRotationMatrix(rotationMatrix);

    // Apply lean + wiggle to bodyGroup (so headlights, hitbox, projectile origin on outer group are unaffected)
    if (bot.bodyGroup) bot.bodyGroup.quaternion.identity();

    // Apply momentum lean (pitch + steer) before wiggle
    const leanTarget = bot.bodyGroup || bot.group;
    if (bot.state.lean) {
      if (bot.state.lean.pitchAngle !== 0) {
        _botPitchQuat.setFromAxisAngle(_botPitchAxis, bot.state.lean.pitchAngle);
        leanTarget.quaternion.multiply(_botPitchQuat);
      }
      if (bot.state.lean.steerAngle !== 0) {
        _botSteerQuat.setFromAxisAngle(_botZAxis, bot.state.lean.steerAngle);
        leanTarget.quaternion.multiply(_botSteerQuat);
      }
    }

    // Apply roll wiggle around forward axis if moving (skip for dead bots)
    if (speed > 0.00001 && !bot.isDead) {
      const hpPercent = Math.max(bot.hp / bot.maxHp, 0);
      const wiggleMultiplier = 1 + (1 - hpPercent) * 3;
      const baseMaxWiggle = 0.035;
      const maxWiggle = baseMaxWiggle * wiggleMultiplier;
      const speedRatio = Math.min(speed / 0.0004, 1);
      const wiggleAmount = speedRatio * maxWiggle;
      const rollAngle = Math.sin(bot.state.wigglePhase) * wiggleAmount;

      _botRollQuat.setFromAxisAngle(_botZAxis, rollAngle);
      leanTarget.quaternion.multiply(_botRollQuat);
    }

    // Update cluster ID (bot-specific)
    bot.clusterId = this.planet.getClusterIdAtLocalPosition(bot.group.position);

    // Counter-rotate lodDot position so raycast matches visual appearance
    // (Shader billboards the dot, but raycast uses mesh world position)
    if (bot.lodDot) {
      const dotHeight = 3;
      const inverseQuat = new THREE.Quaternion();
      bot.group.getWorldQuaternion(inverseQuat);
      inverseQuat.invert();

      // Surface normal in WORLD space (transform from hexGroup local space)
      // 'up' is in hexGroup local coords, need world coords for the math to work
      const worldUp = new THREE.Vector3();
      bot.group.getWorldPosition(worldUp);
      worldUp.normalize();
      const localDotOffset = worldUp.multiplyScalar(dotHeight);

      // Transform world-space offset to local-space
      localDotOffset.applyQuaternion(inverseQuat);

      bot.lodDot.position.copy(localDotOffset);

      // Keep commander outline at same position
      if (bot.lodDotOutline) {
        bot.lodDotOutline.position.copy(localDotOffset);
      }
    }
  }

  // ========================
  // CHAT SYSTEM
  // ========================

  /**
   * Set the chat system reference (called from main init)
   */
  setChatSystem(proximityChat, playerTags) {
    this.proximityChat = proximityChat;
    this.playerTags = playerTags;
  }

  /**
   * Set the player tank reference for collision avoidance
   * @param {Object} playerTank - The player's Tank instance (with state.theta, state.phi, state.isDead)
   */
  setPlayerTank(playerTank) {
    this.playerTankRef = playerTank;
  }

  setDustShockwave(dustShockwave) {
    this._dustShockwave = dustShockwave;
  }

  /**
   * Set TankCollision reference for physical push-apart.
   * Bots will be registered on spawn for collision detection.
   * @param {TankCollision} tankCollision
   */
  setTankCollision(tankCollision) {
    this._tankCollision = tankCollision;
    // Register any already-spawned bots
    for (const bot of this.bots) {
      const tankId = `sbot-${bot.playerId}`;
      tankCollision.registerTank(tankId, {
        group: bot.group,
        state: bot.state,
        isBot: true,
      });
    }
  }

  /**
   * Update bot chat - called each frame
   * Chat frequency scales with proximity to enemies
   */
  updateChat(timestamp) {
    if (!this.proximityChat || !this.playerTags) return;

    // Respect global cooldown
    if (timestamp - this.lastChatTime < this.chatCooldown) return;

    // Check each bot for chat chance
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];

      // Find this bot's tag ID (use stable playerId, not array index)
      const botTagId = bot.playerId;
      const botTag = this.playerTags.tags.get(botTagId);
      if (!botTag) continue;

      // Mostly chat when visible/nearby, but 20% chance to chat from anywhere
      const isVisible = botTag.element.style.display !== "none";
      if (!isVisible && Math.random() > 0.2) continue;

      // Find nearby tanks and closest enemy distance
      const { names: nearbyNames, closestDist } = this._findNearbyTankNames(bot, i);

      // Scale chat chance by proximity — closer enemies = much more chatty
      let chatChance;
      if (closestDist < this.chatProximityRadius) {
        // Lerp from boosted (at dist=0) to base (at radius edge)
        const t = closestDist / this.chatProximityRadius;
        chatChance = this.chatChanceNearby * (1 - t) + this.chatChanceBase * t;
      } else {
        chatChance = this.chatChanceBase;
      }

      if (Math.random() > chatChance) continue;

      // Get trash talk (with or without target)
      const targetName =
        nearbyNames.length > 0
          ? nearbyNames[Math.floor(Math.random() * nearbyNames.length)]
          : null;

      const message = this.proximityChat.getRandomTrashTalk(targetName);

      // Randomly send to squad, faction, or lobby chat
      const channels = ["squad", "faction", "lobby"];
      const chatChannel = channels[Math.floor(Math.random() * channels.length)];
      this.proximityChat.addMessage(botTagId, message, chatChannel);
      this.lastChatTime = timestamp;

      // Only one bot chats per cooldown period
      break;
    }
  }

  /**
   * Find names of tanks near a given bot and the closest enemy distance
   * @param {Object} bot - The bot looking for nearby tanks
   * @param {number} botIndex - This bot's index (to exclude self)
   * @returns {{ names: string[], closestDist: number }}
   */
  _findNearbyTankNames(bot, botIndex) {
    const names = [];
    const radius = this.chatProximityRadius;
    let closestDist = Infinity;

    // Check player distance (use actual spherical distance, not just visibility)
    if (this.playerTankRef && !this.playerTankRef.state.isDead) {
      const playerTag = this.playerTags.tags.get("player");
      if (playerTag) {
        let dTheta = Math.abs(bot.theta - this.playerTankRef.state.theta);
        if (dTheta > Math.PI) dTheta = 2 * Math.PI - dTheta;
        const dPhi = Math.abs(bot.phi - this.playerTankRef.state.phi);
        const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

        if (dist < closestDist) closestDist = dist;
        if (dist < radius) {
          names.push(playerTag.config.name);
        }
      }
    }

    // Check other bots (enemy faction only)
    for (let i = 0; i < this.bots.length; i++) {
      if (i === botIndex) continue;

      const otherBot = this.bots[i];
      if (otherBot.faction === bot.faction) continue;

      let dTheta = Math.abs(bot.theta - otherBot.theta);
      if (dTheta > Math.PI) dTheta = 2 * Math.PI - dTheta;
      const dPhi = Math.abs(bot.phi - otherBot.phi);
      const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

      if (dist < closestDist) closestDist = dist;
      if (dist < radius) {
        const otherTag = this.playerTags.tags.get(this.bots[i].playerId);
        if (otherTag) {
          names.push(otherTag.config.name);
        }
      }
    }

    return { names, closestDist };
  }

  // ========================
  // DAMAGE SYSTEM
  // ========================

  /**
   * Apply damage to a bot
   * @param {Object} bot - The bot object
   * @param {number} amount - Damage amount
   * @param {string} attackerFaction - Faction of the attacker
   */
  applyDamage(bot, amount, attackerFaction) {
    if (bot.isDead) return;

    bot.hp = Math.max(0, bot.hp - amount);
    this._updateBotDamageState(bot);

    // Flash bot white briefly on hit
    this._flashBotHit(bot);

    // Update health bar via playerTags (use stable playerId, not array index)
    if (bot.playerId && this.playerTags) {
      this.playerTags.updateHP(bot.playerId, bot.hp, bot.maxHp);
    }

    if (bot.hp <= 0) {
      this._onBotDeath(bot, attackerFaction);
    }
  }

  _flashBotHit(bot) {
    // Quick scale pulse effect (doesn't use shared materials)
    const originalScale = bot.group.scale.clone();
    bot.group.scale.multiplyScalar(1.15);

    // Restore original scale after 30ms
    setTimeout(() => {
      bot.group.scale.copy(originalScale);
    }, 30);
  }

  _updateBotDamageState(bot) {
    const hpPercent = bot.hp / bot.maxHp;
    const oldState = bot.damageState;

    // When hp is 0, don't update state here — _onBotDeath handles the dead transition
    if (hpPercent <= 0) return;

    let newState;
    if (hpPercent > 0.5) {
      newState = "healthy";
    } else if (hpPercent > 0.25) {
      newState = "damaged";
    } else {
      newState = "critical";
    }

    if (newState !== oldState) {
      bot.damageState = newState;
      // Notify callback for smoke/fire effects
      if (this.onBotDamageStateChange) {
        this.onBotDamageStateChange(bot, newState);
      }
    }
  }

  _onBotDeath(bot, killerFaction) {
    bot.isDead = true;
    bot.state.isDead = true; // Also set on state for tread dust/tracks
    bot.state.speed = 0;
    bot.damageState = "dead";

    // Hide lodDot immediately so it's not detected by raycast
    if (bot.lodDot) {
      bot.lodDot.visible = false;
    }

    // Mark as hidden for instanced LOD (won't write box/shadow instances)
    bot._lodState = -1;

    // Notify callback for smoke/fire effects (dead = smoke only, no fire)
    if (this.onBotDamageStateChange) {
      this.onBotDamageStateChange(bot, "dead");
    }

    // Turn bot dark gray
    this._setBotDeadMaterial(bot);

    // Start fade (2s charred delay + 5s linear opacity fade)
    this._startBotFadeOut(bot);

    // Notify callback for explosion effects
    if (this.onBotDeath) {
      this.onBotDeath(bot, killerFaction);
    }
  }

  _setBotDeadMaterial(bot) {
    const charredColor = 0x3a3a3a; // Dark gray - charred look
    bot.group.traverse((child) => {
      if (child.isMesh && child.material && child !== bot.hitbox) {
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

  _startBotFadeOut(bot) {
    bot.fadeStartTime = performance.now();
    bot.sinkDelay = 5000; // 5s charred before sinking
    bot.sinkDuration = 5000; // 5s to sink into ground
    bot.sinkDepth = 3; // units to sink (roughly tank height)
    bot.isFading = true;
    bot._smokeFadeDone = false;
    // Random tilt axis and direction for death sink rotation
    const angle = Math.random() * Math.PI * 2;
    bot._sinkTiltAxis = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)).normalize();
    bot._sinkTiltMax = (0.3 + Math.random() * 0.4) * (Math.random() < 0.5 ? 1 : -1); // radians
  }

  _updateBotFade(bot) {
    if (!bot.isFading) return false;

    const elapsed = performance.now() - bot.fadeStartTime;

    // Fade smoke over the first 5 seconds
    const smokeDuration = 5000;
    if (elapsed < smokeDuration) {
      const smokeOpacity = 1 - (elapsed / smokeDuration);
      if (this.onBotFadeUpdate) {
        this.onBotFadeUpdate(bot, smokeOpacity, "smoke");
      }
    } else if (!bot._smokeFadeDone) {
      bot._smokeFadeDone = true;
      if (this.onBotFadeUpdate) {
        this.onBotFadeUpdate(bot, 0, "smoke");
      }
    }

    // Wait for charred delay before sinking
    if (elapsed < bot.sinkDelay) return false;

    const sinkElapsed = elapsed - bot.sinkDelay;
    const sinkProgress = Math.min(1, sinkElapsed / bot.sinkDuration);

    if (sinkProgress >= 1) {
      if (this.onBotFadeComplete) {
        this.onBotFadeComplete(bot);
      }
      return true;
    }

    // Ease-in: slow start, accelerates into ground
    const eased = sinkProgress * sinkProgress;

    // Sink bodyGroup in local Y + tilt on random axis
    if (bot.bodyGroup) {
      bot.bodyGroup.position.y = -eased * bot.sinkDepth;
      bot.bodyGroup.quaternion.setFromAxisAngle(bot._sinkTiltAxis, eased * bot._sinkTiltMax);
    }

    return false;
  }

  // ========================
  // PUBLIC API
  // ========================

  getBotsPerCluster() {
    // Reuse preallocated Map (avoid per-call GC)
    this._botsPerClusterMap.clear();

    this.bots.forEach((bot) => {
      if (bot.clusterId === undefined) return;
      if (bot.isDead || bot.isDeploying) return; // Don't count dead or deploying bots

      if (!this._botsPerClusterMap.has(bot.clusterId)) {
        this._botsPerClusterMap.set(bot.clusterId, { rust: 0, cobalt: 0, viridian: 0 });
      }
      this._botsPerClusterMap.get(bot.clusterId)[bot.faction]++;
    });

    return this._botsPerClusterMap;
  }

  // ========================
  // PLAYER POPULATION MANAGEMENT
  // ========================

  /**
   * Register a human player joining the game
   * Quietly despawns a bot far from any human players to maintain total count
   * @param {string} playerId - Unique player identifier
   * @param {THREE.Vector3} position - Player's world position
   * @param {string} faction - Player's faction
   */
  registerHumanPlayer(playerId, position, faction) {
    // Check if already registered
    const existing = this.humanPlayers.find((p) => p.id === playerId);
    if (existing) {
      // Update position
      existing.position.copy(position);
      existing.faction = faction;
      return;
    }

    // Add new human player
    this.humanPlayers.push({
      id: playerId,
      position: position.clone(),
      faction: faction,
    });

    // Despawn a bot to maintain total count
    this._despawnDistantBot();
  }

  /**
   * Unregister a human player leaving the game
   * @param {string} playerId - Unique player identifier
   */
  unregisterHumanPlayer(playerId) {
    const index = this.humanPlayers.findIndex((p) => p.id === playerId);
    if (index !== -1) {
      this.humanPlayers.splice(index, 1);
      // Could spawn a new bot here if desired
    }
  }

  /**
   * Update a human player's position (call periodically for distance checks)
   * @param {string} playerId - Unique player identifier
   * @param {THREE.Vector3} position - Player's current world position
   */
  updateHumanPlayerPosition(playerId, position) {
    const player = this.humanPlayers.find((p) => p.id === playerId);
    if (player) {
      player.position.copy(position);
    }
  }

  /**
   * Quietly despawn a bot that is far from all human players
   * Prefers bots that are dead, fading, or far away
   */
  _despawnDistantBot() {
    if (this.bots.length === 0) return;

    // Minimum distance from any human to be eligible for despawn
    const minDespawnDistance = 150;

    // Find eligible bots (not close to any human)
    const eligibleBots = this.bots.filter((bot) => {
      // Skip deploying or dead/fading bots
      if (bot.isDeploying) return false;
      if (bot.isDead && bot.isFading) return false;

      // Check distance to all human players
      for (const human of this.humanPlayers) {
        const dist = bot.group.position.distanceTo(human.position);
        if (dist < minDespawnDistance) {
          return false; // Too close to a human
        }
      }
      return true;
    });

    if (eligibleBots.length === 0) {
      // No eligible bots, find the furthest one from any human
      let furthestBot = null;
      let maxMinDist = 0;

      for (const bot of this.bots) {
        if (bot.isDeploying) continue;
        if (bot.isDead && bot.isFading) continue;

        let minDistToHuman = Infinity;
        for (const human of this.humanPlayers) {
          const dist = bot.group.position.distanceTo(human.position);
          minDistToHuman = Math.min(minDistToHuman, dist);
        }

        if (minDistToHuman > maxMinDist) {
          maxMinDist = minDistToHuman;
          furthestBot = bot;
        }
      }

      if (furthestBot) {
        this._quietlyDespawnBot(furthestBot);
      }
    } else {
      // Pick a random eligible bot
      const bot = eligibleBots[Math.floor(Math.random() * eligibleBots.length)];
      this._quietlyDespawnBot(bot);
    }
  }

  /**
   * Quietly remove a bot from the game (no death effects)
   * @param {THREE.Object3D} bot - The bot to remove
   */
  _quietlyDespawnBot(bot) {
    // Remove tag if exists
    if (this.playerTags && bot.playerId) {
      this.playerTags.removeTag(bot.playerId);
    }

    // Remove from parent (hexGroup or scene)
    if (bot.group.parent) bot.group.parent.remove(bot.group);

    // Remove from bots array
    const index = this.bots.indexOf(bot);
    if (index !== -1) {
      this.bots.splice(index, 1);
    }

    // Remove from faction arrays
    const factionIndex = this._factionBots[bot.faction].indexOf(bot);
    if (factionIndex !== -1) {
      this._factionBots[bot.faction].splice(factionIndex, 1);
    }

    // Unregister from TankCollision
    if (this._tankCollision && bot.playerId) {
      this._tankCollision.unregisterTank(`sbot-${bot.playerId}`);
    }
  }

  /**
   * Get current total player count (humans + active bots)
   */
  getTotalPlayerCount() {
    const activeBots = this.bots.filter((b) => !b.isDeploying && (!b.isDead || !b.isFading)).length;
    return this.humanPlayers.length + activeBots;
  }

  // ========================
  // RESPAWN SYSTEM
  // ========================

  /**
   * Respawn a dead bot at a random portal
   */
  respawnBot(bot) {
    if (!bot.isDead) return;

    // Pick a random portal
    const portalCenters = this.planet.getAllPortalCenters();
    if (portalCenters.length === 0) return;

    const portalIndex =
      portalCenters[Math.floor(Math.random() * portalCenters.length)];

    // Get portal position in local space
    const portalPos = this.planet.getPortalPosition(portalIndex);
    if (!portalPos) return;

    // Calculate spherical coords from local position
    const r = portalPos.length();
    const phi = Math.acos(portalPos.y / r);
    const theta = Math.atan2(portalPos.z, portalPos.x);

    // Add random offset to not spawn exactly on portal
    const offsetTheta = theta + (Math.random() - 0.5) * 0.02;
    const offsetPhi = phi + (Math.random() - 0.5) * 0.02;

    // Reset bot state
    bot.hp = bot.maxHp;
    bot.isDead = false;
    bot.state.isDead = false; // Also reset on state for tread dust/tracks
    bot.isFading = false;
    bot.damageState = "healthy";
    bot.theta = offsetTheta;
    bot.phi = offsetPhi;
    bot.heading = Math.random() * Math.PI * 2;
    bot.state.speed = 0;
    bot.state.keys = { w: false, a: false, s: false, d: false };
    bot.state.turretAngle = Math.random() * Math.PI * 2;
    bot.state.turretTargetAngle = 0;
    bot.state.turretAngularVelocity = 0;
    bot.aiState = BOT_STATES.IDLE;
    bot.targetClusterId = null;
    bot.targetPosition = null;
    bot.stateTimer = 0;
    bot._stuckCheckTheta = bot.theta;
    bot._stuckCheckPhi = bot.phi;
    bot._stuckCheckTimer = 0;
    bot._stuckCounter = 0;
    bot._terrainBounceCount = 0;
    bot._centerBlocked = false;
    bot._terrainProbeFrame = 0;
    bot._lastTerrainThreat = null;
    bot.pathWaypoints = [];
    bot.currentWaypointIdx = 0;
    bot.pathTargetCluster = null;
    bot._replanCount = 0;

    // Restore materials
    bot.group.traverse((child) => {
      if (child.isMesh && child.material && child !== bot.hitbox) {
        if (child.userData.originalMaterial) {
          child.material.dispose();
          child.material = child.userData.originalMaterial;
          delete child.userData.originalMaterial;
        }
        child.material.transparent = false;
        child.material.opacity = 1;
      }
    });

    // Reset sink offset and tilt from death
    if (bot.bodyGroup) {
      bot.bodyGroup.position.y = 0;
      bot.bodyGroup.quaternion.identity();
    }

    // Enter deploy state — bot becomes visible after a short delay
    bot.isDeploying = true;
    bot.deployTimer = 0.5;
    bot.group.visible = false;

    // Update visual position (so it's correct when deploy completes)
    this._updateBotVisual(bot);

    // Update cluster ID
    bot.clusterId = this.planet.getClusterIdAtLocalPosition(bot.group.position);

    // Notify callback to clear damage effects and recreate tag
    if (this.onBotDamageStateChange) {
      this.onBotDamageStateChange(bot, "healthy");
    }
    if (this.onBotRespawn) {
      this.onBotRespawn(bot);
    }
  }

  // ========================
  // ORBITAL PHANTOM DOTS
  // ========================

  /**
   * Pre-allocate a pool of billboard shader Mesh dots for distant bots.
   * These are identical to the per-bot lodDot meshes: same geometry, same
   * ShaderMaterial, same custom sphere raycast — so they look and interact
   * identically. Registered with TankLODInteraction for hover/right-click.
   */
  _setupOrbitalPhantoms() {
    const POOL_SIZE = 300;
    const hitRadius = this._lodDotRadius * 2;

    this._phantomPool = [];
    this._phantomActiveCount = 0;
    this._orbitalPhantomVisible = false;
    this._phantomsRegistered = false;

    // Per-mesh interpolation targets for smooth orbital dot movement
    this._phantomHasTarget = new Uint8Array(POOL_SIZE); // 0 = no target yet (snap), 1 = has previous position

    // Pre-allocated temp objects for phantom raycast (shared across all pool meshes)
    const _rcWorldPos = new THREE.Vector3();
    const _rcSphere = new THREE.Sphere(new THREE.Vector3(), hitRadius);
    const _rcIntersectPoint = new THREE.Vector3();

    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(
        this._lodDotGeometry,
        this._lodDotMaterials["rust"],
      );
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 10;

      // Custom sphere-based raycast (identical to per-bot lodDot in Tank.js)
      mesh.raycast = function (raycaster, intersects) {
        if (!this.visible) return;
        this.getWorldPosition(_rcWorldPos);
        _rcSphere.center.copy(_rcWorldPos);
        if (raycaster.ray.intersectSphere(_rcSphere, _rcIntersectPoint)) {
          const distance = raycaster.ray.origin.distanceTo(_rcWorldPos);
          if (distance >= (raycaster.near || 0) && distance <= (raycaster.far || Infinity)) {
            intersects.push({ distance, point: _rcIntersectPoint.clone(), object: this });
          }
        }
      };

      mesh.userData = { playerId: "", faction: "", username: "", squad: null, isCommander: false };

      this.planet.hexGroup.add(mesh);
      this._phantomPool.push(mesh);
    }
  }

  /**
   * Update orbital phantom dots from server-reported positions.
   * Called every frame from the render loop.
   */
  updateOrbitalPhantoms(isOrbitalView, isHumanCommander, viewerFaction, deltaTime) {
    const mp = window._mpState;
    if (!mp || !mp.orbitalPositions) {
      this._hideOrbitalPhantoms();
      return;
    }

    if (!isOrbitalView) {
      this._hideOrbitalPhantoms();
      return;
    }

    // Lazy-register all pool meshes with TankLODInteraction (once)
    if (!this._phantomsRegistered && window.tankLODInteraction) {
      for (const mesh of this._phantomPool) {
        window.tankLODInteraction.registerDot(mesh);
      }
      this._phantomsRegistered = true;
    }

    const op = mp.orbitalPositions;
    const opn = mp.orbitalPositionNames;
    const factionNames = ["rust", "cobalt", "viridian"];
    const r = this.sphereRadius + 3;
    const hoveredMesh = window.tankLODInteraction?.hoveredDot;

    // Build set of known bot thetas (bots with full 3D representation)
    const knownBotThetas = new Set();
    for (const bot of this.bots) {
      if (bot.isDead || bot.isDeploying) continue;
      knownBotThetas.add(Math.round(bot.theta * 10000));
    }
    // Also exclude remoteTanks (human players + nearby bots already rendered)
    const remotes = mp.remoteTanks;
    if (remotes) {
      for (const [id, rt] of remotes) {
        if (id.startsWith("bot-") && !rt.isDead) {
          // Use the server-reported theta from last state update
          if (rt.targetState) {
            knownBotThetas.add(Math.round(rt.targetState.theta * 10000));
          }
        }
      }
    }

    let poolIdx = 0;

    for (let i = 0, opnIdx = 0; i < op.length; i += 3, opnIdx += 2) {
      const theta = op[i];
      const phi = op[i + 1];
      const fi = op[i + 2];
      const faction = factionNames[fi];

      // Filter: commanders see all, regular players see own faction only
      if (!isHumanCommander && faction !== viewerFaction) continue;

      // Skip bots with full 3D representation
      if (knownBotThetas.has(Math.round(theta * 10000))) continue;

      if (poolIdx >= this._phantomPool.length) break;
      const mesh = this._phantomPool[poolIdx];

      // Position in hexGroup local space — interpolate for smooth movement
      const tx = r * Math.sin(phi) * Math.cos(theta);
      const ty = r * Math.cos(phi);
      const tz = r * Math.sin(phi) * Math.sin(theta);

      if (!this._phantomHasTarget[poolIdx] || !mesh.visible) {
        // First frame or re-activated — snap directly
        mesh.position.set(tx, ty, tz);
        this._phantomHasTarget[poolIdx] = 1;
      } else {
        // Smooth exponential lerp toward target
        const dx = tx - mesh.position.x;
        const dy = ty - mesh.position.y;
        const dz = tz - mesh.position.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        // Snap if target jumped far (bot died/spawned, pool reassigned)
        if (distSq > 400) {
          mesh.position.set(tx, ty, tz);
        } else {
          const t = Math.min(1, 8 * deltaTime);
          mesh.position.x += dx * t;
          mesh.position.y += dy * t;
          mesh.position.z += dz * t;
        }
      }

      // Swap faction material (skip if this dot is currently hovered to preserve hover effect)
      if (mesh !== hoveredMesh) {
        const targetMat = this._lodDotMaterials[faction];
        if (mesh.material !== targetMat) mesh.material = targetMat;
      }

      // Update userData for hover tooltip + right-click profile card
      // opn may be stale (sent every 100 ticks) while op updates every 10 ticks,
      // so opn[opnIdx] can be undefined when bots spawn/despawn between syncs
      const botId = (opn && opn[opnIdx]) || `phantom-${poolIdx}`;
      const botName = (opn && opn[opnIdx + 1]) || `Bot ${poolIdx}`;
      mesh.userData.playerId = botId;
      mesh.userData.faction = faction;
      mesh.userData.username = botName;

      // Register in ProfileCard cache for right-click support
      if (window.profileCard && botId.startsWith("bot-") && !window.profileCard.playerCache.has(botId)) {
        window.profileCard.playerCache.set(botId, {
          id: botId, name: botName, faction,
          level: 1, crypto: 0, cryptoToNext: 15000,
          title: "Contractor", rank: null, squad: null,
          isOnline: true, badges: [], avatarColor: null,
          socialLinks: {}, isSelf: false,
        });
      }

      mesh.visible = true;
      poolIdx++;
    }

    // Hide unused pool entries and reset their interpolation state
    for (let i = poolIdx; i < this._phantomPool.length; i++) {
      this._phantomPool[i].visible = false;
      this._phantomHasTarget[i] = 0;
    }

    // Force world matrix update on active phantom dots so raycasting works
    // immediately (hover check fires on mousemove between render frames)
    if (poolIdx > 0) {
      this.planet.hexGroup.updateWorldMatrix(true, false);
      for (let i = 0; i < poolIdx; i++) {
        this._phantomPool[i].updateWorldMatrix(false, false);
      }
    }

    this._phantomActiveCount = poolIdx;
    this._orbitalPhantomVisible = true;
  }

  _hideOrbitalPhantoms() {
    if (!this._orbitalPhantomVisible) return;
    for (let i = 0; i < this._phantomPool.length; i++) {
      this._phantomPool[i].visible = false;
    }
    this._phantomActiveCount = 0;
    this._orbitalPhantomVisible = false;
    // Reset interpolation so dots snap on next activation
    if (this._phantomHasTarget) this._phantomHasTarget.fill(0);
  }
}
