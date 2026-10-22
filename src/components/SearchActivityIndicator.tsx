import React from "react";
import { NeriboLogoAnimated } from "./NeriboLogoAnimated";

interface SearchActivityIndicatorProps {
  // The real query text just sent to the search provider — see
  // functions/api/llm/chat/completions.js's activity-stream section and
  // src/App.tsx's onSearchState handler. Never a hardcoded placeholder:
  // this component renders exactly what's passed in, and is only ever
  // mounted (see ChatView.tsx) while the backend has actually told the
  // frontend a search is genuinely in flight for this message.
  query: string;
}

/**
 * "Searching the web" / "Searching <query>..." activity — shown ONLY
 * for the real span between the backend's neribo_search start and done
 * events (see src/lib/neriboApi.ts's onSearchState). Never shown for a
 * request that doesn't trigger search server-side, and never a fixed
 * animation disconnected from that real state.
 */
export const SearchActivityIndicator: React.FC<SearchActivityIndicatorProps> = ({ query }) => {
  return (
    <div className="flex flex-col gap-2 py-2 text-[var(--muted-foreground)]" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <NeriboLogoAnimated size={16} wordmark={false} decorative className="shrink-0" />
        <span className="text-[13.5px] text-[var(--muted-foreground)]">Searching the web</span>
      </div>
      {query && (
        <div className="flex items-start gap-2 pl-0.5">
          <NeriboLogoAnimated size={16} wordmark={false} decorative className="mt-0.5 shrink-0" />
          <span className="text-[13.5px] text-[var(--muted-foreground)] line-clamp-2 break-words">
            Searching {query}...
          </span>
        </div>
      )}
    </div>
  );
};