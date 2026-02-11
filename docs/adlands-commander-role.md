# AdLands Commander Role System

## Overview

The Commander is the #1 ranked player of each faction. The role comes with unique perks, responsibilities, and visual distinction. Commanders are high-value targets with high-value tools.

---

## Becoming Commander

| Trigger | Behavior |
|---------|----------|
| Reach #1 rank | Automatically become Commander |
| Commander logs off | Role passes to #2 |
| Commander resigns | Role passes to #2 |
| Rank drops below #1 | Role transfers to new #1 |

```javascript
function updateCommander(faction) {
  const rankings = getFactionRankings(faction);
  const currentCommander = faction.commander;
  const topPlayer = rankings[0];
  
  if (currentCommander?.id !== topPlayer.id) {
    transferCommanderRole(currentCommander, topPlayer);
  }
}

function transferCommanderRole(oldCommander, newCommander) {
  if (oldCommander) {
    removeCommanderPerks(oldCommander);
  }
  
  applyCommanderPerks(newCommander);
  
  // Announcements
  factionChat.send({
    type: 'system',
    message: `${newCommander.username} is now Commander.`
  });
  
  tuskChat.send(
    `New Commander @${newCommander.username} has been assigned. ` +
    `Try not to disappoint. Again.`
  );
}
```

---

## Commander Perks Summary

| Perk | Description |
|------|-------------|
| Gold trim | Visual distinction on tank |
| 2 bodyguards | Bot escorts that follow and protect |
| Orbital intel | See all player positions as dots |
| Commander spotting | Enemy commanders have gold outline |
| Profile access | Right-click any dot for player card |
| Drawing tools | Gold ink, orbital view only, visible to faction |
| Tip budget | 5,000 XP/hour to reward faction members |
| Chat highlight | Gold name + faction background in chat |

---

## Visual Distinction: Gold Trim

Commander's tank gets gold accent trim applied automatically.

### Where Gold Appears

| Part | Gold accent |
|------|-------------|
| Hull | Edge trim outline |
| Turret | Ring around base |
| Barrel | Tip ring + single stripe |
| Tracks | Outer edge stripe |

### Implementation

```javascript
const commanderSkin = {
  trimColor: 0xFFD700,        // gold
  trimEmissive: 0x332200,     // subtle glow
  trimMetalness: 1.0,
  trimRoughness: 0.3,         // shiny
};

function applyCommanderSkin(tank) {
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: commanderSkin.trimColor,
    emissive: commanderSkin.trimEmissive,
    metalness: commanderSkin.trimMetalness,
    roughness: commanderSkin.trimRoughness
  });
  
  tank.trimMesh.material = trimMaterial;
  tank.trimMesh.visible = true;
}

function removeCommanderSkin(tank) {
  tank.trimMesh.visible = false;
}
```

---

## Bodyguard System

Commander always has 2 bot bodyguards flanking them.

### Bodyguard Config

```javascript
const bodyguardConfig = {
  count: 2,
  followDistance: 25,         // units from commander
  formation: 'flanking',      // left and right side
  engageRange: 60,            // attack enemies within range
  prioritizeThreats: true,    // focus whoever shoots commander
  returnToCommander: true,    // don't chase too far
  maxChaseDistance: 80,       // leash range
  respawnWithCommander: true,
  respawnDelay: 5000          // ms after commander respawns
};
```

### Bodyguard Behavior

| State | Behavior |
|-------|----------|
| Following | Flank commander, left and right |
| Engaging | Attack threats to commander |
| Returning | Leash back if too far from commander |
| Death | Die with commander, respawn with commander |

### Implementation

```javascript
class CommanderBodyguard extends Bot {
  constructor(commander, side) {
    super();
    this.commander = commander;
    this.side = side; // 'left' or 'right'
    this.state = 'following';
  }

  update(delta) {
    const threat = this.findThreat();
    
    if (threat && this.inEngageRange(threat)) {
      this.state = 'engaging';
      this.attackTarget(threat);
      
      if (this.distanceTo(this.commander) > bodyguardConfig.maxChaseDistance) {
        this.state = 'returning';
      }
    } else {
      this.state = 'following';
      this.followCommander();
    }
  }

  findThreat() {
    // Priority 1: Whoever is shooting commander
    if (this.commander.lastAttacker && 
        this.commander.lastAttackerTime > Date.now() - 3000) {
      return this.commander.lastAttacker;
    }
    
    // Priority 2: Nearest enemy in range
    return this.findNearestEnemy(bodyguardConfig.engageRange);
  }

  followCommander() {
    const offset = this.side === 'left' ? -90 : 90;
    const targetPos = this.commander.position.clone()
      .add(this.getOffsetVector(offset, bodyguardConfig.followDistance));
    
    this.moveTo(targetPos);
  }

  onCommanderDeath() {
    this.die();
  }

  onCommanderRespawn() {
    setTimeout(() => {
      this.respawnNear(this.commander.position);
    }, bodyguardConfig.respawnDelay);
  }
}
```

