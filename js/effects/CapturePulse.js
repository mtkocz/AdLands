/**
 * AdLands - Capture Pulse Wave Effect
 * Circular sonar-ping waves that pulse from the player tank during territory capture.
 * One wave per tic (~1/sec), expanding outward on the cluster surface geometry so
 * the ring is naturally clipped at the cluster boundary. Triggers a border glow
 * ripple when the wave reaches cluster extent.
 *
 * Uses shockwave.png sprite projected onto cluster geometry via tangent-frame UVs,
 * tinted with the faction color.
 */

// Preallocated temp vectors (avoid per-frame GC)
const _cpCullPos = new THREE.Vector3();
const _cpCullSphere = new THREE.Sphere();
const _cpCameraPos = new THREE.Vector3();
const _cpTankWorldPos = new THREE.Vector3();
const _cpTankLocalPos = new THREE.Vector3();
// Preallocated vectors for far-side (backface) culling
const _cpCullNormal = new THREE.Vector3();
const _cpCullDir = new THREE.Vector3();

// Distance fade thresholds
const _CP_FADE_START = 150;
const _CP_FADE_END = 350;

class CapturePulse {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.waves = [];
    this.planet = null;
    this.gameCamera = null;
    this.tank = null;

    this.config = {
      startRadius: 0.5, // Initial effect radius (world units)
      endRadius: 7, // Maximum expansion radius (world units)
      duration: 0.6, // Seconds for full expand + fade
      maxOpacity: 1.5, // Peak opacity (>1 for extra punch)
      fadeInEnd: 0.08, // Progress fraction where fade-in completes
      fadeOutStart: 0.3, // Progress fraction where fade-out begins
      borderPulseTrigger: 0.72, // Progress fraction to trigger border glow
      zOffset: 0.03, // Height above surface (above overlay's 0.01)
      maxConcurrent: 5, // Pool ceiling
    };

    // Cached cluster surface geometries (clusterId → BufferGeometry)
    this._clusterGeomCache = new Map();

    // Material pool for reuse
    this._materialPool = [];

