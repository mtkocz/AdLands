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

    /** @type {Array<{line: THREE.Line, geo: THREE.BufferGeometry}>} */
    this.beams = [];
    this._activeCount = 0;

    // Pre-allocate beam pool using THREE.Line (guaranteed continuous, no gaps)
    const POOL_SIZE = 10;
    const SEGMENTS = 12;

    const mat = new THREE.LineBasicMaterial({
      color: 0x00ffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    for (let i = 0; i < POOL_SIZE; i++) {
      const positions = new Float32Array((SEGMENTS + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const line = new THREE.Line(geo, mat);
      line.visible = false;
      line.renderOrder = 50;
      line.layers.enable(1); // BLOOM_LAYER
      line.frustumCulled = false;
      scene.add(line);

      this.beams.push({ line, geo, segments: SEGMENTS });
    }

    // Point light pool (one per beam, positioned at beam midpoint)
    this._lights = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(0x00ffff, 2, 15);
      light.visible = false;
      scene.add(light);
      this._lights.push(light);
    }

    // Temp vectors (avoid per-frame allocation)
    this._tmpFrom = new THREE.Vector3();
    this._tmpTo = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpPerp = new THREE.Vector3();
    this._tmpNormal = new THREE.Vector3();
    this._tmpPoint = new THREE.Vector3();
    this._tmpMid = new THREE.Vector3();

    // Store jitter offsets per beam — two axes for organic lightning
    this._jitterOffsetsA = [];
    this._jitterOffsetsB = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this._jitterOffsetsA.push(new Float32Array(SEGMENTS + 1));
      this._jitterOffsetsB.push(new Float32Array(SEGMENTS + 1));
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

    // Hide all beams and lights
    for (let i = 0; i < this.beams.length; i++) {
      this.beams[i].line.visible = false;
      this._lights[i].visible = false;
    }

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

        this._activateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
        beamIdx++;
      }
    }

    // Remote player welding beams
    for (const [welderId, welder] of remoteTanks) {
      if (!welder.weldingActive || welder.isDead) continue;
      if (beamIdx >= this.beams.length) break;

      welder.group.getWorldPosition(this._tmpFrom);

      for (const [targetId, target] of remoteTanks) {
        if (beamIdx >= this.beams.length) break;
        if (targetId === welderId) continue;
        if (target.isDead || target.faction !== welder.faction) continue;
        if (target.hp >= 100) continue;

        target.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist > 20 || dist < 0.1) continue;

        this._activateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
        beamIdx++;
      }

      // Remote welder → local tank (if same faction, damaged, in range)
      if (welder.faction === playerFaction && !localTank.isDead && localTank.hp < 100) {
        localTank.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist <= 20 && dist > 0.1 && beamIdx < this.beams.length) {
          this._activateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
          beamIdx++;
        }
      }
    }

    this._activeCount = beamIdx;
  }

  _activateBeam(idx, from, to, jitter) {
    this._updateBeamGeometry(idx, from, to, jitter);
    this.beams[idx].line.visible = true;

    // Position point light at beam midpoint
    const light = this._lights[idx];
    this._tmpMid.lerpVectors(from, to, 0.5);
    light.position.copy(this._tmpMid);
    light.visible = true;
  }

  _updateBeamGeometry(idx, from, to, jitter) {
    const beam = this.beams[idx];
    const positions = beam.geo.attributes.position.array;
    const segs = beam.segments;

    // Beam direction
    this._tmpDir.subVectors(to, from).normalize();

    // Two perpendicular axes for jitter
    // Use surface normal at midpoint as one reference
    this._tmpMid.lerpVectors(from, to, 0.5).normalize();
    this._tmpPerp.crossVectors(this._tmpDir, this._tmpMid);
    if (this._tmpPerp.lengthSq() < 0.001) {
      this._tmpPerp.set(0, 1, 0);
      this._tmpPerp.crossVectors(this._tmpDir, this._tmpPerp);
    }
    this._tmpPerp.normalize();
    this._tmpNormal.crossVectors(this._tmpDir, this._tmpPerp).normalize();

    // Regenerate jitter offsets
    const offsetsA = this._jitterOffsetsA[idx];
    const offsetsB = this._jitterOffsetsB[idx];
    if (jitter) {
      offsetsA[0] = 0; offsetsA[segs] = 0;
      offsetsB[0] = 0; offsetsB[segs] = 0;
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        const jitterScale = Math.sin(t * Math.PI) * 1.2;
        offsetsA[s] = (Math.random() - 0.5) * 2 * jitterScale;
        offsetsB[s] = (Math.random() - 0.5) * 2 * jitterScale;
      }
    }

    // Build line vertices — simple polyline, no gaps possible
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      this._tmpPoint.lerpVectors(from, to, t);

      if (s > 0 && s < segs) {
        this._tmpPoint.addScaledVector(this._tmpPerp, offsetsA[s]);
        this._tmpPoint.addScaledVector(this._tmpNormal, offsetsB[s]);
      }

      positions[s * 3]     = this._tmpPoint.x;
      positions[s * 3 + 1] = this._tmpPoint.y;
      positions[s * 3 + 2] = this._tmpPoint.z;
    }

    beam.geo.attributes.position.needsUpdate = true;
  }

  dispose() {
    for (const b of this.beams) {
      this.scene.remove(b.line);
      b.geo.dispose();
    }
    if (this.beams.length > 0) {
      this.beams[0].line.material.dispose();
    }
    for (const l of this._lights) {
      this.scene.remove(l);
      l.dispose();
    }
    this.beams = [];
    this._lights = [];
  }
}
