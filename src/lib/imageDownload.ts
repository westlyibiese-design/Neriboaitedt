// Downloads an AI-generated image (src/components/ChatView.tsx's
// msg.imageUrl — a Supabase Storage signed URL, see
// functions/_shared/supabaseStorage.js) to the user's device.
//
// A plain `<a href={url} download>` is NOT reliable here: the `download`
// attribute is only honored by browsers for same-origin URLs (or ones
// the server explicitly marks downloadable via Content-Disposition) —
// for a cross-origin Supabase URL, most browsers just navigate to/open
// the image instead of saving it. So this fetches the actual bytes as a
// Blob first, then triggers the save from a same-origin (blob:) object
// URL, which every modern browser honors correctly regardless of where
// the original image lived.
//
// If that fetch is blocked for any reason (offline, a restrictive
// in-app WebView, a network hiccup), this falls back to opening the
// image in a new tab so the user can still long-press/right-click
// "Save Image" themselves — never silently doing nothing, and never
// claiming a download happened when it didn't (see
// src/components/ImageDownloadButton.tsx for how each outcome is
// surfaced to the user).

export type ImageDownloadOutcome =
  | { status: "downloaded" }
  | { status: "opened-fallback" }
  | { status: "failed"; reason: string };

const EXTENSION_FROM_URL = /\.(png|jpe?g|webp|gif)(?:[?#]|$)/i;

function inferExtension(url: string): string {
  const match = EXTENSION_FROM_URL.exec(url);
  if (!match) return "png";
  const ext = match[1].toLowerCase();
  return ext === "jpeg" ? "jpg" : ext;
}

function buildFilename(url: string): string {
  const ext = inferExtension(url);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `neribo-ai-image-${stamp}.${ext}`;
}

export async function downloadGeneratedImage(url: string): Promise<ImageDownloadOutcome> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Fetch failed (${res.status})`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = buildFilename(url);
    // Must be in the DOM for Firefox/some WebViews to honor the click.
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Give the browser a moment to pick up the object URL before it's
    // revoked — freeing it immediately can cancel an in-progress save
    // in some browsers.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);

    return { status: "downloaded" };
  } catch (err) {
    console.error("[Neribo:imageDownload] Blob download failed, falling back:", err);
    try {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) {
        throw new Error("The browser blocked opening the image (popup blocked).");
      }
      return { status: "opened-fallback" };
    } catch (fallbackErr) {
      return {
        status: "failed",
        reason: fallbackErr instanceof Error ? fallbackErr.message : "Download was blocked.",
      };
    }
  }
}
