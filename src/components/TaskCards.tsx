/**
 * Responsibility: Job cards: the job cards screen, the cards on work items and
 *   work orders, and editing, signing and evidence files for one card.
 * Layer: UI. React components; job card rules live in src/domain.
 * Dependencies: react, react-dom, zod (ZodError), src/data (store,
 *   historyPages),
 *   src/domain (model, ata, management, programs, shelfLife, signTaskCard,
 *   taskCardValidation, taskCardZone, taskCards, workOrderCards, workOrders,
 *   listSearch), ./PartsRequests, ./WorkOrderRevisions, ./LogbookWording,
 *   ./TaskCsvImport, ./Manuals, ./NumberInput, ./design, ./FileLink,
 *   ./ShopList, ./ui, @phosphor-icons/react.
 *
 * A template holds instructions only: results, parts and signoffs go on the
 * job card a work order copies from it.
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
import { taskCardMatches } from "../domain/listSearch";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  Toolbar,
} from "./design";
import { NamedFileLink } from "./FileLink";
import { ShopSelect, ShopTableCard } from "./ShopList";
import {
  Airplane,
  Funnel,
  Plus,
  SortAscending,
  WifiSlash,
} from "@phosphor-icons/react";
import type { WorkOrder, WorkTask } from "../domain/workOrders";
import { TaskCsvImportButton } from "./TaskCsvImport";
import { ManualReferenceFields } from "./Manuals";
import { useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { useWorkspace, type Workspace } from "../data/store";
import {
  HistoryRecordsContext,
  useHistoryRecords,
  useRecordsSnapshot,
  useWorkOrderHistory,
  withHistory,
  workOrderRows,
  type LoadedWorkOrder,
} from "../data/historyPages";
import { can, type Snapshot } from "../domain/model";
import { ATA_GROUPS, ataLabel } from "../domain/ata";
import { isOpenWorkOrder, validateWorkOrderFile } from "../domain/workOrders";
import {
  CARD_NUMBER_MAX_LENGTH,
  TASK_TEXT_MAX_LENGTH,
  applyTaskLink,
  canUnlinkTaskCard,
  evidenceCategories,
  evidenceRemovable,
  isResultTextField,
  isTaskClosed,
  isTaskTemplate,
  linkableTaskCards,
  linkedTaskCards,
  signoffRefusals,
  taskCardDefaults,
  taskCardFieldsSchema,
  taskCardStatuses,
  taskLinkLocked,
  taskLinksWritable,
  taskStatusChoices,
  taskWritable,
  type TaskCard,
  type TaskCardFields,
  type TaskLink,
  type TaskLinkField,
  type TaskPart,
} from "../domain/taskCards";
import {
  AsyncForm,
  DeleteFileButton,
  Field,
  Modal,
  errorText,
  value,
} from "./ui";
import { NumberInput } from "./NumberInput";

// A longer description shows its first 157 characters and an ellipsis.
// Before the workspace loads there is no user to judge a signoff for.
const WORKSPACE_LOADING = "Loading the workspace…";
const OLDER_REPORT_OFFLINE = "Older problem report: reconnect to see which one";
const REPORT_UNAVAILABLE = "Problem report not available";
const PREVIEW_MAX_LENGTH = 160;
const PREVIEW_KEPT_LENGTH = 157;
const PART_TEXT_FIELDS = [
  ["Part number", "partNumber"],
  ["Description", "description"],
  ["Serial / lot", "serialLot"],
  ["Removed component details", "removedComponent"],
  ["Installed component details", "installedComponent"],
] as const;

/** The card to open, with its work order to load it by when it is older
 * than the workspace keeps; or a new card's defaults. */
type Selection = {
  uuid?: string;
  workOrderUuid?: string;
  /** Just saved: the workspace may not hold it yet. */
  saved?: boolean;
  defaults?: TaskCardFields;
};
type CardOrder = "zone" | "number";
type SignKind = "technician" | "inspection";
type Choice = { uuid: string; name: string };
type Filters = { aircraft: string; status: string; search: string };
type FilterState = Filters & {
  setAircraft: (uuid: string) => void;
  setStatus: (status: string) => void;
  setSearch: (search: string) => void;
};
type Removal = ReturnType<typeof useCardRemoval>;
type LinkedView = {
  s: Snapshot;
  link: TaskLink;
  aircraftUuid: string;
  cards: TaskCard[];
  writable: boolean;
  removal: Removal;
  onSelect: (selection: Selection) => void;
};
type EditorProps = {
  initial?: TaskCard;
  defaults?: TaskCardFields;
  onSaved: (uuid: string) => void;
  onClose: () => void;
};
type Editor = ReturnType<typeof useTaskCardEditor>;
type PartProps = { e: Editor; part: TaskPart; index: number };

/**
 * The Job cards screen: every job card and template the user can see, with
 * filters, inline status and signoffs, and the card editor.
 *
 * @returns The screen. Creating, editing, signing and uploading need a
 *   connection; offline it lists the cached cards.
 */
export function TaskCards() {
  const { snapshot: state, online, connected } = useWorkspace();
  const s = state!;
  const [selected, setSelected] = useState<Selection>();
  const filters = useCardFilters();
  const [orderBy, setOrderBy] = useState<CardOrder>("zone");
  const rows = filterCards(s, filters, orderBy);
  const live = online && connected;
  return (
    <>
      <JobCardsTitle s={s} live={live} onCreate={() => setSelected({})} />
      <Toolbar className="shop-toolbar">
        <SearchField
          label="Search job cards"
          placeholder="Card, title, aircraft or work order"
          value={filters.search}
          onChange={filters.setSearch}
        />
        <CardFilters s={s} filters={filters} />
        <ShopSelect
          label="Order by"
          icon={SortAscending}
          value={orderBy}
          onChange={(v) => setOrderBy(v as CardOrder)}
        >
          <option value="zone">Order by zone</option>
          <option value="number">Order by card number</option>
        </ShopSelect>
      </Toolbar>
      {!live && (
        <NoticeBar tone="warn" icon={WifiSlash}>
          Cached job cards are available. Reconnect to edit, sign or upload
          evidence.
        </NoticeBar>
      )}
      <CardRows
        s={s}
        rows={rows}
        anyCards={!!s.taskCards?.length}
        onSelect={setSelected}
      />
      <SelectionDialog selected={selected} onSelect={setSelected} />
    </>
  );
}

/**
 * The job cards on one work item of a work order, as a collapsible list with
 * inline status and signoffs.
 *
 * @param props.workOrderUuid - The work order.
 * @param props.item - The work item; a card belongs to it through its linked
 *   inspection, service requirement or discrepancy.
 * @returns The list, ordered by zone unless the user picks card number.
 */
