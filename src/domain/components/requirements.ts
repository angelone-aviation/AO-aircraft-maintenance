/**
 * Responsibility: Saving a component's service requirements, and keeping
 *   them right when the component moves or is repaired or overhauled.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: ../model, ../rejection, ./records, ./usage, ./calendar.
 */
import { latestLocalDate, type Aircraft, type Snapshot } from "../model";
import { Rejection } from "../rejection";
import { assertPastDate, calendarDue } from "./calendar";
import {
  requirementSchema,
  type Component,
  type ComponentRequirement,
} from "./records";
import {
  componentTotals,
  tracking,
  usageOnBasis,
  type UsageBefore,
} from "./usage";

/**
 * Checks a requirement against its component and derives its due values.
 *
 * @returns The requirement at the next version: each due value from its
 *   interval (absolute, or from the last compliance), and landing limits
 *   referenced to the component's aircraft.
 * @throws {Rejection} "Component not found."; "Component location changed.
 *   Refresh and try again."; or a refused limit, baseline or last compliance.
 *   Also as {@link componentTotals} and {@link calendarDue}.
 * @throws {z.ZodError} When the derived requirement is invalid.
 */
export function saveRequirement(
  s: Snapshot,
  r: ComponentRequirement,
  now: number,
) {
  const c = (s.management ?? []).find(
    (c): c is Component => c.kind === "component" && c.uuid === r.componentUuid,
  );
  if (!c) throw new Rejection("Component not found.");
  if (r.aircraftUuid !== c.aircraftUuid)
    throw new Rejection("Component location changed. Refresh and try again.");
  const aircraft = s.aircraft.find((a) => a.uuid === c.aircraftUuid);
  const t = componentTotals(c, aircraft, latestLocalDate(now));
  const basis = usageOnBasis(r.timeBasis, t);
  assertServiceLimits(r, c, basis, aircraft);
  assertPastDate(r.lastDate, now);
  assertLastWithinUsage(r, basis, t.cyclesSinceNew, aircraft);
  assertLastForRelativeLimits(r);
  return requirementSchema.parse({
    ...r,
    version: r.version + 1,
    ...computeDueLimits(r, c),
  });
}

/**
 * A requirement following its component to another aircraft. Landing counts
 * belong to the aircraft they were recorded on, so the reference stays there
 * (also stamped on older records without one) and status asks for a new
 * landing baseline.
 *
 * @returns The requirement at the next version, on `aircraftUuid`.
 */
export function moveRequirement(
  r: ComponentRequirement,
  aircraftUuid: string,
): ComponentRequirement {
  return {
    ...r,
    aircraftUuid,
    version: r.version + 1,
    landingReferenceAircraftUuid:
      r.dueLandings === undefined
        ? r.landingReferenceAircraftUuid
        : (r.landingReferenceAircraftUuid ?? r.aircraftUuid),
  };
}

/**
 * Requirements updated by a repair or overhaul of `next` (the component after
 * its reset). Overhaul requirements renew only for an actual overhaul;
 * lifetime limits never renew. Other TSO/TSR intervals keep their remaining
 * time on the reset counter.
 *
 * @param before - The component's usage just before the work.
 * @returns Only the changed requirements, each at its next version.
 * @throws {Rejection} "A component requirement has later compliance. Review
 *   its tracking before backdating this repair or overhaul."; as
 *   {@link saveRequirement} for a renewal.
 */
export function rebaseServicedRequirements(
  s: Snapshot,
  next: Component,
  before: UsageBefore,
  work: { overhaul: boolean; repair: boolean; date: string; landings?: number },
  now: number,
): ComponentRequirement[] {
  const view = {
    ...s,
    management: (s.management ?? []).map((r) =>
      r.uuid === next.uuid ? next : r,
    ),
  };
  return componentRequirements(view, next.uuid).flatMap((r) => {
    const reset =
      (r.timeBasis === "TSO" && work.overhaul) ||
      (r.timeBasis === "TSR" && work.repair);
    const renew = work.overhaul && r.requirementType === "Overhaul Requirement";
    if ((reset || renew) && r.lastDate && r.lastDate > work.date)
      throw new Rejection(
        "A component requirement has later compliance. Review its tracking before backdating this repair or overhaul.",
      );
    if (renew)
      return [saveRequirement(view, renewal(r, next, before, work), now)];
    const prior =
      r.timeBasis === "TSO" ? before.timeSinceOverhaul : before.timeSinceRepair;
    if (!reset || !r.intervalSeconds || prior === null) return [];
    return [carryReset(r, prior, r.intervalSeconds)];
  });
}

/**
 * The service requirements of one component.
 *
 * @returns Them in snapshot order.
 */
export function componentRequirements(s: Snapshot, id: string) {
  return (s.management ?? []).filter(
    (r): r is ComponentRequirement =>
      r.kind === "componentRequirement" && r.componentUuid === id,
  );
}

