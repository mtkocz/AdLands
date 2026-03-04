/**
 * AdLands - Binary State Protocol
 * Shared encoder/decoder for multiplayer state updates.
 * Runs on both server (Node.js) and client (browser).
 *
 * Per-entity binary layout (20 bytes stride):
 *   offset  0: Float32  theta        (longitude, radians)
 *   offset  4: Float32  phi          (latitude, radians)
 *   offset  8: Float32  heading      (facing direction, radians)
 *   offset 12: Float32  speed        (movement speed)
 *   offset 16: Uint16   turretAngle  (quantized [0, 2pi] → [0, 65535])
 *   offset 18: Uint8    hp           (health points, 0-255)
 *   offset 19: Uint8    flags        (packed: faction[2], shield[1], deploy[2], unused[3])
 */

(function (exports) {
  "use strict";

  const ENTITY_STRIDE = 20; // bytes per entity
  const TWO_PI = Math.PI * 2;
  const ANGLE_SCALE = 65535 / TWO_PI;
  const ANGLE_INV_SCALE = TWO_PI / 65535;

  const FACTION_TO_IDX = { rust: 0, cobalt: 1, viridian: 2 };
  const IDX_TO_FACTION = ["rust", "cobalt", "viridian"];

  /**
   * Encode an array of entity states into a binary ArrayBuffer.
   * @param {Array<Object>} entities - [{t, p, h, s, ta, hp, f, sh, d}, ...]
   * @returns {ArrayBuffer}
   */
  function encode(entities) {
    const count = entities.length;
    const buf = new ArrayBuffer(count * ENTITY_STRIDE);
    const dv = new DataView(buf);

    for (let i = 0; i < count; i++) {
      const e = entities[i];
      const off = i * ENTITY_STRIDE;
      dv.setFloat32(off, e.t, true);       // little-endian
      dv.setFloat32(off + 4, e.p, true);
      dv.setFloat32(off + 8, e.h, true);
      dv.setFloat32(off + 12, e.s, true);
      dv.setUint16(off + 16, (e.ta * ANGLE_SCALE) & 0xFFFF, true);
      dv.setUint8(off + 18, e.hp & 0xFF);

      // Pack flags: faction (2 bits) | shield (1 bit) | deploy (2 bits)
      const factionIdx = FACTION_TO_IDX[e.f] || 0;
      const shield = e.sh ? 1 : 0;
      const deploy = (e.d || 0) & 3;
      dv.setUint8(off + 19, (factionIdx & 3) | (shield << 2) | (deploy << 3));
    }

    return buf;
  }

  /**
   * Decode a binary ArrayBuffer into entity state objects.
   * @param {ArrayBuffer} buf
   * @param {Array<string>} ids - entity IDs in the same order as encoded
   * @returns {Object} - { id: {t, p, h, s, ta, hp, f, sh, d}, ... }
   */
  function decode(buf, ids) {
    const dv = new DataView(buf);
    const count = ids.length;
    const result = {};

    for (let i = 0; i < count; i++) {
      const off = i * ENTITY_STRIDE;
      const flags = dv.getUint8(off + 19);
      result[ids[i]] = {
        t: dv.getFloat32(off, true),
        p: dv.getFloat32(off + 4, true),
        h: dv.getFloat32(off + 8, true),
        s: dv.getFloat32(off + 12, true),
        ta: dv.getUint16(off + 16, true) * ANGLE_INV_SCALE,
        hp: dv.getUint8(off + 18),
        f: IDX_TO_FACTION[flags & 3],
        sh: (flags >> 2) & 1,
        d: (flags >> 3) & 3,
      };
    }

    return result;
  }

  exports.ENTITY_STRIDE = ENTITY_STRIDE;
  exports.encode = encode;
  exports.decode = decode;

})(typeof module !== "undefined" ? module.exports : (window.BinaryStateProtocol = {}));
