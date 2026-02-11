/**
 * AdLands - Asteroid Belt (Space Debris Ring)
 * Cinematic ring of corporate space junk orbiting beyond the moons.
 * Uses InstancedMesh + Points for performant LOD rendering.
 * Physically realistic: prograde Keplerian orbits, equatorial alignment.
 */

// Preallocated temp objects (module-level, avoid GC)
const _beltTempPos = new THREE.Vector3();
const _beltTempDir = new THREE.Vector3();
const _beltTempCamDir = new THREE.Vector3();
const _beltTempMatrix = new THREE.Matrix4();
const _beltTempQuat = new THREE.Quaternion();
const _beltTempEuler = new THREE.Euler();
const _beltTempScale = new THREE.Vector3();
const _beltZeroScale = new THREE.Vector3(0, 0, 0);
const _beltBoundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 830);

class AsteroidBelt {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;

    // Belt configuration
    this.ITEM_COUNT = 1500;
    this.BELT_CENTER = 750;
    this.BELT_WIDTH = 80;
    this.NEAR_LOD_DIST = 400;
    this.FAR_LOD_DIST = 6000;
    this.ITEMS_PER_FRAME = 200;
    this.BACKFACE_DOT_THRESHOLD = -0.3;

    // Debris type distribution: [hullPlate, girder, panelShard, tubeSegment]
    this.TYPE_WEIGHTS = [0.35, 0.25, 0.25, 0.15];
    this.TYPE_COUNT = 4;

    // Instance color palette (metallic tints)
    this.COLORS = [
      [0.7, 0.7, 0.72],   // Silver steel
      [0.55, 0.55, 0.58],  // Dark steel
      [0.6, 0.5, 0.4],     // Rusty bronze
      [0.45, 0.5, 0.55],   // Blue-grey
      [0.5, 0.55, 0.65],   // Blue-tinted (emissive)
      [0.65, 0.6, 0.55],   // Warm grey
      [0.4, 0.45, 0.55],   // Dark blue (emissive)
    ];

    // Orbital data arrays (SOA layout)
    this._orbitRadius = new Float32Array(this.ITEM_COUNT);
    this._orbitAngle = new Float32Array(this.ITEM_COUNT);
    this._orbitSpeed = new Float32Array(this.ITEM_COUNT);
    this._orbitInclination = new Float32Array(this.ITEM_COUNT);
    this._orbitNode = new Float32Array(this.ITEM_COUNT);
    this._tumbleX = new Float32Array(this.ITEM_COUNT);
    this._tumbleY = new Float32Array(this.ITEM_COUNT);
    this._tumbleZ = new Float32Array(this.ITEM_COUNT);
    this._tumbleSpeedX = new Float32Array(this.ITEM_COUNT);
    this._tumbleSpeedY = new Float32Array(this.ITEM_COUNT);
    this._tumbleSpeedZ = new Float32Array(this.ITEM_COUNT);
    this._debrisType = new Uint8Array(this.ITEM_COUNT);
    this._scale = new Float32Array(this.ITEM_COUNT);
    this._lodLevel = new Int8Array(this.ITEM_COUNT); // 0=near, 1=far, 2=hidden
    // World positions (cached for LOD checks and points mesh)
    this._worldX = new Float32Array(this.ITEM_COUNT);
    this._worldY = new Float32Array(this.ITEM_COUNT);
    this._worldZ = new Float32Array(this.ITEM_COUNT);

    // Stagger tracking
    this._updateIndex = 0;

    // Near-tier instance tracking: which items are active in each near mesh
    // Maps debrisType -> array of item indices currently shown at near LOD
    this._nearActive = [];
    for (let t = 0; t < this.TYPE_COUNT; t++) {
      this._nearActive.push([]);
    }
    this._nearDirty = new Array(this.TYPE_COUNT).fill(false);
    this._farDirty = false;

    this._generateOrbitalData();
    this._createDebrisGeometries();
    this._createNearTierMeshes();
    this._createFarTierMesh();

