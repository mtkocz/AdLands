# Implement Dashboard System for AdLands

## Overview

Create a collapsible dashboard panel on the left side of the screen to balance the chat panels on the right. The dashboard should be toggleable with the H key and remember panel states between sessions.

## Layout Structure

```
┌─────────────────────┬─────────────────────────────────────┬──────────────────┐
│  [D A S H B O A R D]│                                     │  [C H A T]       │
│                     │                                     │                  │
│  ▼ Notifications (2)│                                     │  ▼ Proximity     │
│  ► Profile          │            G A M E                  │  ▼ Squad         │
│  ► Stats            │            V I E W                  │  ▼ Faction       │
│  ▼ Loadout          │                                     │  ► Global        │
│  ► Social           │                                     │                  │
│  ► Messages         │                                     │                  │
│  ► Tasks            │                                     │                  │
│  ► Share            │                                     │                  │
│  ► Settings         │                                     │                  │
└─────────────────────┴─────────────────────────────────────┴──────────────────┘
```

- Dashboard width: 250-300px
- ▼ = expanded, ► = collapsed
- Click header to toggle expand/collapse
- Badge counts show on collapsed headers (e.g., "Messages (3)")

---

## Panel Hierarchy and Contents

```
Dashboard (H to toggle)
│
├── Notifications (badge count)
│   ├── Friend requests
│   ├── Rewards to claim
│   └── System messages
│
├── Profile
│   ├── Picture (uploadable)
│   ├── Name
│   ├── Dynamic Title (see Title System below)
│   ├── Faction (dropdown - debug only)
│   ├── Squad (with leave button, or "join squad" if solo)
│   ├── Rank (within faction)
│   ├── XP bar + level
│   ├── Badges earned (see Badge System below)
│   ├── Total playtime
│   ├── Member since
│   └── Social links
│       ├── Twitter/X
│       ├── Twitch
│       ├── YouTube
│       ├── Discord
│       └── Custom URL
│
├── Stats
│   ├── Kills
│   ├── Deaths
│   ├── KD ratio
│   ├── Damage dealt
│   ├── Tics contributed
│   ├── Hexes captured
│   ├── Clusters captured
│   ├── Time since last death
│   ├── Longest life
│   └── Current killstreak
│
├── Loadout
│   ├── Offense slot (show tier, e.g., "Cannon III")
│   ├── Defense slot (show tier)
│   ├── Deployable slot (show tier)
│   └── Locked slots greyed out with level requirement shown
│
├── Social
│   ├── Friends list (online/offline status)
│   ├── Friend requests (accept/decline buttons)
│   ├── Squad roster (if in squad)
│   └── Invite to squad button
│
├── Messages
│   ├── Faction board (faction members only)
│   ├── Global board (all players)
│   └── DMs (direct messages)
│
├── Tasks
│   ├── Daily tasks
│   │   ├── Task description
│   │   ├── Progress bar
│   │   ├── Reward preview
│   │   └── Time remaining until reset
│   └── Weekly tasks
│       ├── Task description
│       ├── Progress bar
│       ├── Reward preview
│       └── Time remaining until reset
│
├── Share
│   ├── Screenshot button (captures game view)
│   ├── Caption field (editable)
│   ├── Auto-generated caption suggestions
│   ├── Quick share buttons:
│   │   ├── Twitter/X
│   │   ├── Reddit
│   │   ├── Discord (copy link)
│   │   └── Download image
│   └── Recent screenshots gallery (last 10)
│
└── Settings
    ├── Graphics
    │   ├── Resolution scale (slider)
    │   ├── Quality preset (Low/Medium/High dropdown)
    │   ├── FPS cap (30/60/Uncapped)
    │   ├── Particle density (slider)
    │   └── Shadows (on/off toggle)
    │
    ├── Audio
    │   ├── Master volume (slider)
    │   ├── SFX volume (slider)
    │   ├── Music volume (slider)
    │   └── UI sounds (on/off toggle)
    │
    ├── Controls
    │   ├── Key rebinding
    │   │   ├── Movement (WASD default)
    │   │   ├── Fire
    │   │   ├── Abilities (1, 2, 3)
    │   │   ├── Dashboard (H)
    │   │   ├── Chat toggle
    │   │   └── Quick ping
    │   ├── Mouse sensitivity (slider)
    │   └── Invert Y axis (toggle)
    │
    ├── Gameplay
    │   ├── Show damage numbers (on/off)
    │   ├── Show XP popups (on/off)
    │   ├── Minimap scale (slider)
    │   ├── Chat filter profanity (on/off)
    │   ├── Colorblind mode (off/deuteranopia/protanopia/tritanopia)
    │   └── Elon Tusk Commentary
    │       ├── Full (all quips and events)
    │       ├── Important only (captures, deaths, faction alerts)
    │       └── Off (silence the CEO)
    │
    ├── Account
    │   ├── Change username
    │   ├── Change email
    │   ├── Change password
    │   ├── Privacy settings
    │   ├── Data export
    │   └── Delete account
    │
    └── Privacy
        └── Profile visibility
            ├── Public (anyone can view)
            ├── Faction only
            └── Friends only
```

---

## State Persistence

Save dashboard state to localStorage:

```javascript
const dashboardState = {
  visible: true,
  panels: {
    notifications: { expanded: true, order: 0 },
    profile: { expanded: false, order: 1 },
    stats: { expanded: false, order: 2 },
    loadout: { expanded: true, order: 3 },
    social: { expanded: false, order: 4 },
    messages: { expanded: false, order: 5 },
    tasks: { expanded: false, order: 6 },
    share: { expanded: false, order: 7 },
    settings: { expanded: false, order: 8 }
  }
};

// Save on change
localStorage.setItem('dashboardState', JSON.stringify(dashboardState));

// Load on init
const saved = JSON.parse(localStorage.getItem('dashboardState'));
```

---

## Settings Persistence

