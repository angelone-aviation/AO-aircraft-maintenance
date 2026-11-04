/**
 * Responsibility: Pins where the guided flight keeps and exports its draft,
 *   how a new flight picks its sections and follows the open checklist, and
 *   how a plan's flight rules reach the flight log. Pausing, readings and
 *   saving need a browser: tests/e2e/guided-flight.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/GuidedFlight.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { ChecklistRecord } from "../domain/checklists";
import type { FlightPlan } from "../domain/flightPlans";
import type { GuidedDraft } from "../domain/guidedFlight";
import type { FlightInput } from "../domain/model";
import { GuidedFlight } from "./GuidedFlight";

// The panel's fifteen states, in the order it declares them. Unseeded states
// start as the panel starts them; every update is recorded, not applied.
const SLOTS = [
  ...["loaded", "enabled", "draft", "paused", "error", "review", "message"],
  ...["section", "aircraftId", "planId", "checklistId", "preflight"],
  ...["startSection", "shutdown", "override"],
];
const hooks = vi.hoisted(() => ({
  seeds: {} as Record<string, unknown>,
  updates: {} as Record<string, unknown>,
  slot: 0,
  clicks: new Map<string, () => void>(),
  validated: undefined as FlightInput | undefined,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) => {
    const name = SLOTS[hooks.slot++];
    const start = typeof init === "function" ? init() : init;
    const value = name in hooks.seeds ? hooks.seeds[name] : start;
    return [value, (next: unknown) => (hooks.updates[name] = next)];
  };
  return { ...react, useState, useEffect: (effect: () => void) => effect() };
});
// Tests compile JSX for development, so buttons are seen in jsxDEV.
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  type Props = { onClick?: () => void; children?: ReactNode };
  const jsxDEV = (type: unknown, props: Props, ...rest: unknown[]) => {
    if (type === "button" && props.onClick)
      hooks.clicks.set(textOf(props.children), props.onClick);
    return (runtime.jsxDEV as (...args: unknown[]) => unknown)(
      type,
      props,
      ...rest,
    );
  };
  return { ...runtime, jsxDEV };
});
vi.mock("../domain/flights", () => ({
  validateFlight: (_aircraft: unknown, input: FlightInput) =>
    (hooks.validated = input),
}));
vi.mock("./Checklists", () => ({ ChecklistReader: () => null }));
vi.mock("./FlightForm", () => ({ FlightForm: () => null }));
const workspace = { snapshot: demoSnapshot(), namespace: "ns", queue: [] };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
let stored: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => stored[key] ?? null,
  setItem: (key: string) => {
    throw new Error(`Unexpected write to ${key}`);
  },
});

const KEY = "angel-one-guided:ns:demo-admin:demo-program";
const aircraft = workspace.snapshot.aircraft[0];
const checklist = (uuid: string, titles: string[]): ChecklistRecord => ({
  uuid,
  version: 1,
  programUuid: "demo-program",
  aircraftUuid: "",
  sourceName: "c.fmd",
  updatedAt: 0,
  updatedBy: "demo-admin",
  document: {
    type: "checklist",
    payload: {
      objectId: "doc",
      schemaVersion: "1.0",
      metadata: { name: uuid },
      groups: [
        {
          objectId: "g",
          groupType: "normal",
          items: [
            {
              objectId: "gg",
              title: "Normal",
              items: titles.map((title, i) => ({
                objectId: `s${i}`,
                title,
                items: [{ objectId: `c${i}`, title: "Check" }],
              })),
            },
          ],
        },
      ],
    },
  },
});
const TITLED = checklist("10000000-0000-4000-8000-000000000001", [
  ...["Cockpit", "Before start", "Taxi", "After flight", "Secure"],
]);
const UNTITLED = checklist("20000000-0000-4000-8000-000000000002", [
  ...["Alpha", "Beta", "Gamma"],
]);
const plan = (flightRules: string) => ({
  uuid: "30000000-0000-4000-8000-000000000003",
  version: 1,
  aircraftUuid: aircraft.uuid,
  registration: aircraft.registration,
  departureAt: "2026-11-05T08:00:00.000Z",
  origin: "KAAA",
  destination: "KBBB",
  ...{ alternate: "", durationMinutes: 60, cycles: 1, landings: 1 },
  ...{ flightRules, route: "DCT", level: "", pilotText: "", speed: "" },
  ...{ aircraftType: "", flightType: "", equipment: "", otherInformation: "" },
  ...{ sourceName: "", sourceHash: "a".repeat(64) },
  ...{ status: "proposed", createdAt: 0 },
});
const draft = (flightRules: string) =>
  ({
    uuid: "40000000-0000-4000-8000-000000000004",
    aircraftUuid: aircraft.uuid,
    startedAt: "2026-11-04T09:00:00.000Z",
    opening: { version: aircraft.version, hobbs: 0, tach: 0 },
    checklist: TITLED,
    plan: plan(flightRules),
    ...{ preflightList: "s0", shutdownList: "s3", progress: {} },
    metersVerifiedAt: "2026-11-04T09:01:00.000Z",
    fuel: { unit: "US gal", start: 40, added: 0, end: 30 },
    oil: [{ engine: "single", unit: "US qt", start: 6, added: 0 }],
  }) as GuidedDraft;
const render = (
  seeds: Record<string, unknown>,
  props: { records?: ChecklistRecord[]; selectedChecklist?: ChecklistRecord },
) => {
  Object.assign(hooks, { seeds, updates: {}, slot: 0 });
  hooks.clicks.clear();
  const records = props.records ?? [TITLED];
  return renderToStaticMarkup(
    createElement(GuidedFlight, { ...props, records }),
  );
};
const selected = (html: string, label: string) =>
  html.match(
    new RegExp(`${label}</label><select[^>]*>.*?selected="">([^<]*)<`),
  )?.[1];

beforeEach(() => {
  stored = {};
});

it("keeps the draft per user and Flight Program", () => {
  stored = { [`${KEY}:enabled`]: "true", [KEY]: JSON.stringify(draft("I")) };
  expect(render({}, {})).toContain("N206MA · KAAA → KBBB");
  stored = {
    [`${KEY}:enabled`]: "true",
    [KEY.replace("demo-program", "other")]: JSON.stringify(draft("I")),
  };
  expect(render({}, {})).toContain("Start guided checklist");
});

it("will not start over a stored draft it cannot read", () => {
  const start = /<button class="button primary"( disabled="")?>/;
  const snapshot = workspace.snapshot;
  workspace.snapshot = { ...snapshot, flightPlans: [plan("I") as FlightPlan] };
  expect(render({ enabled: true }, {}).match(start)?.[1]).toBeUndefined();
  stored = { [KEY]: "{not json" };
  const html = render({ enabled: true }, {});
  workspace.snapshot = snapshot;
  expect(html).toContain("The saved guided draft could not be loaded.");
  expect(html.match(start)?.[1]).toBe(' disabled=""');
});

it("starts at the sections titled preflight and shutdown, else the ends", () => {
  const titled = render({ enabled: true }, {});
  expect(selected(titled, "Preflight section")).toBe("Before start");
  expect(selected(titled, "Shutdown section")).toBe("After flight");
  const plain = render({ enabled: true }, { records: [UNTITLED] });
  expect(selected(plain, "Preflight section")).toBe("Alpha");
  expect(selected(plain, "Shutdown section")).toBe("Gamma");
});

it("follows the open checklist until a flight is running", () => {
  render({ enabled: true }, { selectedChecklist: UNTITLED });
  expect(hooks.updates.checklistId).toBe(UNTITLED.uuid);
  const html = render(
    { enabled: true, draft: draft("I") },
    { selectedChecklist: UNTITLED },
  );
  expect(hooks.updates).not.toHaveProperty("checklistId");
  expect(html).toContain(`Your active guided flight still uses ${TITLED.uuid}`);
});

it.each([
  ["I", "IFR"],
  ["Y", "IFR"],
  ["V", "VFR"],
  ["Z", "VFR"],
])("logs a plan with rules %s as %s", (rules, logged) => {
  render({ enabled: true, draft: draft(rules) }, {});
  hooks.clicks.get("Review flight log")!();
  expect(hooks.validated?.flightRules).toBe(logged);
});

it("exports the open draft, else the stored one, as guided-flight-draft.json", async () => {
  const link = { href: "", download: "", click: vi.fn() };
  vi.stubGlobal("document", { createElement: () => link });
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return "blob:draft";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  render({ enabled: true, draft: draft("I") }, {});
  hooks.clicks.get("Export draft")!();
  const error = "Could not resume the saved flight. Its draft has been kept.";
  render({ enabled: true, error }, {});
  hooks.clicks.get("Export saved draft")!();
  stored = { [KEY]: "{not json" };
  render({ enabled: true, error }, {});
  hooks.clicks.get("Export saved draft")!();
  vi.restoreAllMocks();
  vi.stubGlobal("document", undefined);
  expect(link.click).toHaveBeenCalledTimes(2);
  expect(link).toMatchObject({
    href: "blob:draft",
    download: "guided-flight-draft.json",
  });
  expect(blobs.map((b) => b.type)).toEqual([
    "application/json",
    "application/json",
  ]);
  expect(await blobs[0].text()).toBe(JSON.stringify(draft("I"), null, 2));
  expect(await blobs[1].text()).toBe("{not json");
});

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node.trim();
  if (Array.isArray(node)) return node.map(textOf).join(" ").trim();
  if (isValidElement<{ children?: ReactNode }>(node))
    return textOf(node.props.children);
  return "";
}
