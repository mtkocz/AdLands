/**
 * TankHeadlights — 2 forward-facing ground-plane headlights per tank.
 * Uses headlight.png alpha map with additive-blended emissive material
 * tinted slightly toward faction color. Night-only (terminator-aware).
 * Flicker state machine: startup burst, hit flicker, low-HP instability.
 */

const HEADLIGHT_FLICKER = {
  // Startup (day→night transition)
  STARTUP_DURATION: 0.5,
  STARTUP_TOGGLE_MIN: 0.04,
  STARTUP_TOGGLE_MAX: 0.12,
  // Damage hit (soft dim pulse)
  HIT_DURATION: 0.4,
  HIT_DIM_DEPTH: 0.25, // minimum brightness (0 = off, 1 = full)
  // Low HP instability (smooth dim-to-zero-and-back)
  UNSTABLE_DIM_MIN: 0.12,
  UNSTABLE_DIM_MAX: 0.25,
  INSTABILITY_CHANCE_50: 0.006, // per frame below 50% HP (~once/2.8s at 60fps)
  INSTABILITY_CHANCE_25: 0.024, // per frame below 25% HP (~once/0.7s at 60fps)
  // SpotLight params (player tank only)
  SPOT_INTENSITY: 2.0,
  SPOT_DISTANCE: 22,
  SPOT_ANGLE: 0.22, // ~12.5° half-angle, matches sprite cone
  SPOT_PENUMBRA: 0.6,
  // Camera distance fade (surface distance in units)
  FADE_THRESHOLD: 260,
  FADE_RANGE: 40, // smooth fade zone (240–280 from surface)
};

function _randomRange(min, max) {
  return min + Math.random() * (max - min);
}

class TankHeadlights {
  constructor() {
    this._tanks = new Map();
    this._materials = {};    // factionName → bright MeshBasicMaterial
    this._geometry = null;
    this._texture = null;
    this._textureLoaded = false;
    this._lightConfig = null;
    this._sphereRadius = 480;
    this._currentOpacity = 1;
    this._tempVec = new THREE.Vector3();

    this._initGeometry();
    this._loadTexture();
    this._initMaterials();
  }

  _initGeometry() {
    this._geometry = new THREE.PlaneGeometry(6.75, 15.75);
  }

  _loadTexture() {
    const loader = new THREE.TextureLoader();
    loader.load(
      "assets/sprites/headlight.png",
      (tex) => {
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        this._texture = tex;
        this._textureLoaded = true;
        for (const key in this._materials) {
          this._materials[key].alphaMap = tex;
          this._materials[key].needsUpdate = true;
        }
        // Also update per-tank cloned materials
        this._tanks.forEach((data) => {
          data.ownMaterial.alphaMap = tex;
          data.ownMaterial.needsUpdate = true;
        });
      },
      undefined,
      (err) => {
        console.warn("TankHeadlights: failed to load headlight.png", err);
      },
    );
  }

  _initMaterials() {
    const factions = {
      rust: 0x8a4444,
      cobalt: 0x395287,
      viridian: 0x627941,
    };
    for (const [name, hex] of Object.entries(factions)) {
      const color = new THREE.Color(1, 1, 1);
      color.lerp(new THREE.Color(hex), 0.35);
      this._materials[name] = new THREE.MeshBasicMaterial({
        color,
        alphaMap: this._texture,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
      });
    }
  }

  setLightingConfig(config) {
    this._lightConfig = config;
  }

  setSphereRadius(r) {
    this._sphereRadius = r;
  }

