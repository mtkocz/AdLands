/**
 * ShieldEffect — 2D arc line shield visual for tanks.
 * A 1/3 circle (120°) line in front of the turret, faction-colored with bloom glow.
 * Attach to turretGroup so the arc rotates with the turret.
 */
class ShieldEffect {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.shields = new Map(); // tankId → { mesh, material, parent }

    // Shared arc geometry — 120° arc centered on -Z (barrel direction)
    const segments = 32;
    const radius = 4.5;
    const arcAngle = Math.PI * 2 / 3; // 120°
    const halfArc = arcAngle / 2;

    const positions = new Float32Array((segments + 1) * 3);
    for (let i = 0; i <= segments; i++) {
      const angle = -halfArc + (arcAngle * i / segments);
      positions[i * 3]     = Math.sin(angle) * radius;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = -Math.cos(angle) * radius;
    }

    this._sharedGeometry = new THREE.BufferGeometry();
    this._sharedGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  }

  /**
   * Get or create a shield line for a tank, attached to its turretGroup.
   */
  getOrCreateShield(tankId, turretGroup, faction) {
    if (this.shields.has(tankId)) return this.shields.get(tankId);

    const factionColor = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].three.clone()
      : new THREE.Color(0x00ccff);
    // HDR boost for bloom glow
    factionColor.multiplyScalar(3.0);

    const material = new THREE.LineBasicMaterial({
      color: factionColor,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const line = new THREE.Line(this._sharedGeometry, material);
    line.visible = false;
    line.renderOrder = 50;
    line.layers.enable(1); // BLOOM_LAYER
    line.position.set(0, 0.5, 0); // Slightly above turret pivot

    turretGroup.add(line);

    const entry = { mesh: line, material, parent: turretGroup };
    this.shields.set(tankId, entry);
    return entry;
  }

  /**
   * Update shield visibility each frame.
   */
  updateShield(tankId, active, arcAngle, energy, deltaTime) {
    const shield = this.shields.get(tankId);
    if (!shield) return;
    shield.mesh.visible = active;
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
