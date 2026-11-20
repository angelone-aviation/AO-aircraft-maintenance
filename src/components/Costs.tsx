/**
 * Responsibility: The maintenance cost screens: the Costs page with its
 *   period report, budgets and CSV export, and an aircraft's cost summary.
 * Layer: UI. React components; cost rules live in src/domain/costs.ts.
 * Dependencies: @tanstack/react-router, src/data/store.ts, src/domain (model,
 *   programs, csv, costs), ./ui.tsx, ./design.tsx, ./ShopList.tsx,
 *   ./CostCharts.tsx, ./WorkOrderList.tsx, ./NumberInput.tsx.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
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
import {
  hours,
  localDate,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
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
  type AircraftCostReport,
  type Period,
} from "../domain/costs";
import { AsyncForm, Field, download, errorText, value } from "./ui";
import { NumberInput } from "./NumberInput";
import {
  EmptyState,
  NoticeBar,
  PageHeader,
  ProgressTrack,
  StatsStrip,
  Toolbar,
} from "./design";
import {
  ShopLead,
  ShopPill,
  ShopSelect,
  ShopStat,
  ShopTableCard,
} from "./ShopList";
import { CostCharts } from "./CostCharts";
import { WorkOrderStatusPill } from "./WorkOrderList";
import "./costs.css";

// The budget years budgetSchema accepts.
const BUDGET_YEAR_MIN = 2000;
const BUDGET_YEAR_MAX = 2200;
const CENTS_PER_DOLLAR = 100;

type PeriodKind = "year" | "12m" | "custom";
type CostLine = AircraftCostReport["orders"][number];
type BudgetStatus = ReturnType<typeof budgetStatus>;

/**
 * The Costs page: an aircraft's labor, parts and other work-order costs for
 * this year, the last 12 months or a custom range, against flight hours and
 * its annual budget, with a CSV export.
 *
 * @returns Nothing before the snapshot loads, and an access notice for anyone
 *   but a Flight Program administrator.
 */
export function CostsPage() {
  const { snapshot: s } = useWorkspace();
  const [aircraftUuid, setAircraftUuid] = useState(
    () => s?.aircraft[0]?.uuid ?? "",
  );
  const [kind, setKind] = useState<PeriodKind>("year");
  const [custom, setCustom] = useState<Partial<Period>>({});
  if (!s) return null;
  if (!programPermission(s, "admin")) return <AdministratorsOnly />;
  const aircraft =
    s.aircraft.find((a) => a.uuid === aircraftUuid) ?? s.aircraft[0];
  const { report, periodError } = buildReport(s, aircraft, kind, custom);
  const period = { kind, custom, onKind: setKind, onCustom: setCustom };
  return (
    <>
      <CostsHeader aircraft={aircraft} report={report} />
      <Toolbar className="shop-toolbar">
        <AircraftPicker s={s} aircraft={aircraft} onChange={setAircraftUuid} />
        <PeriodPicker {...period} />
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
      {report && <CostReport s={s} aircraft={aircraft!} report={report} />}
      <LaborRateNotice rate={laborRate(s)} />
    </>
  );
}

/**
 * An aircraft's spend against its budget for one calendar year.
 *
 * @returns A note with the actual spend when no budget is set; otherwise the
 *   spend, budget and percent used, the amount over or remaining, and a bar.
 */
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
        <BudgetPill status={status} />
      </p>
      <ProgressTrack
        // A zero budget shows an empty bar instead of dividing by zero.
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

/**
 * This year's maintenance costs for one aircraft, with its budget bar and a
 * link to the cost report.
 *
 * @returns Nothing before the snapshot loads, or for anyone but a Flight
 *   Program administrator.
 */
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
      <CostTotals report={report} />
      <BudgetBar s={s} aircraftUuid={aircraftUuid} year={year} />
      <Link to="/costs">Open cost report</Link>
    </section>
  );
}

