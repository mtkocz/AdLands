/**
 * ShieldEffect — 3D energy shield arc visual for tanks.
 * Manages per-tank shield meshes (partial cylinder masked by shader).
 * Attach to turretGroup so the arc rotates with the turret.
 */
class ShieldEffect {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.shields = new Map(); // tankId → { mesh, material, parent }

    // Shared geometry (open-ended cylinder, 32 segments)
    this._sharedGeometry = new THREE.CylinderGeometry(4.0, 4.0, 4.0, 32, 1, true);
  }

  /**
   * Get or create a shield mesh for a tank, attached to its turretGroup.
   */
  getOrCreateShield(tankId, turretGroup, faction) {
    if (this.shields.has(tankId)) return this.shields.get(tankId);

    const factionColor = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].threeLight.clone()
      : new THREE.Color(0x00ccff);
    // HDR boost for bloom
    factionColor.multiplyScalar(3);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: factionColor },
        uArcAngle: { value: 2.094 },
        uOpacity: { value: 0.55 },
        uTime: { value: 0 },
        uEnergy: { value: 1.0 },
      },
      vertexShader: [
        'varying float vAngle;',
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  vAngle = atan(position.x, -position.z);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uArcAngle;',
        'uniform float uOpacity;',
        'uniform float uTime;',
        'uniform float uEnergy;',
        'varying float vAngle;',
        'varying vec2 vUv;',
        'void main() {',
        '  float halfArc = uArcAngle * 0.5;',
        '  float absAngle = abs(vAngle);',
        '  if (absAngle > halfArc) discard;',
        // Soft fade at arc edges
        '  float edgeFade = smoothstep(halfArc, halfArc - 0.2, absAngle);',
        // Hex grid pattern
        '  float gx = fract(vAngle * 5.0 + sin(vUv.y * 12.0) * 0.3);',
        '  float gy = fract(vUv.y * 6.0);',
        '  float grid = step(0.08, gx) * step(gx, 0.92) * step(0.08, gy) * step(gy, 0.92);',
        // Shimmer
        '  float shimmer = 0.75 + 0.25 * sin(uTime * 5.0 + vUv.y * 12.0);',
        // Energy pulse
        '  float pulse = 0.5 + 0.5 * uEnergy;',
        // Top/bottom fade
        '  float vFade = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.85, vUv.y);',
        '  float alpha = uOpacity * edgeFade * (0.25 + 0.75 * grid) * shimmer * pulse * vFade;',
        '  gl_FragColor = vec4(uColor, alpha);',
        '}',
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(this._sharedGeometry, material);
    mesh.visible = false;
    mesh.renderOrder = 50;
    mesh.layers.enable(1); // BLOOM_LAYER
    // Position relative to turret: slightly forward and centered vertically
    mesh.position.set(0, 0, 0);

    turretGroup.add(mesh);

    const entry = { mesh, material, parent: turretGroup };
    this.shields.set(tankId, entry);
    return entry;
  }

  /**
   * Update shield visibility, arc angle, and energy each frame.
   */
  updateShield(tankId, active, arcAngle, energy, deltaTime) {
    const shield = this.shields.get(tankId);
    if (!shield) return;

    shield.mesh.visible = active;
    if (active) {
      shield.material.uniforms.uArcAngle.value = arcAngle;
      shield.material.uniforms.uEnergy.value = energy;
      shield.material.uniforms.uTime.value += deltaTime;
    }
  }

  /**
   * Remove and dispose shield mesh for a despawned tank.
   */
  removeShield(tankId) {
    const shield = this.shields.get(tankId);
    if (!shield) return;
    shield.parent.remove(shield.mesh);
    shield.material.dispose();
    this.shields.delete(tankId);
  }

  dispose() {
    for (const [id] of this.shields) {
      this.removeShield(id);
    }
    this._sharedGeometry.dispose();
  }
}
