/**
 * AdLands - Server-side Bodyguard Manager
 * Manages AI-controlled bodyguard bots for commanders on the server.
 * All positions, HP, death are authoritative. Broadcasts to all clients.
 * No Three.js dependency — pure math.
 */

const { PLANET_ROTATION_SPEED, moveOnSphere } = require("./shared/physics");

const BODYGUARD_CONFIG = {
  count: 2,
  followDistance: 0.04, // Angular distance from commander (radians)
  maxLeashDistance: 0.08,
  formationAngle: Math.PI / 3, // 60° offset from commander heading
  names: ["Guard Alpha", "Guard Beta"],

  // GTA1-style vehicle physics (matches client CommanderBodyguards.js)
  maxSpeed: 0.00024,
  acceleration: 0.000028,
  deceleration: 0.000018,
  baseTurnRate: 0.038,
  minTurnRate: 0.01,
  turnSpeedFactor: 0.7,
  pivotOffset: 0.6,

  // Collision avoidance
  avoidDistance: 0.06,
  avoidAngle: Math.PI / 3,
  avoidStrength: 0.8,

  hp: 100,
};

// Terrain collision probe offsets (half-dimensions of bodyguard body)
const BG_HALF_LEN = 2.75;
const BG_HALF_WID = 1.5;
// Hit detection half-dimensions (oriented-box)
const BG_HIT_HALF_LEN = 3.5;
const BG_HIT_HALF_WID = 3.0;
const BG_HIT_QUICK_REJECT = 0.012; // radians

class BodyguardManager {
  constructor(sphereRadius, terrain, worldGen) {
    this.sphereRadius = sphereRadius;
    this.terrain = terrain;
    this.worldGen = worldGen;
    // bodyguardId → bodyguard state
    this.bodyguards = new Map();
    // faction → { commanderId, ticksRemaining }
    this._pendingRespawns = new Map();
  }

  // ========================
  // LIFECYCLE
  // ========================

  /**
   * Spawn 2 bodyguards for a commander.
   * @param {string} faction
   * @param {string} commanderId - socket ID of the commander
   * @param {Object} commanderState - { theta, phi, heading }
   */
  spawnForCommander(faction, commanderId, commanderState) {
    // DISABLED: commander guards are turned off for now
    return;

    // Remove any existing bodyguards for this faction first
    this.despawnForFaction(faction);

    for (let i = 0; i < BODYGUARD_CONFIG.count; i++) {
      const side = i === 0 ? "left" : "right";
      const id = `bg-${faction}-${i}`;

      // Calculate initial flank position behind commander
      const angleOffset =
        side === "left"
          ? -BODYGUARD_CONFIG.formationAngle
          : BODYGUARD_CONFIG.formationAngle;
      const flankAngle = commanderState.heading + angleOffset + Math.PI;
      const theta =
        commanderState.theta +
        Math.cos(flankAngle) * BODYGUARD_CONFIG.followDistance;
      const phi =
        commanderState.phi +
        Math.sin(flankAngle) * BODYGUARD_CONFIG.followDistance;

      this.bodyguards.set(id, {
        id,
        faction,
        commanderId,
        index: i,
        side,
        name: BODYGUARD_CONFIG.names[i],
        theta,
        phi,
        heading: commanderState.heading,
        speed: 0,
        hp: BODYGUARD_CONFIG.hp,
        maxHp: BODYGUARD_CONFIG.hp,
        isDead: false,
        keys: { w: false, a: false, s: false, d: false },
        targetTheta: theta,
        targetPhi: phi,
        wanderDirection: commanderState.heading,
      });
    }
  }

  /**
   * Remove all bodyguards for a faction (commander changed or disconnected).
   */
  despawnForFaction(faction) {
    for (const [id, bg] of this.bodyguards) {
      if (bg.faction === faction) {
        this.bodyguards.delete(id);
      }
    }
  }

  /**
   * Check if any bodyguards for a faction are dead (used for respawn detection).
   */
  hasDeadBodyguards(faction) {
    for (const [, bg] of this.bodyguards) {
      if (bg.faction === faction && bg.isDead) return true;
    }
    return false;
  }

