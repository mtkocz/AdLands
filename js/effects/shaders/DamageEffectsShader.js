/**
 * DamageEffectsShader - Combined damage feedback post-processing
 *
 * Sub-effects (all driven by HP and damage events):
 *   1. Scanlines — horizontal scan line overlay at low HP
 *   2. Noise — static grain on hit
 *   3. Glitch tears — horizontal UV displacement on hit
 *   4. Signal loss — faction-colored screen with all effects on death
 *
 * Processing order: glitch displaces UV first, then scanlines darken,
 * noise mixes in, signal loss fills with faction color (effects layered on top).
 */

const DamageEffectsShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    scanlineIntensity: { value: 0 },
    noiseIntensity: { value: 0 },
    glitchIntensity: { value: 0 },
    signalLoss: { value: 0 },
    signalLossColor: { value: new THREE.Color(0x000000) },
  },

  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float scanlineIntensity;
    uniform float noiseIntensity;
    uniform float glitchIntensity;
    uniform float signalLoss;
    uniform vec3 signalLossColor;
    varying vec2 vUv;

    float random(vec2 st) {
      return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;

      // ========== GLITCH OFFSET ==========
      if (glitchIntensity > 0.0) {
        float glitchLine = step(0.98 - glitchIntensity * 0.3, random(vec2(floor(vUv.y * 40.0), time)));
        float offset = (random(vec2(time, floor(vUv.y * 40.0))) - 0.5) * glitchIntensity * 0.3;
        uv.x += offset * glitchLine;
      }

      vec3 color = texture2D(tDiffuse, uv).rgb;

      // ========== SIGNAL LOSS (faction color fill) ==========
      // Applied before scanlines/noise so those effects layer on top
      if (signalLoss > 0.0) {
        float fill = step(1.0 - signalLoss, random(vec2(time * 10.0, 0.0)));
        color = mix(color, signalLossColor, fill);
      }

      // ========== SCANLINES (crisp pixel-perfect lines) ==========
      if (scanlineIntensity > 0.0) {
        float scanline = step(0.5, fract(vUv.y * 250.0));
        color *= 1.0 - (scanlineIntensity * scanline * 0.3);
      }

      // ========== STATIC NOISE (blocky, unique every frame) ==========
      if (noiseIntensity > 0.0) {
        vec2 blockUv = floor(vUv * vec2(320.0, 240.0));
        float noise = random(blockUv + time * 137.0) * noiseIntensity;
        color = mix(color, vec3(noise), noiseIntensity * 0.5);
      }

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
