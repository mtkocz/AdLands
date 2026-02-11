/**
 * AdLands - Commander System
 * Manages the Commander role for each faction - the #1 ranked player by level + crypto
 * Commanders get unique perks: gold trim, bodyguards, orbital intel, drawing, tips
 */

class CommanderSystem {
  constructor() {
    // Commander state per faction
    this.commanders = {
      rust: null, // { playerId, tankRef, username, sessionCrypto, assignedAt }
      cobalt: null,
      viridian: null,
    };

    // All registered players (human + bots) with their session crypto
    // Map: playerId -> { faction, tankRef, sessionCrypto, username, isHuman }
    this.players = new Map();

    // Human player ID (for special handling)
    this.humanPlayerId = null;
    this.humanPlayerFaction = null;

    // Multiplayer: server socket ID for the human player.
    // The human player is registered locally as "player" but the server
    // uses the socket ID. This mapping lets isCommander/applyServerCommander
    // bridge both IDs transparently.
    this.humanMultiplayerId = null;

    // Commander Override (testing mode - forces human player to be commander)
    this.commanderOverride = false;

    // Resignation state (player voluntarily stepped down)
    this.resignedUntil = null; // Timestamp when resignation expires, or null if not resigned

    // Dependencies (set via setters)
    this.cryptoSystem = null;
    this.botTanks = null;
    this.commanderSkin = null;
    this.bodyguards = null;
    this.drawing = null;
    this.tipSystem = null;

    // Update interval (check rankings every 5 seconds)
    this.rankingCheckInterval = 5000;
    this.lastRankingCheck = 0;

    // Multiplayer mode: server determines commanders, skip local ranking
    this.multiplayerMode = false;

    // Callbacks
    this.onCommanderChange = null; // (newCommander, oldCommander, faction) => {}
  }

  // ========================
  // DEPENDENCY INJECTION
  // ========================

  setCryptoSystem(cryptoSystem) {
    this.cryptoSystem = cryptoSystem;
  }

  setBotTanks(botTanks) {
    this.botTanks = botTanks;
  }

  setSkin(commanderSkin) {
    this.commanderSkin = commanderSkin;
  }

  setBodyguards(bodyguards) {
    this.bodyguards = bodyguards;
  }

  setDrawing(drawing) {
    this.drawing = drawing;
  }

  setTipSystem(tipSystem) {
    this.tipSystem = tipSystem;
  }

  // ========================
  // PLAYER REGISTRATION
  // ========================

  /**
   * Register the human player
   */
  registerHumanPlayer(playerId, faction, tankRef, username = "Player") {
    this.humanPlayerId = playerId;
    this.humanPlayerFaction = faction;

    this.players.set(playerId, {
      faction,
      tankRef,
      sessionCrypto: 0,
      level: 1,
      crypto: 0,
      username,
      isHuman: true,
    });
  }

  /**
   * Register a bot player
   */
  registerBot(botId, faction, tankRef, username) {
    // Bots get a randomized starting level (1-8) and crypto balance
    const botLevel = 1 + Math.floor(Math.random() * 8);
    const botCrypto = botLevel * (2000 + Math.floor(Math.random() * 5000));

    this.players.set(botId, {
      faction,
      tankRef,
      sessionCrypto: 0,
      level: botLevel,
      crypto: botCrypto,
      username,
      isHuman: false,
    });
  }

  /**
   * Register a remote player (multiplayer)
   */
  registerRemotePlayer(playerId, faction, tankRef, username) {
    this.players.set(playerId, {
      faction,
      tankRef,
      sessionCrypto: 0,
      level: 1,
      crypto: 0,
      username,
      isHuman: false,
    });
  }

