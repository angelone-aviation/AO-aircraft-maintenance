/**
 * Responsibility: Pins job cards: steps, links, parts, signoffs and the
 *   43.7 inspector certificate, every refusal in order, numbering, and the
 *   cards, links, statuses and signoffs the screens offer, and the change-log
 *   entry a command records.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/taskCards.ts, ./workOrders, ./programs,
 *   ./rejection; tests/fixtures (task cards, work orders); src/data/demo.ts.
 */
import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  saveTaskCard,
  applyTaskCardCommand,
  applyTaskLink,
  isResultTextField,
  linkableTaskCards,
  linkedTaskCards,
  signoffRefusals,
  TASK_TEXT_MAX_LENGTH,
  taskCardFieldsSchema,
  taskCardStatuses,
  taskLinkLocked,
  taskLinksWritable,
  taskStatusChoices,
  type TaskCard,
  type TaskCardCommand,
  type TaskCardFields,
  type TaskLink,
  type TaskLinkField,
} from "./taskCards";
import { saveWorkOrder, workOrderProgress } from "./workOrders";
import { scopedSnapshot } from "./programs";
import { Rejection } from "./rejection";
import type { Snapshot } from "./model";
const now = Date.parse("2026-10-01T12:00:00Z");
const edit = (t: TaskCard, patch: Partial<TaskCardFields> = {}) => ({
  action: "save" as const,
  uuid: t.uuid,
  version: t.version,
  fields: { ...taskCardFieldsSchema.parse(t), ...patch },
});
describe("job cards", () => {
  it.each([
    "missing-result",
    "missing-measurement",
    "missing-units",
    "failed-test",
  ])("legacy %s does not block the simplified signoff", (problem) => {
    const s = demoSnapshot();
    let t = saveTaskCard(s, taskCardCommand(), now);
    t = saveTaskCard(
      s,
      edit(t, {
        status: "in-progress",
        actualWork: "Pressure tested",
        completionDate: "2026-10-01",
        functionalTestOutcome:
          problem === "failed-test" ? "fail" : "not-required",
        steps: t.steps.map((step) => ({
          ...step,
          signoffRequired: false,
          result: problem === "missing-result" ? "" : "Measured",
          measurement: problem === "missing-measurement" ? null : 15,
          units: problem === "missing-units" ? "" : "psi",
        })),
      }),
      now,
    );
    expect(() =>
      saveTaskCard(
        s,
        {
          action: "sign",
          uuid: t.uuid,
          version: t.version,
          kind: "technician",
        },
        now,
      ),
    ).not.toThrow();
  });

  it("captures ordered steps, links, ATA and parts while validating scope and stale edits", () => {
    const s = demoSnapshot(),
      c = taskCardCommand();
    const order = saveWorkOrder(s, workOrderCommand(), now);
    c.fields = {
      ...applyTaskLink(s, c.fields, {
        kind: "inspection",
        uuid: s.inspections[0].uuid,
      }),
      workOrderUuid: order.uuid,
      ataChapter: "05",
      partsUsed: [
        {
          uuid: crypto.randomUUID(),
          partNumber: "SEAL-1",
          description: "Seal",
          quantity: 2,
          serialLot: "LOT-22",
          removedComponent: "Old seal",
          installedComponent: "New seal",
        },
      ],
    };
    const t = saveTaskCard(s, c, now);
    expect(t.cardNumber).toBe("TC-2026-0001");
    expect(workOrderProgress(s, order)).toMatchObject({
      taskCardsTotal: 1,
      taskCardsCompleted: 0,
    });
    expect(t.partsUsed[0].quantity).toBe(2);
    expect(t.inspectionUuid).toBe(s.inspections[0].uuid);
    expect(() => saveTaskCard(s, c, now)).toThrow("changed");
    expect(() =>
      saveTaskCard(
        s,
        edit(t, {
          inspectionUuid: s.inspections.find(
            (i) => i.aircraftUuid !== t.aircraftUuid,
          )!.uuid,
        }),
        now,
      ),
    ).toThrow("unavailable");
    expect(() =>
      saveTaskCard(s, edit(t, { aircraftUuid: s.aircraft[1].uuid }), now),
    ).toThrow("change aircraft");
    expect(() =>
      saveWorkOrder(
        s,
        {
          ...workOrderCommand(),
          uuid: order.uuid,
          version: order.version,
          fields: { ...workOrderCommand().fields, status: "cancelled" },
        },
        now,
      ),
    ).toThrow("linked job cards");
    s.aircraft[0].programUuid = "elsewhere";
    expect(scopedSnapshot(s).taskCards).toEqual([]);
    expect(() => saveTaskCard(s, edit(t), now)).toThrow("access denied");
  });
  it("retains historical step data and requires technician and inspection signatures for completion", () => {
    const s = demoSnapshot();
    let t = saveTaskCard(s, taskCardCommand(), now);
    t = saveTaskCard(
      s,
      edit(t, {
        status: "in-progress",
        actualWork: "Tested pressure",
        completionDate: "2026-10-01",
        inspectionSignoffRequired: true,
        functionalTestRequired: true,
        functionalTestOutcome: "pass",
        functionalTestResults: "Pressure stable",
        steps: t.steps.map((x) => ({
          ...x,
          result: "Measured",
          measurement: 30,
        })),
      }),
      now,
    );
    expect(() =>
      saveTaskCard(
        s,
        {
          action: "sign",
          uuid: t.uuid,
          version: t.version,
          kind: "step",
          stepUuid: t.steps[0].uuid,
        },
        now,
      ),
    ).toThrow("outside");
    // The unsigned legacy required step is history, not a signoff prerequisite.
    t = saveTaskCard(
      s,
      { action: "sign", uuid: t.uuid, version: t.version, kind: "technician" },
      now,
    );
    expect(t.technicianSignoff).toEqual({
      userId: s.user.id,
      name: s.user.name,
      at: now,
    });
    expect(() =>
      saveTaskCard(s, edit(t, { status: "completed" }), now),
    ).toThrow("required inspection signoff");
    expect(() =>
      saveTaskCard(
        s,
        {
          action: "sign",
          uuid: t.uuid,
          version: t.version,
          kind: "inspection",
        },
        now,
      ),
    ).toThrow("different person than the technician");
    s.user = {
      ...s.user,
      id: "inspector",
      name: "Inspector",
      licenseNumber: "3456789",
      certificateType: "A&P IA",
    };
    t = saveTaskCard(
      s,
      { action: "sign", uuid: t.uuid, version: t.version, kind: "inspection" },
      now,
    );
    t = saveTaskCard(s, edit(t, { status: "completed" }), now);
    expect(t.status).toBe("completed");
    expect(t.technicianSignoff).not.toBeNull();
    // The step data stays on the card, readable.
    expect(t.steps).toEqual([
      expect.objectContaining({
        instruction: "Measure pressure",
        result: "Measured",
        measurement: 30,
        signoffRequired: true,
      }),
    ]);
    expect(t.stepSignoffs).toEqual({});
    expect(() =>
      saveTaskCard(s, edit(t, { findings: "Changed" }), now),
    ).toThrow("closed");
    expect(s.inspections[0].lastDate).toBeUndefined();
  });
  it("invalidates all signoffs when signed work is edited, but not on a no-op save", () => {
    const s = demoSnapshot();
    let t = saveTaskCard(s, taskCardCommand(), now);
    t = saveTaskCard(
      s,
      edit(t, {
        steps: [],
        status: "ready",
        actualWork: "Checked",
        completionDate: "2026-10-01",
      }),
      now,
    );
    t = saveTaskCard(
      s,
      { action: "sign", uuid: t.uuid, version: t.version, kind: "technician" },
      now,
    );
    t = saveTaskCard(s, edit(t), now);
    expect(t.technicianSignoff).not.toBeNull();
    t = saveTaskCard(s, edit(t, { findings: "Additional finding" }), now);
    expect(t.technicianSignoff).toBeNull();
    expect(() =>
      saveTaskCard(s, edit(t, { status: "completed" }), now),
    ).toThrow("technician signoff");
  });
  it("retains legacy prerequisite links without blocking simplified signoff", () => {
    const s = demoSnapshot();
    const a = saveTaskCard(s, taskCardCommand(), now);
    let b = saveTaskCard(s, taskCardCommand(), now);
    b = saveTaskCard(
      s,
      edit(b, {
        prerequisiteUuids: [a.uuid],
        steps: [],
        status: "ready",
        actualWork: "Done",
        completionDate: "2026-10-01",
      }),
      now,
    );
    expect(() =>
      saveTaskCard(s, edit(a, { prerequisiteUuids: [b.uuid] }), now),
    ).toThrow("cycle");
    expect(() =>
      saveTaskCard(
        s,
        {
          action: "sign",
          uuid: b.uuid,
          version: b.version,
          kind: "technician",
        },
        now,
      ),
    ).not.toThrow();
    b = s.taskCards!.find((card) => card.uuid === b.uuid)!;
    expect(() =>
      saveTaskCard(s, edit(b, { prerequisiteUuids: [b.uuid] }), now),
    ).toThrow("other job cards");
    expect(() =>
      saveTaskCard(
        s,
        edit(b, {
          functionalTestRequired: true,
          functionalTestOutcome: "fail",
        }),
        now,
      ),
    ).not.toThrow();
  });
  it("links component services and discrepancies and rejects component mismatches and duplicate numbers", () => {
    const s = demoSnapshot(),
      c = workOrderComponent();
    s.management = [
      c,
      {
        kind: "componentRequirement",
        uuid: "svc",
        version: 1,
        aircraftUuid: c.aircraftUuid,
        componentUuid: c.uuid,
        description: "Engine inspection",
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
        uuid: "leak",
        aircraftUuid: c.aircraftUuid,
        description: "Oil leak",
        status: "open",
        authorId: s.user.id,
        createdAt: now,
      },
    ];
    let t = saveTaskCard(s, taskCardCommand(), now);
    t = saveTaskCard(
      s,
      {
        action: "link",
        uuid: t.uuid,
        version: t.version,
        link: { kind: "componentRequirement", uuid: "svc" },
      },
      now,
    );
    expect(t.componentUuid).toBe(c.uuid);
    t = saveTaskCard(
      s,
      {
        action: "link",
        uuid: t.uuid,
        version: t.version,
        link: { kind: "discrepancy", uuid: "leak" },
      },
      now,
    );
    expect(t.discrepancyUuid).toBe("leak");
    expect(() => saveTaskCard(s, edit(t, { componentUuid: "" }), now)).toThrow(
      "belong",
    );
    const other = taskCardCommand();
    other.fields.cardNumber = t.cardNumber;
    expect(() => saveTaskCard(s, other, now)).toThrow("number already");
  });
});

