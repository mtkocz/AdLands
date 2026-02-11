/**
 * AdLands - Bot Pathfinder
 * Tile-level A* pathfinding on the hexasphere navigation graph.
 * Builds a traversable-tile adjacency structure excluding elevated and polar tiles,
 * then provides A* path queries with clearance-weighted edges.
 *
 * Dependencies: Planet (for adjacency map, tile centers, terrain elevation)
 */

class BotPathfinder {
  constructor(planet) {
    this.planet = planet;
    this._navAdjacency = new Map(); // tileIndex → [{tile, cost}, ...]
    this._traversable = new Set();
    this._tileSpherical = new Map(); // tileIndex → {theta, phi} (cached)
    this._clusterCenterTiles = new Map(); // clusterId → tileIndex (cached)

    this._buildNavGraph();
  }

  // ========================
  // GRAPH CONSTRUCTION
  // ========================

  _buildNavGraph() {
    const planet = this.planet;
    const adjacencyMap = planet._adjacencyMap;
    const elevatedSet = planet.terrainElevation
      ? planet.terrainElevation.elevatedTileSet
      : new Set();
    const polarSet = planet.polarTileIndices || new Set();

    // Build traversable tile set
    for (let i = 0; i < planet.tileCenters.length; i++) {
      if (!elevatedSet.has(i) && !polarSet.has(i)) {
        this._traversable.add(i);
      }
    }

    // Pre-compute cliff-adjacent set (tiles neighboring elevated terrain)
    // Single pass replaces the O(n·m²) nested loop with O(n·m) + O(1) lookups
    const cliffAdjacentSet = new Set();
    for (const tileIdx of this._traversable) {
      const neighbors = adjacencyMap.get(tileIdx) || [];
      for (const n of neighbors) {
        if (elevatedSet.has(n)) {
          cliffAdjacentSet.add(tileIdx);
          break;
        }
      }
    }

    // Build adjacency with clearance-weighted edges
    let edgeCount = 0;
    for (const tileIdx of this._traversable) {
      const neighbors = adjacencyMap.get(tileIdx) || [];
      const edges = [];

      for (const neighborIdx of neighbors) {
        if (!this._traversable.has(neighborIdx)) continue;
        const cost = cliffAdjacentSet.has(neighborIdx) ? 1.5 : 1.0;
        edges.push({ tile: neighborIdx, cost });
        edgeCount++;
      }

      this._navAdjacency.set(tileIdx, edges);
    }

    // Pre-compute spherical coords for all traversable tiles
    for (const tileIdx of this._traversable) {
      const pos = planet.tileCenters[tileIdx].position;
      const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
      if (r < 0.001) continue;
      const phi = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
      const theta = Math.atan2(pos.z, pos.x);
      this._tileSpherical.set(tileIdx, { theta, phi });
    }

    // Pre-compute cluster center tiles
    if (planet.clusterData) {
      for (const cluster of planet.clusterData) {
        this._clusterCenterTiles.set(
          cluster.id,
          this._findClusterCenterTile(cluster),
        );
      }
    }

    console.log(
      `[BotPathfinder] ${this._traversable.size} traversable tiles, ${edgeCount} edges`,
    );
  }

  _findClusterCenterTile(cluster) {
    // Find the traversable tile in the cluster closest to the geometric center
    const planet = this.planet;
    let sumX = 0,
      sumY = 0,
      sumZ = 0,
      count = 0;

    for (const tileIdx of cluster.tiles) {
      const tile = planet.tileCenters[tileIdx];
      if (tile) {
        sumX += tile.position.x;
        sumY += tile.position.y;
        sumZ += tile.position.z;
        count++;
      }
    }

    if (count === 0) return cluster.tiles[0];

    const cx = sumX / count;
    const cy = sumY / count;
    const cz = sumZ / count;

    let bestTile = -1;
    let bestDist = Infinity;

    for (const tileIdx of cluster.tiles) {
      if (!this._traversable.has(tileIdx)) continue;
      const pos = planet.tileCenters[tileIdx].position;
      const dx = pos.x - cx;
      const dy = pos.y - cy;
      const dz = pos.z - cz;
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestTile = tileIdx;
      }
    }

    // Fallback: if no traversable tile in cluster, find nearest traversable
    if (bestTile === -1 && cluster.tiles.length > 0) {
      const refPos = planet.tileCenters[cluster.tiles[0]].position;
      bestTile = this._nearestTraversableTileFromPos(refPos);
    }

