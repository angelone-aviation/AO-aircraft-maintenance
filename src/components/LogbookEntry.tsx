import { certificateOptions, memberLicense } from "../domain/certifications";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
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
import type { WorkOrder } from "../domain/workOrders";
import { Field, Modal } from "./ui";

export function LogbookEntryButton({ order }: { order: WorkOrder }) {
  const [open, setOpen] = useState(false);
  if (order.status !== "completed") return null;
  return (
    <>
      <button type="button" className="button" onClick={() => setOpen(true)}>
        Generate logbook entry
      </button>
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
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [template, setTemplate] = useState<LogbookTemplate>("maintenance");
  const credentials = memberLicense(s!.user, order.completionDate || undefined);
  const choices = certificateOptions(
    s!.user,
    order.completionDate || undefined,
  );
  const [licenseNumber, setLicense] = useState(credentials.licenseNumber);
  const [certificateType, setCertificate] = useState(
    credentials.certificateType,
  );
  const [inspection, setInspection] =
    useState<InspectionEntry>(emptyInspectionEntry);
  const [component, setComponent] =
    useState<ComponentEntry>(emptyComponentEntry);
  const [drafts, setDrafts] = useState<
    Partial<Record<LogbookTemplate, string>>
  >({});
  const body = drafts[template] ?? null;
  const setBody = (value: string) =>
    setDrafts((old) => ({ ...old, [template]: value }));
  const updateDraftCredentials = (number: string, type: string) => {
    setDrafts((old) =>
      Object.fromEntries(
        Object.entries(old).map(([key, value]) => [
          key,
          value.replace(
            /^Certificate \/ license:.*$/m,
            () =>
              `Certificate / license: ${type || "[enter certificate type]"} ${number || "[enter license number]"}`,
          ),
        ]),
      ),
    );
  };
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generated = logbookText(
    s!,
    order,
    template,
    {
      name: s!.user.name,
      licenseNumber,
      certificateType,
    },
    inspection,
    component,
  );
  const text = body ?? generated;
  const updateEntry = (
    next: InspectionEntry,
    nextComponent: ComponentEntry,
  ) => {
    if (body !== null) {
      const updated = logbookText(
        s!,
        order,
        template,
        { name: s!.user.name, licenseNumber, certificateType },
        next,
        nextComponent,
      ).split("\n");
      const previous = generated.split("\n");
      const replacements = new Map(
        previous.flatMap((line, i) =>
          line && line !== updated[i] ? [[line, updated[i]] as const] : [],
        ),
      );
      setBody(
        body
          .split("\n")
          .map((line) => replacements.get(line) ?? line)
          .join("\n"),
      );
    }
    setInspection(next);
    setComponent(nextComponent);
  };
  const updateInspection = (next: InspectionEntry) =>
    updateEntry(next, component);
  const missingCertification =
    (template === "inspection" && !inspectionEntryReady(inspection)) ||
    (template === "component" && !component.approvedForReturnToService);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to export entry.");
    } finally {
      setBusy(false);
    }
  };
  const validLicense = () =>
    licenseSchema.parse({ licenseNumber, certificateType });
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
      <div className="form-grid">
        <Field label="Logbook template">
          <select
            value={template}
            onChange={(e) => {
              const selected = e.target.value as LogbookTemplate;
              setTemplate(selected);
            }}
          >
            {Object.entries(logbookTemplates).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Certifying person">
          <input value={s!.user.name} readOnly />
        </Field>
        {choices.length > 0 && (
          <Field label="Use saved certification">
            <select
              value={
                choices.find(
                  (c) =>
                    c.licenseNumber === licenseNumber &&
                    c.certificateType === certificateType,
                )?.key ?? ""
              }
              onChange={(e) => {
                const selected = choices.find((c) => c.key === e.target.value);
                if (!selected) return;
                setLicense(selected.licenseNumber);
                setCertificate(selected.certificateType);
                updateDraftCredentials(
                  selected.licenseNumber,
                  selected.certificateType,
                );
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
        )}
        <Field label="License / certificate number">
          <input
            maxLength={100}
            value={licenseNumber}
            onChange={(e) => {
              setLicense(e.target.value);
              updateDraftCredentials(e.target.value, certificateType);
            }}
          />
        </Field>
        <Field label="Certificate type">
          <input
            placeholder="e.g. A&P, IA, AME"
            maxLength={100}
            value={certificateType}
            onChange={(e) => {
              setCertificate(e.target.value);
              updateDraftCredentials(licenseNumber, e.target.value);
            }}
          />
        </Field>
      </div>
      {template === "inspection" && (
        <>
          <div className="form-grid">
            <Field label="Inspection type">
              <select
                value={inspection.type}
                onChange={(e) =>
                  updateInspection({
                    ...inspection,
                    type: e.target.value as InspectionEntry["type"],
                  })
                }
              >
                <option value="annual">Annual</option>
                <option value="100-hour">100-Hour</option>
              </select>
            </Field>
            <Field label="Manufacturer's inspection checklist">
              <input
                value={inspection.checklist}
                placeholder="Manufacturer, checklist and revision"
                onChange={(e) =>
                  updateInspection({ ...inspection, checklist: e.target.value })
                }
              />
            </Field>
            <Field label="AD / SB checked through">
              <input
                value={inspection.reviewedThrough}
                placeholder="Review date or bi-weekly issue"
                onChange={(e) =>
                  updateInspection({
                    ...inspection,
                    reviewedThrough: e.target.value,
                  })
                }
              />
            </Field>
            <Field label="Inspection finding">
              <select
                value={inspection.airworthy ? "airworthy" : ""}
                onChange={(e) =>
                  updateInspection({
                    ...inspection,
                    airworthy: e.target.value === "airworthy",
                  })
                }
              >
                <option value="">Select finding</option>
                <option value="airworthy">
                  Airworthy — approved for return to service
                </option>
              </select>
            </Field>
          </div>
          <p>
            This template is for an airworthy finding. Enter the checklist and
            AD/SB review cutoff before exporting. Include your actual
            certificate type and authorization in the certificate field.
          </p>
        </>
      )}
      {template === "component" && (
        <Field label="Return-to-service outcome">
          <select
            value={component.approvedForReturnToService ? "approved" : ""}
            onChange={(e) =>
              updateEntry(inspection, {
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
      )}
      {template === "inspection" && inspection.type === "annual" && (
        <p>
          For an annual signed as an A&amp;P mechanic, include your IA
          authorization (for example, A&amp;P IA).
        </p>
      )}
      {s!.user.certifications === undefined && (
        <button
          type="button"
          className="button"
          disabled={busy || !online || !connected}
          onClick={() =>
            void run(async () => {
              const license = validLicense();
              await backend!.saveLicense(
                license.licenseNumber,
                license.certificateType,
              );
              setMessage("License saved to your profile.");
            })
          }
        >
          Save license to my profile
        </button>
      )}
      <Field label="Logbook entry text">
        <textarea
          rows={22}
          value={text}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="form-footer">
        <button
          type="button"
          className="button primary"
          disabled={
            busy ||
            missingCertification ||
            !licenseNumber.trim() ||
            !certificateType.trim() ||
            !text.trim()
          }
          onClick={() =>
            void run(async () => {
              validLicense();
              const { logbookPdf } = await import("../data/logbookPdf");
              const pdf = await logbookPdf(text);
              pdf.save(
                `${order.number.replace(/[^a-zA-Z0-9_-]/g, "_")}-logbook.pdf`,
              );
              setMessage("PDF saved.");
            })
          }
        >
          Save as PDF
        </button>
        <button
          type="button"
          className="button"
          disabled={
            busy ||
            missingCertification ||
            !licenseNumber.trim() ||
            !certificateType.trim() ||
            !text.trim()
          }
          onClick={() =>
            void run(async () => {
              validLicense();
              await navigator.clipboard.writeText(text);
              setMessage("Logbook entry copied.");
            })
          }
        >
          Copy text
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </>
  );
}
