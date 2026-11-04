/**
 * Responsibility: Pins deferral expiry by MEL category, days remaining, labels,
 *   the refusals when deferring or resolving a discrepancy, and the
 *   change-log entry each records.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/deferrals.ts, ./model, ./rejection,
 *   src/data/demo.ts (seed).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  deferDiscrepancy,
  deferralDaysRemaining,
  deferralExpired,
  deferralExpiry,
  deferralLabel,
  resolveDiscrepancy,
  resolvedFields,
} from "./deferrals";
import { localDate } from "./model";
import { Rejection } from "./rejection";

const mel = (category: "A" | "B" | "C" | "D", days?: number) => ({
  type: "mel" as const,
  melItem: "33-1",
  category,
  days,
  placard: "INOP",
});
describe("deferral expiry", () => {
  it("adds the category interval to the deferral date", () => {
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
      deferredOn: today,
      deferredAt: now,
      deferredBy: "demo-admin",
      deferredByName: "Alex Morgan",
      expiresOn: deferralExpiry(mel("B"), today),
    });
  });
  it("requires custom days for category A only", () => {
    const s = demoSnapshot();
    expect(() => deferDiscrepancy(s, command(mel("A")))).toThrow("Category A");
    expect(() => deferDiscrepancy(s, command(mel("C", 4)))).toThrow(
      "Category A",
    );
    expect(deferDiscrepancy(s, command(mel("A", 2))).deferral?.expiresOn).toBe(
      deferralExpiry(mel("A", 2), today),
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
        deferredOn: localDate(),
        deferral: mel("B"),
      }),
    ).toThrow(Rejection);
    expect(s.audit).toEqual(log);
  });
});
