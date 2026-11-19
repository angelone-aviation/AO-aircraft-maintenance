/**
 * Responsibility: A user's account, access and certifications form, with
 *   their license copies, and the signed-in user's own certifications button.
 * Layer: UI. React components; saves and files go through the workspace
 *   backend.
 * Dependencies: react-dom, src/data/store.ts, src/data/backend.ts (types),
 *   src/domain (certifications, model, taskCards, accountRules), ./ui.tsx.
 */
import { createPortal } from "react-dom";
import {
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { Backend } from "../data/backend";
import { useWorkspace } from "../data/store";
import {
  certificationLabels,
  certificationsSchema,
  normalizeCertifications,
  validateCertificationFile,
  type Certification,
  type CertificationFile,
  type CertificationKind,
} from "../domain/certifications";
import type { Group, Member, Snapshot } from "../domain/model";
import type { Program } from "../domain/fleet";
import { certificationsEffect } from "../domain/taskCards";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../domain/accountRules";
import { AsyncForm, Field, Modal, errorText } from "./ui";

// Legacy airframe, powerplant and IA rows and copies belong to the mechanic
// certificate (normalizeCertifications).
const MECHANIC_RATINGS = ["airframe", "powerplant", "ia"] as const;
// The limits certificationSchema and convex/admin.ts enforce.
const CERTIFICATE_NUMBER_MAX_LENGTH = 100;
const NAME_MAX_LENGTH = 150;
// Browsers without HEIC support give these photos no MIME type.
const HEIF_TYPES = new Map([
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);

type PendingCopy = { id: string; kind: CertificationKind; file: File };
type CertificationEditor = ReturnType<typeof useCertificationEditor>;
type LicenseCopies = ReturnType<typeof useLicenseCopies>;
type ProfileSave = ReturnType<typeof useProfileForm>["save"];
// The certificate row a field edits, and how it reports a change.
type RowFieldProps = {
  row: Certification;
  onChange: (patch: Partial<Certification>) => void;
};
// What every certification panel needs from the form.
type CertificationTools = {
  editor: CertificationEditor;
  copies: LicenseCopies;
  live: boolean;
};

/**
 * The account form: a new account, another user's profile, access and
 * certifications, or with `self` the signed-in user's certifications (alert
 * email is chosen only in Settings → Alerts). Saving creates the account
 * first, so after a later failure
 * saving again updates it; license copies upload last, for certifications
 * still selected.
 *
 * @param props.initial - The user to edit; a new account without it.
 * @param props.self - The signed-in user's own form: name and email are
 *   read-only, and there are no access fields.
 * @param props.onDone - Called once everything is saved.
 */
export function UserProfileForm({
  initial,
  self = false,
  onDone,
}: {
  initial?: Member;
  self?: boolean;
  onDone: () => void;
}) {
  const form = useProfileForm(initial, self);
  return (
    <AsyncForm
      disabled={!form.live}
      submitLabel={submitLabel(self, !!initial || form.created)}
      onSubmit={async (data) => {
        await saveProfile(form.save, data);
        onDone();
      }}
    >
      <AccountFields initial={initial} self={self} created={form.created} />
      {!self && (
        <AccessFields
          snapshot={form.snapshot}
          initial={initial}
          selected={form.save.groupIds}
          onSelect={form.setGroupIds}
        />
      )}
      {self && (
        <p className="muted">Alert email is chosen under Settings → Alerts.</p>
      )}
      <Certifications initial={initial} tools={form} />
    </AsyncForm>
  );
}

/**
 * A button that opens the signed-in user's certifications form in a dialog.
 *
 * @param props.label - The button's content; "My certifications" by default.
 * @param props.className - The button's class; a text button by default.
 */
export function MyCertifications({
  label = "My certifications",
  className = "text-button",
}: {
  label?: ReactNode;
  className?: string;
}) {
  const { snapshot: s } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open &&
        createPortal(
          <Modal title="My certifications" onClose={() => setOpen(false)}>
            <UserProfileForm
              initial={s!.user}
              self
              onDone={() => setOpen(false)}
            />
          </Modal>,
          document.body,
        )}
    </>
  );
}

function useProfileForm(initial: Member | undefined, self: boolean) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const [createdId, setCreatedId] = useState<string>();
  const editor = useCertificationEditor(initial);
  const userId = initial?.id ?? createdId;
  const copies = useLicenseCopies(backend, userId);
  const [groupIds, setGroupIds] = useState(initial?.groupIds ?? []);
  const s = snapshot!;
  const save = {
    backend: backend!,
    initial,
    self,
    userId,
    editor,
    groupIds,
    onCreated: setCreatedId,
  };
  const live = online && connected;
  const created = !!createdId;
  return { snapshot: s, save, editor, copies, live, created, setGroupIds };
}

