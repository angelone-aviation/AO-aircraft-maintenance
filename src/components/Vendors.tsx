/**
 * Responsibility: The vendor directory screen, the vendor editor, and the
 *   vendor picker used on requests and orders.
 * Layer: UI. React components; vendors save through the workspace backend.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/domain (management, programs, vendors),
 *   ./AddressFields, ./ShopList, ./VendorOrders, ./design, ./ui.
 */
import { useId, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { vendorSchema, type Vendor } from "../domain/management";
import { vendorDirectory, vendorKey } from "../domain/vendors";
import { programPermission } from "../domain/programs";
import type { Snapshot } from "../domain/model";
import { AddressFields } from "./AddressFields";
import { AsyncForm, Field, errorText } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  Toolbar,
} from "./design";
import { ShopLead, ShopTableCard } from "./ShopList";
import { VendorOrders } from "./VendorOrders";
import { ArrowLeft, GearSix, Plus, Storefront } from "@phosphor-icons/react";

const DETAIL_FIELDS = [
  ["website", "Website", "url"],
  ["accountNumber", "Account number", undefined],
  ["paymentTerms", "Payment terms", undefined],
] as const;

type EditorProps = {
  initial: Vendor;
  onDone: (vendor: Vendor) => void;
  onCancel: () => void;
};
type PickerProps = {
  label?: string;
  value: string;
  options: Vendor[];
  onChange: (name: string, vendor?: Vendor) => void;
  onAdd: (name: string, quick: boolean) => Promise<void>;
  disabled?: boolean;
  nameOnly?: boolean;
  customLabel?: string;
};
type PromptProps = Pick<PickerProps, "nameOnly" | "customLabel"> & {
  name: string;
  disabled: boolean;
  onAdd: (quick: boolean) => Promise<void>;
};
type ListProps = {
  s: Snapshot;
  disabled: boolean;
  onEdit: (vendor: Vendor) => void;
};

/**
 * A new, unsaved vendor record (version 0).
 *
 * @param name - The vendor's name; "New vendor" when blank.
 * @returns The record, with a new uuid.
 */
export function newVendor(name = ""): Vendor {
  return vendorSchema.parse({
    kind: "vendor",
    uuid: crypto.randomUUID(),
    version: 0,
    name: name || "New vendor",
  });
}

/**
 * The form that adds or edits a vendor: name, address, website, account
 * number, payment terms and notes. Saving needs a connection and writes a
 * change-log entry ("Vendor added" or "Vendor details updated").
 *
 * @param props.initial - The vendor; version 0 adds a new one.
 * @param props.onDone - Receives the saved record, its version advanced.
 * @param props.onCancel - Called by the form's Close button.
 * @returns The form.
 */
export function VendorEditor({ initial, onDone, onCancel }: EditorProps) {
  const { backend, online, connected } = useWorkspace();
  const [draft, setDraft] = useState(initial);
  const [requestUuid] = useState(() => crypto.randomUUID());
  const save = async () => {
    const record = vendorSchema.parse(draft);
    await backend!.manage({
      action: "record.save",
      record,
      requestUuid,
      reason: initial.version ? "Vendor details updated" : "Vendor added",
    });
    onDone({ ...record, version: record.version + 1 });
  };
  return (
    <section>
      <h2>{initial.version ? "Edit vendor" : "Add vendor"}</h2>
      <AsyncForm
        submitLabel="Save vendor"
        onClose={onCancel}
        disabled={!online || !connected}
        onSubmit={save}
      >
        <VendorFields draft={draft} onChange={setDraft} />
      </AsyncForm>
    </section>
  );
}

/**
 * The Vendors screen: the program's vendors with their contact details and
 * order counts, with search, add and edit.
 *
 * @returns The screen; program administrators only, others see a notice.
 *   Adding and editing need a connection.
 */