  /**
   * Check if any bodyguards exist for a faction (alive or dead).
   */
  hasBodyguards(faction) {
    for (const [, bg] of this.bodyguards) {
      if (bg.faction === faction) return true;
    }
    return false;
  }

  /**
   * Mark all bodyguards for a faction as dead (commander died).
   */
  killAllForFaction(faction) {
    for (const [id, bg] of this.bodyguards) {
      if (bg.faction === faction && !bg.isDead) {
        bg.isDead = true;
        bg.speed = 0;
      }
    }
  }

  /**
   * Schedule a delayed respawn so the death state has time to broadcast.
   * @param {string} faction
   * @param {string} commanderId - socket ID of the new commander
   * @param {number} ticks - number of update ticks to wait before respawning
   */
  scheduleRespawn(faction, commanderId, ticks) {
    this._pendingRespawns.set(faction, { commanderId, ticksRemaining: ticks });
  }

  /**
   * Check if a faction has a pending respawn scheduled.
   */
  hasPendingRespawn(faction) {
    return this._pendingRespawns.has(faction);
  }

  // ========================
  // TICK UPDATE
  // ========================

  /**
   * Run AI + physics for all alive bodyguards.
   * @param {number} dt - seconds since last tick (fixed timestep)
   * @param {Map} players - socketId → player state (to look up commander position)
   * @param {number} planetRotation - current planet rotation
   */
  update(dt, players, planetRotation) {
    // Process pending respawns (delayed so death state broadcasts first)
    for (const [faction, pending] of this._pendingRespawns) {
      pending.ticksRemaining--;
      if (pending.ticksRemaining <= 0) {
        this._pendingRespawns.delete(faction);
        const commander = players.get(pending.commanderId);
        if (commander && !commander.isDead && !commander.waitingForPortal) {
          this.despawnForFaction(faction);
          this.spawnForCommander(faction, pending.commanderId, commander);
        }
      }
    }

    for (const [id, bg] of this.bodyguards) {
      if (bg.isDead) continue;

      const commander = players.get(bg.commanderId);
      if (!commander || commander.isDead || commander.waitingForPortal) {
        // Commander not available — hold position
        this._coastToStop(bg, dt);
        continue;
      }

      // 1. AI target: formation position behind commander
      this._updateTarget(bg, commander);

      // 2. Input simulation: set virtual keys
      this._updateInput(bg, commander);

      // 3. Physics: apply keys to heading and speed
      this._updatePhysics(bg, dt);

      // 4. Movement on sphere + terrain collision
      const prevTheta = bg.theta;
      const prevPhi = bg.phi;
      this._moveOnSphere(bg, dt);
      // Counter planet rotation (same as shared/physics.js moveOnSphere)
      const dt60 = dt * 60;
      bg.theta -= (PLANET_ROTATION_SPEED * dt60) / 60;
      if (bg.theta < 0) bg.theta += Math.PI * 2;

      // 5. Terrain collision with wall sliding
      if (this._checkTerrainCollision(bg, planetRotation)) {
        const newTheta = bg.theta;
        const newPhi = bg.phi;
        let thetaRev = prevTheta - (PLANET_ROTATION_SPEED * dt60) / 60;
        if (thetaRev < 0) thetaRev += Math.PI * 2;
        if (thetaRev >= Math.PI * 2) thetaRev -= Math.PI * 2;

        // Try theta-only slide (keep phi from before)
        bg.phi = prevPhi;
        if (!this._checkTerrainCollision(bg, planetRotation)) {
          bg.speed *= 0.85;
        } else {
          // Try phi-only slide (theta reverted, phi moved)
          bg.theta = thetaRev;
          bg.phi = newPhi;
          if (!this._checkTerrainCollision(bg, planetRotation)) {
            bg.speed *= 0.85;
          } else {
            // Both axes blocked — full revert
            bg.theta = thetaRev;
            bg.phi = prevPhi;
            bg.speed *= 0.3;
          }
        }
      }
    }
  }

