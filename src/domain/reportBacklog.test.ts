/**
 * Responsibility: Pins one member's open problem-report backlog: what counts,
 *   the per-member limit on new reports and what it never blocks, and the
 *   alert its administrators get first (decision D2).
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/reportBacklog.ts, flightSubmission.ts,
 *   deferrals.ts, alerts.ts, model.ts, src/data/demo.ts (fixture).
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Discrepancy, Snapshot } from "./model";
import {
  MAX_OPEN_REPORTS_PER_MEMBER,
  MAX_OPEN_REPORT_BYTES_PER_MEMBER,
  REPORT_LIMIT_REFUSAL,
  reportBacklog,
} from "./reportBacklog";
import {
  FlightRejection,
  submitOperation,
  type DiscrepancyOperation,
  type FlightOperation,
} from "./flightSubmission";
import { deferDiscrepancy, resolveDiscrepancy } from "./deferrals";
import { computeAlerts, urgentAlerts } from "./alerts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const OPTIONS = { now: NOW, today: "2026-10-20" };
const LONG_REPORT_BYTES = 5000;

// The demo program with only the given reports, all by the signed-in user
// on its first aircraft unless they say otherwise.
function withReports(...descriptions: string[]): Snapshot {
  const s = demoSnapshot();
  s.inspections = [];
  s.airworthiness = [];
  s.discrepancies = descriptions.map((description, i) =>
    filed(s, { uuid: `open-${i}`, description }),
  );
  return s;
}
function filed(s: Snapshot, over: Partial<Discrepancy>): Discrepancy {
  return {
    uuid: crypto.randomUUID(),
    aircraftUuid: s.aircraft[0].uuid,
    description: "Report",
    status: "open",
    authorId: s.user.id,
    createdAt: NOW,
    ...over,
  };
}
const newReport = (s: Snapshot, description: string): DiscrepancyOperation => ({
  kind: "discrepancy",
  programUuid: "demo-program",
  uuid: "33333333-3333-4333-8333-333333333333",
  authorId: s.user.id,
  aircraftUuid: s.aircraft[0].uuid,
  description,
});
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal.");
};

describe("a member's open report backlog", () => {
  it("counts their open, undeferred reports in this program, in UTF-8 bytes", () => {
    const s = withReports("ab", "é€");
    const other = { ...s.aircraft[0], uuid: "elsewhere", programUuid: "other" };
    s.aircraft.push(other);
    s.discrepancies.push(
      filed(s, { status: "resolved" }),
      filed(s, {
        deferral: {
          type: "91.213d",
          placard: "INOP",
          notHazard: true,
        } as never,
      }),
      filed(s, { authorId: "someone-else" }),
      filed(s, { aircraftUuid: other.uuid }),
    );
    expect(reportBacklog(s, s.user.id)).toEqual({
      authorId: s.user.id,
      count: 2,
      bytes: 2 + 2 + 3,
    });
  });
});

describe("the per-member limit on new reports (D2)", () => {
  it(`refuses a report past ${MAX_OPEN_REPORTS_PER_MEMBER} open ones, as a permanent refusal`, () => {
    const full = withReports(
      ...Array(MAX_OPEN_REPORTS_PER_MEMBER).fill("Short"),
    );
    const error = refusal(() =>
      submitOperation(full, newReport(full, "One more"), OPTIONS),
    );
    expect(error).toBeInstanceOf(FlightRejection);
    expect(error).toHaveProperty("message", REPORT_LIMIT_REFUSAL);
    expect(REPORT_LIMIT_REFUSAL).toMatch(
      /ask an administrator to resolve or defer/i,
    );
    const room = withReports(
      ...Array(MAX_OPEN_REPORTS_PER_MEMBER - 1).fill("Short"),
    );
    expect(
      submitOperation(room, newReport(room, "Last one"), OPTIONS).status,
    ).toBe("accepted");
  });
  it(`refuses a report that takes their open text past ${MAX_OPEN_REPORT_BYTES_PER_MEMBER} bytes`, () => {
    const reports = Math.floor(
      MAX_OPEN_REPORT_BYTES_PER_MEMBER / LONG_REPORT_BYTES,
    );
    const s = withReports(
      ...Array(reports).fill("x".repeat(LONG_REPORT_BYTES)),
    );
    const left = MAX_OPEN_REPORT_BYTES_PER_MEMBER - reports * LONG_REPORT_BYTES;
    expect(() =>
      submitOperation(s, newReport(s, "x".repeat(left + 1)), OPTIONS),
    ).toThrow(REPORT_LIMIT_REFUSAL);
    expect(
      submitOperation(s, newReport(s, "x".repeat(left)), OPTIONS).status,
    ).toBe("accepted");
  });
  it("refuses a flight that files a report past the limit, not one without", () => {
    const s = withReports(...Array(MAX_OPEN_REPORTS_PER_MEMBER).fill("Short"));
    const a = s.aircraft[0];
    const flight = (discrepancy: string): FlightOperation => ({
      kind: "flight",
      programUuid: "demo-program",
      uuid: "44444444-4444-4444-8444-444444444444",
      authorId: s.user.id,
      baseVersion: a.version,
      input: {
        aircraftUuid: a.uuid,
        pilotId: s.user.id,
        startTime: "2026-10-20T10:00:00Z",
        hobbsOn: a.currentHobbs + 3600,
        tachOn: a.currentTach + 3240,
        landings: 1,
        cycles: 1,
        origin: "AAA",
        destination: "BBB",
        operation: "Mission",
        flightRules: "VFR",
        remarks: "",
        discrepancy,
      },
    });
    expect(() =>
      submitOperation(s, flight("Left brake soft"), OPTIONS),
    ).toThrow(REPORT_LIMIT_REFUSAL);
    expect(submitOperation(s, flight(""), OPTIONS).status).toBe("accepted");
  });
  it("never refuses a resent report, a resolution or a deferral", () => {
    const s = withReports(...Array(MAX_OPEN_REPORTS_PER_MEMBER).fill("Short"));
    const resent = { ...newReport(s, "Short"), uuid: "open-0" };
    s.discrepancies[0] = { ...s.discrepancies[0], uuid: "open-0" };
    expect(submitOperation(s, resent, OPTIONS).status).toBe("accepted");
    expect(resolveDiscrepancy(s, "open-1", "Fixed", NOW).status).toBe(
      "resolved",
    );
    const deferred = deferDiscrepancy(
      s,
      {
        uuid: "open-2",
        foundOn: "2026-10-20",
        deferredOn: "2026-10-20",
        deferral: { type: "91.213d", placard: "INOP", notHazard: true },
      },
      NOW,
    );
    expect(deferred.deferral).toBeDefined();
  });
});

describe("the alert administrators get first (D2)", () => {
  const TODAY = "2026-10-20";
  const ALERT_REPORTS = MAX_OPEN_REPORTS_PER_MEMBER / 2;
  const backlogAlerts = (s: Snapshot) =>
    computeAlerts(s, TODAY).filter((a) => a.kind === "report-backlog");
  // A pilot's reports, read by the demo program's administrator.
  function filedByPilot(...descriptions: string[]) {
    const s = withReports(...descriptions);
    const pilot = s.members.find((m) => !m.isAdmin)!;
    for (const d of s.discrepancies) d.authorId = pilot.id;
    return { s, pilot };
  }

  it(`alerts at half the count limit, ${ALERT_REPORTS} open reports, at once`, () => {
    const { s, pilot } = filedByPilot(...Array(ALERT_REPORTS).fill("Short"));
    const alerts = backlogAlerts(s);
    expect(alerts).toEqual([
      {
        key: `report-backlog|${pilot.id}`,
        kind: "report-backlog",
        severity: "danger",
        title: `${pilot.name} has ${ALERT_REPORTS} open problem reports`,
        detail: expect.stringContaining(
          `New reports from them are refused past ${MAX_OPEN_REPORTS_PER_MEMBER}`,
        ),
        entityUuid: pilot.id,
        link: "/discrepancies",
      },
    ]);
    expect(urgentAlerts(alerts)).toEqual(alerts);
    s.discrepancies.pop();
    expect(backlogAlerts(s)).toEqual([]);
  });
  it("alerts at half the text limit, and keeps one key as the backlog grows", () => {
    const half = MAX_OPEN_REPORT_BYTES_PER_MEMBER / 2;
    const { s } = filedByPilot("x".repeat(half - 1));
    expect(backlogAlerts(s)).toEqual([]);
    s.discrepancies.push({
      ...s.discrepancies[0],
      uuid: "more",
      description: "x",
    });
    const [first] = backlogAlerts(s);
    s.discrepancies.push({ ...s.discrepancies[0], uuid: "even-more" });
    expect(backlogAlerts(s)[0].key).toBe(first.key);
  });
  it("is for the program's administrators only, and clears once reports are deferred", () => {
    const { s, pilot } = filedByPilot(...Array(ALERT_REPORTS).fill("Short"));
    const asPilot = { ...s, user: pilot };
    expect(backlogAlerts(asPilot)).toEqual([]);
    s.discrepancies[0].deferral = {
      type: "91.213d",
      placard: "INOP",
      notHazard: true,
    } as never;
    expect(backlogAlerts(s)).toEqual([]);
  });
});
