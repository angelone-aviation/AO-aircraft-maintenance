/**
 * Responsibility: The board view: who gets it, the read-only rule for board
 *   groups, and the fleet-summary snapshot a board member may read.
 * Layer: Domain. Pure functions; no I/O, no React (a `today` left to its
 *   default reads the clock).
 * Dependencies: ./model, ./management, ./workOrders, ./airworthiness,
 *   ./deferrals, ./components/records (types), ./programs, ./adOwnership,
 *   ./pickFields, ./costs/workOrderCosts, ./costs/period, ./rejection.
 *
 * The board snapshot is a whitelist of its own, not a cut of the owner
 * snapshot: every field a board member sees is named here (BOARD_FIELDS), so
 * a field added to the snapshot, a record or the owner view stays hidden from
 * the board until someone decides they may see it. Free text, people, rates
 * and files never pass; status inputs, totals and the names the due list
 * shows do.
 */
import type {
  Aircraft,
  Discrepancy,
  Group,
  Inspection,
  Snapshot,
} from "./model";
import { localDate } from "./model";
import type { ManagedRecord } from "./management";
import type { WorkOrder } from "./workOrders";
import type { AD, ADCompliance, ADSource } from "./airworthiness";
import type { Deferral } from "./deferrals";
import type { Component, ComponentRequirement } from "./components/records";
import { groupCoversAircraft, reducedViewGroups } from "./programs";
import { adAircraftUuid } from "./adOwnership";
import { pickFields } from "./pickFields";
import { aircraftSpendCents, findBudget } from "./costs/workOrderCosts";
import type { Period } from "./costs/period";
import { Rejection } from "./rejection";

const MONTHS_PER_QUARTER = 3;
/** What the board reads in place of a terminating action's text. */
export const BOARD_TERMINATED = "Terminating action recorded";

/**
 * The fields the board view copies from each kind of record, by name. Every
 * other field is cleared (descriptions, notes, reasons, people) or left out,
 * so a field added to a schema stays hidden from the board until it is
 * listed here. Inspection references and descriptions, requirement
 * descriptions and AD subjects pass: they are the names the due list shows.
 */
export const BOARD_FIELDS = {
  inspection: [
    "uuid",
    "version",
    "programUuid",
    "aircraftUuid",
    "componentUuid",
    "reference",
    "description",
    "ataChapter",
    "sourceKey",
    "usageMeter",
    "calendarExempt",
    "calendarExemptChangedAt",
    "dueSeconds",
    "dueCycles",
    "dueLandings",
    "dueDate",
    "intervalSeconds",
    "intervalLandings",
    "intervalCycles",
    "intervalMonths",
    "lastSeconds",
    "lastCycles",
    "lastLandings",
    "lastDate",
    "archived",
  ],
  ad: [
    "uuid",
    "version",
    "programUuid",
    "aircraftUuid",
    "componentUuid",
    "applicability",
    "priorCompliance",
    "reviewRequired",
    "updatedAt",
  ],
  adSource: [
    "number",
    "faaModified",
    "amendment",
    "issued",
    "effective",
    "subject",
    "recurring",
    "supersededBy",
    "url",
    "source",
    "section",
    "make",
    "model",
  ],
  adTask: [
    "uuid",
    "dueDate",
    "dueHours",
    "dueCycles",
    "dueLandings",
    "intervalLandings",
    "intervalDays",
    "intervalHours",
    "intervalCycles",
    "recurrence",
    "workOrderUuid",
  ],
  adCompliance: [
    "uuid",
    "taskUuid",
    "date",
    "hours",
    "cycles",
    "landings",
    "workOrderUuid",
    "recordedAt",
    "corrects",
  ],
  component: [
    "uuid",
    "version",
    "kind",
    "programUuid",
    "aircraftUuid",
    "parentComponentUuid",
    "createdAt",
    "ataChapter",
    "componentType",
    "partNumber",
    "serial",
    "model",
    "faaSearchModel",
    "manufacturer",
    "expirationDate",
    "usageMeter",
    "trackTime",
    "trackCycles",
    "trackCalendar",
    "installed",
    "installedDate",
    "removedDate",
    "installPosition",
    "installedSeconds",
    "installedCycles",
    "timeSinceNew",
    "timeSinceOverhaul",
    "timeSinceRepair",
    "cyclesSinceNew",
    "serviceDaysBase",
    "calendarSinceNewUnknown",
    "calendarOverhaulDaysBase",
    "calendarOverhaulDate",
  ],
  requirement: [
    "uuid",
    "version",
    "kind",
    "programUuid",
    "componentUuid",
    "aircraftUuid",
    "sourceKey",
    "requirementType",
    "description",
    "lastDate",
    "lastSeconds",
    "lastCycles",
    "lastLandings",
    "calendarIntervalValue",
    "calendarIntervalUnit",
    "intervalSeconds",
    "timeBasis",
    "timeLimitMode",
    "timeResetSeconds",
    "intervalLandings",
    "intervalCycles",
    "cycleLimitMode",
    "landingLimitMode",
    "landingReferenceAircraftUuid",
    "warningLandings",
    "dueDate",
    "dueSeconds",
    "dueCycles",
    "dueLandings",
    "warningCalendarMonths",
    "warningSeconds",
    "warningCycles",
  ],
} as const satisfies {
  inspection: readonly (keyof Inspection)[];
  ad: readonly (keyof AD)[];
  adSource: readonly (keyof ADSource)[];
  adTask: readonly (keyof AD["tasks"][number])[];
  adCompliance: readonly (keyof ADCompliance)[];
  component: readonly (keyof Component)[];
  requirement: readonly (keyof ComponentRequirement)[];
};

