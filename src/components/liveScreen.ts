/**
 * Responsibility: Decides which screen the live app shows: loading, sign-in,
 *   the workspace, or the page saying the workspace could not be opened.
 * Layer: UI. Pure decision over the connection, sign-in and query state; no
 *   React, no I/O.
 * Dependencies: src/domain/model.ts (Snapshot type).
 */
import type { Snapshot } from "../domain/model";

/** A screen of the live (not demo) app. */
export type LiveScreen = "loading" | "workspace" | "sign-in" | "unavailable";

/** What the live root knows when it picks a screen. */
export interface LiveSession {
  /** False until the device cache has been read. */
  ready: boolean;
  /** The snapshot kept on this device, if any. */
  snapshot: Snapshot | null;
  online: boolean;
  socket: boolean;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * The server's snapshot: undefined until loaded or when the query failed,
   * null without an active account and session.
   */
  result: Snapshot | null | undefined;
  /** Set when the server could not run the snapshot query. */
  failure?: Error;
  /** The signed-in account, asked for only after a failure. */
  signedInUserId?: string | null;
}

/**
 * Picks the live app's screen. Offline, or with the socket down, the kept
 * copy opens the workspace and the access gate enforces the seven days.
 * Connected, the workspace opens only once the server's snapshot is for the
 * same user, so a kept copy never shows for a signed-out or different
 * account. When the snapshot query fails, the workspace-unavailable page shows
 * instead, unless the user chose to open the kept copy and it is theirs.
 *
 * @param session - The connection, sign-in and query state.
 * @param openKeptCopy - Whether the user chose the copy on this device.
 * @returns The screen to render.
 */
export function chooseLiveScreen(
  session: LiveSession,
  openKeptCopy = false,
): LiveScreen {
  const { ready, snapshot, isLoading, isAuthenticated, result } = session;
  const live = session.online && session.socket;
  if (!ready) return "loading";
  if (live && isAuthenticated && session.failure)
    return openKeptCopy && keptCopyIsTheirs(session)
      ? "workspace"
      : "unavailable";
  if (live && (isLoading || (isAuthenticated && result === undefined)))
    return "loading";
  if (
    snapshot &&
    (!live ||
      (isAuthenticated && result && snapshot.user.id === result.user.id))
  )
    return "workspace";
  return "sign-in";
}

/**
 * Tells whether the copy kept on this device may be offered after a failed
 * snapshot: it must belong to the account the server says is signed in.
 *
 * @param session - The live session, with `signedInUserId` once known.
 * @returns False while the account is unknown or the copy is someone else's.
 */
export function keptCopyIsTheirs(
  session: Pick<LiveSession, "snapshot" | "signedInUserId">,
): boolean {
  return (
    !!session.snapshot &&
    !!session.signedInUserId &&
    session.snapshot.user.id === session.signedInUserId
  );
}