```javascript
const settings = {
  graphics: {
    resolutionScale: 1.0,
    quality: 'medium',
    fpsCap: 60,
    particleDensity: 0.8,
    shadows: true
  },
  audio: {
    master: 0.8,
    sfx: 0.8,
    music: 0.5,
    uiSounds: true
  },
  controls: {
    keybinds: {
      moveForward: 'KeyW',
      moveBack: 'KeyS',
      moveLeft: 'KeyA',
      moveRight: 'KeyD',
      fire: 'Mouse0',
      ability1: 'Digit1',
      ability2: 'Digit2',
      ability3: 'Digit3',
      dashboard: 'KeyH',
      chat: 'Enter',
      ping: 'KeyG'
    },
    mouseSensitivity: 0.5,
    invertY: false
  },
  gameplay: {
    showDamageNumbers: true,
    showXPPopups: true,
    minimapScale: 1.0,
    chatFilter: true,
    colorblindMode: 'off',
    tuskCommentary: 'full' // 'full' | 'important' | 'off'
  },
  privacy: {
    profileVisibility: 'public' // 'public' | 'faction' | 'friends'
  }
};
```

---

## Elon Tusk Commentary System

### Event Priority Mapping

```javascript
const tuskEventPriority = {
  playerSpawn: 'full',
  playerDeath: 'important',
  killStreak: 'full',
  hexCaptured: 'full',
  clusterCaptured: 'important',
  factionTakesLead: 'important',
  orbitalStrikeAvailable: 'important',
  rubberbandActivated: 'important',
  randomQuip: 'full',
  sessionStart: 'important',
  sessionEnd: 'important',
  levelUp: 'important',
  upgradeUnlocked: 'important',
  badgeUnlocked: 'important'
};

function triggerTusk(eventType, message) {
  const tuskLevel = settings.gameplay.tuskCommentary;
  const importance = tuskEventPriority[eventType];
  
  if (tuskLevel === 'off') return;
  if (tuskLevel === 'important' && importance === 'full') return;
  
  showTuskMessage(message);
}
```

### Special Messages When Changing Tusk Setting

```javascript
// When switching to 'off':
"Your feedback has been noted, contractor. Corporate communications suspended. Productivity metrics will continue to be monitored in silence."

// When switching back to 'full':
"Welcome back to the AdLands family! Your engagement is valued."
```

---

## Screenshot System

```javascript
function captureScreenshot() {
  // Hide UI temporarily
  dashboard.hide();
  chat.hide();
  hud.hide();
  
  // Capture canvas
  const dataUrl = renderer.domElement.toDataURL('image/png');
  
  // Restore UI
  dashboard.show();
  chat.show();
  hud.show();
  
  // Add watermark in corner
  const watermarked = addWatermark(dataUrl, 'AdLands - adlands.gg');
  
  return watermarked;
}

// Auto-generated caption templates
const captionTemplates = [
  `Just captured ${clusterName} for ${factionName}! 🎯`,
  `${killCount} kills and counting. #AdLands`,
  `The ${factionName} war machine rolls on. 💀`,
  `Another day, another hex. #AdLands`,
  `Corporate warfare at its finest.`
];
```

---

## Hotkeys

| Key | Action |
|-----|--------|
| H | Toggle dashboard |
| F12 | Quick screenshot |
| Esc | Close current panel / Open settings |

---

## Visual Style Guidelines

- Dark semi-transparent background (rgba(0,0,0,0.8))
- Faction-colored accents on headers
- Smooth expand/collapse animations (150-200ms)
- Hover states on all interactive elements
- Scrollable content within panels if overflow
- Consistent padding (12-16px)
- Font hierarchy: headers bold, content regular

---

## Player Data Structure

```javascript
const player = {
  accountId: "xxx",
  globalData: {
    username: "TankLord99",
    profilePicture: "url",
    friends: [],
    socialLinks: {
      twitter: "",
      twitch: "",
      youtube: "",
      discord: "",
      custom: ""
    },
    createdAt: "2025-01-01",
    unlockedBadges: [
      { id: 'first_blood', unlockedAt: '2025-01-02T14:30:00Z' },
      { id: 'centurion', unlockedAt: '2025-01-15T09:22:00Z' },
      { id: 'squad_up', unlockedAt: '2025-01-03T18:45:00Z' }
    ],
    badgeProgress: {
      // Hidden from player, tracked server-side
      totalKills: 847,
      totalHexesCaptured: 234,
      totalHoursPlayed: 127
    }
  },
  factionProfiles: {
    rust: {
      level: 45,
      xp: 523000,
      currentTitle: "Apex Predator",
      stats: {
        kills: 1200,
        deaths: 800,
        damageDealt: 245000,
        ticsContributed: 18400,
        hexesCaptured: 342,
        clustersCaptured: 89,
        longestLife: 1847, // seconds
        currentKillstreak: 0
      },
      last24HourStats: {
        kills: 47,
        deaths: 23,
        damageDealt: 12000,
        shotsFired: 890,
        shotsHit: 412,
        ticsContributed: 340,
        hexesCaptured: 12,
        clustersCaptured: 3,
        distanceTraveled: 48000,
        avgSpeed: 24.5,
        timeInEnemyTerritory: 2400, // seconds
        timeInFriendlyTerritory: 4800,
        avgDistanceToAllies: 45.2,
        shieldActivations: 23,
        turretsMinesPlaced: 8,
        messagesSent: 34,
        filteredWords: 2,
        drawingToolUsage: 5,
        pingsSent: 18,
        screenshotsTaken: 3,
        socialShares: 1,
        sessionLength: 7200, // seconds
        squadTime: 5400
      },
      loadout: {
        offense: { type: "cannon", tier: 3 },
        defense: { type: "shield", tier: 1 },
        deployable: null
      },
      unlockedUpgrades: ["cannon", "shield", "missiles"],
      rank: 12,
      playtime: 14400 // minutes
    },
    cobalt: {
      level: 1,
      xp: 0,
      currentTitle: "Fresh Recruit",
      stats: {
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        ticsContributed: 0,
        hexesCaptured: 0,
        clustersCaptured: 0,
        longestLife: 0,
        currentKillstreak: 0
      },
      last24HourStats: null,
      loadout: {
        offense: null,
        defense: null,
        deployable: null
      },
      unlockedUpgrades: [],
      rank: null,
      playtime: 0
    },
    viridian: {
      level: 1,
      xp: 0,
      currentTitle: "Fresh Recruit",
      stats: {
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        ticsContributed: 0,
        hexesCaptured: 0,
        clustersCaptured: 0,
        longestLife: 0,
        currentKillstreak: 0
      },
      last24HourStats: null,
      loadout: {
        offense: null,
        defense: null,
        deployable: null
      },
      unlockedUpgrades: [],
      rank: null,
      playtime: 0
    }
  },
  activeFaction: "rust"
};
```

---

## Dynamic Title System

### Overview

Each player has a dynamic title based on their playstyle over the last 24 hours. Titles update whenever the dominant behavior shifts. All titles have a positive spin—even "negative" behaviors get fun, non-judgmental titles.

### Display Format

```
[Apex Predator] TankLord99
       Rust · Rank #12
