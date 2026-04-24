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
  static BOT_POLE_SOFT_LIMIT = 0.6;
  static TARGET_SLOTS_PER_CLUSTER = 8;

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
    this._clusterPressure = new Map();
    this._clusterCenters = new Map();
    this._clusterSlots = new Map();
    this.rebuildClusterCaches();
  }

  rebuildClusterCaches() {
    this._clusterCenters.clear();
    this._clusterSlots.clear();
    this.worldGen.clusterData.forEach((cluster) => {
      const center = this._computeClusterCenter(cluster);
      this._clusterCenters.set(cluster.id, center);
      this._clusterSlots.set(cluster.id, this._computeClusterSlots(cluster, center));
    });
  }

  setPathfinder(pathfinder) {
    this.pathfinder = pathfinder;
    this.rebuildClusterCaches();
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

    this._updateClusterPressure(factionBots);
    this._calculatePriorities(factionBots, allCoordinators);
    this._assignBots(factionBots);
  }

  _updateClusterPressure(factionBots) {
    this._clusterPressure.clear();

    for (let i = 0; i < factionBots.length; i++) {
      const bot = factionBots[i];
      if (!bot || bot.isDead || bot.isDeploying) continue;

      if (bot.currentClusterId !== null && bot.currentClusterId !== undefined) {
        const current = this._getPressure(bot.currentClusterId);
        current.present++;
      }

      if (bot.targetClusterId !== null && bot.targetClusterId !== undefined) {
        const target = this._getPressure(bot.targetClusterId);
        target.inbound++;
      }
    }
  }

  _getPressure(clusterId) {
    let pressure = this._clusterPressure.get(clusterId);
    if (!pressure) {
      pressure = { present: 0, inbound: 0 };
      this._clusterPressure.set(clusterId, pressure);
    }
    return pressure;
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

      const friendlyPressure = this._clusterPressure.get(cluster.id);
      if (friendlyPressure) {
        priority -= friendlyPressure.present * 5;
        priority -= friendlyPressure.inbound * 7;
      }

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

    const numTargets = Math.min(28, Math.ceil(availableBots.length / 3));
    let assignedCount = 0;
    const assignedIds = new Set();
    const reservedSlots = new Map();
    for (const bot of availableBots) {
      if (
        bot.targetClusterId !== null &&
        bot.targetClusterId !== undefined &&
        bot.targetSlotIndex !== null &&
        bot.targetSlotIndex !== undefined
      ) {
        let reserved = reservedSlots.get(bot.targetClusterId);
        if (!reserved) {
          reserved = new Set();
          reservedSlots.set(bot.targetClusterId, reserved);
        }
        reserved.add(bot.targetSlotIndex);
      }
    }

    for (
      let i = 0;
      i < Math.min(numTargets, this.targetPriorities.length);
      i++
    ) {
      const target = this.targetPriorities[i];
      if (assignedCount >= availableBots.length) break;

      const clusterPressure = this._clusterPressure.get(target.clusterId);
      const alreadyCommitted =
        (clusterPressure ? clusterPressure.present + clusterPressure.inbound : 0);
      const slotCount = this._getClusterSlots(target.clusterId).length || 1;
      const desiredBots = Math.min(
        Math.max(2, Math.ceil(target.tileCount / 20) + 1),
        Math.ceil(availableBots.length / numTargets),
        5,
      );
      const botsNeeded = Math.max(0, Math.min(desiredBots, slotCount - alreadyCommitted));
      if (botsNeeded <= 0) continue;

      this.assignedBots.set(target.clusterId, new Set());
      const clusterCenter = this._clusterCenters.get(target.clusterId);
      if (!clusterCenter) continue;

      const unassigned = availableBots.filter(
        (b) =>
          !assignedIds.has(b.id) &&
          (b.targetClusterId === null || b.targetClusterId === undefined),
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
          const slot = this._reserveTargetSlot(target.clusterId, bot, reservedSlots);
          const targetPosition = slot || clusterCenter;
          bot.targetClusterId = target.clusterId;
          bot.targetPosition = {
            theta: targetPosition.theta,
            phi: targetPosition.phi,
          };
          bot.targetTileIndex = targetPosition.tileIndex ?? null;
          bot.targetSlotIndex = targetPosition.slotIndex ?? null;
          this.assignedBots.get(target.clusterId).add(bot);
          this._getPressure(target.clusterId).inbound++;
          assignedIds.add(bot.id);
          assignedCount++;
        });
    }
  }

  _computeClusterSlots(cluster, center) {
    if (!cluster || !center || !cluster.tiles.length) return [];

    const slots = [];
    const tileCenters = this.worldGen.tileCenters;

    for (let i = 0; i < cluster.tiles.length; i++) {
      const tileIndex = cluster.tiles[i];
      if (this.pathfinder && !this.pathfinder.getTileSpherical(tileIndex)) continue;

      const tile = tileCenters[tileIndex];
      if (!tile) continue;

      const sp = this._tilePositionToSpherical(tile.position);
      if (!this._isClusterReachable(sp, cluster.id)) continue;
      if (this.worldGen.isTerrainBlocked(sp.theta, sp.phi)) continue;

      let dTheta = sp.theta - center.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = sp.phi - center.phi;
      const dist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
      const angle = Math.atan2(dPhi, dTheta);

      slots.push({
        theta: sp.theta,
        phi: sp.phi,
        tileIndex,
        dist,
        angle,
      });
    }

    if (slots.length === 0) return [];

    slots.sort((a, b) => b.dist - a.dist);
    const selected = [];
    const minAngle = (Math.PI * 2) / ServerFactionCoordinator.TARGET_SLOTS_PER_CLUSTER;

    for (const slot of slots) {
      if (selected.length >= ServerFactionCoordinator.TARGET_SLOTS_PER_CLUSTER) break;
      let tooClose = false;
      for (const existing of selected) {
        let angleDiff = Math.abs(slot.angle - existing.angle);
        if (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;
        if (angleDiff < minAngle * 0.55) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) selected.push(slot);
    }

    for (const slot of slots) {
      if (selected.length >= ServerFactionCoordinator.TARGET_SLOTS_PER_CLUSTER) break;
      if (!selected.includes(slot)) selected.push(slot);
    }

    selected.sort((a, b) => a.angle - b.angle);
    return selected.map((slot, slotIndex) => ({ ...slot, slotIndex }));
  }

  _tilePositionToSpherical(pos) {
    const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
    return {
      phi: Math.acos(Math.max(-1, Math.min(1, pos.y / r))),
      theta: Math.atan2(pos.z, pos.x),
    };
  }

  _getClusterSlots(clusterId) {
    return this._clusterSlots.get(clusterId) || [];
  }

  _reserveTargetSlot(clusterId, bot, reservedSlots) {
    const slots = this._getClusterSlots(clusterId);
    if (slots.length === 0) return null;

    let reserved = reservedSlots.get(clusterId);
    if (!reserved) {
      reserved = new Set();
      reservedSlots.set(clusterId, reserved);
    }

    let bestSlot = null;
    let bestScore = Infinity;

    for (const slot of slots) {
      if (reserved.has(slot.slotIndex)) continue;
      const score = this._sphereDistance(bot, slot);
      if (score < bestScore) {
        bestScore = score;
        bestSlot = slot;
      }
    }

    if (!bestSlot) {
      bestSlot = slots[(reserved.size + Math.floor(Math.random() * slots.length)) % slots.length];
    }

    reserved.add(bestSlot.slotIndex);
    return bestSlot;
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
        const pressure = coordinator._clusterPressure.get(clusterId);
        if (pressure) count += pressure.present + pressure.inbound;
      }
    }
    return count;
  }

  getClusterCenter(clusterId) {
    return this._clusterCenters.get(clusterId);
  }
}

module.exports = ServerFactionCoordinator;
