/**
 * AdLands - Chromatic Aberration Shader
 * Radial RGB channel separation, stronger at screen edges.
 *
 * Base (cinematic): always-on subtle fringing (intensity ~0.0015)
 * Damage reactive: spikes on hit, decays per frame, sustained at low HP
 *
 * Dependencies: THREE.js (must be loaded before this file)
 */

const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    intensity: { value: 0.0015 },
    falloff: { value: 0.6 },
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
    uniform float intensity;
    uniform float falloff;
    varying vec2 vUv;

    void main() {
      vec2 center = vUv - 0.5;
      float dist = length(center);
      float aberrationAmount = intensity * pow(dist, falloff);
      vec2 dir = normalize(center);

      float r = texture2D(tDiffuse, vUv + dir * aberrationAmount).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - dir * aberrationAmount).b;

      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};