```

### Metrics and Titles

#### Combat

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| High kills | Kills/hour | Bloodthirsty, Apex Predator, Terminator, Reaper |
| High accuracy | Hits/shots fired | Sharpshooter, Surgical, Bullseye, Precision |
| Low accuracy | Low hit ratio | Spray & Pray, Suppressive Fire, Area Denial |
| High damage dealt | Damage/hour | Heavy Hitter, Bruiser, Powerhouse |
| High assists | Damage without kills | Wingman, Setup Artist, Softener |
| Kill streaks | Avg streak length | Rampage, Unstoppable, Hot Streak |

#### Survival

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| Low deaths | Deaths/hour | Untouchable, Ghost, Survivor, Teflon |
| High deaths | Deaths/hour | Kamikaze, Fearless, First In, Sacrificial |
| Long avg life | Time between deaths | Cockroach, Enduring, Marathon |
| Short avg life | Quick deaths | Speedrunner, YOLO, Blaze of Glory |

#### Territory

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| High tics | Tics/hour | Land Baron, Expansionist, Imperialist |
| High captures | Hexes flipped | Conquistador, Liberator, Flag Planter |
| High cluster captures | Full clusters taken | Big Game Hunter, Whale Hunter, Kingpin |
| Defense focused | Defense tics | Sentinel, Anchor, Immovable, Fortress |
| Attack focused | Attack tics | Aggressor, Invader, Raider |

#### Movement

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| High avg speed | Avg velocity | Speed Demon, Roadrunner, Hyperdrive |
| Low avg speed | Slow movement | Methodical, Calculated, Snail's Pace |
| High distance | Total distance | Globe Trotter, Explorer, Wanderer, Nomad |
| Low distance | Stays put | Territorial, Homebody, Nested |
| Time in enemy territory | % time in hostile | Infiltrator, Behind Enemy Lines, Daredevil |
| Time in friendly territory | % time in safe | Defender, Homeland Security, Patriot |

#### Social Proximity

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| Close to faction mates | Avg distance to allies | Pack Animal, Team Player, Social |
| Far from faction mates | Solo positioning | Lone Wolf, Ronin, Maverick, Rogue |
| Always in squad | Squad time % | Squad Goals, Ride or Die, Brother in Arms |
| Never in squad | Solo queue | Independent, Self-Reliant, One-Man Show |

#### Equipment

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| Shield heavy | Shield activations | Iron Wall, Deflector, Turtle, Porcupine |
| Deployable heavy | Turrets/mines placed | Engineer, Architect, Trapper, Nest Builder |
| Offensive loadout | Damage upgrades | Glass Cannon, All-In, Berserker |
| Balanced loadout | Mixed upgrades | Swiss Army, Versatile, Prepared |

#### Communication

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| High chat usage | Messages/hour | Chatterbox, Social Butterfly, Diplomat |
| Low chat usage | Silent | Strong Silent Type, Mysterious, Mute |
| Profanity heavy | Filtered words | Potty Mouth, Sailor, Colorful |
| Strategic drawing | Drawing tool usage | Tactician, Field Marshal, Strategist |
| Ping heavy | Pings/hour | Shot Caller, Director, Coordinator |

#### Meta

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| Screenshot heavy | Screenshots taken | Photographer, Influencer, Content Creator |
| Social shares | Shares/hour | Brand Ambassador, Evangelist, Promoter |
| Long sessions | Avg session length | Marathon Runner, Dedicated, No-Lifer |
| Short sessions | Quick sessions | Hit and Run, Efficient, Busy Bee |
| Consistent daily play | Login streak | Reliable, Old Faithful, Clockwork |
| Sporadic play | Irregular logins | Free Spirit, Unpredictable, Wild Card |

#### Miscellaneous

| Metric | How Measured | Possible Titles |
|--------|--------------|-----------------|
| High XP/hour | Efficiency | Grinder, Optimizer, Min-Maxer |
| Low XP/hour | Casual pace | Laid Back, Zen Master, Tourist |
| Balanced everything | No dominant stat | Renaissance Contractor, Jack of All Trades |
| New player | <24hr playtime | Fresh Recruit, New Blood, Rookie |
| Returning player | First session after break | Back from Leave, Returnee, Comeback Kid |

### Title Priority System

Some behaviors override others when calculating titles:

```javascript
const titlePriority = [
  'killStreak',      // Most impressive
  'survivalStreak',
  'clusterCaptures',
  'accuracy',
  'combat',
  'territory',
  'movement',
  'social',
  'equipment',
  'meta',
  'balanced'         // Fallback
];
```

### Intensity Modifiers

Same behavior, different intensity = different title tier:

| Kills/hour | Title Tier |
|------------|------------|
| 5-10 | Hunter |
| 10-20 | Predator |
| 20-30 | Apex Predator |
| 30+ | Terminator |

### Title Update Logic

```javascript
function updateTitle(player) {
  const stats = getLast24HourStats(player);
  const newTitle = calculateDominantTitle(stats);
  
  if (newTitle !== player.currentTitle) {
    player.currentTitle = newTitle;
    triggerTusk('titleChange', `New designation: ${newTitle}`);
  }
}

// Call on:
// - Session start
// - Every 30 minutes during play
// - Major stat events (kill streak, cluster capture)
```

### Edge Cases

| Situation | Title |
|-----------|-------|
| Brand new player (no 24hr data) | "Fresh Recruit" or "New Blood" |
| Hasn't played in 24hr | Keep last title, or "On Leave" |
| Perfectly balanced | "Renaissance Contractor" |

---

## Badge System (Achievements)

### Overview

Badges are hidden achievements. Players don't see a checklist—badges appear as surprises when earned. Once unlocked, badges are visible in the player's profile. This creates discovery moments and bragging rights.

### Badge Data Structure

```javascript
const badgeDefinitions = {
  first_blood: {
    id: 'first_blood',
    name: 'First Blood',
    description: 'Get your first kill',
    icon: 'first_blood.png',
    rarity: 'common',
    hidden: true // description hidden until unlocked
  },
  centurion: {
    id: 'centurion',
    name: 'Centurion',
    description: 'Kill 100 tanks',
    icon: 'centurion.png',
    rarity: 'uncommon',
    hidden: true
  }
  // ... etc
};

