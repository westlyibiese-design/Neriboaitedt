import React, { useState } from "react";
import { Download, Loader2, Check } from "lucide-react";
import { downloadGeneratedImage } from "../lib/imageDownload";
import { useToast } from "./Toast";

type ButtonState = "idle" | "loading" | "success";

/**
 * A small circular control overlaid on the bottom-right corner of a
 * generated image (see src/components/ChatView.tsx) — deliberately not
 * just the raw image URL exposed as a link. Handles its own loading/
 * success/error presentation; failures and the "opened in a new tab"
 * fallback both surface through the existing Toast system
 * (src/components/Toast.tsx) rather than pretending the download always
 * succeeds.
 */
export const ImageDownloadButton: React.FC<{ imageUrl: string }> = ({ imageUrl }) => {
  const [state, setState] = useState<ButtonState>("idle");
  const { showToast } = useToast();

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state === "loading") return;
    setState("loading");
    const outcome = await downloadGeneratedImage(imageUrl);
    if (outcome.status === "downloaded") {
      setState("success");
      setTimeout(() => setState("idle"), 1800);
    } else if (outcome.status === "opened-fallback") {
      setState("idle");
      showToast("Opened the image in a new tab — save it from there.", "info");
    } else {
      setState("idle");
      showToast("Couldn't download this image. Please try again.", "error");
    }
  };

  return (
    <button
      type="button"
      onClick={(e) => void handleDownload(e)}
      disabled={state === "loading"}
      aria-label="Download image"
      title="Download image"
      className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-white shadow-lg hover:bg-black/75 active:scale-95 transition-all disabled:opacity-70"
    >
      {state === "loading" ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : state === "success" ? (
        <Check className="h-4 w-4 text-emerald-400" />
      ) : (
        <Download className="h-4 w-4" />
      )}
    </button>
  );
};