it("links stock parts to the correct program and location, supports non-stock parts and preserves quantities", () => {
  const s = demoSnapshot();
  const owner = s.aircraft[0].programUuid;
  s.management = [
    {
      kind: "location",
      uuid: "shelf",
      version: 1,
      programUuid: owner,
      name: "Shelf A",
      address: "",
      contact: "",
    },
    {
      kind: "location",
      uuid: "other-shelf",
      version: 1,
      programUuid: owner,
      name: "Shelf B",
      address: "",
      contact: "",
    },
    {
      kind: "stock",
      uuid: "stock-seal",
      version: 1,
      programUuid: owner,
      partNumber: "SEAL-1",
      description: "Seal",
      alternates: "",
      category: "part",
      condition: "new",
      locationUuid: "shelf",
      quantity: 5,
      minimum: 1,
    },
  ];
  let card = saveTaskCard(s, taskCardCommand(), now);
  const part = {
    uuid: crypto.randomUUID(),
    source: "stock" as const,
    stockUuid: "stock-seal",
    locationUuid: "shelf",
    partNumber: "SEAL-1",
    description: "Seal",
    quantity: 1,
    serialLot: "LOT-1",
    removedComponent: "",
    installedComponent: "",
  };
  const inventory = structuredClone(s.management);
  card = saveTaskCard(
    s,
    edit(card, { notesRemarks: "Seal replaced", partsUsed: [part] }),
    now,
  );
  expect(card.partsUsed[0]).toMatchObject(part);
  expect(card.notesRemarks).toBe("Seal replaced");
  expect(s.management).toEqual(inventory);
  expect(() =>
    saveTaskCard(
      s,
      edit(card, { partsUsed: [{ ...part, locationUuid: "other-shelf" }] }),
      now,
    ),
  ).toThrow("inventory location");
  expect(() =>
    saveTaskCard(
      s,
      edit(card, { partsUsed: [{ ...part, partNumber: "OTHER" }] }),
      now,
    ),
  ).toThrow("part number");
  expect(() =>
    saveTaskCard(
      s,
      edit(card, { partsUsed: [{ ...part, source: "non-stock" }] }),
      now,
    ),
  ).toThrow("Non-stock");
  s.management[2].programUuid = "another-program";
  expect(() => saveTaskCard(s, edit(card), now)).toThrow("Flight Program");
  card = saveTaskCard(
    s,
    edit(card, {
      partsUsed: [
        { ...part, source: "non-stock", stockUuid: "", locationUuid: "" },
      ],
    }),
    now,
  );
  expect(card.partsUsed[0].source).toBe("non-stock");
});
it("refuses linking an expired stock lot but keeps a lot linked before it expired or was renamed", () => {
  const s = demoSnapshot();
  const owner = s.aircraft[0].programUuid;
  const lot = (uuid: string, expirationDate: string) => ({
    kind: "stock" as const,
    uuid,
    version: 1,
    programUuid: owner,
    partNumber: "SEAL-1",
    description: "Seal",
    alternates: "",
    category: "part" as const,
    condition: "new" as const,
    locationUuid: "shelf",
    quantity: 5,
    minimum: 1,
    expirationDate,
  });
  s.management = [
    {
      kind: "location",
      uuid: "shelf",
      version: 1,
      programUuid: owner,
      name: "Shelf A",
      address: "",
      contact: "",
    },
    lot("fresh", "2026-12-31"),
    // Past its date in every time zone at `now`.
    lot("expired", "2026-09-29"),
  ];
  const part = (stockUuid: string) => ({
    uuid: crypto.randomUUID(),
    source: "stock" as const,
    stockUuid,
    locationUuid: "shelf",
    partNumber: "SEAL-1",
    description: "Seal",
    quantity: 1,
    serialLot: "",
    removedComponent: "",
    installedComponent: "",
  });
  let card = saveTaskCard(s, taskCardCommand(), now);
  expect(() =>
    saveTaskCard(s, edit(card, { partsUsed: [part("expired")] }), now),
  ).toThrow(
    "SEAL-1 expired on 2026-09-29. Expired stock cannot be linked as a part used",
  );
  const linked = part("fresh");
  card = saveTaskCard(s, edit(card, { partsUsed: [linked] }), now);
  // Switching an existing part to an expired lot is a new link too.
  expect(() =>
    saveTaskCard(
      s,
      edit(card, { partsUsed: [{ ...linked, stockUuid: "expired" }] }),
      now,
    ),
  ).toThrow("Expired stock cannot be linked");
  // The linked lot expires later: the recorded part stays and the card can
  // still be edited, signed and completed.
  const later = Date.parse("2027-01-15T12:00:00Z");
  card = saveTaskCard(
    s,
    edit(card, {
      partsUsed: [{ ...linked, quantity: 2 }],
      status: "in-progress",
      actualWork: "Replaced seal",
      completionDate: "2027-01-15",
    }),
    later,
  );
  expect(card.partsUsed[0]).toMatchObject({ stockUuid: "fresh", quantity: 2 });
  // The lot's part number is corrected later: the recorded part keeps the
  // number it was recorded with, and only a re-entered number must match.
  (s.management[1] as { partNumber: string }).partNumber = "SEAL-10";
  card = saveTaskCard(s, edit(card, { notesRemarks: "Seal replaced" }), later);
  expect(card.partsUsed[0].partNumber).toBe("SEAL-1");
  expect(() =>
    saveTaskCard(
      s,
      edit(card, { partsUsed: [{ ...linked, partNumber: "SEAL-2" }] }),
      later,
    ),
  ).toThrow("The part number must match the selected stock item.");
  card = saveTaskCard(
    s,
    edit(card, { partsUsed: [{ ...linked, partNumber: "SEAL-10" }] }),
    later,
  );
  expect(card.partsUsed[0].partNumber).toBe("SEAL-10");
});
it("signs and completes a stored card whose legacy required step was never signed", () => {
  const s = demoSnapshot();
  let t = saveTaskCard(s, taskCardCommand(), now);
  t = saveTaskCard(
    s,
    edit(t, {
      status: "in-progress",
      actualWork: "Pressure tested",
      completionDate: "2026-10-01",
      steps: t.steps.map((x) => ({ ...x, result: "Measured" })),
    }),
    now,
  );
  expect(t.steps[0].signoffRequired).toBe(true);
  t = saveTaskCard(
    s,
    { action: "sign", uuid: t.uuid, version: t.version, kind: "technician" },
    now,
  );
  expect(t.technicianSignoff).not.toBeNull();
  t = saveTaskCard(s, edit(t, { status: "completed" }), now);
  expect(t.status).toBe("completed");
  expect(t.steps[0]).toMatchObject({ result: "Measured", measurement: null });
  // A card signed before the flow was simplified also completes.
  let legacy = saveTaskCard(s, taskCardCommand(), now);
  legacy = saveTaskCard(
    s,
    edit(legacy, { status: "in-progress", completionDate: "2026-10-01" }),
    now,
  );
  const signature = { userId: s.user.id, name: s.user.name, at: now };
  s.taskCards = s.taskCards!.map((x) =>
    x.uuid === legacy.uuid ? { ...legacy, technicianSignoff: signature } : x,
  );
  expect(
    saveTaskCard(s, edit(legacy, { status: "completed" }), now).status,
  ).toBe("completed");
});
describe("inspection signoff certificate (the 43.7 signer)", () => {
  const hint =
    "Add your certificate type and number under My certifications to sign as inspector.";
  function technicianSigned() {
    const s = demoSnapshot();
    let t = saveTaskCard(s, taskCardCommand(), now);
    t = saveTaskCard(
      s,
      edit(t, {
        steps: [],
        status: "in-progress",
        actualWork: "Replaced seal",
        completionDate: "2026-10-01",
        inspectionSignoffRequired: true,
      }),
      now,
    );
    // The demo technician has no certificate on file: 43.3(d) lets
    // supervised uncertificated workers perform work.
    expect(s.user.certifications).toBeUndefined();
    expect(s.user.licenseNumber).toBeUndefined();
    t = saveTaskCard(
      s,
      { action: "sign", uuid: t.uuid, version: t.version, kind: "technician" },
      now,
    );
    expect(t.technicianSignoff?.userId).toBe(s.user.id);
    return { s, t };
  }
  const inspect = (s: ReturnType<typeof demoSnapshot>, t: TaskCard) =>
    saveTaskCard(
      s,
      { action: "sign", uuid: t.uuid, version: t.version, kind: "inspection" },
      now,
    );
  it("accepts a technician signoff without a certificate on file", () => {
    expect(technicianSigned().t.technicianSignoff).not.toBeNull();
  });
  it("rejects an inspection signoff without a certificate on file", () => {
    const { s, t } = technicianSigned();
    s.user = { ...s.user, id: "inspector", name: "Inspector" };
    expect(() => inspect(s, t)).toThrow(hint);
    // A selected certification without a number is not a certificate on file.
    s.user = {
      ...s.user,
      certifications: [
        { kind: "mechanic", number: "", issuedOn: "", airframe: true },
      ],
    };
    expect(() => inspect(s, t)).toThrow(hint);
    // A certificate issued after today is not yet held.
    s.user = {
      ...s.user,
      certifications: [
        { kind: "mechanic", number: "3456789", issuedOn: "2027-01-01" },
      ],
    };
    expect(() => inspect(s, t)).toThrow(hint);
    // The older single-license profile fields need both a type and a number.
    s.user = {
      ...s.user,
      certifications: undefined,
      licenseNumber: "3456789",
      certificateType: "",
    };
    expect(() => inspect(s, t)).toThrow(hint);
    expect(
      s.taskCards!.find((x) => x.uuid === t.uuid)?.inspectionSignoff,
    ).toBeNull();
  });
  it("accepts an inspection signoff with a certificate type and number on file", () => {
    const { s, t } = technicianSigned();
    s.user = {
      ...s.user,
      id: "inspector",
      name: "Inspector",
      certifications: [
        {
          kind: "mechanic",
          number: "3456789",
          issuedOn: "2020-05-01",
          airframe: true,
          powerplant: true,
          ia: true,
        },
      ],
    };
    const signed = inspect(s, t);
    expect(signed.inspectionSignoff).toEqual({
      userId: "inspector",
      name: "Inspector",
      at: now,
    });
    expect(
      saveTaskCard(s, edit(signed, { status: "completed" }), now).status,
    ).toBe("completed");
  });
  it("accepts the older single-license profile fields", () => {
    const { s, t } = technicianSigned();
    s.user = {
      ...s.user,
      id: "inspector",
      name: "Inspector",
      licenseNumber: "3456789",
      certificateType: "A&P IA",
    };
    expect(inspect(s, t).inspectionSignoff?.userId).toBe("inspector");
  });
  const maintenanceHint =
    "Add a mechanic, repairman or inspection authorization certificate under My certifications to sign as inspector.";
  it("refuses a pilot certificate: only maintenance certificates sign inspections", () => {
    const { s, t } = technicianSigned();
    const pilot = { kind: "pilot" as const, number: "P-98765", issuedOn: "" };
    s.user = {
      ...s.user,
      id: "inspector",
      name: "Inspector",
      certifications: [pilot],
    };
    expect(() => inspect(s, t)).toThrow(maintenanceHint);
    // An unnumbered mechanic record does not make up for it.
    s.user = {
      ...s.user,
      certifications: [
        pilot,
        { kind: "mechanic", number: "", issuedOn: "", airframe: true },
      ],
    };
    expect(() => inspect(s, t)).toThrow(maintenanceHint);
    // Older single-license fields: pilot and unrecognized types are refused.
    for (const certificateType of [
      "Pilot",
      "Private pilot",
      "Commercial pilot",
      "ATP",
      "AME",
      "CRS",
    ]) {
      s.user = {
        ...s.user,
        certifications: undefined,
        licenseNumber: "3456789",
        certificateType,
      };
      expect(() => inspect(s, t), certificateType).toThrow(maintenanceHint);
    }
    expect(
      s.taskCards!.find((x) => x.uuid === t.uuid)?.inspectionSignoff,
    ).toBeNull();
    // A numbered mechanic certificate beside the pilot certificate signs.
    s.user = {
      ...s.user,
      certifications: [
        pilot,
        { kind: "mechanic", number: "3456789", issuedOn: "" },
      ],
    };
    expect(inspect(s, t).inspectionSignoff?.userId).toBe("inspector");
  });
  it.each([
    "A&P",
    "A & P",
    "A&P IA",
    "Airframe (A)",
    "Powerplant (P)",
    "Mechanic",
    "IA",
    "Inspection Authorization",
    "Repairman",
    "Pilot, A&P",
  ])("accepts the older certificate type %s", (certificateType) => {
    const { s, t } = technicianSigned();
    s.user = {
      ...s.user,
      id: "inspector",
      name: "Inspector",
      licenseNumber: "3456789",
      certificateType,
    };
    expect(inspect(s, t).inspectionSignoff?.userId).toBe("inspector");
  });
});

