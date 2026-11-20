/**
 * Responsibility: The workspace store: the scoped snapshot every screen reads,
 *   the device outbox of offline flights and problem reports, the queue of
 *   logbook page photos waiting on them, and their sync.
 * Layer: Data. Zustand store over IndexedDB and the Backend; no UI.
 * Dependencies: zustand, convex/values, src/data (local, backend, demo,
 *   demoBackend, deviceManuals, errors, logbookPhotos), src/domain (model,
 *   programs, flights, flightChecklistLink, flightPlans, flightSubmission,
 *   aircraftStatus, aircraftFiles, rejection).
 *
 * Only flights and problem reports queue offline; every other write needs a
 * connection. A logbook page photo is the one exception: it waits on the
 * device until its flight has synced, then uploads. The client checks in
 * enqueue() and attachLogbookPhoto() are a convenience: the server checks
 * each entry again when it syncs.
 */
import { validateChecklistFlight } from "../domain/flightChecklistLink";
import { validatePlanFlight } from "../domain/flightPlans";
import { aircraftAfterPendingFlights } from "../domain/flightSubmission";
import { scopedSnapshot } from "../domain/programs";
import { create } from "zustand";
import { ConvexError } from "convex/values";
import type { Operation, QueuedOperation, Snapshot } from "../domain/model";
import { can, localDate, offlineValid } from "../domain/model";
import { dispatchGate, groundedDuringFlight } from "../domain/aircraftStatus";
import { validateFlight } from "../domain/flights";
import {
  assertAircraftFileWriter,
  hasAircraftFileTarget,
  validateLogbookPhoto,
  type AircraftFileLink,
} from "../domain/aircraftFiles";
import { Rejection } from "../domain/rejection";
import * as local from "./local";
import {
  pendingPhotoFile,
  pendingPhotoKey,
  pendingPhotoReady,
  relinkPendingPhoto,
  type PendingLogbookPhoto,
} from "./logbookPhotos";
import { reconcileKeptManuals, removeAllKeptManuals } from "./deviceManuals";
import { demoWorkspace, withDemoRole, type DemoRole } from "./demo";
import type { Backend } from "./backend";
import { demoBackend } from "./demoBackend";
import { CONVEX_FAILURE_PREFIX, errorText } from "./errors";

// The demo keeps its full fictional snapshot under this suffix of the
// namespace and shows the workspace a scoped copy, as the server would.
const DEMO_FULL_SUFFIX = ":all";
// Snapshots cached before Flight Program scoping lack this version and are
// not shown; the next snapshot from the server replaces them.
const PROGRAM_SCOPE_VERSION = 1;

