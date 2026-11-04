/**
 * Responsibility: Maintenance costs on work orders (labor, parts, other),
 *   annual budgets, the labor rate, and the aircraft cost report.
 * Layer: Domain. Zod schemas, an applier and pure reports; no I/O, no React.
 * Dependencies: zod; ./model, ./programs, ./workOrders, ./flights,
 *   ./changeLog, ./rejection.
 *
 * Money is integer cents. Labor time is integer seconds, exact for hours
 * entered to the hundredth (36 s); entries saved before that carry only whole
 * minutes and keep their amounts.
 */
import { z } from "zod";
import {
  can,
  latestLocalDate,
  localDate,
  type Aircraft,
  type Flight,
  type Snapshot,
} from "./model";
import { activeProgram, programPermission } from "./programs";
import { isOpenWorkOrder, type WorkOrder } from "./workOrders";
import { meterAtFlight } from "./flights";
import { auditEntry } from "./changeLog";
import { Rejection } from "./rejection";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_HUNDREDTH_HOUR = 36;
const CENTS_PER_DOLLAR = 100;
const MAX_ENTRY_HOURS = 1000;

/** The largest amount of money a cost field holds: $1 billion, in cents. */
export const MAX_CENTS = 100_000_000_000;
/** The largest labor rate: $100,000 an hour, in cents. */
export const MAX_RATE_CENTS = 10_000_000;
/** The longest single labor entry, 1,000 hours, in whole minutes. */
export const MAX_ENTRY_MINUTES = MAX_ENTRY_HOURS * SECONDS_PER_MINUTE;
/** The longest single labor entry, 1,000 hours, in seconds. */
export const MAX_ENTRY_SECONDS = MAX_ENTRY_HOURS * SECONDS_PER_HOUR;

const cents = z.number().int().nonnegative().max(MAX_CENTS);
const rate = z.number().int().nonnegative().max(MAX_RATE_CENTS);
const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(500);
const date = z.iso.date();
const minutes = z.number().int().positive().max(MAX_ENTRY_MINUTES);
const seconds = z.number().int().positive().max(MAX_ENTRY_SECONDS);
const budgetYear = z.number().int().min(2000).max(2200);

/**
 * Labor recorded on a work order: a technician's time on a date, priced at
 * the rate in force when it was added.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const laborEntrySchema = z.object({
  uuid: id,
  date,
  technician: text.max(200),
  // Rounded to whole minutes; exact only when `seconds` is absent. Still
  // written so app versions that read only minutes keep working.
  minutes,
  // Exact labor time; absent on entries saved before it existed.
  seconds: seconds.optional(),
  // Absent only in the scoped snapshot of a non-administrator.
  rateCents: rate.optional(),
  createdBy: id,
  createdAt: z.number(),
});

/**
 * A cost on a work order other than labor or issued parts.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const otherCostSchema = z.object({
  uuid: id,
  date,
  description: text,
  amountCents: cents.positive(),
  createdBy: id,
  createdAt: z.number(),
});

const base = {
  uuid: id,
  version: z.number().int().nonnegative(),
  programUuid: id,
};

/**
 * The costs of one work order: labor, other costs, and manual unit costs for
 * issued parts that override the stock unit cost.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field or too many entries.
 */
export const workOrderCostSchema = z.object({
  ...base,
  kind: z.literal("workOrder"),
  aircraftUuid: id,
  workOrderUuid: id,
  labor: z.array(laborEntrySchema).max(500),
  other: z.array(otherCostSchema).max(200),
  partUnitCosts: z
    .array(z.object({ stockUuid: id, unitCents: cents }))
    .max(200),
});

/**
 * An aircraft's maintenance budget for one calendar year.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const budgetSchema = z.object({
  ...base,
  kind: z.literal("budget"),
  aircraftUuid: id,
  year: budgetYear,
  amountCents: cents,
});

/**
 * A Flight Program's labor rate, applied to labor added without one.
 *
 * @throws {z.ZodError} From `parse()` on an invalid field.
 */
export const costSettingsSchema = z.object({
  ...base,
  kind: z.literal("settings"),
  laborRateCents: rate,
});

