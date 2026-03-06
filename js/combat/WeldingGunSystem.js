/**
 * AdLands - Welding Gun System
 * Client-side visuals for the tactical welding gun.
 * Creates cyan lightning bolt beams between the welder and friendly tanks being healed,
 * with welding sparks and smoke at the target.
 */

class WeldingGunSystem {
  constructor(scene, sphereRadius) {
    this.scene = scene;
    this.R = sphereRadius;
    this._jitterTimer = 0;
    this._jitterInterval = 0.08;

    this.beams = [];
    this._activeCount = 0;

    const POOL_SIZE = 10;
    const SEGMENTS = 12;

    // Core bolt material — bright white, bloom makes it glow cyan
    const coreMat = new THREE.LineBasicMaterial({
      color: 0xccffff,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });

    for (let i = 0; i < POOL_SIZE; i++) {
      const positions = new Float32Array((SEGMENTS + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

      const line = new THREE.Line(geo, coreMat);
      line.visible = false;
      line.renderOrder = 50;
      line.layers.enable(1); // BLOOM_LAYER
      line.frustumCulled = false;
      scene.add(line);

      this.beams.push({ line, geo, segments: SEGMENTS });
    }

    // Point light pool
    this._lights = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(0x00ffff, 3, 20);
      light.visible = false;
      scene.add(light);
      this._lights.push(light);
    }

    // ---- Welding spark particles ----
    const MAX_SPARKS = 200;
    this._sparkPositions = new Float32Array(MAX_SPARKS * 3);
    this._sparkVelocities = new Float32Array(MAX_SPARKS * 3);
    this._sparkAges = new Float32Array(MAX_SPARKS);
    this._sparkLifetimes = new Float32Array(MAX_SPARKS);
    this._sparkSizes = new Float32Array(MAX_SPARKS);
    this._sparkAlive = 0;
    this._maxSparks = MAX_SPARKS;
    this._sparkHead = 0;

    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(this._sparkPositions, 3));
    sparkGeo.setAttribute('aAge', new THREE.BufferAttribute(this._sparkAges, 1));
    sparkGeo.setAttribute('aLifetime', new THREE.BufferAttribute(this._sparkLifetimes, 1));
    sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(this._sparkSizes, 1));