### Visual Distinction

| Element | Design |
|---------|--------|
| Paint job | Darker/metallic faction color |
| Decal | Shield emblem |
| Name | "Guard Alpha" / "Guard Beta" |
| Indicator | Small star icon |

### Formation

```
Stationary:          Moving:              Combat:
                     
  [G]                  [G]                [G]→→→ [Enemy]
      [CMD]                [CMD]              [CMD]
  [G]                  [G]                [G]→→→
```

---

## Orbital Intel System

Commander sees all player positions when in orbital view.

### What Commander Sees

| Element | Visibility |
|---------|------------|
| Friendly players | Faction colored dots |
| Enemy players | Faction colored dots |
| Enemy commanders | Faction colored dots + gold outline |
| Hover on dot | Shows player username |
| Right-click dot | Opens player profile card |

### Visual Reference

```
Commander's Orbital View:

    ┌───────────────────────┐
    │      ●        ●◉      │  ◉ = enemy commander (gold outline)
    │  ●       ●            │  ● = regular players
    │      ●◉       ●   ●   │  
    │  ●       ●        ●   │  Colors = faction
    │          ~~~~         │  ~~~~ = commander's gold drawing
    │      ●       ●    ●   │
    └───────────────────────┘
```

### Implementation

```javascript
const commanderOrbitalConfig = {
  showAllPlayers: true,
  dotSize: 6,
  commanderDotGoldOutline: true,
  commanderOutlineWidth: 2,
  hoverShowsName: true,
  rightClickOpensProfile: true
};

class CommanderOrbitalView extends OrbitalView {
  renderPlayerDots() {
    const allPlayers = getAllActivePlayers();
    
    allPlayers.forEach(player => {
      const isCommander = player.isCommander;
      const color = factionColors[player.faction];
      
      const dot = this.createDot(player.position, color, {
        size: commanderOrbitalConfig.dotSize,
        goldOutline: isCommander,
        playerId: player.id
      });
      
      dot.on('hover', () => this.showNameTag(player));
      dot.on('hoverEnd', () => this.hideNameTag());
      dot.on('rightClick', () => showPlayerProfile(player.id, dot));
      
      this.dots.push(dot);
    });
  }

  createDot(position, color, options) {
    const dot = new PIXI.Graphics();
    
    // Gold outline for commanders
    if (options.goldOutline) {
      dot.lineStyle(commanderOrbitalConfig.commanderOutlineWidth, 0xFFD700);
      dot.drawCircle(0, 0, options.size + 2);
    }
    
    // Faction colored fill
    dot.beginFill(color);
    dot.drawCircle(0, 0, options.size);
    dot.endFill();
    
    dot.position.set(position.x, position.y);
    dot.playerId = options.playerId;
    dot.interactive = true;
    
    return dot;
  }

  showNameTag(player) {
    this.nameTag.text = player.username;
    this.nameTag.visible = true;
    this.nameTag.position.set(
      this.mouse.x + 10,
      this.mouse.y - 10
    );
  }
}
```

---

## Drawing System

Commander can draw tactical markings on the planet surface. Visible to entire faction.

### Drawing Rules

| Rule | Value |
|------|-------|
| Who can draw | Commander only |
| When | Orbital view only |
| Color | Gold |
| Visibility | Entire faction |
| Duration | 60 seconds, then fades |
| Input | Left-click drag |

### Controls

| Input | Action |
|-------|--------|
| Left-click drag | Draw |
| Right-click tap | Open profile card (if on dot) |
| Right-click drag | Orbit camera |

### Implementation

```javascript
const drawingConfig = {
  enabled: true,
  color: 0xFFD700,        // gold
  lineWidth: 3,
  fadeTime: 60000,        // 60 seconds
  maxPointsPerStroke: 500
};

class CommanderDrawingTool {
  constructor(commander) {
    this.commander = commander;
    this.isDrawing = false;
    this.currentStroke = [];
  }

  onMouseDown(e) {
    if (e.button !== 0) return; // left click only
    this.isDrawing = true;
    this.currentStroke = [this.getUVPosition(e)];
  }

  onMouseMove(e) {
    if (!this.isDrawing) return;
    this.currentStroke.push(this.getUVPosition(e));
    this.renderStrokePreview();
  }

  onMouseUp() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    
    // Broadcast to faction
    broadcastToFaction(this.commander.faction, {
      type: 'commander_drawing',
      points: this.currentStroke,
      color: 'gold',
      commander: this.commander.username,
      timestamp: Date.now(),
      expiry: Date.now() + drawingConfig.fadeTime
    });
    
    this.currentStroke = [];
  }

  getUVPosition(e) {
    // Convert screen position to UV coordinates on planet surface
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.mouse, this.camera);
    const intersect = raycaster.intersectObject(this.planet);
    
    if (intersect.length > 0) {
      return intersect[0].uv;
    }
    return null;
  }
}
```

