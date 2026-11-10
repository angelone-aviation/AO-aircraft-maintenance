/**
 * Responsibility: One aircraft's setup session in this browser: the draft
 *   kept in localStorage and the single commit that saves its rows.
 * Layer: Data. Module state and localStorage; no React, no network of its
 *   own (the caller supplies how a row is sent).
 * Dependencies: src/domain/aircraftSetup.ts, ./errors.
 *
 * The commit lives here, not in the screen, because it outlives the step that
 * started it: a second start while one runs would save every row the first
 * has not reached twice, each with a new record id the server cannot match.
 */
import {
  setupDraftSchema,
  type SetupAction,
  type SetupDraft,
} from "../domain/aircraftSetup";
import { errorText } from "./errors";

/** A commit of one plan: where it stands, and why it stopped. */
export interface SetupRun {
  /** The plan as it was when the commit started; a retry resends these. */
  actions: SetupAction[];
  /** Keys of the actions saved so far. */
  saved: string[];
  /** Keys of actions not sent because their record was already there. */
  onRecord: string[];
  /** The row the commit stopped at, with the message to show. */
  failure?: { key: string; message: string };
  /** True while rows are still being sent. */
  busy: boolean;
}

/** What the wizard shows for one aircraft: its draft and its commit. */
export interface SetupSession {
  draft: SetupDraft;
  /** Why the draft cannot be kept between visits, or "". */
  storageError: string;
  run?: SetupRun;
}

/** How a commit reaches the records; supplied by the screen. */
export interface SetupCommitPorts {
  /** Sends one action's command; rejects with the refusal to show. */
  send: (action: SetupAction) => Promise<unknown>;
  /** Whether the action's record is on the aircraft now. */
  onRecord: (action: SetupAction) => boolean;
}

const EMPTY_DRAFT: SetupDraft = { inspectionCsv: "", adCsv: "", done: [] };
const STORAGE_BLOCKED =
  "Browser storage failed, so this setup cannot be resumed after leaving the page. Finish it in this visit.";
const DRAFT_UNREADABLE =
  "The saved setup draft could not be loaded. Rows it had already saved are skipped as duplicates in the review.";

const sessions = new Map<string, SetupSession>();
const listeners = new Set<() => void>();

/**
 * Opens an aircraft's session for a visit to the wizard: reloads the draft
 * from storage (sign-out clears it there), and keeps the last commit's result
 * only while the draft it belongs to is unchanged. A running commit is never
 * disturbed.
 *
 * @param key - The session's storage key: one per namespace and aircraft.
 */
export function openSetupSession(key: string): void {
  const current = sessions.get(key);
  if (current?.run?.busy) return;
  const loaded = loadDraft(key);
  const unchanged =
    current && JSON.stringify(current.draft) === JSON.stringify(loaded.draft);
  sessions.set(key, { ...loaded, run: unchanged ? current.run : undefined });
}

/**
 * The session as it stands.
 *
 * @param key - The session's storage key.
 * @returns The same object until the session changes, so it can back
 *   `useSyncExternalStore`.
 */
export function setupSession(key: string): SetupSession {
  if (!sessions.has(key)) openSetupSession(key);
  return sessions.get(key)!;
}

/**
 * Calls a listener after any session changes.
 *
 * @returns The function that stops the calls.
 */
export function subscribeSetupSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Replaces one or both template texts and stores the draft. The result of a
 * finished or failed commit is dropped, since it describes the old text.
 *
 * @param key - The session's storage key.
 * @param patch - The new text of either file.
 * @returns False, changing nothing, while a commit is running: its rows come
 *   from the text it started with.
 */
export function editSetupDraft(
  key: string,
  patch: Partial<Pick<SetupDraft, "inspectionCsv" | "adCsv">>,
): boolean {
  const session = setupSession(key);
  if (session.run?.busy) return false;
  const draft = { ...session.draft, ...patch };
  publish(key, { draft, storageError: persistDraft(key, draft) });
  return true;
}