    const sparkMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: [
        'attribute float aAge;',
        'attribute float aLifetime;',
        'attribute float aSize;',
        'varying float vAlpha;',
        'void main() {',
        '  float life = aAge / aLifetime;',
        '  vAlpha = life < 1.0 ? (1.0 - life) : 0.0;',
        '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = aSize * (200.0 / -mvPos.z) * vAlpha;',
        '  gl_Position = projectionMatrix * mvPos;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'varying float vAlpha;',
        'void main() {',
        '  if (vAlpha < 0.01) discard;',
        '  float d = length(gl_PointCoord - 0.5) * 2.0;',
        '  if (d > 1.0) discard;',
        '  float bright = 1.0 - d * d;',
        // Orange-yellow core fading to red
        '  vec3 col = mix(vec3(1.0, 0.3, 0.05), vec3(1.0, 0.9, 0.5), bright);',
        '  gl_FragColor = vec4(col, vAlpha * bright);',
        '}',
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });

    this._sparkPoints = new THREE.Points(sparkGeo, sparkMat);
    this._sparkPoints.frustumCulled = false;
    this._sparkPoints.layers.enable(1);
    scene.add(this._sparkPoints);
    this._sparkGeo = sparkGeo;

    // ---- Smoke particles ----
    const MAX_SMOKE = 60;
    this._smokePositions = new Float32Array(MAX_SMOKE * 3);
    this._smokeVelocities = new Float32Array(MAX_SMOKE * 3);
    this._smokeAges = new Float32Array(MAX_SMOKE);
    this._smokeLifetimes = new Float32Array(MAX_SMOKE);
    this._smokeSizes = new Float32Array(MAX_SMOKE);
    this._maxSmoke = MAX_SMOKE;
    this._smokeHead = 0;

    const smokeGeo = new THREE.BufferGeometry();
    smokeGeo.setAttribute('position', new THREE.BufferAttribute(this._smokePositions, 3));
    smokeGeo.setAttribute('aAge', new THREE.BufferAttribute(this._smokeAges, 1));
    smokeGeo.setAttribute('aLifetime', new THREE.BufferAttribute(this._smokeLifetimes, 1));
    smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(this._smokeSizes, 1));

    const smokeMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: [
        'attribute float aAge;',
        'attribute float aLifetime;',
        'attribute float aSize;',
        'varying float vAlpha;',
        'void main() {',
        '  float life = aAge / aLifetime;',
        '  vAlpha = life < 1.0 ? (1.0 - life * life) * 0.3 : 0.0;',
        '  float grow = 1.0 + life * 2.0;',
        '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = aSize * grow * (200.0 / -mvPos.z);',
        '  gl_Position = projectionMatrix * mvPos;',
        '}',
      ].join('\n'),
      fragmentShader: [
        'varying float vAlpha;',
        'void main() {',
        '  if (vAlpha < 0.01) discard;',
        '  float d = length(gl_PointCoord - 0.5) * 2.0;',
        '  if (d > 1.0) discard;',
        '  float soft = 1.0 - d * d;',
        '  gl_FragColor = vec4(0.5, 0.5, 0.5, vAlpha * soft);',
        '}',
      ].join('\n'),
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });

    this._smokePoints = new THREE.Points(smokeGeo, smokeMat);
    this._smokePoints.frustumCulled = false;
    scene.add(this._smokePoints);
    this._smokeGeo = smokeGeo;

    // Temp vectors
    this._tmpFrom = new THREE.Vector3();
    this._tmpTo = new THREE.Vector3();
    this._tmpDir = new THREE.Vector3();
    this._tmpPerp = new THREE.Vector3();
    this._tmpNormal = new THREE.Vector3();
    this._tmpPoint = new THREE.Vector3();
    this._tmpMid = new THREE.Vector3();
    this._tmpVel = new THREE.Vector3();

    // Jitter offsets
    this._jitterOffsetsA = [];
    this._jitterOffsetsB = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this._jitterOffsetsA.push(new Float32Array(SEGMENTS + 1));
      this._jitterOffsetsB.push(new Float32Array(SEGMENTS + 1));
    }

    // Accumulator for spark emission rate
    this._sparkAccum = 0;
    this._smokeAccum = 0;
  }

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
    const targetPositions = []; // Collect target positions for spark emission

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
        targetPositions.push(this._tmpTo.clone());
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
        targetPositions.push(this._tmpTo.clone());
        beamIdx++;
      }

      if (welder.faction === playerFaction && !localTank.isDead && localTank.hp < 100) {
        localTank.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist <= 20 && dist > 0.1 && beamIdx < this.beams.length) {
          this._activateBeam(beamIdx, this._tmpFrom, this._tmpTo, shouldJitter);
          targetPositions.push(this._tmpTo.clone());
          beamIdx++;
        }
      }
    }

    this._activeCount = beamIdx;

    // Emit sparks and smoke at each target position
    this._sparkAccum += dt * 80 * targetPositions.length; // ~80 sparks/sec per target
    this._smokeAccum += dt * 6 * targetPositions.length;  // ~6 smoke/sec per target
    while (this._sparkAccum >= 1 && targetPositions.length > 0) {
      const pos = targetPositions[Math.floor(Math.random() * targetPositions.length)];
      this._emitSpark(pos);
      this._sparkAccum--;
    }
    while (this._smokeAccum >= 1 && targetPositions.length > 0) {
      const pos = targetPositions[Math.floor(Math.random() * targetPositions.length)];
      this._emitSmoke(pos);
      this._smokeAccum--;
    }
    if (targetPositions.length === 0) {
      this._sparkAccum = 0;
      this._smokeAccum = 0;
    }

    // Update spark particles
    this._updateSparks(dt);
    this._updateSmoke(dt);
  }

  _activateBeam(idx, from, to, jitter) {
    this._updateBeamGeometry(idx, from, to, jitter);
    this.beams[idx].line.visible = true;

    const light = this._lights[idx];
    this._tmpMid.lerpVectors(from, to, 0.5);
    light.position.copy(this._tmpMid);
    light.visible = true;
  }

  _updateBeamGeometry(idx, from, to, jitter) {
    const beam = this.beams[idx];
    const positions = beam.geo.attributes.position.array;
    const segs = beam.segments;

    this._tmpDir.subVectors(to, from).normalize();

    this._tmpMid.lerpVectors(from, to, 0.5).normalize();
    this._tmpPerp.crossVectors(this._tmpDir, this._tmpMid);
    if (this._tmpPerp.lengthSq() < 0.001) {
      this._tmpPerp.set(0, 1, 0);
      this._tmpPerp.crossVectors(this._tmpDir, this._tmpPerp);
    }
    this._tmpPerp.normalize();
    this._tmpNormal.crossVectors(this._tmpDir, this._tmpPerp).normalize();

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

  // ---- Spark particles ----

  _emitSpark(targetPos) {
    const i = this._sparkHead;
    this._sparkHead = (this._sparkHead + 1) % this._maxSparks;

    // Position at target with slight random offset
    const surfNormal = this._tmpVel.copy(targetPos).normalize();
    this._sparkPositions[i * 3]     = targetPos.x + (Math.random() - 0.5) * 1.5;
    this._sparkPositions[i * 3 + 1] = targetPos.y + (Math.random() - 0.5) * 1.5;
    this._sparkPositions[i * 3 + 2] = targetPos.z + (Math.random() - 0.5) * 1.5;

    // Velocity: outward from surface + random spread
    const speed = 3 + Math.random() * 8;
    this._sparkVelocities[i * 3]     = surfNormal.x * speed + (Math.random() - 0.5) * 6;
    this._sparkVelocities[i * 3 + 1] = surfNormal.y * speed + (Math.random() - 0.5) * 6;
    this._sparkVelocities[i * 3 + 2] = surfNormal.z * speed + (Math.random() - 0.5) * 6;

    this._sparkAges[i] = 0;
    this._sparkLifetimes[i] = 0.2 + Math.random() * 0.4;
    this._sparkSizes[i] = 0.3 + Math.random() * 0.5;
  }

  _updateSparks(dt) {
    for (let i = 0; i < this._maxSparks; i++) {
      if (this._sparkAges[i] >= this._sparkLifetimes[i]) continue;
      this._sparkAges[i] += dt;

      // Apply velocity with drag
      const drag = 0.96;
      this._sparkPositions[i * 3]     += this._sparkVelocities[i * 3] * dt;
      this._sparkPositions[i * 3 + 1] += this._sparkVelocities[i * 3 + 1] * dt;
      this._sparkPositions[i * 3 + 2] += this._sparkVelocities[i * 3 + 2] * dt;
      this._sparkVelocities[i * 3]     *= drag;
      this._sparkVelocities[i * 3 + 1] *= drag;
      this._sparkVelocities[i * 3 + 2] *= drag;
    }

    this._sparkGeo.attributes.position.needsUpdate = true;
    this._sparkGeo.attributes.aAge.needsUpdate = true;
  }

  // ---- Smoke particles ----

  _emitSmoke(targetPos) {
    const i = this._smokeHead;
    this._smokeHead = (this._smokeHead + 1) % this._maxSmoke;

    const surfNormal = this._tmpVel.copy(targetPos).normalize();
    this._smokePositions[i * 3]     = targetPos.x + (Math.random() - 0.5) * 0.5;
    this._smokePositions[i * 3 + 1] = targetPos.y + (Math.random() - 0.5) * 0.5;
    this._smokePositions[i * 3 + 2] = targetPos.z + (Math.random() - 0.5) * 0.5;

    const speed = 1 + Math.random() * 2;
    this._smokeVelocities[i * 3]     = surfNormal.x * speed + (Math.random() - 0.5) * 1;
    this._smokeVelocities[i * 3 + 1] = surfNormal.y * speed + (Math.random() - 0.5) * 1;
    this._smokeVelocities[i * 3 + 2] = surfNormal.z * speed + (Math.random() - 0.5) * 1;

    this._smokeAges[i] = 0;
    this._smokeLifetimes[i] = 0.5 + Math.random() * 0.8;
    this._smokeSizes[i] = 1.0 + Math.random() * 1.5;
  }

  _updateSmoke(dt) {
    for (let i = 0; i < this._maxSmoke; i++) {
      if (this._smokeAges[i] >= this._smokeLifetimes[i]) continue;
      this._smokeAges[i] += dt;

      this._smokePositions[i * 3]     += this._smokeVelocities[i * 3] * dt;
      this._smokePositions[i * 3 + 1] += this._smokeVelocities[i * 3 + 1] * dt;
      this._smokePositions[i * 3 + 2] += this._smokeVelocities[i * 3 + 2] * dt;
      this._smokeVelocities[i * 3]     *= 0.98;
      this._smokeVelocities[i * 3 + 1] *= 0.98;
      this._smokeVelocities[i * 3 + 2] *= 0.98;
    }

    this._smokeGeo.attributes.position.needsUpdate = true;
    this._smokeGeo.attributes.aAge.needsUpdate = true;
  }

  dispose() {
    for (const b of this.beams) {
      this.scene.remove(b.line);
      b.geo.dispose();
    }
    if (this.beams.length > 0) this.beams[0].line.material.dispose();
    for (const l of this._lights) {
      this.scene.remove(l);
      l.dispose();
    }
    this.scene.remove(this._sparkPoints);
    this._sparkGeo.dispose();
    this._sparkPoints.material.dispose();
    this.scene.remove(this._smokePoints);
    this._smokeGeo.dispose();
    this._smokePoints.material.dispose();
    this.beams = [];
    this._lights = [];
  }
}
