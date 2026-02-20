/**
 * AdLands - Server Bot Manager
 * Server-authoritative AI bots for multiplayer. Manages bot population,
 * AI state machines, physics, navigation, combat, and state broadcasting.
 * Follows BodyguardManager.js pattern — pure math, no Three.js dependency.
 *
 * Dependencies: ServerBotPathfinder, ServerFactionCoordinator,
 *               WorldGenerator, TerrainElevation, SharedPhysics
 */

const ServerBotPathfinder = require("./ServerBotPathfinder");
const ServerFactionCoordinator = require("./ServerFactionCoordinator");
const { FACTIONS, sphericalDistance } = require("./shared/physics");

// Bot AI states
const BOT_STATES = {
  IDLE: "idle",
  MOVING: "moving",
  CAPTURING: "capturing",
  WANDERING: "wandering",
};

// Bot name pool (same as GameRoom)
const BOT_NAME_POOL = [
  "xXSlayerXx", "N00bKiller", "TankMaster", "DeathWish", "ShadowFury",
  "IronClad", "VoidWalker", "CyberPunk", "NightHawk", "StormBringer",
  "PhantomX", "BlazeFire", "FrostBite", "ThunderBolt", "VenomStrike",
  "RageBeast", "SilentDeath", "ChaosMaker", "DoomBringer", "HexMaster",
  "PixelPro", "ByteMe", "LazerEyes", "CritHit", "HeadShot",
  "NightQueen", "VixenStrike", "LunaWolf", "ScarletRage", "IvyBlade",
  "AthenaX", "ValkyrieFury", "NovaFlare", "ZeldaMain", "SamusRun",
  "GlitchKing", "HackSaw", "R00tAccess", "BufferFlow", "StackSmash",
  "QuantumLeap", "Nebula9", "CometTail", "StarDust", "MoonRise",
  "DesertFox", "ArcticWolf", "JungleCat", "CoralReef", "VolcanoAsh",
  "TurboTank", "NitroBoost", "DriftKing", "BurnOut", "RedLine",
  "Anon420", "Shitposter", "HODL_Lord", "ToTheMoon", "BasedChad",
  "BigBrain99", "SmoothOp", "BotOrNot", "TryHard42", "Lurker_1",
  "OmegaLul", "Kek_Master", "GG_EZ", "PogChamp", "Pepe_Hands",
  "NoScope360", "Wallhacker", "AimBot_Hehe", "LaggingOut", "RubberBand",
  "SendIt", "FullSend", "SkibidiTank", "RizzLord", "CapnCap",
  "SigmaTank", "GyattDamn", "NPC_Energy", "MainChar", "TouchGrass",
  "LockIn", "Tweakin", "GoatedFR", "NoCapFR", "itsGivingTank",
  "SlayQueen", "MotherShip", "Bruh_Moment", "Down_Bad", "RatioKing",
  "JigglyPuff", "YeetMaster", "VibeCheck", "BussyDestroyer", "ClapBack",
  "TheyDontKnow", "FinalBoss", "LilTanky", "BigChungus", "DaddyTank",
  "SheeshMobile", "WakeUp_Neo", "NoBitches", "FactsOnly", "CopiumMax",
  "FadedAF", "ZonedOut", "OnGodBruh", "DeadAss", "ItsOver9000",
  "ImCooked", "RentFree", "StayMad", "Delulu", "EraOfMe",
  "NPC_#4829", "Bot_Maybe", "TankGoBrrr", "PewPewPew", "Kaboomski",
  "SorryNotSorry", "WhoAsked", "Literally1984", "MidTank", "L_Plus_Ratio",
];

// Physics constants (match client BotTanks.js)
const BOT_MAX_SPEED = 0.00022;
const BOT_ACCELERATION = 0.000025;
const BOT_DECELERATION = 0.000015;
const BOT_BASE_TURN_RATE = 0.035;
const BOT_MIN_TURN_RATE = 0.008;
const BOT_TURN_SPEED_FACTOR = 0.7;
const BOT_PIVOT_OFFSET = 0.6;

// Pole avoidance (improved values)
const BOT_POLE_SOFT_LIMIT = 0.5;
const BOT_POLE_HARD_LIMIT = 0.20;
const BOT_POLE_REPULSION_STRENGTH = 0.005;

// Collision avoidance
const BOT_AVOID_DISTANCE = 0.04;
const BOT_AVOID_ANGLE = Math.PI / 2.5;
const BOT_AVOID_STRENGTH = 1.0;

// Omnidirectional separation (anti-bunching)
const BOT_SEPARATION_RADIUS = 0.025;
const BOT_SEPARATION_STRENGTH = 0.15;

// Terrain navigation
const BOT_STUCK_CHECK_INTERVAL = 0.75;
const BOT_STUCK_THRESHOLD = 3;
const BOT_TERRAIN_BOUNCE_LIMIT = 1;
const BOT_COLLISION_SPEED_RETAIN = 0.15;
const BOT_TERRAIN_AVOID_COOLDOWN = 2.5;

// Terrain collision probes (half-dimensions of tank body)
const HALF_LEN = 2.75;
const HALF_WID = 1.5;

// Combat
const BOT_FIRE_COOLDOWN_MIN = 3000; // ms
const BOT_FIRE_COOLDOWN_MAX = 5000;
const BOT_COMBAT_SCAN_RADIUS = 0.15; // radians
const BOT_COMBAT_LOCK_DURATION = 4000; // ms
const BOT_RESPAWN_TIME_MIN = 8000;
const BOT_RESPAWN_TIME_MAX = 12000;

// Hit detection (oriented-box, matches BodyguardManager)
const BOT_HIT_HALF_LEN = 3.5;
const BOT_HIT_HALF_WID = 3.0;
const BOT_HIT_QUICK_REJECT = 0.012; // radians

// Trash talk
const BOT_CHAT_COOLDOWN = 5000; // Per-bot cooldown between messages (ms)
const BOT_GLOBAL_CHAT_COOLDOWN = 1500; // Global cooldown so bots don't flood (ms)
const BOT_CHAT_PROXIMITY_RADIUS = 0.20; // Radians — ~96 world units, proximity hearing range

const BOT_TRASH_TALK = {
  onKill: [
    "gg {victim}",
    "later {victim} lol",
    "{victim} was free",
    "ez clap {victim}",
    "get rekt {victim}",
    "sit down {victim}",
    "{victim} diff",
    "sorry {victim} lmao",
    "bye {victim}",
    "{victim} needs a tutorial",
    "imagine losing to me {victim}",
    "too easy {victim}",
    "{victim} just uninstall",
    "skill issue {victim}",
    "rip {victim}",
    "{victim} is cooked",
    "nt {victim}",
    "{victim} go next",
    "lol {victim}",
    "hold that L {victim}",
  ],
  onDeath: [
    "nice shot {killer}",
    "ok {killer} chill",
    "{killer} got lucky",
    "lag",
    "bruh {killer}",
    "thats cap {killer}",
    "rematch {killer}",
    "im coming for u {killer}",
    "whatever {killer}",
    "i wasnt even trying",
    "camping lol",
    "how {killer}",
    "bro {killer} relax",
    "{killer} ur next on my list",
    "ill be back {killer}",
  ],
  onCombatEngage: [
    "{target} im coming",
    "found u {target}",
    "ur mine {target}",
    "got eyes on {target}",
    "{target} run",
    "pulling up on {target}",
    "{target} dont move",
    "{target} wrong neighborhood",
    "hey {target}",
    "{target} 1v1 me",
  ],
  onCapture: [
    "this is ours now",
    "free real estate",
    "secured",
    "mine",
    "territory diff",
    "get off our land",
    "claimed",
    "ez cap",
  ],
  idle: [
    "anyone else bored",
    "where is everyone",
    "gg lobby",
    "this faction rocks",
    "lets goooo",
    "yall are quiet",
    "bruh this map",
    "whos the best here",
    "im the goat",
    "vibes",
  ],
};

