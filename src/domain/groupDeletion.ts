/**
 * Responsibility: Reviewing and deleting a permission group: who loses
 *   program access, and the check that nothing changed since the review.
 * Layer: Domain. Pure review function and a snapshot applier; no I/O.
 * Dependencies: ./model (types), ./programs, ./rejection.
 */
import type { Snapshot } from "./model";
import { activeProgram, programPermission } from "./programs";
import { Rejection } from "./rejection";

/**
 * Reviews deleting a permission group: its members, and which of them lose
 * all access to its program because no other group there grants read.
 *
 * @param s - The snapshot; the user must administer the group's program.
 * @param id - The group to delete.
 * @returns The group name, its members with `losesProgramAccess`, and
 *   `expected`, a fingerprint of the group and members the delete must match.
 * @throws {Rejection} "Permission group not found." or "Flight Program
 *   administrator permission required."
 */
export function groupDeletionPlan(s: Snapshot, id: string) {
  const group = s.groups.find((g) => g.id === id);
  if (!group) throw new Rejection("Permission group not found.");
  if (
    !s.user.active ||
    (!s.user.isAdmin &&
      (group.programUuid !== activeProgram(s) ||
        !programPermission(s, "admin")))
  )
    throw new Rejection("Flight Program administrator permission required.");
  const users = s.members
    .filter((m) => m.groupIds.includes(id))
    .map((m) => ({
      id: m.id,
      name: m.name,
      // System administrators keep access to every program.
      losesProgramAccess:
        !m.isAdmin &&
        !s.groups.some(
          (g) =>
            g.id !== id &&
            g.programUuid === group.programUuid &&
            m.groupIds.includes(g.id) &&
            g.permissions.includes("read"),
        ),
    }));
  return {
    name: group.name,
    users,
    expected: JSON.stringify([
      group,
      [...users].sort((a, b) => a.id.localeCompare(b.id)),
    ]),
  };
}

/** The review shown before a permission group is deleted. */
export type GroupDeletionPlan = ReturnType<typeof groupDeletionPlan>;

/**
 * Deletes a reviewed permission group from the snapshot and from every
 * member's and the user's group list; accounts and other groups stay.
 *
 * @param s - The working snapshot, changed in place.
 * @param id - The group to delete.
 * @param expected - The reviewed plan's `expected` fingerprint.
 * @returns The plan that was carried out.
 * @throws {Rejection} As {@link groupDeletionPlan}, or "This group or its
 *   members changed. Close this dialog and review deletion again."
 */
export function deletePermissionGroup(
  s: Snapshot,
  id: string,
  expected: string,
) {
  const plan = groupDeletionPlan(s, id);
  if (plan.expected !== expected)
    throw new Rejection(
      "This group or its members changed. Close this dialog and review deletion again.",
    );
  s.groups = s.groups.filter((g) => g.id !== id);
  s.members = s.members.map((m) => ({
    ...m,
    groupIds: m.groupIds.filter((g) => g !== id),
  }));
  s.user = { ...s.user, groupIds: s.user.groupIds.filter((g) => g !== id) };
  return plan;
}
