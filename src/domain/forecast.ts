import { adCounters, adTaskStatus } from "./airworthiness";
import { adAircraftUuid } from "./adOwnership";
import {
  requirementDueDate,
  requirementStatus,
  type Component,
} from "./components";
import { meterAtFlight } from "./flights";
import { inspectionCounters } from "./management";
import { inspectionDueDate, inspectionStatus } from "./maintenance";
import {
  hours,
  localDate,
  type Aircraft,
  type Flight,
  type Snapshot,
} from "./model";

export const DEFAULT_WINDOW_DAYS = 90;
const MIN_FLIGHTS = 3;
const MIN_HISTORY_DAYS = 14;
// Beyond a century a projection is noise and risks invalid dates.
const MAX_PROJECTION_DAYS = 36500;
const dayMs = 86400000;

export interface Rates {
  secondsPerDay: number;
  collectiveSecondsPerDay: number;
  cyclesPerDay: number;
  landingsPerDay: number;
}
export type Utilization =
  | { kind: "insufficient"; note: string }
  | (Rates & {
      kind: "rate";
      flights: number;
      days: number;
      confidence: "normal" | "low";
      note: string;
    });
export interface Remaining {
  seconds?: number;
  cycles?: number;
  landings?: number;
  dueDate?: string;
}
export type Basis = "hours" | "cycles" | "landings" | "calendar";
export interface Projection {
  date: string;
  basis: Basis;
  overdue: boolean;
}
export interface ForecastItem {
  key: string;
  kind: "inspection" | "component" | "ad";
  /** Undefined for components held in inventory. */
  aircraftUuid?: string;
  title: string;
  detail: string;
  status: string;
  remaining: string;
  projection?: Projection;
  note: string;
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / dayMs);
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date + "T00:00:00Z") + days * dayMs)
    .toISOString()
    .slice(0, 10);
}

function flightUsage(aircraft: Aircraft, f: Flight) {
  const meter = meterAtFlight(aircraft, f.startTime);
  const [start, end] =
    meter === "tach"
      ? [f.tachOff, f.tachOn]
      : meter === "flightTimeLog"
        ? [f.flightTimeLogOff, f.flightTimeLogOn]
        : meter === "cyclic"
          ? [f.cyclicHobbsOff, f.cyclicHobbsOn]
          : [f.hobbsOff, f.hobbsOn];
  const span = (a?: number, b?: number) =>
    a === undefined || b === undefined ? 0 : Math.max(0, b - a);
  return {
    seconds: span(start, end),
    collective: span(f.cyclicHobbsOff, f.cyclicHobbsOn),
    cycles: f.cycles,
    landings: f.landings,
  };
}

/** Average daily usage from accepted flights; held or rejected flights are excluded from totals. */
export function utilization(
  aircraft: Aircraft,
  flights: Flight[],
  today = localDate(),
  windowDays = DEFAULT_WINDOW_DAYS,
): Utilization {
  const logged = flights
    .filter((f) => f.aircraftUuid === aircraft.uuid && f.status === "accepted")
    .map((f) => ({ f, date: localDate(Date.parse(f.startTime)) }))
    .filter((x) => x.date <= today);
  if (!logged.length)
    return {
      kind: "insufficient",
      note: "No accepted flights recorded for this aircraft.",
    };
  const earliest = logged.reduce(
    (min, x) => (x.date < min ? x.date : min),
    today,
  );
  const windowStart = addDays(today, -windowDays);
  const span = (from: string) => Math.max(1, daysBetween(from, today));
  const inWindow = logged.filter((x) => x.date > windowStart);
  const windowDaysUsed = span(earliest > windowStart ? earliest : windowStart);
  const windowOk =
    inWindow.length >= MIN_FLIGHTS && windowDaysUsed >= MIN_HISTORY_DAYS;
  const used = windowOk ? inWindow : logged;
  const days = windowOk ? windowDaysUsed : span(earliest);
  const totals = used.reduce(
    (t, { f }) => {
      const u = flightUsage(aircraft, f);
      return {
        seconds: t.seconds + u.seconds,
        collective: t.collective + u.collective,
        cycles: t.cycles + u.cycles,
        landings: t.landings + u.landings,
      };
    },
    { seconds: 0, collective: 0, cycles: 0, landings: 0 },
  );
  const low = used.length < MIN_FLIGHTS || days < MIN_HISTORY_DAYS;
  const basis = `${used.length} flight${used.length === 1 ? "" : "s"} over ${days} day${days === 1 ? "" : "s"}`;
  return {
    kind: "rate",
    secondsPerDay: totals.seconds / days,
    collectiveSecondsPerDay: totals.collective / days,
    cyclesPerDay: totals.cycles / days,
    landingsPerDay: totals.landings / days,
    flights: used.length,
    days,
    confidence: low ? "low" : "normal",
    note: windowOk
      ? `Based on ${basis} (last ${windowDays} days).`
      : `${low ? "Low confidence: based" : "Based"} on all history, ${basis}; the last ${windowDays} days had too little data.`,
  };
}

