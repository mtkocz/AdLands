/**
 * AdLands - Faction Colors
 * Single source of truth for all faction-coded visuals
 *
 * Dependencies: THREE.js (must be loaded before this file)
 */

// Color utility: derive lighter/darker shades from a base color
function shadeColor(hex, amount) {
  // amount: positive = lighter, negative = darker (e.g., 0.3 = 30% lighter, -0.3 = 30% darker)
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;

  const adjust = (c) =>
    Math.max(
      0,
      Math.min(
        255,
        Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)),
      ),
    );

  return (adjust(r) << 16) | (adjust(g) << 8) | adjust(b);
}

function hexToCSS(hex) {
  return "#" + hex.toString(16).padStart(6, "0").toUpperCase();
}

// Global faction color definitions - single source of truth for all faction-coded visuals
// Define ONE base color per faction; derive all variations from it
const FACTION_COLORS = (() => {
  const bases = {
    rust: 0x8a4444,
    cobalt: 0x395287,
    viridian: 0x627941,
  };

  // Override light variant for specific factions (e.g. more saturated cluster color)
  const lightOverrides = {
    cobalt: shadeColor(0x2845aa, 0.4),
  };

  const result = {};
  for (const [name, base] of Object.entries(bases)) {
    const lightHex = lightOverrides[name] || shadeColor(base, 0.4);
    const darkHex = shadeColor(base, -0.4);
    result[name] = {
      hex: base,
      three: new THREE.Color(base),
      css: hexToCSS(base),
      // Derived shades
      light: lightHex,
      dark: darkHex,
      threeLight: new THREE.Color(lightHex),
      threeDark: new THREE.Color(darkHex),
      cssLight: hexToCSS(lightHex),
      cssDark: hexToCSS(darkHex),
      // Vehicle colors (darker/muted military look)
      vehicle: {
        primary: shadeColor(base, -0.2),
        secondary: shadeColor(base, -0.4),
      },
    };
  }
  return result;
})();

// Inject faction colors as CSS variables so UI elements use the same colors
function injectFactionCSSVariables() {
  const root = document.documentElement;
  for (const [name, colors] of Object.entries(FACTION_COLORS)) {
    root.style.setProperty(`--${name}`, colors.css);
    root.style.setProperty(`--${name}-light`, colors.cssLight);
    root.style.setProperty(`--${name}-dark`, colors.cssDark);
  }
}
injectFactionCSSVariables();
