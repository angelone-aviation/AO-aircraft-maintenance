/**
 * Responsibility: Pins the group deletion review (members, lost access,
 *   fingerprint), its refusals, and the delete applier.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/groupDeletion.ts, ./rejection, src/data/demo.ts.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { deletePermissionGroup, groupDeletionPlan } from "./groupDeletion";
import { Rejection } from "./rejection";

function withObservers() {
  const s = demoSnapshot();
  s.groups.push({
    id: "observers",
    name: "Observers",
    programUuid: "demo-program",
    aircraftIds: [],
    permissions: ["read"],
  });
  s.members[1].groupIds.push("observers");
  s.members[0].groupIds = ["demo-pilots"];
  return s;
}

it("lists members and who loses all program access", () => {
  const s = withObservers();
  const plan = groupDeletionPlan(s, "demo-pilots");
  expect(plan.name).toBe("Pilots");
  expect(plan.users).toEqual([
    { id: "demo-admin", name: "Alex Morgan", losesProgramAccess: false },
    { id: "demo-pilot", name: "Jordan Lee", losesProgramAccess: false },
  ]);
  s.members[1].groupIds = ["demo-pilots"];
  expect(groupDeletionPlan(s, "demo-pilots").users[1]).toMatchObject({
    losesProgramAccess: true,
  });
});

it("refuses a missing group or a user who does not administer it", () => {
  const s = demoSnapshot();
  const missing = () => groupDeletionPlan(s, "nope");
  expect(missing).toThrow(Rejection);
  expect(missing).toThrow("Permission group not found.");
  s.user = { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] };
  const pilot = () => groupDeletionPlan(s, "demo-pilots");
  expect(pilot).toThrow(Rejection);
  expect(pilot).toThrow("Flight Program administrator permission required.");
  s.user = { ...s.user, isAdmin: true, active: false };
  expect(pilot).toThrow("Flight Program administrator permission required.");
});

it("deletes only the reviewed group and keeps member accounts", () => {
  const s = withObservers();
  const { expected } = groupDeletionPlan(s, "demo-pilots");
  s.user.groupIds = ["demo-pilots"];
  const plan = deletePermissionGroup(s, "demo-pilots", expected);
  expect(plan.expected).toBe(expected);
  expect(s.groups.map((g) => g.id)).toEqual(["observers"]);
  expect(s.members.map((m) => m.groupIds)).toEqual([[], ["observers"]]);
  expect(s.user.groupIds).toEqual([]);
});

it("refuses a delete when the group or its members changed", () => {
  const s = withObservers();
  const { expected } = groupDeletionPlan(s, "demo-pilots");
  s.members[1].groupIds = ["demo-pilots"];
  const stale = () => deletePermissionGroup(s, "demo-pilots", expected);
  expect(stale).toThrow(Rejection);
  expect(stale).toThrow(
    "This group or its members changed. Close this dialog and review deletion again.",
  );
  expect(s.groups).toHaveLength(2);
});