/** Earliest of the usage-projected and calendar dates ("whichever comes first"). */
export function projectDue(
  remaining: Remaining,
  rates: Partial<Rates> & { secondsPerDay?: number } = {},
  today = localDate(),
): Projection | undefined {
  const candidates: Projection[] = [];
  const usage = (
    basis: Basis,
    left: number | undefined,
    rate: number | undefined,
  ) => {
    if (left === undefined) return;
    if (left <= 0)
      return candidates.push({ date: today, basis, overdue: true });
    if (!rate || rate <= 0) return;
    // Epsilon absorbs float error so exact multiples land on the same day.
    const days = Math.ceil(left / rate - 1e-9);
    if (days <= MAX_PROJECTION_DAYS)
      candidates.push({ date: addDays(today, days), basis, overdue: false });
  };
  usage("hours", remaining.seconds, rates.secondsPerDay);
  usage("cycles", remaining.cycles, rates.cyclesPerDay);
  usage("landings", remaining.landings, rates.landingsPerDay);
  if (remaining.dueDate)
    candidates.push(
      remaining.dueDate < today
        ? { date: today, basis: "calendar", overdue: true }
        : { date: remaining.dueDate, basis: "calendar", overdue: false },
    );
  return candidates.reduce<Projection | undefined>(
    (best, c) =>
      !best ||
      c.date < best.date ||
      (c.date === best.date && c.overdue && !best.overdue)
        ? c
        : best,
    undefined,
  );
}

const amount = (n: number, unit: string, digits = 0) =>
  `${Math.abs(n).toFixed(digits)} ${unit}${n < 0 ? " overdue" : ""}`;
