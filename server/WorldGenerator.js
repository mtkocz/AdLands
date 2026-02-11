/**
 * AdLands - Server-side World Generator
 * Ports cluster generation from Planet.js to Node.js.
 * Produces identical output to the client when given the same seed.
 */

const Hexasphere = require("./shared/hexasphere");
const Vec3 = require("./shared/Vec3");

// Same pattern array as Planet.js — needed so RNG advances identically
const PATTERNS = [
  "stripes_h", "stripes_v", "stripes_d1", "stripes_d2",
  "dots", "dots_sparse", "checkerboard", "crosshatch",
  "grid", "waves", "zigzag", "diamonds", "triangles", "circles",
];

class WorldGenerator {
  constructor(radius, subdivisions, seed = 42) {
    this.radius = radius;
    this.subdivisions = subdivisions;
    this.random = this._createSeededRandom(seed);

    // Output data
    this.tileCenters = [];         // { position: Vec3, tileIndex }
    this.tileClusterMap = new Map(); // tileIndex → clusterId
    this.clusterData = [];         // { id, tiles: [] }
    this.clusterColors = new Map();
    this.clusterPatterns = new Map();
    this.portalCenterIndices = new Set();
    this.portalTileIndices = new Set();
    this.polarTileIndices = new Set();
    this.adjacencyMap = null;
    this.tiles = null;

    // Spatial hash for fast position→tile lookups
    this._spatialGrid = null;
    this._GRID_PHI = 32;
    this._GRID_THETA = 64;
  }

  // ========================
  // SEEDED RNG (same LCG as Planet.js)
  // ========================

  _createSeededRandom(seed) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  // ========================
  // GENERATE
  // ========================

  generate() {
    const hexasphere = new Hexasphere(this.radius, this.subdivisions, 1.0);

    this.tiles = hexasphere.tiles;
    this._storeTileCenters(hexasphere.tiles);
    this._markPortalTiles(hexasphere.tiles);
    this.adjacencyMap = this._generateClusters(hexasphere.tiles);
    this._buildSpatialHash();

    const clusterCount = this.clusterData.length;
    const portalCount = this.portalTileIndices.size;
    const polarCount = this.polarTileIndices.size;
    console.log(
      `[WorldGenerator] ${hexasphere.tiles.length} tiles | ` +
      `${clusterCount} clusters | ${portalCount} portal tiles | ${polarCount} polar tiles`
    );

    return {
      tiles: hexasphere.tiles,
      tileCenters: this.tileCenters,
      adjacencyMap: this.adjacencyMap,
      tileClusterMap: this.tileClusterMap,
      clusterData: this.clusterData,
      clusterColors: this.clusterColors,
      clusterPatterns: this.clusterPatterns,
      portalCenterIndices: this.portalCenterIndices,
      portalTileIndices: this.portalTileIndices,
      polarTileIndices: this.polarTileIndices,
    };
  }

  // ========================
  // TILE CENTERS
  // ========================

  _storeTileCenters(tiles) {
    tiles.forEach((tile, index) => {
      const cp = tile.centerPoint;
      this.tileCenters.push({
        position: new Vec3(
          parseFloat(cp.x),
          parseFloat(cp.y),
          parseFloat(cp.z)
        ),
        tileIndex: index,
      });
    });
  }

  // ========================
  // PORTAL & POLAR DETECTION
  // ========================

  _markPortalTiles(tiles) {
    tiles.forEach((tile, index) => {
      if (tile.boundary.length === 5) {
        this.portalCenterIndices.add(index);
        this.portalTileIndices.add(index);
      }
    });
  }

  _expandPortalBorders(adjacencyMap) {
    const portalBorders = new Set();
    for (const portalIndex of this.portalTileIndices) {
      const neighbors = adjacencyMap.get(portalIndex) || [];
      for (const neighborIndex of neighbors) {
        if (!this.portalTileIndices.has(neighborIndex)) {
          portalBorders.add(neighborIndex);
        }
      }
    }
    for (const borderIndex of portalBorders) {
      this.portalTileIndices.add(borderIndex);
    }
  }

  _isPolarTile(tile, radius) {
    const y = parseFloat(tile.centerPoint.y);
    const phi = Math.acos(y / radius);
    const polarThreshold = (10 * Math.PI) / 180;
    return phi < polarThreshold || phi > Math.PI - polarThreshold;
  }

  // ========================
  // ADJACENCY MAP
  // ========================

