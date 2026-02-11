# AdLands: Game Design Document

**Full Title:** AdLands - Humanity's Second Chance™  
**Genre:** Top-down vehicle combat, territorial control, browser-based MMO  
**Platform:** Web browser (desktop primary, mobile secondary)  
**Art Style:** PS1-era low-poly with modern PBR lighting  
**Monetization:** Sponsor-funded (hex rental model)

---

## Executive Summary

AdLands is a browser-based territorial warfare game where three mercenary factions fight for control of an artificial planet being constructed in Earth's orbit. The planet's hexagonal surface serves as advertising space rented by real-world corporate sponsors. Players capture and hold sponsor-branded territories to earn rewards (XP, cosmetics, real-world coupon codes).

**What Makes It Unique:**
- Sponsor-funded model: Real brands rent hexagonal territories, their logos become the battlefield
- Living world: Planet physically expands as more sponsors join
- Real rewards: Players earn actual discount codes from sponsors
- Corporate dystopia satire: The planet itself is a corporation (AdLands)
- Retro-modern aesthetic: PS1 low-poly visuals with contemporary lighting

**Target Audience:** 25-40 year olds, nostalgia for PS1 era, enjoy competitive multiplayer, appreciate satire

---

## Core Concept

### The Setup
Year 2084. Earth is overpopulated and depleted. Mega-corporations pooled resources to fund **The AdLands Project**—construction of an artificial planet in Earth's orbit. **AdLands** manages construction and operation of humanity's "second chance."

Three mercenary factions (Red, Blue, Green) fight for territorial control as the planet is built module-by-module. Players are hired guns fighting for corporate interests on a world that is itself a corporate asset.

### The Gameplay Loop (30 seconds)
1. Move tank across hexagonal battlefield
2. Engage enemies from rival factions
3. Capture sponsor-branded hex clusters
4. Hold territory to earn rewards
5. Respawn when destroyed, repeat

### The Meta Loop (long-term)
- Earn XP → Level up → Unlock skills → Specialize build
- Join squad → Coordinate on faction board → Execute raids
- Sponsors expand planet → New territories open → Land rush events
- Earn cosmetics and real-world rewards → Prestige and tangible value

---

## World & Lore

### Setting
**Year 2084.** Earth is overpopulated and depleted. Mega-corporations pooled resources to fund **The AdLands Project**—construction of an artificial planet in Earth's orbit. **AdLands** (a limited liability company) was formed to manage the construction and operation of humanity's "second chance."

Three mercenary factions fight for territorial control as the planet is built module-by-module. Players are hired guns, fighting for corporate interests on a world that is itself a corporate asset.

### The Corporation
**AdLands** (AdLands Holdings, Inc.)
- Owns and operates the artificial planet
- Funds construction through corporate sponsorships
- Manages territorial contracts and mercenary operations
- Tagline: "Humanity's Second Chance™"
- Motto: "Construct. Conquer. Consume."

**The CEO: Elon Tusk**
- Founder and visionary of AdLands
- Provides live sports-announcer-style commentary throughout gameplay
- Satirical take on tech billionaire culture
- Genuinely believes he's saving humanity while treating mercenaries as "engagement metrics"
- (Full character details in "Characters & Narrative" section below)

### The Three Factions

**Abstract mercenary teams (not tied to sponsors):**

**Red Faction: "The Scrappers"**
- Guerrilla fighters, improvised tech, underdog rebels
- Visual: Rust red, welded scrap metal, asymmetrical tanks
- Vibe: CS terrorists, Soviet tech, Star Wars Rebels

**Blue Faction: "The Enforcers"**  
- Corporate military, professional soldiers, modern tech
- Visual: Steel blue, clean lines, symmetrical tanks
- Vibe: CS counter-terrorists, NATO, Star Wars Empire

**Green Faction: "The Unknowns"**
- Mysterious origin, experimental/alien tech, wildcards
- Visual: Olive green, bioluminescent accents, organic curves
- Vibe: Half-Life Combine, unknown supernatural/alien influence

**Note:** Factions are purely aesthetic. No stat differences. Players pick based on vibe.

