/**
 * AdLands - Welding Gun System
 * Client-side visuals for the tactical welding gun.
 * Creates cyan lightning bolt beams between the welder and friendly tanks being healed.
 */

class WeldingGunSystem {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.R = sphereRadius;
    this._jitterTimer = 0;
    this._jitterInterval = 0.08; // Re-jitter every 80ms

    /** @type {Array<{mesh: THREE.Mesh, geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial}>} */
    this.beams = [];
    this._activeCount = 0;

    // Pre-allocate beam pool
    const POOL_SIZE = 10;
    const SEGMENTS = 10;

    for (let i = 0; i < POOL_SIZE; i++) {
      const vertCount = (SEGMENTS + 1) * 2;
      const positions = new Float32Array(vertCount * 3);
      const uvs = new Float32Array(vertCount * 2);
      const indices = [];

      for (let s = 0; s < SEGMENTS; s++) {
        const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, b, c, b, d, c);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(indices);

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0x00ffff) },
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main() {',
          '  vUv = uv;',
          '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
          '}',
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 uColor;',
          'varying vec2 vUv;',
          'void main() {',
          '  float center = 1.0 - abs(vUv.y - 0.5) * 2.0;',
          '  float alpha = smoothstep(0.0, 0.4, center);',
          '  vec3 col = mix(uColor, vec3(1.0), center * center);',
          '  gl_FragColor = vec4(col, alpha * 0.9);',
          '}',
        ].join('\n'),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 50;
      mesh.layers.enable(1); // BLOOM_LAYER
      mesh.frustumCulled = false;
      scene.add(mesh);

      this.beams.push({ mesh, geo, mat, segments: SEGMENTS });
    }

    // Temp vectors (avoid per-frame allocation)
    this._tmpFrom = new THREE.Vector3();
    this._tmpTo = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpPerp = new THREE.Vector3();
    this._tmpCamDir = new THREE.Vector3();
    this._tmpPoint = new THREE.Vector3();
    this._tmpNormal = new THREE.Vector3();

    // Store jitter offsets per beam so they persist between frames
    this._jitterOffsets = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this._jitterOffsets.push(new Float32Array(SEGMENTS + 1));
    }
  }

  /**
   * @param {Tank} localTank
   * @param {Map} remoteTanks
   * @param {string} playerFaction
   * @param {number} dt
   */
  update(localTank, remoteTanks, playerFaction, dt) {
    this._jitterTimer += dt;
    const shouldJitter = this._jitterTimer >= this._jitterInterval;
    if (shouldJitter) this._jitterTimer = 0;

    // Hide all beams
    for (let i = 0; i < this.beams.length; i++) this.beams[i].mesh.visible = false;

    let beamIdx = 0;

    // Local player welding beams
    const isWelding = localTank.state.keys.tac &&
      window.weaponSlotSystem?.getActiveTacticalWeapon() === 'welding_gun' &&
      !localTank.isDead;

    if (isWelding) {
      localTank.group.getWorldPosition(this._tmpFrom);

      for (const [id, rt] of remoteTanks) {
        if (beamIdx >= this.beams.length) break;
        if (rt.isDead || rt.faction !== playerFaction) continue;
        if (rt.hp >= 100) continue;

        rt.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist > 20 || dist < 0.1) continue;

        this._updateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
        this.beams[beamIdx].mesh.visible = true;
        beamIdx++;
      }
    }

    // Remote player welding beams
    for (const [welderId, welder] of remoteTanks) {
      if (!welder.weldingActive || welder.isDead) continue;
      if (beamIdx >= this.beams.length) break;

      welder.group.getWorldPosition(this._tmpFrom);

      // Draw beams to nearby friendlies (other remote tanks + local tank)
      for (const [targetId, target] of remoteTanks) {
        if (beamIdx >= this.beams.length) break;
        if (targetId === welderId) continue;
        if (target.isDead || target.faction !== welder.faction) continue;
        if (target.hp >= 100) continue;

        target.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist > 20 || dist < 0.1) continue;

        this._updateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
        this.beams[beamIdx].mesh.visible = true;
        beamIdx++;
      }

      // Remote welder → local tank (if same faction, damaged, in range)
      if (welder.faction === playerFaction && !localTank.isDead && localTank.hp < 100) {
        localTank.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist <= 20 && dist > 0.1 && beamIdx < this.beams.length) {
          this._updateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
          this.beams[beamIdx].mesh.visible = true;
          beamIdx++;
        }
      }
    }

    this._activeCount = beamIdx;
  }

  _updateBeam(idx, from, to, jitter) {
    const beam = this.beams[idx];
    const positions = beam.geo.attributes.position.array;
    const uvs = beam.geo.attributes.uv.array;
    const segs = beam.segments;

    this._tmpDir.subVectors(to, from);
    const length = this._tmpDir.length();
    this._tmpDir.normalize();

    // Camera-facing perpendicular for billboard quad strip
    const cam = window.gameCamera?.camera;
    if (cam) {
      this._tmpCamDir.subVectors(cam.position, from).normalize();
    } else {
      this._tmpCamDir.set(0, 1, 0);
    }
    this._tmpPerp.crossVectors(this._tmpDir, this._tmpCamDir).normalize();

    const WIDTH = 0.4; // Half-width of beam

    // Regenerate jitter offsets
    const offsets = this._jitterOffsets[idx];
    if (jitter) {
      offsets[0] = 0; // No jitter at start
      offsets[segs] = 0; // No jitter at end
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        const jitterScale = Math.sin(t * Math.PI) * 1.5;
        offsets[s] = (Math.random() - 0.5) * 2 * jitterScale;
      }
    }

    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      this._tmpPoint.lerpVectors(from, to, t);

      // Apply lateral jitter
      if (s > 0 && s < segs) {
        this._tmpPoint.addScaledVector(this._tmpPerp, offsets[s]);
        // Also jitter along surface normal for 3D depth
        this._tmpNormal.copy(this._tmpPoint).normalize();
        this._tmpPoint.addScaledVector(this._tmpNormal, offsets[s] * 0.3);
      }

      const base = s * 2;
      // Top vertex (perp + WIDTH)
      positions[base * 3]     = this._tmpPoint.x + this._tmpPerp.x * WIDTH;
      positions[base * 3 + 1] = this._tmpPoint.y + this._tmpPerp.y * WIDTH;
      positions[base * 3 + 2] = this._tmpPoint.z + this._tmpPerp.z * WIDTH;
      uvs[base * 2] = t;
      uvs[base * 2 + 1] = 1;
      // Bottom vertex (perp - WIDTH)
      positions[(base + 1) * 3]     = this._tmpPoint.x - this._tmpPerp.x * WIDTH;
      positions[(base + 1) * 3 + 1] = this._tmpPoint.y - this._tmpPerp.y * WIDTH;
      positions[(base + 1) * 3 + 2] = this._tmpPoint.z - this._tmpPerp.z * WIDTH;
      uvs[(base + 1) * 2] = t;
      uvs[(base + 1) * 2 + 1] = 0;
    }

    beam.geo.attributes.position.needsUpdate = true;
    beam.geo.attributes.uv.needsUpdate = true;
  }

  dispose() {
    for (const b of this.beams) {
      this.scene.remove(b.mesh);
      b.geo.dispose();
      b.mat.dispose();
    }
    this.beams = [];
  }
}
