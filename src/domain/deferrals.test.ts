import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  deferDiscrepancy,
  deferralDaysRemaining,
  deferralExpired,
  deferralExpiry,
} from "./deferrals";
import { localDate } from "./model";

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
});