/**
 * Forgets the draft and the last commit's result, here and in storage.
 *
 * @param key - The session's storage key.
 * @returns False, changing nothing, while a commit is running.
 */
export function forgetSetupDraft(key: string): boolean {
  if (setupSession(key).run?.busy) return false;
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clear when storage is blocked.
  }
  publish(key, { draft: EMPTY_DRAFT, storageError: "" });
  return true;
}

/**
 * Starts the commit of a plan: sends each action in order, records every
 * saved row's key in the draft, and stops at the first failure. An action
 * whose record is on the aircraft by the time it is reached is not sent.
 *
 * @param key - The session's storage key.
 * @param actions - The plan's actions; their request ids are kept for a
 *   retry.
 * @param ports - How a row is sent and checked.
 * @returns False, starting nothing, while a commit is already running for
 *   this aircraft.
 */
export function startSetupCommit(
  key: string,
  actions: SetupAction[],
  ports: SetupCommitPorts,
): boolean {
  const session = setupSession(key);
  if (session.run?.busy) return false;
  const run: SetupRun = { actions, saved: [], onRecord: [], busy: true };
  publish(key, { ...session, run });
  void sendActions(key, ports);
  return true;
}

/**
 * Resumes a failed commit from the row it stopped at, resending that row
 * with the request id it had, so a save the server already took is not
 * repeated.
 *
 * @param key - The session's storage key.
 * @param ports - How a row is sent and checked.
 * @returns False, starting nothing, unless the last commit failed.
 */
export function retrySetupCommit(key: string, ports: SetupCommitPorts) {
  const session = setupSession(key);
  if (!session.run?.failure || session.run.busy) return false;
  const run: SetupRun = { ...session.run, failure: undefined, busy: true };
  publish(key, { ...session, run });
  void sendActions(key, ports);
  return true;
}

// Reads the session afresh for every row: this loop outlives the render, and
// the wizard visit, that started it.
async function sendActions(key: string, ports: SetupCommitPorts) {
  for (const action of sessions.get(key)!.run!.actions) {
    const run = sessions.get(key)!.run!;
    if (run.saved.includes(action.key) || run.onRecord.includes(action.key))
      continue;
    if (ports.onRecord(action)) {
      patchRun(key, { onRecord: [...run.onRecord, action.key] });
      continue;
    }
    try {
      await ports.send(action);
    } catch (e) {
      const failure = { key: action.key, message: errorText(e) };
      patchRun(key, { busy: false, failure });
      return;
    }
    recordSaved(key, action.key);
  }
  patchRun(key, { busy: false });
}

function recordSaved(key: string, actionKey: string) {
  const session = sessions.get(key)!;
  const done = [...new Set([...session.draft.done, actionKey])];
  const draft = { ...session.draft, done };
  const run = { ...session.run!, saved: [...session.run!.saved, actionKey] };
  publish(key, { draft, storageError: persistDraft(key, draft), run });
}

function patchRun(key: string, patch: Partial<SetupRun>) {
  const session = sessions.get(key)!;
  publish(key, { ...session, run: { ...session.run!, ...patch } });
}

function publish(key: string, session: SetupSession) {
  sessions.set(key, session);
  for (const listener of listeners) listener();
}

// Returns the storage error to show, or "" once the draft is stored.
function persistDraft(key: string, draft: SetupDraft): string {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
    return "";
  } catch {
    // Blocked or full storage: the draft stays on screen for this visit.
    return STORAGE_BLOCKED;
  }
}

function loadDraft(key: string): Pick<SetupSession, "draft" | "storageError"> {
  try {
    const raw = localStorage.getItem(key);
    return {
      draft: raw ? setupDraftSchema.parse(JSON.parse(raw)) : EMPTY_DRAFT,
      storageError: "",
    };
  } catch {
    // Blocked storage or a draft of another shape: start empty and say so,
    // since rows the lost draft recorded as saved are only found by the
    // review's duplicate check.
    return { draft: EMPTY_DRAFT, storageError: DRAFT_UNREADABLE };
  }
}