### Design Pillars

1. **Accessibility:** Low barrier to entry, anyone can jump in and play
2. **Clarity:** Faction control, sponsor identity, and rewards are always visually clear
3. **Fairness:** Factions are balanced, no pay-to-win
4. **Satire:** Corporate dystopia theme is darkly humorous, not preachy
5. **Respect:** Sponsors get value, players get rewards, no exploitation

---

## Core Gameplay Systems

### Map & Movement

**The Planet (Spherical Hex Grid):**
- 3D sphere covered in hexagonal tiles
- Camera: Top-down bird's-eye view, always oriented "north = top of screen"
- Playable area: 70°N to 70°S latitude (polar exclusion zones prevent camera issues)
- Day/Night cycle: Planet rotates, sun on one side, moon on opposite (20-25 min full cycle)
- Earth visible in background from planetary view

**Starting Size & Expansion:**
- Launch: 5,000-10,000 hexes ("Asteroid" phase)
- Trigger: When 75% of hexes are rented by sponsors
- Event: "New sector fabrication complete"—planet visibly grows
- Visual: Construction scaffolding, skeletal frameworks "filling in"

**Portal System (Fast Travel):**
- 6-12 portals evenly distributed across planet
- Right-click portal → camera zooms to planetary view → rotate planet → preview destination → teleport
- Preview window shows live ground-level feed (anti-camping)
- Cooldown: 30 seconds between uses

### Territory Control

**Hex Clusters:**
- Sponsors rent groups of hexagons (3x3 to 50x50+)
- Clusters have central control point
- Capture time scales with cluster size

**Capture Mechanic:**
- Stand near control point for X seconds
- Enemies entering zone pause progress
- Cluster changes to controlling faction's color
- Sponsor logo receives faction color overlay

**Faction Colors:**
- Red: `#8B3A3A` (rust red)
- Blue: `#3A5F7D` (steel blue)
- Green: `#4A5C3A` (military olive)

**Sponsor Logos:**
- Displayed in grayscale
- Receive faction color wash when controlled
- Maintains brand recognition while showing ownership

### Combat System

**Vehicle: Tank**
- Movement: WASD controls
- Weapon: Homing missiles (accessible, low skill floor)
- Health: Respawn on death at faction spawn points

**Combat Mechanics:**
- Point and click to fire
- Projectiles: Homing missiles with slight arc
- Effects: Muzzle flashes and explosions tinted by faction color

**Defensive Abilities:**

**Energy Shield (E key):**
- Duration: 3 seconds
- Complete invulnerability (blocks infinite damage)
- Cooldown: 10 seconds
- Pure timing-based skill expression

**Flares (Q key):**
- Charges: 2
- Redirects homing missiles to flare position
- Recharge: 12 seconds per charge

### Progression Systems

**XP Sources:**
- Capturing hexes
- Holding territory over time
- Enemy kills and assists
- Faction objectives

**Skill Tree (Full details in "Advanced Systems" section):**
- Three branches: Offense, Defense, Mobility
- 5 tiers each, max level 50
- Unlock deployables (turrets, soldiers, mines)
- Ultimate abilities at tier 5

**Cosmetics:**
- Faction-specific tank skins, decals, effects
- Unlocked through progression milestones

**Real-World Rewards:**
- Sponsor-specific coupon codes for extended holds
- Example: Hold Burger King territory 24hrs → discount code

---

## Monetization Model

### Sponsor Hex Rental

**Pricing:**
- Base: $1/hex/month
- Tiers:
  - **Basic ($1/hex):** Logo displayed, faction tint, intel panel visibility
  - **Premium ($2-3/hex):** + clickable website link + coupon reward capability

**Sponsor Platform:**
- Visual hex selection tool
- Customizable rewards (XP, cosmetics, coupons)
- Analytics dashboard (impressions, clicks, captures, hold time)

**Expansion Model:**
- Planet grows when 75% occupied
- New hexes added at base price
- Early sponsors get legacy pricing (grandfathered)

