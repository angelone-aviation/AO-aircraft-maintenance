import { ConvexError } from "convex/values";
import {
  useState,
  useId,
  cloneElement,
  isValidElement,
  type ReactNode,
  type FormEvent,
} from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { DialogFrame, PageHeader } from "./design";
import { useWorkspace } from "../data/store";
// The active Flight Program, or null before a snapshot is loaded.
function currentProgram() {
  const snapshot = useWorkspace.getState().snapshot;
  return snapshot ? (snapshot.activeProgramUuid ?? "") : null;
}
// Every existing modal renders through the design system's dialog: a centred
// modal from 760px, a bottom sheet below. Unlike <Dialog>, a stray click on
// the scrim never discards a half-filled form; Escape and the close button do.
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  className = "",
}: {
  title: string;
  wide?: boolean;
  className?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <DialogFrame
      title={title}
      onClose={onClose}
      size={wide ? "wide" : "default"}
      dismissOnScrim={false}
      className={["modal", className].filter(Boolean).join(" ")}
    >
      {children}
    </DialogFrame>
  );
}
const errorText = (e: unknown) =>
  e instanceof ConvexError && typeof e.data === "string"
    ? e.data
    : e instanceof Error
      ? e.message
      : "Something went wrong. Please try again.";
// Confirmed, permanent removal of a stored attachment.
export function DeleteFileButton({
  name,
  onDelete,
  disabled = false,
}: {
  name: string;
  onDelete: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="text-button"
        aria-label={`Delete ${name}`}
        disabled={busy || disabled}
        onClick={async () => {
          if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
          setBusy(true);
          setError("");
          try {
            await onDelete();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
    const data = new FormData(e.currentTarget);
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    if (submitter instanceof HTMLButtonElement && submitter.name)
      data.set(submitter.name, submitter.value);
    setBusy(true);
    setError("");
    try {
      await onSubmit(data);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={submit}
      onChange={(e) => onChange?.(new FormData(e.currentTarget))}
    >
      <fieldset disabled={busy || disabled}>{children}</fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
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
    </form>
  );
}
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
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "danger";
}) {
  // Status codes such as "due-soon" read as "Due soon"; CSS capitalizes.
  return (
    <span className={"badge " + tone}>
      {typeof children === "string" ? children.replace(/-/g, " ") : children}
    </span>
  );
}
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
// Legacy page heading; renders the redesign's PageHeader.
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
// Stored and third-party URLs may carry javascript: or data: schemes.
export function safeHref(url: string | null | undefined) {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}
export function value(data: FormData, key: string) {
  return String(data.get(key) ?? "").trim();
}
export function download(
  name: string,
  text: string,
  type = "application/json",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
