/**
 * AdLands - Screenshot & Share System
 * Captures game canvas, adds watermark, and enables sharing
 */

class ScreenshotSystem {
  constructor(renderer, badgeSystem = null) {
    this.renderer = renderer;
    this.badgeSystem = badgeSystem;

    // Current screenshot data
    this.currentScreenshot = null;
    this.screenshotHistory = [];
    this.maxHistory = 10;

    // Caption templates
    this.captionTemplates = [
      "Just captured {cluster} for {faction}!",
      "{kills} kills and counting. #AdLands",
      "The {faction} war machine rolls on.",
      "Another day, another hex. #AdLands",
      "Corporate warfare at its finest.",
      "Dominating the battlefield. #AdLands",
      "{faction} forever.",
      "Victory tastes sweet. #AdLands",
    ];

    // Watermark config
    this.watermark = {
      text: "AdLands - adlands.gg",
      position: "bottom-right",
      padding: 16,
      fontSize: 16,
      fontFamily: '"Atari ST 8x16", monospace',
      color: "rgba(255, 255, 255, 0.7)",
      shadowColor: "rgba(0, 0, 0, 0.5)",
    };

    // Stats overlay config
    this.showStatsOverlay = false;

    // DOM references
    this.previewElement = null;
    this.captionInput = null;

    // Callbacks
    this.onScreenshotTaken = null;
    this.onShare = null;

  }

  // ========================
  // SCREENSHOT CAPTURE
  // ========================

  /**
   * Capture a screenshot from the renderer (includes full viewport with UI)
   * Uses manual compositing: WebGL canvas + UI overlay for correct transparency
   */
  async capture(options = {}) {
    if (!this.renderer) {
      console.error("[ScreenshotSystem] No renderer available");
      return null;
    }

    const {
      hideUI = false, // Include UI in screenshots by default
      addWatermark = true,
      addStats = this.showStatsOverlay,
      quality = 1.0,
    } = options;

    try {
      // Force a render to ensure WebGL canvas is up-to-date
      if (this.renderer.render && window.scene && window.camera) {
        this.renderer.render(window.scene, window.camera);
      }

      const rendererCanvas = this.renderer.domElement;
      const width = window.innerWidth;
      const height = window.innerHeight;

      // IMPORTANT: Capture WebGL canvas content immediately into an image
      // The force-render above ensures the buffer is fresh (preserveDrawingBuffer not needed)
      const gameImageData = rendererCanvas.toDataURL("image/png");
      const gameImage = await this._loadImage(gameImageData);

      // Create final compositing canvas
      const finalCanvas = document.createElement("canvas");
      finalCanvas.width = width;
      finalCanvas.height = height;
      const finalCtx = finalCanvas.getContext("2d");

      // Step 1: Draw the captured game image as base layer
      finalCtx.drawImage(gameImage, 0, 0, width, height);

      // Step 2: Capture and composite UI if not hiding it
      if (!hideUI) {
        // Hide all canvases so html2canvas only captures HTML UI elements
        const allCanvases = document.querySelectorAll("canvas");
        const hiddenCanvases = [];
        allCanvases.forEach((canvas) => {
          hiddenCanvases.push({ el: canvas, vis: canvas.style.visibility });
          canvas.style.visibility = "hidden";
        });

        // Capture UI elements only (with transparent background)
        const uiCanvas = await html2canvas(document.body, {
          useCORS: true,
          allowTaint: true,
          backgroundColor: null, // Transparent background
          scale: 1,
          logging: false,
          width: width,
          height: height,
        });

        // Restore canvas visibility
        hiddenCanvases.forEach((item) => {
          item.el.style.visibility = item.vis;
        });

        // Composite UI on top of game
        finalCtx.drawImage(uiCanvas, 0, 0);
      }

      let imageData = finalCanvas.toDataURL("image/png", quality);

      // Process image (add watermark, stats)
      if (addWatermark || addStats) {
        imageData = await this._processImage(imageData, addWatermark, addStats);
      }

      // Create screenshot object
      const screenshot = {
        id: Date.now().toString(),
        dataUrl: imageData,
        timestamp: new Date().toISOString(),
        caption: this._generateCaption(),
        stats: this._captureStats(),
      };

      this.currentScreenshot = screenshot;

      // Add to history
      this.screenshotHistory.unshift(screenshot);
      if (this.screenshotHistory.length > this.maxHistory) {
        this.screenshotHistory.pop();
      }

      // Save to localStorage (just metadata, not full images)
      this._saveHistory();

      // Track for badges
      if (this.badgeSystem) {
        this.badgeSystem.trackScreenshot();
      }

      // Trigger callback
      if (this.onScreenshotTaken) {
        this.onScreenshotTaken(screenshot);
      }

      return screenshot;
    } catch (error) {
      console.error("[ScreenshotSystem] Capture failed:", error);
      return null;
    }
  }

