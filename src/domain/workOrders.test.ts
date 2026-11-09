/**
 * Responsibility: Pins work orders in the domain: saving, adding work items,
 *   which orders take an item, counts, field limits, access and attachment
 *   rules, and every refusal's message and class.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrders.ts, ./model, ./programs, ./rejection,
 *   ./taskCards, ./workOrderComponentWork (types), tests/fixtures (work
 *   orders, task cards), src/data/demo.ts (seed).
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  addInspectionTask,
  isPreparingJobCards,
  saveWorkOrder,
  newWorkTask,
  unusedWorkSources,
  workOrderCounts,
  workOrderFieldsSchema,
  workOrdersTaking,
  workSources,
  workOrderProgress,
  validateWorkOrderFile,
  WORK_ORDER_NUMBER_MAX_LENGTH,
  WORK_ORDER_TEXT_MAX_LENGTH,
  type WorkOrder,
  type WorkOrderCommand,
} from "./workOrders";
import type { ComponentWork } from "./workOrderComponentWork";
import { saveTaskCard } from "./taskCards";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import { totalSeconds, type Snapshot } from "./model";
import { scopedSnapshot } from "./programs";
import { Rejection, STALE_RECORD_MESSAGE } from "./rejection";
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
    saveWorkOrder(s, command, now);
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
  it("adds an inspection as a requested task without changing the order", () => {
    const s = demoSnapshot();
    const order = saveWorkOrder(s, workOrderCommand(), now);
    const inspection = s.inspections.find(
      (i) => i.aircraftUuid === order.aircraftUuid,
    )!;
    const added = addInspectionTask(order, inspection);
    expect(order.tasks).toEqual([]);
    expect(added.tasks).toEqual([
      expect.objectContaining({
        source: { kind: "inspection", uuid: inspection.uuid },
        description: `${inspection.reference}: ${inspection.description}`,
        status: "requested",
      }),
    ]);
    // Characterizes current behaviour: a second task for the same inspection
    // is refused by saveWorkOrder, not here.
    expect(addInspectionTask(added, inspection).tasks).toHaveLength(2);
  });
  it("refuses a missing, archived or other aircraft's inspection as a Rejection", () => {
    const s = demoSnapshot();
    const order = saveWorkOrder(s, workOrderCommand(), now);
    const inspection = s.inspections.find(
      (i) => i.aircraftUuid === order.aircraftUuid,
    )!;
    for (const unavailable of [
      undefined,
      { ...inspection, archived: true },
      { ...inspection, aircraftUuid: "other-aircraft" },
    ]) {
      const refusal = () => addInspectionTask(order, unavailable);
      expect(refusal).toThrow(Rejection);
      expect(refusal).toThrow("Work item is unavailable for this aircraft.");
    }
  });
});

describe("which orders take an item", () => {
  const preparing = (status: "running" | "failed" | "completed") => ({
    jobId: "job",
    status,
    completed: 0,
    total: 1,
  });
  function setup() {
    const s = demoSnapshot();
    const order = saveWorkOrder(s, workOrderCommand(), now);
    const [offered] = workSources(s, order.aircraftUuid);
    const holding = {
      ...order,
      uuid: "holding",
      tasks: [newWorkTask(offered.source, "x")],
    };
    return { s, order, offered, holding };
  }

  it("is preparing job cards while a template copy runs or has failed", () => {
    const { order } = setup();
    expect(isPreparingJobCards(order)).toBe(false);
    expect(
      (["running", "failed", "completed"] as const).map((status) =>
        isPreparingJobCards({ ...order, templateCopy: preparing(status) }),
      ),
    ).toEqual([true, true, false]);
  });

  it("offers the aircraft's open, prepared orders without the item, in record order", () => {
    const { s, order, offered, holding } = setup();
    const other = s.aircraft[1].uuid;
    const orders: WorkOrder[] = [
      { ...order, uuid: "ready", templateCopy: preparing("completed") },
      { ...order, uuid: "running", templateCopy: preparing("running") },
      { ...order, uuid: "failed", templateCopy: preparing("failed") },
      { ...order, uuid: "done", status: "completed" },
      { ...order, uuid: "cancelled", status: "cancelled" },
      { ...order, uuid: "elsewhere", aircraftUuid: other },
      holding,
      { ...order, uuid: "busy", status: "parts-delay" },
      {
        ...order,
        uuid: "same-uuid",
        tasks: [
          newWorkTask({ kind: "manual", uuid: offered.source.uuid }, "x"),
        ],
      },
    ];
    s.workOrders = orders;
    expect(
      workOrdersTaking(s, order.aircraftUuid, offered.source).map(
        (w) => w.uuid,
      ),
    ).toEqual(["ready", "busy", "same-uuid"]);
  });

  it("leaves out the items an order already holds, keeping the offered order", () => {
    const { s, order } = setup();
    s.discrepancies.push({
      uuid: "defect",
      aircraftUuid: order.aircraftUuid,
      description: "Oil leak",
      status: "open",
      authorId: s.user.id,
      createdAt: now,
    });
    const all = workSources(s, order.aircraftUuid);
    const held = [newWorkTask(all[1].source, "x")];
    expect(all.length).toBeGreaterThan(2);
    expect(unusedWorkSources(s, order.aircraftUuid, held)).toEqual([
      all[0],
      ...all.slice(2),
    ]);
    expect(unusedWorkSources(s, order.aircraftUuid, [])).toEqual(all);
  });
});

describe("work order counts and limits", () => {
  it("counts open and in-progress orders, and orders completed this month", () => {
    const order = saveWorkOrder(demoSnapshot(), workOrderCommand(), now);
    const closed = (status: "completed" | "cancelled", date: string) => ({
      ...order,
      status,
      completionDate: date,
    });
    const orders: WorkOrder[] = [
      order,
      { ...order, status: "in-progress" },
      closed("completed", "2026-10-01"),
      closed("completed", "2026-10-31"),
      closed("completed", "2026-09-30"),
      closed("cancelled", "2026-10-02"),
    ];
    expect(workOrderCounts(orders, "2026-10-15")).toEqual({
      open: 2,
      inProgress: 1,
      closedThisMonth: 2,
    });
  });

  it("limits the number and free text a work order holds", () => {
    const { fields } = workOrderCommand();
    const parses = (over: Partial<typeof fields>) =>
      workOrderFieldsSchema.safeParse({ ...fields, ...over }).success;
    const longest = (n: number) => "x".repeat(n);
    expect([WORK_ORDER_NUMBER_MAX_LENGTH, WORK_ORDER_TEXT_MAX_LENGTH]).toEqual([
      100, 10_000,
    ]);
    expect(parses({ number: longest(WORK_ORDER_NUMBER_MAX_LENGTH) })).toBe(
      true,
    );
    expect(parses({ number: longest(WORK_ORDER_NUMBER_MAX_LENGTH + 1) })).toBe(
      false,
    );
    expect(parses({ supervisor: longest(WORK_ORDER_TEXT_MAX_LENGTH) })).toBe(
      true,
    );
    expect(
      parses({ supervisor: longest(WORK_ORDER_TEXT_MAX_LENGTH + 1) }),
    ).toBe(false);
  });
});

describe("saveWorkOrder refusals", () => {
  // Each refusal is a Rejection, so users see it, and leaves the snapshot as
  // it was.
  function refusal(s: Snapshot, command: WorkOrderCommand) {
    const before = structuredClone(s);
    try {
      saveWorkOrder(s, command, now);
    } catch (error) {
      expect(s).toEqual(before);
      expect(error).toBeInstanceOf(Rejection);
      return error as Error;
    }
    throw new Error("Expected a refusal.");
  }

  // An open order on the first aircraft with one manual task, and the engine.
  function opened() {
    const s = demoSnapshot();
    s.management = [workOrderComponent()];
    const command = workOrderCommand();
    const manual = newWorkTask({ kind: "manual", uuid: "manual" }, "Check");
    command.tasks = [manual];
    const order = saveWorkOrder(s, command, now);
    return { s, command: { ...command, version: order.version }, manual };
  }

  function closed() {
    const { s, command, manual } = opened();
    const order = saveWorkOrder(
      s,
      {
        ...command,
        tasks: [{ ...manual, status: "completed" }],
        fields: {
          ...command.fields,
          status: "completed",
          completionDate: "2026-10-01",
          releaseOutcome: "Released",
        },
      },
      now,
    );
    const revision = {
      action: "revise" as const,
      uuid: order.uuid,
      version: order.version,
      reason: "Correct the record",
      fields: {
        supervisor: order.supervisor,
        scope: order.scope,
        releaseOutcome: order.releaseOutcome,
        finalReview: order.finalReview,
        workPerformed: order.closeout!.workPerformed,
      },
    };
    return { s, command: { ...command, version: order.version }, revision };
  }

  function move(fields: Partial<ComponentWork>) {
    const { s, command, manual } = opened();
    const work: ComponentWork = {
      componentUuid: "engine",
      version: 0,
      action: "remove",
      taskUuid: manual.uuid,
      partsLocation: "Shelf",
      description: "Move",
      reference: "",
      ...fields,
    };
    return { s, command: { ...command, componentWork: [work] } };
  }

  it("refuses a new order the user cannot open", () => {
    const fresh = () => ({ s: demoSnapshot(), command: workOrderCommand() });
    const cases: [string, ReturnType<typeof fresh>][] = [];
    const denied = fresh();
    denied.s.user.isAdmin = false;
    cases.push(["Work order maintenance access denied.", denied]);
    const future = fresh();
    future.command.fields.dateOpened = "2026-12-01";
    cases.push(["Date opened cannot be in the future.", future]);
    const early = fresh();
    early.command.fields.completionDate = "2025-12-31";
    cases.push(["Completion date must be between opening and today.", early]);
    const started = fresh();
    started.command.fields.status = "in-progress";
    cases.push(["New work orders must start open.", started]);
    const unlisted = fresh();
    unlisted.command.componentUuids = ["unknown"];
    cases.push([
      "Header components must be installed on this aircraft.",
      unlisted,
    ]);
    const foreign = fresh();
    foreign.command.tasks = [
      newWorkTask({ kind: "discrepancy", uuid: "unknown" }, "Leak"),
    ];
    cases.push(["Work item is unavailable for this aircraft.", foreign]);
    const twice = fresh();
    twice.command.tasks = [
      newWorkTask({ kind: "manual", uuid: "same" }, "One"),
      newWorkTask({ kind: "manual", uuid: "same" }, "Two"),
    ];
    cases.push(["This item is already on the work order.", twice]);
    for (const [message, { s, command }] of cases)
      expect(refusal(s, command).message).toBe(message);
  });

  it("refuses a stale, moved, duplicate or unfinished change to an order", () => {
    const { s, command, manual } = opened();
    const other = s.aircraft[1].uuid;
    const refused = (change: WorkOrderCommand) => refusal(s, change).message;
    expect(refused({ ...command, version: 0 })).toBe(STALE_RECORD_MESSAGE);
    expect(
      refused({
        ...command,
        fields: { ...command.fields, aircraftUuid: other },
      }),
    ).toBe("A work order cannot change aircraft.");
    expect(
      refused({
        ...workOrderCommand(),
        fields: { ...command.fields, number: "WO-2026-0001" },
      }),
    ).toBe("Work order number already exists in this program.");
    expect(
      refused({
        ...command,
        tasks: [{ ...manual, source: { kind: "manual", uuid: "other" } }],
      }),
    ).toBe("A task cannot change its source.");
    expect(
      refused({
        ...command,
        fields: { ...command.fields, status: "completed" },
      }),
    ).toBe(
      "Complete or cancel every task and enter a completion date and release outcome before closing.",
    );
    expect(
      refused({
        action: "add",
        uuid: command.uuid,
        version: command.version,
        source: { kind: "discrepancy", uuid: "unknown" },
      }),
    ).toBe("Work item is unavailable for this aircraft.");
    expect(
      refused({
        action: "revise",
        uuid: command.uuid,
        version: command.version,
        reason: "Correct",
        fields: {
          supervisor: "",
          scope: "",
          releaseOutcome: "",
          finalReview: "",
          workPerformed: "",
        },
      }),
    ).toBe(
      "Only closed work orders can be revised. Edit open orders normally.",
    );
    s.workOrders![0].templateCopy = {
      jobId: "job",
      status: "running",
      completed: 0,
      total: 1,
    };
    expect(refused(command)).toBe(
      "Job cards are still being prepared. Finish or resume preparation before editing or closing this work order.",
    );
  });

  // Characterizes current behaviour: a command other than a save takes its
  // aircraft from the order, so one naming an order the snapshot lacks is
  // refused for access before "Work order not found." could be reached.
  it("refuses a command for an order it does not hold as access denied", () => {
    const s = demoSnapshot();
    const uuid = crypto.randomUUID();
    for (const command of [
      { action: "copyTemplates", uuid, version: 0 },
      {
        action: "add",
        uuid,
        version: 0,
        source: { kind: "manual", uuid: "manual" },
      },
    ] as WorkOrderCommand[])
      expect(refusal(s, command).message).toBe(
        "Work order maintenance access denied.",
      );
  });

  it("refuses closing over open job cards or completing an unsigned item", () => {
    const s = demoSnapshot();
    const card = taskCardCommand();
    card.fields.inspectionUuid = s.inspections[0].uuid;
    saveTaskCard(s, card, now);
    const command = workOrderCommand();
    const item = newWorkTask(
      { kind: "inspection", uuid: s.inspections[0].uuid },
      "Inspection",
    );
    command.tasks = [item];
    const order = saveWorkOrder(s, command, now);
    const saved = { ...command, version: order.version };
    expect(
      refusal(s, { ...saved, fields: { ...saved.fields, status: "cancelled" } })
        .message,
    ).toBe(
      "Complete or cancel linked job cards before closing the work order.",
    );
    expect(
      refusal(s, { ...saved, tasks: [{ ...item, status: "completed" }] })
        .message,
    ).toBe(
      "Complete and sign off every job card for this item on this work order before marking it completed.",
    );
  });

  it("refuses a change to a closed order and an empty revision", () => {
    const { s, command, revision } = closed();
    expect(refusal(s, command).message).toBe("This work order is closed.");
    expect(refusal(s, revision).message).toBe(
      "Change at least one field before saving a revision.",
    );
    expect(
      refusal(s, {
        ...revision,
        fields: { ...revision.fields, releaseOutcome: "" },
      }).message,
    ).toBe("A completed work order requires a release statement.");
  });

  it("refuses a component movement it cannot record", () => {
    const cases: [string, ReturnType<typeof move>][] = [
      [
        "A component movement requires its own work order task.",
        move({ taskUuid: undefined }),
      ],
      ["Component maintenance access denied.", move({ componentUuid: "x" })],
      [STALE_RECORD_MESSAGE, move({ version: 5 })],
      [
        "Component is unavailable for this aircraft movement.",
        move({ action: "install", installPosition: "LEFT" }),
      ],
      ["Select the removal inventory location.", move({ partsLocation: " " })],
    ];
    const twice = move({ action: "service" });
    twice.command.componentWork!.push(twice.command.componentWork![0]);
    cases.push(["A component can only have one action per work order.", twice]);
    const attached = move({});
    Object.assign(attached.s.management![0], { parentComponentUuid: "p" });
    cases.push([
      "Move the parent component; its attached parts move with it.",
      attached,
    ]);
    const unplaced = move({ action: "install" });
    Object.assign(unplaced.s.management![0], { installed: false });
    cases.push(["Select an installation position.", unplaced]);
    for (const [message, { s, command }] of cases)
      expect(refusal(s, command).message).toBe(message);
  });
});
