/**
 * AdLands - Admin Hex Selector
 * Mini 3D sphere for selecting tiles to assign to sponsors
 */

class HexSelector {
  constructor(containerElement, options = {}) {
    this.container = containerElement;
    this.width = options.width || containerElement.clientWidth;
    this.height = options.height || containerElement.clientHeight;

    // Sphere settings (smaller than game for admin UI)
    this.sphereRadius = 100;
    this.subdivisions = 22; // Same as main game for consistent tile indices

    // Three.js components
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      60,
      this.width / this.height,
      1,
      2000,
    );
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });

    // Selection state
    this.selectedTiles = new Set();
    this.excludedTiles = new Set(); // Polar + portal tiles
    this.assignedTiles = new Set(); // Tiles belonging to other sponsors
    this.tileMeshes = []; // Array of mesh references
    this.tileIndexToMesh = new Map(); // Quick lookup
    this.tileOutlines = []; // Edge line segments for outlines

    // Tile positions for reference (no visible labels)
    this.tilePositions = new Map(); // tileIndex → Vector3 center position

    // Adjacency map for neighbor constraints
    this.adjacencyMap = new Map(); // tileIndex → [neighborIndices]

    // Pattern preview state
    this.patternTexture = null;
    this.patternAdjustment = {
      scale: 1.0,
      offsetX: 0,
      offsetY: 0,
      inputBlack: 0,
      inputGamma: 1.0,
      inputWhite: 255,
      outputBlack: 0,
      outputWhite: 255,
      saturation: 1.0,
    };

    // Orbit controls state
    this.orbitalTheta = 0;
    this.orbitalPhi = Math.PI / 3; // Start at 60° elevation
    this.orbitalDistance = 220;
    this.isDragging = false;
    this.previousMouse = { x: 0, y: 0 };
    this.lastMoveTime = 0;

    // Orbital momentum state
    this.orbitalVelocity = { theta: 0, phi: 0 };
    this.orbitalFriction = 0.95; // Velocity decay per frame (lower = faster stop)
    this.dragStartMouse = { x: 0, y: 0 }; // Track initial mousedown position for click detection

    // Paint-drag state (left-click drag to select/deselect tiles)
    this.isPainting = false;
    this.paintMode = null; // 'add' | 'remove'
    this.isLeftDown = false;
    this.lastPaintedTile = -1; // Avoid re-processing same tile

    // Wheel gesture classification state (trackpad vs mouse wheel)
    this._wheelGesture = {
      active: false,
      device: null, // 'mouse' | 'trackpad' | null
      lastEventTime: 0,
      eventCount: 0,
      totalDeltaX: 0,
      timeoutId: null,
    };

    // Camera transition state (pull out → orbit → push in)
    this.transitioning = false;
    this.transitionProgress = 0;
    this.transitionSpeed = 0.6; // Progress per second (reaches 1.0 in ~1.7s)
    this.transitionStart = { theta: 0, phi: 0, distance: 0 };
    this.transitionTarget = { theta: 0, phi: 0, distance: 0 };
    this.lastFrameTime = performance.now();

    // Raycaster for click detection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Callbacks
    this.onSelectionChange = options.onSelectionChange || null;

    // Render-on-demand flag (set true when visual state changes)
    this._needsRender = true;

    this._init();
  }

  _init() {
    // Setup renderer
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x050505, 1);
    this.container.appendChild(this.renderer.domElement);

    // Add ambient light
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambient);

    // Add directional light parented to camera (always illuminates from viewer)
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(-3, 3, 1);
    directional.target.position.set(0, 0, -1);
    this.camera.add(directional);
    this.camera.add(directional.target);
    this.scene.add(this.camera);

    // Generate hexasphere and build meshes
    this._generateTiles();

    // Setup controls
    this._setupControls();

    // Position camera
    this._updateCameraPosition();

    // Start render loop
    this._animate();
  }

  _generateTiles() {
    if (typeof Hexasphere === "undefined") {
      console.error("Hexasphere.js not loaded");
      return;
    }

    const hexasphere = new Hexasphere(
      this.sphereRadius,
      this.subdivisions,
      1.0,
    );

    // Store tiles reference for tier system
    this._tiles = hexasphere.tiles;

    // Build adjacency map for polar expansion and neighbor constraints
    this.adjacencyMap = this._buildAdjacencyMap(hexasphere.tiles);

    // Identify excluded tiles (polar + portals)
    this._markExcludedTiles(hexasphere.tiles, this.adjacencyMap);

    // Build tier map if HexTierSystem is available
    if (typeof HexTierSystem !== "undefined") {
      this.tierMap = HexTierSystem.buildTierMap(
        hexasphere.tiles,
        this.sphereRadius,
        this.adjacencyMap,
      );
      console.log(
        "[HexSelector] Tier map built:",
        HexTierSystem.getTierStats(this.tierMap),
      );
    }

    // Collect all edge vertices for a single merged outline object
    const allEdgeVertices = [];

    // Create meshes for each tile
    hexasphere.tiles.forEach((tile, index) => {
      if (this.polarTileIndices && this.polarTileIndices.has(index)) return;
      const boundary = tile.boundary;
      const vertices = [];

      for (let i = 0; i < boundary.length; i++) {
        const vx = parseFloat(boundary[i].x);
        const vy = parseFloat(boundary[i].y);
        const vz = parseFloat(boundary[i].z);
        vertices.push(vx, vy, vz);
      }

      // Store tile center position for labels
      const centerPos = new THREE.Vector3(
        parseFloat(tile.centerPoint.x),
        parseFloat(tile.centerPoint.y),
        parseFloat(tile.centerPoint.z),
      );
      this.tilePositions.set(index, centerPos);

      const indices = [];
      for (let i = 1; i < boundary.length - 1; i++) {
        indices.push(0, i, i + 1);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(vertices, 3),
      );
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      // Determine initial color based on tier (if HexTierSystem available) or fallback
      let color;
      let tier = null;
      const isPortalCenter = boundary.length === 5;
      const isExcluded = this.excludedTiles.has(index);

      // Use tier system if available
      if (typeof HexTierSystem !== "undefined" && this.tierMap) {
        tier = this.tierMap.get(index);
        const tierDef = HexTierSystem.TIERS[tier];
        color = tierDef ? tierDef.color : 0x4a4a4a;
      } else if (isPortalCenter) {
        color = 0x000000; // Black for portal centers
      } else if (isExcluded) {
        color = 0x2a2a2a; // Dark gray for excluded (polar/portal border)
      } else {
        color = 0x4a4a4a; // Medium gray for selectable
      }

      const material = new THREE.MeshLambertMaterial({
        color: color,
        flatShading: true,
        side: THREE.FrontSide,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = {
        tileIndex: index,
        isExcluded: isExcluded,
        isPortalCenter: isPortalCenter,
        originalColor: color,
        tierColor: color,
        tier: tier,
      };

      this.scene.add(mesh);
      this.tileMeshes.push(mesh);
      this.tileIndexToMesh.set(index, mesh);

      // Collect edge vertices for merged outline
      for (let i = 0; i < boundary.length; i++) {
        const curr = boundary[i];
        const next = boundary[(i + 1) % boundary.length];
        allEdgeVertices.push(
          parseFloat(curr.x),
          parseFloat(curr.y),
          parseFloat(curr.z),
          parseFloat(next.x),
          parseFloat(next.y),
          parseFloat(next.z),
        );
      }
    });

    // Create single merged outline for all tiles (one draw call instead of ~2500)
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(allEdgeVertices, 3),
    );
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x222222,
      transparent: true,
      opacity: 0.35,
    });
    const edgeLine = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    this.scene.add(edgeLine);
    this.tileOutlines = [edgeLine];

    // Create outline sphere for visual reference
    const outlineGeom = new THREE.SphereGeometry(
      this.sphereRadius * 0.99,
      32,
      32,
    );
    const outlineMat = new THREE.MeshBasicMaterial({
      color: 0x222222,
      wireframe: true,
      transparent: true,
      opacity: 0.1,
    });
    this.scene.add(new THREE.Mesh(outlineGeom, outlineMat));
  }

  _buildAdjacencyMap(tiles) {
    const adjacencyMap = new Map();
    const vertexToTiles = new Map();

    // Round vertex coordinates to avoid floating point precision issues
    const roundCoord = (val) => Math.round(parseFloat(val) * 10000) / 10000;

    tiles.forEach((tile, idx) => {
      adjacencyMap.set(idx, []);
      tile.boundary.forEach((v) => {
        const key = `${roundCoord(v.x)},${roundCoord(v.y)},${roundCoord(v.z)}`;
        if (!vertexToTiles.has(key)) vertexToTiles.set(key, []);
        vertexToTiles.get(key).push(idx);
      });
    });

    tiles.forEach((tile, idx) => {
      const neighbors = new Set();
      tile.boundary.forEach((v) => {
        const key = `${roundCoord(v.x)},${roundCoord(v.y)},${roundCoord(v.z)}`;
        (vertexToTiles.get(key) || []).forEach((other) => {
          if (other !== idx) neighbors.add(other);
        });
      });
      adjacencyMap.set(idx, Array.from(neighbors));
    });

    return adjacencyMap;
  }

  _markExcludedTiles(tiles, adjacencyMap) {
    const portalCenters = new Set();
    this.polarTileIndices = new Set();
    tiles.forEach((tile, index) => {
      // Mark polar tiles (within 10° of poles) - deleted from rendering
      const y = parseFloat(tile.centerPoint.y);
      const phi = Math.acos(y / this.sphereRadius);
      const polarThreshold = (10 * Math.PI) / 180;
      if (phi < polarThreshold || phi > Math.PI - polarThreshold) {
        this.excludedTiles.add(index);
        this.polarTileIndices.add(index);
      }

      // Mark portal centers (pentagons)
      if (tile.boundary.length === 5) {
        portalCenters.add(index);
        this.excludedTiles.add(index);
      }
    });

    // Expand portal borders
    for (const portalIndex of portalCenters) {
      const neighbors = adjacencyMap.get(portalIndex) || [];
      for (const neighborIndex of neighbors) {
        this.excludedTiles.add(neighborIndex);
      }
    }
  }

  _setupControls() {
    const canvas = this.renderer.domElement;

    // Prevent context menu on right-click (we use it for camera orbit)
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // ====== MOUSE CONTROLS ======
    // Right-click + drag = orbit camera
    // Left-click = select tile, Left-click + drag = paint-select tiles
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 2) {
        // Right-click for orbit
        this.isDragging = true;
        this.previousMouse = { x: e.clientX, y: e.clientY };
        this.lastMoveTime = performance.now();
        this.orbitalVelocity.theta = 0;
        this.orbitalVelocity.phi = 0;
      } else if (e.button === 0) {
        // Left-click: prepare for click or paint-drag
        this.isLeftDown = true;
        this.isPainting = false;
        this.paintMode = null;
        this.lastPaintedTile = -1;
        this.dragStartMouse = { x: e.clientX, y: e.clientY };
      }
    });

    canvas.addEventListener("mousemove", (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.previousMouse.x;
        const dy = e.clientY - this.previousMouse.y;

        const now = performance.now();
        const deltaTime = now - this.lastMoveTime;

        if (deltaTime > 0 && deltaTime < 100) {
          const thetaDelta = dx * 0.008;
          const phiDelta = -dy * 0.008;
          this.orbitalVelocity.theta = (thetaDelta / deltaTime) * 16;
          this.orbitalVelocity.phi = (phiDelta / deltaTime) * 16;
        }

        this.orbitalTheta += dx * 0.008;
        this.orbitalPhi -= dy * 0.008;

        const minPhi = (10 * Math.PI) / 180;
        const maxPhi = (170 * Math.PI) / 180;
        this.orbitalPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitalPhi));

        this.previousMouse = { x: e.clientX, y: e.clientY };
        this.lastMoveTime = now;
        this._updateCameraPosition();
      } else if (this.isLeftDown) {
        // Paint-drag: start painting once mouse moves past threshold
        const dx = Math.abs(e.clientX - this.dragStartMouse.x);
        const dy = Math.abs(e.clientY - this.dragStartMouse.y);

        if (!this.isPainting && (dx > 5 || dy > 5)) {
          // Crossed drag threshold — enter paint mode
          this.isPainting = true;
          // Determine mode from the tile under the initial mousedown position
          const startTile = this._getTileAtScreen(this.dragStartMouse.x, this.dragStartMouse.y);
          if (startTile !== null) {
            this.paintMode = this.selectedTiles.has(startTile) ? "remove" : "add";
            this._paintTile(startTile);
          } else {
            this.paintMode = "add";
          }
        }

        if (this.isPainting) {
          this._paintAtScreen(e.clientX, e.clientY);
        }
      }
    });

    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 2) {
        // Right-click release
        this.isDragging = false;
      } else if (e.button === 0) {
        if (!this.isPainting) {
          // No drag — treat as single click (toggle)
          const dx = Math.abs(e.clientX - this.dragStartMouse.x);
          const dy = Math.abs(e.clientY - this.dragStartMouse.y);
          if (dx < 5 && dy < 5) {
            this._handleClick(e);
          }
        }
        this.isLeftDown = false;
        this.isPainting = false;
        this.paintMode = null;
        this.lastPaintedTile = -1;
      }
    });

    canvas.addEventListener("mouseleave", () => {
      this.isDragging = false;
      this.isLeftDown = false;
      this.isPainting = false;
      this.paintMode = null;
      this.lastPaintedTile = -1;
    });

    // ====== WHEEL CONTROLS ======
    // Mouse wheel → zoom (distance).
    // Trackpad → orbit (deltaX horizontal, deltaY vertical).
    // Pinch gesture (ctrlKey) → zoom.
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();

        // Pinch gesture (ctrlKey) = zoom
        if (e.ctrlKey) {
          this.orbitalDistance += e.deltaY * 0.5;
          this.orbitalDistance = Math.max(
            110,
            Math.min(600, this.orbitalDistance),
          );
          this._updateCameraPosition();
          return;
        }

        // Classify input device for this gesture
        const device = this._classifyWheelDevice(e);

        // deltaX → orbit (horizontal, trackpad only)
        if (Math.abs(e.deltaX) > 0) {
          const sensitivity = 0.0015;
          this.orbitalTheta -= e.deltaX * sensitivity;
          this.orbitalVelocity.theta = -e.deltaX * sensitivity * 0.3;
          this._updateCameraPosition();
        }

        // deltaY → mouse wheel zooms, trackpad orbits vertically
        if (Math.abs(e.deltaY) > 0) {
          if (device === "mouse") {
            // Mouse wheel → zoom (distance)
            this.orbitalDistance += e.deltaY * 0.5;
            this.orbitalDistance = Math.max(
              110,
              Math.min(600, this.orbitalDistance),
            );
            this._updateCameraPosition();
          } else {
            // Trackpad → orbit (vertical)
            const sensitivity = 0.0015;
            this.orbitalPhi += e.deltaY * sensitivity;

            const minPhi = (10 * Math.PI) / 180;
            const maxPhi = (170 * Math.PI) / 180;
            this.orbitalPhi = Math.max(
              minPhi,
              Math.min(maxPhi, this.orbitalPhi),
            );

            this.orbitalVelocity.phi = e.deltaY * sensitivity * 0.3;
            this._updateCameraPosition();
          }
        }
      },
      { passive: false },
    );

    // ====== TOUCH CONTROLS (for actual touchscreens) ======
    let touchStartDistance = 0;
    let lastTouchCenter = { x: 0, y: 0 };

    canvas.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          this.isDragging = true;
          this.orbitalVelocity.theta = 0;
          this.orbitalVelocity.phi = 0;
          this.lastMoveTime = performance.now();

          const t1 = e.touches[0];
          const t2 = e.touches[1];
          lastTouchCenter = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2,
          };
          touchStartDistance = Math.hypot(
            t2.clientX - t1.clientX,
            t2.clientY - t1.clientY,
          );
        } else if (e.touches.length === 1) {
          // Single touch for tile selection
          this.dragStartMouse = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
          };
        }
      },
      { passive: false },
    );

    canvas.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && this.isDragging) {
          e.preventDefault();

          const t1 = e.touches[0];
          const t2 = e.touches[1];
          const currentCenter = {
            x: (t1.clientX + t2.clientX) / 2,
            y: (t1.clientY + t2.clientY) / 2,
          };
          const currentDistance = Math.hypot(
            t2.clientX - t1.clientX,
            t2.clientY - t1.clientY,
          );

          const dx = currentCenter.x - lastTouchCenter.x;
          const dy = currentCenter.y - lastTouchCenter.y;

          const now = performance.now();
          const deltaTime = now - this.lastMoveTime;

          if (deltaTime > 0 && deltaTime < 100) {
            const thetaDelta = dx * 0.008;
            const phiDelta = -dy * 0.008;
            this.orbitalVelocity.theta = (thetaDelta / deltaTime) * 16;
            this.orbitalVelocity.phi = (phiDelta / deltaTime) * 16;
          }

          this.orbitalTheta += dx * 0.008;
          this.orbitalPhi -= dy * 0.008;

          const minPhi = (10 * Math.PI) / 180;
          const maxPhi = (170 * Math.PI) / 180;
          this.orbitalPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitalPhi));

          // Pinch = zoom
          const pinchDelta = currentDistance - touchStartDistance;
          if (Math.abs(pinchDelta) > 10) {
            this.orbitalDistance -= pinchDelta * 0.5;
            this.orbitalDistance = Math.max(
              110,
              Math.min(600, this.orbitalDistance),
            );
            touchStartDistance = currentDistance;
          }

          lastTouchCenter = currentCenter;
          this.lastMoveTime = now;
          this._updateCameraPosition();
        }
      },
      { passive: false },
    );

    canvas.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) {
        this.isDragging = false;
      }
      // Handle single tap for tile selection
      if (e.changedTouches.length === 1 && e.touches.length === 0) {
        const touch = e.changedTouches[0];
        const dx = Math.abs(touch.clientX - this.dragStartMouse.x);
        const dy = Math.abs(touch.clientY - this.dragStartMouse.y);
        if (dx < 10 && dy < 10) {
          this._handleClick({ clientX: touch.clientX, clientY: touch.clientY });
        }
      }
    });
  }

  _handleClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.tileMeshes);

    if (intersects.length > 0) {
      const mesh = intersects[0].object;
      const tileIndex = mesh.userData.tileIndex;

      // Skip excluded and already assigned tiles
      if (mesh.userData.isExcluded) return;
      if (this.assignedTiles.has(tileIndex)) return;

      this._toggleSelection(tileIndex);
    }
  }

  /**
   * Raycast to find which tile index is at the given screen coordinates.
   * Returns null if no valid tile is hit.
   */
  _getTileAtScreen(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.tileMeshes);

    if (intersects.length > 0) {
      const mesh = intersects[0].object;
      if (mesh.userData.isExcluded) return null;
      if (this.assignedTiles.has(mesh.userData.tileIndex)) return null;
      return mesh.userData.tileIndex;
    }
    return null;
  }

  /**
   * Process a screen position during paint-drag, selecting/deselecting the tile under cursor.
   */
  _paintAtScreen(clientX, clientY) {
    const tileIndex = this._getTileAtScreen(clientX, clientY);
    if (tileIndex === null) return;
    this._paintTile(tileIndex);
  }

  /**
   * Select or deselect a tile during paint-drag based on current paintMode.
   */
  _paintTile(tileIndex) {
    if (tileIndex === this.lastPaintedTile) return; // Already processed
    this.lastPaintedTile = tileIndex;

    const mesh = this.tileIndexToMesh.get(tileIndex);
    if (!mesh) return;

    if (this.paintMode === "add") {
      if (this.selectedTiles.has(tileIndex)) return; // Already selected
      if (!this._canSelectTile(tileIndex)) return;

      this.selectedTiles.add(tileIndex);
      mesh.material.color.setHex(0xffd700);
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(0x333300);
      }
    } else if (this.paintMode === "remove") {
      if (!this.selectedTiles.has(tileIndex)) return; // Already unselected
      if (!this._canDeselectTile(tileIndex)) return;

      this.selectedTiles.delete(tileIndex);
      if (mesh.userData.originalMaterial) {
        if (mesh.material !== mesh.userData.originalMaterial) {
          mesh.material.dispose();
        }
        mesh.material = mesh.userData.originalMaterial;
        delete mesh.userData.originalMaterial;
      }
      mesh.material.color.setHex(mesh.userData.originalColor);
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(0x000000);
      }
    }

    this._updateSelectableHighlights();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.getSelectedTiles());
    }
  }

  _toggleSelection(tileIndex) {
    const mesh = this.tileIndexToMesh.get(tileIndex);
    if (!mesh) return;

    if (this.selectedTiles.has(tileIndex)) {
      // Unselect: only allow if it won't break contiguity
      if (!this._canDeselectTile(tileIndex)) {
        return; // Would create disconnected selection
      }

      this.selectedTiles.delete(tileIndex);
      if (mesh.userData.originalMaterial) {
        if (mesh.material !== mesh.userData.originalMaterial) {
          mesh.material.dispose();
        }
        mesh.material = mesh.userData.originalMaterial;
        delete mesh.userData.originalMaterial;
      }
      mesh.material.color.setHex(mesh.userData.originalColor);
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(0x000000);
      }
    } else {
      // Select: only allow if adjacent to existing selection (or first tile)
      if (!this._canSelectTile(tileIndex)) {
        return; // Not adjacent to current selection
      }

      this.selectedTiles.add(tileIndex);
      mesh.material.color.setHex(0xffd700); // Yellow for selected
      if (mesh.material.emissive) {
        mesh.material.emissive.setHex(0x333300);
      }
    }

    // Update visual hints for selectable tiles
    this._updateSelectableHighlights();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.getSelectedTiles());
    }
  }

  /**
   * Check if a tile can be selected (must be adjacent to current selection, or first tile)
   * @param {number} tileIndex
   * @returns {boolean}
   */
  _canSelectTile(tileIndex) {
    // First tile can always be selected
    if (this.selectedTiles.size === 0) {
      return true;
    }

    // Check if this tile is adjacent to any selected tile
    const neighbors = this.adjacencyMap.get(tileIndex) || [];

    for (const neighborIndex of neighbors) {
      if (this.selectedTiles.has(neighborIndex)) {
        return true; // Adjacent to at least one selected tile
      }
    }

    return false; // Not adjacent to any selected tile
  }

  /**
   * Check if a tile can be deselected without breaking contiguity
   * @param {number} tileIndex
   * @returns {boolean}
   */
  _canDeselectTile(tileIndex) {
    // If only one tile selected, can always deselect
    if (this.selectedTiles.size <= 1) {
      return true;
    }

    // Create a temporary set without this tile
    const remaining = new Set(this.selectedTiles);
    remaining.delete(tileIndex);

    // Check if remaining tiles are still contiguous using flood fill
    const visited = new Set();
    const startTile = remaining.values().next().value;
    const queue = [startTile];
    visited.add(startTile);

    while (queue.length > 0) {
      const current = queue.shift();
      const neighbors = this.adjacencyMap.get(current) || [];

      for (const neighbor of neighbors) {
        if (remaining.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // If all remaining tiles were visited, selection is still contiguous
    return visited.size === remaining.size;
  }

  /**
   * Update visual highlighting to show which tiles can be selected next
   */
  _updateSelectableHighlights() {
    // Get the set of selectable neighbor tiles
    const selectableNeighbors = new Set();

    if (this.selectedTiles.size > 0) {
      for (const selectedIndex of this.selectedTiles) {
        const neighbors = this.adjacencyMap.get(selectedIndex) || [];
        for (const neighborIndex of neighbors) {
          // Only include if not already selected, not excluded, and not assigned
          if (
            !this.selectedTiles.has(neighborIndex) &&
            !this.excludedTiles.has(neighborIndex) &&
            !this.assignedTiles.has(neighborIndex)
          ) {
            selectableNeighbors.add(neighborIndex);
          }
        }
      }
    }

    // Update all tile colors
    for (const [tileIndex, mesh] of this.tileIndexToMesh) {
      if (this.selectedTiles.has(tileIndex)) {
        continue; // Don't change selected tiles
      }
      if (mesh.userData.isExcluded) {
        continue; // Don't change excluded tiles
      }
      if (this.assignedTiles.has(tileIndex)) {
        continue; // Don't change assigned tiles
      }

      // Skip tiles with pattern material applied
      if (mesh.userData.originalMaterial) {
        continue;
      }

      // Get base color from tier
      const tierColor = mesh.userData.originalColor || 0x4a4a4a;

      if (selectableNeighbors.has(tileIndex)) {
        // Highlight selectable neighbors - brighten tier color
        const brightenedColor = this._brightenColor(tierColor, 1.4);
        mesh.material.color.setHex(brightenedColor);
      } else if (this.selectedTiles.size === 0) {
        // No selection yet - show tier colors at full brightness
        mesh.material.color.setHex(tierColor);
      } else {
        // Not selectable - dim the tier color
        const dimmedColor = this._brightenColor(tierColor, 0.6);
        mesh.material.color.setHex(dimmedColor);
      }
    }
    this._needsRender = true;
  }

  /**
   * Brighten or dim a hex color
   * @param {number} hex - Hex color value
   * @param {number} factor - Multiplier (>1 = brighten, <1 = dim)
   * @returns {number} New hex color
   */
  _brightenColor(hex, factor) {
    const r = Math.min(255, Math.floor(((hex >> 16) & 0xff) * factor));
    const g = Math.min(255, Math.floor(((hex >> 8) & 0xff) * factor));
    const b = Math.min(255, Math.floor((hex & 0xff) * factor));
    return (r << 16) | (g << 8) | b;
  }

  _classifyWheelDevice(e) {
    const now = performance.now();
    const gesture = this._wheelGesture;
    const timeSinceLast = now - gesture.lastEventTime;

    // After 400ms gap, start a new gesture
    if (!gesture.active || timeSinceLast > 400) {
      gesture.active = true;
      gesture.device = null;
      gesture.eventCount = 0;
      gesture.totalDeltaX = 0;
    }

    gesture.lastEventTime = now;
    gesture.eventCount++;
    gesture.totalDeltaX += Math.abs(e.deltaX);

    // Reset gesture-end timeout
    clearTimeout(gesture.timeoutId);
    gesture.timeoutId = setTimeout(() => {
      gesture.active = false;
      gesture.device = null;
      gesture.eventCount = 0;
      gesture.totalDeltaX = 0;
    }, 400);

    // Already classified — return cached result
    if (gesture.device !== null) {
      return gesture.device;
    }

    // Firefox line-mode = mouse wheel
    if (e.deltaMode === 1) {
      gesture.device = "mouse";
      return "mouse";
    }

    // Any horizontal delta = trackpad (mice don't produce deltaX)
    if (Math.abs(e.deltaX) > 0 || gesture.totalDeltaX > 0) {
      gesture.device = "trackpad";
      return "trackpad";
    }

    // Mouse wheel hardware sends wheelDeltaY in multiples of 120
    // Trackpad sends wheelDeltaY = deltaY * 3 (small, variable, not multiples of 120)
    if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 &&
        e.wheelDeltaY % 120 === 0) {
      gesture.device = "mouse";
      return "mouse";
    }

    // Rapid stream of events without a 120-multiple = trackpad
    if (gesture.eventCount >= 3 && timeSinceLast < 30) {
      gesture.device = "trackpad";
      return "trackpad";
    }

    // Default: trackpad (don't lock — let subsequent events re-evaluate)
    return "trackpad";
  }

  _updateCameraPosition() {
    const x =
      this.orbitalDistance *
      Math.sin(this.orbitalPhi) *
      Math.cos(this.orbitalTheta);
    const y = this.orbitalDistance * Math.cos(this.orbitalPhi);
    const z =
      this.orbitalDistance *
      Math.sin(this.orbitalPhi) *
      Math.sin(this.orbitalTheta);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 0, 0);
    this._needsRender = true;
  }

  _animate() {
    requestAnimationFrame(() => this._animate());

    // Skip rendering when tab is not visible
    if (document.hidden) return;

    // Throttle to 30 FPS (admin UI doesn't need 60+)
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    if (elapsed < 33) return; // 33ms = ~30 FPS

    const deltaTime = elapsed / 1000;
    this.lastFrameTime = now;

    // Check if anything is actually animating
    const hasMotion =
      this.isDragging ||
      this.transitioning ||
      Math.abs(this.orbitalVelocity.theta) > 0.0001 ||
      Math.abs(this.orbitalVelocity.phi) > 0.0001;

    // Handle camera transitions
    if (this.transitioning) {
      this._updateTransition(deltaTime);
    } else if (hasMotion) {
      // Apply orbital momentum when not dragging (only if not transitioning)
      this._applyOrbitalMomentum();
    } else if (!this._needsRender) {
      // Nothing animating and no pending render - skip
      return;
    }

    this._needsRender = false;
    this.renderer.render(this.scene, this.camera);
  }

  _applyOrbitalMomentum() {
    // Apply momentum when not dragging
    if (!this.isDragging) {
      const minVelocity = 0.0001;

      if (
        Math.abs(this.orbitalVelocity.theta) > minVelocity ||
        Math.abs(this.orbitalVelocity.phi) > minVelocity
      ) {
        this.orbitalTheta += this.orbitalVelocity.theta;
        this.orbitalPhi += this.orbitalVelocity.phi;

        // Clamp phi to avoid gimbal lock (10° to 170°)
        const minPhi = (10 * Math.PI) / 180;
        const maxPhi = (170 * Math.PI) / 180;
        this.orbitalPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitalPhi));

        // Apply friction decay
        this.orbitalVelocity.theta *= this.orbitalFriction;
        this.orbitalVelocity.phi *= this.orbitalFriction;

        // Stop if below threshold
        if (Math.abs(this.orbitalVelocity.theta) < minVelocity) {
          this.orbitalVelocity.theta = 0;
        }
        if (Math.abs(this.orbitalVelocity.phi) < minVelocity) {
          this.orbitalVelocity.phi = 0;
        }

        this._updateCameraPosition();
      }
    }
  }

  // ========================
  // CAMERA TRANSITIONS
  // ========================

  // Delegate to shared MathUtils (loaded from js/utils/mathUtils.js)
  _smoothstep(t) { return MathUtils.smoothstep(t); }
  _lerp(a, b, t) { return MathUtils.lerp(a, b, t); }
  _lerpAngle(a, b, t) { return MathUtils.lerpAngle(a, b, t); }

  /**
   * Update camera transition animation
   * Uses pull-out → orbit → push-in pattern with overlapping phases
   * @param {number} deltaTime - Time since last frame in seconds
   */
  _updateTransition(deltaTime) {
    this.transitionProgress += this.transitionSpeed * deltaTime;

    if (this.transitionProgress >= 1) {
      // Transition complete
      this.transitionProgress = 1;
      this.transitioning = false;

      // Snap to final position
      this.orbitalTheta = this.transitionTarget.theta;
      this.orbitalPhi = this.transitionTarget.phi;
      this.orbitalDistance = this.transitionTarget.distance;
      this._updateCameraPosition();
      return;
    }

    // Phase timing with overlap for smooth motion:
    // Phase 1 (pull out): 0.0 → 0.6 of total progress
    // Phase 2 (orbit):    0.2 → 0.8 of total progress
    // Phase 3 (push in):  0.4 → 1.0 of total progress
    const pullProgress = Math.min(this.transitionProgress / 0.6, 1.0);
    const orbitProgress = Math.max(
      0,
      Math.min((this.transitionProgress - 0.2) / 0.6, 1.0),
    );
    const pushProgress = Math.max(0, (this.transitionProgress - 0.4) / 0.6);

    // Apply smoothstep to each phase
    const pullT = this._smoothstep(pullProgress);
    const orbitT = this._smoothstep(orbitProgress);
    const pushT = this._smoothstep(pushProgress);

    // Pull out distance (starts at current, peaks at 1.4x target, then returns)
    const peakDistance = this.transitionTarget.distance * 1.4;
    let currentDistance;
    if (this.transitionProgress < 0.5) {
      // First half: pull out to peak
      currentDistance = this._lerp(
        this.transitionStart.distance,
        peakDistance,
        pullT,
      );
    } else {
      // Second half: push in to target
      currentDistance = this._lerp(
        peakDistance,
        this.transitionTarget.distance,
        pushT,
      );
    }

    // Orbit to target angles
    const currentTheta = this._lerpAngle(
      this.transitionStart.theta,
      this.transitionTarget.theta,
      orbitT,
    );
    const currentPhi = this._lerp(
      this.transitionStart.phi,
      this.transitionTarget.phi,
      orbitT,
    );

    // Update orbital state and camera position
    this.orbitalTheta = currentTheta;
    this.orbitalPhi = currentPhi;
    this.orbitalDistance = currentDistance;
    this._updateCameraPosition();
  }

  /**
   * Transition camera to face a specific cluster of tiles
   * Uses pull-out → orbit → push-in animation
   * @param {number[]} tileIndices - Array of tile indices in the cluster
   */
  transitionToCluster(tileIndices) {
    if (!tileIndices || tileIndices.length === 0) return;
    if (this.transitioning) return; // Don't interrupt existing transition

    // Calculate cluster center
    let sumX = 0,
      sumY = 0,
      sumZ = 0;
    let count = 0;

    for (const tileIndex of tileIndices) {
      const pos = this.tilePositions.get(tileIndex);
      if (pos) {
        sumX += pos.x;
        sumY += pos.y;
        sumZ += pos.z;
        count++;
      }
    }

    if (count === 0) return;

    // Calculate target angles from cluster center
    const centerX = sumX / count;
    const centerY = sumY / count;
    const centerZ = sumZ / count;

    const targetTheta = Math.atan2(centerZ, centerX);
    const r = Math.sqrt(
      centerX * centerX + centerY * centerY + centerZ * centerZ,
    );
    const targetPhi = Math.acos(centerY / r);

    // Clamp phi to avoid gimbal lock (10° to 170°)
    const minPhi = (10 * Math.PI) / 180;
    const maxPhi = (170 * Math.PI) / 180;
    const clampedPhi = Math.max(minPhi, Math.min(maxPhi, targetPhi));

    // Capture current camera state
    this.transitionStart = {
      theta: this.orbitalTheta,
      phi: this.orbitalPhi,
      distance: this.orbitalDistance,
    };

    // Set target state (zoom in slightly for better view)
    this.transitionTarget = {
      theta: targetTheta,
      phi: clampedPhi,
      distance: 220, // Closer than default 300 for better cluster view
    };

    // Clear any existing momentum
    this.orbitalVelocity.theta = 0;
    this.orbitalVelocity.phi = 0;

    // Start transition
    this.transitioning = true;
    this.transitionProgress = 0;
  }

  // ========================
  // PUBLIC METHODS
  // ========================

  /**
   * Get array of selected tile indices
   * @returns {number[]}
   */
  getSelectedTiles() {
    return Array.from(this.selectedTiles);
  }

  /**
   * Get the tier map for all tiles
   * @returns {Map|null} tileIndex → tier ID
   */
  getTierMap() {
    return this.tierMap || null;
  }

  /**
   * Get pricing breakdown for currently selected tiles
   * @returns {Object|null} Pricing breakdown or null if tier system not available
   */
  getPricing() {
    if (typeof HexTierSystem === "undefined" || !this.tierMap) {
      return null;
    }
    return HexTierSystem.calculatePricing(
      this.getSelectedTiles(),
      this.tierMap,
    );
  }

  /**
   * Get tier statistics for all tiles
   * @returns {Object|null} { HOTZONE: count, PRIME: count, ... }
   */
  getTierStats() {
    if (typeof HexTierSystem === "undefined" || !this.tierMap) {
      return null;
    }
    return HexTierSystem.getTierStats(this.tierMap);
  }

  /**
   * Set selected tiles (for loading existing sponsor)
   * @param {number[]} tileIndices
   */
  setSelectedTiles(tileIndices) {
    // Clear current selection
    this.clearSelection();

    // Select new tiles (bypasses neighbor constraint for loading saved data)
    for (const tileIndex of tileIndices) {
      if (this.excludedTiles.has(tileIndex)) continue;
      if (this.assignedTiles.has(tileIndex)) continue;

      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (mesh) {
        this.selectedTiles.add(tileIndex);
        mesh.material.color.setHex(0xffd700);
        mesh.material.emissive.setHex(0x333300);
      }
    }

    // Update visual hints for selectable tiles
    this._updateSelectableHighlights();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.getSelectedTiles());
    }
  }

  /**
   * Clear all selected tiles
   */
  clearSelection() {
    for (const tileIndex of this.selectedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (mesh) {
        // Restore original material if pattern was applied
        if (mesh.userData.originalMaterial) {
          if (mesh.material !== mesh.userData.originalMaterial) {
            mesh.material.dispose();
          }
          mesh.material = mesh.userData.originalMaterial;
          delete mesh.userData.originalMaterial;
        }
        mesh.material.color.setHex(mesh.userData.originalColor);
        mesh.material.emissive.setHex(0x000000);
      }
    }
    this.selectedTiles.clear();

    // Update visual hints (all tiles become selectable again)
    this._updateSelectableHighlights();

    if (this.onSelectionChange) {
      this.onSelectionChange(this.getSelectedTiles());
    }
  }

  /**
   * Set tiles that are assigned to other sponsors (shows red with faint pattern)
   * @param {Set<number>|number[]} tileIndices - Simple set for backward compat
   * @param {Map<number, Object>|null} tileMap - Optional: tileIndex → { sponsorId, patternImage, patternAdjustment }
   */
  setAssignedTiles(tileIndices, tileMap = null) {
    // Reset previously assigned tiles
    for (const tileIndex of this.assignedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (mesh && !mesh.userData.isExcluded) {
        // Restore original MeshStandardMaterial if a shader pattern was applied
        if (mesh.userData.assignedMaterial) {
          mesh.userData.assignedMaterial.dispose();
          mesh.material = mesh.userData.originalStdMaterial || mesh.material;
          delete mesh.userData.assignedMaterial;
          delete mesh.userData.originalStdMaterial;
        }
        delete mesh.userData.assignedTexture;
        mesh.userData.originalColor = mesh.userData.tierColor || 0x4a4a4a;
        if (!this.selectedTiles.has(tileIndex)) {
          mesh.material.color.setHex(mesh.userData.originalColor);
          if (mesh.material.emissive) {
            mesh.material.emissive.setHex(0x000000);
          }
        }
      }
    }

    // Dispose old assigned textures cache
    if (this._assignedTextureCache) {
      for (const tex of this._assignedTextureCache.values()) {
        tex.dispose();
      }
    }
    this._assignedTextureCache = new Map();

    this.assignedTiles = new Set(tileIndices);

    // Mark assigned tiles: 50% red + 50% tier color (opaque)
    const red = new THREE.Color(0x660000);
    const mixed = new THREE.Color();
    for (const tileIndex of this.assignedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (mesh && !mesh.userData.isExcluded) {
        const tierColor = new THREE.Color(mesh.userData.tierColor || 0x4a4a4a);
        mixed.copy(red).lerp(tierColor, 0.5);
        mesh.userData.originalColor = mixed.getHex();
        if (!this.selectedTiles.has(tileIndex)) {
          mesh.material.color.copy(mixed);
        }
      }
    }

    // Apply faint sponsor patterns if tile map provided
    console.log(
      "[DEBUG] setAssignedTiles: tileMap =",
      tileMap,
      "size =",
      tileMap ? tileMap.size : "null",
    );
    if (tileMap && tileMap.size > 0) {
      // Check how many entries have patternImage
      let withPattern = 0;
      for (const [, info] of tileMap) {
        if (info.patternImage) withPattern++;
      }
      console.log(
        "[DEBUG] tileMap entries with patternImage:",
        withPattern,
        "/",
        tileMap.size,
      );
      this._applyAssignedPatterns(tileMap);
    }
    this._needsRender = true;
  }

  /**
   * Apply faint sponsor patterns to assigned tiles
   * @param {Map<number, Object>} tileMap - tileIndex → { sponsorId, patternImage, patternAdjustment }
   */
  _applyAssignedPatterns(tileMap) {
    // Group tiles by sponsor
    const sponsorGroups = new Map(); // sponsorId → { info, tileIndices[] }
    for (const [tileIndex, info] of tileMap) {
      if (!info.patternImage) continue;
      if (!sponsorGroups.has(info.sponsorId)) {
        sponsorGroups.set(info.sponsorId, { info, tileIndices: [] });
      }
      sponsorGroups.get(info.sponsorId).tileIndices.push(tileIndex);
    }

    console.log(
      "[DEBUG] _applyAssignedPatterns: sponsorGroups count =",
      sponsorGroups.size,
    );

    // Process each sponsor group
    for (const [sponsorId, group] of sponsorGroups) {
      const { info, tileIndices } = group;
      console.log(
        "[DEBUG] Loading texture for sponsor",
        sponsorId,
        "tiles:",
        tileIndices.length,
        "imageLen:",
        info.patternImage?.length,
      );

      // Load texture (cache per sponsor to avoid duplicates)
      this._loadAssignedTexture(sponsorId, info.patternImage, (texture) => {
        console.log(
          "[DEBUG] Texture loaded for sponsor",
          sponsorId,
          "texture:",
          texture,
          "image:",
          texture.image?.width,
          "x",
          texture.image?.height,
        );
        this._applyPatternToAssignedGroup(
          tileIndices,
          texture,
          info.patternAdjustment,
        );
      });
    }
  }

  /**
   * Load and cache a texture for an assigned sponsor
   */
  _loadAssignedTexture(sponsorId, imageDataUrl, callback) {
    if (this._assignedTextureCache.has(sponsorId)) {
      callback(this._assignedTextureCache.get(sponsorId));
      return;
    }

    const img = new Image();
    img.onload = () => {
      const texture = new THREE.Texture(img);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.needsUpdate = true;
      this._assignedTextureCache.set(sponsorId, texture);
      callback(texture);
    };
    img.src = imageDataUrl;
  }

  /**
   * Apply a faint pattern to a group of assigned tiles
   */
  _applyPatternToAssignedGroup(tileIndices, texture, adjustment = {}) {
    const scale = adjustment.scale || 1.0;
    const offsetX = adjustment.offsetX || 0;
    const offsetY = adjustment.offsetY || 0;

    // Calculate cluster center from these tiles
    const center = this._calculateCenterForTiles(tileIndices);
    const { tanU, tanV } = this._calculateClusterTangentBasis(center);
    const bounds = this._calculateBoundsForTiles(tileIndices, tanU, tanV);

    const clusterWidth = bounds.maxU - bounds.minU;
    const clusterHeight = bounds.maxV - bounds.minV;
    const textureWidth = texture.image ? texture.image.width : 256;
    const textureHeight = texture.image ? texture.image.height : 256;
    const textureAspect = textureWidth / textureHeight;
    const uniformScale = Math.max(clusterWidth, clusterHeight * textureAspect);
    const centerU = (bounds.minU + bounds.maxU) / 2;
    const centerV = (bounds.minV + bounds.maxV) / 2;
    const uvScale = 1.0 / scale;

    // Base color (30% red + 70% tier) with sponsor texture mixed at 50%
    const redColor = new THREE.Color(0x660000);
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uBase: { value: redColor.clone() },
        uMix: { value: 0.5 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 uBase;
        uniform float uMix;
        varying vec2 vUv;

        // RGB to HSL
        vec3 rgb2hsl(vec3 c) {
          float maxC = max(c.r, max(c.g, c.b));
          float minC = min(c.r, min(c.g, c.b));
          float l = (maxC + minC) * 0.5;
          float s = 0.0;
          float h = 0.0;
          if (maxC != minC) {
            float d = maxC - minC;
            s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
            if (maxC == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
            else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
            else h = (c.r - c.g) / d + 4.0;
            h /= 6.0;
          }
          return vec3(h, s, l);
        }

        float hue2rgb(float p, float q, float t) {
          if (t < 0.0) t += 1.0;
          if (t > 1.0) t -= 1.0;
          if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
          if (t < 1.0/2.0) return q;
          if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
          return p;
        }

        // HSL to RGB
        vec3 hsl2rgb(vec3 hsl) {
          float h = hsl.x, s = hsl.y, l = hsl.z;
          if (s == 0.0) return vec3(l);
          float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
          float p = 2.0 * l - q;
          return vec3(
            hue2rgb(p, q, h + 1.0/3.0),
            hue2rgb(p, q, h),
            hue2rgb(p, q, h - 1.0/3.0)
          );
        }

        void main() {
          vec3 tex = texture2D(map, vUv).rgb;
          // Color blend: take hue+saturation from texture, luminance from base
          vec3 baseHSL = rgb2hsl(uBase);
          vec3 texHSL = rgb2hsl(tex);
          vec3 blended = hsl2rgb(vec3(texHSL.x, texHSL.y, baseHSL.z));
          gl_FragColor = vec4(mix(uBase, blended, uMix), 1.0);
        }
      `,
      side: THREE.FrontSide,
    });

    for (const tileIndex of tileIndices) {
      if (this.selectedTiles.has(tileIndex)) continue;
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (!mesh || mesh.userData.isExcluded) continue;

      // Compute UVs
      const positions = mesh.geometry.attributes.position.array;
      const newUvs = [];
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i],
          y = positions[i + 1],
          z = positions[i + 2];
        const localU = x * tanU.x + y * tanU.y + z * tanU.z;
        const localV = x * tanV.x + y * tanV.y + z * tanV.z;
        let u = ((localV - centerV) / uniformScale + 0.5) * uvScale;
        let v =
          (((localU - centerU) / uniformScale) * textureAspect + 0.5) * uvScale;
        u += offsetX * 0.5;
        v += offsetY * 0.5;
        newUvs.push(u, v);
      }

      mesh.geometry.setAttribute(
        "uv",
        new THREE.Float32BufferAttribute(newUvs, 2),
      );
      mesh.geometry.attributes.uv.needsUpdate = true;

      // Store original material, apply per-tile pattern material
      mesh.userData.originalStdMaterial = mesh.material;
      const tierCol = new THREE.Color(mesh.userData.tierColor || 0x4a4a4a);
      const tileBase = redColor.clone().lerp(tierCol, 0.5);
      const tileMat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: texture },
          uBase: { value: tileBase },
          uMix: { value: 0.5 },
        },
        vertexShader: material.vertexShader,
        fragmentShader: material.fragmentShader,
        side: THREE.FrontSide,
      });
      mesh.userData.assignedMaterial = tileMat;
      mesh.material = tileMat;
    }

    // Note: don't dispose template — clones share its compiled program
  }

  /**
   * Calculate center point for an arbitrary set of tile indices
   * @param {number[]} tileIndices
   * @returns {THREE.Vector3}
   */
  _calculateCenterForTiles(tileIndices) {
    let sumX = 0,
      sumY = 0,
      sumZ = 0;
    let count = 0;
    for (const tileIndex of tileIndices) {
      const pos = this.tilePositions.get(tileIndex);
      if (pos) {
        sumX += pos.x;
        sumY += pos.y;
        sumZ += pos.z;
        count++;
      }
    }
    if (count === 0) return new THREE.Vector3(0, 1, 0);
    const center = new THREE.Vector3(sumX / count, sumY / count, sumZ / count);
    center.normalize().multiplyScalar(this.sphereRadius);
    return center;
  }

  /**
   * Calculate tangent-space bounds for an arbitrary set of tile indices
   * @param {number[]} tileIndices
   * @param {THREE.Vector3} tanU
   * @param {THREE.Vector3} tanV
   * @returns {{ minU: number, maxU: number, minV: number, maxV: number }}
   */
  _calculateBoundsForTiles(tileIndices, tanU, tanV) {
    let minU = Infinity,
      maxU = -Infinity;
    let minV = Infinity,
      maxV = -Infinity;
    for (const tileIndex of tileIndices) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (!mesh) continue;
      const positions = mesh.geometry.attributes.position.array;
      for (let i = 0; i < positions.length; i += 3) {
        const localU =
          positions[i] * tanU.x +
          positions[i + 1] * tanU.y +
          positions[i + 2] * tanU.z;
        const localV =
          positions[i] * tanV.x +
          positions[i + 1] * tanV.y +
          positions[i + 2] * tanV.z;
        minU = Math.min(minU, localU);
        maxU = Math.max(maxU, localU);
        minV = Math.min(minV, localV);
        maxV = Math.max(maxV, localV);
      }
    }
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
   * Get the set of excluded tile indices
   * @returns {Set<number>}
   */
  getExcludedTiles() {
    return new Set(this.excludedTiles);
  }

  /**
   * Resize the renderer
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this._needsRender = true;
  }

  /**
   * Set a pattern image for live preview on selected tiles
   * @param {string|null} imageDataUrl - Base64 data URL or null to clear
   * @param {Object} adjustment - { scale, offsetX, offsetY, inputBlack, inputGamma, inputWhite, outputBlack, outputWhite, saturation }
   */
  setPatternPreview(imageDataUrl, adjustment = {}) {
    this.patternAdjustment = {
      scale: adjustment.scale || 1.0,
      offsetX: adjustment.offsetX || 0,
      offsetY: adjustment.offsetY || 0,
      // Input levels
      inputBlack: adjustment.inputBlack ?? 0,
      inputGamma: adjustment.inputGamma ?? 1.0,
      inputWhite: adjustment.inputWhite ?? 255,
      // Output levels
      outputBlack: adjustment.outputBlack ?? 0,
      outputWhite: adjustment.outputWhite ?? 255,
      // Saturation
      saturation: adjustment.saturation ?? 1.0,
    };

    if (!imageDataUrl) {
      // Clear pattern preview
      this.patternTexture = null;
      this._clearPatternFromSelectedTiles();
      return;
    }

    // Load image and create texture
    const img = new Image();
    img.onload = () => {
      if (this.patternTexture) {
        this.patternTexture.dispose();
      }
      this.patternTexture = new THREE.Texture(img);
      // Use repeat wrapping for tiled pattern
      this.patternTexture.wrapS = THREE.RepeatWrapping;
      this.patternTexture.wrapT = THREE.RepeatWrapping;
      this.patternTexture.minFilter = THREE.NearestFilter;
      this.patternTexture.magFilter = THREE.NearestFilter;
      this.patternTexture.needsUpdate = true;

      this._applyPatternToSelectedTiles();
    };
    img.src = imageDataUrl;
  }

  /**
   * Update pattern adjustment and refresh preview
   * @param {Object} adjustment - { scale, offsetX, offsetY, inputBlack, inputGamma, inputWhite, outputBlack, outputWhite, saturation }
   */
  updatePatternAdjustment(adjustment) {
    this.patternAdjustment = {
      scale: adjustment.scale || 1.0,
      offsetX: adjustment.offsetX || 0,
      offsetY: adjustment.offsetY || 0,
      // Input levels
      inputBlack: adjustment.inputBlack ?? 0,
      inputGamma: adjustment.inputGamma ?? 1.0,
      inputWhite: adjustment.inputWhite ?? 255,
      // Output levels
      outputBlack: adjustment.outputBlack ?? 0,
      outputWhite: adjustment.outputWhite ?? 255,
      // Saturation
      saturation: adjustment.saturation ?? 1.0,
    };

    if (this.patternTexture && this.selectedTiles.size > 0) {
      this._applyPatternToSelectedTiles();
    }
  }

  _applyPatternToSelectedTiles() {
    if (!this.patternTexture || this.selectedTiles.size === 0) return;

    const scale = this.patternAdjustment.scale;
    const offsetX = this.patternAdjustment.offsetX;
    const offsetY = this.patternAdjustment.offsetY;

    // Calculate cluster center and create local coordinate system
    const clusterCenter = this._calculateClusterCenter();
    const { tanU, tanV } = this._calculateClusterTangentBasis(clusterCenter);

    // Calculate cluster bounds in tangent space
    const bounds = this._calculateClusterTangentBounds(
      clusterCenter,
      tanU,
      tanV,
    );
    const clusterWidth = bounds.maxU - bounds.minU;
    const clusterHeight = bounds.maxV - bounds.minV;

    // Get texture dimensions for aspect ratio calculation
    const textureWidth = this.patternTexture.image
      ? this.patternTexture.image.width
      : 256;
    const textureHeight = this.patternTexture.image
      ? this.patternTexture.image.height
      : 256;
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

    for (const tileIndex of this.selectedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (!mesh) continue;

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

      mesh.geometry.setAttribute(
        "uv",
        new THREE.Float32BufferAttribute(newUvs, 2),
      );
      mesh.geometry.attributes.uv.needsUpdate = true;

      // Store original material if not already stored
      if (!mesh.userData.originalMaterial) {
        mesh.userData.originalMaterial = mesh.material;
      }

      if (mesh.material !== mesh.userData.originalMaterial) {
        mesh.material.dispose();
      }
      mesh.material = this._createColorAdjustedMaterial();
    }
    this._needsRender = true;
  }

  /**
   * Create a ShaderMaterial with Photoshop-style levels and saturation adjustments
   * @returns {THREE.ShaderMaterial}
   */
  _createColorAdjustedMaterial() {
    // Get adjustment values
    const inputBlack = (this.patternAdjustment.inputBlack ?? 0) / 255.0;
    const inputWhite = (this.patternAdjustment.inputWhite ?? 255) / 255.0;
    const gamma = this.patternAdjustment.inputGamma ?? 1.0;
    const outputBlack = (this.patternAdjustment.outputBlack ?? 0) / 255.0;
    const outputWhite = (this.patternAdjustment.outputWhite ?? 255) / 255.0;
    const saturation = this.patternAdjustment.saturation ?? 1.0;

    // If all defaults, use simple MeshBasicMaterial for reliability
    const isDefault =
      inputBlack === 0.0 &&
      inputWhite === 1.0 &&
      gamma === 1.0 &&
      outputBlack === 0.0 &&
      outputWhite === 1.0 &&
      saturation === 1.0;
    if (isDefault) {
      return new THREE.MeshBasicMaterial({
        map: this.patternTexture,
        color: 0xffff88, // Yellow tint for selection
        side: THREE.FrontSide,
      });
    }

    const vertexShader = `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `;

    const fragmentShader = `
            uniform sampler2D map;
            uniform float uInputBlack;
            uniform float uInputWhite;
            uniform float uGamma;
            uniform float uOutputBlack;
            uniform float uOutputWhite;
            uniform float uSaturation;
            uniform vec3 uTint;
            varying vec2 vUv;

            void main() {
                vec4 texColor = texture2D(map, vUv);
                vec3 color = texColor.rgb;

                // Step 1: Apply input levels (remap inputBlack-inputWhite to 0-1)
                float inputRange = max(0.001, uInputWhite - uInputBlack);
                color = (color - uInputBlack) / inputRange;
                color = clamp(color, 0.0, 1.0);

                // Step 2: Apply gamma correction
                color = pow(color, vec3(1.0 / uGamma));

                // Step 3: Apply output levels (remap 0-1 to outputBlack-outputWhite)
                color = uOutputBlack + color * (uOutputWhite - uOutputBlack);

                // Step 4: Apply saturation adjustment
                float luminance = dot(color, vec3(0.299, 0.587, 0.114));
                color = mix(vec3(luminance), color, uSaturation);

                // Apply selection tint
                color = color * uTint;

                gl_FragColor = vec4(clamp(color, 0.0, 1.0), texColor.a);
            }
        `;

    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.patternTexture },
        uInputBlack: { value: inputBlack },
        uInputWhite: { value: inputWhite },
        uGamma: { value: gamma },
        uOutputBlack: { value: outputBlack },
        uOutputWhite: { value: outputWhite },
        uSaturation: { value: saturation },
        uTint: { value: new THREE.Color(0xffff88) }, // Yellow tint for selection
      },
      vertexShader,
      fragmentShader,
      side: THREE.FrontSide,
    });
  }

  _clearPatternFromSelectedTiles() {
    for (const tileIndex of this.selectedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (!mesh) continue;

      // Restore original material
      if (mesh.userData.originalMaterial) {
        if (mesh.material !== mesh.userData.originalMaterial) {
          mesh.material.dispose();
        }
        mesh.material = mesh.userData.originalMaterial;
        // Keep selected color
        mesh.material.color.setHex(0xffd700);
        mesh.material.emissive.setHex(0x333300);
      }
    }
    this._needsRender = true;
  }

  /**
   * Calculate the center point of all selected tiles
   * @returns {THREE.Vector3}
   */
  _calculateClusterCenter() {
    let sumX = 0,
      sumY = 0,
      sumZ = 0;
    let count = 0;

    for (const tileIndex of this.selectedTiles) {
      const pos = this.tilePositions.get(tileIndex);
      if (pos) {
        sumX += pos.x;
        sumY += pos.y;
        sumZ += pos.z;
        count++;
      }
    }

    if (count === 0) {
      return new THREE.Vector3(0, 1, 0); // Default to north pole
    }

    // Normalize to get a point on the sphere surface
    const center = new THREE.Vector3(sumX / count, sumY / count, sumZ / count);
    center.normalize().multiplyScalar(this.sphereRadius);
    return center;
  }

  /**
   * Calculate tangent basis vectors for the cluster
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
   * @param {THREE.Vector3} center - Cluster center
   * @param {THREE.Vector3} tanU - East tangent vector
   * @param {THREE.Vector3} tanV - North tangent vector
   * @returns {{ minU: number, maxU: number, minV: number, maxV: number }}
   */
  _calculateClusterTangentBounds(center, tanU, tanV) {
    let minU = Infinity,
      maxU = -Infinity;
    let minV = Infinity,
      maxV = -Infinity;

    for (const tileIndex of this.selectedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (!mesh) continue;

      const positions = mesh.geometry.attributes.position.array;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];

        // Project vertex onto tangent plane
        const localU = x * tanU.x + y * tanU.y + z * tanU.z;
        const localV = x * tanV.x + y * tanV.y + z * tanV.z;

        minU = Math.min(minU, localU);
        maxU = Math.max(maxU, localU);
        minV = Math.min(minV, localV);
        maxV = Math.max(maxV, localV);
      }
    }

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

  _calculateSelectedTilesBounds() {
    let minTheta = Infinity,
      maxTheta = -Infinity;
    let minPhi = Infinity,
      maxPhi = -Infinity;
    const thetas = [];

    for (const tileIndex of this.selectedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (!mesh) continue;

      const positions = mesh.geometry.attributes.position.array;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];

        const r = Math.sqrt(x * x + y * y + z * z);
        const theta = Math.atan2(z, x);
        const phi = Math.acos(y / r);

        thetas.push(theta);
        minPhi = Math.min(minPhi, phi);
        maxPhi = Math.max(maxPhi, phi);
      }
    }

    // Check for dateline crossing
    thetas.sort((a, b) => a - b);
    let maxGap = 0;
    let gapStart = 0;
    for (let i = 1; i < thetas.length; i++) {
      const gap = thetas[i] - thetas[i - 1];
      if (gap > maxGap) {
        maxGap = gap;
        gapStart = i;
      }
    }
    const wrapGap = thetas[0] + Math.PI * 2 - thetas[thetas.length - 1];
    const crossesDateline = wrapGap < maxGap;

    if (crossesDateline) {
      minTheta = thetas[gapStart];
      maxTheta = thetas[gapStart - 1] + Math.PI * 2;
    } else {
      minTheta = thetas[0];
      maxTheta = thetas[thetas.length - 1];
    }

    // Add padding
    const thetaPad = (maxTheta - minTheta) * 0.02;
    const phiPad = (maxPhi - minPhi) * 0.02;

    return {
      minTheta: minTheta - thetaPad,
      maxTheta: maxTheta + thetaPad,
      minPhi: minPhi - phiPad,
      maxPhi: maxPhi + phiPad,
      crossesDateline,
    };
  }

  /**
   * Destroy the hex selector (cleanup)
   */
  destroy() {
    // Remove renderer from DOM
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }

    // Dispose geometries and materials
    this.tileMeshes.forEach((mesh) => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    });

    // Dispose tile outlines
    this.tileOutlines.forEach((outline) => {
      outline.geometry.dispose();
      outline.material.dispose();
    });

    // Dispose pattern texture
    if (this.patternTexture) {
      this.patternTexture.dispose();
    }

    this.renderer.dispose();
  }
}
