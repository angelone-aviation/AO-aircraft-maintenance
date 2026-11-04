/**
 * Responsibility: Job cards: the job cards screen, the cards on work items and
 *   work orders, and editing, signing and evidence files for one card.
 * Layer: UI. React components; job card rules live in src/domain.
 * Dependencies: react, react-dom, zod (ZodError), src/data/store.ts,
 *   src/domain (model, ata, management, programs, shelfLife, signTaskCard,
 *   taskCardValidation, taskCardZone, taskCards, workOrderCards, workOrders),
 *   ./PartsRequests, ./WorkOrderRevisions, ./LogbookWording, ./TaskCsvImport,
 *   ./Manuals, ./ui.
 */
import { ZodError } from "zod";
import { RequestPartsButton } from "./PartsRequests";
import { localDate } from "../domain/model";
import { WorkOrderRevisions } from "./WorkOrderRevisions";
import { taskCardZone as cardZone } from "../domain/taskCardZone";
import { signTaskCard } from "../domain/signTaskCard";
import {
  taskCardSaveWarnings,
  taskCardSigningWarnings,
  taskCardValidationMessages,
} from "../domain/taskCardValidation";
import { LogbookWording } from "./LogbookWording";
import { recordProgram } from "../domain/programs";
import type { Stock } from "../domain/management";
import { expiredForUse, usableQuantity } from "../domain/shelfLife";
import { taskCardMatchesWorkItem } from "../domain/workOrderCards";
import type { WorkTask } from "../domain/workOrders";
import { TaskCsvImportButton } from "./TaskCsvImport";
import { ManualReferenceFields } from "./Manuals";
import { useState } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can } from "../domain/model";
import { ATA_GROUPS, ataLabel } from "../domain/ata";
import { isOpenWorkOrder, validateWorkOrderFile } from "../domain/workOrders";
import {
  applyTaskLink,
  canUnlinkTaskCard,
  evidenceCategories,
  evidenceRemovable,
  inspectorCertificateProblem,
  inspectorCertificateRequired,
  isTaskClosed,
  isTaskTemplate,
  linkField,
  taskCardDefaults,
  taskCardFieldsSchema,
  taskCardStatuses,
  taskWritable,
  type TaskCard,
  type TaskCardFields,
  type TaskLink,
  type TaskPart,
} from "../domain/taskCards";
import {
  AsyncForm,
  DeleteFileButton,
  Empty,
  Field,
  Modal,
  PageTitle,
  errorText,
  value,
} from "./ui";
const label = (s: string) => s.replaceAll("-", " ");
const nullableNumber = (s: string) => (s === "" ? null : Number(s));
type Selection = { uuid?: string; defaults?: TaskCardFields };
const compareCardZones = (a: TaskCard, b: TaskCard) => {
  const az = cardZone(a),
    bz = cardZone(b);
  if (!az || !bz)
    return az
      ? -1
      : bz
        ? 1
        : a.cardNumber.localeCompare(b.cardNumber, undefined, {
            numeric: true,
          });
  return (
    az.localeCompare(bz, undefined, { numeric: true, sensitivity: "base" }) ||
    a.cardNumber.localeCompare(b.cardNumber, undefined, { numeric: true })
  );
};
type CardOrder = "zone" | "number";
function CardOrderSelect({
  value,
  onChange,
}: {
  value: CardOrder;
  onChange: (value: CardOrder) => void;
}) {
  return (
    <div className="job-card-order">
      <Field label="Order by">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as CardOrder)}
        >
          <option value="zone">Zone</option>
          <option value="number">Card number</option>
        </select>
      </Field>
    </div>
  );
}
const compareCardNumbers = (a: TaskCard, b: TaskCard) =>
  a.cardNumber.localeCompare(b.cardNumber, undefined, { numeric: true });

function CardPreview({ card }: { card: TaskCard }) {
  const description = card.description.replace(/\s+/g, " ").trim();
  return (
    <small className="block muted">
      <strong>Zone: {cardZone(card) || "Unspecified"}</strong>
      {description && (
        <span className="block">
          {description.length > 160
            ? `${description.slice(0, 157)}…`
            : description}
        </span>
      )}
    </small>
  );
}

