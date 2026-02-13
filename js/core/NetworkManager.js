/**
 * AdLands - NetworkManager
 * Client-side networking: connects to the server, sends input,
 * receives world state, manages remote player tanks.
 *
 * This is the bridge between the existing single-player game systems
 * and the multiplayer server.
 */

class NetworkManager {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.playerId = null;

    // Assigned by server on connect
    this.playerName = null;
    this.playerFaction = null;

    // All remote players: id → { tank, name, faction, targetState, ... }
    this.remotePlayers = new Map();

    // Server tick rate (sent in welcome packet)
    this.serverTickRate = 20;

    // Client-side prediction: buffer of unacknowledged inputs
    this.inputSeq = 0;
    this.pendingInputs = [];

    // Input send throttle: match server tick rate (20Hz = 50ms)
    this._lastInputSendTime = 0;
    this._inputSendInterval = 50; // ms — matches 20 tick/sec server

    // Ping measurement
    this.ping = 0; // latest round-trip time in ms
    this._pingInterval = null;

    // Server state for reconciliation
    this.lastServerState = null;

    // Callbacks — set by main.js to wire into existing systems
    this.onConnected = null;        // (welcomeData) => {}
    this.onPlayerJoined = null;     // (playerData) => {}
    this.onPlayerIdentityUpdated = null; // ({ id, name, faction }) => {}
    this.onPlayerLeft = null;       // (playerId) => {}
    this.onStateUpdate = null;      // (stateData) => {}
    this.onPlayerFired = null;      // (fireData) => {}
    this.onPlayerHit = null;        // (hitData) => {}
    this.onPlayerKilled = null;     // (killData) => {}
    this.onPlayerRespawned = null;  // (respawnData) => {}
    this.onChatMessage = null;      // (chatData) => {}
    this.onTuskChat = null;         // (data) => { text }
    this.onTerritoryUpdate = null;  // (changes) => {}
    this.onTicCrypto = null;         // () => {} — server says player earned tic crypto
    this.onHoldingCrypto = null;     // (data) => { amount } — server awarded holding crypto
    this.onCaptureProgress = null;   // (data) => { clusterId, tics, capacity, owner }
    this.onPlayerFactionChanged = null; // (data) => { id, faction }
    this.onPortalConfirmed = null;  // (data) => { theta, phi, heading }
    this.onRespawnChoosePortal = null; // (data) => { id, hp }
    this.onPlayerActivated = null;  // (data) => { id, name, faction, theta, phi, ... }
    this.onPlayerProfile = null;    // (data) => { id, badges, crypto, title }
    this.onSponsorsReloaded = null; // (data) => { world }
    this.onMoonSponsorsReloaded = null; // (data) => { moonSponsors }
    this.onBillboardSponsorsReloaded = null; // (data) => { billboardSponsors }
    this.onCommanderUpdate = null;  // (data) => { faction, commander: { id, name } | null }
    this.onCryptoUpdate = null;     // (cryptoState) => { playerId: amount, ... }
    this.onTipReceived = null;      // (data) => { fromId, fromName, amount, newCrypto }
    this.onTipConfirmed = null;     // (data) => { targetId, targetName, amount, newBudget }
    this.onTipFailed = null;        // (data) => { reason }
    this.onBodyguardKilled = null;  // (data) => { id, faction, killerFaction }
    this.onCommanderPing = null;    // (data) => { id, faction, x, y, z }
    this.onCommanderDrawing = null; // (data) => { id, faction, points }
  }

  // ========================
  // CONNECTION
  // ========================

  connect() {
    // Socket.IO auto-connects to the server that served the page
    this.socket = io({
      transports: ["websocket"],     // Skip HTTP long-polling, go straight to WebSocket
      upgrade: false,                // Don't attempt transport upgrade
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket.on("connect", () => {
      this.connected = true;
      this.playerId = this.socket.id;
      // Start ping measurement (every 2s)
      this._startPing();
    });

    this.socket.on("disconnect", (reason) => {
      this.connected = false;
      this._stopPing();
    });

    // Ping response from server
    this.socket.on("pong-measure", (ts) => {
      this.ping = Date.now() - ts;
    });

    this.socket.on("reconnect", () => {
    });

    // ---- Server Events ----

    // Welcome: server tells us who we are and who else is here
    this.socket.on("welcome", (data) => {
      this.playerName = data.you.name;
      this.playerFaction = data.you.faction;
      this.serverTickRate = data.tickRate;

      if (this.onConnected) this.onConnected(data);
    });

    // Another player joined
    this.socket.on("player-joined", (data) => {
      if (this.onPlayerJoined) this.onPlayerJoined(data);
    });

    // A player updated their identity (name/faction from onboarding)
    this.socket.on("player-identity-updated", (data) => {
      if (this.onPlayerIdentityUpdated) this.onPlayerIdentityUpdated(data);
    });

    // A player left
    this.socket.on("player-left", (data) => {
      if (this.onPlayerLeft) this.onPlayerLeft(data.id);
    });

    // World state update (20 times/sec from server)
    this.socket.on("state", (data) => {
      this.lastServerState = data;
      if (this.onStateUpdate) this.onStateUpdate(data);
    });

    // Someone fired
    this.socket.on("player-fired", (data) => {
      if (this.onPlayerFired) this.onPlayerFired(data);
    });

    // Someone was hit
    this.socket.on("player-hit", (data) => {
      if (this.onPlayerHit) this.onPlayerHit(data);
    });

    // Someone was killed
    this.socket.on("player-killed", (data) => {
      if (this.onPlayerKilled) this.onPlayerKilled(data);
    });

    // Someone respawned
    this.socket.on("player-respawned", (data) => {
      if (this.onPlayerRespawned) this.onPlayerRespawned(data);
    });

    // Chat message
    this.socket.on("chat", (data) => {
      if (this.onChatMessage) this.onChatMessage(data);
    });

    // Tusk global chat (server-generated Lord Elon messages)
    this.socket.on("tusk-chat", (data) => {
      if (this.onTuskChat) this.onTuskChat(data);
    });

    // Territory ownership changes
    this.socket.on("territory-update", (data) => {
      if (this.onTerritoryUpdate) this.onTerritoryUpdate(data);
    });

    // Server awarded tic contribution crypto (includes current tics for ring sync)
    this.socket.on("tic-crypto", (data) => {
      if (this.onTicCrypto) this.onTicCrypto(data);
    });

    // Server awarded holding crypto (once per 60 seconds for territory holdings)
    this.socket.on("holding-crypto", (data) => {
      if (this.onHoldingCrypto) this.onHoldingCrypto(data);
    });

    // Periodic capture progress (tic values for player's current cluster)
    this.socket.on("capture-progress", (data) => {
      if (this.onCaptureProgress) this.onCaptureProgress(data);
    });

    // A player changed their faction
    this.socket.on("player-faction-changed", (data) => {
      if (this.onPlayerFactionChanged) this.onPlayerFactionChanged(data);
    });

    // Portal confirmed (server accepted our portal choice)
    this.socket.on("portal-confirmed", (data) => {
      if (this.onPortalConfirmed) this.onPortalConfirmed(data);
    });

    // Respawn: server tells us to choose a portal
    this.socket.on("respawn-choose-portal", (data) => {
      if (this.onRespawnChoosePortal) this.onRespawnChoosePortal(data);
    });

    // A waiting player has activated (chose their portal)
    this.socket.on("player-activated", (data) => {
      if (this.onPlayerActivated) this.onPlayerActivated(data);
    });

    // Another player's profile data (badges, crypto)
    this.socket.on("player-profile", (data) => {
      if (this.onPlayerProfile) this.onPlayerProfile(data);
    });

    // Admin changed sponsors — server reloaded clusters
    this.socket.on("sponsors-reloaded", (data) => {
      if (this.onSponsorsReloaded) this.onSponsorsReloaded(data);
    });

    // Admin changed moon sponsors — server reloaded moon textures
    this.socket.on("moon-sponsors-reloaded", (data) => {
      if (this.onMoonSponsorsReloaded) this.onMoonSponsorsReloaded(data);
    });

    // Admin changed billboard sponsors — server reloaded billboard textures
    this.socket.on("billboard-sponsors-reloaded", (data) => {
      if (this.onBillboardSponsorsReloaded) this.onBillboardSponsorsReloaded(data);
    });

    // Server-authoritative commander change (immediate)
    this.socket.on("commander-update", (data) => {
      if (this.onCommanderUpdate) this.onCommanderUpdate(data);
    });

    // Server-authoritative commander full sync (periodic, every 5 seconds)
    this.socket.on("commander-sync", (data) => {
      if (this.onCommanderSync) this.onCommanderSync(data);
    });

    // Server-authoritative crypto balances (broadcast every 5 seconds)
    this.socket.on("crypto-update", (data) => {
      if (this.onCryptoUpdate) this.onCryptoUpdate(data);
    });

    // Commander tip events
    this.socket.on("tip-received", (data) => {
      if (this.onTipReceived) this.onTipReceived(data);
    });
    this.socket.on("tip-confirmed", (data) => {
      if (this.onTipConfirmed) this.onTipConfirmed(data);
    });
    this.socket.on("tip-failed", (data) => {
      if (this.onTipFailed) this.onTipFailed(data);
    });

    // Bodyguard killed (server-authoritative)
    this.socket.on("bodyguard-killed", (data) => {
      if (this.onBodyguardKilled) this.onBodyguardKilled(data);
    });

    // Commander ping (relayed by server to faction members)
    this.socket.on("commander-ping", (data) => {
      if (this.onCommanderPing) this.onCommanderPing(data);
    });

    // Commander drawing (relayed by server to faction members)
    this.socket.on("commander-drawing", (data) => {
      if (this.onCommanderDrawing) this.onCommanderDrawing(data);
    });
  }

  // ========================
  // INPUT SENDING
  // ========================

  /**
   * Send current input state to the server.
   * Call this every client frame (or at a throttled rate).
   *
   * @param {Object} keys - { w, a, s, d, shift }
   * @param {number} turretAngle - current turret angle in radians
   * @param {number} dt - frame deltaTime in seconds (stored for reconciliation replay)
   */
  sendInput(keys, turretAngle, dt) {
    if (!this.connected) return;

    this.inputSeq++;

    const input = {
      keys: {
        w: !!keys.w,
        a: !!keys.a,
        s: !!keys.s,
        d: !!keys.d,
        shift: !!keys.shift,
      },
      turretAngle: turretAngle,
      seq: this.inputSeq,
    };

    // Store for client-side prediction reconciliation (every frame)
    this.pendingInputs.push({
      seq: this.inputSeq,
      keys: { ...input.keys },
      turretAngle: turretAngle,
      dt: dt || 1 / 60,
    });

    // Throttle network sends to match server tick rate (20Hz)
    // Each input contains full key state, so server only needs the latest
    const now = performance.now();
    if (now - this._lastInputSendTime >= this._inputSendInterval) {
      this.socket.emit("input", input);
      this._lastInputSendTime = now;
    }

    return this.inputSeq;
  }

  /**
   * Send a fire event to the server (with charge power + turret angle).
   * @param {number} power - Charge power level (0-10)
   * @param {number} turretAngle - Current turret angle at moment of firing
   */
  sendFire(power, turretAngle) {
    if (!this.connected) return;
    this.socket.emit("fire", { power: power || 0, turretAngle: turretAngle });
  }

  /**
   * Send a chat message with mode (faction/lobby/squad).
   * @param {string} text - Message text
   * @param {string} mode - Chat mode: 'faction', 'lobby', or 'squad'
   */
  sendChat(text, mode) {
    if (!this.connected) return;
    this.socket.emit("chat", { text: text, mode: mode || "lobby" });
  }

  /**
   * Send a faction change to the server.
   * @param {string} faction - New faction: 'rust', 'cobalt', or 'viridian'
   */
  sendFactionChange(faction) {
    if (!this.connected) return;
    this.socket.emit("change-faction", { faction });
  }

  /**
   * Send player-chosen name and faction from onboarding screen.
   * @param {string} name - Chosen player name
   * @param {string} faction - Chosen faction: 'rust', 'cobalt', or 'viridian'
   */
  sendIdentity(name, faction) {
    if (!this.connected) return;
    this.socket.emit("set-identity", { name, faction });
  }

  /**
   * Send portal selection to the server.
   * @param {number} portalTileIndex - The tile index of the chosen portal
   */
  sendEnterFastTravel() {
    if (!this.connected) return;
    this.socket.emit("enter-fast-travel");
  }

  sendChoosePortal(portalTileIndex) {
    if (!this.connected) return;
    this.socket.emit("choose-portal", { portalTileIndex });
  }

  /**
   * Send self-damage event to the server (debug K key).
   * @param {number} amount - Damage amount
   */
  sendSelfDamage(amount) {
    if (!this.connected) return;
    this.socket.emit("self-damage", { amount });
  }

  /**
   * Send local player's profile data (badges, crypto) to the server.
   * Called after connect so the server can relay to other clients.
   */
  sendProfile(profileData) {
    if (!this.connected) return;
    this.socket.emit("profile", profileData);
  }

  /**
   * Resign from commander role for a duration (ms).
   */
  sendResign(duration) {
    if (!this.connected) return;
    this.socket.emit("commander-resign", { duration });
  }

  /**
   * Cancel an active commander resignation.
   */
  sendCancelResign() {
    if (!this.connected) return;
    this.socket.emit("commander-cancel-resign");
  }

  /**
   * Request commander override (dev testing — locks for 60s server-side).
   */
  sendCommanderOverride() {
    if (!this.connected) return;
    this.socket.emit("commander-override");
  }

  /**
   * Send a commander ping to the server for relay to faction members.
   * @param {Object} data - { x, y, z } local-space normal direction
   */
  sendCommanderPing(data) {
    if (!this.connected) return;
    this.socket.emit("commander-ping", data);
  }

  /**
   * Send a commander drawing to the server for relay to faction members.
   * @param {Object} data - { points: [[x,y,z], ...] } local-space stroke points
   */
  sendCommanderDrawing(data) {
    if (!this.connected) return;
    this.socket.emit("commander-drawing", data);
  }

  // ========================
  // PING MEASUREMENT
  // ========================

  _startPing() {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      if (this.connected) this.socket.emit("ping-measure", Date.now());
    }, 2000);
  }

  _stopPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  // ========================
  // CLIENT-SIDE PREDICTION
  // ========================

  /**
   * After receiving a server state update, reconcile our predicted position
   * with the server's authoritative position.
   *
   * @param {Object} serverPlayerState - { t, p, h, s, ta, hp, d, seq }
   * @param {Object} localTank - reference to the local Tank instance
   */
  reconcile(serverPlayerState, localTank) {
    if (!serverPlayerState) return;

    const serverSeq = serverPlayerState.seq;

    // Remove all inputs the server has already processed
    this.pendingInputs = this.pendingInputs.filter((i) => i.seq > serverSeq);

    // Save client's predicted position before reconciliation
    const clientTheta = localTank.state.theta;
    const clientPhi = localTank.state.phi;

    // Snap to server state
    localTank.state.theta = serverPlayerState.t;
    localTank.state.phi = serverPlayerState.p;
    localTank.state.heading = serverPlayerState.h;
    localTank.state.speed = serverPlayerState.s;

    // Re-apply unprocessed inputs (client-side prediction replay)
    // Each input stores its original frame deltaTime for accurate replay
    for (const input of this.pendingInputs) {
      const replayDt = input.dt;

      // Temporarily set keys to this input's keys
      const prevKeys = { ...localTank.state.keys };
      localTank.state.keys = input.keys;

      // Save position before move for terrain collision revert
      const prevTheta = localTank.state.theta;
      const prevPhi = localTank.state.phi;

      // Re-run physics for this input using its original frame delta
      SharedPhysics.applyInput(localTank.state, replayDt);
      SharedPhysics.moveOnSphere(
        localTank.state,
        SharedPhysics.PLANET_ROTATION_SPEED,
        replayDt
      );

      // Enforce terrain collision (server doesn't check elevation)
      localTank.checkTerrainCollision(
        prevTheta, prevPhi,
        SharedPhysics.PLANET_ROTATION_SPEED,
        replayDt
      );

      localTank.state.keys = prevKeys;
    }

    // Smooth small corrections: if the reconciled position is close to where
    // the client predicted, blend gradually to avoid micro-jitter from
    // floating-point drift or terrain collision differences.
    let thetaErr = localTank.state.theta - clientTheta;
    const phiErr = localTank.state.phi - clientPhi;
    // Normalize theta error to [-PI, PI]
    while (thetaErr > Math.PI) thetaErr -= Math.PI * 2;
    while (thetaErr < -Math.PI) thetaErr += Math.PI * 2;

    const errMag = Math.abs(thetaErr) + Math.abs(phiErr);
    if (errMag > 0 && errMag < 0.005) {
      // Small drift — apply only 40% of the correction per tick
      // (accumulates over several ticks for full convergence)
      localTank.state.theta = clientTheta + thetaErr * 0.4;
      localTank.state.phi = clientPhi + phiErr * 0.4;
    }
    // Large errors (≥0.005 rad ≈ 2.4 units on r=480): snap immediately (already done)
  }

  // ========================
  // UTILITY
  // ========================

  /**
   * Whether multiplayer mode is active (connected to server).
   */
  get isMultiplayer() {
    return this.connected && this.playerId !== null;
  }

  /**
   * Get the number of connected players (including us).
   */
  get playerCount() {
    return this.remotePlayers.size + (this.connected ? 1 : 0);
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.playerId = null;
    this.remotePlayers.clear();
    this.pendingInputs = [];
  }
}
