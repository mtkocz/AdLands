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

    // Shared geometry (open-ended cylinder, 24 segments — plenty for a smooth arc)
    this._sharedGeometry = new THREE.CylinderGeometry(4.0, 4.0, 4.0, 24, 1, true);
  }

  /**
   * Get or create a shield mesh for a tank, attached to its turretGroup.
   */
  getOrCreateShield(tankId, turretGroup, faction) {
    if (this.shields.has(tankId)) return this.shields.get(tankId);

    const factionColor = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].three.clone()
      : new THREE.Color(0x00ccff);
    // HDR boost for bloom (moderate to preserve faction hue)
    factionColor.multiplyScalar(2.0);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: factionColor },
        uArcAngle: { value: 2.094 },
        uOpacity: { value: 0.6 },
        uTime: { value: 0 },
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
        'varying float vAngle;',
        'varying vec2 vUv;',
        'void main() {',
        '  float halfArc = uArcAngle * 0.5;',
        '  float absAngle = abs(vAngle);',
        '  if (absAngle > halfArc) discard;',
        // Hard edge with thin bright border
        '  float edge = smoothstep(halfArc, halfArc - 0.08, absAngle);',
        '  float rim = 1.0 - smoothstep(halfArc - 0.12, halfArc - 0.04, absAngle);',
        // Horizontal scan lines (scrolling upward)
        '  float scan = 0.85 + 0.15 * step(0.5, fract(vUv.y * 10.0 - uTime * 0.8));',
        // Top/bottom hard fade
        '  float vFade = smoothstep(0.0, 0.1, vUv.y) * smoothstep(1.0, 0.9, vUv.y);',
        // Combine: base fill + bright rim at edges
        '  float alpha = uOpacity * edge * scan * vFade + 0.3 * (1.0 - rim) * edge * vFade;',
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
