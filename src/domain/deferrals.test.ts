/**
 * Responsibility: Pins which reports ground their aircraft, deferral expiry by
 *   MEL category, days remaining, labels, the refusals when deferring or
 *   resolving a discrepancy, and the change-log entry each records.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/deferrals.ts, ./model, ./rejection,
 *   src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { demoSnapshot } from "../data/demo";
import {
  defectFoundOn,
  deferDiscrepancy,
  deferralDaysRemaining,
  deferralExpired,
  deferralExpiry,
  deferralLabel,
  isGroundingReport,
  resolveDiscrepancy,
  resolvedFields,
} from "./deferrals";
import { localDate } from "./model";
import { Rejection } from "./rejection";

const DAY_MS = 86_400_000;
// The demo report was made yesterday, so it was found by yesterday.
const FOUND_ON = localDate(Date.now() - DAY_MS);

const mel = (category: "A" | "B" | "C" | "D", days?: number) => ({
  type: "mel" as const,
  melItem: "33-1",
  category,
  days,
  placard: "INOP",
});
it("grounds the aircraft only for an open, undeferred grounding report", () => {
  const deferral = { type: "91.213d", placard: "INOP", notHazard: true };
  const open = { status: "open", grounding: true } as const;
  expect(isGroundingReport(open)).toBe(true);
  expect(isGroundingReport({ ...open, grounding: false })).toBe(false);
  expect(isGroundingReport({ ...open, grounding: undefined })).toBe(false);
  expect(isGroundingReport({ ...open, status: "resolved" })).toBe(false);
  expect(isGroundingReport({ ...open, deferral: deferral as never })).toBe(
    false,
  );
});

describe("deferral expiry", () => {
  it("adds the category interval to the date the defect was found", () => {
    expect(deferralExpiry(mel("B"), "2026-12-30")).toBe("2027-01-02");
    expect(deferralExpiry(mel("C"), "2026-02-20")).toBe("2026-03-02");
    expect(deferralExpiry(mel("D"), "2026-01-01")).toBe("2026-05-01");
    expect(deferralExpiry(mel("A", 5), "2026-01-01")).toBe("2026-01-06");
    expect(
      deferralExpiry(
        { type: "91.213d", placard: "INOP", notHazard: true },
        "2026-01-01",
      ),
    ).toBeUndefined();
  });
  it("stays valid through the expiry date and expires the day after", () => {
    const d = { expiresOn: "2026-01-04" };
    expect(deferralDaysRemaining(d, "2026-01-01")).toBe(3);
    expect(deferralDaysRemaining(d, "2026-01-04")).toBe(0);
    expect(deferralExpired(d, "2026-01-04")).toBe(false);
    expect(deferralDaysRemaining(d, "2026-01-05")).toBe(-1);
    expect(deferralExpired(d, "2026-01-05")).toBe(true);
    expect(deferralExpired({}, "2099-01-01")).toBe(false);
    expect(deferralDaysRemaining({}, "2026-01-01")).toBeUndefined();
  });
  it("names MEL and 91.213(d) deferrals", () => {
    const recorded = {
      deferredOn: "2026-01-01",
      deferredAt: 0,
      deferredBy: "u",
      deferredByName: "U",
    };
    expect(deferralLabel({ ...mel("C"), ...recorded })).toBe(
      "MEL 33-1 (Category C)",
    );
    expect(
      deferralLabel({
        type: "91.213d",
        placard: "INOP",
        notHazard: true,
        ...recorded,
      }),
    ).toBe("14 CFR 91.213(d) inoperative equipment");
  });
});

describe("deferring a discrepancy", () => {
  const today = localDate();
  const command = (deferral: unknown) => ({
    uuid: "demo-report",
    foundOn: FOUND_ON,
    deferredOn: today,
    deferral,
  });
  it("records an MEL deferral with expiry and actor without mutating input", () => {
    const s = demoSnapshot();
    const before = structuredClone(s.discrepancies[0]);
    const now = Date.now();
    const d = deferDiscrepancy(s, command(mel("B")), now);
    expect(s.discrepancies[0]).toEqual(before);
    expect(d.deferral).toEqual({
      ...mel("B"),
      days: undefined,
      foundOn: FOUND_ON,
      deferredOn: today,
      deferredAt: now,
      deferredBy: "demo-admin",
      deferredByName: "Alex Morgan",
      expiresOn: deferralExpiry(mel("B"), FOUND_ON),
    });
  });
  it("requires custom days for category A only", () => {
    const s = demoSnapshot();
    expect(() => deferDiscrepancy(s, command(mel("A")))).toThrow("Category A");
    expect(() => deferDiscrepancy(s, command(mel("C", 4)))).toThrow(
      "Category A",
    );
    expect(deferDiscrepancy(s, command(mel("A", 2))).deferral?.expiresOn).toBe(
      deferralExpiry(mel("A", 2), FOUND_ON),
    );
  });
  it("requires the 91.213(d) hazard determination and records no expiry", () => {
    const s = demoSnapshot();
    expect(() =>
      deferDiscrepancy(
        s,
        command({ type: "91.213d", placard: "INOP", notHazard: false }),
      ),
    ).toThrow("not to be a hazard");
    const d = deferDiscrepancy(
      s,
      command({ type: "91.213d", placard: "INOP", notHazard: true }),
    );
    expect(d.deferral).toMatchObject({ type: "91.213d", expiresOn: undefined });
  });
  it("rejects resolved, already deferred, backdated and unauthorized deferrals", () => {
    const s = demoSnapshot();
    expect(() =>
      deferDiscrepancy(s, { ...command(mel("B")), deferredOn: "2020-01-01" }),
    ).toThrow("must be today");
    s.discrepancies[0] = deferDiscrepancy(s, command(mel("B")));
    expect(() => deferDiscrepancy(s, command(mel("C")))).toThrow(
      "already deferred",
    );
    s.discrepancies[0] = {
      ...s.discrepancies[0],
      deferral: undefined,
      status: "resolved",
    };
    expect(() => deferDiscrepancy(s, command(mel("C")))).toThrow(
      "Only open discrepancies",
    );
    const pilot = demoSnapshot();
    pilot.user = { ...pilot.members[1] };
    expect(() => deferDiscrepancy(pilot, command(mel("C")))).toThrow(
      "permission",
    );
    expect(() =>
      deferDiscrepancy(demoSnapshot(), { ...command(mel("C")), uuid: "x" }),
    ).toThrow("Report not found");
  });
  it("refuses each case as a Rejection", () => {
    const refusal = (s: ReturnType<typeof demoSnapshot>, raw: unknown) => {
      try {
        deferDiscrepancy(s, raw);
      } catch (error) {
        return error;
      }
    };
    const deferred = demoSnapshot();
    deferred.discrepancies[0] = deferDiscrepancy(deferred, command(mel("B")));
    const resolved = demoSnapshot();
    resolved.discrepancies[0].status = "resolved";
    const pilot = demoSnapshot();
    pilot.user = { ...pilot.members[1] };
    for (const [s, raw, message] of [
      [
        demoSnapshot(),
        { ...command(mel("C")), uuid: "x" },
        "Report not found.",
      ],
      [
        pilot,
        command(mel("C")),
        "You do not have permission for this aircraft.",
      ],
      [resolved, command(mel("C")), "Only open discrepancies can be deferred."],
      [deferred, command(mel("C")), "This discrepancy is already deferred."],
      [
        demoSnapshot(),
        { ...command(mel("B")), deferredOn: "2020-01-01" },
        "The deferral date must be today.",
      ],
    ] as const) {
      const error = refusal(s, raw);
      expect(error).toBeInstanceOf(Rejection);
      expect(error).toHaveProperty("message", message);
    }
  });
});

describe("the date the defect was found (MX-3)", () => {
  const uuid = "demo-report";
  const REPORTED = Date.parse("2026-11-02T15:00:00Z");
  const DEFERRED_AT = REPORTED + 5 * DAY_MS;
  const reportedOnNov2 = () => {
    const s = demoSnapshot();
    s.discrepancies[0].createdAt = REPORTED;
    return s;
  };
  const deferFound = (foundOn: string) =>
    deferDiscrepancy(
      reportedOnNov2(),
      { uuid, foundOn, deferredOn: "2026-11-07", deferral: mel("B") },
      DEFERRED_AT,
    );

  it("starts an MEL repair interval, however late the deferral is entered", () => {
    expect(deferFound("2026-11-02").deferral).toMatchObject({
      foundOn: "2026-11-02",
      deferredOn: "2026-11-07",
      expiresOn: "2026-11-05",
    });
  });
  it("may be before the report, or its date anywhere, but not after", () => {
    expect(deferFound("2026-10-30").deferral?.expiresOn).toBe("2026-11-02");
    // 15:00 UTC on 2 Nov was already 3 Nov in the furthest-ahead zone.
    expect(deferFound("2026-11-03").deferral?.expiresOn).toBe("2026-11-06");
    expect(() => deferFound("2026-11-04")).toThrow(
      new Rejection("The defect cannot have been found after it was reported."),
    );
  });
  it("is required", () => {
    expect(() =>
      deferDiscrepancy(
        reportedOnNov2(),
        { uuid, deferredOn: "2026-11-07", deferral: mel("B") },
        DEFERRED_AT,
      ),
    ).toThrow(z.ZodError);
  });
  it("reads as the report's own date until a deferral records one", () => {
    const report = reportedOnNov2().discrepancies[0];
    expect(defectFoundOn(report)).toBe(localDate(REPORTED));
    const { foundOn, ...older } = deferFound("2026-10-30").deferral!;
    expect(foundOn).toBe("2026-10-30");
    expect(defectFoundOn({ ...report, deferral: older })).toBe(
      localDate(REPORTED),
    );
    expect(defectFoundOn({ ...report, deferral: { ...older, foundOn } })).toBe(
      "2026-10-30",
    );
  });
});

describe("resolving a discrepancy", () => {
  const uuid = "demo-report";
  it("records the trimmed repair, the user and the time without mutating input", () => {
    const s = demoSnapshot();
    const before = structuredClone(s.discrepancies[0]);
    const d = resolveDiscrepancy(s, uuid, "  Replaced the seal ", 1234);
    expect(s.discrepancies[0]).toEqual(before);
    expect(d).toEqual({
      ...before,
      status: "resolved",
      resolution: "Replaced the seal",
      resolvedBy: "demo-admin",
      resolvedAt: 1234,
    });
    expect(
      resolveDiscrepancy(s, uuid, "x".repeat(5000)).resolution,
    ).toHaveLength(5000);
  });
  it("refuses each case as a Rejection", () => {
    const refusal = (
      s: ReturnType<typeof demoSnapshot>,
      id: string,
      text: string,
    ) => {
      try {
        resolveDiscrepancy(s, id, text);
      } catch (error) {
        return error;
      }
    };
    const resolved = demoSnapshot();
    resolved.discrepancies[0].status = "resolved";
    const pilot = demoSnapshot();
    pilot.user = { ...pilot.members[1] };
    const length = "Describe the repair in 1–5000 characters.";
    for (const [s, id, text, message] of [
      [demoSnapshot(), "x", "Fixed", "Report not found."],
      [pilot, uuid, "Fixed", "You do not have permission for this aircraft."],
      [demoSnapshot(), uuid, " ", length],
      [demoSnapshot(), uuid, "x".repeat(5001), length],
      // The limit counts the text as entered, before trimming.
      [demoSnapshot(), uuid, "x".repeat(4999) + "  ", length],
      [resolved, uuid, "Fixed", "This report is already resolved."],
    ] as const) {
      const error = refusal(s, id, text);
      expect(error, message).toBeInstanceOf(Rejection);
      expect(error).toMatchObject({ message });
    }
  });
});

describe("the change-log entry", () => {
  const uuid = "demo-report";
  it("records a deferral: the placard, the report before and the deferral", () => {
    const s = demoSnapshot();
    const report = structuredClone(s.discrepancies[0]);
    const log = s.audit.length;
    const command = {
      uuid,
      foundOn: FOUND_ON,
      deferredOn: localDate(),
      deferral: mel("B"),
    };
    const now = Date.now();
    const next = deferDiscrepancy(s, command, now);
    expect(s.audit).toHaveLength(log + 1);
    expect(s.audit[0]).toEqual({
      uuid: expect.any(String),
      programUuid: "demo-program",
      actorId: "demo-admin",
      at: now,
      action: "discrepancy.deferred",
      entityUuid: uuid,
      aircraftUuid: report.aircraftUuid,
      reason: "INOP",
      before: JSON.stringify(report),
      after: JSON.stringify(next.deferral),
    });
  });
  it("records a resolution: the repair as entered, the report before and the resolved fields", () => {
    const s = demoSnapshot();
    const report = structuredClone(s.discrepancies[0]);
    const log = s.audit.length;
    const next = resolveDiscrepancy(s, uuid, "  Replaced the seal ", 1234);
    expect(s.audit).toHaveLength(log + 1);
    expect(s.audit[0]).toEqual({
      uuid: expect.any(String),
      programUuid: "demo-program",
      actorId: "demo-admin",
      at: 1234,
      action: "discrepancy.resolved",
      entityUuid: uuid,
      aircraftUuid: report.aircraftUuid,
      reason: "  Replaced the seal ",
      before: JSON.stringify(report),
      after: JSON.stringify({
        status: "resolved",
        resolution: "Replaced the seal",
        resolvedBy: "demo-admin",
        resolvedAt: 1234,
      }),
    });
    expect(Object.keys(resolvedFields(next))).toEqual([
      "status",
      "resolution",
      "resolvedBy",
      "resolvedAt",
    ]);
  });
  it("records nothing for a refusal", () => {
    const s = demoSnapshot();
    s.discrepancies[0].status = "resolved";
    const log = structuredClone(s.audit);
    expect(() => resolveDiscrepancy(s, uuid, "Again")).toThrow(Rejection);
    expect(() =>
      deferDiscrepancy(s, {
        uuid,
        foundOn: FOUND_ON,
        deferredOn: localDate(),
        deferral: mel("B"),
      }),
    ).toThrow(Rejection);
    expect(s.audit).toEqual(log);
  });
});
