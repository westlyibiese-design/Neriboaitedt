// Covers the free-tier art engine's watermark on a generated image with
// Neribo's own logo, entirely client-side. This runs in the browser
// because Cloudflare Pages Functions (the Workers runtime) have no
// built-in image-editing capability — no Canvas, no image libraries —
// so this cannot happen in functions/api/images/generate.js.
//
// The upstream engine does not publish the exact pixel position or
// size of its watermark, and it could vary between images or change if
// it updates its service. Rather than trying to precisely trace its
// mark (which could miss and leave part of it visible), this draws a
// solid bar across the same bottom-right corner, generously sized to
// reliably cover it regardless of small variation, with Neribo's own
// logo stamped on top.
//
// If the upstream engine ever moves its watermark somewhere this bar
// doesn't reach, widen BAR_HEIGHT_RATIO/BAR_WIDTH_RATIO below rather
// than trying to pinpoint its new exact position.

const LOGO_SRC = "/neribo-logo.svg";
const BAR_HEIGHT_RATIO = 0.12; // fraction of image height
const BAR_WIDTH_RATIO = 0.48; // fraction of image width, anchored to bottom-right
// Fully opaque, near-black — was rgba(10, 10, 12, 0.92); the slight
// transparency let a bright/white upstream watermark show through
// underneath. Solid color guarantees Neribo's bar is the only thing
// visible in that corner, no matter how bright the mark beneath it is.
const BAR_COLOR = "rgba(8, 8, 10, 1)";
const LOGO_PADDING_RATIO = 0.25; // padding inside the bar, relative to bar height

let cachedLogo: HTMLImageElement | null = null;
function loadLogo(): Promise<HTMLImageElement> {
  if (cachedLogo) return Promise.resolve(cachedLogo);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cachedLogo = img;
      resolve(img);
    };
    img.onerror = () => reject(new Error("Failed to load Neribo logo for watermark"));
    img.src = LOGO_SRC;
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load generated image for watermarking"));
    img.src = src;
  });
}

/**
 * Takes a data: URL of a generated image and returns a new data: URL
 * with Neribo's logo stamped over the bottom-right corner, covering
 * the upstream engine's watermark. Falls back to the original image (never
 * throws to the caller) if anything about the compositing step fails —
 * a visible third-party watermark is a cosmetic issue, not worth
 * failing the whole image generation over.
 */
export async function stampNeriboWatermark(sourceDataUrl: string): Promise<string> {
  try {
    const [sourceImg, logoImg] = await Promise.all([
      loadImage(sourceDataUrl),
      loadLogo(),
    ]);

    const width = sourceImg.naturalWidth || sourceImg.width;
    const height = sourceImg.naturalHeight || sourceImg.height;
    if (!width || !height) return sourceDataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return sourceDataUrl;

    ctx.drawImage(sourceImg, 0, 0, width, height);

    const barHeight = Math.round(height * BAR_HEIGHT_RATIO);
    const barWidth = Math.round(width * BAR_WIDTH_RATIO);
    const barX = width - barWidth;
    const barY = height - barHeight;

    ctx.fillStyle = BAR_COLOR;
    ctx.fillRect(barX, barY, barWidth, barHeight);

    // Fit the logo inside the bar with padding, preserving aspect ratio,
    // right-aligned within the bar.
    const padding = Math.round(barHeight * LOGO_PADDING_RATIO);
    const availableHeight = barHeight - padding * 2;
    const logoAspect = logoImg.naturalWidth / logoImg.naturalHeight;
    let logoHeight = availableHeight;
    let logoWidth = logoHeight * logoAspect;
    const maxLogoWidth = barWidth - padding * 2;
    if (logoWidth > maxLogoWidth) {
      logoWidth = maxLogoWidth;
      logoHeight = logoWidth / logoAspect;
    }
    const logoX = barX + barWidth - padding - logoWidth;
    const logoY = barY + (barHeight - logoHeight) / 2;

    ctx.drawImage(logoImg, logoX, logoY, logoWidth, logoHeight);

    // JPEG keeps output size small; the source images from the free-tier
    // art engine are photographic content anyway, not sharp-edged graphics that
    // would suffer visibly from JPEG compression.
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    // Any failure (logo missing, canvas unsupported, tainted canvas,
    // etc.) — just show the original image rather than losing the
    // generation the user already waited for.
    return sourceDataUrl;
  }
}
