/**
 * AdLands - Server-Side TuskGlobalChat
 * Lord Elon Tusk broadcasts satirical commentary to global chat.
 * Ported from client-side js/misc/TuskCommentary.js TuskGlobalChat class.
 *
 * Generates messages server-side so all clients see the same Tusk messages.
 */

"use strict";

class TuskGlobalChat {
  constructor(io, roomId, room) {
    this.io = io;
    this.roomId = roomId;
    this.room = room; // Reference to GameRoom for player validation
    this.lastMessageTime = Date.now();
    this.messageCount = 0;
    this.hourStart = Date.now();

    // Configuration
    this.config = {
      minInterval: 180000, // 3 minutes minimum between messages
      maxInterval: 600000, // 10 minutes max quiet time before random message
      maxPerHour: 8,
      eventCooldown: 15000, // 15 second delay after event before posting

      eventChance: {
        kill: 0.05,
        killStreak: 0.4,
        deathStreak: 0.3,
        clusterCapture: 0.3,
        territoryRent: 0.8,
        factionLeadChange: 0.2,
        factionStruggle: 0.1,
        playerMilestone: 0.6,
        revengeKill: 0.25,
        commanderTip: 0.8,
        quietLobby: 0.05,
        randomChaos: 0.05,
        broke: 0.15,
        loan: 0.4,
      },
    };

    // Message templates (same as client-side)
    this.templates = {
      kill: [
        "@{killer} just eliminated @{victim}. {victimFaction} loses another contractor.",
        "@{killer} sends @{victim} to the respawn queue. Business as usual.",
        "RIP @{victim}. @{killer} didn't even hesitate.",
        "@{victim} has been decommissioned by @{killer}. Condolences to their K/D ratio.",
        "@{killer} vs @{victim}. Spoiler: @{victim} lost.",
        "Another one bites the dust. @{killer} takes out @{victim}.",
      ],
      killStreak: [
        "@{player} is on a {count} kill streak. Someone stop them. Or don't. Entertainment value is high.",
        "@{player} has {count} kills in a row. This is either skill or everyone else is terrible.",
        "{count} consecutive kills for @{player}. At this point it's just bullying.",
        "@{player}, slow down! You're making everyone else look bad. Which I appreciate.",
        "Everyone take notes. @{player} is showing you how it's done.",
        "@{player} with {count} kills! HR is going to need a bigger 'Employee of the Month' plaque.",
      ],
      deathStreak: [
        "@{player} has died {count} times in {minutes} minutes. Inspirational persistence or tragic incompetence?",
        "@{player} is speedrunning the respawn screen. {count} deaths and counting.",
        "Someone check on @{player}. {count} deaths suggests a cry for help.",
        "@{player}, don't worry — we offer very attractive financing options for cloning.",
        "@{player}, have you considered... not dying? Just a thought.",
        "I'm not saying @{player} is bad, but their K/D ratio just filed for bankruptcy.",
      ],
      clusterCapture: [
        "@{player} just took the {cluster} cluster. Someone's getting a promotion.",
        "@{player} conquered {cluster}. The sponsor will be pleased. Probably.",
        "Nice work @{player}! The {cluster} cluster is now generating revenue. For me.",
        "@{player} claims {cluster}! That's the kind of initiative I pretend to reward.",
        "The {cluster} cluster falls to @{player}. Previous owners: skill issue.",
      ],
      territoryRent: [
        "@{player} is a land baron now. As for the rest of the lobby: your poverty disgusts me.",
        "BREAKING: @{player} signed a lease. Welcome to the property ladder. The rest of you? Still homeless.",
        "@{player} is officially a real estate mogul. Meanwhile, the rest of you are basically squatters.",
        "@{player} rented territory and honestly? The rest of you look poor by comparison. Just saying.",
        "@{player} is renting from ME. I want the rest of you to think about what that says about your life choices.",
        "REAL ESTATE UPDATE: @{player} just upgraded from 'homeless' to 'slumlord.' The rest of you remain unhoused.",
        "@{player} just rented territory. To everyone else camping on free land: gentrification is coming.",
        "@{player} just rented land. One of you finally understands economics. The rest of you are a rounding error.",
        "@{player} just made a power move. The rest of you should be taking notes.",
        "@{player} — a player of taste and strategy. Everyone else? Noted.",
        "Big landlord energy from @{player} right there. The lobby just got a little more unequal.",
        "@{player}'s territory just increased in value by 300%. Source: me. I make the numbers up.",
      ],
      factionLead: [
        "{faction} now controls {percent}% of the planet. {loser1}, {loser2} — are you even trying?",
        "{faction} takes the lead with {percent}%. The other factions are invited to cope.",
        "New standings: {faction} at {percent}%. Corporate is watching.",
        "MARKET REPORT: {faction} stock is UP. {loser1} and {loser2} stock is... well, I wouldn't invest.",
        "{faction} at {percent}%. That's called market dominance. {loser1} and {loser2}, that's called getting acquired.",
        "If {faction} were a company, I'd buy shares. If {loser1} or {loser2} were companies, I'd short them into the ground.",
        "{faction} is running this planet at {percent}%. {loser1} and {loser2} are just renting space at this point. From {faction}.",
        "BREAKING: {faction} controls {percent}% of the map. I'm starting to think {loser1} and {loser2} are here for the vibes, not the victory.",
      ],
      factionStruggle: [
        "{faction} controls just {percent}% of the planet. Should I start writing their eulogy?",
        "{faction} at {percent}% territory. That's not a faction, that's a parking spot.",
        "Thoughts and prayers for {faction}. {percent}% and sinking.",
        "{faction} is at {percent}%. At this point they're paying rent on someone else's land.",
        "Someone check {faction}'s pulse. {percent}% territory isn't a strategy, it's a cry for help.",
        "INVESTOR ALERT: {faction} is at {percent}%. I'm pulling their funding. Effective immediately. I'm kidding. They never had funding.",
        "{faction} at {percent}%. I've seen startups fail more gracefully than this.",
        "If {faction} were a stock it'd be delisted. {percent}% territory is not even a rounding error.",
        "{faction} holds {percent}% of the planet. That's less than my personal bathroom. And I would know — it's massive.",
        "BREAKING: {faction} territory has dropped to {percent}%. At this rate they'll be a Wikipedia article by tomorrow.",
      ],
      playerMilestone: [
        "@{player} just hit {count} kills this session. Somebody's gunning for Employee of the Month.",
        "{count} kills for @{player}. That's not a contractor, that's a natural disaster.",
        "@{player} reached {count} eliminations. HR is reviewing the footage.",
        "MILESTONE: @{player} has {count} kills. The rest of you should be embarrassed.",
        "@{player} with {count} kills. At this rate, we'll need to order more clones.",
      ],
      revengeKill: [
        "@{killer} just got revenge on @{victim}! That's what I call conflict resolution.",
        "@{killer} remembered what @{victim} did. And chose violence.",
        "Payback delivered! @{killer} sends @{victim} back to respawn.",
        "@{killer} to @{victim}: 'Remember me?' Apparently they do now.",
      ],
      quietLobby: [
        "It's been {minutes} minutes without drama. What am I paying you for?!",
        "Did everyone fall asleep? The metrics are flatlining here.",
      ],
      commanderTip: [
        "BREAKING: @{from} has bestowed ¢{amount} upon @{to}. Trickle-down economics at work!",
        "NOTICE: @{to} received ¢{amount} from Commander @{from}. Favoritism? We call it 'strategic incentivization.'",
        "MORALE UPDATE: @{from} just tipped @{to} ¢{amount}. This is basically a raise.",
        "WEALTH REDISTRIBUTION: @{from} made @{to} ¢{amount} richer. The Commander's generosity knows bounds. Budget bounds.",
        "@{to} just received ¢{amount} from the Commander. Don't spend it all on one respawn.",
      ],
      randomChaos: [
        "Performance reviews are next week. Just kidding. Or am I?",
        "Fun fact: one of you is secretly my favorite. Guess who. It's probably not you.",
        "PRO TIP: Every crypto you spend on ammo is crypto you're not spending on territory. Think about that. Then buy territory. From me.",
        "FINANCIAL WISDOM: The best investment you can make is in real estate. Specifically, MY real estate. Rent territory today.",
        "TUSK TIP: Stop dying. Every respawn costs crypto. I'm not running a charity. Well, I am, but it's for tax purposes.",
        "Did you know? 73% of contractors retire broke. The other 27% rent territory. This is definitely a real statistic.",
        "ECONOMY UPDATE: Crypto doesn't grow on trees. It grows on territory you capture. So go capture some. This has been a Tusk Financial Minute.",
        "Reminder: You miss 100% of the territory you don't capture. — Lord Elon Tusk, visionary, landlord, humble genius.",
        "PSA: In-game crypto is worth exactly nothing in the real world. You want REAL territory? That costs REAL dollars. I've said too much.",
      ],
      commanderReturns: [
        "Step aside @{acting}, Daddy @{commander} is home.",
        "Commander @{commander} is back online. @{acting}, your watch has ended.",
        "BREAKING: The real Commander @{commander} has returned. Acting Commander @{acting}, please return the gold trim.",
        "@{commander} is back. @{acting}, it was fun while it lasted.",
        "The Commander has returned! @{acting}, back to the ranks with you.",
      ],
      broke: [
        "@{player} just tried to {action} with no crypto. The audacity of the impoverished.",
        "POVERTY ALERT: @{player} can't afford to {action}. Maybe try capturing territory?",
        "@{player} is broke. In a war zone. This is what peak financial planning looks like.",
        "Someone get @{player} a GoFundMe. They can't even afford to {action}.",
        "@{player} just bounced a check. In a warzone. Peak comedy.",
        "FINANCIAL ADVISORY: @{player}, your balance is lower than your K/D ratio. And that's saying something.",
        "@{player} can't afford anything. This is what happens when you don't diversify your portfolio.",
        "@{player} can't afford to {action}. Have you tried being born into an emerald mine? Worked great for me.",
      ],
      loan: [
        "@{player} just went into debt to respawn. Congratulations, you now owe me money.",
        "LOAN APPROVED: @{player} is borrowing from the Bank of Tusk. Interest rate: your dignity.",
        "@{player} is now in crypto debt. I own you now. Well, more than before.",
        "BREAKING: @{player} has a negative balance of ¢{balance}. They're literally worth less than nothing.",
        "@{player} just took a predatory loan from me to stay alive. The system works!",
        "@{player} is fighting on borrowed time AND borrowed money. Inspirational.",
        "Debt notice for @{player}. Don't worry, I charge compound interest on your suffering.",
      ],
    };

    // Start periodic timers
    this._chaosTimer = null;
    this._quietTimer = null;
    this._startRandomChaosTimer();
    this._startQuietChecker();
    this._sendWelcomeMessage();
  }