  /**
   * Gradually slow a bodyguard to a stop.
   */
  _coastToStop(bg, dt) {
    const dt60 = dt * 60;
    if (bg.speed > 0) {
      bg.speed -= BODYGUARD_CONFIG.deceleration * dt60;
      if (bg.speed < 0) bg.speed = 0;
    } else if (bg.speed < 0) {
      bg.speed += BODYGUARD_CONFIG.deceleration * dt60;
      if (bg.speed > 0) bg.speed = 0;
    }
    if (bg.speed !== 0) {
      this._moveOnSphere(bg, dt);
      const dt60b = dt * 60;
      bg.theta -= (PLANET_ROTATION_SPEED * dt60b) / 60;
      if (bg.theta < 0) bg.theta += Math.PI * 2;
    } else {
      // Still counter planet rotation even when stopped
      const dt60b = dt * 60;
      bg.theta -= (PLANET_ROTATION_SPEED * dt60b) / 60;
      if (bg.theta < 0) bg.theta += Math.PI * 2;
    }
  }

  // ========================
  // AI TARGET
  // ========================

  /**
   * Calculate target formation position behind commander.
   * Port of CommanderBodyguards._updateGuardTarget
   */
  _updateTarget(bg, commander) {
    const angleOffset =
      bg.side === "left"
        ? -BODYGUARD_CONFIG.formationAngle
        : BODYGUARD_CONFIG.formationAngle;
    const flankAngle = commander.heading + angleOffset + Math.PI;

    bg.targetTheta =
      commander.theta + Math.cos(flankAngle) * BODYGUARD_CONFIG.followDistance;
    bg.targetPhi =
      commander.phi + Math.sin(flankAngle) * BODYGUARD_CONFIG.followDistance;

    // Calculate wander direction toward target
    const dTheta = bg.targetTheta - bg.theta;
    const dPhi = bg.targetPhi - bg.phi;
    bg.wanderDirection = Math.atan2(-dTheta, -dPhi);
  }

  // ========================
  // INPUT SIMULATION
  // ========================

  /**
   * Set virtual keys based on AI decisions.
   * Port of CommanderBodyguards._updateGuardInput
   */
  _updateInput(bg, commander) {
    bg.keys = { w: false, a: false, s: false, d: false };

    // Check for collision threats
    const avoidance = this._detectCollisionThreat(bg, commander);

    // Heading difference to target
    let headingDiff = bg.wanderDirection - bg.heading;
    while (headingDiff > Math.PI) headingDiff -= Math.PI * 2;
    while (headingDiff < -Math.PI) headingDiff += Math.PI * 2;

    const steerDeadZone = 0.05;
    const driveAngleLimit = 0.4;

    // Distance to target
    const dTheta = bg.targetTheta - bg.theta;
    const dPhi = bg.targetPhi - bg.phi;
    const distToTarget = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    if (avoidance.threat > 0.1) {
      // Steer away from threat
      if (avoidance.steerDirection > 0) {
        bg.keys.d = true;
      } else {
        bg.keys.a = true;
      }

      if (avoidance.threat > 0.5) {
        if (bg.speed > BODYGUARD_CONFIG.maxSpeed * 0.2) {
          bg.keys.s = true;
        }
      } else if (avoidance.threat > 0.3) {
        // Coast
      } else {
        if (Math.abs(headingDiff) < driveAngleLimit * 1.5) {
          bg.keys.w = true;
        }
      }
    } else {
      // Normal steering toward target
      if (headingDiff > steerDeadZone) {
        bg.keys.d = true;
      } else if (headingDiff < -steerDeadZone) {
        bg.keys.a = true;
      }

      if (distToTarget < 0.008) {
        // Very close — match commander heading
        bg.wanderDirection = commander.heading;
      } else if (Math.abs(headingDiff) < driveAngleLimit) {
        bg.keys.w = true;
      } else if (Math.abs(headingDiff) > Math.PI * 0.75) {
        if (bg.speed < BODYGUARD_CONFIG.maxSpeed * 0.3) {
          bg.keys.s = true;
        }
      }
    }
  }