/**
 * Any stored cost record, by `kind`.
 *
 * @throws {z.ZodError} From `parse()` on an unknown kind or invalid field.
 */
export const costRecordSchema = z.discriminatedUnion("kind", [
  workOrderCostSchema,
  budgetSchema,
  costSettingsSchema,
]);
/** A parsed cost record. */
export type CostRecord = z.infer<typeof costRecordSchema>;
/** A parsed work-order cost record. */
export type WorkOrderCost = z.infer<typeof workOrderCostSchema>;
/** A parsed labor entry. */
export type LaborEntry = z.infer<typeof laborEntrySchema>;
/** A parsed other cost. */
export type OtherCost = z.infer<typeof otherCostSchema>;

/**
 * A cost command: add or remove labor or another cost, set or clear a part's
 * manual unit cost, set a budget, or set the labor rate.
 *
 * @throws {z.ZodError} From `parse()` on an invalid command; "Enter labor
 *   hours." for labor with both or neither of minutes and seconds.
 */
export const costCommandSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("labor.add"),
    workOrderUuid: id,
    // Current apps send exact seconds; older apps send whole minutes.
    entry: z
      .object({
        uuid: z.string().uuid(),
        date,
        technician: text.max(200),
        minutes: minutes.optional(),
        seconds: seconds.optional(),
        rateCents: rate.optional(),
      })
      .refine((e) => (e.minutes === undefined) !== (e.seconds === undefined), {
        message: "Enter labor hours.",
      }),
  }),
  z.object({
    action: z.enum(["labor.remove", "other.remove"]),
    workOrderUuid: id,
    uuid: id,
  }),
  z.object({
    action: z.literal("other.add"),
    workOrderUuid: id,
    entry: z.object({
      uuid: z.string().uuid(),
      date,
      description: text,
      amountCents: cents.positive(),
    }),
  }),
  z.object({
    action: z.literal("part.unitCost"),
    workOrderUuid: id,
    stockUuid: id,
    // null clears the manual cost and falls back to the stock unit cost.
    unitCents: cents.nullable(),
  }),
  z.object({
    action: z.literal("budget.set"),
    aircraftUuid: id,
    year: budgetYear,
    amountCents: cents,
  }),
  z.object({ action: z.literal("settings.laborRate"), laborRateCents: rate }),
]);
/** A parsed cost command. */
export type CostCommand = z.infer<typeof costCommandSchema>;

/**
 * Parses hours as typed, exactly: "1.33" is 4,788 seconds.
 *
 * @returns Whole seconds.
 * @throws {Rejection} "Enter hours as a number with up to two decimals.",
 *   "Labor hours must be greater than zero." or "A single labor entry cannot
 *   exceed 1,000 hours."
 */
export function parseLaborHours(value: string) {
  const v = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Rejection("Enter hours as a number with up to two decimals.");
  const [whole, fraction = ""] = v.split(".");
  const seconds =
    Number(whole) * SECONDS_PER_HOUR +
    Number(fraction.padEnd(2, "0")) * SECONDS_PER_HUNDREDTH_HOUR;
  if (seconds <= 0)
    throw new Rejection("Labor hours must be greater than zero.");
  if (!Number.isSafeInteger(seconds) || seconds > MAX_ENTRY_SECONDS)
    throw new Rejection("A single labor entry cannot exceed 1,000 hours.");
  return seconds;
}

/**
 * Parses money as typed: "$1,234.5" is 123,450 cents.
 *
 * @param max - The largest amount accepted, in cents.
 * @throws {Rejection} "Enter a positive amount with up to two decimals." or
 *   "Amount is too large."
 */
export function parseCents(value: string, max = MAX_CENTS) {
  const v = value.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Rejection("Enter a positive amount with up to two decimals.");
  const [whole, fraction = ""] = v.split(".");
  const result =
    Number(whole) * CENTS_PER_DOLLAR + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > max)
    throw new Rejection("Amount is too large.");
  return result;
}

/**
 * Formats cents as US dollars.
 *
 * @returns Such as "$1,234.50".
 */
