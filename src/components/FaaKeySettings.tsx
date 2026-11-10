/**
 * Responsibility: The shared FAA DRS API key: its renewal warning, the status
 *   members read, and the panel and button a system administrator uses to
 *   replace it.
 * Layer: UI. React components; they never see a stored key, only the status
 *   the snapshot carries.
 * Dependencies: react, @tanstack/react-router, src/data/store.ts,
 *   src/domain/faaCredential.ts, src/domain/model.ts, ./demoNotice, ./ui,
 *   ./SettingsBlock.
 *
 * The key is edited in one place, Settings → System (system administrators
 * only); everyone else reads its status and who renews it.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import {
  FAA_DRS_KEY_URL,
  faaKeyNoticeForMembers,
  faaRenewal,
  RENEWAL_WARNING_DAYS,
  type FaaCredentialStatus,
} from "../domain/faaCredential";
import { localDate } from "../domain/model";
import { DEMO_KEYS_UNAVAILABLE } from "./demoNotice";
import { Field, Modal, errorText, useRevealError } from "./ui";
import {
  IntegrationRow,
  UpdateButton,
  type IntegrationStatus,
} from "./SettingsBlock";

const DAY_MS = 86_400_000;

/**
 * The FAA key renewal warning: for system administrators with a link to
 * where they replace the key, for everyone else naming who renews it.
 *
 * @returns Nothing before the snapshot loads, or while a configured key
 *   expires more than 60 days from today.
 */
export function FaaRenewalAlert() {
  const status = useWorkspace((s) => s.snapshot?.faaCredential);
  const systemAdmin = useWorkspace((s) => !!s.snapshot?.user.isAdmin);
  if (!status) return null;
  const notice = systemAdmin
    ? faaRenewal(status)
    : faaKeyNoticeForMembers(status);
  if (!notice.warning) return null;
  return (
    <p role="alert" className="callout">
      {notice.message}{" "}
      {systemAdmin && (
        <Link to="/settings" hash="system">
          FAA key settings
        </Link>
      )}
    </p>
  );
}

/**
 * The FAA key's status for the Airworthiness page, read-only: who renews it,
 * and for system administrators a link to Settings → System.
 */
export function FaaKeyStatus() {
  const { snapshot: s } = useWorkspace();
  const systemAdmin = !!s?.user.isAdmin;
  const notice = systemAdmin
    ? faaRenewal(s?.faaCredential)
    : faaKeyNoticeForMembers(s?.faaCredential);
  return (
    <div>
      <p role={notice.warning ? "alert" : undefined}>{notice.message}</p>
      {systemAdmin && (
        <p>
          <Link to="/settings" hash="system">
            Update the FAA key in Settings → System
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * The FAA key panel in Settings → System: the key's status and renewal, where
 * to renew, and the Update… button. Replacing is unavailable offline and in
 * the demo.
 *
 * @param props.level - The heading level: 3 when nested under a heading of
 *   its own (Settings → System), 2 by default.
 */
export function FaaKeySettings({ level = 2 }: { level?: 2 | 3 }) {
  const { snapshot: s, demo } = useWorkspace();
  const reminder = faaRenewal(s?.faaCredential);
  return (
    <IntegrationRow
      name="FAA API key and renewal"
      heading={level === 3 ? "h3" : "h2"}
      status={faaKeyStatus(s?.faaCredential)}
      summary={
        <span role={reminder.warning ? "alert" : undefined}>
          {reminder.message}
        </span>
      }
      action={<FaaKeyUpdateButton label="Update FAA API key" compact />}
    >
      <p className="set-hint">
        From {RENEWAL_WARNING_DAYS} days before the key expires, system
        administrators get an alert under the bell and in the daily email, and
        an urgent alert once it has expired. Renew the key on the FAA website,
        then enter the new key and its expiration date here.
      </p>
      <p>
        <a href={FAA_DRS_KEY_URL} target="_blank" rel="noreferrer">
          Request / renew key at FAA
        </a>
      </p>
      {demo && <p className="set-hint">{DEMO_KEYS_UNAVAILABLE}</p>}
    </IntegrationRow>
  );
}

/**
 * The button that opens the FAA key replacement dialog, with the notice
 * shown once a replacement is saved. Only system administrators get it.
 *
 * @param props.label - The button's accessible name, and its text unless
 *   `compact`.
 * @param props.compact - Shows "Update…", as in an integration row.
 * @returns Nothing for anyone but a system administrator.
 */
export function FaaKeyUpdateButton({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  const { snapshot: s, online, connected, demo } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  if (!s?.user.isAdmin) return null;
  const disabled = demo || !online || !connected;
  const show = () => setOpen(true);
  return (
    <>
      {compact ? (
        <UpdateButton label={label} disabled={disabled} onClick={show} />
      ) : (
        <button
          type="button"
          className="button small"
          disabled={disabled}
          onClick={show}
        >
          {label}
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <ReplaceKeyDialog
          version={s.faaCredential?.version ?? 0}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            setNotice(
              "Replacement key verified with FAA and saved. Its expiring date and alerts now follow the new expiration date.",
            );
          }}
        />
      )}
    </>
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
  const { alertRef, rememberOrigin } = useRevealError(error);
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
          rememberOrigin(e);
          void replace({ key, expiresOn, version });
        }}
      >
        <KeyFields
          apiKey={key}
          expiresOn={expiresOn}
          onKey={setKey}
          onExpiry={setExpiry}
        />
        {error && (
          <p ref={alertRef} role="alert">
            {error}
          </p>
        )}
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

// A key stays valid through its expiration date, so it reads expired from
// the next day, as calendar limits do (GLOSSARY "Overdue").
function faaKeyStatus(
  status: FaaCredentialStatus | undefined,
  today = localDate(),
): IntegrationStatus {
  if (!status?.configured) return { tone: "warn", label: "Not set up" };
  if (!status.expiresOn) return { tone: "warn", label: "No expiry date" };
  if (status.expiresOn < today) return { tone: "danger", label: "Expired" };
  return faaRenewal(status, today).warning
    ? { tone: "warn", label: "Renew soon" }
    : { tone: "good", label: "Active" };
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
