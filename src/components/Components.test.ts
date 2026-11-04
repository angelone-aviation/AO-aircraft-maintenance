/**
 * Responsibility: Pins how the Components screen groups, searches and flags
 *   components, how a limit it cannot compute fails it, and what the
 *   component, requirement and service forms save and refuse.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Components.tsx, src/data/demo.ts,
 *   src/domain (components, model), convex/values, react-dom/server.
 */
// @vitest-environment node
import { ConvexError } from "convex/values";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { componentSchema, requirementSchema } from "../domain/components";
import { localDate, totalSeconds, type Snapshot } from "../domain/model";
import {
  ComponentForm,
  Components,
  RequirementForm,
  ServiceForm,
} from "./Components";

// The root's states are seeded in the order it declares them, and their
// updates recorded; later states are React's own.
const hooks = vi.hoisted(() => ({
  seeds: [] as unknown[],
  updates: [] as unknown[][],
  effects: [] as (() => void)[],
  forms: new Map<string, FormProps>(),
  search: {} as { item?: string },
}));
type FormProps = {
  onSubmit: (d: FormData) => Promise<void>;
  onChange?: (d: FormData) => void;
};
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) => {
    const slot = hooks.updates.length;
    if (!hooks.seeds.length) return react.useState(init);
    hooks.updates.push([]);
    const update = (next: unknown) => hooks.updates[slot].push(next);
    return [hooks.seeds.shift(), update];
  };
  const useEffect = (effect: () => void) => hooks.effects.push(effect);
  return { ...react, useState, useEffect };
});
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  Modal: (props: { title: string; children: ReactNode }) =>
    createElement("section", { "data-title": props.title }, props.children),
  AsyncForm: (
    props: FormProps & { submitLabel: string; children: ReactNode },
  ) => {
    hooks.forms.set(props.submitLabel, props);
    return createElement("form", null, props.children);
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useSearch: () => hooks.search,
  useNavigate: () => () => Promise.resolve(),
}));
vi.mock("./PartsRequests", () => ({ RequestPartsButton: () => null }));
vi.mock("./InventoryScanner", () => ({ ScanButton: () => null }));
vi.mock("./DrsComboBox", () => ({ DrsComboBox: () => null }));
vi.mock("./PlanComponentMovement", () => ({
  PlanComponentMovement: () => createElement("i", null, "Movement plan"),
}));
vi.mock("./InventoryPrinting", () => ({ InventoryPrintButtons: () => null }));
vi.mock("./InventoryAttachments", () => ({
  InventoryAttachments: () => null,
  InventoryFilePicker: () => null,
}));
vi.mock("./TaskCards", () => ({ LinkedTaskCards: () => null }));
vi.mock("./WorkOrders", () => ({ AddToWorkOrder: () => null }));
vi.mock("./AtaChapterField", () => ({ AtaChapterField: () => null }));
vi.mock("./RequiredParts", () => ({
  RequiredPartsFields: () => null,
  PartsAvailability: () => null,
  requiredPartsFromForm: () => [],
}));
vi.mock("./Manuals", () => ({
  ManualLink: () => null,
  ManualReferenceFields: () => null,
  manualReferenceFromForm: () => null,
}));
const manage = vi.fn(async (_command: unknown) => {});
const attachInventoryFile = vi.fn(async (_uuid: string, _file: File) => {});
const workspace = {
  snapshot: demoSnapshot() as Snapshot,
  online: true,
  connected: true,
  backend: { manage, attachInventoryFile },
};
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace, { setState: () => {} }),
}));

const HOUR = 3600;
const base = demoSnapshot();
const n206 = base.aircraft.find((a) => a.uuid === "demo-206")!;
const component = (uuid: string, extra: object = {}) =>
  componentSchema.parse({
    uuid,
    version: 1,
    kind: "component",
    aircraftUuid: "demo-206",
    componentType: "Engine",
    partNumber: "PN",
    serial: "SN-" + uuid,
    manufacturer: "",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: true,
    installedDate: "2026-01-01",
    installedSeconds: totalSeconds(n206),
    installedCycles: n206.cycles,
    timeSinceNew: 100 * HOUR,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 20,
    serviceDaysBase: 0,
    ...extra,
  });