const playerBadges = {
  unlockedBadges: [
    { id: 'first_blood', unlockedAt: '2025-01-02T14:30:00Z' },
    { id: 'centurion', unlockedAt: '2025-01-15T09:22:00Z' }
  ],
  progress: {
    // Hidden from player, tracked server-side
    kills: 847,
    hexesCaptured: 234,
    hoursPlayed: 127
  }
};
```

### Rarity Tiers

| Rarity | Color | % of Players |
|--------|-------|--------------|
| Common | Gray | >50% |
| Uncommon | Green | 25-50% |
| Rare | Blue | 10-25% |
| Epic | Purple | 1-10% |
| Legendary | Gold | <1% |

### Badge Categories

#### Combat Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| First Blood | Get your first kill | Common |
| Centurion | Kill 100 tanks | Uncommon |
| Thousand Souls | Kill 1,000 tanks | Rare |
| Genocide | Kill 10,000 tanks | Epic |
| Sniper Elite | 10 kills at max range | Uncommon |
| Up Close and Personal | 50 point-blank kills | Uncommon |
| Collateral | Kill 2 tanks with one shot | Rare |
| Untouchable | 20 kill streak | Epic |
| Glass Cannon | 10 kills without taking damage | Rare |
| From the Grave | Kill someone after dying (deployable/mine) | Uncommon |
| Nemesis | Kill the same player 10 times in one session | Rare |
| Revenge | Kill someone within 10 seconds of them killing you | Common |

#### Survival Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| Survivor | Stay alive for 30 minutes | Common |
| Cockroach | Stay alive for 1 hour | Uncommon |
| Immortal | Stay alive for 2 hours | Rare |
| Close Call | Survive with 1 HP | Uncommon |
| Phoenix | Get 5 kills after dropping below 10% HP | Rare |
| Escape Artist | Escape combat with <10 HP, 10 times | Uncommon |

#### Territory Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| Landlord | Capture 100 hexes | Common |
| Real Estate Mogul | Capture 1,000 hexes | Uncommon |
| Planet Owner | Capture 10,000 hexes | Epic |
| Hostile Takeover | Capture 10 clusters | Uncommon |
| Corporate Raider | Capture 100 clusters | Rare |
| King of the Hill | Hold a hex for 1 hour straight | Rare |
| Defender | Successfully defend 50 hexes | Uncommon |
| Reconquista | Recapture a hex within 60 seconds of losing it | Common |

#### Social Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| Squad Up | Join your first squad | Common |
| Band of Brothers | Play 10 hours with the same squad | Uncommon |
| Ride or Die | Play 100 hours with the same squad | Rare |
| Social Butterfly | Add 10 friends | Common |
| Networker | Add 50 friends | Uncommon |
| Shot Caller | Use drawing tools 100 times | Uncommon |
| Diplomat | Send 1,000 chat messages | Uncommon |
| Introvert | Play 10 hours without sending a message | Rare |

#### Faction Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| Loyal | Play 100 hours for one faction | Uncommon |
| Diehard | Play 500 hours for one faction | Rare |
| Lifer | Play 1,000 hours for one faction | Epic |
| Turncoat | Switch factions | Common |
| Triple Agent | Play all three factions | Uncommon |
| Commander | Become faction commander | Rare |
| Field Marshal | Lead faction to victory as commander | Epic |

#### Meta/Weird Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| Night Owl | Play between 2am-5am | Uncommon |
| Early Bird | Play between 5am-7am | Uncommon |
| Marathon | Play 8 hours in one session | Rare |
| Dedicated | Log in 30 days in a row | Rare |
| Veteran | Play for 1,000 hours total | Epic |
| No Life | Play for 5,000 hours total | Legendary |
| Photographer | Take 100 screenshots | Uncommon |
| Influencer | Share 50 times to social media | Rare |
| Listener | Set Tusk commentary to "Off" | Common |
| Masochist | Set Tusk commentary back to "Full" after turning it off | Uncommon |
| Broke | Die 100 times in one session | Uncommon |
| Pacifist | Play 1 hour without killing anyone | Rare |
| Tourist | Visit every hex on the map | Epic |

#### Secret/Easter Egg Badges

| Badge | Hidden Requirement | Rarity |
|-------|-------------------|--------|
| ??? | Find a hidden location | Legendary |
| Insider | Read the terms of service | Legendary |
| Conspiracy Theorist | Visit the same hex 100 times | Rare |
| Tusk's Favorite | Get called out by Tusk 50 times | Rare |
| Tusk's Enemy | Get roasted by Tusk 100 times | Epic |

### Badge Unlock Notification

When a badge is earned, Tusk announces it:

```javascript
// Example Tusk messages for badge unlocks
const badgeUnlockMessages = {
  centurion: "Achievement unlocked: Centurion. @{player} has killed 100 contractors. HR has been notified.",
  immortal: "Achievement unlocked: Immortal. @{player} survived 2 hours. Impressive. Or boring. Jury's out.",
  pacifist: "Achievement unlocked: Pacifist. @{player} played an hour without killing anyone. Wrong game, maybe?",
  no_life: "Achievement unlocked: No Life. @{player} has 5,000 hours. We should talk.",
  turncoat: "Achievement unlocked: Turncoat. @{player} switched factions. Loyalty is overrated anyway."
};

function onBadgeUnlock(player, badgeId) {
  const badge = badgeDefinitions[badgeId];
  const message = badgeUnlockMessages[badgeId] || 
    `Achievement unlocked: ${badge.name}. @${player.username} earned it. Somehow.`;
  
  triggerTusk('badgeUnlocked', message);
  
  // Add to player's unlocked badges
  player.globalData.unlockedBadges.push({
    id: badgeId,
    unlockedAt: new Date().toISOString()
  });
}
```

### Badge Display in Profile

```
Badges (24)
🏆 💀 ⭐ 🎖️ 🔥 👻 🎯 🛡️
(+16 more)
```

Click to expand full badge showcase with hover tooltips showing badge name and description.

---

## Elon Tusk Chat Participation System

### Overview

Tusk actively participates in the global lobby chat. He is highlighted in yellow (accent color) and publicly calls out players for certain behaviors. His goal is to stoke rivalries and pit factions against each other—a master manipulator entertained by the chaos he creates.

### Personality Guidelines

- Never actually mean, just provocative
- Backhanded compliments
- Feigned indifference ("Not my problem")
- Corporate speak mixed with trolling
- Occasionally breaks fourth wall
- Treats everything as entertainment
- No favorites—roasts everyone equally

### Chat Display

```
[Proximity] [Squad] [Faction] [Global]