// Spatial hash for bot-bot collision
const SPATIAL_GRID_PHI = 32;
const SPATIAL_GRID_THETA = 64;
class ServerBotManager {
  /**
   * @param {number} sphereRadius - Planet radius (480)
   * @param {Object} terrain - TerrainElevation instance
   * @param {Object} worldGen - WorldGenerator instance
   * @param {Map} clusterCaptureState - Reference to GameRoom's capture state
   */
  constructor(sphereRadius, terrain, worldGen, clusterCaptureState) {
    this.sphereRadius = sphereRadius;
    this.terrain = terrain;
    this.worldGen = worldGen;
    this.clusterCaptureState = clusterCaptureState;

    this.TARGET_TOTAL = 300;
    this.bots = new Map(); // botId → bot state
    this._botArray = []; // Flat array for iteration (synced with Map)
    this._nextBotId = 0;
    this._usedNames = new Set();

    // Faction arrays (updated on spawn/despawn)
    this._factionBots = { rust: [], cobalt: [], viridian: [] };

    // Pathfinder and coordinators (built during init)
    this.pathfinder = null;
    this.coordinators = null;

    // Staggered update tracking
    this._aiUpdateIndex = 0;
    this._pathfindCount = 0; // Per-tick pathfind counter (max 2)
    this._planetRotation = 0; // Updated each tick in update()

    // Spatial hash for bot-bot collision
    this._spatialHash = new Map();
    this._spatialCellSize = { phi: Math.PI / SPATIAL_GRID_PHI, theta: (Math.PI * 2) / SPATIAL_GRID_THETA };

    // Broadcast state cache (reuse objects to reduce GC)
    this._stateCache = {};

    // IO reference (set by GameRoom after construction)
    this.io = null;
    this.roomId = null;

    // Trash talk state
    this._lastGlobalChatTime = 0;
    this._idleChatTimer = 0;
  }

  /**
   * Set Socket.IO references for broadcasting events.
   * Called from GameRoom after construction.
   */
  setIO(io, roomId) {
    this.io = io;
    this.roomId = roomId;
  }

  // ========================
  // INITIALIZATION
  // ========================

  init(humanCount = 0) {
    // Build pathfinder
    this.pathfinder = new ServerBotPathfinder(this.worldGen, this.terrain, this.sphereRadius);

    // Build faction coordinators
    this.coordinators = {
      rust: new ServerFactionCoordinator(this.worldGen, this.clusterCaptureState, "rust"),
      cobalt: new ServerFactionCoordinator(this.worldGen, this.clusterCaptureState, "cobalt"),
      viridian: new ServerFactionCoordinator(this.worldGen, this.clusterCaptureState, "viridian"),
    };
    for (const c of Object.values(this.coordinators)) {
      c.setPathfinder(this.pathfinder);
    }

    // Spawn initial bots
    const botsToSpawn = Math.max(0, this.TARGET_TOTAL - humanCount);
    const perFaction = Math.floor(botsToSpawn / 3);
    const remainder = botsToSpawn - perFaction * 3;

    let extrasGiven = 0;
    for (const faction of FACTIONS) {
      const count = perFaction + (extrasGiven < remainder ? 1 : 0);
      if (extrasGiven < remainder) extrasGiven++;
      for (let i = 0; i < count; i++) {
        this.spawnBot(faction, true); // silent = true (no broadcast on init)
      }
    }

    console.log(`[ServerBotManager] Initialized with ${this.bots.size} bots`);
  }

  // ========================
  // BOT LIFECYCLE
  // ========================

  spawnBot(faction, silent = false) {
    const id = `bot-${String(this._nextBotId++).padStart(4, "0")}`;
    const name = this._pickName();
    const spawn = this._getValidSpawnPosition();
    const personality = Math.random();

    const bot = {
      id,
      name,
      faction,

      // Physics state (broadcast to clients)
      theta: spawn.theta,
      phi: spawn.phi,
      heading: Math.random() * Math.PI * 2,
      speed: 0,
      turretAngle: 0,

      // Health
      hp: 100,
      maxHp: 100,
      isDead: false,

      // Virtual keys (AI output)
      keys: { w: false, a: false, s: false, d: false },

      // AI state
      aiState: BOT_STATES.IDLE,
      stateTimer: 0,
      targetClusterId: null,
      targetPosition: null,
      currentClusterId: null,
      wanderDirection: Math.random() * Math.PI * 2,
      personality,
      driftOffset: (Math.random() - 0.5) * 0.3,
      maxSpeed: BOT_MAX_SPEED * (0.85 + Math.random() * 0.30),
      level: 1 + Math.floor(Math.random() * 5), // 1-5
      crypto: Math.floor(Math.random() * 5001),  // 0-5000

      // Pathfinding
      pathWaypoints: [],
      currentWaypointIdx: 0,
      pathTargetCluster: null,
      _replanCount: 0,

      // Navigation state
      _stuckCheckTheta: spawn.theta,
      _stuckCheckPhi: spawn.phi,
      _stuckCheckTimer: 0,
      _stuckCounter: 0,
      _terrainBounceCount: 0,
      _terrainAvoidTimer: 0,
      _terrainProbeFrame: 0,
      _lastTerrainThreat: null,
      _centerBlocked: false,

      // Combat
      lastFireTime: 0,
      combatTarget: null,
      combatScanTimer: 0,
      combatLockTime: 0,
      _fireAccuracy: 0.125 + personality * 0.25, // 0.125-0.375 radians inaccuracy (25% less accurate)

      // Respawn
      respawnTimer: 0,

      // Trash talk
      lastChatTime: 0,
      chattiness: 0.3 + Math.random() * 0.4, // 30-70% chance per trigger

      // Deploy stagger
      deployTimer: silent ? 1 + Math.random() * 12 : 1 + Math.random() * 4,
      isDeploying: true,
    };

    this.bots.set(id, bot);
    this._botArray.push(bot);
    this._factionBots[faction].push(bot);
    this._usedNames.add(name);

    if (!silent && this.io) {
      this.io.to(this.roomId).emit("player-joined", {
        id: bot.id,
        name: bot.name,
        faction: bot.faction,
        hp: bot.hp,
        level: bot.level,
        crypto: bot.crypto,
        waitingForPortal: false,
        isBot: true,
      });
    }

    return bot;
  }

  despawnBot(botId) {
    const bot = this.bots.get(botId);
    if (!bot) return;

    this.bots.delete(botId);
    this._botArray = this._botArray.filter(b => b.id !== botId);
    this._factionBots[bot.faction] = this._factionBots[bot.faction].filter(b => b.id !== botId);
    this._usedNames.delete(bot.name);

    // Clean from state cache
    delete this._stateCache[botId];

    if (this.io) {
      this.io.to(this.roomId).emit("player-left", { id: botId });
    }
  }

  /**
   * Called when a human player joins. Despawn a bot to maintain population.
   * @param {Object} humanPlayer - The player object (for faction/position info)
   */
  onHumanJoin(humanPlayer) {
    if (this.bots.size === 0) return;

    // Prefer despawning from the human's faction to keep balance
    let candidates = this._factionBots[humanPlayer.faction].filter(b => !b.isDead);
    if (candidates.length === 0) {
      candidates = this._botArray.filter(b => !b.isDead);
    }
    if (candidates.length === 0) {
      candidates = this._botArray;
    }

    // Pick the bot farthest from the new human
    let farthestBot = null;
    let farthestDist = -1;
    for (const bot of candidates) {
      const dist = this._angularDistance(bot.theta, bot.phi, humanPlayer.theta, humanPlayer.phi);
      if (dist > farthestDist) {
        farthestDist = dist;
        farthestBot = bot;
      }
    }

    if (farthestBot) {
      this.despawnBot(farthestBot.id);
    }
  }

  /**
   * Called when a human player leaves. Spawn a bot to maintain population.
   * @param {number} currentHumanCount - Number of human players after removal
   */
  onHumanLeave(currentHumanCount) {
    const targetBots = Math.max(0, this.TARGET_TOTAL - currentHumanCount);
    while (this.bots.size < targetBots) {
      // Spawn on faction with fewest total bots
      const faction = this._getLeastPopulatedBotFaction();
      this.spawnBot(faction);
    }
  }

  // ========================
  // MAIN UPDATE LOOP
  // ========================