  _buildAdjacencyMap(tiles) {
    const adjacencyMap = new Map();
    const vertexToTiles = new Map();

    tiles.forEach((tile, idx) => {
      adjacencyMap.set(idx, []);
      tile.boundary.forEach((v) => {
        const key = `${v.x},${v.y},${v.z}`;
        if (!vertexToTiles.has(key)) vertexToTiles.set(key, []);
        vertexToTiles.get(key).push(idx);
      });
    });

    tiles.forEach((tile, idx) => {
      const neighbors = new Set();
      tile.boundary.forEach((v) => {
        const key = `${v.x},${v.y},${v.z}`;
        (vertexToTiles.get(key) || []).forEach((other) => {
          if (other !== idx) neighbors.add(other);
        });
      });
      adjacencyMap.set(idx, Array.from(neighbors));
    });

    return adjacencyMap;
  }

  // ========================
  // CLUSTER GENERATION
  // ========================

  _generateClusters(tiles) {
    const numTiles = tiles.length;
    const assigned = new Array(numTiles).fill(false);
    const adjacencyMap = this._buildAdjacencyMap(tiles);

    this._expandPortalBorders(adjacencyMap);

    // Mark polar tiles
    let polarCount = 0;
    for (let i = 0; i < numTiles; i++) {
      if (this._isPolarTile(tiles[i], this.radius)) {
        assigned[i] = true;
        this.polarTileIndices.add(i);
        polarCount++;
      }
    }

    // Mark portal tiles as neutral
    let portalCount = 0;
    for (const portalIndex of this.portalTileIndices) {
      if (!assigned[portalIndex]) {
        assigned[portalIndex] = true;
        portalCount++;
      }
    }

    // No sponsor tiles on server (sponsorCount = 0)
    const sponsorCount = 0;

    // Plan cluster sizes
    const clusterSizes = [];
    let remaining = numTiles - polarCount - portalCount - sponsorCount;
    console.log(
      `[WorldGenerator] Total tiles: ${numTiles} | Polar: ${polarCount} | ` +
      `Portal+neutral: ${portalCount} | Sponsor: ${sponsorCount} | RENTABLE: ${remaining - sponsorCount}`
    );
    const maxSize = 100;

    while (remaining > 0) {
      const rand = this.random();
      let size;
      if (rand < 0.3) size = Math.floor(this.random() * 5) + 1;
      else if (rand < 0.6) size = Math.floor(this.random() * 10) + 6;
      else if (rand < 0.85) size = Math.floor(this.random() * 25) + 16;
      else size = Math.floor(this.random() * 60) + 41;

      size = Math.min(size, maxSize, remaining);
      clusterSizes.push(size);
      remaining -= size;
    }

    // Grow clusters
    let clusterId = 0;
    let clusterIndex = 0;

    const getTileCenter = (idx) => {
      const cp = tiles[idx].centerPoint;
      return new Vec3(
        parseFloat(cp.x),
        parseFloat(cp.y),
        parseFloat(cp.z)
      );
    };

    for (let i = 0; i < numTiles && clusterIndex < clusterSizes.length; i++) {
      if (assigned[i]) continue;

      const targetSize = clusterSizes[clusterIndex];
      const clusterTiles = [];
      const frontier = new Map();
      const seedCenter = getTileCenter(i);

      assigned[i] = true;
      clusterTiles.push(i);
      this.tileClusterMap.set(i, clusterId);

      for (const neighbor of adjacencyMap.get(i) || []) {
        if (!assigned[neighbor]) {
          frontier.set(
            neighbor,
            getTileCenter(neighbor).distanceTo(seedCenter)
          );
        }
      }

      while (clusterTiles.length < targetSize && frontier.size > 0) {
        let closest = -1;
        let closestDist = Infinity;

        for (const [idx, dist] of frontier) {
          if (dist < closestDist) {
            closestDist = dist;
            closest = idx;
          }
        }

        if (closest === -1) break;

        frontier.delete(closest);
        if (assigned[closest]) continue;

        assigned[closest] = true;
        clusterTiles.push(closest);
        this.tileClusterMap.set(closest, clusterId);

        for (const neighbor of adjacencyMap.get(closest) || []) {
          if (!assigned[neighbor] && !frontier.has(neighbor)) {
            frontier.set(
              neighbor,
              getTileCenter(neighbor).distanceTo(seedCenter)
            );
          }
        }
      }

      this.clusterData.push({ id: clusterId, tiles: clusterTiles });

      // Advance RNG identically to Planet.js (color, pattern, roughness, metalness)
      const gray = Math.floor(102 + this.random() * 26);
      this.clusterColors.set(clusterId, (gray << 16) | (gray << 8) | gray);

      const patternIdx = Math.floor(this.random() * PATTERNS.length);
      const roughness = 0.5 + this.random() * 0.5;
      const metalness = this.random() * 0.3;
      this.clusterPatterns.set(clusterId, {
        type: PATTERNS[patternIdx],
        grayValue: gray,
        roughness,
        metalness,
      });

      clusterId++;
      clusterIndex++;
    }

    // Assign remaining unassigned tiles
    for (let i = 0; i < numTiles; i++) {
      if (assigned[i]) continue;

      for (const neighbor of adjacencyMap.get(i) || []) {
        if (assigned[neighbor]) {
          const cid = this.tileClusterMap.get(neighbor);
          if (cid === undefined) continue;
          this.tileClusterMap.set(i, cid);
          this.clusterData[cid].tiles.push(i);
          assigned[i] = true;
          break;
        }
      }

      if (!assigned[i]) {
        this.tileClusterMap.set(i, clusterId);
        this.clusterData.push({ id: clusterId, tiles: [i] });
        clusterId++;
      }
    }

    return adjacencyMap;
  }

