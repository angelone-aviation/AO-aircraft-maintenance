/**
 * Responsibility: Asks before a sign-out deletes work that has not reached
 *   the server, so the user can stay signed in and sync it instead.
 * Layer: UI. React hook and dialog over the workspace store; no rules.
 * Dependencies: react, src/data (store, pendingEntries), ./design.tsx.
 */
import { useState, type ReactNode } from "react";
import { useWorkspace } from "../data/store";
import { unsyncedItems } from "../data/pendingEntries";
import { Dialog } from "./design";

/** A user's outbox entries and queued photos that have not synced. */
type Unsynced = ReturnType<typeof unsyncedItems>;

/**
 * The warning's title for a user's unsynced work.
 *
 * @param items - Their unsynced entries and photos; at least one in all.
 * @returns For example "1 entry hasn't synced" or "2 entries and 1 photo
 *   haven't synced".
 */
export function unsyncedTitle({ entries, photos }: Unsynced): string {
  const parts = [
    entries ? `${entries} ${entries === 1 ? "entry" : "entries"}` : "",
    photos ? `${photos} ${photos === 1 ? "photo" : "photos"}` : "",
  ].filter(Boolean);
  return `${parts.join(" and ")} ${entries + photos === 1 ? "hasn't" : "haven't"} synced`;
}

/**
 * Wraps a sign-out so that, while the signed-in user has entries or photos
 * that have not synced, it first warns that signing out deletes them. Only
 * "Delete and sign out" goes on; "Stay signed in", Escape and the close
 * button keep the user signed in.
 *
 * @param signOut - Signs out, clearing this device (Workspace.signOutLocal).
 * @returns `request`, to call in place of `signOut`, and `dialog`, to render;
 *   null while not asking.
 */
export function useConfirmedSignOut(signOut: () => void): {
  request: () => void;
  dialog: ReactNode;
} {
  const [asking, setAsking] = useState<Unsynced | null>(null);
  const request = () => {
    const items = currentUnsynced();
    if (items.entries + items.photos > 0) setAsking(items);
    else signOut();
  };
  const dialog = asking && (
    <SignOutDialog
      items={asking}
      onStay={() => setAsking(null)}
      onSignOut={signOut}
    />
  );
  return { request, dialog };
}

/**
 * The warning shown before a sign-out that would delete unsynced work.
 *
 * @param props.items - The user's unsynced entries and photos.
 * @param props.onStay - Closes the warning; nothing is deleted.
 * @param props.onSignOut - Signs out and deletes them; both buttons are then
 *   disabled while the sign-out runs.
 */
export function SignOutDialog(props: {
  items: Unsynced;
  onStay: () => void;
  onSignOut: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [them, they] =
    props.items.entries + props.items.photos === 1
      ? ["it", "It has"]
      : ["them", "They have"];
  const leave = () => {
    setLeaving(true);
    props.onSignOut();
  };
  return (
    <Dialog
      title={unsyncedTitle(props.items)}
      size="narrow"
      dismissOnScrim={false}
      onClose={props.onStay}
      footer={<SignOutActions leaving={leaving} {...props} onLeave={leave} />}
    >
      <p>
        Signing out deletes {them} from this device. {they} not reached the
        server and cannot be recovered.
      </p>
      <p>Stay signed in to sync {them} when you are connected.</p>
    </Dialog>
  );
}

function SignOutActions(props: {
  leaving: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="button primary"
        disabled={props.leaving}
        onClick={props.onStay}
      >
        Stay signed in
      </button>
      <button
        type="button"
        className="button danger"
        disabled={props.leaving}
        onClick={props.onLeave}
      >
        Delete and sign out
      </button>
    </>
  );
}

// Read when the user asks to sign out, not subscribed: the warning states
// what was waiting at that moment.
function currentUnsynced(): Unsynced {
  const { snapshot, queue, pendingPhotos } = useWorkspace.getState();
  if (!snapshot) return { entries: 0, photos: 0 };
  return unsyncedItems(queue, pendingPhotos, snapshot.user.id);
}
