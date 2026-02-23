/**
 * AdLands - Environment Module
 * Lighting, atmosphere, stars, moons, satellites, and background Earth
 */

/**
 * Global sponsor image cache shared between Planet and Environment.
 * Keyed by URL — stores { img: HTMLImageElement, filtered: HTMLCanvasElement }.
 * Prevents duplicate downloads and duplicate pixel art filter runs when the
 * same sponsor advertises on hex clusters, moons, and billboards.
 */
window._sponsorImageCache = window._sponsorImageCache || new Map();

/**
 * Apply pixel art filter to an image: downscale to 128px, 8-color palette,
 * Bayer dithering, then upscale to 4x with nearest-neighbor.
 * Returns a canvas element ready for THREE.Texture.
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @returns {HTMLCanvasElement}
 */
function _envPixelArtFilter(image) {
  const targetShortSide = 128;
  const maxColors = 8;
  const ditherIntensity = 32;
  const srcW = image.width || 256;
  const srcH = image.height || 256;
  const aspect = srcW / srcH;

  let tw, th;
  if (srcW <= srcH) { tw = targetShortSide; th = Math.round(targetShortSide / aspect); }
  else { th = targetShortSide; tw = Math.round(targetShortSide * aspect); }

  // Step 1: Downscale
  const dc = document.createElement("canvas");
  dc.width = tw; dc.height = th;
  const dx = dc.getContext("2d");
  dx.imageSmoothingEnabled = false;
  dx.drawImage(image, 0, 0, tw, th);
  const id = dx.getImageData(0, 0, tw, th);
  const d = id.data;

  // Step 2: Extract palette
  const buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    const qr = Math.floor(d[i] / 32) * 32;
    const qg = Math.floor(d[i+1] / 32) * 32;
    const qb = Math.floor(d[i+2] / 32) * 32;
    const key = `${qr},${qg},${qb}`;
    const b = buckets.get(key) || { count: 0, sumR: 0, sumG: 0, sumB: 0 };
    b.count++; b.sumR += d[i]; b.sumG += d[i+1]; b.sumB += d[i+2];
    buckets.set(key, b);
  }
  const palette = Array.from(buckets.values())
    .sort((a, b) => b.count - a.count).slice(0, maxColors)
    .map(b => [Math.round(b.sumR / b.count), Math.round(b.sumG / b.count), Math.round(b.sumB / b.count)]);
  if (palette.length === 0) palette.push([128, 128, 128]);

  // Step 3: Dithering
  const bayer = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const i = (y * tw + x) * 4;
      const t = (bayer[y % 4][x % 4] / 16 - 0.5) * ditherIntensity;
      const r = Math.max(0, Math.min(255, d[i] + t));
      const g = Math.max(0, Math.min(255, d[i+1] + t));
      const b2 = Math.max(0, Math.min(255, d[i+2] + t));
      let minD = Infinity, closest = palette[0];
      for (const c of palette) {
        const dr = r-c[0], dg = g-c[1], db = b2-c[2];
        const dist = dr*dr*0.299 + dg*dg*0.587 + db*db*0.114;
        if (dist < minD) { minD = dist; closest = c; }
      }
      d[i] = closest[0]; d[i+1] = closest[1]; d[i+2] = closest[2];
    }
  }
  dx.putImageData(id, 0, 0);

  // Step 4: Upscale to 4x
  const us = Math.ceil(512 / Math.min(tw, th));
  const fc = document.createElement("canvas");
  fc.width = tw * us; fc.height = th * us;
  const fx = fc.getContext("2d");
  fx.imageSmoothingEnabled = false;
  fx.drawImage(dc, 0, 0, fc.width, fc.height);
  return fc;
}

// Constant direction vectors for shadow camera (preallocated)
const _envSunDir = new THREE.Vector3(1, 0, 0);
const _envFillDir = new THREE.Vector3(-1, 0, 0);

// Preallocated temps for billboard orientation (avoid per-frame allocation)
const _bbForward = new THREE.Vector3();
const _bbRight = new THREE.Vector3();
const _bbUp = new THREE.Vector3();
const _bbWorldUp = new THREE.Vector3(0, 1, 0);
const _bbMatrix = new THREE.Matrix4();
const _bbWobbleQuat = new THREE.Quaternion();
const _bbWobbleEuler = new THREE.Euler();

class Environment {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;

    this.moons = [];
    this.satellites = [];
    this.spaceStations = [];
    this.billboards = [];
    this.earth = null;
    this.clouds = null;
    this.atmosphereMaterial = null;

    // In multiplayer mode, server syncs celestial positions — skip local advancement
    this.isMultiplayer = false;

    // Space object visibility settings (inverse of surface objects)
    // These fade IN when zooming out, fade OUT when close to surface
    this.spaceObjectVisibility = {
      // Camera height above surface thresholds
      fadeInStart: 200, // Start fading in at 200 units above surface
      fadeInEnd: 260, // Fully visible at 260 units above surface
      cutoffDistance: 200, // Completely hidden below 200 units

      // Per-object distance culling (camera to object)
      maxRenderDistance: 8000, // Don't render objects beyond this
      fadeStartDistance: 6000, // Start distance fade at this range
    };

    // Temp vectors for culling calculations
    this._cullTemp = {
      objPos: new THREE.Vector3(),
      cameraPos: new THREE.Vector3(),
      // Billboard atmosphere temps (avoid per-frame allocations)
      billboardCameraLocal: new THREE.Vector3(),
      billboardDir: new THREE.Vector3(),
      billboardUp: new THREE.Vector3(0, 1, 0),
      billboardQuat: new THREE.Quaternion(),
      earthMatrixInverse: new THREE.Matrix4(),
      // Space object visibility temps
      objFromCenter: new THREE.Vector3(),
      cameraFromCenter: new THREE.Vector3(),
    };

