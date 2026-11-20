/**
 * Responsibility: Pins the logbook entry's "Performed by" line: who it names,
 *   where it sits, and that close-out freezes it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/logbook.ts, ./taskCards, ./workOrders,
 *   src/data/demo.ts, tests/fixtures/taskCards.ts,
 *   tests/fixtures/workOrders.ts.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { saveTaskCard } from "./taskCards";
import {
  saveWorkOrder,
  workOrderFieldsSchema,
  type WorkOrder,
} from "./workOrders";
import { logbookText } from "./logbook";

const now = Date.parse("2026-10-02T12:00:00Z");
const jamie = { userId: "jamie", name: "Jamie Lee" };
const sam = { userId: "sam", name: "Sam Rivera" };
const credentials = { licenseNumber: "3456789", certificateType: "A&P IA" };

/** An open order whose job cards were signed by the given technicians. */
function orderWithCards(
  cards: {
    by: { userId: string; name: string };
    status?: "completed" | "canceled";
    includeInLogbook?: boolean;
  }[],
) {
  const s = demoSnapshot();
  const wo = workOrderCommand();
  const order = saveWorkOrder(s, wo, now);
  cards.forEach((c, index) => {
    const cmd = taskCardCommand();
    cmd.fields.workOrderUuid = order.uuid;
    cmd.fields.cardNumber = `TC-${index + 1}`;
    cmd.fields.title = `Task ${index + 1}`;
    cmd.fields.steps = [];
    cmd.fields.includeInLogbook = c.includeInLogbook ?? true;
    cmd.fields.actualWork = "Work recorded";
    const card = saveTaskCard(s, cmd, now);
    card.status = c.status ?? "completed";
    card.completionDate = "2026-10-02";
    card.technicianSignoff = { ...c.by, at: now + index };
    // The inspector approves the card; the inspector is not a performer.
    card.inspectionSignoff = { userId: "ia", name: "Pat Inspector", at: now };
  });
  return { s, order };
}
/** Closes the order as completed and approved for return to service. */
function close(s: ReturnType<typeof demoSnapshot>, order: WorkOrder) {
  return saveWorkOrder(
    s,
    {
      action: "save",
      uuid: order.uuid,
      version: order.version,
      componentUuids: [],
      fields: {
        ...workOrderFieldsSchema.parse(order),
        status: "completed",
        completionDate: "2026-10-02",
        releaseOutcome: "Approved for return to service.",
      },
      tasks: [],
    },
    now,
  );
}
const performedBy = (text: string) =>
  text.split("\n").filter((line) => line.startsWith("Performed by:"));

it("names each distinct technician signer once, beside the certifying person", () => {
  const { s, order } = orderWithCards([
    { by: jamie },
    { by: sam },
    { by: jamie },
    // Excluded and canceled cards are not part of the entry.
    { by: { userId: "x", name: "Excluded Tech" }, includeInLogbook: false },
    { by: { userId: "y", name: "Canceled Tech" }, status: "canceled" },
  ]);
  const final = close(s, order);
  const text = logbookText(s, final, "maintenance", {
    userId: s.user.id,
    name: s.user.name,
    ...credentials,
  });
  expect(performedBy(text)).toEqual(["Performed by: Jamie Lee, Sam Rivera"]);
  const lines = text.split("\n");
  expect(lines.indexOf("Performed by: Jamie Lee, Sam Rivera")).toBe(
    lines.indexOf(`Certifying person: ${s.user.name}`) - 1,
  );
  // The certifying person is left out when they also performed some work.
  expect(
    performedBy(
      logbookText(s, final, "maintenance", { ...jamie, ...credentials }),
    ),
  ).toEqual(["Performed by: Sam Rivera"]);
  // The component template names the approver "Name"; the performer line stays.
  expect(
    performedBy(logbookText(s, final, "component", { ...sam, ...credentials })),
  ).toEqual(["Performed by: Jamie Lee"]);
});

it("omits the line when the performer is the certifying person", () => {
  const { s, order } = orderWithCards([{ by: jamie }, { by: jamie }]);
  const final = close(s, order);
  expect(
    performedBy(
      logbookText(s, final, "maintenance", { ...jamie, ...credentials }),
    ),
  ).toEqual([]);
  // Without an account id the approver is matched by name.
  expect(
    performedBy(
      logbookText(s, final, "maintenance", {
        name: "Jamie Lee",
        ...credentials,
      }),
    ),
  ).toEqual([]);
});

it("freezes performers at close-out and leaves entries closed before the line existed unchanged", () => {
  const { s, order } = orderWithCards([{ by: jamie }]);
  // The live sample of an open order already names the performer.
  expect(
    performedBy(
      logbookText(
        s,
        order,
        "maintenance",
        { userId: s.user.id, name: s.user.name, ...credentials },
        undefined,
        undefined,
        true,
      ),
    ),
  ).toEqual(["Performed by: Jamie Lee"]);
  const final = close(s, order);
  expect(final.closeout!.performers).toEqual([jamie]);
  const signer = { userId: s.user.id, name: s.user.name, ...credentials };
  const frozen = logbookText(s, final, "maintenance", signer);
  // Later account renames do not rewrite the closed entry.
  s.taskCards![0].technicianSignoff = { ...jamie, name: "Renamed", at: now };
  expect(logbookText(s, final, "maintenance", signer)).toBe(frozen);
  // An order closed before performers were recorded keeps its entry.
  const { performers: _performers, ...closeout } = final.closeout!;
  const older = { ...final, closeout };
  expect(performedBy(logbookText(s, older, "maintenance", signer))).toEqual([]);
  expect(logbookText(s, older, "maintenance", signer)).toBe(
    frozen.replace("Performed by: Jamie Lee\n", ""),
  );
});
