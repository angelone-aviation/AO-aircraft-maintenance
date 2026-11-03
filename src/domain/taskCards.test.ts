import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import {
  workOrderCommand,
  workOrderComponent,
} from "../../tests/fixtures/workOrders";
import {
  saveTaskCard,
  applyTaskLink,
  taskCardFieldsSchema,
  type TaskCard,
  type TaskCardFields,
} from "./taskCards";
import { saveWorkOrder, workOrderProgress } from "./workOrders";
import { scopedSnapshot } from "./programs";
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
it("refuses linking an expired stock lot but keeps a lot linked before it expired", () => {
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
});