/** The workspace state and actions the screens use, through useWorkspace. */
export interface Workspace {
  /** False until {@link Workspace.initialize} has read the device cache. */
  ready: boolean;
  /** The scoped snapshot shown; null before sign-in or after sign-out. */
  snapshot: Snapshot | null;
  /** This namespace's outbox, oldest first. */
  queue: QueuedOperation[];
  /** Logbook page photos waiting to upload, oldest first. */
  pendingPhotos: PendingLogbookPhoto[];
  /** The device-cache namespace: "demo", or "live:" and the deployment URL. */
  namespace: string;
  demo: boolean;
  online: boolean;
  connected: boolean;
  syncing: boolean;
  /** Set when the session ended or the user signed out; nothing may queue. */
  blocked: boolean;
  error: string;
  notice: string;
  favorites: string[];
  backend: Backend | null;
  /**
   * Opens a namespace from the device cache: its snapshot and outbox. The
   * demo opens its full snapshot (else the cached one, else a fresh demo)
   * and scopes it. Sets
   * `error` to "Persistent storage is unavailable. Enable browser storage
   * before adding offline entries." when IndexedDB fails.
   *
   * @param namespace - The device-cache namespace.
   * @param demo - Whether this is the demo, which uses the demo backend.
   */
  initialize(namespace: string, demo: boolean): Promise<void>;
  /**
   * Shows and caches a snapshot from the server, then reconciles kept manuals
   * and flushes. Null means the session ended: the cached snapshot and kept
   * manuals are removed and the workspace is blocked. A call that finishes
   * after a newer one started is dropped.
   *
   * @param snapshot - The new snapshot, or null when signed out.
   */
  receive(snapshot: Snapshot | null): Promise<void>;
  /**
   * Records the browser's and the backend's connection; flushes once both
   * are up.
   *
   * @param online - Whether the browser reports a network.
   * @param connected - Whether the backend connection is open.
   */
  setConnection(online: boolean, connected: boolean): void;
  /**
   * Saves a flight or problem report on the device, stamped with the active
   * program, then tries to sync it.
   *
   * @param operation - The entry, written by the signed-in user.
   * @throws {Error} "Your offline access expired. Reconnect and sign in;
   *   pending entries are preserved."; "Account does not match this
   *   entry."; "You cannot add entries for this aircraft."; for a flight
   *   linked to a plan with a queued flight, "This plan has a failed flight
   *   entry. Discard it in the Sync center before logging the flight
   *   again." or "This plan already has a flight pending synchronization.";
   *   and as validateFlight, validateChecklistFlight, dispatchGate and
   *   validatePlanFlight.
   */
  enqueue(operation: Operation): Promise<void>;
  /**
   * Attaches a photo of the paper logbook line or signed page to a flight or
   * work order on the aircraft. Connected, with the record already synced,
   * the photo uploads at once; otherwise it is kept on this device and
   * uploads on a later flush, once the record is in the snapshot.
   *
   * @param target - The aircraft and the flight or work order.
   * @param file - The photo.
   * @throws {Error} "Your offline access expired. Reconnect and sign in;
   *   pending entries are preserved."; as validateLogbookPhoto and
   *   assertAircraftFileWriter; and, when uploading at once, as
   *   `backend.uploadAircraftFile`.
   */
  attachLogbookPhoto(
    target: { aircraftUuid: string } & AircraftFileLink,
    file: File,
  ): Promise<void>;
  /**
   * Sends the signed-in author's entries for the active program, one at a
   * time, while connected and within the offline window, then the author's
   * queued photos whose flight or work order is in the snapshot. A server
   * rejection is kept on the entry or photo for the Sync center, as errorText
   * words it; other failures are retried on the next flush. A flush requested
   * while one runs adds one more pass.
   *
   * @param retry - Also resend entries and photos holding a rejection.
   */
  flush(retry?: boolean): Promise<void>;
  /**
   * Deletes an outbox entry from the device without sending it.
   *
   * @param uuid - The entry's operation uuid.
   */
  discard(uuid: string): Promise<void>;
  /**
   * Deletes a queued photo from the device without uploading it.
   *
   * @param key - The photo's key.
   */
  discardPhoto(key: string): Promise<void>;
  /**
   * Replaces a failed outbox entry with an edited one (Edit and retry): the
   * old entry is discarded, then the new one is queued as
   * {@link Workspace.enqueue} does, under its own request id. If queuing is
   * refused, the old entry is put back with its error, so nothing recorded on
   * the device is lost. Logbook page photos waiting on a replaced flight move
   * to the new one.
   *
   * @param uuid - The entry to replace.
   * @param operation - The edited entry, with a new uuid.
   * @throws As {@link Workspace.enqueue}.
   */
  replace(uuid: string, operation: Operation): Promise<void>;
  /**
   * Adds or removes a favorite aircraft, kept per user on this device; does
   * nothing without a snapshot.
   *
   * @param uuid - The aircraft's uuid.
   */
  toggleFavorite(uuid: string): Promise<void>;
  /**
   * Signs out on this device: blocks the workspace, then deletes what the
   * device keeps for the signed-in user (the cached snapshot, the outbox
   * entries and queued photos they recorded, favorites, read-alert lists),
   * every unsent form draft and kept manual for the namespace. Other people's
   * unsynced entries and photos stay, and so do device settings such as the
   * theme. Callers confirm with the user first when anything has not synced
   * (unsyncedItems in src/data/pendingEntries.ts): it cannot be recovered.
   */
  signOutLocal(): Promise<void>;
}