  /**
   * Called from GameRoom._gameTick() each server tick.
   * @param {number} dt - Delta time in seconds (1/tickRate)
   * @param {Map} players - Human player map
   * @param {Array} projectiles - Game projectile array (for bot firing)
   * @param {number} planetRotation - Current planet rotation angle
   * @param {number} tick - Current tick number
   * @param {number} nextProjectileId - Next projectile ID from GameRoom
   * @returns {number} Updated nextProjectileId
   */
  update(dt, players, projectiles, planetRotation, tick, nextProjectileId) {
    const now = Date.now();
    this._players = players; // Store for proximity chat
    this._pathfindCount = 0; // Reset per-tick pathfind budget
    this._planetRotation = planetRotation; // Store for use in sub-methods

    const _b0 = Date.now();

    // Deploy bots whose timers have expired
    for (const bot of this._botArray) {
      if (!bot.isDeploying) continue;
      bot.deployTimer -= dt;
      if (bot.deployTimer <= 0) {
        bot.isDeploying = false;
      }
    }

    // Update faction coordinators (every 2 seconds, staggered)
    // Reuse pre-allocated arrays to avoid GC from .filter()
    if (!this._aliveFactionBots) {
      this._aliveFactionBots = { rust: [], cobalt: [], viridian: [] };
    }
    for (const faction of FACTIONS) {
      const alive = this._aliveFactionBots[faction];
      alive.length = 0;
      const factionBots = this._factionBots[faction];
      for (let i = 0; i < factionBots.length; i++) {
        const b = factionBots[i];
        if (!b.isDead && !b.isDeploying) alive.push(b);
      }
      this.coordinators[faction].update(alive, this.coordinators, now);
    }

    const _b1 = Date.now();

    // Staggered AI state updates (30 bots per tick for 300 bots = 10-tick rotation)
    const botsPerTick = Math.max(1, Math.ceil(this._botArray.length / 10));
    const startIdx = this._aiUpdateIndex;
    const endIdx = Math.min(startIdx + botsPerTick, this._botArray.length);

    for (let i = startIdx; i < endIdx; i++) {
      const bot = this._botArray[i];
      if (bot.isDead || bot.isDeploying) continue;
      this._updateAI(bot, dt * (this._botArray.length / botsPerTick));
    }

    this._aiUpdateIndex = endIdx >= this._botArray.length ? 0 : endIdx;

    const _b2 = Date.now();
    let _inputMs = 0, _physMs = 0, _moveMs = 0, _combatMs = 0;

    // Every-tick updates for all bots
    for (let j = 0; j < this._botArray.length; j++) {
      const bot = this._botArray[j];
      if (bot.isDeploying) continue;

      if (bot.isDead) {
        // Respawn countdown
        bot.respawnTimer -= dt * 1000;
        if (bot.respawnTimer <= 0) {
          this._respawnBot(bot);
        }
        continue;
      }

      // 1. AI decides virtual keys
      // Expensive separation + collision threat only on stagger ticks (30/tick)
      const isStagger = (j >= startIdx && j < endIdx);
      let _s = Date.now();
      this._updateInput(bot, dt, isStagger);
      _inputMs += Date.now() - _s;

      // 2. Physics: apply keys to heading and speed
      _s = Date.now();
      this._updatePhysics(bot, dt);
      _physMs += Date.now() - _s;

      // 3. Movement on sphere with pole avoidance
      _s = Date.now();
      this._moveOnSphere(bot, planetRotation, dt);
      _moveMs += Date.now() - _s;

      // 4. Terrain collision (5-probe wall-sliding)
      // (handled inside _moveOnSphere)

      // 5. Update cluster ID (O(1) grid lookup)
      bot.currentClusterId = this.worldGen.getClusterIdAt(bot.theta + planetRotation, bot.phi);

      // 6. Combat (staggered with AI updates)
      if (isStagger) {
        _s = Date.now();
        nextProjectileId = this._updateCombat(bot, dt, players, planetRotation, projectiles, nextProjectileId, now);
        _combatMs += Date.now() - _s;
      }
    }

    const _b3 = Date.now();

    // Rebuild spatial hash (used by player-bot collision in GameRoom + bot AI separation)
    this._rebuildSpatialHash();

    const _b4 = Date.now();

    // Idle trash talk
    this._updateIdleChat(dt);

    // Sub-phase timing (every 100 ticks)
    if (!this._botTickCount) this._botTickCount = 0;
    if (!this._botPhaseSum) this._botPhaseSum = { coord: 0, ai: 0, input: 0, phys: 0, move: 0, combat: 0, hash: 0, total: 0 };
    const bp = this._botPhaseSum;
    bp.coord += _b1 - _b0;
    bp.ai += _b2 - _b1;
    bp.input += _inputMs;
    bp.phys += _physMs;
    bp.move += _moveMs;
    bp.combat += _combatMs;
    bp.hash += _b4 - _b3;
    bp.total += _b4 - _b0;
    this._botTickCount++;
    if (this._botTickCount >= 100) {
      const n = this._botTickCount;
      console.warn(`[Bot] coord=${(bp.coord/n).toFixed(0)} ai=${(bp.ai/n).toFixed(0)} input=${(bp.input/n).toFixed(0)} phys=${(bp.phys/n).toFixed(0)} move=${(bp.move/n).toFixed(0)} combat=${(bp.combat/n).toFixed(0)} hash=${(bp.hash/n).toFixed(0)} total=${(bp.total/n).toFixed(0)}ms`);
      this._botTickCount = 0;
      this._botPhaseSum = { coord: 0, ai: 0, input: 0, phys: 0, move: 0, combat: 0, hash: 0, total: 0 };
    }

    return nextProjectileId;
  }

  // ========================
  // AI STATE MACHINE
  // ========================

