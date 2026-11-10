/**
 * Responsibility: Shared building blocks for forms and pages: the modal, the
 *   async form and delete button, revealing a refused save, labelled fields,
 *   empty states, page titles, safe links, file and blank-CSV downloads, and
 *   the text shown for an error.
 * Layer: UI. Shared components; no Convex imports.
 * Dependencies: react, @phosphor-icons/react, ./design.tsx, src/data/store.ts,
 *   src/data/errors.ts, src/domain/csv.ts.
 */
import {
  useEffect,
  useRef,
  useState,
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
  type FormEvent,
  type SyntheticEvent,
} from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { DialogFrame, PageHeader } from "./design";
import { useWorkspace } from "../data/store";
import { errorText } from "../data/errors";
import { toCsv } from "../domain/csv";

/** Re-exported so screens keep one import for their building blocks. */
export { errorText };

// Long enough for the browser to start the download; revoking the URL at once
// can cancel it.
const DOWNLOAD_URL_LIFETIME_MS = 1000;

/**
 * A dialog for forms: a centred modal from 760px, a bottom sheet below.
 * Unlike `Dialog`, a click on the scrim never closes it; Escape and Back ask
 * before discarding what the user entered, and the close button closes.
 *
 * @param props.wide - Uses the wide dialog size.
 * @param props.className - Added after the `modal` class.
 * @param props.confirmDiscard - False for a form that asks by itself.
 * @returns The design system's DialogFrame.
 */
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
  confirmDiscard,
}: {
  title: string;
  wide?: boolean;
  className?: string;
  children: ReactNode;
  onClose: () => void;
  confirmDiscard?: boolean;
}) {
  return (
    <DialogFrame
      title={title}
      onClose={onClose}
      size={wide ? "wide" : "default"}
      dismissOnScrim={false}
      confirmDiscard={confirmDiscard}
      className={["modal", className].filter(Boolean).join(" ")}
    >
      {children}
    </DialogFrame>
  );
}

/**
 * A Delete button that asks for confirmation, then permanently removes a
 * stored attachment.
 *
 * @param props.name - The file's name, in the accessible name ("Delete
 *   <name>") and the confirmation.
 * @param props.onDelete - Removes the file; its error shows beside the button.
 * @returns The button, followed by an alert after a failure.
 */
export function DeleteFileButton({
  name,
  onDelete,
  disabled = false,
}: {
  name: string;
  onDelete: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const { busy, error, run } = useBusyAction();
  return (
    <>
      <button
        type="button"
        className="text-button"
        aria-label={`Delete ${name}`}
        disabled={busy || disabled}
        onClick={() => {
          if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
          void run(onDelete);
        }}
      >
        Delete
      </button>
      {error && (
        <span role="alert" className="error">
          {" "}
          {error}
        </span>
      )}
    </>
  );
}

/**
 * A form that submits through an async command, disabling its fields while
 * the command runs and showing the command's error above the footer.
 * A refused submit scrolls its error into view, clear of a sticky footer,
 * and returns focus to the field or button it was submitted from.
 *
 * @param props.onSubmit - Receives the form data, including the name and value
 *   of the submit button that was clicked.
 * @param props.onChange - Receives the form data after every change.
 * @param props.onClose - Adds a Close button, disabled only while submitting.
 * @param props.submitLabel - Defaults to "Save".
 * @returns The form. Submitting after the active Flight Program changed shows
 *   "The active Flight Program changed. Reopen this form." instead.
 */
export function AsyncForm({
  onSubmit,
  onClose,
  onChange,
  children,
  submitLabel = "Save",
  disabled = false,
}: {
  onSubmit: (data: FormData) => Promise<void>;
  onClose?: () => void;
  onChange?: (data: FormData) => void;
  children: ReactNode;
  submitLabel?: string;
  disabled?: boolean;
}) {
  const { busy, error, submit } = useProgramSubmit(onSubmit);
  const { alertRef, rememberOrigin } = useRevealError(error);
  return (
    <form
      onSubmit={(e) => {
        rememberOrigin(e);
        return submit(e);
      }}
      onChange={(e) => onChange?.(new FormData(e.currentTarget))}
    >
      <fieldset disabled={busy || disabled}>{children}</fieldset>
      {error && (
        <p ref={alertRef} role="alert" className="error">
          {error}
        </p>
      )}
      <FormFooter
        busy={busy}
        disabled={disabled}
        submitLabel={submitLabel}
        onClose={onClose}
      />
    </form>
  );
}

/**
 * Keeps a refused save in front of the user, for forms that show their own
 * error instead of using AsyncForm. Disabling a busy form drops focus from
 * the field or button the save started from to the page, and the error often
 * renders below the visible part of a long dialog.
 *
 * @param error - The error text the form shows; "" when there is none.
 * @returns `alertRef`, for the element that shows the error, and
 *   `rememberOrigin`, to call with the submit or click event that starts the
 *   save. When the error appears, focus returns to that field or button if it
 *   fell to the page (never if the user moved it), and the error scrolls into
 *   view clear of a sticky footer. The same text twice in a row does not
 *   reveal again, so clear the error when a save starts.
 */
export function useRevealError(error: string) {
  const alertRef = useRef<HTMLParagraphElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!error) return;
    restoreFocus(origin.current);
    // "nearest" honours the dialog body's scroll-padding-bottom, so the
    // error stops above the sticky footer instead of under it.
    alertRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  function rememberOrigin(e: SyntheticEvent<HTMLElement>) {
    origin.current = saveOrigin(e);
  }
  return { alertRef, rememberOrigin };
}