const requirement = (uuid: string, c: string, extra: object) =>
  requirementSchema.parse({
    uuid,
    version: 1,
    kind: "componentRequirement",
    componentUuid: c,
    aircraftUuid: "demo-206",
    requirementType: "Life Limits",
    description: "Limit " + uuid,
    notes: "",
    calendarIntervalUnit: "MONTHS",
    timeBasis: "TSN",
    timeLimitMode: "ABSOLUTE",
    cycleLimitMode: "ABSOLUTE",
    warningCalendarMonths: 0,
    warningSeconds: 10 * HOUR,
    warningCycles: 0,
    ...extra,
  });
const ENGINE = component("engine", { ataChapter: "72" });
const PUMP = component("pump", {
  componentType: "Appliance",
  aircraftUuid: "demo-208",
  installedSeconds: totalSeconds(base.aircraft[1]),
  installedCycles: base.aircraft[1].cycles,
});
const SPARE = component("spare", { installed: false, aircraftUuid: "" });
const fileOf = (name: string) =>
  new File(["x"], name, { type: "application/pdf" });
const form = (label: string) => hooks.forms.get(label)!;
const fields = (entries: Record<string, string>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(entries)) d.set(k, v);
  return d;
};

beforeEach(() => {
  workspace.snapshot = { ...base, management: [ENGINE, PUMP, SPARE] };
  workspace.online = true;
  Object.assign(hooks, { seeds: [], updates: [], effects: [], search: {} });
  hooks.forms.clear();
  manage.mockClear();
  attachInventoryFile.mockReset();
});

function page(search = "", location = "all") {
  hooks.seeds = [null, "details", undefined, search, location];
  return renderToStaticMarkup(createElement(Components));
}

describe("the component list", () => {
  it("groups under each aircraft or Inventory, sorted by label", () => {
    const groups = [
      ...page().matchAll(/<table[^>]* aria-label="([^"]+) components"/g),
    ];
    expect(groups.map((m) => m[1])).toEqual(["Inventory", "N206MA", "N208MA"]);
  });

  it("searches registration and ATA chapter", () => {
    expect(page("n208")).toContain('aria-label="N208MA components"');
    expect(page("n208")).not.toContain('aria-label="N206MA components"');
    expect(page("ata 72")).toContain("SN-engine");
    expect(page("ata 72")).not.toContain("SN-pump");
  });

  it("flags a usage limit at zero (Due now) as Past due", () => {
    const limit = { dueCycles: ENGINE.cyclesSinceNew };
    workspace.snapshot.management!.push(requirement("r", "engine", limit));
    expect(page()).toContain("0 cycles");
    expect(page()).toContain(">Past due<");
  });

  it("fails on a limit it cannot compute (Characterizes current behaviour)", () => {
    const early = component("early", {
      installedSeconds: totalSeconds(n206) + HOUR,
    });
    workspace.snapshot.management = [early, requirement("r", "early", {})];
    expect(() => page()).toThrow(
      "Aircraft readings or date precede the installation baseline.",
    );
  });

  it("opens a linked component's details", () => {
    hooks.search = { item: "pump" };
    page();
    hooks.effects[0]();
    expect(hooks.updates.slice(0, 2)).toEqual([[PUMP], ["details"]]);
  });
});

const onDone = vi.fn();
const NEW_SPARE = { componentType: "Engine", serial: "SN-9" };
const render = (files: File[], record?: typeof ENGINE) => {
  hooks.seeds = [files, undefined, ""];
  renderToStaticMarkup(createElement(ComponentForm, { onDone, record }));
  return form(record ? "Save component details" : "Save component");
};

describe("ComponentForm attachments", () => {
  it("refuses attachments offline before saving anything", async () => {
    workspace.online = false;
    await expect(
      render([fileOf("a.pdf")]).onSubmit(fields(NEW_SPARE)),
    ).rejects.toThrow("Reconnect before saving a component with attachments.");
    expect(manage).not.toHaveBeenCalled();
  });

  it("offers the failed file and the rest for retry, with the refusal", async () => {
    attachInventoryFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ConvexError("File refused."));
    const files = ["a.pdf", "b.pdf", "c.pdf"].map(fileOf);
    await render(files).onSubmit(fields(NEW_SPARE));
    const [filesLeft, saved, error] = hooks.updates;
    expect(filesLeft[0]).toEqual(files.slice(1));
    expect(error).toEqual(["File refused."]);
    expect(saved[0]).toMatchObject({ serial: "SN-9", version: 1 });
    expect(onDone).not.toHaveBeenCalled();
  });

  it("shows no server internals for a failed upload", async () => {
    attachInventoryFile.mockRejectedValue(
      new Error("[CONVEX A(files:attach)] [Request ID: 1] Server Error"),
    );
    await render([fileOf("a.pdf")]).onSubmit(fields(NEW_SPARE));
    expect(hooks.updates[2]).toEqual(["Upload failed."]);
  });
});

