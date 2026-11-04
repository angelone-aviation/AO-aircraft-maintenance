/**
 * Responsibility: Saving an inspection schedule and recording its completion,
 *   with the next due point each recurring interval sets.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../maintenance, ../requiredParts, ../rejection,
 *   ./schemas, ./context, ./counters.
 */
import { latestLocalDate, type Inspection, type Snapshot } from "../model";
import { endOfDueMonth } from "../maintenance";
import { validateRequiredParts } from "../requiredParts";
import { Rejection } from "../rejection";
import type { CommandOf } from "./schemas";
import type { Context } from "./context";
import { inspectionCounters } from "./counters";

type InspectionRecord = CommandOf<"inspection.save">["record"];

/**
 * Saves an aircraft or component inspection schedule, stamped with its
 * program and calendar-exemption change, one version on.
 *
 * @throws {Rejection} In order: "Enter a reason/reference for the calendar
 *   exemption."; "Create a new schedule with verified baselines to change its
 *   time source."; as {@link validateRequiredParts}; "Create a new schedule
 *   to change the tracked component."; as {@link inspectionCounters}; "Enter
 *   at least one due limit or recurring interval."; "Service dates cannot be
 *   in the future."; "Last compliance cannot exceed aircraft totals."; "Each
 *   interval requires its last compliance reading or date.".
 */
export function saveInspection(
  s: Snapshot,
  r: InspectionRecord,
  ctx: Context,
): Inspection {
  const prior = ctx.existing as Inspection | undefined;
  stampCalendarExemption(s, r, prior, ctx.now);
  r.programUuid = ctx.aircraft!.programUuid;
  if (prior) {
    r.usageMeter ??= prior.usageMeter;
    if ((r.usageMeter ?? "aircraft") !== (prior.usageMeter ?? "aircraft"))
      throw new Rejection(
        "Create a new schedule with verified baselines to change its time source.",
      );
  }
  if (r.requiredParts === undefined) r.requiredParts = prior?.requiredParts;
  validateRequiredParts(s, r.requiredParts, r.programUuid);
  if (prior && prior.componentUuid !== r.componentUuid)
    throw new Rejection(
      "Create a new schedule to change the tracked component.",
    );
  const counters = inspectionCounters(r, ctx.aircraft!, ctx.records);
  assertInspectionLimits(r, counters, ctx.now);
  return withScheduledDue(r);
}

/**
 * Records an inspection's compliance and sets its next due point; without a
 * recurring interval, the schedule is archived.
 *
 * @throws {Rejection} In order: "Inspection not found."; "Inspection is
 *   archived."; "Service dates cannot be in the future."; as
 *   {@link inspectionCounters}; "Enter aircraft total landings at
 *   completion."; "Compliance readings must be between last compliance and
 *   current aircraft totals.".
 */
export function completeInspection(
  c: CommandOf<"inspection.complete">,
  ctx: Context,
): Inspection {
  const existing = ctx.existing;
  if (!existing || "kind" in existing)
    throw new Rejection("Inspection not found.");
  if (existing.archived) throw new Rejection("Inspection is archived.");
  checkDate(c.date, ctx.now);
  const counters = inspectionCounters(existing, ctx.aircraft!, ctx.records);
  if (
    (existing.intervalLandings || existing.dueLandings !== undefined) &&
    c.landings === undefined
  )
    throw new Rejection("Enter aircraft total landings at completion.");
  if (
    c.seconds > counters.seconds ||
    c.cycles > counters.cycles ||
    (c.landings !== undefined &&
      (c.landings > counters.landings ||
        c.landings < (existing.lastLandings ?? 0))) ||
    c.seconds < (existing.lastSeconds ?? 0) ||
    c.cycles < (existing.lastCycles ?? 0) ||
    c.date < (existing.lastDate ?? "")
  )
    throw new Rejection(
      "Compliance readings must be between last compliance and current aircraft totals.",
    );
  return renewInspection(existing, c);
}