export function formatCents(c: number) {
  return (c / CENTS_PER_DOLLAR).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/** Labor time in seconds: exact when recorded, else the stored whole minutes. */
export const laborSeconds = (e: Pick<LaborEntry, "minutes" | "seconds">) =>
  e.seconds ?? e.minutes * SECONDS_PER_MINUTE;

/**
 * The price of a labor entry, rounded to the cent.
 *
 * @returns Cents; 0 when the rate is hidden from the caller.
 */
export const laborCents = (
  e: Pick<LaborEntry, "minutes" | "seconds" | "rateCents">,
) => Math.round((laborSeconds(e) * (e.rateCents ?? 0)) / SECONDS_PER_HOUR);

/**
 * Formats labor seconds as hours, such as "1.33", with up to two decimals.
 */
export const formatLaborHours = (seconds: number) =>
  (seconds / SECONDS_PER_HOUR).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });

/** A date range for cost reports, inclusive, as ISO dates. */
export interface Period {
  from: string;
  to: string;
}

const addDays = (d: string, days: number) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + days)).toISOString().slice(0, 10);
};

/**
 * The period a cost report covers.
 *
 * @param kind - "year" for this calendar year, "12m" for the twelve months
 *   ending today, or "custom".
 * @param custom - The custom range; ignored otherwise.
 * @throws {Rejection} "Choose a start and end date." or "Choose a start date
 *   on or before the end date." for a custom range.
 */
export function periodFor(
  kind: "year" | "12m" | "custom",
  today: string,
  custom?: Partial<Period>,
): Period {
  const year = today.slice(0, 4);
  if (kind === "year") return { from: `${year}-01-01`, to: `${year}-12-31` };
  if (kind === "12m") {
    const lastYear = `${Number(year) - 1}${today.slice(4)}`;
    // 2024-02-29 has no counterpart a year earlier; count from the 28th.
    const start = lastYear.endsWith("-02-29")
      ? lastYear.replace(/29$/, "28")
      : lastYear;
    return { from: addDays(start, 1), to: today };
  }
  const from = custom?.from ?? "",
    to = custom?.to ?? "";
  if (!date.safeParse(from).success || !date.safeParse(to).success)
    throw new Rejection("Choose a start and end date.");
  if (from > to)
    throw new Rejection("Choose a start date on or before the end date.");
  return { from, to };
}

const inPeriod = (d: string, p?: Period) => !p || (d >= p.from && d <= p.to);

const workOrderCost = (s: Snapshot, workOrderUuid: string) =>
  s.costs?.find(
    (r): r is WorkOrderCost =>
      r.kind === "workOrder" && r.workOrderUuid === workOrderUuid,
  );

/**
 * The active Flight Program's labor rate.
 *
 * @returns Cents an hour, or undefined when none is set.
 */
export const laborRate = (s: Snapshot) =>
  s.costs?.find(
    (r): r is Extract<CostRecord, { kind: "settings" }> =>
      r.kind === "settings" && r.programUuid === activeProgram(s),
  )?.laborRateCents;

/**
 * Stock issued against the work order through parts requests: requests on
 * its tasks, and requests on job cards it owns, archived ones included.
 *
 * @returns One entry per issue, dated the local date it was issued.
 */
export function partIssues(s: Snapshot, w: Pick<WorkOrder, "uuid">) {
  const cards = new Map(
    [...(s.taskCards ?? []), ...(s.archivedTaskCards ?? [])].map((c) => [
      c.uuid,
      c.workOrderUuid,
    ]),
  );
  return (s.partsRequests ?? [])
    .filter(
      (r) =>
        r.source.workOrderUuid === w.uuid ||
        (r.source.kind === "jobCard" && cards.get(r.source.uuid) === w.uuid),
    )
    .flatMap((r) =>
      r.issues.map((i) => {
        const line = r.lines.find((l) => l.uuid === i.lineUuid);
        return {
          stockUuid: i.stockUuid,
          quantity: i.quantity,
          date: localDate(i.at),
          partNumber: line?.partNumber ?? "",
          description: line?.description ?? "",
        };
      }),
    );
}

/** One stock item's issued parts on a work order, priced. */
export interface PartCostLine {
  stockUuid: string;
  partNumber: string;
  description: string;
  quantity: number;
  unitCents?: number;
  manual: boolean;
  totalCents: number;
}