  /**
   * Load an image from a data URL
   */
  _loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /**
   * Process image - add watermark and stats overlay
   */
  async _processImage(dataUrl, addWatermark, addStats) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");

        // Draw original image
        ctx.drawImage(img, 0, 0);

        // Add watermark
        if (addWatermark) {
          this._drawWatermark(ctx, canvas.width, canvas.height);
        }

        // Add stats overlay
        if (addStats) {
          this._drawStatsOverlay(ctx, canvas.width, canvas.height);
        }

        resolve(canvas.toDataURL("image/png"));
      };
      img.src = dataUrl;
    });
  }

  /**
   * Draw watermark on canvas
   */
  _drawWatermark(ctx, width, height) {
    const wm = this.watermark;

    ctx.font = `${wm.fontSize}px ${wm.fontFamily}`;
    ctx.textBaseline = "bottom";

    const text = wm.text;

    let x, y;

    switch (wm.position) {
      case "bottom-left":
        x = wm.padding;
        y = height - wm.padding;
        ctx.textAlign = "left";
        break;
      case "bottom-right":
      default:
        x = width - wm.padding;
        y = height - wm.padding;
        ctx.textAlign = "right";
        break;
      case "top-left":
        x = wm.padding;
        y = wm.padding + wm.fontSize;
        ctx.textAlign = "left";
        break;
      case "top-right":
        x = width - wm.padding;
        y = wm.padding + wm.fontSize;
        ctx.textAlign = "right";
        break;
    }

    // Draw shadow
    ctx.fillStyle = wm.shadowColor;
    ctx.fillText(text, x + 2, y + 2);

    // Draw text
    ctx.fillStyle = wm.color;
    ctx.fillText(text, x, y);
  }

  /**
   * Draw stats overlay on canvas
   */
  _drawStatsOverlay(ctx, width, height) {
    const stats = this._captureStats();
    if (!stats) return;

    const padding = 16;
    const lineHeight = 20;
    const fontSize = 12; // 3 grid units - pixel-perfect

    // Draw semi-transparent background
    const lines = [
      `${stats.playerName} [${stats.title}]`,
      `${stats.faction} - Level ${stats.level}`,
      `K/D: ${stats.kills}/${stats.deaths}`,
    ];

    const boxHeight = lines.length * lineHeight + padding * 2;
    const boxWidth = 200;
    const boxX = padding;
    const boxY = padding;

    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

    // Draw text
    ctx.font = `${fontSize}px "Ark Pixel 12px", monospace`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    lines.forEach((line, i) => {
      ctx.fillText(line, boxX + padding, boxY + padding + i * lineHeight);
    });
  }

  // ========================
  // CAPTION GENERATION
  // ========================

  /**
   * Generate a caption from templates
   */
  _generateCaption() {
    const template =
      this.captionTemplates[
        Math.floor(Math.random() * this.captionTemplates.length)
      ];

    const stats = this._captureStats();

    return template
      .replace("{cluster}", stats?.lastCluster || "a cluster")
      .replace("{faction}", stats?.faction || "the faction")
      .replace("{kills}", stats?.kills || "0");
  }

  /**
   * Capture current game stats
   */
  _captureStats() {
    const cryptoSystem = window.cryptoSystem;
    const titleSystem = window.titleSystem;

    return {
      playerName: window.playerName || "Player",
      faction: window.playerFaction || "rust",
      level: cryptoSystem?.stats?.level || 1,
      kills: cryptoSystem?.stats?.kills || 0,
      deaths: cryptoSystem?.stats?.deaths || 0,
      title: titleSystem?.getTitle() || "Contractor",
      lastCluster: window.lastCapturedCluster || "territory",
      timestamp: new Date().toISOString(),
    };
  }

  // ========================
  // SHARING
  // ========================

  /**
   * Share to Twitter/X - copies image to clipboard first, then opens Twitter
   */
  async shareToTwitter(caption = null) {
    const screenshot = this.currentScreenshot;
    if (!screenshot) {
      console.warn("[ScreenshotSystem] No screenshot to share");
      return false;
    }

    // Copy image to clipboard first so user can paste it
    await this.copyImage();

    // Include @AdLands handle in the tweet
    const captionText = caption || screenshot.caption;
    const text = encodeURIComponent(`${captionText} @AdLands`);
    const url = encodeURIComponent("https://adlands.gg");

    // Twitter intent URL - user can paste the image from clipboard
    const twitterUrl = `https://twitter.com/intent/tweet?text=${text}&url=${url}`;

    window.open(twitterUrl, "_blank", "width=550,height=420");

    // Show hint to user
    this._showShareHint("Image copied! Paste (Ctrl+V) in the tweet.");

    this._trackShare("twitter");
    return true;
  }

  /**
   * Share to Reddit - copies image to clipboard first, then opens Reddit
   */
  async shareToReddit(caption = null) {
    const screenshot = this.currentScreenshot;
    if (!screenshot) return false;

    // Copy image to clipboard first
    await this.copyImage();

    const title = encodeURIComponent(caption || screenshot.caption);

    // Open Reddit image submission page
    const redditUrl = `https://www.reddit.com/submit?type=IMAGE&title=${title}`;

    window.open(redditUrl, "_blank");

    // Show hint to user
    this._showShareHint("Image copied! Paste (Ctrl+V) on Reddit.");

    this._trackShare("reddit");
    return true;
  }

  /**
   * Copy link to clipboard (for Discord, etc.) - also copies image
   */
  async copyLink() {
    // Copy image instead of just link for Discord
    const success = await this.copyImage();
    if (success) {
      this._showShareHint("Image copied! Paste in Discord/chat.");
    }
    return success;
  }

  /**
   * Show a temporary hint message to the user
   */
  _showShareHint(message) {
    // Remove any existing hint
    const existing = document.getElementById("share-hint");
    if (existing) existing.remove();

    const hint = document.createElement("div");
    hint.id = "share-hint";
    hint.textContent = message;
    hint.style.cssText = `
            position: fixed;
            bottom: 100px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.85);
            color: #ffd700;
            padding: 12px 24px;
            font-family: 'Atari ST 8x16', monospace;
            font-size: 16px;
            border: 2px solid #ffd700;
            z-index: 10000;
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.5s ease;
        `;
    document.body.appendChild(hint);

    // Fade out and remove after 3 seconds
    setTimeout(() => {
      hint.style.opacity = "0";
      setTimeout(() => hint.remove(), 500);
    }, 3000);
  }

  /**
   * Download screenshot
   */
  download(filename = null) {
    const screenshot = this.currentScreenshot;
    if (!screenshot) {
      console.warn("[ScreenshotSystem] No screenshot to download");
      return false;
    }

    const defaultName = `adlands_${Date.now()}.png`;
    const link = document.createElement("a");
    link.download = filename || defaultName;
    link.href = screenshot.dataUrl;
    link.click();

    this._trackShare("download");
    return true;
  }

  /**
   * Copy image to clipboard
   */
  async copyImage() {
    const screenshot = this.currentScreenshot;
    if (!screenshot) return false;

    try {
      // Convert data URL to blob
      const response = await fetch(screenshot.dataUrl);
      const blob = await response.blob();

      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);

      return true;
    } catch (error) {
      console.error("[ScreenshotSystem] Failed to copy image:", error);
      return false;
    }
  }

  /**
   * Track share event
   */
  _trackShare(platform) {
    if (this.badgeSystem) {
      this.badgeSystem.trackSocialShare();
    }

    if (this.onShare) {
      this.onShare(platform, this.currentScreenshot);
    }

  }

  // ========================
  // HISTORY
  // ========================

  /**
   * Get screenshot history
   */
  getHistory() {
    return this.screenshotHistory;
  }

  /**
   * Clear history
   */
  clearHistory() {
    this.screenshotHistory = [];
    this._saveHistory();
  }

  /**
   * Load history from localStorage
   */
  _loadHistory() {
    try {
      const saved = localStorage.getItem("adlands_screenshots");
      if (saved) {
        const data = JSON.parse(saved);
        // Only load metadata, not full images
        this.screenshotHistory = data.map((s) => ({
          ...s,
          dataUrl: null, // Clear data URLs to save memory
        }));
      }
    } catch (e) {
      console.warn("[ScreenshotSystem] Failed to load history:", e);
    }
  }

  /**
   * Save history to localStorage (metadata only)
   */
  _saveHistory() {
    try {
      const metadata = this.screenshotHistory.map((s) => ({
        id: s.id,
        timestamp: s.timestamp,
        caption: s.caption,
        stats: s.stats,
      }));
      localStorage.setItem("adlands_screenshots", JSON.stringify(metadata));
    } catch (e) {
      console.warn("[ScreenshotSystem] Failed to save history:", e);
    }
  }

  // ========================
  // UI INTEGRATION
  // ========================

  /**
   * Bind to dashboard share panel elements
   */
  bindToDashboard() {
    // Screenshot button
    const screenshotBtn = document.getElementById("btn-screenshot");
    if (screenshotBtn) {
      screenshotBtn.addEventListener("click", async () => {
        await this.capture();
        this._updatePreview();
      });
    }

    // Share buttons
    const shareButtons = document.querySelectorAll(".social-share-btn");
    shareButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const platform = btn.dataset.platform;
        this._handleShareClick(platform);
      });
    });

    // Preview element
    this.previewElement = document.getElementById("share-preview");

  }

  /**
   * Handle share button click
   */
  _handleShareClick(platform) {
    if (!this.currentScreenshot) {
      console.warn("[ScreenshotSystem] No screenshot to share");
      return;
    }

    switch (platform) {
      case "twitter":
        this.shareToTwitter();
        break;
      case "reddit":
        this.shareToReddit();
        break;
      case "discord":
        this.copyLink();
        break;
      case "download":
        this.download();
        break;
    }
  }

  /**
   * Update preview element
   */
  _updatePreview() {
    if (!this.previewElement || !this.currentScreenshot) return;

    this.previewElement.innerHTML = `
            <img src="${this.currentScreenshot.dataUrl}"
                 alt="Screenshot preview"
                 style="width: 100%; height: auto; image-rendering: pixelated;">
        `;

    // Enable share buttons
    const shareButtons = document.querySelectorAll(".social-share-btn");
    shareButtons.forEach((btn) => {
      btn.disabled = false;
    });
  }

  // ========================
  // QUICK CAPTURE (F12)
  // ========================

  /**
   * Setup F12 quick capture
   */
  setupQuickCapture() {
    document.addEventListener("keydown", async (e) => {
      if (window._authScreenInstance?.isVisible) return;
      if (e.key === "F12") {
        e.preventDefault();
        const screenshot = await this.capture();
        if (screenshot) {
          this._showCaptureFlash();
        }
      }
    });

  }

  /**
   * Show capture flash effect
   */
  _showCaptureFlash() {
    const flash = document.createElement("div");
    flash.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: white;
            pointer-events: none;
            z-index: 99999;
            opacity: 0.8;
            transition: opacity 0.3s ease;
        `;
    document.body.appendChild(flash);

    requestAnimationFrame(() => {
      flash.style.opacity = "0";
      setTimeout(() => flash.remove(), 300);
    });
  }
}
