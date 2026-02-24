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
const BotWorkerBridge = require("./BotWorkerBridge");
const DEBUG_LOG = process.env.DEBUG_LOG === "1";

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

// Grace period for reconnecting players (ms)
const RECONNECT_GRACE_MS = 30000;

// Kick players after 60 seconds of no meaningful input
const INACTIVITY_TIMEOUT_MS = 60000;

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

    // Reconnect grace: uid → { player, disconnectedAt, cleanupTimer }
    this.disconnectedSessions = new Map();

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

    // Tick loop: 10 ticks/second
    this.tickRate = 10;
    this.tickDelta = 1 / this.tickRate;
    this.tickInterval = null;
    this.lastTickTime = Date.now();

    // Sequence number for state snapshots (clients use for reconciliation)
    this.tick = 0;

    // Territory tics, crypto awards, and capture-progress all fire once per second.
    // Counter increments at half tick rate (capture runs every other tick);
    // threshold is tickRate/2 to maintain 1-second cadence.
    this.captureSecondCounter = 0;

    // Award holding crypto at the top of each wall-clock minute
    this._lastHoldingMinute = Math.floor(Date.now() / 60000);

    // Throttle rank recomputation to once per second (or when dirty flag is set)
    this.rankRecomputeCounter = 0;
    this._ranksDirty = false;

    // Economy: action costs (in ¢)
    this.costs = {
      fastTravel: 500,
      respawn: 150,
      cannonBase: 5,
      cannonPerCharge: 1,
      slotUnlock: {
        'defense-1': 15000,
        'tactical-1': 30000,
        'offense-2': 60000,
        'defense-2': 120000,
        'tactical-2': 200000,
      },
      slotLevels: {
        'defense-1': 3,
        'tactical-1': 5,
        'offense-2': 8,
        'defense-2': 12,
        'tactical-2': 15,
      },
    };

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

    // Build O(1) terrain blocked grid for fast collision checks
    this.worldGen.buildBlockedGrid(this.terrain);

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

    DEBUG_LOG && console.log(`[Room ${roomId}] ${this.portalPositions.length} portals computed from world gen`);

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
      // Rebuild blocked grid now that sponsor tiles have been de-elevated
      this.worldGen.buildBlockedGrid(this.terrain);
      DEBUG_LOG && console.log(`[Room ${roomId}] Applied ${this.sponsors.length} sponsor clusters`);
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
    this.tuskChat = new TuskGlobalChat(io, roomId, this);

    // Server-authoritative commander state: one commander per faction
    this.commanders = { rust: null, cobalt: null, viridian: null };

    // Commander overrides: faction → { id, until } (dev testing — locks commander for 60s)
    this.commanderOverrides = new Map();

    // Server-authoritative bodyguards (2 per commander, synced to all clients)
    this.bodyguardManager = new BodyguardManager(480, this.terrain, this.worldGen);

    // Server-authoritative bots on worker thread (population fills to 300, despawn as humans join)
    this.botBridge = new BotWorkerBridge(480, 22, 42, 73, this.players.size);

    // ---- All-profile faction ranking cache ----
    // Stores ALL profiles from Firestore (online + offline) for true faction ranking.
    // Updated live as connected players' stats change.
    this.factionProfileCache = { rust: [], cobalt: [], viridian: [] };
    this.profileCacheIndex = new Map();  // "uid:profileIndex" → cache entry reference
    this.profileCacheReady = false;
    this.factionMemberCounts = { rust: 0, cobalt: 0, viridian: 0 };
    this._factionRosters = {};           // faction → sorted member array (set by _recomputeRanks)
  }

  async start() {
    // Restore faction capture state from Firestore BEFORE accepting connections
    // (must complete before tick loop or welcome messages reference this data)
    if (process.env.RESET_TERRITORIES === "true") {
      DEBUG_LOG && console.log(`[Room ${this.roomId}] RESET_TERRITORIES=true — starting with fresh territory state`);
    } else {
      await this.loadCaptureState();
    }

    // Bot worker initializes itself from seeds (no init call needed)

    this._tickRunning = true;
    this._nextTickTime = Date.now();
    this._scheduleTick();
    DEBUG_LOG && console.log(`[Room ${this.roomId}] Started at ${this.tickRate} ticks/sec`);

    // Load all Firestore profiles into cache (async, non-blocking)
    this._loadAllProfiles();

    // Periodic auto-save: persist all active players every 60 seconds
    this._autoSaveInterval = setInterval(() => this._autoSaveAllPlayers(), 60000);

    // Periodic capture state save: persist faction ownership every 60 seconds
    this._captureSaveInterval = setInterval(() => {
      this.saveCaptureState().catch(err => {
        console.warn(`[Room ${this.roomId}] Capture state auto-save error:`, err.message);
      });
    }, 60000);
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
          avatarColor: data.profilePicture || null,
          isOnline: false,
          socketId: null,
        };

        if (!this.profileCacheIndex.has(cacheKey)) {
          this.factionProfileCache[data.faction].push(entry);
          this.profileCacheIndex.set(cacheKey, entry);
        } else {
          // Update existing entry instead of creating a duplicate
          const existing = this.profileCacheIndex.get(cacheKey);
          existing.name = entry.name;
          existing.level = entry.level;
          existing.totalCrypto = entry.totalCrypto;
          existing.territoryCaptured = entry.territoryCaptured;
          existing.lastPlayedAt = entry.lastPlayedAt;
          existing.avatarColor = entry.avatarColor;
        }
      }

      this.profileCacheReady = true;

      // Reconcile: players who connected before the cache was ready
      // need their cache entries linked to their live sockets
      for (const [socketId, player] of this.players) {
        if (!player.uid) continue;
        const cacheKey = `${player.uid}:${player.profileIndex}`;
        let entry = this.profileCacheIndex.get(cacheKey);
        if (entry) {
          entry.isOnline = true;
          entry.socketId = socketId;
          entry.name = player.name;
          entry.level = player.level || 1;
          entry.totalCrypto = player.totalCrypto || 0;
          entry.territoryCaptured = player.territoryCaptured || 0;
          entry.avatarColor = player.avatarColor || entry.avatarColor;
          if (entry.faction !== player.faction) {
            const oldArr = this.factionProfileCache[entry.faction];
            const idx = oldArr.indexOf(entry);
            if (idx !== -1) oldArr.splice(idx, 1);
            const newArr = this.factionProfileCache[player.faction];
            if (newArr.indexOf(entry) === -1) newArr.push(entry);
            entry.faction = player.faction;
          }
        } else {
          entry = {
            uid: player.uid,
            profileIndex: player.profileIndex,
            name: player.name,
            faction: player.faction,
            level: player.level || 1,
            totalCrypto: player.totalCrypto || 0,
            territoryCaptured: player.territoryCaptured || 0,
            lastPlayedAt: null,
            avatarColor: player.avatarColor || null,
            isOnline: true,
            socketId: socketId,
          };
          this.factionProfileCache[player.faction].push(entry);
          this.profileCacheIndex.set(cacheKey, entry);
        }
      }

      this._markRanksDirty();
      DEBUG_LOG && console.log(`[Room ${this.roomId}] Loaded ${snapshot.size} profiles from Firestore`);
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
    if (this._autoSaveInterval) {
      clearInterval(this._autoSaveInterval);
      this._autoSaveInterval = null;
    }
    if (this._captureSaveInterval) {
      clearInterval(this._captureSaveInterval);
      this._captureSaveInterval = null;
    }
    if (this.tuskChat && typeof this.tuskChat.destroy === "function") {
      this.tuskChat.destroy();
    }
    DEBUG_LOG && console.log(`[Room ${this.roomId}] Stopped`);
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

    // 2. Snapshot old sponsor state so we can restore unchanged sponsors
    const oldSponsorClusterIds = new Set(this.clusterSponsorMap.keys());
    const oldSponsorClusterMap = new Map(this.sponsorClusterMap);   // sponsorId → clusterId
    const oldCaptureSnapshots = new Map();
    for (const [sponsorId, clusterId] of oldSponsorClusterMap) {
      const capture = this.clusterCaptureState.get(clusterId);
      const timer = this.sponsorHoldTimers.get(sponsorId);
      if (capture) {
        oldCaptureSnapshots.set(sponsorId, {
          clusterId,
          tics: { ...capture.tics },
          owner: capture.owner,
          timer: timer ? { ...timer } : null,
        });
      }
    }

    this.sponsorClusterMap.clear();
    this.clusterSponsorMap.clear();
    this.sponsorHoldTimers.clear();

    // 3. Re-read and re-apply sponsors (exclude paused)
    this.sponsors = this.sponsorStore.getAll().filter(s => s.active !== false && !s.paused);
    this._applySponsorClusters(wr);
    // Rebuild blocked grid now that sponsor tiles have been de-elevated
    this.worldGen.buildBlockedGrid(this.terrain);

    // 4. Rebuild world payload
    this._worldPayload = this._buildWorldPayload(wr);

    // 5. Update capture state: remove stale sponsor clusters, add new ones,
    //    and restore capture progress for sponsors whose cluster didn't change
    for (const oldId of oldSponsorClusterIds) {
      if (!this.clusterSponsorMap.has(oldId)) {
        this.clusterCaptureState.delete(oldId);
      }
    }
    for (const [sponsorId, clusterId] of this.sponsorClusterMap) {
      const old = oldCaptureSnapshots.get(sponsorId);
      if (old && old.clusterId === clusterId) {
        // Same cluster assignment — restore capture progress
        const state = this.clusterCaptureState.get(clusterId);
        if (state) {
          state.tics.rust = old.tics.rust;
          state.tics.cobalt = old.tics.cobalt;
          state.tics.viridian = old.tics.viridian;
          state.owner = old.owner;
        }
        if (old.timer) {
          this.sponsorHoldTimers.set(sponsorId, { ...old.timer });
        }
      } else if (!this.clusterCaptureState.has(clusterId)) {
        // New or reassigned sponsor — fresh capture state
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

    // 6. Build capture state snapshot so clients can restore ownership after reload
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

    // 7. Broadcast full reload to all connected clients
    this.io.to(this.roomId).emit("sponsors-reloaded", {
      world: this._worldPayload,
      captureState,
    });

    DEBUG_LOG && console.log(`[Room ${this.roomId}] Sponsors reloaded: ${this.sponsors.length} active, broadcast to clients`);
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
      return {
        moonIndex: i,
        name: sponsor.name,
        tagline: sponsor.tagline,
        websiteUrl: sponsor.websiteUrl,
        patternImage: urls.patternUrl || null,
        patternAdjustment: sponsor.patternAdjustment,
        createdAt: sponsor.createdAt,
        logoImage: urls.logoUrl || null,
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
    // Update cached world payload so new clients get fresh data on connect
    if (this._worldPayload) this._worldPayload.moonSponsors = moonSponsors;
    this.io.to(this.roomId).emit("moon-sponsors-reloaded", { moonSponsors });
    const active = moonSponsors.filter(Boolean).length;
    DEBUG_LOG && console.log(`[Room ${this.roomId}] Moon sponsors reloaded: ${active} active, broadcast to clients`);
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
      return {
        billboardIndex: i,
        name: sponsor.name,
        tagline: sponsor.tagline,
        websiteUrl: sponsor.websiteUrl,
        patternImage: urls.patternUrl || null,
        patternAdjustment: sponsor.patternAdjustment,
        createdAt: sponsor.createdAt,
        logoImage: urls.logoUrl || null,
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
    // Update cached world payload so new clients get fresh data on connect
    if (this._worldPayload) this._worldPayload.billboardSponsors = billboardSponsors;
    this.io.to(this.roomId).emit("billboard-sponsors-reloaded", { billboardSponsors });
    const active = billboardSponsors.filter(Boolean).length;
    DEBUG_LOG && console.log(`[Room ${this.roomId}] Billboard sponsors reloaded: ${active} active, broadcast to clients`);
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

    const isGuest = socket.isGuest === true;
    const baseName = profileData?.name || this._pickName();

    const player = {
      id: socket.id,
      uid: socket.uid || null,               // Firebase UID (null for guests)
      profileIndex: socket.profileIndex || 0, // Active profile slot (0-2)
      isAuthenticated: !!socket.uid,
      isGuest: isGuest,

      name: baseName,
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
      _portalReason: 'deploy', // 'deploy' | 'fastTravel' | 'respawn'

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
      avatarColor: profileData?.profilePicture || null,
      loadout: profileData?.loadout || {},
      unlockedSlots: profileData?.unlockedSlots || ['offense-1'],
      tankUpgrades: profileData?.tankUpgrades || { armor: 0, speed: 0, fireRate: 0, damage: 0 },

      // Inactivity tracking (timestamp of last meaningful action)
      lastActivityAt: Date.now(),

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
        // If faction changed since cache was built, move entry to correct array
        if (entry.faction !== player.faction) {
          const oldArr = this.factionProfileCache[entry.faction];
          const idx = oldArr.indexOf(entry);
          if (idx !== -1) oldArr.splice(idx, 1);
          const newArr = this.factionProfileCache[player.faction];
          if (newArr.indexOf(entry) === -1) newArr.push(entry);
          entry.faction = player.faction;
        }
        entry.isOnline = true;
        entry.socketId = socket.id;
        entry.name = player.name;
        entry.level = player.level || 1;
        entry.totalCrypto = player.totalCrypto || 0;
        entry.territoryCaptured = player.territoryCaptured || 0;
        entry.avatarColor = player.avatarColor || entry.avatarColor;
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
          avatarColor: player.avatarColor || null,
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
      avatarColor: player.avatarColor || null,
    });

    // Despawn a bot to maintain population balance
    this.botBridge.onHumanJoin(player);

    // Recompute ranks and commander for all factions
    this._recomputeRanks();

    // Send roster immediately so the player doesn't wait for the next 10s broadcast
    this._sendRosterToPlayer(socket.id);

    DEBUG_LOG && console.log(
      `[Room ${this.roomId}] ${player.name} (${player.faction}) joined. ` +
      `Players: ${this.players.size}, Bots: ${this.botBridge.botCount}`
    );

    return player;
  }

  /**
   * Attempt to restore a recently-disconnected authenticated player.
   * Returns the restored player object, or null if no session found.
   */
  reconnectPlayer(socket) {
    const uid = socket.uid;
    if (!uid) return null;

    const session = this.disconnectedSessions.get(uid);
    if (!session) return null;

    // Clean up the grace period
    clearTimeout(session.cleanupTimer);
    this.disconnectedSessions.delete(uid);

    const saved = session.player;
    const oldId = saved.id;

    // Re-key to new socket ID
    saved.id = socket.id;

    // Reset volatile input state
    saved.keys = { w: false, a: false, s: false, d: false, shift: false };
    saved.lastInputSeq = 0;
    saved.speed = 0;
    saved.lastActivityAt = Date.now();

    // If player was dead at disconnect, send them to portal selection
    if (saved.isDead) {
      saved.hp = saved.maxHp;
      saved.isDead = false;
      saved.speed = 0;
      saved.waitingForPortal = true;
      saved._portalReason = 'respawn';
    }

    // Insert into players map under new socket ID
    this.players.set(socket.id, saved);
    socket.join(this.roomId);

    // --- Update all references from oldId to new socket ID ---

    // Profile cache
    if (saved.uid && this.profileCacheReady) {
      const cacheKey = `${saved.uid}:${saved.profileIndex}`;
      const entry = this.profileCacheIndex.get(cacheKey);
      if (entry) {
        entry.isOnline = true;
        entry.socketId = socket.id;
        entry.name = saved.name;
        entry.level = saved.level || 1;
        entry.totalCrypto = saved.totalCrypto || 0;
        entry.territoryCaptured = saved.territoryCaptured || entry.territoryCaptured;
      }
    }

    // Commander references
    for (const faction of FACTIONS) {
      const cmdr = this.commanders[faction];
      if (cmdr && cmdr.id === oldId) {
        cmdr.id = socket.id;
      }
    }

    // Resigned players
    if (this.resignedPlayers.has(oldId)) {
      const until = this.resignedPlayers.get(oldId);
      this.resignedPlayers.delete(oldId);
      this.resignedPlayers.set(socket.id, until);
    }

    // In-flight projectiles
    for (const proj of this.projectiles) {
      if (proj.ownerId === oldId) {
        proj.ownerId = socket.id;
      }
    }

    // lastKilledBy references on other players
    for (const [, p] of this.players) {
      if (p.lastKilledBy === oldId) {
        p.lastKilledBy = socket.id;
      }
    }

    // --- Send welcome payload (same structure as addPlayer) ---
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

    socket.emit("welcome", {
      you: {
        id: saved.id,
        name: saved.name,
        faction: saved.faction,
        waitingForPortal: saved.waitingForPortal,
        factionTotal: this.factionMemberCounts[saved.faction] || 0,
        // Reconnection-specific: restore position/state
        reconnected: true,
        theta: saved.theta,
        phi: saved.phi,
        heading: saved.heading,
        hp: saved.hp,
        isDead: saved.isDead,
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

    // Notify other players
    if (!saved.waitingForPortal) {
      // Player was alive on the surface — spawn their tank for others
      socket.to(this.roomId).emit("player-activated", {
        id: saved.id,
        name: saved.name,
        faction: saved.faction,
        theta: saved.theta,
        phi: saved.phi,
        heading: saved.heading,
        hp: saved.hp,
        level: saved.level,
        badges: saved.badges,
        totalCrypto: saved.totalCrypto,
        title: saved.title,
        crypto: saved.crypto,
        avatarColor: saved.avatarColor || null,
      });
    } else {
      // Player is waiting for portal (was dead or in portal selection)
      socket.to(this.roomId).emit("player-joined", {
        id: saved.id,
        name: saved.name,
        faction: saved.faction,
        hp: saved.hp,
        level: saved.level,
        waitingForPortal: true,
        badges: saved.badges,
        totalCrypto: saved.totalCrypto,
        title: saved.title,
        crypto: saved.crypto,
        rank: saved.rank || 0,
        avatarColor: saved.avatarColor || null,
      });
    }

    this._recomputeRanks();
    this._sendRosterToPlayer(socket.id);

    DEBUG_LOG && console.log(
      `[Room ${this.roomId}] ${saved.name} (${saved.faction}) reconnected ` +
      `after ${((Date.now() - session.disconnectedAt) / 1000).toFixed(1)}s. ` +
      `Players: ${this.players.size}`
    );

    return saved;
  }

  /**
   * Link a player to the faction profile cache after late authentication.
   * Called when a guest player sends refresh-token and becomes authenticated.
   */
  linkPlayerToProfileCache(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid || !this.profileCacheReady) return;

    const cacheKey = `${player.uid}:${player.profileIndex}`;
    let entry = this.profileCacheIndex.get(cacheKey);
    if (entry) {
      // If faction changed since cache was built, move entry to correct array
      if (entry.faction !== player.faction) {
        const oldArr = this.factionProfileCache[entry.faction];
        const idx = oldArr.indexOf(entry);
        if (idx !== -1) oldArr.splice(idx, 1);
        const newArr = this.factionProfileCache[player.faction];
        if (newArr.indexOf(entry) === -1) newArr.push(entry);
        entry.faction = player.faction;
      }
      entry.isOnline = true;
      entry.socketId = socketId;
      entry.name = player.name;
      entry.level = player.level || 1;
      entry.totalCrypto = player.totalCrypto || 0;
      entry.territoryCaptured = player.territoryCaptured || 0;
      entry.avatarColor = player.avatarColor || entry.avatarColor;
    } else {
      // Player not yet in cache — add them
      entry = {
        uid: player.uid,
        profileIndex: player.profileIndex,
        name: player.name,
        faction: player.faction,
        level: player.level || 1,
        totalCrypto: player.totalCrypto || 0,
        territoryCaptured: player.territoryCaptured || 0,
        lastPlayedAt: null,
        avatarColor: player.avatarColor || null,
        isOnline: true,
        socketId: socketId,
      };
      this.factionProfileCache[player.faction].push(entry);
      this.profileCacheIndex.set(cacheKey, entry);
    }

    this._markRanksDirty();
  }

  /**
   * Mark a player's profile cache entry as offline (e.g. when they sign out mid-session).
   * Called before the player's uid is cleared so we can look up the correct cache key.
   */
  unlinkPlayerFromProfileCache(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid || !this.profileCacheReady) return;

    const cacheKey = `${player.uid}:${player.profileIndex}`;
    const entry = this.profileCacheIndex.get(cacheKey);
    if (entry) {
      entry.isOnline = false;
      entry.socketId = null;
      entry.level = player.level || entry.level;
      entry.totalCrypto = player.totalCrypto || entry.totalCrypto;
      entry.territoryCaptured = player.territoryCaptured || entry.territoryCaptured;
      entry.avatarColor = player.avatarColor || entry.avatarColor;
    }

    this._markRanksDirty();
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
        entry.avatarColor = player.avatarColor || entry.avatarColor;
      }
    }

    this.players.delete(socketId);
    this.resignedPlayers.delete(socketId);
    if (this._playerBotSets) this._playerBotSets.delete(socketId);

    // Stash session for authenticated players to allow seamless reconnect
    if (player.uid) {
      const existing = this.disconnectedSessions.get(player.uid);
      if (existing && existing.cleanupTimer) clearTimeout(existing.cleanupTimer);

      const uid = player.uid;
      const cleanupTimer = setTimeout(() => {
        this.disconnectedSessions.delete(uid);
        DEBUG_LOG && console.log(`[Room ${this.roomId}] Reconnect grace expired for ${player.name} (${uid})`);
      }, RECONNECT_GRACE_MS);

      this.disconnectedSessions.set(player.uid, {
        player: { ...player },
        disconnectedAt: Date.now(),
        cleanupTimer,
      });
    }

    // Recompute ranks and commander (player now offline — may trigger Acting Commander)
    this._markRanksDirty();

    // Tell everyone the player left
    this.io.to(this.roomId).emit("player-left", { id: socketId });

    // Spawn a bot to maintain population balance
    this.botBridge.onHumanLeave(this.players.size);

    DEBUG_LOG && console.log(
      `[Room ${this.roomId}] ${player.name} left. Players: ${this.players.size}, Bots: ${this.botBridge.botCount}`
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
        totalCrypto: player.crypto, // Live balance (crypto = totalCrypto + session earnings - spending)
        unlockedSlots: player.unlockedSlots || ['offense-1'],
        loadout: player.loadout || {},
        tankUpgrades: player.tankUpgrades || { armor: 0, speed: 0, fireRate: 0, damage: 0 },
      };

      // Keep totalCrypto in sync with live balance for next save
      player.totalCrypto = player.crypto;

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

      // Also update denormalized level on account profiles array.
      // MUST read-modify-write the full array; dot-notation (profiles.0.level)
      // converts the Firestore array into a map, corrupting profile data.
      const accountRef = db.collection("accounts").doc(player.uid);
      await db.runTransaction(async (t) => {
        const accountDoc = await t.get(accountRef);
        if (!accountDoc.exists) return;
        const profiles = accountDoc.data().profiles;
        if (Array.isArray(profiles) && profiles[player.profileIndex]) {
          profiles[player.profileIndex].level = player.level;
          t.update(accountRef, { profiles });
        }
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
   * Save all authenticated players' profiles to Firestore.
   * Used for periodic auto-save and graceful shutdown.
   * @returns {Promise<void>}
   */
  async saveAllPlayers() {
    const saves = [];
    for (const [socketId, player] of this.players) {
      if (player.uid) {
        saves.push(this.savePlayerProfile(socketId));
      }
    }
    await Promise.allSettled(saves);
  }

  /**
   * Save faction capture state to Firestore.
   * Used for periodic auto-save and graceful shutdown.
   * @returns {Promise<void>}
   */
  async saveCaptureState() {
    try {
      const { getFirestore } = require("./firebaseAdmin");
      const db = getFirestore();
      const clusters = {};
      for (const [clusterId, state] of this.clusterCaptureState) {
        const total = state.tics.rust + state.tics.cobalt + state.tics.viridian;
        if (total > 0 || state.owner) {
          clusters[clusterId] = {
            tics: { ...state.tics },
            owner: state.owner,
          };
        }
      }
      // Sponsor hold timers: sponsorId → { owner, capturedAt, holdDuration }
      const sponsorTimers = {};
      for (const [sponsorId, timer] of this.sponsorHoldTimers) {
        if (timer.owner) {
          sponsorTimers[sponsorId] = {
            owner: timer.owner,
            capturedAt: timer.capturedAt || null,
            holdDuration: timer.holdDuration || 0,
          };
        }
      }

      await db.collection("gameState").doc("captureState").set({
        roomId: this.roomId,
        savedAt: require("firebase-admin").firestore.FieldValue.serverTimestamp(),
        clusters,
        sponsorTimers,
      });
      const count = Object.keys(clusters).length;
      if (count > 0) {
        DEBUG_LOG && console.log(`[Room ${this.roomId}] Saved capture state (${count} active clusters)`);
      }
    } catch (err) {
      console.warn(`[Room ${this.roomId}] Failed to save capture state:`, err.message);
    }
  }

  /**
   * Load faction capture state from Firestore and apply to current cluster map.
   * @returns {Promise<boolean>} true if state was loaded
   */
  async loadCaptureState() {
    try {
      const { getFirestore } = require("./firebaseAdmin");
      const db = getFirestore();
      const doc = await db.collection("gameState").doc("captureState").get();
      if (!doc.exists) return false;
      const data = doc.data();
      if (!data.clusters) return false;
      let restored = 0;
      for (const [clusterId, saved] of Object.entries(data.clusters)) {
        const current = this.clusterCaptureState.get(Number(clusterId));
        if (current && saved.tics) {
          current.tics.rust = saved.tics.rust || 0;
          current.tics.cobalt = saved.tics.cobalt || 0;
          current.tics.viridian = saved.tics.viridian || 0;
          current.owner = saved.owner || null;
          restored++;
        }
      }
      // Restore sponsor hold timers
      let timersRestored = 0;
      if (data.sponsorTimers) {
        for (const [sponsorId, saved] of Object.entries(data.sponsorTimers)) {
          const timer = this.sponsorHoldTimers.get(sponsorId);
          if (timer && saved.owner) {
            timer.owner = saved.owner;
            timer.capturedAt = saved.capturedAt || null;
            timer.holdDuration = saved.holdDuration || 0;
            timersRestored++;
          }
        }
      }
      DEBUG_LOG && console.log(`[Room ${this.roomId}] Restored capture state (${restored} clusters, ${timersRestored} sponsor timers from ${data.savedAt?.toDate?.() || "unknown"})`);
      return true;
    } catch (err) {
      console.warn(`[Room ${this.roomId}] Failed to load capture state:`, err.message);
      return false;
    }
  }

  /** @private */
  _autoSaveAllPlayers() {
    const authCount = [...this.players.values()].filter(p => p.uid).length;
    if (authCount === 0) return;
    DEBUG_LOG && console.log(`[Room ${this.roomId}] Auto-saving ${authCount} player profile(s)...`);
    this.saveAllPlayers().catch(err => {
      console.warn(`[Room ${this.roomId}] Auto-save error:`, err.message);
    });
  }

  /**
   * Handle a player switching their active profile mid-game.
   * Resets player state with new profile data and broadcasts to all clients.
   * @param {string} socketId
   * @param {number} newProfileIndex - The profile slot index (0-2)
   * @param {Object} profileData - Full profile data from Firestore
   */
  handleProfileSwitch(socketId, newProfileIndex, profileData) {
    const player = this.players.get(socketId);
    if (!player) return;

    const oldFaction = player.faction;
    const oldProfileIndex = player.profileIndex;

    // Update player data from new profile
    player.name = profileData.name || player.name;
    player.faction = profileData.faction || player.faction;
    player.level = profileData.level || 1;
    player.totalCrypto = profileData.totalCrypto || 0;
    player.crypto = profileData.totalCrypto || 0;
    player.badges = profileData.unlockedBadges?.map(b => b.id) || [];
    player.title = profileData.titleStats?.currentTitle || "Contractor";
    player.profilePicture = profileData.profilePicture || null;
    player.avatarColor = profileData.profilePicture || null;
    player.loadout = profileData.loadout || {};
    player.tankUpgrades = profileData.tankUpgrades || { armor: 0, speed: 0, fireRate: 0, damage: 0 };
    player.unlockedSlots = profileData.unlockedSlots || ['offense-1'];
    player.profileIndex = newProfileIndex;

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
    player._portalReason = 'deploy'; // Profile switch = free re-deploy
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
      avatarColor: player.avatarColor || null,
    });

    // Update faction profile cache for profile switch
    if (player.uid && this.profileCacheReady) {
      // Mark old cache entry offline
      const oldCacheKey = `${player.uid}:${oldProfileIndex}`;
      const oldEntry = this.profileCacheIndex.get(oldCacheKey);
      if (oldEntry) {
        oldEntry.isOnline = false;
        oldEntry.socketId = null;
      }
      const newCacheKey = `${player.uid}:${newProfileIndex}`;
      let newEntry = this.profileCacheIndex.get(newCacheKey);
      if (newEntry) {
        // If the new profile's cached faction differs from the player's current faction, move it
        if (newEntry.faction !== player.faction) {
          const oldArr = this.factionProfileCache[newEntry.faction];
          const idx = oldArr.indexOf(newEntry);
          if (idx !== -1) oldArr.splice(idx, 1);
          const newArr = this.factionProfileCache[player.faction];
          if (newArr.indexOf(newEntry) === -1) newArr.push(newEntry);
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
        this.bodyguardManager.killAllForFaction(oldFaction);
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

    DEBUG_LOG && console.log(
      `[Room ${this.roomId}] ${player.name} switched profile → ${player.faction} Lv${player.level}`
    );
  }

  // ========================
  // ECONOMY: COST HELPERS
  // ========================

  /** Deduct crypto from a player (can go negative for respawn loans) */
  _deductCrypto(player, amount) {
    player.crypto -= amount;
  }

  /** Deny an action due to insufficient funds and notify client + Elon */
  _denyAction(socketId, action, cost) {
    const player = this.players.get(socketId);
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("action-denied", { action, cost, balance: player ? player.crypto : 0 });
    }
    if (player && this.tuskChat) {
      this.tuskChat.onBrokePlayer(player.name, action, socketId);
    }
  }

  /** Get cost to reach a specific level */
  _getLevelCost(level) {
    if (level <= 1) return 0;
    if (level <= 5) return level * 10000;
    if (level <= 10) return 50000 + (level - 5) * 20000;
    if (level <= 20) return 150000 + (level - 10) * 35000;
    return 500000 + (level - 20) * 50000;
  }

  /** Handle level-up purchase request */
  handleLevelUp(socketId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid) return; // Guests can't level up

    const nextLevel = player.level + 1;
    const cost = this._getLevelCost(nextLevel);
    if (cost <= 0) return;

    if (player.crypto < cost) {
      this._denyAction(socketId, 'level-up', cost);
      return;
    }

    this._deductCrypto(player, cost);
    player.level = nextLevel;

    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("level-up-confirmed", { level: nextLevel, cost });
    }

    // Broadcast updated level to all via rank recomputation
    this._markRanksDirty();

    // Persist immediately so level survives disconnect/crash
    this.savePlayerProfile(socketId).catch(() => {});

    DEBUG_LOG && console.log(`[Room ${this.roomId}] ${player.name} purchased level ${nextLevel} for ¢${cost}`);
  }

  /** Handle loadout slot unlock purchase */
  handleUnlockSlot(socketId, slotId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid) return; // Guests can't unlock slots

    const cost = this.costs.slotUnlock[slotId];
    if (!cost) return; // Invalid slot or offense-1 (free)

    // Check level requirement
    const requiredLevel = this.costs.slotLevels[slotId];
    if (requiredLevel && player.level < requiredLevel) return;

    // Check already unlocked
    if (player.unlockedSlots && player.unlockedSlots.includes(slotId)) return;

    if (player.crypto < cost) {
      this._denyAction(socketId, 'unlock-slot', cost);
      return;
    }

    this._deductCrypto(player, cost);
    if (!player.unlockedSlots) player.unlockedSlots = ['offense-1'];
    player.unlockedSlots.push(slotId);

    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("slot-unlocked", { slotId, cost });
    }

    // Persist immediately so unlock survives disconnect/crash
    this.savePlayerProfile(socketId).catch(() => {});

    DEBUG_LOG && console.log(`[Room ${this.roomId}] ${player.name} unlocked slot ${slotId} for ¢${cost}`);
  }

  /** Handle equipping an upgrade into a loadout slot */
  handleEquipUpgrade(socketId, slotId, upgradeId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid) return; // Guests can't equip upgrades

    // Validate slot ID
    const validSlots = ['offense-1', 'offense-2', 'defense-1', 'defense-2', 'tactical-1', 'tactical-2'];
    if (!validSlots.includes(slotId)) return;

    // Validate upgrade ID
    const validUpgrades = {
      offense: ['cannon', 'gunner', '50cal', 'missile', 'flamethrower'],
      defense: ['shield', 'flares', 'barricades'],
      tactical: ['proximity_mine', 'foot_soldiers', 'turrets', 'welding_gun'],
    };
    const slotCategory = slotId.split('-')[0];
    if (!validUpgrades[slotCategory]?.includes(upgradeId)) return;

    // Check slot is unlocked (offense-1 is always unlocked)
    if (slotId !== 'offense-1') {
      if (!player.unlockedSlots || !player.unlockedSlots.includes(slotId)) return;
    }

    player.loadout[slotId] = upgradeId;

    // Persist immediately so loadout survives disconnect/crash
    this.savePlayerProfile(socketId).catch(() => {});
  }

  /** Handle unequipping an upgrade from a loadout slot */
  handleUnequipUpgrade(socketId, slotId) {
    const player = this.players.get(socketId);
    if (!player || !player.uid) return;

    if (player.loadout && player.loadout[slotId]) {
      delete player.loadout[slotId];
      // Persist immediately so loadout survives disconnect/crash
      this.savePlayerProfile(socketId).catch(() => {});
    }
  }

  /** Handle tank upgrade purchase (armor, speed, fireRate, damage) */
  handleTankUpgrade(socketId, type) {
    const player = this.players.get(socketId);
    if (!player || !player.uid) return; // Guests can't purchase upgrades

    const validTypes = ['armor', 'speed', 'fireRate', 'damage'];
    if (!validTypes.includes(type)) return;

    if (!player.tankUpgrades) {
      player.tankUpgrades = { armor: 0, speed: 0, fireRate: 0, damage: 0 };
    }

    if (player.tankUpgrades[type] >= 5) return; // Max tier

    const tier = player.tankUpgrades[type] + 1;
    const costs = [0, 5000, 15000, 40000, 100000, 250000];
    const cost = costs[tier] || 0;
    if (cost <= 0) return;

    if (player.crypto < cost) {
      this._denyAction(socketId, 'tank-upgrade', cost);
      return;
    }

    this._deductCrypto(player, cost);
    player.tankUpgrades[type] = tier;

    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("tank-upgrade-confirmed", { type, tier, cost });
    }

    // Persist immediately so upgrade survives disconnect/crash
    this.savePlayerProfile(socketId).catch(() => {});

    DEBUG_LOG && console.log(`[Room ${this.roomId}] ${player.name} upgraded ${type} to tier ${tier} for ¢${cost}`);
  }

  // ========================
  // INPUT HANDLING
  // ========================

  handleInput(socketId, input) {
    const player = this.players.get(socketId);
    if (!player || this._isUndeployed(player)) return;

    // Validate and apply input (don't trust client positions, only keys)
    if (input.keys) {
      player.keys.w = !!input.keys.w;
      player.keys.a = !!input.keys.a;
      player.keys.s = !!input.keys.s;
      player.keys.d = !!input.keys.d;
      player.keys.shift = !!input.keys.shift;

      // Any key pressed counts as meaningful activity
      if (input.keys.w || input.keys.a || input.keys.s || input.keys.d) {
        player.lastActivityAt = Date.now();
      }
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
    if (!player || this._isUndeployed(player)) return;

    // Enforce server-side cooldown (2 seconds between shots)
    const now = Date.now();
    if (now - player.lastFireTime < 2000) return;
    player.lastFireTime = now;
    player.lastActivityAt = now;

    // Clamp charge power to valid range (0-10)
    const chargePower = Math.max(0, Math.min(10, power || 0));

    // Economy: deduct cannon fire cost (5¢ base + 1¢ per charge level)
    const fireCost = this.costs.cannonBase + Math.ceil(chargePower) * this.costs.cannonPerCharge;
    if (player.crypto < fireCost) {
      this._denyAction(socketId, 'fire', fireCost);
      return;
    }
    this._deductCrypto(player, fireCost);

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
    // Guests are independent — don't accept totalCrypto, level, or profile images
    // from the client (prevents stale data leaking from a previous account session)
    if (!player.isGuest) {
      if (typeof profileData.totalCrypto === "number" && isFinite(profileData.totalCrypto)) {
        player.totalCrypto = Math.max(0, Math.floor(profileData.totalCrypto));
      }
      if (typeof profileData.level === "number" && isFinite(profileData.level)) {
        player.level = Math.max(1, Math.floor(profileData.level));
      }
    }
    // NOTE: crypto is server-authoritative — do NOT accept from client profile data
    if (typeof profileData.title === "string") {
      player.title = profileData.title.substring(0, 50);
    }
    if (typeof profileData.avatarColor === "string") {
      const clientAvatar = profileData.avatarColor.substring(0, 200_000);
      // Guests only get random HSL colors — reject data: URLs that may be stale
      // from a previous account session
      if (player.isGuest) {
        if (!clientAvatar.startsWith("data:")) {
          player.avatarColor = clientAvatar;
        }
      } else if (!player.profilePicture || clientAvatar.startsWith("data:")) {
        player.avatarColor = clientAvatar;
      }
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
        avatarColor: player.avatarColor || null,
      });
    }
  }

  handleEnterFastTravel(socketId) {
    const player = this.players.get(socketId);
    if (!player || this._isUndeployed(player)) return;

    // Economy: check if player can afford fast travel
    if (player.crypto < this.costs.fastTravel) {
      this._denyAction(socketId, 'fast-travel', this.costs.fastTravel);
      return;
    }

    // Mark as waiting so _recomputeRanks won't respawn bodyguards
    player.waitingForPortal = true;
    player._portalReason = 'fastTravel';

    // Kill bodyguards immediately when commander enters fast travel
    for (const faction of FACTIONS) {
      if (this.commanders[faction]?.id === socketId) {
        this.bodyguardManager.killAllForFaction(faction);
        break;
      }
    }
  }

  handlePreviewPortal(socketId, portalTileIndex) {
    const player = this.players.get(socketId);
    if (!player || !player.waitingForPortal) return;

    if (portalTileIndex === null) {
      // Leaving preview — clear override
      player._previewPortalTile = null;
      return;
    }

    // Validate and store the portal tile index for spatial filtering
    if (this.portalPositionsByTile.has(portalTileIndex)) {
      player._previewPortalTile = portalTileIndex;
    }
  }

  handleChoosePortal(socketId, portalTileIndex) {
    const player = this.players.get(socketId);
    if (!player || player.isDead || !player.waitingForPortal) {
      console.log(`[Room ${this.roomId}] choosePortal REJECTED — player:${!!player}, isDead:${player?.isDead}, waitingForPortal:${player?.waitingForPortal}`);
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) socket.emit("portal-rejected");
      return;
    }
    player.lastActivityAt = Date.now();

    // Validate portal tile index
    if (!this.portalPositionsByTile.has(portalTileIndex)) {
      console.log(`[Room ${this.roomId}] Invalid portal tile ${portalTileIndex} from ${player.name} (valid: ${[...this.portalPositionsByTile.keys()].join(',')})`);
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) socket.emit("portal-rejected");
      return;
    }

    const wasWaiting = player.waitingForPortal;

    // Economy: deduct cost based on portal reason
    let portalCost = 0;
    if (player._portalReason === 'fastTravel') {
      portalCost = this.costs.fastTravel;
      this._deductCrypto(player, portalCost);
    } else if (player._portalReason === 'respawn') {
      portalCost = this.costs.respawn;
      const wasBrokeAlready = player.crypto < 0;
      this._deductCrypto(player, portalCost);
      if (player.crypto < 0 && !wasBrokeAlready && this.tuskChat) {
        this.tuskChat.onLoanTaken(player.name, player.crypto, socketId);
      }
    }
    // 'deploy' (initial spawn) is free
    player._portalReason = null;

    // Pick the adjacent hex tile farthest from other tanks
    const neighbors = this.portalNeighborPositions.get(portalTileIndex) || [];
    const spawnPos =
      neighbors.length > 0
        ? this._pickFarthestNeighbor(neighbors, socketId)
        : this.portalPositionsByTile.get(portalTileIndex);

    // Small offset within the chosen tile so players don't stack
    const offsetAngle = Math.random() * Math.PI * 2;
    const offsetMag = 0.001 + Math.random() * 0.002;

    let spawnTheta = spawnPos.theta + Math.cos(offsetAngle) * offsetMag;
    while (spawnTheta < 0) spawnTheta += Math.PI * 2;
    while (spawnTheta >= Math.PI * 2) spawnTheta -= Math.PI * 2;
    player.theta = spawnTheta;
    player.phi = Math.max(
      0.1,
      Math.min(Math.PI - 0.1, spawnPos.phi + Math.sin(offsetAngle) * offsetMag)
    );
    player.heading = Math.random() * Math.PI * 2;
    player.waitingForPortal = false;
    player._previewPortalTile = null;
    player.currentClusterId = null;
    player._lastTicCluster = undefined;
    player._lastTicCryptoTics = undefined;
    player._clusterChangeTicks = 0;

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
        cost: portalCost, // 0 for deploy, 500 for fast travel, 150 for respawn
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
        avatarColor: player.avatarColor || null,
      });
    }

    // Recompute ranks and commander (player is now alive and deployed)
    if (wasWaiting) {
      this._markRanksDirty();
    }

    DEBUG_LOG && console.log(
      `[Room ${this.roomId}] ${player.name} ${wasWaiting ? 'deployed' : 'fast-traveled'} at portal tile ${portalTileIndex}`
    );
  }

  // ========================
  // GAME TICK
  // ========================

  _gameTick() {
    const now = Date.now();
    const tickStart = now;
    const dt = this.tickDelta; // Fixed timestep

    this.tick++;

    // Update planet rotation (normalize to [0, 2pi) to prevent float drift over long uptime)
    this.planetRotation = (this.planetRotation + PLANET_ROTATION_SPEED * dt) % (Math.PI * 2);

    // Update celestial body orbits
    for (const moon of this.moons) moon.angle += moon.speed * dt;
    for (const s of this.stations) {
      s.orbitalAngle += s.speed * dt;
      s.localRotation += s.rotationSpeed * dt;
    }
    for (const b of this.billboardOrbits) b.orbitalAngle += b.speed * dt;

    const _t0 = Date.now();
    // 1. Apply inputs and simulate all player tanks
    for (const [id, player] of this.players) {
      if (this._isUndeployed(player)) {
        continue;
      }

      // Save pre-move position for terrain collision revert
      const prevTheta = player.theta;
      const prevPhi = player.phi;

      // Apply input to physics
      applyInput(player, dt);

      // Move on sphere
      moveOnSphere(player, dt);

      // Terrain collision with wall sliding
      if (this._isTerrainBlockedAt(player.theta, player.phi, player.heading, player.speed)) {
        // Wall sliding: try each axis independently before full revert
        if (!this._isTerrainBlockedAt(player.theta, prevPhi, player.heading, player.speed)) {
          // Slide along latitude (theta moved, phi reverted)
          player.phi = prevPhi;
          player.speed *= 0.85;
        } else if (!this._isTerrainBlockedAt(prevTheta, player.phi, player.heading, player.speed)) {
          // Slide along longitude (theta reverted, phi moved)
          player.theta = prevTheta;
          player.speed *= 0.85;
        } else {
          // Both axes blocked — full revert with speed decay
          player.theta = prevTheta;
          player.phi = prevPhi;
          player.speed *= 0.3;
        }
      }
    }

    const _t1 = Date.now();
    // 1.5. Update bodyguard bots (AI + physics + terrain collision)
    this.bodyguardManager.update(dt, this.players, this.planetRotation);

    const _t2 = Date.now();
    // 1.6. Process previous tick's bot output (worker already finished during inter-tick gap)
    const botResult = this.botBridge.processPendingOutput();
    this.nextProjectileId = botResult.nextProjectileId;
    // Add bot-fired projectiles to shared array
    for (const proj of botResult.newProjectiles) {
      this.projectiles.push(proj);
    }
    // Replay buffered Socket.IO events from worker
    for (const evt of botResult.events) {
      if (evt.proximity) {
        // Proximity chat — only send to nearby players
        for (const [socketId, player] of this.players) {
          if (this._isUndeployed(player)) continue;
          let dTheta = evt.botTheta - player.theta;
          while (dTheta > Math.PI) dTheta -= Math.PI * 2;
          while (dTheta < -Math.PI) dTheta += Math.PI * 2;
          const dPhi = evt.botPhi - player.phi;
          const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
          if (dist <= 0.20) {
            const socket = this.io.sockets.sockets.get(socketId);
            if (socket) socket.emit(evt.type, evt.data);
          }
        }
      } else {
        this.io.to(this.roomId).emit(evt.type, evt.data);
      }
    }

    const _t3 = Date.now();
    // 1.7. Tank-to-tank collision (player-player + player-bot)
    this._resolveTankCollisions();

    const _t4 = Date.now();
    // 2. Update projectiles
    this._updateProjectiles(dt);

    // 3. Update territory capture (every other tick — 10Hz is imperceptible for
    //    seconds-long captures, halves getNearestTile calls from capture logic)
    if (this.tick % 2 === 0) this._updateCapture();

    const _t5 = Date.now();
    // 4. Broadcast world state to all clients
    this._broadcastState();
    const _t6 = Date.now();

    // 5. Recompute faction ranks (every 1 second, or immediately when dirty)
    // Runs BEFORE commander-sync so the snapshot is always up-to-date
    // (e.g. after resign, the resigned player is excluded before broadcast)
    this.rankRecomputeCounter++;
    if (this.rankRecomputeCounter >= this.tickRate || this._ranksDirty) {
      this.rankRecomputeCounter = 0;
      this._ranksDirty = false;
      this._recomputeRanks();
      // Broadcast roster in real-time alongside every rank recompute
      this._broadcastFactionRosters();
    }

    // 6. Broadcast crypto balances + commander state (every 5 seconds)
    if (this.tick % (this.tickRate * 5) === 0) {
      this._broadcastCrypto();
      // Full commander state sync (reliable — catches any missed commander-update events)
      this.io.to(this.roomId).emit("commander-sync", this._getCommanderSnapshot());
    }

    // 6.5. Kill inactive deployed players (check every 5 seconds)
    if (this.tick % (this.tickRate * 5) === 0) {
      const now2 = Date.now();
      for (const [socketId, player] of this.players) {
        if (this._isUndeployed(player)) continue;
        if (now2 - player.lastActivityAt > INACTIVITY_TIMEOUT_MS) {
          console.log(`[Room ${this.roomId}] Killing ${player.name} (${socketId}) for inactivity`);

          player.hp = 0;
          player.isDead = true;
          player.speed = 0;
          player._lastTicCluster = undefined;
          player._lastTicCryptoTics = undefined;

          this.io.to(this.roomId).emit("player-hit", {
            targetId: socketId,
            attackerId: socketId,
            damage: 100,
            hp: 0,
          });

          this.io.to(this.roomId).emit("player-killed", {
            victimId: socketId,
            killerId: socketId,
            victimFaction: player.faction,
            killerFaction: player.faction,
            victimName: player.name,
            killerName: player.name,
            idleKill: true,
          });

          this._markRanksDirty();
          player.killStreak = 0;
          player.deathCount = (player.deathCount || 0) + 1;

          // Shorter delay — client skips terminal sequence for idle kills
          setTimeout(() => this._respawnPlayer(socketId), 2000);
        }
      }
    }

    // 7. Award holding crypto (at the top of each wall-clock minute)
    const currentMinute = Math.floor(Date.now() / 60000);
    if (currentMinute !== this._lastHoldingMinute) {
      this._lastHoldingMinute = currentMinute;
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

    // 9. Send NEXT tick's input to bot worker — placed at end of tick so the
    //    worker has the full ~100ms inter-tick gap to process. Its output will
    //    be ready at the start of the next tick (no 1-tick stale positions).
    const sendCaptureState = (this.tick % 50 === 0) ? this.clusterCaptureState : null;
    this.botBridge.sendTickInput(dt, this.players, this.planetRotation, this.tick, this.nextProjectileId, sendCaptureState);

    // Log tick duration every 100 ticks (~10s)
    const tickMs = Date.now() - tickStart;
    if (!this._tickSum) { this._tickSum = 0; this._tickMax = 0; this._tickCount = 0; }
    this._tickSum += tickMs;
    this._tickMax = Math.max(this._tickMax, tickMs);
    this._tickCount++;
    // Accumulate phase timings
    if (!this._phaseSum) this._phaseSum = [0,0,0,0,0,0];
    this._phaseSum[0] += _t1 - _t0; // players
    this._phaseSum[1] += _t2 - _t1; // bodyguards
    this._phaseSum[2] += _t3 - _t2; // bots
    this._phaseSum[3] += _t4 - _t3; // collision
    this._phaseSum[4] += _t5 - _t4; // projectiles+capture
    this._phaseSum[5] += _t6 - _t5; // broadcast
    if (this._tickCount >= 100) {
      const n = this._tickCount;
      const p = this._phaseSum;
      const avgBytes = this._payloadCount ? Math.round(this._payloadByteSum / this._payloadCount) : 0;
      const avgEntities = this._payloadCount ? Math.round(this._payloadEntitySum / this._payloadCount) : 0;
      const kbps = this._payloadCount ? Math.round(this._payloadByteSum / (n / 10) / 1024 * 10) / 10 : 0;
      console.warn(`[Tick] avg=${(this._tickSum/n).toFixed(0)}ms max=${this._tickMax}ms | players=${(p[0]/n).toFixed(0)} guards=${(p[1]/n).toFixed(0)} bots=${(p[2]/n).toFixed(0)} collide=${(p[3]/n).toFixed(0)} proj=${(p[4]/n).toFixed(0)} broadcast=${(p[5]/n).toFixed(0)} | n=${this.botBridge.botCount}bots ${this.players.size}players | payload=${avgBytes}B ${avgEntities}ents ${kbps}KB/s`);
      this._tickSum = 0; this._tickMax = 0; this._tickCount = 0;
      this._phaseSum = [0,0,0,0,0,0];
      this._payloadByteSum = 0; this._payloadEntitySum = 0; this._payloadCount = 0; this._payloadEmitCount = 0;
    }
  }

  // ========================
  // TANK-TO-TANK COLLISION
  // ========================

  _resolveTankCollisions() {
    const COLLISION_RADIUS = 3.0 / 480;   // ~0.00625 rad (matches bot collision)
    const MIN_DIST = COLLISION_RADIUS * 2;
    const PUSH_BUFFER = 1.5 / 480;
    const SPEED_DAMPEN = 0.3;             // Retain 30% speed on collision

    // --- Player-Player collisions (brute force, max ~1225 pairs) ---
    const playerArray = [];
    for (const [id, p] of this.players) {
      if (!this._isUndeployed(p)) playerArray.push(p);
    }
    for (let i = 0; i < playerArray.length; i++) {
      for (let j = i + 1; j < playerArray.length; j++) {
        this._resolvePairCollision(playerArray[i], playerArray[j], MIN_DIST, PUSH_BUFFER, SPEED_DAMPEN);
      }
    }

    // --- Player-Bot collisions (using bridge spatial hash, player-only push) ---
    const bb = this.botBridge;
    if (!bb || !bb._spatialHash || bb._spatialHash.size === 0) return;

    for (let i = 0; i < playerArray.length; i++) {
      const player = playerArray[i];
      const cellKey = bb._getCellKey(player.theta, player.phi);
      const neighborKeys = bb._getNeighborKeys(cellKey);
      const nCount = bb._neighborKeysCount;

      for (let ni = 0; ni < nCount; ni++) {
        const cellBots = bb._spatialHash.get(neighborKeys[ni]);
        if (!cellBots) continue;

        for (let ci = 0; ci < cellBots.length; ci++) {
          const bot = cellBots[ci];
          // Only push the player — bot is authoritative on worker thread
          this._resolvePlayerBotCollision(player, bot, MIN_DIST, PUSH_BUFFER, SPEED_DAMPEN);
        }
      }
    }
  }

  /**
   * Resolve player-bot collision by only pushing the player.
   * Bot position is authoritative on the worker thread — we can't modify it here.
   */
  _resolvePlayerBotCollision(player, bot, minDist, pushBuffer, speedDampen) {
    let dTheta = bot.theta - player.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const dPhi = bot.phi - player.phi;
    const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    if (dist >= minDist) return;

    const overlap = minDist - dist;
    const push = overlap + pushBuffer; // Full push on player only
    const nx = dist > 0.0001 ? dTheta / dist : 1;
    const ny = dist > 0.0001 ? dPhi / dist : 0;

    const newTheta = player.theta - nx * push;
    const newPhi = player.phi - ny * push;

    if (!this._isTerrainBlockedAt(newTheta, newPhi, player.heading, player.speed)) {
      player.theta = newTheta;
      player.phi = newPhi;
    } else {
      // Try perpendicular push
      const perpTheta = player.theta + ny * push;
      const perpPhi = player.phi - nx * push;
      if (!this._isTerrainBlockedAt(perpTheta, perpPhi, player.heading, player.speed)) {
        player.theta = perpTheta;
        player.phi = perpPhi;
      }
    }

    player.speed *= speedDampen;
  }

  _resolvePairCollision(a, b, minDist, pushBuffer, speedDampen) {
    let dTheta = b.theta - a.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const dPhi = b.phi - a.phi;
    const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    if (dist >= minDist) return;

    const overlap = minDist - dist;
    const push = overlap / 2 + pushBuffer;
    const nx = dist > 0.0001 ? dTheta / dist : 1;
    const ny = dist > 0.0001 ? dPhi / dist : 0;

    // Terrain-aware push: try both, then one-sided, then perpendicular
    const newATheta = a.theta - nx * push;
    const newAPhi = a.phi - ny * push;
    const newBTheta = b.theta + nx * push;
    const newBPhi = b.phi + ny * push;

    const aBlocked = this._isTerrainBlockedAt(newATheta, newAPhi, a.heading, a.speed);
    const bBlocked = this._isTerrainBlockedAt(newBTheta, newBPhi, b.heading, b.speed);

    if (!aBlocked && !bBlocked) {
      a.theta = newATheta; a.phi = newAPhi;
      b.theta = newBTheta; b.phi = newBPhi;
    } else if (!aBlocked) {
      a.theta -= nx * push * 2; a.phi -= ny * push * 2;
    } else if (!bBlocked) {
      b.theta += nx * push * 2; b.phi += ny * push * 2;
    } else {
      // Both blocked — try perpendicular push (slide along wall)
      const perpX = -ny;
      const perpY = nx;
      const perpATheta = a.theta - perpX * push;
      const perpAPhi = a.phi - perpY * push;
      const perpBTheta = b.theta + perpX * push;
      const perpBPhi = b.phi + perpY * push;

      const aPerpBlocked = this._isTerrainBlockedAt(perpATheta, perpAPhi, a.heading, a.speed);
      const bPerpBlocked = this._isTerrainBlockedAt(perpBTheta, perpBPhi, b.heading, b.speed);

      if (!aPerpBlocked && !bPerpBlocked) {
        a.theta = perpATheta; a.phi = perpAPhi;
        b.theta = perpBTheta; b.phi = perpBPhi;
      } else if (!aPerpBlocked) {
        a.theta = perpATheta; a.phi = perpAPhi;
      } else if (!bPerpBlocked) {
        b.theta = perpBTheta; b.phi = perpBPhi;
      }
      // Both fully blocked: just dampen speed, no position change
    }

    // Dampen speed (softer than killing to 0)
    a.speed *= speedDampen;
    b.speed *= speedDampen;
  }

  _isTerrainBlockedAt(theta, phi, heading, speed) {
    const sinPhi = Math.sin(phi);
    const safeSinPhi = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
    const dir = speed > 0 ? 1 : speed < 0 ? -1 : 0;
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);
    const R = 480;
    const fwdPhi = -cosH;
    const fwdTh  = -sinH / safeSinPhi;
    const rgtPhi =  sinH;
    const rgtTh  = -cosH / safeSinPhi;
    const HALF_LEN = 2.75;
    const HALF_WID = 1.5;
    const probes = [
      [0, 0],
      [HALF_LEN * dir, -HALF_WID],
      [HALF_LEN * dir,  HALF_WID],
      [-HALF_LEN * dir, -HALF_WID],
      [-HALF_LEN * dir,  HALF_WID],
    ];
    for (const [fwd, rgt] of probes) {
      const pPhi = phi + (fwdPhi * fwd + rgtPhi * rgt) / R;
      const pTh  = theta + (fwdTh * fwd + rgtTh * rgt) / R;
      if (this.worldGen.isTerrainBlocked(pTh, pPhi)) return true;
    }
    return false;
  }

  _updateProjectiles(dt) {
    const projs = this.projectiles;
    for (let i = projs.length - 1; i >= 0; i--) {
      const p = projs[i];
      p.age += dt;

      if (p.age >= p.maxAge) {
        projs[i] = projs[projs.length - 1]; projs.pop();
        continue;
      }

      // Save pre-move position for swept collision
      const prevTheta = p.theta;
      const prevPhi = p.phi;

      // Move projectile on sphere
      moveOnSphere(p, dt);

      // Distance-based despawn: cap range to match client visual range
      if (p.maxDistanceRad) {
        const distTraveled = sphericalDistance(p.startTheta, p.startPhi, p.theta, p.phi);
        if (distTraveled > p.maxDistanceRad) {
          projs[i] = projs[projs.length - 1]; projs.pop();
          continue;
        }
      }

      // Oriented-box collision: tank body is 5.5 long × 3 wide on radius 480 sphere.
      // Uses heading to check forward/right extents (same approach as terrain probes).
      const R = 480;
      const HALF_LEN = 3.5;   // Forward/back half-extent in world units (2.75 + latency margin)
      const HALF_WID = 3.0;   // Left/right half-extent in world units (1.5 + latency margin, matches client hitRadius)
      const QUICK_REJECT = 0.012; // ~5.8 world units — skip distant players fast

      // Swept collision: check multiple points along the path to prevent tunneling
      const moveDist = sphericalDistance(prevTheta, prevPhi, p.theta, p.phi);
      // Step every ~1.0 world units (well under half of narrow box dim) to catch edge hits
      const numSteps = Math.max(1, Math.ceil(moveDist / 0.002));
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
          if (id === p.ownerId || this._isUndeployed(player)) continue;

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
            player._lastTicCluster = undefined;
            player._lastTicCryptoTics = undefined;

            const killer = this.players.get(p.ownerId);
            const killerBotName = this.botBridge.getBotName(p.ownerId);
            const killerName = killer ? killer.name : (killerBotName || "Unknown");
            const victimName = player.name;

            this.io.to(this.roomId).emit("player-killed", {
              victimId: id,
              killerId: p.ownerId,
              victimFaction: player.faction,
              killerFaction: p.ownerFaction,
              victimName: victimName,
              killerName: killerName,
            });

            // Bot killer trash talk is handled by the worker thread via events

            // Track kill/death streaks for Tusk
            if (killer) {
              killer.killStreak = (killer.killStreak || 0) + 1;
              killer.totalKills = (killer.totalKills || 0) + 1;
              const isVictimCommander = this.commanders[player.faction]?.id === id;
              if (killer.uid) {
                killer.crypto += 500 * (isVictimCommander ? 10 : 1); // Kill bounty (authenticated only)
              }

              // Tusk kill announcement (pass socket IDs for deferred name resolution)
              this.tuskChat.onKill(killerName, victimName, p.ownerFaction, player.faction, p.ownerId, id);

              // Tusk kill streak announcement (at 3, 5, 7, 10+)
              if (killer.killStreak >= 3) {
                this.tuskChat.onKillStreak(killerName, killer.killStreak, p.ownerId);
              }

              // Tusk player milestone (at 10, 25, 50, 100...)
              const milestones = [10, 25, 50, 100, 150, 200];
              if (milestones.includes(killer.totalKills)) {
                this.tuskChat.onPlayerMilestone(killerName, killer.totalKills, p.ownerId);
              }

              // Tusk revenge kill (victim killed the killer recently)
              if (player.lastKilledBy === p.ownerId) {
                this.tuskChat.onRevengeKill(killerName, victimName, p.ownerId, id);
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
              this.tuskChat.onDeathStreak(victimName, player.deathCount, minutes, id);
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
          projs[i] = projs[projs.length - 1]; projs.pop();
          hitPlayer = true;
          break;
        }
      }
      // Check bot hits (after player checks)
      if (!hitPlayer) {
        const botHit = this.botBridge.checkProjectileHit(testTheta, testPhi, p.ownerFaction, p.ownerId);
        if (botHit) {
          const damage = p.damage || 25;
          // Look up bot info from cached broadcast state
          const botState = this.botBridge.getStatesForBroadcast()[botHit.id];
          const botHp = botState ? botState.hp : 100;
          const botFaction = botState ? botState.f : "rust";
          const botName = this.botBridge.getBotName(botHit.id) || "Bot";

          // Send damage to worker (it handles death, respawn, trash talk)
          const attacker = this.players.get(p.ownerId);
          const attackerName = attacker ? attacker.name : "Unknown";
          this.botBridge.applyDamage(botHit.id, damage, p.ownerId, attackerName);

          // Award crypto to human attacker
          if (attacker) {
            attacker.crypto += Math.floor(damage);
          }

          this.io.to(this.roomId).emit("player-hit", {
            targetId: botHit.id,
            attackerId: p.ownerId,
            damage,
            hp: Math.max(0, botHp - damage),
            theta: p.theta,
            phi: p.phi,
          });

          // Check if this hit likely killed the bot (approximate — worker confirms next tick)
          if (botHp - damage <= 0) {
            const killerName = attacker ? attacker.name : "Unknown";
            this.io.to(this.roomId).emit("player-killed", {
              victimId: botHit.id,
              killerId: p.ownerId,
              victimFaction: botFaction,
              killerFaction: p.ownerFaction,
              victimName: botName,
              killerName,
            });

            // Award kill bounty to human attacker
            if (attacker) {
              if (attacker.uid) attacker.crypto += 500;
              attacker.killStreak = (attacker.killStreak || 0) + 1;
              attacker.totalKills = (attacker.totalKills || 0) + 1;
            }
          }

          projs[i] = projs[projs.length - 1]; projs.pop();
          hitPlayer = true;
          break;
        }
      }

      // Check bodyguard hits (after player and bot checks)
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

          projs[i] = projs[projs.length - 1]; projs.pop();
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
    player._portalReason = 'respawn';

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
    if (!player || this._isUndeployed(player)) return;

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
      player._lastTicCluster = undefined;
      player._lastTicCryptoTics = undefined;

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
    if (!tipper || this._isUndeployed(tipper)) return;

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

    // Cannot tip undeployed players (dead or in portal selection)
    if (this._isUndeployed(target)) {
      this._emitToSocket(socketId, "tip-failed", { reason: "Player is not deployed" });
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

    // Tusk announcement to everyone (pass socket IDs for deferred name resolution)
    this.tuskChat.onCommanderTip(tipper.name, target.name, tipAmount, socketId, targetId);
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
    if (!player) return;

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
      if (this._isUndeployed(player)) continue;

      // O(1) cluster ID lookup from precomputed grid
      const rawClusterId = this.worldGen.getClusterIdAt(player.theta, player.phi);

      // Neutral carve-out: if player is on neutral territory (portal/pole),
      // immediately stop contributing to any capture — no hysteresis delay.
      if (rawClusterId == null) {
        player.currentClusterId = null;
        player._clusterChangeTicks = 0;
      // Hysteresis: require 3 consecutive capture ticks (~600ms) of a different
      // cluster before switching. Prevents grid boundary flickering from
      // disrupting tic-crypto tracking (sameCluster check).
      // Exception: assign immediately when player has no cluster yet (first
      // entry after spawn/respawn) to avoid dead time with no capture credit.
      } else if (rawClusterId !== player.currentClusterId) {
        if (player.currentClusterId == null) {
          // No current cluster — assign immediately (first entry / after respawn)
          player.currentClusterId = rawClusterId;
          player._clusterChangeTicks = 0;
          // Prime tic-crypto tracking so the first 1-second check can fire
          // (without this, sameCluster is false and gained is false for 2 seconds)
          player._lastTicCluster = rawClusterId;
          const primeState = this.clusterCaptureState.get(rawClusterId);
          player._lastTicCryptoTics = primeState ? primeState.tics[player.faction] : 0;
        } else {
          player._clusterChangeTicks = (player._clusterChangeTicks || 0) + 1;
          if (player._clusterChangeTicks >= 3) {
            player.currentClusterId = rawClusterId;
            player._clusterChangeTicks = 0;
          }
        }
      } else {
        player._clusterChangeTicks = 0;
      }

      if (player.currentClusterId == null) continue;

      if (!clusterTankCounts.has(player.currentClusterId)) {
        clusterTankCounts.set(player.currentClusterId, { rust: 0, cobalt: 0, viridian: 0 });
      }
      clusterTankCounts.get(player.currentClusterId)[player.faction]++;
    }

    // 1b. Count server bots in clusters (from worker thread position data)
    const botClusterCounts = this.botBridge.getBotClusterCounts();
    for (const [clusterId, counts] of botClusterCounts) {
      if (!clusterTankCounts.has(clusterId)) {
        clusterTankCounts.set(clusterId, { rust: 0, cobalt: 0, viridian: 0 });
      }
      const c = clusterTankCounts.get(clusterId);
      c.rust += counts.rust;
      c.cobalt += counts.cobalt;
      c.viridian += counts.viridian;
    }

    // 2. Advance territory tics and fire all effects (once per real-world second).
    // Cluster assignment above still runs at 5Hz for smooth hysteresis, but tic
    // gains, crypto awards, ring flash, shockwave pulse, and capture-progress
    // all fire together at a clean 1-second cadence.
    this.captureSecondCounter++;
    if (this.captureSecondCounter < this.tickRate / 2) return;
    this.captureSecondCounter = 0;

    // 2a. Process capture logic for each cluster with players in it
    const territoryChanges = [];

    for (const [clusterId, counts] of clusterTankCounts) {
      const state = this.clusterCaptureState.get(clusterId);
      if (!state) continue;

      const previousOwner = state.owner;

      // Snapshot tics before modifications (for snapshot-based steal calculations)
      const snapR = state.tics.rust, snapC = state.tics.cobalt, snapV = state.tics.viridian;
      const snapTotal = snapR + snapC + snapV;
      const isFull = snapTotal >= state.capacity;

      // Process tic gains per faction (1 tic per tank per second)
      for (const faction of FACTIONS) {
        if (counts[faction] <= 0) continue;
        const ticsToAdd = counts[faction]; // 1 tic/tank/sec — runs once per second

        if (isFull) {
          // Territory full — steal from enemy factions proportionally
          const selfSnap = faction === 'rust' ? snapR : faction === 'cobalt' ? snapC : snapV;
          const enemyTotal = snapTotal - selfSnap;
          if (enemyTotal > 0) {
            for (const f of FACTIONS) {
              if (f === faction) continue;
              const fSnap = f === 'rust' ? snapR : f === 'cobalt' ? snapC : snapV;
              if (fSnap > 0) {
                state.tics[f] -= ticsToAdd * (fSnap / enemyTotal);
              }
            }
            state.tics[faction] += ticsToAdd;
          }
        } else {
          // Territory not full — add from unclaimed pool
          state.tics[faction] += ticsToAdd;
        }
      }

      // Floor negative tics (floating-point edge cases near zero)
      for (const f of FACTIONS) {
        if (state.tics[f] < 0) state.tics[f] = 0;
      }

      // Cap total tics at cluster capacity (handles not-full → full transition)
      const totalTics = state.tics.rust + state.tics.cobalt + state.tics.viridian;
      if (totalTics > state.capacity) {
        const scale = state.capacity / totalTics;
        for (const faction of FACTIONS) {
          state.tics[faction] *= scale;
        }
      }

      // Determine ownership
      // Once a faction owns a territory, it stays owned until another faction
      // takes a clear lead. Ownership never reverts to unclaimed.
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

        // On tie, keep previous owner (defender's advantage)
        if (!isTied) {
          state.owner = leadingFaction;
        }
      }
      // Below capacity: keep previous owner (territory doesn't revert to unclaimed)

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

    // 2b. Award tic crypto to contributing players
    for (const [id, player] of this.players) {
      if (this._isUndeployed(player)) continue;
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
        const cryptoAwarded = player.uid ? 10 : 0;
        if (player.uid) {
          player.crypto += 10; // Territory capture income (authenticated only)
        }
        const ticPayload = {
          id: player.currentClusterId,
          t: { r: state.tics.rust, c: state.tics.cobalt, v: state.tics.viridian },
          cap: state.capacity,
          crypto: cryptoAwarded,
        };
        this.io.to(id).emit("tic-crypto", ticPayload);
        player.territoryCaptured += currentTics - lastTics; // Rank tiebreaker
      }
    }

    // 2c. Update sponsor hold timers
    for (const [sponsorId, clusterId] of this.sponsorClusterMap) {
      const state = this.clusterCaptureState.get(clusterId);
      if (!state) continue;
      const timer = this.sponsorHoldTimers.get(sponsorId);
      if (!timer) continue;

      if (state.owner && state.owner === timer.owner) {
        timer.holdDuration += 1000; // 1 full second per tick
      } else if (state.owner && state.owner !== timer.owner) {
        timer.owner = state.owner;
        timer.capturedAt = Date.now();
        timer.holdDuration = 0;
      }
    }

    // 2d. Annotate territory changes with sponsor info
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
          let capturerSocketId = null;
          for (const [sid, player] of this.players) {
            if (player.faction === change.owner && !this._isUndeployed(player)) {
              capturerName = player.name;
              capturerSocketId = sid;
              break;
            }
          }
          const clusterLabel = `Sector ${change.clusterId}`;
          this.tuskChat.onClusterCapture(capturerName, clusterLabel, change.owner, capturerSocketId);
        }
      }
    }

    // 4. Broadcast capture progress to players in active clusters (1/sec, synced with tic advancement)
    const clusterPlayers = new Map();
    for (const [id, player] of this.players) {
      if (this._isUndeployed(player)) continue;
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

  // ========================
  // HOLDING CRYPTO (per-minute territory income)
  // ========================

  _awardHoldingCrypto() {
    const worldResult = this.worldResult;
    const adjacencyMap = worldResult.adjacencyMap;
    const HOLDING_EXPONENT = 1.05;

    // Build owned hex sets and cluster lists per faction (one pass over all clusters)
    const factionOwnedHexes = {
      rust: new Set(),
      cobalt: new Set(),
      viridian: new Set(),
    };
    const factionClusters = { rust: [], cobalt: [], viridian: [] };

    for (const [clusterId, state] of this.clusterCaptureState) {
      if (!state.owner) continue;
      const cluster = worldResult.clusterData[clusterId];
      if (!cluster) continue;
      factionClusters[state.owner].push(clusterId);
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

    DEBUG_LOG && console.log(`[HoldingCrypto] R:${factionCrypto.rust} C:${factionCrypto.cobalt} V:${factionCrypto.viridian}`);

    // Award to each alive player and emit event (include cluster IDs for client visuals)
    for (const [id, player] of this.players) {
      if (this._isUndeployed(player)) continue;
      if (!player.uid) continue; // Guests don't earn crypto

      const amount = factionCrypto[player.faction];
      if (amount <= 0) continue;

      player.crypto += amount;
      this.io.to(id).emit("holding-crypto", {
        amount,
        clusters: factionClusters[player.faction],
      });
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

    // Remove stale bot entries
    const botStates = this.botBridge.getStatesForBroadcast();
    for (const id in playerStates) {
      if (id.startsWith("bot-") && !botStates[id]) delete playerStates[id];
    }

    // Merge bot states
    for (const id in botStates) {
      playerStates[id] = botStates[id];
    }

    // Update/create entries for current players
    for (const [id, p] of this.players) {
      let state = playerStates[id];
      if (!state) {
        state = {};
        playerStates[id] = state;
      }
      state.t = Math.round(p.theta * 10000) / 10000;
      state.p = Math.round(p.phi * 10000) / 10000;
      state.h = Math.round(p.heading * 10000) / 10000;
      state.s = p.speed;
      state.ta = Math.round(p.turretAngle * 10000) / 10000;
      state.hp = p.hp;
      state.d = p.waitingForPortal ? 2 : (p.isDead ? 1 : 0);
      state.seq = p.lastInputSeq;
      state.f = p.faction;
      state.r = p.rank || 0;
      state.rt = this.factionMemberCounts[p.faction] || 0;
    }

    // -- Celestial data (shared by all clients — computed once) --
    if (!this._statePayload) this._statePayload = { tick: 0, players: null, bg: null, pr: 0, ma: [], sa: [], ba: [], tc: 0, bfc: null };
    const statePayload = this._statePayload;
    statePayload.tick = this.tick;
    statePayload.bg = this.bodyguardManager.getStatesForBroadcast();
    statePayload.pr = this.planetRotation;
    // Total population + bot faction breakdown (for chat panel headers)
    statePayload.tc = this.players.size + this.botBridge.botCount;
    statePayload.bfc = this.botBridge.getBotFactionCounts();

    // Compact orbital positions for all bots (every 10 ticks ≈ 1/sec)
    // Flat array: [theta, phi, factionIdx, theta, phi, factionIdx, ...]
    // factionIdx: 0=rust, 1=cobalt, 2=viridian
    if (this.tick % 10 === 0) {
      const op = [];
      const opn = [];
      for (const botId in botStates) {
        const bs = botStates[botId];
        if (bs.d) continue; // skip dead
        op.push(bs.t, bs.p, bs.f === 'rust' ? 0 : bs.f === 'cobalt' ? 1 : 2);
        opn.push(botId, bs.n || botId);
      }
      statePayload.op = op;
      // Send name map every 100 ticks (~10s) to keep bandwidth low
      if (this.tick % 100 === 0 || !this._opNamesSent) {
        statePayload.opn = opn;
        this._opNamesSent = true;
      } else {
        delete statePayload.opn;
      }
    } else {
      delete statePayload.op;
      delete statePayload.opn;
    }

    // Update moon angles in-place
    statePayload.ma.length = this.moons.length;
    for (let i = 0; i < this.moons.length; i++) statePayload.ma[i] = this.moons[i].angle;

    // Update station data in-place
    if (this.tick % 100 === 0) {
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
      statePayload.ba = this.billboardOrbits.map(b => [b.orbitalAngle, b.inclination, b.ascendingNode, b.orbitRadius, b.wobbleX, b.wobbleY, b.wobbleZ, b.speed]);
    } else {
      statePayload.ba.length = this.billboardOrbits.length;
      for (let i = 0; i < this.billboardOrbits.length; i++) {
        if (!statePayload.ba[i]) statePayload.ba[i] = [0];
        statePayload.ba[i][0] = this.billboardOrbits[i].orbitalAngle;
        statePayload.ba[i].length = 1;
      }
    }

    // -- Spatial interest management --
    // Only send nearby bots to each player to reduce bandwidth and serialization.
    // Human players are always included; bots filtered by distance on the sphere.
    // Commanders (who see the whole planet) get all entities.
    // Uses unit vector dot product for O(1) distance check per entity pair.
    const NEARBY_ENTER_THRESHOLD = 0.65; // cos(~49°) — enter radius
    const NEARBY_LEAVE_THRESHOLD = 0.55; // cos(~57°) — wider leave radius (hysteresis prevents flicker)

    // Per-player tracking of which bots were included last tick (for hysteresis)
    if (!this._playerBotSets) this._playerBotSets = new Map();

    // Precompute unit vectors for bot states (theta/phi → xyz on unit sphere)
    if (!this._botUnitVecs) this._botUnitVecs = {};
    const botUnitVecs = this._botUnitVecs;
    for (const botId in botStates) {
      const bs = botStates[botId];
      if (!botUnitVecs[botId]) botUnitVecs[botId] = { x: 0, y: 0, z: 0 };
      const sinP = Math.sin(bs.p);
      botUnitVecs[botId].x = sinP * Math.cos(bs.t);
      botUnitVecs[botId].y = Math.cos(bs.p);
      botUnitVecs[botId].z = sinP * Math.sin(bs.t);
    }
    // Clean stale entries
    for (const id in botUnitVecs) {
      if (!botStates[id]) delete botUnitVecs[id];
    }

    // Collect all human player IDs into an array for fast iteration
    const humanIds = [];
    for (const [id] of this.players) humanIds.push(id);

    // Per-player filtered broadcast
    if (!this._filteredPayloads) this._filteredPayloads = new Map();
    const filteredPayloads = this._filteredPayloads;

    for (const [socketId, player] of this.players) {
      // When previewing a portal, use the portal's position for spatial filtering
      // so the client receives bots near the destination (to check for campers)
      let filterTheta = player.theta;
      let filterPhi = player.phi;
      if (player._previewPortalTile != null) {
        const portalPos = this.portalPositionsByTile.get(player._previewPortalTile);
        if (portalPos) {
          filterTheta = portalPos.theta;
          filterPhi = portalPos.phi;
        }
      }

      // Compute unit vector for spatial filtering
      const pSinP = Math.sin(filterPhi);
      const px = pSinP * Math.cos(filterTheta);
      const py = Math.cos(filterPhi);
      const pz = pSinP * Math.sin(filterTheta);

      // Build filtered players object: all humans + nearby bots
      let filtered = filteredPayloads.get(socketId);
      if (!filtered) {
        filtered = {};
        filteredPayloads.set(socketId, filtered);
      }

      // Clear previous tick's entries
      for (const id in filtered) delete filtered[id];

      // Always include all human players
      for (const hid of humanIds) {
        filtered[hid] = playerStates[hid];
      }

      // Include bots: distance-filtered with hysteresis to prevent boundary flicker.
      // Bots already included use the wider leave threshold; new bots use the tighter enter threshold.
      let includedBots = this._playerBotSets.get(socketId);
      if (!includedBots) {
        includedBots = new Set();
        this._playerBotSets.set(socketId, includedBots);
      }
      for (const botId in botStates) {
        const bv = botUnitVecs[botId];
        const dot = px * bv.x + py * bv.y + pz * bv.z;
        const threshold = includedBots.has(botId) ? NEARBY_LEAVE_THRESHOLD : NEARBY_ENTER_THRESHOLD;
        if (dot > threshold) {
          filtered[botId] = playerStates[botId];
          includedBots.add(botId);
        } else {
          includedBots.delete(botId);
        }
      }

      statePayload.players = filtered;

      // Track payload size for bandwidth monitoring (sample every 50th emit to avoid expensive stringify)
      if (!this._payloadByteSum) this._payloadByteSum = 0;
      if (!this._payloadEntitySum) this._payloadEntitySum = 0;
      if (!this._payloadCount) this._payloadCount = 0;
      if (!this._payloadEmitCount) this._payloadEmitCount = 0;
      this._payloadEmitCount++;
      const entityCount = Object.keys(filtered).length;
      if (this._payloadEmitCount % 50 === 0) {
        this._payloadByteSum += JSON.stringify(statePayload).length;
        this._payloadEntitySum += entityCount;
        this._payloadCount++;
      }

      const socket = this.io.sockets.sockets.get(socketId);
      if (socket) socket.volatile.emit("state", statePayload);
    }
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
        avatarColor: p.avatarColor || null,
      };
    }
    // Merge bot states from worker bridge (build full states from broadcast cache)
    const broadcastStates = this.botBridge.getStatesForBroadcast();
    for (const id in broadcastStates) {
      const bs = broadcastStates[id];
      states[id] = {
        id,
        name: bs.n,
        faction: bs.f,
        theta: bs.t,
        phi: bs.p,
        heading: bs.h,
        turretAngle: bs.ta,
        hp: bs.hp,
        maxHp: 100,
        isDead: bs.d === 1,
        speed: bs.s,
        level: 1,
        crypto: 0,
        isBot: true,
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

    // If this player was commander of the old faction, clear the slot + kill bodyguards
    if (this.commanders[oldFaction]?.id === socketId) {
      this.bodyguardManager.killAllForFaction(oldFaction);
      this.commanders[oldFaction] = null;
    }

    // Update faction
    player.faction = newFaction;

    // Move entry in faction profile cache so _recomputeRanks sees the new faction
    if (player.uid && this.profileCacheReady) {
      const cacheKey = `${player.uid}:${player.profileIndex}`;
      const entry = this.profileCacheIndex.get(cacheKey);
      if (entry && entry.faction !== newFaction) {
        const oldArr = this.factionProfileCache[entry.faction];
        const idx = oldArr.indexOf(entry);
        if (idx !== -1) oldArr.splice(idx, 1);
        const newArr = this.factionProfileCache[newFaction];
        if (newArr.indexOf(entry) === -1) newArr.push(entry);
        entry.faction = newFaction;
      }
    }

    // Broadcast faction change to all clients
    this.io.to(this.roomId).emit("player-faction-changed", {
      id: socketId,
      faction: newFaction,
    });

    // Recompute ranks and commanders for all factions
    this._markRanksDirty();
  }

  /**
   * Server-authoritative identity update from onboarding/auth screen.
   * Sanitizes name, handles duplicates, updates faction and profileIndex if changed.
   */
  handleSetIdentity(socketId, name, faction, profileIndex) {
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
    const oldProfileIndex = player.profileIndex;
    player.name = sanitized;
    player.faction = faction;

    // Update profileIndex if provided (authenticated user selected a profile)
    if (player.uid && typeof profileIndex === "number" && [0, 1, 2].includes(profileIndex)) {
      player.profileIndex = profileIndex;
    }

    // Broadcast identity update to all clients
    this.io.to(this.roomId).emit("player-identity-updated", {
      id: socketId,
      name: sanitized,
      faction: faction,
    });

    // Re-link profile cache if profileIndex changed (user selected a different profile
    // than the one loaded by the auth middleware)
    if (player.uid && this.profileCacheReady && player.profileIndex !== oldProfileIndex) {
      // Mark old entry offline
      const oldCacheKey = `${player.uid}:${oldProfileIndex}`;
      const oldEntry = this.profileCacheIndex.get(oldCacheKey);
      if (oldEntry) {
        oldEntry.isOnline = false;
        oldEntry.socketId = null;
      }
      // Link to new profile's cache entry
      this.linkPlayerToProfileCache(socketId);
    }

    // Update name in profile cache regardless of faction change
    if (player.uid && this.profileCacheReady) {
      const cacheKey = `${player.uid}:${player.profileIndex}`;
      const entry = this.profileCacheIndex.get(cacheKey);
      if (entry) entry.name = sanitized;
    }

    // Recompute ranks if faction changed
    if (oldFaction !== faction) {
      if (this.commanders[oldFaction]?.id === socketId) {
        this.bodyguardManager.killAllForFaction(oldFaction);
        this.commanders[oldFaction] = null;
      }

      // Move entry in faction profile cache so _recomputeRanks sees the new faction
      if (player.uid && this.profileCacheReady) {
        const cacheKey = `${player.uid}:${player.profileIndex}`;
        const entry = this.profileCacheIndex.get(cacheKey);
        if (entry && entry.faction !== faction) {
          const oldArr = this.factionProfileCache[entry.faction];
          const idx = oldArr.indexOf(entry);
          if (idx !== -1) oldArr.splice(idx, 1);
          const newArr = this.factionProfileCache[faction];
          if (newArr.indexOf(entry) === -1) newArr.push(entry);
          entry.faction = faction;
        }
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
   * Check if a player is "undeployed" — not active on the battlefield.
   * Undeployed players cannot be killed, earn/spend crypto (except shop),
   * earn badges, or contribute to territory capture.
   * Covers: initial login, fast travel, profile/account switch, death.
   */
  _isUndeployed(player) {
    return player.isDead || player.waitingForPortal;
  }

  /**
   * Recompute faction ranks for all factions and update commanders.
   * When profileCacheReady, ranks include ALL profiles (online + offline).
   * Falls back to connected-only ranking if Firestore cache isn't loaded.
   * Sorted by: level DESC → live crypto DESC.
   * Commander = rank #1 overall. If offline, highest-ranked online player
   * becomes Acting Commander with full privileges.
   */
  _recomputeRanks() {
    if (!this._rankLogOnce) {
      this._rankLogOnce = true;
      DEBUG_LOG && console.log(`[Ranks] Real-time ranking active: level DESC → live crypto DESC`);
    }
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
            entry.name = p.name;
            entry.level = p.level || 1;
            entry.totalCrypto = p.crypto || 0; // Live balance (not stale p.totalCrypto)
            entry.territoryCaptured = p.territoryCaptured || entry.territoryCaptured;
            // Ensure socket linkage stays current (heals startup race + edge cases)
            entry.socketId = id;
            entry.isOnline = true;
          }
        }

        for (const entry of this.factionProfileCache[faction]) {
          // Skip entries stranded in wrong faction array (stale from failed move)
          if (entry.faction !== faction) continue;
          if (entry.socketId) {
            const player = this.players.get(entry.socketId);
            // Track portal state (ranked but skipped for commander)
            entry.waitingForPortal = !!(player && player.waitingForPortal);
            // Mark resigned players (still ranked, but skipped for commander)
            const resignedUntil = this.resignedPlayers.get(entry.socketId);
            if (resignedUntil && now < resignedUntil) {
              entry.resigned = true;
            } else {
              entry.resigned = false;
              if (resignedUntil) this.resignedPlayers.delete(entry.socketId);
            }
          } else {
            entry.waitingForPortal = false;
          }
          allMembers.push(entry);
        }

        // Include guest players (no uid) who aren't in the profile cache
        for (const [id, p] of this.players) {
          if (p.faction !== faction || p.uid) continue;
          let resigned = false;
          const resignedUntil = this.resignedPlayers.get(id);
          if (resignedUntil && now < resignedUntil) {
            resigned = true;
          } else if (resignedUntil) {
            this.resignedPlayers.delete(id);
          }
          allMembers.push({
            uid: null,
            socketId: id,
            name: p.name,
            level: p.level || 1,
            totalCrypto: p.crypto || 0, // Live balance
            territoryCaptured: p.territoryCaptured || 0,
            avatarColor: p.avatarColor || null,
            isOnline: true,
            resigned,
            waitingForPortal: !!p.waitingForPortal,
          });
        }
      } else {
        // ---- Fallback: connected players only (original behavior) ----
        for (const [id, p] of this.players) {
          if (p.faction !== faction) continue;
          let resigned = false;
          const resignedUntil = this.resignedPlayers.get(id);
          if (resignedUntil && now < resignedUntil) {
            resigned = true;
          } else if (resignedUntil) {
            this.resignedPlayers.delete(id);
          }
          allMembers.push({
            uid: p.uid,
            socketId: id,
            name: p.name,
            level: p.level || 1,
            totalCrypto: p.crypto || 0, // Live balance
            territoryCaptured: p.territoryCaptured || 0,
            avatarColor: p.avatarColor || null,
            isOnline: true,
            resigned,
            waitingForPortal: !!p.waitingForPortal,
          });
        }
      }

      // ---- Deduplicate by uid: keep only the best profile per account ----
      // Guest players (uid=null) are unique per socket, no dedup needed.
      {
        const bestByUid = new Map(); // uid → index in allMembers
        const toRemove = [];

        for (let i = 0; i < allMembers.length; i++) {
          const m = allMembers[i];
          if (!m.uid) continue; // Guest — always keep

          const prevIdx = bestByUid.get(m.uid);
          if (prevIdx === undefined) {
            bestByUid.set(m.uid, i);
            continue;
          }

          // Prefer online > higher level > higher crypto
          const prev = allMembers[prevIdx];
          const mBetter =
            (m.isOnline && !prev.isOnline) ||
            (m.isOnline === prev.isOnline && (m.level || 1) > (prev.level || 1)) ||
            (m.isOnline === prev.isOnline && (m.level || 1) === (prev.level || 1) && (m.totalCrypto || 0) > (prev.totalCrypto || 0));

          if (mBetter) {
            toRemove.push(prevIdx);
            bestByUid.set(m.uid, i);
          } else {
            toRemove.push(i);
          }
        }

        // Remove duplicates (reverse order to preserve indices)
        if (toRemove.length > 0) {
          toRemove.sort((a, b) => b - a);
          for (const idx of toRemove) {
            allMembers.splice(idx, 1);
          }
        }
      }

      // Sort: level DESC → live crypto DESC
      // Look up player.crypto directly from players map (bypasses stale cache)
      const playersMap = this.players;
      allMembers.sort((a, b) => {
        const aLevel = a.level || 1, bLevel = b.level || 1;
        if (bLevel !== aLevel) return bLevel - aLevel;
        const aP = a.socketId ? playersMap.get(a.socketId) : null;
        const bP = b.socketId ? playersMap.get(b.socketId) : null;
        const aCrypto = aP ? aP.crypto : (a.totalCrypto || 0);
        const bCrypto = bP ? bP.crypto : (b.totalCrypto || 0);
        return bCrypto - aCrypto;
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

      // True Commander = rank #1 overall (override or top-ranked non-resigned)
      const trueCommander = overrideEntry || allMembers.find(m => !m.resigned) || null;

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
        // True commander is offline — highest-ranked online non-resigned player is Acting Commander
        isActing = true;
        activeCommander = allMembers.find(m => m.isOnline && m.socketId && !m.resigned) || null;
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
          this.tuskChat?.onCommanderReturns?.(newName, current.name, newId, current.id);
        }
        this.bodyguardManager.killAllForFaction(faction);
        this.commanders[faction] = {
          id: newId, name: newName, isActing,
          trueCommanderName: isActing ? (trueCommander?.name || null) : null,
        };

        // Only spawn bodyguards if new commander is on the planet surface
        const player = this.players.get(newId);
        if (player && !this._isUndeployed(player)) {
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
          this.tuskChat?.onCommanderReturns?.(current.name, current.name, current.id, current.id);
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
        if (player && !this._isUndeployed(player)) {
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
        // For online players, use live player.crypto (totalCrypto + session earnings);
        // for offline players, use cached totalCrypto from Firestore.
        const liveCrypto = m.socketId ? (this.players.get(m.socketId)?.crypto ?? m.totalCrypto) : m.totalCrypto;
        condensed.push({
          id: m.socketId || (m.uid ? `offline_${m.uid}_${m.profileIndex}` : null),
          rank: m.rank,
          name: m.name,
          level: m.level || 1,
          crypto: liveCrypto || 0,
          online: m.isOnline,
          isSelf: m.socketId === socketId,
          avatarColor: m.avatarColor || null,
        });
        if (m.socketId === socketId) playerFound = true;
      }

      // If player is outside top 50, append their entry
      if (!playerFound) {
        const selfEntry = roster.find(m => m.socketId === socketId);
        if (selfEntry) {
          const liveCrypto = this.players.get(selfEntry.socketId)?.crypto ?? selfEntry.totalCrypto;
          condensed.push({
            id: selfEntry.socketId,
            rank: selfEntry.rank,
            name: selfEntry.name,
            level: selfEntry.level || 1,
            crypto: liveCrypto || 0,
            online: true,
            isSelf: true,
            avatarColor: selfEntry.avatarColor || null,
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

  /**
   * Send the faction roster to a single player (e.g. on join).
   */
  _sendRosterToPlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return;

    const roster = this._factionRosters[player.faction];
    if (!roster) return;

    const socket = this.io.sockets.sockets.get(socketId);
    if (!socket) return;

    const condensed = [];
    let playerFound = false;

    for (let i = 0; i < Math.min(roster.length, 50); i++) {
      const m = roster[i];
      const liveCrypto = m.socketId ? (this.players.get(m.socketId)?.crypto ?? m.totalCrypto) : m.totalCrypto;
      condensed.push({
        id: m.socketId || (m.uid ? `offline_${m.uid}_${m.profileIndex}` : null),
        rank: m.rank,
        name: m.name,
        level: m.level || 1,
        crypto: liveCrypto || 0,
        online: m.isOnline,
        isSelf: m.socketId === socketId,
        avatarColor: m.avatarColor || null,
      });
      if (m.socketId === socketId) playerFound = true;
    }

    if (!playerFound) {
      const selfEntry = roster.find(m => m.socketId === socketId);
      if (selfEntry) {
        const liveCrypto = this.players.get(selfEntry.socketId)?.crypto ?? selfEntry.totalCrypto;
        condensed.push({
          id: selfEntry.socketId,
          rank: selfEntry.rank,
          name: selfEntry.name,
          level: selfEntry.level || 1,
          crypto: liveCrypto || 0,
          online: true,
          isSelf: true,
          avatarColor: selfEntry.avatarColor || null,
        });
      }
    }

    socket.emit("faction-roster", {
      faction: player.faction,
      total: roster.length,
      members: condensed,
    });
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

      // Filter out neutral tiles (portals, poles) — they must never be part of any cluster
      const tileIndices = sponsor.cluster.tileIndices.filter(t =>
        !worldResult.portalTileIndices.has(t) && !worldResult.polarTileIndices.has(t)
      );
      if (tileIndices.length === 0) continue;

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
        tiles: tileIndices,
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
    // URLs already include ?v=<mtime> cache busters from extractSponsorImage()
    const sponsors = this.sponsors.map(s => {
      const urls = this.sponsorImageUrls[s.id] || {};
      const entry = {
        id: s.id,
        name: s.name,
        tagline: s.tagline,
        websiteUrl: s.websiteUrl,
        patternImage: urls.patternUrl || null,
        logoImage: urls.logoUrl || null,
        patternAdjustment: s.patternAdjustment,
        cluster: { tileIndices: s.cluster.tileIndices },
        rewards: s.rewards,
        active: s.active,
        createdAt: s.createdAt,
        clusterId: this.sponsorClusterMap.get(s.id),
      };
      // Include player territory metadata so clients can reconcile local state
      if (s.ownerType === "player" || s.isPlayerTerritory) {
        entry.ownerType = "player";
        entry.isPlayerTerritory = true; // backward compat for cached clients
        entry.ownerUid = s.ownerUid || null;
        entry.imageStatus = s.imageStatus || null;
        entry.tierName = s.tierName || null;
        entry._territoryId = s._territoryId || null;
      }
      return entry;
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
      let theta = spawnPos.theta + Math.cos(offsetAngle) * offsetMag;
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
      if (this._isUndeployed(p)) continue;
      tankPositions.push({ theta: p.theta, phi: p.phi });
    }

    // No other tanks — pick random
    if (tankPositions.length === 0) {
      return neighbors[Math.floor(Math.random() * neighbors.length)];
    }

    let bestNeighbor = null;
    let bestMinDist = -1;

    for (const n of neighbors) {
      let nTheta = n.theta;
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
