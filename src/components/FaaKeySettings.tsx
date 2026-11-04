/**
 * Responsibility: The shared FAA DRS API key: its renewal reminders, and the
 *   form a system administrator uses to replace it.
 * Layer: UI. React components; they never see a stored key, only the status
 *   the snapshot carries.
 * Dependencies: @tanstack/react-router, src/data/store.ts,
 *   src/domain/faaCredential.ts, src/domain/model.ts, ./ui.tsx.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { faaRenewal } from "../domain/faaCredential";
import { localDate } from "../domain/model";
import { Field, Modal, errorText } from "./ui";

const DAY_MS = 86_400_000;

/**
 * The FAA key renewal warning, with a link to where the key is updated.
 *
 * @returns Nothing before the snapshot loads, or while a configured key
 *   expires more than 60 days from today.
 */
export function FaaRenewalAlert() {
  const status = useWorkspace((s) => s.snapshot?.faaCredential);
  const systemAdmin = useWorkspace((s) => !!s.snapshot?.user.isAdmin);
  if (!status) return null;
  const reminder = faaRenewal(status);
  if (!reminder.warning) return null;
  // The key is updated in Settings → System, which only system
  // administrators see; everyone else keeps the read-only status on the
  // Airworthiness page.
  return (
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
  );
}

/**
 * The FAA key panel: renewal status, where to renew, and for system
 * administrators a replacement form that the server checks with the FAA
 * before saving. Replacing is unavailable offline and in demo mode.
 *
 * @param props.level - The heading level: 3 when nested under a heading of
 *   its own (Settings → System), 2 by default (the Airworthiness page).
 */
export function FaaKeySettings({ level = 2 }: { level?: 2 | 3 }) {
  const Heading = level === 3 ? "h3" : "h2";
  const { snapshot: s, online, connected, demo } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const reminder = faaRenewal(s?.faaCredential);
  return (
    <section className="panel">
      <Heading>FAA API key and renewal</Heading>
      <p role={reminder.warning ? "alert" : undefined}>{reminder.message}</p>
      <RenewalHelp />
      <UpdateKeyButton
        systemAdmin={!!s?.user.isAdmin}
        disabled={demo || !online || !connected}
        onOpen={() => setOpen(true)}
      />
      {demo && (
        <p>
          API keys can only be updated on the connected app, not in demo mode.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <ReplaceKeyDialog
          version={s?.faaCredential?.version ?? 0}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            setNotice(
              "Replacement key verified with FAA and saved. Renewal reminder updated.",
            );
          }}
        />
      )}
    </section>
  );
}

function RenewalHelp() {
  return (
    <>
      <p>
        Renewal reminders appear here and on the overview starting 60 days
        before expiry. FAA renewal is completed on the FAA website; then enter
        the replacement key and its new expiration date below.
      </p>
      <a href="https://drs.faa.gov/drs-api" target="_blank" rel="noreferrer">
        Request / renew key at FAA
      </a>
    </>
  );
}

function UpdateKeyButton({
  systemAdmin,
  disabled,
  onOpen,
}: {
  systemAdmin: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  if (!systemAdmin)
    return <p>An administrator can update the shared FAA key.</p>;
  return (
    <button
      type="button"
      className="button"
      disabled={disabled}
      onClick={onOpen}
    >
      Update FAA API key
    </button>
  );
}

// Mounted only while open, so each opening starts empty, without an old error.
function ReplaceKeyDialog({
  version,
  onClose,
  onSaved,
}: {
  version: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [expiresOn, setExpiry] = useState("");
  const { busy, error, replace } = useKeyReplacement(onSaved);
  return (
    <Modal
      title="Update FAA API key"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void replace({ key, expiresOn, version });
        }}
      >
        <KeyFields
          apiKey={key}
          expiresOn={expiresOn}
          onKey={setKey}
          onExpiry={setExpiry}
        />
        {error && <p role="alert">{error}</p>}
        <button className="button primary" disabled={busy}>
          {busy ? "Verifying with FAA…" : "Verify and save replacement"}
        </button>
      </form>
    </Modal>
  );
}

function KeyFields({
  apiKey,
  expiresOn,
  onKey,
  onExpiry,
}: {
  apiKey: string;
  expiresOn: string;
  onKey: (key: string) => void;
  onExpiry: (date: string) => void;
}) {
  return (
    <>
      <p>
        This updates the shared key used by all aircraft. The new key is
        verified with FAA before replacing the current one. Stored keys are
        never displayed or included in offline data.
      </p>
      <Field label="New FAA API key">
        <input
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => onKey(e.target.value)}
        />
      </Field>
      <Field label="New FAA key expiration date">
        <input
          type="date"
          required
          min={localDate(Date.now() + DAY_MS)}
          value={expiresOn}
          onChange={(e) => onExpiry(e.target.value)}
        />
      </Field>
    </>
  );
}

function useKeyReplacement(onSaved: () => void) {
  const backend = useWorkspace((s) => s.backend);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function replace(input: {
    key: string;
    expiresOn: string;
    version: number;
  }) {
    setBusy(true);
    setError("");
    try {
      await backend!.updateFaaKey(input);
      onSaved();
    } catch (error) {
      // A refusal shows the server's reason; a fault that production hides
      // gets advice naming every likely cause.
      setError(
        errorText(
          error,
          "Unable to confirm the update. Check the key, future expiration date, connection, and administrator access. Refresh to check the saved expiration date before retrying.",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, replace };
}