    // Load shockwave texture
    this._texture = null;
    const loader = new THREE.TextureLoader();
    loader.load("assets/sprites/shockwave.png", (tex) => {
      this._texture = tex;
    });
  }

  // --- Dependency injection (setter pattern) ---

  setPlanet(planet) {
    this.planet = planet;
  }

  setCamera(gameCamera) {
    this.gameCamera = gameCamera;
  }

  setTank(tank) {
    this.tank = tank;
  }

  // --- Shader definitions ---

  _getVertexShader() {
    return `
      varying vec3 vLocalPos;
      void main() {
        vLocalPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
  }

  _getFragmentShader() {
    return `
      uniform sampler2D uTexture;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform vec3 uCenter;
      uniform float uRadius;

      varying vec3 vLocalPos;

      void main() {
        float d = distance(vLocalPos, uCenter);
        float normalizedR = d / uRadius;
        if (normalizedR > 1.0) discard;

        // Sample texture radially (texture is radially symmetric)
        // normalizedR=0 → texture center (0.5, 0.5), normalizedR=1 → edge
        vec2 uv = vec2(0.5 + normalizedR * 0.5, 0.5);
        float intensity = texture2D(uTexture, uv).r;
        if (intensity < 0.01) discard;

        // Strong saturated faction color
        vec3 boosted = uColor * 3.0 - vec3(0.4);
        gl_FragColor = vec4(boosted * intensity, intensity * uOpacity);
      }
    `;
  }

  // --- Cluster geometry caching ---

  _getClusterGeometry(clusterId) {
    if (this._clusterGeomCache.has(clusterId))
      return this._clusterGeomCache.get(clusterId);

    if (!this.planet) return null;
    const cluster = this.planet.clusterData[clusterId];
    if (!cluster) return null;

    const tileSet = new Set(cluster.tiles);
    const positions = [];
    const indices = [];
    let vertexOffset = 0;
    const offset = this.config.zOffset;

    this.planet.hexGroup.children.forEach((mesh) => {
      if (!mesh.userData || !tileSet.has(mesh.userData.tileIndex)) return;
      if (!mesh.geometry || !mesh.geometry.attributes.position) return;

      const pos = mesh.geometry.attributes.position.array;
      const idx = mesh.geometry.index ? mesh.geometry.index.array : null;

      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i],
          y = pos[i + 1],
          z = pos[i + 2];
        const len = Math.sqrt(x * x + y * y + z * z);
        positions.push(
          x + (x / len) * offset,
          y + (y / len) * offset,
          z + (z / len) * offset,
        );
      }

      if (idx) {
        for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertexOffset);
      } else {
        const vertCount = pos.length / 3;
        for (let i = 1; i < vertCount - 1; i++)
          indices.push(vertexOffset, vertexOffset + i, vertexOffset + i + 1);
      }

      vertexOffset += pos.length / 3;
    });

    if (positions.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);

    this._clusterGeomCache.set(clusterId, geometry);
    return geometry;
  }

  // --- Material pooling ---

  _acquireMaterial(factionColor, tankLocalPos) {
    let material;
    if (this._materialPool.length > 0) {
      material = this._materialPool.pop();
      material.uniforms.uColor.value.copy(factionColor);
      material.uniforms.uCenter.value.copy(tankLocalPos);
    } else {
      material = new THREE.ShaderMaterial({
        uniforms: {
          uTexture: { value: this._texture },
          uColor: { value: factionColor.clone() },
          uOpacity: { value: 0 },
          uCenter: { value: tankLocalPos.clone() },
          uRadius: { value: this.config.startRadius },
        },
        vertexShader: this._getVertexShader(),
        fragmentShader: this._getFragmentShader(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
    }
    material.uniforms.uTexture.value = this._texture;
    material.uniforms.uOpacity.value = 0;
    material.uniforms.uRadius.value = this.config.startRadius;
    return material;
  }

  _releaseMaterial(material) {
    this._materialPool.push(material);
  }

  // --- Distance fade ---

  _getDistanceFade() {
    if (!this.gameCamera?.camera || !this.tank) return 1;
    // Use tank world position (not mesh origin, which is planet center)
    this.tank.group.getWorldPosition(_cpCullPos);
    this.gameCamera.camera.getWorldPosition(_cpCameraPos);
    const dist = _cpCullPos.distanceTo(_cpCameraPos);
    return (
      1 -
      Math.max(
        0,
        Math.min(1, (dist - _CP_FADE_START) / (_CP_FADE_END - _CP_FADE_START)),
      )
    );
  }

  // --- Emit & Update ---

  /**
   * Emit a capture pulse wave on the cluster surface
   * @param {THREE.Vector3} position - World position of the tank
   * @param {string} faction - 'rust', 'cobalt', or 'viridian'
   * @param {number} clusterId - The cluster being captured
   */
  emit(position, faction, clusterId) {
    if (!this.planet || !this._texture) return;

    // Enforce pool ceiling: drop oldest wave if at max
    if (this.waves.length >= this.config.maxConcurrent) {
      const oldest = this.waves.shift();
      this.planet.hexGroup.remove(oldest.mesh);
      this._releaseMaterial(oldest.material);
    }

    const clusterGeometry = this._getClusterGeometry(clusterId);
    if (!clusterGeometry) return;

    const factionColor = FACTION_COLORS[faction]?.threeLight;
    if (!factionColor) return;

    // Transform tank world position to hexGroup local space for the shader
    _cpTankLocalPos.copy(position);
    this.planet.hexGroup.worldToLocal(_cpTankLocalPos);

    const material = this._acquireMaterial(factionColor, _cpTankLocalPos);
    const mesh = new THREE.Mesh(clusterGeometry, material);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;

    this.planet.hexGroup.add(mesh);

    this.waves.push({
      mesh,
      material,
      age: 0,
      duration: this.config.duration,
      clusterId,
      faction,
      hasTriggeredBorderPulse: false,
    });
  }

  /**
   * Update all active pulse waves
   * @param {number} deltaTime - Seconds since last frame
   * @param {THREE.Frustum} frustum - Camera frustum for culling
   */
  update(deltaTime, frustum, camera = null) {
    if (this.waves.length === 0) return;

    const cfg = this.config;

    // Cache camera world position for backface culling
    if (camera) camera.getWorldPosition(_cpCameraPos);

    // Get tank position in hexGroup local space once for all waves
    if (this.tank && this.planet) {
      this.tank.group.getWorldPosition(_cpTankWorldPos);
      _cpTankLocalPos.copy(_cpTankWorldPos);
      this.planet.hexGroup.worldToLocal(_cpTankLocalPos);
    }

    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wave = this.waves[i];
      wave.age += deltaTime;
      const progress = wave.age / wave.duration;

      // Expired: remove and recycle
      if (progress >= 1) {
        this.planet.hexGroup.remove(wave.mesh);
        this._releaseMaterial(wave.material);
        this.waves.splice(i, 1);
        continue;
      }

      // Update center to tank's current local position (waves follow the tank)
      if (this.tank) {
        wave.material.uniforms.uCenter.value.copy(_cpTankLocalPos);
      }

      // Backface + frustum culling for capture pulse waves
      wave.mesh.getWorldPosition(_cpCullPos);
      _cpCullNormal.copy(_cpCullPos).normalize();
      _cpCullDir.copy(_cpCullPos).sub(_cpCameraPos).normalize();
      if (_cpCullNormal.dot(_cpCullDir) > 0.15) {
        wave.mesh.visible = false;
        continue;
      }
      if (frustum) {
        _cpCullSphere.set(_cpCullPos, this.config.endRadius);
        wave.mesh.visible = frustum.intersectsSphere(_cpCullSphere);
        if (!wave.mesh.visible) continue;
      } else {
        wave.mesh.visible = true;
      }

      // Radius: ease-out expansion
      const easedProgress = 1 - Math.pow(1 - progress, 2);
      const radius =
        cfg.startRadius + (cfg.endRadius - cfg.startRadius) * easedProgress;
      wave.material.uniforms.uRadius.value = radius;

      // Opacity envelope
      let opacity;
      if (progress < cfg.fadeInEnd) {
        opacity = progress / cfg.fadeInEnd;
      } else if (progress < cfg.fadeOutStart) {
        opacity = 1;
      } else {
        opacity =
          1 - (progress - cfg.fadeOutStart) / (1 - cfg.fadeOutStart);
      }

      // Distance fade
      const distanceFade = this._getDistanceFade();
      wave.material.uniforms.uOpacity.value =
        opacity * cfg.maxOpacity * distanceFade;

      // Border pulse trigger
      if (
        progress >= cfg.borderPulseTrigger &&
        !wave.hasTriggeredBorderPulse
      ) {
        wave.hasTriggeredBorderPulse = true;
        if (this.planet?.triggerCapturePulse) {
          this.planet.triggerCapturePulse(wave.faction);
        }
      }
    }
  }

  /**
   * Clean up all resources
   */
  dispose() {
    for (const wave of this.waves) {
      if (this.planet) this.planet.hexGroup.remove(wave.mesh);
      wave.material.dispose();
    }
    this.waves.length = 0;

    for (const mat of this._materialPool) {
      mat.dispose();
    }
    this._materialPool.length = 0;

    for (const geom of this._clusterGeomCache.values()) {
      geom.dispose();
    }
    this._clusterGeomCache.clear();

    if (this._texture) {
      this._texture.dispose();
      this._texture = null;
    }
  }
}
