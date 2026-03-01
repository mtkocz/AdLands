/**
 * ShieldEffect — 2D arc shield visual for tanks.
 * A 1/3 circle (120°) ribbon in front of the turret, faction-colored with bloom glow.
 * Attach to turretGroup so the arc rotates with the turret.
 */
class ShieldEffect {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.shields = new Map(); // tankId → { mesh, material, parent, wasActive, pulseTime }

    // Shared arc geometry — 120° ribbon (inner + outer radius) centered on -Z
    const segments = 32;
    const innerRadius = 4.325;
    const outerRadius = 4.675;
    const arcAngle = Math.PI * 2 / 3; // 120°
    const halfArc = arcAngle / 2;

    // Two vertices per segment (inner and outer edge)
    const vertCount = (segments + 1) * 2;
    const positions = new Float32Array(vertCount * 3);
    const indices = [];

    for (let i = 0; i <= segments; i++) {
      const angle = -halfArc + (arcAngle * i / segments);
      const sinA = Math.sin(angle);
      const cosA = -Math.cos(angle);
      const base = i * 2;

      // Inner vertex
      positions[base * 3]     = sinA * innerRadius;
      positions[base * 3 + 1] = 0;
      positions[base * 3 + 2] = cosA * innerRadius;

      // Outer vertex
      positions[(base + 1) * 3]     = sinA * outerRadius;
      positions[(base + 1) * 3 + 1] = 0;
      positions[(base + 1) * 3 + 2] = cosA * outerRadius;

      // Two triangles per quad
      if (i < segments) {
        const a = base, b = base + 1, c = base + 2, d = base + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    this._sharedGeometry = new THREE.BufferGeometry();
    this._sharedGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._sharedGeometry.setIndex(indices);
  }

  /**
   * Get or create a shield mesh for a tank, attached to its turretGroup.
   */
  getOrCreateShield(tankId, turretGroup, faction) {
    if (this.shields.has(tankId)) return this.shields.get(tankId);

    const factionColor = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].three.clone()
      : new THREE.Color(0x00ccff);
    // HDR boost for bloom glow
    factionColor.multiplyScalar(0.9);

    const material = new THREE.MeshBasicMaterial({
      color: factionColor,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(this._sharedGeometry, material);
    mesh.visible = false;
    mesh.renderOrder = 50;
    mesh.layers.enable(1); // BLOOM_LAYER
    mesh.position.set(0, 0.5, 0);

    turretGroup.add(mesh);

    const entry = { mesh, material, parent: turretGroup, wasActive: false, pulseTime: -1 };
    this.shields.set(tankId, entry);
    return entry;
  }

  /**
   * Update shield visibility and activation pulse each frame.
   */
  updateShield(tankId, active, arcAngle, energy, deltaTime) {
    const shield = this.shields.get(tankId);
    if (!shield) return;

    // Detect activation edge — trigger pulse
    if (active && !shield.wasActive) {
      shield.pulseTime = 0;
    }
    shield.wasActive = active;

    shield.mesh.visible = active;
    if (!active) {
      shield.mesh.scale.setScalar(1);
      return;
    }

    // Pulse animation: quick scale burst that settles to 1x
    if (shield.pulseTime >= 0) {
      shield.pulseTime += deltaTime;
      const dur = 0.15; // 150ms pulse
      if (shield.pulseTime < dur) {
        const t = shield.pulseTime / dur;
        // Ease-out: starts big, snaps to normal
        const ease = 1 - (1 - t) * (1 - t);
        const scale = 1 + 0.5 * (1 - ease); // 1.5 → 1.0
        shield.mesh.scale.setScalar(scale);
        // Brief opacity flash
        shield.material.opacity = 0.9 + 0.6 * (1 - ease);
      } else {
        shield.mesh.scale.setScalar(1);
        shield.material.opacity = 0.9;
        shield.pulseTime = -1; // Done
      }
    }
  }

  /**
   * Remove and dispose shield for a despawned tank.
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
