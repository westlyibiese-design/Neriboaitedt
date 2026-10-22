import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastVariant = "success" | "error" | "info";

interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  /** Shows a Neribo-styled toast. Defaults to "info". Auto-dismisses. */
  showToast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Every user-facing success/info/error notification in Neribo should go
 * through this hook rather than `alert()` or a one-off inline banner —
 * this is the "Neribo UI notification" step in the centralized error
 * handling flow (see src/lib/errorHandling.ts).
 */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fails loudly in dev rather than silently no-op-ing, so a missing
    // <ToastProvider> in the tree is caught immediately.
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

const VARIANT_STYLES: Record<
  ToastVariant,
  { icon: React.ElementType; iconClass: string }
> = {
  success: { icon: CheckCircle2, iconClass: "text-emerald-400" },
  error: { icon: AlertCircle, iconClass: "text-rose-400" },
  info: { icon: Info, iconClass: "text-blue-400" },
};

const AUTO_DISMISS_MS = 4500;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  const showToast = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev, { id, message, variant }]);
      timers.current[id] = setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        className="fixed bottom-4 inset-x-0 z-[100] flex flex-col items-center gap-2 px-4 pointer-events-none"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => {
          const { icon: Icon, iconClass } = VARIANT_STYLES[t.variant];
          return (
            <div
              key={t.id}
              className="pointer-events-auto flex items-center gap-2.5 max-w-sm w-full sm:w-auto bg-[var(--popover)] border border-[var(--border)] rounded-2xl shadow-2xl px-4 py-3 animate-in fade-in slide-in-from-bottom-2 duration-200"
            >
              <Icon className={`h-4.5 w-4.5 shrink-0 ${iconClass}`} />
              <span className="text-[13.5px] text-[var(--popover-foreground)] leading-snug">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="ml-1 p-1 rounded-full text-[var(--muted-foreground)] hover:text-[var(--popover-foreground)] hover:bg-[var(--elevated)] transition-colors shrink-0"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};
