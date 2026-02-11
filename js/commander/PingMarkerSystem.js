/**
 * AdLands - Ping Marker System
 * Allows players to place tactical ping markers on the planet surface
 * Commander pings: Gold, visible to all faction members
 * Regular pings: Purple, visible only to squad members
 */

const PING_CONFIG = {
  markerSize: 6, // Base size of ping marker
  heightAboveSurface: 10, // Float above planet
  duration: 60000, // 60 seconds total
  fadeDuration: 10000, // Final 10 seconds fade
  arrivalDistance: 30, // Distance to trigger arrival pop
  ownColor: 0x00ffff, // Cyan (player's own ping)
  commanderColor: 0xffd700, // Gold (other commanders)
  squadColor: 0xa064dc, // Purple (other squad members)
  pulseSpeed: 0.005, // Pulse animation speed
  pulseMin: 0.8, // Minimum scale during pulse
  pulseMax: 1.2, // Maximum scale during pulse
  darkOutlineSize: 1, // Dark outline thickness
  darkOutlineColor: 0x000000,
  darkOutlineOpacity: 0.8,
  // Audio
  commanderFreq: 880, // A5 note
  squadFreq: 660, // E5 note
  soundDuration: 0.3, // 300ms
};

class PingMarkerSystem {
  constructor(scene, camera, planet, sphereRadius, renderer) {
    this.scene = scene;
    this.camera = camera;
    this.planet = planet;
    this.sphereRadius = sphereRadius;
    this.renderer = renderer;

    // External references
    this.commanderSystem = null;
    this.proximityChat = null;
    this.playerTank = null;
    this.humanPlayerId = "player";

    // Ping storage: playerId -> PingData
    this.pings = new Map();

    // 3D group for markers
    this.pingsGroup = new THREE.Group();
    this.pingsGroup.name = "pingMarkers";
    this.planet.hexGroup.add(this.pingsGroup);

    // DOM container for arrows
    this.arrowsContainer = null;
    this._createArrowsContainer();

    // Audio context (lazy init)
    this._audioCtx = null;

    // Track 3D marker visibility (arrows always update)
    this.markersVisible = false;

    // When suppressed, all pings and arrows are hidden (e.g. during terminal screen)
    this.suppressed = false;

    // Reusable vectors
    this._tempVec3 = new THREE.Vector3();
    this._tempVec3b = new THREE.Vector3();
    this._tempVec3c = new THREE.Vector3();
    this._tempVec3d = new THREE.Vector3();
  }

  // ========================
  // DEPENDENCY INJECTION
  // ========================

  setCommanderSystem(commanderSystem) {
    this.commanderSystem = commanderSystem;
  }

  setProximityChat(proximityChat) {
    this.proximityChat = proximityChat;
  }

  setPlayerTank(tank) {
    this.playerTank = tank;
  }

  setBotTanks(botTanks) {
    this.botTanks = botTanks;
  }

  /**
   * Get a player's current world position by ID
   * @param {string} targetPlayerId - 'player' or 'bot-{index}'
   * @returns {THREE.Vector3|null} World position or null if not found
   */
  _getPlayerPosition(targetPlayerId) {
    if (targetPlayerId === "player") {
      return this.playerTank?.getPosition() || null;
    } else if (targetPlayerId.startsWith("bot-")) {
      // Find bot by playerId stored on lodDot, not by array index
      // (array indices shift when bots are despawned via splice)
      const bot = this.botTanks?.bots?.find(
        (b) => b.lodDot?.userData?.playerId === targetPlayerId,
      );
      if (bot) {
        bot.group.getWorldPosition(this._tempVec3c);
        return this._tempVec3c;
      }
    }
    return null;
  }

  /**
   * Set visibility for 3D markers (orbital view only)
   * Arrows remain visible in all modes
   */
  setMarkersVisible(visible) {
    this.markersVisible = visible;
    this.pingsGroup.visible = visible;
  }

  // ========================
  // PING PLACEMENT
  // ========================