function useCertificationEditor(initial?: Member) {
  const [rows, setRows] = useState<Certification[]>(() =>
    normalizeCertifications(initial?.certifications ?? []),
  );
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<PendingCopy[]>([]);
  const edit = (change: (old: Certification[]) => Certification[]) => {
    setTouched(true);
    setRows(change);
  };
  return {
    rows,
    touched,
    pending,
    toggle: (kind: CertificationKind, selected: boolean) =>
      edit((old) =>
        selected
          ? [...old, { kind, number: "", issuedOn: "" }]
          : old.filter((c) => !coversKind(kind, c.kind)),
      ),
    update: (kind: CertificationKind, patch: Partial<Certification>) =>
      edit((old) => old.map((c) => (c.kind === kind ? { ...c, ...patch } : c))),
    addCopies: (kind: CertificationKind, files: File[]) =>
      setPending((old) => [
        ...old,
        ...files.map((file) => ({ id: crypto.randomUUID(), kind, file })),
      ]),
    removeCopy: (id: string) =>
      setPending((old) => old.filter((p) => p.id !== id)),
  };
}

function useLicenseCopies(backend: Backend | null, userId?: string) {
  const [error, setError] = useState("");
  const [files, setFiles] = useState<CertificationFile[]>([]);
  useEffect(() => {
    // A load that ends after the user changed or the form closed is dropped.
    let current = true;
    if (userId)
      backend!
        .certificationFiles(userId)
        .then((result) => {
          if (current) setFiles(result);
        })
        .catch((e) => {
          if (current) setError(errorText(e));
        });
    return () => {
      current = false;
    };
  }, [userId, backend]);
  const remove = async (id: string) => {
    try {
      await backend!.deleteCertificationFile(id);
      if (userId) setFiles(await backend!.certificationFiles(userId));
    } catch (e) {
      setError(errorText(e));
    }
  };
  const view = (id: string) => viewLicenseCopy(backend!, id, setError);
  return { files, error, setError, view, remove };
}

async function saveProfile(save: ProfileSave, data: FormData) {
  const certifications = certificationsSchema.parse(save.editor.rows);
  const id = save.userId || (await createAccount(save, data));
  if (save.self) {
    if (save.editor.touched)
      await save.backend.saveCertifications(id, certifications);
  } else
    await save.backend.updateUser(userUpdate(save, id, certifications, data));
  // Copies chosen for a certification that was unchecked since are skipped.
  const { pending, rows } = save.editor;
  const uploads = pending.filter((p) => rows.some((c) => c.kind === p.kind));
  for (const copy of uploads) {
    await save.backend.uploadCertification(id, copy.kind, copy.file);
    save.editor.removeCopy(copy.id);
  }
}

async function createAccount(save: ProfileSave, data: FormData) {
  const id = await save.backend.createUser(
    String(data.get("email")),
    String(data.get("name")),
    String(data.get("password")),
  );
  save.onCreated(id);
  return id;
}

// An untouched existing user keeps their stored certifications.
function userUpdate(
  { initial, editor, groupIds }: ProfileSave,
  id: string,
  certifications: Certification[],
  data: FormData,
): Member {
  return {
    ...(initial ?? { email: String(data.get("email")), groupIds: [] }),
    id,
    name: String(data.get("name")),
    active: data.has("active"),
    isAdmin: data.has("admin"),
    groupIds,
    certifications: editor.touched || !initial ? certifications : undefined,
  };
}

async function viewLicenseCopy(
  backend: Backend,
  id: string,
  onError: (message: string) => void,
) {
  // Opened before the await, while the click still lets the page open a tab.
  const win = window.open("about:blank", "_blank");
  if (win) win.opener = null;
  try {
    const url = await backend.certificationFileUrl(id);
    if (!url) throw new Error("License copy unavailable.");
    if (!win) throw new Error("Allow a new tab to view the license copy.");
    win.location.href = url;
  } catch (error) {
    win?.close();
    onError(errorText(error));
  }
}

function submitLabel(self: boolean, exists: boolean) {
  if (self) return "Save certifications";
  return exists ? "Save user" : "Create account";
}

function coversKind(kind: CertificationKind, other: CertificationKind) {
  return (
    other === kind ||
    (kind === "mechanic" &&
      (MECHANIC_RATINGS as readonly string[]).includes(other))
  );
}

