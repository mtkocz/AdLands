/**
 * ShieldHolosphere — holographic geodesic wireframe sphere that pulses on shield impact.
 * A bright ring ripples outward from the impact point across the sphere surface.
 * Parented to turretGroup so it follows the tank.
 */
const _holoImpactWorld = new THREE.Vector3();
const _holoLocalCenter = new THREE.Vector3(0, 0.5, 0);

class ShieldHolosphere {
  constructor(scene) {
    this.scene = scene;
    this.effects = [];
    // Shared geodesic sphere — detail 1 = 80 triangles, radius matches clip sphere
    this._geometry = new THREE.IcosahedronGeometry(4.5, 1);
  }

  emit(impactPos, faction, turretGroup) {
    // Compute impact direction in turretGroup local space
    _holoImpactWorld.copy(impactPos);
    turretGroup.worldToLocal(_holoImpactWorld);
    const impactDir = _holoImpactWorld.sub(_holoLocalCenter).normalize();

    const color = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].threeLight.clone()
      : new THREE.Color(0x00ccff);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor:     { value: color },
        uImpactDir: { value: impactDir.clone() },
        uWaveFront: { value: 1.0 },
        uOpacity:   { value: 0.0 },
      },
      vertexShader: [
        'uniform vec3 uImpactDir;',
        'varying float vDot;',
        'void main() {',
        '  vec3 localDir = normalize(position);',
        '  vDot = dot(localDir, uImpactDir);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uWaveFront;',
        'uniform float uOpacity;',
        'varying float vDot;',
        'void main() {',
        '  float dist = abs(vDot - uWaveFront);',
        '  float ring = smoothstep(0.5, 0.0, dist);',
        '  float brightness = 0.04 + ring * 0.36;',
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

    const mesh = new THREE.Mesh(this._geometry, material);
    mesh.position.copy(_holoLocalCenter); // Same offset as shield (0, 0.5, 0)
    mesh.renderOrder = 51;
    mesh.layers.enable(1); // BLOOM_LAYER
    turretGroup.add(mesh);

    this.effects.push({ mesh, material, parent: turretGroup, age: 0, duration: 1.2 });
  }

  update(deltaTime) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.age += deltaTime;
      const t = e.age / e.duration;

      if (t >= 1) {
        e.parent.remove(e.mesh);
        e.material.dispose();
        this.effects.splice(i, 1);
        continue;
      }

      // Wave sweeps from impact (dot=1) to opposite side (dot=-1)
      e.material.uniforms.uWaveFront.value = 1.0 - t * 2.0;

      // Opacity: gentle fade-in, then gradual fade-out
      const fadeIn = Math.min(t / 0.1, 1.0);
      const fadeOut = t > 0.35 ? 1.0 - (t - 0.35) / 0.65 : 1.0;
      e.material.uniforms.uOpacity.value = fadeIn * fadeOut;
    }
  }

  dispose() {
    for (const e of this.effects) {
      e.parent.remove(e.mesh);
      e.material.dispose();
    }
    this.effects.length = 0;
    this._geometry.dispose();
  }
}
