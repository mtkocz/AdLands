/**
 * AdLands - Cannon System Module
 * Projectile management for tank weapons
 */

// Distance fade config for sprites (explosions, decals, etc.)
const SPRITE_FADE_START = 100; // Start fading sprites at this camera distance
const PROJECTILE_CULL_DISTANCE = 260; // Fully invisible at this camera distance

// Preallocated vectors for collision detection and distance fade (avoid per-frame GC)
const _spriteWorldPos = new THREE.Vector3();
const _cameraWorldPos = new THREE.Vector3();
const _prevPosition = new THREE.Vector3();
const _moveVector = new THREE.Vector3();
const _pathDir = new THREE.Vector3();
const _toTank = new THREE.Vector3();
const _closestPoint = new THREE.Vector3();
const _testPos = new THREE.Vector3();
const _projectileToTank = new THREE.Vector3();
const _horizontalOffset = new THREE.Vector3();
const _tankWorldPos = new THREE.Vector3();
const _tankSurfaceNormal = new THREE.Vector3();
const _terrainLocalPos = new THREE.Vector3();
// Preallocated sphere for frustum culling (flares, projectiles, explosions)
const _cannonCullSphere = new THREE.Sphere();
// Preallocated vectors for far-side (backface) culling
const _cannonCullNormal = new THREE.Vector3();
const _cannonCullDir = new THREE.Vector3();
// Preallocated vectors for fireShot (avoid per-shot allocations)
const _muzzleLocal = new THREE.Vector3();
const _muzzleWorld = new THREE.Vector3();
const _shotSurfaceNormal = new THREE.Vector3();
const _shotDirection = new THREE.Vector3();
const _shotDirWorld = new THREE.Vector3();
const _shotTarget = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

class CannonSystem {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.projectiles = [];
    this.lastFireTime = 0;
    this.gameCamera = null;
    this.playerTank = null;
    this.botTanks = null; // Reference to BotTanks system for collision
    this.dustShockwave = null; // Reference to dust shockwave effect
    this.planet = null; // Reference to planet for parenting decals

    // Charging state
    this.charging = {
      active: false,
      power: 0, // Current charge (0-10)
      maxPower: 10, // Maximum charge value
      chargeTime: 5, // Seconds to reach max charge
      shakeInterval: 0.1, // How often to pulse shake while charging
      lastShakeTime: 0,
    };

    this.config = {
      // Base values (at charge 0)
      projectileSpeed: 0.84375, // Units per frame
      projectileLength: 2.5, // Tracer length
      projectileRadius: 0.125, // Tracer thickness
      maxDistance: 20, // Max range before despawn
      maxLifetime: 2, // Fallback timeout (seconds)
      cooldown: 2, // Time between shots
      // Charge multipliers (applied at max charge)
      chargeSpeedMultiplier: 2, // 2x speed at max charge
      chargeRangeMultiplier: 3, // 4x range at max charge
      chargeDamageMultiplier: 3, // 3x damage at max charge
      chargeSizeMultiplier: 1.5, // 1.5x projectile size at max charge
    };

    // Pre-create materials for each faction (HDR for bloom)
    this.materials = {};
    this._createMaterials();

    // Pre-create point lights for each faction (reused via pooling)
    this.lights = {};
    this._createLights();

    // Shared geometry (reused for all projectiles)
    this.geometry = new THREE.CylinderGeometry(
      this.config.projectileRadius,
      this.config.projectileRadius,
      this.config.projectileLength,
      8,
    );
    this.geometry.rotateX(Math.PI / 2); // Orient along Z

    // Explosion system (sprite sheet based)
    this.explosions = [];
    this._createExplosionSystem();

    // LOD explosion system (simple circles for orbital view)
    this.lodExplosions = [];
    this._createLODExplosionSystem();

    // Track if we're in orbital view for LOD decisions
    this.isOrbitalView = false;

    // Load explosion sprite sheet
    this.explosionTexture = null;
    this._loadExplosionSprite();

    // ========================
    // MUZZLE FLARE CONFIG
    // ========================
    this.muzzleFlareConfig = {
      duration: 0.1,
      size: 0.5,
      intensity: 3, // Color multiplier for emission brightness
    };
    this.muzzleFlares = [];
    this.muzzleFlareMaterials = {}; // Set in _createMuzzleEffects()

    this._createMuzzleEffects();

    // Object pooling system for performance
    this.objectPools = new ObjectPools(scene, this);
    this.objectPools._initializeProjectilePool();
    // Note: Explosion pooling disabled - using simple sprite approach instead
    // this.objectPools._initializeExplosionPool();

    // Impact decals
    this.impactDecals = [];
    this.impactDecalTexture = null;
    this._loadImpactDecalTexture();
    this.impactDecalConfig = {
      size: 10.5, // Base size in units
      color: 0x000000, // Black
      lifetime: 10, // Fade out after 10 seconds
      fadeOutDuration: 2, // Fade out over 2 seconds
    };
    this.impactDecalGeometry = new THREE.PlaneGeometry(1, 1);

