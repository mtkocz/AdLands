/**
 * ShieldHolosphere — holographic geodesic wireframe sphere that pulses on shield impact.
 * A bright ring ripples outward from the impact point across the sphere surface.
 * Two layers: soft surface pulse underneath + wireframe grid on top.
 * Position follows tank, rotation stays independent (world space).
 */
const _holoImpactWorld = new THREE.Vector3();
const _holoWorldCenter = new THREE.Vector3();
const _holoLocalCenter = new THREE.Vector3(0, 0.5, 0);

class ShieldHolosphere {
  constructor(scene) {
    this.scene = scene;
    this.effects = [];
    // Shared geodesic sphere — detail 1 = 80 triangles, radius matches clip sphere
    this._geometry = new THREE.IcosahedronGeometry(4.5, 1);
  }

  emit(impactPos, faction, turretGroup) {
    // Compute impact direction in world space relative to shield center
    _holoWorldCenter.copy(_holoLocalCenter);
    turretGroup.localToWorld(_holoWorldCenter);
    const impactDir = _holoImpactWorld.subVectors(impactPos, _holoWorldCenter).normalize();

    const color = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].threeLight.clone()
      : new THREE.Color(0x00ccff);

    // --- Shared vertex shader ---
    const vertexShader = [
      'uniform vec3 uImpactDir;',
      'varying float vDot;',
      'void main() {',
      '  vec3 localDir = normalize(position);',
      '  vDot = dot(localDir, uImpactDir);',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}',
    ].join('\n');

    // --- Layer 1: Soft surface pulse (solid, underneath wireframe) ---
    const surfaceMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:     { value: color },
        uImpactDir: { value: impactDir.clone() },
        uWaveFront: { value: 1.0 },
        uOpacity:   { value: 0.0 },
      },
      vertexShader,
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uWaveFront;',
        'uniform float uOpacity;',
        'varying float vDot;',
        'void main() {',
        '  float dist = abs(vDot - uWaveFront);',
        '  float ring = smoothstep(0.6, 0.0, dist);',
        '  float alpha = ring * uOpacity;',
        '  gl_FragColor = vec4(uColor * 0.5, alpha);',
        '}',
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const surfaceMesh = new THREE.Mesh(this._geometry, surfaceMat);
    surfaceMesh.position.copy(_holoWorldCenter);
    surfaceMesh.renderOrder = 50;
    surfaceMesh.layers.enable(1);
    this.scene.add(surfaceMesh);

    // --- Layer 2: Wireframe grid (on top) ---
    const wireMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor:     { value: color },
        uImpactDir: { value: impactDir.clone() },
        uWaveFront: { value: 1.0 },
        uOpacity:   { value: 0.0 },
      },
      vertexShader,
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uWaveFront;',
        'uniform float uOpacity;',
        'varying float vDot;',
        'void main() {',
        '  float dist = abs(vDot - uWaveFront);',
        '  float ring = smoothstep(0.5, 0.0, dist);',
        '  float brightness = 0.05 + ring * 0.35;',
        '  vec3 col = uColor * brightness;',
        '  float alpha = brightness * uOpacity;',
        '  gl_FragColor = vec4(col, alpha);',
        '}',
      ].join('\n'),
      wireframe: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const wireMesh = new THREE.Mesh(this._geometry, wireMat);
    wireMesh.position.copy(_holoWorldCenter);
    wireMesh.renderOrder = 51;
    wireMesh.layers.enable(1);
    this.scene.add(wireMesh);

    this.effects.push({
      wireMesh, wireMat,
      surfaceMesh, surfaceMat,
      turretGroup, age: 0, duration: 1.2,
    });
  }

  update(deltaTime) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += deltaTime;
      const t = e.age / e.duration;

      if (t >= 1) {
        this.scene.remove(e.wireMesh);
        this.scene.remove(e.surfaceMesh);
        e.wireMat.dispose();
        e.surfaceMat.dispose();
        this.effects.splice(i, 1);
        continue;
      }

      // Follow tank position (rotation stays independent)
      _holoWorldCenter.copy(_holoLocalCenter);
      e.turretGroup.localToWorld(_holoWorldCenter);
      e.wireMesh.position.copy(_holoWorldCenter);
      e.surfaceMesh.position.copy(_holoWorldCenter);

      // Wave sweeps from impact (dot=1) to opposite side (dot=-1)
      const waveFront = 1.0 - t * 2.0;
      e.wireMat.uniforms.uWaveFront.value = waveFront;
      e.surfaceMat.uniforms.uWaveFront.value = waveFront;

      // Opacity: gentle fade-in, then gradual fade-out
      const fadeIn = Math.min(t / 0.1, 1.0);
      const fadeOut = t > 0.35 ? 1.0 - (t - 0.35) / 0.65 : 1.0;
      const opacity = fadeIn * fadeOut;
      e.wireMat.uniforms.uOpacity.value = opacity;
      e.surfaceMat.uniforms.uOpacity.value = opacity;
    }
  }

  dispose() {
    for (const e of this.effects) {
      this.scene.remove(e.wireMesh);
      this.scene.remove(e.surfaceMesh);
      e.wireMat.dispose();
      e.surfaceMat.dispose();
    }
    this.effects.length = 0;
    this._geometry.dispose();
  }
}
