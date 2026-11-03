import { validateChecklistFlight } from "../domain/flightChecklistLink";
import { validatePlanFlight } from "../domain/flightPlans";
import { scopedSnapshot } from "../domain/programs";
import { create } from "zustand";
import { ConvexError } from "convex/values";
import type { Operation, QueuedOperation, Snapshot } from "../domain/model";
import { can, localDate, offlineValid } from "../domain/model";
import { dispatchGate } from "../domain/aircraftStatus";
import { validateFlight } from "../domain/flights";
import * as local from "./local";
import { reconcileKeptManuals, removeAllKeptManuals } from "./deviceManuals";
import { demoSnapshot, withDemoUser } from "./demo";
import type { Backend } from "./backend";
import { demoBackend } from "./demoBackend";
export interface Workspace {
  ready: boolean;
  snapshot: Snapshot | null;
  queue: QueuedOperation[];
  namespace: string;
  demo: boolean;
  online: boolean;
  connected: boolean;
  syncing: boolean;
  blocked: boolean;
  error: string;
  notice: string;
  favorites: string[];
  backend: Backend | null;
  initialize(namespace: string, demo: boolean): Promise<void>;
  receive(snapshot: Snapshot | null): Promise<void>;
  setConnection(online: boolean, connected: boolean): void;
  enqueue(operation: Operation): Promise<void>;
  flush(retry?: boolean): Promise<void>;
  discard(uuid: string): Promise<void>;
  toggleFavorite(uuid: string): Promise<void>;
  signOutLocal(): Promise<void>;
}
// Server rejections (ConvexError, or any failure reported by the Convex
// backend as "[CONVEX M(...)] ...") will not succeed on resend; anything else
// (dropped connection, timeout, client-side failure) is retried automatically.
export function permanentSyncError(error: unknown) {
  return (
    error instanceof ConvexError ||
    (error instanceof Error && error.message.startsWith("[CONVEX "))
  );
}
function canFlush(state: Workspace) {
  return (
    state.online &&
    state.connected &&
    !!state.backend &&
    state.snapshot !== null &&
    !state.blocked &&
    offlineValid(state.snapshot)
  );
}
// Set when flush is called during a running flush so the running loop makes
// another pass instead of dropping the request.
let flushRequested = false;
let retryRequested = false;
// Drops snapshot completions that finish after a newer receive() started.
let receiveSequence = 0;
// Device-local drafts keyed by namespace; cleared on sign-out.
const draftPrefixes = [
  "angel-one-guided:",
  "angel-one-flight-sessions:",
  "angel-one-checks:",
];
function clearDeviceDrafts(namespace: string) {
  let keys: string[];
  try {
    keys = Object.keys(localStorage);
  } catch {
    return; // Storage is unavailable, so no drafts were written.
  }
  for (const key of keys)
    if (
      draftPrefixes.some((prefix) => key.startsWith(prefix + namespace + ":"))
    )
      localStorage.removeItem(key);
}
export const useWorkspace = create<Workspace>((set, get) => ({
  ready: false,
  snapshot: null,
  queue: [],
  namespace: "",
  demo: false,
  online: navigator.onLine,
  connected: false,
  syncing: false,
  blocked: false,
  error: "",
  notice: "",
  favorites: [],
  backend: null,
  async initialize(namespace, demo) {
    set({
      ready: false,
      snapshot: null,
      queue: [],
      namespace,
      demo,
      blocked: false,
      error: "",
      notice: "",
    });
    try {
      const [cached, queue] = await Promise.all([
        local.readSnapshot(namespace),
        local.readQueue(namespace),
      ]);
      const full = demo
        ? ((await local.readSnapshot(namespace + ":all")) ??
          cached ??
          demoSnapshot())
        : cached;
      if (demo && full && cached?.user.id === full.user.id)
        full.authenticatedAt = cached.authenticatedAt;
      const snapshot = full
        ? demo
          ? scopedSnapshot(full)
          : full.programScopeVersion === 1
            ? full
            : null
        : null;
      if (demo && full) await local.saveSnapshot(namespace + ":all", full);
      // Persist before showing the workspace, so once it renders no startup
      // write is still pending that could overwrite a newer one.
      if (snapshot && demo) await local.saveSnapshot(namespace, snapshot);
      const favorites = snapshot
        ? ((await local.readFavorites(namespace + ":" + snapshot.user.id)) ??
          [])
        : [];
      set({
        namespace,
        demo,
        snapshot,
        queue,
        favorites,
        ready: true,
        connected: demo && navigator.onLine,
        backend: demo ? demoBackend(useWorkspace) : get().backend,
      });
      if (snapshot) void reconcileKeptManuals(namespace, snapshot);
    } catch {
      set({
        ready: true,
        error:
          "Persistent storage is unavailable. Enable browser storage before adding offline entries.",
      });
    }
  },
  async receive(snapshot) {
    const { namespace } = get();
    if (!namespace) return;
    const sequence = ++receiveSequence;
    if (snapshot) {
      const favorites =
        (await local.readFavorites(namespace + ":" + snapshot.user.id)) ?? [];
      // Check before writing too: IndexedDB applies writes in issue order, so a
      // newer receive() always persists after this one.
      if (sequence !== receiveSequence) return;
      await local.saveSnapshot(namespace, snapshot);
      if (sequence !== receiveSequence) return;
      set({ snapshot, favorites, blocked: false });
      // Kept manuals follow the snapshot: access revoked, aircraft transferred
      // or program switched away removes the device copy.
      void reconcileKeptManuals(namespace, snapshot);
      void get().flush();
    } else {
      // The session ended: nobody on this device may open kept manuals.
      await local.clearSnapshot(namespace);
      await removeAllKeptManuals(namespace);
      if (sequence !== receiveSequence) return;
      set({ snapshot: null, blocked: true });
    }
  },
  setConnection(online, connected) {
    set({ online, connected });
    if (online && connected) void get().flush();
  },
  async enqueue(operation) {
    const { snapshot, namespace } = get();
    if (!snapshot || get().blocked || !offlineValid(snapshot))
      throw new Error(
        "Your offline access expired. Reconnect and sign in; pending entries are preserved.",
      );
    if (operation.authorId !== snapshot.user.id)
      throw new Error("Account does not match this entry.");
    const aircraftUuid =
      operation.kind === "flight"
        ? operation.input.aircraftUuid
        : operation.aircraftUuid;
    if (
      !can(
        snapshot,
        aircraftUuid,
        operation.kind === "flight" ? "flight" : "discrepancy",
      )
    )
      throw new Error("You cannot add entries for this aircraft.");
    if (operation.kind === "flight")
      validateFlight(
        snapshot.aircraft.find((a) => a.uuid === aircraftUuid)!,
        operation.input,
      );
    if (operation.kind === "flight") {
      validateChecklistFlight(snapshot, operation.input);
      dispatchGate(
        snapshot,
        aircraftUuid,
        operation.dispatchOverrideReason,
        localDate(),
      );
    }
    if (operation.kind === "flight" && operation.input.flightPlanUuid) {
      validatePlanFlight(snapshot, operation.input);
      const planUuid = operation.input.flightPlanUuid;
      const pending = get().queue.find(
        (q) =>
          q.operation.kind === "flight" &&
          q.operation.input.flightPlanUuid === planUuid,
      );
      // A failed entry still blocks: it can be retried, and letting a second
      // flight queue beside it risks logging the plan twice.
      if (pending?.error)
        throw new Error(
          "This plan has a failed flight entry. Discard it in the Sync center before logging the flight again.",
        );
      if (pending)
        throw new Error(
          "This plan already has a flight pending synchronization.",
        );
    }
    operation = { ...operation, programUuid: snapshot.activeProgramUuid };
    const entry = { operation, queuedAt: Date.now() };
    await local.persistOperation(namespace, entry);
    set({
      queue: await local.readQueue(namespace),
      notice: "Entry saved on this device. It will sync when connected.",
    });
    void get().flush();
  },
  async flush(retry = false) {
    const state = get();
    if (state.syncing) {
      flushRequested = true;
      retryRequested ||= retry;
      return;
    }
    if (!canFlush(state)) return;
    set({ syncing: true });
    try {
      // Each extra pass needs a new flush request made during the previous
      // pass (an enqueue or a received snapshot), never a failure, so a
      // persistently failing entry cannot spin this loop.
      do {
        flushRequested = false;
        await flushPass(state.namespace, state.backend!, retry);
        retry = retryRequested;
        retryRequested = false;
      } while (flushRequested && canFlush(get()));
      set({ queue: await local.readQueue(state.namespace) });
    } finally {
      set({ syncing: false });
    }
  },
  async discard(uuid) {
    const { namespace } = get();
    await local.removeOperation(namespace, uuid);
    set({ queue: await local.readQueue(namespace) });
  },
  async toggleFavorite(uuid) {
    const { snapshot, namespace, favorites } = get();
    if (!snapshot) return;
    const next = favorites.includes(uuid)
      ? favorites.filter((id) => id !== uuid)
      : [...favorites, uuid];
    await local.saveFavorites(namespace + ":" + snapshot.user.id, next);
    set({ favorites: next });
  },
  async signOutLocal() {
    const { namespace } = get();
    await local.clearSnapshot(namespace);
    // The outbox stays (entries are tied to their author and sync after the
    // same user signs in again); unsent form drafts and kept manuals do not.
    clearDeviceDrafts(namespace);
    await removeAllKeptManuals(namespace);
    set({ snapshot: null, blocked: true, favorites: [] });
  },
}));
async function flushPass(namespace: string, backend: Backend, retry: boolean) {
  const { getState: get, setState: set } = useWorkspace;
  for (const entry of await local.readQueue(namespace)) {
    if (
      !get().online ||
      !get().connected ||
      get().snapshot?.user.id !== entry.operation.authorId ||
      entry.operation.programUuid !== get().snapshot?.activeProgramUuid
    )
      continue;
    if (entry.error && !retry) continue;
    try {
      const result = await backend.submit(entry.operation);
      await local.removeOperation(namespace, entry.operation.uuid);
      set({
        notice:
          result.status === "review"
            ? "Entry synced and held for administrator review. Aircraft totals are unchanged."
            : "Entry synchronized successfully.",
      });
    } catch (error) {
      if (!permanentSyncError(error)) continue;
      await local.persistOperation(namespace, {
        ...entry,
        error:
          error instanceof ConvexError && typeof error.data === "string"
            ? error.data
            : error instanceof Error
              ? error.message
              : "Sync failed. Your entry is preserved.",
      });
    }
  }
}
/** Local demo only: preview the read-only owner portal as a sample owner. */
export async function previewDemoOwner(owner: boolean) {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Owner preview is available in the demo.");
  const all =
    (await local.readSnapshot(current.namespace + ":all")) ?? current.snapshot!;
  const next = withDemoUser(all, owner);
  await local.saveSnapshot(current.namespace + ":all", next);
  await current.receive(scopedSnapshot(next));
}
/** Local demo only: restart the offline window. Demo changes rebuild the
 * workspace from the full snapshot, so renew that one too. */
export async function renewDemoAccess() {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Renewal is available in the demo.");
  const all =
    (await local.readSnapshot(current.namespace + ":all")) ?? current.snapshot!;
  const next = { ...all, authenticatedAt: Date.now() };
  await local.saveSnapshot(current.namespace + ":all", next);
  await current.receive(scopedSnapshot(next));
}