const create = (patch: Partial<TaskCardFields> = {}) => {
  const c = taskCardCommand();
  return { ...c, fields: { ...c.fields, ...patch } };
};
const sign = (
  t: TaskCard,
  kind: "technician" | "inspection" | "step",
  stepUuid?: string,
): TaskCardCommand => ({
  action: "sign",
  uuid: t.uuid,
  version: t.version,
  kind,
  stepUuid,
});
const link = (
  t: TaskCard,
  action: "link" | "unlink",
  kind: TaskLink["kind"],
  uuid: string,
): TaskCardCommand => ({
  action,
  uuid: t.uuid,
  version: t.version,
  link: { kind, uuid },
});
const stockPart = (patch: object = {}) => ({
  uuid: crypto.randomUUID(),
  source: "stock" as const,
  stockUuid: "seal",
  locationUuid: "shelf",
  partNumber: "SEAL-1",
  description: "Seal",
  quantity: 1,
  serialLot: "",
  removedComponent: "",
  installedComponent: "",
  ...patch,
});

/**
 * A shelf with a seal lot and an expired lot, an open work order, and job
 * cards: a draft, a ready card, an inspection template and one on the order.
 */
function cardWorld() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const stock = (uuid: string, expirationDate?: string) => ({
    kind: "stock" as const,
    uuid,
    version: 1,
    programUuid: a.programUuid,
    partNumber: "SEAL-1",
    description: "Seal",
    alternates: "",
    category: "part" as const,
    condition: "new" as const,
    locationUuid: "shelf",
    quantity: 5,
    minimum: 1,
    expirationDate,
  });
  s.management = [
    {
      kind: "location",
      uuid: "shelf",
      version: 1,
      programUuid: a.programUuid,
      name: "Shelf",
      address: "",
      contact: "",
    },
    stock("seal"),
    stock("expired", "2026-01-01"),
  ];
  const order = saveWorkOrder(s, workOrderCommand(), now);
  const card = saveTaskCard(s, create({ sourceKey: "csv:1" }), now);
  const ready = saveTaskCard(
    s,
    edit(saveTaskCard(s, create(), now), { status: "ready" }),
    now,
  );
  const template = saveTaskCard(
    s,
    create({ inspectionUuid: s.inspections[0].uuid }),
    now,
  );
  const onOrder = saveTaskCard(s, create({ workOrderUuid: order.uuid }), now);
  const stored = (t: TaskCard) => s.taskCards!.find((x) => x.uuid === t.uuid)!;
  return { s, a, order, card, ready, template, onOrder, stored };
}
type CardWorld = ReturnType<typeof cardWorld>;

