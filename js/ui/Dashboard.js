/**
 * AdLands - Dashboard System
 * Collapsible left-side dashboard with multiple panels
 */

// Upgrade definitions per category
const UPGRADES = {
  offense: [
    { id: "cannon", name: "Cannon" },
    { id: "gunner", name: "Gunner" },
    { id: "50cal", name: "50 Cal" },
    { id: "missile", name: "Missile" },
    { id: "flamethrower", name: "Flame Thrower" },
  ],
  defense: [
    { id: "shield", name: "Shield" },
    { id: "flares", name: "Flares" },
    { id: "barricades", name: "Barricades" },
  ],
  tactical: [
    { id: "proximity_mine", name: "Proximity Mine" },
    { id: "foot_soldiers", name: "Foot Soldiers" },
    { id: "turrets", name: "Turrets" },
    { id: "welding_gun", name: "Welding Gun" },
  ],
};

// Slot unlock levels
const SLOT_UNLOCKS = {
  "offense-1": 1,
  "defense-1": 3,
  "tactical-1": 5,
  "offense-2": 8,
  "defense-2": 12,
  "tactical-2": 15,
};

class Dashboard {
  constructor() {
    // Panel definitions in order (profile is now in header)
    this.panels = [
      "stats",
      "faction",
      "loadout",
      "social",
      "tasks",
      "territory",
      "share",
      "settings",
    ];

    // Panel metadata
    this.panelMeta = {
      stats: { icon: "\uD83D\uDCC8", title: "Stats", hasBadge: false },
      faction: { icon: "\u2694", title: "Faction", hasBadge: false },
      loadout: { icon: "\u2699", title: "Loadout", hasBadge: false },
      social: { icon: "\uD83D\uDC65", title: "Social", hasBadge: true },
      tasks: { icon: "\uD83D\uDCCB", title: "Tasks", hasBadge: true },
      territory: { icon: "\u2691", title: "Claim Territory", hasBadge: false },
      share: { icon: "\uD83D\uDCF7", title: "Share", hasBadge: false },
      settings: { icon: "\u2699", title: "Settings", hasBadge: false },
    };

    // State
    this.isVisible = true;
    this.panelStates = new Map();
    this.badgeCounts = new Map();
    this.notificationDots = new Set();

    // Loadout state
    this.equippedUpgrades = {}; // slot -> upgradeId
    this.loadoutInitialized = false;

    // Territory claim state
    this._territoryPlanet = null;
    this._territoryTank = null;
    this._territoryCamera = null;
    this._playerTerritories = []; // { id, tierName, tileIndices, patternImage, timestamp }
    this._selectedTerritoryTier = null;
    this._territoryPreview = null; // { centerTile, rawCount, tileIndices, pricing }

    // DOM references
    this.container = null;
    this.panelElements = new Map();

    // External references (set by main.js)
    this.cryptoSystem = null;
    this.settingsManager = null;
    this.playerData = null;

    // Cached values for dirty-checking (skip DOM writes when unchanged)
    this._cachedStats = { kills: null, deaths: null, kd: null, damage: null, tics: null, hexes: null, clusters: null };
    this._cachedProfile = { level: null, crypto: null, rank: null, rankTotal: null };
    this._formattedStrings = { damage: "", tics: "", crypto: "" };
    this._serverCryptoMode = false; // When true, updateCrypto() owns the roller (skip updateProfile crypto)

    // Slot-machine roller state
    this._rollerColumns = [];
    this._rollerPreviousString = "";
    this._rollerContainer = null;

    // Guest nudge state
    this._shownNudges = new Set();
    this._nudgeCount = 0;

    // Load persisted state
    this._loadState();

    // Create UI
    this._createUI();

    // Setup event listeners
    this._setupEventListeners();

    // Initialize loadout if panel was already expanded (persisted from previous session)
    const loadoutState = this.panelStates.get("loadout");
    if (loadoutState && loadoutState.expanded) {
      // Defer initialization to ensure DOM is ready and playerLevel is set
      setTimeout(() => {
        this.initLoadout(this.playerLevel || 1);
      }, 0);
    }
  }

  // ========================
  // UI CREATION
  // ========================

  _createUI() {
    // Create dashboard container
    this.container = document.createElement("div");
    this.container.id = "dashboard-container";
    this.container.className = "dashboard";

    // Create header
    const header = this._createHeader();
    this.container.appendChild(header);

    // Create scrollable panels container
    const panelsContainer = document.createElement("div");
    panelsContainer.className = "dashboard-panels";

    // Create each panel
    this.panels.forEach((panelId, index) => {
      const panel = this._createPanel(panelId, index);
      panelsContainer.appendChild(panel);
      this.panelElements.set(panelId, panel);
    });

    this.container.appendChild(panelsContainer);
    document.body.appendChild(this.container);

    // Apply initial visibility state
    if (!this.isVisible) {
      this.container.classList.add("collapsed");
    }

    // Apply settings section collapsed states
    this._applySectionStates();
  }

  _createHeader() {
    const header = document.createElement("div");
    header.className = "dashboard-header";
    header.innerHTML = `
            <div class="header-profile card-header-row">
                <div class="header-avatar card-header-image" id="dashboard-avatar">
                    <div class="avatar-inner" id="dashboard-avatar-inner"></div>
                </div>
                <div class="header-info card-header-info">
                    <div class="header-name card-header-name" id="dashboard-player-name">Player</div>
                    <div class="header-title-row">
                        <div class="header-title card-header-subtitle" id="dashboard-player-title">Rookie Contractor</div>
                        <div class="commander-resign-dropdown hidden" id="commander-resign-dropdown">
                            <button class="resign-toggle" id="resign-toggle-btn">Resign ▼</button>
                            <div class="resign-menu hidden" id="resign-menu">
                                <div class="resign-header">Resign Command</div>
                                <button class="resign-option" data-duration="60000">For 1 Minute</button>
                                <button class="resign-option" data-duration="3600000">For 1 Hour</button>
                                <button class="resign-option" data-duration="86400000">For 24 Hours</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="header-crypto">
                <div class="header-level" id="dashboard-level">1</div>
                <div class="header-crypto-amount">¢<span id="dashboard-crypto-current">0</span></div>
            </div>
            <button class="header-switch-profile hidden" id="dashboard-switch-profile" title="Switch Profile">Switch Profile</button>
        `;

    // Setup resign dropdown after header is created
    setTimeout(() => this._setupResignDropdown(), 0);

    // Setup level-up popup click handler
    setTimeout(() => this._setupLevelUpPopup(), 0);

    return header;
  }

