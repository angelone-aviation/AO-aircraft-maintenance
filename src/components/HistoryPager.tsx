/**
 * Responsibility: The pager under a list that keeps only recent history:
 *   what the list covers, Load older, and all records loaded.
 * Layer: UI. Presentational; loading is the caller's (src/data/historyPages).
 * Dependencies: react, @phosphor-icons/react, src/domain/retention.ts,
 *   src/styles/historyPager.css.
 */
import "../styles/historyPager.css";
import { useCallback, useEffect, useId, useRef } from "react";
import {
  Checks,
  ClockCounterClockwise,
  WifiSlash,
} from "@phosphor-icons/react";
import { historyWindowMonths, type HistoryKind } from "../domain/retention";

/** What the pager shows and does; useHistoryPages returns all of it. */
export interface PagerState {
  /** No older record is left to load. */
  isDone: boolean;
  loading: boolean;
  /** The last load's failure; "" when none. */
  error: string;
  /** No connection: Load older is disabled. */
  offline: boolean;
  loadOlder(): void;
}

const ICON_SIZE = 16;

/**
 * "Showing the last 3 months · Load older" under a list, or "All records
 * loaded" once nothing older is left. Offline the button is disabled, with
 * "Older records need a connection".
 *
 * @param props.pages - The list's paging state.
 * @param props.summary - What the list covers, as {@link windowSummary}
 *   words it; announced as it changes.
 * @param props.className - Placement within the list's card.
 */
export function HistoryPager({
  pages,
  summary,
  className,
}: {
  pages: PagerState;
  summary: string;
  className?: string;
}) {
  const noteId = useId();
  const [statusRef, markAsked] = useFocusWhenDone(pages.isDone);
  const { isDone, loading, offline, error } = pages;
  return (
    <div className={className ? `history-pager ${className}` : "history-pager"}>
      <p
        ref={statusRef}
        className="history-pager-summary"
        role="status"
        tabIndex={-1}
      >
        {isDone ? <AllLoaded /> : summary}
      </p>
      {!isDone && <span aria-hidden="true">·</span>}
      {!isDone && (
        <button
          type="button"
          className="history-pager-load"
          disabled={offline || loading}
          aria-describedby={offline ? noteId : undefined}
          onClick={() => {
            markAsked();
            pages.loadOlder();
          }}
        >
          <ClockCounterClockwise size={ICON_SIZE} aria-hidden="true" />
          {loading ? "Loading older records…" : "Load older"}
        </button>
      )}
      {offline && !isDone && (
        <p id={noteId} className="history-pager-note">
          <WifiSlash size={ICON_SIZE} aria-hidden="true" />
          Older records need a connection
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * What a paged list covers: the window, and the older rows loaded.
 *
 * @param kind - The list, for its window.
 * @param older - Older rows loaded so far.
 * @param noun - One row, such as "work order"; an "s" makes it plural.
 * @returns "Showing the last 3 months", or "… and 50 older work orders".
 */
export function windowSummary(
  kind: HistoryKind,
  older: number,
  noun: string,
): string {
  const window = `Showing the last ${historyWindowMonths(kind)} months`;
  if (!older) return window;
  return `${window} and ${older} older ${older === 1 ? noun : `${noun}s`}`;
}

/**
 * A change history's paging as the pager shows it. Offline the history lists
 * only the recent entries kept on the device, which are not all of them.
 *
 * @param history - From useAuditHistory.
 */
export function changeHistoryPages(history: {
  isDone: boolean;
  loading: boolean;
  error: string;
  offline: boolean;
  loadMore(): void;
}): PagerState {
  const { isDone, loading, error, offline, loadMore } = history;
  return {
    isDone: isDone && !offline,
    loading,
    error,
    offline,
    loadOlder: loadMore,
  };
}

/** What a change history lists, beside its pager. */
export const CHANGE_HISTORY_SUMMARY = "Newest changes first";

function AllLoaded() {
  return (
    <>
      <Checks size={ICON_SIZE} aria-hidden="true" />
      All records loaded
    </>
  );
}

// The last Load older removes its button; focus moves to the line saying all
// records are loaded rather than being lost.
function useFocusWhenDone(isDone: boolean) {
  const ref = useRef<HTMLParagraphElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (isDone && asked.current) ref.current?.focus();
    asked.current = false;
  }, [isDone]);
  const markAsked = useCallback(() => {
    asked.current = true;
  }, []);
  return [ref, markAsked] as const;
}