  registerTank(id, group, faction, entity = null, options = {}) {
    const mat = this._materials[faction];
    if (!mat) return;

    // Per-tank material clone for independent smooth dimming
    const ownMat = mat.clone();
    const baseColor = mat.color.clone();

    const meshL = new THREE.Mesh(this._geometry, ownMat);
    const meshR = new THREE.Mesh(this._geometry, ownMat);

    const splay = (5 * Math.PI) / 180;
    meshL.rotation.order = "YXZ";
    meshL.rotation.set(-Math.PI / 2, splay, 0);
    meshR.rotation.order = "YXZ";
    meshR.rotation.set(-Math.PI / 2, -splay, 0);

    meshL.position.set(-1.4, 0.25, -10.4);
    meshR.position.set(1.4, 0.25, -10.4);

    meshL.castShadow = false;
    meshL.receiveShadow = false;
    meshR.castShadow = false;
    meshR.receiveShadow = false;

    // Render after cluster overlays (1) and border glows (2)
    // so additive blend adds on top of final composited terrain
    meshL.renderOrder = 3;
    meshR.renderOrder = 3;

    meshL.visible = false;
    meshR.visible = false;

    meshL.userData.isHeadlight = true;
    meshR.userData.isHeadlight = true;

    group.add(meshL);
    group.add(meshR);

    // Optional real SpotLights (player tank only — expensive)
    let spotL = null;
    let spotR = null;
    if (options.spotLights) {
      const F = HEADLIGHT_FLICKER;
      const spotColor = mat.color.clone();

      spotL = new THREE.SpotLight(
        spotColor,
        F.SPOT_INTENSITY,
        F.SPOT_DISTANCE,
        F.SPOT_ANGLE,
        F.SPOT_PENUMBRA,
      );
      spotR = new THREE.SpotLight(
        spotColor,
        F.SPOT_INTENSITY,
        F.SPOT_DISTANCE,
        F.SPOT_ANGLE,
        F.SPOT_PENUMBRA,
      );

      // Position at hull front, slightly above hull surface
      spotL.position.set(-1.4, 0.6, -2.5);
      spotR.position.set(1.4, 0.6, -2.5);

      // Targets forward with matching 5° outward splay
      const splayOffset = 15 * Math.tan(splay); // ~1.3 at distance 15
      spotL.target.position.set(-1.4 - splayOffset, 0, -17);
      spotR.target.position.set(1.4 + splayOffset, 0, -17);

      spotL.castShadow = false;
      spotR.castShadow = false;
      spotL.visible = false;
      spotR.visible = false;

      // Layer 1: spotlights only illuminate objects that opt in (not hex ground)
      spotL.layers.set(1);
      spotR.layers.set(1);

      // Attach spotlights to bodyGroup so they lean with the tank body
      const spotParent = options.bodyGroup || group;
      spotParent.add(spotL);
      spotParent.add(spotL.target);
      spotParent.add(spotR);
      spotParent.add(spotR.target);
    }

    this._tanks.set(id, {
      group,
      faction,
      meshL,
      meshR,
      spotL,
      spotR,
      entity,
      ownMaterial: ownMat,
      baseColor,
      hasSpots: !!options.spotLights,
      // Flicker state machine
      flickerState: "off",
      flickerTimer: 0,
      flickerDuration: 0,
      flickerToggleTimer: 0,
      flickerOn: false,
      hitElapsed: 0,
      lastKnownHP: entity ? entity.hp : 100,
      wasNight: false,
      wasAlive: entity ? !entity.isDead : true,
    });
  }

  unregisterTank(id) {
    const data = this._tanks.get(id);
    if (!data) return;
    data.group.remove(data.meshL);
    data.group.remove(data.meshR);
    if (data.spotL) {
      data.group.remove(data.spotL);
      data.group.remove(data.spotL.target);
      data.group.remove(data.spotR);
      data.group.remove(data.spotR.target);
    }
    this._tanks.delete(id);
  }

  updateFaction(id, faction) {
    const data = this._tanks.get(id);
    if (!data) return;
    const mat = this._materials[faction];
    if (!mat) return;
    data.faction = faction;
    data.baseColor.copy(mat.color);
    data.ownMaterial.color.copy(mat.color);
    if (data.spotL) {
      data.spotL.color.copy(mat.color);
      data.spotR.color.copy(mat.color);
    }
  }

