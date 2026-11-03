import { describe, it, expect } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  can,
  isLocalToday,
  latestLocalDate,
  localDate,
  offlineValid,
  OFFLINE_WINDOW,
  parseHours,
  type Flight,
  type FlightInput,
} from "./model";
import { validateFlight, conflictReason, rebuildFlights } from "./flights";
import {
  endOfDueMonth,
  inspectionDueDate,
  inspectionStatus,
} from "./maintenance";
import { toCsv } from "./csv";
const input: FlightInput = {
  aircraftUuid: "demo-206",
  pilotId: "demo-admin",
  startTime: "2026-01-01T10:00:00Z",
  hobbsOn: 2342 * 3600,
  landings: 1,
  cycles: 1,
  origin: "AAA",
  destination: "BBB",
  operation: "Mission",
  flightRules: "VFR",
  remarks: "",
  discrepancy: "",
};
describe("flight integrity", () => {
  it("requires the selected tracking meter, not both meters", () => {
    const a = demoSnapshot().aircraft[0];
    expect(() => validateFlight(a, input)).not.toThrow();
    expect(() =>
      validateFlight(a, { ...input, hobbsOn: undefined, tachOn: 5000 * 3600 }),
    ).toThrow("hobbs");
  });
  it("holds stale versions, decreasing meters and backdated flights", () => {
    const a = demoSnapshot().aircraft[0];
    expect(conflictReason(a, input, 1)).toContain("changed");
    expect(conflictReason(a, { ...input, hobbsOn: 1 }, 0)).toContain("lower");
    expect(
      conflictReason(
        { ...a, latestFlightAt: "2026-02-01T00:00:00Z" },
        input,
        0,
      ),
    ).toContain("Backdated");
  });
  it("rebuilds backdated accepted flights without counting baselines twice", () => {
    const a = demoSnapshot().aircraft[0];
    const first: Flight = {
      ...input,
      uuid: "1",
      authorId: "a",
      submittedAt: 0,
      status: "accepted",
    };
    const second: Flight = {
      ...first,
      uuid: "2",
      startTime: "2026-01-02T10:00:00Z",
      hobbsOn: 2343 * 3600,
    };
    const result = rebuildFlights(a, [second, first]);
    expect(result.aircraft.currentHobbs).toBe(2343 * 3600);
    expect(result.aircraft.cycles).toBe(a.baselineCycles + 2);
    expect(result.flights[1].hobbsOff).toBe(2342 * 3600);
  });
  it("rejects corrections that break a later meter reading", () => {
    const a = demoSnapshot().aircraft[0];
    const first: Flight = {
      ...input,
      uuid: "1",
      authorId: "a",
      submittedAt: 0,
      status: "accepted",
      hobbsOn: 2344 * 3600,
    };
    const second: Flight = {
      ...first,
      uuid: "2",
      startTime: "2026-01-02T00:00:00Z",
      hobbsOn: 2343 * 3600,
    };
    expect(() => rebuildFlights(a, [first, second])).toThrow("lower");
  });
  it("preserves decimal hours exactly as integer seconds", () => {
    expect(parseHours("1234.5")).toBe(4444200);
    expect(parseHours("")).toBeUndefined();
    expect(() => parseHours("1.23")).toThrow();
    expect(() => parseHours("-1")).toThrow();
  });
});
describe("access and deadlines", () => {
  it("expires seven days from authentication, regardless of recent synchronization", () => {
    const s = demoSnapshot();
    expect(offlineValid(s, s.authenticatedAt + OFFLINE_WINDOW - 1)).toBe(true);
    expect(
      offlineValid(
        { ...s, syncedAt: s.authenticatedAt + OFFLINE_WINDOW },
        s.authenticatedAt + OFFLINE_WINDOW,
      ),
    ).toBe(false);
    expect(offlineValid(s, s.authenticatedAt - 1)).toBe(false);
  });
  it("requires aircraft scope and read permission along with writes", () => {
    const s = demoSnapshot();
    s.user = s.members[1];
    expect(can(s, "demo-206", "flight")).toBe(true);
    expect(can(s, "unassigned", "flight")).toBe(false);
    s.groups[0].permissions = ["flight"];
    expect(can(s, "demo-206", "flight")).toBe(false);
    s.user.active = false;
    expect(can(s, "demo-206", "read")).toBe(false);
  });
  it("flags recurring inspections from compliance even when the stored date is a month late", () => {
    const a = demoSnapshot().aircraft[0];
    const i = {
      uuid: "phase-2",
      aircraftUuid: a.uuid,
      reference: "Phase 2",
      description: "",
      lastDate: "2025-12-12",
      intervalMonths: 12,
      dueDate: "2027-01-31",
    };
    expect(endOfDueMonth(i.lastDate, i.intervalMonths)).toBe("2026-12-31");
    expect(inspectionDueDate(i)).toBe("2026-12-31");
    expect(inspectionDueDate({ ...i, intervalMonths: undefined })).toBe(
      "2027-01-31",
    );
    expect(inspectionStatus(i, a, "2026-12-31").daysRemaining).toBe(0);
    expect(inspectionStatus(i, a, "2027-01-01").status).toBe("overdue");
  });
  it("uses end-of-month dates including leap years", () => {
    expect(endOfDueMonth("2023-02-03", 12)).toBe("2024-02-29");
    expect(endOfDueMonth("2026-01-15", 1)).toBe("2026-02-28");
    expect(() => endOfDueMonth("2026-02-30", 1)).toThrow();
  });
  it("calculates remaining usage with positive values before the deadline", () => {
    const a = demoSnapshot().aircraft[0];
    expect(
      inspectionStatus(
        {
          uuid: "x",
          aircraftUuid: a.uuid,
          reference: "",
          description: "",
          dueSeconds: a.currentHobbs + 10 * 3600,
        },
        a,
      ).hoursRemaining,
    ).toBe(10);
    expect(
      inspectionStatus(
        { uuid: "x", aircraftUuid: a.uuid, reference: "", description: "" },
        a,
      ).status,
    ).toBe("unknown");
  });
  it("allows the due calendar day but treats a reached meter limit as due", () => {
    const a = demoSnapshot().aircraft[0],
      i = {
        uuid: "i",
        aircraftUuid: a.uuid,
        reference: "",
        description: "",
        dueDate: "2026-01-31",
      };
    expect(inspectionStatus(i, a, "2026-01-31").status).toBe("due-soon");
    expect(inspectionStatus(i, a, "2026-02-01").status).toBe("overdue");
    expect(
      inspectionStatus({ ...i, dueSeconds: a.currentHobbs }, a, "2026-01-01")
        .status,
    ).toBe("overdue");
  });
});
describe("CSV backups", () => {
  it("quotes CSV values and neutralizes spreadsheet formulas", () => {
    expect(
      toCsv([{ name: '=HYPERLINK("test")', notes: "a,b\nline" }]),
    ).toContain('"\'=HYPERLINK(""test"")"');
    expect(toCsv([{ notes: "a,b\nline" }])).toContain('"a,b\nline"');
  });
  it("keeps negative numbers numeric while neutralizing formula-like text", () => {
    expect(toCsv([{ delta: -5, note: "-5" }])).toBe(
      '\uFEFF"delta","note"\r\n"-5","\'-5"',
    );
  });
});
describe("local calendar dates", () => {
  it("uses the device date and tolerates any zone's today on the server", () => {
    const d = new Date(2026, 9, 29, 23, 30);
    expect(localDate(d.getTime())).toBe("2026-10-29");
    const now = Date.parse("2026-10-29T12:00:00Z");
    expect(latestLocalDate(now)).toBe("2026-10-30");
    expect(isLocalToday("2026-10-29", now)).toBe(true);
    expect(isLocalToday("2026-10-30", now)).toBe(true);
    expect(isLocalToday("2026-10-28", now)).toBe(false);
    expect(isLocalToday("2026-10-31", now)).toBe(false);
  });
});
