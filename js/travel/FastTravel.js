/**
 * AdLands - Fast Travel Module
 * Coordinates portal-based fast travel system
 */

class FastTravel {
    constructor(scene, planet, tank, gameCamera, renderer) {
        this.scene = scene;
        this.planet = planet;
        this.tank = tank;
        this.gameCamera = gameCamera;
        this.renderer = renderer;

        // State machine: 'inactive' | 'fastTravel' | 'preview'
        this.state = 'inactive';
        this.active = false;

        // Track entry portal for abort
        this.originTheta = 0;
        this.originPhi = 0;
        this.originPortalIndex = null;

        // Track planet rotation during fast travel (for abort correction)
        this.accumulatedRotation = 0;

        // Preview state
        this.previewPortalIndex = null;

        // Beam retraction animation
        this.beamRetractProgress = 0;
        this.beamRetractTarget = 0;
        this.beamRetractSpeed = 3;  // Per second

        // Raycaster for portal/beam clicks
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // Create visual systems
        this.skyBeams = new SkyBeams(scene, planet);

        // Effect systems
        this.dustShockwave = null;

        // Reference to bot tanks for spawn collision checking
        this.botTanks = null;

        // Multiplayer callback: when set, portal selection goes through server
        this.onPortalChosen = null;

        // Called when entering/leaving portal preview (so server can send nearby bots)
        this.onPreviewPortal = null;

        // Called when entering fast travel (commander leaves planet surface)
        this.onEnterFastTravel = null;

        // Minimum spawn distance from other tanks (in radians on sphere surface)
        this.minSpawnDistance = 0.03;  // ~3 degrees apart

        // Guard against double-sends while waiting for server confirmation
        this._awaitingConfirmation = false;

        // Setup click handler
        this._setupEventListeners();
    }

    setDustShockwave(dustShockwave) {
        this.dustShockwave = dustShockwave;
    }

    setBotTanks(botTanks) {
        this.botTanks = botTanks;
    }

    /**
     * Check if a click at the given screen coordinates would hit a sky beam.
     * Used to prevent ping placement when selecting fast travel destinations.
     * @param {number} mouseX - Normalized device coordinate X (-1 to 1)
     * @param {number} mouseY - Normalized device coordinate Y (-1 to 1)
     * @returns {boolean} True if click would hit a visible beam
     */
    isClickOnBeam(mouseX, mouseY) {
        // Check if any visible beam is hit, regardless of fast travel state
        // This prevents pings whenever beams are visible and clicked
        const beamMeshes = this.skyBeams.getBeamMeshes().filter(b => b.visible);
        if (beamMeshes.length === 0) return false;

        this.raycaster.setFromCamera({ x: mouseX, y: mouseY }, this.gameCamera.camera);
        const beamIntersects = this.raycaster.intersectObjects(beamMeshes);

        return beamIntersects.length > 0;
    }

    // ========================
    // PUBLIC METHODS
    // ========================

    update(deltaTime, planetRotationSpeed = 0) {
        if (!this.active) return;

        // Track planet rotation during fast travel (for abort correction)
        // Same formula as tank uses: planetRotationSpeed / 60
        this.accumulatedRotation += planetRotationSpeed / 60;

        // Update sky beams animation
        this.skyBeams.update(deltaTime);

        // Animate beam retraction
        if (this.beamRetractProgress !== this.beamRetractTarget) {
            const diff = this.beamRetractTarget - this.beamRetractProgress;
            const step = this.beamRetractSpeed * deltaTime;

            if (Math.abs(diff) <= step) {
                this.beamRetractProgress = this.beamRetractTarget;
            } else {
                this.beamRetractProgress += Math.sign(diff) * step;
            }

            this.skyBeams.setRetraction(this.beamRetractProgress);
        }

        // Update camera preview target to follow portal as planet rotates
        if (this.state === 'preview' && this.previewPortalIndex !== null) {
            this._updatePreviewCameraTarget();
        }
    }