// Each refusal, triggered alone; saveTaskCard checks them in this order.
const cardRefusals: [string, (w: CardWorld) => TaskCardCommand][] = [
  [
    "Archived job cards are read-only.",
    (w) => {
      w.s.archivedTaskCards = [w.card];
      return edit(w.card);
    },
  ],
  [
    "Job card maintenance access denied.",
    () => create({ aircraftUuid: "nowhere" }),
  ],
  [
    "A job card cannot change aircraft.",
    (w) => edit(w.card, { aircraftUuid: w.s.aircraft[1].uuid }),
  ],
  [
    "Job card changed. Reopen it before saving.",
    (w) => ({ ...edit(w.card), version: 9 }),
  ],
  [
    "This job card or its work order is closed.",
    (w) => {
      w.stored(w.card).status = "canceled";
      return edit(w.card);
    },
  ],
  [
    "Sign the work-order job card, not the reusable template.",
    (w) => sign(w.template, "technician"),
  ],
  ["Make the task ready before signing.", (w) => sign(w.card, "technician")],
  [
    "Select a required step signoff point.",
    (w) => sign(w.ready, "step", crypto.randomUUID()),
  ],
  [
    "Record a result for every step.",
    (w) => sign(w.ready, "step", w.ready.steps[0].uuid),
  ],
  [
    "Record required step measurements and units.",
    (w) => {
      w.stored(w.ready).steps[0].result = "Done";
      return sign(w.ready, "step", w.ready.steps[0].uuid);
    },
  ],
  [
    "A step measurement is outside its limits.",
    (w) => {
      Object.assign(w.stored(w.ready).steps[0], {
        result: "Done",
        measurement: 25,
      });
      return sign(w.ready, "step", w.ready.steps[0].uuid);
    },
  ],
  [
    "Enter a completion date (today or earlier) before signing or completing this job card.",
    (w) => sign(w.ready, "technician"),
  ],
  [
    "Technician signoff is required before inspection signoff.",
    (w) => {
      w.stored(w.ready).completionDate = "2026-10-01";
      return sign(w.ready, "inspection");
    },
  ],
  [
    "Inspection signoff must be by a different person than the technician.",
    (w) => {
      Object.assign(w.stored(w.ready), {
        completionDate: "2026-10-01",
        technicianSignoff: { userId: w.s.user.id, name: "Me", at: now },
      });
      return sign(w.ready, "inspection");
    },
  ],
  [
    "Add your certificate type and number under My certifications to sign as inspector.",
    (w) => {
      Object.assign(w.stored(w.ready), {
        completionDate: "2026-10-01",
        technicianSignoff: { userId: "technician", name: "Tech", at: now },
      });
      return sign(w.ready, "inspection");
    },
  ],
  [
    "Only unsigned job cards without recorded work or a work-order link can be removed from this item.",
    (w) => link(w.card, "unlink", "inspection", "missing"),
  ],
  [
    "This job card is already linked to another record of this type.",
    (w) => link(w.template, "link", "inspection", w.s.inspections[1].uuid),
  ],
  [
    "Reusable templates contain instructions only. Record work results and completion on a work-order job card.",
    (w) => create({ inspectionUuid: w.s.inspections[0].uuid, status: "ready" }),
  ],
  [
    "Keep the reusable job card template attached to its source. Add the source to a work order to create an independent job card.",
    (w) => edit(w.template, { workOrderUuid: w.order.uuid }),
  ],
  [
    "A work-order copy must keep its source links.",
    (w) => {
      w.stored(w.onOrder).sourceTaskCardUuid = w.template.uuid;
      return edit(w.onOrder, { componentUuid: "engine" });
    },
  ],
  [
    "A saved work order link cannot be changed.",
    (w) => edit(w.onOrder, { workOrderUuid: "" }),
  ],
  [
    "Select an open work order for this aircraft.",
    () => create({ workOrderUuid: "missing" }),
  ],
  [
    "Inspection is unavailable for this aircraft.",
    () => create({ inspectionUuid: "missing" }),
  ],
  [
    "Discrepancy is unavailable for this aircraft.",
    () => create({ discrepancyUuid: "missing" }),
  ],
  [
    "Component must be installed on this aircraft.",
    () => create({ componentUuid: "missing" }),
  ],
  [
    "Service requirement must belong to the linked component.",
    () => create({ requirementUuid: "missing" }),
  ],
  [
    "Non-stock parts cannot link to inventory.",
    () => create({ partsUsed: [stockPart({ source: "non-stock" })] }),
  ],
  [
    "Select a stock item and its inventory location in this aircraft’s Flight Program.",
    () => create({ partsUsed: [stockPart({ locationUuid: "missing" })] }),
  ],
  [
    "The part number must match the selected stock item.",
    () => create({ partsUsed: [stockPart({ partNumber: "OTHER" })] }),
  ],
  [
    "SEAL-1 expired on 2026-01-01. Expired stock cannot be linked as a part used; choose another lot or record a non-stock item.",
    () => create({ partsUsed: [stockPart({ stockUuid: "expired" })] }),
  ],
  [
    "This CSV task has already been imported for this parent record.",
    () => create({ sourceKey: "csv:1" }),
  ],
  ["New job cards must start as draft.", () => create({ status: "ready" })],
  [
    "Completion date cannot be in the future.",
    (w) => edit(w.card, { completionDate: "2026-12-01" }),
  ],
  [
    "Step and parts identifiers must be unique.",
    (w) => edit(w.card, { steps: [w.card.steps[0], w.card.steps[0]] }),
  ],
  [
    "A step lower limit cannot exceed its upper limit.",
    (w) => edit(w.card, { steps: [{ ...w.card.steps[0], lowerLimit: 30 }] }),
  ],
  [
    "Prerequisites must be unique.",
    (w) => edit(w.card, { prerequisiteUuids: [w.ready.uuid, w.ready.uuid] }),
  ],
  [
    "Prerequisites must be templates for a template, or job cards on the same work order.",
    (w) => edit(w.onOrder, { prerequisiteUuids: [w.ready.uuid] }),
  ],
  [
    "Prerequisites must be other job cards for this aircraft.",
    (w) => edit(w.card, { prerequisiteUuids: [w.card.uuid] }),
  ],
  [
    "Task prerequisites cannot form a cycle.",
    (w) => {
      w.stored(w.ready).prerequisiteUuids = [w.card.uuid];
      return edit(w.card, { prerequisiteUuids: [w.ready.uuid] });
    },
  ],
  [
    "Card number already exists in this program.",
    (w) => create({ cardNumber: w.card.cardNumber.toUpperCase() }),
  ],
  [
    "Enter a completion date (today or earlier) before signing or completing this job card.\nSave the work, then record technician signoff before completing.",
    (w) => edit(w.ready, { status: "completed" }),
  ],
  [
    "Save the work, then record technician signoff before completing.\nRecord the required inspection signoff before completing.",
    (w) =>
      edit(w.ready, {
        status: "completed",
        completionDate: "2026-10-01",
        inspectionSignoffRequired: true,
      }),
  ],
];

