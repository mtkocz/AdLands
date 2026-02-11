/**
 * AdLands - GameRoom
 * One game instance: manages all player state, runs the server tick loop,
 * and broadcasts world state to connected clients.
 */

const {
  FACTIONS,
  TANK_PHYSICS,
  PLANET_ROTATION_SPEED,
  applyInput,
  moveOnSphere,
  sphericalDistance,
} = require("./shared/physics");
const WorldGenerator = require("./WorldGenerator");
const TerrainElevation = require("./shared/TerrainElevation");
const TuskGlobalChat = require("./TuskGlobalChat");
const BodyguardManager = require("./BodyguardManager");

// Bot name pool (same as client for consistency)
const BOT_NAME_POOL = [
  "xXSlayerXx", "N00bKiller", "TankMaster", "DeathWish", "ShadowFury",
  "IronClad", "VoidWalker", "CyberPunk", "NightHawk", "StormBringer",
  "PhantomX", "BlazeFire", "FrostBite", "ThunderBolt", "VenomStrike",
  "RageBeast", "SilentDeath", "ChaosMaker", "DoomBringer", "HexMaster",
  "PixelPro", "ByteMe", "LazerEyes", "CritHit", "HeadShot",
  "NightQueen", "VixenStrike", "LunaWolf", "ScarletRage", "IvyBlade",
  "AthenaX", "ValkyrieFury", "NovaFlare", "ZeldaMain", "SamusRun",
];

class GameRoom {
  constructor(io, roomId, sponsorStore) {
    this.io = io;
    this.roomId = roomId;
    this.sponsorStore = sponsorStore || null;

    // Connected players: socketId → player state
    this.players = new Map();

    // Resigned commanders: socketId → resignedUntil (ms timestamp)
    this.resignedPlayers = new Map();

    // Projectiles in flight
    this.projectiles = [];
    this.nextProjectileId = 1;

    // Server time tracking
    this.planetRotation = 0;

    // Server-authoritative celestial bodies (speeds in rad/s)
    this.moons = [
      { angle: 0,     speed: -0.012, distance: 600, inclination: 0.3,  radius: 48 },
      { angle: 2.094, speed: -0.009, distance: 820, inclination: -0.2, radius: 24 },
      { angle: 4.189, speed: -0.006, distance: 720, inclination: 0.15, radius: 32 },
    ];
    this.stations = [
      { orbitalAngle: 0.5,  speed: 0.0048, orbitRadius: 700, inclination: 1.2, ascendingNode: 0.8, rotationSpeed: 0.06,  localRotation: 0 },
      { orbitalAngle: 3.64, speed: 0.0036, orbitRadius: 750, inclination: 0.7, ascendingNode: 2.5, rotationSpeed: 0.048, localRotation: 0 },
    ];

    // Tick loop: 20 ticks/second
    this.tickRate = 20;
    this.tickDelta = 1 / this.tickRate;
    this.tickInterval = null;
    this.lastTickTime = Date.now();

    // Sequence number for state snapshots (clients use for reconciliation)
    this.tick = 0;

    // Throttle tic-crypto awards to once per second (counter resets at tickRate)
    this.captureSecondCounter = 0;

    // Throttle capture-progress broadcasts to ~4x/sec
    this.captureProgressCounter = 0;
    this.captureProgressRate = Math.round(this.tickRate / 4);

    // Throttle holding crypto awards to once per 60 seconds
    this.holdingCryptoCounter = 0;
    this.holdingCryptoInterval = this.tickRate * 60; // 1200 ticks = 60s

    // Throttle rank recomputation to once per second
    this.rankRecomputeCounter = 0;

    // ---- Server-authoritative world generation ----
    this.worldGen = new WorldGenerator(480, 22, 42);
    const worldResult = this.worldGen.generate();
    this.worldResult = worldResult;

    this.terrain = new TerrainElevation(73);
    this.terrain.generate(
      worldResult.tiles,
      worldResult.adjacencyMap,
      worldResult.portalTileIndices,
      worldResult.polarTileIndices
    );

    // Compute portal positions in spherical coords from world data
    this.portalPositions = [];
    this.portalPositionsByTile = new Map(); // tileIndex → { theta, phi }
    for (const portalIdx of worldResult.portalCenterIndices) {
      const tc = this.worldGen.tileCenters[portalIdx];
      const pos = tc.position;
      const r = pos.length();
      if (r < 0.001) continue;
      const phi = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
      const theta = Math.atan2(pos.z, pos.x);
      this.portalPositions.push({ theta, phi });
      this.portalPositionsByTile.set(portalIdx, { theta, phi });
    }
    // For each portal center, compute spherical coords of adjacent hex tiles
    // (matching client's getPortalNeutralNeighbors logic)
    this.portalNeighborPositions = new Map(); // portalCenterIndex → [{ theta, phi }]
    for (const portalIdx of worldResult.portalCenterIndices) {
      const neighbors = worldResult.adjacencyMap.get(portalIdx) || [];
      const hexNeighbors = neighbors.filter(
        (n) =>
          worldResult.portalTileIndices.has(n) &&
          !worldResult.portalCenterIndices.has(n)
      );
      const positions = [];
      for (const nIdx of hexNeighbors) {
        const tc = this.worldGen.tileCenters[nIdx];
        if (!tc) continue;
        const pos = tc.position;
        const r = pos.length();
        if (r < 0.001) continue;
        const nPhi = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
        const nTheta = Math.atan2(pos.z, pos.x);
        positions.push({ theta: nTheta, phi: nPhi });
      }
      this.portalNeighborPositions.set(portalIdx, positions);
    }

    console.log(`[Room ${roomId}] ${this.portalPositions.length} portals computed from world gen`);

    // ---- Snapshot original world state (before sponsor modifications) ----
    this._worldResult = worldResult;
    this._originalClusterData = worldResult.clusterData.map(c => ({
      id: c.id,
      tiles: c.tiles.slice(),
    }));
    this._originalTileClusterMap = new Map(worldResult.tileClusterMap);
    this._originalClusterColors = new Map(worldResult.clusterColors);
    this._originalClusterPatterns = new Map(worldResult.clusterPatterns);
    this._originalTileElevation = new Map(this.terrain.tileElevation);
    this._originalElevatedTileSet = new Set(this.terrain.elevatedTileSet);

    // ---- Apply sponsor clusters (before capture state init) ----
    this.sponsors = [];
    this.sponsorClusterMap = new Map(); // sponsorId → clusterId
    this.clusterSponsorMap = new Map(); // clusterId → sponsorId
    this.sponsorHoldTimers = new Map(); // sponsorId → { owner, capturedAt, holdDuration }

    if (this.sponsorStore) {
      this.sponsors = this.sponsorStore.getAll().filter(s => s.active !== false);
      this._applySponsorClusters(worldResult);
      console.log(`[Room ${roomId}] Applied ${this.sponsors.length} sponsor clusters`);
    }

    // Prepare serialized world data to send to clients on connect
    this._worldPayload = this._buildWorldPayload(worldResult);

    // Territory capture state: clusterId → { tics, owner, capacity, momentum }
    this.clusterCaptureState = new Map();
    for (const cluster of worldResult.clusterData) {
      const capacity = cluster.tiles.length * 5;
      this.clusterCaptureState.set(cluster.id, {
        tics: { rust: 0, cobalt: 0, viridian: 0 },
        owner: null,
        capacity,
        momentum: { rust: 0, cobalt: 0, viridian: 0 },
      });
    }

    // Server-side Tusk global chat (broadcasts satirical commentary)
    this.tuskChat = new TuskGlobalChat(io, roomId);

    // Server-authoritative commander state: one commander per faction
    this.commanders = { rust: null, cobalt: null, viridian: null };

    // Commander overrides: faction → { id, until } (dev testing — locks commander for 60s)
    this.commanderOverrides = new Map();

    // Server-authoritative bodyguards (2 per commander, synced to all clients)
    this.bodyguardManager = new BodyguardManager(480, this.terrain, this.worldGen);
  }

  start() {
    this.tickInterval = setInterval(() => this._gameTick(), 1000 / this.tickRate);
    console.log(`[Room ${this.roomId}] Started at ${this.tickRate} ticks/sec`);
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    console.log(`[Room ${this.roomId}] Stopped`);
  }

