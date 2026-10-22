import React from "react";
import { Loader2 } from "lucide-react";

interface LoadMoreFooterProps {
  /** How many rows are currently loaded (unfiltered count, not the
   * filtered/search-narrowed count) — shown so a Supervisor knows
   * whether they're looking at the complete dataset or a page of it. */
  loadedCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onLoadAll: () => void;
}

/**
 * Sits below every growing-limit realtime list (see
 * src/hooks/useRealtimeFeed.ts). Renders nothing once `hasMore` is
 * false — including on the very first render, before the first
 * snapshot has told us whether more exists — so a short list never
 * shows a pointless "Load more" it doesn't need. New records still
 * appear automatically above this footer the moment they're written;
 * this control is only about reaching further into the *existing*
 * historical dataset, never about "refreshing".
 */
export const LoadMoreFooter: React.FC<LoadMoreFooterProps> = ({
  loadedCount,
  hasMore,
  loadingMore,
  onLoadMore,
  onLoadAll,
}) => {
  if (!hasMore) return null;

  return (
    <div className="flex flex-col items-center gap-2 pt-2 pb-1">
      <div className="text-[11px] text-[var(--muted-foreground)]">
        Showing {loadedCount.toLocaleString()} so far — more may exist.
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onLoadMore}
          disabled={loadingMore}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[var(--secondary)] hover:bg-[var(--elevated)] disabled:opacity-50 text-[var(--secondary-foreground)] text-xs font-medium transition-colors"
        >
          {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Load more
        </button>
        <button
          onClick={onLoadAll}
          disabled={loadingMore}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-[var(--border)] hover:bg-[var(--elevated)] disabled:opacity-50 text-[var(--fg-1)] text-xs font-medium transition-colors"
        >
          Load all
        </button>
      </div>
    </div>
  );
};
