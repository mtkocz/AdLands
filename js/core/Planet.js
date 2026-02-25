/**
 * AdLands - Planet Module
 * Hexasphere planet with cluster territories and patterns
 *
 * Dependencies: THREE.js, hexasphere.js, js/utils/factionColors.js
 */

// Border band configuration for faction territory visualization
const BORDER_GLOW_CONFIG = {
  glowWidth: 11.0, // 20x thicker band (was 0.55)
  baseOpacity: 0.9, // Near-solid at edge
  fadeExponent: 1.2, // Smooth fade inward
  zOffset: 0.012, // Above terrain
};

// Cluster overlay opacity for faction territory coloring
const CLUSTER_OVERLAY_OPACITY = 0.5;

// Crust thickness for visible side walls at polar openings
const CRUST_THICKNESS = 6;

// World units per rock texture tile (controls texture density on cliff/polar walls)
const ROCK_TEXTURE_WORLD_SIZE = 7;

class Planet {
  constructor(scene, radius = 5, subdivisions = 22) {
    this.scene = scene;
    this.radius = radius;
    this.subdivisions = subdivisions;

    // Groups
    this.hexGroup = new THREE.Group();

    // Cluster data
    this.tileClusterMap = new Map();
    this.clusterData = [];
    this.clusterColors = new Map();
    this.clusterPatterns = new Map();
    this.clusterTextures = new Map();

    // Seeded RNG for consistent generation
    this.random = this._createSeededRandom(42);

    // Territory ownership and capture state
    this.clusterOwnership = new Map(); // clusterId → faction name ('rust', 'cobalt', 'viridian', or null)
    this.clusterCaptureState = new Map(); // clusterId → { tics: number, owner: string|null }

    // Tile center positions for tank-cluster detection
    this.tileCenters = []; // Array of { position: Vector3, tileIndex: number }

    // Portal tiles (neutral spawn points)
    this.portalTileIndices = new Set(); // All portal-related tiles (centers + borders)
    this.portalCenterIndices = new Set(); // Just the 8 actual portal centers (black)

    // Polar tile indices (deleted - hollow poles)
    this.polarTileIndices = new Set();

    // Sponsor clusters
    this.sponsorClusters = new Map(); // sponsorId → { sponsor, clusterId, tileIndices }
    this.sponsorHoldTimers = new Map(); // sponsorId → { owner, capturedAt, holdDuration }
    this.sponsorTileIndices = new Set(); // All tiles belonging to any sponsor cluster
    this._sponsorTextureCache = new Map(); // patternImage dataUrl → THREE.Texture
    this.sponsorOutlines = new Map(); // sponsorId → THREE.LineSegments

    // Historical occupancy tracking for pie charts
    this.clusterOccupancyHistory = new Map(); // clusterId → { rust: ms, cobalt: ms, viridian: ms, unclaimed: ms }

    // Cluster adjacency for territory logic
    this._clusterAdjacencyMap = new Map(); // clusterId → Set<neighboring clusterIds>

    // Inner glow overlays for captured clusters
    this.clusterGlowOverlays = new Map(); // clusterId → THREE.Mesh (glow overlay)

    // Territory transition animations
    this._overlayAnimations = []; // Active overlay animations

    // Weak territories (under heavy attack) - opacity flicker effect (owner color only)
    this._weakTerritories = new Map(); // clusterId → attacking faction name

    // Border glow meshes for faction territories (replaces color overlay)
    this.factionBorderGlows = new Map(); // 'rust'/'cobalt'/'viridian' → THREE.Mesh (ribbon mesh)
    this._dirtyFactionBorderGlows = new Set(); // factions needing border glow regeneration
    this._lastBorderGlowUpdate = 0;
    this._borderGlowAnimations = []; // Active border glow animations

    // Volumetric light cones at polar openings
    this._volLightMeshes = [];
    this._volLightTime = 0;

    // Portal pulse animation
    this._portalMeshes = [];
    this._portalPulseTime = 0;

    // Preallocated temp objects for visibility culling (avoid GC pressure)
    this._cullTemp = {
      cameraWorldPos: new THREE.Vector3(),
      tileWorldPos: new THREE.Vector3(),
      tileNormal: new THREE.Vector3(),
      tileToCamera: new THREE.Vector3(),
    };

    // Pattern types
    this.PATTERNS = [
      "stripes_h",
      "stripes_v",
      "stripes_d1",
      "stripes_d2",
      "dots",
      "dots_sparse",
      "checkerboard",
      "crosshatch",
      "grid",
      "waves",
      "zigzag",
      "diamonds",
      "triangles",
      "circles",
    ];

    this._generate();

    scene.add(this.hexGroup);
  }

