/**
 * Responsibility: The Generate logbook entry button on a completed work
 *   order: composes the maintenance entry, saves it as a PDF or copies it,
 *   and the photos of the signed page beside it.
 * Layer: UI. Entry wording lives in src/domain/logbook.ts.
 * Dependencies: react, react-dom, src/data/store.ts, src/data/logbookPdf.ts
 *   (loaded on demand), src/domain/certifications.ts, src/domain/logbook.ts,
 *   src/domain/model.ts, src/domain/workOrders.ts, ./LogbookPhotos.tsx,
 *   ./ui.tsx.
 */
import { useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { certificateOptions, memberLicense } from "../domain/certifications";
import {
  licenseSchema,
  emptyInspectionEntry,
  emptyComponentEntry,
  type ComponentEntry,
  inspectionEntryReady,
  type InspectionEntry,
  logbookTemplates,
  logbookText,
  type LogbookTemplate,
} from "../domain/logbook";
import type { Snapshot } from "../domain/model";
import type { WorkOrder } from "../domain/workOrders";
import { Field, Modal, errorText, useRevealError } from "./ui";
import { LogbookPhotoStrip } from "./LogbookPhotos";

const CREDENTIAL_FIELD_MAX_LENGTH = 100;
// Must match the line logbookText writes (src/domain/logbook.ts).
const CREDENTIAL_LINE = /^Certificate \/ license:.*$/m;

type Drafts = Partial<Record<LogbookTemplate, string>>;
type Entry = ReturnType<typeof useLogbookEntry>;
type Signer = ReturnType<typeof useSigner>;
type Status = Omit<ReturnType<typeof useActionStatus>, "alertRef">;
type ActionsProps = {
  entry: Entry;
  status: Status;
  order: WorkOrder;
  onClose: () => void;
};

/**
 * Opens the logbook entry for a completed work order: the user picks a
 * template, completes the certifying details, may edit the text, then saves
 * it as a PDF or copies it. The entry stays unsigned (ADR-0004).
 *
 * @param props.order - The work order.
 * @returns The button and, beside it, the photos of the signed logbook page
 *   with "Attach signed page photo" for maintenance; or null until the order
 *   is completed.
 */
export function LogbookEntryButton({ order }: { order: WorkOrder }) {
  const [open, setOpen] = useState(false);
  if (order.status !== "completed") return null;
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Generate logbook entry
      </button>
      <LogbookPhotoStrip
        target={{
          aircraftUuid: order.aircraftUuid,
          linkedKind: "work-order",
          linkedUuid: order.uuid,
        }}
        label="Attach signed page photo"
      />
      {open &&
        createPortal(
          <Modal
            title={`Logbook entry — ${order.number}`}
            onClose={() => setOpen(false)}
          >
            <LogbookEntry order={order} onClose={() => setOpen(false)} />
          </Modal>,
          document.body,
        )}
    </>
  );
}

function LogbookEntry({
  order,
  onClose,
}: {
  order: WorkOrder;
  onClose: () => void;
}) {
  const { snapshot } = useWorkspace();
  const user = snapshot!.user;
  const entry = useLogbookEntry(order);
  // The error ref stays out of `status`, so render code never reads a ref.
  const { alertRef, ...status } = useActionStatus();
  return (
    <>
      <EntryIntro order={order} />
      <SignerFields entry={entry} name={user.name} />
      {entry.template === "inspection" && <InspectionFields entry={entry} />}
      {entry.template === "component" && <ComponentOutcome entry={entry} />}
      {user.certifications === undefined && (
        <SaveLicenseButton entry={entry} status={status} />
      )}
      <Field label="Logbook entry text">
        <textarea
          rows={22}
          value={entry.text}
          onChange={(e) => entry.setBody(e.target.value)}
        />
      </Field>
      <StatusMessages status={status} alertRef={alertRef} />
      <EntryActions
        entry={entry}
        status={status}
        order={order}
        onClose={onClose}
      />
    </>
  );
}

