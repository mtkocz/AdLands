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

  // Sponsor list filter: "sponsors" | "players" | "all"
  let sponsorListFilter = "sponsors";

  // UI elements
  const selectionCountEl = document.getElementById("selection-count");
  const selectedTilesListEl = document.getElementById("selected-tiles-list");
  const sponsorsListEl = document.getElementById("sponsors-list");
  const clearSelectionBtn = document.getElementById("clear-selection-btn");
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFileInput = document.getElementById("import-file");
  const addSponsorBtn = document.getElementById("add-sponsor-btn");
  const toastContainer = document.getElementById("toast-container");

  // Form view elements
  const formPanelTitle = document.getElementById("form-panel-title");
  const viewSponsorInfo = document.getElementById("view-sponsor-info");
  const viewTerritories = document.getElementById("view-territories");
  const saveSponsorInfoBtn = document.getElementById("save-sponsor-info-btn");
  const saveTerritoryBtn = document.getElementById("save-territory-btn");
  const clearFormBtnInfo = document.getElementById("clear-form-btn-info");
  const clearFormBtnTerritory = document.getElementById("clear-form-btn-territory");

  // Currently active form view: 'info' or 'territories'
  let activeView = "info";

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
      onAdjustmentChange: handleAdjustmentChange,
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

    // Done — fade out loading overlay
    setLoadingProgress(100, "Ready");
    hideLoading();
  }

  function setupEventListeners() {
    // Save buttons (both views)
    saveSponsorInfoBtn.addEventListener("click", handleSaveSponsor);
    saveTerritoryBtn.addEventListener("click", handleSaveSponsor);

    // Clear buttons (both views)
    clearFormBtnInfo.addEventListener("click", handleClearForm);
    clearFormBtnTerritory.addEventListener("click", handleClearForm);

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
    addSponsorBtn.addEventListener("click", handleNewSponsor);

    // Sponsor list tab filter (reload from server when switching to User Territories
    // to pick up any pending image submissions)
    document.querySelector(".sponsor-tabs")?.addEventListener("click", (e) => {
      const tab = e.target.closest(".sponsor-tab");
      if (!tab) return;
      document.querySelectorAll(".sponsor-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      sponsorListFilter = tab.dataset.filter;
      if (tab.dataset.filter === "players") {
        SponsorStorage.reload().then(() => refreshSponsorsList());
      } else {
        refreshSponsorsList();
      }
    });

    // Cross-tab sync: refresh sponsor list when game tab creates/updates/deletes territories
    if (SponsorStorage._channel) {
      SponsorStorage._channel.addEventListener("message", (e) => {
        const action = e.data?.action;
        if (action === "create" || action === "delete" || action === "update") {
          SponsorStorage.reload().then(() => {
            // Auto-switch to "User Territories" tab when a player territory arrives
            if (action === "create" && e.data.sponsor?.isPlayerTerritory) {
              sponsorListFilter = "players";
              document.querySelectorAll(".sponsor-tab").forEach((t) => {
                t.classList.toggle("active", t.dataset.filter === "players");
              });
            }
            // Auto-switch to User Territories when an image is submitted for review
            if (action === "update") {
              sponsorListFilter = "players";
              document.querySelectorAll(".sponsor-tab").forEach((t) => {
                t.classList.toggle("active", t.dataset.filter === "players");
              });
            }
            refreshSponsorsList();
          });
        }
      });
    }

    // Window resize
    window.addEventListener("resize", handleResize);

    // Sponsor list — single delegated handler (survives innerHTML rebuilds)
    sponsorsListEl.addEventListener("click", (e) => {
      // Handle group header clicks → show sponsor info
      const groupHeader = e.target.closest(".sponsor-group-header");
      if (groupHeader) {
        const group = groupHeader.closest(".sponsor-group");
        if (e.target.closest(".delete-entire-sponsor-btn")) {
          deleteEntireSponsor(group.dataset.name);
        } else if (e.target.closest(".pause-sponsor-btn")) {
          togglePauseSponsor(group.dataset.name);
        } else if (e.target.closest(".add-cluster-btn")) {
          addClusterToGroup(group.dataset.name);
        } else if (!e.target.closest(".sponsor-card-actions")) {
          if (editingGroup && editingGroup.groupKey === group.dataset.name) {
            // Already editing this group — switch to sponsor info view
            showSponsorInfoView();
          } else {
            // Immediately expand and load sponsor info into form panel
            group.classList.add("expanded");
            editGroup(group.dataset.name, null).catch(err => {
              console.error("[AdminApp] editGroup failed:", err);
              showToast("Failed to load sponsor: " + (err.message || err), "error");
            });
          }
        }
        return;
      }

      // Handle submission review buttons (approve/reject)
      const approveBtn = e.target.closest(".approve-submission-btn") || e.target.closest(".approve-image-btn");
      if (approveBtn) {
        reviewTerritorySubmission(approveBtn.dataset.id, "approve");
        return;
      }
      const rejectBtn = e.target.closest(".reject-submission-btn") || e.target.closest(".reject-image-btn");
      if (rejectBtn) {
        reviewTerritorySubmission(rejectBtn.dataset.id, "reject");
        return;
      }

      // Handle pending review adjustment sliders
      const adjSlider = e.target.closest(".pending-review-adjustments input[type=range]");
      if (adjSlider) return; // handled by input event below

      // Handle territory row clicks within groups → show territory view
      const clusterRow = e.target.closest(".sponsor-cluster-row");
      if (clusterRow) {
        const id = clusterRow.dataset.id;
        if (e.target.closest(".delete-sponsor-btn")) {
          deleteSponsor(id);
        } else {
          const group = clusterRow.closest(".sponsor-group");
          // If already editing this group, just switch territory (saves unsaved changes)
          if (editingGroup && editingGroup.groupKey === group.dataset.name) {
            const idx = editingGroup.ids.indexOf(id);
            if (idx !== -1 && idx !== editingGroup.activeIndex) {
              switchCluster(idx);
            }
            showTerritoryView();
          } else {
            editGroup(group.dataset.name, id).catch(err => {
              console.error("[AdminApp] editGroup failed:", err);
              showToast("Failed to load sponsor: " + (err.message || err), "error");
            });
          }
        }
        return;
      }

      // Handle single sponsor cards (non-grouped)
      const card = e.target.closest(".sponsor-card");
      if (!card) return;
      const id = card.dataset.id;
      const cardName = card.dataset.name;

      if (e.target.closest(".delete-entire-sponsor-btn")) {
        deleteEntireSponsor(cardName);
      } else if (e.target.closest(".pause-sponsor-btn")) {
        togglePauseSponsor(cardName);
      } else if (e.target.closest(".duplicate-sponsor-btn")) {
        duplicateSponsor(id);
      } else if (!e.target.closest(".sponsor-card-actions")) {
        const isAlreadyEditing = !editingGroup && card.classList.contains("editing");
        if (isAlreadyEditing) {
          handleClearForm();
          refreshSponsorsList();
        } else {
          editSponsor(id).catch(err => {
            console.error("[AdminApp] editSponsor failed:", err);
            showToast("Failed to load sponsor: " + (err.message || err), "error");
          });
        }
      }
    });

    // Pending review adjustment sliders — update value display on input
    sponsorsListEl.addEventListener("input", (e) => {
      const slider = e.target;
      if (!slider.matches(".pending-review-adjustments input[type=range]")) return;
      const valSpan = slider.nextElementSibling;
      if (valSpan) valSpan.textContent = slider.value;
    });

    // Pending review adjustment sliders — save on change (mouse release)
    sponsorsListEl.addEventListener("change", (e) => {
      const slider = e.target;
      if (!slider.matches(".pending-review-adjustments input[type=range]")) return;
      const card = slider.closest(".pending-review-adjustments");
      if (!card) return;
      const sponsorId = card.dataset.id;
      const adj = {
        scale: parseFloat(card.querySelector(".adj-scale")?.value ?? 1),
        offsetX: parseFloat(card.querySelector(".adj-offsetX")?.value ?? 0),
        offsetY: parseFloat(card.querySelector(".adj-offsetY")?.value ?? 0),
        saturation: parseFloat(card.querySelector(".adj-saturation")?.value ?? 0.7),
      };
      SponsorStorage.update(sponsorId, { patternAdjustment: adj }).catch(err =>
        console.warn("[Admin] Adjustment save failed:", err),
      );
    });
  }

  // ========================
  // VIEW SWITCHING (driven by sponsor list clicks)
  // ========================

  /**
   * Show the sponsor info view in the form panel
   */
  function showSponsorInfoView() {
    activeView = "info";
    viewSponsorInfo.classList.add("active");
    viewTerritories.classList.remove("active");
    formPanelTitle.textContent = "Sponsor Information";
  }

  /**
   * Show the territory settings view in the form panel
   */
  function showTerritoryView() {
    activeView = "territories";
    viewSponsorInfo.classList.remove("active");
    viewTerritories.classList.add("active");
    formPanelTitle.textContent = "Territory Settings";
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
      // Selection changed — need full texture apply (but track image to avoid redundant reload)
      _lastPatternImage = formData.patternImage;
      hexSelector.setPatternPreview(
        formData.patternImage,
        formData.patternAdjustment,
      );
    } else {
      _lastPatternImage = null;
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
          // Include live moon/billboard revenue for this row
          const rowTotal = rev.total + liveMoonRev + liveBbRev;
          const revEl = row.querySelector(".sponsor-cluster-row-revenue");
          const newRevSpan = rowTotal > 0
            ? `$${fmtUSD(rowTotal)}/mo`
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
      const groupEl = sponsorsListEl.querySelector(`.sponsor-group[data-name="${CSS.escape(editingGroup.groupKey)}"]`);
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

  // Track the last pattern image data URL to avoid redundant texture reloads
  let _lastPatternImage = null;

  function handleFormChange(formData) {
    // Update pattern preview on selected tiles, moons, and billboards in real-time
    const selectedTiles = hexSelector.getSelectedTiles();
    const selectedMoons = hexSelector.getSelectedMoons();
    const selectedBillboards = hexSelector.getSelectedBillboards();
    const hasSelection = selectedTiles.length > 0 || selectedMoons.length > 0 || selectedBillboards.length > 0;

    if (formData.patternImage && hasSelection) {
      // Only do the expensive full texture reload when the image itself changed
      if (formData.patternImage !== _lastPatternImage) {
        _lastPatternImage = formData.patternImage;
        hexSelector.setPatternPreview(
          formData.patternImage,
          formData.patternAdjustment,
        );
      }
      // If just text fields changed (name/tagline/url), skip pattern update entirely
    } else if (!formData.patternImage) {
      if (_lastPatternImage !== null) {
        _lastPatternImage = null;
        hexSelector.setPatternPreview(null);
      }
    }
  }

  /**
   * Lightweight handler for adjustment-only slider changes.
   * Uses updatePatternAdjustment which only updates shader uniforms
   * instead of re-parsing the base64 image and recreating textures.
   */
  function handleAdjustmentChange(adjustment) {
    hexSelector.updatePatternAdjustment(adjustment);
  }

  function handleRewardsChange(rewards) {
    // Could add validation feedback here
  }

  async function handleSaveSponsor() {
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }
    busy = true;

    try {
      const formData = sponsorForm.getFormData();

      // Validate shared fields always
      const formValidation = sponsorForm.validate();
      if (!formValidation.valid) {
        showToast(formValidation.errors.join(". "), "error");
        return;
      }

      if (activeView === "info" && editingGroup) {
        // === GROUP INFO-ONLY SAVE ===
        // Save only shared fields, propagate to all territories in group
        const sharedFields = {
          name: formData.name,
          tagline: formData.tagline,
          websiteUrl: formData.websiteUrl,
          logoImage: formData.logoImage,
        };

        try {
          for (const id of editingGroup.ids) {
            await SponsorStorage.update(id, sharedFields);
          }
          showToast(`Sponsor "${formData.name}" info updated (${editingGroup.ids.length} territories)`, "success");
        } catch (e) {
          showToast(e.message || "Failed to save sponsor info", "error");
          return;
        }

        refreshSponsorsList();
      } else if (editingGroup) {
        // === GROUP TERRITORY SAVE ===
        const selectedTiles = hexSelector.getSelectedTiles();
        const rewards = rewardConfig.getRewards();
        const selectedMoonsForGroupSave = hexSelector ? hexSelector.getSelectedMoons() : [];
        const selectedBillboardsForGroupSave = hexSelector ? hexSelector.getSelectedBillboards() : [];

        const rewardValidation = rewardConfig.validate();
        if (!rewardValidation.valid) {
          showToast(rewardValidation.errors.join(". "), "error");
          return;
        }

        const activeId = editingGroup.ids[editingGroup.activeIndex];

        if (selectedTiles.length === 0 && selectedMoonsForGroupSave.length === 0 && selectedBillboardsForGroupSave.length === 0) {
          showToast("Active territory must have at least one tile, moon, or billboard", "error");
          return;
        }

        // Tile conflict check (exclude all group members)
        for (const id of editingGroup.ids) {
          const tiles = id === activeId
            ? selectedTiles
            : (SponsorStorage.getById(id)?.cluster?.tileIndices || []);
          if (tiles.length === 0) continue;
          const check = SponsorStorage.areTilesUsed(tiles, id);
          if (check.isUsed) {
            const groupIdSet = new Set(editingGroup.ids);
            const conflictSponsor = SponsorStorage.getAll().find(
              (s) => !groupIdSet.has(s.id) && s.cluster?.tileIndices?.some((t) => tiles.includes(t))
            );
            if (conflictSponsor) {
              showToast(`Tiles conflict with "${conflictSponsor.name}"`, "error");
              return;
            }
          }
        }

        const sharedFields = {
          name: formData.name,
          tagline: formData.tagline,
          websiteUrl: formData.websiteUrl,
          logoImage: formData.logoImage,
        };

        // Detect territory type from selection
        let territoryType = null;
        if (selectedTiles.length > 0) territoryType = 'hex';
        else if (selectedMoonsForGroupSave.length > 0) territoryType = 'moon';
        else if (selectedBillboardsForGroupSave.length > 0) territoryType = 'billboard';

        // Check previous territory type to detect type changes
        const prevGroupSponsor = SponsorStorage.getById(activeId);
        const prevGroupType = prevGroupSponsor?.territoryType || null;

        try {
          await SponsorStorage.update(activeId, {
            ...sharedFields,
            cluster: { tileIndices: selectedTiles },
            territoryType: territoryType,
            patternImage: formData.patternImage,
            patternAdjustment: formData.patternAdjustment,
            rewards: rewards,
          });

          for (const id of editingGroup.ids) {
            if (id === activeId) continue;
            await SponsorStorage.update(id, sharedFields);
          }

          showToast(`"${formData.name}" saved (${editingGroup.ids.length} territories)`, "success");
        } catch (e) {
          showToast(e.message || "Failed to save group", "error");
          return;
        }

        // Save moon assignments (only when this territory involves moons,
        // or was previously a moon territory that is changing type)
        if (territoryType === 'moon' || prevGroupType === 'moon') {
          try {
            if (moonManager) {
              await moonManager.saveMoonsForSponsor(selectedMoonsForGroupSave, formData);
            }
          } catch (e) {
            console.warn("[AdminApp] Moon save failed:", e);
          }
        }

        // Save billboard assignments (only when this territory involves billboards,
        // or was previously a billboard territory that is changing type)
        if (territoryType === 'billboard' || prevGroupType === 'billboard') {
          try {
            if (billboardManager) {
              await billboardManager.saveBillboardsForSponsor(selectedBillboardsForGroupSave, formData);
            }
          } catch (e) {
            console.warn("[AdminApp] Billboard save failed:", e);
          }
        }

        handleClearForm();
        refreshSponsorsList();
      } else {
        // === SINGLE SPONSOR SAVE (always full save — info + territory) ===
        const selectedTiles = hexSelector.getSelectedTiles();
        const rewards = rewardConfig.getRewards();
        const selectedMoonsForSave = hexSelector ? hexSelector.getSelectedMoons() : [];
        const selectedBillboardsForSave = hexSelector ? hexSelector.getSelectedBillboards() : [];

        // Detect territory type from selection
        let singleTerritoryType = null;
        if (selectedTiles.length > 0) singleTerritoryType = 'hex';
        else if (selectedMoonsForSave.length > 0) singleTerritoryType = 'moon';
        else if (selectedBillboardsForSave.length > 0) singleTerritoryType = 'billboard';

        const sponsor = {
          ...formData,
          cluster: { tileIndices: selectedTiles },
          territoryType: singleTerritoryType,
          rewards: rewards,
        };

        const editingId = sponsorForm.getEditingSponsorId();

        // Check previous territory type to detect type changes
        const prevSponsor = editingId ? SponsorStorage.getById(editingId) : null;
        const prevType = prevSponsor?.territoryType || null;

        // Tile conflict check
        if (selectedTiles.length > 0) {
          const tileCheck = SponsorStorage.areTilesUsed(selectedTiles, editingId);
          if (tileCheck.isUsed) {
            showToast(
              `Some tiles are already assigned to "${tileCheck.sponsorName}"`,
              "error",
            );
            return;
          }
        }

        let createdSponsor = null;
        try {
          if (editingId) {
            await SponsorStorage.update(editingId, sponsor);
            showToast(`Sponsor "${sponsor.name}" updated`, "success");
          } else {
            createdSponsor = await SponsorStorage.create(sponsor);
            showToast(`Sponsor "${sponsor.name}" created`, "success");
          }
        } catch (e) {
          showToast(e.message || "Failed to save sponsor", "error");
          return;
        }

        // Save moon assignments (only when this territory involves moons,
        // or was previously a moon territory that is changing type)
        if (singleTerritoryType === 'moon' || prevType === 'moon') {
          try {
            if (moonManager) {
              await moonManager.saveMoonsForSponsor(selectedMoonsForSave, formData);
            }
          } catch (e) {
            console.warn("[AdminApp] Moon save failed:", e);
          }
        }

        // Save billboard assignments (only when this territory involves billboards,
        // or was previously a billboard territory that is changing type)
        if (singleTerritoryType === 'billboard' || prevType === 'billboard') {
          try {
            if (billboardManager) {
              await billboardManager.saveBillboardsForSponsor(selectedBillboardsForSave, formData);
            }
          } catch (e) {
            console.warn("[AdminApp] Billboard save failed:", e);
          }
        }

        if (createdSponsor) {
          // New sponsor — enter edit mode and show territory view
          refreshSponsorsList();
          await editSponsor(createdSponsor.id);
          showTerritoryView();
        } else {
          handleClearForm();
          refreshSponsorsList();
        }
      }
    } finally {
      busy = false;
    }
  }

  function handleClearForm() {
    editingGroup = null;
    _lastPatternImage = null;
    sponsorForm.clear();
    hexSelector.clearSelection();
    hexSelector.setPatternPreview(null);
    rewardConfig.clear();
    updateAssignedTiles();
    updateAssignedMoons();
    updateAssignedBillboards();
    selectedTilesListEl.textContent = "";
    showSponsorInfoView();
  }

  function handleNewSponsor() {
    handleClearForm();
    refreshSponsorsList();
    const nameInput = document.getElementById("sponsor-name");
    if (nameInput) {
      nameInput.focus();
    }
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

  /** Get the grouping key for a sponsor/territory entry */
  function getGroupKey(s) {
    if (s.isPlayerTerritory) {
      return "player:" + (s.ownerEmail || s.ownerUid || s.name || "");
    }
    return (s.name || "").toLowerCase();
  }

  /** Resolve all group members from a groupKey */
  function getGroupMembers(groupKey) {
    const sponsors = SponsorStorage.getAll();
    if (groupKey.startsWith("player:")) {
      const identifier = groupKey.slice(7);
      return sponsors.filter(
        (s) => s.isPlayerTerritory && (s.ownerEmail === identifier || s.ownerUid === identifier)
      );
    }
    return sponsors.filter(
      (s) => (s.name || "").toLowerCase() === groupKey.toLowerCase()
    );
  }

  function refreshSponsorsList() {
    const allSponsors = SponsorStorage.getAll();

    // Apply tab filter
    let sponsors;
    if (sponsorListFilter === "players") {
      sponsors = allSponsors.filter((s) => !!s.isPlayerTerritory);
    } else if (sponsorListFilter === "sponsors") {
      sponsors = allSponsors.filter((s) => !s.isPlayerTerritory);
    } else {
      sponsors = allSponsors;
    }

    // Update tab counts
    const playerCount = allSponsors.filter((s) => !!s.isPlayerTerritory).length;
    const pendingCount = allSponsors.filter((s) => s.isPlayerTerritory && (s.submissionStatus === "pending" || s.imageStatus === "pending")).length;
    const sponsorCount = allSponsors.length - playerCount;
    const tabEls = document.querySelectorAll(".sponsor-tab");
    tabEls.forEach((tab) => {
      const filter = tab.dataset.filter;
      if (filter === "sponsors") tab.textContent = `Sponsors (${sponsorCount})`;
      else if (filter === "players") {
        tab.innerHTML = `User Territories (${playerCount})${pendingCount > 0 ? ` <span class="pending-badge">${pendingCount}</span>` : ""}`;
      }
      else if (filter === "all") tab.textContent = `All (${allSponsors.length})`;
    });

    if (sponsors.length === 0) {
      const emptyMsg = sponsorListFilter === "players"
        ? "No user territories yet"
        : "No sponsors created yet";
      sponsorsListEl.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }

    // Build pending review section for player territories tab
    let pendingHtml = "";
    if (sponsorListFilter === "players") {
      const pendingSponsors = sponsors.filter(s =>
        s.submissionStatus === "pending" || (s.imageStatus === "pending" && s.pendingImage)
      );
      if (pendingSponsors.length > 0) {
        const pendingCards = pendingSponsors.map(s => {
          const logoSrc = s.logoUrl || s.logoImage;
          const tileCount = s.cluster?.tileIndices?.length || 0;
          const adj = s.patternAdjustment || {};
          const pTitle = escapeHtml(s.pendingTitle || s.name || "");
          const pTagline = escapeHtml(s.pendingTagline || s.tagline || "");
          const pUrl = escapeHtml(s.pendingWebsiteUrl || s.websiteUrl || "");
          const hasImage = !!s.pendingImage;
          return `
            <div class="pending-review-card" data-id="${s.id}">
              <div class="pending-review-card-header">
                <div class="sponsor-card-logo">
                  ${logoSrc ? `<img src="${logoSrc}" alt="${pTitle}">` : '<span style="color:#666;font-family:var(--font-small);font-size:var(--font-size-small);">No logo</span>'}
                </div>
                <div class="pending-review-card-info">
                  <div class="sponsor-card-name">${escapeHtml(s.ownerEmail || s.name)}</div>
                  <div class="sponsor-card-stats">${tileCount} tiles &middot; ${s.tierName || "territory"}</div>
                </div>
              </div>
              <div class="pending-review-fields" data-id="${s.id}">
                <div class="review-field"><label>Name</label><input type="text" class="review-input review-title" value="${pTitle}" maxlength="40"></div>
                <div class="review-field"><label>Tagline</label><input type="text" class="review-input review-tagline" value="${pTagline}" maxlength="80"></div>
                <div class="review-field"><label>URL</label><input type="url" class="review-input review-url" value="${pUrl}" maxlength="200"></div>
              </div>
              ${hasImage ? `
              <div class="pending-review-card-texture">
                <img src="${s.pendingImage}" alt="Uploaded texture" class="territory-pending-img">
              </div>
              <div class="pending-review-adjustments" data-id="${s.id}">
                <div class="adj-row"><label>Scale</label><input type="range" class="adj-scale" min="0.1" max="3" step="0.05" value="${adj.scale ?? 1}"><span class="adj-val">${adj.scale ?? 1}</span></div>
                <div class="adj-row"><label>Offset X</label><input type="range" class="adj-offsetX" min="-1" max="1" step="0.05" value="${adj.offsetX ?? 0}"><span class="adj-val">${adj.offsetX ?? 0}</span></div>
                <div class="adj-row"><label>Offset Y</label><input type="range" class="adj-offsetY" min="-1" max="1" step="0.05" value="${adj.offsetY ?? 0}"><span class="adj-val">${adj.offsetY ?? 0}</span></div>
                <div class="adj-row"><label>Saturation</label><input type="range" class="adj-saturation" min="0" max="1.5" step="0.05" value="${adj.saturation ?? 0.7}"><span class="adj-val">${adj.saturation ?? 0.7}</span></div>
              </div>` : '<div class="pending-review-no-image">No image uploaded</div>'}
              <div class="review-field review-comment-field"><label>Rejection Comment</label><textarea class="review-input review-comment" placeholder="Reason for rejection (sent to player)" rows="2"></textarea></div>
              <div class="territory-review-actions">
                <button class="btn-approve approve-submission-btn" data-id="${s.id}">Approve</button>
                <button class="btn-reject reject-submission-btn" data-id="${s.id}">Reject</button>
              </div>
            </div>`;
        }).join("");
        pendingHtml = `
          <div class="pending-review-section">
            <div class="pending-review-section-header">Pending Review (${pendingSponsors.length})</div>
            <div class="pending-review-grid">${pendingCards}</div>
          </div>`;
        // Remove pending sponsors from the main list so they don't duplicate
        sponsors = sponsors.filter(s =>
          !(s.submissionStatus === "pending" || (s.imageStatus === "pending" && s.pendingImage))
        );
      }
    }

    // Sort sponsors alphabetically by name
    const sortedSponsors = [...sponsors].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, {
        sensitivity: "base",
      }),
    );

    // Group: player territories by ownerEmail, sponsors by name
    const groups = new Map();
    for (const s of sortedSponsors) {
      const key = getGroupKey(s);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    const tierMap = hexSelector ? hexSelector.getTierMap() : null;
    let totalMonthly = 0;
    const htmlParts = [];
    const currentEditingId = sponsorForm ? sponsorForm.getEditingSponsorId() : null;

    for (const [, members] of groups) {
      const hasPlayerTerritory = members.some((s) => !!s.isPlayerTerritory);
      if (members.length === 1 && !hasPlayerTerritory) {
        // Single sponsor — render as flat card
        const sponsor = members[0];
        const rev = calcRevenueForTiles(sponsor.cluster?.tileIndices, tierMap);
        const moonRev = calcMoonRevenue(sponsor.name);
        const bbRev = calcBillboardRevenue(sponsor.name);
        const sponsorTotal = rev.total + moonRev + bbRev;
        totalMonthly += sponsorTotal;

        const isEditing = sponsor.id === currentEditingId;
        const logoSrc = sponsor.logoUrl || sponsor.logoImage;
        const isPaused = !!sponsor.paused;
        htmlParts.push(`
            <div class="sponsor-card${isEditing ? " editing" : ""}${isPaused ? " paused" : ""}" data-id="${sponsor.id}" data-name="${escapeHtml(getGroupKey(sponsor))}">
                <div class="sponsor-card-logo">
                    ${
                      logoSrc
                        ? `<img src="${logoSrc}" alt="${escapeHtml(sponsor.name)}">`
                        : '<span style="color:#666;font-family:var(--font-small);font-size:var(--font-size-small);">No logo</span>'
                    }
                </div>
                <div class="sponsor-card-info">
                    <div class="sponsor-card-name">${escapeHtml(sponsor.name)}${isPaused ? ' <span class="paused-badge">PAUSED</span>' : ""}</div>
                    <div class="sponsor-card-stats">
                        ${sponsor.cluster?.tileIndices?.length || 0} tiles${moonRev > 0 ? ", " + moonManager.getMoonsForSponsor(sponsor.name).length + " moons" : ""}${bbRev > 0 ? ", " + (billboardManager ? billboardManager.getBillboardsForSponsor(sponsor.name).length : 0) + " billboards" : ""},
                        ${sponsor.rewards?.length || 0} rewards
                    </div>
                    ${sponsorTotal > 0 ? `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(sponsorTotal)}/mo</span></div>` : ""}
                </div>
                <div class="sponsor-card-actions">
                    <button class="icon-btn pause-sponsor-btn" title="${isPaused ? "Resume" : "Pause"}">&#x23F8;</button>
                    <button class="icon-btn duplicate-sponsor-btn" title="Duplicate">&#x29C9;</button>
                    <button class="icon-btn delete-entire-sponsor-btn" title="Delete">&times;</button>
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

        // Pre-calculate moon/billboard revenue (shared per sponsor name)
        const groupMoonRev = calcMoonRevenue(first.name);
        const groupBbRev = calcBillboardRevenue(first.name);
        let moonRevClaimed = false;
        let bbRevClaimed = false;

        // Aggregate revenue across all clusters + moons + billboards
        let groupRevenue = 0;
        const activeEditId = editingGroup ? editingGroup.ids[editingGroup.activeIndex] : null;
        const clusterRows = members.map((s, i) => {
          const tileCount = s.cluster?.tileIndices?.length || 0;
          const rev = calcRevenueForTiles(s.cluster?.tileIndices, tierMap);

          // Detect territory type from stored field, with fallback inference
          let tt = s.territoryType;
          let typeLabel, typeClass;
          if (tt === 'hex' || (!tt && tileCount > 0)) {
            tt = 'hex'; typeLabel = "Hex Cluster"; typeClass = "type-hex";
          } else if (tt === 'moon') {
            typeLabel = "Moon"; typeClass = "type-moon";
          } else if (tt === 'billboard') {
            typeLabel = "Billboard"; typeClass = "type-billboard";
          } else if (!tt && tileCount === 0 && !moonRevClaimed && groupMoonRev > 0) {
            // Infer as moon territory (backward compat for missing territoryType)
            tt = 'moon'; typeLabel = "Moon"; typeClass = "type-moon";
          } else if (!tt && tileCount === 0 && !bbRevClaimed && groupBbRev > 0) {
            // Infer as billboard territory
            tt = 'billboard'; typeLabel = "Billboard"; typeClass = "type-billboard";
          } else {
            typeLabel = "Empty"; typeClass = "type-empty";
          }

          // Row revenue: tile revenue + moon/billboard revenue (claimed once per type)
          let rowRev = rev.total;
          if (tt === 'moon' && !moonRevClaimed) {
            rowRev += groupMoonRev;
            moonRevClaimed = true;
          } else if (tt === 'billboard' && !bbRevClaimed) {
            rowRev += groupBbRev;
            bbRevClaimed = true;
          }
          groupRevenue += rowRev;
          totalMonthly += rowRev;

          const revSpan = rowRev > 0
            ? `<span class="sponsor-cluster-row-revenue">$${fmtUSD(rowRev)}/mo</span>`
            : "";

          const isActive = s.id === activeEditId;

          // Player territories: compact row with thumbnail, info, and actions
          if (s.isPlayerTerritory) {
            const textureSrc = s.pendingImage || s.patternImage || s.patternUrl;
            const thumbHtml = textureSrc
              ? `<img src="${textureSrc}" alt="" class="territory-thumb-img">`
              : '<span class="territory-thumb-empty"></span>';

            const infoTitle = s.pendingTitle || s.title || s.name || "";
            const infoTagline = s.pendingTagline || s.tagline || "";
            const infoUrl = s.pendingWebsiteUrl || s.websiteUrl || "";

            const titleLine = infoTitle
              ? `<strong>${escapeHtml(infoTitle)}</strong>`
              : `<em style="color:#555">Untitled</em>`;
            const taglinePart = infoTagline ? ` &middot; ${escapeHtml(infoTagline)}` : "";
            const revPart = rowRev > 0 ? ` &middot; <span class="territory-row-rev">$${fmtUSD(rowRev)}/mo</span>` : "";
            const metaLine = `${tileCount} tiles &middot; <span class="sponsor-cluster-row-type ${typeClass}">${typeLabel}</span>${revPart}`;
            const urlLine = infoUrl
              ? `<div class="territory-row-url"><a href="${escapeHtml(infoUrl)}" target="_blank" rel="noopener">${escapeHtml(infoUrl)}</a></div>`
              : "";

            // Review actions
            const subStatus = s.submissionStatus || s.imageStatus;
            let actionsHtml = `<button class="icon-btn delete-sponsor-btn" title="Delete territory">&times;</button>`;
            if (subStatus === "pending") {
              actionsHtml += `
                <button class="btn-approve approve-submission-btn" data-id="${s.id}">Approve</button>
                <button class="btn-reject reject-submission-btn" data-id="${s.id}">Reject</button>`;
            } else if (subStatus === "approved") {
              actionsHtml += `<span class="territory-review-status approved">Approved</span>`;
            } else if (subStatus === "rejected") {
              actionsHtml += `<span class="territory-review-status rejected">Rejected</span>`;
            }

            return `
              <div class="sponsor-cluster-row territory-compact-row${isActive ? " active-territory" : ""}" data-id="${s.id}">
                <div class="territory-row-thumb">${thumbHtml}</div>
                <div class="territory-row-main">
                  <div class="territory-row-title">${titleLine}${taglinePart}</div>
                  <div class="territory-row-meta">${metaLine}</div>
                  ${urlLine}
                </div>
                <div class="territory-row-actions">${actionsHtml}</div>
              </div>
            `;
          }

          // Sponsor territories: simple row
          return `
            <div class="sponsor-cluster-row${isActive ? " active-territory" : ""}" data-id="${s.id}">
                <span class="sponsor-cluster-row-label">${escapeHtml(s.name || ("Territory " + (i + 1)))}</span>
                <span class="sponsor-cluster-row-type ${typeClass}">${typeLabel}</span>
                <span class="sponsor-cluster-row-stats">${tileCount} tiles, ${s.rewards?.length || 0} rewards</span>
                ${rowRev > 0 ? `<span class="sponsor-cluster-row-revenue">$${fmtUSD(rowRev)}/mo</span>` : ""}
                <button class="icon-btn delete-sponsor-btn" title="Delete territory">&times;</button>
            </div>
          `;
        }).join("");

        // Add any unclaimed moon/billboard revenue to group total
        if (!moonRevClaimed) { groupRevenue += groupMoonRev; totalMonthly += groupMoonRev; }
        if (!bbRevClaimed) { groupRevenue += groupBbRev; totalMonthly += groupBbRev; }

        const groupMoonCount = moonManager ? moonManager.getMoonsForSponsor(first.name).length : 0;
        const groupBbCount = billboardManager ? billboardManager.getBillboardsForSponsor(first.name).length : 0;

        const groupRevHtml = groupRevenue > 0
          ? `<div class="sponsor-card-revenue"><span class="sponsor-card-revenue-total">$${fmtUSD(groupRevenue)}/mo</span></div>`
          : "";

        const groupKey = getGroupKey(first);
        const isGroupEditing = editingGroup && editingGroup.groupKey === groupKey;
        const groupLogoSrc = first.logoUrl || first.logoImage;
        const isGroupPaused = members.some((s) => !!s.paused);
        const isNewTerritory = hasPlayerTerritory && members.some((s) => s.imageStatus === "placeholder" || !s.imageStatus);
        const hasPendingImage = hasPlayerTerritory && members.some((s) => s.imageStatus === "pending");
        const groupHighlight = hasPendingImage ? " highlight-pending" : isNewTerritory ? " highlight-new" : "";
        htmlParts.push(`
            <div class="sponsor-group${isGroupEditing ? " editing expanded" : ""}${isGroupPaused ? " paused" : ""}${groupHighlight}" data-name="${escapeHtml(groupKey)}">
                <div class="sponsor-group-header">
                    <span class="sponsor-group-chevron">&#x25B6;</span>
                    <div class="sponsor-card-logo">
                        ${
                          groupLogoSrc
                            ? `<img src="${groupLogoSrc}" alt="${escapeHtml(first.name)}">`
                            : '<span style="color:#666;font-family:var(--font-small);font-size:var(--font-size-small);">No logo</span>'
                        }
                    </div>
                    <div class="sponsor-card-info">
                        <div class="sponsor-card-name">${escapeHtml(hasPlayerTerritory ? (first.ownerEmail || first.name) : first.name)}${isGroupPaused ? ' <span class="paused-badge">PAUSED</span>' : ""}${hasPendingImage ? ' <span class="pending-status-badge">PENDING</span>' : ""}${isNewTerritory && !hasPendingImage ? ' <span class="new-status-badge">NEW</span>' : ""}</div>
                        <span class="sponsor-group-badge">${members.length} territories</span>
                        <div class="sponsor-card-stats">
                            ${totalTiles} tiles${groupMoonCount > 0 ? ", " + groupMoonCount + " moons" : ""}${groupBbCount > 0 ? ", " + groupBbCount + " billboards" : ""}, ${totalRewards} rewards
                        </div>
                        ${groupRevHtml}
                    </div>
                    <div class="sponsor-card-actions">
                        <button class="icon-btn pause-sponsor-btn" title="${isGroupPaused ? "Resume" : "Pause"}">&#x23F8;</button>
                        <button class="icon-btn add-cluster-btn" title="Add territory">+</button>
                        <button class="icon-btn delete-entire-sponsor-btn" title="Delete sponsor">&times;</button>
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

    // Capture currently expanded groups before rebuild
    const expandedNames = new Set();
    sponsorsListEl.querySelectorAll(".sponsor-group.expanded").forEach((g) => {
      expandedNames.add(g.dataset.name);
    });

    sponsorsListEl.innerHTML = pendingHtml + htmlParts.join("") + totalHtml;

    // Restore expanded state
    sponsorsListEl.querySelectorAll(".sponsor-group").forEach((g) => {
      if (expandedNames.has(g.dataset.name)) {
        g.classList.add("expanded");
      }
    });
  }

  async function editSponsor(id) {
    try {
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

      // Auto-select the territory's selection in hex selector
      loadTerritorySelection(sponsor);

      // Load rewards
      if (sponsor.rewards) {
        rewardConfig.loadRewards(sponsor.rewards);
      }

      showSponsorInfoView();
      refreshSponsorsList();
      window.scrollTo({ top: 0, behavior: "smooth" });
      showToast(`Editing "${sponsor.name}"`, "success");
    } catch (err) {
      console.error("[AdminApp] editSponsor error:", err);
      showToast("Failed to load sponsor: " + (err.message || err), "error");
    }
  }

  /**
   * Load a territory's hex/moon/billboard selection into the hex selector.
   * Only loads one type (exclusive territory model).
   */
  function loadTerritorySelection(sponsor) {
    // Clear current selection first
    hexSelector.clearSelection();

    const hasTiles = sponsor.cluster?.tileIndices?.length > 0;
    const moonIndices = moonManager && sponsor.name ? moonManager.getMoonsForSponsor(sponsor.name) : [];
    const bbIndices = billboardManager && sponsor.name ? billboardManager.getBillboardsForSponsor(sponsor.name) : [];

    // Load the territory's type-specific selection
    if (hasTiles) {
      hexSelector.setSelectedTiles(sponsor.cluster.tileIndices);
      hexSelector.transitionToCluster(sponsor.cluster.tileIndices);
    } else if (moonIndices.length > 0) {
      hexSelector.setSelectedMoons(moonIndices);
      hexSelector.transitionToMoon(moonIndices);
    } else if (bbIndices.length > 0) {
      hexSelector.setSelectedBillboards(bbIndices);
      hexSelector.transitionToBillboard(bbIndices);
    }

    // Update assigned items (exclude current sponsor)
    if (moonManager && sponsor.name) updateAssignedMoons(sponsor.name);
    if (billboardManager && sponsor.name) updateAssignedBillboards(sponsor.name);
  }

  // ========================
  // GROUP EDITING
  // ========================

  /**
   * Edit all clusters of a sponsor group
   * @param {string} groupKey - The group key (from getGroupKey / data-name)
   * @param {string|null} startAtId - Optionally start at a specific cluster ID
   */
  async function editGroup(groupKey, startAtId) {
    const members = getGroupMembers(groupKey);
    if (members.length === 0) {
      showToast("Sponsor group not found", "error");
      return;
    }

    // If only one member and not a player territory, edit it directly as a flat card
    if (members.length === 1 && !members[0].isPlayerTerritory) {
      editSponsor(members[0].id).catch(err => {
        console.error("[AdminApp] editSponsor (from group) failed:", err);
        showToast("Failed to load sponsor: " + (err.message || err), "error");
      });
      return;
    }

    try {
      // Determine starting index
      let activeIndex = 0;
      if (startAtId) {
        const idx = members.findIndex((s) => s.id === startAtId);
        if (idx !== -1) activeIndex = idx;
      }

      // Initialize group editing state immediately (before async fetch)
      editingGroup = {
        groupKey: groupKey,
        name: members[0].name || groupKey,
        ids: members.map((s) => s.id),
        activeIndex: activeIndex,
        clusterStates: new Map(),
      };

      // Immediately load form from lite-cached data so the user sees it right away
      sponsorForm.loadSponsor(members[0]);

      // Show the correct view immediately
      if (startAtId) {
        showTerritoryView();
      } else {
        showSponsorInfoView();
      }

      refreshSponsorsList();

      // Fetch full data (including base64 images) in background
      await Promise.all(members.map((s) => SponsorStorage.fetchFull(s.id)));

      // Reload form with full data (now includes base64 images)
      const first = SponsorStorage.getById(editingGroup.ids[0]);
      if (first) {
        sponsorForm.loadSponsor(first);
      }

      // Load active cluster's data into hex selector
      loadClusterAtIndex(activeIndex);

      refreshSponsorsList();
      window.scrollTo({ top: 0, behavior: "smooth" });
      showToast(`Editing "${editingGroup.name}" (${members.length} territories)`, "success");
    } catch (err) {
      console.error("[AdminApp] editGroup error:", err);
      showToast("Failed to load sponsor group: " + (err.message || err), "error");
    }
  }

  /**
   * Load a specific cluster by index within the editing group
   */
  async function loadClusterAtIndex(index) {
    if (!editingGroup) return;
    const id = editingGroup.ids[index];
    // Ensure full data (with base64 images) is fetched before loading
    let sponsor = SponsorStorage.getById(id);
    if (!sponsor) return;
    if (!sponsor._hasFull) {
      sponsor = await SponsorStorage.fetchFull(id) || sponsor;
    }

    // Set the form's editing ID to this cluster's entry
    sponsorForm.editingSponsorId = id;

    // === Suppress callbacks during batch load to avoid redundant work ===
    const savedFormChange = sponsorForm.onFormChange;
    const savedSelectionChange = hexSelector.onSelectionChange;
    sponsorForm.onFormChange = null;
    hexSelector.onSelectionChange = null;

    try {
      // === STEP 1: Load form data ===
      const currentFormData = sponsorForm.getFormData();
      const patternData = {
        id: id,
        name: currentFormData.name,
        tagline: currentFormData.tagline,
        websiteUrl: currentFormData.websiteUrl,
        logoImage: currentFormData.logoImage || sponsor.logoImage || null,
        patternImage: sponsor.patternImage || null,
        patternAdjustment: sponsor.patternAdjustment || null,
      };
      sponsorForm.loadSponsor(patternData);

      // === STEP 2: Load rewards ===
      if (sponsor.rewards) {
        rewardConfig.loadRewards(sponsor.rewards);
      } else {
        rewardConfig.clear();
      }

      // === STEP 3: Update hex selector and set selection ===
      updateGroupAssignedTiles(id);

      let tt = sponsor.territoryType;
      if (!tt) {
        if (sponsor.cluster?.tileIndices?.length > 0) tt = 'hex';
        else {
          const fallbackMoons = moonManager ? moonManager.getMoonsForSponsor(editingGroup.name) : [];
          const fallbackBbs = billboardManager ? billboardManager.getBillboardsForSponsor(editingGroup.name) : [];
          if (fallbackMoons.length > 0) tt = 'moon';
          else if (fallbackBbs.length > 0) tt = 'billboard';
        }
      }

      // Allow camera transitions to be interrupted
      hexSelector.transitioning = false;

      if (tt === 'moon') {
        hexSelector.clearSelection();
        const moonIndices = moonManager ? moonManager.getMoonsForSponsor(editingGroup.name) : [];
        if (moonIndices.length > 0) {
          hexSelector.setSelectedMoons(moonIndices);
          hexSelector.transitionToMoon(moonIndices);
        }
      } else if (tt === 'billboard') {
        hexSelector.clearSelection();
        const bbIndices = billboardManager ? billboardManager.getBillboardsForSponsor(editingGroup.name) : [];
        if (bbIndices.length > 0) {
          hexSelector.setSelectedBillboards(bbIndices);
          hexSelector.transitionToBillboard(bbIndices);
        }
      } else if (sponsor.cluster?.tileIndices?.length > 0) {
        hexSelector.setSelectedTiles(sponsor.cluster.tileIndices);
        hexSelector.transitionToCluster(sponsor.cluster.tileIndices);
      } else {
        hexSelector.clearSelection();
      }
    } finally {
      // === Restore callbacks ===
      sponsorForm.onFormChange = savedFormChange;
      hexSelector.onSelectionChange = savedSelectionChange;
    }

    // === Fire a single update with correct state ===
    if (savedSelectionChange) {
      savedSelectionChange(hexSelector.getSelectedTiles());
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
    const selectedMoonsCS = hexSelector.getSelectedMoons();
    const selectedBillboardsCS = hexSelector.getSelectedBillboards();
    const rewards = rewardConfig.getRewards();

    // Detect territory type from current selection
    let csType = null;
    if (selectedTiles.length > 0) csType = 'hex';
    else if (selectedMoonsCS.length > 0) csType = 'moon';
    else if (selectedBillboardsCS.length > 0) csType = 'billboard';

    await SponsorStorage.update(id, {
      cluster: { tileIndices: selectedTiles },
      territoryType: csType,
      patternImage: formData.patternImage,
      patternAdjustment: formData.patternAdjustment,
      rewards: rewards,
    });

    // Also persist moon/billboard assignments
    if (moonManager && csType === 'moon') {
      await moonManager.saveMoonsForSponsor(selectedMoonsCS, formData);
    }
    if (billboardManager && csType === 'billboard') {
      await billboardManager.saveBillboardsForSponsor(selectedBillboardsCS, formData);
    }
  }

  /**
   * Switch to a different cluster tab within the editing group
   */
  async function switchCluster(index) {
    if (!editingGroup || index === editingGroup.activeIndex) return;
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }
    busy = true;

    try {
      // Ensure we're on the territory view when switching territories
      if (activeView !== "territories") {
        showTerritoryView();
      }

      // Await save of current state to prevent data loss
      try {
        await saveCurrentClusterState();
      } catch (e) {
        console.warn("[AdminApp] Auto-save failed:", e);
        showToast("Failed to auto-save current territory", "error");
      }

      // Switch after save completes
      editingGroup.activeIndex = index;
      loadClusterAtIndex(index);
      refreshSponsorsList();
    } finally {
      busy = false;
    }
  }

  /**
   * Add a new cluster to a group from the sponsor list (without being in edit mode)
   * Creates a new entry with shared fields, then enters group edit on the new cluster
   */
  async function addClusterToGroup(groupKey) {
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }
    busy = true;

    try {
      const members = getGroupMembers(groupKey);
      if (members.length === 0) {
        showToast("Sponsor group not found", "error");
        return;
      }

      // Copy shared fields from the first member (blank territory — no pattern)
      const first = members[0];
      await SponsorStorage.fetchFull(first.id);
      const firstFull = SponsorStorage.getById(first.id) || first;
      const createData = {
        name: firstFull.name || first.name,
        tagline: firstFull.tagline || first.tagline || "",
        websiteUrl: firstFull.websiteUrl || first.websiteUrl || "",
        logoImage: firstFull.logoImage || first.logoImage || null,
        cluster: { tileIndices: [] },
        rewards: [],
      };
      // Preserve player territory ownership so new entry stays in the same group
      if (first.isPlayerTerritory) {
        createData.isPlayerTerritory = true;
        if (first.ownerUid) createData.ownerUid = first.ownerUid;
        if (first.ownerEmail) createData.ownerEmail = first.ownerEmail;
      }
      const newSponsor = await SponsorStorage.create(createData);

      // Enter group edit mode on the new territory
      refreshSponsorsList();
      editGroup(groupKey, newSponsor.id);

      const displayName = first.ownerEmail || first.name || groupKey;
      showToast(`New territory added to "${displayName}"`, "success");
    } catch (e) {
      showToast(e.message || "Failed to add territory", "error");
    } finally {
      busy = false;
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
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }
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

  async function reviewTerritorySubmission(id, action) {
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }

    // Read admin overrides from the editable fields in the pending review card
    const card = document.querySelector(`.pending-review-card[data-id="${id}"]`);
    const overrides = {};
    if (card) {
      const titleInput = card.querySelector(".review-title");
      const taglineInput = card.querySelector(".review-tagline");
      const urlInput = card.querySelector(".review-url");
      if (titleInput) overrides.title = titleInput.value.trim();
      if (taglineInput) overrides.tagline = taglineInput.value.trim();
      if (urlInput) overrides.websiteUrl = urlInput.value.trim();
    }

    // Read rejection comment from the card
    let rejectionReason = "";
    if (action === "reject") {
      const commentEl = card?.querySelector(".review-comment");
      rejectionReason = commentEl?.value?.trim() || "";
      if (!rejectionReason) {
        rejectionReason = prompt("Rejection reason (optional):") || "";
      }
    }

    busy = true;
    try {
      const res = await fetch(`/api/sponsors/${encodeURIComponent(id)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, rejectionReason, overrides: action === "approve" ? overrides : undefined }),
      });
      const result = await res.json();
      if (result.success) {
        showToast(
          action === "approve"
            ? "Submission approved and broadcast to players"
            : "Submission rejected. Player notified.",
          "success",
        );
        await SponsorStorage.reload();
        refreshSponsorsList();
      } else {
        showToast((result.errors || []).join(". ") || "Review failed", "error");
      }
    } catch (err) {
      showToast("Review failed: " + err.message, "error");
    } finally {
      busy = false;
    }
  }

  async function deleteSponsor(id) {
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }

    const sponsor = SponsorStorage.getById(id);
    if (!sponsor) return;

    const isInEditingGroup = editingGroup && editingGroup.ids.includes(id);
    const label = isInEditingGroup
      ? `Delete territory from "${sponsor.name}"?`
      : `Are you sure you want to delete "${sponsor.name}"?`;
    if (!confirm(label)) return;

    busy = true;
    try {
      await SponsorStorage.delete(id);
      showToast(`Deleted "${sponsor.name}" territory`, "success");

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

      if (isInEditingGroup) {
        // Remove from editing group
        const idx = editingGroup.ids.indexOf(id);
        if (idx !== -1) editingGroup.ids.splice(idx, 1);

        if (editingGroup.ids.length === 0) {
          // No territories left — clear form
          handleClearForm();
        } else {
          // Adjust active index
          if (editingGroup.activeIndex >= editingGroup.ids.length) {
            editingGroup.activeIndex = editingGroup.ids.length - 1;
          }
          loadClusterAtIndex(editingGroup.activeIndex);
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

  /**
   * Delete an entire sponsor group (all territories with the same name)
   */
  async function deleteEntireSponsor(groupKey) {
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }

    const members = getGroupMembers(groupKey);
    if (members.length === 0) return;

    const displayName = members[0].ownerEmail || members[0].name || groupKey;
    const label = members.length === 1
      ? `Are you sure you want to delete "${displayName}"?`
      : `Delete "${displayName}" and all ${members.length} territories?`;
    if (!confirm(label)) return;

    busy = true;
    try {
      for (const s of members) {
        await SponsorStorage.delete(s.id);
      }
      // Clear moon/billboard assignments
      const sponsorName = members[0].name || "";
      if (moonManager) await moonManager.clearMoonsForSponsor(sponsorName);
      if (billboardManager) await billboardManager.clearBillboardsForSponsor(sponsorName);

      showToast(`Deleted "${displayName}"`, "success");

      // Clear form if we were editing this sponsor
      if (editingGroup && editingGroup.groupKey === groupKey) {
        handleClearForm();
      } else {
        const editingId = sponsorForm.getEditingSponsorId();
        if (editingId && members.some((s) => s.id === editingId)) {
          handleClearForm();
        }
      }

      refreshSponsorsList();
      updateAssignedTiles();
      updateAssignedMoons();
      updateAssignedBillboards();
    } finally {
      busy = false;
    }
  }

  /**
   * Toggle the paused state of a sponsor (all territories with the same name)
   */
  async function togglePauseSponsor(groupKey) {
    if (busy) {
      showToast("Please wait for the current operation to finish", "info");
      return;
    }

    const members = getGroupMembers(groupKey);
    if (members.length === 0) return;

    // Toggle: if any member is not paused, pause all; otherwise unpause all
    const shouldPause = members.some((s) => !s.paused);
    const displayName = members[0].ownerEmail || members[0].name || groupKey;

    busy = true;
    try {
      for (const s of members) {
        await SponsorStorage.update(s.id, { paused: shouldPause });
      }
      showToast(`${shouldPause ? "Paused" : "Resumed"} "${displayName}"`, "success");
      refreshSponsorsList();
    } finally {
      busy = false;
    }
  }

  function updateAssignedTiles(excludeSponsorId = null) {
    if (!hexSelector) return;
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
