/**
 * AdLands - Server-side Terrain Elevation
 * Procedurally generates raised hex plateaus with nested elevation levels.
 * Generation-only — no cliff wall rendering (that's client-side).
 * Produces identical output to the client when given the same seed.
 */

const Vec3 = require("./Vec3");

class TerrainElevation {
  constructor(seed = 73) {
    this.random = this._createSeededRandom(seed);

    // Core data
    this.tileElevation = new Map();   // tileIndex → elevation level (0-3)
    this.elevatedTileSet = new Set(); // All tiles with elevation > 0
    this.elevationRegions = [];       // { id, level, tiles: Set, parentId }

    // Config (identical to client)
    this.config = {
      EXTRUSION_HEIGHT: 3.5,
      COVERAGE_TARGET: 0.18,
      PRIMARY_MIN_SIZE: 8,
      PRIMARY_MAX_SIZE: 30,
      SECONDARY_MIN_SIZE: 3,
      SECONDARY_MAX_SIZE: 12,
      SECONDARY_MIN_PARENT: 12,
      TERTIARY_MIN_SIZE: 2,
      TERTIARY_MAX_SIZE: 6,
      TERTIARY_MIN_PARENT: 8,
      MIN_SEED_SPACING: 0.12,
    };
  }

  // ========================
  // SEEDED RNG (same LCG as client)
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

    const seedPositions = [];

    // Phase 1: Primary regions (level 1)
    let attempts = 0;
    const maxAttempts = 400;

