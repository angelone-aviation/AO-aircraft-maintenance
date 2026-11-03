import { useState } from "react";
import { localDate } from "../domain/model";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { faaRenewal } from "../domain/faaCredential";
import { Field, Modal } from "./ui";
export function FaaRenewalAlert() {
  const status = useWorkspace((s) => s.snapshot?.faaCredential);
  const systemAdmin = useWorkspace((s) => !!s.snapshot?.user.isAdmin);
  if (!status) return null;
  const reminder = faaRenewal(status);
  // The key is updated in Settings → System, which only system
  // administrators see; everyone else keeps the read-only status on the
  // Airworthiness page.
  return reminder.warning ? (
    <p role="alert" className="callout">
      {reminder.message}{" "}
      {systemAdmin ? (
        <Link to="/settings" hash="system">
          FAA key settings
        </Link>
      ) : (
        <Link to="/airworthiness">FAA key settings</Link>
      )}
    </p>
  ) : null;
}
/** Shared FAA DRS key status and replacement. Settings → System nests it
 * under its own heading (level 3); the Airworthiness page shows it as h2. */
export function FaaKeySettings({ level = 2 }: { level?: 2 | 3 }) {
  const Heading = level === 3 ? "h3" : "h2";
  const { snapshot: s, backend, online, connected, demo } = useWorkspace();
  const [open, setOpen] = useState(false),
    [key, setKey] = useState(""),
    [expiresOn, setExpiry] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const status = s?.faaCredential;
  const reminder = faaRenewal(status);
  return (
    <section className="panel">
      <Heading>FAA API key and renewal</Heading>
      <p role={reminder.warning ? "alert" : undefined}>{reminder.message}</p>
      <p>
        Renewal reminders appear here and on the overview starting 60 days
        before expiry. FAA renewal is completed on the FAA website; then enter
        the replacement key and its new expiration date below.
      </p>
      <a href="https://drs.faa.gov/drs-api" target="_blank" rel="noreferrer">
        Request / renew key at FAA
      </a>
      {s?.user.isAdmin ? (
        <button
          type="button"
          className="button"
          disabled={demo || !online || !connected}
          onClick={() => {
            setOpen(true);
            setKey("");
            setExpiry("");
            setError("");
          }}
        >
          Update FAA API key
        </button>
      ) : (
        <p>An administrator can update the shared FAA key.</p>
      )}
      {demo && (
        <p>
          API keys can only be updated on the connected app, not in demo mode.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <Modal
          title="Update FAA API key"
          onClose={() => {
            if (!busy) {
              setOpen(false);
              setKey("");
            }
          }}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await backend!.updateFaaKey({
                  key,
                  expiresOn,
                  version: status?.version ?? 0,
                });
                setKey("");
                setOpen(false);
                setNotice(
                  "Replacement key verified with FAA and saved. Renewal reminder updated.",
                );
              } catch {
                setError(
                  "Unable to confirm the update. Check the key, future expiration date, connection, and administrator access. Refresh to check the saved expiration date before retrying.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>
              This updates the shared key used by all aircraft. The new key is
              verified with FAA before replacing the current one. Stored keys
              are never displayed or included in offline data.
            </p>
            <Field label="New FAA API key">
              <input
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
            <Field label="New FAA key expiration date">
              <input
                type="date"
                required
                min={localDate(Date.now() + 86400000)}
                value={expiresOn}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </Field>
            {error && <p role="alert">{error}</p>}
            <button className="button primary" disabled={busy}>
              {busy ? "Verifying with FAA…" : "Verify and save replacement"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