describe("job card refusals", () => {
  it.each(cardRefusals)("refuses: %s", (message, build) => {
    const w = cardWorld();
    const command = build(w);
    const before = JSON.stringify(w.s);
    let error: unknown;
    try {
      saveTaskCard(w.s, command, now);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Rejection);
    expect((error as Error).message).toBe(message);
    expect(JSON.stringify(w.s)).toBe(before);
  });
});

describe("job card results", () => {
  it("numbers new cards in turn, and a step signoff clears the card's signoffs", () => {
    const w = cardWorld();
    expect(
      [w.card, w.ready, w.template, w.onOrder].map((t) => t.cardNumber),
    ).toEqual(["TC-2026-0001", "TC-2026-0002", "TC-2026-0003", "TC-2026-0004"]);
    const step = w.ready.steps[0];
    Object.assign(w.stored(w.ready), {
      steps: [{ ...step, result: "Done", measurement: 15 }],
      technicianSignoff: { userId: "technician", name: "Tech", at: 1 },
    });
    const signed = saveTaskCard(w.s, sign(w.ready, "step", step.uuid), now);
    expect(signed).toMatchObject({
      version: w.ready.version + 1,
      updatedAt: now,
      technicianSignoff: null,
      inspectionSignoff: null,
      stepSignoffs: {
        [step.uuid]: { userId: w.s.user.id, name: w.s.user.name, at: now },
      },
    });
  });
});

