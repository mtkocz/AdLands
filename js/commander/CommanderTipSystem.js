/**
 * AdLands - Commander Tip System
 * Crypto tip budget for commanders to reward faction members
 * ¢5,000/hour budget, ¢100-500 per tip
 */

const TIP_CONFIG = {
  hourlyBudget: 5000, // Crypto to distribute per hour
  tipAmount: 100, // Fixed tip amount (¢100 per tip)
  perPlayerCooldown: 60000, // 60 seconds between tips to same player
  activityThreshold: 600000, // Player must be active within 10 minutes
  carryOver: false, // Budget doesn't carry over
};

class CommanderTipSystem {
  constructor(cryptoSystem) {
    this.cryptoSystem = cryptoSystem;
    this.commanderSystem = null;

    // Tip state
    this.active = false;
    this.commanderPlayerId = null;
    this.faction = null;

    // Budget tracking
    this.budget = 0;
    this.hourStart = 0;

    // Cooldowns per player
    this.lastTips = new Map(); // playerId -> timestamp

    // Tip history (for display)
    this.tipHistory = []; // { to, amount, message, timestamp }

    // UI element
    this.uiElement = null;

    // HUD visibility (synced from main.js)
    this.hudVisible = true;
  }

  setCommanderSystem(commanderSystem) {
    this.commanderSystem = commanderSystem;
  }

  // ========================
  // ACTIVATION
  // ========================

  /**
   * Activate tip system for a commander
   */
  activate(playerId, faction) {
    this.active = true;
    this.commanderPlayerId = playerId;
    this.faction = faction;
    this.budget = TIP_CONFIG.hourlyBudget;
    this.hourStart = Date.now();
    this.lastTips.clear();

    this._createUI();
    this._updateUI();
  }

  /**
   * Deactivate tip system
   */
  deactivate() {
    this.active = false;
    this.commanderPlayerId = null;
    this.faction = null;

    this._removeUI();
  }

  /**
   * Hide or show the tip panel without changing active state or budget.
   * Used during death (hide) and respawn (show) to keep UI in sync.
   */
  setHidden(hidden) {
    if (!this.uiElement) return;
    if (hidden) {
      this.uiElement.style.display = "none";
      if (this.dragCoin) this.dragCoin.style.display = "none";
    } else {
      this.uiElement.style.display = "";
      if (this.dragCoin) this.dragCoin.style.display = "";
      this._updateUI();
    }
  }

  // ========================
  // TIP LOGIC
  // ========================

  /**
   * Check if a tip can be made
   * @returns {{ ok: boolean, reason?: string }}
   */
  canTip(targetId) {
    if (!this.active) {
      return { ok: false, reason: "Not commander" };
    }

    if (TIP_CONFIG.tipAmount > this.budget) {
      return { ok: false, reason: "Insufficient budget" };
    }

    if (this.commanderPlayerId === targetId) {
      return { ok: false, reason: "Cannot tip yourself" };
    }

    // Cannot tip bodyguards (they're not real players)
    if (targetId && targetId.startsWith("bodyguard-")) {
      return { ok: false, reason: "Cannot tip bodyguards" };
    }

    // Check faction match
    const target = this._getPlayer(targetId);
    if (!target) {
      return { ok: false, reason: "Player not found" };
    }

    if (target.faction !== this.faction) {
      return { ok: false, reason: "Can only tip faction members" };
    }

    // Check cooldown
    const lastTip = this.lastTips.get(targetId) || 0;
    const timeSinceTip = Date.now() - lastTip;
    if (timeSinceTip < TIP_CONFIG.perPlayerCooldown) {
      const remaining = Math.ceil(
        (TIP_CONFIG.perPlayerCooldown - timeSinceTip) / 1000,
      );
      return {
        ok: false,
        reason: `Wait ${remaining}s to tip this player again`,
      };
    }

    // Check activity (anti-abuse)
    if (!this._isPlayerActive(targetId)) {
      return { ok: false, reason: "Player must be active" };
    }

    return { ok: true };
  }