    return bestTile;
  }

  // ========================
  // A* PATHFINDING
  // ========================

  findPath(fromTileIndex, toTileIndex) {
    if (fromTileIndex === toTileIndex) return [fromTileIndex];
    if (
      !this._traversable.has(fromTileIndex) ||
      !this._traversable.has(toTileIndex)
    ) {
      return null;
    }

    const planet = this.planet;
    const goalPos = planet.tileCenters[toTileIndex].position;

    // A* with binary heap
    const gScore = new Map();
    const fScore = new Map();
    const cameFrom = new Map();
    const closed = new Set();

    gScore.set(fromTileIndex, 0);
    fScore.set(fromTileIndex, this._heuristic(fromTileIndex, goalPos));

    // Simple min-heap using array (sufficient for ~2300 nodes)
    const open = [fromTileIndex];
    const inOpen = new Set([fromTileIndex]);

    while (open.length > 0) {
      // Find node with lowest fScore in open set
      let bestIdx = 0;
      let bestF = fScore.get(open[0]) || Infinity;
      for (let i = 1; i < open.length; i++) {
        const f = fScore.get(open[i]) || Infinity;
        if (f < bestF) {
          bestF = f;
          bestIdx = i;
        }
      }

      const current = open[bestIdx];

      // Goal reached
      if (current === toTileIndex) {
        return this._reconstructPath(cameFrom, current);
      }

      // Remove from open, add to closed
      open[bestIdx] = open[open.length - 1];
      open.pop();
      inOpen.delete(current);
      closed.add(current);

      const currentG = gScore.get(current) || Infinity;
      const edges = this._navAdjacency.get(current) || [];

      for (const edge of edges) {
        if (closed.has(edge.tile)) continue;

        const tentativeG = currentG + edge.cost;
        const existingG = gScore.get(edge.tile);

        if (existingG === undefined || tentativeG < existingG) {
          cameFrom.set(edge.tile, current);
          gScore.set(edge.tile, tentativeG);
          fScore.set(
            edge.tile,
            tentativeG + this._heuristic(edge.tile, goalPos),
          );

          if (!inOpen.has(edge.tile)) {
            open.push(edge.tile);
            inOpen.add(edge.tile);
          }
        }
      }
    }

    return null; // No path
  }

  _heuristic(tileIndex, goalPos) {
    // Euclidean distance (admissible on sphere — always <= actual surface distance)
    const pos = this.planet.tileCenters[tileIndex].position;
    const dx = pos.x - goalPos.x;
    const dy = pos.y - goalPos.y;
    const dz = pos.z - goalPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  _reconstructPath(cameFrom, current) {
    const path = [current];
    while (cameFrom.has(current)) {
      current = cameFrom.get(current);
      path.push(current);
    }
    path.reverse();
    return path;
  }

  // ========================
  // PATH TO WAYPOINTS
  // ========================

  pathToWaypoints(tilePathArray) {
    if (!tilePathArray || tilePathArray.length === 0) return [];
    if (tilePathArray.length === 1) {
      const sp = this._tileSpherical.get(tilePathArray[0]);
      return sp ? [{ theta: sp.theta, phi: sp.phi }] : [];
    }

    // Always include start and end
    const waypoints = [];
    const startSp = this._tileSpherical.get(tilePathArray[0]);
    if (startSp) waypoints.push({ theta: startSp.theta, phi: startSp.phi });

    // Walk path, keep waypoints where direction changes significantly (>15 degrees)
    const DIR_THRESHOLD = (15 * Math.PI) / 180; // 15 degrees in radians
    let prevDir = null;

    for (let i = 1; i < tilePathArray.length - 1; i++) {
      const prev = this._tileSpherical.get(tilePathArray[i - 1]);
      const curr = this._tileSpherical.get(tilePathArray[i]);
      const next = this._tileSpherical.get(tilePathArray[i + 1]);

      if (!prev || !curr || !next) continue;

      // Direction from prev to curr
      const dir1 = Math.atan2(curr.phi - prev.phi, curr.theta - prev.theta);
      // Direction from curr to next
      const dir2 = Math.atan2(next.phi - curr.phi, next.theta - curr.theta);

      let angleDiff = Math.abs(dir2 - dir1);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;

      if (angleDiff > DIR_THRESHOLD) {
        waypoints.push({ theta: curr.theta, phi: curr.phi });
      }
    }

    // Always include end
    const endSp = this._tileSpherical.get(
      tilePathArray[tilePathArray.length - 1],
    );
    if (endSp) waypoints.push({ theta: endSp.theta, phi: endSp.phi });

    return waypoints;
  }

  // ========================
  // PATH DISTANCE (for FactionCoordinator)
  // ========================

  getPathDistance(fromTileIndex, toTileIndex) {
    const path = this.findPath(fromTileIndex, toTileIndex);
    if (!path) return Infinity;
    return path.length;
  }

  // ========================
  // TILE LOOKUPS
  // ========================

  getNearestTraversableTile(theta, phi) {
    // Convert spherical to Cartesian for distance comparison
    const r = this.planet.radius || 480;
    const sinPhi = Math.sin(phi);
    const x = r * sinPhi * Math.cos(theta);
    const y = r * Math.cos(phi);
    const z = r * sinPhi * Math.sin(theta);

    return this._nearestTraversableTileFromXYZ(x, y, z);
  }

  _nearestTraversableTileFromPos(pos) {
    return this._nearestTraversableTileFromXYZ(pos.x, pos.y, pos.z);
  }

  _nearestTraversableTileFromXYZ(x, y, z) {
    let bestTile = -1;
    let bestDist = Infinity;

    for (const tileIdx of this._traversable) {
      const pos = this.planet.tileCenters[tileIdx].position;
      const dx = pos.x - x;
      const dy = pos.y - y;
      const dz = pos.z - z;
      const dist = dx * dx + dy * dy + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        bestTile = tileIdx;
      }
    }

    return bestTile;
  }

  getClusterCenterTile(clusterId) {
    return this._clusterCenterTiles.get(clusterId) ?? -1;
  }

  getTileSpherical(tileIndex) {
    return this._tileSpherical.get(tileIndex) || null;
  }
}
