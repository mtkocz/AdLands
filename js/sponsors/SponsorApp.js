/**
 * AdLands - Sponsor Portal Application Controller
 * Wires 3D scene, pricing panel, and inquiry form together.
 */

(function () {
  "use strict";

  // Format USD with commas
  function fmtUSD(n) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ========================
  // INITIALIZATION
  // ========================

  const loadingOverlay = document.getElementById("sponsor-loading");
  const loadingBarFill = document.querySelector(".loading-bar-fill");
  const loadingStatus = document.querySelector(".loading-status");

  function setLoading(pct, status) {
    if (loadingBarFill) loadingBarFill.style.width = pct + "%";
    if (loadingStatus) loadingStatus.textContent = status;
  }

  setLoading(10, "Initializing...");

  // Create 3D scene
  const scene = new SponsorScene(document.getElementById("sponsor-canvas"));

  setLoading(60, "Generating planet...");

  // DOM references
  const pricingSummary = document.getElementById("pricing-summary");
  const selectionInfo = document.getElementById("selection-info");
  const inquireBtn = document.getElementById("inquire-btn");
  const clearBtn = document.getElementById("clear-btn");
  const inquiryModal = document.getElementById("inquiry-modal");
  const inquiryForm = document.getElementById("inquiry-form");
  const screenshotPreview = document.getElementById("screenshot-preview");
  const modalPricingSummary = document.getElementById("modal-pricing-summary");
  const formMessage = document.getElementById("form-message");
  const submitBtn = document.getElementById("submit-inquiry-btn");

  // ========================
  // TIER LEGEND
  // ========================

  function renderTierLegend() {
    const container = document.getElementById("tier-legend");
    if (!container || typeof HexTierSystem === "undefined") return;

    let html = "";

    // — Hexagons —
    html += '<div class="tier-group"><div class="tier-group-label">Hexagons</div>';
    const tiers = HexTierSystem.TIER_ORDER;
    html += tiers.map((tierId) => {
      const tier = HexTierSystem.TIERS[tierId];
      const isRentable = HexTierSystem.RENTABLE_TIERS.includes(tierId);
      return `
        <div class="tier-item">
          <div class="tier-color" style="background: ${tier.cssColor}; border-color: ${tier.stroke};">
            ${tier.icon === "\u2298" ? '<span style="color:' + tier.textColor + '">\u2715</span>' : ""}
          </div>
          <div class="tier-info">
            <div class="tier-header">
              <span class="tier-name" style="color: ${tier.textColor}">${tier.name}</span>
              ${isRentable ? `<span class="tier-price">$${tier.price}<span class="tier-price-unit">/hex/mo</span></span>` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");
    html += "</div>";

    // — Moons — (colors match hex tiers: Large=Hotzone, Small=Frontier, Medium=Prime)
    const moonTierIds = ["HOTZONE", "FRONTIER", "PRIME"];
    html += '<div class="tier-group"><div class="tier-group-label">Moons</div>';
    HexTierSystem.MOON_LABELS.forEach((label, i) => {
      const price = HexTierSystem.MOON_PRICES[i];
      const tier = HexTierSystem.TIERS[moonTierIds[i]];
      html += `
        <div class="tier-item">
          <div class="tier-color" style="background: ${tier.cssColor}; border-color: ${tier.stroke};">
            <span style="color: ${tier.textColor}; font-size: 11px;">\u263d</span>
          </div>
          <div class="tier-info">
            <div class="tier-header">
              <span class="tier-name" style="color: ${tier.textColor}">${label}</span>
              <span class="tier-price">$${price}<span class="tier-price-unit">/mo</span></span>
            </div>
          </div>
        </div>
      `;
    });
    html += "</div>";

    // — Billboards — (LOW=Frontier, HIGH=Prime)
    const bbTierMap = { LOW: "FRONTIER", HIGH: "PRIME" };
    html += '<div class="tier-group"><div class="tier-group-label">Billboards</div>';
    const bbTiers = HexTierSystem.BILLBOARD_ORBIT_TIERS;
    for (const [key, def] of Object.entries(bbTiers)) {
      const tier = HexTierSystem.TIERS[bbTierMap[key]];
      html += `
        <div class="tier-item">
          <div class="tier-color" style="background: ${tier.cssColor}; border-color: ${tier.stroke};">
            <span style="color: ${tier.textColor}; font-size: 11px;">\u26ef</span>
          </div>
          <div class="tier-info">
            <div class="tier-header">
              <span class="tier-name" style="color: ${tier.textColor}">${def.label}</span>
              <span class="tier-price">$${def.price}<span class="tier-price-unit">/mo</span></span>
            </div>
            <div class="tier-description">${def.count} slots</div>
          </div>
        </div>
      `;
    }
    html += "</div>";

    container.innerHTML = html;
  }

  renderTierLegend();

  // ========================
  // DISCOUNT TABLE
  // ========================

  function renderDiscountTable() {
    const container = document.getElementById("discount-table");
    if (!container || typeof HexTierSystem === "undefined") return;

    const examples = HexTierSystem.getDiscountExamples();
    container.innerHTML = `
      <div class="discount-grid">
        ${examples.map(({ hexCount, discount }) => {
          const hasDiscount = discount > 0;
          const isBig = discount >= 25;
          return `
            <div class="discount-item ${hasDiscount ? "has-discount" : ""} ${isBig ? "big-discount" : ""}">
              <div class="discount-count">${hexCount}</div>
              <div class="discount-label">${hexCount === 1 ? "hex" : "hexes"}</div>
              <div class="discount-value">${hasDiscount ? `-${discount}%` : "\u2014"}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // Discount table toggle
  const discountToggle = document.getElementById("discount-toggle");
  const discountTable = document.getElementById("discount-table");
  if (discountToggle && discountTable) {
    renderDiscountTable();
    discountToggle.addEventListener("click", () => {
      const hidden = discountTable.style.display === "none";
      discountTable.style.display = hidden ? "block" : "none";
      discountToggle.textContent = hidden ? "\u25be Cluster Bonus Schedule" : "\u25b8 Cluster Bonus Schedule";
    });
  }

  // ========================
  // PRICING UPDATES
  // ========================

  function updatePricing() {
    const pricing = scene.getPricing();
    const hasMoons = pricing && pricing.moons && pricing.moons.length > 0;
    const hasBillboards = pricing && pricing.billboards && pricing.billboards.length > 0;
    const hasHexes = pricing && pricing.totalHexes > 0;
    const hasSelection = hasHexes || hasMoons || hasBillboards;

    // Update inquire button
    if (inquireBtn) inquireBtn.disabled = !hasSelection;

    // Update selection info
    if (selectionInfo) {
      selectionInfo.style.display = "none";
    }

    if (!pricingSummary) return;

    if (!hasSelection) {
      pricingSummary.innerHTML = `
        <div class="pricing-empty-state">
          Click hexes, moons, or billboards on the planet to build your sponsorship package.
        </div>
      `;
      return;
    }

    const { byTier, totalHexes, subtotal, discount, discountAmount, total, label, moons, moonTotal } = pricing;

    let html = "";

    // Hex pricing
    if (hasHexes) {
      html += `
        <div class="pricing-header">
          <span class="pricing-hex-count">${totalHexes} ${totalHexes === 1 ? "hex" : "hexes"} selected</span>
        </div>
      `;

      Object.entries(byTier).forEach(([tierId, count]) => {
        const tier = HexTierSystem.TIERS[tierId];
        html += `
          <div class="pricing-row">
            <div class="pricing-row-left">
              <span class="pricing-tier-icon" style="color: ${tier.textColor}">${tier.icon}</span>
              <span class="pricing-tier-name">${tier.name} \u00d7 ${count}</span>
            </div>
            <span class="pricing-tier-subtotal">$${fmtUSD(tier.price * count)}</span>
          </div>
        `;
      });

      html += `
        <div class="pricing-subtotal-row">
          <span>Hex subtotal</span>
          <span>$${fmtUSD(subtotal)}/mo</span>
        </div>
      `;

      if (discount > 0) {
        html += `
          <div class="pricing-discount-row">
            <div class="pricing-discount-left">
              <span class="pricing-discount-label">\u2605 ${label}</span>
              <span class="pricing-discount-badge">-${discount}%</span>
            </div>
            <span class="pricing-discount-amount">-$${fmtUSD(discountAmount)}</span>
          </div>
        `;
      }
    }

    // Moon pricing
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
              <span class="pricing-tier-icon" style="color: #aaa">\u263d</span>
              <span class="pricing-tier-name">${moon.label}</span>
            </div>
            <span class="pricing-tier-subtotal">$${fmtUSD(moon.price)}</span>
          </div>
        `;
      }
    }

    // Billboard pricing
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
              <span class="pricing-tier-icon" style="color: #7af">\u26ef</span>
              <span class="pricing-tier-name">${bb.label}</span>
            </div>
            <span class="pricing-tier-subtotal">$${fmtUSD(bb.price)}</span>
          </div>
        `;
      }
    }

    // Grand total
    const grandTotal = (pricing.total || 0) + (pricing.moonTotal || 0) + (pricing.billboardTotal || 0);
    html += `
      <div class="pricing-total-row">
        <span>Monthly Total</span>
        <div class="pricing-total-amount">
          <span class="pricing-total-value">$${fmtUSD(grandTotal)}</span>
          <span class="pricing-total-unit">/mo</span>
        </div>
      </div>
    `;

    if (discount > 0) {
      html += `
        <div class="pricing-savings">
          You save $${fmtUSD(discountAmount)}/mo ($${fmtUSD(discountAmount * 12)}/year) with a ${totalHexes}-hex cluster
        </div>
      `;
    }

    pricingSummary.innerHTML = html;
  }

  // Wire selection changes
  scene.onSelectionChange = updatePricing;

  // Scene ready callback
  scene.onReady = () => {
    setLoading(100, "Ready");
    setTimeout(() => {
      if (loadingOverlay) {
        loadingOverlay.classList.add("fade-out");
        setTimeout(() => loadingOverlay.style.display = "none", 600);
      }
    }, 300);
  };

  // If onReady wasn't called (tiles already generated synchronously), dismiss loading
  setTimeout(() => {
    if (loadingOverlay && !loadingOverlay.classList.contains("fade-out")) {
      setLoading(100, "Ready");
      loadingOverlay.classList.add("fade-out");
      setTimeout(() => loadingOverlay.style.display = "none", 600);
    }
  }, 2000);

  // ========================
  // CLEAR SELECTION
  // ========================

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      scene.clearSelection();
      updatePricing();
    });
  }

  // ========================
  // INQUIRY MODAL
  // ========================

  function showInquiryModal() {
    if (!inquiryModal) return;

    // Capture screenshot
    const screenshot = scene.captureScreenshot();
    if (screenshotPreview) {
      screenshotPreview.src = screenshot;
      screenshotPreview.style.display = "block";
    }

    // Show pricing summary in modal
    if (modalPricingSummary) {
      const pricing = scene.getPricing();
      const tiles = scene.getSelectedTiles();
      const moons = scene.getSelectedMoons();
      const bbs = scene.getSelectedBillboards();
      const grandTotal = (pricing.total || 0) + (pricing.moonTotal || 0) + (pricing.billboardTotal || 0);

      let lines = [];
      if (tiles.length > 0) lines.push(`${tiles.length} hex${tiles.length !== 1 ? "es" : ""}`);
      if (moons.length > 0) lines.push(`${moons.length} moon${moons.length !== 1 ? "s" : ""}`);
      if (bbs.length > 0) lines.push(`${bbs.length} billboard${bbs.length !== 1 ? "s" : ""}`);

      modalPricingSummary.innerHTML = `
        <div>${lines.join(" + ")}</div>
        ${pricing.discount > 0 ? `<div>Cluster discount: -${pricing.discount}%</div>` : ""}
        <div class="total-line">Estimated total: $${fmtUSD(grandTotal)}/mo</div>
      `;
    }

    // Reset form state
    if (formMessage) { formMessage.className = "form-message"; formMessage.textContent = ""; }
    if (submitBtn) submitBtn.disabled = false;

    inquiryModal.classList.remove("hidden");
  }

  function hideInquiryModal() {
    if (inquiryModal) inquiryModal.classList.add("hidden");
  }

  if (inquireBtn) {
    inquireBtn.addEventListener("click", showInquiryModal);
  }

  // Close modal buttons
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", hideInquiryModal);
  });

  // Close modal on overlay click
  if (inquiryModal) {
    inquiryModal.addEventListener("click", (e) => {
      if (e.target === inquiryModal) hideInquiryModal();
    });
  }

  // ========================
  // INQUIRY FORM SUBMISSION
  // ========================

  if (inquiryForm) {
    inquiryForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submitBtn) submitBtn.disabled = true;
      if (formMessage) { formMessage.className = "form-message"; formMessage.textContent = ""; }

      const formData = new FormData(inquiryForm);
      const name = formData.get("name");
      const email = formData.get("email");
      const company = formData.get("company");
      const message = formData.get("message");

      if (!name || !email) {
        if (formMessage) {
          formMessage.className = "form-message error";
          formMessage.textContent = "Name and email are required.";
        }
        if (submitBtn) submitBtn.disabled = false;
        return;
      }

      const screenshot = scene.captureScreenshot();
      const importPayload = scene.getAdminImportPayload();
      const pricing = scene.getPricing();

      try {
        const response = await fetch("/api/sponsor-inquiry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            email,
            company,
            message,
            screenshot,
            importPayload,
            pricing,
            selectedTiles: scene.getSelectedTiles(),
            selectedMoons: scene.getSelectedMoons(),
            selectedBillboards: scene.getSelectedBillboards(),
          }),
        });

        const result = await response.json();

        if (result.success) {
          if (formMessage) {
            formMessage.className = "form-message success";
            formMessage.textContent = "Inquiry sent successfully! We'll be in touch soon.";
          }
          // Reset form fields
          inquiryForm.reset();
        } else {
          throw new Error(result.error || "Failed to send inquiry");
        }
      } catch (err) {
        if (formMessage) {
          formMessage.className = "form-message error";
          formMessage.textContent = err.message || "Failed to send inquiry. Please try again.";
        }
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  // ========================
  // CONTACT FORM (bottom panel)
  // ========================

  const contactForm = document.getElementById("contact-form");
  const contactMessage = document.getElementById("contact-message");

  if (contactForm) {
    contactForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const contactSubmitBtn = contactForm.querySelector("button[type=submit]");
      if (contactSubmitBtn) contactSubmitBtn.disabled = true;
      if (contactMessage) { contactMessage.className = "form-message"; contactMessage.textContent = ""; }

      const formData = new FormData(contactForm);

      try {
        const response = await fetch("/api/sponsor-inquiry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: formData.get("contact-name"),
            email: formData.get("contact-email"),
            company: "",
            message: formData.get("contact-message"),
            selectedTiles: [],
            selectedMoons: [],
            selectedBillboards: [],
          }),
        });

        const result = await response.json();
        if (result.success) {
          if (contactMessage) {
            contactMessage.className = "form-message success";
            contactMessage.textContent = "Message sent! We'll be in touch.";
          }
          contactForm.reset();
        } else {
          throw new Error(result.error || "Failed to send");
        }
      } catch (err) {
        if (contactMessage) {
          contactMessage.className = "form-message error";
          contactMessage.textContent = err.message || "Failed to send. Please try again.";
        }
      }
      if (contactSubmitBtn) contactSubmitBtn.disabled = false;
    });
  }

  // ========================
  // WINDOW RESIZE
  // ========================

  window.addEventListener("resize", () => scene.resize());

  // Initial pricing render
  updatePricing();
})();
