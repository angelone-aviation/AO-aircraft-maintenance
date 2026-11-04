/**
 * Responsibility: Tests the review of groups an edit before #34 may have
 *   silently opened to every aircraft in their Flight Program.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: vitest; src/data/demo.ts, src/domain/groupAccessReview.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { AuditEntry, Group } from "./model";
import {
  groupAccessFinding,
  groupAccessReport,
  groupAccessReports,
  groupAccessSummary,
  sortReports,
} from "./groupAccessReview";

const DAY = 86400000;
const group = (fields: Partial<Group> = {}): Group => ({
  id: "crew",
  name: "N206 crew",
  programUuid: "demo-program",
  programAdmin: false,
  owner: false,
  aircraftIds: [],
  permissions: ["read", "flight"],
  ...fields,
});
const state = (fields: Partial<Group> & { allAircraft?: boolean } = {}) => {
  const { id: _id, ...g } = group(fields);
  return JSON.stringify(g);
};
let n = 0;
// A group.saved change-log entry as convex/admin.ts saveGroup writes it.
const saved = (
  at: number,
  after: string | undefined,
  before?: string,
  actorId = "demo-admin",
): AuditEntry => ({
  uuid: `entry-${++n}`,
  at,
  actorId,
  action: "group.saved",
  entityUuid: "crew",
  programUuid: "demo-program",
  before,
  after,
});
// Newest first, as the server reads them.
const newestFirst = (...entries: AuditEntry[]) =>
  [...entries].sort((a, b) => b.at - a.at);
const created = 10 * DAY;

describe("groupAccessFinding", () => {
  it("flags a group whose restricted list an edit emptied (#34)", () => {
    const history = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206"] })),
      saved(
        created + DAY,
        state({ name: "N206 crew (renamed)" }),
        state({ aircraftIds: ["demo-206"] }),
        "demo-pilot",
      ),
    );
    expect(groupAccessFinding(group(), history, created)).toEqual({
      flag: "widened",
      reason: "aircraft_removed",
      savedAt: created + DAY,
      savedBy: "demo-pilot",
      aircraftBefore: ["demo-206"],
    });
  });

  it("infers the earlier list from the previous entry when an edit recorded no before-state", () => {
    const history = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206", "demo-208"] })),
      saved(created + DAY, state()),
    );
    expect(groupAccessFinding(group(), history, created)).toMatchObject({
      flag: "widened",
      reason: "aircraft_removed",
      aircraftBefore: ["demo-206", "demo-208"],
    });
  });

  it("flags an owner group with no aircraft that became an ordinary group", () => {
    const owner = state({ owner: true, permissions: ["read"] });
    const history = newestFirst(
      saved(created, owner),
      saved(created + DAY, state({ permissions: ["read"] }), owner),
    );
    expect(groupAccessFinding(group(), history, created)).toMatchObject({
      flag: "widened",
      reason: "owner_removed",
      aircraftBefore: [],
    });
  });

  it("keeps flagging a widened group re-saved without an explicit choice", () => {
    const history = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206"] })),
      saved(created + DAY, state(), state({ aircraftIds: ["demo-206"] })),
      // A client from before #34 may still save an unchanged all-aircraft
      // group.
      saved(created + 2 * DAY, state({ name: "Crew" }), state()),
    );
    expect(groupAccessFinding(group(), history, created)).toMatchObject({
      flag: "widened",
      savedAt: created + DAY,
    });
  });

  it("clears a group once an administrator chose all aircraft explicitly", () => {
    const history = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206"] })),
      saved(created + DAY, state(), state({ aircraftIds: ["demo-206"] })),
      saved(created + 2 * DAY, state({ allAircraft: true }), state()),
    );
    expect(groupAccessFinding(group(), history, created)).toBeUndefined();
  });

  it("does not flag a group restricted again after it was widened", () => {
    const history = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206"] })),
      saved(created + DAY, state(), state({ aircraftIds: ["demo-206"] })),
      saved(created + 2 * DAY, state({ aircraftIds: ["demo-208"] }), state()),
    );
    const now = group({ aircraftIds: ["demo-208"] });
    expect(groupAccessFinding(now, history, created)).toBeUndefined();
  });

  it("asks for review of a group created with all aircraft before the choice was recorded, without calling it widened", () => {
    const history = [saved(created, state())];
    expect(groupAccessFinding(group(), history, created)).toEqual({
      flag: "review",
      reason: "created_all",
      savedAt: created,
      savedBy: "demo-admin",
      aircraftBefore: [],
    });
    // Renaming it later changes nothing about how it reached all aircraft.
    const renamed = newestFirst(
      ...history,
      saved(created + DAY, state({ name: "Crew" }), state()),
    );
    expect(groupAccessFinding(group(), renamed, created)).toMatchObject({
      flag: "review",
      reason: "created_all",
    });
  });

  it("does not flag a group created with an explicit all-aircraft choice", () => {
    const history = [saved(created, state({ allAircraft: true }))];
    expect(groupAccessFinding(group(), history, created)).toBeUndefined();
  });

  it("does not flag the default all-aircraft groups a new Flight Program receives", () => {
    // ensureDefaultGroups records the default definition with no owner flag.
    const pilots = JSON.stringify({
      name: "Pilots",
      programAdmin: false,
      aircraftIds: [],
      permissions: ["read", "flight", "discrepancy"],
      programUuid: "demo-program",
    });
    const current = group({
      name: "Pilots",
      permissions: ["read", "flight", "discrepancy"],
    });
    expect(
      groupAccessFinding(current, [saved(created, pilots)], created),
    ).toBeUndefined();
    // A changed default is judged like any other group.
    const custom = JSON.stringify({
      ...JSON.parse(pilots),
      permissions: ["read", "flight", "discrepancy", "maintenance"],
    });
    expect(
      groupAccessFinding(current, [saved(created, custom)], created),
    ).toMatchObject({ flag: "review", reason: "created_all" });
  });

  it("asks for review when the change log cannot show the earlier aircraft", () => {
    // The oldest entry is an edit long after creation with no before-state.
    expect(
      groupAccessFinding(group(), [saved(created + DAY, state())], created),
    ).toMatchObject({ flag: "review", reason: "no_before" });
    // The log begins with the group already open to all aircraft.
    expect(
      groupAccessFinding(
        group(),
        [saved(created + DAY, state({ name: "Crew" }), state())],
        created,
      ),
    ).toMatchObject({ flag: "review", reason: "no_before" });
    // Entries that record no group state at all.
    expect(
      groupAccessFinding(group(), [saved(created, undefined)], created),
    ).toMatchObject({ flag: "review", reason: "unrecorded_change" });
  });

  it("asks for review when the group reached all aircraft outside the change log", () => {
    const history = [saved(created, state({ aircraftIds: ["demo-206"] }))];
    expect(groupAccessFinding(group(), history, created)).toEqual({
      flag: "review",
      reason: "unrecorded_change",
      aircraftBefore: [],
    });
    expect(groupAccessFinding(group(), [], created)).toEqual({
      flag: "review",
      reason: "no_history",
      aircraftBefore: [],
    });
    // An edit found it open, although the entry before left it limited.
    const gap = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206"] })),
      saved(created + DAY, state({ name: "Crew" }), state()),
    );
    expect(groupAccessFinding(group(), gap, created)).toMatchObject({
      flag: "review",
      reason: "unrecorded_change",
      savedAt: created + DAY,
    });
  });

  it("ignores groups that do not reach every aircraft through an empty list", () => {
    const history = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206"] })),
      saved(created + DAY, state(), state({ aircraftIds: ["demo-206"] })),
    );
    for (const g of [
      group({ aircraftIds: ["demo-206"] }),
      group({ owner: true, permissions: ["read"] }),
      group({ programAdmin: true }),
      group({ programUuid: undefined }),
    ])
      expect(groupAccessFinding(g, history, created)).toBeUndefined();
  });

  it("does not flag a Flight Program administrator group that became an ordinary all-aircraft group", () => {
    const admin = state({ programAdmin: true, aircraftIds: ["demo-206"] });
    const history = newestFirst(
      saved(created, admin),
      saved(created + DAY, state(), admin),
    );
    expect(groupAccessFinding(group(), history, created)).toBeUndefined();
  });
});

describe("groupAccessReports", () => {
  // N206 crew was limited to N206MA, which moved to a second program; an
  // edit before the fix then emptied its list.
  function widenedAfterTransfer() {
    const s = demoSnapshot();
    s.programs = [
      ...s.programs!,
      { ...s.programs![0], uuid: "second", name: "Second program" },
    ];
    s.aircraft = s.aircraft.map((a) =>
      a.uuid === "demo-206" ? { ...a, programUuid: "second" } : a,
    );
    s.groups.push(group());
    s.members = s.members.map((m) =>
      m.id === "demo-pilot" ? { ...m, groupIds: ["crew"] } : m,
    );
    s.audit = newestFirst(
      saved(created, state({ aircraftIds: ["demo-206", "demo-208"] })),
      saved(
        created + DAY,
        state(),
        state({ aircraftIds: ["demo-206", "demo-208", "gone"] }),
      ),
    );
    return s;
  }

  it("names the program, who saved it, the aircraft listed before and where they are now, and the members", () => {
    const [report, ...rest] = groupAccessReports(widenedAfterTransfer());
    expect(rest).toEqual([]);
    expect(report).toEqual({
      groupId: "crew",
      groupName: "N206 crew",
      programUuid: "demo-program",
      programName: "Mission operations",
      flag: "widened",
      reason: "aircraft_removed",
      savedAt: created + DAY,
      savedBy: { id: "demo-admin", name: "Alex Morgan" },
      aircraftBefore: [
        {
          uuid: "demo-206",
          registration: "N206MA",
          programUuid: "second",
          programName: "Second program",
          transferredAway: true,
        },
        {
          uuid: "demo-208",
          registration: "N208MA",
          programUuid: "demo-program",
          programName: "Mission operations",
          transferredAway: false,
        },
        { uuid: "gone", transferredAway: true },
      ],
      members: [
        {
          id: "demo-pilot",
          name: "Jordan Lee",
          email: "jordan@example.test",
          active: true,
        },
      ],
    });
    expect(groupAccessSummary(report, () => "Nov 3, 2026")).toBe(
      "Limited to N206MA (now in Second program), N208MA and an aircraft no longer in Angel One until Alex Morgan saved it with no aircraft on Nov 3, 2026.",
    );
  });

  it("describes each review reason", () => {
    const base = groupAccessReport(group(), groupAccessFinding(group(), [])!, {
      programs: [],
      aircraft: [],
      users: [],
    });
    const date = () => "Nov 3, 2026";
    const say = (fields: Partial<typeof base>) =>
      groupAccessSummary({ ...base, ...fields }, date);
    expect(say({})).toBe(
      "Cannot determine: this group has no change-log entries.",
    );
    expect(
      say({
        reason: "created_all",
        savedAt: 1,
        savedBy: { id: "x", name: "Alex Morgan" },
      }),
    ).toBe(
      "Cannot determine: Alex Morgan created it with all aircraft on Nov 3, 2026, before the form asked for an explicit choice.",
    );
    expect(say({ reason: "no_before", savedAt: 1 })).toBe(
      "Cannot determine: the change log does not show its aircraft before an unknown user saved it on Nov 3, 2026.",
    );
    expect(say({ reason: "unrecorded_change" })).toBe(
      "Cannot determine: the change log does not show how it came to cover all aircraft.",
    );
    expect(
      say({
        flag: "widened",
        reason: "owner_removed",
        savedAt: 1,
        savedBy: { id: "system", name: "the system" },
      }),
    ).toBe(
      "An aircraft owner group with no aircraft until the system saved it as an ordinary group on Nov 3, 2026.",
    );
  });

  it("falls back for an unknown program and actor, and names the system", () => {
    const report = (savedBy: string) =>
      groupAccessReport(
        group(),
        { flag: "review", reason: "no_before", savedBy, aircraftBefore: [] },
        { programs: [], aircraft: [], users: [] },
      );
    expect(report("demo-admin")).toMatchObject({
      programName: "Unknown Flight Program",
      savedBy: { id: "demo-admin", name: "an unknown user" },
    });
    expect(report("system").savedBy).toEqual({
      id: "system",
      name: "the system",
    });
  });

  it("sorts widened before review, then by program and group name", () => {
    const base = groupAccessReport(group(), groupAccessFinding(group(), [])!, {
      programs: [],
      aircraft: [],
      users: [],
    });
    const r = (
      flag: "widened" | "review",
      programName: string,
      groupName: string,
    ) => ({
      ...base,
      flag,
      programName,
      groupName,
    });
    const reports = [
      r("review", "Alpha", "Crew"),
      r("widened", "Beta", "Crew"),
      r("widened", "Alpha", "Pilots"),
      r("widened", "Alpha", "Crew"),
    ];
    expect(
      sortReports(reports).map((x) => [x.flag, x.programName, x.groupName]),
    ).toEqual([
      ["widened", "Alpha", "Crew"],
      ["widened", "Alpha", "Pilots"],
      ["widened", "Beta", "Crew"],
      ["review", "Alpha", "Crew"],
    ]);
    expect(reports[0].flag).toBe("review");
  });
});
