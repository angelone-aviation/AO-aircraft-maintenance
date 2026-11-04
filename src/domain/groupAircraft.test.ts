/**
 * Responsibility: Pins the aircraft and Flight Program rules for permission
 *   groups, and the aircraft label, including after a transfer.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/groupAircraft.ts, model.ts, programs.ts,
 *   programTransfers.ts, rejection.ts, src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { can, type Group, type Snapshot } from "./model";
import { scopedSnapshot } from "./programs";
import { transferProgram } from "./programTransfers";
import {
  CHOOSE_GROUP_AIRCRAFT,
  assertGroupAircraftChoice,
  assertGroupProgramChange,
  groupAircraftLabel,
  listsAllAircraft,
} from "./groupAircraft";
import { Rejection } from "./rejection";

// N206 crew is limited to N206MA, then N206MA moves to another program.
function restrictedGroupAfterTransfer() {
  const s = demoSnapshot();
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: "second", name: "Second program" },
  ];
  s.groups.push({
    id: "n206-crew",
    name: "N206 crew",
    programUuid: "demo-program",
    aircraftIds: ["demo-206"],
    permissions: ["read", "flight"],
  });
  s.members = s.members.map((m) =>
    m.id === "demo-pilot" ? { ...m, groupIds: ["n206-crew"] } : m,
  );
  transferProgram(s, {
    kind: "aircraft",
    uuid: "demo-206",
    destination: "second",
    reason: "Aircraft moved to the second program.",
  });
  const asPilot = (activeProgramUuid: string): Snapshot => ({
    ...s,
    user: {
      ...s.members.find((m) => m.id === "demo-pilot")!,
      activeProgramUuid,
    },
  });
  return { s, group: s.groups.find((g) => g.id === "n206-crew")!, asPilot };
}

describe("a group whose restricted aircraft left the program (#34)", () => {
  it("keeps its list and grants no aircraft in either program", () => {
    const { s, group, asPilot } = restrictedGroupAfterTransfer();
    // Transfers leave groups untouched; the stale id must not empty the list.
    expect(group.aircraftIds).toEqual(["demo-206"]);
    const pilot = asPilot("demo-program");
    expect(scopedSnapshot(pilot).aircraft).toEqual([]);
    for (const a of s.aircraft)
      for (const p of ["read", "flight"] as const)
        expect(can(pilot, a.uuid, p)).toBe(false);
    // Membership is per program: nothing is granted in the destination either.
    expect(scopedSnapshot(asPilot("second")).aircraft).toEqual([]);
  });
  it("is labelled as having no aircraft in this program, not as one aircraft", () => {
    const { s, group } = restrictedGroupAfterTransfer();
    const program = s.aircraft.filter((a) => a.programUuid === "demo-program");
    expect(groupAircraftLabel(group, program)).toBe(
      "No aircraft in this program",
    );
    expect(
      groupAircraftLabel(
        { ...group, aircraftIds: ["demo-206", "demo-208"] },
        program,
      ),
    ).toBe("1 aircraft");
    expect(groupAircraftLabel({ ...group, aircraftIds: [] }, program)).toBe(
      "All program aircraft",
    );
    expect(
      groupAircraftLabel({ ...group, owner: true, aircraftIds: [] }, program),
    ).toBe("No aircraft assigned");
    // An unscoped (legacy) group cannot be judged against a program's fleet.
    expect(
      groupAircraftLabel({ ...group, programUuid: undefined }, program),
    ).toBe("1 aircraft");
  });
});

describe("assertGroupAircraftChoice (#34)", () => {
  const restricted = { aircraftIds: ["demo-206"] };
  const everyAircraft = { aircraftIds: [] };
  const owners = { owner: true, aircraftIds: [] };
  const choose = /all aircraft in this program/;
  it("refuses to widen a restricted group to every program aircraft unless that is chosen explicitly", () => {
    expect(() =>
      assertGroupAircraftChoice(restricted, { aircraftIds: [] }),
    ).toThrow(choose);
    expect(() =>
      assertGroupAircraftChoice(restricted, {
        aircraftIds: [],
        allAircraft: false,
      }),
    ).toThrow(choose);
    expect(() =>
      assertGroupAircraftChoice(restricted, {
        aircraftIds: [],
        allAircraft: true,
      }),
    ).not.toThrow();
    // An owner group with no aircraft reaches none; dropping the owner flag
    // must not silently open every aircraft.
    expect(() =>
      assertGroupAircraftChoice(owners, { aircraftIds: [] }),
    ).toThrow(choose);
  });
  it("requires the explicit choice for a new group with no aircraft", () => {
    expect(() =>
      assertGroupAircraftChoice(undefined, { aircraftIds: [] }),
    ).toThrow(choose);
    expect(() =>
      assertGroupAircraftChoice(undefined, {
        aircraftIds: [],
        allAircraft: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertGroupAircraftChoice(undefined, { aircraftIds: ["demo-206"] }),
    ).not.toThrow();
  });
  it("keeps saving groups that already reach every aircraft, administrators and owners", () => {
    expect(() =>
      assertGroupAircraftChoice(everyAircraft, { aircraftIds: [] }),
    ).not.toThrow();
    expect(() =>
      assertGroupAircraftChoice(restricted, {
        programAdmin: true,
        aircraftIds: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertGroupAircraftChoice(undefined, { owner: true, aircraftIds: [] }),
    ).not.toThrow();
    expect(() =>
      assertGroupAircraftChoice(restricted, { aircraftIds: ["demo-208"] }),
    ).not.toThrow();
  });
  it("refuses contradictory choices", () => {
    expect(() =>
      assertGroupAircraftChoice(undefined, {
        aircraftIds: ["demo-206"],
        allAircraft: true,
      }),
    ).toThrow(/not both/);
    expect(() =>
      assertGroupAircraftChoice(undefined, {
        owner: true,
        aircraftIds: [],
        allAircraft: true,
      }),
    ).toThrow(/owner/);
  });
});

describe("assertGroupProgramChange (#45)", () => {
  const legacy: Pick<Group, "programUuid"> = {};
  const scoped: Pick<Group, "programUuid"> = { programUuid: "demo-program" };
  it("lets a system administrator give an unscoped group its first Flight Program", () => {
    expect(
      assertGroupProgramChange(legacy, { programUuid: "demo-program" }, true),
    ).toBe(true);
    expect(() =>
      assertGroupProgramChange(legacy, { programUuid: "demo-program" }, false),
    ).toThrow(/system administrator/);
  });
  it("still refuses to move a group between Flight Programs", () => {
    for (const systemAdmin of [true, false]) {
      expect(() =>
        assertGroupProgramChange(
          scoped,
          { programUuid: "second" },
          systemAdmin,
        ),
      ).toThrow(/cannot be moved/);
      expect(() => assertGroupProgramChange(scoped, {}, systemAdmin)).toThrow(
        /cannot be moved/,
      );
      expect(
        assertGroupProgramChange(
          scoped,
          { programUuid: "demo-program" },
          systemAdmin,
        ),
      ).toBe(false);
      expect(
        assertGroupProgramChange(
          undefined,
          { programUuid: "demo-program" },
          systemAdmin,
        ),
      ).toBe(false);
    }
  });
});

describe("group rules", () => {
  it("refuse with a Rejection and the exact message", () => {
    const refusals: [() => unknown, string][] = [
      [
        () =>
          assertGroupAircraftChoice(undefined, {
            owner: true,
            aircraftIds: [],
            allAircraft: true,
          }),
        "Aircraft owner groups must name their aircraft.",
      ],
      [
        () =>
          assertGroupAircraftChoice(undefined, {
            aircraftIds: ["demo-206"],
            allAircraft: true,
          }),
        "Choose all aircraft in this program or selected aircraft, not both.",
      ],
      [
        () => assertGroupAircraftChoice(undefined, { aircraftIds: [] }),
        "Choose the aircraft this group can access, or choose all aircraft in this program.",
      ],
      [
        () =>
          assertGroupProgramChange(
            { programUuid: "demo-program" },
            { programUuid: "second" },
            true,
          ),
        "A permission group cannot be moved to another Flight Program.",
      ],
      [
        () => assertGroupProgramChange({}, { programUuid: "second" }, false),
        "Only a system administrator can assign an unscoped permission group to a Flight Program.",
      ],
    ];
    for (const [run, message] of refusals) {
      expect(run).toThrow(Rejection);
      expect(run).toThrow(Error(message));
    }
    expect(CHOOSE_GROUP_AIRCRAFT).toBe(refusals[2][1]);
  });
  it("lists every aircraft only through a non-owner group's empty list", () => {
    expect(listsAllAircraft({ aircraftIds: [] })).toBe(true);
    expect(listsAllAircraft({ owner: true, aircraftIds: [] })).toBe(false);
    expect(listsAllAircraft({ aircraftIds: ["demo-206"] })).toBe(false);
  });
});
