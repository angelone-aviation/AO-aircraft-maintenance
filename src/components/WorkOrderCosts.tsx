/**
 * Responsibility: A work order's labor, parts and other costs panel.
 * Layer: UI. React components; cost rules live in src/domain/costs.ts.
 * Dependencies: react, @phosphor-icons/react, src/data (store,
 *   historyPages: an older order's costs come with its page), src/domain
 *   (model, programs, workOrders, costs), ./ShopList, ./ui, ./costs.css.
 */
import { useState } from "react";
import { Trash } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { useRecordsSnapshot } from "../data/historyPages";
import { can, localDate, type Snapshot } from "../domain/model";
import { programPermission } from "../domain/programs";
import { isOpenWorkOrder, type WorkOrder } from "../domain/workOrders";
import {
  formatCents,
  formatLaborHours,
  laborCents,
  laborRate,
  laborSeconds,
  MAX_RATE_CENTS,
  parseCents,
  parseLaborHours,
  workOrderCosts,
  type CostCommand,
} from "../domain/costs";
import { ShopPill } from "./ShopList";
import { AsyncForm, Field, errorText, value } from "./ui";
import "./costs.css";

type Costs = ReturnType<typeof workOrderCosts>;
type View = {
  s: Snapshot;
  order: WorkOrder;
  costs: Costs;
  admin: boolean;
  writable: boolean;
  run: (command: CostCommand) => Promise<void>;
};
type ViewProps = { view: View };
type UnitCostProps = {
  label: string;
  manual: boolean;
  onSave: (unitCents: number | null) => Promise<void>;
};

/**
 * Labor, parts and other costs for one work order. Program administrators see
 * amounts, rates, parts and other costs; maintainers of the aircraft see and
 * record labor. Changes need an open order and a connection, and a maintainer
 * may remove only labor they recorded.
 *
 * @param props.order - The work order.
 * @returns The panel, or null for a user who is neither.
 */