  _syncSpots(data, visible, intensity = 1) {
    if (!data.spotL) return;
    data.spotL.visible = visible;
    data.spotR.visible = visible;
    if (visible) {
      const full = HEADLIGHT_FLICKER.SPOT_INTENSITY * this._currentOpacity;
      data.spotL.intensity = full * intensity;
      data.spotR.intensity = full * intensity;
    }
  }

  update(deltaTime, camera) {
    if (!this._lightConfig) return;

    const sunDir = this._lightConfig.sun.direction;
    const tmp = this._tempVec;
    const F = HEADLIGHT_FLICKER;

    // Camera distance fade — smooth opacity around the 260-unit surface threshold
    let targetOpacity = 1;
    if (camera) {
      const surfaceDist = camera.position.length() - this._sphereRadius;
      const fadeStart = F.FADE_THRESHOLD - F.FADE_RANGE * 0.5; // 240
      const fadeEnd = F.FADE_THRESHOLD + F.FADE_RANGE * 0.5;   // 280
      targetOpacity = 1 - Math.max(0, Math.min(1, (surfaceDist - fadeStart) / (fadeEnd - fadeStart)));
    }
    // Smooth lerp toward target (avoid pop)
    this._currentOpacity += (targetOpacity - this._currentOpacity) * Math.min(deltaTime * 6, 1);
    // Apply to shared materials (per-tank clones synced in loop below)
    for (const key in this._materials) {
      this._materials[key].opacity = this._currentOpacity;
    }

    this._tanks.forEach((data) => {
      const { group, meshL, meshR, entity } = data;

      // Skip if tank group hidden (backface / frustum culled)
      if (!group.visible) {
        meshL.visible = false;
        meshR.visible = false;
        this._syncSpots(data, false);
        return;
      }

      // Hull visibility as LOD proxy
      const hull = group.children[0];
      if (!hull || !hull.visible) {
        meshL.visible = false;
        meshR.visible = false;
        this._syncSpots(data, false);
        return;
      }

      // Death check
      const isDead = entity ? entity.isDead : false;
      if (isDead) {
        meshL.visible = false;
        meshR.visible = false;
        this._syncSpots(data, false);
        data.flickerState = "off";
        data.wasAlive = false;
        return;
      }

      // Detect respawn (was dead, now alive) — reset HP tracking
      if (!data.wasAlive) {
        data.wasAlive = true;
        if (entity) data.lastKnownHP = entity.hp;
      }

      // Terminator check
      group.getWorldPosition(tmp);
      tmp.normalize();
      const sunDot = tmp.dot(sunDir);
      const isNight = sunDot < 0.1;

      // Day→night transition: flicker to life
      if (isNight && !data.wasNight) {
        data.flickerState = "starting";
        data.flickerTimer = F.STARTUP_DURATION;
        data.flickerToggleTimer = _randomRange(
          F.STARTUP_TOGGLE_MIN,
          F.STARTUP_TOGGLE_MAX,
        );
        data.flickerOn = false;
      }

      // Not night: off
      if (!isNight) {
        meshL.visible = false;
        meshR.visible = false;
        this._syncSpots(data, false);
        data.flickerState = "off";
        data.wasNight = false;
        return;
      }
      data.wasNight = true;

      // Detect HP drop → hit dim pulse (only when in 'on' state)
      if (entity && data.flickerState === "on") {
        const currentHP = entity.hp;
        if (currentHP < data.lastKnownHP) {
          data.flickerState = "hit";
          data.flickerTimer = F.HIT_DURATION;
          data.hitElapsed = 0;
        }
        data.lastKnownHP = currentHP;
      } else if (entity) {
        data.lastKnownHP = entity.hp;
      }

      // State machine tick
      switch (data.flickerState) {
        case "off":
          meshL.visible = false;
          meshR.visible = false;
          this._syncSpots(data, false);
          break;

        case "starting":
          data.flickerTimer -= deltaTime;
          data.flickerToggleTimer -= deltaTime;
          if (data.flickerToggleTimer <= 0) {
            data.flickerOn = !data.flickerOn;
            data.flickerToggleTimer = _randomRange(
              F.STARTUP_TOGGLE_MIN,
              F.STARTUP_TOGGLE_MAX,
            );
          }
          meshL.visible = data.flickerOn;
          meshR.visible = data.flickerOn;
          this._syncSpots(data, data.flickerOn);
          if (data.flickerTimer <= 0) {
            data.flickerState = "on";
          }
          break;

        case "on":
          meshL.visible = true;
          meshR.visible = true;
          data.ownMaterial.color.copy(data.baseColor);
          this._syncSpots(data, true);
          // Low HP instability
          if (entity) {
            const hpRatio = entity.hp / entity.maxHp;
            let chance = 0;
            if (hpRatio <= 0.25) {
              chance = F.INSTABILITY_CHANCE_25;
            } else if (hpRatio <= 0.5) {
              chance = F.INSTABILITY_CHANCE_50;
            }
            if (chance > 0 && Math.random() < chance) {
              data.flickerState = "unstable";
              const dur = _randomRange(F.UNSTABLE_DIM_MIN, F.UNSTABLE_DIM_MAX);
              data.flickerTimer = dur;
              data.flickerDuration = dur;
              // Random depth: 0 = full blackout, 0.7 = barely noticeable dip
              data.flickerDepth = Math.random() * 0.7;
            }
          }
          break;

        case "hit": {
          data.flickerTimer -= deltaTime;
          data.hitElapsed += deltaTime;
          meshL.visible = true;
          meshR.visible = true;
          // Smooth cosine pulse: 2 dips from full to HIT_DIM_DEPTH and back
          const t = data.hitElapsed / F.HIT_DURATION;
          const wave = 0.5 + 0.5 * Math.cos(t * Math.PI * 4);
          const brightness = F.HIT_DIM_DEPTH + (1 - F.HIT_DIM_DEPTH) * wave;
          data.ownMaterial.color.copy(data.baseColor).multiplyScalar(brightness);
          this._syncSpots(data, true, brightness);
          if (data.flickerTimer <= 0) {
            data.flickerState = "on";
            data.ownMaterial.color.copy(data.baseColor);
            this._syncSpots(data, true);
          }
          break;
        }

        case "unstable": {
          data.flickerTimer -= deltaTime;
          meshL.visible = true;
          meshR.visible = true;
          // Smooth cosine dip: 1 → flickerDepth → 1 over the full duration
          const uT = 1 - data.flickerTimer / data.flickerDuration;
          const wave = 0.5 + 0.5 * Math.cos(uT * 2 * Math.PI);
          const uBrightness = data.flickerDepth + (1 - data.flickerDepth) * wave;
          data.ownMaterial.color.copy(data.baseColor).multiplyScalar(uBrightness);
          this._syncSpots(data, true, uBrightness);
          if (data.flickerTimer <= 0) {
            data.flickerState = "on";
            data.ownMaterial.color.copy(data.baseColor);
            this._syncSpots(data, true);
          }
          break;
        }
      }

      // Sync per-tank material opacity with camera fade
      data.ownMaterial.opacity = this._currentOpacity;

      // Stretch/compress headlight sprites based on pitch lean
      // Backward lean (nose up) → longer projection, forward lean (nose down) → shorter
      // Anchor at base (near tank) so only the far end moves
      const pitchAngle = entity?.state?.lean?.pitchAngle || 0;
      const scaleY = Math.max(0.5, Math.min(1.5, 1 + pitchAngle * 1.82));
      meshL.scale.y = scaleY;
      meshR.scale.y = scaleY;
      // Offset position to keep base fixed: baseZ = -10.4 + halfHeight(7.875) = -2.525
      const zOffset = -10.4 - 7.875 * (scaleY - 1);
      meshL.position.z = zOffset;
      meshR.position.z = zOffset;

    });
  }
}
