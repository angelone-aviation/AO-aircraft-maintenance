/**
 * Responsibility: The maintenance forecast: each aircraft's recent daily usage,
 *   and when every inspection, component requirement and AD task falls due.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ./airworthiness, ./components, ./dueItems, ./flights,
 *   ./maintenance, ./model.
 */
import { adCounters, CLOSED_APPLICABILITY, type ADTask } from "./airworthiness";
import { requirementDueDate, type Component } from "./components";
import {
  dueItems,
  type AdDue,
  type InspectionDue,
  type MaintenanceDue,
  type RequirementDue,
} from "./dueItems";
import { meterAtFlight } from "./flights";
import { inspectionDueDate } from "./maintenance";
import {
  hours,
  localDate,
  type Aircraft,
  type Flight,
  type Snapshot,
} from "./model";

/** The usage window, in days, that daily rates are averaged over by default. */
export const DEFAULT_WINDOW_DAYS = 90;
const MIN_FLIGHTS = 3;
const MIN_HISTORY_DAYS = 14;
// Beyond a century a projection is noise and risks invalid dates.
const MAX_PROJECTION_DAYS = 36500;
// Absorbs float error so exact multiples of a daily rate land on the same day.
const PROJECTION_EPSILON_DAYS = 1e-9;
const MS_PER_DAY = 86_400_000;
const SECONDS_PER_HOUR = 3600;
const UTC_MIDNIGHT = "T00:00:00Z";
// Sorts after every ISO date, so unprojected items come last.
const UNPROJECTED_SORT_KEY = "9999";
const NO_RATES: Rates = {
  secondsPerDay: 0,
  collectiveSecondsPerDay: 0,
  cyclesPerDay: 0,
  landingsPerDay: 0,
};

// Each meter's off and on readings on a flight; any other meter reads hobbs.
const METER_READINGS = {
  hobbs: ["hobbsOff", "hobbsOn"],
  tach: ["tachOff", "tachOn"],
  flightTimeLog: ["flightTimeLogOff", "flightTimeLogOn"],
  cyclic: ["cyclicHobbsOff", "cyclicHobbsOn"],
} as const;

/** Average usage per calendar day; seconds are on the aircraft's meter. */
export interface Rates {
  secondsPerDay: number;
  collectiveSecondsPerDay: number;
  cyclesPerDay: number;
  landingsPerDay: number;
}

/**
 * An aircraft's daily usage rates with the flights and days behind them, or
 * "insufficient" with the reason when it has no accepted flight.
 */
export type Utilization =
  | { kind: "insufficient"; note: string }
  | (Rates & {
      kind: "rate";
      flights: number;
      days: number;
      confidence: "normal" | "low";
      note: string;
    });

/**
 * What is left before an item falls due; a usage value of 0 or less is
 * overdue. A missing field sets no limit.
 */
export interface Remaining {
  seconds?: number;
  cycles?: number;
  landings?: number;
  dueDate?: string;
}

/** The limit that decides a projected due date. */
export type Basis = "hours" | "cycles" | "landings" | "calendar";

/** A projected due date and its limit; an overdue item is placed on today. */
export interface Projection {
  date: string;
  basis: Basis;
  overdue: boolean;
}

/**
 * One forecast row: an inspection, a component requirement or an AD task, with
 * its status, what remains, its projection and how that was made.
 */
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

type ItemBase = Omit<ForecastItem, "remaining" | "projection" | "note">;

interface ForecastContext {
  s: Snapshot;
  today: string;
  usageOf: (a: Aircraft) => Utilization;
}

/**
 * Whole days from one ISO date to another, rounded to the nearest day.
 *
 * @returns Negative when `to` is before `from`.
 */
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / MS_PER_DAY);

/**
 * Moves an ISO date by whole days, in UTC so no time zone shifts it.
 *
 * @throws {RangeError} When the result is not a valid date.
 */