// Each template keeps its own edited text; with none, the text is generated
// afresh from the fields on every render.
function useLogbookEntry(order: WorkOrder) {
  const { snapshot } = useWorkspace();
  const s = snapshot!;
  const [template, setTemplate] = useState<LogbookTemplate>("maintenance");
  const [inspection, setInspection] =
    useState<InspectionEntry>(emptyInspectionEntry);
  const [component, setComponent] =
    useState<ComponentEntry>(emptyComponentEntry);
  const drafts = useDrafts(template);
  const completedOn = order.completionDate || undefined;
  const signer = useSigner(s.user, completedOn, drafts.setCredentials);
  const textFor = (i: InspectionEntry, c: ComponentEntry) =>
    logbookText(s, order, template, signer.details, i, c);
  const generated = textFor(inspection, component);
  const text = drafts.body ?? generated;
  function updateEntry(next: InspectionEntry, nextComponent: ComponentEntry) {
    if (drafts.body !== null)
      drafts.setBody(
        carryEdits(drafts.body, generated, textFor(next, nextComponent)),
      );
    setInspection(next);
    setComponent(nextComponent);
  }
  const exportable =
    !certificationMissing(template, inspection, component) &&
    signer.complete &&
    !!text.trim();
  return {
    template,
    setTemplate,
    signer,
    inspection,
    component,
    updateEntry,
    text,
    setBody: drafts.setBody,
    exportable,
  };
}

function useDrafts(template: LogbookTemplate) {
  const [drafts, setDrafts] = useState<Drafts>({});
  return {
    body: drafts[template] ?? null,
    setBody: (value: string) =>
      setDrafts((old) => ({ ...old, [template]: value })),
    setCredentials: (licenseNumber: string, certificateType: string) =>
      setDrafts((old) => withCredentials(old, licenseNumber, certificateType)),
  };
}

// Changing the credentials also rewrites them in every edited draft.
function useSigner(
  user: Snapshot["user"],
  completedOn: string | undefined,
  onChange: (licenseNumber: string, certificateType: string) => void,
) {
  const saved = memberLicense(user, completedOn);
  const [licenseNumber, setLicense] = useState(saved.licenseNumber);
  const [certificateType, setCertificate] = useState(saved.certificateType);
  const choices = certificateOptions(user, completedOn);
  const chosen = choices.find(
    (c) =>
      c.licenseNumber === licenseNumber &&
      c.certificateType === certificateType,
  );
  return {
    licenseNumber,
    certificateType,
    choices,
    chosenKey: chosen?.key ?? "",
    complete: !!licenseNumber.trim() && !!certificateType.trim(),
    details: {
      userId: user.id,
      name: user.name,
      licenseNumber,
      certificateType,
    },
    set(number: string, type: string) {
      setLicense(number);
      setCertificate(type);
      onChange(number, type);
    },
    validLicense: () => licenseSchema.parse({ licenseNumber, certificateType }),
  };
}

function useActionStatus() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { alertRef, rememberOrigin } = useRevealError(error);
  async function run(
    from: SyntheticEvent<HTMLElement>,
    action: () => Promise<string>,
  ) {
    rememberOrigin(from);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setMessage(await action());
    } catch (e) {
      setError(errorText(e, "Unable to export entry."));
    } finally {
      setBusy(false);
    }
  }
  return { message, error, busy, run, alertRef };
}

function StatusMessages({
  status,
  alertRef,
}: {
  status: Status;
  alertRef: ReturnType<typeof useActionStatus>["alertRef"];
}) {
  return (
    <>
      {status.error && (
        <p ref={alertRef} role="alert" className="error">
          {status.error}
        </p>
      )}
      {status.message && <p role="status">{status.message}</p>}
    </>
  );
}

