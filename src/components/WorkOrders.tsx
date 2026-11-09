/**
 * Responsibility: The work orders screen (listing, opening, editing and
 *   closing work orders) and the Add to work order button other screens use.
 * Layer: UI. React components; work order rules live in src/domain.
 * Dependencies: react, react-dom, @phosphor-icons/react, src/data/store.ts,
 *   src/domain (model, readings, components, workOrders, workOrderCards,
 *   workOrderComponentWork, workOrderTaskRemoval), ./PartsRequests,
 *   ./RequestedComponentMovement, ./TaskCards, ./WorkOrderCosts,
 *   ./WorkOrderComponentWork, ./WorkOrderRevisions, ./ReleaseStatements,
 *   ./LogbookEntry, ./LogbookSample, ./LogbookWording,
 *   ./ComponentCloseoutCorrection, ./ShopList, ./design, ./ui.
 */
import { RequestPartsButton } from "./PartsRequests";
import { localDate } from "../domain/model";
import { SECONDS_PER_HOUR } from "../domain/readings";
import { removedTaskCards } from "../domain/workOrderTaskRemoval";
import { RequestedComponentMovement } from "./RequestedComponentMovement";
import { ComponentCloseoutCorrection } from "./ComponentCloseoutCorrection";
import { WorkOrderRevisions } from "./WorkOrderRevisions";
import { WorkOrderCosts } from "./WorkOrderCosts";
import { WorkOrderComponentWork } from "./WorkOrderComponentWork";
import {
  workOrderComponentIds,
  componentWorkLabels,
  serviceDone,
  type ComponentWork,
} from "../domain/workOrderComponentWork";
import { ReleaseStatements } from "./ReleaseStatements";
import { LogbookWording } from "./LogbookWording";
import { LogbookSample } from "./LogbookSample";
import { LogbookEntryButton } from "./LogbookEntry";
import {
  copiesJobCardTemplates,
  workItemCompletionIssue,
} from "../domain/workOrderCards";
import {
  ArchivedJobCardButton,
  LinkedTaskCards,
  WorkItemJobCards,
} from "./TaskCards";
import { useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import {
  can,
  hours,
  totalSeconds,
  aircraftMeterLabels,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import type { Component } from "../domain/components";
import {
  componentReading,
  installedComponents,
  isOpenWorkOrder,
  isPreparingJobCards,
  newWorkTask,
  openingReading,
  taskStatuses,
  unusedWorkSources,
  workOrderCounts,
  workOrderFieldsSchema,
  workOrderProgress,
  workOrdersTaking,
  workOrderStatuses,
  validateWorkOrderFile,
  WORK_ORDER_NUMBER_MAX_LENGTH,
  WORK_ORDER_TEXT_MAX_LENGTH,
  type WorkOrder,
  type WorkSource,
  type WorkTask,
} from "../domain/workOrders";
import {
  AsyncForm,
  DeleteFileButton,
  Field,
  Modal,
  errorText,
  value,
} from "./ui";
import { useStaleSave, type StaleSaveOptions } from "./StaleSave";
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

const CLOSE_WARNING =
  "Closing this work order is permanent. You will no longer be able to modify the work order or its job cards. You can still view tasks and attachments.";
const today = () => localDate();
const sourceLabel = (kind: WorkSource["kind"]) =>
  ({
    discrepancy: "Discrepancy",
    inspection: "Inspection",
    componentRequirement: "Component service",
    airworthiness: "Airworthiness directive",
    manual: "Requested work",
  })[kind];

type SourceChoice = { source: WorkSource; description: string };
type AddToWorkOrderProps = { aircraftUuid: string } & (
  | { source: WorkSource; sources?: never }
  | { source?: never; sources: SourceChoice[] }
);

/**
 * Adds one discrepancy, inspection, service requirement or AD to an open work
 * order on its aircraft, from a dialog listing the orders that can take it.
 * Renders nothing without maintenance permission on the aircraft.
 *
 * @param props.source - The item to add; or
 * @param props.sources - Items to choose from, the first chosen by default.
 * @returns The button and, once opened, the dialog. Adding calls
 *   `backend.workOrder({ action: "add" })` and then shows the order's job card
 *   preparation; it needs a connection.
 */
export function AddToWorkOrder({
  aircraftUuid,
  source,
  sources,
}: AddToWorkOrderProps) {
  const { snapshot: s, online, connected } = useWorkspace();
  const dialog = useAddDialog(sources);
  const selectedSource =
    source ?? sources?.find((x) => x.source.uuid === dialog.sourceUuid)?.source;
  if (!s || !can(s, aircraftUuid, "maintenance")) return null;
  const choices = {
    ...{ sources, sourceUuid: dialog.sourceUuid, selectedSource },
    onSource: dialog.setSourceUuid,
    orders: selectedSource
      ? workOrdersTaking(s, aircraftUuid, selectedSource)
      : [],
    onAdded: dialog.setSubmittedOrder,
  };
  return (
    <>
      <button
        type="button"
        className="button small"
        disabled={!online || !connected}
        onClick={dialog.start}
      >
        Add to work order
      </button>
      {dialog.open &&
        createPortal(
          <AddToWorkOrderDialog
            submittedOrder={dialog.submittedOrder}
            choices={choices}
            onClose={() => dialog.setOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * The work orders screen: counts, the open (or all) orders of one or every
 * aircraft, newest first, and the dialog that opens, edits or closes one.
 *
 * @returns The screen. Saving, closing, copying templates and attachments
 *   call `backend.workOrder`, `attachWorkOrderFile` and `removeWorkOrderFile`;
 *   every change needs a connection and maintenance permission.
 */
export function WorkOrders() {
  const { snapshot: state, online, connected } = useWorkspace();
  const s = state!;
  const [selected, setSelected] = useState<WorkOrder | "new" | null>(null);
  const [aircraft, setAircraft] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const scoped = (s.workOrders ?? []).filter(
    (w) => !aircraft || w.aircraftUuid === aircraft,
  );
  const list = newestFirst(
    scoped.filter((w) => showClosed || isOpenWorkOrder(w)),
  );
  const enabled = online && connected;
  return (
    <>
      <WorkOrdersHeader s={s} enabled={enabled} onOpen={setSelected} />
      <WorkOrderCounts scoped={scoped} />
      <WorkOrderFilters
        s={s}
        filter={{ aircraft, setAircraft, showClosed, setShowClosed }}
      />
      {!enabled && <OfflineNotice />}
      {list.length ? (
        <WorkOrderTable s={s} list={list} onSelect={setSelected} />
      ) : (
        <NoWorkOrders anyInScope={!!scoped.length} />
      )}
      {selected && (
        <WorkOrderDialog
          s={s}
          selected={selected}
          onClose={() => setSelected(null)}
          onReload={setSelected}
        />
      )}
    </>
  );
}

function newestFirst(orders: WorkOrder[]) {
  return orders.sort((a, b) => b.recordedAt - a.recordedAt);
}

// Opening the dialog again starts over from the first item.
function useAddDialog(sources: SourceChoice[] | undefined) {
  const [open, setOpen] = useState(false);
  const [submittedOrder, setSubmittedOrder] = useState<string>();
  const [sourceUuid, setSourceUuid] = useState(sources?.[0]?.source.uuid);
  const start = () => {
    setSubmittedOrder(undefined);
    setSourceUuid(sources?.[0]?.source.uuid);
    setOpen(true);
  };
  return {
    ...{ open, setOpen, submittedOrder, setSubmittedOrder },
    ...{ sourceUuid, setSourceUuid, start },
  };
}

// React events bubble through a portal to the screen around the button, which
// may be a form; a submit here must not reach it.
function AddToWorkOrderDialog({
  submittedOrder,
  choices,
  onClose,
}: {
  submittedOrder: string | undefined;
  choices: AddItemProps;
  onClose: () => void;
}) {
  return (
    <div onSubmit={(e) => e.stopPropagation()}>
      <Modal title="Add to work order" onClose={onClose}>
        <p>
          Associated job card templates will be copied into this work order as
          independent job cards.
        </p>
        {submittedOrder ? (
          <TemplateCopyProgress orderUuid={submittedOrder} accepted />
        ) : (
          <AddItemChoices {...choices} />
        )}
      </Modal>
    </div>
  );
}

type AddItemProps = {
  sources?: SourceChoice[];
  sourceUuid: string | undefined;
  onSource: (uuid: string) => void;
  orders: WorkOrder[];
  selectedSource: WorkSource | undefined;
  onAdded: (orderUuid: string) => void;
};

function AddItemChoices(props: AddItemProps) {
  const { sources, orders, selectedSource } = props;
  return (
    <>
      {sources && (
        <Field label="Required action">
          <select
            value={props.sourceUuid}
            onChange={(e) => props.onSource(e.target.value)}
          >
            {sources.map((item) => (
              <option key={item.source.uuid} value={item.source.uuid}>
                {item.description}
              </option>
            ))}
          </select>
        </Field>
      )}
      {orders.length && selectedSource ? (
        <AddItemForm
          orders={orders}
          source={selectedSource}
          onAdded={props.onAdded}
        />
      ) : (
        <p>
          No available open work orders for this aircraft. Open one from Work
          orders, or check whether this item has already been added.
        </p>
      )}
    </>
  );
}

function AddItemForm({
  orders,
  source,
  onAdded,
}: {
  orders: WorkOrder[];
  source: WorkSource;
  onAdded: (orderUuid: string) => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const submit = async (data: FormData) => {
    const order = orders.find((w) => w.uuid === value(data, "order"))!;
    await backend!.workOrder({
      action: "add",
      uuid: order.uuid,
      version: order.version,
      source,
    });
    onAdded(order.uuid);
  };
  return (
    <AsyncForm
      submitLabel="Add item"
      disabled={!online || !connected}
      onSubmit={submit}
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
  );
}

// Template copies run in the background on the server; this shows their
// progress and offers to resume a copy that stopped.
function TemplateCopyProgress({
  orderUuid,
  accepted = false,
}: {
  orderUuid: string;
  accepted?: boolean;
}) {
  const { snapshot } = useWorkspace();
  const order = snapshot?.workOrders?.find((w) => w.uuid === orderUuid);
  const progress = order?.templateCopy;
  if (!progress)
    return accepted ? (
      <p role="status">
        Item added. Job card preparation will appear here if templates are
        available.
      </p>
    ) : null;
  const done = progress.status === "completed";
  return (
    <div className="notice">
      <p role="status" aria-live="polite">
        {done
          ? `Job cards ready: ${progress.total} added.`
          : `Preparing job cards: ${progress.completed} of ${progress.total}.`}
      </p>
      {!done && <PreparationRunning order={order} />}
    </div>
  );
}

function PreparationRunning({ order }: { order: WorkOrder }) {
  const { snapshot, backend, connected, online } = useWorkspace();
  const progress = order.templateCopy!;
  return (
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
      {snapshot && can(snapshot, order.aircraftUuid, "maintenance") && (
        <AsyncForm
          submitLabel="Resume preparation"
          disabled={!online || !connected}
          onSubmit={async () => {
            await backend!.resumeWorkOrderTemplates(order.uuid);
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
  );
}

function statusTone(status: WorkOrder["status"]): "good" | "warn" | "neutral" {
  if (status === "completed") return "good";
  if (["open", "parts-delay", "awaiting-approval"].includes(status))
    return "warn";
  return "neutral";
}

const statusIcon = (status: WorkOrder["status"]) =>
  ({
    open: ClipboardText,
    "in-progress": Wrench,
    "awaiting-approval": Hourglass,
    "parts-delay": Package,
    completed: CheckCircle,
    cancelled: Prohibit,
  })[status];

function OfflineNotice() {
  return (
    <NoticeBar tone="warn" icon={WifiSlash}>
      Cached work orders are available. Reconnect to make changes.
    </NoticeBar>
  );
}

function WorkOrdersHeader({
  s,
  enabled,
  onOpen,
}: {
  s: Snapshot;
  enabled: boolean;
  onOpen: (selected: "new") => void;
}) {
  const maintains = s.aircraft.some((a) => can(s, a.uuid, "maintenance"));
  return (
    <PageHeader
      eyebrow="MAINTENANCE"
      title="Work orders"
      description="Scoped maintenance work with requested items, job cards, parts and sign-off through closeout."
      actions={
        <button
          className="button primary"
          disabled={!enabled || !maintains}
          onClick={() => onOpen("new")}
        >
          <Plus size={18} weight="bold" aria-hidden="true" />
          Open work order
        </button>
      }
    />
  );
}

function WorkOrderCounts({ scoped }: { scoped: WorkOrder[] }) {
  const counts = workOrderCounts(scoped, today());
  return (
    <StatsStrip className="shop-stats">
      <StatTile label="Open" value={counts.open} />
      <StatTile label="In progress" value={counts.inProgress} />
      <StatTile label="Closed this month" value={counts.closedThisMonth} />
    </StatsStrip>
  );
}

function WorkOrderFilters({
  s,
  filter,
}: {
  s: Snapshot;
  filter: {
    aircraft: string;
    setAircraft: (uuid: string) => void;
    showClosed: boolean;
    setShowClosed: (show: boolean) => void;
  };
}) {
  return (
    <Toolbar
      className="shop-toolbar"
      end={
        <Switch
          label="Include closed work orders"
          checked={filter.showClosed}
          onChange={filter.setShowClosed}
        />
      }
    >
      <ShopSelect
        label="Aircraft"
        icon={Airplane}
        value={filter.aircraft}
        onChange={filter.setAircraft}
      >
        <option value="">All aircraft</option>
        {s.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </ShopSelect>
    </Toolbar>
  );
}

function WorkOrderTable({
  s,
  list,
  onSelect,
}: {
  s: Snapshot;
  list: WorkOrder[];
  onSelect: (order: WorkOrder) => void;
}) {
  return (
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
          {list.map((w) => (
            <WorkOrderRow key={w.uuid} s={s} order={w} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

function WorkOrderRow({
  s,
  order: w,
  onSelect,
}: {
  s: Snapshot;
  order: WorkOrder;
  onSelect: (order: WorkOrder) => void;
}) {
  const progress = workOrderProgress(s, w);
  const tone = statusTone(w.status);
  return (
    <tr>
      <LeadCell order={w} tone={tone} />
      <OpenedCell order={w} tone={tone} />
      <td data-label="Supervisor">
        {w.supervisor || "Unassigned"}
        <small className="shop-priority">{w.priority}</small>
      </td>
      <RequestedWorkCell progress={progress} good={tone === "good"} />
      <CountCell label="Discrepancies" tone="shop-count-danger">
        {progress.outstandingDiscrepancies}
      </CountCell>
      <CountCell label="Parts delays" tone="shop-count-warn">
        {progress.partsDelays}
      </CountCell>
      <td className="shop-num" data-label="Job cards">
        {progress.taskCardsCompleted} / {progress.taskCardsTotal}
      </td>
      <td className="shop-actions-cell">
        <button className="button small" onClick={() => onSelect(w)}>
          Details
        </button>
      </td>
    </tr>
  );
}

type CellProps = { order: WorkOrder; tone: ReturnType<typeof statusTone> };

function LeadCell({ order: w, tone }: CellProps) {
  return (
    <td className="shop-wide">
      <ShopLead
        icon={statusIcon(w.status)}
        tone={tone}
        title={w.number}
        sub={w.aircraft.registration}
      />
    </td>
  );
}

function OpenedCell({ order: w, tone }: CellProps) {
  return (
    <td data-label="Opened">
      <span className="shop-nowrap">{w.dateOpened}</span>
      <span className="shop-sub">
        <StatusPill tone={tone}>
          <span className="shop-cap">{w.status.replace(/-/g, " ")}</span>
        </StatusPill>
      </span>
    </td>
  );
}

function RequestedWorkCell({
  progress,
  good,
}: {
  progress: ReturnType<typeof workOrderProgress>;
  good: boolean;
}) {
  const { completed, total } = progress;
  return (
    <td className="shop-num" data-label="Requested work">
      <span className="shop-wo-progress">
        <span>
          {completed} / {total}
        </span>
        <ProgressTrack
          thin
          tone={good ? "good" : "blue"}
          value={total ? completed / total : 0}
        />
      </span>
    </td>
  );
}

// A count of zero is muted; any other count takes the given tone.
function CountCell({
  label,
  tone,
  children: count,
}: {
  label: string;
  tone: string;
  children: number;
}) {
  return (
    <td className="shop-num" data-label={label}>
      <span className={count ? tone : "shop-zero"}>{count}</span>
    </td>
  );
}

function NoWorkOrders({ anyInScope }: { anyInScope: boolean }) {
  return (
    <EmptyState title="No work orders">
      {anyInScope
        ? "No open work orders match. Include closed work orders to see completed and cancelled orders."
        : "Open a work order for an aircraft, then add inspections, discrepancies and component service requirements."}
    </EmptyState>
  );
}

function WorkOrderDialog({
  s,
  selected,
  onClose,
  onReload,
}: {
  s: Snapshot;
  selected: WorkOrder | "new";
  onClose: () => void;
  onReload: (current: WorkOrder) => void;
}) {
  const isNew = selected === "new";
  // The version is in the key so that Use theirs reloads the form's fields.
  return (
    <Modal
      className="work-order-modal shop-wo-dialog"
      title={isNew ? "Open work order" : selected.number}
      onClose={onClose}
    >
      <WorkOrderForm
        key={isNew ? "new" : `${selected.uuid}:${selected.version}`}
        s={s}
        initial={isNew ? undefined : selected}
        onDone={onClose}
        onReload={onReload}
      />
    </Modal>
  );
}

// How the stale-save review names and formats a work order's fields.
const WORK_ORDER_STALE_SAVE: StaleSaveOptions<WorkOrder> = {
  label: "work order",
  entityUuid: (w) => w.uuid,
  specs: {
    number: "Number",
    dateOpened: "Date opened",
    supervisor: "Supervisor",
    scope: "Scope",
    priority: "Priority",
    status: "Status",
    completionDate: "Completion date",
    releaseOutcome: "Release statement",
    finalReview: "Final review",
    tasks: { label: "Requested work", format: formatTasks },
  },
};

function formatTasks(value: unknown) {
  return (value as WorkOrder["tasks"]).map((t) => t.description).join("; ");
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
  // A saved order shows the readings it captured when it was opened.
  const r = initial?.aircraft ?? openingReading(a);
  const components = selectedComponents.map((uuid) =>
    headerReading(s, a, initial, uuid),
  );
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
      <AircraftReadings readings={r} turbine={a.turbine} />
      {!!components.length && <ComponentReadings components={components} />}
    </div>
  );
}

type Reading = WorkOrder["componentReadings"][number];

// A saved order keeps the readings it captured; a component added since is
// read now. Its preview label leaves out the install position the saved
// reading adds.
function headerReading(
  s: Snapshot,
  a: Aircraft,
  initial: WorkOrder | undefined,
  uuid: string,
): Reading | undefined {
  const prior = initial?.componentReadings.find(
    (c) => c.componentUuid === uuid,
  );
  if (prior) return prior;
  const c = installedComponents(s, a.uuid).find((c) => c.uuid === uuid);
  if (!c) return undefined;
  const reading = componentReading(c, a, today(), Date.now());
  return { ...reading, label: c.componentType };
}

function AircraftReadings({
  readings: r,
  turbine,
}: {
  readings: WorkOrder["aircraft"];
  turbine: boolean | undefined;
}) {
  return (
    <dl className="details-grid shop-readings">
      <ReadingItem term="Aircraft total time">
        {hours(r.totalSeconds)} h
      </ReadingItem>
      <ReadingItem term="Hobbs">{hours(r.hobbs)} h</ReadingItem>
      <ReadingItem term="Tach">{hours(r.tach)} h</ReadingItem>
      <ReadingItem term="Total landings">
        {r.landings ?? "Not recorded"}
      </ReadingItem>
      <ReadingItem term="Tracking meter">
        {aircraftMeterLabels[r.meter]}
      </ReadingItem>
      {turbine && <ReadingItem term="Cycles">{r.cycles}</ReadingItem>}
    </dl>
  );
}

function ReadingItem({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ComponentReadings({
  components,
}: {
  components: (Reading | undefined)[];
}) {
  return (
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
            (c) => c && <ComponentReadingRow key={c.componentUuid} c={c} />,
          )}
        </tbody>
      </table>
    </div>
  );
}

function ComponentReadingRow({ c }: { c: Reading }) {
  return (
    <tr>
      <td>
        {c.label}
        <br />
        {c.serial}
        <small className="block">
          Recorded {new Date(c.recordedAt).toLocaleString()}
        </small>
      </td>
      <td>{c.partNumber}</td>
      <td>{recordedHours(c.timeSinceNew)}</td>
      <td>{recordedHours(c.timeSinceOverhaul)}</td>
      <td>{recordedHours(c.timeSinceRepair)}</td>
      <td>{c.cyclesSinceNew}</td>
    </tr>
  );
}

function recordedHours(seconds: number | null) {
  return seconds === null ? "Not recorded" : `${hours(seconds)} h`;
}

type Draft = ReturnType<typeof useWorkOrderDraft>;
type DraftView = ReturnType<typeof describeDraft>;
type FormProps = {
  s: Snapshot;
  initial?: WorkOrder;
  draft: Draft;
  view: DraftView;
};

function WorkOrderForm({
  s,
  initial,
  onDone,
  onReload,
}: {
  s: Snapshot;
  initial?: WorkOrder;
  onDone: () => void;
  onReload?: (current: WorkOrder) => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const draft = useWorkOrderDraft(s, initial);
  const view = describeDraft(s, initial, draft, online && connected);
  const props = { s, initial, draft, view };
  const stale = useStaleSave(WORK_ORDER_STALE_SAVE);
  return (
    <>
      {draft.confirmTaskRemoval &&
        createPortal(<ConfirmTaskRemoval {...props} />, document.body)}
      <DraftForm
        {...props}
        onDone={onDone}
        onSubmit={(data) =>
          stale.run({
            draft: initial && {
              ...initial,
              ...readWorkOrderFields(props, data),
              tasks: draft.tasks,
            },
            loaded: initial,
            find: (live) =>
              live.workOrders?.find((w) => w.uuid === initial?.uuid),
            save: (version) =>
              submitWorkOrder(backend!, props, data, onDone, version),
            useTheirs: (current) =>
              current && onReload ? onReload(current) : onDone(),
          })
        }
      />
      <WorkOrderRecords {...props} onDone={onDone} />
      {stale.dialog}
    </>
  );
}

function useWorkOrderDraft(s: Snapshot, initial: WorkOrder | undefined) {
  const [aircraftUuid, setAircraftUuid] = useState(
    initial?.aircraftUuid ??
      s.aircraft.find((a) => can(s, a.uuid, "maintenance"))?.uuid ??
      "",
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
  return {
    ...{ aircraftUuid, setAircraftUuid, componentUuids, setComponents },
    ...{ tasks, setTasks, removingTasks, setRemovingTasks },
    ...{ removeTaskIds, setRemoveTaskIds, removeTaskError, setRemoveTaskError },
    ...{ confirmTaskRemoval, setConfirmTaskRemoval },
    ...{ componentWork, setComponentWork, previewFields, setPreviewFields },
    ...{ releaseOutcome, setReleaseOutcome, sourceKey, setSourceKey },
    ...{ manual, setManual, status, setStatus, uuid },
  };
}

// The form is read-only while job cards are being prepared, once the order is
// closed, offline, or without maintenance permission on the aircraft.
function describeDraft(
  s: Snapshot,
  initial: WorkOrder | undefined,
  draft: Draft,
  online: boolean,
) {
  const { aircraftUuid, tasks, componentWork, status, uuid } = draft;
  const stored = s.workOrders?.find((w) => w.uuid === uuid);
  const writable =
    (!stored || !isPreparingJobCards(stored)) &&
    online &&
    can(s, aircraftUuid, "maintenance") &&
    (!initial || isOpenWorkOrder(initial));
  const closeoutComponentIds = workOrderComponentIds(
    s,
    {
      uuid,
      tasks,
      componentWork,
      componentReadings: draft.componentUuids.map((id) => ({
        componentUuid: id,
      })),
    },
    status !== "completed",
  );
  return {
    writable,
    closing: writable && (status === "completed" || status === "cancelled"),
    closeoutComponentIds,
    selectedComponentWork: componentWork.filter((item) =>
      closeoutComponentIds.includes(item.componentUuid),
    ),
    sources: unusedWorkSources(s, aircraftUuid, tasks),
    choices: componentChoices(s, aircraftUuid, initial),
  };
}

// Installed components, then components the saved order recorded that have
// since left the aircraft.
function componentChoices(
  s: Snapshot,
  aircraftUuid: string,
  initial: WorkOrder | undefined,
) {
  const installed = installedComponents(s, aircraftUuid);
  return [
    ...installed.map((c) => ({
      uuid: c.uuid,
      label: `${c.componentType} · ${c.serial} · ${c.installPosition ?? ""}`,
    })),
    ...(initial?.componentReadings ?? [])
      .filter((c) => !installed.some((x) => x.uuid === c.componentUuid))
      .map((c) => ({
        uuid: c.componentUuid,
        label: `${c.label} · ${c.serial} (recorded)`,
      })),
  ];
}

// Removal is staged in the draft and applied when the order is saved; it is
// refused here when another job card lists one of the cards as a prerequisite.
function removeSelectedTasks(s: Snapshot, draft: Draft) {
  const { tasks, removeTaskIds } = draft;
  draft.setRemoveTaskError("");
  const removed = tasks.filter((task) => removeTaskIds.includes(task.uuid));
  const remaining = tasks.filter((task) => !removeTaskIds.includes(task.uuid));
  try {
    removedTaskCards(s, draft.uuid, removed, remaining);
    draft.setTasks(remaining);
    draft.setComponentWork((current) =>
      current.filter(
        (work) => !work.taskUuid || !removeTaskIds.includes(work.taskUuid),
      ),
    );
    draft.setRemoveTaskIds([]);
    draft.setRemovingTasks(false);
  } catch (error) {
    draft.setRemoveTaskError(errorText(error, "Unable to remove tasks."));
  }
}

function updateTask(draft: Draft, uuid: string, patch: Partial<WorkTask>) {
  draft.setTasks(
    draft.tasks.map((t) => (t.uuid === uuid ? { ...t, ...patch } : t)),
  );
}

function moveTask(draft: Draft, uuid: string, direction: -1 | 1) {
  draft.setTasks((current) => {
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
}

function ConfirmTaskRemoval({ s, draft, view }: FormProps) {
  const proceed = () => {
    draft.setConfirmTaskRemoval(false);
    removeSelectedTasks(s, draft);
  };
  return (
    <Modal
      title="Remove selected tasks?"
      onClose={() => draft.setConfirmTaskRemoval(false)}
    >
      <TaskRemovalWarning count={draft.removeTaskIds.length} />
      <div className="job-card-remove-actions">
        <button
          type="button"
          className="button"
          autoFocus
          onClick={() => draft.setConfirmTaskRemoval(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!view.writable || !draft.removeTaskIds.length}
          onClick={proceed}
        >
          Yes, proceed
        </button>
      </div>
    </Modal>
  );
}

function TaskRemovalWarning({ count }: { count: number }) {
  return (
    <>
      <p className="notice">
        Removing these {count} selected task(s) will archive their linked job
        cards and remove them from the active work order.
      </p>
      <p>
        All recorded work, signatures, and attachments will be preserved in
        Archived tasks. No signer approval is required. Source templates and
        cards still linked to other tasks stay active.
      </p>
      <p>
        Click Yes, proceed to stage the removal, then Save work order to apply
        it.
      </p>
    </>
  );
}

// Closing needs the user's confirmation, listing the tracking each
// component's repair or overhaul will reset.
// `version` is the one the save is checked against: the order's, or the
// current one when the user keeps a stale draft.
async function submitWorkOrder(
  backend: Backend,
  props: FormProps,
  data: FormData,
  onDone: () => void,
  version: number,
) {
  const { s, initial, draft, view } = props;
  const fields = readWorkOrderFields(props, data);
  if (view.closing && !window.confirm(closeConfirmation(draft, view))) return;
  await backend.workOrder({
    action: "save",
    uuid: draft.uuid,
    version,
    fields,
    completionReadings:
      draft.status === "completed"
        ? readCompletion(s, initial, draft.aircraftUuid, data)
        : undefined,
    componentUuids: draft.componentUuids,
    componentWork: view.selectedComponentWork,
    tasks: draft.tasks,
  });
  onDone();
}

function readWorkOrderFields({ initial, draft }: FormProps, data: FormData) {
  return workOrderFieldsSchema.parse({
    number: value(data, "number"),
    aircraftUuid: draft.aircraftUuid,
    dateOpened: value(data, "dateOpened"),
    supervisor: value(data, "supervisor"),
    scope: value(data, "scope"),
    priority: value(data, "priority"),
    status: draft.status,
    completionDate: value(data, "completionDate"),
    releaseOutcome: value(data, "releaseOutcome"),
    finalReview: initial?.finalReview ?? "",
  });
}

function closeConfirmation(draft: Draft, view: DraftView) {
  const resets =
    draft.status === "completed"
      ? view.selectedComponentWork
          .map((item) => componentResetLine(view, item))
          .join("\n")
      : "";
  return `${CLOSE_WARNING}\n\n${resets}\n\nClose this work order?`;
}

function componentResetLine(view: DraftView, item: ComponentWork) {
  const c = view.choices.find((c) => c.uuid === item.componentUuid);
  const { repair, overhaul } = serviceDone(item);
  return `${c?.label ?? item.componentUuid}: ${componentWorkLabels[item.action]}${repair ? "; TSR → 0.0 h" : ""}${overhaul ? "; TSO → 0.0 h" : ""}`;
}

// Optional counters are read only when the form shows them; cycles fall back
// to the recorded or current aircraft cycles.
function readCompletion(
  s: Snapshot,
  initial: WorkOrder | undefined,
  aircraftUuid: string,
  data: FormData,
) {
  const seconds = (name: string) =>
    Math.round(Number(value(data, name)) * SECONDS_PER_HOUR);
  const optional = (name: string) =>
    data.has(name) ? seconds(name) : undefined;
  return {
    totalSeconds: seconds("completionTotalHours"),
    hobbs: seconds("completionHobbs"),
    tach: seconds("completionTach"),
    cyclicHobbs: optional("completionCyclicHobbs"),
    flightTimeLog: optional("completionFlightTimeLog"),
    landings: Number(value(data, "completionLandings")),
    cycles: data.has("completionCycles")
      ? Number(value(data, "completionCycles"))
      : (initial?.closeout?.aircraft.cycles ??
        s.aircraft.find((a) => a.uuid === aircraftUuid)!.cycles),
  };
}

function DraftForm(
  props: FormProps & {
    onDone: () => void;
    onSubmit: (data: FormData) => Promise<void>;
  },
) {
  const { initial, draft, view } = props;
  return (
    <AsyncForm
      onChange={draft.setPreviewFields}
      submitLabel={initial ? "Save work order" : "Open work order"}
      onClose={props.onDone}
      disabled={!view.writable}
      onSubmit={props.onSubmit}
    >
      <WorkOrderHeaderFields {...props} />
      <div className="work-order-workspace">
        <RequestedWorkPanel {...props} />
        <ReadingsPanel {...props} />
      </div>
      {view.writable && draft.status !== "cancelled" && (
        <DraftComponentWork {...props} />
      )}
      {view.closing && (
        <p role="alert" className="notice">
          {CLOSE_WARNING}
        </p>
      )}
      <p className="muted">
        Completing this order records compliance for completed routine
        inspections. Component repair and overhaul selections update tracking at
        closeout. Discrepancy resolution uses its own record.
      </p>
      <CloseoutPanel {...props} />
      <DraftLogbookSample {...props} />
    </AsyncForm>
  );
}

function DraftComponentWork({ s, draft, view }: FormProps) {
  return (
    <WorkOrderComponentWork
      s={s}
      ids={view.closeoutComponentIds}
      aircraftUuid={draft.aircraftUuid}
      fields={draft.previewFields}
      choices={view.selectedComponentWork}
      onChange={draft.setComponentWork}
      closing={draft.status === "completed"}
    />
  );
}

function DraftLogbookSample({ s, initial, draft, view }: FormProps) {
  if (initial && !isOpenWorkOrder(initial)) return null;
  return (
    <LogbookSample
      s={s}
      initial={initial}
      uuid={draft.uuid}
      aircraftUuid={draft.aircraftUuid}
      componentUuids={draft.componentUuids}
      tasks={draft.tasks}
      status={draft.status}
      fields={draft.previewFields}
      releaseOutcome={draft.releaseOutcome}
      componentWork={view.selectedComponentWork}
    />
  );
}

function WorkOrderHeaderFields({ s, initial, draft }: FormProps) {
  return (
    <div className="work-order-header-fields">
      <Field label="Work order number">
        <input
          name="number"
          placeholder="Automatic if blank"
          title="Leave blank to assign the next available number."
          defaultValue={initial?.number}
          maxLength={WORK_ORDER_NUMBER_MAX_LENGTH}
        />
      </Field>
      <AircraftField s={s} initial={initial} draft={draft} />
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
          maxLength={WORK_ORDER_TEXT_MAX_LENGTH}
        />
      </Field>
      <PriorityField initial={initial} />
      <StatusField initial={initial} draft={draft} />
    </div>
  );
}

// A new order's aircraft decides its items and components, so changing it
// clears them.
function AircraftField({
  s,
  initial,
  draft,
}: Pick<FormProps, "s" | "initial" | "draft">) {
  const choose = (aircraftUuid: string) => {
    draft.setAircraftUuid(aircraftUuid);
    draft.setComponents([]);
    draft.setComponentWork([]);
    draft.setTasks([]);
    draft.setSourceKey("");
  };
  const options = initial
    ? s.aircraft
    : s.aircraft.filter((a) => can(s, a.uuid, "maintenance"));
  return (
    <Field label="Aircraft">
      <select
        value={draft.aircraftUuid}
        disabled={!!initial}
        onChange={(e) => choose(e.target.value)}
      >
        {options.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PriorityField({ initial }: { initial?: WorkOrder }) {
  return (
    <Field label="Priority">
      <select name="priority" defaultValue={initial?.priority ?? "routine"}>
        {workOrderFieldsSchema.shape.priority.options.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
    </Field>
  );
}

function StatusField({ initial, draft }: Pick<FormProps, "initial" | "draft">) {
  return (
    <Field label="Status">
      <select
        aria-label="Work order status"
        value={draft.status}
        disabled={!initial}
        onChange={(e) => draft.setStatus(e.target.value as WorkOrder["status"])}
      >
        {workOrderStatuses.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </Field>
  );
}

function RequestedWorkPanel(props: FormProps) {
  const { initial, draft, view } = props;
  return (
    <section className="work-order-panel" aria-label="Requested work">
      <input type="hidden" name="scope" value={initial?.scope ?? ""} />
      {view.writable && (
        <>
          <h3>Requested work</h3>
          <TaskRemovalControls {...props} />
          <RequestedWorkControls {...props} />
          {!draft.tasks.length && (
            <p className="muted">No requested work added yet.</p>
          )}
          {draft.tasks.map((t, index) => (
            <EditableTask key={t.uuid} {...props} task={t} index={index} />
          ))}
        </>
      )}
    </section>
  );
}

function TaskRemovalControls({ initial, draft }: FormProps) {
  const pending = initial?.tasks.some(
    (task) => !draft.tasks.some((current) => current.uuid === task.uuid),
  );
  const start = () => {
    draft.setRemovingTasks(true);
    draft.setRemoveTaskIds([]);
    draft.setRemoveTaskError("");
  };
  return (
    <div className="work-order-remove-tasks">
      {!draft.removingTasks ? (
        <button
          type="button"
          className="button small"
          disabled={!draft.tasks.length}
          onClick={start}
        >
          Remove tasks
        </button>
      ) : (
        <TaskRemovalSelection draft={draft} />
      )}
      {pending && (
        <p role="status" className="muted">
          Task removal is pending. Save work order to apply it, or close without
          saving to keep the tasks.
        </p>
      )}
    </div>
  );
}

function TaskRemovalSelection({ draft }: { draft: Draft }) {
  return (
    <>
      <p>
        Select tasks to remove from the active work order. Their job cards,
        signatures, and attachments will be archived when you save. Source
        templates stay available.
      </p>
      {!draft.tasks.length && (
        <p className="notice" role="status">
          No tasks remain to select.
        </p>
      )}
      <TaskRemovalActions draft={draft} />
      {draft.removeTaskError && (
        <p className="error" role="alert">
          {draft.removeTaskError}
        </p>
      )}
    </>
  );
}

// Every task can be removed; its job cards are archived, not deleted.
function TaskRemovalActions({ draft }: { draft: Draft }) {
  const removable = draft.tasks;
  const cancel = () => {
    draft.setRemovingTasks(false);
    draft.setRemoveTaskIds([]);
    draft.setRemoveTaskError("");
  };
  return (
    <div className="job-card-remove-actions">
      <button
        type="button"
        className="button small"
        disabled={!removable.length}
        onClick={() => draft.setRemoveTaskIds(removable.map((t) => t.uuid))}
      >
        Select all removable
      </button>
      <button
        type="button"
        className="button primary"
        disabled={!draft.removeTaskIds.length}
        onClick={() => draft.setConfirmTaskRemoval(true)}
      >
        Remove selected ({draft.removeTaskIds.length})
      </button>
      <button type="button" className="button" onClick={cancel}>
        Cancel removal
      </button>
    </div>
  );
}

function RequestedWorkControls({ s, draft, view }: FormProps) {
  const addMovement = (component: Component, work: ComponentWork) => {
    const task = newWorkTask(
      { kind: "manual", uuid: work.taskUuid! },
      `${work.action === "install" ? "Install" : "Remove"} ${component.componentType} P/N ${component.partNumber}; S/N ${component.serial}. ${work.description}`,
    );
    draft.setTasks([...draft.tasks, { ...task, uuid: work.taskUuid! }]);
    draft.setComponentWork([
      ...draft.componentWork.filter((w) => w.componentUuid !== component.uuid),
      work,
    ]);
  };
  return (
    <div className="requested-work-controls">
      <ExistingWorkRow draft={draft} sources={view.sources} />
      <ManualWorkRow draft={draft} />
      <RequestedComponentMovement
        key={draft.aircraftUuid}
        s={s}
        aircraftUuid={draft.aircraftUuid}
        choices={view.selectedComponentWork}
        onAdd={addMovement}
      />
    </div>
  );
}

function ExistingWorkRow({
  draft,
  sources,
}: {
  draft: Draft;
  sources: DraftView["sources"];
}) {
  return (
    <div className="requested-work-add-row">
      <Field label="Existing work item">
        <select
          value={draft.sourceKey}
          onChange={(e) => draft.setSourceKey(e.target.value)}
        >
          <option value="">
            Select an inspection, discrepancy or service requirement
          </option>
          {sources.map((x) => (
            <option key={sourceKey(x)} value={sourceKey(x)}>
              {sourceLabel(x.source.kind)} · {x.description}
            </option>
          ))}
        </select>
      </Field>
      <button
        type="button"
        className="button"
        disabled={!draft.sourceKey}
        onClick={() => addSelectedWork(draft, sources)}
      >
        Add selected work
      </button>
    </div>
  );
}

function addSelectedWork(draft: Draft, sources: DraftView["sources"]) {
  const item = sources.find((x) => sourceKey(x) === draft.sourceKey);
  if (item)
    draft.setTasks([
      ...draft.tasks,
      newWorkTask(item.source, item.description),
    ]);
  draft.setSourceKey("");
}

function sourceKey({ source }: SourceChoice) {
  return `${source.kind}:${source.uuid}`;
}

function ManualWorkRow({ draft }: { draft: Draft }) {
  const add = () => {
    draft.setTasks([
      ...draft.tasks,
      newWorkTask(
        { kind: "manual", uuid: crypto.randomUUID() },
        draft.manual.trim(),
      ),
    ]);
    draft.setManual("");
  };
  return (
    <div className="requested-work-add-row">
      <Field label="Additional requested work">
        <input
          value={draft.manual}
          maxLength={WORK_ORDER_TEXT_MAX_LENGTH}
          onChange={(e) => draft.setManual(e.target.value)}
        />
      </Field>
      <button
        type="button"
        className="button"
        disabled={!draft.manual.trim()}
        onClick={add}
      >
        Add requested work
      </button>
    </div>
  );
}

type TaskProps = FormProps & { task: WorkTask; index: number };

function EditableTask(props: TaskProps) {
  const { draft, task: t, index } = props;
  return (
    <div className="panel work-order-task-card">
      {draft.removingTasks && (
        <RemoveTaskChoice draft={draft} task={t} index={index} />
      )}
      <details className="work-order-task-details">
        <TaskSummary task={t} index={index} />
        <div className="work-order-task-body">
          <p className="muted">{sourceLabel(t.source.kind)}</p>
          <TaskMoveButtons {...props} />
          <p className="muted">
            Use Move up or Move down to reorder tasks, then save the work order.
          </p>
          <LogbookWording
            included={t.includeInLogbook}
            phrase={t.logbookPhrase}
            onChange={(patch) => updateTask(draft, t.uuid, patch)}
          />
          <TaskReferenceField {...props} />
          <TaskProgressFields {...props} />
          <TaskJobCards {...props} />
        </div>
      </details>
    </div>
  );
}

function RemoveTaskChoice({
  draft,
  task: t,
  index,
}: Pick<TaskProps, "draft" | "task" | "index">) {
  return (
    <label className="job-card-remove-choice">
      <input
        type="checkbox"
        aria-label={`Remove task ${index + 1}: ${t.description}`}
        checked={draft.removeTaskIds.includes(t.uuid)}
        onChange={(event) =>
          draft.setRemoveTaskIds((current) =>
            event.target.checked
              ? [...current, t.uuid]
              : current.filter((id) => id !== t.uuid),
          )
        }
      />
      Select task to remove and archive
    </label>
  );
}

function TaskSummary({ task: t, index }: { task: WorkTask; index: number }) {
  return (
    <summary className="work-order-task-summary" title={t.description}>
      <span className="work-order-task-number">Task {index + 1}</span>
      <strong className="work-order-task-title">{t.description}</strong>
      <span className="badge">{t.status.replace(/-/g, " ")}</span>
    </summary>
  );
}

function TaskMoveButtons({ draft, task: t, index }: TaskProps) {
  return (
    <div className="work-order-task-move">
      <button
        type="button"
        className="button"
        aria-label={`Move task ${index + 1} up`}
        disabled={index === 0}
        onClick={() => moveTask(draft, t.uuid, -1)}
      >
        Move up
      </button>
      <button
        type="button"
        className="button"
        aria-label={`Move task ${index + 1} down`}
        disabled={index === draft.tasks.length - 1}
        onClick={() => moveTask(draft, t.uuid, 1)}
      >
        Move down
      </button>
    </div>
  );
}

// The reference feeds the logbook entry, so it is asked for only while the
// task is included in it.
function TaskReferenceField({ draft, task: t, index }: TaskProps) {
  if (!(t.includeInLogbook ?? true)) return null;
  return (
    <Field
      label={`Task ${index + 1} maintenance manual reference`}
      hint="Used for log book entry data."
    >
      <input
        value={t.maintenanceReference ?? ""}
        maxLength={WORK_ORDER_TEXT_MAX_LENGTH}
        onChange={(e) =>
          updateTask(draft, t.uuid, { maintenanceReference: e.target.value })
        }
      />
    </Field>
  );
}

function TaskProgressFields({ s, draft, task: t, index }: TaskProps) {
  const issue = workItemCompletionIssue(s, draft.uuid, t);
  const update = (patch: Partial<WorkTask>) => updateTask(draft, t.uuid, patch);
  return (
    <>
      {issue && <p className="muted">{issue}</p>}
      <div className="form-grid">
        <TaskStatusField task={t} index={index} issue={issue} update={update} />
        <Field label={`Task ${index + 1} parts delay`}>
          <input
            value={t.partsDelay}
            maxLength={WORK_ORDER_TEXT_MAX_LENGTH}
            onChange={(e) => update({ partsDelay: e.target.value })}
          />
        </Field>
      </div>
      <Field label={`Task ${index + 1} work notes`}>
        <textarea
          value={t.notes}
          maxLength={WORK_ORDER_TEXT_MAX_LENGTH}
          onChange={(e) => update({ notes: e.target.value })}
        />
      </Field>
    </>
  );
}

// "completed" stays unavailable while the item's job cards block it.
function TaskStatusField({
  task: t,
  index,
  issue,
  update,
}: {
  task: WorkTask;
  index: number;
  issue: string;
  update: (patch: Partial<WorkTask>) => void;
}) {
  return (
    <Field label={`Task ${index + 1} status`}>
      <select
        value={t.status}
        onChange={(e) =>
          update({ status: e.target.value as WorkTask["status"] })
        }
      >
        {taskStatuses.map((v) => (
          <option key={v} value={v} disabled={v === "completed" && !!issue}>
            {v}
          </option>
        ))}
      </select>
    </Field>
  );
}

// Job cards and parts requests attach to a saved task only.
function TaskJobCards({ initial, draft, task: t }: TaskProps) {
  const saved = initial?.tasks.some((x) => x.uuid === t.uuid);
  const remove = () =>
    draft.setTasks(draft.tasks.filter((x) => x.uuid !== t.uuid));
  return (
    <>
      {saved ? (
        <SavedTaskLinks orderUuid={draft.uuid} task={t} />
      ) : (
        copiesJobCardTemplates(t.source.kind) && (
          <p className="muted">
            Save the work order to create this item’s job cards from its
            templates.
          </p>
        )
      )}
      {!saved && (
        <button type="button" className="text-button" onClick={remove}>
          Remove unsaved task
        </button>
      )}
    </>
  );
}

function SavedTaskLinks({
  orderUuid,
  task,
}: {
  orderUuid: string;
  task: WorkTask;
}) {
  return (
    <>
      <RequestPartsButton
        source={{ kind: "workTask", uuid: task.uuid, workOrderUuid: orderUuid }}
        label="Request parts for task"
      />
      <WorkItemJobCards workOrderUuid={orderUuid} item={task} />
    </>
  );
}

function ReadingsPanel({ s, initial, draft, view }: FormProps) {
  const { componentUuids, setComponents } = draft;
  const toggle = (uuid: string, checked: boolean) =>
    setComponents(
      checked
        ? [...componentUuids, uuid]
        : componentUuids.filter((id) => id !== uuid),
    );
  return (
    <aside
      className="work-order-panel work-order-readings"
      aria-label="Aircraft and component readings"
    >
      <ReadingHeader
        s={s}
        aircraftUuid={draft.aircraftUuid}
        initial={initial}
        selectedComponents={componentUuids}
      />
      <h3>Component times in header</h3>
      <p>
        Select the installed engines, propellers or other components to include.
        Unknown overhaul or repair times remain unrecorded.
      </p>
      {view.choices.map((c) => (
        <label className="block" key={c.uuid}>
          <input
            type="checkbox"
            checked={componentUuids.includes(c.uuid)}
            onChange={(e) => toggle(c.uuid, e.target.checked)}
          />{" "}
          {c.label}
        </label>
      ))}
      {!view.choices.length && (
        <p className="muted">No installed components for this aircraft.</p>
      )}
    </aside>
  );
}

// Readings are confirmed only while completing an open order, or shown again
// for one that recorded them.
function CloseoutPanel(props: FormProps) {
  const { initial, draft, view } = props;
  const completing = draft.status === "completed";
  const showReadings =
    completing && (!initial || isOpenWorkOrder(initial) || initial.closeout);
  return (
    <details className="work-order-panel work-order-closeout" open={completing}>
      <summary>Closeout</summary>
      {showReadings && <CompletionReadings {...props} />}

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
        value={draft.releaseOutcome}
        onChange={draft.setReleaseOutcome}
        editable={view.writable}
      />
    </details>
  );
}

function CompletionReadings({ s, initial, draft }: FormProps) {
  const recorded = initial?.closeout?.aircraft;
  const a = s.aircraft.find((a) => a.uuid === draft.aircraftUuid);
  return (
    <>
      <p>
        Confirm the aircraft readings at completion. Saving updates compliance
        for completed routine inspections and recalculates their next due
        limits. Cancelled items and absolute life limits are unchanged.
      </p>
      <div className="form-grid">
        {(recorded?.cyclicHobbs !== undefined || a?.helicopter) && (
          <HourReading
            name="completionCyclicHobbs"
            label="Completion Collective hourmeter (hours)"
            seconds={recorded?.cyclicHobbs ?? a?.currentCyclicHobbs ?? 0}
          />
        )}
        {(recorded?.flightTimeLog !== undefined || a?.flightTimeLog) && (
          <HourReading
            name="completionFlightTimeLog"
            label="Completion Flight time log (hours)"
            seconds={recorded?.flightTimeLog ?? a?.currentFlightTimeLog ?? 0}
          />
        )}
        {completionCounters(s, initial, draft.aircraftUuid).map(
          ([name, label, defaultValue]) => (
            <CounterReading key={name} {...{ name, label, defaultValue }} />
          ),
        )}
      </div>
    </>
  );
}

// Landings and cycles are whole counts; times take any decimal.
function CounterReading({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: number;
}) {
  const whole = name === "completionCycles" || name === "completionLandings";
  return (
    <Field label={label}>
      <input
        name={name}
        type="number"
        min="0"
        step={whole ? "1" : "any"}
        required
        defaultValue={defaultValue}
      />
    </Field>
  );
}

function HourReading({
  name,
  label,
  seconds,
}: {
  name: string;
  label: string;
  seconds: number;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        type="number"
        min="0"
        step="0.1"
        required
        defaultValue={seconds / SECONDS_PER_HOUR}
      />
    </Field>
  );
}

// Defaults are the readings a closed order recorded, else the aircraft's
// current ones; only a turbine aircraft records cycles.
function completionCounters(
  s: Snapshot,
  initial: WorkOrder | undefined,
  aircraftUuid: string,
) {
  const recorded = initial?.closeout?.aircraft;
  const aircraft = () => s.aircraft.find((a) => a.uuid === aircraftUuid)!;
  const counters = [
    [
      "completionTotalHours",
      "Completion aircraft total time (hours)",
      (recorded?.totalSeconds ?? totalSeconds(aircraft())) / SECONDS_PER_HOUR,
    ],
    [
      "completionHobbs",
      "Completion Hobbs (hours)",
      (recorded?.hobbs ?? aircraft().currentHobbs) / SECONDS_PER_HOUR,
    ],
    [
      "completionTach",
      "Completion tach (hours)",
      (recorded?.tach ?? aircraft().currentTach) / SECONDS_PER_HOUR,
    ],
    [
      "completionLandings",
      "Completion aircraft total landings",
      recorded?.landings ?? aircraft().landings,
    ],
    [
      "completionCycles",
      "Completion cycles",
      recorded?.cycles ?? aircraft().cycles,
    ],
  ] as const;
  return counters.filter(
    ([name]) =>
      name !== "completionCycles" ||
      s.aircraft.find((a) => a.uuid === aircraftUuid)?.turbine,
  );
}

function WorkOrderRecords(props: FormProps & { onDone: () => void }) {
  const { s, initial, draft, view, onDone } = props;
  return (
    <>
      {!!initial?.archivedTasks?.length && (
        <ArchivedTasks s={s} entries={initial.archivedTasks} />
      )}
      {initial && <WorkOrderRevisions order={initial} onDone={onDone} />}
      {initial && (
        <ComponentCloseoutCorrection order={initial} onDone={onDone} />
      )}
      {!view.writable && initial && (
        <ReadOnlyTasks order={initial} tasks={draft.tasks} uuid={draft.uuid} />
      )}
      {initial?.status === "completed" && <CloseoutRecord order={initial} />}
      {initial && (
        <JobCardsSection
          order={initial}
          writable={view.writable}
          onDone={onDone}
        />
      )}
      {initial && <WorkOrderCosts order={initial} />}
      {initial ? (
        <Attachments order={initial} writable={view.writable} />
      ) : (
        <p className="muted">
          Open the work order to upload maintenance-record attachments.
        </p>
      )}
    </>
  );
}

type ArchivedTask = NonNullable<WorkOrder["archivedTasks"]>[number];

function ArchivedTasks({
  s,
  entries,
}: {
  s: Snapshot;
  entries: ArchivedTask[];
}) {
  return (
    <section className="panel" aria-label="Archived tasks">
      <h3>Archived tasks ({entries.length})</h3>
      <p className="muted">
        Removed from the active work order. Original records, signatures, and
        attachments are preserved and read-only.
      </p>
      {entries.map((entry, index) => (
        <ArchivedTaskDetails
          key={`${entry.task.uuid}:${entry.removedAt}:${index}`}
          s={s}
          entry={entry}
        />
      ))}
    </section>
  );
}

function ArchivedTaskDetails({
  s,
  entry,
}: {
  s: Snapshot;
  entry: ArchivedTask;
}) {
  const { task } = entry;
  return (
    <details>
      <summary>{task.description}</summary>
      <p>
        Archived by {entry.removedByName} ·{" "}
        {new Date(entry.removedAt).toLocaleString()}
      </p>
      <p>Task status at removal: {task.status}</p>
      {task.notes && <p style={{ whiteSpace: "pre-wrap" }}>{task.notes}</p>}
      {task.partsDelay && <p>Parts delay: {task.partsDelay}</p>}
      {task.maintenanceReference && (
        <p>Maintenance reference: {task.maintenanceReference}</p>
      )}
      {entry.componentWork?.map((work) => (
        <p key={work.componentUuid}>
          {componentWorkLabels[work.action]}: {work.description}
        </p>
      ))}
      <ArchivedCards s={s} cardUuids={entry.cardUuids} />
    </details>
  );
}

function ArchivedCards({ s, cardUuids }: { s: Snapshot; cardUuids: string[] }) {
  return (
    <>
      <ul>
        {cardUuids.map((id) => {
          const card = s.archivedTaskCards?.find((card) => card.uuid === id);
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
      {!cardUuids.length && (
        <p className="muted">
          No job cards were moved into the archive for this task.
        </p>
      )}
    </>
  );
}

function ReadOnlyTasks({
  order,
  tasks,
  uuid,
}: {
  order: WorkOrder;
  tasks: WorkTask[];
  uuid: string;
}) {
  return (
    <section aria-label="Requested work">
      <h3>Requested work</h3>
      {!isOpenWorkOrder(order) && (
        <p className="notice">
          This work order is closed. Tasks and job cards are available to view
          only.
        </p>
      )}
      {!tasks.length && <p className="muted">No requested work added.</p>}
      {tasks.map((t, index) => (
        <details
          className="panel work-order-task-card work-order-task-details"
          key={t.uuid}
        >
          <TaskSummary task={t} index={index} />
          <div className="work-order-task-body">
            <p className="muted">{sourceLabel(t.source.kind)}</p>
            {t.partsDelay && <p>Parts delay: {t.partsDelay}</p>}
            {t.notes && (
              <p style={{ whiteSpace: "pre-wrap" }}>Work notes: {t.notes}</p>
            )}
            <SavedTaskLinks orderUuid={uuid} task={t} />
          </div>
        </details>
      ))}
    </section>
  );
}

function CloseoutRecord({ order }: { order: WorkOrder }) {
  const { closeout } = order;
  return (
    <section className="panel">
      <h3>Logbook entry</h3>
      <LogbookEntryButton order={order} />
      {closeout?.componentWork?.map((item) => (
        <div key={item.componentUuid}>
          <h4>
            {
              closeout?.components.find(
                (c) => c.componentUuid === item.componentUuid,
              )?.label
            }
            : {componentWorkLabels[item.action]}
          </h4>
          <p>
            {item.date} · {item.description} {item.reference}
          </p>
          <TrackingChange item={item} />
        </div>
      ))}
      {closeout && (
        <p>
          {closeout.compliance.length} inspection compliance record(s) updated
          at closeout.
        </p>
      )}
    </section>
  );
}

function TrackingChange({
  item,
}: {
  item: NonNullable<
    NonNullable<WorkOrder["closeout"]>["componentWork"]
  >[number];
}) {
  const { before, after } = item;
  return (
    <p>
      TSO: {recordedHours(before.timeSinceOverhaul)} →{" "}
      {recordedHours(after.timeSinceOverhaul)}; TSR:{" "}
      {recordedHours(before.timeSinceRepair)} →{" "}
      {recordedHours(after.timeSinceRepair)}
    </p>
  );
}

function JobCardsSection({
  order,
  writable,
  onDone,
}: {
  order: WorkOrder;
  writable: boolean;
  onDone: () => void;
}) {
  return (
    <section>
      <h3>Work-order job cards</h3>
      <TemplateCopyProgress orderUuid={order.uuid} />
      <p>
        Each card is a separate copy for this order. Complete and sign all of an
        item’s cards before marking that item completed.
      </p>
      <CopyTemplatesForm order={order} writable={writable} onDone={onDone} />
      <LinkedTaskCards
        aircraftUuid={order.aircraftUuid}
        link={{ kind: "workOrder", uuid: order.uuid }}
      />
    </section>
  );
}

// Copies templates for every item, including completed ones that gained a
// template after they were completed.
function CopyTemplatesForm({
  order,
  writable,
  onDone,
}: {
  order: WorkOrder;
  writable: boolean;
  onDone: () => void;
}) {
  const { backend } = useWorkspace();
  const copy = async () => {
    await backend!.workOrder({
      action: "copyTemplates",
      uuid: order.uuid,
      version: order.version,
    });
    onDone();
  };
  return (
    <AsyncForm
      submitLabel="Add missing job card templates"
      disabled={!writable}
      onSubmit={copy}
    >
      <p>
        For an existing order, append missing template copies. Existing copies
        and recorded work are preserved.
      </p>
    </AsyncForm>
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
  const upload = async () => {
    if (!file) throw new Error("Choose a maintenance record file.");
    validateWorkOrderFile(file.name, file.type, file.size);
    await backend!.attachWorkOrderFile(order.uuid, file);
    setFile(undefined);
    setFileKey(fileKey + 1);
  };
  return (
    <section>
      <h3>Maintenance-record attachments</h3>
      <AttachmentList files={files} writable={writable} />
      {writable && (
        <UploadAttachment
          fileKey={fileKey}
          onFile={setFile}
          onUpload={upload}
        />
      )}
    </section>
  );
}

// A new key clears the file input after an upload.
function UploadAttachment({
  fileKey,
  onFile,
  onUpload,
}: {
  fileKey: number;
  onFile: (file: File | undefined) => void;
  onUpload: () => Promise<void>;
}) {
  return (
    <AsyncForm submitLabel="Upload attachment" onSubmit={onUpload}>
      <Field
        label="Maintenance record file"
        hint="PDF, JPEG or PNG, up to 7 MB"
      >
        <input
          key={fileKey}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={(e) => onFile(e.target.files?.[0])}
        />
      </Field>
    </AsyncForm>
  );
}

function AttachmentList({
  files,
  writable,
}: {
  files: NonNullable<Snapshot["workOrderAttachments"]>;
  writable: boolean;
}) {
  const { backend } = useWorkspace();
  return (
    <>
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
    </>
  );
}
