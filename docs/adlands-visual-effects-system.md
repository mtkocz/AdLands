# AdLands Visual Effects System

## Overview

Complete visual feedback system for AdLands, covering camera effects, post-processing, and damage feedback.

---

## System Architecture

```
VISUAL EFFECTS SYSTEMS
│
├── Camera Effects (camera transform - before render)
│   ├── Screen Shake
│   ├── Recoil
│   └── Directional Punch
│
├── Post-Processing: Cinematic (always on, subtle)
│   ├── Bloom
│   ├── Vignette
│   ├── Lens Dirt
│   └── Chromatic Aberration (base)
│
└── Post-Processing: Damage Feedback (reactive)
    ├── Damage Vignette (red flash)
    ├── Heal Vignette (green pulse)
    ├── Damage Chromatic (spike)
    ├── Scanlines
    ├── Static/Noise
    ├── Glitch Tears
    └── Signal Loss (death only)
```

---

## Effect Trigger Matrix

| Effect | On Hit | Near Explosion | Low HP | Being Healed | On Death |
|--------|--------|----------------|--------|--------------|----------|
| Camera Shake | ✅ | ✅ big | ❌ | ❌ | ✅ |
| Camera Recoil | ❌ | ❌ | ❌ | ❌ | ❌ |
| Camera Punch | ✅ | ❌ | ❌ | ❌ | ❌ |
| Bloom | always | always | always | always | always |
| Vignette (black) | always | always | always | always | always |
| Vignette (red) | ✅ spike | ❌ | ✅ tint | ❌ | ✅ |
| Vignette (green) | ❌ | ❌ | ❌ | ✅ pulse | ❌ |
| Lens Dirt | always | always | always | always | always |
| Chromatic (base) | always | always | always | always | always |
| Chromatic (damage) | ✅ spike | ✅ small | ✅ constant | ❌ | ✅ max |
| Scanlines | ✅ | ❌ | ✅ | ❌ | ✅ |
| Noise | ✅ | ✅ brief | ✅ flicker | ❌ | ✅ max |
| Glitch Tears | ✅ | ✅ brief | ✅ occasional | ❌ | ✅ max |
| Signal Loss | ❌ | ❌ | ❌ | ❌ | ✅ only |

---

## Vignette System

The vignette has three layers that stack:

| Layer | Color | Behavior | Toggle |
|-------|-------|----------|--------|
| Cinematic (base) | Black | Always on, constant intensity | Cinematic → Vignette |
| Damage (overlay) | Red | Flash on hit, tint at low HP | Damage → Damage Vignette |
| Heal (overlay) | Green | Pulse while being healed | Damage → Heal Vignette |

### How they layer:

```
Normal gameplay:
┌─────────────────────────────────────────┐
│░░                                     ░░│  ← Cinematic vignette (constant black)
│                                         │
│              [Tank]                     │
│                                         │
│░░                                     ░░│
└─────────────────────────────────────────┘

Taking damage (red overlays on black):
┌─────────────────────────────────────────┐
│▓▓                                     ▓▓│  ← Black + Red flash (temporary)
│                                         │
│              [Tank]                     │
│                                         │
│▓▓                                     ▓▓│
└─────────────────────────────────────────┘

After damage settles:
┌─────────────────────────────────────────┐
│░░                                     ░░│  ← Back to constant black
│                                         │
│              [Tank]                     │
│                                         │
│░░                                     ░░│
└─────────────────────────────────────────┘

Being healed (green overlays on black):
┌─────────────────────────────────────────┐
│▒▒                                     ▒▒│  ← Black + Green pulse
│                                         │
│              [Tank]                     │
│                                         │
│▒▒                                     ▒▒│
└─────────────────────────────────────────┘
```

**Key point:** Cinematic vignette is ALWAYS constant. It never changes intensity or color. Damage and heal vignettes layer on top temporarily.

---

## Settings Structure

