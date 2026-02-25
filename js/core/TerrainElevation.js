/**
 * AdLands - Terrain Elevation System
 * Procedurally generates raised hex plateaus with nested elevation levels.
 * Elevated terrain blocks tank movement and projectiles.
 *
 * Dependencies: THREE.js, Planet.js (for tile data and hexGroup)
 */

class TerrainElevation {
  constructor(planet, seed = 73) {
    this.planet = planet;

    // Seeded RNG (same LCG as Planet.js)
    this.random = this._createSeededRandom(seed);

    // Core data
    this.tileElevation = new Map();   // tileIndex → elevation level (0-3)
    this.elevatedTileSet = new Set(); // All tiles with elevation > 0
    this.elevationRegions = [];       // { id, level, tiles: Set, parentId }

    // Geometry
    this.cliffWallMesh = null;

    // Config
    this.config = {
      EXTRUSION_HEIGHT: 3.5,         // World units per elevation level
      COVERAGE_TARGET: 0.18,         // ~18% of eligible tiles (50% more terrain)
      PRIMARY_MIN_SIZE: 8,
      PRIMARY_MAX_SIZE: 30,
      SECONDARY_MIN_SIZE: 3,
      SECONDARY_MAX_SIZE: 12,
      SECONDARY_MIN_PARENT: 12,      // Parent must have >= N tiles for sub-regions
      TERTIARY_MIN_SIZE: 2,
      TERTIARY_MAX_SIZE: 6,
      TERTIARY_MIN_PARENT: 8,
      MIN_SEED_SPACING: 0.12,        // Radians between primary seeds
      CLIFF_BASE_COLOR: { r: 112 / 255, g: 112 / 255, b: 112 / 255 },
      CLIFF_COLOR_VARIATION: 0.08,
    };

    // Spatial hash for fast position→tile lookups
    this._spatialGrid = null;
    this._GRID_PHI = 32;
    this._GRID_THETA = 64;

    // Preallocated temp vectors (GC avoidance)
    this._temp = {
      testPos: new THREE.Vector3(),
      highA: new THREE.Vector3(),
      highB: new THREE.Vector3(),
      lowA: new THREE.Vector3(),
      lowB: new THREE.Vector3(),
      edgeDir: new THREE.Vector3(),
      midpoint: new THREE.Vector3(),
      radialDir: new THREE.Vector3(),
      wallNormal: new THREE.Vector3(),
      tileCenterDir: new THREE.Vector3(),
      apronA: new THREE.Vector3(),
      apronB: new THREE.Vector3(),
      groundNormal: new THREE.Vector3(),
    };
  }

  // ========================
  // SEEDED RNG
  // ========================

  _createSeededRandom(seed) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  // ========================
  // GENERATION
  // ========================