    // Oil puddle system (for tank deaths)
    this.oilPuddles = [];
    this.oilPuddleConfig = {
      color: 0x0a0a0a, // Very dark (almost black) oil
      maxSize: 12, // Final size after spreading
      spreadDuration: 4, // Time to spread to full size (seconds) - slow ooze
      lifetime: 30, // Stay visible for 30 seconds
      fadeOutDuration: 5, // Fade out over 5 seconds
    };
    // Shared geometry for all oil puddles (simple quad instead of 24-seg blob)
    this.oilPuddleGeometry = new THREE.PlaneGeometry(1, 1);
  }

  _createExplosionSystem() {
    // Sprite sheet explosion config
    this.explosionConfig = {
      columns: 8, // Sprite sheet columns
      rows: 4, // Sprite sheet rows
      totalFrames: 32, // Total animation frames (8x4)
      duration: 32 / 24, // Animation duration in seconds (32 frames @ 24fps = 1.33s)
      baseSize: 12, // World-unit size of explosion sprite (sizeAttenuation: true)
    };

    // Store faction colors for tinting
    this.factionColors = {};
    for (const faction of ["rust", "cobalt", "viridian"]) {
      this.factionColors[faction] = FACTION_COLORS[faction].three.clone();
    }
  }

  _createLODExplosionSystem() {
    // LOD explosions — hard-edged concentric rings, short & punchy
    this.lodExplosionConfig = {
      baseSize: 10.5,
      duration: 1,
    };

    // Hard-edged 3-band ring texture (white core / orange / dark red)
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const half = size / 2;
    const g = ctx.createRadialGradient(half, half, 0, half, half, half);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.22, "#ffffff");
    g.addColorStop(0.23, "#ff8820");
    g.addColorStop(0.52, "#ff8820");
    g.addColorStop(0.53, "#551100");
    g.addColorStop(0.78, "#551100");
    g.addColorStop(0.79, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const circleTexture = new THREE.CanvasTexture(canvas);
    circleTexture.minFilter = THREE.NearestFilter;
    circleTexture.magFilter = THREE.NearestFilter;

    // Per-faction materials — subtle faction tint over explosion palette
    this.lodExplosionMaterials = {};
    for (const faction of ["rust", "cobalt", "viridian"]) {
      const factionColor = FACTION_COLORS[faction].three.clone();
      const color = new THREE.Color(1.0, 0.7, 0.4).lerp(factionColor, 0.25);
      color.multiplyScalar(1.5);

      this.lodExplosionMaterials[faction] = new THREE.SpriteMaterial({
        map: circleTexture,
        color: color,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    }
  }

  _loadExplosionSprite() {
    const loader = new THREE.TextureLoader();
    loader.load(
      "assets/sprites/explosion1.png",
      (texture) => {
        // Success callback
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        this.explosionTexture = texture;
      },
      (progress) => {
        // Progress callback
      },
      (error) => {
        // Error callback
        console.error("[CANNON] Failed to load explosion texture:", error);
      },
    );
  }

  _loadImpactDecalTexture() {
    const loader = new THREE.TextureLoader();
    loader.load("assets/sprites/blastdecal.png", (texture) => {
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      this.impactDecalTexture = texture;
    });
  }

  _spawnImpactDecal(position, sizeScale = 1) {
    if (!this.impactDecalTexture || !this.planet) {
      return;
    }

    // Cap decals to limit draw calls — recycle oldest when full
    while (this.impactDecals.length >= 30) {
      const oldest = this.impactDecals.shift();
      this.planet.hexGroup.remove(oldest.mesh);
      oldest.material.alphaMap = null;
      oldest.material.dispose();
    }

    const normal = position.clone().normalize();

    // Project position onto sphere surface (not at explosion height)
    const surfacePosition = normal.clone().multiplyScalar(this.sphereRadius + 0.1);

    // Convert to planet's local space for parenting
    const localPosition = surfacePosition.clone();
    this.planet.hexGroup.worldToLocal(localPosition);

    // Skip decals centered inside the pole hole
    if (this.planet.isInsidePolarHole(localPosition)) {
      return;
    }

    const cfg = this.impactDecalConfig;

    // Random opacity between 60% and 100% for visual variety
    const randomOpacity = 0.6 + Math.random() * 0.4;

    // Create black material with decal texture as alpha map
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000, // Black
      alphaMap: this.impactDecalTexture,
      transparent: true,
      opacity: randomOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(this.impactDecalGeometry, material);

    // Position at surface (in local space)
    mesh.position.copy(localPosition);

    // Orient flat on surface (normal in local space)
    const localNormal = localPosition.clone().normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);

    // Random rotation around normal axis
    mesh.rotateZ(Math.random() * Math.PI * 2);

    // Random flip on X and/or Y for variety
    const flipX = Math.random() > 0.5 ? -1 : 1;
    const flipY = Math.random() > 0.5 ? -1 : 1;

    // Random size between 60% and 100% for visual variety
    const randomSizeScale = 0.6 + Math.random() * 0.4;
    const size = cfg.size * sizeScale * randomSizeScale;
    mesh.scale.set(size * flipX, size * flipY, 1);

    // Ensure matrix is up-to-date for polar clipping shader
    mesh.updateMatrix();

    // Clip decal fragments that extend over pole holes
    this._applyPolarClipping(material, mesh);

    // Set to default layer (layer 0) for visibility
    mesh.layers.set(0);

    // Set render order to ensure it renders on top of terrain
    mesh.renderOrder = 100;

    // Disable frustum culling (will be parented to rotating planet)
    mesh.frustumCulled = false;

    // Parent to planet's hexGroup so it rotates with planet
    this.planet.hexGroup.add(mesh);

    this.impactDecals.push({
      mesh,
      material,
      age: 0,
      baseOpacity: randomOpacity,
    });
  }

  _updateImpactDecals(deltaTime) {
    const cfg = this.impactDecalConfig;
    const fadeStart = cfg.lifetime - cfg.fadeOutDuration;

    for (let i = this.impactDecals.length - 1; i >= 0; i--) {
      const decal = this.impactDecals[i];
      decal.age += deltaTime;

      // Remove if fully faded
      if (decal.age >= cfg.lifetime) {
        if (this.planet) {
          this.planet.hexGroup.remove(decal.mesh);
        }
        decal.material.alphaMap = null;
        decal.material.dispose();
        this.impactDecals.splice(i, 1);
        continue;
      }

      // Calculate age-based opacity
      let ageOpacity = decal.baseOpacity;
      if (decal.age > fadeStart) {
        const fadeProgress = (decal.age - fadeStart) / cfg.fadeOutDuration;
        ageOpacity = decal.baseOpacity * (1 - fadeProgress);
      }

      // Distance fade (smooth fade to zero at PROJECTILE_CULL_DISTANCE)
      if (this.gameCamera?.camera) {
        decal.mesh.getWorldPosition(_spriteWorldPos);
        const dist = _spriteWorldPos.distanceTo(_cameraWorldPos);
        const distanceFade =
          1 -
          Math.max(
            0,
            Math.min(
              1,
              (dist - SPRITE_FADE_START) /
                (PROJECTILE_CULL_DISTANCE - SPRITE_FADE_START),
            ),
          );
        ageOpacity *= distanceFade;
      }

      // Set opacity
      decal.material.opacity = ageOpacity;
    }
  }

  /**
   * Generate a pixelated oil blob texture on a small canvas
   * @returns {THREE.CanvasTexture}
   */
  _generateOilPuddleTexture() {
    const size = 32; // Pixelated but higher detail
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Clear transparent
    ctx.clearRect(0, 0, size, size);

    const half = size / 2;
    const imageData = ctx.createImageData(size, size);
    const data = imageData.data;
    const seed = Math.random() * 1000;

    // Draw a pixelated blob: for each pixel, check distance from center
    // with noise to create irregular edges
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - half + 0.5) / half; // -1 to 1
        const dy = (y - half + 0.5) / half;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Angle-based noise for irregular blob shape
        const angle = Math.atan2(dy, dx);
        const noise =
          0.15 * Math.sin(angle * 2 + seed) +
          0.1 * Math.sin(angle * 3 + seed * 1.7) +
          0.08 * Math.sin(angle * 5 + seed * 2.3);

        // Threshold with noise — pixels inside the blob are filled
        const threshold = 0.72 + noise;
        if (dist < threshold) {
          const idx = (y * size + x) * 4;
          data[idx] = 8; // R
          data[idx + 1] = 8; // G
          data[idx + 2] = 8; // B
          data[idx + 3] = 255; // A — fully opaque
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  /**
   * Spawn an oil puddle at a tank's death position
   * @param {THREE.Vector3} position - World position of the dead tank
   */
  spawnOilPuddle(position) {
    if (!this.planet) {
      console.warn("[OIL PUDDLE] Planet not set");
      return;
    }

    const cfg = this.oilPuddleConfig;

    // Cap active puddles — force oldest into fade-out instead of instant removal
    const fadeStart = cfg.lifetime - cfg.fadeOutDuration;
    let activeCount = 0;
    for (const p of this.oilPuddles) {
      if (p.age < fadeStart) activeCount++;
    }
    if (activeCount >= 10) {
      // Force the oldest non-fading puddle into its fade phase
      for (const p of this.oilPuddles) {
        if (p.age < fadeStart) {
          p.age = fadeStart;
          break;
        }
      }
    }

    // Generate a unique pixelated blob texture for this puddle
    const texture = this._generateOilPuddleTexture();

    // Create dark oil material with pixelated texture
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Reuse shared plane geometry
    const mesh = new THREE.Mesh(this.oilPuddleGeometry, material);

    // Project position onto sphere surface (raised to avoid z-fighting)
    const normal = position.clone().normalize();
    const surfacePosition = normal
      .clone()
      .multiplyScalar(this.sphereRadius + 0.15);

    // Convert to planet's local space
    const localPosition = surfacePosition.clone();
    this.planet.hexGroup.worldToLocal(localPosition);

    // Skip oil puddles centered inside the pole hole
    if (this.planet.isInsidePolarHole(localPosition)) {
      texture.dispose();
      material.dispose();
      return;
    }

    mesh.position.copy(localPosition);

    // Orient flat on surface (plane's default normal is +Z)
    const localNormal = localPosition.clone().normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), localNormal);

    // Start at small size, will grow during spread phase
    mesh.scale.set(0.1, 0.1, 1);

    // Clip oil puddle fragments that extend over pole holes
    mesh.updateMatrix();
    this._applyPolarClipping(material, mesh);

    // Parent to planet
    this.planet.hexGroup.add(mesh);

    this.oilPuddles.push({
      mesh,
      material,
      age: 0,
      targetSize: cfg.maxSize * (0.8 + Math.random() * 0.4), // Some size variation
    });
  }

  _updateOilPuddles(deltaTime) {
    const cfg = this.oilPuddleConfig;
    const fadeStart = cfg.lifetime - cfg.fadeOutDuration;

    for (let i = this.oilPuddles.length - 1; i >= 0; i--) {
      const puddle = this.oilPuddles[i];
      puddle.age += deltaTime;

      // Remove if fully faded
      if (puddle.age >= cfg.lifetime) {
        if (this.planet) {
          this.planet.hexGroup.remove(puddle.mesh);
        }
        puddle.material.map.dispose();
        puddle.material.dispose();
        this.oilPuddles.splice(i, 1);
        continue;
      }

      // Spreading phase: grow from 0 to target size
      if (puddle.age < cfg.spreadDuration) {
        const spreadProgress = puddle.age / cfg.spreadDuration;
        // Ease-out for natural spread (fast start, slow end)
        const eased = 1 - Math.pow(1 - spreadProgress, 3);
        const size = puddle.targetSize * eased;
        puddle.mesh.scale.set(size, size, 1);
      } else {
        // Ensure at full size after spread
        puddle.mesh.scale.set(puddle.targetSize, puddle.targetSize, 1);
      }

      // Calculate base opacity from age fade
      let opacity = 1.0;
      if (puddle.age > fadeStart) {
        const fadeProgress = (puddle.age - fadeStart) / cfg.fadeOutDuration;
        opacity = 1.0 - fadeProgress;
      }

      // Distance fade (smooth fade to zero at PROJECTILE_CULL_DISTANCE)
      if (this.gameCamera?.camera) {
        puddle.mesh.getWorldPosition(_spriteWorldPos);
        const dist = _spriteWorldPos.distanceTo(_cameraWorldPos);
        const distanceFade =
          1 -
          Math.max(
            0,
            Math.min(
              1,
              (dist - SPRITE_FADE_START) /
                (PROJECTILE_CULL_DISTANCE - SPRITE_FADE_START),
            ),
          );
        opacity *= distanceFade;
      }

      puddle.material.opacity = opacity;
    }
  }

  _createMuzzleEffects() {
    // Create muzzle flare materials per faction (bright burst at barrel tip)
    for (const faction of ["rust", "cobalt", "viridian"]) {
      const color = FACTION_COLORS[faction].three.clone();
      color.multiplyScalar(this.muzzleFlareConfig.intensity);

      this.muzzleFlareMaterials[faction] = new THREE.SpriteMaterial({
        color: color,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    }
  }

  _createMaterials() {
    for (const faction of ["rust", "cobalt", "viridian"]) {
      // Use base faction color, boosted for strong bloom
      const color = FACTION_COLORS[faction].three.clone();
      color.multiplyScalar(5); // HDR boost for vivid faction color

      this.materials[faction] = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 1,
      });
    }
  }

  _createLights() {
    // Pre-create one PointLight per faction for reuse
    for (const faction of ["rust", "cobalt", "viridian"]) {
      this.lights[faction] = new THREE.PointLight(
        FACTION_COLORS[faction].hex,
        5, // intensity (stronger for vivid faction color glow)
        50, // distance (falloff range)
      );
    }
  }

  setCamera(gameCamera) {
    this.gameCamera = gameCamera;
  }

  setPlayerTank(playerTank) {
    this.playerTank = playerTank;
  }

  setBotTanks(botTanks) {
    this.botTanks = botTanks;
  }

  setDustShockwave(dustShockwave) {
    this.dustShockwave = dustShockwave;
  }

  setPlanet(planet) {
    this.planet = planet;
    this._computePolarClipData();
  }

  /**
   * Build polar hole polygon data for GPU-side clipping.
   * Converts Planet's boundary polygons into vec2 arrays for GLSL ray-casting.
   */
  _computePolarClipData() {
    this._polarClip = null;
    if (!this.planet) return;

    const north = this.planet._northPolePolygon;
    const south = this.planet._southPolePolygon;
    if (!north && !south) return;

    // Convert {x, z} polygon arrays to THREE.Vector2 arrays for uniform vec2[]
    const toVec2Array = (poly) => {
      if (!poly) return [];
      return poly.map((v) => new THREE.Vector2(v.x, v.z));
    };

    // Pad arrays to fixed length (48) with zeros for GLSL uniform array
    const MAX_VERTS = 48;
    const pad = (arr) => {
      const padded = new Array(MAX_VERTS);
      for (let i = 0; i < MAX_VERTS; i++) {
        padded[i] = i < arr.length ? arr[i] : new THREE.Vector2(0, 0);
      }
      return padded;
    };

    const northVerts = toVec2Array(north);
    const southVerts = toVec2Array(south);

    // Quick-rejection Y threshold: cos(20°) * radius (matches Planet.isInsidePolarHole)
    const yThreshold = this.planet.radius * 0.9397;

    this._polarClip = {
      northPoly: pad(northVerts),
      northCount: northVerts.length,
      southPoly: pad(southVerts),
      southCount: southVerts.length,
      yThreshold,
    };
  }

  /**
   * Inject polar hole clipping into a material's shader.
   * Uses ray-casting point-in-polygon test in GLSL to precisely clip
   * fragments at the hex boundary edges of pole holes.
   * @param {THREE.Material} material
   * @param {THREE.Mesh} mesh - must have updateMatrix() called first
   */
  _applyPolarClipping(material, mesh) {
    const clip = this._polarClip;
    if (!clip) return;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.u_meshMatrix = { value: mesh.matrix };
      shader.uniforms.u_northPoly = { value: clip.northPoly };
      shader.uniforms.u_northPolyCount = { value: clip.northCount };
      shader.uniforms.u_southPoly = { value: clip.southPoly };
      shader.uniforms.u_southPolyCount = { value: clip.southCount };
      shader.uniforms.u_yThreshold = { value: clip.yThreshold };

      shader.vertexShader = shader.vertexShader.replace(
        'void main() {',
        `uniform mat4 u_meshMatrix;
varying vec3 vHexLocalPos;
void main() {
  vHexLocalPos = (u_meshMatrix * vec4(position, 1.0)).xyz;`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        `uniform vec2 u_northPoly[48];
uniform int u_northPolyCount;
uniform vec2 u_southPoly[48];
uniform int u_southPolyCount;
uniform float u_yThreshold;
varying vec3 vHexLocalPos;
void main() {
  float absY = abs(vHexLocalPos.y);
  if (absY > u_yThreshold) {
    float px = vHexLocalPos.x;
    float pz = vHexLocalPos.z;
    bool inside = false;
    if (vHexLocalPos.y > 0.0 && u_northPolyCount > 0) {
      int j = u_northPolyCount - 1;
      for (int i = 0; i < 48; i++) {
        if (i >= u_northPolyCount) break;
        float zi = u_northPoly[i].y;
        float zj = u_northPoly[j].y;
        if ((zi > pz) != (zj > pz)) {
          float xi = u_northPoly[i].x;
          float xj = u_northPoly[j].x;
          if (px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
            inside = !inside;
          }
        }
        j = i;
      }
    } else if (vHexLocalPos.y < 0.0 && u_southPolyCount > 0) {
      int j = u_southPolyCount - 1;
      for (int i = 0; i < 48; i++) {
        if (i >= u_southPolyCount) break;
        float zi = u_southPoly[i].y;
        float zj = u_southPoly[j].y;
        if ((zi > pz) != (zj > pz)) {
          float xi = u_southPoly[i].x;
          float xj = u_southPoly[j].x;
          if (px < (xj - xi) * (pz - zi) / (zj - zi) + xi) {
            inside = !inside;
          }
        }
        j = i;
      }
    }
    if (inside) discard;
  }`
      );
    };
  }

  setCryptoSystem(cryptoSystem) {
    this.cryptoSystem = cryptoSystem;
  }

  setTitleSystem(titleSystem) {
    this.titleSystem = titleSystem;
  }

  setVisualEffects(visualEffects) {
    this.visualEffects = visualEffects;
  }

  setLightingConfig(lightConfig) {
    // Reserved for future lighting-aware effects
  }

  // ========================
  // TANK COLLISION
  // ========================

  /**
   * Get all tank hitboxes for collision testing
   * @returns {THREE.Mesh[]} Array of hitbox meshes
   */
  _getAllTankHitboxes() {
    const hitboxes = [];

    // Player tank
    if (this.playerTank?.hitbox) {
      hitboxes.push(this.playerTank.hitbox);
    }

    // Bot tanks
    if (this.botTanks) {
      for (const bot of this.botTanks.bots) {
        if (bot.hitbox && !bot.isDead && !bot.isDeploying) {
          hitboxes.push(bot.hitbox);
        }
      }
    }

    // Remote tanks (multiplayer)
    if (window._mpState?.remoteTanks) {
      for (const [, remoteTank] of window._mpState.remoteTanks) {
        if (remoteTank.hitbox && !remoteTank.isDead) {
          hitboxes.push(remoteTank.hitbox);
        }
      }
    }

    return hitboxes;
  }

  /**
   * Apply damage to a tank when hit by projectile
   * @param {Object} tank - Tank or bot object
   * @param {Object} projectile - Projectile data
   * @returns {boolean} True if the tank died from this hit
   */
  _onTankHit(tank, projectile) {
    // Calculate damage: 25 base + up to 50 from charge
    // projectile.damage ranges from 1 (no charge) to 3 (full charge)
    const baseDamage = 25;
    const chargeDamage = (projectile.damage - 1) * 25; // 0 to 50
    let totalDamage = Math.round(baseDamage + chargeDamage);

    // Apply weapon slot damage modifier (if this is a player shot)
    if (this.weaponSlotSystem && projectile.faction === this.playerTank?.faction) {
      const mods = this.weaponSlotSystem.getModifiers();
      totalDamage = Math.round(totalDamage * mods.damageMultiplier);
    }

    // Check if this hit will kill the tank
    const willDie = tank.hp - totalDamage <= 0;

    // Award crypto for damage dealt by player
    const isPlayerShot = projectile.faction === this.playerTank?.faction;
    if (isPlayerShot && tank !== this.playerTank) {
      // Get target tank position for floating crypto number (emits from damaged/killed tank)
      const targetPos = new THREE.Vector3();
      if (tank.group) {
        tank.group.getWorldPosition(targetPos);
      }

      // Check if target is a commander (10x crypto bonus)
      let isCommander = false;
      if (window.commanderSystem) {
        const commanders = window.commanderSystem.getAllCommanders();
        for (const faction in commanders) {
          if (commanders[faction]?.tankRef === tank) {
            isCommander = true;
            break;
          }
        }
      }
      const cryptoMultiplier = isCommander ? 10 : 1;

      // Award damage crypto (10x for commanders)
      if (this.cryptoSystem) {
        this.cryptoSystem.stats.damageDealt += totalDamage;
        const damageCrypto = Math.floor(
          totalDamage * this.cryptoSystem.cryptoValues.damageDealt * cryptoMultiplier,
        );
        this.cryptoSystem.awardCrypto(
          damageCrypto,
          isCommander ? "commander damage" : "damage",
          targetPos,
        );

        // Award kill crypto if this hit kills the target (10x for commanders)
        if (willDie) {
          this.cryptoSystem.stats.kills++;
          const killCrypto = this.cryptoSystem.cryptoValues.killBonus * cryptoMultiplier;
          this.cryptoSystem.awardCrypto(
            killCrypto,
            isCommander ? "commander kill" : "kill",
            targetPos,
          );
        }
      }

      // Track damage and hit for title system
      if (this.titleSystem) {
        this.titleSystem.trackDamage(totalDamage);
        this.titleSystem.trackShots(0, 1); // 0 fired, 1 hit
      }
    }

    // Apply damage based on tank type
    if (tank === this.playerTank) {
      tank.takeDamage(totalDamage, projectile.faction);
    } else if (tank instanceof RemoteTank) {
      // Remote player — visual hit feedback only, server handles HP + authoritative flash
      // (server player-hit event triggers the white flash and HP bar update)
      if (tank.group) {
        // Scale bump (120ms) — instant client-side feedback
        const origScale = tank.group.scale.clone();
        tank.group.scale.multiplyScalar(1.15);
        setTimeout(() => {
          if (tank.group) tank.group.scale.copy(origScale);
        }, 120);
      }
    } else if (this.botTanks) {
      // It's a bot - use BotTanks damage method
      this.botTanks.applyDamage(tank, totalDamage, projectile.faction);
    }

    return willDie;
  }

  // ========================
  // CHARGING SYSTEM
  // ========================

  startCharge() {
    this.charging.active = true;
    this.charging.power = 0;
    this.charging.lastShakeTime = performance.now() / 1000;
  }

  updateCharge(deltaTime, tank, faction) {
    if (!this.charging.active) return;

    // Cancel charge if tank died while charging
    if (tank && tank.isDead) {
      this.cancelCharge();
      return;
    }

    // Increase charge power
    const chargeRate = this.charging.maxPower / this.charging.chargeTime;
    this.charging.power = Math.min(
      this.charging.maxPower,
      this.charging.power + chargeRate * deltaTime,
    );

    // Apply charging screen shake (intensifies with charge)
    const now = performance.now() / 1000;
    if (now - this.charging.lastShakeTime >= this.charging.shakeInterval) {
      this.charging.lastShakeTime = now;

      if (this.gameCamera && this.playerTank) {
        // Shake intensity scales with charge (0.02 to 0.12)
        const chargeRatio = this.charging.power / this.charging.maxPower;
        const shakeIntensity = 0.02 + chargeRatio * 0.1;
        const playerWorldPos = this.playerTank.group._cachedWorldPos || this.playerTank.group.position;
        this.gameCamera.triggerShake(
          playerWorldPos,
          playerWorldPos,
          shakeIntensity,
          100,
        );
      }
    }

    // Notify camera of charge level for pullback
    if (this.gameCamera) {
      this.gameCamera.setChargePullback(
        this.charging.power / this.charging.maxPower,
      );
    }

    // Auto-fire at max charge
    if (this.charging.power >= this.charging.maxPower && tank && faction) {
      this.releaseCharge(tank, faction);
      // Notify multiplayer server (mouseup won't fire since isCharging() is now false)
      if (window._mp && window._mp.onFire) {
        window._mp.onFire(this.getLastChargePower(), tank.state?.turretAngle);
      }
    }
  }

  releaseCharge(tank, faction) {
    if (!this.charging.active) return;

    const power = this.charging.power;
    this.charging.active = false;
    this.charging.power = 0;

    // Reset camera pullback (no delay, smooth easing return)
    if (this.gameCamera) {
      this.gameCamera.setChargePullback(0);
    }

    // Fire with the accumulated charge
    this._fireWithCharge(tank, faction, power);
  }

  cancelCharge() {
    this.charging.active = false;
    this.charging.power = 0;

    // Reset camera pullback
    if (this.gameCamera) {
      this.gameCamera.setChargePullback(0);
    }
  }

  getChargeRatio() {
    return this.charging.power / this.charging.maxPower;
  }

  isCharging() {
    return this.charging.active;
  }

  isReady() {
    let cooldown = this.config.cooldown;
    if (this.weaponSlotSystem) {
      cooldown /= this.weaponSlotSystem.getModifiers().fireRateMultiplier;
    }
    return performance.now() / 1000 - this.lastFireTime >= cooldown;
  }

  getCurrentRange() {
    const chargeRatio = this.charging.active
      ? this.charging.power / this.charging.maxPower
      : 0;
    let range =
      this.config.maxDistance *
      (1 + chargeRatio * (this.config.chargeRangeMultiplier - 1));
    if (this.weaponSlotSystem) {
      range *= this.weaponSlotSystem.getModifiers().rangeMultiplier;
    }
    return range;
  }

  fire(tank, faction) {
    // Quick fire with no charge
    this._fireWithCharge(tank, faction, 0);
  }

  getLastChargePower() {
    return this._lastChargePower || 0;
  }

  _fireWithCharge(tank, faction, chargePower) {
    if (tank.isDead) return;

    // Economy: client-side pre-check for cannon fire cost
    const isPlayerShot_ = faction === this.playerTank?.faction;
    if (isPlayerShot_ && window.cryptoSystem) {
      const fireCost = 5 + Math.ceil(chargePower);
      // Use server balance from dashboard if available, otherwise totalCrypto
      const balance = (window.dashboard && window.dashboard._lastServerCrypto !== undefined)
        ? window.dashboard._lastServerCrypto
        : window.cryptoSystem.stats.totalCrypto;
      if (balance < fireCost) {
        // Show denial message locally
        if (window.dashboard) {
          window.dashboard.showToast?.(`Not enough crypto to fire (need ¢${fireCost})`);
        }
        if (window.tuskCommentary) {
          window.tuskCommentary.onBroke?.();
        }
        return;
      }
    }

    const now = performance.now() / 1000;
    let cooldown = this.config.cooldown;
    if (this.weaponSlotSystem) {
      cooldown /= this.weaponSlotSystem.getModifiers().fireRateMultiplier;
    }
    if (now - this.lastFireTime < cooldown) return;
    this.lastFireTime = now;
    this._lastChargePower = chargePower;

    // Track shot fired for title system (player shots only)
    const isPlayerShot = faction === this.playerTank?.faction;
    if (isPlayerShot && this.titleSystem) {
      this.titleSystem.trackShots(1, 0); // 1 fired, 0 hits (hits tracked on impact)
    }

    // Show red spend floater for cannon fire cost
    if (isPlayerShot && window.cryptoVisuals && this.playerTank?.group) {
      const fireCost = 5 + Math.ceil(chargePower);
      this.playerTank.group.getWorldPosition(_tankWorldPos);
      window.cryptoVisuals._spawnFloatingNumber(-fireCost, _tankWorldPos);
    }

    // Calculate charge ratio (0-1)
    const chargeRatio = chargePower / this.charging.maxPower;

    // Calculate charged stats using lerp
    const speed =
      this.config.projectileSpeed *
      (1 + chargeRatio * (this.config.chargeSpeedMultiplier - 1));
    let range =
      this.config.maxDistance *
      (1 + chargeRatio * (this.config.chargeRangeMultiplier - 1));
    const damage = 1 + chargeRatio * (this.config.chargeDamageMultiplier - 1);
    const sizeScale = 1 + chargeRatio * (this.config.chargeSizeMultiplier - 1);

    // Apply weapon slot range modifier to player shots
    if (isPlayerShot && this.weaponSlotSystem) {
      range *= this.weaponSlotSystem.getModifiers().rangeMultiplier;
    }

    // Get muzzle position (barrel tip is at z = -3.2 in turret local space)
    // turretGroup.position.y = 0.8, barrel at y = 0.4 within turret
    _muzzleLocal.set(0, 0.8 + 0.4, -3.2);

    // Apply turret rotation
    _muzzleLocal.applyAxisAngle(_yAxis, tank.state.turretAngle);

    // Transform to world space
    _muzzleWorld.copy(_muzzleLocal).applyMatrix4(tank.group.matrixWorld);

    // Lift muzzle position up along surface normal to prevent ground collision
    // This compensates for roll wiggle tilting the barrel downward
    _shotSurfaceNormal.copy(tank.group._cachedWorldPos || tank.group.position).normalize();
    _muzzleWorld.addScaledVector(_shotSurfaceNormal, 0.5);

    // Fire direction: straight out of the barrel
    // Barrel points -Z in local space, rotated by turret angle
    _shotDirection.set(0, 0, -1);
    _shotDirection.applyAxisAngle(_yAxis, tank.state.turretAngle);

    // Transform direction to world space (apply tank's rotation only, not position)
    _shotDirWorld.copy(_shotDirection).transformDirection(tank.group.matrixWorld);

    // Project onto tangent plane (parallel to ground surface)
    // This removes the vertical component caused by roll wiggle
    const dot = _shotDirWorld.dot(_shotSurfaceNormal);
    _shotDirWorld.addScaledVector(_shotSurfaceNormal, -dot).normalize();

    // Acquire projectile from pool (reuse geometry/meshes for performance)
    const poolItem = this.objectPools.acquireProjectile(faction, sizeScale);
    poolItem.mesh.position.copy(_muzzleWorld);

    // Orient along velocity
    _shotTarget.copy(_muzzleWorld).add(_shotDirWorld);
    poolItem.mesh.lookAt(_shotTarget);

    poolItem.mesh.layers.set(1); // BLOOM_LAYER only - per-object bloom control
    this.scene.add(poolItem.mesh); // Add to scene

    // Create and attach point light to projectile (faction-colored glow)
    const projectileLight = new THREE.PointLight(
      FACTION_COLORS[faction].hex,
      5, // intensity
      30, // distance (falloff range)
    );
    projectileLight.layers.set(0); // Default layer so it affects all objects
    poolItem.mesh.add(projectileLight); // Parent to projectile mesh

    // Spawn muzzle flare (bright faction-colored flash at barrel tip, directional)
    this._spawnMuzzleFlare(
      _muzzleWorld,
      _shotDirWorld,
      faction,
      sizeScale,
    );

    // Spawn muzzle smoke
    if (this.dustShockwave) {
      this.dustShockwave.emitMuzzleSmoke(
        _muzzleWorld,
        _shotDirWorld,
        sizeScale,
      );
    }

    // Spawn dust shockwave at tank's ground position (parented to tank)
    if (this.dustShockwave) {
      // 25% smaller for tank firing: (0.6 + chargeRatio * 0.4) * 0.75
      this.dustShockwave.emit(
        tank.group._cachedWorldPos || tank.group.position,
        (0.6 + chargeRatio * 0.4) * 0.75,
        tank.group,
      );
    }

    // Trigger screen shake for firing (scales with charge)
    if (this.gameCamera && this.playerTank) {
      const shakeIntensity = 0.4 + chargeRatio * 0.6; // 0.4 to 1.0
      this.gameCamera.triggerShake(
        _muzzleWorld,
        this.playerTank.group._cachedWorldPos || this.playerTank.group.position,
        shakeIntensity,
        100,
      );
    }

    // Trigger barrel recoil
    if (tank.triggerRecoil) {
      tank.triggerRecoil();
    }

    this.projectiles.push({
      poolItem: poolItem, // Pool reference instead of direct mesh
      mesh: poolItem.mesh, // Keep mesh reference for compatibility
      light: projectileLight, // Point light attached to projectile
      faction: faction,
      position: _muzzleWorld.clone(),
      velocity: _shotDirWorld.multiplyScalar(speed).clone(),
      startPosition: _muzzleWorld.clone(),
      maxDistance: range,
      damage: damage,
      sizeScale: sizeScale,
      age: 0,
    });
  }

  /**
   * Spawn a visual-only projectile for a remote player's fire event.
   * No client-side collision detection — server handles hits.
   *
   * @param {Object} data - { theta, phi, turretAngle, power }
   * @param {Object} remoteTank - RemoteTank instance with group/faction
   */
  spawnRemoteProjectile(data, remoteTank) {
    if (!remoteTank || !remoteTank.group || remoteTank.isDead) return;

    const faction = remoteTank.faction;
    const chargePower = data.power || 0;
    const chargeRatio = chargePower / 10;

    // Calculate charged stats (same formulas as _fireWithCharge)
    const speed =
      this.config.projectileSpeed *
      (1 + chargeRatio * (this.config.chargeSpeedMultiplier - 1));
    const range =
      this.config.maxDistance *
      (1 + chargeRatio * (this.config.chargeRangeMultiplier - 1));
    const sizeScale = 1 + chargeRatio * (this.config.chargeSizeMultiplier - 1);

    // Compute muzzle position using remote tank's world matrix
    // Barrel tip is at local (0, 1.2, -3.2) rotated by turret angle
    _muzzleLocal.set(0, 0.8 + 0.4, -3.2);
    _muzzleLocal.applyAxisAngle(_yAxis, data.turretAngle);
    _muzzleWorld.copy(_muzzleLocal).applyMatrix4(remoteTank.group.matrixWorld);

    // Lift muzzle up along surface normal to prevent ground collision
    _shotSurfaceNormal.copy(remoteTank.group._cachedWorldPos || remoteTank.group.position).normalize();
    _muzzleWorld.addScaledVector(_shotSurfaceNormal, 0.5);

    // Fire direction: -Z rotated by turret angle, transformed to world space
    _shotDirection.set(0, 0, -1);
    _shotDirection.applyAxisAngle(_yAxis, data.turretAngle);
    _shotDirWorld.copy(_shotDirection).transformDirection(remoteTank.group.matrixWorld);

    // Project onto tangent plane (remove vertical component from roll wiggle)
    const dot = _shotDirWorld.dot(_shotSurfaceNormal);
    _shotDirWorld.addScaledVector(_shotSurfaceNormal, -dot).normalize();

    // Acquire projectile from pool
    const poolItem = this.objectPools.acquireProjectile(faction, sizeScale);
    poolItem.mesh.position.copy(_muzzleWorld);

    // Orient along velocity
    _shotTarget.copy(_muzzleWorld).add(_shotDirWorld);
    poolItem.mesh.lookAt(_shotTarget);

    poolItem.mesh.layers.set(1); // BLOOM_LAYER
    this.scene.add(poolItem.mesh);

    // Create point light
    const projectileLight = new THREE.PointLight(
      FACTION_COLORS[faction].hex,
      5,
      30,
    );
    projectileLight.layers.set(0);
    poolItem.mesh.add(projectileLight);

    // Spawn muzzle flare
    this._spawnMuzzleFlare(_muzzleWorld, _shotDirWorld, faction, sizeScale);

    // Spawn muzzle smoke
    if (this.dustShockwave) {
      this.dustShockwave.emitMuzzleSmoke(
        _muzzleWorld,
        _shotDirWorld,
        sizeScale,
      );
    }

    // Spawn dust shockwave at tank position
    if (this.dustShockwave) {
      this.dustShockwave.emit(
        remoteTank.group._cachedWorldPos || remoteTank.group.position,
        (0.6 + chargeRatio * 0.4) * 0.75,
        remoteTank.group,
      );
    }

    // Calculate damage for remote projectiles (same formula as local)
    const damage = 1 + chargeRatio * (this.config.chargeDamageMultiplier - 1);

    this.projectiles.push({
      poolItem: poolItem,
      mesh: poolItem.mesh,
      light: projectileLight,
      faction: faction,
      position: _muzzleWorld.clone(),
      velocity: _shotDirWorld.multiplyScalar(speed).clone(),
      startPosition: _muzzleWorld.clone(),
      maxDistance: range,
      damage: damage,
      sizeScale: sizeScale,
      age: 0,
      isRemote: true,
      serverId: data.projectileId,
    });
  }

  /**
   * Redirect a projectile to simulate shield deflection.
   * Finds the projectile by serverId or nearest position, then updates
   * its velocity to match the server's reflected heading.
   *
   * @param {Object} data - { projectileId, theta, phi, newHeading, shieldOwnerId }
   * @param {number} sphereRadius - Planet sphere radius
   * @returns {boolean} true if a projectile was redirected
   */
  redirectProjectile(data, sphereRadius) {
    // Try to find by server ID first
    let proj = null;
    for (let i = 0; i < this.projectiles.length; i++) {
      if (this.projectiles[i].serverId === data.projectileId) {
        proj = this.projectiles[i];
        break;
      }
    }

    // Fallback: find nearest projectile to impact position
    if (!proj) {
      const r = sphereRadius;
      const sinPhi = Math.sin(data.phi);
      const impactX = r * sinPhi * Math.sin(data.theta);
      const impactY = r * Math.cos(data.phi);
      const impactZ = r * sinPhi * Math.cos(data.theta);

      let bestDist = 25; // Max search radius (world units)
      for (let i = 0; i < this.projectiles.length; i++) {
        const p = this.projectiles[i];
        const dx = p.position.x - impactX;
        const dy = p.position.y - impactY;
        const dz = p.position.z - impactZ;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          proj = p;
        }
      }
    }

    if (!proj) return false;

    // Convert server heading to world-space velocity direction
    // Server heading: 0 = +phi (south), PI/2 = +theta (east)
    // Tangent basis on sphere at (theta, phi):
    //   eTheta = (cos(theta), 0, -sin(theta))
    //   ePhi   = (cos(phi)*sin(theta), -sin(phi), cos(phi)*cos(theta))
    const ct = Math.cos(data.theta);
    const st = Math.sin(data.theta);
    const cp = Math.cos(data.phi);
    const sp = Math.sin(data.phi);
    const h = data.newHeading;
    const sinH = Math.sin(h);
    const cosH = Math.cos(h);

    // World velocity direction = sin(heading) * eTheta + cos(heading) * ePhi
    const vx = sinH * ct + cosH * cp * st;
    const vy = -cosH * sp;
    const vz = -sinH * st + cosH * cp * ct;

    // Keep original speed
    const speed = proj.velocity.length();
    proj.velocity.set(vx * speed, vy * speed, vz * speed);

    // Move projectile to impact position and reset distance tracking
    const impR = sphereRadius;
    const impSinPhi = Math.sin(data.phi);
    proj.position.set(
      impR * impSinPhi * Math.sin(data.theta),
      impR * Math.cos(data.phi),
      impR * impSinPhi * Math.cos(data.theta)
    );
    proj.mesh.position.copy(proj.position);
    proj.startPosition.copy(proj.position);
    proj.age = 0;

    // Re-orient mesh along new velocity
    _shotTarget.copy(proj.position).add(proj.velocity);
    proj.mesh.lookAt(_shotTarget);

    return true;
  }

  _spawnExplosion(position, faction, sizeScale = 1) {
    // Don't spawn if no planet reference
    if (!this.planet) {
      console.warn("[CANNON] Cannot spawn explosion - no planet reference");
      return;
    }

    // In orbital view, spawn simple LOD circle instead of full sprite-sheet explosion
    if (this.isOrbitalView) {
      this._spawnLODExplosion(position, faction, sizeScale);
      return;
    }

    // Guard against texture not loaded yet
    if (!this.explosionTexture) {
      console.warn(
        "[CANNON] Explosion texture not loaded yet - using fallback",
      );
      // Fallback to solid color if texture not ready
      const material = new THREE.SpriteMaterial({
        color: FACTION_COLORS[faction].hex,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.setScalar(12 * sizeScale);
      sprite.layers.set(0);
      const localPosition = position.clone();
      this.planet.hexGroup.worldToLocal(localPosition);
      sprite.position.copy(localPosition);
      const surfaceNormal = localPosition.clone().normalize();
      sprite.position.addScaledVector(surfaceNormal, 0.5);
      this.planet.hexGroup.add(sprite);

      this.explosions.push({
        sprite: sprite,
        material: material,
        age: 0,
        duration: 1.0,
      });
      return;
    }

    const cfg = this.explosionConfig;

    // Clone texture for independent UV control
    const texture = this.explosionTexture.clone();
    texture.repeat.set(1 / cfg.columns, 1 / cfg.rows);
    texture.offset.set(0, 1 - 1 / cfg.rows); // Start at first frame
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;

    // Apply faction color tinting
    const factionColor = this.factionColors[faction].clone();
    factionColor.lerp(new THREE.Color(1, 1, 1), 0.35); // Lighten 35% toward white
    factionColor.multiplyScalar(1.5); // Brighten for bloom

    // Create material with texture
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: factionColor, // Tinted with faction color
      transparent: true,
      opacity: 1,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      rotation: Math.random() * Math.PI * 2,
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(cfg.baseSize * sizeScale);
    sprite.layers.set(1); // BLOOM_LAYER - explosions should bloom
    sprite.renderOrder = 1000; // Render on top of blast decals

    // Position in local space
    const localPosition = position.clone();
    this.planet.hexGroup.worldToLocal(localPosition);
    sprite.position.copy(localPosition);

    // Offset above surface
    const surfaceNormal = localPosition.clone().normalize();
    sprite.position.addScaledVector(surfaceNormal, 0.5);

    // Add to scene
    this.planet.hexGroup.add(sprite);

    // Store for animation
    this.explosions.push({
      sprite: sprite,
      material: material,
      texture: texture,
      age: 0,
      duration: cfg.duration,
      currentFrame: 0,
    });
  }

  _spawnLODExplosion(position, faction, sizeScale = 1) {
    const cfg = this.lodExplosionConfig;

    // Clone material for independent opacity control
    const material = this.lodExplosionMaterials[faction].clone();

    const sprite = new THREE.Sprite(material);

    // Convert world position to planet's local space
    const localPosition = position.clone();
    this.planet.hexGroup.worldToLocal(localPosition);

    // Position in local space
    sprite.position.copy(localPosition);

    // Offset slightly above surface
    const surfaceNormal = localPosition.clone().normalize();
    sprite.position.addScaledVector(surfaceNormal, 0.5);

    sprite.scale.setScalar(cfg.baseSize * sizeScale * 1.5); // Start big — punch
    sprite.layers.set(1); // BLOOM_LAYER only

    // Parent to planet's hexGroup so it rotates with planet
    this.planet.hexGroup.add(sprite);

    this.lodExplosions.push({
      sprite,
      material,
      sizeScale,
      age: 0,
      duration: cfg.duration,
    });
  }

  _spawnMuzzleFlare(position, direction, faction, sizeScale = 1) {
    const cfg = this.muzzleFlareConfig;

    // Create flare sprite - elongated in firing direction
    const flare = new THREE.Sprite(this.muzzleFlareMaterials[faction].clone());
    flare.position.copy(position);
    // Elongate in firing direction (3:1 aspect ratio for directional look)
    flare.scale.set(cfg.size * sizeScale * 3, cfg.size * sizeScale, 1);
    flare.layers.set(1); // BLOOM_LAYER only - per-object bloom control

    // Calculate initial rotation to align with firing direction
    const rotation = this._calculateFlareRotation(position, direction);
    flare.material.rotation = rotation;

    this.scene.add(flare);

    // Store direction for orientation updates
    this.muzzleFlares.push({
      sprite: flare,
      direction: direction.clone(),
      position: position.clone(),
      age: 0,
      duration: cfg.duration,
    });
  }

  /**
   * Calculate sprite rotation to align with firing direction in screen space
   */
  _calculateFlareRotation(position, direction) {
    if (!this.gameCamera?.camera) return 0;

    const camera = this.gameCamera.camera;

    // Project flare position and a point along the direction to screen space
    const screenPos = position.clone().project(camera);
    const dirEndPoint = position.clone().add(direction);
    const screenDir = dirEndPoint.project(camera);

    // Calculate angle in screen space
    const dx = screenDir.x - screenPos.x;
    const dy = screenDir.y - screenPos.y;

    // atan2 gives angle from positive X axis, sprite rotation is counter-clockwise
    return Math.atan2(dy, dx);
  }

  _updateMuzzleEffects(deltaTime, frustum = null) {
    // Update muzzle flares
    for (let i = this.muzzleFlares.length - 1; i >= 0; i--) {
      const flare = this.muzzleFlares[i];
      flare.age += deltaTime;

      if (flare.age >= flare.duration) {
        this.scene.remove(flare.sprite);
        flare.sprite.material.dispose();
        this.muzzleFlares.splice(i, 1);
      } else {
        // Distance + backface + frustum culling for muzzle flare
        if (this.gameCamera?.camera) {
          const dist = flare.position.distanceTo(_cameraWorldPos);
          if (dist > PROJECTILE_CULL_DISTANCE) {
            flare.sprite.visible = false;
          } else {
            _cannonCullNormal.copy(flare.position).normalize();
            _cannonCullDir.copy(flare.position).sub(_cameraWorldPos).normalize();
            if (_cannonCullNormal.dot(_cannonCullDir) > 0.15) {
              flare.sprite.visible = false;
            } else if (frustum) {
              _cannonCullSphere.set(flare.position, 15);
              flare.sprite.visible = frustum.intersectsSphere(_cannonCullSphere);
            } else {
              flare.sprite.visible = true;
            }
          }
        }

        // Quick fade and expand
        const progress = flare.age / flare.duration;
        flare.sprite.material.opacity = 1 - progress;
        flare.sprite.scale.multiplyScalar(1 + deltaTime * 15);

        // Update rotation to stay aligned with firing direction as camera moves
        const rotation = this._calculateFlareRotation(
          flare.position,
          flare.direction,
        );
        flare.sprite.material.rotation = rotation;
      }
    }
  }

  _updateExplosions(deltaTime, frustum = null) {
    const cfg = this.explosionConfig;

    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const exp = this.explosions[i];
      exp.age += deltaTime;

      // Check if done
      if (exp.age >= exp.duration) {
        this.planet.hexGroup.remove(exp.sprite);
        exp.material.dispose();
        if (exp.texture) {
          exp.texture.dispose();
        }
        if (exp.light) {
          this.planet.hexGroup.remove(exp.light);
          exp.light.dispose();
        }
        this.explosions.splice(i, 1);
        continue;
      }

      // Backface + frustum culling for explosions
      exp.sprite.getWorldPosition(_spriteWorldPos);
      _cannonCullNormal.copy(_spriteWorldPos).normalize();
      _cannonCullDir.copy(_spriteWorldPos).sub(_cameraWorldPos).normalize();
      if (_cannonCullNormal.dot(_cannonCullDir) > 0.15) {
        exp.sprite.visible = false;
        if (exp.light) exp.light.visible = false;
        continue;
      }
      if (frustum) {
        _cannonCullSphere.set(_spriteWorldPos, cfg.baseSize);
        exp.sprite.visible = frustum.intersectsSphere(_cannonCullSphere);
        if (exp.light) exp.light.visible = exp.sprite.visible;
        if (!exp.sprite.visible) continue;
      }

      const progress = exp.age / exp.duration;

      // Distance fade (smooth fade to zero at PROJECTILE_CULL_DISTANCE)
      let distanceFade = 1;
      if (this.gameCamera?.camera) {
        if (!frustum) exp.sprite.getWorldPosition(_spriteWorldPos);
        const dist = _spriteWorldPos.distanceTo(_cameraWorldPos);
        distanceFade =
          1 -
          Math.max(
            0,
            Math.min(
              1,
              (dist - SPRITE_FADE_START) /
                (PROJECTILE_CULL_DISTANCE - SPRITE_FADE_START),
            ),
          );
      }

      // Animate sprite sheet if we have texture
      if (exp.texture && exp.currentFrame !== undefined) {
        const frame = Math.min(
          Math.floor(progress * cfg.totalFrames),
          cfg.totalFrames - 1,
        );

        // Only update UV if frame changed
        if (frame !== exp.currentFrame) {
          exp.currentFrame = frame;

          // Calculate UV offset for current frame
          const col = frame % cfg.columns;
          const row = Math.floor(frame / cfg.columns);

          exp.texture.offset.set(col / cfg.columns, 1 - (row + 1) / cfg.rows);
        }

        // Fade out in last 20% of animation, multiplied by distance fade
        if (progress > 0.8) {
          exp.material.opacity = (1 - (progress - 0.8) / 0.2) * distanceFade;
        } else {
          exp.material.opacity = distanceFade;
        }

        // Scale up during animation
        exp.sprite.scale.setScalar(cfg.baseSize * (1 + progress * 0.3));
      } else {
        // Simple fade for non-textured fallback
        exp.material.opacity = (1 - progress) * distanceFade;
        const baseScale = 12;
        exp.sprite.scale.setScalar(baseScale * (1 + progress * 0.5));
      }

      // Fade point light with the explosion
      if (exp.light) {
        exp.light.intensity = 3 * (1 - progress) * distanceFade;
      }
    }
  }

  _updateLODExplosions(deltaTime, frustum = null) {
    const cfg = this.lodExplosionConfig;

    for (let i = this.lodExplosions.length - 1; i >= 0; i--) {
      const exp = this.lodExplosions[i];
      exp.age += deltaTime;

      // Check if LOD explosion is done
      if (exp.age >= exp.duration) {
        if (this.planet) {
          this.planet.hexGroup.remove(exp.sprite);
        }
        exp.material.dispose();
        this.lodExplosions.splice(i, 1);
        continue;
      }

      // Backface + frustum culling for LOD explosions
      exp.sprite.getWorldPosition(_spriteWorldPos);
      _cannonCullNormal.copy(_spriteWorldPos).normalize();
      _cannonCullDir.copy(_spriteWorldPos).sub(_cameraWorldPos).normalize();
      if (_cannonCullNormal.dot(_cannonCullDir) > 0.15) {
        exp.sprite.visible = false;
        continue;
      }
      if (frustum) {
        _cannonCullSphere.set(_spriteWorldPos, cfg.baseSize * (exp.sizeScale || 1));
        exp.sprite.visible = frustum.intersectsSphere(_cannonCullSphere);
        if (!exp.sprite.visible) continue;
      }

      const t = 1 - exp.age / exp.duration; // 1 → 0
      exp.material.opacity = t;
      // Shrink from 1.5x → 1x over lifetime (collapse after blast)
      exp.sprite.scale.setScalar(cfg.baseSize * exp.sizeScale * (1 + 0.5 * t));
    }
  }

  update(deltaTime, frustum = null) {
    // Cache camera world position for distance fade (used by explosions, decals, etc.)
    if (this.gameCamera?.camera) {
      this.gameCamera.camera.getWorldPosition(_cameraWorldPos);
    }

    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      p.age += deltaTime;

      // Store previous position for swept collision (use preallocated vector)
      _prevPosition.copy(p.position);

      // Move projectile
      p.position.addScaledVector(p.velocity, deltaTime * 60);
      p.mesh.position.copy(p.position);

      // Distance + backface + frustum culling - hide projectiles far from camera, on far side, or outside view
      if (this.gameCamera?.camera) {
        const dist = p.position.distanceTo(_cameraWorldPos);
        if (dist > PROJECTILE_CULL_DISTANCE) {
          p.mesh.visible = false;
        } else {
          // Backface culling — hide projectiles on far side of planet
          _cannonCullNormal.copy(p.position).normalize();
          _cannonCullDir.copy(p.position).sub(_cameraWorldPos).normalize();
          if (_cannonCullNormal.dot(_cannonCullDir) > 0.15) {
            p.mesh.visible = false;
          } else if (frustum) {
            _cannonCullSphere.set(p.position, 15);
            p.mesh.visible = frustum.intersectsSphere(_cannonCullSphere);
          } else {
            p.mesh.visible = true;
          }
        }
      } else {
        p.mesh.visible = true;
      }

      let shouldExplode = false;
      let hitTank = false;

      // Swept collision check - test along the projectile's path (use preallocated vectors)
      _moveVector.copy(p.position).sub(_prevPosition);
      const moveDistance = _moveVector.length();

      // Check tank collision using swept sphere test
      const allHitboxes = this._getAllTankHitboxes();
      for (const hitbox of allHitboxes) {
        const tank = hitbox.userData?.tankRef;

        // Skip if tank reference is missing or invalid
        if (!tank || !tank.faction) continue;

        // Skip same faction (no friendly fire)
        if (tank.faction === p.faction) continue;

        // Skip dead tanks
        if (tank.isDead) continue;

        // Get tank world position (use preallocated vector)
        // Ensure world matrix is up to date before getting position
        hitbox.updateWorldMatrix(true, false);
        hitbox.getWorldPosition(_tankWorldPos);

        // Sanity check: tank should be at/near planet surface, not at origin
        // Skip if world position seems invalid (length should be near sphereRadius)
        const tankDistance = _tankWorldPos.length();
        if (
          tankDistance < this.sphereRadius * 0.9 ||
          tankDistance > this.sphereRadius * 1.5
        ) {
          continue;
        }

        // Quick distance check - find closest point on path to tank (use preallocated vectors)
        _pathDir.copy(_moveVector).normalize();
        _toTank.copy(_tankWorldPos).sub(_prevPosition);
        const projLength = _toTank.dot(_pathDir);
        // Clamp to path segment
        const clampedT = Math.max(0, Math.min(moveDistance, projLength));
        _closestPoint.copy(_prevPosition).addScaledVector(_pathDir, clampedT);
        const distToPath = _closestPoint.distanceTo(_tankWorldPos);
        if (distToPath > 10) continue; // Too far from path

        // Get tank's surface normal (direction from planet center to tank)
        _tankSurfaceNormal.copy(_tankWorldPos).normalize();

        // Tank footprint radius (based on tank dimensions: 3 width, 5.5 length)
        // Slightly larger than server's HALF_WID (2.5) for visual generosity
        const hitRadius = 3.0;

        // Height tolerance (allows hits above/below tank center)
        const heightTolerance = 3.0;

        // Swept collision: check multiple points along the path (every 0.5 units for better accuracy)
        const numSteps = Math.max(1, Math.ceil(moveDistance / 0.5));
        for (let step = 0; step <= numSteps; step++) {
          const t = step / numSteps;
          _testPos.copy(_prevPosition).lerp(p.position, t);

          // Calculate position relative to tank (use preallocated vector)
          _projectileToTank.copy(_testPos).sub(_tankWorldPos);

          // Decompose into height (along surface normal) and horizontal components
          const heightDiff = _projectileToTank.dot(_tankSurfaceNormal);
          _horizontalOffset
            .copy(_projectileToTank)
            .addScaledVector(_tankSurfaceNormal, -heightDiff);
          const horizontalDist = _horizontalOffset.length();

          if (
            horizontalDist < hitRadius &&
            Math.abs(heightDiff) < heightTolerance
          ) {
            // HIT! Snap projectile to impact point so explosion spawns on target
            p.position.copy(_testPos);
            p.mesh.position.copy(p.position);
            // In multiplayer: server is authoritative for all damage/crypto via
            // player-hit events. Client collision only triggers visual explosion.
            // In singleplayer: client handles damage directly.
            if (!p.isRemote && !window._mp?.isMultiplayer) {
              this._onTankHit(tank, p);
            }
            shouldExplode = true;
            hitTank = true;
            break;
          }
        }

        if (hitTank) break;
      }

      // Terrain elevation collision: projectiles hit cliff walls
      if (!hitTank && this.planet?.terrainElevation) {
        const terrainSteps = Math.max(1, Math.ceil(moveDistance / 0.5));
        for (let step = 0; step <= terrainSteps; step++) {
          const t = step / terrainSteps;
          _testPos.copy(_prevPosition).lerp(p.position, t);

          // Transform to planet local space for tile lookup
          _terrainLocalPos.copy(_testPos);
          this.planet.hexGroup.worldToLocal(_terrainLocalPos);

          const elevation =
            this.planet.terrainElevation.getElevationAtPosition(
              _terrainLocalPos,
            );

          if (elevation > 0) {
            // Check if projectile is below the elevated surface
            const elevatedRadius =
              this.sphereRadius +
              elevation * this.planet.terrainElevation.config.EXTRUSION_HEIGHT;
            const projectileRadius = _terrainLocalPos.length();

            if (projectileRadius < elevatedRadius + 0.5) {
              shouldExplode = true;
              // Snap projectile to impact point
              p.position.copy(_prevPosition).lerp(p.position, t);
              p.mesh.position.copy(p.position);
              break;
            }
          }
        }
      }

      // Check removal: max distance, lifetime, or hit surface
      const distance = p.position.distanceTo(p.startPosition);
      const hitSurface = p.position.length() < this.sphereRadius + 1;
      const maxDist = p.maxDistance || this.config.maxDistance;

      if (
        shouldExplode ||
        distance > maxDist ||
        p.age > this.config.maxLifetime ||
        hitSurface
      ) {
        // Spawn explosion at impact point
        this._spawnExplosion(p.position, p.faction, p.sizeScale || 1);

        // Spawn impact decal on surface
        this._spawnImpactDecal(p.position, p.sizeScale || 1);

        // Spawn dust shockwave at explosion point
        if (this.dustShockwave) {
          this.dustShockwave.emit(p.position, p.sizeScale || 1);
        }

        // Trigger impact shake (scales with projectile size)
        if (this.gameCamera && this.playerTank) {
          const shakeIntensity = hitSurface || hitTank ? 0.8 : 0.5;
          const playerWorldPos = this.playerTank.group._cachedWorldPos || this.playerTank.group.position;
          this.gameCamera.triggerShake(
            p.position,
            playerWorldPos,
            shakeIntensity * (p.sizeScale || 1),
            80,
          );
        }

        // Trigger nearby explosion visual effects (noise, glitch, etc.)
        if (this.visualEffects && this.playerTank) {
          const playerWorldPos = this.playerTank.group._cachedWorldPos || this.playerTank.group.position;
          const dist = p.position.distanceTo(playerWorldPos);
          if (dist < 80) {
            const intensity = (1 - dist / 80) * (p.sizeScale || 1);
            this.visualEffects.onNearbyExplosion(intensity);
          }
        }

        // Clean up point light before returning to pool
        if (p.light) {
          p.mesh.remove(p.light);
          p.light.dispose();
        }

        // Return projectile to pool (reuse for performance)
        this.objectPools.releaseProjectile(p.poolItem);
        this.projectiles.splice(i, 1);
      }
    }

    // Update explosions
    this._updateExplosions(deltaTime, frustum);
    this._updateLODExplosions(deltaTime, frustum);

    // Update muzzle effects (flare + smoke)
    this._updateMuzzleEffects(deltaTime, frustum);

    // Update impact decals
    this._updateImpactDecals(deltaTime);

    // Update oil puddles
    this._updateOilPuddles(deltaTime);
  }

  // ========================
  // PUBLIC API
  // ========================

  /**
   * Spawn an explosion effect at a given position
   * Public wrapper for external systems (like bodyguard death explosions)
   * @param {THREE.Vector3} position - World position for explosion
   * @param {string} faction - Faction for color tinting
   * @param {number} sizeScale - Size multiplier (default 1)
   */
  spawnExplosion(position, faction, sizeScale = 1) {
    this._spawnExplosion(position, faction, sizeScale);
  }
}
