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
// Money is integer cents. Labor time is integer seconds, exact for hours
// entered to the hundredth (36 s); entries saved before that carry only whole
// minutes and keep their amounts.
export const MAX_CENTS = 100_000_000_000;
export const MAX_RATE_CENTS = 10_000_000;
export const MAX_ENTRY_MINUTES = 1000 * 60;
export const MAX_ENTRY_SECONDS = 1000 * 3600;
const cents = z.number().int().nonnegative().max(MAX_CENTS);
const rate = z.number().int().nonnegative().max(MAX_RATE_CENTS);
const id = z.string().min(1).max(200);
const text = z.string().trim().min(1).max(500);
const date = z.iso.date();
const minutes = z.number().int().positive().max(MAX_ENTRY_MINUTES);
const seconds = z.number().int().positive().max(MAX_ENTRY_SECONDS);
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
export const budgetSchema = z.object({
  ...base,
  kind: z.literal("budget"),
  aircraftUuid: id,
  year: z.number().int().min(2000).max(2200),
  amountCents: cents,
});
export const costSettingsSchema = z.object({
  ...base,
  kind: z.literal("settings"),
  laborRateCents: rate,
});
export const costRecordSchema = z.discriminatedUnion("kind", [
  workOrderCostSchema,
  budgetSchema,
  costSettingsSchema,
]);
export type CostRecord = z.infer<typeof costRecordSchema>;
export type WorkOrderCost = z.infer<typeof workOrderCostSchema>;
export type LaborEntry = z.infer<typeof laborEntrySchema>;
export type OtherCost = z.infer<typeof otherCostSchema>;
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
    year: z.number().int().min(2000).max(2200),
    amountCents: cents,
  }),
  z.object({ action: z.literal("settings.laborRate"), laborRateCents: rate }),
]);
export type CostCommand = z.infer<typeof costCommandSchema>;

/** "1.33" hours → 4788 seconds, exactly (a hundredth of an hour is 36 s). */
export function parseLaborHours(value: string) {
  const v = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Error("Enter hours as a number with up to two decimals.");
  const [whole, fraction = ""] = v.split(".");
  const seconds = Number(whole) * 3600 + Number(fraction.padEnd(2, "0")) * 36;
  if (seconds <= 0) throw new Error("Labor hours must be greater than zero.");
  if (!Number.isSafeInteger(seconds) || seconds > MAX_ENTRY_SECONDS)
    throw new Error("A single labor entry cannot exceed 1,000 hours.");
  return seconds;
}
/** "12.34" → 1234 cents. */
export function parseCents(value: string, max = MAX_CENTS) {
  const v = value.trim().replace(/^\$/, "").replaceAll(",", "");
  if (!/^\d+(\.\d{1,2})?$/.test(v))
    throw new Error("Enter a positive amount with up to two decimals.");
  const [whole, fraction = ""] = v.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > max)
    throw new Error("Amount is too large.");
  return result;
}
export function formatCents(c: number) {
  return (c / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}
/** Labor time in seconds: exact when recorded, else the stored whole minutes. */
export const laborSeconds = (e: Pick<LaborEntry, "minutes" | "seconds">) =>
  e.seconds ?? e.minutes * 60;
export const laborCents = (
  e: Pick<LaborEntry, "minutes" | "seconds" | "rateCents">,
) => Math.round((laborSeconds(e) * (e.rateCents ?? 0)) / 3600);
export const formatLaborHours = (seconds: number) =>
  (seconds / 3600).toLocaleString("en-US", { maximumFractionDigits: 2 });

export interface Period {
  from: string;
  to: string;
}
const addDays = (d: string, days: number) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + days)).toISOString().slice(0, 10);
};
export function periodFor(
  kind: "year" | "12m" | "custom",
  today: string,
  custom?: Partial<Period>,
): Period {
  if (kind === "year")
    return {
      from: `${today.slice(0, 4)}-01-01`,
      to: `${today.slice(0, 4)}-12-31`,
    };
  if (kind === "12m") {
    const lastYear = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
    // 2024-02-29 has no counterpart a year earlier; count from the 28th.
    const start = lastYear.endsWith("-02-29")
      ? lastYear.replace(/29$/, "28")
      : lastYear;
    return { from: addDays(start, 1), to: today };
  }
  const from = custom?.from ?? "",
    to = custom?.to ?? "";
  if (!date.safeParse(from).success || !date.safeParse(to).success)
    throw new Error("Choose a start and end date.");
  if (from > to)
    throw new Error("Choose a start date on or before the end date.");
  return { from, to };
}
const inPeriod = (d: string, p?: Period) => !p || (d >= p.from && d <= p.to);

