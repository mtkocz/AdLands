/**
 * AdLands - MultiplayerClient
 * Integration layer: connects NetworkManager to the existing game systems.
 *
 * This file is loaded AFTER main.js. It hooks into the global references
 * (window.tank, window.scene, etc.) that main.js exposes, and replaces
 * the single-player loop with multiplayer networking.
 *
 * When MULTIPLAYER_ENABLED is true:
 * - Local player input is sent to the server (and predicted locally)
 * - Remote player tanks are spawned/destroyed based on server events
 * - Server state updates drive all tank positions
 * - Fire events are sent to the server and effects played from server events
 */

(function () {
  "use strict";

  // ========================
  // CONFIG
  // ========================

  // Set this to true to enable multiplayer, false for offline single-player
  const MULTIPLAYER_ENABLED = typeof io !== "undefined"; // auto-detect Socket.IO

  if (!MULTIPLAYER_ENABLED) {
    return;
  }

  // Wait for the game to be ready (main.js exposes globals after init)
  const waitForGame = setInterval(() => {
    if (!window._mp || !window._mp.tank || !window._mp.scene) return;
    clearInterval(waitForGame);
    initMultiplayer();
  }, 100);

  function initMultiplayer() {
    const mp = window._mp; // Game references exposed by main.js
    const {
      tank,
      scene,
      sphereRadius,
      planet,
      playerTags,
      cannonSystem,
      treadDust,
      treadTracks,
      tankHeadlights,
      tankCollision,
      tankDamageEffects,
      dustShockwave,
      gameCamera,
      visualEffects,
    } = mp;

    const net = new NetworkManager();
    window.networkManager = net; // Expose for debugging
    mp.net = net; // Expose on _mp so Dashboard can access socket

    // Remote player tank instances: socketId → RemoteTank
    const remoteTanks = new Map();
    window._remoteTanks = remoteTanks; // Expose for CommanderTipSystem 3D raycasting

    // Remote bodyguard instances: bodyguardId → RemoteBodyguard
    const remoteBodyguards = new Map();

    // Helper: compute damage state string from HP values (mirrors Tank._updateDamageState thresholds)
    function computeDamageState(hp, maxHp) {
      if (hp <= 0) return "dead";
      const pct = hp / maxHp;
      if (pct > 0.5) return "healthy";
      if (pct > 0.25) return "damaged";
      return "critical";
    }

    // ========================
    // INPUT SENDING
    // ========================

    // Throttle input sending to ~60 times/sec max (matches frame rate)
    let lastInputTime = 0;
    const INPUT_INTERVAL = 1000 / 60;

    // Track current cluster for territory ring HUD (throttled)
    let lastHUDUpdateTime = 0;
    const HUD_UPDATE_INTERVAL = 250; // 4x/sec
    let lastPlayerClusterId = undefined;

    // Server-authoritative cluster ID for ring display.
    // Set by capture-progress and tic-crypto events. Prevents mismatch between
    // the server's grid-based cluster lookup and the client's nearest-neighbor detection.
    let serverClusterId = undefined;
    mp.onFrameUpdate = (deltaTime, camera, frustum, lodOptions) => {
      if (!net.isMultiplayer) return;

      const now = performance.now();
      if (now - lastInputTime >= INPUT_INTERVAL) {
        lastInputTime = now;

        // Don't send inputs during fast travel (prevents stale prediction buffer)
        if (!(mp.fastTravel && mp.fastTravel.active)) {
          net.sendInput(tank.state.keys, tank.state.turretAngle, deltaTime);
        }
      }

      // Update all remote tanks (interpolation + LOD + death fade)
      for (const [id, remoteTank] of remoteTanks) {
        remoteTank.update(deltaTime);
        remoteTank.updateFade();
        if (camera) {
          remoteTank.updateLOD(camera, frustum, lodOptions);
        }
      }

      // Update all remote bodyguards (interpolation + death fade)
      for (const [id, bg] of remoteBodyguards) {
        bg.update(deltaTime);
        bg.updateFade();
      }

      // Update territory ring HUD (throttled — server data only changes at tick rate)
      // Only show ring when player is alive and on the planet surface (not in fast travel, orbital, or dead)
      const hasSpawned = mp.getHasSpawnedIn?.();
      const onSurface = hasSpawned && !tank.isDead && !(mp.fastTravel && mp.fastTravel.active);
      if (now - lastHUDUpdateTime >= HUD_UPDATE_INTERVAL && hasSpawned) {
        lastHUDUpdateTime = now;
        // Use server-authoritative cluster when available (prevents grid vs nearest-neighbor mismatch)
        const clusterId = serverClusterId !== undefined ? serverClusterId : tank.getCurrentClusterId(planet);

        if (clusterId !== undefined && onSurface) {
          const state = planet.clusterCaptureState.get(clusterId);
          if (state) {
            // Build tank counts for this cluster (local player + remote tanks)
            const counts = { rust: 0, cobalt: 0, viridian: 0 };
            counts[tank.faction]++;
            for (const [, rt] of remoteTanks) {
              if (!rt.isDead && rt.faction && rt.group) {
                const rtCluster = planet.getClusterIdAtPosition(rt.group.position);
                if (rtCluster === clusterId) counts[rt.faction]++;
              }
            }
            mp.updateTugOfWarUI?.(clusterId, state, counts);
            mp.setTerritoryRingVisible?.(true);
          }
        } else {
          if (lastPlayerClusterId !== undefined) {
            mp.clearTugOfWarUI?.();
            mp.setTerritoryRingVisible?.(false);
          }
        }
        lastPlayerClusterId = clusterId;
      }
    };

    // Hook into fire events — also notify server (with charge power + turret angle)
    mp.onFire = (power, turretAngle) => {
      if (net.isMultiplayer) {
        net.sendFire(power, turretAngle);
      }
    };

    // ========================
    // SERVER EVENT HANDLERS
    // ========================

    net.onConnected = (data) => {
      // Mark environment as multiplayer (server syncs celestial positions)
      if (mp.environment) mp.environment.isMultiplayer = true;

      // Update local player with server-assigned identity
      mp.setPlayerFaction(data.you.faction);
      mp.setPlayerName(data.you.name);

      // Enable server-authoritative mode (disables local physics in Tank.update)
      tank.multiplayerMode = true;

      // Sync planet rotation from server
      if (data.planetRotation !== undefined && mp.setPlanetRotation) {
        mp.setPlanetRotation(data.planetRotation);
      }

      // Apply server-authoritative world data (clusters, terrain, portals)
      if (data.world && planet) {
        planet.applyServerWorld(data.world);

        // Preload sponsor textures (baked to ~1-3KB each, fast even on slow connections)
        if (data.world.sponsors && data.world.sponsors.length > 0) {
          if (mp.setSponsorLoadProgress) mp.setSponsorLoadProgress(0);
          planet.preloadSponsorTextures(data.world.sponsors, (p) => {
            if (mp.setSponsorLoadProgress) mp.setSponsorLoadProgress(p * 0.9);
          }).then(() => {
            planet.applySponsorVisuals(data.world.sponsors);
            planet.deElevateSponsorTiles();
            planet.mergeClusterTiles();
            mp.setSponsorTexturesReady();
          });
        } else {
          planet.mergeClusterTiles();
          mp.setSponsorTexturesReady();
        }

        // Apply moon sponsor textures
        if (data.world.moonSponsors && mp.environment) {
          data.world.moonSponsors.forEach((sponsor, i) => {
            mp.environment.applyMoonSponsor(i, sponsor);
          });
        }

        // Apply billboard sponsor textures
        if (data.world.billboardSponsors && mp.environment) {
          data.world.billboardSponsors.forEach((sponsor, i) => {
            mp.environment.applyBillboardSponsor(i, sponsor);
          });
        }
      } else {
        mp.setSponsorTexturesReady();
      }

      // Apply server-authoritative territory capture state (ownership + tics)
      if (data.captureState && planet) {
        for (const [clusterId, state] of Object.entries(data.captureState)) {
          planet.applyTerritoryState(Number(clusterId), state.owner, state.tics);
        }
        planet.updateDirtyFactionOutlines?.();
      }

      // Handle reconnection: restore position if player was alive on the surface
      if (data.you.reconnected && !data.you.waitingForPortal) {
        // Clear stale prediction inputs accumulated during disconnect
        net.pendingInputs = [];

        tank.teleportTo(data.you.theta, data.you.phi);
        tank.state.heading = data.you.heading;

        // Exit fast travel UI if it was active, otherwise directly show the tank
        if (mp.fastTravel && mp.fastTravel.active) {
          mp.fastTravel._exitFastTravel();
        } else {
          tank.setVisible(true);
          tank.setControlsEnabled(true);
          if (mp.setSpawnedIn) mp.setSpawnedIn();
        }
      }
      // Fallback: if server says we need to choose a portal but fast travel
      // UI isn't showing (mid-game reconnect that fell through to addPlayer),
      // enter fast travel so the player isn't stuck with ignored inputs.
      // Only for reconnections — fresh players go through auth → startPortalSelection().
      if (data.you.reconnected && data.you.waitingForPortal && mp.fastTravel && !mp.fastTravel.active) {
        net.pendingInputs = [];
        tank.setVisible(false);
        tank.setControlsEnabled(false);
        mp.fastTravel.startRespawn();
      }

      // Apply server-authoritative celestial body configs
      if (data.celestial && mp.applyCelestialConfig) {
        mp.applyCelestialConfig(data.celestial);
      }

      // Send our profile data (badges, totalCrypto, title, avatar) to the server
      net.sendProfile({
        badges: window.badgeSystem?.getUnlockedBadges()?.map((b) => b.id) || [],
        totalCrypto: window.cryptoSystem?.stats?.totalCrypto || 0,
        title: window.titleSystem?.getTitle?.() || "Contractor",
        avatarColor: window.avatarColor || null,
      });

      // Seed ProfileCard crypto state from welcome data (before first broadcast)
      if (window.profileCard) {
        for (const [id, playerState] of Object.entries(data.players)) {
          if (playerState.crypto !== undefined) {
            window.profileCard.latestCryptoState[id] = playerState.crypto;
          }
        }
      }

      // Spawn existing HUMAN players that are NOT waiting for portal
      // Bots are lazily spawned from state updates (spatial-filtered, ~60 nearby)
      for (const [id, playerState] of Object.entries(data.players)) {
        if (id === net.playerId) continue; // Skip ourselves
        if (id.startsWith("bot-")) continue; // Bots created lazily from state updates
        if (playerState.waitingForPortal) continue; // Don't spawn waiting players
        spawnRemoteTank(playerState);
      }

      // Apply server-authoritative commander state
      if (data.commanders && window.commanderSystem) {
        window.commanderSystem.setMultiplayerMode(true);
        // Bridge the local "player" ID with the server socket ID so
        // isCommander / applyServerCommander resolve correctly.
        window.commanderSystem.setHumanMultiplayerId(net.playerId);
        for (const [faction, cmdrData] of Object.entries(data.commanders)) {
          window.commanderSystem.applyServerCommander(
            faction,
            cmdrData ? { id: cmdrData.id, name: cmdrData.name } : null,
            cmdrData?.isActing || false,
            cmdrData?.trueCommanderName || null,
          );
        }
      }

      // Spawn existing bodyguards from welcome packet
      if (data.bodyguards) {
        for (const [bgId, bgData] of Object.entries(data.bodyguards)) {
          if (!bgData.isDead) {
            spawnRemoteBodyguard(bgData);
          }
        }
      }
    };

    net.onPlayerJoined = (data) => {
      if (data.waitingForPortal) return; // Don't spawn until they choose a portal
      spawnRemoteTank(data);
    };

    net.onPlayerLeft = (playerId) => {
      despawnRemoteTank(playerId);
    };

    net.onStateUpdate = (data) => {
      // Store server-authoritative population counts on _mpState (read by main.js)
      const mpState = window._mpState;
      if (mpState) {
        if (data.tc !== undefined) mpState.serverTotalCount = data.tc;
        if (data.bfc) mpState.serverBotFactionCounts = data.bfc;
        if (data.op) mpState.orbitalPositions = data.op;
        if (data.opn) mpState.orbitalPositionNames = data.opn;
      }

      // Track which bots were seen this tick (for cleanup)
      if (!mp._seenBotIds) mp._seenBotIds = new Set();
      mp._seenBotIds.clear();

      // Update all remote tanks with their new target states
      for (const [id, state] of Object.entries(data.players)) {
        if (id === net.playerId) {
          // Skip reconciliation while in fast travel (we haven't deployed yet)
          if (mp.fastTravel && mp.fastTravel.active) continue;

          if (tank.isDead) {
            // Dead: snap to server position directly (no reconcile replay —
            // replay would double-apply planet rotation counter)
            tank.state.theta = state.t;
            tank.state.phi = state.p;
          } else {
            // Alive: full reconcile with input replay
            net.reconcile(state, tank);
          }
          // Sync faction if server disagrees (server-authoritative)
          if (state.f && state.f !== tank.faction) {
            mp.setPlayerFaction(state.f);
          }
          // Sync server-authoritative rank
          if (state.r !== undefined && state.r !== window.playerRank) {
            window.playerRank = state.r;
            window.playerRankTotal = state.rt || 0;
            playerTags.updateRank?.("player", state.r);
            if (window.dashboard) {
              window.dashboard.updateProfile({ rank: state.r, rankTotal: state.rt || 0 });
            }
          }
          continue;
        }

        // Skip waiting players (d === 2)
        if (state.d === 2) continue;

        // Track seen bots for cleanup
        if (id.startsWith("bot-")) mp._seenBotIds.add(id);

        // Lazy-spawn bots that entered the spatial filter radius
        let remoteTank = remoteTanks.get(id);
        if (!remoteTank && id.startsWith("bot-") && state.d !== 1) {
          spawnRemoteTank({
            id, name: state.n || id.slice(4),
            faction: state.f, theta: state.t, phi: state.p,
            heading: state.h, speed: state.s, hp: state.hp || 100, maxHp: 100,
            isBot: true,
          });
          remoteTank = remoteTanks.get(id);
        }
        if (remoteTank) {
          // Handle death/alive state transitions from server ticks
          if (state.d === 1 && !remoteTank.isDead) {
            // Transition to dead (catches missed player-killed events)
            remoteTank.die();
            tankDamageEffects.setDamageState(id, remoteTank.group, "dead");
            playerTags.fadeOutTag?.(id);
            // Explosion + shockwave
            const worldPos = new THREE.Vector3();
            remoteTank.group.getWorldPosition(worldPos);
            cannonSystem._spawnExplosion?.(worldPos, remoteTank.faction, 1.5);
            dustShockwave?.emit(worldPos, 1.5);
            cannonSystem.spawnOilPuddle?.(worldPos);
            // Wire fade callbacks
            const deadId = id;
            remoteTank.onSmokeFadeUpdate = (rt, opacity) => {
              tankDamageEffects.setOpacity(deadId, opacity);
            };
            remoteTank.onFadeComplete = (rt) => {
              tankDamageEffects.removeTank(deadId);
              rt.group.visible = false;
            };
          } else if (state.d === 0 && remoteTank.isDead) {
            // Transition back to alive (catches missed player-activated events)
            remoteTank.revive();
            tankDamageEffects.setDamageState(id, remoteTank.group, "healthy");
            // Recreate tag (createTag handles removing any existing/fading tag)
            playerTags.createTag?.(id, remoteTank, {
              name: remoteTank.playerName || "Unknown",
              level: 1, rank: remoteTank.rank || 0,
              avatar: null, avatarColor: remoteTank.avatarColor || null, squad: null,
              faction: remoteTank.faction,
              title: window.profileCard?.playerCache?.get(id)?.title || "Contractor",
              hp: state.hp || 100, maxHp: 100,
            });
          } else if (state.d === 0 && !remoteTank.isDead && state.hp !== undefined) {
            // Alive — sync damage state from HP (catches gradual damage via state ticks)
            const newState = computeDamageState(state.hp, remoteTank.maxHp);
            if (newState !== remoteTank.damageState) {
              remoteTank.damageState = newState;
              tankDamageEffects.setDamageState(id, remoteTank.group, newState);
            }
            // Sync HP bar from authoritative state ticks (not just discrete player-hit events)
            if (state.hp !== remoteTank.hp) {
              playerTags.updateHP?.(id, state.hp, remoteTank.maxHp);
            }
          }

          remoteTank.setTargetState(state);

          // Adaptive interpolation delay based on server tick rate + ping/jitter.
          // Must be at least 2 server ticks behind for smooth snapshot interpolation.
          if (remoteTank._snapBuf) {
            const tickMs = 1000 / (net.serverTickRate || 10);
            const halfRtt = net.smoothPing / 2;
            const minDelay = tickMs * 2; // Need 2 ticks of buffer minimum
            const adaptiveDelay = Math.max(minDelay, Math.min(400, halfRtt + net.jitter * 2 + tickMs * 1.5));
            // Slow blend (5%) to prevent oscillation
            remoteTank.interpolationDelay = remoteTank.interpolationDelay * 0.95 + adaptiveDelay * 0.05;
          }

          // Sync server-authoritative rank
          if (state.r !== undefined && state.r !== remoteTank.rank) {
            remoteTank.rank = state.r;
            playerTags.updateRank?.(id, state.r);
            if (window.profileCard) {
              window.profileCard.updatePlayer(id, { rank: state.r });
            }
          }
          // Sync faction from state tick (catches missed player-faction-changed events)
          if (state.f && state.f !== remoteTank.faction) {
            remoteTank.setFaction(state.f);
            playerTags.updateFaction?.(id, state.f);
            tankHeadlights.updateFaction?.(id, state.f);
          }
        }
      }

      // Cleanup bots that left the spatial filter — grace period prevents
      // premature despawn from a single dropped packet or boundary flicker.
      if (!mp._botMissCounts) mp._botMissCounts = new Map();
      for (const [id] of remoteTanks) {
        if (id.startsWith("bot-")) {
          if (!mp._seenBotIds.has(id)) {
            const misses = (mp._botMissCounts.get(id) || 0) + 1;
            mp._botMissCounts.set(id, misses);
            if (misses >= 10) { // 10 ticks (~1s) grace period
              despawnRemoteTank(id);
              mp._botMissCounts.delete(id);
            }
          } else {
            mp._botMissCounts.delete(id);
          }
        }
      }

      // Process bodyguard states from server
      if (data.bg) {
        const activeBgIds = new Set(Object.keys(data.bg));

        for (const [bgId, bgState] of Object.entries(data.bg)) {
          let bg = remoteBodyguards.get(bgId);

          if (!bg && bgState.d === 0) {
            // New bodyguard appeared — spawn it
            bg = spawnRemoteBodyguard({
              id: bgId,
              f: bgState.f,
              t: bgState.t,
              p: bgState.p,
              h: bgState.h,
              s: bgState.s,
              hp: bgState.hp,
            });
            // Dust shockwave on spawn (compute position from theta/phi — group isn't positioned yet)
            if (bg) {
              const t = bgState.t, p = bgState.p;
              const worldPos = new THREE.Vector3(
                sphereRadius * Math.sin(p) * Math.cos(t),
                sphereRadius * Math.cos(p),
                sphereRadius * Math.sin(p) * Math.sin(t)
              );
              dustShockwave?.emit(worldPos, 1.5);
            }
          }

          if (!bg) continue;

          // Sync faction change: if server changed this bodyguard's faction
          // (e.g. commander switched factions), despawn old and spawn new
          if (!bg.isDead && bgState.f && bgState.f !== bg.faction) {
            despawnRemoteBodyguard(bgId);
            bg = spawnRemoteBodyguard({
              id: bgId,
              f: bgState.f,
              t: bgState.t,
              p: bgState.p,
              h: bgState.h,
              s: bgState.s,
              hp: bgState.hp,
            });
            if (!bg) continue;
          }

          // Handle resurrection: server respawned with same ID — remove dead one and recreate
          if (bg.isDead && bgState.d === 0) {
            despawnRemoteBodyguard(bgId);
            bg = spawnRemoteBodyguard({
              id: bgId,
              f: bgState.f,
              t: bgState.t,
              p: bgState.p,
              h: bgState.h,
              s: bgState.s,
              hp: bgState.hp,
            });
            if (!bg) continue;
            // Dust shockwave on respawn (compute position from theta/phi)
            const t = bgState.t, p = bgState.p;
            const worldPos = new THREE.Vector3(
              sphereRadius * Math.sin(p) * Math.cos(t),
              sphereRadius * Math.cos(p),
              sphereRadius * Math.sin(p) * Math.sin(t)
            );
            dustShockwave?.emit(worldPos, 1.5);
          }

          // Handle death transition
          if (bgState.d === 1 && !bg.isDead) {
            bg.die();
            tankDamageEffects.setDamageState(bgId, bg.group, "dead");
            playerTags.fadeOutTag?.(bgId);
            // Explosion + shockwave
            const worldPos = new THREE.Vector3();
            bg.group.getWorldPosition(worldPos);
            cannonSystem._spawnExplosion?.(worldPos, bg.faction, 1.5);
            dustShockwave?.emit(worldPos, 1.5);
            cannonSystem.spawnOilPuddle?.(worldPos);
            // Wire fade callbacks
            const deadBgId = bgId;
            bg.onSmokeFadeUpdate = (rt, opacity) => {
              tankDamageEffects.setOpacity(deadBgId, opacity);
            };
            bg.onFadeComplete = (rt) => {
              tankDamageEffects.removeTank(deadBgId);
              rt.group.visible = false;
              // Clean up from Map so it doesn't leak
              despawnRemoteBodyguard(deadBgId);
            };
          } else if (bgState.d === 0 && !bg.isDead) {
            // Alive — sync damage state from HP
            const newState = computeDamageState(bgState.hp, bg.maxHp);
            if (newState !== bg.damageState) {
              bg.damageState = newState;
              tankDamageEffects.setDamageState(bgId, bg.group, newState);
            }
            if (bgState.hp !== bg.hp) {
              bg.hp = bgState.hp;
              playerTags.updateHP?.(bgId, bgState.hp, bg.maxHp);
            }
          }

          if (bgState.d === 0) {
            bg.setTargetState(bgState);
          }
        }

        // Remove bodyguards no longer in server state (and not currently fading)
        for (const [bgId, bg] of remoteBodyguards) {
          if (!activeBgIds.has(bgId) && !bg.isDead) {
            despawnRemoteBodyguard(bgId);
          }
        }
      }

      // Sync planet rotation — soft correction to avoid visual snapping
      if (data.pr !== undefined && mp.setPlanetRotation && mp.getPlanetRotation) {
        const clientPR = mp.getPlanetRotation();
        let drift = data.pr - clientPR;
        // Normalize drift to [-PI, PI]
        while (drift > Math.PI) drift -= Math.PI * 2;
        while (drift < -Math.PI) drift += Math.PI * 2;

        if (Math.abs(drift) > 0.01) {
          // Significant drift — snap to server value
          mp.setPlanetRotation(data.pr);
        } else if (Math.abs(drift) > 0.001) {
          // Minor drift — soft correct (lerp 20% toward server)
          mp.setPlanetRotation(clientPR + drift * 0.2);
        }
      }

      // Sync moon orbital angles (client advances locally; server corrects drift)
      if (data.ma && mp.environment) {
        const moons = mp.environment.moons;
        data.ma.forEach((serverAngle, i) => {
          if (i >= moons.length) return;
          const moon = moons[i];
          let drift = serverAngle - moon.userData.angle;
          while (drift > Math.PI) drift -= Math.PI * 2;
          while (drift < -Math.PI) drift += Math.PI * 2;
          if (Math.abs(drift) > 0.5) {
            moon.userData.angle = serverAngle;
          } else if (Math.abs(drift) > 0.0001) {
            moon.userData.angle += drift * 0.1;
          }
        });
      }

      // Sync space station orbital angles, rotation, and orbital plane
      // Client advances locally; server corrects drift smoothly
      if (data.sa && mp.environment) {
        const stations = mp.environment.spaceStations;
        data.sa.forEach((arr, i) => {
          if (i >= stations.length) return;
          const s = stations[i];

          let orbDrift = arr[0] - s.userData.orbitalAngle;
          while (orbDrift > Math.PI) orbDrift -= Math.PI * 2;
          while (orbDrift < -Math.PI) orbDrift += Math.PI * 2;
          if (Math.abs(orbDrift) > 0.5) {
            s.userData.orbitalAngle = arr[0];
          } else if (Math.abs(orbDrift) > 0.0001) {
            s.userData.orbitalAngle += orbDrift * 0.1;
          }

          let rotDrift = arr[1] - s.userData.localRotation;
          while (rotDrift > Math.PI) rotDrift -= Math.PI * 2;
          while (rotDrift < -Math.PI) rotDrift += Math.PI * 2;
          if (Math.abs(rotDrift) > 0.5) {
            s.userData.localRotation = arr[1];
          } else if (Math.abs(rotDrift) > 0.0001) {
            s.userData.localRotation += rotDrift * 0.1;
          }

          // Orbital plane params (sent every ~5s to handle late joins / missed welcome)
          if (arr.length >= 5) {
            s.userData.inclination = arr[2];
            s.userData.ascendingNode = arr[3];
            s.userData.orbitRadius = arr[4];
          }
        });
      }

      // Sync billboard orbital angles and params
      if (data.ba && mp.environment) {
        const billboards = mp.environment.billboards;
        data.ba.forEach((arr, i) => {
          if (i >= billboards.length) return;
          const b = billboards[i];

          let orbDrift = arr[0] - b.userData.orbitalAngle;
          while (orbDrift > Math.PI) orbDrift -= Math.PI * 2;
          while (orbDrift < -Math.PI) orbDrift += Math.PI * 2;
          if (Math.abs(orbDrift) > 0.5) {
            b.userData.orbitalAngle = arr[0];
          } else if (Math.abs(orbDrift) > 0.0001) {
            b.userData.orbitalAngle += orbDrift * 0.1;
          }

          // Full orbital params (sent every ~5s)
          if (arr.length >= 4) {
            b.userData.inclination = arr[1];
            b.userData.ascendingNode = arr[2];
            b.userData.orbitRadius = arr[3];
          }
          // Wobble and speed (sent with full orbital params every ~5s)
          if (arr.length >= 8) {
            b.userData.wobbleX = arr[4];
            b.userData.wobbleY = arr[5];
            b.userData.wobbleZ = arr[6];
            b.userData.speed = arr[7];
          }
        });
      }
    };

    net.onPlayerFired = (data) => {
      if (data.id === net.playerId) return; // We already played our own effects

      const remoteTank = remoteTanks.get(data.id);
      if (remoteTank) {
        // Trigger muzzle flash and recoil on the remote tank
        if (remoteTank.barrelMesh) {
          // Simple recoil
          const baseZ = remoteTank.barrelBaseZ || 0;
          remoteTank.barrelMesh.position.z = baseZ + 0.8;
          setTimeout(() => {
            if (remoteTank.barrelMesh) {
              remoteTank.barrelMesh.position.z = baseZ;
            }
          }, 150);
        }

        // Spawn projectile visually using cannon system
        // (Server handles hit detection; client just shows the visual)
        cannonSystem.spawnRemoteProjectile?.(
          { theta: data.theta, phi: data.phi, turretAngle: data.turretAngle, power: data.power },
          remoteTank
        );
      }
    };

    // Preallocated vectors for hit effects and ping positions
    const _hitWorldPos = new THREE.Vector3();
    const _pingWorldPos = new THREE.Vector3();

    net.onPlayerHit = (data) => {
      // Handle bodyguard hits
      if (data.targetId.startsWith("bg-")) {
        const bg = remoteBodyguards.get(data.targetId);
        if (bg && !bg.isDead) {
          bg.hp = data.hp;
          playerTags.updateHP?.(data.targetId, data.hp, bg.maxHp);
          const newState = computeDamageState(data.hp, bg.maxHp);
          if (newState !== bg.damageState) {
            bg.damageState = newState;
            tankDamageEffects.setDamageState(data.targetId, bg.group, newState);
          }
          // Visual hit effect
          if (bg.group) {
            bg.group.getWorldPosition(_hitWorldPos);
            const weAreAttacker = data.attackerId === net.playerId;
            const explosionFaction = weAreAttacker ? tank.faction : bg.faction;
            cannonSystem._spawnExplosion?.(_hitWorldPos, explosionFaction, 0.6);
            dustShockwave?.emit(_hitWorldPos, 0.4);
            // White flash
            const meshesToFlash = [];
            bg.group.traverse((child) => {
              if (child.isMesh && child.material && child.material.color && child !== bg.hitbox) {
                if (child.userData._hitFlashOrigColor === undefined) {
                  child.userData._hitFlashOrigColor = child.material.color.getHex();
                }
                meshesToFlash.push(child);
              }
            });
            for (const child of meshesToFlash) {
              child.material.color.setHex(0xffffff);
              clearTimeout(child.userData._hitFlashTimer);
              child.userData._hitFlashTimer = setTimeout(() => {
                if (child.material && child.userData._hitFlashOrigColor !== undefined) {
                  child.material.color.setHex(child.userData._hitFlashOrigColor);
                  delete child.userData._hitFlashOrigColor;
                  delete child.userData._hitFlashTimer;
                }
              }, 150);
            }
          }
        }
        return;
      }

      if (data.targetId === net.playerId) {
        // WE got hit — update local HP and play damage effects
        tank.hp = data.hp;
        if (tank.onDamage) {
          tank.onDamage(data.hp, tank.maxHp, data.damage);
        }
        // Sync damage state (smoke/fire particle effects)
        const newState = computeDamageState(data.hp, tank.maxHp);
        if (newState !== tank.damageState) {
          tank.damageState = newState;
          if (tank.onDamageStateChange) {
            tank.onDamageStateChange(newState);
          }
        }
      } else {
        // Someone else got hit — update their HP display and damage effects
        const remoteTank = remoteTanks.get(data.targetId);
        if (remoteTank) {
          remoteTank.hp = data.hp;
          playerTags.updateHP?.(data.targetId, data.hp, remoteTank.maxHp);
          // Sync damage state (smoke/fire particle effects)
          const newState = computeDamageState(data.hp, remoteTank.maxHp);
          if (newState !== remoteTank.damageState) {
            remoteTank.damageState = newState;
            tankDamageEffects.setDamageState(data.targetId, remoteTank.group, newState);
          }

          // Server-confirmed hit: award damage crypto and track stats when we're the attacker
          const weAreAttacker = data.attackerId === net.playerId;
          if (weAreAttacker) {
            const damage = data.damage || 25;

            // Award damage crypto (check commander bonus)
            if (cannonSystem.cryptoSystem) {
              let isCommander = false;
              if (window.commanderSystem) {
                const commanders = window.commanderSystem.getAllCommanders();
                for (const faction in commanders) {
                  if (commanders[faction]?.tankRef === remoteTank) {
                    isCommander = true;
                    break;
                  }
                }
              }
              const cryptoMultiplier = isCommander ? 10 : 1;
              cannonSystem.cryptoSystem.stats.damageDealt += damage;
              const damageCrypto = Math.floor(
                damage * cannonSystem.cryptoSystem.cryptoValues.damageDealt * cryptoMultiplier,
              );
              // Show floating crypto at the damaged tank's position
              const victimPos = new THREE.Vector3();
              if (remoteTank.group) {
                remoteTank.group.getWorldPosition(victimPos);
              }
              cannonSystem.cryptoSystem.awardCrypto(
                damageCrypto,
                isCommander ? "commander damage" : "damage",
                victimPos,
              );
            }

            // Track hit for title system (accuracy tracking)
            if (cannonSystem.titleSystem) {
              cannonSystem.titleSystem.trackDamage(damage);
              cannonSystem.titleSystem.trackShots(0, 1); // 0 fired, 1 hit
            }
          }

          // Visual hit confirmation: explosion + flash at target position
          if (remoteTank.group) {
            remoteTank.group.getWorldPosition(_hitWorldPos);
            // Skip explosion for self-damage (no projectile was fired)
            const isSelfDamage = data.attackerId === data.targetId;
            if (!isSelfDamage) {
              // Use attacker's faction color for explosion when we fired the shot
              const explosionFaction = weAreAttacker ? tank.faction : remoteTank.faction;
              cannonSystem._spawnExplosion?.(_hitWorldPos, explosionFaction, 0.6);
              dustShockwave?.emit(_hitWorldPos, 0.4);
            }

            // Brief white flash on the hit tank (150ms)
            // Two-pass approach: save all original colors BEFORE mutating any,
            // because multiple meshes can share the same material instance.
            const meshesToFlash = [];
            remoteTank.group.traverse((child) => {
              if (child.isMesh && child.material && child.material.color && child !== remoteTank.hitbox) {
                if (child.userData._hitFlashOrigColor === undefined) {
                  child.userData._hitFlashOrigColor = child.material.color.getHex();
                }
                meshesToFlash.push(child);
              }
            });
            for (const child of meshesToFlash) {
              child.material.color.setHex(0xffffff);
              clearTimeout(child.userData._hitFlashTimer);
              child.userData._hitFlashTimer = setTimeout(() => {
                if (child.material && child.userData._hitFlashOrigColor !== undefined) {
                  child.material.color.setHex(child.userData._hitFlashOrigColor);
                  delete child.userData._hitFlashOrigColor;
                  delete child.userData._hitFlashTimer;
                }
              }, 150);
            }
          }
        }

      }
    };

    net.onPlayerKilled = (data) => {
      if (data.victimId === net.playerId) {
        // WE died — use _die() so damage state, charred material, and fade all trigger
        tank.hp = 0;
        // Clear prediction buffer (dead players don't process inputs on server)
        net.pendingInputs = [];
        if (tank._die) {
          tank._die(data.killerFaction);
        } else {
          // Fallback if _die is not accessible
          tank.isDead = true;
          tank.state.isDead = true;
          tank.damageState = "dead";
          if (tank.onDamageStateChange) {
            tank.onDamageStateChange("dead");
          }
          if (tank.onDeath) {
            tank.onDeath(tank, data.killerFaction);
          }
        }
      } else {
        // Someone else died — full death sequence (explosion, charred, smoke, fade, sink)
        const remoteTank = remoteTanks.get(data.victimId);
        if (remoteTank) {
          // Trigger death sequence on RemoteTank (charred material + fade timer)
          remoteTank.die();
          tankDamageEffects.setDamageState(data.victimId, remoteTank.group, "dead");
          playerTags.fadeOutTag?.(data.victimId);

          // Spawn explosion + shockwave at death position (reuses preallocated _hitWorldPos)
          remoteTank.group.getWorldPosition(_hitWorldPos);
          cannonSystem._spawnExplosion?.(_hitWorldPos, remoteTank.faction, 1.5);
          dustShockwave?.emit(_hitWorldPos, 1.5);
          cannonSystem.spawnOilPuddle?.(_hitWorldPos);

          // Award kill crypto immediately when we're the killer
          const weAreKiller = data.killerId === net.playerId;
          const isSelfKill = data.killerId === data.victimId;
          if (weAreKiller && !isSelfKill && cannonSystem.cryptoSystem) {
            let isCommander = false;
            if (window.commanderSystem) {
              const commanders = window.commanderSystem.getAllCommanders();
              for (const faction in commanders) {
                if (commanders[faction]?.tankRef === remoteTank) {
                  isCommander = true;
                  break;
                }
              }
            }
            const cryptoMultiplier = isCommander ? 10 : 1;
            cannonSystem.cryptoSystem.stats.kills++;
            const killCrypto = cannonSystem.cryptoSystem.cryptoValues.killBonus * cryptoMultiplier;
            cannonSystem.cryptoSystem.awardCrypto(
              killCrypto,
              isCommander ? "commander kill" : "kill",
              _hitWorldPos.clone(),
            );
          }

          // Wire fade callbacks for this death
          const victimId = data.victimId;
          remoteTank.onSmokeFadeUpdate = (rt, opacity) => {
            tankDamageEffects.setOpacity(victimId, opacity);
          };
          remoteTank.onFadeComplete = (rt) => {
            tankDamageEffects.removeTank(victimId);
            rt.group.visible = false;
          };
        }

      }
    };

    // Portal rejected: server denied our portal choice — re-show preview UI
    net.onPortalRejected = () => {
      console.warn('[MP] portal-rejected received — re-showing preview UI');
      if (mp.fastTravel?._portalTimeout) {
        clearTimeout(mp.fastTravel._portalTimeout);
        mp.fastTravel._portalTimeout = null;
      }
      if (mp.fastTravel && mp.fastTravel.state === 'preview') {
        mp.fastTravel._showPreviewUI();
      }
    };

    // Portal confirmed: server accepted our portal choice — teleport and exit fast travel
    net.onPortalConfirmed = (data) => {
      console.log('[MP] portal-confirmed received:', data);
      if (mp.fastTravel?._portalTimeout) {
        clearTimeout(mp.fastTravel._portalTimeout);
        mp.fastTravel._portalTimeout = null;
      }
      // Clear stale prediction inputs accumulated during fast travel
      net.pendingInputs = [];

      tank.teleportTo(data.theta, data.phi);
      tank.state.heading = data.heading;

      // Exit fast travel (shows tank, swoops camera down, enables controls)
      if (mp.fastTravel && mp.fastTravel.active) {
        mp.fastTravel._exitFastTravel();
      } else {
        tank.setVisible(true);
        tank.setControlsEnabled(true);
        if (mp.setSpawnedIn) mp.setSpawnedIn();
      }

      // Show red spend floater for portal cost (fast travel / respawn)
      // Delayed so the camera has time to swoop from orbital to surface view
      if (data.cost > 0 && window.cryptoVisuals && tank.group) {
        const portalCost = data.cost;
        setTimeout(() => {
          if (tank.group) {
            tank.group.getWorldPosition(_tipScreenPos);
            window.cryptoVisuals._spawnFloatingNumber(-portalCost, _tipScreenPos);
          }
        }, 1500);
      }
    };

    // Respawn: server tells us to pick a portal after death
    net.onRespawnChoosePortal = () => {

      // Abort the signal lost terminal sequence (started by tank.onDeath in main.js).
      // onRespawn() clears all signal-loss timeouts, hides the overlay, and resets
      // damage shader uniforms. Without this, the terminal's _hideUIElements() sets
      // inline display:none on fast-travel-ui, which overrides the class-based
      // visibility toggling in FastTravel._showFastTravelUI().
      if (visualEffects) {
        visualEffects.onRespawn();
        // Prevent the signal lost completion callback from calling startRespawn()
        // a second time (the if(this.active) guard would skip it, but cleaner to
        // null it out so no stale callback fires after we've already entered fast travel).
        visualEffects.onSignalLostComplete = null;
      }

      // Resume crypto counter (was frozen during terminal)
      if (window.dashboard) window.dashboard.resumeCrypto();

      // Do NOT reset the tank here — keep isDead=true during portal selection.
      // The tank only resets when the player clicks "Deploy Here!" in
      // FastTravel._exitFastTravel(), which calls tank.resetForRespawn().

      // Enter fast travel respawn mode (portal selection screen)
      if (mp.fastTravel) {
        mp.fastTravel.startRespawn();
      }
    };

    // A waiting player picked their portal and is now active
    net.onPlayerActivated = (data) => {
      if (window.profileCard && data.crypto !== undefined) {
        window.profileCard.latestCryptoState[data.id] = data.crypto;
      }
      spawnRemoteTank(data);
    };

    net.onChatMessage = (data) => {
      if (data.id === net.playerId) return; // Skip own messages (already shown locally)
      if (mp.proximityChat) {
        mp.proximityChat.addMessage(data.id, data.text, data.mode || "lobby");
      }
    };

    // A player changed their faction
    net.onPlayerFactionChanged = (data) => {
      if (data.id === net.playerId) return; // We already updated locally

      const remoteTank = remoteTanks.get(data.id);
      if (remoteTank) {
        remoteTank.setFaction(data.faction);
        playerTags.updateFaction?.(data.id, data.faction);
        tankHeadlights.updateFaction?.(data.id, data.faction);
      }
      // Keep CommanderSystem in sync (for tip system faction validation)
      if (window.commanderSystem) {
        window.commanderSystem.updatePlayerFaction?.(data.id, data.faction);
      }
    };

    // Player identity updated (from onboarding screen — name and/or faction changed)
    net.onPlayerIdentityUpdated = (data) => {
      if (data.id === net.playerId) {
        // Server confirmed our identity — update local display with sanitized name
        mp.setPlayerName(data.name);
        mp.setPlayerFaction(data.faction);
        return;
      }

      const remoteTank = remoteTanks.get(data.id);
      if (remoteTank) {
        remoteTank.setFaction(data.faction);
        playerTags.updateName?.(data.id, data.name);
        playerTags.updateFaction?.(data.id, data.faction);
        tankHeadlights.updateFaction?.(data.id, data.faction);
      }
      if (window.commanderSystem) {
        window.commanderSystem.updatePlayerFaction?.(data.id, data.faction);
      }
    };

    // A player switched their active profile mid-game
    net.onPlayerProfileSwitched = (data) => {
      if (data.id === net.playerId) {
        // Server confirmed our profile switch — set authoritative crypto
        if (window.dashboard) {
          window.dashboard.updateCrypto(data.totalCrypto || 0);
        }
        if (window.profileCard) {
          window.profileCard.latestCryptoState[data.id] = data.totalCrypto || 0;
        }
        return;
      }

      // Remote player switched profiles — update their display
      const remoteTank = remoteTanks.get(data.id);
      const newAvatarColor = data.avatarColor || data.profilePicture || null;
      if (remoteTank) {
        if (data.faction) remoteTank.setFaction(data.faction);
        remoteTank.avatarColor = newAvatarColor;
        playerTags.updateName?.(data.id, data.name);
        playerTags.updateFaction?.(data.id, data.faction);
        playerTags.updateLevel?.(data.id, data.level);
        playerTags.updateTitle?.(data.id, data.title || "Contractor");
        tankHeadlights.updateFaction?.(data.id, data.faction);

        // Update tag avatar for the new profile
        if (newAvatarColor && playerTags.tags?.has(data.id)) {
          const tagData = playerTags.tags.get(data.id);
          if (tagData?.element) {
            const avatarEl = tagData.element.querySelector(".tag-avatar");
            if (avatarEl) {
              if (newAvatarColor.startsWith("data:")) {
                avatarEl.style.background = "";
                avatarEl.style.backgroundImage = `url(${newAvatarColor})`;
                avatarEl.style.backgroundSize = "cover";
                avatarEl.style.backgroundPosition = "center";
              } else {
                avatarEl.style.backgroundImage = "";
                avatarEl.style.background = newAvatarColor;
              }
            }
          }
        }
      }

      // Update ProfileCard cache with new profile data
      if (window.profileCard) {
        window.profileCard.updatePlayer(data.id, {
          name: data.name,
          faction: data.faction,
          level: data.level,
          badges: data.badges || [],
          title: data.title || "Contractor",
          crypto: data.totalCrypto || 0,
          avatarColor: newAvatarColor,
        });
        window.profileCard.latestCryptoState[data.id] = data.totalCrypto || 0;
      }

      // Keep CommanderSystem in sync
      if (window.commanderSystem) {
        window.commanderSystem.updatePlayerFaction?.(data.id, data.faction);
      }
    };

    // Commander ping relayed by server — place on local ping system
    net.onCommanderPing = (data) => {
      if (!window.pingMarkerSystem || !planet) return;
      // Reconstruct world position from local-space normal (reuses preallocated vector)
      _pingWorldPos.set(data.x, data.y, data.z).normalize().multiplyScalar(sphereRadius);
      planet.hexGroup.localToWorld(_pingWorldPos);
      window.pingMarkerSystem.placePing(
        data.id,
        _pingWorldPos,
        true, // isCommander
        data.faction,
        null, // no squad for commander pings
      );
    };

    // Commander drawing relayed by server — render on local drawing system
    // Supports live streaming (done: false = preview, done: true = finalized)
    net.onCommanderDrawing = (data) => {
      if (!mp.commanderDrawing) return;
      if (data.done) {
        mp.commanderDrawing.finalizeRemotePreview(
          data.id,
          data.points,
          data.faction,
        );
      } else {
        mp.commanderDrawing.updateRemotePreview(
          data.id,
          data.points,
          data.faction,
        );
      }
    };

    // Server-authoritative commander change (immediate, per-faction)
    net.onCommanderUpdate = (data) => {
      if (!window.commanderSystem) return;
      window.commanderSystem.applyServerCommander(
        data.faction,
        data.commander,
        data.isActing || false,
        data.trueCommanderName || null,
      );
    };

    // Server-authoritative commander full sync (periodic, all factions)
    net.onCommanderSync = (commanders) => {
      if (!window.commanderSystem) return;
      for (const [faction, cmdrData] of Object.entries(commanders)) {
        window.commanderSystem.applyServerCommander(
          faction,
          cmdrData ? { id: cmdrData.id, name: cmdrData.name } : null,
          cmdrData?.isActing || false,
          cmdrData?.trueCommanderName || null,
        );
      }
      // Force-verify dashboard commander state (catches any desync)
      // Skip if human player is resigned — don't override the resign UI
      if (window.dashboard && window.commanderSystem.humanPlayerFaction && !window.commanderSystem.isResigned()) {
        const isCommander = window.commanderSystem.isHumanCommander();
        const isActing = window.commanderSystem.isHumanActingCommander();
        window.dashboard.updateCommanderStatus(isCommander, isActing);
      }
    };

    // Server-authoritative faction roster (periodic, every 10 seconds)
    net.onFactionRoster = (data) => {
      if (window.dashboard) {
        window.dashboard.updateFactionRoster(data);
      }
    };

    // Commander tip: server confirmed our tip went through
    net.onTipConfirmed = (data) => {
      const tipSystem = window.commanderSystem?.tipSystem;
      if (tipSystem) tipSystem.applyServerTipConfirm(data);
    };

    // Commander tip: server rejected our tip
    net.onTipFailed = (data) => {
      const tipSystem = window.commanderSystem?.tipSystem;
      if (tipSystem) tipSystem.applyServerTipFailed(data.reason);
    };

    // We received a tip from our faction's commander
    const _tipScreenPos = new THREE.Vector3();
    net.onTipReceived = (data) => {
      // Award crypto through CryptoSystem (updates stats, checks level-up, floating number visual)
      if (window.cryptoSystem && tank.group) {
        tank.group.getWorldPosition(_tipScreenPos);
        window.cryptoSystem.awardCrypto(data.amount, 'tip', _tipScreenPos);
      }
      // Set authoritative server balance on dashboard
      if (window.dashboard) {
        window.dashboard.updateCrypto?.(data.newCrypto);
      }
      // Tusk local notification for the recipient
      if (window.tuskCommentary?.onTipReceived) {
        window.tuskCommentary.onTipReceived(data.fromName, data.amount);
      }
      // Tip explosion effect + sound on recipient's screen (around their own tank)
      const tipSystem = window.commanderSystem?.tipSystem;
      if (tipSystem && tank.group && window.gameCamera?.camera) {
        tank.group.getWorldPosition(_tipScreenPos);
        _tipScreenPos.project(window.gameCamera.camera);
        const sx = (_tipScreenPos.x * 0.5 + 0.5) * window.innerWidth;
        const sy = (-_tipScreenPos.y * 0.5 + 0.5) * window.innerHeight;
        tipSystem._spawnTipEffect(sx, sy);
        tipSystem._playChaChing();
      }
    };

    // Another player sent their profile (badges, crypto, title)
    net.onPlayerProfile = (data) => {
      if (!data || !data.id) return;
      // Update ProfileCard cache with real data
      // (Commander title is applied at render time, not stored in cache)
      if (window.profileCard) {
        window.profileCard.updatePlayer(data.id, {
          badges: data.badges || [],
          totalCrypto: data.totalCrypto || 0,
          title: data.title || "Contractor",
          avatarColor: data.avatarColor || null,
        });
      }

      // Update player tag title
      if (data.title) {
        playerTags.updateTitle?.(data.id, data.title);
      }

      // Update player tag avatar if avatarColor changed
      if (data.avatarColor && playerTags.tags?.has(data.id)) {
        const tagData = playerTags.tags.get(data.id);
        if (tagData?.element) {
          const avatarEl = tagData.element.querySelector(".tag-avatar");
          if (avatarEl) {
            if (data.avatarColor.startsWith("data:")) {
              avatarEl.style.background = "";
              avatarEl.style.backgroundImage = `url(${data.avatarColor})`;
              avatarEl.style.backgroundSize = "cover";
              avatarEl.style.backgroundPosition = "center";
            } else {
              avatarEl.style.backgroundImage = "";
              avatarEl.style.background = data.avatarColor;
            }
          }
        }
      }
    };

    // Server-generated Lord Elon Tusk global chat messages
    // Queue messages if chatWindow isn't ready yet (race condition on connect)
    const pendingTuskMessages = [];
    net.onTuskChat = (data) => {
      const chatWindow = mp.proximityChat?.chatWindow;
      if (chatWindow) {
        // Flush any queued messages first
        while (pendingTuskMessages.length > 0) {
          chatWindow.addTuskMessage(pendingTuskMessages.shift());
        }
        chatWindow.addTuskMessage(data.text);
      } else {
        // Buffer until chatWindow is available (max 20 to prevent unbounded growth)
        if (pendingTuskMessages.length < 20) {
          pendingTuskMessages.push(data.text);
        }
      }
    };

    net.onTerritoryUpdate = (changes) => {
      if (!planet) return;
      const playerCluster = tank.getCurrentClusterId(planet);

      for (const change of changes) {
        planet.applyTerritoryState(change.clusterId, change.owner, change.tics);

        // Update sponsor hold timers if this is a sponsor cluster
        // (visual overlay is already handled by applyTerritoryState → updateClusterVisual)
        if (change.sponsorId && change.holdTimer) {
          const timer = planet.sponsorHoldTimers.get(change.sponsorId);
          if (timer) Object.assign(timer, change.holdTimer);
        }

        // Immediately refresh ring HUD if this change affects player's cluster
        const hasSpawned = mp.getHasSpawnedIn?.();
        if (hasSpawned && change.clusterId === playerCluster && mp.updateTugOfWarUI) {
          const state = planet.clusterCaptureState.get(change.clusterId);
          if (state) {
            const counts = { rust: 0, cobalt: 0, viridian: 0 };
            if (!tank.isDead) counts[tank.faction]++;
            mp.updateTugOfWarUI(change.clusterId, state, counts);
          }
        }
      }
      planet.updateDirtyFactionOutlines?.();
    };

    // Server awarded tic contribution crypto (once per second while contributing)
    const _ticCryptoPos = new THREE.Vector3();
    net.onTicCrypto = (data) => {
      // Update capture state from payload BEFORE flash (avoids race with capture-progress)
      if (data && data.id) {
        serverClusterId = data.id; // Keep ring in sync with tic-crypto cluster
        const capState = planet.clusterCaptureState.get(data.id);
        if (capState) {
          capState.tics.rust = data.t.r;
          capState.tics.cobalt = data.t.c;
          capState.tics.viridian = data.t.v;
          capState.capacity = data.cap;
        }
      }
      // Sync ring flash with tic pulse — fires regardless of cryptoSystem
      // so the ring always tracks tic growth (stepped advances here only in MP)
      mp.triggerTickFlash?.();
      // Visual effects require cryptoSystem
      if (!window.cryptoSystem) return;
      tank.group.getWorldPosition(_ticCryptoPos);
      // Only award crypto if server confirmed it (guests get crypto: 0)
      if (data.crypto > 0) {
        window.cryptoSystem.awardTicCrypto(_ticCryptoPos);
      }
      if (mp.capturePulse) {
        mp.capturePulse.emit(_ticCryptoPos, tank.faction, serverClusterId);
      }
    };

    // Server awarded holding crypto (once per minute for territory holdings)
    const _holdingCryptoPos = new THREE.Vector3();
    net.onHoldingCrypto = (data) => {
      if (!window.cryptoSystem) return;
      tank.group.getWorldPosition(_holdingCryptoPos);

      // Use server-provided cluster IDs to spawn floating numbers at each owned hex
      const adjacencyMap = planet._adjacencyMap;
      if (data.clusters && data.clusters.length > 0 && adjacencyMap) {
        const HOLDING_EXPONENT = 1.05;
        const ownedHexes = new Set();
        for (const clusterId of data.clusters) {
          const cluster = planet.clusterData[clusterId];
          if (!cluster) continue;
          for (const tileIdx of cluster.tiles) {
            ownedHexes.add(tileIdx);
          }
        }

        if (ownedHexes.size > 0) {
          const hexData = [];
          for (const tileIdx of ownedHexes) {
            const tileCenter = planet.tileCenters[tileIdx];
            if (!tileCenter) continue;
            const neighbors = adjacencyMap.get(tileIdx) || [];
            let friendlyNeighbors = 0;
            for (const n of neighbors) {
              if (ownedHexes.has(n)) friendlyNeighbors++;
            }
            const crypto = Math.pow(HOLDING_EXPONENT, friendlyNeighbors);
            // Project to surface and convert to world space (matches single-player pattern)
            const surfacePos = tileCenter.position.clone().normalize().multiplyScalar(planet.radius);
            planet.hexGroup.localToWorld(surfacePos);
            hexData.push({ pos: surfacePos, crypto });
          }

          window.cryptoSystem.awardHoldingCrypto(data.amount, _holdingCryptoPos, hexData);
          return;
        }
      }

      // Fallback: single floating number at tank position
      window.cryptoSystem.awardCrypto(data.amount, "holding", _holdingCryptoPos);
    };

    // Periodic capture progress — server sends tic state for player's current cluster ~4x/sec
    net.onCaptureProgress = (data) => {
      if (!planet) return;

      const state = planet.clusterCaptureState.get(data.clusterId);
      if (state) {
        // Calculate momentum from tic delta before overwriting
        state.momentum.rust = (data.tics.rust - state.tics.rust) * 4; // 4x/sec → per-second rate
        state.momentum.cobalt = (data.tics.cobalt - state.tics.cobalt) * 4;
        state.momentum.viridian = (data.tics.viridian - state.tics.viridian) * 4;

        const previousOwner = state.owner;
        state.tics = data.tics;
        state.capacity = data.capacity;
        state.owner = data.owner;

        // If ownership changed (capture-progress arrived before territory-update),
        // apply the visual update so the overlay color stays in sync
        if (data.owner !== previousOwner) {
          planet.updateClusterVisual(data.clusterId);
          planet.updateDirtyFactionOutlines?.();
        }
      }

      // Server sends capture-progress only for the player's assigned cluster,
      // so it's always the right one — track it as the authoritative cluster ID
      serverClusterId = data.clusterId;

      // Always refresh ring HUD (no client-side cluster check — server is authoritative)
      const hasSpawned = mp.getHasSpawnedIn?.();
      if (hasSpawned && mp.updateTugOfWarUI) {
        const counts = { rust: 0, cobalt: 0, viridian: 0 };
        if (!tank.isDead) counts[tank.faction]++;
        for (const [, rt] of remoteTanks) {
          if (!rt.isDead && rt.faction && rt.group) {
            const rtCluster = planet.getClusterIdAtPosition(rt.group.position);
            if (rtCluster === data.clusterId) counts[rt.faction]++;
          }
        }
        mp.updateTugOfWarUI(data.clusterId, state || { tics: data.tics, capacity: data.capacity, owner: data.owner, momentum: { rust: 0, cobalt: 0, viridian: 0 } }, counts);
      }
    };

    // Admin changed sponsors — server reloaded clusters, re-apply everything
    net.onSponsorsReloaded = (data) => {
      if (!planet || !data.world) return;

      // Clear existing sponsor state and stale texture cache so updated
      // images (cache-busted URLs) are re-fetched from the server.
      planet.unmergeClusterTiles();
      planet.clearSponsorData();
      planet.clearSponsorTextureCache();

      // Re-apply full world data (clusters, tile mappings, elevation)
      planet.applyServerWorld(data.world);

      // Preload updated sponsor textures, then apply visuals
      if (data.world.sponsors && data.world.sponsors.length > 0) {
        planet.preloadSponsorTextures(data.world.sponsors).then(() => {
          planet.applySponsorVisuals(data.world.sponsors);
          planet.deElevateSponsorTiles();
          planet.mergeClusterTiles();
        });
      } else {
        planet.mergeClusterTiles();
      }

      // Restore territory capture state (applyServerWorld clears it)
      if (data.captureState && planet) {
        for (const [clusterId, state] of Object.entries(data.captureState)) {
          planet.applyTerritoryState(Number(clusterId), state.owner, state.tics);
        }
        planet.updateDirtyFactionOutlines?.();
      }

      // Reconcile player territories with admin-authoritative server state
      const dashboard = window.dashboard;
      if (dashboard && data.world.sponsors) {
        dashboard._reconcilePlayerTerritories(data.world.sponsors);
      }
    };

    // Admin changed moon sponsors — update moon textures
    net.onMoonSponsorsReloaded = (data) => {
      if (!mp.environment || !data.moonSponsors) return;
      mp.environment.clearMoonSponsors();
      data.moonSponsors.forEach((sponsor, i) => {
        mp.environment.applyMoonSponsor(i, sponsor);
      });
    };

    // Admin changed billboard sponsors — update billboard textures
    net.onBillboardSponsorsReloaded = (data) => {
      if (!mp.environment || !data.billboardSponsors) return;
      mp.environment.clearBillboardSponsors();
      data.billboardSponsors.forEach((sponsor, i) => {
        mp.environment.applyBillboardSponsor(i, sponsor);
      });
    };

    // Another player claimed a territory — apply it visually on the planet
    net.onPlayerTerritoryClaimed = (data) => {
      if (!planet || !data || !data.tileIndices) return;

      const virtualSponsor = {
        id: data.id,
        name: data.title || data.playerName || "Player",
        tagline: data.tagline || "",
        websiteUrl: data.websiteUrl || "",
        cluster: { tileIndices: data.tileIndices },
        patternImage: data.patternImage,
        patternAdjustment: data.patternAdjustment || {},
      };

      planet.applySponsorCluster(virtualSponsor);
      planet.deElevateSponsorTiles();
    };

    // Territory info (title/tagline/URL) updated by another player (kept for backward compat)
    net.onTerritoryInfoUpdated = (data) => {
      if (!planet || !data || !data.territoryId) return;
      const entry = planet.sponsorClusters.get(data.territoryId);
      if (entry?.sponsor) {
        if (data.title) entry.sponsor.name = data.title;
        entry.sponsor.tagline = data.tagline || "";
        entry.sponsor.websiteUrl = data.websiteUrl || "";
      }
    };

    // Admin approved a territory submission — update texture + info on planet for all players
    net.onTerritorySubmissionApproved = (data) => {
      if (!planet || !data || !data.tileIndices) return;

      // Update texture
      const sponsor = {
        id: data.territoryId,
        patternImage: data.patternImage,
        patternAdjustment: data.patternAdjustment || {},
      };
      if (data.patternImage) {
        planet._applySponsorTexture(sponsor, data.tileIndices);
      }

      // Update sponsor info (name, tagline, URL)
      const entry = planet.sponsorClusters.get(data.territoryId);
      if (entry?.sponsor) {
        if (data.title) entry.sponsor.name = data.title;
        entry.sponsor.tagline = data.tagline || "";
        entry.sponsor.websiteUrl = data.websiteUrl || "";
      }
    };

    // Backward compat: old image-only approval event
    net.onTerritoryImageApproved = (data) => {
      if (!planet || !data || !data.tileIndices) return;
      const sponsor = {
        id: data.territoryId,
        patternImage: data.patternImage,
        patternAdjustment: data.patternAdjustment || {},
      };
      planet._applySponsorTexture(sponsor, data.tileIndices);
    };

    // Admin deleted the player's territory
    net.onTerritoryDeleted = (data) => {
      if (!data) return;
      const dashboard = window.dashboard;
      if (!dashboard) return;
      dashboard._onAdminDeleteTerritory(data.territoryId, data.sponsorStorageId, data.reason);
    };

    // Personal review result for the territory owner (approve or reject all fields)
    net.onTerritoryReviewResult = (data) => {
      if (!data) return;
      const dashboard = window.dashboard;
      if (!dashboard || !dashboard._playerTerritories) return;

      const territory = dashboard._playerTerritories.find(t => t.id === data.territoryId);
      if (!territory) return;

      territory.submissionStatus = data.status;

      if (data.status === "rejected") {
        // Remove territory from planet
        if (dashboard._territoryPlanet) {
          dashboard._territoryPlanet.removeSponsorCluster(territory.id);
        }
        // Keep entry as rejection stub (shown in dashboard until dismissed)
        territory.rejectionReason = data.reason || "Submission rejected by admin";
        territory.tileIndices = [];
        territory.pendingTitle = null;
        territory.pendingTagline = null;
        territory.pendingWebsiteUrl = null;
        territory.pendingImage = null;

        dashboard._savePlayerTerritories();
        dashboard._renderTerritoryList();
        return;
      } else if (data.status === "approved") {
        // Move approved data to active fields
        if (data.title !== undefined) territory.title = data.title;
        if (data.tagline !== undefined) territory.tagline = data.tagline;
        if (data.websiteUrl !== undefined) territory.websiteUrl = data.websiteUrl;
        if (data.patternImage) territory.patternImage = data.patternImage;
        // Clear pending fields
        territory.pendingTitle = null;
        territory.pendingTagline = null;
        territory.pendingWebsiteUrl = null;
        territory.pendingImage = null;

        // Update planet texture for the owning player
        if (data.patternImage && dashboard._territoryPlanet) {
          dashboard._territoryPlanet._applySponsorTexture(
            { id: territory.id, patternImage: data.patternImage, patternAdjustment: territory.patternAdjustment },
            territory.tileIndices,
          );
        }
        // Update sponsor info on planet
        const entry = dashboard._territoryPlanet?.sponsorClusters?.get(territory.id);
        if (entry?.sponsor) {
          if (data.title) entry.sponsor.name = data.title;
          entry.sponsor.tagline = data.tagline || "";
          entry.sponsor.websiteUrl = data.websiteUrl || "";
        }

        dashboard.addNotification("Your territory submission was approved!", "info", "territory");
      }

      dashboard._savePlayerTerritories();
      dashboard._renderTerritoryList();
    };

    // Backward compat: old image-only review result
    net.onTerritoryImageReviewResult = (data) => {
      // Delegate to the new handler
      if (net.onTerritoryReviewResult) net.onTerritoryReviewResult(data);
    };

    // Server acknowledged image submission — notify admin portal to reload
    net.onTerritoryImageSubmitted = (data) => {
      if (data && data.status === "error") {
        console.warn("[Territory] Image submission failed:", data.message);
      } else if (data && data.status === "pending") {
        if (typeof SponsorStorage !== "undefined") {
          SponsorStorage._broadcast("update", { id: data.territoryId });
        }
      }
    };

    // Server acknowledged info submission as pending
    net.onTerritoryInfoSubmitted = (data) => {
      if (data && data.status === "pending") {
        const dashboard = window.dashboard;
        if (dashboard) {
          const territory = dashboard._playerTerritories?.find(t => t.id === data.territoryId);
          if (territory) {
            territory.submissionStatus = "pending";
            dashboard._renderTerritoryList();
          }
          dashboard.addNotification("Territory info submitted for review", "info", "territory");
        }
      }
    };

    // Server-authoritative crypto balances (broadcast every 5 seconds)
    net.onCryptoUpdate = (cryptoState) => {
      // Update CommanderSystem with server crypto for all players
      if (window.commanderSystem) {
        for (const [id, crypto] of Object.entries(cryptoState)) {
          window.commanderSystem.updatePlayerCrypto?.(id, crypto);
        }
      }
      // Store full crypto state on ProfileCard (most reliable source for show())
      if (window.profileCard) {
        window.profileCard.latestCryptoState = cryptoState;
        for (const [id, crypto] of Object.entries(cryptoState)) {
          window.profileCard.updatePlayer(id, { crypto });
        }
      }
      // Sync local CryptoSystem with server-authoritative balance
      // Prevents client-side Firestore saves from writing drifted values
      if (cryptoState[net.playerId] !== undefined && window.cryptoSystem) {
        window.cryptoSystem.stats.totalCrypto = cryptoState[net.playerId];
      }
      // Update own crypto display in dashboard
      if (cryptoState[net.playerId] !== undefined && window.dashboard) {
        window.dashboard.updateCrypto?.(cryptoState[net.playerId]);
      }
    };

    // ========================
    // ECONOMY: ACTION DENIED / LEVEL-UP / SLOT UNLOCK
    // ========================

    net.onActionDenied = (data) => {
      const actionLabels = {
        'fast-travel': 'fast travel',
        'fire': 'firing',
        'level-up': 'leveling up',
        'unlock-slot': 'unlocking slot',
      };
      const label = actionLabels[data.action] || data.action;
      const msg = `Not enough crypto for ${label} (need ¢${data.cost.toLocaleString()})`;

      // Show floating message near tank
      if (window.cryptoVisuals && tank.group) {
        tank.group.getWorldPosition(_tipScreenPos);
        window.cryptoVisuals._spawnFloatingNumber(-data.cost, _tipScreenPos);
      }

      // Show toast notification
      if (window.dashboard) {
        window.dashboard.showToast?.(msg);
      }

      // Trigger local Tusk commentary
      if (window.tuskCommentary) {
        window.tuskCommentary.onBroke?.();
      }

      // If fast travel was denied, exit portal UI if it was entered optimistically
      if (data.action === 'fast-travel' && mp.fastTravel && mp.fastTravel.active) {
        mp.fastTravel.exitFastTravel?.();
      }
    };

    net.onLevelUpConfirmed = (data) => {
      // Show red spend floater for level-up cost
      if (data.cost > 0 && window.cryptoVisuals && tank.group) {
        tank.group.getWorldPosition(_tipScreenPos);
        window.cryptoVisuals._spawnFloatingNumber(-data.cost, _tipScreenPos);
      }
      // Update local level
      if (window.cryptoSystem) {
        window.cryptoSystem.stats.level = data.level;
      }
      // Trigger level-up effects
      if (window.cryptoSystem && window.cryptoSystem.onLevelUp) {
        window.cryptoSystem.onLevelUp(data.level, data.level - 1);
      }
      // Update dashboard
      if (window.dashboard) {
        window.dashboard.setPlayerLevel?.(data.level);
      }
      // Trigger local Tusk level-up commentary
      if (window.tuskCommentary) {
        window.tuskCommentary.onLevelUp?.();
      }
    };

    net.onSlotUnlocked = (data) => {
      // Update dashboard loadout UI
      if (window.dashboard) {
        window.dashboard.onSlotUnlocked?.(data.slotId);
      }
    };

    net.onTankUpgradeConfirmed = (data) => {
      // Show red spend floater for tank upgrade cost
      if (data.cost > 0 && window.cryptoVisuals && tank.group) {
        tank.group.getWorldPosition(_tipScreenPos);
        window.cryptoVisuals._spawnFloatingNumber(-data.cost, _tipScreenPos);
      }
      // Apply confirmed upgrade to local WeaponSlotSystem
      if (window.weaponSlotSystem) {
        window.weaponSlotSystem.applyServerUpgrade(data.type, data.tier);
      }
      // Refresh dashboard loadout UI
      if (window.dashboard && window.dashboard.loadoutInitialized) {
        window.dashboard.updateLoadout(window.dashboard.playerLevel || 1);
      }
    };

    // ========================
    // REMOTE TANK MANAGEMENT
    // ========================

    function spawnRemoteTank(playerData) {
      const existing = remoteTanks.get(playerData.id);
      if (existing) {
        // Revive existing dead/waiting tank (restores materials, resets fade state)
        existing.revive();
        tankDamageEffects.setDamageState(playerData.id, existing.group, "healthy");
        existing.setFaction(playerData.faction);
        existing.setTargetState({
          t: playerData.theta, p: playerData.phi,
          h: playerData.heading || 0, s: 0,
          ta: 0, hp: playerData.hp || 100,
          d: 0, f: playerData.faction,
        });
        // Recreate player tag (fadeOutTag removes it after death fade completes)
        playerTags.createTag?.(playerData.id, existing, {
          name: playerData.name,
          level: playerData.level || 1,
          rank: playerData.rank || 0,
          avatar: null, avatarColor: playerData.avatarColor || null, squad: null,
          faction: playerData.faction,
          title: playerData.title || "Contractor",
          hp: playerData.hp || 100,
          maxHp: playerData.maxHp || 100,
        });
        // Update faction in CommanderSystem (may have changed)
        if (window.commanderSystem) {
          window.commanderSystem.updatePlayerFaction?.(playerData.id, playerData.faction);
        }
        // Apply commander tag styling if this player is the current commander
        if (window.commanderSystem?.isCommander(playerData.id)) {
          playerTags.setCommander?.(playerData.id, true);
        }
        return;
      }

      const remoteTank = new RemoteTank(scene, sphereRadius, playerData);
      remoteTanks.set(playerData.id, remoteTank);

      // Register with visual systems
      playerTags.createTag?.(playerData.id, remoteTank, {
        name: playerData.name,
        level: playerData.level || 1,
        rank: playerData.rank || 0,
        avatar: null,
        avatarColor: playerData.avatarColor || null,
        squad: null,
        faction: playerData.faction,
        title: playerData.title || "Contractor",
        hp: playerData.hp || 100,
        maxHp: playerData.maxHp || 100,
      });

      // Register LOD dot for hover tooltips and right-click player card
      if (remoteTank.lodDot && window.tankLODInteraction) {
        window.tankLODInteraction.registerDot(remoteTank.lodDot);
      }

      treadDust.registerTank?.(playerData.id, remoteTank.group, remoteTank.state);
      treadTracks.registerTank?.(playerData.id, remoteTank.group, remoteTank.state);
      tankHeadlights.registerTank?.(
        playerData.id,
        remoteTank.group,
        playerData.faction,
        remoteTank
      );
      tankCollision.registerTank?.(playerData.id, {
        group: remoteTank.group,
        state: remoteTank.state,
        isBot: false,
        playerRef: remoteTank,
      });

      // Register with ProfileCard using real server data
      if (window.profileCard) {
        window.profileCard.registerPlayer({
          id: playerData.id,
          name: playerData.name,
          faction: playerData.faction,
          level: playerData.level || 1,
          rank: playerData.rank || 0,
          crypto: playerData.crypto || 0,
          title: playerData.title || "Contractor",
          badges: playerData.badges || [],
          hp: playerData.hp || 100,
          maxHp: playerData.maxHp || 100,
          avatarColor: playerData.avatarColor || null,
          isOnline: true,
          isSelf: false,
        });
      }

      // Register with CommanderSystem (enables tip system player lookup)
      if (window.commanderSystem) {
        window.commanderSystem.registerRemotePlayer(playerData.id, playerData.faction, remoteTank, playerData.name);
        // Apply commander tag styling if this player is the current commander
        // (handles late-join where commander-update arrived before the tag was created)
        if (window.commanderSystem.isCommander(playerData.id)) {
          const isActing = window.commanderSystem.actingCommanders?.[playerData.faction] || false;
          playerTags.setCommander?.(playerData.id, true, null, isActing);
        }
      }

      mp.updatePlayerCount?.();
    }

    function despawnRemoteTank(playerId) {
      const remoteTank = remoteTanks.get(playerId);
      if (!remoteTank) return;

      // Unregister from visual systems
      playerTags.removeTag?.(playerId);
      treadDust.unregisterTank?.(playerId);
      treadTracks.unregisterTank?.(playerId);
      tankHeadlights.unregisterTank?.(playerId);
      tankCollision.unregisterTank?.(playerId);

      // Unregister from CommanderSystem
      if (window.commanderSystem) {
        window.commanderSystem.unregisterPlayer(playerId);
      }

      // Unregister LOD dot from interaction system
      if (remoteTank.lodDot && window.tankLODInteraction) {
        window.tankLODInteraction.unregisterDot(remoteTank.lodDot);
      }

      remoteTank.destroy();
      remoteTanks.delete(playerId);

      mp.updatePlayerCount?.();
    }

    // ========================
    // BODYGUARD HELPERS
    // ========================

    function spawnRemoteBodyguard(bgData) {
      const id = bgData.id;
      if (remoteBodyguards.has(id)) return remoteBodyguards.get(id);

      const spawnFaction = bgData.faction || bgData.f;
      if (!spawnFaction) {
        console.warn("[Multiplayer] Bodyguard spawned with missing faction!", id, bgData);
      }

      const bg = new RemoteBodyguard(scene, sphereRadius, bgData);
      remoteBodyguards.set(id, bg);

      // Register with visual systems
      const name = bg.name;
      const faction = bg.faction;
      playerTags.createTag?.(id, bg, {
        name: name,
        level: 1,
        rank: 0,
        avatar: null,
        avatarColor: null,
        squad: null,
        faction: faction,
        title: "Bodyguard",
        hp: bg.hp,
        maxHp: bg.maxHp,
      });
      treadDust.registerTank?.(id, bg.group, bg.state);
      tankHeadlights.registerTank?.(id, bg.group, faction, bg);

      return bg;
    }

    function despawnRemoteBodyguard(bgId) {
      const bg = remoteBodyguards.get(bgId);
      if (!bg) return;

      playerTags.removeTag?.(bgId);
      treadDust.unregisterTank?.(bgId);
      tankHeadlights.unregisterTank?.(bgId);
      tankDamageEffects.removeTank?.(bgId);
      bg.destroy();
      remoteBodyguards.delete(bgId);
    }

    // ========================
    // CONNECT
    // ========================

    // Wire fast travel events to send to server
    if (mp.fastTravel) {
      const origOnEnter = mp.fastTravel.onEnterFastTravel;
      mp.fastTravel.onEnterFastTravel = () => {
        if (origOnEnter) origOnEnter();
        if (net.isMultiplayer) {
          net.sendEnterFastTravel();
        }
      };
      mp.fastTravel.onPortalChosen = (portalTileIndex) => {
        console.log('[MP] onPortalChosen — portalTileIndex:', portalTileIndex, 'isMultiplayer:', net.isMultiplayer, 'connected:', net.connected, 'playerId:', net.playerId);
        if (net.isMultiplayer) {
          net.sendChoosePortal(portalTileIndex);
        } else {
          console.warn('[MP] NOT sending choose-portal — isMultiplayer is false');
        }
      };
      mp.fastTravel.onPreviewPortal = (portalTileIndex) => {
        if (net.isMultiplayer) {
          net.sendPreviewPortal(portalTileIndex);
        }
      };
    }

    // Connect with Firebase auth token if available
    const connectOpts = {};
    if (window.authManager && window.authManager.idToken) {
      connectOpts.token = window.authManager.idToken;
    }
    net.connect(connectOpts);

    // If token wasn't available at connect time, send it once auth resolves
    if (!connectOpts.token && window.authManager) {
      // Poll briefly — token may resolve between our check and socket connect
      const tokenPoll = setInterval(() => {
        if (window.authManager.idToken && net.connected) {
          clearInterval(tokenPoll);
          net.sendRefreshToken(window.authManager.idToken);
        }
      }, 200);
      // Stop polling after 10s to avoid leaking
      setTimeout(() => clearInterval(tokenPoll), 10000);
    }

    // Expose for debugging
    window._mpState = {
      net,
      remoteTanks,
      getPlayerCount: () => remoteTanks.size + 1,
    };

  }
})();
