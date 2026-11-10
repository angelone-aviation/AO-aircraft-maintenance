/**
 * Responsibility: Pins that the board's "Due in the next 30 days" list leaves
 *   out an AD action that compliance has closed, such as a terminating action.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/boardSummary.ts, src/domain/airworthiness.ts,
 *   tests/fixtures/dueFleet.ts.
 */
import { expect, it } from "vitest";
import { dueFleet } from "../../tests/fixtures/dueFleet";
import { boardSummary } from "./boardSummary";
import { adStatus } from "./airworthiness";

const NOW = new Date(2026, 9, 30, 12).getTime();

// A terminating action keeps the action's last due date, which used to count
// as a date 29 days past and list the AD as "ok" with negative days.
function terminatedFleet() {
  const { s, c } = dueFleet();
  s.inspections = s.inspections.filter((i) => i.aircraftUuid !== c.uuid);
  const ad = s.airworthiness!.find((r) => r.uuid === "ad-overdue")!;
  const task = ad.tasks[0];
  task.dueDate = "2026-10-01";
  ad.history = [
    {
      uuid: "terminated",
      taskUuid: task.uuid,
      date: "2026-09-15",
      hours: null,
      cycles: null,
      method: "Replaced with improved part",
      serviceBulletin: "",
      terminatedBy: "Terminating action per paragraph (h)",
      workOrderUuid: "",
      mechanic: "Mechanic",
      certificate: "",
      evidence: "",
      recordedAt: 0,
      recordedBy: "demo-admin",
    },
  ];
  return { s, ad };
}

it("leaves an AD whose only action was terminated off the 30-day list", () => {
  const { s, ad } = terminatedFleet();
  expect(adStatus(s, ad, "2026-10-30")).toBe("Complied");
  const row = boardSummary(s, NOW).upcoming.find((i) => i.uuid === ad.uuid);
  expect(row).toBeUndefined();
});

it("still lists the same AD while its action is open", () => {
  const { s, ad } = terminatedFleet();
  ad.history = [];
  const row = boardSummary(s, NOW).upcoming.find((i) => i.uuid === ad.uuid);
  expect(row?.days).toBe(-29);
});
