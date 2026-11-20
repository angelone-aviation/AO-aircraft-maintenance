/**
 * Responsibility: The maintenance cost screens: the Costs page with its
 *   period report, budgets and CSV export, and an aircraft's cost summary.
 * Layer: UI. React components; cost rules live in src/domain/costs.ts.
 * Dependencies: @tanstack/react-router, src/data (store, costReports),
 *   src/domain (model, programs, csv, costs, costs/costReport, workOrders),
 *   ./ui.tsx, ./design.tsx, ./ShopList.tsx, ./CostCharts.tsx,
 *   ./WorkOrderList.tsx, ./NumberInput.tsx.
 *
 * Spending comes from the server's cost ledger (history.costReport, S4), so
 * these screens and the board total it alike; budgets come from the
 * workspace, which keeps them all.
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
  WifiSlash,
} from "@phosphor-icons/react";
import { useWorkspace } from "../data/store";
import { useCostReport, type LoadedCostReport } from "../data/costReports";
import {
  hours,
  localDate,
  type Aircraft,
  type Snapshot,
} from "../domain/model";
import { programPermission } from "../domain/programs";
import { toCsv } from "../domain/csv";
import {
  budgetStatusOf,
  formatCents,
  formatLaborHours,
  laborRate,
  parseCents,
  periodFor,
  type Period,
} from "../domain/costs";
import { findBudget } from "../domain/costs/workOrderCosts";
import { workOrderStatuses } from "../domain/workOrders";
import {
  ledgerReportCsvRows,
  type CostReportView,
} from "../domain/costs/costReport";
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
type CostLine = CostReportView["orders"][number];
type BudgetStatus = ReturnType<typeof budgetStatusOf>;

/**
 * The Costs page: an aircraft's labor, parts and other work-order costs from
 * the cost ledger for this year, the last 12 months or a custom range,
 * against flight hours and its annual budget, with a CSV export.
 *
 * @returns Nothing before the snapshot loads, and an access notice for anyone
 *   but a Flight Program administrator. The report needs a connection.
 */
export function CostsPage() {
  const { snapshot: s } = useWorkspace();
  const [aircraftUuid, setAircraftUuid] = useState(
    () => s?.aircraft[0]?.uuid ?? "",
  );
  const [kind, setKind] = useState<PeriodKind>("year");
  const [custom, setCustom] = useState<Partial<Period>>({});
  const admin = !!s && programPermission(s, "admin");
  const aircraft =
    s?.aircraft.find((a) => a.uuid === aircraftUuid) ?? s?.aircraft[0];
  const { period, periodError } = choosePeriod(kind, custom);
  const loaded = useCostReport(admin ? aircraft : undefined, period);
  if (!s) return null;
  if (!admin) return <AdministratorsOnly />;
  const { report } = loaded;
  return (
    <>
      <CostsHeader aircraft={aircraft} report={report} />
      <Toolbar className="shop-toolbar">
        <AircraftPicker s={s} aircraft={aircraft} onChange={setAircraftUuid} />
        <PeriodPicker
          {...{ kind, custom, onKind: setKind, onCustom: setCustom }}
        />
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
      {aircraft && period && <ReportState loaded={loaded} />}
      {report && <CostReport s={s} aircraft={aircraft!} report={report} />}
      <LaborRateNotice rate={laborRate(s)} />
    </>
  );
}

/**
 * An aircraft's spend against its budget for one calendar year.
 *
 * @param props.budgetCents - The year's budget; undefined when none is set.
 * @param props.actualCents - The year's spend from the cost ledger;
 *   undefined until it loads.
 * @returns A note while the spend loads, or with the spend when no budget
 *   is set; otherwise the spend, budget and percent used, the amount over or
 *   remaining, and a bar.
 */
