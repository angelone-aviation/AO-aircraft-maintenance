import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  saveWorkOrder,
  newWorkTask,
  workSources,
  workOrderProgress,
  validateWorkOrderFile,
} from "./workOrders";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import { totalSeconds } from "./model";
import { scopedSnapshot } from "./programs";
const now = Date.parse("2026-10-01T12:00:00Z");
describe("work orders", () => {
  it("captures current aircraft and selected component readings and preserves them after flights", () => {
    const s = demoSnapshot(),
      command = workOrderCommand();
    s.management = [workOrderComponent()];
    command.componentUuids = ["engine"];
    const w = saveWorkOrder(s, command, now);
    expect(w.number).toBe("WO-2026-0001");
    expect(w.aircraft.totalSeconds).toBe(totalSeconds(s.aircraft[0]));
    expect(w.componentReadings[0]).toMatchObject({
      timeSinceNew: 110 * 3600,
      timeSinceOverhaul: 30 * 3600,
      timeSinceRepair: null,
    });
    s.aircraft[0].currentHobbs += 7200;
    const updated = saveWorkOrder(
      s,
      { ...command, version: w.version },
      now + 1000,
    );
    expect(updated.aircraft).toEqual(w.aircraft);
    expect(updated.componentReadings).toEqual(w.componentReadings);
    expect(updated.recordedAt).toBe(w.recordedAt);
    expect(
      saveWorkOrder(
        s,
        { ...workOrderCommand(), uuid: crypto.randomUUID() },
        now,
      ).number,
    ).toBe("WO-2026-0002");
  });
  it("adds discrepancies, inspections and installed service requirements, rejects duplicates and foreign items", () => {
    const s = demoSnapshot(),
      command = workOrderCommand(),
      c = workOrderComponent();
    s.management = [
      c,
      {
        kind: "componentRequirement",
        uuid: "service",
        version: 0,
        aircraftUuid: c.aircraftUuid,
        componentUuid: c.uuid,
        description: "Inspect engine",
        requirementType: "Inspection Requirement",
        notes: "",
        calendarIntervalUnit: "MONTHS",
        timeBasis: "TSN",
        timeLimitMode: "ABSOLUTE",
        cycleLimitMode: "ABSOLUTE",
        warningCalendarMonths: 1,
        warningSeconds: 0,
        warningCycles: 0,
      },
    ];
    s.discrepancies = [
      {
        uuid: "defect",
        aircraftUuid: c.aircraftUuid,
        description: "Oil leak",
        status: "open",
        authorId: s.user.id,
        createdAt: now,
      },
    ];
    const sources = workSources(s, c.aircraftUuid);
    expect(new Set(sources.map((x) => x.source.kind))).toEqual(
      new Set(["discrepancy", "inspection", "componentRequirement"]),
    );
    let w = saveWorkOrder(s, command, now);
    for (const item of sources)
      w = saveWorkOrder(
        s,
        {
          action: "add",
          uuid: w.uuid,
          version: w.version,
          source: item.source,
        },
        now,
      );
    expect(w.tasks).toHaveLength(sources.length);
    expect(workOrderProgress(s, w).outstandingDiscrepancies).toBe(1);
    expect(() =>
      saveWorkOrder(
        s,
        {
          action: "add",
          uuid: w.uuid,
          version: w.version,
          source: sources[0].source,
        },
        now,
      ),
    ).toThrow("already");
    expect(() =>
      saveWorkOrder(
        s,
        {
          action: "add",
          uuid: w.uuid,
          version: w.version,
          source: {
            kind: "inspection",
            uuid: s.inspections.find((i) => i.aircraftUuid !== c.aircraftUuid)!
              .uuid,
          },
        },
        now,
      ),
    ).toThrow("unavailable");
    c.installed = false;
    expect(
      workSources(s, c.aircraftUuid).some(
        (x) => x.source.kind === "componentRequirement",
      ),
    ).toBe(false);
  });
  it("enforces stale edits, closeout, source history, access and program isolation", () => {
    const s = demoSnapshot(),
      command = workOrderCommand();
    command.tasks = [
      newWorkTask({ kind: "manual", uuid: "manual" }, "Check cabin"),
    ];
    const w = saveWorkOrder(s, command, now);
    expect(() => saveWorkOrder(s, command, now)).toThrow("changed");
    expect(
      saveWorkOrder(
        structuredClone(s),
        { ...command, version: 1, tasks: [] },
        now,
      ).tasks,
    ).toEqual([]);
    expect(() =>
      saveWorkOrder(
        s,
        {
          ...command,
          version: 1,
          fields: { ...command.fields, status: "completed" },
        },
        now,
      ),
    ).toThrow("Complete or cancel");
    const closed = saveWorkOrder(
      s,
      {
        ...command,
        version: 1,
        tasks: command.tasks.map((t) => ({ ...t, status: "completed" })),
        fields: {
          ...command.fields,
          status: "completed",
          completionDate: "2026-10-01",
          releaseOutcome: "Released",
          finalReview: "",
        },
      },
      now,
    );
    expect(closed.status).toBe("completed");
    expect(() => saveWorkOrder(s, { ...command, version: 2 }, now)).toThrow(
      "closed",
    );
    s.aircraft[0].programUuid = "other";
    expect(scopedSnapshot(s).workOrders).toEqual([]);
    expect(() => saveWorkOrder(s, workOrderCommand(), now)).toThrow(
      "access denied",
    );
  });
  it("rejects components from other aircraft, duplicate numbers and invalid completion dates", () => {
    const s = demoSnapshot(),
      command = workOrderCommand();
    expect(() =>
      saveWorkOrder(s, { ...command, componentUuids: ["unknown"] }, now),
    ).toThrow("installed");
    const w = saveWorkOrder(s, command, now);
    expect(() =>
      saveWorkOrder(
        s,
        {
          ...workOrderCommand(),
          fields: { ...command.fields, number: w.number },
        },
        now,
      ),
    ).toThrow("number already");
    expect(() =>
      saveWorkOrder(
        s,
        {
          ...command,
          version: 1,
          fields: { ...command.fields, completionDate: "2025-12-31" },
        },
        now,
      ),
    ).toThrow("Completion date");
    s.user.isAdmin = false;
    s.user.groupIds = [];
    expect(() => saveWorkOrder(s, { ...command, version: 1 }, now)).toThrow(
      "access denied",
    );
  });
  it("allows document attachments and rejects empty, oversized and active content files", () => {
    expect(() =>
      validateWorkOrderFile("record.pdf", "application/pdf", 100),
    ).not.toThrow();
    expect(() =>
      validateWorkOrderFile("record.html", "text/html", 100),
    ).toThrow();
    expect(() =>
      validateWorkOrderFile("record.pdf", "application/pdf", 0),
    ).toThrow();
    expect(() =>
      validateWorkOrderFile("record.pdf", "application/pdf", 11 * 1024 * 1024),
    ).toThrow();
    // Action arguments are capped near 8 MiB, so 8 MB files must fail early.
    expect(() =>
      validateWorkOrderFile("record.pdf", "application/pdf", 7 * 1024 * 1024),
    ).not.toThrow();
    expect(() =>
      validateWorkOrderFile("record.pdf", "application/pdf", 8 * 1024 * 1024),
    ).toThrow("7 MB");
  });
});