export function Vendors() {
  const { snapshot: s, online, connected } = useWorkspace();
  const [search, setSearch] = useState("");
  const [edit, setEdit] = useState<Vendor>();
  if (!s || !programPermission(s, "admin"))
    return (
      <>
        {vendorsHeader()}
        <EmptyState title="Inventory administrator access required">
          Vendors are managed by Flight Program inventory administrators.
        </EmptyState>
      </>
    );
  if (edit)
    return (
      <>
        {vendorsHeader()}
        <div className="shop-card shop-editor-card">
          <VendorEditor
            key={edit.uuid}
            initial={edit}
            onDone={() => setEdit(undefined)}
            onCancel={() => setEdit(undefined)}
          />
        </div>
      </>
    );
  const disabled = !online || !connected;
  return (
    <VendorDirectory
      s={s}
      disabled={disabled}
      search={search}
      onSearch={setSearch}
      onEdit={setEdit}
    />
  );
}

/**
 * A vendor name field with suggestions from `options`. A name that matches
 * no vendor offers to add it; a matching name is corrected to the vendor's
 * spelling when the field loses focus.
 *
 * @param props.onChange - Receives the typed name and the vendor it matches,
 *   ignoring case and surrounding spaces.
 * @param props.onAdd - Adds the trimmed name; `quick` is true for the name
 *   alone. Its error shows under the field.
 * @param props.nameOnly - Offers only `customLabel` and no full vendor form.
 * @returns The field.
 */