  /**
   * Setup the resign dropdown menu events
   */
  _setupResignDropdown() {
    const toggleBtn = document.getElementById("resign-toggle-btn");
    const menu = document.getElementById("resign-menu");

    if (!toggleBtn || !menu) return;

    // Move menu to body so it escapes dashboard container's
    // contain:paint / will-change:transform containment
    document.body.appendChild(menu);

    // Toggle menu on button click
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasHidden = menu.classList.contains("hidden");
      menu.classList.toggle("hidden");

      // Position menu below the toggle button when opening
      if (wasHidden) {
        const rect = toggleBtn.getBoundingClientRect();
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${rect.left}px`;
      }
    });

    // Handle resign option clicks
    menu.addEventListener("click", (e) => {
      const option = e.target.closest(".resign-option");
      if (option) {
        const duration = parseInt(option.dataset.duration, 10);
        this._handleResign(duration);
        menu.classList.add("hidden");
      }
    });

    // Close menu when clicking outside (menu is now in body, check both)
    document.addEventListener("click", (e) => {
      if (
        !e.target.closest(".commander-resign-dropdown") &&
        !e.target.closest(".resign-menu")
      ) {
        menu.classList.add("hidden");
      }
    });
  }

  /**
   * Handle commander resignation
   * @param {number} duration - Resignation duration in milliseconds
   */
  _handleResign(duration) {
    if (!window.commanderSystem) return;

    const durationText =
      duration === 60000
        ? "1 minute"
        : duration === 3600000
          ? "1 hour"
          : "24 hours";

    // Resign from commander role
    window.commanderSystem.resignCommander(duration);

    // Show Tusk commentary about resignation
    if (window.tuskCommentary && window.tuskCommentary.onCommanderResign) {
      window.tuskCommentary.onCommanderResign(durationText);
    }
  }

  /**
   * Update commander badge visibility and button state
   * @param {boolean} isCommander - Whether the player is currently commander (or acting)
   * @param {boolean} isActing - Whether the player is an Acting Commander (true commander offline)
   */
  updateCommanderStatus(isCommander, isActing = false) {
    // Update resign dropdown visibility
    const resignDropdown = document.getElementById("commander-resign-dropdown");
    if (resignDropdown) {
      if (isCommander) {
        resignDropdown.classList.remove("hidden");
      } else {
        resignDropdown.classList.add("hidden");
        // Close resign menu if open
        const menu = document.getElementById("resign-menu");
        if (menu) menu.classList.add("hidden");
      }
    }

    // Update title to "Commander" / "Acting Commander" or restore previous title
    const titleEl = document.getElementById("dashboard-player-title");
    if (titleEl) {
      if (isCommander) {
        // Store previous title for restoration
        if (!this._previousTitle) {
          this._previousTitle = titleEl.textContent;
        }
        titleEl.textContent = isActing ? "Acting Commander" : "Commander";
        titleEl.classList.add("commander-title");
      } else {
        // Restore previous title (fallback to title system or default)
        const restored = this._previousTitle
          || (this.titleSystem && this.titleSystem.getTitle())
          || "Contractor";
        titleEl.textContent = restored;
        this._previousTitle = null;
        titleEl.classList.remove("commander-title");
      }
    }

    // Update button state
    this._updateBecomeCommanderButton(isCommander);
  }

  _createPanel(panelId, order) {
    const state = this.panelStates.get(panelId) || { expanded: false, order };
    const meta = this.panelMeta[panelId];

    const panel = document.createElement("div");
    panel.className = "dashboard-panel";
    panel.dataset.panel = panelId;

    // Create header
    const header = document.createElement("div");
    header.className = "panel-header";
    header.dataset.expanded = state.expanded.toString();

    const badgeCount = this.badgeCounts.get(panelId) || 0;
    const badgeHidden = !meta.hasBadge || badgeCount <= 0;

    header.innerHTML = `
            <span class="panel-icon">${meta.icon}</span>
            <span class="panel-title">${meta.title}</span>
            <span class="panel-badge${badgeHidden ? " hidden" : ""}">${badgeCount}</span>
            <span class="panel-chevron">\u25B6</span>
        `;

    // Create content
    const content = document.createElement("div");
    content.className = "panel-content";
    content.innerHTML = this._buildPanelContent(panelId);

    panel.appendChild(header);
    panel.appendChild(content);

    return panel;
  }

  _buildPanelContent(panelId) {
    switch (panelId) {
      case "stats":
        return this._buildStatsContent();
      case "faction":
        return this._buildFactionContent();
      case "loadout":
        return this._buildLoadoutContent();
      case "social":
        return this._buildSocialContent();
      case "tasks":
        return this._buildTasksContent();
      case "territory":
        return this._buildTerritoryContent();
      case "share":
        return this._buildShareContent();
      case "settings":
        return this._buildSettingsContent();
      default:
        return '<div class="panel-inner"><p>Coming soon...</p></div>';
    }
  }

  // ========================
  // PANEL CONTENT BUILDERS
  // ========================

  _buildStatsContent() {
    return `
            <div class="panel-inner">
                <div class="stats-badges" id="dashboard-badges">
                    <div class="stats-badges-label">Badges (<span id="dashboard-badge-count">0</span>)</div>
                    <div class="stats-badges-grid" id="dashboard-badges-grid"></div>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Kills:</span>
                    <span class="stat-value" id="dashboard-kills">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Deaths:</span>
                    <span class="stat-value" id="dashboard-deaths">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">K/D Ratio:</span>
                    <span class="stat-value" id="dashboard-kd">0.00</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Damage Dealt:</span>
                    <span class="stat-value" id="dashboard-damage">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Tics Contributed:</span>
                    <span class="stat-value" id="dashboard-tics">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Hexes Captured:</span>
                    <span class="stat-value" id="dashboard-hexes">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Clusters Captured:</span>
                    <span class="stat-value" id="dashboard-clusters">0</span>
                </div>
            </div>
        `;
  }

  _buildFactionContent() {
    return `
            <div class="panel-inner">
                <div class="faction-roster-header">
                    <div class="faction-roster-count" id="faction-roster-count">Loading...</div>
                </div>
                <div class="faction-roster-list" id="faction-roster-list">
                    <div class="empty-state" style="padding:12px;opacity:0.5;font-size:12px;">Waiting for roster data...</div>
                </div>
            </div>
        `;
  }

  /**
   * Reset faction panel title and roster when the player's faction changes.
   */
  _resetFactionPanel(faction) {
    const factionName = faction.charAt(0).toUpperCase() + faction.slice(1);
    this.updatePanelTitle("faction", "Faction Leaderboard");

    // Clear stale roster from old faction
    this._lastRosterData = null;
    const countEl = document.getElementById("faction-roster-count");
    if (countEl) countEl.textContent = "Loading...";
    const listEl = document.getElementById("faction-roster-list");
    if (listEl) {
      listEl.innerHTML = '<div class="empty-state" style="padding:12px;opacity:0.5;font-size:12px;">Waiting for roster data...</div>';
    }
  }

  updateFactionRoster(data) {
    // Ignore roster data for a different faction (stale broadcast after switching)
    if (data.faction && data.faction !== this.playerFaction) return;

    this._lastRosterData = data;

    const countEl = document.getElementById("faction-roster-count");
    if (countEl) {
      countEl.textContent = `${data.total} member${data.total !== 1 ? "s" : ""}`;
    }

    const listEl = document.getElementById("faction-roster-list");
    if (!listEl) return;

    // Determine who the active commander is
    const cmdrSystem = window.commanderSystem;
    const myFaction = cmdrSystem?.humanPlayerFaction;
    const factionCmdr = myFaction ? cmdrSystem?.commanders[myFaction] : null;
    const cmdrPlayerId = factionCmdr?.playerId || null;
    const isActingCmdr = myFaction ? (cmdrSystem?.actingCommanders[myFaction] || false) : false;

    let html = "";
    const faction = data.faction || this.playerFaction;
    for (const member of data.members) {
      const onlineClass = member.online ? "roster-online" : "roster-offline";
      const selfClass = member.isSelf ? "roster-self" : "";
      const statusDot = member.online
        ? '<span class="roster-dot online"></span>'
        : '<span class="roster-dot offline"></span>';

      const cmdrRowClass = member.rank === 1 ? "roster-commander" : "";

      // Use "player_self" for self, server-provided id for everyone else
      const playerId = member.isSelf ? "player_self" : member.id;
      const playerIdAttr = playerId ? `data-player-id="${playerId}"` : "";

      const cryptoDisplay = member.crypto !== undefined ? `<span class="roster-crypto">¢${Number(member.crypto).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>` : '';

      const avatarStyle = member.avatarColor && member.avatarColor.startsWith("data:")
        ? `background-image: url(${member.avatarColor}); background-size: cover; background-position: center;`
        : `background: ${member.avatarColor || "#555"};`;

      html += `<div class="roster-member ${cmdrRowClass} ${onlineClass} ${selfClass}" ${playerIdAttr}>
                <span class="roster-rank">#${member.rank}</span>
                ${statusDot}
                <span class="roster-avatar" style="${avatarStyle}"></span>
                <span class="roster-name">${member.name}</span>
                ${cryptoDisplay}
                <span class="roster-level">Lv${member.level}</span>
            </div>`;

      // Register offline/unknown roster members with ProfileCard so right-click works
      if (!member.isSelf && playerId && window.profileCard) {
        if (!window.profileCard.playerCache.has(playerId)) {
          window.profileCard.playerCache.set(playerId, {
            id: playerId,
            name: member.name,
            faction: faction,
            level: member.level || 1,
            crypto: member.crypto || 0,
            rank: member.rank,
            isOnline: member.online,
            badges: [],
            avatarColor: member.avatarColor || null,
            socialLinks: {},
            title: member.rank === 1 ? "Commander" : "Contractor",
          });
        } else {
          // Update crypto in existing cache entry
          const cached = window.profileCard.playerCache.get(playerId);
          if (member.crypto !== undefined) cached.crypto = member.crypto;
        }
      }
    }

    if (data.members.length === 0) {
      html = '<div class="empty-state" style="padding:12px;opacity:0.5;font-size:12px;">No faction members</div>';
    }

    listEl.innerHTML = html;

    // Auto-scroll to the current player's row so they can find themselves
    const selfRow = listEl.querySelector(".roster-self");
    if (selfRow) selfRow.scrollIntoView({ block: "nearest" });
  }

  _buildLoadoutContent() {
    return `
            <div class="panel-inner">
                <div class="loadout-container">
                    <!-- 3-Column Layout: Upgrades + Slots per category -->
                    <div class="loadout-columns" id="loadout-columns">
                        <!-- Rendered dynamically -->
                    </div>

                    <!-- Tank Preview (real-time 3D) -->
                    <div class="loadout-tank-preview">
                        <canvas id="tank-preview-canvas"></canvas>
                    </div>

                    <button class="cosmetics-store-btn" id="btn-open-cosmetics">Cosmetics Store</button>
                </div>
            </div>
        `;
  }

  _buildSocialContent() {
    return `
            <div class="panel-inner">
                <div class="social-section">
                    <div class="messages-tabs">
                        <button class="msg-tab active" data-tab="dm">DMs</button>
                        <button class="msg-tab" data-tab="faction">Faction</button>
                        <button class="msg-tab" data-tab="global">Global</button>
                    </div>
                    <div class="messages-list" id="dashboard-messages">
                        <div class="empty-state">No messages</div>
                    </div>
                </div>
                <div class="social-section">
                    <div class="section-title">Squad</div>
                    <div class="squad-info" id="dashboard-squad">
                        <div class="empty-state">Not in a squad</div>
                    </div>
                    <button class="squad-btn" id="btn-open-squad">Open a Squad</button>
                </div>
                <div class="social-section">
                    <div class="section-title">Friends (0)</div>
                    <div class="social-search">
                        <input type="text" class="social-search-input" id="friend-search" placeholder="Search players...">
                    </div>
                    <div class="friends-list" id="dashboard-friends">
                        <div class="empty-state">No friends yet</div>
                    </div>
                </div>
            </div>
        `;
  }

  _buildTasksContent() {
    return `
            <div class="panel-inner">
                <div class="tasks-section">
                    <div class="section-title">Daily Tasks</div>
                    <div class="tasks-list" id="dashboard-daily-tasks">
                        <div class="empty-state">No active tasks</div>
                    </div>
                </div>
                <div class="tasks-section">
                    <div class="section-title">Weekly Tasks</div>
                    <div class="tasks-list" id="dashboard-weekly-tasks">
                        <div class="empty-state">No active tasks</div>
                    </div>
                </div>
            </div>
        `;
  }

  _buildTerritoryContent() {
    return `
            <div class="panel-inner territory-panel">
                <div class="territory-description">
                    Rent a hex. Plant your flag. Show everyone who owns this ground.
                </div>

                <div class="territory-tiers" id="territory-tiers">
                    <div class="territory-tier-card" data-tier="outpost">
                        <div class="tier-card-header">
                            <span class="tier-card-name">Outpost</span>
                        </div>
                        <div class="tier-card-details">
                            <span class="tier-card-hexes" id="territory-hexes-outpost">1 hex</span>
                            <span class="tier-card-price" id="territory-price-outpost">--</span>
                        </div>
                    </div>

                    <div class="territory-tier-card" data-tier="compound">
                        <div class="tier-card-header">
                            <span class="tier-card-name">Compound</span>
                        </div>
                        <div class="tier-card-details">
                            <span class="tier-card-hexes" id="territory-hexes-compound">up to 7 hexes</span>
                            <span class="tier-card-price" id="territory-price-compound">--</span>
                        </div>
                    </div>

                    <div class="territory-tier-card" data-tier="stronghold">
                        <div class="tier-card-header">
                            <span class="tier-card-name">Stronghold</span>
                        </div>
                        <div class="tier-card-details">
                            <span class="tier-card-hexes" id="territory-hexes-stronghold">up to 19 hexes</span>
                            <span class="tier-card-price" id="territory-price-stronghold">--</span>
                        </div>
                    </div>
                </div>

                <div class="territory-preview hidden" id="territory-preview">
                    <div class="preview-header">Claim Preview</div>
                    <div class="preview-hex-count" id="territory-hex-count"></div>
                    <div class="preview-overlap-warning hidden" id="territory-overlap-warning"></div>
                    <div class="preview-pricing" id="territory-pricing"></div>
                    <div class="preview-actions">
                        <button class="territory-btn territory-btn-claim" id="btn-territory-claim">
                            Claim Territory
                        </button>
                        <button class="territory-btn territory-btn-cancel" id="btn-territory-cancel">
                            Cancel
                        </button>
                    </div>
                </div>

                <div class="territory-owned" id="territory-owned">
                    <div class="territory-section-title">Your Territories</div>
                    <div class="territory-list" id="territory-list">
                        <div class="empty-state">No territories claimed</div>
                    </div>
                </div>

            </div>
        `;
  }

  _buildShareContent() {
    return `
            <div class="panel-inner">
                <button class="share-btn" id="btn-screenshot">
                    \uD83D\uDCF7 Take Screenshot (F12)
                </button>
                <div class="share-preview" id="share-preview">
                    <div class="empty-state">No screenshot</div>
                </div>
                <div class="share-buttons">
                    <button class="social-share-btn" data-platform="twitter" disabled>Twitter/X</button>
                    <button class="social-share-btn" data-platform="reddit" disabled>Reddit</button>
                    <button class="social-share-btn" data-platform="download" disabled>Download</button>
                </div>
            </div>
        `;
  }

  _buildSettingsContent() {
    return `
            <div class="panel-inner settings-panel">
                <!-- Graphics Section -->
                <div class="settings-section" data-section="graphics">
                    <div class="settings-section-header">
                        <span class="settings-section-chevron">▶</span>
                        <span class="settings-section-title">Graphics</span>
                        <button class="reset-section-btn" data-section="graphics" title="Reset Graphics">↺</button>
                    </div>
                    <div class="settings-section-content">
                        <div class="setting-row">
                            <label>Shadows</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-shadows" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row">
                            <label>Lens Dirt</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-lens-dirt" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row">
                            <label>Vignette</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-vignette" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row">
                            <label>Chromatic Aberration</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-chromatic" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row">
                            <label>Damage Effects</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-damage-effects" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row sub-setting">
                            <label>Scanlines</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-damage-scanlines" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row sub-setting">
                            <label>Noise</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-damage-noise" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row sub-setting">
                            <label>Glitch</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-damage-glitch" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row sub-setting">
                            <label>Signal Loss</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-damage-signal-loss" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- Audio Section -->
                <div class="settings-section" data-section="audio">
                    <div class="settings-section-header">
                        <span class="settings-section-chevron">▶</span>
                        <span class="settings-section-title">Audio</span>
                        <button class="reset-section-btn" data-section="audio" title="Reset Audio">↺</button>
                    </div>
                    <div class="settings-section-content">
                        <div class="setting-row">
                            <label>Master Volume</label>
                            <input type="range" id="setting-master-volume"
                                   min="0" max="1" step="0.1" value="0.8">
                            <span class="setting-value" id="val-master-volume">80%</span>
                        </div>
                        <div class="setting-row">
                            <label>SFX Volume</label>
                            <input type="range" id="setting-sfx-volume"
                                   min="0" max="1" step="0.1" value="0.8">
                            <span class="setting-value" id="val-sfx-volume">80%</span>
                        </div>
                        <div class="setting-row">
                            <label>Music Volume</label>
                            <input type="range" id="setting-music-volume"
                                   min="0" max="1" step="0.1" value="0.5">
                            <span class="setting-value" id="val-music-volume">50%</span>
                        </div>
                        <div class="setting-row">
                            <label>UI Sounds</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-ui-sounds" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                    </div>
                </div>

                <!-- Controls Section -->
                <div class="settings-section" data-section="controls">
                    <div class="settings-section-header">
                        <span class="settings-section-chevron">▶</span>
                        <span class="settings-section-title">Controls</span>
                        <button class="reset-section-btn" data-section="controls" title="Reset Controls">↺</button>
                    </div>
                    <div class="settings-section-content">
                        <div class="setting-row">
                            <label>Mouse Sensitivity</label>
                            <input type="range" id="setting-mouse-sensitivity"
                                   min="0.1" max="2" step="0.1" value="0.5">
                            <span class="setting-value" id="val-mouse-sensitivity">0.50</span>
                        </div>
                        <div class="setting-row">
                            <label>Invert Y Axis</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-invert-y">
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="controls-hints">
                            <div class="controls-hint"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> <span>Move</span></div>
                            <div class="controls-hint"><kbd>H</kbd> <span>Hide UI</span></div>
                            <div class="controls-hint"><kbd>Left Click</kbd> <span>Fire</span></div>
                            <div class="controls-hint"><kbd>Right Drag</kbd> <span>Orbit Camera</span></div>
                        </div>
                    </div>
                </div>

                <!-- Gameplay Section -->
                <div class="settings-section" data-section="gameplay">
                    <div class="settings-section-header">
                        <span class="settings-section-chevron">▶</span>
                        <span class="settings-section-title">Gameplay</span>
                        <button class="reset-section-btn" data-section="gameplay" title="Reset Gameplay">↺</button>
                    </div>
                    <div class="settings-section-content">
                        <div class="setting-row">
                            <label>Crypto Popups</label>
                            <label class="toggle-switch">
                                <input type="checkbox" id="setting-crypto-popups" checked>
                                <span class="toggle-slider"></span>
                            </label>
                        </div>
                        <div class="setting-row">
                            <label>Colorblind Mode</label>
                            <select id="setting-colorblind">
                                <option value="off">Off</option>
                                <option value="deuteranopia">Deuteranopia</option>
                                <option value="protanopia">Protanopia</option>
                                <option value="tritanopia">Tritanopia</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label>Tusk Commentary</label>
                            <select id="setting-tusk-commentary">
                                <option value="full">Full</option>
                                <option value="important">Important Only</option>
                                <option value="off">Off</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Privacy Section -->
                <div class="settings-section" data-section="privacy">
                    <div class="settings-section-header">
                        <span class="settings-section-chevron">▶</span>
                        <span class="settings-section-title">Privacy</span>
                        <button class="reset-section-btn" data-section="privacy" title="Reset Privacy">↺</button>
                    </div>
                    <div class="settings-section-content">
                        <div class="setting-row">
                            <label>Profile Visibility</label>
                            <select id="setting-profile-visibility">
                                <option value="public">Public</option>
                                <option value="faction">Faction Only</option>
                                <option value="friends">Friends Only</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Developer Section -->
                <div class="settings-section" data-section="developer">
                    <div class="settings-section-header">
                        <span class="settings-section-chevron">▶</span>
                        <span class="settings-section-title">Developer</span>
                        <button class="reset-section-btn" data-section="developer" title="Reset Developer">↺</button>
                    </div>
                    <div class="settings-section-content">
                        <div class="setting-row">
                            <label>Faction</label>
                            <select id="setting-dev-faction" class="setting-select">
                                <option value="rust">Rust</option>
                                <option value="cobalt">Cobalt</option>
                                <option value="viridian">Viridian</option>
                            </select>
                        </div>
                        <div class="setting-row">
                            <label>Become Commander</label>
                            <button class="setting-btn" id="btn-become-commander">★ Activate</button>
                        </div>
                    </div>
                </div>

                <!-- Reset All Button -->
                <div class="settings-reset-all">
                    <button id="reset-all-settings" class="reset-all-btn">Reset All Settings</button>
                </div>
            </div>
        `;
  }

  // ========================
  // EVENT HANDLING
  // ========================

  _setupEventListeners() {
    // Panel header click to expand/collapse
    this.container.addEventListener("click", (e) => {
      const header = e.target.closest(".panel-header");
      if (header) {
        this._togglePanel(header);
      }

      // Settings section header click (but not on reset button)
      const sectionHeader = e.target.closest(".settings-section-header");
      if (sectionHeader && !e.target.closest(".reset-section-btn")) {
        const section = sectionHeader.closest(".settings-section");
        const sectionId = section.dataset.section;
        section.classList.toggle("collapsed");

        // Persist collapsed state
        this._saveSectionState(
          sectionId,
          section.classList.contains("collapsed"),
        );
      }

      // Reset section button click
      const resetSectionBtn = e.target.closest(".reset-section-btn");
      if (resetSectionBtn) {
        e.stopPropagation();
        const section = resetSectionBtn.dataset.section;
        if (this.settingsManager && section) {
          this.settingsManager.resetSection(section);
        }
      }

      // Reset all settings button click
      if (e.target.id === "reset-all-settings") {
        if (this.settingsManager) {
          this.settingsManager.resetAll();
        }
      }
    });

    // Cosmetics Store button
    this.container.addEventListener("click", (e) => {
      if (e.target.id === "btn-open-cosmetics") {
        this._openCosmeticsModal();
      }
    });

    // Become Commander button
    this.container.addEventListener("click", (e) => {
      if (e.target.id === "btn-become-commander") {
        this._handleBecomeCommander();
      }
    });

    // Switch Profile button
    this.container.addEventListener("click", (e) => {
      if (e.target.id === "dashboard-switch-profile") {
        this._handleSwitchProfile();
      }
    });

    // Territory panel interactions
    this.container.addEventListener("click", (e) => {
      const tierCard = e.target.closest(".territory-tier-card");
      if (tierCard) {
        this._selectTerritoryTier(tierCard.dataset.tier);
      }

      if (e.target.id === "btn-territory-claim") {
        this._claimTerritory();
      }

      if (e.target.id === "btn-territory-cancel") {
        this._cancelTerritoryPreview();
      }

      // Image upload button on owned territory
      const uploadBtn = e.target.closest(".territory-item-upload");
      if (uploadBtn) {
        const territoryId = uploadBtn.dataset.territoryId;
        console.log(`[Dashboard] Upload button clicked for territory ${territoryId}`);
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = () => this._handleTerritoryUpload(input, territoryId);
        input.click();
      }

      // Cancel subscription button
      const cancelBtn = e.target.closest(".territory-item-cancel");
      if (cancelBtn) {
        const territoryId = cancelBtn.dataset.territoryId;
        this._cancelTerritorySubscription(territoryId);
      }
    });

    // Territory adjustment sliders (scale, offsetX, offsetY)
    // "input" → lightweight UV-only update (fast, no material recreation)
    // "change" → full texture + storage save (on slider release)
    this._territoryUVTimer = null;
    this.container.addEventListener("input", (e) => {
      const slider = e.target;
      if (!slider.classList.contains("territory-scale-slider") &&
          !slider.classList.contains("territory-offsetx-slider") &&
          !slider.classList.contains("territory-offsety-slider")) return;

      const territoryId = slider.dataset.territoryId;
      const value = parseFloat(slider.value);

      // Update displayed value
      const valueSpan = slider.nextElementSibling;
      if (valueSpan) {
        valueSpan.textContent = slider.classList.contains("territory-scale-slider")
          ? value.toFixed(1) : value.toFixed(2);
      }

      let key;
      if (slider.classList.contains("territory-scale-slider")) key = "scale";
      else if (slider.classList.contains("territory-offsetx-slider")) key = "offsetX";
      else key = "offsetY";

      // Update local state immediately (no storage write)
      const territory = this._playerTerritories.find((t) => t.id === territoryId);
      if (!territory) return;
      if (!territory.patternAdjustment) {
        territory.patternAdjustment = {
          scale: 1.0, offsetX: 0, offsetY: 0,
          saturation: 0.7, inputBlack: 30, inputGamma: 1.0,
          inputWhite: 225, outputBlack: 40, outputWhite: 215,
        };
      }
      territory.patternAdjustment[key] = value;

      // Lightweight UV-only update (no material/texture recreation)
      clearTimeout(this._territoryUVTimer);
      this._territoryUVTimer = setTimeout(() => {
        if (this._territoryPlanet) {
          this._territoryPlanet._updateSponsorTileUVs(
            territory.tileIndices,
            territory.patternAdjustment,
          );
        }
      }, 16); // ~60fps cap
    });

    // On slider release, persist to storage
    this.container.addEventListener("change", (e) => {
      const slider = e.target;
      if (!slider.classList.contains("territory-scale-slider") &&
          !slider.classList.contains("territory-offsetx-slider") &&
          !slider.classList.contains("territory-offsety-slider")) return;

      const territoryId = slider.dataset.territoryId;
      const territory = this._playerTerritories.find((t) => t.id === territoryId);
      if (!territory) return;

      this._updatePlayerTerritory(territoryId, {
        patternAdjustment: territory.patternAdjustment,
      });
    });

    // Note: H key toggle is handled by main.js to coordinate with chat window
  }

  /**
   * Handle the "Become Commander" button click
   */
  _handleBecomeCommander() {
    if (!window.commanderSystem) return;

    // Check if already commander
    if (window.commanderSystem.isHumanCommander()) {
      return;
    }

    // Check if resigned
    if (window.commanderSystem.isResigned()) {
      window.commanderSystem.cancelResignation();
    }

    // In multiplayer, send to server only — server responds with commander-update
    // which triggers applyServerCommander() → updateCommanderStatus()
    if (window.networkManager) {
      window.networkManager.sendCommanderOverride();
      // Immediate visual feedback while waiting for server confirmation
      const btn = document.getElementById("btn-become-commander");
      if (btn) {
        btn.textContent = "★ Requesting...";
        btn.disabled = true;
      }
    } else {
      // Single-player: apply locally
      window.commanderSystem.setCommanderOverride(true);
      this._updateBecomeCommanderButton(true);
    }
  }

  /**
   * Handle the "Switch Profile" button click.
   * Shows the auth screen profile selector overlay.
   */
  _handleSwitchProfile() {
    // Find the auth screen instance on the window
    const authScreen = document.getElementById("auth-screen");
    if (!authScreen || !window.authManager?.isSignedIn) return;

    // Save current profile before showing selector
    if (window.profileManager) {
      window.profileManager.saveNow();
    }

    // Show the profile-selector directly (profiles are already loaded)
    if (window._authScreenInstance) {
      window._authScreenInstance.showProfileSelector();
    }
  }

  /**
   * Reset crypto display state for a profile switch.
   * Clears server-crypto mode so the new profile's crypto can be
   * set via updateProfile() before the first server broadcast arrives.
   */
  resetForProfileSwitch() {
    this._serverCryptoMode = false;
    this._cachedProfile.crypto = null;
    this._cachedProfile.level = null;
    this._cachedProfile.rank = null;
    this._cachedProfile.rankTotal = null;
  }

  /**
   * Show or hide the "Switch Profile" button based on auth state.
   * @param {boolean} show
   */
  showSwitchProfileButton(show) {
    const btn = document.getElementById("dashboard-switch-profile");
    if (btn) {
      btn.classList.toggle("hidden", !show);
    }
  }

  /**
   * Update the "Become Commander" button state
   */
  _updateBecomeCommanderButton(isCommander) {
    const btn = document.getElementById("btn-become-commander");
    if (!btn) return;

    if (isCommander) {
      btn.textContent = "★ Active";
      btn.classList.add("active");
      btn.disabled = true;
    } else {
      btn.textContent = "★ Activate";
      btn.classList.remove("active");
      btn.disabled = false;
    }
  }

  _togglePanel(headerElement) {
    const isExpanded = headerElement.dataset.expanded === "true";
    headerElement.dataset.expanded = (!isExpanded).toString();

    const panel = headerElement.closest(".dashboard-panel");
    const panelId = panel.dataset.panel;

    // Update state
    const state = this.panelStates.get(panelId) || {
      expanded: false,
      order: 0,
    };
    state.expanded = !isExpanded;
    this.panelStates.set(panelId, state);

    // Clear notification dot when panel is expanded
    if (state.expanded && this.notificationDots.has(panelId)) {
      this.notificationDots.delete(panelId);
      this._updateNotificationDot(panelId, false);
    }

    // Initialize loadout when expanded
    if (panelId === "loadout" && state.expanded) {
      this.initLoadout(this.playerLevel || 1);
    }

    // Update territory list and prices when expanded
    if (panelId === "territory" && state.expanded) {
      this._renderTerritoryList();
      this._updateTerritoryCardPrices();
    }

    // Reset camera pullback when territory panel is collapsed
    if (panelId === "territory" && !state.expanded) {
      this._cancelTerritoryPreview();
    }

    this._saveState();
  }

  /**
   * Open and scroll to the Faction panel when the rank label is clicked.
   */
  _openFactionPanel() {
    const panel = this.container.querySelector('[data-panel="faction"]');
    if (!panel) return;

    // Expand if collapsed
    const header = panel.querySelector(".panel-header");
    if (header && header.dataset.expanded !== "true") {
      this._togglePanel(header);
    }

    // Scroll panel into view
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ========================
  // VISIBILITY
  // ========================

  toggle() {
    this.isVisible = !this.isVisible;
    this.container.classList.toggle("collapsed", !this.isVisible);
    this._saveState();
  }

  show() {
    this.isVisible = true;
    this.container.classList.remove("collapsed");

    // Resume tank preview rendering
    if (this.tankPreviewRenderer && !this.tankPreviewAnimationId) {
      this._animateTankPreview();
    }

    this._saveState();
  }

  hide() {
    this.isVisible = false;
    this.container.classList.add("collapsed");

    // Stop tank preview rendering to save GPU resources
    if (this.tankPreviewAnimationId) {
      cancelAnimationFrame(this.tankPreviewAnimationId);
      this.tankPreviewAnimationId = null;
    }

    this._saveState();
  }

  // ========================
  // STATE PERSISTENCE
  // ========================

  _loadState() {
    try {
      const saved = localStorage.getItem("adlands_dashboard_state");
      if (saved) {
        const data = JSON.parse(saved);
        this.isVisible = data.visible !== false;
        if (data.panels) {
          Object.entries(data.panels).forEach(([id, state]) => {
            this.panelStates.set(id, state);
          });
        }
        // Load settings section states
        if (data.settingsSections) {
          this.settingsSectionStates = data.settingsSections;
        } else {
          this.settingsSectionStates = {};
        }
      }
    } catch (e) {
      console.warn("[Dashboard] Failed to load state:", e);
    }
  }

  _saveSectionState(sectionId, isCollapsed) {
    if (!this.settingsSectionStates) {
      this.settingsSectionStates = {};
    }
    this.settingsSectionStates[sectionId] = isCollapsed;
    this._saveState();
  }

  _applySectionStates() {
    if (!this.settingsSectionStates) return;

    Object.entries(this.settingsSectionStates).forEach(
      ([sectionId, isCollapsed]) => {
        const section = document.querySelector(
          `.settings-section[data-section="${sectionId}"]`,
        );
        if (section) {
          section.classList.toggle("collapsed", isCollapsed);
        }
      },
    );
  }

  _saveState() {
    try {
      const panels = {};
      this.panelStates.forEach((state, id) => {
        panels[id] = state;
      });

      const data = {
        visible: this.isVisible,
        panels: panels,
        settingsSections: this.settingsSectionStates || {},
      };
      localStorage.setItem("adlands_dashboard_state", JSON.stringify(data));
    } catch (e) {
      console.warn("[Dashboard] Failed to save state:", e);
    }
  }

  // ========================
  // DATA UPDATES
  // ========================

  /**
   * Update stats panel with crypto system data
   */
  updateStats(stats) {
    const els = {
      kills: document.getElementById("dashboard-kills"),
      deaths: document.getElementById("dashboard-deaths"),
      kd: document.getElementById("dashboard-kd"),
      damage: document.getElementById("dashboard-damage"),
      tics: document.getElementById("dashboard-tics"),
      hexes: document.getElementById("dashboard-hexes"),
      clusters: document.getElementById("dashboard-clusters"),
    };
    const c = this._cachedStats;

    if (els.kills && c.kills !== stats.kills) {
      c.kills = stats.kills;
      els.kills.textContent = stats.kills || 0;
    }
    if (els.deaths && c.deaths !== stats.deaths) {
      c.deaths = stats.deaths;
      els.deaths.textContent = stats.deaths || 0;
    }
    if (els.kd) {
      const kd =
        stats.deaths > 0
          ? (stats.kills / stats.deaths).toFixed(2)
          : stats.kills.toFixed(2);
      if (c.kd !== kd) {
        c.kd = kd;
        els.kd.textContent = kd;
      }
    }
    // Cache toLocaleString results (expensive locale-aware formatting)
    const damageVal = Math.floor(stats.damageDealt || 0);
    if (els.damage && c.damage !== damageVal) {
      c.damage = damageVal;
      this._formattedStrings.damage = damageVal.toLocaleString();
      els.damage.textContent = this._formattedStrings.damage;
    }
    const ticsVal = Math.floor(stats.ticsContributed || 0);
    if (els.tics && c.tics !== ticsVal) {
      c.tics = ticsVal;
      this._formattedStrings.tics = ticsVal.toLocaleString();
      els.tics.textContent = this._formattedStrings.tics;
    }
    if (els.hexes && c.hexes !== stats.hexesCaptured) {
      c.hexes = stats.hexesCaptured;
      els.hexes.textContent = stats.hexesCaptured || 0;
    }
    if (els.clusters && c.clusters !== stats.clustersCaptured) {
      c.clusters = stats.clustersCaptured;
      els.clusters.textContent = stats.clustersCaptured || 0;
    }
  }

  /**
   * Update profile panel
   */
  updateProfile(data) {
    const nameEl = document.getElementById("dashboard-player-name");
    const titleEl = document.getElementById("dashboard-player-title");
    const levelEl = document.getElementById("dashboard-level");
    const cryptoCurrentEl = document.getElementById("dashboard-crypto-current");

    if (nameEl && data.name) nameEl.textContent = data.name;
    if (titleEl && data.title) {
      // Don't overwrite commander/acting commander title
      const isCommander = window.commanderSystem?.isHumanCommander?.() || false;
      if (isCommander) {
        this._previousTitle = data.title;
      } else {
        titleEl.textContent = data.title;
      }
    }
    if (data.faction) {
      const factionChanged = this.playerFaction !== data.faction;
      this.playerFaction = data.faction;
      this._updateFactionDropdown(data.faction);
      if (factionChanged) {
        this._resetFactionPanel(data.faction);
      }
    }
    if (levelEl && data.level !== undefined && this._cachedProfile.level !== data.level) {
      this._cachedProfile.level = data.level;
      levelEl.textContent = data.level;
    }
    if (cryptoCurrentEl && data.crypto !== undefined && this._cachedProfile.crypto !== data.crypto && !this._serverCryptoMode) {
      const oldCrypto = this._cachedProfile.crypto;
      this._cachedProfile.crypto = data.crypto;
      this._formattedStrings.crypto = Number(data.crypto).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      if (oldCrypto === null) {
        this._initRoller(this._formattedStrings.crypto);
      } else {
        this._updateRoller(this._formattedStrings.crypto, oldCrypto, data.crypto);
      }
    }

    if (data.rank !== undefined) {
      const rankChanged = this._cachedProfile.rank !== data.rank;
      const totalChanged = data.rankTotal !== undefined && this._cachedProfile.rankTotal !== data.rankTotal;
      if (rankChanged || totalChanged) {
        this._cachedProfile.rank = data.rank;
        if (data.rankTotal !== undefined) this._cachedProfile.rankTotal = data.rankTotal;
        this.updatePanelTitle("faction", "Faction Leaderboard");
      }
    }
  }

  /**
   * Update the crypto balance display (server-authoritative).
   * Reuses the existing crypto roller element in the dashboard header.
   */
  updateCrypto(amount) {
    this._serverCryptoMode = true; // Server owns the roller from now on
    this._lastServerCrypto = amount; // Track for economy pre-checks

    // Handle negative balance display
    const cryptoEl = document.querySelector(".header-crypto-amount");
    if (cryptoEl) {
      if (amount < 0) {
        cryptoEl.classList.add("crypto-negative");
      } else {
        cryptoEl.classList.remove("crypto-negative");
      }
    }

    const absAmount = Math.abs(amount);
    const formatted = (amount < 0 ? "-" : "") + Number(absAmount).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const oldCrypto = this._cachedProfile.crypto;
    this._cachedProfile.crypto = amount;
    this._formattedStrings.crypto = formatted;
    if (oldCrypto === null) {
      this._initRoller(formatted);
    } else {
      this._updateRoller(formatted, oldCrypto, amount);
    }
  }

  /**
   * Optimistic increment for immediate feedback (e.g. tic-crypto +10, damage/kill crypto).
   * Server broadcast corrects to authoritative total every 5 seconds.
   */
  incrementCrypto(amount) {
    if (this._serverCryptoMode) {
      const newAmount = (this._cachedProfile.crypto || 0) + amount;
      this.updateCrypto(newAmount);
    } else if (this.cryptoSystem) {
      // Client-mode: show totalCrypto (consistent with server mode & ProfileCard)
      const stats = this.cryptoSystem.stats;
      const level = stats.level || 1;
      const totalCrypto = stats.totalCrypto || 0;
      const cryptoForNextLevel = this.cryptoSystem.getCryptoRequiredForLevel(level + 1);
      const levelProgress = this.cryptoSystem.getLevelProgress();
      this.updateProfile({
        level,
        crypto: totalCrypto,
        cryptoToNext: cryptoForNextLevel,
        cryptoPercent: levelProgress * 100,
      });
    }
  }

  /**
   * Set initial player info (name, faction, level, avatar color) and setup faction change handler
   */
  setPlayerInfo(name, faction, level, avatarColor, onFactionChange) {
    this.playerName = name;
    this.playerFaction = faction;
    this.playerLevel = level;
    this.avatarColor = avatarColor;
    this.onFactionChange = onFactionChange;

    // Update display
    const nameEl = document.getElementById("dashboard-player-name");
    const avatarInnerEl = document.getElementById("dashboard-avatar-inner");
    const levelEl = document.getElementById("dashboard-level");

    if (nameEl) nameEl.textContent = name;
    if (levelEl) levelEl.textContent = level;

    // Update avatar — supports both color strings and data URL images
    if (avatarInnerEl && avatarColor) {
      if (avatarColor.startsWith("data:")) {
        avatarInnerEl.style.background = "";
        avatarInnerEl.style.backgroundImage = `url(${avatarColor})`;
        avatarInnerEl.style.backgroundSize = "cover";
        avatarInnerEl.style.backgroundPosition = "center";
      } else {
        avatarInnerEl.style.backgroundImage = "";
        avatarInnerEl.style.background = avatarColor;
      }
    }

    // Update avatar border color based on faction
    this._updateAvatarFaction(faction);

    // Setup custom faction dropdown
    this._setupFactionDropdown(faction);
  }

  /**
   * Setup faction selection (now only in Developer section)
   */
  _setupFactionDropdown(initialFaction) {
    // Setup the developer section faction select
    this._setupDevFactionSelect(initialFaction);
  }

  /**
   * Update faction dropdown display (now only updates dev select)
   */
  _updateFactionDropdown(faction) {
    // Update the developer section faction select
    const devFactionSelect = document.getElementById("setting-dev-faction");
    if (devFactionSelect) {
      devFactionSelect.value = faction;
      this._updateDevFactionSelectColor(devFactionSelect, faction);
    }
  }

  /**
   * Update the dev faction select background color based on faction
   */
  _updateDevFactionSelectColor(select, faction) {
    const colors = {
      rust: { bg: "rgba(180, 80, 60, 0.6)", border: "#b4503c" },
      cobalt: { bg: "rgba(60, 100, 180, 0.6)", border: "#3c64b4" },
      viridian: { bg: "rgba(60, 140, 80, 0.6)", border: "#3c8c50" },
    };
    const color = colors[faction] || colors.rust;
    select.style.backgroundColor = color.bg;
    select.style.borderColor = color.border;
  }

  /**
   * Setup the developer faction select (in Developer settings section)
   */
  _setupDevFactionSelect(initialFaction) {
    const select = document.getElementById("setting-dev-faction");
    if (!select) return;

    // Set initial value and color
    select.value = initialFaction;
    this._updateDevFactionSelectColor(select, initialFaction);

    // Handle change
    select.addEventListener("change", () => {
      const newFaction = select.value;
      this.playerFaction = newFaction;

      // Update select color
      this._updateDevFactionSelectColor(select, newFaction);

      // Update avatar border color
      this._updateAvatarFaction(newFaction);

      // Update tank preview with new faction colors
      this._updateTankPreview();

      // Reset faction panel to reflect new faction
      this._resetFactionPanel(newFaction);

      // Trigger callback (this updates the game state)
      if (this.onFactionChange) {
        this.onFactionChange(newFaction);
      }
    });
  }

  /**
   * Update the player level in the dashboard (called when level changes)
   */
  setPlayerLevel(level) {
    this.playerLevel = level;
    const levelEl = document.getElementById("dashboard-level");
    if (levelEl) levelEl.textContent = level;
  }

  /**
   * Update avatar border color based on faction
   */
  _updateAvatarFaction(faction) {
    const avatarEl = document.getElementById("dashboard-avatar");
    if (!avatarEl) return;

    // Remove existing faction classes
    avatarEl.classList.remove("rust", "cobalt", "viridian");
    // Add current faction class
    avatarEl.classList.add(faction);
  }

  /**
   * Update a panel's header title dynamically.
   */
  updatePanelTitle(panelId, newTitle) {
    const panel = this.panelElements.get(panelId);
    if (!panel) return;
    const titleEl = panel.querySelector(".panel-title");
    if (titleEl) titleEl.textContent = newTitle;
  }

  /**
   * Update badge count on a panel
   */
  updateBadge(panelId, count) {
    this.badgeCounts.set(panelId, count);

    const panel = this.panelElements.get(panelId);
    if (panel) {
      const badge = panel.querySelector(".panel-badge");
      if (badge) {
        badge.textContent = count;
        badge.classList.toggle("hidden", count <= 0);
      }
    }
  }

  /**
   * Add a notification dot to the target panel header.
   * @param {string} text - Notification text (currently unused, reserved for future toast)
   * @param {string} type - Notification type (unused, kept for API compat)
   * @param {string|null} panelId - Panel to show the dot on
   */
  addNotification(text, type = "info", panelId = null) {
    if (!panelId) return;
    this.notificationDots.add(panelId);
    this._updateNotificationDot(panelId, true);
  }

  /**
   * Show or hide a cyan notification dot on a panel header.
   */
  _updateNotificationDot(panelId, show) {
    const panel = this.panelElements.get(panelId);
    if (!panel) return;
    const header = panel.querySelector(".panel-header");
    if (!header) return;
    let dot = header.querySelector(".panel-notification-dot");
    if (show && !dot) {
      dot = document.createElement("span");
      dot.className = "panel-notification-dot";
      const chevron = header.querySelector(".panel-chevron");
      if (chevron) chevron.appendChild(dot);
    } else if (!show && dot) {
      dot.remove();
    }
  }

  // ========================
  // GUEST NUDGE
  // ========================

  /**
   * Show a dismissible toast nudging guest users to sign in.
   * Each reason fires at most once per session, capped at 3 total.
   * @param {string} reason - Dedup key (e.g. "levelup", "badge", "shop")
   * @param {string} message - Display text
   */
  showGuestNudge(reason, message) {
    if (!window.authManager?.isGuest) return;
    if (this._shownNudges.has(reason)) return;
    if (this._nudgeCount >= 3) return;

    // Remove any existing nudge toast
    const existing = document.querySelector(".guest-nudge-toast");
    if (existing) existing.remove();

    this._shownNudges.add(reason);
    this._nudgeCount++;

    const toast = document.createElement("div");
    toast.className = "guest-nudge-toast";
    toast.innerHTML = `
      <span class="guest-nudge-text">${message}</span>
      <button class="guest-nudge-signin">Sign In</button>
      <button class="guest-nudge-dismiss">\u2715</button>
    `;

    document.body.appendChild(toast);

    const dismiss = () => {
      toast.classList.add("fade-out");
      setTimeout(() => toast.remove(), 500);
    };

    toast.querySelector(".guest-nudge-signin").addEventListener("click", () => {
      toast.remove();
      if (window._authScreenInstance) {
        window._authScreenInstance.show(true);
      }
    });

    toast.querySelector(".guest-nudge-dismiss").addEventListener("click", dismiss);

    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      if (toast.parentNode) dismiss();
    }, 8000);
  }

  // ========================
  // COSMETICS MODAL
  // ========================

  _openCosmeticsModal() {
    let overlay = document.getElementById("cosmetics-modal-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "cosmetics-modal-overlay";
      overlay.className = "modal-overlay";
      overlay.innerHTML = `
        <div class="modal-container cosmetics-modal">
          <div class="modal-header">
            <span class="modal-title">Cosmetics Store</span>
            <button class="modal-close" id="btn-close-cosmetics">&times;</button>
          </div>
          <div class="modal-body" id="cosmetics-modal-body"></div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector("#btn-close-cosmetics").addEventListener("click", () => this._closeCosmeticsModal());
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this._closeCosmeticsModal();
      });
    }
    const body = document.getElementById("cosmetics-modal-body");
    if (body && window.cosmeticsShop) {
      body.innerHTML = window.cosmeticsShop.buildContent();
      window.cosmeticsShop.onPanelOpen();
    }
    overlay.classList.add("visible");
  }

  _closeCosmeticsModal() {
    const overlay = document.getElementById("cosmetics-modal-overlay");
    if (overlay) overlay.classList.remove("visible");
  }

  // ========================
  // SYSTEM CONNECTIONS
  // ========================

  /**
   * Set crypto system reference and start stats updates
   */
  setCryptoSystem(cryptoSystem) {
    this.cryptoSystem = cryptoSystem;

    // Update stats periodically (staggered 333ms from capture tick to avoid frame spike)
    setTimeout(() => setInterval(() => {
      if (!this.isVisible) return; // Skip updates when hidden
      if (this.cryptoSystem && this.cryptoSystem.stats) {
        const stats = this.cryptoSystem.stats;

        this.updateStats({
          kills: stats.kills || 0,
          deaths: stats.deaths || 0,
          damageDealt: stats.damageDealt || 0,
          ticsContributed: stats.ticsContributed || 0,
          hexesCaptured: stats.hexesCaptured || 0,
          clustersCaptured: stats.clustersCaptured || 0,
        });

        // Calculate crypto progress for profile
        const level = stats.level || 1;
        const totalCrypto = stats.totalCrypto || 0;

        const cryptoForNextLevel = this.cryptoSystem.getCryptoRequiredForLevel
          ? this.cryptoSystem.getCryptoRequiredForLevel(level + 1)
          : 10000;
        const levelProgress = this.cryptoSystem.getLevelProgress
          ? this.cryptoSystem.getLevelProgress()
          : 0;

        // Use server-authoritative faction rank
        const factionRank = window.playerRank || null;

        // Update profile crypto (show totalCrypto — consistent with ProfileCard & server mode)
        this.updateProfile({
          level: level,
          crypto: totalCrypto,
          cryptoToNext: cryptoForNextLevel,
          cryptoPercent: levelProgress * 100,
          rank: factionRank,
        });
      }
    }, 1000), 333);
  }

  /**
   * Build a single roller column for the given character.
   * Digit chars get a drum with 0-9 repeated 3× (30 spans) so the drum
   * can always roll in the correct direction without wrapping artefacts.
   * Home position for digit d is index d+10 (middle set).
   * @returns {{element: HTMLSpanElement, type: string, char: string, drumEl: HTMLSpanElement|null, homeIndex: number}}
   */
  _buildRollerColumn(char) {
    const col = document.createElement("span");
    col.className = "crypto-roller-col";
    col.setAttribute("data-char", char);

    const isDigit = char >= "0" && char <= "9";
    if (isDigit) {
      const drum = document.createElement("span");
      drum.className = "crypto-roller-drum";
      for (let rep = 0; rep < 3; rep++) {
        for (let d = 0; d < 10; d++) {
          const digitSpan = document.createElement("span");
          digitSpan.className = "crypto-roller-digit";
          digitSpan.textContent = String(d);
          drum.appendChild(digitSpan);
        }
      }
      const digitIndex = parseInt(char, 10);
      const homeIndex = digitIndex + 10; // middle set
      drum.style.transform = `translateY(${-homeIndex * 16}px)`;
      col.appendChild(drum);
      return { element: col, type: "digit", char, drumEl: drum, homeIndex };
    } else {
      col.classList.add("crypto-roller-static");
      col.textContent = char;
      return { element: col, type: "static", char, drumEl: null, homeIndex: 0 };
    }
  }

  /**
   * Initialize the roller structure from scratch (no animation).
   * Called on first render when _cachedProfile.crypto transitions from null.
   */
  _initRoller(formattedString) {
    const container = document.getElementById("dashboard-crypto-current");
    if (!container) return;

    this._rollerContainer = container;
    container.textContent = "";
    container.classList.add("crypto-roller");

    this._rollerColumns = [];
    for (let i = 0; i < formattedString.length; i++) {
      const colData = this._buildRollerColumn(formattedString[i]);
      this._rollerColumns.push(colData);
      container.appendChild(colData.element);
    }
    this._rollerPreviousString = formattedString;
  }

  /**
   * Animate the roller from old value to new value.
   * Diffs right-aligned, handles length changes, scales duration by delta.
   */
  _updateRoller(newString, oldCrypto, newCrypto) {
    if (!this._rollerContainer) {
      this._initRoller(newString);
      return;
    }

    const oldString = this._rollerPreviousString;
    if (oldString === newString) return;

    const delta = Math.abs(newCrypto - oldCrypto);
    const baseDuration = 300 + Math.min(500, Math.log10(delta + 1) * 167);

    // Handle column count changes (right-aligned diff)
    const addCount = Math.max(0, newString.length - this._rollerColumns.length);
    const removeCount = Math.max(0, this._rollerColumns.length - newString.length);

    // Remove excess leftmost columns
    for (let i = 0; i < removeCount; i++) {
      const col = this._rollerColumns.shift();
      col.element.classList.add("crypto-col-exit");
      col.element.addEventListener("animationend", () => col.element.remove(), { once: true });
    }

    // Add new leftmost columns
    if (addCount > 0) {
      const fragment = document.createDocumentFragment();
      const newCols = [];
      for (let i = 0; i < addCount; i++) {
        const colData = this._buildRollerColumn(newString[i]);
        colData.element.classList.add("crypto-col-enter");
        newCols.push(colData);
        fragment.appendChild(colData.element);
      }
      this._rollerContainer.insertBefore(fragment, this._rollerContainer.firstChild);
      this._rollerColumns = newCols.concat(this._rollerColumns);
    }

    // Determine roll direction: value up → drum moves up, value down → drum moves down
    const goingUp = newCrypto > oldCrypto;

    // Animate each column to its new character
    for (let i = 0; i < newString.length; i++) {
      const newChar = newString[i];
      const colData = this._rollerColumns[i];

      if (colData.char === newChar) continue;

      const newIsDigit = newChar >= "0" && newChar <= "9";

      if (newIsDigit && colData.type === "digit") {
        const oldDigit = parseInt(colData.char, 10);
        const newDigit = parseInt(newChar, 10);
        const newHome = newDigit + 10; // home position in middle set

        // Pick a target index that guarantees correct roll direction.
        // Drum has 3 sets of 0-9 (indices 0-29), home is in middle set (10-19).
        // goingUp → drum moves up (more negative translateY) → target index > current
        // goingDown → drum moves down (less negative translateY) → target index < current
        let targetIndex;
        if (goingUp) {
          // Need target > oldHome. Use next set (d+20) if same-set would go wrong way.
          targetIndex = newDigit > oldDigit ? newHome : newDigit + 20;
        } else {
          // Need target < oldHome. Use first set (d+0) if same-set would go wrong way.
          targetIndex = newDigit < oldDigit ? newHome : newDigit;
        }

        const stagger = (newString.length - 1 - i) * 20;
        const duration = baseDuration + stagger;
        colData.drumEl.style.transitionDuration = `${duration}ms`;
        colData.drumEl.style.transitionTimingFunction = "ease-out";
        colData.drumEl.style.transform = `translateY(${-targetIndex * 16}px)`;
        colData.char = newChar;
        colData.homeIndex = newHome;

        // After animation, snap back to home position (middle set) without transition
        const drum = colData.drumEl;
        const snapHome = () => {
          drum.removeEventListener("transitionend", snapHome);
          drum.style.transitionDuration = "0ms";
          drum.style.transform = `translateY(${-newHome * 16}px)`;
        };
        drum.addEventListener("transitionend", snapHome, { once: true });
      } else {
        // Type changed — replace column entirely
        const newColData = this._buildRollerColumn(newChar);
        colData.element.replaceWith(newColData.element);
        this._rollerColumns[i] = newColData;
      }
    }

    this._rollerPreviousString = newString;
  }

  /**
   * Flash the crypto bar when crypto is gained
   * Intensity (flash brightness & shake) scales with crypto amount
   * Shake only activates for 100+ crypto gains
   * @param {number} amount - Crypto amount gained
   */
  flashCryptoBar(amount) {
    const cryptoAmount = document.querySelector(".header-crypto-amount");
    if (!cryptoAmount) return;

    // Brief brightness flash scaled by amount
    const intensity = Math.min(Math.log10(amount + 1) / 3, 1);
    const duration = 200 + 800 * intensity;

    cryptoAmount.classList.remove("crypto-flash");
    void cryptoAmount.offsetWidth;
    cryptoAmount.style.setProperty("--flash-duration", `${duration}ms`);
    cryptoAmount.classList.add("crypto-flash");

    setTimeout(() => {
      cryptoAmount.classList.remove("crypto-flash");
    }, duration);
  }

  /**
   * Set settings manager reference and bind UI
   */
  setSettingsManager(settingsManager) {
    this.settingsManager = settingsManager;

    // Bind settings UI after a short delay to ensure DOM is ready
    setTimeout(() => {
      if (this.settingsManager) {
        this.settingsManager.bindToUI();
      }
    }, 100);
  }

  /**
   * Set badge system reference
   */
  setBadgeSystem(badgeSystem) {
    this.badgeSystem = badgeSystem;

    // Listen for badge unlocks
    if (badgeSystem) {
      badgeSystem.onBadgeUnlock = (badge) => {
        this.addNotification(
          `Badge Unlocked: ${badge.icon} ${badge.name}`,
          "achievement",
          "stats",
        );
        // Update badge display when new badge unlocked
        this.updateBadgesDisplay();
        // Nudge guest users to sign in
        if (window.authManager?.isGuest) {
          this.showGuestNudge("badge", "Badge unlocked! Sign in to save it");
        }
      };
      // Initial badge display update
      this.updateBadgesDisplay();
    }
  }

  /**
   * Update the badges display in the dashboard header
   */
  updateBadgesDisplay() {
    if (!this.badgeSystem) return;

    const countEl = document.getElementById("dashboard-badge-count");
    const gridEl = document.getElementById("dashboard-badges-grid");

    if (!gridEl) return;

    const unlockedBadges = this.badgeSystem.getUnlockedBadges();
    const maxDisplay = 8;

    // Update count
    if (countEl) {
      countEl.textContent = unlockedBadges.length;
    }

    // Build badge icons
    gridEl.innerHTML = "";

    if (unlockedBadges.length === 0) {
      gridEl.innerHTML = '<span class="no-badges">None yet</span>';
      return;
    }

    for (let i = 0; i < Math.min(unlockedBadges.length, maxDisplay); i++) {
      const badge = unlockedBadges[i];
      const color = this.badgeSystem.getRarityColor(badge.rarity);

      const badgeEl = document.createElement("div");
      badgeEl.className = "header-badge";
      badgeEl.dataset.badgeId = badge.id;
      badgeEl.style.color = color;
      badgeEl.textContent = badge.icon;

      // Attach floating tooltip events
      this.badgeSystem.attachTooltipEvents(badgeEl, badge);

      gridEl.appendChild(badgeEl);
    }

    // Show "+X more" if there are more badges
    if (unlockedBadges.length > maxDisplay) {
      const moreEl = document.createElement("div");
      moreEl.className = "header-badge-more";
      moreEl.textContent = `+${unlockedBadges.length - maxDisplay}`;
      gridEl.appendChild(moreEl);
    }
  }

  /**
   * Set title system reference and start title updates
   */
  setTitleSystem(titleSystem) {
    this.titleSystem = titleSystem;

    // Self-correcting title updater: every 5 seconds, verify the dashboard
    // title matches the actual commander state. Catches any desync from missed
    // events or race conditions.
    setInterval(() => {
      const titleEl = document.getElementById("dashboard-player-title");
      if (!titleEl) return;

      const isCommander = window.commanderSystem?.isHumanCommander?.() || false;
      const isActing = window.commanderSystem?.isHumanActingCommander?.() || false;
      const expectedTitle = isActing ? "Acting Commander" : "Commander";
      const showingCommander = titleEl.textContent === "Commander" || titleEl.textContent === "Acting Commander";
      if (isCommander) {
        // Should be showing commander title — correct if not or wrong variant
        if (!showingCommander || titleEl.textContent !== expectedTitle) {
          if (!this._previousTitle) this._previousTitle = titleEl.textContent;
          titleEl.textContent = expectedTitle;
          titleEl.classList.add("commander-title");
          this._updateBecomeCommanderButton(true);
        }
      } else {
        // Should NOT be showing "Commander" — correct if stuck
        if (showingCommander) {
          const restored = this._previousTitle
            || (this.titleSystem && this.titleSystem.getTitle())
            || "Contractor";
          titleEl.textContent = restored;
          this._previousTitle = null;
          titleEl.classList.remove("commander-title");
          this._updateBecomeCommanderButton(false);
        } else if (this.titleSystem) {
          // Normal title refresh
          titleEl.textContent = this.titleSystem.getTitle();
        }
      }
    }, 5000);
  }

  /**
   * Set screenshot system reference and bind share panel
   */
  setScreenshotSystem(screenshotSystem) {
    this.screenshotSystem = screenshotSystem;

    if (screenshotSystem) {
      // Bind to share panel
      screenshotSystem.bindToDashboard();

      // Listen for screenshots
      screenshotSystem.onScreenshotTaken = (screenshot) => {
        // Enable share buttons
        const shareButtons = document.querySelectorAll(".social-share-btn");
        shareButtons.forEach((btn) => {
          btn.disabled = false;
        });
      };
    }
  }

  // ========================
  // TERRITORY SYSTEM
  // ========================

  /**
   * Set planet, tank, and camera references for territory claiming
   */
  setTerritoryRefs(planet, tank, gameCamera) {
    this._territoryPlanet = planet;
    this._territoryTank = tank;
    this._territoryCamera = gameCamera;

    // Restore saved territories
    this._loadPlayerTerritories();

    // Listen for admin deletions via BroadcastChannel
    if (typeof BroadcastChannel !== "undefined") {
      this._sponsorSyncChannel = new BroadcastChannel("adlands_sponsor_sync");
      this._sponsorSyncChannel.onmessage = (e) => {
        if (e.data.action === "delete" && e.data.sponsor?.isPlayerTerritory) {
          const territoryId = e.data.sponsor._territoryId || e.data.id;
          this._onAdminDeleteTerritory(territoryId, e.data.id);
        }
      };
    }
  }

  _onAdminDeleteTerritory(territoryId, sponsorStorageId) {
    // Find matching territory by original ID, SponsorStorage ID, or direct ID match
    const idx = this._playerTerritories.findIndex(
      (t) => t.id === territoryId ||
             t.id === sponsorStorageId ||
             t._sponsorStorageId === sponsorStorageId,
    );
    if (idx === -1) return;

    const territory = this._playerTerritories[idx];

    // Remove cluster from planet
    if (this._territoryPlanet) {
      this._territoryPlanet.removeSponsorCluster(territory.id);
    }

    // Remove from local array
    this._playerTerritories.splice(idx, 1);
    this._savePlayerTerritories();
    this._renderTerritoryList();

    // Remove from Firestore so it doesn't reappear on reload
    if (window.firestoreSync?.isActive && window.authManager?.uid) {
      firebase.firestore().collection("territories").doc(territory.id).delete().catch((e) =>
        console.warn("[Dashboard] Firestore territory cleanup failed:", e),
      );
    }

    const tierLabels = { outpost: "Outpost", compound: "Compound", stronghold: "Stronghold" };
    this.addNotification(
      `Territory removed by admin: ${tierLabels[territory.tierName] || "Territory"}`,
      "info",
      "territory",
    );
  }

  /**
   * Reconcile local player territories with server-authoritative sponsor data.
   * Called on every sponsors-reloaded so admin changes always override player state.
   */
  _reconcilePlayerTerritories(serverSponsors) {
    const uid = window.authManager?.uid;
    if (!uid || !this._playerTerritories || this._playerTerritories.length === 0) return;

    // Build lookup of this player's territories from server data
    const serverMap = new Map();
    for (const s of serverSponsors) {
      if (s.isPlayerTerritory && s.ownerUid === uid) {
        const territoryId = s._territoryId || s.id;
        serverMap.set(territoryId, s);
      }
    }

    let changed = false;

    // Update local entries from server-authoritative data
    for (const local of this._playerTerritories) {
      const server = serverMap.get(local.id);
      if (!server) continue;

      // Override local state with admin-authoritative values
      if (server.patternImage) local.patternImage = server.patternImage;
      if (server.patternAdjustment) local.patternAdjustment = server.patternAdjustment;
      if (server.imageStatus) local.imageStatus = server.imageStatus;
      if (server.cluster?.tileIndices) local.tileIndices = server.cluster.tileIndices;
      local._sponsorStorageId = server.id;
      changed = true;
    }

    // Remove territories no longer present on server (admin deleted them)
    // Only prune if the server payload actually includes player territory data
    // (avoids wiping on legacy payloads without territory metadata)
    const hasAnyPlayerTerritoryData = serverSponsors.some(s => s.isPlayerTerritory);
    const before = this._playerTerritories.length;
    this._playerTerritories = this._playerTerritories.filter((t) => {
      return serverMap.has(t.id) || !hasAnyPlayerTerritoryData;
    });
    if (this._playerTerritories.length < before) changed = true;

    if (changed) {
      this._savePlayerTerritories();
      this._renderTerritoryList();
    }
  }

  _selectTerritoryTier(tierName) {
    if (!this._territoryPlanet || !this._territoryTank) return;

    const ringMap = { outpost: 0, compound: 1, stronghold: 2 };
    const pullbackMap = { outpost: 0.15, compound: 0.5, stronghold: 1.0 };
    const ringCount = ringMap[tierName];
    if (ringCount === undefined) return;

    this._selectedTerritoryTier = tierName;

    // Highlight selected card
    const cards = this.container.querySelectorAll(".territory-tier-card");
    cards.forEach((c) =>
      c.classList.toggle("selected", c.dataset.tier === tierName),
    );

    // Get player's current tile from tank position
    const planet = this._territoryPlanet;
    const tankPos = this._territoryTank.getPosition();
    const centerTile = planet.getTileIndexAtPosition(tankPos);

    if (centerTile < 0) return;

    // Expand hex rings
    const rawTiles = planet.getHexRing(centerTile, ringCount);

    // Filter out sponsor tiles, portal tiles, and player's own existing territories
    const ownedTiles = new Set();
    for (const t of this._playerTerritories) {
      for (const idx of t.tileIndices) ownedTiles.add(idx);
    }

    let filtered = rawTiles.filter((idx) => {
      if (planet.sponsorTileIndices.has(idx)) return false;
      if (planet.portalTileIndices.has(idx)) return false;
      if (ownedTiles.has(idx)) return false;
      return true;
    });

    // Also filter RESTRICTED tier tiles
    const tierMap = planet.getTierMap();
    if (tierMap) {
      filtered = filtered.filter((idx) => tierMap.get(idx) !== "RESTRICTED");
    }

    // Calculate pricing
    let pricing = null;
    if (tierMap && typeof HexTierSystem !== "undefined") {
      pricing = HexTierSystem.calculatePricing(filtered, tierMap);
    }

    this._territoryPreview = {
      centerTile,
      rawCount: rawTiles.length,
      tileIndices: filtered,
      pricing,
    };

    // Highlight selected tiles on the planet
    planet.clearHighlightedTiles();
    planet.highlightTiles(filtered, 0x00cccc);

    // Trigger camera pullback
    if (this._territoryCamera) {
      this._territoryCamera.setTerritoryPreviewPullback(pullbackMap[tierName]);
    }

    // Update all card prices (player may have moved)
    this._updateTerritoryCardPrices();

    // Update preview UI
    this._renderTerritoryPreview();
  }

  _updateTerritoryCardPrices() {
    if (!this._territoryPlanet || !this._territoryTank) return;

    const planet = this._territoryPlanet;
    const tierMap = planet.getTierMap();
    if (!tierMap || typeof HexTierSystem === "undefined") return;

    const tankPos = this._territoryTank.getPosition();
    const centerTile = planet.getTileIndexAtPosition(tankPos);
    if (centerTile < 0) return;

    // Build set of already-owned tiles
    const ownedTiles = new Set();
    for (const t of this._playerTerritories) {
      for (const idx of t.tileIndices) ownedTiles.add(idx);
    }

    const tiers = [
      { name: "outpost", rings: 0 },
      { name: "compound", rings: 1 },
      { name: "stronghold", rings: 2 },
    ];

    for (const tier of tiers) {
      const rawTiles = planet.getHexRing(centerTile, tier.rings);

      // Filter same as _selectTerritoryTier
      let filtered = rawTiles.filter((idx) => {
        if (planet.sponsorTileIndices.has(idx)) return false;
        if (planet.portalTileIndices.has(idx)) return false;
        if (ownedTiles.has(idx)) return false;
        return true;
      });
      filtered = filtered.filter((idx) => tierMap.get(idx) !== "RESTRICTED");

      const pricing = HexTierSystem.calculatePricing(filtered, tierMap);

      // Update hex count
      const hexesEl = document.getElementById(`territory-hexes-${tier.name}`);
      if (hexesEl) {
        hexesEl.textContent = `${filtered.length} hex${filtered.length !== 1 ? "es" : ""}`;
      }

      // Update price
      const priceEl = document.getElementById(`territory-price-${tier.name}`);
      if (priceEl) {
        if (filtered.length === 0) {
          priceEl.textContent = "N/A";
        } else {
          priceEl.textContent = `$${pricing.total.toFixed(2)}/mo`;
        }
      }
    }
  }

  _renderTerritoryPreview() {
    const preview = this._territoryPreview;
    if (!preview) return;

    const previewEl = document.getElementById("territory-preview");
    const hexCountEl = document.getElementById("territory-hex-count");
    const overlapEl = document.getElementById("territory-overlap-warning");
    const pricingEl = document.getElementById("territory-pricing");

    if (!previewEl) return;
    previewEl.classList.remove("hidden");

    // Hex count
    if (hexCountEl) {
      if (preview.tileIndices.length === 0) {
        hexCountEl.textContent = "No available hexes at this location";
      } else {
        hexCountEl.textContent = `${preview.tileIndices.length} hex${preview.tileIndices.length !== 1 ? "es" : ""}`;
      }
    }

    // Show overlap warning if tiles were lost
    if (overlapEl) {
      const lost = preview.rawCount - preview.tileIndices.length;
      if (lost > 0) {
        overlapEl.textContent = `${lost} hex${lost > 1 ? "es" : ""} excluded (sponsor/portal overlap)`;
        overlapEl.classList.remove("hidden");
      } else {
        overlapEl.classList.add("hidden");
      }
    }

    // Pricing breakdown
    if (pricingEl && preview.pricing) {
      const p = preview.pricing;
      let html = '<div class="pricing-breakdown">';

      for (const tierId of HexTierSystem.TIER_ORDER) {
        const count = p.byTier[tierId];
        if (!count) continue;
        const tier = HexTierSystem.TIERS[tierId];
        html += `<div class="pricing-row">
          <span style="color:${tier.textColor}">${tier.icon} ${tier.name}</span>
          <span>${count} x $${tier.price} = $${(count * tier.price).toFixed(2)}</span>
        </div>`;
      }

      if (p.discount > 0) {
        html += `<div class="pricing-row pricing-discount">
          <span>${p.label || "Cluster Discount"}</span>
          <span>-${p.discount.toFixed(1)}% (-$${p.discountAmount.toFixed(2)})</span>
        </div>`;
      }

      html += `<div class="pricing-row pricing-total">
        <span>Monthly Total</span>
        <span>$${p.total.toFixed(2)}/mo</span>
      </div>`;
      html += "</div>";

      pricingEl.innerHTML = html;
    }

    // Disable claim button if no tiles available
    const claimBtn = document.getElementById("btn-territory-claim");
    if (claimBtn) {
      claimBtn.disabled = preview.tileIndices.length === 0;
    }
  }

  async _claimTerritory() {
    // Prompt guest users to create an account before claiming
    if (window.authManager?.isGuest) {
      if (window._authScreenInstance) {
        window._authScreenInstance.show(true, true);
      }
      return;
    }

    const preview = this._territoryPreview;
    if (!preview || preview.tileIndices.length === 0) return;
    if (!this._territoryPlanet) return;

    const planet = this._territoryPlanet;
    const playerName = this.playerName || "Player";

    // Generate unique territory ID
    const territoryId = `territory_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

    // Generate placeholder texture (canvas with player name)
    const patternImage = this._generateTerritoryTexture(playerName);

    // Create virtual sponsor object (matches applySponsorCluster interface)
    const virtualSponsor = {
      id: territoryId,
      name: playerName,
      cluster: {
        tileIndices: preview.tileIndices,
      },
      patternImage: patternImage,
      patternAdjustment: {
        scale: 1.0,
        offsetX: 0,
        offsetY: 0,
        saturation: 0.7,
        inputBlack: 30,
        inputGamma: 1.0,
        inputWhite: 225,
        outputBlack: 40,
        outputWhite: 215,
      },
    };

    // Clear highlight before applying textures
    planet.clearHighlightedTiles();

    // Apply through sponsor pipeline
    planet.applySponsorCluster(virtualSponsor);
    planet.deElevateSponsorTiles();

    // Track territory
    const tierName = this._selectedTerritoryTier;
    const territoryRecord = {
      id: territoryId,
      tierName: tierName,
      tileIndices: preview.tileIndices,
      timestamp: Date.now(),
      patternImage: patternImage,
      patternAdjustment: virtualSponsor.patternAdjustment,
    };
    this._playerTerritories.push(territoryRecord);

    // Save to SponsorStorage (and localStorage fallback) + Firestore
    // Await ensures SponsorStore entry exists before user can upload images
    await this._savePlayerTerritory(territoryRecord);

    // Emit server event for multiplayer territory broadcast
    if (window._mp?.net?.socket) {
      window._mp.net.socket.emit("claim-territory", {
        territoryId: territoryId,
        tileIndices: preview.tileIndices,
        tierName: tierName,
        patternImage: patternImage,
        patternAdjustment: virtualSponsor.patternAdjustment,
        playerName: playerName,
      });
    }

    // Elon Tusk global chat announcement on territory rent
    const _tuskRentLines = [
      "@NAME is a land baron now. As for the rest of the lobby: your poverty disgusts me.",
      "BREAKING: @NAME signed a lease. Welcome to the property ladder. The rest of you? Still homeless.",
      "@NAME is officially a real estate mogul. Meanwhile, the rest of you are basically squatters.",
      "@NAME rented territory and honestly? The rest of you look poor by comparison. Just saying.",
      "@NAME is renting from ME. I want the rest of you to think about what that says about your life choices.",
      "REAL ESTATE UPDATE: @NAME just upgraded from 'homeless' to 'slumlord.' The rest of you remain unhoused.",
      "@NAME just rented territory. To everyone else camping on free land: gentrification is coming.",
      "@NAME just rented land. One of you finally understands economics. The rest of you are a rounding error.",
      "@NAME just made a power move. The rest of you should be taking notes.",
      "@NAME — a player of taste and strategy. Everyone else? Noted.",
      "Big landlord energy from @NAME right there. The lobby just got a little more unequal.",
      "@NAME's territory just increased in value by 300%. Source: me. I make the numbers up.",
    ];
    try {
      const _cw = window.proximityChat && window.proximityChat.chatWindow;
      if (_cw && _cw.addTuskMessage) {
        const msg = _tuskRentLines[Math.floor(Math.random() * _tuskRentLines.length)]
          .replace(/@NAME/g, "@" + playerName);
        _cw.addTuskMessage(msg);
      }
    } catch (e) {
      console.warn("[Territory] Tusk chat failed:", e);
    }

    // Reset preview state and camera
    this._territoryPreview = null;
    this._selectedTerritoryTier = null;

    if (this._territoryCamera) {
      this._territoryCamera.setTerritoryPreviewPullback(0);
    }

    // Update UI
    const previewEl = document.getElementById("territory-preview");
    if (previewEl) previewEl.classList.add("hidden");

    const cards = this.container.querySelectorAll(".territory-tier-card");
    cards.forEach((c) => c.classList.remove("selected"));

    this._renderTerritoryList();

    // Show notification
    const tierLabels = { outpost: "Outpost", compound: "Compound", stronghold: "Stronghold" };
    this.addNotification(
      `Territory claimed: ${tierLabels[tierName] || "Territory"} (${preview.tileIndices.length} hexes)`,
      "achievement",
      "territory",
    );
  }

  _cancelTerritoryPreview() {
    this._territoryPreview = null;
    this._selectedTerritoryTier = null;

    // Clear highlighted tiles on planet
    if (this._territoryPlanet) {
      this._territoryPlanet.clearHighlightedTiles();
    }

    if (this._territoryCamera) {
      this._territoryCamera.setTerritoryPreviewPullback(0);
    }

    const previewEl = document.getElementById("territory-preview");
    if (previewEl) previewEl.classList.add("hidden");

    const cards = this.container.querySelectorAll(".territory-tier-card");
    cards.forEach((c) => c.classList.remove("selected"));
  }

  _generateTerritoryTexture(playerName) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    // Grayscale placeholder (neutral, non-faction)
    const colors = { bg: "#2a2a2a", accent: "#555555", text: "#cccccc" };

    // Base fill
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, 512, 512);

    // Diagonal stripe pattern
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 8;
    ctx.globalAlpha = 0.3;
    for (let i = -512; i < 1024; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 512, 512);
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // Player name text (centered)
    ctx.fillStyle = colors.text;
    ctx.font = "bold 48px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const displayName =
      playerName.length > 12
        ? playerName.substring(0, 11) + "\u2026"
        : playerName;

    ctx.fillText(displayName, 256, 240);

    // Flag icon below name
    ctx.font = "64px serif";
    ctx.fillText("\u2691", 256, 320);

    return canvas.toDataURL("image/png");
  }

  _handleTerritoryUpload(inputEl, territoryId) {
    console.log(`[Dashboard] _handleTerritoryUpload called for territory ${territoryId}`);
    const file = inputEl.files[0];
    if (!file) { console.warn("[Dashboard] No file selected"); return; }
    console.log(`[Dashboard] File selected: ${file.name} (${(file.size / 1024).toFixed(1)}KB, ${file.type})`);

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      console.log(`[Dashboard] FileReader loaded, dataUrl length: ${dataUrl.length}`);

      const territory = this._playerTerritories.find((t) => t.id === territoryId);
      if (!territory) return;

      // Optimistic local update — player sees their image immediately
      territory.patternImage = dataUrl;
      territory.imageStatus = "pending";

      // Preserve existing adjustment or use muted defaults
      if (!territory.patternAdjustment) {
        territory.patternAdjustment = {
          scale: 1.0, offsetX: 0, offsetY: 0,
          saturation: 0.7, inputBlack: 30, inputGamma: 1.0,
          inputWhite: 225, outputBlack: 40, outputWhite: 215,
        };
      }

      // Re-apply texture locally (player sees their own image)
      if (this._territoryPlanet) {
        const sponsor = {
          id: territoryId,
          patternImage: dataUrl,
          patternAdjustment: territory.patternAdjustment,
        };
        this._territoryPlanet._applySponsorTexture(sponsor, territory.tileIndices);
      }

      // Submit to server for admin review via socket
      let socketAckReceived = false;
      if (window._mp?.net?.socket) {
        console.log("[Dashboard] Socket available, submitting image for review");
        // Listen for server acknowledgment
        const ackHandler = (ackData) => {
          if (ackData?.territoryId === territoryId) {
            socketAckReceived = true;
            window._mp.net.socket.off("territory-image-submitted", ackHandler);
            if (ackData.status === "error") {
              console.warn("[Dashboard] Image submit error from server:", ackData.message);
            } else {
              console.log("[Dashboard] Image submit acknowledged by server, status:", ackData.status);
              // Notify admin portal via BroadcastChannel
              if (typeof SponsorStorage !== "undefined") {
                const storageId = territory._sponsorStorageId ||
                  (SponsorStorage._cache && SponsorStorage.getAll().find(s => s._territoryId === territoryId)?.id);
                if (storageId) {
                  SponsorStorage._broadcast("update", { id: storageId });
                  console.log("[Dashboard] BroadcastChannel update sent for", storageId);
                }
              }
            }
          }
        };
        window._mp.net.socket.on("territory-image-submitted", ackHandler);

        console.log(`[Dashboard] Emitting submit-territory-image via socket (territoryId=${territoryId}, dataUrl=${dataUrl.length} chars)`);
        window._mp.net.socket.emit("submit-territory-image", {
          territoryId,
          pendingImage: dataUrl,
          patternAdjustment: territory.patternAdjustment,
        });

        // HTTP fallback: if no ack within 3s, update via REST API
        setTimeout(async () => {
          window._mp.net.socket.off("territory-image-submitted", ackHandler);
          if (!socketAckReceived) {
            console.warn("[Dashboard] Socket image submit timed out, trying HTTP fallback");
            // Resolve SponsorStore ID
            let storageId = territory._sponsorStorageId;
            if (!storageId && typeof SponsorStorage !== "undefined" && SponsorStorage._cache) {
              const match = SponsorStorage.getAll().find((s) => s._territoryId === territoryId);
              if (match) { storageId = match.id; territory._sponsorStorageId = match.id; }
            }
            if (storageId) {
              try {
                const res = await fetch(`/api/sponsors/${storageId}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    pendingImage: dataUrl,
                    imageStatus: "pending",
                    patternAdjustment: territory.patternAdjustment,
                  }),
                });
                if (res.ok) {
                  console.log("[Dashboard] HTTP fallback image submit succeeded");
                  if (typeof SponsorStorage !== "undefined") {
                    SponsorStorage._broadcast("update", { id: storageId });
                  }
                } else {
                  console.warn("[Dashboard] HTTP fallback failed:", res.status);
                }
              } catch (e) {
                console.warn("[Dashboard] HTTP fallback error:", e);
              }
            } else {
              console.warn("[Dashboard] No SponsorStore ID for HTTP fallback");
            }
          }
        }, 3000);
      } else {
        console.warn("[Dashboard] No socket available! Cannot submit image via socket. window._mp:", !!window._mp, "net:", !!window._mp?.net, "socket:", !!window._mp?.net?.socket);
      }

      // Patch SponsorStorage local cache directly (avoid PUT /api/sponsors which
      // triggers a full sponsors-reloaded broadcast that would wipe the texture)
      if (typeof SponsorStorage !== "undefined" && SponsorStorage._cache) {
        let storageId = territory._sponsorStorageId;
        if (!storageId) {
          const allSponsors = SponsorStorage.getAll();
          const match = allSponsors.find((s) => s._territoryId === territoryId);
          if (match) { storageId = match.id; territory._sponsorStorageId = match.id; }
        }
        if (storageId) {
          const idx = SponsorStorage._cache.sponsors.findIndex((s) => s.id === storageId);
          if (idx !== -1) {
            SponsorStorage._cache.sponsors[idx].pendingImage = dataUrl;
            SponsorStorage._cache.sponsors[idx].imageStatus = "pending";
            SponsorStorage._cache.sponsors[idx].patternAdjustment = territory.patternAdjustment;
            // Persist to IndexedDB if available (no API call)
            if (SponsorStorage._db) {
              try {
                const tx = SponsorStorage._db.transaction("sponsors", "readwrite");
                tx.objectStore("sponsors").put(SponsorStorage._cache.sponsors[idx]);
              } catch (e) { /* IndexedDB write is best-effort */ }
            }
          }
        }
      }

      // Update Firestore with pending status
      if (window.firestoreSync?.isActive && window.authManager?.uid) {
        firebase.firestore().collection("territories").doc(territoryId).update({
          pendingImage: dataUrl,
          imageStatus: "pending",
          patternAdjustment: territory.patternAdjustment,
        }).catch((e) => console.warn("[Dashboard] Firestore pending update failed:", e));
      }

      // Save to localStorage with pending status
      this._savePlayerTerritories();
      this._renderTerritoryList();

      this.addNotification(
        "Image submitted for review",
        "info",
        "territory",
      );
    };
    reader.readAsDataURL(file);
  }

  _cancelTerritorySubscription(territoryId) {
    const idx = this._playerTerritories.findIndex((t) => t.id === territoryId);
    if (idx === -1) return;

    const territory = this._playerTerritories[idx];

    // Remove cluster from planet (restores tiles to procedural clusters)
    if (this._territoryPlanet) {
      this._territoryPlanet.removeSponsorCluster(territoryId);
    }

    // Remove from local array
    this._playerTerritories.splice(idx, 1);

    // Remove from Firestore if authenticated
    if (window.firestoreSync?.isActive && window.authManager?.uid) {
      firebase.firestore().collection("territories").doc(territoryId).delete().catch((e) =>
        console.warn("[Dashboard] Firestore territory delete failed:", e),
      );
    }

    // Remove from SponsorStorage
    if (typeof SponsorStorage !== "undefined" && SponsorStorage._cache) {
      const storageId = territory._sponsorStorageId;
      if (storageId) {
        SponsorStorage.delete(storageId).catch((e) =>
          console.warn("[Dashboard] SponsorStorage delete failed:", e),
        );
      } else {
        // Fallback: find by _territoryId
        const allSponsors = SponsorStorage.getAll();
        const match = allSponsors.find((s) => s._territoryId === territoryId);
        if (match) {
          SponsorStorage.delete(match.id).catch((e) =>
            console.warn("[Dashboard] SponsorStorage delete failed:", e),
          );
        }
      }
    }

    // Update localStorage fallback
    this._savePlayerTerritories();

    // Update UI
    this._renderTerritoryList();

    const tierLabels = { outpost: "Outpost", compound: "Compound", stronghold: "Stronghold" };
    this.addNotification(
      `Subscription cancelled: ${tierLabels[territory.tierName] || "Territory"}`,
      "info",
      "territory",
    );
  }

  _renderTerritoryList() {
    const listEl = document.getElementById("territory-list");
    if (!listEl) return;

    if (this._playerTerritories.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No territories claimed</div>';
      return;
    }

    const tierLabels = { outpost: "Outpost", compound: "Compound", stronghold: "Stronghold" };

    listEl.innerHTML = this._playerTerritories
      .map((t) => {
        const label = tierLabels[t.tierName] || "Territory";
        const age = this._formatTimeAgo(t.timestamp);
        const adj = t.patternAdjustment || { scale: 1.0, offsetX: 0, offsetY: 0 };
        return `
          <div class="territory-owned-item" data-territory-id="${t.id}">
              <div class="territory-item-header">
                  <span class="territory-item-name">${label}</span>
                  <span class="territory-item-detail">${t.tileIndices.length} hex${t.tileIndices.length !== 1 ? "es" : ""} · ${age}</span>
                  ${t.imageStatus === "pending" ? '<span class="territory-status-badge pending">Pending Review</span>' : ""}
                  ${t.imageStatus === "rejected" ? '<span class="territory-status-badge rejected">Rejected — Upload New</span>' : ""}
                  ${t.imageStatus === "approved" ? '<span class="territory-status-badge approved">Approved</span>' : ""}
              </div>
              <div class="territory-controls" data-territory-id="${t.id}">
                  <div class="territory-control-row">
                      <label>Scale</label>
                      <input type="range" min="0.5" max="2.0" step="0.1" value="${adj.scale}" class="territory-scale-slider" data-territory-id="${t.id}">
                      <span class="territory-control-value">${adj.scale.toFixed(1)}</span>
                  </div>
                  <div class="territory-control-row">
                      <label>X</label>
                      <input type="range" min="-1" max="1" step="0.05" value="${adj.offsetX}" class="territory-offsetx-slider" data-territory-id="${t.id}">
                      <span class="territory-control-value">${adj.offsetX.toFixed(2)}</span>
                  </div>
                  <div class="territory-control-row">
                      <label>Y</label>
                      <input type="range" min="-1" max="1" step="0.05" value="${adj.offsetY}" class="territory-offsety-slider" data-territory-id="${t.id}">
                      <span class="territory-control-value">${adj.offsetY.toFixed(2)}</span>
                  </div>
              </div>
              <div class="territory-item-actions">
                  <button class="territory-item-upload" data-territory-id="${t.id}">Replace Image</button>
                  <button class="territory-item-cancel" data-territory-id="${t.id}">Cancel</button>
              </div>
          </div>
        `;
      })
      .join("");
  }

  _formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  _savePlayerTerritories() {
    // Save to localStorage as fallback
    try {
      localStorage.setItem(
        "adlands_player_territories",
        JSON.stringify(this._playerTerritories),
      );
    } catch (e) {
      console.warn("[Dashboard] Failed to save territories:", e);
    }
  }

  async _savePlayerTerritory(territory) {
    // Save to Firestore if authenticated (account-level)
    if (window.firestoreSync?.isActive && window.authManager?.uid) {
      try {
        const db = firebase.firestore();
        await db.collection("territories").doc(territory.id).set({
          ownerUid: window.authManager.uid,
          tileIndices: territory.tileIndices,
          tierName: territory.tierName,
          patternImage: territory.patternImage,
          patternAdjustment: territory.patternAdjustment,
          playerName: this.playerName || "Player",
          playerFaction: this.playerFaction,
          purchasedAt: firebase.firestore.FieldValue.serverTimestamp(),
          active: true,
        });
      } catch (e) {
        console.warn("[Dashboard] Firestore territory save failed:", e);
      }
    }

    // Save individual territory to SponsorStorage (appears in admin portal)
    // Ensure SponsorStorage init has completed before checking _cache
    if (window._sponsorStorageReady) {
      await window._sponsorStorageReady;
    }
    if (typeof SponsorStorage !== "undefined" && SponsorStorage._cache) {
      try {
        const sponsor = {
          _territoryId: territory.id,
          name: window.authManager?.email || this.playerName || "Player",
          cluster: { tileIndices: territory.tileIndices },
          patternImage: territory.patternImage,
          patternAdjustment: territory.patternAdjustment,
          isPlayerTerritory: true,
          playerFaction: this.playerFaction,
          tierName: territory.tierName,
          createdAt: new Date().toISOString(),
          imageStatus: "placeholder",
          ownerUid: window.authManager?.uid || null,
        };
        // Use player's profile picture as the logo in the admin portal
        if (this.avatarColor?.startsWith("data:")) {
          sponsor.logoImage = this.avatarColor;
        }
        const created = await SponsorStorage.create(sponsor);
        // Store the SponsorStorage-generated ID for future updates
        territory._sponsorStorageId = created.id;
      } catch (e) {
        console.warn("[Dashboard] SponsorStorage save failed:", e);
      }
    }
    // Always save to localStorage as fallback
    this._savePlayerTerritories();
  }

  async _updatePlayerTerritory(territoryId, changes) {
    // Update in Firestore if authenticated
    if (window.firestoreSync?.isActive && window.authManager?.uid) {
      try {
        const db = firebase.firestore();
        await db.collection("territories").doc(territoryId).update(changes);
      } catch (e) {
        console.warn("[Dashboard] Firestore territory update failed:", e);
      }
    }

    // Update in SponsorStorage using the stored SponsorStorage ID
    if (typeof SponsorStorage !== "undefined" && SponsorStorage._cache) {
      try {
        const territory = this._playerTerritories.find((t) => t.id === territoryId);
        const storageId = territory?._sponsorStorageId;
        if (storageId) {
          await SponsorStorage.update(storageId, changes);
        } else {
          // Fallback: find by _territoryId field
          const allSponsors = SponsorStorage.getAll();
          const match = allSponsors.find((s) => s._territoryId === territoryId);
          if (match) {
            await SponsorStorage.update(match.id, changes);
            if (territory) territory._sponsorStorageId = match.id;
          }
        }
      } catch (e) {
        console.warn("[Dashboard] SponsorStorage update failed:", e);
      }
    }
    this._savePlayerTerritories();
  }

  _loadPlayerTerritories() {
    // If authenticated, load from Firestore (async, then apply)
    if (window.firestoreSync?.isActive && window.authManager?.uid) {
      this._loadTerritoriesFromFirestore();
      return;
    }

    // Fallback: load from local storage
    this._loadTerritoriesFromLocal();
  }

  async _loadTerritoriesFromFirestore() {
    try {
      const db = firebase.firestore();
      const snap = await db.collection("territories")
        .where("ownerUid", "==", window.authManager.uid)
        .where("active", "==", true)
        .get();

      if (snap.empty) {
        // Still try local as fallback
        this._loadTerritoriesFromLocal();
        return;
      }

      const territories = [];
      snap.forEach((doc) => {
        territories.push({ id: doc.id, ...doc.data() });
      });

      this._applyLoadedTerritories(territories);
    } catch (e) {
      console.warn("[Dashboard] Firestore territory load failed:", e);
      this._loadTerritoriesFromLocal();
    }
  }

  _loadTerritoriesFromLocal() {
    let territories = [];
    let loadedFromStorage = false;

    // Try SponsorStorage first (admin-authoritative source)
    if (typeof SponsorStorage !== "undefined" && SponsorStorage._cache) {
      try {
        const allSponsors = SponsorStorage.getAll();
        territories = allSponsors.filter((s) => s.isPlayerTerritory);
        loadedFromStorage = true;
      } catch (e) {
        console.warn("[Dashboard] SponsorStorage load failed:", e);
      }
    }

    // Fall back to localStorage only if SponsorStorage was unavailable
    if (!loadedFromStorage) {
      try {
        const saved = localStorage.getItem("adlands_player_territories");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed)) territories = parsed;
        }
      } catch (e) {
        console.warn("[Dashboard] localStorage load failed:", e);
      }
    }

    if (territories.length > 0) {
      this._applyLoadedTerritories(territories);
    }
  }

  _applyLoadedTerritories(territories) {
    if (!this._territoryPlanet || territories.length === 0) return;

    for (const territory of territories) {
      // Normalize tile indices from sponsor format if needed
      const tileIndices = territory.tileIndices ||
        (territory.cluster && territory.cluster.tileIndices) || [];
      if (tileIndices.length === 0) continue;

      // Check that tiles are still available (not taken by sponsors since last session)
      const planet = this._territoryPlanet;
      const validTiles = tileIndices.filter(
        (idx) =>
          !planet.sponsorTileIndices.has(idx) &&
          !planet.portalTileIndices.has(idx),
      );

      if (validTiles.length === 0) continue;

      const adj = territory.patternAdjustment || {
        scale: 1.0, offsetX: 0, offsetY: 0,
        saturation: 0.7, inputBlack: 30, inputGamma: 1.0,
        inputWhite: 225, outputBlack: 40, outputWhite: 215,
      };

      // For pending images, show the pending image optimistically to the owning player
      const displayImage = (territory.imageStatus === "pending" && territory.pendingImage)
        ? territory.pendingImage
        : territory.patternImage;

      const record = {
        id: territory._territoryId || territory.id,
        _sponsorStorageId: territory._territoryId ? territory.id : undefined,
        tierName: territory.tierName || "outpost",
        tileIndices: validTiles,
        timestamp: territory.timestamp || Date.parse(territory.createdAt) || Date.now(),
        patternImage: displayImage,
        patternAdjustment: adj,
        imageStatus: territory.imageStatus || "placeholder",
      };

      const virtualSponsor = {
        id: record.id,
        name: this.playerName || "Player",
        cluster: { tileIndices: validTiles },
        patternImage: displayImage,
        patternAdjustment: adj,
      };

      planet.applySponsorCluster(virtualSponsor);
      this._playerTerritories.push(record);
    }

    if (this._playerTerritories.length > 0) {
      this._territoryPlanet.deElevateSponsorTiles();
      this._renderTerritoryList();
    }
  }

  /**
   * Update the player's dynamic title display
   */
  updateTitle(title) {
    const titleEl = document.getElementById("dashboard-player-title");
    if (!titleEl || !title) return;

    // Don't overwrite commander/acting commander title with behavioral title
    const isCommander = window.commanderSystem?.isHumanCommander?.() || false;
    if (isCommander) {
      // Store for restoration when commander status is lost
      this._previousTitle = title;
      return;
    }
    titleEl.textContent = title;
  }

  // ========================
  // LOADOUT SYSTEM
  // ========================

  /**
   * Initialize the loadout panel after it's expanded for the first time
   */
  initLoadout(playerLevel = 1) {
    if (this.loadoutInitialized) {
      this.updateLoadout(playerLevel);
      return;
    }

    this.loadoutInitialized = true;
    this._renderUpgrades(playerLevel);
    this._updateSlotStates(playerLevel);
    this._initLoadoutDropdowns();
    this._initTankPreview();
  }

  /**
   * Render 3-column layout: Offense | Defense | Tactical
   * Each column has: header and 2 dropdown slots stacked
   */
  _renderUpgrades(playerLevel) {
    const container = document.getElementById("loadout-columns");
    if (!container) return;

    const categories = [
      { key: "offense", label: "Offense", slots: ["offense-1", "offense-2"] },
      { key: "defense", label: "Defense", slots: ["defense-1", "defense-2"] },
      {
        key: "tactical",
        label: "Tactical",
        slots: ["tactical-1", "tactical-2"],
      },
    ];

    let html = "";
    for (const cat of categories) {
      const upgrades = UPGRADES[cat.key];

      html += `
                <div class="loadout-column" data-category="${cat.key}">
                    <div class="column-header">${cat.label}</div>
                    <div class="slot-stack">
            `;

      // Render 2 dropdown slots per column
      for (const slotId of cat.slots) {
        const isUnlocked = true; // DEBUG: all slots unlocked
        const equippedId = this.equippedUpgrades[slotId];

        // Build dropdown options
        let options = `<option value="">-- Empty --</option>`;
        for (const upgrade of upgrades) {
          const selected = equippedId === upgrade.id ? " selected" : "";
          // Disable if this upgrade is equipped in another slot of the same category
          const equippedElsewhere =
            !selected &&
            Object.entries(this.equippedUpgrades).some(
              ([slot, id]) => id === upgrade.id && slot !== slotId,
            );
          const disabled = equippedElsewhere ? " disabled" : "";
          options += `<option value="${upgrade.id}"${selected}${disabled}>${upgrade.name}</option>`;
        }

        html += `
                    <div class="loadout-slot unlocked"
                         data-slot="${slotId}"
                         data-type="${cat.key}">
                        <select class="loadout-select" data-slot="${slotId}">
                            ${options}
                        </select>
                    </div>
                `;
      }

      html += `
                    </div>
                </div>
            `;
    }

    container.innerHTML = html;
  }

  /**
   * Update slot visual states based on player level
   * Now just re-renders via _renderUpgrades since slots are inline
   */
  _updateSlotStates() {
    // Slots are now rendered within _renderUpgrades
    // This method is kept for API compatibility
  }

  /**
   * Find an upgrade by ID across all categories
   */
  _findUpgrade(upgradeId) {
    for (const category of ["offense", "defense", "tactical"]) {
      const found = UPGRADES[category].find((u) => u.id === upgradeId);
      if (found) return { ...found, category };
    }
    return null;
  }

  /**
   * Initialize dropdown change listeners for the loadout system
   */
  _initLoadoutDropdowns() {
    const columnsContainer = document.getElementById("loadout-columns");
    if (!columnsContainer) return;

    columnsContainer.addEventListener("change", (e) => {
      const select = e.target.closest(".loadout-select");
      if (!select) return;

      const slotId = select.dataset.slot;
      const upgradeId = select.value;

      if (upgradeId) {
        this._equipUpgrade(slotId, upgradeId);
      } else {
        this._unequipUpgrade(slotId);
      }
    });
  }

  /**
   * Unequip an upgrade from a slot
   */
  _unequipUpgrade(slotId) {
    const upgradeId = this.equippedUpgrades[slotId];
    if (!upgradeId) return;

    const upgrade = this._findUpgrade(upgradeId);
    delete this.equippedUpgrades[slotId];

    // Update visuals
    this._renderUpgrades(this.playerLevel || 1);
    this._updateTankPreview();
  }

  /**
   * Equip an upgrade to a slot
   */
  _equipUpgrade(slotId, upgradeId) {
    const upgrade = this._findUpgrade(upgradeId);
    if (!upgrade) return;

    // Remove from any other slot first
    for (const [slot, id] of Object.entries(this.equippedUpgrades)) {
      if (id === upgradeId) {
        delete this.equippedUpgrades[slot];
      }
    }

    // Equip to new slot
    this.equippedUpgrades[slotId] = upgradeId;

    // Update visuals
    this._updateSlotStates(this.playerLevel || 1);
    this._renderUpgrades(this.playerLevel || 1);
    this._updateTankPreview();
  }

  /**
   * Initialize real-time THREE.js tank preview with orbit controls
   */
  _initTankPreview() {
    const canvas = document.getElementById("tank-preview-canvas");
    if (!canvas) return;

    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();

    // Create THREE.js renderer
    this.tankPreviewRenderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: false,
      alpha: true,
    });
    this.tankPreviewRenderer.setSize(rect.width, rect.height);
    this.tankPreviewRenderer.setPixelRatio(
      Math.min(window.devicePixelRatio, 2),
    );
    this.tankPreviewRenderer.setClearColor(0x000000, 0);

    // Create scene
    this.tankPreviewScene = new THREE.Scene();

    // Create camera (closer to tank)
    const aspect = rect.width / rect.height;
    this.tankPreviewCamera = new THREE.PerspectiveCamera(35, aspect, 0.1, 100);
    this.tankPreviewCamera.position.set(6, 4, 6);
    this.tankPreviewCamera.lookAt(0, 0, 0);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.tankPreviewScene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    this.tankPreviewScene.add(directionalLight);

    // Create tank group
    this.tankPreviewGroup = new THREE.Group();
    this.tankPreviewScene.add(this.tankPreviewGroup);

    // Build initial tank
    this._buildPreviewTank();

    // Setup orbit controls (manual drag implementation)
    this._setupTankPreviewOrbit(canvas);

    // Start render loop
    this._animateTankPreview();

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      const newRect = container.getBoundingClientRect();
      if (newRect.width > 0 && newRect.height > 0) {
        this.tankPreviewRenderer.setSize(newRect.width, newRect.height);
        this.tankPreviewCamera.aspect = newRect.width / newRect.height;
        this.tankPreviewCamera.updateProjectionMatrix();
      }
    });
    resizeObserver.observe(container);
  }

  /**
   * Setup manual orbit controls for tank preview (click and drag to rotate)
   */
  _setupTankPreviewOrbit(canvas) {
    this.tankOrbit = {
      isDragging: false,
      hasBeenDragged: false, // Track if user has ever dragged
      lastX: 0,
      lastY: 0,
      theta: Math.PI / 4, // Horizontal angle
      phi: Math.PI / 3, // Vertical angle - lower camera (more side-on view)
      radius: 9, // Distance from center (pulled back)
      velocity: 0, // Angular velocity for momentum
      lastMoveTime: 0, // Timestamp of last mouse move
      friction: 0.95, // Friction coefficient (0-1, higher = slower decay)
      autoSpinSpeed: 0.003, // Radians per frame for auto-spin
    };

    // Prevent context menu on canvas (right-click is used for orbit)
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // Wheel = orbit (no device detection — unreliable on macOS)
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey) return; // Ignore pinch gesture

        this.tankOrbit.hasBeenDragged = true;
        const sensitivity = 0.001;
        this.tankOrbit.theta -= e.deltaX * sensitivity;
        this.tankOrbit.velocity = -e.deltaX * sensitivity * 0.3;
        this._updateTankPreviewCamera();
      },
      { passive: false },
    );

    // Right-click drag to orbit (matches game controls)
    canvas.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (e.button !== 2) return; // Only right-click
      this.tankOrbit.isDragging = true;
      this.tankOrbit.hasBeenDragged = true; // Stop auto-spin permanently
      this.tankOrbit.lastX = e.clientX;
      this.tankOrbit.velocity = 0; // Stop momentum when grabbing
      canvas.style.cursor = "grabbing";
    });

    canvas.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Use window for mousemove/mouseup so dragging continues outside canvas
    window.addEventListener("mousemove", (e) => {
      if (!this.tankOrbit || !this.tankOrbit.isDragging) return;

      const now = performance.now();
      const deltaX = e.clientX - this.tankOrbit.lastX;
      const deltaTime = now - this.tankOrbit.lastMoveTime;

      // Rotate camera around tank horizontally only (clockwise/counterclockwise)
      const rotationDelta = deltaX * 0.01;
      this.tankOrbit.theta += rotationDelta;

      // Track velocity for momentum (radians per ms)
      if (deltaTime > 0 && deltaTime < 100) {
        this.tankOrbit.velocity = (rotationDelta / deltaTime) * 16; // Normalize to ~60fps
      }

      // Update camera position
      this._updateTankPreviewCamera();

      this.tankOrbit.lastX = e.clientX;
      this.tankOrbit.lastMoveTime = now;
    });

    window.addEventListener("mouseup", () => {
      if (!this.tankOrbit) return;
      this.tankOrbit.isDragging = false;
      canvas.style.cursor = "grab";
      // Velocity is preserved for momentum effect
    });

    // Set initial cursor
    canvas.style.cursor = "grab";

    // Initial camera position
    this._updateTankPreviewCamera();
  }

  /**
   * Update tank preview camera position based on orbit angles
   */
  _updateTankPreviewCamera() {
    if (!this.tankOrbit || !this.tankPreviewCamera) return;

    const { theta, phi, radius } = this.tankOrbit;

    // Spherical to Cartesian conversion
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);

    this.tankPreviewCamera.position.set(x, y, z);
    this.tankPreviewCamera.lookAt(0, 0, 0); // Look at tank base (tank appears higher in frame)
  }

  /**
   * Create a rectangular shadow blob on top of the ground plane (matches tank shape)
   * Tank dimensions: hull 2.5w × 5.0l, tracks add 0.6 each side = ~3.7w × 5.2l
   */
  _createShadowBlob() {
    const shadowWidth = 4.5; // Tank width (~3.7 + soft edge)
    const shadowDepth = 7; // Tank length - extended for longer tank footprint
    const shadowGeometry = new THREE.PlaneGeometry(shadowWidth, shadowDepth);

    // Create canvas for rectangular gradient shadow texture
    // Canvas aspect ratio matches tank: width < depth (tank is longer than wide)
    const canvas = document.createElement("canvas");
    const width = 96; // Narrower (tank width)
    const height = 144; // Longer (tank length) - extended
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    // Draw rounded rectangle with soft edges using multiple passes
    const centerX = width / 2;
    const centerY = height / 2;
    const rectWidth = width * 0.7;
    const rectHeight = height * 0.7;
    const cornerRadius = 8;

    // Helper to draw rounded rect path
    const roundedRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };

    // Draw multiple layers to create soft edge falloff
    const layers = 8;
    for (let i = layers; i >= 0; i--) {
      const scale = 1 + (i / layers) * 0.5; // Outer layers are larger
      const alpha = (1 - i / layers) * 0.6; // Outer layers are more transparent
      const w = rectWidth * scale;
      const h = rectHeight * scale;
      const x = centerX - w / 2;
      const y = centerY - h / 2;
      const r = cornerRadius * scale;

      roundedRect(x, y, w, h, r);
      ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
      ctx.fill();
    }

    const shadowTexture = new THREE.CanvasTexture(canvas);
    shadowTexture.minFilter = THREE.NearestFilter;
    shadowTexture.magFilter = THREE.NearestFilter;
    shadowTexture.needsUpdate = true;

    const shadowMaterial = new THREE.MeshBasicMaterial({
      map: shadowTexture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });

    const shadowMesh = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = 0.05; // Above ground plane
    shadowMesh.renderOrder = 0; // Render after ground plane (-1)

    this.tankPreviewGroup.add(shadowMesh);
  }

  /**
   * Create a ground plane underneath the tank that fades to transparent at edges
   */
  _createGroundPlane() {
    // Create a circular plane geometry
    const groundSize = 5.5;
    const groundGeometry = new THREE.CircleGeometry(groundSize, 32);

    // Create canvas for radial gradient texture
    const canvas = document.createElement("canvas");
    const size = 256;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Draw radial gradient: gray center fading to transparent edges (ground plane effect)
    const gradient = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0, // Inner circle center
      size / 2,
      size / 2,
      size / 2, // Outer circle radius
    );
    gradient.addColorStop(0, "rgba(80, 80, 85, 0.9)"); // Solid gray center
    gradient.addColorStop(0.4, "rgba(70, 70, 75, 0.7)"); // Still mostly solid
    gradient.addColorStop(0.7, "rgba(60, 60, 65, 0.4)"); // Starting to fade
    gradient.addColorStop(1, "rgba(50, 50, 55, 0)"); // Transparent edges

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // Create texture from canvas
    const groundTexture = new THREE.CanvasTexture(canvas);
    groundTexture.minFilter = THREE.NearestFilter;
    groundTexture.magFilter = THREE.NearestFilter;
    groundTexture.needsUpdate = true;

    // Create material with transparency
    const groundMaterial = new THREE.MeshBasicMaterial({
      map: groundTexture,
      transparent: true,
      depthWrite: false,
      opacity: 1,
    });

    // Create the ground mesh
    const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    groundMesh.rotation.x = -Math.PI / 2; // Rotate to lay flat on ground
    groundMesh.position.y = 0; // At ground level
    groundMesh.renderOrder = -1; // Render before tank

    this.tankPreviewGroup.add(groundMesh);
  }

  /**
   * Build the 3D tank model for preview
   */
  _buildPreviewTank() {
    // Clear existing
    while (this.tankPreviewGroup.children.length > 0) {
      this.tankPreviewGroup.remove(this.tankPreviewGroup.children[0]);
    }

    // Create ground plane underneath the tank
    this._createGroundPlane();

    // Create shadow blob on top of ground plane
    this._createShadowBlob();

    // Get faction colors
    const faction = this.playerFaction || "rust";
    const factionData =
      typeof FACTION_COLORS !== "undefined" ? FACTION_COLORS[faction] : null;

    const colors = {
      primary: factionData ? factionData.vehicle.primary : 0x555555,
      secondary: factionData ? factionData.vehicle.secondary : 0x444444,
      tracks: 0x222222,
      barrel: 0x333333,
    };

    // Materials
    const hullMaterial = new THREE.MeshStandardMaterial({
      color: colors.primary,
      roughness: 0.7,
      metalness: 0.3,
      flatShading: true,
    });

    const turretMaterial = new THREE.MeshStandardMaterial({
      color: colors.secondary,
      roughness: 0.6,
      metalness: 0.4,
      flatShading: true,
    });

    const trackMaterial = new THREE.MeshStandardMaterial({
      color: colors.tracks,
      roughness: 0.9,
      metalness: 0.1,
      flatShading: true,
    });

    const barrelMaterial = new THREE.MeshStandardMaterial({
      color: colors.barrel,
      roughness: 0.5,
      metalness: 0.6,
      flatShading: true,
    });

    // Hull (2.5 × 0.8 × 5)
    const hull = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 0.8, 5),
      hullMaterial,
    );
    hull.position.y = 0.4;
    this.tankPreviewGroup.add(hull);

    // Front slope
    const frontSlope = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.5, 1.0),
      hullMaterial,
    );
    frontSlope.position.set(0, 0.7, -2.5);
    frontSlope.rotation.x = 0.3;
    this.tankPreviewGroup.add(frontSlope);

    // Rear
    const rear = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 1.0, 0.8),
      hullMaterial,
    );
    rear.position.set(0, 0.5, 2.6);
    this.tankPreviewGroup.add(rear);

    // Tracks
    const trackGeom = new THREE.BoxGeometry(0.6, 0.6, 5.2);
    const leftTrack = new THREE.Mesh(trackGeom, trackMaterial);
    leftTrack.position.set(-1.3, 0.3, 0);
    this.tankPreviewGroup.add(leftTrack);

    const rightTrack = new THREE.Mesh(trackGeom, trackMaterial);
    rightTrack.position.set(1.3, 0.3, 0);
    this.tankPreviewGroup.add(rightTrack);

    // Turret group
    const turretGroup = new THREE.Group();
    turretGroup.position.y = 0.8;

    // Turret base
    const turret = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.6, 1.8),
      turretMaterial,
    );
    turret.position.y = 0.3;
    turretGroup.add(turret);

    // Barrel
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.15, 0.2, 2.5, 8),
      barrelMaterial,
    );
    barrel.rotation.x = -Math.PI / 2;
    barrel.position.set(0, 0.4, -2.0);
    turretGroup.add(barrel);

    // Muzzle brake
    const muzzle = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.3, 0.3),
      barrelMaterial,
    );
    muzzle.position.set(0, 0.4, -3.2);
    turretGroup.add(muzzle);

    this.tankPreviewGroup.add(turretGroup);
  }

  /**
   * Animation loop for tank preview
   * OPTIMIZED: Reduced to 30 FPS and includes visibility check
   */
  _animateTankPreview() {
    if (!this.tankPreviewRenderer) return;

    let lastRenderTime = 0;
    const targetFPS = 30;
    const frameInterval = 1000 / targetFPS;

    const animate = (timestamp) => {
      // Exit if dashboard is hidden (defensive check)
      if (!this.isVisible) {
        this.tankPreviewAnimationId = null;
        return;
      }

      this.tankPreviewAnimationId = requestAnimationFrame(animate);

      // Throttle to 30 FPS - preview doesn't need 60 FPS
      const elapsed = timestamp - lastRenderTime;
      if (elapsed < frameInterval) return;
      lastRenderTime = timestamp - (elapsed % frameInterval);

      if (this.tankOrbit && !this.tankOrbit.isDragging) {
        // Auto-spin until user drags for the first time
        if (!this.tankOrbit.hasBeenDragged) {
          this.tankOrbit.theta += this.tankOrbit.autoSpinSpeed;
          this._updateTankPreviewCamera();
        }
        // Apply momentum after dragging
        else if (Math.abs(this.tankOrbit.velocity) > 0.0001) {
          this.tankOrbit.theta += this.tankOrbit.velocity;
          this.tankOrbit.velocity *= this.tankOrbit.friction; // Apply friction
          this._updateTankPreviewCamera();

          // Stop when velocity is negligible
          if (Math.abs(this.tankOrbit.velocity) < 0.0001) {
            this.tankOrbit.velocity = 0;
          }
        }
      }

      this.tankPreviewRenderer.render(
        this.tankPreviewScene,
        this.tankPreviewCamera,
      );
    };
    animate(0);
  }

  /**
   * Update the tank preview (rebuild with current faction colors)
   */
  _updateTankPreview() {
    if (!this.tankPreviewGroup) return;
    this._buildPreviewTank();
  }

  /**
   * Update loadout when player level changes
   */
  updateLoadout(playerLevel) {
    this.playerLevel = playerLevel;
    if (this.loadoutInitialized) {
      this._renderUpgrades(playerLevel);
      this._updateSlotStates(playerLevel);
    }
  }

  // ========================
  // ECONOMY: LEVEL-UP POPUP
  // ========================

  _setupLevelUpPopup() {
    const levelEl = document.getElementById("dashboard-level");
    if (!levelEl) return;

    levelEl.style.cursor = "pointer";
    levelEl.title = "Click to level up";

    levelEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showLevelUpPopup();
    });
  }

  _showLevelUpPopup() {
    // Remove existing popup if any
    const existing = document.getElementById("level-up-popup");
    if (existing) existing.remove();

    const currentLevel = this.playerLevel || 1;
    const nextLevel = currentLevel + 1;

    // Calculate cost using same formula as server
    let cost = 0;
    if (nextLevel <= 5) cost = nextLevel * 10000;
    else if (nextLevel <= 10) cost = 50000 + (nextLevel - 5) * 20000;
    else if (nextLevel <= 20) cost = 150000 + (nextLevel - 10) * 35000;
    else cost = 500000 + (nextLevel - 20) * 50000;

    const balance = this._lastServerCrypto !== undefined ? this._lastServerCrypto : 0;
    const canAfford = balance >= cost;

    // Check what unlocks at next level
    const slotUnlocks = {
      3: 'Defense Slot 1',
      5: 'Tactical Slot 1',
      8: 'Offense Slot 2',
      12: 'Defense Slot 2',
      15: 'Tactical Slot 2',
    };
    const slotCosts = {
      3: 15000, 5: 30000, 8: 60000, 12: 120000, 15: 200000
    };
    const unlock = slotUnlocks[nextLevel];

    // Build popup
    const popup = document.createElement("div");
    popup.id = "level-up-popup";
    popup.className = "level-up-popup";
    popup.innerHTML = `
      <div class="level-up-popup-content">
        <div class="level-up-popup-header">Level Up</div>
        <div class="level-up-popup-body">
          <div class="level-up-current">Level ${currentLevel} → <strong>Level ${nextLevel}</strong></div>
          <div class="level-up-cost ${canAfford ? '' : 'level-up-cost-insufficient'}">
            Cost: ¢${cost.toLocaleString()}
          </div>
          ${!canAfford ? '<div class="level-up-insufficient">Not enough crypto</div>' : ''}
          ${unlock ? `<div class="level-up-unlock">Unlocks: ${unlock} (¢${slotCosts[nextLevel].toLocaleString()})</div>` : ''}
        </div>
        <div class="level-up-popup-buttons">
          <button class="level-up-btn level-up-confirm" ${canAfford ? '' : 'disabled'}>Confirm</button>
          <button class="level-up-btn level-up-cancel">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    // Event handlers
    const confirmBtn = popup.querySelector(".level-up-confirm");
    const cancelBtn = popup.querySelector(".level-up-cancel");

    confirmBtn.addEventListener("click", () => {
      // Send level-up request to server
      if (window._mp && window._mp.net) {
        window._mp.net.sendLevelUp();
      }
      popup.remove();
    });

    cancelBtn.addEventListener("click", () => {
      popup.remove();
    });

    // Close on outside click
    popup.addEventListener("click", (e) => {
      if (e.target === popup) popup.remove();
    });
  }

  // ========================
  // ECONOMY: TOAST NOTIFICATIONS
  // ========================

  showToast(message) {
    // Remove existing toast if any
    const existing = document.querySelector(".dashboard-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "dashboard-toast";
    toast.textContent = message;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => toast.classList.add("visible"));

    // Remove after 3 seconds
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ========================
  // ECONOMY: SLOT UNLOCK CALLBACK
  // ========================

  onSlotUnlocked(slotId) {
    // Re-render loadout to reflect the unlocked slot
    if (this.loadoutInitialized) {
      this._renderUpgrades(this.playerLevel || 1);
    }
    this.showToast(`Loadout slot unlocked: ${slotId}`);
  }
}
