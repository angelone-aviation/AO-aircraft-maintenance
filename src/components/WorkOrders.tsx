import { RequestPartsButton } from "./PartsRequests";
import { localDate } from "../domain/model";
import { removedTaskCards } from "../domain/workOrderTaskRemoval";
import { RequestedComponentMovement } from "./RequestedComponentMovement";
import { ComponentCloseoutCorrection } from "./ComponentCloseoutCorrection";
import { WorkOrderRevisions } from "./WorkOrderRevisions";
import { WorkOrderCosts } from "./WorkOrderCosts";
import { WorkOrderComponentWork } from "./WorkOrderComponentWork";
import {
  workOrderComponentIds,
  componentWorkLabels,
  type ComponentWork,
} from "../domain/workOrderComponentWork";
import { ReleaseStatements } from "./ReleaseStatements";
import { LogbookWording } from "./LogbookWording";
import { LogbookSample } from "./LogbookSample";
import { LogbookEntryButton } from "./LogbookEntry";
import { workItemCompletionIssue } from "../domain/workOrderCards";
import {
  ArchivedJobCardButton,
  LinkedTaskCards,
  WorkItemJobCards,
} from "./TaskCards";
import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import {
  can,
  hours,
  totalSeconds,
  aircraftMeterLabels,
  type Snapshot,
} from "../domain/model";
import { componentTotals } from "../domain/components";
import {
  installedComponents,
  isOpenWorkOrder,
  newWorkTask,
  taskStatuses,
  workOrderFieldsSchema,
  workOrderProgress,
  workOrderStatuses,
  workSources,
  validateWorkOrderFile,
  type WorkOrder,
  type WorkSource,
  type WorkTask,
} from "../domain/workOrders";
import { AsyncForm, DeleteFileButton, Field, Modal, value } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  ProgressTrack,
  StatTile,
  StatsStrip,
  StatusPill,
  Switch,
  Toolbar,
} from "./design";
import { ShopLead, ShopSelect, ShopTableCard } from "./ShopList";
import {
  Airplane,
  CheckCircle,
  ClipboardText,
  Hourglass,
  Package,
  Plus,
  Prohibit,
  WifiSlash,
  Wrench,
} from "@phosphor-icons/react";
const today = () => localDate();
const sourceLabel = (kind: WorkSource["kind"]) =>
  ({
    discrepancy: "Discrepancy",
    inspection: "Inspection",
    componentRequirement: "Component service",
    airworthiness: "Airworthiness directive",
    manual: "Requested work",
  })[kind];