export function VendorPicker(props: PickerProps) {
  const { value, options, onChange, disabled = false } = props;
  const { busy, error, setError, add } = useVendorAdd(props.onAdd);
  const match = findVendor(options, value);
  return (
    <div>
      <VendorNameField
        label={props.label}
        value={value}
        options={options}
        disabled={disabled || busy}
        onChange={(name) => {
          setError("");
          onChange(name, findVendor(options, name));
        }}
        onBlur={() => {
          if (match && match.name !== value) onChange(match.name, match);
        }}
      />
      {!!value.trim() && !match && (
        <AddVendorPrompt
          nameOnly={props.nameOnly}
          customLabel={props.customLabel}
          name={value.trim()}
          disabled={disabled || busy}
          onAdd={(quick) => add(value.trim(), quick)}
        />
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

function VendorFields(props: { draft: Vendor; onChange: (v: Vendor) => void }) {
  const { draft } = props;
  const set = (patch: Partial<Vendor>) =>
    props.onChange({ ...draft, ...patch });
  return (
    <>
      <Field label="Vendor name">
        <input
          required
          maxLength={200}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <AddressFields
        label="Vendor address"
        value={draft.addressDetails}
        onChange={(addressDetails) => set({ addressDetails })}
      />
      <div className="form-grid">
        {DETAIL_FIELDS.map(([key, label, type]) => (
          <Field key={key} label={label}>
            <input
              type={type}
              value={draft[key]}
              onChange={(e) => set({ [key]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <Field label="Vendor notes">
        <textarea
          value={draft.notes}
          onChange={(e) => set({ notes: e.target.value })}
        />
      </Field>
    </>
  );
}

const vendorsHeader = (action?: ReactNode) => (
  <PageHeader
    eyebrow="PURCHASING"
    title="Vendors"
    description="Suppliers and repair stations, with the contact, address and account details your purchase orders use."
    actions={action}
  />
);

function VendorDirectory(
  props: ListProps & { search: string; onSearch: (search: string) => void },
) {
  const all = vendorDirectory(props.s);
  const vendors = all.filter((v) => matchesSearch(v, props.search));
  return (
    <>
      <Link to="/purchase-orders" className="shop-back-link">
        <ArrowLeft size={16} aria-hidden="true" />
        Back to purchase orders
      </Link>
      {vendorsHeader(<AddVendorButton {...props} />)}
      <Toolbar className="shop-toolbar">
        <SearchField
          label="Search vendors"
          placeholder="Name, contact or email"
          value={props.search}
          onChange={props.onSearch}
        />
      </Toolbar>
      {vendors.length ? (
        <VendorTable {...props} vendors={vendors} />
      ) : (
        <EmptyState title="No vendors">
          {all.length
            ? "No vendors match the search."
            : "Add a vendor here or quick add one from a purchase order."}
        </EmptyState>
      )}
      <NoticeBar icon={GearSix}>
        The Aircraft Spruce account is linked in Settings → Flight Program.{" "}
        <Link to="/settings" hash="program">
          Open Flight Program settings
        </Link>
      </NoticeBar>
    </>
  );
}

function AddVendorButton({ disabled, onEdit }: Omit<ListProps, "s">) {
  return (
    <button
      className="button primary"
      disabled={disabled}
      onClick={() => onEdit({ ...newVendor(), name: "" })}
    >
      <Plus size={18} weight="bold" aria-hidden="true" />
      Add vendor
    </button>
  );
}

function VendorTable(props: ListProps & { vendors: Vendor[] }) {
  return (
    <ShopTableCard label="Vendors" className="shop-list-look" stack>
      <table className="shop-table">
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Account</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.vendors.map((v) => (
            <VendorRow key={vendorKey(v.name)} {...props} vendor={v} />
          ))}
        </tbody>
      </table>
    </ShopTableCard>
  );
}

// The vendor's orders open in a dialog with their history: the workspace
// keeps only open and recent orders (H5), so a count here would be short.
function VendorRow({
  disabled,
  onEdit,
  vendor: v,
}: ListProps & { vendor: Vendor }) {
  const [orders, setOrders] = useState(false);
  const a = v.addressDetails;
  const place = [a?.city, a?.region].filter(Boolean).join(", ");
  const details = [place, a?.contactName, a?.email, a?.phone];
  return (
    <tr>
      <td className="shop-lead-cell shop-wide">
        <ShopLead
          icon={Storefront}
          title={v.name}
          sub={details.filter(Boolean).join(" · ")}
        />
      </td>
      <td className="shop-nowrap" data-label="Account">
        {v.accountNumber ? (
          <span className="ds-list-meta">
            <span className="shop-meta-label">Acct</span> {v.accountNumber}
          </span>
        ) : (
          <span className="shop-zero">No account number</span>
        )}
      </td>
      <td className="shop-actions-cell">
        <button className="button small" onClick={() => setOrders(true)}>
          Orders
        </button>
        <button
          className="button small"
          disabled={disabled}
          // Vendors named only on orders, requests or stock have no uuid yet.
          onClick={() => onEdit({ ...v, uuid: v.uuid || crypto.randomUUID() })}
        >
          Edit vendor
        </button>
        {orders && <VendorOrders vendor={v} onClose={() => setOrders(false)} />}
      </td>
    </tr>
  );
}

function useVendorAdd(onAdd: PickerProps["onAdd"]) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async (name: string, quick: boolean) => {
    setBusy(true);
    setError("");
    try {
      await onAdd(name, quick);
    } catch (e) {
      setError(errorText(e, "Unable to add vendor."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, add };
}

function VendorNameField({
  label = "Vendor",
  ...props
}: {
  label?: string;
  value: string;
  options: Vendor[];
  disabled: boolean;
  onChange: (name: string) => void;
  onBlur: () => void;
}) {
  const id = useId();
  return (
    <>
      <Field label={label}>
        <input
          maxLength={200}
          list={id}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={props.onBlur}
          autoComplete="off"
        />
      </Field>
      <datalist id={id}>
        {props.options.map((v) => (
          <option key={vendorKey(v.name)} value={v.name} />
        ))}
      </datalist>
    </>
  );
}

function AddVendorPrompt({
  nameOnly = false,
  customLabel = "Create custom vendor",
  ...props
}: PromptProps) {
  const { disabled, onAdd } = props;
  return (
    <div className="callout">
      <p>Vendor not found. Add “{props.name}”?</p>
      <div className="management-actions">
        <button
          type="button"
          className="button small"
          disabled={disabled}
          onClick={() => void onAdd(true)}
        >
          {nameOnly ? customLabel : "Quick add"}
        </button>
        {!nameOnly && (
          <button
            type="button"
            className="button small"
            disabled={disabled}
            onClick={() => void onAdd(false)}
          >
            Add vendor
          </button>
        )}
      </div>
      <small>
        {nameOnly
          ? "Use the vendor name only. Contact details can be managed separately under Vendors."
          : "Quick add saves the name only. Add vendor opens the full details form."}
      </small>
    </div>
  );
}

function findVendor(options: Vendor[], name: string) {
  return options.find((v) => vendorKey(v.name) === vendorKey(name));
}

function matchesSearch(v: Vendor, search: string) {
  const a = v.addressDetails;
  return `${v.name} ${a?.contactName ?? ""} ${a?.email ?? ""}`
    .toLowerCase()
    .includes(search.toLowerCase());
}
