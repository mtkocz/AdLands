/**
 * AdLands - Player Tags Module
 * Floating name tags above tanks showing name, level, avatar, and squad
 */

class PlayerTags {
  constructor(camera, sphereRadius = 480) {
    this.camera = camera;
    this.sphereRadius = sphereRadius;
    this.tags = new Map(); // tankId → { element, tank, config, lastX, lastY, lastOpacity, lastVisible }

    // Container for all tags
    this.container = document.createElement("div");
    this.container.id = "player-tags-container";
    this.container.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:40;";
    document.body.appendChild(this.container);

    // Reusable Vector3 instances to avoid GC pressure
    this._tempPos = new THREE.Vector3();
    this._surfaceNormal = new THREE.Vector3();
    this._cameraToTank = new THREE.Vector3();
  }

  /**
   * Generate a random color for bot avatars
   * @returns {string} HSL color string
   */
  _generateRandomColor() {
    const hue = Math.floor(Math.random() * 360);
    const sat = 50 + Math.floor(Math.random() * 30); // 50-80%
    const lit = 40 + Math.floor(Math.random() * 20); // 40-60%
    return `hsl(${hue}, ${sat}%, ${lit}%)`;
  }

  /**
   * Create a name tag for a tank
   * @param {string} tankId - Unique identifier for this tank
   * @param {Object} tank - Tank object with .group property
   * @param {Object} config - { name, level, avatar, squad, faction, isPlayer }
   */
  createTag(tankId, tank, config) {
    const el = document.createElement("div");
    el.className = "player-tag";

    // Add player ID for profile card right-click (on entire tag)
    el.dataset.playerId = tankId;

    // Mark player tag for different height offset
    if (config.isPlayer) {
      el.dataset.isPlayer = "true";
    }

    // Build avatar HTML - image for uploaded pic, colored div for bots
    let avatarHtml;
    const avatarColor = config.avatarColor || this._generateRandomColor();
    if (config.avatar) {
      avatarHtml = `<img class="tag-avatar" src="${config.avatar}" alt="" />`;
    } else if (avatarColor.startsWith("data:")) {
      avatarHtml = `<div class="tag-avatar" style="background-image: url(${avatarColor}); background-size: cover; background-position: center;"></div>`;
    } else {
      avatarHtml = `<div class="tag-avatar" style="background: ${avatarColor};"></div>`;
    }

    // Build name with optional squad prefix
    const squadPrefix = config.squad ? `[${config.squad}] ` : "";

    // Get title (default to 'Contractor' for bots)
    const title = config.title || "Contractor";

    // Initialize HP (default 100)
    const hp = config.hp !== undefined ? config.hp : 100;
    const maxHp = config.maxHp !== undefined ? config.maxHp : 100;
    const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));

    el.innerHTML = `
            <span class="tag-title">${title}</span>
            <div class="tag-panel">
                <div class="tag-panel-fill"></div>
                ${avatarHtml}
                <div class="tag-info">
                    <span class="tag-name">${squadPrefix}${config.name}</span>
                </div>
                <div class="tag-rank">${config.rank ? "#" + config.rank : ""}</div>
            </div>
            <div class="tag-healthbar">
                <div class="tag-healthbar-fill" style="width: ${hpPercent}%"></div>
            </div>
        `;

    // Set faction background color on the panel
    const panel = el.querySelector(".tag-panel");
    if (
      panel &&
      typeof FACTION_COLORS !== "undefined" &&
      FACTION_COLORS[config.faction]
    ) {
      const fc = FACTION_COLORS[config.faction];
      // Convert hex to rgba for semi-transparent background
      const hex = fc.hex;
      const r = (hex >> 16) & 255;
      const g = (hex >> 8) & 255;
      const b = hex & 255;
      panel.style.setProperty(
        "--tag-faction-color",
        `rgba(${r}, ${g}, ${b}, 0.85)`,
      );
    }

    this.container.appendChild(el);
    // Include dirty tracking properties for performance optimization
    this.tags.set(tankId, {
      element: el,
      tank,
      config,
      lastX: -9999, // Track last position to skip unchanged updates
      lastY: -9999,
      lastOpacity: -1,
      lastVisible: null, // null = never set, true/false = last display state
    });
  }

  /**
   * Get the config for a tag
   * @param {string} tankId - Tank identifier
   * @returns {Object|null} The tag config or null if not found
   */
  getTagConfig(tankId) {
    const tag = this.tags.get(tankId);
    return tag ? tag.config : null;
  }

  /**
   * Update the name displayed on a tag
   * @param {string} tankId - Tank identifier
   * @param {string} newName - New name to display
   */
  updateName(tankId, newName) {
    const tag = this.tags.get(tankId);
    if (!tag) return;

    const nameEl = tag.element.querySelector(".tag-name");
    if (nameEl) {
      const squadPrefix = tag.config.squad ? `[${tag.config.squad}] ` : "";
      nameEl.textContent = `${squadPrefix}${newName}`;
    }
    tag.config.name = newName;
  }

  /**
   * Update the level displayed on a tag
   * @param {string} tankId - Tank identifier
   * @param {number} newLevel - New level to display
   */
  updateLevel(tankId, newLevel) {
    const tag = this.tags.get(tankId);
    if (!tag) return;

    const levelEl = tag.element.querySelector(".tag-level");
    if (levelEl) {
      levelEl.textContent = newLevel;
    }
    tag.config.level = newLevel;
  }

  /**
   * Update the rank displayed on a tag
   * @param {string} tankId - Tank identifier
   * @param {number} newRank - New rank to display (1-based)
   */
  updateRank(tankId, newRank) {
    const tag = this.tags.get(tankId);
    if (!tag) return;

    const rankEl = tag.element.querySelector(".tag-rank");
    if (rankEl) {
      rankEl.textContent = newRank ? `#${newRank}` : "";
    }
    tag.config.rank = newRank;
  }

  /**
   * Update the title displayed on a tag
   * @param {string} tankId - Tank identifier
   * @param {string} newTitle - New title to display
   */
  updateTitle(tankId, newTitle) {
    const tag = this.tags.get(tankId);
    if (!tag) return;

    // Don't overwrite commander/acting commander title with behavioral title
    if (tag.element.classList.contains("commander")) {
      // Store the new behavioral title for when commander status is removed
      tag.config._previousTitle = newTitle;
      return;
    }

    const titleEl = tag.element.querySelector(".tag-title");
    if (titleEl) {
      titleEl.textContent = newTitle;
    }
    tag.config.title = newTitle;
  }

  /**
   * Set or remove commander status on a player tag
   * @param {string} tankId - Tank identifier
   * @param {boolean} isCommander - Whether this player is now a commander
   * @param {string} previousTitle - The title to restore when losing commander (optional)
   * @param {boolean} isActing - Whether this is an Acting Commander (true commander offline)
   */
  setCommander(tankId, isCommander, previousTitle = null, isActing = false) {
    const tag = this.tags.get(tankId);
    if (!tag) return;

    const titleEl = tag.element.querySelector(".tag-title");

    if (isCommander) {
      // Store previous title for restoration later
      if (!tag.config._previousTitle) {
        tag.config._previousTitle = tag.config.title;
      }
      // Add commander class for gold styling
      tag.element.classList.add("commander");
      // Set title to Commander or Acting Commander
      const displayTitle = isActing ? "Acting Commander" : "Commander";
      if (titleEl) {
        titleEl.textContent = displayTitle;
      }
      tag.config.title = displayTitle;
    } else {
      // Remove commander class
      tag.element.classList.remove("commander");
      // Restore previous title
      const restoredTitle =
        previousTitle || tag.config._previousTitle || "Contractor";
      if (titleEl) {
        titleEl.textContent = restoredTitle;
      }
      tag.config.title = restoredTitle;
      tag.config._previousTitle = null;
    }
  }

  /**
   * Update all tag positions - call every frame
   * Tags are pure 2D UI elements - same size regardless of distance
   * Uses multiple culling strategies for performance
   * OPTIMIZED: Uses dirty tracking and reusable vectors to minimize DOM updates
   */
  update() {
    const tempPos = this._tempPos;
    const surfaceNormal = this._surfaceNormal;
    const cameraToTank = this._cameraToTank;
    const cameraPos = this.camera.position;

    // === CAMERA HEIGHT FADE (for zoom transitions) ===
    const ZOOM_FADE_START = 60; // Start fading when camera is 60 units above surface
    const ZOOM_FADE_END = 100; // Fully invisible at 100 units above surface
    const ZOOM_CUTOFF = 120; // Hide all tags beyond this camera height

    // === PER-TAG DISTANCE CULLING ===
    const TAG_MAX_DISTANCE = 150; // Hide individual tags beyond this distance from camera
    const TAG_FADE_START = 100; // Start fading individual tags at this distance
    const TAG_FADE_END = 140; // Fully faded at this distance

    // Calculate camera distance from planet surface
    const cameraDistanceFromSurface = cameraPos.length() - this.sphereRadius;

    // Hide all tags if camera is too far from surface (zoom out)
    if (cameraDistanceFromSurface > ZOOM_CUTOFF) {
      for (const [, tagData] of this.tags) {
        if (tagData.lastVisible !== false) {
          tagData.element.style.display = "none";
          tagData.lastVisible = false;
        }
      }
      return;
    }

    // Calculate zoom-based opacity (affects all tags uniformly during zoom)
    let zoomOpacity = 1;
    if (cameraDistanceFromSurface > ZOOM_FADE_START) {
      zoomOpacity =
        1 -
        (cameraDistanceFromSurface - ZOOM_FADE_START) /
          (ZOOM_FADE_END - ZOOM_FADE_START);
      zoomOpacity = Math.max(0, Math.min(1, zoomOpacity));
    }

    for (const [, tagData] of this.tags) {
      const { element, tank } = tagData;

      // Skip if tank group is not visible (already culled by bot system)
      if (!tank.group.visible) {
        if (tagData.lastVisible !== false) {
          element.style.display = "none";
          tagData.lastVisible = false;
        }
        continue;
      }

      // Get tank world position (handles rotation of parent groups)
      tank.group.getWorldPosition(tempPos);

      // === DISTANCE CULLING ===
      const distToCamera = cameraPos.distanceTo(tempPos);
      if (distToCamera > TAG_MAX_DISTANCE) {
        if (tagData.lastVisible !== false) {
          element.style.display = "none";
          tagData.lastVisible = false;
        }
        continue;
      }

      // === BACKFACE CULLING ===
      // Hide tags for tanks on the far side of the planet
      // Reuse vectors instead of .clone()
      surfaceNormal.copy(tempPos).normalize();
      cameraToTank.copy(tempPos).sub(cameraPos).normalize();
      const dotProduct = surfaceNormal.dot(cameraToTank);
      if (dotProduct > 0.2) {
        // Tank is facing away (on far side of planet)
        if (tagData.lastVisible !== false) {
          element.style.display = "none";
          tagData.lastVisible = false;
        }
        continue;
      }

      // Offset above tank (along surface normal - away from planet center)
      const heightOffset = 3.0;
      tempPos.addScaledVector(surfaceNormal, heightOffset);

      // Project to normalized device coordinates
      tempPos.project(this.camera);

      // === FRUSTUM CULLING (behind camera check) ===
      if (tempPos.z > 1) {
        if (tagData.lastVisible !== false) {
          element.style.display = "none";
          tagData.lastVisible = false;
        }
        continue;
      }

      // Convert NDC to screen coordinates (rounded for pixel-perfect positioning)
      const x = Math.round((tempPos.x * 0.5 + 0.5) * window.innerWidth);
      let y = Math.round((tempPos.y * -0.5 + 0.5) * window.innerHeight);

      // Screen-space Y offset - same for all tags (2% higher)
      y -= Math.round(40 + window.innerHeight * 0.02);

      // === SCREEN BOUNDS CULLING ===
      if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) {
        if (tagData.lastVisible !== false) {
          element.style.display = "none";
          tagData.lastVisible = false;
        }
        continue;
      }

      // === COMBINED OPACITY ===
      // Per-tag distance fade (for distant tanks)
      let distanceOpacity = 1;
      if (distToCamera > TAG_FADE_START) {
        distanceOpacity =
          1 - (distToCamera - TAG_FADE_START) / (TAG_FADE_END - TAG_FADE_START);
        distanceOpacity = Math.max(0, Math.min(1, distanceOpacity));
      }

      // Combine zoom opacity and distance opacity (use minimum for smooth fade)
      // Round to 2 decimal places to reduce false updates
      const finalOpacity =
        Math.round(Math.min(zoomOpacity, distanceOpacity) * 100) / 100;

      // === DIRTY TRACKING: Only update DOM if values changed ===
      // Show element if it was hidden
      if (tagData.lastVisible !== true) {
        element.style.display = "flex";
        tagData.lastVisible = true;
      }

      // Only update position if changed (using transform for GPU acceleration)
      if (x !== tagData.lastX || y !== tagData.lastY) {
        element.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 100%))`;
        tagData.lastX = x;
        tagData.lastY = y;
      }

      // Only update opacity if changed
      if (finalOpacity !== tagData.lastOpacity) {
        element.style.opacity = finalOpacity;
        tagData.lastOpacity = finalOpacity;
      }
    }
  }

  /**
   * Update a tag's HP bar
   * @param {string} tankId
   * @param {number} hp - Current HP
   * @param {number} maxHp - Maximum HP (default 100)
   */
  updateHP(tankId, hp, maxHp = 100) {
    const tag = this.tags.get(tankId);
    if (tag) {
      tag.config.hp = hp;
      tag.config.maxHp = maxHp;
      const hpPercent = Math.max(0, Math.min(100, (hp / maxHp) * 100));
      const healthFill = tag.element.querySelector(".tag-healthbar-fill");
      if (healthFill) {
        healthFill.style.width = hpPercent + "%";

        // Color based on HP threshold
        healthFill.classList.remove("hp-high", "hp-medium", "hp-low");
        if (hpPercent > 50) {
          healthFill.classList.add("hp-high");
        } else if (hpPercent > 25) {
          healthFill.classList.add("hp-medium");
        } else {
          healthFill.classList.add("hp-low");
        }
      }
    }
  }

  /**
   * Update a tag's faction (e.g., when player switches faction)
   * @param {string} tankId
   * @param {string} newFaction
   */
  updateFaction(tankId, newFaction) {
    const tag = this.tags.get(tankId);
    if (
      tag &&
      typeof FACTION_COLORS !== "undefined" &&
      FACTION_COLORS[newFaction]
    ) {
      tag.config.faction = newFaction;
      const panel = tag.element.querySelector(".tag-panel");
      if (panel) {
        // Update background color CSS variable
        const fc = FACTION_COLORS[newFaction];
        const hex = fc.hex;
        const r = (hex >> 16) & 255;
        const g = (hex >> 8) & 255;
        const b = hex & 255;
        panel.style.setProperty(
          "--tag-faction-color",
          `rgba(${r}, ${g}, ${b}, 0.85)`,
        );
      }
    }
  }

  /**
   * Fade out and remove a tag over duration (for deaths)
   * @param {string} tankId
   * @param {number} duration - Fade duration in ms (default 3000)
   */
  fadeOutTag(tankId, duration = 3000) {
    const tag = this.tags.get(tankId);
    if (!tag) return;

    // Mark as fading to prevent updates from overriding opacity
    tag.isFading = true;

    const startTime = performance.now();
    const fadeStep = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Ease-out fade
      const opacity = 1 - progress;
      tag.element.style.opacity = opacity;

      if (progress < 1) {
        requestAnimationFrame(fadeStep);
      } else {
        // Fade complete - remove tag
        tag.element.remove();
        this.tags.delete(tankId);
      }
    };

    requestAnimationFrame(fadeStep);
  }

  /**
   * Remove a tag immediately
   * @param {string} tankId
   */
  removeTag(tankId) {
    const tag = this.tags.get(tankId);
    if (tag) {
      tag.element.remove();
      this.tags.delete(tankId);
    }
  }

  /**
   * Clean up all tags
   */
  dispose() {
    for (const [id, { element }] of this.tags) {
      element.remove();
    }
    this.tags.clear();
    this.container.remove();
  }
}