    // Compute initial positions for all items
    this._computeAllPositions();
    // Initialize far-tier with all positions
    this._rebuildFarTier();
  }

  _generateOrbitalData() {
    const N = this.ITEM_COUNT;

    // Build cumulative type weights for selection
    const cumWeights = [];
    let cumSum = 0;
    for (let t = 0; t < this.TYPE_COUNT; t++) {
      cumSum += this.TYPE_WEIGHTS[t];
      cumWeights.push(cumSum);
    }

    for (let i = 0; i < N; i++) {
      // Gaussian-ish radius peaked at belt center
      const r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
      let radius = this.BELT_CENTER + (r1 + r2 + r3 - 1.5) * this.BELT_WIDTH * 0.667;
      radius = Math.max(this.BELT_CENTER - this.BELT_WIDTH, Math.min(this.BELT_CENTER + this.BELT_WIDTH, radius));
      this._orbitRadius[i] = radius;

      this._orbitAngle[i] = Math.random() * Math.PI * 2;

      // Keplerian speed — negative for prograde (matches planet rotation direction)
      this._orbitSpeed[i] = -0.0002 * Math.sqrt(this.sphereRadius / radius);

      // Very flat equatorial inclination: ±1.1°
      this._orbitInclination[i] = (Math.random() - 0.5) * 0.04;

      this._orbitNode[i] = Math.random() * Math.PI * 2;

      // Tumble (slow self-rotation)
      this._tumbleX[i] = Math.random() * Math.PI * 2;
      this._tumbleY[i] = Math.random() * Math.PI * 2;
      this._tumbleZ[i] = Math.random() * Math.PI * 2;
      this._tumbleSpeedX[i] = (Math.random() - 0.5) * 0.002;
      this._tumbleSpeedY[i] = (Math.random() - 0.5) * 0.002;
      this._tumbleSpeedZ[i] = (Math.random() - 0.5) * 0.002;

      // Debris type (weighted random)
      const roll = Math.random();
      let type = 0;
      for (let t = 0; t < this.TYPE_COUNT; t++) {
        if (roll < cumWeights[t]) { type = t; break; }
      }
      this._debrisType[i] = type;

      // Size variant (0.5x, 1x, or 1.8x)
      const sizeRoll = Math.random();
      this._scale[i] = sizeRoll < 0.3 ? 0.5 : sizeRoll < 0.75 ? 1.0 : 1.8;

      // Start hidden
      this._lodLevel[i] = 2;
    }
  }

  _createDebrisGeometries() {
    this._geometries = [];

    // Type 0: Hull Plate — bent flat panel
    const hull = new THREE.BoxGeometry(2, 0.15, 3);
    const hullPos = hull.attributes.position;
    // Bend two corners upward for a warped plate look
    for (let v = 0; v < hullPos.count; v++) {
      const x = hullPos.getX(v);
      const z = hullPos.getZ(v);
      if (x > 0.5 && z > 0.5) {
        hullPos.setY(v, hullPos.getY(v) + 0.4);
      }
      if (x < -0.5 && z < -0.5) {
        hullPos.setY(v, hullPos.getY(v) - 0.2);
      }
    }
    hullPos.needsUpdate = true;
    hull.computeVertexNormals();
    hull.computeBoundingSphere();
    this._geometries.push(hull);

    // Type 1: Girder — I-beam cross section
    const girderWeb = new THREE.BoxGeometry(0.15, 1.5, 3);
    const girderFlange1 = new THREE.BoxGeometry(1.0, 0.15, 3);
    const girderFlange2 = new THREE.BoxGeometry(1.0, 0.15, 3);
    // Merge into single geometry
    girderFlange1.translate(0, 0.75, 0);
    girderFlange2.translate(0, -0.75, 0);
    const girder = this._mergeGeometries([girderWeb, girderFlange1, girderFlange2]);
    girder.computeBoundingSphere();
    this._geometries.push(girder);

    // Type 2: Panel Shard — irregular tetrahedron
    const shard = new THREE.TetrahedronGeometry(1, 0);
    shard.scale(1.2, 0.4, 0.8);
    shard.computeVertexNormals();
    shard.computeBoundingSphere();
    this._geometries.push(shard);

    // Type 3: Tube Segment — broken pipe
    const tube = new THREE.CylinderGeometry(0.3, 0.3, 2.5, 6, 1, true);
    tube.computeVertexNormals();
    tube.computeBoundingSphere();
    this._geometries.push(tube);
  }

  /**
   * Merge multiple BufferGeometries into one (simple concatenation).
   * r128 doesn't have BufferGeometryUtils.mergeBufferGeometries globally,
   * so we do it manually.
   */
  _mergeGeometries(geometries) {
    const positions = [];
    const normals = [];
    const indices = [];
    let vertexOffset = 0;

    for (const geo of geometries) {
      const pos = geo.attributes.position;
      const norm = geo.attributes.normal;
      const idx = geo.index;

      for (let i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
      }

      if (idx) {
        for (let i = 0; i < idx.count; i++) {
          indices.push(idx.getX(i) + vertexOffset);
        }
      } else {
        for (let i = 0; i < pos.count; i++) {
          indices.push(i + vertexOffset);
        }
      }

      vertexOffset += pos.count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.setIndex(indices);
    merged.computeVertexNormals();
    return merged;
  }

  _createNearTierMeshes() {
    // Custom ShaderMaterial for metallic debris with icy shimmer
    const debrisMaterial = new THREE.ShaderMaterial({
      uniforms: {
        sunDirection: { value: new THREE.Vector3(1, 0, 0).normalize() },
        sunColor: { value: new THREE.Color(0xffdc9b) },
        sunIntensity: { value: 1.5 },
        ambientColor: { value: new THREE.Color(0x3366aa) },
        ambientIntensity: { value: 0.4 },
        planetRadius: { value: this.sphereRadius },
        uTime: { value: 0 },
        uOpacity: { value: 1.0 },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vWorldPosition;
        varying vec3 vInstanceColor;

        void main() {
          // Transform normal through instance + model matrices
          mat3 normalMat = mat3(modelMatrix) * mat3(instanceMatrix);
          vNormal = normalize(normalMat * normal);

          // World position
          vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;

          // Pass instance color
          vInstanceColor = instanceColor;

          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 sunDirection, sunColor, ambientColor;
        uniform float sunIntensity, ambientIntensity, planetRadius;
        uniform float uTime, uOpacity;

        varying vec3 vNormal, vWorldPosition, vInstanceColor;

        float calculateShadow(vec3 pos, vec3 lightDir) {
          float a = dot(lightDir, lightDir);
          float b = 2.0 * dot(pos, lightDir);
          float c = dot(pos, pos) - planetRadius * planetRadius;
          float d = b * b - 4.0 * a * c;
          if (d > 0.0) {
            float t1 = (-b - sqrt(d)) / (2.0 * a);
            float t2 = (-b + sqrt(d)) / (2.0 * a);
            if (t1 > 0.01 || t2 > 0.01) return 0.0;
          }
          return 1.0;
        }

        void main() {
          vec3 n = normalize(vNormal);
          vec3 viewDir = normalize(cameraPosition - vWorldPosition);

          // Ambient
          vec3 color = vInstanceColor * ambientColor * ambientIntensity;

          // Shadow from planet
          float shadow = calculateShadow(vWorldPosition, sunDirection);

          // Diffuse sun lighting
          float nDotL = max(dot(n, sunDirection), 0.0);
          color += vInstanceColor * sunColor * sunIntensity * nDotL * 0.5 * shadow;

          // Metallic specular (Blinn-Phong)
          vec3 halfDir = normalize(sunDirection + viewDir);
          float spec = pow(max(dot(n, halfDir), 0.0), 64.0);
          color += sunColor * spec * 0.8 * shadow;

          // Icy shimmer: time-modulated high-frequency specular, blue-white tint
          float shimmer = sin(uTime * 2.0 + vWorldPosition.x * 0.1 + vWorldPosition.z * 0.1) * 0.5 + 0.5;
          float shimmerSpec = pow(max(dot(n, halfDir), 0.0), 128.0) * shimmer;
          color += vec3(0.6, 0.8, 1.0) * shimmerSpec * 0.4 * shadow;

          // Blue emissive for pieces with high blue channel (unaffected by shadow)
          float emissiveStrength = smoothstep(0.55, 0.65, vInstanceColor.b) * 0.15;
          color += vec3(0.3, 0.5, 0.8) * emissiveStrength;

          gl_FragColor = vec4(color, uOpacity);
        }
      `,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
    });

    // Create one InstancedMesh per debris type
    // Max near instances per type: generous upper bound
    this._nearMeshes = [];
    this._nearMaterials = [];
    const maxPerType = Math.ceil(this.ITEM_COUNT * 0.5); // generous upper bound

    for (let t = 0; t < this.TYPE_COUNT; t++) {
      const mat = debrisMaterial.clone();
      const mesh = new THREE.InstancedMesh(this._geometries[t], mat, maxPerType);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      // Per-instance color attribute
      const colors = new Float32Array(maxPerType * 3);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

      mesh.count = 0; // start with none visible
      mesh.frustumCulled = false; // we handle culling manually
      mesh.matrixAutoUpdate = false;

      this.scene.add(mesh);
      this._nearMeshes.push(mesh);
      this._nearMaterials.push(mat);
    }
  }

  _createFarTierMesh() {
    const N = this.ITEM_COUNT;

    // Position buffer (updated each frame for visible items)
    const positions = new Float32Array(N * 3);
    // Per-point shimmer phase
    const shimmerPhases = new Float32Array(N);
    // Per-point color
    const colors = new Float32Array(N * 3);

    for (let i = 0; i < N; i++) {
      shimmerPhases[i] = Math.random() * Math.PI * 2;

      // Assign color from palette
      const c = this.COLORS[Math.floor(Math.random() * this.COLORS.length)];
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aShimmerPhase', new THREE.Float32BufferAttribute(shimmerPhases, 1));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 1.0 },
        uPointSize: { value: 3.0 },
        sunDirection: { value: new THREE.Vector3(1, 0, 0) },
        planetRadius: { value: this.sphereRadius },
      },
      vertexShader: `
        attribute float aShimmerPhase;
        varying float vBrightness;
        varying vec3 vColor;
        varying vec3 vWorldPosition;
        uniform float uTime;
        uniform float uPointSize;

        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;

          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPointSize * (300.0 / -mvPos.z);
          gl_PointSize = clamp(gl_PointSize, 1.0, 5.0);

          vBrightness = 0.5 + 0.5 * sin(uTime * 1.5 + aShimmerPhase);
          vColor = color;

          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        uniform vec3 sunDirection;
        uniform float planetRadius;
        varying float vBrightness;
        varying vec3 vColor;
        varying vec3 vWorldPosition;

        float calculateShadow(vec3 pos, vec3 lightDir) {
          float a = dot(lightDir, lightDir);
          float b = 2.0 * dot(pos, lightDir);
          float c = dot(pos, pos) - planetRadius * planetRadius;
          float d = b * b - 4.0 * a * c;
          if (d > 0.0) {
            float t1 = (-b - sqrt(d)) / (2.0 * a);
            float t2 = (-b + sqrt(d)) / (2.0 * a);
            if (t1 > 0.01 || t2 > 0.01) return 0.0;
          }
          return 1.0;
        }

        void main() {
          // Circular point
          vec2 center = gl_PointCoord - 0.5;
          if (dot(center, center) > 0.25) discard;

          float shadow = calculateShadow(vWorldPosition, sunDirection);

          vec3 col = mix(vColor * 0.8, vec3(0.7, 0.85, 1.0), vBrightness * 0.3);
          // In shadow: dim to ambient level
          col *= mix(0.15, 1.0, shadow);
          gl_FragColor = vec4(col, uOpacity * (0.6 + 0.4 * vBrightness));
        }
      `,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    });

    this._farMesh = new THREE.Points(geometry, material);
    this._farMesh.frustumCulled = false;
    this._farMesh.matrixAutoUpdate = false;
    this._farMaterial = material;
    this.scene.add(this._farMesh);
  }

  /**
   * Compute world position for a single item from its orbital elements.
   */
  _computePosition(i) {
    const angle = this._orbitAngle[i];
    const r = this._orbitRadius[i];
    const inc = this._orbitInclination[i];
    const node = this._orbitNode[i];

    const xOrbit = Math.cos(angle);
    const yOrbit = Math.sin(angle);

    this._worldX[i] = r * (Math.cos(node) * xOrbit - Math.sin(node) * Math.cos(inc) * yOrbit);
    this._worldY[i] = r * Math.sin(inc) * yOrbit;
    this._worldZ[i] = r * (Math.sin(node) * xOrbit + Math.cos(node) * Math.cos(inc) * yOrbit);
  }

  _computeAllPositions() {
    for (let i = 0; i < this.ITEM_COUNT; i++) {
      this._computePosition(i);
    }
  }

  /**
   * Rebuild the far-tier points mesh positions from cached world positions.
   */
  _rebuildFarTier() {
    const posAttr = this._farMesh.geometry.attributes.position;
    const arr = posAttr.array;
    for (let i = 0; i < this.ITEM_COUNT; i++) {
      arr[i * 3] = this._worldX[i];
      arr[i * 3 + 1] = this._worldY[i];
      arr[i * 3 + 2] = this._worldZ[i];
    }
    posAttr.needsUpdate = true;
  }

  /**
   * Write instance matrix for a near-tier item.
   */
  _writeNearMatrix(meshIndex, instanceIndex, itemIndex) {
    const s = this._scale[itemIndex];
    _beltTempEuler.set(this._tumbleX[itemIndex], this._tumbleY[itemIndex], this._tumbleZ[itemIndex]);
    _beltTempQuat.setFromEuler(_beltTempEuler);
    _beltTempScale.set(s, s, s);
    _beltTempPos.set(this._worldX[itemIndex], this._worldY[itemIndex], this._worldZ[itemIndex]);
    _beltTempMatrix.compose(_beltTempPos, _beltTempQuat, _beltTempScale);

    const mesh = this._nearMeshes[meshIndex];
    mesh.setMatrixAt(instanceIndex, _beltTempMatrix);

    // Set instance color
    const c = this.COLORS[itemIndex % this.COLORS.length];
    mesh.instanceColor.setXYZ(instanceIndex, c[0], c[1], c[2]);
  }

  /**
   * Main update — called from environment.update() each frame.
   */
  update(camera, zoomOpacity, cameraPos, frustum) {
    // Early exit: not visible at surface level
    if (zoomOpacity <= 0) {
      this._setAllVisible(false);
      return;
    }

    // Frustum pre-check: is the belt bounding sphere on screen?
    if (frustum && !frustum.intersectsSphere(_beltBoundingSphere)) {
      this._setAllVisible(false);
      return;
    }

    this._setAllVisible(true);

    // Update shader uniforms
    const time = performance.now() * 0.001;
    for (let t = 0; t < this.TYPE_COUNT; t++) {
      const u = this._nearMaterials[t].uniforms;
      u.uTime.value = time;
      u.uOpacity.value = zoomOpacity;
    }
    this._farMaterial.uniforms.uTime.value = time;
    this._farMaterial.uniforms.uOpacity.value = zoomOpacity;

    // Staggered update batch
    const start = this._updateIndex;
    const end = Math.min(start + this.ITEMS_PER_FRAME, this.ITEM_COUNT);
    const staggerCompensation = this.ITEM_COUNT / this.ITEMS_PER_FRAME;

    // Camera direction from center (for backface check)
    _beltTempCamDir.copy(cameraPos).normalize();

    for (let i = start; i < end; i++) {
      // Update orbital angle (compensate for staggered updates)
      this._orbitAngle[i] += this._orbitSpeed[i] * staggerCompensation;

      // Update tumble rotation
      this._tumbleX[i] += this._tumbleSpeedX[i] * staggerCompensation;
      this._tumbleY[i] += this._tumbleSpeedY[i] * staggerCompensation;
      this._tumbleZ[i] += this._tumbleSpeedZ[i] * staggerCompensation;

      // Compute new world position
      this._computePosition(i);

      // Update far-tier point position
      const posArr = this._farMesh.geometry.attributes.position.array;
      posArr[i * 3] = this._worldX[i];
      posArr[i * 3 + 1] = this._worldY[i];
      posArr[i * 3 + 2] = this._worldZ[i];

      // Determine LOD level
      _beltTempPos.set(this._worldX[i], this._worldY[i], this._worldZ[i]);
      const distToCamera = _beltTempPos.distanceTo(cameraPos);

      // Backface check: behind planet?
      _beltTempDir.copy(_beltTempPos).normalize();
      const dot = _beltTempDir.dot(_beltTempCamDir);
      const isBehindPlanet = dot < this.BACKFACE_DOT_THRESHOLD;

      let newLod;
      if (isBehindPlanet || distToCamera > this.FAR_LOD_DIST) {
        newLod = 2; // hidden
      } else if (distToCamera < this.NEAR_LOD_DIST) {
        newLod = 0; // near
      } else {
        newLod = 1; // far (points only)
      }

      const oldLod = this._lodLevel[i];
      if (newLod !== oldLod) {
        // Remove from old near-tier if was near
        if (oldLod === 0) {
          const type = this._debrisType[i];
          const activeList = this._nearActive[type];
          const idx = activeList.indexOf(i);
          if (idx !== -1) {
            activeList.splice(idx, 1);
            this._nearDirty[type] = true;
          }
        }
        // Add to new near-tier if now near
        if (newLod === 0) {
          const type = this._debrisType[i];
          this._nearActive[type].push(i);
          this._nearDirty[type] = true;
        }
        this._lodLevel[i] = newLod;
      } else if (newLod === 0) {
        // Position/rotation changed, mark dirty for matrix update
        this._nearDirty[this._debrisType[i]] = true;
      }
    }

    // Mark far positions dirty
    this._farMesh.geometry.attributes.position.needsUpdate = true;

    // Advance stagger index
    this._updateIndex = end >= this.ITEM_COUNT ? 0 : end;

    // Rebuild dirty near-tier meshes (pack active instances)
    for (let t = 0; t < this.TYPE_COUNT; t++) {
      if (!this._nearDirty[t]) continue;
      this._nearDirty[t] = false;

      const mesh = this._nearMeshes[t];
      const activeList = this._nearActive[t];
      mesh.count = activeList.length;

      for (let j = 0; j < activeList.length; j++) {
        this._writeNearMatrix(t, j, activeList[j]);
      }

      if (activeList.length > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  _setAllVisible(visible) {
    for (let t = 0; t < this.TYPE_COUNT; t++) {
      this._nearMeshes[t].visible = visible;
    }
    this._farMesh.visible = visible;
  }

  dispose() {
    for (let t = 0; t < this.TYPE_COUNT; t++) {
      this.scene.remove(this._nearMeshes[t]);
      this._nearMeshes[t].dispose();
      this._nearMaterials[t].dispose();
      this._geometries[t].dispose();
    }
    this.scene.remove(this._farMesh);
    this._farMesh.geometry.dispose();
    this._farMaterial.dispose();
  }
}
