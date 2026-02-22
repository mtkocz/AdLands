/**
 * One-time script to optimize sponsor textures.
 * Resizes PNGs to max 512px on longest edge, overwriting originals.
 *
 * Run from server/: node optimizeSponsorImages.js
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const TEXTURE_DIR = path.join(__dirname, '..', 'sponsor-textures');
const MAX_DIMENSION = 512;

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

  for (const file of files) {
    const filePath = path.join(TEXTURE_DIR, file);
    const stat = fs.statSync(filePath);
    totalBefore += stat.size;

    const metadata = await sharp(filePath).metadata();
    const needsResize = metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION;

    let pipeline = sharp(filePath);
    if (needsResize) {
      pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    const optimized = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    fs.writeFileSync(filePath, optimized);
    totalAfter += optimized.length;

    const saved = stat.size - optimized.length;
    const pct = stat.size > 0 ? ((saved / stat.size) * 100).toFixed(0) : 0;
    console.log(
      `${file}: ${(stat.size / 1024).toFixed(0)}KB -> ${(optimized.length / 1024).toFixed(0)}KB (${pct}% saved)`
    );
  }

  console.log(
    `\nTotal: ${(totalBefore / 1024 / 1024).toFixed(1)}MB -> ${(totalAfter / 1024 / 1024).toFixed(1)}MB`
  );
  console.log(
    `Saved: ${((totalBefore - totalAfter) / 1024 / 1024).toFixed(1)}MB (${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(0)}%)`
  );
}

optimize().catch(console.error);