export function BudgetBar({
  year,
  budgetCents,
  actualCents,
}: {
  year: number;
  budgetCents?: number;
  actualCents?: number;
}) {
  if (actualCents === undefined)
    return (
      <p className="muted">
        The {year} spend loads from the cost ledger while connected.
      </p>
    );
  const status = budgetStatusOf(budgetCents, actualCents);
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
 * This year's maintenance costs for one aircraft, from the cost ledger, with
 * its budget bar and a link to the cost report.
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
  const admin = !!s && programPermission(s, "admin");
  const aircraft = s?.aircraft.find((a) => a.uuid === aircraftUuid);
  const year = Number(localDate().slice(0, 4));
  const loaded = useCostReport(
    admin ? aircraft : undefined,
    periodFor("year", localDate()),
  );
  if (!s || !admin) return null;
  const { report } = loaded;
  return (
    <section className="panel" aria-labelledby={`cost-summary-${aircraftUuid}`}>
      <h3 id={`cost-summary-${aircraftUuid}`}>{year} maintenance costs</h3>
      {report ? (
        <CostTotals report={report} />
      ) : (
        <ReportState loaded={loaded} />
      )}
      <BudgetBar
        year={year}
        budgetCents={findBudget(s, aircraftUuid, year)?.amountCents}
        actualCents={report?.totalCents}
      />
      <Link to="/costs">Open cost report</Link>
    </section>
  );
}

// periodFor refuses a custom range that is incomplete or reversed; the
// screen shows why instead of a report.
function choosePeriod(kind: PeriodKind, custom: Partial<Period>) {
  try {
    return { period: periodFor(kind, localDate(), custom), periodError: "" };
  } catch (e) {
    return {
      period: undefined,
      periodError: errorText(e, "Choose a valid period."),
    };
  }
}

// What stands in for the report until it loads, when it cannot, and why.
function ReportState({ loaded }: { loaded: LoadedCostReport }) {
  if (loaded.error)
    return (
      <NoticeBar tone="danger" icon={WarningCircle} role="alert">
        {loaded.error}
      </NoticeBar>
    );
  if (loaded.report) return null;
  if (loaded.offline)
    return (
      <NoticeBar tone="warn" icon={WifiSlash}>
        The cost report needs a connection. It totals the server&apos;s cost
        ledger.
      </NoticeBar>
    );
  return loaded.loading ? (
    <p role="status" className="muted">
      Loading the cost report…
    </p>
  ) : null;
}

function formatCostPerHour(report: CostReportView) {
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
  report?: CostReportView;
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
  report: CostReportView;
}) {
  const { from, to } = report.period;
  return (
    <button
      type="button"
      className="button"
      onClick={() =>
        download(
          `${aircraft.registration}-costs-${from}-${to}.csv`,
          toCsv(ledgerReportCsvRows(report)),
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
  report: CostReportView;
}) {
  return (
    <>
      <CostStats report={report} />
      <CostCharts report={report} />
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
        <BudgetPanel s={s} aircraft={aircraft} />
      </div>
    </>
  );
}

function CostStats({ report }: { report: CostReportView }) {
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
        foot="Issued parts at the price each issue recorded"
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
          <CostRow key={line.workOrderUuid} line={line} />
        ))}
      </tbody>
    </table>
  );
}

function CostRow({ line }: { line: CostLine }) {
  const status = workOrderStatuses.find((x) => x === line.status);
  return (
    <tr>
      <td className="shop-wide">
        <ShopLead
          icon={CurrencyCircleDollar}
          tone={status === "completed" ? "good" : "blue"}
          title={line.number || "Work order"}
        />
      </td>
      <td className="shop-nowrap" data-label="Opened">
        {line.dateOpened}
      </td>
      <td data-label="Status">
        {status && <WorkOrderStatusPill status={status} />}
      </td>
      <NumberCell label="Labor h">
        {formatLaborHours(line.laborSeconds)}
      </NumberCell>
      <NumberCell label="Labor">{formatCents(line.laborCents)}</NumberCell>
      <NumberCell label="Parts">{formatCents(line.partsCents)}</NumberCell>
      <NumberCell label="Other">{formatCents(line.otherCents)}</NumberCell>
      <NumberCell label="Total">
        <strong>{formatCents(line.totalCents)}</strong>
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

function BudgetPanel({ s, aircraft }: { s: Snapshot; aircraft: Aircraft }) {
  const [year, setYear] = useState(Number(localDate().slice(0, 4)));
  const spend = useCostReport(aircraft, {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });
  const current = findBudget(s, aircraft.uuid, year)?.amountCents;
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
      <BudgetBar
        year={year}
        budgetCents={current}
        actualCents={spend.report?.totalCents}
      />
      <BudgetForm
        // Remounted when the aircraft, year or saved budget changes, so the
        // amount shows the stored value.
        key={`${aircraft.uuid}:${year}:${current}`}
        aircraftUuid={aircraft.uuid}
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

function CostTotals({ report }: { report: CostReportView }) {
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
