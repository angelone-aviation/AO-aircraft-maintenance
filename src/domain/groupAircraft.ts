/**
 * Responsibility: Which aircraft and Flight Program a permission group
 *   covers: the save rules for both, and the aircraft summary label.
 * Layer: Domain. Pure functions; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), rejection.ts.
 */
import type { Aircraft, Group } from "./model";
import { Rejection } from "./rejection";

/**
 * Tells whether a group reaches every aircraft of its Flight Program through
 * an empty aircraft list. Owner groups never do: an empty list reaches none.
 *
 * @param g - The group.
 * @returns True for a non-owner group with no aircraft listed.
 */
export const listsAllAircraft = (g: Pick<Group, "owner" | "aircraftIds">) =>
  !g.owner && !g.aircraftIds.length;

/** The refusal for a group saved with no aircraft and no explicit choice. */
export const CHOOSE_GROUP_AIRCRAFT =
  "Choose the aircraft this group can access, or choose all aircraft in this program.";

/**
 * Checks a group's aircraft choice before it is saved. "All aircraft in this
 * program" is never implied (#34), so a group whose aircraft left the program,
 * or an owner group losing its flag, cannot silently open to the whole fleet.
 *
 * @param before - The stored group; undefined for a new one. An empty list
 *   that already reached every aircraft may stay.
 * @param next - The group as saved, with the form's `allAircraft` choice.
 *   Program administrator groups pass whatever their list.
 * @throws {Rejection} "Aircraft owner groups must name their aircraft.";
 *   "Choose all aircraft in this program or selected aircraft, not both.";
 *   {@link CHOOSE_GROUP_AIRCRAFT}.
 */
export function assertGroupAircraftChoice(
  before: Pick<Group, "owner" | "aircraftIds"> | undefined,
  next: Pick<Group, "owner" | "programAdmin" | "aircraftIds"> & {
    allAircraft?: boolean;
  },
) {
  if (next.allAircraft) {
    if (next.owner)
      throw new Rejection("Aircraft owner groups must name their aircraft.");
    if (next.aircraftIds.length)
      throw new Rejection(
        "Choose all aircraft in this program or selected aircraft, not both.",
      );
    return;
  }
  if (next.programAdmin || !listsAllAircraft(next)) return;
  if (next.allAircraft === false || !before || !listsAllAircraft(before))
    throw new Rejection(CHOOSE_GROUP_AIRCRAFT);
}

/**
 * Checks that a stored group keeps its Flight Program, which is fixed once
 * the group is saved.
 *
 * @param before - The stored group; undefined for a new one.
 * @param next - The group as it will be saved.
 * @throws {Rejection} "A permission group cannot be moved to another Flight
 *   Program." for any other program, also for a group stored without one.
 */
export function assertGroupProgramFixed(
  before: Pick<Group, "programUuid"> | undefined,
  next: Pick<Group, "programUuid">,
) {
  if (before && before.programUuid !== next.programUuid)
    throw new Rejection(
      "A permission group cannot be moved to another Flight Program.",
    );
}

/**
 * {@link assertGroupProgramFixed}, except that a system administrator may
 * give an unscoped (pre-program) group its first program (#45). Only the
 * offline demo still allows that; the server retired it (T21), since no
 * unscoped group exists. Remove this with the demo's copy.
 *
 * @param before - The stored group; undefined for a new one.
 * @param next - The group as it will be saved.
 * @param systemAdmin - Whether the user is a system administrator.
 * @returns True for that first assignment, so the caller can audit it.
 * @throws {Rejection} "A permission group cannot be moved to another Flight
 *   Program." for a group that has one; "Only a system administrator can
 *   assign an unscoped permission group to a Flight Program."
 */
export function assertGroupProgramChange(
  before: Pick<Group, "programUuid"> | undefined,
  next: Pick<Group, "programUuid">,
  systemAdmin: boolean,
) {
  if (!before || before.programUuid === next.programUuid) return false;
  if (before.programUuid) assertGroupProgramFixed(before, next);
  if (!systemAdmin)
    throw new Rejection(
      "Only a system administrator can assign an unscoped permission group to a Flight Program.",
    );
  return !!next.programUuid;
}

/**
 * Summarizes the aircraft a group covers, for Administration.
 *
 * @param g - The group.
 * @param aircraft - The group's program fleet.
 * @returns "All program aircraft", "No aircraft assigned" (an owner group with
 *   none), "N aircraft", or "No aircraft in this program". Ids of aircraft
 *   that left the program grant nothing and are not counted.
 */
export function groupAircraftLabel(
  g: Group,
  aircraft: Pick<Aircraft, "uuid" | "programUuid">[],
) {
  if (!g.aircraftIds.length)
    return g.owner ? "No aircraft assigned" : "All program aircraft";
  const count = g.aircraftIds.filter((id) =>
    aircraft.some((a) => a.uuid === id && a.programUuid === g.programUuid),
  ).length;
  return count ? `${count} aircraft` : "No aircraft in this program";
}