  // ========================
  // SPATIAL HASH (for position → tile lookups)
  // ========================

  _buildSpatialHash() {
    this._spatialGrid = new Map();

    for (let i = 0; i < this.tileCenters.length; i++) {
      const tc = this.tileCenters[i];
      const pos = tc.position;
      const r = pos.length();
      if (r < 0.001) continue;

      const phi = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
      const theta = Math.atan2(pos.z, pos.x) + Math.PI;

      const phiCell = Math.min(
        this._GRID_PHI - 1,
        Math.floor((phi / Math.PI) * this._GRID_PHI)
      );
      const thetaCell = Math.min(
        this._GRID_THETA - 1,
        Math.floor((theta / (Math.PI * 2)) * this._GRID_THETA)
      );
      const key = phiCell * this._GRID_THETA + thetaCell;

      if (!this._spatialGrid.has(key)) {
        this._spatialGrid.set(key, []);
      }
      this._spatialGrid.get(key).push(i);
    }
  }

  /**
   * Find nearest tile index for a spherical position (theta, phi).
   * Returns { tileIndex, clusterId } or null.
   */
  getNearestTile(theta, phi) {
    if (!this._spatialGrid) return null;

    // Convert spherical (theta, phi) to Cartesian
    // Convention: theta = atan2(z, x), matching GameRoom portal coords and client Tank.js
    const sinPhi = Math.sin(phi);
    const pos = new Vec3(
      this.radius * sinPhi * Math.cos(theta),
      this.radius * Math.cos(phi),
      this.radius * sinPhi * Math.sin(theta)
    );

    const r = pos.length();
    if (r < 0.001) return null;

    const gridPhi = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
    const gridTheta = Math.atan2(pos.z, pos.x) + Math.PI;

    const phiCell = Math.min(
      this._GRID_PHI - 1,
      Math.floor((gridPhi / Math.PI) * this._GRID_PHI)
    );
    const thetaCell = Math.min(
      this._GRID_THETA - 1,
      Math.floor((gridTheta / (Math.PI * 2)) * this._GRID_THETA)
    );

    let closestArrayIdx = -1;
    let closestDist = Infinity;

    for (let dp = -1; dp <= 1; dp++) {
      const pc = phiCell + dp;
      if (pc < 0 || pc >= this._GRID_PHI) continue;
      for (let dt = -1; dt <= 1; dt++) {
        const tc = ((thetaCell + dt) % this._GRID_THETA + this._GRID_THETA) % this._GRID_THETA;
        const key = pc * this._GRID_THETA + tc;
        const entries = this._spatialGrid.get(key);
        if (!entries) continue;

        for (const arrayIdx of entries) {
          const tcEntry = this.tileCenters[arrayIdx];
          const dx = pos.x - tcEntry.position.x;
          const dy = pos.y - tcEntry.position.y;
          const dz = pos.z - tcEntry.position.z;
          const dist = dx * dx + dy * dy + dz * dz;
          if (dist < closestDist) {
            closestDist = dist;
            closestArrayIdx = arrayIdx;
          }
        }
      }
    }

    if (closestArrayIdx < 0) return null;

    const tileIndex = this.tileCenters[closestArrayIdx].tileIndex;
    const clusterId = this.tileClusterMap.get(tileIndex);
    return { tileIndex, clusterId: clusterId !== undefined ? clusterId : null };
  }
}

module.exports = WorldGenerator;