/** One aircraft's spend this quarter and this year against its budget. */
export interface BoardAircraftCosts {
  aircraftUuid: string;
  /** The calendar year the budget and `yearCents` cover. */
  year: number;
  /** The current calendar quarter, as "Q4 2026". */
  quarterLabel: string;
  quarterCents: number;
  yearCents: number;
  /** Undefined when the aircraft has no budget for the year. */
  budgetCents?: number;
  overBudget: boolean;
}

/**
 * Refuses a board group (`board: true`) that could write or administer, or
 * that is also an owner group: board groups are read-only, and a group is one
 * kind of reduced view or the other.
 *
 * @param g - The group being saved.
 * @throws {Rejection} "Board groups are read-only: remove administrator and
 *   write permissions."; "A group is a board group or an aircraft owner
 *   group, not both."
 */
export function validateBoardGroup(
  g: Pick<Group, "board" | "owner" | "programAdmin" | "permissions">,
) {
  if (!g.board) return;
  if (g.programAdmin || g.permissions.some((p) => p !== "read"))
    throw new Rejection(
      "Board groups are read-only: remove administrator and write permissions.",
    );
  if (g.owner)
    throw new Rejection(
      "A group is a board group or an aircraft owner group, not both.",
    );
}

/**
 * Tells whether the user gets the board view: they hold a board group with
 * read access in the active program, and every other such group is a board
 * or owner group. A user who also holds an owner group gets the owner portal
 * beside it; one ordinary group gives the workspace instead.
 *
 * @param s - The user, the groups and the programs.
 * @returns False for an inactive user or a system administrator.
 */
export function isBoardView(s: Pick<Snapshot, "user" | "groups" | "programs">) {
  return reducedViewGroups(s).some((g) => g.board);
}

/**
 * The aircraft the board view covers: those the user's board groups reach.
 * An owner group they also hold adds none.
 *
 * @param s - A snapshot scoped to the program, for a user in a board view.
 * @returns Those aircraft, in snapshot order.
 */
export function boardViewAircraft(
  s: Pick<Snapshot, "user" | "groups" | "programs" | "aircraft">,
): Aircraft[] {
  const board = reducedViewGroups(s).filter((g) => g.board);
  return s.aircraft.filter((a) =>
    board.some((g) => groupCoversAircraft(g, a.uuid)),
  );
}

/**
 * Totals each aircraft's spend for the current quarter and year against its
 * budget.
 *
 * @param s - A snapshot with the budgets and, unless `spend` is given, the
 *   cost records (a program administrator's, or the one the board whitelist
 *   is built from).
 * @param today - A local date; today by default.
 * @param spend - An aircraft's spend in cents over a period; by default
 *   totalled from the cost records (aircraftSpendCents). The server sums the
 *   cost ledger instead (ADR-0013).
 * @returns One row per aircraft in `s.aircraft`, in that order.
 */
