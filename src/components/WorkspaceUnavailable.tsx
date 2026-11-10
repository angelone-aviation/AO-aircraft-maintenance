/**
 * Responsibility: The page shown when the server cannot load the workspace:
 *   what happened, that records are safe, whom to contact, and the way on.
 * Layer: UI. Content for the welcome card; the live root decides when it
 *   shows and what each button does.
 * Dependencies: src/data/store.ts (outbox), src/data/pendingEntries.ts,
 *   ./ui (download).
 */
import { useWorkspace } from "../data/store";
import { ownEntries, pendingEntriesFile } from "../data/pendingEntries";
import { download } from "./ui";

/** What the workspace-unavailable page shows and does. */
export interface WorkspaceUnavailableProps {
  /**
   * When the copy on this device was last synced; set only when that copy
   * belongs to the signed-in account and may be opened.
   */
  keptCopySyncedAt?: number;
  /** The signed-in account, for its pending entries; unset until known. */
  userId?: string | null;
  /** Asks the server for the workspace again. */
  onRetry: () => void;
  /** Opens the copy on this device, as offline mode does. */
  onOpenKeptCopy: () => void;
  onSignOut: () => void;
}

/**
 * Explains that the workspace could not be loaded, in place of a blank page.
 * Offers to try again, to open the copy on this device when it is the
 * account's own, to export the account's pending entries, and to sign out.
 *
 * @param props - See {@link WorkspaceUnavailableProps}.
 */
export function WorkspaceUnavailable(props: WorkspaceUnavailableProps) {
  const { queue } = useWorkspace();
  const { userId } = props;
  const pending = userId ? ownEntries(queue, userId) : [];
  return (
    <>
      <h1>Your workspace could not be opened.</h1>
      <p role="alert">
        The server could not load your Flight Program&apos;s records just now.
        Your records are safe: nothing was changed or lost, and entries saved on
        this device stay queued until the workspace opens.
      </p>
      <p>
        Try again in a few minutes. If this keeps happening, contact your Flight
        Program administrator and tell them when it started.
      </p>
      <button className="button primary" onClick={props.onRetry}>
        Try again
      </button>
      {props.keptCopySyncedAt !== undefined && (
        <KeptCopyChoice
          syncedAt={props.keptCopySyncedAt}
          onOpen={props.onOpenKeptCopy}
        />
      )}
      {userId && pending.length > 0 && (
        <button
          className="text-button"
          onClick={() => {
            const file = pendingEntriesFile(queue, userId);
            download(file.name, file.text);
          }}
        >
          Export my pending entries
        </button>
      )}
      <button className="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </>
  );
}

function KeptCopyChoice(props: { syncedAt: number; onOpen: () => void }) {
  const synced = new Date(props.syncedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <>
      <button className="button" onClick={props.onOpen}>
        View the copy on this device
      </button>
      <small>
        Last synced {synced}. Flights and problem reports you add wait on this
        device until the workspace opens; other changes need it open.
      </small>
    </>
  );
}
