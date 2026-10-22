import React, { useEffect, useState } from "react";
import { Lock, Delete, LogOut, Loader2, ShieldCheck } from "lucide-react";
import { NeriboLogo } from "./NeriboLogo";
import { useDeviceLock } from "../contexts/DeviceLockContext";
import { UserAccount } from "../types";

interface DeviceLockScreenProps {
  currentUser: UserAccount;
  onSignOut: () => void;
}

/**
 * Full-screen Device Lock overlay, rendered by App.tsx whenever
 * DeviceLockContext reports `locked`. Re-confirmation on top of an
 * already-valid Firebase session — the person is already signed in, this
 * only proves it's still them right now. Never asks for the account
 * password, only the Device PIN set on
 * src/components/operations/DeviceSettingsPanel.tsx. "Sign out" always
 * stays available as an explicit escape hatch, and performs a real,
 * complete sign-out (unlike closing/backgrounding the tab, which just
 * re-locks on return).
 *
 * Visual language matches Neribo's existing dark theme tokens
 * (var(--bg-*)/var(--fg-*) from src/index.css) rather than introducing a
 * one-off palette, per the task's "don't break Neribo's design language."
 * Ported from the Westly HMS reference's DeviceLockScreen, which used a
 * fixed navy/gold theme — this version reads live theme variables so it
 * looks right in Light, Dark, Midnight, or System.
 */
export const DeviceLockScreen: React.FC<DeviceLockScreenProps> = ({ currentUser, onSignOut }) => {
  const { unlockWithPin } = useDeviceLock();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [shake, setShake] = useState(false);

  const handleDigit = (d: string) => {
    if (verifying || pin.length >= 10) return;
    setError(null);
    setPin((p) => p + d);
  };

  const handleDelete = () => {
    if (!verifying) setPin((p) => p.slice(0, -1));
  };

  const submitPin = async (currentPin: string) => {
    if (currentPin.length < 6 || verifying) return;
    setVerifying(true);
    setError(null);
    try {
      await unlockWithPin(currentPin);
      // On success, DeviceLockContext flips `locked` to false and App.tsx
      // stops rendering this component — nothing left to do here.
    } catch (err) {
      setVerifying(false);
      setPin("");
      setShake(true);
      setError(err instanceof Error ? err.message : "Incorrect PIN. Please try again.");
      setTimeout(() => setShake(false), 600);
    }
  };

  useEffect(() => {
    if (pin.length >= 6) void submitPin(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  return (
    <div
      className="fixed inset-0 z-[100] min-h-dvh bg-[var(--bg-0)] flex items-center justify-center p-4 overflow-hidden select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Device locked — enter your PIN to continue"
      onContextMenu={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      style={{ WebkitUserSelect: "none", userSelect: "none" }}
    >
      <div className="w-full max-w-sm flex flex-col items-center relative z-10">
        <div className="text-center mb-8">
          <NeriboLogo variant="mark" size="md" className="mx-auto mb-4" />
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5 shadow-lg bg-[var(--bg-3)] border border-[var(--border-1)]">
            <Lock className="w-7 h-7 text-[var(--fg-0)]" />
          </div>
          <h1 className="font-serif text-3xl font-bold text-[var(--fg-0)]">Welcome back</h1>
          <p className="text-[var(--fg-1)] mt-2 text-sm max-w-xs mx-auto leading-relaxed">
            This device was locked automatically for security.
            {currentUser.name ? (
              <>
                {" "}
                Enter your PIN to continue as{" "}
                <span className="text-[var(--fg-0)] font-medium">{currentUser.name}</span>.
              </>
            ) : (
              " Enter your PIN to continue."
            )}
          </p>
        </div>

        <div
          className="w-full"
          style={shake ? { animation: "neribo-lock-shake 0.5s ease-in-out" } : undefined}
        >
          {/* PIN dots — the PIN itself is never rendered as text */}
          <div className="flex justify-center gap-4 mb-10 h-6" role="status" aria-live="polite" aria-atomic="true">
            <span className="sr-only">{pin.length} of 6 to 10 digits entered</span>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                aria-hidden="true"
                className="w-4 h-4 rounded-full transition-all duration-200"
                style={{
                  backgroundColor: i < pin.length ? "var(--fg-0)" : "var(--border-1)",
                  transform: i < pin.length ? "scale(1.25)" : "scale(1)",
                }}
              />
            ))}
          </div>

          {error && <p className="text-sm text-rose-400 text-center mb-4 -mt-6">{error}</p>}

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-3 max-w-[240px] mx-auto">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button
                key={d}
                onClick={() => handleDigit(d)}
                disabled={verifying}
                className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-2xl font-medium text-[var(--fg-0)] hover:bg-[var(--bg-3)] active:scale-95 transition-all disabled:opacity-50"
              >
                {d}
              </button>
            ))}
            <div />
            <button
              onClick={() => handleDigit("0")}
              disabled={verifying}
              className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-2xl font-medium text-[var(--fg-0)] hover:bg-[var(--bg-3)] active:scale-95 transition-all disabled:opacity-50"
            >
              0
            </button>
            <button
              onClick={handleDelete}
              disabled={verifying || pin.length === 0}
              aria-label="Delete last digit"
              className="w-[72px] h-[72px] rounded-full flex items-center justify-center text-[var(--fg-1)] hover:bg-[var(--bg-3)] active:scale-95 transition-all disabled:opacity-30"
            >
              <Delete className="w-6 h-6" />
            </button>
          </div>

          {verifying && (
            <div className="flex items-center justify-center gap-2 mt-6 text-[var(--fg-1)] text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Verifying…
            </div>
          )}
        </div>

        <div className="w-full max-w-xs mt-10 flex items-center gap-3 text-[var(--fg-1)] text-xs">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <p>For your security, this device locks automatically after 5 minutes of inactivity.</p>
        </div>

        <button
          onClick={onSignOut}
          className="mt-6 text-sm text-[var(--fg-1)] hover:text-[var(--fg-0)] flex items-center gap-2 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>

      <style>{`
        @keyframes neribo-lock-shake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-8px); }
          40%, 80% { transform: translateX(8px); }
        }
      `}</style>
    </div>
  );
};

/**
 * Thin bridge between App.tsx and DeviceLockContext: App.tsx renders the
 * Provider around the whole app shell, but can't itself call
 * useDeviceLock() (a component can't consume a context it renders the
 * Provider for) — this sibling does, and renders the lock screen only
 * when the context reports `locked`. Render this once, anywhere inside
 * <DeviceLockProvider>, alongside the rest of the app (it renders
 * nothing itself when unlocked).
 */
export const DeviceLockOverlay: React.FC<DeviceLockScreenProps> = (props) => {
  const { locked } = useDeviceLock();
  if (!locked) return null;
  return <DeviceLockScreen {...props} />;
};
