/**
 * Responsibility: Pins the account-administration rules: the groups a new
 *   member gets, the Observers fallback, the groups that replace a member's
 *   access, group saves and account details.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/accountRules.ts, ./model (types), ./rejection.
 */
import { describe, expect, it } from "vitest";
import {
  assertAccessGroups,
  assertGrantsRead,
  assertProgramGroups,
  grantsRead,
  normalizeAccount,
  normalizeGroup,
  observersGroup,
  programGroupIds,
  type GroupInput,
} from "./accountRules";
import type { Group } from "./model";
import { Rejection } from "./rejection";

const PROGRAM = "program";
const group = (id: string, fields: Partial<Group> = {}): Group => ({
  id,
  programUuid: PROGRAM,
  name: id,
  aircraftIds: [],
  permissions: ["read"],
  ...fields,
});
const OBSERVERS = group("observers", { name: "Observers" });
const MECHANICS = group("mechanics", { permissions: ["read", "maintenance"] });
const WRITERS = group("writers", { permissions: ["flight"] });
const ELSEWHERE = group("elsewhere", { programUuid: "other" });
const GROUPS = [OBSERVERS, MECHANICS, WRITERS, ELSEWHERE];

function refusalOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal.");
}
function expectRejection(run: () => unknown, message: string) {
  const error = refusalOf(run);
  expect(error).toBeInstanceOf(Rejection);
  expect(error).toEqual(new Error(message));
}

describe("programGroupIds", () => {
  it("keeps chosen groups that grant read access, without repeats", () => {
    const chosen = ["mechanics", "writers", "mechanics"];
    expect(programGroupIds(GROUPS, PROGRAM, chosen)).toEqual([
      "mechanics",
      "writers",
    ]);
  });

  it("adds Observers when no chosen group grants read access", () => {
    expect(programGroupIds(GROUPS, PROGRAM, [])).toEqual(["observers"]);
    expect(programGroupIds(GROUPS, PROGRAM, ["writers"])).toEqual([
      "writers",
      "observers",
    ]);
  });

  it("refuses groups outside the program", () => {
    for (const id of ["elsewhere", "missing"])
      expectRejection(
        () => programGroupIds(GROUPS, PROGRAM, ["mechanics", id]),
        "Users can only be assigned groups in this Flight Program.",
      );
  });

  it("refuses when the program has no Observers group to fall back to", () => {
    expectRejection(
      () => programGroupIds([MECHANICS, WRITERS], PROGRAM, ["writers"]),
      "Select a permission group; Observers read-only access is unavailable.",
    );
  });
});

describe("observersGroup", () => {
  it("matches the default read-only group by name and exact shape", () => {
    expect(observersGroup(GROUPS, PROGRAM)).toBe(OBSERVERS);
    expect(observersGroup(GROUPS, "other")).toBeUndefined();
    const lookalikes: Partial<Group>[] = [
      { name: "Observers (old)" },
      { programAdmin: true },
      { aircraftIds: ["aircraft"] },
      { permissions: ["read", "flight"] },
      { permissions: ["flight"] },
    ];
    for (const fields of lookalikes)
      expect(observersGroup([{ ...OBSERVERS, ...fields }], PROGRAM)).toBe(
        undefined,
      );
  });
});

describe("grantsRead", () => {
  it("is true when any of the groups grants read access", () => {
    expect(grantsRead(GROUPS, ["writers", "mechanics"])).toBe(true);
    expect(grantsRead(GROUPS, ["writers"])).toBe(false);
    expect(grantsRead(GROUPS, [])).toBe(false);
  });
});