function assertServiceLimits(
  r: ComponentRequirement,
  c: Component,
  basis: number | null,
  aircraft: Aircraft | undefined,
) {
  if (
    !r.intervalSeconds &&
    !r.intervalCycles &&
    !r.intervalLandings &&
    !r.calendarIntervalValue
  )
    throw new Rejection("Set at least one service limit.");
  const track = tracking(c);
  if (
    (r.intervalSeconds && !track.time) ||
    (r.intervalCycles && !track.cycles) ||
    (r.calendarIntervalValue && !track.calendar)
  )
    throw new Rejection(
      "Enable the corresponding tracking dimension on the component first.",
    );
  if (r.intervalSeconds && basis === null)
    throw new Rejection(
      "Set a verified " + r.timeBasis + " baseline before adding a time limit.",
    );
  if (r.intervalLandings && (!aircraft || !c.installed))
    throw new Rejection(
      "Aircraft landing limits require an installed component.",
    );
  if (
    r.intervalLandings &&
    r.landingReferenceAircraftUuid &&
    r.landingReferenceAircraftUuid !== c.aircraftUuid
  )
    throw new Rejection(
      "Review the landing baseline for the new aircraft before saving this service requirement.",
    );
}

function assertLastWithinUsage(
  r: ComponentRequirement,
  basis: number | null,
  cyclesSinceNew: number,
  aircraft: Aircraft | undefined,
) {
  if (
    (r.lastSeconds !== undefined &&
      (basis === null || r.lastSeconds > basis)) ||
    (r.lastCycles !== undefined && r.lastCycles > cyclesSinceNew) ||
    (r.lastLandings !== undefined &&
      (!aircraft || r.lastLandings > aircraft.landings))
  )
    throw new Rejection("Last compliance exceeds current component usage.");
}

function assertLastForRelativeLimits(r: ComponentRequirement) {
  if (
    (r.intervalSeconds &&
      r.timeLimitMode === "FROM_LAST_COMPLIED" &&
      r.lastSeconds === undefined) ||
    (r.intervalCycles &&
      r.cycleLimitMode === "FROM_LAST_COMPLIED" &&
      r.lastCycles === undefined) ||
    (r.intervalLandings &&
      r.landingLimitMode !== "ABSOLUTE" &&
      r.lastLandings === undefined) ||
    (r.calendarIntervalValue && !r.lastDate)
  )
    throw new Rejection("Enter last compliance for each relative interval.");
}

// An absolute time limit is a reading on the basis counter, less what earlier
// resets of that counter carried (timeResetSeconds); a relative limit counts
// from the last compliance. Landing limits stay with the current aircraft.
function computeDueLimits(r: ComponentRequirement, c: Component) {
  return {
    dueSeconds:
      r.intervalSeconds === undefined
        ? undefined
        : Math.max(
            0,
            r.intervalSeconds +
              (r.timeLimitMode === "ABSOLUTE"
                ? -(r.timeResetSeconds ?? 0)
                : r.lastSeconds!),
          ),
    dueLandings:
      r.intervalLandings === undefined
        ? undefined
        : r.intervalLandings +
          (r.landingLimitMode === "ABSOLUTE" ? 0 : r.lastLandings!),
    landingReferenceAircraftUuid: r.intervalLandings
      ? c.aircraftUuid
      : undefined,
    dueCycles:
      r.intervalCycles === undefined
        ? undefined
        : r.intervalCycles +
          (r.cycleLimitMode === "ABSOLUTE" ? 0 : r.lastCycles!),
    dueDate: r.calendarIntervalValue
      ? calendarDue(
          r.lastDate!,
          r.calendarIntervalValue,
          r.calendarIntervalUnit,
        )
      : undefined,
  };
}

// An overhaul renews its requirement as complied with on the work date, at
// the usage the work left: since-new from before it, TSO/TSR after it.
function renewal(
  r: ComponentRequirement,
  next: Component,
  before: UsageBefore,
  work: { date: string; landings?: number },
): ComponentRequirement {
  const basis = usageOnBasis(r.timeBasis, {
    timeSinceNew: before.timeSinceNew,
    timeSinceOverhaul: next.timeSinceOverhaul,
    timeSinceRepair: next.timeSinceRepair,
  });
  return {
    ...r,
    timeResetSeconds: 0,
    lastDate: work.date,
    lastSeconds: basis ?? undefined,
    lastCycles: before.cyclesSinceNew,
    lastLandings: r.intervalLandings ? work.landings : undefined,
  };
}

// The counter restarts at zero, so the interval keeps its remaining time by
// moving its compliance and due values down by the usage `prior` removed.
function carryReset(
  r: ComponentRequirement,
  prior: number,
  intervalSeconds: number,
): ComponentRequirement {
  return {
    ...r,
    version: r.version + 1,
    timeResetSeconds: (r.timeResetSeconds ?? 0) + prior,
    lastSeconds:
      r.lastSeconds === undefined ? undefined : r.lastSeconds - prior,
    // ponytail: dueSeconds is a non-negative count, so an overdue interval
    // resets to "Due now" and the overdue amount is not carried.
    dueSeconds: Math.max(0, (r.dueSeconds ?? intervalSeconds) - prior),
  };
}