Global chat:
─────────────────────────────
TankLord99: gg
FragMaster: nice shot
██ ELON TUSK: @TankLord99 is on a 7 kill streak. 
              Somebody nerf this person. Or buff 
              yourselves. Either way, not my problem.
NoobSlayer: lol
CobaltFan: rust cheating
██ ELON TUSK: @CobaltFan, accusations of cheating 
              are cute. So is Cobalt's 24% territory.
─────────────────────────────
```

### Visual Styling

```css
.tusk-message {
  background: rgba(255, 215, 0, 0.15);
  border-left: 3px solid gold;
  color: #FFD700;
}

.tusk-name {
  color: #FFD700;
  font-weight: bold;
}
```

### Individual Player Call-outs

| Trigger | Example Message |
|---------|-----------------|
| Kill streak (5+) | "@TankLord99 is on a rampage. Someone stop them. Or don't. Entertainment value is high." |
| Death streak (5+) | "@NoobSlayer has died 5 times in 3 minutes. Inspirational persistence or tragic incompetence? You decide." |
| Long life ended | "@Ghost finally died after 14 minutes. The myth was mortal after all." |
| First blood of session | "@FragMaster draws first blood. Aggression noted in your performance review." |
| Terrible accuracy | "@SprayNPray has fired 200 rounds and hit... 12. Ammunition budget: under review." |
| Camping too long | "@Sniper42 hasn't moved in 4 minutes. Still alive though. Strategic or scared?" |
| Stealing kills | "@Vulture has 8 kills with only 400 damage dealt. Efficient? Or opportunistic?" |
| Big cluster capture | "@Conqueror just took the Bebsi cluster. Someone's getting a promotion." |
| Lost big cluster | "@Defender lost the Macrosoft cluster after holding it for 47 minutes. Thoughts and prayers." |
| Title change | "@Warrior is now designated 'Kamikaze'. Rebrand complete." |
| Returning player | "@OldTimer is back after 2 weeks. Did you miss us? We didn't notice you were gone." |
| Rage quit (disconnect after death) | "@SaltyBoi has left the battlefield. Unrelated to their 0-7 record, I'm sure." |
| Proximity buddies (same faction) | "@PlayerHater69, I'm not paying you to flirt with @HexMeister12 on company time." |
| Proximity buddies (extended) | "Hey @PlayerHater69 and @HexMeister12, get a room already. Preferably off the battlefield." |
| Proximity buddies (enemies) | "@RustFan and @CobaltKing have been circling each other for 3 minutes. Just kiss or shoot already." |
| Proximity breakup | "@PlayerHater69 and @HexMeister12 finally separated. The divorce was inevitable." |

### Faction Rivalry Stoking

| Trigger | Example Message |
|---------|-----------------|
| Faction takes lead | "Rust now controls 42% of the planet. Cobalt, Viridian—are you even trying?" |
| Faction losing badly | "Viridian holds 18% territory. At this point it's less 'faction' and more 'support group'." |
| Close race | "Rust: 34%, Cobalt: 33%, Viridian: 33%. Finally, some competition. Took you long enough." |
| Faction comeback | "Cobalt went from 20% to 31% in one hour. Someone had their coffee." |
| Faction collapse | "Rust lost 15% territory in 30 minutes. Leadership? Never heard of it." |
| One faction dominating | "Cobalt owns 55% of the map. This isn't a war, it's a landlord situation." |
| Underdog wins fight | "Viridian just took a cluster from Rust despite being outnumbered. Cute." |
| Stalemate | "No territory has changed hands in 20 minutes. Is this war or a picnic?" |

### Player vs Player Instigation

| Trigger | Example Message |
|---------|-----------------|
| Revenge kill | "@Victim just killed @Bully. The plot thickens." |
| Repeated kills | "@Hunter has killed @Prey 4 times this session. At this point it's personal." |
| Nemesis formed | "@Alpha and @Omega have killed each other 6 times. Get a room." |
| Squad wipe | "@Ace just wiped Squad Bravo solo. Condolences to their families." |
| Close fight | "@Fighter1 killed @Fighter2 with 2 HP remaining. Cinema." |

### Random Chaos Messages

| Trigger | Example Message |
|---------|-----------------|
| Quiet lobby | "It's been 5 minutes without drama. Disappointing." |
| Random pot-stir | "Reminder: the contractor with the lowest score in 10 minutes gets publicly shamed. Clock's ticking." |
| Random praise | "Shoutout to @RandomPlayer for... existing, I guess. Keep it up." |
| Random threat | "Performance reviews are next week. Just kidding. Or am I?" |
| Random faction dig | "Fun fact: Viridian has the best K/D ratio. They also have the least territory. Priorities." |

### Timing and Frequency Configuration

```javascript
const tuskChatConfig = {
  minInterval: 45,        // seconds between messages
  maxInterval: 180,       // max quiet time before random message
  eventCooldown: 10,      // seconds after event before commenting
  maxPerHour: 40,         // don't spam
  
  // Proximity tracking for "relationship" teasing
  proximityTracking: {
    minDistance: 50,           // units - close enough to tease
    minDuration: 120,          // seconds together before first comment
    escalationTime: 300,       // seconds for "get a room" level
    cooldownAfterTease: 600,   // don't tease same pair for 10 minutes
    breakupThreshold: 200      // units apart to count as "separated"
  },
  
  // Probability of commenting on events
  eventChance: {
    killStreak: 0.8,
    deathStreak: 0.6,
    clusterCapture: 0.9,
    factionLeadChange: 1.0,
    revengeKill: 0.5,
    proximityBuddies: 0.7,
    proximityBreakup: 0.5,
    randomChaos: 0.3
  }
};
```

### Tusk Chat Implementation

```javascript
class TuskChat {
  constructor() {
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.hourStart = Date.now();
  }