  /**
   * Place a ping marker at the given world position
   * @param {string} playerId - ID of the player placing the ping
   * @param {THREE.Vector3} worldPosition - World position on planet surface
   * @param {boolean} isCommander - Whether the player is a commander
   * @param {string} faction - Player's faction
   * @param {string|null} squad - Player's squad (null if none)
   * @param {Object} options - Optional settings
   * @param {string} options.followingPlayerId - Player ID to follow (ping tracks this player)
   */
  placePing(
    playerId,
    worldPosition,
    isCommander,
    faction,
    squad,
    options = {},
  ) {
    // Remove existing ping from this player (one ping per player)
    if (this.pings.has(playerId)) {
      this._removePing(playerId);
    }

    // Convert world position to local space
    const localPos = this.planet.hexGroup.worldToLocal(worldPosition.clone());

    // Normalize and raise above surface
    const normal = localPos.clone().normalize();
    const surfaceHeight = this.sphereRadius + PING_CONFIG.heightAboveSurface;
    const position = normal.multiplyScalar(surfaceHeight);

    // Determine if this is the player's own ping
    const isOwn = playerId === this.humanPlayerId;

    // Create marker mesh (diamond shape - 4-sided circle rotated 45 degrees)
    // Commander pings = always gold, own non-commander ping = cyan, squad ping = purple
    let color;
    if (isCommander) {
      color = PING_CONFIG.commanderColor; // Commander pings always gold
    } else if (isOwn) {
      color = PING_CONFIG.ownColor; // Own non-commander ping = cyan
    } else {
      color = PING_CONFIG.squadColor; // Other squad pings = purple
    }
    const mesh = this._createMarkerMesh(color);
    mesh.position.copy(position);
    this.pingsGroup.add(mesh);

    // Create dark outline
    const outlineMesh = this._createOutlineMesh();
    outlineMesh.position.copy(position);
    this.pingsGroup.add(outlineMesh);

    // Create arrow element
    const arrowElement = this._createArrowElement(isCommander, isOwn);

    // Store ping data
    const now = Date.now();
    const pingData = {
      playerId,
      position: position.clone(),
      mesh,
      outlineMesh,
      createdAt: now,
      expiry: now + PING_CONFIG.duration,
      fadeStart: now + PING_CONFIG.duration - PING_CONFIG.fadeDuration,
      isCommander,
      faction,
      squad,
      arrowElement,
      arrived: false, // Track if player has reached this ping
      followingPlayerId: options.followingPlayerId || null, // Player ID to follow
    };

    this.pings.set(playerId, pingData);

    // Play sound for viewers who can see this ping
    this._playPingSound(isCommander);
  }

  /**
   * Remove a player's ping
   */
  removePing(playerId) {
    this._removePing(playerId);
  }

  _removePing(playerId) {
    const ping = this.pings.get(playerId);
    if (!ping) return;

    // Remove mesh
    this.pingsGroup.remove(ping.mesh);
    ping.mesh.geometry.dispose();
    ping.mesh.material.dispose();

    // Remove outline
    this.pingsGroup.remove(ping.outlineMesh);
    ping.outlineMesh.geometry.dispose();
    ping.outlineMesh.material.dispose();

    // Remove arrow and distance label
    if (ping.arrowElement) {
      if (ping.arrowElement._distanceLabel?.parentNode) {
        ping.arrowElement._distanceLabel.remove();
      }
      if (ping.arrowElement.parentNode) {
        ping.arrowElement.parentNode.removeChild(ping.arrowElement);
      }
    }

    this.pings.delete(playerId);
  }

  // ========================
  // MARKER RENDERING
  // ========================

  _createMarkerMesh(color) {
    // Diamond shape: CircleGeometry with 4 segments creates diamond by default
    // (corners at top/right/bottom/left)
    const geometry = new THREE.CircleGeometry(PING_CONFIG.markerSize, 4);

    const material = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.9,
      depthTest: false, // Always visible (2D-like)
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 999; // Render on top
    return mesh;
  }

