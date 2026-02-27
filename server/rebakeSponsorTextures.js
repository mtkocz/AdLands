/**
 * Re-bake all sponsor textures from original source images in sponsors/.
 * Reads the high-res originals, applies the pixel art filter consistently,
 * and writes to sponsor-textures/{sponsorId}.png.
 *
 * Also re-encodes the originals as base64 patternImage in sponsors.json
 * so future extractions use the correct source.
 *
 * Run from project root: node server/rebakeSponsorTextures.js
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { applyPixelArtFilter } = require("./pixelArtFilter");

const PROJECT_ROOT = path.join(__dirname, "..");
const SPONSOR_DIR = path.join(PROJECT_ROOT, "sponsors");
const TEX_DIR = path.join(PROJECT_ROOT, "sponsor-textures");
const SPONSORS_JSON = path.join(PROJECT_ROOT, "data", "sponsors.json");

// Special name mappings where filename doesn't match sponsor name
const NAME_ALIASES = {
  bepsi: "bebsi",
  wackdonalds: "wackdolands",
  infancinema: "infancinemapattern",
};

async function rebake() {
  const data = JSON.parse(fs.readFileSync(SPONSORS_JSON, "utf8"));
  const sponsors = data.sponsors;

  // Get all source files (non-logo pattern images)
  const sourceFiles = fs.readdirSync(SPONSOR_DIR).filter((f) =>
    /\.(png|jpg|jpeg)$/i.test(f)
  );

  // Build name → source file map
  const sourceMap = {};
  for (const f of sourceFiles) {
    if (f.includes("_logo") || f.includes("logo")) continue;
    const base = f.replace(/\.(png|jpg|jpeg)$/i, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    sourceMap[base.replace(/_/g, "")] = f;
    sourceMap[base] = f; // keep underscored version too
  }

  // Also build logo source map
  const logoSourceMap = {};
  for (const f of sourceFiles) {
    if (!f.includes("_logo") && !f.includes("logo")) continue;
    const base = f
      .replace(/\.(png|jpg|jpeg)$/i, "")
      .replace(/_?logo/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    logoSourceMap[base] = f;
  }

  // Deduplicate sponsors by name (many share the same texture)
  const uniqueByName = new Map();
  for (const s of sponsors) {
    const name = s.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!uniqueByName.has(name)) {
      uniqueByName.set(name, []);
    }
    uniqueByName.get(name).push(s);
  }

  console.log(`Found ${uniqueByName.size} unique sponsor brands, ${sponsors.length} total entries`);
  console.log(`Source files: ${Object.keys(sourceMap).join(", ")}`);
  console.log("");

  let rebaked = 0;
  let skipped = 0;
  let logoUpdated = 0;
  let noSource = [];

  for (const [name, sponsorList] of uniqueByName) {
    // Find matching source file
    let srcFileName = sourceMap[name];

    // Check aliases
    if (!srcFileName && NAME_ALIASES[name]) {
      srcFileName = sourceMap[NAME_ALIASES[name]];
    }

    if (!srcFileName) {
      noSource.push(name);
      console.log(`  SKIP ${name} — no source image found`);
      skipped += sponsorList.length;
      continue;
    }

    const srcPath = path.join(SPONSOR_DIR, srcFileName);
    const raw = fs.readFileSync(srcPath);
    const rawSize = raw.length;

    const srcMeta = await sharp(raw).metadata();

    // Encode original as base64 for sponsors.json
    const ext = path.extname(srcFileName).slice(1).toLowerCase();
    const mimeType = ext === "jpg" || ext === "jpeg" ? "jpeg" : "png";
    const base64 = `data:image/${mimeType};base64,${raw.toString("base64")}`;

    // Write baked texture for each sponsor entry with this name
    for (const s of sponsorList) {
      // Update base64 in sponsors.json
      s.patternImage = base64;

      // Apply pixel art filter with adaptive resolution based on territory size
      const tileCount = s.cluster?.tileIndices?.length || 20;
      const baked = await applyPixelArtFilter(raw, tileCount);
      const meta = await sharp(baked).metadata();
      console.log(
        `  ${name} (${s.id}): ${srcFileName} (${srcMeta.width}x${srcMeta.height}, ${(rawSize / 1024).toFixed(1)}KB) → ${meta.width}x${meta.height} [${tileCount} tiles] (${(baked.length / 1024).toFixed(1)}KB)`
      );

      // Write baked PNG to sponsor-textures
      const outPath = path.join(TEX_DIR, `${s.id}.png`);
      fs.writeFileSync(outPath, baked);
      rebaked++;
    }

    // Also handle logo
    const logoSrc = logoSourceMap[name];
    if (logoSrc) {
      const logoPath = path.join(SPONSOR_DIR, logoSrc);
      const logoRaw = fs.readFileSync(logoPath);
      const logoExt = path.extname(logoSrc).slice(1).toLowerCase();
      const logoMimeType = logoExt === "jpg" || logoExt === "jpeg" ? "jpeg" : "png";
      const logoBase64 = `data:image/${logoMimeType};base64,${logoRaw.toString("base64")}`;

      // Resize logo to 128px
      const logoOptimized = await sharp(logoRaw)
        .resize(128, 128, { fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();

      for (const s of sponsorList) {
        s.logoImage = logoBase64;
        const logoOutPath = path.join(TEX_DIR, `${s.id}_logo.png`);
        fs.writeFileSync(logoOutPath, logoOptimized);
      }
      logoUpdated++;
    }
  }

  // Write updated sponsors.json
  fs.writeFileSync(SPONSORS_JSON, JSON.stringify(data, null, 2));

  console.log(`\nDone: ${rebaked} textures re-baked, ${logoUpdated} logos updated, ${skipped} skipped`);
  if (noSource.length > 0) {
    console.log(`No source image for: ${noSource.join(", ")}`);
  }

  // Verify consistency: check all baked textures have the same pixel dimensions
  console.log("\n--- Verification ---");
  const sharpV = require("sharp");
  const texFiles = fs.readdirSync(TEX_DIR).filter((f) => f.endsWith(".png") && !f.includes("_logo"));
  const dims = new Map();
  for (const f of texFiles) {
    const meta = await sharpV(path.join(TEX_DIR, f)).metadata();
    const key = `${meta.width}x${meta.height}`;
    if (!dims.has(key)) dims.set(key, []);
    dims.get(key).push(f);
  }
  for (const [dim, files] of dims) {
    console.log(`  ${dim}: ${files.length} files`);
    if (files.length <= 5) {
      for (const f of files) console.log(`    - ${f}`);
    }
  }
}

rebake().catch(console.error);
