/**
 * Responsibility: Pins recurring parts lists: one occurrence per open task
 *   and list, numbering, change log, the lists' own rules, the applier
 *   serving open work orders, and which sources a server loads for them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/partsRequests.ts (the rules), airworthiness.ts,
 *   workOrders.ts, partsPlanning.ts, model.ts,
 *   src/components/PartsRequests.tsx; src/data/demo.ts and
 *   tests/fixtures/workOrders.ts (fixtures).
 */
import { it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { localDate } from "./model";
import { blankAD, blankADTask } from "./airworthiness";
import {
  applyRequestCommand,
  generateRecurringRequests,
  recurringPartsNeeds,
  requestDraftSchema,
  recurringRequestSource,
  requestStatus,
  type PartsRequest,
  type RequestSource,
} from "./partsRequests";
import { saveWorkOrder, newWorkTask } from "./workOrders";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { requestedParts, maintenancePartsPlans } from "./partsPlanning";
import { requestPODraft } from "../components/PartsRequests";

// An applicable AD with one recurring 100-hour task.
function recurringAD(aircraftUuid: string) {
  const ad = blankAD(aircraftUuid);
  ad.source.number = "2026-01-01";
  ad.applicability = "Applicable";
  ad.reviewRequired = false;
  const task = {
    ...blankADTask(),
    description: "Recurring inspection",
    recurrence: "Recurring" as const,
    intervalHours: 100,
  };
  ad.tasks = [task];
  return { ad, task };
}

// A recurring list of two filters for one source.
function recurringDraft(source: RequestSource) {
  return requestDraftSchema.parse({
    uuid: "template",
    version: 0,
    source,
    recurring: true,
    mode: "parts",
    date: "2026-10-20",
    engineer: "Tech",
    priority: "P2 Routine",
    requiredBy: "",
    currency: "USD",
    lines: [
      {
        uuid: "filter",
        partNumber: "FILTER",
        description: "Filter",
        quantity: 2,
      },
    ],
  });
}

function fixture() {
  const s = demoSnapshot();
  s.user.isAdmin = true;
  const { ad, task } = recurringAD(s.aircraft[0].uuid);
  s.airworthiness = [ad];
  const source = {
    kind: "airworthiness" as const,
    uuid: task.uuid,
    workOrderUuid: "",
  };
  const draft = recurringDraft(source);
  const template = applyRequestCommand(s, {
    kind: "save",
    requestUuid: "create",
    draft,
  });
  const command = workOrderCommand();
  command.tasks = [
    newWorkTask({ kind: "airworthiness", uuid: task.uuid }, task.description),
  ];
  const order = saveWorkOrder(s, command);
  return { s, ad, task, source, draft, template, order, command };
}
it("creates separate AD occurrence requests, keeps fulfilled history, and never duplicates a retried or cancelled occurrence", () => {
  const { s, order, template, command } = fixture();
  const [first] = generateRecurringRequests(s, order);
  expect(first).toMatchObject({
    templateUuid: template.uuid,
    recurring: false,
    source: { kind: "workTask", workOrderUuid: order.uuid },
  });
  expect(generateRecurringRequests(s, order)).toEqual([]);
  first.issues.push({
    lineUuid: "filter",
    stockUuid: "stock",
    quantity: 2,
    at: Date.now(),
    actorId: s.user.id,
  });
  expect(requestStatus(s, first)).toBe("Fulfilled");
  order.status = "completed";
  const next = saveWorkOrder(s, {
    ...command,
    uuid: crypto.randomUUID(),
    tasks: [newWorkTask(command.tasks[0].source, "Next occurrence")],
  });
  const [second] = generateRecurringRequests(s, next);
  expect(second.issues).toEqual([]);
  expect(second.uuid).not.toBe(first.uuid);
  second.cancelled = true;
  expect(generateRecurringRequests(s, next)).toEqual([]);
  expect(first.issues).toHaveLength(1);
});
it("AD recurrence and ownership are validated and one-time AD requests remain supported", () => {
  const { s, task, source, draft, ad } = fixture();
  task.recurrence = "One-time" as typeof task.recurrence;
  expect(recurringRequestSource(s, source)).toBeUndefined();
  expect(() =>
    applyRequestCommand(s, {
      kind: "save",
      requestUuid: "bad",
      draft: { ...draft, uuid: "bad" },
    }),
  ).toThrow(/recurring/i);
  expect(
    applyRequestCommand(s, {
      kind: "save",
      requestUuid: "once",
      draft: { ...draft, uuid: "once", recurring: false },
    }).sourceLabel,
  ).toContain("AD 2026-01-01");
  ad.aircraftUuid = "foreign";
  expect(() =>
    applyRequestCommand(s, {
      kind: "save",
      requestUuid: "foreign",
      draft: { ...draft, uuid: "foreign", recurring: false },
    }),
  ).toThrow(/Flight Program/);
});
it("recurring lists cannot reserve stock or become purchase orders", () => {
  const { s, template } = fixture();
  expect(() =>
    applyRequestCommand(s, {
      kind: "reserve",
      requestUuid: "reserve",
      uuid: template.uuid,
      version: template.version,
      lineUuid: "filter",
      stockUuid: "stock",
      quantity: 1,
      alternateConfirmed: false,
    }),
  ).toThrow(/occurrence/);
  expect(() => requestPODraft(s, [template.uuid])).toThrow(/occurrence/);
});
it("forecasts count the active occurrence once and credit its reserved and issued parts", () => {
  const { s, source, order } = fixture();
  expect(requestedParts(s, source)?.[0].quantity).toBe(2);
  const [r] = generateRecurringRequests(s, order);
  expect(requestedParts(s, source)?.map((p) => p.quantity)).toEqual([2]);
  r.reservations.push({ lineUuid: "filter", stockUuid: "stock", quantity: 1 });
  r.issues.push({
    lineUuid: "filter",
    stockUuid: "stock",
    quantity: 1,
    actorId: s.user.id,
    at: Date.now(),
  });
  expect(requestedParts(s, source)).toEqual([]);
  order.status = "completed";
  expect(requestedParts(s, source)?.[0].quantity).toBe(2);
  expect(maintenancePartsPlans(s).some((p) => p.uuid === source.uuid)).toBe(
    true,
  );
});
it("template edits leave existing occurrences unchanged and apply to the next occurrence", () => {
  const { s, template, order, draft, command } = fixture();
  const [first] = generateRecurringRequests(s, order);
  applyRequestCommand(s, {
    kind: "save",
    requestUuid: "edit",
    draft: {
      ...draft,
      version: template.version,
      lines: draft.lines.map((l) => ({ ...l, quantity: 4 })),
    },
  });
  expect(generateRecurringRequests(s, order)).toEqual([]);
  const secondOrder = saveWorkOrder(s, {
    ...command,
    uuid: crypto.randomUUID(),
    tasks: [newWorkTask(command.tasks[0].source, "Next")],
  });
  expect(generateRecurringRequests(s, secondOrder)[0].lines[0].quantity).toBe(
    4,
  );
  expect(first.lines[0].quantity).toBe(2);
});

it("stops generation after cancellation or terminating AD compliance and enforces maintenance permissions", () => {
  const { s, ad, task, source, order, draft } = fixture();
  ad.history.push({
    uuid: crypto.randomUUID(),
    taskUuid: task.uuid,
    date: "2026-10-20",
    hours: 2400,
    cycles: null,
    method: "Terminated",
    serviceBulletin: "",
    terminatedBy: "Terminating modification",
    workOrderUuid: "",
    mechanic: "Tech",
    certificate: "",
    evidence: "",
    recordedAt: Date.now(),
    recordedBy: s.user.id,
  });
  expect(recurringRequestSource(s, source)).toBeUndefined();
  expect(generateRecurringRequests(s, order)).toEqual([]);
  ad.history = [];
  s.partsRequests![0].cancelled = true;
  expect(generateRecurringRequests(s, order)).toEqual([]);
  s.user.isAdmin = false;
  s.user.groupIds = ["demo-pilots"];
  expect(() =>
    applyRequestCommand(s, {
      kind: "save",
      requestUuid: "unauthorized",
      draft: { ...draft, uuid: "unauthorized", recurring: false },
    }),
  ).toThrow(/Maintenance access/);
});

it("supports repeating component overhaul requirements on resettable counters without recurring life limits", () => {
  const { s } = fixture();
  s.management = [
    {
      kind: "componentRequirement",
      uuid: "service",
      version: 1,
      componentUuid: "engine",
      aircraftUuid: s.aircraft[0].uuid,
      requirementType: "Overhaul Requirement",
      description: "Overhaul",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      intervalSeconds: 360000,
      timeBasis: "TSO",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
    },
  ];
  const source = {
    kind: "componentRequirement" as const,
    uuid: "service",
    workOrderUuid: "",
  };
  expect(recurringRequestSource(s, source)).toEqual(source);
  const requirement = s.management[0];
  if (requirement.kind !== "componentRequirement") throw Error("Fixture");
  requirement.requirementType = "Life Limits";
  expect(recurringRequestSource(s, source)).toBeUndefined();
});

it("numbers, labels and logs one occurrence per open task of a list on this aircraft and program", () => {
  const { s, order, template } = fixture();
  const list = (uuid: string, patch: object) => ({
    ...template,
    uuid,
    ...patch,
  });
  s.partsRequests!.unshift(
    list("stale", { source: { ...template.source, uuid: "gone" } }),
  );
  s.partsRequests!.push(
    list("other-aircraft", { aircraftUuid: s.aircraft[1].uuid }),
    list("other-program", { programUuid: "other", number: "PR-00042" }),
  );
  const performing = order.tasks[0];
  order.tasks.push(
    { ...newWorkTask(performing.source, "Done"), status: "completed" },
    newWorkTask({ kind: "inspection", uuid: performing.source.uuid }, "Other"),
  );
  const audit = s.audit.length;
  const now = Date.parse("2026-11-03T12:00:00Z");
  const created = generateRecurringRequests(s, order, now);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    number: "PR-00002",
    sourceLabel: `${order.number}: ${performing.description}`,
    date: localDate(now),
    source: { uuid: performing.uuid },
  });
  expect(created[0].history[0].detail).toBe(
    `Created from ${template.number} for ${order.number}`,
  );
  expect(s.audit).toHaveLength(audit + 1);
  expect(s.audit[0]).toMatchObject({
    action: "partsRequest.recurring",
    entityUuid: created[0].uuid,
  });
});