const workOrderCost = (s: Snapshot, workOrderUuid: string) =>
  s.costs?.find(
    (r): r is WorkOrderCost =>
      r.kind === "workOrder" && r.workOrderUuid === workOrderUuid,
  );
export const laborRate = (s: Snapshot) =>
  s.costs?.find(
    (r): r is Extract<CostRecord, { kind: "settings" }> =>
      r.kind === "settings" && r.programUuid === activeProgram(s),
  )?.laborRateCents;

/** Stock issued against the work order through parts requests. */
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
export interface PartCostLine {
  stockUuid: string;
  partNumber: string;
  description: string;
  quantity: number;
  unitCents?: number;
  manual: boolean;
  totalCents: number;
}
export function workOrderCosts(s: Snapshot, w: WorkOrder, period?: Period) {
  const record = workOrderCost(s, w.uuid);
  const labor = (record?.labor ?? []).filter((e) => inPeriod(e.date, period));
  const other = (record?.other ?? []).filter((e) => inPeriod(e.date, period));
  const grouped = new Map<string, PartCostLine>();
  for (const issue of partIssues(s, w)) {
    if (!inPeriod(issue.date, period)) continue;
    const prior = grouped.get(issue.stockUuid);
    if (prior) {
      prior.quantity += issue.quantity;
      continue;
    }
    const manual = record?.partUnitCosts.find(
      (p) => p.stockUuid === issue.stockUuid,
    );
    const stock = s.management?.find(
      (r) => r.kind === "stock" && r.uuid === issue.stockUuid,
    );
    const stockCost =
      stock?.kind === "stock" && stock.cost !== undefined
        ? Math.round(stock.cost * 100)
        : undefined;
    grouped.set(issue.stockUuid, {
      stockUuid: issue.stockUuid,
      partNumber:
        issue.partNumber || (stock?.kind === "stock" ? stock.partNumber : ""),
      description:
        issue.description || (stock?.kind === "stock" ? stock.description : ""),
      quantity: issue.quantity,
      unitCents: manual?.unitCents ?? stockCost,
      manual: !!manual,
      totalCents: 0,
    });
  }
  const parts = [...grouped.values()].map((p) => ({
    ...p,
    totalCents: p.quantity * (p.unitCents ?? 0),
  }));
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
export type WorkOrderCostSummary = ReturnType<typeof workOrderCosts>;

/** Meter seconds an accepted flight added, on the meter in use at the time. */
export function flightSeconds(a: Aircraft, f: Flight) {
  if (f.status !== "accepted") return 0;
  const meter = meterAtFlight(a, f.startTime);
  const [start, end] =
    meter === "tach"
      ? [f.tachOff, f.tachOn]
      : meter === "flightTimeLog"
        ? [f.flightTimeLogOff, f.flightTimeLogOn]
        : meter === "cyclic"
          ? [f.cyclicHobbsOff, f.cyclicHobbsOn]
          : [f.hobbsOff, f.hobbsOn];
  return start === undefined || end === undefined
    ? 0
    : Math.max(0, end - start);
}
export function aircraftCostReport(
  s: Snapshot,
  aircraftUuid: string,
  period: Period,
) {
  const a = s.aircraft.find((a) => a.uuid === aircraftUuid);
  const orders = (s.workOrders ?? [])
    .filter((w) => w.aircraftUuid === aircraftUuid)
    .map((order) => ({ order, costs: workOrderCosts(s, order, period) }))
    .filter(
      ({ costs }) =>
        costs.labor.length || costs.other.length || costs.parts.length,
    )
    .sort((x, y) => x.order.dateOpened.localeCompare(y.order.dateOpened));
  const total = (
    k:
      | "laborSeconds"
      | "laborCents"
      | "partsCents"
      | "otherCents"
      | "totalCents"
      | "missingPartCosts",
  ) => orders.reduce((n, o) => n + o.costs[k], 0);
  const seconds = a
    ? s.flights
        .filter(
          (f) =>
            f.aircraftUuid === aircraftUuid &&
            inPeriod(localDate(Date.parse(f.startTime)), period),
        )
        .reduce((n, f) => n + flightSeconds(a, f), 0)
    : 0;
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
      ? Math.round((totalCents / seconds) * 3600)
      : undefined,
  };
}
export type AircraftCostReport = ReturnType<typeof aircraftCostReport>;
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
export function costReportCsvRows(report: AircraftCostReport) {
  const money = (c: number) => c / 100;
  return [
    ...report.orders.map(({ order, costs }) => ({
      "Work order": order.number,
      Status: order.status,
      Opened: order.dateOpened,
      "Labor hours": costs.laborSeconds / 3600,
      Labor: money(costs.laborCents),
      Parts: money(costs.partsCents),
      Other: money(costs.otherCents),
      Total: money(costs.totalCents),
    })),
    {
      "Work order": "Total",
      Status: `${report.period.from} to ${report.period.to}`,
      Opened: "",
      "Labor hours": report.laborSeconds / 3600,
      Labor: money(report.laborCents),
      Parts: money(report.partsCents),
      Other: money(report.otherCents),
      Total: money(report.totalCents),
      "Flight hours": report.flightSeconds / 3600,
      "Cost per flight hour":
        report.costPerHourCents === undefined
          ? "—"
          : money(report.costPerHourCents),
    },
  ];
}