function JobCardStatus({ card }: { card: TaskCard }) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writable =
    !!snapshot &&
    !!backend &&
    online &&
    connected &&
    taskWritable(snapshot, card);
  const statuses = isTaskTemplate(card)
    ? (["draft", "canceled"] as const)
    : taskCardStatuses;

  return (
    <>
      <select
        className="job-card-status-select"
        aria-label={`Task status for ${card.cardNumber}`}
        aria-busy={busy}
        title={label(card.status)}
        value={card.status}
        disabled={!writable || busy}
        onChange={async (event) => {
          const status = event.target.value as TaskCardFields["status"];
          if (!backend || !writable || status === card.status) return;
          setBusy(true);
          setError("");
          try {
            await backend.taskCard({
              action: "save",
              uuid: card.uuid,
              version: card.version,
              fields: { ...taskCardFieldsSchema.parse(card), status },
            });
          } catch (error) {
            setError(cardErrorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        {statuses.map((status) => (
          <option key={status} value={status}>
            {label(status)}
          </option>
        ))}
      </select>
      {error && (
        <small className="job-card-status-error error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}

function JobCardSignoffs({ card }: { card: TaskCard }) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const [busy, setBusy] = useState<"technician" | "inspection">();
  const [error, setError] = useState("");
  const writable =
    !!snapshot &&
    !!backend &&
    online &&
    connected &&
    taskWritable(snapshot, card);
  const sameSigner = card.technicianSignoff?.userId === snapshot?.user.id;
  // Why this user cannot sign as inspector, if they cannot.
  const certificateProblem = snapshot
    ? inspectorCertificateProblem(snapshot.user, localDate())
    : inspectorCertificateRequired;
  const certified = !certificateProblem;

  async function sign(kind: "technician" | "inspection") {
    if (!backend || !writable || busy) return;
    setBusy(kind);
    setError("");
    try {
      await signTaskCard(card, kind, (command) => backend.taskCard(command));
    } catch (error) {
      setError(cardErrorText(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div
      className="job-card-summary-signoffs"
      aria-label={`Signoffs for ${card.cardNumber}`}
    >
      {isTaskTemplate(card) ? (
        <small className="muted">Sign on the work-order copy.</small>
      ) : (
        <>
          <button
            type="button"
            className="button small"
            disabled={
              !writable ||
              !!busy ||
              card.status === "draft" ||
              !!card.technicianSignoff
            }
            onClick={() => void sign("technician")}
            title={
              card.technicianSignoff
                ? `${card.technicianSignoff.name} · ${new Date(card.technicianSignoff.at).toLocaleString()}`
                : "Record technician signoff"
            }
          >
            {busy === "technician"
              ? "Signing…"
              : card.technicianSignoff
                ? "Technician signed"
                : "Technician signoff"}
          </button>
          <button
            type="button"
            className="button small"
            disabled={
              !writable ||
              !!busy ||
              card.status === "draft" ||
              !card.technicianSignoff ||
              !!card.inspectionSignoff ||
              sameSigner ||
              !certified
            }
            onClick={() => void sign("inspection")}
            title={
              card.inspectionSignoff
                ? `${card.inspectionSignoff.name} · ${new Date(card.inspectionSignoff.at).toLocaleString()}`
                : certificateProblem
                  ? certificateProblem
                  : sameSigner
                    ? "Inspection must be signed by a different person"
                    : !card.technicianSignoff
                      ? "Technician signoff is required first"
                      : "Record inspection signoff"
            }
          >
            {busy === "inspection"
              ? "Signing…"
              : card.inspectionSignoff
                ? "Inspection signed"
                : "Inspection signoff"}
          </button>
          {error && (
            <small className="error" role="alert">
              {error}
            </small>
          )}
        </>
      )}
    </div>
  );
}

export function TaskCards() {
  const { snapshot: state, online, connected } = useWorkspace();
  const s = state!;
  const [selected, setSelected] = useState<Selection>();
  const [aircraft, setAircraft] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [orderBy, setOrderBy] = useState<CardOrder>("zone");
  const rows = (s.taskCards ?? [])
    .filter(
      (t) =>
        (!aircraft || t.aircraftUuid === aircraft) &&
        (!status ||
          (status === "template"
            ? isTaskTemplate(t)
            : !isTaskTemplate(t) && t.status === status)) &&
        `${t.cardNumber} ${t.title}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(orderBy === "zone" ? compareCardZones : compareCardNumbers);
  return (
    <>
      <PageTitle
        eyebrow="MAINTENANCE"
        title="Job cards"
        description="Instructions, notes, work results, parts and signoffs for individual maintenance tasks."
        action={
          <button
            className="button primary"
            disabled={
              !online ||
              !connected ||
              !s.aircraft.some((a) => can(s, a.uuid, "maintenance"))
            }
            onClick={() => setSelected({})}
          >
            New job card
          </button>
        }
      />
      <TaskCsvImportButton />
      <div className="management-toolbar">
        <Field label="Aircraft">
          <select
            value={aircraft}
            onChange={(e) => setAircraft(e.target.value)}
          >
            <option value="">All aircraft</option>
            {s.aircraft.map((a) => (
              <option key={a.uuid} value={a.uuid}>
                {a.registration}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Task status filter">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="template">Reusable templates</option>
            {taskCardStatuses.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </Field>
        <CardOrderSelect value={orderBy} onChange={setOrderBy} />
        <Field label="Search job cards">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
      </div>
      {(!online || !connected) && (
        <p className="notice">
          Cached job cards are available. Reconnect to edit, sign or upload
          evidence.
        </p>
      )}
      {rows.length ? (
        <div className="panel table-wrap">
          <table className="job-card-summary-table">
            <thead>
              <tr>
                <th>Task status</th>
                <th>Card / title</th>
                <th>Aircraft / work order</th>
                <th>ATA chapter</th>
                <th>Signoffs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.uuid}>
                  <td>
                    <JobCardStatus card={t} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      aria-label={`Details for ${t.cardNumber}`}
                      onClick={() => setSelected({ uuid: t.uuid })}
                    >
                      <strong>{t.cardNumber}</strong> · {t.title}
                    </button>
                    <CardPreview card={t} />
                  </td>
                  <td>
                    {
                      s.aircraft.find((a) => a.uuid === t.aircraftUuid)
                        ?.registration
                    }
                    <br />
                    {s.workOrders?.find((w) => w.uuid === t.workOrderUuid)
                      ?.number ?? "Unassigned"}
                  </td>
                  <td>{ataLabel(t.ataChapter)}</td>
                  <td>
                    <JobCardSignoffs card={t} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // Without rows the table would still scroll sideways at narrow widths
        // with nothing focusable in it, so show only the empty state.
        <div className="panel">
          <Empty title="No job cards">
            Create a card here or add one from an inspection, service
            requirement or discrepancy.
          </Empty>
        </div>
      )}
      {selected && (
        <TaskCardDialog
          selection={selected}
          onSelect={setSelected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
export function WorkItemJobCards({
  workOrderUuid,
  item,
}: {
  workOrderUuid: string;
  item: WorkTask;
}) {
  const { snapshot: s } = useWorkspace();
  const [selected, setSelected] = useState<Selection>();
  const [orderBy, setOrderBy] = useState<CardOrder>("zone");
  const cards = (s?.taskCards ?? [])
    .filter(
      (card) =>
        card.workOrderUuid === workOrderUuid &&
        taskCardMatchesWorkItem(card, item),
    )
    .sort(orderBy === "zone" ? compareCardZones : compareCardNumbers);
  return (
    <details
      className="work-item-job-cards"
      aria-label={`Job cards for ${item.description}`}
    >
      <summary>Job cards ({cards.length})</summary>

      <div className="job-card-list-heading">
        <CardOrderSelect value={orderBy} onChange={setOrderBy} />
      </div>
      {cards.length ? (
        <ul className="job-card-summary-list">
          {cards.map((card) => (
            <li key={card.uuid}>
              <span className="job-card-summary-status">
                <JobCardStatus card={card} />
              </span>
              <div className="job-card-summary-content">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSelected({ uuid: card.uuid })}
                >
                  {card.cardNumber} · {card.title}
                </button>
                <CardPreview card={card} />
                <small className="block muted">
                  Technician: {card.technicianSignoff ? "Signed" : "Pending"}
                  {card.inspectionSignoffRequired &&
                    ` · Inspection: ${card.inspectionSignoff ? "Signed" : "Pending"}`}
                </small>
              </div>
              <JobCardSignoffs card={card} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No job cards linked to this item.</p>
      )}
      {selected && (
        <TaskCardDialog
          selection={selected}
          onSelect={setSelected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </details>
  );
}
export function LinkedTaskCards({
  aircraftUuid,
  link,
}: {
  aircraftUuid: string;
  link: TaskLink;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<Selection>();
  const [orderBy, setOrderBy] = useState<CardOrder>("zone");
  const [removing, setRemoving] = useState(false);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  if (!s) return null;
  const cards = (s.taskCards ?? [])
    .filter(
      (t) =>
        t.aircraftUuid === aircraftUuid &&
        t[linkField[link.kind]] === link.uuid &&
        (link.kind === "workOrder" || !t.workOrderUuid),
    )
    .sort(orderBy === "zone" ? compareCardZones : compareCardNumbers);
  const available = (s.taskCards ?? [])
    .filter(
      (t) =>
        t.aircraftUuid === aircraftUuid &&
        !t[linkField[link.kind]] &&
        (link.kind === "workOrder" ? !isTaskTemplate(t) : !t.workOrderUuid) &&
        taskWritable(s, t),
    )
    .sort(orderBy === "zone" ? compareCardZones : compareCardNumbers);
  const parentOpen =
    link.kind !== "workOrder" ||
    s.workOrders?.some((w) => w.uuid === link.uuid && isOpenWorkOrder(w));
  const writable =
    online && connected && can(s, aircraftUuid, "maintenance") && parentOpen;
  const removable = cards.filter((card) => canUnlinkTaskCard(s, card, link));
  async function removeSelected() {
    if (!backend || !writable || removeBusy) return;
    setRemoveBusy(true);
    setRemoveError("");
    try {
      for (const id of removeIds) {
        const card = s!.taskCards?.find((item) => item.uuid === id);
        if (!card || !canUnlinkTaskCard(s!, card, link))
          throw new Error(
            "A selected card changed. Review the remaining selection.",
          );
        await backend.taskCard({
          action: "unlink",
          uuid: card.uuid,
          version: card.version,
          link,
        });
        setRemoveIds((current) =>
          current.filter((selected) => selected !== id),
        );
      }
      setRemoving(false);
    } catch (error) {
      setRemoveError(cardErrorText(error));
    } finally {
      setRemoveBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="button small"
        onClick={() => setOpen(true)}
      >
        {link.kind === "workOrder" ? "Job cards" : "Job card templates"} (
        {cards.length})
      </button>
      {open &&
        createPortal(
          <div onSubmit={(e) => e.stopPropagation()}>
            <Modal
              title={
                link.kind === "workOrder"
                  ? "Work-order job cards"
                  : "Linked job card templates"
              }
              onClose={() => setOpen(false)}
            >
              {link.kind !== "workOrder" && (
                <p>
                  These are reusable instructions. Adding this source to a work
                  order creates independent job cards for that order.
                </p>
              )}
              <CardOrderSelect value={orderBy} onChange={setOrderBy} />
              {link.kind !== "workOrder" && (
                <div className="job-card-remove-controls">
                  {!removing ? (
                    <button
                      type="button"
                      className="button"
                      disabled={!writable || !removable.length}
                      onClick={() => {
                        setRemoving(true);
                        setRemoveIds([]);
                        setRemoveError("");
                      }}
                    >
                      Remove job cards
                    </button>
                  ) : (
                    <>
                      <p>
                        Select cards to remove from this linked item. Cards
                        remain available to link again; existing work-order
                        copies are unchanged.
                      </p>
                      <div className="job-card-remove-actions">
                        <button
                          type="button"
                          className="button small"
                          disabled={removeBusy || !writable}
                          onClick={() =>
                            setRemoveIds(removable.map((card) => card.uuid))
                          }
                        >
                          Select all removable
                        </button>
                        <button
                          type="button"
                          className="button primary"
                          disabled={
                            removeBusy || !writable || !removeIds.length
                          }
                          onClick={() => void removeSelected()}
                        >
                          {removeBusy
                            ? "Removing…"
                            : `Remove selected (${removeIds.length})`}
                        </button>
                        <button
                          type="button"
                          className="button"
                          disabled={removeBusy}
                          onClick={() => {
                            setRemoving(false);
                            setRemoveIds([]);
                            setRemoveError("");
                          }}
                        >
                          Cancel removal
                        </button>
                      </div>
                      {removeError && (
                        <p className="error" role="alert">
                          {removeError}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              <ul className="job-card-summary-list">
                {cards.map((t) => (
                  <li key={t.uuid}>
                    <span className="job-card-summary-status">
                      <JobCardStatus card={t} />
                    </span>
                    <div className="job-card-summary-content">
                      {removing && (
                        <label className="job-card-remove-choice">
                          <input
                            type="checkbox"
                            aria-label={`Remove ${t.cardNumber} from linked item`}
                            checked={removeIds.includes(t.uuid)}
                            disabled={
                              removeBusy ||
                              !writable ||
                              !canUnlinkTaskCard(s, t, link)
                            }
                            onChange={(event) =>
                              setRemoveIds((current) =>
                                event.target.checked
                                  ? [...current, t.uuid]
                                  : current.filter((id) => id !== t.uuid),
                              )
                            }
                          />
                          {canUnlinkTaskCard(s, t, link)
                            ? "Select to remove"
                            : "Cannot remove recorded or closed work"}
                        </label>
                      )}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setSelected({ uuid: t.uuid })}
                      >
                        {t.cardNumber} · {t.title}
                      </button>
                      <CardPreview card={t} />
                    </div>
                    <JobCardSignoffs card={t} />
                  </li>
                ))}
              </ul>
              {!cards.length && <p>No job cards linked yet.</p>}
              <button
                type="button"
                className="button primary"
                disabled={!writable}
                onClick={() =>
                  setSelected({
                    defaults: applyTaskLink(
                      s,
                      taskCardDefaults(aircraftUuid),
                      link,
                    ),
                  })
                }
              >
                {link.kind === "workOrder"
                  ? "Create linked job card"
                  : "Create job card template"}
              </button>
              {!!available.length && (
                <AsyncForm
                  submitLabel={
                    link.kind === "workOrder"
                      ? "Add existing job card"
                      : "Add existing job card template"
                  }
                  disabled={!writable}
                  onSubmit={async (data) => {
                    const t = available.find(
                      (t) => t.uuid === value(data, "task"),
                    )!;
                    await backend!.taskCard({
                      action: "link",
                      uuid: t.uuid,
                      version: t.version,
                      link,
                    });
                  }}
                >
                  <Field label="Existing job card">
                    <select name="task">
                      {available.map((t) => (
                        <option key={t.uuid} value={t.uuid}>
                          {t.cardNumber} · {t.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                </AsyncForm>
              )}
            </Modal>
          </div>,
          document.body,
        )}
      {selected && (
        <TaskCardDialog
          selection={selected}
          onSelect={setSelected}
          onClose={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
export function ArchivedJobCardButton({ card }: { card: TaskCard }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="text-button"
        onClick={() => setOpen(true)}
      >
        {card.cardNumber} · {card.title}
      </button>
      {open && (
        <TaskCardDialog
          selection={{ uuid: card.uuid }}
          onSelect={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function TaskCardDialog({
  selection,
  onSelect,
  onClose,
}: {
  selection: Selection;
  onSelect: (s: Selection) => void;
  onClose: () => void;
}) {
  const { snapshot: s } = useWorkspace();
  const card = selection.uuid
    ? [...(s?.taskCards ?? []), ...(s?.archivedTaskCards ?? [])].find(
        (t) => t.uuid === selection.uuid,
      )
    : undefined;
  return createPortal(
    <div onSubmit={(e) => e.stopPropagation()}>
      <Modal
        className="job-card-modal"
        title={card ? `Job card ${card.cardNumber}` : "New job card"}
        onClose={onClose}
      >
        <TaskCardEditor
          key={card ? `${card.uuid}:${card.version}` : "new"}
          initial={card}
          defaults={selection.defaults}
          onSaved={(uuid) => onSelect({ uuid })}
          onClose={onClose}
        />
      </Modal>
    </div>,
    document.body,
  );
}
function TaskCardEditor({
  initial,
  defaults,
  onSaved,
  onClose,
}: {
  initial?: TaskCard;
  defaults?: TaskCardFields;
  onSaved: (uuid: string) => void;
  onClose: () => void;
}) {
  const { snapshot: state, backend, online, connected } = useWorkspace();
  const s = state!;
  const [uuid] = useState(initial?.uuid ?? crypto.randomUUID());
  const [f, setFields] = useState<TaskCardFields>(
    initial
      ? taskCardFieldsSchema.parse(initial)
      : (defaults ??
          taskCardDefaults(
            s.aircraft.find((a) => can(s, a.uuid, "maintenance"))?.uuid ?? "",
          )),
  );
  const [revising, setRevising] = useState(false);
  const revisionOrder = initial?.workOrderUuid
    ? s.workOrders?.find((order) => order.uuid === initial.workOrderUuid)
    : undefined;
  const canRevise =
    !!revisionOrder &&
    !isOpenWorkOrder(revisionOrder) &&
    online &&
    connected &&
    can(s, f.aircraftUuid, "maintenance");
  const archived =
    !!initial &&
    !!s.archivedTaskCards?.some((card) => card.uuid === initial.uuid);
  const template = isTaskTemplate(f);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const change = <K extends keyof TaskCardFields>(
    key: K,
    v: TaskCardFields[K],
  ) => setFields({ ...f, [key]: v });
  const writable =
    online &&
    connected &&
    can(s, f.aircraftUuid, "maintenance") &&
    (!initial || taskWritable(s, initial));
  const dirty =
    !initial ||
    JSON.stringify(taskCardFieldsSchema.parse(initial)) !== JSON.stringify(f);
  const saveWarnings = writable
    ? taskCardSaveWarnings(s, uuid, f, initial)
    : [];
  const signingWarnings =
    !template && writable ? taskCardSigningWarnings(f, dirty, initial) : [];
  const certificateProblem = inspectorCertificateProblem(s.user, localDate());
  const certified = !certificateProblem;
  const components = (s.management ?? []).filter(
    (c) =>
      c.kind === "component" &&
      c.aircraftUuid === f.aircraftUuid &&
      (c.installed || c.uuid === f.componentUuid),
  );
  const programUuid = s.aircraft.find(
    (a) => a.uuid === f.aircraftUuid,
  )?.programUuid;
  const stockItems = (s.management ?? []).filter(
    (r): r is Stock =>
      r.kind === "stock" && recordProgram(s, r) === programUuid,
  );
  const locations = (s.management ?? []).filter(
    (r) => r.kind === "location" && recordProgram(s, r) === programUuid,
  );
  const requirements = (s.management ?? []).filter(
    (r) =>
      r.kind === "componentRequirement" && r.componentUuid === f.componentUuid,
  );
  const textField = (
    name: string,
    key: keyof TaskCardFields,
    multiline = false,
  ) => (
    <Field
      label={name}
      hint={
        key === "actualWork"
          ? "Used for the log book entry. Optional — not required to save or sign."
          : undefined
      }
    >
      {multiline ? (
        <textarea
          value={String(f[key] ?? "")}
          disabled={
            template &&
            [
              "findings",
              "actualWork",
              "measurements",
              "functionalTestResults",
            ].includes(key)
          }
          maxLength={10000}
          onChange={(e) => setFields({ ...f, [key]: e.target.value })}
        />
      ) : (
        <input
          value={String(f[key] ?? "")}
          disabled={
            template &&
            [
              "findings",
              "actualWork",
              "measurements",
              "functionalTestResults",
            ].includes(key)
          }
          maxLength={key === "cardNumber" ? 100 : 10000}
          onChange={(e) => setFields({ ...f, [key]: e.target.value })}
        />
      )}
    </Field>
  );
  const selectLink = (
    name: string,
    key:
      | "inspectionUuid"
      | "componentUuid"
      | "requirementUuid"
      | "discrepancyUuid"
      | "workOrderUuid",
    items: { uuid: string; name: string }[],
    disabled = false,
  ) => (
    <Field label={name}>
      <select
        value={f[key]}
        disabled={
          disabled ||
          (!!initial &&
            ((isTaskTemplate(initial) &&
              (key === "workOrderUuid" || !!initial[key])) ||
              !!initial.sourceTaskCardUuid))
        }
        onChange={(e) => {
          const v = e.target.value;
          if (key === "componentUuid")
            setFields({ ...f, componentUuid: v, requirementUuid: "" });
          else change(key, v);
        }}
      >
        <option value="">None</option>
        {f[key] && !items.some((i) => i.uuid === f[key]) && (
          <option value={f[key]}>Previously linked record</option>
        )}
        {items.map((i) => (
          <option key={i.uuid} value={i.uuid}>
            {i.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const updatePart = (id: string, patch: Partial<TaskPart>) =>
    change(
      "partsUsed",
      f.partsUsed.map((x) => (x.uuid === id ? { ...x, ...patch } : x)),
    );
  async function sign(
    kind: "technician" | "inspection" | "step",
    stepUuid?: string,
  ) {
    if (!initial) return;
    setBusy(true);
    setError("");
    try {
      await signTaskCard(
        initial,
        kind,
        (command) => backend!.taskCard(command),
        stepUuid,
      );
    } catch (e) {
      setError(cardErrorText(e));
    } finally {
      setBusy(false);
    }
  }
  const signature = (sig: TaskCard["technicianSignoff"]) =>
    sig ? `${sig.name} · ${new Date(sig.at).toLocaleString()}` : "Not signed";
  return (
    <>
      {initial && !archived && (
        <RequestPartsButton
          source={{ kind: "jobCard", uuid: initial.uuid, workOrderUuid: "" }}
        />
      )}
      {archived && (
        <p className="notice">
          Archived job card — original work, signatures, and attachments are
          preserved. This record is read-only.
        </p>
      )}
      {!archived && initial?.status === "completed" && (
        <div className="job-card-revision-action">
          <button
            type="button"
            className="button"
            disabled={!canRevise}
            onClick={() => setRevising(true)}
          >
            Revise
          </button>
          <p className="muted">
            {revisionOrder && isOpenWorkOrder(revisionOrder)
              ? "Written-record revisions are available after the work order is closed."
              : "Correct the work order’s written record with a reason. The original job card and signatures are preserved."}
          </p>
        </div>
      )}
      {revising &&
        revisionOrder &&
        createPortal(
          <Modal
            title={`Revise written record · ${initial?.cardNumber}`}
            onClose={() => setRevising(false)}
            wide
          >
            <p>
              Work order {revisionOrder.number}. This revises the work order’s
              written record, including log book wording.
            </p>
            <WorkOrderRevisions
              key={revisionOrder.version}
              order={revisionOrder}
              initiallyEditing
              onDone={() => setRevising(false)}
            />
          </Modal>,
          document.body,
        )}

      {template && (
        <details className="job-card-help">
          <summary>About this reusable template</summary>
          <p>
            Reusable job card template. Add its inspection, service requirement
            or discrepancy to a work order to create a job card for recording
            results and signoffs.
          </p>
        </details>
      )}
      {initial?.sourceTaskCardUuid && (
        <p>
          Work-order copy of template{" "}
          {s.taskCards?.find((t) => t.uuid === initial.sourceTaskCardUuid)
            ?.cardNumber ?? initial.sourceTaskCardUuid}
          , version {initial.sourceTaskCardVersion}. Template edits do not
          change this copy.
        </p>
      )}
      {!!saveWarnings.length && (
        <div className="notice" role="alert">
          <strong>Before saving:</strong>
          <ul>
            {saveWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {!!signingWarnings.length && (
        <div className="notice" role="status">
          <strong>Before signing:</strong>
          <ul>
            {signingWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <AsyncForm
        submitLabel={template ? "Save job card template" : "Save job card"}
        onClose={onClose}
        disabled={!writable || busy}
        onSubmit={async () => {
          if (saveWarnings.length) throw new Error(saveWarnings.join("\n"));
          await backend!.taskCard({
            action: "save",
            uuid,
            version: initial?.version ?? 0,
            fields: f,
          });
          onSaved(uuid);
        }}
      >
        <div className="job-card-header-fields">
          <Field label="Aircraft">
            <select
              value={f.aircraftUuid}
              disabled={!!initial || !!defaults}
              onChange={(e) =>
                setFields({
                  ...taskCardDefaults(e.target.value),
                  cardNumber: f.cardNumber,
                  title: f.title,
                })
              }
            >
              {s.aircraft
                .filter((a) => !!initial || can(s, a.uuid, "maintenance"))
                .map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.registration}
                  </option>
                ))}
            </select>
          </Field>
          {textField("Card number (automatic if blank)", "cardNumber")}
          {textField("Title", "title")}
          <Field label="ATA chapter">
            <select
              value={f.ataChapter ?? ""}
              onChange={(e) =>
                change(
                  "ataChapter",
                  (e.target.value as TaskCardFields["ataChapter"]) || undefined,
                )
              }
            >
              <option value="">Unassigned</option>
              {ATA_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.chapters.map(([code, name]) => (
                    <option key={code} value={code}>
                      {code} · {name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Task status">
            <select
              value={f.status}
              disabled={!initial}
              onChange={(e) =>
                change("status", e.target.value as TaskCardFields["status"])
              }
            >
              {(template
                ? (["draft", "canceled"] as const)
                : taskCardStatuses
              ).map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </Field>
          {selectLink(
            "Work order",
            "workOrderUuid",
            (s.workOrders ?? [])
              .filter(
                (w) =>
                  w.aircraftUuid === f.aircraftUuid &&
                  (isOpenWorkOrder(w) || w.uuid === f.workOrderUuid),
              )
              .map((w) => ({ uuid: w.uuid, name: w.number })),
            !!initial?.workOrderUuid || template,
          )}
        </div>
        <div className="job-card-workspace">
          <details open className="job-card-panel job-card-instructions">
            <summary>Instructions and maintenance data</summary>
            {textField("Description", "description", true)}
            {textField("Applicability", "applicability", true)}
            <LogbookWording
              included={f.includeInLogbook}
              phrase={f.logbookPhrase}
              onChange={(patch) =>
                setFields((current) => ({ ...current, ...patch }))
              }
            />
            {/* References are part of the job card itself; the checkbox above only controls log book inclusion. */}
            {textField("Maintenance-data reference", "maintenanceReference")}
            <ManualReferenceFields
              initial={f.manualReference}
              onChange={(ref) => change("manualReference", ref)}
            />
            <div className="form-grid">
              {textField("Reference revision", "referenceRevision")}
              <Field label="Reference date">
                <input
                  type="date"
                  value={f.referenceDate}
                  onChange={(e) => change("referenceDate", e.target.value)}
                />
              </Field>
            </div>
          </details>
          <details open className="job-card-panel job-card-links">
            <summary>Linked records</summary>
            <div className="job-card-linked-fields">
              {selectLink(
                "Inspection",
                "inspectionUuid",
                s.inspections
                  .filter(
                    (i) =>
                      i.aircraftUuid === f.aircraftUuid &&
                      (!i.archived || i.uuid === f.inspectionUuid),
                  )
                  .map((i) => ({
                    uuid: i.uuid,
                    name: `${i.reference}: ${i.description}`,
                  })),
              )}
              {selectLink(
                "Component",
                "componentUuid",
                components.map((c) => ({
                  uuid: c.uuid,
                  name:
                    c.kind === "component"
                      ? `${c.componentType} · ${c.serial}`
                      : "",
                })),
              )}
              {selectLink(
                "Component service requirement",
                "requirementUuid",
                requirements.map((r) => ({
                  uuid: r.uuid,
                  name: r.kind === "componentRequirement" ? r.description : "",
                })),
              )}
              {selectLink(
                "Originating discrepancy",
                "discrepancyUuid",
                s.discrepancies
                  .filter(
                    (d) =>
                      d.aircraftUuid === f.aircraftUuid &&
                      (d.status === "open" || d.uuid === f.discrepancyUuid),
                  )
                  .map((d) => ({ uuid: d.uuid, name: d.description })),
              )}
            </div>
          </details>
        </div>
        <details>
          <summary>Parts used and component changes</summary>
          <fieldset disabled={template}>
            {f.partsUsed.map((part, index) => (
              <div className="panel" key={part.uuid}>
                <h3>Part {index + 1}</h3>
                <Field label={`Part ${index + 1} source`}>
                  <select
                    value={part.source ?? "non-stock"}
                    onChange={(e) =>
                      updatePart(part.uuid, {
                        source: e.target.value as "stock" | "non-stock",
                        stockUuid: "",
                        locationUuid: "",
                      })
                    }
                  >
                    <option value="non-stock">Non-stock item</option>
                    <option value="stock">Inventory stock</option>
                  </select>
                </Field>
                {part.source === "stock" && (
                  <>
                    <Field label={`Part ${index + 1} inventory location`}>
                      <select
                        required
                        value={part.locationUuid ?? ""}
                        onChange={(e) =>
                          updatePart(part.uuid, {
                            locationUuid: e.target.value,
                            stockUuid: "",
                          })
                        }
                      >
                        <option value="">Select location</option>
                        {part.locationUuid &&
                          !locations.some(
                            (r) => r.uuid === part.locationUuid,
                          ) && (
                            <option value={part.locationUuid}>
                              Previously linked inventory location
                            </option>
                          )}
                        {locations.map((location) => (
                          <option key={location.uuid} value={location.uuid}>
                            {location.kind === "location" ? location.name : ""}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label={`Part ${index + 1} stock item`}>
                      <select
                        required
                        value={part.stockUuid ?? ""}
                        onChange={(e) => {
                          const stock = stockItems.find(
                            (r) => r.uuid === e.target.value,
                          );
                          updatePart(part.uuid, {
                            stockUuid: stock?.uuid ?? "",
                            partNumber: stock?.partNumber ?? "",
                            description: stock?.description ?? "",
                          });
                        }}
                      >
                        <option value="">Select stock item</option>
                        {part.stockUuid &&
                          !stockItems.some(
                            (r) => r.uuid === part.stockUuid,
                          ) && (
                            <option value={part.stockUuid}>
                              {part.partNumber} · Previously linked stock item
                            </option>
                          )}
                        {stockItems
                          .filter(
                            (stock) => stock.locationUuid === part.locationUuid,
                          )
                          .map((stock) => {
                            // Expired lots cannot be issued, so they cannot be
                            // chosen; a lot linked before it expired stays.
                            const expired = expiredForUse(stock.expirationDate);
                            return (
                              <option
                                key={stock.uuid}
                                value={stock.uuid}
                                disabled={
                                  expired && stock.uuid !== part.stockUuid
                                }
                              >
                                {`${stock.partNumber} · ${stock.description} · ${
                                  expired
                                    ? `Expired ${stock.expirationDate}`
                                    : `Available: ${usableQuantity(stock)}`
                                }`}
                              </option>
                            );
                          })}
                      </select>
                    </Field>
                    {!locations.length && (
                      <p className="muted">
                        Selecting stock requires inventory access and a saved
                        inventory location.
                      </p>
                    )}
                    <p className="muted">
                      This links the part to inventory. Record stock issues
                      through Inventory → Move stock.
                    </p>
                  </>
                )}

                {(
                  [
                    ["Part number", "partNumber"],
                    ["Description", "description"],
                    ["Serial / lot", "serialLot"],
                    ["Removed component details", "removedComponent"],
                    ["Installed component details", "installedComponent"],
                  ] as const
                ).map(([name, key]) => (
                  <Field key={key} label={`Part ${index + 1} ${name}`}>
                    <input
                      value={part[key]}
                      readOnly={part.source === "stock" && key === "partNumber"}
                      required={key === "partNumber"}
                      maxLength={10000}
                      onChange={(e) =>
                        updatePart(part.uuid, { [key]: e.target.value })
                      }
                    />
                  </Field>
                ))}
                <Field label={`Part ${index + 1} quantity`}>
                  <input
                    type="number"
                    min="0.000001"
                    step="any"
                    value={part.quantity}
                    onChange={(e) =>
                      updatePart(part.uuid, {
                        quantity: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    change(
                      "partsUsed",
                      f.partsUsed.filter((x) => x.uuid !== part.uuid),
                    )
                  }
                >
                  Remove part {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button"
              onClick={() =>
                change("partsUsed", [
                  ...f.partsUsed,
                  {
                    uuid: crypto.randomUUID(),
                    partNumber: "",
                    description: "",
                    quantity: 1,
                    serialLot: "",
                    removedComponent: "",
                    installedComponent: "",
                  },
                ])
              }
            >
              Add part used
            </button>
          </fieldset>
        </details>
        <details open>
          <summary>Notes / remarks</summary>
          {textField("Notes / remarks", "notesRemarks", true)}
        </details>
        {!!f.steps.length && (
          <details>
            <summary>Previously recorded step details</summary>
            {f.steps.map((step, index) => (
              <div key={step.uuid}>
                <p>
                  {index + 1}. {step.instruction}
                </p>
                {step.requiredResult && (
                  <p>Required result: {step.requiredResult}</p>
                )}
                {step.result && <p>Result: {step.result}</p>}
                {step.measurement !== null && (
                  <p>
                    Measurement: {step.measurement} {step.units}
                  </p>
                )}
                {(step.lowerLimit !== null || step.upperLimit !== null) && (
                  <p>
                    Limits: {step.lowerLimit ?? "—"} to {step.upperLimit ?? "—"}{" "}
                    {step.units}
                  </p>
                )}
                {initial?.stepSignoffs[step.uuid] && (
                  <p>Signed: {signature(initial.stepSignoffs[step.uuid])}</p>
                )}
              </div>
            ))}
          </details>
        )}
        <details open>
          <summary>Execution</summary>
          <fieldset disabled={template}>
            {textField("Actual work performed", "actualWork", true)}
            <div className="form-grid">
              <Field
                label="Actual labor (hours)"
                hint="Optional — leave blank if no labor time is recorded."
              >
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={f.actualLabor ?? ""}
                  onChange={(e) =>
                    change("actualLabor", nullableNumber(e.target.value))
                  }
                />
              </Field>
              <Field
                label="Completion date"
                hint="Optional — automatically records today’s date when you sign if left blank."
              >
                <input
                  type="date"
                  max={localDate()}
                  value={f.completionDate}
                  onChange={(e) => change("completionDate", e.target.value)}
                />
              </Field>
            </div>
          </fieldset>
        </details>
        <details open>
          <summary>Verification</summary>
          <label className="block">
            <input
              type="checkbox"
              checked={f.inspectionSignoffRequired}
              onChange={(e) =>
                change("inspectionSignoffRequired", e.target.checked)
              }
            />{" "}
            Inspection signoff required
          </label>
        </details>
      </AsyncForm>
      {initial && !template && (
        <section>
          <h3>Signoffs</h3>
          <p>
            Save changes before signing. Signing records your account and the
            current time. Changes to card content or evidence clear existing
            signoffs.
          </p>
          {dirty && (
            <p className="notice">
              Save your changes before signing or uploading evidence.
            </p>
          )}
          <p>Technician: {signature(initial.technicianSignoff)}</p>
          <button
            type="button"
            className="button"
            disabled={!writable || busy || dirty || initial.status === "draft"}
            onClick={() => void sign("technician")}
          >
            Technician signoff
          </button>
          <p>Inspection: {signature(initial.inspectionSignoff)}</p>
          <button
            type="button"
            className="button"
            disabled={
              !writable ||
              busy ||
              dirty ||
              !initial.technicianSignoff ||
              initial.technicianSignoff.userId === s.user.id ||
              !certified
            }
            aria-describedby={
              !initial.inspectionSignoff && !certified
                ? `inspector-certificate-${initial.uuid}`
                : undefined
            }
            onClick={() => void sign("inspection")}
          >
            Inspection signoff
          </button>
          {!initial.inspectionSignoff && !certified && (
            <p className="muted" id={`inspector-certificate-${initial.uuid}`}>
              {certificateProblem}
            </p>
          )}
          {!initial.inspectionSignoff &&
            initial.technicianSignoff?.userId === s.user.id && (
              <p className="muted">
                Inspection must be signed by a different person than the
                technician.
              </p>
            )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
      {initial ? (
        <Evidence
          card={initial}
          writable={writable && !dirty && !busy && !template}
        />
      ) : (
        <p>Save the draft to upload evidence and record signoffs.</p>
      )}
      <p className="muted">
        Job-card completion records the work performed. Update inspection
        compliance, discrepancy resolution and component installation records in
        their respective screens.
      </p>
    </>
  );
}
function Evidence({ card, writable }: { card: TaskCard; writable: boolean }) {
  const { snapshot: s, backend } = useWorkspace();
  const [file, setFile] = useState<File>();
  const files = (s?.taskEvidence ?? []).filter(
    (f) => f.taskCardUuid === card.uuid,
  );
  return (
    <section>
      <h3>Evidence</h3>
      <ul>
        {files.map((f) => (
          <li key={f.uuid}>
            <a href={f.url} download={f.name} target="_blank" rel="noreferrer">
              {f.name}
            </a>{" "}
            · {label(f.category)}{" "}
            {writable && s && evidenceRemovable(s, card) && (
              <DeleteFileButton
                name={f.name}
                onDelete={() => backend!.removeTaskEvidence(f.uuid)}
              />
            )}
          </li>
        ))}
      </ul>
      {!files.length && <p>No evidence attached.</p>}
      {!isTaskClosed(card) && (
        <AsyncForm
          submitLabel="Upload evidence"
          disabled={!writable}
          onSubmit={async (data) => {
            if (!file) throw new Error("Choose an evidence file.");
            validateWorkOrderFile(file.name, file.type, file.size);
            await backend!.attachTaskEvidence(
              card.uuid,
              value(data, "category") as (typeof evidenceCategories)[number],
              file,
            );
          }}
        >
          <Field label="Evidence category">
            <select name="category">
              {evidenceCategories.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Evidence file" hint="PDF, JPEG or PNG, up to 7 MB">
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </Field>
        </AsyncForm>
      )}
    </section>
  );
}

// A card that failed its schema here reads field by field; anything else,
// including a server refusal, reads as errorText shows it.
function cardErrorText(error: unknown) {
  return error instanceof ZodError
    ? taskCardValidationMessages(error).join("\n")
    : errorText(error, "Unable to save the job card.");
}
