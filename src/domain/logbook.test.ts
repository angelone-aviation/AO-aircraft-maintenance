/**
 * Responsibility: Pins the generated logbook entry text for each template,
 *   for closed, historical and previewed orders, the unsigned records copy,
 *   its refusal, and the signer's license fields.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/logbook.ts, workOrders.ts, rejection.ts,
 *   validationText.ts, src/data/demo.ts and tests/fixtures/workOrders.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { workOrderCommand } from "../../tests/fixtures/workOrders";
import { licenseSchema, logbookRecordText, logbookText } from "./logbook";
import { Rejection } from "./rejection";
import { validationText } from "./validationText";
import {
  saveWorkOrder,
  workOrderFieldsSchema,
  type WorkOrder,
} from "./workOrders";

const now = Date.parse("2026-10-02T12:00:00Z");
const signer = { name: "Alex", licenseNumber: "123", certificateType: "A&P" };

function closedOrder() {
  const s = demoSnapshot();
  const order = saveWorkOrder(s, workOrderCommand(), now);
  const final = saveWorkOrder(
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
        finalReview: "Reviewed",
      },
      tasks: [],
    },
    now,
  );
  final.closeout!.aircraft = {
    ...final.closeout!.aircraft,
    registration: "N1",
    make: "Cessna",
    model: "206",
    serial: "",
    totalSeconds: 360_000,
    hobbs: 3600,
    tach: 7200,
    cycles: 5,
    landings: undefined,
  };
  return { s, final };
}

describe("licenseSchema", () => {
  const refusal = (fields: object) => {
    const parsed = licenseSchema.safeParse(fields);
    return parsed.success ? "" : validationText(parsed.error);
  };
  it("asks for each field in plain words, trimmed, up to 100 characters", () => {
    expect(refusal({ licenseNumber: " ", certificateType: "" })).toBe(
      "Enter a license / certificate number of up to 100 characters.\nEnter a certificate type of up to 100 characters.",
    );
    expect(
      refusal({ licenseNumber: "1".repeat(101), certificateType: "A&P" }),
    ).toBe("Enter a license / certificate number of up to 100 characters.");
    expect(
      licenseSchema.parse({
        licenseNumber: ` ${"1".repeat(100)} `,
        certificateType: " A&P ",
      }),
    ).toEqual({ licenseNumber: "1".repeat(100), certificateType: "A&P" });
  });
});

describe("logbook entry", () => {
  it("writes a component entry from the close-out, line for line", () => {
    const { s, final } = closedOrder();
    Object.assign(final.closeout!, {
      workPerformed: "Replaced the left magneto.",
      performers: [
        { userId: "jamie", name: "Jamie Lee" },
        { userId: "alex", name: " ALEX " },
      ],
      aircraft: { ...final.closeout!.aircraft, flightTimeLog: 7200 },
      components: [
        {
          componentUuid: "magneto",
          label: "Left magneto",
          manufacturer: "Slick",
          model: "",
          partNumber: "",
          serial: "SN1",
          timeSinceNew: 36_000,
          timeSinceOverhaul: null,
          timeSinceRepair: 0,
          cyclesSinceNew: null,
          serviceDays: 12,
        },
      ],
      compliance: [
        {
          uuid: "hundred",
          kind: "inspection",
          description: "100-hour",
          date: "2026-10-02",
          timeBasis: "TSN",
          seconds: 360_000,
          cycles: 10,
          landings: 12,
          dueDate: "2027-10-02",
          dueSeconds: 720_000,
          dueCycles: 20,
          dueLandings: 24,
        },
        {
          uuid: "oil",
          kind: "componentRequirement",
          description: "Oil",
          date: "2026-10-02",
        },
      ],
    } satisfies Partial<NonNullable<WorkOrder["closeout"]>>);
    final.revisions = [
      {
        number: 1,
        recordedAt: now,
        authorId: "pat",
        authorName: "Pat",
        reason: "Typo",
        previousRecord: "{}",
      },
    ];
    const approved = { approvedForReturnToService: true };
    const text = logbookText(
      s,
      final,
      "component",
      { ...signer, name: "alex" },
      undefined,
      approved,
    );
    expect(text).toBe(
      [
        "Component service / replacement logbook entry",
        "Date: 10/02/2026",
        "Aircraft Total Time: 100.0 Hours",
        "Aircraft: N1 — Cessna 206; S/N Not recorded",
        "Aircraft total time: 100.0 h; Hobbs: 1.0 h; Tach: 2.0 h; Cycles: 5",
        "Flight time log: 2.0 h",
        "Work order: WO-2026-0001",
        "Revision 1 — 2026-10-02T12:00:00.000Z — Pat",
        "Correction reason: Typo",
        "",
        "Work performed:",
        "Replaced the left magneto.",
        "",
        "Component: Left magneto — Slick",
        "P/N Not recorded; S/N SN1",
        "TSN: 10.0 h; TSO: Not recorded; TSR: 0.0 h; Cycles: Not tracked; Service days: 12",
        "",
        "Inspection compliance recorded:",
        "100-hour: 2026-10-02 at 100.0 h TSN, 10 cycles, 12 aircraft landings. Next due: 2027-10-02 / 200.0 h TSN / 20 cycles / 24 aircraft landings.",
        "Oil: 2026-10-02. Next due: No recurring interval.",
        "",
        "Approved for return to service.",
        "",
        "The work performed on the aircraft component part identified above has been performed satisfactorily. The aircraft is approved for return to service only for the work performed.",
        "",
        "Performed by: Jamie Lee",
        "Name: alex",
        "Certificate / license: A&P 123",
        "Signature: ______________________________",
        "",
      ].join("\n"),
    );
  });

  it("words the AD template and the inspection statement by type", () => {
    const { s, final } = closedOrder();
    final.revisedWorkPerformed = "Revised wording.";
    const ad = logbookText(s, final, "ad", {
      name: "Alex",
      licenseNumber: "",
      certificateType: "",
    });
    expect(ad).toMatch(
      /^AD compliance logbook entry\nDate completed: 2026-10-02\nAircraft: N1/,
    );
    expect(ad).toContain(
      "\nWork and compliance references:\nRevised wording.\n\nApproved",
    );
    expect(ad).toContain(
      "\nCertifying person: Alex\nCertificate / license: [enter certificate type] [enter license number]\n",
    );
    const inspection = logbookText(s, final, "inspection", signer, {
      type: "100-hour",
      checklist: " Rev 12 ",
      reviewedThrough: " Issue 26-20 ",
      airworthy: true,
    });
    expect(inspection).toContain(
      "\n\nCompleted a 100-Hour inspection of this aircraft in accordance with the scope and detail of 14 CFR Part 43, Appendix D, and Rev 12. Service Bulletins and Airworthiness Directives checked through Issue 26-20.\n\nWork performed:\n",
    );
    expect(inspection).toContain(
      "\nI certify that this aircraft has been inspected in accordance with a 100-hour inspection and was determined to be in airworthy condition.\n\n",
    );
  });

  it("writes the records copy without certification or signature lines", () => {
    const { s, final } = closedOrder();
    Object.assign(final.closeout!, {
      workPerformed: "Replaced the left magneto.",
      performers: [
        { userId: "jamie", name: "Jamie Lee" },
        { userId: "alex", name: "Alex Morgan" },
      ],
    });
    const text = logbookRecordText(s, final);
    expect(text).toMatch(
      /^Maintenance \/ inspection logbook entry\nDate completed: 2026-10-02\n/,
    );
    expect(text).toContain("\nWork performed:\nReplaced the left magneto.\n");
    expect(text).toMatch(
      /\nApproved for return to service\.\n\nPerformed by: Jamie Lee, Alex Morgan$/,
    );
    expect(text).not.toContain("Certifying person");
    expect(text).not.toContain("Signature");
    const open = { ...final, status: "open" as const };
    expect(() => logbookRecordText(s, open)).toThrow(
      new Rejection(
        "Complete the work order before generating a logbook entry.",
      ),
    );
  });

  it("marks an order closed without a close-out as historical", () => {
    const { s, final } = closedOrder();
    const historical: WorkOrder = {
      ...final,
      closeout: undefined,
      componentReadings: [
        {
          recordedAt: now,
          componentUuid: "engine",
          label: "Engine",
          partNumber: "PN",
          serial: "SN",
          timeSinceNew: null,
          timeSinceOverhaul: null,
          timeSinceRepair: null,
          cyclesSinceNew: 4,
        },
      ],
    };
    const readings =
      "\nP/N PN; S/N SN\nTSN: Not recorded; TSO: Not recorded; TSR: Not recorded; Cycles: 4\n";
    const text = logbookText(s, historical, "maintenance", signer);
    expect(text).toContain(
      "\nWork order: WO-2026-0001\nHistorical work order: the readings above were recorded when the order opened. Confirm completion readings before signing.\n\n",
    );
    expect(text).toContain(`\nComponent: Engine (opening readings)${readings}`);
    const draft = logbookText(
      s,
      historical,
      "maintenance",
      signer,
      undefined,
      undefined,
      true,
    );
    expect(draft).not.toContain("Historical work order");
    expect(draft).toContain(`\nComponent: Engine${readings}`);
  });

  it("drafts an open order only as a preview", () => {
    const s = demoSnapshot();
    const open = saveWorkOrder(s, workOrderCommand(), now);
    const finish = () => logbookText(s, open, "maintenance", signer);
    expect(finish).toThrow(Rejection);
    expect(finish).toThrow(
      Error("Complete the work order before generating a logbook entry."),
    );
    const draft = logbookText(
      s,
      open,
      "maintenance",
      signer,
      undefined,
      undefined,
      true,
    );
    expect(draft).toContain(
      "\nWork performed:\n[Select Include in log book entry on a task or job card to see its wording here.]\n",
    );
  });

  it("prints the wording prompt for a blank close-out or revised wording", () => {
    const { s, final } = closedOrder();
    const prompted =
      "\nWork performed:\n[Select Include in log book entry on a task or job card to see its wording here.]\n\nApproved for return to service.\n";
    expect(final.closeout!.workPerformed).toBe("");
    expect(logbookText(s, final, "maintenance", signer)).toContain(prompted);
    const revised = { ...final, revisedWorkPerformed: " " };
    expect(logbookText(s, revised, "maintenance", signer)).toContain(prompted);
  });
});