**Revenue Scaling:**
- Launch: 1,000 hexes = $1,000/month
- Growth: 10,000 hexes = $10,000/month
- Mature: 100,000 hexes = $100,000/month

### Player-Facing Monetization
**Zero.** No microtransactions, no cosmetic shop, no pay-to-win.

All progression through gameplay. All cosmetics earned. Real-world rewards from sponsors are bonuses, not core loop.

---

## Visual & Audio Design

### Art Direction: "Elevated PS1"

**Retro Elements:**
- Low-poly models (200-500 polygons for tanks)
- Pixelated textures (64x64 to 256x256)
- Vertex jitter (PS1 wobble)
- Draw distance fog
- Sprite-based particles

**Modern Elements:**
- PBR materials (Diffuse, Roughness, Metallic maps)
- Real-time dynamic lighting
- Modern shadows
- Smooth camera controls

**Color Palette:**
- Environment: Muted grays, browns (desaturated)
- Factions: Desaturated red/blue/green (pop against background)
- Danger zones: `#D9A441` (hazard yellow-orange)
- Portals: `#3A9396` (cyan/teal)

### Lighting System

**Sun (Directional Light):**
- Warm orange-yellow (`#FFAA66`)
- Harsh shadows
- Day side illumination

**Moon (Directional Light):**
- Cool blue-gray (`#4466AA`)
- Soft/no shadows
- Night side illumination

**Dynamic Lights:**
- Explosions: Orange core + faction-tinted particles
- Muzzle flashes: Faction-colored, brief duration
- Shield bubbles: Faction-colored glow

### Audio Design

**Combat:**
- Tank engine (faction-specific rumbles)
- Weapon fire (missile launch whoosh)
- Explosions (low-poly boom, screen shake)
- Shield activation (deep bass whooom)
- Successful block (loud CLANG)

**Ambient:**
- Construction sounds (distant welding, machinery)
- Radio chatter (faction comms)
- Elon Tusk commentary (murmur + subtitles)

---

## Community Features

### Squads/Clans System

**Core Features:**
- Create squad (max 50 members)
- Squad name + tag (e.g., "[WOLF]" PlayerName)
- Squad-specific chat channel
- Squadmates highlighted on minimap
- Squad leaderboards

### Faction Message Board

**Design:**
- Faction-segregated (Red can't see Blue's posts)
- Reddit/Discord hybrid
- Text posts, upvote/downvote, comment threads
- Categories: Strategy, Recruitment, Trash Talk, General
- Accessible in-game and via web browser

**Purpose:**
- Coordinate raids ("FRIDAY 10PM - ADIDAS ATTACK")
- Foster faction identity and rivalry
- Create emergent gameplay moments

---

## Advanced Systems

(Full details of complex systems)

### Skill Tree System

**Overview:**
- Max level: 50 (50 skill points)
- Three specialization branches
- Unlock deployables and ultimate abilities
- Respec: Free every 7 days, or pay credits for instant

**Offense Tree (Red Path):**
- Theme: Damage, firepower, aggression
- Unlock: Land Mines (Proximity → Cluster → Heavy)
- Ultimate: Orbital Strike (massive AoE from space)

**Defense Tree (Blue Path):**
- Theme: Survivability, protection, tanking
- Unlock: AI Turrets (Light → Medium → Heavy)
- Ultimate: Guardian Shield (protect allies)

**Mobility Tree (Green Path):**
- Theme: Speed, positioning, evasion
- Unlock: AI Soldiers (Scout → Infantry → Heavy Trooper)
- Ultimate: Warp Teleport (instant repositioning)

### Deployable Weapons

**AI Turrets (Defense Tree):**
- Auto-targeting stationary defense
- Light (50 HP) → Medium (100 HP) → Heavy (200 HP)
- Max deployable increases with skill points (1 → 2 → 3)

**AI Foot Soldiers (Mobility Tree):**
- Mobile infantry that follows player or guards position
- Scout (30 HP) → Infantry (60 HP) → Heavy Trooper (120 HP)
- Max deployable increases with skill points (1 → 2 → 3)