describe("member access refusals", () => {
  it("refuses a group of another program, or an unknown one", () => {
    expect(() =>
      assertProgramGroups(GROUPS, PROGRAM, ["mechanics", "observers"]),
    ).not.toThrow();
    for (const id of ["elsewhere", "missing"])
      expectRejection(
        () => assertProgramGroups(GROUPS, PROGRAM, ["mechanics", id]),
        "Users can only be assigned groups in this Flight Program.",
      );
  });

  it("refuses groups without read access, none included, when adding", () => {
    expect(() =>
      assertGrantsRead(GROUPS, ["writers", "mechanics"]),
    ).not.toThrow();
    for (const ids of [["writers"], []])
      expectRejection(
        () => assertGrantsRead(GROUPS, ids),
        "Select a group with read access.",
      );
  });

  it("asks for a group, or removal, before read access when changing", () => {
    expect(() => assertAccessGroups(GROUPS, ["mechanics"])).not.toThrow();
    expectRejection(
      () => assertAccessGroups(GROUPS, []),
      "Select at least one permission group or remove program access.",
    );
    expectRejection(
      () => assertAccessGroups(GROUPS, ["writers"]),
      "Select a group with read access.",
    );
  });
});

describe("normalizeGroup", () => {
  const input = (fields: Partial<GroupInput> = {}): GroupInput => ({
    programUuid: PROGRAM,
    name: "  Line crew  ",
    aircraftIds: ["a1", "a2", "a1"],
    permissions: ["read", "flight", "read"],
    ...fields,
  });

  it("trims the name, drops repeats and defaults the flags to false", () => {
    expect(normalizeGroup(input(), undefined)).toEqual({
      programUuid: PROGRAM,
      programAdmin: false,
      owner: false,
      name: "Line crew",
      aircraftIds: ["a1", "a2"],
      permissions: ["read", "flight"],
    });
  });

  it("gives no program to a group stored without one (#45 retired)", () => {
    const unscoped = group("legacy", { programUuid: undefined });
    expectRejection(
      () => normalizeGroup(input(), unscoped),
      "A permission group cannot be moved to another Flight Program.",
    );
  });

  it("measures the name after trimming, as it is stored", () => {
    const padded = (length: number) => ` ${"x".repeat(length)} `;
    const saved = normalizeGroup(input({ name: padded(100) }), undefined);
    expect(saved.name).toBe("x".repeat(100));
    expectRejection(
      () => normalizeGroup(input({ name: padded(101) }), undefined),
      "Group name is required.",
    );
  });

  // Characterizes current behaviour: no permissions at all is allowed.
  it("allows no permissions", () => {
    const none = normalizeGroup(input({ permissions: [] }), undefined);
    expect(none.permissions).toEqual([]);
  });

  it.each<[string, Partial<GroupInput>]>([
    ["Group name is required.", { name: "   " }],
    ["Group name is required.", { name: "x".repeat(101) }],
    [
      "Write permissions also require read access.",
      { permissions: ["flight"] },
    ],
    [
      "Aircraft owner groups are read-only: remove administrator and write permissions.",
      { owner: true },
    ],
    [
      "Choose the aircraft this group can access, or choose all aircraft in this program.",
      { aircraftIds: [] },
    ],
    ["Select a Flight Program for this group.", { programUuid: undefined }],
  ])("refuses with %j", (message, fields) => {
    expectRejection(() => normalizeGroup(input(fields), undefined), message);
  });

  it("checks the program before the name, and the name before the rest", () => {
    const moved = group("crew", { programUuid: "other" });
    const broken = input({ name: "", permissions: ["flight"] });
    expectRejection(
      () => normalizeGroup(broken, moved),
      "A permission group cannot be moved to another Flight Program.",
    );
    expectRejection(
      () => normalizeGroup(broken, undefined),
      "Group name is required.",
    );
  });
});

describe("normalizeAccount", () => {
  it("trims and lower-cases the email and trims the name", () => {
    expect(normalizeAccount("  Pat@Example.ORG ", "  Pat Lee ")).toEqual({
      email: "pat@example.org",
      name: "Pat Lee",
    });
  });

  it("measures the name after trimming", () => {
    const name = ` ${"x".repeat(150)} `;
    expect(normalizeAccount("pat@example.org", name).name).toHaveLength(150);
  });

  it.each([
    ["pat@example", "Pat"],
    ["pat example@x.org", "Pat"],
    ["pat@example.org", "   "],
    ["pat@example.org", "x".repeat(151)],
  ])("refuses %j with %j", (email, name) => {
    expectRejection(
      () => normalizeAccount(email, name),
      "A valid email and name are required.",
    );
  });
});