    _updatePreviewCameraTarget() {
        // Get portal position in local space
        const portalPosLocal = this.planet.getPortalPosition(this.previewPortalIndex);
        if (!portalPosLocal) return;

        // Transform to world space (account for planet rotation)
        const portalPosWorld = portalPosLocal.clone();
        this.planet.hexGroup.localToWorld(portalPosWorld);

        // Update camera's preview target angles
        const normal = portalPosWorld.clone().normalize();
        this.gameCamera.previewTheta = Math.atan2(normal.z, normal.x);
        this.gameCamera.previewPhi = Math.acos(normal.y);
    }

    checkPortalEntry() {
        // Returns portal index if tank is on a portal, null otherwise
        if (this.active) return null;

        const tankPos = this.tank.getPosition();
        return this.planet.isOnPortal(tankPos);
    }

    enterFastTravel(portalIndex) {
        if (this.active) return;

        // Economy: client-side pre-check for fast travel cost
        const ftCost = 500;
        if (window.cryptoSystem) {
            const balance = (window.dashboard && window.dashboard._lastServerCrypto !== undefined)
                ? window.dashboard._lastServerCrypto
                : window.cryptoSystem.stats.totalCrypto;
            if (balance < ftCost) {
                if (window.dashboard) {
                    window.dashboard.showToast?.(`Not enough crypto for fast travel (need ¢${ftCost})`);
                }
                if (window.tuskCommentary) {
                    window.tuskCommentary.onBroke?.();
                }
                return;
            }
        }

        this.active = true;
        this.state = 'fastTravel';

        // Store origin for abort
        this.originTheta = this.tank.state.theta;
        this.originPhi = this.tank.state.phi;
        this.originPortalIndex = portalIndex;
        this.accumulatedRotation = 0; // Reset rotation tracking

        // Show sky beams (fully extended), excluding origin portal
        this.beamRetractProgress = 0;
        this.beamRetractTarget = 0;
        this.skyBeams.show(portalIndex);

        // Transition camera to fast travel view
        this.gameCamera.startFastTravelTransition();

        // Show UI
        this._showFastTravelUI();

        // Disable tank controls and hide tank
        this.tank.setControlsEnabled(false);
        this.tank.setVisible(false);

        // Notify that commander has left the planet surface
        if (this.onEnterFastTravel) {
            this.onEnterFastTravel();
        }
    }

    /**
     * Enter fast travel mode at game start (no origin portal)
     * Used when starting the game in deployment selection
     */
    enterFastTravelAtStart() {
        if (this.active) return;

        this.active = true;
        this.state = 'fastTravel';
        this.isRespawning = false;

        // No origin portal - player is deploying fresh
        this.originTheta = 0;
        this.originPhi = Math.PI / 2;
        this.originPortalIndex = null;  // No origin to exclude
        this.accumulatedRotation = 0;

        // Show all sky beams (no exclusion since no origin)
        this.beamRetractProgress = 0;
        this.beamRetractTarget = 0;
        this.skyBeams.show(null);  // Pass null to show all beams

        // Camera is already in fast travel mode (set by main.js)

        // Show UI
        this._showFastTravelUI();

        // Tank controls already disabled and tank hidden by main.js
        this.tank.setVisible(false);
    }

    /**
     * Start respawn flow after player death
     * Similar to enterFastTravelAtStart but shows respawn message
     */
    startRespawn() {
        if (this.active) return;

        this.active = true;
        this.state = 'fastTravel';
        this.isRespawning = true;

        // No origin portal - player is respawning
        this.originTheta = 0;
        this.originPhi = Math.PI / 2;
        this.originPortalIndex = null;
        this.accumulatedRotation = 0;

        // Show all sky beams
        this.beamRetractProgress = 0;
        this.beamRetractTarget = 0;
        this.skyBeams.show(null);

        // Transition camera to fast travel view
        this.gameCamera.startFastTravelTransition();

        // Show UI with respawn message
        this._showFastTravelUI();

        // Tank is already hidden from death fade
    }