function EntryIntro({ order }: { order: WorkOrder }) {
  return (
    <>
      <p>
        Review the entry and release outcome before exporting. The signature
        line is left for the certifying person.
      </p>
      <p>
        <a
          href="https://www.somasoftware.com/post/aircraft-logbook-entry"
          target="_blank"
          rel="noreferrer"
        >
          Template examples
        </a>
      </p>
      {!order.closeout && (
        <p className="notice">
          This older order has opening readings only. Confirm the completion
          readings and any component details in the entry. Its inspection
          compliance has not been changed retrospectively.
        </p>
      )}
    </>
  );
}

function SignerFields({ entry, name }: { entry: Entry; name: string }) {
  return (
    <div className="form-grid">
      <Field label="Logbook template">
        <select
          value={entry.template}
          onChange={(e) => entry.setTemplate(e.target.value as LogbookTemplate)}
        >
          {Object.entries(logbookTemplates).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Certifying person">
        <input value={name} readOnly />
      </Field>
      <CredentialFields signer={entry.signer} />
    </div>
  );
}

function CredentialFields({ signer }: { signer: Signer }) {
  const { licenseNumber, certificateType } = signer;
  return (
    <>
      {signer.choices.length > 0 && <SavedCertificationField signer={signer} />}
      <Field label="License / certificate number">
        <input
          maxLength={CREDENTIAL_FIELD_MAX_LENGTH}
          value={licenseNumber}
          onChange={(e) => signer.set(e.target.value, certificateType)}
        />
      </Field>
      <Field label="Certificate type">
        <input
          placeholder="e.g. A&P, IA, AME"
          maxLength={CREDENTIAL_FIELD_MAX_LENGTH}
          value={certificateType}
          onChange={(e) => signer.set(licenseNumber, e.target.value)}
        />
      </Field>
    </>
  );
}

function SavedCertificationField({ signer }: { signer: Signer }) {
  const { choices } = signer;
  return (
    <Field label="Use saved certification">
      <select
        value={signer.chosenKey}
        onChange={(e) => {
          const selected = choices.find((c) => c.key === e.target.value);
          if (!selected) return;
          signer.set(selected.licenseNumber, selected.certificateType);
        }}
      >
        <option value="">Enter manually</option>
        {choices.map((c) => (
          <option key={c.key} value={c.key}>
            {c.certificateType} · {c.licenseNumber}
          </option>
        ))}
      </select>
    </Field>
  );
}

function InspectionFields({ entry }: { entry: Entry }) {
  const { inspection } = entry;
  const update = (patch: Partial<InspectionEntry>) =>
    entry.updateEntry({ ...inspection, ...patch }, entry.component);
  return (
    <>
      <div className="form-grid">
        <Field label="Inspection type">
          <select
            value={inspection.type}
            onChange={(e) =>
              update({ type: e.target.value as InspectionEntry["type"] })
            }
          >
            <option value="annual">Annual</option>
            <option value="100-hour">100-Hour</option>
          </select>
        </Field>
        <InspectionTextFields inspection={inspection} update={update} />
        <Field label="Inspection finding">
          <select
            value={inspection.airworthy ? "airworthy" : ""}
            onChange={(e) =>
              update({ airworthy: e.target.value === "airworthy" })
            }
          >
            <option value="">Select finding</option>
            <option value="airworthy">
              Airworthy — approved for return to service
            </option>
          </select>
        </Field>
      </div>
      <InspectionNotes annual={inspection.type === "annual"} />
    </>
  );
}

function InspectionTextFields({
  inspection,
  update,
}: {
  inspection: InspectionEntry;
  update: (patch: Partial<InspectionEntry>) => void;
}) {
  return (
    <>
      <Field label="Manufacturer's inspection checklist">
        <input
          value={inspection.checklist}
          placeholder="Manufacturer, checklist and revision"
          onChange={(e) => update({ checklist: e.target.value })}
        />
      </Field>
      <Field label="AD / SB checked through">
        <input
          value={inspection.reviewedThrough}
          placeholder="Review date or bi-weekly issue"
          onChange={(e) => update({ reviewedThrough: e.target.value })}
        />
      </Field>
    </>
  );
}

function InspectionNotes({ annual }: { annual: boolean }) {
  return (
    <>
      <p>
        This template is for an airworthy finding. Enter the checklist and AD/SB
        review cutoff before exporting. Include your actual certificate type and
        authorization in the certificate field.
      </p>
      {annual && (
        <p>
          For an annual signed as an A&amp;P mechanic, include your IA
          authorization (for example, A&amp;P IA).
        </p>
      )}
    </>
  );
}

function ComponentOutcome({ entry }: { entry: Entry }) {
  return (
    <Field label="Return-to-service outcome">
      <select
        value={entry.component.approvedForReturnToService ? "approved" : ""}
        onChange={(e) =>
          entry.updateEntry(entry.inspection, {
            approvedForReturnToService: e.target.value === "approved",
          })
        }
      >
        <option value="">Select outcome</option>
        <option value="approved">
          Work satisfactory — approved only for the work performed
        </option>
      </select>
    </Field>
  );
}

function SaveLicenseButton({
  entry,
  status,
}: {
  entry: Entry;
  status: Status;
}) {
  const { backend, online, connected } = useWorkspace();
  async function saveLicense() {
    const license = entry.signer.validLicense();
    await backend!.saveLicense(license.licenseNumber, license.certificateType);
    return "License saved to your profile.";
  }
  return (
    <button
      type="button"
      className="button"
      disabled={status.busy || !online || !connected}
      onClick={(e) => void status.run(e, saveLicense)}
    >
      Save license to my profile
    </button>
  );
}

function EntryActions({ entry, status, order, onClose }: ActionsProps) {
  const disabled = status.busy || !entry.exportable;
  const exportWith =
    (action: () => Promise<string>) => (e: SyntheticEvent<HTMLElement>) =>
      void status.run(e, async () => {
        entry.signer.validLicense();
        return action();
      });
  return (
    <div className="form-footer">
      <button
        type="button"
        className="button primary"
        disabled={disabled}
        onClick={exportWith(() => savePdf(entry.text, order.number))}
      >
        Save as PDF
      </button>
      <button
        type="button"
        className="button"
        disabled={disabled}
        onClick={exportWith(() => copyText(entry.text))}
      >
        Copy text
      </button>
      <button
        type="button"
        className="button"
        disabled={status.busy}
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );
}

function certificationMissing(
  template: LogbookTemplate,
  inspection: InspectionEntry,
  component: ComponentEntry,
): boolean {
  if (template === "inspection") return !inspectionEntryReady(inspection);
  if (template === "component") return !component.approvedForReturnToService;
  return false;
}

// Keeps the user's edits when a field changes: each line the generated text
// changed is replaced wherever it still appears unedited in the draft.
function carryEdits(body: string, previous: string, updated: string): string {
  const next = updated.split("\n");
  const replacements = new Map(
    previous
      .split("\n")
      .flatMap((line, i) =>
        line && line !== next[i] ? [[line, next[i]] as const] : [],
      ),
  );
  return body
    .split("\n")
    .map((line) => replacements.get(line) ?? line)
    .join("\n");
}

function withCredentials(
  drafts: Drafts,
  licenseNumber: string,
  certificateType: string,
): Drafts {
  const line = `Certificate / license: ${certificateType || "[enter certificate type]"} ${licenseNumber || "[enter license number]"}`;
  return Object.fromEntries(
    Object.entries(drafts).map(([key, text]) => [
      key,
      text.replace(CREDENTIAL_LINE, () => line),
    ]),
  );
}

// jsPDF loads on demand, keeping it out of the main bundle.
async function savePdf(text: string, orderNumber: string): Promise<string> {
  const { logbookPdf } = await import("../data/logbookPdf");
  const pdf = await logbookPdf(text);
  pdf.save(`${orderNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}-logbook.pdf`);
  return "PDF saved.";
}

async function copyText(text: string): Promise<string> {
  await navigator.clipboard.writeText(text);
  return "Logbook entry copied.";
}
