/**
 * AdLands - Dust Shockwave Effect
 * Sprite-based expanding ring using shockwave.png as alpha mask
 *
 * GROUND SMOKE MATERIAL: Both dustwave and muzzle smoke effects share the
 * "groundSmokeMaterial" config for consistent appearance. Adjust this config
 * to change color, opacity, blending, etc. for both effects at once.
 */

// Distance fade config for ground smoke sprites
const _SMOKE_FADE_START = 100;
const _SMOKE_FADE_END = 200;
const _smokeSpriteWorldPos = new THREE.Vector3();
const _smokeCameraWorldPos = new THREE.Vector3();

// Preallocated temp objects for frustum culling (avoid per-frame GC)
const _cullWorldPos = new THREE.Vector3();
const _cullSphere = new THREE.Sphere();
const _tempSunDir = new THREE.Vector3();
const _tempNormal = new THREE.Vector3();
const _tempTangentSun = new THREE.Vector3();
const _zUp = new THREE.Vector3(0, 0, 1);

class DustShockwave {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.shockwaves = [];

    // Configuration
    this.config = {
      // Size
      startSize: 8, // Initial size in units
      finalSize: 30, // Final size in units

      // Timing
      duration: 0.3, // Total duration in seconds (controls growth speed)
      fadeInRatio: 0.0, // Fraction of duration for fade in (0-1)
      fadeOutRatio: 1, // Fraction of duration for fade out (0-1)

      // Opacity
      opacity: 2, // Maximum opacity

      // Appearance
      color: 0xdddddd, // Gray color

      // Scaling
      impactMultiplier: 5.0, // Multiplier for impact/explosion shockwaves
    };

    // Shared geometry for all shockwaves
    this.geometry = new THREE.PlaneGeometry(1, 1);

    // Load shockwave texture
    this.shockwaveTexture = null;
    this._loadShockwaveSprite();

    // Sprite sheet animation config (dustwave.png)
    this.dustwaveConfig = {
      columns: 9,
      rows: 5,
      totalFrames: 43, // 45 cells total, last 2 are empty
      fps: 12, // 12 frames per second
      duration: 43 / 12, // Duration = totalFrames / fps = 3.58 seconds
      baseSize: 25, // 50% of previous size (50 * 0.5 = 25)
    };

    // Load dustwave sprite sheet
    this.dustwaveTexture = null;
    this._loadDustwaveSprite();

    // Load blurred shadow texture for fake shadows
    this.shadowTexture = null;
    this._loadShadowTexture();

    // Store active sprite animations
    this.dustwaveSprites = [];

    // Material pools for reuse (avoid repeated ShaderMaterial creation/disposal)
    this._dustwaveMaterialPool = [];
    this._muzzleSmokeMaterialPool = [];

    // Sun light reference (for shadow direction)
    this.sunLight = null;

    // Shadow configuration
    this.shadowConfig = {
      color: 0x000000, // Black
      opacity: 0.5, // 50% opacity
      sizeMultiplier: 1.15, // 15% larger than main dustwave
      offsetDistance: 2.0, // How far toward sun to offset (increased from 0.5)
      verticalOffset: 1.3, // Shadow slightly below main dustwave height (1.5 - 0.2 = 1.3)
    };

    // Lighting config (kept for API compatibility)
    this.lightingConfig = {
      sunDirection: new THREE.Vector3(1, 0, 0),
      sunColor: new THREE.Vector3(1.0, 0.85, 0.72),
      fillColor: new THREE.Vector3(0.42, 0.56, 0.6),
    };

    // ============================================
    // GROUND SMOKE MATERIAL CONFIG
    // ============================================
    // Shared material settings for dustwave and muzzle smoke effects
    // Reference this as "groundSmokeMaterial" when adjusting appearance
    this.groundSmokeMaterial = {
      color: 0xcccccc, // Light gray
      opacity: 1, // Full opacity (fades handled per-sprite)
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide, // Only render side facing camera
      blending: THREE.NormalBlending,
      alphaTest: 0.01, // Discard very transparent pixels to prevent background bleed
      premultipliedAlpha: false, // Prevent alpha blending artifacts
    };

    // Muzzle smoke sprite system
    this.muzzleSmokeTexture = null;
    this.muzzleSmokeShadowTexture = null;
    this.muzzleSmokeSprites = [];

    this.muzzleSmokeConfig = {
      columns: 8,
      rows: 6,
      totalFrames: 48,
      fps: 12,
      duration: 48 / 12, // 4 seconds
      baseSize: 18.75, // 50% bigger than 12.5
    };

    // Muzzle smoke shadow config (same as dustwave shadow)
    this.muzzleSmokeShadowConfig = {
      color: 0x000000,
      opacity: 0.5,
      sizeMultiplier: 1.15,
      offsetDistance: 2.0,
      verticalOffset: 1.3,
    };