/**
 * A work order's costs, optionally within a period.
 *
 * @returns Its labor and other entries, its issued parts grouped by stock
 *   item (a manual unit cost, else the stock unit cost, else unpriced), and
 *   the totals; `missingPartCosts` counts the unpriced part lines.
 */
export function workOrderCosts(s: Snapshot, w: WorkOrder, period?: Period) {
  const record = workOrderCost(s, w.uuid);
  const labor = (record?.labor ?? []).filter((e) => inPeriod(e.date, period));
  const other = (record?.other ?? []).filter((e) => inPeriod(e.date, period));
  const parts = priceIssuedParts(s, w, record, period);
  const sum = <T>(xs: T[], f: (x: T) => number) =>
    xs.reduce((n, x) => n + f(x), 0);
  const totals = {
    laborSeconds: sum(labor, laborSeconds),
    laborCents: sum(labor, laborCents),
    partsCents: sum(parts, (p) => p.totalCents),
    otherCents: sum(other, (e) => e.amountCents),
    missingPartCosts: parts.filter((p) => p.unitCents === undefined).length,
  };
  return {
    labor,
    other,
    parts,
    ...totals,
    totalCents: totals.laborCents + totals.partsCents + totals.otherCents,
  };
}
/** A work order's costs, as {@link workOrderCosts} returns them. */
export type WorkOrderCostSummary = ReturnType<typeof workOrderCosts>;

/** Meter seconds an accepted flight added, on the meter in use at the time. */
export function flightSeconds(a: Aircraft, f: Flight) {
  if (f.status !== "accepted") return 0;
  const [start, end] = meterReadings(f, meterAtFlight(a, f.startTime));
  return start === undefined || end === undefined
    ? 0
    : Math.max(0, end - start);
}

/**
 * An aircraft's maintenance costs and flying over a period.
 *
 * @returns The work orders with costs in the period, oldest opened first; the
 *   totals; the flight seconds of accepted flights started in the period; and
 *   the cost per flight hour, undefined when nothing was flown.
 */
export function aircraftCostReport(
  s: Snapshot,
  aircraftUuid: string,
  period: Period,
) {
  const orders = (s.workOrders ?? [])
    .filter((w) => w.aircraftUuid === aircraftUuid)
    .map((order) => ({ order, costs: workOrderCosts(s, order, period) }))
    .filter(
      ({ costs }) =>
        costs.labor.length || costs.other.length || costs.parts.length,
    )
    .sort((x, y) => x.order.dateOpened.localeCompare(y.order.dateOpened));
  const total = (k: TotalKey) => orders.reduce((n, o) => n + o.costs[k], 0);
  const seconds = flownSeconds(s, aircraftUuid, period);
  const totalCents = total("totalCents");
  return {
    period,
    orders,
    laborSeconds: total("laborSeconds"),
    laborCents: total("laborCents"),
    partsCents: total("partsCents"),
    otherCents: total("otherCents"),
    missingPartCosts: total("missingPartCosts"),
    totalCents,
    flightSeconds: seconds,
    // Undefined when no hours were flown: shown as "—", never divided by zero.
    costPerHourCents: seconds
      ? Math.round((totalCents / seconds) * SECONDS_PER_HOUR)
      : undefined,
  };
}
/** An aircraft cost report, as {@link aircraftCostReport} returns it. */
export type AircraftCostReport = ReturnType<typeof aircraftCostReport>;

/**
 * An aircraft's spending against its budget for a calendar year.
 *
 * @returns The budget (undefined if none), actual spend, what remains, the
 *   whole percent spent (undefined for no or a zero budget), and whether
 *   spend is over budget.
 */
export function budgetStatus(s: Snapshot, aircraftUuid: string, year: number) {
  const budget = s.costs?.find(
    (r) =>
      r.kind === "budget" && r.aircraftUuid === aircraftUuid && r.year === year,
  );
  const actualCents = aircraftCostReport(s, aircraftUuid, {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  }).totalCents;
  const budgetCents =
    budget?.kind === "budget" ? budget.amountCents : undefined;
  return {
    budgetCents,
    actualCents,
    remainingCents:
      budgetCents === undefined ? undefined : budgetCents - actualCents,
    percent: budgetCents
      ? Math.round((actualCents / budgetCents) * 100)
      : undefined,
    over: budgetCents !== undefined && actualCents > budgetCents,
  };
}

