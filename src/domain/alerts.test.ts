/**
 * Responsibility: Pins which maintenance alerts fire, their keys and order,
 *   the email preference and the digest email.
 * Layer: Test. Vitest over pure domain functions.
 * Dependencies: src/domain/alerts.ts, alertDigest.ts, airworthiness.ts,
 *   components.ts, faa.ts, model.ts; src/data/demo.ts (seed),
 *   tests/fixtures/dueFleet.ts.
 */
import { describe, expect, it } from "vitest";
import {
  DUE_FLEET_TODAY,
  dueFleet,
  withoutMeterReading,
} from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import {
  ALERTS_SKIPPED_AD_STATUSES,
  computeAlerts as allAlerts,
  URGENT_ALERT_KINDS,
  urgentAlerts,
  wantsAlertEmails,
  wantsUrgentAlertEmails,
  type Alert,
} from "./alerts";
import type { ExpiringItem } from "./expiringItems";
import { digestEmail, DIGEST_LIMIT } from "./alertDigest";
import {
  blankAD,
  blankADTask,
  DASHBOARD_SETTLED_AD_STATUSES,
} from "./airworthiness";
import type { Component, ComponentRequirement } from "./components";
import type { FaaCandidate } from "./faa";
import { totalSeconds, type Snapshot } from "./model";

const today = "2026-10-30";
const plus = (days: number) =>
  new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
// Aircraft N206MA (demo-206) reads 2341.2 h with 1894 cycles.
function fleet(): Snapshot {
  return { ...demoSnapshot(), inspections: [] };
}
const kinds = (alerts: Alert[]) => alerts.map((a) => a.kind);
// Per-kind tests leave out the grounded summary, which has its own test.
const computeAlerts = (s: Snapshot, day: string) =>
  allAlerts(s, day).filter((a) => a.kind !== "aircraft-grounded");

describe("inspection alerts", () => {
  const at = (patch: Partial<Snapshot["inspections"][number]>) =>
    computeAlerts(
      {
        ...fleet(),
        inspections: [
          {
            uuid: "insp",
            aircraftUuid: "demo-206",
            reference: "Annual",
            description: "Calendar inspection",
            ...patch,
          },
        ],
      },
      today,
    );
  it("flags calendar inspections due within 30 days and overdue after the due date", () => {
    expect(kinds(at({ dueDate: plus(31) }))).toEqual([]);
    expect(kinds(at({ dueDate: plus(30) }))).toEqual(["inspection-due-soon"]);
    expect(kinds(at({ dueDate: today }))).toEqual(["inspection-due-soon"]);
    const overdue = at({ dueDate: plus(-1) });
    expect(overdue).toMatchObject([
      {
        kind: "inspection-overdue",
        severity: "danger",
        aircraftUuid: "demo-206",
        entityUuid: "insp",
        dueDate: plus(-1),
        link: "/inspections",
      },
    ]);
    expect(overdue[0].detail).toContain("N206MA");
  });
  it("flags hour limits within 10 hours and at the limit", () => {
    expect(kinds(at({ dueSeconds: (2351.2 + 0.1) * 3600 }))).toEqual([]);
    expect(kinds(at({ dueSeconds: 2351.2 * 3600 }))).toEqual([
      "inspection-due-soon",
    ]);
    expect(kinds(at({ dueSeconds: 2341.2 * 3600 }))).toEqual([
      "inspection-overdue",
    ]);
  });
  it("ignores archived schedules", () => {
    expect(at({ dueDate: plus(-1), archived: true })).toEqual([]);
  });
  it("keeps keys stable until the due point or status changes", () => {
    const first = at({ dueDate: plus(5) })[0].key;
    expect(at({ dueDate: plus(5) })[0].key).toBe(first);
    expect(at({ dueDate: plus(6) })[0].key).not.toBe(first);
    expect(at({ dueDate: plus(-1) })[0].key).not.toBe(
      at({ dueDate: plus(-1), dueSeconds: 9999 * 3600 })[0].key,
    );
  });
});