  /**
   * Execute a tip (always ¢100)
   * @returns {{ ok: boolean, reason?: string, newBudget?: number }}
   */
  tip(targetId, message = "") {
    const check = this.canTip(targetId);
    if (!check.ok) {
      return check;
    }

    const amount = TIP_CONFIG.tipAmount;

    // In multiplayer, send to server for authoritative validation + crypto award
    if (window.networkManager?.isMultiplayer) {
      window.networkManager.socket.emit("tip", { targetId, amount, message });

      // Optimistic local updates (server will correct via tip-confirmed/tip-failed)
      this.budget -= amount;
      this.lastTips.set(targetId, Date.now());

      const target = this._getPlayer(targetId);
      const targetName = target?.username || targetId;

      this.tipHistory.push({
        to: targetId,
        toName: targetName,
        amount,
        message,
        timestamp: Date.now(),
      });
      if (this.tipHistory.length > 50) this.tipHistory.shift();

      // Visual/audio feedback (immediate for responsiveness)
      this._spawnTipEffect(this._lastDropX, this._lastDropY);
      this._playChaChing();
      this._updateUI();

      // Tusk announcement handled server-side in multiplayer (via tusk-chat broadcast)

      return { ok: true, newBudget: this.budget };
    }

    // Single-player path (original behavior)
    this.budget -= amount;
    this.lastTips.set(targetId, Date.now());

    // Get target info
    const target = this._getPlayer(targetId);
    const targetName = target?.username || targetId;

    // Record tip
    this.tipHistory.push({
      to: targetId,
      toName: targetName,
      amount,
      message,
      timestamp: Date.now(),
    });

    // Keep only last 50 tips in history
    if (this.tipHistory.length > 50) {
      this.tipHistory.shift();
    }

    // Spawn tip effect at drop location
    this._spawnTipEffect(this._lastDropX, this._lastDropY);

    // Play cha-ching sound
    this._playChaChing();

    // Announce in global chat via Tusk
    this._announceTip(targetName, amount, message);

    // Update UI
    this._updateUI();

    // Notify Tusk commentary system
    if (window.tuskCommentary) {
      // Global chat announcement (shown to everyone)
      if (window.tuskCommentary.onCommanderTip) {
        window.tuskCommentary.onCommanderTip("Commander", targetName, amount);
      }
      // Local panel message for the tipper (Commander sending the tip)
      if (window.tuskCommentary.onTipSent) {
        window.tuskCommentary.onTipSent(targetName, amount);
      }
    }

    return { ok: true, newBudget: this.budget };
  }

  /**
   * Server confirmed the tip — sync authoritative budget
   */
  applyServerTipConfirm(data) {
    this.budget = data.newBudget;
    this._updateUI();
  }

  /**
   * Server rejected the tip — revert optimistic budget deduction
   */
  applyServerTipFailed(reason) {
    // Revert: re-add the amount we optimistically deducted
    this.budget = Math.min(this.budget + TIP_CONFIG.tipAmount, TIP_CONFIG.hourlyBudget);
    this._updateUI();
    this._showTipError(reason);
  }

  // ========================
  // UPDATE
  // ========================

  /**
   * Update tip system - handle hourly reset
   * Call from game loop
   */
  update(timestamp) {
    if (!this.active) return;

    // Check hourly reset
    const hourMs = 3600000;
    if (Date.now() - this.hourStart >= hourMs) {
      this.hourStart = Date.now();
      this.budget = TIP_CONFIG.hourlyBudget;
      this._updateUI();
    }
  }

  // ========================
  // HELPERS
  // ========================

  _getPlayer(playerId) {
    // Try commander system first
    if (window.commanderSystem) {
      const players = window.commanderSystem.players;
      if (players && players.has(playerId)) {
        return players.get(playerId);
      }
    }

    // Fallback for bots
    if (playerId.startsWith("bot-") && window.botTanks) {
      const index = parseInt(playerId.replace("bot-", ""));
      const bot = window.botTanks.bots[index];
      if (bot) {
        return {
          faction: bot.faction,
          username: bot.lodDot?.userData?.username || `Bot ${index}`,
          isHuman: false,
        };
      }
    }

    return null;
  }

  _isPlayerActive(playerId) {
    // For now, assume all players are active
    // In multiplayer, would check last activity timestamp
    return true;
  }