export function AddToWorkOrder({
  aircraftUuid,
  source,
  sources,
}: {
  aircraftUuid: string;
} & (
  | { source: WorkSource; sources?: never }
  | { source?: never; sources: { source: WorkSource; description: string }[] }
)) {
  const { snapshot: s, online, connected, backend } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<string>();
  const [sourceUuid, setSourceUuid] = useState(sources?.[0]?.source.uuid);
  const selectedSource =
    source ?? sources?.find((x) => x.source.uuid === sourceUuid)?.source;
  if (!s || !can(s, aircraftUuid, "maintenance")) return null;
  const orders = (s.workOrders ?? []).filter(
    (w) =>
      w.aircraftUuid === aircraftUuid &&
      isOpenWorkOrder(w) &&
      (!w.templateCopy || w.templateCopy.status === "completed") &&
      !w.tasks.some(
        (t) =>
          t.source.kind === selectedSource?.kind &&
          t.source.uuid === selectedSource?.uuid,
      ),
  );
  return (
    <>
      <button
        type="button"
        className="button small"
        disabled={!online || !connected}
        onClick={() => {
          setSubmittedOrder(undefined);
          setSourceUuid(sources?.[0]?.source.uuid);
          setOpen(true);
        }}
      >
        Add to work order
      </button>
      {open &&
        createPortal(
          <div onSubmit={(e) => e.stopPropagation()}>
            <Modal title="Add to work order" onClose={() => setOpen(false)}>
              <p>
                Associated job card templates will be copied into this work
                order as independent job cards.
              </p>
              {submittedOrder ? (
                <TemplateCopyProgress orderUuid={submittedOrder} accepted />
              ) : (
                <>
                  {sources && (
                    <Field label="Required action">
                      <select
                        value={sourceUuid}
                        onChange={(e) => setSourceUuid(e.target.value)}
                      >
                        {sources.map((item) => (
                          <option
                            key={item.source.uuid}
                            value={item.source.uuid}
                          >
                            {item.description}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {orders.length && selectedSource ? (
                    <AsyncForm
                      submitLabel="Add item"
                      disabled={!online || !connected}
                      onSubmit={async (data) => {
                        const order = orders.find(
                          (w) => w.uuid === value(data, "order"),
                        )!;
                        await backend!.workOrder({
                          action: "add",
                          uuid: order.uuid,
                          version: order.version,
                          source: selectedSource,
                        });
                        setSubmittedOrder(order.uuid);
                      }}
                    >
                      <Field label="Open work order">
                        <select name="order" required>
                          {orders.map((w) => (
                            <option key={w.uuid} value={w.uuid}>
                              {w.number} · {w.scope || w.aircraft.registration}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </AsyncForm>
                  ) : (
                    <p>
                      No available open work orders for this aircraft. Open one
                      from Work orders, or check whether this item has already
                      been added.
                    </p>
                  )}
                </>
              )}
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}

function TemplateCopyProgress({
  orderUuid,
  accepted = false,
}: {
  orderUuid: string;
  accepted?: boolean;
}) {
  const { snapshot, backend, connected, online } = useWorkspace();
  const order = snapshot?.workOrders?.find((w) => w.uuid === orderUuid);
  const progress = order?.templateCopy;
  if (!progress)
    return accepted ? (
      <p role="status">
        Item added. Job card preparation will appear here if templates are
        available.
      </p>
    ) : null;
  return (
    <div className="notice">
      <p role="status" aria-live="polite">
        {progress.status === "completed"
          ? `Job cards ready: ${progress.total} added.`
          : `Preparing job cards: ${progress.completed} of ${progress.total}.`}
      </p>
      {progress.status !== "completed" && (
        <>
          <progress
            value={progress.completed}
            max={progress.total}
            aria-label="Job cards prepared"
          />
          <p>
            You can close this window. Preparation continues in the background.
            Finish preparation before editing or closing out this work order.
          </p>
          {progress.error && <p role="alert">{progress.error}</p>}
          {order &&
            snapshot &&
            can(snapshot, order.aircraftUuid, "maintenance") && (
              <AsyncForm
                submitLabel="Resume preparation"
                disabled={!online || !connected}
                onSubmit={async () => {
                  await backend!.resumeWorkOrderTemplates(orderUuid);
                }}
              >
                <span>
                  {progress.status === "failed"
                    ? "Retry the remaining cards."
                    : "If progress stops, resume here."}
                </span>
              </AsyncForm>
            )}
        </>
      )}
    </div>
  );
}

const statusTone = (status: WorkOrder["status"]) =>
  status === "completed"
    ? "good"
    : status === "open" ||
        status === "parts-delay" ||
        status === "awaiting-approval"
      ? "warn"
      : "neutral";
const statusIcon = (status: WorkOrder["status"]) =>
  ({
    open: ClipboardText,
    "in-progress": Wrench,
    "awaiting-approval": Hourglass,
    "parts-delay": Package,
    completed: CheckCircle,
    cancelled: Prohibit,
  })[status];
export function WorkOrders() {
  const { snapshot: state, online, connected } = useWorkspace();
  const s = state!;
  const [selected, setSelected] = useState<WorkOrder | "new" | null>(null);
  const [aircraft, setAircraft] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const scoped = (s.workOrders ?? []).filter(
    (w) => !aircraft || w.aircraftUuid === aircraft,
  );
  const list = scoped
    .filter((w) => showClosed || isOpenWorkOrder(w))
    .sort((a, b) => b.recordedAt - a.recordedAt);
  const month = today().slice(0, 7);
  const openCount = scoped.filter(isOpenWorkOrder).length;
  const inProgress = scoped.filter((w) => w.status === "in-progress").length;
  const closedThisMonth = scoped.filter(
    (w) => w.status === "completed" && w.completionDate.startsWith(month),
  ).length;
  return (
    <>
      <PageHeader
        eyebrow="MAINTENANCE"
        title="Work orders"
        description="Scoped maintenance work with requested items, job cards, parts and sign-off through closeout."
        actions={
          <button
            className="button primary"
            disabled={
              !online ||
              !connected ||
              !s.aircraft.some((a) => can(s, a.uuid, "maintenance"))
            }
            onClick={() => setSelected("new")}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            Open work order
          </button>
        }
      />
      <StatsStrip className="shop-stats">
        <StatTile label="Open" value={openCount} />
        <StatTile label="In progress" value={inProgress} />
        <StatTile label="Closed this month" value={closedThisMonth} />
      </StatsStrip>
      <Toolbar
        className="shop-toolbar"
        end={
          <Switch
            label="Include closed work orders"
            checked={showClosed}
            onChange={setShowClosed}
          />
        }
      >
        <ShopSelect
          label="Aircraft"
          icon={Airplane}
          value={aircraft}
          onChange={setAircraft}
        >
          <option value="">All aircraft</option>
          {s.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </ShopSelect>
      </Toolbar>
      {(!online || !connected) && (
        <NoticeBar tone="warn" icon={WifiSlash}>
          Cached work orders are available. Reconnect to make changes.
        </NoticeBar>
      )}
      {list.length ? (
        <ShopTableCard label="Work orders" className="shop-compact" stack>
          <table
            className="shop-table"
            style={{ "--shop-table-min": "880px" } as CSSProperties}
          >
            <thead>
              <tr>
                <th>Work order</th>
                <th>Opened / status</th>
                <th>Supervisor</th>
                <th className="shop-num">Requested work</th>
                <th className="shop-num">Open discrepancies</th>
                <th className="shop-num">Parts delays</th>
                <th className="shop-num">Job cards</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => {
                const progress = workOrderProgress(s, w);
                const tone = statusTone(w.status);
                return (
                  <tr key={w.uuid}>
                    <td className="shop-wide">
                      <ShopLead
                        icon={statusIcon(w.status)}
                        tone={tone}
                        title={w.number}
                        sub={w.aircraft.registration}
                      />
                    </td>
                    <td data-label="Opened">
                      <span className="shop-nowrap">{w.dateOpened}</span>
                      <span className="shop-sub">
                        <StatusPill tone={tone}>
                          <span className="shop-cap">
                            {w.status.replace(/-/g, " ")}
                          </span>
                        </StatusPill>
                      </span>
                    </td>
                    <td data-label="Supervisor">
                      {w.supervisor || "Unassigned"}
                      <small className="shop-priority">{w.priority}</small>
                    </td>
                    <td className="shop-num" data-label="Requested work">
                      <span className="shop-wo-progress">
                        <span>
                          {progress.completed} / {progress.total}
                        </span>
                        <ProgressTrack
                          thin
                          tone={tone === "good" ? "good" : "blue"}
                          value={
                            progress.total
                              ? progress.completed / progress.total
                              : 0
                          }
                        />
                      </span>
                    </td>
                    <td className="shop-num" data-label="Discrepancies">
                      <span
                        className={
                          progress.outstandingDiscrepancies
                            ? "shop-count-danger"
                            : "shop-zero"
                        }
                      >
                        {progress.outstandingDiscrepancies}
                      </span>
                    </td>
                    <td className="shop-num" data-label="Parts delays">
                      <span
                        className={
                          progress.partsDelays ? "shop-count-warn" : "shop-zero"
                        }
                      >
                        {progress.partsDelays}
                      </span>
                    </td>
                    <td className="shop-num" data-label="Job cards">
                      {progress.taskCardsCompleted} / {progress.taskCardsTotal}
                    </td>
                    <td className="shop-actions-cell">
                      <button
                        className="button small"
                        onClick={() => setSelected(w)}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ShopTableCard>
      ) : (
        <EmptyState title="No work orders">
          {scoped.length
            ? "No open work orders match. Include closed work orders to see completed and cancelled orders."
            : "Open a work order for an aircraft, then add inspections, discrepancies and component service requirements."}
        </EmptyState>
      )}
      {selected && (
        <Modal
          className="work-order-modal shop-wo-dialog"
          title={selected === "new" ? "Open work order" : selected.number}
          onClose={() => setSelected(null)}
        >
          <WorkOrderForm
            key={selected === "new" ? "new" : selected.uuid}
            s={s}
            initial={selected === "new" ? undefined : selected}
            onDone={() => setSelected(null)}
          />
        </Modal>
      )}
    </>
  );
}
function ReadingHeader({
  s,
  aircraftUuid,
  initial,
  selectedComponents,
}: {
  s: Snapshot;
  aircraftUuid: string;
  initial?: WorkOrder;
  selectedComponents: string[];
}) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!a) return null;
  const r = initial?.aircraft ?? {
    ...a,
    totalSeconds: totalSeconds(a),
    hobbs: a.currentHobbs,
    tach: a.currentTach,
    cyclicHobbs: a.currentCyclicHobbs,
    flightTimeLog: a.currentFlightTimeLog,
  };
  const components = selectedComponents.map((uuid) => {
    const prior = initial?.componentReadings.find(
      (c) => c.componentUuid === uuid,
    );
    if (prior) return prior;
    const c = installedComponents(s, aircraftUuid).find((c) => c.uuid === uuid);
    return c
      ? {
          ...componentTotals(c, a),
          recordedAt: Date.now(),
          componentUuid: uuid,
          label: c.componentType,
          serial: c.serial,
          partNumber: c.partNumber,
        }
      : undefined;
  });
  return (
    <div className="panel">
      <h3>Aircraft readings</h3>
      <p>
        {r.registration} · {r.make} {r.model} · Serial {r.serial || "—"}
      </p>
      <p>
        Recorded:{" "}
        {initial
          ? new Date(initial.recordedAt).toLocaleString()
          : "Current readings, captured when opened"}
      </p>
      <dl className="details-grid shop-readings">
        <div>
          <dt>Aircraft total time</dt>
          <dd>{hours(r.totalSeconds)} h</dd>
        </div>
        <div>
          <dt>Hobbs</dt>
          <dd>{hours(r.hobbs)} h</dd>
        </div>
        <div>
          <dt>Tach</dt>
          <dd>{hours(r.tach)} h</dd>
        </div>
        <div>
          <dt>Total landings</dt>
          <dd>{r.landings ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Tracking meter</dt>
          <dd>{aircraftMeterLabels[r.meter]}</dd>
        </div>
        {a.turbine && (
          <div>
            <dt>Cycles</dt>
            <dd>{r.cycles}</dd>
          </div>
        )}
      </dl>
      {!!components.length && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Component / serial</th>
                <th>Part number</th>
                <th>TSN</th>
                <th>TSO</th>
                <th>TSR</th>
                <th>Cycles</th>
              </tr>
            </thead>
            <tbody>
              {components.map(
                (c) =>
                  c && (
                    <tr key={c.componentUuid}>
                      <td>
                        {c.label}
                        <br />
                        {c.serial}
                        <small className="block">
                          Recorded {new Date(c.recordedAt).toLocaleString()}
                        </small>
                      </td>
                      <td>{c.partNumber}</td>
                      <td>
                        {c.timeSinceNew === null
                          ? "Not recorded"
                          : `${hours(c.timeSinceNew)} h`}
                      </td>
                      <td>
                        {c.timeSinceOverhaul === null
                          ? "Not recorded"
                          : `${hours(c.timeSinceOverhaul)} h`}
                      </td>
                      <td>
                        {c.timeSinceRepair === null
                          ? "Not recorded"
                          : `${hours(c.timeSinceRepair)} h`}
                      </td>
                      <td>{c.cyclesSinceNew}</td>
                    </tr>
                  ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function WorkOrderForm({
  s,
  initial,
  onDone,
}: {
  s: Snapshot;
  initial?: WorkOrder;
  onDone: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const aircraftOptions = s.aircraft.filter((a) =>
    can(s, a.uuid, "maintenance"),
  );
  const [aircraftUuid, setAircraftUuid] = useState(
    initial?.aircraftUuid ?? aircraftOptions[0]?.uuid ?? "",
  );
  const [componentUuids, setComponents] = useState(
    initial?.componentReadings.map((c) => c.componentUuid) ?? [],
  );
  const [tasks, setTasks] = useState<WorkTask[]>(initial?.tasks ?? []);
  const [removingTasks, setRemovingTasks] = useState(false);
  const [removeTaskIds, setRemoveTaskIds] = useState<string[]>([]);
  const [removeTaskError, setRemoveTaskError] = useState("");
  const [confirmTaskRemoval, setConfirmTaskRemoval] = useState(false);
  const [componentWork, setComponentWork] = useState<ComponentWork[]>(
    initial?.componentWork ?? [],
  );
  const [previewFields, setPreviewFields] = useState<FormData>();
  const [releaseOutcome, setReleaseOutcome] = useState(
    initial?.releaseOutcome ?? "",
  );
  const [sourceKey, setSourceKey] = useState("");
  const [manual, setManual] = useState("");
  const [status, setStatus] = useState(initial?.status ?? "open");
  const [uuid] = useState(initial?.uuid ?? crypto.randomUUID());
  const preparation = s.workOrders?.find((w) => w.uuid === uuid)?.templateCopy;
  const writable =
    (!preparation || preparation.status === "completed") &&
    online &&
    connected &&
    can(s, aircraftUuid, "maintenance") &&
    (!initial || isOpenWorkOrder(initial));
  const closing =
    writable && (status === "completed" || status === "cancelled");
  const closeoutComponentIds = workOrderComponentIds(
    s,
    {
      uuid,
      tasks,
      componentWork,
      componentReadings: componentUuids.map((id) => ({ componentUuid: id })),
    },
    status !== "completed",
  );
  const selectedComponentWork = componentWork.filter((item) =>
    closeoutComponentIds.includes(item.componentUuid),
  );
  const closeWarning =
    "Closing this work order is permanent. You will no longer be able to modify the work order or its job cards. You can still view tasks and attachments.";
  const sources = workSources(s, aircraftUuid).filter(
    (x) =>
      !tasks.some(
        (t) =>
          t.source.kind === x.source.kind && t.source.uuid === x.source.uuid,
      ),
  );
  const choices = [
    ...installedComponents(s, aircraftUuid).map((c) => ({
      uuid: c.uuid,
      label: `${c.componentType} · ${c.serial} · ${c.installPosition ?? ""}`,
    })),
    ...(initial?.componentReadings ?? [])
      .filter(
        (c) =>
          !installedComponents(s, aircraftUuid).some(
            (x) => x.uuid === c.componentUuid,
          ),
      )
      .map((c) => ({
        uuid: c.componentUuid,
        label: `${c.label} · ${c.serial} (recorded)`,
      })),
  ];
  const removableTasks = tasks;
  function removeSelectedTasks() {
    setRemoveTaskError("");
    const removed = tasks.filter((task) => removeTaskIds.includes(task.uuid));
    const remaining = tasks.filter(
      (task) => !removeTaskIds.includes(task.uuid),
    );
    try {
      removedTaskCards(s, uuid, removed, remaining);
      setTasks(remaining);
      setComponentWork((current) =>
        current.filter(
          (work) => !work.taskUuid || !removeTaskIds.includes(work.taskUuid),
        ),
      );
      setRemoveTaskIds([]);
      setRemovingTasks(false);
    } catch (error) {
      setRemoveTaskError(
        error instanceof Error ? error.message : "Unable to remove tasks.",
      );
    }
  }
  const updateTask = (uuid: string, patch: Partial<WorkTask>) =>
    setTasks(tasks.map((t) => (t.uuid === uuid ? { ...t, ...patch } : t)));
  const moveTask = (uuid: string, direction: -1 | 1) =>
    setTasks((current) => {
      const index = current.findIndex((t) => t.uuid === uuid);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[target]] = [
        reordered[target],
        reordered[index],
      ];
      return reordered;
    });
  return (
    <>
      {confirmTaskRemoval &&
        createPortal(
          <Modal
            title="Remove selected tasks?"
            onClose={() => setConfirmTaskRemoval(false)}
          >
            <p className="notice">
              Removing these {removeTaskIds.length} selected task(s) will
              archive their linked job cards and remove them from the active
              work order.
            </p>
            <p>
              All recorded work, signatures, and attachments will be preserved
              in Archived tasks. No signer approval is required. Source
              templates and cards still linked to other tasks stay active.
            </p>
            <p>
              Click Yes, proceed to stage the removal, then Save work order to
              apply it.
            </p>
            <div className="job-card-remove-actions">
              <button
                type="button"
                className="button"
                autoFocus
                onClick={() => setConfirmTaskRemoval(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button primary"
                disabled={!writable || !removeTaskIds.length}
                onClick={() => {
                  setConfirmTaskRemoval(false);
                  removeSelectedTasks();
                }}
              >
                Yes, proceed
              </button>
            </div>
          </Modal>,
          document.body,
        )}

      <AsyncForm
        onChange={setPreviewFields}
        submitLabel={initial ? "Save work order" : "Open work order"}
        onClose={onDone}
        disabled={!writable}
        onSubmit={async (data) => {
          const fields = workOrderFieldsSchema.parse({
            number: value(data, "number"),
            aircraftUuid,
            dateOpened: value(data, "dateOpened"),
            supervisor: value(data, "supervisor"),
            scope: value(data, "scope"),
            priority: value(data, "priority"),
            status,
            completionDate: value(data, "completionDate"),
            releaseOutcome: value(data, "releaseOutcome"),
            finalReview: initial?.finalReview ?? "",
          });
          if (
            closing &&
            !window.confirm(
              `${closeWarning}\n\n${
                status === "completed"
                  ? selectedComponentWork
                      .map((item) => {
                        const c = choices.find(
                          (c) => c.uuid === item.componentUuid,
                        );
                        return `${c?.label ?? item.componentUuid}: ${componentWorkLabels[item.action]}${item.action === "repair" || item.action === "both" ? "; TSR → 0.0 h" : ""}${item.action === "overhaul" || item.action === "both" ? "; TSO → 0.0 h" : ""}`;
                      })
                      .join("\n")
                  : ""
              }\n\nClose this work order?`,
            )
          )
            return;
          await backend!.workOrder({
            action: "save",
            uuid,
            version: initial?.version ?? 0,
            fields,
            completionReadings:
              status === "completed"
                ? {
                    totalSeconds: Math.round(
                      Number(value(data, "completionTotalHours")) * 3600,
                    ),
                    hobbs: Math.round(
                      Number(value(data, "completionHobbs")) * 3600,
                    ),
                    tach: Math.round(
                      Number(value(data, "completionTach")) * 3600,
                    ),
                    cyclicHobbs: data.has("completionCyclicHobbs")
                      ? Math.round(
                          Number(value(data, "completionCyclicHobbs")) * 3600,
                        )
                      : undefined,
                    flightTimeLog: data.has("completionFlightTimeLog")
                      ? Math.round(
                          Number(value(data, "completionFlightTimeLog")) * 3600,
                        )
                      : undefined,
                    landings: Number(value(data, "completionLandings")),
                    cycles: data.has("completionCycles")
                      ? Number(value(data, "completionCycles"))
                      : (initial?.closeout?.aircraft.cycles ??
                        s.aircraft.find((a) => a.uuid === aircraftUuid)!
                          .cycles),
                  }
                : undefined,
            componentUuids,
            componentWork: selectedComponentWork,
            tasks,
          });
          onDone();
        }}
      >
        <div className="work-order-header-fields">
          <Field label="Work order number">
            <input
              name="number"
              placeholder="Automatic if blank"
              title="Leave blank to assign the next available number."
              defaultValue={initial?.number}
              maxLength={100}
            />
          </Field>
          <Field label="Aircraft">
            <select
              value={aircraftUuid}
              disabled={!!initial}
              onChange={(e) => {
                setAircraftUuid(e.target.value);
                setComponents([]);
                setComponentWork([]);
                setTasks([]);
                setSourceKey("");
              }}
            >
              {(initial ? s.aircraft : aircraftOptions).map((a) => (
                <option key={a.uuid} value={a.uuid}>
                  {a.registration}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date opened">
            <input
              name="dateOpened"
              type="date"
              required
              max={today()}
              defaultValue={initial?.dateOpened ?? today()}
            />
          </Field>
          <Field label="Supervisor">
            <input
              name="supervisor"
              aria-label="Assigned supervisor"
              defaultValue={initial?.supervisor}
              maxLength={10000}
            />
          </Field>
          <Field label="Priority">
            <select
              name="priority"
              defaultValue={initial?.priority ?? "routine"}
            >
              {["routine", "high", "urgent"].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              aria-label="Work order status"
              value={status}
              disabled={!initial}
              onChange={(e) => setStatus(e.target.value as WorkOrder["status"])}
            >
              {workOrderStatuses.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="work-order-workspace">
          <section className="work-order-panel" aria-label="Requested work">
            <input type="hidden" name="scope" value={initial?.scope ?? ""} />
            {writable && (
              <>
                <h3>Requested work</h3>
                <div className="work-order-remove-tasks">
                  {!removingTasks ? (
                    <button
                      type="button"
                      className="button small"
                      disabled={!tasks.length}
                      onClick={() => {
                        setRemovingTasks(true);
                        setRemoveTaskIds([]);
                        setRemoveTaskError("");
                      }}
                    >
                      Remove tasks
                    </button>
                  ) : (
                    <>
                      <p>
                        Select tasks to remove from the active work order. Their
                        job cards, signatures, and attachments will be archived
                        when you save. Source templates stay available.
                      </p>
                      {!removableTasks.length && (
                        <p className="notice" role="status">
                          No tasks remain to select.
                        </p>
                      )}
                      <div className="job-card-remove-actions">
                        <button
                          type="button"
                          className="button small"
                          disabled={!removableTasks.length}
                          onClick={() =>
                            setRemoveTaskIds(
                              removableTasks.map((task) => task.uuid),
                            )
                          }
                        >
                          Select all removable
                        </button>
                        <button
                          type="button"
                          className="button primary"
                          disabled={!removeTaskIds.length}
                          onClick={() => setConfirmTaskRemoval(true)}
                        >
                          Remove selected ({removeTaskIds.length})
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            setRemovingTasks(false);
                            setRemoveTaskIds([]);
                            setRemoveTaskError("");
                          }}
                        >
                          Cancel removal
                        </button>
                      </div>
                      {removeTaskError && (
                        <p className="error" role="alert">
                          {removeTaskError}
                        </p>
                      )}
                    </>
                  )}
                  {initial?.tasks.some(
                    (task) =>
                      !tasks.some((current) => current.uuid === task.uuid),
                  ) && (
                    <p role="status" className="muted">
                      Task removal is pending. Save work order to apply it, or
                      close without saving to keep the tasks.
                    </p>
                  )}
                </div>
                <div className="requested-work-controls">
                  <div className="requested-work-add-row">
                    <Field label="Existing work item">
                      <select
                        value={sourceKey}
                        onChange={(e) => setSourceKey(e.target.value)}
                      >
                        <option value="">
                          Select an inspection, discrepancy or service
                          requirement
                        </option>
                        {sources.map((x) => (
                          <option
                            key={`${x.source.kind}:${x.source.uuid}`}
                            value={`${x.source.kind}:${x.source.uuid}`}
                          >
                            {sourceLabel(x.source.kind)} · {x.description}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button
                      type="button"
                      className="button"
                      disabled={!sourceKey}
                      onClick={() => {
                        const item = sources.find(
                          (x) =>
                            `${x.source.kind}:${x.source.uuid}` === sourceKey,
                        );
                        if (item)
                          setTasks([
                            ...tasks,
                            newWorkTask(item.source, item.description),
                          ]);
                        setSourceKey("");
                      }}
                    >
                      Add selected work
                    </button>
                  </div>
                  <div className="requested-work-add-row">
                    <Field label="Additional requested work">
                      <input
                        value={manual}
                        maxLength={10000}
                        onChange={(e) => setManual(e.target.value)}
                      />
                    </Field>
                    <button
                      type="button"
                      className="button"
                      disabled={!manual.trim()}
                      onClick={() => {
                        setTasks([
                          ...tasks,
                          newWorkTask(
                            { kind: "manual", uuid: crypto.randomUUID() },
                            manual.trim(),
                          ),
                        ]);
                        setManual("");
                      }}
                    >
                      Add requested work
                    </button>
                  </div>
                  <RequestedComponentMovement
                    key={aircraftUuid}
                    s={s}
                    aircraftUuid={aircraftUuid}
                    choices={selectedComponentWork}
                    onAdd={(component, work) => {
                      const task = newWorkTask(
                        { kind: "manual", uuid: work.taskUuid! },
                        `${work.action === "install" ? "Install" : "Remove"} ${component.componentType} P/N ${component.partNumber}; S/N ${component.serial}. ${work.description}`,
                      );
                      setTasks([...tasks, { ...task, uuid: work.taskUuid! }]);
                      setComponentWork([
                        ...componentWork.filter(
                          (w) => w.componentUuid !== component.uuid,
                        ),
                        work,
                      ]);
                    }}
                  />
                </div>
                {!tasks.length && (
                  <p className="muted">No requested work added yet.</p>
                )}
                {tasks.map((t, index) => (
                  <div className="panel work-order-task-card" key={t.uuid}>
                    {removingTasks && (
                      <label className="job-card-remove-choice">
                        <input
                          type="checkbox"
                          aria-label={`Remove task ${index + 1}: ${t.description}`}
                          checked={removeTaskIds.includes(t.uuid)}
                          onChange={(event) =>
                            setRemoveTaskIds((current) =>
                              event.target.checked
                                ? [...current, t.uuid]
                                : current.filter((id) => id !== t.uuid),
                            )
                          }
                        />
                        Select task to remove and archive
                      </label>
                    )}
                    <details className="work-order-task-details">
                      <summary
                        className="work-order-task-summary"
                        title={t.description}
                      >
                        <span className="work-order-task-number">
                          Task {index + 1}
                        </span>
                        <strong className="work-order-task-title">
                          {t.description}
                        </strong>
                        <span className="badge">
                          {t.status.replace(/-/g, " ")}
                        </span>
                      </summary>
                      <div className="work-order-task-body">
                        <p className="muted">{sourceLabel(t.source.kind)}</p>
                        <div className="work-order-task-move">
                          <button
                            type="button"
                            className="button"
                            aria-label={`Move task ${index + 1} up`}
                            disabled={index === 0}
                            onClick={() => moveTask(t.uuid, -1)}
                          >
                            Move up
                          </button>
                          <button
                            type="button"
                            className="button"
                            aria-label={`Move task ${index + 1} down`}
                            disabled={index === tasks.length - 1}
                            onClick={() => moveTask(t.uuid, 1)}
                          >
                            Move down
                          </button>
                        </div>
                        <p className="muted">
                          Use Move up or Move down to reorder tasks, then save
                          the work order.
                        </p>
                        <LogbookWording
                          included={t.includeInLogbook}
                          phrase={t.logbookPhrase}
                          onChange={(patch) => updateTask(t.uuid, patch)}
                        />
                        {(t.includeInLogbook ?? true) && (
                          <Field
                            label={`Task ${index + 1} maintenance manual reference`}
                            hint="Used for log book entry data."
                          >
                            <input
                              value={t.maintenanceReference ?? ""}
                              maxLength={10000}
                              onChange={(e) =>
                                updateTask(t.uuid, {
                                  maintenanceReference: e.target.value,
                                })
                              }
                            />
                          </Field>
                        )}
                        {workItemCompletionIssue(s, uuid, t) && (
                          <p className="muted">
                            {workItemCompletionIssue(s, uuid, t)}
                          </p>
                        )}
                        <div className="form-grid">
                          <Field label={`Task ${index + 1} status`}>
                            <select
                              value={t.status}
                              onChange={(e) =>
                                updateTask(t.uuid, {
                                  status: e.target.value as WorkTask["status"],
                                })
                              }
                            >
                              {taskStatuses.map((v) => (
                                <option
                                  key={v}
                                  value={v}
                                  disabled={
                                    v === "completed" &&
                                    !!workItemCompletionIssue(s, uuid, t)
                                  }
                                >
                                  {v}
                                </option>
                              ))}
                            </select>
                          </Field>
                          <Field label={`Task ${index + 1} parts delay`}>
                            <input
                              value={t.partsDelay}
                              maxLength={10000}
                              onChange={(e) =>
                                updateTask(t.uuid, {
                                  partsDelay: e.target.value,
                                })
                              }
                            />
                          </Field>
                        </div>
                        <Field label={`Task ${index + 1} work notes`}>
                          <textarea
                            value={t.notes}
                            maxLength={10000}
                            onChange={(e) =>
                              updateTask(t.uuid, { notes: e.target.value })
                            }
                          />
                        </Field>
                        {initial?.tasks.some((x) => x.uuid === t.uuid) ? (
                          <>
                            <RequestPartsButton
                              source={{
                                kind: "workTask",
                                uuid: t.uuid,
                                workOrderUuid: uuid,
                              }}
                              label="Request parts for task"
                            />
                            <WorkItemJobCards workOrderUuid={uuid} item={t} />
                          </>
                        ) : (
                          t.source.kind !== "manual" &&
                          t.source.kind !== "airworthiness" && (
                            <p className="muted">
                              Save the work order to create this item’s job
                              cards from its templates.
                            </p>
                          )
                        )}
                        {!initial?.tasks.some((x) => x.uuid === t.uuid) && (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              setTasks(tasks.filter((x) => x.uuid !== t.uuid))
                            }
                          >
                            Remove unsaved task
                          </button>
                        )}
                      </div>
                    </details>
                  </div>
                ))}
              </>
            )}
          </section>
          <aside
            className="work-order-panel work-order-readings"
            aria-label="Aircraft and component readings"
          >
            <ReadingHeader
              s={s}
              aircraftUuid={aircraftUuid}
              initial={initial}
              selectedComponents={componentUuids}
            />
            <h3>Component times in header</h3>
            <p>
              Select the installed engines, propellers or other components to
              include. Unknown overhaul or repair times remain unrecorded.
            </p>
            {choices.map((c) => (
              <label className="block" key={c.uuid}>
                <input
                  type="checkbox"
                  checked={componentUuids.includes(c.uuid)}
                  onChange={(e) =>
                    setComponents(
                      e.target.checked
                        ? [...componentUuids, c.uuid]
                        : componentUuids.filter((id) => id !== c.uuid),
                    )
                  }
                />{" "}
                {c.label}
              </label>
            ))}
            {!choices.length && (
              <p className="muted">
                No installed components for this aircraft.
              </p>
            )}
          </aside>
        </div>
        {writable && status !== "cancelled" && (
          <WorkOrderComponentWork
            s={s}
            ids={closeoutComponentIds}
            aircraftUuid={aircraftUuid}
            fields={previewFields}
            choices={selectedComponentWork}
            onChange={setComponentWork}
            closing={status === "completed"}
          />
        )}
        {closing && (
          <p role="alert" className="notice">
            {closeWarning}
          </p>
        )}
        <p className="muted">
          Completing this order records compliance for completed routine
          inspections. Component repair and overhaul selections update tracking
          at closeout. Discrepancy resolution uses its own record.
        </p>
        <details
          className="work-order-panel work-order-closeout"
          open={status === "completed"}
        >
          <summary>Closeout</summary>
          {status === "completed" &&
            (!initial || isOpenWorkOrder(initial) || initial.closeout) && (
              <>
                <p>
                  Confirm the aircraft readings at completion. Saving updates
                  compliance for completed routine inspections and recalculates
                  their next due limits. Cancelled items and absolute life
                  limits are unchanged.
                </p>
                <div className="form-grid">
                  {(initial?.closeout?.aircraft.cyclicHobbs !== undefined ||
                    s.aircraft.find((a) => a.uuid === aircraftUuid)
                      ?.helicopter) && (
                    <Field label="Completion Collective hourmeter (hours)">
                      <input
                        name="completionCyclicHobbs"
                        type="number"
                        min="0"
                        step="0.1"
                        required
                        defaultValue={
                          (initial?.closeout?.aircraft.cyclicHobbs ??
                            s.aircraft.find((a) => a.uuid === aircraftUuid)
                              ?.currentCyclicHobbs ??
                            0) / 3600
                        }
                      />
                    </Field>
                  )}
                  {(initial?.closeout?.aircraft.flightTimeLog !== undefined ||
                    s.aircraft.find((a) => a.uuid === aircraftUuid)
                      ?.flightTimeLog) && (
                    <Field label="Completion Flight time log (hours)">
                      <input
                        name="completionFlightTimeLog"
                        type="number"
                        min="0"
                        step="0.1"
                        required
                        defaultValue={
                          (initial?.closeout?.aircraft.flightTimeLog ??
                            s.aircraft.find((a) => a.uuid === aircraftUuid)
                              ?.currentFlightTimeLog ??
                            0) / 3600
                        }
                      />
                    </Field>
                  )}
                  {(
                    [
                      [
                        "completionTotalHours",
                        "Completion aircraft total time (hours)",
                        (initial?.closeout?.aircraft.totalSeconds ??
                          totalSeconds(
                            s.aircraft.find((a) => a.uuid === aircraftUuid)!,
                          )) / 3600,
                      ],
                      [
                        "completionHobbs",
                        "Completion Hobbs (hours)",
                        (initial?.closeout?.aircraft.hobbs ??
                          s.aircraft.find((a) => a.uuid === aircraftUuid)!
                            .currentHobbs) / 3600,
                      ],
                      [
                        "completionTach",
                        "Completion tach (hours)",
                        (initial?.closeout?.aircraft.tach ??
                          s.aircraft.find((a) => a.uuid === aircraftUuid)!
                            .currentTach) / 3600,
                      ],
                      [
                        "completionLandings",
                        "Completion aircraft total landings",
                        initial?.closeout?.aircraft.landings ??
                          s.aircraft.find((a) => a.uuid === aircraftUuid)!
                            .landings,
                      ],
                      [
                        "completionCycles",
                        "Completion cycles",
                        initial?.closeout?.aircraft.cycles ??
                          s.aircraft.find((a) => a.uuid === aircraftUuid)!
                            .cycles,
                      ],
                    ] as const
                  )
                    .filter(
                      ([name]) =>
                        name !== "completionCycles" ||
                        s.aircraft.find((a) => a.uuid === aircraftUuid)
                          ?.turbine,
                    )
                    .map(([name, label, defaultValue]) => (
                      <Field key={name} label={label}>
                        <input
                          name={name}
                          type="number"
                          min="0"
                          step={
                            name === "completionCycles" ||
                            name === "completionLandings"
                              ? "1"
                              : "any"
                          }
                          required
                          defaultValue={defaultValue}
                        />
                      </Field>
                    ))}
                </div>
              </>
            )}

          <Field label="Completion date">
            <input
              type="date"
              name="completionDate"
              min={initial?.dateOpened}
              max={today()}
              defaultValue={initial?.completionDate}
            />
          </Field>
          <ReleaseStatements
            value={releaseOutcome}
            onChange={setReleaseOutcome}
            editable={writable}
          />
        </details>
        {(!initial || isOpenWorkOrder(initial)) && (
          <LogbookSample
            s={s}
            initial={initial}
            uuid={uuid}
            aircraftUuid={aircraftUuid}
            componentUuids={componentUuids}
            tasks={tasks}
            status={status}
            fields={previewFields}
            releaseOutcome={releaseOutcome}
            componentWork={selectedComponentWork}
          />
        )}
      </AsyncForm>
      {!!initial?.archivedTasks?.length && (
        <section className="panel" aria-label="Archived tasks">
          <h3>Archived tasks ({initial.archivedTasks.length})</h3>
          <p className="muted">
            Removed from the active work order. Original records, signatures,
            and attachments are preserved and read-only.
          </p>
          {initial.archivedTasks.map((entry, index) => (
            <details key={`${entry.task.uuid}:${entry.removedAt}:${index}`}>
              <summary>{entry.task.description}</summary>
              <p>
                Archived by {entry.removedByName} ·{" "}
                {new Date(entry.removedAt).toLocaleString()}
              </p>
              <p>Task status at removal: {entry.task.status}</p>
              {entry.task.notes && (
                <p style={{ whiteSpace: "pre-wrap" }}>{entry.task.notes}</p>
              )}
              {entry.task.partsDelay && (
                <p>Parts delay: {entry.task.partsDelay}</p>
              )}
              {entry.task.maintenanceReference && (
                <p>Maintenance reference: {entry.task.maintenanceReference}</p>
              )}
              {entry.componentWork?.map((work) => (
                <p key={work.componentUuid}>
                  {componentWorkLabels[work.action]}: {work.description}
                </p>
              ))}
              <ul>
                {entry.cardUuids.map((id) => {
                  const card = s.archivedTaskCards?.find(
                    (card) => card.uuid === id,
                  );
                  return (
                    <li key={id}>
                      {card ? (
                        <ArchivedJobCardButton card={card} />
                      ) : (
                        "Archived job card unavailable."
                      )}
                    </li>
                  );
                })}
              </ul>
              {!entry.cardUuids.length && (
                <p className="muted">
                  No job cards were moved into the archive for this task.
                </p>
              )}
            </details>
          ))}
        </section>
      )}
      {initial && <WorkOrderRevisions order={initial} onDone={onDone} />}
      {initial && (
        <ComponentCloseoutCorrection order={initial} onDone={onDone} />
      )}
      {!writable && initial && (
        <section aria-label="Requested work">
          <h3>Requested work</h3>
          {!isOpenWorkOrder(initial) && (
            <p className="notice">
              This work order is closed. Tasks and job cards are available to
              view only.
            </p>
          )}
          {!tasks.length && <p className="muted">No requested work added.</p>}
          {tasks.map((t, index) => (
            <details
              className="panel work-order-task-card work-order-task-details"
              key={t.uuid}
            >
              <summary
                className="work-order-task-summary"
                title={t.description}
              >
                <span className="work-order-task-number">Task {index + 1}</span>
                <strong className="work-order-task-title">
                  {t.description}
                </strong>
                <span className="badge">{t.status.replace(/-/g, " ")}</span>
              </summary>
              <div className="work-order-task-body">
                <p className="muted">{sourceLabel(t.source.kind)}</p>
                {t.partsDelay && <p>Parts delay: {t.partsDelay}</p>}
                {t.notes && (
                  <p style={{ whiteSpace: "pre-wrap" }}>
                    Work notes: {t.notes}
                  </p>
                )}
                <>
                  <RequestPartsButton
                    source={{
                      kind: "workTask",
                      uuid: t.uuid,
                      workOrderUuid: uuid,
                    }}
                    label="Request parts for task"
                  />
                  <WorkItemJobCards workOrderUuid={uuid} item={t} />
                </>
              </div>
            </details>
          ))}
        </section>
      )}
      {initial?.status === "completed" && (
        <section className="panel">
          <h3>Logbook entry</h3>
          <LogbookEntryButton order={initial} />
          {initial.closeout?.componentWork?.map((item) => (
            <div key={item.componentUuid}>
              <h4>
                {
                  initial.closeout?.components.find(
                    (c) => c.componentUuid === item.componentUuid,
                  )?.label
                }
                : {componentWorkLabels[item.action]}
              </h4>
              <p>
                {item.date} · {item.description} {item.reference}
              </p>
              <p>
                TSO:{" "}
                {item.before.timeSinceOverhaul === null
                  ? "Not recorded"
                  : `${hours(item.before.timeSinceOverhaul)} h`}{" "}
                →{" "}
                {item.after.timeSinceOverhaul === null
                  ? "Not recorded"
                  : `${hours(item.after.timeSinceOverhaul)} h`}
                ; TSR:{" "}
                {item.before.timeSinceRepair === null
                  ? "Not recorded"
                  : `${hours(item.before.timeSinceRepair)} h`}{" "}
                →{" "}
                {item.after.timeSinceRepair === null
                  ? "Not recorded"
                  : `${hours(item.after.timeSinceRepair)} h`}
              </p>
            </div>
          ))}
          {initial.closeout && (
            <p>
              {initial.closeout.compliance.length} inspection compliance
              record(s) updated at closeout.
            </p>
          )}
        </section>
      )}
      {initial && (
        <section>
          <h3>Work-order job cards</h3>
          <TemplateCopyProgress orderUuid={initial.uuid} />
          <p>
            Each card is a separate copy for this order. Complete and sign all
            of an item’s cards before marking that item completed.
          </p>
          <AsyncForm
            submitLabel="Add missing job card templates"
            disabled={!writable}
            onSubmit={async () => {
              await backend!.workOrder({
                action: "copyTemplates",
                uuid: initial.uuid,
                version: initial.version,
              });
              onDone();
            }}
          >
            <p>
              For an existing order, append missing template copies. Existing
              copies and recorded work are preserved.
            </p>
          </AsyncForm>
          <LinkedTaskCards
            aircraftUuid={initial.aircraftUuid}
            link={{ kind: "workOrder", uuid: initial.uuid }}
          />
        </section>
      )}
      {initial && <WorkOrderCosts order={initial} />}
      {initial ? (
        <Attachments order={initial} writable={writable} />
      ) : (
        <p className="muted">
          Open the work order to upload maintenance-record attachments.
        </p>
      )}
    </>
  );
}
function Attachments({
  order,
  writable,
}: {
  order: WorkOrder;
  writable: boolean;
}) {
  const { snapshot: s, backend } = useWorkspace();
  const [file, setFile] = useState<File>();
  const [fileKey, setFileKey] = useState(0);
  const files = (s?.workOrderAttachments ?? []).filter(
    (f) => f.workOrderUuid === order.uuid,
  );
  return (
    <section>
      <h3>Maintenance-record attachments</h3>
      <ul>
        {files.map((f) => (
          <li key={f.uuid}>
            <a href={f.url} target="_blank" rel="noreferrer" download={f.name}>
              {f.name}
            </a>{" "}
            · {Math.ceil(f.size / 1024)} KB{" "}
            {writable && (
              <DeleteFileButton
                name={f.name}
                onDelete={() => backend!.removeWorkOrderFile(f.uuid)}
              />
            )}
          </li>
        ))}
      </ul>
      {!files.length && <p>No attachments.</p>}
      {writable && (
        <AsyncForm
          submitLabel="Upload attachment"
          onSubmit={async () => {
            if (!file) throw new Error("Choose a maintenance record file.");
            validateWorkOrderFile(file.name, file.type, file.size);
            await backend!.attachWorkOrderFile(order.uuid, file);
            setFile(undefined);
            setFileKey(fileKey + 1);
          }}
        >
          <Field
            label="Maintenance record file"
            hint="PDF, JPEG or PNG, up to 7 MB"
          >
            <input
              key={fileKey}
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