describe("AD alerts", () => {
  function withTask(patch: Partial<ReturnType<typeof blankADTask>>) {
    const s = fleet();
    const r = blankAD("demo-206");
    r.source.number = "2026-01-01";
    r.applicability = "Applicable";
    r.reviewRequired = false;
    r.tasks = [{ ...blankADTask(), description: "Inspect", ...patch }];
    return { s: { ...s, airworthiness: [r] }, r };
  }
  it("flags tasks due within 30 days and overdue", () => {
    expect(
      kinds(computeAlerts(withTask({ dueDate: plus(31) }).s, today)),
    ).toEqual([]);
    expect(
      computeAlerts(withTask({ dueDate: plus(30) }).s, today),
    ).toMatchObject([
      {
        kind: "ad-due-soon",
        title: "AD 2026-01-01 due soon",
        severity: "warning",
      },
    ]);
    expect(kinds(computeAlerts(withTask({ dueHours: 2341 }).s, today))).toEqual(
      ["ad-overdue"],
    );
  });
  it("skips ADs that are not applicable", () => {
    const { s, r } = withTask({ dueDate: plus(-3) });
    r.applicability = "Not applicable";
    expect(computeAlerts(s, today)).toEqual([]);
  });
  it("alerts on an action of an AD under review (Characterizes current behaviour)", () => {
    const { s, r } = withTask({ dueDate: plus(-3) });
    r.reviewRequired = true;
    expect(kinds(computeAlerts(s, today))).toEqual(["ad-overdue"]);
  });
  it("skips fewer statuses than the dashboard's AD panel (Characterizes current behaviour; T13)", () => {
    expect(ALERTS_SKIPPED_AD_STATUSES).toEqual([
      "Not applicable",
      "Superseded",
      "Removed component",
      "Previously Complied With (PCW)",
    ]);
    expect([...DASHBOARD_SETTLED_AD_STATUSES].sort()).toEqual(
      [...ALERTS_SKIPPED_AD_STATUSES, "Complied", "Scheduled"].sort(),
    );
  });
});

describe("component requirement alerts", () => {
  function setup(
    dueDate: string,
    installed = true,
    patch: Partial<ComponentRequirement> = {},
  ) {
    const s = fleet();
    const a = s.aircraft[0];
    const component: Component = {
      uuid: "pump",
      version: 1,
      kind: "component",
      aircraftUuid: installed ? a.uuid : "",
      componentType: "Hydraulic pump",
      partNumber: "PN1",
      serial: "SN1",
      manufacturer: "Example",
      notes: "",
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
      installed,
      installedDate: "2026-01-01",
      installedSeconds: totalSeconds(a),
      installedCycles: a.cycles,
      timeSinceNew: 100 * 3600,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 25,
      serviceDaysBase: 30,
    };
    const requirement: ComponentRequirement = {
      uuid: "req",
      version: 1,
      kind: "componentRequirement",
      componentUuid: "pump",
      aircraftUuid: component.aircraftUuid,
      requirementType: "Life Limits",
      description: "Replace pump",
      notes: "",
      calendarIntervalUnit: "MONTHS",
      timeBasis: "TSN",
      timeLimitMode: "ABSOLUTE",
      cycleLimitMode: "ABSOLUTE",
      dueDate,
      warningCalendarMonths: 1,
      warningSeconds: 0,
      warningCycles: 0,
      ...patch,
    };
    return { ...s, management: [component, requirement] };
  }
  it("flags installed components near or past their limits", () => {
    expect(computeAlerts(setup(plus(60)), today)).toEqual([]);
    expect(computeAlerts(setup(plus(10)), today)).toMatchObject([
      {
        kind: "component-due-soon",
        entityUuid: "req",
        link: "/components",
      },
    ]);
    expect(kinds(computeAlerts(setup(plus(-1)), today))).toEqual([
      "component-past-due",
    ]);
    const usedUp = setup(plus(60), true, { dueSeconds: 100 * 3600 });
    expect(computeAlerts(usedUp, today)).toMatchObject([
      {
        kind: "component-past-due",
        title: "Component due now: Hydraulic pump",
      },
    ]);
  });
  it("ignores removed components", () => {
    expect(computeAlerts(setup(plus(-1), false), today)).toEqual([]);
  });
  it("measures a component inspection on the alert date, not the clock's", () => {
    const s = setup("2099-12-31");
    Object.assign(s.management[0], { installedDate: "2099-01-01" });
    s.inspections = [
      {
        uuid: "insp",
        aircraftUuid: s.aircraft[0].uuid,
        reference: "Pump check",
        description: "",
        componentUuid: "pump",
        dueSeconds: 100 * 3600,
      },
    ];
    const alerts = computeAlerts(s, "2099-06-01");
    expect(kinds(alerts.filter((a) => a.entityUuid === "insp"))).toEqual([
      "inspection-overdue",
    ]);
  });
});

