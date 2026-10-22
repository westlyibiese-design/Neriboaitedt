import React from "react";
import { reportDiagnostic } from "../lib/diagnostics";

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Root-level React Error Boundary (System Console Diagnostics, Phase 3
 * of the System Console). Neribo had no Error Boundary anywhere before
 * this — any render crash previously took down the whole app to a blank
 * white screen with nothing captured. Mounted once in src/main.tsx,
 * wrapping <App /> itself, so it catches a crash anywhere in the tree
 * (including a crash on AuthScreen, before any account is signed in).
 *
 * Reports via src/lib/diagnostics.ts's reportDiagnostic() rather than
 * src/lib/errorHandling.ts's toSafeMessage — a render crash isn't a
 * caught, categorizable failure (auth/network/firestore/ai/...), it's
 * exactly the kind of event the Diagnostics section (not the Events
 * page) exists for. Always reported as `critical` severity: unlike a
 * caught error the user can retry, a render crash means the affected
 * part of the UI is gone until this boundary's own reset/reload, so it
 * always deserves the Supervisor notification `critical` triggers (see
 * reportDiagnostic).
 *
 * Deliberately a plain, minimal fallback UI (not a redesign of the
 * app's error states elsewhere) — its only job is to tell the person
 * something broke and give them a way back, styled to match the app's
 * existing full-screen states (src/App.tsx's loading/auth screens).
 */
export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Internal logging only — same "always log, never show the raw
    // error" spirit as toSafeMessage's console.error.
    console.error("[Neribo:render-crash]", error, info.componentStack);

    // `info.componentStack` is just a list of React component display
    // names (e.g. "in ChatView\n in App") — never anything from
    // props/state — so it's safe to include as context here, unlike
    // the general "never log request bodies" caution in
    // src/lib/diagnostics.ts, which is about network payloads.
    const firstLine = (info.componentStack || "").trim().split("\n")[0]?.trim();

    reportDiagnostic({
      category: "render-crash",
      severity: "critical",
      message: error.message || error.name || "Render crashed",
      context: firstLine || "unknown component",
    });
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-dvh flex items-center justify-center bg-[var(--bg-0)] px-6">
        <div className="max-w-sm w-full text-center space-y-4">
          <h1 className="font-serif text-xl font-bold text-[var(--fg-0)]">Something went wrong</h1>
          <p className="text-sm text-[var(--muted-foreground)]">
            Neribo hit an unexpected error and this part of the app couldn't continue. This has
            been reported automatically.
          </p>
          <button
            onClick={this.handleReload}
            className="w-full py-3 px-6 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-medium hover:opacity-90 transition-colors"
          >
            Reload Neribo
          </button>
        </div>
      </div>
    );
  }
}
