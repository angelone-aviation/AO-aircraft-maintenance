import { VendorPicker, newVendor } from "./Vendors";
import { localDate } from "../domain/model";
import { vendorDirectory, vendorKey } from "../domain/vendors";
import type { Vendor } from "../domain/management";
import { SpruceProductPicker } from "./AircraftSpruce";
import { SavedAddressPicker } from "./SavedAddresses";
import { formatAddress } from "../domain/addresses";
import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useWorkspace } from "../data/store";
import { can, type Snapshot } from "../domain/model";
import { programPermission } from "../domain/programs";
import { partsInventory } from "../domain/requiredParts";
import { expiredForUse, usableQuantity } from "../domain/shelfLife";
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
} from "../domain/partsRequests";
import { poLineSchema, type PODraft } from "../domain/purchaseOrders";
import { POEditor, PODetail } from "./PurchaseOrders";
import { AsyncForm, Field, Modal } from "./ui";
import {
  EmptyState,
  PageHeader,
  SearchField,
  StatusPill,
  Toolbar,
} from "./design";
import { ShopLead, ShopSelect, ShopTableCard } from "./ShopList";
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
const today = () => localDate();
// Keep empty editable fields until the form is submitted.
const newLine = (): RequestLine => ({
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
});
function newDraft(s: Snapshot, source: RequestSource): RequestDraft {
  const resolved = resolveRequestSource(s, source);
  const component = s.management?.find(
    (r) => r.kind === "component" && r.uuid === resolved.componentUuid,
  );
  const stock =
    source.kind === "stock"
      ? s.management?.find((r) => r.kind === "stock" && r.uuid === source.uuid)
      : undefined;
  const linked =
    source.kind === "inspection"
      ? s.inspections.find((r) => r.uuid === source.uuid)
      : source.kind === "discrepancy"
        ? s.discrepancies.find((r) => r.uuid === source.uuid)
        : source.kind === "jobCard"
          ? s.taskCards?.find((r) => r.uuid === source.uuid)
          : source.kind === "componentRequirement"
            ? s.management?.find(
                (r) =>
                  r.uuid === source.uuid && r.kind === "componentRequirement",
              )
            : undefined;
  const reference =
    linked && "manualReference" in linked && linked.manualReference
      ? `${linked.manualReference.section} · printed page ${linked.manualReference.printedPage} · PDF page ${linked.manualReference.pdfPage}`
      : "";
  const inventory = partsInventory(s);
  const requested =
    linked && "requiredParts" in linked && Array.isArray(linked.requiredParts)
      ? linked.requiredParts.flatMap((p) => {
          const stock = inventory.stock.find((x) => x.uuid === p.stockUuid);
          return stock
            ? [
                {
                  ...newLine(),
                  partNumber: stock.partNumber,
                  description: stock.description,
                  quantity: p.quantity,
                  ipcReference: reference,
                },
              ]
            : [];
        })
      : [];
  const line = { ...newLine(), ipcReference: reference };
  if (stock?.kind === "stock")
    Object.assign(line, {
      partNumber: stock.partNumber,
      description: stock.description,
      alternateNumber: stock.alternates,
    });
  if (
    source.kind === "component" &&
    component?.kind === "component" &&
    !component.installed
  )
    Object.assign(line, {
      partNumber: component.partNumber,
      description: `${component.manufacturer} ${component.model ?? component.componentType}`,
      componentUuid: component.uuid,
    });
  const location = s.management?.find(
    (r) =>
      r.kind === "location" &&
      r.uuid ===
        (stock?.kind === "stock"
          ? stock.locationUuid
          : component?.kind === "component"
            ? component.locationUuid
            : ""),
  );
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    source,
    recurring: requested.length > 0 && !!recurringRequestSource(s, source),
    mode:
      source.kind === "component" &&
      component?.kind === "component" &&
      !component.installed
        ? "repair"
        : "parts",
    date: today(),
    engineer: s.user.name,
    base: location?.kind === "location" ? location.name : "",
    priority: source.kind === "stock" ? "P3 Stock" : "P2 Routine",
    requiredBy: "",
    timeframe: "",
    vendor: stock?.kind === "stock" ? (stock.vendor ?? "") : "",
    vendorAddress: "",
    currency: "USD",
    shipTo: location?.kind === "location" ? location.address : "",
    shipToDetails:
      location?.kind === "location" ? location.addressDetails : undefined,
    billTo: "",
    shipFrom: "",
    aircraftYear: "",
    notes: "",
    shippingInstructions: "",
    returnInstructions: "",
    lines: requested.length ? requested : [line],
  };
}
export function RequestPartsButton({
  source,
  label = "Parts / repair requests",
  initialOpen = false,
  onClose,
}: {
  source: RequestSource;
  label?: string;
  initialOpen?: boolean;
  onClose?: () => void;
}) {
  const { snapshot: s } = useWorkspace();
  const [open, setOpen] = useState(initialOpen);
  if (!s) return null;
  let resolved;
  try {
    resolved = resolveRequestSource(s, source);
  } catch {
    return null;
  }
  if (
    !(resolved.aircraftUuid
      ? can(s, resolved.aircraftUuid, "read")
      : programPermission(s, "admin"))
  )
    return null;
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
      {open &&
        createPortal(
          <div onSubmit={(e) => e.stopPropagation()}>
            <Modal
              title={label}
              wide
              onClose={() => {
                setOpen(false);
                onClose?.();
              }}
            >
              <RequestWorkspace source={source} />
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}
export function PartsRequests() {
  return <RequestWorkspace page />;
}
const requestTone = (status: string) =>
  status === "Requested"
    ? "warn"
    : status === "Fulfilled" || status === "Received / awaiting issue"
      ? "good"
      : "neutral";
function RequestWorkspace({
  source,
  page = false,
}: {
  source?: RequestSource;
  page?: boolean;
}) {
  const { snapshot: s, online, connected } = useWorkspace();
  const [edit, setEdit] = useState<RequestDraft>();
  const [view, setView] = useState<string>();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [aircraft, setAircraft] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [draftPO, setDraftPO] = useState<PODraft>();
  const [error, setError] = useState("");
  if (!s) return null;
  const admin = programPermission(s, "admin");
  const all = (s.partsRequests ?? []).filter(
    (r) => !source || requestMatchesSource(s, r, source),
  );
  const rows = all
    .filter(
      (r) =>
        (!priority || r.priority === priority) &&
        (!aircraft || r.aircraftUuid === aircraft) &&
        (!status || requestStatus(s, r) === status) &&
        `${r.number} ${r.vendor} ${r.engineer} ${r.aircraftRegistration} ${r.sourceLabel} ${r.lines.map((l) => `${l.partNumber} ${l.description}`).join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const current = all.find((r) => r.uuid === view);
  const writable = online && connected;
  const canCreate = source
    ? (() => {
        try {
          const a = resolveRequestSource(s, source).aircraftUuid;
          return a ? can(s, a, "maintenance") : admin;
        } catch {
          return false;
        }
      })()
    : admin || s.aircraft.some((a) => can(s, a.uuid, "maintenance"));
  const newRequest = canCreate ? (
    <button
      type="button"
      className="button primary"
      disabled={!writable}
      onClick={() => {
        setError("");
        try {
          setEdit(newDraft(s, source ?? sourceOptions(s)[0].value));
        } catch (e) {
          setError(String(e));
        }
      }}
    >
      <Plus size={18} weight="bold" aria-hidden="true" />
      New request
    </button>
  ) : undefined;
  return (
    <div className="parts-requests">
      {page && (
        <PageHeader
          eyebrow="MAINTENANCE"
          title="Parts & repair requests"
          description="What mechanics need, what's been ordered, and what's out for repair. Request, reserve and issue parts, or track a component through repair and return."
          actions={newRequest}
        />
      )}
      <Toolbar className="shop-toolbar" end={page ? undefined : newRequest}>
        <SearchField
          label="Search requests"
          placeholder="Part, request, vendor or requester"
          value={search}
          onChange={setSearch}
        />
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
        <ShopSelect
          label="Priority"
          icon={Flag}
          value={priority}
          onChange={setPriority}
        >
          <option value="">All priorities</option>
          {["P1 AOG", "P2 Routine", "P3 Stock"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </ShopSelect>
        <ShopSelect
          label="Status"
          icon={Funnel}
          value={status}
          onChange={setStatus}
        >
          <option value="">All statuses</option>
          {[
            "Recurring",
            "Requested",
            "Reserved",
            "On purchase order",
            "Out for repair",
            "Received / awaiting issue",
            "Partially issued",
            "Fulfilled",
            "Cancelled",
          ].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </ShopSelect>
      </Toolbar>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ShopTableCard
        label="Parts and repair requests"
        className="shop-compact"
        stack
        title={
          <>
            Requests{" "}
            <span className="shop-count">
              {String(rows.length).padStart(2, "0")}
            </span>
          </>
        }
        actions={
          admin && (
            <button
              type="button"
              className="button small"
              disabled={!writable || !selected.length}
              onClick={() => {
                try {
                  setDraftPO(requestPODraft(s, selected));
                  setError("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <Receipt size={17} aria-hidden="true" />
              Add selected to purchase order ({selected.length})
            </button>
          )
        }
      >
        {rows.length ? (
          <table
            className="shop-table"
            style={{ "--shop-table-min": "900px" } as CSSProperties}
          >
            <thead>
              <tr>
                {admin && <th>Select</th>}
                <th>Request / aircraft</th>
                <th>Parts / source</th>
                <th>Priority / needed</th>
                <th>Vendor / requester</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const state = requestStatus(s, r);
                return (
                  <tr key={r.uuid}>
                    {admin && (
                      <td className="shop-select-cell">
                        <label className="shop-check-hit">
                          <input
                            type="checkbox"
                            className="shop-check"
                            aria-label={`Select ${r.number}`}
                            checked={selected.includes(r.uuid)}
                            disabled={
                              r.recurring ||
                              r.cancelled ||
                              !r.lines.some(
                                (l) =>
                                  requestLineProgress(s, r, l.uuid).toOrder > 0,
                              )
                            }
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, r.uuid]
                                  : selected.filter((x) => x !== r.uuid),
                              )
                            }
                          />
                        </label>
                      </td>
                    )}
                    <td className="shop-wide">
                      <ShopLead
                        icon={r.mode === "repair" ? ArrowsLeftRight : Package}
                        tone={requestTone(state)}
                        title={
                          <button
                            type="button"
                            className="shop-title-button"
                            onClick={() => setView(r.uuid)}
                          >
                            {r.number}
                          </button>
                        }
                        sub={`${r.aircraftRegistration || "Stock"} · ${r.mode}`}
                      />
                    </td>
                    <td className="shop-wide" data-label="Parts">
                      <span className="shop-pr-lines">
                        {r.lines.map((l) => (
                          <span className="shop-pr-line" key={l.uuid}>
                            <strong>{l.partNumber}</strong> × {l.quantity} —{" "}
                            {l.description}
                          </span>
                        ))}
                      </span>
                      <small>
                        {r.recurring
                          ? "Recurring · "
                          : r.templateUuid
                            ? "Recurring occurrence · "
                            : ""}
                        {r.sourceLabel}
                      </small>
                    </td>
                    <td data-label="Priority">
                      <StatusPill
                        tone={r.priority === "P1 AOG" ? "danger" : "neutral"}
                        dot={r.priority === "P1 AOG"}
                      >
                        {r.priority}
                      </StatusPill>
                      <small>
                        {r.requiredBy || r.timeframe || "No date specified"}
                      </small>
                    </td>
                    <td data-label="Vendor">
                      {r.vendor || "Unassigned"}
                      <small>{r.engineer}</small>
                    </td>
                    <td data-label="Status">
                      <StatusPill tone={requestTone(state)}>{state}</StatusPill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="shop-table-empty">
            <EmptyState
              title={
                all.length
                  ? "No requests match these filters"
                  : "No requests yet"
              }
            >
              {all.length
                ? "Clear the search or filters to see every request."
                : "Create a request here, or from an inspection, discrepancy, work order, job card or component."}
            </EmptyState>
          </div>
        )}
      </ShopTableCard>
      {edit && (
        <Modal
          title={edit.version ? "Edit request" : "New parts / repair request"}
          wide
          onClose={() => setEdit(undefined)}
        >
          <RequestEditor
            initial={edit}
            chooseSource={!source && !edit.version}
            onDone={() => setEdit(undefined)}
          />
        </Modal>
      )}
      {current && (
        <Modal
          title={`${current.number} · ${requestStatus(s, current)}`}
          wide
          onClose={() => setView(undefined)}
        >
          <RequestDetail
            request={current}
            onEdit={() => {
              setView(undefined);
              setEdit(current);
            }}
          />
        </Modal>
      )}
      {draftPO && (
        <Modal
          title="Purchase requested parts / repair services"
          wide
          onClose={() => setDraftPO(undefined)}
        >
          <POEditor
            initial={draftPO}
            onDone={() => {
              setDraftPO(undefined);
              setSelected([]);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function sourceOptions(s: Snapshot): { value: RequestSource; label: string }[] {
  const option = (
    kind: RequestSource["kind"],
    uuid: string,
    label: string,
    workOrderUuid = "",
  ) => ({ value: { kind, uuid, workOrderUuid }, label });
  return [
    ...(programPermission(s, "admin")
      ? [option("stock", "", "Inventory stock request")]
      : []),
    ...s.discrepancies
      .filter((r) => can(s, r.aircraftUuid, "maintenance"))
      .map((r) =>
        option("discrepancy", r.uuid, `Discrepancy: ${r.description}`),
      ),
    ...(s.airworthiness ?? []).flatMap((ad) =>
      ad.tasks.flatMap((task) => {
        const source: RequestSource = {
          kind: "airworthiness",
          uuid: task.uuid,
          workOrderUuid: "",
        };
        try {
          const resolved = resolveRequestSource(s, source);
          return can(s, resolved.aircraftUuid, "maintenance")
            ? [option("airworthiness", task.uuid, resolved.label)]
            : [];
        } catch {
          return [];
        }
      }),
    ),
    ...s.inspections
      .filter((r) => can(s, r.aircraftUuid, "maintenance"))
      .map((r) =>
        option(
          "inspection",
          r.uuid,
          `Inspection: ${r.reference} — ${r.description}`,
        ),
      ),
    ...(s.workOrders ?? [])
      .filter((r) => can(s, r.aircraftUuid, "maintenance"))
      .flatMap((w) =>
        w.tasks.map((t) =>
          option("workTask", t.uuid, `${w.number}: ${t.description}`, w.uuid),
        ),
      ),
    ...(s.taskCards ?? [])
      .filter((r) => can(s, r.aircraftUuid, "maintenance"))
      .map((r) => option("jobCard", r.uuid, `${r.cardNumber}: ${r.title}`)),
    ...(s.management ?? [])
      .filter(
        (r) => r.kind === "componentRequirement" || r.kind === "component",
      )
      .filter(
        (r) =>
          "aircraftUuid" in r &&
          (r.aircraftUuid
            ? can(s, r.aircraftUuid, "maintenance")
            : programPermission(s, "admin")),
      )
      .map((r) =>
        option(
          r.kind as "component" | "componentRequirement",
          r.uuid,
          r.kind === "component"
            ? `${r.partNumber} S/N ${r.serial}`
            : r.kind === "componentRequirement"
              ? r.description
              : "",
        ),
      ),
  ];
}
function RequestEditor({
  initial,
  chooseSource,
  onDone,
}: {
  initial: RequestDraft;
  chooseSource: boolean;
  onDone: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [draft, setDraft] = useState(initial);
  const [addedVendors, setAddedVendors] = useState<Vendor[]>([]);
  const vendorOptions = [
    ...new Map(
      [...vendorDirectory(s!), ...addedVendors].map((v) => [
        vendorKey(v.name),
        v,
      ]),
    ).values(),
  ];
  const selectVendor = (name: string, vendor?: Vendor) =>
    setDraft((d) => ({
      ...d,
      vendor: vendor?.name ?? name,
      vendorAddressDetails: vendor?.addressDetails,
      vendorAddress: vendor?.addressDetails
        ? formatAddress(vendor.addressDetails)
        : "",
    }));
  const [requestUuid] = useState(() => crypto.randomUUID());
  const patch = (p: Partial<RequestDraft>) => setDraft((d) => ({ ...d, ...p }));
  const linePatch = (uuid: string, p: Partial<RequestLine>) =>
    patch({
      lines: draft.lines.map((l) =>
        l.uuid === uuid
          ? {
              ...l,
              ...p,
              ...(!("sprucePart" in p) &&
              p.partNumber !== undefined &&
              p.partNumber !== l.partNumber
                ? { sprucePart: undefined }
                : {}),
            }
          : l,
      ),
    });
  const resolved = resolveRequestSource(s!, draft.source);
  const components = (s!.management ?? []).filter(
    (r): r is import("../domain/components").Component =>
      r.kind === "component" &&
      !r.installed &&
      !r.outForRepair &&
      (!resolved.aircraftUuid ||
        !r.aircraftUuid ||
        r.aircraftUuid === resolved.aircraftUuid),
  );
  const inventory = partsInventory(s!);
  const sources = sourceOptions(s!);
  const input = (
    key:
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
      | "returnInstructions",
    label: string,
    type = "text",
  ) => (
    <Field label={label}>
      <input
        type={type}
        value={draft[key]}
        onChange={(e) => patch({ [key]: e.target.value })}
        required={key === "date" || key === "engineer" || key === "currency"}
      />
    </Field>
  );
  return (
    <AsyncForm
      submitLabel="Save request"
      disabled={!online || !connected}
      onSubmit={async () => {
        await backend!.partsRequest({
          kind: "save",
          requestUuid,
          draft: requestDraftSchema.parse(draft),
        });
        onDone();
      }}
    >
      {chooseSource && (
        <Field label="Request for">
          <select
            value={JSON.stringify(draft.source)}
            onChange={(e) => {
              const source = JSON.parse(e.target.value) as RequestSource;
              setDraft({ ...newDraft(s!, source), uuid: draft.uuid });
            }}
          >
            {sources.map((o) => (
              <option
                key={JSON.stringify(o.value)}
                value={JSON.stringify(o.value)}
              >
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <p className="notice">
        {resolved.label}
        <br />
        {resolved.aircraft
          ? `${resolved.aircraft.registration} · ${resolved.aircraft.make} ${resolved.aircraft.model} · Aircraft S/N ${resolved.aircraft.serial}`
          : "Inventory stock request"}
      </p>
      {draft.mode === "parts" &&
        (draft.recurring || recurringRequestSource(s!, draft.source)) && (
          <section className="notice">
            <label>
              <input
                type="checkbox"
                checked={!!draft.recurring}
                disabled={!!draft.version}
                onChange={(e) => patch({ recurring: e.target.checked })}
              />{" "}
              Recurring — required each time this inspection/service/AD task is
              performed
            </label>
            {draft.recurring && (
              <p>
                Recurring ·{" "}
                {
                  resolveRequestSource(
                    s!,
                    recurringRequestSource(s!, draft.source) ?? draft.source,
                  ).label
                }
                . Follows its maintenance schedule. Each open work-order
                occurrence gets a separate request. Reserve stock and order
                parts from that occurrence.
              </p>
            )}
          </section>
        )}
      <div className="request-grid">
        <Field label="Request type">
          <select
            value={draft.mode}
            onChange={(e) =>
              patch({
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
        {input("date", "Request date", "date")}
        {input("engineer", "Engineer / requester")}
        <Field label="Inventory location">
          <select
            value={draft.base}
            onChange={(e) => patch({ base: e.target.value })}
          >
            <option value="">Select inventory location</option>
            {draft.base &&
              !inventory.locations.some(
                (location) => location.name === draft.base,
              ) && (
                <option value={draft.base}>
                  {draft.base} (previously saved)
                </option>
              )}
            {[
              ...new Set(inventory.locations.map((location) => location.name)),
            ].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {!inventory.locations.length && (
            <small>
              Add an inventory location in this Flight Program to select it
              here.
            </small>
          )}
        </Field>
        <Field label="Priority">
          <select
            value={draft.priority}
            onChange={(e) =>
              patch({ priority: e.target.value as RequestDraft["priority"] })
            }
          >
            {["P1 AOG", "P2 Routine", "P3 Stock"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        {input("requiredBy", "Required by", "date")}
        {input("timeframe", "Anticipated timeframe")}
        <VendorPicker
          label="Preferred vendor"
          value={draft.vendor}
          options={vendorOptions}
          disabled={!online || !connected}
          nameOnly
          customLabel={
            programPermission(s!, "admin")
              ? "Create custom vendor"
              : "Use custom vendor"
          }
          onChange={selectVendor}
          onAdd={async (name) => {
            const record = newVendor(name);
            if (programPermission(s!, "admin")) {
              await backend!.manage({
                action: "record.save",
                record,
                requestUuid: crypto.randomUUID(),
                reason: "Vendor created from parts request",
              });
              record.version = 1;
            }
            setAddedVendors((previous) => [...previous, record]);
            selectVendor(record.name, record);
          }}
        />

        {input("currency", "Currency")}

        {input("aircraftYear", "Aircraft year (if known)")}
      </div>
      <SavedAddressPicker
        label="Deliver / return to"
        inventoryLocationName={draft.base}
        value={draft.shipToDetails}
        legacy={draft.shipTo}
        onChange={(address) =>
          patch({ shipToDetails: address, shipTo: formatAddress(address) })
        }
      />
      {draft.lines.map((l, index) => (
        <section className="request-line" key={l.uuid}>
          <h3>Item {index + 1}</h3>
          {draft.mode === "parts" && (
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
                  ...(!l.description
                    ? { description: product.description }
                    : {}),
                  ...(cents !== undefined ? { quotedCents: cents } : {}),
                });
                setDraft((d) => ({
                  ...d,
                  vendor: d.vendor || "Aircraft Spruce",
                }));
              }}
            />
          )}
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
          {draft.mode === "repair" && (
            <Field label="Existing serialized component">
              <select
                required
                value={l.componentUuid}
                onChange={(e) => {
                  const c = components.find((c) => c.uuid === e.target.value);
                  if (c?.kind === "component")
                    linePatch(l.uuid, {
                      componentUuid: c.uuid,
                      partNumber: c.partNumber,
                      description: `${c.manufacturer} ${c.model ?? c.componentType}`,
                      quantity: 1,
                    });
                }}
              >
                <option value="">Choose an uninstalled component</option>
                {components.map((c) => (
                  <option key={c.uuid} value={c.uuid}>
                    {c.partNumber} · S/N {c.serial}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="request-grid">
            <Field label="Part number">
              <input
                required
                value={l.partNumber}
                readOnly={draft.mode === "repair"}
                onChange={(e) =>
                  linePatch(l.uuid, { partNumber: e.target.value })
                }
              />
            </Field>
            <Field label="Alternate part number">
              <input
                value={l.alternateNumber}
                onChange={(e) =>
                  linePatch(l.uuid, { alternateNumber: e.target.value })
                }
              />
            </Field>
            <Field label="Part name">
              <input
                required
                value={l.description}
                onChange={(e) =>
                  linePatch(l.uuid, { description: e.target.value })
                }
              />
            </Field>
            <Field label="Quantity">
              <input
                type="number"
                min={1}
                step={1}
                required
                value={l.quantity}
                readOnly={draft.mode === "repair"}
                onChange={(e) =>
                  linePatch(l.uuid, { quantity: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="IPC / manual reference">
              <input
                value={l.ipcReference}
                onChange={(e) =>
                  linePatch(l.uuid, { ipcReference: e.target.value })
                }
              />
            </Field>
            {draft.mode === "repair" && (
              <>
                <Field label="Work type">
                  <select
                    value={l.service}
                    onChange={(e) =>
                      linePatch(l.uuid, {
                        service: e.target.value as RequestLine["service"],
                      })
                    }
                  >
                    <option>repair</option>
                    <option>overhaul</option>
                    <option>inspection</option>
                  </select>
                </Field>
                <Field label={`Quoted cost (${draft.currency})`}>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={l.quotedCents / 100}
                    onChange={(e) =>
                      linePatch(l.uuid, {
                        quotedCents: Math.round(Number(e.target.value) * 100),
                      })
                    }
                  />
                </Field>
              </>
            )}
          </div>
          {draft.mode === "repair" ? (
            <>
              <Field label="Defect">
                <textarea
                  required
                  value={l.defect}
                  onChange={(e) =>
                    linePatch(l.uuid, { defect: e.target.value })
                  }
                />
              </Field>
              <Field label="Work requested">
                <textarea
                  required
                  value={l.workRequested}
                  onChange={(e) =>
                    linePatch(l.uuid, { workRequested: e.target.value })
                  }
                />
              </Field>
            </>
          ) : (
            <StockAvailability
              partNumber={l.partNumber}
              alternate={l.alternateNumber}
              needed={l.quantity}
            />
          )}
          {draft.lines.length > 1 && (
            <button
              type="button"
              className="button small"
              onClick={() =>
                patch({ lines: draft.lines.filter((x) => x.uuid !== l.uuid) })
              }
            >
              Remove item
            </button>
          )}
        </section>
      ))}
      <button
        type="button"
        className="button"
        onClick={() => patch({ lines: [...draft.lines, newLine()] })}
      >
        Add part / component
      </button>
      {draft.mode === "repair" && (
        <div className="request-grid">
          <SavedAddressPicker
            label="Ship from"
            inventoryLocationName={draft.base}
            value={draft.shipFromDetails}
            legacy={draft.shipFrom}
            onChange={(address) =>
              patch({
                shipFromDetails: address,
                shipFrom: formatAddress(address),
              })
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
          {input("shippingInstructions", "Shipping instructions")}
          {input("returnInstructions", "Return instructions")}
        </div>
      )}
      <Field
        label={draft.mode === "repair" ? "Repair notes" : "Ordering notes"}
      >
        <textarea
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </Field>
      {!inventory.locations.length && (
        <p className="notice">
          An inventory administrator must create a delivery location before
          purchasing or receiving.
        </p>
      )}
    </AsyncForm>
  );
}
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
      ["new", "overhauled"].includes(x.condition ?? "new"),
  );
  // Expired lots cannot be reserved or issued, so they are never available.
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
              <td>
                {
                  inventory.locations.find((l) => l.uuid === x.locationUuid)
                    ?.name
                }
              </td>
              <td>{x.quantity}</td>
              <td>{x.reservedQuantity ?? 0}</td>
              <td>{usableQuantity(x)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!stock.length && <p>No matching inventory stock.</p>}
    </div>
  );
}
function RequestDetail({
  request: r,
  onEdit,
}: {
  request: PartsRequest;
  onEdit: () => void;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [poUuid, setPoUuid] = useState("");
  const [editPO, setEditPO] = useState<PODraft>();
  const [docError, setDocError] = useState("");
  const po = s!.purchaseOrders?.find((p) => p.uuid === poUuid);
  const admin = programPermission(s!, "admin");
  return (
    <div className="parts-requests">
      <p>
        <strong>{r.aircraftRegistration || "Stock"}</strong> ·{" "}
        <a
          href={
            r.source.kind === "airworthiness"
              ? "/airworthiness"
              : r.source.kind === "stock"
                ? "/inventory"
                : r.source.kind === "workTask"
                  ? "/work-orders"
                  : r.source.kind === "jobCard"
                    ? "/task-cards"
                    : r.source.kind === "inspection"
                      ? "/inspections"
                      : r.source.kind === "discrepancy"
                        ? "/discrepancies"
                        : "/components"
          }
        >
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
          {s!.partsRequests?.find((t) => t.uuid === r.templateUuid)?.number ??
            r.templateUuid}
        </p>
      )}
      <div className="management-actions">
        {!r.cancelled &&
          (r.aircraftUuid ? can(s!, r.aircraftUuid, "maintenance") : admin) && (
            <button
              type="button"
              className="button"
              onClick={onEdit}
              disabled={!online || !connected}
            >
              Edit request
            </button>
          )}
        <button
          type="button"
          className="button"
          onClick={async () => {
            try {
              const { requestPdf } = await import("../data/partsRequestPdf");
              requestPdf(r, s!, "request").save(`${r.number}.pdf`);
            } catch (e) {
              setDocError(String(e));
            }
          }}
        >
          Download{" "}
          {r.mode === "repair" ? "repair order / tag" : "parts request"}
        </button>
        {r.mode === "repair" && (
          <button
            type="button"
            className="button"
            onClick={async () => {
              try {
                const { requestPdf } = await import("../data/partsRequestPdf");
                requestPdf(r, s!, "packing").save(
                  `${r.number}-packing-slip.pdf`,
                );
              } catch (e) {
                setDocError(String(e));
              }
            }}
          >
            Download packing slip
          </button>
        )}
      </div>
      {docError && (
        <p role="alert" className="error">
          {docError}
        </p>
      )}
      {r.lines.map((l) => {
        const p = requestLineProgress(s!, r, l.uuid);
        return (
          <section className="request-line" key={l.uuid}>
            <h3>
              {l.partNumber} — {l.description} × {l.quantity}
            </h3>
            <p>
              Reserved {p.reserved} · Issued {p.issued} · On POs {p.ordered} ·
              Received {p.received} · To order {p.toOrder}
            </p>
            {l.ipcReference && <p>IPC / manual: {l.ipcReference}</p>}
            {r.mode === "repair" ? (
              <p>
                {l.service} · Defect: {l.defect}
                <br />
                Work requested: {l.workRequested}
              </p>
            ) : (
              <StockAvailability
                partNumber={l.partNumber}
                alternate={l.alternateNumber}
                needed={p.remaining}
              />
            )}
            {p.purchases.map((a, i) => (
              <p key={`${a.poUuid}-${i}`}>
                <button
                  type="button"
                  className="text-button"
                  disabled={!admin}
                  onClick={() => setPoUuid(a.poUuid)}
                >
                  {a.number}
                </button>{" "}
                · {a.phase} · Qty {a.quantity} · Received {a.received} ·
                Expected {a.expectedDate || "Not specified"}
                {a.purchasedDate &&
                  ` · Purchased ${a.purchasedDate} by ${(s!.members ?? []).find((m) => m.id === a.purchasedBy)?.name ?? a.purchasedBy}`}
              </p>
            ))}
            {admin && !r.cancelled && !r.recurring && r.mode === "parts" && (
              <ReservationForm request={r} line={l} />
            )}
          </section>
        );
      })}
      <p>{r.notes}</p>
      {admin && !r.cancelled && (
        <details>
          <summary>Cancel request</summary>
          <AsyncForm
            submitLabel="Cancel request and release reservations"
            disabled={!online || !connected}
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
              Issued parts and purchasing history remain recorded. Outstanding
              PO quantities must be cancelled first.
            </p>
          </AsyncForm>
        </details>
      )}
      <details>
        <summary>Request history ({r.history.length})</summary>
        {r.history.map((h, i) => (
          <p key={i}>
            {new Date(h.at).toLocaleString()} · {h.action} ·{" "}
            {s!.members.find((m) => m.id === h.actorId)?.name ?? h.actorId}
          </p>
        ))}
      </details>
      {editPO && (
        <Modal
          title="Edit purchase order"
          wide
          onClose={() => setEditPO(undefined)}
        >
          <POEditor initial={editPO} onDone={() => setEditPO(undefined)} />
        </Modal>
      )}
      {po && (
        <Modal title={po.number} wide onClose={() => setPoUuid("")}>
          <PODetail
            po={po}
            onEdit={() => {
              setEditPO(po);
              setPoUuid("");
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function ReservationForm({
  request: r,
  line,
}: {
  request: PartsRequest;
  line: RequestLine;
}) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [stockUuid, setStock] = useState("");
  const [operation, setOperation] = useState<"reserve" | "release" | "issue">(
    "reserve",
  );
  const [quantity, setQuantity] = useState(1);
  const [alternate, setAlternate] = useState(false);
  const inventory = partsInventory(s!);
  const stocks = inventory.stock.filter((x) =>
    operation === "reserve"
      ? x.partNumber === line.partNumber ||
        (line.alternateNumber && x.partNumber === line.alternateNumber)
      : r.reservations.some(
          (a) => a.lineUuid === line.uuid && a.stockUuid === x.uuid,
        ),
  );
  return (
    <AsyncForm
      submitLabel={
        operation === "reserve"
          ? "Reserve stock"
          : operation === "release"
            ? "Release reservation"
            : "Issue reserved parts"
      }
      disabled={!online || !connected}
      onSubmit={async () => {
        await backend!.partsRequest({
          kind: operation,
          requestUuid: crypto.randomUUID(),
          uuid: r.uuid,
          version: r.version,
          lineUuid: line.uuid,
          stockUuid,
          quantity,
          alternateConfirmed: alternate,
        });
      }}
    >
      <div className="request-grid">
        <Field label="Inventory action">
          <select
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value as typeof operation);
              setStock("");
            }}
          >
            <option value="reserve">Reserve</option>
            <option value="issue">Issue reserved parts</option>
            <option value="release">Release reservation</option>
          </select>
        </Field>
        <Field label="Stock lot / location">
          <select
            value={stockUuid}
            required
            onChange={(e) => {
              setStock(e.target.value);
              setAlternate(false);
            }}
          >
            <option value="">Select stock</option>
            {stocks.map((x) => (
              <option key={x.uuid} value={x.uuid}>
                {x.partNumber} ·{" "}
                {
                  inventory.locations.find((l) => l.uuid === x.locationUuid)
                    ?.name
                }{" "}
                · {x.condition} ·{" "}
                {operation === "reserve"
                  ? expiredForUse(x.expirationDate)
                    ? `Expired ${x.expirationDate}`
                    : `Available ${usableQuantity(x)}`
                  : `Reserved ${r.reservations.find((a) => a.lineUuid === line.uuid && a.stockUuid === x.uuid)?.quantity ?? 0}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantity">
          <input
            required
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </Field>
      </div>
      {operation === "reserve" &&
        stocks.find((x) => x.uuid === stockUuid)?.partNumber !==
          line.partNumber &&
        stockUuid && (
          <label>
            <input
              type="checkbox"
              checked={alternate}
              required
              onChange={(e) => setAlternate(e.target.checked)}
            />{" "}
            I confirm use of the listed alternate part number.
          </label>
        )}
    </AsyncForm>
  );
}
export function requestPODraft(s: Snapshot, ids: string[]): PODraft {
  const requests = (s.partsRequests ?? []).filter(
    (r) => ids.includes(r.uuid) && !r.cancelled,
  );
  if (!requests.length) throw Error("Select an open request.");
  if (requests.some((r) => r.recurring))
    throw Error(
      "Select occurrence requests for purchasing, not recurring lists.",
    );
  const first = requests[0];
  if (
    requests.some(
      (r) =>
        r.vendor.toLowerCase() !== first.vendor.toLowerCase() ||
        r.currency !== first.currency ||
        r.shipTo.trim() !== first.shipTo.trim(),
    )
  )
    throw Error(
      "Select requests with the same vendor, currency and ship-to address.",
    );
  const inventory = partsInventory(s);
  const lines = requests.flatMap((r) =>
    r.lines.flatMap((l) => {
      const quantity = requestLineProgress(s, r, l.uuid).toOrder;
      if (!quantity) return [];
      const component = s.management?.find(
        (c) => c.kind === "component" && c.uuid === l.componentUuid,
      );
      const stock = inventory.stock.find((x) => x.partNumber === l.partNumber);
      const stockRecord = s.management?.find(
        (x) => x.uuid === stock?.uuid && x.kind === "stock",
      );
      return [
        poLineSchema.parse({
          uuid: crypto.randomUUID(),
          stockUuid: r.mode === "parts" ? (stock?.uuid ?? "") : "",
          locationUuid:
            stock?.locationUuid ||
            (component?.kind === "component" ? component.locationUuid : "") ||
            inventory.locations[0]?.uuid ||
            "choose-location",
          partNumber: l.partNumber,
          description:
            r.mode === "repair"
              ? `${l.description} — ${l.service}: ${l.workRequested}`
              : l.description,
          quantity,
          unitCents: l.quotedCents,
          sprucePart: l.sprucePart,
          kind:
            r.mode === "repair"
              ? "component"
              : stockRecord?.kind === "stock"
                ? stockRecord.category
                : "part",
          aircraftUuid: r.aircraftUuid,
          workOrderUuid: r.source.workOrderUuid,
          inspectionUuid: r.source.kind === "inspection" ? r.source.uuid : "",
          requestAllocations: [
            { requestUuid: r.uuid, lineUuid: l.uuid, quantity },
          ],
          ...(r.mode === "repair"
            ? { repairComponentUuid: l.componentUuid, repairWork: l.service }
            : {}),
        }),
      ];
    }),
  );
  if (!lines.length)
    throw Error(
      "Selected requests are already reserved, ordered or fulfilled.",
    );
  // Empty vendor/ship-to remain editable in the PO editor; validation occurs on save.
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    vendor: first.vendor,
    vendorContact: first.vendorAddress,
    vendorAddressDetails: first.vendorAddressDetails,
    shippingAddress: first.shipToDetails,
    shipTo: first.shipTo,
    currency: first.currency,
    expectedDate: first.requiredBy,
    shippingCents: 0,
    notes: requests.map((r) => `${r.number}: ${r.notes}`).join("\n"),
    lines,
  };
}