describe("certificate alerts", () => {
  const at = (expiresOn: string, renewalDate?: string) =>
    computeAlerts(
      {
        ...fleet(),
        user: {
          ...fleet().user,
          certifications: [
            { kind: "pilot", number: "P1", issuedOn: "", expiresOn },
            {
              kind: "mechanic",
              number: "M1",
              issuedOn: "",
              ia: !!renewalDate,
              renewalDate,
            },
          ],
        },
      },
      today,
    );
  it("warns within 30 days and flags expired certificates", () => {
    expect(at(plus(31))).toEqual([]);
    expect(at(plus(30))).toMatchObject([
      { kind: "certificate-expiring", dueDate: plus(30), link: "/" },
    ]);
    expect(at(today)[0].kind).toBe("certificate-expiring");
    expect(at(plus(-1))).toMatchObject([
      { kind: "certificate-expired", severity: "danger" },
    ]);
  });
  it("shows an inactive user none, not even their own certificates", () => {
    const s = fleet();
    const certifications = [
      { kind: "pilot" as const, number: "P1", issuedOn: "", expiresOn: today },
    ];
    expect(
      computeAlerts({ ...s, user: { ...s.user, certifications } }, today),
    ).toHaveLength(1);
    expect(
      computeAlerts(
        { ...s, user: { ...s.user, certifications, active: false } },
        today,
      ),
    ).toEqual([]);
  });
  it("includes the IA renewal date", () => {
    expect(at(plus(200), plus(3))).toMatchObject([
      {
        kind: "certificate-expiring",
        title: `IA renewal expires on ${plus(3)}`,
      },
    ]);
  });
});

describe("FAA monitor alerts", () => {
  const candidate = (id: string, patch: Partial<FaaCandidate> = {}) => ({
    id,
    modified: "2026-10-01",
    source: { ...blankAD("demo-206").source, number: "2026-" + id },
    emergency: false,
    status: "Final",
    reviewReason: "",
    ...patch,
  });
  const at = (candidates: FaaCandidate[]) =>
    computeAlerts(
      {
        ...fleet(),
        faaMonitors: [
          {
            aircraftUuid: "demo-206",
            enabled: true,
            terms: [],
            error: "",
            runId: "",
            candidates,
          },
        ],
      },
      today,
    );
  it("summarizes unreviewed documents per aircraft and re-fires when they change", () => {
    expect(at([candidate("a", { reviewReason: "Not applicable" })])).toEqual(
      [],
    );
    const first = at([candidate("a"), candidate("b")]);
    expect(first).toMatchObject([
      {
        kind: "faa-ad-review",
        severity: "info",
        link: "/airworthiness",
      },
    ]);
    expect(first[0].title).toContain("2 new or changed");
    expect(at([candidate("b"), candidate("a")])[0].key).toBe(first[0].key);
    expect(
      at([candidate("a"), candidate("b", { modified: "2026-10-02" })])[0].key,
    ).not.toBe(first[0].key);
    expect(at([candidate("a", { emergency: true })])[0].severity).toBe(
      "danger",
    );
  });
});

describe("permission filtering", () => {
  it("only returns alerts for aircraft the user can read", () => {
    const s = demoSnapshot();
    const pilot = { ...s.members[1], activeProgramUuid: "demo-program" };
    const limited: Snapshot = {
      ...s,
      user: pilot,
      groups: [{ ...s.groups[0], aircraftIds: ["demo-182"] }],
      inspections: [
        {
          uuid: "a",
          aircraftUuid: "demo-206",
          reference: "Annual",
          description: "",
          dueDate: plus(-1),
        },
        {
          uuid: "b",
          aircraftUuid: "demo-182",
          reference: "Annual",
          description: "",
          dueDate: plus(-1),
        },
      ],
    };
    expect(computeAlerts(limited, today).map((a) => a.entityUuid)).toEqual([
      "b",
    ]);
    expect(
      computeAlerts({ ...limited, user: { ...pilot, active: false } }, today),
    ).toEqual([]);
  });
});

