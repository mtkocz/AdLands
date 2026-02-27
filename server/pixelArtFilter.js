/**
 * Server-side pixel art filter — mirrors the client-side _applyPixelArtFilter().
 * Downscales to 128px short side, extracts 8-color palette, applies Bayer dithering.
 * Returns a sharp-compatible buffer at the reduced resolution.
 *
 * Requires: sharp
 */
const sharp = require("sharp");

const TARGET_SHORT_SIDE = 64;
const MAX_COLORS = 8;
const DITHER_INTENSITY = 32;

const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Apply pixel art filter to an image buffer.
 * @param {Buffer} inputBuffer - PNG/JPEG image buffer
 * @returns {Promise<Buffer>} - Processed PNG buffer at reduced resolution
 */
async function applyPixelArtFilter(inputBuffer) {
  const metadata = await sharp(inputBuffer).metadata();
  const srcWidth = metadata.width || 256;
  const srcHeight = metadata.height || 256;
  const aspect = srcWidth / srcHeight;

  // Calculate target dimensions (short side = 128)
  let targetWidth, targetHeight;
  if (srcWidth <= srcHeight) {
    targetWidth = TARGET_SHORT_SIDE;
    targetHeight = Math.round(TARGET_SHORT_SIDE / aspect);
  } else {
    targetHeight = TARGET_SHORT_SIDE;
    targetWidth = Math.round(TARGET_SHORT_SIDE * aspect);
  }

  // Step 1: Downscale with nearest-neighbor (no antialiasing)
  const { data, info } = await sharp(inputBuffer)
    .resize(targetWidth, targetHeight, { kernel: "nearest" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const pixels = new Uint8Array(data);

  // Step 2: Extract palette from most frequent colors
  const colorBuckets = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const qr = Math.floor(pixels[i] / 32) * 32;
    const qg = Math.floor(pixels[i + 1] / 32) * 32;
    const qb = Math.floor(pixels[i + 2] / 32) * 32;
    const key = `${qr},${qg},${qb}`;

    const bucket = colorBuckets.get(key) || { count: 0, sumR: 0, sumG: 0, sumB: 0 };
    bucket.count++;
    bucket.sumR += pixels[i];
    bucket.sumG += pixels[i + 1];
    bucket.sumB += pixels[i + 2];
    colorBuckets.set(key, bucket);
  }

  const palette = Array.from(colorBuckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_COLORS)
    .map((b) => [
      Math.round(b.sumR / b.count),
      Math.round(b.sumG / b.count),
      Math.round(b.sumB / b.count),
    ]);

  if (palette.length === 0) palette.push([128, 128, 128]);

  // Step 3: Apply ordered dithering and map to palette
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const threshold = (BAYER_4X4[y % 4][x % 4] / 16.0 - 0.5) * DITHER_INTENSITY;

      const r = Math.max(0, Math.min(255, pixels[i] + threshold));
      const g = Math.max(0, Math.min(255, pixels[i + 1] + threshold));
      const b = Math.max(0, Math.min(255, pixels[i + 2] + threshold));

      // Find closest palette color (perceptual weighting)
      let minDist = Infinity;
      let closest = palette[0];
      for (const color of palette) {
        const dr = r - color[0];
        const dg = g - color[1];
        const db = b - color[2];
        const dist = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
        if (dist < minDist) {
          minDist = dist;
          closest = color;
        }
      }

      pixels[i] = closest[0];
      pixels[i + 1] = closest[1];
      pixels[i + 2] = closest[2];
      // Alpha stays unchanged
    }
  }

  // Step 4: Save at reduced resolution (no upscale — NearestFilter handles that client-side)
  return sharp(Buffer.from(pixels.buffer), {
    raw: { width: w, height: h, channels: 4 },
  })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}

module.exports = { applyPixelArtFilter };
