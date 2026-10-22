import React from "react";

interface NeriboLogoAnimatedProps {
  /** Rendered pixel height of the icon; the wordmark scales with it. Default 96. */
  size?: number;
  className?: string;
  /** Accessible label for the loading indicator. Ignored when `decorative` is true. */
  label?: string;
  /**
   * Show the "Neribo" wordmark below the mark. Default true (unchanged
   * behavior for every existing full-screen call site). Set false to use
   * just the animated ring+triangles mark inline — e.g. next to text
   * that already says what's loading, where a second "Neribo" label
   * would be redundant.
   */
  wordmark?: boolean;
  /**
   * Mark this instance as purely decorative: drops the `role="status"` /
   * `aria-label` so it doesn't announce on its own. Default false
   * (unchanged behavior). Set true when this icon sits inside — or
   * right next to — a container that already carries its own
   * `aria-live` status text, so screen readers aren't told twice.
   */
  decorative?: boolean;
}

/**
 * Neribo's animated brand reveal, used wherever the app shows a
 * full-screen loading state (see src/App.tsx's authLoading,
 * chatsLoading and operationsLoading gates — this is what someone
 * sees the moment they open the app, before Firebase/Firestore have
 * answered). Renders the same exact mark as <NeriboLogo variant="mark" />
 * (src/components/NeriboLogo.tsx) — the ring draws itself on, the
 * three triangles lock into place, then the wordmark rises in with a
 * light pass across the whole mark.
 *
 * That intro plays once (~3.4s) and holds on the fully-formed logo —
 * it never disappears or resets. From then on, while the underlying
 * loading state is still true, a single soft light sweep repeats every
 * 3.4s as a quiet "still working" cue, so a long load never reads as a
 * frozen/stuck screen. Every value below is driven by CSS
 * @keyframes with `animation-fill-mode` (one-shot parts) or
 * `animation-iteration-count: infinite` (the loop) — nothing is timed
 * with JS/setTimeout, so there is no drift or stuck-mid-animation
 * state to worry about: a fresh mount always starts clean at frame 0.
 * `prefers-reduced-motion` skips straight to the finished, static logo.
 */
