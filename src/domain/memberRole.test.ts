/**
 * Responsibility: Pins the role label the sidebar and Settings share.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/memberRole.ts, src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Group, Snapshot } from "./model";
import { memberRoleLabel } from "./memberRole";

const PROGRAM = "demo-program";

function withGroup(group: Partial<Group>): Snapshot {
  const s = demoSnapshot();
  const g: Group = {
    id: "g",
    name: "Group",
    programUuid: PROGRAM,
    aircraftIds: [],
    permissions: ["read"],
    ...group,
  };
  s.groups = [g];
  s.user = { ...s.user, isAdmin: false, groupIds: ["g"] };
  s.activeProgramUuid = PROGRAM;
  return s;
}

it("names the member in the glossary's terms, the first that applies", () => {
  const admin = demoSnapshot();
  admin.user = { ...admin.user, isAdmin: true };
  expect(memberRoleLabel(admin)).toBe("System administrator");
  expect(memberRoleLabel(withGroup({ programAdmin: true }))).toBe(
    "Flight Program administrator",
  );
  expect(memberRoleLabel(withGroup({ owner: true }))).toBe("Aircraft owner");
  expect(memberRoleLabel(withGroup({ board: true }))).toBe("Board member");
  expect(
    memberRoleLabel(
      withGroup({ permissions: ["read", "flight", "maintenance"] }),
    ),
  ).toBe("Mechanic");
  expect(memberRoleLabel(withGroup({ permissions: ["read", "flight"] }))).toBe(
    "Pilot",
  );
  expect(memberRoleLabel(withGroup({ permissions: ["read"] }))).toBe("Member");
});