  /**
   * Clean up timers when room is destroyed
   */
  destroy() {
    if (this._chaosTimer) clearTimeout(this._chaosTimer);
    if (this._quietTimer) clearInterval(this._quietTimer);
  }

  // ========================
  // WELCOME MESSAGE
  // ========================

  _sendWelcomeMessage() {
    const welcomeMessages = [
      "Welcome to AdLands, contractors! Remember: every death funds my next yacht.",
      "Another day, another opportunity to generate shareholder value through violence.",
      "Good to see you all online. Now get out there and capture some territory!",
      "AdLands welcomes you. Your performance is being monitored. Always.",
      "Contractors deployed. Let the territorial disputes begin!",
    ];

    setTimeout(
      () => {
        const msg =
          welcomeMessages[Math.floor(Math.random() * welcomeMessages.length)];
        this._sendMessage(msg);
      },
      15000 + Math.random() * 15000,
    );
  }

  // ========================
  // RATE LIMITING
  // ========================

  canSendMessage() {
    const now = Date.now();

    // Reset hourly counter
    if (now - this.hourStart > 3600000) {
      this.hourStart = now;
      this.messageCount = 0;
    }

    if (this.messageCount >= this.config.maxPerHour) return false;
    if (now - this.lastMessageTime < this.config.minInterval) return false;

    return true;
  }