  _getAudioContext() {
    if (!this._audioCtx) {
      try {
        this._audioCtx = new (
          window.AudioContext || window.webkitAudioContext
        )();
      } catch (e) {
        return null;
      }
    }
    return this._audioCtx;
  }

  _playChaChing() {
    if (window.settingsManager) {
      const sfx = window.settingsManager.get("audio.sfx");
      const master = window.settingsManager.get("audio.master");
      if (sfx === 0 || master === 0) return;
    }

    const ctx = this._getAudioContext();
    if (!ctx) return;

    try {
      const sfx = window.settingsManager?.get("audio.sfx") ?? 0.8;
      const master = window.settingsManager?.get("audio.master") ?? 0.8;
      const vol = sfx * master * 0.25;
      const now = ctx.currentTime;

      // "Cha" — short metallic hit
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.frequency.value = 1200;
      osc1.type = "square";
      gain1.gain.setValueAtTime(vol, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc1.start(now);
      osc1.stop(now + 0.08);

      // "Ching" — higher pitched ring, slight delay
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.value = 1800;
      osc2.type = "square";
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(vol, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc2.start(now + 0.1);
      osc2.stop(now + 0.35);

      // Shimmer overtone
      const osc3 = ctx.createOscillator();
      const gain3 = ctx.createGain();
      osc3.connect(gain3);
      gain3.connect(ctx.destination);
      osc3.frequency.value = 3600;
      osc3.type = "sine";
      gain3.gain.setValueAtTime(vol * 0.3, now + 0.1);
      gain3.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc3.start(now + 0.1);
      osc3.stop(now + 0.4);
    } catch (e) {
      // Audio failed silently
    }
  }

  _announceTip(targetName, amount, message) {
    // Announce in global chat via Lord Elon (Tusk)
    // Pick from a variety of corporate dystopia announcements
    if (
      window.proximityChat &&
      window.proximityChat.chatWindow &&
      window.proximityChat.chatWindow.addTuskMessage
    ) {
      const commander = this._getPlayer(this.commanderPlayerId);
      const cmdName = commander?.username || "The Commander";

      const announcements = message
        ? [
            `BREAKING: @${cmdName} has bestowed ¢ ${amount} upon @${targetName}. "${message}" — Trickle-down economics at work!`,
            `NOTICE: @${targetName} received ¢ ${amount} from @${cmdName} with a personal note: "${message}". Favoritism? We call it 'strategic incentivization.'`,
            `MORALE UPDATE: @${cmdName} just tipped @${targetName} ¢ ${amount}. "${message}" — This is basically a raise.`,
          ]
        : [
            `ATTENTION CONTRACTORS: @${cmdName} has financially validated @${targetName} with ¢ ${amount}. Excellence is noticed. Sometimes.`,
            `ECONOMY ALERT: @${targetName} received ¢ ${amount} from Commander @${cmdName}. Trickle-down economics at its finest.`,
            `BREAKING: @${cmdName} just tipped @${targetName} ¢ ${amount}. Teacher's pet detected. Other contractors take note.`,
            `NOTICE: Commander @${cmdName} deployed ¢ ${amount} to @${targetName}. Remember: gratitude is mandatory but smiling is optional.`,
            `WEALTH REDISTRIBUTION: @${cmdName} made @${targetName} ¢ ${amount} richer. The Commander's generosity knows bounds. Budget bounds.`,
          ];

      const tipMessage =
        announcements[Math.floor(Math.random() * announcements.length)];
      window.proximityChat.chatWindow.addTuskMessage(tipMessage);
    }
  }

  // ========================
  // UI
  // ========================

  _createUI() {
    if (this.uiElement) return;

    // Add styles first
    if (!document.getElementById("commander-tip-styles")) {
      const style = document.createElement("style");
      style.id = "commander-tip-styles";
      style.textContent = `
                #commander-tip-panel {
                    position: fixed;
                    top: var(--space-sm);
                    left: 340px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    background: var(--bg-highlight);
                    padding: 8px 14px;
                    font-family: var(--font-body);
                    font-size: var(--font-size-body);
                    color: #ffd700;
                    z-index: 100;
                    user-select: none;
                    cursor: grab;
                    clip-path: var(--clip-rounded-16);
                    /* Match dashboard outline style */
                    filter: drop-shadow(1px 0 0 rgba(255, 255, 255, 0.15))
                        drop-shadow(-1px 0 0 rgba(255, 255, 255, 0.15))
                        drop-shadow(0 1px 0 rgba(255, 255, 255, 0.15))
                        drop-shadow(0 -1px 0 rgba(255, 255, 255, 0.15))
                        drop-shadow(2px 0 0 var(--border-dark))
                        drop-shadow(-2px 0 0 var(--border-dark))
                        drop-shadow(0 2px 0 var(--border-dark))
                        drop-shadow(0 -2px 0 var(--border-dark));
                    transition: opacity 0.3s ease-in;
                }
                #commander-tip-panel:hover {
                    background: #3a3a3a;
                }
                #commander-tip-panel:active {
                    cursor: grabbing;
                }
                #commander-tip-panel.dragging {
                    opacity: 0.7;
                }
                #commander-tip-panel .tip-crypto-label {
                    font-family: var(--font-body);
                    font-size: var(--font-size-body);
                    font-weight: normal;
                    color: #ffd700;
                    text-shadow: 0 0 8px rgba(255, 215, 0, 0.6);
                    margin-right: 4px;
                }
                #commander-tip-panel .tip-budget {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }
                #commander-tip-panel .tip-budget-label {
                    font-family: var(--font-body);
                    font-size: var(--font-size-body);
                    color: #ffd700;
                    text-transform: uppercase;
                }
                #commander-tip-panel .tip-budget-bar {
                    width: 120px;
                    height: 10px;
                    background: #333;
                    border: 1px solid #555;
                }
                #commander-tip-panel .tip-budget-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #ffd700, #ccac00);
                    transition: width 0.3s ease;
                }
                #commander-tip-panel .tip-budget-text {
                    font-size: var(--font-size-body);
                }
                #tip-drag-indicator {
                    position: fixed;
                    padding: 6px 10px;
                    background: rgba(0, 0, 0, 0.9);
                    border: 2px solid #ffd700;
                    font-family: var(--font-body);
                    font-size: var(--font-size-body);
                    font-weight: bold;
                    color: #ffd700;
                    pointer-events: none;
                    z-index: 10000;
                    transform: translate(-50%, -50%);
                    display: none;
                    /* Bresenham corners for drag indicator too */
                    clip-path: polygon(
                        0 4px, 2px 4px, 2px 2px, 4px 2px, 4px 0,
                        calc(100% - 4px) 0,
                        calc(100% - 4px) 2px, calc(100% - 2px) 2px, calc(100% - 2px) 4px, 100% 4px,
                        100% calc(100% - 4px),
                        calc(100% - 2px) calc(100% - 4px), calc(100% - 2px) calc(100% - 2px), calc(100% - 4px) calc(100% - 2px), calc(100% - 4px) 100%,
                        4px 100%,
                        4px calc(100% - 2px), 2px calc(100% - 2px), 2px calc(100% - 4px), 0 calc(100% - 4px)
                    );
                }
                #tip-drag-indicator.visible {
                    display: block;
                }
            `;
      document.head.appendChild(style);
    }

    // Create panel
    this.uiElement = document.createElement("div");
    this.uiElement.id = "commander-tip-panel";
    this.uiElement.title = "Drag to tip a player";
    this.uiElement.innerHTML = `
            <div class="tip-crypto-label">¢</div>
            <div class="tip-budget">
                <div class="tip-budget-label">Bonus Budget</div>
                <div class="tip-budget-bar">
                    <div class="tip-budget-fill" id="tip-budget-fill"></div>
                </div>
                <div class="tip-budget-text">
                    ¢ <span id="tip-budget-current">${this.budget.toLocaleString()}</span> / ${TIP_CONFIG.hourlyBudget.toLocaleString()}
                </div>
            </div>
        `;

    // Respect current HUD visibility (fade via opacity)
    if (!this.hudVisible) {
      this.uiElement.style.opacity = "0";
      this.uiElement.style.pointerEvents = "none";
    }

    document.body.appendChild(this.uiElement);

    // Create drag indicator element (shows fixed ¢100)
    this.dragCoin = document.createElement("div");
    this.dragCoin.id = "tip-drag-indicator";
    this.dragCoin.textContent = `+¢ ${TIP_CONFIG.tipAmount}`;
    document.body.appendChild(this.dragCoin);

    // Setup drag and drop
    this._setupDragAndDrop();
  }

  _setupDragAndDrop() {
    const panel = this.uiElement;
    if (!panel) return;

    this.isDragging = false;
    this.dragTarget = null;
    this._dragStartPos = null;
    this._hasDraggedEnough = false;

    // Mouse down on panel - start drag
    panel.addEventListener("mousedown", (e) => {
      if (this.budget < TIP_CONFIG.tipAmount) return;

      e.preventDefault();
      e.stopPropagation();
      this.isDragging = true;
      this._dragStartPos = { x: e.clientX, y: e.clientY };
      this._hasDraggedEnough = false;
      panel.classList.add("dragging");
      document.body.classList.add("tip-dragging");
      this.dragCoin.classList.add("visible");
      this._updateDragPosition(e.clientX, e.clientY);
    });

    // Mouse move - update drag position and check for targets
    this._mouseMoveHandler = (e) => {
      if (!this.isDragging) return;

      this._updateDragPosition(e.clientX, e.clientY);

      // Check if user has dragged far enough (minimum 20px to count as a real drag)
      if (!this._hasDraggedEnough && this._dragStartPos) {
        const dx = e.clientX - this._dragStartPos.x;
        const dy = e.clientY - this._dragStartPos.y;
        if (Math.sqrt(dx * dx + dy * dy) > 20) {
          this._hasDraggedEnough = true;
        }
      }

      // Check for player tag under cursor
      const target = this._findPlayerTagAtPosition(e.clientX, e.clientY);
      this._updateDragTarget(target);
    };
    window.addEventListener("mousemove", this._mouseMoveHandler);

    // Mouse up - drop tip if over valid target
    this._mouseUpHandler = (e) => {
      if (!this.isDragging) return;

      // Prevent weapon firing when dropping tip
      e.preventDefault();
      e.stopPropagation();

      panel.classList.remove("dragging");
      document.body.classList.remove("tip-dragging");
      this.dragCoin.classList.remove("visible");

      // Clear all highlights
      document.querySelectorAll(".tip-highlight").forEach((el) => {
        el.classList.remove("tip-highlight");
      });
      if (this.dragCoin) {
        this.dragCoin.style.filter = "";
      }

      // Only execute tip if user actually dragged (not just clicked)
      if (this.dragTarget && this._hasDraggedEnough) {
        // Store drop position for effect
        this._lastDropX = e.clientX;
        this._lastDropY = e.clientY;

        // Execute tip (fixed ¢100)
        const playerId = this.dragTarget.dataset.playerId;
        if (playerId) {
          const result = this.tip(playerId);
          if (!result.ok) {
            this._showTipError(result.reason);
          }
        }
      }

      // Set a flag to block weapon firing briefly
      this._blockWeaponFire = true;
      setTimeout(() => {
        this._blockWeaponFire = false;
      }, 100);

      this.isDragging = false;
      this.dragTarget = null;
    };
    window.addEventListener("mouseup", this._mouseUpHandler);
  }

  /**
   * Check if weapon firing should be blocked (just dropped a tip)
   */
  isBlockingWeaponFire() {
    return this._blockWeaponFire || this.isDragging;
  }

  _updateDragPosition(x, y) {
    if (this.dragCoin) {
      this.dragCoin.style.left = x + "px";
      this.dragCoin.style.top = y + "px";
    }
  }

  _findPlayerTagAtPosition(x, y) {
    // Check 2D player tag DOM elements first
    const tags = document.querySelectorAll(".player-tag");
    for (const tag of tags) {
      const rect = tag.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        return tag;
      }
    }

    // Check chat panel names (msg-name and chat-mention with data-player-id)
    const chatNames = document.querySelectorAll(
      ".msg-name[data-player-id], .chat-mention[data-player-id]",
    );
    for (const nameEl of chatNames) {
      const rect = nameEl.getBoundingClientRect();
      if (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      ) {
        nameEl._isChatName = true;
        return nameEl;
      }
    }

    // Check 3D tank LOD dots (for orbital view)
    if (window.tankLODInteraction) {
      const ndcX = (x / window.innerWidth) * 2 - 1;
      const ndcY = -(y / window.innerHeight) * 2 + 1;
      const hit = window.tankLODInteraction.getClickedPlayer(ndcX, ndcY);
      if (hit) {
        return { dataset: { playerId: hit.playerId }, _is3DTank: true };
      }
    }

    // Check 3D tanks directly (for close range surface view)
    if (window.gameCamera && window.botTanks) {
      const cam = window.gameCamera.camera;
      if (cam) {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2(
          (x / window.innerWidth) * 2 - 1,
          -(y / window.innerHeight) * 2 + 1,
        );
        raycaster.setFromCamera(mouse, cam);

        let closestHit = null;
        let closestDist = Infinity;
        const tankWorldPos = new THREE.Vector3();
        const hitRadius = 6.0;

        for (const bot of window.botTanks.bots) {
          if (!bot.group.visible || bot.isDead) continue;

          bot.group.updateWorldMatrix(true, false);
          bot.group.getWorldPosition(tankWorldPos);

          const sphere = new THREE.Sphere(tankWorldPos, hitRadius);
          const intersectPoint = new THREE.Vector3();
          if (raycaster.ray.intersectSphere(sphere, intersectPoint)) {
            const dist = raycaster.ray.origin.distanceTo(intersectPoint);
            if (dist < closestDist && bot.playerId) {
              closestDist = dist;
              closestHit = bot;
            }
          }
        }

        if (closestHit) {
          return {
            dataset: { playerId: closestHit.playerId },
            _is3DTank: true,
          };
        }
      }
    }

    // Check remote tanks in multiplayer (surface view)
    if (window._remoteTanks && window.gameCamera) {
      const cam = window.gameCamera.camera;
      if (cam) {
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2(
          (x / window.innerWidth) * 2 - 1,
          -(y / window.innerHeight) * 2 + 1,
        );
        raycaster.setFromCamera(mouse, cam);

        let closestHit = null;
        let closestDist = Infinity;
        const tankWorldPos = new THREE.Vector3();
        const hitRadius = 6.0;

        for (const [id, rt] of window._remoteTanks) {
          if (!rt.group?.visible || rt.isDead) continue;

          rt.group.updateWorldMatrix(true, false);
          rt.group.getWorldPosition(tankWorldPos);

          const sphere = new THREE.Sphere(tankWorldPos, hitRadius);
          const intersectPoint = new THREE.Vector3();
          if (raycaster.ray.intersectSphere(sphere, intersectPoint)) {
            const dist = raycaster.ray.origin.distanceTo(intersectPoint);
            if (dist < closestDist) {
              closestDist = dist;
              closestHit = { id, rt };
            }
          }
        }

        if (closestHit) {
          return {
            dataset: { playerId: closestHit.id },
            _is3DTank: true,
          };
        }
      }
    }

    return null;
  }

  _updateDragTarget(newTarget) {
    // Remove highlight from previous target
    if (this.dragTarget && this.dragTarget !== newTarget) {
      this._removeTargetHighlight(this.dragTarget);
    }

    this.dragTarget = newTarget;

    // Add highlight to new target if valid
    if (newTarget) {
      const playerId = newTarget.dataset.playerId;

      // Early exit for invalid targets (self or bodyguards) - never highlight these
      if (
        playerId === this.commanderPlayerId ||
        (playerId && playerId.startsWith("bodyguard-"))
      ) {
        this._removeTargetHighlight(newTarget);
        this.dragTarget = null;
        return;
      }

      const check = this.canTip(playerId);
      if (check.ok) {
        this._applyTargetHighlight(newTarget);
      } else {
        this._removeTargetHighlight(newTarget);
        this.dragTarget = null; // Can't tip this target
      }
    }

    // Reset drag indicator when not over a valid 3D/non-DOM target
    if ((!newTarget || !newTarget._is3DTank) && this.dragCoin) {
      this.dragCoin.style.borderColor = "#ffd700";
      this.dragCoin.style.color = "#ffd700";
    }
  }

  _applyTargetHighlight(target) {
    if (target._is3DTank) {
      // Gold border on drag indicator for 3D targets
      if (this.dragCoin) {
        this.dragCoin.style.borderColor = "#ffd700";
        this.dragCoin.style.color = "#ffd700";
        this.dragCoin.style.filter = "brightness(1.5)";
      }
    } else if (target._isChatName) {
      // Gold outline on chat name
      target.classList.add("tip-highlight");
    } else {
      // Player tag DOM element
      target.classList.add("tip-highlight");
    }
  }

  _removeTargetHighlight(target) {
    if (target._is3DTank) {
      if (this.dragCoin) {
        this.dragCoin.style.filter = "";
      }
    } else if (target._isChatName) {
      target.classList.remove("tip-highlight");
    } else {
      target.classList.remove("tip-highlight");
    }
  }

  _showTipError(message) {
    // Brief error notification
    const error = document.createElement("div");
    error.style.cssText = `
            position: fixed;
            top: 60px;
            left: 340px;
            background: rgba(255, 50, 50, 0.9);
            color: #fff;
            padding: 8px 12px;
            font-family: var(--font-body);
            font-size: var(--font-size-body);
            z-index: 10001;
            border: 1px solid #ff0000;
        `;
    error.textContent = message;
    document.body.appendChild(error);

    setTimeout(() => {
      error.remove();
    }, 2000);
  }

  /**
   * Spawn tip effect at the drop location
   * Uses the same floating crypto style as the regular crypto system for consistency
   */
  _spawnTipEffect(x, y) {
    if (x === undefined || y === undefined) return;

    const amount = TIP_CONFIG.tipAmount;

    // Create particle container
    const container = document.createElement("div");
    container.style.cssText = `
            position: fixed;
            left: ${x}px;
            top: ${y}px;
            pointer-events: none;
            z-index: 10002;
        `;
    document.body.appendChild(container);

    // Spawn multiple floating crypto numbers exploding outward
    // Use the same .crypto-floating-number style as regular crypto
    const cryptoNumberCount = 6;
    for (let i = 0; i < cryptoNumberCount; i++) {
      const cryptoNum = document.createElement("div");
      cryptoNum.className = "crypto-floating-number crypto-medium";
      const angle =
        (i / cryptoNumberCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const distance = 50 + Math.random() * 30;
      const endX = Math.cos(angle) * distance;
      const endY = Math.sin(angle) * distance - 20; // Drift upward
      const delay = Math.random() * 0.1;

      cryptoNum.style.cssText += `
                position: absolute;
                transform: translate(-50%, -50%);
                animation: tipCryptoExplode 0.8s ease-out ${delay}s forwards;
                opacity: 0;
                --end-x: ${endX}px;
                --end-y: ${endY}px;
                white-space: nowrap;
                color: #ffd700;
                text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, -1px 0 0 #000, 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000, 0 0 6px rgba(255, 215, 0, 0.5);
            `;
      cryptoNum.textContent = `+¢ ${amount}`;
      container.appendChild(cryptoNum);
    }

    // Gold sparkle particles (small visual accent)
    const particleCount = 12;
    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement("div");
      const angle = (i / particleCount) * Math.PI * 2;
      const distance = 40 + Math.random() * 30;
      const endX = Math.cos(angle) * distance;
      const endY = Math.sin(angle) * distance;
      const size = 2 + Math.random() * 2;
      const delay = Math.random() * 0.1;

      particle.style.cssText = `
                position: absolute;
                width: ${size}px;
                height: ${size}px;
                background: #FFD700;
                box-shadow: 0 0 4px #FFD700;
                transform: translate(-50%, -50%);
                animation: tipParticle 0.5s ease-out ${delay}s forwards;
                opacity: 0;
                --end-x: ${endX}px;
                --end-y: ${endY}px;
            `;
      container.appendChild(particle);
    }

    // Main floating +crypto text (larger, central) - uses crypto-large class for consistency
    const floatText = document.createElement("div");
    floatText.className = "crypto-floating-number crypto-large";
    floatText.style.cssText += `
            position: absolute;
            transform: translate(-50%, -50%);
            animation: tipFloatUp 1.2s ease-out forwards;
            white-space: nowrap;
            color: #ffd700;
            text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, -1px 0 0 #000, 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000, 0 0 6px rgba(255, 215, 0, 0.5);
        `;
    floatText.textContent = `+¢ ${amount}`;
    container.appendChild(floatText);

    // Add CSS animation if not already added
    if (!document.getElementById("tip-effect-styles")) {
      const style = document.createElement("style");
      style.id = "tip-effect-styles";
      style.textContent = `
                @keyframes tipParticle {
                    0% {
                        opacity: 1;
                        transform: translate(-50%, -50%) scale(1);
                    }
                    100% {
                        opacity: 0;
                        transform: translate(calc(-50% + var(--end-x)), calc(-50% + var(--end-y))) scale(0.3);
                    }
                }
                @keyframes tipCryptoExplode {
                    0% {
                        opacity: 0.8;
                        transform: translate(-50%, -50%) scale(0.5);
                    }
                    30% {
                        opacity: 0.8;
                        transform: translate(calc(-50% + calc(var(--end-x) * 0.5)), calc(-50% + calc(var(--end-y) * 0.5))) scale(1);
                    }
                    100% {
                        opacity: 0;
                        transform: translate(calc(-50% + var(--end-x)), calc(-50% + var(--end-y))) scale(0.8);
                    }
                }
                @keyframes tipFloatUp {
                    0% {
                        opacity: 0.8;
                        transform: translate(-50%, -50%) scale(0.5);
                    }
                    15% {
                        transform: translate(-50%, -50%) scale(1.2);
                    }
                    30% {
                        opacity: 0.8;
                        transform: translate(-50%, calc(-50% - 10px)) scale(1);
                    }
                    100% {
                        opacity: 0;
                        transform: translate(-50%, calc(-50% - 50px)) scale(1);
                    }
                }
            `;
      document.head.appendChild(style);
    }

    // Clean up after animation
    setTimeout(() => {
      container.remove();
    }, 1500);
  }

  _updateUI() {
    if (!this.uiElement) return;

    const fill = this.uiElement.querySelector("#tip-budget-fill");
    const current = this.uiElement.querySelector("#tip-budget-current");

    if (fill) {
      const percent = (this.budget / TIP_CONFIG.hourlyBudget) * 100;
      fill.style.width = `${percent}%`;
    }

    if (current) {
      current.textContent = this.budget.toLocaleString();
    }

    // Update panel appearance if budget is too low for a tip
    // Respect HUD visibility — don't override opacity when hidden
    if (!this.hudVisible) {
      this.uiElement.style.opacity = "0";
      this.uiElement.style.pointerEvents = "none";
      this.uiElement.style.cursor = "default";
    } else if (this.budget < TIP_CONFIG.tipAmount) {
      this.uiElement.style.opacity = "0.5";
      this.uiElement.style.cursor = "not-allowed";
    } else {
      this.uiElement.style.opacity = "";
      this.uiElement.style.cursor = "grab";
    }
  }

  _removeUI() {
    // Remove event listeners
    if (this._mouseMoveHandler) {
      window.removeEventListener("mousemove", this._mouseMoveHandler);
      this._mouseMoveHandler = null;
    }
    if (this._mouseUpHandler) {
      window.removeEventListener("mouseup", this._mouseUpHandler);
      this._mouseUpHandler = null;
    }
    if (this._globalDragStartHandler) {
      window.removeEventListener("mousedown", this._globalDragStartHandler);
      this._globalDragStartHandler = null;
    }

    if (this.uiElement && this.uiElement.parentNode) {
      this.uiElement.parentNode.removeChild(this.uiElement);
      this.uiElement = null;
    }
    if (this.dragCoin && this.dragCoin.parentNode) {
      this.dragCoin.parentNode.removeChild(this.dragCoin);
      this.dragCoin = null;
    }
  }

  // ========================
  // PUBLIC API
  // ========================

  /**
   * Get current budget
   */
  getBudget() {
    return this.budget;
  }

  /**
   * Get tip history
   */
  getHistory() {
    return [...this.tipHistory];
  }

  /**
   * Check if tip system is active
   */
  isActive() {
    return this.active;
  }

  /**
   * Get quick tip amounts
   */
  getQuickTipAmounts() {
    return [100, 250, 500];
  }
}