export function boardCostTotals(
  s: Snapshot,
  today = localDate(),
  spend: (aircraftUuid: string, period: Period) => number = (a, p) =>
    aircraftSpendCents(s, a, p),
): BoardAircraftCosts[] {
  const { year, quarter, wholeYear } = boardCostPeriods(today);
  return s.aircraft.map((a) => {
    const budgetCents = findBudget(s, a.uuid, year)?.amountCents;
    const yearCents = spend(a.uuid, wholeYear);
    return {
      aircraftUuid: a.uuid,
      year,
      quarterLabel: quarter.label,
      quarterCents: spend(a.uuid, quarter),
      yearCents,
      budgetCents,
      overBudget: budgetCents !== undefined && yearCents > budgetCents,
    };
  });
}

/**
 * The periods the board totals: the calendar year and the quarter `today`
 * falls in, both inclusive.
 *
 * @param today - A local date.
 */
export function boardCostPeriods(today: string) {
  const year = Number(today.slice(0, 4));
  return {
    year,
    quarter: quarterPeriod(today),
    wholeYear: { from: `${year}-01-01`, to: `${year}-12-31` },
  };
}

/**
 * The board's cost rows for `s.aircraft`: those the server totalled from the
 * cost ledger (`s.boardCosts`) when present, else totalled here from the
 * cost records, as the demo does.
 *
 * @param today - A local date; today by default.
 * @returns One row per aircraft in `s.aircraft` that has one, in that order.
 */
export function boardCostRows(
  s: Snapshot,
  today = localDate(),
): BoardAircraftCosts[] {
  const totalled = s.boardCosts;
  if (!totalled) return boardCostTotals(s, today);
  return s.aircraft.flatMap((a) =>
    totalled.filter((c) => c.aircraftUuid === a.uuid),
  );
}

/**
 * Reduces a snapshot already scoped to the program and the board's aircraft
 * to the fleet summary a board member may read: aircraft identity and
 * counters, the due items and open discrepancies that decide status (no
 * notes, descriptions or people), completed work orders as number, dates and
 * scope, cost totals in place of cost records, and the backup time.
 *
 * @param s - A program-scoped snapshot that still holds cost records, or the
 *   board's cost rows the server totalled (`boardCosts`).
 * @param today - A local date for the cost periods; today by default.
 * @returns The user's own member record and groups; open discrepancies with
 *   grounding and deferral but no text; unarchived inspections, ADs and
 *   installed components with their requirements, free text cleared;
 *   completed work-order summaries; `boardCosts`; `offsiteBackupAt`. Flights,
 *   the change log, files, inventory, purchasing and other people are left
 *   out.
 */
export function boardSnapshot(s: Snapshot, today = localDate()): Snapshot {
  const ids = new Set(s.aircraft.map((a) => a.uuid));
  const components = findAircraftComponents(s, ids);
  return {
    programScopeVersion: s.programScopeVersion,
    activeProgramUuid: s.activeProgramUuid,
    programs: s.programs,
    user: s.user,
    authenticatedAt: s.authenticatedAt,
    syncedAt: s.syncedAt,
    groups: s.groups.filter((g) => s.user.groupIds.includes(g.id)),
    members: s.members.filter((m) => m.id === s.user.id),
    aircraft: s.aircraft,
    flights: [],
    audit: [],
    discrepancies: s.discrepancies
      .filter((d) => d.status === "open" && ids.has(d.aircraftUuid))
      .map(toBoardDiscrepancy),
    inspections: s.inspections
      .filter((i) => !i.archived && ids.has(i.aircraftUuid))
      .map(toBoardInspection),
    airworthiness: (s.airworthiness ?? [])
      .filter((r) => ids.has(adAircraftUuid(s, r)))
      .map(toBoardAD),
    management: (s.management ?? []).flatMap((r) =>
      toBoardRecords(r, components),
    ),
    workOrders: (s.workOrders ?? [])
      .filter((w) => w.status === "completed" && ids.has(w.aircraftUuid))
      .map(toBoardWorkOrder),
    boardCosts: boardCostRows(s, today),
    offsiteBackupAt: s.offsiteBackupAt,
  };
}

