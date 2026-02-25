/**
 * AdLands - Sky Beams Module
 * Glowing yellow beams shooting from portals for fast travel visualization
 * Features: hover deformation with radiating rings, click pulse effect
 */

class SkyBeams {
  constructor(scene, planet) {
    this.scene = scene;
    this.planet = planet;
    this.beams = [];
    this.beamHeight = 120; // Shorter beams
    this.beamRadius = 8;
    this.visible = false;
    this.time = 0;

    // Hover state
    this.hoveredPortalIndex = null;
    this.hoverTime = 0;

    // Click effect state
    this.clickEffects = new Map(); // portalIndex → { time, intensity }

    // Appearance animation state
    this.appearDelay = 0.8;
    this.appearDuration = 0.5;
    this.appearTimer = 0;
    this.appearing = false;
    this.pendingExcludeIndex = null;
    this.currentAppearDelay = this.appearDelay;

    // Create a group for beams that will be added to planet's hexGroup
    this.beamGroup = new THREE.Group();
    this.planet.hexGroup.add(this.beamGroup);

    // Radiating rings group (for hover effect)
    this.ringsGroup = new THREE.Group();
    this.planet.hexGroup.add(this.ringsGroup);
    this.rings = [];

    this._createBeams();
  }

  _createBeams() {
    // Perfect cylinder (no taper)
    const geometry = new THREE.CylinderGeometry(
      this.beamRadius,
      this.beamRadius,
      this.beamHeight,
      24, // More radial segments for smoother deformation
      16, // More height segments for wave deformation
    );

    // Shift geometry so base is at origin
    geometry.translate(0, this.beamHeight / 2, 0);

    // Enhanced shader with hover deformation and click effects
    const vertexShader = `
            varying float vHeight;
            varying float vNormalizedHeight;
            varying vec3 vWorldNormal;
            varying vec3 vViewPosition;
            varying float vDeformation;

            uniform float retractProgress;
            uniform float extendProgress;
            uniform float beamHeight;
            uniform float time;
            uniform float hoverIntensity;
            uniform float clickPulse;

            void main() {
                vec3 pos = position;

                // Calculate current height based on extend/retract
                float currentHeight = beamHeight * extendProgress * (1.0 - retractProgress);
                if (pos.y > currentHeight) {
                    pos.y = currentHeight;
                }

                // Hover deformation: radiating wave rings traveling up the beam
                float deformation = 0.0;
                if (hoverIntensity > 0.0) {
                    float heightRatio = pos.y / beamHeight;

                    // Multiple wave rings traveling upward (50% speed)
                    float wave1 = sin((heightRatio * 8.0 - time * 3.0) * 3.14159) * 0.5 + 0.5;
                    float wave2 = sin((heightRatio * 8.0 - time * 3.0 + 2.0) * 3.14159) * 0.5 + 0.5;
                    float wave3 = sin((heightRatio * 8.0 - time * 3.0 + 4.0) * 3.14159) * 0.5 + 0.5;

                    // Combine waves with decreasing intensity
                    deformation = (wave1 * 0.5 + wave2 * 0.3 + wave3 * 0.2) * hoverIntensity;

                    // Radial expansion at wave peaks
                    float radialExpand = 1.0 + deformation * 0.4;
                    pos.x *= radialExpand;
                    pos.z *= radialExpand;
                }

                // Click pulse: expanding ring burst
                if (clickPulse > 0.0) {
                    float heightRatio = pos.y / beamHeight;
                    float pulseWave = sin(heightRatio * 12.0 - (1.0 - clickPulse) * 15.0);
                    float pulseIntensity = clickPulse * max(0.0, pulseWave);
                    float clickExpand = 1.0 + pulseIntensity * 0.6;
                    pos.x *= clickExpand;
                    pos.z *= clickExpand;
                    deformation += pulseIntensity;
                }

                vDeformation = deformation;
                vHeight = pos.y / beamHeight;
                vNormalizedHeight = extendProgress > 0.0 ? pos.y / (beamHeight * extendProgress) : 0.0;
                vWorldNormal = normalize(normalMatrix * normal);

                vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                vViewPosition = -mvPosition.xyz;

                gl_Position = projectionMatrix * mvPosition;
            }
        `;

    const fragmentShader = `
            uniform vec3 beamColor;
            uniform float glowIntensity;
            uniform float fadeStart;
            uniform float fadeEnd;
            uniform float time;
            uniform float retractProgress;
            uniform float extendProgress;
            uniform float hoverIntensity;
            uniform float clickPulse;

            varying float vHeight;
            varying float vNormalizedHeight;
            varying vec3 vWorldNormal;
            varying vec3 vViewPosition;
            varying float vDeformation;

            void main() {
                // Height-based fade
                float heightFade = 1.0 - smoothstep(fadeStart, fadeEnd, vHeight);

                // Edge glow (fresnel)
                vec3 viewDir = normalize(vViewPosition);
                float fresnel = pow(1.0 - abs(dot(vWorldNormal, viewDir)), 1.5);

                // Pulsing animation
                float pulse = 0.7 + 0.3 * sin(time * 4.0 + vHeight * 15.0);

                // Core brightness
                float core = 0.6 + fresnel * 0.4;

                // Leading edge glow during extend
                float leadingEdge = 0.0;
                if (extendProgress < 1.0 && extendProgress > 0.0) {
                    float edgeDist = 1.0 - vNormalizedHeight;
                    leadingEdge = smoothstep(0.5, 0.0, edgeDist) * 4.0 * (1.0 - extendProgress);
                }

                float extendBoost = extendProgress < 1.0 ? 1.5 : 1.0;

                // Combine effects
                float alpha = heightFade * glowIntensity * pulse * core * extendBoost;
                alpha += leadingEdge;
                alpha *= (1.0 - retractProgress);
                alpha *= min(extendProgress * 2.0, 1.0);

                // Hover boost: subtle brightness increase
                float hoverBoost = 1.0 + hoverIntensity * 0.15;
                alpha *= hoverBoost;

                // Click flash
                alpha += clickPulse * 2.0;

                // Color with deformation brightness boost
                vec3 finalColor = beamColor * (1.0 + fresnel * 0.3);
                finalColor += vec3(1.0) * vDeformation * 0.5;  // Whiter at deformation peaks
                finalColor = mix(finalColor, vec3(1.0), leadingEdge * 0.7);

                // Click makes it flash white
                finalColor = mix(finalColor, vec3(1.0, 1.0, 0.8), clickPulse * 0.7);

                gl_FragColor = vec4(finalColor, alpha);
            }
        `;

    // Create a beam for each portal
    if (typeof this.planet.getAllPortalCenters !== 'function') {
      console.warn('[SkyBeams] planet.getAllPortalCenters not available — skipping beam creation');
      return;
    }
    const portalCenters = this.planet.getAllPortalCenters();

    for (const portalIndex of portalCenters) {
      const position = this.planet.getPortalPosition(portalIndex);
      if (!position) continue;

      const normal = position.clone().normalize();

      const material = new THREE.ShaderMaterial({
        uniforms: {
          beamColor: { value: new THREE.Color(0x00ffff) }, // Cyan game accent
          glowIntensity: { value: 1.0 },
          fadeStart: { value: 0.0 },
          fadeEnd: { value: 0.7 },
          time: { value: 0 },
          retractProgress: { value: 0 },
          extendProgress: { value: 1 },
          beamHeight: { value: this.beamHeight },
          hoverIntensity: { value: 0 },
          clickPulse: { value: 0 },
        },
        vertexShader,
        fragmentShader,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const beam = new THREE.Mesh(geometry, material);
      beam.position.copy(position);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);

      beam.userData.portalIndex = portalIndex;
      beam.userData.normal = normal;
      beam.userData.basePosition = position.clone();
      beam.visible = false;

      this.beams.push(beam);
      this.beamGroup.add(beam);
    }
  }

  _createRadiatingRing(position, normal) {
    // Create a ring that expands outward from the beam base
    const ringGeometry = new THREE.RingGeometry(
      this.beamRadius,
      this.beamRadius + 2,
      32,
    );
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.copy(position);

    // Orient ring perpendicular to beam (facing outward from planet)
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);

    this.ringsGroup.add(ring);
    this.rings.push({
      mesh: ring,
      age: 0,
      maxAge: 0.8,
      startRadius: this.beamRadius,
      normal: normal.clone(),
    });
  }

