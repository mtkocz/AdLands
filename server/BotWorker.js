/**
 * AdLands - Bot Worker Thread
 * Runs ServerBotManager on a dedicated CPU core. Communicates with
 * main thread via postMessage (structured clone, no SharedArrayBuffer).
 *
 * The worker re-generates WorldGenerator + TerrainElevation from the same
 * deterministic seeds used by the main thread (~300ms startup cost).
 */

const { workerData, parentPort } = require("worker_threads");
const WorldGenerator = require("./WorldGenerator");
const TerrainElevation = require("./shared/TerrainElevation");
const ServerBotManager = require("./ServerBotManager");

// ---- Re-generate world from seeds (deterministic) ----
const { sphereRadius, subdivisions, worldGenSeed, terrainSeed, initialHumanCount } = workerData;

const worldGen = new WorldGenerator(sphereRadius, subdivisions, worldGenSeed);
const worldResult = worldGen.generate();

const terrain = new TerrainElevation(terrainSeed);
terrain.generate(
  worldResult.tiles,
  worldResult.adjacencyMap,
  worldResult.portalTileIndices,
  worldResult.polarTileIndices
);
worldGen.buildBlockedGrid(terrain);

// ---- Create bot manager in worker mode ----
// clusterCaptureState starts empty — main thread sends updates every 50 ticks
const clusterCaptureState = new Map();
const botManager = new ServerBotManager(sphereRadius, terrain, worldGen, clusterCaptureState, true);
botManager.init(initialHumanCount);

// Track whether bot IDs changed (spawn/despawn) — send IDs + names on change
let botIdsChanged = true;

console.log(`[BotWorker] Ready — ${botManager.bots.size} bots, world regenerated from seeds`);
parentPort.postMessage({ type: "ready", botCount: botManager.bots.size });

// ---- Message handler ----
parentPort.on("message", (msg) => {
  switch (msg.type) {
    case "tick-input": {
      const { dt, planetRotation, tick, nextProjectileId, players } = msg;

      // Build a Map from the player array (ServerBotManager expects Map)
      const playerMap = new Map();
      for (const p of players) {
        playerMap.set(p.id, p);
      }

      // Update capture state if included (every 50 ticks)
      if (msg.captureState) {
        clusterCaptureState.clear();
        for (const [k, v] of msg.captureState) {
          clusterCaptureState.set(k, v);
        }
      }

      // Run full bot update — AI, physics, combat, terrain collision
      // In worker mode, projectiles are buffered internally instead of pushing to shared array
      const updatedNextId = botManager.update(
        dt, playerMap, [], planetRotation, tick, nextProjectileId
      );

      // Collect outputs
      const newProjectiles = botManager.drainProjectiles();
      const events = botManager.drainEvents();
      const botStates = botManager.getStatesForBroadcast();
      const positions = botManager.getPositionsFlat();

      const output = {
        type: "tick-output",
        tick,
        nextProjectileId: updatedNextId,
        botStates,
        // Transfer the Float32Array (zero-copy)
        positions: positions.slice(), // Copy since getPositionsFlat reuses buffer
        newProjectiles,
        events,
      };

      // Include bot IDs + names only on change (spawn/despawn)
      if (botIdsChanged) {
        output.botIds = botManager.getBotIds();
        output.botNames = botManager.getBotNames();
        botIdsChanged = false;
      }

      parentPort.postMessage(output);
      break;
    }

    case "apply-damage": {
      const { botId, damage, killerId, killerName } = msg;
      // Build a minimal "players" map with just the killer name for trash talk resolution
      const fakePlayers = new Map();
      if (killerId && killerName) {
        fakePlayers.set(killerId, { name: killerName });
      }
      botManager.applyDamage(botId, damage, killerId, fakePlayers);
      break;
    }

    case "human-join": {
      // Despawn a bot to maintain population balance
      botManager.onHumanJoin(msg.player);
      botIdsChanged = true;
      break;
    }

    case "human-leave": {
      botManager.onHumanLeave(msg.currentHumanCount);
      botIdsChanged = true;
      break;
    }

    case "request-full-states": {
      const fullStates = botManager.getFullStatesForWelcome();
      parentPort.postMessage({ type: "full-states", states: fullStates });
      break;
    }

    case "update-capture-state": {
      clusterCaptureState.clear();
      for (const [k, v] of msg.state) {
        clusterCaptureState.set(k, v);
      }
      break;
    }

    case "update-cluster-data": {
      // Main thread sends post-sponsor cluster grids and data.
      // Without this, all tiles map to background cluster 0 because the worker
      // regenerates the world from seeds without sponsor cluster assignments.
      if (msg.clusterGrid) {
        worldGen._clusterGrid = new Int16Array(msg.clusterGrid);
      }
      if (msg.blockedGrid) {
        worldGen._blockedGrid = new Uint8Array(msg.blockedGrid);
      }
      if (msg.tileClusterMap) {
        worldGen.tileClusterMap.clear();
        for (const [tileIdx, clusterId] of msg.tileClusterMap) {
          worldGen.tileClusterMap.set(tileIdx, clusterId);
        }
      }
      if (msg.clusterData) {
        worldGen.clusterData = msg.clusterData;
      }
      // Rebuild coordinator cluster centers with new sponsor clusters
      for (const coord of Object.values(botManager.coordinators)) {
        coord._clusterCenters.clear();
        worldGen.clusterData.forEach((cluster) => {
          coord._clusterCenters.set(cluster.id, coord._computeClusterCenter(cluster));
        });
      }
      // Rebuild pathfinder cluster center tiles
      if (botManager.pathfinder && botManager.pathfinder._clusterCenterTiles) {
        botManager.pathfinder._clusterCenterTiles.clear();
        for (const cluster of worldGen.clusterData) {
          botManager.pathfinder._clusterCenterTiles.set(
            cluster.id,
            botManager.pathfinder._findClusterCenterTile(cluster),
          );
        }
      }
      console.log(`[BotWorker] Updated cluster data — ${worldGen.clusterData.length} clusters`);
      break;
    }

    case "shutdown": {
      process.exit(0);
      break;
    }
  }
});
