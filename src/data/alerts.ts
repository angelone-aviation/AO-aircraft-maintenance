/**
 * Responsibility: Tracks which alerts the signed-in user has read in the
 *   active Flight Program.
 * Layer: Data. Zustand store over the Backend and the device cache; no UI.
 * Dependencies: zustand, src/data/local.ts, src/data/store.ts,
 *   src/data/errors.ts.
 *
 * Read state is per user and Flight Program and lives on the server; a device
 * copy keeps the badge accurate offline until the backend answers. A mark
 * lasts as long as its alert: when the alert clears, the mark is forgotten.
 */
import { create, type StoreApi } from "zustand";
import * as local from "./local";
import { useWorkspace } from "./store";
import { errorText } from "./errors";

interface AlertReads {
  /** Whose reads `keys` holds: namespace, user and program; "" before load. */
  scope: string;
  keys: string[];
  error: string;
  /** Whether the server has answered for `scope`; until then `keys` is the
   * device copy. */
  synced: boolean;
  /** Marks made here that the server has not confirmed saving. */
  unsaved: string[];
  /**
   * Switches to the current scope, starting from the device copy, then
   * replaces it with the server's reads plus the marks not saved yet: the
   * server forgets the marks of cleared alerts, and the copy must not bring
   * them back. Sets `error` to the failure's errorText, falling back to
   * "Unable to load read alerts.", when the server cannot answer.
   */
  load(): Promise<void>;
  /**
   * Adds the keys (with `all`, replaces the reads with them) here and on the
   * device at once, then saves them on the server. Sets `error` to the
   * failure's errorText, falling back to "Unable to save read alerts.", when
   * that fails.
   */
  markRead(keys: string[], all?: boolean): Promise<void>;
  /**
   * Forgets the marks of alerts no longer shown, here, on the device and on
   * the server, so an alert that clears and later returns is unread again.
   * Does nothing until the server's reads have loaded. A failed save sets no
   * error: the server forgets cleared marks at its own next alert check.
   *
   * @param current - The key of every alert shown now.
   */
  forgetCleared(current: string[]): Promise<void>;
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
  synced: false,
  unsaved: [],
  load: () => loadReads({ set, get }),
  markRead: (keys, all = false) => saveReads({ set, get }, keys, all),
  forgetCleared: (current) => forgetClearedReads({ set, get }, current),
}));

type Store = {
  set: StoreApi<AlertReads>["setState"];
  get: StoreApi<AlertReads>["getState"];
};

async function loadReads(store: Store) {
  const { set, get } = store;
  const scope = currentScope();
  const { backend, snapshot } = useWorkspace.getState();
  if (!scope || !backend || !snapshot) return;
  if (scope !== get().scope && !(await switchScope(store, scope))) return;
  try {
    const remote = await backend.alertReads(snapshot.activeProgramUuid);
    if (get().scope !== scope) return;
    const keys = [...new Set([...remote, ...get().unsaved])];
    set({ keys, synced: true });
    await cacheReads(scope, keys);
  } catch (error) {
    if (get().scope === scope)
      set({ error: errorText(error, "Unable to load read alerts.") });
  }
}

// Starts the scope from the device copy; false when the user left the scope
// while it was read.
async function switchScope({ set, get }: Store, scope: string) {
  set({ scope, keys: [], error: "", synced: false, unsaved: [] });
  const cached = await local.readFavorites(scope).catch(() => undefined);
  if (get().scope !== scope) return false;
  set({ keys: [...new Set([...get().keys, ...(cached ?? [])])] });
  return true;
}

async function saveReads({ set, get }: Store, keys: string[], all: boolean) {
  const { scope } = get();
  const { backend, snapshot } = useWorkspace.getState();
  if (!scope || scope !== currentScope() || !backend || !snapshot) return;
  const next = [...new Set(all ? keys : [...get().keys, ...keys])];
  set({ keys: next, error: "", unsaved: union(get().unsaved, keys) });
  await cacheReads(scope, next);
  try {
    await backend.markAlertsRead(snapshot.activeProgramUuid, keys, all);
    if (get().scope === scope)
      set({ unsaved: get().unsaved.filter((k) => !keys.includes(k)) });
  } catch (error) {
    set({ error: errorText(error, "Unable to save read alerts.") });
  }
}

async function forgetClearedReads({ set, get }: Store, current: string[]) {
  const { scope, synced, keys } = get();
  const { backend, snapshot } = useWorkspace.getState();
  if (!synced || scope !== currentScope() || !backend || !snapshot) return;
  const cleared = keys.filter((k) => !current.includes(k));
  if (!cleared.length) return;
  const kept = keys.filter((k) => current.includes(k));
  set({
    keys: kept,
    unsaved: get().unsaved.filter((k) => current.includes(k)),
  });
  await cacheReads(scope, kept);
  await backend
    .forgetAlertReads(snapshot.activeProgramUuid, cleared)
    // Expected offline or between sessions, and harmless: the server
    // forgets the marks of cleared alerts at its own next check.
    .catch(() => undefined);
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

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
