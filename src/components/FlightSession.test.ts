/**
 * Responsibility: Pins Start flight / End flight: which saved preflights are
 *   listed, the checks before a preflight is saved, what is removed when, and
 *   which plans' preflights can be resumed.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FlightSession.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/flightSession.ts.
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep
 * useState values in call order and capture buttons, forms and the flight
 * form's props; localStorage and window.confirm are fakes.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  startFlightSession,
  type FlightSession,
} from "../domain/flightSession";
import type { FlightPlan } from "../domain/flightPlans";
import type { FlightInput, QueuedOperation, Snapshot } from "../domain/model";
import { FlightSessions, useResumablePlans } from "./FlightSession";

type SessionId = ReturnType<typeof crypto.randomUUID>;
type Handlers = { children?: unknown; onClick?: () => unknown };
type FormProps = {
  onSavePreflight?: (input: FlightInput) => Promise<void>;
  onDone: () => void;
  prefill?: Partial<FlightInput>;
};

const ui = vi.hoisted(() => ({
  states: [] as unknown[],
  next: 0,
  buttons: new Map<string, () => unknown>(),
  forms: new Map<string, () => Promise<void>>(),
  flightForm: undefined as FormProps | undefined,
  workspace: {} as Record<string, unknown>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = ui.next++;
      if (!(slot in ui.states))
        ui.states[slot] = typeof initial === "function" ? initial() : initial;
      const set = (update: unknown) => {
        ui.states[slot] =
          typeof update === "function" ? update(ui.states[slot]) : update;
      };
      return [ui.states[slot], set];
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, element] = args;
      const props = element as Handlers;
      if (type === "button" && props.onClick)
        ui.buttons.set(textOf(props.children), props.onClick);
      return runtime.jsxDEV(...args);
    },
  };
});
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      const submit = props.onSubmit;
      ui.forms.set(props.submitLabel ?? "Save", () => submit(new FormData()));
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("./FlightForm", () => ({
  FlightForm: (props: FormProps) => {
    ui.flightForm = props;
    return null;
  },
}));
vi.mock("./PreflightMaintenance", () => ({ PreflightMaintenance: () => null }));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));

const VERIFIED_AT = "2026-01-01T10:00:00.000Z";
const FIRST = "40000000-0000-4000-8000-000000000001";
const SECOND = "40000000-0000-4000-8000-000000000002";
const PLAN = "30000000-0000-4000-8000-000000000001";
let s: Snapshot;
let storage: Map<string, string>;
let confirmed: boolean;

beforeEach(() => {
  s = demoSnapshot();
  storage = new Map();
  confirmed = true;
  ui.states = [];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", { confirm: () => confirmed });
  ui.workspace = {
    snapshot: s,
    namespace: "demo",
    queue: [],
    online: true,
    connected: true,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function textOf(node: unknown): string {
  if (typeof node === "string") return node.trim();
  return Array.isArray(node) ? node.map(textOf).join(" ").trim() : "";
}

function key() {
  return `angel-one-flight-sessions:demo:${s.user.id}:${s.activeProgramUuid}`;
}

function input(aircraftUuid: string, fields: Partial<FlightInput> = {}) {
  return {
    aircraftUuid,
    pilotId: s.user.id,
    startTime: VERIFIED_AT,
    origin: "KPAO",
    destination: "KSQL",
    landings: 1,
    cycles: 0,
    flightRules: "VFR",
    operation: "Mission",
    remarks: "",
    discrepancy: "",
    fuel: { unit: "US gal", start: 50, added: 0 },
    oil: [{ engine: "single", unit: "US qt", start: 6, added: 0 }],
    ...fields,
  } as FlightInput;
}

function saved(uuid: SessionId, index: number, fields?: Partial<FlightInput>) {
  const aircraft = { ...s.aircraft[index], twin: false };
  const entry = input(aircraft.uuid, fields);
  return startFlightSession(aircraft, entry, VERIFIED_AT, uuid);
}

function store(sessions: FlightSession[]) {
  storage.set(key(), JSON.stringify(sessions));
}

function stored(): FlightSession[] {
  return JSON.parse(storage.get(key()) ?? "[]");
}

function render(plan?: FlightPlan) {
  ui.next = 0;
  ui.buttons.clear();
  ui.forms.clear();
  ui.flightForm = undefined;
  return renderToStaticMarkup(h(Sessions, { plan }));
}

// FlightSessions's props default to {}, which createElement cannot type.
function Sessions({ plan }: { plan?: FlightPlan }) {
  return FlightSessions({ plan });
}

async function press(text: string) {
  const handler = ui.buttons.get(text);
  if (!handler) throw new Error(`No "${text}" button.`);
  await handler();
}

describe("FlightSessions", () => {
  it("lists saved preflights until their flight is logged or queued", async () => {
    store([saved(FIRST, 0), saved(SECOND, 1)]);
    const queued = { operation: { uuid: SECOND } } as QueuedOperation;
    ui.workspace.queue = [queued];
    const html = render();
    expect(html.match(/End flight<\/button>/g)).toHaveLength(1);
    expect(html).toContain(`<strong>${s.aircraft[0].registration}</strong>`);
    await press("End flight");
    render();
    ui.flightForm!.onDone();
    expect(stored().map((f) => f.uuid)).toEqual([SECOND]);
  });

  it("keeps unreadable saved data and disables Start flight", () => {
    storage.set(key(), "{not json");
    const html = render();
    expect(html).toContain("Saved preflight data could not be read.");
    expect(html).toMatch(/<button class="button primary" disabled="">/);
    expect(storage.get(key())).toBe("{not json");
  });

  it("removes a started flight only once the pilot confirms", async () => {
    store([saved(FIRST, 0)]);
    confirmed = false;
    render();
    await press("Cancel flight");
    expect(stored()).toHaveLength(1);
    confirmed = true;
    await press("Cancel flight");
    expect(stored()).toEqual([]);
  });

  it("refuses a second preflight on the same aircraft", async () => {
    store([saved(FIRST, 0)]);
    render();
    await press("Start flight");
    render();
    await expect(
      ui.forms.get("Verified — continue to flight information")!(),
    ).rejects.toThrow("This aircraft already has saved preflight data");
  });

  it("saves a verified preflight, and refuses one whose readings changed", async () => {
    render();
    await press("Start flight");
    render();
    await ui.forms.get("Verified — continue to flight information")!();
    render();
    const form = ui.flightForm!;
    await form.onSavePreflight!(input(s.aircraft[0].uuid));
    expect(stored().map((f) => f.input.aircraftUuid)).toEqual([
      s.aircraft[0].uuid,
    ]);
    s.aircraft[0] = { ...s.aircraft[0], version: s.aircraft[0].version + 1 };
    await expect(
      form.onSavePreflight!(input(s.aircraft[0].uuid)),
    ).rejects.toThrow(
      "Aircraft readings changed. Go back and verify the latest readings.",
    );
  });

  it("opens a plan's saved preflight as End flight, without the panel", () => {
    const plan = {
      uuid: PLAN,
      aircraftUuid: s.aircraft[1].uuid,
    } as FlightPlan;
    store([saved(SECOND, 1, { flightPlanUuid: plan.uuid })]);
    const html = render(plan);
    expect(html).not.toContain("Start flight / End flight");
    expect(ui.flightForm!.prefill).toMatchObject({ flightPlanUuid: plan.uuid });
  });

  it("names the plans whose saved preflight is not yet logged or queued", () => {
    const OTHER_PLAN = "30000000-0000-4000-8000-000000000002";
    store([
      saved(FIRST, 0, { flightPlanUuid: PLAN }),
      saved(SECOND, 1, { flightPlanUuid: OTHER_PLAN }),
      saved("40000000-0000-4000-8000-000000000003", 2),
    ]);
    ui.workspace.queue = [{ operation: { uuid: SECOND } } as QueuedOperation];
    const Probe = () => [...useResumablePlans()].join(",");
    expect(renderToStaticMarkup(h(Probe))).toBe(PLAN);
    storage.set(key(), "{not json");
    expect(renderToStaticMarkup(h(Probe))).toBe("");
  });
});