### Faction Receives Drawing

```javascript
function onCommanderDrawing(data) {
  const drawing = new TacticalDrawing({
    points: data.points,
    color: data.color,
    author: data.commander,
    expiry: data.expiry
  });
  
  tacticalOverlay.addDrawing(drawing);
  
  // Optional: notification
  showNotification(`Commander ${data.commander} marked the map`);
}
```

---

## Tip Budget System

Commander can reward faction members with XP from a renewable budget.

### Tip Config

```javascript
const commanderTipConfig = {
  hourlyBudget: 5000,        // XP to distribute per hour
  minTip: 100,
  maxTip: 500,
  perPlayerCooldown: 60,     // seconds between tips to same player
  carryOver: false           // use it or lose it
};
```

### Implementation

```javascript
class CommanderTipSystem {
  constructor(commander) {
    this.commander = commander;
    this.budget = commanderTipConfig.hourlyBudget;
    this.lastTips = new Map(); // playerId -> timestamp
  }

  canTip(targetId, amount) {
    if (amount < commanderTipConfig.minTip) return false;
    if (amount > commanderTipConfig.maxTip) return false;
    if (amount > this.budget) return false;
    if (this.commander.id === targetId) return false;
    
    const target = getPlayer(targetId);
    if (target.faction !== this.commander.faction) return false;
    
    const lastTip = this.lastTips.get(targetId) || 0;
    if (Date.now() - lastTip < commanderTipConfig.perPlayerCooldown * 1000) {
      return false;
    }
    
    return true;
  }

  tip(targetId, amount, message = '') {
    if (!this.canTip(targetId, amount)) return false;
    
    this.budget -= amount;
    this.lastTips.set(targetId, Date.now());
    
    const target = getPlayer(targetId);
    target.addXP(amount, 'commander_tip');
    
    // Announce in faction chat
    factionChat.send({
      type: 'commander_tip',
      from: this.commander.username,
      to: target.username,
      amount: amount,
      message: message
    });
    
    return true;
  }

  hourlyReset() {
    this.budget = commanderTipConfig.hourlyBudget;
  }
}
```

### Commander UI

```
┌─────────────────────────────────┐
│ COMMANDER TIP BUDGET            │
│ ████████░░░░░░ 3,200 / 5,000 XP │
│                                 │
│ Right-click player → Tip        │
│ [100] [250] [500] [Custom]      │
└─────────────────────────────────┘
```

### Tip Announcement

```
[Faction Chat]
──────────────────────────────
⭐ Commander TankLord99 tipped @Scout420 250 XP
   "Good recon on the eastern front"
──────────────────────────────
```

### Anti-Abuse Measures

| Abuse vector | Prevention |
|--------------|------------|
| Tipping alts | Can only tip players active in last 10 min |
| Tip circles | Commander can't receive tips |
| Favoritism | Tip history visible to faction |
| AFK farming | Target must have recent activity |

---

## Chat Highlighting

Commander messages are highlighted in faction chat.

### Styling

| Element | Style |
|---------|-------|
| Icon | ★ before name |
| Name | Gold text |
| Message | Normal white/light text |
| Background | Faction color, 15% opacity |
| Border | Faction color, 2px left |

### CSS

```css
.chat-message--commander {
  background: var(--faction-color-15);
  border-left: 2px solid var(--faction-color);
  padding: 4px 8px;
}

.chat-message--commander .player-name {
  color: #FFD700;
  font-weight: bold;
}

.chat-message--commander .player-name::before {
  content: '★ ';
}

/* Faction color variables */
.faction-rust { 
  --faction-color: #8B4513; 
  --faction-color-15: rgba(139, 69, 19, 0.15); 
}
.faction-cobalt { 
  --faction-color: #4169E1; 
  --faction-color-15: rgba(65, 105, 225, 0.15); 
}
.faction-viridian { 
  --faction-color: #228B22; 
  --faction-color-15: rgba(34, 139, 34, 0.15); 
}
```

### Visual Example

```
┌─────────────────────────────────────────┐
│ [Faction Chat - Rust]                   │
│                                         │
│ Scout420: enemies spotted at bebsi      │
│ FragMaster: how many?                   │
│ Scout420: at least 6                    │
│                                         │
│ ┃★ TankLord99: all squads push east     │ ← commander
│ ┃★ TankLord99: ignore north for now     │
│                                         │
│ NoobSlayer: yes sir                     │
│ FragMaster: moving                      │
└─────────────────────────────────────────┘
```