    // ========================
    // INTERNAL STATE TRANSITIONS
    // ========================

    _enterPreview(portalIndex) {
        this.state = 'preview';
        this.previewPortalIndex = portalIndex;

        // Notify server so it sends bots near this portal
        if (this.onPreviewPortal) this.onPreviewPortal(portalIndex);

        // Get portal position in local space
        const portalPosLocal = this.planet.getPortalPosition(portalIndex);
        if (!portalPosLocal) {
            console.error('Could not find portal position for index', portalIndex);
            return;
        }

        // Transform to world space (account for planet rotation)
        const portalPosWorld = portalPosLocal.clone();
        this.planet.hexGroup.localToWorld(portalPosWorld);

        // Retract beams
        this.beamRetractTarget = 1;

        // Hide fast travel controls while transitioning
        const fastTravelControls = document.getElementById('fast-travel-controls');
        if (fastTravelControls) fastTravelControls.classList.add('hidden');

        // Show preview UI only after camera arrives
        this.gameCamera.onTransitionComplete = () => {
            this._showPreviewUI();
        };

        // Transition camera to preview (pass planet for rotation tracking)
        this.gameCamera.startPortalPreviewTransition(portalPosWorld, this.planet, portalIndex);
    }

    _returnToFastTravel() {
        this.state = 'fastTravel';
        this.previewPortalIndex = null;

        // Clear preview so server stops sending bots for that portal
        if (this.onPreviewPortal) this.onPreviewPortal(null);

        // Re-extend beams with shoot-up animation (excluding origin portal if any)
        // Use 1.5 second delay when returning from preview
        this.beamRetractProgress = 0;
        this.beamRetractTarget = 0;
        this.skyBeams.reextendWithAnimation(this.originPortalIndex, 1.5);

        // Return camera to fast travel orbital
        if (this.originPortalIndex !== null) {
            // Get origin portal position in world space
            const originPosLocal = this.planet.getPortalPosition(this.originPortalIndex);
            const originPosWorld = originPosLocal.clone();
            this.planet.hexGroup.localToWorld(originPosWorld);
            this.gameCamera.returnToFastTravel(originPosWorld);
        } else {
            // Initial deployment - no origin portal, just return to orbital view
            this.gameCamera.returnToFastTravel(null);
        }

        // Update UI
        this._showFastTravelUI();
    }

    _executeTravel() {
        console.log('[FastTravel] _executeTravel — previewPortalIndex:', this.previewPortalIndex, 'onPortalChosen:', !!this.onPortalChosen);
        if (this.previewPortalIndex === null) { console.warn('[FastTravel] previewPortalIndex is null, aborting'); return; }

        // Multiplayer: send portal choice to server, wait for confirmation
        if (this.onPortalChosen) {
            if (this._awaitingConfirmation) return; // Already waiting for server
            this._awaitingConfirmation = true;

            console.log('[FastTravel] Sending portal choice to server:', this.previewPortalIndex);
            this.onPortalChosen(this.previewPortalIndex);
            // Hide UI while waiting for server confirmation
            this._hideAllUI();

            // Timeout: if server never responds, re-show UI so player can retry
            this._portalTimeout = setTimeout(() => {
                this._awaitingConfirmation = false;
                if (this.state === 'preview') {
                    console.warn('[FastTravel] Portal confirmation timed out — re-showing UI');
                    this._showPreviewUI();
                }
            }, 3000);
            return;
        }

        // Single-player: teleport to a random hex adjacent to the portal
        const neutralNeighbors = this.planet.getPortalNeutralNeighbors(this.previewPortalIndex);
        if (neutralNeighbors.length === 0) {
            this._teleportToTile(this.previewPortalIndex);
        } else {
            const targetTile = neutralNeighbors[Math.floor(Math.random() * neutralNeighbors.length)];
            this._teleportToTile(targetTile);
        }

        // Exit fast travel
        this._exitFastTravel();
    }

