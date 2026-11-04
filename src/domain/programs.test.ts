/**
 * Responsibility: Pins Flight Program membership, permissions and what the
 *   scoped snapshot strips.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/programs.ts, src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { ManagedRecord } from "./management";
import type { AuditEntry, Group, Member } from "./model";
import { Rejection } from "./rejection";
import {
  activeProgram,
  assertProgramSelectable,
  auditVisible,
  groupCoversAircraft,
  ownsActive,
  programIds,
  programPermission,
  recordProgram,
  scopedSnapshot,
} from "./programs";

const HOME = "demo-program";
const group = (id: string, patch: Partial<Group> = {}): Group => ({
  id,
  name: id,
  programUuid: HOME,
  aircraftIds: [],
  permissions: ["read"],
  ...patch,
});
// A non-administrator in every given group, working in the home program.
const snapshotAs = (groups: Group[], user: Partial<Member> = {}) => {
  const s = demoSnapshot();
  s.programs = [...s.programs!, { ...s.programs![0], uuid: "other" }];
  s.groups = groups;
  s.user = {
    ...s.user,
    isAdmin: false,
    groupIds: groups.map((g) => g.id),
    ...user,
  };
  return s;
};
const asRecord = (r: object) => r as ManagedRecord;
const audit = (patch: Partial<AuditEntry>) =>
  ({
    uuid: "a",
    action: "flight.save",
    entityUuid: "x",
    ...patch,
  }) as AuditEntry;

describe("groups and programs", () => {
  it("lets an empty aircraft list cover every aircraft, except for owners", () => {
    expect(groupCoversAircraft(group("g"), "any")).toBe(true);
    expect(groupCoversAircraft(group("g", { owner: true }), "any")).toBe(false);
    expect(groupCoversAircraft(group("g", { aircraftIds: ["a"] }), "b")).toBe(
      false,
    );
    expect(
      groupCoversAircraft(
        group("g", { aircraftIds: ["a"], programAdmin: true }),
        "b",
      ),
    ).toBe(true);
  });
  it("lists each readable program once, in group order", () => {
    const s = snapshotAs([
      group("a", { programUuid: "other" }),
      group("b"),
      group("c", { programUuid: "other" }),
      group("d", { programUuid: "third", permissions: ["flight"] }),
      group("e", { programUuid: undefined }),
    ]);
    expect(programIds(s.user, s.groups)).toEqual(["other", HOME]);
  });
  it("keeps the chosen program only when the user may read it", () => {
    const groups = [group("a", { programUuid: "other" }), group("b")];
    expect(activeProgram(snapshotAs(groups))).toBe(HOME);
    expect(
      activeProgram(snapshotAs(groups, { activeProgramUuid: "third" })),
    ).toBe("other");
    expect(activeProgram(snapshotAs(groups, { activeProgramUuid: "" }))).toBe(
      "other",
    );
    // A system administrator may pick any program, or none.
    const admin = (activeProgramUuid: string) =>
      activeProgram(snapshotAs([], { isAdmin: true, activeProgramUuid }));
    expect(admin("other")).toBe("other");
    expect(admin("")).toBeUndefined();
  });
  it("selects a program the user may read, and unassigned records only for a system administrator", () => {
    const member = snapshotAs([
      group("a"),
      group("b", { programUuid: "other", permissions: ["flight"] }),
    ]);
    const admin = snapshotAs([], { isAdmin: true });
    const select = (s: typeof member, programUuid: string) => () =>
      assertProgramSelectable(s, programUuid);
    expect(select(member, HOME)).not.toThrow();
    expect(select(admin, "other")).not.toThrow();
    expect(select(admin, "")).not.toThrow();
    for (const [s, programUuid] of [
      [member, "other"],
      [member, ""],
      [admin, "missing"],
    ] as const) {
      expect(select(s, programUuid)).toThrow(Rejection);
      expect(select(s, programUuid)).toThrow("Flight Program access denied.");
    }
  });
});

describe("programPermission and ownsActive", () => {
  it("counts a group only with read; a program administrator has everything", () => {
    const pilot = snapshotAs([group("p", { permissions: ["read", "flight"] })]);
    expect(programPermission(pilot, "flight")).toBe(true);
    expect(programPermission(pilot, "maintenance")).toBe(false);
    expect(programPermission(pilot, "admin")).toBe(false);
    expect(programPermission(pilot, "flight", "other")).toBe(false);
    const unread = snapshotAs([group("u", { permissions: ["flight"] })]);
    expect(programPermission(unread, "flight", HOME)).toBe(false);
    const manager = snapshotAs([group("m", { programAdmin: true })]);
    expect(programPermission(manager, "maintenance")).toBe(true);
    expect(programPermission(manager, "admin")).toBe(true);
  });
  it("refuses an inactive user and trusts an active system administrator", () => {
    const admin = snapshotAs([], { isAdmin: true, activeProgramUuid: "" });
    expect(programPermission(admin, "admin")).toBe(true);
    expect(
      programPermission(
        { ...admin, user: { ...admin.user, active: false } },
        "read",
      ),
    ).toBe(false);
    expect(programPermission(snapshotAs([]), "read")).toBe(false);
  });
  it("scopes records to the active program, untagged ones to a system administrator in none", () => {
    const s = snapshotAs([group("g")]);
    expect(ownsActive(s, HOME)).toBe(true);
    expect(ownsActive(s, "other")).toBe(false);
    expect(ownsActive(s, undefined)).toBe(false);
    const admin = snapshotAs([], { isAdmin: true, activeProgramUuid: "" });
    expect(ownsActive(admin, undefined)).toBe(true);
  });
  it("finds a record's program through its location, component or aircraft", () => {
    const s = snapshotAs([group("g")]);
    s.management = [
      asRecord({ kind: "location", uuid: "l", programUuid: "other" }),
      asRecord({ kind: "component", uuid: "c", aircraftUuid: "demo-206" }),
    ];
    const stock = asRecord({ kind: "stock", uuid: "s", locationUuid: "l" });
    expect(recordProgram(s, stock)).toBe("other");
    expect(
      recordProgram(
        s,
        asRecord({
          kind: "componentRequirement",
          uuid: "q",
          componentUuid: "c",
        }),
      ),
    ).toBe(HOME);
    expect(recordProgram(s, { ...stock, programUuid: "own" })).toBe("own");
    expect(
      recordProgram(s, asRecord({ kind: "vendor", uuid: "v" })),
    ).toBeUndefined();
  });
});

describe("scopedSnapshot", () => {
  it("marks the scope without changing the full snapshot", () => {
    const s = snapshotAs([group("g")]);
    const before = structuredClone(s);
    const scoped = scopedSnapshot(s);
    expect(s).toEqual(before);
    expect(scoped).toMatchObject({
      activeProgramUuid: HOME,
      programScopeVersion: 1,
    });
    expect(scoped.programs?.map((p) => [p.uuid, p.email])).toEqual([
      [HOME, "operations@example.test"],
    ]);
  });
  it("keeps only the aircraft the user's groups reach", () => {
    const s = snapshotAs([group("g", { aircraftIds: ["demo-208"] })]);
    expect(scopedSnapshot(s).aircraft.map((a) => a.uuid)).toEqual(["demo-208"]);
    expect(
      scopedSnapshot(s).inspections.every((i) => i.aircraftUuid === "demo-208"),
    ).toBe(true);
  });
  it("blanks another program's contact details for anyone but a system administrator", () => {
    const s = snapshotAs([group("g"), group("o", { programUuid: "other" })]);
    expect(scopedSnapshot(s).programs?.[1]).toMatchObject({
      uuid: "other",
      address: "",
      email: "",
      contactName: "",
      website: "",
    });
  });
  it("reduces other members, showing email and groups to program administrators", () => {
    const groups = [group("g"), group("m", { programAdmin: true })];
    const other: Member = {
      id: "other",
      name: "Other",
      email: "other@example.test",
      active: true,
      isAdmin: true,
      groupIds: ["g", "elsewhere"],
      licenseNumber: "A&P 1",
    };
    const reader = snapshotAs([groups[0]]);
    reader.members = [reader.user, other];
    expect(scopedSnapshot(reader).members[1]).toStrictEqual({
      id: "other",
      name: "Other",
      email: "",
      availableAsPilot: true,
      active: true,
      isAdmin: false,
      groupIds: [],
    });
    const manager = snapshotAs(groups);
    manager.members = [manager.user, other];
    expect(scopedSnapshot(manager).members[1]).toMatchObject({
      email: "other@example.test",
      groupIds: ["g"],
    });
  });
  it("hides inventory change-log rows from all but program administrators", () => {
    const rows = [
      audit({ action: "stock.save", aircraftUuid: "demo-206" }),
      audit({ action: "flight.save", aircraftUuid: "demo-206" }),
    ];
    const reader = snapshotAs([group("g")]);
    reader.audit = rows;
    expect(scopedSnapshot(reader).audit).toEqual([rows[1]]);
    expect(rows.map(auditVisible(reader))).toEqual([false, true]);
    const manager = snapshotAs([group("m", { programAdmin: true })]);
    manager.audit = rows;
    expect(scopedSnapshot(manager).audit).toEqual(rows);
  });
});