  // ========================
  // EVENT HANDLING
  // ========================

  /**
   * @param {string} eventType
   * @param {Object} data - Template data (player names as fallback values)
   * @param {Object} [playerRefs] - Map of data key → socketId for deferred name resolution
   */
  onEvent(eventType, data, playerRefs) {
    if (!this.canSendMessage()) return;

    const chance = this.config.eventChance[eventType] || 0.5;
    if (Math.random() > chance) return;

    setTimeout(() => {
      // Re-resolve player names from socket IDs so Tusk always uses the current name
      const resolved = this._resolvePlayerNames(data, playerRefs);
      const message = this._generateMessage(eventType, resolved);
      if (message && this._mentionedPlayersExist(message)) {
        this._sendMessage(message);
      }
    }, this.config.eventCooldown);
  }

  // ========================
  // MESSAGE GENERATION
  // ========================

  _generateMessage(eventType, data) {
    const templates = this.templates[eventType];
    if (!templates || templates.length === 0) return null;

    const template = templates[Math.floor(Math.random() * templates.length)];
    return this._fillTemplate(template, data);
  }

  _fillTemplate(template, data) {
    let message = template;
    for (const [key, value] of Object.entries(data || {})) {
      message = message.replace(new RegExp(`\\{${key}\\}`, "g"), value);
    }
    return message;
  }

