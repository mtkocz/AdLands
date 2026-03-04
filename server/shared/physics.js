/**
 * AdLands - Shared Physics
 * Tank movement on a sphere surface.
 * Runs identically on server (Node.js) and client (browser).
 *
 * This is a direct port of Tank.moveEntityOnSphere from Tank.js,
 * extracted so the server can simulate tank movement without THREE.js.
 */

(function (exports) {
  "use strict";

  const FACTIONS = ["rust", "cobalt", "viridian"];

  // Physics constants (must match Tank.js and BotTanks.js)
  const TANK_PHYSICS = {
    maxSpeed: 0.0004,
    acceleration: 0.00001,
    deceleration: 0.00001,
    turnRate: 0.015,
    sprintMultiplier: 5,
  };

  // Day/night cycle speed (matches CONFIG.dayNightCycleMinutes = 30)
  const DAY_NIGHT_CYCLE_MINUTES = 30;
  const PLANET_ROTATION_SPEED =
    (Math.PI * 2) / (DAY_NIGHT_CYCLE_MINUTES * 60);

  /**
   * Apply player input to a tank's physics state.
   * Modifies tank.speed and tank.heading in place.
   *
   * @param {Object} tank - { speed, heading, keys: { w, a, s, d, shift } }
   * @param {number} deltaTime - seconds since last tick
   */
  function applyInput(tank, deltaTime) {
    const keys = tank.keys;
    const dt60 = deltaTime * 60;

    const currentMaxSpeed = keys.shift
      ? TANK_PHYSICS.maxSpeed * TANK_PHYSICS.sprintMultiplier
      : TANK_PHYSICS.maxSpeed;

    // Steering
    if (keys.a) tank.heading -= TANK_PHYSICS.turnRate * dt60;
    if (keys.d) tank.heading += TANK_PHYSICS.turnRate * dt60;

    // Normalize heading to [0, 2π]
    while (tank.heading < 0) tank.heading += Math.PI * 2;
    while (tank.heading >= Math.PI * 2) tank.heading -= Math.PI * 2;

    // Acceleration / deceleration
    // NOTE: In AdLands, W = reverse and S = forward (tank controls)
    if (keys.s) {
      tank.speed += TANK_PHYSICS.acceleration * dt60;
      if (tank.speed > currentMaxSpeed) tank.speed = currentMaxSpeed;
    } else if (keys.w) {
      tank.speed -= TANK_PHYSICS.acceleration * dt60;
      if (tank.speed < -currentMaxSpeed) tank.speed = -currentMaxSpeed;
    } else {
      // Decelerate toward zero
      if (tank.speed > 0) {
        tank.speed -= TANK_PHYSICS.deceleration * dt60;
        if (tank.speed < 0) tank.speed = 0;
      } else if (tank.speed < 0) {
        tank.speed += TANK_PHYSICS.deceleration * dt60;
        if (tank.speed > 0) tank.speed = 0;
      }
    }
  }

  /**
   * Move an entity on the sphere surface.
   * Direct port of Tank.moveEntityOnSphere.
   *
   * @param {Object} entity - { speed, heading, theta, phi }
   * @param {number} planetRotationSpeed - radians per second-ish
   * @param {number} deltaTime - seconds since last tick
   * @param {number} [minPhi] - minimum latitude (polar opening boundary)
   * @param {number} [maxPhi] - maximum latitude (polar opening boundary)
   */
  var POLAR_PHI_LIMIT = (3 * Math.PI) / 180; // 3° safety net (polygon collision is primary boundary)
  function moveOnSphere(
    entity,
    deltaTime,
    minPhi,
    maxPhi
  ) {
    if (minPhi === undefined) minPhi = POLAR_PHI_LIMIT;
    if (maxPhi === undefined) maxPhi = Math.PI - POLAR_PHI_LIMIT;

    const speed = entity.speed;
    const heading = entity.heading;
    const phi = entity.phi;

    const dt60 = deltaTime * 60;

    // Convert speed in heading direction to north/east components
    const velocityNorth = Math.cos(heading) * speed * dt60;
    const velocityEast = -Math.sin(heading) * speed * dt60;

    // Convert tangent plane velocity to spherical coordinate changes
    const dPhi = -velocityNorth;
    const sinPhi = Math.sin(phi);
    const safeSinPhi =
      Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
    const dTheta = velocityEast / safeSinPhi;

    // Clamp to prevent pole teleportation
    const maxDTheta = 0.1;
    const clampedDTheta = Math.max(-maxDTheta, Math.min(maxDTheta, dTheta));

    entity.phi += dPhi;
    entity.theta += clampedDTheta;

    // Clamp latitude
    entity.phi = Math.max(minPhi, Math.min(maxPhi, entity.phi));

    // Wrap longitude
    while (entity.theta > Math.PI * 2) entity.theta -= Math.PI * 2;
    while (entity.theta < 0) entity.theta += Math.PI * 2;
  }

  /**
   * Compute spherical distance between two points on a unit sphere.
   * Multiply by sphereRadius for actual distance.
   */
  function sphericalDistance(theta1, phi1, theta2, phi2) {
    const sinPhi1 = Math.sin(phi1);
    const cosPhi1 = Math.cos(phi1);
    const sinPhi2 = Math.sin(phi2);
    const cosPhi2 = Math.cos(phi2);
    const dTheta = theta2 - theta1;
    const cosDTheta = Math.cos(dTheta);
    return Math.acos(
      Math.min(1, Math.max(-1, cosPhi1 * cosPhi2 + sinPhi1 * sinPhi2 * cosDTheta))
    );
  }

  // ---- Terrain Collision (shared grid-based lookup) ----

  var TANK_HALF_LEN = 2.75;
  var TANK_HALF_WID = 1.5;
  var _terrainProbes = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]; // pre-allocated

  /**
   * O(1) terrain blocked check using a precomputed blocked grid.
   * Identical on server (WorldGenerator) and client (received on join).
   * @param {number} theta
   * @param {number} phi
   * @param {Uint8Array} grid - blocked grid (1 = blocked)
   * @param {number} gridT - grid width (theta resolution)
   * @param {number} gridP - grid height (phi resolution)
   * @returns {boolean}
   */
  function isGridBlocked(theta, phi, grid, gridT, gridP) {
    var t = theta % (Math.PI * 2);
    if (t < 0) t += Math.PI * 2;
    var ti = (t / (Math.PI * 2) * gridT) | 0;
    if (ti >= gridT) ti = gridT - 1;
    var pi = (phi / Math.PI * gridP) | 0;
    if (pi >= gridP) pi = gridP - 1;
    if (pi < 0) pi = 0;
    return grid[pi * gridT + ti] === 1;
  }

  /**
   * Check if a tank at (theta, phi) with given heading/speed is blocked by terrain.
   * Uses 5 probe points (center + 4 corners) in 2D spherical coordinates.
   * Must produce identical results on client and server.
   *
   * @param {number} theta
   * @param {number} phi
   * @param {number} heading
   * @param {number} speed
   * @param {Uint8Array} grid
   * @param {number} gridT
   * @param {number} gridP
   * @param {number} R - sphere radius (480)
   * @returns {boolean}
   */
  function isTerrainBlockedAt(theta, phi, heading, speed, grid, gridT, gridP, R) {
    var sinPhi = Math.sin(phi);
    var safeSinPhi = Math.abs(sinPhi) < 0.01 ? 0.01 * Math.sign(sinPhi || 1) : sinPhi;
    var dir = speed > 0 ? 1 : speed < 0 ? -1 : 0;
    var cosH = Math.cos(heading);
    var sinH = Math.sin(heading);
    var fwdPhi = -cosH;
    var fwdTh  = -sinH / safeSinPhi;
    var rgtPhi =  sinH;
    var rgtTh  = -cosH / safeSinPhi;

    // 5 probes: center + 4 corners of tank body
    _terrainProbes[0][0] = 0;                    _terrainProbes[0][1] = 0;
    _terrainProbes[1][0] = TANK_HALF_LEN * dir;  _terrainProbes[1][1] = -TANK_HALF_WID;
    _terrainProbes[2][0] = TANK_HALF_LEN * dir;  _terrainProbes[2][1] =  TANK_HALF_WID;
    _terrainProbes[3][0] = -TANK_HALF_LEN * dir; _terrainProbes[3][1] = -TANK_HALF_WID;
    _terrainProbes[4][0] = -TANK_HALF_LEN * dir; _terrainProbes[4][1] =  TANK_HALF_WID;

    for (var i = 0; i < 5; i++) {
      var fwd = _terrainProbes[i][0];
      var rgt = _terrainProbes[i][1];
      var pPhi = phi + (fwdPhi * fwd + rgtPhi * rgt) / R;
      var pTh  = theta + (fwdTh * fwd + rgtTh * rgt) / R;
      if (isGridBlocked(pTh, pPhi, grid, gridT, gridP)) return true;
    }
    return false;
  }

  // ---- Exports ----
  exports.FACTIONS = FACTIONS;
  exports.TANK_PHYSICS = TANK_PHYSICS;
  exports.PLANET_ROTATION_SPEED = PLANET_ROTATION_SPEED;
  exports.DAY_NIGHT_CYCLE_MINUTES = DAY_NIGHT_CYCLE_MINUTES;
  exports.POLAR_PHI_LIMIT = POLAR_PHI_LIMIT;
  exports.applyInput = applyInput;
  exports.moveOnSphere = moveOnSphere;
  exports.sphericalDistance = sphericalDistance;
  exports.isGridBlocked = isGridBlocked;
  exports.isTerrainBlockedAt = isTerrainBlockedAt;

  // UMD: works as CommonJS (Node) or global (browser)
})(typeof module !== "undefined" ? module.exports : (window.SharedPhysics = {}));