export function WorkOrderCosts({ order }: { order: WorkOrder }) {
  const { backend, online, connected } = useWorkspace();
  const s = useRecordsSnapshot();
  const [error, setError] = useState("");
  if (!s) return null;
  const admin = programPermission(s, "admin");
  if (!admin && !can(s, order.aircraftUuid, "maintenance")) return null;
  const open = isOpenWorkOrder(order);
  const run = async (command: CostCommand) => {
    setError("");
    try {
      await backend!.costs(command);
    } catch (e) {
      setError(errorText(e, "Cost change failed."));
    }
  };
  const costs = workOrderCosts(s, order);
  const writable = open && online && connected;
  const view = { s, order, costs, admin, writable, run };
  return (
    <section className="panel" aria-labelledby={`costs-${order.uuid}`}>
      <h3 id={`costs-${order.uuid}`}>Costs</h3>
      {!open && (
        <p className="notice">
          This work order is closed. Its costs are read-only.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {admin && <CostTotals costs={costs} />}
      <LaborCosts view={view} />
      {admin && <PartCosts view={view} />}
      {admin && <OtherCosts view={view} />}
    </section>
  );
}

function CostTotals({ costs }: { costs: Costs }) {
  return (
    <dl className="cost-totals">
      <div>
        <dt>Labor</dt>
        <dd>{formatCents(costs.laborCents)}</dd>
      </div>
      <div>
        <dt>Parts</dt>
        <dd>{formatCents(costs.partsCents)}</dd>
      </div>
      <div>
        <dt>Other</dt>
        <dd>{formatCents(costs.otherCents)}</dd>
      </div>
      <div>
        <dt>Total</dt>
        <dd>
          <strong>{formatCents(costs.totalCents)}</strong>
        </dd>
      </div>
    </dl>
  );
}

function LaborCosts({ view }: ViewProps) {
  const { costs, admin, writable } = view;
  return (
    <>
      <h4>Labor · {formatLaborHours(costs.laborSeconds)} h</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Technician</th>
              <th>Hours</th>
              {admin && <th>Rate</th>}
              {admin && <th>Amount</th>}
              {writable && <ActionsHeading />}
            </tr>
          </thead>
          <tbody>
            {costs.labor.map((entry) => (
              <LaborRow key={entry.uuid} entry={entry} view={view} />
            ))}
          </tbody>
        </table>
        {!costs.labor.length && <p className="muted">No labor recorded.</p>}
      </div>
      {writable && <LaborForm view={view} />}
    </>
  );
}

function LaborRow({
  entry: e,
  view,
}: ViewProps & { entry: Costs["labor"][number] }) {
  const { admin, order } = view;
  return (
    <tr>
      <td>{e.date}</td>
      <td>{e.technician}</td>
      <td>{formatLaborHours(laborSeconds(e))}</td>
      {admin && <td>{formatCents(e.rateCents ?? 0)}/h</td>}
      {admin && <td>{formatCents(laborCents(e))}</td>}
      {view.writable && (
        <td>
          {(admin || e.createdBy === view.s.user.id) && (
            <RemoveButton
              label={`Remove labor for ${e.technician} on ${e.date}`}
              onClick={() =>
                view.run({
                  action: "labor.remove",
                  workOrderUuid: order.uuid,
                  uuid: e.uuid,
                })
              }
            />
          )}
        </td>
      )}
    </tr>
  );
}

function LaborForm({ view: { s, order, admin } }: ViewProps) {
  const { backend } = useWorkspace();
  const [key, setKey] = useState(0);
  const save = async (data: FormData) => {
    await backend!.costs(laborCommand(order, admin, data));
    setKey(key + 1);
  };
  return (
    <AsyncForm key={key} submitLabel="Add labor" onSubmit={save}>
      <div className="form-grid">
        <DateField />
        <TechnicianField s={s} list={`technicians-${order.uuid}`} />
        <Field label="Hours" hint="Decimal hours, e.g. 1.5">
          <input
            name="hours"
            required
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
          />
        </Field>
        {admin && <RateField rate={laborRate(s)} />}
      </div>
    </AsyncForm>
  );
}

function TechnicianField({ s, list }: { s: Snapshot; list: string }) {
  return (
    <>
      <Field label="Technician">
        <input
          name="technician"
          required
          maxLength={200}
          defaultValue={s.user.name}
          list={list}
        />
      </Field>
      <datalist id={list}>
        {s.members
          .filter((m) => m.active)
          .map((m) => (
            <option key={m.id} value={m.name} aria-label={m.name} />
          ))}
      </datalist>
    </>
  );
}

function RateField({ rate }: { rate: number | undefined }) {
  return (
    <Field
      label="Rate per hour (USD)"
      hint={
        rate === undefined
          ? "Leave blank to use the program rate (not set)."
          : `Leave blank to use the program rate of ${formatCents(rate)}.`
      }
    >
      <input name="rate" inputMode="decimal" />
    </Field>
  );
}

function PartCosts({ view }: ViewProps) {
  const { parts } = view.costs;
  return (
    <>
      <h4>Parts issued</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Part</th>
              <th>Quantity</th>
              <th>Unit cost</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => (
              <PartRow key={part.stockUuid} part={part} view={view} />
            ))}
          </tbody>
        </table>
        {!parts.length && (
          <p className="muted">
            No stock has been issued to this work order through parts requests.
          </p>
        )}
      </div>
    </>
  );
}

function PartRow({
  part: p,
  view,
}: ViewProps & { part: Costs["parts"][number] }) {
  return (
    <tr>
      <td>
        <strong>{p.partNumber}</strong>
        <small className="block">{p.description}</small>
      </td>
      <td>{p.quantity}</td>
      <td>
        {p.unitCents === undefined ? (
          <ShopPill tone="warn">No unit cost</ShopPill>
        ) : (
          <>
            {formatCents(p.unitCents)}
            {p.manual && <small className="block">Manual</small>}
          </>
        )}
        {view.writable && (
          <UnitCostEditor
            label={p.partNumber}
            manual={p.manual}
            onSave={(unitCents) =>
              view.run({
                action: "part.unitCost",
                workOrderUuid: view.order.uuid,
                stockUuid: p.stockUuid,
                unitCents,
              })
            }
          />
        )}
      </td>
      <td>{formatCents(p.totalCents)}</td>
    </tr>
  );
}

