/**
 * Presence Chart - Line graph showing cumulative faction presence time over time
 * Uses Canvas 2D API to match the pixelated aesthetic
 * Supports hover interaction to show values at specific points in time
 */

const PresenceChart = (function () {
  // Faction colors matching the game
  const FACTION_COLORS = {
    rust: "#cc4444",
    cobalt: "#5577cc",
    viridian: "#77aa55",
  };

  // Track all chart instances for cleanup
  const instances = new Map();

  // Shared tooltip element (reused across all charts)
  let tooltipEl = null;

  /**
   * Get or create the shared tooltip element
   */
  function getTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "presence-tooltip";
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  /**
   * Format a timestamp for display
   * @param {Date} timestamp
   * @returns {string}
   */
  function formatTime(timestamp) {
    const now = new Date();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ago`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s ago`;
    } else {
      return `${seconds}s ago`;
    }
  }

  /**
   * Format seconds as compact time string for Y-axis labels
   * @param {number} seconds
   * @returns {string}
   */
  function formatSecondsCompact(seconds) {
    if (seconds >= 3600) {
      return Math.round(seconds / 3600) + "h";
    } else if (seconds >= 60) {
      return Math.round(seconds / 60) + "m";
    }
    return seconds + "s";
  }

  /**
   * Format seconds for tooltip display
   * @param {number} seconds
   * @returns {string}
   */
  function formatSecondsLegend(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    }
    return `${secs}s`;
  }

  /**
   * Generate mock time-series data for demonstration (cumulative seconds)
   * @param {number} points - Number of data points to generate
   * @returns {Array} Array of { timestamp, rust, cobalt, viridian } objects
   */
  function generateMockData(points = 24) {
    const data = [];
    const now = Date.now();
    const interval = 30000; // 30 seconds between points

    // Cumulative totals
    let rust = 0,
      cobalt = 0,
      viridian = 0;

    for (let i = 0; i < points; i++) {
      // Randomly add 0-30 seconds per faction per interval
      rust += Math.floor(Math.random() * 31);
      cobalt += Math.floor(Math.random() * 31);
      viridian += Math.floor(Math.random() * 31);

      data.push({
        timestamp: new Date(now - (points - i - 1) * interval),
        rust,
        cobalt,
        viridian,
      });
    }
    return data;
  }

  /**
   * Chart instance class for stateful hover tracking
   */
  class ChartInstance {
    constructor(canvas, sponsorId) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.sponsorId = sponsorId;
      this.data = [];
      this.hoveredIndex = -1;
      this.padding = { top: 8, right: 8, bottom: 16, left: 32 };

      this._setupCanvas();
      this._loadData();
      this._setupEvents();
    }

    _setupCanvas() {
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width || 280;
      this.canvas.height = rect.height || 80;
    }

    _loadData() {
      // Try to load from PresenceTracker if available
      if (typeof PresenceTracker !== "undefined" && this.sponsorId) {
        const history = PresenceTracker.getHistory(this.sponsorId);
        if (history && history.length > 0) {
          this.data = history;
          return;
        }
      }

      // Fallback to mock data for demo
      this.data = generateMockData(24);
    }

    _setupEvents() {
      this.canvas.addEventListener("mousemove", (e) => this._onMouseMove(e));
      this.canvas.addEventListener("mouseleave", () => this._onMouseLeave());
    }

    _onMouseMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;

      const dataIndex = this._getDataIndexAtX(x);
      if (dataIndex !== this.hoveredIndex) {
        this.hoveredIndex = dataIndex;
        this.draw();
        this._updateTooltip(e.clientX, e.clientY);
      } else if (dataIndex >= 0) {
        // Update tooltip position even if same index
        this._updateTooltip(e.clientX, e.clientY);
      }
    }

    _onMouseLeave() {
      this.hoveredIndex = -1;
      this._hideTooltip();
      this.draw();
    }

    _getDataIndexAtX(canvasX) {
      if (this.data.length === 0) return -1;

      const chartWidth =
        this.canvas.width - this.padding.left - this.padding.right;
      const relativeX = canvasX - this.padding.left;

      if (relativeX < 0 || relativeX > chartWidth) return -1;

      const dataIndex = Math.round(
        (relativeX / chartWidth) * (this.data.length - 1),
      );
      return Math.max(0, Math.min(dataIndex, this.data.length - 1));
    }

    _updateTooltip(mouseX, mouseY) {
      if (this.hoveredIndex < 0 || !this.data[this.hoveredIndex]) {
        this._hideTooltip();
        return;
      }

      const sample = this.data[this.hoveredIndex];
      const tooltip = getTooltip();

      const timeStr = formatTime(sample.timestamp);

      tooltip.innerHTML = `
                <div class="presence-tooltip-time">${timeStr}</div>
                <div class="presence-tooltip-row">
                    <span class="presence-tooltip-dot" style="background:${FACTION_COLORS.rust}"></span>
                    <span class="presence-tooltip-label">Rust:</span>
                    <span class="presence-tooltip-value">${formatSecondsLegend(sample.rust)}</span>
                </div>
                <div class="presence-tooltip-row">
                    <span class="presence-tooltip-dot" style="background:${FACTION_COLORS.cobalt}"></span>
                    <span class="presence-tooltip-label">Cobalt:</span>
                    <span class="presence-tooltip-value">${formatSecondsLegend(sample.cobalt)}</span>
                </div>
                <div class="presence-tooltip-row">
                    <span class="presence-tooltip-dot" style="background:${FACTION_COLORS.viridian}"></span>
                    <span class="presence-tooltip-label">Viridian:</span>
                    <span class="presence-tooltip-value">${formatSecondsLegend(sample.viridian)}</span>
                </div>
            `;

      // Position near cursor but within viewport
      const tooltipWidth = 140;
      const tooltipHeight = 90;
      const margin = 10;

      let left = mouseX + margin;
      let top = mouseY - tooltipHeight - margin;

      // Keep within viewport
      if (left + tooltipWidth > window.innerWidth - margin) {
        left = mouseX - tooltipWidth - margin;
      }
      if (top < margin) {
        top = mouseY + margin;
      }

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.classList.add("visible");
    }

    _hideTooltip() {
      const tooltip = getTooltip();
      tooltip.classList.remove("visible");
    }

    _getMaxValue() {
      let maxValue = 0;
      this.data.forEach((d) => {
        maxValue = Math.max(maxValue, d.rust, d.cobalt, d.viridian);
      });
      return Math.max(maxValue, 1);
    }

    draw() {
      const ctx = this.ctx;
      const width = this.canvas.width;
      const height = this.canvas.height;

      // Clear canvas
      ctx.fillStyle = "#1a1a1a";
      ctx.fillRect(0, 0, width, height);

      if (this.data.length === 0) {
        // Show "Collecting data..." message
        ctx.fillStyle = "#666666";
        ctx.font = '12px "Ark Pixel 12px", monospace';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Collecting data...", width / 2, height / 2);
        return;
      }

      const chartWidth = width - this.padding.left - this.padding.right;
      const chartHeight = height - this.padding.top - this.padding.bottom;
      const maxValue = this._getMaxValue();

      // Draw grid lines (subtle)
      ctx.strokeStyle = "#333333";
      ctx.lineWidth = 1;

      for (let i = 0; i <= 4; i++) {
        const y = this.padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(this.padding.left, y);
        ctx.lineTo(width - this.padding.right, y);
        ctx.stroke();
      }

      // Draw Y-axis labels (formatted as time)
      ctx.fillStyle = "#666666";
      ctx.font = '12px "Ark Pixel 12px", monospace';
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      for (let i = 0; i <= 4; i++) {
        const value = Math.round((maxValue * (4 - i)) / 4);
        const y = this.padding.top + (chartHeight / 4) * i;
        ctx.fillText(formatSecondsCompact(value), this.padding.left - 4, y);
      }

      // Draw hover indicator (vertical line) before drawing lines
      if (this.hoveredIndex >= 0 && this.data.length > 1) {
        const hoverX =
          this.padding.left +
          (this.hoveredIndex / (this.data.length - 1)) * chartWidth;

        ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(hoverX, this.padding.top);
        ctx.lineTo(hoverX, this.padding.top + chartHeight);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw lines for each faction
      const factions = ["rust", "cobalt", "viridian"];

      factions.forEach((faction) => {
        ctx.strokeStyle = FACTION_COLORS[faction];
        ctx.lineWidth = 2;
        ctx.beginPath();

        this.data.forEach((d, i) => {
          const x =
            this.padding.left + (i / (this.data.length - 1)) * chartWidth;
          const y =
            this.padding.top +
            chartHeight -
            (d[faction] / maxValue) * chartHeight;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        });

        ctx.stroke();

        // Draw data points as small squares (pixelated look)
        ctx.fillStyle = FACTION_COLORS[faction];
        this.data.forEach((d, i) => {
          const x =
            this.padding.left + (i / (this.data.length - 1)) * chartWidth;
          const y =
            this.padding.top +
            chartHeight -
            (d[faction] / maxValue) * chartHeight;

          // Draw larger point if hovered
          if (i === this.hoveredIndex) {
            ctx.fillRect(x - 3, y - 3, 6, 6);
            // Add white border
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1;
            ctx.strokeRect(x - 3, y - 3, 6, 6);
            ctx.strokeStyle = FACTION_COLORS[faction];
            ctx.lineWidth = 2;
          } else {
            ctx.fillRect(x - 2, y - 2, 4, 4);
          }
        });
      });

      // Draw X-axis label
      ctx.fillStyle = "#666666";
      ctx.font = '12px "Ark Pixel 12px", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("Time →", width / 2, height - 12);
    }

    destroy() {
      this.canvas.removeEventListener("mousemove", this._onMouseMove);
      this.canvas.removeEventListener("mouseleave", this._onMouseLeave);
    }
  }

  /**
   * Initialize a chart on a canvas element
   * @param {HTMLCanvasElement} canvas - Target canvas element
   * @param {string} [sponsorId] - Optional sponsor ID for loading real data
   */
  function init(canvas, sponsorId) {
    if (!canvas) return;

    // Clean up existing instance if any
    if (instances.has(canvas)) {
      instances.get(canvas).destroy();
    }

    const instance = new ChartInstance(canvas, sponsorId);
    instances.set(canvas, instance);
    instance.draw();
  }

  /**
   * Initialize all presence charts in the document
   * Note: This will use mock data since no sponsorId is provided
   * For real data, use init() with sponsorId for each chart
   */
  function initAll() {
    const charts = document.querySelectorAll(".presence-chart");
    charts.forEach((canvas) => {
      init(canvas);
    });
  }

  /**
   * Draw a line graph on the given canvas (legacy API)
   * @param {HTMLCanvasElement} canvas - Target canvas element
   * @param {Array} data - Array of { rust, cobalt, viridian } objects
   */
  function draw(canvas, data) {
    if (!canvas || !data || data.length === 0) return;

    // Convert old format to new format with timestamps
    const now = Date.now();
    const interval = 30000;
    const formattedData = data.map((d, i) => ({
      timestamp: new Date(now - (data.length - i - 1) * interval),
      rust: d.rust,
      cobalt: d.cobalt,
      viridian: d.viridian,
    }));

    // Create or update instance
    if (!instances.has(canvas)) {
      const instance = new ChartInstance(canvas, null);
      instances.set(canvas, instance);
    }

    const instance = instances.get(canvas);
    instance.data = formattedData;
    instance.draw();
  }

  // Public API
  return {
    init,
    initAll,
    draw,
    generateMockData,
    FACTION_COLORS,
  };
})();