  /**
   * Detect nearby tanks that pose a collision threat.
   * Port of CommanderBodyguards._detectCollisionThreat
   */
  _detectCollisionThreat(bg, commander) {
    let maxThreat = 0;
    let steerDirection = 0;

    const avoidDist = BODYGUARD_CONFIG.avoidDistance;
    const avoidAngle = BODYGUARD_CONFIG.avoidAngle;

    // Check other bodyguards
    for (const [, other] of this.bodyguards) {
      if (other === bg || other.isDead) continue;

      const threat = this._calculateThreat(
        bg.theta,
        bg.phi,
        bg.heading,
        other.theta,
        other.phi,
        avoidDist,
        avoidAngle
      );
      if (threat.level > maxThreat) {
        maxThreat = threat.level;
        steerDirection = threat.steerDirection;
      }
    }

    // Check commander
    if (commander) {
      const threat = this._calculateThreat(
        bg.theta,
        bg.phi,
        bg.heading,
        commander.theta,
        commander.phi,
        avoidDist * 0.7,
        avoidAngle
      );
      if (threat.level > maxThreat) {
        maxThreat = threat.level;
        steerDirection = threat.steerDirection;
      }
    }

    return {
      threat: maxThreat * BODYGUARD_CONFIG.avoidStrength,
      steerDirection,
    };
  }

  /**
   * Calculate threat level from a single obstacle.
   * Port of CommanderBodyguards._calculateThreat
   */
  _calculateThreat(
    guardTheta,
    guardPhi,
    guardHeading,
    obstacleTheta,
    obstaclePhi,
    avoidDist,
    avoidAngle
  ) {
    let dTheta = obstacleTheta - guardTheta;
    while (dTheta > Math.PI) dTheta -= Math.PI * 2;
    while (dTheta < -Math.PI) dTheta += Math.PI * 2;

    const dPhi = obstaclePhi - guardPhi;
    const angularDist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);

    if (angularDist > avoidDist) {
      return { level: 0, steerDirection: 0 };
    }

    const angleToObstacle = Math.atan2(-dTheta, -dPhi);
    let relativeAngle = angleToObstacle - guardHeading;
    while (relativeAngle > Math.PI) relativeAngle -= Math.PI * 2;
    while (relativeAngle < -Math.PI) relativeAngle += Math.PI * 2;

    if (Math.abs(relativeAngle) > avoidAngle) {
      return { level: 0, steerDirection: 0 };
    }

    const distanceFactor = 1 - angularDist / avoidDist;
    const angleFactor = 1 - Math.abs(relativeAngle) / avoidAngle;
    const threatLevel = distanceFactor * angleFactor;

    let steerDir;
    if (Math.abs(relativeAngle) < 0.1) {
      steerDir = dTheta > 0 ? -1 : 1;
    } else {
      steerDir = relativeAngle < 0 ? 1 : -1;
    }

