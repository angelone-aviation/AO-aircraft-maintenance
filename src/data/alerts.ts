import { create } from "zustand";
import * as local from "./local";
import { useWorkspace } from "./store";

interface AlertReads {
  scope: string;
  keys: string[];
  error: string;
  load(): Promise<void>;
  markRead(keys: string[], all?: boolean): Promise<void>;
}
// Read state is per user and Flight Program; a device copy keeps the badge
// accurate offline until the backend answers.
function currentScope() {
  const { namespace, snapshot } = useWorkspace.getState();
  return snapshot
    ? `${namespace}:alert-reads:${snapshot.user.id}:${snapshot.activeProgramUuid ?? ""}`
    : "";
}
const cache = (scope: string, keys: string[]) =>
  local.saveFavorites(scope, keys).catch(() => undefined); // Cache only.
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

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
      await cache(scope, keys);
    } catch (error) {
      if (get().scope === scope)
        set({ error: message(error, "Unable to load read alerts.") });
    }
  },
  async markRead(keys, all = false) {
    const { scope } = get();
    const { backend, snapshot } = useWorkspace.getState();
    if (!scope || scope !== currentScope() || !backend || !snapshot) return;
    const next = [...new Set(all ? keys : [...get().keys, ...keys])];
    set({ keys: next, error: "" });
    await cache(scope, next);
    try {
      await backend.markAlertsRead(snapshot.activeProgramUuid, keys, all);
    } catch (error) {
      set({ error: message(error, "Unable to save read alerts.") });
    }
  },
}));
