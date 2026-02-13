/**
 * AdLands - Hex Tier System
 * Manages hex tier assignments, pricing, and bulk discounts for monetization
 */

const HexTierSystem = {
  // ═══════════════════════════════════════════════════════
  // TIER DEFINITIONS
  // ═══════════════════════════════════════════════════════

  TIERS: {
    RESTRICTED: {
      id: "RESTRICTED",
      name: "Restricted",
      label: "RESTRICTED ZONE",
      color: 0x111111, // Very dark gray
      cssColor: "#111111",
      stroke: "#222222",
      textColor: "#444444",
      icon: "⊘",
      price: null, // Not rentable
      description:
        "Neutral portal zones & polar caps. Not available for sponsorship.",
    },
    FRONTIER: {
      id: "FRONTIER",
      name: "Frontier",
      label: "FRONTIER",
      color: 0x2a3b3a, // Bright desaturated teal
      cssColor: "#1a3533",
      stroke: "#14b8a6",
      textColor: "#5eead4",
      icon: "◇",
      price: 3, // $/hex/month
      description:
        "Polar rim & low-traffic edges. Budget-friendly entry point for sponsors.",
    },
    PRIME: {
      id: "PRIME",
      name: "Prime",
      label: "PRIME",
      color: 0x302a40, // Bright desaturated purple
      cssColor: "#252038",
      stroke: "#7c3aed",
      textColor: "#a78bfa",
      icon: "◆",
      price: 7, // $/hex/month
      description:
        "Mid-latitude standard zones. Solid traffic, good visibility.",
    },
    HOTZONE: {
      id: "HOTZONE",
      name: "Hotzone",
      label: "HOTZONE",
      color: 0x3d3a2a, // Bright desaturated amber
      cssColor: "#352e18",
      stroke: "#fbbf24",
      textColor: "#fcd34d",
      icon: "◈",
      price: 15, // $/hex/month
      description:
        "Near portals, faction borders & equatorial chokepoints. Maximum exposure.",
    },
  },

  // Order for UI display (premium first)
  TIER_ORDER: ["HOTZONE", "PRIME", "FRONTIER", "RESTRICTED"],

  // Rentable tiers only
  RENTABLE_TIERS: ["FRONTIER", "PRIME", "HOTZONE"],

  // ═══════════════════════════════════════════════════════
  // TIER ASSIGNMENT LOGIC
  // ═══════════════════════════════════════════════════════

  /**
   * Determine the tier for a tile based on its position and properties
   * @param {Object} tile - Hexasphere tile object
   * @param {number} tileIndex - Tile index
   * @param {number} sphereRadius - Radius of the hexasphere
   * @param {Set} portalCenters - Set of portal center tile indices
   * @param {Map} adjacencyMap - Tile adjacency map
   * @returns {string} Tier ID
   */
  getTierForTile(tile, tileIndex, sphereRadius, portalCenters, adjacencyMap) {
    const y = parseFloat(tile.centerPoint.y);
    const phi = Math.acos(y / sphereRadius); // Angle from north pole (0 = north, PI = south)
    const distFromEquator = Math.abs(phi - Math.PI / 2) / (Math.PI / 2); // 0 = equator, 1 = pole

    // Pentagon tiles are portal centers
    const isPortalCenter = tile.boundary.length === 5;

    // Check if within polar exclusion zone (10° from poles)
    const polarThreshold = (10 * Math.PI) / 180;
    const isNearPole = phi < polarThreshold || phi > Math.PI - polarThreshold;

    // Check if adjacent to a portal center
    const isPortalAdjacent =
      !isPortalCenter &&
      Array.from(portalCenters).some((portalIdx) => {
        const neighbors = adjacencyMap.get(portalIdx) || [];
        return neighbors.includes(tileIndex);
      });

    // RESTRICTED: Portals, portal-adjacent, and polar zones
    if (isPortalCenter || isPortalAdjacent || isNearPole) {
      return "RESTRICTED";
    }

    // FRONTIER: Far from equator (72-92% toward poles)
    if (distFromEquator > 0.72) {
      return "FRONTIER";
    }

    // Check if near (but not adjacent to) a portal - 4 rings out
    const isNearPortal = Array.from(portalCenters).some((portalIdx) => {
      const ring1 = adjacencyMap.get(portalIdx) || [];
      for (const r1 of ring1) {
        const ring2 = adjacencyMap.get(r1) || [];
        if (ring2.includes(tileIndex)) return true;
        for (const r2 of ring2) {
          const ring3 = adjacencyMap.get(r2) || [];
          if (ring3.includes(tileIndex)) return true;
          for (const r3 of ring3) {
            const ring4 = adjacencyMap.get(r3) || [];
            if (ring4.includes(tileIndex)) return true;
          }
        }
      }
      return false;
    });

    // HOTZONE: Near equator (within 15%) or near portals
    if (distFromEquator < 0.15 || isNearPortal) {
      return "HOTZONE";
    }

    // PRIME: Everything else (mid-latitudes)
    return "PRIME";
  },

  /**
   * Build a complete tier map for all tiles
   * @param {Array} tiles - Array of hexasphere tiles
   * @param {number} sphereRadius - Radius of the hexasphere
   * @param {Map} adjacencyMap - Tile adjacency map
   * @returns {Map} tileIndex → tier ID
   */
  buildTierMap(tiles, sphereRadius, adjacencyMap) {
    const tierMap = new Map();

    // First pass: identify portal centers
    const portalCenters = new Set();
    tiles.forEach((tile, index) => {
      if (tile.boundary.length === 5) {
        portalCenters.add(index);
      }
    });

    // Second pass: assign tiers
    tiles.forEach((tile, index) => {
      const tier = this.getTierForTile(
        tile,
        index,
        sphereRadius,
        portalCenters,
        adjacencyMap,
      );
      tierMap.set(index, tier);
    });

    return tierMap;
  },

  /**
   * Get tier statistics (count per tier)
   * @param {Map} tierMap - Tile index to tier ID map
   * @returns {Object} { HOTZONE: count, PRIME: count, ... }
   */
  getTierStats(tierMap) {
    const stats = {};
    this.TIER_ORDER.forEach((tierId) => (stats[tierId] = 0));

    for (const tier of tierMap.values()) {
      stats[tier] = (stats[tier] || 0) + 1;
    }

    return stats;
  },

  // ═══════════════════════════════════════════════════════
  // PRICING & DISCOUNTS
  // ═══════════════════════════════════════════════════════

  /**
   * Calculate cluster discount percentage
   * Uses logarithmic curve: discount = 8 * ln(count), capped at 30%
   * @param {number} hexCount - Number of hexes in cluster
   * @returns {number} Discount percentage (0-30)
   */
  getClusterDiscount(hexCount) {
    if (hexCount <= 1) return 0;
    const raw = 8 * Math.log(hexCount);
    return Math.min(30, Math.round(raw * 10) / 10);
  },

  /**
   * Get human-readable discount label
   * @param {number} discount - Discount percentage
   * @returns {string|null} Label or null if no discount
   */
  getDiscountLabel(discount) {
    if (discount >= 25) return "MEGA CLUSTER BONUS";
    if (discount >= 18) return "CLUSTER BONUS";
    if (discount >= 10) return "MULTI-HEX BONUS";
    if (discount > 0) return "BUNDLE SAVINGS";
    return null;
  },

  /**
   * Calculate pricing breakdown for a selection of tiles
   * @param {Array<number>} tileIndices - Selected tile indices
   * @param {Map} tierMap - Tile index to tier ID map
   * @returns {Object} Pricing breakdown
   */
  calculatePricing(tileIndices, tierMap) {
    // Count tiles by tier
    const byTier = {};
    this.RENTABLE_TIERS.forEach((t) => (byTier[t] = 0));

    let totalHexes = 0;
    let subtotal = 0;

    for (const idx of tileIndices) {
      const tier = tierMap.get(idx);
      if (!tier || tier === "RESTRICTED") continue;

      byTier[tier] = (byTier[tier] || 0) + 1;
      totalHexes++;
      subtotal += this.TIERS[tier].price;
    }

    // Remove tiers with 0 count
    Object.keys(byTier).forEach((k) => {
      if (byTier[k] === 0) delete byTier[k];
    });

    const discount = this.getClusterDiscount(totalHexes);
    const discountAmount = subtotal * (discount / 100);
    const total = subtotal - discountAmount;
    const label = this.getDiscountLabel(discount);

    return {
      byTier, // { HOTZONE: 3, PRIME: 4, ... }
      totalHexes,
      subtotal, // Before discount
      discount, // Percentage
      discountAmount, // Dollar amount saved
      total, // After discount
      label, // Discount label
    };
  },

  /**
   * Calculate maximum potential revenue at 100% fill
   * @param {Map} tierMap - Tile index to tier ID map
   * @returns {Object} Revenue breakdown
   */
  calculateMaxRevenue(tierMap) {
    const stats = this.getTierStats(tierMap);
    let total = 0;
    const byTier = {};

    this.RENTABLE_TIERS.forEach((tierId) => {
      const tier = this.TIERS[tierId];
      const count = stats[tierId] || 0;
      const revenue = tier.price * count;
      byTier[tierId] = { count, price: tier.price, revenue };
      total += revenue;
    });

    return { byTier, total };
  },

  // ═══════════════════════════════════════════════════════
  // DISCOUNT TABLE (for UI display)
  // ═══════════════════════════════════════════════════════

  /**
   * Get discount examples for display
   * @returns {Array} Array of { hexCount, discount }
   */
  getDiscountExamples() {
    const examples = [1, 3, 7, 13, 19, 37, 61];
    return examples.map((n) => ({
      hexCount: n,
      discount: this.getClusterDiscount(n),
    }));
  },

  // ═══════════════════════════════════════════════════════
  // MOON PRICING
  // ═══════════════════════════════════════════════════════

  /** Fixed monthly price per moon index (ordered by moonConfigs) */
  MOON_PRICES: [250, 60, 120], // Moon 1 (Large), Moon 2 (Small), Moon 3 (Medium)

  MOON_LABELS: ["Moon 1 (Large)", "Moon 2 (Small)", "Moon 3 (Medium)"],

  /**
   * Calculate pricing for selected moons
   * @param {number[]} moonIndices
   * @returns {{ moons: Array<{index, label, price}>, moonTotal: number }}
   */
  calculateMoonPricing(moonIndices) {
    if (!moonIndices || moonIndices.length === 0) {
      return { moons: [], moonTotal: 0 };
    }
    let moonTotal = 0;
    const moons = moonIndices.map((i) => {
      const price = this.MOON_PRICES[i] || 0;
      moonTotal += price;
      return { index: i, label: this.MOON_LABELS[i] || `Moon ${i + 1}`, price };
    });
    return { moons, moonTotal };
  },

  // ═══════════════════════════════════════════════════════
  // BILLBOARD PRICING
  // ═══════════════════════════════════════════════════════

  /** Billboard orbit tier definitions: 12 low (0-11), 6 high (12-17) */
  BILLBOARD_ORBIT_TIERS: {
    LOW:  { label: "Low Orbit",  count: 12, price: 25  },
    HIGH: { label: "High Orbit", count: 6,  price: 100 },
  },

  /** Map billboard index to its orbit tier */
  getBillboardOrbitTier(billboardIndex) {
    if (billboardIndex < 12) return "LOW";
    return "HIGH";
  },

  /** Get billboard label for display */
  getBillboardLabel(billboardIndex) {
    const tier = this.getBillboardOrbitTier(billboardIndex);
    const tierDef = this.BILLBOARD_ORBIT_TIERS[tier];
    const offset = tier === "LOW" ? 0 : 12;
    const localIndex = billboardIndex - offset + 1;
    return `${tierDef.label} #${localIndex}`;
  },

  /** Get billboard price by index */
  getBillboardPrice(billboardIndex) {
    const tier = this.getBillboardOrbitTier(billboardIndex);
    return this.BILLBOARD_ORBIT_TIERS[tier].price;
  },

  /**
   * Calculate pricing for selected billboards
   * @param {number[]} billboardIndices
   * @returns {{ billboards: Array<{index, label, price, tier}>, billboardTotal: number }}
   */
  calculateBillboardPricing(billboardIndices) {
    if (!billboardIndices || billboardIndices.length === 0) {
      return { billboards: [], billboardTotal: 0 };
    }
    let billboardTotal = 0;
    const billboards = billboardIndices.map((i) => {
      const tier = this.getBillboardOrbitTier(i);
      const price = this.getBillboardPrice(i);
      billboardTotal += price;
      return { index: i, label: this.getBillboardLabel(i), price, tier };
    });
    return { billboards, billboardTotal };
  },
};

// Make available globally for other modules
if (typeof window !== "undefined") {
  window.HexTierSystem = HexTierSystem;
}