// The quarter `today` falls in, inclusive of its last day.
function quarterPeriod(today: string): Period & { label: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const index = Math.floor((month - 1) / MONTHS_PER_QUARTER);
  const first = index * MONTHS_PER_QUARTER + 1;
  const last = first + MONTHS_PER_QUARTER - 1;
  // Day 0 of the month after `last` is the last day of `last`.
  const lastDay = new Date(Date.UTC(year, last, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${year}-${pad(first)}-01`,
    to: `${year}-${pad(last)}-${pad(lastDay)}`,
    label: `Q${index + 1} ${year}`,
  };
}

function findAircraftComponents(s: Snapshot, aircraft: Set<string>) {
  return new Set(
    (s.management ?? [])
      .filter((r) => r.kind === "component" && aircraft.has(r.aircraftUuid))
      .map((r) => r.uuid),
  );
}

// Grounding and the deferral's type, category and expiry decide the status;
// the placard, the MEL item and the deferring person are not the board's
// business.
function toBoardDiscrepancy(d: Discrepancy): Discrepancy {
  return {
    uuid: d.uuid,
    aircraftUuid: d.aircraftUuid,
    description: "",
    status: d.status,
    createdAt: d.createdAt,
    authorId: "",
    grounding: d.grounding,
    deferral: d.deferral && toBoardDeferral(d.deferral),
  };
}

function toBoardDeferral(d: Deferral): Deferral {
  const recorded = {
    deferredOn: d.deferredOn,
    deferredAt: d.deferredAt,
    deferredBy: "",
    deferredByName: "",
    expiresOn: d.expiresOn,
  };
  if (d.type === "91.213d")
    return { type: d.type, notHazard: d.notHazard, placard: "", ...recorded };
  return {
    type: d.type,
    category: d.category,
    days: d.days,
    melItem: "",
    placard: "",
    ...recorded,
  };
}

function toBoardInspection(i: Inspection): Inspection {
  return pickFields(i, BOARD_FIELDS.inspection);
}

// Due limits, applicability and the compliance dates and counters decide an
// AD's status; the notes, the method and the mechanics who complied do not.
// Whether a terminating action was recorded stops the recurrence, so its
// presence passes as a fixed phrase, never the text typed.
function toBoardAD(r: AD): AD {
  return {
    ...pickFields(r, BOARD_FIELDS.ad),
    reason: "",
    source: toBoardADSource(r.source),
    sourceHistory: r.sourceHistory.map((h) => ({
      at: h.at,
      source: toBoardADSource(h.source),
    })),
    tasks: r.tasks.map((t) => ({
      ...pickFields(t, BOARD_FIELDS.adTask),
      description: "",
    })),
    history: r.history.map(toBoardCompliance),
  };
}

function toBoardADSource(source: ADSource): ADSource {
  return { ...pickFields(source, BOARD_FIELDS.adSource), sourceNotes: "" };
}

function toBoardCompliance(h: ADCompliance): ADCompliance {
  return {
    ...pickFields(h, BOARD_FIELDS.adCompliance),
    method: "",
    serviceBulletin: "",
    terminatedBy: h.terminatedBy ? BOARD_TERMINATED : "",
    mechanic: "",
    certificate: "",
    evidence: "",
    recordedBy: "",
  };
}

function toBoardRecords(
  r: ManagedRecord,
  components: Set<string>,
): ManagedRecord[] {
  if (r.kind === "component" && components.has(r.uuid))
    return [{ ...pickFields(r, BOARD_FIELDS.component), notes: "" }];
  if (r.kind === "componentRequirement" && components.has(r.componentUuid))
    return [{ ...pickFields(r, BOARD_FIELDS.requirement), notes: "" }];
  return [];
}

// Only identity, dates and the scope line leave the server.
function toBoardWorkOrder(w: WorkOrder): WorkOrder {
  return {
    uuid: w.uuid,
    version: w.version,
    recordedAt: w.recordedAt,
    number: w.number,
    aircraftUuid: w.aircraftUuid,
    aircraft: w.aircraft,
    dateOpened: w.dateOpened,
    completionDate: w.completionDate,
    status: w.status,
    priority: w.priority,
    scope: w.scope,
    supervisor: "",
    releaseOutcome: "",
    createdBy: "",
    componentReadings: [],
    tasks: [],
  };
}
