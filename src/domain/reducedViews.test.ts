/**
 * Responsibility: Pins which reduced views a user's groups give, and that an
 *   aircraft owner who also sits on the board gets the two views side by
 *   side, each for the aircraft its own groups cover, never the workspace.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: ./reducedViews, ./ownerView, ./boardView, ./boardSummary,
 *   ./programs, ./model, src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot, withDemoRole } from "../data/demo";
import type { Snapshot } from "./model";
import { reducedViewGroups, scopedSnapshot } from "./programs";
import { isOwnerView, ownerPortalAircraft } from "./ownerView";
import { boardViewAircraft, isBoardView } from "./boardView";
import { boardSummary } from "./boardSummary";
import { reducedSnapshot } from "./reducedViews";

const OWNED = "demo-206";

// One seed for every member, since the seed stamps records with the clock.
const SEED = withDemoRole(withDemoRole(demoSnapshot(), "owner"), "board");

// The demo program seen by a member of the given groups: the sample owner
// group names N206MA, the sample board group reads the fleet.
function memberOf(groupIds: string[], edit: (s: Snapshot) => void = () => {}) {
  const s = structuredClone(SEED);
  s.user = { ...s.user, groupIds };
  s.members = s.members.map((m) => (m.id === s.user.id ? s.user : m));
  edit(s);
  return s;
}

describe("which reduced views a user gets", () => {
  it.each<[string, string[], boolean, boolean]>([
    ["an owner group only", ["demo-owners"], true, false],
    ["a board group only", ["demo-board"], false, true],
    [
      "an owner group and a board group",
      ["demo-owners", "demo-board"],
      true,
      true,
    ],
    [
      "an owner group and an ordinary group",
      ["demo-owners", "demo-pilots"],
      false,
      false,
    ],
    [
      "a board group and an ordinary group",
      ["demo-board", "demo-pilots"],
      false,
      false,
    ],
    [
      "all three kinds",
      ["demo-owners", "demo-board", "demo-pilots"],
      false,
      false,
    ],
    ["no group", [], false, false],
  ])("for %s", (_, groupIds, owner, board) => {
    const s = memberOf(groupIds);
    expect([isOwnerView(s), isBoardView(s)]).toEqual([owner, board]);
    expect(reducedViewGroups(s).length > 0).toBe(owner || board);
    expect(reducedSnapshot(scopedSnapshot(s)) !== undefined).toBe(
      owner || board,
    );
  });
});

describe("an aircraft owner who also sits on the board", () => {
  const full = () => memberOf(["demo-owners", "demo-board"]);

  it("gets each view for the aircraft its own groups cover", () => {
    const s = full();
    expect(ownerPortalAircraft(s).map((a) => a.uuid)).toEqual([OWNED]);
    expect(boardViewAircraft(s)).toEqual(s.aircraft);
    const narrow = memberOf(["demo-owners", "demo-board"], (x) => {
      x.groups = x.groups.map((g) =>
        g.id === "demo-board" ? { ...g, aircraftIds: ["demo-208"] } : g,
      );
    });
    expect(boardViewAircraft(narrow).map((a) => a.uuid)).toEqual(["demo-208"]);
    const view = scopedSnapshot(narrow);
    expect(view.aircraft.map((a) => a.uuid)).toEqual([OWNED, "demo-208"]);
    expect(view.boardCosts?.map((c) => c.aircraftUuid)).toEqual(["demo-208"]);
    expect(boardSummary(view).aircraft.map((l) => l.aircraft.uuid)).toEqual([
      "demo-208",
    ]);
  });

  it("reads the owner's records for the owned aircraft and the board's for the rest", () => {
    const both = scopedSnapshot(full());
    const owner = scopedSnapshot(memberOf(["demo-owners"]));
    const board = scopedSnapshot(memberOf(["demo-board"]));
    const ownedInspections = owner.inspections.map((i) => i.uuid);
    expect(ownedInspections.length).toBeGreaterThan(0);
    expect(both.inspections).toEqual([
      ...owner.inspections,
      ...board.inspections.filter((i) => !ownedInspections.includes(i.uuid)),
    ]);
    expect(both.discrepancies).toEqual([
      ...owner.discrepancies,
      ...board.discrepancies.filter((d) => d.aircraftUuid !== OWNED),
    ]);
    expect(both.boardCosts).toEqual(board.boardCosts);
    expect(Object.keys(both).sort()).toEqual(
      [...new Set([...Object.keys(owner), ...Object.keys(board)])].sort(),
    );
  });

  it("reads none of the workspace", () => {
    const both = scopedSnapshot(full());
    expect(both.flights).toEqual([]);
    expect(both.audit).toEqual([]);
    expect(both.members.map((m) => m.id)).toEqual([both.user.id]);
    expect(both.costs).toBeUndefined();
    expect(both.manuals).toBeUndefined();
    expect(both.taskCards).toBeUndefined();
  });
});