  /**
   * Unregister a player (e.g., bot despawn)
   */
  unregisterPlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      // If this player was a commander, transfer the role
      if (this.commanders[player.faction]?.playerId === playerId) {
        this._removeCommander(player.faction);
      }
      this.players.delete(playerId);
    }
  }

  /**
   * Update a player's session crypto
   */
  updateSessionCrypto(playerId, sessionCrypto) {
    const player = this.players.get(playerId);
    if (player) {
      player.sessionCrypto = sessionCrypto;
    }
  }

  /**
   * Update a player's level and crypto (used for commander ranking)
   */
  updatePlayerStats(playerId, level, crypto) {
    const player = this.players.get(playerId);
    if (player) {
      player.level = level;
      player.crypto = crypto;
    }
  }

  /**
   * Update a player's crypto balance (server-authoritative in multiplayer)
   */
  updatePlayerCrypto(playerId, crypto) {
    const player = this.players.get(playerId);
    if (player) {
      player.crypto = crypto;
    }
  }

  /**
   * Update a player's faction (e.g., faction switch in multiplayer)
   */
  updatePlayerFaction(playerId, faction) {
    const player = this.players.get(playerId);
    if (player) player.faction = faction;
  }

  /**
   * Sync bots from BotTanks system
   * Call this periodically to keep bot registration in sync
   */
  syncBots() {
    if (!this.botTanks) return;

    const bots = this.botTanks.bots || [];
    bots.forEach((bot, index) => {
      if (!bot || bot.isDead || bot.isDeploying) return;

      const botId = `bot-${index}`;
      if (!this.players.has(botId)) {
        this.registerBot(
          botId,
          bot.faction,
          bot,
          bot.lodDot?.userData?.username || `Bot ${index}`,
        );
      }

      // Keep username in sync with player tag display name
      const player = this.players.get(botId);
      if (player) {
        const tagName = bot.lodDot?.userData?.username;
        if (tagName && player.username !== tagName) {
          player.username = tagName;
        }

        // Bots passively earn session crypto and economy crypto over time
        if (!bot.isDead) {
          player.sessionCrypto += Math.random() * 2;
          player.crypto += Math.floor(Math.random() * 50);
          // Small chance to level up per sync cycle (~every 5s)
          if (Math.random() < 0.02) {
            player.level = Math.min(player.level + 1, 30);
          }
        }
      }
    });
  }

  // ========================
  // RANKING & COMMANDER LOGIC
  // ========================

  /**
   * Get faction rankings sorted by level (primary) then crypto (secondary)
   */
  getFactionRankings(faction) {
    const rankings = [];

    this.players.forEach((player, playerId) => {
      if (player.faction !== faction) return;

      // Exclude dead or waiting-for-portal players (matches server logic)
      const tankRef = player.tankRef;
      if (tankRef && (tankRef.isDead || tankRef.waitingForPortal)) return;

      rankings.push({
        playerId,
        username: player.username,
        sessionCrypto: player.sessionCrypto,
        level: player.level || 1,
        crypto: player.crypto || 0,
        tankRef: tankRef,
        isHuman: player.isHuman,
      });
    });

    // Sort by level descending, then crypto descending as tiebreaker
    rankings.sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return b.crypto - a.crypto;
    });

    return rankings;
  }

  /**
   * Check if a player is currently a commander.
   * Handles the "player" ↔ socket-ID mapping transparently:
   * passing either "player" or the socket ID will match if
   * the human player is the commander.
   */
  isCommander(playerId) {
    // Build set of equivalent IDs to check
    let altId = null;
    if (this.humanMultiplayerId) {
      if (playerId === this.humanPlayerId) altId = this.humanMultiplayerId;
      else if (playerId === this.humanMultiplayerId) altId = this.humanPlayerId;
    }

    for (const faction of ["rust", "cobalt", "viridian"]) {
      const cmdrId = this.commanders[faction]?.playerId;
      if (cmdrId === playerId || (altId && cmdrId === altId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the commander for a specific faction
   */
  getCommander(faction) {
    return this.commanders[faction];
  }

  /**
   * Get all current commanders
   */
  getAllCommanders() {
    return { ...this.commanders };
  }

  /**
   * Check if the human player is a commander
   */
  isHumanCommander() {
    return this.humanPlayerId && this.isCommander(this.humanPlayerId);
  }

  /**
   * Update commander for a specific faction based on rankings
   */
  _updateFactionCommander(faction) {
    // In multiplayer, server is sole authority — never pick commanders locally
    if (this.multiplayerMode) return;

    const rankings = this.getFactionRankings(faction);
    if (rankings.length === 0) return;

    // Commander override: human player is ALWAYS commander of their faction - no exceptions
    // (unless they've resigned)
    if (
      this.commanderOverride &&
      faction === this.humanPlayerFaction &&
      !this.isResigned()
    ) {
      const humanPlayer = this.players.get(this.humanPlayerId);
      if (humanPlayer) {
        const currentCommander = this.commanders[faction];
        // Force human as commander if not already
        if (
          !currentCommander ||
          currentCommander.playerId !== this.humanPlayerId
        ) {
          this._transferCommander(faction, {
            playerId: this.humanPlayerId,
            username: humanPlayer.username,
            sessionCrypto: humanPlayer.sessionCrypto,
            tankRef: humanPlayer.tankRef,
            isHuman: true,
          });

          // Update dashboard
          if (window.dashboard && window.dashboard.updateCommanderStatus) {
            window.dashboard.updateCommanderStatus(true);
          }
        }
        // Always return early when override is on - don't allow ranking-based changes
        return;
      }
    }

    // If human is resigned, skip them in rankings
    let topPlayer = rankings[0];
    if (faction === this.humanPlayerFaction && this.isResigned()) {
      topPlayer =
        rankings.find((p) => p.playerId !== this.humanPlayerId) || null;
      if (!topPlayer) {
        // No one else to be commander
        const currentCommander = this.commanders[faction];
        if (currentCommander) {
          this._removeCommanderPerks(currentCommander, faction);
          this.commanders[faction] = null;
        }
        return;
      }
    }

    const currentCommander = this.commanders[faction];

    // Check if commander needs to change
    if (!currentCommander || currentCommander.playerId !== topPlayer.playerId) {
      this._transferCommander(faction, topPlayer);

      // Update dashboard if human became/lost commander
      if (
        faction === this.humanPlayerFaction &&
        window.dashboard &&
        window.dashboard.updateCommanderStatus
      ) {
        window.dashboard.updateCommanderStatus(
          topPlayer.playerId === this.humanPlayerId,
        );
      }
    }
  }

  /**
   * Transfer commander role to a new player
   */
  _transferCommander(faction, newCommander) {
    const oldCommander = this.commanders[faction];

    // Remove perks from old commander
    if (oldCommander) {
      this._removeCommanderPerks(oldCommander, faction);
    }

    // Assign new commander
    this.commanders[faction] = {
      playerId: newCommander.playerId,
      username: newCommander.username,
      sessionCrypto: newCommander.sessionCrypto,
      tankRef: newCommander.tankRef,
      isHuman: newCommander.isHuman,
      assignedAt: Date.now(),
    };

    // Apply perks to new commander
    this._applyCommanderPerks(this.commanders[faction], faction);

    // Fire callback
    if (this.onCommanderChange) {
      this.onCommanderChange(this.commanders[faction], oldCommander, faction);
    }
  }

  /**
   * Remove commander from a faction
   */
  _removeCommander(faction) {
    const commander = this.commanders[faction];
    if (commander) {
      this._removeCommanderPerks(commander, faction);
      this.commanders[faction] = null;

      // Find new commander
      this._updateFactionCommander(faction);
    }
  }

  /**
   * Apply commander perks (gold trim, bodyguards, etc.)
   */
  _applyCommanderPerks(commander, faction) {
    if (!commander) return;

    // Gold trim (requires tankRef for the Three.js mesh)
    if (this.commanderSkin && commander.tankRef) {
      this.commanderSkin.applyTrim(commander.tankRef);
    }

    // Player tag - gold styling and "Commander" title
    // Translate socket ID back to "player" for local player's tag lookup
    if (window.playerTags) {
      const tagId = (commander.playerId === this.humanMultiplayerId) ? this.humanPlayerId : commander.playerId;
      const tag = window.playerTags.tags?.get(tagId);
      if (tag) {
        window.playerTags.setCommander(tagId, true);
      } else {
        // Tag not created yet (late join) — mark pending for spawnRemoteTank to pick up
        commander._pendingCommanderTag = tagId;
      }
    }

    // ProfileCard: title is handled at render time via isCommander() check — no cache mutation needed

    // Bodyguards (only for human player in single-player; server handles multiplayer)
    if (commander.isHuman && commander.tankRef && this.bodyguards && !this.multiplayerMode) {
      this.bodyguards.spawn(commander, faction);
    }

    // Tip system (only for human player — no tankRef needed)
    if (commander.isHuman && this.tipSystem) {
      this.tipSystem.activate(commander.playerId, faction);
    }
  }

  /**
   * Remove commander perks
   */
  _removeCommanderPerks(commander, faction) {
    if (!commander) return;

    const tankRef = commander.tankRef;
    const playerId = commander.playerId;
    const isHuman = commander.isHuman;
    // Translate socket ID back to "player" for local player's tag lookup
    const tagId = (playerId === this.humanMultiplayerId) ? this.humanPlayerId : playerId;

    // Gold trim
    if (this.commanderSkin && tankRef) {
      this.commanderSkin.removeTrim(tankRef);
    }

    // Player tag - remove gold styling and restore previous title
    if (window.playerTags) {
      window.playerTags.setCommander(tagId, false);
    }
    // Clear pending tag flag
    commander._pendingCommanderTag = null;

    // ProfileCard: title is handled at render time via isCommander() check — no cache mutation needed

    // Bodyguards (single-player only; server handles multiplayer)
    if (isHuman && this.bodyguards && !this.multiplayerMode) {
      this.bodyguards.despawn();
    }

    // Tip system
    if (isHuman && this.tipSystem) {
      this.tipSystem.deactivate();
    }
  }

  // ========================
  // COMMANDER OVERRIDE (TESTING)
  // ========================

  /**
   * Set commander override mode (for testing)
   * When enabled, the human player is always commander of their faction
   * When disabled, normal ranking logic applies immediately
   */
  setCommanderOverride(enabled) {
    // In multiplayer, server handles commander override — don't apply locally
    if (this.multiplayerMode) return;

    const wasEnabled = this.commanderOverride;
    this.commanderOverride = enabled;

    if (!this.humanPlayerFaction) {
      console.warn("[CommanderSystem] No human player faction set");
      return;
    }

    if (enabled) {
      // Override ON: Immediately make human player commander
      const humanPlayer = this.players.get(this.humanPlayerId);
      if (humanPlayer) {
        const currentCommander = this.commanders[this.humanPlayerFaction];
        // Force transfer to human player if not already commander
        if (
          !currentCommander ||
          currentCommander.playerId !== this.humanPlayerId
        ) {
          this._transferCommander(this.humanPlayerFaction, {
            playerId: this.humanPlayerId,
            username: humanPlayer.username,
            sessionCrypto: humanPlayer.sessionCrypto,
            tankRef: humanPlayer.tankRef,
            isHuman: true,
          });
        }
      }
    } else if (wasEnabled) {
      // Override OFF: Force re-evaluation based on actual rankings
      const rankings = this.getFactionRankings(this.humanPlayerFaction);
      const currentCommander = this.commanders[this.humanPlayerFaction];

      if (
        currentCommander &&
        currentCommander.playerId === this.humanPlayerId
      ) {
        const isTopRanked =
          rankings.length > 0 && rankings[0].playerId === this.humanPlayerId;

        if (!isTopRanked && rankings.length > 0) {
          this._transferCommander(this.humanPlayerFaction, rankings[0]);
        } else if (rankings.length === 0) {
          this._removeCommanderPerks(currentCommander, this.humanPlayerFaction);
          this.commanders[this.humanPlayerFaction] = null;
        }
      }
    }
  }

  /**
   * Check if commander override is enabled
   */
  isOverrideEnabled() {
    return this.commanderOverride;
  }

  // ========================
  // RESIGNATION
  // ========================

  /**
   * Resign from commander role for a specified duration
   * @param {number} duration - Resignation duration in milliseconds
   */
  resignCommander(duration) {
    if (!this.humanPlayerId || !this.humanPlayerFaction) {
      console.warn(
        "[CommanderSystem] Cannot resign - no human player registered",
      );
      return;
    }

    if (!this.isHumanCommander()) {
      console.warn("[CommanderSystem] Cannot resign - human is not commander");
      return;
    }

    // In multiplayer, send to server — it will re-evaluate and broadcast commander-update.
    // Don't remove perks locally — wait for server's commander-update event to trigger
    // applyServerCommander() which handles perk removal properly.
    if (this.multiplayerMode) {
      const net = window._mpState?.net;
      if (net) net.sendResign(duration);

      // Immediate dashboard UI feedback (resign dropdown hides)
      if (window.dashboard && window.dashboard.updateCommanderStatus) {
        window.dashboard.updateCommanderStatus(false);
      }
      return;
    }

    // Single-player: handle locally
    const currentCommander = this.commanders[this.humanPlayerFaction];

    // Set resignation expiry
    this.resignedUntil = Date.now() + duration;
    this.commanderOverride = false; // Disable override when resigning

    // Force re-evaluation of commander (will pick next highest ranked)
    const rankings = this.getFactionRankings(this.humanPlayerFaction);
    // Find the next player who isn't the human
    const nextCommander = rankings.find(
      (p) => p.playerId !== this.humanPlayerId,
    );

    if (nextCommander) {
      this._transferCommander(this.humanPlayerFaction, nextCommander);
    } else {
      // No one else to be commander
      this._removeCommanderPerks(currentCommander, this.humanPlayerFaction);
      this.commanders[this.humanPlayerFaction] = null;
    }

    // Update dashboard
    if (window.dashboard && window.dashboard.updateCommanderStatus) {
      window.dashboard.updateCommanderStatus(false);
    }
  }

  /**
   * Check if the human player is currently resigned
   */
  isResigned() {
    if (!this.resignedUntil) return false;

    const now = Date.now();
    if (now >= this.resignedUntil) {
      // Resignation expired
      this.resignedUntil = null;
      return false;
    }
    return true;
  }

  /**
   * Get remaining resignation time in milliseconds
   */
  getResignationTimeRemaining() {
    if (!this.resignedUntil) return 0;
    return Math.max(0, this.resignedUntil - Date.now());
  }

  /**
   * Cancel resignation early (reclaim commander if eligible)
   */
  cancelResignation() {
    this.resignedUntil = null;

    // In multiplayer, send to server — it will re-evaluate and broadcast commander-update
    if (this.multiplayerMode) {
      const net = window._mpState?.net;
      if (net) net.sendCancelResign();
      return;
    }

    // Re-evaluate commander (human might become commander again if top-ranked)
    if (this.humanPlayerFaction) {
      this._updateFactionCommander(this.humanPlayerFaction);
    }
  }

  // ========================
  // MULTIPLAYER MODE
  // ========================

  /**
   * Enable/disable multiplayer mode.
   * When enabled, server determines commanders and local ranking is skipped.
   */
  setMultiplayerMode(enabled) {
    this.multiplayerMode = enabled;
    // Despawn any local bodyguards — server handles them in multiplayer
    if (enabled && this.bodyguards) {
      this.bodyguards.despawn(false);
    }
  }

  /**
   * Set the human player's server socket ID.
   * Bridges the local "player" ID with the server-assigned socket ID
   * so that isCommander / applyServerCommander work correctly.
   */
  setHumanMultiplayerId(socketId) {
    this.humanMultiplayerId = socketId;
  }

  /**
   * Apply a server-authoritative commander assignment for a faction.
   * @param {string} faction - "rust", "cobalt", or "viridian"
   * @param {Object|null} commanderData - { id, name } or null to clear
   */
  applyServerCommander(faction, commanderData) {
    const current = this.commanders[faction];

    if (!commanderData) {
      // Server cleared the commander for this faction
      if (current) {
        this._removeCommanderPerks(current, faction);
        this.commanders[faction] = null;
        if (this.onCommanderChange) {
          this.onCommanderChange(null, current, faction);
        }
        // Update dashboard if this was our faction
        if (
          faction === this.humanPlayerFaction &&
          window.dashboard &&
          window.dashboard.updateCommanderStatus
        ) {
          window.dashboard.updateCommanderStatus(false);
        }
      }
      return;
    }

    // If the commander hasn't changed, check if we need to retry perk application
    if (current && current.playerId === commanderData.id) {
      // If tankRef was null when assigned, try to resolve it now
      if (!current.tankRef) {
        let player = this.players.get(commanderData.id);
        if (!player && commanderData.id === this.humanMultiplayerId) {
          player = this.players.get(this.humanPlayerId);
        }
        if (player && player.tankRef) {
          current.tankRef = player.tankRef;
          current.isHuman = player.isHuman;
          this._applyCommanderPerks(current, faction);
        }
      }
      // Always confirm dashboard state (handles override confirmations where
      // the commander was already set — dashboard may be out of sync)
      if (
        faction === this.humanPlayerFaction &&
        window.dashboard &&
        window.dashboard.updateCommanderStatus
      ) {
        window.dashboard.updateCommanderStatus(
          commanderData.id === this.humanPlayerId || commanderData.id === this.humanMultiplayerId,
        );
      }
      return;
    }

    // Look up the player for tankRef
    // If the incoming ID is the human player's socket ID, fall back to the
    // local "player" registration so we get the correct tankRef and isHuman flag.
    let player = this.players.get(commanderData.id);
    if (!player && commanderData.id === this.humanMultiplayerId) {
      player = this.players.get(this.humanPlayerId);
    }

    // Build commander object matching the existing format
    const newCommander = {
      playerId: commanderData.id,
      username: commanderData.name,
      sessionCrypto: player ? player.sessionCrypto : 0,
      tankRef: player ? player.tankRef : null,
      isHuman: player ? player.isHuman : false,
    };

    this._transferCommander(faction, newCommander);

    // Update dashboard
    if (
      faction === this.humanPlayerFaction &&
      window.dashboard &&
      window.dashboard.updateCommanderStatus
    ) {
      window.dashboard.updateCommanderStatus(
        commanderData.id === this.humanPlayerId || commanderData.id === this.humanMultiplayerId,
      );
    }
  }

  // ========================
  // UPDATE LOOP
  // ========================

  /**
   * Main update function - call each frame
   */
  update(timestamp) {
    // In multiplayer, server determines commanders — skip local ranking
    if (!this.multiplayerMode) {
      // Check rankings periodically (single-player / offline mode)
      if (timestamp - this.lastRankingCheck >= this.rankingCheckInterval) {
        this.lastRankingCheck = timestamp;

        // Sync human player's stats from crypto system
        if (this.cryptoSystem && this.humanPlayerId) {
          this.updateSessionCrypto(this.humanPlayerId, this.cryptoSystem.stats.sessionCrypto);
          this.updatePlayerStats(
            this.humanPlayerId,
            this.cryptoSystem.stats.level,
            this.cryptoSystem.stats.totalCrypto,
          );
        }

        // Sync bots
        this.syncBots();

        // Update commanders for all factions
        for (const faction of ["rust", "cobalt", "viridian"]) {
          this._updateFactionCommander(faction);
        }
      }
    }

    // Update subsystems
    if (this.bodyguards) {
      this.bodyguards.update(timestamp);
    }

    if (this.drawing) {
      this.drawing.update(timestamp);
    }

    if (this.tipSystem) {
      this.tipSystem.update(timestamp);
    }
  }

  // ========================
  // EVENT HANDLERS
  // ========================

  /**
   * Called when a commander dies
   */
  onCommanderDeath(faction) {
    const commander = this.commanders[faction];
    if (!commander) return;

    // Remove gold trim on death
    if (this.commanderSkin && commander.tankRef) {
      this.commanderSkin.removeTrim(commander.tankRef);
    }

    // Bodyguards die with commander (single-player only; server handles multiplayer)
    if (commander.isHuman && this.bodyguards && !this.multiplayerMode) {
      this.bodyguards.onCommanderDeath();
    }
  }

  /**
   * Called when a commander respawns
   */
  onCommanderRespawn(faction) {
    const commander = this.commanders[faction];
    if (!commander) return;

    // Restore gold trim on respawn
    if (this.commanderSkin && commander.tankRef) {
      this.commanderSkin.applyTrim(commander.tankRef);
    }

    // Respawn bodyguards (single-player only; server handles multiplayer)
    if (commander.isHuman && this.bodyguards && !this.multiplayerMode) {
      this.bodyguards.onCommanderRespawn();
    }
  }

  /**
   * Server-authoritative faction change handler for any player.
   * If the switching player was commander of their old faction, strips them
   * and finds a replacement. In the new faction, recalculates rankings to
   * determine whether the incoming player outranks the current commander.
   * @param {string} playerId - The player switching factions
   * @param {string} newFaction - The faction they're switching to
   */
  handleFactionChange(playerId, newFaction) {
    const player = this.players.get(playerId);
    if (!player) return;

    const oldFaction = player.faction;
    if (oldFaction === newFaction) return;

    // If this player was commander of the old faction, explicitly strip them
    const wasCommander =
      oldFaction && this.commanders[oldFaction]?.playerId === playerId;
    if (wasCommander) {
      this._removeCommanderPerks(this.commanders[oldFaction], oldFaction);
      this.commanders[oldFaction] = null;
    }

    // Move player to new faction and reset session crypto
    player.faction = newFaction;
    player.sessionCrypto = 0;

    // Old faction: find a new commander (level + crypto ranking)
    if (oldFaction) {
      this._updateFactionCommander(oldFaction);
    }

    // New faction: recalculate rankings — the incoming player's level and
    // crypto are compared against the existing commander to determine who
    // should lead
    this._updateFactionCommander(newFaction);
  }

  /**
   * Called when the human player changes faction.
   * Delegates to handleFactionChange and updates human-specific bookkeeping.
   */
  onPlayerFactionChange(newFaction) {
    this.humanPlayerFaction = newFaction;
    this.handleFactionChange(this.humanPlayerId, newFaction);
  }

  // ========================
  // DEBUG
  // ========================

  /**
   * Get debug info
   */
  getDebugInfo() {
    return {
      commanders: this.commanders,
      playerCount: this.players.size,
      commanderOverride: this.commanderOverride,
      humanPlayerId: this.humanPlayerId,
      humanPlayerFaction: this.humanPlayerFaction,
    };
  }
}
