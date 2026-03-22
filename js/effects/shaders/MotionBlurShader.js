/**
 * AdLands - Motion Blur Shader
 * Radial zoom blur driven by camera velocity during view transitions.
 * Samples along the line from each pixel to the blur center, creating
 * a speed-line effect that matches the camera's radial descent/ascent.
 *
 * Dependencies: THREE.js (must be loaded before this file)
 */

const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uIntensity: { value: 0.0 },   // 0 = no blur, ~0.02 = subtle, ~0.06 = strong
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uSamples: { value: 8 },       // number of blur taps
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
    uniform float uIntensity;
    uniform vec2 uCenter;
    uniform int uSamples;
    varying vec2 vUv;

    void main() {
      if (uIntensity < 0.001) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 dir = vUv - uCenter;
      float dist = length(dir);

      // Scale blur by distance from center (edges blur more, center stays sharp)
      vec2 velocity = dir * uIntensity * dist;

      vec4 color = vec4(0.0);
      float totalWeight = 0.0;

      for (int i = 0; i < 16; i++) {
        if (i >= uSamples) break;
        // Sample from current pixel back along the velocity direction
        float t = float(i) / float(uSamples - 1) - 0.5;
        vec2 offset = velocity * t;
        // Slight falloff for outer samples
        float weight = 1.0 - abs(t) * 0.4;
        color += texture2D(tDiffuse, vUv + offset) * weight;
        totalWeight += weight;
      }

      gl_FragColor = color / totalWeight;
    }
  `,
};
