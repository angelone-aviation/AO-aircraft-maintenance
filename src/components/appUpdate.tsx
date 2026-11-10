/**
 * Responsibility: Offers a waiting app update and applies it on request.
 * Layer: UI. A notice component and the module state it reads; the service
 *   worker registration in src/main.tsx hands it the update.
 * Dependencies: react, @phosphor-icons/react.
 *
 * Kept apart from the workspace's one-line notice so a later notice (such as
 * "Entry saved") cannot replace the offer before the user acts on it.
 */
import { useState, useSyncExternalStore } from "react";
import { X } from "@phosphor-icons/react";

/** Activates the waiting service worker; the page then reloads itself. */
export type ApplyUpdate = () => Promise<void>;

// The registration reloads the page once the new worker takes control. If it
// never does (another tab already applied the update, so this page has no
// waiting worker to switch), reload anyway: the new worker serves the page.
const RELOAD_FALLBACK_MS = 4000;

let offered: ApplyUpdate | null = null;
const listeners = new Set<() => void>();

/**
 * Shows the update notice in the open workspace, replacing any earlier offer.
 *
 * @param apply - Activates the waiting worker (vite-plugin-pwa's
 *   `updateSW`).
 */
export function offerAppUpdate(apply: ApplyUpdate) {
  offered = apply;
  for (const listener of listeners) listener();
}

/**
 * The update notice: "A new version is ready. Save any open form first." with
 * a Reload now button that activates the waiting worker and reloads the page.
 * The warning stays because a reload discards input not yet saved.
 *
 * @returns The notice, or nothing while no update waits or after the user
 *   dismissed it.
 */
export function AppUpdateNotice() {
  const apply = useSyncExternalStore(subscribe, () => offered);
  const [reloading, setReloading] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (!apply || dismissed) return null;
  const reload = () => {
    setReloading(true);
    void apply().finally(() =>
      setTimeout(() => location.reload(), RELOAD_FALLBACK_MS),
    );
  };
  return (
    <div className="notice app-update" role="status">
      <span>A new version is ready. Save any open form first.</span>
      <span className="app-update-actions">
        <button
          type="button"
          className="button primary small"
          disabled={reloading}
          onClick={reload}
        >
          {reloading ? "Reloading…" : "Reload now"}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss update notice"
          onClick={() => setDismissed(true)}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </span>
    </div>
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