/**
 * The rows of a cost report's CSV export: one per work order, then a total
 * row with the period, flight hours and cost per flight hour ("—" when
 * nothing was flown). Money is in dollars and time in hours.
 */
export function costReportCsvRows(report: AircraftCostReport) {
  const money = (c: number) => c / CENTS_PER_DOLLAR;
  const hours = (seconds: number) => seconds / SECONDS_PER_HOUR;
  return [
    ...report.orders.map(({ order, costs }) => ({
      "Work order": order.number,
      Status: order.status,
      Opened: order.dateOpened,
      "Labor hours": hours(costs.laborSeconds),
      Labor: money(costs.laborCents),
      Parts: money(costs.partsCents),
      Other: money(costs.otherCents),
      Total: money(costs.totalCents),
    })),
    {
      "Work order": "Total",
      Status: `${report.period.from} to ${report.period.to}`,
      Opened: "",
      "Labor hours": hours(report.laborSeconds),
      Labor: money(report.laborCents),
      Parts: money(report.partsCents),
      Other: money(report.otherCents),
      Total: money(report.totalCents),
      "Flight hours": hours(report.flightSeconds),
      "Cost per flight hour":
        report.costPerHourCents === undefined
          ? "—"
          : money(report.costPerHourCents),
    },
  ];
}

/**
 * Applies one cost command to the snapshot and returns the changed record.
 * Granular add/remove commands never overwrite fields a non-administrator
 * cannot see (rates, amounts).
 *
 * @returns The saved record. Adding an entry whose uuid is already stored
 *   returns the stored record and changes nothing.
 * @throws {Rejection} For a refused command: no active program, missing
 *   access, an unknown or closed work order, a future date, or an entry or
 *   part that is not there.
 * @throws {z.ZodError} For an invalid command or result.
 *
 * Side effects: replaces the record in `s.costs` and prepends a
 * `cost.<action>` entry to `s.audit`.
 */
export function applyCostCommand(
  s: Snapshot,
  raw: CostCommand,
  now = Date.now(),
): CostRecord {
  const c = costCommandSchema.parse(raw);
  const program = activeProgram(s);
  if (!program || !s.user.active)
    throw new Rejection("Select a Flight Program first.");
  const change = { action: c.action, program, now };
  if (c.action === "settings.laborRate")
    return saveCostRecord(s, change, laborRateRecord(s, c, program));
  if (c.action === "budget.set") {
    const budget = budgetRecord(s, c, program);
    return saveCostRecord(
      s,
      { ...change, aircraftUuid: c.aircraftUuid },
      budget,
    );
  }
  const w = openOrder(s, c.workOrderUuid, isAdmin(s));
  const record = workOrderCost(s, w.uuid) ?? emptyWorkOrderCost(w, program);
  const changed = changeWorkOrderCost(s, c, w, record, now);
  if (!changed) return record;
  const next = workOrderCostSchema.parse({
    ...record,
    ...changed,
    version: record.version + 1,
  });
  return saveCostRecord(s, { ...change, aircraftUuid: w.aircraftUuid }, next);
}

type TotalKey =
  | "laborSeconds"
  | "laborCents"
  | "partsCents"
  | "otherCents"
  | "totalCents"
  | "missingPartCosts";
type WorkOrderCommand = Exclude<
  CostCommand,
  { action: "settings.laborRate" | "budget.set" }
>;
interface CostChange {
  action: CostCommand["action"];
  program: string;
  now: number;
  aircraftUuid?: string;
}

// Issued parts grouped by stock item: a manual unit cost wins over the stock
// item's unit cost (dollars, rounded to the cent).
function priceIssuedParts(
  s: Snapshot,
  w: WorkOrder,
  record: WorkOrderCost | undefined,
  period: Period | undefined,
): PartCostLine[] {
  const grouped = new Map<string, PartCostLine>();
  for (const issue of partIssues(s, w)) {
    if (!inPeriod(issue.date, period)) continue;
    const prior = grouped.get(issue.stockUuid);
    if (prior) prior.quantity += issue.quantity;
    else grouped.set(issue.stockUuid, priceIssue(s, record, issue));
  }
  return [...grouped.values()].map((p) => ({
    ...p,
    totalCents: p.quantity * (p.unitCents ?? 0),
  }));
}