function stampCalendarExemption(
  s: Snapshot,
  r: InspectionRecord,
  prior: Inspection | undefined,
  now: number,
) {
  // Older clients omit these fields: preserve the exemption on unrelated edits.
  r.calendarExempt ??= prior?.calendarExempt;
  r.calendarExemptReason ??= prior?.calendarExemptReason;
  if (r.calendarExempt && !r.calendarExemptReason?.trim())
    throw new Rejection("Enter a reason/reference for the calendar exemption.");
  const changed =
    (r.calendarExempt ?? false) !== (prior?.calendarExempt ?? false) ||
    (r.calendarExemptReason ?? "") !== (prior?.calendarExemptReason ?? "");
  r.calendarExemptChangedAt = changed ? now : prior?.calendarExemptChangedAt;
  r.calendarExemptChangedBy = changed
    ? s.user.id
    : prior?.calendarExemptChangedBy;
}

function assertInspectionLimits(
  r: Inspection,
  counters: ReturnType<typeof inspectionCounters>,
  now: number,
) {
  const limits = [
    r.dueSeconds,
    r.dueCycles,
    r.dueLandings,
    r.intervalLandings,
    r.dueDate,
    r.intervalSeconds,
    r.intervalCycles,
    r.intervalMonths,
  ];
  if (!r.archived && !limits.some((v) => v !== undefined))
    throw new Rejection("Enter at least one due limit or recurring interval.");
  if (r.lastDate) checkDate(r.lastDate, now);
  if (
    (r.lastSeconds !== undefined && r.lastSeconds > counters.seconds) ||
    (r.lastCycles !== undefined && r.lastCycles > counters.cycles) ||
    (r.lastLandings !== undefined && r.lastLandings > counters.landings)
  )
    throw new Rejection("Last compliance cannot exceed aircraft totals.");
  if (
    (r.intervalSeconds && r.lastSeconds === undefined) ||
    (r.intervalCycles && r.lastCycles === undefined) ||
    (r.intervalLandings && r.lastLandings === undefined) ||
    (r.intervalMonths && !r.lastDate)
  )
    throw new Rejection(
      "Each interval requires its last compliance reading or date.",
    );
}

function withScheduledDue(r: InspectionRecord): Inspection {
  return {
    ...r,
    dueSeconds: r.intervalSeconds
      ? r.lastSeconds! + r.intervalSeconds
      : r.dueSeconds,
    dueCycles: r.intervalCycles
      ? r.lastCycles! + r.intervalCycles
      : r.dueCycles,
    dueLandings: r.intervalLandings
      ? r.lastLandings! + r.intervalLandings
      : r.dueLandings,
    dueDate: r.intervalMonths
      ? endOfDueMonth(r.lastDate!, r.intervalMonths)
      : r.dueDate,
    version: r.version + 1,
  };
}

function renewInspection(
  i: Inspection,
  c: CommandOf<"inspection.complete">,
): Inspection {
  return {
    ...i,
    lastDate: c.date,
    lastSeconds: c.seconds,
    lastCycles: c.cycles,
    lastLandings: c.landings,
    dueLandings: i.intervalLandings
      ? c.landings! + i.intervalLandings
      : undefined,
    dueSeconds: i.intervalSeconds ? c.seconds + i.intervalSeconds : undefined,
    dueCycles: i.intervalCycles ? c.cycles + i.intervalCycles : undefined,
    dueDate: i.intervalMonths
      ? endOfDueMonth(c.date, i.intervalMonths)
      : undefined,
    archived:
      !i.intervalSeconds &&
      !i.intervalCycles &&
      !i.intervalLandings &&
      !i.intervalMonths,
    version: c.version + 1,
  };
}

function checkDate(d: string, now: number) {
  if (d > latestLocalDate(now))
    throw new Rejection("Service dates cannot be in the future.");
}
