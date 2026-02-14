/**
 * AdLands - GameRoom
 * One game instance: manages all player state, runs the server tick loop,
 * and broadcasts world state to connected clients.
 */

const {
  FACTIONS,
  TANK_PHYSICS,
  PLANET_ROTATION_SPEED,
  POLAR_PHI_LIMIT,
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
  constructor(io, roomId, sponsorStore, sponsorImageUrls, moonSponsorStore, moonSponsorImageUrls, billboardSponsorStore, billboardSponsorImageUrls) {
    this.io = io;
    this.roomId = roomId;
    this.sponsorStore = sponsorStore || null;
    this.sponsorImageUrls = sponsorImageUrls || {};
    this.moonSponsorStore = moonSponsorStore || null;
    this.moonSponsorImageUrls = moonSponsorImageUrls || {};
    this.billboardSponsorStore = billboardSponsorStore || null;
    this.billboardSponsorImageUrls = billboardSponsorImageUrls || {};

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

    // Server-authoritative billboard orbital parameters (18 billboards across 2 tiers)
    this.billboardOrbits = this._generateBillboardOrbits();

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

    // Throttle rank recomputation to once per second (or when dirty flag is set)
    this.rankRecomputeCounter = 0;
    this._ranksDirty = false;

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
      this.sponsors = this.sponsorStore.getAll().filter(s => s.active !== false && !s.paused);
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

    // ---- All-profile faction ranking cache ----
    // Stores ALL profiles from Firestore (online + offline) for true faction ranking.
    // Updated live as connected players' stats change.
    this.factionProfileCache = { rust: [], cobalt: [], viridian: [] };
    this.profileCacheIndex = new Map();  // "uid:profileIndex" → cache entry reference
    this.profileCacheReady = false;
    this.factionMemberCounts = { rust: 0, cobalt: 0, viridian: 0 };
    this._factionRosters = {};           // faction → sorted member array (set by _recomputeRanks)
  }

  start() {
    this._tickRunning = true;
    this._nextTickTime = Date.now();
    this._scheduleTick();
    console.log(`[Room ${this.roomId}] Started at ${this.tickRate} ticks/sec`);

    // Load all Firestore profiles into cache (async, non-blocking)
    this._loadAllProfiles();
  }

  /**
   * Load all player profiles from Firestore into the faction profile cache.
   * Called once on startup. Cache is then updated live as players connect/disconnect.
   */
  async _loadAllProfiles() {
    try {
      const { getFirestore } = require("./firebaseAdmin");
      const db = getFirestore();

      const snapshot = await db.collectionGroup("profiles").get();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (!data.faction || !FACTIONS.includes(data.faction)) continue;

        // Extract uid and profileIndex from path: accounts/{uid}/profiles/{index}
        const pathParts = doc.ref.path.split("/");
        const uid = pathParts[1];
        const profileIndex = parseInt(pathParts[3], 10);

        const cacheKey = `${uid}:${profileIndex}`;
        const entry = {
          uid,
          profileIndex,
          name: data.name || "Unknown",
          faction: data.faction,
          level: data.level || 1,
          totalCrypto: data.totalCrypto || 0,
          territoryCaptured: (data.hexesCaptured || 0) + (data.clustersCaptured || 0),
          lastPlayedAt: data.lastPlayedAt || null,
          isOnline: false,
          socketId: null,
        };

        this.factionProfileCache[data.faction].push(entry);
        this.profileCacheIndex.set(cacheKey, entry);
      }

      this.profileCacheReady = true;
      this._markRanksDirty();
      console.log(`[Room ${this.roomId}] Loaded ${snapshot.size} profiles from Firestore`);
    } catch (err) {
      console.warn(`[Room ${this.roomId}] Failed to load profiles from Firestore:`, err.message);
      this.profileCacheReady = false;
    }
  }

  stop() {
    this._tickRunning = false;
    if (this.tickInterval) {
      clearTimeout(this.tickInterval);
      this.tickInterval = null;
    }
    console.log(`[Room ${this.roomId}] Stopped`);
  }

  /**
   * Self-correcting tick scheduler using setTimeout.
   * Unlike setInterval, this never queues up ticks when processing runs long —
   * it yields to the event loop between ticks so socket events (ping, input)
   * can be processed promptly. Drops ticks if falling behind >200ms.
   */
  _scheduleTick() {
    if (!this._tickRunning) return;
    const now = Date.now();
    const tickMs = 1000 / this.tickRate;

    // If we've fallen behind by more than 4 ticks, skip ahead (don't cascade)
    if (now - this._nextTickTime > tickMs * 4) {
      this._nextTickTime = now;
    }

    this._nextTickTime += tickMs;
    const delay = Math.max(1, this._nextTickTime - now);
    this.tickInterval = setTimeout(() => {
      this._gameTick();
      this._scheduleTick();
    }, delay);
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

    // 3. Re-read and re-apply sponsors (exclude paused)
    this.sponsors = this.sponsorStore.getAll().filter(s => s.active !== false && !s.paused);
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
  // LIVE MOON SPONSOR RELOAD
  // ========================

  /**
   * Build moon sponsor payload for clients (URLs instead of base64).
   */
  _buildMoonSponsorPayload() {
    if (!this.moonSponsorStore) return [null, null, null];
    const pausedNames = this._getPausedSponsorNames();
    return this.moonSponsorStore.getAll().map((sponsor, i) => {
      if (!sponsor || sponsor.active === false) return null;
      // Hide moon if its sponsor name is paused
      if (sponsor.name && pausedNames.has(sponsor.name.toLowerCase())) return null;
      const urls = this.moonSponsorImageUrls[i] || {};
      const cacheBust = sponsor.updatedAt ? `?v=${encodeURIComponent(sponsor.updatedAt)}` : '';
      return {
        moonIndex: i,
        name: sponsor.name,
        tagline: sponsor.tagline,
        websiteUrl: sponsor.websiteUrl,
        patternImage: urls.patternUrl ? urls.patternUrl + cacheBust : null,
        patternAdjustment: sponsor.patternAdjustment,
        createdAt: sponsor.createdAt,
        logoImage: sponsor.logoImage || null,
      };
    });
  }

  /**
   * Reload moon sponsors and broadcast to all connected clients.
   * Called by the REST API after moon sponsor assign/clear.
   */
  reloadMoonSponsors() {
    if (!this.moonSponsorStore) return;
    const moonSponsors = this._buildMoonSponsorPayload();
    this.io.to(this.roomId).emit("moon-sponsors-reloaded", { moonSponsors });
    const active = moonSponsors.filter(Boolean).length;
    console.log(`[Room ${this.roomId}] Moon sponsors reloaded: ${active} active, broadcast to clients`);
  }

  _generateBillboardOrbits() {
    const orbits = [
      { distance: 538, count: 12 },
      { distance: 850, count: 6 },
    ];
    const maxInclination = Math.PI / 3; // 60° — never pass over poles
    const wobbleRange = 0.087; // ~5° orientation wobble
    const result = [];
    for (const orbit of orbits) {
      for (let i = 0; i < orbit.count; i++) {
        // Per-billboard distance offset (±30 units) to stagger orbits
        const distanceOffset = (Math.random() - 0.5) * 60;
        result.push({
          orbitalAngle: Math.random() * Math.PI * 2,
          speed: 0.008 * Math.sqrt(480 / orbit.distance) * (Math.random() > 0.5 ? 1 : -1),
          orbitRadius: orbit.distance + distanceOffset,
          inclination: Math.random() * maxInclination,
          ascendingNode: Math.random() * Math.PI * 2,
          wobbleX: (Math.random() - 0.5) * 2 * wobbleRange,
          wobbleY: (Math.random() - 0.5) * 2 * wobbleRange,
          wobbleZ: (Math.random() - 0.5) * 2 * wobbleRange,
        });
      }
    }
    return result;
  }

  _buildBillboardSponsorPayload() {
    if (!this.billboardSponsorStore) return new Array(18).fill(null);
    const pausedNames = this._getPausedSponsorNames();
    return this.billboardSponsorStore.getAll().map((sponsor, i) => {
      if (!sponsor || sponsor.active === false) return null;
      // Hide billboard if its sponsor name is paused
      if (sponsor.name && pausedNames.has(sponsor.name.toLowerCase())) return null;
      const urls = this.billboardSponsorImageUrls[i] || {};
      const cacheBust = sponsor.updatedAt ? `?v=${encodeURIComponent(sponsor.updatedAt)}` : '';
      return {
        billboardIndex: i,
        name: sponsor.name,
        tagline: sponsor.tagline,
        websiteUrl: sponsor.websiteUrl,
        patternImage: urls.patternUrl ? urls.patternUrl + cacheBust : null,
        patternAdjustment: sponsor.patternAdjustment,
        createdAt: sponsor.createdAt,
        logoImage: sponsor.logoImage || null,
      };
    });
  }

  /**
   * Reload billboard sponsors and broadcast to all connected clients.
   * Called by the REST API after billboard sponsor assign/clear.
   */
  reloadBillboardSponsors() {
    if (!this.billboardSponsorStore) return;
    const billboardSponsors = this._buildBillboardSponsorPayload();
    this.io.to(this.roomId).emit("billboard-sponsors-reloaded", { billboardSponsors });
    const active = billboardSponsors.filter(Boolean).length;
    console.log(`[Room ${this.roomId}] Billboard sponsors reloaded: ${active} active, broadcast to clients`);
  }

  // ========================
  // PLAYER MANAGEMENT
  // ========================

  addPlayer(socket) {
    // Use authenticated profile data if available, otherwise defaults
    const profileData = socket.profileData;

    // Assign faction: from profile if authenticated, otherwise balance teams
    const faction = profileData?.faction || this._getLeastPopulatedFaction();

    // Spawn near a random portal (or mid-latitudes if portals not yet received)
    const spawn = this._getSpawnPosition(socket.id);

    const player = {
      id: socket.id,
      uid: socket.uid || null,               // Firebase UID (null for guests)
      profileIndex: socket.profileIndex || 0, // Active profile slot (0-2)
      isAuthenticated: !!socket.uid,

      name: profileData?.name || this._pickName(),
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
      level: profileData?.level || 1,
      crypto: profileData?.totalCrypto || 0,

      // Territory contribution counter (tic deltas accumulated)
      territoryCaptured: 0,

      // Server-computed faction rank (1-based, unique per faction)
      rank: 0,

      // Cannon cooldown (server-authoritative)
      lastFireTime: 0,

      // Profile data (from Firestore or sent by client after connect)
      badges: profileData?.unlockedBadges?.map(b => b.id) || [],
      totalCrypto: profileData?.totalCrypto || 0,
      title: profileData?.titleStats?.currentTitle || "Contractor",
      profilePicture: profileData?.profilePicture || null,
      loadout: profileData?.loadout || {},
      tankUpgrades: profileData?.tankUpgrades || { armor: 0, speed: 0, fireRate: 0, damage: 0 },

      // Session tracking for Firestore saves (deltas accumulated this session)
      _sessionKills: 0,
      _sessionDeaths: 0,
      _sessionDamageDealt: 0,
      _sessionHexes: 0,
      _sessionClusters: 0,
      _sessionTics: 0,
      _sessionDefendTime: 0,
    };

    this.players.set(socket.id, player);
    socket.join(this.roomId);

    // Update faction profile cache (mark this player as online)
    if (player.uid && this.profileCacheReady) {
      const cacheKey = `${player.uid}:${player.profileIndex}`;
      let entry = this.profileCacheIndex.get(cacheKey);
      if (entry) {
        entry.isOnline = true;
        entry.socketId = socket.id;
        entry.name = player.name;
        entry.level = player.level || 1;
        entry.totalCrypto = player.totalCrypto || 0;
        entry.territoryCaptured = player.territoryCaptured || 0;
      } else {
        // New player not yet in cache — add them
        entry = {
          uid: player.uid,
          profileIndex: player.profileIndex,
          name: player.name,
          faction: player.faction,
          level: player.level || 1,
          totalCrypto: player.totalCrypto || 0,
          territoryCaptured: player.territoryCaptured || 0,
          lastPlayedAt: null,
          isOnline: true,
          socketId: socket.id,
        };
        this.factionProfileCache[player.faction].push(entry);
        this.profileCacheIndex.set(cacheKey, entry);
      }
    }

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
        factionTotal: this.factionMemberCounts[player.faction] || 0,
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
        billboards: this.billboardOrbits.map(b => ({
          orbitalAngle: b.orbitalAngle, speed: b.speed,
          orbitRadius: b.orbitRadius, inclination: b.inclination,
          ascendingNode: b.ascendingNode,
          wobbleX: b.wobbleX, wobbleY: b.wobbleY, wobbleZ: b.wobbleZ,
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
    this._markRanksDirty();

    console.log(
      `[Room ${this.roomId}] ${player.name} (${player.faction}) joined. ` +
      `Players: ${this.players.size}`
    );

    return player;
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    // Mark offline in profile cache (keep in roster)
    if (player.uid && this.profileCacheReady) {
      const cacheKey = `${player.uid}:${player.profileIndex}`;
      const entry = this.profileCacheIndex.get(cacheKey);
      if (entry) {
        entry.isOnline = false;
        entry.socketId = null;
        // Persist latest stats so offline ranking stays accurate
        entry.level = player.level || entry.level;
        entry.totalCrypto = player.totalCrypto || entry.totalCrypto;
        entry.territoryCaptured = player.territoryCaptured || entry.territoryCaptured;
      }
    }

    this.players.delete(socketId);
    this.resignedPlayers.delete(socketId);

    // Recompute ranks and commander (player now offline — may trigger Acting Commander)
    this._markRanksDirty();

    // Tell everyone the player left
    this.io.to(this.roomId).emit("player-left", { id: socketId });

    console.log(
      `[Room ${this.roomId}] ${player.name} left. Players: ${this.players.size}`
    );
  }

  // ========================
  // PROFILE PERSISTENCE
  // ========================

  /**
   * Save a player's session stats to Firestore.
   * Called periodically (every 60s), on disconnect, and before profile switch.
   */
  async savePlayerProfile(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid) return; // Skip guests

    try {
      const { getFirestore } = require("./firebaseAdmin");
      const db = getFirestore();
      const admin = require("firebase-admin");

      const profileRef = db
        .collection("accounts").doc(player.uid)
        .collection("profiles").doc(String(player.profileIndex));

      // Use increments for session deltas (avoids race conditions)
      const updates = {
        lastPlayedAt: admin.firestore.FieldValue.serverTimestamp(),
        level: player.level,
        totalCrypto: player.totalCrypto,
      };

      // Only increment stats that have accumulated this session
      if (player._sessionKills > 0) {
        updates.kills = admin.firestore.FieldValue.increment(player._sessionKills);
        player._sessionKills = 0;
      }
      if (player._sessionDeaths > 0) {
        updates.deaths = admin.firestore.FieldValue.increment(player._sessionDeaths);
        player._sessionDeaths = 0;
      }
      if (player._sessionDamageDealt > 0) {
        updates.damageDealt = admin.firestore.FieldValue.increment(player._sessionDamageDealt);
        player._sessionDamageDealt = 0;
      }
      if (player._sessionHexes > 0) {
        updates.hexesCaptured = admin.firestore.FieldValue.increment(player._sessionHexes);
        player._sessionHexes = 0;
      }
      if (player._sessionClusters > 0) {
        updates.clustersCaptured = admin.firestore.FieldValue.increment(player._sessionClusters);
        player._sessionClusters = 0;
      }
      if (player._sessionTics > 0) {
        updates.ticsContributed = admin.firestore.FieldValue.increment(player._sessionTics);
        player._sessionTics = 0;
      }
      if (player._sessionDefendTime > 0) {
        updates.timeDefending = admin.firestore.FieldValue.increment(player._sessionDefendTime);
        player._sessionDefendTime = 0;
      }

      await profileRef.update(updates);

      // Also update denormalized level on account profiles array
      await db.collection("accounts").doc(player.uid).update({
        [`profiles.${player.profileIndex}.level`]: player.level,
      });

      // Keep faction profile cache in sync
      if (this.profileCacheReady) {
        const cacheKey = `${player.uid}:${player.profileIndex}`;
        const entry = this.profileCacheIndex.get(cacheKey);
        if (entry) {
          entry.level = player.level;
          entry.totalCrypto = player.totalCrypto;
          entry.territoryCaptured = player.territoryCaptured || entry.territoryCaptured;
        }
      }
    } catch (err) {
      console.warn(`[Room ${this.roomId}] Failed to save profile for ${socketId}:`, err.message);
    }
  }

  /**
   * Handle a player switching their active profile mid-game.
   * Resets player state with new profile data and broadcasts to all clients.
   */
  handleProfileSwitch(socketId, profileData) {
    const player = this.players.get(socketId);
    if (!player) return;

    const oldFaction = player.faction;

    // Update player data from new profile
    player.name = profileData.name || player.name;
    player.faction = profileData.faction || player.faction;
    player.level = profileData.level || 1;
    player.totalCrypto = profileData.totalCrypto || 0;
    player.crypto = profileData.totalCrypto || 0;
    player.badges = profileData.unlockedBadges?.map(b => b.id) || [];
    player.title = profileData.titleStats?.currentTitle || "Contractor";
    player.profilePicture = profileData.profilePicture || null;
    player.loadout = profileData.loadout || {};
    player.tankUpgrades = profileData.tankUpgrades || { armor: 0, speed: 0, fireRate: 0, damage: 0 };

    // Reset session stats
    player._sessionKills = 0;
    player._sessionDeaths = 0;
    player._sessionDamageDealt = 0;
    player._sessionHexes = 0;
    player._sessionClusters = 0;
    player._sessionTics = 0;
    player._sessionDefendTime = 0;

    // Reset combat state
    player.hp = player.maxHp;
    player.isDead = false;
    player.waitingForPortal = true;
    player.territoryCaptured = 0;

    // Broadcast to all clients
    this.io.to(this.roomId).emit("player-profile-switched", {
      id: socketId,
      name: player.name,
      faction: player.faction,
      level: player.level,
      badges: player.badges,
      title: player.title,
      totalCrypto: player.totalCrypto,
      rank: player.rank || 0,
      profilePicture: player.profilePicture,
    });

    // Update faction profile cache for profile switch
    if (player.uid && this.profileCacheReady) {
      // Mark old cache entry offline
      const oldCacheKey = `${player.uid}:${player._prevProfileIndex ?? player.profileIndex}`;
      const oldEntry = this.profileCacheIndex.get(oldCacheKey);
      if (oldEntry) {
        oldEntry.isOnline = false;
        oldEntry.socketId = null;
      }

      // Update or create entry for new profile
      const newProfileIndex = profileData.profileIndex ?? player.profileIndex;
      player.profileIndex = newProfileIndex;
      const newCacheKey = `${player.uid}:${newProfileIndex}`;
      let newEntry = this.profileCacheIndex.get(newCacheKey);
      if (newEntry) {
        // If faction changed, move between arrays
        if (oldFaction !== player.faction) {
          const oldArr = this.factionProfileCache[oldFaction];
          const idx = oldArr.indexOf(newEntry);
          if (idx !== -1) oldArr.splice(idx, 1);
          this.factionProfileCache[player.faction].push(newEntry);
          newEntry.faction = player.faction;
        }
        newEntry.isOnline = true;
        newEntry.socketId = socketId;
        newEntry.name = player.name;
        newEntry.level = player.level;
        newEntry.totalCrypto = player.totalCrypto;
      } else {
        // New profile not in cache
        newEntry = {
          uid: player.uid,
          profileIndex: newProfileIndex,
          name: player.name,
          faction: player.faction,
          level: player.level || 1,
          totalCrypto: player.totalCrypto || 0,
          territoryCaptured: 0,
          lastPlayedAt: null,
          isOnline: true,
          socketId,
        };
        this.factionProfileCache[player.faction].push(newEntry);
        this.profileCacheIndex.set(newCacheKey, newEntry);
      }
    }

    // Handle faction change implications
    if (oldFaction !== player.faction) {
      // If they were commander, remove them
      if (this.commanders[oldFaction]?.id === socketId) {
        this.bodyguardManager.despawnForFaction(oldFaction);
        this.commanders[oldFaction] = null;
        this.io.to(this.roomId).emit("commander-update", {
          faction: oldFaction,
          commander: null,
          isActing: false,
          trueCommanderName: null,
        });
      }
      this._markRanksDirty();
    }

    console.log(
      `[Room ${this.roomId}] ${player.name} switched profile → ${player.faction} Lv${player.level}`
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

    // Enforce server-side cooldown (2 seconds between shots)
    const now = Date.now();
    if (now - player.lastFireTime < 2000) return;
    player.lastFireTime = now;

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
      this._markRanksDirty();
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

  handleEnterFastTravel(socketId) {
    const player = this.players.get(socketId);
    if (!player || player.isDead || player.waitingForPortal) return;

    // Mark as waiting so _recomputeRanks won't respawn bodyguards
    player.waitingForPortal = true;

    // Kill bodyguards immediately when commander enters fast travel
    for (const faction of FACTIONS) {
      if (this.commanders[faction]?.id === socketId) {
        this.bodyguardManager.killAllForFaction(faction);
        break;
      }
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

    // Spawn bodyguards now that commander is on the surface
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
      this._markRanksDirty();
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
    for (const b of this.billboardOrbits) b.orbitalAngle += b.speed * dt;

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

        // Block if probe enters hollow polar opening
        if (pPhi < POLAR_PHI_LIMIT || pPhi > Math.PI - POLAR_PHI_LIMIT) {
          blocked = true;
          break;
        }

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

    // 6. Recompute faction ranks (every 1 second, or immediately when dirty)
    this.rankRecomputeCounter++;
    if (this.rankRecomputeCounter >= this.tickRate || this._ranksDirty) {
      this.rankRecomputeCounter = 0;
      this._ranksDirty = false;
      this._recomputeRanks();
    }

    // 6b. Broadcast faction rosters (every 10 seconds)
    if (this.tick % (this.tickRate * 10) === 0 && this.profileCacheReady) {
      this._broadcastFactionRosters();
    }

    // 7. Award holding crypto (every 60 seconds)
    this.holdingCryptoCounter++;
    if (this.holdingCryptoCounter >= this.holdingCryptoInterval) {
      this.holdingCryptoCounter = 0;
      this._awardHoldingCrypto();
    }

    // 8. Save authenticated player profiles to Firestore (every 60 seconds)
    this._profileSaveCounter = (this._profileSaveCounter || 0) + 1;
    if (this._profileSaveCounter >= this.tickRate * 60) {
      this._profileSaveCounter = 0;
      for (const [socketId, player] of this.players) {
        if (player.uid) {
          this.savePlayerProfile(socketId).catch((err) =>
            console.warn(`[Room ${this.roomId}] Profile save failed for ${socketId}:`, err.message)
          );
        }
      }
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
            this._markRanksDirty();

            // Respawn after death terminal animation completes (+1s buffer)
            // Animation: 900ms flicker + 2000ms text + 3500ms progress bar
            //          + 200ms complete text + 2400ms hold + 300ms glitch = ~9300ms
            setTimeout(() => this._respawnPlayer(id), 10300);
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
    this._markRanksDirty();

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
      this._markRanksDirty();

      player.killStreak = 0;
      player.deathCount = (player.deathCount || 0) + 1;
      // Respawn after death terminal animation completes (+1s buffer)
      setTimeout(() => this._respawnPlayer(socketId), 10300);
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
    this._markRanksDirty();
  }

  handleCancelResign(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    if (this.resignedPlayers.delete(socketId)) {
      // Player is eligible again — recompute ranks and commander
      this._markRanksDirty();
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
    this._markRanksDirty();

    // Always confirm current commander state to the requester.
    // _recomputeRanks only broadcasts when the commander *changes*; if the
    // player was already commander the client would never get confirmation.
    if (socket) {
      const cmdr = this.commanders[player.faction];
      socket.emit("commander-update", {
        faction: player.faction,
        commander: cmdr ? { id: cmdr.id, name: cmdr.name } : null,
        isActing: cmdr?.isActing || false,
        trueCommanderName: cmdr?.trueCommanderName || null,
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
    // Reuse player state objects across ticks to reduce GC pressure.
    // _playerStateCache: id → reusable state object
    if (!this._playerStateCache) this._playerStateCache = {};
    const playerStates = this._playerStateCache;

    // Remove stale entries for disconnected players
    for (const id in playerStates) {
      if (!this.players.has(id)) delete playerStates[id];
    }

    // Update/create entries for current players
    for (const [id, p] of this.players) {
      let state = playerStates[id];
      if (!state) {
        state = {};
        playerStates[id] = state;
      }
      state.t = p.theta;
      state.p = p.phi;
      state.h = p.heading;
      state.s = p.speed;
      state.ta = p.turretAngle;
      state.hp = p.hp;
      state.d = p.waitingForPortal ? 2 : (p.isDead ? 1 : 0);
      state.seq = p.lastInputSeq;
      state.f = p.faction;
      state.r = p.rank || 0;
      state.rt = this.factionMemberCounts[p.faction] || 0;
    }

    // Reuse payload object
    if (!this._statePayload) this._statePayload = { tick: 0, players: null, bg: null, pr: 0, ma: [], sa: [], ba: [] };
    const statePayload = this._statePayload;
    statePayload.tick = this.tick;
    statePayload.players = playerStates;
    statePayload.bg = this.bodyguardManager.getStatesForBroadcast();
    statePayload.pr = this.planetRotation;

    // Update moon angles in-place
    statePayload.ma.length = this.moons.length;
    for (let i = 0; i < this.moons.length; i++) statePayload.ma[i] = this.moons[i].angle;

    // Update station data in-place
    if (this.tick % 100 === 0) {
      // Full orbital params every ~5s
      statePayload.sa = this.stations.map(s => [s.orbitalAngle, s.localRotation, s.inclination, s.ascendingNode, s.orbitRadius]);
    } else {
      statePayload.sa.length = this.stations.length;
      for (let i = 0; i < this.stations.length; i++) {
        const s = this.stations[i];
        if (!statePayload.sa[i]) statePayload.sa[i] = [0, 0];
        statePayload.sa[i][0] = s.orbitalAngle;
        statePayload.sa[i][1] = s.localRotation;
        statePayload.sa[i].length = 2;
      }
    }

    // Update billboard orbital angles in-place
    if (this.tick % 100 === 0) {
      // Full orbital params every ~5s
      statePayload.ba = this.billboardOrbits.map(b => [b.orbitalAngle, b.inclination, b.ascendingNode, b.orbitRadius]);
    } else {
      statePayload.ba.length = this.billboardOrbits.length;
      for (let i = 0; i < this.billboardOrbits.length; i++) {
        if (!statePayload.ba[i]) statePayload.ba[i] = [0];
        statePayload.ba[i][0] = this.billboardOrbits[i].orbitalAngle;
        statePayload.ba[i].length = 1;
      }
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
    this._markRanksDirty();
  }

  /**
   * Server-authoritative identity update from onboarding screen.
   * Sanitizes name, handles duplicates, updates faction if changed.
   */
  handleSetIdentity(socketId, name, faction) {
    const player = this.players.get(socketId);
    if (!player) return;

    // Sanitize name: trim, limit 20 chars, strip non-alphanumeric (keep spaces, hyphens, underscores)
    let sanitized = name.trim().replace(/[^\w\s\-]/g, "").substring(0, 20);
    if (!sanitized) sanitized = this._pickName();

    // Check for duplicate names — append suffix if taken
    for (const [id, p] of this.players) {
      if (id !== socketId && p.name === sanitized) {
        sanitized = sanitized + "_" + Math.floor(Math.random() * 99);
        break;
      }
    }

    const oldFaction = player.faction;
    player.name = sanitized;
    player.faction = faction;

    // Broadcast identity update to all clients
    this.io.to(this.roomId).emit("player-identity-updated", {
      id: socketId,
      name: sanitized,
      faction: faction,
    });

    // Recompute ranks if faction changed
    if (oldFaction !== faction) {
      if (this.commanders[oldFaction]?.id === socketId) {
        this.bodyguardManager.despawnForFaction(oldFaction);
        this.commanders[oldFaction] = null;
      }
      this._markRanksDirty();
    }
  }

  /**
   * Mark ranks as needing recomputation. Actual work deferred to next tick.
   * This avoids redundant recomputations when multiple events fire in the same frame.
   */
  _markRanksDirty() {
    this._ranksDirty = true;
  }

  /**
   * Recompute faction ranks for all factions and update commanders.
   * When profileCacheReady, ranks include ALL profiles (online + offline).
   * Falls back to connected-only ranking if Firestore cache isn't loaded.
   * Sorted by: level DESC → totalCrypto DESC → territoryCaptured DESC.
   * Commander = rank #1 overall. If offline, highest-ranked online player
   * becomes Acting Commander with full privileges.
   */
  _recomputeRanks() {
    const now = Date.now();
    for (const faction of FACTIONS) {
      const allMembers = [];

      if (this.profileCacheReady) {
        // ---- All-profile ranking (online + offline from Firestore cache) ----
        // First, update cache entries for connected players with live stats
        for (const [id, p] of this.players) {
          if (p.faction !== faction || !p.uid) continue;
          const cacheKey = `${p.uid}:${p.profileIndex}`;
          const entry = this.profileCacheIndex.get(cacheKey);
          if (entry) {
            entry.level = p.level || 1;
            entry.totalCrypto = p.totalCrypto || 0;
            entry.territoryCaptured = p.territoryCaptured || entry.territoryCaptured;
          }
        }

        for (const entry of this.factionProfileCache[faction]) {
          // Exclude resigned players (only applies to online players)
          if (entry.socketId) {
            const resignedUntil = this.resignedPlayers.get(entry.socketId);
            if (resignedUntil) {
              if (now < resignedUntil) continue;
              this.resignedPlayers.delete(entry.socketId);
            }
          }
          allMembers.push(entry);
        }
      } else {
        // ---- Fallback: connected players only (original behavior) ----
        for (const [id, p] of this.players) {
          if (p.faction !== faction) continue;
          const resignedUntil = this.resignedPlayers.get(id);
          if (resignedUntil) {
            if (now < resignedUntil) continue;
            this.resignedPlayers.delete(id);
          }
          allMembers.push({
            uid: p.uid,
            socketId: id,
            name: p.name,
            level: p.level || 1,
            totalCrypto: p.totalCrypto || 0,
            territoryCaptured: p.territoryCaptured || 0,
            isOnline: true,
          });
        }
      }

      // Sort: level DESC → totalCrypto DESC → territoryCaptured DESC
      allMembers.sort((a, b) => {
        const aLevel = a.level || 1, bLevel = b.level || 1;
        if (bLevel !== aLevel) return bLevel - aLevel;
        const aCrypto = a.totalCrypto || 0, bCrypto = b.totalCrypto || 0;
        if (bCrypto !== aCrypto) return bCrypto - aCrypto;
        return (b.territoryCaptured || 0) - (a.territoryCaptured || 0);
      });

      // Assign ranks (1-based)
      for (let i = 0; i < allMembers.length; i++) {
        allMembers[i].rank = i + 1;
        // Update connected player's rank field
        if (allMembers[i].socketId) {
          const player = this.players.get(allMembers[i].socketId);
          if (player) player.rank = i + 1;
        }
      }

      this.factionMemberCounts[faction] = allMembers.length;
      this._factionRosters[faction] = allMembers;

      // ---- Commander / Acting Commander ----
      // Check for active override (dev testing — locks for 60s)
      const override = this.commanderOverrides.get(faction);
      let overrideEntry = null;
      if (override) {
        if (now < override.until) {
          overrideEntry = allMembers.find(m => m.socketId === override.id) || null;
        } else {
          this.commanderOverrides.delete(faction);
        }
      }

      // True Commander = rank #1 overall (override or top-ranked)
      const trueCommander = overrideEntry || allMembers[0] || null;

      // Determine active commander (who actually gets perks right now)
      let activeCommander = null;
      let isActing = false;

      if (!trueCommander) {
        activeCommander = null;
      } else if (trueCommander.isOnline && trueCommander.socketId) {
        // True commander is online — they are the active commander
        activeCommander = trueCommander;
        isActing = false;
      } else {
        // True commander is offline — highest-ranked online player is Acting Commander
        isActing = true;
        activeCommander = allMembers.find(m => m.isOnline && m.socketId) || null;
      }

      const current = this.commanders[faction];
      const newId = activeCommander?.socketId || null;
      const newName = activeCommander?.name || null;

      if (!activeCommander) {
        // No online commander
        if (current) {
          this.bodyguardManager.despawnForFaction(faction);
          this.commanders[faction] = null;
          this.io.to(this.roomId).emit("commander-update", {
            faction,
            commander: null,
            isActing: false,
            trueCommanderName: trueCommander?.name || null,
          });
        }
      } else if (!current || current.id !== newId) {
        // Commander changed
        // True commander returned, replacing acting commander
        if (current && current.isActing && !isActing) {
          this.tuskChat?.onCommanderReturns?.(newName, current.name);
        }
        this.bodyguardManager.killAllForFaction(faction);
        this.commanders[faction] = {
          id: newId, name: newName, isActing,
          trueCommanderName: isActing ? (trueCommander?.name || null) : null,
        };

        // Only spawn bodyguards if new commander is on the planet surface
        const player = this.players.get(newId);
        if (player && !player.isDead && !player.waitingForPortal) {
          this.bodyguardManager.scheduleRespawn(faction, newId, 4);
        }

        this.io.to(this.roomId).emit("commander-update", {
          faction,
          commander: { id: newId, name: newName },
          isActing,
          trueCommanderName: isActing ? (trueCommander?.name || null) : null,
        });
      } else if (current.isActing !== isActing) {
        // Same person but acting status changed (e.g., true commander came online
        // and IS this person, or true commander went offline)
        // True commander returned (acting status removed)
        if (current.isActing && !isActing) {
          this.tuskChat?.onCommanderReturns?.(current.name, current.name);
        }
        current.isActing = isActing;
        this.io.to(this.roomId).emit("commander-update", {
          faction,
          commander: { id: current.id, name: current.name },
          isActing,
          trueCommanderName: isActing ? (trueCommander?.name || null) : null,
        });
      } else {
        // Same commander, same acting status — handle bodyguard respawn
        const player = this.players.get(newId);
        if (player && !player.isDead && !player.waitingForPortal) {
          if (!this.bodyguardManager.hasPendingRespawn(faction)) {
            const hasDead = this.bodyguardManager.hasDeadBodyguards(faction);
            const hasBg = this.bodyguardManager.hasBodyguards(faction);
            if (hasDead || !hasBg) {
              this.bodyguardManager.killAllForFaction(faction);
              this.bodyguardManager.scheduleRespawn(faction, newId, 4);
            }
          }
        }
      }
    }
  }

  /**
   * Build a snapshot of current commanders for the welcome packet.
   * Includes isActing and trueCommanderName for Acting Commander support.
   */
  _getCommanderSnapshot() {
    const snapshot = {};
    for (const faction of FACTIONS) {
      const cmdr = this.commanders[faction];
      snapshot[faction] = cmdr
        ? {
            id: cmdr.id,
            name: cmdr.name,
            isActing: cmdr.isActing || false,
            trueCommanderName: cmdr.isActing ? (cmdr.trueCommanderName || null) : null,
          }
        : null;
    }
    return snapshot;
  }

  /**
   * Broadcast faction roster to each connected player (their own faction only).
   * Sends top 50 + the player's own entry if outside top 50.
   */
  _broadcastFactionRosters() {
    for (const [socketId, player] of this.players) {
      const roster = this._factionRosters[player.faction];
      if (!roster) continue;

      const socket = this.io.sockets.sockets.get(socketId);
      if (!socket) continue;

      const condensed = [];
      let playerFound = false;

      for (let i = 0; i < Math.min(roster.length, 50); i++) {
        const m = roster[i];
        condensed.push({
          rank: m.rank,
          name: m.name,
          level: m.level || 1,
          online: m.isOnline,
          isSelf: m.socketId === socketId,
        });
        if (m.socketId === socketId) playerFound = true;
      }

      // If player is outside top 50, append their entry
      if (!playerFound) {
        const selfEntry = roster.find(m => m.socketId === socketId);
        if (selfEntry) {
          condensed.push({
            rank: selfEntry.rank,
            name: selfEntry.name,
            level: selfEntry.level || 1,
            online: true,
            isSelf: true,
          });
        }
      }

      socket.emit("faction-roster", {
        faction: player.faction,
        total: roster.length,
        members: condensed,
      });
    }
  }

  // ========================
  // COMMANDER PING / DRAWING RELAY
  // ========================

  /**
   * Relay a commander ping to all other players in the room.
   * Server validates that the sender is actually the commander of their faction.
   */
  handleCommanderPing(socketId, data) {
    const player = this.players.get(socketId);
    if (!player) return;

    // Validate this player is actually the commander of their faction
    const commander = this.commanders[player.faction];
    if (!commander || commander.id !== socketId) return;

    // Validate data (local-space normal vector)
    if (typeof data.x !== "number" || typeof data.y !== "number" || typeof data.z !== "number") return;
    if (!isFinite(data.x) || !isFinite(data.y) || !isFinite(data.z)) return;

    // Broadcast to all others in room (volatile — skip if client buffer full)
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.to(this.roomId).volatile.emit("commander-ping", {
        id: socketId,
        faction: player.faction,
        x: data.x,
        y: data.y,
        z: data.z,
      });
    }
  }

  /**
   * Relay a commander drawing to all other players in the room.
   * Server validates that the sender is actually the commander of their faction.
   */
  handleCommanderDrawing(socketId, data) {
    const player = this.players.get(socketId);
    if (!player) return;

    // Validate this player is actually the commander of their faction
    const commander = this.commanders[player.faction];
    if (!commander || commander.id !== socketId) return;

    // Validate data: array of point arrays
    if (!Array.isArray(data.points) || data.points.length < 2) return;
    if (data.points.length > 500) return; // Hard limit matching client maxPointsPerStroke

    const isDone = !!data.done;

    // Preview updates are volatile (droppable), final strokes are reliable
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      const payload = {
        id: socketId,
        faction: player.faction,
        points: data.points,
        done: isDone,
      };
      if (isDone) {
        socket.to(this.roomId).emit("commander-drawing", payload);
      } else {
        socket.to(this.roomId).volatile.emit("commander-drawing", payload);
      }
    }
  }

  // ========================
  // HELPERS
  // ========================

  /**
   * Get a Set of lowercased sponsor names that are currently paused.
   * Used by moon/billboard payload builders to hide paused sponsors.
   */
  _getPausedSponsorNames() {
    const names = new Set();
    if (!this.sponsorStore) return names;
    for (const s of this.sponsorStore.getAll()) {
      if (s.paused && s.name) names.add(s.name.toLowerCase());
    }
    return names;
  }

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

    // Serialize sponsor data for clients (with image URLs instead of base64)
    // Append updatedAt as cache-busting query param so browsers and texture
    // caches serve fresh images after admin edits.
    const sponsors = this.sponsors.map(s => {
      const urls = this.sponsorImageUrls[s.id] || {};
      const cacheBust = s.updatedAt ? `?v=${encodeURIComponent(s.updatedAt)}` : '';
      return {
        id: s.id,
        name: s.name,
        tagline: s.tagline,
        websiteUrl: s.websiteUrl,
        patternImage: urls.patternUrl ? urls.patternUrl + cacheBust : null,
        logoImage: urls.logoUrl ? urls.logoUrl + cacheBust : null,
        patternAdjustment: s.patternAdjustment,
        cluster: { tileIndices: s.cluster.tileIndices },
        rewards: s.rewards,
        active: s.active,
        createdAt: s.createdAt,
        clusterId: this.sponsorClusterMap.get(s.id),
      };
    });

    return {
      clusters,
      tileClusterMap: tileClusterArr,
      tileElevation: tileElevationArr,
      clusterVisuals,
      portalCenterIndices: Array.from(worldResult.portalCenterIndices),
      portalTileIndices: Array.from(worldResult.portalTileIndices),
      polarTileIndices: Array.from(worldResult.polarTileIndices),
      sponsors,
      moonSponsors: this._buildMoonSponsorPayload(),
      billboardSponsors: this._buildBillboardSponsorPayload(),
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