export function WorkItemJobCards(props: {
  workOrderUuid: string;
  item: WorkTask;
}) {
  const s = useRecordsSnapshot();
  const [selected, setSelected] = useState<Selection>();
  const [orderBy, setOrderBy] = useState<CardOrder>("zone");
  const { workOrderUuid, item } = props;
  const cards = (s?.taskCards ?? [])
    .filter((card) => card.workOrderUuid === workOrderUuid)
    .filter((card) => taskCardMatchesWorkItem(card, item))
    .sort(cardOrder(orderBy));
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
            <WorkItemCard key={card.uuid} card={card} onSelect={setSelected} />
          ))}
        </ul>
      ) : (
        <p className="muted">No job cards linked to this item.</p>
      )}
      <SelectionDialog selected={selected} onSelect={setSelected} />
    </details>
  );
}

/**
 * A button that opens the job cards linked to a work order, or the job card
 * templates linked to an inspection, service requirement or discrepancy, to
 * create, add and (for templates) remove links.
 *
 * @param props.aircraftUuid - The aircraft whose cards are listed.
 * @param props.link - The linked record. A work order lists its own job cards;
 *   any other record lists the linked cards that are not work-order copies.
 * @returns Nothing until the snapshot loads. Changes need a connection,
 *   maintenance access and, for a work order, that it is still open. Removing
 *   unlinks the selected cards one at a time and stops at the first refusal,
 *   leaving the rest selected.
 */
export function LinkedTaskCards(props: {
  aircraftUuid: string;
  link: TaskLink;
}) {
  const { online, connected } = useWorkspace();
  const s = useRecordsSnapshot();
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<Selection>();
  const [orderBy, setOrderBy] = useState<CardOrder>("zone");
  const removal = useCardRemoval();
  if (!s) return null;
  const { aircraftUuid, link } = props;
  const cards = linkedTaskCards(s, aircraftUuid, link).sort(cardOrder(orderBy));
  const writable =
    online && connected && taskLinksWritable(s, aircraftUuid, link);
  const view = { ...props, s, cards, writable, removal };
  return (
    <>
      <button
        type="button"
        className="button small"
        onClick={() => setOpen(true)}
      >
        {props.link.kind === "workOrder" ? "Job cards" : "Job card templates"} (
        {cards.length})
      </button>
      {open && (
        <LinkedCardsModal
          view={{ ...view, onSelect: setSelected }}
          order={{ orderBy, setOrderBy }}
          onClose={() => setOpen(false)}
        />
      )}
      <SelectionDialog selected={selected} onSelect={setSelected} />
    </>
  );
}

