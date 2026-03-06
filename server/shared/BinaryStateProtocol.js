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
 *   offset 19: Uint8    flags        (packed: faction[2], shield[1], deploy[2], welding[1], unused[2])
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
    _encodeInto(entities, dv, count);
    return buf;
  }

  /**
   * Encode into a pre-allocated ArrayBuffer, returning a Uint8Array view.
   * Avoids per-call ArrayBuffer allocation for hot paths.
   * @param {Array<Object>} entities
   * @param {ArrayBuffer} buf - must be >= entities.length * ENTITY_STRIDE bytes
   * @returns {Uint8Array} slice view of buf (no copy)
   */
  function encodeInto(entities, buf) {
    const count = entities.length;
    const dv = new DataView(buf, 0, count * ENTITY_STRIDE);
    _encodeInto(entities, dv, count);
    return new Uint8Array(buf, 0, count * ENTITY_STRIDE);
  }

  /** @private Shared encoding logic */
  function _encodeInto(entities, dv, count) {
    for (let i = 0; i < count; i++) {
      const e = entities[i];
      const off = i * ENTITY_STRIDE;
      dv.setFloat32(off, e.t, true);       // little-endian
      dv.setFloat32(off + 4, e.p, true);
      dv.setFloat32(off + 8, e.h, true);
      dv.setFloat32(off + 12, e.s, true);
      dv.setUint16(off + 16, (e.ta * ANGLE_SCALE) & 0xFFFF, true);
      dv.setUint8(off + 18, e.hp & 0xFF);

      // Pack flags: faction (2 bits) | shield (1 bit) | deploy (2 bits) | welding (1 bit)
      const factionIdx = FACTION_TO_IDX[e.f] || 0;
      const shield = e.sh ? 1 : 0;
      const deploy = (e.d || 0) & 3;
      const welding = e.weld ? 1 : 0;
      dv.setUint8(off + 19, (factionIdx & 3) | (shield << 2) | (deploy << 3) | (welding << 5));
    }
  }

  // Object pool for decode entries — avoids per-tick allocation of ~200 objects.
  // Pool grows as needed; objects are recycled between decode calls.
  var _entryPool = [];
  var _entryPoolIdx = 0;

  function _acquireEntry() {
    if (_entryPoolIdx < _entryPool.length) {
      return _entryPool[_entryPoolIdx++];
    }
    var e = { t: 0, p: 0, h: 0, s: 0, ta: 0, hp: 0, f: '', sh: 0, d: 0, weld: 0 };
    _entryPool.push(e);
    _entryPoolIdx++;
    return e;
  }

  /**
   * Decode a binary ArrayBuffer into entity state objects.
   * Uses an internal object pool to reuse entry objects across calls,
   * reducing GC pressure from ~2000 object allocations/sec to near zero.
   * @param {ArrayBuffer} buf
   * @param {Array<string>} ids - entity IDs in the same order as encoded
   * @returns {Object} - { id: {t, p, h, s, ta, hp, f, sh, d}, ... }
   */
  function decode(buf, ids) {
    const dv = new DataView(buf);
    const count = ids.length;
    const result = {};

    // Reset pool index — reuse objects from previous decode call
    _entryPoolIdx = 0;

    for (let i = 0; i < count; i++) {
      const off = i * ENTITY_STRIDE;
      const flags = dv.getUint8(off + 19);
      var entry = _acquireEntry();
      entry.t = dv.getFloat32(off, true);
      entry.p = dv.getFloat32(off + 4, true);
      entry.h = dv.getFloat32(off + 8, true);
      entry.s = dv.getFloat32(off + 12, true);
      entry.ta = dv.getUint16(off + 16, true) * ANGLE_INV_SCALE;
      entry.hp = dv.getUint8(off + 18);
      entry.f = IDX_TO_FACTION[flags & 3];
      entry.sh = (flags >> 2) & 1;
      entry.d = (flags >> 3) & 3;
      entry.weld = (flags >> 5) & 1;
      result[ids[i]] = entry;
    }

    return result;
  }

  exports.ENTITY_STRIDE = ENTITY_STRIDE;
  exports.encode = encode;
  exports.encodeInto = encodeInto;
  exports.decode = decode;

})(typeof module !== "undefined" ? module.exports : (window.BinaryStateProtocol = {}));