### Where Highlighting Applies

| Location | Commander highlight |
|----------|---------------------|
| Faction chat | ★ Gold name + faction bg |
| Global chat | ★ Gold name + faction bg |
| Proximity chat | ★ Gold name + faction bg |
| Kill feed | ★ icon next to name |
| Leaderboard | ★ icon + row highlight |

---

## Tusk Commentary

Tusk comments on commander actions and status.

### Commander-Related Messages

```javascript
const tuskCommanderMessages = {
  newCommander: [
    "New Commander @{player} has been assigned. Try not to disappoint.",
    "Commander @{player} reporting for duty. Security detail attached.",
    "@{player} is now Commander. The gold trim is ready. Try to keep it."
  ],
  
  commanderDemotion: [
    "@{player} has been demoted. The gold has been repossessed.",
    "Former Commander @{player} returns to the ranks. How the mighty fall.",
    "@{player} is no longer Commander. Security detail reassigned."
  ],
  
  commanderDeath: [
    "Commander down. Leadership vacuum detected.",
    "Commander @{player} has been eliminated. Bodyguards failed.",
    "The Commander is dead. Long live the Commander."
  ],
  
  bodyguardsDead: [
    "Commander's bodyguard down. Budget cuts incoming.",
    "@{player} just killed the Commander's escort. Bold move.",
    "Both bodyguards eliminated. The Commander stands alone."
  ],
  
  commanderTip: [
    "Commander @{from} is distributing bonuses. Trickle-down economics.",
    "@{to} received a tip from the Commander. Teacher's pet detected.",
    "The Commander's budget is being deployed. Favoritism in action."
  ],
  
  commanderDrawing: [
    "Commander is drawing. Pay attention or don't. Your funeral.",
    "Tactical markup detected. The gold crayon is out.",
    "Commander @{player} is micromanaging from orbit. Classic."
  ],
  
  budgetDepleted: [
    "Commander's tip budget depleted. Fiscal irresponsibility noted.",
    "No more bonuses this hour. The well is dry."
  ],
  
  budgetUnused: [
    "Commander hasn't tipped anyone in 30 minutes. Hoarding is noted.",
    "Tip budget sitting unused. Generosity not detected."
  ]
};
```

---

## Commander Badges

| Badge | Requirement |
|-------|-------------|
| Field Promotion | Become commander for the first time |
| Golden Hour | Hold commander role for 1 hour |
| Golden Age | Hold commander role for 24 hours total |
| Gilded | Be commander 10 separate times |
| Generous Leader | Tip 50,000 XP total as commander |
| Tactician | Draw 100 tactical markings as commander |
| Untouchable Commander | Survive 30 minutes as commander without dying |
| Target Practice | Kill an enemy commander |
| Regicide | Kill an enemy commander while you are commander |

---

## Edge Cases

| Situation | Behavior |
|-----------|----------|
| Commander logs off | Role transfers to #2, bodyguards despawn |
| Commander goes AFK | Keeps role until rank drops or logout |
| Commander resigns | Role transfers to #2 |
| #1 and #2 swap ranks | Role transfers immediately |
| Only 1 player in faction | They are commander by default |
| Commander changes faction | Loses role, new faction starts at bottom |
| Bodyguard stuck on terrain | Teleport to commander after 10s |
| Commander in combat when promoted | Bodyguards spawn after combat ends |

---

## Implementation Checklist

### Phase 1: Core Role
- [ ] Commander assignment based on rank
- [ ] Role transfer on rank change
- [ ] Gold trim skin application
- [ ] Chat highlighting

### Phase 2: Bodyguards
- [ ] Bodyguard bot class
- [ ] Follow behavior
- [ ] Threat engagement
- [ ] Respawn with commander
- [ ] Visual distinction

### Phase 3: Orbital Intel
- [ ] Player dots in orbital view
- [ ] Faction coloring
- [ ] Commander gold outline
- [ ] Hover name tags
- [ ] Right-click profile cards

### Phase 4: Drawing
- [ ] Drawing tool in orbital view
- [ ] UV coordinate mapping
- [ ] Faction broadcast
- [ ] 60-second fade

### Phase 5: Tip System
- [ ] Tip budget tracking
- [ ] Hourly reset
- [ ] Per-player cooldown
- [ ] Faction announcements
- [ ] Anti-abuse measures

### Phase 6: Polish
- [ ] Tusk commentary integration
- [ ] Badge tracking
- [ ] Sound effects
- [ ] Particle effects for promotion
