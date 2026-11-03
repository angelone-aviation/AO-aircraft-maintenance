import { ensureDefaultGroups } from "./defaultGroups";
/** Explicit, internal-only provisioning of fictional training data. Never runs automatically. */
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { recordSchema, inspectionSchema } from "../src/domain/management";
import { workOrderSchema, newWorkTask } from "../src/domain/workOrders";
import { taskCardSchema, taskCardDefaults } from "../src/domain/taskCards";
import { blankAD, adSchema } from "../src/domain/airworthiness";
import {
  emptyChecklist,
  checklistRecordSchema,
} from "../src/domain/checklists";
import {
  emptyTemplate,
  inspectionTemplateSchema,
} from "../src/domain/inspectionTemplates";
import { flightPlanSchema } from "../src/domain/flightPlans";
import { poSchema } from "../src/domain/purchaseOrders";

export const PROGRAM = "sample-aviation-program-v1";
const NOTE =
  "SAMPLE ONLY — fictional training data; not approved for flight or maintenance.";
export const seed = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (!user?.isAdmin || !user.active)
      throw new Error("An active administrator is required.");
    const existing = await ctx.db
      .query("programs")
      .withIndex("uuid", (q) => q.eq("uuid", PROGRAM))
      .unique();
    if (existing) return { programUuid: PROGRAM, created: false };
    const now = Date.now();
    const day = (offset: number) =>
      new Date(now + offset * 86400000).toISOString().slice(0, 10);
    await ctx.db.insert("programs", {
      uuid: PROGRAM,
      version: 1,
      name: "SAMPLE — Hope Aviation Training",
      address: "Sample Hangar, Example Airfield (fictional)",
      email: "operations@example.test",
      contactName: "Sample Operations Coordinator",
      website: "https://example.test",
    });
    await ensureDefaultGroups(ctx, PROGRAM, user._id);
    const models = [
      ["Cessna", "172S", false, false],
      ["Mooney", "M20J", false, false],
      ["Cessna", "441", true, true],
      ["Cessna", "208B", false, true],
    ] as const;
    const aircraftIds = models.map((_, i) => `sample-aircraft-${i + 1}`);
    for (const [i, name] of [
      "Sample pilots",
      "Sample maintenance",
      "Sample dispatch",
      "Sample observers",
    ].entries())
      await ctx.db.insert("groups", {
        programUuid: PROGRAM,
        name,
        aircraftIds,
        permissions:
          i === 1
            ? ["read", "maintenance", "resolve"]
            : i === 3
              ? ["read"]
              : ["read", "flight", "discrepancy"],
      });
    for (let i = 0; i < 4; i++) {
      const [make, model, twin, turbine] = models[i];
      const aircraftUuid = aircraftIds[i],
        registration = `SAMPLE-${i + 1}`,
        h = (1200 + i * 800) * 3600,
        cycles = 800 + i * 300;
      const locationUuid = `sample-location-${i + 1}`,
        stockUuid = `sample-stock-${i + 1}`,
        componentUuid = `sample-component-${i + 1}`;
      const inspectionUuid = `sample-inspection-${i + 1}`,
        workOrderUuid = crypto.randomUUID(),
        cardUuid = crypto.randomUUID(),
        poUuid = crypto.randomUUID();
      const aircraft = {
        uuid: aircraftUuid,
        registration,
        make,
        model,
        serial: `SAMPLE-SERIAL-${i + 1}`,
        program: "SAMPLE — Hope Aviation Training",
        programUuid: PROGRAM,
        meter: "hobbs" as const,
        adjustmentSeconds: 0,
        baselineHobbs: h,
        baselineTach: h,
        baselineCycles: cycles,
        baselineLandings: cycles,
        currentHobbs: h + 3600,
        currentTach: h + 3600,
        cycles: cycles + 1,
        landings: cycles + 1,
        version: 1,
        twin,
        turbine,
        latestFlightAt: day(-2) + "T12:00:00.000Z",
        operationalStatus: "unknown" as const,
      };
      await ctx.db.insert("aircraft", aircraft);
      const managed = async (raw: unknown) => {
        const record = recordSchema.parse(raw);
        await ctx.db.insert("management", {
          uuid: record.uuid,
          programUuid: PROGRAM,
          kind: record.kind,
          ...("aircraftUuid" in record
            ? { aircraftUuid: record.aircraftUuid }
            : {}),
          payload: JSON.stringify(record),
        });
      };
      await managed({
        uuid: locationUuid,
        version: 1,
        programUuid: PROGRAM,
        kind: "location",
        name: [
          "SAMPLE Main Parts Store",
          "SAMPLE Line Maintenance",
          "SAMPLE Engine Shop",
          "SAMPLE Remote Base",
        ][i],
        address: "Fictional location for training",
        contact: "stores@example.test",
      });
      const part = [
        "SAMPLE-FILTER",
        "SAMPLE-TIRE",
        "SAMPLE-LAMP",
        "SAMPLE-OIL",
      ][i];
      await managed({
        uuid: stockUuid,
        version: 1,
        programUuid: PROGRAM,
        kind: "stock",
        partNumber: part,
        alternates: "",
        description: [
          "SAMPLE oil filter",
          "SAMPLE main tire",
          "SAMPLE landing lamp",
          "SAMPLE engine oil quart",
        ][i],
        category: i === 3 ? "supply" : "part",
        oil: i === 3 || undefined,
        condition: "new",
        locationUuid,
        quantity: [8, 0, 2, 24][i],
        minimum: 4,
        vendor: `SAMPLE Vendor ${i + 1}`,
        cost: [35, 180, 65, 12][i],
      });
      const component = {
        uuid: componentUuid,
        version: 1,
        programUuid: PROGRAM,
        kind: "component",
        aircraftUuid,
        componentType: "Engine",
        partNumber: `SAMPLE-ENGINE-${i + 1}`,
        serial: `SAMPLE-ENG-SN-${i + 1}`,
        manufacturer: make,
        model: `SAMPLE ${model} engine`,
        notes: NOTE,
        trackTime: true,
        trackCycles: true,
        trackCalendar: true,
        installed: true,
        installedDate: day(-365),
        installPosition: "MAIN",
        installedSeconds: h,
        installedCycles: cycles,
        timeSinceNew: 500 * 3600,
        timeSinceOverhaul: 100 * 3600,
        timeSinceRepair: null,
        cyclesSinceNew: 400,
        serviceDaysBase: 0,
      };
      await managed(component);
      await managed({
        ...component,
        uuid: `sample-spare-${i + 1}`,
        aircraftUuid: "",
        installed: false,
        installedDate: undefined,
        installPosition: undefined,
        locationUuid,
        serial: `SAMPLE-SPARE-SN-${i + 1}`,
        notes: NOTE + " Spare in inventory.",
        incomingTag: { condition: "overhauled" },
      });
      await managed({
        uuid: `sample-requirement-${i + 1}`,
        version: 1,
        programUuid: PROGRAM,
        kind: "componentRequirement",
        componentUuid,
        aircraftUuid,
        requirementType: "Inspection Requirement",
        description: "SAMPLE engine condition review",
        notes: NOTE,
        calendarIntervalUnit: "MONTHS",
        timeBasis: "TSN",
        timeLimitMode: "FROM_LAST_COMPLIED",
        cycleLimitMode: "FROM_LAST_COMPLIED",
        intervalSeconds: 100 * 3600,
        lastSeconds: 450 * 3600,
        dueSeconds: 550 * 3600,
        warningCalendarMonths: 1,
        warningSeconds: 30 * 3600,
        warningCycles: 30,
        requiredParts: [{ locationUuid, stockUuid, quantity: 1 }],
      });
      await managed({
        uuid: `sample-baseline-${i + 1}`,
        version: 1,
        programUuid: PROGRAM,
        kind: "componentMovement",
        componentUuid,
        aircraftUuid,
        action: "BASELINE",
        date: day(-365),
        timeSinceNew: 500 * 3600,
        timeSinceOverhaul: 100 * 3600,
        timeSinceRepair: null,
        cycles: 400,
        serviceDays: 0,
        note:
          NOTE + " Initial setup baseline; not an installation certification.",
        actorId: user._id,
        at: now,
      });
      const inspection = inspectionSchema.parse({
        uuid: inspectionUuid,
        version: 1,
        programUuid: PROGRAM,
        aircraftUuid,
        reference: `SAMPLE inspection ${i + 1}`,
        description: NOTE + " Example scheduled condition inspection.",
        dueSeconds: h + [10, 20, 50, 100][i] * 3600,
        dueDate: day([7, 14, 45, 90][i]),
        intervalSeconds: 100 * 3600,
        materials: "Sample parts only",
        archived: false,
        requiredParts: [{ locationUuid, stockUuid, quantity: 2 }],
      });
      await ctx.db.insert("inspections", inspection);
      const task = newWorkTask(
        { kind: "inspection", uuid: inspectionUuid },
        inspection.description,
      );
      const order = workOrderSchema.parse({
        uuid: workOrderUuid,
        version: 1,
        number: `SAMPLE-WO-${i + 1}`,
        aircraftUuid,
        dateOpened: day(-1),
        supervisor: "Sample Maintenance Coordinator",
        scope: NOTE,
        priority: "routine",
        status: ["open", "parts-delay", "in-progress", "awaiting-approval"][i],
        completionDate: "",
        releaseOutcome: "",
        finalReview: "",
        recordedAt: now,
        createdBy: user._id,
        aircraft: {
          registration,
          make,
          model,
          serial: aircraft.serial,
          totalSeconds: h + 3600,
          hobbs: h + 3600,
          tach: h + 3600,
          meter: "hobbs",
          cycles: cycles + 1,
        },
        componentReadings: [],
        tasks: [task],
      });
      await ctx.db.insert("workOrders", {
        uuid: order.uuid,
        aircraftUuid,
        payload: JSON.stringify(order),
      });
      const card = taskCardSchema.parse({
        ...taskCardDefaults(aircraftUuid),
        uuid: cardUuid,
        version: 1,
        cardNumber: `SAMPLE-JC-${i + 1}`,
        title: "SAMPLE condition inspection job card",
        description: NOTE,
        inspectionUuid,
        workOrderUuid,
        workTaskUuid: task.uuid,
        createdAt: now,
        updatedAt: now,
        createdBy: user._id,
        technicianSignoff: null,
        inspectionSignoff: null,
        stepSignoffs: {},
      });
      await ctx.db.insert("taskCards", {
        uuid: cardUuid,
        aircraftUuid,
        payload: JSON.stringify(card),
      });
      const template = inspectionTemplateSchema.parse({
        ...emptyTemplate(),
        version: 1,
        programUuid: PROGRAM,
        name: `SAMPLE ${model} inspection template`,
        group: "SAMPLE training",
        description: NOTE,
        hours: 100,
        applicability: {
          kind: "aircraft",
          manufacturer: make,
          model,
          partNumber: "",
        },
        tasks: [
          {
            itemCode: "SAMPLE-01",
            instruction: NOTE + " Review this example record.",
            applicability: "Training only",
          },
        ],
      });
      await ctx.db.insert("inspectionTemplates", {
        uuid: template.uuid,
        programUuid: PROGRAM,
        payload: JSON.stringify(template),
      });
      const doc = emptyChecklist();
      doc.payload.metadata = {
        name: `SAMPLE ${model} checklist`,
        detail: NOTE,
        tailNumber: registration,
      };
      doc.payload.groups[0].items = [
        {
          objectId: crypto.randomUUID(),
          title: "SAMPLE Training",
          items: [
            "Preflight",
            "Engine Start",
            "Before Takeoff",
            "Shutdown",
          ].map((title) => ({
            objectId: crypto.randomUUID(),
            title,
            items: [
              {
                objectId: crypto.randomUUID(),
                type: "comment" as const,
                title: NOTE,
              },
              {
                objectId: crypto.randomUUID(),
                title: "Review sample screen",
                detail:
                  "Training only — use approved aircraft procedures for actual operations.",
              },
            ],
          })),
        },
      ];
      const checklist = checklistRecordSchema.parse({
        uuid: crypto.randomUUID(),
        version: 1,
        programUuid: PROGRAM,
        aircraftUuid,
        sourceName: "Sample training checklist",
        updatedAt: now,
        updatedBy: user._id,
        document: doc,
      });
      await ctx.db.insert("checklists", {
        uuid: checklist.uuid,
        programUuid: PROGRAM,
        aircraftUuid,
        payload: JSON.stringify(checklist),
      });
      for (let future = 0; future < 2; future++) {
        const plan = flightPlanSchema.parse({
          uuid: crypto.randomUUID(),
          version: 1,
          aircraftUuid,
          registration,
          departureAt: day(future ? i + 1 : -2) + "T12:00:00.000Z",
          origin: ["KCHA", "KAVL", "KTYS", "KTRI"][i],
          destination: ["KAVL", "KTYS", "KTRI", "KCHA"][i],
          alternate: "",
          durationMinutes: 60,
          cycles: 1,
          landings: 1,
          flightRules: "V",
          aircraftType: model,
          flightType: "G",
          speed: "N0120",
          level: "VFR",
          route: "DCT",
          pilotText: "Sample pilot",
          equipment: "",
          otherInformation: NOTE,
          sourceName: "Sample training plan",
          sourceHash: String(i * 2 + future + 1).padStart(64, "0"),
          status: "proposed",
          createdAt: now,
        });
        await ctx.db.insert("flightPlans", {
          uuid: plan.uuid,
          aircraftUuid,
          payload: JSON.stringify(plan),
        });
        if (!future)
          await ctx.db.insert("flights", {
            uuid: `sample-flight-${i + 1}`,
            aircraftUuid,
            flightPlanUuid: plan.uuid,
            authorId: user._id,
            pilotId: user._id,
            startTime: plan.departureAt,
            submittedAt: now,
            status: "accepted",
            hobbsOn: h,
            hobbsOff: h + 3600,
            tachOn: h,
            tachOff: h + 3600,
            cycles: 1,
            landings: 1,
            origin: plan.origin,
            destination: plan.destination,
            operation: "Private",
            flightRules: "VFR",
            remarks: NOTE,
            discrepancy: "",
            fuel: { unit: "US gal", start: 50, added: 0, end: 35 },
            oil: (twin
              ? (["left", "right"] as const)
              : (["single"] as const)
            ).map((engine) => ({
              engine,
              unit: "US qt" as const,
              start: 7,
              added: 0,
            })),
          });
      }
      await ctx.db.insert("discrepancies", {
        uuid: `sample-discrepancy-${i + 1}`,
        aircraftUuid,
        flightUuid: `sample-flight-${i + 1}`,
        description:
          NOTE +
          " " +
          [
            "Landing light intermittent",
            "Seat trim loose",
            "Cabin reading light inoperative",
            "Inspection panel fastener missing",
          ][i],
        status: "open",
        authorId: user._id,
        createdAt: now,
        requiredParts: [{ locationUuid, stockUuid, quantity: 1 }],
      });
      const ad = blankAD(aircraftUuid);
      ad.version = 1;
      ad.programUuid = PROGRAM;
      ad.updatedAt = now;
      ad.source.number = `SAMPLE-NOT-FAA-${i + 1}`;
      ad.source.subject = NOTE;
      ad.source.source = "Fictional training example — not an FAA directive";
      ad.source.make = make;
      ad.source.model = model;
      ad.reason = NOTE;
      adSchema.parse(ad);
      await ctx.db.insert("airworthiness", {
        uuid: ad.uuid,
        aircraftUuid,
        programUuid: PROGRAM,
        payload: JSON.stringify(ad),
      });
      const lineUuid = crypto.randomUUID();
      const po = poSchema.parse({
        uuid: poUuid,
        version: 1,
        programUuid: PROGRAM,
        number: `SAMPLE-PO-${i + 1}`,
        vendor: `SAMPLE Vendor ${i + 1}`,
        vendorContact: "sales@example.test",
        shipTo: "Sample Hangar — fictional address",
        expectedDate: day(7),
        currency: "USD",
        shippingCents: 0,
        notes: NOTE,
        phase: i === 0 ? "draft" : "issued",
        revision: 0,
        createdAt: now,
        updatedAt: now,
        ...(i ? { issuedAt: now } : {}),
        lines: [
          {
            uuid: lineUuid,
            stockUuid,
            locationUuid,
            partNumber: part,
            description: "SAMPLE replacement parts",
            quantity: 4,
            unitCents: 3500,
            kind: i === 3 ? "supply" : "part",
            inspectionUuid,
            aircraftUuid,
            workOrderUuid,
          },
        ],
        shipments:
          i >= 2
            ? [
                {
                  uuid: crypto.randomUUID(),
                  date: day(0),
                  carrier: "SAMPLE carrier",
                  tracking: `SAMPLE-TRACK-${i + 1}`,
                  lines: [{ lineUuid, quantity: i === 2 ? 2 : 4 }],
                },
              ]
            : [],
        receipts: [],
        history: [
          {
            at: now,
            actorId: user._id,
            action: "sample.created",
            reason: NOTE,
            requestUuid: crypto.randomUUID(),
            detail: "Fictional purchase order; no order was placed.",
          },
        ],
      });
      await ctx.db.insert("purchaseOrders", {
        uuid: poUuid,
        programUuid: PROGRAM,
        payload: JSON.stringify(po),
      });
      await ctx.db.insert("audit", {
        uuid: crypto.randomUUID(),
        programUuid: PROGRAM,
        aircraftUuid,
        actorId: user._id,
        at: now,
        action: "sample.created",
        entityUuid: aircraftUuid,
        reason: NOTE,
        after: JSON.stringify({ workOrderUuid, cardUuid, poUuid }),
      });
    }
    if (!user.activeProgramUuid)
      await ctx.db.patch(user._id, { activeProgramUuid: PROGRAM });
    return { programUuid: PROGRAM, created: true };
  },
});