  // ========================
  // PLAYER NAME RESOLUTION
  // ========================

  /**
   * Re-resolve player names from socket IDs at send time.
   * Ensures Tusk uses the player's current profile name, not the name at event time.
   */
  _resolvePlayerNames(data, playerRefs) {
    if (!playerRefs || !this.room || !this.room.players) return data;
    const resolved = { ...data };
    for (const [key, socketId] of Object.entries(playerRefs)) {
      const player = this.room.players.get(socketId);
      if (player) {
        resolved[key] = player.name;
      }
    }
    return resolved;
  }

  /**
   * Check that all @-mentioned player names in a message still exist in the room.
   * Prevents Tusk from referencing players who disconnected during the event cooldown.
   */
  _mentionedPlayersExist(message) {
    if (!this.room || !this.room.players) return true;

    const playerNames = new Set();
    for (const [, p] of this.room.players) {
      playerNames.add(p.name);
    }

    // Extract @mentions — match @Name allowing word chars, hyphens, spaces
    const mentions = [];
    const regex = /@([\w][\w\s-]*[\w]|[\w])/g;
    let match;
    while ((match = regex.exec(message)) !== null) {
      mentions.push(match[1]);
    }
    if (mentions.length === 0) return true;

    return mentions.every((name) => playerNames.has(name));
  }

  // ========================
  // BROADCAST
  // ========================

  _sendMessage(message) {
    if (!message) return;

    this.lastMessageTime = Date.now();
    this.messageCount++;

    // Broadcast to all clients in the room
    this.io.to(this.roomId).emit("tusk-chat", { text: message });
  }

  // ========================
  // PERIODIC TIMERS
  // ========================

  _startRandomChaosTimer() {
    const deliverChaos = () => {
      const delay = 240000 + Math.random() * 240000; // 4-8 minutes

      this._chaosTimer = setTimeout(() => {
        if (this.canSendMessage()) {
          const messages = this.templates.randomChaos;
          const msg = messages[Math.floor(Math.random() * messages.length)];

          if (Math.random() < this.config.eventChance.randomChaos) {
            this._sendMessage(msg);
          }
        }
        deliverChaos();
      }, delay);
    };

    // Start after initial delay
    this._chaosTimer = setTimeout(deliverChaos, 45000);
  }