/**
 * A card's number and title as a button that opens the card in the job card
 * dialog, for cards listed outside the job card screens, such as archived
 * ones.
 *
 * @param props.card - The job card.
 * @returns The button, and the dialog while it is open.
 */
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
          selection={{ uuid: card.uuid, workOrderUuid: card.workOrderUuid }}
          onSelect={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function JobCardsTitle(props: {
  s: Snapshot;
  live: boolean;
  onCreate: () => void;
}) {
  const { s } = props;
  return (
    <PageHeader
      eyebrow="MAINTENANCE"
      title="Job"
      accent="cards"
      description="Instructions, notes, work results, parts and signoffs for individual maintenance tasks."
      actions={
        <>
          <TaskCsvImportButton />
          <button
            className="button primary"
            disabled={
              !props.live ||
              !s.aircraft.some((a) => can(s, a.uuid, "maintenance"))
            }
            onClick={props.onCreate}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            New job card
          </button>
        </>
      }
    />
  );
}

function useCardFilters(): FilterState {
  const [aircraft, setAircraft] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  return { aircraft, setAircraft, status, setStatus, search, setSearch };
}

function CardFilters({ s, filters: f }: { s: Snapshot; filters: FilterState }) {
  return (
    <>
      <ShopSelect
        label="Aircraft"
        icon={Airplane}
        value={f.aircraft}
        onChange={f.setAircraft}
      >
        <option value="">All aircraft</option>
        {s.aircraft.map((a) => (
          <option key={a.uuid} value={a.uuid}>
            {a.registration}
          </option>
        ))}
      </ShopSelect>
      <ShopSelect
        label="Task status filter"
        icon={Funnel}
        value={f.status}
        onChange={f.setStatus}
      >
        <option value="">All statuses</option>
        <option value="template">Reusable templates</option>
        {taskCardStatuses.map((v) => (
          <option key={v} value={v}>
            {label(v)}
          </option>
        ))}
      </ShopSelect>
    </>
  );
}

function CardRows({
  anyCards,
  ...props
}: {
  s: Snapshot;
  rows: TaskCard[];
  anyCards: boolean;
  onSelect: (selection: Selection) => void;
}) {
  if (!props.rows.length)
    // Without rows the table would still scroll sideways at narrow widths
    // with nothing focusable in it, so show only the empty state.
    return anyCards ? (
      <EmptyState title="No matching job cards">
        Try another search, aircraft or status.
      </EmptyState>
    ) : (
      <EmptyState title="No job cards">
        Create a card here or add one from an inspection, service requirement or
        discrepancy.
      </EmptyState>
    );
  return (
    <ShopTableCard label="Job cards" className="shop-jobs" stack>
      <table className="shop-table">
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
          {props.rows.map((t) => (
            <CardRow key={t.uuid} {...props} card={t} />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

function CardRow(props: {
  s: Snapshot;
  card: TaskCard;
  onSelect: (selection: Selection) => void;
}) {
  const { s, card: t } = props;
  return (
    <tr>
      <td className="shop-wide" data-label="Task status">
        <JobCardStatus card={t} />
      </td>
      <td className="shop-wide">
        <button
          type="button"
          className="shop-title-button"
          aria-label={`Details for ${t.cardNumber}`}
          onClick={() =>
            props.onSelect({ uuid: t.uuid, workOrderUuid: t.workOrderUuid })
          }
        >
          <strong>{t.cardNumber}</strong> · {t.title}
        </button>
        <CardPreview card={t} />
      </td>
      <td data-label="Aircraft / work order">
        {s.aircraft.find((a) => a.uuid === t.aircraftUuid)?.registration}
        <small>
          {s.workOrders?.find((w) => w.uuid === t.workOrderUuid)?.number ??
            "Unassigned"}
        </small>
      </td>
      <td data-label="ATA chapter">{ataLabel(t.ataChapter)}</td>
      <td className="shop-wide" data-label="Signoffs">
        <JobCardSignoffs card={t} />
      </td>
    </tr>
  );
}

function WorkItemCard(props: {
  card: TaskCard;
  onSelect: (selection: Selection) => void;
}) {
  const { card } = props;
  return (
    <li>
      <span className="job-card-summary-status">
        <JobCardStatus card={card} />
      </span>
      <div className="job-card-summary-content">
        <button
          type="button"
          className="text-button"
          onClick={() =>
            props.onSelect({
              uuid: card.uuid,
              workOrderUuid: card.workOrderUuid,
            })
          }
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
  );
}

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

function CardPreview({ card }: { card: TaskCard }) {
  const description = card.description.replace(/\s+/g, " ").trim();
  return (
    <small className="block muted">
      <strong>Zone: {cardZone(card) || "Unspecified"}</strong>
      {description && (
        <span className="block">
          {description.length > PREVIEW_MAX_LENGTH
            ? `${description.slice(0, PREVIEW_KEPT_LENGTH)}…`
            : description}
        </span>
      )}
    </small>
  );
}

function JobCardStatus({ card }: { card: TaskCard }) {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { backend } = workspace;
  const writable = summaryWritable(workspace, card);
  const statuses = taskStatusChoices(card);
  const choose = async (status: string) => {
    if (!backend || !writable || status === card.status) return;
    setBusy(true);
    await withCardError(setError, () =>
      backend.taskCard(statusCommand(card, status)),
    );
    setBusy(false);
  };
  return (
    <>
      <select
        className="job-card-status-select"
        aria-label={`Task status for ${card.cardNumber}`}
        aria-busy={busy}
        title={label(card.status)}
        value={card.status}
        disabled={!writable || busy}
        onChange={(event) => choose(event.target.value)}
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
  const workspace = useWorkspace();
  const [busy, setBusy] = useState<SignKind>();
  const [error, setError] = useState("");
  const { backend } = workspace;
  const writable = summaryWritable(workspace, card);
  async function sign(kind: SignKind) {
    if (!backend || !writable || busy) return;
    setBusy(kind);
    await withCardError(setError, () =>
      signTaskCard(card, kind, (command) => backend.taskCard(command)),
    );
    setBusy(undefined);
  }
  return (
    <div
      className="job-card-summary-signoffs"
      aria-label={`Signoffs for ${card.cardNumber}`}
    >
      {isTaskTemplate(card) ? (
        <small className="muted">Sign on the work-order copy.</small>
      ) : (
        <SummarySignoffButtons
          card={card}
          snapshot={workspace.snapshot}
          state={{ busy, writable, error }}
          onSign={(kind) => void sign(kind)}
        />
      )}
    </div>
  );
}

function SummarySignoffButtons(props: {
  card: TaskCard;
  snapshot: Snapshot | null;
  state: { busy?: SignKind; writable: boolean; error: string };
  onSign: (kind: SignKind) => void;
}) {
  const { card, snapshot } = props;
  const { busy, error } = props.state;
  const refused = snapshot
    ? signoffRefusals(card, snapshot.user, localDate())
    : { technician: WORKSPACE_LOADING, inspection: WORKSPACE_LOADING };
  const blocked = !props.state.writable || !!busy;
  const { technicianSignoff: technician, inspectionSignoff: inspection } = card;
  return (
    <>
      <SignButton
        signer="Technician"
        state={{ signing: busy === "technician", signed: !!technician }}
        disabled={blocked || !!refused.technician}
        title={signoffTitle(technician, refused.technician, "technician")}
        onClick={() => props.onSign("technician")}
      />
      <SignButton
        signer="Inspection"
        state={{ signing: busy === "inspection", signed: !!inspection }}
        disabled={blocked || !!refused.inspection}
        title={signoffTitle(inspection, refused.inspection, "inspection")}
        onClick={() => props.onSign("inspection")}
      />
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}

function SignButton(props: {
  signer: string;
  state: { signing: boolean; signed: boolean };
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  const { signing, signed } = props.state;
  const text = signing
    ? "Signing…"
    : `${props.signer} ${signed ? "signed" : "signoff"}`;
  return (
    <button
      type="button"
      className="button small"
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.title}
    >
      {text}
    </button>
  );
}

function useCardRemoval() {
  const [removing, setRemoving] = useState(false);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState("");
  // Starting and cancelling both begin from an empty selection.
  const reset = (on: boolean) => {
    setRemoving(on);
    setRemoveIds([]);
    setRemoveError("");
  };
  return {
    removing,
    setRemoving,
    removeIds,
    setRemoveIds,
    removeBusy,
    setRemoveBusy,
    removeError,
    setRemoveError,
    reset,
  };
}

function LinkedCardsModal(props: {
  view: LinkedView;
  order: { orderBy: CardOrder; setOrderBy: (order: CardOrder) => void };
  onClose: () => void;
}) {
  const { view } = props;
  const { orderBy, setOrderBy } = props.order;
  const templates = view.link.kind !== "workOrder";
  const available = linkableTaskCards(
    view.s,
    view.aircraftUuid,
    view.link,
  ).sort(cardOrder(orderBy));
  return createPortal(
    <div onSubmit={(e) => e.stopPropagation()}>
      <Modal
        title={templates ? "Linked job card templates" : "Work-order job cards"}
        onClose={props.onClose}
      >
        {templates && (
          <p>
            These are reusable instructions. Adding this source to a work order
            creates independent job cards for that order.
          </p>
        )}
        <CardOrderSelect value={orderBy} onChange={setOrderBy} />
        {templates && <RemoveControls view={view} />}
        <ul className="job-card-summary-list">
          {view.cards.map((t) => (
            <LinkedCardItem key={t.uuid} view={view} card={t} />
          ))}
        </ul>
        {!view.cards.length && <p>No job cards linked yet.</p>}
        <LinkedCardActions view={view} available={available} />
      </Modal>
    </div>,
    document.body,
  );
}

function RemoveControls({ view }: { view: LinkedView }) {
  const { removal: r } = view;
  const removable = view.cards.filter((card) =>
    canUnlinkTaskCard(view.s, card, view.link),
  );
  if (!r.removing)
    return (
      <div className="job-card-remove-controls">
        <button
          type="button"
          className="button"
          disabled={!view.writable || !removable.length}
          onClick={() => r.reset(true)}
        >
          Remove job cards
        </button>
      </div>
    );
  return (
    <div className="job-card-remove-controls">
      <p>
        Select cards to remove from this linked item. Cards remain available to
        link again; existing work-order copies are unchanged.
      </p>
      <RemoveActions view={view} removable={removable} />
      {r.removeError && (
        <p className="error" role="alert">
          {r.removeError}
        </p>
      )}
    </div>
  );
}

function RemoveActions(props: { view: LinkedView; removable: TaskCard[] }) {
  const { view } = props;
  const { removal: r, writable } = view;
  const { backend } = useWorkspace();
  return (
    <div className="job-card-remove-actions">
      <button
        type="button"
        className="button small"
        disabled={r.removeBusy || !writable}
        onClick={() => r.setRemoveIds(props.removable.map((card) => card.uuid))}
      >
        Select all removable
      </button>
      <button
        type="button"
        className="button primary"
        disabled={r.removeBusy || !writable || !r.removeIds.length}
        onClick={() => void removeSelected(view, backend)}
      >
        {r.removeBusy ? "Removing…" : `Remove selected (${r.removeIds.length})`}
      </button>
      <button
        type="button"
        className="button"
        disabled={r.removeBusy}
        onClick={() => r.reset(false)}
      >
        Cancel removal
      </button>
    </div>
  );
}

function LinkedCardItem({
  view,
  card: t,
}: {
  view: LinkedView;
  card: TaskCard;
}) {
  return (
    <li>
      <span className="job-card-summary-status">
        <JobCardStatus card={t} />
      </span>
      <div className="job-card-summary-content">
        {view.removal.removing && <RemoveChoice view={view} card={t} />}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            view.onSelect({ uuid: t.uuid, workOrderUuid: t.workOrderUuid })
          }
        >
          {t.cardNumber} · {t.title}
        </button>
        <CardPreview card={t} />
      </div>
      <JobCardSignoffs card={t} />
    </li>
  );
}

function RemoveChoice({ view, card: t }: { view: LinkedView; card: TaskCard }) {
  const { removal: r } = view;
  const removable = canUnlinkTaskCard(view.s, t, view.link);
  return (
    <label className="job-card-remove-choice">
      <input
        type="checkbox"
        aria-label={`Remove ${t.cardNumber} from linked item`}
        checked={r.removeIds.includes(t.uuid)}
        disabled={r.removeBusy || !view.writable || !removable}
        onChange={(event) =>
          r.setRemoveIds((current) =>
            event.target.checked
              ? [...current, t.uuid]
              : current.filter((id) => id !== t.uuid),
          )
        }
      />
      {removable ? "Select to remove" : "Cannot remove recorded or closed work"}
    </label>
  );
}

function LinkedCardActions(props: { view: LinkedView; available: TaskCard[] }) {
  const { s, link, writable, onSelect } = props.view;
  const orders = link.kind === "workOrder";
  const defaults = () =>
    applyTaskLink(s, taskCardDefaults(props.view.aircraftUuid), link);
  return (
    <>
      <button
        type="button"
        className="button primary"
        disabled={!writable}
        onClick={() => onSelect({ defaults: defaults() })}
      >
        {orders ? "Create linked job card" : "Create job card template"}
      </button>
      {!!props.available.length && (
        <AddExistingCard view={props.view} available={props.available} />
      )}
    </>
  );
}

function AddExistingCard(props: { view: LinkedView; available: TaskCard[] }) {
  const { link, writable } = props.view;
  const { backend } = useWorkspace();
  return (
    <AsyncForm
      submitLabel={
        link.kind === "workOrder"
          ? "Add existing job card"
          : "Add existing job card template"
      }
      disabled={!writable}
      onSubmit={async (data) => {
        const t = props.available.find((t) => t.uuid === value(data, "task"))!;
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
          {props.available.map((t) => (
            <option key={t.uuid} value={t.uuid}>
              {t.cardNumber} · {t.title}
            </option>
          ))}
        </select>
      </Field>
    </AsyncForm>
  );
}

// The job card dialog for the card or new-card defaults being edited, if any.
function SelectionDialog({
  selected,
  onSelect,
}: {
  selected?: Selection;
  onSelect: (selection?: Selection) => void;
}) {
  if (!selected) return null;
  return (
    <TaskCardDialog
      selection={selected}
      onSelect={onSelect}
      onClose={() => onSelect(undefined)}
    />
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
  const opened = useSelectedCard(selection);
  const { card, s } = opened;
  const missing = !!selection.uuid && !card;
  return createPortal(
    <div onSubmit={(e) => e.stopPropagation()}>
      <HistoryRecordsContext.Provider value={s}>
        <Modal
          className="job-card-modal"
          title={
            card
              ? `Job card ${card.cardNumber}`
              : missing
                ? "Job card"
                : "New job card"
          }
          onClose={onClose}
        >
          {missing ? (
            <MissingCard loaded={opened.loaded} saved={!!selection.saved} />
          ) : (
            <TaskCardEditor
              key={card ? `${card.uuid}:${card.version}` : "new"}
              initial={card}
              defaults={selection.defaults}
              onSaved={(uuid) =>
                onSelect({
                  uuid,
                  workOrderUuid: card?.workOrderUuid,
                  saved: true,
                })
              }
              onClose={onClose}
            />
          )}
        </Modal>
      </HistoryRecordsContext.Provider>
    </div>,
    document.body,
  );
}

// A card the screen does not hold belongs to a work order older than the
// workspace keeps: it loads with that order, so a uuid never opens a blank
// new card in its place (docs/history-paging.md, TaskCards.tsx).
function useSelectedCard(selection: Selection) {
  const records = useRecordsSnapshot();
  const held = selection.uuid ? findCard(records, selection.uuid) : undefined;
  const loaded = useWorkOrderHistory(
    selection.uuid && !held ? selection.workOrderUuid : undefined,
  );
  const s =
    records && loaded.history
      ? withHistory(records, workOrderRows(loaded.history))
      : records;
  const card =
    held ?? (selection.uuid ? findCard(s, selection.uuid) : undefined);
  return { card, s, loaded };
}

function findCard(s: Snapshot | null, uuid: string) {
  return [...(s?.taskCards ?? []), ...(s?.archivedTaskCards ?? [])].find(
    (t) => t.uuid === uuid,
  );
}

// A card just saved shows once the workspace receives it.
function MissingCard({
  loaded,
  saved,
}: {
  loaded: LoadedWorkOrder;
  saved: boolean;
}) {
  if (loaded.loading || (saved && !loaded.error))
    return <p role="status">Loading the job card…</p>;
  if (loaded.offline && !loaded.error)
    return (
      <p className="notice">
        This job card is older than the records kept on this device. Reconnect
        to open it.
      </p>
    );
  return (
    <p role="alert" className="error">
      {loaded.error || "Job card not found."}
    </p>
  );
}

function TaskCardEditor(props: EditorProps) {
  const e = useTaskCardEditor(props);
  const { initial } = e;
  return (
    <>
      <EditorNotices e={e} />
      <CardForm e={e} onSaved={props.onSaved} onClose={props.onClose} />
      {initial && !e.template && <EditorSignoffs e={e} initial={initial} />}
      {initial ? (
        <Evidence
          card={initial}
          writable={e.writable && !e.dirty && !e.busy && !e.template}
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

function useTaskCardEditor({ initial, defaults }: EditorProps) {
  const { backend, online, connected } = useWorkspace();
  const s = useRecordsSnapshot()!;
  const [uuid] = useState(initial?.uuid ?? crypto.randomUUID());
  const [f, setFields] = useState(initialFields(s, initial, defaults));
  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = online && connected;
  return {
    s,
    backend,
    live,
    initial,
    defaults,
    uuid,
    f,
    setFields,
    change: <K extends keyof TaskCardFields>(key: K, v: TaskCardFields[K]) =>
      setFields({ ...f, [key]: v }),
    revising,
    setRevising,
    busy,
    setBusy,
    error,
    setError,
    template: isTaskTemplate(f),
    writable:
      live &&
      can(s, f.aircraftUuid, "maintenance") &&
      (!initial || taskWritable(s, initial)),
    dirty:
      !initial ||
      JSON.stringify(taskCardFieldsSchema.parse(initial)) !== JSON.stringify(f),
  };
}

function EditorNotices({ e }: { e: Editor }) {
  const { s, initial } = e;
  const archived =
    !!initial &&
    !!s.archivedTaskCards?.some((card) => card.uuid === initial.uuid);
  const order = initial?.workOrderUuid
    ? s.workOrders?.find((o) => o.uuid === initial.workOrderUuid)
    : undefined;
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
        <RevisionAction e={e} order={order} />
      )}
      {e.revising && order && <RevisionDialog e={e} order={order} />}
      <TemplateNotes e={e} />
    </>
  );
}

function RevisionAction({ e, order }: { e: Editor; order?: WorkOrder }) {
  const canRevise =
    !!order &&
    !isOpenWorkOrder(order) &&
    e.live &&
    can(e.s, e.f.aircraftUuid, "maintenance");
  return (
    <div className="job-card-revision-action">
      <button
        type="button"
        className="button"
        disabled={!canRevise}
        onClick={() => e.setRevising(true)}
      >
        Revise
      </button>
      <p className="muted">
        {order && isOpenWorkOrder(order)
          ? "Written-record revisions are available after the work order is closed."
          : "Correct the work order’s written record with a reason. The original job card and signatures are preserved."}
      </p>
    </div>
  );
}

function RevisionDialog({ e, order }: { e: Editor; order: WorkOrder }) {
  return createPortal(
    <Modal
      title={`Revise written record · ${e.initial?.cardNumber}`}
      onClose={() => e.setRevising(false)}
      wide
    >
      <p>
        Work order {order.number}. This revises the work order’s written record,
        including log book wording.
      </p>
      <WorkOrderRevisions
        key={order.version}
        order={order}
        initiallyEditing
        onDone={() => e.setRevising(false)}
      />
    </Modal>,
    document.body,
  );
}

function TemplateNotes({ e }: { e: Editor }) {
  const source = e.initial?.sourceTaskCardUuid;
  return (
    <>
      {e.template && (
        <details className="job-card-help">
          <summary>About this reusable template</summary>
          <p>
            Reusable job card template. Add its inspection, service requirement
            or discrepancy to a work order to create a job card for recording
            results and signoffs.
          </p>
        </details>
      )}
      {source && (
        <p>
          Work-order copy of template{" "}
          {e.s.taskCards?.find((t) => t.uuid === source)?.cardNumber ?? source},
          version {e.initial?.sourceTaskCardVersion}. Template edits do not
          change this copy.
        </p>
      )}
    </>
  );
}

function CardWarnings(props: {
  title: string;
  role: "alert" | "status";
  warnings: string[];
}) {
  if (!props.warnings.length) return null;
  return (
    <div className="notice" role={props.role}>
      <strong>{props.title}</strong>
      <ul>
        {props.warnings.map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </div>
  );
}

function CardForm(props: {
  e: Editor;
  onSaved: (uuid: string) => void;
  onClose: () => void;
}) {
  const { e } = props;
  const saving = e.writable
    ? taskCardSaveWarnings(e.s, e.uuid, e.f, e.initial)
    : [];
  const signing =
    !e.template && e.writable
      ? taskCardSigningWarnings(e.f, e.dirty, e.initial)
      : [];
  return (
    <>
      <CardWarnings title="Before saving:" role="alert" warnings={saving} />
      <CardWarnings title="Before signing:" role="status" warnings={signing} />
      <AsyncForm
        submitLabel={e.template ? "Save job card template" : "Save job card"}
        onClose={props.onClose}
        disabled={!e.writable || e.busy}
        onSubmit={() => saveCard(e, saving, props.onSaved)}
      >
        <CardFields e={e} />
      </AsyncForm>
    </>
  );
}

function CardFields({ e }: { e: Editor }) {
  return (
    <>
      <HeaderFields e={e} />
      <div className="job-card-workspace">
        <InstructionsPanel e={e} />
        <LinksPanel e={e} />
      </div>
      <PartsUsed e={e} />
      <details open>
        <summary>Notes / remarks</summary>
        <TextField
          e={e}
          label="Notes / remarks"
          field="notesRemarks"
          multiline
        />
      </details>
      {!!e.f.steps.length && <StepDetails e={e} />}
      <ExecutionPanel e={e} />
      <VerificationPanel e={e} />
    </>
  );
}

function HeaderFields({ e }: { e: Editor }) {
  return (
    <div className="job-card-header-fields">
      <AircraftField e={e} />
      <TextField
        e={e}
        label="Card number (automatic if blank)"
        field="cardNumber"
      />
      <TextField e={e} label="Title" field="title" />
      <AtaField e={e} />
      <StatusField e={e} />
      <LinkSelect
        e={e}
        label="Work order"
        field="workOrderUuid"
        choices={workOrderChoices(e.s, e.f)}
        disabled={!!e.initial?.workOrderUuid || e.template}
      />
    </div>
  );
}

function AircraftField({ e }: { e: Editor }) {
  const { s, f, initial } = e;
  return (
    <Field label="Aircraft">
      <select
        value={f.aircraftUuid}
        disabled={!!initial || !!e.defaults}
        onChange={(event) =>
          e.setFields({
            ...taskCardDefaults(event.target.value),
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
  );
}

function AtaField({ e }: { e: Editor }) {
  return (
    <Field label="ATA chapter">
      <select
        value={e.f.ataChapter ?? ""}
        onChange={(event) =>
          e.change(
            "ataChapter",
            (event.target.value as TaskCardFields["ataChapter"]) || undefined,
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
  );
}

function StatusField({ e }: { e: Editor }) {
  return (
    <Field label="Task status">
      <select
        value={e.f.status}
        disabled={!e.initial}
        onChange={(event) =>
          e.change("status", event.target.value as TaskCardFields["status"])
        }
      >
        {taskStatusChoices(e.f).map((v) => (
          <option key={v} value={v}>
            {label(v)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TextField(props: {
  e: Editor;
  label: string;
  field: keyof TaskCardFields;
  multiline?: boolean;
}) {
  const { e, field } = props;
  const shared = {
    value: String(e.f[field] ?? ""),
    disabled: e.template && isResultTextField(field),
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      e.setFields({ ...e.f, [field]: event.target.value }),
  };
  const limit =
    field === "cardNumber" ? CARD_NUMBER_MAX_LENGTH : TASK_TEXT_MAX_LENGTH;
  return (
    <Field
      label={props.label}
      hint={
        field === "actualWork"
          ? "Used for the log book entry. Optional — not required to save or sign."
          : undefined
      }
    >
      {props.multiline ? (
        <textarea {...shared} maxLength={TASK_TEXT_MAX_LENGTH} />
      ) : (
        <input {...shared} maxLength={limit} />
      )}
    </Field>
  );
}

function LinkSelect(props: {
  e: Editor;
  label: string;
  field: TaskLinkField;
  choices: Choice[];
  disabled?: boolean;
}) {
  const { e, field, choices } = props;
  const current = e.f[field];
  const choose = (v: string) =>
    field === "componentUuid"
      ? e.setFields({ ...e.f, componentUuid: v, requirementUuid: "" })
      : e.change(field, v);
  return (
    <Field label={props.label}>
      <select
        value={current}
        disabled={props.disabled || taskLinkLocked(e.initial, field)}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">None</option>
        {current && !choices.some((i) => i.uuid === current) && (
          <option value={current}>Previously linked record</option>
        )}
        {choices.map((i) => (
          <option key={i.uuid} value={i.uuid}>
            {i.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function InstructionsPanel({ e }: { e: Editor }) {
  const { f } = e;
  return (
    <details open className="job-card-panel job-card-instructions">
      <summary>Instructions and maintenance data</summary>
      <TextField e={e} label="Description" field="description" multiline />
      <TextField e={e} label="Applicability" field="applicability" multiline />
      <LogbookWording
        included={f.includeInLogbook}
        phrase={f.logbookPhrase}
        onChange={(patch) =>
          e.setFields((current) => ({ ...current, ...patch }))
        }
      />
      {/* References are part of the job card itself; the checkbox above only
          controls log book inclusion. */}
      <TextField
        e={e}
        label="Maintenance-data reference"
        field="maintenanceReference"
      />
      <ManualReferenceFields
        initial={f.manualReference}
        onChange={(ref) => e.change("manualReference", ref)}
      />
      <div className="form-grid">
        <TextField e={e} label="Reference revision" field="referenceRevision" />
        <Field label="Reference date">
          <input
            type="date"
            value={f.referenceDate}
            onChange={(event) => e.change("referenceDate", event.target.value)}
          />
        </Field>
      </div>
    </details>
  );
}

function LinksPanel({ e }: { e: Editor }) {
  const choices = linkChoices(e.s, e.f);
  const report = useLinkedReport(e.s, e.f.discrepancyUuid);
  if (report) choices.discrepancies.push(report);
  return (
    <details open className="job-card-panel job-card-links">
      <summary>Linked records</summary>
      <div className="job-card-linked-fields">
        <LinkSelect
          e={e}
          label="Inspection"
          field="inspectionUuid"
          choices={choices.inspections}
        />
        <LinkSelect
          e={e}
          label="Component"
          field="componentUuid"
          choices={choices.components}
        />
        <LinkSelect
          e={e}
          label="Component service requirement"
          field="requirementUuid"
          choices={choices.requirements}
        />
        <LinkSelect
          e={e}
          label="Originating discrepancy"
          field="discrepancyUuid"
          choices={choices.discrepancies}
        />
      </div>
    </details>
  );
}

function PartsUsed({ e }: { e: Editor }) {
  return (
    <details>
      <summary>Parts used and component changes</summary>
      <fieldset disabled={e.template}>
        {e.f.partsUsed.map((part, index) => (
          <PartEditor key={part.uuid} e={e} part={part} index={index} />
        ))}
        <button
          type="button"
          className="button"
          onClick={() => e.change("partsUsed", [...e.f.partsUsed, newPart()])}
        >
          Add part used
        </button>
      </fieldset>
    </details>
  );
}

function PartEditor({ e, part, index }: PartProps) {
  const n = index + 1;
  return (
    <div className="panel">
      <h3>Part {n}</h3>
      <Field label={`Part ${n} source`}>
        <select
          value={part.source ?? "non-stock"}
          onChange={(event) =>
            updatePart(e, part.uuid, {
              source: event.target.value as "stock" | "non-stock",
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
        <StockFields e={e} part={part} index={index} />
      )}
      <PartDetails e={e} part={part} index={index} />
      <button
        type="button"
        className="text-button"
        onClick={() =>
          e.change(
            "partsUsed",
            e.f.partsUsed.filter((x) => x.uuid !== part.uuid),
          )
        }
      >
        Remove part {n}
      </button>
    </div>
  );
}

function StockFields(props: PartProps) {
  const { stockItems, locations } = inventory(props.e.s, props.e.f);
  return (
    <>
      <LocationSelect {...props} locations={locations} />
      <StockSelect {...props} stockItems={stockItems} />
      {!locations.length && (
        <p className="muted">
          Selecting stock requires inventory access and a saved inventory
          location.
        </p>
      )}
      <p className="muted">
        This links the part to inventory. Record stock issues through Inventory
        → Move stock.
      </p>
    </>
  );
}

function LocationSelect(
  props: PartProps & { locations: ReturnType<typeof inventory>["locations"] },
) {
  const { part, locations } = props;
  return (
    <Field label={`Part ${props.index + 1} inventory location`}>
      <select
        required
        value={part.locationUuid ?? ""}
        onChange={(event) =>
          updatePart(props.e, part.uuid, {
            locationUuid: event.target.value,
            stockUuid: "",
          })
        }
      >
        <option value="">Select location</option>
        {part.locationUuid &&
          !locations.some((r) => r.uuid === part.locationUuid) && (
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
  );
}

function StockSelect(props: PartProps & { stockItems: Stock[] }) {
  const { part, stockItems } = props;
  const choose = (uuid: string) => {
    const stock = stockItems.find((r) => r.uuid === uuid);
    updatePart(props.e, part.uuid, {
      stockUuid: stock?.uuid ?? "",
      partNumber: stock?.partNumber ?? "",
      description: stock?.description ?? "",
    });
  };
  return (
    <Field label={`Part ${props.index + 1} stock item`}>
      <select
        required
        value={part.stockUuid ?? ""}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="">Select stock item</option>
        {part.stockUuid &&
          !stockItems.some((r) => r.uuid === part.stockUuid) && (
            <option value={part.stockUuid}>
              {part.partNumber} · Previously linked stock item
            </option>
          )}
        {stockItems
          .filter((stock) => stock.locationUuid === part.locationUuid)
          .map((stock) => (
            <StockOption
              key={stock.uuid}
              stock={stock}
              linked={part.stockUuid}
            />
          ))}
      </select>
    </Field>
  );
}

// Expired lots cannot be issued, so they cannot be chosen; a lot linked
// before it expired stays.
function StockOption({ stock, linked }: { stock: Stock; linked?: string }) {
  const expired = expiredForUse(stock.expirationDate);
  const status = expired
    ? `Expired ${stock.expirationDate}`
    : `Available: ${usableQuantity(stock)}`;
  return (
    <option value={stock.uuid} disabled={expired && stock.uuid !== linked}>
      {`${stock.partNumber} · ${stock.description} · ${status}`}
    </option>
  );
}

function PartDetails({ e, part, index }: PartProps) {
  return (
    <>
      {PART_TEXT_FIELDS.map(([name, key]) => (
        <Field key={key} label={`Part ${index + 1} ${name}`}>
          <input
            value={part[key]}
            readOnly={part.source === "stock" && key === "partNumber"}
            required={key === "partNumber"}
            maxLength={TASK_TEXT_MAX_LENGTH}
            onChange={(event) =>
              updatePart(e, part.uuid, { [key]: event.target.value })
            }
          />
        </Field>
      ))}
      <Field label={`Part ${index + 1} quantity`}>
        <NumberInput
          min="0.000001"
          step="any"
          value={part.quantity}
          onValue={(quantity) => updatePart(e, part.uuid, { quantity })}
        />
      </Field>
    </>
  );
}

function StepDetails({ e }: { e: Editor }) {
  const signoffs = e.initial?.stepSignoffs;
  return (
    <details>
      <summary>Previously recorded step details</summary>
      {e.f.steps.map((step, index) => (
        <div key={step.uuid}>
          <p>
            {index + 1}. {step.instruction}
          </p>
          {step.requiredResult && <p>Required result: {step.requiredResult}</p>}
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
          {signoffs?.[step.uuid] && (
            <p>Signed: {signatureText(signoffs[step.uuid])}</p>
          )}
        </div>
      ))}
    </details>
  );
}

function ExecutionPanel({ e }: { e: Editor }) {
  return (
    <details open>
      <summary>Execution</summary>
      <fieldset disabled={e.template}>
        <TextField
          e={e}
          label="Actual work performed"
          field="actualWork"
          multiline
        />
        <ExecutionFields e={e} />
      </fieldset>
    </details>
  );
}

function ExecutionFields({ e }: { e: Editor }) {
  return (
    <div className="form-grid">
      <Field
        label="Actual labor (hours)"
        hint="Optional — leave blank if no labor time is recorded."
      >
        <input
          type="number"
          min="0"
          step="any"
          value={e.f.actualLabor ?? ""}
          onChange={(event) =>
            e.change("actualLabor", nullableNumber(event.target.value))
          }
        />
      </Field>
      <Field
        label="Completion date"
        hint="Required for technician and inspection signoff — today or earlier. Completing without one is refused."
      >
        <input
          type="date"
          max={localDate()}
          value={e.f.completionDate}
          onChange={(event) => e.change("completionDate", event.target.value)}
        />
      </Field>
    </div>
  );
}

function VerificationPanel({ e }: { e: Editor }) {
  return (
    <details open>
      <summary>Verification</summary>
      <label className="block">
        <input
          type="checkbox"
          checked={e.f.inspectionSignoffRequired}
          onChange={(event) =>
            e.change("inspectionSignoffRequired", event.target.checked)
          }
        />{" "}
        Inspection signoff required
      </label>
    </details>
  );
}

function EditorSignoffs({ e, initial }: { e: Editor; initial: TaskCard }) {
  const blocked = !e.writable || e.busy || e.dirty;
  const refused = signoffRefusals(initial, e.s.user, localDate());
  return (
    <section>
      <h3>Signoffs</h3>
      <p>
        Save changes before signing. Signing records your account and the
        current time. Changes to card content or evidence clear existing
        signoffs.
      </p>
      {e.dirty && (
        <p className="notice">
          Save your changes before signing or uploading evidence.
        </p>
      )}
      <p>Technician: {signatureText(initial.technicianSignoff)}</p>
      <EditorSignButton
        e={e}
        kind="technician"
        refusal={refused.technician}
        disabled={blocked}
      />
      <p>Inspection: {signatureText(initial.inspectionSignoff)}</p>
      <EditorSignButton
        e={e}
        kind="inspection"
        refusal={refused.inspection}
        disabled={blocked}
      />
      {e.error && (
        <p className="error" role="alert">
          {e.error}
        </p>
      )}
    </section>
  );
}

// A signoff the server would refuse is disabled, with the refusal beside it.
function EditorSignButton(props: {
  e: Editor;
  kind: SignKind;
  refusal: string | undefined;
  disabled: boolean;
}) {
  const { e, kind, refusal } = props;
  const noteId = `${kind}-signoff-refusal-${e.initial?.uuid}`;
  return (
    <>
      <button
        type="button"
        className="button"
        disabled={props.disabled || !!refusal}
        aria-describedby={refusal ? noteId : undefined}
        onClick={() => void signCard(e, kind)}
      >
        {kind === "technician" ? "Technician signoff" : "Inspection signoff"}
      </button>
      {refusal && (
        <p className="muted" id={noteId}>
          {refusal}
        </p>
      )}
    </>
  );
}

function Evidence({ card, writable }: { card: TaskCard; writable: boolean }) {
  const { backend } = useWorkspace();
  const s = useRecordsSnapshot();
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
            <NamedFileLink
              file={{ kind: "taskEvidence", id: f.uuid }}
              name={f.name}
            />{" "}
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
        <EvidenceUpload
          card={card}
          file={file}
          onFile={setFile}
          writable={writable}
        />
      )}
    </section>
  );
}

function EvidenceUpload(props: {
  card: TaskCard;
  file?: File;
  onFile: (file?: File) => void;
  writable: boolean;
}) {
  const { backend } = useWorkspace();
  const { file } = props;
  return (
    <AsyncForm
      submitLabel="Upload evidence"
      disabled={!props.writable}
      onSubmit={(data) => uploadEvidence(backend!, props.card, file, data)}
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
      <Field label="Evidence file" hint="PDF, JPEG or PNG, up to 7 MiB">
        <input
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          onChange={(event) => props.onFile(event.target.files?.[0])}
        />
      </Field>
    </AsyncForm>
  );
}

const label = (s: string) => s.replaceAll("-", " ");
const nullableNumber = (s: string) => (s === "" ? null : Number(s));

function cardOrder(orderBy: CardOrder) {
  return orderBy === "zone" ? compareCardZones : compareCardNumbers;
}

// Cards without a zone sort after those with one, then by card number.
function compareCardZones(a: TaskCard, b: TaskCard) {
  const az = cardZone(a),
    bz = cardZone(b);
  if (az && bz)
    return (
      az.localeCompare(bz, undefined, { numeric: true, sensitivity: "base" }) ||
      compareCardNumbers(a, b)
    );
  if (az) return -1;
  if (bz) return 1;
  return compareCardNumbers(a, b);
}

function compareCardNumbers(a: TaskCard, b: TaskCard) {
  return a.cardNumber.localeCompare(b.cardNumber, undefined, { numeric: true });
}

function filterCards(s: Snapshot, filters: Filters, orderBy: CardOrder) {
  return (s.taskCards ?? [])
    .filter((card) => matchesFilters(s, card, filters))
    .sort(cardOrder(orderBy));
}

function matchesFilters(s: Snapshot, card: TaskCard, filters: Filters) {
  return (
    (!filters.aircraft || card.aircraftUuid === filters.aircraft) &&
    matchesStatus(card, filters.status) &&
    taskCardMatches(s, card, filters.search)
  );
}

// "template" picks the reusable templates; a status picks job cards only.
function matchesStatus(card: TaskCard, status: string) {
  if (!status) return true;
  if (status === "template") return isTaskTemplate(card);
  return !isTaskTemplate(card) && card.status === status;
}

function summaryWritable(
  w: Pick<Workspace, "snapshot" | "backend" | "online" | "connected">,
  card: TaskCard,
) {
  return (
    !!w.snapshot &&
    !!w.backend &&
    w.online &&
    w.connected &&
    taskWritable(w.snapshot, card)
  );
}

function statusCommand(card: TaskCard, status: string) {
  const fields = {
    ...taskCardFieldsSchema.parse(card),
    status: status as TaskCardFields["status"],
  };
  return {
    action: "save" as const,
    uuid: card.uuid,
    version: card.version,
    fields,
  };
}

function signedBy(sig: NonNullable<TaskCard["technicianSignoff"]>) {
  return `${sig.name} · ${new Date(sig.at).toLocaleString()}`;
}

function signatureText(sig: TaskCard["technicianSignoff"]) {
  return sig ? signedBy(sig) : "Not signed";
}

// Who signed, else why this user may not, else what the button does.
function signoffTitle(
  signature: TaskCard["technicianSignoff"],
  refusal: string | undefined,
  kind: SignKind,
) {
  if (signature) return signedBy(signature);
  return refusal ?? `Record ${kind} signoff`;
}

async function removeSelected(view: LinkedView, backend: Workspace["backend"]) {
  const { removal: r } = view;
  if (!backend || !view.writable || r.removeBusy) return;
  r.setRemoveBusy(true);
  r.setRemoveError("");
  try {
    for (const id of r.removeIds) await unlinkCard(view, backend, id);
    r.setRemoving(false);
  } catch (error) {
    r.setRemoveError(cardErrorText(error));
  } finally {
    r.setRemoveBusy(false);
  }
}

async function unlinkCard(
  { s, link, removal }: LinkedView,
  backend: NonNullable<Workspace["backend"]>,
  id: string,
) {
  const card = s.taskCards?.find((item) => item.uuid === id);
  if (!card || !canUnlinkTaskCard(s, card, link))
    throw new Error("A selected card changed. Review the remaining selection.");
  await backend.taskCard({
    action: "unlink",
    uuid: card.uuid,
    version: card.version,
    link,
  });
  removal.setRemoveIds((current) =>
    current.filter((selected) => selected !== id),
  );
}

function initialFields(
  s: Snapshot,
  initial?: TaskCard,
  defaults?: TaskCardFields,
): TaskCardFields {
  if (initial) return taskCardFieldsSchema.parse(initial);
  return (
    defaults ??
    taskCardDefaults(
      s.aircraft.find((a) => can(s, a.uuid, "maintenance"))?.uuid ?? "",
    )
  );
}

async function saveCard(
  e: Editor,
  warnings: string[],
  onSaved: (uuid: string) => void,
) {
  if (warnings.length) throw new Error(warnings.join("\n"));
  await e.backend!.taskCard({
    action: "save",
    uuid: e.uuid,
    version: e.initial?.version ?? 0,
    fields: e.f,
  });
  onSaved(e.uuid);
}

async function signCard(e: Editor, kind: SignKind) {
  const { initial } = e;
  if (!initial) return;
  e.setBusy(true);
  await withCardError(e.setError, () =>
    signTaskCard(initial, kind, (command) => e.backend!.taskCard(command)),
  );
  e.setBusy(false);
}

// Clears the error, runs the command and shows a refusal in its place.
async function withCardError(
  setError: (message: string) => void,
  command: () => Promise<unknown>,
) {
  setError("");
  try {
    await command();
  } catch (error) {
    setError(cardErrorText(error));
  }
}

function workOrderChoices(s: Snapshot, f: TaskCardFields): Choice[] {
  return (s.workOrders ?? [])
    .filter(
      (w) =>
        w.aircraftUuid === f.aircraftUuid &&
        (isOpenWorkOrder(w) || w.uuid === f.workOrderUuid),
    )
    .map((w) => ({ uuid: w.uuid, name: w.number }));
}

// Archived inspections, removed components and discrepancies no longer open
// stay listed only while the card still links them.
function linkChoices(s: Snapshot, f: TaskCardFields) {
  const records = s.management ?? [];
  return {
    inspections: s.inspections
      .filter(
        (i) =>
          i.aircraftUuid === f.aircraftUuid &&
          (!i.archived || i.uuid === f.inspectionUuid),
      )
      .map((i) => ({ uuid: i.uuid, name: `${i.reference}: ${i.description}` })),
    components: records
      .filter(
        (c) =>
          c.kind === "component" &&
          c.aircraftUuid === f.aircraftUuid &&
          (c.installed || c.uuid === f.componentUuid),
      )
      .map((c) => ({
        uuid: c.uuid,
        name: c.kind === "component" ? `${c.componentType} · ${c.serial}` : "",
      })),
    requirements: records
      .filter(
        (r) =>
          r.kind === "componentRequirement" &&
          r.componentUuid === f.componentUuid,
      )
      .map((r) => ({
        uuid: r.uuid,
        name: r.kind === "componentRequirement" ? r.description : "",
      })),
    discrepancies: s.discrepancies
      .filter(
        (d) =>
          d.aircraftUuid === f.aircraftUuid &&
          (d.status === "open" || d.uuid === f.discrepancyUuid),
      )
      .map((d) => ({ uuid: d.uuid, name: d.description })),
  };
}

// A card can link a report the workspace's window has left out (resolved
// before it). LinkSelect keeps the link either way; this names the report,
// loaded on demand, or says why it cannot.
function useLinkedReport(s: Snapshot, uuid: string): Choice | undefined {
  const held = !uuid || s.discrepancies.some((d) => d.uuid === uuid);
  const loaded = useHistoryRecords({
    discrepancyUuids: held ? [] : [uuid],
    taskCardUuids: [],
    flightPlanUuids: [],
  });
  if (held) return undefined;
  const report = loaded.records?.discrepancies[0];
  if (report) return { uuid, name: report.description };
  if (loaded.offline) return { uuid, name: OLDER_REPORT_OFFLINE };
  return loaded.loading ? undefined : { uuid, name: REPORT_UNAVAILABLE };
}

// Stock and locations come from the aircraft's own Flight Program.
function inventory(s: Snapshot, f: TaskCardFields) {
  const programUuid = s.aircraft.find(
    (a) => a.uuid === f.aircraftUuid,
  )?.programUuid;
  const records = s.management ?? [];
  return {
    stockItems: records.filter(
      (r): r is Stock =>
        r.kind === "stock" && recordProgram(s, r) === programUuid,
    ),
    locations: records.filter(
      (r) => r.kind === "location" && recordProgram(s, r) === programUuid,
    ),
  };
}

function updatePart(e: Editor, id: string, patch: Partial<TaskPart>) {
  e.change(
    "partsUsed",
    e.f.partsUsed.map((x) => (x.uuid === id ? { ...x, ...patch } : x)),
  );
}

function newPart(): TaskPart {
  return {
    uuid: crypto.randomUUID(),
    partNumber: "",
    description: "",
    quantity: 1,
    serialLot: "",
    removedComponent: "",
    installedComponent: "",
  };
}

async function uploadEvidence(
  backend: NonNullable<Workspace["backend"]>,
  card: TaskCard,
  file: File | undefined,
  data: FormData,
) {
  if (!file) throw new Error("Choose an evidence file.");
  validateWorkOrderFile(file.name, file.type, file.size);
  const category = value(data, "category");
  await backend.attachTaskEvidence(
    card.uuid,
    category as (typeof evidenceCategories)[number],
    file,
  );
}

// A card that failed its schema here reads field by field; anything else,
// including a server refusal, reads as errorText shows it.
function cardErrorText(error: unknown) {
  return error instanceof ZodError
    ? taskCardValidationMessages(error).join("\n")
    : errorText(error, "Unable to save the job card.");
}
