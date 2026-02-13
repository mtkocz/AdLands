/**
 * AdLands - Pricing Panel
 * Displays tier breakdown, pricing, and bulk discounts for selected hexes
 */

/** Format a number as USD with commas, e.g. 1234567.8 → "1,234,567.80" */
function _fmtUSD(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

class PricingPanel {
  constructor(containerElement, options = {}) {
    this.container = containerElement;
    this.onTierFilter = options.onTierFilter || null;
    this.currentFilter = null;

    this._render();
  }

  _render() {
    this.container.innerHTML = `
      <div class="panel-title">Pricing Calculator</div>

      <!-- Tier Legend -->
      <div class="pricing-section">
        <div class="pricing-section-title">Territory Tiers</div>
        <div id="tier-legend"></div>
      </div>

      <!-- Pricing Summary -->
      <div class="pricing-section">
        <div class="pricing-section-title">Sponsorship Quote</div>
        <div id="pricing-summary">
          <div class="pricing-empty-state">Select hexes to see pricing</div>
        </div>
      </div>

      <!-- Discount Schedule -->
      <div class="pricing-section">
        <button id="toggle-discount-table" class="btn btn-secondary btn-small" style="width: 100%; margin-bottom: 8px;">
          ▸ Cluster Bonus Schedule
        </button>
        <div id="discount-table" style="display: none;"></div>
      </div>

    `;

    // Setup toggle for discount table
    const toggleBtn = this.container.querySelector("#toggle-discount-table");
    const discountTable = this.container.querySelector("#discount-table");
    toggleBtn.addEventListener("click", () => {
      const isHidden = discountTable.style.display === "none";
      discountTable.style.display = isHidden ? "block" : "none";
      toggleBtn.textContent = isHidden
        ? "▾ Cluster Bonus Schedule"
        : "▸ Cluster Bonus Schedule";
    });

    // Initial render of static content
    this._renderTierLegend();
    this._renderDiscountTable();
  }

  _renderTierLegend() {
    if (typeof HexTierSystem === "undefined") return;

    const container = this.container.querySelector("#tier-legend");
    const tiers = HexTierSystem.TIER_ORDER;

    container.innerHTML = tiers
      .map((tierId) => {
        const tier = HexTierSystem.TIERS[tierId];
        const isRentable = HexTierSystem.RENTABLE_TIERS.includes(tierId);

        return `
        <div class="tier-item ${this.currentFilter === tierId ? "tier-item-active" : ""}"
             data-tier="${tierId}">
          <div class="tier-color" style="background: ${tier.cssColor}; border-color: ${tier.stroke};">
            ${tier.icon === "⊘" ? '<span style="color:' + tier.textColor + '">✕</span>' : ""}
          </div>
          <div class="tier-info">
            <div class="tier-header">
              <span class="tier-name" style="color: ${tier.textColor}">${tier.name}</span>
              ${isRentable ? `<span class="tier-price">$${tier.price}<span class="tier-price-unit">/hex/mo</span></span>` : ""}
              <span class="tier-count" id="tier-count-${tierId}">—</span>
            </div>
            <div class="tier-description">${tier.description}</div>
          </div>
        </div>
      `;
      })
      .join("");

    // Add click handlers for tier filtering
    container.querySelectorAll(".tier-item").forEach((item) => {
      item.addEventListener("click", () => {
        const tierId = item.dataset.tier;
        const isActive = this.currentFilter === tierId;
        this.currentFilter = isActive ? null : tierId;

        // Update active state visually
        container.querySelectorAll(".tier-item").forEach((i) => {
          i.classList.toggle(
            "tier-item-active",
            i.dataset.tier === this.currentFilter,
          );
        });

        // Callback to hex selector for filtering
        if (this.onTierFilter) {
          this.onTierFilter(this.currentFilter);
        }
      });
    });
  }

  _renderDiscountTable() {
    if (typeof HexTierSystem === "undefined") return;

    const container = this.container.querySelector("#discount-table");
    const examples = HexTierSystem.getDiscountExamples();

    container.innerHTML = `
      <div class="discount-grid">
        ${examples
          .map(({ hexCount, discount }) => {
            const hasDiscount = discount > 0;
            const isBig = discount >= 25;
            return `
            <div class="discount-item ${hasDiscount ? "has-discount" : ""} ${isBig ? "big-discount" : ""}">
              <div class="discount-count">${hexCount}</div>
              <div class="discount-label">${hexCount === 1 ? "hex" : "hexes"}</div>
              <div class="discount-value">${hasDiscount ? `-${discount}%` : "—"}</div>
            </div>
          `;
          })
          .join("")}
      </div>
    `;
  }

  /**
   * Update tier counts from hex selector stats
   * @param {Object} stats - { HOTZONE: count, PRIME: count, ... }
   */
  updateTierStats(stats) {
    if (!stats) return;

    HexTierSystem.TIER_ORDER.forEach((tierId) => {
      const countEl = this.container.querySelector(`#tier-count-${tierId}`);
      if (countEl) {
        countEl.textContent = stats[tierId] || 0;
      }
    });
  }

  /**
   * Update pricing display for selected tiles
   * @param {Object} pricing - From HexTierSystem.calculatePricing()
   */
  updatePricing(pricing) {
    const container = this.container.querySelector("#pricing-summary");

    const hasMoons = pricing && pricing.moons && pricing.moons.length > 0;
    const hasBillboards = pricing && pricing.billboards && pricing.billboards.length > 0;
    const hasHexes = pricing && pricing.totalHexes > 0;

    if (!pricing || (!hasHexes && !hasMoons && !hasBillboards)) {
      container.innerHTML = `
        <div class="pricing-empty-state">
          Select hexes, moons, or billboards to see pricing
          <div class="pricing-empty-hint">Click hexes to build a cluster • Bigger clusters = bigger discounts</div>
        </div>
      `;
      return;
    }

    const {
      byTier,
      totalHexes,
      subtotal,
      discount,
      discountAmount,
      total,
      label,
      moons,
      moonTotal,
    } = pricing;

    let html = "";

    // Hex pricing section
    if (hasHexes) {
      html += `
        <div class="pricing-header">
          <span class="pricing-hex-count">${totalHexes} ${totalHexes === 1 ? "hex" : "hexes"} selected</span>
        </div>
      `;

      // Tier breakdown
      Object.entries(byTier).forEach(([tierId, count]) => {
        const tier = HexTierSystem.TIERS[tierId];
        html += `
          <div class="pricing-row">
            <div class="pricing-row-left">
              <span class="pricing-tier-icon" style="color: ${tier.textColor}">${tier.icon}</span>
              <span class="pricing-tier-name">${tier.name} × ${count}</span>
            </div>
            <span class="pricing-tier-subtotal">$${_fmtUSD(tier.price * count)}</span>
          </div>
        `;
      });

      // Subtotal
      html += `
        <div class="pricing-subtotal-row">
          <span>Hex subtotal</span>
          <span>$${_fmtUSD(subtotal)}/mo</span>
        </div>
      `;

      // Discount (if any)
      if (discount > 0) {
        html += `
          <div class="pricing-discount-row">
            <div class="pricing-discount-left">
              <span class="pricing-discount-label">★ ${label}</span>
              <span class="pricing-discount-badge">-${discount}%</span>
            </div>
            <span class="pricing-discount-amount">-$${_fmtUSD(discountAmount)}</span>
          </div>
        `;
      }
    }

    // Moon pricing section
    if (hasMoons) {
      html += `
        <div class="pricing-header" ${hasHexes ? 'style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);"' : ""}>
          <span class="pricing-hex-count">${moons.length} ${moons.length === 1 ? "moon" : "moons"} selected</span>
        </div>
      `;

      for (const moon of moons) {
        html += `
          <div class="pricing-row">
            <div class="pricing-row-left">
              <span class="pricing-tier-icon" style="color: #aaa">☽</span>
              <span class="pricing-tier-name">${moon.label}</span>
            </div>
            <span class="pricing-tier-subtotal">$${_fmtUSD(moon.price)}</span>
          </div>
        `;
      }
    }

    // Billboard pricing section
    if (hasBillboards) {
      const { billboards } = pricing;
      html += `
        <div class="pricing-header" ${(hasHexes || hasMoons) ? 'style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);"' : ""}>
          <span class="pricing-hex-count">${billboards.length} ${billboards.length === 1 ? "billboard" : "billboards"} selected</span>
        </div>
      `;

      for (const bb of billboards) {
        html += `
          <div class="pricing-row">
            <div class="pricing-row-left">
              <span class="pricing-tier-icon" style="color: #7af">⛯</span>
              <span class="pricing-tier-name">${bb.label}</span>
            </div>
            <span class="pricing-tier-subtotal">$${_fmtUSD(bb.price)}</span>
          </div>
        `;
      }
    }

    // Grand total
    const grandTotal = total + (moonTotal || 0) + (pricing.billboardTotal || 0);
    html += `
      <div class="pricing-total-row">
        <span>Monthly Total</span>
        <div class="pricing-total-amount">
          <span class="pricing-total-value">$${_fmtUSD(grandTotal)}</span>
          <span class="pricing-total-unit">/mo</span>
        </div>
      </div>
    `;

    // Savings callout (hex cluster discount only)
    if (discount > 0) {
      html += `
        <div class="pricing-savings">
          You save $${_fmtUSD(discountAmount)}/mo ($${_fmtUSD(discountAmount * 12)}/year) with a ${totalHexes}-hex cluster
        </div>
      `;
    }

    container.innerHTML = html;
  }
}

// Make available globally
if (typeof window !== "undefined") {
  window.PricingPanel = PricingPanel;
}