  canSendMessage() {
    const now = Date.now();
    
    // Reset hourly counter
    if (now - this.hourStart > 3600000) {
      this.hourStart = now;
      this.messageCount = 0;
    }
    
    // Check limits
    if (this.messageCount >= tuskChatConfig.maxPerHour) return false;
    if (now - this.lastMessageTime < tuskChatConfig.minInterval * 1000) return false;
    
    return true;
  }

  onEvent(eventType, data) {
    if (!this.canSendMessage()) return;
    
    const chance = tuskChatConfig.eventChance[eventType] || 0.5;
    if (Math.random() > chance) return;
    
    setTimeout(() => {
      const message = this.generateMessage(eventType, data);
      this.sendMessage(message);
    }, tuskChatConfig.eventCooldown * 1000);
  }

  generateMessage(eventType, data) {
    const templates = tuskMessageTemplates[eventType];
    const template = templates[Math.floor(Math.random() * templates.length)];
    return this.fillTemplate(template, data);
  }

  sendMessage(message) {
    this.lastMessageTime = Date.now();
    this.messageCount++;
    
    globalChat.addMessage({
      sender: 'ELON TUSK',
      message: message,
      type: 'tusk',
      timestamp: Date.now()
    });
  }

  checkQuietLobby() {
    const now = Date.now();
    if (now - this.lastMessageTime > tuskChatConfig.maxInterval * 1000) {
      this.onEvent('quietLobby', {});
    }
  }
}
```

### Tips and Tricks Messages

Tusk periodically shares gameplay tips disguised as corporate memos. These cover subtle mechanics that aren't explained in the basic tutorial.

#### Territory & XP Tips

| Tip | Message |
|-----|---------|
| Adjacent territory bonus | "Corporate memo: Holding adjacent territories increases productivity bonuses. Synergy isn't just a buzzword." |
| Territory holding XP | "Pro tip: XP rewards grow the longer you hold territory. Patience is profitable, contractors." |
| Attacker advantage | "Did you know? Attackers receive a 10% tic bonus. AdLands rewards initiative." |
| Cluster capture scaling | "FYI: Larger cluster captures yield exponentially higher rewards. Think big or go home." |
| Connected territory multiplier | "Friendly reminder: Connected territories multiply your earnings. Fragmented holdings are for amateurs." |
| Defense tic requirements | "Intel report: Defenders need more presence to hold than attackers need to capture. Aggression pays." |
| Hex capture cooldown | "Notice: Recently captured hexes have diminished XP value. Stop farming the same spot, we're watching." |

#### Combat Tips

| Tip | Message |
|-----|---------|
| Damage XP | "Reminder: You earn XP for every point of damage dealt, not just kills. Chip away, contractors." |
| Kill bonus | "FYI: The finishing blow grants a 250 XP bonus. Last hits matter." |
| Accuracy matters | "Corporate analysis shows: Higher accuracy means more XP per ammo spent. Math is beautiful." |
| Deployables after death | "Pro tip: Your deployables keep working after you die. Death is not an excuse for zero productivity." |

#### Squad & Social Tips

| Tip | Message |
|-----|---------|
| Squad benefits | "Did you know? Squad members share capture bonuses. Friendship has monetary value here." |
| Squad leader drawing | "Reminder: Squad leaders can draw tactical plans visible to their squad. Use it or lose it." |
| Commander visibility | "Intel: The Commander's drawings are visible to the entire faction. No pressure." |
| Proximity chat | "Pro tip: Nearby tanks can see your chat bubbles. Loose lips sink tanks." |
| Squad encryption | "Security notice: Squad communications are encrypted. Enemies see only gibberish. Plan freely." |
| Faction encryption | "FYI: Faction chat is scrambled to outsiders. Your strategies are safe. Probably." |
| Enemy comms | "Did you know? Enemy squad chatter appears as encrypted nonsense. They're plotting something. You just can't read it." |
| Scrambled text | "Intel tip: If you see scrambled text, that's enemy comms you're not cleared for. Invest in counter-intelligence. Or don't." |

#### Loadout Tips

| Tip | Message |
|-----|---------|
| Upgrade tiers | "FYI: Unlocking an upgrade you already own increases its tier. Duplicates aren't useless." |
| Slot unlocks | "Reminder: Higher levels unlock more equipment slots. Grind now, dominate later." |
| Visual loadout | "Did you know? Your equipped upgrades are visible on your tank. Fashion meets function." |

#### Faction Tips

| Tip | Message |
|-----|---------|
| Underdog XP bonus | "Corporate welfare notice: Struggling factions receive XP bonuses. Losing has its perks." |
| Orbital strike | "Classified intel: The losing faction's top player may receive... special authorization. Stay tuned." |
| Faction profiles | "Reminder: Each faction has separate progression. Switching factions means starting fresh. Choose wisely." |
| Commander succession | "FYI: If a Commander resigns, the next highest-ranked player is automatically promoted. Meritocracy in action." |

#### Meta Tips

| Tip | Message |
|-----|---------|
| Title system | "Did you know? Your title reflects your last 24 hours of playstyle. Be the contractor you want to be labeled as." |
| Hidden badges | "Corporate secret: There are hidden achievements waiting to be discovered. Good luck." |
| Screenshot sharing | "Pro tip: Share your victories on social media. Free marketing for you, free advertising for us. Win-win." |
| Settings reminder | "Reminder: You can adjust my commentary frequency in Settings. But why would you?" |

#### Tips Configuration

```javascript
const tuskTipsConfig = {
  minInterval: 300,        // minimum 5 minutes between tips
  maxInterval: 900,        // force a tip every 15 minutes max
  newPlayerBoost: true,    // more frequent tips for new players
  newPlayerThreshold: 10,  // hours of playtime
  newPlayerInterval: 180,  // 3 minutes between tips for new players
  
  // Weight tips by relevance
  contextualTips: {
    lowTerritory: ['adjacentBonus', 'attackerAdvantage', 'clusterScaling'],
    highDeaths: ['damageXP', 'deployablesAfterDeath'],
    soloPlayer: ['squadBenefits', 'squadLeaderDrawing'],
    newPlayer: ['upgradeSlots', 'titleSystem', 'factionProfiles']
  }
};