    _teleportToTile(tileIndex) {
        const tilePosLocal = this.planet.getPortalPosition(tileIndex);
        if (!tilePosLocal) return;

        // Compute spherical coords from local-space position
        const r = tilePosLocal.length();
        const localPhi = Math.acos(tilePosLocal.y / r);
        const localTheta = Math.atan2(tilePosLocal.z, tilePosLocal.x);

        // Tank is parented to hexGroup, so theta is in local (hex) space already
        let baseTheta = localTheta;
        let basePhi = localPhi;

        // Find a spawn position that doesn't overlap with other tanks
        let theta, phi;
        let attempts = 0;
        const maxAttempts = 20;

        do {
            const offsetMagnitude = 0.002 + attempts * 0.001;
            const randomAngle = Math.random() * Math.PI * 2;
            const randomRadius = Math.random() * offsetMagnitude;

            theta = baseTheta + Math.cos(randomAngle) * randomRadius;
            phi = basePhi + Math.sin(randomAngle) * randomRadius;
            phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));

            attempts++;
        } while (attempts < maxAttempts && this._isSpawnBlocked(theta, phi));

        this.tank.teleportTo(theta, phi);

        if (window.tuskCommentary) {
            window.tuskCommentary.onPortalUse();
        }
    }

    /**
     * Check if a spawn position is too close to any other tank
     * @param {number} theta - Longitude in radians
     * @param {number} phi - Latitude in radians
     * @returns {boolean} True if position is blocked
     */
    _isSpawnBlocked(theta, phi) {
        if (!this.botTanks) return false;

        // Both bots and player are hexGroup children — theta is in the same local space
        for (const bot of this.botTanks.bots) {
            if (bot.isDead || bot.isDeploying) continue;

            const dTheta = theta - bot.theta;
            const dPhi = phi - bot.phi;

            // Approximate spherical distance (works well for small distances)
            const avgPhi = (phi + bot.phi) / 2;
            const dist = Math.sqrt(dPhi * dPhi + Math.pow(dTheta * Math.sin(avgPhi), 2));

            if (dist < this.minSpawnDistance) {
                return true;
            }
        }

        return false;
    }

    _abortTravel() {
        // Travel back to origin portal (same as traveling to any other portal, skip confirmation)
        this.previewPortalIndex = this.originPortalIndex;
        this._executeTravel();
    }

    _exitFastTravel() {
        this._awaitingConfirmation = false;
        if (this._portalTimeout) {
            clearTimeout(this._portalTimeout);
            this._portalTimeout = null;
        }

        // If respawning, reset the tank and notify callback
        const wasRespawning = this.isRespawning;
        if (wasRespawning) {
            this.tank.resetForRespawn();
            if (this.onRespawnComplete) {
                this.onRespawnComplete();
            }
        }
        this.isRespawning = false;

        this.active = false;
        this.state = 'inactive';
        this.previewPortalIndex = null;

        // Hide beams and clear any highlight
        this.skyBeams.clearHighlight();
        this.skyBeams.hide();

        // Reset cursor
        this.renderer.domElement.style.cursor = 'default';

        // Hide UI
        this._hideAllUI();

        // Show tank immediately (before camera transition)
        this.tank.setVisible(true);

        // Emit dust shockwave at spawn point (half size for spawns)
        if (this.dustShockwave) {
            this.dustShockwave.emit((this.tank.group._cachedWorldPos || this.tank.group.position).clone(), 0.5);
        }

        // Enable controls only when camera arrives
        this.gameCamera.onTransitionComplete = () => {
            this.tank.setControlsEnabled(true);
        };

        // Exit camera fast travel mode (camera swoops down to meet tank)
        this.gameCamera.exitFastTravel();

        // Always notify when exiting fast travel (for crypto enable, etc.)
        if (this.onExitFastTravel) {
            this.onExitFastTravel();
        }
    }

    // ========================
    // CLICK/HOVER HANDLING
    // ========================

    _setupEventListeners() {
        this.renderer.domElement.addEventListener('click', (e) => {
            // Convert mouse to normalized device coordinates
            const mouseX = (e.clientX / window.innerWidth) * 2 - 1;
            const mouseY = -(e.clientY / window.innerHeight) * 2 + 1;

            // ALWAYS block ping when clicking on a visible beam, regardless of fast travel state
            // This prevents pings during initial deployment, respawn, and fast travel
            if (this.isClickOnBeam(mouseX, mouseY)) {
                e.stopPropagation();
            }

            // For actual fast travel handling, check state
            if (!this.active) return;
            if (this.state !== 'fastTravel') return;
            if (this.gameCamera.transitioning) return;

            this.mouse.x = mouseX;
            this.mouse.y = mouseY;

            this._checkPortalClick();
        });

        // Mouse move for hover effects
        this.renderer.domElement.addEventListener('mousemove', (e) => {
            if (!this.active) return;
            if (this.state !== 'fastTravel') return;
            if (this.gameCamera.transitioning) return;

            // Convert mouse to normalized device coordinates
            this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

            this._checkPortalHover();
        });
    }

    _checkPortalHover() {
        this.raycaster.setFromCamera(this.mouse, this.gameCamera.camera);

        // Check intersection with sky beams (only visible ones, excludes origin)
        const beamMeshes = this.skyBeams.getBeamMeshes().filter(b => b.visible);
        const beamIntersects = this.raycaster.intersectObjects(beamMeshes);

        if (beamIntersects.length > 0) {
            const hoveredBeam = beamIntersects[0].object;
            const portalIndex = this.skyBeams.getPortalIndexFromBeam(hoveredBeam);
            if (portalIndex !== undefined && portalIndex !== this.originPortalIndex) {
                this.skyBeams.highlightBeam(portalIndex);
                this.renderer.domElement.style.cursor = 'pointer';
                return;
            }
        }

        // Also check portal tiles on planet surface (exclude origin)
        const portalCenters = this.planet.getAllPortalCenters().filter(
            idx => idx !== this.originPortalIndex
        );
        const portalMeshes = this.planet.hexGroup.children.filter(mesh =>
            mesh.userData?.tileIndex !== undefined &&
            portalCenters.includes(mesh.userData.tileIndex)
        );

        const tileIntersects = this.raycaster.intersectObjects(portalMeshes);

        if (tileIntersects.length > 0) {
            const portalIndex = tileIntersects[0].object.userData.tileIndex;
            this.skyBeams.highlightBeam(portalIndex);
            this.renderer.domElement.style.cursor = 'pointer';
            return;
        }

        // No hover - clear highlight
        this.skyBeams.clearHighlight();
        this.renderer.domElement.style.cursor = 'default';
    }

    _checkPortalClick() {
        this.raycaster.setFromCamera(this.mouse, this.gameCamera.camera);

        // First check intersection with sky beams (only visible ones, excludes origin)
        const beamMeshes = this.skyBeams.getBeamMeshes().filter(b => b.visible);
        const beamIntersects = this.raycaster.intersectObjects(beamMeshes);

        if (beamIntersects.length > 0) {
            const clickedBeam = beamIntersects[0].object;
            const portalIndex = this.skyBeams.getPortalIndexFromBeam(clickedBeam);
            if (portalIndex !== undefined && portalIndex !== this.originPortalIndex) {
                // Trigger click effect on the beam
                this.skyBeams.triggerClickEffect(portalIndex);
                this._enterPreview(portalIndex);
                return;
            }
        }

        // Also check portal tiles on planet surface (exclude origin)
        const portalCenters = this.planet.getAllPortalCenters().filter(
            idx => idx !== this.originPortalIndex
        );
        const portalMeshes = this.planet.hexGroup.children.filter(mesh =>
            mesh.userData?.tileIndex !== undefined &&
            portalCenters.includes(mesh.userData.tileIndex)
        );

        const tileIntersects = this.raycaster.intersectObjects(portalMeshes);

        if (tileIntersects.length > 0) {
            const portalIndex = tileIntersects[0].object.userData.tileIndex;
            this._enterPreview(portalIndex);
        }
    }

    // ========================
    // UI MANAGEMENT
    // ========================

    _showFastTravelUI() {
        const container = document.getElementById('fast-travel-ui');
        const fastTravelControls = document.getElementById('fast-travel-controls');
        const previewControls = document.getElementById('preview-controls');
        const portalPrompt = document.getElementById('portal-prompt');
        const abortBtn = document.getElementById('abort-travel-btn');
        const hint = fastTravelControls?.querySelector('.fast-travel-hint');
        const title = fastTravelControls?.querySelector('.fast-travel-title');

        if (container) {
            container.classList.remove('hidden');
            container.style.display = ''; // Clear any inline override from VisualEffects._hideUIElements()
        }
        if (fastTravelControls) fastTravelControls.classList.remove('hidden');
        if (previewControls) previewControls.classList.add('hidden');
        if (portalPrompt) portalPrompt.classList.add('hidden');

        // Adjust UI based on mode
        const isInitialDeployment = this.originPortalIndex === null && !this.isRespawning;
        const isRespawn = this.isRespawning;

        if (abortBtn) {
            abortBtn.classList.toggle('hidden', isInitialDeployment || isRespawn);
        }

        if (title) {
            title.textContent = isRespawn ? 'YOU WERE DESTROYED!' : 'FAST TRAVEL';
        }

        if (hint) {
            if (isRespawn) {
                hint.textContent = 'Select a portal to respawn';
            } else if (isInitialDeployment) {
                hint.textContent = 'Click on a portal beam to select deployment zone';
            } else {
                hint.textContent = 'Click on a portal beam to preview destination';
            }
        }
    }

    _showPreviewUI() {
        const container = document.getElementById('fast-travel-ui');
        const fastTravelControls = document.getElementById('fast-travel-controls');
        const previewControls = document.getElementById('preview-controls');
        const travelBtn = document.getElementById('travel-btn');

        // Restore parent container visibility (may have been hidden by _hideAllUI
        // during a failed portal confirmation or server timeout)
        if (container) {
            container.classList.remove('hidden');
            container.style.display = '';
        }
        if (fastTravelControls) fastTravelControls.classList.add('hidden');
        if (previewControls) previewControls.classList.remove('hidden');

        if (travelBtn) {
            travelBtn.textContent = 'Deploy Here!';
        }
    }

    _hideAllUI() {
        const container = document.getElementById('fast-travel-ui');
        const portalPrompt = document.getElementById('portal-prompt');

        if (container) container.classList.add('hidden');
        if (portalPrompt) portalPrompt.classList.add('hidden');
    }

    showPortalPrompt() {
        const portalPrompt = document.getElementById('portal-prompt');
        if (portalPrompt) portalPrompt.classList.remove('hidden');
    }

    hidePortalPrompt() {
        const portalPrompt = document.getElementById('portal-prompt');
        if (portalPrompt) portalPrompt.classList.add('hidden');
    }

    // ========================
    // BUTTON HANDLERS (called from index.html)
    // ========================

    onAbortClick() {
        if (this.state === 'fastTravel' || this.state === 'preview') {
            this._abortTravel();
        }
    }

    onTravelClick() {
        console.log('[FastTravel] onTravelClick — state:', this.state, 'previewPortalIndex:', this.previewPortalIndex, 'onPortalChosen:', !!this.onPortalChosen);
        if (this.state === 'preview') {
            this._executeTravel();
        }
    }

    onGoBackClick() {
        if (this.state === 'preview') {
            this._returnToFastTravel();
        }
    }
}
