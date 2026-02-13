/**
 * AdLands - Admin Application
 * Main controller for the sponsor admin portal
 */

(function () {
  "use strict";

  // Module references
  let hexSelector = null;
  let sponsorForm = null;
  let rewardConfig = null;
  let pricingPanel = null;
  let moonManager = null;
  let billboardManager = null;

  // Busy guard — prevents concurrent save/duplicate/delete operations
  let busy = false;

  // Group editing state: null when not editing a group
  // { name: string, ids: [id1, id2, ...], activeIndex: number, clusterStates: Map }
  let editingGroup = null;

  // UI elements
  const selectionCountEl = document.getElementById("selection-count");
  const selectedTilesListEl = document.getElementById("selected-tiles-list");
  const sponsorsListEl = document.getElementById("sponsors-list");
  const saveBtn = document.getElementById("save-sponsor-btn");
  const clearFormBtn = document.getElementById("clear-form-btn");
  const clearSelectionBtn = document.getElementById("clear-selection-btn");
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFileInput = document.getElementById("import-file");
  const addSponsorBtn = document.getElementById("add-sponsor-btn");
  const toastContainer = document.getElementById("toast-container");
  const clusterTabsContainer = document.getElementById("cluster-tabs-container");
  const clusterTabsEl = document.getElementById("cluster-tabs");

  // ========================
  // INITIALIZATION
  // ========================

  // Loading overlay helpers
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingBarFill = document.getElementById("loading-bar-fill");
  const loadingStatus = document.getElementById("loading-status");

  function setLoadingProgress(pct, status) {
    if (loadingBarFill) loadingBarFill.style.width = pct + "%";
    if (loadingStatus) loadingStatus.textContent = status;
  }

  function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.classList.add("fade-out");
    setTimeout(() => loadingOverlay.remove(), 400);
  }

  async function init() {
    // Step 1: Connect to storage
    setLoadingProgress(10, "Connecting to server...");
    await SponsorStorage.init();
    setLoadingProgress(40, "Loading sponsors...");

    // Show connection status badge
    const headerActions = document.querySelector(".header-actions");
    if (headerActions) {
      const badge = document.createElement("span");
      badge.className = SponsorStorage._useAPI ? "badge badge-server" : "badge badge-offline";
      badge.textContent = SponsorStorage._useAPI ? "SERVER" : "OFFLINE";
      headerActions.prepend(badge);
    }

    // Step 2: Initialize hex selector (builds 3D sphere)
    setLoadingProgress(50, "Building hex sphere...");
    const hexContainer = document.getElementById("hex-canvas-container");
    hexSelector = new HexSelector(hexContainer, {
      width: hexContainer.clientWidth,
      height: hexContainer.clientHeight,
      onSelectionChange: handleSelectionChange,
    });

    // Initialize pricing panel
    setLoadingProgress(65, "Setting up panels...");
    const pricingContainer = document.getElementById("pricing-panel");
    pricingPanel = new PricingPanel(pricingContainer, {
      onTierFilter: handleTierFilter,
    });

    // Update tier stats in pricing panel
    const tierStats = hexSelector.getTierStats();
    if (tierStats) {
      pricingPanel.updateTierStats(tierStats);
    }

    // Initialize sponsor form
    sponsorForm = new SponsorForm({
      onFormChange: handleFormChange,
    });

    // Initialize reward config
    rewardConfig = new RewardConfig({
      onRewardsChange: handleRewardsChange,
    });

    // Initialize moon sponsor manager (API utility for moon assignments)
    setLoadingProgress(68, "Loading moon sponsors...");
    if (typeof MoonSponsorManager !== "undefined") {
      moonManager = new MoonSponsorManager();
      await moonManager.load();
      // Show which moons are already assigned to other sponsors
      updateAssignedMoons();
    }

    // Initialize billboard sponsor manager
    setLoadingProgress(72, "Loading billboard sponsors...");
    if (typeof BillboardSponsorManager !== "undefined") {
      billboardManager = new BillboardSponsorManager();
      await billboardManager.load();
      updateAssignedBillboards();
    }

    // Step 3: Wire up UI
    setLoadingProgress(80, "Loading sponsor list...");
    setupEventListeners();

    // Load existing sponsors
    refreshSponsorsList();

    // Initialize column resizer
    columnResizer.init(document.getElementById("main-content"));

    // Update assigned tiles in hex selector
    setLoadingProgress(95, "Rendering tiles...");
    updateAssignedTiles();

    // Show initial cluster tabs
    renderClusterTabs();

    // Done — fade out loading overlay
    setLoadingProgress(100, "Ready");
    hideLoading();
  }

  function setupEventListeners() {
    // Save sponsor
    saveBtn.addEventListener("click", handleSaveSponsor);

    // Clear form
    clearFormBtn.addEventListener("click", handleClearForm);

    // Clear selection
    clearSelectionBtn.addEventListener("click", () => {
      hexSelector.clearSelection();
    });

    // Export JSON
    exportBtn.addEventListener("click", handleExport);

    // Import JSON
    importBtn.addEventListener("click", () => {
      importFileInput.click();
    });
    importFileInput.addEventListener("change", handleImport);

    // Add new sponsor
    addSponsorBtn.addEventListener("click", handleClearForm);

    // Window resize
    window.addEventListener("resize", handleResize);

    // Sponsor list — single delegated handler (survives innerHTML rebuilds)
    sponsorsListEl.addEventListener("click", (e) => {
      // Handle group header clicks (expand/collapse or edit)
      const groupHeader = e.target.closest(".sponsor-group-header");
      if (groupHeader) {
        const group = groupHeader.closest(".sponsor-group");
        if (e.target.closest(".add-cluster-btn")) {
          addClusterToGroup(group.dataset.name);
        } else if (e.target.closest(".edit-group-btn")) {
          editGroup(group.dataset.name);
        } else {
          group.classList.toggle("expanded");
        }
        return;
      }

      // Handle cluster row clicks within groups
      const clusterRow = e.target.closest(".sponsor-cluster-row");
      if (clusterRow) {
        const id = clusterRow.dataset.id;
        if (e.target.closest(".delete-sponsor-btn")) {
          deleteSponsor(id);
        } else {
          // Edit the whole group, starting at this cluster
          const group = clusterRow.closest(".sponsor-group");
          editGroup(group.dataset.name, id);
        }
        return;
      }

      // Handle single sponsor cards (non-grouped)
      const card = e.target.closest(".sponsor-card");
      if (!card) return;
      const id = card.dataset.id;

      if (e.target.closest(".duplicate-sponsor-btn")) {
        duplicateSponsor(id);
      } else if (e.target.closest(".delete-sponsor-btn")) {
        deleteSponsor(id);
      } else if (!e.target.closest(".sponsor-card-actions")) {
        editSponsor(id);
      }
    });

    // Cluster tabs — delegated handler
    clusterTabsEl.addEventListener("click", (e) => {
      const tab = e.target.closest(".cluster-tab");
      if (tab && !tab.classList.contains("active")) {
        const index = parseInt(tab.dataset.index, 10);
        switchCluster(index);
        return;
      }
      if (e.target.closest(".cluster-tab-add")) {
        addCluster();
      }
    });
  }

  // ========================
  // EVENT HANDLERS
  // ========================

  function handleSelectionChange(selectedTiles) {
    const selectedMoons = hexSelector ? hexSelector.getSelectedMoons() : [];
    const selectedBillboards = hexSelector ? hexSelector.getSelectedBillboards() : [];
    const totalCount = selectedTiles.length + selectedMoons.length + selectedBillboards.length;
    selectionCountEl.textContent = totalCount;

    // Update selected tiles list for accountability
    const parts = [];
    if (selectedTiles.length > 0) {
      const sortedTiles = [...selectedTiles].sort((a, b) => a - b);
      parts.push("Tiles: " + sortedTiles.join(", "));
    }
    if (selectedMoons.length > 0) {
      const moonLabels = selectedMoons.map(i => "Moon " + (i + 1));
      parts.push(moonLabels.join(", "));
    }
    if (selectedBillboards.length > 0) {
      const bbLabels = selectedBillboards.map(i =>
        typeof HexTierSystem !== "undefined" ? HexTierSystem.getBillboardLabel(i) : `Billboard ${i + 1}`
      );
      parts.push(bbLabels.join(", "));
    }
    selectedTilesListEl.textContent = parts.join(" | ");

    // Update pricing panel
    if (pricingPanel) {
      const pricing = hexSelector.getPricing();
      pricingPanel.updatePricing(pricing);
    }

    // Update pattern preview when selection changes (tiles, moons, or billboards)
    const formData = sponsorForm.getFormData();
    if (formData.patternImage && (selectedTiles.length > 0 || selectedMoons.length > 0 || selectedBillboards.length > 0)) {
      hexSelector.setPatternPreview(
        formData.patternImage,
        formData.patternAdjustment,
      );
    } else {
      hexSelector.setPatternPreview(null);
    }

    // Live-update revenue total and editing sponsor's card
    updateLiveRevenue(selectedTiles);
  }

  /**
   * Recalculate the monthly revenue total from all sponsors.
   * When editing, substitutes the active cluster's stored tiles with the live
   * hex-selector selection and patches the editing card/row in-place.
   */
  function updateLiveRevenue(liveSelectedTiles) {
    const tierMap = hexSelector ? hexSelector.getTierMap() : null;
    if (!tierMap || typeof HexTierSystem === "undefined") return;

    const editingId = sponsorForm ? sponsorForm.getEditingSponsorId() : null;
    const editingSponsor = editingId ? SponsorStorage.getById(editingId) : null;
    const editingSponsorName = editingSponsor?.name;
    const liveSelectedMoons = hexSelector ? hexSelector.getSelectedMoons() : [];
    const sponsors = SponsorStorage.getAll();
    let totalMonthly = 0;

    // Track which sponsor names we've already counted moon/billboard revenue for (avoid double-counting in groups)
    const moonRevCounted = new Set();
    const liveSelectedBillboards = hexSelector ? hexSelector.getSelectedBillboards() : [];

    for (const s of sponsors) {
      let tiles;
      if (editingId && s.id === editingId) {
        tiles = liveSelectedTiles;
      } else {
        tiles = s.cluster?.tileIndices;
      }
      const rev = calcRevenueForTiles(tiles, tierMap);
      totalMonthly += rev.total;

      // Add moon + billboard revenue once per sponsor name
      const nameKey = (s.name || "").toLowerCase();
      if (!moonRevCounted.has(nameKey)) {
        moonRevCounted.add(nameKey);
        // For the editing sponsor, use live selections
        if (editingSponsorName && nameKey === editingSponsorName.toLowerCase()) {
          totalMonthly += calcMoonRevenue(null, liveSelectedMoons);
          totalMonthly += calcBillboardRevenue(null, liveSelectedBillboards);
        } else {
          totalMonthly += calcMoonRevenue(s.name);
          totalMonthly += calcBillboardRevenue(s.name);
        }
      }

      // Patch individual card/cluster row revenue in-place (only for editing sponsor)
      if (editingId && s.id === editingId) {
        const liveMoonRev = calcMoonRevenue(null, liveSelectedMoons);
        const liveBbRev = calcBillboardRevenue(null, liveSelectedBillboards);
        const liveTotal = rev.total + liveMoonRev + liveBbRev;

        // Update card if it's a flat card
        const card = sponsorsListEl.querySelector(`.sponsor-card[data-id="${s.id}"]`);
        if (card) {
          const revEl = card.querySelector(".sponsor-card-revenue");
          const newHtml = liveTotal > 0
            ? `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(liveTotal)}/mo</span></div>`
            : "";
          if (newHtml) {
            if (revEl) revEl.outerHTML = newHtml;
            else {
              const info = card.querySelector(".sponsor-card-info");
              if (info) info.insertAdjacentHTML("beforeend", newHtml);
            }
          } else if (revEl) {
            revEl.remove();
          }
        }
        // Update cluster row if it's in a group
        const row = sponsorsListEl.querySelector(`.sponsor-cluster-row[data-id="${s.id}"]`);
        if (row) {
          const statsEl = row.querySelector(".sponsor-cluster-row-stats");
          if (statsEl) statsEl.textContent = `${(tiles?.length || 0)} tiles, ${s.rewards?.length || 0} rewards`;
          const revEl = row.querySelector(".sponsor-cluster-row-revenue");
          const newRevSpan = rev.total > 0
            ? `$${fmtUSD(rev.total)}/mo`
            : "";
          if (revEl) {
            if (newRevSpan) revEl.textContent = newRevSpan;
            else revEl.remove();
          } else if (newRevSpan) {
            const delBtn = row.querySelector(".delete-sponsor-btn");
            if (delBtn) delBtn.insertAdjacentHTML("beforebegin",
              `<span class="sponsor-cluster-row-revenue">${newRevSpan}</span>`);
          }
        }
      }
    }

    // Update group header aggregated stats if editing a group
    if (editingGroup && editingId) {
      const groupEl = sponsorsListEl.querySelector(`.sponsor-group[data-name="${escapeHtml(editingGroup.name)}"]`);
      if (groupEl) {
        let groupTiles = 0;
        let groupRev = 0;
        for (const id of editingGroup.ids) {
          const tiles = id === editingId
            ? liveSelectedTiles
            : (SponsorStorage.getById(id)?.cluster?.tileIndices || []);
          groupTiles += tiles?.length || 0;
          groupRev += calcRevenueForTiles(tiles, tierMap).total;
        }
        // Add moon + billboard revenue for the group (live selection if editing)
        const groupMoonRev = editingSponsorName
          ? calcMoonRevenue(null, liveSelectedMoons)
          : calcMoonRevenue(editingGroup.name);
        const groupBbRev = editingSponsorName
          ? calcBillboardRevenue(null, liveSelectedBillboards)
          : calcBillboardRevenue(editingGroup.name);
        groupRev += groupMoonRev + groupBbRev;

        const statsEl = groupEl.querySelector(".sponsor-group-header .sponsor-card-stats");
        if (statsEl) {
          const totalRewards = editingGroup.ids.reduce((sum, id) =>
            sum + (SponsorStorage.getById(id)?.rewards?.length || 0), 0);
          const groupMoonCount = liveSelectedMoons.length;
          const groupBbCount = liveSelectedBillboards.length;
          statsEl.textContent = `${groupTiles} tiles${groupMoonCount > 0 ? ", " + groupMoonCount + " moons" : ""}${groupBbCount > 0 ? ", " + groupBbCount + " billboards" : ""}, ${totalRewards} rewards`;
        }
        const revEl = groupEl.querySelector(".sponsor-group-header .sponsor-card-revenue");
        if (groupRev > 0) {
          const newHtml = `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(groupRev)}/mo</span></div>`;
          if (revEl) revEl.outerHTML = newHtml;
          else {
            const info = groupEl.querySelector(".sponsor-group-header .sponsor-card-info");
            if (info) info.insertAdjacentHTML("beforeend", newHtml);
          }
        } else if (revEl) {
          revEl.remove();
        }
      }
    }

    // Always update the bottom total
    const totalEl = sponsorsListEl.querySelector(".sponsors-revenue-total-amount");
    if (totalEl) {
      totalEl.textContent = `$${fmtUSD(totalMonthly)}/mo`;
    }
  }

  /**
   * Handle tier filter from pricing panel
   * @param {string|null} tierId - Tier to filter, or null to clear
   */
  function handleTierFilter(tierId) {
    // TODO: Implement tier filtering in hex selector
    // This would dim/hide tiles not matching the selected tier
    console.log("[AdminApp] Tier filter:", tierId);
  }

  function handleFormChange(formData) {
    // Update pattern preview on selected tiles and moons in real-time
    const selectedTiles = hexSelector.getSelectedTiles();
    const selectedMoons = hexSelector.getSelectedMoons();
    if (formData.patternImage && (selectedTiles.length > 0 || selectedMoons.length > 0)) {
      hexSelector.setPatternPreview(
        formData.patternImage,
        formData.patternAdjustment,
      );
    } else {
      hexSelector.setPatternPreview(null);
    }
  }

  function handleRewardsChange(rewards) {
    // Could add validation feedback here
  }

  async function handleSaveSponsor() {
    if (busy) return;
    busy = true;

    try {
      const formData = sponsorForm.getFormData();
      const selectedTiles = hexSelector.getSelectedTiles();
      const rewards = rewardConfig.getRewards();

      // Validate shared fields
      const formValidation = sponsorForm.validate();
      if (!formValidation.valid) {
        showToast(formValidation.errors.join(". "), "error");
        return;
      }

      const rewardValidation = rewardConfig.validate();
      if (!rewardValidation.valid) {
        showToast(rewardValidation.errors.join(". "), "error");
        return;
      }

      if (editingGroup) {
        // === GROUP SAVE MODE ===
        // Save active cluster's per-cluster data
        const activeId = editingGroup.ids[editingGroup.activeIndex];

        const selectedMoonsForGroupSave = hexSelector ? hexSelector.getSelectedMoons() : [];
        if (selectedTiles.length === 0 && selectedMoonsForGroupSave.length === 0) {
          showToast("Active cluster must have at least one tile or moon", "error");
          return;
        }

        // Tile conflict check (exclude all group members)
        for (const id of editingGroup.ids) {
          const tiles = id === activeId
            ? selectedTiles
            : (SponsorStorage.getById(id)?.cluster?.tileIndices || []);
          if (tiles.length === 0) continue;
          // Check against sponsors NOT in this group
          const check = SponsorStorage.areTilesUsed(tiles, id);
          if (check.isUsed) {
            const groupIdSet = new Set(editingGroup.ids);
            // Only flag if the conflict is with a sponsor outside the group
            const conflictSponsor = SponsorStorage.getAll().find(
              (s) => !groupIdSet.has(s.id) && s.cluster?.tileIndices?.some((t) => tiles.includes(t))
            );
            if (conflictSponsor) {
              showToast(`Tiles conflict with "${conflictSponsor.name}"`, "error");
              return;
            }
          }
        }

        // Shared fields to propagate
        const sharedFields = {
          name: formData.name,
          tagline: formData.tagline,
          websiteUrl: formData.websiteUrl,
          logoImage: formData.logoImage,
        };

        try {
          // Update active cluster with full data
          await SponsorStorage.update(activeId, {
            ...sharedFields,
            cluster: { tileIndices: selectedTiles },
            patternImage: formData.patternImage,
            patternAdjustment: formData.patternAdjustment,
            rewards: rewards,
          });

          // Propagate shared fields to sibling clusters
          for (const id of editingGroup.ids) {
            if (id === activeId) continue;
            await SponsorStorage.update(id, sharedFields);
          }

          showToast(`Group "${formData.name}" saved (${editingGroup.ids.length} clusters)`, "success");
        } catch (e) {
          showToast(e.message || "Failed to save group", "error");
          return;
        }

        // Save moon assignments
        if (moonManager) {
          const selectedMoons = hexSelector.getSelectedMoons();
          await moonManager.saveMoonsForSponsor(selectedMoons, formData);
        }

        // Save billboard assignments
        if (billboardManager) {
          const selectedBillboards = hexSelector.getSelectedBillboards();
          await billboardManager.saveBillboardsForSponsor(selectedBillboards, formData);
        }

        handleClearForm();
        refreshSponsorsList();
      } else {
        // === SINGLE SAVE MODE (unchanged) ===
        const sponsor = {
          ...formData,
          cluster: { tileIndices: selectedTiles },
          rewards: rewards,
        };

        const selectedMoonsForSave = hexSelector ? hexSelector.getSelectedMoons() : [];
        const selectedBillboardsForSave = hexSelector ? hexSelector.getSelectedBillboards() : [];
        if (selectedTiles.length === 0 && selectedMoonsForSave.length === 0 && selectedBillboardsForSave.length === 0) {
          showToast("Please select at least one tile, moon, or billboard", "error");
          return;
        }

        const editingId = sponsorForm.getEditingSponsorId();
        const tileCheck = SponsorStorage.areTilesUsed(selectedTiles, editingId);
        if (tileCheck.isUsed) {
          showToast(
            `Some tiles are already assigned to "${tileCheck.sponsorName}"`,
            "error",
          );
          return;
        }

        try {
          if (editingId) {
            await SponsorStorage.update(editingId, sponsor);
            showToast(`Sponsor "${sponsor.name}" updated successfully`, "success");
          } else {
            await SponsorStorage.create(sponsor);
            showToast(`Sponsor "${sponsor.name}" created successfully`, "success");
          }
        } catch (e) {
          showToast(e.message || "Failed to save sponsor", "error");
          return;
        }

        // Save moon assignments
        if (moonManager) {
          const selectedMoons = hexSelector.getSelectedMoons();
          await moonManager.saveMoonsForSponsor(selectedMoons, formData);
        }

        // Save billboard assignments
        if (billboardManager) {
          const selectedBillboards = hexSelector.getSelectedBillboards();
          await billboardManager.saveBillboardsForSponsor(selectedBillboards, formData);
        }

        handleClearForm();
        refreshSponsorsList();
      }
    } finally {
      busy = false;
    }
  }

  function handleClearForm() {
    editingGroup = null;
    sponsorForm.clear();
    hexSelector.clearSelection();
    hexSelector.setPatternPreview(null);
    rewardConfig.clear();
    updateAssignedTiles();
    updateAssignedMoons();
    updateAssignedBillboards();
    selectedTilesListEl.textContent = "";
    renderClusterTabs();
  }

  function handleExport() {
    const json = SponsorStorage.exportJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `adlands_sponsors_${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast("Sponsors exported successfully", "success");
  }

  function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      const result = await SponsorStorage.importJSON(event.target.result, true);

      if (result.success) {
        showToast(`Imported ${result.imported} sponsors`, "success");
        if (result.errors.length > 0) {
          console.warn("Import warnings:", result.errors);
        }
        refreshSponsorsList();
        updateAssignedTiles();
      } else {
        showToast(result.errors.join(". "), "error");
      }
    };

    reader.onerror = () => {
      showToast("Failed to read file", "error");
    };

    reader.readAsText(file);

    // Reset file input
    e.target.value = "";
  }

  function handleResize() {
    const hexContainer = document.getElementById("hex-canvas-container");
    if (hexSelector) {
      hexSelector.resize(hexContainer.clientWidth, hexContainer.clientHeight);
    }
  }

  // ========================
  // SPONSOR LIST
  // ========================

  /** Format a number as USD with commas, e.g. 1234567.8 → "1,234,567.80" */
  function fmtUSD(n) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * Calculate revenue HTML for a set of tile indices
   * @returns {{ html: string, total: number }}
   */
  function calcRevenueForTiles(tiles, tierMap) {
    if (!tiles?.length || !tierMap || typeof HexTierSystem === "undefined") {
      return { html: "", total: 0 };
    }
    const pricing = HexTierSystem.calculatePricing(tiles, tierMap);
    if (!pricing || pricing.totalHexes === 0) return { html: "", total: 0 };

    let html;
    if (pricing.discount > 0) {
      html = `<div class="sponsor-card-revenue">$${fmtUSD(pricing.subtotal)} <span class="sponsor-card-discount">−$${fmtUSD(pricing.discountAmount)} (${pricing.discount}%)</span> = <span class="sponsor-card-revenue-total">$${fmtUSD(pricing.total)}/mo</span></div>`;
    } else {
      html = `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(pricing.total)}/mo</span></div>`;
    }
    return { html, total: pricing.total };
  }

  /**
   * Calculate moon revenue for a sponsor by name
   * @param {string} sponsorName
   * @param {number[]} [overrideMoons] - If provided, use these moon indices instead of looking up by name
   * @returns {number} Monthly moon revenue
   */
  function calcMoonRevenue(sponsorName, overrideMoons) {
    if (typeof HexTierSystem === "undefined") return 0;
    const indices = overrideMoons || (moonManager ? moonManager.getMoonsForSponsor(sponsorName) : []);
    if (!indices.length) return 0;
    return HexTierSystem.calculateMoonPricing(indices).moonTotal;
  }

  /**
   * Calculate billboard revenue for a sponsor by name
   * @param {string} sponsorName
   * @param {number[]} [overrideBillboards] - If provided, use these billboard indices instead of looking up by name
   * @returns {number} Monthly billboard revenue
   */
  function calcBillboardRevenue(sponsorName, overrideBillboards) {
    if (typeof HexTierSystem === "undefined") return 0;
    const indices = overrideBillboards || (billboardManager ? billboardManager.getBillboardsForSponsor(sponsorName) : []);
    if (!indices.length) return 0;
    return HexTierSystem.calculateBillboardPricing(indices).billboardTotal;
  }

  function refreshSponsorsList() {
    const sponsors = SponsorStorage.getAll();

    if (sponsors.length === 0) {
      sponsorsListEl.innerHTML =
        '<div class="empty-state">No sponsors created yet</div>';
      return;
    }

    // Sort sponsors alphabetically by name
    const sortedSponsors = [...sponsors].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, {
        sensitivity: "base",
      }),
    );

    // Group by exact name (case-insensitive)
    const groups = new Map();
    for (const s of sortedSponsors) {
      const key = (s.name || "").toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const tierMap = hexSelector ? hexSelector.getTierMap() : null;
    let totalMonthly = 0;
    const htmlParts = [];

    for (const [, members] of groups) {
      if (members.length === 1) {
        // Single sponsor — render as flat card
        const sponsor = members[0];
        const rev = calcRevenueForTiles(sponsor.cluster?.tileIndices, tierMap);
        const moonRev = calcMoonRevenue(sponsor.name);
        const bbRev = calcBillboardRevenue(sponsor.name);
        const sponsorTotal = rev.total + moonRev + bbRev;
        totalMonthly += sponsorTotal;

        const logoSrc = sponsor.logoUrl || sponsor.logoImage;
        htmlParts.push(`
            <div class="sponsor-card" data-id="${sponsor.id}">
                <div class="sponsor-card-logo">
                    ${
                      logoSrc
                        ? `<img src="${logoSrc}" alt="${escapeHtml(sponsor.name)}">`
                        : '<span style="color:#666;font-size:12px;">No logo</span>'
                    }
                </div>
                <div class="sponsor-card-info">
                    <div class="sponsor-card-name">${escapeHtml(sponsor.name)}</div>
                    <div class="sponsor-card-stats">
                        ${sponsor.cluster?.tileIndices?.length || 0} tiles${moonRev > 0 ? ", " + moonManager.getMoonsForSponsor(sponsor.name).length + " moons" : ""}${bbRev > 0 ? ", " + (billboardManager ? billboardManager.getBillboardsForSponsor(sponsor.name).length : 0) + " billboards" : ""},
                        ${sponsor.rewards?.length || 0} rewards
                    </div>
                    ${sponsorTotal > 0 ? `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(sponsorTotal)}/mo</span></div>` : ""}
                </div>
                <div class="sponsor-card-actions">
                    <button class="icon-btn duplicate-sponsor-btn" title="Duplicate">&#x29C9;</button>
                    <button class="close-btn delete-sponsor-btn" title="Delete">&times;</button>
                </div>
            </div>
        `);
      } else {
        // Multi-entry group — render as accordion
        const first = members[0];
        const totalTiles = members.reduce(
          (sum, s) => sum + (s.cluster?.tileIndices?.length || 0), 0
        );
        const totalRewards = members.reduce(
          (sum, s) => sum + (s.rewards?.length || 0), 0
        );

        // Aggregate revenue across all clusters + moons
        let groupRevenue = 0;
        const clusterRows = members.map((s, i) => {
          const tileCount = s.cluster?.tileIndices?.length || 0;
          const rev = calcRevenueForTiles(s.cluster?.tileIndices, tierMap);
          groupRevenue += rev.total;
          totalMonthly += rev.total;

          const revSpan = rev.total > 0
            ? `<span class="sponsor-cluster-row-revenue">$${fmtUSD(rev.total)}/mo</span>`
            : "";

          return `
            <div class="sponsor-cluster-row" data-id="${s.id}">
                <span class="sponsor-cluster-row-label">Cluster ${i + 1}</span>
                <span class="sponsor-cluster-row-stats">${tileCount} tiles, ${s.rewards?.length || 0} rewards</span>
                ${revSpan}
                <button class="icon-btn delete-sponsor-btn" title="Delete cluster">&times;</button>
            </div>
          `;
        }).join("");

        // Add moon + billboard revenue (shared across all clusters of this sponsor)
        const groupMoonRev = calcMoonRevenue(first.name);
        const groupBbRev = calcBillboardRevenue(first.name);
        groupRevenue += groupMoonRev + groupBbRev;
        totalMonthly += groupMoonRev + groupBbRev;

        const groupMoonCount = moonManager ? moonManager.getMoonsForSponsor(first.name).length : 0;
        const groupBbCount = billboardManager ? billboardManager.getBillboardsForSponsor(first.name).length : 0;

        const groupRevHtml = groupRevenue > 0
          ? `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(groupRevenue)}/mo</span></div>`
          : "";

        const groupLogoSrc = first.logoUrl || first.logoImage;
        htmlParts.push(`
            <div class="sponsor-group" data-name="${escapeHtml(first.name)}">
                <div class="sponsor-group-header">
                    <span class="sponsor-group-chevron">&#x25B6;</span>
                    <div class="sponsor-card-logo">
                        ${
                          groupLogoSrc
                            ? `<img src="${groupLogoSrc}" alt="${escapeHtml(first.name)}">`
                            : '<span style="color:#666;font-size:12px;">No logo</span>'
                        }
                    </div>
                    <div class="sponsor-card-info">
                        <div class="sponsor-card-name">${escapeHtml(first.name)}</div>
                        <span class="sponsor-group-badge">${members.length} clusters</span>
                        <div class="sponsor-card-stats">
                            ${totalTiles} tiles${groupMoonCount > 0 ? ", " + groupMoonCount + " moons" : ""}${groupBbCount > 0 ? ", " + groupBbCount + " billboards" : ""}, ${totalRewards} rewards
                        </div>
                        ${groupRevHtml}
                    </div>
                    <div class="sponsor-card-actions">
                        <button class="icon-btn add-cluster-btn" title="Add cluster">+</button>
                        <button class="icon-btn edit-group-btn" title="Edit all clusters">&#x270E;</button>
                    </div>
                </div>
                <div class="sponsor-group-clusters">
                    ${clusterRows}
                </div>
            </div>
        `);
      }
    }

    // Append revenue total summary
    // Always render the total row so updateLiveRevenue can patch it in-place
    const totalHtml = `<div class="sponsors-revenue-total"><span>Monthly revenue</span><span class="sponsors-revenue-total-amount">$${fmtUSD(totalMonthly)}/mo</span></div>`;

    sponsorsListEl.innerHTML = htmlParts.join("") + totalHtml;
  }

  async function editSponsor(id) {
    // Fetch full data (including base64 images) from server
    const sponsor = await SponsorStorage.fetchFull(id);
    if (!sponsor) {
      showToast("Sponsor not found", "error");
      return;
    }

    // Clear any active group editing
    editingGroup = null;

    // Update assigned tiles to exclude current sponsor's tiles
    updateAssignedTiles(id);

    // Load into form
    sponsorForm.loadSponsor(sponsor);

    // Load tiles and transition camera to cluster
    if (sponsor.cluster?.tileIndices) {
      hexSelector.setSelectedTiles(sponsor.cluster.tileIndices);
      hexSelector.transitionToCluster(sponsor.cluster.tileIndices);
    }

    // Load moon assignments for this sponsor
    if (moonManager && sponsor.name) {
      const moonIndices = moonManager.getMoonsForSponsor(sponsor.name);
      hexSelector.setSelectedMoons(moonIndices);
      updateAssignedMoons(sponsor.name);
    }

    // Load billboard assignments for this sponsor
    if (billboardManager && sponsor.name) {
      const bbIndices = billboardManager.getBillboardsForSponsor(sponsor.name);
      hexSelector.setSelectedBillboards(bbIndices);
      updateAssignedBillboards(sponsor.name);
    }

    // Load rewards
    if (sponsor.rewards) {
      rewardConfig.loadRewards(sponsor.rewards);
    }

    renderClusterTabs();
    window.scrollTo({ top: 0, behavior: "smooth" });
    showToast(`Editing "${sponsor.name}"`, "success");
  }

  // ========================
  // GROUP EDITING
  // ========================

  /**
   * Edit all clusters of a sponsor group
   * @param {string} sponsorName - The shared sponsor name
   * @param {string|null} startAtId - Optionally start at a specific cluster ID
   */
  async function editGroup(sponsorName, startAtId) {
    const sponsors = SponsorStorage.getAll();
    const members = sponsors.filter(
      (s) => (s.name || "").toLowerCase() === sponsorName.toLowerCase()
    );
    if (members.length === 0) {
      showToast("Sponsor group not found", "error");
      return;
    }

    // If only one member, just edit it directly
    if (members.length === 1) {
      editSponsor(members[0].id);
      return;
    }

    // Fetch full data for all group members
    await Promise.all(members.map((s) => SponsorStorage.fetchFull(s.id)));

    // Determine starting index
    let activeIndex = 0;
    if (startAtId) {
      const idx = members.findIndex((s) => s.id === startAtId);
      if (idx !== -1) activeIndex = idx;
    }

    // Initialize group editing state
    editingGroup = {
      name: sponsorName,
      ids: members.map((s) => s.id),
      activeIndex: activeIndex,
      // Cache cluster states so unsaved changes survive tab switching
      clusterStates: new Map(),
    };

    // Load shared fields from first member
    const first = members[0];
    sponsorForm.loadSponsor(first);

    // Load active cluster
    loadClusterAtIndex(activeIndex);

    // Load moon assignments for this sponsor group
    if (moonManager && sponsorName) {
      const moonIndices = moonManager.getMoonsForSponsor(sponsorName);
      hexSelector.setSelectedMoons(moonIndices);
      updateAssignedMoons(sponsorName);
    }

    // Load billboard assignments for this sponsor group
    if (billboardManager && sponsorName) {
      const bbIndices = billboardManager.getBillboardsForSponsor(sponsorName);
      hexSelector.setSelectedBillboards(bbIndices);
      updateAssignedBillboards(sponsorName);
    }

    // Render cluster tabs
    renderClusterTabs();

    window.scrollTo({ top: 0, behavior: "smooth" });
    showToast(`Editing group "${sponsorName}" (${members.length} clusters)`, "success");
  }

  /**
   * Load a specific cluster by index within the editing group
   */
  function loadClusterAtIndex(index) {
    if (!editingGroup) return;
    const id = editingGroup.ids[index];
    const sponsor = SponsorStorage.getById(id);
    if (!sponsor) return;

    // Set the form's editing ID to this cluster's entry
    sponsorForm.editingSponsorId = id;

    // Update hex selector: exclude all other sponsors AND sibling clusters
    updateGroupAssignedTiles(id);

    // Load this cluster's tiles
    if (sponsor.cluster?.tileIndices) {
      hexSelector.setSelectedTiles(sponsor.cluster.tileIndices);
      hexSelector.transitionToCluster(sponsor.cluster.tileIndices);
    } else {
      hexSelector.clearSelection();
    }

    // Load this cluster's pattern into form (without overwriting shared fields)
    // Use loadSponsor's pattern logic by building a partial sponsor object
    const patternData = {
      id: id,
      name: sponsorForm.getFormData().name, // keep current shared name
      tagline: sponsorForm.getFormData().tagline,
      websiteUrl: sponsorForm.getFormData().websiteUrl,
      logoImage: sponsorForm.getFormData().logoImage,
      patternImage: sponsor.patternImage || null,
      patternAdjustment: sponsor.patternAdjustment || null,
    };
    // Re-load via loadSponsor to update all sliders and previews consistently
    sponsorForm.loadSponsor(patternData);

    // Load this cluster's rewards
    if (sponsor.rewards) {
      rewardConfig.loadRewards(sponsor.rewards);
    } else {
      rewardConfig.clear();
    }
  }

  /**
   * Save the current active cluster's per-cluster state to its storage entry
   */
  async function saveCurrentClusterState() {
    if (!editingGroup) return;
    const id = editingGroup.ids[editingGroup.activeIndex];
    const formData = sponsorForm.getFormData();
    const selectedTiles = hexSelector.getSelectedTiles();
    const rewards = rewardConfig.getRewards();

    await SponsorStorage.update(id, {
      cluster: { tileIndices: selectedTiles },
      patternImage: formData.patternImage,
      patternAdjustment: formData.patternAdjustment,
      rewards: rewards,
    });
  }

  /**
   * Switch to a different cluster tab within the editing group
   */
  async function switchCluster(index) {
    if (!editingGroup || index === editingGroup.activeIndex) return;
    if (busy) return;
    busy = true;

    try {
      // Save current cluster state first
      await saveCurrentClusterState();

      // Switch
      editingGroup.activeIndex = index;
      loadClusterAtIndex(index);
      renderClusterTabs();
      refreshSponsorsList();
    } catch (e) {
      showToast(e.message || "Failed to switch cluster", "error");
    } finally {
      busy = false;
    }
  }

  /**
   * Add a new cluster to a group from the sponsor list (without being in edit mode)
   * Creates a new entry with shared fields, then enters group edit on the new cluster
   */
  async function addClusterToGroup(sponsorName) {
    if (busy) return;
    busy = true;

    try {
      const sponsors = SponsorStorage.getAll();
      const members = sponsors.filter(
        (s) => (s.name || "").toLowerCase() === sponsorName.toLowerCase()
      );
      if (members.length === 0) {
        showToast("Sponsor group not found", "error");
        return;
      }

      // Get shared fields from the first member
      const first = members[0];
      const newSponsor = await SponsorStorage.create({
        name: first.name,
        tagline: first.tagline,
        websiteUrl: first.websiteUrl,
        logoImage: first.logoImage,
        cluster: { tileIndices: [] },
        rewards: [],
      });

      // Enter group edit mode on the new cluster
      refreshSponsorsList();
      editGroup(sponsorName, newSponsor.id);

      showToast(`New cluster added to "${sponsorName}"`, "success");
    } catch (e) {
      showToast(e.message || "Failed to add cluster", "error");
    } finally {
      busy = false;
    }
  }

  /**
   * Add a new cluster to the current editing group.
   * If editing a single sponsor (no group), promotes it to a group first.
   */
  async function addCluster() {
    if (busy) return;
    busy = true;

    try {
      // If editing a single sponsor, promote to group first
      if (!editingGroup) {
        const editingId = sponsorForm ? sponsorForm.getEditingSponsorId() : null;
        if (!editingId) return; // Can't add cluster to a new unsaved sponsor

        // Save the current sponsor's data
        const formData = sponsorForm.getFormData();
        const selectedTiles = hexSelector.getSelectedTiles();
        const rewards = rewardConfig.getRewards();
        await SponsorStorage.update(editingId, {
          ...formData,
          cluster: { tileIndices: selectedTiles },
          rewards: rewards,
        });

        // Set up editingGroup with the single sponsor
        editingGroup = {
          name: formData.name,
          ids: [editingId],
          activeIndex: 0,
          clusterStates: new Map(),
        };
      } else {
        // Save current cluster state
        await saveCurrentClusterState();
      }

      // Get shared fields from form
      const formData = sponsorForm.getFormData();

      // Create new entry with shared fields but empty cluster
      const newSponsor = await SponsorStorage.create({
        name: formData.name,
        tagline: formData.tagline,
        websiteUrl: formData.websiteUrl,
        logoImage: formData.logoImage,
        cluster: { tileIndices: [] },
        rewards: [],
      });

      // Add to group
      editingGroup.ids.push(newSponsor.id);
      editingGroup.activeIndex = editingGroup.ids.length - 1;

      // Load the new empty cluster
      loadClusterAtIndex(editingGroup.activeIndex);
      renderClusterTabs();
      refreshSponsorsList();

      showToast("New cluster added", "success");
    } catch (e) {
      showToast(e.message || "Failed to add cluster", "error");
    } finally {
      busy = false;
    }
  }

  /**
   * Render cluster tabs — always visible.
   * Shows group cluster tabs when editing a group, or a single "Cluster 1" tab otherwise.
   */
  function renderClusterTabs() {
    if (editingGroup) {
      // Multi-cluster group
      const tabs = editingGroup.ids.map((id, i) => {
        const sponsor = SponsorStorage.getById(id);
        const tileCount = sponsor?.cluster?.tileIndices?.length || 0;
        const active = i === editingGroup.activeIndex ? " active" : "";
        return `<button class="cluster-tab${active}" data-index="${i}">Cluster ${i + 1} (${tileCount})</button>`;
      });

      clusterTabsEl.innerHTML =
        `<span class="cluster-tabs-label">Clusters:</span>` +
        tabs.join("") +
        `<button class="cluster-tab-add" title="Add cluster">+</button>`;
    } else {
      // Single cluster (new sponsor or editing single sponsor)
      const editingId = sponsorForm ? sponsorForm.getEditingSponsorId() : null;
      const showAdd = !!editingId; // Show "+" only when editing an existing sponsor
      const tileCount = editingId
        ? (SponsorStorage.getById(editingId)?.cluster?.tileIndices?.length || 0)
        : (hexSelector ? hexSelector.getSelectedTiles().length : 0);

      clusterTabsEl.innerHTML =
        `<span class="cluster-tabs-label">Clusters:</span>` +
        `<button class="cluster-tab active" data-index="0">Cluster 1 (${tileCount})</button>` +
        (showAdd ? `<button class="cluster-tab-add" title="Add cluster">+</button>` : "");
    }
  }

  /**
   * Update assigned tiles for group editing — excludes all group members,
   * then adds sibling (non-active) cluster tiles as assigned/dimmed
   */
  function updateGroupAssignedTiles(activeId) {
    if (!editingGroup) {
      updateAssignedTiles(activeId);
      return;
    }

    const sponsors = SponsorStorage.getAll();
    const groupIdSet = new Set(editingGroup.ids);
    const assigned = new Set();
    const tileMap = new Map();

    // Add all non-group sponsor tiles as assigned
    for (const sponsor of sponsors) {
      if (groupIdSet.has(sponsor.id)) continue;
      if (!sponsor.cluster?.tileIndices) continue;

      const info = {
        sponsorId: sponsor.id,
        patternImage: sponsor.patternImage || null,
        patternAdjustment: sponsor.patternAdjustment || {},
      };
      for (const tileIndex of sponsor.cluster.tileIndices) {
        assigned.add(tileIndex);
        tileMap.set(tileIndex, info);
      }
    }

    // Add sibling cluster tiles (non-active group members) as assigned/dimmed
    for (const id of editingGroup.ids) {
      if (id === activeId) continue;
      const sponsor = SponsorStorage.getById(id);
      if (!sponsor?.cluster?.tileIndices) continue;

      const info = {
        sponsorId: sponsor.id,
        patternImage: sponsor.patternImage || null,
        patternAdjustment: sponsor.patternAdjustment || {},
      };
      for (const tileIndex of sponsor.cluster.tileIndices) {
        assigned.add(tileIndex);
        tileMap.set(tileIndex, info);
      }
    }

    hexSelector.setAssignedTiles(assigned, tileMap);

    // Also update assigned moons/billboards (exclude the current group's sponsor name)
    if (moonManager && editingGroup) {
      updateAssignedMoons(editingGroup.name);
    }
    if (billboardManager && editingGroup) {
      updateAssignedBillboards(editingGroup.name);
    }
  }

  async function duplicateSponsor(id) {
    if (busy) return;
    busy = true;

    try {
      const sponsor = SponsorStorage.getById(id);
      if (!sponsor) {
        showToast("Sponsor not found", "error");
        return;
      }

      // Create a copy without the id, cluster, or hex visuals (must be reassigned)
      const duplicate = {
        ...sponsor,
        id: undefined,
        name: sponsor.name,
        cluster: { tileIndices: [] },
        patternImage: null,
        patternAdjustment: {},
      };

      // Deep copy rewards array
      if (sponsor.rewards) {
        duplicate.rewards = JSON.parse(JSON.stringify(sponsor.rewards));
      }

      await SponsorStorage.create(duplicate);
      showToast(`Duplicated "${sponsor.name}"`, "success");
      refreshSponsorsList();
    } catch (err) {
      showToast(err.message || "Failed to duplicate sponsor", "error");
    } finally {
      busy = false;
    }
  }

  async function deleteSponsor(id) {
    if (busy) return;

    const sponsor = SponsorStorage.getById(id);
    if (!sponsor) return;

    const label = editingGroup
      ? `Delete cluster from "${sponsor.name}"?`
      : `Are you sure you want to delete "${sponsor.name}"?`;
    if (!confirm(label)) return;

    busy = true;
    try {
      await SponsorStorage.delete(id);
      showToast(`Cluster deleted from "${sponsor.name}"`, "success");

      // Check if this sponsor name still exists — if not, clear its moon and billboard assignments
      if (sponsor.name) {
        const remaining = SponsorStorage.getAll().filter(
          (s) => s.name && s.name.toLowerCase() === sponsor.name.toLowerCase()
        );
        if (remaining.length === 0) {
          if (moonManager) await moonManager.clearMoonsForSponsor(sponsor.name);
          if (billboardManager) await billboardManager.clearBillboardsForSponsor(sponsor.name);
        }
      }

      if (editingGroup) {
        // Remove from group
        const idx = editingGroup.ids.indexOf(id);
        if (idx !== -1) editingGroup.ids.splice(idx, 1);

        if (editingGroup.ids.length === 0) {
          // No clusters left — clear form
          handleClearForm();
        } else {
          // Adjust active index
          if (editingGroup.activeIndex >= editingGroup.ids.length) {
            editingGroup.activeIndex = editingGroup.ids.length - 1;
          }
          loadClusterAtIndex(editingGroup.activeIndex);
          renderClusterTabs();
        }
      } else if (sponsorForm.getEditingSponsorId() === id) {
        handleClearForm();
      }

      refreshSponsorsList();
      updateAssignedTiles();
      updateAssignedMoons();
      updateAssignedBillboards();
    } finally {
      busy = false;
    }
  }

  function updateAssignedTiles(excludeSponsorId = null) {
    const assignedTiles = SponsorStorage.getAssignedTiles(excludeSponsorId);
    const assignedTileMap = SponsorStorage.getAssignedTileMap(excludeSponsorId);
    hexSelector.setAssignedTiles(assignedTiles, assignedTileMap);
  }

  /**
   * Update which moons are shown as assigned (dimmed) in hex selector.
   * @param {string|null} excludeName - Sponsor name to exclude (currently editing)
   */
  function updateAssignedMoons(excludeName = null) {
    if (!moonManager || !hexSelector) return;
    const assignedMap = moonManager.getAssignedMoons(excludeName);
    hexSelector.setAssignedMoons(assignedMap);
  }

  /**
   * Update which billboards are shown as assigned (dimmed) in hex selector.
   * @param {string|null} excludeName - Sponsor name to exclude (currently editing)
   */
  function updateAssignedBillboards(excludeName = null) {
    if (!billboardManager || !hexSelector) return;
    const assignedMap = billboardManager.getAssignedBillboards(excludeName);
    hexSelector.setAssignedBillboards(assignedMap);
  }

  // ========================
  // UTILITIES
  // ========================

  function showToast(message, type = "success") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    // Remove after 3 seconds
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(100%)";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // ========================
  // COLUMN RESIZER
  // ========================

  const columnResizer = {
    handles: [],
    grid: null,
    gap: 8, // matches --space-sm
    minCol: 200,
    cols: [340, 375, 0, 320], // index 2 = flex, computed at runtime

    init(gridEl) {
      this.grid = gridEl;
      this.gap = parseInt(getComputedStyle(gridEl).gap) || 8;

      // Compute initial col3 from available space
      const gridLeft =
        parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--space-sm",
          ),
        ) || 8;
      const totalWidth = window.innerWidth - gridLeft * 2;
      const fixedSum =
        this.cols[0] + this.cols[1] + this.cols[3] + this.gap * 3;
      this.cols[2] = Math.max(this.minCol, totalWidth - fixedSum);

      this._applyWidths();

      // Create 3 handles (between cols 1-2, 2-3, 3-4)
      for (let i = 0; i < 3; i++) {
        const handle = document.createElement("div");
        handle.className = "col-resize-handle";
        handle.dataset.index = i;
        document.body.appendChild(handle);
        this.handles.push(handle);
        this._bindHandle(handle, i);
      }

      this._positionHandles();

      window.addEventListener("resize", () => {
        this._recalcFlex();
        this._applyWidths();
        this._positionHandles();
      });
    },

    _bindHandle(handle, index) {
      let startX, startLeftCol, startRightCol;

      const onMouseMove = (e) => {
        const dx = e.clientX - startX;
        const leftIdx = index;
        const rightIdx = index + 1;

        let newLeft = startLeftCol + dx;
        let newRight = startRightCol - dx;

        // Enforce minimums
        if (newLeft < this.minCol) {
          newRight -= this.minCol - newLeft;
          newLeft = this.minCol;
        }
        if (newRight < this.minCol) {
          newLeft -= this.minCol - newRight;
          newRight = this.minCol;
        }
        if (newLeft < this.minCol || newRight < this.minCol) return;

        this.cols[leftIdx] = newLeft;
        this.cols[rightIdx] = newRight;
        this._applyWidths();
        this._positionHandles();
      };

      const onMouseUp = () => {
        handle.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        // Trigger resize for hex selector
        handleResize();
      };

      handle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startX = e.clientX;
        startLeftCol = this.cols[index];
        startRightCol = this.cols[index + 1];
        handle.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
      });
    },

    _recalcFlex() {
      const gridLeft =
        parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--space-sm",
          ),
        ) || 8;
      const totalWidth = window.innerWidth - gridLeft * 2;
      const fixedSum =
        this.cols[0] + this.cols[1] + this.cols[3] + this.gap * 3;
      this.cols[2] = Math.max(this.minCol, totalWidth - fixedSum);
    },

    _applyWidths() {
      const s = this.grid.style;
      s.setProperty("--col1", this.cols[0] + "px");
      s.setProperty("--col2", this.cols[1] + "px");
      s.setProperty("--col3", this.cols[2] + "px");
      s.setProperty("--col4", this.cols[3] + "px");
    },

    _positionHandles() {
      const rect = this.grid.getBoundingClientRect();
      let x = rect.left;
      for (let i = 0; i < 3; i++) {
        x += this.cols[i] + this.gap;
        this.handles[i].style.left = x - 5 + "px";
      }
    },

  };

  // ========================
  // START
  // ========================

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
