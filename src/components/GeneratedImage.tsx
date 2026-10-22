import React, { useState } from "react";
import { ImageOff } from "lucide-react";

interface GeneratedImageProps {
  src: string;
  alt: string;
  className?: string;
}

/**
 * Renders an AI-generated image (ChatMessage.imageUrl — a persistent
 * Supabase Storage signed URL, see src/types.ts and
 * functions/api/images/store.js) inside ChatView.
 *
 * Adds one thing over a bare <img>: a clean, user-facing message if the
 * URL ever genuinely fails to load, instead of the browser's
 * broken-image icon or any raw technical detail. The real error never
 * reaches the user; a caller wiring this into the existing Supervisor
 * diagnostics pipeline can still hook the standard `error` event this
 * component listens for (browsers don't expose more detail than that
 * for <img> load failures to JS).
 *
 * IMPORTANT — do not reintroduce a "hide the <img> until loaded" state
 * (e.g. a `display:none`/`hidden` class swap) combined with
 * `loading="lazy"`: an element with no rendered box (display:none)
 * never satisfies the intersection check lazy-loading waits for, so the
 * image request is never even issued and `onLoad`/`onError` never fire
 * — the image silently stays blank forever. That combination was
 * shipped once and caused exactly that regression (chat worked,
 * generated images never appeared). If a loading placeholder is wanted
 * again, it must be an overlay (e.g. absolutely positioned) on top of
 * an <img> that stays in normal, visible flow the whole time — never a
 * `display:none` toggle paired with `loading="lazy"`.
 */
export const GeneratedImage: React.FC<GeneratedImageProps> = ({ src, alt, className }) => {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        className={`flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--muted)]/60 px-4 py-6 text-sm text-[var(--muted-foreground)] ${
          className || ""
        }`}
      >
        <ImageOff className="h-4 w-4 shrink-0" />
        <span>This image couldn't be loaded.</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      decoding="async"
      onError={() => setFailed(true)}
      className={`${className || ""} block`}
    />
  );
};
