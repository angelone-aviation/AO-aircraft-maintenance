/**
 * Responsibility: A work order's labor, parts and other costs panel.
 * Layer: UI. React components; cost rules live in src/domain/costs.ts.
 * Dependencies: react, @phosphor-icons/react, src/data/store.ts, src/domain
 *   (model, programs, workOrders, costs), ./ui, ./costs.css.
 */
import { useState } from "react";
import { Trash } from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { can, localDate } from "../domain/model";
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
import { AsyncForm, Badge, Field, errorText, value } from "./ui";
import "./costs.css";

/** Labor, parts and other costs for one work order. */
export function WorkOrderCosts({ order }: { order: WorkOrder }) {
  const { snapshot: s, backend, online, connected } = useWorkspace();
  const [error, setError] = useState("");
  const [laborKey, setLaborKey] = useState(0);
  const [otherKey, setOtherKey] = useState(0);
  if (!s) return null;
  const admin = programPermission(s, "admin");
  if (!admin && !can(s, order.aircraftUuid, "maintenance")) return null;
  const open = isOpenWorkOrder(order);
  const writable = open && online && connected;
  const costs = workOrderCosts(s, order);
  const defaultRate = laborRate(s);
  async function run(command: CostCommand) {
    setError("");
    try {
      await backend!.costs(command);
    } catch (e) {
      setError(errorText(e, "Cost change failed."));
    }
  }
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
      {admin && (
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
      )}
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
              {writable && (
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {costs.labor.map((e) => (
              <tr key={e.uuid}>
                <td>{e.date}</td>
                <td>{e.technician}</td>
                <td>{formatLaborHours(laborSeconds(e))}</td>
                {admin && <td>{formatCents(e.rateCents ?? 0)}/h</td>}
                {admin && <td>{formatCents(laborCents(e))}</td>}
                {writable && (
                  <td>
                    {(admin || e.createdBy === s.user.id) && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove labor for ${e.technician} on ${e.date}`}
                        onClick={() =>
                          run({
                            action: "labor.remove",
                            workOrderUuid: order.uuid,
                            uuid: e.uuid,
                          })
                        }
                      >
                        <Trash size={16} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!costs.labor.length && <p className="muted">No labor recorded.</p>}
      </div>
      {writable && (
        <AsyncForm
          key={laborKey}
          submitLabel="Add labor"
          onSubmit={async (data) => {
            const rate = admin ? value(data, "rate") : "";
            await backend!.costs({
              action: "labor.add",
              workOrderUuid: order.uuid,
              entry: {
                uuid: crypto.randomUUID(),
                date: value(data, "date"),
                technician: value(data, "technician"),
                seconds: parseLaborHours(value(data, "hours")),
                rateCents: rate ? parseCents(rate, MAX_RATE_CENTS) : undefined,
              },
            });
            setLaborKey(laborKey + 1);
          }}
        >
          <div className="form-grid">
            <Field label="Date">
              <input
                name="date"
                type="date"
                required
                defaultValue={localDate()}
                max={localDate()}
              />
            </Field>
            <Field label="Technician">
              <input
                name="technician"
                required
                maxLength={200}
                defaultValue={s.user.name}
                list={`technicians-${order.uuid}`}
              />
            </Field>
            <datalist id={`technicians-${order.uuid}`}>
              {s.members
                .filter((m) => m.active)
                .map((m) => (
                  <option key={m.id} value={m.name} aria-label={m.name} />
                ))}
            </datalist>
            <Field label="Hours" hint="Decimal hours, e.g. 1.5">
              <input
                name="hours"
                required
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
              />
            </Field>
            {admin && (
              <Field
                label="Rate per hour (USD)"
                hint={
                  defaultRate === undefined
                    ? "Leave blank to use the program rate (not set)."
                    : `Leave blank to use the program rate of ${formatCents(defaultRate)}.`
                }
              >
                <input name="rate" inputMode="decimal" />
              </Field>
            )}
          </div>
        </AsyncForm>
      )}
      {admin && (
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
                {costs.parts.map((p) => (
                  <tr key={p.stockUuid}>
                    <td>
                      <strong>{p.partNumber}</strong>
                      <small className="block">{p.description}</small>
                    </td>
                    <td>{p.quantity}</td>
                    <td>
                      {p.unitCents === undefined ? (
                        <Badge tone="warning">No unit cost</Badge>
                      ) : (
                        <>
                          {formatCents(p.unitCents)}
                          {p.manual && <small className="block">Manual</small>}
                        </>
                      )}
                      {writable && (
                        <UnitCostEditor
                          label={p.partNumber}
                          manual={p.manual}
                          onSave={(unitCents) =>
                            run({
                              action: "part.unitCost",
                              workOrderUuid: order.uuid,
                              stockUuid: p.stockUuid,
                              unitCents,
                            })
                          }
                        />
                      )}
                    </td>
                    <td>{formatCents(p.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!costs.parts.length && (
              <p className="muted">
                No stock has been issued to this work order through parts
                requests.
              </p>
            )}
          </div>
          <h4>Other costs</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                  {writable && (
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {costs.other.map((e) => (
                  <tr key={e.uuid}>
                    <td>{e.date}</td>
                    <td>{e.description}</td>
                    <td>{formatCents(e.amountCents)}</td>
                    {writable && (
                      <td>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${e.description}`}
                          onClick={() =>
                            run({
                              action: "other.remove",
                              workOrderUuid: order.uuid,
                              uuid: e.uuid,
                            })
                          }
                        >
                          <Trash size={16} aria-hidden="true" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {!costs.other.length && (
              <p className="muted">No other costs recorded.</p>
            )}
          </div>
          {writable && (
            <AsyncForm
              key={otherKey}
              submitLabel="Add cost"
              onSubmit={async (data) => {
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
                setOtherKey(otherKey + 1);
              }}
            >
              <div className="form-grid">
                <Field label="Date">
                  <input
                    name="date"
                    type="date"
                    required
                    defaultValue={localDate()}
                    max={localDate()}
                  />
                </Field>
                <Field label="Amount (USD)">
                  <input name="amount" required inputMode="decimal" />
                </Field>
              </div>
              <Field label="Description">
                <input name="description" required maxLength={500} />
              </Field>
            </AsyncForm>
          )}
        </>
      )}
    </section>
  );
}
function UnitCostEditor({
  label,
  manual,
  onSave,
}: {
  label: string;
  manual: boolean;
  onSave: (unitCents: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="unit-cost-editor">
      <input
        aria-label={`Manual unit cost for ${label} (USD)`}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className="button small"
        onClick={async () => {
          try {
            setError("");
            await onSave(parseCents(draft));
            setDraft("");
          } catch (e) {
            setError(errorText(e, "Invalid amount."));
          }
        }}
      >
        Set
      </button>
      {manual && (
        <button
          type="button"
          className="text-button"
          onClick={() => onSave(null)}
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