function priceIssue(
  s: Snapshot,
  record: WorkOrderCost | undefined,
  issue: ReturnType<typeof partIssues>[number],
): PartCostLine {
  const manual = record?.partUnitCosts.find(
    (p) => p.stockUuid === issue.stockUuid,
  );
  const stock = s.management?.find(
    (r) => r.kind === "stock" && r.uuid === issue.stockUuid,
  );
  const stockCost =
    stock?.kind === "stock" && stock.cost !== undefined
      ? Math.round(stock.cost * CENTS_PER_DOLLAR)
      : undefined;
  return {
    stockUuid: issue.stockUuid,
    partNumber:
      issue.partNumber || (stock?.kind === "stock" ? stock.partNumber : ""),
    description:
      issue.description || (stock?.kind === "stock" ? stock.description : ""),
    quantity: issue.quantity,
    unitCents: manual?.unitCents ?? stockCost,
    manual: !!manual,
    totalCents: 0,
  };
}

// Flights are matched to the period by the local date they started.
function flownSeconds(s: Snapshot, aircraftUuid: string, period: Period) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  if (!a) return 0;
  return s.flights
    .filter(
      (f) =>
        f.aircraftUuid === aircraftUuid &&
        inPeriod(localDate(Date.parse(f.startTime)), period),
    )
    .reduce((n, f) => n + flightSeconds(a, f), 0);
}

// The "Off" reading is taken at the start of the flight, "On" at its end.
function meterReadings(f: Flight, meter: ReturnType<typeof meterAtFlight>) {
  if (meter === "tach") return [f.tachOff, f.tachOn];
  if (meter === "flightTimeLog") return [f.flightTimeLogOff, f.flightTimeLogOn];
  if (meter === "cyclic") return [f.cyclicHobbsOff, f.cyclicHobbsOn];
  return [f.hobbsOff, f.hobbsOn];
}

const isAdmin = (s: Snapshot) => programPermission(s, "admin");

function requireAdmin(s: Snapshot) {
  if (!isAdmin(s))
    throw new Rejection("Flight Program administrator access is required.");
}

// An administrator may cost any work order they can read; others need
// maintenance access to its aircraft.
function openOrder(s: Snapshot, workOrderUuid: string, admin: boolean) {
  const w = s.workOrders?.find((w) => w.uuid === workOrderUuid);
  if (!w || !can(s, w.aircraftUuid, admin ? "read" : "maintenance"))
    throw new Rejection("Work order not found.");
  if (!isOpenWorkOrder(w))
    throw new Rejection("This work order is closed. Its costs are read-only.");
  return w;
}

function checkDate(d: string, now: number) {
  if (d > latestLocalDate(now))
    throw new Rejection("Cost dates cannot be in the future.");
}

function laborRateRecord(
  s: Snapshot,
  c: Extract<CostCommand, { action: "settings.laborRate" }>,
  program: string,
): CostRecord {
  requireAdmin(s);
  const prior = s.costs?.find(
    (r) => r.kind === "settings" && r.programUuid === program,
  );
  return {
    uuid: prior?.uuid ?? crypto.randomUUID(),
    version: (prior?.version ?? 0) + 1,
    programUuid: program,
    kind: "settings",
    laborRateCents: c.laborRateCents,
  };
}

function budgetRecord(
  s: Snapshot,
  c: Extract<CostCommand, { action: "budget.set" }>,
  program: string,
): CostRecord {
  requireAdmin(s);
  if (!can(s, c.aircraftUuid, "read"))
    throw new Rejection("Aircraft not found.");
  const prior = s.costs?.find(
    (r) =>
      r.kind === "budget" &&
      r.aircraftUuid === c.aircraftUuid &&
      r.year === c.year,
  );
  return {
    uuid: prior?.uuid ?? crypto.randomUUID(),
    version: (prior?.version ?? 0) + 1,
    programUuid: program,
    kind: "budget",
    aircraftUuid: c.aircraftUuid,
    year: c.year,
    amountCents: c.amountCents,
  };
}

