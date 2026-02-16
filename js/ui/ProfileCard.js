/**
 * AdLands - Player Profile Card System
 * Right-click popup showing player stats, badges, and social actions
 * Triggers from: player tags, chat names, leaderboard, kill feed
 */

class ProfileCard {
  constructor(badgeSystem, titleSystem) {
    this.badgeSystem = badgeSystem;
    this.titleSystem = titleSystem;

    // Current card element
    this.cardElement = null;
    this.isVisible = false;
    this.currentPlayerId = null;

    // Player data cache
    this.playerCache = new Map();

    // Latest server crypto balances (socket ID → amount)
    this.latestCryptoState = {};

    // Tank ID to player ID mapping
    this.tankToPlayerId = new Map();

    // Player name to player ID mapping (for chat lookups)
    this.nameToPlayerId = new Map();

    // Reference to playerTags system (set externally)
    this.playerTags = null;

    // Mock player database (for demo)
    this._initMockPlayers();

    // Create card container
    this._createCardElement();

    // Setup global click handlers
    this._setupEventListeners();
  }

  // ========================
  // MOCK DATA
  // ========================

  _initMockPlayers() {
    // Create some mock player profiles for testing
    this.mockPlayers = {
      player_self: {
        id: "player_self",
        name: "You",
        isSelf: true,
      },
      bot_rust_1: this._createMockPlayer("RustMaster", "rust", 23),
      bot_rust_2: this._createMockPlayer("IronFist", "rust", 15),
      bot_cobalt_1: this._createMockPlayer("BlueSky", "cobalt", 31),
      bot_cobalt_2: this._createMockPlayer("DeepSix", "cobalt", 8),
      bot_viridian_1: this._createMockPlayer("GreenMachine", "viridian", 19),
      bot_viridian_2: this._createMockPlayer("Verdant", "viridian", 27),
    };
  }

  _createMockPlayer(name, faction, level) {
    const titles = [
      "Hunter",
      "Predator",
      "Survivor",
      "Conquistador",
      "Ghost",
      "Explorer",
    ];
    const badges = [
      "first_blood",
      "centurion",
      "survivor",
      "landlord",
      "squad_up",
    ];

    return {
      id: `mock_${name.toLowerCase()}`,
      name: name,
      faction: faction,
      level: level,
      crypto: Math.floor(Math.random() * 50000),
      cryptoToNext: 10000 + level * 5000,
      title: titles[Math.floor(Math.random() * titles.length)],
      rank: Math.floor(Math.random() * 50) + 1,
      squad: Math.random() > 0.5 ? "Alpha Squad" : null,
      isOnline: true,
      badges: badges.slice(0, Math.floor(Math.random() * badges.length) + 1),
      avatarColor: this._randomColor(),
      joinedAt: new Date(
        Date.now() - Math.floor(Math.random() * 90 + 1) * 86400000,
      ).toISOString(),
      socialLinks: {
        twitter: Math.random() > 0.7 ? "@" + name.toLowerCase() : null,
        twitch: Math.random() > 0.8 ? name.toLowerCase() : null,
      },
    };
  }

