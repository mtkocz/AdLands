# AdLands

Browser-based multiplayer territorial warfare game. Three mercenary factions (Rust, Cobalt, Viridian) fight for control of hexagonal territory on an artificial planet. Each hex is sponsored ad space rented by corporate sponsors — logos become the battlefield. Players capture territories to earn currency, cosmetics, and coupon codes.

## Tech Stack

- **Frontend:** Vanilla JavaScript (ES6 classes, no framework/bundler), Three.js v0.128 for 3D rendering
- **Backend:** Node.js 18+, Express, Socket.IO 4
- **Database:** Firebase Firestore + Firebase Authentication
- **Deployment:** Railway.app via Docker (Node 20-slim)

## Project Structure

```
js/                  # Client-side JavaScript (68 files, feature-based)
  core/              # Planet, Camera, Environment, Auth, Multiplayer, main.js
  tank/              # Tank physics, collision, pathfinding, bots
  combat/            # Weapons, projectiles
  commander/         # Commander role, squad leadership
  effects/           # Shaders, post-processing, visual effects
  ui/                # AuthScreen, Dashboard, CosmeticsShop, ProfileCard
  progression/       # XP, leveling, badges, titles
  admin/             # Admin portal logic
  travel/            # Fast travel portals
  utils/             # Helpers
server/              # Node.js backend
  index.js           # Entry point — Express + Socket.IO server
  GameRoom.js        # Core game loop and multiplayer state
  WorldGenerator.js  # Procedural planet generation
  firebaseAdmin.js   # Firebase Admin SDK init
  *SponsorStore.js   # Sponsor data management (3 variants)
  *sponsorRoutes.js  # Sponsor API endpoints (3 variants)
  BodyguardManager.js
  TuskGlobalChat.js  # In-game Elon Tusk commentary
  wipePlayerData.js  # Firestore data reset utility
  shared/            # Code shared with client
    physics.js       # Physics simulation
    hexasphere.js    # Hex sphere geometry
    TerrainElevation.js
    Vec3.js
css/                 # Stylesheets (main, auth, admin, shared-tokens)
assets/              # 3D models, sprites, fonts, cursors
sponsors/            # Sponsor logo images
data/sponsors.json   # Sponsor config with base64 textures
docs/                # GDD, feature docs
```

## Commands

All commands run from `server/`:

```bash
npm run dev          # Dev server with --watch auto-restart
npm start            # Production server
node wipePlayerData.js  # Wipe all player data from Firestore
```

## Environment Setup

1. Install dependencies: `cd server && npm install`
2. Firebase credentials — one of:
   - Set `GOOGLE_APPLICATION_CREDENTIALS` env var to path of service account JSON
   - Place key at `server/serviceAccountKey.json`
   - Skip for dev mode (auth verification disabled)
3. `PORT` env var (default: 3000)

## Code Conventions

- **No TypeScript, no bundler, no test framework**
- **Frontend:** Global-scope ES6 classes loaded via `<script>` tags in `index.html`. No ES module imports
- **Backend:** CommonJS (`require`/`module.exports`)
- **Types:** JSDoc annotations (`/** @type {Type} */`) instead of TypeScript
- **Performance patterns:** Pre-allocated temp objects, typed arrays (`Float32Array`, `Uint8Array`), instance pooling, LOD systems
- **Shared code:** `server/shared/` is served statically to the client at `/shared/`

## Architecture

- **Multiplayer:** Socket.IO with WebSocket-only transport (no HTTP long-polling). 10 tick/sec server game loop
- **Rendering:** Three.js with custom post-processing pipeline (bloom, lens dirt, vignette, chromatic aberration, damage effects)
- **Planet geometry:** Hexasphere — hexagonal tiles on a sphere surface
- **Physics:** Custom 2D vehicle physics projected onto 3D sphere terrain, shared between client and server
- **Sponsor textures:** Stored as base64 in `data/sponsors.json`, extracted to PNG files at server startup
- **Auth:** Firebase Auth on client, ID tokens verified server-side via Admin SDK
- **Data:** Firestore collections — `accounts`, `profiles` (subcollection), `territories`, `cosmetics`, `leaderboards`
- **CORS:** Open (`*`) for development

## Key Files

| File | Purpose |
|------|---------|
| `server/index.js` | Server entry point, Express + Socket.IO setup |
| `server/GameRoom.js` | Game state, tick loop, all multiplayer logic (~106KB) |
| `js/core/main.js` | Client entry point, game loop (~4K lines) |
| `js/core/Planet.js` | Planet rendering and terrain (~5K lines) |
| `js/core/MultiplayerClient.js` | Client networking (~1.6K lines) |
| `js/tank/Tank.js` | Tank mechanics and physics |
| `index.html` | Game client — loads all 68 JS files via script tags |
| `admin.html` | Admin portal for sponsor/territory management |
| `firestore.rules` | Firestore security rules |
