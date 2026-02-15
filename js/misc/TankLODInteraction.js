/**
 * AdLands - Tank LOD Interaction Module
 * Handles hover tooltips and right-click player cards for LOD dots
 */

class TankLODInteraction {
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.hoveredDot = null;
    this.active = false;
    this.dotMeshes = [];

    this._mouseX = 0;
    this._mouseY = 0;

    // Hover effect config
    this._hoverScale = 1.6;
    this._originalScale = 1.0;
    this._brightenFactor = 1.8; // How much to brighten color on hover
    this._originalMaterial = null; // Store original shared material during hover

    this._createNameTag();
    this._setupEventListeners();
  }

  _createNameTag() {
    this.nameTag = document.createElement("div");
    this.nameTag.className = "lod-dot-nametag";
    this.nameTag.style.cssText = `
            position: fixed;
            display: none;
            padding: 6px 12px;
            background: rgba(0, 0, 0, 0.85);
            color: white;
            font-size: 16px;
            border: 1px solid #FFD700;
            border-radius: 4px;
            pointer-events: none;
            z-index: 1000;
            font-family: 'Atari ST 8x16', monospace;
        `;
    document.body.appendChild(this.nameTag);
  }

  _setupEventListeners() {
    // Throttle mousemove to ~30fps (32ms) - hover detection doesn't need high frequency
    let lastMouseMoveTime = 0;
    window.addEventListener("mousemove", (e) => {
      const now = performance.now();
      if (now - lastMouseMoveTime < 32) return;
      lastMouseMoveTime = now;
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
      this._mouseX = e.clientX;
      this._mouseY = e.clientY;
      if (this.active) this._updateHover();
    });

    // Track right-click start to distinguish click from drag
    let rightClickStart = null;
    let rightClickDot = null;

    window.addEventListener("contextmenu", (e) => {
      if (window._authScreenInstance?.isVisible) return;
      if (this.hoveredDot && this.active) {
        e.preventDefault();
        // Store start position and hovered dot for mouseup check
        rightClickStart = { x: e.clientX, y: e.clientY };
        rightClickDot = this.hoveredDot;
      }
    });

    window.addEventListener("mouseup", (e) => {
      if (e.button !== 2) return; // Only right-click
      if (!rightClickStart || !rightClickDot) return;

      const dx = Math.abs(e.clientX - rightClickStart.x);
      const dy = Math.abs(e.clientY - rightClickStart.y);
      const wasDrag = dx > 5 || dy > 5;

      const clickX = rightClickStart.x;
      const clickY = rightClickStart.y;
      const dot = rightClickDot;

      // Clear stored values
      rightClickStart = null;
      rightClickDot = null;

      // If it was a drag, don't show the card
      if (wasDrag) {
        return;
      }

      // Block if camera is still considered orbiting
      if (window.gameCamera?.wasRightClickDragging?.()) {
        return;
      }

      const { playerId } = dot.userData;
      if (window.profileCard) {
        window.profileCard.show(playerId, clickX, clickY);
      }
    });
  }

  /**
   * Register a dot mesh for interaction tracking
   * @param {THREE.Mesh} dot - The LOD dot mesh with userData
   */
  registerDot(dot) {
    if (dot && !this.dotMeshes.includes(dot)) {
      this.dotMeshes.push(dot);
    }
  }

  /**
   * Unregister a dot mesh (e.g., when bot is destroyed)
   * @param {THREE.Mesh} dot - The LOD dot mesh to remove
   */
  unregisterDot(dot) {
    const index = this.dotMeshes.indexOf(dot);
    if (index !== -1) {
      this.dotMeshes.splice(index, 1);
    }
  }

  /**
   * Check if a click at the given normalized coordinates hit a player dot
   * @param {number} mouseX - Normalized device coordinate X (-1 to 1)
   * @param {number} mouseY - Normalized device coordinate Y (-1 to 1)
   * @returns {Object|null} Player data { playerId, position, faction, username } or null
   */
  getClickedPlayer(mouseX, mouseY) {
    this.raycaster.setFromCamera({ x: mouseX, y: mouseY }, this.camera);
    const visibleDots = this.dotMeshes.filter((d) => d.visible);
    const intersects = this.raycaster.intersectObjects(visibleDots);

    if (intersects.length > 0) {
      // Sort by distance (custom raycast methods don't auto-sort)
      intersects.sort((a, b) => a.distance - b.distance);
      const hit = intersects[0].object;
      const userData = hit.userData;

      // Get world position of the dot
      const position = new THREE.Vector3();
      hit.getWorldPosition(position);

      return {
        playerId: userData.playerId,
        position: position,
        faction: userData.faction,
        username: userData.username,
        isCommander: userData.isCommander,
      };
    }

    return null;
  }

  _updateHover() {
    // Don't show hover effects while orbiting camera
    if (window.gameCamera?.isOrbiting?.()) {
      if (this.hoveredDot) {
        this._clearHoverEffect();
        this.hoveredDot = null;
      }
      this.nameTag.style.display = "none";
      return;
    }

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const visibleDots = this.dotMeshes.filter((d) => d.visible);
    const intersects = this.raycaster.intersectObjects(visibleDots);

    if (intersects.length > 0) {
      // Sort by distance (custom raycast methods don't auto-sort)
      intersects.sort((a, b) => a.distance - b.distance);
      const newHovered = intersects[0].object;
      if (newHovered !== this.hoveredDot) {
        // Clear previous hover effect
        this._clearHoverEffect();
        // Apply new hover effect
        this.hoveredDot = newHovered;
        this._applyHoverEffect();
      }
      this._showNameTag();
    } else {
      if (this.hoveredDot) {
        this._clearHoverEffect();
        this.hoveredDot = null;
      }
      this.nameTag.style.display = "none";
    }
  }

  _applyHoverEffect() {
    if (!this.hoveredDot) return;

    // Scale up the dot
    this.hoveredDot.scale.setScalar(this._hoverScale);

    // Clone material to avoid affecting other dots sharing the same material
    const originalMaterial = this.hoveredDot.material;
    if (
      originalMaterial &&
      originalMaterial.uniforms &&
      originalMaterial.uniforms.uColor
    ) {
      this._originalMaterial = originalMaterial;
      const clonedMaterial = originalMaterial.clone();
      // Brighten the color on the cloned material
      const brightened = originalMaterial.uniforms.uColor.value.clone();
      brightened.r = Math.min(1.0, brightened.r * this._brightenFactor);
      brightened.g = Math.min(1.0, brightened.g * this._brightenFactor);
      brightened.b = Math.min(1.0, brightened.b * this._brightenFactor);
      clonedMaterial.uniforms.uColor.value = brightened;
      this.hoveredDot.material = clonedMaterial;
    }
  }

  _clearHoverEffect() {
    if (!this.hoveredDot) return;

    // Restore original scale
    this.hoveredDot.scale.setScalar(this._originalScale);

    // Restore original shared material
    if (this._originalMaterial) {
      this.hoveredDot.material = this._originalMaterial;
      this._originalMaterial = null;
    }
  }

  _showNameTag() {
    const { username, squad, isCommander } = this.hoveredDot.userData;
    const prefix = squad ? `[${squad}] ` : "";

    if (isCommander) {
      this.nameTag.textContent = `★ ${prefix}${username} (Commander)`;
      this.nameTag.style.color = "#FFD700";
    } else {
      this.nameTag.textContent = `${prefix}${username}`;
      this.nameTag.style.color = "#fff";
    }

    this.nameTag.style.display = "block";
    this.nameTag.style.left = this._mouseX + 15 + "px";
    this.nameTag.style.top = this._mouseY + 15 + "px";
  }

  /**
   * Enable or disable the interaction system
   * @param {boolean} active - Whether interactions should be active
   */
  setActive(active) {
    this.active = active;
    if (!active) {
      this._clearHoverEffect();
      this.nameTag.style.display = "none";
      this.hoveredDot = null;
    }
  }

  /**
   * Update a dot's userData (e.g., when name or commander status changes)
   * @param {string} playerId - The player/bot ID
   * @param {Object} data - Updated userData properties
   */
  updateDotData(playerId, data) {
    for (const dot of this.dotMeshes) {
      if (dot.userData.playerId === playerId) {
        Object.assign(dot.userData, data);
        break;
      }
    }
  }
}
