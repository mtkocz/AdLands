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
        uPulseEdge: { value: -1.0 },
        uFlash: { value: 0.0 },
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
        'uniform float uFlash;',
        'varying float vNormAngle;',
        'void main() {',
        '  if (vNormAngle > uReveal) discard;',
        '  float edgeDist = abs(vNormAngle - uPulseEdge);',
        '  float pulse = uPulseEdge > -0.5 ? smoothstep(0.12, 0.0, edgeDist) : 0.0;',
        '  vec3 col = uColor + pulse * vec3(0.8) + uFlash * vec3(1.0);',
        '  float alpha = 0.9 + pulse * 0.6 + uFlash * 0.5;',
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
      retractTime: -1,
    };
    this.shields.set(tankId, entry);
    return entry;
  }

  updateShield(tankId, active, arcAngle, energy, deltaTime) {
    const shield = this.shields.get(tankId);
    if (!shield) return;

    // Detect activation edge
    if (active && !shield.wasActive) {
      shield.deployTime = 0;
      shield.retractTime = -1;
    }
    // Detect deactivation edge
    if (!active && shield.wasActive) {
      shield.retractTime = 0;
      shield.deployTime = -1;
    }
    shield.wasActive = active;

    // Retract animation (plays after shield deactivates)
    if (shield.retractTime >= 0) {
      shield.retractTime += deltaTime;
      const dur = 0.15; // 150ms retract (snappier than deploy)

      if (shield.retractTime < dur) {
        shield.mesh.visible = true;
        shield.mesh.scale.set(1, 1, 1); // Reset any deploy overshoot
        const t = shield.retractTime / dur;
        // Ease-in: starts slow, accelerates
        const ease = t * t;
        shield.material.uniforms.uReveal.value = 1 - ease;
        shield.material.uniforms.uPulseEdge.value = 1 - ease;
        shield.material.uniforms.uFlash.value = 0.0;
      } else {
        shield.mesh.visible = false;
        shield.mesh.scale.set(1, 1, 1);
        shield.material.uniforms.uReveal.value = 1.0;
        shield.material.uniforms.uPulseEdge.value = -1.0;
        shield.material.uniforms.uFlash.value = 0.0;
        shield.retractTime = -1;
      }
      return;
    }

    shield.mesh.visible = active;
    if (!active) return;

    // Deploy animation
    if (shield.deployTime >= 0) {
      shield.deployTime += deltaTime;
      const dur = 0.3; // 300ms deploy with overshoot bounce

      if (shield.deployTime < dur) {
        const t = shield.deployTime / dur;

        // Reveal: fast ease-out, completes by t=0.5
        const revealT = Math.min(1, t * 2);
        const revealEase = 1 - (1 - revealT) * (1 - revealT);
        shield.material.uniforms.uReveal.value = revealEase;
        shield.material.uniforms.uPulseEdge.value = revealEase;

        // Flash
        const flash = t < 0.1 ? t / 0.1 : Math.max(0, (0.4 - t) / 0.3);
        shield.material.uniforms.uFlash.value = flash * 1.4;

        // Scale: back-ease-out — overshoots ~15% then settles to 1.0
        const s = 2.5;
        const t1 = t - 1;
        const scaleVal = t1 * t1 * ((s + 1) * t1 + s) + 1;
        shield.mesh.scale.set(scaleVal, 1, scaleVal);
      } else {
        shield.mesh.scale.set(1, 1, 1);
        shield.material.uniforms.uReveal.value = 1.0;
        shield.material.uniforms.uPulseEdge.value = -1.0;
        shield.material.uniforms.uFlash.value = 0.0;
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
