/**
 * One-time script to optimize sponsor textures.
 * Applies the pixel art filter (downscale to 128px, 8-color palette, Bayer dithering)
 * and saves at the reduced resolution. Skips logo files (_logo).
 *
 * Run from server/: node optimizeSponsorImages.js
 */
const fs = require('fs');
const path = require('path');
const { applyPixelArtFilter } = require('./pixelArtFilter');

const TEXTURE_DIR = path.join(__dirname, '..', 'sponsor-textures');

async function optimize() {
  if (!fs.existsSync(TEXTURE_DIR)) {
    console.log('No sponsor-textures/ directory found.');
    return;
  }

  const files = fs.readdirSync(TEXTURE_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
  if (files.length === 0) {
    console.log('No image files found.');
    return;
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let patternCount = 0;
  let logoCount = 0;

  for (const file of files) {
    const filePath = path.join(TEXTURE_DIR, file);
    const stat = fs.statSync(filePath);
    totalBefore += stat.size;

    const isLogo = file.includes('_logo');
    const inputBuffer = fs.readFileSync(filePath);
    let optimized;

    if (isLogo) {
      // Logos: just compress, don't apply pixel art filter
      const sharp = require('sharp');
      optimized = await sharp(inputBuffer)
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .png({ compressionLevel: 9 })
        .toBuffer();
      logoCount++;
    } else {
      // Pattern images: apply full pixel art filter (128px, 8 colors, dithering)
      optimized = await applyPixelArtFilter(inputBuffer);
      patternCount++;
    }

    // Write as PNG regardless of original format
    const pngPath = filePath.replace(/\.(jpg|jpeg)$/i, '.png');
    fs.writeFileSync(pngPath, optimized);
    // Remove original if it was a JPEG
    if (pngPath !== filePath) fs.unlinkSync(filePath);

    totalAfter += optimized.length;

    const saved = stat.size - optimized.length;
    const pct = stat.size > 0 ? ((saved / stat.size) * 100).toFixed(0) : 0;
    console.log(
      `${file}: ${(stat.size / 1024).toFixed(1)}KB -> ${(optimized.length / 1024).toFixed(1)}KB (${pct}% saved)${isLogo ? ' [logo]' : ''}`
    );
  }

  console.log(
    `\nPatterns: ${patternCount}, Logos: ${logoCount}`
  );
  console.log(
    `Total: ${(totalBefore / 1024 / 1024).toFixed(1)}MB -> ${(totalAfter / 1024 / 1024).toFixed(1)}MB`
  );
  console.log(
    `Saved: ${((totalBefore - totalAfter) / 1024 / 1024).toFixed(1)}MB (${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(0)}%)`
  );
}

optimize().catch(console.error);