// Tip delivery function
function deliverTip(player) {
  const context = analyzePlayerContext(player);
  const relevantTips = getRelevantTips(context);
  const tip = selectRandomTip(relevantTips);
  
  tuskChat.sendMessage(tip.message);
}

// Contextual tip selection
function analyzePlayerContext(player) {
  return {
    isNewPlayer: player.totalPlaytime < tuskTipsConfig.newPlayerThreshold,
    hasLowTerritory: player.faction.territoryPercent < 25,
    hasHighDeaths: player.last24HourStats.deaths > player.last24HourStats.kills * 2,
    isSoloPlayer: !player.currentSquad,
    isCommander: player.isCommander,
    recentlyLostTerritory: player.recentEvents.includes('lostHex')
  };
}
```

### Message Template Storage

```javascript
const tuskMessageTemplates = {
  killStreak: [
    "@{player} is on a {count} kill streak. Someone stop them. Or don't. Entertainment value is high.",
    "@{player} has {count} kills in a row. This is either skill or everyone else is terrible.",
    "{count} consecutive kills for @{player}. At this point it's just bullying."
  ],
  deathStreak: [
    "@{player} has died {count} times in {minutes} minutes. Inspirational persistence or tragic incompetence? You decide.",
    "@{player} is speedrunning the respawn screen. {count} deaths and counting.",
    "Someone check on @{player}. {count} deaths suggests a cry for help."
  ],
  clusterCapture: [
    "@{player} just took the {cluster} cluster. Someone's getting a promotion.",
    "The {cluster} cluster now belongs to {faction}. Previous owners: thoughts and prayers.",
    "@{player} conquered {cluster}. The sponsor will be pleased. Probably."
  ],
  factionLead: [
    "{faction} now controls {percent}% of the planet. {loser1}, {loser2}—are you even trying?",
    "{faction} takes the lead with {percent}%. The other factions are invited to cope.",
    "New standings: {faction} at {percent}%. Corporate is watching."
  ],
  quietLobby: [
    "It's been {minutes} minutes without drama. Disappointing.",
    "Did everyone fall asleep? The metrics are flatlining here.",
    "This silence is deafening. Someone do something entertaining."
  ],
  randomChaos: [
    "Reminder: the contractor with the lowest score in 10 minutes gets publicly shamed. Clock's ticking.",
    "Fun fact: {faction} has the best K/D ratio. They also have the least territory. Priorities.",
    "Performance reviews are next week. Just kidding. Or am I?",
    "Shoutout to @{randomPlayer} for... existing, I guess. Keep it up."
  ],
  proximityBuddies: [
    "@{player1}, I'm not paying you to flirt with @{player2} on company time.",
    "Hey @{player1} and @{player2}, get a room already. Preferably off the battlefield.",
    "@{player1} and @{player2} have been inseparable for {minutes} minutes. Should I notify HR?",
    "Productivity alert: @{player1} and @{player2} are... bonding. Aggressively.",
    "@{player1} and @{player2} are moving as a unit. Cute. Disgusting. But cute.",
    "Are @{player1} and @{player2} conjoined? Asking for accounting purposes."
  ],
  proximityBuddiesEnemy: [
    "@{player1} and @{player2} have been circling each other for {minutes} minutes. Just kiss or shoot already.",
    "The tension between @{player1} and @{player2} is palpable. And unproductive.",
    "@{player1} ({faction1}) and @{player2} ({faction2}) are... what is this? A standoff? A date?",
    "Cross-faction fraternization detected: @{player1} and @{player2}. Treasonous and adorable."
  ],
  proximityBreakup: [
    "@{player1} and @{player2} finally separated. The divorce was inevitable.",
    "@{player1} and @{player2} have gone their separate ways. Corporate wishes them both the worst.",
    "Breaking: @{player1} and @{player2} are no longer a thing. The battlefield mourns. Or celebrates.",
    "@{player1} left @{player2}. Or was it the other way around? Drama."
  ],
  tips: [
    // Territory & XP
    "Corporate memo: Holding adjacent territories increases productivity bonuses. Synergy isn't just a buzzword.",
    "Pro tip: XP rewards grow the longer you hold territory. Patience is profitable, contractors.",
    "Did you know? Attackers receive a 10% tic bonus. AdLands rewards initiative.",
    "FYI: Larger cluster captures yield exponentially higher rewards. Think big or go home.",
    "Friendly reminder: Connected territories multiply your earnings. Fragmented holdings are for amateurs.",
    "Intel report: Defenders need more presence to hold than attackers need to capture. Aggression pays.",
    "Notice: Recently captured hexes have diminished XP value. Stop farming the same spot, we're watching.",
    
    // Combat
    "Reminder: You earn XP for every point of damage dealt, not just kills. Chip away, contractors.",
    "FYI: The finishing blow grants a 250 XP bonus. Last hits matter.",
    "Corporate analysis shows: Higher accuracy means more XP per ammo spent. Math is beautiful.",
    "Pro tip: Your deployables keep working after you die. Death is not an excuse for zero productivity.",
    
    // Squad & Social
    "Did you know? Squad members share capture bonuses. Friendship has monetary value here.",
    "Reminder: Squad leaders can draw tactical plans visible to their squad. Use it or lose it.",
    "Intel: The Commander's drawings are visible to the entire faction. No pressure.",
    "Pro tip: Nearby tanks can see your chat bubbles. Loose lips sink tanks.",
    "Security notice: Squad communications are encrypted. Enemies see only gibberish. Plan freely.",
    "FYI: Faction chat is scrambled to outsiders. Your strategies are safe. Probably.",
    "Did you know? Enemy squad chatter appears as encrypted nonsense. They're plotting something. You just can't read it.",
    "Intel tip: If you see scrambled text, that's enemy comms you're not cleared for. Invest in counter-intelligence. Or don't.",
    
    // Loadout
    "FYI: Unlocking an upgrade you already own increases its tier. Duplicates aren't useless.",
    "Reminder: Higher levels unlock more equipment slots. Grind now, dominate later.",
    "Did you know? Your equipped upgrades are visible on your tank. Fashion meets function.",
    
    // Faction
    "Corporate welfare notice: Struggling factions receive XP bonuses. Losing has its perks.",
    "Classified intel: The losing faction's top player may receive... special authorization. Stay tuned.",
    "Reminder: Each faction has separate progression. Switching factions means starting fresh. Choose wisely.",
    "FYI: If a Commander resigns, the next highest-ranked player is automatically promoted. Meritocracy in action.",
    
    // Meta
    "Did you know? Your title reflects your last 24 hours of playstyle. Be the contractor you want to be labeled as.",
    "Corporate secret: There are hidden achievements waiting to be discovered. Good luck.",
    "Pro tip: Share your victories on social media. Free marketing for you, free advertising for us. Win-win.",
    "Reminder: You can adjust my commentary frequency in Settings. But why would you?"
  ]
};
```

---

## Player Profile Card System

### Overview

Players can view other players' profiles by right-clicking on their name anywhere it appears in the game. This creates a popup profile card showing public information about that player.

### Trigger Locations

| Location | Action |
|----------|--------|
| Tank in game world | Right-click tank |
| Proximity chat | Right-click name |
| Squad chat | Right-click name |
| Faction chat | Right-click name |
| Global chat | Right-click name |
| Friends list | Right-click name |
| Squad roster | Right-click name |
| Faction leaderboard | Right-click name |
| Kill feed | Right-click name |
| Tusk call-outs | Right-click @mention |

### Profile Card Layout

```
┌─────────────────────────────────┐
│  [Picture]                      │
│                                 │
│  TankLord99                     │
│  [Apex Predator]                │
│                                 │
│  Level 45 ████████████░░ 46    │
│                                 │
│  Faction: Rust                  │
│  Squad: Death Dealers           │
│  Rank: #12 in faction           │
│                                 │
│  ─────────────────────────────  │
│  Badges (24)                    │
│  🏆 💀 ⭐ 🎖️ 🔥 👻 🎯 🛡️       │
│  (+16 more)                     │
│                                 │
│  ─────────────────────────────  │
│  [Add Friend] [Invite to Squad] │
│  [Message] [Block]              │
└─────────────────────────────────┘
```

### Profile Data Shown

| Field | Visibility |
|-------|------------|
| Name | Always |
| Profile picture | Always |
| Level | Always |
| XP progress bar | Always |
| Title | Always |
| Faction | Always |
| Squad | If in squad |
| Faction rank | Always |
| Badges earned | Always (count + icons) |
| Social links | If set by player |
| Online status | Always |

### Data NOT Shown (Privacy)

- Detailed stats (K/D, accuracy, etc.)
- Loadout (strategic advantage)
- Last 24hr metrics
- Play time (optional via privacy setting)

### Action Buttons

| Button | Condition |
|--------|-----------|
| Add Friend | Not already friends |
| Remove Friend | Already friends |
| Invite to Squad | Not in your squad, you're squad leader |
| Message | Always |
| Block | Always |
| Report | Always (hidden in submenu) |

### Badge Hover Tooltip

When hovering over a badge icon in the profile card:

```
┌──────────────────┐
│ 💀 Centurion     │
│ "Kill 100 tanks" │
│ Rare             │
└──────────────────┘
```

### Implementation

```javascript
function showPlayerProfile(playerId, sourceElement) {
  const player = await fetchPlayerProfile(playerId);
  
  // Check privacy settings
  if (!canViewProfile(player, currentUser)) {
    showPrivateProfileCard(player.username);
    return;
  }
  
  const card = new ProfileCard({
    name: player.username,
    picture: player.profilePicture,
    level: player.factionProfiles[player.activeFaction].level,
    xp: player.factionProfiles[player.activeFaction].xp,
    title: player.factionProfiles[player.activeFaction].currentTitle,
    faction: player.activeFaction,
    squad: player.currentSquad,
    rank: player.factionProfiles[player.activeFaction].rank,
    badges: player.globalData.unlockedBadges,
    socialLinks: player.globalData.socialLinks,
    isOnline: player.isOnline,
    isFriend: isFriend(player.accountId),
    isBlocked: isBlocked(player.accountId)
  });
  
  // Position near clicked element
  card.showNear(sourceElement);
}