describe("ordering", () => {
  it("lists action required first, then by due date with undated last, then by title", () => {
    const inspection = (uuid: string, reference: string, dueDate: string) => ({
      uuid,
      aircraftUuid: "demo-206",
      reference,
      description: "",
      dueDate,
    });
    const alerts = allAlerts(
      {
        ...fleet(),
        inspections: [
          inspection("soon", "Pitot", plus(10)),
          inspection("late", "Transponder", plus(-1)),
          inspection("later", "Annual", plus(-1)),
          inspection("latest", "ELT", plus(-5)),
        ],
      },
      today,
    );
    expect(alerts.map((a) => [a.severity, a.entityUuid])).toEqual([
      ["danger", "latest"],
      ["danger", "later"],
      ["danger", "late"],
      ["danger", "demo-206"],
      ["warning", "soon"],
    ]);
  });
});

describe("email preference", () => {
  const groups = [
    {
      id: "admins",
      programUuid: "p",
      programAdmin: true,
      name: "Admins",
      aircraftIds: [],
      permissions: ["read" as const],
    },
    {
      id: "pilots",
      programUuid: "p",
      name: "Pilots",
      aircraftIds: [],
      permissions: ["read" as const],
    },
  ];
  it("defaults on for program administrators and honours an explicit choice", () => {
    expect(wantsAlertEmails({ groupIds: ["admins"] }, groups, "p")).toBe(true);
    expect(wantsAlertEmails({ groupIds: ["admins"] }, groups, "q")).toBe(false);
    expect(wantsAlertEmails({ groupIds: ["pilots"] }, groups, "p")).toBe(false);
    expect(
      wantsAlertEmails(
        { groupIds: ["pilots"], emailAlerts: true },
        groups,
        "p",
      ),
    ).toBe(true);
    expect(
      wantsAlertEmails(
        { groupIds: ["admins"], emailAlerts: false },
        groups,
        "p",
      ),
    ).toBe(false);
  });
  it("does not default on for an administrator group without read access", () => {
    const noRead = [{ ...groups[0], permissions: [] }];
    expect(wantsAlertEmails({ groupIds: ["admins"] }, noRead, "p")).toBe(false);
  });
  it("sends urgent alerts to administrators and maintenance members by default", () => {
    const maintenance = {
      id: "mx",
      name: "Maintenance",
      programUuid: "p",
      aircraftIds: [],
      permissions: ["read", "maintenance"] as const,
    };
    const all = [
      ...groups,
      { ...maintenance, permissions: [...maintenance.permissions] },
    ];
    expect(wantsUrgentAlertEmails({ groupIds: ["admins"] }, all, "p")).toBe(
      true,
    );
    expect(wantsUrgentAlertEmails({ groupIds: ["mx"] }, all, "p")).toBe(true);
    expect(wantsUrgentAlertEmails({ groupIds: ["pilots"] }, all, "p")).toBe(
      false,
    );
    expect(wantsUrgentAlertEmails({ groupIds: ["mx"] }, all, "q")).toBe(false);
    expect(
      wantsUrgentAlertEmails(
        { groupIds: ["mx"], urgentAlertEmails: false },
        all,
        "p",
      ),
    ).toBe(false);
    expect(
      wantsUrgentAlertEmails(
        { groupIds: ["pilots"], urgentAlertEmails: true },
        all,
        "p",
      ),
    ).toBe(true);
  });
});

describe("expiring-date alerts", () => {
  const date = (patch: Partial<ExpiringItem> = {}): ExpiringItem => ({
    uuid: "11111111-1111-4111-8111-111111111111",
    programUuid: "demo-program",
    kind: "insurance",
    label: "Hull policy",
    expiresOn: plus(10),
    warnDays: 60,
    version: 1,
    ...patch,
  });
  const alertsFor = (s: Snapshot, items: ExpiringItem[]) =>
    allAlerts({ ...s, expiringItems: items }, today).filter(
      (a) => a.kind === "date-expiring" || a.kind === "date-expired",
    );
  it("warns from warnDays before, marks the day after as expired, and keys on the date", () => {
    const [soon] = alertsFor(fleet(), [date({ aircraftUuid: "demo-206" })]);
    expect(soon).toMatchObject({
      kind: "date-expiring",
      severity: "warning",
      title: `Hull policy expires on ${plus(10)}`,
      detail: "Insurance · N206MA · 10 days remaining.",
      aircraftUuid: "demo-206",
      dueDate: plus(10),
      link: "/settings",
      key: `date-expiring|11111111-1111-4111-8111-111111111111|${plus(10)}`,
    });
    expect(alertsFor(fleet(), [date({ expiresOn: plus(61) })])).toEqual([]);
    expect(alertsFor(fleet(), [date({ expiresOn: plus(60) })])).toHaveLength(1);
    const [expired] = alertsFor(fleet(), [date({ expiresOn: plus(-1) })]);
    expect(expired).toMatchObject({
      kind: "date-expired",
      severity: "danger",
      title: `Hull policy expired on ${plus(-1)}`,
      detail:
        "Insurance · Renew it, then record the new date under Expiring dates in Settings.",
    });
    expect(
      alertsFor(fleet(), [date({ archived: true, expiresOn: plus(-1) })]),
    ).toEqual([]);
  });
  it("shows system-wide dates and the FAA key only to system administrators", () => {
    const system = date({
      programUuid: undefined,
      kind: "secret",
      label: "Entra secret",
    });
    const s = {
      ...fleet(),
      faaCredential: { configured: true, expiresOn: plus(5), version: 1 },
    };
    expect(alertsFor(s, [system]).map((a) => a.title)).toEqual([
      `FAA DRS API key expires on ${plus(5)}`,
      `Entra secret expires on ${plus(10)}`,
    ]);
    const member = {
      ...s,
      user: { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] },
    };
    expect(alertsFor(member, [system, date()])).toEqual([]);
  });
});

