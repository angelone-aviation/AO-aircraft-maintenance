import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "./store";
import {
  AUDIT_PAGE_SIZE,
  matchesAuditFilter,
  type AuditFilter,
} from "../domain/auditHistory";
import type { AuditEntry } from "../domain/model";
// Pages through the full change history from the backend. Offline, it falls
// back to the recent entries cached in the snapshot.
export function useAuditHistory({ entityUuid, aircraftUuid }: AuditFilter) {
  const { backend, online, connected, snapshot } = useWorkspace();
  const live = !!backend && online && connected;
  // New activity or a program switch reloads from the newest entry.
  const newest = snapshot?.audit[0]?.uuid;
  const program = snapshot?.activeProgramUuid;
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
        if (id === request.current)
          setError(
            e instanceof Error ? e.message : "Could not load change history.",
          );
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [backend, entityUuid, aircraftUuid],
  );
  useEffect(() => {
    if (live) void load(null);
  }, [live, load, newest, program]);
  if (!live)
    return {
      entries: (snapshot?.audit ?? []).filter((a) =>
        matchesAuditFilter(a, { entityUuid, aircraftUuid }),
      ),
      isDone: true,
      loading: false,
      error: "",
      offline: true,
      loadMore: () => {},
    };
  return {
    entries,
    isDone,
    loading,
    error,
    offline: false,
    loadMore: () => void load(cursor),
  };
}