function AccountFields({
  initial,
  self,
  created,
}: {
  initial?: Member;
  self: boolean;
  created: boolean;
}) {
  return (
    <>
      {created && (
        <p className="notice">
          The account has been created. Save again to finish any remaining
          profile details or license uploads.
        </p>
      )}
      <Field label="Full name">
        <input
          name="name"
          required
          maxLength={NAME_MAX_LENGTH}
          defaultValue={initial?.name}
          readOnly={self}
        />
      </Field>
      <Field label="Email">
        <input
          name="email"
          type="email"
          required
          defaultValue={initial?.email}
          readOnly={!!initial || created}
        />
      </Field>
      {!initial && !created && <InitialPasswordField />}
    </>
  );
}

function InitialPasswordField() {
  return (
    <Field
      label="Initial password"
      hint={`At least ${PASSWORD_MIN_LENGTH} characters; common passwords are refused. Share privately with the user.`}
    >
      <input
        name="password"
        type="password"
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        required
        autoComplete="new-password"
      />
    </Field>
  );
}

function AccessFields({
  snapshot,
  initial,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  initial?: Member;
  selected: string[];
  onSelect: Dispatch<SetStateAction<string[]>>;
}) {
  return (
    <>
      <AccountFlags initial={initial} />
      <h3>Flight Program access</h3>
      <p className="muted">
        Select permission groups under each Flight Program. Choose Observers for
        read-only access. Uncheck every group in a program to remove access to
        that program.
      </p>
      {snapshot.programs?.map((program) => (
        <ProgramGroups
          key={program.uuid}
          program={program}
          groups={snapshot.groups.filter((g) => g.programUuid === program.uuid)}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function AccountFlags({ initial }: { initial?: Member }) {
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          name="active"
          defaultChecked={initial?.active ?? true}
        />
        Account active
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          name="admin"
          defaultChecked={initial?.isAdmin ?? false}
        />
        Global administrator (all aircraft and settings)
      </label>
    </>
  );
}

function ProgramGroups({
  program,
  groups,
  selected,
  onSelect,
}: {
  program: Program;
  groups: Group[];
  selected: string[];
  onSelect: Dispatch<SetStateAction<string[]>>;
}) {
  return (
    <fieldset className="panel">
      <legend>{program.name}</legend>
      {groups.map((g) => (
        <label className="checkbox" key={g.id}>
          <input
            type="checkbox"
            checked={selected.includes(g.id)}
            onChange={(e) =>
              onSelect((old) =>
                e.target.checked
                  ? [...old, g.id]
                  : old.filter((id) => id !== g.id),
              )
            }
          />
          {g.name} ·{" "}
          {g.programAdmin ? "Program administrator" : g.permissions.join(", ")}
        </label>
      ))}
      {!groups.length && (
        <p className="muted">
          No permission groups are available. Create a permission group in
          Administration before granting access.
        </p>
      )}
    </fieldset>
  );
}

function Certifications({
  initial,
  tools,
}: {
  initial?: Member;
  tools: CertificationTools;
}) {
  return (
    <>
      <h3>Certifications</h3>
      {initial?.certifications === undefined && initial?.licenseNumber && (
        <p className="notice">
          Existing profile license: {initial.certificateType}{" "}
          {initial.licenseNumber}. It is retained until certification selections
          are saved.
        </p>
      )}
      <p className="muted">
        Select applicable certifications. Leave dates blank if not applicable or
        not recorded. {certificationsEffect}
      </p>
      <CertificationPanel kind="pilot" tools={tools} />
      <CertificationPanel kind="mechanic" tools={tools} />
      {tools.copies.error && (
        <p className="error" role="alert">
          {tools.copies.error}
        </p>
      )}
    </>
  );
}

function CertificationPanel({
  kind,
  tools,
}: {
  kind: CertificationKind;
  tools: CertificationTools;
}) {
  const { editor, copies } = tools;
  const row = editor.rows.find((c) => c.kind === kind);
  const label = certificationLabels[kind];
  return (
    <fieldset className="panel">
      <legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!row}
            onChange={(e) => editor.toggle(kind, e.target.checked)}
          />
          {label}
        </label>
      </legend>
      {row && (
        <>
          <CertificateFields
            row={row}
            label={label}
            onChange={(patch) => editor.update(kind, patch)}
          />
          <LicenseCopyInput
            label={label}
            onAdd={(files) => editor.addCopies(kind, files)}
            onError={copies.setError}
          />
          <CopyList kind={kind} tools={tools} />
        </>
      )}
    </fieldset>
  );
}

function CertificateFields({
  row,
  label,
  onChange,
}: RowFieldProps & { label: string }) {
  return (
    <div className="form-grid">
      <Field label={`${label} certificate number`}>
        <input
          maxLength={CERTIFICATE_NUMBER_MAX_LENGTH}
          value={row.number}
          onChange={(e) => onChange({ number: e.target.value })}
        />
      </Field>
      {row.kind === "mechanic" && (
        <MechanicRatings row={row} onChange={onChange} />
      )}
      <Field label={`${label} date of issue`}>
        <input
          type="date"
          value={row.issuedOn}
          onChange={(e) => onChange({ issuedOn: e.target.value })}
        />
      </Field>
      <ExpiryFields row={row} onChange={onChange} />
    </div>
  );
}

function MechanicRatings({ row, onChange }: RowFieldProps) {
  return (
    <div
      aria-label="Mechanic ratings and authorization"
      role="group"
      style={{ marginLeft: "1rem" }}
    >
      {MECHANIC_RATINGS.map((rating) => (
        <label key={rating} className="checkbox">
          <input
            type="checkbox"
            checked={!!row[rating]}
            onChange={(e) =>
              // Only an IA has a renewal date, so losing IA clears it.
              onChange({
                [rating]: e.target.checked,
                ...(rating === "ia" && !e.target.checked
                  ? { renewalDate: "" }
                  : {}),
              })
            }
          />
          {certificationLabels[rating]}
        </label>
      ))}
    </div>
  );
}

function ExpiryFields({ row, onChange }: RowFieldProps) {
  return (
    <>
      {row.kind === "pilot" && (
        <Field
          label="Medical or certificate expiration"
          hint="Alerts start 30 days before this date."
        >
          <input
            type="date"
            value={row.expiresOn ?? ""}
            onChange={(e) => onChange({ expiresOn: e.target.value })}
          />
        </Field>
      )}
      {row.kind === "mechanic" && row.ia && (
        <Field label="IA renewal date">
          <input
            type="date"
            value={row.renewalDate ?? ""}
            min={row.issuedOn || undefined}
            onChange={(e) => onChange({ renewalDate: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}

function LicenseCopyInput({
  label,
  onAdd,
  onError,
}: {
  label: string;
  onAdd: (files: File[]) => void;
  onError: (message: string) => void;
}) {
  return (
    <Field
      label={`${label} license copies`}
      hint="PDF, JPEG, PNG, WebP, HEIC or HEIF; up to 5 MiB each. Uploaded when you save."
    >
      <input
        type="file"
        multiple
        accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
        onChange={(e) => {
          onError("");
          try {
            onAdd(Array.from(e.target.files ?? []).map(checkLicenseCopy));
          } catch (error) {
            // One refused file keeps the whole selection out.
            onError(errorText(error));
          }
          // Cleared so choosing the same file again still fires onChange.
          e.target.value = "";
        }}
      />
    </Field>
  );
}

function checkLicenseCopy(file: File): File {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const type = !file.type && HEIF_TYPES.get(extension);
  const typed = type ? new File([file], file.name, { type }) : file;
  validateCertificationFile(typed.name, typed.type, typed.size);
  return typed;
}

function CopyList({
  kind,
  tools: { editor, copies, live },
}: {
  kind: CertificationKind;
  tools: CertificationTools;
}) {
  const pending = editor.pending.filter((p) => p.kind === kind);
  const stored = copies.files.filter((f) => coversKind(kind, f.kind));
  return (
    <>
      {pending.map((p) => (
        <p key={p.id}>
          {p.file.name} · Pending upload{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => editor.removeCopy(p.id)}
          >
            Remove pending copy
          </button>
        </p>
      ))}
      {stored.map((f) => (
        <StoredCopy key={f.id} file={f} copies={copies} live={live} />
      ))}
    </>
  );
}

function StoredCopy({
  file,
  copies,
  live,
}: {
  file: CertificationFile;
  copies: LicenseCopies;
  live: boolean;
}) {
  return (
    <p>
      {file.name}{" "}
      <button
        type="button"
        className="text-button"
        onClick={() => void copies.view(file.id)}
      >
        View license copy
      </button>{" "}
      <button
        type="button"
        className="text-button"
        disabled={!live}
        onClick={() => void copies.remove(file.id)}
      >
        Delete license copy
      </button>
    </p>
  );
}
