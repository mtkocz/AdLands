/**
 * AdLands - Bot Worker Bridge
 * Main-thread wrapper that manages the Worker Thread running bot AI.
 * Provides the same interface GameRoom expects from ServerBotManager,
 * but all bot processing happens on a dedicated CPU core.
 *
 * Uses a pipelined pattern: main thread uses tick N-1 output while
 * worker processes tick N. One-tick latency is imperceptible.
 */

const { Worker } = require("worker_threads");
const path = require("path");

// Spatial hash constants (must match ServerBotManager)
const SPATIAL_GRID_PHI = 32;
const SPATIAL_GRID_THETA = 64;
const SPATIAL_CELL_PHI = Math.PI / SPATIAL_GRID_PHI;
const SPATIAL_CELL_THETA = (Math.PI * 2) / SPATIAL_GRID_THETA;

// Hit detection constants (must match ServerBotManager)
const BOT_HIT_HALF_LEN = 3.25;
const BOT_HIT_HALF_WID = 2.25;
const BOT_HIT_QUICK_REJECT = 0.012;

// Position Float32Array stride (must match ServerBotManager.getPositionsFlat)
const POS_STRIDE = 6; // theta, phi, heading, speed, flags, clusterId

// Faction names by index (must match ServerBotManager FACTION_INDEX)
const FACTION_BY_INDEX = ["rust", "cobalt", "viridian"];

class BotWorkerBridge {
  /**
   * @param {number} sphereRadius
   * @param {number} subdivisions
   * @param {number} worldGenSeed
   * @param {number} terrainSeed
   * @param {number} initialHumanCount
   */
  constructor(sphereRadius, subdivisions, worldGenSeed, terrainSeed, initialHumanCount) {
    this._initData = { sphereRadius, subdivisions, worldGenSeed, terrainSeed, initialHumanCount };
    this._sphereRadius = sphereRadius;

    // Worker state
    this._workerReady = false;
    this._worker = null;

    // Pipelined output: previous tick's results
    this._pendingOutput = null;

    // Bot position data (from worker output)
    this._positions = null;       // Float32Array
    this._botIds = [];            // string[]
    this._botNames = {};          // { botId: name }
    this._botStates = {};         // Broadcast states cache

    // Main-thread spatial hash (rebuilt from Float32Array each tick)
    // Fixed-size buckets + length array — zero GC per rebuild
    const totalCells = SPATIAL_GRID_PHI * SPATIAL_GRID_THETA;
    this._spatialCellLengths = new Int32Array(totalCells);
    this._spatialBuckets = new Array(totalCells);
    for (let i = 0; i < totalCells; i++) this._spatialBuckets[i] = [];
    this._spatialCellSize = { phi: SPATIAL_CELL_PHI, theta: SPATIAL_CELL_THETA };
    this._neighborKeysBuf = new Int32Array(9);
    this._neighborKeysCount = 0;

    // Pre-allocated proxy objects for spatial hash (avoids GC)
    this._proxyPool = [];
    this._proxyPoolUsed = 0;

    // Tracking
    this.botCount = 0;
    this._nextProjectileId = 1;  // Fallback if worker hasn't responded yet
    this._missedTicks = 0;

    // Welcome packet callback
    this._fullStatesCallback = null;

    // Start worker
    this._startWorker();
  }

  // ========================
  // WORKER LIFECYCLE
  // ========================

