/**
 * AdLands - Environment Module
 * Lighting, atmosphere, stars, moons, satellites, and background Earth
 */

// Constant direction vectors for shadow camera (preallocated)
const _envSunDir = new THREE.Vector3(1, 0, 0);
const _envFillDir = new THREE.Vector3(-1, 0, 0);

class Environment {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;

    this.moons = [];
    this.satellites = [];
    this.spaceStations = [];
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
    sunLight.shadow.mapSize.width = 8192; // High resolution for reduced banding
    sunLight.shadow.mapSize.height = 8192;
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
    fillLight.shadow.mapSize.width = 4096;
    fillLight.shadow.mapSize.height = 4096;
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
      },
      vertexShader: `
                varying vec3 vNormal;
                varying vec3 vWorldPosition;
                void main() {
                    vNormal = normalize(mat3(modelMatrix) * normal);
                    vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
      fragmentShader: `
                uniform vec3 moonColor, sunDirection, sunColor, fillLightDirection, fillLightColor;
                uniform vec3 secondaryFillLightDirection, secondaryFillLightColor, ambientColor;
                uniform float sunIntensity, fillLightIntensity, secondaryFillLightIntensity, ambientIntensity, planetRadius;
                varying vec3 vNormal, vWorldPosition;

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
                    vec3 color = moonColor * ambientColor * ambientIntensity;
                    color += moonColor * sunColor * sunIntensity * max(dot(n, sunDirection), 0.0) * calculateShadow(vWorldPosition, sunDirection);
                    color += moonColor * fillLightColor * fillLightIntensity * max(dot(n, fillLightDirection), 0.0);
                    color += moonColor * secondaryFillLightColor * secondaryFillLightIntensity * max(dot(n, secondaryFillLightDirection), 0.0);
                    gl_FragColor = vec4(color, 1.0);
                }
            `,
    });

    configs.forEach((cfg) => {
      const moon = new THREE.Mesh(
        new THREE.SphereGeometry(cfg.radius, 16, 16),
        moonMaterial.clone(),
      );
      moon.userData = cfg;
      this.scene.add(moon);
      this.moons.push(moon);
    });
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
      if (!this.isMultiplayer) moon.userData.angle += moon.userData.speed * deltaTime;
      const a = moon.userData.angle;
      const d = moon.userData.distance;
      const inc = moon.userData.inclination;

      moon.position.x = Math.cos(a) * d;
      moon.position.z = Math.sin(a) * d;
      moon.position.y = Math.sin(a) * d * Math.sin(inc);

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
      if (!this.isMultiplayer) {
        station.userData.orbitalAngle += station.userData.speed * deltaTime;
        station.userData.localRotation += station.userData.rotationSpeed * deltaTime;
      }

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