  _startQuietChecker() {
    this._quietTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastMessageTime > this.config.maxInterval) {
        const minutes = Math.floor((now - this.lastMessageTime) / 60000);
        this.onEvent("quietLobby", { minutes });
      }
    }, 60000);
  }

  // ========================
  // PUBLIC EVENT METHODS
  // ========================

  onKill(killerName, victimName, killerFaction, victimFaction, killerSocketId, victimSocketId) {
    const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
    this.onEvent("kill", {
      killer: killerName || "Unknown",
      victim: victimName || "Unknown",
      killerFaction: cap(killerFaction),
      victimFaction: cap(victimFaction),
    }, {
      killer: killerSocketId,
      victim: victimSocketId,
    });
  }

  onKillStreak(playerName, count, socketId) {
    this.onEvent("killStreak", { player: playerName, count }, { player: socketId });
  }

  onDeathStreak(playerName, count, minutes, socketId) {
    this.onEvent("deathStreak", { player: playerName, count, minutes }, { player: socketId });
  }

  onClusterCapture(playerName, clusterName, faction, socketId) {
    this.onEvent("clusterCapture", {
      player: playerName,
      cluster: clusterName,
      faction: faction ? faction.charAt(0).toUpperCase() + faction.slice(1) : "Unknown",
    }, socketId ? { player: socketId } : null);
  }

  onFactionLeadChange(leadingFaction, percent, loser1, loser2) {
    const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
    this.onEvent("factionLead", {
      faction: cap(leadingFaction),
      percent: percent.toFixed(1),
      loser1: cap(loser1),
      loser2: cap(loser2),
    });
  }

  onFactionStruggle(faction, percent) {
    this.onEvent("factionStruggle", {
      faction: faction ? faction.charAt(0).toUpperCase() + faction.slice(1) : "Unknown",
      percent: percent.toFixed(1),
    });
  }

  onPlayerMilestone(playerName, count, socketId) {
    this.onEvent("playerMilestone", { player: playerName, count }, { player: socketId });
  }

  onRevengeKill(killerName, victimName, killerSocketId, victimSocketId) {
    this.onEvent("revengeKill", {
      killer: killerName || "Unknown",
      victim: victimName || "Unknown",
    }, {
      killer: killerSocketId,
      victim: victimSocketId,
    });
  }

  onTerritoryRent(playerName, socketId) {
    // Always fire — this is a paid action, bypass rate limiting and probability gate
    // Resolve current name from socket ID (player may have changed profile)
    if (socketId && this.room) {
      const player = this.room.players.get(socketId);
      if (player) playerName = player.name;
    }
    const templates = this.templates.territoryRent;
    if (!templates || templates.length === 0) return;
    const template = templates[Math.floor(Math.random() * templates.length)];
    const msg = this._fillTemplate(template, { player: playerName || "Unknown" });
    this._sendMessage(msg);
  }

  onCommanderTip(fromName, toName, amount, fromSocketId, toSocketId) {
    this.onEvent("commanderTip", {
      from: fromName || "The Commander",
      to: toName || "Unknown",
      amount: amount || 100,
    }, {
      from: fromSocketId,
      to: toSocketId,
    });
  }

  onCommanderReturns(commanderName, actingName, commanderSocketId, actingSocketId) {
    // Always fire (important event, no probability gate)
    if (!this.canSendMessage()) return;
    // Resolve current names from socket IDs
    if (this.room) {
      if (commanderSocketId) {
        const p = this.room.players.get(commanderSocketId);
        if (p) commanderName = p.name;
      }
      if (actingSocketId) {
        const p = this.room.players.get(actingSocketId);
        if (p) actingName = p.name;
      }
    }
    const templates = this.templates.commanderReturns;
    if (!templates || templates.length === 0) return;
    const template = templates[Math.floor(Math.random() * templates.length)];
    const msg = template
      .replace(/@?\{commander\}/g, `@${commanderName || "Commander"}`)
      .replace(/@?\{acting\}/g, `@${actingName || "Acting Commander"}`);
    this._sendMessage(msg);
  }

  /** Triggered when a player can't afford an action */
  onBrokePlayer(playerName, action, socketId) {
    const actionLabels = {
      'fast-travel': 'fast travel',
      'fire': 'fire their cannon',
      'level-up': 'level up',
      'unlock-slot': 'unlock a loadout slot',
    };
    this.onEvent("broke", {
      player: playerName || "Unknown",
      action: actionLabels[action] || action,
    }, socketId ? { player: socketId } : null);
  }

  /** Triggered when respawn pushes a player into negative balance */
  onLoanTaken(playerName, balance, socketId) {
    this.onEvent("loan", {
      player: playerName || "Unknown",
      balance: Math.abs(Math.round(balance)).toLocaleString(),
    }, socketId ? { player: socketId } : null);
  }
}

module.exports = TuskGlobalChat;
