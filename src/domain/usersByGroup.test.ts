/**
 * Responsibility: Pins how active users are counted per permission group.
 * Layer: Test. Vitest unit tests.
 * Dependencies: vitest, ./usersByGroup.
 */
import { describe, expect, it } from "vitest";
import { usersByGroup } from "./usersByGroup";

const group = (id: string, name: string, programUuid = "p1") => ({
  id,
  name,
  programUuid,
});
const member = (groupIds: string[], active = true) => ({ active, groupIds });

describe("usersByGroup", () => {
  it("counts a user in each of their groups and keeps empty groups", () => {
    const counts = usersByGroup(
      [member(["pilots", "mx"]), member(["pilots"]), member([])],
      [
        group("mx", "Maintenance"),
        group("pilots", "Pilots"),
        group("o", "Observers"),
      ],
    );
    expect(counts).toEqual([
      { label: "Pilots", users: 2 },
      { label: "Maintenance", users: 1 },
      { label: "Observers", users: 0 },
    ]);
  });

  it("leaves disabled accounts out", () => {
    const counts = usersByGroup(
      [member(["pilots"]), member(["pilots"], false)],
      [group("pilots", "Pilots")],
    );
    expect(counts).toEqual([{ label: "Pilots", users: 1 }]);
  });

  it("orders equal counts by label", () => {
    const counts = usersByGroup(
      [],
      [group("b", "Pilots"), group("a", "Maintenance")],
    );
    expect(counts.map((c) => c.label)).toEqual(["Maintenance", "Pilots"]);
  });

  it("names the Flight Program of groups that share a name", () => {
    const counts = usersByGroup(
      [member(["a"])],
      [
        group("a", "Pilots", "p1"),
        group("b", "Pilots", "p2"),
        group("c", "Board"),
      ],
      [
        { uuid: "p1", name: "Mission operations" },
        { uuid: "p2", name: "Training" },
      ],
    );
    expect(counts.map((c) => c.label)).toEqual([
      "Pilots (Mission operations)",
      "Board",
      "Pilots (Training)",
    ]);
  });
});