function OtherCosts({ view }: ViewProps) {
  const { costs, order, writable } = view;
  return (
    <>
      <h4>Other costs</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Amount</th>
              {writable && <ActionsHeading />}
            </tr>
          </thead>
          <tbody>
            {costs.other.map((entry) => (
              <OtherRow key={entry.uuid} entry={entry} view={view} />
            ))}
          </tbody>
        </table>
        {!costs.other.length && (
          <p className="muted">No other costs recorded.</p>
        )}
      </div>
      {writable && <OtherCostForm order={order} />}
    </>
  );
}

function OtherRow({
  entry: e,
  view,
}: ViewProps & { entry: Costs["other"][number] }) {
  return (
    <tr>
      <td>{e.date}</td>
      <td>{e.description}</td>
      <td>{formatCents(e.amountCents)}</td>
      {view.writable && (
        <td>
          <RemoveButton
            label={`Remove ${e.description}`}
            onClick={() =>
              view.run({
                action: "other.remove",
                workOrderUuid: view.order.uuid,
                uuid: e.uuid,
              })
            }
          />
        </td>
      )}
    </tr>
  );
}

function OtherCostForm({ order }: { order: WorkOrder }) {
  const { backend } = useWorkspace();
  const [key, setKey] = useState(0);
  const save = async (data: FormData) => {
    await backend!.costs({
      action: "other.add",
      workOrderUuid: order.uuid,
      entry: {
        uuid: crypto.randomUUID(),
        date: value(data, "date"),
        description: value(data, "description"),
        amountCents: parseCents(value(data, "amount")),
      },
    });
    setKey(key + 1);
  };
  return (
    <AsyncForm key={key} submitLabel="Add cost" onSubmit={save}>
      <div className="form-grid">
        <DateField />
        <Field label="Amount (USD)">
          <input name="amount" required inputMode="decimal" />
        </Field>
      </div>
      <Field label="Description">
        <input name="description" required maxLength={500} />
      </Field>
    </AsyncForm>
  );
}

function DateField() {
  return (
    <Field label="Date">
      <input
        name="date"
        type="date"
        required
        defaultValue={localDate()}
        max={localDate()}
      />
    </Field>
  );
}

function ActionsHeading() {
  return (
    <th>
      <span className="sr-only">Actions</span>
    </th>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      onClick={onClick}
    >
      <Trash size={16} aria-hidden="true" />
    </button>
  );
}

function UnitCostEditor(props: UnitCostProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const save = async () => {
    try {
      setError("");
      await props.onSave(parseCents(draft));
      setDraft("");
    } catch (e) {
      setError(errorText(e, "Invalid amount."));
    }
  };
  return (
    <div className="unit-cost-editor">
      <input
        aria-label={`Manual unit cost for ${props.label} (USD)`}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button type="button" className="button small" onClick={save}>
        Set
      </button>
      {props.manual && (
        <button
          type="button"
          className="text-button"
          onClick={() => props.onSave(null)}
        >
          Use stock cost
        </button>
      )}
      {error && (
        <small role="alert" className="error">
          {error}
        </small>
      )}
    </div>
  );
}

function laborCommand(
  order: WorkOrder,
  admin: boolean,
  data: FormData,
): CostCommand {
  const rate = admin ? value(data, "rate") : "";
  return {
    action: "labor.add",
    workOrderUuid: order.uuid,
    entry: {
      uuid: crypto.randomUUID(),
      date: value(data, "date"),
      technician: value(data, "technician"),
      seconds: parseLaborHours(value(data, "hours")),
      rateCents: rate ? parseCents(rate, MAX_RATE_CENTS) : undefined,
    },
  };
}