it("accepts a completion date that is today anywhere, and refuses the day after", () => {
  const w = cardWorld();
  // At noon UTC on 1 October it is already 2 October in UTC+14.
  w.stored(w.ready).completionDate = "2026-10-02";
  expect(
    saveTaskCard(w.s, sign(w.ready, "technician"), now).technicianSignoff,
  ).not.toBeNull();
  expect(() =>
    saveTaskCard(w.s, edit(w.card, { completionDate: "2026-10-03" }), now),
  ).toThrow("Completion date cannot be in the future.");
});

describe("what the job card screens offer", () => {
  const cardNumbers = (cards: TaskCard[]) => cards.map((t) => t.cardNumber);

  it("keeps a template to draft or canceled and free of result text", () => {
    const w = cardWorld();
    expect(taskStatusChoices(w.template)).toEqual(["draft", "canceled"]);
    expect(taskStatusChoices(w.card)).toEqual(taskCardStatuses);
    const results: (keyof TaskCardFields)[] = [
      "findings",
      "actualWork",
      "measurements",
      "functionalTestResults",
    ];
    for (const field of results) {
      expect(isResultTextField(field)).toBe(true);
      expect(() =>
        saveTaskCard(w.s, edit(w.template, { [field]: "Done" }), now),
      ).toThrow("Reusable templates contain instructions only.");
    }
    for (const field of ["description", "actualLabor", "notesRemarks"] as const)
      expect(isResultTextField(field)).toBe(false);
    const canceled = edit(w.template, { status: "canceled" });
    expect(saveTaskCard(w.s, canceled, now).status).toBe("canceled");
  });

  it("lists a record's linked cards and offers its unlinked, writable ones", () => {
    const w = cardWorld();
    const inspection: TaskLink = {
      kind: "inspection",
      uuid: w.template.inspectionUuid,
    };
    const order: TaskLink = { kind: "workOrder", uuid: w.order.uuid };
    w.stored(w.onOrder).inspectionUuid = inspection.uuid;
    const [card, ready, template, onOrder] = cardNumbers([
      w.card,
      w.ready,
      w.template,
      w.onOrder,
    ]);
    const linked = (link: TaskLink, aircraftUuid = w.a.uuid) =>
      cardNumbers(linkedTaskCards(w.s, aircraftUuid, link));
    const offered = (link: TaskLink) =>
      cardNumbers(linkableTaskCards(w.s, w.a.uuid, link));
    expect(linked(inspection)).toEqual([template]);
    expect(linked(order)).toEqual([onOrder]);
    expect(linked(inspection, "elsewhere")).toEqual([]);
    expect(offered(inspection)).toEqual([card, ready]);
    expect(offered(order)).toEqual([card, ready]);
    w.stored(w.ready).status = "canceled";
    expect(offered(order)).toEqual([card]);
  });

  it("lets links change with maintenance access, on a work order while open", () => {
    const w = cardWorld();
    const order: TaskLink = { kind: "workOrder", uuid: w.order.uuid };
    const inspection: TaskLink = { kind: "inspection", uuid: "any" };
    expect(taskLinksWritable(w.s, w.a.uuid, order)).toBe(true);
    expect(taskLinksWritable(w.s, "nowhere", inspection)).toBe(false);
    const missing: TaskLink = { kind: "workOrder", uuid: "missing" };
    expect(taskLinksWritable(w.s, w.a.uuid, missing)).toBe(false);
    w.s.workOrders = w.s.workOrders!.map((o) => ({
      ...o,
      status: "completed",
    }));
    expect(taskLinksWritable(w.s, w.a.uuid, order)).toBe(false);
    w.s.workOrders = undefined;
    expect(taskLinksWritable(w.s, w.a.uuid, order)).toBe(false);
    expect(taskLinksWritable(w.s, w.a.uuid, inspection)).toBe(true);
  });

  it("locks a copy's every link, and a template's work order and saved links", () => {
    const w = cardWorld();
    const fields: TaskLinkField[] = [
      "workOrderUuid",
      "inspectionUuid",
      "componentUuid",
      "requirementUuid",
      "discrepancyUuid",
    ];
    const locked = (t?: TaskCard) =>
      fields.filter((field) => taskLinkLocked(t, field));
    expect(locked(undefined)).toEqual([]);
    expect(locked(w.card)).toEqual([]);
    expect(locked(w.onOrder)).toEqual([]);
    expect(locked({ ...w.template, componentUuid: "engine" })).toEqual([
      "workOrderUuid",
      "inspectionUuid",
      "componentUuid",
    ]);
    expect(
      locked({ ...w.onOrder, sourceTaskCardUuid: w.template.uuid }),
    ).toEqual(fields);
  });
});

