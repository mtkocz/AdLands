/**
 * AdLands - Commander Drawing
 * Tactical drawing tool for commanders in orbital view
 * Gold ink, 60-second fade, visible to faction
 */

const DRAWING_CONFIG = {
  color: 0xffd700, // Gold
  lineWidth: 1.6, // Tube radius
  outlineColor: 0x000000, // Black outline
  outlineWidth: 2.2, // Outline tube radius (slightly larger than lineWidth)
  outlineOpacity: 0.5, // Outline opacity
  fadeTime: 60000, // 60 seconds before fade starts
  fadeDuration: 10000, // 10 seconds to fully fade
  maxPointsPerStroke: 500,
  minPointDistance: 3, // Minimum distance between stroke points
  maxStrokeLength: 600, // Maximum total length of a stroke
  heightAboveSurface: 6.25, // How far drawings float above planet
  maxDrawings: 10, // Maximum number of lines (oldest fades when exceeded)
  hideDistance: 260, // Hide drawings when camera closer than this
  hideFadeRange: 30, // Smooth fade range (260-290 units from surface)
};

class CommanderDrawing {
  constructor(scene, camera, planet, sphereRadius, renderer) {
    this.scene = scene;
    this.camera = camera;
    this.planet = planet;
    this.sphereRadius = sphereRadius;
    this.renderer = renderer;
    this.commanderSystem = null;

    // Drawing state
    this.isDrawing = false;
    this.wasDrawing = false; // Track if we just finished drawing (to block click event)
    this.currentStroke = []; // Array of THREE.Vector3 points
    this.currentStrokeLength = 0; // Total length of current stroke
    this.previewMesh = null;

    // All completed drawings
    this.drawings = []; // { mesh, expiry, authorFaction }

    // Materials
    this.drawingMaterial = this._createDrawingMaterial();

    // Raycaster for planet intersection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Create invisible sphere for raycasting (ignores all other objects)
    const raycastGeometry = new THREE.SphereGeometry(this.sphereRadius, 32, 32);
    const raycastMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.raycastSphere = new THREE.Mesh(raycastGeometry, raycastMaterial);
    this.planet.hexGroup.add(this.raycastSphere);

    // Track if drawing is enabled
    this.enabled = false;

    // Setup input
    this._setupInput();
  }

  // ========================
  // MATERIALS
  // ========================

