/**
 * Responsibility: Pages through the change history for a screen, from the
 *   backend when connected and from the snapshot's recent entries offline.
 * Layer: Data. React hook over the workspace store; renders nothing.
 * Dependencies: react, src/data/store.ts, src/data/backend.ts (types),
 *   src/domain/auditHistory.ts, src/domain/model.ts (types).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "./store";
import {
  AUDIT_PAGE_SIZE,
  matchesAuditFilter,
  type AuditFilter,
} from "../domain/auditHistory";
import type { AuditEntry, Snapshot } from "../domain/model";
import type { Backend } from "./backend";

/**
 * The change history for one record or aircraft. Connected, it loads the
 * newest page from the backend, and again on new activity or a program
 * switch; `loadMore` appends the next page. Offline, it lists the snapshot's
 * recent entries that match, with `offline` set and `isDone` true.
 *
 * @param filter - The record (`entityUuid`) or aircraft to show; neither for
 *   all history.
 * @returns The entries, newest first, with paging and load state. `error`
 *   holds the backend's message, or "Could not load change history.".
 */
export function useAuditHistory({ entityUuid, aircraftUuid }: AuditFilter) {
  const { backend, online, connected, snapshot } = useWorkspace();
  const live = !!backend && online && connected;
  const newest = snapshot?.audit[0]?.uuid;
  const program = snapshot?.activeProgramUuid;
  const { entries, cursor, isDone, loading, error, load } = useAuditPages(
    backend,
    entityUuid,
    aircraftUuid,
  );
  useEffect(() => {
    if (live) void load(null);
  }, [live, load, newest, program]);
  if (!live) return offlineHistory(snapshot, { entityUuid, aircraftUuid });
  return {
    entries,
    isDone,
    loading,
    error,
    offline: false,
    loadMore: () => void load(cursor),
  };
}

// A newer load supersedes an older one: only the latest request's result,
// error and end of loading are applied.
function useAuditPages(
  backend: Backend | null,
  entityUuid?: string,
  aircraftUuid?: string,
) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isDone, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = useCallback(
    async (from: string | null) => {
      if (!backend) return;
      const id = ++request.current;
      setLoading(true);
      setError("");
      try {
        const result = await backend.auditPage({
          entityUuid,
          aircraftUuid,
          cursor: from,
          numItems: AUDIT_PAGE_SIZE,
        });
        if (id !== request.current) return;
        setEntries((current) =>
          from === null ? result.page : [...current, ...result.page],
        );
        setCursor(result.continueCursor);
        setDone(result.isDone);
      } catch (e) {
        if (id === request.current) setError(describeLoadError(e));
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [backend, entityUuid, aircraftUuid],
  );
  return { entries, cursor, isDone, loading, error, load };
}

function describeLoadError(e: unknown): string {
  return e instanceof Error ? e.message : "Could not load change history.";
}

function offlineHistory(snapshot: Snapshot | null, filter: AuditFilter) {
  return {
    entries: (snapshot?.audit ?? []).filter((a) =>
      matchesAuditFilter(a, filter),
    ),
    isDone: true,
    loading: false,
    error: "",
    offline: true,
    loadMore: () => {},
  };
}