function emptyWorkOrderCost(w: WorkOrder, program: string): WorkOrderCost {
  return {
    uuid: crypto.randomUUID(),
    version: 0,
    programUuid: program,
    kind: "workOrder",
    aircraftUuid: w.aircraftUuid,
    workOrderUuid: w.uuid,
    labor: [],
    other: [],
    partUnitCosts: [],
  };
}

// Undefined when the entry was already added: the command is idempotent.
function changeWorkOrderCost(
  s: Snapshot,
  c: WorkOrderCommand,
  w: WorkOrder,
  record: WorkOrderCost,
  now: number,
): Partial<WorkOrderCost> | undefined {
  if (c.action === "labor.add") return addLabor(s, c, record, now);
  if (c.action === "labor.remove") return removeLabor(s, c.uuid, record);
  requireAdmin(s);
  if (c.action === "other.add") return addOther(s, c, record, now);
  if (c.action === "other.remove") return removeOther(c.uuid, record);
  if (c.action !== "part.unitCost") throw new Error("Unknown command.");
  if (!partIssues(s, w).some((i) => i.stockUuid === c.stockUuid))
    throw new Rejection("That part was not issued to this work order.");
  const rest = record.partUnitCosts.filter((p) => p.stockUuid !== c.stockUuid);
  if (c.unitCents === null) return { partUnitCosts: rest };
  const manual = { stockUuid: c.stockUuid, unitCents: c.unitCents };
  return { partUnitCosts: [...rest, manual] };
}

// Labor added without a rate is priced at the program rate in force now.
function addLabor(
  s: Snapshot,
  c: Extract<CostCommand, { action: "labor.add" }>,
  record: WorkOrderCost,
  now: number,
) {
  if (c.entry.rateCents !== undefined && !isAdmin(s))
    throw new Rejection("Only Flight Program administrators can set rates.");
  checkDate(c.entry.date, now);
  if (record.labor.some((e) => e.uuid === c.entry.uuid)) return undefined;
  const { seconds } = c.entry;
  const entry = {
    ...c.entry,
    minutes:
      seconds === undefined
        ? c.entry.minutes!
        : Math.max(1, Math.round(seconds / SECONDS_PER_MINUTE)),
    rateCents: c.entry.rateCents ?? laborRate(s) ?? 0,
    createdBy: s.user.id,
    createdAt: now,
  };
  return { labor: [...record.labor, entry] };
}

function removeLabor(s: Snapshot, uuid: string, record: WorkOrderCost) {
  const entry = record.labor.find((e) => e.uuid === uuid);
  if (!entry) throw new Rejection("Labor entry not found.");
  if (!isAdmin(s) && entry.createdBy !== s.user.id)
    throw new Rejection("You can only remove labor you recorded.");
  return { labor: record.labor.filter((e) => e.uuid !== uuid) };
}

function addOther(
  s: Snapshot,
  c: Extract<CostCommand, { action: "other.add" }>,
  record: WorkOrderCost,
  now: number,
) {
  checkDate(c.entry.date, now);
  if (record.other.some((e) => e.uuid === c.entry.uuid)) return undefined;
  const entry = { ...c.entry, createdBy: s.user.id, createdAt: now };
  return { other: [...record.other, entry] };
}

function removeOther(uuid: string, record: WorkOrderCost) {
  if (!record.other.some((e) => e.uuid === uuid))
    throw new Rejection("Cost entry not found.");
  return { other: record.other.filter((e) => e.uuid !== uuid) };
}

// Cost audit entries carry no aircraft so only administrators see them.
function saveCostRecord(
  s: Snapshot,
  { action, program, now, aircraftUuid }: CostChange,
  next: CostRecord,
) {
  const before = s.costs?.find((r) => r.uuid === next.uuid);
  s.costs = [...(s.costs ?? []).filter((r) => r.uuid !== next.uuid), next];
  const entry = auditEntry(
    s,
    {
      programUuid: program,
      action: `cost.${action}`,
      entityUuid: next.uuid,
      reason: aircraftUuid
        ? s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration
        : undefined,
      before,
      after: next,
    },
    now,
  );
  s.audit = [entry, ...s.audit];
  return next;
}
