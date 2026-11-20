/**
 * Responsibility: Pins how the flight plans screen searches and projects each
 *   aircraft's queue, which actions a plan offers online and offline, and how
 *   the plan form picks an aircraft and removes a plan. Uploading a PDF needs a browser:
 *   tests/e2e/flight-plans.spec.ts covers it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FlightPlans.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server, tests/fixtures/dueFleet.ts.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { withoutMeterReading } from "../../tests/fixtures/dueFleet";
import { demoSnapshot } from "../data/demo";
import type { FlightPlan } from "../domain/flightPlans";
import type { Snapshot } from "../domain/model";
import { FlightPlans } from "./FlightPlans";

// The screen's twelve states are seeded by name, in the order it declares
// them; later states (the plan form's) are React's own.
const SLOTS = [
  "aircraftUuid",
  "draft",
  "copying",
  "editing",
  "logging",
  "flightMessage",
  "removing",
  "busy",
  "error",
  "uploadReport",
  "reportCopied",
  "search",
];
let seeds: unknown[] = [];
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) =>
    seeds.length ? [seeds.shift(), () => {}] : react.useState(init);
  return { ...react, useState };
});
let removeForm: { onSubmit: () => Promise<void> } | undefined;
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  Modal: (props: { children: ReactNode }) =>
    createElement("section", null, props.children),
  AsyncForm: (props: {
    submitLabel: string;
    onSubmit: () => Promise<void>;
    children: ReactNode;
  }) => {
    if (props.submitLabel === "Remove from queue") removeForm = props;
    return createElement("form", null, props.children);
  },
}));
let resumable = new Set<string>();
vi.mock("./FlightSession", () => ({
  FlightSessions: () => null,
  useResumablePlans: () => resumable,
}));
const base = demoSnapshot();
const workspace = {
  snapshot: base as Snapshot,
  online: true,
  connected: true,
  queue: [] as unknown[],
  backend: { savePlan: vi.fn(async () => {}) },
};
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const plan = (n: number): FlightPlan =>
  ({
    uuid: `00000000-0000-4000-8000-00000000000${n}`,
    version: 2,
    aircraftUuid: base.aircraft[0].uuid,
    registration: base.aircraft[0].registration,
    departureAt: `2026-11-1${n}T08:00:00.000Z`,
    origin: "KAAA",
    destination: `KB${n}`,
    alternate: "",
    durationMinutes: 60,
    cycles: 1,
    landings: 1,
    flightRules: "I",
    route: "",
    level: "",
    pilotText: "",
    status: "proposed",
    createdAt: n,
  }) as FlightPlan;
const render = (
  state: Record<string, unknown>,
  extra: Partial<Snapshot> = {},
) => {
  const values: Record<string, unknown> = { flightMessage: "", error: "" };
  Object.assign(values, { uploadReport: "", search: "", aircraftUuid: "" });
  Object.assign(values, state);
  seeds = SLOTS.map((name) => values[name]);
  workspace.snapshot = { ...base, flightPlans: [plan(1), plan(2)], ...extra };
  return renderToStaticMarkup(createElement(FlightPlans));
};

// The Start / resume flight button in the row of the plan to that
// destination, and the note it points at, if any.
const flyButton = (html: string, destination: string) => {
  const row = html.split("<tr>").find((r) => r.includes(`→ ${destination}`));
  const button = row?.match(/<button[^>]*>Start \/ resume flight<\/button>/);
  if (!button) throw new Error(`No Start / resume flight for ${destination}.`);
  const noteId = button[0].match(/aria-describedby="([^"]+)"/)?.[1];
  const note = noteId && row!.match(new RegExp(`id="${noteId}"[^>]*>([^<]*)<`));
  return { disabled: button[0].includes('disabled=""'), note: note?.[1] };
};
const START_NOTE =
  "Starting needs a connection: this device&#x27;s copy of the plan may be out of date.";

describe("FlightPlans", () => {
  it("projects the full queue even when the search hides a plan", () => {
    const html = render({ search: "kb2" });
    expect(html).not.toContain("KB1");
    expect(html).toMatch(/data-label="Cumulative">2h 00m</);
  });

  it("projects the queue of an aircraft without a meter reading, with no total", () => {
    const s = demoSnapshot();
    const html = () =>
      render({}, { aircraft: s.aircraft, airworthiness: s.airworthiness });
    expect(html()).toMatch(/Projected total <strong>[\d,.]+ h<\/strong>/);
    withoutMeterReading(s, s.aircraft[0]);
    expect(html()).toContain("Projected total <strong>Not recorded</strong>");
    expect(html()).toMatch(/data-label="Cumulative">2h 00m</);
  });

  it("lists a plan only when it contains every search word", () => {
    expect(render({ search: "kaaa kb2" })).toContain("KB2");
    expect(render({ search: "kaaa zzz" })).toContain(
      "No matching flight plans",
    );
  });

  it("offers no flight, edit or removal once a flight is logged or queued", () => {
    const review = {
      uuid: "f",
      flightPlanUuid: plan(1).uuid,
      status: "review",
    };
    workspace.queue = [
      {
        operation: { kind: "flight", input: { flightPlanUuid: plan(2).uuid } },
      },
    ];
    const html = render({}, { flights: [review] } as Partial<Snapshot>);
    workspace.queue = [];
    expect(html).toContain("Flight awaiting review");
    expect(html).toContain("Flight pending sync");
    expect(html).not.toContain("Edit plan");
  });

  it("cancels a removed plan rather than deleting it", async () => {
    render({ removing: plan(1) });
    await removeForm!.onSubmit();
    expect(workspace.backend.savePlan).toHaveBeenCalledWith({
      plan: { ...plan(1), status: "cancelled" },
      baseVersion: 2,
    });
  });

  it("picks the one aircraft whose registration matches the PDF", () => {
    const draft = { ...plan(3), registration: "n-206 ma", sourceHash: "" };
    const selected = (aircraft: Snapshot["aircraft"]) =>
      render({ draft }, { aircraft }).match(
        /<option value="([^"]*)" selected="">/g,
      );
    expect(selected(base.aircraft)?.[1]).toContain(base.aircraft[0].uuid);
    const twins = [base.aircraft[0], { ...base.aircraft[0], uuid: "twin" }];
    expect(selected(twins)?.[1]).toBe('<option value="" selected="">');
  });

  it("labels the plan form's count inputs", () => {
    const html = render({ editing: plan(1) });
    expect(html).toMatch(
      /<label for="([^"]+)">Estimated landings<\/label><input[^>]*id="\1"/,
    );
  });

  it("starts a copy with a blank date on its own aircraft", () => {
    // A copy keeps its aircraft even when the registration no longer matches.
    const html = render({ copying: { ...plan(1), registration: "N999XX" } });
    expect(html).toMatch(/name="date"[^>]*value=""/);
    expect(html).toContain(
      `value="${base.aircraft[0].uuid}" selected="">N206MA</option>`,
    );
  });

  it("disables uploading and plan changes offline", () => {
    workspace.online = false;
    const html = render({});
    workspace.online = true;
    expect(html).toMatch(/type="file"[^>]*disabled=""/);
    expect(html).toContain('<button class="button small" disabled="">Copy');
  });

  it("resumes a preflight saved on this device offline, but starts no flight", () => {
    const offline = (saved: string[], extra: Partial<Snapshot> = {}) => {
      workspace.online = false;
      resumable = new Set(saved);
      const html = render({}, extra);
      workspace.online = true;
      resumable = new Set();
      return html;
    };
    const html = offline([plan(1).uuid]);
    expect(flyButton(html, "KB1")).toEqual({
      disabled: false,
      note: undefined,
    });
    expect(flyButton(html, "KB2")).toEqual({
      disabled: true,
      note: START_NOTE,
    });
    expect(html).not.toMatch(/<button class="button small">(Edit|Remove)/);
    const online = render({});
    expect(flyButton(online, "KB2")).toEqual({
      disabled: false,
      note: undefined,
    });
    // A saved preflight never stands in for flight access to the aircraft.
    const user = { ...base.user, isAdmin: false, groupIds: [] };
    const denied = offline([plan(1).uuid], { user });
    expect(flyButton(denied, "KB1")).toEqual({
      disabled: true,
      note: undefined,
    });
  });
});