describe("urgent alerts", () => {
  it("are the grounded, overdue, past-due and expired kinds", () => {
    expect([...URGENT_ALERT_KINDS].sort()).toEqual([
      "ad-overdue",
      "aircraft-grounded",
      "component-past-due",
      "date-expired",
      "inspection-overdue",
    ]);
    const { s } = dueFleet();
    const all = allAlerts(s, DUE_FLEET_TODAY);
    const urgent = urgentAlerts(all);
    expect(urgent.length).toBeGreaterThan(0);
    expect(urgent.every((a) => a.severity === "danger")).toBe(true);
    expect(urgent.map((a) => a.key)).toEqual(
      all.filter((a) => URGENT_ALERT_KINDS.includes(a.kind)).map((a) => a.key),
    );
    expect(urgentAlerts(all.filter((a) => a.severity !== "danger"))).toEqual(
      [],
    );
  });
});

describe("digest email", () => {
  const alert = (n: number): Alert => ({
    key: "k" + n,
    kind: "inspection-overdue",
    severity: "danger",
    title: `Inspection <b>${n}</b> & "more"`,
    detail: "N1 · <script>",
    entityUuid: "e" + n,
    link: "/inspections",
  });
  it("escapes text, links to the app and caps the list", () => {
    const alerts = Array.from({ length: DIGEST_LIMIT + 3 }, (_, i) => alert(i));
    const email = digestEmail(alerts, {
      programName: "Ops\r\nBcc: x",
      siteUrl: "https://app.example.test/",
    });
    expect(email.shown).toHaveLength(DIGEST_LIMIT);
    expect(email.subject).toBe(
      `Ops Bcc: x: ${DIGEST_LIMIT + 3} maintenance alerts`,
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain(
      "Inspection &lt;b&gt;0&lt;/b&gt; &amp; &quot;more&quot;",
    );
    expect(email.html).toContain('href="https://app.example.test/inspections"');
    expect(email.html).toContain("and 3 more");
    expect(email.text).toContain("and 3 more");
    expect(email.text).toContain("https://app.example.test/inspections");
  });
  it("omits links when the site URL is not http(s)", () => {
    const email = digestEmail([alert(1)], {
      programName: "Ops",
      siteUrl: "javascript:alert(1)",
    });
    expect(email.html).not.toContain("href");
    expect(email.subject).toBe("Ops: 1 maintenance alert");
  });
});

describe("grounded aircraft alerts", () => {
  it("adds one summary alert per grounded aircraft that changes with its reasons", () => {
    const grounded = (dueDate: string, reference = "Annual") =>
      allAlerts(
        {
          ...fleet(),
          inspections: [
            {
              uuid: "insp",
              aircraftUuid: "demo-206",
              reference,
              description: "Calendar inspection",
              intervalValue: 12,
              intervalUnit: "MONTHS",
              lastDate: "2025-01-01",
              dueDate,
              warningDays: 30,
              warningHours: 10,
              warningCycles: 0,
              trackingType: "calendar",
              archived: false,
            } as Snapshot["inspections"][number],
          ],
        },
        today,
      ).filter((a) => a.kind === "aircraft-grounded");
    expect(grounded(plus(60))).toEqual([]);
    const [alert] = grounded(plus(-1));
    expect(alert).toMatchObject({
      severity: "danger",
      title: "N206MA is grounded",
      aircraftUuid: "demo-206",
      link: "/",
    });
    expect(grounded(plus(-1))[0].key).toBe(alert.key);
  });
});

describe("on the due fleet", () => {
  // Characterizes current behaviour: an AD marked not applicable but awaiting
  // review still alerts, and an AD on a removed component does not.
  it("alerts in severity, due date and title order, with stable keys", () => {
    const { s } = dueFleet();
    expect(
      allAlerts(s, DUE_FLEET_TODAY).map((x) =>
        [x.severity, x.entityUuid, x.title, x.detail, x.dueDate, x.key].join(
          " | ",
        ),
      ),
    ).toStrictEqual(DUE_FLEET_ALERTS);
  });

  it("skips an AD limit an aircraft without a meter reading cannot judge, not its passed due dates", () => {
    const { s, c } = dueFleet();
    withoutMeterReading(s, c);
    const onC = allAlerts(s, DUE_FLEET_TODAY).filter(
      (x) => x.aircraftUuid === c.uuid,
    );
    // RM-66: the calendar-only inspection alerts although the meter is unread.
    expect(onC.map((x) => `${x.kind} ${x.title}`)).toStrictEqual([
      "ad-overdue AD AD-UNREAD-LATE overdue",
      "inspection-overdue Inspection overdue: i-calendar-unread",
      "aircraft-grounded N182MA is grounded",
    ]);
  });
});

const DUE_FLEET_ALERTS = [
  "danger | ad-b | AD AD-B overdue | N208MA · Inspect · due 2020-01-01 | 2020-01-01 | ad-overdue|ad-b|ad-b/monthly-2020-01-01|2020-01-01|||",
  "danger | ad-na-review | AD AD-NA-REVIEW overdue | N206MA · Inspect · due 2020-01-01 | 2020-01-01 | ad-overdue|ad-na-review|ad-na-review/monthly-2020-01-01|2020-01-01|||",
  "danger | ad-overdue | AD AD-OVERDUE overdue | N206MA · Inspect · due 2020-01-01 | 2020-01-01 | ad-overdue|ad-overdue|ad-overdue/monthly-2020-01-01|2020-01-01|||",
  "danger | i-other | Inspection overdue: i-other | N208MA · i-other description · due 2026-01-01 | 2026-01-01 | inspection-overdue|i-other|2026-01-01|||",
  "danger | i-late | Inspection overdue: i-late | N206MA · i-late description · due 2026-10-01 | 2026-10-01 | inspection-overdue|i-late|2026-10-01|||",
  "danger | r-b | Component due now: Type b-pump | N208MA · P/N PN-b-pump S/N SN-b-pump · Life Limits: r-b limit |  | component-past-due|r-b||360000||",
  "danger | r-now | Component due now: Type pump | N206MA · P/N PN-pump S/N SN-pump · Life Limits: r-now limit |  | component-past-due|r-now||360000||",
  "danger | i-zero | Inspection overdue: i-zero | N206MA · i-zero description · 0 h remaining |  | inspection-overdue|i-zero||8428320||",
  "danger | demo-206 | N206MA is grounded | i-late overdue; i-zero overdue; Type pump S/N SN-pump: r-now limit due now and 1 more |  | aircraft-grounded|demo-206|ccc3e606",
  "danger | demo-208 | N208MA is grounded | i-other overdue; Type b-pump S/N SN-b-pump: r-b limit due now; AD AD-B overdue |  | aircraft-grounded|demo-208|1d9eefcc",
  "warning | r-today | Component due soon: Type pump | N206MA · P/N PN-pump S/N SN-pump · Life Limits: r-today limit · due 2026-10-30 | 2026-10-30 | component-due-soon|r-today|2026-10-30|||",
  "warning | i-today | Inspection due soon: i-today | N206MA · i-today description · due 2026-10-30 | 2026-10-30 | inspection-due-soon|i-today|2026-10-30|||",
  "warning | ad-soon | AD AD-SOON due soon | N206MA · Inspect · due at 2351.2 h |  | ad-due-soon|ad-soon|ad-soon/hourly-2351.2||2351.2||",
  "warning | i-cycles | Inspection due soon: i-cycles | N206MA · i-cycles description · 5 cycles remaining |  | inspection-due-soon|i-cycles|||1899|",
];