/**
 * A labelled field. Clones a single element child with the label's id and
 * points its aria-describedby at the hint; any other child renders as is.
 * A component child gets them as its `id` and `aria-describedby` props: it
 * must pass both to its control, or the label and hint are silently unlinked.
 *
 * @returns The `.field` wrapper with its label, control and hint.
 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {isValidElement<{ id?: string; "aria-describedby"?: string }>(children)
        ? cloneElement(children, {
            id,
            "aria-describedby": hint ? id + "-hint" : undefined,
          })
        : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}

/** An empty state: a heading over an explanatory paragraph. */
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/**
 * The older page heading, drawn by the design system's PageHeader.
 *
 * @param props.action - Shown in the header's actions area.
 */
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <PageHeader
      className="page-title"
      eyebrow={eyebrow}
      title={title}
      description={description}
      actions={action}
    />
  );
}

/**
 * Lets only http and https links through: stored and third-party URLs may
 * carry javascript: or data: schemes.
 *
 * @returns The url unchanged, or undefined for any other scheme, a relative or
 *   unparseable url, or an empty value.
 */
export function safeHref(url: string | null | undefined) {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    // The URL constructor throws on relative and malformed input.
    return undefined;
  }
}

/**
 * Reads a form field as trimmed text.
 *
 * @returns The trimmed value, or "" when the field is missing.
 */
export function value(data: FormData, key: string) {
  return String(data.get(key) ?? "").trim();
}

/**
 * Saves text, or a blob's bytes, as a file by clicking a temporary object-URL
 * link, which is revoked a second later.
 *
 * @param contents - The text, or a blob whose bytes are saved unchanged.
 * @param type - The file's MIME type; defaults to application/json.
 */
export function download(
  name: string,
  contents: string | Blob,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}

/**
 * Saves a CSV template for an importer: the byte-order mark and the quoted
 * header row only, ending in CRLF.
 *
 * @param name - The file name.
 * @param headers - The importer's column names, in order.
 * @param type - The file's MIME type; defaults to text/csv.
 */
export function downloadBlankCsv(
  name: string,
  headers: readonly string[],
  type = "text/csv",
) {
  const [headerRow] = toCsv([
    Object.fromEntries(headers.map((h) => [h, ""])),
  ]).split("\r\n");
  download(name, `${headerRow}\r\n`, type);
}

function FormFooter({
  busy,
  disabled,
  submitLabel,
  onClose,
}: {
  busy: boolean;
  disabled: boolean;
  submitLabel: string;
  onClose?: () => void;
}) {
  return (
    <div className="form-footer">
      <button className="button primary" disabled={busy || disabled}>
        {busy && (
          <CircleNotch
            className="spin"
            size={16}
            weight="bold"
            aria-hidden="true"
          />
        )}{" "}
        {submitLabel}
      </button>
      {onClose && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      )}
    </div>
  );
}

function useProgramSubmit(onSubmit: (data: FormData) => Promise<void>) {
  const { busy, error, setError, run } = useBusyAction();
  // Backend commands resolve the program at call time; refuse to submit a form
  // opened under one Flight Program after another became active.
  const [programAtOpen] = useState(currentProgram);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const program = currentProgram();
    if (
      programAtOpen !== null &&
      program !== null &&
      program !== programAtOpen
    ) {
      setError("The active Flight Program changed. Reopen this form.");
      return;
    }
    const data = readSubmission(e);
    await run(() => onSubmit(data));
  }
  return { busy, error, submit };
}

// The focused field or button inside the form or button the save started
// from; else the submit button, since Safari does not focus a clicked button.
function saveOrigin(e: SyntheticEvent<HTMLElement>): HTMLElement {
  const focused = document.activeElement;
  const inside = focused && e.currentTarget.contains(focused);
  if (inside && focused instanceof HTMLElement) return focused;
  const { submitter } = e.nativeEvent as SubmitEvent;
  return submitter ?? e.currentTarget;
}

// Only when focus was dropped: never take it from where the user moved it.
// role="alert" already announces the error, so focus does not go to it.
function restoreFocus(origin: HTMLElement | null) {
  const focused = document.activeElement;
  if (focused && focused !== document.body) return;
  origin?.focus({ preventScroll: true });
}

function useBusyAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

// The active Flight Program, or null before a snapshot is loaded.
function currentProgram() {
  const snapshot = useWorkspace.getState().snapshot;
  return snapshot ? (snapshot.activeProgramUuid ?? "") : null;
}

// new FormData(form) leaves out the clicked submit button, which forms with
// several submit buttons read.
function readSubmission(e: FormEvent<HTMLFormElement>): FormData {
  const data = new FormData(e.currentTarget);
  const submitter = (e.nativeEvent as SubmitEvent).submitter;
  if (submitter instanceof HTMLButtonElement && submitter.name)
    data.set(submitter.name, submitter.value);
  return data;
}