describe("signoffs the job-card screens offer: exactly what the server accepts", () => {
  const asOf = "2026-10-01";
  const certified = (s: Snapshot, id: string) => {
    s.user = { ...s.user, id, licenseNumber: "A1", certificateType: "A&P" };
  };
  // Offers "TI" (T for technician, I for inspection, else -), after checking
  // that the server accepts each offered signoff and refuses each other one
  // with the refusal the screens show.
  const offers = (s: Snapshot, card: TaskCard) => {
    const refusals = signoffRefusals(card, s.user, asOf);
    for (const kind of ["technician", "inspection"] as const) {
      const attempt = () =>
        saveTaskCard(structuredClone(s), sign(card, kind), now);
      if (refusals[kind]) expect(attempt).toThrow(Error(refusals[kind]));
      else expect(attempt).not.toThrow();
    }
    return `${refusals.technician ? "-" : "T"}${refusals.inspection ? "-" : "I"}`;
  };
  // A ready card with its completion date, signed by "technician".
  const signedWorld = () => {
    const w = cardWorld();
    w.stored(w.ready).completionDate = asOf;
    const user = w.s.user;
    certified(w.s, "technician");
    const card = saveTaskCard(w.s, sign(w.ready, "technician"), now);
    w.s.user = user;
    return { ...w, card };
  };

  it("offers nothing on a draft or a template, and waits for a completion date", () => {
    const w = cardWorld();
    certified(w.s, "inspector");
    expect(offers(w.s, w.card)).toBe("--");
    expect(offers(w.s, w.template)).toBe("--");
    expect(offers(w.s, w.ready)).toBe("--");
    w.stored(w.ready).completionDate = asOf;
    expect(offers(w.s, w.stored(w.ready))).toBe("T-");
  });

  it("offers inspection after the technician's, to another certificated person, and both again once signed", () => {
    const { s, card } = signedWorld();
    expect(offers(s, card)).toBe("T-");
    certified(s, "technician");
    expect(offers(s, card)).toBe("T-");
    certified(s, "inspector");
    expect(offers(s, card)).toBe("TI");
    const both = saveTaskCard(s, sign(card, "inspection"), now);
    expect(offers(s, both)).toBe("TI");
  });

  it("clears a signed card's signoffs when it is set back to draft, keeping them in the change log", () => {
    const { s, card } = signedWorld();
    certified(s, "inspector");
    const both = saveTaskCard(s, sign(card, "inspection"), now);
    const draft = applyTaskCardCommand(s, edit(both, { status: "draft" }), now);
    expect(draft).toMatchObject({
      status: "draft",
      technicianSignoff: null,
      inspectionSignoff: null,
    });
    expect(JSON.parse(s.audit[0].before!)).toMatchObject({
      technicianSignoff: { userId: "technician" },
      inspectionSignoff: { userId: "inspector" },
    });
    expect(offers(s, draft)).toBe("--");
  });
});

