import React from "react";

interface NeriboLogoProps {
  variant?: "full" | "wordmark" | "mark";
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  className?: string;
  onClick?: () => void;
}

/**
 * Neribo's official brand mark: an orange-to-red-brown gradient ring
 * (open on the right) with three coral triangles fanning out of the
 * opening. Traced from the approved logo artwork — the ring is a
 * single stroked arc, viewBox "290 197 622 500", center (540,447) —
 * so it stays crisp at every size below instead of blurring the way a
 * raster PNG would at xs/sm icon sizes.
 *
 * This replaces the previous navy-tile "chevron + gold dot" mark and
 * the Newsreader serif "Neribo" wordmark everywhere in the app — every
 * call site below (Header, AuthScreen, SettingsModals, SidebarDrawer,
 * DeviceLockScreen, OperationsSidebar, OrderIntake, App.tsx) keeps
 * using this same <NeriboLogo variant size /> API unchanged.
 *
 * For the animated version shown on the app's loading screens, see
 * ./NeriboLogoAnimated.tsx.
 */
export const NeriboLogo: React.FC<NeriboLogoProps> = ({
  variant = "wordmark",
  size = "md",
  className = "",
  onClick,
}) => {
  const gradId = React.useId();

  const sizeMap = {
    xs: { text: "text-lg", markHeight: 20 },
    sm: { text: "text-xl", markHeight: 26 },
    md: { text: "text-2xl sm:text-3xl", markHeight: 34 },
    lg: { text: "text-3xl sm:text-4xl", markHeight: 44 },
    xl: { text: "text-4xl sm:text-5xl", markHeight: 58 },
  };

  const currentSize = sizeMap[size];
  // Icon-only bounding box of the mark is 622 x 500 (viewBox below) —
  // used so the mark's rendered width matches its real aspect ratio
  // instead of being squashed into a square box.
  const markWidth = Math.round(currentSize.markHeight * (622 / 500));

  const renderMark = () => (
    <svg
      viewBox="290 197 622 500"
      width={markWidth}
      height={currentSize.markHeight}
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${gradId}-ring`} x1="20%" y1="8%" x2="78%" y2="92%">
          <stop offset="0%" stopColor="#E5943A" />
          <stop offset="55%" stopColor="#CD7A2E" />
          <stop offset="100%" stopColor="#9C431E" />
        </linearGradient>
      </defs>
      <path
        d="M 638.2 269.9 A 202.5 202.5 0 1 0 638.2 624.1"
        fill="none"
        stroke={`url(#${gradId}-ring)`}
        strokeWidth={67}
        strokeLinecap="round"
      />
      <polygon points="655,296 655,396 822,346" fill="#D95C33" />
      <polygon points="655,497 655,598 822,548" fill="#D95C33" />
      <polygon points="655,373 655,520 898,447" fill="#EFA029" />
    </svg>
  );

  const renderWordmark = () => (
    <span
      className={`font-sans font-bold tracking-tight text-[var(--fg-0)] select-none ${currentSize.text}`}
      style={{ letterSpacing: "-0.02em" }}
    >
      Neribo
    </span>
  );

  return (
    <div
      className={`inline-flex items-center gap-2.5 ${onClick ? "cursor-pointer" : ""} ${className}`}
      onClick={onClick}
    >
      {(variant === "full" || variant === "mark") && renderMark()}
      {(variant === "full" || variant === "wordmark") && renderWordmark()}
    </div>
  );
};