    this._createLighting();
    this._createAtmosphere();
    this._createPlanetCore();
    this._createSkybox();
    this._createMoons();
    this._createSatellites();
    this._createSpaceStations();
    this._createBillboards();
    this._createBackgroundEarth();
    this._createAsteroidBelt();
  }

  _createAsteroidBelt() {
    this.asteroidBelt = new AsteroidBelt(this.scene, this.sphereRadius);
  }

  _createLighting() {
    // Ambient light - blue tint for shadows
    this.scene.add(new THREE.AmbientLight(0x3366aa, 0.4));

    // Sun light - primary shadow caster with optimized frustum
    const sunLight = new THREE.DirectionalLight(0xffd9b7, 1.5);
    sunLight.position.set(960, 0, 0);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 4096;
    sunLight.shadow.mapSize.height = 4096;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 2000;
    sunLight.shadow.camera.left = -200; // Reduced frustum for better texel density
    sunLight.shadow.camera.right = 200;
    sunLight.shadow.camera.top = 200;
    sunLight.shadow.camera.bottom = -200;
    sunLight.shadow.bias = -0.0001;
    sunLight.shadow.normalBias = 0.03; // Low value for good shadow contact
    this.sunLight = sunLight;
    this.scene.add(sunLight);
    this.scene.add(sunLight.target);

    // Visible sun - HSL color control with HDR brightness for bloom
    const sunColor = new THREE.Color();
    const hue = 0.04; // 0=red, 0.08=orange, 0.17=yellow
    const saturation = 1;
    const lightness = 0.65;
    const hdrMultiplier = 2; // Brightness boost for bloom (>1 = HDR)

    sunColor.setHSL(hue, saturation, lightness);
    sunColor.multiplyScalar(hdrMultiplier);

    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(288, 32, 32),
      new THREE.MeshBasicMaterial({ color: sunColor }),
    );
    sun.position.set(7680, 0, 0);
    sun.layers.set(1); // BLOOM_LAYER only - per-object bloom control
    sun.matrixAutoUpdate = false;
    sun.updateMatrix();
    this.sun = sun;
    this.scene.add(sun);

    // Fill light - opposite sun, casts softer shadows onto terrain
    const fillLight = new THREE.DirectionalLight(0x6b8e99, 0.75);
    fillLight.position.set(-960, 0, 0);
    fillLight.castShadow = true;
    fillLight.shadow.mapSize.width = 2048;
    fillLight.shadow.mapSize.height = 2048;
    fillLight.shadow.camera.near = 0.5;
    fillLight.shadow.camera.far = 2000;
    fillLight.shadow.camera.left = -200;
    fillLight.shadow.camera.right = 200;
    fillLight.shadow.camera.top = 200;
    fillLight.shadow.camera.bottom = -200;
    fillLight.shadow.bias = -0.0002;
    fillLight.shadow.normalBias = 0.05;
    this.fillLight = fillLight;
    this.scene.add(fillLight);
    this.scene.add(fillLight.target);
  }

  /**
   * Get lighting configuration for particle systems
   * @returns {Object} Light colors, directions, and intensities
   */
  getLightingConfig() {
    return {
      sun: {
        color: new THREE.Color(0xffd9b7),
        direction: new THREE.Vector3(1, 0, 0),
        intensity: 1.5,
      },
      fill: {
        color: new THREE.Color(0x6b8e99),
        direction: new THREE.Vector3(-1, 0, 0),
        intensity: 0.75,
      },
      ambient: {
        color: new THREE.Color(0x3366aa),
        intensity: 0.4,
      },
    };
  }

  /**
   * Scale shadow frustum continuously with camera distance so terrain
   * shadows remain visible at all zoom levels.
   * @param {number} cameraDistance - Camera distance from planet center
   */
  setShadowMode(cameraDistance) {
    if (!this.sunLight) return;

    // Scale frustum to cover visible terrain at current distance
    // Surface (~520): tight frustum for sharp shadows
    // Orbital (~960+): wide frustum to cover full visible horizon
    const surfaceDist = this.sphereRadius + 40;
    const orbitalDist = 960;
    const t = Math.max(0, Math.min(1, (cameraDistance - surfaceDist) / (orbitalDist - surfaceDist)));
    const frustumSize = 200 + t * 500; // 200 at surface, 700 at orbital

    // Skip update if frustum hasn't changed meaningfully
    if (this._currentFrustumSize !== undefined && Math.abs(this._currentFrustumSize - frustumSize) < 5) return;
    this._currentFrustumSize = frustumSize;

    // Scale normalBias with frustum to maintain consistent texel-space offset
    const biasScale = frustumSize / 200;
    this.sunLight.shadow.normalBias = 0.03 * biasScale;
    if (this.fillLight) this.fillLight.shadow.normalBias = 0.05 * biasScale;

    const sunCam = this.sunLight.shadow.camera;
    const fillCam = this.fillLight ? this.fillLight.shadow.camera : null;

    sunCam.left = -frustumSize;
    sunCam.right = frustumSize;
    sunCam.top = frustumSize;
    sunCam.bottom = -frustumSize;
    sunCam.updateProjectionMatrix();

    if (fillCam) {
      fillCam.left = -frustumSize;
      fillCam.right = frustumSize;
      fillCam.top = frustumSize;
      fillCam.bottom = -frustumSize;
      fillCam.updateProjectionMatrix();
    }
  }

  updateShadowCamera(tankPosition) {
    if (!this.sunLight) return;

    // Position sun shadow camera to follow tank
    this.sunLight.position.copy(tankPosition).addScaledVector(_envSunDir, 500);
    this.sunLight.target.position.copy(tankPosition);
    this.sunLight.target.updateMatrixWorld();

    // Update fill light position and target (opposite side from sun)
    if (this.fillLight) {
      this.fillLight.position.copy(tankPosition).addScaledVector(_envFillDir, 500);
      this.fillLight.target.position.copy(tankPosition);
      this.fillLight.target.updateMatrixWorld();
    }
  }

  _createAtmosphere() {
    const geometry = new THREE.SphereGeometry(this.sphereRadius + 33.6, 64, 64);

    // Use additive blending for natural glow effect (no bloom pass needed)
    // Additive blending inherently creates glow without the selective bloom system
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

    this._atmosphereMesh = new THREE.Mesh(geometry, this.atmosphereMaterial);
    // Don't mark as bloomObject - additive blending creates natural glow
    // Using bloom with transparent additive materials causes flickering
    this._atmosphereMesh.matrixAutoUpdate = false;
    this._atmosphereMesh.updateMatrix();
    this.scene.add(this._atmosphereMesh);
  }

  _createPlanetCore() {
    // Glowing cyan core visible through hollow polar openings
    // Additive blending on default layer for full-res depth testing against crust geometry
    const coreRadius = 450;

    // Soft radial gradient: bright center fading to transparent edges
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
      new THREE.SphereGeometry(coreRadius, 32, 32),
      coreMaterial,
    );
    coreMesh.layers.set(3); // Bloom-source-only: prevents bleed through tile/cliff gaps
    coreMesh.matrixAutoUpdate = false;
    coreMesh.updateMatrix();
    this.scene.add(coreMesh);
    this._coreMesh = coreMesh;
    this._coreMaterial = coreMaterial;

    this._coreTime = 0;
  }

  _createSkybox() {
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
    this._starsMesh = new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({ color: 0xffffff, size: 14.4 }),
    );
    this._starsMesh.matrixAutoUpdate = false;
    this._starsMesh.updateMatrix();
    this.scene.add(this._starsMesh);
  }

  _createMoons() {
    // Speeds in rad/s (original per-frame values × 60)
    const configs = [
      {
        radius: 48,
        distance: 600,
        speed: -0.012,
        angle: Math.random() * Math.PI * 2,
        inclination: (Math.random() - 0.5) * 0.8,
      },
      {
        radius: 24,
        distance: 820,
        speed: -0.009,
        angle: Math.random() * Math.PI * 2,
        inclination: (Math.random() - 0.5) * 0.8,
      },
      {
        radius: 32,
        distance: 720,
        speed: -0.006,
        angle: Math.random() * Math.PI * 2,
        inclination: (Math.random() - 0.5) * 0.8,
      },
    ];

    const moonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        moonColor: { value: new THREE.Color(0x888888) },
        sunDirection: { value: new THREE.Vector3(1, 0, 0).normalize() },
        sunColor: { value: new THREE.Color(0xffdc9b) },
        sunIntensity: { value: 1.2 },
        fillLightDirection: { value: new THREE.Vector3(-1, 0, 0).normalize() },
        fillLightColor: { value: new THREE.Color(0x6b8e99) },
        fillLightIntensity: { value: 0.5 },
        secondaryFillLightDirection: {
          value: new THREE.Vector3(-15, -5, -5).normalize(),
        },
        secondaryFillLightColor: { value: new THREE.Color(0x4a5a6a) },
        secondaryFillLightIntensity: { value: 0.4 },
        ambientColor: { value: new THREE.Color(0x303030) },
        ambientIntensity: { value: 1 },
        planetRadius: { value: this.sphereRadius },
        // Sponsor texture uniforms
        hasTexture: { value: 0 },
        moonTexture: { value: null },
        textureScale: { value: 1.0 },
        textureOffsetX: { value: 0.0 },
        textureOffsetY: { value: 0.0 },
        saturation: { value: 1.0 },
        inputBlack: { value: 0.0 },
        inputGamma: { value: 1.0 },
        inputWhite: { value: 1.0 },
        outputBlack: { value: 0.0 },
        outputWhite: { value: 1.0 },
        moonRadius: { value: 1.0 },
      },
      vertexShader: `
                varying vec3 vNormal;
                varying vec3 vWorldPosition;
                varying vec2 vUv;
                varying float vFacingFactor;
                uniform float moonRadius;
                void main() {
                    vNormal = normalize(mat3(modelMatrix) * normal);
                    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;

                    // Frontal projection toward planet center (matches admin portal)
                    // Compute projection basis in world space from moon center
                    vec3 moonCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
                    vec3 localPos = vWorldPosition - moonCenter;
                    vec3 forward = normalize(-moonCenter);
                    vec3 worldUp = vec3(0.0, 1.0, 0.0);
                    vec3 right = cross(worldUp, forward);
                    if (dot(right, right) < 0.001) {
                        right = vec3(1.0, 0.0, 0.0);
                    }
                    right = normalize(right);
                    vec3 up = normalize(cross(forward, right));

                    // Back hemisphere: project onto equator so UVs extend edge pixels
                    vec3 localDir = normalize(localPos);
                    float behindFactor = dot(localDir, forward);
                    if (behindFactor > 0.0) {
                        vec3 equatorDir = localDir - behindFactor * forward;
                        float eLen = length(equatorDir);
                        if (eLen > 0.001) {
                            localPos = normalize(equatorDir) * moonRadius;
                        }
                    }

                    float invR = 1.0 / moonRadius;
                    float projR = dot(localPos, right) * invR;
                    float projU = dot(localPos, up) * invR;
                    vUv = vec2(1.0 - (projR * 0.5 + 0.5), projU * 0.5 + 0.5);
                    // How much this vertex faces outward (1=away from planet, 0=edge, <0=toward planet)
                    vFacingFactor = -dot(normalize(localPos), forward);

                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
      fragmentShader: `
                uniform vec3 moonColor, sunDirection, sunColor, fillLightDirection, fillLightColor;
                uniform vec3 secondaryFillLightDirection, secondaryFillLightColor, ambientColor;
                uniform float sunIntensity, fillLightIntensity, secondaryFillLightIntensity, ambientIntensity, planetRadius;
                uniform float hasTexture;
                uniform sampler2D moonTexture;
                uniform float textureScale, textureOffsetX, textureOffsetY;
                uniform float saturation, inputBlack, inputGamma, inputWhite, outputBlack, outputWhite;
                varying vec3 vNormal, vWorldPosition;
                varying vec2 vUv;
                varying float vFacingFactor;

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

                vec3 applyLevels(vec3 c) {
                    c = clamp((c - vec3(inputBlack)) / (vec3(inputWhite) - vec3(inputBlack)), 0.0, 1.0);
                    c = pow(c, vec3(1.0 / inputGamma));
                    c = mix(vec3(outputBlack), vec3(outputWhite), c);
                    return c;
                }

                void main() {
                    vec3 n = normalize(vNormal);
                    vec3 baseColor;
                    if (hasTexture > 0.5) {
                        // Scale/offset matching admin: zoom centered, then shift
                        vec2 uv = (vUv - 0.5) / textureScale + 0.5;
                        uv += vec2(textureOffsetX, textureOffsetY) * 0.5;
                        // Clamp UVs so edge pixels extend across the entire moon
                        uv = clamp(uv, 0.0, 1.0);
                        vec3 texColor = texture2D(moonTexture, uv).rgb;
                        texColor = applyLevels(texColor);
                        float gray = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
                        texColor = mix(vec3(gray), texColor, saturation);
                        baseColor = texColor;
                    } else {
                        baseColor = moonColor;
                    }
                    vec3 color = baseColor * ambientColor * ambientIntensity;
                    color += baseColor * sunColor * sunIntensity * max(dot(n, sunDirection), 0.0) * calculateShadow(vWorldPosition, sunDirection);
                    color += baseColor * fillLightColor * fillLightIntensity * max(dot(n, fillLightDirection), 0.0);
                    color += baseColor * secondaryFillLightColor * secondaryFillLightIntensity * max(dot(n, secondaryFillLightDirection), 0.0);
                    gl_FragColor = vec4(color, 1.0);
                }
            `,
    });

    configs.forEach((cfg) => {
      const mat = moonMaterial.clone();
      mat.uniforms.moonRadius.value = cfg.radius;
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(cfg.radius, 16, 16),
        mat,
      );
      moon.userData = cfg;
      this.scene.add(moon);
      this.moons.push(moon);
    });
  }

  /**
   * Apply a sponsor's pattern texture to a moon.
   * @param {number} moonIndex - 0, 1, or 2
   * @param {Object|null} sponsorData - { patternImage, patternAdjustment } or null to clear
   */
  applyMoonSponsor(moonIndex, sponsorData) {
    if (moonIndex < 0 || moonIndex >= this.moons.length) return;
    const moon = this.moons[moonIndex];
    const mat = moon.material;

    if (!sponsorData || !sponsorData.patternImage) {
      // Clear sponsor — revert to default gray
      mat.uniforms.hasTexture.value = 0;
      mat.uniforms.moonTexture.value = null;
      mat.needsUpdate = true;
      moon.userData.sponsor = null;
      return;
    }

    // Store sponsor metadata for right-click popup
    moon.userData.sponsor = {
      name: sponsorData.name,
      tagline: sponsorData.tagline,
      websiteUrl: sponsorData.websiteUrl,
      logoImage: sponsorData.logoImage,
      createdAt: sponsorData.createdAt,
    };

    // Load texture from URL (use global cache to share with hex/billboard)
    const src = sponsorData.patternImage;
    const applyTexture = (texSrc) => {
      const texture = new THREE.Texture(texSrc);
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.needsUpdate = true;

      mat.uniforms.hasTexture.value = 1;
      mat.uniforms.moonTexture.value = texture;

      const adj = sponsorData.patternAdjustment || {};
      mat.uniforms.textureScale.value = adj.scale || 1;
      mat.uniforms.textureOffsetX.value = adj.offsetX || 0;
      mat.uniforms.textureOffsetY.value = adj.offsetY || 0;
      mat.uniforms.saturation.value = adj.saturation !== undefined ? adj.saturation : 1;
      mat.uniforms.inputBlack.value = (adj.inputBlack || 0) / 255;
      mat.uniforms.inputGamma.value = adj.inputGamma || 1;
      mat.uniforms.inputWhite.value = (adj.inputWhite !== undefined ? adj.inputWhite : 255) / 255;
      mat.uniforms.outputBlack.value = (adj.outputBlack || 0) / 255;
      mat.uniforms.outputWhite.value = (adj.outputWhite !== undefined ? adj.outputWhite : 255) / 255;

      mat.needsUpdate = true;
    };

    const cached = window._sponsorImageCache.get(src);
    if (cached?.filtered) {
      applyTexture(cached.filtered);
    } else {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const filtered = _envPixelArtFilter(img);
        window._sponsorImageCache.set(src, { img, filtered });
        applyTexture(filtered);
      };
      img.src = src;
    }
  }

  /** Clear all moon sponsor textures, reverting to default gray. */
  clearMoonSponsors() {
    for (let i = 0; i < this.moons.length; i++) {
      this.applyMoonSponsor(i, null);
    }
  }

  _createSatellites() {
    // Simple satellite model: body + solar panels (reduced count for performance)
    for (let i = 0; i < 120; i++) {
      const satellite = new THREE.Group();

      // Satellite body (small box)
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(3, 2, 2),
        new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          metalness: 0.3,
          roughness: 0.4,
        }),
      );
      body.receiveShadow = true;
      satellite.add(body);

      // Solar panels (two flat rectangles)
      const panelMaterial = new THREE.MeshStandardMaterial({
        color: 0x3a4a6a,
        metalness: 0.15,
        roughness: 0.5,
      });
      const leftPanel = new THREE.Mesh(
        new THREE.BoxGeometry(6, 0.2, 3),
        panelMaterial,
      );
      leftPanel.position.set(-4.5, 0, 0);
      leftPanel.receiveShadow = true;
      satellite.add(leftPanel);

      const rightPanel = new THREE.Mesh(
        new THREE.BoxGeometry(6, 0.2, 3),
        panelMaterial,
      );
      rightPanel.position.set(4.5, 0, 0);
      rightPanel.receiveShadow = true;
      satellite.add(rightPanel);

      // Random orbital parameters
      // Planet radius = sphereRadius (480), distance from surface = 20-100
      const orbitRadius = this.sphereRadius + 40 + Math.random() * 40;

      // Random orbital plane
      const inclination = Math.random() * Math.PI;
      const ascendingNode = Math.random() * Math.PI * 2;

      // Random starting position in orbit
      const orbitalAngle = Math.random() * Math.PI * 2;

      // Orbital speed in rad/s (slower for higher orbits)
      const speed =
        0.012 *
        Math.sqrt(this.sphereRadius / orbitRadius) *
        (Math.random() > 0.5 ? 1 : -1);

      // Random fixed orientation (Euler angles)
      const rotX = Math.random() * Math.PI * 2;
      const rotY = Math.random() * Math.PI * 2;
      const rotZ = Math.random() * Math.PI * 2;

      satellite.userData = {
        orbitRadius,
        inclination,
        ascendingNode,
        orbitalAngle,
        speed,
        rotX,
        rotY,
        rotZ,
      };

      this.scene.add(satellite);
      this.satellites.push(satellite);
    }
  }

  _createSpaceStations() {
    // Speeds in rad/s (original per-frame values × 60)
    const configs = [
      {
        orbitRadius: 700,
        inclination: Math.random() * Math.PI,
        ascendingNode: Math.random() * Math.PI * 2,
        orbitalAngle: Math.random() * Math.PI * 2,
        speed: 0.0048,
        rotationSpeed: 0.06,
      },
      {
        orbitRadius: 750,
        inclination: Math.random() * Math.PI,
        ascendingNode: Math.random() * Math.PI * 2,
        orbitalAngle: Math.random() * Math.PI * 2,
        speed: 0.0036,
        rotationSpeed: 0.048,
      },
    ];

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0xcccccc,
      metalness: 0.35,
      roughness: 0.3,
    });

    const panelMaterial = new THREE.MeshStandardMaterial({
      color: 0x2244aa,
      metalness: 0.2,
      roughness: 0.4,
    });

    const radiatorMaterial = new THREE.MeshStandardMaterial({
      color: 0xaa8866,
      metalness: 0.15,
      roughness: 0.6,
    });

    configs.forEach((cfg) => {
      const station = new THREE.Group();

      // Main truss (central spine)
      const truss = new THREE.Mesh(
        new THREE.BoxGeometry(60, 3, 3),
        bodyMaterial,
      );
      truss.receiveShadow = true;
      station.add(truss);

      // Habitat modules (perpendicular cylinders)
      const habitatGeom = new THREE.CylinderGeometry(5, 5, 20, 8);

      const habitat1 = new THREE.Mesh(habitatGeom, bodyMaterial);
      habitat1.rotation.x = Math.PI / 2;
      habitat1.position.set(-10, 0, 0);
      habitat1.receiveShadow = true;
      station.add(habitat1);

      const habitat2 = new THREE.Mesh(habitatGeom, bodyMaterial);
      habitat2.rotation.x = Math.PI / 2;
      habitat2.position.set(10, 0, 0);
      habitat2.receiveShadow = true;
      station.add(habitat2);

      // Solar arrays (4 large panels at truss ends)
      const solarGeom = new THREE.BoxGeometry(25, 0.3, 12);

      const solar1 = new THREE.Mesh(solarGeom, panelMaterial);
      solar1.position.set(-25, 0, 10);
      solar1.receiveShadow = true;
      station.add(solar1);

      const solar2 = new THREE.Mesh(solarGeom, panelMaterial);
      solar2.position.set(-25, 0, -10);
      solar2.receiveShadow = true;
      station.add(solar2);

      const solar3 = new THREE.Mesh(solarGeom, panelMaterial);
      solar3.position.set(25, 0, 10);
      solar3.receiveShadow = true;
      station.add(solar3);

      const solar4 = new THREE.Mesh(solarGeom, panelMaterial);
      solar4.position.set(25, 0, -10);
      solar4.receiveShadow = true;
      station.add(solar4);

      // Radiator panels (near center)
      const radiatorGeom = new THREE.BoxGeometry(8, 0.2, 6);

      const radiator1 = new THREE.Mesh(radiatorGeom, radiatorMaterial);
      radiator1.position.set(0, 4, 0);
      radiator1.receiveShadow = true;
      station.add(radiator1);

      const radiator2 = new THREE.Mesh(radiatorGeom, radiatorMaterial);
      radiator2.position.set(0, -4, 0);
      radiator2.receiveShadow = true;
      station.add(radiator2);

      station.userData = {
        ...cfg,
        localRotation: Math.random() * Math.PI * 2,
      };

      this.scene.add(station);
      this.spaceStations.push(station);
    });
  }

  /**
   * Inject analytical planet shadow into a MeshLambertMaterial via onBeforeCompile.
   * Uses ray-sphere intersection (same approach as moon shader) to test whether the
   * planet blocks sunlight at each fragment's world position.
   */
  _applyPlanetShadow(material) {
    const planetRadius = this.sphereRadius;
    const existingCallback = material.onBeforeCompile;

    // Add a define so Three.js generates a unique shader program for shadowed materials
    material.defines = material.defines || {};
    material.defines['PLANET_SHADOW'] = '';

    material.onBeforeCompile = (shader) => {
      // Chain existing onBeforeCompile if present (e.g., UV flip on ad panels)
      if (existingCallback) existingCallback(shader);

      // Add uniforms
      shader.uniforms.uPlanetRadius = { value: planetRadius };
      shader.uniforms.uSunDirection = { value: new THREE.Vector3(1, 0, 0) };

      // Vertex shader: declare varying and compute world position
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vWorldPos;'
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

      // Fragment shader: add shadow function and apply before output
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform float uPlanetRadius;
uniform vec3 uSunDirection;
varying vec3 vWorldPos;

float calcPlanetShadow(vec3 pos, vec3 lightDir, float radius) {
    float a = dot(lightDir, lightDir);
    float b = 2.0 * dot(pos, lightDir);
    float c = dot(pos, pos) - radius * radius;
    float d = b * b - 4.0 * a * c;
    if (d > 0.0) {
        float t1 = (-b - sqrt(d)) / (2.0 * a);
        float t2 = (-b + sqrt(d)) / (2.0 * a);
        if (t1 > 0.01 || t2 > 0.01) return 0.0;
    }
    return 1.0;
}`
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( outgoingLight, diffuseColor.a );',
        `vec3 shadowFactor = vec3(mix(0.3, 1.0, calcPlanetShadow(vWorldPos, uSunDirection, uPlanetRadius)));
outgoingLight = (outgoingLight - totalEmissiveRadiance) * shadowFactor + totalEmissiveRadiance;
gl_FragColor = vec4( outgoingLight, diffuseColor.a );`
      );
    };
  }

  _createBillboards() {
    // 18 billboard slots across 2 orbital tiers
    // Admin uses sphereRadius 100 with distances 112/137 → scale to game (×4.8)
    const orbits = [
      { distance: 538, count: 12 },  // LOW orbit (below moons)
      { distance: 850, count: 6 },   // HIGH orbit (above moons, clear of 600/720/820)
    ];

    const panelWidth = 57.6;   // 12 × 4.8 scale
    const panelHeight = 38.4;  // 8 × 4.8 scale
    const bt = 1.44;           // beam thickness
    const bd = 2.4;            // beam depth
    const sw = 19.2;           // solar wing width
    const sh = 14.4;           // solar wing height

    const frameMat = new THREE.MeshLambertMaterial({ color: 0x444444, emissive: 0x222222 });
    const solarMat = new THREE.MeshLambertMaterial({ color: 0x1a1a3a, emissive: 0x0a0a2a, side: THREE.DoubleSide });
    const hubMat = new THREE.MeshLambertMaterial({ color: 0x555555, emissive: 0x181818 });

    // Apply planet shadow to shared materials
    this._applyPlanetShadow(frameMat);
    this._applyPlanetShadow(solarMat);
    this._applyPlanetShadow(hubMat);

    let globalIndex = 0;
    for (const orbit of orbits) {
      for (let i = 0; i < orbit.count; i++) {
        const group = new THREE.Group();

        // Central ad panel
        const panelMat = new THREE.MeshLambertMaterial({
          color: 0x888888,
          emissive: 0x111111,
          side: THREE.DoubleSide,
        });
        // Flip U on back face so outside surface reads correctly
        panelMat.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#ifdef USE_MAP
              vec2 mapUv = vUv;
              if (!gl_FrontFacing) mapUv.x = 1.0 - mapUv.x;
              vec4 texelColor = texture2D(map, mapUv);
              texelColor = mapTexelToLinear(texelColor);
              diffuseColor *= texelColor;
            #endif`
          );
          // Flip emissive map UV on back face too (sponsor glow)
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <emissivemap_fragment>',
            `#ifdef USE_EMISSIVEMAP
              vec2 emissiveMapUv = vUv;
              if (!gl_FrontFacing) emissiveMapUv.x = 1.0 - emissiveMapUv.x;
              vec4 emissiveColor = texture2D(emissiveMap, emissiveMapUv);
              emissiveColor.rgb = emissiveMapTexelToLinear(emissiveColor).rgb;
              totalEmissiveRadiance *= emissiveColor.rgb;
            #endif`
          );
        };
        // Chain planet shadow onto the ad panel material (preserves UV flip above)
        this._applyPlanetShadow(panelMat);
        const adPanel = new THREE.Mesh(new THREE.PlaneGeometry(panelWidth, panelHeight), panelMat);
        adPanel.userData.isAdPanel = true;
        group.add(adPanel);

        // Frame beams
        const topBeam = new THREE.Mesh(new THREE.BoxGeometry(panelWidth + bt * 2, bt, bd), frameMat);
        topBeam.position.set(0, panelHeight / 2 + bt / 2, 0);
        topBeam.layers.enable(1);
        group.add(topBeam);

        const bottomBeam = new THREE.Mesh(new THREE.BoxGeometry(panelWidth + bt * 2, bt, bd), frameMat);
        bottomBeam.position.set(0, -panelHeight / 2 - bt / 2, 0);
        bottomBeam.layers.enable(1);
        group.add(bottomBeam);

        const leftBeam = new THREE.Mesh(new THREE.BoxGeometry(bt, panelHeight, bd), frameMat);
        leftBeam.position.set(-panelWidth / 2 - bt / 2, 0, 0);
        leftBeam.layers.enable(1);
        group.add(leftBeam);

        const rightBeam = new THREE.Mesh(new THREE.BoxGeometry(bt, panelHeight, bd), frameMat);
        rightBeam.position.set(panelWidth / 2 + bt / 2, 0, 0);
        rightBeam.layers.enable(1);
        group.add(rightBeam);

        // Solar wings
        const leftSolar = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), solarMat);
        leftSolar.position.set(-panelWidth / 2 - bt - sw / 2 - 2.4, 0, 0);
        leftSolar.layers.enable(1);
        group.add(leftSolar);

        const rightSolar = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), solarMat);
        rightSolar.position.set(panelWidth / 2 + bt + sw / 2 + 2.4, 0, 0);
        rightSolar.layers.enable(1);
        group.add(rightSolar);

        // Hub connectors
        const hubGeom = new THREE.CylinderGeometry(1.92, 1.92, 3.84, 8);
        const leftHub = new THREE.Mesh(hubGeom, hubMat);
        leftHub.rotation.z = Math.PI / 2;
        leftHub.position.set(-panelWidth / 2 - bt - 0.96, 0, 0);
        leftHub.layers.enable(1);
        group.add(leftHub);

        const rightHub = new THREE.Mesh(hubGeom, hubMat);
        rightHub.rotation.z = Math.PI / 2;
        rightHub.position.set(panelWidth / 2 + bt + 0.96, 0, 0);
        rightHub.layers.enable(1);
        group.add(rightHub);

        // Zeroed defaults — server provides authoritative orbital params via welcome packet
        // and periodic ba broadcast. Billboards start hidden (visible = false) so these
        // defaults are never rendered before server values arrive.
        group.userData = {
          isBillboard: true,
          billboardIndex: globalIndex,
          orbitRadius: orbit.distance,
          inclination: 0,
          ascendingNode: 0,
          orbitalAngle: 0,
          speed: 0,
          wobbleX: 0,
          wobbleY: 0,
          wobbleZ: 0,
        };

        group.visible = false; // hidden until a sponsor rents this slot
        this.scene.add(group);
        this.billboards.push(group);
        globalIndex++;
      }
    }
  }

  _createAtmosphereGlow() {
    // Realistic atmospheric scattering for background Earth
    // Earth model is ~1344 radius (3.5 base × 384 scale)
    // Atmosphere is thicker at the limb (edges) due to longer light path
    const atmosphereGroup = new THREE.Group();

    // Single atmosphere sphere with scattering shader
    const atmosphereGeometry = new THREE.SphereGeometry(1420, 64, 64);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      uniforms: {
        atmosphereColor: { value: new THREE.Color(0x6699ff) },
        sunDirection: { value: new THREE.Vector3(1, 0.3, 0.5).normalize() },
      },
      vertexShader: `
                varying vec3 vNormal;
                varying vec3 vWorldPosition;

                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
      fragmentShader: `
                uniform vec3 atmosphereColor;
                uniform vec3 sunDirection;
                varying vec3 vNormal;
                varying vec3 vWorldPosition;

                void main() {
                    // View direction from camera to fragment
                    vec3 viewDir = normalize(cameraPosition - vWorldPosition);

                    // Atmospheric scattering: thicker at edges (limb) due to longer path
                    // When view is tangent to surface, light travels through more atmosphere
                    float viewDot = dot(vNormal, viewDir);
                    float limb = 1.0 - abs(viewDot);

                    // Scattering intensity with realistic falloff
                    // Stronger at edges, almost invisible when facing camera
                    float scatter = pow(limb, 2.5) * 1.2;

                    // Sun-side brightening (Rayleigh scattering is stronger toward sun)
                    float sunFacing = max(0.0, dot(vNormal, sunDirection));
                    float sunScatter = scatter * (0.6 + sunFacing * 0.4);

                    // Add subtle terminator glow (atmosphere glows at day/night boundary)
                    float terminator = 1.0 - abs(sunFacing - 0.5) * 2.0;
                    terminator = pow(terminator, 3.0) * 0.15 * limb;

                    float totalScatter = sunScatter + terminator;

                    // Color with blue tint, slightly warmer toward sun
                    vec3 color = atmosphereColor;
                    color = mix(color, vec3(0.8, 0.9, 1.0), sunFacing * 0.2);

                    gl_FragColor = vec4(color * totalScatter, totalScatter * 0.9);
                }
            `,
      side: THREE.FrontSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    atmosphereGroup.add(new THREE.Mesh(atmosphereGeometry, atmosphereMaterial));

    // Outer glow halo - extends into space around the limb
    const haloGeometry = new THREE.SphereGeometry(1550, 64, 64);
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x4488dd) },
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
                uniform vec3 glowColor;
                varying vec3 vNormal;
                varying vec3 vViewDir;
                void main() {
                    // Soft outer halo that fades into space
                    float fresnel = 1.0 - abs(dot(vNormal, vViewDir));
                    float glow = pow(fresnel, 3.0) * 0.5;

                    gl_FragColor = vec4(glowColor, glow);
                }
            `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    atmosphereGroup.add(new THREE.Mesh(haloGeometry, haloMaterial));

    return atmosphereGroup;
  }

  _createBackgroundEarth() {
    // Load Earth GLB model (requires http server, not file:// protocol)
    this.earth = new THREE.Group();
    this.earth.position.set(-6000, 0, 0);
    this.scene.add(this.earth);

    // Check if we're on http/https (GLB loading works) or file:// (use fallback)
    if (window.location.protocol === "file:") {
      // Fallback for file:// protocol
      const fallback = new THREE.Mesh(
        new THREE.SphereGeometry(768, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0x2b5f7f }),
      );
      this.earth.add(fallback);
    } else {
      const loader = new THREE.GLTFLoader();

      // Set up DRACOLoader for compressed meshes
      const dracoLoader = new THREE.DRACOLoader();
      dracoLoader.setDecoderPath(
        "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/draco/",
      );
      loader.setDRACOLoader(dracoLoader);

      loader.load(
        "assets/earth.glb",
        (gltf) => {
          const model = gltf.scene;
          model.scale.set(384, 384, 384);

          // Configure Earth model materials
          model.traverse((child) => {
            if (child.isMesh) {
              // Disable shadow receiving on Earth
              child.receiveShadow = false;
              if (child.material) {
                child.material.emissiveIntensity = 1;
                // Force NearestFilter on all textures (no anti-aliasing)
                const mat = child.material;
                const texProps = [
                  "map",
                  "emissiveMap",
                  "alphaMap",
                  "normalMap",
                  "bumpMap",
                  "roughnessMap",
                  "metalnessMap",
                  "aoMap",
                ];
                texProps.forEach((prop) => {
                  if (mat[prop]) {
                    mat[prop].minFilter = THREE.NearestFilter;
                    mat[prop].magFilter = THREE.NearestFilter;
                    mat[prop].needsUpdate = true;
                  }
                });
                child.material.needsUpdate = true;
              }
              // Check if this is the cloud layer (by name)
              if (child.name.toLowerCase().includes("cloud")) {
                this.clouds = child;
              }
              // Check if this is the atmosphere layer
              if (child.name.toLowerCase().includes("atmosphere")) {
                const mat = child.material;

                mat.transparent = true;
                mat.depthWrite = false;
                mat.opacity = 1.0;
                mat.alphaTest = 0;

                // Remove all maps except map, alphaMap and emissiveMap
                mat.normalMap = null;
                mat.bumpMap = null;
                mat.displacementMap = null;
                mat.roughnessMap = null;
                mat.metalnessMap = null;
                mat.aoMap = null;
                mat.lightMap = null;
                mat.envMap = null;

                // Ensure emissiveMap is properly configured
                if (mat.emissiveMap) {
                  mat.emissiveMap.encoding = THREE.sRGBEncoding;
                }
                if (mat.alphaMap) {
                  mat.alphaMap.encoding = THREE.sRGBEncoding;
                }

                child.renderOrder = 1;
                mat.needsUpdate = true;

                // Store reference for billboard update
                this.earthAtmosphere = child;
                // Store original rotation to understand disc orientation
                this.earthAtmosphereOriginalQuat = child.quaternion.clone();
              }
            }
          });

          this.earth.add(model);
        },
        undefined,
        (error) => {
          console.error("[Environment] Error loading Earth GLB:", error);
          const fallback = new THREE.Mesh(
            new THREE.SphereGeometry(768, 32, 32),
            new THREE.MeshBasicMaterial({ color: 0x2b5f7f }),
          );
          this.earth.add(fallback);
        },
      );
    }

    this.clouds = null;
  }

  update(camera, deltaTime) {

    // Get camera distance from surface for space object visibility
    const cameraPos = this._cullTemp.cameraPos.copy(camera.position);
    const cameraDistanceFromSurface = cameraPos.length() - this.sphereRadius;
    const vis = this.spaceObjectVisibility;

    // Calculate global zoom-based opacity for space objects
    // INVERSE of surface objects: fade IN when zooming out
    let zoomOpacity = 0;
    if (cameraDistanceFromSurface > vis.fadeInEnd) {
      zoomOpacity = 1; // Fully visible when far from surface
    } else if (cameraDistanceFromSurface > vis.fadeInStart) {
      zoomOpacity =
        (cameraDistanceFromSurface - vis.fadeInStart) /
        (vis.fadeInEnd - vis.fadeInStart);
    }
    // Below cutoff, objects are hidden (zoomOpacity stays 0)

    // Create frustum for culling
    if (!this._frustum) {
      this._frustum = new THREE.Frustum();
      this._projScreenMatrix = new THREE.Matrix4();
    }
    this._projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this._frustum.setFromProjectionMatrix(this._projScreenMatrix);

    // Rotate Earth (slow rotation)
    this.earth.rotation.y += 0.00005;
    // Clouds spin slightly faster than Earth
    if (this.clouds) this.clouds.rotation.y += 0.00015;

    // Billboard atmosphere - flat side always faces camera
    if (this.earthAtmosphere && camera) {
      // Get camera position in Earth's local space (using preallocated temps)
      const temp = this._cullTemp;
      this.earth.updateMatrixWorld();
      temp.earthMatrixInverse.copy(this.earth.matrixWorld).invert();
      temp.billboardCameraLocal
        .copy(camera.position)
        .applyMatrix4(temp.earthMatrixInverse);

      // Calculate direction from atmosphere center to camera (in local space)
      temp.billboardDir
        .copy(temp.billboardCameraLocal)
        .sub(this.earthAtmosphere.position)
        .normalize();

      // Create rotation that aligns Y-axis (disc normal) with camera direction
      temp.billboardUp.set(0, 1, 0);
      temp.billboardQuat.setFromUnitVectors(
        temp.billboardUp,
        temp.billboardDir,
      );

      this.earthAtmosphere.quaternion.copy(temp.billboardQuat);
    }

    // Update Earth visibility (very far, always check frustum)
    this._updateEarthVisibility(zoomOpacity, cameraPos);

    // Update sun visibility
    this._updateSunVisibility(zoomOpacity, cameraPos);

    // Update stars and atmosphere visibility
    if (this._starsMesh) this._starsMesh.visible = zoomOpacity > 0;
    if (this._atmosphereMesh) this._atmosphereMesh.visible = zoomOpacity > 0;

    // Update moons with visibility culling
    this.moons.forEach((moon) => {
      moon.userData.angle += moon.userData.speed * deltaTime;
      const a = moon.userData.angle;
      const d = moon.userData.distance;
      const inc = moon.userData.inclination;

      moon.position.x = Math.cos(a) * d;
      moon.position.z = Math.sin(a) * d;
      moon.position.y = Math.sin(a) * d * Math.sin(inc);

      // Tidal lock: always face outward from planet center
      moon.lookAt(moon.position.x * 2, moon.position.y * 2, moon.position.z * 2);

      // Apply visibility culling
      this._updateSpaceObjectVisibility(
        moon,
        zoomOpacity,
        cameraPos,
        moon.geometry.parameters.radius || 48,
      );
    });

    // Update satellites (staggered - update 20 per frame for performance)
    const satPerFrame = 30;
    const satStart = this._satelliteUpdateIndex || 0;
    const satEnd = Math.min(satStart + satPerFrame, this.satellites.length);

    for (let i = satStart; i < satEnd; i++) {
      const sat = this.satellites[i];
      // Update angle (compensate for staggered updates)
      sat.userData.orbitalAngle +=
        sat.userData.speed * deltaTime * (this.satellites.length / satPerFrame);

      const angle = sat.userData.orbitalAngle;
      const r = sat.userData.orbitRadius;
      const inc = sat.userData.inclination;
      const node = sat.userData.ascendingNode;

      // Position in orbital plane
      const xOrbit = Math.cos(angle);
      const yOrbit = Math.sin(angle);

      // Apply orbital inclination and ascending node
      const x =
        r * (Math.cos(node) * xOrbit - Math.sin(node) * Math.cos(inc) * yOrbit);
      const y = r * Math.sin(inc) * yOrbit;
      const z =
        r * (Math.sin(node) * xOrbit + Math.cos(node) * Math.cos(inc) * yOrbit);

      // Position relative to planet center
      sat.position.set(x, y, z);

      // Apply random fixed orientation
      sat.rotation.set(sat.userData.rotX, sat.userData.rotY, sat.userData.rotZ);

      // Apply visibility culling (satellites are small, radius ~6)
      this._updateSpaceObjectVisibility(sat, zoomOpacity, cameraPos, 6);
    }

    this._satelliteUpdateIndex = satEnd >= this.satellites.length ? 0 : satEnd;

    // Update space stations with visibility culling
    this.spaceStations.forEach((station) => {
      station.userData.orbitalAngle += station.userData.speed * deltaTime;
      station.userData.localRotation += station.userData.rotationSpeed * deltaTime;

      const angle = station.userData.orbitalAngle;
      const r = station.userData.orbitRadius;
      const inc = station.userData.inclination;
      const node = station.userData.ascendingNode;

      // Position in orbital plane (same as satellites)
      const xOrbit = Math.cos(angle);
      const yOrbit = Math.sin(angle);

      // Apply orbital inclination and ascending node
      const x =
        r * (Math.cos(node) * xOrbit - Math.sin(node) * Math.cos(inc) * yOrbit);
      const y = r * Math.sin(inc) * yOrbit;
      const z =
        r * (Math.sin(node) * xOrbit + Math.cos(node) * Math.cos(inc) * yOrbit);

      station.position.set(x, y, z);

      // Slow self-rotation around local Y-axis
      station.rotation.y = station.userData.localRotation;

      // Apply visibility culling (stations are larger, radius ~30)
      this._updateSpaceObjectVisibility(station, zoomOpacity, cameraPos, 30);
    });

    // Update billboards with orbital animation and north-up orientation
    this.billboards.forEach((bb) => {
      // Skip unrented billboards — they stay hidden
      if (!bb.userData.sponsor) return;

      bb.userData.orbitalAngle += bb.userData.speed * deltaTime;

      const angle = bb.userData.orbitalAngle;
      const r = bb.userData.orbitRadius;
      const inc = bb.userData.inclination;
      const node = bb.userData.ascendingNode;

      // Position in orbital plane (same formula as satellites/stations)
      const xOrbit = Math.cos(angle);
      const yOrbit = Math.sin(angle);

      const x = r * (Math.cos(node) * xOrbit - Math.sin(node) * Math.cos(inc) * yOrbit);
      const y = r * Math.sin(inc) * yOrbit;
      const z = r * (Math.sin(node) * xOrbit + Math.cos(node) * Math.cos(inc) * yOrbit);

      bb.position.set(x, y, z);

      // Orient billboard: face planet center with top pointing north (world Y+)
      // Forward = direction from billboard toward planet center (negative position)
      // Build orthonormal basis: Z-forward toward planet, Y-up toward north
      const forward = _bbForward.copy(bb.position).negate().normalize();
      const worldUp = _bbWorldUp; // (0, 1, 0)
      // Right = worldUp × forward (cross product gives rightward direction)
      const right = _bbRight.crossVectors(worldUp, forward).normalize();
      // Recompute up to ensure orthonormal (forward × right)
      const up = _bbUp.crossVectors(forward, right);

      // Construct rotation matrix from basis vectors
      // Three.js Matrix4 column-major: col0=right, col1=up, col2=forward
      _bbMatrix.makeBasis(right, up, forward);
      bb.quaternion.setFromRotationMatrix(_bbMatrix);

      // Apply per-billboard orientation wobble
      _bbWobbleEuler.set(bb.userData.wobbleX, bb.userData.wobbleY, bb.userData.wobbleZ);
      _bbWobbleQuat.setFromEuler(_bbWobbleEuler);
      bb.quaternion.multiply(_bbWobbleQuat);

      // Visibility culling (billboard bounding radius ~40)
      this._updateSpaceObjectVisibility(bb, zoomOpacity, cameraPos, 40);
    });

    // Update asteroid belt
    if (this.asteroidBelt) {
      this.asteroidBelt.update(camera, zoomOpacity, cameraPos, this._frustum);
    }
  }

  // ========================
  // MULTIPLAYER SYNC
  // ========================

  applyCelestialConfig(config) {
    if (config.moons) {
      config.moons.forEach((srv, i) => {
        if (i < this.moons.length) {
          const m = this.moons[i];
          m.userData.angle = srv.angle;
          m.userData.speed = srv.speed;
          m.userData.distance = srv.distance;
          m.userData.inclination = srv.inclination;
        }
      });
    }
    if (config.stations) {
      config.stations.forEach((srv, i) => {
        if (i < this.spaceStations.length) {
          const s = this.spaceStations[i];
          s.userData.orbitalAngle = srv.orbitalAngle;
          s.userData.speed = srv.speed;
          s.userData.orbitRadius = srv.orbitRadius;
          s.userData.inclination = srv.inclination;
          s.userData.ascendingNode = srv.ascendingNode;
          s.userData.rotationSpeed = srv.rotationSpeed;
          s.userData.localRotation = srv.localRotation;
        }
      });
    }
    if (config.billboards) {
      config.billboards.forEach((srv, i) => {
        if (i < this.billboards.length) {
          const b = this.billboards[i];
          b.userData.orbitalAngle = srv.orbitalAngle;
          b.userData.speed = srv.speed;
          b.userData.orbitRadius = srv.orbitRadius;
          b.userData.inclination = srv.inclination;
          b.userData.ascendingNode = srv.ascendingNode;
          if (srv.wobbleX !== undefined) {
            b.userData.wobbleX = srv.wobbleX;
            b.userData.wobbleY = srv.wobbleY;
            b.userData.wobbleZ = srv.wobbleZ;
          }
        }
      });
    }
  }

  /**
   * Apply a sponsor's pattern texture to a billboard's ad panel.
   * @param {number} billboardIndex - 0-17
   * @param {Object|null} sponsorData - { patternImage, patternAdjustment } or null to clear
   */
  applyBillboardSponsor(billboardIndex, sponsorData) {
    if (billboardIndex < 0 || billboardIndex >= this.billboards.length) return;
    const bb = this.billboards[billboardIndex];
    const adPanel = bb.children.find((c) => c.userData.isAdPanel);
    if (!adPanel) return;

    if (!sponsorData || !sponsorData.patternImage) {
      // Clear sponsor — hide billboard, revert to default gray, remove from bloom
      bb.visible = false;
      adPanel.material.color.setHex(0x888888);
      adPanel.material.emissive.setHex(0x111111);
      adPanel.material.emissiveMap = null;
      adPanel.material.emissiveIntensity = 1;
      adPanel.material.map = null;
      adPanel.material.needsUpdate = true;
      adPanel.layers.set(0);
      bb.userData.sponsor = null;
      return;
    }

    // Show billboard when sponsor is assigned
    bb.visible = true;

    // Store sponsor metadata for right-click popup
    bb.userData.sponsor = {
      name: sponsorData.name,
      tagline: sponsorData.tagline,
      websiteUrl: sponsorData.websiteUrl,
      logoImage: sponsorData.logoImage,
      createdAt: sponsorData.createdAt,
    };

    // Load texture from URL (use global cache to share with hex/moon)
    const src = sponsorData.patternImage;
    const applyTexture = (texSrc) => {
      const texture = new THREE.Texture(texSrc);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;

      // Aspect-correct "cover" mapping: fill panel without stretching
      const panelAspect = 57.6 / 38.4; // 1.5
      const texAspect = texSrc.width / texSrc.height;
      if (texAspect < panelAspect) {
        texture.repeat.set(1, texAspect / panelAspect);
        texture.offset.set(0, (1 - texAspect / panelAspect) / 2);
      } else {
        texture.repeat.set(panelAspect / texAspect, 1);
        texture.offset.set((1 - panelAspect / texAspect) / 2, 0);
      }

      // Apply patternAdjustment (scale, offset)
      const adj = sponsorData.patternAdjustment || {};
      const scale = adj.scale || 1;
      const coverOffX = texture.offset.x;
      const coverOffY = texture.offset.y;
      texture.repeat.set(texture.repeat.x / scale, texture.repeat.y / scale);
      texture.offset.set(
        (coverOffX - 0.5) / scale + 0.5 + (adj.offsetX || 0) * 0.5,
        (coverOffY - 0.5) / scale + 0.5 + (adj.offsetY || 0) * 0.5
      );

      texture.needsUpdate = true;

      adPanel.material.map = texture;
      adPanel.material.color.setHex(0xffffff);
      adPanel.material.emissive.setHex(0xffffff);
      adPanel.material.emissiveMap = texture;
      adPanel.material.emissiveIntensity = 0.85;
      adPanel.material.needsUpdate = true;
      adPanel.layers.enable(1);
    };

    const cached = window._sponsorImageCache.get(src);
    if (cached?.filtered) {
      applyTexture(cached.filtered);
    } else {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const filtered = _envPixelArtFilter(img);
        window._sponsorImageCache.set(src, { img, filtered });
        applyTexture(filtered);
      };
      img.onerror = () => {
        console.warn(`Billboard ${billboardIndex}: failed to load image`, src);
        bb.visible = false;
      };
      img.src = src;
    }
  }

  /** Clear all billboard sponsor textures. */
  clearBillboardSponsors() {
    for (let i = 0; i < this.billboards.length; i++) {
      this.applyBillboardSponsor(i, null);
    }
  }

  /**
   * Update visibility for a space object (satellite, moon, station)
   * Objects fade IN when zooming out, fade OUT when close to surface
   */
  _updateSpaceObjectVisibility(obj, zoomOpacity, cameraPos, boundingRadius) {
    const vis = this.spaceObjectVisibility;

    // If zoom opacity is 0, hide everything
    if (zoomOpacity <= 0) {
      obj.visible = false;
      return;
    }

    // Get object world position
    const objPos = this._cullTemp.objPos;
    obj.getWorldPosition(objPos);

    // Distance culling - hide objects too far from camera
    const distToCamera = objPos.distanceTo(cameraPos);
    if (distToCamera > vis.maxRenderDistance) {
      obj.visible = false;
      return;
    }

    // Backface culling for objects on far side of planet
    // Check if planet occludes the object from camera's view
    const temp = this._cullTemp;
    const objFromCenter = temp.objFromCenter.copy(objPos).normalize();
    const cameraFromCenter = temp.cameraFromCenter.copy(cameraPos).normalize();
    const objDistFromCenter = objPos.length();

    // If object is behind the planet relative to camera
    // (object's direction from center is opposite to camera's direction, and it's close to surface)
    const dotProduct = objFromCenter.dot(cameraFromCenter);
    if (dotProduct < -0.3 && objDistFromCenter < this.sphereRadius * 1.5) {
      obj.visible = false;
      return;
    }

    // Frustum culling - use bounding sphere
    if (!this._boundingSphere) {
      this._boundingSphere = new THREE.Sphere();
    }
    this._boundingSphere.center.copy(objPos);
    this._boundingSphere.radius = boundingRadius;
    if (!this._frustum.intersectsSphere(this._boundingSphere)) {
      obj.visible = false;
      return;
    }

    // Object is visible - apply opacity
    obj.visible = true;

    // Calculate distance-based opacity fade for very distant objects
    let distanceOpacity = 1;
    if (distToCamera > vis.fadeStartDistance) {
      distanceOpacity =
        1 -
        (distToCamera - vis.fadeStartDistance) /
          (vis.maxRenderDistance - vis.fadeStartDistance);
      distanceOpacity = Math.max(0, Math.min(1, distanceOpacity));
    }

    // Combined opacity
    const finalOpacity = zoomOpacity * distanceOpacity;

    // Apply opacity to all mesh materials in the object
    obj.traverse((child) => {
      if (child.isMesh && child.material) {
        // Only modify if material supports transparency
        if (!child.material.userData.originalOpacity) {
          child.material.userData.originalOpacity =
            child.material.opacity !== undefined ? child.material.opacity : 1;
          child.material.transparent = true;
        }
        child.material.opacity =
          child.material.userData.originalOpacity * finalOpacity;
      }
    });
  }

  /**
   * Update Earth visibility (special case - very large and distant)
   */
  _updateEarthVisibility(zoomOpacity, cameraPos) {
    if (!this.earth) return;

    // Earth is always far enough to be visible when zoomed out
    // Just apply zoom-based opacity
    if (zoomOpacity <= 0) {
      this.earth.visible = false;
      return;
    }

    this.earth.visible = true;

    // Apply opacity to Earth meshes
    this.earth.traverse((child) => {
      if (child.isMesh && child.material) {
        if (!child.material.userData.originalOpacity) {
          child.material.userData.originalOpacity =
            child.material.opacity !== undefined ? child.material.opacity : 1;
          // Don't force transparency on solid Earth materials
          if (child.material.transparent) {
            child.material.userData.wasTransparent = true;
          }
        }
        if (
          child.material.userData.wasTransparent ||
          child.material.transparent
        ) {
          child.material.opacity =
            child.material.userData.originalOpacity * zoomOpacity;
        }
      }
    });
  }

  /**
   * Update Sun visibility (special case - emissive, no transparency)
   */
  _updateSunVisibility(zoomOpacity, cameraPos) {
    if (!this.sun) return;
    this.sun.visible = zoomOpacity > 0;
  }

  updateAtmosphere(cameraDistance) {
    this.atmosphereMaterial.uniforms.cameraDistance.value = cameraDistance;
  }
}