  show(excludePortalIndex = null) {
    this.visible = true;
    this.appearing = true;
    this.appearTimer = 0;
    this.pendingExcludeIndex = excludePortalIndex;
    this.currentAppearDelay = this.appearDelay;

    this.beams.forEach((beam) => {
      beam.visible = false;
      beam.material.uniforms.retractProgress.value = 0;
      beam.material.uniforms.extendProgress.value = 0;
    });
  }

  _startAppearAnimation() {
    this.beams.forEach((beam) => {
      if (
        this.pendingExcludeIndex !== null &&
        beam.userData.portalIndex === this.pendingExcludeIndex
      ) {
        beam.visible = false;
      } else {
        beam.visible = true;
      }
    });
  }

  reextendWithAnimation(excludePortalIndex = null, delay = null) {
    this.appearing = true;
    this.appearTimer = 0;
    this.pendingExcludeIndex = excludePortalIndex;
    this.currentAppearDelay = delay !== null ? delay : this.appearDelay;

    this.beams.forEach((beam) => {
      beam.visible = false;
      beam.material.uniforms.extendProgress.value = 0;
      beam.material.uniforms.retractProgress.value = 0;
    });
  }

  _updateAppearAnimation(deltaTime) {
    const animTime = this.appearTimer - this.currentAppearDelay;
    const progress = Math.min(animTime / this.appearDuration, 1.0);
    const easedProgress = 1.0 - Math.pow(1.0 - progress, 3);

    this.beams.forEach((beam) => {
      if (beam.visible) {
        beam.material.uniforms.extendProgress.value = easedProgress;
      }
    });

    if (progress >= 1.0) {
      this.appearing = false;
    }
  }