    while (elevatedCount < targetCount && attempts < maxAttempts) {
      attempts++;

      const eligibleArr = Array.from(eligible).filter(
        (i) => !this.elevatedTileSet.has(i)
      );
      if (eligibleArr.length === 0) break;

      const seedIdx =
        eligibleArr[Math.floor(this.random() * eligibleArr.length)];

      const seedPos = this._getTileCenter(tiles, seedIdx);
      let tooClose = false;
      for (const existing of seedPositions) {
        const angDist = this._angleTo(seedPos, existing);
        if (angDist < this.config.MIN_SEED_SPACING) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const size =
        this.config.PRIMARY_MIN_SIZE +
        Math.floor(
          this.random() *
            (this.config.PRIMARY_MAX_SIZE - this.config.PRIMARY_MIN_SIZE + 1)
        );
      const region = this._floodFill(
        seedIdx, size, tiles, adjacencyMap, eligible, this.elevatedTileSet, null
      );

      if (region.size < this.config.PRIMARY_MIN_SIZE) continue;

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

      const numSub = 1 + Math.floor(this.random() * 2);
      for (let s = 0; s < numSub; s++) {
        const parentArr = Array.from(parent.tiles);
        const subSeed =
          parentArr[Math.floor(this.random() * parentArr.length)];

        const subSize =
          this.config.SECONDARY_MIN_SIZE +
          Math.floor(
            this.random() *
              (this.config.SECONDARY_MAX_SIZE -
                this.config.SECONDARY_MIN_SIZE + 1)
          );

        const subRegion = this._floodFill(
          subSeed, subSize, tiles, adjacencyMap,
          parent.tiles, new Set(), null
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
    const secondaryRegions = this.elevationRegions.filter((r) => r.level === 2);
    for (const parent of secondaryRegions) {
      if (parent.tiles.size < this.config.TERTIARY_MIN_PARENT) continue;

      const parentArr = Array.from(parent.tiles);
      const subSeed = parentArr[Math.floor(this.random() * parentArr.length)];

      const subSize =
        this.config.TERTIARY_MIN_SIZE +
        Math.floor(
          this.random() *
            (this.config.TERTIARY_MAX_SIZE - this.config.TERTIARY_MIN_SIZE + 1)
        );

      const subRegion = this._floodFill(
        subSeed, subSize, tiles, adjacencyMap,
        parent.tiles, new Set(), null
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
    this._validateGroundConnectivity(tiles, adjacencyMap, portalTileIndices, polarTileIndices);

    const l1 = this.elevationRegions.filter((r) => r.level === 1).length;
    const l2 = this.elevationRegions.filter((r) => r.level === 2).length;
    const l3 = this.elevationRegions.filter((r) => r.level === 3).length;
    console.log(
      `[TerrainElevation] ${this.elevatedTileSet.size} elevated tiles ` +
      `(${((this.elevatedTileSet.size / tiles.length) * 100).toFixed(1)}%) | ` +
      `L1: ${l1} regions, L2: ${l2}, L3: ${l3}`
    );
  }

  // ========================
  // FLOOD FILL
  // ========================

  _floodFill(seedIdx, targetSize, tiles, adjacencyMap, allowedTiles, excludedTiles, _unused) {
    const region = new Set();
    const frontier = new Map();
    const seedCenter = this._getTileCenter(tiles, seedIdx);

    if (excludedTiles.has(seedIdx) || !allowedTiles.has(seedIdx)) {
      return region;
    }

    region.add(seedIdx);

    for (const neighbor of adjacencyMap.get(seedIdx) || []) {
      if (
        allowedTiles.has(neighbor) &&
        !excludedTiles.has(neighbor) &&
        !region.has(neighbor)
      ) {
        const dist = this._getTileCenter(tiles, neighbor).distanceTo(seedCenter);
        frontier.set(neighbor, dist);
      }
    }

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
            this._getTileCenter(tiles, neighbor).distanceTo(seedCenter)
          );
        }
      }
    }

    return region;
  }

  _getTileCenter(tiles, idx) {
    const cp = tiles[idx].centerPoint;
    return new Vec3(
      parseFloat(cp.x),
      parseFloat(cp.y),
      parseFloat(cp.z)
    );
  }

  /**
   * Angle between two Vec3 positions (equivalent to THREE.Vector3.angleTo)
   */
  _angleTo(a, b) {
    const la = a.length();
    const lb = b.length();
    if (la === 0 || lb === 0) return 0;
    const dot = (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb);
    return Math.acos(Math.max(-1, Math.min(1, dot)));
  }

  // ========================
  // GROUND CONNECTIVITY VALIDATION
  // ========================

  _validateGroundConnectivity(tiles, adjacencyMap, portalTileIndices, polarTileIndices) {
    const groundTiles = new Set();
    for (let i = 0; i < tiles.length; i++) {
      if (
        !polarTileIndices.has(i) &&
        !portalTileIndices.has(i) &&
        !this.elevatedTileSet.has(i)
      ) {
        groundTiles.add(i);
      }
    }

    if (groundTiles.size === 0) return;

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
      const isolated = new Set();
      for (const idx of groundTiles) {
        if (!visited.has(idx)) isolated.add(idx);
      }

      const borderingRegions = new Map();
      for (const isoIdx of isolated) {
        for (const neighbor of adjacencyMap.get(isoIdx) || []) {
          if (this.elevatedTileSet.has(neighbor)) {
            for (const region of this.elevationRegions) {
              if (region.tiles.has(neighbor)) {
                borderingRegions.set(
                  region.id,
                  (borderingRegions.get(region.id) || 0) + 1
                );
              }
            }
          }
        }
      }

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
        const region = this.elevationRegions.find((r) => r.id === smallestId);
        if (region) {
          this._removeRegionAndChildren(smallestId);
          console.log(
            `[TerrainElevation] Removed region ${smallestId} (${region.tiles.size} tiles) to fix ground connectivity`
          );
          this._validateGroundConnectivity(tiles, adjacencyMap, portalTileIndices, polarTileIndices);
        }
      }
    }
  }

  _removeRegionAndChildren(regionId) {
    const region = this.elevationRegions.find((r) => r.id === regionId);
    if (!region) return;

    const children = this.elevationRegions.filter((r) => r.parentId === regionId);
    for (const child of children) {
      this._removeRegionAndChildren(child.id);
    }

    for (const idx of region.tiles) {
      this.tileElevation.delete(idx);
      this.elevatedTileSet.delete(idx);
    }

    const rIdx = this.elevationRegions.indexOf(region);
    if (rIdx >= 0) this.elevationRegions.splice(rIdx, 1);
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
}

module.exports = TerrainElevation;
