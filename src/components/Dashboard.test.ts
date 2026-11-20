/**
 * Responsibility: Pins the dashboard's inspection marks and outlook order,
 *   its component-limit count, its aircraft filters, a card without a meter
 *   reading, what pilot view leaves out, and who may log a flight.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Dashboard.tsx, src/data/demo.ts,
 *   src/domain (components, model), react-dom/server,
 *   tests/fixtures/dueFleet.ts.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withoutMeterReading } from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import { componentSchema, requirementSchema } from "../domain/components";
import {
  localDate,
  totalSeconds,
  type Inspection,
  type Snapshot,
} from "../domain/model";
import { Dashboard } from "./Dashboard";

const HOUR = 3600;
let snapshot = demoSnapshot();
let favorites: string[] = [];
const hooks = vi.hoisted(() => ({ states: [] as unknown[], slot: 0 }));
vi.mock("../data/store", () => {
  const state = () => ({
    snapshot,
    favorites,
    toggleFavorite: () => {},
    online: true,
    connected: true,
  });
  const useWorkspace = (select?: (s: ReturnType<typeof state>) => unknown) =>
    select ? select(state()) : state();
  return { useWorkspace: Object.assign(useWorkspace, { getState: state }) };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: unknown }) =>
    createElement("a", null, children as never),
}));
// Seeds the dashboard's state: slot 0 is the search text, 1 the favorites
// filter (see useDashboard).
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = hooks.slot++;
      if (!(slot in hooks.states)) hooks.states[slot] = initial;
      return [hooks.states[slot], () => {}];
    },
  };
});
beforeEach(() => {
  snapshot = demoSnapshot();
  favorites = [];
  hooks.states = [];
});
const shift = (days: number) => {
  const d = new Date(localDate() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** N182MA (1,650.4 h on the Hobbs) with only the given inspections. */