    return { level: threatLevel, steerDirection: steerDir };
  }

  // ========================
  // PHYSICS
  // ========================

  /**
   * GTA1-style acceleration/steering from virtual keys.
   * Port of CommanderBodyguards._updateGuardPhysics
   */
  _updatePhysics(bg, dt) {
    const keys = bg.keys;
    const dt60 = dt * 60;

    // Speed-dependent steering
    const speedRatio = Math.abs(bg.speed) / BODYGUARD_CONFIG.maxSpeed;
    const turnReduction = speedRatio * BODYGUARD_CONFIG.turnSpeedFactor;
    const currentTurnRate =
      BODYGUARD_CONFIG.baseTurnRate * (1 - turnReduction) +
      BODYGUARD_CONFIG.minTurnRate * turnReduction;

    // Steering
    let steerInput = 0;
    if (keys.a) steerInput = -1;
    if (keys.d) steerInput = 1;

    if (steerInput !== 0) {
      const turnAmount = steerInput * currentTurnRate * dt60;
      const pivotMultiplier =
        1.0 + speedRatio * BODYGUARD_CONFIG.pivotOffset;
      bg.heading += turnAmount * pivotMultiplier;
    }

    // Normalize heading
    while (bg.heading < 0) bg.heading += Math.PI * 2;
    while (bg.heading >= Math.PI * 2) bg.heading -= Math.PI * 2;

    // Acceleration
    if (keys.w) {
      bg.speed += BODYGUARD_CONFIG.acceleration * dt60;
      if (bg.speed > BODYGUARD_CONFIG.maxSpeed) {
        bg.speed = BODYGUARD_CONFIG.maxSpeed;
      }
    } else if (keys.s) {
      if (bg.speed > 0) {
        bg.speed -= BODYGUARD_CONFIG.deceleration * 2.5 * dt60;
        if (bg.speed < 0) bg.speed = 0;
      } else {
        bg.speed -= BODYGUARD_CONFIG.acceleration * 0.6 * dt60;
        if (bg.speed < -BODYGUARD_CONFIG.maxSpeed * 0.5) {
          bg.speed = -BODYGUARD_CONFIG.maxSpeed * 0.5;
        }
      }
    } else {
      // Coast to stop
      if (bg.speed > 0) {
        bg.speed -= BODYGUARD_CONFIG.deceleration * dt60;
        if (bg.speed < 0) bg.speed = 0;
      } else if (bg.speed < 0) {
        bg.speed += BODYGUARD_CONFIG.deceleration * dt60;
        if (bg.speed > 0) bg.speed = 0;
      }
    }
  }

  // ========================
  // MOVEMENT
  // ========================

  /**
   * Move bodyguard on sphere surface.
   * Port of CommanderBodyguards._moveGuardOnSphere
   * NOTE: Does NOT counter planet rotation — caller handles that.
   */
  _moveOnSphere(bg, dt) {
    const speed = bg.speed;
    const heading = bg.heading;
    const phi = bg.phi;
    const dt60 = dt * 60;

    const velocityNorth = Math.cos(heading) * speed * dt60;
    const velocityEast = -Math.sin(heading) * speed * dt60;

    const sinPhi = Math.sin(phi);
    const safeSinPhi = Math.max(0.1, sinPhi);

    const dPhi = -velocityNorth;
    const dTheta = velocityEast / safeSinPhi;

    bg.phi += dPhi;
    bg.theta += dTheta;

    // Clamp phi (avoid poles)
    bg.phi = Math.max(0.25, Math.min(Math.PI - 0.25, bg.phi));

    // Wrap theta
    while (bg.theta > Math.PI * 2) bg.theta -= Math.PI * 2;
    while (bg.theta < 0) bg.theta += Math.PI * 2;
  }

  // ========================
  // TERRAIN COLLISION
  // ========================

  /**
   * Check if bodyguard overlaps elevated terrain.
   * Same 5-probe approach as GameRoom._gameTick player terrain collision.
   * @returns {boolean} true if blocked
   */
  _checkTerrainCollision(bg, planetRotation) {
    const R = this.sphereRadius;
    const sinPhi = Math.sin(bg.phi);
    const safeSinPhi =
      Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
    const dir = bg.speed > 0 ? 1 : bg.speed < 0 ? -1 : 0;
    const cosH = Math.cos(bg.heading);
    const sinH = Math.sin(bg.heading);

    // Forward/right unit vectors in (dPhi, dTheta) space
    const fwdPhi = -cosH;
    const fwdTh = -sinH / safeSinPhi;
    const rgtPhi = sinH;
    const rgtTh = -cosH / safeSinPhi;

    const probes = [
      [0, 0],
      [BG_HALF_LEN * dir, -BG_HALF_WID],
      [BG_HALF_LEN * dir, BG_HALF_WID],
      [-BG_HALF_LEN * dir, -BG_HALF_WID],
      [-BG_HALF_LEN * dir, BG_HALF_WID],
    ];

    for (const [fwd, rgt] of probes) {
      const pPhi = bg.phi + (fwdPhi * fwd + rgtPhi * rgt) / R;
      const pTh = bg.theta + (fwdTh * fwd + rgtTh * rgt) / R;
      if (this.worldGen.isTerrainBlocked(pTh + planetRotation, pPhi)) return true;
    }
    return false;
  }

  // ========================
  // PROJECTILE COLLISION
  // ========================

  /**
   * Check if a projectile at (theta, phi) hits any alive bodyguard.
   * Uses oriented-box collision matching GameRoom._updateProjectiles.
   * @param {number} theta - projectile theta
   * @param {number} phi - projectile phi
   * @param {string} ownerFaction - faction of the projectile owner (skip friendly fire)
   * @returns {Object|null} hit bodyguard or null
   */
  checkProjectileHit(theta, phi, ownerFaction) {
    for (const [, bg] of this.bodyguards) {
      if (bg.isDead) continue;
      if (bg.faction === ownerFaction) continue; // No friendly fire

      // Quick-reject distance check
      let dTheta = theta - bg.theta;
      while (dTheta > Math.PI) dTheta -= Math.PI * 2;
      while (dTheta < -Math.PI) dTheta += Math.PI * 2;
      const dPhi = phi - bg.phi;

      const angularDist = Math.sqrt(dTheta * dTheta + dPhi * dPhi);
      if (angularDist > BG_HIT_QUICK_REJECT) continue;

      // Project into bodyguard's local heading frame
      const cosH = Math.cos(bg.heading);
      const sinH = Math.sin(bg.heading);
      // Local forward (along heading) and right
      const localForward = -dPhi * cosH - dTheta * sinH;
      const localRight = -dPhi * sinH + dTheta * cosH;

      // Scale to world units
      const R = this.sphereRadius;
      const worldForward = localForward * R;
      const worldRight = localRight * R;

      if (
        Math.abs(worldForward) <= BG_HIT_HALF_LEN &&
        Math.abs(worldRight) <= BG_HIT_HALF_WID
      ) {
        return bg;
      }
    }
    return null;
  }

  /**
   * Apply damage to a bodyguard.
   * @returns {{ killed: boolean, bodyguard: Object }}
   */
  applyDamage(bgId, damage) {
    const bg = this.bodyguards.get(bgId);
    if (!bg || bg.isDead) return { killed: false, bodyguard: bg };

    bg.hp = Math.max(0, bg.hp - damage);
    if (bg.hp <= 0) {
      bg.isDead = true;
      bg.speed = 0;
      return { killed: true, bodyguard: bg };
    }
    return { killed: false, bodyguard: bg };
  }

  // ========================
  // STATE SERIALIZATION
  // ========================

  /**
   * Compact state for per-tick broadcast (included in "state" event).
   * Reuses cached objects to reduce GC pressure.
   */
  getStatesForBroadcast() {
    if (!this._broadcastCache) this._broadcastCache = {};
    const states = this._broadcastCache;

    // Remove stale entries
    for (const id in states) {
      if (!this.bodyguards.has(id)) delete states[id];
    }

    for (const [id, bg] of this.bodyguards) {
      let s = states[id];
      if (!s) {
        s = {};
        states[id] = s;
      }
      s.t = bg.theta;
      s.p = bg.phi;
      s.h = bg.heading;
      s.s = bg.speed;
      s.hp = bg.hp;
      s.d = bg.isDead ? 1 : 0;
      s.f = bg.faction;
    }
    return states;
  }

  /**
   * Full state for welcome packet (late-joining clients).
   */
  getFullStatesForWelcome() {
    const states = {};
    for (const [id, bg] of this.bodyguards) {
      states[id] = {
        id: bg.id,
        faction: bg.faction,
        commanderId: bg.commanderId,
        index: bg.index,
        side: bg.side,
        name: bg.name,
        theta: bg.theta,
        phi: bg.phi,
        heading: bg.heading,
        speed: bg.speed,
        hp: bg.hp,
        maxHp: bg.maxHp,
        isDead: bg.isDead,
      };
    }
    return states;
  }
}

module.exports = BodyguardManager;