export const NeriboLogoAnimated: React.FC<NeriboLogoAnimatedProps> = ({
  size = 96,
  className = "",
  label = "Loading Neribo",
  wordmark = true,
  decorative = false,
}) => {
  const uid = React.useId().replace(/:/g, "");
  const width = Math.round(size * (622 / 500));

  return (
    <div
      className={`neribo-anim-root inline-flex flex-col items-center ${className}`}
      {...(decorative ? { "aria-hidden": true } : { role: "status", "aria-label": label })}
    >
      <style>{`
        .neribo-anim-root .neribo-ring-${uid}{
          fill:none;
          stroke:url(#neribo-ring-grad-${uid});
          stroke-width:67;
          stroke-linecap:round;
          stroke-dasharray:1000;
          stroke-dashoffset:1000;
          animation:neribo-draw-ring-${uid} 1.1s cubic-bezier(.65,.05,.36,1) .1s forwards;
        }
        .neribo-anim-root .neribo-tri-mid-${uid}{
          fill:#EFA029;
          opacity:0;
          transform-box:fill-box;
          transform-origin:0% 50%;
          transform:scaleX(0);
          animation:neribo-expand-mid-${uid} .55s cubic-bezier(.22,.7,.32,1) 1.05s forwards;
        }
        .neribo-anim-root .neribo-tri-side-${uid}{
          fill:#D95C33;
          opacity:0;
          transform-box:fill-box;
          transform-origin:0% 50%;
        }
        .neribo-anim-root .neribo-tri-top-${uid}{ transform:translateX(20px); animation:neribo-lock-in-${uid} .45s cubic-bezier(.2,.9,.3,1.05) 1.45s forwards; }
        .neribo-anim-root .neribo-tri-bottom-${uid}{ transform:translateX(20px); animation:neribo-lock-in-${uid} .45s cubic-bezier(.2,.9,.3,1.05) 1.56s forwards; }
        .neribo-anim-root .neribo-shine-bar-${uid}{
          transform:translateX(0);
          animation:neribo-shine-loop-${uid} 3.4s cubic-bezier(.33,0,.2,1) 2.55s infinite;
        }
        .neribo-anim-root .neribo-word-${uid}{
          margin-top:${Math.max(6, Math.round(size * 0.12))}px;
          font-family:'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-weight:700;
          letter-spacing:-0.02em;
          font-size:${Math.max(14, Math.round(size * 0.34))}px;
          opacity:0;
          transform:translateY(10px);
          background-image:linear-gradient(115deg, var(--fg-0, #f3f4f6) 38%, #ffffff 50%, var(--fg-0, #f3f4f6) 62%);
          background-size:280% 100%;
          background-position:230% 0;
          -webkit-background-clip:text;
          background-clip:text;
          color:transparent;
          animation:
            neribo-rise-fade-${uid} .45s cubic-bezier(.16,.8,.24,1) 1.9s forwards,
            neribo-text-shine-loop-${uid} 3.4s ease-in-out 2.55s infinite;
        }
        @keyframes neribo-draw-ring-${uid}{ to{ stroke-dashoffset:0; } }
        @keyframes neribo-expand-mid-${uid}{
          0%{ opacity:0; transform:scaleX(0); }
          40%{ opacity:1; }
          100%{ opacity:1; transform:scaleX(1); }
        }
        @keyframes neribo-lock-in-${uid}{
          0%{ opacity:0; transform:translateX(20px); }
          100%{ opacity:1; transform:translateX(0); }
        }
        @keyframes neribo-rise-fade-${uid}{ to{ opacity:1; transform:translateY(0); } }
        @keyframes neribo-shine-loop-${uid}{
          0%{ transform:translateX(0); }
          26%{ transform:translateX(970px); }
          100%{ transform:translateX(970px); }
        }
        @keyframes neribo-text-shine-loop-${uid}{
          0%{ background-position:230% 0; }
          26%{ background-position:-60% 0; }
          100%{ background-position:-60% 0; }
        }
        @media (prefers-reduced-motion: reduce){
          .neribo-anim-root .neribo-ring-${uid},
          .neribo-anim-root .neribo-tri-mid-${uid},
          .neribo-anim-root .neribo-tri-side-${uid},
          .neribo-anim-root .neribo-word-${uid}{
            animation-duration:.01s !important;
            animation-iteration-count:1 !important;
            animation-delay:0s !important;
          }
          .neribo-anim-root .neribo-shine-bar-${uid}{ display:none; }
        }
      `}</style>

      <svg viewBox="290 197 622 500" width={width} height={size} xmlns="http://www.w3.org/2000/svg" overflow="visible">
        <defs>
          <linearGradient id={`neribo-ring-grad-${uid}`} x1="20%" y1="8%" x2="78%" y2="92%">
            <stop offset="0%" stopColor="#E5943A" />
            <stop offset="55%" stopColor="#CD7A2E" />
            <stop offset="100%" stopColor="#9C431E" />
          </linearGradient>
          <linearGradient id={`neribo-shine-grad-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="50%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <mask id={`neribo-mask-${uid}`} maskUnits="userSpaceOnUse" x="290" y="197" width="622" height="500">
            <path
              d="M 638.2 269.9 A 202.5 202.5 0 1 0 638.2 624.1"
              fill="none"
              stroke="#fff"
              strokeWidth={67}
              strokeLinecap="round"
            />
            <polygon points="655,296 655,396 822,346" fill="#fff" />
            <polygon points="655,497 655,598 822,548" fill="#fff" />
            <polygon points="655,373 655,520 898,447" fill="#fff" />
          </mask>
        </defs>

        <path className={`neribo-ring-${uid}`} pathLength={1000} d="M 638.2 269.9 A 202.5 202.5 0 1 0 638.2 624.1" />
        <polygon className={`neribo-tri-side-${uid} neribo-tri-top-${uid}`} points="655,296 655,396 822,346" />
        <polygon className={`neribo-tri-side-${uid} neribo-tri-bottom-${uid}`} points="655,497 655,598 822,548" />
        <polygon className={`neribo-tri-mid-${uid}`} points="655,373 655,520 898,447" />

        <g mask={`url(#neribo-mask-${uid})`}>
          <rect
            className={`neribo-shine-bar-${uid}`}
            x="0"
            y="197"
            width="220"
            height="500"
            fill={`url(#neribo-shine-grad-${uid})`}
          />
        </g>
      </svg>

      {wordmark && <span className={`neribo-word-${uid}`}>Neribo</span>}
    </div>
  );
};