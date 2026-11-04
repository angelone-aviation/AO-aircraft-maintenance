/**
 * Responsibility: Tracks which alerts the signed-in user has read in the
 *   active Flight Program.
 * Layer: Data. Zustand store over the Backend and the device cache; no UI.
 * Dependencies: zustand, src/data/local.ts, src/data/store.ts,
 *   src/data/errors.ts.
 *
 * Read state is per user and Flight Program and lives on the server; a device
 * copy keeps the badge accurate offline until the backend answers.
 */
import { create } from "zustand";
import * as local from "./local";
import { useWorkspace } from "./store";
import { errorText } from "./errors";

interface AlertReads {
  /** Whose reads `keys` holds: namespace, user and program; "" before load. */
  scope: string;
  keys: string[];
  error: string;
  /**
   * Switches to the current scope, starting from the device copy, then merges
   * the server's reads. Sets `error` to the failure's errorText, falling back
   * to "Unable to load read alerts.", when the server cannot answer.
   */
  load(): Promise<void>;
  /**
   * Adds the keys (with `all`, replaces the reads with them) here and on the
   * device at once, then saves them on the server. Sets `error` to the
   * failure's errorText, falling back to "Unable to save read alerts.", when
   * that fails.
   */
  markRead(keys: string[], all?: boolean): Promise<void>;
}

/**
 * The read alert keys for the workspace's user and program. Its actions do
 * nothing without a backend and snapshot (markRead also before a load), and
 * drop results that arrive after the user left that scope.
 */
export const useAlertReads = create<AlertReads>((set, get) => ({
  scope: "",
  keys: [],
  error: "",
  async load() {
    const scope = currentScope();
    const { backend, snapshot } = useWorkspace.getState();
    if (!scope || !backend || !snapshot) return;
    if (scope !== get().scope) {
      set({ scope, keys: [], error: "" });
      const cached = await local.readFavorites(scope).catch(() => undefined);
      if (get().scope !== scope) return;
      set({ keys: [...new Set([...get().keys, ...(cached ?? [])])] });
    }
    try {
      const remote = await backend.alertReads(snapshot.activeProgramUuid);
      if (get().scope !== scope) return;
      const keys = [...new Set([...get().keys, ...remote])];
      set({ keys });
      await cacheReads(scope, keys);
    } catch (error) {
      if (get().scope === scope)
        set({ error: errorText(error, "Unable to load read alerts.") });
    }
  },
  async markRead(keys, all = false) {
    const { scope } = get();
    const { backend, snapshot } = useWorkspace.getState();
    if (!scope || scope !== currentScope() || !backend || !snapshot) return;
    const next = [...new Set(all ? keys : [...get().keys, ...keys])];
    set({ keys: next, error: "" });
    await cacheReads(scope, next);
    try {
      await backend.markAlertsRead(snapshot.activeProgramUuid, keys, all);
    } catch (error) {
      set({ error: errorText(error, "Unable to save read alerts.") });
    }
  },
}));

function currentScope(): string {
  const { namespace, snapshot } = useWorkspace.getState();
  return snapshot
    ? `${namespace}:alert-reads:${snapshot.user.id}:${snapshot.activeProgramUuid ?? ""}`
    : "";
}

// The device copy is a convenience: the server holds the read state, so a
// failed write (or, in load(), a failed read) is ignored.
function cacheReads(scope: string, keys: string[]) {
  return local.saveFavorites(scope, keys).catch(() => undefined);
}
