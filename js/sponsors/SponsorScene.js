/**
 * AdLands - Sponsor Portal 3D Scene
 * Full-fidelity planet visualization with interactive hex/moon/billboard selection.
 * Adapted from admin HexSelector (selection logic) and game Environment (visuals).
 */

class SponsorScene {
  constructor(containerElement) {
    this.container = containerElement;

    // Sphere settings — game scale for full visual fidelity
    this.sphereRadius = 480;
    this.subdivisions = 22;

    // Three.js components
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      9.6,
      96000,
    );
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true, // for screenshot capture
    });

    // Bloom layer constants
    this.BLOOM_LAYER = 1;

    // Selection state
    this.selectedTiles = new Set();
    this.excludedTiles = new Set();
    this.tileMeshes = [];
    this.tileIndexToMesh = new Map();
    this.tilePositions = new Map();
    this.adjacencyMap = new Map();
    this.tierMap = null;
    this.polarTileIndices = new Set();

    // Orbit controls
    this.orbitalTheta = 0.4;
    this.orbitalPhi = Math.PI / 3;
    this.orbitalDistance = 1200;
    this.isDragging = false;
    this.previousMouse = { x: 0, y: 0 };
    this.lastMoveTime = 0;
    this.orbitalVelocity = { theta: 0, phi: 0 };
    this.orbitalFriction = 0.95;
    this.dragStartMouse = { x: 0, y: 0 };
    this.isLeftDown = false;

    // Wheel gesture classification
    this._wheelGesture = {
      active: false, device: null, lastEventTime: 0,
      eventCount: 0, totalDeltaX: 0, timeoutId: null,
    };

    // Auto-rotation
    this.autoRotateSpeed = 0.00015;
    this.lastInteractionTime = performance.now();
    this.autoRotateDelay = 5000; // ms before auto-rotate starts

    // Moon state — colors match tier pricing: gold=$250, purple=$120, teal=$60
    this.moonConfigs = [
      { radius: 48, distance: 600, angle: 0, inclination: 0.3, label: "Moon 1 (Large)", color: 0x3d3a2a, emissive: 0x191507 },
      { radius: 24, distance: 820, angle: 2.094, inclination: -0.2, label: "Moon 2 (Small)", color: 0x2a3b3a, emissive: 0x0a1514 },
      { radius: 32, distance: 720, angle: 4.189, inclination: 0.15, label: "Moon 3 (Medium)", color: 0x302a40, emissive: 0x100d18 },
    ];
    this.moonMeshes = [];
    this.selectedMoons = new Set();

    // Billboard state
    this.billboardConfigs = [];
    this.billboardGroups = [];
    this.billboardAdPanels = [];
    this.selectedBillboards = new Set();

    // Paint mode state (left-click drag to paint-select/erase tiles)
    this.isPainting = false;
    this.paintMode = null; // 'add' or 'erase', set by first hex in stroke
    this.paintedThisStroke = new Set();

    // Callbacks
    this.onSelectionChange = null;
    this.onReady = null;

    // Render state
    this._needsRender = true;
    this.lastFrameTime = performance.now();

    // Planet day/night rotation
    this.planetRotation = 0;

    this._init();
  }

  _init() {
    // Renderer setup
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.shadowMap.enabled = false; // no shadows needed for portal
    this.container.appendChild(this.renderer.domElement);

    // Camera layers
    this.camera.layers.enable(0);
    this.camera.layers.enable(this.BLOOM_LAYER);
    this.camera.layers.enable(2);

    // Raycaster
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Build the scene
    this._createSkybox();
    this._createLighting();
    this._createAtmosphere();
    this._createPlanetCore();
    this._createStars();
    this._generateTiles();
    this._createMoons();
    this._buildBillboardConfigs();
    this._createBillboards();
    this._setupBloom();
    this._setupControls();
    this._updateCameraPosition();

    // Start render loop
    this._animate();
  }

  // ═══════════════════════════════════════════════════════
  // ENVIRONMENT SETUP (adapted from environment.js + main.js)
  // ═══════════════════════════════════════════════════════

  _createSkybox() {
    // HDRI skybox sphere (from main.js:158-177)
    const skyboxGeo = new THREE.SphereGeometry(48000, 32, 16);
    const skyboxMat = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const skybox = new THREE.Mesh(skyboxGeo, skyboxMat);
    skybox.renderOrder = -9999;
    skybox.layers.set(0);
    this.scene.add(skybox);

    new THREE.TextureLoader().load("assets/sprites/hdri.png", (tex) => {
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      skyboxMat.map = tex;
      skyboxMat.needsUpdate = true;
      this._needsRender = true;
    });
  }

  _createLighting() {
    // Ambient light — blue tint (from environment.js:81)
    this.scene.add(new THREE.AmbientLight(0x3366aa, 0.4));

    // Sun directional light — world-space, always targets planet center (0,0,0)
    const sunLight = new THREE.DirectionalLight(0xffd9b7, 1.5);
    sunLight.target.position.set(0, 0, 0);
    this.scene.add(sunLight);
    this.scene.add(sunLight.target);
    this.sunLight = sunLight;
    this._sunOffset = new THREE.Vector3(-1, 1.4, 0.15).normalize();

    // Camera must be in scene graph for bloom camera syncing
    this.scene.add(this.camera);
  }

  _createAtmosphere() {
    // Fresnel atmosphere glow (from environment.js:218-265)
    const geometry = new THREE.SphereGeometry(this.sphereRadius + 33.6, 64, 64);
    this.atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x4db8ff) },
        cameraDistance: { value: 1152.0 },
      },
      vertexShader: `
        uniform float cameraDistance;
        varying float intensity;
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vPosition = mvPosition.xyz;
          float distanceFactor = smoothstep(672.0, 2400.0, cameraDistance);
          float power = mix(1.8, 3.5, distanceFactor);
          float threshold = mix(0.35, 0.55, distanceFactor);
          vec3 viewDir = normalize(-vPosition);
          float proximityFade = smoothstep(260.0, 520.0, cameraDistance);
          intensity = pow(threshold - dot(vNormal, viewDir), power) * proximityFade;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying float intensity;
        void main() {
          if (intensity <= 0.0) discard;
          gl_FragColor = vec4(glowColor * intensity, intensity * 0.75);
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    const atmosphereMesh = new THREE.Mesh(geometry, this.atmosphereMaterial);
    atmosphereMesh.matrixAutoUpdate = false;
    atmosphereMesh.updateMatrix();
    this.scene.add(atmosphereMesh);
  }

  _createPlanetCore() {
    // Glowing core visible through hollow poles (from environment.js:268-316)
    const coreMaterial = new THREE.ShaderMaterial({
      uniforms: {
        coreColor: { value: new THREE.Color().setHSL(0.52, 1, 0.8) },
        hdrMultiplier: { value: 1.0 },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mvPos.xyz);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform vec3 coreColor;
        uniform float hdrMultiplier;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        void main() {
          float facing = abs(dot(vNormal, vViewDir));
          float gradient = pow(facing, 1.5);
          vec3 col = coreColor * hdrMultiplier * gradient;
          gl_FragColor = vec4(col, gradient);
        }
      `,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });

    const coreMesh = new THREE.Mesh(
      new THREE.SphereGeometry(450, 32, 32),
      coreMaterial,
    );
    coreMesh.layers.set(3); // bloom-source-only
    coreMesh.matrixAutoUpdate = false;
    coreMesh.updateMatrix();
    this.scene.add(coreMesh);
  }

  _createStars() {
    // Star field (from environment.js:321-340)
    const starsGeometry = new THREE.BufferGeometry();
    const vertices = [];
    const minDist = 4800;

    for (let i = 0; i < 2000; i++) {
      let x, y, z, dist;
      do {
        x = (Math.random() - 0.5) * 28800;
        y = (Math.random() - 0.5) * 28800;
        z = (Math.random() - 0.5) * 28800;
        dist = Math.sqrt(x * x + y * y + z * z);
      } while (dist < minDist);
      vertices.push(x, y, z);
    }

    starsGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3),
    );

    const stars = new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 14.4 }),
    );
    stars.matrixAutoUpdate = false;
    stars.updateMatrix();
    this.scene.add(stars);
  }

  // ═══════════════════════════════════════════════════════
  // BLOOM PIPELINE (adapted from main.js:200-265)
  // ═══════════════════════════════════════════════════════

  _setupBloom() {
    // Bloom camera only sees layer 1 + 3
    this.bloomCamera = this.camera.clone();
    this.bloomCamera.layers.set(this.BLOOM_LAYER);
    this.bloomCamera.layers.enable(3);

    // Black occluder for planet hull in bloom pass
    this.bloomOcclusionMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    // Create occluder sphere matching planet
    const occluderGeo = new THREE.SphereGeometry(this.sphereRadius * 0.995, 32, 32);
    const occluder = new THREE.Mesh(occluderGeo, this.bloomOcclusionMaterial);
    occluder.layers.set(this.BLOOM_LAYER);
    occluder.matrixAutoUpdate = false;
    occluder.updateMatrix();
    this.scene.add(occluder);

    // Bloom composer at half resolution
    const bloomWidth = Math.floor(window.innerWidth / 2);
    const bloomHeight = Math.floor(window.innerHeight / 2);

    this.bloomComposer = new THREE.EffectComposer(this.renderer);
    this.bloomComposer.setSize(bloomWidth, bloomHeight);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new THREE.RenderPass(this.scene, this.bloomCamera));
    const bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(bloomWidth, bloomHeight),
      3,    // strength
      1.2,  // radius
      0.8,  // threshold
    );
    this.bloomComposer.addPass(bloomPass);

    // Final composer blends bloom on top of full scene
    const bloomBlendShader = {
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(baseTexture, vUv);
          vec4 bloom = texture2D(bloomTexture, vUv);
          gl_FragColor = base + bloom;
        }
      `,
    };

    this.finalComposer = new THREE.EffectComposer(this.renderer);
    const renderPass = new THREE.RenderPass(this.scene, this.camera);
    this.finalComposer.addPass(renderPass);
    const bloomBlendPass = new THREE.ShaderPass(bloomBlendShader, "baseTexture");
    bloomBlendPass.uniforms.bloomTexture.value =
      this.bloomComposer.renderTarget2.texture;
    bloomBlendPass.needsSwap = true;
    this.finalComposer.addPass(bloomBlendPass);
  }

  // ═══════════════════════════════════════════════════════
  // HEX TILE GENERATION (adapted from hexSelector.js:168-306)
  // ═══════════════════════════════════════════════════════

  _generateTiles() {
    if (typeof Hexasphere === "undefined") {
      console.error("[SponsorScene] Hexasphere.js not loaded");
      return;
    }

    const hexasphere = new Hexasphere(this.sphereRadius, this.subdivisions, 1.0);
    this._tiles = hexasphere.tiles;

    // Build adjacency map
    this.adjacencyMap = this._buildAdjacencyMap(hexasphere.tiles);

    // Mark excluded tiles (polar + portal)
    this._markExcludedTiles(hexasphere.tiles, this.adjacencyMap);

    // Build tier map
    if (typeof HexTierSystem !== "undefined") {
      this.tierMap = HexTierSystem.buildTierMap(
        hexasphere.tiles,
        this.sphereRadius,
        this.adjacencyMap,
      );
    }

    // Collect edge vertices for outline
    const allEdgeVertices = [];

    // Create hex tile meshes
    hexasphere.tiles.forEach((tile, index) => {
      const boundary = tile.boundary;
      const vertices = [];
      for (let i = 0; i < boundary.length; i++) {
        vertices.push(
          parseFloat(boundary[i].x),
          parseFloat(boundary[i].y),
          parseFloat(boundary[i].z),
        );
      }

      // Store center position
      this.tilePositions.set(index, new THREE.Vector3(
        parseFloat(tile.centerPoint.x),
        parseFloat(tile.centerPoint.y),
        parseFloat(tile.centerPoint.z),
      ));

      // Fan triangulation
      const indices = [];
      for (let i = 1; i < boundary.length - 1; i++) {
        indices.push(0, i, i + 1);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      // Tier-based coloring — all restricted tiles use the same dark gray
      let color;
      let tier = null;
      const isExcluded = this.excludedTiles.has(index);

      if (isExcluded) {
        color = 0x111111;
      } else if (this.tierMap) {
        tier = this.tierMap.get(index);
        const tierDef = HexTierSystem.TIERS[tier];
        color = tierDef ? tierDef.color : 0x4a4a4a;
      } else {
        color = 0x4a4a4a;
      }

      const material = new THREE.MeshPhongMaterial({
        color: color,
        specular: 0x111111,
        shininess: 15,
        flatShading: true,
        side: THREE.FrontSide,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = {
        tileIndex: index,
        isExcluded: isExcluded,
        originalColor: color,
        tier: tier,
      };

      this.scene.add(mesh);
      this.tileMeshes.push(mesh);
      this.tileIndexToMesh.set(index, mesh);

      // Edges for outline
      for (let i = 0; i < boundary.length; i++) {
        const curr = boundary[i];
        const next = boundary[(i + 1) % boundary.length];
        allEdgeVertices.push(
          parseFloat(curr.x), parseFloat(curr.y), parseFloat(curr.z),
          parseFloat(next.x), parseFloat(next.y), parseFloat(next.z),
        );
      }
    });

    // Merged outline (single draw call)
    const edgeGeometry = new THREE.BufferGeometry();
    edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(allEdgeVertices, 3));
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: 0x222222,
      transparent: true,
      opacity: 0.35,
    });
    this.scene.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));

    // Signal ready
    if (this.onReady) this.onReady();
  }

  _buildAdjacencyMap(tiles) {
    const adjacencyMap = new Map();
    const vertexToTiles = new Map();
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
      const y = parseFloat(tile.centerPoint.y);
      const phi = Math.acos(y / this.sphereRadius);
      const polarThreshold = (10 * Math.PI) / 180;
      if (phi < polarThreshold || phi > Math.PI - polarThreshold) {
        this.excludedTiles.add(index);
        this.polarTileIndices.add(index);
      }
      if (tile.boundary.length === 5) {
        portalCenters.add(index);
        this.excludedTiles.add(index);
      }
    });

    for (const portalIndex of portalCenters) {
      const neighbors = adjacencyMap.get(portalIndex) || [];
      for (const n of neighbors) this.excludedTiles.add(n);
    }
  }

  // ═══════════════════════════════════════════════════════
  // MOONS (adapted from hexSelector.js:323-345, game scale)
  // ═══════════════════════════════════════════════════════

  _createMoons() {
    this.moonMeshes = [];

    for (let i = 0; i < this.moonConfigs.length; i++) {
      const cfg = this.moonConfigs[i];
      const geometry = new THREE.SphereGeometry(cfg.radius, 24, 24);
      const material = new THREE.MeshPhongMaterial({
        color: cfg.color,
        emissive: cfg.emissive,
        specular: 0x181818,
        shininess: 20,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { isMoon: true, moonIndex: i, label: cfg.label, originalColor: cfg.color, originalEmissive: cfg.emissive };

      const x = cfg.distance * Math.cos(cfg.angle) * Math.cos(cfg.inclination);
      const y = cfg.distance * Math.sin(cfg.inclination);
      const z = cfg.distance * Math.sin(cfg.angle) * Math.cos(cfg.inclination);
      mesh.position.set(x, y, z);

      this.scene.add(mesh);
      this.moonMeshes.push(mesh);
    }
  }

  // ═══════════════════════════════════════════════════════
  // BILLBOARDS (adapted from hexSelector.js:351-475, game scale)
  // ═══════════════════════════════════════════════════════

  _buildBillboardConfigs() {
    this.billboardConfigs = [];
    const orbits = [
      { distance: 538, count: 12, inclinationRange: 0.25 },  // Low orbit
      { distance: 658, count: 6, inclinationRange: 0.20 },   // High orbit
    ];

    let globalIndex = 0;
    for (const orbit of orbits) {
      for (let i = 0; i < orbit.count; i++) {
        const angle = (i / orbit.count) * Math.PI * 2;
        const incSign = (i % 2 === 0) ? 1 : -1;
        const inclination = incSign * orbit.inclinationRange * ((i % 3 + 1) / 3);
        this.billboardConfigs.push({
          index: globalIndex,
          distance: orbit.distance,
          angle,
          inclination,
          orbit: orbit.distance === 538 ? "LOW" : "HIGH",
        });
        globalIndex++;
      }
    }
  }

  _createBillboardModel(orbit) {
    const group = new THREE.Group();
    // Scale factor from admin (radius 100) to game (radius 480) = 4.8
    const panelWidth = 57.6;
    const panelHeight = 38.4;

    // Color by orbit tier: LOW=$25 (teal/Frontier), HIGH=$100 (purple/Prime)
    const panelColor = orbit === "HIGH" ? 0x302a40 : 0x2a3b3a;
    const panelEmissive = orbit === "HIGH" ? 0x100d18 : 0x0a1514;

    // Ad panel
    const panelGeom = new THREE.PlaneGeometry(panelWidth, panelHeight);
    const panelMat = new THREE.MeshPhongMaterial({
      color: panelColor,
      emissive: panelEmissive,
      specular: 0x222222,
      shininess: 25,
      side: THREE.DoubleSide,
    });
    const adPanel = new THREE.Mesh(panelGeom, panelMat);
    adPanel.userData.isAdPanel = true;
    group.add(adPanel);

    // Frame beams
    const bt = 1.44;
    const bd = 2.4;
    const frameMat = new THREE.MeshPhongMaterial({ color: 0x444444, emissive: 0x080808, specular: 0x222222, shininess: 30 });

    const topBeam = new THREE.Mesh(new THREE.BoxGeometry(panelWidth + bt * 2, bt, bd), frameMat);
    topBeam.position.set(0, panelHeight / 2 + bt / 2, 0);
    group.add(topBeam);

    const bottomBeam = new THREE.Mesh(new THREE.BoxGeometry(panelWidth + bt * 2, bt, bd), frameMat);
    bottomBeam.position.set(0, -panelHeight / 2 - bt / 2, 0);
    group.add(bottomBeam);

    const leftBeam = new THREE.Mesh(new THREE.BoxGeometry(bt, panelHeight, bd), frameMat);
    leftBeam.position.set(-panelWidth / 2 - bt / 2, 0, 0);
    group.add(leftBeam);

    const rightBeam = new THREE.Mesh(new THREE.BoxGeometry(bt, panelHeight, bd), frameMat);
    rightBeam.position.set(panelWidth / 2 + bt / 2, 0, 0);
    group.add(rightBeam);

    // Solar wings
    const solarMat = new THREE.MeshPhongMaterial({ color: 0x1a1a3a, emissive: 0x050510, specular: 0x111122, shininess: 20, side: THREE.DoubleSide });
    const sw = 19.2, sh = 14.4;

    const leftSolar = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), solarMat);
    leftSolar.position.set(-panelWidth / 2 - bt - sw / 2 - 2.4, 0, 0);
    group.add(leftSolar);

    const rightSolar = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), solarMat);
    rightSolar.position.set(panelWidth / 2 + bt + sw / 2 + 2.4, 0, 0);
    group.add(rightSolar);

    // Hub connectors
    const hubGeom = new THREE.CylinderGeometry(1.92, 1.92, 3.84, 8);
    const hubMat = new THREE.MeshPhongMaterial({ color: 0x555555, specular: 0x222222, shininess: 25 });

    const leftHub = new THREE.Mesh(hubGeom, hubMat);
    leftHub.rotation.z = Math.PI / 2;
    leftHub.position.set(-panelWidth / 2 - bt - 0.96, 0, 0);
    group.add(leftHub);

    const rightHub = new THREE.Mesh(hubGeom, hubMat);
    rightHub.rotation.z = Math.PI / 2;
    rightHub.position.set(panelWidth / 2 + bt + 0.96, 0, 0);
    group.add(rightHub);

    return group;
  }

  _createBillboards() {
    this.billboardGroups = [];
    this.billboardAdPanels = [];

    for (let i = 0; i < this.billboardConfigs.length; i++) {
      const cfg = this.billboardConfigs[i];
      const group = this._createBillboardModel(cfg.orbit);

      const x = cfg.distance * Math.cos(cfg.angle) * Math.cos(cfg.inclination);
      const y = cfg.distance * Math.sin(cfg.inclination);
      const z = cfg.distance * Math.sin(cfg.angle) * Math.cos(cfg.inclination);
      group.position.set(x, y, z);
      group.lookAt(0, 0, 0);

      group.userData = { isBillboard: true, billboardIndex: i, orbit: cfg.orbit };

      const adPanel = group.children.find((c) => c.userData.isAdPanel);
      if (adPanel) {
        adPanel.userData.billboardIndex = i;
        adPanel.userData.isBillboard = true;
        adPanel.userData.originalColor = adPanel.material.color.getHex();
        adPanel.userData.originalEmissive = adPanel.material.emissive.getHex();
        this.billboardAdPanels.push(adPanel);
      }

      this.billboardGroups.push(group);
      this.scene.add(group);
    }
  }

  // ═══════════════════════════════════════════════════════
  // CONTROLS (adapted from hexSelector.js:837-1109)
  // ═══════════════════════════════════════════════════════

  _setupControls() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // Mouse controls
    canvas.addEventListener("mousedown", (e) => {
      this.lastInteractionTime = performance.now();
      if (e.button === 2) {
        this.isDragging = true;
        this.previousMouse = { x: e.clientX, y: e.clientY };
        this.lastMoveTime = performance.now();
        this.orbitalVelocity.theta = 0;
        this.orbitalVelocity.phi = 0;
      } else if (e.button === 0) {
        this.isLeftDown = true;
        this.dragStartMouse = { x: e.clientX, y: e.clientY };
        // Reset paint state for new stroke
        this.isPainting = false;
        this.paintMode = null;
        this.paintedThisStroke.clear();
      }
    });

    canvas.addEventListener("mousemove", (e) => {
      if (this.isDragging) {
        this.lastInteractionTime = performance.now();
        const dx = e.clientX - this.previousMouse.x;
        const dy = e.clientY - this.previousMouse.y;
        const now = performance.now();
        const deltaTime = now - this.lastMoveTime;

        if (deltaTime > 0 && deltaTime < 100) {
          this.orbitalVelocity.theta = ((dx * 0.005) / deltaTime) * 16;
          this.orbitalVelocity.phi = ((-dy * 0.005) / deltaTime) * 16;
        }

        this.orbitalTheta += dx * 0.005;
        this.orbitalPhi -= dy * 0.005;
        this.orbitalPhi = Math.max(
          (10 * Math.PI) / 180,
          Math.min((170 * Math.PI) / 180, this.orbitalPhi),
        );

        this.previousMouse = { x: e.clientX, y: e.clientY };
        this.lastMoveTime = now;
        this._updateCameraPosition();
      } else if (this.isLeftDown) {
        // Paint mode: once dragged past threshold, start painting tiles
        const dx = Math.abs(e.clientX - this.dragStartMouse.x);
        const dy = Math.abs(e.clientY - this.dragStartMouse.y);
        if (dx > 5 || dy > 5) {
          this.isPainting = true;
          this._paintAtScreen(e.clientX, e.clientY);
        }
      }
    });

    canvas.addEventListener("mouseup", (e) => {
      if (e.button === 2) {
        this.isDragging = false;
      } else if (e.button === 0) {
        if (this.isPainting) {
          // End paint stroke
          this.isPainting = false;
          this.paintMode = null;
          this.paintedThisStroke.clear();
        } else {
          // Single click — toggle
          const dx = Math.abs(e.clientX - this.dragStartMouse.x);
          const dy = Math.abs(e.clientY - this.dragStartMouse.y);
          if (dx < 5 && dy < 5) {
            this._handleClick(e);
          }
        }
        this.isLeftDown = false;
      }
    });

    canvas.addEventListener("mouseleave", () => {
      this.isDragging = false;
      if (this.isPainting) {
        this.isPainting = false;
        this.paintMode = null;
        this.paintedThisStroke.clear();
      }
      this.isLeftDown = false;
    });

    // Wheel controls
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.lastInteractionTime = performance.now();

      if (e.ctrlKey) {
        this.orbitalDistance += e.deltaY * 2.4;
        this.orbitalDistance = Math.max(528, Math.min(3360, this.orbitalDistance));
        this._updateCameraPosition();
        return;
      }

      const device = this._classifyWheelDevice(e);

      if (Math.abs(e.deltaX) > 0) {
        this.orbitalTheta -= e.deltaX * 0.001;
        this.orbitalVelocity.theta = -e.deltaX * 0.001 * 0.3;
        this._updateCameraPosition();
      }

      if (Math.abs(e.deltaY) > 0) {
        if (device === "mouse") {
          this.orbitalDistance += e.deltaY * 2.4;
          this.orbitalDistance = Math.max(528, Math.min(3360, this.orbitalDistance));
          this._updateCameraPosition();
        } else {
          this.orbitalPhi += e.deltaY * 0.001;
          this.orbitalPhi = Math.max(
            (10 * Math.PI) / 180,
            Math.min((170 * Math.PI) / 180, this.orbitalPhi),
          );
          this.orbitalVelocity.phi = e.deltaY * 0.001 * 0.3;
          this._updateCameraPosition();
        }
      }
    }, { passive: false });

    // Touch controls
    let touchStartDistance = 0;
    let lastTouchCenter = { x: 0, y: 0 };

    canvas.addEventListener("touchstart", (e) => {
      this.lastInteractionTime = performance.now();
      if (e.touches.length === 2) {
        e.preventDefault();
        this.isDragging = true;
        this.orbitalVelocity.theta = 0;
        this.orbitalVelocity.phi = 0;
        this.lastMoveTime = performance.now();
        const t1 = e.touches[0], t2 = e.touches[1];
        lastTouchCenter = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        touchStartDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      } else if (e.touches.length === 1) {
        this.dragStartMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && this.isDragging) {
        e.preventDefault();
        this.lastInteractionTime = performance.now();
        const t1 = e.touches[0], t2 = e.touches[1];
        const currentCenter = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
        const currentDistance = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        const dx = currentCenter.x - lastTouchCenter.x;
        const dy = currentCenter.y - lastTouchCenter.y;

        this.orbitalTheta += dx * 0.005;
        this.orbitalPhi -= dy * 0.005;
        this.orbitalPhi = Math.max((10 * Math.PI) / 180, Math.min((170 * Math.PI) / 180, this.orbitalPhi));

        const pinchDelta = currentDistance - touchStartDistance;
        if (Math.abs(pinchDelta) > 10) {
          this.orbitalDistance -= pinchDelta * 2.4;
          this.orbitalDistance = Math.max(528, Math.min(3360, this.orbitalDistance));
          touchStartDistance = currentDistance;
        }

        lastTouchCenter = currentCenter;
        this.lastMoveTime = performance.now();
        this._updateCameraPosition();
      }
    }, { passive: false });

    canvas.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) this.isDragging = false;
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

  _classifyWheelDevice(e) {
    const now = performance.now();
    const gesture = this._wheelGesture;
    const timeSinceLast = now - gesture.lastEventTime;

    if (!gesture.active || timeSinceLast > 400) {
      gesture.active = true;
      gesture.device = null;
      gesture.eventCount = 0;
      gesture.totalDeltaX = 0;
    }

    gesture.lastEventTime = now;
    gesture.eventCount++;
    gesture.totalDeltaX += Math.abs(e.deltaX);

    clearTimeout(gesture.timeoutId);
    gesture.timeoutId = setTimeout(() => {
      gesture.active = false;
      gesture.device = null;
    }, 400);

    if (gesture.device !== null) return gesture.device;
    if (e.deltaMode === 1) { gesture.device = "mouse"; return "mouse"; }
    if (Math.abs(e.deltaX) > 0 || gesture.totalDeltaX > 0) { gesture.device = "trackpad"; return "trackpad"; }
    if (e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0) {
      gesture.device = "mouse"; return "mouse";
    }
    if (gesture.eventCount >= 3 && timeSinceLast < 30) { gesture.device = "trackpad"; return "trackpad"; }
    return "trackpad";
  }

  // ═══════════════════════════════════════════════════════
  // CLICK HANDLING + SELECTION
  // ═══════════════════════════════════════════════════════

  _handleClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Check billboards first
    if (this.billboardAdPanels.length > 0) {
      const bbIntersects = this.raycaster.intersectObjects(this.billboardAdPanels);
      if (bbIntersects.length > 0) {
        const bbIndex = bbIntersects[0].object.userData.billboardIndex;
        this._toggleBillboardSelection(bbIndex);
        return;
      }
    }

    // Check moons
    if (this.moonMeshes.length > 0) {
      const moonIntersects = this.raycaster.intersectObjects(this.moonMeshes);
      if (moonIntersects.length > 0) {
        const moonIndex = moonIntersects[0].object.userData.moonIndex;
        this._toggleMoonSelection(moonIndex);
        return;
      }
    }

    // Check tiles
    const intersects = this.raycaster.intersectObjects(this.tileMeshes);
    if (intersects.length > 0) {
      const mesh = intersects[0].object;
      if (mesh.userData.isExcluded) return;
      this._toggleTileSelection(mesh.userData.tileIndex);
    }
  }

  _paintAtScreen(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const intersects = this.raycaster.intersectObjects(this.tileMeshes);
    if (intersects.length > 0) {
      const mesh = intersects[0].object;
      if (mesh.userData.isExcluded) return;
      const tileIndex = mesh.userData.tileIndex;
      if (this.paintedThisStroke.has(tileIndex)) return;

      // First hex in stroke determines add vs erase
      if (this.paintMode === null) {
        this.paintMode = this.selectedTiles.has(tileIndex) ? "erase" : "add";
      }

      this.paintedThisStroke.add(tileIndex);

      if (this.paintMode === "add" && !this.selectedTiles.has(tileIndex)) {
        this.selectedTiles.add(tileIndex);
        mesh.material.color.setHex(0xffd700);
        if (mesh.material.emissive) mesh.material.emissive.setHex(0x333300);
        this._needsRender = true;
        if (this.onSelectionChange) this.onSelectionChange();
      } else if (this.paintMode === "erase" && this.selectedTiles.has(tileIndex)) {
        this.selectedTiles.delete(tileIndex);
        mesh.material.color.setHex(mesh.userData.originalColor);
        if (mesh.material.emissive) mesh.material.emissive.setHex(0x000000);
        this._needsRender = true;
        if (this.onSelectionChange) this.onSelectionChange();
      }
    }
  }

  _toggleTileSelection(tileIndex) {
    const mesh = this.tileIndexToMesh.get(tileIndex);
    if (!mesh) return;

    if (this.selectedTiles.has(tileIndex)) {
      this.selectedTiles.delete(tileIndex);
      mesh.material.color.setHex(mesh.userData.originalColor);
      if (mesh.material.emissive) mesh.material.emissive.setHex(0x000000);
    } else {
      this.selectedTiles.add(tileIndex);
      mesh.material.color.setHex(0xffd700);
      if (mesh.material.emissive) mesh.material.emissive.setHex(0x333300);
    }
    this._needsRender = true;

    if (this.onSelectionChange) this.onSelectionChange();
  }

  _toggleMoonSelection(moonIndex) {
    const mesh = this.moonMeshes[moonIndex];
    if (!mesh) return;

    if (this.selectedMoons.has(moonIndex)) {
      this.selectedMoons.delete(moonIndex);
      mesh.material.color.setHex(mesh.userData.originalColor);
      mesh.material.emissive.setHex(mesh.userData.originalEmissive);
    } else {
      this.selectedMoons.add(moonIndex);
      mesh.material.color.setHex(0xffd700);
      mesh.material.emissive.setHex(0x333300);
    }
    this._needsRender = true;

    if (this.onSelectionChange) this.onSelectionChange();
  }

  _toggleBillboardSelection(bbIndex) {
    const group = this.billboardGroups[bbIndex];
    const adPanel = group && group.children.find((c) => c.userData.isAdPanel);
    if (!group || !adPanel) return;

    if (this.selectedBillboards.has(bbIndex)) {
      this.selectedBillboards.delete(bbIndex);
      adPanel.material.color.setHex(adPanel.userData.originalColor);
      adPanel.material.emissive.setHex(adPanel.userData.originalEmissive);
    } else {
      this.selectedBillboards.add(bbIndex);
      adPanel.material.color.setHex(0xffd700);
      adPanel.material.emissive.setHex(0x333300);
    }
    this._needsRender = true;

    if (this.onSelectionChange) this.onSelectionChange();
  }

  // ═══════════════════════════════════════════════════════
  // CAMERA + ANIMATION
  // ═══════════════════════════════════════════════════════

  _updateCameraPosition() {
    const x = this.orbitalDistance * Math.sin(this.orbitalPhi) * Math.cos(this.orbitalTheta);
    const y = this.orbitalDistance * Math.cos(this.orbitalPhi);
    const z = this.orbitalDistance * Math.sin(this.orbitalPhi) * Math.sin(this.orbitalTheta);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 0, 0);

    // Update sun light: offset from camera, always targeting planet center (0,0,0)
    if (this.sunLight) {
      const offset = this._sunOffset.clone().applyQuaternion(this.camera.quaternion);
      this.sunLight.position.copy(this.camera.position).addScaledVector(offset, 500);
    }

    // Sync bloom camera
    if (this.bloomCamera) {
      this.bloomCamera.position.copy(this.camera.position);
      this.bloomCamera.quaternion.copy(this.camera.quaternion);
      this.bloomCamera.projectionMatrix.copy(this.camera.projectionMatrix);
    }

    // Update atmosphere distance
    if (this.atmosphereMaterial) {
      this.atmosphereMaterial.uniforms.cameraDistance.value = this.orbitalDistance;
    }

    this._needsRender = true;
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    if (document.hidden) return;

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    if (elapsed < 33) return; // ~30 FPS

    this.lastFrameTime = now;

    // Auto-rotation when idle
    const timeSinceInteraction = now - this.lastInteractionTime;
    if (timeSinceInteraction > this.autoRotateDelay && !this.isDragging) {
      this.orbitalTheta += this.autoRotateSpeed;
      this.planetRotation += 0.0002;
      this._needsRender = true;
    }

    // Orbital momentum
    const hasMotion =
      this.isDragging ||
      Math.abs(this.orbitalVelocity.theta) > 0.0001 ||
      Math.abs(this.orbitalVelocity.phi) > 0.0001;

    if (hasMotion && !this.isDragging) {
      const minV = 0.0001;
      if (Math.abs(this.orbitalVelocity.theta) > minV || Math.abs(this.orbitalVelocity.phi) > minV) {
        this.orbitalTheta += this.orbitalVelocity.theta;
        this.orbitalPhi += this.orbitalVelocity.phi;
        this.orbitalPhi = Math.max((10 * Math.PI) / 180, Math.min((170 * Math.PI) / 180, this.orbitalPhi));
        this.orbitalVelocity.theta *= this.orbitalFriction;
        this.orbitalVelocity.phi *= this.orbitalFriction;
        if (Math.abs(this.orbitalVelocity.theta) < minV) this.orbitalVelocity.theta = 0;
        if (Math.abs(this.orbitalVelocity.phi) < minV) this.orbitalVelocity.phi = 0;
        this._updateCameraPosition();
      }
    }

    if (!this._needsRender && !hasMotion) return;
    this._needsRender = false;

    // Update camera position (for auto-rotation)
    this._updateCameraPosition();

    // Two-pass bloom render
    this.bloomComposer.render();
    this.finalComposer.render();
  }

  // ═══════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════

  getSelectedTiles() { return Array.from(this.selectedTiles); }
  getSelectedMoons() { return Array.from(this.selectedMoons); }
  getSelectedBillboards() { return Array.from(this.selectedBillboards); }
  getSelectionType() { return null; }

  hasSelection() {
    return this.selectedTiles.size > 0 ||
           this.selectedMoons.size > 0 ||
           this.selectedBillboards.size > 0;
  }

  getPricing() {
    if (typeof HexTierSystem === "undefined" || !this.tierMap) return null;

    const pricing = HexTierSystem.calculatePricing(this.getSelectedTiles(), this.tierMap);
    const moonPricing = HexTierSystem.calculateMoonPricing(this.getSelectedMoons());
    pricing.moons = moonPricing.moons;
    pricing.moonTotal = moonPricing.moonTotal;
    const bbPricing = HexTierSystem.calculateBillboardPricing(this.getSelectedBillboards());
    pricing.billboards = bbPricing.billboards;
    pricing.billboardTotal = bbPricing.billboardTotal;
    return pricing;
  }

  getTierStats() {
    if (typeof HexTierSystem === "undefined" || !this.tierMap) return null;
    return HexTierSystem.getTierStats(this.tierMap);
  }

  clearSelection() {
    // Clear tiles
    for (const tileIndex of this.selectedTiles) {
      const mesh = this.tileIndexToMesh.get(tileIndex);
      if (mesh) {
        mesh.material.color.setHex(mesh.userData.originalColor);
        if (mesh.material.emissive) mesh.material.emissive.setHex(0x000000);
      }
    }
    this.selectedTiles.clear();

    // Clear moons
    for (const mi of this.selectedMoons) {
      const mesh = this.moonMeshes[mi];
      if (mesh) {
        mesh.material.color.setHex(mesh.userData.originalColor);
        mesh.material.emissive.setHex(mesh.userData.originalEmissive);
      }
    }
    this.selectedMoons.clear();

    // Clear billboards
    for (const bi of this.selectedBillboards) {
      const group = this.billboardGroups[bi];
      const adPanel = group && group.children.find((c) => c.userData.isAdPanel);
      if (adPanel) {
        adPanel.material.color.setHex(adPanel.userData.originalColor);
        adPanel.material.emissive.setHex(adPanel.userData.originalEmissive);
      }
    }
    this.selectedBillboards.clear();

    this._needsRender = true;

    if (this.onSelectionChange) this.onSelectionChange();
  }

  captureScreenshot() {
    // Force a render
    this.bloomComposer.render();
    this.finalComposer.render();

    // Capture and downscale preserving aspect ratio (max 800px wide)
    const canvas = this.renderer.domElement;
    const aspect = canvas.width / canvas.height;
    const w = Math.min(800, canvas.width);
    const h = Math.round(w / aspect);
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = w;
    tmpCanvas.height = h;
    const ctx = tmpCanvas.getContext("2d");
    ctx.drawImage(canvas, 0, 0, w, h);
    return tmpCanvas.toDataURL("image/png");
  }

  getAdminImportPayload() {
    const data = {
      tiles: this.getSelectedTiles(),
      moons: this.getSelectedMoons(),
      billboards: this.getSelectedBillboards(),
    };
    return btoa(JSON.stringify(data));
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);

    if (this.bloomCamera) {
      this.bloomCamera.aspect = w / h;
      this.bloomCamera.updateProjectionMatrix();
    }

    const bw = Math.floor(w / 2);
    const bh = Math.floor(h / 2);
    if (this.bloomComposer) this.bloomComposer.setSize(bw, bh);
    if (this.finalComposer) this.finalComposer.setSize(w, h);

    this._needsRender = true;
  }
}

// Make available globally
if (typeof window !== "undefined") {
  window.SponsorScene = SponsorScene;
}
