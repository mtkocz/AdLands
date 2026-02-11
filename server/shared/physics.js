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
   * @param {number} [minPhi=0.01] - minimum latitude (avoid north pole)
   * @param {number} [maxPhi=Math.PI-0.01] - maximum latitude (avoid south pole)
   */
  function moveOnSphere(
    entity,
    planetRotationSpeed,
    deltaTime,
    minPhi,
    maxPhi
  ) {
    if (minPhi === undefined) minPhi = 0.01;
    if (maxPhi === undefined) maxPhi = Math.PI - 0.01;

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

    // Counter planet rotation
    entity.theta -= (planetRotationSpeed * dt60) / 60;
    if (entity.theta < 0) entity.theta += Math.PI * 2;
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

  // ---- Exports ----
  exports.FACTIONS = FACTIONS;
  exports.TANK_PHYSICS = TANK_PHYSICS;
  exports.PLANET_ROTATION_SPEED = PLANET_ROTATION_SPEED;
  exports.DAY_NIGHT_CYCLE_MINUTES = DAY_NIGHT_CYCLE_MINUTES;
  exports.applyInput = applyInput;
  exports.moveOnSphere = moveOnSphere;
  exports.sphericalDistance = sphericalDistance;

  // UMD: works as CommonJS (Node) or global (browser)
})(typeof module !== "undefined" ? module.exports : (window.SharedPhysics = {}));