**Land Mines (Offense Tree):**
- High-damage proximity traps
- Proximity (60 dmg) → Cluster (80 + AoE) → Heavy (150, one-shot)
- Max deployable increases with skill points (3 → 5 → 7)

**Auto-Replace System:**
- Placing new deployable at max capacity deactivates oldest
- Player chooses placement, system chooses replacement
- Visual/audio feedback on replacement

### Ultimate Abilities (Tier 5)

**Orbital Strike (Offense):**
- Massive AoE damage from space
- 4-second telegraphed warning
- 2-3 minute cooldown

**Guardian Shield (Defense):**
- Shields nearby allies for 3 seconds
- Team support ultimate

**Warp Teleport (Mobility):**
- Instant short-range repositioning
- 30-second cooldown

---

## Characters & Narrative

### The CEO: Elon Tusk

**Character Profile:**
- Founder and CEO of AdLands
- Low-poly 3D portrait (~200 polygons)
- Slicked hair, smug expression, expensive suit
- Genuinely believes he's saving humanity
- Treats warfare as "engagement metrics"

**Dynamic Commentary System:**

Tusk provides live sports-announcer-style commentary throughout gameplay.

**Example Lines:**
- On kill: *"Hostile eliminated! Excellent aggression metrics!"*
- On death: *"Cloning you now. That was expensive, by the way."*
- On capture: *"Territory monetized! Shareholders rejoice!"*
- On orbital strike: *"BOOM! That's disruptive innovation!"*

**Audio Implementation (MVP):**
- GTA1-style murmur + subtitles
- Generic "mwa mwa mwa" sound (3-5 variations)
- Text box appears with subtitle
- Auto-advances after reading time
- No voice acting (cost-effective, retro charm)

**Appearances:**
- Login screen (rotating messages)
- Tutorial onboarding
- Expansion event broadcasts
- Live commentary during gameplay
- Achievement congratulations
- Environmental storytelling (billboards, statues)

**Design Goals:**
- Add personality (world feels alive)
- Reinforce satire (corporate metrics)
- Create memorable moments
- Viral potential (players clip and share)

---

## Right-Click Territory Intel Panel

**Primary Mechanic:** Right-click any hex cluster to open info panel

**Information Displayed:**
- Sponsor identity (logo, brand name, website link)
- Cluster size (number of hexes)
- Controlling faction
- Hold duration (how long current faction has controlled it)
- Combat activity level (Low/Medium/High)
- Player count (active players in area)
- Rewards:
  - In-game: XP, cosmetics for capture/hold milestones
  - Real-world: Coupon codes for extended holds

**Purpose:**
- Tactical reconnaissance (plan attacks)
- Sponsor discovery (learn about brands)
- Reward preview (decide if objective is worth pursuing)
- Makes sponsor info feel integrated, not forced

---

## Technical Architecture

### Phase Overview
1. **Prototype:** Single-player, bots, prove core loop
2. **MVP:** Small multiplayer (50-100 players), basic sponsors
3. **Alpha:** Scaled multiplayer (500-1,000 players), full features
4. **Launch:** Full MMO infrastructure (5,000+ players)

### Tech Stack

**Client (Browser):**
- Three.js (3D rendering)
- Phaser.js (2D UI/HUD)
- JavaScript/TypeScript

**Server (Backend):**
- Node.js + Socket.io (MVP)
- PostgreSQL (territory state, player data)
- Redis (real-time state cache)
- Colyseus (Alpha - spatial partitioning)

**Hosting:**
- DigitalOcean/AWS (start small, scale up)
- CloudFlare CDN (asset delivery)

### Scalability Strategy
- Spatial partitioning (divide planet into zones)
- Zone servers handle 100-200 players each
- Update frequencies:
  - Player movement: 10-20 Hz (local zone only)
  - Territory control: 0.2 Hz (every 5 seconds, global)
  - Faction stats: 0.03 Hz (every 30 seconds)

---

## Development Phases

### PHASE 1: PROTOTYPE (2-4 Weeks)

**Goals:**
- Prove core gameplay loop is fun
- Validate hex sphere + tank combat + territory control
- Test visual aesthetic