  _startWorker() {
    this._worker = new Worker(path.join(__dirname, "BotWorker.js"), {
      workerData: this._initData,
    });

    this._worker.on("message", (msg) => this._onMessage(msg));
    this._worker.on("error", (err) => this._onError(err));
    this._worker.on("exit", (code) => this._onExit(code));
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "ready":
        this._workerReady = true;
        this.botCount = msg.botCount;
        console.log(`[BotWorkerBridge] Worker ready — ${msg.botCount} bots`);
        break;

      case "tick-output":
        this._pendingOutput = msg;
        this._missedTicks = 0;

        // Update cached data
        if (msg.botIds) {
          this._botIds = msg.botIds;
          this.botCount = msg.botIds.length;
        }
        if (msg.botNames) {
          this._botNames = msg.botNames;
        }
        if (msg.botStates) {
          this._botStates = msg.botStates;
        }
        if (msg.positions) {
          this._positions = msg.positions;
          this._rebuildSpatialHash();
        }
        break;

      case "full-states":
        if (this._fullStatesCallback) {
          this._fullStatesCallback(msg.states);
          this._fullStatesCallback = null;
        }
        break;
    }
  }

  _onError(err) {
    console.error("[BotWorkerBridge] Worker error:", err.message);
  }

  _onExit(code) {
    if (code !== 0) {
      console.error(`[BotWorkerBridge] Worker exited with code ${code}, restarting...`);
      this._workerReady = false;
      this._startWorker();
    }
  }

  shutdown() {
    if (this._worker) {
      this._worker.postMessage({ type: "shutdown" });
      this._worker = null;
    }
  }

  // ========================
  // TICK INTERFACE (called by GameRoom)
  // ========================

  /**
   * Send tick input to the worker. Non-blocking — returns immediately.
   * @param {number} dt
   * @param {Map} players - Human player map
   * @param {number} planetRotation
   * @param {number} tick
   * @param {number} nextProjectileId
   * @param {Map} [captureState] - Full capture state (sent every 50 ticks)
   */
  sendTickInput(dt, players, planetRotation, tick, nextProjectileId, captureState) {
    if (!this._workerReady) return;

    // Serialize players Map to array for structured clone
    const playerArray = [];
    for (const [id, p] of players) {
      playerArray.push({
        id,
        theta: p.theta,
        phi: p.phi,
        heading: p.heading,
        speed: p.speed,
        faction: p.faction,
        isDead: p.isDead,
        waitingForPortal: p.waitingForPortal,
        name: p.name,
        hp: p.hp,
      });
    }

    const msg = {
      type: "tick-input",
      dt,
      planetRotation,
      tick,
      nextProjectileId,
      players: playerArray,
    };

    // Include capture state periodically
    if (captureState) {
      msg.captureState = Array.from(captureState.entries());
    }

    this._worker.postMessage(msg);
  }

  /**
   * Process the previous tick's output from the worker.
   * Returns new projectiles and events to be applied on the main thread.
   * @returns {{ nextProjectileId: number, newProjectiles: Array, events: Array }}
   */
  processPendingOutput() {
    if (!this._pendingOutput) {
      this._missedTicks++;
      if (this._missedTicks > 3 && this._missedTicks % 100 === 0) {
        console.warn(`[BotWorkerBridge] No worker output for ${this._missedTicks} ticks`);
      }
      return { nextProjectileId: this._nextProjectileId, newProjectiles: [], events: [] };
    }

    const output = this._pendingOutput;
    this._pendingOutput = null;

    this._nextProjectileId = output.nextProjectileId;

    return {
      nextProjectileId: output.nextProjectileId,
      newProjectiles: output.newProjectiles || [],
      events: output.events || [],
      playerHeals: output.playerHeals || [],
    };
  }

  /**
   * Send updated cluster data to the worker after sponsor clusters are applied.
   * The worker regenerates the world from seeds but doesn't have sponsor data,
   * so its cluster grid maps everything to background cluster 0. This sends
   * the main thread's post-sponsor grids and cluster data so bots get correct
   * cluster IDs (fixes territory ring presence dots and bot AI targeting).
   */
  sendClusterData(worldGen, clusterData) {
    if (!this._worker) return;
    this._worker.postMessage({
      type: "update-cluster-data",
      clusterGrid: worldGen._clusterGrid.slice(),
      blockedGrid: worldGen._blockedGrid.slice(),
      clusterData: clusterData.map(c => ({ id: c.id, tiles: c.tiles.slice() })),
      tileClusterMap: Array.from(worldGen.tileClusterMap.entries()),
    });
  }

  // ========================
  // BROADCAST STATE
  // ========================

  /** Get bot states for per-tick broadcast (cached from last worker output) */
  getStatesForBroadcast() {
    return this._botStates;
  }

  /** Get full bot states for welcome packet (async — requests from worker) */
  getFullStatesForWelcome() {
    return new Promise((resolve) => {
      if (!this._workerReady) {
        resolve({});
        return;
      }
      this._fullStatesCallback = resolve;
      this._worker.postMessage({ type: "request-full-states" });
      // Timeout fallback — don't hang forever
      setTimeout(() => {
        if (this._fullStatesCallback) {
          this._fullStatesCallback({});
          this._fullStatesCallback = null;
        }
      }, 500);
    });
  }

  // ========================
  // SPAWN / DESPAWN
  // ========================

  onHumanJoin(player) {
    if (!this._workerReady) return;
    this._worker.postMessage({
      type: "human-join",
      player: { id: player.id, faction: player.faction, theta: player.theta, phi: player.phi },
    });
  }

  onHumanLeave(currentHumanCount) {
    if (!this._workerReady) return;
    this._worker.postMessage({ type: "human-leave", currentHumanCount });
  }

  // ========================
  // DAMAGE (main thread projectile hits bot)
  // ========================

  /**
   * Apply damage to a bot (called when a human-fired projectile hits a bot).
   * @param {string} botId
   * @param {number} damage
   * @param {string} killerId
   * @param {string} killerName
   */
  applyDamage(botId, damage, killerId, killerName) {
    if (!this._workerReady) return;
    this._worker.postMessage({ type: "apply-damage", botId, damage, killerId, killerName });
  }

  /**
   * Heal a bot (called when welding gun targets a bot).
   * @param {string} botId
   * @param {number} amount
   */
  applyHealing(botId, amount) {
    if (!this._workerReady) return;
    this._worker.postMessage({ type: "apply-healing", botId, amount });
  }

  // ========================
  // CAPTURE STATE
  // ========================

  updateCaptureState(captureState) {
    if (!this._workerReady) return;
    this._worker.postMessage({
      type: "update-capture-state",
      state: Array.from(captureState.entries()),
    });
  }

  // ========================
  // NAME RESOLUTION
  // ========================

  getBotName(botId) {
    return this._botNames[botId] || null;
  }

  /** Check if a bot exists (for missile owner validation) */
  getBot(botId) {
    return this._botStates[botId] || null;
  }

  // ========================
  // SPATIAL HASH (main thread — for player-bot collision + projectile hit)
  // ========================

  _rebuildSpatialHash() {
    // Reset all cell lengths (zero-alloc clear)
    this._spatialCellLengths.fill(0);
    const positions = this._positions;
    const ids = this._botIds;
    if (!positions || !ids) return;

    this._proxyPoolUsed = 0;

    for (let i = 0; i < ids.length; i++) {
      const off = i * POS_STRIDE;
      const flags = positions[off + 4];
      const isDead = (flags & 1) !== 0;
      const isDeploying = (flags & 2) !== 0;
      if (isDead || isDeploying) continue;

      const theta = positions[off];
      const phi = positions[off + 1];
      const key = this._getCellKey(theta, phi);

      // Reuse proxy objects from pool
      let proxy;
      if (this._proxyPoolUsed < this._proxyPool.length) {
        proxy = this._proxyPool[this._proxyPoolUsed];
      } else {
        proxy = { id: "", theta: 0, phi: 0, heading: 0, speed: 0, faction: "", isDead: false, isDeploying: false };
        this._proxyPool.push(proxy);
      }
      this._proxyPoolUsed++;

      proxy.id = ids[i];
      proxy.theta = theta;
      proxy.phi = phi;
      proxy.heading = positions[off + 2];
      proxy.speed = positions[off + 3];
      proxy.faction = FACTION_BY_INDEX[(flags >> 4) & 0x3];
      proxy.isDead = false;
      proxy.isDeploying = false;

      // Append to bucket (reuse array, track length separately)
      const len = this._spatialCellLengths[key];
      const bucket = this._spatialBuckets[key];
      if (len < bucket.length) {
        bucket[len] = proxy;
      } else {
        bucket.push(proxy);
      }
      this._spatialCellLengths[key] = len + 1;
    }
  }

  _getCellKey(theta, phi) {
    const phiIdx = Math.min(SPATIAL_GRID_PHI - 1, Math.max(0, Math.floor(phi / SPATIAL_CELL_PHI)));
    let normTheta = theta;
    while (normTheta < 0) normTheta += Math.PI * 2;
    while (normTheta >= Math.PI * 2) normTheta -= Math.PI * 2;
    const thetaIdx = Math.min(SPATIAL_GRID_THETA - 1, Math.floor(normTheta / SPATIAL_CELL_THETA));
    return phiIdx * SPATIAL_GRID_THETA + thetaIdx;
  }

  _getNeighborKeys(cellKey) {
    const phiIdx = Math.floor(cellKey / SPATIAL_GRID_THETA);
    const thetaIdx = cellKey % SPATIAL_GRID_THETA;
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

  // ========================
  // PROJECTILE HIT CHECK (on main thread using cached positions)
  // ========================

  /**
   * Check if a projectile at (theta, phi) hits any alive bot.
   * Uses spatial hash for O(~10) checks instead of O(300) brute force.
   * @returns {Object|null} Proxy { id, theta, phi, heading, ... } or null
   */
  checkProjectileHit(theta, phi, ownerFaction, ownerId) {
    if (!this._spatialBuckets) return null;

    const R = this._sphereRadius;
    const cellKey = this._getCellKey(theta, phi);
    const neighborKeys = this._getNeighborKeys(cellKey);
    const nCount = this._neighborKeysCount;

    for (let ni = 0; ni < nCount; ni++) {
      const nk = neighborKeys[ni];
      const cellLen = this._spatialCellLengths[nk];
      if (cellLen === 0) continue;
      const bucket = this._spatialBuckets[nk];

      for (let ci = 0; ci < cellLen; ci++) {
        const bot = bucket[ci];
        if (bot.id === ownerId) continue;
        if (bot.faction === ownerFaction) continue;

        let dTheta = theta - bot.theta;
        if (dTheta > Math.PI) dTheta -= Math.PI * 2;
        else if (dTheta < -Math.PI) dTheta += Math.PI * 2;
        const dPhi = phi - bot.phi;

        const sinPhi = Math.sin(bot.phi);
        const safeSin = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;

        const northOff = dPhi * R;
        const eastOff = dTheta * safeSin * R;

        if (northOff * northOff + eastOff * eastOff > BOT_HIT_QUICK_REJECT * BOT_HIT_QUICK_REJECT * R * R) continue;

        const cosH = Math.cos(bot.heading);
        const sinH = Math.sin(bot.heading);
        const localFwd = -cosH * northOff - sinH * eastOff;
        const localRgt =  sinH * northOff - cosH * eastOff;

        if (Math.abs(localFwd) < BOT_HIT_HALF_LEN && Math.abs(localRgt) < BOT_HIT_HALF_WID) {
          return bot;
        }
      }
    }
    return null;
  }

  // ========================
  // FACTION COUNTS (main thread reads from Float32Array)
  // ========================

  /**
   * Count alive (non-dead, non-deploying) bots per faction.
   * @returns {{ rust: number, cobalt: number, viridian: number }}
   */
  getBotFactionCounts() {
    const counts = { rust: 0, cobalt: 0, viridian: 0 };
    const positions = this._positions;
    const ids = this._botIds;
    if (!positions || !ids) return counts;

    for (let i = 0; i < ids.length; i++) {
      const off = i * POS_STRIDE;
      const flags = positions[off + 4];
      const isDead = (flags & 1) !== 0;
      const isDeploying = (flags & 2) !== 0;
      if (isDead || isDeploying) continue;

      const faction = FACTION_BY_INDEX[(flags >> 4) & 0x3];
      counts[faction]++;
    }
    return counts;
  }

  // ========================
  // CAPTURE COUNTING (main thread reads from Float32Array)
  // ========================

  /**
   * Count bots per cluster per faction for territory capture logic.
   * @returns {Map<number, {rust: number, cobalt: number, viridian: number}>}
   */
  getBotClusterCounts() {
    const counts = new Map();
    const positions = this._positions;
    const ids = this._botIds;
    if (!positions || !ids) return counts;

    for (let i = 0; i < ids.length; i++) {
      const off = i * POS_STRIDE;
      const flags = positions[off + 4];
      const isDead = (flags & 1) !== 0;
      const isDeploying = (flags & 2) !== 0;
      if (isDead || isDeploying) continue;

      const clusterId = positions[off + 5];
      if (clusterId < 0) continue; // -1 = no cluster

      const faction = FACTION_BY_INDEX[(flags >> 4) & 0x3];

      if (!counts.has(clusterId)) {
        counts.set(clusterId, { rust: 0, cobalt: 0, viridian: 0 });
      }
      counts.get(clusterId)[faction]++;
    }
    return counts;
  }
}

module.exports = BotWorkerBridge;