    this._loadMuzzleSmokeSprite();
    this._loadMuzzleSmokeShadowTexture();
  }

  // ============================================
  // SHADER CODE FOR TERMINATOR-AWARE COLORING
  // ============================================

  /**
   * Vertex shader for simple effects (shockwave ring)
   * Passes world position for terminator calculation
   */
  _getVertexShader() {
    return `
            varying vec2 vUv;
            varying vec3 vWorldPosition;

            void main() {
                vUv = uv;
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPos.xyz;
                gl_Position = projectionMatrix * viewMatrix * worldPos;
            }
        `;
  }

  /**
   * Vertex shader for sprite sheet effects (dustwave, muzzle smoke)
   * Handles UV offset/repeat for sprite sheet animation
   */
  _getSpriteSheetVertexShader() {
    return `
            uniform vec2 uUvOffset;
            uniform vec2 uUvRepeat;

            varying vec2 vUv;
            varying vec3 vWorldPosition;

            void main() {
                // Apply sprite sheet UV transform
                vUv = uv * uUvRepeat + uUvOffset;
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPos.xyz;
                gl_Position = projectionMatrix * viewMatrix * worldPos;
            }
        `;
  }

  /**
   * Fragment shader with terminator-aware coloring
   * Blends between warm day colors and cool night colors based on sun direction
   */
  _getFragmentShader() {
    return `
            uniform vec3 uColor;
            uniform float uOpacity;
            uniform sampler2D uAlphaMap;
            uniform vec3 uSunDirection;
            uniform vec3 uSunColor;
            uniform vec3 uFillColor;

            varying vec2 vUv;
            varying vec3 vWorldPosition;

            void main() {
                // Sample alpha from sprite sheet
                float alpha = texture2D(uAlphaMap, vUv).r;
                if (alpha < 0.01) discard;

                // Terminator-aware coloring (same as TreadDust)
                vec3 surfaceNormal = normalize(vWorldPosition);
                float sunFacing = dot(surfaceNormal, uSunDirection);
                float dayFactor = smoothstep(-0.2, 0.3, sunFacing);

                // Base color
                vec3 baseColor = uColor * 0.7;

                // Day side: neutral/warm tint, Night side: blue fill light tint
                vec3 dayColor = baseColor * mix(vec3(1.17), uSunColor, 0.15);
                vec3 nightColor = baseColor * uFillColor * vec3(0.95, 1.0, 1.25);

                vec3 litColor = mix(nightColor, dayColor, dayFactor);

                gl_FragColor = vec4(litColor, alpha * uOpacity);
            }
        `;
  }

  /**
   * Load the shockwave sprite texture
   */
  _loadShockwaveSprite() {
    const loader = new THREE.TextureLoader();
    loader.load("assets/sprites/shockwave.png", (texture) => {
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      this.shockwaveTexture = texture;
    });
  }

  /**
   * Load the dustwave sprite sheet texture
   */
  _loadDustwaveSprite() {
    const loader = new THREE.TextureLoader();
    loader.load("assets/sprites/dustwave.png", (texture) => {
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.dustwaveTexture = texture;
    });
  }

  /**
   * Load the blurred shadow texture for fake shadows
   */
  _loadShadowTexture() {
    const loader = new THREE.TextureLoader();
    loader.load(
      "assets/sprites/dustwave_shadow.png",
      (texture) => {
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        this.shadowTexture = texture;
      },
      undefined,
      (error) => {
        console.error("[DustShockwave] Failed to load shadow texture:", error);
      },
    );
  }

  /**
   * Load the muzzle smoke sprite sheet texture
   */
  _loadMuzzleSmokeSprite() {
    const loader = new THREE.TextureLoader();
    loader.load(
      "assets/sprites/muzzlesmoke.png",
      (texture) => {
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        this.muzzleSmokeTexture = texture;
      },
      undefined,
      (error) => {
        console.error(
          "[DustShockwave] Failed to load muzzle smoke texture:",
          error,
        );
      },
    );
  }

  /**
   * Load the muzzle smoke shadow texture
   */
  _loadMuzzleSmokeShadowTexture() {
    const loader = new THREE.TextureLoader();
    loader.load(
      "assets/sprites/muzzlesmoke_shadow.png",
      (texture) => {
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        this.muzzleSmokeShadowTexture = texture;
      },
      undefined,
      (error) => {
        console.error(
          "[DustShockwave] Failed to load muzzle smoke shadow texture:",
          error,
        );
      },
    );
  }

  /**
   * Set sun light reference for shadow direction calculation
   * @param {THREE.DirectionalLight} sunLight - Sun light from environment
   */
  setSunLight(sunLight) {
    this.sunLight = sunLight;
  }

  setCamera(gameCamera) {
    this.gameCamera = gameCamera;
  }

  setPlanet(planet) {
    this.planet = planet;
  }

  /**
   * Create a shadow mesh with alpha-mapped texture for sprite sheet animation
   * Shared by dustwave and muzzle smoke shadow creation
   * @param {THREE.Texture} baseTexture - Source texture to clone
   * @param {Object} shadowCfg - Shadow config (color, opacity, sizeMultiplier, etc.)
   * @param {Object} spriteCfg - Sprite sheet config (columns, rows)
   * @param {number} scaleX - Shadow mesh X scale
   * @param {number} scaleY - Shadow mesh Y scale
   * @param {number} renderOrder - Render order for the shadow mesh
   * @returns {{ mesh: THREE.Mesh, texture: THREE.Texture }}
   */
  _createShadowMesh(baseTexture, shadowCfg, spriteCfg, scaleX, scaleY, renderOrder) {
    const texture = baseTexture.clone();
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(1 / spriteCfg.columns, 1 / spriteCfg.rows);
    texture.offset.set(0, 1 - 1 / spriteCfg.rows);
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      color: shadowCfg.color,
      alphaMap: texture,
      transparent: true,
      opacity: shadowCfg.opacity,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.scale.set(scaleX, scaleY, 1);
    mesh.renderOrder = renderOrder;

    return { mesh, texture };
  }

  /**
   * Calculate sun direction projected onto a surface tangent plane
   * Result is stored in _tempTangentSun (preallocated)
   * @param {THREE.Vector3} surfaceNormal - Surface normal (unit vector)
   */
  _calculateSunTangent(surfaceNormal) {
    _tempSunDir.set(1, 0.5, 0.5).normalize();
    if (this.sunLight && this.sunLight.position) {
      _tempSunDir.copy(this.sunLight.position).normalize();
    }
    _tempTangentSun.copy(_tempSunDir)
      .addScaledVector(surfaceNormal, -_tempSunDir.dot(surfaceNormal))
      .normalize();
  }

  /**
   * Calculate distance fade factor for a mesh
   * @returns {number} 0 (invisible) to 1 (fully visible)
   */
  _getDistanceFade(mesh) {
    if (!this.gameCamera?.camera) return 1;
    mesh.getWorldPosition(_smokeSpriteWorldPos);
    const dist = _smokeSpriteWorldPos.distanceTo(_smokeCameraWorldPos);
    return (
      1 -
      Math.max(
        0,
        Math.min(
          1,
          (dist - _SMOKE_FADE_START) / (_SMOKE_FADE_END - _SMOKE_FADE_START),
        ),
      )
    );
  }

  /**
   * Set lighting configuration for terminator-aware coloring
   * @param {Object} lightConfig - Light colors/directions from environment.getLightingConfig()
   */
  setLightingConfig(lightConfig) {
    const sunColor = lightConfig.sun.color;
    const fillColor = lightConfig.fill.color;

    // Store for new sprite creation
    this.lightingConfig.sunDirection.copy(lightConfig.sun.direction);
    this.lightingConfig.sunColor.set(sunColor.r, sunColor.g, sunColor.b);
    this.lightingConfig.fillColor.set(fillColor.r, fillColor.g, fillColor.b);

    // Update active shockwave materials
    for (const sw of this.shockwaves) {
      if (sw.material.uniforms) {
        sw.material.uniforms.uSunDirection.value.copy(
          this.lightingConfig.sunDirection,
        );
        sw.material.uniforms.uSunColor.value.copy(this.lightingConfig.sunColor);
        sw.material.uniforms.uFillColor.value.copy(
          this.lightingConfig.fillColor,
        );
      }
    }

    // Update active dustwave sprite materials
    for (const sprite of this.dustwaveSprites) {
      if (sprite.material.uniforms) {
        sprite.material.uniforms.uSunDirection.value.copy(
          this.lightingConfig.sunDirection,
        );
        sprite.material.uniforms.uSunColor.value.copy(
          this.lightingConfig.sunColor,
        );
        sprite.material.uniforms.uFillColor.value.copy(
          this.lightingConfig.fillColor,
        );
      }
    }

    // Update active muzzle smoke sprite materials
    for (const sprite of this.muzzleSmokeSprites) {
      if (sprite.material.uniforms) {
        sprite.material.uniforms.uSunDirection.value.copy(
          this.lightingConfig.sunDirection,
        );
        sprite.material.uniforms.uSunColor.value.copy(
          this.lightingConfig.sunColor,
        );
        sprite.material.uniforms.uFillColor.value.copy(
          this.lightingConfig.fillColor,
        );
      }
    }
  }

  /**
   * Emit a dust shockwave at the given position
   * @param {THREE.Vector3} position - World position of the shockwave center
   * @param {number} scale - Size multiplier (default 1)
   * @param {THREE.Object3D} parent - Optional parent to attach shockwave to (e.g., tank group)
   */
  emit(position, scale = 1, parent = null) {
    if (!this.shockwaveTexture) return;

    const cfg = this.config;

    // ShaderMaterial with terminator-aware coloring
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(cfg.color) },
        uOpacity: { value: 0 },
        uAlphaMap: { value: this.shockwaveTexture },
        uSunDirection: { value: this.lightingConfig.sunDirection.clone() },
        uSunColor: { value: this.lightingConfig.sunColor.clone() },
        uFillColor: { value: this.lightingConfig.fillColor.clone() },
      },
      vertexShader: this._getVertexShader(),
      fragmentShader: this._getFragmentShader(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Create mesh
    const mesh = new THREE.Mesh(this.geometry, material);

    // Surface normal (points away from planet center)
    const normal = position.clone().normalize();

    if (parent) {
      // Parent to tank - use lookAt for proper orientation in local space
      parent.add(mesh);
      mesh.position.set(0, 0, 0);
      // Offset slightly above surface
      mesh.position.addScaledVector(normal, 0.1);
      // Look away from planet center (makes plane lie flat on surface)
      mesh.lookAt(normal.multiplyScalar(2));
    } else {
      // World space - position at emission point
      mesh.position.copy(position);
      // Slight offset above surface to prevent z-fighting
      mesh.position.addScaledVector(normal, 0.1);
      // Orient flat on surface using quaternion
      mesh.quaternion.setFromUnitVectors(_zUp, normal);
      this.scene.add(mesh);
    }

    // Calculate sizes based on scale
    const startSize = cfg.startSize * scale;
    const finalSize = cfg.finalSize * scale;

    // Start at initial size
    mesh.scale.set(startSize, startSize, 1);

    this.shockwaves.push({
      mesh,
      material,
      parent,
      age: 0,
      duration: cfg.duration,
      startSize: startSize,
      finalSize: finalSize,
    });

    // Also spawn sprite sheet animation
    this._emitDustwaveSprite(position, scale, parent);
  }

  /**
   * Emit a dustwave sprite animation at the given position
   * @param {THREE.Vector3} position - World position of the effect
   * @param {number} scale - Size multiplier
   * @param {THREE.Object3D} parent - Optional parent to attach to
   */
  _emitDustwaveSprite(position, scale = 1, parent = null) {
    if (!this.dustwaveTexture) return;

    const cfg = this.dustwaveConfig;

    // Reuse pooled material or create new ShaderMaterial
    let material;
    if (this._dustwaveMaterialPool.length > 0) {
      material = this._dustwaveMaterialPool.pop();
      // Reset uniforms for new sprite
      material.uniforms.uOpacity.value = 1.0;
      material.uniforms.uUvOffset.value.set(0, 1 - 1 / cfg.rows);
      material.uniforms.uSunDirection.value.copy(this.lightingConfig.sunDirection);
      material.uniforms.uSunColor.value.copy(this.lightingConfig.sunColor);
      material.uniforms.uFillColor.value.copy(this.lightingConfig.fillColor);
    } else {
      material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xcccccc) },
          uOpacity: { value: 1.0 },
          uAlphaMap: { value: this.dustwaveTexture },
          uUvOffset: { value: new THREE.Vector2(0, 1 - 1 / cfg.rows) },
          uUvRepeat: { value: new THREE.Vector2(1 / cfg.columns, 1 / cfg.rows) },
          uSunDirection: { value: this.lightingConfig.sunDirection.clone() },
          uSunColor: { value: this.lightingConfig.sunColor.clone() },
          uFillColor: { value: this.lightingConfig.fillColor.clone() },
        },
        vertexShader: this._getSpriteSheetVertexShader(),
        fragmentShader: this._getFragmentShader(),
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
    }

    // Create mesh using shared geometry
    const mesh = new THREE.Mesh(this.geometry, material);
    // All dustwave sprites spawn at the same size (ignore scale parameter)
    const planeSize = cfg.baseSize;
    mesh.scale.set(planeSize, planeSize, 1);
    mesh.renderOrder = 10; // Start above overlays (1-2) to avoid faction color tinting

    // Surface normal (points away from planet center)
    const normal = position.clone().normalize();

    // Always add to world space (never parent to tanks)
    // This allows the sprite to follow planet rotation
    mesh.position.copy(position);
    mesh.position.addScaledVector(normal, 0.3); // Start low, will animate upward
    // Orient flat on surface using quaternion
    mesh.quaternion.setFromUnitVectors(_zUp, normal);
    // Apply random rotation around the surface normal (Z-axis after orientation)
    mesh.rotateZ(Math.random() * Math.PI * 2);
    this.scene.add(mesh);

    // CREATE SHADOW MESH (if shadow texture loaded)
    let shadowMesh = null;
    let shadowTexture = null;
    if (this.shadowTexture) {
      const shadowCfg = this.shadowConfig;
      const shadowScale = planeSize * shadowCfg.sizeMultiplier;
      const shadow = this._createShadowMesh(
        this.shadowTexture, shadowCfg, cfg, shadowScale, shadowScale, 9
      );
      shadowMesh = shadow.mesh;
      shadowTexture = shadow.texture;

      // Position shadow offset toward sun
      this._calculateSunTangent(normal);
      shadowMesh.position.copy(position);
      shadowMesh.position.addScaledVector(_tempTangentSun, shadowCfg.offsetDistance);
      shadowMesh.position.addScaledVector(normal, shadowCfg.verticalOffset);

      // Orient shadow mesh
      shadowMesh.quaternion.setFromUnitVectors(_zUp, normal);
      shadowMesh.rotateZ(Math.random() * Math.PI * 2);

      this.scene.add(shadowMesh);
    }

    // Compute cliff height cap for dustwave
    let maxHeight = Infinity;
    if (this.planet && this.planet.terrainElevation) {
      const localPos = position.clone();
      this.planet.hexGroup.worldToLocal(localPos);
      const capHeight = this.planet.terrainElevation.getCliffCapHeight(localPos);
      if (capHeight !== Infinity) {
        maxHeight = Math.max(0.2, capHeight - 3.0);
      }
    }

    // Store sprite animation data
    this.dustwaveSprites.push({
      sprite: mesh, // Actually a mesh, but keeping variable name for consistency
      shadowSprite: shadowMesh, // Shadow mesh (null if texture not loaded)
      shadowTexture: shadowTexture, // Shadow texture for animation (null if not loaded)
      material: material,
      parent: null, // Always null - never parented to tanks
      age: 0,
      duration: cfg.duration,
      currentFrame: 0,
      sizeScale: scale,
      baseSize: planeSize,
      basePosition: position.clone(), // Store base position for height animation
      surfaceNormal: normal.clone(), // Store surface normal for height animation
      maxHeight: maxHeight, // Cliff cap: max height above surface
    });
  }

  /**
   * Emit a muzzle smoke sprite animation at the given position
   * Uses MeshLambertMaterial with alphaMap (same approach as dustwave)
   * @param {THREE.Vector3} position - World position of the muzzle
   * @param {THREE.Vector3} direction - Firing direction (normalized)
   * @param {number} scale - Size multiplier
   */
  emitMuzzleSmoke(position, direction, scale = 1) {
    if (!this.muzzleSmokeTexture) return;

    const cfg = this.muzzleSmokeConfig;

    // Calculate aspect ratio from sprite sheet
    // The sprite sheet image is ~2:3 (width:height ratio)
    // With 8 columns and 6 rows, each frame is:
    // frameWidth = imageWidth/8, frameHeight = imageHeight/6
    // If image is 2:3, frame aspect = (2/8) / (3/6) = 0.25 / 0.5 = 0.5 (width:height)
    // So each frame is twice as tall as it is wide
    const frameAspect = 0.5; // width:height ratio (frames are taller than wide)
    const spriteHeight = cfg.baseSize * scale;
    const spriteWidth = spriteHeight * frameAspect;

    // Reuse pooled material or create new ShaderMaterial
    const matCfg = this.groundSmokeMaterial;
    let material;
    if (this._muzzleSmokeMaterialPool.length > 0) {
      material = this._muzzleSmokeMaterialPool.pop();
      // Reset uniforms for new sprite
      material.uniforms.uOpacity.value = matCfg.opacity;
      material.uniforms.uUvOffset.value.set(0, 1 - 1 / cfg.rows);
      material.uniforms.uSunDirection.value.copy(this.lightingConfig.sunDirection);
      material.uniforms.uSunColor.value.copy(this.lightingConfig.sunColor);
      material.uniforms.uFillColor.value.copy(this.lightingConfig.fillColor);
    } else {
      material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(matCfg.color) },
          uOpacity: { value: matCfg.opacity },
          uAlphaMap: { value: this.muzzleSmokeTexture },
          uUvOffset: { value: new THREE.Vector2(0, 1 - 1 / cfg.rows) },
          uUvRepeat: { value: new THREE.Vector2(1 / cfg.columns, 1 / cfg.rows) },
          uSunDirection: { value: this.lightingConfig.sunDirection.clone() },
          uSunColor: { value: this.lightingConfig.sunColor.clone() },
          uFillColor: { value: this.lightingConfig.fillColor.clone() },
        },
        vertexShader: this._getSpriteSheetVertexShader(),
        fragmentShader: this._getFragmentShader(),
        transparent: true,
        depthWrite: matCfg.depthWrite,
        depthTest: matCfg.depthTest,
        side: matCfg.side,
        blending: matCfg.blending,
      });
    }

    // Create mesh using shared geometry (1x1 plane)
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.scale.set(spriteWidth, spriteHeight, 1);

    // Position at muzzle
    mesh.position.copy(position);

    // Orient the mesh so it lies flat on the ground (like dustwave):
    // - Plane normal points away from planet (toward sky)
    // - "Top" of sprite (local +Y) points in firing direction
    const surfaceNormal = position.clone().normalize();

    // Project firing direction onto the tangent plane (perpendicular to surface normal)
    const tangentDir = direction.clone();
    tangentDir.addScaledVector(surfaceNormal, -tangentDir.dot(surfaceNormal));
    tangentDir.normalize();

    // Orient flat on surface (plane's Z-up becomes surface normal direction)
    mesh.quaternion.setFromUnitVectors(_zUp, surfaceNormal);

    // Now rotate around the surface normal so local +Y points in firing direction
    const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
    const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);

    // Find angle to rotate so local +Y aligns with tangentDir
    const angleY = localY.dot(tangentDir);
    const angleX = localX.dot(tangentDir);
    const rotationAngle = Math.atan2(angleX, angleY);
    mesh.rotateZ(-rotationAngle);

    // Offset position so bottom of sprite is at muzzle (move in firing direction by half height)
    mesh.position.addScaledVector(tangentDir, spriteHeight / 2);

    // Lift slightly above surface to prevent z-fighting
    mesh.position.addScaledVector(surfaceNormal, 0.3);

    mesh.renderOrder = 500;
    this.scene.add(mesh);

    // Create shadow mesh (same pattern as dustwave)
    let shadowMesh = null;
    let shadowTexture = null;
    if (this.muzzleSmokeShadowTexture) {
      const shadowCfg = this.muzzleSmokeShadowConfig;
      const shadowWidth = spriteWidth * shadowCfg.sizeMultiplier;
      const shadowHeight = spriteHeight * shadowCfg.sizeMultiplier;
      const shadow = this._createShadowMesh(
        this.muzzleSmokeShadowTexture, shadowCfg, cfg, shadowWidth, shadowHeight, 499
      );
      shadowMesh = shadow.mesh;
      shadowTexture = shadow.texture;

      // Position shadow offset toward sun, same flat orientation as main
      this._calculateSunTangent(surfaceNormal);
      shadowMesh.position.copy(position);
      shadowMesh.position.addScaledVector(_tempTangentSun, shadowCfg.offsetDistance);
      shadowMesh.position.addScaledVector(tangentDir, shadowHeight / 2);
      shadowMesh.position.addScaledVector(surfaceNormal, 0.2);
      shadowMesh.quaternion.copy(mesh.quaternion);

      this.scene.add(shadowMesh);
    }

    this.muzzleSmokeSprites.push({
      sprite: mesh, // Mesh with ShaderMaterial
      shadowSprite: shadowMesh,
      shadowTexture: shadowTexture,
      material: material,
      age: 0,
      currentFrame: 0,
    });
  }

  /**
   * Update all active shockwaves
   * @param {number} deltaTime - Time since last frame in seconds
   */
  update(deltaTime, frustum = null) {
    const cfg = this.config;

    // Cache camera world position for distance fade
    if (this.gameCamera?.camera) {
      this.gameCamera.camera.getWorldPosition(_smokeCameraWorldPos);
    }

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.age += deltaTime;
      const progress = sw.age / sw.duration;

      // Check if expired
      if (progress >= 1) {
        // Remove from parent (tank) or scene
        if (sw.parent) {
          sw.parent.remove(sw.mesh);
        } else {
          this.scene.remove(sw.mesh);
        }
        // Dispose shader material (uniforms cleaned up automatically)
        sw.material.dispose();
        this.shockwaves.splice(i, 1);
        continue;
      }

      // Frustum culling for shockwave (with 10 unit margin for smooth visibility)
      if (frustum) {
        sw.mesh.getWorldPosition(_cullWorldPos);
        const scale = sw.startSize + (sw.finalSize - sw.startSize) * progress;
        _cullSphere.set(_cullWorldPos, scale + 10);
        sw.mesh.visible = frustum.intersectsSphere(_cullSphere);
        if (!sw.mesh.visible) continue; // Skip expensive updates for invisible shockwaves
      } else {
        sw.mesh.visible = true;
      }

      // Scale: linear growth from startSize to finalSize
      const scale = sw.startSize + (sw.finalSize - sw.startSize) * progress;
      sw.mesh.scale.set(scale, scale, 1);

      // Opacity: fade in then out
      let opacity;
      if (progress < cfg.fadeInRatio) {
        // Fade in
        opacity = progress / cfg.fadeInRatio;
      } else {
        // Fade out over remaining duration
        const fadeOutStart = 1 - cfg.fadeOutRatio;
        if (progress > fadeOutStart) {
          opacity = 1 - (progress - fadeOutStart) / cfg.fadeOutRatio;
        } else {
          opacity = 1;
        }
      }

      // Distance fade
      const distanceFade = this._getDistanceFade(sw.mesh);
      sw.material.uniforms.uOpacity.value =
        opacity * cfg.opacity * distanceFade;
    }

    // Update dustwave sprite animations
    this._updateDustwaveSprites(deltaTime, frustum);

    // Update muzzle smoke sprite animations
    this._updateMuzzleSmokeSprites(deltaTime, frustum);
  }

  /**
   * Update all active dustwave sprite animations
   * @param {number} deltaTime - Time since last frame in seconds
   * @param {THREE.Frustum} frustum - Optional frustum for culling
   */
  _updateDustwaveSprites(deltaTime, frustum = null) {
    const cfg = this.dustwaveConfig;

    for (let i = this.dustwaveSprites.length - 1; i >= 0; i--) {
      const sprite = this.dustwaveSprites[i];
      sprite.age += deltaTime;
      const progress = sprite.age / sprite.duration;

      // Check if animation is complete
      if (progress >= 1) {
        if (sprite.parent) {
          sprite.parent.remove(sprite.sprite);
        } else {
          this.scene.remove(sprite.sprite);
        }
        // Return material to pool for reuse instead of disposing
        this._dustwaveMaterialPool.push(sprite.material);

        // Remove shadow sprite
        if (sprite.shadowSprite) {
          this.scene.remove(sprite.shadowSprite);
          if (sprite.shadowTexture) {
            sprite.shadowTexture.dispose();
          }
          sprite.shadowSprite.material.dispose();
        }

        this.dustwaveSprites.splice(i, 1);
        continue;
      }

      // Frustum culling
      if (frustum) {
        sprite.sprite.getWorldPosition(_cullWorldPos);
        _cullSphere.set(_cullWorldPos, sprite.baseSize + 5);
        const isVisible = frustum.intersectsSphere(_cullSphere);
        sprite.sprite.visible = isVisible;
        if (sprite.shadowSprite) sprite.shadowSprite.visible = isVisible;
        if (!isVisible) continue;
      } else {
        sprite.sprite.visible = true;
      }

      // Distance fade
      const distanceFade = this._getDistanceFade(sprite.sprite);
      if (sprite.material.uniforms) {
        sprite.material.uniforms.uOpacity.value = distanceFade;
      }

      // Calculate current frame based on age
      const frame = Math.min(
        Math.floor(progress * cfg.totalFrames),
        cfg.totalFrames - 1,
      );

      // Animate height: start low (0.3 units), rise to high (2.0 units)
      // Use ease-out easing - rises quickly at first, then slows down
      const startHeight = 0.3; // Below tank bodies (which are ~0.7 units)
      const endHeight = 1.0; // Above tank bodies but below cliff edges
      const heightProgress = 1 - Math.pow(1 - progress, 2); // Quadratic ease-out - fast start, slow end
      const currentHeight = Math.min(
        startHeight + (endHeight - startHeight) * heightProgress,
        sprite.maxHeight || Infinity,
      );

      // Update sprite position height
      sprite.sprite.position.copy(sprite.basePosition);
      sprite.sprite.position.addScaledVector(
        sprite.surfaceNormal,
        currentHeight,
      );

      // Animate renderOrder - start ABOVE overlays (renderOrder 1-2) to avoid faction color tinting
      const startRenderOrder = 10;
      const endRenderOrder = 500;
      sprite.sprite.renderOrder = Math.floor(
        startRenderOrder + (endRenderOrder - startRenderOrder) * heightProgress,
      );

      // Update shadow position and renderOrder to stay below main dustwave
      if (sprite.shadowSprite) {
        sprite.shadowSprite.position.copy(sprite.basePosition);
        sprite.shadowSprite.position.addScaledVector(
          sprite.surfaceNormal,
          Math.max(0.1, currentHeight - 0.2),
        );
        sprite.shadowSprite.renderOrder = sprite.sprite.renderOrder - 1;
      }

      // Update UV offset when frame changes
      if (frame !== sprite.currentFrame) {
        const col = frame % cfg.columns;
        const row = Math.floor(frame / cfg.columns);

        // Update main dustwave via shader uniform
        if (sprite.material.uniforms) {
          sprite.material.uniforms.uUvOffset.value.set(
            col / cfg.columns,
            1 - (row + 1) / cfg.rows, // Flip Y
          );
        }

        // Update shadow sprite texture (synchronized with main dustwave)
        // Shadow still uses MeshBasicMaterial with texture offset
        if (sprite.shadowSprite && sprite.shadowTexture) {
          sprite.shadowTexture.offset.set(
            col / cfg.columns,
            1 - (row + 1) / cfg.rows, // Flip Y
          );
          sprite.shadowTexture.needsUpdate = true;
        }

        // Update currentFrame after both updates
        sprite.currentFrame = frame;
      }

      // Update shadow opacity (independent of frame changes)
      if (sprite.shadowSprite && sprite.shadowTexture) {
        const shadowCfg = this.shadowConfig;
        const baseOpacity = shadowCfg.opacity; // 50% max opacity

        // Fade shadow opacity in last 30% of animation, multiplied by distance fade
        let currentOpacity;
        if (progress > 0.7) {
          currentOpacity = baseOpacity * (1 - (progress - 0.7) / 0.3);
        } else {
          currentOpacity = baseOpacity;
        }
        sprite.shadowSprite.material.opacity = currentOpacity * distanceFade;

        // Note: Shadow stays constant size (doesn't expand)
        // This creates a nice visual contrast with the expanding main dustwave
      }
    }
  }

  /**
   * Update all active muzzle smoke sprite animations
   * @param {number} deltaTime - Time since last frame in seconds
   */
  _updateMuzzleSmokeSprites(deltaTime, frustum = null) {
    const cfg = this.muzzleSmokeConfig;

    for (let i = this.muzzleSmokeSprites.length - 1; i >= 0; i--) {
      const sprite = this.muzzleSmokeSprites[i];
      sprite.age += deltaTime;
      const progress = sprite.age / cfg.duration;

      // Remove when animation complete
      if (progress >= 1) {
        this.scene.remove(sprite.sprite);
        // Return material to pool for reuse instead of disposing
        this._muzzleSmokeMaterialPool.push(sprite.material);

        if (sprite.shadowSprite) {
          this.scene.remove(sprite.shadowSprite);
          if (sprite.shadowTexture) {
            sprite.shadowTexture.dispose();
          }
          sprite.shadowSprite.material.dispose();
        }

        this.muzzleSmokeSprites.splice(i, 1);
        continue;
      }

      // Frustum culling for muzzle smoke
      if (frustum) {
        sprite.sprite.getWorldPosition(_cullWorldPos);
        _cullSphere.set(_cullWorldPos, sprite.baseSize + 5);
        const isVisible = frustum.intersectsSphere(_cullSphere);
        sprite.sprite.visible = isVisible;
        if (sprite.shadowSprite) sprite.shadowSprite.visible = isVisible;
        if (!isVisible) continue;
      }

      // Distance fade
      const distanceFade = this._getDistanceFade(sprite.sprite);
      if (sprite.material.uniforms) {
        sprite.material.uniforms.uOpacity.value = distanceFade;
      }

      // Calculate current frame
      const frame = Math.min(
        Math.floor(progress * cfg.totalFrames),
        cfg.totalFrames - 1,
      );

      // Update UV offset when frame changes via shader uniform
      if (frame !== sprite.currentFrame) {
        sprite.currentFrame = frame;
        const col = frame % cfg.columns;
        const row = Math.floor(frame / cfg.columns);

        // Update main muzzle smoke via shader uniform
        if (sprite.material.uniforms) {
          sprite.material.uniforms.uUvOffset.value.set(
            col / cfg.columns,
            1 - (row + 1) / cfg.rows,
          );
        }

        // Update shadow alphaMap texture too (shadow still uses MeshBasicMaterial)
        if (sprite.shadowSprite && sprite.shadowSprite.material.alphaMap) {
          sprite.shadowSprite.material.alphaMap.offset.set(
            col / cfg.columns,
            1 - (row + 1) / cfg.rows,
          );
        }
      }

      // Fade shadow in last 30% of animation, multiplied by distance fade
      if (sprite.shadowSprite) {
        const shadowCfg = this.muzzleSmokeShadowConfig;
        let shadowOpacity = shadowCfg.opacity;
        if (progress > 0.7) {
          shadowOpacity = shadowCfg.opacity * (1 - (progress - 0.7) / 0.3);
        }
        sprite.shadowSprite.material.opacity = shadowOpacity * distanceFade;
      }
    }
  }

  /**
   * Clean up all resources
   */
  dispose() {
    for (const sw of this.shockwaves) {
      if (sw.parent) {
        sw.parent.remove(sw.mesh);
      } else {
        this.scene.remove(sw.mesh);
      }
      // ShaderMaterial - just dispose
      sw.material.dispose();
    }
    this.shockwaves = [];

    // Dispose dustwave sprites
    for (const sprite of this.dustwaveSprites) {
      if (sprite.parent) {
        sprite.parent.remove(sprite.sprite);
      } else {
        this.scene.remove(sprite.sprite);
      }
      // ShaderMaterial - just dispose
      sprite.material.dispose();

      // Dispose shadow sprite (still MeshBasicMaterial)
      if (sprite.shadowSprite) {
        this.scene.remove(sprite.shadowSprite);
        if (sprite.shadowTexture) {
          sprite.shadowTexture.dispose();
        }
        sprite.shadowSprite.material.dispose();
      }
    }
    this.dustwaveSprites = [];
    if (this.dustwaveTexture) {
      this.dustwaveTexture.dispose();
    }

    // Dispose shadow texture
    if (this.shadowTexture) {
      this.shadowTexture.dispose();
    }

    // Dispose muzzle smoke sprites
    for (const sprite of this.muzzleSmokeSprites) {
      this.scene.remove(sprite.sprite);
      // ShaderMaterial - just dispose
      sprite.material.dispose();

      // Dispose shadow sprite (still MeshBasicMaterial)
      if (sprite.shadowSprite) {
        this.scene.remove(sprite.shadowSprite);
        if (sprite.shadowSprite.material.alphaMap) {
          sprite.shadowSprite.material.alphaMap.dispose();
        }
        sprite.shadowSprite.material.dispose();
      }
    }
    this.muzzleSmokeSprites = [];
    if (this.muzzleSmokeTexture) {
      this.muzzleSmokeTexture.dispose();
    }
    if (this.muzzleSmokeShadowTexture) {
      this.muzzleSmokeShadowTexture.dispose();
    }

    this.geometry.dispose();
    if (this.shockwaveTexture) {
      this.shockwaveTexture.dispose();
    }
  }
}
