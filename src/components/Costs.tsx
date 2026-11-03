import { useState, type CSSProperties } from "react";
import { Link } from "@tanstack/react-router";
import {
  Airplane,
  CalendarBlank,
  CurrencyCircleDollar,
  DownloadSimple,
  GearSix,
  WarningCircle,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { hours, localDate, type Snapshot } from "../domain/model";
import { programPermission } from "../domain/programs";
import { toCsv } from "../domain/csv";
import {
  aircraftCostReport,
  budgetStatus,
  costReportCsvRows,
  formatCents,
  formatLaborHours,
  laborRate,
  parseCents,
  periodFor,
  type Period,
} from "../domain/costs";
import { AsyncForm, Field, download, value } from "./ui";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  ProgressTrack,
  StatsStrip,
  StatusPill,
  Toolbar,
} from "./design";
import { ShopLead, ShopSelect, ShopStat, ShopTableCard } from "./ShopList";
import "./costs.css";

type PeriodKind = "year" | "12m" | "custom";
export function CostsPage() {
  const { snapshot: s } = useWorkspace();
  const [aircraftUuid, setAircraftUuid] = useState(
    () => s?.aircraft[0]?.uuid ?? "",
  );
  const [kind, setKind] = useState<PeriodKind>("year");
  const [custom, setCustom] = useState<Partial<Period>>({});
  if (!s) return null;
  if (!programPermission(s, "admin"))
    return (
      <>
        <PageHeader eyebrow="FINANCE" title="Costs" />
        <EmptyState title="Administrator access required">
          Maintenance costs are visible to Flight Program administrators only.
        </EmptyState>
      </>
    );
  const aircraft =
    s.aircraft.find((a) => a.uuid === aircraftUuid) ?? s.aircraft[0];
  let period: Period | undefined,
    periodError = "";
  try {
    period = periodFor(kind, localDate(), custom);
  } catch (e) {
    periodError = e instanceof Error ? e.message : "Choose a valid period.";
  }
  const report =
    aircraft && period ? aircraftCostReport(s, aircraft.uuid, period) : null;
  const rate = laborRate(s);
  return (
    <>
      <PageHeader
        eyebrow="FINANCE"
        title="Costs"
        description="Labor, parts and other work-order costs per aircraft, against flight hours and the annual budget."
        actions={
          report && (
            <button
              type="button"
              className="button"
              onClick={() =>
                download(
                  `${aircraft!.registration}-costs-${report.period.from}-${report.period.to}.csv`,
                  toCsv(costReportCsvRows(report)),
                  "text/csv",
                )
              }
            >
              <DownloadSimple size={18} aria-hidden="true" /> Export CSV
            </button>
          )
        }
      />
      <Toolbar className="shop-toolbar">
        <ShopSelect
          label="Aircraft"
          icon={Airplane}
          value={aircraft?.uuid ?? ""}
          onChange={setAircraftUuid}
        >
          {s.aircraft.map((a) => (
            <option key={a.uuid} value={a.uuid}>
              {a.registration} · {a.make} {a.model}
            </option>
          ))}
        </ShopSelect>
        <ShopSelect
          label="Period"
          icon={CalendarBlank}
          value={kind}
          onChange={(v) => setKind(v as PeriodKind)}
        >
          <option value="year">This year</option>
          <option value="12m">Last 12 months</option>
          <option value="custom">Custom range</option>
        </ShopSelect>
        {kind === "custom" && (
          <>
            <label className="shop-date">
              From
              <input
                type="date"
                value={custom.from ?? ""}
                onChange={(e) => setCustom({ ...custom, from: e.target.value })}
              />
            </label>
            <label className="shop-date">
              To
              <input
                type="date"
                value={custom.to ?? ""}
                onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              />
            </label>
          </>
        )}
      </Toolbar>
      {periodError && (
        <NoticeBar tone="danger" icon={WarningCircle} role="alert">
          {periodError}
        </NoticeBar>
      )}
      {!aircraft && (
        <EmptyState title="No aircraft">
          Add an aircraft to track its costs.
        </EmptyState>
      )}
      {report && (
        <>
          <StatsStrip className="shop-stats shop-cost-stats">
            <ShopStat
              label="Labor"
              value={formatCents(report.laborCents)}
              foot={`${formatLaborHours(report.laborSeconds)} h recorded`}
            />
            <ShopStat
              label="Parts"
              value={formatCents(report.partsCents)}
              foot={
                report.missingPartCosts
                  ? `${report.missingPartCosts} part(s) without a unit cost`
                  : "Issued stock at unit cost"
              }
            />
            <ShopStat label="Other" value={formatCents(report.otherCents)} />
            <ShopStat
              label="Total"
              value={formatCents(report.totalCents)}
              foot={`${hours(report.flightSeconds)} flight h · ${
                report.costPerHourCents === undefined
                  ? "—"
                  : formatCents(report.costPerHourCents)
              } per flight hour`}
            />
          </StatsStrip>
          <ShopTableCard
            label="Work-order costs"
            className="shop-compact"
            stack
            title={`Work orders · ${report.period.from} to ${report.period.to}`}
          >
            {report.orders.length ? (
              <table
                className="shop-table"
                style={{ "--shop-table-min": "860px" } as CSSProperties}
              >
                <thead>
                  <tr>
                    <th>Work order</th>
                    <th>Opened</th>
                    <th>Status</th>
                    <th className="shop-num">Labor h</th>
                    <th className="shop-num">Labor</th>
                    <th className="shop-num">Parts</th>
                    <th className="shop-num">Other</th>
                    <th className="shop-num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {report.orders.map(({ order, costs }) => (
                    <tr key={order.uuid}>
                      <td className="shop-wide">
                        <ShopLead
                          icon={CurrencyCircleDollar}
                          tone={order.status === "completed" ? "good" : "blue"}
                          title={order.number}
                          sub={order.scope}
                        />
                      </td>
                      <td className="shop-nowrap" data-label="Opened">
                        {order.dateOpened}
                      </td>
                      <td data-label="Status">
                        <StatusPill
                          tone={
                            order.status === "completed" ? "good" : "neutral"
                          }
                        >
                          <span className="shop-cap">
                            {order.status.replace(/-/g, " ")}
                          </span>
                        </StatusPill>
                      </td>
                      <td className="shop-num" data-label="Labor h">
                        {formatLaborHours(costs.laborSeconds)}
                      </td>
                      <td className="shop-num" data-label="Labor">
                        {formatCents(costs.laborCents)}
                      </td>
                      <td className="shop-num" data-label="Parts">
                        {formatCents(costs.partsCents)}
                        {!!costs.missingPartCosts && (
                          <small>Unit cost missing</small>
                        )}
                      </td>
                      <td className="shop-num" data-label="Other">
                        {formatCents(costs.otherCents)}
                      </td>
                      <td className="shop-num" data-label="Total">
                        <strong>{formatCents(costs.totalCents)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="shop-table-empty">
                <p>
                  No costs recorded in this period. Add labor and other costs
                  from each <Link to="/work-orders">work order</Link>.
                </p>
              </div>
            )}
          </ShopTableCard>
        </>
      )}
      {report && (
        <div className="shop-card-grid">
          <BudgetPanel s={s} aircraftUuid={aircraft!.uuid} />
        </div>
      )}
      <NoticeBar icon={GearSix}>
        Labor rate moved to Settings.{" "}
        {rate === undefined
          ? "No default rate is set."
          : `Default rate ${formatCents(rate)} per hour.`}{" "}
        <Link to="/settings" hash="program">
          Open Flight Program settings
        </Link>
      </NoticeBar>
    </>
  );
}
export function BudgetBar({
  s,
  aircraftUuid,
  year,
}: {
  s: Snapshot;
  aircraftUuid: string;
  year: number;
}) {
  const status = budgetStatus(s, aircraftUuid, year);
  if (status.budgetCents === undefined)
    return (
      <p className="muted">
        No {year} budget set. Actual spend {formatCents(status.actualCents)}.
      </p>
    );
  return (
    <div className={"shop-budget" + (status.over ? " over" : "")}>
      <p>
        <span>
          <strong>{formatCents(status.actualCents)}</strong> of{" "}
          {formatCents(status.budgetCents)} ({status.percent ?? 0}%)
        </span>{" "}
        {status.over ? (
          <StatusPill tone="danger">
            Over budget by {formatCents(-status.remainingCents!)}
          </StatusPill>
        ) : (
          <StatusPill tone="good">
            {formatCents(status.remainingCents!)} remaining
          </StatusPill>
        )}
      </p>
      <ProgressTrack
        value={
          Math.min(status.actualCents, status.budgetCents) /
          (status.budgetCents || 1)
        }
        tone={status.over ? "danger" : "good"}
        label={`${year} budget used`}
      />
    </div>
  );
}
function BudgetPanel({
  s,
  aircraftUuid,
}: {
  s: Snapshot;
  aircraftUuid: string;
}) {
  const { backend, online, connected } = useWorkspace();
  const [year, setYear] = useState(Number(localDate().slice(0, 4)));
  const current = budgetStatus(s, aircraftUuid, year).budgetCents;
  return (
    <section className="shop-card" aria-labelledby="budget-heading">
      <h2 id="budget-heading">Annual budget</h2>
      <Field label="Budget year">
        <input
          type="number"
          min={2000}
          max={2200}
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
        />
      </Field>
      <BudgetBar s={s} aircraftUuid={aircraftUuid} year={year} />
      <AsyncForm
        key={`${aircraftUuid}:${year}:${current}`}
        submitLabel="Save budget"
        disabled={!online || !connected}
        onSubmit={async (data) => {
          await backend!.costs({
            action: "budget.set",
            aircraftUuid,
            year,
            amountCents: parseCents(value(data, "amount")),
          });
        }}
      >
        <Field label={`${year} budget (USD)`}>
          <input
            name="amount"
            required
            inputMode="decimal"
            defaultValue={
              current === undefined ? "" : (current / 100).toFixed(2)
            }
          />
        </Field>
      </AsyncForm>
    </section>
  );
}
/** This year's cost summary for the aircraft details dialog. */
export function AircraftCostSummary({
  aircraftUuid,
}: {
  aircraftUuid: string;
}) {
  const { snapshot: s } = useWorkspace();
  if (!s || !programPermission(s, "admin")) return null;
  const year = Number(localDate().slice(0, 4));
  const report = aircraftCostReport(
    s,
    aircraftUuid,
    periodFor("year", localDate()),
  );
  return (
    <section className="panel" aria-labelledby={`cost-summary-${aircraftUuid}`}>
      <h3 id={`cost-summary-${aircraftUuid}`}>{year} maintenance costs</h3>
      <dl className="cost-totals">
        <div>
          <dt>Labor</dt>
          <dd>{formatCents(report.laborCents)}</dd>
        </div>
        <div>
          <dt>Parts</dt>
          <dd>{formatCents(report.partsCents)}</dd>
        </div>
        <div>
          <dt>Other</dt>
          <dd>{formatCents(report.otherCents)}</dd>
        </div>
        <div>
          <dt>Per flight hour</dt>
          <dd>
            {report.costPerHourCents === undefined
              ? "—"
              : formatCents(report.costPerHourCents)}
          </dd>
        </div>
      </dl>
      <BudgetBar s={s} aircraftUuid={aircraftUuid} year={year} />
      <Link to="/costs">Open cost report</Link>
    </section>
  );
}
