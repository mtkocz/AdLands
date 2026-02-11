/**
 * Shared Math Utilities
 * Common math functions used across multiple game systems
 */

const MathUtils = {
    /**
     * Linear interpolation between two values
     * @param {number} a - Start value
     * @param {number} b - End value
     * @param {number} t - Interpolation factor (0-1)
     * @returns {number}
     */
    lerp(a, b, t) {
        return a + (b - a) * t;
    },

    /**
     * Lerp angles, handling wrap-around at +/- PI
     * @param {number} a - Start angle (radians)
     * @param {number} b - End angle (radians)
     * @param {number} t - Interpolation factor (0-1)
     * @returns {number}
     */
    lerpAngle(a, b, t) {
        let delta = b - a;

        // Normalize delta to [-PI, PI]
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;

        return a + delta * t;
    },

    /**
     * Septic ease-in-out for extra smooth acceleration/deceleration
     * Formula: -20t^7 + 70t^6 - 84t^5 + 35t^4
     * @param {number} t - Input value (0-1)
     * @returns {number}
     */
    smoothstep(t) {
        const t2 = t * t;
        const t4 = t2 * t2;
        return t4 * (35 - 84 * t + 70 * t2 - 20 * t2 * t);
    },

    /**
     * Clamp a value between min and max
     * @param {number} value - Value to clamp
     * @param {number} min - Minimum value
     * @param {number} max - Maximum value
     * @returns {number}
     */
    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    },

    /**
     * Map a value from one range to another
     * @param {number} value - Input value
     * @param {number} inMin - Input range minimum
     * @param {number} inMax - Input range maximum
     * @param {number} outMin - Output range minimum
     * @param {number} outMax - Output range maximum
     * @returns {number}
     */
    mapRange(value, inMin, inMax, outMin, outMax) {
        return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
    }
};