  _createOutlineMesh() {
    const outlineSize = PING_CONFIG.markerSize + PING_CONFIG.darkOutlineSize;
    // Diamond shape: CircleGeometry with 4 segments creates diamond by default
    const geometry = new THREE.CircleGeometry(outlineSize, 4);

    const material = new THREE.MeshBasicMaterial({
      color: PING_CONFIG.darkOutlineColor,
      transparent: true,
      opacity: PING_CONFIG.darkOutlineOpacity,
      depthTest: false, // Always visible (2D-like)
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 998; // Render on top, but behind main marker
    return mesh;
  }

  // ========================
  // ARROW RENDERING
  // ========================

  _createArrowsContainer() {
    this.arrowsContainer = document.getElementById("ping-arrows-container");
    if (!this.arrowsContainer) {
      this.arrowsContainer = document.createElement("div");
      this.arrowsContainer.id = "ping-arrows-container";
      document.body.appendChild(this.arrowsContainer);
    }
  }

  _createArrowElement(isCommander, isOwn) {
    const arrow = document.createElement("div");
    arrow.className = "ping-arrow";
    arrow.setAttribute("data-commander", isCommander ? "true" : "false");
    arrow.setAttribute("data-own", isOwn ? "true" : "false");
    arrow.style.display = "none";
    this.arrowsContainer.appendChild(arrow);

    // Distance label — separate sibling element (avoids touching arrow animation)
    const label = document.createElement("div");
    label.className = "ping-arrow-distance";
    if (isCommander) {
      label.style.color = "#ffd700";
    } else if (isOwn) {
      label.style.color = "#00ffff";
    } else {
      label.style.color = "#a064dc";
    }
    label.style.display = "none";
    this.arrowsContainer.appendChild(label);
    arrow._distanceLabel = label;

    return arrow;
  }

  // ========================
  // VISIBILITY LOGIC
  // ========================

  /**
   * Check if the current player can see a given ping
   */
  _canSeePing(ping, viewerFaction, viewerSquad) {
    // Own ping is always visible
    if (ping.playerId === this.humanPlayerId) {
      return true;
    }

    if (ping.isCommander) {
      // Commander pings: visible to all same-faction members
      return ping.faction === viewerFaction;
    } else {
      // Regular pings: visible to same squad only
      return ping.squad && ping.squad === viewerSquad;
    }
  }

  // ========================
  // UPDATE
  // ========================

  /**
   * Main update - call from game loop
   * Arrows update in all modes, 3D markers only in orbital/fast travel
   */
  update(deltaTime, playerFaction, playerSquad) {
    if (this.pings.size === 0) return;

    // Hide all pings and arrows when suppressed (terminal screen)
    if (this.suppressed) {
      for (const [, ping] of this.pings) {
        ping.mesh.visible = false;
        ping.outlineMesh.visible = false;
        ping.arrowElement.style.display = "none";
        if (ping.arrowElement._distanceLabel) {
          ping.arrowElement._distanceLabel.style.display = "none";
        }
      }
      return;
    }

    const now = Date.now();

    // Update each ping
    for (const [playerId, ping] of this.pings) {
      // Check expiry
      if (now >= ping.expiry) {
        this._removePing(playerId);
        continue;
      }

      // Check visibility (can this player see this ping?)
      const canSee = this._canSeePing(ping, playerFaction, playerSquad);

      if (!canSee) {
        ping.mesh.visible = false;
        ping.outlineMesh.visible = false;
        ping.arrowElement.style.display = "none";
        if (ping.arrowElement._distanceLabel) {
          ping.arrowElement._distanceLabel.style.display = "none";
        }
        continue;
      }

      // Update position if following a player
      if (ping.followingPlayerId) {
        const targetPos = this._getPlayerPosition(ping.followingPlayerId);
        if (targetPos) {
          // Convert world position to local space (use temp to avoid mutating returned pos)
          const localPos = this._tempVec3d.copy(targetPos);
          this.planet.hexGroup.worldToLocal(localPos);
          // Normalize and raise above surface
          localPos.normalize();
          const surfaceHeight =
            this.sphereRadius + PING_CONFIG.heightAboveSurface;
          ping.position.copy(localPos.multiplyScalar(surfaceHeight));
          // Update mesh positions
          ping.mesh.position.copy(ping.position);
          ping.outlineMesh.position.copy(ping.position);
        }
      }

      // Get ping world position for arrow and occlusion
      const pingWorldPos = this._tempVec3.copy(ping.position);
      this.planet.hexGroup.localToWorld(pingWorldPos);

      // Update arrow (always, in all camera modes)
      const isOccluded = this._isOccluded(pingWorldPos);
      this._updateArrow(ping, pingWorldPos, isOccluded);

      // Only update 3D markers when in orbital/fast travel view
      if (!this.markersVisible) {
        ping.mesh.visible = false;
        ping.outlineMesh.visible = false;
        continue;
      }

      // Handle fade
      if (now >= ping.fadeStart) {
        const fadeProgress = (now - ping.fadeStart) / PING_CONFIG.fadeDuration;
        const opacity = Math.max(0, 0.9 * (1 - fadeProgress));
        ping.mesh.material.opacity = opacity;
        ping.outlineMesh.material.opacity =
          PING_CONFIG.darkOutlineOpacity * (1 - fadeProgress);
      }

      // Pulse animation
      const pulse =
        PING_CONFIG.pulseMin +
        (PING_CONFIG.pulseMax - PING_CONFIG.pulseMin) *
          (0.5 + 0.5 * Math.sin(now * PING_CONFIG.pulseSpeed));
      ping.mesh.scale.setScalar(pulse);
      ping.outlineMesh.scale.setScalar(pulse);

      // Billboard: face camera
      ping.mesh.lookAt(this.camera.position);
      ping.outlineMesh.lookAt(this.camera.position);

      // Always visible (2D-like, no occlusion hiding)
      ping.mesh.visible = true;
      ping.outlineMesh.visible = true;
    }
  }

  _updateArrow(ping, pingWorldPos, isOccluded) {
    const label = ping.arrowElement._distanceLabel;

    // Project ping position to screen (needed for positioning)
    const screenPos = this._projectToScreen(pingWorldPos);

    // Calculate arrow position on ring
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    const arrowRadius = ((vmin * 0.9) / 2) * 0.81;
    const dx = screenPos.x - cx;
    const dy = screenPos.y - cy;
    const angle = Math.atan2(dy, dx);
    const arrowX = cx + Math.cos(angle) * arrowRadius;
    const arrowY = cy + Math.sin(angle) * arrowRadius;
    const rotation = (angle * 180) / Math.PI + 90;

    // Check arrival/departure (surface view only)
    if (this.playerTank && !this.markersVisible) {
      const playerPos = this.playerTank.getPosition();
      if (playerPos) {
        const distance = playerPos.distanceTo(pingWorldPos);
        const inArrivalZone = distance < PING_CONFIG.arrivalDistance;

        if (inArrivalZone && !ping.arrived) {
          // Player has arrived! Trigger pop animation
          ping.arrived = true;
          ping.arrowElement.classList.remove("ping-arrow-appear");
          // Position arrow before pop animation
          ping.arrowElement.style.left = arrowX + "px";
          ping.arrowElement.style.top = arrowY + "px";
          ping.arrowElement.style.setProperty(
            "--arrow-rotation",
            `${rotation}deg`,
          );
          ping.arrowElement.style.display = "block";
          ping.arrowElement.classList.add("ping-arrow-pop");
          if (label) label.style.display = "none";
          // Hide after animation completes (500ms)
          setTimeout(() => {
            if (ping.arrived) {
              ping.arrowElement.style.display = "none";
            }
          }, 500);
          return;
        } else if (!inArrivalZone && ping.arrived) {
          // Player has left the arrival zone! Trigger reappear animation
          ping.arrived = false;
          ping.animatingAppear = true;
          ping.arrowElement.classList.remove("ping-arrow-pop");
          // Position arrow before appear animation
          ping.arrowElement.style.left = arrowX + "px";
          ping.arrowElement.style.top = arrowY + "px";
          ping.arrowElement.style.setProperty(
            "--arrow-rotation",
            `${rotation}deg`,
          );
          ping.arrowElement.style.display = "block";
          ping.arrowElement.classList.add("ping-arrow-appear");
          if (label) label.style.display = "none";
          // Remove animation class after it finishes so normal transforms work
          setTimeout(() => {
            ping.arrowElement.classList.remove("ping-arrow-appear");
            ping.animatingAppear = false;
          }, 500);
          return;
        } else if (ping.arrived) {
          // Still in arrival zone, keep hidden
          ping.arrowElement.style.display = "none";
          if (label) label.style.display = "none";
          return;
        }
      }
    }

    // Don't hide during appear animation
    if (ping.animatingAppear) {
      return;
    }

    // Screen bounds check
    const margin = 50;
    const isOnScreen =
      screenPos.x >= margin &&
      screenPos.x <= window.innerWidth - margin &&
      screenPos.y >= margin &&
      screenPos.y <= window.innerHeight - margin &&
      screenPos.z < 1 && // Not behind camera
      !isOccluded;

    if (isOnScreen) {
      ping.arrowElement.style.display = "none";
      if (label) label.style.display = "none";
      return;
    }

    // Position arrow on ring (values calculated at top of function)
    ping.arrowElement.style.display = "block";
    ping.arrowElement.style.left = arrowX + "px";
    ping.arrowElement.style.top = arrowY + "px";
    ping.arrowElement.style.setProperty("--arrow-rotation", `${rotation}deg`);
    // Only set transform directly if no animation is active
    if (
      !ping.arrowElement.classList.contains("ping-arrow-appear") &&
      !ping.arrowElement.classList.contains("ping-arrow-pop")
    ) {
      ping.arrowElement.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    }

    // Position distance label between center and arrow (close to arrow, always horizontal)
    if (label) {
      const labelOffset = 24;
      label.style.display = "block";
      label.style.left = (arrowX - Math.cos(angle) * labelOffset) + "px";
      label.style.top = (arrowY - Math.sin(angle) * labelOffset) + "px";
      if (this.playerTank) {
        const playerPos = this.playerTank.getPosition();
        if (playerPos) {
          label.textContent = Math.round(playerPos.distanceTo(pingWorldPos)) + "m";
        }
      }
    }
  }

  _projectToScreen(worldPos) {
    const pos = this._tempVec3b.copy(worldPos);
    pos.project(this.camera);

    return {
      x: (pos.x * 0.5 + 0.5) * window.innerWidth,
      y: (-pos.y * 0.5 + 0.5) * window.innerHeight,
      z: pos.z,
    };
  }

  /**
   * Check if a position is occluded by the planet
   */
  _isOccluded(worldPosition) {
    if (!this.camera || !worldPosition) return false;

    const cameraPos = this.camera.position;
    const planetRadius = this.sphereRadius;

    // Ray from camera to position (use preallocated temp vectors)
    const rayDir = this._tempVec3b.copy(worldPosition).sub(cameraPos).normalize();

    // Ray-sphere intersection
    const oc = this._tempVec3c.copy(cameraPos);
    const a = 1;
    const b = 2.0 * oc.dot(rayDir);
    const c = oc.dot(oc) - planetRadius * planetRadius;
    const discriminant = b * b - 4 * a * c;

    if (discriminant < 0) return false;

    const sqrtDisc = Math.sqrt(discriminant);
    const t1 = (-b - sqrtDisc) / 2;
    const t2 = (-b + sqrtDisc) / 2;

    let tHit = -1;
    if (t1 > 0.001 && t2 > 0.001) {
      tHit = Math.min(t1, t2);
    } else if (t1 > 0.001) {
      tHit = t1;
    } else if (t2 > 0.001) {
      tHit = t2;
    }

    if (tHit < 0) return false;

    const distToPos = cameraPos.distanceTo(worldPosition);
    return tHit < distToPos - PING_CONFIG.heightAboveSurface;
  }

  // ========================
  // AUDIO
  // ========================

  _playPingSound(isCommander) {
    // Check audio settings
    if (window.settingsManager) {
      const sfxVolume = window.settingsManager.get("audio.sfx");
      const masterVolume = window.settingsManager.get("audio.master");
      if (sfxVolume === 0 || masterVolume === 0) return;
    }

    const audioCtx = this._getAudioContext();
    if (!audioCtx) return;

    try {
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      // Commander: higher pitched, Regular: lower pitched
      oscillator.frequency.value = isCommander
        ? PING_CONFIG.commanderFreq
        : PING_CONFIG.squadFreq;
      oscillator.type = "sine";

      // Get volume from settings or default
      const sfx = window.settingsManager?.get("audio.sfx") ?? 0.8;
      const master = window.settingsManager?.get("audio.master") ?? 0.8;
      const volume = sfx * master * 0.3;

      gainNode.gain.setValueAtTime(volume, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(
        0.01,
        audioCtx.currentTime + PING_CONFIG.soundDuration,
      );

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + PING_CONFIG.soundDuration);
    } catch (e) {
      console.warn("[PingMarkerSystem] Audio failed:", e);
    }
  }

  _getAudioContext() {
    if (!this._audioCtx) {
      try {
        this._audioCtx = new (
          window.AudioContext || window.webkitAudioContext
        )();
      } catch (e) {
        console.warn("[PingMarkerSystem] AudioContext not available");
        return null;
      }
    }
    return this._audioCtx;
  }

  // ========================
  // CLEANUP
  // ========================

  dispose() {
    // Remove all pings
    for (const playerId of this.pings.keys()) {
      this._removePing(playerId);
    }

    // Remove group from scene
    if (this.pingsGroup.parent) {
      this.pingsGroup.parent.remove(this.pingsGroup);
    }

    // Remove arrows container
    if (this.arrowsContainer && this.arrowsContainer.parentNode) {
      this.arrowsContainer.parentNode.removeChild(this.arrowsContainer);
    }

    // Close audio context
    if (this._audioCtx) {
      this._audioCtx.close();
    }
  }
}