describe("ComponentForm for an edit", () => {
  it("keeps the stored readings when editing", async () => {
    const readings = {
      installedSeconds: "1",
      timeSinceNew: "2",
      cyclesSinceNew: "3",
    };
    await render([], ENGINE).onSubmit(fields({ ...NEW_SPARE, ...readings }));
    expect(manage.mock.calls[0][0]).toMatchObject({
      record: {
        installedSeconds: ENGINE.installedSeconds,
        timeSinceNew: ENGINE.timeSinceNew,
        cyclesSinceNew: ENGINE.cyclesSinceNew,
        version: ENGINE.version,
      },
    });
  });
});

describe("ComponentForm for a new component", () => {
  it("installs a trackable part in its assembly's position", async () => {
    const parent = { ...ENGINE, installPosition: "LEFT" as const };
    hooks.seeds = [[], undefined, ""];
    const props = {
      onDone,
      parentComponent: parent,
      initialAircraftUuid: "demo-206",
    };
    renderToStaticMarkup(createElement(ComponentForm, props));
    await form("Save component").onSubmit(
      fields({
        ...NEW_SPARE,
        installPosition: "RIGHT",
        installedSeconds: "1",
        installedCycles: "1",
      }),
    );
    expect(manage.mock.calls[0][0]).toMatchObject({
      record: { installPosition: "LEFT", parentComponentUuid: "engine" },
    });
  });

  it("starts pre-filled readings blank instead of at zero", () => {
    const tsn = (html: string) =>
      /<input[^>]*name="timeSinceNew"[^>]*>/.exec(html)![0];
    const blank = renderToStaticMarkup(
      createElement(ComponentForm, {
        onDone,
        defaults: { componentType: "Pump" },
      }),
    );
    const fresh = renderToStaticMarkup(
      createElement(ComponentForm, { onDone }),
    );
    expect(tsn(blank)).not.toContain("value=");
    expect(tsn(fresh)).toContain('value="0"');
  });
});

describe("RequirementForm", () => {
  const renderRequirement = (c = ENGINE, defaults?: object) => {
    const onDone = () => {};
    return renderToStaticMarkup(
      createElement(RequirementForm, { c, defaults, onDone }),
    );
  };

  it("previews when pre-filled limits fall due, first reached", () => {
    hooks.seeds = [{ time: true, calendar: false, cycles: true }, ""];
    renderRequirement(ENGINE, { description: "Life" });
    const preview = (entries: Record<string, string>) => {
      form("Calculate and save").onChange!(fields(entries));
      return hooks.updates[1].at(-1);
    };
    const limits = { intervalSeconds: "200", intervalCycles: "50" };
    const life = { requirementType: "Life Limits", description: "Life" };
    expect(preview({ ...life, ...limits })).toBe(
      "Next due: 200 TSN hours or 50 cycles (first reached).",
    );
    expect(preview({ ...life, intervalSeconds: "abc" })).toBe(
      "Complete the limits and verified compliance history to calculate due values.",
    );
  });

  it("offers landings only for an installed component", () => {
    const landings = (html: string) => /<input[^>]*>Landings</.exec(html)![0];
    expect(landings(renderRequirement(ENGINE))).not.toContain("disabled");
    expect(landings(renderRequirement(SPARE))).toContain("disabled");
  });
});

describe("ServiceForm", () => {
  it("plans an installed component's removal on a work order", () => {
    const html = renderToStaticMarkup(
      createElement(ServiceForm, { c: ENGINE, onDone: () => {} }),
    );
    expect(html).toContain("Movement plan");
  });

  it("records a stored component's overhaul with today's date", async () => {
    hooks.seeds = ["overhaul"];
    renderToStaticMarkup(
      createElement(ServiceForm, { c: SPARE, onDone: () => {} }),
    );
    await form("Save service event").onSubmit(fields({ reason: "Overhauled" }));
    expect(manage.mock.calls[0][0]).toMatchObject({
      action: "component.service",
      uuid: "spare",
      operation: "overhaul",
      reason: "Overhauled",
      date: localDate(),
    });
  });
});