  hide() {
    this.visible = false;
    this.appearing = false;
    this.appearTimer = 0;
    this.beams.forEach((beam) => {
      beam.visible = false;
      beam.material.uniforms.extendProgress.value = 1;
    });

    // Clear rings
    this.rings.forEach((ring) => {
      this.ringsGroup.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.mesh.material.dispose();
    });
    this.rings = [];
  }

  isBeamVisible(portalIndex) {
    const beam = this.beams.find((b) => b.userData.portalIndex === portalIndex);
    return beam ? beam.visible : false;
  }

  setRetraction(progress) {
    this.beams.forEach((beam) => {
      beam.material.uniforms.retractProgress.value = Math.max(
        0,
        Math.min(1, progress),
      );
    });
  }

  update(deltaTime) {
    if (!this.visible) return;

    this.time += deltaTime;

    // Handle appear animation
    if (this.appearing) {
      this.appearTimer += deltaTime;

      if (
        this.appearTimer >= this.currentAppearDelay &&
        !this.beams.some(
          (b) =>
            b.visible && b.userData.portalIndex !== this.pendingExcludeIndex,
        )
      ) {
        this._startAppearAnimation();
      }

      if (this.appearTimer >= this.currentAppearDelay) {
        this._updateAppearAnimation(deltaTime);
      }
    }

    // Update hover animation
    if (this.hoveredPortalIndex !== null) {
      this.hoverTime += deltaTime;

      // Spawn radiating rings periodically while hovering (50% speed - every 0.5s)
      if (
        Math.floor(this.hoverTime * 2) >
        Math.floor((this.hoverTime - deltaTime) * 2)
      ) {
        const beam = this.beams.find(
          (b) => b.userData.portalIndex === this.hoveredPortalIndex,
        );
        if (beam && beam.visible) {
          this._createRadiatingRing(
            beam.userData.basePosition,
            beam.userData.normal,
          );
        }
      }
    }

    // Update all beams
    this.beams.forEach((beam) => {
      beam.material.uniforms.time.value = this.time;

      // Smooth hover intensity transition (50% speed)
      const isHovered = beam.userData.portalIndex === this.hoveredPortalIndex;
      const targetHover = isHovered ? 1.0 : 0.0;
      const currentHover = beam.material.uniforms.hoverIntensity.value;
      beam.material.uniforms.hoverIntensity.value =
        currentHover +
        (targetHover - currentHover) * Math.min(deltaTime * 4, 1);
    });

    // Update click effects
    for (const [portalIndex, effect] of this.clickEffects) {
      effect.time += deltaTime;
      const progress = effect.time / 0.4; // 0.4 second click animation

      if (progress >= 1) {
        this.clickEffects.delete(portalIndex);
        const beam = this.beams.find(
          (b) => b.userData.portalIndex === portalIndex,
        );
        if (beam) {
          beam.material.uniforms.clickPulse.value = 0;
        }
      } else {
        const beam = this.beams.find(
          (b) => b.userData.portalIndex === portalIndex,
        );
        if (beam) {
          // Fast attack, slow decay
          const pulse =
            progress < 0.1
              ? progress * 10
              : Math.pow(1 - (progress - 0.1) / 0.9, 2);
          beam.material.uniforms.clickPulse.value = pulse * effect.intensity;
        }
      }
    }

    // Update radiating rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const ring = this.rings[i];
      ring.age += deltaTime;

      if (ring.age >= ring.maxAge) {
        this.ringsGroup.remove(ring.mesh);
        ring.mesh.geometry.dispose();
        ring.mesh.material.dispose();
        this.rings.splice(i, 1);
        continue;
      }

      const progress = ring.age / ring.maxAge;

      // Expand outward
      const expandedRadius = ring.startRadius + progress * 40;
      const thickness = 3 * (1 - progress);

      // Update ring geometry
      ring.mesh.geometry.dispose();
      ring.mesh.geometry = new THREE.RingGeometry(
        expandedRadius,
        expandedRadius + thickness,
        32,
      );

      // Fade out
      ring.mesh.material.opacity = 0.6 * (1 - progress);

      // Move ring slightly outward along normal as it expands
      const basePos = this.beams.find(
        (b) => b.userData.portalIndex === this.hoveredPortalIndex,
      )?.userData.basePosition;
      if (basePos) {
        ring.mesh.position
          .copy(basePos)
          .addScaledVector(ring.normal, progress * 5);
      }
    }
  }

  highlightBeam(portalIndex) {
    // Set hovered portal for deformation effect
    if (this.hoveredPortalIndex !== portalIndex) {
      this.hoveredPortalIndex = portalIndex;
      this.hoverTime = 0;
    }

    // Visual highlight (subtle brightness on hover)
    this.beams.forEach((beam) => {
      if (beam.userData.portalIndex === portalIndex) {
        beam.material.uniforms.glowIntensity.value = 1.1;
        beam.material.uniforms.beamColor.value.setHex(0x33ffff); // Slightly brighter cyan
      } else {
        beam.material.uniforms.glowIntensity.value = 1.0;
        beam.material.uniforms.beamColor.value.setHex(0x00ffff); // Cyan game accent
      }
    });
  }

  clearHighlight() {
    this.hoveredPortalIndex = null;
    this.hoverTime = 0;

    this.beams.forEach((beam) => {
      beam.material.uniforms.glowIntensity.value = 1.0;
      beam.material.uniforms.beamColor.value.setHex(0x00ffff); // Cyan game accent
    });
  }

  // Trigger click effect on a beam
  triggerClickEffect(portalIndex, intensity = 1.0) {
    this.clickEffects.set(portalIndex, { time: 0, intensity });

    // Also spawn a burst of rings
    const beam = this.beams.find((b) => b.userData.portalIndex === portalIndex);
    if (beam && beam.visible) {
      for (let i = 0; i < 3; i++) {
        setTimeout(() => {
          if (this.visible) {
            this._createRadiatingRing(
              beam.userData.basePosition,
              beam.userData.normal,
            );
          }
        }, i * 50);
      }
    }
  }

  getBeamMeshes() {
    return this.beams;
  }

  getPortalIndexFromBeam(beamMesh) {
    return beamMesh.userData?.portalIndex;
  }

  dispose() {
    this.beams.forEach((beam) => {
      this.beamGroup.remove(beam);
      beam.geometry.dispose();
      beam.material.dispose();
    });
    this.beams = [];

    this.rings.forEach((ring) => {
      this.ringsGroup.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.mesh.material.dispose();
    });
    this.rings = [];

    this.planet.hexGroup.remove(this.beamGroup);
    this.planet.hexGroup.remove(this.ringsGroup);
  }
}
