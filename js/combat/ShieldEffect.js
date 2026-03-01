/**
 * ShieldEffect — 2D arc shield visual for tanks.
 * A 1/3 circle (120°) ribbon in front of the turret, faction-colored with bloom glow.
 * On activation the arc grows outward from center with a bright pulse at the edge.
 */
class ShieldEffect {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.sphereRadius = sphereRadius;
    this.shields = new Map();

    // Shared arc geometry — 120° ribbon centered on -Z
    // Store normalized angle (0 = center, 1 = edge) in UV.x for shader
    const segments = 32;
    const innerRadius = 4.325;
    const outerRadius = 4.675;
    const arcAngle = Math.PI * 2 / 3;
    const halfArc = arcAngle / 2;

    const vertCount = (segments + 1) * 2;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const indices = [];

    for (let i = 0; i <= segments; i++) {
      const frac = i / segments; // 0 → 1 along arc
      const normAngle = Math.abs(frac - 0.5) * 2; // 0 at center, 1 at edges
      const angle = -halfArc + arcAngle * frac;
      const sinA = Math.sin(angle);
      const cosA = -Math.cos(angle);
      const base = i * 2;

      positions[base * 3]     = sinA * innerRadius;
      positions[base * 3 + 1] = 0;
      positions[base * 3 + 2] = cosA * innerRadius;
      uvs[base * 2] = normAngle;
      uvs[base * 2 + 1] = 0;

      positions[(base + 1) * 3]     = sinA * outerRadius;
      positions[(base + 1) * 3 + 1] = 0;
      positions[(base + 1) * 3 + 2] = cosA * outerRadius;
      uvs[(base + 1) * 2] = normAngle;
      uvs[(base + 1) * 2 + 1] = 1;

      if (i < segments) {
        const a = base, b = base + 1, c = base + 2, d = base + 3;
        indices.push(a, b, c, b, d, c);
      }
    }

    this._sharedGeometry = new THREE.BufferGeometry();
    this._sharedGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._sharedGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this._sharedGeometry.setIndex(indices);
  }

  getOrCreateShield(tankId, turretGroup, faction) {
    if (this.shields.has(tankId)) return this.shields.get(tankId);

    const factionColor = FACTION_COLORS[faction]
      ? FACTION_COLORS[faction].three.clone()
      : new THREE.Color(0x00ccff);
    factionColor.multiplyScalar(0.9);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: factionColor },
        uReveal: { value: 1.0 },
        uPulseEdge: { value: 0.0 },
      },
      vertexShader: [
        'varying float vNormAngle;',
        'void main() {',
        '  vNormAngle = uv.x;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform float uReveal;',
        'uniform float uPulseEdge;',
        'varying float vNormAngle;',
        'void main() {',
        '  if (vNormAngle > uReveal) discard;',
        // Bright pulse at the expanding leading edge
        '  float edgeDist = abs(vNormAngle - uPulseEdge);',
        '  float pulse = smoothstep(0.12, 0.0, edgeDist);',
        '  vec3 col = uColor + pulse * vec3(0.8);',
        '  float alpha = 0.9 + pulse * 0.6;',
        '  gl_FragColor = vec4(col, alpha);',
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
    mesh.position.set(0, 0.5, 0);

    turretGroup.add(mesh);

    const entry = {
      mesh, material, parent: turretGroup,
      wasActive: false,
      deployTime: -1,
    };
    this.shields.set(tankId, entry);
    return entry;
  }

  updateShield(tankId, active, arcAngle, energy, deltaTime) {
    const shield = this.shields.get(tankId);
    if (!shield) return;

    if (active && !shield.wasActive) {
      shield.deployTime = 0;
    }
    shield.wasActive = active;

    shield.mesh.visible = active;
    if (!active) {
      shield.material.uniforms.uReveal.value = 1.0;
      shield.material.uniforms.uPulseEdge.value = 0.0;
      return;
    }

    if (shield.deployTime >= 0) {
      shield.deployTime += deltaTime;
      const dur = 0.2; // 200ms deploy

      if (shield.deployTime < dur) {
        const t = shield.deployTime / dur;
        // Ease-out quad: fast start, smooth end
        const ease = 1 - (1 - t) * (1 - t);
        shield.material.uniforms.uReveal.value = ease;
        shield.material.uniforms.uPulseEdge.value = ease;
      } else {
        shield.material.uniforms.uReveal.value = 1.0;
        shield.material.uniforms.uPulseEdge.value = 0.0;
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
