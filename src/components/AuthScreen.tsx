import React, { useState } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { NeriboLogo } from "./NeriboLogo";

interface AuthScreenProps {
  onEmailSignIn: (email: string, password: string) => void;
  onEmailSignUp: (email: string, password: string) => void;
  errorMessage?: string;
  onOpenLegal: (type: "terms" | "usage" | "privacy") => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  onEmailSignIn,
  onEmailSignUp,
  errorMessage,
  onOpenLegal,
}) => {
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const handleEmailSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailInput.trim() || !passwordInput) return;
    if (mode === "signup") {
      onEmailSignUp(emailInput.trim(), passwordInput);
    } else {
      onEmailSignIn(emailInput.trim(), passwordInput);
    }
  };

  return (
    <div className="relative flex flex-col justify-between min-h-dvh w-full bg-[var(--bg-0)] px-6 py-6 overflow-y-auto">
      {/* Main Centered Content.
          min-h-dvh (not min-h-screen) on the outer container is the fix
          for the footer notice requiring a scroll to see: 100vh/min-h-screen
          is measured against the mobile browser's *large* viewport — the
          size you'd get with the address bar and nav bar hidden — which is
          taller than what's actually visible while those bars are showing
          on first load. That taller-than-visible layout is exactly why the
          footer sat below the fold until scrolling collapsed the browser
          chrome and "revealed" the extra space. dvh tracks the real,
          currently-visible viewport instead, so the page always matches
          what the user can actually see on load, on any device or browser.
          No top-bar logo anymore (removed per feedback) — the full logo
          below is now the only mark on screen, so it reads as centered
          instead of competing with a second, smaller one up top. */}
      <div className="flex flex-col items-center justify-center flex-1 max-w-sm w-full mx-auto py-8 text-center space-y-6 animate-in fade-in zoom-in-95 duration-300">
        {/* Hero Tagline in high-contrast Serif font as in Screenshot 2 */}
        <div className="space-y-2">
          <div className="flex justify-center mb-2">
            <NeriboLogo variant="full" size="md" />
          </div>
          <h1 className="font-serif text-4xl sm:text-5xl font-medium tracking-tight text-[var(--fg-0)] leading-[1.15]">
            Smart help, built
            <br />
            for how you work
          </h1>
        </div>

        {/* Auth Action Controls */}
        <div className="w-full space-y-4 pt-2">
          {/* Email + password form */}
          <form onSubmit={handleEmailSubmit} className="w-full space-y-3">
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="Enter your email"
              className="w-full py-3.5 px-6 rounded-full bg-[var(--input)] border border-[var(--input-border)] text-[var(--input-foreground)] text-center text-[15px] placeholder-[var(--placeholder)] focus:outline-none focus:border-[var(--ring)] transition-colors shadow-inner"
              required
            />
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Enter your password"
              className="w-full py-3.5 px-6 rounded-full bg-[var(--input)] border border-[var(--input-border)] text-[var(--input-foreground)] text-center text-[15px] placeholder-[var(--placeholder)] focus:outline-none focus:border-[var(--ring)] transition-colors shadow-inner"
              required
            />

            {errorMessage ? (
              <p className="text-red-400 text-sm">{errorMessage}</p>
            ) : null}

            <div className="relative w-full">
              <button
                type="submit"
                disabled={!emailInput.trim() || !passwordInput}
                className="w-full flex items-center justify-center gap-2 py-3.5 px-6 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] font-semibold text-[15px] shadow-lg hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                <span>{mode === "signup" ? "Create account" : "Sign in"}</span>
                <ArrowRight className="h-4 w-4 stroke-[2.5]" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="text-[13px] text-[var(--muted-foreground)] hover:text-[var(--fg-0)] transition-colors"
            >
              {mode === "signin"
                ? "Don't have an account? Create one"
                : "Already have an account? Sign in"}
            </button>
          </form>
        </div>
      </div>

      {/* Footer Disclaimer matching Screenshot 2 */}
      <div className="max-w-xs mx-auto text-center pt-6">
        <p className="text-[13px] text-[var(--muted-foreground)] leading-relaxed">
          By continuing, you agree to Neribo's{" "}
          <button
            onClick={() => onOpenLegal("terms")}
            className="underline underline-offset-2 text-[var(--muted-foreground)] hover:text-[var(--fg-0)] transition-colors"
          >
            Consumer Terms
          </button>{" "}
          and{" "}
          <button
            onClick={() => onOpenLegal("usage")}
            className="underline underline-offset-2 text-[var(--muted-foreground)] hover:text-[var(--fg-0)] transition-colors"
          >
            Usage Policy
          </button>
          , and acknowledge their{" "}
          <button
            onClick={() => onOpenLegal("privacy")}
            className="underline underline-offset-2 text-[var(--muted-foreground)] hover:text-[var(--fg-0)] transition-colors"
          >
            Privacy Policy
          </button>
          .
        </p>
      </div>
    </div>
  );
};
