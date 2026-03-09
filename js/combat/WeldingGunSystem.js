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

    // Bolt half-width in world units
    this._boltHalfWidth = 0.175;

    // Billboard quad-strip material — gives actual width unlike THREE.Line
    const boltMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: [
        'attribute float aSide;',
        'varying float vSide;',
        'void main() {',
        '  vSide = aSide;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}',
      ].join('\n'),
      fragmentShader: [
        'varying float vSide;',
        'void main() {',
        '  float edge = 1.0 - abs(vSide);',
        '  float alpha = smoothstep(0.0, 0.4, edge);',
        '  vec3 col = mix(vec3(0.0, 0.8, 1.0), vec3(0.85, 1.0, 1.0), edge * edge);',
        '  gl_FragColor = vec4(col, alpha);',
        '}',
      ].join('\n'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    for (let i = 0; i < POOL_SIZE; i++) {
      // Quad strip: 2 verts per segment = (SEGMENTS+1)*2 verts, SEGMENTS*2 triangles
      const vertCount = (SEGMENTS + 1) * 2;
      const positions = new Float32Array(vertCount * 3);
      const sides = new Float32Array(vertCount); // -1 or +1 for edge fade
      for (let s = 0; s <= SEGMENTS; s++) {
        sides[s * 2] = -1;
        sides[s * 2 + 1] = 1;
      }

      // Index buffer for triangle strip as indexed triangles
      const indexCount = SEGMENTS * 6;
      const indices = new Uint16Array(indexCount);
      for (let s = 0; s < SEGMENTS; s++) {
        const base = s * 2;
        const ii = s * 6;
        indices[ii]     = base;
        indices[ii + 1] = base + 1;
        indices[ii + 2] = base + 2;
        indices[ii + 3] = base + 1;
        indices[ii + 4] = base + 3;
        indices[ii + 5] = base + 2;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));

      const mesh = new THREE.Mesh(geo, boltMat);
      mesh.visible = false;
      mesh.renderOrder = 50;
      mesh.layers.enable(1); // BLOOM_LAYER
      mesh.frustumCulled = false;
      scene.add(mesh);

      this.beams.push({ mesh, geo, segments: SEGMENTS, introT: 1, targetId: null });
    }

    // Point light pool — 1 light per beam at destination with strobe
    this._lights = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = new THREE.PointLight(0x99ccdd, 3, 15);
      light.visible = false;
      scene.add(light);
      this._lights.push(light);
    }

    // ---- Welding spark particles ----
    const MAX_SPARKS = 400;
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
        '  if (aLifetime <= 0.0) { gl_PointSize = 0.0; gl_Position = vec4(2.0,2.0,2.0,1.0); vAlpha = 0.0; return; }',
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
        // Hot white-yellow core fading to orange
        '  vec3 col = mix(vec3(1.0, 0.4, 0.05), vec3(1.0, 1.0, 0.8), bright);',
        '  gl_FragColor = vec4(col, vAlpha);',
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
        '  if (aLifetime <= 0.0) { gl_PointSize = 0.0; gl_Position = vec4(2.0,2.0,2.0,1.0); vAlpha = 0.0; return; }',
        '  float life = aAge / aLifetime;',
        '  vAlpha = life < 1.0 ? (1.0 - life * life) * 0.6 : 0.0;',
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
        '  gl_FragColor = vec4(0.7, 0.75, 0.8, vAlpha * soft);',
        '}',
      ].join('\n'),
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: false,
    });

    this._smokePoints = new THREE.Points(smokeGeo, smokeMat);
    this._smokePoints.frustumCulled = false;
    scene.add(this._smokePoints);
    this._smokeGeo = smokeGeo;

    // Tank silhouette edge offset (beam terminates at tank edge, not center)
    this._EDGE_OFFSET = 2.5;

    // Track which tanks are being healed this frame (for HP bar cyan flicker)
    this._healedTankIds = new Set();
    this._prevHealedTankIds = new Set();

    // Temp vectors
    this._tmpFrom = new THREE.Vector3();
    this._tmpTo = new THREE.Vector3();
    this._tmpToEdge = new THREE.Vector3();
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

    // Crypto award: track HP healed per target, emit floating numbers once/sec
    this._healCryptoAccum = {}; // targetId → { hp: accumulated, timer: seconds }
    this._CRYPTO_INTERVAL = 1.0; // seconds between floating number emissions
  }

  hideAll() {
    for (let i = 0; i < this.beams.length; i++) {
      this.beams[i].mesh.visible = false;
      this._lights[i].visible = false;
    }
  }

  update(localTank, remoteTanks, playerFaction, dt) {
    this._dt = dt;
    this._jitterTimer += dt;
    const shouldJitter = this._jitterTimer >= this._jitterInterval;
    if (shouldJitter) this._jitterTimer = 0;

    // Hide all beams and lights
    for (let i = 0; i < this.beams.length; i++) {
      this.beams[i].mesh.visible = false;
      this._lights[i].visible = false;
    }

    // Swap healed sets for diffing
    const tmp = this._prevHealedTankIds;
    this._prevHealedTankIds = this._healedTankIds;
    this._healedTankIds = tmp;
    this._healedTankIds.clear();

    let beamIdx = 0;
    const sparkTargets = []; // { pos, origin } pairs for spark emission

    // Local player welding beams
    const isWelding = localTank.state.keys.tac &&
      window.weaponSlotSystem?.getActiveTacticalWeapon() === 'welding_gun' &&
      !localTank.isDead;

    let localHealTargetCount = 0;
    const localHealTargetPositions = []; // { id, worldPos } for crypto floating numbers

    if (isWelding) {
      localTank.group.getWorldPosition(this._tmpFrom);

      for (const [id, rt] of remoteTanks) {
        if (beamIdx >= this.beams.length) break;
        if (rt.isDead || rt.faction !== playerFaction) continue;
        if (rt.hp >= 100) continue;

        rt.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist > 20 || dist < 0.1) continue;

        // Offset endpoint to tank silhouette edge
        this._tmpToEdge.copy(this._tmpTo).sub(this._tmpFrom).normalize()
          .multiplyScalar(-this._EDGE_OFFSET).add(this._tmpTo);

        this._activateBeam(beamIdx, this._tmpFrom, this._tmpToEdge, shouldJitter, id);
        sparkTargets.push({ pos: this._tmpToEdge.clone(), origin: this._tmpFrom.clone() });
        this._healedTankIds.add(id);
        localHealTargetPositions.push({ id, worldPos: this._tmpTo.clone() });
        localHealTargetCount++;
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

        this._tmpToEdge.copy(this._tmpTo).sub(this._tmpFrom).normalize()
          .multiplyScalar(-this._EDGE_OFFSET).add(this._tmpTo);

        this._activateBeam(beamIdx, this._tmpFrom, this._tmpToEdge, shouldJitter, targetId);
        sparkTargets.push({ pos: this._tmpToEdge.clone(), origin: this._tmpFrom.clone() });
        this._healedTankIds.add(targetId);
        beamIdx++;
      }

      if (welder.faction === playerFaction && !localTank.isDead && localTank.hp < 100) {
        localTank.group.getWorldPosition(this._tmpTo);
        const dist = this._tmpFrom.distanceTo(this._tmpTo);
        if (dist <= 20 && dist > 0.1 && beamIdx < this.beams.length) {
          this._tmpToEdge.copy(this._tmpTo).sub(this._tmpFrom).normalize()
            .multiplyScalar(-this._EDGE_OFFSET).add(this._tmpTo);
          this._activateBeam(beamIdx, this._tmpFrom, this._tmpToEdge, shouldJitter, "player");
          sparkTargets.push({ pos: this._tmpToEdge.clone(), origin: this._tmpFrom.clone() });
          this._healedTankIds.add("player");
          beamIdx++;
        }
      }
    }

    this._activeCount = beamIdx;

    // Reset targetId on unused beams so they re-animate next activation
    for (let i = beamIdx; i < this.beams.length; i++) {
      this.beams[i].targetId = null;
    }

    // Emit sparks and smoke at each target position
    this._sparkAccum += dt * 150 * sparkTargets.length; // ~150 sparks/sec per target
    this._smokeAccum += dt * 10 * sparkTargets.length;  // ~10 smoke/sec per target
    while (this._sparkAccum >= 1 && sparkTargets.length > 0) {
      const t = sparkTargets[Math.floor(Math.random() * sparkTargets.length)];
      this._emitSpark(t.pos, t.origin);
      this._sparkAccum--;
    }
    while (this._smokeAccum >= 1 && sparkTargets.length > 0) {
      const t = sparkTargets[Math.floor(Math.random() * sparkTargets.length)];
      this._emitSmoke(t.pos);
      this._smokeAccum--;
    }
    if (sparkTargets.length === 0) {
      this._sparkAccum = 0;
      this._smokeAccum = 0;
    }

    // Update spark particles
    this._updateSparks(dt);
    this._updateSmoke(dt);

    // Award crypto for healing (1 crypto per HP healed, floating number once/sec per target)
    this._updateHealCrypto(dt, localHealTargetCount, localHealTargetPositions);

    // Update HP bar cyan flicker via PlayerTags
    if (typeof playerTags !== 'undefined' && playerTags.setHealing) {
      // Enable/update flicker for all healed tanks (cyan brightness tracks HP)
      for (const id of this._healedTankIds) {
        playerTags.setHealing(id, true);
      }
      // Disable flicker for tanks no longer healed
      for (const id of this._prevHealedTankIds) {
        if (!this._healedTankIds.has(id)) {
          playerTags.setHealing(id, false);
        }
      }
    }
  }

  _activateBeam(idx, from, to, jitter, targetId) {
    const beam = this.beams[idx];

    // New target → reset intro animation
    if (beam.targetId !== targetId) {
      beam.introT = 0;
      beam.targetId = targetId;
    }
    // Advance intro (0→1 over ~100ms)
    if (beam.introT < 1) {
      beam.introT = Math.min(1, beam.introT + this._dt / 0.1);
    }

    this._updateBeamGeometry(idx, from, to, jitter, beam.introT);
    beam.mesh.visible = true;

    // Point light tracks bolt tip during intro, then stays at target
    const light = this._lights[idx];
    if (beam.introT < 1) {
      light.position.lerpVectors(from, to, beam.introT);
    } else {
      light.position.copy(to);
    }
    light.intensity = 1.5 + Math.random() * 4;
    light.visible = true;
  }

  _updateBeamGeometry(idx, from, to, jitter, introT = 1) {
    const beam = this.beams[idx];
    const positions = beam.geo.attributes.position.array;
    const segs = beam.segments;
    const hw = this._boltHalfWidth;

    this._tmpDir.subVectors(to, from).normalize();

    // Camera-facing perpendicular for billboard effect
    const cam = this.scene.getObjectByProperty('isCamera', true)
      || (window.camera && window.camera);
    if (cam) {
      this._tmpMid.copy(cam.position).sub(from).normalize();
    } else {
      this._tmpMid.lerpVectors(from, to, 0.5).normalize();
    }
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

    // Build quad-strip: 2 vertices per segment (left/right of center line)
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      if (t <= introT) {
        this._tmpPoint.lerpVectors(from, to, t);
        if (s > 0 && s < segs) {
          this._tmpPoint.addScaledVector(this._tmpNormal, offsetsA[s]);
          this._tmpPoint.addScaledVector(this._tmpPerp, offsetsB[s] * 0.3);
        }
      } else {
        // Collapse segments beyond intro progress to the current tip
        this._tmpPoint.lerpVectors(from, to, introT);
      }

      const vi = s * 2;
      // Left vertex
      positions[vi * 3]     = this._tmpPoint.x - this._tmpPerp.x * hw;
      positions[vi * 3 + 1] = this._tmpPoint.y - this._tmpPerp.y * hw;
      positions[vi * 3 + 2] = this._tmpPoint.z - this._tmpPerp.z * hw;
      // Right vertex
      positions[(vi + 1) * 3]     = this._tmpPoint.x + this._tmpPerp.x * hw;
      positions[(vi + 1) * 3 + 1] = this._tmpPoint.y + this._tmpPerp.y * hw;
      positions[(vi + 1) * 3 + 2] = this._tmpPoint.z + this._tmpPerp.z * hw;
    }

    beam.geo.attributes.position.needsUpdate = true;
  }

  // ---- Spark particles ----

  _emitSpark(targetPos, originPos) {
    const i = this._sparkHead;
    this._sparkHead = (this._sparkHead + 1) % this._maxSparks;

    // Position at target with tight random offset
    this._sparkPositions[i * 3]     = targetPos.x + (Math.random() - 0.5) * 0.8;
    this._sparkPositions[i * 3 + 1] = targetPos.y + (Math.random() - 0.5) * 0.8;
    this._sparkPositions[i * 3 + 2] = targetPos.z + (Math.random() - 0.5) * 0.8;

    // Direction towards beam origin (welder), plus surface-outward and random spread
    const toOrigin = this._tmpVel.copy(originPos).sub(targetPos).normalize();
    const surfNormal = this._tmpNormal.copy(targetPos).normalize();
    const speed = 5 + Math.random() * 12;
    // Bias 60% towards origin, 20% outward from surface, 20% random
    this._sparkVelocities[i * 3]     = (toOrigin.x * 0.6 + surfNormal.x * 0.2) * speed + (Math.random() - 0.5) * 6;
    this._sparkVelocities[i * 3 + 1] = (toOrigin.y * 0.6 + surfNormal.y * 0.2) * speed + (Math.random() - 0.5) * 6;
    this._sparkVelocities[i * 3 + 2] = (toOrigin.z * 0.6 + surfNormal.z * 0.2) * speed + (Math.random() - 0.5) * 6;

    this._sparkAges[i] = 0;
    this._sparkLifetimes[i] = 0.3 + Math.random() * 0.5;
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
    this._sparkGeo.attributes.aLifetime.needsUpdate = true;
    this._sparkGeo.attributes.aSize.needsUpdate = true;
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
    this._smokeGeo.attributes.aLifetime.needsUpdate = true;
    this._smokeGeo.attributes.aSize.needsUpdate = true;
  }

  _updateHealCrypto(dt, targetCount, targetPositions) {
    const crypto = window.cryptoSystem;
    if (!crypto) return;

    if (targetCount === 0) {
      // Healing ended — flush any remaining accumulated crypto
      for (const id in this._healCryptoAccum) {
        const acc = this._healCryptoAccum[id];
        const amount = Math.floor(acc.hp);
        if (amount > 0 && acc.lastWorldPos) {
          crypto.awardCrypto(amount, 'healing', acc.lastWorldPos);
        }
      }
      this._healCryptoAccum = {};
      return;
    }

    // 10 HP/sec total, split across targets → HP per target per second
    const hpPerTargetPerSec = 10 / targetCount;
    const activeIds = new Set();

    for (const { id, worldPos } of targetPositions) {
      activeIds.add(id);
      if (!this._healCryptoAccum[id]) {
        this._healCryptoAccum[id] = { hp: 0, timer: 0, lastWorldPos: null };
      }
      const acc = this._healCryptoAccum[id];
      acc.hp += hpPerTargetPerSec * dt;
      acc.timer += dt;
      acc.lastWorldPos = worldPos;

      if (acc.timer >= this._CRYPTO_INTERVAL) {
        const amount = Math.floor(acc.hp);
        if (amount > 0) {
          crypto.awardCrypto(amount, 'healing', worldPos);
        }
        acc.hp -= amount;
        acc.timer = 0;
      }
    }

    // Flush and clean up targets that left range
    for (const id in this._healCryptoAccum) {
      if (!activeIds.has(id)) {
        const acc = this._healCryptoAccum[id];
        const amount = Math.floor(acc.hp);
        if (amount > 0 && acc.lastWorldPos) {
          crypto.awardCrypto(amount, 'healing', acc.lastWorldPos);
        }
        delete this._healCryptoAccum[id];
      }
    }
  }

  dispose() {
    for (const b of this.beams) {
      this.scene.remove(b.mesh);
      b.geo.dispose();
    }
    if (this.beams.length > 0) this.beams[0].mesh.material.dispose();
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