**Must-Have Features:**
- Hexagonal sphere (5,000 hexes, camera controls)
- Player tank (WASD movement, homing missiles)
- Bot enemies (3 AI representing factions)
- Territory capture (hex color change on capture)
- Placeholder sponsor logos (fake brands)
- Basic sun/moon lighting

**Explicitly NOT Building:**
- Real multiplayer (use bots)
- Real sponsors (fake brands)
- Portals
- Rewards/progression
- Right-click intel panel
- Server infrastructure

**Success Criteria:**
- Core loop feels engaging for 10+ minutes
- Movement feels good
- Combat is satisfying
- Capture mechanic is clear

---

### PHASE 2: MVP (4-8 Weeks)

**Goals:**
- Add real multiplayer (50-100 players)
- Onboard 3-5 real sponsors
- Build basic sponsor platform
- Prove monetization model

**Must-Have Features:**
- WebSocket server (Node.js)
- Faction selection
- Portal system (6 portals, zoom-out teleport)
- Right-click intel panel (cluster info, rewards preview)
- Basic cosmetic unlocks (3-5 skins per faction)
- Sponsor platform (manual admin, hex selection, payment via Stripe)
- Elon Tusk commentary (~20 murmur lines)
- Squad system (create, join, chat)
- Faction message board (text posts, upvotes, comments)

**Success Criteria:**
- 50+ concurrent players without major lag
- 3-5 sponsors paying for hexes
- Monthly sponsor revenue covers server costs
- Players use portals and intel panel frequently

---

### PHASE 3: ALPHA (3-6 Months)

**Goals:**
- Scale to 500-1,000 players
- Onboard 50-100 sponsors
- Implement planet expansion
- Add full progression systems

**Must-Have Features:**
- Spatial partitioning (zone-based servers)
- Planet expansion system (automated triggers)
- Full skill tree (3 branches, 5 tiers)
- Deployable weapons (turrets, soldiers, mines)
- Ultimate abilities
- Real-world coupon system (code generation, account dashboard)
- Self-service sponsor platform
- Expanded Tusk commentary (100+ lines)
- Community moderation tools

**Success Criteria:**
- 500+ concurrent players during peak
- 50+ active sponsors
- Planet has expanded at least once
- Players redeeming real-world coupons
- Monthly revenue: $5,000-10,000
- 30%+ weekly player retention

---

### PHASE 4: LAUNCH (6-12 Months Post-Alpha)

**Goals:**
- Support 5,000-10,000+ players
- Onboard 500-1,000 sponsors
- Full MMO infrastructure
- Professional marketing push

**Features:**
- Enterprise-grade servers (Kubernetes, load balancing)
- Multiple server regions (NA, EU, Asia)
- Anti-cheat systems
- Mobile browser optimization
- Seasonal content updates
- Advanced analytics for sponsors

---

## Open Questions (To Be Resolved)

**Movement:**
- WASD direct control vs. click-to-move pathfinding? → Test in prototype

**Faction Switching:**
- Locked forever, cooldown, or seasonal? → Decide in MVP

**Sponsor Logo Treatment:**
- Full grayscale + tint vs. subtle overlay on original colors? → Test with sponsors

**Planet Expansion Schedule:**
- Fixed schedule vs. demand-based? → Learn from MVP data

---

## Appendix: Design References

**Visual Inspiration:**
- Metal Gear Solid (PS1 aesthetic)
- Command & Conquer (RTS warfare)
- Armored Core (vehicle combat)

**Gameplay Inspiration:**
- GTA1 (top-down perspective, murmur audio)
- Foxhole (persistent territorial warfare)
- Planetside 2 (faction-based MMO combat)
- Agar.io (browser-based, accessible multiplayer)

**Thematic Inspiration:**
- Cyberpunk dystopias (corporate control)
- Wall-E (Earth abandoned, corporate future)
- Robocop (satirical corporate excess)

---

**Document Version:** 1.0  
**Last Updated:** January 2026  
**Status:** Pre-Production → Prototype in Progress