  _randomColor() {
    const colors = [
      "#8b4466",
      "#466a8b",
      "#6a8b46",
      "#8b6a46",
      "#6a468b",
      "#468b6a",
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  // ========================
  // UI CREATION
  // ========================

  _createCardElement() {
    this.cardElement = document.createElement("div");
    this.cardElement.id = "player-profile-card";
    this.cardElement.className = "profile-card hidden";
    document.body.appendChild(this.cardElement);
  }

  _buildCardHTML(player) {
    const factionClass = player.faction || "rust";
    const cryptoPercent =
      player.cryptoToNext > 0 ? (player.crypto / player.cryptoToNext) * 100 : 0;
    const badgeIcons = this._getBadgeIcons(player.badges || []);
    const badgeCount = (player.badges || []).length;

    return `
            <div class="profile-card-inner ${factionClass}">
                <div class="profile-card-header card-header-row">
                    <div class="profile-card-avatar card-header-image" style="${(player.avatarColor && player.avatarColor.startsWith("data:")) ? `background-image: url(${player.avatarColor}); background-size: cover; background-position: center;` : `background: ${player.avatarColor || "#8b4466"}`}">
                    </div>
                    <div class="profile-card-info card-header-info">
                        <div class="profile-card-name card-header-name">${player.name}</div>
                        <div class="profile-card-title card-header-subtitle${(player.title === "Commander" || player.title === "Acting Commander") ? " commander-title" : ""}">${player.title || "Contractor"}</div>
                    </div>
                    <button class="profile-card-close card-close-x"></button>
                </div>

                <div class="profile-card-crypto">
                    <div class="profile-card-level">${player.level || 1}</div>
                    <div class="profile-card-crypto-amount">¢ ${Number(player.crypto || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                </div>

                <div class="profile-card-details">
                    <div class="profile-card-row">
                        <span class="profile-card-label">Faction</span>
                        <span class="profile-card-value ${factionClass}">${this._capitalize(factionClass)}</span>
                    </div>
                    ${
                      player.squad
                        ? `
                    <div class="profile-card-row">
                        <span class="profile-card-label">Squad</span>
                        <span class="profile-card-value">${player.squad}</span>
                    </div>
                    `
                        : ""
                    }
                    <div class="profile-card-row">
                        <span class="profile-card-label">Faction Rank</span>
                        <span class="profile-card-value">#${player.rank || "?"}</span>
                    </div>
                    <div class="profile-card-row">
                        <span class="profile-card-label">Joined</span>
                        <span class="profile-card-value">${this._formatTimeAgo(player.joinedAt)}</span>
                    </div>
                </div>

                ${
                  badgeCount > 0
                    ? `
                <div class="profile-card-badges">
                    <div class="profile-card-badges-header">Badges (${badgeCount})</div>
                    <div class="profile-card-badges-grid">
                        ${badgeIcons}
                    </div>
                </div>
                `
                    : ""
                }

                ${this._buildSocialLinks(player.socialLinks)}

                <div class="profile-card-actions">
                    ${this._buildActionButtons(player)}
                </div>
            </div>
        `;
  }

  _getBadgeIcons(badgeIds) {
    const maxDisplay = 8;
    let html = "";

    for (let i = 0; i < Math.min(badgeIds.length, maxDisplay); i++) {
      const badge = this.badgeSystem?.getBadge(badgeIds[i]);
      if (badge) {
        const color = this.badgeSystem.getRarityColor(badge.rarity);
        html += `
                    <div class="profile-card-badge"
                         data-badge-id="${badge.id}"
                         style="color: ${color}">
                        ${badge.icon}
                    </div>
                `;
      }
    }

    if (badgeIds.length > maxDisplay) {
      html += `<div class="profile-card-badge-more">+${badgeIds.length - maxDisplay}</div>`;
    }

    return html;
  }

  /**
   * Attach tooltip events to badge elements after card HTML is inserted
   */
  _attachBadgeTooltipEvents() {
    if (!this.badgeSystem) return;

    const badgeEls = this.cardElement.querySelectorAll(
      ".profile-card-badge[data-badge-id]",
    );
    badgeEls.forEach((badgeEl) => {
      const badgeId = badgeEl.dataset.badgeId;
      const badge = this.badgeSystem.getBadge(badgeId);
      if (badge) {
        this.badgeSystem.attachTooltipEvents(badgeEl, badge);
      }
    });
  }

  _buildSocialLinks(links) {
    if (!links) return "";

    const hasLinks =
      links.twitter || links.twitch || links.youtube || links.discord;
    if (!hasLinks) return "";

    let html = '<div class="profile-card-social">';

    if (links.twitter) {
      html += `<a href="https://twitter.com/${links.twitter}" target="_blank" rel="noopener" class="social-link twitter">X</a>`;
    }
    if (links.twitch) {
      html += `<a href="https://twitch.tv/${links.twitch}" target="_blank" rel="noopener" class="social-link twitch">TTV</a>`;
    }
    if (links.youtube) {
      html += `<a href="https://youtube.com/${links.youtube}" target="_blank" rel="noopener" class="social-link youtube">YT</a>`;
    }
    if (links.discord) {
      html += `<span class="social-link discord" title="Discord: ${links.discord}">DC</span>`;
    }

    html += "</div>";
    return html;
  }

  _buildActionButtons(player) {
    if (player.isSelf) {
      return '<div class="profile-card-action-note">This is you</div>';
    }

    return `
            <button class="profile-card-btn primary" data-action="friend">
                Add Friend
            </button>
            <button class="profile-card-btn" data-action="message">
                Message
            </button>
            <button class="profile-card-btn" data-action="invite">
                Invite to Squad
            </button>
            <button class="profile-card-btn danger" data-action="block">
                Block
            </button>
        `;
  }

  _capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
  }

  _formatTimeAgo(isoString) {
    if (!isoString) return "Unknown";
    const date = new Date(isoString);
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  // ========================
  // EVENT HANDLING
  // ========================

  _setupEventListeners() {
    // Global right-click handler for player elements
    // Track right-click start to distinguish click from drag
    let rightClickStart = null;
    let rightClickTarget = null;

    document.addEventListener("contextmenu", (e) => {
      const playerElement = e.target.closest("[data-player-id]");
      if (playerElement) {
        e.preventDefault();
        e.stopPropagation();
        // Store start position and target for mouseup check
        rightClickStart = { x: e.clientX, y: e.clientY };
        rightClickTarget = playerElement;
      }
    });

    document.addEventListener("mouseup", (e) => {
      if (e.button !== 2) return; // Only right-click
      if (!rightClickStart || !rightClickTarget) return;

      const dx = Math.abs(e.clientX - rightClickStart.x);
      const dy = Math.abs(e.clientY - rightClickStart.y);
      const wasDrag = dx > 5 || dy > 5;

      const clickX = rightClickStart.x;
      const clickY = rightClickStart.y;
      const target = rightClickTarget;

      // Clear stored values
      rightClickStart = null;
      rightClickTarget = null;

      // If it was a drag, don't show the card
      if (wasDrag) {
        return;
      }

      // Block if camera is still considered orbiting
      if (window.gameCamera?.wasRightClickDragging?.()) {
        return;
      }

      const playerId = target.dataset.playerId;
      this.show(playerId, clickX, clickY);
    });

    // Click outside to close
    document.addEventListener("click", (e) => {
      if (this.isVisible && !this.cardElement.contains(e.target)) {
        this.hide();
      }
    });

    // Card button clicks
    this.cardElement.addEventListener("click", (e) => {
      const closeBtn = e.target.closest(".profile-card-close");
      if (closeBtn) {
        this.hide();
        return;
      }

      const actionBtn = e.target.closest(".profile-card-btn");
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        this._handleAction(action);
      }

      const badge = e.target.closest(".profile-card-badge");
      if (badge) {
        // Show badge tooltip
        const badgeId = badge.dataset.badgeId;
      }
    });

    // Escape key to close
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isVisible) {
        this.hide();
      }
    });
  }

  _handleAction(action) {
    const playerId = this.currentPlayerId;
    if (!playerId) return;

    switch (action) {
      case "friend":
        this._showNotification("Friend request sent");
        break;
      case "message":
        this._showNotification("Messages coming soon");
        break;
      case "invite":
        this._showNotification("Squad invite sent");
        break;
      case "block":
        this._showNotification("Player blocked");
        this.hide();
        break;
    }
  }

  _showNotification(message) {
    // Simple notification - could integrate with dashboard
  }

  // ========================
  // SHOW/HIDE
  // ========================

  /**
   * Show profile card for a player
   */
  show(playerId, x, y) {
    // Get player data
    const player = this._getPlayerData(playerId);
    if (!player) {
      console.warn("[ProfileCard] Player not found:", playerId);
      return;
    }

    // Pull latest crypto from server broadcast (most reliable source).
    // latestCryptoState is keyed by socket ID, so resolve "player_self" to the real socket ID.
    const cryptoLookupId = (playerId === "player_self" || playerId === "self" || playerId === "player")
      ? window.networkManager?.playerId
      : playerId;
    if (cryptoLookupId && this.latestCryptoState[cryptoLookupId] !== undefined) {
      player.crypto = this.latestCryptoState[cryptoLookupId];
    }

    // Override title at render time if this player is the current commander
    // (avoids cache mutation races between commander events and profile updates)
    const displayPlayer = Object.assign({}, player);
    if (window.commanderSystem?.isCommander(playerId)) {
      const playerFaction = displayPlayer.faction;
      const isActing = window.commanderSystem.actingCommanders?.[playerFaction] || false;
      displayPlayer.title = isActing ? "Acting Commander" : "Commander";
    }

    this.currentPlayerId = playerId;

    // Build and display card
    this.cardElement.innerHTML = this._buildCardHTML(displayPlayer);
    this._attachBadgeTooltipEvents();
    this.cardElement.classList.remove("hidden");
    this.isVisible = true;

    // Position card
    this._positionCard(x, y);
  }

  /**
   * Hide profile card
   */
  hide() {
    this.cardElement.classList.add("hidden");
    this.isVisible = false;
    this.currentPlayerId = null;
  }

  /**
   * Position card near click point, keeping it on screen
   */
  _positionCard(x, y) {
    const card = this.cardElement;
    const padding = 16;

    // Reset position to measure
    card.style.left = "0";
    card.style.top = "0";

    // Get card dimensions
    const rect = card.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    // Calculate position
    let left = x + padding;
    let top = y + padding;

    // Keep on screen horizontally
    if (left + rect.width > viewW - padding) {
      left = x - rect.width - padding;
    }
    if (left < padding) {
      left = padding;
    }

    // Keep on screen vertically
    if (top + rect.height > viewH - padding) {
      top = y - rect.height - padding;
    }
    if (top < padding) {
      top = padding;
    }

    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }

  // ========================
  // DATA ACCESS
  // ========================

  /**
   * Get player data by ID
   */
  _getPlayerData(playerId) {
    // For self player, always build fresh from current systems
    if (
      playerId === "player_self" ||
      playerId === "self" ||
      playerId === "player"
    ) {
      return this._buildSelfProfile();
    }

    // Check cache first
    if (this.playerCache.has(playerId)) {
      return this.playerCache.get(playerId);
    }

    // Check mock players
    if (this.mockPlayers[playerId]) {
      return this.mockPlayers[playerId];
    }

    // Try to build profile from playerTags if it's a tankId
    if (this.playerTags && this.playerTags.tags.has(playerId)) {
      return this._buildProfileFromTank(playerId);
    }

    return null;
  }

  /**
   * Build a player profile from tank tag data
   * @param {string} tankId - The tank identifier
   */
  _buildProfileFromTank(tankId) {
    if (!this.playerTags) return null;

    const tagData = this.playerTags.tags.get(tankId);
    if (!tagData || !tagData.config) return null;

    const config = tagData.config;

    // Use real data from playerCache if registered via registerPlayer()
    const cached = this.playerCache.get(tankId);

    const profile = {
      id: tankId,
      name: config.name,
      faction: config.faction || "rust",
      level: config.level || 1,
      crypto: cached?.crypto ?? 0,
      cryptoToNext: 10000 + (config.level || 1) * 5000,
      title: cached?.title || config.title || "Contractor",
      rank: cached?.rank || null,
      squad: config.squad || null,
      isOnline: true,
      badges: cached?.badges || [],
      avatarColor: config.avatarColor || this._randomColor(),
      socialLinks: {},
      isSelf: config.isPlayer || false,
    };

    // Cache for future lookups
    this.playerCache.set(tankId, profile);
    this.nameToPlayerId.set(config.name, tankId);

    return profile;
  }

  /**
   * Get player ID by name (for chat lookups)
   * @param {string} name - Player display name
   * @returns {string|null} - Player ID or null
   */
  getPlayerIdByName(name) {
    // Check name mapping
    if (this.nameToPlayerId.has(name)) {
      return this.nameToPlayerId.get(name);
    }

    // Search playerTags for matching name
    if (this.playerTags) {
      for (const [tankId, tagData] of this.playerTags.tags) {
        if (tagData.config && tagData.config.name === name) {
          this.nameToPlayerId.set(name, tankId);
          return tankId;
        }
      }
    }

    return null;
  }

  /**
   * Register a tank with the profile system
   * @param {string} tankId - Tank identifier
   * @param {Object} config - Tag config with name, faction, etc.
   */
  registerTank(tankId, config) {
    if (config && config.name) {
      this.nameToPlayerId.set(config.name, tankId);
      this.tankToPlayerId.set(tankId, tankId);
    }
  }

  /**
   * Build profile data for current player
   */
  _buildSelfProfile() {
    // Prefer server-authoritative crypto (includes damage/kill crypto tracked only server-side).
    // Fall back to local CryptoSystem if no server data yet.
    const socketId = window.networkManager?.playerId;
    const serverCrypto = socketId ? this.latestCryptoState[socketId] : undefined;
    return {
      id: "player_self",
      name: window.playerName || "Player",
      faction: window.playerFaction || "rust",
      level: window.cryptoSystem?.stats?.level || 1,
      crypto: serverCrypto ?? window.cryptoSystem?.stats?.totalCrypto ?? 0,
      cryptoToNext:
        window.cryptoSystem?.getCryptoRequiredForLevel?.(
          (window.cryptoSystem?.stats?.level || 1) + 1,
        ) || 10000,
      title: (window.commanderSystem?.isHumanCommander?.())
        ? (window.commanderSystem.isHumanActingCommander?.() ? "Acting Commander" : "Commander")
        : (this.titleSystem?.getTitle() || "Contractor"),
      rank: window.playerRank || null,
      squad: null,
      isOnline: true,
      badges: this.badgeSystem?.getUnlockedBadges()?.map((b) => b.id) || [],
      avatarColor: window.avatarColor || "#8b4466",
      joinedAt: window.playerJoinedAt || new Date().toISOString(),
      socialLinks: {},
      isSelf: true,
    };
  }

  /**
   * Register a player (for real multiplayer)
   */
  registerPlayer(player) {
    this.playerCache.set(player.id, player);
  }

  /**
   * Update a player's data
   */
  updatePlayer(playerId, updates) {
    const existing = this.playerCache.get(playerId);
    if (existing) {
      Object.assign(existing, updates);
    }
  }



  // ========================
  // UTILITIES
  // ========================

  /**
   * Add data-player-id attribute to an element
   */
  static addPlayerAttribute(element, playerId) {
    element.dataset.playerId = playerId;
    element.style.cursor = "context-menu";
  }

  /**
   * Create a clickable player name span
   */
  static createPlayerNameSpan(name, playerId, factionClass) {
    const span = document.createElement("span");
    span.className = `player-name ${factionClass || ""}`;
    span.textContent = name;
    span.dataset.playerId = playerId;
    span.style.cursor = "context-menu";
    return span;
  }
}
