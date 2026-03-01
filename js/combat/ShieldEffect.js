/**
 * ShieldEffect — 2D arc shield visual for tanks.
 * A 1/3 circle (120°) ribbon in front of the turret, faction-colored with bloom glow.
 * Attach to turretGroup so the arc rotates with the turret.
 */
class ShieldEffect {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.shields = new Map();

    // Shared arc geometry — 120° ribbon (inner + outer radius) centered on -Z
    const segments = 32;
    const innerRadius = 4.325;
    const outerRadius = 4.675;
    const arcAngle = Math.PI * 2 / 3; // 120°
    const halfArc = arcAngle / 2;

    const vertCount = (segments + 1) * 2;
    const positions = new Float32Array(vertCount * 3);
    const indices = [];

    for (let i = 0; i <= segments; i++) {
      const angle = -halfArc + (arcAngle * i / segments);
      const sinA = Math.sin(angle);
      const cosA = -Math.cos(angle);
      const base = i * 2;

      positions[base * 3]     = sinA * innerRadius;
      positions[base * 3 + 1] = 0;
      positions[base * 3 + 2] = cosA * innerRadius;

      positions[(base + 1) * 3]     = sinA * outerRadius;
      positions[(base + 1) * 3 + 1] = 0;
      positions[(base + 1) * 3 + 2] = cosA * outerRadius;

      if (i < segments) {
        const a = base, b = base + 1, c = base + 2, d = base + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    this._sharedGeometry = new THREE.BufferGeometry();
    this._sharedGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._sharedGeometry.setIndex(indices);

    this._white = new THREE.Color(1.5, 1.5, 1.5);
  }

  getOrCreateShield(tankId, turretGroup, faction) {
    if (this.shields.has(tankId)) return this.shields.get(tankId);

    const factionColor = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].three.clone()
      : new THREE.Color(0x00ccff);
    factionColor.multiplyScalar(0.9);

    const material = new THREE.MeshBasicMaterial({
      color: factionColor.clone(),
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

    const entry = {
      mesh, material, parent: turretGroup,
      factionColor: factionColor,
      wasActive: false,
      deployTime: -1,
    };
    this.shields.set(tankId, entry);
    return entry;
  }

  updateShield(tankId, active, arcAngle, energy, deltaTime) {
    const shield = this.shields.get(tankId);
    if (!shield) return;

    // Detect activation — start deploy animation
    if (active && !shield.wasActive) {
      shield.deployTime = 0;
    }
    shield.wasActive = active;

    shield.mesh.visible = active;
    if (!active) {
      shield.mesh.scale.set(1, 1, 1);
      shield.material.opacity = 0.9;
      return;
    }

    // Deploy animation: arc sweeps open + white flash → faction color
    if (shield.deployTime >= 0) {
      shield.deployTime += deltaTime;
      const dur = 0.25; // 250ms

      if (shield.deployTime < dur) {
        const t = shield.deployTime / dur;

        // Elastic overshoot on X scale (arc sweeps open from center)
        // Goes 0 → 1.12 → 1.0
        const p = t * t * (3 - 2 * t); // smoothstep
        const overshoot = t < 0.7
          ? t / 0.7 * 1.12
          : 1.12 - (t - 0.7) / 0.3 * 0.12;
        shield.mesh.scale.set(overshoot, 1, 1);

        // White flash → faction color
        const flash = 1 - p;
        shield.material.color.copy(shield.factionColor).lerp(this._white, flash);
        shield.material.opacity = 0.9 + 0.5 * flash;
      } else {
        shield.mesh.scale.set(1, 1, 1);
        shield.material.color.copy(shield.factionColor);
        shield.material.opacity = 0.9;
        shield.deployTime = -1;
      }
    }
  }

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
