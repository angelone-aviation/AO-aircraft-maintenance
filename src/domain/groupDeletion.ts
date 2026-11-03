import type { Snapshot } from "./model";
import { activeProgram, programPermission } from "./programs";
export function groupDeletionPlan(s: Snapshot, id: string) {
  const group = s.groups.find((g) => g.id === id);
  if (!group) throw Error("Permission group not found.");
  if (
    !s.user.active ||
    (!s.user.isAdmin &&
      (group.programUuid !== activeProgram(s) ||
        !programPermission(s, "admin")))
  )
    throw Error("Flight Program administrator permission required.");
  const users = s.members
    .filter((m) => m.groupIds.includes(id))
    .map((m) => ({
      id: m.id,
      name: m.name,
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
export type GroupDeletionPlan = ReturnType<typeof groupDeletionPlan>;
export function deletePermissionGroup(
  s: Snapshot,
  id: string,
  expected: string,
) {
  const plan = groupDeletionPlan(s, id);
  if (plan.expected !== expected)
    throw Error(
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
