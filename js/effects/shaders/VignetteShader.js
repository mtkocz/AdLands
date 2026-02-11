/**
 * AdLands - Vignette Shader
 * Two-layer vignette: constant cinematic black framing + dynamic overlay for damage/heal.
 *
 * Base layer: always-on edge darkening (black, constant intensity)
 * Overlay layer: reactive color (red on damage, green on heal, decays over time)
 *
 * Dependencies: THREE.js (must be loaded before this file)
 */

const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    baseIntensity: { value: 0.5 },
    baseColor: { value: new THREE.Color(0x000000) },
    overlayIntensity: { value: 0.0 },
    overlayColor: { value: new THREE.Color(0x000000) },
    smoothness: { value: 0.5 },
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
    uniform float baseIntensity;
    uniform vec3 baseColor;
    uniform float overlayIntensity;
    uniform vec3 overlayColor;
    uniform float smoothness;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);

      vec2 center = vUv - 0.5;
      float dist = length(center);

      // Base cinematic vignette (always constant)
      float baseVignette = smoothstep(0.8, smoothness * 0.8, dist * (baseIntensity + smoothness));
      vec3 result = mix(baseColor, texel.rgb, baseVignette);

      // Overlay vignette (damage/heal - layers on top)
      if (overlayIntensity > 0.0) {
        float overlayVignette = smoothstep(0.8, smoothness * 0.8, dist * (overlayIntensity + smoothness));
        result = mix(overlayColor, result, overlayVignette);
      }

      gl_FragColor = vec4(result, texel.a);
    }
  `,
};