it("records a job-card command with the card before and after; saveTaskCard alone records nothing", () => {
  const s = demoSnapshot();
  const logged = s.audit.length;
  const plain = structuredClone(s);
  saveTaskCard(plain, taskCardCommand(), now);
  expect(plain.audit).toHaveLength(logged);
  const created = applyTaskCardCommand(s, taskCardCommand(), now);
  const edited = applyTaskCardCommand(s, edit(created, { title: "Re" }), now);
  const entry = (before: TaskCard | undefined, after: TaskCard) => ({
    uuid: expect.any(String),
    programUuid: s.aircraft[0].programUuid,
    actorId: s.user.id,
    at: now,
    action: "taskCard.save",
    entityUuid: after.uuid,
    aircraftUuid: after.aircraftUuid,
    before: before && JSON.stringify(before),
    after: JSON.stringify(after),
  });
  expect(s.audit).toHaveLength(logged + 2);
  expect(s.audit.slice(0, 2)).toEqual([
    entry(created, edited),
    entry(undefined, created),
  ]);
});

it("holds TASK_TEXT_MAX_LENGTH (10,000) characters in a card's text fields", () => {
  const { title, description } = taskCardFieldsSchema.shape;
  const fits = (n: number) =>
    [title, description].map((f) => f.safeParse("x".repeat(n)).success);
  expect(TASK_TEXT_MAX_LENGTH).toBe(10_000);
  expect(fits(TASK_TEXT_MAX_LENGTH)).toEqual([true, true]);
  expect(fits(TASK_TEXT_MAX_LENGTH + 1)).toEqual([false, false]);
});