// Document examples share four PDFs across their related records; no real certificates are fabricated.
export const attach = internalMutation({
  args: {
    files: v.array(v.object({ storageId: v.id("_storage"), size: v.number() })),
    email: v.string(),
  },
  handler: async (ctx, { files, email }) => {
    if (files.length !== 4)
      throw new Error("Exactly four example PDFs are required.");
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (!user?.isAdmin) throw new Error("Administrator required.");
    if (
      !(await ctx.db
        .query("programs")
        .withIndex("uuid", (q) => q.eq("uuid", PROGRAM))
        .unique())
    )
      throw new Error("Seed the sample program first.");
    const present = await ctx.db
      .query("manuals")
      .withIndex("uuid", (q) => q.eq("uuid", "sample-manual-1"))
      .unique();
    if (present) return { created: false };
    const orders = await ctx.db
      .query("purchaseOrders")
      .withIndex("program", (q) => q.eq("programUuid", PROGRAM))
      .collect();
    for (let i = 0; i < 4; i++) {
      const aircraftUuid = `sample-aircraft-${i + 1}`,
        file = files[i],
        name = `SAMPLE-training-document-${i + 1}.pdf`,
        at = Date.now();
      const wo = (
        await ctx.db
          .query("workOrders")
          .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
          .collect()
      )[0];
      const card = (
        await ctx.db
          .query("taskCards")
          .withIndex("aircraft", (q) => q.eq("aircraftUuid", aircraftUuid))
          .collect()
      )[0];
      const po = orders.find(
        (p) => JSON.parse(p.payload).lines[0].aircraftUuid === aircraftUuid,
      );
      if (!wo || !card || !po) throw new Error("Sample links are missing.");
      await ctx.db.insert("manuals", {
        uuid: `sample-manual-${i + 1}`,
        aircraftUuid,
        title: `SAMPLE training reference ${i + 1}`,
        documentNumber: `SAMPLE-DOC-${i + 1}`,
        revision: "Training only",
        revisionDate: new Date(at).toISOString().slice(0, 10),
        filename: name,
        size: file.size,
        pageCount: 1,
        storageId: file.storageId,
        uploadedAt: at,
        uploadedBy: user._id,
      });
      await ctx.db.insert("taskEvidence", {
        taskCardUuid: card.uuid,
        storageId: file.storageId,
        name,
        size: file.size,
        uploadedAt: at,
        category: "supporting-document",
      });
      await ctx.db.insert("inventoryFiles", {
        stockUuid: `sample-stock-${i + 1}`,
        storageId: file.storageId,
        name,
        type: "application/pdf",
        size: file.size,
        uploadedAt: at,
      });
      await ctx.db.insert("workOrderFiles", {
        workOrderUuid: wo.uuid,
        storageId: file.storageId,
        name,
        size: file.size,
        uploadedAt: at,
      });
      await ctx.db.insert("poFiles", {
        poUuid: po.uuid,
        programUuid: PROGRAM,
        storageId: file.storageId,
        name,
        type: "application/pdf",
        size: file.size,
        uploadedAt: at,
      });
    }
    return { created: true };
  },
});