/**
 * Whether a sync failure is a server rejection that will fail again if
 * resent: a ConvexError, or any error the Convex client reports as
 * "[CONVEX M(...)] ...". Anything else (a dropped connection, a timeout, a
 * client-side failure) is retried automatically.
 *
 * @param error - The failure from `backend.submit`.
 * @returns True for a permanent rejection.
 */
export function permanentSyncError(error: unknown) {
  return (
    error instanceof ConvexError ||
    (error instanceof Error && error.message.startsWith(CONVEX_FAILURE_PREFIX))
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
// Unsent form drafts, kept per namespace under these localStorage prefixes by
// the guided-flight, flight-session, checklist and aircraft-setup screens;
// cleared on sign-out.
const DRAFT_PREFIXES = [
  "angel-one-guided:",
  "angel-one-flight-sessions:",
  "angel-one-checks:",
  "angel-one-setup:",
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
      DRAFT_PREFIXES.some((prefix) => key.startsWith(prefix + namespace + ":"))
    )
      localStorage.removeItem(key);
}
/**
 * The app's one workspace store. Writes other than outbox entries go through
 * `backend` methods; the store itself only caches what the server sends.
 */
export const useWorkspace = create<Workspace>((set, get) => ({
  ready: false,
  snapshot: null,
  queue: [],
  pendingPhotos: [],
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
      pendingPhotos: [],
      namespace,
      demo,
      blocked: false,
      error: "",
      notice: "",
    });
    try {
      const opened = await readDeviceWorkspace(namespace, demo);
      set({
        namespace,
        demo,
        ...opened,
        ready: true,
        connected: demo && navigator.onLine,
        backend: demo ? demoBackend(useWorkspace) : get().backend,
      });
      if (opened.snapshot)
        void reconcileKeptManuals(namespace, opened.snapshot);
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
        (await local.readFavorites(
          local.favoritesKey(namespace, snapshot.user.id),
        )) ?? [];
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
    assertEntryAllowed(snapshot, operation);
    if (operation.kind === "flight") {
      assertFlightEntry(snapshot, operation, get().queue);
      operation = chainAfterPendingFlights(snapshot, operation, get().queue);
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
  async attachLogbookPhoto(target, file) {
    const state = get();
    const { snapshot, namespace } = state;
    if (!snapshot || state.blocked || !offlineValid(snapshot))
      throw new Error(
        "Your offline access expired. Reconnect and sign in; pending entries are preserved.",
      );
    validateLogbookPhoto(file.name, file.type, file.size);
    assertAircraftFileWriter(snapshot, target.aircraftUuid, target.linkedKind);
    const link = {
      linkedKind: target.linkedKind,
      linkedUuid: target.linkedUuid,
    };
    if (
      canFlush(state) &&
      hasAircraftFileTarget(snapshot, target.aircraftUuid, link)
    ) {
      await state.backend!.uploadAircraftFile(
        target.aircraftUuid,
        "logbook-page",
        file,
        link,
      );
      set({ notice: "Photo attached." });
      return;
    }
    await local.savePendingPhoto(
      namespace,
      buildPendingPhoto(snapshot, target, file),
    );
    set({
      pendingPhotos: await local.readPendingPhotos(namespace),
      notice:
        "Photo saved on this device. It will upload once the record has synced.",
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
        await flushPhotos(state.namespace, state.backend!, retry);
        retry = retryRequested;
        retryRequested = false;
      } while (flushRequested && canFlush(get()));
      set({
        queue: await local.readQueue(state.namespace),
        pendingPhotos: await local.readPendingPhotos(state.namespace),
      });
    } finally {
      set({ syncing: false });
    }
  },
  async discard(uuid) {
    const { namespace } = get();
    await local.removeOperation(namespace, uuid);
    set({ queue: await local.readQueue(namespace) });
  },
  async discardPhoto(key) {
    const { namespace } = get();
    await local.removePendingPhoto(namespace, key);
    set({ pendingPhotos: await local.readPendingPhotos(namespace) });
  },
  async replace(uuid, operation) {
    const { namespace, queue, discard, enqueue } = get();
    const previous = queue.find((q) => q.operation.uuid === uuid);
    await discard(uuid);
    try {
      await enqueue(operation);
    } catch (error) {
      if (previous) {
        await local.persistOperation(namespace, previous);
        set({ queue: await local.readQueue(namespace) });
      }
      throw error;
    }
    if (!(await movePendingPhotos(namespace, uuid, operation))) return;
    set({ pendingPhotos: await local.readPendingPhotos(namespace) });
    // enqueue's flush may already be past its photo pass.
    void get().flush();
  },
  async toggleFavorite(uuid) {
    const { snapshot, namespace, favorites } = get();
    if (!snapshot) return;
    const next = favorites.includes(uuid)
      ? favorites.filter((id) => id !== uuid)
      : [...favorites, uuid];
    await local.saveFavorites(
      local.favoritesKey(namespace, snapshot.user.id),
      next,
    );
    set({ favorites: next });
  },
  async signOutLocal() {
    const { namespace, snapshot } = get();
    // Blocked first, so no entry is queued or sent while the device is
    // cleared, and a refusal arriving afterwards is not stored again.
    set({ blocked: true });
    if (snapshot) await local.clearUserData(namespace, snapshot.user.id);
    else await local.clearSnapshot(namespace);
    clearDeviceDrafts(namespace);
    await removeAllKeptManuals(namespace);
    set({
      snapshot: null,
      favorites: [],
      queue: await local.readQueue(namespace),
      pendingPhotos: await local.readPendingPhotos(namespace),
    });
  },
}));
async function flushPass(namespace: string, backend: Backend, retry: boolean) {
  const { getState: get } = useWorkspace;
  for (const entry of await local.readQueue(namespace)) {
    if (
      !get().online ||
      !get().connected ||
      get().snapshot?.user.id !== entry.operation.authorId ||
      entry.operation.programUuid !== get().snapshot?.activeProgramUuid
    )
      continue;
    if (entry.error && !retry) continue;
    await submitEntry(namespace, backend, entry);
  }
}

// A permanent refusal stays in the outbox with its text; any other failure
// is retried on the next flush. After sign-out nothing is stored again: the
// user chose to delete the entry, and a session that ended keeps it as it
// was.
async function submitEntry(
  namespace: string,
  backend: Backend,
  entry: QueuedOperation,
) {
  try {
    const result = await backend.submit(entry.operation);
    await local.removeOperation(namespace, entry.operation.uuid);
    useWorkspace.setState({
      notice:
        result.status === "review"
          ? "Entry synced and held for administrator review. Aircraft totals are unchanged."
          : "Entry synchronized successfully.",
    });
  } catch (error) {
    if (!permanentSyncError(error) || useWorkspace.getState().blocked) return;
    await local.persistOperation(namespace, {
      ...entry,
      error: errorText(error),
    });
  }
}
// The device copy a namespace opens with. The demo rebuilds its scoped view
// from the full fictional snapshot and saves both before the workspace shows,
// so once it renders no startup write is still pending that could overwrite
// a newer one. A live copy cached under another program scope format is
// dropped.
async function readDeviceWorkspace(namespace: string, demo: boolean) {
  const [cached, queue, pendingPhotos] = await Promise.all([
    local.readSnapshot(namespace),
    local.readQueue(namespace),
    local.readPendingPhotos(namespace),
  ]);
  const snapshot = demo
    ? await openDemoSnapshot(namespace, cached)
    : cached?.programScopeVersion === PROGRAM_SCOPE_VERSION
      ? cached
      : null;
  const favorites = snapshot
    ? ((await local.readFavorites(
        local.favoritesKey(namespace, snapshot.user.id),
      )) ?? [])
    : [];
  return { snapshot, queue, pendingPhotos, favorites };
}

async function openDemoSnapshot(
  namespace: string,
  cached: Snapshot | undefined,
): Promise<Snapshot> {
  const full =
    (await local.readSnapshot(namespace + DEMO_FULL_SUFFIX)) ??
    cached ??
    demoWorkspace();
  if (cached?.user.id === full.user.id)
    full.authenticatedAt = cached.authenticatedAt;
  const snapshot = scopedSnapshot(full);
  await local.saveSnapshot(namespace + DEMO_FULL_SUFFIX, full);
  await local.saveSnapshot(namespace, snapshot);
  return snapshot;
}

function assertEntryAllowed(snapshot: Snapshot, operation: Operation) {
  if (operation.authorId !== snapshot.user.id)
    throw new Error("Account does not match this entry.");
  const flight = operation.kind === "flight";
  const aircraftUuid = flight
    ? operation.input.aircraftUuid
    : operation.aircraftUuid;
  if (!can(snapshot, aircraftUuid, flight ? "flight" : "discrepancy"))
    throw new Error("You cannot add entries for this aircraft.");
}

// Checks the server's submitOperation makes too, refused here before the
// flight waits in the outbox.
function assertFlightEntry(
  snapshot: Snapshot,
  operation: FlightEntry,
  queue: QueuedOperation[],
) {
  const { input } = operation;
  validateFlight(
    snapshot.aircraft.find((a) => a.uuid === input.aircraftUuid)!,
    input,
  );
  validateChecklistFlight(snapshot, input);
  assertDispatchable(snapshot, operation);
  if (!input.flightPlanUuid) return;
  validatePlanFlight(snapshot, input);
  assertPlanFree(queue, input.flightPlanUuid);
}

// A flight the aircraft was grounded after it began is queued: the server
// holds it for review, as it would refuse one grounded before it began.
function assertDispatchable(snapshot: Snapshot, operation: FlightEntry) {
  const { aircraftUuid, startTime } = operation.input;
  const today = localDate();
  if (
    operation.dispatchOverrideReason === undefined &&
    groundedDuringFlight(snapshot, aircraftUuid, startTime, today)
  )
    return;
  dispatchGate(snapshot, aircraftUuid, operation.dispatchOverrideReason, today);
}

// A failed entry still blocks: it can be retried, and letting a second
// flight queue beside it risks logging the plan twice.
function assertPlanFree(queue: QueuedOperation[], planUuid: string) {
  const pending = queue.find(
    (q) =>
      q.operation.kind === "flight" &&
      q.operation.input.flightPlanUuid === planUuid,
  );
  if (pending?.error)
    throw new Error(
      "This plan has a failed flight entry. Discard it in the Sync center before logging the flight again.",
    );
  if (pending)
    throw new Error("This plan already has a flight pending synchronization.");
}

type FlightEntry = Extract<Operation, { kind: "flight" }>;

// A leg started from the stored aircraft while this user's earlier legs on it
// wait in the outbox takes the version they will leave, so the server accepts
// the legs in order (decision D7). A form that opened on other readings keeps
// its version, and the server holds it as before.
function chainAfterPendingFlights(
  snapshot: Snapshot,
  operation: FlightEntry,
  queue: QueuedOperation[],
): FlightEntry {
  const { aircraftUuid } = operation.input;
  const stored = snapshot.aircraft.find((a) => a.uuid === aircraftUuid);
  if (operation.baseVersion !== stored?.version) return operation;
  const pending = queue.map((q) => q.operation);
  const after = aircraftAfterPendingFlights(snapshot, aircraftUuid, pending);
  return { ...operation, baseVersion: after?.version ?? stored.version };
}

function buildPendingPhoto(
  snapshot: Snapshot,
  target: { aircraftUuid: string } & AircraftFileLink,
  file: File,
): PendingLogbookPhoto {
  const link = { linkedKind: target.linkedKind, linkedUuid: target.linkedUuid };
  return {
    key: pendingPhotoKey(link, crypto.randomUUID()),
    aircraftUuid: target.aircraftUuid,
    ...link,
    authorId: snapshot.user.id,
    programUuid: snapshot.activeProgramUuid,
    name: file.name,
    type: file.type,
    size: file.size,
    queuedAt: Date.now(),
    blob: file,
  };
}
// When a failed flight entry is replaced, its queued photos follow the new
// entry. Without this, a photo of the failed flight would name a record that
// never reaches the server, and the Sync center could only offer to discard
// it. The new copy is saved before the old one goes, so a crash loses no
// photo.
async function movePendingPhotos(
  namespace: string,
  from: string,
  operation: Operation,
): Promise<boolean> {
  if (operation.kind !== "flight" || operation.uuid === from) return false;
  const flight = {
    uuid: operation.uuid,
    aircraftUuid: operation.input.aircraftUuid,
  };
  const photos = (await local.readPendingPhotos(namespace)).filter(
    (p) => p.linkedKind === "flight" && p.linkedUuid === from,
  );
  for (const photo of photos) {
    await local.savePendingPhoto(namespace, relinkPendingPhoto(photo, flight));
    await local.removePendingPhoto(namespace, photo.key);
  }
  return photos.length > 0;
}

// A photo waits until its flight or work order is in the snapshot: the
// server can file it only against a record it holds.
async function flushPhotos(
  namespace: string,
  backend: Backend,
  retry: boolean,
) {
  const { getState: get } = useWorkspace;
  for (const photo of await local.readPendingPhotos(namespace)) {
    const snapshot = get().snapshot;
    if (!get().online || !get().connected || !snapshot) continue;
    if (!pendingPhotoReady(photo, snapshot)) continue;
    if (photo.error && !retry) continue;
    await uploadPhoto(namespace, backend, photo);
  }
}

// A domain Rejection counts as permanent like a ConvexError: the demo adapter
// throws it as is. Blocked, the photo is left as submitEntry leaves entries.
async function uploadPhoto(
  namespace: string,
  backend: Backend,
  photo: PendingLogbookPhoto,
) {
  try {
    await backend.uploadAircraftFile(
      photo.aircraftUuid,
      "logbook-page",
      pendingPhotoFile(photo),
      { linkedKind: photo.linkedKind, linkedUuid: photo.linkedUuid },
    );
    await local.removePendingPhoto(namespace, photo.key);
    useWorkspace.setState({ notice: "Logbook page photo uploaded." });
  } catch (error) {
    if (!permanentSyncError(error) && !(error instanceof Rejection)) return;
    if (useWorkspace.getState().blocked) return;
    await local.savePendingPhoto(namespace, {
      ...photo,
      error: errorText(error),
    });
  }
}
/**
 * Demo only: switches the demo user to a sample aircraft owner, to preview
 * the read-only owner portal, or back.
 *
 * @param owner - True to view as the owner, false to return.
 * @throws {Error} "Owner preview is available in the demo." outside the demo.
 */
export async function previewDemoOwner(owner: boolean) {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Owner preview is available in the demo.");
  await previewDemoRole(current, owner ? "owner" : "admin");
}

/**
 * Demo only: switches the demo user to a sample board member, to preview the
 * read-only board view, or back.
 *
 * @param board - True to view as the board member, false to return.
 * @throws {Error} "Board preview is available in the demo." outside the demo.
 */
export async function previewDemoBoard(board: boolean) {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Board preview is available in the demo.");
  await previewDemoRole(current, board ? "board" : "admin");
}

// Rebuilds the full demo snapshot as that account and shows its scoped view.
async function previewDemoRole(current: Workspace, role: DemoRole) {
  const all =
    (await local.readSnapshot(current.namespace + DEMO_FULL_SUFFIX)) ??
    current.snapshot!;
  const next = withDemoRole(all, role);
  await local.saveSnapshot(current.namespace + DEMO_FULL_SUFFIX, next);
  await current.receive(scopedSnapshot(next));
}
/**
 * Demo only: restarts the offline window. Demo changes rebuild the workspace
 * from the full snapshot, so that one is renewed too.
 *
 * @throws {Error} "Renewal is available in the demo." outside the demo.
 */
export async function renewDemoAccess() {
  const current = useWorkspace.getState();
  if (!current.demo) throw new Error("Renewal is available in the demo.");
  const all =
    (await local.readSnapshot(current.namespace + DEMO_FULL_SUFFIX)) ??
    current.snapshot!;
  const next = { ...all, authenticatedAt: Date.now() };
  await local.saveSnapshot(current.namespace + DEMO_FULL_SUFFIX, next);
  await current.receive(scopedSnapshot(next));
}