  /**
   * Build a single merged BufferGeometry from hex tile faces + polar crust walls.
   * Used as a bloom-pass occluder so bloom occlusion matches the actual hull.
   */
  createHullOccluderGeometry() {
    const allPositions = [];
    const allIndices = [];
    let vertexOffset = 0;

    // 1. Hex tile faces (outer surface, elevation-aware)
    this._tiles.forEach((tile, index) => {
      if (this.polarTileIndices.has(index)) return;
      const boundary = tile.boundary;
      const n = boundary.length;
      const es = 1; // Base radius — watertight shell for bloom occlusion

      for (let i = 0; i < n; i++) {
        allPositions.push(
          parseFloat(boundary[i].x) * es,
          parseFloat(boundary[i].y) * es,
          parseFloat(boundary[i].z) * es,
        );
      }
      for (let i = 1; i < n - 1; i++) {
        allIndices.push(vertexOffset, vertexOffset + i, vertexOffset + i + 1);
      }
      vertexOffset += n;
    });

    // 2. Polar crust walls (rim of polar openings)
    const edges = this._findPolarBoundaryEdges(this._tiles);
    const scale = (this.radius - CRUST_THICKNESS) / this.radius;
    for (const edge of edges) {
      const ox1 = edge.v1.x, oy1 = edge.v1.y, oz1 = edge.v1.z;
      const ox2 = edge.v2.x, oy2 = edge.v2.y, oz2 = edge.v2.z;
      const ix1 = ox1 * scale, iy1 = oy1 * scale, iz1 = oz1 * scale;
      const ix2 = ox2 * scale, iy2 = oy2 * scale, iz2 = oz2 * scale;

      allPositions.push(
        ox1, oy1, oz1,
        ox2, oy2, oz2,
        ix2, iy2, iz2,
        ix1, iy1, iz1,
      );
      // Both winding orders so it occludes from either side
      allIndices.push(
        vertexOffset, vertexOffset + 1, vertexOffset + 2,
        vertexOffset, vertexOffset + 2, vertexOffset + 3,
        vertexOffset, vertexOffset + 2, vertexOffset + 1,
        vertexOffset, vertexOffset + 3, vertexOffset + 2,
      );
      vertexOffset += 4;
    }

    // 3. Inner crust faces (inward-facing hex tiles at reduced radius)
    this._tiles.forEach((tile, index) => {
      if (this.polarTileIndices.has(index)) return;
      const boundary = tile.boundary;
      const n = boundary.length;

      for (let i = 0; i < n; i++) {
        allPositions.push(
          parseFloat(boundary[i].x) * scale,
          parseFloat(boundary[i].y) * scale,
          parseFloat(boundary[i].z) * scale,
        );
      }
      for (let i = 1; i < n - 1; i++) {
        allIndices.push(vertexOffset, vertexOffset + i + 1, vertexOffset + i);
      }
      vertexOffset += n;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(allPositions, 3),
    );
    geometry.setIndex(allIndices);
    return geometry;
  }

  _createSeededRandom(seed) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  _generate() {
    if (typeof Hexasphere === "undefined") {
      console.warn("Hexasphere.js not loaded, using fallback");
      this._generateFallback();
      return;
    }

    const hexasphere = new Hexasphere(this.radius, this.subdivisions, 1.0);

    this._storeTileCenters(hexasphere.tiles);
    this._markPortalTiles(hexasphere.tiles);
    const adjacencyMap = this._generateClusters(hexasphere.tiles);
    this._adjacencyMap = adjacencyMap; // Store for portal neighbor lookups
    this._tiles = hexasphere.tiles;
    this._initializeCaptureState();

    // Generate terrain elevation (raised hex plateaus)
    if (typeof TerrainElevation !== "undefined") {
      this.terrainElevation = new TerrainElevation(this, 73);
      this.terrainElevation.generate(
        hexasphere.tiles,
        adjacencyMap,
        this.portalTileIndices,
        this.polarTileIndices,
      );
    }

    this._createNoiseTextures();
    this._createTileMeshes(hexasphere.tiles);

    // Create cliff wall geometry for terrain elevation transitions
    if (this.terrainElevation) {
      try {
        this.terrainElevation.createCliffWalls(hexasphere.tiles, adjacencyMap);
      } catch (e) {
        console.error("[Planet] createCliffWalls failed:", e);
      }
    }

    this._createPolarWalls(hexasphere.tiles);
    this._buildPolarBoundaryPolygons(hexasphere.tiles);
    this._createPolarVolumetricLights(hexasphere.tiles);
    this._clusterAdjacencyMap = this._buildClusterAdjacencyMap();
  }

  _generateFallback() {
    const geometry = new THREE.IcosahedronGeometry(this.radius, 5);
    const material = new THREE.MeshStandardMaterial({
      color: 0x808080,
      flatShading: false,
      roughness: 0.95,
      metalness: 0.02,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.hexGroup.add(mesh);
  }

  _isPolarTile(tile, radius) {
    const y = parseFloat(tile.centerPoint.y);
    const phi = Math.acos(y / radius);
    // 80° from equator = 10° from pole
    const polarThreshold = (10 * Math.PI) / 180;
    return phi < polarThreshold || phi > Math.PI - polarThreshold;
  }

  _findClosestTileIndex(position) {
    let closestIndex = -1;
    let closestDist = Infinity;
    for (const tile of this.tileCenters) {
      const dist = position.distanceToSquared(tile.position);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = tile.tileIndex;
      }
    }
    return closestIndex;
  }

  _markPortalTiles(tiles) {
    // Pentagons (12 total on hexasphere at icosahedron vertices) are the portals
    tiles.forEach((tile, index) => {
      if (tile.boundary.length === 5) {
        this.portalCenterIndices.add(index);
        this.portalTileIndices.add(index);
      }
    });
  }

  isPortalTile(tileIndex) {
    return this.portalTileIndices.has(tileIndex);
  }

  _expandPortalBorders(adjacencyMap) {
    // Add the 6 neighboring tiles around each portal as neutral territory
    const portalBorders = new Set();
    for (const portalIndex of this.portalTileIndices) {
      const neighbors = adjacencyMap.get(portalIndex) || [];
      for (const neighborIndex of neighbors) {
        if (!this.portalTileIndices.has(neighborIndex)) {
          portalBorders.add(neighborIndex);
        }
      }
    }
    // Add borders to portal set
    for (const borderIndex of portalBorders) {
      this.portalTileIndices.add(borderIndex);
    }
  }

  _generateClusters(tiles) {
    const numTiles = tiles.length;
    const assigned = new Array(numTiles).fill(false);
    const adjacencyMap = this._buildAdjacencyMap(tiles);

    // Expand portal tiles to include their neighbors
    this._expandPortalBorders(adjacencyMap);

    // Mark polar tiles (deleted from rendering - hollow poles)
    let polarCount = 0;
    for (let i = 0; i < numTiles; i++) {
      if (this._isPolarTile(tiles[i], this.radius)) {
        assigned[i] = true;
        this.polarTileIndices.add(i);
        polarCount++;
      }
    }

    // Mark portal tiles as neutral (not assignable to clusters)
    let portalCount = 0;
    for (const portalIndex of this.portalTileIndices) {
      if (!assigned[portalIndex]) {
        assigned[portalIndex] = true;
        portalCount++;
      }
    }

    // Mark sponsor tiles as protected (not assignable to background cluster)
    let sponsorCount = 0;
    for (const sponsorTileIndex of this.sponsorTileIndices) {
      if (!assigned[sponsorTileIndex]) {
        assigned[sponsorTileIndex] = true;
        sponsorCount++;
      }
    }

    // Procedural clusters disabled — all non-special tiles go into one background cluster.
    // Sponsor clusters (applied later) are the only distinct territories.
    const backgroundTiles = [];
    for (let i = 0; i < numTiles; i++) {
      if (!assigned[i]) {
        backgroundTiles.push(i);
        assigned[i] = true;
        this.tileClusterMap.set(i, 0);
      }
    }

    this.clusterData.push({ id: 0, tiles: backgroundTiles });

    const gray = 112;
    this.clusterColors.set(0, (gray << 16) | (gray << 8) | gray);
    this.clusterPatterns.set(0, {
      type: "solid",
      grayValue: gray,
      roughness: 0.95,
      metalness: 0.02,
    });

    return adjacencyMap;
  }

  _storeTileCenters(tiles) {
    tiles.forEach((tile, index) => {
      const cp = tile.centerPoint;
      this.tileCenters.push({
        position: new THREE.Vector3(
          parseFloat(cp.x),
          parseFloat(cp.y),
          parseFloat(cp.z),
        ),
        tileIndex: index,
      });
    });
  }

  _initializeCaptureState() {
    this.clusterData.forEach((cluster) => {
      if (!cluster.isSponsorCluster) return;
      const capacity = cluster.tiles.length * 5;
      this.clusterCaptureState.set(cluster.id, {
        tics: { rust: 0, cobalt: 0, viridian: 0 },
        owner: null,
        capacity: capacity,
        momentum: { rust: 0, cobalt: 0, viridian: 0 },
      });
    });
  }

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

  /**
   * Apply server-authoritative world data (clusters, terrain, portals).
   * Overrides locally generated data to guarantee server/client consistency.
   * Called by MultiplayerClient on connect.
   */
  applyServerWorld(world) {
    // Override cluster mapping
    this.tileClusterMap.clear();
    for (let i = 0; i < world.tileClusterMap.length; i++) {
      if (world.tileClusterMap[i] >= 0) {
        this.tileClusterMap.set(i, world.tileClusterMap[i]);
      }
    }

    // Override cluster data
    this.clusterData = world.clusters.map((c) => ({
      id: c.id,
      tiles: c.tiles,
      isSponsorCluster: !!c.isSponsorCluster,
    }));

    // Override cluster visuals
    this.clusterColors.clear();
    this.clusterPatterns.clear();
    for (const [cid, vis] of Object.entries(world.clusterVisuals)) {
      const id = parseInt(cid);
      this.clusterColors.set(id, vis.color);
      this.clusterPatterns.set(id, vis.pattern);
    }

    // Override portal/polar indices
    this.portalCenterIndices = new Set(world.portalCenterIndices);
    this.portalTileIndices = new Set(world.portalTileIndices);
    this.polarTileIndices = new Set(world.polarTileIndices);

    // Override terrain elevation
    if (this.terrainElevation && world.tileElevation) {
      this.terrainElevation.tileElevation.clear();
      this.terrainElevation.elevatedTileSet.clear();
      for (let i = 0; i < world.tileElevation.length; i++) {
        if (world.tileElevation[i] > 0) {
          this.terrainElevation.tileElevation.set(i, world.tileElevation[i]);
          this.terrainElevation.elevatedTileSet.add(i);
        }
      }
    }

    // Re-initialize capture state from server clusters
    this.clusterCaptureState.clear();
    this.clusterOwnership.clear();
    this._initializeCaptureState();

    // Clear stale overlay meshes and animations from previous connection
    for (const [, overlay] of this.clusterGlowOverlays) {
      this.hexGroup.remove(overlay);
      overlay.geometry.dispose();
      overlay.material.dispose();
    }
    this.clusterGlowOverlays.clear();
    this._overlayAnimations = [];
    this._weakTerritories.clear();

  }

  /**
   * Apply a territory state update from the server.
   * Called when server broadcasts ownership changes.
   */
  applyTerritoryState(clusterId, owner, tics) {
    const state = this.clusterCaptureState.get(clusterId);
    if (!state) return;

    state.tics = tics;
    state.owner = owner;
    this.updateClusterVisual(clusterId);
  }

  /**
   * Build a map of which clusters neighbor each other
   * Two clusters are neighbors if any of their tiles share an edge
   */
  _buildClusterAdjacencyMap() {
    const clusterAdj = new Map();

    // Initialize empty sets for all clusters
    for (const cluster of this.clusterData) {
      clusterAdj.set(cluster.id, new Set());
    }

    // For each cluster, check if any of its tiles neighbor tiles from other clusters
    for (const cluster of this.clusterData) {
      for (const tileIdx of cluster.tiles) {
        const neighborTiles = this._adjacencyMap.get(tileIdx) || [];
        for (const neighborTileIdx of neighborTiles) {
          const neighborClusterId = this.tileClusterMap.get(neighborTileIdx);
          // Skip if neighbor is neutral (no cluster) or same cluster
          if (
            neighborClusterId === undefined ||
            neighborClusterId === cluster.id
          )
            continue;

          // These two clusters are adjacent
          clusterAdj.get(cluster.id).add(neighborClusterId);
        }
      }
    }

    return clusterAdj;
  }

  _createPatternTexture(type, baseGray) {
    const size = 128; // Half resolution for crispier PS1 look
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Base fill
    ctx.fillStyle = `rgb(${baseGray},${baseGray},${baseGray})`;
    ctx.fillRect(0, 0, size, size);

    // Pattern (scaled down proportionally)
    const patternGray = baseGray - 25;
    ctx.strokeStyle =
      ctx.fillStyle = `rgb(${patternGray},${patternGray},${patternGray})`;
    ctx.lineWidth = 8; // Halved from 16

    switch (type) {
      case "stripes_h":
        for (let y = 0; y < size; y += 16) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(size, y);
          ctx.stroke();
        }
        break;
      case "stripes_v":
        for (let x = 0; x < size; x += 16) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, size);
          ctx.stroke();
        }
        break;
      case "stripes_d1":
        for (let i = -size; i < size * 2; i += 16) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i + size, size);
          ctx.stroke();
        }
        break;
      case "stripes_d2":
        for (let i = -size; i < size * 2; i += 16) {
          ctx.beginPath();
          ctx.moveTo(i, size);
          ctx.lineTo(i + size, 0);
          ctx.stroke();
        }
        break;
      case "dots":
        for (let x = 16; x < size; x += 32) {
          for (let y = 16; y < size; y += 32) {
            ctx.beginPath();
            ctx.arc(x, y, 10, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      case "dots_sparse":
        for (let x = 32; x < size; x += 64) {
          for (let y = 32; y < size; y += 64) {
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      case "checkerboard":
        for (let x = 0; x < size; x += 16) {
          for (let y = 0; y < size; y += 16) {
            if ((x / 16 + y / 16) % 2 === 0) ctx.fillRect(x, y, 16, 16);
          }
        }
        break;
      case "crosshatch":
        ctx.lineWidth = 6;
        for (let i = -size; i < size * 2; i += 16) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i + size, size);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(i, size);
          ctx.lineTo(i + size, 0);
          ctx.stroke();
        }
        break;
      case "grid":
        for (let i = 0; i < size; i += 32) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i, size);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(0, i);
          ctx.lineTo(size, i);
          ctx.stroke();
        }
        break;
      case "waves":
        const freq = (Math.PI * 2) / size;
        for (let y = 16; y < size; y += 32) {
          ctx.beginPath();
          for (let x = 0; x <= size; x += 2) {
            const wy = y + Math.sin(x * freq * 4) * 12;
            x === 0 ? ctx.moveTo(x, wy) : ctx.lineTo(x, wy);
          }
          ctx.stroke();
        }
        break;
      case "zigzag":
        for (let y = 10; y < size; y += 32) {
          ctx.beginPath();
          for (let x = 0; x <= size; x += 16) {
            const zy = y + ((x / 16) % 2 === 0 ? 0 : 12);
            x === 0 ? ctx.moveTo(x, zy) : ctx.lineTo(x, zy);
          }
          ctx.stroke();
        }
        break;
      case "diamonds":
        for (let x = 0; x < size; x += 32) {
          for (let y = 0; y < size; y += 32) {
            const cx = x + 16,
              cy = y + 16;
            ctx.beginPath();
            ctx.moveTo(cx, cy - 16);
            ctx.lineTo(cx + 16, cy);
            ctx.lineTo(cx, cy + 16);
            ctx.lineTo(cx - 16, cy);
            ctx.closePath();
            ctx.stroke();
          }
        }
        break;
      case "triangles":
        for (let x = 0; x < size; x += 32) {
          for (let y = 0; y < size; y += 32) {
            ctx.beginPath();
            ctx.moveTo(x + 16, y + 4);
            ctx.lineTo(x + 28, y + 28);
            ctx.lineTo(x + 4, y + 28);
            ctx.closePath();
            ctx.stroke();
          }
        }
        break;
      case "circles":
        for (let x = 0; x < size; x += 32) {
          for (let y = 0; y < size; y += 32) {
            ctx.beginPath();
            ctx.arc(x + 16, y + 16, 11, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        break;
      case "noise": {
        // Random pixel noise — no repeating structure so tiling is invisible
        const imgData = ctx.getImageData(0, 0, size, size);
        const d = imgData.data;
        const pixelSize = 4; // Chunky 4x4 blocks for pixel-art look
        for (let by = 0; by < size; by += pixelSize) {
          for (let bx = 0; bx < size; bx += pixelSize) {
            const v = Math.floor(baseGray + (Math.random() - 0.5) * 30);
            for (let py = 0; py < pixelSize && by + py < size; py++) {
              for (let px = 0; px < pixelSize && bx + px < size; px++) {
                const i = ((by + py) * size + (bx + px)) * 4;
                d[i] = d[i + 1] = d[i + 2] = v;
              }
            }
          }
        }
        ctx.putImageData(imgData, 0, 0);
        break;
      }
      case "solid":
        // No pattern - just base color
        break;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    return texture;
  }

  _createTileMeshes(tiles) {
    tiles.forEach((tile, index) => {
      if (this.polarTileIndices.has(index)) return;
      const boundary = tile.boundary;
      const n = boundary.length;
      const vertices = [];
      const uvs = [];

      // Terrain elevation: scale vertices radially outward for raised tiles
      const extrusionScale = this.terrainElevation
        ? this.terrainElevation.getExtrusion(
            this.terrainElevation.getElevationAtTileIndex(index),
          )
        : 1;

      const isElevated = extrusionScale > 1;

      // For elevated tiles, build tangent-plane basis for distortion-free UVs
      let tanU, tanV;
      if (isElevated) {
        const cp = tile.centerPoint;
        const normal = new THREE.Vector3(
          parseFloat(cp.x), parseFloat(cp.y), parseFloat(cp.z),
        ).normalize();
        const up = Math.abs(normal.y) < 0.99
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
        tanU = new THREE.Vector3().crossVectors(up, normal).normalize();
        tanV = new THREE.Vector3().crossVectors(normal, tanU);
      }

      for (let i = 0; i < n; i++) {
        const origX = parseFloat(boundary[i].x);
        const origY = parseFloat(boundary[i].y);
        const origZ = parseFloat(boundary[i].z);

        // Apply extrusion scale for elevated tiles
        const vx = origX * extrusionScale;
        const vy = origY * extrusionScale;
        const vz = origZ * extrusionScale;
        vertices.push(vx, vy, vz);

        if (isElevated) {
          // Tangent-plane projection scaled to match cliff wall texture density
          const u = (origX * tanU.x + origY * tanU.y + origZ * tanU.z) / ROCK_TEXTURE_WORLD_SIZE;
          const v = (origX * tanV.x + origY * tanV.y + origZ * tanV.z) / ROCK_TEXTURE_WORLD_SIZE;
          uvs.push(u, v);
        } else {
          // Spherical UVs for ground-level pattern textures
          const r = Math.sqrt(origX * origX + origY * origY + origZ * origZ);
          const theta = Math.atan2(origZ, origX);
          const phi = Math.acos(origY / r);
          uvs.push((theta / Math.PI + 1) * 0.5 * 60.0, (phi / Math.PI) * 60.0);
        }
      }

      const indices = [];
      for (let i = 1; i < n - 1; i++) {
        indices.push(0, i, i + 1);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3),
      );
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      const clusterId = this.tileClusterMap.get(index);
      const _cp = tile.centerPoint;
      const tileCenter = new THREE.Vector3(parseFloat(_cp.x), parseFloat(_cp.y), parseFloat(_cp.z));

      let material;

      if (this.portalCenterIndices.has(index)) {
        // Compute centroid of the pentagon
        const center = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < n; i++) {
          center.x += vertices[i * 3];
          center.y += vertices[i * 3 + 1];
          center.z += vertices[i * 3 + 2];
        }
        center.divideScalar(n);

        // Compute max distance from center to any vertex (circumradius)
        let maxDist = 0;
        for (let i = 0; i < n; i++) {
          const dx = vertices[i * 3] - center.x;
          const dy = vertices[i * 3 + 1] - center.y;
          const dz = vertices[i * 3 + 2] - center.z;
          maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }

        // Compute tangent direction (center → first vertex, projected onto tangent plane)
        const normal = center.clone().normalize();
        const firstVertex = new THREE.Vector3(vertices[0], vertices[1], vertices[2]);
        const tangent = firstVertex.clone().sub(center);
        tangent.sub(normal.clone().multiplyScalar(tangent.dot(normal)));
        tangent.normalize();

        material = new THREE.ShaderMaterial({
          uniforms: {
            uTime: { value: 0 },
            uCenter: { value: center },
            uMaxDist: { value: maxDist },
            uTangent: { value: tangent },
          },
          vertexShader: `
            varying vec3 vPos;
            void main() {
              vPos = position;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform float uTime;
            uniform vec3 uCenter;
            uniform float uMaxDist;
            uniform vec3 uTangent;
            varying vec3 vPos;
            void main() {
              // Project fragment onto local 2D tangent plane for pentagon shape
              vec3 n = normalize(uCenter);
              vec3 toFrag = vPos - uCenter;
              toFrag -= n * dot(toFrag, n);
              vec3 bitangent = cross(n, uTangent);
              float x2d = dot(toFrag, uTangent);
              float y2d = dot(toFrag, bitangent);

              // Pentagon-shaped distance (equidistant contours form pentagons)
              float angle = atan(y2d, x2d);
              float r = length(vec2(x2d, y2d));
              float segAngle = 6.28318 / 5.0;
              float piOver5 = 3.14159 / 5.0;
              float d = cos(piOver5) / cos(mod(angle, segAngle) - piOver5);
              float dist = r / (uMaxDist * d);

              // Color palette
              vec3 cyanBright = vec3(0.15, 1.0, 1.0);
              vec3 cyanDim    = vec3(0.0, 0.65, 0.75);

              // --- Three staggered ripple rings (pentagon-shaped) ---
              float speed = 0.5;
              float phase = uTime * speed;
              float w = 0.14;

              float r1 = fract(phase);
              float r2 = fract(phase + 0.333);
              float r3 = fract(phase + 0.666);

              float ring1 = smoothstep(w, 0.0, abs(dist - r1)) * (1.0 - r1) * (1.0 - r1);
              float ring2 = smoothstep(w, 0.0, abs(dist - r2)) * (1.0 - r2) * (1.0 - r2);
              float ring3 = smoothstep(w, 0.0, abs(dist - r3)) * (1.0 - r3) * (1.0 - r3);

              float rings = ring1 + ring2 + ring3;

              // --- Breathing center glow ---
              float breath = 0.5 + 0.5 * sin(uTime * 1.5);
              float centerGlow = exp(-dist * 4.0) * (0.35 + 0.2 * breath);

              // --- Faint persistent edge ---
              float edge = smoothstep(0.5, 1.0, dist) * 0.12;

              // Combine layers
              vec3 color = cyanBright * (rings * 0.85 + centerGlow) + cyanDim * edge;
              gl_FragColor = vec4(color, 1.0);
            }
          `,
          side: THREE.FrontSide,
        });
      } else if (clusterId === undefined) {
        if (!this._neutralTexture) {
          this._neutralTexture = this._createPatternTexture("solid", 58);
        }
        material = new THREE.MeshStandardMaterial({
          map: this._neutralTexture,
          flatShading: false,
          roughness: 0.95,
          metalness: 0.02,
          side: THREE.FrontSide,
        });
        this._patchTriplanarNoise(material, tileCenter);
        this._patchIgnoreSpotLights(material);
      } else {
        const pattern = this.clusterPatterns.get(clusterId);
        const isElevated = this.terrainElevation && this.terrainElevation.getElevationAtTileIndex(index) > 0;

        if (isElevated) {
          // Desaturated vertex color with per-tile variation
          const variation = (this.random() - 0.5) * 0.06;
          const gray = 112 / 255 + variation;
          const cr = gray;
          const cg = gray;
          const cb = gray;
          const colors = [];
          for (let i = 0; i < n; i++) {
            colors.push(cr, cg, cb);
          }
          geometry.setAttribute(
            "color",
            new THREE.Float32BufferAttribute(colors, 3),
          );
          material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            flatShading: false,
            roughness: 0.95,
            metalness: 0.02,
            side: THREE.FrontSide,
          });
          this._patchTriplanarNoise(material, tileCenter);
        } else {
          if (!this.clusterTextures.has(clusterId)) {
            this.clusterTextures.set(
              clusterId,
              this._createPatternTexture(pattern.type, pattern.grayValue),
            );
          }
          material = new THREE.MeshStandardMaterial({
            map: this.clusterTextures.get(clusterId),
            flatShading: false,
            roughness: pattern.roughness,
            metalness: pattern.metalness,
            side: THREE.FrontSide,
          });
          this._patchTriplanarNoise(material, tileCenter);
          this._patchIgnoreSpotLights(material);
        }
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { tileIndex: index, clusterId };
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.hexGroup.add(mesh);

      if (this.portalCenterIndices.has(index)) {
        this._portalMeshes.push(mesh);
      }
    });
  }

  /**
   * Merge individual tile meshes per cluster into single geometries for rendering.
   * Individual tile meshes are kept (invisible) for programmatic lookups.
   * Call AFTER sponsors are applied so sponsored tiles can be excluded.
   */
  mergeClusterTiles() {
    // Clean up any previous merge
    this.unmergeClusterTiles();

    this._mergedClusterMeshes = [];
    this._mergedClusterCentroids = new Map(); // clusterId → Vector3 centroid

    // Group individual tile meshes by cluster and material type
    const clusterGroundTiles = new Map(); // clusterId → [mesh, ...]
    const clusterElevatedTiles = new Map(); // clusterId → [mesh, ...]

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.isMesh) return;
      if (mesh.userData?.tileIndex === undefined) return;

      const tileIndex = mesh.userData.tileIndex;
      const clusterId = mesh.userData.clusterId;

      // Skip: portal tiles (custom ShaderMaterial), sponsored tiles, no-cluster (neutral)
      if (this.portalCenterIndices.has(tileIndex)) return;
      if (this.sponsorTileIndices.has(tileIndex)) return;
      if (clusterId === undefined) return;

      const isElevated = this.terrainElevation &&
        this.terrainElevation.getElevationAtTileIndex(tileIndex) > 0;

      const map = isElevated ? clusterElevatedTiles : clusterGroundTiles;
      if (!map.has(clusterId)) map.set(clusterId, []);
      map.get(clusterId).push(mesh);
    });

    // Merge each group into a single geometry + mesh
    const mergeTileGroup = (tiles, clusterId, materialType) => {
      if (tiles.length <= 1) return; // Not worth merging a single tile

      // Collect geometry data
      const allPositions = [];
      const allUvs = [];
      const allNormals = [];
      const allColors = [];
      const allIndices = [];
      const faceToTile = []; // triangle index → tileIndex
      let vertexOffset = 0;
      const hasColors = tiles[0].geometry.attributes.color !== undefined;

      for (const mesh of tiles) {
        const geom = mesh.geometry;
        const pos = geom.attributes.position.array;
        const uv = geom.attributes.uv ? geom.attributes.uv.array : null;
        const norm = geom.attributes.normal ? geom.attributes.normal.array : null;
        const col = hasColors && geom.attributes.color ? geom.attributes.color.array : null;
        const idx = geom.index ? geom.index.array : null;
        const tileIndex = mesh.userData.tileIndex;
        const vertCount = pos.length / 3;

        // Copy vertex data
        for (let i = 0; i < pos.length; i++) allPositions.push(pos[i]);
        if (uv) for (let i = 0; i < uv.length; i++) allUvs.push(uv[i]);
        if (norm) for (let i = 0; i < norm.length; i++) allNormals.push(norm[i]);
        if (col) for (let i = 0; i < col.length; i++) allColors.push(col[i]);

        // Copy indices with offset, and record face-to-tile mapping
        if (idx) {
          for (let i = 0; i < idx.length; i += 3) {
            allIndices.push(idx[i] + vertexOffset, idx[i + 1] + vertexOffset, idx[i + 2] + vertexOffset);
            faceToTile.push(tileIndex);
          }
        } else {
          // Generate triangle fan indices
          for (let i = 1; i < vertCount - 1; i++) {
            allIndices.push(vertexOffset, vertexOffset + i, vertexOffset + i + 1);
            faceToTile.push(tileIndex);
          }
        }

        vertexOffset += vertCount;
      }

      // Build merged BufferGeometry
      const mergedGeom = new THREE.BufferGeometry();
      mergedGeom.setAttribute("position", new THREE.Float32BufferAttribute(allPositions, 3));
      if (allUvs.length > 0) mergedGeom.setAttribute("uv", new THREE.Float32BufferAttribute(allUvs, 2));
      if (allNormals.length > 0) mergedGeom.setAttribute("normal", new THREE.Float32BufferAttribute(allNormals, 3));
      if (allColors.length > 0) mergedGeom.setAttribute("color", new THREE.Float32BufferAttribute(allColors, 3));
      mergedGeom.setIndex(allIndices);

      // Create material matching the tile group
      let material;
      if (materialType === "elevated") {
        material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          flatShading: false,
          roughness: 0.95,
          metalness: 0.02,
          side: THREE.FrontSide,
        });
      } else {
        const pattern = this.clusterPatterns.get(clusterId);
        if (!this.clusterTextures.has(clusterId)) {
          this.clusterTextures.set(clusterId, this._createPatternTexture(pattern.type, pattern.grayValue));
        }
        material = new THREE.MeshStandardMaterial({
          map: this.clusterTextures.get(clusterId),
          flatShading: false,
          roughness: pattern.roughness,
          metalness: pattern.metalness,
          side: THREE.FrontSide,
        });
      }
      // Compute cluster centroid for noise tangent basis
      let cx = 0, cy = 0, cz = 0;
      for (const m of tiles) {
        const cp = this._tiles[m.userData.tileIndex].centerPoint;
        cx += parseFloat(cp.x); cy += parseFloat(cp.y); cz += parseFloat(cp.z);
      }
      const clusterCenter = new THREE.Vector3(cx / tiles.length, cy / tiles.length, cz / tiles.length);
      this._patchTriplanarNoise(material, clusterCenter);
      if (materialType !== "elevated") {
        this._patchIgnoreSpotLights(material);
      }

      const mergedMesh = new THREE.Mesh(mergedGeom, material);
      mergedMesh.receiveShadow = true;
      mergedMesh.castShadow = true;
      mergedMesh.userData = {
        isMergedCluster: true,
        clusterId,
        materialType,
        tileIndices: tiles.map((m) => m.userData.tileIndex),
        faceToTile,
      };

      // Custom raycast: map face index to tileIndex
      const originalRaycast = THREE.Mesh.prototype.raycast;
      mergedMesh.raycast = function (raycaster, intersects) {
        const before = intersects.length;
        originalRaycast.call(this, raycaster, intersects);
        // Annotate new hits with tileIndex
        for (let i = before; i < intersects.length; i++) {
          const hit = intersects[i];
          if (hit.faceIndex !== undefined && this.userData.faceToTile) {
            hit.tileIndex = this.userData.faceToTile[hit.faceIndex];
          }
        }
      };

      this.hexGroup.add(mergedMesh);
      this._mergedClusterMeshes.push(mergedMesh);

      // Hide individual tiles (they remain in hexGroup for programmatic lookups)
      for (const mesh of tiles) {
        mesh.visible = false;
        mesh.userData._merged = true;
      }
    };

    // Merge ground-level tiles per cluster
    for (const [clusterId, tiles] of clusterGroundTiles) {
      mergeTileGroup(tiles, clusterId, "ground");
    }

    // Merge elevated tiles per cluster
    for (const [clusterId, tiles] of clusterElevatedTiles) {
      mergeTileGroup(tiles, clusterId, "elevated");
    }

    // Precompute cluster centroids for visibility culling
    for (const mesh of this._mergedClusterMeshes) {
      const cid = mesh.userData.clusterId;
      if (!this._mergedClusterCentroids.has(cid)) {
        const cluster = this.clusterData[cid];
        if (cluster && cluster.tiles.length > 0) {
          const centroid = new THREE.Vector3();
          let count = 0;
          for (const ti of cluster.tiles) {
            const td = this.tileCenters[ti];
            if (td) { centroid.add(td.position); count++; }
          }
          if (count > 0) centroid.divideScalar(count);
          this._mergedClusterCentroids.set(cid, centroid);
        }
      }
    }

    // Create noise grain overlay on top of entire planet surface
    this._createNoiseOverlay();
  }

  /**
   * Create a shared noise roughness map applied to all surface materials.
   * MeshStandardMaterial multiplies its roughness scalar by the green channel of roughnessMap.
   * Values centered at ~0.85 give subtle per-pixel roughness variation.
   */
  _createNoiseTextures() {
    const size = 128;
    // Generate shared random values so diffuse and roughness are the same PBR texture
    const randomValues = new Float32Array(size * size);
    for (let i = 0; i < randomValues.length; i++) {
      randomValues[i] = Math.random();
    }

    // Diffuse noise: centered at gray 128 ±30 (used by overlay shader)
    const diffuseCanvas = document.createElement("canvas");
    diffuseCanvas.width = size;
    diffuseCanvas.height = size;
    const diffuseCtx = diffuseCanvas.getContext("2d");
    const diffuseImg = diffuseCtx.getImageData(0, 0, size, size);
    const dd = diffuseImg.data;
    for (let i = 0; i < randomValues.length; i++) {
      const v = Math.floor(140 + (randomValues[i] - 0.5) * 60);
      dd[i * 4] = dd[i * 4 + 1] = dd[i * 4 + 2] = v;
      dd[i * 4 + 3] = 255;
    }
    diffuseCtx.putImageData(diffuseImg, 0, 0);

    const diffuseTex = new THREE.CanvasTexture(diffuseCanvas);
    diffuseTex.wrapS = diffuseTex.wrapT = THREE.RepeatWrapping;
    diffuseTex.minFilter = THREE.NearestFilter;
    diffuseTex.magFilter = THREE.NearestFilter;
    this._noiseDiffuseMap = diffuseTex;

    // Roughness noise: same pattern mapped to 0.7–1.0 range (179–255)
    const roughCanvas = document.createElement("canvas");
    roughCanvas.width = size;
    roughCanvas.height = size;
    const roughCtx = roughCanvas.getContext("2d");
    const roughImg = roughCtx.getImageData(0, 0, size, size);
    const rd = roughImg.data;
    for (let i = 0; i < randomValues.length; i++) {
      const v = Math.floor(217 + (randomValues[i] - 0.5) * 76);
      rd[i * 4] = rd[i * 4 + 1] = rd[i * 4 + 2] = v;
      rd[i * 4 + 3] = 255;
    }
    roughCtx.putImageData(roughImg, 0, 0);

    const roughTex = new THREE.CanvasTexture(roughCanvas);
    roughTex.wrapS = roughTex.wrapT = THREE.RepeatWrapping;
    roughTex.minFilter = THREE.NearestFilter;
    roughTex.magFilter = THREE.NearestFilter;
    this._noiseRoughnessMap = roughTex;

    // Derive noise scale to match sponsor texture pixel density.
    // Sponsor pixel art filter: 128px for a 20-tile reference cluster.
    // The texture fills the cluster once, so pixel size = clusterDiam / 128.
    // For triplanar: pixel size = 1 / (texSize * noiseScale).
    // Match: noiseScale = texSize / (texSize * clusterDiam) = 1 / clusterDiam.
    const numTiles = 10 * this.subdivisions * this.subdivisions + 2;
    const tileSize = Math.sqrt(4 * Math.PI * this.radius * this.radius / numTiles);
    const refClusterDiam = 2 * Math.sqrt(20 / Math.PI) * tileSize;
    this._noiseScale = 1.0 / refClusterDiam;
  }

  /**
   * Patch a MeshStandardMaterial with triplanar roughness noise sampling.
   * Uses the same world-space scale as the noise overlay so both maps align exactly.
   * @param {THREE.MeshStandardMaterial} material
   */
  _patchTriplanarNoise(material, center) {
    const noiseRoughMap = this._noiseRoughnessMap;
    const noiseScale = this._noiseScale;

    // Compute tangent basis from center (same logic as _calculateClusterTangentBasis)
    const normal = center.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0);
    let tanE = new THREE.Vector3().crossVectors(up, normal);
    if (tanE.lengthSq() < 0.001) tanE.set(1, 0, 0);
    tanE.normalize();
    const tanN = new THREE.Vector3().crossVectors(normal, tanE).normalize();

    material.onBeforeCompile = (shader) => {
      shader.uniforms.triNoiseRoughMap = { value: noiseRoughMap };
      shader.uniforms.triNoiseScale = { value: noiseScale };
      shader.uniforms.noiseTanE = { value: tanE };
      shader.uniforms.noiseTanN = { value: tanN };

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTriObjPos;",
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTriObjPos = position;",
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTriObjPos;
        uniform sampler2D triNoiseRoughMap;
        uniform float triNoiseScale;
        uniform vec3 noiseTanE;
        uniform vec3 noiseTanN;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;
        {
          vec2 uv = vec2(dot(vTriObjPos, noiseTanE), dot(vTriObjPos, noiseTanN)) * triNoiseScale;
          roughnessFactor *= texture2D(triNoiseRoughMap, uv).g;
        }`,
      );
    };
  }

  /**
   * Patch a MeshStandardMaterial with cylindrical roughness noise sampling.
   * Used for cliff walls and polar walls where spherical mapping distorts.
   * Horizontal: azimuthal arc length, Vertical: radial distance.
   * @param {THREE.MeshStandardMaterial} material
   */
  _patchWallNoise(material) {
    const noiseRoughMap = this._noiseRoughnessMap;
    const noiseScale = this._noiseScale;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.triNoiseRoughMap = { value: noiseRoughMap };
      shader.uniforms.triNoiseScale = { value: noiseScale };

      shader.vertexShader = shader.vertexShader.replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTriObjPos;",
      );
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTriObjPos = position;",
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <common>",
        `#include <common>
        varying vec3 vTriObjPos;
        uniform sampler2D triNoiseRoughMap;
        uniform float triNoiseScale;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <roughnessmap_fragment>",
        `float roughnessFactor = roughness;
        {
          float horizR = length(vTriObjPos.xz);
          float theta = atan(vTriObjPos.z, vTriObjPos.x);
          float r = length(vTriObjPos);
          vec2 uv = vec2(theta * horizR, r) * triNoiseScale;
          roughnessFactor *= texture2D(triNoiseRoughMap, uv).g;
        }`,
      );
    };
  }

  /**
   * Patch a MeshStandardMaterial to ignore SpotLight illumination.
   * Three.js r128 doesn't filter lights per-object by layer, so we strip the
   * spot light loop from the compiled fragment shader. Chains with any existing
   * onBeforeCompile (e.g. triplanar noise patch).
   *
   * Applied to ground-level hex tile materials only — elevated terrain, cliff
   * walls, and tanks still receive spotlight illumination.
   *
   * Call sites: _createTileMeshes (neutral + ground faction), mergeClusterTiles
   * (ground), _updateProceduralTileMaterials, clearHighlightedTiles,
   * removeSponsorCluster, _createHSVMaterial (sponsors).
   */
  _patchIgnoreSpotLights(material) {
    const originalCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (originalCompile) originalCompile.call(material, shader, renderer);
      const chunk = THREE.ShaderChunk['lights_fragment_begin'];
      const noSpotChunk = chunk.replace(
        /#if\s*\(\s*NUM_SPOT_LIGHTS\s*>\s*0\s*\)[\s\S]*?#pragma\s+unroll_loop_end\s*\n\s*#endif/,
        ''
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        noSpotChunk
      );
    };
  }

  /**
   * Create a planet-wide noise grain overlay that sits on top of all tiles.
   * Uses multiply blending so the underlying textures (sponsor logos, patterns) show through
   * with a subtle pixel-noise grain on top.
   */
  _createNoiseOverlay() {
    // Clean up previous overlay
    if (this._noiseOverlayMesh) {
      this.hexGroup.remove(this._noiseOverlayMesh);
      this._noiseOverlayMesh.geometry.dispose();
      this._noiseOverlayMesh.material.dispose();
      this._noiseOverlayMesh = null;
    }

    // Disabled — the per-tile overlay geometry creates visible gaps at hex boundaries
    return;

    // Use the shared diffuse noise texture (created in _createNoiseTextures)
    const texture = this._noiseDiffuseMap;

    // Collect geometry from all visible surface meshes
    const allPositions = [];
    const allUVs = [];
    const allIndices = [];
    let vertexOffset = 0;
    const offset = 0.04;
    const ns = this._noiseScale;

    // Wall UVs are stored as distance / ROCK_TEXTURE_WORLD_SIZE.
    // Rescale to noise density: multiply by ROCK_TEXTURE_WORLD_SIZE * noiseScale.
    const wallUVRescale = ROCK_TEXTURE_WORLD_SIZE * ns;

    const collectMesh = (pos, idx, srcUVs, tileIndex) => {
      // Per-tile tangent basis for square pixels on flat tiles
      let tanU, tanV;
      if (!srcUVs && tileIndex !== undefined && this._tiles && this._tiles[tileIndex]) {
        const cp = this._tiles[tileIndex].centerPoint;
        const center = new THREE.Vector3(parseFloat(cp.x), parseFloat(cp.y), parseFloat(cp.z));
        ({ tanU, tanV } = this._calculateClusterTangentBasis(center));
      }

      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        const len = Math.sqrt(x * x + y * y + z * z);
        allPositions.push(
          x + (x / len) * offset,
          y + (y / len) * offset,
          z + (z / len) * offset,
        );

        const vi = i / 3; // vertex index for UV lookup
        if (srcUVs) {
          // Use existing planar UVs from wall geometry, rescaled to noise density
          allUVs.push(srcUVs[vi * 2] * wallUVRescale, srcUVs[vi * 2 + 1] * wallUVRescale);
        } else if (tanU && tanV) {
          // Tangent-plane projection: square pixels at any latitude
          const u = (x * tanU.x + y * tanU.y + z * tanU.z) * ns;
          const v = (x * tanV.x + y * tanV.y + z * tanV.z) * ns;
          allUVs.push(u, v);
        } else {
          // Fallback: spherical mapping
          const nx = x / len, ny = y / len, nz = z / len;
          const theta = Math.atan2(nz, nx);
          const phi = Math.acos(Math.max(-1, Math.min(1, ny)));
          allUVs.push(theta * ns * len, phi * ns * len);
        }
      }

      if (idx) {
        for (let i = 0; i < idx.length; i++) {
          allIndices.push(idx[i] + vertexOffset);
        }
      } else {
        const vertCount = pos.length / 3;
        for (let i = 1; i < vertCount - 1; i++) {
          allIndices.push(vertexOffset, vertexOffset + i, vertexOffset + i + 1);
        }
      }
      vertexOffset += pos.length / 3;
    };

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.isMesh) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      // Skip inner crust — too dark for visible noise, and uses MeshBasicMaterial
      if (mesh.userData?.isInnerCrust) return;

      // Skip merged cluster meshes — we process individual tiles for per-tile tangent UVs
      if (mesh.userData?.isMergedCluster) return;

      // Collect from cliff walls and polar walls — use existing planar UVs
      if (mesh.userData?.isCliffWall || mesh.userData?.isPolarWall) {
        const pos = mesh.geometry.attributes.position.array;
        const idx = mesh.geometry.index ? mesh.geometry.index.array : null;
        const uvs = mesh.geometry.attributes.uv ? mesh.geometry.attributes.uv.array : null;
        collectMesh(pos, idx, uvs);
        return;
      }

      // Process all individual tiles (visible or hidden/_merged)
      if (mesh.userData?.tileIndex === undefined) return;

      // Skip portals and polar tiles
      const tileIndex = mesh.userData.tileIndex;
      if (this.portalCenterIndices.has(tileIndex)) return;
      if (this.polarTileIndices.has(tileIndex)) return;

      // Skip sponsor tiles — noise only applies to neutral territory
      if (this.sponsorTileIndices.has(tileIndex)) return;

      // Collect with per-tile tangent-plane projection
      const pos = mesh.geometry.attributes.position.array;
      const idx = mesh.geometry.index ? mesh.geometry.index.array : null;
      collectMesh(pos, idx, null, tileIndex);
    });

    if (allPositions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(allPositions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(allUVs, 2));
    geometry.setIndex(allIndices);

    // Overlay blend with distance fade
    // UVs pre-computed: per-tile tangent-plane for flat tiles, cylindrical for walls
    const material = new THREE.ShaderMaterial({
      uniforms: {
        noiseMap: { value: texture },
        uFade: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vNoiseUV;
        void main() {
          vNoiseUV = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D noiseMap;
        uniform float uFade;
        varying vec2 vNoiseUV;
        void main() {
          vec3 noise = texture2D(noiseMap, vNoiseUV).rgb;
          gl_FragColor = vec4(mix(vec3(0.5), noise, uFade), 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
    });

    const overlayMesh = new THREE.Mesh(geometry, material);
    overlayMesh.frustumCulled = false;
    overlayMesh.renderOrder = 0.5;
    overlayMesh.userData = { isNoiseOverlay: true };
    overlayMesh.raycast = () => {}; // Don't interfere with tile picking
    this.hexGroup.add(overlayMesh);
    this._noiseOverlayMesh = overlayMesh;
  }

  /**
   * Undo tile merging — restore individual tile meshes to visible, remove merged meshes.
   * Called before operations that modify tile assignments (scrambleClusters, sponsor changes).
   */
  unmergeClusterTiles() {
    if (!this._mergedClusterMeshes) return;

    // Restore individual tile visibility
    this.hexGroup.children.forEach((child) => {
      if (child.isMesh && child.userData?._merged) {
        child.visible = true;
        delete child.userData._merged;
      }
    });

    // Remove and dispose merged meshes
    for (const mesh of this._mergedClusterMeshes) {
      this.hexGroup.remove(mesh);
      mesh.geometry.dispose();
      if (mesh.material && mesh.material.dispose) mesh.material.dispose();
    }

    this._mergedClusterMeshes = [];
    this._mergedClusterCentroids = null;

    // Remove noise overlay (will be recreated when mergeClusterTiles is called again)
    if (this._noiseOverlayMesh) {
      this.hexGroup.remove(this._noiseOverlayMesh);
      this._noiseOverlayMesh.geometry.dispose();
      this._noiseOverlayMesh.material.dispose();
      this._noiseOverlayMesh = null;
    }
  }

  _findPolarBoundaryEdges(tiles) {
    const edges = [];
    const seenEdges = new Set();

    for (const tileIdx of this.polarTileIndices) {
      const neighbors = this._adjacencyMap.get(tileIdx) || [];
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
   * Build ordered 2D boundary polygons for each pole hole from actual hex edges.
   * Used for precise point-in-polygon collision detection.
   */
  _buildPolarBoundaryPolygons(tiles) {
    const edges = this._findPolarBoundaryEdges(tiles);
    this._northPolePolygon = null;
    this._southPolePolygon = null;
    if (edges.length === 0) return;

    // Separate edges into north pole (y > 0) and south pole (y < 0)
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
   * @param {Array<{v1: {x,y,z}, v2: {x,y,z}}>} edges
   * @returns {Array<{x: number, z: number}>|null}
   */
  _chainEdgesToPolygon2D(edges) {
    if (edges.length === 0) return null;

    // Build adjacency: vertex key → connected edges
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

    // Walk the ring starting from first edge
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

    // Remove duplicate closing vertex
    if (poly.length > 1) {
      const f = poly[0], l = poly[poly.length - 1];
      if (Math.abs(f.x - l.x) < 0.01 && Math.abs(f.z - l.z) < 0.01) {
        poly.pop();
      }
    }

    return poly;
  }

  /**
   * Test if a local-space position is inside a polar hole using actual hex boundary.
   * @param {{x: number, y: number, z: number}} localPos - hexGroup local space
   * @returns {boolean}
   */
  isInsidePolarHole(localPos) {
    // Quick rejection: only test near poles (20° threshold > actual ~14.5° boundary)
    const threshold = this.radius * 0.9397; // cos(20°)
    if (localPos.y > threshold && this._northPolePolygon) {
      return this._pointInPolygon2D(localPos.x, localPos.z, this._northPolePolygon);
    }
    if (localPos.y < -threshold && this._southPolePolygon) {
      return this._pointInPolygon2D(localPos.x, localPos.z, this._southPolePolygon);
    }
    return false;
  }

  /**
   * Ray-casting point-in-polygon test in 2D (XZ plane).
   * @param {number} px
   * @param {number} pz
   * @param {Array<{x: number, z: number}>} polygon
   * @returns {boolean}
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

  _createPolarWalls(tiles) {
    const thickness = CRUST_THICKNESS;
    const edges = this._findPolarBoundaryEdges(tiles);
    if (edges.length === 0) return;

    const positions = [];
    const normals = [];
    const colors = [];
    const uvs = [];
    const indices = [];
    const scale = (this.radius - thickness) / this.radius;

    const _outerA = new THREE.Vector3();
    const _outerB = new THREE.Vector3();
    const _innerA = new THREE.Vector3();
    const _innerB = new THREE.Vector3();
    const _edgeDir = new THREE.Vector3();
    const _midpoint = new THREE.Vector3();
    const _radialDir = new THREE.Vector3();
    const _wallNormal = new THREE.Vector3();
    const _towardPole = new THREE.Vector3();

    for (const edge of edges) {
      _outerA.set(edge.v1.x, edge.v1.y, edge.v1.z);
      _outerB.set(edge.v2.x, edge.v2.y, edge.v2.z);
      _innerA.copy(_outerA).multiplyScalar(scale);
      _innerB.copy(_outerB).multiplyScalar(scale);

      const baseIndex = positions.length / 3;

      positions.push(
        _outerA.x, _outerA.y, _outerA.z,
        _outerB.x, _outerB.y, _outerB.z,
        _innerB.x, _innerB.y, _innerB.z,
        _innerA.x, _innerA.y, _innerA.z,
      );

      // UV tiling: U along edge, V along wall depth
      const edgeLen = _outerA.distanceTo(_outerB);
      const wallDepth = _outerA.distanceTo(_innerA);
      const uTile = edgeLen / ROCK_TEXTURE_WORLD_SIZE;
      const vTile = wallDepth / ROCK_TEXTURE_WORLD_SIZE;
      uvs.push(
        0,     0,      // outerA
        uTile, 0,      // outerB
        uTile, vTile,  // innerB
        0,     vTile,  // innerA
      );

      _edgeDir.subVectors(_outerB, _outerA).normalize();
      _midpoint.addVectors(_outerA, _outerB).multiplyScalar(0.5);
      _radialDir.copy(_midpoint).normalize();
      _wallNormal.crossVectors(_edgeDir, _radialDir).normalize();

      // Orient normal away from the pole (outward from the hole)
      const poleY = _midpoint.y > 0 ? this.radius : -this.radius;
      _towardPole.set(0, poleY, 0).sub(_midpoint).normalize();

      if (_wallNormal.dot(_towardPole) > 0) {
        _wallNormal.negate();
        indices.push(
          baseIndex, baseIndex + 2, baseIndex + 1,
          baseIndex, baseIndex + 3, baseIndex + 2,
        );
      } else {
        indices.push(
          baseIndex, baseIndex + 1, baseIndex + 2,
          baseIndex, baseIndex + 2, baseIndex + 3,
        );
      }

      for (let i = 0; i < 4; i++) {
        normals.push(_wallNormal.x, _wallNormal.y, _wallNormal.z);
      }

      // Slight per-quad color variation for rocky appearance
      const baseR = 0.23,
        baseG = 0.18,
        baseB = 0.16;
      const variation = (this.random() - 0.5) * 0.06;
      const r = baseR + variation;
      const g = baseG + variation * 0.8;
      const b = baseB + variation * 0.6;
      for (let i = 0; i < 4; i++) {
        colors.push(r, g, b);
      }
    }

    // Wall mesh — lit, receives light
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    wallGeometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(normals, 3),
    );
    wallGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(colors, 3),
    );
    wallGeometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute(uvs, 2),
    );
    wallGeometry.setIndex(indices);

    const wallMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: false,
      side: THREE.FrontSide,
    });
    this._patchWallNoise(wallMaterial);

    const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    wallMesh.userData = { isPolarWall: true };
    this.hexGroup.add(wallMesh);
    this._polarWallMesh = wallMesh;

    // Inner crust faces — unlit, dark gray hexagons
    const innerPositions = [];
    const innerNormals = [];
    const innerColors = [];
    const innerIndices = [];

    tiles.forEach((tile, index) => {
      if (this.polarTileIndices.has(index)) return;
      const boundary = tile.boundary;
      const n = boundary.length;
      const vertexOffset = innerPositions.length / 3;

      // Random gray per tile: 3%–8%
      const gray = 0.03 + this.random() * 0.05;

      for (let i = 0; i < n; i++) {
        const vx = parseFloat(boundary[i].x) * scale;
        const vy = parseFloat(boundary[i].y) * scale;
        const vz = parseFloat(boundary[i].z) * scale;
        innerPositions.push(vx, vy, vz);

        const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
        innerNormals.push(-vx / len, -vy / len, -vz / len);

        innerColors.push(gray, gray, gray);
      }

      // Reversed winding for inward-facing triangles
      for (let i = 1; i < n - 1; i++) {
        innerIndices.push(vertexOffset, vertexOffset + i + 1, vertexOffset + i);
      }
    });

    const innerGeometry = new THREE.BufferGeometry();
    innerGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(innerPositions, 3),
    );
    innerGeometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(innerNormals, 3),
    );
    innerGeometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(innerColors, 3),
    );
    innerGeometry.setIndex(innerIndices);

    const innerMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
    });

    const innerMesh = new THREE.Mesh(innerGeometry, innerMaterial);
    innerMesh.userData = { isInnerCrust: true };
    this.hexGroup.add(innerMesh);
    this._innerCrustMesh = innerMesh;
  }

  // ── Polar volumetric light ───────────────────────────────────────────

  _chainBoundaryEdges(edges) {
    if (edges.length === 0) return [];

    // Build adjacency: vertexKey → [edgeIndex, ...]
    const vertexToEdges = new Map();
    const keyOf = (v) =>
      `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`;

    for (let i = 0; i < edges.length; i++) {
      const k1 = keyOf(edges[i].v1);
      const k2 = keyOf(edges[i].v2);
      if (!vertexToEdges.has(k1)) vertexToEdges.set(k1, []);
      if (!vertexToEdges.has(k2)) vertexToEdges.set(k2, []);
      vertexToEdges.get(k1).push(i);
      vertexToEdges.get(k2).push(i);
    }

    // Walk the chain starting from edge 0
    const ring = [];
    const visited = new Set();
    visited.add(0);
    ring.push(
      new THREE.Vector3(edges[0].v1.x, edges[0].v1.y, edges[0].v1.z),
    );

    const startKey = keyOf(edges[0].v1);
    let currentKey = keyOf(edges[0].v2);
    ring.push(
      new THREE.Vector3(edges[0].v2.x, edges[0].v2.y, edges[0].v2.z),
    );

    while (currentKey !== startKey && visited.size < edges.length) {
      const candidates = vertexToEdges.get(currentKey);
      let nextIdx = -1;
      for (const idx of candidates) {
        if (!visited.has(idx)) {
          nextIdx = idx;
          break;
        }
      }
      if (nextIdx === -1) break;
      visited.add(nextIdx);

      const nextEdge = edges[nextIdx];
      const k1 = keyOf(nextEdge.v1);
      const k2 = keyOf(nextEdge.v2);

      if (k1 === currentKey) {
        currentKey = k2;
        ring.push(
          new THREE.Vector3(nextEdge.v2.x, nextEdge.v2.y, nextEdge.v2.z),
        );
      } else {
        currentKey = k1;
        ring.push(
          new THREE.Vector3(nextEdge.v1.x, nextEdge.v1.y, nextEdge.v1.z),
        );
      }
    }

    // Remove duplicate closing vertex
    if (ring.length > 1 && ring[0].distanceTo(ring[ring.length - 1]) < 0.01) {
      ring.pop();
    }

    return ring;
  }

  _buildVolLightGeometry(ring, reach, interiorCount) {
    const n = ring.length;
    const _dir = new THREE.Vector3();
    const totalDist = this.radius + reach; // 780
    const rimH = this.radius / totalDist;  // ~0.615

    const posArr = [];
    const htArr = [];
    const idxArr = [];

    // Helper: add a single vertex, return its index
    const addVert = (x, y, z, h) => {
      const vi = posArr.length / 3;
      posArr.push(x, y, z);
      htArr.push(h);
      return vi;
    };

    // 0. Apex vertex at origin (height = 0, brightest)
    const apex = addVert(0, 0, 0, 0.0);

    // 1. Rim + outer tip ring vertices
    const rimIdx = []; // indices of rim vertices
    const tipIdx = []; // indices of outer tip vertices
    for (let i = 0; i < n; i++) {
      const r = ring[i];
      rimIdx.push(addVert(r.x, r.y, r.z, rimH));
      _dir.copy(r).normalize();
      tipIdx.push(addVert(
        r.x + _dir.x * reach,
        r.y + _dir.y * reach,
        r.z + _dir.z * reach,
        1.0,
      ));
    }

    // 2. Inner cone: triangle fan from apex to rim ring
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      idxArr.push(apex, rimIdx[i], rimIdx[next]);
    }

    // 3. Outer tube: quad strip from rim to outer tips
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      idxArr.push(rimIdx[i], rimIdx[next], tipIdx[next]);
      idxArr.push(rimIdx[i], tipIdx[next], tipIdx[i]);
    }

    // 4. Interior fins: triangular slices from apex through random rim arcs to tips
    for (let i = 0; i < interiorCount; i++) {
      const riA = Math.floor(this.random() * n);
      const span = 1 + Math.floor(this.random() * 3);
      for (let s = 0; s < span; s++) {
        const rj = (riA + s) % n;
        const rk = (riA + s + 1) % n;
        // Inner triangle: apex → two rim vertices
        idxArr.push(apex, rimIdx[rj], rimIdx[rk]);
        // Outer quad: two rim vertices → two tip vertices
        idxArr.push(rimIdx[rj], rimIdx[rk], tipIdx[rk]);
        idxArr.push(rimIdx[rj], tipIdx[rk], tipIdx[rj]);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(posArr, 3),
    );
    geometry.setAttribute("height", new THREE.Float32BufferAttribute(htArr, 1));
    geometry.setIndex(idxArr);
    geometry.computeVertexNormals();
    return geometry;
  }

  _createPolarVolumetricLights(tiles) {
    const allEdges = this._findPolarBoundaryEdges(tiles);
    if (allEdges.length === 0) return;

    // Separate north / south by midpoint Y sign
    const northEdges = [];
    const southEdges = [];
    for (const edge of allEdges) {
      const midY = (edge.v1.y + edge.v2.y) / 2;
      if (midY > 0) northEdges.push(edge);
      else southEdges.push(edge);
    }

    const reach = 150;

    const vertexShader = `
      attribute float height;
      varying float vHeight;
      varying vec3 vPos;
      varying vec3 vWorldPosition;
      void main() {
        vHeight = height;
        vPos = position;
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      uniform float uTime;
      varying float vHeight;
      varying vec3 vPos;
      varying vec3 vWorldPosition;
      void main() {
        // Far-side culling: discard fragments on the back of the planet
        vec3 surfNorm = normalize(vWorldPosition);
        vec3 camToFrag = normalize(vWorldPosition - cameraPosition);
        if (dot(surfNorm, camToFrag) > 0.15) discard;

        // Angular coord around pole axis for curtain variation
        float angle = atan(vPos.z, vPos.x);

        // Layered sine waves — traveling outward (core → space)
        float w1 = sin(vHeight * 30.0 - uTime * 0.8 + angle * 6.0) * 0.5 + 0.5;
        float w2 = sin(vHeight * 20.0 - uTime * 0.5 + angle * 10.0 + 1.5) * 0.5 + 0.5;
        float w3 = sin(vHeight * 50.0 - uTime * 1.2 + angle * 4.0 + 3.0) * 0.5 + 0.5;
        float pattern = w1 * 0.5 + w2 * 0.3 + w3 * 0.2;

        // Aurora spectrum: cyan (core) → green (mid) → purple (outer)
        float colorT = clamp(vHeight + pattern * 0.4 - 0.2, 0.0, 1.0);
        vec3 cCyan   = vec3(0.4, 0.9, 1.0);
        vec3 cGreen  = vec3(0.2, 0.9, 0.3);
        vec3 cPurple = vec3(0.6, 0.3, 0.8);
        vec3 color = colorT < 0.5
          ? mix(cCyan, cGreen, colorT * 2.0)
          : mix(cGreen, cPurple, (colorT - 0.5) * 2.0);

        // Height fade + curtain modulation
        float alpha = pow(1.0 - vHeight, 1.2) * 0.5;
        alpha *= pattern * pattern;

        if (alpha < 0.005) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `;

    for (const edges of [northEdges, southEdges]) {
      if (edges.length === 0) continue;

      const ring = this._chainBoundaryEdges(edges);
      if (ring.length < 3) continue;

      const geometry = this._buildVolLightGeometry(ring, reach, 20);

      const material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0.0 },
        },
        vertexShader,
        fragmentShader,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { isVolumetricLight: true };
      this.hexGroup.add(mesh);
      this._volLightMeshes.push(mesh);
    }
  }

  updateVolumetricLights(dt) {
    if (this._volLightMeshes.length === 0) return;
    this._volLightTime += dt;
    for (const mesh of this._volLightMeshes) {
      mesh.material.uniforms.uTime.value = this._volLightTime;
    }
  }

  updatePortalPulse(dt) {
    if (this._portalMeshes.length === 0) return;
    this._portalPulseTime += dt;
    for (const mesh of this._portalMeshes) {
      mesh.material.uniforms.uTime.value = this._portalPulseTime;
    }
  }


  _createPolarOverlay() {
    const geometry = new THREE.SphereGeometry(this.radius + 1.92, 64, 64);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        toxicColor: { value: new THREE.Color(0xc4b800) },
        fadeStart: { value: 0.7 },
        fadeEnd: { value: 1.0 },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
        sunColor: { value: new THREE.Color(0xffdc9b) },
        sunIntensity: { value: 1.2 },
        fillLightDirection: { value: new THREE.Vector3(-1, 0, 0) },
        fillLightColor: { value: new THREE.Color(0x6b8e99) },
        fillLightIntensity: { value: 0.5 },
        ambientIntensity: { value: 0.15 },
      },
      vertexShader: `
                varying vec3 vPosition;
                varying vec3 vWorldNormal;
                void main() {
                    vPosition = position;
                    vWorldNormal = normalize(mat3(modelMatrix) * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
      fragmentShader: `
                uniform vec3 toxicColor;
                uniform float fadeStart, fadeEnd;
                uniform vec3 sunDirection, sunColor;
                uniform float sunIntensity;
                uniform vec3 fillLightDirection, fillLightColor;
                uniform float fillLightIntensity, ambientIntensity;
                varying vec3 vPosition;
                varying vec3 vWorldNormal;
                void main() {
                    float latitude = abs(normalize(vPosition).y);
                    float polarIntensity = smoothstep(fadeStart, fadeEnd, latitude);
                    vec3 normal = normalize(vWorldNormal);
                    vec3 lighting = vec3(ambientIntensity);
                    lighting += sunColor * sunIntensity * max(dot(normal, sunDirection), 0.0);
                    lighting += fillLightColor * fillLightIntensity * max(dot(normal, fillLightDirection), 0.0);
                    gl_FragColor = vec4(toxicColor * lighting, polarIntensity * 0.6);
                }
            `,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      transparent: true,
      depthWrite: false,
    });

    this.hexGroup.add(new THREE.Mesh(geometry, material));
  }

  setRotation(rotation) {
    this.hexGroup.rotation.y = rotation;
  }

  /**
   * Update visibility culling for terrain tiles based on camera position
   * Hides tiles on the far side of the planet (backface culling) and outside frustum
   * @param {THREE.Camera} camera - The camera to cull against
   * @param {THREE.Frustum} frustum - Optional frustum for additional culling
   */
  updateVisibility(camera, frustum = null) {
    if (!camera) return;

    // Use preallocated temp objects to avoid GC pressure
    const temp = this._cullTemp;
    camera.getWorldPosition(temp.cameraWorldPos);

    // Fade noise overlay based on camera altitude above planet surface
    if (this._noiseOverlayMesh) {
      const altitude = temp.cameraWorldPos.length() - this.radius;
      const fadeStart = 260;
      const fadeEnd = 320;
      const fade = 1 - Math.min(1, Math.max(0, (altitude - fadeStart) / (fadeEnd - fadeStart)));
      this._noiseOverlayMesh.material.uniforms.uFade.value = fade;
      this._noiseOverlayMesh.visible = fade > 0;
    }

    // Pre-compute hexGroup world matrix for transforming tile positions
    this.hexGroup.updateMatrixWorld();
    const hexGroupMatrix = this.hexGroup.matrixWorld;

    // Backface + frustum cull hex tiles
    this.hexGroup.children.forEach((child) => {
      if (!child.isMesh) return;

      // Fast-skip tiles hidden by cluster merging (majority of children)
      if (child.userData?._merged) return;

      // Cull merged cluster meshes by centroid
      if (child.userData?.isMergedCluster) {
        const centroid = this._mergedClusterCentroids?.get(child.userData.clusterId);
        if (!centroid) return;

        // Background cluster (id 0) wraps the whole planet — centroid is near
        // the planet center, so backface culling doesn't apply. Always visible.
        if (child.userData.clusterId === 0) {
          child.visible = true;
          return;
        }

        temp.tileWorldPos.copy(centroid).applyMatrix4(hexGroupMatrix);
        temp.tileNormal.copy(temp.tileWorldPos).normalize();
        temp.tileToCamera.copy(temp.cameraWorldPos).sub(temp.tileWorldPos).normalize();
        const dot = temp.tileNormal.dot(temp.tileToCamera);

        child.visible = dot > -0.3;
        if (child.visible && frustum) {
          child.visible = frustum.intersectsObject(child);
        }
        return;
      }

      if (child.userData?.tileIndex === undefined) return;

      const tileIndex = child.userData.tileIndex;
      const tileData = this.tileCenters[tileIndex];
      if (!tileData) return;

      temp.tileWorldPos.copy(tileData.position).applyMatrix4(hexGroupMatrix);
      temp.tileNormal.copy(temp.tileWorldPos).normalize();
      temp.tileToCamera
        .copy(temp.cameraWorldPos)
        .sub(temp.tileWorldPos)
        .normalize();
      const dot = temp.tileNormal.dot(temp.tileToCamera);

      // Backface cull first, then frustum cull if still visible
      child.visible = dot > -0.15;
      if (child.visible && frustum) {
        child.visible = frustum.intersectsObject(child);
      }
    });

  }

  /**
   * Regenerate procedural clusters with a new seed while preserving sponsor clusters
   * @param {number} seed - New seed for random generation
   */
  scrambleClusters(seed) {
    // Unmerge cluster tiles before modifying cluster assignments
    this.unmergeClusterTiles();

    // Store sponsor cluster data before regeneration
    const sponsorData = [];
    for (const data of this.sponsorClusters.values()) {
      sponsorData.push({
        sponsor: data.sponsor,
        tileIndices: data.tileIndices.slice(),
      });
    }

    // Reset cluster data but preserve sponsor clusters
    const sponsorClustersBackup = [];
    for (const cluster of this.clusterData) {
      if (cluster.isSponsorCluster) {
        sponsorClustersBackup.push(cluster);
      }
    }

    // Clear procedural cluster assignments from tileClusterMap (keep sponsor assignments)
    for (const tileIndex of this.tileClusterMap.keys()) {
      if (!this.sponsorTileIndices.has(tileIndex)) {
        this.tileClusterMap.delete(tileIndex);
      }
    }

    // Reset non-sponsor data
    this.clusterData = [];
    this.clusterColors.clear();
    this.clusterPatterns.clear();

    // Dispose old procedural textures
    for (const [clusterId, texture] of this.clusterTextures) {
      const wasSponsored = sponsorClustersBackup.some(
        (c) => c.id === clusterId,
      );
      if (!wasSponsored) {
        texture.dispose();
        this.clusterTextures.delete(clusterId);
      }
    }

    // Create new seeded RNG
    this.random = this._createSeededRandom(seed);

    // Regenerate procedural clusters (sponsor tiles are protected via sponsorTileIndices)
    this._generateClusters(this._tiles);

    // Re-add sponsor clusters with new IDs
    for (const backup of sponsorClustersBackup) {
      const newClusterId = this.clusterData.length;
      backup.id = newClusterId;
      this.clusterData.push(backup);

      // Update tileClusterMap for sponsor tiles
      for (const tileIndex of backup.tiles) {
        this.tileClusterMap.set(tileIndex, newClusterId);
      }

      // Update sponsorClusters map
      const sponsorClusterData = this.sponsorClusters.get(backup.sponsorId);
      if (sponsorClusterData) {
        sponsorClusterData.clusterId = newClusterId;
      }
    }

    // Update tile mesh materials for procedural clusters
    this._updateProceduralTileMaterials();

    // Reset capture state for procedural clusters
    this._initializeCaptureState();

    // Re-merge cluster tiles for draw call reduction
    this.mergeClusterTiles();
  }

  /**
   * Update materials for procedural (non-sponsor) tiles after scramble
   */
  _updateProceduralTileMaterials() {
    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || mesh.userData.isSponsorTile) return;

      const tileIndex = mesh.userData.tileIndex;
      if (tileIndex === undefined) return;
      if (this.sponsorTileIndices.has(tileIndex)) return;

      const clusterId = this.tileClusterMap.get(tileIndex);
      if (clusterId === undefined) return;

      const pattern = this.clusterPatterns.get(clusterId);
      if (!pattern) return;

      if (!this.clusterTextures.has(clusterId)) {
        this.clusterTextures.set(
          clusterId,
          this._createPatternTexture(pattern.type, pattern.grayValue),
        );
      }

      mesh.material.dispose();
      mesh.material = new THREE.MeshStandardMaterial({
        map: this.clusterTextures.get(clusterId),
        flatShading: false,
        roughness: 0.95,
        metalness: 0.02,
        side: THREE.FrontSide,
      });
      const cp = this._tiles[tileIndex].centerPoint;
      const center = new THREE.Vector3(parseFloat(cp.x), parseFloat(cp.y), parseFloat(cp.z));
      this._patchTriplanarNoise(mesh.material, center);
      const isElevated = this.terrainElevation &&
        this.terrainElevation.getElevationAtTileIndex(tileIndex) > 0;
      if (!isElevated) {
        this._patchIgnoreSpotLights(mesh.material);
      }
      mesh.userData.clusterId = clusterId;
    });
  }

  // ========================
  // TERRITORY CAPTURE
  // ========================

  getTicsRequired(clusterId) {
    const state = this.clusterCaptureState.get(clusterId);
    return state ? state.capacity : 0;
  }

  getCaptureProgress(clusterId) {
    const state = this.clusterCaptureState.get(clusterId);
    if (!state) return null;
    return {
      tics: { ...state.tics },
      owner: state.owner,
      capacity: state.capacity,
      momentum: { ...state.momentum },
    };
  }

  getClusterIdAtPosition(worldPosition) {
    // Find the closest tile center to the given world position
    // Account for planet rotation by transforming position into hexGroup local space
    const localPos = worldPosition.clone();
    this.hexGroup.worldToLocal(localPos);
    return this._getClusterIdAtLocalPosition(localPos);
  }

  getClusterIdAtLocalPosition(localPosition) {
    // For objects already in hexGroup's local coordinate space
    return this._getClusterIdAtLocalPosition(localPosition);
  }

  _getClusterIdAtLocalPosition(localPos) {
    let closestTileIndex = -1;
    let closestDist = Infinity;

    for (const tile of this.tileCenters) {
      const dist = localPos.distanceToSquared(tile.position);
      if (dist < closestDist) {
        closestDist = dist;
        closestTileIndex = tile.tileIndex;
      }
    }

    if (closestTileIndex >= 0) {
      return this.tileClusterMap.get(closestTileIndex);
    }
    return undefined;
  }

  updateClusterVisual(clusterId) {
    const state = this.clusterCaptureState.get(clusterId);
    if (!state) return;

    const previousOwner = this.clusterOwnership.get(clusterId) || null;
    const newOwner = state.owner;

    // Update ownership tracking
    if (newOwner) {
      this.clusterOwnership.set(clusterId, newOwner);
    } else {
      this.clusterOwnership.delete(clusterId);
    }

    // Only process visual changes when ownership actually changes
    if (previousOwner !== newOwner) {
      // Apply inner glow effect with transition animation (using light shade for visibility)
      const previousColor =
        previousOwner && FACTION_COLORS[previousOwner]
          ? FACTION_COLORS[previousOwner].threeLight
          : null;
      if (newOwner && FACTION_COLORS[newOwner]) {
        this.applyInnerGlowToCluster(
          clusterId,
          FACTION_COLORS[newOwner].threeLight,
          previousColor,
        );
      } else {
        this.applyInnerGlowToCluster(clusterId, null, previousColor);
      }
    }
  }

  // ========================
  // PORTAL HELPERS
  // ========================

  getPortalPosition(portalIndex) {
    const tile = this.tileCenters.find((tc) => tc.tileIndex === portalIndex);
    return tile ? tile.position.clone() : null;
  }

  getPortalNormal(portalIndex) {
    const position = this.getPortalPosition(portalIndex);
    return position ? position.normalize() : null;
  }

  getPortalNeighbors(portalIndex) {
    // Return adjacent tile indices for a portal
    if (!this._adjacencyMap) return [];
    return this._adjacencyMap.get(portalIndex) || [];
  }

  getPortalNeutralNeighbors(portalIndex) {
    // Return only the neutral territory tiles adjacent to a portal
    const neighbors = this.getPortalNeighbors(portalIndex);
    return neighbors.filter(
      (idx) =>
        this.portalTileIndices.has(idx) && !this.portalCenterIndices.has(idx),
    );
  }

  getTileIndexAtPosition(worldPosition) {
    // Find the closest tile to a world position
    const localPos = worldPosition.clone();
    this.hexGroup.worldToLocal(localPos);

    let closestTileIndex = -1;
    let closestDist = Infinity;

    for (const tile of this.tileCenters) {
      const dist = localPos.distanceToSquared(tile.position);
      if (dist < closestDist) {
        closestDist = dist;
        closestTileIndex = tile.tileIndex;
      }
    }
    return closestTileIndex;
  }

  isOnPortal(worldPosition) {
    const tileIndex = this.getTileIndexAtPosition(worldPosition);
    return this.portalCenterIndices.has(tileIndex) ? tileIndex : null;
  }

  getAllPortalCenters() {
    return Array.from(this.portalCenterIndices);
  }

  // ========================
  // TERRITORY / TIER HELPERS
  // ========================

  /**
   * Get or build the tier map for all tiles (lazy, cached).
   * Requires HexTierSystem to be loaded via index.html.
   * @returns {Map<number, string>|null} tileIndex → tier ID, or null if unavailable
   */
  getTierMap() {
    if (this._tierMap) return this._tierMap;
    if (typeof HexTierSystem === "undefined" || !this._tiles || !this._adjacencyMap) return null;

    this._tierMap = HexTierSystem.buildTierMap(
      this._tiles,
      this.radius,
      this._adjacencyMap,
    );
    return this._tierMap;
  }

  /**
   * Expand hex rings from a center tile using BFS on the adjacency map.
   * Ring 0 = center (1 tile), Ring 1 = +neighbors (7 total), Ring 2 = +outer ring (19 total).
   * @param {number} centerTileIndex - Starting tile
   * @param {number} ringCount - Number of rings to expand (0, 1, or 2)
   * @returns {number[]} Array of tile indices in the cluster
   */
  getHexRing(centerTileIndex, ringCount) {
    if (!this._adjacencyMap) return [centerTileIndex];

    const inCluster = new Set([centerTileIndex]);
    let currentRing = [centerTileIndex];

    for (let r = 0; r < ringCount; r++) {
      const nextRing = [];
      for (const tileIdx of currentRing) {
        const neighbors = this._adjacencyMap.get(tileIdx) || [];
        for (const neighbor of neighbors) {
          if (!inCluster.has(neighbor)) {
            inCluster.add(neighbor);
            nextRing.push(neighbor);
          }
        }
      }
      currentRing = nextRing;
    }

    return Array.from(inCluster);
  }

  /**
   * Highlight specific tiles on the planet with a color overlay.
   * Used to preview territory selections before claiming.
   * @param {number[]} tileIndices - Tile indices to highlight
   * @param {number} color - Hex color for the highlight (e.g. 0x00cccc)
   */
  highlightTiles(tileIndices, color = 0x00cccc) {
    if (!this.hexGroup) return;
    if (!this._highlightedTileIndices) this._highlightedTileIndices = new Set();

    const emissiveColor = 0x003333;

    for (const tileIndex of tileIndices) {
      const mesh = this.hexGroup.children.find(
        (m) => m.userData?.tileIndex === tileIndex,
      );
      if (!mesh) continue;

      // Save original state if not already saved
      if (mesh.userData._highlightOriginalColor === undefined) {
        mesh.userData._highlightOriginalColor = mesh.material.color.getHex();
        mesh.userData._highlightOriginalEmissive =
          mesh.material.emissive ? mesh.material.emissive.getHex() : 0x000000;
        mesh.userData._highlightWasMerged = mesh.userData._merged || false;
      }

      // Un-hide merged tiles so the highlight is visible
      if (mesh.userData._merged) {
        mesh.visible = true;
        mesh.material = mesh.material.clone();
        mesh.material.map = null;
        mesh.material.vertexColors = false;
        mesh.material.polygonOffset = true;
        mesh.material.polygonOffsetFactor = -1;
        mesh.material.polygonOffsetUnits = -1;
        mesh.material.needsUpdate = true;
      }

      mesh.material.color.setHex(color);
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(emissiveColor);
      }
      this._highlightedTileIndices.add(tileIndex);
    }
  }

  /**
   * Clear all highlighted tiles, restoring their original colors.
   */
  clearHighlightedTiles() {
    if (!this._highlightedTileIndices || this._highlightedTileIndices.size === 0) return;
    if (!this.hexGroup) return;

    for (const tileIndex of this._highlightedTileIndices) {
      const mesh = this.hexGroup.children.find(
        (m) => m.userData?.tileIndex === tileIndex,
      );
      if (!mesh) continue;

      if (mesh.userData._highlightOriginalColor !== undefined) {
        // Dispose the cloned highlight material and hide merged tiles again
        if (mesh.userData._highlightWasMerged) {
          mesh.material.dispose();
          // Restore original material from cluster
          const clusterId = mesh.userData.clusterId;
          const pattern = this.clusterPatterns.get(clusterId);
          const isElevated = this.terrainElevation &&
            this.terrainElevation.getElevationAtTileIndex(tileIndex) > 0;
          if (isElevated) {
            mesh.material = new THREE.MeshStandardMaterial({
              vertexColors: true,
              flatShading: false,
              roughness: 0.95,
              metalness: 0.02,
              side: THREE.FrontSide,
            });
          } else {
            const tex = this.clusterTextures.get(clusterId);
            mesh.material = new THREE.MeshStandardMaterial({
              map: tex || null,
              flatShading: false,
              roughness: pattern ? pattern.roughness : 0.95,
              metalness: pattern ? pattern.metalness : 0.02,
              side: THREE.FrontSide,
            });
          }
          const cp = this._tiles[tileIndex].centerPoint;
          const center = new THREE.Vector3(parseFloat(cp.x), parseFloat(cp.y), parseFloat(cp.z));
          this._patchTriplanarNoise(mesh.material, center);
          if (!isElevated) {
            this._patchIgnoreSpotLights(mesh.material);
          }
          mesh.material.color.setHex(mesh.userData._highlightOriginalColor);
          if (mesh.material.emissive) {
            mesh.material.emissive.setHex(mesh.userData._highlightOriginalEmissive || 0x000000);
          }
          mesh.visible = false;
        } else {
          mesh.material.color.setHex(mesh.userData._highlightOriginalColor);
          if (mesh.material.emissive) {
            mesh.material.emissive.setHex(mesh.userData._highlightOriginalEmissive || 0x000000);
          }
        }
        delete mesh.userData._highlightOriginalColor;
        delete mesh.userData._highlightOriginalEmissive;
        delete mesh.userData._highlightWasMerged;
      }
    }

    this._highlightedTileIndices.clear();
  }

  // ========================
  // SPONSOR CLUSTERS
  // ========================

  /**
   * Apply a sponsor configuration to create a sponsor cluster
   * This removes the selected tiles from their original clusters and creates a new sponsor cluster
   * @param {Object} sponsor - Sponsor configuration from storage
   */
  applySponsorCluster(sponsor) {
    if (!sponsor || !sponsor.cluster || !sponsor.cluster.tileIndices) {
      console.warn("Invalid sponsor configuration");
      return;
    }

    // Filter out neutral tiles (portals, poles) — never part of any cluster
    const tileIndices = sponsor.cluster.tileIndices.filter(t =>
      !this.portalTileIndices.has(t) && !this.polarTileIndices.has(t)
    );
    if (tileIndices.length === 0) return;

    // Create a new cluster ID for this sponsor
    const sponsorClusterId = this.clusterData.length;

    // Track which original clusters are affected
    const affectedClusters = new Set();

    // Remove tiles from original clusters and reassign to sponsor cluster
    for (const tileIndex of tileIndices) {
      const originalClusterId = this.tileClusterMap.get(tileIndex);
      if (originalClusterId !== undefined) {
        affectedClusters.add(originalClusterId);

        // Remove from original cluster's tile list
        const originalCluster = this.clusterData[originalClusterId];
        if (originalCluster) {
          originalCluster.tiles = originalCluster.tiles.filter(
            (t) => t !== tileIndex,
          );
        }
      }

      // Assign to sponsor cluster
      this.tileClusterMap.set(tileIndex, sponsorClusterId);
      // Mark as protected sponsor tile
      this.sponsorTileIndices.add(tileIndex);

      // Update the mesh's userData.clusterId so raycasting finds the sponsor
      const mesh = this.hexGroup.children.find(
        (m) => m.userData?.tileIndex === tileIndex,
      );
      if (mesh) {
        mesh.userData.clusterId = sponsorClusterId;
      }
    }

    // Create new cluster entry for sponsor
    this.clusterData.push({
      id: sponsorClusterId,
      tiles: tileIndices.slice(),
      isSponsorCluster: true,
      sponsorId: sponsor.id,
    });

    // Initialize capture state for sponsor cluster
    const capacity = tileIndices.length * 5;
    this.clusterCaptureState.set(sponsorClusterId, {
      tics: { rust: 0, cobalt: 0, viridian: 0 },
      owner: null,
      capacity: capacity,
      momentum: { rust: 0, cobalt: 0, viridian: 0 },
    });

    // Store sponsor cluster data
    this.sponsorClusters.set(sponsor.id, {
      sponsor: sponsor,
      clusterId: sponsorClusterId,
      tileIndices: tileIndices,
    });

    // Initialize hold timer
    this.sponsorHoldTimers.set(sponsor.id, {
      owner: null,
      capturedAt: null,
      holdDuration: 0,
    });

    // Apply sponsor pattern texture to tiles
    this._applySponsorTexture(sponsor, tileIndices);
  }

  /**
   * Clear all sponsor-specific state so sponsors can be cleanly re-applied.
   * Called before applyServerWorld() + applySponsorVisuals() during live reload.
   */
  /**
   * Remove a sponsor cluster and restore tiles to neighboring procedural clusters.
   * @param {string} sponsorId - The sponsor/territory ID to remove
   */
  removeSponsorCluster(sponsorId) {
    const sponsorEntry = this.sponsorClusters.get(sponsorId);
    if (!sponsorEntry) return;

    const { sponsor, clusterId, tileIndices } = sponsorEntry;

    // Remove sponsor texture from cache
    const patternSrc = sponsor?.patternImage || sponsor?.patternUrl;
    if (patternSrc && this._sponsorTextureCache.has(patternSrc)) {
      this._sponsorTextureCache.get(patternSrc).dispose();
      this._sponsorTextureCache.delete(patternSrc);
    }

    // Remove tiles from sponsorTileIndices
    for (const tileIndex of tileIndices) {
      this.sponsorTileIndices.delete(tileIndex);
    }

    // Remove capture state and ownership
    this.clusterCaptureState.delete(clusterId);
    this.clusterOwnership.delete(clusterId);

    // Clear the cluster data entry
    if (this.clusterData[clusterId]) {
      this.clusterData[clusterId].tiles = [];
      this.clusterData[clusterId].isSponsorCluster = false;
      this.clusterData[clusterId].sponsorId = null;
    }

    // Remove sponsor tracking
    this.sponsorClusters.delete(sponsorId);
    this.sponsorHoldTimers.delete(sponsorId);

    // Reassign orphaned tiles to neighboring procedural clusters
    const reassigned = new Set();
    for (const tileIndex of tileIndices) {
      const neighbors = this._adjacencyMap.get(tileIndex) || [];
      let bestCluster = undefined;
      for (const neighbor of neighbors) {
        const neighborCluster = this.tileClusterMap.get(neighbor);
        if (neighborCluster === undefined) continue;
        if (neighborCluster === clusterId) continue;
        const clusterEntry = this.clusterData[neighborCluster];
        if (clusterEntry && !clusterEntry.isSponsorCluster) {
          bestCluster = neighborCluster;
          break;
        }
      }

      if (bestCluster !== undefined) {
        this.tileClusterMap.set(tileIndex, bestCluster);
        this.clusterData[bestCluster].tiles.push(tileIndex);
        reassigned.add(tileIndex);
      }
    }

    // Second pass for any tiles that couldn't find a non-sponsor neighbor
    for (const tileIndex of tileIndices) {
      if (reassigned.has(tileIndex)) continue;
      const neighbors = this._adjacencyMap.get(tileIndex) || [];
      for (const neighbor of neighbors) {
        const neighborCluster = this.tileClusterMap.get(neighbor);
        if (neighborCluster !== undefined && neighborCluster !== clusterId) {
          this.tileClusterMap.set(tileIndex, neighborCluster);
          this.clusterData[neighborCluster].tiles.push(tileIndex);
          reassigned.add(tileIndex);
          break;
        }
      }
    }

    // Restore terrain elevation that was cleared when territory was first applied
    const restoredElevation = this.terrainElevation
      ? this.terrainElevation.restoreElevationForTiles(tileIndices)
      : new Set();

    // Rebuild meshes, restore procedural materials, and fix UVs for all removed tiles
    const affectedClusters = new Set();
    for (const tileIndex of tileIndices) {
      const newClusterId = this.tileClusterMap.get(tileIndex);
      if (newClusterId !== undefined) affectedClusters.add(newClusterId);

      const meshIdx = this.hexGroup.children.findIndex(
        (m) => m.userData?.tileIndex === tileIndex,
      );
      if (meshIdx === -1) continue;

      const oldMesh = this.hexGroup.children[meshIdx];
      const oldUserData = { ...oldMesh.userData };
      oldUserData.clusterId = newClusterId;
      oldUserData.isSponsorTile = false;
      delete oldUserData.sponsorId;

      oldMesh.geometry.dispose();
      oldMesh.material.dispose();
      this.hexGroup.remove(oldMesh);

      // Rebuild mesh geometry with correct vertices and UVs
      const tile = this._tiles[tileIndex];
      const boundary = tile.boundary;
      const n = boundary.length;
      const vertices = [];
      const uvs = [];

      const elevation = this.terrainElevation
        ? this.terrainElevation.getElevationAtTileIndex(tileIndex)
        : 0;
      const extrusionScale = this.terrainElevation
        ? this.terrainElevation.getExtrusion(elevation)
        : 1;
      const isElevated = extrusionScale > 1;

      // Build tangent-plane basis for elevated tile UVs
      let tanU, tanV;
      if (isElevated) {
        const cp = tile.centerPoint;
        const normal = new THREE.Vector3(
          parseFloat(cp.x), parseFloat(cp.y), parseFloat(cp.z),
        ).normalize();
        const up = Math.abs(normal.y) < 0.99
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
        tanU = new THREE.Vector3().crossVectors(up, normal).normalize();
        tanV = new THREE.Vector3().crossVectors(normal, tanU);
      }

      for (let i = 0; i < n; i++) {
        const origX = parseFloat(boundary[i].x);
        const origY = parseFloat(boundary[i].y);
        const origZ = parseFloat(boundary[i].z);
        vertices.push(origX * extrusionScale, origY * extrusionScale, origZ * extrusionScale);

        if (isElevated) {
          // Tangent-plane UVs for elevated rock textures
          const u = (origX * tanU.x + origY * tanU.y + origZ * tanU.z) / ROCK_TEXTURE_WORLD_SIZE;
          const v = (origX * tanV.x + origY * tanV.y + origZ * tanV.z) / ROCK_TEXTURE_WORLD_SIZE;
          uvs.push(u, v);
        } else {
          // Spherical UVs for ground-level procedural textures
          const r = Math.sqrt(origX * origX + origY * origY + origZ * origZ);
          const theta = Math.atan2(origZ, origX);
          const phi = Math.acos(origY / r);
          uvs.push((theta / Math.PI + 1) * 0.5 * 60.0, (phi / Math.PI) * 60.0);
        }
      }

      const indices = [];
      for (let i = 1; i < n - 1; i++) {
        indices.push(0, i, i + 1);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3),
      );
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      // Restore correct material based on elevation
      let material;
      if (isElevated) {
        // Elevated tiles use desaturated vertex colors
        const variation = (this.random() - 0.5) * 0.06;
        const gray = 0.42 + variation;
        const vertColors = [];
        for (let i = 0; i < n; i++) {
          vertColors.push(gray, gray, gray);
        }
        geometry.setAttribute(
          "color",
          new THREE.Float32BufferAttribute(vertColors, 3),
        );
        material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          flatShading: false,
          roughness: 0.95,
          metalness: 0.02,
          side: THREE.FrontSide,
        });
      } else if (newClusterId !== undefined) {
        // Ground-level tiles use procedural cluster pattern
        const pattern = this.clusterPatterns.get(newClusterId);
        if (pattern) {
          if (!this.clusterTextures.has(newClusterId)) {
            this.clusterTextures.set(
              newClusterId,
              this._createPatternTexture(pattern.type, pattern.grayValue),
            );
          }
          material = new THREE.MeshStandardMaterial({
            map: this.clusterTextures.get(newClusterId),
            flatShading: false,
            roughness: pattern.roughness,
            metalness: pattern.metalness,
            side: THREE.FrontSide,
          });
        }
      }
      if (!material) {
        material = new THREE.MeshStandardMaterial({
          color: 0x444444,
          flatShading: false,
          side: THREE.FrontSide,
        });
      }
      const _cp = tile.centerPoint;
      const tileCenter = new THREE.Vector3(parseFloat(_cp.x), parseFloat(_cp.y), parseFloat(_cp.z));
      this._patchTriplanarNoise(material, tileCenter);
      if (!isElevated) {
        this._patchIgnoreSpotLights(material);
      }

      const newMesh = new THREE.Mesh(geometry, material);
      newMesh.userData = oldUserData;
      newMesh.receiveShadow = true;
      newMesh.castShadow = true;
      this.hexGroup.add(newMesh);
    }

    // Rebuild cliff walls if any elevation was restored
    if (restoredElevation.size > 0 && this.terrainElevation) {
      this.terrainElevation.rebuildCliffWalls(this._tiles, this._adjacencyMap);
      this._createNoiseOverlay();
    }

    // Update capture state for clusters that gained tiles
    for (const affectedId of affectedClusters) {
      const cluster = this.clusterData[affectedId];
      if (!cluster) continue;
      const state = this.clusterCaptureState.get(affectedId);
      if (state) {
        state.capacity = cluster.tiles.length * 5;
      }
    }

  }

  clearSponsorData() {
    this.sponsorClusters.clear();
    this.sponsorHoldTimers.clear();
    this.sponsorTileIndices.clear();
  }

  /**
   * Dispose and clear all cached sponsor textures.
   * Must be called before preloadSponsorTextures() during live reload so that
   * updated images (served at the same URL with a new cache-bust param) are
   * re-fetched instead of served from the stale in-memory cache.
   */
  clearSponsorTextureCache() {
    for (const texture of this._sponsorTextureCache.values()) {
      texture.dispose();
    }
    this._sponsorTextureCache.clear();
    if (window._sponsorImageCache) window._sponsorImageCache.clear();
  }

  /**
   * Apply sponsor visuals from server-provided data.
   * Unlike applySponsorCluster(), this does NOT create new clusters or
   * reassign tiles — that's already done by applyServerWorld().
   * It only marks sponsor metadata, initializes hold timers, and applies textures.
   * @param {Array} sponsors - Array of sponsor objects with clusterId from server
   */
  applySponsorVisuals(sponsors, skipTextures = false) {
    for (const sponsor of sponsors) {
      if (!sponsor.cluster || !sponsor.cluster.tileIndices || sponsor.cluster.tileIndices.length === 0) continue;
      const clusterId = sponsor.clusterId;
      if (clusterId === undefined || clusterId === null) continue;

      // Filter out neutral tiles (portals, poles) — never part of any cluster
      const tileIndices = sponsor.cluster.tileIndices.filter(t =>
        !this.portalTileIndices.has(t) && !this.polarTileIndices.has(t)
      );
      if (tileIndices.length === 0) continue;

      // Mark tiles as sponsor tiles
      for (const tileIndex of tileIndices) {
        this.sponsorTileIndices.add(tileIndex);

        // Update mesh userData for raycasting
        const mesh = this.hexGroup.children.find(
          (m) => m.userData?.tileIndex === tileIndex,
        );
        if (mesh) {
          mesh.userData.clusterId = clusterId;
        }
      }

      // Mark cluster data entry as sponsor cluster
      if (this.clusterData[clusterId]) {
        this.clusterData[clusterId].isSponsorCluster = true;
        this.clusterData[clusterId].sponsorId = sponsor.id;
      }

      // Store sponsor tracking data
      this.sponsorClusters.set(sponsor.id, {
        sponsor: sponsor,
        clusterId: clusterId,
        tileIndices: tileIndices,
      });

      // Initialize hold timer
      this.sponsorHoldTimers.set(sponsor.id, {
        owner: null,
        capturedAt: null,
        holdDuration: 0,
      });

      // Apply sponsor pattern texture to tiles (Three.js visuals)
      if (!skipTextures) {
        this._applySponsorTexture(sponsor, tileIndices);
      }
    }

  }

  /**
   * Remove terrain elevation from all sponsor tiles, fix mesh geometry,
   * and rebuild cliff walls. Called after all sponsors have been applied.
   */
  deElevateSponsorTiles() {
    if (!this.terrainElevation || this.sponsorTileIndices.size === 0) return;

    // Clear elevation data for sponsor tiles (needed for offline mode
    // where data hasn't been cleared yet; no-op in multiplayer since
    // server already de-elevated before serializing the world payload)
    this.terrainElevation.clearElevationForTiles(this.sponsorTileIndices);

    // Rebuild meshes at ground level for ALL sponsor tiles.
    // In multiplayer, applyServerWorld() updates elevation data but not
    // the 3D meshes, so they remain elevated from local generation.
    let rebuilt = 0;
    for (const tileIndex of this.sponsorTileIndices) {
      const meshIdx = this.hexGroup.children.findIndex(
        (m) => m.userData?.tileIndex === tileIndex,
      );
      if (meshIdx === -1) continue;

      const oldMesh = this.hexGroup.children[meshIdx];
      const oldMaterial = oldMesh.material;
      const oldUserData = { ...oldMesh.userData };

      oldMesh.geometry.dispose();
      this.hexGroup.remove(oldMesh);

      // Rebuild at ground level (extrusionScale = 1)
      const tile = this._tiles[tileIndex];
      const boundary = tile.boundary;
      const n = boundary.length;
      const vertices = [];
      const uvs = [];

      for (let i = 0; i < n; i++) {
        const origX = parseFloat(boundary[i].x);
        const origY = parseFloat(boundary[i].y);
        const origZ = parseFloat(boundary[i].z);
        vertices.push(origX, origY, origZ);

        const r = Math.sqrt(origX * origX + origY * origY + origZ * origZ);
        const theta = Math.atan2(origZ, origX);
        const phi = Math.acos(origY / r);
        const scale = 60.0;
        uvs.push((theta / Math.PI + 1) * 0.5 * scale, (phi / Math.PI) * scale);
      }

      const indices = [];
      for (let i = 1; i < n - 1; i++) {
        indices.push(0, i, i + 1);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3),
      );
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      const newMesh = new THREE.Mesh(geometry, oldMaterial);
      newMesh.userData = oldUserData;
      newMesh.receiveShadow = true;
      newMesh.castShadow = true;
      this.hexGroup.add(newMesh);
      rebuilt++;
    }

    // Rebuild cliff walls with updated elevation data
    this.terrainElevation.rebuildCliffWalls(this._tiles, this._adjacencyMap);
    this._createNoiseOverlay();

    // Rebuild any existing faction overlays for sponsor clusters.
    // Overlays may have been created (via applyTerritoryState) before de-elevation,
    // so their geometry still references the old elevated vertex positions.
    for (const [, data] of this.sponsorClusters) {
      const clusterId = data.clusterId;
      const existingOverlay = this.clusterGlowOverlays.get(clusterId);
      if (existingOverlay) {
        const color = this._getOverlayColor(existingOverlay.material);
        this._removeClusterColorOverlay(clusterId);
        this._createClusterColorOverlay(clusterId, color);
      }
    }

  }

  /**
   * Preload all sponsor pattern images into the texture cache.
   * Returns a Promise that resolves when all textures are decoded and ready.
   * @param {Array} sponsors - Array of sponsor objects with patternImage fields
   * @returns {Promise<void>}
   */
  preloadSponsorTextures(sponsors, onProgress) {
    const toLoad = [];
    const queued = new Set();
    for (const sponsor of sponsors) {
      const src = sponsor.patternImage || sponsor.patternUrl;
      if (!src) continue;
      if (this._sponsorTextureCache.has(src)) continue;
      if (queued.has(src)) continue;
      queued.add(src);
      toLoad.push({ sponsor, src });
    }
    if (toLoad.length === 0) {
      if (onProgress) onProgress(1);
      return Promise.resolve();
    }
    const total = toLoad.length;
    let loaded = 0;
    const loads = toLoad.map(({ sponsor, src }) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const texture = new THREE.Texture(img);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;
        this._sponsorTextureCache.set(src, texture);
        // Store in global cache so moon/billboard can reuse the same image
        if (window._sponsorImageCache) window._sponsorImageCache.set(src, { img });
        loaded++;
        if (onProgress) onProgress(loaded / total);
        resolve();
      };
      img.onerror = () => {
        console.warn(`[Planet] Failed to preload sponsor texture for ${sponsor.name || sponsor.id}`);
        loaded++;
        if (onProgress) onProgress(loaded / total);
        resolve(); // Don't block on failures — fallback pattern will be used
      };
      img.src = src;
    }));
    return Promise.all(loads);
  }

  /**
   * Lazy-load sponsor textures in batches after the loading screen dismisses.
   * Each texture is applied to its tiles as it arrives.
   * @param {Array} sponsors - Array of sponsor objects with patternImage fields
   */
  lazyLoadSponsorTextures(sponsors) {
    const queue = [];
    const queued = new Set();
    for (const sponsor of sponsors) {
      const src = sponsor.patternImage || sponsor.patternUrl;
      if (!src) continue;
      if (this._sponsorTextureCache.has(src)) continue;
      if (queued.has(src)) continue;
      queued.add(src);
      queue.push({ sponsor, src });
    }
    if (queue.length === 0) return;

    const BATCH_SIZE = 4;
    let index = 0;
    const planet = this;

    const loadNext = () => {
      const batch = queue.slice(index, index + BATCH_SIZE);
      index += BATCH_SIZE;
      if (batch.length === 0) return;

      const promises = batch.map(({ sponsor, src }) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const texture = new THREE.Texture(img);
          texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
          texture.generateMipmaps = false;
          texture.minFilter = THREE.NearestFilter;
          texture.magFilter = THREE.NearestFilter;
          texture.needsUpdate = true;
          planet._sponsorTextureCache.set(src, texture);
          if (window._sponsorImageCache) window._sponsorImageCache.set(src, { img });

          const entry = planet.sponsorClusters.get(sponsor.id);
          if (entry) {
            planet._updateSponsorTileMaterialsTiled(entry.tileIndices, texture, sponsor);
          }
          resolve();
        };
        img.onerror = () => {
          console.warn(`[Planet] Failed to lazy-load sponsor texture: ${sponsor.name || sponsor.id}`);
          resolve();
        };
        img.src = src;
      }));

      Promise.all(promises).then(loadNext);
    };

    // Start after loading screen fade-out completes
    setTimeout(loadNext, 200);
  }

  /**
   * Apply sponsor pattern texture to tiles with spherical projection
   * The image top points north (toward +Y axis)
   * @param {Object} sponsor
   * @param {number[]} tileIndices
   */
  _applySponsorTexture(sponsor, tileIndices) {
    const src = sponsor.patternImage || sponsor.patternUrl;
    if (src) {
      // Use cached texture if available (preloaded during loading screen)
      const cached = this._sponsorTextureCache.get(src);
      if (cached) {
        // Defer to microtask: callers run deElevateSponsorTiles() after this,
        // which rebuilds meshes. UV mapping must target the rebuilt meshes.
        Promise.resolve().then(() => {
          this._updateSponsorTileMaterialsTiled(tileIndices, cached, sponsor);
        });
        return;
      }

      // Fallback: async load (shouldn't happen if preloadSponsorTextures was called)
      const img = new Image();
      img.onload = () => {
        const texture = new THREE.Texture(img);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.needsUpdate = true;

        this._sponsorTextureCache.set(src, texture);
        if (window._sponsorImageCache) window._sponsorImageCache.set(src, { img });
        this._updateSponsorTileMaterialsTiled(tileIndices, texture, sponsor);
      };
      img.src = src;
    } else {
      // Use a default sponsor pattern (distinct cyan/teal color)
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");

      // Teal base with diagonal stripes
      ctx.fillStyle = "#1a4a4a";
      ctx.fillRect(0, 0, 256, 256);

      ctx.strokeStyle = "#2a6a6a";
      ctx.lineWidth = 16;
      for (let i = -256; i < 512; i += 32) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 256, 256);
        ctx.stroke();
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;

      this._updateSponsorTileMaterialsTiled(tileIndices, texture, sponsor);
    }
  }

  /**
   * Update materials for sponsor tiles with tiled UV projection
   * Uses global spherical mapping for consistent textures across the planet
   * Top of image points north, textures tile seamlessly
   * @param {number[]} tileIndices
   * @param {THREE.Texture} texture
   * @param {Object} sponsor
   */
  _updateSponsorTileMaterialsTiled(tileIndices, texture, sponsor) {
    const tileSet = new Set(tileIndices);

    // Get pattern adjustment values (defaults if not set)
    const adjustment = sponsor.patternAdjustment || {};
    const scale = adjustment.scale || 1.0;
    const offsetX = adjustment.offsetX || 0;
    const offsetY = adjustment.offsetY || 0;

    // Calculate cluster center and tangent basis for local projection
    const clusterCenter = this._calculateClusterCenter(tileIndices);
    const { tanU, tanV } = this._calculateClusterTangentBasis(clusterCenter);
    const bounds = this._calculateClusterTangentBounds(tileIndices, tanU, tanV);

    const clusterWidth = bounds.maxU - bounds.minU;
    const clusterHeight = bounds.maxV - bounds.minV;

    // Get texture dimensions for aspect ratio calculation
    const textureWidth = texture.image ? texture.image.width : 256;
    const textureHeight = texture.image ? texture.image.height : 256;
    const textureAspect = textureWidth / textureHeight;

    // Calculate uniform scale factor for "contain" mode
    // Use the larger dimension to ensure the full texture fits without distortion
    // Texture tiles via RepeatWrapping to fill remaining space
    const uniformScale = Math.max(clusterWidth, clusterHeight * textureAspect);

    // Center the texture within the cluster bounds
    const centerU = (bounds.minU + bounds.maxU) / 2;
    const centerV = (bounds.minV + bounds.maxV) / 2;

    // Scale factor: at scale=1, texture fills the cluster once
    const uvScale = 1.0 / scale;

    // Create a single shared material for all tiles in this cluster
    const sharedMaterial = this._createHSVMaterial(
      texture,
      adjustment,
      tileIndices.length,
    );

    let tilesUpdated = 0;

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || !tileSet.has(mesh.userData.tileIndex)) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      tilesUpdated++;
      const positions = mesh.geometry.attributes.position.array;
      const newUvs = [];

      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];

        // Project onto cluster's tangent plane
        const localU = x * tanU.x + y * tanU.y + z * tanU.z;
        const localV = x * tanV.x + y * tanV.y + z * tanV.z;

        // Normalize using uniform scaling (contain mode - no distortion)
        // The texture fits entirely within bounds and tiles to fill extra space
        // NOTE: Swap u/v assignments - texture U maps to North (localV), texture V maps to East (localU)
        let u = ((localV - centerV) / uniformScale + 0.5) * uvScale;
        let v =
          (((localU - centerU) / uniformScale) * textureAspect + 0.5) * uvScale;

        // Apply offset
        u += offsetX * 0.5;
        v += offsetY * 0.5;

        newUvs.push(u, v);
      }

      // Update the geometry's UV attribute
      mesh.geometry.setAttribute(
        "uv",
        new THREE.Float32BufferAttribute(newUvs, 2),
      );
      mesh.geometry.attributes.uv.needsUpdate = true;

      // Use shared material for all tiles in this cluster
      mesh.material.dispose();
      mesh.material = sharedMaterial;
      mesh.userData.sponsorId = sponsor.id;
      mesh.userData.isSponsorTile = true;
    });
  }

  /**
   * Lightweight UV-only update for sponsor tiles.
   * Skips material/texture recreation — only recalculates UV coordinates.
   * Used for real-time scale/offset slider adjustments.
   * @param {number[]} tileIndices
   * @param {Object} adjustment - { scale, offsetX, offsetY }
   */
  _updateSponsorTileUVs(tileIndices, adjustment) {
    const tileSet = new Set(tileIndices);
    const scale = adjustment.scale || 1.0;
    const offsetX = adjustment.offsetX || 0;
    const offsetY = adjustment.offsetY || 0;

    const clusterCenter = this._calculateClusterCenter(tileIndices);
    const { tanU, tanV } = this._calculateClusterTangentBasis(clusterCenter);
    const bounds = this._calculateClusterTangentBounds(tileIndices, tanU, tanV);

    const clusterWidth = bounds.maxU - bounds.minU;
    const clusterHeight = bounds.maxV - bounds.minV;

    // Get texture aspect from existing material
    let textureAspect = 1;
    for (const mesh of this.hexGroup.children) {
      if (mesh.userData && tileSet.has(mesh.userData.tileIndex) && mesh.material?.map?.image) {
        textureAspect = mesh.material.map.image.width / mesh.material.map.image.height;
        break;
      }
    }

    const uniformScale = Math.max(clusterWidth, clusterHeight * textureAspect);
    const centerU = (bounds.minU + bounds.maxU) / 2;
    const centerV = (bounds.minV + bounds.maxV) / 2;
    const uvScale = 1.0 / scale;

    for (const mesh of this.hexGroup.children) {
      if (!mesh.userData || !tileSet.has(mesh.userData.tileIndex)) continue;
      if (!mesh.geometry?.attributes?.position) continue;

      const positions = mesh.geometry.attributes.position.array;
      const uvAttr = mesh.geometry.attributes.uv;
      const uvArray = uvAttr.array;

      for (let i = 0, vi = 0; i < positions.length; i += 3, vi += 2) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        const localU = x * tanU.x + y * tanU.y + z * tanU.z;
        const localV = x * tanV.x + y * tanV.y + z * tanV.z;

        uvArray[vi] = ((localV - centerV) / uniformScale + 0.5) * uvScale + offsetX * 0.5;
        uvArray[vi + 1] = (((localU - centerU) / uniformScale) * textureAspect + 0.5) * uvScale + offsetY * 0.5;
      }

      uvAttr.needsUpdate = true;
    }
  }

  /**
   * Create a MeshStandardMaterial with Photoshop-style levels adjustment
   * Pre-processes the texture on a canvas to apply input/output levels + gamma
   * @param {THREE.Texture} texture
   * @param {Object} adjustment - { inputBlack, inputGamma, inputWhite, outputBlack, outputWhite }
   * @param {number} tileCount - Number of tiles in the cluster (for pixel art resolution)
   * @returns {THREE.MeshBasicMaterial}
   */
  _createHSVMaterial(
    texture,
    adjustment = {},
    tileCount = 20,
  ) {
    // Apply levels adjustment then pixel art filter (downscale, palette, dither, upscale)
    let finalTexture = texture;
    if (texture.image) {
      finalTexture = this._applyLevelsAdjustment(
        texture.image,
        adjustment,
      );
      finalTexture = this._applyPixelArtFilter(finalTexture.image, tileCount);
      finalTexture.wrapS = texture.wrapS;
      finalTexture.wrapT = texture.wrapT;
    }

    const mat = new THREE.MeshStandardMaterial({
      map: finalTexture,
      roughness: 1.0,
      metalness: 0,
      side: THREE.FrontSide,
    });
    this._patchIgnoreSpotLights(mat);
    return mat;
  }

  /**
   * Apply Photoshop-style levels adjustment and saturation to an image
   * @param {HTMLImageElement|HTMLCanvasElement} image
   * @param {Object} adjustment - { inputBlack, inputGamma, inputWhite, outputBlack, outputWhite, saturation }
   * @returns {THREE.CanvasTexture}
   */
  _applyLevelsAdjustment(image, adjustment = {}) {
    // Get adjustment values with defaults
    const inputBlack = (adjustment.inputBlack ?? 0) / 255; // 0-1
    const inputWhite = (adjustment.inputWhite ?? 255) / 255; // 0-1
    const gamma = adjustment.inputGamma ?? 1.0; // 0.1-3.0
    const outputBlack = (adjustment.outputBlack ?? 0) / 255; // 0-1
    const outputWhite = (adjustment.outputWhite ?? 255) / 255; // 0-1
    const saturation = adjustment.saturation ?? 1.0; // 0-2 (1.0 = normal)

    // If all defaults, skip processing
    if (
      inputBlack === 0 &&
      inputWhite === 1 &&
      gamma === 1.0 &&
      outputBlack === 0 &&
      outputWhite === 1 &&
      saturation === 1.0
    ) {
      // Return a canvas texture of the original (pixel-perfect, no smoothing)
      const canvas = document.createElement("canvas");
      canvas.width = image.width || 256;
      canvas.height = image.height || 256;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.generateMipmaps = false;
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      return tex;
    }

    const canvas = document.createElement("canvas");
    canvas.width = image.width || 256;
    canvas.height = image.height || 256;
    const ctx = canvas.getContext("2d");

    // Draw original image
    ctx.drawImage(image, 0, 0);

    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Input range
    const inputRange = Math.max(0.001, inputWhite - inputBlack);
    // Output range
    const outputRange = outputWhite - outputBlack;
    // Gamma (inverted for correction)
    const gammaInv = 1 / gamma;

    // Process each pixel with Photoshop levels formula + saturation
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i] / 255;
      let g = data[i + 1] / 255;
      let b = data[i + 2] / 255;

      // Step 1: Apply input levels (remap inputBlack-inputWhite to 0-1)
      r = Math.max(0, Math.min(1, (r - inputBlack) / inputRange));
      g = Math.max(0, Math.min(1, (g - inputBlack) / inputRange));
      b = Math.max(0, Math.min(1, (b - inputBlack) / inputRange));

      // Step 2: Apply gamma correction
      r = Math.pow(r, gammaInv);
      g = Math.pow(g, gammaInv);
      b = Math.pow(b, gammaInv);

      // Step 3: Apply output levels (remap 0-1 to outputBlack-outputWhite)
      r = outputBlack + r * outputRange;
      g = outputBlack + g * outputRange;
      b = outputBlack + b * outputRange;

      // Step 4: Apply saturation adjustment
      // Convert to grayscale luminance (perceptual weights)
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // Interpolate between grayscale and color based on saturation
      r = luma + saturation * (r - luma);
      g = luma + saturation * (g - luma);
      b = luma + saturation * (b - luma);

      // Clamp and write back
      data[i] = Math.max(0, Math.min(255, r * 255));
      data[i + 1] = Math.max(0, Math.min(255, g * 255));
      data[i + 2] = Math.max(0, Math.min(255, b * 255));
    }

    ctx.putImageData(imageData, 0, 0);

    const processedTexture = new THREE.CanvasTexture(canvas);
    processedTexture.generateMipmaps = false;
    processedTexture.minFilter = THREE.NearestFilter;
    processedTexture.magFilter = THREE.NearestFilter;
    processedTexture.needsUpdate = true;
    return processedTexture;
  }

  /**
   * Apply pixel art filter: reduce resolution, limit to 16 colors, apply dithering
   * @param {HTMLImageElement|HTMLCanvasElement} image
   * @returns {THREE.CanvasTexture}
   */
  _applyPixelArtFilter(image, tileCount = 20) {
    // Scale resolution with territory size so pixel blocks appear the same physical size
    // Reference: 20 tiles = 128px. Sqrt because pixel dimension scales with sqrt(area)
    const baseShortSide = 128;
    const referenceTileCount = 20;
    const targetShortSide = Math.round(
      Math.max(64, Math.min(256, baseShortSide * Math.sqrt(tileCount / referenceTileCount)))
    );
    const maxColors = 8; // Limit to 8-color palette for retro look
    const ditherIntensity = 32;

    // Calculate target dimensions (short side = 64, long side scales proportionally)
    const srcWidth = image.width || 256;
    const srcHeight = image.height || 256;
    const aspect = srcWidth / srcHeight;

    let targetWidth, targetHeight;
    if (srcWidth <= srcHeight) {
      targetWidth = targetShortSide;
      targetHeight = Math.round(targetShortSide / aspect);
    } else {
      targetHeight = targetShortSide;
      targetWidth = Math.round(targetShortSide * aspect);
    }

    // Step 1: Downscale with no antialiasing
    const downCanvas = document.createElement("canvas");
    downCanvas.width = targetWidth;
    downCanvas.height = targetHeight;
    const downCtx = downCanvas.getContext("2d");
    downCtx.imageSmoothingEnabled = false;
    downCtx.drawImage(image, 0, 0, targetWidth, targetHeight);

    const imageData = downCtx.getImageData(0, 0, targetWidth, targetHeight);
    const data = imageData.data;

    // Step 2: Extract palette from most frequent colors in the image
    // Group similar colors into buckets, then pick representative color from each bucket
    const colorBuckets = new Map(); // quantized key → { count, sumR, sumG, sumB }
    for (let i = 0; i < data.length; i += 4) {
      // Quantize to group similar colors (bucket size = 32 for better grouping)
      const qr = Math.floor(data[i] / 32) * 32;
      const qg = Math.floor(data[i + 1] / 32) * 32;
      const qb = Math.floor(data[i + 2] / 32) * 32;
      const key = `${qr},${qg},${qb}`;

      const bucket = colorBuckets.get(key) || {
        count: 0,
        sumR: 0,
        sumG: 0,
        sumB: 0,
      };
      bucket.count++;
      bucket.sumR += data[i];
      bucket.sumG += data[i + 1];
      bucket.sumB += data[i + 2];
      colorBuckets.set(key, bucket);
    }

    // Sort buckets by frequency and take top colors
    // Use average color of each bucket for better accuracy
    const palette = Array.from(colorBuckets.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, maxColors)
      .map((bucket) => [
        Math.round(bucket.sumR / bucket.count),
        Math.round(bucket.sumG / bucket.count),
        Math.round(bucket.sumB / bucket.count),
      ]);

    if (palette.length === 0) palette.push([128, 128, 128]);

    // Step 3: Apply ordered dithering and map to palette
    const bayerMatrix4x4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];

    for (let y = 0; y < targetHeight; y++) {
      for (let x = 0; x < targetWidth; x++) {
        const i = (y * targetWidth + x) * 4;
        const threshold =
          (bayerMatrix4x4[y % 4][x % 4] / 16.0 - 0.5) * ditherIntensity;

        const r = Math.max(0, Math.min(255, data[i] + threshold));
        const g = Math.max(0, Math.min(255, data[i + 1] + threshold));
        const b = Math.max(0, Math.min(255, data[i + 2] + threshold));

        // Find closest palette color
        let minDist = Infinity;
        let closest = palette[0];
        for (const color of palette) {
          const dr = r - color[0];
          const dg = g - color[1];
          const db = b - color[2];
          const dist = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
          if (dist < minDist) {
            minDist = dist;
            closest = color;
          }
        }

        data[i] = closest[0];
        data[i + 1] = closest[1];
        data[i + 2] = closest[2];
      }
    }

    downCtx.putImageData(imageData, 0, 0);

    // Step 4: Scale up to 4x intermediate (512px short side) — crisp pixel blocks
    const upScale = Math.ceil(512 / Math.min(targetWidth, targetHeight));
    const upWidth = targetWidth * upScale;
    const upHeight = targetHeight * upScale;
    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = upWidth;
    finalCanvas.height = upHeight;
    const finalCtx = finalCanvas.getContext("2d");
    finalCtx.imageSmoothingEnabled = false;
    finalCtx.drawImage(downCanvas, 0, 0, upWidth, upHeight);

    const processedTexture = new THREE.CanvasTexture(finalCanvas);
    processedTexture.generateMipmaps = false;
    processedTexture.magFilter = THREE.NearestFilter;
    processedTexture.minFilter = THREE.NearestFilter;
    processedTexture.needsUpdate = true;
    return processedTexture;
  }

  /**
   * Process an image with saturation and output levels adjustments
   * @param {HTMLImageElement|HTMLCanvasElement} image
   * @param {number} saturation - 0 to 2 (1 = normal)
   * @param {number} outputBlack - 0 to 1 (output black point)
   * @param {number} outputWhite - 0 to 1 (output white point)
   * @returns {THREE.CanvasTexture}
   */
  _processTextureWithColorAdjustments(
    image,
    saturation,
    outputBlack,
    outputWhite,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = image.width || 256;
    canvas.height = image.height || 256;
    const ctx = canvas.getContext("2d");

    // Draw original image
    ctx.drawImage(image, 0, 0);

    // Get image data
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Process each pixel
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i] / 255;
      let g = data[i + 1] / 255;
      let b = data[i + 2] / 255;

      // Apply saturation
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      r = luminance + (r - luminance) * saturation;
      g = luminance + (g - luminance) * saturation;
      b = luminance + (b - luminance) * saturation;

      // Apply output levels
      const range = outputWhite - outputBlack;
      r = outputBlack + r * range;
      g = outputBlack + g * range;
      b = outputBlack + b * range;

      // Clamp and write back
      data[i] = Math.max(0, Math.min(255, r * 255));
      data[i + 1] = Math.max(0, Math.min(255, g * 255));
      data[i + 2] = Math.max(0, Math.min(255, b * 255));
    }

    // Apply PS1-style ordered dithering for retro pixelated look
    const bayerMatrix4x4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];

    const ditherIntensity = 32; // Controls dither strength (higher = more visible)
    const colorDepth = 32; // 5 bits per channel (2^5 = 32 levels) for PS1 look

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;

        // Get Bayer matrix threshold value (0-15) normalized to -0.5 to 0.5
        const threshold =
          (bayerMatrix4x4[y % 4][x % 4] / 16.0 - 0.5) * ditherIntensity;

        // Apply ordered dithering and reduce color depth for each channel
        for (let c = 0; c < 3; c++) {
          // R, G, B channels
          const value = data[i + c] + threshold;
          // Quantize to reduced color depth
          data[i + c] =
            Math.floor((value / 255) * (colorDepth - 1)) *
            (255 / (colorDepth - 1));
          // Clamp to valid range
          data[i + c] = Math.max(0, Math.min(255, data[i + c]));
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);

    const processedTexture = new THREE.CanvasTexture(canvas);
    processedTexture.minFilter = THREE.NearestFilter;
    processedTexture.magFilter = THREE.NearestFilter;
    processedTexture.needsUpdate = true;
    return processedTexture;
  }

  /**
   * Calculate the center point of a cluster of tiles
   * @param {number[]} tileIndices
   * @returns {THREE.Vector3}
   */
  _calculateClusterCenter(tileIndices) {
    const tileSet = new Set(tileIndices);
    let sumX = 0,
      sumY = 0,
      sumZ = 0;
    let count = 0;

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || mesh.userData.tileIndex === undefined) return;
      if (!tileSet.has(mesh.userData.tileIndex)) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      const positions = mesh.geometry.attributes.position.array;
      let tileX = 0,
        tileY = 0,
        tileZ = 0;
      const vertCount = positions.length / 3;

      for (let j = 0; j < positions.length; j += 3) {
        tileX += positions[j];
        tileY += positions[j + 1];
        tileZ += positions[j + 2];
      }

      sumX += tileX / vertCount;
      sumY += tileY / vertCount;
      sumZ += tileZ / vertCount;
      count++;
    });

    if (count === 0) {
      return new THREE.Vector3(0, 1, 0).multiplyScalar(this.radius);
    }

    const center = new THREE.Vector3(sumX / count, sumY / count, sumZ / count);
    center.normalize().multiplyScalar(this.radius);
    return center;
  }

  /**
   * Calculate tangent basis vectors for a cluster
   * tanU points East, tanV points North
   * @param {THREE.Vector3} center - Cluster center point
   * @returns {{ tanU: THREE.Vector3, tanV: THREE.Vector3 }}
   */
  _calculateClusterTangentBasis(center) {
    // Normal at cluster center (pointing outward from sphere)
    const normal = center.clone().normalize();

    // "Up" direction (toward north pole)
    const up = new THREE.Vector3(0, 1, 0);

    // tanV = North direction (perpendicular to both normal and up)
    let tanV = new THREE.Vector3().crossVectors(up, normal);
    if (tanV.lengthSq() < 0.001) {
      // Cluster is near a pole, use a different reference
      tanV = new THREE.Vector3(1, 0, 0);
    }
    tanV.normalize();

    // tanU = East direction (perpendicular to normal and tanV)
    const tanU = new THREE.Vector3().crossVectors(normal, tanV);
    tanU.normalize();

    return { tanU, tanV };
  }

  /**
   * Calculate the bounding box of the cluster in tangent space
   * @param {number[]} tileIndices
   * @param {THREE.Vector3} tanU - East tangent vector
   * @param {THREE.Vector3} tanV - North tangent vector
   * @returns {{ minU: number, maxU: number, minV: number, maxV: number }}
   */
  _calculateClusterTangentBounds(tileIndices, tanU, tanV) {
    const tileSet = new Set(tileIndices);
    let minU = Infinity,
      maxU = -Infinity;
    let minV = Infinity,
      maxV = -Infinity;

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || mesh.userData.tileIndex === undefined) return;
      if (!tileSet.has(mesh.userData.tileIndex)) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      const positions = mesh.geometry.attributes.position.array;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i],
          y = positions[i + 1],
          z = positions[i + 2];
        const localU = x * tanU.x + y * tanU.y + z * tanU.z;
        const localV = x * tanV.x + y * tanV.y + z * tanV.z;
        minU = Math.min(minU, localU);
        maxU = Math.max(maxU, localU);
        minV = Math.min(minV, localV);
        maxV = Math.max(maxV, localV);
      }
    });

    // Add small padding to prevent edge artifacts
    const padU = (maxU - minU) * 0.02;
    const padV = (maxV - minV) * 0.02;

    return {
      minU: minU - padU,
      maxU: maxU + padU,
      minV: minV - padV,
      maxV: maxV + padV,
    };
  }

  /**
   * Update sponsor cluster visual based on capture state
   * Uses inner glow effect from edges toward center with transition animations
   * @param {string} sponsorId
   * @param {string|null} previousOwner - The previous owner (for transition animations)
   */
  updateSponsorClusterVisual(sponsorId, previousOwner = null) {
    const sponsorCluster = this.sponsorClusters.get(sponsorId);
    if (!sponsorCluster) return;

    const state = this.clusterCaptureState.get(sponsorCluster.clusterId);
    if (!state) return;

    const newOwner = state.owner;

    // Only process visual changes when ownership actually changes
    if (previousOwner !== newOwner) {
      // Apply inner glow effect with transition animation (using light shade for visibility)
      const previousColor =
        previousOwner && FACTION_COLORS[previousOwner]
          ? FACTION_COLORS[previousOwner].threeLight
          : null;
      if (newOwner && FACTION_COLORS[newOwner]) {
        this.applyInnerGlowToCluster(
          sponsorCluster.clusterId,
          FACTION_COLORS[newOwner].threeLight,
          previousColor,
        );
      } else {
        this.applyInnerGlowToCluster(
          sponsorCluster.clusterId,
          null,
          previousColor,
        );
      }
    }
  }

  /**
   * Update hold timer for a sponsor cluster
   * Called every second from the capture update loop
   * @param {string} sponsorId
   * @param {string|null} currentOwner
   */
  updateSponsorHoldTimer(sponsorId, currentOwner) {
    const timer = this.sponsorHoldTimers.get(sponsorId);
    if (!timer) return;

    if (currentOwner && currentOwner === timer.owner) {
      // Same owner - increment hold duration
      timer.holdDuration += 1000; // 1 second in ms
    } else if (currentOwner && currentOwner !== timer.owner) {
      // New owner - reset timer
      timer.owner = currentOwner;
      timer.capturedAt = Date.now();
      timer.holdDuration = 0;
    }
  }

  /**
   * Get hold duration for a sponsor cluster
   * @param {string} sponsorId
   * @returns {{ owner: string|null, holdDuration: number, capturedAt: number|null }}
   */
  getSponsorHoldStatus(sponsorId) {
    return (
      this.sponsorHoldTimers.get(sponsorId) || {
        owner: null,
        holdDuration: 0,
        capturedAt: null,
      }
    );
  }

  /**
   * Check if any reward milestones have been reached for a sponsor
   * @param {string} sponsorId
   * @returns {Object[]} Array of triggered rewards
   */
  checkSponsorRewardMilestones(sponsorId) {
    const sponsorCluster = this.sponsorClusters.get(sponsorId);
    if (!sponsorCluster) return [];

    const timer = this.sponsorHoldTimers.get(sponsorId);
    if (!timer || !timer.owner) return [];

    const sponsor = sponsorCluster.sponsor;
    if (!sponsor.rewards) return [];

    const holdMs = timer.holdDuration;
    const triggeredRewards = [];

    // Hold duration milestones in milliseconds
    const holdMilestones = {
      hold_1m: 60 * 1000,
      hold_5m: 5 * 60 * 1000,
      hold_10m: 10 * 60 * 1000,
      hold_1h: 60 * 60 * 1000,
      hold_6h: 6 * 60 * 60 * 1000,
      hold_12h: 12 * 60 * 60 * 1000,
      hold_24h: 24 * 60 * 60 * 1000,
    };

    for (const reward of sponsor.rewards) {
      if (reward.accomplishment === "capture") {
        // Capture reward triggers immediately on capture
        // Would need separate tracking for "first capture" logic
        continue;
      }

      const requiredMs = holdMilestones[reward.accomplishment];
      if (requiredMs && holdMs >= requiredMs) {
        triggeredRewards.push({
          sponsorId: sponsorId,
          sponsorName: sponsor.name,
          reward: reward,
          holdDuration: holdMs,
          owner: timer.owner,
        });
      }
    }

    return triggeredRewards;
  }

  /**
   * Get sponsor cluster ID from sponsor ID
   * @param {string} sponsorId
   * @returns {number|null}
   */
  getSponsorClusterId(sponsorId) {
    const sponsorCluster = this.sponsorClusters.get(sponsorId);
    return sponsorCluster ? sponsorCluster.clusterId : null;
  }

  /**
   * Get sponsor info for a cluster
   * @param {number} clusterId
   * @returns {Object|null}
   */
  getSponsorForCluster(clusterId) {
    const cluster = this.clusterData[clusterId];
    if (!cluster || !cluster.isSponsorCluster) return null;

    const sponsorCluster = this.sponsorClusters.get(cluster.sponsorId);
    return sponsorCluster ? sponsorCluster.sponsor : null;
  }

  /**
   * Get all sponsor clusters
   * @returns {Map}
   */
  getAllSponsorClusters() {
    return this.sponsorClusters;
  }

  /**
   * Initialize occupancy history for a cluster
   * @param {number} clusterId
   */
  initializeOccupancyHistory(clusterId) {
    if (!this.clusterOccupancyHistory.has(clusterId)) {
      this.clusterOccupancyHistory.set(clusterId, {
        rust: 0,
        cobalt: 0,
        viridian: 0,
        unclaimed: 0,
      });
    }
  }

  /**
   * Update occupancy history for a cluster (call every second)
   * @param {number} clusterId
   * @param {string|null} currentOwner - 'rust', 'cobalt', 'viridian', or null
   * @param {number} deltaMs - Time elapsed in milliseconds (default 1000)
   */
  updateOccupancyHistory(clusterId, currentOwner, deltaMs = 1000) {
    this.initializeOccupancyHistory(clusterId);
    const history = this.clusterOccupancyHistory.get(clusterId);

    if (currentOwner && history[currentOwner] !== undefined) {
      history[currentOwner] += deltaMs;
    } else {
      history.unclaimed += deltaMs;
    }
  }

  /**
   * Get occupancy history for a cluster
   * @param {number} clusterId
   * @returns {{ rust: number, cobalt: number, viridian: number, unclaimed: number }}
   */
  getOccupancyHistory(clusterId) {
    return (
      this.clusterOccupancyHistory.get(clusterId) || {
        rust: 0,
        cobalt: 0,
        viridian: 0,
        unclaimed: 0,
      }
    );
  }

  // ========================
  // INNER GLOW EFFECT (Overlay Approach)
  // ========================

  /**
   * Calculate the boundary edges of a cluster (edges not shared with other cluster tiles)
   * @param {number[]} tileIndices - Array of tile indices in the cluster
   * @returns {Array<{v1: THREE.Vector3, v2: THREE.Vector3}>} Array of boundary edges
   */
  _calculateClusterBoundaryEdges(tileIndices) {
    const tileSet = new Set(tileIndices);
    const boundaryEdges = [];

    for (const tileIdx of tileIndices) {
      const tile = this._tiles[tileIdx];
      if (!tile) continue;

      const boundary = tile.boundary;

      for (let i = 0; i < boundary.length; i++) {
        const v1 = boundary[i];
        const v2 = boundary[(i + 1) % boundary.length];

        // Check if this edge is shared with another tile in the cluster
        const isShared = this._isEdgeSharedWithTileSet(
          tileIdx,
          v1,
          v2,
          tileSet,
        );

        if (!isShared) {
          // This is a boundary edge - apply terrain elevation scaling
          const es = this.terrainElevation
            ? this.terrainElevation.getExtrusion(
                this.terrainElevation.getElevationAtTileIndex(tileIdx),
              )
            : 1;
          boundaryEdges.push({
            v1: new THREE.Vector3(
              parseFloat(v1.x) * es,
              parseFloat(v1.y) * es,
              parseFloat(v1.z) * es,
            ),
            v2: new THREE.Vector3(
              parseFloat(v2.x) * es,
              parseFloat(v2.y) * es,
              parseFloat(v2.z) * es,
            ),
          });
        }
      }
    }

    return boundaryEdges;
  }

  /**
   * Calculate the minimum distance from a point to any boundary edge
   * @param {THREE.Vector3} point - The point to measure from
   * @param {Array<{v1: THREE.Vector3, v2: THREE.Vector3}>} boundaryEdges - Cluster boundary edges
   * @returns {number} Minimum distance to boundary
   */
  _distanceToNearestBoundaryEdge(point, boundaryEdges) {
    let minDist = Infinity;

    for (const edge of boundaryEdges) {
      const dist = this._distanceToLineSegment(point, edge.v1, edge.v2);
      minDist = Math.min(minDist, dist);
    }

    return minDist;
  }

  /**
   * Calculate distance from a point to a line segment
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} lineStart
   * @param {THREE.Vector3} lineEnd
   * @returns {number}
   */
  _distanceToLineSegment(point, lineStart, lineEnd) {
    const line = lineEnd.clone().sub(lineStart);
    const lineLength = line.length();

    if (lineLength < 0.0001) {
      return point.distanceTo(lineStart);
    }

    const lineDir = line.normalize();
    const toPoint = point.clone().sub(lineStart);

    // Project point onto line
    let t = toPoint.dot(lineDir);
    t = Math.max(0, Math.min(lineLength, t)); // Clamp to segment

    // Closest point on segment
    const closest = lineStart.clone().add(lineDir.multiplyScalar(t));
    return point.distanceTo(closest);
  }

  /**
   * Calculate the maximum distance any vertex can be from the boundary (cluster "radius")
   * @param {number[]} tileIndices
   * @param {Array<{v1: THREE.Vector3, v2: THREE.Vector3}>} boundaryEdges
   * @returns {number}
   */
  _calculateClusterMaxBoundaryDistance(tileIndices, boundaryEdges) {
    const tileSet = new Set(tileIndices);
    let maxDist = 0;

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || !tileSet.has(mesh.userData.tileIndex)) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      const positions = mesh.geometry.attributes.position.array;
      for (let i = 0; i < positions.length; i += 3) {
        const point = new THREE.Vector3(
          positions[i],
          positions[i + 1],
          positions[i + 2],
        );
        const dist = this._distanceToNearestBoundaryEdge(point, boundaryEdges);
        maxDist = Math.max(maxDist, dist);
      }
    });

    return maxDist;
  }

  // ========================================================================
  // SPONSOR OUTLINE SYSTEM - 1px screen-space outlines for sponsored territories
  // ========================================================================

  /**
   * Build and add a 1px outline around a sponsor cluster's boundary edges.
   * Uses THREE.LineSegments which WebGL renders at exactly 1px screen-space.
   * @param {string} sponsorId
   */
  _buildSponsorOutline(sponsorId) {
    // Remove existing outline for this sponsor if any
    this._removeSponsorOutline(sponsorId);

    const entry = this.sponsorClusters.get(sponsorId);
    if (!entry) return;

    const tileIndices = entry.tileIndices;
    const tileSet = new Set(tileIndices);
    const zOffset = 0.015; // Slightly above border glow (0.012)

    const positions = [];

    for (const tileIdx of tileIndices) {
      const tile = this._tiles[tileIdx];
      if (!tile) continue;

      const boundary = tile.boundary;

      // Terrain elevation scaling
      const es = this.terrainElevation
        ? this.terrainElevation.getExtrusion(
            this.terrainElevation.getElevationAtTileIndex(tileIdx),
          )
        : 1;

      for (let i = 0; i < boundary.length; i++) {
        const v1 = boundary[i];
        const v2 = boundary[(i + 1) % boundary.length];

        // Check if this edge is on the sponsor boundary
        if (this._isEdgeFactionBoundary(tileIdx, v1, v2, tileSet)) {
          // Apply elevation and radial z-offset
          const p1 = new THREE.Vector3(
            parseFloat(v1.x) * es,
            parseFloat(v1.y) * es,
            parseFloat(v1.z) * es,
          );
          const p2 = new THREE.Vector3(
            parseFloat(v2.x) * es,
            parseFloat(v2.y) * es,
            parseFloat(v2.z) * es,
          );

          // Offset outward along surface normal to prevent z-fighting
          const n1 = p1.clone().normalize().multiplyScalar(zOffset);
          const n2 = p2.clone().normalize().multiplyScalar(zOffset);
          p1.add(n1);
          p2.add(n2);

          // Line segment pair
          positions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
    }

    if (positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );

    const material = new THREE.LineBasicMaterial({
      color: 0x555555,
      depthTest: true,
      depthWrite: false,
    });

    const lineSegments = new THREE.LineSegments(geometry, material);
    lineSegments.renderOrder = 3; // Above border glow (renderOrder 2)
    this.scene.add(lineSegments);
    this.sponsorOutlines.set(sponsorId, lineSegments);
  }

  /**
   * Remove and dispose the outline for a sponsor cluster.
   * @param {string} sponsorId
   */
  _removeSponsorOutline(sponsorId) {
    const outline = this.sponsorOutlines.get(sponsorId);
    if (!outline) return;
    this.scene.remove(outline);
    outline.geometry.dispose();
    outline.material.dispose();
    this.sponsorOutlines.delete(sponsorId);
  }

  /**
   * Remove and dispose all sponsor outlines.
   */
  _removeAllSponsorOutlines() {
    for (const [sponsorId, outline] of this.sponsorOutlines) {
      this.scene.remove(outline);
      outline.geometry.dispose();
      outline.material.dispose();
    }
    this.sponsorOutlines.clear();
  }

  // ========================================================================
  // BORDER GLOW SYSTEM - Faction territory visualization with fading border
  // ========================================================================

  /**
   * Create shader material for border band effect
   * Uses distance-from-edge attribute to fade the band inward
   * @param {THREE.Color} factionColor - The faction's base color
   * @returns {THREE.ShaderMaterial}
   */
  _createBorderGlowMaterial(factionColor) {
    // Use faction color directly (no modification)
    const bandColor = factionColor.clone();

    return new THREE.ShaderMaterial({
      uniforms: {
        bandColor: { value: bandColor },
        opacity: { value: BORDER_GLOW_CONFIG.baseOpacity },
        fadeExponent: { value: BORDER_GLOW_CONFIG.fadeExponent },
        time: { value: 0 },
        pulseIntensity: { value: 0 },
      },
      vertexShader: `
                attribute float distanceFromEdge;
                varying float vDistance;
                varying vec3 vWorldPosition;

                void main() {
                    vDistance = distanceFromEdge;
                    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
      fragmentShader: `
                uniform vec3 bandColor;
                uniform float opacity;
                uniform float fadeExponent;
                uniform float time;
                uniform float pulseIntensity;

                varying float vDistance;
                varying vec3 vWorldPosition;

                void main() {
                    // Far-side culling: discard fragments on the back of the planet
                    vec3 surfNorm = normalize(vWorldPosition);
                    vec3 camToFrag = normalize(vWorldPosition - cameraPosition);
                    if (dot(surfNorm, camToFrag) > 0.15) discard;

                    // Smooth fade: solid at edge (0), transparent at inner (1)
                    float fade = 1.0 - pow(vDistance, fadeExponent);
                    fade = clamp(fade, 0.0, 1.0);

                    // Pulse animation: bright flash + rapid shimmer on capture pulse
                    float pulse = 1.0 + pulseIntensity * (0.3 + 0.2 * sin(time * 8.0));

                    // Alpha fades smoothly to 0 at inner edge
                    float alpha = fade * opacity * pulse;

                    gl_FragColor = vec4(bandColor, alpha);
                }
            `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.NormalBlending, // Normal blend for solid faction color
    });
  }

  /**
   * Check if an edge is on the faction boundary (borders non-faction territory)
   * @param {number} tileIdx - The tile index
   * @param {Object} v1 - First vertex of edge
   * @param {Object} v2 - Second vertex of edge
   * @param {Set<number>} factionTiles - Set of tile indices owned by the faction
   * @returns {boolean}
   */
  _isEdgeFactionBoundary(tileIdx, v1, v2, factionTiles) {
    const key1 = `${v1.x},${v1.y},${v1.z}`;
    const key2 = `${v2.x},${v2.y},${v2.z}`;

    const neighbors = this._adjacencyMap.get(tileIdx) || [];
    for (const neighborIdx of neighbors) {
      // If neighbor is also faction-owned, check if they share this edge
      if (factionTiles.has(neighborIdx)) {
        const neighborBoundary = this._tiles[neighborIdx].boundary;
        for (let j = 0; j < neighborBoundary.length; j++) {
          const nv1 = neighborBoundary[j];
          const nv2 = neighborBoundary[(j + 1) % neighborBoundary.length];
          const nk1 = `${nv1.x},${nv1.y},${nv1.z}`;
          const nk2 = `${nv2.x},${nv2.y},${nv2.z}`;

          if (
            (key1 === nk1 && key2 === nk2) ||
            (key1 === nk2 && key2 === nk1)
          ) {
            return false; // Shared with faction neighbor, not a boundary
          }
        }
      }
    }
    return true; // No faction neighbor shares this edge = boundary
  }

  /**
   * Build ribbon geometry for border glow effect
   * Creates quads along boundary edges that fade inward
   * @param {Set<number>} factionTiles - Set of tile indices owned by the faction
   * @returns {THREE.BufferGeometry|null}
   */
  _buildBorderRibbonGeometry(factionTiles) {
    const glowWidth = BORDER_GLOW_CONFIG.glowWidth;
    const zOffset = BORDER_GLOW_CONFIG.zOffset;

    const positions = [];
    const distanceAttrib = []; // 0 at edge, 1 at inner boundary
    const indices = [];
    let vertexIndex = 0;

    // For each boundary edge, create a ribbon quad
    for (const tileIdx of factionTiles) {
      const tile = this._tiles[tileIdx];
      if (!tile) continue;

      const boundary = tile.boundary;
      const tileCenter = new THREE.Vector3(
        parseFloat(tile.centerPoint.x),
        parseFloat(tile.centerPoint.y),
        parseFloat(tile.centerPoint.z),
      );

      for (let i = 0; i < boundary.length; i++) {
        const v1 = boundary[i];
        const v2 = boundary[(i + 1) % boundary.length];

        // Check if this edge is on the faction boundary
        if (this._isEdgeFactionBoundary(tileIdx, v1, v2, factionTiles)) {
          // Apply terrain elevation scaling
          const es = this.terrainElevation
            ? this.terrainElevation.getExtrusion(
                this.terrainElevation.getElevationAtTileIndex(tileIdx),
              )
            : 1;
          const p1 = new THREE.Vector3(
            parseFloat(v1.x) * es,
            parseFloat(v1.y) * es,
            parseFloat(v1.z) * es,
          );
          const p2 = new THREE.Vector3(
            parseFloat(v2.x) * es,
            parseFloat(v2.y) * es,
            parseFloat(v2.z) * es,
          );

          // Calculate inward direction (toward elevated tile center)
          const edgeMid = p1.clone().add(p2).multiplyScalar(0.5);
          const elevatedCenter = tileCenter.clone().multiplyScalar(es);
          const inwardDir = elevatedCenter.sub(edgeMid).normalize();

          // Surface normal for z-offset
          const surfaceNormal = edgeMid.clone().normalize();

          // Create 4 vertices for ribbon quad:
          // outer1, outer2 (at boundary edge, distance=0)
          // inner1, inner2 (offset inward, distance=1)

          const outer1 = p1
            .clone()
            .add(surfaceNormal.clone().multiplyScalar(zOffset));
          const outer2 = p2
            .clone()
            .add(surfaceNormal.clone().multiplyScalar(zOffset));

          const inner1 = p1
            .clone()
            .add(inwardDir.clone().multiplyScalar(glowWidth))
            .add(surfaceNormal.clone().multiplyScalar(zOffset));
          const inner2 = p2
            .clone()
            .add(inwardDir.clone().multiplyScalar(glowWidth))
            .add(surfaceNormal.clone().multiplyScalar(zOffset));

          // Add vertices: outer1, outer2, inner1, inner2
          positions.push(
            outer1.x,
            outer1.y,
            outer1.z,
            outer2.x,
            outer2.y,
            outer2.z,
            inner1.x,
            inner1.y,
            inner1.z,
            inner2.x,
            inner2.y,
            inner2.z,
          );

          // Distance attribute: 0 at edge, 1 at inner
          distanceAttrib.push(0, 0, 1, 1);

          // Two triangles for the quad
          indices.push(
            vertexIndex,
            vertexIndex + 1,
            vertexIndex + 2,
            vertexIndex + 1,
            vertexIndex + 3,
            vertexIndex + 2,
          );

          vertexIndex += 4;
        }
      }
    }

    if (positions.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      "distanceFromEdge",
      new THREE.Float32BufferAttribute(distanceAttrib, 1),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return geometry;
  }

  /**
   * Create or update the border glow for a faction's territory
   * @param {string} faction - 'rust', 'cobalt', or 'viridian'
   */
  _createFactionBorderGlow(faction) {
    // Remove existing border glow for this faction
    this._removeFactionBorderGlow(faction);

    // Collect all tiles owned by this faction
    const factionTiles = new Set();
    for (const [clusterId, owner] of this.clusterOwnership) {
      if (owner === faction) {
        const cluster = this.clusterData[clusterId];
        if (cluster && cluster.tiles) {
          for (const tileIdx of cluster.tiles) {
            factionTiles.add(tileIdx);
          }
        }
      }
    }

    if (factionTiles.size === 0) {
      return;
    }

    // Build ribbon geometry from boundary edges
    const geometry = this._buildBorderRibbonGeometry(factionTiles);
    if (!geometry) return;

    // Create material with faction color
    const factionColor = FACTION_COLORS[faction].threeLight;
    const material = this._createBorderGlowMaterial(factionColor);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2; // Above terrain overlays
    this.hexGroup.add(mesh);
    this.factionBorderGlows.set(faction, mesh);
  }

  /**
   * Remove the border glow for a faction
   * @param {string} faction - 'rust', 'cobalt', or 'viridian'
   */
  _removeFactionBorderGlow(faction) {
    const glow = this.factionBorderGlows.get(faction);
    if (glow) {
      this.hexGroup.remove(glow);
      glow.geometry.dispose();
      glow.material.dispose();
      this.factionBorderGlows.delete(faction);
    }
  }

  /**
   * Animate border glow appearing (fade-in with pulse)
   * @param {string} faction - The faction
   */
  _animateBorderGlowAppear(faction) {
    const startTime = performance.now();
    const duration = 1200;

    // Cancel existing animations for this faction
    this._borderGlowAnimations = this._borderGlowAnimations.filter(
      (a) => a.faction !== faction,
    );

    this._borderGlowAnimations.push({
      faction,
      startTime,
      duration,
      type: "appear",
    });
  }

  /**
   * Animate border glow disappearing (fade-out)
   * @param {string} faction - The faction
   */
  _animateBorderGlowDisappear(faction) {
    const startTime = performance.now();
    const duration = 800;

    // Cancel existing animations for this faction
    this._borderGlowAnimations = this._borderGlowAnimations.filter(
      (a) => a.faction !== faction,
    );

    this._borderGlowAnimations.push({
      faction,
      startTime,
      duration,
      type: "disappear",
    });
  }

  /**
   * Update border glow animations each frame
   * @param {number} now - Current timestamp from performance.now()
   */
  _updateBorderGlowAnimations(now) {
    const completed = [];

    for (let i = 0; i < this._borderGlowAnimations.length; i++) {
      const anim = this._borderGlowAnimations[i];
      const elapsed = now - anim.startTime;
      const t = Math.min(elapsed / anim.duration, 1);

      const glow = this.factionBorderGlows.get(anim.faction);
      if (!glow || !glow.material || !glow.material.uniforms) {
        completed.push(i);
        continue;
      }

      const material = glow.material;

      if (anim.type === "appear") {
        // Fade in with pulse
        if (t < 0.4) {
          const fadeT = t / 0.4;
          material.uniforms.opacity.value =
            BORDER_GLOW_CONFIG.baseOpacity * fadeT;
          material.uniforms.pulseIntensity.value = (1 - fadeT) * 0.5;
        } else {
          material.uniforms.opacity.value = BORDER_GLOW_CONFIG.baseOpacity;
          material.uniforms.pulseIntensity.value = 0;
        }
      } else if (anim.type === "disappear") {
        // Fade out
        material.uniforms.opacity.value =
          BORDER_GLOW_CONFIG.baseOpacity * (1 - t);
      }

      // Update time uniform for any ongoing effects
      material.uniforms.time.value = now * 0.001;

      if (t >= 1) {
        completed.push(i);
        if (anim.type === "disappear") {
          this._removeFactionBorderGlow(anim.faction);
        }
      }
    }

    // Remove completed animations (in reverse order to preserve indices)
    for (let i = completed.length - 1; i >= 0; i--) {
      this._borderGlowAnimations.splice(completed[i], 1);
    }
  }

  /**
   * Trigger a capture pulse glow on a faction's border ribbon.
   * Called by CapturePulse when a wave reaches the cluster boundary.
   * @param {string} faction - 'rust', 'cobalt', or 'viridian'
   */
  triggerCapturePulse(faction) {
    const glow = this.factionBorderGlows.get(faction);
    if (!glow || !glow.material || !glow.material.uniforms) return;

    if (!this._capturePulseDecays) this._capturePulseDecays = [];

    // Replace any existing decay for this faction
    for (let i = this._capturePulseDecays.length - 1; i >= 0; i--) {
      if (this._capturePulseDecays[i].faction === faction) {
        this._capturePulseDecays.splice(i, 1);
      }
    }

    glow.material.uniforms.pulseIntensity.value = 1.0;
    this._capturePulseDecays.push({ faction, intensity: 1.0 });
  }

  /**
   * Decay capture pulse glow intensities each frame.
   * @param {number} deltaTime - Seconds since last frame
   */
  updateCapturePulseDecays(deltaTime) {
    if (!this._capturePulseDecays || this._capturePulseDecays.length === 0)
      return;

    for (let i = this._capturePulseDecays.length - 1; i >= 0; i--) {
      const decay = this._capturePulseDecays[i];
      // Exponential decay: ~0.5s to near-zero
      decay.intensity *= Math.pow(0.05, deltaTime);

      const glow = this.factionBorderGlows.get(decay.faction);
      if (glow && glow.material && glow.material.uniforms) {
        glow.material.uniforms.pulseIntensity.value = decay.intensity;
        glow.material.uniforms.time.value = performance.now() * 0.001;
      }

      if (decay.intensity < 0.01) {
        if (glow && glow.material && glow.material.uniforms) {
          glow.material.uniforms.pulseIntensity.value = 0;
        }
        this._capturePulseDecays.splice(i, 1);
      }
    }
  }

  /**
   * Update dirty border glows (debounced)
   */
  _updateDirtyBorderGlows() {
    if (this._dirtyFactionBorderGlows.size === 0) return;

    const now = performance.now();
    if (now - this._lastBorderGlowUpdate < 200) return;

    for (const faction of this._dirtyFactionBorderGlows) {
      this._createFactionBorderGlow(faction);
    }
    this._dirtyFactionBorderGlows.clear();
  }

  // ========================================================================
  // END BORDER GLOW SYSTEM
  // ========================================================================

  /**
   * Create a lighting-aware overlay material that adapts visibility based on surface lighting
   * Boosts opacity and saturation on bright (sun-lit) areas so colors remain visible
   * @param {THREE.Color} overlayColor - The base overlay color
   * @returns {THREE.ShaderMaterial}
   */
  _createLightingAwareOverlayMaterial(overlayColor) {
    // Overlay blend mode: boosts contrast, tints mid-tones
    // Result = Src × DstColor + Dst × SrcColor
    return new THREE.ShaderMaterial({
      uniforms: {
        overlayColor: { value: overlayColor.clone() },
        opacity: { value: CLUSTER_OVERLAY_OPACITY },
      },
      vertexShader: `
                void main() {
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
      fragmentShader: `
                uniform vec3 overlayColor;
                uniform float opacity;

                void main() {
                    // Mix overlay color with neutral gray based on opacity
                    // At 0% opacity: outputs gray (no effect)
                    // At 100% opacity: outputs full overlay color
                    vec3 blendedColor = mix(vec3(0.5), overlayColor, opacity);

                    gl_FragColor = vec4(blendedColor, 1.0);
                }
            `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
      // Overlay blend: Result = Src × DstColor + Dst × SrcColor
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
    });
  }

  /**
   * Create a simple color overlay mesh for a captured cluster
   * @param {number} clusterId - The cluster ID
   * @param {THREE.Color} overlayColor - The overlay color
   */
  _createClusterColorOverlay(clusterId, overlayColor) {
    const cluster = this.clusterData[clusterId];
    if (!cluster) return;

    const tileIndices = cluster.tiles;
    const tileSet = new Set(tileIndices);

    // Collect all vertices for overlay geometry
    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    this.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || !tileSet.has(mesh.userData.tileIndex)) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      const pos = mesh.geometry.attributes.position.array;
      const idx = mesh.geometry.index ? mesh.geometry.index.array : null;

      // Add vertices with slight offset outward from planet center
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i],
          y = pos[i + 1],
          z = pos[i + 2];
        const len = Math.sqrt(x * x + y * y + z * z);
        const offset = 0.03; // Offset to prevent z-fighting
        positions.push(
          x + (x / len) * offset,
          y + (y / len) * offset,
          z + (z / len) * offset,
        );
      }

      // Add indices (triangles)
      if (idx) {
        for (let i = 0; i < idx.length; i++) {
          indices.push(idx[i] + vertexOffset);
        }
      } else {
        const vertCount = pos.length / 3;
        for (let i = 1; i < vertCount - 1; i++) {
          indices.push(vertexOffset, vertexOffset + i, vertexOffset + i + 1);
        }
      }

      vertexOffset += pos.length / 3;
    });

    if (positions.length === 0) return;

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    // Lighting-aware color overlay for occupied territory
    // Boosts visibility on bright (sun-lit) areas
    const material = this._createLightingAwareOverlayMaterial(overlayColor);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 1;
    this.hexGroup.add(mesh);
    this.clusterGlowOverlays.set(clusterId, mesh);
  }

  /**
   * Remove the color overlay for a cluster
   * @param {number} clusterId
   */
  _removeClusterColorOverlay(clusterId) {
    const overlay = this.clusterGlowOverlays.get(clusterId);
    if (overlay) {
      this.hexGroup.remove(overlay);
      overlay.geometry.dispose();
      overlay.material.dispose();
      this.clusterGlowOverlays.delete(clusterId);
    }
  }

  /**
   * Apply or remove color overlay to a cluster with transition animation
   * @param {number} clusterId - The cluster ID
   * @param {THREE.Color|null} overlayColor - The overlay color (null to remove)
   * @param {THREE.Color|null} previousColor - The previous color for transitions
   */
  applyInnerGlowToCluster(clusterId, overlayColor, previousColor = null) {
    const existingOverlay = this.clusterGlowOverlays.get(clusterId);

    if (overlayColor) {
      if (existingOverlay) {
        // Faction-to-faction transition: pulse effect
        this._animateOverlayTransition(
          clusterId,
          existingOverlay,
          previousColor,
          overlayColor,
        );
      } else {
        // Unclaimed-to-faction: create with flash-in effect
        this._createClusterColorOverlay(clusterId, overlayColor);
        const newOverlay = this.clusterGlowOverlays.get(clusterId);
        if (newOverlay) {
          this._animateOverlayAppear(clusterId, newOverlay, overlayColor);
        }
      }
    } else {
      // Remove overlay (faction-to-unclaimed)
      if (existingOverlay) {
        this._animateOverlayDisappear(clusterId, existingOverlay);
      }
    }
  }

  /**
   * Animate overlay appearing (unclaimed → faction)
   * DRAMATIC: Blinding flash, multiple pulses, then settle
   */
  _animateOverlayAppear(clusterId, overlay, targetColor) {
    const startTime = performance.now();
    const duration = 1200; // Longer for drama
    const material = overlay.material;

    // Cancel any existing animations for this cluster
    this._overlayAnimations = this._overlayAnimations.filter(
      (a) => a.clusterId !== clusterId,
    );

    // Stop any weak territory flickering for this cluster
    this._weakTerritories.delete(clusterId);

    // Start with intense white flash
    this._setOverlayColor(material, 1, 1, 1);
    this._setOverlayOpacity(material, 1.0);

    this._overlayAnimations.push({
      clusterId,
      overlay,
      startTime,
      duration,
      type: "appear",
      targetColor: targetColor.clone(),
    });
  }

  /**
   * Animate overlay disappearing (faction → unclaimed)
   * DRAMATIC: Flicker and shatter effect
   */
  _animateOverlayDisappear(clusterId, overlay) {
    const startTime = performance.now();
    const duration = 800;
    const material = overlay.material;

    // Cancel any existing animations for this cluster
    this._overlayAnimations = this._overlayAnimations.filter(
      (a) => a.clusterId !== clusterId,
    );

    // Stop any weak territory flickering for this cluster
    this._weakTerritories.delete(clusterId);

    this._overlayAnimations.push({
      clusterId,
      overlay,
      startTime,
      duration,
      type: "disappear",
      startOpacity: this._getOverlayOpacity(material),
      startColor: this._getOverlayColor(material),
    });
  }

  /**
   * Animate overlay transition (faction → faction)
   * DRAMATIC: Explosion of old color, shockwave, new color emerges
   */
  _animateOverlayTransition(clusterId, overlay, fromColor, toColor) {
    const startTime = performance.now();
    const duration = 1500; // Long dramatic transition

    // Cancel any existing animations for this cluster to prevent color blending issues
    this._overlayAnimations = this._overlayAnimations.filter(
      (a) => a.clusterId !== clusterId,
    );

    // Stop any weak territory flickering for this cluster
    this._weakTerritories.delete(clusterId);

    // Use the provided fromColor (original owner's color), not the current material color
    // This prevents blended colors when transitions are interrupted
    const safeFromColor = fromColor ? fromColor.clone() : toColor.clone();

    // Immediately set the material to the true fromColor to clear any blended state
    // This ensures the transition starts from the correct color, not a flickered blend
    this._copyOverlayColor(overlay.material, safeFromColor);
    this._setOverlayOpacity(overlay.material, 0.35);

    this._overlayAnimations.push({
      clusterId,
      overlay,
      startTime,
      duration,
      type: "transition",
      fromColor: safeFromColor,
      toColor: toColor.clone(),
    });
  }

  /**
   * Helper: Set overlay material color (works with both ShaderMaterial and MeshBasicMaterial)
   */
  _setOverlayColor(material, r, g, b) {
    if (material.uniforms && material.uniforms.overlayColor) {
      material.uniforms.overlayColor.value.setRGB(r, g, b);
    } else if (material.color) {
      material.color.setRGB(r, g, b);
    }
  }

  /**
   * Helper: Copy color to overlay material
   */
  _copyOverlayColor(material, color) {
    if (material.uniforms && material.uniforms.overlayColor) {
      material.uniforms.overlayColor.value.copy(color);
    } else if (material.color) {
      material.color.copy(color);
    }
  }

  /**
   * Helper: Set overlay material opacity (works with both ShaderMaterial and MeshBasicMaterial)
   */
  _setOverlayOpacity(material, opacity) {
    if (material.uniforms && material.uniforms.opacity) {
      material.uniforms.opacity.value = opacity;
    } else if (material.uniforms && material.uniforms.baseOpacity) {
      material.uniforms.baseOpacity.value = opacity;
    } else {
      material.opacity = opacity;
    }
  }

  /**
   * Helper: Get overlay material opacity
   */
  _getOverlayOpacity(material) {
    if (material.uniforms && material.uniforms.opacity) {
      return material.uniforms.opacity.value;
    }
    if (material.uniforms && material.uniforms.baseOpacity) {
      return material.uniforms.baseOpacity.value;
    }
    return material.opacity || 0.25;
  }

  /**
   * Helper: Get overlay material color
   */
  _getOverlayColor(material) {
    if (material.uniforms && material.uniforms.overlayColor) {
      return material.uniforms.overlayColor.value.clone();
    }
    return material.color ? material.color.clone() : new THREE.Color(1, 1, 1);
  }

  /**
   * Update overlay animations - call this in your render loop
   */
  updateOverlayAnimations() {
    const now = performance.now();
    const completed = [];

    for (let i = 0; i < this._overlayAnimations.length; i++) {
      const anim = this._overlayAnimations[i];
      const elapsed = now - anim.startTime;
      const t = Math.min(elapsed / anim.duration, 1);

      if (!anim.overlay || !anim.overlay.material) {
        completed.push(i);
        continue;
      }

      const material = anim.overlay.material;

      if (anim.type === "appear") {
        // CAPTURE: Gentle glow-in with subtle pulse
        // Phase 1 (0-0.3): Slow fade in
        // Phase 2 (0.3-0.6): Subtle pulse
        // Phase 3 (0.6-1.0): Settle to final state

        if (t < 0.3) {
          // Gradual fade in - soft and subtle
          const fadeT = t / 0.3;
          const easeOut = 1 - Math.pow(1 - fadeT, 2);
          this._setOverlayOpacity(material, easeOut * CLUSTER_OVERLAY_OPACITY);
          // Subtle color warmth during fade-in
          this._setOverlayColor(
            material,
            Math.min(1, anim.targetColor.r + (1 - easeOut) * 0.08),
            Math.min(1, anim.targetColor.g + (1 - easeOut) * 0.08),
            Math.min(1, anim.targetColor.b + (1 - easeOut) * 0.08),
          );
        } else if (t < 0.6) {
          // Subtle pulse - gentle brightness swell
          const pulseT = (t - 0.3) / 0.3;
          const pulse = Math.sin(pulseT * Math.PI); // 0 -> 1 -> 0
          this._setOverlayOpacity(
            material,
            CLUSTER_OVERLAY_OPACITY * (1 + pulse * 0.3),
          );
          // Slight color boost during pulse
          this._setOverlayColor(
            material,
            Math.min(1, anim.targetColor.r + pulse * 0.06),
            Math.min(1, anim.targetColor.g + pulse * 0.06),
            Math.min(1, anim.targetColor.b + pulse * 0.06),
          );
        } else {
          // Gentle settle to final state
          const settleT = (t - 0.6) / 0.4;
          const easeOut = 1 - Math.pow(1 - settleT, 2);
          this._setOverlayOpacity(material, CLUSTER_OVERLAY_OPACITY);
          this._copyOverlayColor(material, anim.targetColor);
        }
      } else if (anim.type === "disappear") {
        // LOSS: Flicker, desaturate, fade
        // Phase 1 (0-0.3): Subtle flickering
        // Phase 2 (0.3-0.6): Desaturate to gray
        // Phase 3 (0.6-1.0): Fade out

        if (t < 0.3) {
          // Flickering phase - territory is unstable
          const flickerT = t / 0.3;
          const flicker = Math.sin(flickerT * Math.PI * 8) * 0.5 + 0.5;
          this._setOverlayOpacity(
            material,
            anim.startOpacity * (0.6 + flicker * 0.4),
          );
          // Occasional lightened flash (not pure white)
          if (Math.sin(flickerT * Math.PI * 12) > 0.9) {
            this._setOverlayColor(
              material,
              Math.min(1, anim.startColor.r + 0.3),
              Math.min(1, anim.startColor.g + 0.3),
              Math.min(1, anim.startColor.b + 0.3),
            );
          } else {
            this._copyOverlayColor(material, anim.startColor);
          }
        } else if (t < 0.6) {
          // Desaturate - life draining away
          const desatT = (t - 0.3) / 0.3;
          const gray =
            (anim.startColor.r + anim.startColor.g + anim.startColor.b) / 3;
          this._setOverlayColor(
            material,
            anim.startColor.r + (gray - anim.startColor.r) * desatT,
            anim.startColor.g + (gray - anim.startColor.g) * desatT,
            anim.startColor.b + (gray - anim.startColor.b) * desatT,
          );
          this._setOverlayOpacity(
            material,
            anim.startOpacity * (1 - desatT * 0.3),
          );
        } else {
          // Final fade
          const fadeT = (t - 0.6) / 0.4;
          const easeIn = fadeT * fadeT;
          this._setOverlayOpacity(
            material,
            anim.startOpacity * 0.7 * (1 - easeIn),
          );
        }
      } else if (anim.type === "transition") {
        // FLIP: Color crossfade with DOUBLE PULSE at end
        // Phase 1 (0-0.2): Old color fades slightly
        // Phase 2 (0.2-0.5): Smooth color blend
        // Phase 3 (0.5-0.7): First pulse in new color
        // Phase 4 (0.7-0.9): Second pulse (stronger)
        // Phase 5 (0.9-1.0): Settle to final state

        if (t < 0.2) {
          // Old color fades slightly
          const fadeT = t / 0.2;
          const easeOut = 1 - Math.pow(1 - fadeT, 2);
          this._setOverlayOpacity(
            material,
            CLUSTER_OVERLAY_OPACITY * (1 - easeOut * 0.15),
          );
          this._copyOverlayColor(material, anim.fromColor);
        } else if (t < 0.5) {
          // Smooth color blend
          const blendT = (t - 0.2) / 0.3;
          const easeInOut =
            blendT < 0.5
              ? 2 * blendT * blendT
              : 1 - Math.pow(-2 * blendT + 2, 2) / 2;

          // Blend colors smoothly
          this._setOverlayColor(
            material,
            anim.fromColor.r + (anim.toColor.r - anim.fromColor.r) * easeInOut,
            anim.fromColor.g + (anim.toColor.g - anim.fromColor.g) * easeInOut,
            anim.fromColor.b + (anim.toColor.b - anim.fromColor.b) * easeInOut,
          );
          this._setOverlayOpacity(
            material,
            CLUSTER_OVERLAY_OPACITY * (0.85 + easeInOut * 0.15),
          );
        } else if (t < 0.7) {
          // First pulse in new color
          const pulseT = (t - 0.5) / 0.2;
          const pulse = Math.sin(pulseT * Math.PI); // 0 -> 1 -> 0
          this._setOverlayOpacity(
            material,
            CLUSTER_OVERLAY_OPACITY * (1 + pulse * 0.4),
          );
          // Color boost during pulse
          this._setOverlayColor(
            material,
            Math.min(1, anim.toColor.r + pulse * 0.1),
            Math.min(1, anim.toColor.g + pulse * 0.1),
            Math.min(1, anim.toColor.b + pulse * 0.1),
          );
        } else if (t < 0.9) {
          // Second pulse (stronger for emphasis)
          const pulseT = (t - 0.7) / 0.2;
          const pulse = Math.sin(pulseT * Math.PI); // 0 -> 1 -> 0
          this._setOverlayOpacity(
            material,
            CLUSTER_OVERLAY_OPACITY * (1 + pulse * 0.6),
          );
          // Stronger color boost on second pulse
          this._setOverlayColor(
            material,
            Math.min(1, anim.toColor.r + pulse * 0.15),
            Math.min(1, anim.toColor.g + pulse * 0.15),
            Math.min(1, anim.toColor.b + pulse * 0.15),
          );
        } else {
          // Settle to final state
          const settleT = (t - 0.9) / 0.1;
          const easeOut = 1 - Math.pow(1 - settleT, 2);

          this._copyOverlayColor(material, anim.toColor);
          this._setOverlayOpacity(material, CLUSTER_OVERLAY_OPACITY);
        }
      }

      if (t >= 1) {
        completed.push(i);

        // Ensure final state is exactly correct - use current owner's true color
        // This handles edge cases where ownership changed during animation
        if (anim.type === "appear" || anim.type === "transition") {
          const state = this.clusterCaptureState.get(anim.clusterId);
          if (state && state.owner && FACTION_COLORS[state.owner]) {
            // Use the TRUE current owner color, not the animation's target
            // This ensures we never end up with a stale/blended color
            this._copyOverlayColor(
              material,
              FACTION_COLORS[state.owner].threeLight,
            );
          } else if (anim.type === "appear") {
            this._copyOverlayColor(material, anim.targetColor);
          } else {
            this._copyOverlayColor(material, anim.toColor);
          }
          this._setOverlayOpacity(material, CLUSTER_OVERLAY_OPACITY);
        }

        // Final cleanup for disappear animations
        if (anim.type === "disappear") {
          this._removeClusterColorOverlay(anim.clusterId);
        }
      }
    }

    // Remove completed animations (reverse order to preserve indices)
    for (let i = completed.length - 1; i >= 0; i--) {
      this._overlayAnimations.splice(completed[i], 1);
    }

    // Apply flicker effect to weak territories
    this._updateWeakTerritoryFlicker(now);
  }

  /**
   * Mark a territory as weak (about to be recaptured) - triggers flickering
   * @param {number} clusterId
   * @param {string|null} attackingFaction - faction name or null if not weak
   */
  setTerritoryWeak(clusterId, attackingFaction) {
    if (attackingFaction) {
      this._weakTerritories.set(clusterId, attackingFaction);
    } else {
      // Clear from map and restore the true owner color immediately
      if (this._weakTerritories.has(clusterId)) {
        this._weakTerritories.delete(clusterId);
        this._restoreOwnerColor(clusterId);
      }
    }
  }

  /**
   * Restore the true owner color to a cluster overlay (used after flickering ends)
   */
  _restoreOwnerColor(clusterId) {
    const overlay = this.clusterGlowOverlays.get(clusterId);
    if (!overlay || !overlay.material) return;

    // Skip if there's an active animation (it will handle the color)
    const hasActiveAnimation = this._overlayAnimations.some(
      (a) => a.clusterId === clusterId,
    );
    if (hasActiveAnimation) return;

    const state = this.clusterCaptureState.get(clusterId);
    if (!state || !state.owner) return;

    const ownerColor = FACTION_COLORS[state.owner]?.threeLight;
    if (!ownerColor) return;

    // Immediately restore the true owner color
    this._copyOverlayColor(overlay.material, ownerColor);
    this._setOverlayOpacity(overlay.material, CLUSTER_OVERLAY_OPACITY);
  }

  /**
   * Apply flickering effect to weak territories - dims/flashes owner color to indicate instability.
   * Does NOT show the attacker's color; territory stays in the owner's color until officially captured.
   */
  _updateWeakTerritoryFlicker(now) {
    for (const [clusterId, attackingFaction] of this._weakTerritories) {
      const overlay = this.clusterGlowOverlays.get(clusterId);
      if (!overlay || !overlay.material) continue;

      // Skip if there's an active animation for this cluster
      const hasActiveAnimation = this._overlayAnimations.some(
        (a) => a.clusterId === clusterId,
      );
      if (hasActiveAnimation) continue;

      // Get current owner from capture state
      const state = this.clusterCaptureState.get(clusterId);
      if (!state || !state.owner) continue;

      // Skip if the "attacker" is now the owner (ownership changed, map is stale)
      if (state.owner === attackingFaction) {
        this._weakTerritories.delete(clusterId);
        continue;
      }

      const ownerColor = FACTION_COLORS[state.owner]?.threeLight;
      if (!ownerColor) continue;

      const material = overlay.material;
      const t = now / 1000;

      // Irregular flicker pattern - "dying bulb" feel
      const slowWave = Math.sin(t * 3.5);
      const fastWave = Math.sin(t * 12);
      const veryFast = Math.sin(t * 47);

      // Occasional near-blackout flicker
      const blackoutChance = Math.sin(t * 2.1) * Math.sin(t * 3.7);
      const dimAmount = blackoutChance > 0.85 ? 0.15 : 0;

      // Keep the owner's color — no blending toward attacker
      this._copyOverlayColor(material, ownerColor);

      // Opacity flicker — "dying bulb" dimming effect
      const baseOpacity = CLUSTER_OVERLAY_OPACITY;
      const opacityFlicker = slowWave * 0.1 + fastWave * 0.05 + veryFast * 0.03 - dimAmount;
      this._setOverlayOpacity(
        material,
        Math.max(
          CLUSTER_OVERLAY_OPACITY * 0.3,
          baseOpacity + opacityFlicker * CLUSTER_OVERLAY_OPACITY,
        ),
      );
    }
  }
}
