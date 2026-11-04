/**
 * Responsibility: Pins copying task-card templates into job cards and the
 *   job-card checks on completing a work item.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/workOrderCards.ts, taskCards.ts, workOrders.ts,
 *   src/data/demo.ts and tests/fixtures (task cards, work orders).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  saveTaskCard,
  taskCardFieldsSchema,
  isTaskTemplate,
  type TaskCard,
} from "./taskCards";
import { saveWorkOrder, newWorkTask } from "./workOrders";
import {
  copyWorkOrderTemplates,
  taskCardMatchesWorkItem,
  workItemCompletionIssue,
} from "./workOrderCards";
const now = Date.parse("2026-10-02T12:00:00Z");
function setup() {
  const s = demoSnapshot(),
    cmd = taskCardCommand();
  cmd.fields.inspectionUuid = s.inspections[0].uuid;
  const template = saveTaskCard(s, cmd, now);
  return { s, template };
}
it("copies reusable tasks into separate work orders and preserves source definitions", () => {
  const { s, template } = setup();
  const source = { kind: "inspection" as const, uuid: template.inspectionUuid };
  const first = workOrderCommand();
  first.tasks = [newWorkTask(source, "Inspection")];
  const one = saveWorkOrder(s, first, now);
  const two = saveWorkOrder(
    s,
    { ...workOrderCommand(), tasks: [newWorkTask(source, "Inspection")] },
    now,
  );
  const copies = s.taskCards!.filter((t) => t.workOrderUuid);
  expect(copies).toHaveLength(2);
  expect(copies[0].uuid).not.toBe(copies[1].uuid);
  expect(new Set(s.taskCards!.map((t) => t.cardNumber)).size).toBe(3);
  for (const card of copies) {
    expect(card).toMatchObject({
      sourceTaskCardUuid: template.uuid,
      sourceTaskCardVersion: template.version,
      status: "draft",
      technicianSignoff: null,
      inspectionSignoff: null,
      findings: "",
      actualLabor: null,
    });
    expect(card.steps[0].uuid).not.toBe(template.steps[0].uuid);
    expect(isTaskTemplate(card)).toBe(false);
  }
  expect(s.taskCards!.find((t) => t.uuid === template.uuid)).toEqual(template);
  saveTaskCard(
    s,
    {
      action: "save",
      uuid: template.uuid,
      version: template.version,
      fields: {
        ...taskCardFieldsSchema.parse(template),
        title: "Revised template",
      },
    },
    now,
  );
  expect(
    s
      .taskCards!.filter((t) => t.workOrderUuid)
      .every((t) => t.title === template.title),
  ).toBe(true);
  saveWorkOrder(s, { ...first, version: one.version, tasks: one.tasks }, now);
  expect(s.taskCards!.filter((t) => t.workOrderUuid)).toHaveLength(2);
  expect(two.uuid).not.toBe(one.uuid);
});
it("resets legacy execution and signatures, blocks template execution and in-place linking", () => {
  const { s, template } = setup();
  const legacy = {
    ...template,
    status: "completed" as const,
    findings: "old result",
    actualWork: "old work",
    actualLabor: 3,
    completionDate: "2026-01-02",
    technicianSignoff: { userId: s.user.id, name: s.user.name, at: now },
    inspectionSignoff: { userId: s.user.id, name: s.user.name, at: now },
    steps: template.steps.map((x) => ({
      ...x,
      result: "old",
      measurement: 11,
    })),
    stepSignoffs: {
      [template.steps[0].uuid]: {
        userId: s.user.id,
        name: s.user.name,
        at: now,
      },
    },
  };
  s.taskCards = [legacy];
  const cmd = workOrderCommand();
  cmd.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: template.inspectionUuid },
      "Inspect",
    ),
  ];
  saveWorkOrder(s, cmd, now);
  const copy = s.taskCards!.find((t) => t.workOrderUuid)!;
  expect(copy.steps[0]).toMatchObject({ result: "", measurement: null });
  expect(copy.stepSignoffs).toEqual({});
  expect(copy.technicianSignoff).toBeNull();
  expect(s.taskCards!.find((t) => t.uuid === template.uuid)).toEqual(legacy);
  const fresh = setup();
  const fields = taskCardFieldsSchema.parse(fresh.template);
  expect(() =>
    saveTaskCard(
      fresh.s,
      {
        action: "save",
        uuid: fresh.template.uuid,
        version: 1,
        fields: { ...fields, actualWork: "Performed" },
      },
      now,
    ),
  ).toThrow("instructions only");
  expect(() =>
    saveTaskCard(
      fresh.s,
      {
        action: "sign",
        uuid: fresh.template.uuid,
        version: 1,
        kind: "technician",
      },
      now,
    ),
  ).toThrow("reusable template");
  const w = saveWorkOrder(fresh.s, workOrderCommand(), now);
  expect(() =>
    saveTaskCard(
      fresh.s,
      {
        action: "link",
        uuid: fresh.template.uuid,
        version: 1,
        link: { kind: "workOrder", uuid: w.uuid },
      },
      now,
    ),
  ).toThrow("independent job card");
});
it("blocks item completion until every copy is completed and signed, independent of other orders", () => {
  const { s, template } = setup();
  const cmd = workOrderCommand();
  cmd.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: template.inspectionUuid },
      "Inspection",
    ),
  ];
  const w = saveWorkOrder(s, cmd, now);
  const other = saveWorkOrder(
    s,
    {
      ...workOrderCommand(),
      tasks: [
        newWorkTask(
          { kind: "inspection", uuid: template.inspectionUuid },
          "Inspection",
        ),
      ],
    },
    now,
  );
  const done = {
    ...cmd,
    version: w.version,
    tasks: w.tasks.map((t) => ({ ...t, status: "completed" as const })),
  };
  const before = structuredClone(s);
  expect(() => saveWorkOrder(s, done, now)).toThrow("sign off every");
  expect(s).toEqual(before);
  let card = s.taskCards!.find((t) => t.workOrderUuid === w.uuid)!;
  card = saveTaskCard(
    s,
    {
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: {
        ...taskCardFieldsSchema.parse(card),
        status: "ready",
        actualWork: "Inspected",
        completionDate: "2026-10-02",
        steps: card.steps.map((x) => ({
          ...x,
          result: "Pass",
          measurement: 11,
        })),
      },
    },
    now,
  );
  card = saveTaskCard(
    s,
    {
      action: "sign",
      uuid: card.uuid,
      version: card.version,
      kind: "technician",
    },
    now,
  );
  card = saveTaskCard(
    s,
    {
      action: "save",
      uuid: card.uuid,
      version: card.version,
      fields: { ...taskCardFieldsSchema.parse(card), status: "completed" },
    },
    now,
  );
  expect(saveWorkOrder(s, done, now).tasks[0].status).toBe("completed");
  expect(() =>
    saveWorkOrder(
      s,
      {
        ...cmd,
        uuid: other.uuid,
        version: other.version,
        tasks: other.tasks.map((t) => ({ ...t, status: "completed" as const })),
      },
      now,
    ),
  ).toThrow("sign off every");
  expect(card.sourceTaskCardUuid).toBe(template.uuid);
});
it("copies component-service templates without carrying retired prerequisite requirements", () => {
  const { s, template } = setup();
  const c = workOrderComponent();
  s.management = [
    c,
    {
      kind: "componentRequirement",
      uuid: "service",
      version: 1,
      aircraftUuid: c.aircraftUuid,
      componentUuid: c.uuid,
      requirementType: "Inspection Requirement",
      description: "Engine service",
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
  const cmd = taskCardCommand();
  cmd.fields.componentUuid = c.uuid;
  cmd.fields.requirementUuid = "service";
  cmd.fields.prerequisiteUuids = [template.uuid];
  const service = saveTaskCard(s, cmd, now);
  const wcmd = workOrderCommand();
  wcmd.tasks = [
    newWorkTask({ kind: "componentRequirement", uuid: "service" }, "Service"),
  ];
  wcmd.tasks.push(
    newWorkTask(
      { kind: "inspection", uuid: template.inspectionUuid },
      "Inspection",
    ),
  );
  const w = saveWorkOrder(s, wcmd, now);
  const cards = s.taskCards!.filter((t) => t.workOrderUuid === w.uuid);
  expect(cards).toHaveLength(2);
  expect(
    cards.find((t) => t.sourceTaskCardUuid === service.uuid)!.prerequisiteUuids,
  ).toEqual([]);
});
it("backfills old orders only on request and never rewrites existing copies", () => {
  const { s, template } = setup();
  const cmd = workOrderCommand();
  const w = saveWorkOrder(s, cmd, now);
  const legacy = {
    ...w,
    tasks: [
      newWorkTask(
        { kind: "inspection", uuid: template.inspectionUuid },
        "Inspection",
      ),
    ],
  };
  s.workOrders = [legacy];
  const updated = saveWorkOrder(
    s,
    { action: "copyTemplates", uuid: w.uuid, version: w.version },
    now,
  );
  const before = s.taskCards!.find((t) => t.workOrderUuid === w.uuid)!;
  saveWorkOrder(
    s,
    { action: "copyTemplates", uuid: w.uuid, version: updated.version },
    now,
  );
  expect(s.taskCards!.filter((t) => t.workOrderUuid === w.uuid)).toEqual([
    before,
  ]);
});
it("does not hold a work item for a legacy required step that was never signed", () => {
  const { s, template } = setup();
  const cmd = workOrderCommand();
  cmd.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: template.inspectionUuid },
      "Inspection",
    ),
  ];
  const w = saveWorkOrder(s, cmd, now);
  const card = s.taskCards!.find((t) => t.workOrderUuid === w.uuid)!;
  const signature = { userId: s.user.id, name: s.user.name, at: now };
  // Stored before steps were retired: a required step without a signoff.
  const legacy: TaskCard = {
    ...card,
    status: "completed",
    completionDate: "2026-10-02",
    technicianSignoff: signature,
    steps: card.steps.map((x) => ({
      ...x,
      result: "Pass",
      measurement: 11,
      signoffRequired: true,
    })),
  };
  s.taskCards = s.taskCards!.map((t) => (t.uuid === card.uuid ? legacy : t));
  expect(workItemCompletionIssue(s, w.uuid, w.tasks[0])).toBe("");
});
it("copies legacy template steps as readable details, not signoff points", () => {
  const { s, template } = setup();
  expect(template.steps[0].signoffRequired).toBe(true);
  const cmd = workOrderCommand();
  cmd.tasks = [
    newWorkTask(
      { kind: "inspection", uuid: template.inspectionUuid },
      "Inspection",
    ),
  ];
  const w = saveWorkOrder(s, cmd, now);
  const card = s.taskCards!.find((t) => t.workOrderUuid === w.uuid)!;
  expect(card.steps).toEqual([
    {
      ...template.steps[0],
      uuid: card.steps[0].uuid,
      signoffRequired: false,
    },
  ]);
  // The template itself keeps its stored step data.
  expect(s.taskCards!.find((t) => t.uuid === template.uuid)!.steps).toEqual(
    template.steps,
  );
});

describe("job cards for one work order", () => {
  const inspectionItem = (inspectionUuid?: string) =>
    newWorkTask({ kind: "inspection", uuid: inspectionUuid! }, "Inspection");

  it("copies a template once per order, for new uncancelled items, auditing each copy", () => {
    const { s, template } = setup();
    const w = saveWorkOrder(s, workOrderCommand(), now);
    const item = inspectionItem(template.inspectionUuid);
    const order = { ...w, tasks: [item] };
    const cancelled = { ...item, status: "cancelled" as const };
    expect(
      copyWorkOrderTemplates(s, { ...w, tasks: [cancelled] }, undefined, now),
    ).toBe(0);
    expect(copyWorkOrderTemplates(s, order, order, now)).toBe(0);
    expect(copyWorkOrderTemplates(s, order, undefined, now)).toBe(1);
    expect(copyWorkOrderTemplates(s, order, undefined, now)).toBe(0);
    const copy = s.taskCards!.find((t) => t.workOrderUuid === w.uuid)!;
    expect(copy.workTaskUuid).toBe(item.uuid);
    expect(s.audit[0]).toMatchObject({
      action: "taskCard.created_from_template",
      entityUuid: copy.uuid,
      aircraftUuid: w.aircraftUuid,
      reason: `Copied ${template.cardNumber} version ${template.version} to ${w.number}.`,
    });
    expect(JSON.parse(s.audit[0].after!)).toEqual(copy);
  });

  it("explains in order why an item cannot be completed yet", () => {
    const { s, template } = setup();
    const w = saveWorkOrder(s, workOrderCommand(), now);
    const item = inspectionItem(template.inspectionUuid);
    expect(workItemCompletionIssue(s, w.uuid, item)).toBe(
      "Add the associated job card templates to this work order before completing this item.",
    );
    const preparing = { jobId: "job", status: "running" as const };
    s.workOrders = s.workOrders!.map((o) => ({
      ...o,
      templateCopy: { ...preparing, completed: 0, total: 1 },
    }));
    expect(workItemCompletionIssue(s, w.uuid, item)).toBe(
      "Finish preparing the job cards before completing this item.",
    );
    s.workOrders = s.workOrders!.map((o) => ({
      ...o,
      templateCopy: undefined,
    }));
    copyWorkOrderTemplates(s, { ...w, tasks: [item] }, undefined, now);
    const signOff =
      "Complete and sign off every job card for this item on this work order before marking it completed.";
    expect(workItemCompletionIssue(s, w.uuid, item)).toBe(signOff);
    const signature = { userId: s.user.id, name: s.user.name, at: now };
    const finish = (fields: Partial<TaskCard>) => {
      s.taskCards = s.taskCards!.map((t) =>
        t.workOrderUuid === w.uuid
          ? { ...t, status: "completed" as const, ...fields }
          : t,
      );
      return workItemCompletionIssue(s, w.uuid, item);
    };
    expect(finish({ technicianSignoff: null })).toBe(signOff);
    expect(
      finish({
        technicianSignoff: signature,
        inspectionSignoffRequired: true,
        inspectionSignoff: null,
      }),
    ).toBe(signOff);
    expect(finish({ inspectionSignoff: signature })).toBe("");
    expect(workItemCompletionIssue(s, w.uuid, inspectionItem("none"))).toBe("");
  });

  it("matches a card to an item it was copied for or that names its source", () => {
    const { template } = setup();
    const discrepancy = newWorkTask({ kind: "discrepancy", uuid: "d" }, "Fix");
    const requirement = newWorkTask(
      { kind: "componentRequirement", uuid: "r" },
      "Service",
    );
    const card = { ...template, discrepancyUuid: "d", requirementUuid: "r" };
    expect(taskCardMatchesWorkItem(card, discrepancy)).toBe(true);
    expect(taskCardMatchesWorkItem(card, requirement)).toBe(true);
    expect(taskCardMatchesWorkItem(template, discrepancy)).toBe(false);
    expect(
      taskCardMatchesWorkItem(
        { ...template, workTaskUuid: discrepancy.uuid },
        discrepancy,
      ),
    ).toBe(true);
    const airworthiness = newWorkTask(
      { kind: "airworthiness", uuid: template.inspectionUuid! },
      "AD",
    );
    expect(taskCardMatchesWorkItem(template, airworthiness)).toBe(false);
  });
});
