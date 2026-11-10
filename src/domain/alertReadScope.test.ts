/**
 * Responsibility: Pins that computeAlerts raises AD, component and
 *   inspection alerts only on aircraft the user can read, even when handed a
 *   snapshot that still holds other aircraft's records.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/alerts.ts, model.ts, tests/fixtures/dueFleet.ts.
 *
 * The server scopes the snapshot first; this check is the second line, so a
 * scoping mistake cannot email one group's records to another.
 */
import { expect, it } from "vitest";
import { DUE_FLEET_TODAY, dueFleet } from "../../tests/fixtures/dueFleet";
import { computeAlerts } from "./alerts";

it("leaves out the records of an aircraft outside the user's groups", () => {
  const { s, a, b, c } = dueFleet();
  s.inspections = s.inspections.filter((i) => i.aircraftUuid !== c.uuid);
  const titles = () => computeAlerts(s, DUE_FLEET_TODAY).map((x) => x.title);
  expect(titles()).toEqual(
    expect.arrayContaining([
      "AD AD-B overdue",
      "Component due now: Type b-pump",
      "Inspection overdue: i-other",
    ]),
  );
  s.groups = [
    {
      id: "n206-only",
      name: "N206 crew",
      programUuid: "demo-program",
      aircraftIds: [a.uuid],
      permissions: ["read"],
    },
  ];
  s.user = { ...s.user, isAdmin: false, groupIds: ["n206-only"] };
  const scoped = computeAlerts(s, DUE_FLEET_TODAY);
  expect(scoped.length).toBeGreaterThan(0);
  expect(scoped.filter((x) => x.aircraftUuid === b.uuid)).toEqual([]);
  expect(scoped.map((x) => x.title)).toContain("AD AD-OVERDUE overdue");
});