function buildReport(
  s: Snapshot,
  aircraft: Aircraft | undefined,
  kind: PeriodKind,
  custom: Partial<Period>,
) {
  let period: Period | undefined;
  let periodError = "";
  try {
    period = periodFor(kind, localDate(), custom);
  } catch (e) {
    // periodFor refuses a custom range that is incomplete or reversed.
    periodError = errorText(e, "Choose a valid period.");
  }
  const report =
    aircraft && period ? aircraftCostReport(s, aircraft.uuid, period) : null;
  return { report, periodError };
}

function formatCostPerHour(report: AircraftCostReport) {
  return report.costPerHourCents === undefined
    ? "—"
    : formatCents(report.costPerHourCents);
}

function AdministratorsOnly() {
  return (
    <>
      <PageHeader eyebrow="FINANCE" title="Costs" />
      <EmptyState title="Administrator access required">
        Maintenance costs are visible to Flight Program administrators only.
      </EmptyState>
    </>
  );
}

function CostsHeader({
  aircraft,
  report,
}: {
  aircraft?: Aircraft;
  report: AircraftCostReport | null;
}) {
  return (
    <PageHeader
      eyebrow="FINANCE"
      title="Costs"
      description="Labor, parts and other work-order costs per aircraft, against flight hours and the annual budget."
      actions={report && <ExportButton aircraft={aircraft!} report={report} />}
    />
  );
}

function ExportButton({
  aircraft,
  report,
}: {
  aircraft: Aircraft;
  report: AircraftCostReport;
}) {
  const { from, to } = report.period;
  return (
    <button
      type="button"
      className="button"
      onClick={() =>
        download(
          `${aircraft.registration}-costs-${from}-${to}.csv`,
          toCsv(costReportCsvRows(report)),
          "text/csv",
        )
      }
    >
      <DownloadSimple size={18} aria-hidden="true" /> Export CSV
    </button>
  );
}

function AircraftPicker({
  s,
  aircraft,
  onChange,
}: {
  s: Snapshot;
  aircraft?: Aircraft;
  onChange: (uuid: string) => void;
}) {
  return (
    <ShopSelect
      label="Aircraft"
      icon={Airplane}
      value={aircraft?.uuid ?? ""}
      onChange={onChange}
    >
      {s.aircraft.map((a) => (
        <option key={a.uuid} value={a.uuid}>
          {a.registration} · {a.make} {a.model}
        </option>
      ))}
    </ShopSelect>
  );
}

function PeriodPicker({
  kind,
  custom,
  onKind,
  onCustom,
}: {
  kind: PeriodKind;
  custom: Partial<Period>;
  onKind: (kind: PeriodKind) => void;
  onCustom: (custom: Partial<Period>) => void;
}) {
  return (
    <>
      <ShopSelect
        label="Period"
        icon={CalendarBlank}
        value={kind}
        onChange={(v) => onKind(v as PeriodKind)}
      >
        <option value="year">This year</option>
        <option value="12m">Last 12 months</option>
        <option value="custom">Custom range</option>
      </ShopSelect>
      {kind === "custom" && (
        <>
          <DateBound
            label="From"
            value={custom.from}
            onChange={(from) => onCustom({ ...custom, from })}
          />
          <DateBound
            label="To"
            value={custom.to}
            onChange={(to) => onCustom({ ...custom, to })}
          />
        </>
      )}
    </>
  );
}

