/**
 * AdLands - Lens Dirt Shader
 * Adds cinematic lens dirt artifacts in areas of high bloom.
 *
 * The bloom texture modulates a dirt pattern texture, creating bright
 * smudges and artifacts where light sources bloom (sun, explosions, muzzle flares).
 *
 * Uses a 9-tap weighted kernel to spread bloom sampling wider than the
 * visible bloom halo, so dirt smears across a larger area of the lens.
 *
 * Dependencies: THREE.js (must be loaded before this file)
 */

const LensDirtShader = {
  uniforms: {
    tDiffuse: { value: null }, // Scene after bloom blend (auto-bound by ShaderPass)
    bloomTexture: { value: null }, // Raw bloom output from bloomComposer
    dirtTexture: { value: null }, // Lens dirt pattern texture
    dirtUvScale: { value: new THREE.Vector2(1.0, 1.0) }, // Aspect-ratio correction (cover mode)
    intensity: { value: 1.0 }, // Overall dirt intensity
    bloomThreshold: { value: 0.005 }, // Minimum bloom brightness to trigger dirt
    dirtMinLevel: { value: 0.15 }, // Minimum dirt brightness floor (fills center gaps)
    bloomSpread: { value: 8.0 }, // Texel offset distance for multi-tap sampling
    bloomTexelSize: { value: new THREE.Vector2(1.0 / 960, 1.0 / 540) }, // Reciprocal bloom RT size
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
        uniform sampler2D bloomTexture;
        uniform sampler2D dirtTexture;
        uniform vec2 dirtUvScale;
        uniform float intensity;
        uniform float bloomThreshold;
        uniform float dirtMinLevel;
        uniform float bloomSpread;
        uniform vec2 bloomTexelSize;
        varying vec2 vUv;

        void main() {
            vec4 base = texture2D(tDiffuse, vUv);
            vec2 dirtUv = (vUv - 0.5) * dirtUvScale + 0.5;
            vec4 dirt = texture2D(dirtTexture, dirtUv);

            // 9-tap weighted bloom sampling for wider dirt coverage.
            // Center 0.25 + 4 cardinal 0.125 + 4 diagonal 0.0625 = 1.0
            vec2 offset = bloomTexelSize * bloomSpread;

            vec3 bloomSum =
                texture2D(bloomTexture, vUv).rgb * 0.25
              + texture2D(bloomTexture, vUv + vec2( offset.x,  0.0     )).rgb * 0.125
              + texture2D(bloomTexture, vUv + vec2(-offset.x,  0.0     )).rgb * 0.125
              + texture2D(bloomTexture, vUv + vec2( 0.0,       offset.y)).rgb * 0.125
              + texture2D(bloomTexture, vUv + vec2( 0.0,      -offset.y)).rgb * 0.125
              + texture2D(bloomTexture, vUv + vec2( offset.x,  offset.y)).rgb * 0.0625
              + texture2D(bloomTexture, vUv + vec2(-offset.x,  offset.y)).rgb * 0.0625
              + texture2D(bloomTexture, vUv + vec2( offset.x, -offset.y)).rgb * 0.0625
              + texture2D(bloomTexture, vUv + vec2(-offset.x, -offset.y)).rgb * 0.0625;

            // Bloom luminance drives the dirt visibility
            float bloomLuma = dot(bloomSum, vec3(0.299, 0.587, 0.114));

            // Soft threshold with wider ramp to accommodate diluted edge luma
            float dirtMask = smoothstep(bloomThreshold, bloomThreshold + 0.5, bloomLuma);

            // Lift dirt texture floor so center of screen still gets bloom-driven dirt
            vec3 effectiveDirt = max(dirt.rgb, vec3(dirtMinLevel));

            // Dirt contribution: bloom color * dirt pattern * mask * intensity
            // Using bloom color means sun bloom creates warm dirt, explosions create faction-colored dirt
            vec3 dirtContribution = bloomSum * effectiveDirt * dirtMask * intensity;

            gl_FragColor = vec4(base.rgb + dirtContribution, base.a);
        }
    `,
};