// Add click handler to all player names
document.addEventListener('contextmenu', (e) => {
  const playerElement = e.target.closest('[data-player-id]');
  if (playerElement) {
    e.preventDefault();
    showPlayerProfile(playerElement.dataset.playerId, playerElement);
  }
});
```

### Styling

```css
.profile-card {
  background: rgba(0, 0, 0, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  padding: 16px;
  min-width: 280px;
  max-width: 320px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
  z-index: 1000;
}

.profile-card__faction--rust { 
  border-left: 4px solid #8B4513; 
}
.profile-card__faction--cobalt { 
  border-left: 4px solid #4169E1; 
}
.profile-card__faction--viridian { 
  border-left: 4px solid #228B22; 
}

.profile-card__title {
  color: #888;
  font-style: italic;
  margin-bottom: 8px;
}

.profile-card__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.profile-card__badge {
  width: 24px;
  height: 24px;
  cursor: pointer;
}

.profile-card__badge:hover {
  transform: scale(1.2);
}

.profile-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.profile-card__action-btn {
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.profile-card__online-indicator {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  margin-left: 8px;
}

.profile-card__online-indicator--online {
  background: #4CAF50;
}

.profile-card__online-indicator--offline {
  background: #666;
}
```

### Privacy Settings Integration

```javascript
function canViewProfile(targetPlayer, viewingPlayer) {
  const visibility = targetPlayer.settings.privacy.profileVisibility;
  
  switch (visibility) {
    case 'public':
      return true;
    case 'faction':
      return targetPlayer.activeFaction === viewingPlayer.activeFaction;
    case 'friends':
      return viewingPlayer.globalData.friends.includes(targetPlayer.accountId);
    default:
      return true;
  }
}

function showPrivateProfileCard(username) {
  // Show minimal card for private profiles
  const card = new ProfileCard({
    name: username,
    isPrivate: true,
    message: "This profile is private"
  });
  card.show();
}
```

---

## Implementation Notes

- Dashboard should be part of the HUD class
- Use CSS transitions for smooth panel animations
- Badge counts update in real-time
- Settings changes apply immediately where possible (audio sliders)
- Graphics changes may require "Apply" button if restart needed
- Include "Reset to Default" button per settings section
- Warn before discarding unsaved changes
- Tusk chat messages respect the player's Tusk Commentary setting
- All player names should have `data-player-id` attribute for profile card system
- Badge progress tracked server-side, never exposed to client
- Mobile future consideration: panels become full-screen overlays
