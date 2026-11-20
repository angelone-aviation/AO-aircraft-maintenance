/**
 * Responsibility: Purchase orders: the orders screen, the editor, an order's
 *   detail with its documents and files, and the inspection PO button.
 * Layer: UI. React components; order rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data (store, backend type; poPdf and partsRequestPdf on demand),
 *   src/domain (model, vendors, management, addresses, programs,
 *   purchaseOrders, purchaseOrderRules, shelfLife, aircraftSpruce,
 *   costs/units),
 *   ./AircraftSpruce, ./Vendors, ./CoreReturns, ./SavedAddresses, ./ShopList,
 *   ./NumberInput, ./ui, ./design, ./FileLink, ./WorkOrderNumber, CSS.
 */
import { SpruceProductPicker, SpruceOrderProgress } from "./AircraftSpruce";
import { localDate, type Snapshot } from "../domain/model";
import { VendorEditor, VendorPicker, newVendor } from "./Vendors";
import { vendorDirectory, vendorKey } from "../domain/vendors";
import type { Location, Vendor } from "../domain/management";
import { SavedAddressPicker } from "./SavedAddresses";
import { formatAddress } from "../domain/addresses";
import {
  SPRUCE_VENDOR_NAME,
  type SpruceProduct,
} from "../domain/aircraftSpruce";
import { CENTS_PER_DOLLAR } from "../domain/costs/units";
import { useState, useEffect, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import type { Backend } from "../data/backend";
import { programPermission } from "../domain/programs";
import {
  poAttachmentRemovable,
  poStatus,
  poTotal,
  received,
  shipped,
  outstanding,
  onOrder,
  DEFAULT_CORE_DUE_DAYS,
  type PurchaseOrder,
  type PODraft,
  type POLine,
  type POCommand,
} from "../domain/purchaseOrders";
import {
  CURRENCY_CODE_LENGTH,
  CURRENCY_CODE_PATTERN,
  MAX_CORE_DUE_DAYS,
  PO_STATUSES,
  deliveryOverdue,
  draftsToSave,
  inspectionShortfalls,
} from "../domain/purchaseOrderRules";
import type { Inspection } from "../domain/model";
import { usableQuantity } from "../domain/shelfLife";
import { AsyncForm, DeleteFileButton, Modal, Field, errorText } from "./ui";
import { NumberInput } from "./NumberInput";
import {
  useStaleSave,
  type StaleSaveAttempt,
  type StaleSaveOptions,
} from "./StaleSave";
import { PO_KEEP_MINE } from "../domain/keepMineRules";
import {
  EmptyState,
  PageHeader,
  SearchField,
  StatTile,
  StatsStrip,
  Toolbar,
} from "./design";
import { NamedFileLink } from "./FileLink";
import {
  ShopLead,
  ShopPill,
  ShopSelect,
  ShopStat,
  ShopTableCard,
} from "./ShopList";
import {
  Funnel,
  Plus,
  Receipt,
  Storefront,
  Warning,
} from "@phosphor-icons/react";
import "./purchaseOrders.css";
import { CoreReturns } from "./CoreReturns";
import { WorkOrderNumber } from "./WorkOrderNumber";

const ORDER_TABLE_STYLE = { "--shop-table-min": "860px" } as CSSProperties;
// The preview tab reads the PDF through this URL, so it must outlive the load.
const PREVIEW_URL_LIFETIME_MS = 60_000;
// A component receipt takes one serial row per unit; this caps the rows.
const MAX_SERIAL_ROWS = 100;
const ATTACHMENT_TYPES = ".pdf,.jpg,.jpeg,.png,.webp";
const COMPONENT_TYPES: POLine["componentType"][] = [
  "Appliance",
  "Engine",
  "Propeller",
];
const RECEIPT_CONDITIONS: ReceiptCondition[] = [
  "new",
  "overhauled",
  "as removed",
  "core",
];
const SUBMIT_LABELS: Partial<Record<OrderAction, string>> = {
  receive: "Confirm receipt into inventory",
  ship: "Save shipment",
  issue: "Finalize PO",
};
const SERIAL_FIELD_LABELS = {
  serial: "serial number",
  hours: "time since new (hours)",
  cycles: "cycles since new",
};

type POEditorProps = {
  initial: PODraft;
  onDone: () => void;
  /** Reopens the editor on the draft as it stands, after a stale save the
   * user resolved with Use theirs; without it the editor closes. */
  onReload?: (current: PODraft) => void;
  inspection?: Inspection;
};

// How the stale-save review names and formats a draft order's fields.
const PO_STALE_SAVE: StaleSaveOptions<PODraft> = {
  label: "purchase order",
  entityUuid: (d) => d.uuid,
  specs: {
    vendor: "Vendor",
    vendorContact: "Vendor contact",
    vendorAddressDetails: "Vendor address",
    shipTo: "Deliver to",
    shippingAddress: "Shipping address",
    expectedDate: "Expected date",
    currency: "Currency",
    shippingCents: { label: "Shipping", format: formatCents },
    notes: "Notes",
    lines: {
      label: "Lines",
      item: (l, index) => `Line ${index + 1} (${l.partNumber})`,
      fields: {
        partNumber: "Part number",
        description: "Description",
        quantity: "Quantity",
        unitCents: { label: "Unit cost", format: formatCents },
        kind: "Kind",
        exchange: "Exchange",
        coreDueDays: "Core due (days)",
      },
    },
  },
  rules: PO_KEEP_MINE,
};

function formatCents(value: unknown) {
  return (Number(value) / 100).toFixed(2);
}

type PODetailProps = { po: PurchaseOrder; onEdit: () => void };
type OrderAction = Exclude<POCommand["kind"], "save" | "core">;
type ReceiveCommand = Extract<POCommand, { kind: "receive" }>;
type ReceiptCondition = ReceiveCommand["lines"][number]["condition"];
type SerialRow = { serial: string; hours: string; cycles: string };
type OrderFile = {
  uuid: string;
  name: string;
  receiptUuid?: string;
};

/**
 * The Purchase orders screen: draft, open and overdue counts, the orders
 * newest first with search and status filter, core returns, and the editor
 * and detail dialogs. Inventory administrators only; others see why.
 *
 * @returns The page. New PO needs a connection.
 */
export function PurchaseOrders() {
  const { snapshot: s, online, connected } = useWorkspace();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [edit, setEdit] = useState<PODraft>();
  const [view, setView] = useState<string>();
  const orders = s?.purchaseOrders ?? [];
  const po = orders.find((p) => p.uuid === view);
  if (!s || !programPermission(s, "admin")) return <PurchasingAccessRequired />;
  return (
    <>
      <OrdersHeader
        disabled={!online || !connected}
        onNew={() => setEdit(freshDraft())}
      />
      <OrderStats orders={orders} />
      <OrderToolbar
        search={search}
        status={status}
        onSearch={setSearch}
        onStatus={setStatus}
      />
      <OrderList
        orders={orders}
        search={search}
        status={status}
        onView={setView}
      />
      <div className="shop-card">
        <CoreReturns orders={orders} />
      </div>
      <OrderDialogs edit={edit} po={po} onEdit={setEdit} onView={setView} />
    </>
  );
}

/**
 * The "Create PO for parts" button on an inspection: drafts a line for each
 * required stock item, for the shortfall that stock on hand, issued orders
 * and this inspection's draft orders leave, then opens the editor.
 *
 * @param props.inspection - Nothing renders unless it has required parts and
 *   the user is an inventory administrator.
 * @returns The button, disabled without a connection, and the editor dialog.
 */
export function InspectionPOButton({ inspection }: { inspection: Inspection }) {
  const { snapshot: s, online, connected } = useWorkspace();
  const [draft, setDraft] = useState<PODraft>();
  if (!s || !inspection.requiredParts?.length || !programPermission(s, "admin"))
    return null;
  return (
    <>
      <button
        className="button small"
        disabled={!online || !connected}
        onClick={() => {
          const lines = inspectionLines(s, inspection);
          setDraft({ ...freshDraft(), lines });
        }}
      >
        Create PO for parts
      </button>
      {draft && (
        <Modal
          title={`Purchase parts · ${inspection.reference}`}
          wide
          onClose={() => setDraft(undefined)}
        >
          <p>
            Review quantities and vendors. Stock availability is shared and is
            not reserved. Zero quantities are excluded.
          </p>
          <POEditor
            initial={draft}
            onDone={() => setDraft(undefined)}
            inspection={inspection}
          />
        </Modal>
      )}
    </>
  );
}

/**
 * The draft order form: vendor, shipping address, delivery, currency and
 * shipping, then each line's part, stock, cost, links and exchange terms.
 * Saving needs a connection and writes one draft per vendor, or adds the
 * lines to an existing draft; a refused save shows its reason in the form.
 *
 * @param props.initial - A new draft (version 0) or a saved draft to edit.
 *   A saved draft keeps one vendor and cannot join another draft.
 * @param props.onDone - Called after the save.
 * @param props.inspection - Allows zero quantities, which the save skips.
 * @returns The form, or the vendor editor while a vendor is being added.
 */
export function POEditor({
  initial,
  onDone,
  onReload,
  inspection,
}: POEditorProps) {
  const editor = usePOEditor(initial);
  const { draft } = editor;
  const stale = useStaleSave(PO_STALE_SAVE);
  if (editor.vendorEdit) return <AddVendorStep editor={editor} />;
  return (
    <AsyncForm
      submitLabel={editor.target ? "Add to draft PO" : "Save draft PO"}
      disabled={!editor.writable}
      onSubmit={() =>
        submitDrafts(editor, { initial, onDone, onReload }, stale.run)
      }
    >
      <OrderFields editor={editor} />
      {inspection && (
        <p className="callout">
          Different vendors create separate draft POs. Review shipping charges
          on each resulting draft before issue.
        </p>
      )}
      {draft.lines.map((l, index) => (
        <LineFields
          key={l.uuid}
          editor={editor}
          line={l}
          index={index}
          initial={initial}
          inspection={inspection}
        />
      ))}
      <EditorFooter editor={editor} initial={initial} />
      {stale.dialog}
    </AsyncForm>
  );
}

// Saves the editor's drafts (one per vendor) under the editor's request id,
// through the stale-save review.
function submitDrafts(
  editor: ReturnType<typeof usePOEditor>,
  props: Omit<POEditorProps, "inspection">,
  run: (attempt: StaleSaveAttempt<PODraft>) => Promise<void>,
) {
  const drafts = draftsToSave({
    draft: editor.draft,
    initial: props.initial,
    lineVendors: editor.vendors,
    vendors: editor.vendorOptions,
    target: editor.target,
    orders: editor.s.purchaseOrders ?? [],
  });
  const save = async (saved: PODraft[]) => {
    await editor.backend!.purchaseOrder({
      kind: "save",
      requestUuid: editor.requestUuid,
      drafts: saved,
    });
    props.onDone();
  };
  return run(draftAttempt(drafts, props, save));
}

// The save as the stale-save review retries or abandons it. Only the saved
// draft being edited can be stale; new drafts for other vendors are created
// alongside it.
function draftAttempt(
  drafts: PODraft[],
  { initial, onDone, onReload }: Omit<POEditorProps, "inspection">,
  save: (drafts: PODraft[]) => Promise<void>,
): StaleSaveAttempt<PODraft> {
  return {
    draft: drafts.find((d) => d.uuid === initial.uuid),
    loaded: initial.version ? initial : undefined,
    find: (live) => live.purchaseOrders?.find((p) => p.uuid === initial.uuid),
    save: (version, merged) =>
      save(
        drafts.map((d) =>
          d.uuid === initial.uuid ? { ...(merged ?? d), version } : d,
        ),
      ),
    useTheirs: (current) =>
      current && onReload ? onReload(current) : onDone(),
  };
}

/**
 * An order's detail: vendor, destination, supplier progress, its documents
 * and next actions, lines, shipments, receipts, attachments and history.
 *
 * @param props.po - The order.
 * @param props.onEdit - Opens a draft in the editor.
 * @returns The detail. A PDF that cannot be made shows its error; actions
 *   that change the order need a connection.
 */
export function PODetail({ po, onEdit }: PODetailProps) {
  const { snapshot: s, online, connected } = useWorkspace();
  const [action, setAction] = useState<OrderAction>();
  const [pdfError, setPdfError] = useState("");
  return (
    <>
      <p>
        <strong>{po.vendor}</strong> · Revision {po.revision} · {po.currency}
      </p>

      <p className="po-pre">Deliver to: {po.shipTo}</p>
      <SpruceOrderProgress poUuid={po.uuid} />
      <OrderActions
        po={po}
        s={s!}
        writable={online && connected}
        onEdit={onEdit}
        onAction={setAction}
        onError={setPdfError}
      />
      {pdfError && (
        <p role="alert" className="error">
          {pdfError}
        </p>
      )}
      <OrderLines po={po} s={s!} />
      <OrderRecords po={po} s={s!} />
      {action && (
        <Modal
          title={`${actionTitle(action)} · ${po.number}`}
          wide
          onClose={() => setAction(undefined)}
        >
          <POAction po={po} kind={action} onDone={() => setAction(undefined)} />
        </Modal>
      )}
    </>
  );
}

function PurchasingAccessRequired() {
  return (
    <>
      <PageHeader eyebrow="PURCHASING" title="Purchase orders" />
      <EmptyState title="Inventory administrator access required">
        Purchase orders are managed by Flight Program inventory administrators.
      </EmptyState>
    </>
  );
}

function OrdersHeader({
  disabled,
  onNew,
}: {
  disabled: boolean;
  onNew: () => void;
}) {
  return (
    <PageHeader
      eyebrow="PURCHASING"
      title="Purchase"
      accent="orders"
      description="Orders to vendors, from draft to receipt: track shipments, receive parts into inventory and follow core returns."
      actions={
        <>
          <Link to="/vendors" className="button">
            <Storefront size={18} aria-hidden="true" />
            View vendors
          </Link>
          <button
            className="button primary"
            disabled={disabled}
            onClick={onNew}
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            New PO
          </button>
        </>
      }
    />
  );
}

function OrderStats({ orders }: { orders: PurchaseOrder[] }) {
  const drafts = orders.filter((p) => p.phase === "draft").length;
  const open = orders.filter(
    (p) => p.phase === "issued" && poStatus(p) !== "Received",
  ).length;
  const late = orders.filter((p) => deliveryOverdue(p, localDate())).length;
  return (
    <StatsStrip className="shop-stats">
      <StatTile label="Drafts" value={drafts} />
      <StatTile label="Open" value={open} />
      <ShopStat
        label="Delivery overdue"
        value={late}
        tone={late ? "danger" : undefined}
      />
    </StatsStrip>
  );
}

function OrderToolbar({
  search,
  status,
  onSearch,
  onStatus,
}: {
  search: string;
  status: string;
  onSearch: (search: string) => void;
  onStatus: (status: string) => void;
}) {
  return (
    <Toolbar className="shop-toolbar">
      <SearchField
        label="Search purchase orders"
        placeholder="PO, vendor or part number"
        value={search}
        onChange={onSearch}
      />
      <ShopSelect
        label="PO status"
        icon={Funnel}
        value={status}
        onChange={onStatus}
      >
        <option value="">All statuses</option>
        {PO_STATUSES.map((x) => (
          <option key={x}>{x}</option>
        ))}
      </ShopSelect>
    </Toolbar>
  );
}

type OrderListProps = {
  orders: PurchaseOrder[];
  search: string;
  status: string;
  onView: (uuid: string) => void;
};

function OrderList({ orders, search, status, onView }: OrderListProps) {
  const list = orders
    .filter((p) => matchesFilters(p, search, status))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length)
    return (
      <EmptyState title="No purchase orders">
        {orders.length
          ? "No purchase orders match the search or status."
          : "Create a PO here or from an inspection’s required parts."}
      </EmptyState>
    );
  return (
    <ShopTableCard label="Purchase orders" stack>
      <table className="shop-table" style={ORDER_TABLE_STYLE}>
        <thead>
          <tr>
            <th>PO number</th>
            <th>Vendor</th>
            <th>Status</th>
            <th>Expected</th>
            <th className="shop-num">Total</th>
            <th className="shop-num">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {list.map((p) => (
            <OrderRow key={p.uuid} po={p} onView={onView} />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

function OrderRow({
  po: p,
  onView,
}: {
  po: PurchaseOrder;
  onView: (uuid: string) => void;
}) {
  const label = poStatus(p);
  const tone = poTone(label);
  return (
    <tr>
      <td className="shop-wide">
        <ShopLead
          icon={Receipt}
          tone={tone}
          title={
            <button
              className="shop-title-button"
              onClick={() => onView(p.uuid)}
            >
              {p.number}
            </button>
          }
          sub={`${p.lines.length} line${p.lines.length === 1 ? "" : "s"} · ${p.currency}`}
        />
      </td>
      <td data-label="Vendor">{p.vendor}</td>
      <td data-label="Status">
        <ShopPill tone={tone}>{label}</ShopPill>
      </td>
      <OrderRowFigures po={p} />
    </tr>
  );
}

function OrderRowFigures({ po: p }: { po: PurchaseOrder }) {
  return (
    <>
      <td data-label="Expected">
        <span className="shop-nowrap">{p.expectedDate || "—"}</span>
        {deliveryOverdue(p, localDate()) && (
          <strong className="shop-overdue">
            <Warning size={15} weight="bold" aria-hidden="true" />
            Delivery overdue
          </strong>
        )}
      </td>
      <td className="shop-num" data-label="Total">
        {cash(poTotal(p), p.currency)}
      </td>
      <td className="shop-num" data-label="Outstanding">
        {p.lines.reduce((n, l) => n + outstanding(p, l), 0)}
      </td>
    </>
  );
}

function OrderDialogs({
  edit,
  po,
  onEdit,
  onView,
}: {
  edit?: PODraft;
  po?: PurchaseOrder;
  onEdit: (draft?: PODraft) => void;
  onView: (uuid?: string) => void;
}) {
  return (
    <>
      {edit && <EditOrderDialog edit={edit} onEdit={onEdit} />}
      {po && <ViewOrderDialog po={po} onEdit={onEdit} onView={onView} />}
    </>
  );
}

function EditOrderDialog({
  edit,
  onEdit,
}: {
  edit: PODraft;
  onEdit: (draft?: PODraft) => void;
}) {
  return (
    <Modal
      title={edit.version ? "Edit draft PO" : "New purchase order"}
      wide
      onClose={() => onEdit(undefined)}
    >
      <POEditor
        key={`${edit.uuid}:${edit.version}`}
        initial={edit}
        onDone={() => onEdit(undefined)}
        onReload={onEdit}
      />
    </Modal>
  );
}

function ViewOrderDialog({
  po,
  onEdit,
  onView,
}: {
  po: PurchaseOrder;
  onEdit: (draft?: PODraft) => void;
  onView: (uuid?: string) => void;
}) {
  return (
    <Modal
      title={`${po.number} · ${poStatus(po)}`}
      wide
      onClose={() => onView(undefined)}
    >
      <PODetail
        po={po}
        onEdit={() => {
          onView(undefined);
          onEdit(po);
        }}
      />
    </Modal>
  );
}

// The editor's state: the draft, per-line vendor overrides, the existing
// draft to add to, and vendors added while editing.
function usePOEditor(initial: PODraft) {
  const { snapshot, backend, online, connected } = useWorkspace();
  const s = snapshot!;
  const locations = (s.management ?? []).filter((r) => r.kind === "location");
  const [draft, setDraft] = useState<PODraft>(() =>
    initialDraft(initial, locations),
  );
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");
  const [requestUuid] = useState(() => crypto.randomUUID());
  const patch = (p: Partial<PODraft>) => setDraft({ ...draft, ...p });
  return {
    s,
    backend,
    writable: online && connected,
    locations,
    stocks: (s.management ?? []).filter((r) => r.kind === "stock"),
    draft,
    setDraft,
    patch,
    linePatch: (uuid: string, p: Partial<POLine>) =>
      patch(lineChange(draft, uuid, p, locations)),
    vendors,
    setVendors,
    target,
    setTarget,
    requestUuid,
    ...useVendorChoices(s, backend, setDraft, setVendors),
  };
}

type Editor = ReturnType<typeof usePOEditor>;
type DraftSetter = (update: (draft: PODraft) => PODraft) => void;
type VendorsSetter = (
  update: (vendors: Record<string, string>) => Record<string, string>,
) => void;

// The vendor directory plus vendors added here, and choosing or adding one
// for the order or for a single line.
function useVendorChoices(
  s: Snapshot,
  backend: Backend | null,
  setDraft: DraftSetter,
  setVendors: VendorsSetter,
) {
  const [addedVendors, setAddedVendors] = useState<Vendor[]>([]);
  const [vendorEdit, setVendorEdit] = useState<{
    record: Vendor;
    lineUuid?: string;
  }>();
  const selectVendor = (vendor: Vendor, lineUuid?: string) => {
    if (lineUuid) setVendors((prev) => ({ ...prev, [lineUuid]: vendor.name }));
    else setDraft((prev) => ({ ...prev, ...vendorFields(vendor) }));
  };
  const addVendor = async (name: string, quick: boolean, lineUuid?: string) => {
    const record = newVendor(name);
    if (!quick) {
      setVendorEdit({ record, lineUuid });
      return;
    }
    await backend!.manage({
      action: "record.save",
      record,
      requestUuid: crypto.randomUUID(),
      reason: "Vendor quick added from purchase order",
    });
    const saved = { ...record, version: 1 };
    setAddedVendors((prev) => [...prev, saved]);
    selectVendor(saved, lineUuid);
  };
  return {
    vendorOptions: uniqueVendors([...vendorDirectory(s), ...addedVendors]),
    vendorEdit,
    setVendorEdit,
    setAddedVendors,
    selectVendor,
    addVendor,
  };
}

function AddVendorStep({ editor }: { editor: Editor }) {
  const { vendorEdit, setVendorEdit } = editor;
  return (
    <>
      <p>Your purchase order is kept while you add this vendor.</p>
      <VendorEditor
        initial={vendorEdit!.record}
        onCancel={() => setVendorEdit(undefined)}
        onDone={(v) => {
          editor.setAddedVendors((prev) => [...prev, v]);
          editor.selectVendor(v, vendorEdit!.lineUuid);
          setVendorEdit(undefined);
        }}
      />
    </>
  );
}

function OrderFields({ editor }: { editor: Editor }) {
  const { draft, patch } = editor;
  return (
    <div className="form-grid">
      <VendorPicker
        value={draft.vendor}
        options={editor.vendorOptions}
        disabled={!editor.writable}
        onChange={(name, vendor) =>
          vendor
            ? editor.selectVendor(vendor)
            : patch({
                vendor: name,
                vendorUuid: undefined,
                vendorContact: "",
                vendorAddressDetails: undefined,
              })
        }
        onAdd={(name, quick) => editor.addVendor(name, quick)}
      />
      <SavedAddressPicker
        label="Shipping address"
        inventoryLocationName={
          editor.locations.find((l) => l.uuid === draft.lines[0]?.locationUuid)
            ?.name
        }
        value={draft.shippingAddress}
        legacy={draft.shipTo}
        onChange={(address) =>
          patch({ shippingAddress: address, shipTo: formatAddress(address) })
        }
      />
      <OrderTermsFields editor={editor} />
    </div>
  );
}

function OrderTermsFields({ editor }: { editor: Editor }) {
  const { draft, patch } = editor;
  return (
    <>
      <Field label="Expected delivery">
        <input
          type="date"
          value={draft.expectedDate}
          onChange={(e) => patch({ expectedDate: e.target.value })}
        />
      </Field>
      <Field label="Currency">
        <input
          required
          maxLength={CURRENCY_CODE_LENGTH}
          pattern={CURRENCY_CODE_PATTERN}
          value={draft.currency}
          onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label="Shipping cost">
        <NumberInput
          min="0"
          step=".01"
          value={draft.shippingCents / CENTS_PER_DOLLAR}
          onValue={(amount) => patch({ shippingCents: toCents(amount) })}
        />
      </Field>
    </>
  );
}

type LineProps = {
  editor: Editor;
  line: POLine;
  index: number;
  initial: PODraft;
  inspection?: Inspection;
};

function LineFields(props: LineProps) {
  const { editor, line: l, index, initial } = props;
  return (
    <fieldset className="po-line">
      <legend>Part {index + 1}</legend>
      <LineSupplier editor={editor} line={l} />
      <div className="form-grid">
        <LineStockFields {...props} />
        <LinePartFields {...props} />
        <LineQuantityFields {...props} />
        {!initial.version && (
          <VendorPicker
            label={`Part ${index + 1} vendor (optional override)`}
            value={editor.vendors[l.uuid] ?? ""}
            options={editor.vendorOptions}
            disabled={!editor.writable}
            onChange={(name) =>
              editor.setVendors({ ...editor.vendors, [l.uuid]: name })
            }
            onAdd={(name, quick) => editor.addVendor(name, quick, l.uuid)}
          />
        )}
        <LineWorkFields {...props} />
        {l.kind === "component" && <LineComponentFields {...props} />}
        <LineExchangeFields {...props} />
      </div>
      <LineNotes {...props} />
      <LineButtons {...props} />
    </fieldset>
  );
}

function LineSupplier({ editor, line: l }: { editor: Editor; line: POLine }) {
  return (
    <>
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
      {l.sprucePart && (
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
      )}
    </>
  );
}

function LineStockFields({ editor, line: l, index }: LineProps) {
  const set = (p: Partial<POLine>) => editor.linePatch(l.uuid, p);
  const stocks = editor.stocks.filter((x) => x.locationUuid === l.locationUuid);
  return (
    <>
      <Field label={`Part ${index + 1} inventory location`}>
        <select
          required
          value={l.locationUuid}
          onChange={(e) => set({ locationUuid: e.target.value, stockUuid: "" })}
        >
          <option value="">Select location</option>
          {editor.locations.map((x) => (
            <option key={x.uuid} value={x.uuid}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Part ${index + 1} stock item`}>
        <select
          value={l.stockUuid}
          onChange={(e) => set(stockChange(editor, e.target.value))}
        >
          <option value="">New part / component</option>
          {stocks.map((x) => (
            <option key={x.uuid} value={x.uuid}>
              {x.partNumber} · {x.description}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function LinePartFields({ editor, line: l, index }: LineProps) {
  const set = (p: Partial<POLine>) => editor.linePatch(l.uuid, p);
  return (
    <>
      <Field label={`Part ${index + 1} number`}>
        <input
          required
          readOnly={!!l.stockUuid}
          value={l.partNumber}
          onChange={(e) => set({ partNumber: e.target.value })}
        />
      </Field>
      <Field label={`Part ${index + 1} description`}>
        <input
          required
          value={l.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>
      <LineCategoryField editor={editor} line={l} index={index} />
    </>
  );
}

function LineQuantityFields({ editor, line: l, index, inspection }: LineProps) {
  const set = (p: Partial<POLine>) => editor.linePatch(l.uuid, p);
  return (
    <>
      <Field label={`Part ${index + 1} quantity`}>
        <NumberInput
          required
          min={inspection ? 0 : 1}
          step="1"
          value={l.quantity}
          onValue={(quantity) => set({ quantity })}
        />
      </Field>
      <Field label={`Part ${index + 1} unit cost`}>
        <NumberInput
          required
          min="0"
          step=".01"
          value={l.unitCents / CENTS_PER_DOLLAR}
          onValue={(amount) => set({ unitCents: toCents(amount) })}
        />
      </Field>
    </>
  );
}

function LineCategoryField({
  editor,
  line: l,
  index,
}: Pick<LineProps, "editor" | "line" | "index">) {
  return (
    <Field label={`Part ${index + 1} category`}>
      <select
        disabled={!!l.stockUuid}
        value={l.kind}
        onChange={(e) =>
          editor.linePatch(l.uuid, { kind: e.target.value as POLine["kind"] })
        }
      >
        <option value="part">Part</option>
        <option value="supply">Supply</option>
        <option value="component">Trackable Aircraft Component</option>
      </select>
    </Field>
  );
}

function LineWorkFields({ editor, line: l, index }: LineProps) {
  const set = (p: Partial<POLine>) => editor.linePatch(l.uuid, p);
  const workOrders = (editor.s.workOrders ?? []).filter(
    (w) => w.aircraftUuid === l.aircraftUuid,
  );
  return (
    <>
      <Field label={`Part ${index + 1} aircraft`}>
        <select
          value={l.aircraftUuid}
          disabled={!!l.inspectionUuid}
          onChange={(e) =>
            set({ aircraftUuid: e.target.value, workOrderUuid: "" })
          }
        >
          <option value="">General inventory</option>
          {editor.s.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`Part ${index + 1} work order`}>
        <select
          value={l.workOrderUuid}
          onChange={(e) => set({ workOrderUuid: e.target.value })}
        >
          <option value="">No work order</option>
          {workOrders.map((w) => (
            <option key={w.uuid} value={w.uuid}>
              {w.number}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function LineComponentFields({ editor, line: l, index }: LineProps) {
  const set = (p: Partial<POLine>) => editor.linePatch(l.uuid, p);
  return (
    <>
      <Field label={`Part ${index + 1} component type`}>
        <select
          value={l.componentType}
          onChange={(e) =>
            set({
              componentType: e.target.value as POLine["componentType"],
            })
          }
        >
          {COMPONENT_TYPES.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      <Field label={`Part ${index + 1} manufacturer`}>
        <input
          value={l.manufacturer}
          onChange={(e) => set({ manufacturer: e.target.value })}
        />
      </Field>
      <Field label={`Part ${index + 1} model`}>
        <input
          value={l.model}
          onChange={(e) => set({ model: e.target.value })}
        />
      </Field>
    </>
  );
}

// A repair return brings back the same component, so it is never an
// exchange (the domain refuses repair lines marked as exchanges).
function LineExchangeFields({ editor, line: l, index }: LineProps) {
  return (
    <>
      {!l.repairComponentUuid && (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!l.exchange}
            onChange={(e) =>
              editor.linePatch(l.uuid, {
                exchange: e.target.checked || undefined,
                coreDueDays: e.target.checked
                  ? (l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS)
                  : undefined,
              })
            }
          />
          Part {index + 1} is an exchange (core return due)
        </label>
      )}
      {l.exchange && (
        <Field label={`Part ${index + 1} core due (days after receipt)`}>
          <NumberInput
            required
            min="1"
            max={MAX_CORE_DUE_DAYS}
            step="1"
            value={l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS}
            onValue={(coreDueDays) => editor.linePatch(l.uuid, { coreDueDays })}
          />
        </Field>
      )}
    </>
  );
}

function LineNotes({ editor, line: l, inspection }: LineProps) {
  const { s } = editor;
  const stock = editor.stocks.find((x) => x.uuid === l.stockUuid);
  return (
    <>
      {!!l.stockUuid && (
        <p>
          On hand: {stock?.quantity ?? 0} · Available:{" "}
          {stock ? usableQuantity(stock) : 0} · On order:{" "}
          {onOrder(s, l.stockUuid)}
          {inspection
            ? ` · Required: ${inspection.requiredParts?.find((r) => r.stockUuid === l.stockUuid)?.quantity ?? 0}`
            : ""}
        </p>
      )}
      {l.inspectionUuid && (
        <p>
          Inspection:{" "}
          {s.inspections.find((i) => i.uuid === l.inspectionUuid)?.reference}
        </p>
      )}
    </>
  );
}

// Splitting copies the line for another vendor, starting it at one unit.
function LineButtons({ editor, line: l, index, initial }: LineProps) {
  const { draft, patch } = editor;
  return (
    <>
      {!initial.version && (
        <button
          type="button"
          className="button"
          onClick={() =>
            patch({
              lines: [
                ...draft.lines,
                {
                  ...l,
                  uuid: crypto.randomUUID(),
                  quantity: 1,
                  ...followingAllocation(l, 1),
                },
              ],
            })
          }
        >
          Split part {index + 1} across vendors
        </button>
      )}
      <button
        type="button"
        className="text-button"
        onClick={() =>
          patch({ lines: draft.lines.filter((x) => x.uuid !== l.uuid) })
        }
      >
        Remove part {index + 1}
      </button>
    </>
  );
}

function EditorFooter({
  editor,
  initial,
}: {
  editor: Editor;
  initial: PODraft;
}) {
  const { draft, patch } = editor;
  return (
    <>
      <button
        type="button"
        className="button"
        onClick={() => patch({ lines: [...draft.lines, freshLine()] })}
      >
        Add part
      </button>
      {!initial.version && <ExistingDraftField editor={editor} />}
      <Field label="PO notes">
        <textarea
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </Field>
      <p>Total: {cash(poTotal(draft), draft.currency)}</p>
    </>
  );
}

// A new order's lines may join a draft already open with the same vendor.
function ExistingDraftField({ editor }: { editor: Editor }) {
  return (
    <Field label="Add to existing draft PO">
      <select
        value={editor.target}
        onChange={(e) => editor.setTarget(e.target.value)}
      >
        <option value="">Create new vendor PO(s)</option>
        {(editor.s.purchaseOrders ?? [])
          .filter((p) => p.phase === "draft")
          .map((p) => (
            <option key={p.uuid} value={p.uuid}>
              {p.number} · {p.vendor}
            </option>
          ))}
      </select>
    </Field>
  );
}

type OrderActionsProps = {
  po: PurchaseOrder;
  s: Snapshot;
  writable: boolean;
  onEdit: () => void;
  onAction: (action: OrderAction) => void;
  onError: (error: string) => void;
};

function OrderActions(props: OrderActionsProps) {
  const { po, s, writable, onAction, onError } = props;
  return (
    <div className="management-actions">
      <button
        className="button"
        onClick={() => void printOrder(po, s, false, onError)}
      >
        Print PO
      </button>
      <button
        className="button"
        onClick={() => void printOrder(po, s, true, onError)}
      >
        Save PO PDF
      </button>
      {repairRequests(po, s).map((r) => (
        <RepairDocuments key={r.uuid} request={r} s={s} onError={onError} />
      ))}
      {po.phase === "draft" && <DraftActions {...props} />}
      {po.phase === "issued" && <IssuedActions {...props} />}
      {["draft", "issued"].includes(po.phase) && (
        <button
          className="button"
          disabled={!writable}
          onClick={() => onAction("cancel")}
        >
          {po.receipts.length ? "Cancel remaining and close" : "Cancel PO"}
        </button>
      )}
    </div>
  );
}

type PartsRequest = NonNullable<Snapshot["partsRequests"]>[number];

function RepairDocuments({
  request: r,
  s,
  onError,
}: {
  request: PartsRequest;
  s: Snapshot;
  onError: (error: string) => void;
}) {
  return (
    <span>
      <button
        type="button"
        className="button"
        onClick={() => saveRequestPdf(r, s, "request", "repair", onError)}
      >
        Repair order / tag {r.number}
      </button>
      <button
        type="button"
        className="button"
        onClick={() => saveRequestPdf(r, s, "packing", "packing", onError)}
      >
        Packing slip {r.number}
      </button>
    </span>
  );
}

function DraftActions({ writable, onEdit, onAction }: OrderActionsProps) {
  return (
    <>
      <button className="button" disabled={!writable} onClick={onEdit}>
        Edit draft
      </button>
      <button
        className="button primary"
        disabled={!writable}
        onClick={() => onAction("issue")}
      >
        Issue PO
      </button>
    </>
  );
}

// A PO can be revised only before anything has shipped or arrived.
function IssuedActions({ po, writable, onAction }: OrderActionsProps) {
  const open = po.lines.some((l) => outstanding(po, l) > 0);
  return (
    <>
      <button
        className="button"
        disabled={!writable || !open}
        onClick={() => onAction("ship")}
      >
        Record shipment
      </button>
      <button
        className="button primary"
        disabled={!writable || !open}
        onClick={() => onAction("receive")}
      >
        {po.lines.some((l) => l.repairComponentUuid)
          ? "Receive repair return"
          : "Receive parts"}
      </button>
      <button
        className="button"
        disabled={!writable || open}
        onClick={() => onAction("close")}
      >
        Close PO
      </button>
      {!po.shipments.length && !po.receipts.length && (
        <button
          className="button"
          disabled={!writable}
          onClick={() => onAction("revise")}
        >
          Revise PO
        </button>
      )}
    </>
  );
}

function OrderLines({ po, s }: { po: PurchaseOrder; s: Snapshot }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th>Destination / linked work</th>
            <th>Ordered</th>
            <th>Shipped</th>
            <th>Received</th>
            <th>Cancelled</th>
            <th>Unit cost</th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l) => (
            <tr key={l.uuid}>
              <OrderLinePart line={l} s={s} />
              <OrderLineDestination line={l} s={s} />
              <td>{l.quantity}</td>
              <td>{shipped(po, l)}</td>
              <td>{received(po, l)}</td>
              <td>{l.cancelled}</td>
              <td>{cash(l.unitCents, po.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderLinePart({ line: l, s }: { line: POLine; s: Snapshot }) {
  return (
    <td>
      {l.partNumber}
      <small className="block">{l.description}</small>
      {l.exchange && (
        <small className="block">
          Exchange · core due {l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS} days
          after receipt
        </small>
      )}
      {(l.requestAllocations ?? []).map((a) => (
        <small className="block" key={`${a.requestUuid}-${a.lineUuid}`}>
          {s.partsRequests?.find((r) => r.uuid === a.requestUuid)?.number ??
            a.requestUuid}{" "}
          · Allocated {a.quantity}
        </small>
      ))}
    </td>
  );
}

function OrderLineDestination({ line: l, s }: { line: POLine; s: Snapshot }) {
  const location = s.management?.find(
    (r) => r.uuid === l.locationUuid && r.kind === "location",
  );
  return (
    <td>
      {location?.kind === "location" ? location.name : l.locationUuid}
      <small className="block">
        {s.aircraft.find((a) => a.uuid === l.aircraftUuid)?.registration}{" "}
        {s.inspections.find((i) => i.uuid === l.inspectionUuid)?.reference}{" "}
        {l.workOrderUuid && <WorkOrderNumber uuid={l.workOrderUuid} />}
      </small>
    </td>
  );
}

function OrderRecords({ po, s }: { po: PurchaseOrder; s: Snapshot }) {
  return (
    <>
      <p>
        Shipping: {cash(po.shippingCents, po.currency)} · Total ordered:{" "}
        <strong>{cash(poTotal(po), po.currency)}</strong>
      </p>
      <p className="po-pre">{po.notes}</p>
      {!!po.shipments.length && <Shipments po={po} />}
      {!!po.receipts.length && <Receipts po={po} />}
      <POFiles po={po} />
      <OrderHistory po={po} s={s} />
    </>
  );
}

function Shipments({ po }: { po: PurchaseOrder }) {
  return (
    <section>
      <h3>Shipments</h3>
      {po.shipments.map((sh) => (
        <p key={sh.uuid}>
          {sh.date} · {sh.carrier || "Carrier not recorded"} · Tracking:{" "}
          {sh.tracking || "—"} ·{" "}
          {sh.lines
            .map(
              (l) =>
                `${po.lines.find((x) => x.uuid === l.lineUuid)?.partNumber}: ${l.quantity}`,
            )
            .join(", ")}
        </p>
      ))}
    </section>
  );
}

function Receipts({ po }: { po: PurchaseOrder }) {
  return (
    <section>
      <h3>Receipts</h3>
      {po.receipts.map((r) => (
        <div key={r.uuid}>
          <p>
            {r.date} · Invoice {r.invoice || "—"} · {r.notes}
          </p>
          {r.lines.map((l) => (
            <ReceiptLine key={l.lineUuid} po={po} line={l} />
          ))}
        </div>
      ))}
    </section>
  );
}

function ReceiptLine({
  po,
  line: l,
}: {
  po: PurchaseOrder;
  line: PurchaseOrder["receipts"][number]["lines"][number];
}) {
  return (
    <p>
      {po.lines.find((x) => x.uuid === l.lineUuid)?.partNumber}: {l.quantity} ·{" "}
      {l.condition} {l.serials.map((x) => x.serial).join(", ")}
      {l.expirationDate ? ` · Expires ${l.expirationDate}` : ""} ·{" "}
      <Link
        to="/inventory"
        search={{ item: l.itemUuids[0], program: po.programUuid }}
      >
        View inventory
      </Link>
    </p>
  );
}

function OrderHistory({ po, s }: { po: PurchaseOrder; s: Snapshot }) {
  return (
    <details>
      <summary>PO history ({po.history.length})</summary>
      {po.history.map((h, i) => (
        <div key={i}>
          <p>
            {new Date(h.at).toLocaleString()} · {h.action} ·{" "}
            {s.members.find((m) => m.id === h.actorId)?.name ?? h.actorId}{" "}
            {h.reason}
          </p>
          {h.action === "Draft saved" && (
            <SavedRevision po={po} detail={h.detail} />
          )}
        </div>
      ))}
    </details>
  );
}

// A "Draft saved" entry's detail holds the save command's drafts; the
// order's own draft is the revision it saved.
function SavedRevision({ po, detail }: { po: PurchaseOrder; detail: string }) {
  return (
    <details>
      <summary>Saved order revision</summary>
      {(JSON.parse(detail).drafts as PODraft[])
        .filter((d) => d.uuid === po.uuid)
        .map((d) => (
          <div key={d.uuid}>
            <p>
              {d.vendor} · Deliver to: {d.shipTo} · Expected:{" "}
              {d.expectedDate || "Not specified"}
            </p>
            <ul>
              {d.lines.map((l) => (
                <li key={l.uuid}>
                  {l.partNumber} · {l.description} · Qty {l.quantity} ·{" "}
                  {cash(l.unitCents, d.currency)} each
                </li>
              ))}
            </ul>
            <p>
              Shipping {cash(d.shippingCents, d.currency)} · Total{" "}
              {cash(poTotal(d), d.currency)}
            </p>
            <p>{d.notes}</p>
          </div>
        ))}
    </details>
  );
}

type POActionProps = {
  po: PurchaseOrder;
  kind: OrderAction;
  onDone: () => void;
};

function POAction({ po, kind, onDone }: POActionProps) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [requestUuid] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(localDate());
  const [reason, setReason] = useState("");
  const delivery = useDelivery();
  return (
    <AsyncForm
      submitLabel={SUBMIT_LABELS[kind] ?? "Confirm"}
      disabled={!online || !connected}
      onSubmit={async () => {
        const form = { po, kind, requestUuid, date, reason, delivery };
        await backend!.purchaseOrder(actionCommand(form));
        onDone();
      }}
    >
      <ActionNotices po={po} kind={kind} />
      {(kind === "ship" || kind === "receive") && (
        <DeliveryFields
          po={po}
          s={s}
          kind={kind}
          date={date}
          onDate={setDate}
          delivery={delivery}
        />
      )}
      <Field label={kind === "receive" ? "Receipt notes" : "Reason / notes"}>
        <textarea
          required={kind === "cancel" || kind === "revise"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </AsyncForm>
  );
}

// Per-line shipment and receipt entries, keyed by order line uuid.
function useDelivery() {
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [invoice, setInvoice] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [conditions, setConditions] = useState<
    Record<string, ReceiptCondition>
  >({});
  const [serials, setSerials] = useState<Record<string, SerialRow[]>>({});
  const [expirations, setExpirations] = useState<Record<string, string>>({});
  return {
    carrier,
    setCarrier,
    tracking,
    setTracking,
    invoice,
    setInvoice,
    quantities,
    setQuantities,
    conditions,
    setConditions,
    serials,
    setSerials,
    expirations,
    setExpirations,
  };
}

type Delivery = ReturnType<typeof useDelivery>;
type DeliveryKind = "ship" | "receive";

function ActionNotices({ po, kind }: { po: PurchaseOrder; kind: OrderAction }) {
  return (
    <>
      {kind === "issue" && (
        <p>
          Finalize this draft and mark its parts as on order in Angel One. This
          does not send the PO or place an order with {po.vendor}. Place the
          order with the vendor separately, using this PO number. Inventory
          increases only after you confirm receipt.
        </p>
      )}
      {kind === "issue" &&
        po.shippingAddress &&
        !po.shippingAddress.confirmed && (
          <p role="alert">
            Before finalizing: close this dialog, edit the draft, choose Review
            selected address, save the address, and save the draft.
          </p>
        )}
      {kind === "close" && (
        <p>
          Close this completed order. Its receipts and history remain available.
        </p>
      )}
      {kind === "cancel" && (
        <p>
          Cancel all unreceived quantities. Quantities already received stay in
          inventory.
        </p>
      )}
    </>
  );
}

type DeliveryFieldsProps = {
  po: PurchaseOrder;
  s: Snapshot | null;
  kind: DeliveryKind;
  date: string;
  onDate: (date: string) => void;
  delivery: Delivery;
};

function DeliveryFields(props: DeliveryFieldsProps) {
  const { po, s, kind, date, onDate, delivery } = props;
  return (
    <>
      <div className="form-grid">
        <Field label={kind === "ship" ? "Shipment date" : "Receipt date"}>
          <input
            type="date"
            required
            max={localDate()}
            value={date}
            onChange={(e) => onDate(e.target.value)}
          />
        </Field>
        <DeliveryReferenceFields kind={kind} delivery={delivery} />
      </div>
      {po.lines.map((l) => (
        <DeliveryLine
          key={l.uuid}
          po={po}
          s={s}
          line={l}
          kind={kind}
          delivery={delivery}
        />
      ))}
    </>
  );
}

function DeliveryReferenceFields({
  kind,
  delivery: d,
}: {
  kind: DeliveryKind;
  delivery: Delivery;
}) {
  if (kind !== "ship")
    return (
      <Field label="Invoice number">
        <input
          value={d.invoice}
          onChange={(e) => d.setInvoice(e.target.value)}
        />
      </Field>
    );
  return (
    <>
      <Field label="Carrier">
        <input
          value={d.carrier}
          onChange={(e) => d.setCarrier(e.target.value)}
        />
      </Field>
      <Field label="Tracking number">
        <input
          value={d.tracking}
          onChange={(e) => d.setTracking(e.target.value)}
        />
      </Field>
    </>
  );
}

type DeliveryLineProps = {
  po: PurchaseOrder;
  s: Snapshot | null;
  line: POLine;
  kind: DeliveryKind;
  delivery: Delivery;
};

function DeliveryLine({
  po,
  s,
  line: l,
  kind,
  delivery: d,
}: DeliveryLineProps) {
  const max = deliverable(po, l, kind);
  if (max <= 0) return null;
  return (
    <fieldset className="po-line">
      <legend>
        {l.partNumber} · Outstanding {max}
        {l.repairComponentUuid ? " · Existing component repair / return" : ""}
      </legend>
      <Field
        label={`${l.partNumber} ${kind === "ship" ? "quantity shipped" : "quantity received"}`}
      >
        <NumberInput
          min="0"
          max={Math.min(max, l.kind === "component" ? MAX_SERIAL_ROWS : max)}
          step="1"
          value={d.quantities[l.uuid] ?? 0}
          onValue={(quantity) => setQuantity(d, s, l, kind, quantity)}
        />
      </Field>
      {kind === "receive" && (d.quantities[l.uuid] ?? 0) > 0 && (
        <ReceiptFields line={l} delivery={d} />
      )}
    </fieldset>
  );
}

// A repair return keeps the component's own record, so it takes no
// expiration date.
function ReceiptFields({ line: l, delivery: d }: ReceiptFieldProps) {
  return (
    <>
      <Field label={`${l.partNumber} received condition`}>
        <select
          value={d.conditions[l.uuid] ?? "new"}
          onChange={(e) =>
            d.setConditions({
              ...d.conditions,
              [l.uuid]: e.target.value as ReceiptCondition,
            })
          }
        >
          {RECEIPT_CONDITIONS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      {!l.repairComponentUuid && <ExpirationField line={l} delivery={d} />}
      <ReceiptNotes line={l} />
      {(d.serials[l.uuid] ?? []).map((serial, index) => (
        <SerialFields
          key={index}
          line={l}
          serial={serial}
          index={index}
          delivery={d}
        />
      ))}
    </>
  );
}

type ReceiptFieldProps = { line: POLine; delivery: Delivery };

function ExpirationField({ line: l, delivery: d }: ReceiptFieldProps) {
  return (
    <Field
      label={`${l.partNumber} expiration date`}
      hint="Optional shelf-life limit. A different date is stored as a separate stock lot."
    >
      <input
        type="date"
        value={d.expirations[l.uuid] ?? ""}
        onChange={(e) =>
          d.setExpirations({ ...d.expirations, [l.uuid]: e.target.value })
        }
      />
    </Field>
  );
}

function ReceiptNotes({ line: l }: { line: POLine }) {
  return (
    <>
      {l.exchange && (
        <p>
          Exchange unit: a core return will be due{" "}
          {l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS} days after this receipt.
        </p>
      )}
      {l.kind === "component" && (
        <p>
          Enter verified total time and cycles for each serial number.
          Components are received into inventory, not installed on an aircraft.
        </p>
      )}
    </>
  );
}

// A repair return's serial is the repaired component's, so it is read-only.
function SerialFields({
  line: l,
  serial,
  index,
  delivery: d,
}: ReceiptFieldProps & { serial: SerialRow; index: number }) {
  return (
    <div className="form-grid">
      {(["serial", "hours", "cycles"] as const).map((field) => (
        <Field
          key={field}
          label={`${l.partNumber} item ${index + 1} ${SERIAL_FIELD_LABELS[field]}`}
        >
          <input
            required
            type={field === "serial" ? "text" : "number"}
            min="0"
            step={field === "hours" ? "any" : "1"}
            readOnly={field === "serial" && !!l.repairComponentUuid}
            value={serial[field]}
            onChange={(e) =>
              d.setSerials({
                ...d.serials,
                [l.uuid]: d.serials[l.uuid].map((x, i) =>
                  i === index ? { ...x, [field]: e.target.value } : x,
                ),
              })
            }
          />
        </Field>
      ))}
    </div>
  );
}

function POFiles({ po }: { po: PurchaseOrder }) {
  const { online, connected } = useWorkspace();
  const files = useOrderFiles(po);
  const writable = online && connected;
  return (
    <section>
      <h3>Attachments</h3>
      <p>
        Attach invoices, packing slips, photos, or 8130 documents. Receipt
        attachments are also linked to the received inventory items.
      </p>
      <Field label="Attach files to">
        <select
          value={files.receipt}
          onChange={(e) => files.setReceipt(e.target.value)}
        >
          <option value="">Purchase order</option>
          {po.receipts.map((r, i) => (
            <option key={r.uuid} value={r.uuid}>
              Receipt {i + 1} · {r.date} · {r.invoice}
            </option>
          ))}
        </select>
      </Field>
      <Field label="PO attachment">
        <input
          type="file"
          accept={ATTACHMENT_TYPES}
          disabled={!writable || files.busy}
          onChange={files.upload}
        />
      </Field>
      <FileList po={po} files={files} removable={writable} />
    </section>
  );
}

function FileList({
  po,
  files,
  removable,
}: {
  po: PurchaseOrder;
  files: OrderFiles;
  removable: boolean;
}) {
  return (
    <>
      {files.busy && <p role="status">Uploading…</p>}
      {files.error && (
        <p role="alert" className="error">
          {files.error}
        </p>
      )}
      <ul>
        {files.files.map((f) => (
          <li key={f.uuid}>
            <NamedFileLink
              file={{ kind: "poFile", id: f.uuid }}
              name={f.name}
            />
            {f.receiptUuid ? " · Receipt attachment" : ""}{" "}
            {poAttachmentRemovable(po) && removable && (
              <DeleteFileButton
                name={f.name}
                onDelete={() => files.remove(f.uuid)}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// The order's attachments, reloaded after each upload or removal.
function useOrderFiles(po: PurchaseOrder) {
  const { backend } = useWorkspace();
  const [files, setFiles] = useState<OrderFile[]>([]);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(
    () => loadFiles(backend, po.uuid, setFiles, setError),
    [backend, po.uuid, refresh],
  );
  async function upload(e: { target: HTMLInputElement }) {
    const file = e.target.files?.[0];
    // Cleared at once so choosing the same file again uploads it again.
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await backend!.attachPOFile(po.uuid, receipt || undefined, file);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(uuid: string) {
    await backend!.removePOFile(uuid);
    setRefresh((n) => n + 1);
  }
  return { files, error, receipt, setReceipt, busy, upload, remove };
}

type OrderFiles = ReturnType<typeof useOrderFiles>;

// A reply that arrives after the order changes or closes is dropped.
function loadFiles(
  backend: Backend | null,
  uuid: string,
  onFiles: (files: OrderFile[]) => void,
  onError: (error: string) => void,
) {
  let cancelled = false;
  backend
    ?.poFiles(uuid)
    .then((f) => {
      if (!cancelled) onFiles(f);
    })
    .catch((e) => {
      if (!cancelled) onError(errorText(e));
    });
  return () => {
    cancelled = true;
  };
}

function freshLine(): POLine {
  return {
    uuid: crypto.randomUUID(),
    stockUuid: "",
    locationUuid: "",
    partNumber: "",
    description: "",
    quantity: 1,
    unitCents: 0,
    kind: "part",
    componentType: "Appliance",
    manufacturer: "",
    model: "",
    inspectionUuid: "",
    aircraftUuid: "",
    workOrderUuid: "",
    cancelled: 0,
  };
}

function freshDraft(): PODraft {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    vendor: "",
    vendorContact: "",
    shipTo: "",
    expectedDate: "",
    currency: "USD",
    shippingCents: 0,
    notes: "",
    lines: [freshLine()],
  };
}

function cash(cents: number, currency: string) {
  return `${currency} ${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;
}

function toCents(amount: number) {
  return Math.round(amount * CENTS_PER_DOLLAR);
}

function poTone(status: string) {
  if (status === "Draft") return "warn";
  if (status === "Received" || status === "Closed") return "good";
  return "neutral";
}

function matchesFilters(p: PurchaseOrder, search: string, status: string) {
  const text = `${p.number} ${p.vendor} ${p.lines.map((l) => l.partNumber).join(" ")}`;
  return (
    (!status || poStatus(p) === status) &&
    text.toLowerCase().includes(search.toLowerCase())
  );
}

function inspectionLines(s: Snapshot, inspection: Inspection): POLine[] {
  return inspectionShortfalls(s, inspection).map(({ stock, quantity }) => ({
    ...freshLine(),
    stockUuid: stock.uuid,
    locationUuid: stock.locationUuid,
    partNumber: stock.partNumber,
    description: stock.description,
    kind: stock.category,
    quantity,
    unitCents: toCents(stock.cost ?? 0),
    inspectionUuid: inspection.uuid,
    aircraftUuid: inspection.aircraftUuid,
  }));
}

function locationAddress(locations: Location[], uuid: string) {
  return locations.find((location) => location.uuid === uuid)?.address ?? "";
}

// A draft without a ship-to ships to its first line's inventory location.
function initialDraft(initial: PODraft, locations: Location[]): PODraft {
  const blank = !initial.shipTo.trim();
  const first = initial.lines[0]?.locationUuid;
  return {
    ...initial,
    shippingAddress:
      initial.shippingAddress ??
      (blank
        ? locations.find((l) => l.uuid === first)?.addressDetails
        : undefined),
    shipTo: blank ? locationAddress(locations, first ?? "") : initial.shipTo,
  };
}

// Another part or stock item drops the line's Aircraft Spruce mapping, which
// belonged to the old part.
function lineChange(
  draft: PODraft,
  uuid: string,
  change: Partial<POLine>,
  locations: Location[],
): Partial<PODraft> {
  const previous = draft.lines.find((line) => line.uuid === uuid);
  const p = changesPart(change, previous)
    ? { ...change, sprucePart: undefined }
    : change;
  return {
    ...shipToFromLocation(draft, uuid, p, previous, locations),
    lines: draft.lines.map((l) =>
      l.uuid === uuid
        ? {
            ...l,
            ...p,
            ...(p.quantity !== undefined
              ? followingAllocation(l, p.quantity)
              : {}),
          }
        : l,
    ),
  };
}

function changesPart(change: Partial<POLine>, previous?: POLine) {
  if ("sprucePart" in change) return false;
  return (
    (change.partNumber !== undefined &&
      change.partNumber !== previous?.partNumber) ||
    (change.stockUuid !== undefined && change.stockUuid !== previous?.stockUuid)
  );
}

// A location fills the ship-to while it is blank, or while it is still the
// first line's previous location.
function shipToFromLocation(
  draft: PODraft,
  uuid: string,
  p: Partial<POLine>,
  previous: POLine | undefined,
  locations: Location[],
): Partial<PODraft> {
  if (p.locationUuid === undefined) return {};
  const followsFirstLine =
    draft.lines[0]?.uuid === uuid &&
    draft.shipTo === locationAddress(locations, previous?.locationUuid ?? "");
  if (draft.shipTo.trim() && !followsFirstLine) return {};
  return {
    shipTo: locationAddress(locations, p.locationUuid),
    shippingAddress: locations.find((l) => l.uuid === p.locationUuid)
      ?.addressDetails,
  };
}

// A line drawn from a single parts request carries its quantity to it.
function followingAllocation(line: POLine, quantity: number) {
  return line.requestAllocations?.length === 1
    ? { requestAllocations: [{ ...line.requestAllocations[0], quantity }] }
    : {};
}

function stockChange(editor: Editor, stockUuid: string): Partial<POLine> {
  const st = editor.stocks.find((x) => x.uuid === stockUuid);
  if (!st) return { stockUuid: "" };
  return {
    stockUuid: st.uuid,
    partNumber: st.partNumber,
    description: st.description,
    kind: st.category,
    unitCents: toCents(st.cost ?? 0),
  };
}

// The product maps the line to Aircraft Spruce and fills only what is blank,
// plus the catalog price when there is one.
function spruceChange(
  line: POLine,
  product: SpruceProduct,
  cents: number | undefined,
): Partial<POLine> {
  return {
    sprucePart: {
      partNumber: product.partNumber,
      uom: product.uom,
      currency: product.currency,
      catalogAt: product.catalogAt,
    },
    ...(!line.partNumber ? { partNumber: product.partNumber } : {}),
    ...(!line.description ? { description: product.description } : {}),
    ...(cents !== undefined ? { unitCents: cents } : {}),
  };
}

function vendorFields(vendor: Vendor) {
  return {
    vendor: vendor.name,
    vendorUuid: vendor.uuid || undefined,
    vendorContact: vendor.addressDetails
      ? formatAddress(vendor.addressDetails)
      : "",
    vendorAddressDetails: vendor.addressDetails,
  };
}

// One vendor per name; a vendor added while editing replaces the directory's.
function uniqueVendors(vendors: Vendor[]) {
  return [...new Map(vendors.map((v) => [vendorKey(v.name), v])).values()];
}

function actionTitle(action: OrderAction) {
  if (action === "receive") return "Receive parts";
  if (action === "ship") return "Record shipment";
  return action;
}

function repairRequests(po: PurchaseOrder, s: Snapshot | undefined) {
  return (s?.partsRequests ?? []).filter(
    (r) =>
      r.mode === "repair" &&
      po.lines.some((l) =>
        l.requestAllocations?.some((a) => a.requestUuid === r.uuid),
      ),
  );
}

// The preview window opens before the PDF module loads: browsers allow a
// popup only while handling the click. It gets no handle on this page.
async function printOrder(
  po: PurchaseOrder,
  s: Snapshot,
  download: boolean,
  onError: (error: string) => void,
) {
  const preview = download ? null : window.open("", "_blank");
  if (preview) preview.opener = null;
  try {
    onError("");
    const { poPdf } = await import("../data/poPdf");
    const doc = await poPdf(po, s);
    if (download) doc.save(`${po.number}.pdf`);
    else showPreview(preview, doc.output("blob"));
  } catch (e) {
    preview?.close();
    onError(errorText(e));
  }
}

function showPreview(preview: Window | null, pdf: Blob) {
  const url = URL.createObjectURL(pdf);
  if (!preview)
    throw Error("Allow the PDF preview window, or use Save PO PDF.");
  preview.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), PREVIEW_URL_LIFETIME_MS);
}

async function saveRequestPdf(
  request: PartsRequest,
  s: Snapshot,
  kind: "request" | "packing",
  suffix: string,
  onError: (error: string) => void,
) {
  try {
    const { requestPdf } = await import("../data/partsRequestPdf");
    (await requestPdf(request, s, kind)).save(
      `${request.number}-${suffix}.pdf`,
    );
  } catch (e) {
    onError(errorText(e));
  }
}

function actionCommand({
  po,
  kind,
  requestUuid,
  date,
  reason,
  delivery: d,
}: {
  po: PurchaseOrder;
  kind: OrderAction;
  requestUuid: string;
  date: string;
  reason: string;
  delivery: Delivery;
}): POCommand {
  const order = { requestUuid, uuid: po.uuid, version: po.version };
  if (kind !== "ship" && kind !== "receive") return { kind, ...order, reason };
  const lines = deliveryLines(po, d);
  if (!lines.length) throw Error("Enter a quantity for at least one line.");
  if (kind === "receive")
    return { kind, ...order, date, invoice: d.invoice, notes: reason, lines };
  return {
    kind,
    ...order,
    date,
    carrier: d.carrier,
    tracking: d.tracking,
    lines: lines.map(({ lineUuid, quantity }) => ({ lineUuid, quantity })),
  };
}

function deliveryLines(po: PurchaseOrder, d: Delivery) {
  return po.lines
    .filter((l) => (d.quantities[l.uuid] ?? 0) > 0)
    .map((l) => ({
      lineUuid: l.uuid,
      quantity: d.quantities[l.uuid],
      condition: d.conditions[l.uuid] ?? "new",
      expirationDate: d.expirations[l.uuid] || undefined,
      serials: (d.serials[l.uuid] ?? []).map((x) => ({
        serial: x.serial,
        hours: Number(x.hours),
        cycles: Number(x.cycles),
      })),
    }));
}

// A unit already received cannot ship again, even without a shipment record.
function deliverable(po: PurchaseOrder, l: POLine, kind: DeliveryKind) {
  if (kind !== "ship") return outstanding(po, l);
  return l.quantity - l.cancelled - Math.max(shipped(po, l), received(po, l));
}

function setQuantity(
  d: Delivery,
  s: Snapshot | null,
  l: POLine,
  kind: DeliveryKind,
  quantity: number,
) {
  d.setQuantities({ ...d.quantities, [l.uuid]: quantity });
  if (l.kind === "component" && kind === "receive")
    d.setSerials({
      ...d.serials,
      [l.uuid]: serialRows(d.serials[l.uuid], quantity, repairSerial(s, l)),
    });
}

// One row per unit received, keeping rows already filled in.
function serialRows(
  rows: SerialRow[] | undefined,
  quantity: number,
  serial: string,
) {
  return Array.from(
    { length: Math.max(0, Math.min(quantity, MAX_SERIAL_ROWS)) },
    (_, i) => rows?.[i] ?? { serial, hours: "", cycles: "" },
  );
}

function repairSerial(s: Snapshot | null, l: POLine) {
  const c = s?.management?.find(
    (c) => c.kind === "component" && c.uuid === l.repairComponentUuid,
  );
  return c?.kind === "component" ? c.serial : "";
}
