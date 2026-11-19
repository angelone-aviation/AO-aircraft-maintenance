/**
 * Responsibility: Parts and repair requests: the Request parts button, the
 *   requests screen with its editor and documents, and turning requests into
 *   a purchase order draft.
 * Layer: UI. React components; request rules live in src/domain.
 * Dependencies: react, react-dom, @phosphor-icons/react, src/data (store;
 *   partsRequestPdf on demand), src/domain (model, vendors, management,
 *   components, addresses, programs, requiredParts, shelfLife, partsRequests,
 *   partsRequestRules, purchaseOrders (types), aircraftSpruce, costs/units),
 *   ./Vendors, ./AircraftSpruce, ./SavedAddresses, ./PurchaseOrders,
 *   ./NumberInput, ./ui, ./design, ./ShopList, CSS.
 */
import { VendorPicker, newVendor } from "./Vendors";
import { localDate } from "../domain/model";
import { vendorDirectory, vendorKey } from "../domain/vendors";
import type { ManagedRecord, Vendor } from "../domain/management";
import type { Component } from "../domain/components";
import { SpruceProductPicker } from "./AircraftSpruce";
import { SavedAddressPicker } from "./SavedAddresses";
import { formatAddress } from "../domain/addresses";
import { CENTS_PER_DOLLAR } from "../domain/costs/units";
import {
  SPRUCE_VENDOR_NAME,
  type SpruceProduct,
} from "../domain/aircraftSpruce";
import { useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { can, type Snapshot } from "../domain/model";
import { programPermission } from "../domain/programs";
import { partsInventory } from "../domain/requiredParts";
import {
  SERVICEABLE_CONDITIONS,
  expiredForUse,
  usableQuantity,
} from "../domain/shelfLife";
import {
  recurringRequestSource,
  requestMatchesSource,
  requestDraftSchema,
  requestLineProgress,
  requestStatus,
  resolveRequestSource,
  type RequestDraft,
  type RequestSource,
  type PartsRequest,
  type RequestLine,
  type RequestCommand,
} from "../domain/partsRequests";
import type { PODraft } from "../domain/purchaseOrders";
import { REQUEST_STATUSES, requestPODraft } from "../domain/partsRequestRules";
import { POEditor, PODetail } from "./PurchaseOrders";
import { AsyncForm, Field, Modal, errorText } from "./ui";
import { NumberInput } from "./NumberInput";
import {
  EmptyState,
  PageHeader,
  SearchField,
  StatusPill,
  Toolbar,
} from "./design";
import { ShopLead, ShopPill, ShopSelect, ShopTableCard } from "./ShopList";
import {
  Airplane,
  ArrowsLeftRight,
  Flag,
  Funnel,
  Package,
  Plus,
  Receipt,
} from "@phosphor-icons/react";
import "./partsRequests.css";

const PRIORITIES: RequestDraft["priority"][] = [
  "P1 AOG",
  "P2 Routine",
  "P3 Stock",
];
const REQUEST_TABLE_STYLE = { "--shop-table-min": "900px" } as CSSProperties;
const SOURCE_PAGES: Partial<Record<RequestSource["kind"], string>> = {
  airworthiness: "/airworthiness",
  stock: "/inventory",
  workTask: "/work-orders",
  jobCard: "/task-cards",
  inspection: "/inspections",
  discrepancy: "/discrepancies",
};
const RESERVATION_LABELS = {
  reserve: "Reserve stock",
  release: "Release reservation",
  issue: "Issue reserved parts",
};

type Reservation = keyof typeof RESERVATION_LABELS;
type DraftText =
  | "date"
  | "engineer"
  | "requiredBy"
  | "timeframe"
  | "currency"
  | "shipTo"
  | "billTo"
  | "shipFrom"
  | "aircraftYear"
  | "shippingInstructions"
  | "returnInstructions";
type SourceOption = { value: RequestSource; label: string };
type RequestPartsButtonProps = {
  source: RequestSource;
  label?: string;
  initialOpen?: boolean;
  onClose?: () => void;
};

/**
 * The parts and repair requests button on a record: its open request count,
 * and a dialog with the record's requests and a New request button. Hidden
 * when the record cannot be resolved or the user may not read it (stock
 * needs inventory administrator access).
 *
 * @param props.source - The record the requests belong to.
 * @param props.label - The button text and dialog title.
 * @param props.initialOpen - Opens the dialog on first render.
 * @param props.onClose - Called when the dialog closes.
 * @returns The button and dialog, or null.
 */
export function RequestPartsButton({
  source,
  label = "Parts / repair requests",
  initialOpen = false,
  onClose,
}: RequestPartsButtonProps) {
  const { snapshot: s } = useWorkspace();
  const [open, setOpen] = useState(initialOpen);
  if (!s) return null;
  const resolved = resolvedSource(s, source);
  if (!resolved || !mayRead(s, resolved.aircraftUuid)) return null;
  const count =
    s.partsRequests?.filter(
      (r) => requestMatchesSource(s, r, source) && !r.cancelled,
    ).length ?? 0;
  return (
    <>
      <button
        type="button"
        className="button small"
        onClick={() => setOpen(true)}
      >
        {label}
        {count ? ` (${count})` : ""}
      </button>
      {open && (
        <RequestsDialog
          source={source}
          label={label}
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}

/**
 * The Parts & repair requests screen: every request in the Flight Program,
 * with search and filters, new requests, request details and, for inventory
 * administrators, turning selected requests into a purchase order.
 *
 * @returns The page; nothing before a snapshot is loaded.
 */
export function PartsRequests() {
  return <RequestWorkspace page />;
}

// Moved to the domain; kept here for the importers of this screen.
export { requestPODraft };

// The dialog is portalled to the body, and stops submit events there so a
// request form inside it never submits a form around the button.
function RequestsDialog({
  source,
  label,
  onClose,
}: {
  source: RequestSource;
  label: string;
  onClose: () => void;
}) {
  return createPortal(
    <div onSubmit={(e) => e.stopPropagation()}>
      <Modal title={label} wide onClose={onClose}>
        <RequestWorkspace source={source} />
      </Modal>
    </div>,
    document.body,
  );
}

// The requests list, on the screen or inside a record's dialog.
function RequestWorkspace({
  source,
  page = false,
}: {
  source?: RequestSource;
  page?: boolean;
}) {
  const workspace = useRequestWorkspace(source);
  if (!workspace) return null;
  const { s, filters, newRequest } = workspace;
  return (
    <div className="parts-requests">
      {page && (
        <PageHeader
          eyebrow="MAINTENANCE"
          title="Parts &"
          accent="repair requests"
          description="What mechanics need, what's been ordered, and what's out for repair. Request, reserve and issue parts, or track a component through repair and return."
          actions={newRequest}
        />
      )}
      <RequestToolbar
        s={s}
        filters={filters}
        end={page ? undefined : newRequest}
      />
      {workspace.error && (
        <p className="error" role="alert">
          {workspace.error}
        </p>
      )}
      <RequestTable workspace={workspace} />
      <RequestDialogs workspace={workspace} source={source} />
    </div>
  );
}

// The workspace's state: filters, selection, the open dialogs and the
// request the New request button drafts.
function useRequestWorkspace(source?: RequestSource) {
  const { snapshot: s, online, connected } = useWorkspace();
  const [edit, setEdit] = useState<RequestDraft>();
  const [view, setView] = useState<string>();
  const filters = useRequestFilters();
  const [selected, setSelected] = useState<string[]>([]);
  const [draftPO, setDraftPO] = useState<PODraft>();
  const [error, setError] = useState("");
  if (!s) return undefined;
  const admin = programPermission(s, "admin");
  const all = (s.partsRequests ?? []).filter(
    (r) => !source || requestMatchesSource(s, r, source),
  );
  const writable = online && connected;
  const startRequest = () => {
    setError("");
    try {
      setEdit(newDraft(s, source ?? sourceOptions(s)[0].value));
    } catch (e) {
      setError(errorText(e));
    }
  };
  return {
    s,
    admin,
    all,
    rows: filteredRequests(s, all, filters),
    current: all.find((r) => r.uuid === view),
    writable,
    filters,
    ...{ edit, setEdit, setView, selected, setSelected, draftPO, setDraftPO },
    ...{ error, setError },
    newRequest: canCreateRequest(s, source, admin) ? (
      <NewRequestButton disabled={!writable} onClick={startRequest} />
    ) : undefined,
  };
}

type Workspace = NonNullable<ReturnType<typeof useRequestWorkspace>>;

function useRequestFilters() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [aircraft, setAircraft] = useState("");
  return {
    ...{ search, setSearch, status, setStatus },
    ...{ priority, setPriority, aircraft, setAircraft },
  };
}

type Filters = ReturnType<typeof useRequestFilters>;

function NewRequestButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="button primary"
      disabled={disabled}
      onClick={onClick}
    >
      <Plus size={18} weight="bold" aria-hidden="true" />
      New request
    </button>
  );
}

function RequestToolbar({
  s,
  filters: f,
  end,
}: {
  s: Snapshot;
  filters: Filters;
  end?: ReactNode;
}) {
  return (
    <Toolbar className="shop-toolbar" end={end}>
      <SearchField
        label="Search requests"
        placeholder="Part, request, vendor or requester"
        value={f.search}
        onChange={f.setSearch}
      />
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
      <RequestFilterSelects filters={f} />
    </Toolbar>
  );
}

function RequestFilterSelects({ filters: f }: { filters: Filters }) {
  return (
    <>
      <ShopSelect
        label="Priority"
        icon={Flag}
        value={f.priority}
        onChange={f.setPriority}
      >
        <option value="">All priorities</option>
        {PRIORITIES.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </ShopSelect>
      <ShopSelect
        label="Status"
        icon={Funnel}
        value={f.status}
        onChange={f.setStatus}
      >
        <option value="">All statuses</option>
        {REQUEST_STATUSES.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </ShopSelect>
    </>
  );
}

function RequestTable({ workspace: w }: { workspace: Workspace }) {
  return (
    <ShopTableCard
      label="Parts and repair requests"
      className="shop-compact"
      stack
      title={
        <>
          Requests{" "}
          <span className="shop-count">
            {String(w.rows.length).padStart(2, "0")}
          </span>
        </>
      }
      actions={w.admin && <PurchaseSelectedButton workspace={w} />}
    >
      {w.rows.length ? (
        <table className="shop-table" style={REQUEST_TABLE_STYLE}>
          <thead>
            <tr>
              {w.admin && <th>Select</th>}
              <th>Request / aircraft</th>
              <th>Parts / source</th>
              <th>Priority / needed</th>
              <th>Vendor / requester</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {w.rows.map((r) => (
              <RequestRow key={r.uuid} workspace={w} request={r} />
            ))}
          </tbody>
        </table>
      ) : (
        <NoRequests any={w.all.length > 0} />
      )}
    </ShopTableCard>
  );
}

function PurchaseSelectedButton({ workspace: w }: { workspace: Workspace }) {
  return (
    <button
      type="button"
      className="button small"
      disabled={!w.writable || !w.selected.length}
      onClick={() => {
        try {
          w.setDraftPO(requestPODraft(w.s, w.selected));
          w.setError("");
        } catch (e) {
          w.setError(errorText(e));
        }
      }}
    >
      <Receipt size={17} aria-hidden="true" />
      Add selected to purchase order ({w.selected.length})
    </button>
  );
}

function NoRequests({ any }: { any: boolean }) {
  return (
    <div className="shop-table-empty">
      <EmptyState
        title={any ? "No requests match these filters" : "No requests yet"}
      >
        {any
          ? "Clear the search or filters to see every request."
          : "Create a request here, or from an inspection, discrepancy, work order, job card or component."}
      </EmptyState>
    </div>
  );
}

function RequestRow({
  workspace: w,
  request: r,
}: {
  workspace: Workspace;
  request: PartsRequest;
}) {
  const state = requestStatus(w.s, r);
  return (
    <tr>
      {w.admin && <RequestSelectCell workspace={w} request={r} />}
      <td className="shop-wide">
        <ShopLead
          icon={r.mode === "repair" ? ArrowsLeftRight : Package}
          tone={requestTone(state)}
          title={
            <button
              type="button"
              className="shop-title-button"
              onClick={() => w.setView(r.uuid)}
            >
              {r.number}
            </button>
          }
          sub={`${r.aircraftRegistration || "Stock"} · ${r.mode}`}
        />
      </td>
      <RequestPartsCell request={r} />
      <RequestPriorityCell request={r} />
      <td data-label="Vendor">
        {r.vendor || "Unassigned"}
        <small>{r.engineer}</small>
      </td>
      <td data-label="Status">
        <ShopPill tone={requestTone(state)}>{state}</ShopPill>
      </td>
    </tr>
  );
}

// Only an open occurrence with something still to order can be purchased.
function RequestSelectCell({
  workspace: w,
  request: r,
}: {
  workspace: Workspace;
  request: PartsRequest;
}) {
  const nothingToOrder = !r.lines.some(
    (l) => requestLineProgress(w.s, r, l.uuid).toOrder > 0,
  );
  return (
    <td className="shop-select-cell">
      <label className="shop-check-hit">
        <input
          type="checkbox"
          className="shop-check"
          aria-label={`Select ${r.number}`}
          checked={w.selected.includes(r.uuid)}
          disabled={r.recurring || r.cancelled || nothingToOrder}
          onChange={(e) =>
            w.setSelected(
              e.target.checked
                ? [...w.selected, r.uuid]
                : w.selected.filter((x) => x !== r.uuid),
            )
          }
        />
      </label>
    </td>
  );
}

function RequestPartsCell({ request: r }: { request: PartsRequest }) {
  return (
    <td className="shop-wide" data-label="Parts">
      <span className="shop-pr-lines">
        {r.lines.map((l) => (
          <span className="shop-pr-line" key={l.uuid}>
            <strong>{l.partNumber}</strong> × {l.quantity} — {l.description}
          </span>
        ))}
      </span>
      <small>
        {recurrenceLabel(r)}
        {r.sourceLabel}
      </small>
    </td>
  );
}

function RequestPriorityCell({ request: r }: { request: PartsRequest }) {
  return (
    <td data-label="Priority">
      {r.priority === "P1 AOG" ? (
        <ShopPill tone="danger">{r.priority}</ShopPill>
      ) : (
        <StatusPill dot={false}>{r.priority}</StatusPill>
      )}
      <small>{r.requiredBy || r.timeframe || "No date specified"}</small>
    </td>
  );
}

type DialogProps = { workspace: Workspace; source?: RequestSource };

function RequestDialogs({ workspace: w, source }: DialogProps) {
  const { current } = w;
  return (
    <>
      <EditorDialog workspace={w} source={source} />
      {current && (
        <Modal
          title={`${current.number} · ${requestStatus(w.s, current)}`}
          wide
          onClose={() => w.setView(undefined)}
        >
          <RequestDetail
            request={current}
            onEdit={() => {
              w.setView(undefined);
              w.setEdit(current);
            }}
          />
        </Modal>
      )}
      <PurchaseDialog workspace={w} />
    </>
  );
}

// Only a new request from the screen chooses its record.
function EditorDialog({ workspace: w, source }: DialogProps) {
  const { edit } = w;
  if (!edit) return null;
  return (
    <Modal
      title={edit.version ? "Edit request" : "New parts / repair request"}
      wide
      onClose={() => w.setEdit(undefined)}
    >
      <RequestEditor
        initial={edit}
        chooseSource={!source && !edit.version}
        onDone={() => w.setEdit(undefined)}
      />
    </Modal>
  );
}

function PurchaseDialog({ workspace: w }: { workspace: Workspace }) {
  if (!w.draftPO) return null;
  return (
    <Modal
      title="Purchase requested parts / repair services"
      wide
      onClose={() => w.setDraftPO(undefined)}
    >
      <POEditor
        initial={w.draftPO}
        onDone={() => {
          w.setDraftPO(undefined);
          w.setSelected([]);
        }}
      />
    </Modal>
  );
}

type RequestEditorProps = {
  initial: RequestDraft;
  chooseSource: boolean;
  onDone: () => void;
};

function RequestEditor({ initial, chooseSource, onDone }: RequestEditorProps) {
  const editor = useRequestEditor(initial);
  const { draft } = editor;
  return (
    <AsyncForm
      submitLabel="Save request"
      disabled={!editor.writable}
      onSubmit={async () => {
        await editor.backend!.partsRequest({
          kind: "save",
          requestUuid: editor.requestUuid,
          draft: requestDraftSchema.parse(draft),
        });
        onDone();
      }}
    >
      {chooseSource && <SourceField editor={editor} />}
      <SourceNotice editor={editor} />
      <RecurringField editor={editor} />
      <RequestFields editor={editor} />
      <DeliverToField editor={editor} />
      {draft.lines.map((l, index) => (
        <RequestLineFields
          key={l.uuid}
          editor={editor}
          line={l}
          index={index}
        />
      ))}
      <EditorFooter editor={editor} />
    </AsyncForm>
  );
}

// The editor's state: the draft, vendors added while editing, and what the
// request's source allows.
function useRequestEditor(initial: RequestDraft) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const s = snapshot!;
  const [draft, setDraft] = useState(initial);
  const [addedVendors, setAddedVendors] = useState<Vendor[]>([]);
  const [requestUuid] = useState(() => crypto.randomUUID());
  const patch = (p: Partial<RequestDraft>) => setDraft((d) => ({ ...d, ...p }));
  const selectVendor = (name: string, vendor?: Vendor) =>
    setDraft((d) => ({ ...d, ...vendorFields(name, vendor) }));
  const resolved = resolveRequestSource(s, draft.source);
  return {
    ...{ s, backend, writable: online && connected, requestUuid },
    ...{ draft, setDraft, patch, resolved, selectVendor },
    linePatch: (uuid: string, p: Partial<RequestLine>) =>
      patch({
        lines: draft.lines.map((l) => (l.uuid === uuid ? lineChange(l, p) : l)),
      }),
    vendorOptions: uniqueVendors([...vendorDirectory(s), ...addedVendors]),
    addVendor: (name: string) =>
      addVendor(s, backend, name, (record) => {
        setAddedVendors((previous) => [...previous, record]);
        selectVendor(record.name, record);
      }),
    components: repairableComponents(s, resolved.aircraftUuid),
    inventory: partsInventory(s),
  };
}

type Editor = ReturnType<typeof useRequestEditor>;

// Choosing another record starts a new draft for it, keeping the draft's
// uuid.
function SourceField({ editor }: { editor: Editor }) {
  const { s, draft } = editor;
  return (
    <Field label="Request for">
      <select
        value={JSON.stringify(draft.source)}
        onChange={(e) => {
          const source = JSON.parse(e.target.value) as RequestSource;
          editor.setDraft({ ...newDraft(s, source), uuid: draft.uuid });
        }}
      >
        {sourceOptions(s).map((o) => (
          <option key={JSON.stringify(o.value)} value={JSON.stringify(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SourceNotice({ editor }: { editor: Editor }) {
  const { aircraft, label } = editor.resolved;
  return (
    <p className="notice">
      {label}
      <br />
      {aircraft
        ? `${aircraft.registration} · ${aircraft.make} ${aircraft.model} · Aircraft S/N ${aircraft.serial}`
        : "Inventory stock request"}
    </p>
  );
}

function DeliverToField({ editor }: { editor: Editor }) {
  const { draft } = editor;
  return (
    <SavedAddressPicker
      label="Deliver / return to"
      inventoryLocationName={draft.base}
      value={draft.shipToDetails}
      legacy={draft.shipTo}
      onChange={(address) =>
        editor.patch({ shipToDetails: address, shipTo: formatAddress(address) })
      }
    />
  );
}

// A recurring parts list belongs to the scheduled work, not to one
// occurrence, and is fixed once saved. Only parts requests from a recurring
// source offer it.
function RecurringField({ editor }: { editor: Editor }) {
  const { s, draft } = editor;
  if (draft.mode !== "parts") return null;
  if (!draft.recurring && !recurringRequestSource(s, draft.source)) return null;
  return (
    <section className="notice">
      <label>
        <input
          type="checkbox"
          checked={!!draft.recurring}
          disabled={!!draft.version}
          onChange={(e) => editor.patch({ recurring: e.target.checked })}
        />{" "}
        Recurring — required each time this inspection/service/AD task is
        performed
      </label>
      {draft.recurring && (
        <p>
          Recurring ·{" "}
          {
            resolveRequestSource(
              s,
              recurringRequestSource(s, draft.source) ?? draft.source,
            ).label
          }
          . Follows its maintenance schedule. Each open work-order occurrence
          gets a separate request. Reserve stock and order parts from that
          occurrence.
        </p>
      )}
    </section>
  );
}

function RequestFields({ editor }: { editor: Editor }) {
  const input = (field: DraftText, label: string, type?: string) => (
    <DraftInput editor={editor} field={field} label={label} type={type} />
  );
  return (
    <div className="request-grid">
      <RequestTypeField editor={editor} />
      {input("date", "Request date", "date")}
      {input("engineer", "Engineer / requester")}
      <LocationField editor={editor} />
      <PriorityField editor={editor} />
      {input("requiredBy", "Required by", "date")}
      {input("timeframe", "Anticipated timeframe")}
      <RequestVendorPicker editor={editor} />

      {input("currency", "Currency")}

      {input("aircraftYear", "Aircraft year (if known)")}
    </div>
  );
}

// A repair names one component per line, so changing the type clears the
// lines' components; a repair is never recurring.
function RequestTypeField({ editor }: { editor: Editor }) {
  const { draft } = editor;
  return (
    <Field label="Request type">
      <select
        value={draft.mode}
        onChange={(e) =>
          editor.patch({
            mode: e.target.value as RequestDraft["mode"],
            recurring: e.target.value === "parts" ? draft.recurring : false,
            lines: draft.lines.map((l) => ({ ...l, componentUuid: "" })),
          })
        }
      >
        <option value="parts">Parts</option>
        <option value="repair">Component repair / service</option>
      </select>
    </Field>
  );
}

function DraftInput({
  editor,
  field,
  label,
  type = "text",
}: {
  editor: Editor;
  field: DraftText;
  label: string;
  type?: string;
}) {
  return (
    <Field label={label}>
      <input
        type={type}
        value={editor.draft[field]}
        onChange={(e) => editor.patch({ [field]: e.target.value })}
        required={
          field === "date" || field === "engineer" || field === "currency"
        }
      />
    </Field>
  );
}

// A location no longer in inventory stays selectable under its saved name.
function LocationField({ editor }: { editor: Editor }) {
  const { draft, inventory } = editor;
  const names = [
    ...new Set(inventory.locations.map((location) => location.name)),
  ];
  return (
    <Field
      label="Inventory location"
      hint={
        inventory.locations.length
          ? undefined
          : "Add an inventory location in this Flight Program to select it here."
      }
    >
      <select
        value={draft.base}
        onChange={(e) => editor.patch({ base: e.target.value })}
      >
        <option value="">Select inventory location</option>
        {draft.base &&
          !inventory.locations.some(
            (location) => location.name === draft.base,
          ) && (
            <option value={draft.base}>{draft.base} (previously saved)</option>
          )}
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PriorityField({ editor }: { editor: Editor }) {
  return (
    <Field label="Priority">
      <select
        value={editor.draft.priority}
        onChange={(e) =>
          editor.patch({ priority: e.target.value as RequestDraft["priority"] })
        }
      >
        {PRIORITIES.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
    </Field>
  );
}

// Only an inventory administrator saves a new vendor to the directory;
// others name a custom vendor on this request alone.
function RequestVendorPicker({ editor }: { editor: Editor }) {
  const admin = programPermission(editor.s, "admin");
  return (
    <VendorPicker
      label="Preferred vendor"
      value={editor.draft.vendor}
      options={editor.vendorOptions}
      disabled={!editor.writable}
      nameOnly
      customLabel={admin ? "Create custom vendor" : "Use custom vendor"}
      onChange={editor.selectVendor}
      onAdd={editor.addVendor}
    />
  );
}

function RequestLineFields({ editor, line: l, index }: LineProps) {
  const { draft } = editor;
  return (
    <section className="request-line">
      <h3>Item {index! + 1}</h3>
      {draft.mode === "parts" && (
        <LineSupplierPicker editor={editor} line={l} />
      )}
      <SupplierMapping editor={editor} line={l} />
      {draft.mode === "repair" && (
        <RepairComponentField editor={editor} line={l} />
      )}
      <LinePartFields editor={editor} line={l} />
      <LineNeeds editor={editor} line={l} />
      {draft.lines.length > 1 && (
        <button
          type="button"
          className="button small"
          onClick={() =>
            editor.patch({
              lines: draft.lines.filter((x) => x.uuid !== l.uuid),
            })
          }
        >
          Remove item
        </button>
      )}
    </section>
  );
}

type LineProps = { editor: Editor; line: RequestLine; index?: number };

function SupplierMapping({ editor, line: l }: LineProps) {
  if (!l.sprucePart) return null;
  return (
    <p>
      Aircraft Spruce: {l.sprucePart.partNumber} · {l.sprucePart.uom}{" "}
      <button
        type="button"
        className="text-button"
        onClick={() => editor.linePatch(l.uuid, { sprucePart: undefined })}
      >
        Remove supplier mapping
      </button>
    </p>
  );
}

function LineSupplierPicker({ editor, line: l }: LineProps) {
  return (
    <SpruceProductPicker
      initialSearch={l.partNumber}
      currency={editor.draft.currency}
      onSelect={(product, cents) => {
        editor.linePatch(l.uuid, spruceChange(l, product, cents));
        editor.setDraft((d) => ({
          ...d,
          vendor: d.vendor || SPRUCE_VENDOR_NAME,
        }));
      }}
    />
  );
}

// A repair returns one serialized component, so choosing it fixes the line's
// part, description and quantity.
function RepairComponentField({ editor, line: l }: LineProps) {
  return (
    <Field label="Existing serialized component">
      <select
        required
        value={l.componentUuid}
        onChange={(e) => {
          const c = editor.components.find((c) => c.uuid === e.target.value);
          if (c?.kind === "component")
            editor.linePatch(l.uuid, {
              componentUuid: c.uuid,
              partNumber: c.partNumber,
              description: componentDescription(c),
              quantity: 1,
            });
        }}
      >
        <option value="">Choose an uninstalled component</option>
        {editor.components.map((c) => (
          <option key={c.uuid} value={c.uuid}>
            {c.partNumber} · S/N {c.serial}
          </option>
        ))}
      </select>
    </Field>
  );
}

function LinePartFields({ editor, line: l }: LineProps) {
  const repair = editor.draft.mode === "repair";
  const set = (p: Partial<RequestLine>) => editor.linePatch(l.uuid, p);
  return (
    <div className="request-grid">
      <Field label="Part number">
        <input
          required
          value={l.partNumber}
          readOnly={repair}
          onChange={(e) => set({ partNumber: e.target.value })}
        />
      </Field>
      <Field label="Alternate part number">
        <input
          value={l.alternateNumber}
          onChange={(e) => set({ alternateNumber: e.target.value })}
        />
      </Field>
      <Field label="Part name">
        <input
          required
          value={l.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>
      <LineQuantityFields editor={editor} line={l} />
      {repair && <RepairWorkFields editor={editor} line={l} />}
    </div>
  );
}

function LineQuantityFields({ editor, line: l }: LineProps) {
  const set = (p: Partial<RequestLine>) => editor.linePatch(l.uuid, p);
  return (
    <>
      <Field label="Quantity">
        <NumberInput
          min={1}
          step={1}
          required
          value={l.quantity}
          readOnly={editor.draft.mode === "repair"}
          onValue={(quantity) => set({ quantity })}
        />
      </Field>
      <Field label="IPC / manual reference">
        <input
          value={l.ipcReference}
          onChange={(e) => set({ ipcReference: e.target.value })}
        />
      </Field>
    </>
  );
}

function RepairWorkFields({ editor, line: l }: LineProps) {
  const set = (p: Partial<RequestLine>) => editor.linePatch(l.uuid, p);
  return (
    <>
      <Field label="Work type">
        <select
          value={l.service}
          onChange={(e) =>
            set({ service: e.target.value as RequestLine["service"] })
          }
        >
          <option>repair</option>
          <option>overhaul</option>
          <option>inspection</option>
        </select>
      </Field>
      <Field label={`Quoted cost (${editor.draft.currency})`}>
        <NumberInput
          min={0}
          step="0.01"
          value={l.quotedCents / CENTS_PER_DOLLAR}
          onValue={(amount) =>
            set({ quotedCents: Math.round(amount * CENTS_PER_DOLLAR) })
          }
        />
      </Field>
    </>
  );
}

// A repair line describes the defect and the work; a parts line shows what
// stock can already fill it.
function LineNeeds({ editor, line: l }: LineProps) {
  const set = (p: Partial<RequestLine>) => editor.linePatch(l.uuid, p);
  if (editor.draft.mode !== "repair")
    return (
      <StockAvailability
        partNumber={l.partNumber}
        alternate={l.alternateNumber}
        needed={l.quantity}
      />
    );
  return (
    <>
      <Field label="Defect">
        <textarea
          required
          value={l.defect}
          onChange={(e) => set({ defect: e.target.value })}
        />
      </Field>
      <Field label="Work requested">
        <textarea
          required
          value={l.workRequested}
          onChange={(e) => set({ workRequested: e.target.value })}
        />
      </Field>
    </>
  );
}

function EditorFooter({ editor }: { editor: Editor }) {
  const { draft, patch } = editor;
  return (
    <>
      <button
        type="button"
        className="button"
        onClick={() => patch({ lines: [...draft.lines, newLine()] })}
      >
        Add part / component
      </button>
      {draft.mode === "repair" && <RepairShippingFields editor={editor} />}
      <Field
        label={draft.mode === "repair" ? "Repair notes" : "Ordering notes"}
      >
        <textarea
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </Field>
      {!editor.inventory.locations.length && (
        <p className="notice">
          An inventory administrator must create a delivery location before
          purchasing or receiving.
        </p>
      )}
    </>
  );
}

function RepairShippingFields({ editor }: { editor: Editor }) {
  const { draft, patch } = editor;
  return (
    <div className="request-grid">
      <SavedAddressPicker
        label="Ship from"
        inventoryLocationName={draft.base}
        value={draft.shipFromDetails}
        legacy={draft.shipFrom}
        onChange={(address) =>
          patch({ shipFromDetails: address, shipFrom: formatAddress(address) })
        }
      />
      <SavedAddressPicker
        label="Bill to"
        value={draft.billToDetails}
        legacy={draft.billTo}
        onChange={(address) =>
          patch({ billToDetails: address, billTo: formatAddress(address) })
        }
      />
      <DraftInput
        editor={editor}
        field="shippingInstructions"
        label="Shipping instructions"
      />
      <DraftInput
        editor={editor}
        field="returnInstructions"
        label="Return instructions"
      />
    </div>
  );
}

// Expired lots cannot be reserved or issued, so they are never available.
function StockAvailability({
  partNumber,
  alternate,
  needed,
}: {
  partNumber: string;
  alternate: string;
  needed: number;
}) {
  const s = useWorkspace().snapshot!;
  const inventory = partsInventory(s);
  const stock = inventory.stock.filter(
    (x) =>
      x.partNumber === partNumber || (alternate && x.partNumber === alternate),
  );
  const serviceable = stock.filter(
    (x) =>
      x.partNumber === partNumber &&
      SERVICEABLE_CONDITIONS.includes(x.condition ?? "new"),
  );
  const available = serviceable.reduce((n, x) => n + usableQuantity(x), 0);
  const expired = serviceable
    .filter((x) => expiredForUse(x.expirationDate))
    .reduce((n, x) => n + x.quantity, 0);
  return (
    <div className="request-availability">
      <strong>
        Available: {available} · Shortage: {Math.max(0, needed - available)}
        {expired > 0 && ` · Expired: ${expired}`}
      </strong>
      <small className="block">
        Alternates require explicit selection. Reserving holds stock; issuing
        records its use.
      </small>
      <StockTable stock={stock} inventory={inventory} partNumber={partNumber} />
      {!stock.length && <p>No matching inventory stock.</p>}
    </div>
  );
}

type Inventory = ReturnType<typeof partsInventory>;
type InventoryStock = Inventory["stock"][number];

function StockTable({
  stock,
  inventory,
  partNumber,
}: {
  stock: InventoryStock[];
  inventory: Inventory;
  partNumber: string;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Part / condition</th>
          <th>Location</th>
          <th>On hand</th>
          <th>Reserved</th>
          <th>Available</th>
        </tr>
      </thead>
      <tbody>
        {stock.map((x) => (
          <tr key={x.uuid}>
            <td>
              {x.partNumber}
              {x.partNumber !== partNumber && " (alternate)"} · {x.condition}
              {expiredForUse(x.expirationDate) &&
                ` · Expired ${x.expirationDate}`}
            </td>
            <td>{locationName(inventory, x.locationUuid)}</td>
            <td>{x.quantity}</td>
            <td>{x.reservedQuantity ?? 0}</td>
            <td>{usableQuantity(x)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type RequestDetailProps = { request: PartsRequest; onEdit: () => void };

function RequestDetail({ request: r, onEdit }: RequestDetailProps) {
  const { snapshot, online, connected } = useWorkspace();
  const s = snapshot!;
  const [poUuid, setPoUuid] = useState("");
  const [editPO, setEditPO] = useState<PODraft>();
  const po = s.purchaseOrders?.find((p) => p.uuid === poUuid);
  const admin = programPermission(s, "admin");
  const writable = online && connected;
  return (
    <div className="parts-requests">
      <RequestSummary s={s} request={r} />
      <RequestActions s={s} request={r} writable={writable} onEdit={onEdit} />
      {r.lines.map((l) => (
        <LineProgress
          key={l.uuid}
          s={s}
          request={r}
          line={l}
          onOrder={setPoUuid}
        />
      ))}
      <p>{r.notes}</p>
      {admin && !r.cancelled && (
        <CancelRequest request={r} writable={writable} />
      )}
      <RequestHistory s={s} request={r} />
      <OrderDialogs
        po={po}
        editPO={editPO}
        onEditPO={setEditPO}
        onPO={setPoUuid}
      />
    </div>
  );
}

function RequestSummary({
  s,
  request: r,
}: {
  s: Snapshot;
  request: PartsRequest;
}) {
  return (
    <>
      <p>
        <strong>{r.aircraftRegistration || "Stock"}</strong> ·{" "}
        <a href={SOURCE_PAGES[r.source.kind] ?? "/components"}>
          {r.sourceLabel}
        </a>
        <br />
        {r.engineer} · {r.date} · {r.priority}
        <br />
        Vendor: {r.vendor || "Unassigned"} · {r.currency} · Deliver to:{" "}
        {r.shipTo || "Not specified"}
      </p>
      {r.recurring && (
        <p className="notice">
          Recurring · {r.sourceLabel}. A separate request is created when this
          work is added to a work order. Changes here apply to future
          occurrences.
        </p>
      )}
      {r.templateUuid && (
        <p className="notice">
          Recurring occurrence ·{" "}
          {s.partsRequests?.find((t) => t.uuid === r.templateUuid)?.number ??
            r.templateUuid}
        </p>
      )}
    </>
  );
}

type RequestActionsProps = {
  s: Snapshot;
  request: PartsRequest;
  writable: boolean;
  onEdit: () => void;
};

function RequestActions({
  s,
  request: r,
  writable,
  onEdit,
}: RequestActionsProps) {
  const [docError, setDocError] = useState("");
  return (
    <>
      <div className="management-actions">
        {!r.cancelled && mayMaintain(s, r.aircraftUuid) && (
          <button
            type="button"
            className="button"
            onClick={onEdit}
            disabled={!writable}
          >
            Edit request
          </button>
        )}
        <RequestDocuments s={s} request={r} onError={setDocError} />
      </div>
      {docError && (
        <p role="alert" className="error">
          {docError}
        </p>
      )}
    </>
  );
}

function RequestDocuments({
  s,
  request: r,
  onError,
}: {
  s: Snapshot;
  request: PartsRequest;
  onError: (error: string) => void;
}) {
  const save = (kind: "request" | "packing", filename: string) =>
    saveRequestPdf(r, s, kind, filename, onError);
  return (
    <>
      <button
        type="button"
        className="button"
        onClick={() => save("request", `${r.number}.pdf`)}
      >
        Download {r.mode === "repair" ? "repair order / tag" : "parts request"}
      </button>
      {r.mode === "repair" && (
        <button
          type="button"
          className="button"
          onClick={() => save("packing", `${r.number}-packing-slip.pdf`)}
        >
          Download packing slip
        </button>
      )}
    </>
  );
}

// Reserving and issuing apply to parts on an open occurrence request, and
// only inventory administrators may do them.
function LineProgress({
  s,
  request: r,
  line: l,
  onOrder,
}: {
  s: Snapshot;
  request: PartsRequest;
  line: RequestLine;
  onOrder: (poUuid: string) => void;
}) {
  const p = requestLineProgress(s, r, l.uuid);
  const admin = programPermission(s, "admin");
  return (
    <section className="request-line">
      <h3>
        {l.partNumber} — {l.description} × {l.quantity}
      </h3>
      <p>
        Reserved {p.reserved} · Issued {p.issued} · On POs {p.ordered} ·
        Received {p.received} · To order {p.toOrder}
      </p>
      {l.ipcReference && <p>IPC / manual: {l.ipcReference}</p>}
      <LineWork request={r} line={l} remaining={p.remaining} />
      {p.purchases.map((a, i) => (
        <PurchaseLink
          key={`${a.poUuid}-${i}`}
          s={s}
          purchase={a}
          admin={admin}
          onOrder={onOrder}
        />
      ))}
      {admin && !r.cancelled && !r.recurring && r.mode === "parts" && (
        <ReservationForm request={r} line={l} />
      )}
    </section>
  );
}

function LineWork({
  request: r,
  line: l,
  remaining,
}: {
  request: PartsRequest;
  line: RequestLine;
  remaining: number;
}) {
  if (r.mode !== "repair")
    return (
      <StockAvailability
        partNumber={l.partNumber}
        alternate={l.alternateNumber}
        needed={remaining}
      />
    );
  return (
    <p>
      {l.service} · Defect: {l.defect}
      <br />
      Work requested: {l.workRequested}
    </p>
  );
}

type Purchase = ReturnType<typeof requestLineProgress>["purchases"][number];

// Only inventory administrators open the purchase order itself.
function PurchaseLink({
  s,
  purchase: a,
  admin,
  onOrder,
}: {
  s: Snapshot;
  purchase: Purchase;
  admin: boolean;
  onOrder: (poUuid: string) => void;
}) {
  return (
    <p>
      <button
        type="button"
        className="text-button"
        disabled={!admin}
        onClick={() => onOrder(a.poUuid)}
      >
        {a.number}
      </button>{" "}
      · {a.phase} · Qty {a.quantity} · Received {a.received} · Expected{" "}
      {a.expectedDate || "Not specified"}
      {a.purchasedDate &&
        ` · Purchased ${a.purchasedDate} by ${(s.members ?? []).find((m) => m.id === a.purchasedBy)?.name ?? a.purchasedBy}`}
    </p>
  );
}

function CancelRequest({
  request: r,
  writable,
}: {
  request: PartsRequest;
  writable: boolean;
}) {
  const { backend } = useWorkspace();
  return (
    <details>
      <summary>Cancel request</summary>
      <AsyncForm
        submitLabel="Cancel request and release reservations"
        disabled={!writable}
        onSubmit={async (data) => {
          await backend!.partsRequest({
            kind: "cancel",
            requestUuid: crypto.randomUUID(),
            uuid: r.uuid,
            version: r.version,
            reason: String(data.get("reason")),
          });
        }}
      >
        <Field label="Cancellation reason">
          <input name="reason" required />
        </Field>
        <p>
          Issued parts and purchasing history remain recorded. Outstanding PO
          quantities must be cancelled first.
        </p>
      </AsyncForm>
    </details>
  );
}

function RequestHistory({
  s,
  request: r,
}: {
  s: Snapshot;
  request: PartsRequest;
}) {
  return (
    <details>
      <summary>Request history ({r.history.length})</summary>
      {r.history.map((h, i) => (
        <p key={i}>
          {new Date(h.at).toLocaleString()} · {h.action} ·{" "}
          {s.members.find((m) => m.id === h.actorId)?.name ?? h.actorId}
        </p>
      ))}
    </details>
  );
}

function OrderDialogs({
  po,
  editPO,
  onEditPO,
  onPO,
}: {
  po?: NonNullable<Snapshot["purchaseOrders"]>[number];
  editPO?: PODraft;
  onEditPO: (draft?: PODraft) => void;
  onPO: (uuid: string) => void;
}) {
  return (
    <>
      {editPO && (
        <Modal
          title="Edit purchase order"
          wide
          onClose={() => onEditPO(undefined)}
        >
          <POEditor initial={editPO} onDone={() => onEditPO(undefined)} />
        </Modal>
      )}
      {po && (
        <Modal title={po.number} wide onClose={() => onPO("")}>
          <PODetail
            po={po}
            onEdit={() => {
              onEditPO(po);
              onPO("");
            }}
          />
        </Modal>
      )}
    </>
  );
}

// Reserving draws on the line's part or its listed alternate; releasing and
// issuing act on the lots already reserved for the line.
type ReservationFormProps = { request: PartsRequest; line: RequestLine };

function ReservationForm({ request: r, line }: ReservationFormProps) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const [stockUuid, setStock] = useState("");
  const [operation, setOperation] = useState<Reservation>("reserve");
  const [quantity, setQuantity] = useState(1);
  const [alternate, setAlternate] = useState(false);
  const inventory = partsInventory(snapshot!);
  const stocks = reservationStocks(inventory, r, line, operation);
  const form = { r, line, inventory, stocks, operation, stockUuid, quantity };
  const confirmsAlternate =
    operation === "reserve" &&
    stocks.find((x) => x.uuid === stockUuid)?.partNumber !== line.partNumber &&
    stockUuid;
  return (
    <AsyncForm
      submitLabel={RESERVATION_LABELS[operation]}
      disabled={!online || !connected}
      onSubmit={async () => {
        await backend!.partsRequest(reservationCommand(form, alternate));
      }}
    >
      <ReservationFields
        form={form}
        set={{ setOperation, setStock, setQuantity, setAlternate }}
      />
      {confirmsAlternate && (
        <AlternateConfirmation checked={alternate} onChange={setAlternate} />
      )}
    </AsyncForm>
  );
}

function reservationCommand(
  { r, line, operation, stockUuid, quantity }: ReservationState,
  alternateConfirmed: boolean,
): RequestCommand {
  return {
    kind: operation,
    requestUuid: crypto.randomUUID(),
    uuid: r.uuid,
    version: r.version,
    lineUuid: line.uuid,
    stockUuid,
    quantity,
    alternateConfirmed,
    // Costs count an issued part on this date in every time zone.
    date: operation === "issue" ? localDate() : undefined,
  };
}

type ReservationState = {
  r: PartsRequest;
  line: RequestLine;
  inventory: Inventory;
  stocks: InventoryStock[];
  operation: Reservation;
  stockUuid: string;
  quantity: number;
};

type ReservationSetters = {
  setOperation: (operation: Reservation) => void;
  setStock: (stockUuid: string) => void;
  setQuantity: (quantity: number) => void;
  setAlternate: (alternate: boolean) => void;
};

// Another action or lot starts the lot choice and alternate confirmation
// again.
function ReservationFields({
  form: f,
  set,
}: {
  form: ReservationState;
  set: ReservationSetters;
}) {
  return (
    <div className="request-grid">
      <Field label="Inventory action">
        <select
          value={f.operation}
          onChange={(e) => {
            set.setOperation(e.target.value as Reservation);
            set.setStock("");
          }}
        >
          <option value="reserve">Reserve</option>
          <option value="issue">Issue reserved parts</option>
          <option value="release">Release reservation</option>
        </select>
      </Field>
      <StockLotField
        form={f}
        onStock={(next) => {
          set.setStock(next);
          set.setAlternate(false);
        }}
      />
      <QuantityField quantity={f.quantity} onChange={set.setQuantity} />
    </div>
  );
}

function QuantityField({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (quantity: number) => void;
}) {
  return (
    <Field label="Quantity">
      <NumberInput
        required
        min={1}
        step={1}
        value={quantity}
        onValue={onChange}
      />
    </Field>
  );
}

function StockLotField({
  form: f,
  onStock,
}: {
  form: ReservationState;
  onStock: (stockUuid: string) => void;
}) {
  return (
    <Field label="Stock lot / location">
      <select
        value={f.stockUuid}
        required
        onChange={(e) => onStock(e.target.value)}
      >
        <option value="">Select stock</option>
        {f.stocks.map((x) => (
          <option key={x.uuid} value={x.uuid}>
            {x.partNumber} · {locationName(f.inventory, x.locationUuid)} ·{" "}
            {x.condition} · {stockLotStatus(f, x)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function AlternateConfirmation({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={checked}
        required
        onChange={(e) => onChange(e.target.checked)}
      />{" "}
      I confirm use of the listed alternate part number.
    </label>
  );
}

// Empty editable fields stay until the form is submitted.
function newLine(): RequestLine {
  return {
    uuid: crypto.randomUUID(),
    partNumber: "",
    description: "",
    quantity: 1,
    alternateNumber: "",
    ipcReference: "",
    componentUuid: "",
    service: "repair",
    defect: "",
    workRequested: "",
    quotedCents: 0,
  };
}

// A new request for a record: its required parts (or one line for the
// stock item or component), its location, and a repair when the source is
// an uninstalled component.
function newDraft(s: Snapshot, source: RequestSource): RequestDraft {
  const resolved = resolveRequestSource(s, source);
  const component = findRecord(s, "component", resolved.componentUuid);
  const stock =
    source.kind === "stock" ? findRecord(s, "stock", source.uuid) : undefined;
  const linked = linkedRecord(s, source);
  const reference = referenceText(linked);
  const requested = requiredLines(s, linked, reference);
  const line = firstLine(source, stock, component, reference);
  const location = draftLocation(s, stock, component);
  const repair = repairsComponent(source, component);
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    source,
    recurring: requested.length > 0 && !!recurringRequestSource(s, source),
    mode: repair ? "repair" : "parts",
    date: localDate(),
    engineer: s.user.name,
    base: location?.kind === "location" ? location.name : "",
    priority: source.kind === "stock" ? "P3 Stock" : "P2 Routine",
    requiredBy: "",
    timeframe: "",
    vendor: stock?.kind === "stock" ? (stock.vendor ?? "") : "",
    vendorAddress: "",
    currency: "USD",
    ...draftShipping(location),
    aircraftYear: "",
    notes: "",
    shippingInstructions: "",
    returnInstructions: "",
    lines: requested.length ? requested : [line],
  };
}

function findRecord(s: Snapshot, kind: ManagedRecord["kind"], uuid: string) {
  return s.management?.find((r) => r.kind === kind && r.uuid === uuid);
}

function linkedRecord(s: Snapshot, source: RequestSource) {
  const uuid = source.uuid;
  if (source.kind === "inspection")
    return s.inspections.find((r) => r.uuid === uuid);
  if (source.kind === "discrepancy")
    return s.discrepancies.find((r) => r.uuid === uuid);
  if (source.kind === "jobCard")
    return s.taskCards?.find((r) => r.uuid === uuid);
  if (source.kind === "componentRequirement")
    return s.management?.find(
      (r) => r.uuid === uuid && r.kind === "componentRequirement",
    );
  return undefined;
}

type Linked = ReturnType<typeof linkedRecord>;

function referenceText(linked: Linked) {
  if (!linked || !("manualReference" in linked) || !linked.manualReference)
    return "";
  const { section, printedPage, pdfPage } = linked.manualReference;
  return `${section} · printed page ${printedPage} · PDF page ${pdfPage}`;
}

// A record's required parts that are in stock become the request's lines.
function requiredLines(s: Snapshot, linked: Linked, reference: string) {
  if (!linked || !("requiredParts" in linked)) return [];
  if (!Array.isArray(linked.requiredParts)) return [];
  const inventory = partsInventory(s);
  return linked.requiredParts.flatMap((p) => {
    const stock = inventory.stock.find((x) => x.uuid === p.stockUuid);
    if (!stock) return [];
    return [
      {
        ...newLine(),
        partNumber: stock.partNumber,
        description: stock.description,
        quantity: p.quantity,
        ipcReference: reference,
      },
    ];
  });
}

function firstLine(
  source: RequestSource,
  stock: ManagedRecord | undefined,
  component: ManagedRecord | undefined,
  reference: string,
): RequestLine {
  const line = { ...newLine(), ipcReference: reference };
  if (stock?.kind === "stock")
    Object.assign(line, {
      partNumber: stock.partNumber,
      description: stock.description,
      alternateNumber: stock.alternates,
    });
  if (repairsComponent(source, component) && component?.kind === "component")
    Object.assign(line, {
      partNumber: component.partNumber,
      description: componentDescription(component),
      componentUuid: component.uuid,
    });
  return line;
}

// Only an uninstalled component can be sent out for repair.
function repairsComponent(
  source: RequestSource,
  component: ManagedRecord | undefined,
) {
  return (
    source.kind === "component" &&
    component?.kind === "component" &&
    !component.installed
  );
}

function draftLocation(
  s: Snapshot,
  stock: ManagedRecord | undefined,
  component: ManagedRecord | undefined,
) {
  let uuid: string | undefined = "";
  if (stock?.kind === "stock") uuid = stock.locationUuid;
  else if (component?.kind === "component") uuid = component.locationUuid;
  return s.management?.find((r) => r.kind === "location" && r.uuid === uuid);
}

function draftShipping(location: ManagedRecord | undefined) {
  const found = location?.kind === "location" ? location : undefined;
  return {
    shipTo: found ? found.address : "",
    shipToDetails: found ? found.addressDetails : undefined,
    billTo: "",
    shipFrom: "",
  };
}

function componentDescription(c: Component) {
  return `${c.manufacturer} ${c.model ?? c.componentType}`;
}

// A record that was deleted or left the program resolves to nothing.
function resolvedSource(s: Snapshot, source: RequestSource) {
  try {
    return resolveRequestSource(s, source);
  } catch {
    return undefined;
  }
}

// An aircraft's records follow its permissions; stock needs inventory
// administrator access.
function mayRead(s: Snapshot, aircraftUuid: string) {
  return aircraftUuid
    ? can(s, aircraftUuid, "read")
    : programPermission(s, "admin");
}

function mayMaintain(s: Snapshot, aircraftUuid: string) {
  return aircraftUuid
    ? can(s, aircraftUuid, "maintenance")
    : programPermission(s, "admin");
}

// From a record, a maintainer of its aircraft creates; from the screen,
// anyone who maintains some aircraft or administers inventory.
function canCreateRequest(
  s: Snapshot,
  source: RequestSource | undefined,
  admin: boolean,
) {
  if (!source)
    return admin || s.aircraft.some((a) => can(s, a.uuid, "maintenance"));
  const resolved = resolvedSource(s, source);
  if (!resolved) return false;
  return resolved.aircraftUuid
    ? can(s, resolved.aircraftUuid, "maintenance")
    : admin;
}

function filteredRequests(s: Snapshot, all: PartsRequest[], f: Filters) {
  return all
    .filter(
      (r) =>
        (!f.priority || r.priority === f.priority) &&
        (!f.aircraft || r.aircraftUuid === f.aircraft) &&
        (!f.status || requestStatus(s, r) === f.status) &&
        searchText(r).toLowerCase().includes(f.search.toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

function searchText(r: PartsRequest) {
  const lines = r.lines.map((l) => `${l.partNumber} ${l.description}`);
  return `${r.number} ${r.vendor} ${r.engineer} ${r.aircraftRegistration} ${r.sourceLabel} ${lines.join(" ")}`;
}

function requestTone(status: string) {
  if (status === "Requested") return "warn";
  if (status === "Fulfilled" || status === "Received / awaiting issue")
    return "good";
  return "neutral";
}

function recurrenceLabel(r: PartsRequest) {
  if (r.recurring) return "Recurring · ";
  return r.templateUuid ? "Recurring occurrence · " : "";
}

// Every record the user may request parts for, stock first.
function sourceOptions(s: Snapshot): SourceOption[] {
  const maintains = (aircraftUuid: string) =>
    can(s, aircraftUuid, "maintenance");
  return [
    ...(programPermission(s, "admin")
      ? [sourceOption("stock", "", "Inventory stock request")]
      : []),
    ...s.discrepancies
      .filter((r) => maintains(r.aircraftUuid))
      .map((r) =>
        sourceOption("discrepancy", r.uuid, `Discrepancy: ${r.description}`),
      ),
    ...adTaskOptions(s),
    ...s.inspections
      .filter((r) => maintains(r.aircraftUuid))
      .map((r) =>
        sourceOption(
          "inspection",
          r.uuid,
          `Inspection: ${r.reference} — ${r.description}`,
        ),
      ),
    ...workRecordOptions(s, maintains),
    ...componentOptions(s),
  ];
}

function sourceOption(
  kind: RequestSource["kind"],
  uuid: string,
  label: string,
  workOrderUuid = "",
): SourceOption {
  return { value: { kind, uuid, workOrderUuid }, label };
}

// An AD task is left out when its aircraft cannot be resolved or the user
// does not maintain it.
function adTaskOptions(s: Snapshot) {
  return (s.airworthiness ?? []).flatMap((ad) =>
    ad.tasks.flatMap((task) => {
      const resolved = resolvedSource(s, {
        kind: "airworthiness",
        uuid: task.uuid,
        workOrderUuid: "",
      });
      if (!resolved || !can(s, resolved.aircraftUuid, "maintenance")) return [];
      return [sourceOption("airworthiness", task.uuid, resolved.label)];
    }),
  );
}

function workRecordOptions(
  s: Snapshot,
  maintains: (aircraftUuid: string) => boolean,
) {
  return [
    ...(s.workOrders ?? [])
      .filter((r) => maintains(r.aircraftUuid))
      .flatMap((w) =>
        w.tasks.map((t) =>
          sourceOption(
            "workTask",
            t.uuid,
            `${w.number}: ${t.description}`,
            w.uuid,
          ),
        ),
      ),
    ...(s.taskCards ?? [])
      .filter((r) => maintains(r.aircraftUuid))
      .map((r) =>
        sourceOption("jobCard", r.uuid, `${r.cardNumber}: ${r.title}`),
      ),
  ];
}

// Components and component requirements on an aircraft the user maintains,
// or off-aircraft for an inventory administrator.
function componentOptions(s: Snapshot) {
  return (s.management ?? [])
    .filter((r) => r.kind === "componentRequirement" || r.kind === "component")
    .filter(
      (r) =>
        "aircraftUuid" in r &&
        (r.aircraftUuid
          ? can(s, r.aircraftUuid, "maintenance")
          : programPermission(s, "admin")),
    )
    .map((r) =>
      sourceOption(
        r.kind as "component" | "componentRequirement",
        r.uuid,
        componentOptionLabel(r),
      ),
    );
}

function componentOptionLabel(r: ManagedRecord) {
  if (r.kind === "component") return `${r.partNumber} S/N ${r.serial}`;
  return r.kind === "componentRequirement" ? r.description : "";
}

// A component can be sent for repair only while it is uninstalled and not
// already out; an aircraft's request takes that aircraft's components or
// unassigned ones.
function repairableComponents(s: Snapshot, aircraftUuid: string) {
  return (s.management ?? []).filter(
    (r): r is Component =>
      r.kind === "component" &&
      !r.installed &&
      !r.outForRepair &&
      (!aircraftUuid || !r.aircraftUuid || r.aircraftUuid === aircraftUuid),
  );
}

// Another part number drops the line's Aircraft Spruce mapping, which
// belonged to the old part.
function lineChange(l: RequestLine, p: Partial<RequestLine>): RequestLine {
  const changesPart =
    !("sprucePart" in p) &&
    p.partNumber !== undefined &&
    p.partNumber !== l.partNumber;
  return { ...l, ...p, ...(changesPart ? { sprucePart: undefined } : {}) };
}

// The product maps the line to Aircraft Spruce and fills only what is blank,
// plus the catalog price as the quote when there is one.
function spruceChange(
  line: RequestLine,
  product: SpruceProduct,
  cents: number | undefined,
): Partial<RequestLine> {
  return {
    sprucePart: {
      partNumber: product.partNumber,
      uom: product.uom,
      currency: product.currency,
      catalogAt: product.catalogAt,
    },
    ...(!line.partNumber ? { partNumber: product.partNumber } : {}),
    ...(!line.description ? { description: product.description } : {}),
    ...(cents !== undefined ? { quotedCents: cents } : {}),
  };
}

function vendorFields(name: string, vendor?: Vendor) {
  return {
    vendor: vendor?.name ?? name,
    vendorAddressDetails: vendor?.addressDetails,
    vendorAddress: vendor?.addressDetails
      ? formatAddress(vendor.addressDetails)
      : "",
  };
}

// One vendor per name; a vendor added while editing replaces the directory's.
function uniqueVendors(vendors: Vendor[]) {
  return [...new Map(vendors.map((v) => [vendorKey(v.name), v])).values()];
}

// An inventory administrator's new vendor is saved to the directory, with a
// change-log entry; anyone else's stays a name on this request.
async function addVendor(
  s: Snapshot,
  backend: Backend | null,
  name: string,
  onAdded: (record: Vendor) => void,
) {
  const record = newVendor(name);
  if (programPermission(s, "admin")) {
    await backend!.manage({
      action: "record.save",
      record,
      requestUuid: crypto.randomUUID(),
      reason: "Vendor created from parts request",
    });
    record.version = 1;
  }
  onAdded(record);
}

function locationName(inventory: Inventory, uuid: string) {
  return inventory.locations.find((l) => l.uuid === uuid)?.name;
}

function reservationStocks(
  inventory: Inventory,
  r: PartsRequest,
  line: RequestLine,
  operation: Reservation,
) {
  return inventory.stock.filter((x) =>
    operation === "reserve"
      ? x.partNumber === line.partNumber ||
        (line.alternateNumber && x.partNumber === line.alternateNumber)
      : r.reservations.some(
          (a) => a.lineUuid === line.uuid && a.stockUuid === x.uuid,
        ),
  );
}

function stockLotStatus(f: ReservationState, x: InventoryStock) {
  if (f.operation !== "reserve") {
    const held = f.r.reservations.find(
      (a) => a.lineUuid === f.line.uuid && a.stockUuid === x.uuid,
    );
    return `Reserved ${held?.quantity ?? 0}`;
  }
  return expiredForUse(x.expirationDate)
    ? `Expired ${x.expirationDate}`
    : `Available ${usableQuantity(x)}`;
}

async function saveRequestPdf(
  request: PartsRequest,
  s: Snapshot,
  kind: "request" | "packing",
  filename: string,
  onError: (error: string) => void,
) {
  try {
    const { requestPdf } = await import("../data/partsRequestPdf");
    (await requestPdf(request, s, kind)).save(filename);
  } catch (e) {
    onError(errorText(e));
  }
}