```javascript
const visualSettings = {
  // Camera Effects
  camera: {
    shakeEnabled: true,
    shakeIntensity: 1.0,        // 0.0 - 2.0
    recoilEnabled: true,
    punchEnabled: true
  },
  
  // Cinematic (always on, constant)
  cinematic: {
    bloomEnabled: true,
    bloomIntensity: 0.5,        // 0.0 - 2.0
    vignetteEnabled: true,      // Constant black vignette, never changes
    vignetteIntensity: 0.3,     // 0.0 - 1.0 (always this value)
    lensDirtEnabled: true,
    lensDirtIntensity: 0.5,     // 0.0 - 1.0
    chromaticEnabled: true,
    chromaticIntensity: 0.0015  // Subtle base, always on
  },
  
  // Damage Feedback (reactive, layers on top of cinematic)
  damage: {
    damageVignetteEnabled: true,  // Red flash on hit, tint at low HP (overlays cinematic)
    healVignetteEnabled: true,    // Green pulse when healed (overlays cinematic)
    chromaticEnabled: true,       // Spike on hit
    scanlinesEnabled: true,
    noiseEnabled: true,
    glitchEnabled: true,
    signalLossEnabled: true       // Death only
  }
};
```

---

## Settings UI

```
Settings → Graphics → Visual Effects

┌─────────────────────────────────────────┐
│ CAMERA EFFECTS                          │
├─────────────────────────────────────────┤
│ Screen Shake         [On]  ████████░░   │
│ Recoil               [On]               │
│ Directional Punch    [On]               │
├─────────────────────────────────────────┤
│ CINEMATIC EFFECTS                       │
├─────────────────────────────────────────┤
│ Bloom                [On]  ████████░░   │
│ Vignette             [On]  ██████░░░░   │  ← Constant black, never changes
│ Lens Dirt            [On]  ████████░░   │
│ Chromatic Aberration [On]  ██░░░░░░░░   │
├─────────────────────────────────────────┤
│ DAMAGE EFFECTS                          │
├─────────────────────────────────────────┤
│ Damage Vignette      [On]               │  ← Red flash/tint (overlays cinematic)
│ Heal Vignette        [On]               │  ← Green pulse (overlays cinematic)
│ Damage Chromatic     [On]               │
│ Scanlines            [On]               │
│ Static/Noise         [On]               │
│ Glitch Tears         [On]               │
│ Signal Loss          [On]               │
├─────────────────────────────────────────┤
│ [Reset to Defaults]                     │
└─────────────────────────────────────────┘
```

---

## Post-Processing Stack Order

```javascript
// Order matters!
composer.addPass(new RenderPass(scene, camera));  // 1. Base scene
composer.addPass(bloomPass);                       // 2. Bloom
composer.addPass(lensDirtPass);                    // 3. Lens dirt (uses bloom)
composer.addPass(damageEffectsPass);               // 4. Scanlines, noise, glitch, signal loss
composer.addPass(chromaticPass);                   // 5. Chromatic aberration
composer.addPass(vignettePass);                    // 6. Vignette (last, frames everything)
```

---

## Camera Effects

### Camera Shake

Triggered by: hits, explosions, death

```javascript
class CameraShake {
  constructor(camera) {
    this.camera = camera;
    this.trauma = 0;          // 0 to 1
    this.decay = 5;           // How fast trauma decays
    this.maxOffset = 0.5;     // Max position offset
    this.maxRotation = 0.05;  // Max rotation offset
  }

  trigger(intensity) {
    this.trauma = Math.min(1, this.trauma + intensity);
  }

  update(delta) {
    if (this.trauma <= 0) return;

    // Shake amount = trauma squared (feels better)
    const shake = this.trauma * this.trauma;

    // Random offsets
    const offsetX = (Math.random() * 2 - 1) * this.maxOffset * shake;
    const offsetY = (Math.random() * 2 - 1) * this.maxOffset * shake;
    const rotation = (Math.random() * 2 - 1) * this.maxRotation * shake;

    // Apply to camera
    this.camera.position.x += offsetX;
    this.camera.position.y += offsetY;
    this.camera.rotation.z = rotation;

    // Decay trauma
    this.trauma = Math.max(0, this.trauma - this.decay * delta);
  }
}
```

### Camera Recoil

Triggered by: firing weapon

```javascript
class CameraRecoil {
  constructor(camera) {
    this.camera = camera;
    this.recoilAmount = 0;
    this.recoilMax = 0.03;
    this.recovery = 8;
  }

  trigger() {
    this.recoilAmount = this.recoilMax;
  }

  update(delta) {
    if (this.recoilAmount <= 0) return;

    // Apply recoil (pitch up slightly)
    this.camera.rotation.x -= this.recoilAmount;

    // Recover
    this.recoilAmount = Math.max(0, this.recoilAmount - this.recovery * delta);
  }
}
```