it("serves the open work orders on its aircraft when a list is saved or resent, in one command", () => {
  const { s, order, template, draft, command } = fixture();
  const now = Date.parse("2026-11-03T12:00:00Z");
  const occurrences = () =>
    s.partsRequests!.filter((r) => r.templateUuid === template.uuid);
  const edit = {
    kind: "save" as const,
    requestUuid: "edit",
    draft: { ...draft, version: template.version },
  };
  applyRequestCommand(s, edit, now);
  expect(occurrences()).toEqual([
    expect.objectContaining({
      createdAt: now,
      source: {
        kind: "workTask",
        uuid: order.tasks[0].uuid,
        workOrderUuid: order.uuid,
      },
    }),
  ]);
  expect(s.audit.slice(0, 2).map((e) => e.action)).toEqual([
    "partsRequest.recurring",
    "partsRequest.save",
  ]);
  const owed = () =>
    saveWorkOrder(s, {
      ...command,
      uuid: crypto.randomUUID(),
      tasks: [newWorkTask(command.tasks[0].source, "Next")],
    });
  owed();
  applyRequestCommand(s, edit, now);
  expect(occurrences()).toHaveLength(2);
  applyRequestCommand(s, edit, now);
  expect(occurrences()).toHaveLength(2);
  owed();
  applyRequestCommand(s, {
    ...edit,
    requestUuid: "once",
    draft: { ...draft, uuid: "once", recurring: false },
  });
  const list = s.partsRequests!.find((r) => r.uuid === template.uuid)!;
  s.partsRequests!.push({ ...list, uuid: "second", history: [] });
  applyRequestCommand(s, {
    kind: "cancel",
    requestUuid: "cancel",
    uuid: list.uuid,
    version: list.version,
    reason: "Retired",
  });
  expect(s.partsRequests!.filter((r) => r.templateUuid)).toHaveLength(2);
});