function render(...inspections: Partial<Inspection>[]) {
  snapshot.inspections = inspections.map((i, n) => ({
    uuid: `insp-${n}`,
    aircraftUuid: "demo-182",
    reference: `REF-${n}`,
    description: `Inspection ${n}`,
    ...i,
  }));
  const html = page();
  const card = html.slice(html.indexOf(">N182MA</h3>"));
  const timeline = card.slice(
    card.indexOf("dash-timeline"),
    card.indexOf("</article>"),
  );
  const text = (s: string) =>
    s
      .replace(/<[^>]+aria-label="([^"]*)"[^>]*>/g, " $1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  const outlook = html.slice(
    html.indexOf("Maintenance outlook"),
    html.indexOf("dash-callout"),
  );
  return { card: text(timeline), outlook: text(outlook) };
}
it("shows the overdue calendar limit, not the hours still remaining", () => {
  const due = shift(-5);
  const { card, outlook } = render({
    reference: "Annual + 100 h",
    lastSeconds: 1600 * HOUR,
    dueSeconds: 1700 * HOUR,
    lastDate: shift(-370),
    dueDate: due,
  });
  expect(card).toContain("Annual + 100 h 5 days overdue");
  expect(card).not.toContain("49.6 h remaining");
  expect(card).toContain("Due " + due.slice(8).replace(/^0/, ""));
  expect(outlook).toMatch(/Annual \+ 100 h .* · overdue/);
  expect(outlook).not.toContain("49.6 h");
});
it("shows the dimension closest to its limit relative to its due-soon allowance", () => {
  // 20 of 30 calendar days left is nearer the limit than 8.6 of 10 hours.
  const calendar = render({
    reference: "Combined",
    dueSeconds: 1659 * HOUR,
    dueDate: shift(10),
  });
  expect(calendar.card).toContain("Combined 10 days remaining");
  expect(calendar.outlook).not.toContain("8.6 h");
  // 2.6 of 10 hours left is nearer than 20 of 30 days.
  const hours = render({
    reference: "Combined",
    dueSeconds: 1653 * HOUR,
    dueDate: shift(20),
  });
  expect(hours.card).toContain("Combined 2.6 h remaining");
  expect(hours.outlook).toContain("2.6 h");
});
it("shows the most overdue limit when several are overdue", () => {
  const { card, outlook } = render({
    reference: "Combined",
    dueSeconds: 1649 * HOUR,
    dueDate: shift(-40),
  });
  expect(card).toContain("Combined 40 days overdue");
  expect(outlook).toMatch(/Combined .* · overdue/);
  const hours = render({
    reference: "Combined",
    dueSeconds: 1600 * HOUR,
    dueDate: shift(-2),
  });
  expect(hours.card).toContain("Combined 50.4 h overdue");
  expect(hours.outlook).toContain("50.4 h overdue");
});
it("keeps the progress track on the dimension shown", () => {
  const { card } = render({
    reference: "Combined",
    lastSeconds: 1600 * HOUR,
    dueSeconds: 1700 * HOUR,
    lastDate: shift(-355),
    dueDate: shift(10),
  });
  expect(card).toContain("Combined 10 days remaining");
  // 355 of 365 days used, not 50.4 of 100 hours.
  expect(card).toContain("Combined: 97% of the interval used");
  expect(card).not.toContain("Last 1,600.0 h");
});
it("picks the most urgent of several inspections with the same status", () => {
  const { card, outlook } = render(
    { reference: "SLIGHTLY-LATE", dueSeconds: 1650 * HOUR },
    { reference: "VERY-LATE", dueSeconds: 1600 * HOUR },
  );
  expect(card).toContain("VERY-LATE 50.4 h overdue");
  expect(outlook.indexOf("VERY-LATE")).toBeLessThan(
    outlook.indexOf("SLIGHTLY-LATE"),
  );
  const scheduled = render(
    { reference: "LATER", dueDate: shift(300) },
    { reference: "SOONER", dueDate: shift(200) },
  );
  expect(scheduled.card).toContain("SOONER 200 days remaining");
});
it("marks cycles by their count, with the singular for one left", () => {
  // N182MA has 1,142 cycles.
  const { card } = render({
    reference: "Cycles",
    lastCycles: 1,
    dueCycles: 1143,
    intervalCycles: 1142,
  });
  expect(card).toContain("Cycles 1 cycle remaining");
  expect(card).toContain("Last 1 cycles");
  expect(card).toContain("Due 1,143 cycles");
});
it("words a usage limit at exactly 0 as due now in the outlook", () => {
  const { outlook } = render(
    { reference: "ZERO-HOURS", dueSeconds: 1650.4 * HOUR },
    { reference: "ZERO-CYCLES", dueCycles: 1142 },
  );
  expect(outlook).toMatch(/ZERO-HOURS .* Due now/);
  expect(outlook).toMatch(/ZERO-CYCLES .* Due now/);
  expect(outlook).not.toContain("0.0 h");
});
it("words an expired deferral as expired, apart from one still in force", () => {
  const deferral = (expiresOn: string) => ({
    type: "mel" as const,
    melItem: "33-1",
    category: "B" as const,
    placard: "INOP",
    deferredOn: shift(-10),
    deferredAt: 0,
    deferredBy: "demo-admin",
    deferredByName: "Admin",
    expiresOn,
  });
  const report = {
    aircraftUuid: "demo-182",
    status: "open" as const,
    authorId: "demo-admin",
    createdAt: 0,
  };
  snapshot.discrepancies = [
    {
      ...report,
      uuid: "late",
      description: "LATE",
      deferral: deferral(shift(-1)),
    },
    {
      ...report,
      uuid: "valid",
      description: "VALID",
      deferral: deferral(shift(5)),
    },
  ];
  const { outlook } = render();
  expect(outlook).toMatch(/Deferral expired N182MA · LATE Expired/);
  expect(outlook).toMatch(/Deferred discrepancy N182MA · VALID Deferred/);
  expect(page()).toMatch(/dash-tone-danger">Expired</);
});
it("keeps an inspection it cannot compute unverified instead of failing", () => {
  const { card } = render({
    reference: "Component",
    componentUuid: "missing",
    dueSeconds: 1700 * HOUR,
  });
  expect(card).toContain("Component Maintenance information needed");
});

describe("component service limits", () => {
  it("counts components with a limit past Tracked", () => {
    snapshot.management = [
      ...lifeLimit("tracked", 2000 * HOUR),
      ...lifeLimit("soon", 105 * HOUR),
    ];
    expect(page()).toContain(
      "1 component(s) with approaching or reached service limits",
    );
  });

  it("fails on a limit it cannot compute (Characterizes current behaviour)", () => {
    snapshot.management = lifeLimit("early", 2000 * HOUR, HOUR);
    expect(page).toThrow(
      "Aircraft readings or date precede the installation baseline.",
    );
  });
});

describe("aircraft cards", () => {
  it("filters by registration, make, model or program text and by favorites", () => {
    hooks.states = ["n206"];
    expect(registrations()).toEqual(["N206MA"]);
    hooks.states = ["skylane"];
    expect(registrations()).toEqual(["N182MA"]);
    snapshot.aircraft[1].make = "Textron";
    hooks.states = ["cessna"];
    expect(registrations()).toEqual(["N206MA", "N182MA"]);
    hooks.states = ["textron 208"];
    expect(registrations()).toEqual(["N208MA"]);
    favorites = ["demo-208"];
    hooks.states = ["", true];
    expect(registrations()).toEqual(["N208MA"]);
    hooks.states = ["no such aircraft"];
    expect(page()).toContain("No aircraft match");
  });

  it("offers Log flight only on aircraft with the flight permission", () => {
    const html = page();
    expect(html).toContain("Log a flight");
    snapshot = asOutsider(snapshot);
    const outsider = page();
    expect(outsider).not.toContain("Log flight");
    expect(outsider).not.toContain("Log a flight");
  });
});

describe("an aircraft without a meter reading", () => {
  const card = () => {
    const html = page();
    return html
      .slice(html.indexOf(">N208MA</h3>"))
      .split("</article>")[0]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  };

  it("shows its total as not recorded and judges what it can read", () => {
    withoutMeterReading(snapshot, snapshot.aircraft[1]);
    // The card lists the most urgent items; the fixture's overdue calendar
    // inspection would push the hours inspection off it, so it is left out.
    snapshot.inspections = snapshot.inspections.filter(
      (i) => i.uuid !== "i-calendar-unread",
    );
    const text = card();
    expect(text).toContain("Total Not recorded");
    expect(text).toContain("AD AD-UNREAD-LATE overdue");
    expect(text).toContain(
      "100-hour inspection Maintenance information needed",
    );
  });

  it("shows a calendar-only inspection overdue although the meter is unread (RM-66)", () => {
    withoutMeterReading(snapshot, snapshot.aircraft[1]);
    const text = card();
    expect(text).toContain("i-calendar-unread overdue");
    expect(text).toContain("days overdue Due 1 Jan 2020");
  });
});

describe("pilot view", () => {
  it("leaves out the stock notice, outlook and review KPI and shows each operational status", () => {
    const stock = { uuid: "s1", kind: "stock", quantity: 0, minimum: 1 };
    snapshot = { ...snapshot, management: [stock] } as unknown as Snapshot;
    const full = page();
    expect(full).toContain("1 stock item(s) need replenishment");
    expect(full).toContain("Maintenance outlook");
    expect(full).toContain("Flights awaiting review");
    snapshot = asPilot(snapshot);
    const pilot = page();
    expect(pilot).not.toContain("need replenishment");
    expect(pilot).not.toContain("Maintenance outlook");
    expect(pilot).not.toContain("Flights awaiting review");
    expect(pilot).toContain("Profile status: ");
  });
});

function page() {
  hooks.slot = 0;
  return renderToStaticMarkup(createElement(Dashboard));
}

function registrations() {
  return [...page().matchAll(/<h3 id="dash-reg-[^"]*">([^<]*)</g)].map(
    (m) => m[1],
  );
}

// The demo's Pilots group: flight and discrepancy, no administration.
function asPilot(s: Snapshot): Snapshot {
  return {
    ...s,
    user: { ...s.user, isAdmin: false, groupIds: ["demo-pilots"] },
  };
}

/** A component on N206MA at 100 h since new, with one time limit. `early`
 * installs it that many seconds past the aircraft's readings. */
function lifeLimit(uuid: string, dueSeconds: number, early = 0) {
  const a = snapshot.aircraft[0];
  const component = componentSchema.parse({
    uuid,
    kind: "component",
    version: 1,
    aircraftUuid: a.uuid,
    componentType: "Pump",
    partNumber: "PN",
    serial: "SN-" + uuid,
    manufacturer: "",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(a) + early,
    installedCycles: a.cycles,
    timeSinceNew: 100 * HOUR,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 20,
    serviceDaysBase: 0,
  });
  const limit = requirementSchema.parse({
    uuid: uuid + "-life",
    kind: "componentRequirement",
    version: 1,
    componentUuid: uuid,
    aircraftUuid: a.uuid,
    requirementType: "Life Limits",
    description: "Life limit",
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    dueSeconds,
    warningCalendarMonths: 0,
    warningSeconds: 10 * HOUR,
    warningCycles: 0,
  });
  return [component, limit];
}

// Sees the aircraft but holds no permission on them.
function asOutsider(s: Snapshot): Snapshot {
  return { ...s, user: { ...s.user, isAdmin: false, groupIds: [] } };
}
