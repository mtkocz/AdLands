/**
 * AdLands - Server-Side TuskGlobalChat
 * Lord Elon Tusk broadcasts satirical commentary to global chat.
 * Ported from client-side js/misc/TuskCommentary.js TuskGlobalChat class.
 *
 * Generates messages server-side so all clients see the same Tusk messages.
 */

"use strict";

class TuskGlobalChat {
  constructor(io, roomId) {
    this.io = io;
    this.roomId = roomId;
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
        factionLeadChange: 0.2,
        factionStruggle: 0.1,
        playerMilestone: 0.6,
        revengeKill: 0.25,
        commanderTip: 0.8,
        quietLobby: 0.05,
        randomChaos: 0.05,
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
        "@{player}, at this rate your clone bill is going to exceed your salary.",
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
      factionLead: [
        "{faction} now controls {percent}% of the planet. {loser1}, {loser2} — are you even trying?",
        "{faction} takes the lead with {percent}%. The other factions are invited to cope.",
        "New standings: {faction} at {percent}%. Corporate is watching.",
      ],
      factionStruggle: [
        "{faction} controls just {percent}% of the planet. Should I start writing their eulogy?",
        "{faction} at {percent}% territory. That's not a faction, that's a parking spot.",
        "Thoughts and prayers for {faction}. {percent}% and sinking.",
        "{faction} is at {percent}%. At this point they're paying rent on someone else's land.",
        "Someone check {faction}'s pulse. {percent}% territory isn't a strategy, it's a cry for help.",
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
      ],
      commanderReturns: [
        "Step aside @{acting}, Daddy @{commander} is home.",
        "Commander @{commander} is back online. @{acting}, your watch has ended.",
        "BREAKING: The real Commander @{commander} has returned. Acting Commander @{acting}, please return the gold trim.",
        "@{commander} is back. @{acting}, it was fun while it lasted.",
        "The Commander has returned! @{acting}, back to the ranks with you.",
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

  onEvent(eventType, data) {
    if (!this.canSendMessage()) return;

    const chance = this.config.eventChance[eventType] || 0.5;
    if (Math.random() > chance) return;

    setTimeout(() => {
      const message = this._generateMessage(eventType, data);
      this._sendMessage(message);
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

  onKill(killerName, victimName, killerFaction, victimFaction) {
    const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown";
    this.onEvent("kill", {
      killer: killerName || "Unknown",
      victim: victimName || "Unknown",
      killerFaction: cap(killerFaction),
      victimFaction: cap(victimFaction),
    });
  }

  onKillStreak(playerName, count) {
    this.onEvent("killStreak", { player: playerName, count });
  }

  onDeathStreak(playerName, count, minutes) {
    this.onEvent("deathStreak", { player: playerName, count, minutes });
  }

  onClusterCapture(playerName, clusterName, faction) {
    this.onEvent("clusterCapture", {
      player: playerName,
      cluster: clusterName,
      faction: faction ? faction.charAt(0).toUpperCase() + faction.slice(1) : "Unknown",
    });
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

  onPlayerMilestone(playerName, count) {
    this.onEvent("playerMilestone", { player: playerName, count });
  }

  onRevengeKill(killerName, victimName) {
    this.onEvent("revengeKill", {
      killer: killerName || "Unknown",
      victim: victimName || "Unknown",
    });
  }

  onCommanderTip(fromName, toName, amount) {
    this.onEvent("commanderTip", {
      from: fromName || "The Commander",
      to: toName || "Unknown",
      amount: amount || 100,
    });
  }

  onCommanderReturns(commanderName, actingName) {
    // Always fire (important event, no probability gate)
    if (!this.canSendMessage()) return;
    const templates = this.templates.commanderReturns;
    if (!templates || templates.length === 0) return;
    const template = templates[Math.floor(Math.random() * templates.length)];
    const msg = template
      .replace(/@?\{commander\}/g, `@${commanderName || "Commander"}`)
      .replace(/@?\{acting\}/g, `@${actingName || "Acting Commander"}`);
    this._sendMessage(msg);
  }
}

module.exports = TuskGlobalChat;
