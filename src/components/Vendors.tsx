import { useId, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { vendorSchema, type Vendor } from "../domain/management";
import { vendorDirectory, vendorKey } from "../domain/vendors";
import { programPermission } from "../domain/programs";
import { AddressFields } from "./AddressFields";
import { AsyncForm, Field } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  SearchField,
  Toolbar,
} from "./design";
import { ShopLead, ShopTableCard } from "./ShopList";
import { ArrowLeft, GearSix, Plus, Storefront } from "@phosphor-icons/react";

export function newVendor(name = ""): Vendor {
  return vendorSchema.parse({
    kind: "vendor",
    uuid: crypto.randomUUID(),
    version: 0,
    name: name || "New vendor",
  });
}
export function VendorEditor({
  initial,
  onDone,
  onCancel,
}: {
  initial: Vendor;
  onDone: (vendor: Vendor) => void;
  onCancel: () => void;
}) {
  const { backend, online, connected } = useWorkspace();
  const [draft, setDraft] = useState(initial);
  const [requestUuid] = useState(() => crypto.randomUUID());
  return (
    <section>
      <h2>{initial.version ? "Edit vendor" : "Add vendor"}</h2>
      <AsyncForm
        submitLabel="Save vendor"
        onClose={onCancel}
        disabled={!online || !connected}
        onSubmit={async () => {
          const record = vendorSchema.parse(draft);
          await backend!.manage({
            action: "record.save",
            record,
            requestUuid,
            reason: initial.version ? "Vendor details updated" : "Vendor added",
          });
          onDone({ ...record, version: record.version + 1 });
        }}
      >
        <Field label="Vendor name">
          <input
            required
            maxLength={200}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <AddressFields
          label="Vendor address"
          value={draft.addressDetails}
          onChange={(addressDetails) => setDraft({ ...draft, addressDetails })}
        />
        <div className="form-grid">
          <Field label="Website">
            <input
              type="url"
              value={draft.website}
              onChange={(e) => setDraft({ ...draft, website: e.target.value })}
            />
          </Field>
          <Field label="Account number">
            <input
              value={draft.accountNumber}
              onChange={(e) =>
                setDraft({ ...draft, accountNumber: e.target.value })
              }
            />
          </Field>
          <Field label="Payment terms">
            <input
              value={draft.paymentTerms}
              onChange={(e) =>
                setDraft({ ...draft, paymentTerms: e.target.value })
              }
            />
          </Field>
        </div>
        <Field label="Vendor notes">
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </Field>
      </AsyncForm>
    </section>
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
  const all = vendorDirectory(s);
  const orderCount = (name: string) => {
    const n = (s.purchaseOrders ?? []).filter(
      (p) => vendorKey(p.vendor) === vendorKey(name),
    ).length;
    return `${n} order${n === 1 ? "" : "s"}`;
  };
  const vendors = all.filter((v) =>
    `${v.name} ${v.addressDetails?.contactName ?? ""} ${v.addressDetails?.email ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <Link to="/purchase-orders" className="shop-back-link">
        <ArrowLeft size={16} aria-hidden="true" />
        Back to purchase orders
      </Link>
      {vendorsHeader(
        <button
          className="button primary"
          disabled={!online || !connected}
          onClick={() => setEdit({ ...newVendor(), name: "" })}
        >
          <Plus size={18} weight="bold" aria-hidden="true" />
          Add vendor
        </button>,
      )}
      <Toolbar className="shop-toolbar">
        <SearchField
          label="Search vendors"
          placeholder="Name, contact or email"
          value={search}
          onChange={setSearch}
        />
      </Toolbar>
      {vendors.length ? (
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
              {vendors.map((v) => {
                const a = v.addressDetails;
                const place = [a?.city, a?.region].filter(Boolean).join(", ");
                return (
                  <tr key={vendorKey(v.name)}>
                    <td className="shop-lead-cell shop-wide">
                      <ShopLead
                        icon={Storefront}
                        title={v.name}
                        sub={[
                          place,
                          a?.contactName,
                          a?.email,
                          a?.phone,
                          orderCount(v.name),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    </td>
                    <td className="shop-nowrap" data-label="Account">
                      {v.accountNumber ? (
                        <span className="ds-list-meta">
                          <span className="shop-meta-label">Acct</span>{" "}
                          {v.accountNumber}
                        </span>
                      ) : (
                        <span className="shop-zero">No account number</span>
                      )}
                    </td>
                    <td className="shop-actions-cell">
                      <button
                        className="button small"
                        disabled={!online || !connected}
                        onClick={() =>
                          setEdit({
                            ...v,
                            uuid: v.uuid || crypto.randomUUID(),
                          })
                        }
                      >
                        Edit vendor
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ShopTableCard>
      ) : (
        <EmptyState title="No vendors">
          {all.length
            ? "No vendors match the search."
            : "Add a vendor here or quick add one from a purchase order."}
        </EmptyState>
      )}
      <NoticeBar icon={GearSix}>
        Aircraft Spruce account is in Settings.{" "}
        <Link to="/settings" hash="program">
          Open Flight Program settings
        </Link>
      </NoticeBar>
    </>
  );
}
export function VendorPicker({
  label = "Vendor",
  value,
  options,
  onChange,
  onAdd,
  disabled = false,
  nameOnly = false,
  customLabel = "Create custom vendor",
}: {
  label?: string;
  value: string;
  options: Vendor[];
  onChange: (name: string, vendor?: Vendor) => void;
  onAdd: (name: string, quick: boolean) => Promise<void>;
  disabled?: boolean;
  nameOnly?: boolean;
  customLabel?: string;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const match = options.find((v) => vendorKey(v.name) === vendorKey(value));
  async function add(quick: boolean) {
    setBusy(true);
    setError("");
    try {
      await onAdd(value.trim(), quick);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to add vendor.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <Field label={label}>
        <input
          maxLength={200}
          list={id}
          value={value}
          disabled={disabled || busy}
          onChange={(e) => {
            setError("");
            const name = e.target.value;
            onChange(
              name,
              options.find((v) => vendorKey(v.name) === vendorKey(name)),
            );
          }}
          onBlur={() => {
            if (match && match.name !== value) onChange(match.name, match);
          }}
          autoComplete="off"
        />
      </Field>
      <datalist id={id}>
        {options.map((v) => (
          <option key={vendorKey(v.name)} value={v.name} />
        ))}
      </datalist>
      {!!value.trim() && !match && (
        <div className="callout">
          <p>Vendor not found. Add “{value.trim()}”?</p>
          <div className="management-actions">
            <button
              type="button"
              className="button small"
              disabled={disabled || busy}
              onClick={() => void add(true)}
            >
              {nameOnly ? customLabel : "Quick add"}
            </button>
            {!nameOnly && (
              <button
                type="button"
                className="button small"
                disabled={disabled || busy}
                onClick={() => void add(false)}
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
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
