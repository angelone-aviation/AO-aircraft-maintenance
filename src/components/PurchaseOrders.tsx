/**
 * Responsibility: Purchase orders: the orders screen, the editor, an order's
 *   detail with its documents and files, and the inspection PO button.
 * Layer: UI. React components; order rules live in src/domain.
 * Dependencies: react, @tanstack/react-router, @phosphor-icons/react,
 *   src/data/store.ts, src/data/partsRequestPdf.ts and src/data/poPdf.ts (on
 *   demand), src/domain (model, vendors, management, addresses, programs,
 *   purchaseOrders), ./AircraftSpruce, ./Vendors, ./CoreReturns,
 *   ./SavedAddresses, ./ShopList, ./ui, ./design, ./purchaseOrders.css.
 */
import { SpruceProductPicker, SpruceOrderProgress } from "./AircraftSpruce";
import { localDate } from "../domain/model";
import { VendorEditor, VendorPicker, newVendor } from "./Vendors";
import { vendorDirectory, vendorKey } from "../domain/vendors";
import type { Vendor } from "../domain/management";
import { SavedAddressPicker } from "./SavedAddresses";
import { formatAddress } from "../domain/addresses";
import { useState, useEffect, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import { useWorkspace } from "../data/store";
import { programPermission } from "../domain/programs";
import {
  poAttachmentRemovable,
  poDraftSchema,
  poLineSchema,
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
import type { Inspection } from "../domain/model";
import { AsyncForm, DeleteFileButton, Modal, Field, errorText } from "./ui";
import {
  EmptyState,
  PageHeader,
  SearchField,
  StatTile,
  StatsStrip,
  StatusPill,
  Toolbar,
} from "./design";
import { ShopLead, ShopSelect, ShopStat, ShopTableCard } from "./ShopList";
import {
  Funnel,
  Plus,
  Receipt,
  Storefront,
  Warning,
} from "@phosphor-icons/react";
import "./purchaseOrders.css";
import { CoreReturns } from "./CoreReturns";
const today = () => localDate();
const cash = (c: number, currency: string) =>
  `${currency} ${(c / 100).toFixed(2)}`;
const freshLine = (): POLine => ({
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
});
const freshDraft = (): PODraft => ({
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
});
export function PurchaseOrders() {
  const { snapshot: s, online, connected } = useWorkspace();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [edit, setEdit] = useState<PODraft>();
  const [view, setView] = useState<string>();
  const orders = s?.purchaseOrders ?? [];
  const po = orders.find((p) => p.uuid === view);
  if (!s || !programPermission(s, "admin"))
    return (
      <>
        <PageHeader eyebrow="PURCHASING" title="Purchase orders" />
        <EmptyState title="Inventory administrator access required">
          Purchase orders are managed by Flight Program inventory
          administrators.
        </EmptyState>
      </>
    );
  const list = orders
    .filter(
      (p) =>
        (!status || poStatus(p) === status) &&
        `${p.number} ${p.vendor} ${p.lines.map((l) => l.partNumber).join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const overdue = (p: PurchaseOrder) =>
    p.phase === "issued" &&
    !!p.expectedDate &&
    p.expectedDate < today() &&
    p.lines.some((l) => outstanding(p, l) > 0);
  const drafts = orders.filter((p) => p.phase === "draft").length;
  const open = orders.filter(
    (p) => p.phase === "issued" && poStatus(p) !== "Received",
  ).length;
  const late = orders.filter(overdue).length;
  return (
    <>
      <PageHeader
        eyebrow="PURCHASING"
        title="Purchase orders"
        description="Orders to vendors, from draft to receipt: track shipments, receive parts into inventory and follow core returns."
        actions={
          <>
            <Link to="/vendors" className="button">
              <Storefront size={18} aria-hidden="true" />
              View vendors
            </Link>
            <button
              className="button primary"
              disabled={!online || !connected}
              onClick={() => setEdit(freshDraft())}
            >
              <Plus size={18} weight="bold" aria-hidden="true" />
              New PO
            </button>
          </>
        }
      />
      <StatsStrip className="shop-stats">
        <StatTile label="Drafts" value={drafts} />
        <StatTile label="Open" value={open} />
        <ShopStat
          label="Delivery overdue"
          value={late}
          tone={late ? "danger" : undefined}
        />
      </StatsStrip>
      <Toolbar className="shop-toolbar">
        <SearchField
          label="Search purchase orders"
          placeholder="PO, vendor or part number"
          value={search}
          onChange={setSearch}
        />
        <ShopSelect
          label="PO status"
          icon={Funnel}
          value={status}
          onChange={setStatus}
        >
          <option value="">All statuses</option>
          {[
            "Draft",
            "Issued",
            "Partially shipped",
            "Shipped",
            "Partially received",
            "Received",
            "Closed",
            "Cancelled",
          ].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </ShopSelect>
      </Toolbar>
      {list.length ? (
        <ShopTableCard label="Purchase orders" stack>
          <table
            className="shop-table"
            style={{ "--shop-table-min": "860px" } as CSSProperties}
          >
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
              {list.map((p) => {
                const label = poStatus(p);
                const tone = poTone(label);
                return (
                  <tr key={p.uuid}>
                    <td className="shop-wide">
                      <ShopLead
                        icon={Receipt}
                        tone={tone}
                        title={
                          <button
                            className="shop-title-button"
                            onClick={() => setView(p.uuid)}
                          >
                            {p.number}
                          </button>
                        }
                        sub={`${p.lines.length} line${p.lines.length === 1 ? "" : "s"} · ${p.currency}`}
                      />
                    </td>
                    <td data-label="Vendor">{p.vendor}</td>
                    <td data-label="Status">
                      <StatusPill tone={tone}>{label}</StatusPill>
                    </td>
                    <td data-label="Expected">
                      <span className="shop-nowrap">
                        {p.expectedDate || "—"}
                      </span>
                      {overdue(p) && (
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ShopTableCard>
      ) : (
        <EmptyState title="No purchase orders">
          {orders.length
            ? "No purchase orders match the search or status."
            : "Create a PO here or from an inspection’s required parts."}
        </EmptyState>
      )}
      <div className="shop-card">
        <CoreReturns orders={orders} />
      </div>
      {edit && (
        <Modal
          title={edit.version ? "Edit draft PO" : "New purchase order"}
          wide
          onClose={() => setEdit(undefined)}
        >
          <POEditor initial={edit} onDone={() => setEdit(undefined)} />
        </Modal>
      )}
      {po && (
        <Modal
          title={`${po.number} · ${poStatus(po)}`}
          wide
          onClose={() => setView(undefined)}
        >
          <PODetail
            po={po}
            onEdit={() => {
              setView(undefined);
              setEdit(po);
            }}
          />
        </Modal>
      )}
    </>
  );
}
const poTone = (status: string) =>
  status === "Draft"
    ? "warn"
    : status === "Received" || status === "Closed"
      ? "good"
      : "neutral";
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
          const lines = inspection.requiredParts!.flatMap((r) => {
            const stock = s.management?.find(
              (x) => x.kind === "stock" && x.uuid === r.stockUuid,
            );
            if (!stock || stock.kind !== "stock") return [];
            const planned = (s.purchaseOrders ?? [])
              .filter((p) => p.phase === "draft")
              .flatMap((p) => p.lines)
              .filter(
                (l) =>
                  l.inspectionUuid === inspection.uuid &&
                  l.stockUuid === stock.uuid,
              )
              .reduce((n, l) => n + l.quantity, 0);
            return [
              {
                ...freshLine(),
                stockUuid: stock.uuid,
                locationUuid: stock.locationUuid,
                partNumber: stock.partNumber,
                description: stock.description,
                kind: stock.category,
                quantity: Math.max(
                  0,
                  r.quantity -
                    stock.quantity -
                    onOrder(s, stock.uuid) -
                    planned,
                ),
                unitCents: Math.round((stock.cost ?? 0) * 100),
                inspectionUuid: inspection.uuid,
                aircraftUuid: inspection.aircraftUuid,
              },
            ];
          });
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
export function POEditor({
  initial,
  onDone,
  inspection,
}: {
  initial: PODraft;
  onDone: () => void;
  inspection?: Inspection;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const locations = (s!.management ?? []).filter((r) => r.kind === "location");
  const locationAddress = (uuid: string) =>
    locations.find((location) => location.uuid === uuid)?.address ?? "";
  const [draft, setDraft] = useState(() => ({
    ...initial,
    shippingAddress:
      initial.shippingAddress ??
      (!initial.shipTo.trim()
        ? locations.find((l) => l.uuid === initial.lines[0]?.locationUuid)
            ?.addressDetails
        : undefined),
    shipTo: initial.shipTo.trim()
      ? initial.shipTo
      : locationAddress(initial.lines[0]?.locationUuid ?? ""),
  }));
  const [vendors, setVendors] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");
  const [requestUuid] = useState(() => crypto.randomUUID());

  const stocks = (s!.management ?? []).filter((r) => r.kind === "stock");
  const patch = (p: Partial<PODraft>) => setDraft({ ...draft, ...p });
  const linePatch = (uuid: string, p: Partial<POLine>) => {
    const previous = draft.lines.find((line) => line.uuid === uuid);
    if (
      !("sprucePart" in p) &&
      ((p.partNumber !== undefined && p.partNumber !== previous?.partNumber) ||
        (p.stockUuid !== undefined && p.stockUuid !== previous?.stockUuid))
    )
      p = { ...p, sprucePart: undefined };
    const autofill =
      p.locationUuid !== undefined &&
      (!draft.shipTo.trim() ||
        (draft.lines[0]?.uuid === uuid &&
          draft.shipTo === locationAddress(previous?.locationUuid ?? "")));
    patch({
      ...(autofill
        ? {
            shipTo: locationAddress(p.locationUuid!),
            shippingAddress: locations.find((l) => l.uuid === p.locationUuid)
              ?.addressDetails,
          }
        : {}),
      lines: draft.lines.map((l) =>
        l.uuid === uuid
          ? {
              ...l,
              ...p,
              ...(p.quantity !== undefined && l.requestAllocations?.length === 1
                ? {
                    requestAllocations: [
                      { ...l.requestAllocations[0], quantity: p.quantity },
                    ],
                  }
                : {}),
            }
          : l,
      ),
    });
  };
  const [addedVendors, setAddedVendors] = useState<Vendor[]>([]);
  const [vendorEdit, setVendorEdit] = useState<{
    record: Vendor;
    lineUuid?: string;
  }>();
  const vendorOptions = [
    ...new Map(
      [...vendorDirectory(s!), ...addedVendors].map((v) => [
        vendorKey(v.name),
        v,
      ]),
    ).values(),
  ];
  const selectVendor = (vendor: Vendor, lineUuid?: string) => {
    if (lineUuid) setVendors((prev) => ({ ...prev, [lineUuid]: vendor.name }));
    else
      setDraft((prev) => ({
        ...prev,
        vendor: vendor.name,
        vendorUuid: vendor.uuid || undefined,
        vendorContact: vendor.addressDetails
          ? formatAddress(vendor.addressDetails)
          : "",
        vendorAddressDetails: vendor.addressDetails,
      }));
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
  if (vendorEdit)
    return (
      <>
        <p>Your purchase order is kept while you add this vendor.</p>
        <VendorEditor
          initial={vendorEdit.record}
          onCancel={() => setVendorEdit(undefined)}
          onDone={(v) => {
            setAddedVendors((prev) => [...prev, v]);
            selectVendor(v, vendorEdit.lineUuid);
            setVendorEdit(undefined);
          }}
        />
      </>
    );
  return (
    <AsyncForm
      submitLabel={target ? "Add to draft PO" : "Save draft PO"}
      disabled={!online || !connected}
      onSubmit={async () => {
        const positive = draft.lines.filter((l) => l.quantity > 0);
        if (!positive.length)
          throw Error("Select at least one part quantity to purchase.");
        if (initial.version && Object.values(vendors).some(Boolean))
          throw Error("A saved PO must stay with one vendor.");
        const grouped = new Map<string, POLine[]>();
        for (const line of positive) {
          const vendor = (vendors[line.uuid] || draft.vendor).trim();
          if (!vendor) throw Error("Select a vendor for each part.");
          if (
            !vendorOptions.some((v) => vendorKey(v.name) === vendorKey(vendor))
          )
            throw Error(
              `Add vendor “${vendor}” using Quick add or Add vendor before saving.`,
            );
          const key = vendor.toLowerCase();
          grouped.set(key, [...(grouped.get(key) ?? []), line]);
        }
        if (grouped.size > 1 && draft.shippingCents > 0)
          throw Error(
            "Set shipping cost to zero here, then enter each vendor’s shipping charge on its separate draft PO.",
          );
        let drafts: PODraft[];
        if (target) {
          const existing = s!.purchaseOrders?.find(
            (p) => p.uuid === target && p.phase === "draft",
          );
          if (
            !existing ||
            grouped.size !== 1 ||
            !grouped.has(existing.vendor.toLowerCase())
          )
            throw Error("An existing draft must match the selected vendor.");
          if (existing.shipTo.trim() !== draft.shipTo.trim())
            throw Error("Ship-to must match the existing draft.");
          if (existing.currency !== draft.currency)
            throw Error("Currency must match the existing draft.");
          drafts = [
            poDraftSchema.parse({
              ...existing,
              lines: [...existing.lines, ...positive],
            }),
          ];
        } else
          drafts = [...grouped.values()].map((lines, index) =>
            poDraftSchema.parse({
              ...draft,
              uuid: index === 0 ? draft.uuid : `${draft.uuid}-${index}`,
              vendor: vendorOptions.find(
                (v) =>
                  vendorKey(v.name) ===
                  vendorKey(vendors[lines[0].uuid] || draft.vendor),
              )!.name,
              vendorUuid:
                vendorOptions.find(
                  (v) =>
                    vendorKey(v.name) ===
                    vendorKey(vendors[lines[0].uuid] || draft.vendor),
                )!.uuid || undefined,
              lines,
              shippingCents: grouped.size > 1 ? 0 : draft.shippingCents,
              vendorContact: (() => {
                const v = vendorOptions.find(
                  (v) =>
                    vendorKey(v.name) ===
                    vendorKey(vendors[lines[0].uuid] || draft.vendor),
                )!;
                return v.addressDetails
                  ? formatAddress(v.addressDetails)
                  : vendorKey(v.name) === vendorKey(initial.vendor)
                    ? initial.vendorContact
                    : "";
              })(),
              vendorAddressDetails: vendorOptions.find(
                (v) =>
                  vendorKey(v.name) ===
                  vendorKey(vendors[lines[0].uuid] || draft.vendor),
              )!.addressDetails,
            }),
          );
        await backend!.purchaseOrder({ kind: "save", requestUuid, drafts });
        onDone();
      }}
    >
      <div className="form-grid">
        <VendorPicker
          value={draft.vendor}
          options={vendorOptions}
          disabled={!online || !connected}
          onChange={(name, vendor) =>
            vendor
              ? selectVendor(vendor)
              : patch({
                  vendor: name,
                  vendorUuid: undefined,
                  vendorContact: "",
                  vendorAddressDetails: undefined,
                })
          }
          onAdd={(name, quick) => addVendor(name, quick)}
        />
        <SavedAddressPicker
          label="Shipping address"
          inventoryLocationName={
            locations.find((l) => l.uuid === draft.lines[0]?.locationUuid)?.name
          }
          value={draft.shippingAddress}
          legacy={draft.shipTo}
          onChange={(address) =>
            patch({ shippingAddress: address, shipTo: formatAddress(address) })
          }
        />
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
            maxLength={3}
            pattern="[A-Z]{3}"
            value={draft.currency}
            onChange={(e) => patch({ currency: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Shipping cost">
          <input
            type="number"
            min="0"
            step=".01"
            value={draft.shippingCents / 100}
            onChange={(e) =>
              patch({ shippingCents: Math.round(Number(e.target.value) * 100) })
            }
          />
        </Field>
      </div>
      {inspection && (
        <p className="callout">
          Different vendors create separate draft POs. Review shipping charges
          on each resulting draft before issue.
        </p>
      )}
      {draft.lines.map((l, index) => (
        <fieldset className="po-line" key={l.uuid}>
          <legend>Part {index + 1}</legend>
          <SpruceProductPicker
            initialSearch={l.partNumber}
            currency={draft.currency}
            onSelect={(product, cents) => {
              linePatch(l.uuid, {
                sprucePart: {
                  partNumber: product.partNumber,
                  uom: product.uom,
                  currency: product.currency,
                  catalogAt: product.catalogAt,
                },
                ...(!l.partNumber ? { partNumber: product.partNumber } : {}),
                ...(!l.description ? { description: product.description } : {}),
                ...(cents !== undefined ? { unitCents: cents } : {}),
              });
              setDraft((d) => ({
                ...d,
                vendor: d.vendor || "Aircraft Spruce",
              }));
            }}
          />
          {l.sprucePart && (
            <p>
              Aircraft Spruce: {l.sprucePart.partNumber} · {l.sprucePart.uom}{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => linePatch(l.uuid, { sprucePart: undefined })}
              >
                Remove supplier mapping
              </button>
            </p>
          )}
          <div className="form-grid">
            <Field label={`Part ${index + 1} inventory location`}>
              <select
                required
                value={l.locationUuid}
                onChange={(e) =>
                  linePatch(l.uuid, {
                    locationUuid: e.target.value,
                    stockUuid: "",
                  })
                }
              >
                <option value="">Select location</option>
                {locations.map((x) => (
                  <option key={x.uuid} value={x.uuid}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Part ${index + 1} stock item`}>
              <select
                value={l.stockUuid}
                onChange={(e) => {
                  const st = stocks.find((x) => x.uuid === e.target.value);
                  linePatch(
                    l.uuid,
                    st
                      ? {
                          stockUuid: st.uuid,
                          partNumber: st.partNumber,
                          description: st.description,
                          kind: st.category,
                          unitCents: Math.round((st.cost ?? 0) * 100),
                        }
                      : { stockUuid: "" },
                  );
                }}
              >
                <option value="">New part / component</option>
                {stocks
                  .filter((x) => x.locationUuid === l.locationUuid)
                  .map((x) => (
                    <option key={x.uuid} value={x.uuid}>
                      {x.partNumber} · {x.description}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={`Part ${index + 1} number`}>
              <input
                required
                readOnly={!!l.stockUuid}
                value={l.partNumber}
                onChange={(e) =>
                  linePatch(l.uuid, { partNumber: e.target.value })
                }
              />
            </Field>
            <Field label={`Part ${index + 1} description`}>
              <input
                required
                value={l.description}
                onChange={(e) =>
                  linePatch(l.uuid, { description: e.target.value })
                }
              />
            </Field>
            <Field label={`Part ${index + 1} category`}>
              <select
                disabled={!!l.stockUuid}
                value={l.kind}
                onChange={(e) =>
                  linePatch(l.uuid, { kind: e.target.value as POLine["kind"] })
                }
              >
                <option value="part">Part</option>
                <option value="supply">Supply</option>
                <option value="component">Trackable Aircraft Component</option>
              </select>
            </Field>
            <Field label={`Part ${index + 1} quantity`}>
              <input
                type="number"
                required
                min={inspection ? 0 : 1}
                step="1"
                value={l.quantity}
                onChange={(e) =>
                  linePatch(l.uuid, { quantity: Number(e.target.value) })
                }
              />
            </Field>
            <Field label={`Part ${index + 1} unit cost`}>
              <input
                type="number"
                required
                min="0"
                step=".01"
                value={l.unitCents / 100}
                onChange={(e) =>
                  linePatch(l.uuid, {
                    unitCents: Math.round(Number(e.target.value) * 100),
                  })
                }
              />
            </Field>
            {!initial.version && (
              <VendorPicker
                label={`Part ${index + 1} vendor (optional override)`}
                value={vendors[l.uuid] ?? ""}
                options={vendorOptions}
                disabled={!online || !connected}
                onChange={(name) => setVendors({ ...vendors, [l.uuid]: name })}
                onAdd={(name, quick) => addVendor(name, quick, l.uuid)}
              />
            )}
            <Field label={`Part ${index + 1} aircraft`}>
              <select
                value={l.aircraftUuid}
                disabled={!!l.inspectionUuid}
                onChange={(e) =>
                  linePatch(l.uuid, {
                    aircraftUuid: e.target.value,
                    workOrderUuid: "",
                  })
                }
              >
                <option value="">General inventory</option>
                {s!.aircraft.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.registration}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Part ${index + 1} work order`}>
              <select
                value={l.workOrderUuid}
                onChange={(e) =>
                  linePatch(l.uuid, { workOrderUuid: e.target.value })
                }
              >
                <option value="">No work order</option>
                {(s!.workOrders ?? [])
                  .filter((w) => w.aircraftUuid === l.aircraftUuid)
                  .map((w) => (
                    <option key={w.uuid} value={w.uuid}>
                      {w.number}
                    </option>
                  ))}
              </select>
            </Field>
            {l.kind === "component" && (
              <>
                <Field label={`Part ${index + 1} component type`}>
                  <select
                    value={l.componentType}
                    onChange={(e) =>
                      linePatch(l.uuid, {
                        componentType: e.target
                          .value as POLine["componentType"],
                      })
                    }
                  >
                    {["Appliance", "Engine", "Propeller"].map((x) => (
                      <option key={x}>{x}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Part ${index + 1} manufacturer`}>
                  <input
                    value={l.manufacturer}
                    onChange={(e) =>
                      linePatch(l.uuid, { manufacturer: e.target.value })
                    }
                  />
                </Field>
                <Field label={`Part ${index + 1} model`}>
                  <input
                    value={l.model}
                    onChange={(e) =>
                      linePatch(l.uuid, { model: e.target.value })
                    }
                  />
                </Field>
              </>
            )}
            {!l.repairComponentUuid && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={!!l.exchange}
                  onChange={(e) =>
                    linePatch(l.uuid, {
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
                <input
                  type="number"
                  required
                  min="1"
                  max="365"
                  step="1"
                  value={l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS}
                  onChange={(e) =>
                    linePatch(l.uuid, { coreDueDays: Number(e.target.value) })
                  }
                />
              </Field>
            )}
          </div>
          {!!l.stockUuid && (
            <p>
              On hand:{" "}
              {stocks.find((x) => x.uuid === l.stockUuid)?.quantity ?? 0} · On
              order: {onOrder(s!, l.stockUuid)}
              {inspection
                ? ` · Required: ${inspection.requiredParts?.find((r) => r.stockUuid === l.stockUuid)?.quantity ?? 0}`
                : ""}
            </p>
          )}
          {l.inspectionUuid && (
            <p>
              Inspection:{" "}
              {
                s!.inspections.find((i) => i.uuid === l.inspectionUuid)
                  ?.reference
              }
            </p>
          )}
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
                      ...(l.requestAllocations?.length === 1
                        ? {
                            requestAllocations: [
                              { ...l.requestAllocations[0], quantity: 1 },
                            ],
                          }
                        : {}),
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
        </fieldset>
      ))}
      <button
        type="button"
        className="button"
        onClick={() => patch({ lines: [...draft.lines, freshLine()] })}
      >
        Add part
      </button>
      {!initial.version && (
        <Field label="Add to existing draft PO">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Create new vendor PO(s)</option>
            {(s!.purchaseOrders ?? [])
              .filter((p) => p.phase === "draft")
              .map((p) => (
                <option key={p.uuid} value={p.uuid}>
                  {p.number} · {p.vendor}
                </option>
              ))}
          </select>
        </Field>
      )}
      <Field label="PO notes">
        <textarea
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </Field>
      <p>Total: {cash(poTotal(draft), draft.currency)}</p>
    </AsyncForm>
  );
}
export function PODetail({
  po,
  onEdit,
}: {
  po: PurchaseOrder;
  onEdit: () => void;
}) {
  const { snapshot: s, online, connected } = useWorkspace();
  const [action, setAction] =
    useState<Exclude<POCommand["kind"], "save" | "core">>();
  const [pdfError, setPdfError] = useState("");
  const writable = online && connected;
  async function print(download: boolean) {
    const preview = download ? null : window.open("", "_blank");
    if (preview) preview.opener = null;
    try {
      setPdfError("");
      const { poPdf } = await import("../data/poPdf");
      const doc = poPdf(po, s!);
      if (download) doc.save(`${po.number}.pdf`);
      else {
        const url = URL.createObjectURL(doc.output("blob"));
        if (!preview)
          throw Error("Allow the PDF preview window, or use Save PO PDF.");
        preview.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) {
      preview?.close();
      setPdfError(errorText(e));
    }
  }
  return (
    <>
      <p>
        <strong>{po.vendor}</strong> · Revision {po.revision} · {po.currency}
      </p>

      <p className="po-pre">Deliver to: {po.shipTo}</p>
      <SpruceOrderProgress poUuid={po.uuid} />
      <div className="management-actions">
        <button className="button" onClick={() => void print(false)}>
          Print PO
        </button>
        <button className="button" onClick={() => void print(true)}>
          Save PO PDF
        </button>
        {(s?.partsRequests ?? [])
          .filter(
            (r) =>
              r.mode === "repair" &&
              po.lines.some((l) =>
                l.requestAllocations?.some((a) => a.requestUuid === r.uuid),
              ),
          )
          .map((r) => (
            <span key={r.uuid}>
              <button
                type="button"
                className="button"
                onClick={async () => {
                  try {
                    const { requestPdf } =
                      await import("../data/partsRequestPdf");
                    requestPdf(r, s!, "request").save(`${r.number}-repair.pdf`);
                  } catch (e) {
                    setPdfError(errorText(e));
                  }
                }}
              >
                Repair order / tag {r.number}
              </button>
              <button
                type="button"
                className="button"
                onClick={async () => {
                  try {
                    const { requestPdf } =
                      await import("../data/partsRequestPdf");
                    requestPdf(r, s!, "packing").save(
                      `${r.number}-packing.pdf`,
                    );
                  } catch (e) {
                    setPdfError(errorText(e));
                  }
                }}
              >
                Packing slip {r.number}
              </button>
            </span>
          ))}
        {po.phase === "draft" && (
          <>
            <button className="button" disabled={!writable} onClick={onEdit}>
              Edit draft
            </button>
            <button
              className="button primary"
              disabled={!writable}
              onClick={() => setAction("issue")}
            >
              Issue PO
            </button>
          </>
        )}
        {po.phase === "issued" && (
          <>
            <button
              className="button"
              disabled={
                !writable || !po.lines.some((l) => outstanding(po, l) > 0)
              }
              onClick={() => setAction("ship")}
            >
              Record shipment
            </button>
            <button
              className="button primary"
              disabled={
                !writable || !po.lines.some((l) => outstanding(po, l) > 0)
              }
              onClick={() => setAction("receive")}
            >
              {po.lines.some((l) => l.repairComponentUuid)
                ? "Receive repair return"
                : "Receive parts"}
            </button>
            <button
              className="button"
              disabled={
                !writable || po.lines.some((l) => outstanding(po, l) > 0)
              }
              onClick={() => setAction("close")}
            >
              Close PO
            </button>
            {!po.shipments.length && !po.receipts.length && (
              <button
                className="button"
                disabled={!writable}
                onClick={() => setAction("revise")}
              >
                Revise PO
              </button>
            )}
          </>
        )}
        {["draft", "issued"].includes(po.phase) && (
          <button
            className="button"
            disabled={!writable}
            onClick={() => setAction("cancel")}
          >
            {po.receipts.length ? "Cancel remaining and close" : "Cancel PO"}
          </button>
        )}
      </div>
      {pdfError && (
        <p role="alert" className="error">
          {pdfError}
        </p>
      )}
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
                <td>
                  {l.partNumber}
                  <small className="block">{l.description}</small>
                  {l.exchange && (
                    <small className="block">
                      Exchange · core due{" "}
                      {l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS} days after
                      receipt
                    </small>
                  )}
                  {(l.requestAllocations ?? []).map((a) => (
                    <small
                      className="block"
                      key={`${a.requestUuid}-${a.lineUuid}`}
                    >
                      {s?.partsRequests?.find((r) => r.uuid === a.requestUuid)
                        ?.number ?? a.requestUuid}{" "}
                      · Allocated {a.quantity}
                    </small>
                  ))}
                </td>
                <td>
                  {s!.management?.find(
                    (r) => r.uuid === l.locationUuid && r.kind === "location",
                  )?.kind === "location"
                    ? (
                        s!.management.find(
                          (r) => r.uuid === l.locationUuid,
                        ) as { name: string }
                      ).name
                    : l.locationUuid}
                  <small className="block">
                    {
                      s!.aircraft.find((a) => a.uuid === l.aircraftUuid)
                        ?.registration
                    }{" "}
                    {
                      s!.inspections.find((i) => i.uuid === l.inspectionUuid)
                        ?.reference
                    }{" "}
                    {
                      s!.workOrders?.find((w) => w.uuid === l.workOrderUuid)
                        ?.number
                    }
                  </small>
                </td>
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
      <p>
        Shipping: {cash(po.shippingCents, po.currency)} · Total ordered:{" "}
        <strong>{cash(poTotal(po), po.currency)}</strong>
      </p>
      <p className="po-pre">{po.notes}</p>
      {!!po.shipments.length && (
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
      )}
      {!!po.receipts.length && (
        <section>
          <h3>Receipts</h3>
          {po.receipts.map((r) => (
            <div key={r.uuid}>
              <p>
                {r.date} · Invoice {r.invoice || "—"} · {r.notes}
              </p>
              {r.lines.map((l) => (
                <p key={l.lineUuid}>
                  {po.lines.find((x) => x.uuid === l.lineUuid)?.partNumber}:{" "}
                  {l.quantity} · {l.condition}{" "}
                  {l.serials.map((x) => x.serial).join(", ")}
                  {l.expirationDate
                    ? ` · Expires ${l.expirationDate}`
                    : ""} ·{" "}
                  <Link
                    to="/inventory"
                    search={{ item: l.itemUuids[0], program: po.programUuid }}
                  >
                    View inventory
                  </Link>
                </p>
              ))}
            </div>
          ))}
        </section>
      )}
      <POFiles po={po} />
      <details>
        <summary>PO history ({po.history.length})</summary>
        {po.history.map((h, i) => (
          <div key={i}>
            <p>
              {new Date(h.at).toLocaleString()} · {h.action} ·{" "}
              {s!.members.find((m) => m.id === h.actorId)?.name ?? h.actorId}{" "}
              {h.reason}
            </p>
            {h.action === "Draft saved" && (
              <details>
                <summary>Saved order revision</summary>
                {(JSON.parse(h.detail).drafts as PODraft[])
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
                            {l.partNumber} · {l.description} · Qty {l.quantity}{" "}
                            · {cash(l.unitCents, d.currency)} each
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
            )}
          </div>
        ))}
      </details>
      {action && (
        <Modal
          title={`${action === "receive" ? "Receive parts" : action === "ship" ? "Record shipment" : action} · ${po.number}`}
          wide
          onClose={() => setAction(undefined)}
        >
          <POAction po={po} kind={action} onDone={() => setAction(undefined)} />
        </Modal>
      )}
    </>
  );
}
function POAction({
  po,
  kind,
  onDone,
}: {
  po: PurchaseOrder;
  kind: Exclude<POCommand["kind"], "save" | "core">;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [requestUuid] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState("");
  const [invoice, setInvoice] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [conditions, setConditions] = useState<
    Record<string, "new" | "overhauled" | "as removed" | "core">
  >({});
  const [serials, setSerials] = useState<
    Record<string, { serial: string; hours: string; cycles: string }[]>
  >({});
  const [expirations, setExpirations] = useState<Record<string, string>>({});
  return (
    <AsyncForm
      submitLabel={
        kind === "receive"
          ? "Confirm receipt into inventory"
          : kind === "ship"
            ? "Save shipment"
            : kind === "issue"
              ? "Finalize PO"
              : "Confirm"
      }
      disabled={!online || !connected}
      onSubmit={async () => {
        let c: POCommand;
        if (kind === "ship" || kind === "receive") {
          const lines = po.lines
            .filter((l) => (quantities[l.uuid] ?? 0) > 0)
            .map((l) => ({
              lineUuid: l.uuid,
              quantity: quantities[l.uuid],
              condition: conditions[l.uuid] ?? "new",
              expirationDate: expirations[l.uuid] || undefined,
              serials: (serials[l.uuid] ?? []).map((x) => ({
                serial: x.serial,
                hours: Number(x.hours),
                cycles: Number(x.cycles),
              })),
            }));
          if (!lines.length)
            throw Error("Enter a quantity for at least one line.");
          c =
            kind === "ship"
              ? {
                  kind,
                  requestUuid,
                  uuid: po.uuid,
                  version: po.version,
                  date,
                  carrier,
                  tracking,
                  lines: lines.map(({ lineUuid, quantity }) => ({
                    lineUuid,
                    quantity,
                  })),
                }
              : {
                  kind,
                  requestUuid,
                  uuid: po.uuid,
                  version: po.version,
                  date,
                  invoice,
                  notes: reason,
                  lines,
                };
        } else
          c = { kind, requestUuid, uuid: po.uuid, version: po.version, reason };
        await backend!.purchaseOrder(c);
        onDone();
      }}
    >
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
      {(kind === "ship" || kind === "receive") && (
        <>
          <div className="form-grid">
            <Field label={kind === "ship" ? "Shipment date" : "Receipt date"}>
              <input
                type="date"
                required
                max={today()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            {kind === "ship" ? (
              <>
                <Field label="Carrier">
                  <input
                    value={carrier}
                    onChange={(e) => setCarrier(e.target.value)}
                  />
                </Field>
                <Field label="Tracking number">
                  <input
                    value={tracking}
                    onChange={(e) => setTracking(e.target.value)}
                  />
                </Field>
              </>
            ) : (
              <Field label="Invoice number">
                <input
                  value={invoice}
                  onChange={(e) => setInvoice(e.target.value)}
                />
              </Field>
            )}
          </div>
          {po.lines.map((l) => {
            const max =
              kind === "ship"
                ? l.quantity -
                  l.cancelled -
                  Math.max(shipped(po, l), received(po, l))
                : outstanding(po, l);
            if (max <= 0) return null;
            return (
              <fieldset className="po-line" key={l.uuid}>
                <legend>
                  {l.partNumber} · Outstanding {max}
                  {l.repairComponentUuid
                    ? " · Existing component repair / return"
                    : ""}
                </legend>
                <Field
                  label={`${l.partNumber} ${kind === "ship" ? "quantity shipped" : "quantity received"}`}
                >
                  <input
                    type="number"
                    min="0"
                    max={Math.min(max, l.kind === "component" ? 100 : max)}
                    step="1"
                    value={quantities[l.uuid] ?? 0}
                    onChange={(e) => {
                      const quantity = Number(e.target.value);
                      setQuantities({ ...quantities, [l.uuid]: quantity });
                      if (l.kind === "component" && kind === "receive")
                        setSerials({
                          ...serials,
                          [l.uuid]: Array.from(
                            { length: Math.max(0, Math.min(quantity, 100)) },
                            (_, i) =>
                              serials[l.uuid]?.[i] ?? {
                                serial: (() => {
                                  const c = s?.management?.find(
                                    (c) =>
                                      c.kind === "component" &&
                                      c.uuid === l.repairComponentUuid,
                                  );
                                  return c?.kind === "component"
                                    ? c.serial
                                    : "";
                                })(),
                                hours: "",
                                cycles: "",
                              },
                          ),
                        });
                    }}
                  />
                </Field>
                {kind === "receive" && (quantities[l.uuid] ?? 0) > 0 && (
                  <>
                    <Field label={`${l.partNumber} received condition`}>
                      <select
                        value={conditions[l.uuid] ?? "new"}
                        onChange={(e) =>
                          setConditions({
                            ...conditions,
                            [l.uuid]: e.target.value as "new",
                          })
                        }
                      >
                        {["new", "overhauled", "as removed", "core"].map(
                          (x) => (
                            <option key={x}>{x}</option>
                          ),
                        )}
                      </select>
                    </Field>
                    {!l.repairComponentUuid && (
                      <Field
                        label={`${l.partNumber} expiration date`}
                        hint="Optional shelf-life limit. A different date is stored as a separate stock lot."
                      >
                        <input
                          type="date"
                          value={expirations[l.uuid] ?? ""}
                          onChange={(e) =>
                            setExpirations({
                              ...expirations,
                              [l.uuid]: e.target.value,
                            })
                          }
                        />
                      </Field>
                    )}
                    {l.exchange && (
                      <p>
                        Exchange unit: a core return will be due{" "}
                        {l.coreDueDays ?? DEFAULT_CORE_DUE_DAYS} days after this
                        receipt.
                      </p>
                    )}
                    {l.kind === "component" && (
                      <p>
                        Enter verified total time and cycles for each serial
                        number. Components are received into inventory, not
                        installed on an aircraft.
                      </p>
                    )}
                    {(serials[l.uuid] ?? []).map((serial, index) => (
                      <div className="form-grid" key={index}>
                        {(["serial", "hours", "cycles"] as const).map(
                          (field) => (
                            <Field
                              key={field}
                              label={`${l.partNumber} item ${index + 1} ${field === "hours" ? "time since new (hours)" : field === "cycles" ? "cycles since new" : "serial number"}`}
                            >
                              <input
                                required
                                type={field === "serial" ? "text" : "number"}
                                min="0"
                                step={field === "hours" ? "any" : "1"}
                                readOnly={
                                  field === "serial" && !!l.repairComponentUuid
                                }
                                value={serial[field]}
                                onChange={(e) =>
                                  setSerials({
                                    ...serials,
                                    [l.uuid]: serials[l.uuid].map((x, i) =>
                                      i === index
                                        ? { ...x, [field]: e.target.value }
                                        : x,
                                    ),
                                  })
                                }
                              />
                            </Field>
                          ),
                        )}
                      </div>
                    ))}
                  </>
                )}
              </fieldset>
            );
          })}
        </>
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
function POFiles({ po }: { po: PurchaseOrder }) {
  const { backend, online, connected } = useWorkspace();
  const [files, setFiles] = useState<
    { uuid: string; name: string; url: string | null; receiptUuid?: string }[]
  >([]);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    backend
      ?.poFiles(po.uuid)
      .then((f) => {
        if (!cancelled) setFiles(f);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [backend, po.uuid, refresh]);
  return (
    <section>
      <h3>Attachments</h3>
      <p>
        Attach invoices, packing slips, photos, or 8130 documents. Receipt
        attachments are also linked to the received inventory items.
      </p>
      <Field label="Attach files to">
        <select value={receipt} onChange={(e) => setReceipt(e.target.value)}>
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
          accept=".pdf,.jpg,.jpeg,.png,.webp"
          disabled={!online || !connected || busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
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
          }}
        />
      </Field>
      {busy && <p role="status">Uploading…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul>
        {files.map((f) => (
          <li key={f.uuid}>
            <a href={f.url ?? undefined} target="_blank" rel="noreferrer">
              {f.name}
            </a>
            {f.receiptUuid ? " · Receipt attachment" : ""}{" "}
            {poAttachmentRemovable(po) && online && connected && (
              <DeleteFileButton
                name={f.name}
                onDelete={async () => {
                  await backend!.removePOFile(f.uuid);
                  setRefresh((n) => n + 1);
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