  _updateAI(bot, dt) {
    bot.stateTimer += dt;

    switch (bot.aiState) {
      case BOT_STATES.IDLE:
        if (bot.targetClusterId !== null && bot.targetClusterId !== undefined) {
          bot.pathWaypoints = [];
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
        if (bot.targetClusterId === null || bot.targetClusterId === undefined) {
          bot.pathWaypoints = [];
          bot.aiState = BOT_STATES.WANDERING;
          bot.stateTimer = 0;
          break;
        }

        // Reached target cluster
        if (bot.currentClusterId === bot.targetClusterId) {
          bot.pathWaypoints = [];
          bot.aiState = BOT_STATES.CAPTURING;
          bot.stateTimer = 0;
          break;
        }

        // Request path if needed
        if (
          bot.pathWaypoints.length === 0 ||
          bot.pathTargetCluster !== bot.targetClusterId
        ) {
          this._requestPath(bot);
          if (bot.pathWaypoints.length === 0) {
            bot.targetClusterId = null;
            bot.targetPosition = null;
            bot.aiState = BOT_STATES.IDLE;
            bot.stateTimer = 0;
            break;
          }
        }

        // Advance waypoints
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

        // Stuck detection
        if (this._checkStuck(bot, dt)) {
          bot._stuckCounter = 0;
          bot._replanCount++;
          if (bot._replanCount >= 3) {
            bot._replanCount = 0;
            bot.pathWaypoints = [];
            bot.targetClusterId = null;
            bot.targetPosition = null;
            bot.wanderDirection = bot.heading + Math.PI * (0.5 + Math.random());
            bot.aiState = BOT_STATES.WANDERING;
            bot.stateTimer = 0;
            bot.speed = 0;
          } else {
            // Re-plan: reverse briefly
            bot.pathWaypoints = [];
            bot.wanderDirection = bot.heading + Math.PI;
            bot.speed = 0;
            bot._terrainAvoidTimer = 0.5;
          }
        }
        break;

      case BOT_STATES.CAPTURING: {
        const captureState = this.clusterCaptureState.get(bot.currentClusterId);
        if (captureState && captureState.owner === bot.faction) {
          this.onBotCapture(bot);
          bot.targetClusterId = null;
          bot.targetPosition = null;
          bot.pathWaypoints = [];
          bot.aiState = bot.personality > 0.3 ? BOT_STATES.IDLE : BOT_STATES.WANDERING;
          bot.stateTimer = 0;
        } else if (
          bot.targetClusterId !== null &&
          bot.currentClusterId !== bot.targetClusterId
        ) {
          bot.pathWaypoints = [];
          bot.aiState = BOT_STATES.MOVING;
          bot.stateTimer = 0;
        }
        // Stuck detection while capturing — re-path to target
        if (this._checkStuck(bot, dt)) {
          bot._stuckCounter = 0;
          bot.pathWaypoints = [];
          bot.wanderDirection = bot.heading + Math.PI + (Math.random() - 0.5) * 1.0;
          bot.speed = 0;
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
        if (this._checkStuck(bot, dt)) {
          bot._stuckCounter = 0;
          bot.wanderDirection = bot.heading + Math.PI + (Math.random() - 0.5) * 1.0;
          bot.speed = 0;
          bot._terrainAvoidTimer = 0.5;
        }
        break;
      }
    }
  }

  // ========================
  // INPUT SIMULATION
  // ========================

  _updateInput(bot, dt, isStaggerTick) {
    // Reuse keys object instead of allocating new one
    bot.keys.w = false; bot.keys.a = false; bot.keys.s = false; bot.keys.d = false;

    if (bot._terrainAvoidTimer > 0) {
      bot._terrainAvoidTimer -= dt;
    }

    // Expensive spatial queries only on stagger ticks (30 bots/tick)
    if (isStaggerTick) {
      bot._cachedSeparation = this._calculateSeparation(bot);
      const threat = this._detectCollisionThreat(bot);
      bot._cachedThreat = threat.threat;
      bot._cachedSteer = threat.steerDirection;
    }

    // Apply cached separation force
    const separation = bot._cachedSeparation || 0;
    if (separation !== 0) {
      bot.wanderDirection += separation;
    }

    // Target-directed steering (suppressed during terrain avoidance)
    if (bot._terrainAvoidTimer <= 0) {
      if (bot.aiState === BOT_STATES.MOVING) {
        const waypoint = this._getCurrentWaypoint(bot);
        if (waypoint) {
          const desiredHeading = this._computeDesiredHeadingTo(bot, waypoint);
          if (desiredHeading !== null) {
            let targetDiff = desiredHeading - bot.wanderDirection;
            while (targetDiff > Math.PI) targetDiff -= Math.PI * 2;
            while (targetDiff < -Math.PI) targetDiff += Math.PI * 2;
            const blendRate = 0.08 + bot.personality * 0.12;
            bot.wanderDirection += targetDiff * blendRate;
            bot.wanderDirection += bot.driftOffset * 0.06;
          }
        }
      } else if (bot.aiState === BOT_STATES.CAPTURING && bot.targetPosition) {
        const desiredHeading = this._computeDesiredHeadingTo(bot, bot.targetPosition);
        if (desiredHeading !== null) {
          let targetDiff = desiredHeading - bot.wanderDirection;
          while (targetDiff > Math.PI) targetDiff -= Math.PI * 2;
          while (targetDiff < -Math.PI) targetDiff += Math.PI * 2;
          bot.wanderDirection += targetDiff * 0.03;
        }
      }
    }

    // Use cached collision avoidance
    const avoidance = { threat: bot._cachedThreat || 0, steerDirection: bot._cachedSteer || 0 };

    let headingDiff = bot.wanderDirection - bot.heading;
    while (headingDiff > Math.PI) headingDiff -= Math.PI * 2;
    while (headingDiff < -Math.PI) headingDiff += Math.PI * 2;

    const steerDeadZone = 0.05;
    const driveAngleLimit = 0.4;

    if (avoidance.threat > 0.1) {
      if (avoidance.threat > 0.3) {
        const avoidAngle = avoidance.steerDirection * (Math.PI / 2 + avoidance.threat * Math.PI / 4);
        bot.wanderDirection = bot.heading + avoidAngle;
      } else if (this._getCurrentWaypoint(bot) && bot._centerBlocked) {
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
          bot.wanderDirection = Math.abs(diffAvoid) < Math.abs(diffAlt) ? avoidHeading : altHeading;
        }
      }

      if (avoidance.steerDirection > 0) {
        bot.keys.d = true;
      } else {
        bot.keys.a = true;
      }

      if (avoidance.threat > 0.5) {
        if (Math.abs(bot.speed) > bot.maxSpeed * 0.2) {
          bot.keys.s = true;
        }
      } else if (avoidance.threat > 0.3) {
        // Coast
      } else {
        if (Math.abs(headingDiff) < driveAngleLimit * 1.5) {
          bot.keys.w = true;
        }
      }
    } else {
      if (headingDiff > steerDeadZone) {
        bot.keys.d = true;
      } else if (headingDiff < -steerDeadZone) {
        bot.keys.a = true;
      }

      if (Math.abs(headingDiff) < driveAngleLimit) {
        bot.keys.w = true;
      } else if (Math.abs(headingDiff) > Math.PI * 0.75) {
        if (Math.abs(bot.speed) < bot.maxSpeed * 0.3) {
          bot.keys.s = true;
        }
      }
    }

    if (Math.random() < 0.015) {
      bot.wanderDirection += (Math.random() - 0.5) * 1.2;
    }
  }

  // ========================
  // SEPARATION (omnidirectional anti-bunching)
  // ========================

  _calculateSeparation(bot) {
    let separationX = 0; // theta component
    let separationY = 0; // phi component

    const cellKey = this._getCellKey(bot.theta, bot.phi);
    const neighborKeys = this._getNeighborKeys(cellKey);
    const nCount = this._neighborKeysCount;

    for (let ni = 0; ni < nCount; ni++) {
      const cellBots = this._spatialHash.get(neighborKeys[ni]);
      if (!cellBots) continue;
      for (let ci = 0; ci < cellBots.length; ci++) {
        const other = cellBots[ci];
        if (other === bot || other.isDead || other.isDeploying) continue;

        let dTheta = bot.theta - other.theta;
        while (dTheta > Math.PI) dTheta -= Math.PI * 2;
        while (dTheta < -Math.PI) dTheta += Math.PI * 2;
        const dPhi = bot.phi - other.phi;
        const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

        if (dist < BOT_SEPARATION_RADIUS && dist > 0.0001) {
          const weight = (1 - dist / BOT_SEPARATION_RADIUS);
          const factor = weight * weight; // quadratic falloff
          separationX += (dTheta / dist) * factor;
          separationY += (dPhi / dist) * factor;
        }
      }
    }

    if (separationX === 0 && separationY === 0) return 0;

    // Convert repulsion vector to heading offset
    const repulsionHeading = Math.atan2(separationX * Math.max(0.1, Math.sin(bot.phi)), separationY);
    let offset = repulsionHeading - bot.wanderDirection;
    while (offset > Math.PI) offset -= Math.PI * 2;
    while (offset < -Math.PI) offset += Math.PI * 2;

    return offset * BOT_SEPARATION_STRENGTH;
  }

  // ========================
  // COLLISION DETECTION
  // ========================

  _detectCollisionThreat(bot) {
    let botThreat = 0;
    let botSteer = 0;

    // Use spatial hash for nearby bot checks
    const cellKey = this._getCellKey(bot.theta, bot.phi);
    const neighborKeys = this._getNeighborKeys(cellKey);
    const nCount = this._neighborKeysCount;

    for (let ni = 0; ni < nCount; ni++) {
      const cellBots = this._spatialHash.get(neighborKeys[ni]);
      if (!cellBots) continue;
      for (let ci = 0; ci < cellBots.length; ci++) {
        const otherBot = cellBots[ci];
        if (otherBot === bot || otherBot.isDead || otherBot.isDeploying) continue;
        const threat = this._calculateThreat(
          bot.theta, bot.phi, bot.heading,
          otherBot.theta, otherBot.phi,
          BOT_AVOID_DISTANCE, BOT_AVOID_ANGLE,
        );
        if (threat.level > botThreat) {
          botThreat = threat.level;
          botSteer = threat.steerDirection;
        }
      }
    }

    // Terrain threat (every 3rd frame equivalent — every 3rd tick per bot)
    bot._terrainProbeFrame = (bot._terrainProbeFrame || 0) + 1;
    if (bot._terrainProbeFrame >= 3) {
      bot._terrainProbeFrame = 0;
      const terrainThreat = this._detectTerrainThreat(bot);
      bot._lastTerrainThreat = terrainThreat;
    }
    const cachedTerrain = bot._lastTerrainThreat;
    const terrainThreat = cachedTerrain ? cachedTerrain.level : 0;
    const terrainSteer = cachedTerrain ? cachedTerrain.steerDirection : 0;

    // Additive blend: both threats contribute instead of winner-take-all
    const combinedThreat = Math.min(1.0, botThreat + terrainThreat);
    let steerDirection;
    if (botThreat > 0 && terrainThreat > 0) {
      // Weighted blend of steer directions
      const totalWeight = botThreat + terrainThreat;
      const blended = (botSteer * botThreat + terrainSteer * terrainThreat) / totalWeight;
      steerDirection = blended >= 0 ? 1 : -1;
    } else if (terrainThreat > 0) {
      steerDirection = terrainSteer;
    } else {
      steerDirection = botSteer;
    }

    return {
      threat: combinedThreat * BOT_AVOID_STRENGTH,
      steerDirection,
    };
  }

  _calculateThreat(botTheta, botPhi, botHeading, obstacleTheta, obstaclePhi, avoidDist, avoidAngle) {
    let dTheta = obstacleTheta - botTheta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    const dPhi = obstaclePhi - botPhi;
    const angularDist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    if (angularDist > avoidDist) {
      return { level: 0, steerDirection: 0 };
    }

    const angleToObstacle = Math.atan2(-dTheta, -dPhi);
    let relativeAngle = angleToObstacle - botHeading;
    while (relativeAngle > Math.PI) relativeAngle -= Math.PI * 2;
    while (relativeAngle < -Math.PI) relativeAngle += Math.PI * 2;

    if (Math.abs(relativeAngle) > avoidAngle) {
      return { level: 0, steerDirection: 0 };
    }

    const distanceFactor = 1 - angularDist / avoidDist;
    const angleFactor = 1 - Math.abs(relativeAngle) / avoidAngle;
    const threatLevel = distanceFactor * angleFactor;

    let steerDir;
    if (Math.abs(relativeAngle) < 0.1) {
      steerDir = dTheta > 0 ? -1 : 1;
    } else {
      steerDir = relativeAngle < 0 ? 1 : -1;
    }

    return { level: threatLevel, steerDirection: steerDir };
  }

  _detectTerrainThreat(bot) {
    const probeAngles = [-1.2, -0.7, -0.35, 0, 0.35, 0.7, 1.2];
    const probeDistances = [0.02, 0.04, 0.07];
    const maxProbeDist = 0.07;
    let maxThreat = 0;
    let leftThreat = 0;
    let rightThreat = 0;
    let centerBlocked = false;

    const botSinPhi = Math.max(0.1, Math.sin(bot.phi));

    for (const dist of probeDistances) {
      for (const angleOffset of probeAngles) {
        const probeHeading = bot.heading + Math.PI + angleOffset;
        const probePhi = bot.phi - Math.cos(probeHeading) * dist;
        const probeTheta = bot.theta - (Math.sin(probeHeading) * dist) / botSinPhi;

        // Check both terrain elevation AND polar holes
        const blocked = this._isPositionBlocked(probeTheta, probePhi);

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

    // Tiebreaker: steer toward waypoint
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

  /**
   * Check if a spherical position is blocked by terrain or polar hole.
   * Uses WorldGenerator's spatial hash (server-side).
   */
  _isPositionBlocked(theta, phi) {
    const rotTheta = theta + (this._planetRotation || 0);
    return this.worldGen.isTerrainBlocked(rotTheta, phi);
  }

  // ========================
  // PHYSICS
  // ========================

  _updatePhysics(bot, dt) {
    const keys = bot.keys;
    const dt60 = dt * 60;

    const speedRatio = Math.abs(bot.speed) / bot.maxSpeed;
    const turnReduction = speedRatio * BOT_TURN_SPEED_FACTOR;
    const currentTurnRate = BOT_BASE_TURN_RATE + (BOT_MIN_TURN_RATE - BOT_BASE_TURN_RATE) * turnReduction;

    let steerInput = 0;
    if (keys.a) steerInput = -1;
    if (keys.d) steerInput = 1;

    if (steerInput !== 0) {
      const turnAmount = steerInput * currentTurnRate * dt60;
      const pivotMultiplier = 1.0 + speedRatio * BOT_PIVOT_OFFSET;
      bot.heading += turnAmount * pivotMultiplier;
    }

    while (bot.heading < 0) bot.heading += Math.PI * 2;
    while (bot.heading >= Math.PI * 2) bot.heading -= Math.PI * 2;

    // W = forward (negative speed), S = backward (positive speed)
    // Matches shared physics convention where negative speed = visual forward
    if (keys.w) {
      bot.speed -= BOT_ACCELERATION * dt60;
      if (bot.speed < -bot.maxSpeed) bot.speed = -bot.maxSpeed;
    } else if (keys.s) {
      if (bot.speed < 0) {
        bot.speed += BOT_DECELERATION * 2.5 * dt60;
        if (bot.speed > 0) bot.speed = 0;
      } else {
        bot.speed += BOT_ACCELERATION * 0.6 * dt60;
        if (bot.speed > bot.maxSpeed * 0.5) bot.speed = bot.maxSpeed * 0.5;
      }
    } else {
      if (bot.speed > 0) {
        bot.speed -= BOT_DECELERATION * dt60;
        if (bot.speed < 0) bot.speed = 0;
      } else if (bot.speed < 0) {
        bot.speed += BOT_DECELERATION * dt60;
        if (bot.speed > 0) bot.speed = 0;
      }
    }
  }

  // ========================
  // MOVEMENT (with 5-probe wall-sliding)
  // ========================

  _moveOnSphere(bot, planetRotation, dt) {
    const prevTheta = bot.theta;
    const prevPhi = bot.phi;

    const speed = bot.speed;
    const heading = bot.heading;
    const phi = bot.phi;
    const dt60 = dt * 60;

    // Pole repulsion
    const distFromNorthPole = phi;
    const distFromSouthPole = Math.PI - phi;
    const distFromNearestPole = Math.min(distFromNorthPole, distFromSouthPole);

    let poleRepulsion = 0;
    if (distFromNearestPole < BOT_POLE_SOFT_LIMIT) {
      const repulsionFactor = 1 - distFromNearestPole / BOT_POLE_SOFT_LIMIT;
      const repulsionStrength = repulsionFactor * repulsionFactor * BOT_POLE_REPULSION_STRENGTH;
      poleRepulsion = distFromNorthPole < distFromSouthPole
        ? repulsionStrength
        : -repulsionStrength;
    }

    // Scale east-west movement near poles
    const sinPhi = Math.sin(phi);
    const poleMovementScale = Math.min(1.0, sinPhi / Math.sin(BOT_POLE_SOFT_LIMIT));

    const velocityNorth = Math.cos(heading) * speed * dt60;
    const velocityEast = -Math.sin(heading) * speed * dt60 * poleMovementScale;

    const dPhi = -velocityNorth + poleRepulsion * dt60;
    const safeSinPhi = Math.max(0.1, sinPhi);
    const dTheta = velocityEast / safeSinPhi;

    bot.phi += dPhi;
    bot.theta += dTheta;

    // Hard clamp poles
    bot.phi = Math.max(BOT_POLE_HARD_LIMIT, Math.min(Math.PI - BOT_POLE_HARD_LIMIT, bot.phi));

    // Wrap theta
    while (bot.theta > Math.PI * 2) bot.theta -= Math.PI * 2;
    while (bot.theta < 0) bot.theta += Math.PI * 2;

    // Counter planet rotation
    bot.theta -= (dt60 / 60) * 0.001; // PLANET_ROTATION_SPEED = 0.001
    if (bot.theta < 0) bot.theta += Math.PI * 2;

    // 5-probe terrain collision with wall-sliding
    if (bot.speed !== 0) {
      const blocked = this._isTerrainBlockedAt(bot.theta, bot.phi, bot.heading, bot.speed, planetRotation);

      if (blocked) {
        // Compensate planet rotation for revert
        const rotDelta = (dt60 / 60) * 0.001;

        // Try theta-only slide (keep new theta, revert phi)
        const thetaOnly = this._isTerrainBlockedAt(bot.theta, prevPhi, bot.heading, bot.speed, planetRotation);
        // Try phi-only slide (revert theta, keep new phi)
        const thetaRev = prevTheta - rotDelta;
        const phiOnly = this._isTerrainBlockedAt(
          thetaRev < 0 ? thetaRev + Math.PI * 2 : thetaRev,
          bot.phi, bot.heading, bot.speed, planetRotation
        );

        if (!thetaOnly) {
          // Slide along theta (east-west)
          bot.phi = prevPhi;
          bot.speed *= 0.85;
        } else if (!phiOnly) {
          // Slide along phi (north-south)
          bot.theta = thetaRev < 0 ? thetaRev + Math.PI * 2 : thetaRev;
          bot.speed *= 0.85;
        } else {
          // Both axes blocked — full revert
          bot.theta = thetaRev < 0 ? thetaRev + Math.PI * 2 : thetaRev;
          bot.phi = prevPhi;
          bot.speed *= BOT_COLLISION_SPEED_RETAIN;
        }

        // Suppress target-seeking
        bot._terrainAvoidTimer = BOT_TERRAIN_AVOID_COOLDOWN;
        bot._terrainBounceCount++;

        if (bot._terrainBounceCount >= BOT_TERRAIN_BOUNCE_LIMIT) {
          bot.wanderDirection = bot.heading + Math.PI + (Math.random() - 0.5) * 0.5;
          bot._terrainBounceCount = 0;
        } else {
          bot.wanderDirection = bot.heading + Math.PI * (0.5 + Math.random());
        }
      }
    }
  }

  /**
   * 5-probe oriented-box terrain check.
   * Matches GameRoom._isTerrainBlockedAt pattern.
   */
  _isTerrainBlockedAt(theta, phi, heading, speed, planetRotation) {
    const R = this.sphereRadius;
    const sinPhi = Math.sin(phi);
    const safeSinPhi = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
    const dir = speed > 0 ? 1 : speed < 0 ? -1 : 0;
    const cosH = Math.cos(heading);
    const sinH = Math.sin(heading);

    const fwdPhi = -cosH;
    const fwdTh = -sinH / safeSinPhi;
    const rgtPhi = sinH;
    const rgtTh = -cosH / safeSinPhi;

    const probes = [
      [0, 0],
      [HALF_LEN * dir, -HALF_WID],
      [HALF_LEN * dir, HALF_WID],
      [-HALF_LEN * dir, -HALF_WID],
      [-HALF_LEN * dir, HALF_WID],
    ];

    for (const [fwd, rgt] of probes) {
      const pPhi = phi + (fwdPhi * fwd + rgtPhi * rgt) / R;
      const pTh = theta + (fwdTh * fwd + rgtTh * rgt) / R;
      if (this.worldGen.isTerrainBlocked(pTh + planetRotation, pPhi)) return true;
    }
    return false;
  }

  // ========================
  // SPATIAL HASH (for player-bot collision + bot AI separation)
  // ========================

  _rebuildSpatialHash() {
    this._spatialHash.clear();
    for (const bot of this._botArray) {
      if (bot.isDead || bot.isDeploying) continue;
      const key = this._getCellKey(bot.theta, bot.phi);
      if (!this._spatialHash.has(key)) {
        this._spatialHash.set(key, []);
      }
      this._spatialHash.get(key).push(bot);
    }
  }

  // Bot-bot collision removed for performance (300 bots). Player-bot collision
  // still works via GameRoom._resolveTankCollisions() using _spatialHash.

  // ========================
  // COMBAT
  // ========================

  _updateCombat(bot, dt, players, planetRotation, projectiles, nextProjectileId, now) {
    // Scan for targets periodically
    bot.combatScanTimer -= dt * 1000;
    if (bot.combatScanTimer <= 0 || !bot.combatTarget) {
      bot.combatScanTimer = BOT_COMBAT_LOCK_DURATION;
      const prevTarget = bot.combatTarget;
      bot.combatTarget = this._findCombatTarget(bot, players);
      // Trash talk when locking onto a new target
      if (bot.combatTarget && bot.combatTarget !== prevTarget) {
        this.onBotCombatEngage(bot, bot.combatTarget, players);
      }
    }

    // Validate existing target
    if (bot.combatTarget) {
      const target = this._getCombatTargetState(bot.combatTarget, players);
      if (!target || target.isDead) {
        bot.combatTarget = null;
        return nextProjectileId;
      }

      // Update turret angle to face target
      const desiredTurretAngle = this._computeTurretAngle(bot, target);
      bot.turretAngle = desiredTurretAngle;

      // Fire if cooldown expired and within range
      const cooldown = BOT_FIRE_COOLDOWN_MIN + bot.personality * (BOT_FIRE_COOLDOWN_MAX - BOT_FIRE_COOLDOWN_MIN);
      if (now - bot.lastFireTime >= cooldown) {
        const dist = this._angularDistance(bot.theta, bot.phi, target.theta, target.phi);
        const maxRange = 0.08; // ~38 world units — within projectile range
        if (dist < maxRange) {
          bot.lastFireTime = now;
          nextProjectileId = this._fireBotProjectile(bot, projectiles, nextProjectileId);
        }
      }
    }

    return nextProjectileId;
  }

  _findCombatTarget(bot, players) {
    let closestId = null;
    let closestDist = BOT_COMBAT_SCAN_RADIUS;

    // Check human players
    for (const [id, player] of players) {
      if (player.isDead || player.waitingForPortal) continue;
      if (player.faction === bot.faction) continue;
      const dist = this._angularDistance(bot.theta, bot.phi, player.theta, player.phi);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = id;
      }
    }

    // Check other bots
    for (const otherBot of this._botArray) {
      if (otherBot === bot || otherBot.isDead || otherBot.isDeploying) continue;
      if (otherBot.faction === bot.faction) continue;
      const dist = this._angularDistance(bot.theta, bot.phi, otherBot.theta, otherBot.phi);
      if (dist < closestDist) {
        closestDist = dist;
        closestId = otherBot.id;
      }
    }

    return closestId;
  }

  _getCombatTargetState(targetId, players) {
    // Check human players first
    const player = players.get(targetId);
    if (player) return player;
    // Check bots
    return this.bots.get(targetId) || null;
  }

  _computeTurretAngle(bot, target) {
    const dPhi = target.phi - bot.phi;
    let dTheta = target.theta - bot.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    const sinPhi = Math.max(0.1, Math.sin(bot.phi));
    const desiredHeading = Math.atan2(-dTheta * sinPhi, -dPhi);

    // turretAngle = heading + PI - fireHeading (inverse of fire heading calc)
    let turretAngle = bot.heading + Math.PI - desiredHeading;
    // Add inaccuracy
    turretAngle += (Math.random() - 0.5) * bot._fireAccuracy;
    while (turretAngle >= Math.PI * 2) turretAngle -= Math.PI * 2;
    while (turretAngle < 0) turretAngle += Math.PI * 2;
    return turretAngle;
  }

  _fireBotProjectile(bot, projectiles, nextProjectileId) {
    if (bot.isDead) return nextProjectileId;

    // Random charge power 0-4 (bots never max charge)
    const chargePower = Math.random() * 4;
    const chargeRatio = chargePower / 10;

    const speed = 0.004 * (1 + chargeRatio);
    const damage = Math.round(25 * (1 + chargeRatio * 2));
    const rangeWorldUnits = 20 * (1 + chargeRatio * 2);
    const maxDistanceRad = rangeWorldUnits / 480;
    const maxAge = Math.min(maxDistanceRad / (speed * 60) + 0.5, 5);

    // Convert turret angle to fire heading
    let fireHeading = bot.heading + Math.PI - bot.turretAngle;
    while (fireHeading >= Math.PI * 2) fireHeading -= Math.PI * 2;
    while (fireHeading < 0) fireHeading += Math.PI * 2;

    const projectile = {
      id: nextProjectileId++,
      ownerId: bot.id,
      ownerFaction: bot.faction,
      theta: bot.theta,
      phi: bot.phi,
      startTheta: bot.theta,
      startPhi: bot.phi,
      heading: fireHeading,
      speed,
      age: 0,
      maxAge,
      maxDistanceRad,
      damage,
    };

    projectiles.push(projectile);

    // Broadcast fire event
    if (this.io) {
      this.io.to(this.roomId).emit("player-fired", {
        id: bot.id,
        turretAngle: bot.turretAngle,
        theta: bot.theta,
        phi: bot.phi,
        projectileId: projectile.id,
        power: chargePower,
      });
    }

    return nextProjectileId;
  }

  // ========================
  // PROJECTILE HIT CHECK
  // ========================

  /**
   * Check if a projectile at (theta, phi) hits any alive bot.
   * Oriented-box collision matching GameRoom._updateProjectiles pattern.
   * @returns {Object|null} { bot, damage: undefined } or null
   */
  checkProjectileHit(theta, phi, ownerFaction, ownerId) {
    for (const [, bot] of this.bots) {
      if (bot.isDead || bot.isDeploying) continue;
      if (bot.faction === ownerFaction) continue; // No friendly fire
      if (bot.id === ownerId) continue; // Can't hit yourself

      let dTheta = theta - bot.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = phi - bot.phi;

      const angularDist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
      if (angularDist > BOT_HIT_QUICK_REJECT) continue;

      // Project into bot's local heading frame
      const cosH = Math.cos(bot.heading);
      const sinH = Math.sin(bot.heading);
      const localForward = -dPhi * cosH - dTheta * sinH;
      const localRight = -dPhi * sinH + dTheta * cosH;

      const R = this.sphereRadius;
      const worldForward = localForward * R;
      const worldRight = localRight * R;

      if (Math.abs(worldForward) < BOT_HIT_HALF_LEN && Math.abs(worldRight) < BOT_HIT_HALF_WID) {
        return bot;
      }
    }
    return null;
  }

  /**
   * Apply damage to a bot.
   * @param {string} botId
   * @param {number} damage
   * @param {string} [killerId] - Who dealt the killing blow (for trash talk)
   * @param {Map} [players] - Human players map (for name resolution)
   * @returns {boolean} true if bot died
   */
  applyDamage(botId, damage, killerId, players) {
    const bot = this.bots.get(botId);
    if (!bot || bot.isDead) return false;

    bot.hp -= damage;
    if (bot.hp <= 0) {
      bot.hp = 0;
      bot.isDead = true;
      bot.speed = 0;
      bot.respawnTimer = BOT_RESPAWN_TIME_MIN + Math.random() * (BOT_RESPAWN_TIME_MAX - BOT_RESPAWN_TIME_MIN);
      if (killerId) {
        this.onBotDeath(bot, killerId, players);
      }
      return true;
    }
    return false;
  }

  // ========================
  // RESPAWN
  // ========================

  _respawnBot(bot) {
    const spawn = this._getValidSpawnPosition();
    bot.theta = spawn.theta;
    bot.phi = spawn.phi;
    bot.heading = Math.random() * Math.PI * 2;
    bot.speed = 0;
    bot.hp = bot.maxHp;
    bot.isDead = false;
    bot.aiState = BOT_STATES.IDLE;
    bot.stateTimer = 0;
    bot.targetClusterId = null;
    bot.targetPosition = null;
    bot.pathWaypoints = [];
    bot.currentWaypointIdx = 0;
    bot._stuckCounter = 0;
    bot._terrainBounceCount = 0;
    bot._terrainAvoidTimer = 0;
    bot._replanCount = 0;
    bot.combatTarget = null;
    bot.isDeploying = true;
    bot.deployTimer = 0.5 + Math.random() * 2;
  }

  // ========================
  // PATHFINDING
  // ========================

  _requestPath(bot) {
    if (!this.pathfinder) return;
    if (this._pathfindCount >= 2) return; // Budget: max 2 per tick

    const fromTile = this.pathfinder.getNearestTraversableTile(bot.theta, bot.phi);
    if (fromTile === -1) return;

    const toTile = this.pathfinder.getClusterCenterTile(bot.targetClusterId);
    if (toTile === -1) return;

    this._pathfindCount++;
    const path = this.pathfinder.findPath(fromTile, toTile);
    if (path && path.length > 0) {
      bot.pathWaypoints = this.pathfinder.pathToWaypoints(path);
      // Add perpendicular jitter to intermediate waypoints to spread bots across corridor
      if (bot.pathWaypoints.length > 2) {
        const jitterSign = bot.driftOffset > 0 ? 1 : -1;
        const jitterAmount = 0.008 * (0.5 + Math.random() * 0.5) * jitterSign;
        for (let i = 1; i < bot.pathWaypoints.length - 1; i++) {
          const wp = bot.pathWaypoints[i];
          // Jitter perpendicular to path direction
          const prev = bot.pathWaypoints[i - 1];
          const dTheta = wp.theta - prev.theta;
          const dPhi = wp.phi - prev.phi;
          const len = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
          if (len > 0.001) {
            // Perpendicular: rotate 90 degrees
            wp.theta += (-dPhi / len) * jitterAmount;
            wp.phi += (dTheta / len) * jitterAmount;
          }
        }
      }
      bot.currentWaypointIdx = 0;
      bot.pathTargetCluster = bot.targetClusterId;
      bot._replanCount = 0;
    } else {
      bot.pathWaypoints = [];
      bot.currentWaypointIdx = 0;
      bot.pathTargetCluster = null;
    }
  }

  _getCurrentWaypoint(bot) {
    if (bot.pathWaypoints.length > 0 && bot.currentWaypointIdx < bot.pathWaypoints.length) {
      return bot.pathWaypoints[bot.currentWaypointIdx];
    }
    return bot.targetPosition;
  }

  _computeDesiredHeadingTo(bot, target) {
    if (!target) return null;
    const dPhi = target.phi - bot.phi;
    let dTheta = target.theta - bot.theta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const sinPhi = Math.max(0.1, Math.sin(bot.phi));
    return Math.atan2(dTheta * sinPhi, dPhi);
  }

  _checkStuck(bot, dt) {
    bot._stuckCheckTimer += dt; // dt is already scaled for staggered AI
    if (bot._stuckCheckTimer < BOT_STUCK_CHECK_INTERVAL) return false;
    bot._stuckCheckTimer = 0;

    let dTheta = bot.theta - bot._stuckCheckTheta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const dPhi = bot.phi - bot._stuckCheckPhi;
    const distMoved = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    bot._stuckCheckTheta = bot.theta;
    bot._stuckCheckPhi = bot.phi;

    const expectedDistance = bot.maxSpeed * 60 * BOT_STUCK_CHECK_INTERVAL * 0.2;
    if (distMoved < expectedDistance) {
      bot._stuckCounter++;
    } else {
      bot._stuckCounter = 0;
      bot._terrainBounceCount = 0;
    }

    return bot._stuckCounter >= BOT_STUCK_THRESHOLD;
  }

  // ========================
  // STATE BROADCASTING
  // ========================

  /**
   * Get compact bot states for per-tick broadcast.
   * Merges into GameRoom's playerStates object.
   */
  getStatesForBroadcast() {
    // Remove stale entries
    for (const id in this._stateCache) {
      if (!this.bots.has(id)) delete this._stateCache[id];
    }

    for (const [id, bot] of this.bots) {
      if (bot.isDeploying) continue;

      let state = this._stateCache[id];
      if (!state) {
        state = {};
        this._stateCache[id] = state;
      }
      state.t = bot.theta;
      state.p = bot.phi;
      state.h = bot.heading;
      state.s = bot.speed;
      state.ta = bot.turretAngle;
      state.hp = bot.hp;
      state.d = bot.isDead ? 1 : 0;
      state.f = bot.faction;
      state.r = 0; // Bots have no rank
      state.rt = 0;
    }

    return this._stateCache;
  }

  /**
   * Get full bot states for welcome packet.
   */
  getFullStatesForWelcome() {
    const states = {};
    for (const [id, bot] of this.bots) {
      if (bot.isDeploying) continue;
      states[id] = {
        id: bot.id,
        name: bot.name,
        faction: bot.faction,
        theta: bot.theta,
        phi: bot.phi,
        heading: bot.heading,
        turretAngle: bot.turretAngle,
        hp: bot.hp,
        maxHp: bot.maxHp,
        isDead: bot.isDead,
        speed: bot.speed,
        level: bot.level,
        crypto: bot.crypto,
        isBot: true,
      };
    }
    return states;
  }

  // ========================
  // TRASH TALK
  // ========================

  /**
   * Resolve a player/bot ID to a display name.
   * @param {string} id - Socket ID or bot ID
   * @param {Map} [players] - Human players map
   */
  _resolveName(id, players) {
    if (players) {
      const p = players.get(id);
      if (p) return p.name;
    }
    const b = this.bots.get(id);
    if (b) return b.name;
    return null;
  }

  /**
   * Try to send a trash talk message from a bot.
   * Respects per-bot and global cooldowns. RNG gate used for low-priority categories.
   * @param {boolean} [global=false] - true to broadcast to all, false for proximity only
   * @param {boolean} [guaranteed=false] - true to skip RNG chattiness gate
   */
  _botChat(bot, category, replacements, global = false, guaranteed = false) {
    if (!this.io) { console.log("[BotChat] BLOCKED: no io"); return; }
    const now = Date.now();

    // Global cooldown (prevents chat flood from all 150 bots)
    if (now - this._lastGlobalChatTime < BOT_GLOBAL_CHAT_COOLDOWN) return;
    // Per-bot cooldown
    if (now - bot.lastChatTime < BOT_CHAT_COOLDOWN) return;
    // RNG gate — skip for guaranteed events (kills, deaths, captures)
    if (!guaranteed && Math.random() > bot.chattiness) return;

    const pool = BOT_TRASH_TALK[category];
    if (!pool || pool.length === 0) return;

    let text = pool[Math.floor(Math.random() * pool.length)];
    if (replacements) {
      for (const [key, val] of Object.entries(replacements)) {
        text = text.replace(new RegExp(`\\{${key}\\}`, "g"), val);
      }
    }

    bot.lastChatTime = now;
    this._lastGlobalChatTime = now;

    // Global broadcasts use lobby mode (visible to everyone in all tabs).
    // Proximity messages randomly pick faction or lobby, matching client-side bot behavior.
    const mode = global ? "lobby" : (Math.random() < 0.5 ? "lobby" : "faction");

    const chatData = {
      id: bot.id,
      name: bot.name,
      faction: bot.faction,
      text,
      mode,
    };

    if (process.env.DEBUG_LOG === "1") console.log(`[BotChat] ${bot.name} (${category}, ${mode}${global ? ", global" : ""}): ${text}`);

    if (global) {
      // Broadcast to entire room
      this.io.to(this.roomId).emit("chat", chatData);
    } else {
      // Proximity: only send to human players within range
      this._emitToNearbyPlayers(bot, chatData);
    }
  }

  /**
   * Emit a chat event only to human players within proximity of a bot.
   */
  _emitToNearbyPlayers(bot, chatData) {
    const players = this._players;
    if (!players) return;

    for (const [socketId, player] of players) {
      if (player.isDead || player.waitingForPortal) continue;
      const dist = this._angularDistance(bot.theta, bot.phi, player.theta, player.phi);
      if (dist <= BOT_CHAT_PROXIMITY_RADIUS) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) socket.emit("chat", chatData);
      }
    }
  }

  /**
   * Called when a bot kills someone.
   * Guaranteed to fire (only cooldowns can block). 30% chance global.
   */
  onBotKill(bot, victimId, players) {
    const victimName = this._resolveName(victimId, players);
    if (!victimName) return;
    const isGlobal = Math.random() < 0.30;
    this._botChat(bot, "onKill", { victim: victimName }, isGlobal, true);
  }

  /**
   * Called when a bot dies. Guaranteed, proximity-only.
   */
  onBotDeath(bot, killerId, players) {
    const killerName = this._resolveName(killerId, players);
    if (!killerName) return;
    this._botChat(bot, "onDeath", { killer: killerName }, false, true);
  }

  /**
   * Called when a bot locks onto a combat target. RNG-gated, proximity-only.
   */
  onBotCombatEngage(bot, targetId, players) {
    const targetName = this._resolveName(targetId, players);
    if (!targetName) return;
    this._botChat(bot, "onCombatEngage", { target: targetName });
  }

  /**
   * Called when a bot's cluster finishes capturing. Guaranteed, proximity-only.
   */
  onBotCapture(bot) {
    this._botChat(bot, "onCapture", {}, false, true);
  }

  /**
   * Random idle chatter — called from update() on a timer. Broadcast globally.
   */
  _updateIdleChat(dt) {
    this._idleChatTimer -= dt;
    if (this._idleChatTimer > 0) return;
    this._idleChatTimer = 30 + Math.random() * 60; // 30-90 seconds

    // Pick a random alive bot
    const alive = this._botArray.filter(b => !b.isDead && !b.isDeploying);
    if (alive.length === 0) return;
    const bot = alive[Math.floor(Math.random() * alive.length)];
    this._botChat(bot, "idle", {}, true);
  }

  // ========================
  // HELPERS
  // ========================

  _getValidSpawnPosition() {
    const PHI_MIN = 0.35;
    const PHI_MAX = Math.PI - 0.35;

    for (let attempt = 0; attempt < 20; attempt++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = PHI_MIN + Math.random() * (PHI_MAX - PHI_MIN);

      // Check not on elevated terrain or in polar hole
      if (!this._isPositionBlocked(theta, phi)) {
        return { theta, phi };
      }
    }

    // Fallback: mid-latitude
    return {
      theta: Math.random() * Math.PI * 2,
      phi: Math.PI / 4 + Math.random() * (Math.PI / 2),
    };
  }

  _pickName() {
    const available = BOT_NAME_POOL.filter(n => !this._usedNames.has(n));
    if (available.length > 0) {
      return available[Math.floor(Math.random() * available.length)];
    }
    return "Tank_" + Math.floor(Math.random() * 9999);
  }

  _getLeastPopulatedBotFaction() {
    const counts = {
      rust: this._factionBots.rust.length,
      cobalt: this._factionBots.cobalt.length,
      viridian: this._factionBots.viridian.length,
    };
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

  _angularDistance(t1, p1, t2, p2) {
    let dTheta = t2 - t1;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;
    const dPhi = p2 - p1;
    return Math.sqrt(dTheta * dTheta + dPhi * dPhi);
  }

  _getCellKey(theta, phi) {
    const phiIdx = Math.min(SPATIAL_GRID_PHI - 1, Math.max(0, Math.floor(phi / this._spatialCellSize.phi)));
    let normTheta = theta;
    while (normTheta < 0) normTheta += Math.PI * 2;
    while (normTheta >= Math.PI * 2) normTheta -= Math.PI * 2;
    const thetaIdx = Math.min(SPATIAL_GRID_THETA - 1, Math.floor(normTheta / this._spatialCellSize.theta));
    return phiIdx * SPATIAL_GRID_THETA + thetaIdx;
  }

  _getNeighborKeys(cellKey) {
    const phiIdx = Math.floor(cellKey / SPATIAL_GRID_THETA);
    const thetaIdx = cellKey % SPATIAL_GRID_THETA;
    // Reuse pre-allocated array (max 9 neighbors)
    if (!this._neighborKeysBuf) this._neighborKeysBuf = new Int32Array(9);
    let count = 0;

    for (let dp = -1; dp <= 1; dp++) {
      const p = phiIdx + dp;
      if (p < 0 || p >= SPATIAL_GRID_PHI) continue;
      for (let dt = -1; dt <= 1; dt++) {
        const t = (thetaIdx + dt + SPATIAL_GRID_THETA) % SPATIAL_GRID_THETA;
        this._neighborKeysBuf[count++] = p * SPATIAL_GRID_THETA + t;
      }
    }

    this._neighborKeysCount = count;
    return this._neighborKeysBuf;
  }

}

module.exports = ServerBotManager;