  _createDrawingMaterial() {
    return new THREE.MeshBasicMaterial({
      color: DRAWING_CONFIG.color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
  }

  _createOutlineMaterial() {
    return new THREE.MeshBasicMaterial({
      color: DRAWING_CONFIG.outlineColor,
      transparent: true,
      opacity: DRAWING_CONFIG.outlineOpacity,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  // ========================
  // DEPENDENCY INJECTION
  // ========================

  setCommanderSystem(commanderSystem) {
    this.commanderSystem = commanderSystem;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
  }

  // ========================
  // INPUT
  // ========================

  _setupInput() {
    window.addEventListener("mousedown", (e) => this._onMouseDown(e));
    window.addEventListener("mousemove", (e) => this._onMouseMove(e));
    window.addEventListener("mouseup", (e) => this._onMouseUp(e));
  }

  _onMouseDown(e) {
    if (e.button !== 0) return; // Left click only

    if (!this._canDraw()) {
      // Debug: log why we can't draw
      if (this.commanderSystem && !this.commanderSystem.isHumanCommander()) {
        // Not commander - silent fail
      } else if (
        !window.gameCamera ||
        (window.gameCamera.mode !== "orbital" &&
          window.gameCamera.mode !== "fastTravel")
      ) {
        // Not in right view mode - silent fail
      }
      return;
    }

    // Don't start drawing if clicking on UI
    if (e.target.closest("#dashboard, #chat-wrapper, .game-ui")) {
      return;
    }

    this.isDrawing = true;
    this.currentStroke = [];
    this.currentStrokeLength = 0;

    // Update mouse coordinates from this event
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    // Add first point
    const point = this._getDrawPoint(e);
    if (point) {
      this.currentStroke.push(point);
    } else {
    }
  }

  _onMouseMove(e) {
    this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    if (!this.isDrawing) return;

    const point = this._getDrawPoint(e);
    if (point) {
      // Check minimum distance from last point
      const lastPoint = this.currentStroke[this.currentStroke.length - 1];
      if (lastPoint) {
        const distance = point.distanceTo(lastPoint);
        if (distance < DRAWING_CONFIG.minPointDistance) {
          return;
        }

        // Check if adding this segment would exceed max stroke length
        if (
          this.currentStrokeLength + distance >
          DRAWING_CONFIG.maxStrokeLength
        ) {
          return;
        }

        // Track total stroke length
        this.currentStrokeLength += distance;
      }

      // Add point
      if (this.currentStroke.length < DRAWING_CONFIG.maxPointsPerStroke) {
        this.currentStroke.push(point);
        this._renderPreview();
      }
    }
  }

  _onMouseUp(e) {
    if (!this.isDrawing) return;
    this.isDrawing = false;

    // Finalize stroke if we have enough points (actual drawing occurred)
    if (this.currentStroke.length >= 2) {
      this._finalizeStroke();

      // Set flag to block the click event that follows mouseup
      // Only block if we actually drew something (not a single click)
      this.wasDrawing = true;
      requestAnimationFrame(() => {
        this.wasDrawing = false;
      });
    }
    // If only 1 point, it was a click - let the ping system handle it

    // Clear preview
    this._clearPreview();
    this.currentStroke = [];
  }

  _canDraw() {
    // Must be commander
    if (!this.commanderSystem || !this.commanderSystem.isHumanCommander()) {
      return false;
    }

    // Must be in orbital or fast travel view
    if (!window.gameCamera) return false;
    const mode = window.gameCamera.mode;
    if (mode !== "orbital" && mode !== "fastTravel") {
      return false;
    }

    return true;
  }

  _getDrawPoint(e) {
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Intersect only with the invisible raycast sphere (ignores tanks, dots, etc.)
    const intersects = this.raycaster.intersectObject(
      this.raycastSphere,
      false,
    );

    if (intersects.length > 0) {
      const point = intersects[0].point.clone();

      // Convert to local space
      this.planet.hexGroup.worldToLocal(point);

      // Raise above surface
      const normal = point.clone().normalize();
      point.copy(
        normal.multiplyScalar(
          this.sphereRadius + DRAWING_CONFIG.heightAboveSurface,
        ),
      );

      return point;
    }

    return null;
  }

  // ========================
  // STROKE RENDERING
  // ========================

  _renderPreview() {
    this._clearPreview();

    if (this.currentStroke.length < 2) return;

    this.previewMesh = this._createStrokeMesh(this.currentStroke);
    if (this.previewMesh) {
      // Add outline first (renders behind)
      const outlineMesh = this.previewMesh.userData.outlineMesh;
      if (outlineMesh) {
        this.planet.hexGroup.add(outlineMesh);
      }
      this.planet.hexGroup.add(this.previewMesh);
    }
  }

  _clearPreview() {
    if (this.previewMesh) {
      // Remove outline
      const outlineMesh = this.previewMesh.userData.outlineMesh;
      if (outlineMesh) {
        this.planet.hexGroup.remove(outlineMesh);
        outlineMesh.geometry.dispose();
        outlineMesh.material.dispose();
      }
      this.planet.hexGroup.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      this.previewMesh.material.dispose();
      this.previewMesh = null;
    }
  }

  _finalizeStroke() {
    const mesh = this._createStrokeMesh(this.currentStroke);
    if (!mesh) return;

    // Add outline first (renders behind)
    const outlineMesh = mesh.userData.outlineMesh;
    if (outlineMesh) {
      this.planet.hexGroup.add(outlineMesh);
    }
    this.planet.hexGroup.add(mesh);

    // Add to drawings list with expiry
    this.drawings.push({
      mesh,
      outlineMesh,
      expiry:
        Date.now() + DRAWING_CONFIG.fadeTime + DRAWING_CONFIG.fadeDuration,
      fadeStart: Date.now() + DRAWING_CONFIG.fadeTime,
      authorFaction: window.playerFaction || "unknown",
    });

    // Enforce max drawings cap - start fading oldest drawing immediately
    // (it will be removed by update() after fadeDuration completes)
    while (this.drawings.length > DRAWING_CONFIG.maxDrawings) {
      const oldest = this.drawings[0];
      oldest.fadeStart = Date.now();
      oldest.expiry = Date.now() + DRAWING_CONFIG.fadeDuration;
      // Mark as capped so we don't re-trigger fade on it
      if (oldest._cappedFade) {
        // Already fading from cap, remove immediately if we're still over
        this.drawings.shift();
        this._removeDrawingMeshes(oldest);
      } else {
        oldest._cappedFade = true;
        break; // Let it fade, don't remove more yet
      }
    }

    // Notify Tusk
    if (window.tuskCommentary && window.tuskCommentary.onCommanderDrawing) {
      window.tuskCommentary.onCommanderDrawing("Player");
    }
  }

  _removeDrawingMeshes(drawing) {
    // Remove outline
    if (drawing.outlineMesh) {
      this.planet.hexGroup.remove(drawing.outlineMesh);
      drawing.outlineMesh.geometry.dispose();
      drawing.outlineMesh.material.dispose();
    }
    // Remove main mesh
    this.planet.hexGroup.remove(drawing.mesh);
    drawing.mesh.geometry.dispose();
    drawing.mesh.material.dispose();
  }

  _createStrokeMesh(points, includeOutline = true) {
    if (points.length < 2) return null;

    try {
      // Create smooth curve through points
      const curve = new THREE.CatmullRomCurve3(points);
      const segments = Math.max(8, points.length * 2);

      // Create outline (larger, behind main stroke)
      let outlineMesh = null;
      if (includeOutline) {
        const outlineGeometry = new THREE.TubeGeometry(
          curve,
          segments,
          DRAWING_CONFIG.outlineWidth,
          8,
          false,
        );
        const outlineMaterial = this._createOutlineMaterial();
        outlineMesh = new THREE.Mesh(outlineGeometry, outlineMaterial);
        outlineMesh.renderOrder = 998; // Behind main stroke
      }

      // Create main stroke geometry
      const geometry = new THREE.TubeGeometry(
        curve,
        segments,
        DRAWING_CONFIG.lineWidth,
        8,
        false,
      );

      // Create mesh with fresh material (for individual opacity control)
      const material = this._createDrawingMaterial();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 999; // On top of outline

      // Attach outline reference to main mesh for easy access
      mesh.userData.outlineMesh = outlineMesh;

      return mesh;
    } catch (e) {
      console.warn("[CommanderDrawing] Failed to create stroke mesh:", e);
      return null;
    }
  }

  // ========================
  // UPDATE
  // ========================

  /**
   * Update drawings - handle fading, removal, distance visibility, and faction filtering
   * Call from game loop
   * OPTIMIZED: Early exit when no drawings exist and not actively drawing
   */
  update(timestamp) {
    // Update drawing state based on commander status
    this.enabled = this._canDraw();

    // Early exit if no drawings to update and not currently drawing
    if (this.drawings.length === 0 && !this.isDrawing) {
      return;
    }

    const now = Date.now();
    const viewerFaction = window.playerFaction;

    // Calculate camera distance from planet surface for visibility fade
    const cameraPos = this.camera.getWorldPosition(
      this._tempCameraPos || (this._tempCameraPos = new THREE.Vector3()),
    );
    const cameraDistance = cameraPos.length() - this.sphereRadius;

    // Distance fade factor (0 = hidden when close, 1 = fully visible when far)
    let distanceFade = 1;
    if (cameraDistance < DRAWING_CONFIG.hideDistance) {
      distanceFade = 0;
    } else if (
      cameraDistance <
      DRAWING_CONFIG.hideDistance + DRAWING_CONFIG.hideFadeRange
    ) {
      // Smooth transition between hideDistance and hideDistance + hideFadeRange
      distanceFade =
        (cameraDistance - DRAWING_CONFIG.hideDistance) /
        DRAWING_CONFIG.hideFadeRange;
    }

    // Update existing drawings
    this.drawings = this.drawings.filter((drawing) => {
      // Check if expired
      if (now >= drawing.expiry) {
        // Remove from scene
        this._removeDrawingMeshes(drawing);
        return false;
      }

      // Faction visibility - only show to same faction
      // If either faction is unknown/undefined, allow visibility (pre-deployment state)
      const authorFaction = drawing.authorFaction;
      const factionMatch =
        authorFaction === viewerFaction ||
        !authorFaction ||
        authorFaction === "unknown" ||
        !viewerFaction;

      if (!factionMatch) {
        drawing.mesh.visible = false;
        if (drawing.outlineMesh) drawing.outlineMesh.visible = false;
        return true; // Keep in array but hidden
      }

      // Calculate time-based opacity
      let timeOpacity = 0.9;
      let outlineTimeOpacity = DRAWING_CONFIG.outlineOpacity;
      if (now >= drawing.fadeStart) {
        const fadeProgress =
          (now - drawing.fadeStart) / DRAWING_CONFIG.fadeDuration;
        timeOpacity = Math.max(0, 0.9 * (1 - fadeProgress));
        outlineTimeOpacity = Math.max(
          0,
          DRAWING_CONFIG.outlineOpacity * (1 - fadeProgress),
        );
      }

      // Apply both time fade and distance fade
      drawing.mesh.material.opacity = timeOpacity * distanceFade;
      drawing.mesh.visible = distanceFade > 0;

      // Apply to outline as well
      if (drawing.outlineMesh) {
        drawing.outlineMesh.material.opacity =
          outlineTimeOpacity * distanceFade;
        drawing.outlineMesh.visible = distanceFade > 0;
      }

      return true;
    });
  }

  // ========================
  // CURSOR FEEDBACK
  // ========================

  /**
   * Get whether drawing is currently possible
   * UI can use this to show draw cursor
   */
  isDrawingEnabled() {
    return this._canDraw();
  }

  /**
   * Get whether currently drawing or just finished drawing
   * (wasDrawing blocks the click event that fires after mouseup)
   */
  isCurrentlyDrawing() {
    return this.isDrawing || this.wasDrawing;
  }

  // ========================
  // CLEANUP
  // ========================

  dispose() {
    // Clear preview
    this._clearPreview();

    // Remove all drawings
    this.drawings.forEach((drawing) => {
      this._removeDrawingMeshes(drawing);
    });
    this.drawings = [];

    // Dispose shared material
    if (this.drawingMaterial) {
      this.drawingMaterial.dispose();
    }

    // Remove raycast sphere
    if (this.raycastSphere) {
      this.planet.hexGroup.remove(this.raycastSphere);
      this.raycastSphere.geometry.dispose();
      this.raycastSphere.material.dispose();
    }
  }
}
