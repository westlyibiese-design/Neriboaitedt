import React, { useEffect, useRef, useState } from "react";
import { NeriboLogoAnimated } from "./NeriboLogoAnimated";

interface ImageGenerationProgressProps {
  /**
   * True for the entire real span a generateImage() request (see
   * src/lib/neriboApi.ts) is in flight — set by src/App.tsx right
   * before calling it and cleared in that call's `finally`. This
   * component's progress is driven entirely by how long `active` has
   * been true, never by a fixed countdown that ignores the real
   * request. See the header note on the free/Pro art engines below for
   * why there's no real percentage to read from either
   * provider.
   */
  active: boolean;
}

// Neither image provider Neribo talks to (the free-tier engine or the
// Pro-tier engine — see
// functions/api/images/generate.js) returns incremental progress: both
// are a single request/response with one JSON body at the end (see
// src/lib/neriboApi.ts's generateImage, which has no onChunk — there's
// nothing to stream). So there is no real percentage to display, and
// this component does not pretend there is one. What IS real here is
// the request's own lifecycle (`active`): the estimate below starts the
// instant the request actually starts, keeps advancing for exactly as
// long as it's actually still in flight, and is capped so it can never
// visually claim "done" before the actual image comes back — the parent
// unmounts this component only once the real dataUrl has arrived,
// been watermarked, and been persisted (see src/App.tsx's image
// branches), at which point the real image renders in its place.
//
// The curve: fast at first, slowing to a crawl as it nears the cap —
// approximating how these generations actually feel (a few seconds to
// "mostly there", then a longer tail) without ever claiming completion.
const PROGRESS_CAP = 97;
const TAU_SECONDS = 7; // time constant — ~63% of the way to the cap by this point

function estimateProgress(elapsedMs: number): number {
  const t = elapsedMs / 1000;
  return PROGRESS_CAP * (1 - Math.exp(-t / TAU_SECONDS));
}

export const ImageGenerationProgress: React.FC<ImageGenerationProgressProps> = ({ active }) => {
  const [progress, setProgress] = useState(0);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      setProgress(0);
      return;
    }

    startRef.current = performance.now();
    const tick = () => {
      if (startRef.current == null) return;
      const elapsed = performance.now() - startRef.current;
      setProgress(estimateProgress(elapsed));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [active]);

  if (!active) return null;

  const pct = Math.min(PROGRESS_CAP, Math.round(progress));

  return (
    <div
      className="relative w-full max-w-sm aspect-square rounded-2xl border border-[var(--border)] bg-[var(--bg-0)] overflow-hidden"
      role="status"
      aria-live="polite"
      aria-label={`Generating image, ${pct}% so far`}
    >
      {/* Dotted grid background — purely decorative, matches the
          reference activity screen's visual language. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(59,130,246,0.35) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      />

      {/* Center: brand loading animation — replaces the old static
          glyph so the empty box doesn't read as frozen while the
          image is being generated. Same mark used on app boot
          (src/App.tsx's loading gates); here it plays its one-shot
          reveal then loops its "still working" shine for as long as
          `active` stays true. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
        <NeriboLogoAnimated size={64} label="Generating image" />
        <span className="text-xs text-[var(--muted-foreground)]">Generating image…</span>
      </div>

      {/* Live percentage badge — bottom-right, matches the reference. */}
      <div className="absolute bottom-3 right-3 rounded-full bg-[var(--elevated)]/90 border border-[var(--border)] px-3 py-1 backdrop-blur-sm">
        <span className="text-sm font-bold text-blue-400 tabular-nums">{pct}%</span>
      </div>
    </div>
  );
};