const isAdmin = (s: Snapshot) => programPermission(s, "admin");
function requireAdmin(s: Snapshot) {
  if (!isAdmin(s))
    throw new Error("Flight Program administrator access is required.");
}
function openOrder(s: Snapshot, workOrderUuid: string, admin: boolean) {
  const w = s.workOrders?.find((w) => w.uuid === workOrderUuid);
  if (!w || !can(s, w.aircraftUuid, admin ? "read" : "maintenance"))
    throw new Error("Work order not found.");
  if (!isOpenWorkOrder(w))
    throw new Error("This work order is closed. Its costs are read-only.");
  return w;
}
function checkDate(d: string, now: number) {
  if (d > latestLocalDate(now))
    throw new Error("Cost dates cannot be in the future.");
}
/**
 * Applies one cost command to the snapshot and returns the changed record.
 * Granular add/remove commands never overwrite fields a non-administrator
 * cannot see (rates, amounts).
 */
export function applyCostCommand(
  s: Snapshot,
  raw: CostCommand,
  now = Date.now(),
): CostRecord {
  const c = costCommandSchema.parse(raw);
  const program = activeProgram(s);
  if (!program || !s.user.active)
    throw new Error("Select a Flight Program first.");
  const admin = isAdmin(s);
  let next: CostRecord;
  let aircraftUuid: string | undefined;
  if (c.action === "settings.laborRate") {
    requireAdmin(s);
    const prior = s.costs?.find(
      (r) => r.kind === "settings" && r.programUuid === program,
    );
    next = {
      uuid: prior?.uuid ?? crypto.randomUUID(),
      version: (prior?.version ?? 0) + 1,
      programUuid: program,
      kind: "settings",
      laborRateCents: c.laborRateCents,
    };
  } else if (c.action === "budget.set") {
    requireAdmin(s);
    if (!can(s, c.aircraftUuid, "read")) throw new Error("Aircraft not found.");
    aircraftUuid = c.aircraftUuid;
    const prior = s.costs?.find(
      (r) =>
        r.kind === "budget" &&
        r.aircraftUuid === c.aircraftUuid &&
        r.year === c.year,
    );
    next = {
      uuid: prior?.uuid ?? crypto.randomUUID(),
      version: (prior?.version ?? 0) + 1,
      programUuid: program,
      kind: "budget",
      aircraftUuid: c.aircraftUuid,
      year: c.year,
      amountCents: c.amountCents,
    };
  } else {
    const w = openOrder(s, c.workOrderUuid, admin);
    aircraftUuid = w.aircraftUuid;
    const prior = workOrderCost(s, w.uuid);
    const record: WorkOrderCost = prior ?? {
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
    let changed: Partial<WorkOrderCost>;
    if (c.action === "labor.add") {
      if (c.entry.rateCents !== undefined && !admin)
        throw new Error("Only Flight Program administrators can set rates.");
      checkDate(c.entry.date, now);
      if (record.labor.some((e) => e.uuid === c.entry.uuid)) return record;
      const { seconds } = c.entry;
      changed = {
        labor: [
          ...record.labor,
          {
            ...c.entry,
            minutes:
              seconds === undefined
                ? c.entry.minutes!
                : Math.max(1, Math.round(seconds / 60)),
            rateCents: c.entry.rateCents ?? laborRate(s) ?? 0,
            createdBy: s.user.id,
            createdAt: now,
          },
        ],
      };
    } else if (c.action === "labor.remove") {
      const entry = record.labor.find((e) => e.uuid === c.uuid);
      if (!entry) throw new Error("Labor entry not found.");
      if (!admin && entry.createdBy !== s.user.id)
        throw new Error("You can only remove labor you recorded.");
      changed = { labor: record.labor.filter((e) => e.uuid !== c.uuid) };
    } else {
      requireAdmin(s);
      if (c.action === "other.add") {
        checkDate(c.entry.date, now);
        if (record.other.some((e) => e.uuid === c.entry.uuid)) return record;
        changed = {
          other: [
            ...record.other,
            { ...c.entry, createdBy: s.user.id, createdAt: now },
          ],
        };
      } else if (c.action === "other.remove") {
        if (!record.other.some((e) => e.uuid === c.uuid))
          throw new Error("Cost entry not found.");
        changed = { other: record.other.filter((e) => e.uuid !== c.uuid) };
      } else {
        if (c.action !== "part.unitCost") throw new Error("Unknown command.");
        if (!partIssues(s, w).some((i) => i.stockUuid === c.stockUuid))
          throw new Error("That part was not issued to this work order.");
        const rest = record.partUnitCosts.filter(
          (p) => p.stockUuid !== c.stockUuid,
        );
        changed = {
          partUnitCosts:
            c.unitCents === null
              ? rest
              : [...rest, { stockUuid: c.stockUuid, unitCents: c.unitCents }],
        };
      }
    }
    next = workOrderCostSchema.parse({
      ...record,
      ...changed,
      version: record.version + 1,
    });
  }
  const before = s.costs?.find((r) => r.uuid === next.uuid);
  s.costs = [...(s.costs ?? []).filter((r) => r.uuid !== next.uuid), next];
  // Cost audit entries carry no aircraft so only administrators see them.
  s.audit = [
    {
      uuid: crypto.randomUUID(),
      programUuid: program,
      actorId: s.user.id,
      at: now,
      action: "cost." + c.action,
      entityUuid: next.uuid,
      reason: aircraftUuid
        ? s.aircraft.find((a) => a.uuid === aircraftUuid)?.registration
        : undefined,
      before: before ? JSON.stringify(before) : undefined,
      after: JSON.stringify(next),
    },
    ...s.audit,
  ];
  return next;
}