export function remainingText(r: Remaining) {
  return [
    r.seconds !== undefined &&
      (r.seconds < 0
        ? `${hours(-r.seconds)} h overdue`
        : `${hours(r.seconds)} h`),
    r.cycles !== undefined && amount(r.cycles, "cycles"),
    r.landings !== undefined && amount(r.landings, "landings"),
    r.dueDate && `due ${r.dueDate}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

const noRates: Rates = {
  secondsPerDay: 0,
  collectiveSecondsPerDay: 0,
  cyclesPerDay: 0,
  landingsPerDay: 0,
};
function project(
  base: Omit<ForecastItem, "remaining" | "projection" | "note">,
  remaining: Remaining,
  use: Utilization | undefined,
  rates: Rates,
  today: string,
): ForecastItem | undefined {
  if (
    [remaining.seconds, remaining.cycles, remaining.landings].every(
      (n) => n === undefined,
    ) &&
    !remaining.dueDate
  )
    return undefined;
  const projection = projectDue(remaining, rates, today);
  const usageLimited =
    remaining.seconds !== undefined ||
    remaining.cycles !== undefined ||
    remaining.landings !== undefined;
  const note = !use
    ? usageLimited
      ? "Held in inventory; usage limits do not advance."
      : "Calendar limit only."
    : use.kind === "insufficient"
      ? `${use.note}${usageLimited ? " Usage limits are not projected." : ""}`
      : projection
        ? use.note
        : `${use.note} No usage recorded on this item's limits.`;
  return {
    ...base,
    remaining: remainingText(remaining),
    projection,
    note,
  };
}

/** Projected due dates for every inspection, component requirement and AD task with limits. */
export function forecast(
  s: Snapshot,
  today = localDate(),
  windowDays = DEFAULT_WINDOW_DAYS,
): ForecastItem[] {
  const cache = new Map<string, Utilization>();
  const usageOf = (a: Aircraft) => {
    if (!cache.has(a.uuid))
      cache.set(a.uuid, utilization(a, s.flights, today, windowDays));
    return cache.get(a.uuid)!;
  };
  const ratesOf = (
    use: Utilization | undefined,
    meter?: "aircraft" | "collective",
    track = { time: true, cycles: true },
  ): Rates =>
    use?.kind !== "rate"
      ? noRates
      : {
          ...use,
          secondsPerDay: !track.time
            ? 0
            : meter === "collective"
              ? use.collectiveSecondsPerDay
              : use.secondsPerDay,
          cyclesPerDay: track.cycles ? use.cyclesPerDay : 0,
        };
  const failed = (
    base: Omit<ForecastItem, "remaining" | "projection" | "note">,
    e: unknown,
  ): ForecastItem => ({
    ...base,
    remaining: "",
    note: e instanceof Error ? e.message : "Unable to read current totals.",
  });
  const items: (ForecastItem | undefined)[] = [];
  for (const i of s.inspections) {
    if (i.archived) continue;
    const a = s.aircraft.find((a) => a.uuid === i.aircraftUuid);
    if (!a) continue;
    const base = {
      key: i.uuid,
      kind: "inspection" as const,
      aircraftUuid: a.uuid,
      title: i.reference,
      detail: i.description,
      status: "unknown",
    };
    try {
      const st = inspectionStatus(
        i,
        a,
        today,
        inspectionCounters(i, a, s.management),
      );
      const component = s.management?.find(
        (c): c is Component =>
          c.kind === "component" && c.uuid === i.componentUuid,
      );
      const use = usageOf(a);
      items.push(
        project(
          { ...base, status: st.status },
          {
            seconds:
              st.hoursRemaining === undefined
                ? undefined
                : Math.round(st.hoursRemaining * 3600),
            cycles: st.cyclesRemaining,
            landings: st.landingsRemaining,
            dueDate: inspectionDueDate(i),
          },
          use,
          ratesOf(
            use,
            component?.usageMeter ?? i.usageMeter,
            component
              ? { time: component.trackTime, cycles: component.trackCycles }
              : undefined,
          ),
          today,
        ),
      );
    } catch (e) {
      items.push(failed(base, e));
    }
  }
  for (const r of s.management ?? []) {
    if (r.kind !== "componentRequirement") continue;
    const c = s.management!.find(
      (c): c is Component =>
        c.kind === "component" && c.uuid === r.componentUuid,
    );
    if (!c) continue;
    const a = c.installed
      ? s.aircraft.find((a) => a.uuid === c.aircraftUuid)
      : undefined;
    if (c.installed && !a) continue;
    const base = {
      key: r.uuid,
      kind: "component" as const,
      aircraftUuid: a?.uuid,
      title: `${c.componentType} ${c.partNumber} S/N ${c.serial}`.trim(),
      detail: `${r.requirementType}: ${r.description}`,
      status: "unknown",
    };
    try {
      const st = requirementStatus(r, c, a, today);
      const use = a && usageOf(a);
      items.push(
        project(
          { ...base, status: st.status },
          {
            seconds: st.seconds,
            cycles: st.cycles,
            landings: st.landings,
            dueDate: requirementDueDate(r),
          },
          use,
          ratesOf(use, c.usageMeter, {
            time: c.trackTime,
            cycles: c.trackCycles,
          }),
          today,
        ),
      );
    } catch (e) {
      items.push(failed(base, e));
    }
  }
  for (const r of s.airworthiness ?? []) {
    if (["Not applicable", "Superseded"].includes(r.applicability)) continue;
    const a = s.aircraft.find((a) => a.uuid === adAircraftUuid(s, r));
    if (!a) continue;
    const c = s.management?.find(
      (c): c is Component =>
        c.kind === "component" && c.uuid === r.componentUuid,
    );
    const counters = adCounters(s, r);
    const inventory = !!c && !c.installed;
    const use = inventory ? undefined : usageOf(a);
    for (const t of r.tasks) {
      const status = adTaskStatus(s, r, t, today);
      if (status === "Complied" || status === "Due not set") continue;
      const hoursOk = counters && t.dueHours !== null && (!c || c.trackTime);
      const cyclesOk =
        counters && t.dueCycles !== null && (!c || c.trackCycles);
      items.push(
        project(
          {
            key: `${r.uuid}:${t.uuid}`,
            kind: "ad",
            aircraftUuid: inventory ? undefined : a.uuid,
            title: `AD ${r.source.number}`,
            detail: t.description,
            status,
          },
          {
            seconds: hoursOk
              ? Math.round((t.dueHours! - counters.hours) * 3600)
              : undefined,
            cycles: cyclesOk ? t.dueCycles! - counters.cycles : undefined,
            landings:
              counters && t.dueLandings != null
                ? t.dueLandings - counters.landings
                : undefined,
            dueDate: t.dueDate || undefined,
          },
          use,
          ratesOf(use, c?.usageMeter),
          today,
        ),
      );
    }
  }
  return items
    .filter((x): x is ForecastItem => !!x)
    .sort(
      (a, b) =>
        (a.projection?.date ?? "9999").localeCompare(
          b.projection?.date ?? "9999",
        ) || a.title.localeCompare(b.title),
    );
}

/** Monday of the item's week, for grouping. */
export function weekOf(date: string) {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

/** Upcoming (not overdue) projected dates keyed by inspection uuid, for inline hints. */
export function inspectionProjections(s: Snapshot, today = localDate()) {
  return new Map(
    forecast(s, today)
      .filter(
        (i) => i.kind === "inspection" && i.projection && !i.projection.overdue,
      )
      .map((i) => [i.key, i.projection!.date]),
  );
}
