/**
 * Responsibility: The shell's waiting-to-send line: how many of the user's
 *   entries wait in this device's outbox, whether the device is offline, and
 *   a link to the Sync center.
 * Layer: UI. React component over the workspace store; no business rules.
 * Dependencies: @tanstack/react-router, @phosphor-icons/react,
 *   src/data (store, pendingEntries), src/styles/outboxLine.css.
 */
import { Link } from "@tanstack/react-router";
import { CloudArrowUp } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { ownEntries } from "../data/pendingEntries";
import "../styles/outboxLine.css";

/**
 * The line's wording for a number of waiting entries.
 *
 * @param count - The user's entries in the outbox.
 * @param offline - Whether the device has no connection now.
 * @returns For example "1 entry waiting to send" or "3 entries waiting to
 *   send · Offline"; "" for none.
 */
export function waitingText(count: number, offline: boolean): string {
  if (count <= 0) return "";
  const entries = count === 1 ? "entry" : "entries";
  return `${count} ${entries} waiting to send${offline ? " · Offline" : ""}`;
}

/**
 * Shown under the top bar on every screen while the signed-in user has
 * entries waiting to send; empty otherwise.
 *
 * @returns A polite live region that stays mounted, so screen readers hear
 *   the line when it appears or its text changes, not on every render. It
 *   is aria-live rather than role="status", so it never competes with the
 *   app's one status notice.
 */
export function OutboxLine() {
  const userId = useWorkspace((x) => x.snapshot?.user.id);
  const queue = useWorkspace((x) => x.queue);
  const live = useWorkspace((x) => x.online && x.connected);
  const count = userId ? ownEntries(queue, userId).length : 0;
  const text = waitingText(count, !live);
  return (
    <div className={"outbox-line" + (text ? "" : " empty")}>
      {text && <CloudArrowUp size={18} weight="bold" aria-hidden="true" />}
      <span aria-live="polite" aria-atomic="true" className="outbox-line-text">
        {text}
      </span>
      {text && (
        <Link to="/sync" className="outbox-line-link">
          See entries
        </Link>
      )}
    </div>
  );
}