  // ========================
  // LIVE SPONSOR RELOAD
  // ========================

  /**
   * Reload sponsors from disk, re-process clusters, and broadcast to all clients.
   * Called by the REST API after sponsor create/update/delete/import.
   */
  reloadSponsors() {
    if (!this.sponsorStore) return;

    const wr = this._worldResult;

    // 1. Revert world state to pre-sponsor originals
    wr.clusterData.length = 0;
    for (const orig of this._originalClusterData) {
      wr.clusterData.push({ id: orig.id, tiles: orig.tiles.slice() });
    }
    wr.tileClusterMap.clear();
    for (const [k, v] of this._originalTileClusterMap) {
      wr.tileClusterMap.set(k, v);
    }
    wr.clusterColors.clear();
    for (const [k, v] of this._originalClusterColors) {
      wr.clusterColors.set(k, v);
    }
    wr.clusterPatterns.clear();
    for (const [k, v] of this._originalClusterPatterns) {
      wr.clusterPatterns.set(k, v);
    }
    this.terrain.tileElevation.clear();
    for (const [k, v] of this._originalTileElevation) {
      this.terrain.tileElevation.set(k, v);
    }
    this.terrain.elevatedTileSet.clear();
    for (const v of this._originalElevatedTileSet) {
      this.terrain.elevatedTileSet.add(v);
    }

    // 2. Clear old sponsor state
    const oldSponsorClusterIds = new Set(this.clusterSponsorMap.keys());
    this.sponsorClusterMap.clear();
    this.clusterSponsorMap.clear();
    this.sponsorHoldTimers.clear();

    // 3. Re-read and re-apply sponsors
    this.sponsors = this.sponsorStore.getAll().filter(s => s.active !== false);
    this._applySponsorClusters(wr);

    // 4. Rebuild world payload
    this._worldPayload = this._buildWorldPayload(wr);

    // 5. Update capture state: remove stale sponsor clusters, add new ones
    for (const oldId of oldSponsorClusterIds) {
      this.clusterCaptureState.delete(oldId);
    }
    for (const [, clusterId] of this.sponsorClusterMap) {
      if (!this.clusterCaptureState.has(clusterId)) {
        const cluster = wr.clusterData[clusterId];
        const capacity = cluster ? cluster.tiles.length * 5 : 25;
        this.clusterCaptureState.set(clusterId, {
          tics: { rust: 0, cobalt: 0, viridian: 0 },
          owner: null,
          capacity,
          momentum: { rust: 0, cobalt: 0, viridian: 0 },
        });
      }
    }

    // Also update procedural cluster capacities (tiles may have moved)
    for (const cluster of wr.clusterData) {
      if (this.clusterSponsorMap.has(cluster.id)) continue;
      const state = this.clusterCaptureState.get(cluster.id);
      if (state) {
        state.capacity = cluster.tiles.length * 5;
      }
    }

    // 6. Broadcast full reload to all connected clients
    this.io.to(this.roomId).emit("sponsors-reloaded", {
      world: this._worldPayload,
    });

    console.log(`[Room ${this.roomId}] Sponsors reloaded: ${this.sponsors.length} active, broadcast to clients`);
  }

  // ========================
  // PLAYER MANAGEMENT
  // ========================

  addPlayer(socket) {
    // Assign faction for team balance
    const faction = this._getLeastPopulatedFaction();

    // Spawn near a random portal (or mid-latitudes if portals not yet received)
    const spawn = this._getSpawnPosition(socket.id);

    const player = {
      id: socket.id,
      name: this._pickName(),
      faction: faction,

      // Physics state (authoritative)
      theta: spawn.theta,
      phi: spawn.phi,
      heading: Math.random() * Math.PI * 2,
      speed: 0,
      turretAngle: 0,

      // Health
      hp: 100,
      maxHp: 100,
      isDead: false,

      // Player is waiting to choose a deployment portal
      waitingForPortal: true,

      // Latest input from client (updated every time we receive input)
      keys: { w: false, a: false, s: false, d: false, shift: false },

      // Input sequence number (for client-side prediction reconciliation)
      lastInputSeq: 0,

      // Stats for commander ranking (level primary, crypto tiebreaker)
      level: 1,
      crypto: 0,

      // Territory contribution counter (tic deltas accumulated)
      territoryCaptured: 0,

      // Server-computed faction rank (1-based, unique per faction)
      rank: 0,

      // Profile data (sent by client after connect)
      badges: [],
      totalCrypto: 0,
      title: "Contractor",
    };

    this.players.set(socket.id, player);
    socket.join(this.roomId);

    // Build current capture state snapshot (only non-empty clusters to save bandwidth)
    const captureState = {};
    for (const [clusterId, state] of this.clusterCaptureState) {
      const total = state.tics.rust + state.tics.cobalt + state.tics.viridian;
      if (total > 0 || state.owner) {
        captureState[clusterId] = {
          tics: { ...state.tics },
          owner: state.owner,
          capacity: state.capacity,
        };
      }
    }

    // Tell the new player about themselves, all existing players, and the world
    socket.emit("welcome", {
      you: {
        id: player.id,
        name: player.name,
        faction: player.faction,
        waitingForPortal: true,
      },
      players: this._getAllPlayerStates(),
      bodyguards: this.bodyguardManager.getFullStatesForWelcome(),
      tickRate: this.tickRate,
      planetRotation: this.planetRotation,
      world: this._worldPayload,
      captureState,
      commanders: this._getCommanderSnapshot(),
      celestial: {
        moons: this.moons.map(m => ({
          angle: m.angle, speed: m.speed,
          distance: m.distance, inclination: m.inclination, radius: m.radius,
        })),
        stations: this.stations.map(s => ({
          orbitalAngle: s.orbitalAngle, speed: s.speed,
          orbitRadius: s.orbitRadius, inclination: s.inclination,
          ascendingNode: s.ascendingNode, rotationSpeed: s.rotationSpeed,
          localRotation: s.localRotation,
        })),
      },
    });

    // Tell everyone else about the new player (waiting — don't spawn yet)
    socket.to(this.roomId).emit("player-joined", {
      id: player.id,
      name: player.name,
      faction: player.faction,
      hp: player.hp,
      level: player.level,
      waitingForPortal: true,
      badges: player.badges,
      totalCrypto: player.totalCrypto,
      title: player.title,
      crypto: player.crypto,
      rank: player.rank || 0,
    });

    // Recompute ranks and commander for all factions
    this._recomputeRanks();

    console.log(
      `[Room ${this.roomId}] ${player.name} (${player.faction}) joined. ` +
      `Players: ${this.players.size}`
    );

    return player;
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    this.players.delete(socketId);
    this.resignedPlayers.delete(socketId);

    // Recompute ranks and commander (removed player no longer eligible)
    this._recomputeRanks();

    // Tell everyone the player left
    this.io.to(this.roomId).emit("player-left", { id: socketId });

    console.log(
      `[Room ${this.roomId}] ${player.name} left. Players: ${this.players.size}`
    );
  }

  // ========================
  // INPUT HANDLING
  // ========================

  handleInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player || player.isDead || player.waitingForPortal) return;

    // Validate and apply input (don't trust client positions, only keys)
    if (input.keys) {
      player.keys.w = !!input.keys.w;
      player.keys.a = !!input.keys.a;
      player.keys.s = !!input.keys.s;
      player.keys.d = !!input.keys.d;
      player.keys.shift = !!input.keys.shift;
    }

    // Turret angle (validated — must be a finite number)
    if (typeof input.turretAngle === "number" && isFinite(input.turretAngle)) {
      player.turretAngle = input.turretAngle;
    }

    // Track the input sequence number for client prediction reconciliation
    if (typeof input.seq === "number") {
      player.lastInputSeq = input.seq;
    }
  }

  handleFire(socketId, power, fireTurretAngle) {
    const player = this.players.get(socketId);
    if (!player || player.isDead || player.waitingForPortal) return;

    // Clamp charge power to valid range (0-10)
    const chargePower = Math.max(0, Math.min(10, power || 0));
    const chargeRatio = chargePower / 10;

    // Scale projectile stats with charge (matches client CannonSystem formulas)
    const speed = 0.004 * (1 + chargeRatio); // 2x speed at max charge
    const damage = Math.round(25 * (1 + chargeRatio * 2)); // 25-75 damage (integer)

    // Range cap: match client visual range (20 base, 3x at max charge = 20-60 world units)
    const rangeWorldUnits = 20 * (1 + chargeRatio * 2);
    const maxDistanceRad = rangeWorldUnits / 480; // Convert to radians on R=480 sphere
    // Compute maxAge from range/speed + buffer (speed in rad/sec = speed * dt60_factor * tickRate)
    const maxAge = Math.min(maxDistanceRad / (speed * 60) + 0.5, 5);

    // Spawn a projectile from this player's current position and turret angle.
    // turretAngle is a Three.js Y-axis rotation where PI = barrel forward (due to
    // the +PI offset in Tank._updateTurret). Convert to spherical heading:
    // fireHeading = heading + PI - turretAngle  (at turretAngle=PI → fires in heading dir)
    const turretAngle = (typeof fireTurretAngle === "number" && isFinite(fireTurretAngle))
      ? fireTurretAngle
      : player.turretAngle;
    let fireHeading = player.heading + Math.PI - turretAngle;
    while (fireHeading >= Math.PI * 2) fireHeading -= Math.PI * 2;
    while (fireHeading < 0) fireHeading += Math.PI * 2;

    const projectile = {
      id: this.nextProjectileId++,
      ownerId: socketId,
      ownerFaction: player.faction,
      theta: player.theta,
      phi: player.phi,
      startTheta: player.theta,
      startPhi: player.phi,
      heading: fireHeading,
      speed: speed,
      age: 0,
      maxAge: maxAge,
      maxDistanceRad: maxDistanceRad,
      damage: damage,
    };

    this.projectiles.push(projectile);

    // Broadcast the fire event to all clients (for muzzle flash / sound)
    this.io.to(this.roomId).emit("player-fired", {
      id: socketId,
      turretAngle: turretAngle,
      theta: player.theta,
      phi: player.phi,
      projectileId: projectile.id,
      power: chargePower,
    });
  }

  handleProfile(socketId, profileData) {
    const player = this.players.get(socketId);
    if (!player) return;

    const oldLevel = player.level;
    const oldTotalCrypto = player.totalCrypto;

    // Validate and store profile data
    if (Array.isArray(profileData.badges)) {
      // Only store badge ID strings, limit to 50
      player.badges = profileData.badges
        .filter(b => typeof b === "string")
        .slice(0, 50);
    }
    if (typeof profileData.totalCrypto === "number" && isFinite(profileData.totalCrypto)) {
      player.totalCrypto = Math.max(0, Math.floor(profileData.totalCrypto));
    }
    if (typeof profileData.level === "number" && isFinite(profileData.level)) {
      player.level = Math.max(1, Math.floor(profileData.level));
    }
    // NOTE: crypto is server-authoritative — do NOT accept from client profile data
    if (typeof profileData.title === "string") {
      player.title = profileData.title.substring(0, 50);
    }

    // Re-evaluate ranks and commander if ranking metrics changed
    if (player.level !== oldLevel || player.totalCrypto !== oldTotalCrypto) {
      this._recomputeRanks();
    }

    // Relay to all other clients
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.to(this.roomId).emit("player-profile", {
        id: socketId,
        badges: player.badges,
        totalCrypto: player.totalCrypto,
        title: player.title,
      });
    }
  }

  handleChoosePortal(socketId, portalTileIndex) {
    const player = this.players.get(socketId);
    if (!player || player.isDead) return;

    // Validate portal tile index
    if (!this.portalPositionsByTile.has(portalTileIndex)) {
      console.log(`[Room ${this.roomId}] Invalid portal tile ${portalTileIndex} from ${player.name}`);
      return;
    }

    const wasWaiting = player.waitingForPortal;

    // Pick the adjacent hex tile farthest from other tanks
    const neighbors = this.portalNeighborPositions.get(portalTileIndex) || [];
    const spawnPos =
      neighbors.length > 0
        ? this._pickFarthestNeighbor(neighbors, socketId)
        : this.portalPositionsByTile.get(portalTileIndex);

    // Small offset within the chosen tile so players don't stack
    const offsetAngle = Math.random() * Math.PI * 2;
    const offsetMag = 0.001 + Math.random() * 0.002;

    // Positions are in local (unrotated) space; subtract planetRotation for world space
    let spawnTheta = spawnPos.theta - this.planetRotation + Math.cos(offsetAngle) * offsetMag;
    while (spawnTheta < 0) spawnTheta += Math.PI * 2;
    while (spawnTheta >= Math.PI * 2) spawnTheta -= Math.PI * 2;
    player.theta = spawnTheta;
    player.phi = Math.max(
      0.1,
      Math.min(Math.PI - 0.1, spawnPos.phi + Math.sin(offsetAngle) * offsetMag)
    );
    player.heading = Math.random() * Math.PI * 2;
    player.waitingForPortal = false;

    // Reposition bodyguards if this player is a commander (avoids long travel from pre-portal spawn)
    for (const faction of FACTIONS) {
      if (this.commanders[faction]?.id === socketId) {
        this.bodyguardManager.despawnForFaction(faction);
        this.bodyguardManager.spawnForCommander(faction, socketId, player);
        break;
      }
    }

    // Tell the requesting client their confirmed position
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("portal-confirmed", {
        theta: player.theta,
        phi: player.phi,
        heading: player.heading,
      });
    }

    // If they were waiting (initial deploy / respawn), notify others to spawn their tank
    if (wasWaiting && socket) {
      socket.to(this.roomId).emit("player-activated", {
        id: player.id,
        name: player.name,
        faction: player.faction,
        theta: player.theta,
        phi: player.phi,
        heading: player.heading,
        hp: player.hp,
        level: player.level,
        badges: player.badges,
        totalCrypto: player.totalCrypto,
        title: player.title,
        crypto: player.crypto,
      });
    }

    // Recompute ranks and commander (player is now alive and deployed)
    if (wasWaiting) {
      this._recomputeRanks();
    }

    console.log(
      `[Room ${this.roomId}] ${player.name} ${wasWaiting ? 'deployed' : 'fast-traveled'} at portal tile ${portalTileIndex}`
    );
  }

  // ========================
  // GAME TICK
  // ========================

  _gameTick() {
    const now = Date.now();
    const dt = this.tickDelta; // Fixed timestep

    this.tick++;

    // Update planet rotation
    this.planetRotation += PLANET_ROTATION_SPEED * dt;

    // Update celestial body orbits
    for (const moon of this.moons) moon.angle += moon.speed * dt;
    for (const s of this.stations) {
      s.orbitalAngle += s.speed * dt;
      s.localRotation += s.rotationSpeed * dt;
    }

    // 1. Apply inputs and simulate all player tanks
    for (const [id, player] of this.players) {
      if (player.waitingForPortal || player.isDead) {
        // Dead/waiting players still need planet rotation countered
        // so they stay fixed on the surface (client may still render them)
        const dt60 = dt * 60;
        player.theta -= (PLANET_ROTATION_SPEED * dt60) / 60;
        if (player.theta < 0) player.theta += Math.PI * 2;
        continue;
      }

      // Save pre-move position for terrain collision revert
      const prevTheta = player.theta;
      const prevPhi = player.phi;

      // Apply input to physics
      applyInput(player, dt);

      // Move on sphere
      moveOnSphere(player, PLANET_ROTATION_SPEED, dt);

      // Terrain collision: probe center + 4 body corners
      // Tank body: ~5.5 long × ~3 wide → half-length 2.75, half-width 1.5
      // Sphere surface directions from heading h:
      //   Forward: dPhi = -cos(h), dTheta = -sin(h)/sinPhi
      //   Right:   dPhi =  sin(h), dTheta = -cos(h)/sinPhi
      const sinPhi = Math.sin(player.phi);
      const safeSinPhi = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
      const dir = player.speed > 0 ? 1 : player.speed < 0 ? -1 : 0;
      const cosH = Math.cos(player.heading);
      const sinH = Math.sin(player.heading);
      const R = 480;

      // Forward/right unit vectors in (dPhi, dTheta) space
      const fwdPhi = -cosH;
      const fwdTh  = -sinH / safeSinPhi;
      const rgtPhi =  sinH;
      const rgtTh  = -cosH / safeSinPhi;

      // Probe offsets: [forward_units, right_units]
      // Center, front-left, front-right, rear-left, rear-right
      const HALF_LEN = 2.75;
      const HALF_WID = 1.5;
      const probes = [
        [0, 0],                          // center
        [HALF_LEN * dir, -HALF_WID],     // front-left
        [HALF_LEN * dir,  HALF_WID],     // front-right
        [-HALF_LEN * dir, -HALF_WID],    // rear-left
        [-HALF_LEN * dir,  HALF_WID],    // rear-right
      ];

      let blocked = false;
      for (const [fwd, rgt] of probes) {
        const pPhi = player.phi + (fwdPhi * fwd + rgtPhi * rgt) / R;
        const pTh  = player.theta + (fwdTh * fwd + rgtTh * rgt) / R;
        const result = this.worldGen.getNearestTile(pTh + this.planetRotation, pPhi);
        if (result && this.terrain.getElevationAtTileIndex(result.tileIndex) > 0) {
          blocked = true;
          break;
        }
      }

      if (blocked) {
        // Revert movement but apply planet counter-rotation to stay on surface
        player.theta = prevTheta - PLANET_ROTATION_SPEED * dt;
        if (player.theta < 0) player.theta += Math.PI * 2;
        if (player.theta >= Math.PI * 2) player.theta -= Math.PI * 2;
        player.phi = prevPhi;
        player.speed = 0;
      }
    }

    // 1.5. Update bodyguard bots (AI + physics + terrain collision)
    this.bodyguardManager.update(dt, this.players, this.planetRotation);

    // 2. Update projectiles
    this._updateProjectiles(dt);

    // 3. Update territory capture
    this._updateCapture();

    // 4. Broadcast world state to all clients
    this._broadcastState();

    // 5. Broadcast crypto balances + commander state (every 5 seconds)
    if (this.tick % (this.tickRate * 5) === 0) {
      this._broadcastCrypto();
      // Full commander state sync (reliable — catches any missed commander-update events)
      this.io.to(this.roomId).emit("commander-sync", this._getCommanderSnapshot());
    }

    // 6. Recompute faction ranks (every 1 second)
    this.rankRecomputeCounter++;
    if (this.rankRecomputeCounter >= this.tickRate) {
      this.rankRecomputeCounter = 0;
      this._recomputeRanks();
    }

    // 7. Award holding crypto (every 60 seconds)
    this.holdingCryptoCounter++;
    if (this.holdingCryptoCounter >= this.holdingCryptoInterval) {
      this.holdingCryptoCounter = 0;
      this._awardHoldingCrypto();
    }

    this.lastTickTime = now;
  }

  _updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;

      if (p.age >= p.maxAge) {
        this.projectiles.splice(i, 1);
        continue;
      }

      // Save pre-move position for swept collision
      const prevTheta = p.theta;
      const prevPhi = p.phi;

      // Move projectile on sphere
      moveOnSphere(p, PLANET_ROTATION_SPEED, dt);

      // Distance-based despawn: cap range to match client visual range
      if (p.maxDistanceRad) {
        const distTraveled = sphericalDistance(p.startTheta, p.startPhi, p.theta, p.phi);
        if (distTraveled > p.maxDistanceRad) {
          this.projectiles.splice(i, 1);
          continue;
        }
      }

      // Oriented-box collision: tank body is 5.5 long × 3 wide on radius 480 sphere.
      // Uses heading to check forward/right extents (same approach as terrain probes).
      const R = 480;
      const HALF_LEN = 3.5;   // Forward/back half-extent in world units (2.75 + latency margin)
      const HALF_WID = 2.5;   // Left/right half-extent in world units (1.5 + latency margin)
      const QUICK_REJECT = 0.010; // ~4.8 world units — skip distant players fast

      // Swept collision: check multiple points along the path to prevent tunneling
      const moveDist = sphericalDistance(prevTheta, prevPhi, p.theta, p.phi);
      // Step every ~1.9 world units (half of narrow box dim) to avoid skipping the hitbox
      const numSteps = Math.max(1, Math.ceil(moveDist / 0.004));
      let hitPlayer = false;

      // Theta wraparound: compute shortest delta for proper interpolation
      let dTheta = p.theta - prevTheta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = p.phi - prevPhi;

      for (let step = 0; step <= numSteps; step++) {
        const t = step / numSteps;
        let testTheta = prevTheta + dTheta * t;
        while (testTheta < 0) testTheta += Math.PI * 2;
        while (testTheta >= Math.PI * 2) testTheta -= Math.PI * 2;
        const testPhi = prevPhi + dPhi * t;

        // Check for hits against all players
        for (const [id, player] of this.players) {
          if (id === p.ownerId || player.isDead || player.waitingForPortal) continue;

          // No friendly fire — skip same-faction targets
          if (player.faction === p.ownerFaction) continue;

          // Quick reject: great-circle distance filter
          const dist = sphericalDistance(testTheta, testPhi, player.theta, player.phi);
          if (dist > QUICK_REJECT) {
            continue;
          }

          // Project displacement into tank's local frame using heading
          const sinPhi = Math.sin(player.phi);
          const safeSin = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
          let dtN = testTheta - player.theta;
          while (dtN > Math.PI) dtN -= Math.PI * 2;
          while (dtN < -Math.PI) dtN += Math.PI * 2;
          const dpN = testPhi - player.phi;
          const northOff = dpN * R;
          const eastOff = dtN * safeSin * R;
          const cosH = Math.cos(player.heading);
          const sinH = Math.sin(player.heading);
          const localFwd = -cosH * northOff - sinH * eastOff;
          const localRgt =  sinH * northOff - cosH * eastOff;

          if (Math.abs(localFwd) < HALF_LEN && Math.abs(localRgt) < HALF_WID) {
          // Hit! Use per-projectile damage (scales with charge)
          const damage = p.damage || 25;
          player.hp -= damage;


          // Award damage crypto to attacker (1¢ per HP, 10x for commander targets)
          const attacker = this.players.get(p.ownerId);
          if (attacker) {
            const isTargetCommander = this.commanders[player.faction]?.id === id;
            attacker.crypto += Math.floor(damage * (isTargetCommander ? 10 : 1));
          }

          this.io.to(this.roomId).emit("player-hit", {
            targetId: id,
            attackerId: p.ownerId,
            damage: damage,
            hp: player.hp,
            theta: p.theta,
            phi: p.phi,
          });

          if (player.hp <= 0) {
            player.hp = 0;
            player.isDead = true;
            player.speed = 0;

            const killer = this.players.get(p.ownerId);
            const killerName = killer ? killer.name : "Unknown";
            const victimName = player.name;

            this.io.to(this.roomId).emit("player-killed", {
              victimId: id,
              killerId: p.ownerId,
              victimFaction: player.faction,
              killerFaction: p.ownerFaction,
              victimName: victimName,
              killerName: killerName,
            });

            // Track kill/death streaks for Tusk
            if (killer) {
              killer.killStreak = (killer.killStreak || 0) + 1;
              killer.totalKills = (killer.totalKills || 0) + 1;
              const isVictimCommander = this.commanders[player.faction]?.id === id;
              killer.crypto += 500 * (isVictimCommander ? 10 : 1); // Kill bounty (10x for commanders)

              // Tusk kill announcement
              this.tuskChat.onKill(killerName, victimName, p.ownerFaction, player.faction);

              // Tusk kill streak announcement (at 3, 5, 7, 10+)
              if (killer.killStreak >= 3) {
                this.tuskChat.onKillStreak(killerName, killer.killStreak);
              }

              // Tusk player milestone (at 10, 25, 50, 100...)
              const milestones = [10, 25, 50, 100, 150, 200];
              if (milestones.includes(killer.totalKills)) {
                this.tuskChat.onPlayerMilestone(killerName, killer.totalKills);
              }

              // Tusk revenge kill (victim killed the killer recently)
              if (player.lastKilledBy === p.ownerId) {
                this.tuskChat.onRevengeKill(killerName, victimName);
              }
            }

            // Track death streak for victim
            player.killStreak = 0;
            player.deathCount = (player.deathCount || 0) + 1;
            player.lastKilledBy = p.ownerId;

            // Tusk death streak (3+ deaths within 5 minutes)
            const deathWindow = 300000; // 5 minutes
            if (player.deathCount === 1) {
              player.deathStreakStart = Date.now(); // Start window on first death
            }
            if (player.deathCount >= 3 && Date.now() - player.deathStreakStart < deathWindow) {
              const minutes = Math.floor((Date.now() - player.deathStreakStart) / 60000) || 1;
              this.tuskChat.onDeathStreak(victimName, player.deathCount, minutes);
            }
            // Reset streak if window expired
            if (player.deathStreakStart && Date.now() - player.deathStreakStart >= deathWindow) {
              player.deathCount = 1;
              player.deathStreakStart = Date.now();
            }

            // Kill bodyguards if victim was a commander
            for (const faction of FACTIONS) {
              if (this.commanders[faction]?.id === id) {
                this.bodyguardManager.killAllForFaction(faction);
                break;
              }
            }

            // Recompute ranks and commander
            this._recomputeRanks();

            // Respawn after 5 seconds
            setTimeout(() => this._respawnPlayer(id), 5000);
          }

          // Remove projectile on hit
          this.projectiles.splice(i, 1);
          hitPlayer = true;
          break;
        }
      }
      // Check bodyguard hits (after player checks)
      if (!hitPlayer) {
        const bgHit = this.bodyguardManager.checkProjectileHit(
          testTheta, testPhi, p.ownerFaction
        );
        if (bgHit) {
          const damage = p.damage || 25;
          const result = this.bodyguardManager.applyDamage(bgHit.id, damage);

          this.io.to(this.roomId).emit("player-hit", {
            targetId: bgHit.id,
            attackerId: p.ownerId,
            damage: damage,
            hp: bgHit.hp,
            theta: p.theta,
            phi: p.phi,
          });

          if (result.killed) {
            this.io.to(this.roomId).emit("bodyguard-killed", {
              id: bgHit.id,
              faction: bgHit.faction,
              killerFaction: p.ownerFaction,
            });
            // No crypto award for killing bodyguards
          }

          this.projectiles.splice(i, 1);
          hitPlayer = true;
          break;
        }
      }
      if (hitPlayer) break; // Exit swept collision loop
      }
    }
  }

  _respawnPlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    // Reset health but mark as waiting for portal selection
    player.hp = player.maxHp;
    player.isDead = false;
    player.speed = 0;
    player.waitingForPortal = true;

    // Recompute ranks and commander
    this._recomputeRanks();

    // Tell the respawning client to choose a portal
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("respawn-choose-portal", {
        id: socketId,
        hp: player.hp,
      });
    }
  }

  // ========================
  // SELF-DAMAGE (DEBUG)
  // ========================

  handleSelfDamage(socketId, amount) {
    const player = this.players.get(socketId);
    if (!player || player.isDead || player.waitingForPortal) return;

    const dmg = Math.min(Math.max(1, amount), player.hp);
    player.hp -= dmg;

    this.io.to(this.roomId).emit("player-hit", {
      targetId: socketId,
      attackerId: socketId,
      damage: dmg,
      hp: player.hp,
    });

    if (player.hp <= 0) {
      player.hp = 0;
      player.isDead = true;
      player.speed = 0;

      this.io.to(this.roomId).emit("player-killed", {
        victimId: socketId,
        killerId: socketId,
        victimFaction: player.faction,
        killerFaction: player.faction,
        victimName: player.name,
        killerName: player.name,
      });

      // Recompute ranks and commander
      this._recomputeRanks();

      player.killStreak = 0;
      player.deathCount = (player.deathCount || 0) + 1;
      setTimeout(() => this._respawnPlayer(socketId), 5000);
    }
  }

  // ========================
  // COMMANDER TIPPING
  // ========================

  handleTip(socketId, data) {
    const tipper = this.players.get(socketId);
    if (!tipper || tipper.isDead || tipper.waitingForPortal) return;

    // Validate tipper is the commander of their faction
    const commander = this.commanders[tipper.faction];
    if (!commander || commander.id !== socketId) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Not commander" });
      return;
    }

    const targetId = data.targetId;

    // Cannot tip yourself
    if (targetId === socketId) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Cannot tip yourself" });
      return;
    }

    // Cannot tip bodyguards
    if (targetId.startsWith("bodyguard-") || targetId.startsWith("bg-")) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Cannot tip bodyguards" });
      return;
    }

    const target = this.players.get(targetId);
    if (!target) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Player not found" });
      return;
    }

    // Must be same faction
    if (target.faction !== tipper.faction) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Can only tip faction members" });
      return;
    }

    // Server-side budget tracking (per commander per hour)
    if (!tipper._tipBudget || tipper._tipBudgetHourStart === undefined) {
      tipper._tipBudget = 5000;
      tipper._tipBudgetHourStart = Date.now();
      tipper._tipCooldowns = new Map();
    }

    // Hourly reset
    if (Date.now() - tipper._tipBudgetHourStart >= 3600000) {
      tipper._tipBudget = 5000;
      tipper._tipBudgetHourStart = Date.now();
    }

    const tipAmount = 100;

    if (tipper._tipBudget < tipAmount) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Insufficient budget" });
      return;
    }

    // Per-player cooldown (60s)
    const lastTip = tipper._tipCooldowns.get(targetId) || 0;
    if (Date.now() - lastTip < 60000) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Cooldown active" });
      return;
    }

    // All checks passed — execute tip
    tipper._tipBudget -= tipAmount;
    tipper._tipCooldowns.set(targetId, Date.now());
    target.crypto += tipAmount;

    // Notify the recipient
    this._emitToSocket(targetId, "tip-received", {
      fromId: socketId,
      fromName: tipper.name,
      amount: tipAmount,
      newCrypto: target.crypto,
    });

    // Confirm to the tipper (with server-authoritative budget)
    this._emitToSocket(socketId, "tip-confirmed", {
      targetId,
      targetName: target.name,
      amount: tipAmount,
      newBudget: tipper._tipBudget,
    });

    // Tusk announcement to everyone
    this.tuskChat.onCommanderTip(tipper.name, target.name, tipAmount);
  }

  _emitToSocket(socketId, event, data) {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) socket.emit(event, data);
  }

  // ========================
  // COMMANDER RESIGNATION
  // ========================

  handleResign(socketId, duration) {
    const player = this.players.get(socketId);
    if (!player || player.isDead || player.waitingForPortal) return;

    // Only the current commander can resign
    const commander = this.commanders[player.faction];
    if (!commander || commander.id !== socketId) return;

    // Clamp duration to 1 min – 24 h
    const ms = Math.max(60000, Math.min(duration || 60000, 86400000));
    this.resignedPlayers.set(socketId, Date.now() + ms);

    // Recompute ranks and commander (resigned player excluded → next-ranked takes over)
    this._recomputeRanks();
  }

  handleCancelResign(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    if (this.resignedPlayers.delete(socketId)) {
      // Player is eligible again — recompute ranks and commander
      this._recomputeRanks();
    }
  }

  handleCommanderOverride(socketId, socket) {
    const player = this.players.get(socketId);
    if (!player) return;

    // Lock this player as commander of their faction for 60 seconds
    this.commanderOverrides.set(player.faction, {
      id: socketId,
      until: Date.now() + 60000,
    });

    // Immediately recompute (override will be honored in _recomputeRanks)
    this._recomputeRanks();

    // Always confirm current commander state to the requester.
    // _recomputeRanks only broadcasts when the commander *changes*; if the
    // player was already commander the client would never get confirmation.
    if (socket) {
      const cmdr = this.commanders[player.faction];
      socket.emit("commander-update", {
        faction: player.faction,
        commander: cmdr,
      });
    }
  }

  // ========================
  // TERRITORY CAPTURE
  // ========================

  _updateCapture() {
    // 1. Build tank counts per cluster for all alive players
    const clusterTankCounts = new Map();

    for (const [id, player] of this.players) {
      if (player.isDead || player.waitingForPortal) continue;

      // getNearestTile expects local-space theta; player.theta is world-space, so add planetRotation
      const result = this.worldGen.getNearestTile(player.theta + this.planetRotation, player.phi);
      if (!result || result.clusterId === null) {
        player.currentClusterId = null;
        continue;
      }

      player.currentClusterId = result.clusterId;

      if (!clusterTankCounts.has(result.clusterId)) {
        clusterTankCounts.set(result.clusterId, { rust: 0, cobalt: 0, viridian: 0 });
      }
      clusterTankCounts.get(result.clusterId)[player.faction]++;
    }

    // 2. Process capture logic for each cluster with players in it
    const territoryChanges = [];

    for (const [clusterId, counts] of clusterTankCounts) {
      const state = this.clusterCaptureState.get(clusterId);
      if (!state) continue;

      const previousOwner = state.owner;

      // Calculate current total tics
      const currentTotalTics = state.tics.rust + state.tics.cobalt + state.tics.viridian;
      const isFull = currentTotalTics >= state.capacity;

      // Process tic gains per faction
      for (const faction of FACTIONS) {
        if (counts[faction] <= 0) continue;
        const ticsToAdd = counts[faction] * this.tickDelta;

        if (isFull) {
          // CONTEST PHASE: subtract from enemies before adding
          let enemyCount = 0;
          for (const f of FACTIONS) {
            if (f !== faction && state.tics[f] > 0) enemyCount++;
          }
          if (enemyCount > 0) {
            const lossPerEnemy = ticsToAdd / enemyCount;
            for (const f of FACTIONS) {
              if (f !== faction && state.tics[f] > 0) {
                state.tics[f] = Math.max(0, state.tics[f] - lossPerEnemy);
              }
            }
          }
        }

        state.tics[faction] += ticsToAdd;
      }

      // --- SOLO OCCUPATION: decay absent enemy tics ---
      const presentFactions = [];
      for (const f of FACTIONS) {
        if (counts[f] > 0) presentFactions.push(f);
      }

      if (presentFactions.length === 1) {
        const soloFaction = presentFactions[0];
        const decayRate = counts[soloFaction] * this.tickDelta;

        for (const f of FACTIONS) {
          if (f === soloFaction || state.tics[f] <= 0) continue;
          const decay = Math.min(state.tics[f], decayRate);
          state.tics[f] -= decay;
          state.tics[soloFaction] += decay;
        }
      }

      // Cap total tics at cluster capacity
      const totalTics = state.tics.rust + state.tics.cobalt + state.tics.viridian;
      if (totalTics > state.capacity) {
        const scale = state.capacity / totalTics;
        for (const faction of FACTIONS) {
          state.tics[faction] *= scale;
        }
      }

      // Determine ownership (only when capacity is filled)
      const currentTotal = state.tics.rust + state.tics.cobalt + state.tics.viridian;
      if (currentTotal >= state.capacity) {
        let maxTics = 0;
        let leadingFaction = null;
        let isTied = false;

        for (const faction of FACTIONS) {
          if (state.tics[faction] > maxTics) {
            maxTics = state.tics[faction];
            leadingFaction = faction;
            isTied = false;
          } else if (state.tics[faction] === maxTics && maxTics > 0) {
            isTied = true;
          }
        }

        state.owner = isTied ? null : leadingFaction;
      } else {
        state.owner = null;
      }

      // Track ownership changes for broadcast
      if (state.owner !== previousOwner) {
        territoryChanges.push({
          clusterId,
          owner: state.owner,
          tics: { ...state.tics },
          capacity: state.capacity,
        });
      }
    }

    // 2a. Award tic crypto to contributing players (once per second)
    this.captureSecondCounter++;
    if (this.captureSecondCounter >= this.tickRate) {
      this.captureSecondCounter = 0;
      for (const [id, player] of this.players) {
        if (player.isDead || player.waitingForPortal) continue;
        if (player.currentClusterId == null) continue;

        const state = this.clusterCaptureState.get(player.currentClusterId);
        if (!state) continue;

        // Only award crypto + pulse when actually gaining ground
        const currentTics = state.tics[player.faction];
        const sameCluster = player._lastTicCluster === player.currentClusterId;
        const lastTics = sameCluster ? player._lastTicCryptoTics : null;
        const gained = lastTics !== null && currentTics > lastTics + 0.001;

        player._lastTicCluster = player.currentClusterId;
        player._lastTicCryptoTics = currentTics;

        if (gained) {
          const ticPayload = {
            id: player.currentClusterId,
            t: { r: state.tics.rust, c: state.tics.cobalt, v: state.tics.viridian },
            cap: state.capacity,
          };
          this.io.to(id).emit("tic-crypto", ticPayload);
          player.crypto += 10; // Territory capture income
          player.territoryCaptured += currentTics - lastTics; // Rank tiebreaker
        }
      }

    }

    // 2b. Update sponsor hold timers
    for (const [sponsorId, clusterId] of this.sponsorClusterMap) {
      const state = this.clusterCaptureState.get(clusterId);
      if (!state) continue;
      const timer = this.sponsorHoldTimers.get(sponsorId);
      if (!timer) continue;

      if (state.owner && state.owner === timer.owner) {
        timer.holdDuration += this.tickDelta * 1000;
      } else if (state.owner && state.owner !== timer.owner) {
        timer.owner = state.owner;
        timer.capturedAt = Date.now();
        timer.holdDuration = 0;
      } else if (!state.owner && timer.owner) {
        timer.owner = null;
        timer.capturedAt = null;
        timer.holdDuration = 0;
      }
    }

    // 2c. Annotate territory changes with sponsor info
    for (const change of territoryChanges) {
      const sponsorId = this.clusterSponsorMap.get(change.clusterId);
      if (sponsorId) {
        change.sponsorId = sponsorId;
        change.holdTimer = { ...this.sponsorHoldTimers.get(sponsorId) };
      }
    }

    // 3. Broadcast territory changes to all clients
    if (territoryChanges.length > 0) {
      this.io.to(this.roomId).emit("territory-update", territoryChanges);

      // Notify Tusk about cluster captures
      for (const change of territoryChanges) {
        if (change.owner) {
          // Find a player of the capturing faction in the cluster area
          // (simplified: use first player of that faction as "capturer")
          let capturerName = change.owner.charAt(0).toUpperCase() + change.owner.slice(1);
          for (const [, player] of this.players) {
            if (player.faction === change.owner && !player.isDead && !player.waitingForPortal) {
              capturerName = player.name;
              break;
            }
          }
          const clusterLabel = `Sector ${change.clusterId}`;
          this.tuskChat.onClusterCapture(capturerName, clusterLabel, change.owner);
        }
      }
    }

    // 4. Broadcast capture progress to players in active clusters (throttled ~4x/sec)
    this.captureProgressCounter++;
    if (this.captureProgressCounter >= this.captureProgressRate) {
      this.captureProgressCounter = 0;

      // Group players by cluster
      const clusterPlayers = new Map();
      for (const [id, player] of this.players) {
        if (player.isDead || player.waitingForPortal) continue;
        if (player.currentClusterId == null) continue;
        if (!clusterPlayers.has(player.currentClusterId)) {
          clusterPlayers.set(player.currentClusterId, []);
        }
        clusterPlayers.get(player.currentClusterId).push(id);
      }

      for (const [clusterId, playerIds] of clusterPlayers) {
        const state = this.clusterCaptureState.get(clusterId);
        if (!state) continue;

        const progressData = {
          clusterId,
          tics: { ...state.tics },
          capacity: state.capacity,
          owner: state.owner,
        };

        for (const pid of playerIds) {
          this.io.to(pid).emit("capture-progress", progressData);
        }
      }
    }
  }

  // ========================
  // HOLDING CRYPTO (per-minute territory income)
  // ========================

  _awardHoldingCrypto() {
    const worldResult = this.worldResult;
    const adjacencyMap = worldResult.adjacencyMap;
    const HOLDING_EXPONENT = 1.05;

    // Build owned hex sets per faction (one pass over all clusters)
    const factionOwnedHexes = {
      rust: new Set(),
      cobalt: new Set(),
      viridian: new Set(),
    };

    for (const [clusterId, state] of this.clusterCaptureState) {
      if (!state.owner) continue;
      const cluster = worldResult.clusterData[clusterId];
      if (!cluster) continue;
      for (const tileIdx of cluster.tiles) {
        factionOwnedHexes[state.owner].add(tileIdx);
      }
    }

    // Calculate total holding crypto per faction
    const factionCrypto = { rust: 0, cobalt: 0, viridian: 0 };

    for (const faction of ["rust", "cobalt", "viridian"]) {
      const ownedHexes = factionOwnedHexes[faction];
      if (ownedHexes.size === 0) continue;

      let total = 0;
      for (const tileIdx of ownedHexes) {
        const neighbors = adjacencyMap.get(tileIdx) || [];
        let friendlyNeighbors = 0;
        for (const n of neighbors) {
          if (ownedHexes.has(n)) friendlyNeighbors++;
        }
        total += Math.pow(HOLDING_EXPONENT, friendlyNeighbors);
      }
      factionCrypto[faction] = Math.round(total);
    }

    // Award to each alive player and emit event
    for (const [id, player] of this.players) {
      if (player.isDead || player.waitingForPortal) continue;

      const amount = factionCrypto[player.faction];
      if (amount <= 0) continue;

      player.crypto += amount;
      this.io.to(id).emit("holding-crypto", { amount });
    }
  }

  // ========================
  // STATE BROADCASTING
  // ========================

  _broadcastState() {
    // Build compact state snapshot
    const playerStates = {};
    for (const [id, p] of this.players) {
      const state = {
        t: p.theta,        // theta
        p: p.phi,          // phi
        h: p.heading,      // heading
        s: p.speed,        // speed
        ta: p.turretAngle, // turret angle
        hp: p.hp,
        d: p.waitingForPortal ? 2 : (p.isDead ? 1 : 0), // 0=alive, 1=dead, 2=waiting
        seq: p.lastInputSeq, // so client knows which input was processed
        f: p.faction,      // faction (ensures sync on missed events / late joins)
        r: p.rank || 0,    // faction rank (1-based, server-authoritative)
      };
      playerStates[id] = state;
    }

    // Build state payload
    const statePayload = {
      tick: this.tick,
      players: playerStates,
      bg: this.bodyguardManager.getStatesForBroadcast(), // Bodyguard states
      pr: this.planetRotation,
      ma: this.moons.map(m => m.angle),
      // Only send dynamic orbital data per tick (angle + rotation)
      sa: this.stations.map(s => [s.orbitalAngle, s.localRotation]),
    };

    // Include full orbital params every 100 ticks (~5s) to handle late joins / missed welcome
    if (this.tick % 100 === 0) {
      statePayload.sa = this.stations.map(s => [s.orbitalAngle, s.localRotation, s.inclination, s.ascendingNode, s.orbitRadius]);
    }

    // volatile: if client buffer is full, drop stale state rather than queueing
    this.io.to(this.roomId).volatile.emit("state", statePayload);
  }

  _getAllPlayerStates() {
    const states = {};
    for (const [id, p] of this.players) {
      states[id] = {
        id: p.id,
        name: p.name,
        faction: p.faction,
        theta: p.theta,
        phi: p.phi,
        heading: p.heading,
        turretAngle: p.turretAngle,
        hp: p.hp,
        maxHp: p.maxHp,
        isDead: p.isDead,
        waitingForPortal: p.waitingForPortal,
        level: p.level,
        badges: p.badges,
        totalCrypto: p.totalCrypto,
        title: p.title,
        crypto: p.crypto,
        rank: p.rank || 0,
      };
    }
    return states;
  }

  _broadcastCrypto() {
    const cryptoState = {};
    for (const [id, p] of this.players) {
      cryptoState[id] = p.crypto;
    }
    this.io.to(this.roomId).emit("crypto-update", cryptoState);
  }

  // ========================
  // COMMANDER RANKING
  // ========================

  /**
   * Server-authoritative faction change for any player.
   * Strips commander if the switching player was one, re-evaluates both factions.
   */
  handleFactionChange(socketId, newFaction) {
    const player = this.players.get(socketId);
    if (!player) return;

    const oldFaction = player.faction;
    if (oldFaction === newFaction) return;

    // If this player was commander of the old faction, clear the slot + despawn bodyguards
    if (this.commanders[oldFaction]?.id === socketId) {
      this.bodyguardManager.despawnForFaction(oldFaction);
      this.commanders[oldFaction] = null;
    }

    // Update faction
    player.faction = newFaction;

    // Broadcast faction change to all clients
    this.io.to(this.roomId).emit("player-faction-changed", {
      id: socketId,
      faction: newFaction,
    });

    // Recompute ranks and commanders for all factions
    this._recomputeRanks();
  }

  /**
   * Recompute faction ranks for all factions and update commanders.
   * Ranks include ALL connected players (even dead/waiting) except resigned.
   * Sorted by: level DESC → totalCrypto DESC → territoryCaptured DESC.
   * Assigns player.rank (1-based, unique per faction).
   * Commander is ALWAYS the #1 ranked player — switches instantly.
   */
  _recomputeRanks() {
    const now = Date.now();
    for (const faction of FACTIONS) {
      const members = [];
      for (const [id, p] of this.players) {
        if (p.faction !== faction) continue;
        // Exclude resigned players (auto-clear expired resignations)
        const resignedUntil = this.resignedPlayers.get(id);
        if (resignedUntil) {
          if (now < resignedUntil) continue;
          this.resignedPlayers.delete(id);
        }
        members.push(p);
      }
      members.sort((a, b) => {
        const aLevel = a.level || 1, bLevel = b.level || 1;
        if (bLevel !== aLevel) return bLevel - aLevel;
        const aCrypto = a.totalCrypto || 0, bCrypto = b.totalCrypto || 0;
        if (bCrypto !== aCrypto) return bCrypto - aCrypto;
        return (b.territoryCaptured || 0) - (a.territoryCaptured || 0);
      });
      for (let i = 0; i < members.length; i++) {
        members[i].rank = i + 1;
      }

      // Check for active commander override (dev testing — locks for 60s)
      const override = this.commanderOverrides.get(faction);
      let overridePlayer = null;
      if (override) {
        if (now < override.until) {
          overridePlayer = members.find(m => m.id === override.id) || null;
        } else {
          this.commanderOverrides.delete(faction);
        }
      }

      // Commander is the override player (if active) or the #1 ranked player
      const current = this.commanders[faction];
      const topPlayer = overridePlayer || members[0] || null;

      if (!topPlayer) {
        if (current) {
          this.bodyguardManager.despawnForFaction(faction);
          this.commanders[faction] = null;
          this.io.to(this.roomId).emit("commander-update", {
            faction,
            commander: null,
          });
        }
      } else if (!current || current.id !== topPlayer.id) {
        this.bodyguardManager.despawnForFaction(faction);
        this.commanders[faction] = { id: topPlayer.id, name: topPlayer.name };
        // Spawn bodyguards for the new commander
        this.bodyguardManager.spawnForCommander(faction, topPlayer.id, topPlayer);
        this.io.to(this.roomId).emit("commander-update", {
          faction,
          commander: { id: topPlayer.id, name: topPlayer.name },
        });
      } else if (topPlayer && !topPlayer.isDead && !topPlayer.waitingForPortal) {
        // Same commander, alive & deployed — respawn bodyguards if dead or missing
        const hasDead = this.bodyguardManager.hasDeadBodyguards(faction);
        const hasBg = this.bodyguardManager.hasBodyguards(faction);
        if (hasDead || !hasBg) {
          this.bodyguardManager.despawnForFaction(faction);
          this.bodyguardManager.spawnForCommander(faction, topPlayer.id, topPlayer);
        }
      }
    }
  }

  /**
   * Build a snapshot of current commanders for the welcome packet.
   */
  _getCommanderSnapshot() {
    const snapshot = {};
    for (const faction of FACTIONS) {
      snapshot[faction] = this.commanders[faction]
        ? { id: this.commanders[faction].id, name: this.commanders[faction].name }
        : null;
    }
    return snapshot;
  }

  // ========================
  // HELPERS
  // ========================

  _applySponsorClusters(worldResult) {
    for (const sponsor of this.sponsors) {
      if (!sponsor.cluster || !sponsor.cluster.tileIndices || sponsor.cluster.tileIndices.length === 0) {
        continue;
      }

      const tileIndices = sponsor.cluster.tileIndices;
      const sponsorClusterId = worldResult.clusterData.length;

      // Remove sponsor tiles from their original procedural clusters
      const affectedClusters = new Set();
      for (const tileIndex of tileIndices) {
        const originalClusterId = worldResult.tileClusterMap.get(tileIndex);
        if (originalClusterId !== undefined) {
          affectedClusters.add(originalClusterId);
          const originalCluster = worldResult.clusterData[originalClusterId];
          if (originalCluster) {
            originalCluster.tiles = originalCluster.tiles.filter(t => t !== tileIndex);
          }
        }
        // Reassign to sponsor cluster
        worldResult.tileClusterMap.set(tileIndex, sponsorClusterId);
      }

      // Create new cluster entry for sponsor
      worldResult.clusterData.push({
        id: sponsorClusterId,
        tiles: tileIndices.slice(),
        isSponsorCluster: true,
        sponsorId: sponsor.id,
      });

      // Assign a distinct visual for sponsor clusters
      worldResult.clusterColors.set(sponsorClusterId, 0x1a4a4a);
      worldResult.clusterPatterns.set(sponsorClusterId, 0);

      // Remove terrain elevation from sponsor tiles (keep them flat)
      for (const tileIndex of tileIndices) {
        this.terrain.tileElevation.delete(tileIndex);
        this.terrain.elevatedTileSet.delete(tileIndex);
      }

      // Track mappings
      this.sponsorClusterMap.set(sponsor.id, sponsorClusterId);
      this.clusterSponsorMap.set(sponsorClusterId, sponsor.id);

      // Initialize hold timer
      this.sponsorHoldTimers.set(sponsor.id, {
        owner: null,
        capturedAt: null,
        holdDuration: 0,
      });
    }
  }

  _buildWorldPayload(worldResult) {
    // Serialize cluster data: array of { id, tiles: number[] }
    const clusters = worldResult.clusterData.map((c) => ({
      id: c.id,
      tiles: c.tiles,
    }));

    // Serialize tileClusterMap as a flat array (index = tileIndex, value = clusterId)
    const tileClusterArr = new Array(worldResult.tiles.length).fill(-1);
    for (const [tileIdx, clusterId] of worldResult.tileClusterMap) {
      tileClusterArr[tileIdx] = clusterId;
    }

    // Serialize terrain elevation as a flat array (index = tileIndex, value = level)
    const tileElevationArr = new Array(worldResult.tiles.length).fill(0);
    for (const [tileIdx, level] of this.terrain.tileElevation) {
      tileElevationArr[tileIdx] = level;
    }

    // Cluster visual properties (colors + patterns)
    const clusterVisuals = {};
    for (const [cid, color] of worldResult.clusterColors) {
      clusterVisuals[cid] = {
        color,
        pattern: worldResult.clusterPatterns.get(cid),
      };
    }

    // Serialize sponsor data for clients (includes base64 images for textures)
    const sponsors = this.sponsors.map(s => ({
      id: s.id,
      name: s.name,
      tagline: s.tagline,
      websiteUrl: s.websiteUrl,
      logoImage: s.logoImage,
      patternImage: s.patternImage,
      patternAdjustment: s.patternAdjustment,
      cluster: { tileIndices: s.cluster.tileIndices },
      rewards: s.rewards,
      active: s.active,
      clusterId: this.sponsorClusterMap.get(s.id),
    }));

    return {
      clusters,
      tileClusterMap: tileClusterArr,
      tileElevation: tileElevationArr,
      clusterVisuals,
      portalCenterIndices: Array.from(worldResult.portalCenterIndices),
      portalTileIndices: Array.from(worldResult.portalTileIndices),
      polarTileIndices: Array.from(worldResult.polarTileIndices),
      sponsors,
    };
  }

  _getSpawnPosition(excludeSocketId = null) {
    if (this.portalPositions.length > 0) {
      // Pick a random portal, then the adjacent hex tile farthest from other tanks
      const portalCenters = Array.from(this.portalNeighborPositions.keys());
      const portalIdx =
        portalCenters[Math.floor(Math.random() * portalCenters.length)];
      const neighbors = this.portalNeighborPositions.get(portalIdx) || [];
      const spawnPos =
        neighbors.length > 0
          ? this._pickFarthestNeighbor(neighbors, excludeSocketId)
          : this.portalPositions[
              Math.floor(Math.random() * this.portalPositions.length)
            ];

      const offsetAngle = Math.random() * Math.PI * 2;
      const offsetMag = 0.001 + Math.random() * 0.002;
      // Positions are local-space; subtract planetRotation for world-space
      let theta = spawnPos.theta - this.planetRotation + Math.cos(offsetAngle) * offsetMag;
      while (theta < 0) theta += Math.PI * 2;
      while (theta >= Math.PI * 2) theta -= Math.PI * 2;
      return {
        theta,
        phi: Math.max(
          0.1,
          Math.min(Math.PI - 0.1, spawnPos.phi + Math.sin(offsetAngle) * offsetMag)
        ),
      };
    }
    // Fallback: random mid-latitude spawn (before portals are received)
    return {
      theta: Math.random() * Math.PI * 2,
      phi: Math.PI / 4 + Math.random() * (Math.PI / 2),
    };
  }

  /**
   * Pick the neighbor hex that maximizes minimum distance from all active tanks.
   * @param {Array<{theta: number, phi: number}>} neighbors - local-space positions
   * @param {string|null} excludeSocketId - socket ID to exclude from distance check
   * @returns {{theta: number, phi: number}} chosen neighbor in local space
   */
  _pickFarthestNeighbor(neighbors, excludeSocketId = null) {
    if (neighbors.length <= 1) return neighbors[0] || null;

    // Collect world-space positions of all active (alive, deployed) tanks
    const tankPositions = [];
    for (const [sid, p] of this.players) {
      if (sid === excludeSocketId) continue;
      if (p.isDead || p.waitingForPortal) continue;
      tankPositions.push({ theta: p.theta, phi: p.phi });
    }

    // No other tanks — pick random
    if (tankPositions.length === 0) {
      return neighbors[Math.floor(Math.random() * neighbors.length)];
    }

    let bestNeighbor = null;
    let bestMinDist = -1;

    for (const n of neighbors) {
      // Convert neighbor to world space for comparison
      let nTheta = n.theta - this.planetRotation;
      while (nTheta < 0) nTheta += Math.PI * 2;
      while (nTheta >= Math.PI * 2) nTheta -= Math.PI * 2;
      const nPhi = n.phi;

      // Find minimum angular distance to any active tank
      let minDist = Infinity;
      for (const t of tankPositions) {
        const cosDist =
          Math.cos(nPhi) * Math.cos(t.phi) +
          Math.sin(nPhi) * Math.sin(t.phi) * Math.cos(nTheta - t.theta);
        const dist = Math.acos(Math.max(-1, Math.min(1, cosDist)));
        if (dist < minDist) minDist = dist;
      }

      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestNeighbor = n;
      }
    }

    return bestNeighbor;
  }

  _getLeastPopulatedFaction() {
    const counts = { rust: 0, cobalt: 0, viridian: 0 };
    for (const [, p] of this.players) {
      counts[p.faction]++;
    }
    // Return faction with fewest players
    let minFaction = FACTIONS[0];
    let minCount = counts[minFaction];
    for (const f of FACTIONS) {
      if (counts[f] < minCount) {
        minCount = counts[f];
        minFaction = f;
      }
    }
    return minFaction;
  }

  _pickName() {
    // Pick a name not already in use
    const usedNames = new Set();
    for (const [, p] of this.players) {
      usedNames.add(p.name);
    }
    const available = BOT_NAME_POOL.filter((n) => !usedNames.has(n));
    if (available.length === 0) {
      return "Player_" + Math.floor(Math.random() * 9999);
    }
    return available[Math.floor(Math.random() * available.length)];
  }
}

module.exports = GameRoom;