### Camera Punch (Directional)

Triggered by: taking hit from specific direction

```javascript
class CameraPunch {
  constructor(camera) {
    this.camera = camera;
    this.punchVector = new THREE.Vector3();
    this.punchIntensity = 0;
    this.recovery = 10;
  }

  trigger(direction) {
    // Punch camera away from hit direction
    this.punchVector.copy(direction).normalize().multiplyScalar(-0.2);
    this.punchIntensity = 1;
  }

  update(delta) {
    if (this.punchIntensity <= 0) return;

    // Apply punch
    this.camera.position.add(
      this.punchVector.clone().multiplyScalar(this.punchIntensity * delta * 20)
    );

    // Recover
    this.punchIntensity = Math.max(0, this.punchIntensity - this.recovery * delta);
  }
}
```

---

## Cinematic Effects

### Bloom

Always on, subtle glow on bright areas.

```javascript
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.5,    // strength
  0.4,    // radius
  0.85    // threshold
);

// Update from settings
bloomPass.strength = settings.cinematic.bloomIntensity;
bloomPass.enabled = settings.cinematic.bloomEnabled;
```

### Vignette

Base cinematic vignette (constant black) with overlay support for damage/heal.

```javascript
const VignetteShader = {
  uniforms: {
    'tDiffuse': { value: null },
    
    // Base cinematic vignette (constant)
    'baseIntensity': { value: 0.3 },
    'baseColor': { value: new THREE.Color(0x000000) },
    
    // Overlay vignette (reactive - damage/heal)
    'overlayIntensity': { value: 0 },
    'overlayColor': { value: new THREE.Color(0x000000) },
    
    'smoothness': { value: 0.5 }
  },

  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewPosition * vec4(position, 1.0);
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
  `
};
```

#### Vignette Colors

| State | Hex | Layer | Behavior |
|-------|-----|-------|----------|
| Cinematic | `0x000000` | Base | Always constant |
| Damage flash | `0x330000` | Overlay | Spike on hit, decays |
| Low HP | `0x220000` | Overlay | Sustained tint |
| Healing | `0x003300` | Overlay | Pulse while healed |

### Lens Dirt

Only visible when bloom interacts with it.

```javascript
const lensDirtTexture = new THREE.TextureLoader().load('textures/lens_dirt.jpg');

