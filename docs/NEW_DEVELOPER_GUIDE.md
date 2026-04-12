# AdLands: New Developer Guide

## What Is AdLands?

AdLands is a browser-based multiplayer territorial warfare game set in 2084. Three mercenary factions fight for control of hexagonal territory on an artificial planet being constructed in Earth's orbit. Each hex is sponsored ad space rented by real-world corporate sponsors -- their logos become the battlefield. Players capture territories to earn XP, cosmetics, and real-world coupon codes.

It's a corporate dystopia satire with a PS1-era low-poly art style and modern lighting.

---

## The Factions

| Faction | Name | Color | Vibe |
|---------|------|-------|------|
| Rust (Red) | The Scrappers | `#8B3A3A` | Guerrilla rebels, improvised tech |
| Cobalt (Blue) | The Enforcers | `#3A5F7D` | Corporate military, clean lines |
| Viridian (Green) | The Unknowns | `#4A5C3A` | Mysterious origin, experimental tech |

Factions are purely cosmetic -- no stat differences.

---

## Core Gameplay Loop

1. Drive a tank across a hexagonal sphere (the planet)
2. Fight enemy tanks from rival factions
3. Capture sponsor-branded hex clusters by standing on control points
4. Hold territory to earn XP and rewards
5. Respawn on death, repeat

### Combat

- **Primary weapon:** Homing missiles (click to fire)
- **Shield (E):** 3s invulnerability, 10s cooldown
- **Flares (Q):** Redirect enemy missiles, 2 charges, 12s recharge each
- **Skill tree:** 3 branches (Offense, Defense, Mobility) with deployables (mines, turrets, AI soldiers) and ultimate abilities

### Commander Role

The #1 ranked player in each faction becomes Commander, gaining gold tank trim, 2 AI bodyguard escorts, orbital intel (see all players), drawing tools, and an XP tip budget.

---

## The World

- **Planet geometry:** A sphere covered in hexagonal tiles (hexasphere)
- **Day/night cycle:** ~20-25 min full rotation with sun and moon lighting
- **Fast travel:** 6-12 portals across the surface with a zoom-out/zoom-in teleport animation
- **Earth** is visible in the background skybox
- **Elon Tusk:** The satirical CEO provides live sports-announcer commentary ("Hostile eliminated! Excellent aggression metrics!")

---

## Monetization

**Sponsor-funded, zero microtransactions.**

- Real companies rent hex clusters ($1-3/hex/month)
- Sponsor logos display on the planet surface in grayscale with a faction color tint
- Players earn real coupon codes for holding sponsor territories
- The planet grows when 75% of hexes are rented

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS (ES6 classes), Three.js v0.128 |
| Backend | Node.js 18+, Express, Socket.IO 4 |
| Database | Firebase Firestore + Firebase Auth |
| Deployment | VPS via GitHub + PM2 |

**No TypeScript. No bundler. No test framework. No frontend framework.**

---

## Project Structure (Key Directories)

```
js/                  # Client-side JS (68 files loaded via <script defer>)
  core/              # Planet, Camera, Environment, Auth, Multiplayer, main.js
  tank/              # Tank physics, collision, pathfinding, bots
  combat/            # Weapons, projectiles, object pools
  commander/         # Commander role, squad leadership, bodyguards
  effects/           # Shaders, post-processing, visual effects
  ui/                # AuthScreen, Dashboard, CosmeticsShop, ProfileCard
  progression/       # XP, leveling, badges, titles
  admin/             # Admin portal logic
  travel/            # Fast travel portals
  sponsors/          # Sponsor 3D showcase scene
server/              # Node.js backend
  index.js           # Express + Socket.IO entry point
  GameRoom.js        # Core game loop + multiplayer state (~106KB)
  WorldGenerator.js  # Procedural planet generation
  shared/            # Code shared with client (physics, hexasphere, Vec3)
css/                 # Stylesheets (shared-tokens.css has all design tokens)
assets/              # 3D models, sprites, fonts
sponsors/            # Sponsor logo images
data/sponsors.json   # Sponsor config with base64 textures
docs/                # GDD, feature docs
```

### Key Files to Know

| File | What It Does |
|------|-------------|
| `server/index.js` | Server entry point |
| `server/GameRoom.js` | All game state, tick loop, multiplayer logic |
| `js/core/main.js` | Client entry point and game loop (~4K lines) |
| `js/core/Planet.js` | Planet rendering and terrain (~5K lines) |
| `js/core/MultiplayerClient.js` | Client-side networking |
| `js/tank/Tank.js` | Tank mechanics and physics |
| `index.html` | Game client (loads all 68 JS files) |
| `admin.html` | Admin portal for sponsor/territory management |

---

## How To Run It

```bash
cd server
npm install
npm run dev     # Dev server with --watch auto-restart (default port 3000)
```

Firebase credentials are optional for dev mode (auth verification is disabled without them).

---

## Architecture Highlights

- **Multiplayer:** Socket.IO with WebSocket-only transport, 10 tick/sec server loop
- **Rendering:** Three.js with custom post-processing (bloom, lens dirt, vignette, chromatic aberration)
- **Physics:** Custom 2D vehicle physics projected onto 3D sphere terrain, shared between client and server via `server/shared/`
- **Bots:** Run on a Worker Thread (`BotWorkerBridge.js`) to keep the main thread at ~1-2ms per tick. Target: 300 total tanks on the map at all times (bots fill in for missing players)
- **Player cap:** ~150 players per room (150 players + 150 bots = sweet spot)
- **Sponsor textures:** Stored as base64 in `data/sponsors.json`, extracted to PNG at server startup

---

## Code Conventions

- **Frontend:** Global-scope ES6 classes, no imports/exports. All loaded via `<script>` tags
- **Backend:** CommonJS (`require`/`module.exports`)
- **Types:** JSDoc annotations instead of TypeScript
- **Performance:** Pre-allocated temp objects, typed arrays, object pooling, LOD systems
- **CSS:** All design tokens in `css/shared-tokens.css` -- use CSS variables, never hardcode colors
- **Fonts:** Only 3 allowed -- Header (Spleen 16x32), Body (Atari ST 8x16), Small (Ark Pixel 12px). All bitmap/pixel fonts
- **Math:** Use `MathUtils.lerp()`, `.clamp()`, `.smoothstep()` etc. from `js/utils/mathUtils.js`

---

## Things That Will Surprise You

- The entire frontend is 68 separate JS files with no module system -- all globals
- `GameRoom.js` is ~106KB in a single file -- it's the heart of the server
- The project lives in a Dropbox-synced folder, so atomic writes (tmp + rename) will crash the server
- There are no tests -- correctness is verified by running the game
- The planet is a real 3D sphere with hexagonal tiles, not a flat map
- Deployment is `git push` then `ssh root@adlands "cd ~/AdLands && git pull && pm2 restart adlands"`

---

## Further Reading

- [AdLands_gdd.md](AdLands_gdd.md) -- Full game design document
- [adlands-commander-role.md](adlands-commander-role.md) -- Commander system details
- [adlands-visual-effects-system.md](adlands-visual-effects-system.md) -- Post-processing and shader pipeline
- [adlands-dashboard-prompt-v3.md](adlands-dashboard-prompt-v3.md) -- Dashboard UI spec
