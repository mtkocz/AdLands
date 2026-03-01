/**
 * AdLands - Server Faction Coordinator
 * CommonJS port of FactionCoordinator from js/tank/BotTanks.js.
 * Handles strategic target assignment per faction — calculates cluster
 * priorities and assigns bots to high-value targets every 2 seconds.
 *
 * Dependencies: WorldGenerator (clusterData, tileCenters, clusterCaptureState ref)
 *               ServerBotPathfinder
 */

const BOT_STATES = {
  IDLE: "idle",
  MOVING: "moving",
  CAPTURING: "capturing",
  WANDERING: "wandering",
};

class ServerFactionCoordinator {
  static BOT_POLE_SOFT_LIMIT = 0.5;

  /**
   * @param {Object} worldGen - WorldGenerator instance
   * @param {Map} clusterCaptureState - Reference to GameRoom's capture state map
   * @param {string} faction - "rust" | "cobalt" | "viridian"
   */
  constructor(worldGen, clusterCaptureState, faction) {
    this.worldGen = worldGen;
    this.clusterCaptureState = clusterCaptureState;
    this.faction = faction;
    this.assignedBots = new Map();
    this.targetPriorities = [];
    this.updateInterval = 5000;
    this.lastUpdate = 0;
    this.pathfinder = null;

    this._clusterCenters = new Map();
    this.worldGen.clusterData.forEach((cluster) => {
      this._clusterCenters.set(cluster.id, this._computeClusterCenter(cluster));
    });
  }

  setPathfinder(pathfinder) {
    this.pathfinder = pathfinder;
  }

  _computeClusterCenter(cluster) {
    if (!cluster || cluster.tiles.length === 0) return null;

    let sumX = 0, sumY = 0, sumZ = 0, count = 0;
    const tileCenters = this.worldGen.tileCenters;

    cluster.tiles.forEach((tileIdx) => {
      const tile = tileCenters[tileIdx];
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

    this.worldGen.clusterData.forEach((cluster) => {
      const state = this.clusterCaptureState.get(cluster.id);
      if (!state) return;

      const clusterCenter = this._clusterCenters.get(cluster.id);
      if (!this._isClusterReachable(clusterCenter, cluster.id)) return;

      let priority = 0;
      const tileCount = cluster.tiles.length;
      const capacity = state.capacity;
      const myTics = state.tics[this.faction];
      const totalTics =
        state.tics.rust + state.tics.cobalt + state.tics.viridian;

      if (!state.owner && totalTics === 0) {
        priority += 100;
      } else if (!state.owner && myTics > 0) {
        priority += 80 + (myTics / capacity) * 20;
      } else if (!state.owner && totalTics > 0 && myTics === 0) {
        priority += 70;
      } else if (state.owner && state.owner !== this.faction) {
        priority += 50 + (myTics > 0 ? 20 : 0);
      } else if (state.owner === this.faction) {
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
        const state = this.clusterCaptureState.get(b.currentClusterId);
        if (state && state.owner === this.faction) return false;
      }
      return true;
    });

    const numTargets = Math.min(14, Math.ceil(availableBots.length / 3));
    let assignedCount = 0;

    for (
      let i = 0;
      i < Math.min(numTargets, this.targetPriorities.length);
      i++
    ) {
      const target = this.targetPriorities[i];
      if (assignedCount >= availableBots.length) break;

      const botsNeeded = Math.min(
        Math.max(2, Math.ceil(target.tileCount / 20) + 1),
        Math.ceil(availableBots.length / numTargets),
        8,
      );

      this.assignedBots.set(target.clusterId, new Set());
      const clusterCenter = this._clusterCenters.get(target.clusterId);
      if (!clusterCenter) continue;

      const unassigned = availableBots.filter(
        (b) => b.targetClusterId === null || b.targetClusterId === undefined,
      );

      const candidateCount = Math.min(unassigned.length, botsNeeded * 3);

      let candidates = unassigned
        .map((b) => ({ bot: b, dist: this._sphereDistance(b, clusterCenter) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, candidateCount);

      // Use sphere distance only — pathfinding is too expensive for 300 bots

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
    if (
      phi <= ServerFactionCoordinator.BOT_POLE_SOFT_LIMIT ||
      phi >= Math.PI - ServerFactionCoordinator.BOT_POLE_SOFT_LIMIT
    ) {
      return false;
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

module.exports = ServerFactionCoordinator;