const LensDirtShader = {
  uniforms: {
    'tDiffuse': { value: null },
    'tBloom': { value: null },
    'tLensDirt': { value: lensDirtTexture },
    'intensity': { value: 0.5 }
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
    uniform sampler2D tBloom;
    uniform sampler2D tLensDirt;
    uniform float intensity;
    
    varying vec2 vUv;
    
    void main() {
      vec4 scene = texture2D(tDiffuse, vUv);
      vec4 bloom = texture2D(tBloom, vUv);
      vec4 dirt = texture2D(tLensDirt, vUv);
      
      vec3 lensDirt = dirt.rgb * bloom.rgb * intensity;
      
      gl_FragColor = vec4(scene.rgb + lensDirt, 1.0);
    }
  `
};
```

### Chromatic Aberration (Base)

Always on, very subtle. Separates RGB at screen edges.

```javascript
const ChromaticAberrationShader = {
  uniforms: {
    'tDiffuse': { value: null },
    'intensity': { value: 0.0015 },  // Very subtle base
    'falloff': { value: 0.6 }
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
  `
};
```

---

## Damage Feedback Effects

### Combined Damage Shader

All damage effects in one shader for efficiency.

```javascript
const DamageEffectsShader = {
  uniforms: {
    'tDiffuse': { value: null },
    'time': { value: 0 },
    
    'scanlineIntensity': { value: 0 },
    'noiseIntensity': { value: 0 },
    'glitchIntensity': { value: 0 },
    'signalLoss': { value: 0 }
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
    
    varying vec2 vUv;
    
    float random(vec2 st) {
      return fract(sin(dot(st, vec2(12.9898, 78.233))) * 43758.5453);
    }
    
    void main() {
      vec2 uv = vUv;
      
      // ========== GLITCH OFFSET ==========
      if (glitchIntensity > 0.0) {
        float glitchLine = step(0.99 - glitchIntensity * 0.1, random(vec2(floor(vUv.y * 50.0), time)));
        float offset = (random(vec2(time, floor(vUv.y * 50.0))) - 0.5) * glitchIntensity * 0.1;
        uv.x += offset * glitchLine;
      }
      
      vec3 color = texture2D(tDiffuse, uv).rgb;
      
      // ========== SCANLINES ==========
      if (scanlineIntensity > 0.0) {
        float scanline = sin(vUv.y * 500.0) * 0.5 + 0.5;
        color *= 1.0 - (scanlineIntensity * scanline * 0.3);
      }
      
      // ========== STATIC NOISE ==========
      if (noiseIntensity > 0.0) {
        float noise = random(vUv + time) * noiseIntensity;
        color = mix(color, vec3(noise), noiseIntensity * 0.5);
      }
      
      // ========== SIGNAL LOSS ==========
      if (signalLoss > 0.0) {
        float blackout = step(1.0 - signalLoss, random(vec2(time * 10.0, 0.0)));
        color *= 1.0 - blackout;
      }
      
      gl_FragColor = vec4(color, 1.0);
    }
  `
};
```

---

## Visual Effects Manager

Main controller class that coordinates all effects.

```javascript
class VisualEffectsManager {
  constructor(camera, composer, settings) {
    this.settings = settings;
    
    // Camera effects
    this.cameraShake = new CameraShake(camera);
    this.cameraRecoil = new CameraRecoil(camera);
    this.cameraPunch = new CameraPunch(camera);
    
    // Post-processing passes
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      settings.cinematic.bloomIntensity,
      0.4,
      0.85
    );
    
    this.vignettePass = new ShaderPass(VignetteShader);
    this.lensDirtPass = new ShaderPass(LensDirtShader);
    this.chromaticPass = new ShaderPass(ChromaticAberrationShader);
    this.damagePass = new ShaderPass(DamageEffectsShader);
    
    // Add passes to composer (order matters!)
    composer.addPass(this.bloomPass);
    composer.addPass(this.lensDirtPass);
    composer.addPass(this.damagePass);
    composer.addPass(this.chromaticPass);
    composer.addPass(this.vignettePass);
    
    // Set constant base vignette
    this.vignettePass.uniforms.baseIntensity.value = settings.cinematic.vignetteIntensity;
    this.vignettePass.uniforms.baseColor.value = new THREE.Color(0x000000);
    
    // State tracking
    this.damageChromaticIntensity = 0;
    this.isBeingHealed = false;
    this.healPulseTime = 0;
    this.currentHealth = 100;
    this.maxHealth = 100;
    
    // Overlay vignette targets (for damage/heal)
    this.overlayTargetIntensity = 0;
    this.overlayTargetColor = new THREE.Color(0x000000);
  }

  // ==================== TRIGGERS ====================

  onHit(damage, direction) {
    // Camera effects
    if (this.settings.camera.shakeEnabled) {
      const intensity = Math.min(damage / 50, 1) * this.settings.camera.shakeIntensity;
      this.cameraShake.trigger(intensity);
    }
    
    if (this.settings.camera.punchEnabled && direction) {
      this.cameraPunch.trigger(direction);
    }
    
    // Damage vignette (red flash overlay)
    if (this.settings.damage.damageVignetteEnabled) {
      this.vignettePass.uniforms.overlayIntensity.value = 0.5;
      this.vignettePass.uniforms.overlayColor.value = new THREE.Color(0x330000);
    }
    
    // Damage chromatic (spike)
    if (this.settings.damage.chromaticEnabled) {
      const intensity = Math.min(damage / 50, 1);
      this.damageChromaticIntensity = intensity * 0.02;
    }
    
    // Other damage effects
    if (this.settings.damage.noiseEnabled) {
      const intensity = Math.min(damage / 50, 1);
      this.damagePass.uniforms.noiseIntensity.value = intensity * 0.3;
    }
    
    if (this.settings.damage.glitchEnabled) {
      const intensity = Math.min(damage / 50, 1);
      this.damagePass.uniforms.glitchIntensity.value = intensity * 0.2;
    }
  }

  onNearExplosion(distance, maxRange) {
    const intensity = 1 - (distance / maxRange);
    
    // Big camera shake
    if (this.settings.camera.shakeEnabled) {
      this.cameraShake.trigger(intensity * 0.8 * this.settings.camera.shakeIntensity);
    }
    
    // Brief visual disruption (no vignette change - wasn't hurt)
    if (this.settings.damage.chromaticEnabled) {
      this.damageChromaticIntensity += intensity * 0.01;
    }
    
    if (this.settings.damage.noiseEnabled) {
      this.damagePass.uniforms.noiseIntensity.value = intensity * 0.15;
    }
    
    if (this.settings.damage.glitchEnabled) {
      this.damagePass.uniforms.glitchIntensity.value = intensity * 0.1;
    }
  }

  onFire() {
    if (this.settings.camera.recoilEnabled) {
      this.cameraRecoil.trigger();
    }
  }

  setHealth(current, max) {
    this.currentHealth = current;
    this.maxHealth = max;
    const percent = current / max;
    
    // Update overlay vignette target based on health (damage only, not cinematic)
    if (this.settings.damage.damageVignetteEnabled && percent < 0.3) {
      this.overlayTargetIntensity = 0.3;
      this.overlayTargetColor = new THREE.Color(0x220000);
    } else {
      this.overlayTargetIntensity = 0;
      this.overlayTargetColor = new THREE.Color(0x000000);
    }
    
    // Sustained damage effects at low health
    if (percent < 0.4) {
      const severity = (0.4 - percent) / 0.4; // 0 to 1
      
      if (this.settings.damage.scanlinesEnabled) {
        this.damagePass.uniforms.scanlineIntensity.value = severity * 0.3;
      }
      
      if (this.settings.damage.chromaticEnabled) {
        this.damageChromaticIntensity = Math.max(
          this.damageChromaticIntensity,
          severity * 0.008
        );
      }
    }
  }

  startHealing() {
    this.isBeingHealed = true;
  }

  stopHealing() {
    this.isBeingHealed = false;
  }

  onDeath() {
    // Max out all effects
    if (this.settings.camera.shakeEnabled) {
      this.cameraShake.trigger(1.0 * this.settings.camera.shakeIntensity);
    }
    
    if (this.settings.damage.chromaticEnabled) {
      this.damageChromaticIntensity = 0.03;
    }
    
    if (this.settings.damage.scanlinesEnabled) {
      this.damagePass.uniforms.scanlineIntensity.value = 0.8;
    }
    
    if (this.settings.damage.noiseEnabled) {
      this.damagePass.uniforms.noiseIntensity.value = 0.6;
    }
    
    if (this.settings.damage.glitchEnabled) {
      this.damagePass.uniforms.glitchIntensity.value = 0.5;
    }
    
    // Max red overlay
    if (this.settings.damage.damageVignetteEnabled) {
      this.vignettePass.uniforms.overlayIntensity.value = 0.6;
      this.vignettePass.uniforms.overlayColor.value = new THREE.Color(0x330000);
    }
    
    // Signal loss sequence (death only)
    if (this.settings.damage.signalLossEnabled) {
      this.playSignalLossSequence();
    }
  }

  playSignalLossSequence() {
    const timeline = [
      { time: 0, signalLoss: 0.3 },
      { time: 100, signalLoss: 0.1 },
      { time: 200, signalLoss: 0.5 },
      { time: 300, signalLoss: 0.2 },
      { time: 500, signalLoss: 0.7 },
      { time: 700, signalLoss: 0.4 },
      { time: 900, signalLoss: 1.0 },
    ];
    
    timeline.forEach(({ time, signalLoss }) => {
      setTimeout(() => {
        this.damagePass.uniforms.signalLoss.value = signalLoss;
      }, time);
    });
  }

  // ==================== UPDATE ====================

  update(delta) {
    // Update camera effects
    this.cameraShake.update(delta);
    this.cameraRecoil.update(delta);
    this.cameraPunch.update(delta);
    
    // Update time for shaders
    this.damagePass.uniforms.time.value += delta;
    
    // ===== Chromatic Aberration =====
    let chromaticTotal = 0;
    
    // Base chromatic (always subtle)
    if (this.settings.cinematic.chromaticEnabled) {
      chromaticTotal += this.settings.cinematic.chromaticIntensity;
    }
    
    // Damage chromatic (spikes, decays)
    if (this.settings.damage.chromaticEnabled && this.damageChromaticIntensity > 0) {
      chromaticTotal += this.damageChromaticIntensity;
      this.damageChromaticIntensity *= 0.95; // Decay
    }
    
    this.chromaticPass.uniforms.intensity.value = chromaticTotal;
    
    // ===== Vignette =====
    // Base cinematic vignette stays constant (never changes)
    // Only overlay vignette changes for damage/heal
    
    if (this.isBeingHealed && this.settings.damage.healVignetteEnabled) {
      // Green healing pulse (overlay)
      this.healPulseTime += delta * 4;
      const pulse = (Math.sin(this.healPulseTime) + 1) / 2;
      this.vignettePass.uniforms.overlayColor.value = new THREE.Color(0x003300);
      this.vignettePass.uniforms.overlayIntensity.value = 0.2 + (pulse * 0.15);
    } else {
      this.healPulseTime = 0;
      
      // Decay overlay vignette to target (0 when healthy, red tint when low HP)
      this.vignettePass.uniforms.overlayIntensity.value = THREE.MathUtils.lerp(
        this.vignettePass.uniforms.overlayIntensity.value,
        this.overlayTargetIntensity,
        delta * 5
      );
      
      this.vignettePass.uniforms.overlayColor.value.lerp(
        this.overlayTargetColor,
        delta * 5
      );
    }
    
    // ===== Decay damage effects =====
    const noiseDecay = 0.9;
    const glitchDecay = 0.92;
    
    if (this.currentHealth / this.maxHealth > 0.4) {
      // Only decay if not in low health state
      this.damagePass.uniforms.noiseIntensity.value *= noiseDecay;
      this.damagePass.uniforms.glitchIntensity.value *= glitchDecay;
      this.damagePass.uniforms.scanlineIntensity.value *= 0.95;
    }
    
    // ===== Enable/disable passes based on settings =====
    this.bloomPass.enabled = this.settings.cinematic.bloomEnabled;
    this.lensDirtPass.enabled = this.settings.cinematic.lensDirtEnabled;
    this.chromaticPass.enabled = this.settings.cinematic.chromaticEnabled || this.settings.damage.chromaticEnabled;
    this.vignettePass.enabled = this.settings.cinematic.vignetteEnabled || 
                                this.settings.damage.damageVignetteEnabled || 
                                this.settings.damage.healVignetteEnabled;
  }

  // ==================== SETTINGS ====================

  updateSettings(newSettings) {
    this.settings = newSettings;
    
    // Update bloom
    this.bloomPass.strength = this.settings.cinematic.bloomIntensity;
    
    // Update lens dirt
    this.lensDirtPass.uniforms.intensity.value = this.settings.cinematic.lensDirtIntensity;
    
    // Update base vignette (constant, only changes when settings change)
    this.vignettePass.uniforms.baseIntensity.value = this.settings.cinematic.vignetteIntensity;
  }
}
```

---

## Event Integration

```javascript
// Create manager
const visualEffects = new VisualEffectsManager(camera, composer, visualSettings);

// Connect to game events
player.on('damaged', (damage, direction) => {
  visualEffects.onHit(damage, direction);
  visualEffects.setHealth(player.health, player.maxHealth);
});

player.on('explosion', (position, radius) => {
  const distance = player.position.distanceTo(position);
  if (distance > radius && distance < radius * 2.5) {
    visualEffects.onNearExplosion(distance, radius * 2.5);
  }
});

player.on('fire', () => {
  visualEffects.onFire();
});

player.on('healStart', () => {
  visualEffects.startHealing();
});

player.on('healStop', () => {
  visualEffects.stopHealing();
});

player.on('healTick', (amount) => {
  visualEffects.setHealth(player.health, player.maxHealth);
});

player.on('death', () => {
  visualEffects.onDeath();
});

// Animation loop
function animate(delta) {
  visualEffects.update(delta);
  composer.render();
}
```

---

## Visual Timelines

### Near Explosion (no damage)

```
0ms        100ms      300ms      500ms
│          │          │          │
Boom!      Shake +    Fading     Back to
           Noise +               normal
           Glitch
           (no red)
```

### Direct Hit

```
0ms        100ms      300ms      1000ms
│          │          │          │
Hit!       Red +      Fading     Settles to
           Chromatic  out        HP-based
           + Noise               baseline
           + Shake
```

### Low HP (constant)

```
Subtle persistent effects:
├── Red vignette tint
├── Wobbly chromatic
├── Occasional scanlines
└── Random noise flickers

No signal loss (yet alive)
```

### Being Healed

```
Green vignette pulses gently
├── Intensity: 0.3 → 0.45 → 0.3 (sine wave)
├── Color: dark green (0x003300)
└── Stops immediately when healing stops
```

### Death

```
0ms    200ms   400ms   600ms   800ms   1000ms
│      │       │       │       │       │
Hit!   Glitch  Flicker Worse   Dying   BLACK
       MAX     signal  flicker signal  
                                       [Death Screen]
```

---

## Performance Summary

| Effect | GPU Cost | Notes |
|--------|----------|-------|
| Bloom | 5-10% | Most expensive |
| Lens Dirt | 1-3% | Uses bloom output |
| Chromatic Aberration | 1-2% | 3 texture samples |
| Vignette | <1% | Very cheap |
| Damage Effects (combined) | 3-5% | Only when active |
| **Total** | **~10-20%** | All toggleable |

---

## Debug GUI

For testing during development:

```javascript
import GUI from 'lil-gui';

const gui = new GUI();

// Camera
const cameraFolder = gui.addFolder('Camera Effects');
cameraFolder.add(settings.camera, 'shakeEnabled').name('Screen Shake');
cameraFolder.add(settings.camera, 'shakeIntensity', 0, 2).name('Shake Intensity');
cameraFolder.add(settings.camera, 'recoilEnabled').name('Recoil');
cameraFolder.add(settings.camera, 'punchEnabled').name('Punch');

// Cinematic
const cinematicFolder = gui.addFolder('Cinematic');
cinematicFolder.add(settings.cinematic, 'bloomEnabled').name('Bloom');
cinematicFolder.add(settings.cinematic, 'bloomIntensity', 0, 2).name('Bloom Intensity');
cinematicFolder.add(settings.cinematic, 'vignetteEnabled').name('Vignette');
cinematicFolder.add(settings.cinematic, 'vignetteIntensity', 0, 1).name('Vignette Intensity');
cinematicFolder.add(settings.cinematic, 'lensDirtEnabled').name('Lens Dirt');
cinematicFolder.add(settings.cinematic, 'lensDirtIntensity', 0, 1).name('Lens Dirt Intensity');
cinematicFolder.add(settings.cinematic, 'chromaticEnabled').name('Chromatic');
cinematicFolder.add(settings.cinematic, 'chromaticIntensity', 0, 0.01).name('Chromatic Intensity');

// Damage
const damageFolder = gui.addFolder('Damage Effects');
damageFolder.add(settings.damage, 'damageVignetteEnabled').name('Damage Vignette');
damageFolder.add(settings.damage, 'healVignetteEnabled').name('Heal Vignette');
damageFolder.add(settings.damage, 'chromaticEnabled').name('Damage Chromatic');
damageFolder.add(settings.damage, 'scanlinesEnabled').name('Scanlines');
damageFolder.add(settings.damage, 'noiseEnabled').name('Noise');
damageFolder.add(settings.damage, 'glitchEnabled').name('Glitch');
damageFolder.add(settings.damage, 'signalLossEnabled').name('Signal Loss');

// Test triggers
const testFolder = gui.addFolder('Test Triggers');
testFolder.add({
  simulateHit: () => visualEffects.onHit(30, new THREE.Vector3(1, 0, 0))
}, 'simulateHit').name('Simulate Hit');

testFolder.add({
  simulateExplosion: () => visualEffects.onNearExplosion(50, 100)
}, 'simulateExplosion').name('Near Explosion');

testFolder.add({
  setLowHealth: () => visualEffects.setHealth(20, 100)
}, 'setLowHealth').name('Set Low HP (20%)');

testFolder.add({
  setFullHealth: () => visualEffects.setHealth(100, 100)
}, 'setFullHealth').name('Set Full HP');

testFolder.add({
  startHealing: () => visualEffects.startHealing()
}, 'startHealing').name('Start Healing');

testFolder.add({
  stopHealing: () => visualEffects.stopHealing()
}, 'stopHealing').name('Stop Healing');

testFolder.add({
  simulateDeath: () => visualEffects.onDeath()
}, 'simulateDeath').name('Simulate Death');
```

---

## Lore Integration

Tusk commentary on visual effects:

**Low HP:**
> "Your clone's optical feed is degrading. Maybe don't get shot so much."

> "Signal integrity at 20%. AdLands is not responsible for visual artifacts."

**Death:**
> "Signal lost. Your current clone has been... discontinued."

> "Connection terminated. Replacement clone available for a small Crypto fee."

**Being healed:**
> "Structural repairs in progress. Try not to waste the medic's time."

---

## Recommended Defaults

```javascript
const defaultSettings = {
  camera: {
    shakeEnabled: true,
    shakeIntensity: 1.0,
    recoilEnabled: true,
    punchEnabled: true
  },
  cinematic: {
    bloomEnabled: true,
    bloomIntensity: 0.5,
    vignetteEnabled: true,
    vignetteIntensity: 0.3,
    lensDirtEnabled: true,
    lensDirtIntensity: 0.5,
    chromaticEnabled: true,
    chromaticIntensity: 0.0015
  },
  damage: {
    damageVignetteEnabled: true,
    healVignetteEnabled: true,
    chromaticEnabled: true,
    scanlinesEnabled: true,
    noiseEnabled: true,
    glitchEnabled: true,
    signalLossEnabled: true
  }
};
```

---

## Quality Presets

For players who don't want to tweak individual settings:

```javascript
const qualityPresets = {
  off: {
    camera: { shakeEnabled: false, recoilEnabled: false, punchEnabled: false },
    cinematic: { bloomEnabled: false, vignetteEnabled: false, lensDirtEnabled: false, chromaticEnabled: false },
    damage: { damageVignetteEnabled: false, healVignetteEnabled: false, chromaticEnabled: false, scanlinesEnabled: false, noiseEnabled: false, glitchEnabled: false, signalLossEnabled: false }
  },
  
  low: {
    camera: { shakeEnabled: true, shakeIntensity: 0.5, recoilEnabled: true, punchEnabled: false },
    cinematic: { bloomEnabled: false, vignetteEnabled: true, vignetteIntensity: 0.2, lensDirtEnabled: false, chromaticEnabled: false },
    damage: { damageVignetteEnabled: true, healVignetteEnabled: true, chromaticEnabled: false, scanlinesEnabled: false, noiseEnabled: false, glitchEnabled: false, signalLossEnabled: true }
  },
  
  medium: {
    camera: { shakeEnabled: true, shakeIntensity: 1.0, recoilEnabled: true, punchEnabled: true },
    cinematic: { bloomEnabled: true, bloomIntensity: 0.4, vignetteEnabled: true, vignetteIntensity: 0.3, lensDirtEnabled: false, chromaticEnabled: true, chromaticIntensity: 0.001 },
    damage: { damageVignetteEnabled: true, healVignetteEnabled: true, chromaticEnabled: true, scanlinesEnabled: false, noiseEnabled: true, glitchEnabled: false, signalLossEnabled: true }
  },
  
  high: {
    camera: { shakeEnabled: true, shakeIntensity: 1.0, recoilEnabled: true, punchEnabled: true },
    cinematic: { bloomEnabled: true, bloomIntensity: 0.5, vignetteEnabled: true, vignetteIntensity: 0.3, lensDirtEnabled: true, lensDirtIntensity: 0.5, chromaticEnabled: true, chromaticIntensity: 0.0015 },
    damage: { damageVignetteEnabled: true, healVignetteEnabled: true, chromaticEnabled: true, scanlinesEnabled: true, noiseEnabled: true, glitchEnabled: true, signalLossEnabled: true }
  }
};
```

Settings UI:
```
Post-Processing Quality: [Off] [Low] [Medium] [High] [Custom]
```

Selecting "Custom" reveals all individual toggles.
