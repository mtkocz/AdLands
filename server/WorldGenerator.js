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

    // Reusable result object for getNearestTile (avoids allocation per call)
    this._nearestResult = { tileIndex: -1, clusterId: null };
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
    this._buildPolarBoundaryPolygons();

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

    // Convert spherical (theta, phi) to Cartesian using scratch vector (zero allocation)
    const sinPhi = Math.sin(phi);
    const px = this.radius * sinPhi * Math.cos(theta);
    const py = this.radius * Math.cos(phi);
    const pz = this.radius * sinPhi * Math.sin(theta);

    const r = Math.sqrt(px * px + py * py + pz * pz);
    if (r < 0.001) return null;

    const gridPhi = Math.acos(Math.max(-1, Math.min(1, py / r)));
    const gridTheta = Math.atan2(pz, px) + Math.PI;

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
          const dx = px - tcEntry.position.x;
          const dy = py - tcEntry.position.y;
          const dz = pz - tcEntry.position.z;
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
    // Reuse result object to avoid allocation per call
    this._nearestResult.tileIndex = tileIndex;
    this._nearestResult.clusterId = clusterId !== undefined ? clusterId : null;
    return this._nearestResult;
  }

  // ========================
  // PRECOMPUTED TERRAIN BLOCKED GRID
  // ========================

  /**
   * Build a precomputed blocked-grid for fast terrain collision.
   * Resolution: 256 theta x 128 phi = 32KB Uint8Array.
   * Each cell stores 1 if blocked (elevated terrain or polar hole), 0 otherwise.
   * Must be called after generate() and terrain.generate().
   * @param {Object} terrain - TerrainElevation instance
   */
  buildBlockedGrid(terrain) {
    const GRID_T = 256;
    const GRID_P = 128;
    this._blockedGrid = new Uint8Array(GRID_T * GRID_P);
    this._BLOCKED_GRID_T = GRID_T;
    this._BLOCKED_GRID_P = GRID_P;

    for (let pt = 0; pt < GRID_T; pt++) {
      for (let pp = 0; pp < GRID_P; pp++) {
        const theta = (pt / GRID_T) * Math.PI * 2;
        const phi = (pp / GRID_P) * Math.PI;

        // Check polar hole
        if (this.isInsidePolarHole(theta, phi)) {
          this._blockedGrid[pp * GRID_T + pt] = 1;
          continue;
        }

        // Check terrain elevation
        const result = this.getNearestTile(theta, phi);
        if (result && terrain.getElevationAtTileIndex(result.tileIndex) > 0) {
          this._blockedGrid[pp * GRID_T + pt] = 1;
        }
      }
    }

    console.log(`[WorldGenerator] Built blocked grid (${GRID_T}x${GRID_P} = ${this._blockedGrid.length} bytes)`);
  }

  /**
   * O(1) terrain blocked check. Returns true if position is on elevated terrain or in a polar hole.
   * @param {number} theta - World-space theta (already includes planet rotation)
   * @param {number} phi
   * @returns {boolean}
   */
  isTerrainBlocked(theta, phi) {
    // Normalize theta to [0, 2PI]
    let t = theta % (Math.PI * 2);
    if (t < 0) t += Math.PI * 2;

    const ti = Math.min(this._BLOCKED_GRID_T - 1, (t / (Math.PI * 2) * this._BLOCKED_GRID_T) | 0);
    const pi = Math.min(this._BLOCKED_GRID_P - 1, (phi / Math.PI * this._BLOCKED_GRID_P) | 0);
    return this._blockedGrid[pi * this._BLOCKED_GRID_T + ti] === 1;
  }

  // ========================
  // POLAR BOUNDARY POLYGON (precise collision)
  // ========================

  /**
   * Find boundary edges between polar and non-polar tiles.
   * These are the actual hex edges at the rim of each pole opening.
   */
  _findPolarBoundaryEdges() {
    const tiles = this.tiles;
    const edges = [];
    const seenEdges = new Set();

    for (const tileIdx of this.polarTileIndices) {
      const neighbors = this.adjacencyMap.get(tileIdx) || [];
      for (const neighborIdx of neighbors) {
        if (this.polarTileIndices.has(neighborIdx)) continue;

        const polarBoundary = tiles[tileIdx].boundary;
        const neighborBoundary = tiles[neighborIdx].boundary;

        for (let i = 0; i < neighborBoundary.length; i++) {
          const nv1 = neighborBoundary[i];
          const nv2 = neighborBoundary[(i + 1) % neighborBoundary.length];
          const nk1 = `${nv1.x},${nv1.y},${nv1.z}`;
          const nk2 = `${nv2.x},${nv2.y},${nv2.z}`;

          for (let j = 0; j < polarBoundary.length; j++) {
            const pv1 = polarBoundary[j];
            const pv2 = polarBoundary[(j + 1) % polarBoundary.length];
            const pk1 = `${pv1.x},${pv1.y},${pv1.z}`;
            const pk2 = `${pv2.x},${pv2.y},${pv2.z}`;

            if (
              (nk1 === pk1 && nk2 === pk2) ||
              (nk1 === pk2 && nk2 === pk1)
            ) {
              const edgeKey =
                nk1 < nk2 ? `${nk1}|${nk2}` : `${nk2}|${nk1}`;
              if (!seenEdges.has(edgeKey)) {
                seenEdges.add(edgeKey);
                edges.push({
                  v1: {
                    x: parseFloat(nv1.x),
                    y: parseFloat(nv1.y),
                    z: parseFloat(nv1.z),
                  },
                  v2: {
                    x: parseFloat(nv2.x),
                    y: parseFloat(nv2.y),
                    z: parseFloat(nv2.z),
                  },
                });
              }
            }
          }
        }
      }
    }

    return edges;
  }

  /**
   * Build ordered 2D boundary polygons for each pole hole.
   */
  _buildPolarBoundaryPolygons() {
    const edges = this._findPolarBoundaryEdges();
    this._northPolePolygon = null;
    this._southPolePolygon = null;
    if (edges.length === 0) return;

    const northEdges = [];
    const southEdges = [];
    for (const edge of edges) {
      const midY = (edge.v1.y + edge.v2.y) / 2;
      if (midY > 0) northEdges.push(edge);
      else southEdges.push(edge);
    }

    this._northPolePolygon = this._chainEdgesToPolygon2D(northEdges);
    this._southPolePolygon = this._chainEdgesToPolygon2D(southEdges);
  }

  /**
   * Chain unordered edge segments into an ordered polygon vertex ring.
   * Projects to XZ plane for 2D point-in-polygon tests.
   */
  _chainEdgesToPolygon2D(edges) {
    if (edges.length === 0) return null;

    const keyOf = (v) =>
      `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    const adj = new Map();
    for (let i = 0; i < edges.length; i++) {
      const k1 = keyOf(edges[i].v1);
      const k2 = keyOf(edges[i].v2);
      if (!adj.has(k1)) adj.set(k1, []);
      if (!adj.has(k2)) adj.set(k2, []);
      adj.get(k1).push({ idx: i, key: k2, v: edges[i].v2 });
      adj.get(k2).push({ idx: i, key: k1, v: edges[i].v1 });
    }

    const used = new Set();
    const poly = [{ x: edges[0].v1.x, z: edges[0].v1.z }];
    used.add(0);
    let cur = keyOf(edges[0].v2);
    poly.push({ x: edges[0].v2.x, z: edges[0].v2.z });
    const startKey = keyOf(edges[0].v1);

    while (cur !== startKey) {
      const neighbors = adj.get(cur);
      if (!neighbors) break;
      let found = false;
      for (const n of neighbors) {
        if (!used.has(n.idx)) {
          used.add(n.idx);
          cur = n.key;
          poly.push({ x: n.v.x, z: n.v.z });
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    if (poly.length > 1) {
      const f = poly[0], l = poly[poly.length - 1];
      if (Math.abs(f.x - l.x) < 0.01 && Math.abs(f.z - l.z) < 0.01) {
        poly.pop();
      }
    }

    return poly;
  }

  /**
   * Test if a spherical position is inside a polar hole using actual hex boundary.
   * @param {number} theta - longitude in hexasphere local frame
   * @param {number} phi - colatitude (0 = north pole, PI = south pole)
   * @returns {boolean}
   */
  isInsidePolarHole(theta, phi) {
    // Quick rejection: only test near poles (20° threshold > actual ~14.5° boundary)
    const polarCheckRad = (20 * Math.PI) / 180;
    if (phi > polarCheckRad && phi < Math.PI - polarCheckRad) return false;

    const sinPhi = Math.sin(phi);
    const px = this.radius * sinPhi * Math.cos(theta);
    const py = this.radius * Math.cos(phi);
    const pz = this.radius * sinPhi * Math.sin(theta);

    if (py > 0 && this._northPolePolygon) {
      return this._pointInPolygon2D(px, pz, this._northPolePolygon);
    }
    if (py < 0 && this._southPolePolygon) {
      return this._pointInPolygon2D(px, pz, this._southPolePolygon);
    }
    return false;
  }

  /**
   * Ray-casting point-in-polygon test in 2D (XZ plane).
   */
  _pointInPolygon2D(px, pz, polygon) {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x, zi = polygon[i].z;
      const xj = polygon[j].x, zj = polygon[j].z;
      if (
        ((zi > pz) !== (zj > pz)) &&
        (px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi)
      ) {
        inside = !inside;
      }
    }
    return inside;
  }
}

module.exports = WorldGenerator;