  generate(tiles, adjacencyMap, portalTileIndices, polarTileIndices) {
    const eligible = new Set();
    for (let i = 0; i < tiles.length; i++) {
      if (!portalTileIndices.has(i) && !polarTileIndices.has(i)) {
        eligible.add(i);
      }
    }

    const targetCount = Math.floor(eligible.size * this.config.COVERAGE_TARGET);
    let elevatedCount = 0;
    let regionId = 0;

    // Track seed positions for spacing enforcement
    const seedPositions = [];

    // Phase 1: Primary regions (level 1)
    let attempts = 0;
    const maxAttempts = 400;

    while (elevatedCount < targetCount && attempts < maxAttempts) {
      attempts++;

      // Pick random eligible, non-elevated tile
      const eligibleArr = Array.from(eligible).filter(
        (i) => !this.elevatedTileSet.has(i),
      );
      if (eligibleArr.length === 0) break;

      const seedIdx =
        eligibleArr[Math.floor(this.random() * eligibleArr.length)];

      // Check spacing from existing seeds
      const seedPos = this._getTileCenter(tiles, seedIdx);
      let tooClose = false;
      for (const existing of seedPositions) {
        const angDist = seedPos.angleTo(existing);
        if (angDist < this.config.MIN_SEED_SPACING) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      // Flood-fill to grow region
      const size =
        this.config.PRIMARY_MIN_SIZE +
        Math.floor(
          this.random() *
            (this.config.PRIMARY_MAX_SIZE - this.config.PRIMARY_MIN_SIZE + 1),
        );
      const region = this._floodFill(
        seedIdx,
        size,
        tiles,
        adjacencyMap,
        eligible,
        this.elevatedTileSet,
        null,
      );

      if (region.size < this.config.PRIMARY_MIN_SIZE) continue;

      // Mark tiles
      for (const idx of region) {
        this.tileElevation.set(idx, 1);
        this.elevatedTileSet.add(idx);
      }
      elevatedCount += region.size;
      seedPositions.push(seedPos);

      this.elevationRegions.push({
        id: regionId++,
        level: 1,
        tiles: region,
        parentId: null,
      });
    }

    // Phase 2: Secondary regions (level 2) within large primaries
    const primaryRegions = this.elevationRegions.filter((r) => r.level === 1);
    for (const parent of primaryRegions) {
      if (parent.tiles.size < this.config.SECONDARY_MIN_PARENT) continue;

      const numSub = 1 + Math.floor(this.random() * 2); // 1-2
      for (let s = 0; s < numSub; s++) {
        const parentArr = Array.from(parent.tiles);
        const subSeed =
          parentArr[Math.floor(this.random() * parentArr.length)];

        const subSize =
          this.config.SECONDARY_MIN_SIZE +
          Math.floor(
            this.random() *
              (this.config.SECONDARY_MAX_SIZE -
                this.config.SECONDARY_MIN_SIZE +
                1),
          );

        const subRegion = this._floodFill(
          subSeed,
          subSize,
          tiles,
          adjacencyMap,
          parent.tiles, // constrain to parent
          new Set(),    // no exclusion within parent
          null,
        );

        if (subRegion.size < this.config.SECONDARY_MIN_SIZE) continue;

        for (const idx of subRegion) {
          this.tileElevation.set(idx, 2);
        }

        this.elevationRegions.push({
          id: regionId++,
          level: 2,
          tiles: subRegion,
          parentId: parent.id,
        });
      }
    }

    // Phase 3: Tertiary regions (level 3) within large secondaries
    const secondaryRegions = this.elevationRegions.filter(
      (r) => r.level === 2,
    );
    for (const parent of secondaryRegions) {
      if (parent.tiles.size < this.config.TERTIARY_MIN_PARENT) continue;

      const parentArr = Array.from(parent.tiles);
      const subSeed = parentArr[Math.floor(this.random() * parentArr.length)];

      const subSize =
        this.config.TERTIARY_MIN_SIZE +
        Math.floor(
          this.random() *
            (this.config.TERTIARY_MAX_SIZE -
              this.config.TERTIARY_MIN_SIZE +
              1),
        );

      const subRegion = this._floodFill(
        subSeed,
        subSize,
        tiles,
        adjacencyMap,
        parent.tiles,
        new Set(),
        null,
      );

      if (subRegion.size < this.config.TERTIARY_MIN_SIZE) continue;

      for (const idx of subRegion) {
        this.tileElevation.set(idx, 3);
      }

      this.elevationRegions.push({
        id: regionId++,
        level: 3,
        tiles: subRegion,
        parentId: parent.id,
      });
    }

    // Validate ground connectivity
    this._validateGroundConnectivity(tiles, adjacencyMap);

    // Build spatial hash for runtime position lookups
    this._buildSpatialHash();

  }

  // ========================
  // FLOOD FILL
  // ========================

  _floodFill(
    seedIdx,
    targetSize,
    tiles,
    adjacencyMap,
    allowedTiles,
    excludedTiles,
    _unused,
  ) {
    const region = new Set();
    const frontier = new Map(); // tileIdx → distance to seed
    const seedCenter = this._getTileCenter(tiles, seedIdx);

    if (excludedTiles.has(seedIdx) || !allowedTiles.has(seedIdx)) {
      return region;
    }

    region.add(seedIdx);

    // Add seed neighbors to frontier
    for (const neighbor of adjacencyMap.get(seedIdx) || []) {
      if (
        allowedTiles.has(neighbor) &&
        !excludedTiles.has(neighbor) &&
        !region.has(neighbor)
      ) {
        const dist = this._getTileCenter(tiles, neighbor).distanceTo(
          seedCenter,
        );
        frontier.set(neighbor, dist);
      }
    }

    // Grow by picking closest unassigned tile (same pattern as Planet._generateClusters)
    while (region.size < targetSize && frontier.size > 0) {
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
      if (region.has(closest) || excludedTiles.has(closest)) continue;

      region.add(closest);

      for (const neighbor of adjacencyMap.get(closest) || []) {
        if (
          allowedTiles.has(neighbor) &&
          !excludedTiles.has(neighbor) &&
          !region.has(neighbor) &&
          !frontier.has(neighbor)
        ) {
          frontier.set(
            neighbor,
            this._getTileCenter(tiles, neighbor).distanceTo(seedCenter),
          );
        }
      }
    }

    return region;
  }

  _getTileCenter(tiles, idx) {
    const cp = tiles[idx].centerPoint;
    return new THREE.Vector3(
      parseFloat(cp.x),
      parseFloat(cp.y),
      parseFloat(cp.z),
    );
  }

  // ========================
  // GROUND CONNECTIVITY VALIDATION
  // ========================

  _validateGroundConnectivity(tiles, adjacencyMap) {
    // Collect all ground-level eligible tiles
    const groundTiles = new Set();
    for (let i = 0; i < tiles.length; i++) {
      if (
        !this.planet.polarTileIndices.has(i) &&
        !this.planet.portalTileIndices.has(i) &&
        !this.elevatedTileSet.has(i)
      ) {
        groundTiles.add(i);
      }
    }

    if (groundTiles.size === 0) return;

    // BFS from first ground tile
    const start = groundTiles.values().next().value;
    const visited = new Set();
    const queue = [start];
    visited.add(start);

    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighbor of adjacencyMap.get(current) || []) {
        if (groundTiles.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (visited.size < groundTiles.size) {
      // Find isolated ground tiles and remove the smallest bordering elevation region
      const isolated = new Set();
      for (const idx of groundTiles) {
        if (!visited.has(idx)) isolated.add(idx);
      }

      // Find which elevation regions border the isolated pocket
      const borderingRegions = new Map(); // regionId → count
      for (const isoIdx of isolated) {
        for (const neighbor of adjacencyMap.get(isoIdx) || []) {
          if (this.elevatedTileSet.has(neighbor)) {
            for (const region of this.elevationRegions) {
              if (region.tiles.has(neighbor)) {
                borderingRegions.set(
                  region.id,
                  (borderingRegions.get(region.id) || 0) + 1,
                );
              }
            }
          }
        }
      }

      // Remove the region with fewest tiles that borders the isolation
      let smallestId = -1;
      let smallestSize = Infinity;
      for (const [rid] of borderingRegions) {
        const region = this.elevationRegions.find((r) => r.id === rid);
        if (region && region.level === 1 && region.tiles.size < smallestSize) {
          smallestSize = region.tiles.size;
          smallestId = rid;
        }
      }

      if (smallestId >= 0) {
        const region = this.elevationRegions.find(
          (r) => r.id === smallestId,
        );
        if (region) {
          // Remove this region and any nested children
          this._removeRegionAndChildren(smallestId);
          // Re-validate
          this._validateGroundConnectivity(tiles, adjacencyMap);
        }
      }
    }
  }

  _removeRegionAndChildren(regionId) {
    const region = this.elevationRegions.find((r) => r.id === regionId);
    if (!region) return;

    // Remove children first
    const children = this.elevationRegions.filter(
      (r) => r.parentId === regionId,
    );
    for (const child of children) {
      this._removeRegionAndChildren(child.id);
    }

    // Remove tiles
    for (const idx of region.tiles) {
      this.tileElevation.delete(idx);
      this.elevatedTileSet.delete(idx);
    }

    // Remove from regions list
    const rIdx = this.elevationRegions.indexOf(region);
    if (rIdx >= 0) this.elevationRegions.splice(rIdx, 1);
  }

  // ========================
  // SPATIAL HASH
  // ========================

  _buildSpatialHash() {
    this._spatialGrid = new Map();
    const tileCenters = this.planet.tileCenters;

    for (let i = 0; i < tileCenters.length; i++) {
      const tc = tileCenters[i];
      const pos = tc.position;
      const r = pos.length();
      if (r < 0.001) continue;

      const phi = Math.acos(Math.max(-1, Math.min(1, pos.y / r)));
      const theta = Math.atan2(pos.z, pos.x) + Math.PI; // 0 to 2PI

      const phiCell = Math.min(
        this._GRID_PHI - 1,
        Math.floor((phi / Math.PI) * this._GRID_PHI),
      );
      const thetaCell = Math.min(
        this._GRID_THETA - 1,
        Math.floor((theta / (Math.PI * 2)) * this._GRID_THETA),
      );
      const key = phiCell * this._GRID_THETA + thetaCell;

      if (!this._spatialGrid.has(key)) {
        this._spatialGrid.set(key, []);
      }
      this._spatialGrid.get(key).push(i); // Store array index into tileCenters
    }
  }

  // ========================
  // LOOKUPS
  // ========================

  getElevationAtTileIndex(tileIndex) {
    return this.tileElevation.get(tileIndex) || 0;
  }

  isElevatedTile(tileIndex) {
    return this.elevatedTileSet.has(tileIndex);
  }

  /**
   * Find the nearest tile index for a planet-local-space position.
   * Returns the tile index, or -1 if not found.
   */
  getNearestTileIndex(localPos) {
    if (!this._spatialGrid) return -1;

    const r = localPos.length();
    if (r < 0.001) return -1;

    const phi = Math.acos(Math.max(-1, Math.min(1, localPos.y / r)));
    const theta = Math.atan2(localPos.z, localPos.x) + Math.PI;

    const phiCell = Math.min(
      this._GRID_PHI - 1,
      Math.floor((phi / Math.PI) * this._GRID_PHI),
    );
    const thetaCell = Math.min(
      this._GRID_THETA - 1,
      Math.floor((theta / (Math.PI * 2)) * this._GRID_THETA),
    );

    let closestArrayIdx = -1;
    let closestDist = Infinity;

    // Check cell + 8 neighbors
    for (let dp = -1; dp <= 1; dp++) {
      const pc = phiCell + dp;
      if (pc < 0 || pc >= this._GRID_PHI) continue;
      for (let dt = -1; dt <= 1; dt++) {
        const tc = ((thetaCell + dt) % this._GRID_THETA + this._GRID_THETA) % this._GRID_THETA;
        const key = pc * this._GRID_THETA + tc;
        const entries = this._spatialGrid.get(key);
        if (!entries) continue;

        for (const arrayIdx of entries) {
          const tcEntry = this.planet.tileCenters[arrayIdx];
          const dist = localPos.distanceToSquared(tcEntry.position);
          if (dist < closestDist) {
            closestDist = dist;
            closestArrayIdx = arrayIdx;
          }
        }
      }
    }

    if (closestArrayIdx < 0) return -1;
    return this.planet.tileCenters[closestArrayIdx].tileIndex;
  }

  getElevationAtPosition(localPos) {
    const tileIndex = this.getNearestTileIndex(localPos);
    if (tileIndex < 0) return 0;
    return this.tileElevation.get(tileIndex) || 0;
  }

  getExtrusion(elevation) {
    if (elevation <= 0) return 1;
    return 1 + (elevation * this.config.EXTRUSION_HEIGHT) / this.planet.radius;
  }

  /**
   * Returns the max elevation level (0-3) of any tile in the 3x3
   * spatial-hash neighborhood around localPos (planet-local space).
   */
  getMaxNearbyElevation(localPos) {
    if (!this._spatialGrid) return 0;

    const r = localPos.length();
    if (r < 0.001) return 0;

    const phi = Math.acos(Math.max(-1, Math.min(1, localPos.y / r)));
    const theta = Math.atan2(localPos.z, localPos.x) + Math.PI;

    const phiCell = Math.min(
      this._GRID_PHI - 1,
      Math.floor((phi / Math.PI) * this._GRID_PHI),
    );
    const thetaCell = Math.min(
      this._GRID_THETA - 1,
      Math.floor((theta / (Math.PI * 2)) * this._GRID_THETA),
    );

    let maxElev = 0;

    for (let dp = -1; dp <= 1; dp++) {
      const pc = phiCell + dp;
      if (pc < 0 || pc >= this._GRID_PHI) continue;
      for (let dt = -1; dt <= 1; dt++) {
        const tc = ((thetaCell + dt) % this._GRID_THETA + this._GRID_THETA) % this._GRID_THETA;
        const key = pc * this._GRID_THETA + tc;
        const entries = this._spatialGrid.get(key);
        if (!entries) continue;

        for (const arrayIdx of entries) {
          const tcEntry = this.planet.tileCenters[arrayIdx];
          const elev = this.tileElevation.get(tcEntry.tileIndex) || 0;
          if (elev > maxElev) maxElev = elev;
        }
      }
    }

    return maxElev;
  }

  /**
   * Returns the world-unit height cap for effects at localPos.
   * Caps at the nearest higher cliff level (myElev + 1), not the max.
   * Returns Infinity when no higher terrain is adjacent.
   */
  getCliffCapHeight(localPos) {
    const myElevation = this.getElevationAtPosition(localPos);
    const maxNearby = this.getMaxNearbyElevation(localPos);
    if (maxNearby <= myElevation) return Infinity;
    const firstCliffLevel = Math.min(myElevation + 1, maxNearby);
    return (firstCliffLevel - myElevation) * this.config.EXTRUSION_HEIGHT;
  }

  // ========================
  // SPONSOR TILE DE-ELEVATION
  // ========================

  /**
   * Remove elevation from the given tile indices.
   * Returns the set of tiles whose elevation actually changed (were > 0).
   */
  clearElevationForTiles(tileIndices) {
    if (!this._clearedElevationBackup) this._clearedElevationBackup = new Map();
    const changed = new Set();
    for (const idx of tileIndices) {
      const elev = this.tileElevation.get(idx);
      if (elev && elev > 0) {
        changed.add(idx);
        // Backup original elevation and region for later restoration
        this._clearedElevationBackup.set(idx, { elevation: elev });
        this.tileElevation.delete(idx);
        this.elevatedTileSet.delete(idx);
        // Remove from region tile sets
        for (const region of this.elevationRegions) {
          region.tiles.delete(idx);
        }
      }
    }
    if (changed.size > 0) {
      this._buildSpatialHash();
    }
    return changed;
  }

  /**
   * Restore previously cleared elevation for specific tiles.
   * Re-adds them to tileElevation, elevatedTileSet, and matching regions.
   * @param {number[]} tileIndices - Tiles to restore elevation for
   * @returns {Set} Tiles that were actually restored
   */
  restoreElevationForTiles(tileIndices) {
    if (!this._clearedElevationBackup) return new Set();
    const restored = new Set();
    for (const idx of tileIndices) {
      const backup = this._clearedElevationBackup.get(idx);
      if (!backup) continue;
      this.tileElevation.set(idx, backup.elevation);
      this.elevatedTileSet.add(idx);
      this._clearedElevationBackup.delete(idx);
      restored.add(idx);
    }
    if (restored.size > 0) {
      // Re-add tiles to their matching elevation regions
      for (const idx of restored) {
        const elev = this.tileElevation.get(idx);
        // Find a region at the same level that contains a neighbor of this tile
        const neighbors = this.planet._adjacencyMap?.get(idx) || [];
        let assigned = false;
        for (const region of this.elevationRegions) {
          if (region.level !== elev) continue;
          for (const neighbor of neighbors) {
            if (region.tiles.has(neighbor)) {
              region.tiles.add(idx);
              assigned = true;
              break;
            }
          }
          if (assigned) break;
        }
      }
      this._buildSpatialHash();
    }
    return restored;
  }

  /**
   * Dispose old cliff wall mesh and rebuild from current elevation data.
   */
  rebuildCliffWalls(tiles, adjacencyMap) {
    if (this.cliffWallMesh) {
      this.planet.hexGroup.remove(this.cliffWallMesh);
      this.cliffWallMesh.geometry.dispose();
      this.cliffWallMesh.material.dispose();
      this.cliffWallMesh = null;
    }
    this.createCliffWalls(tiles, adjacencyMap);
  }

  // ========================
  // CLIFF WALL GEOMETRY
  // ========================

  createCliffWalls(tiles, adjacencyMap) {
    const positions = [];
    const normals = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    // Separate arrays for the ground apron (no shadow casting)
    const apronPos = [];
    const apronIdx = [];
    const t = this._temp;

    // Build edge map: canonical edge key → { tileIdx, v1, v2 }[]
    const edgeMap = new Map();

    for (let tileIdx = 0; tileIdx < tiles.length; tileIdx++) {
      if (this.planet.polarTileIndices.has(tileIdx)) continue;
      const boundary = tiles[tileIdx].boundary;
      for (let i = 0; i < boundary.length; i++) {
        const v1 = boundary[i];
        const v2 = boundary[(i + 1) % boundary.length];
        const k1 = `${v1.x},${v1.y},${v1.z}`;
        const k2 = `${v2.x},${v2.y},${v2.z}`;
        const edgeKey = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;

        if (!edgeMap.has(edgeKey)) edgeMap.set(edgeKey, []);
        edgeMap.get(edgeKey).push({ tileIdx, v1, v2 });
      }
    }

    for (const [, entries] of edgeMap) {
      if (entries.length !== 2) continue;

      const a = entries[0];
      const b = entries[1];
      const elevA = this.tileElevation.get(a.tileIdx) || 0;
      const elevB = this.tileElevation.get(b.tileIdx) || 0;
      if (elevA === elevB) continue;

      const high = elevA > elevB ? a : b;
      const highElev = Math.max(elevA, elevB);
      const lowElev = Math.min(elevA, elevB);

      const highScale = this.getExtrusion(highElev);
      const lowScale = this.getExtrusion(lowElev);

      const v1x = parseFloat(high.v1.x);
      const v1y = parseFloat(high.v1.y);
      const v1z = parseFloat(high.v1.z);
      const v2x = parseFloat(high.v2.x);
      const v2y = parseFloat(high.v2.y);
      const v2z = parseFloat(high.v2.z);

      t.highA.set(v1x * highScale, v1y * highScale, v1z * highScale);
      t.highB.set(v2x * highScale, v2y * highScale, v2z * highScale);
      t.lowA.set(v1x * lowScale, v1y * lowScale, v1z * lowScale);
      t.lowB.set(v2x * lowScale, v2y * lowScale, v2z * lowScale);

      // Normal: cross(edgeDir, radialDir), oriented away from higher tile
      t.edgeDir.subVectors(t.highB, t.highA).normalize();
      t.midpoint.addVectors(t.highA, t.highB).multiplyScalar(0.5);
      t.radialDir.copy(t.midpoint).normalize();
      t.wallNormal.crossVectors(t.edgeDir, t.radialDir).normalize();

      // Orient outward (away from higher tile center)
      const cp = tiles[high.tileIdx].centerPoint;
      t.tileCenterDir
        .set(
          parseFloat(cp.x) * highScale,
          parseFloat(cp.y) * highScale,
          parseFloat(cp.z) * highScale,
        )
        .sub(t.midpoint)
        .normalize();

      const baseIndex = positions.length / 3;

      positions.push(
        t.highA.x, t.highA.y, t.highA.z,
        t.highB.x, t.highB.y, t.highB.z,
        t.lowB.x,  t.lowB.y,  t.lowB.z,
        t.lowA.x,  t.lowA.y,  t.lowA.z,
      );

      // UV tiling: U along edge, V along wall height
      const edgeLen = t.highA.distanceTo(t.highB);
      const wallHeight = t.highA.distanceTo(t.lowA);
      const uTile = edgeLen / ROCK_TEXTURE_WORLD_SIZE;
      const vTile = wallHeight / ROCK_TEXTURE_WORLD_SIZE;
      uvs.push(
        0,     0,      // highA
        uTile, 0,      // highB
        uTile, vTile,  // lowB
        0,     vTile,  // lowA
      );

      // DoubleSide material auto-flips the shader normal for back faces,
      // so standard winding + unmodified cross-product normal is correct
      // from both viewing directions. No conditional flip needed.
      indices.push(
        baseIndex, baseIndex + 1, baseIndex + 2,
        baseIndex, baseIndex + 2, baseIndex + 3,
      );

      for (let i = 0; i < 4; i++) {
        normals.push(t.wallNormal.x, t.wallNormal.y, t.wallNormal.z);
      }

      // Per-quad color variation (same as polar walls)
      const variation = (this.random() - 0.5) * 0.06;
      const gray = 112 / 255 + variation;
      const cr = gray;
      const cg = gray;
      const cb = gray;
      for (let i = 0; i < 4; i++) {
        colors.push(cr, cg, cb);
      }

      // Dark ground apron at cliff base to mask shadow peter-panning gap.
      // Built into a separate mesh (no shadow casting) so it doesn't
      // create phantom shadows on the ground.
      const APRON_WIDTH = 0.4;
      t.apronA.copy(t.lowA).addScaledVector(t.tileCenterDir, -APRON_WIDTH);
      t.apronB.copy(t.lowB).addScaledVector(t.tileCenterDir, -APRON_WIDTH);

      const ab = apronPos.length / 3;
      apronPos.push(
        t.lowA.x,   t.lowA.y,   t.lowA.z,
        t.lowB.x,   t.lowB.y,   t.lowB.z,
        t.apronB.x, t.apronB.y, t.apronB.z,
        t.apronA.x, t.apronA.y, t.apronA.z,
      );
      apronIdx.push(ab, ab + 1, ab + 2, ab, ab + 2, ab + 3);
    }

    if (positions.length === 0) {
      console.warn("[TerrainElevation] No cliff wall quads generated!");
      return;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(normals, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(colors, 3),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(uvs, 2),
    );
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    // Match polar wall material but DoubleSide for cliff geometry
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: false,
      side: THREE.DoubleSide,
      shadowSide: THREE.FrontSide,
    });
    this.planet._patchWallNoise(material);

    this.cliffWallMesh = new THREE.Mesh(geometry, material);
    this.cliffWallMesh.castShadow = true;
    this.cliffWallMesh.receiveShadow = true;
    // DoubleSide depth material so shadow-side cliff faces (whose front
    // normals point away from the sun) still write to the shadow map.
    // The visual material keeps FrontSide shadows to avoid self-shadow acne.
    this.cliffWallMesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide,
    });
    this.cliffWallMesh.userData = { isCliffWall: true };
    this.planet.hexGroup.add(this.cliffWallMesh);

    // Apron mesh: dark ground strip at cliff bases, no shadow casting
    if (apronPos.length > 0) {
      const apronGeom = new THREE.BufferGeometry();
      apronGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(apronPos, 3),
      );
      apronGeom.setIndex(apronIdx);
      apronGeom.computeBoundingSphere();

      const apronMesh = new THREE.Mesh(
        apronGeom,
        new THREE.MeshBasicMaterial({
          color: 0x050505,
          side: THREE.DoubleSide,
          // Push apron behind ground tiles in depth so sponsor/tile
          // textures always win where they overlap
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      );
      apronMesh.castShadow = false;
      apronMesh.receiveShadow = false;
      apronMesh.raycast = () => {};
      apronMesh.userData = { isCliffApron: true };
      this.planet.hexGroup.add(apronMesh);
      this._cliffApronMesh = apronMesh;
    }
  }
}