function DateBound({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (date: string) => void;
}) {
  return (
    <label className="shop-date">
      {label}
      <input
        type="date"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function CostReport({
  s,
  aircraft,
  report,
}: {
  s: Snapshot;
  aircraft: Aircraft;
  report: AircraftCostReport;
}) {
  return (
    <>
      <CostStats report={report} />
      <CostCharts s={s} report={report} />
      <ShopTableCard
        label="Work-order costs"
        className="shop-compact"
        stack
        title={`Work orders · ${report.period.from} to ${report.period.to}`}
      >
        {report.orders.length ? (
          <CostTable lines={report.orders} />
        ) : (
          <div className="shop-table-empty">
            <p>
              No costs recorded in this period. Add labor and other costs from
              each <Link to="/work-orders">work order</Link>.
            </p>
          </div>
        )}
      </ShopTableCard>
      <div className="shop-card-grid">
        <BudgetPanel s={s} aircraftUuid={aircraft.uuid} />
      </div>
    </>
  );
}

function CostStats({ report }: { report: AircraftCostReport }) {
  return (
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
        foot={`${hours(report.flightSeconds)} flight h · ${formatCostPerHour(report)} per flight hour`}
      />
    </StatsStrip>
  );
}

function CostTable({ lines }: { lines: CostLine[] }) {
  return (
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
        {lines.map((line) => (
          <CostRow key={line.order.uuid} line={line} />
        ))}
      </tbody>
    </table>
  );
}

function CostRow({ line: { order, costs } }: { line: CostLine }) {
  const completed = order.status === "completed";
  return (
    <tr>
      <td className="shop-wide">
        <ShopLead
          icon={CurrencyCircleDollar}
          tone={completed ? "good" : "blue"}
          title={order.number}
          sub={order.scope}
        />
      </td>
      <td className="shop-nowrap" data-label="Opened">
        {order.dateOpened}
      </td>
      <td data-label="Status">
        <WorkOrderStatusPill status={order.status} />
      </td>
      <NumberCell label="Labor h">
        {formatLaborHours(costs.laborSeconds)}
      </NumberCell>
      <NumberCell label="Labor">{formatCents(costs.laborCents)}</NumberCell>
      <NumberCell label="Parts">
        {formatCents(costs.partsCents)}
        {!!costs.missingPartCosts && <small>Unit cost missing</small>}
      </NumberCell>
      <NumberCell label="Other">{formatCents(costs.otherCents)}</NumberCell>
      <NumberCell label="Total">
        <strong>{formatCents(costs.totalCents)}</strong>
      </NumberCell>
    </tr>
  );
}

function NumberCell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <td className="shop-num" data-label={label}>
      {children}
    </td>
  );
}

function LaborRateNotice({ rate }: { rate?: number }) {
  return (
    <NoticeBar icon={GearSix}>
      {rate === undefined
        ? "No default labor rate is set."
        : `Default rate ${formatCents(rate)} per hour.`}{" "}
      Change it in Settings → Flight Program.{" "}
      <Link to="/settings" hash="program">
        Open Flight Program settings
      </Link>
    </NoticeBar>
  );
}

function BudgetPill({ status }: { status: BudgetStatus }) {
  if (status.over)
    return (
      <ShopPill tone="danger">
        Over budget by {formatCents(-status.remainingCents!)}
      </ShopPill>
    );
  return (
    <ShopPill tone="good">
      {formatCents(status.remainingCents!)} remaining
    </ShopPill>
  );
}

function BudgetPanel({
  s,
  aircraftUuid,
}: {
  s: Snapshot;
  aircraftUuid: string;
}) {
  const [year, setYear] = useState(Number(localDate().slice(0, 4)));
  const current = budgetStatus(s, aircraftUuid, year).budgetCents;
  return (
    <section className="shop-card" aria-labelledby="budget-heading">
      <h2 id="budget-heading">Annual budget</h2>
      <Field label="Budget year">
        <NumberInput
          min={BUDGET_YEAR_MIN}
          max={BUDGET_YEAR_MAX}
          value={year}
          onValue={setYear}
        />
      </Field>
      <BudgetBar s={s} aircraftUuid={aircraftUuid} year={year} />
      <BudgetForm
        // Remounted when the aircraft, year or saved budget changes, so the
        // amount shows the stored value.
        key={`${aircraftUuid}:${year}:${current}`}
        aircraftUuid={aircraftUuid}
        year={year}
        current={current}
      />
    </section>
  );
}

function BudgetForm({
  aircraftUuid,
  year,
  current,
}: {
  aircraftUuid: string;
  year: number;
  current?: number;
}) {
  const { backend, online, connected } = useWorkspace();
  return (
    <AsyncForm
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
            current === undefined ? "" : (current / CENTS_PER_DOLLAR).toFixed(2)
          }
        />
      </Field>
    </AsyncForm>
  );
}

function CostTotals({ report }: { report: AircraftCostReport }) {
  return (
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
        <dd>{formatCostPerHour(report)}</dd>
      </div>
    </dl>
  );
}