it("gives a completed or cancelled work order no occurrences", () => {
  const { s, order } = fixture();
  for (const status of ["completed", "cancelled"] as const)
    expect(generateRecurringRequests(s, { ...order, status })).toEqual([]);
});

it("names the sources an order's owed occurrences need, once each, in task order", () => {
  const { s, order, template } = fixture();
  const list = (kind: RequestSource["kind"], uuid: string): PartsRequest => ({
    ...template,
    uuid: `${kind}-list`,
    source: { kind, uuid, workOrderUuid: "" },
  });
  const lists = [
    template,
    list("inspection", "inspection"),
    list("componentRequirement", "requirement"),
  ];
  const task = (kind: "inspection" | "componentRequirement", uuid: string) => ({
    ...order.tasks[0],
    uuid: crypto.randomUUID(),
    source: { kind, uuid },
  });
  const owing = {
    ...order,
    tasks: [
      task("componentRequirement", "requirement"),
      task("inspection", "inspection"),
      ...order.tasks,
      task("inspection", "inspection"),
      task("inspection", "unlisted"),
    ],
  };
  expect(recurringPartsNeeds(owing, lists)).toEqual({
    inspections: ["inspection"],
    requirements: ["requirement"],
    airworthiness: true,
  });
  const none = { inspections: [], requirements: [], airworthiness: false };
  for (const status of ["completed", "cancelled"] as const) {
    expect(recurringPartsNeeds({ ...owing, status }, lists)).toEqual(none);
    const finished = owing.tasks.map((t) => ({ ...t, status }));
    expect(recurringPartsNeeds({ ...owing, tasks: finished }, lists)).toEqual(
      none,
    );
  }
  const elsewhere = { aircraftUuid: s.aircraft[1].uuid };
  for (const change of [{ cancelled: true }, { recurring: false }, elsewhere])
    expect(
      recurringPartsNeeds(
        owing,
        lists.map((l) => ({ ...l, ...change })),
      ),
    ).toEqual(none);
});

it("needs nothing for a task its list has served, even if that was cancelled", () => {
  const { s, order } = fixture();
  expect(recurringPartsNeeds(order, s.partsRequests!).airworthiness).toBe(true);
  const [occurrence] = generateRecurringRequests(s, order);
  expect(recurringPartsNeeds(order, s.partsRequests!).airworthiness).toBe(
    false,
  );
  occurrence.cancelled = true;
  expect(recurringPartsNeeds(order, s.partsRequests!).airworthiness).toBe(
    false,
  );
});
