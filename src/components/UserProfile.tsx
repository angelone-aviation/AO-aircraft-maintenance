/**
 * Responsibility: A user's profile and certifications form, with their
 *   license copies, and the signed-in user's own certifications button.
 * Layer: UI. React components; files go through the workspace backend.
 * Dependencies: react, react-dom, src/data/store.ts, src/domain
 *   (certifications, model, alerts, accountRules), ./ui.
 */
import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";
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
import type { Member } from "../domain/model";
import { wantsAlertEmails } from "../domain/alerts";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../domain/accountRules";
import { AsyncForm, Field, Modal, errorText } from "./ui";

type PendingCopy = { id: string; kind: CertificationKind; file: File };
export function UserProfileForm({
  initial,
  self = false,
  onDone,
}: {
  initial?: Member;
  self?: boolean;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [createdId, setCreatedId] = useState<string>();
  const [rows, setRows] = useState<Certification[]>(() =>
    normalizeCertifications(initial?.certifications ?? []),
  );
  const [certTouched, setCertTouched] = useState(false);
  const [pending, setPending] = useState<PendingCopy[]>([]);
  const [fileError, setFileError] = useState("");
  const [files, setFiles] = useState<CertificationFile[]>([]);
  const [selectedGroups, setGroups] = useState(initial?.groupIds ?? []);
  const userId = initial?.id ?? createdId;
  const emailAlerts =
    self && wantsAlertEmails(s!.user, s!.groups, s!.activeProgramUuid);
  const reloadFiles = async () => {
    if (userId) setFiles(await backend!.certificationFiles(userId));
  };
  useEffect(() => {
    let current = true;
    if (userId)
      backend!
        .certificationFiles(userId)
        .then((result) => {
          if (current) setFiles(result);
        })
        .catch((error) => {
          if (current) setFileError(errorText(error));
        });
    return () => {
      current = false;
    };
  }, [userId, backend]);
  const update = (kind: CertificationKind, patch: Partial<Certification>) => {
    setCertTouched(true);
    setRows((old) =>
      old.map((c) => (c.kind === kind ? { ...c, ...patch } : c)),
    );
  };
  const renderCertification = (kind: CertificationKind): ReactNode => {
    const c = rows.find((c) => c.kind === kind),
      label = certificationLabels[kind];
    return (
      <fieldset key={kind} className="panel">
        <legend>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!c}
              onChange={(e) => {
                setCertTouched(true);
                setRows((old) =>
                  e.target.checked
                    ? [...old, { kind, number: "", issuedOn: "" }]
                    : old.filter(
                        (c) =>
                          c.kind !== kind &&
                          !(
                            kind === "mechanic" &&
                            ["airframe", "powerplant", "ia"].includes(c.kind)
                          ),
                      ),
                );
              }}
            />
            {label}
          </label>
        </legend>
        {c && (
          <>
            <div className="form-grid">
              <Field label={`${label} certificate number`}>
                <input
                  maxLength={100}
                  value={c.number}
                  onChange={(e) => update(kind, { number: e.target.value })}
                />
              </Field>
              {kind === "mechanic" && (
                <div
                  aria-label="Mechanic ratings and authorization"
                  role="group"
                  style={{ marginLeft: "1rem" }}
                >
                  {(["airframe", "powerplant", "ia"] as const).map((rating) => (
                    <label key={rating} className="checkbox">
                      <input
                        type="checkbox"
                        checked={!!c[rating]}
                        onChange={(e) =>
                          update("mechanic", {
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
              )}
              <Field label={`${label} date of issue`}>
                <input
                  type="date"
                  value={c.issuedOn}
                  onChange={(e) => update(kind, { issuedOn: e.target.value })}
                />
              </Field>
              {kind === "pilot" && (
                <Field
                  label="Medical or certificate expiration"
                  hint="Alerts start 30 days before this date."
                >
                  <input
                    type="date"
                    value={c.expiresOn ?? ""}
                    onChange={(e) =>
                      update(kind, { expiresOn: e.target.value })
                    }
                  />
                </Field>
              )}
              {kind === "mechanic" && c.ia && (
                <Field label="IA renewal date">
                  <input
                    type="date"
                    value={c.renewalDate ?? ""}
                    min={c.issuedOn || undefined}
                    onChange={(e) =>
                      update(kind, { renewalDate: e.target.value })
                    }
                  />
                </Field>
              )}
            </div>
            <Field
              label={`${label} license copies`}
              hint="PDF, JPEG, PNG, WebP, HEIC or HEIF; up to 5 MB each. Uploaded when you save."
            >
              <input
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif"
                onChange={(e) => {
                  setFileError("");
                  try {
                    const copies = Array.from(e.target.files ?? []).map(
                      (file) => {
                        if (!file.type) {
                          const extension = file.name
                            .split(".")
                            .at(-1)
                            ?.toLowerCase();
                          const type =
                            extension === "heic"
                              ? "image/heic"
                              : extension === "heif"
                                ? "image/heif"
                                : "";
                          if (type)
                            file = new File([file], file.name, { type });
                        }
                        validateCertificationFile(
                          file.name,
                          file.type,
                          file.size,
                        );
                        return { id: crypto.randomUUID(), kind, file };
                      },
                    );
                    setPending((old) => [...old, ...copies]);
                  } catch (error) {
                    setFileError(errorText(error));
                  }
                  e.target.value = "";
                }}
              />
            </Field>
            {pending
              .filter((p) => p.kind === kind)
              .map((p) => (
                <p key={p.id}>
                  {p.file.name} · Pending upload{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setPending((old) => old.filter((f) => f.id !== p.id))
                    }
                  >
                    Remove pending copy
                  </button>
                </p>
              ))}
            {files
              .filter(
                (f) =>
                  f.kind === kind ||
                  (kind === "mechanic" &&
                    ["airframe", "powerplant", "ia"].includes(f.kind)),
              )
              .map((f) => (
                <p key={f.id}>
                  {f.name}{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={async () => {
                      const win = window.open("about:blank", "_blank");
                      if (win) win.opener = null;
                      try {
                        const url = await backend!.certificationFileUrl(f.id);
                        if (!url) throw Error("License copy unavailable.");
                        if (win) win.location.href = url;
                        else
                          throw Error(
                            "Allow a new tab to view the license copy.",
                          );
                      } catch (error) {
                        win?.close();
                        setFileError(errorText(error));
                      }
                    }}
                  >
                    View license copy
                  </button>{" "}
                  <button
                    type="button"
                    className="text-button"
                    disabled={!online || !connected}
                    onClick={async () => {
                      try {
                        await backend!.deleteCertificationFile(f.id);
                        await reloadFiles();
                      } catch (error) {
                        setFileError(errorText(error));
                      }
                    }}
                  >
                    Delete license copy
                  </button>
                </p>
              ))}
          </>
        )}
      </fieldset>
    );
  };
  return (
    <AsyncForm
      disabled={!online || !connected}
      submitLabel={
        self
          ? "Save certifications"
          : initial || createdId
            ? "Save user"
            : "Create account"
      }
      onSubmit={async (data) => {
        const certifications = certificationsSchema.parse(rows);
        let id = userId;
        if (!id) {
          id = await backend!.createUser(
            String(data.get("email")),
            String(data.get("name")),
            String(data.get("password")),
          );
          setCreatedId(id);
        }
        if (self) {
          if (certTouched)
            await backend!.saveCertifications(id, certifications);
          if (data.has("emailAlerts") !== emailAlerts)
            await backend!.setAlertEmails(data.has("emailAlerts"));
        } else
          await backend!.updateUser({
            ...(initial ?? {
              email: String(data.get("email")),
              groupIds: [],
            }),
            id,
            name: String(data.get("name")),
            active: data.has("active"),
            isAdmin: data.has("admin"),
            groupIds: selectedGroups,
            certifications:
              certTouched || !initial ? certifications : undefined,
          });
        for (const copy of pending.filter((p) =>
          rows.some((c) => c.kind === p.kind),
        )) {
          await backend!.uploadCertification(id, copy.kind, copy.file);
          setPending((old) => old.filter((p) => p.id !== copy.id));
        }
        onDone();
      }}
    >
      {createdId && (
        <p className="notice">
          The account has been created. Save again to finish any remaining
          profile details or license uploads.
        </p>
      )}
      <Field label="Full name">
        <input
          name="name"
          required
          maxLength={150}
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
          readOnly={!!initial || !!createdId}
        />
      </Field>
      {!initial && !createdId && (
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
      )}
      {!self && (
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
          <h3>Flight Program access</h3>
          <p className="muted">
            Select permission groups under each Flight Program. Choose Observers
            for read-only access. Uncheck every group in a program to remove
            access to that program.
          </p>
          {s!.programs?.map((program) => (
            <fieldset key={program.uuid} className="panel">
              <legend>{program.name}</legend>
              {s!.groups
                .filter((g) => g.programUuid === program.uuid)
                .map((g) => (
                  <label className="checkbox" key={g.id}>
                    <input
                      type="checkbox"
                      checked={selectedGroups.includes(g.id)}
                      onChange={(e) =>
                        setGroups((old) =>
                          e.target.checked
                            ? [...old, g.id]
                            : old.filter((id) => id !== g.id),
                        )
                      }
                    />
                    {g.name} ·{" "}
                    {g.programAdmin
                      ? "Program administrator"
                      : g.permissions.join(", ")}
                  </label>
                ))}
              {!s!.groups.some((g) => g.programUuid === program.uuid) && (
                <p className="muted">
                  No permission groups are available. Create a permission group
                  in Administration before granting access.
                </p>
              )}
            </fieldset>
          ))}
        </>
      )}
      {self && (
        <label className="checkbox">
          <input
            type="checkbox"
            name="emailAlerts"
            defaultChecked={emailAlerts}
          />
          Email me maintenance alerts (daily digest)
        </label>
      )}
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
        not recorded. Certification selections do not change application
        permissions.
      </p>
      {renderCertification("pilot")}
      {renderCertification("mechanic")}
      {fileError && (
        <p className="error" role="alert">
          {fileError}
        </p>
      )}
    </AsyncForm>
  );
}
/** The signed-in user's own certifications form, opened from the sidebar
 * footer, the More sheet and Settings → My account (each passes its own
 * button label and look). */
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