export function addDays(date: string, days: number) {
  return new Date(Date.parse(date + UTC_MIDNIGHT) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Average daily usage of one aircraft from its accepted flights up to today.
 * Uses the last `windowDays` when they hold at least 3 flights over at least
 * 14 days, otherwise all history; less than that is low confidence.
 *
 * @param aircraft - The aircraft; its meter decides which readings count.
 * @param flights - Flights of any aircraft; held and rejected ones are skipped.
 * @param today - The last day counted.
 * @param windowDays - The preferred window.
 * @returns Rates over at least 1 day, with a note naming the flights and days.
 */
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
  const { used, days, windowOk } = chooseHistory(logged, today, windowDays);
  const totals = sumUsage(aircraft, used);
  const low = used.length < MIN_FLIGHTS || days < MIN_HISTORY_DAYS;
  const basis = `${plural(used.length, "flight")} over ${plural(days, "day")}`;
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

/**
 * Projects when an item falls due, whichever limit comes first: each usage
 * limit at its daily rate, rounded up to whole days, and the calendar date.
 * A limit already reached is overdue today; a limit with no usage, or more
 * than a century out, is not projected.
 *
 * @param remaining - What is left on each limit.
 * @param rates - Daily rates; a missing or zero rate never projects.
 * @param today - The day projections count from.
 * @returns The earliest projection, or undefined when no limit projects.
 * @throws {RangeError} When `today` is not an ISO date.
 */
export function projectDue(
  remaining: Remaining,
  rates: Partial<Rates> & { secondsPerDay?: number } = {},
  today = localDate(),
): Projection | undefined {
  return [
    projectUsage("hours", remaining.seconds, rates.secondsPerDay, today),
    projectUsage("cycles", remaining.cycles, rates.cyclesPerDay, today),
    projectUsage("landings", remaining.landings, rates.landingsPerDay, today),
    projectCalendar(remaining.dueDate, today),
  ].reduce<Projection | undefined>(pickEarlier, undefined);
}

/**
 * Formats what is left, such as "1.5 h · 3 cycles overdue · due 2027-01-31",
 * leaving out limits that are not set.
 */
export function remainingText(r: Remaining) {
  return [
    r.seconds !== undefined &&
      (r.seconds < 0
        ? `${hours(-r.seconds)} h overdue`
        : `${hours(r.seconds)} h`),
    r.cycles !== undefined && formatAmount(r.cycles, "cycles"),
    r.landings !== undefined && formatAmount(r.landings, "landings"),
    r.dueDate && `due ${r.dueDate}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Projects every unarchived inspection, component requirement and applicable
 * AD task with a limit. An inspection or requirement whose totals cannot be
 * read still lists, with the reason as its note and no projection.
 *
 * @param s - The snapshot.
 * @param today - The day projections count from and totals are read on.
 * @param windowDays - The usage window for each aircraft's rates.
 * @returns Items by projected date, then title; unprojected items last.
 */
export function forecast(
  s: Snapshot,
  today = localDate(),
  windowDays = DEFAULT_WINDOW_DAYS,
): ForecastItem[] {
  const context = { s, today, usageOf: cacheUtilization(s, today, windowDays) };
  const due = dueItems(s, undefined, today);
  return [
    ...inspectionItems(context, due),
    ...requirementItems(context, due),
    ...adItems(context, due),
  ]
    .filter((x): x is ForecastItem => !!x)
    .sort(
      (a, b) =>
        (a.projection?.date ?? UNPROJECTED_SORT_KEY).localeCompare(
          b.projection?.date ?? UNPROJECTED_SORT_KEY,
        ) || a.title.localeCompare(b.title),
    );
}

/** The Monday that starts an ISO date's week, for grouping. */
export function weekOf(date: string) {
  const day = new Date(date + UTC_MIDNIGHT).getUTCDay();
  // getUTCDay counts from Sunday (0); this counts back to Monday.
  return addDays(date, -((day + 6) % 7));
}

/**
 * Upcoming projected due dates of inspections, for inline hints; overdue and
 * unprojected inspections are left out.
 *
 * @returns Projected ISO dates keyed by inspection uuid.
 */
export function inspectionProjections(s: Snapshot, today = localDate()) {
  return new Map(
    forecast(s, today)
      .filter(
        (i) => i.kind === "inspection" && i.projection && !i.projection.overdue,
      )
      .map((i) => [i.key, i.projection!.date]),
  );
}

// The window when it holds enough flights over enough days, else all history.
function chooseHistory(
  logged: { f: Flight; date: string }[],
  today: string,
  windowDays: number,
) {
  const earliest = logged.reduce(
    (min, x) => (x.date < min ? x.date : min),
    today,
  );
  const windowStart = addDays(today, -windowDays);
  const inWindow = logged.filter((x) => x.date > windowStart);
  const windowSpan = spanDays(
    earliest > windowStart ? earliest : windowStart,
    today,
  );
  const windowOk =
    inWindow.length >= MIN_FLIGHTS && windowSpan >= MIN_HISTORY_DAYS;
  return windowOk
    ? { used: inWindow, days: windowSpan, windowOk }
    : { used: logged, days: spanDays(earliest, today), windowOk };
}

function sumUsage(aircraft: Aircraft, used: { f: Flight }[]) {
  return used.reduce(
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
}

// Seconds come from the meter the aircraft used on the flight's date, so a
// meter change does not mix readings.
function flightUsage(aircraft: Aircraft, f: Flight) {
  const meter = meterAtFlight(aircraft, f.startTime);
  const [off, on] = METER_READINGS[meter] ?? METER_READINGS.hobbs;
  return {
    seconds: readingSpan(f[off], f[on]),
    collective: readingSpan(f.cyclicHobbsOff, f.cyclicHobbsOn),
    cycles: f.cycles,
    landings: f.landings,
  };
}

function readingSpan(off?: number, on?: number) {
  return off === undefined || on === undefined ? 0 : Math.max(0, on - off);
}

function spanDays(from: string, today: string) {
  return Math.max(1, daysBetween(from, today));
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function projectUsage(
  basis: Basis,
  left: number | undefined,
  rate: number | undefined,
  today: string,
): Projection | undefined {
  if (left === undefined) return undefined;
  if (left <= 0) return { date: today, basis, overdue: true };
  if (!rate || rate <= 0) return undefined;
  const days = Math.ceil(left / rate - PROJECTION_EPSILON_DAYS);
  return days <= MAX_PROJECTION_DAYS
    ? { date: addDays(today, days), basis, overdue: false }
    : undefined;
}

function projectCalendar(
  dueDate: string | undefined,
  today: string,
): Projection | undefined {
  if (!dueDate) return undefined;
  return dueDate < today
    ? { date: today, basis: "calendar", overdue: true }
    : { date: dueDate, basis: "calendar", overdue: false };
}

// On the same date an overdue projection wins; otherwise the first listed.
function pickEarlier(
  best: Projection | undefined,
  next: Projection | undefined,
) {
  if (!next) return best;
  const earlier =
    !best ||
    next.date < best.date ||
    (next.date === best.date && next.overdue && !best.overdue);
  return earlier ? next : best;
}

function formatAmount(n: number, unit: string) {
  return `${Math.abs(n).toFixed(0)} ${unit}${n < 0 ? " overdue" : ""}`;
}

function cacheUtilization(s: Snapshot, today: string, windowDays: number) {
  const cache = new Map<string, Utilization>();
  return (a: Aircraft) => {
    if (!cache.has(a.uuid))
      cache.set(a.uuid, utilization(a, s.flights, today, windowDays));
    return cache.get(a.uuid)!;
  };
}

function findComponent(s: Snapshot, uuid: string | undefined) {
  return s.management?.find(
    (c): c is Component => c.kind === "component" && c.uuid === uuid,
  );
}

// A dimension the component does not track never advances.
function ratesFor(
  use: Utilization | undefined,
  meter?: "aircraft" | "collective",
  component?: Component,
): Rates {
  if (use?.kind !== "rate") return NO_RATES;
  const secondsPerDay =
    meter === "collective" ? use.collectiveSecondsPerDay : use.secondsPerDay;
  return {
    ...use,
    secondsPerDay: !component || component.trackTime ? secondsPerDay : 0,
    cyclesPerDay: !component || component.trackCycles ? use.cyclesPerDay : 0,
  };
}

function projectItem(
  base: ItemBase,
  remaining: Remaining,
  use: Utilization | undefined,
  rates: Rates,
  today: string,
): ForecastItem | undefined {
  const usageLimited =
    remaining.seconds !== undefined ||
    remaining.cycles !== undefined ||
    remaining.landings !== undefined;
  if (!usageLimited && !remaining.dueDate) return undefined;
  const projection = projectDue(remaining, rates, today);
  return {
    ...base,
    remaining: remainingText(remaining),
    projection,
    note: projectionNote(use, usageLimited, !!projection),
  };
}

// No utilization means the item is held in inventory.
function projectionNote(
  use: Utilization | undefined,
  usageLimited: boolean,
  projected: boolean,
) {
  if (!use)
    return usageLimited
      ? "Held in inventory; usage limits do not advance."
      : "Calendar limit only.";
  if (use.kind === "insufficient")
    return usageLimited
      ? `${use.note} Usage limits are not projected.`
      : use.note;
  return projected
    ? use.note
    : `${use.note} No usage recorded on this item's limits.`;
}

// The item still lists, with the reason, so the planner does not lose it:
// its totals cannot be read (what dueItems kept), or `today` is not a date.
function failedItem(base: ItemBase, e: unknown): ForecastItem {
  return {
    ...base,
    remaining: "",
    note: e instanceof Error ? e.message : "Unable to read current totals.",
  };
}

function inspectionItems(context: ForecastContext, due: MaintenanceDue[]) {
  return due.flatMap((item) =>
    item.kind === "inspection" ? [inspectionItem(context, item)] : [],
  );
}

function inspectionItem(
  { s, today, usageOf }: ForecastContext,
  item: InspectionDue,
) {
  const { inspection: i, aircraft: a } = item;
  const base: ItemBase = {
    key: i.uuid,
    kind: "inspection",
    aircraftUuid: a.uuid,
    title: i.reference,
    detail: i.description,
    status: "unknown",
  };
  if (!item.due) return failedItem(base, item.error);
  const st = item.due;
  try {
    const component = findComponent(s, i.componentUuid);
    const use = usageOf(a);
    const remaining = {
      seconds:
        st.hoursRemaining === undefined
          ? undefined
          : Math.round(st.hoursRemaining * SECONDS_PER_HOUR),
      cycles: st.cyclesRemaining,
      landings: st.landingsRemaining,
      dueDate: inspectionDueDate(i),
    };
    const meter = component?.usageMeter ?? i.usageMeter;
    const rates = ratesFor(use, meter, component);
    const projected = { ...base, status: st.status };
    return projectItem(projected, remaining, use, rates, today);
  } catch (e) {
    return failedItem(base, e);
  }
}

function requirementItems(context: ForecastContext, due: MaintenanceDue[]) {
  return due.flatMap((item) =>
    item.kind === "componentRequirement"
      ? [requirementItem(context, item)]
      : [],
  );
}

// No aircraft for a component held in inventory: its usage limits do not
// advance, so only its calendar limit projects.
function requirementItem(
  { today, usageOf }: ForecastContext,
  item: RequirementDue,
) {
  const { requirement: r, component: c, aircraft: a } = item;
  const base: ItemBase = {
    key: r.uuid,
    kind: "component",
    aircraftUuid: a?.uuid,
    title: `${c.componentType} ${c.partNumber} S/N ${c.serial}`.trim(),
    detail: `${r.requirementType}: ${r.description}`,
    status: "unknown",
  };
  if (!item.due) return failedItem(base, item.error);
  const st = item.due;
  try {
    const use = a && usageOf(a);
    const remaining = {
      seconds: st.seconds,
      cycles: st.cycles,
      landings: st.landings,
      dueDate: requirementDueDate(r),
    };
    const rates = ratesFor(use, c.usageMeter, c);
    const projected = { ...base, status: st.status };
    return projectItem(projected, remaining, use, rates, today);
  } catch (e) {
    return failedItem(base, e);
  }
}

function adItems(context: ForecastContext, due: MaintenanceDue[]) {
  return due.flatMap((item) => {
    if (item.kind !== "ad" || !item.aircraft) return [];
    if (CLOSED_APPLICABILITY.includes(item.ad.applicability)) return [];
    return adTaskItems(context, item, item.aircraft);
  });
}

// Complied tasks and tasks without a due value have nothing to project.
function adTaskItems(
  { s, today, usageOf }: ForecastContext,
  { ad: r, component: c, tasks }: AdDue,
  a: Aircraft,
) {
  const counters = adCounters(s, r);
  const inventory = !!c && !c.installed;
  const use = inventory ? undefined : usageOf(a);
  return tasks.map(({ task: t, status }) => {
    if (status === "Complied" || status === "Due not set") return undefined;
    const base: ItemBase = {
      key: `${r.uuid}:${t.uuid}`,
      kind: "ad",
      aircraftUuid: inventory ? undefined : a.uuid,
      title: `AD ${r.source.number}`,
      detail: t.description,
      status,
    };
    const remaining = adTaskRemaining(t, counters, c);
    const rates = ratesFor(use, c?.usageMeter);
    return projectItem(base, remaining, use, rates, today);
  });
}

// A component AD counts only the hours and cycles that component tracks.
function adTaskRemaining(
  t: ADTask,
  counters: ReturnType<typeof adCounters>,
  c: Component | undefined,
): Remaining {
  const hoursOk = counters && t.dueHours !== null && (!c || c.trackTime);
  const cyclesOk = counters && t.dueCycles !== null && (!c || c.trackCycles);
  return {
    seconds: hoursOk
      ? Math.round((t.dueHours! - counters.hours) * SECONDS_PER_HOUR)
      : undefined,
    cycles: cyclesOk ? t.dueCycles! - counters.cycles : undefined,
    landings:
      counters && t.dueLandings != null
        ? t.dueLandings - counters.landings
        : undefined,
    dueDate: t.dueDate || undefined,
  };
}
