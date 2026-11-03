import type { Aircraft, Group } from "./model";

// Shared by the server (convex/admin.ts), the demo backend and the group form.

/** A group reaches every aircraft of its Flight Program through an empty
 * aircraft list, except owner groups, which reach none (groupCoversAircraft). */
export const listsAllAircraft = (g: Pick<Group, "owner" | "aircraftIds">) =>
  !g.owner && !g.aircraftIds.length;

export const CHOOSE_GROUP_AIRCRAFT =
  "Choose the aircraft this group can access, or choose all aircraft in this program.";

/**
 * "All aircraft in this program" is never implied (#34). An ordinary group
 * saved with an empty aircraft list needs `allAircraft: true`, unless it
 * already reached every aircraft that way. Otherwise a group whose aircraft
 * left the program, or an owner group losing its owner flag, would silently
 * open to the whole fleet. Flight Program administrator groups cover every
 * aircraft regardless of their list.
 */
export function assertGroupAircraftChoice(
  before: Pick<Group, "owner" | "aircraftIds"> | undefined,
  next: Pick<Group, "owner" | "programAdmin" | "aircraftIds"> & {
    allAircraft?: boolean;
  },
) {
  if (next.allAircraft) {
    if (next.owner)
      throw new Error("Aircraft owner groups must name their aircraft.");
    if (next.aircraftIds.length)
      throw new Error(
        "Choose all aircraft in this program or selected aircraft, not both.",
      );
    return;
  }
  if (next.programAdmin || !listsAllAircraft(next)) return;
  if (next.allAircraft === false || !before || !listsAllAircraft(before))
    throw new Error(CHOOSE_GROUP_AIRCRAFT);
}

/**
 * A group's Flight Program is fixed once set. The one change allowed is a
 * system administrator giving an unscoped (pre-program) group its first
 * program (#45). Returns true for that assignment, which is audited.
 */
export function assertGroupProgramChange(
  before: Pick<Group, "programUuid"> | undefined,
  next: Pick<Group, "programUuid">,
  systemAdmin: boolean,
) {
  if (!before || before.programUuid === next.programUuid) return false;
  if (before.programUuid)
    throw new Error(
      "A permission group cannot be moved to another Flight Program.",
    );
  if (!systemAdmin)
    throw new Error(
      "Only a system administrator can assign an unscoped permission group to a Flight Program.",
    );
  return !!next.programUuid;
}

/** Aircraft part of a group's summary in Administration. `aircraft` is the
 * group's program fleet; ids of aircraft that left the program grant nothing
 * and are not counted. */
export function groupAircraftLabel(
  g: Group,
  aircraft: Pick<Aircraft, "uuid" | "programUuid">[],
) {
  if (!g.aircraftIds.length)
    return g.owner ? "No aircraft assigned" : "All program aircraft";
  // An unscoped group grants nothing yet; its ids are judged on assignment.
  const count = g.programUuid
    ? g.aircraftIds.filter((id) =>
        aircraft.some((a) => a.uuid === id && a.programUuid === g.programUuid),
      ).length
    : g.aircraftIds.length;
  return count ? `${count} aircraft` : "No aircraft in this program";
}
