/**
 * Responsibility: Pins how manual search reports its pages and stops, which
 *   components a candidate offers, what a requirement and an inspection
 *   start from, and what the inspection form refuses and previews.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ManualDiscovery.tsx, src/data/demo.ts,
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { ManualCandidate } from "../domain/manualDiscovery";
import type { Snapshot } from "../domain/model";
import { CandidateForm, ManualDiscoveryButton } from "./ManualDiscovery";

// The root's states are seeded in the order it declares them, and their
// updates recorded; later states are React's own.
const hooks = vi.hoisted(() => ({
  seeds: [] as unknown[],
  updates: [] as unknown[][],
  forms: new Map<string, (d: FormData) => Promise<void>>(),
  props: new Map<string, Record<string, unknown>>(),
  previews: [] as ((e: unknown) => void)[],
  search: {
    emptyPages: [] as number[],
    fail: "",
    abort: undefined as (() => void) | undefined,
  },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) => {
    const slot = hooks.updates.length;
    if (!hooks.seeds.length) return react.useState(init);
    hooks.updates.push([]);
    const update = (next: unknown) => hooks.updates[slot].push(next);
    return [hooks.seeds.shift(), update];
  };
  return { ...react, useState, useEffect: () => {} };
});
// Tests compile JSX for development, so the preview's div is seen in jsxDEV.
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  type Props = { onChange?: (e: unknown) => void };
  const jsxDEV = (type: unknown, props: Props, ...rest: unknown[]) => {
    if (type === "div" && props.onChange) hooks.previews.push(props.onChange);
    return (runtime.jsxDEV as (...args: unknown[]) => unknown)(
      type,
      props,
      ...rest,
    );
  };
  return { ...runtime, jsxDEV };
});
vi.mock("react-dom", async (original) => ({
  ...(await original<typeof import("react-dom")>()),
  createPortal: (node: ReactNode) => node,
}));
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  Modal: (props: { children: ReactNode }) =>
    createElement("section", null, props.children),
  AsyncForm: (props: {
    submitLabel: string;
    onSubmit: (d: FormData) => Promise<void>;
    children: ReactNode;
  }) => {
    hooks.forms.set(props.submitLabel, props.onSubmit);
    return createElement("form", null, props.children);
  },
}));
vi.mock("./Components", () => {
  const capture = (name: string) => (props: Record<string, unknown>) => {
    hooks.props.set(name, props);
    return createElement("i", null, name);
  };
  return {
    ComponentForm: capture("ComponentForm"),
    RequirementForm: capture("RequirementForm"),
  };
});
vi.mock("./Manuals", () => ({
  ManualLink: () => null,
  ManualReferenceFields: () => null,
  manualReferenceFromForm: () => null,
}));
vi.mock("./AtaChapterField", () => ({ AtaChapterField: () => null }));
vi.mock("./KeepOnDevice", () => ({
  openManualFile: async () => ({ url: "blob:manual", fromDevice: true }),
}));
vi.mock("../data/manualPdf", () => ({
  searchManualPdf: async () => {
    if (hooks.search.fail === "cancel") hooks.search.abort?.();
    if (hooks.search.fail) throw new Error("PDF unreadable");
    return { emptyPages: hooks.search.emptyPages };
  },
}));
// The search's own controller, so a test can cancel it mid-search.
class Controller extends AbortController {
  constructor() {
    super();
    Object.assign(hooks.search, { abort: () => this.abort() });
  }
}
vi.stubGlobal("AbortController", Controller);
vi.stubGlobal("document", { body: null });
// The preview builds FormData from the form element it finds.
class Form extends FormData {
  constructor(form?: { entries: [string, string][] }) {
    super();
    for (const [k, v] of form?.entries ?? []) this.set(k, v);
  }
}
vi.stubGlobal("FormData", Form);
const revoked: string[] = [];
URL.revokeObjectURL = (url: string) => void revoked.push(url);
const manage = vi.fn(async (_command: unknown) => {});
const workspace = {
  snapshot: demoSnapshot() as Snapshot,
  online: true,
  connected: true,
  backend: { manage },
};
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => workspace, { setState: () => {} }),
}));

const base = demoSnapshot();
const MANUAL = {
  revisionDate: "2026-01-01",
  filename: "mm.pdf",
  size: 1,
  uuid: "manual",
  aircraftUuid: "demo-206",
  title: "Maintenance Manual",
  documentNumber: "MM",
  revision: "A",
  pageCount: 40,
  uploadedAt: 0,
  uploadedBy: "demo-admin",
};
const SCOPE = { kind: "component", manufacturer: "", model: "IO-540" };
const engine = (uuid: string, extra: object = {}) =>
  ({
    uuid,
    kind: "component",
    aircraftUuid: "demo-206",
    componentType: "Engine",
    model: "IO-540",
    manufacturer: "Lycoming",
    partNumber: "PN-1",
    serial: "S-" + uuid,
    trackTime: true,
    trackCycles: true,
    trackCalendar: true,
    installed: true,
    ...extra,
  }) as never;
const candidate = (extra: Partial<ManualCandidate> = {}): ManualCandidate => ({
  sourceKey: "src",
  name: "Overhaul engine",
  kind: "component",
  text: "Life limit 2000 hours",
  scheduleText: "",
  warnings: [],
  hours: 2000,
  reference: { manualUuid: "manual", section: "", printedPage: "", pdfPage: 1 },
  ...extra,
});
const fields = (entries: Record<string, string>) => {
  const d = new Form();
  for (const [k, v] of Object.entries(entries)) d.set(k, v);
  return d;
};

beforeEach(() => {
  workspace.snapshot = {
    ...base,
    manuals: [{ ...MANUAL, applicability: { ...SCOPE, partNumber: "" } }],
    management: [engine("e1"), engine("e2", { manufacturer: "Other" })],
  } as Snapshot;
  Object.assign(hooks, { seeds: [], updates: [], previews: [] });
  Object.assign(hooks.search, { emptyPages: [], fail: "" });
  hooks.forms.clear();
  hooks.props.clear();
  revoked.length = 0;
  manage.mockClear();
});

describe("manual search", () => {
  const search = async () => {
    hooks.updates = [];
    hooks.seeds = [true, false, [], "", 100, "", "", undefined, ""];
    renderToStaticMarkup(
      createElement(ManualDiscoveryButton, { manual: MANUAL }),
    );
    await hooks.forms.get("Search manual")!(fields({ from: "2", to: "30" }));
    return hooks.updates[6].at(-1);
  };

  it("lists the first 20 pages without text, then an ellipsis", async () => {
    hooks.search.emptyPages = Array.from({ length: 21 }, (_, i) => i + 2);
    expect(await search()).toBe(
      "Searched PDF pages 2–30. Found 0 suggestions. 21 pages had little or no searchable text (pages 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, …); review these pages separately.",
    );
    expect(revoked).toEqual(["blob:manual"]);
  });

  it("keeps partial results on a cancel, and reports a failure", async () => {
    hooks.search.fail = "cancel";
    expect(await search()).toMatch(/^Search canceled\. Partial results/);
    hooks.search.fail = "fail";
    await expect(search()).rejects.toThrow("PDF unreadable");
    expect(hooks.updates[6].at(-1)).toMatch(/^Search failed before completion/);
    expect(revoked).toEqual(["blob:manual", "blob:manual"]);
  });

  it("refuses a page range outside the manual", async () => {
    hooks.seeds = [true, false, [], "", 100, "", "", undefined, ""];
    renderToStaticMarkup(
      createElement(ManualDiscoveryButton, { manual: MANUAL }),
    );
    const submit = hooks.forms.get("Search manual")!;
    await expect(submit(fields({ from: "2", to: "41" }))).rejects.toThrow(
      "Choose a valid PDF page range.",
    );
  });
});

type CandidateProps = Parameters<typeof CandidateForm>[0];

// Seeds the candidate form's target and created component ids.
function render(row: ManualCandidate, action: string, seeds: unknown[]) {
  hooks.seeds = seeds;
  const onDone = () => {};
  const props = { row, scope: { ...SCOPE, partNumber: "" }, action, onDone };
  return renderToStaticMarkup(
    createElement(CandidateForm, props as CandidateProps),
  );
}

describe("CandidateForm targets", () => {
  it("offers components of the candidate's maker, ignoring case and spaces", () => {
    const row = candidate({
      componentDefaults: { manufacturer: " LYCOMING " },
    });
    const html = render(row, "requirement", ["", ""]);
    expect(html).toContain('value="e1"');
    expect(html).not.toContain('value="e2"');
  });
});

describe("CandidateForm requirements", () => {
  it("starts a component limit as an absolute life limit, an overhaul from the last one", () => {
    render(candidate({ name: "N".repeat(300) }), "requirement", ["e1", ""]);
    expect(hooks.props.get("RequirementForm")!.defaults).toMatchObject({
      requirementType: "Life Limits",
      timeLimitMode: "ABSOLUTE",
      intervalSeconds: 2000 * 3600,
      description: "N".repeat(255),
    });
    render(candidate({ text: "OVERHAUL every 2000 hours" }), "requirement", [
      "e1",
      "",
    ]);
    expect(hooks.props.get("RequirementForm")!.defaults).toMatchObject({
      requirementType: "Overhaul Requirement",
      cycleLimitMode: "FROM_LAST_COMPLIED",
    });
  });

  it("asks for tracking a suggested limit needs, and refuses a repeat", () => {
    workspace.snapshot.management!.push(engine("e3", { trackTime: false }));
    expect(render(candidate(), "requirement", ["e3", ""])).toContain(
      "Enable all suggested tracking dimensions",
    );
    workspace.snapshot.management!.push({
      kind: "componentRequirement",
      componentUuid: "e1",
      sourceKey: "src",
    } as never);
    expect(render(candidate(), "requirement", ["e1", ""])).toContain(
      "already been added to this component",
    );
  });
});

// Seeds the inspection form's aircraft, schedule and fixed record id.
function inspection(target: string, mode: string) {
  const row = candidate({ kind: "inspection", initialHours: 50 });
  const model = base.aircraft[0].model;
  const scope = { kind: "aircraft", manufacturer: "", model, partNumber: "" };
  hooks.seeds = ["", "", target, mode, "", "id"];
  const props = { row, scope, action: "inspection", onDone: () => {} };
  renderToStaticMarkup(createElement(CandidateForm, props as CandidateProps));
  return hooks.forms.get("Save inspection")!;
}

describe("inspection from a candidate", () => {
  it("needs a schedule and an aircraft of the manual's model", async () => {
    await expect(inspection("demo-206", "")(fields({}))).rejects.toThrow(
      "Choose an initial or recurring schedule.",
    );
    await expect(inspection("demo-208", "initial")(fields({}))).rejects.toThrow(
      "Select an aircraft of the associated model.",
    );
  });

  it("saves an initial inspection with due limits only", async () => {
    const entries = { reference: "R", intervalHours: "100", dueHours: "50" };
    await inspection("demo-206", "initial")(fields(entries));
    expect(manage.mock.calls[0][0]).toMatchObject({
      requestUuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      record: {
        uuid: "id",
        sourceKey: "src:initial",
        intervalSeconds: undefined,
        dueSeconds: 50 * 3600,
      },
    });
  });

  // Roadmap leftover (LO-1): a request id kept for the form's life made an
  // edited save after a lost reply a reused id, which the server refuses.
  it("resends an identical save under its request id, and an edited one under a new id", async () => {
    const save = inspection("demo-206", "initial");
    const entries = { reference: "R", intervalHours: "100", dueHours: "50" };
    await save(fields(entries));
    await save(fields(entries));
    await save(fields({ ...entries, dueHours: "60" }));
    const ids = manage.mock.calls.map(
      ([command]) => (command as { requestUuid: string }).requestUuid,
    );
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(manage.mock.calls[2][0]).toMatchObject({ record: { uuid: "id" } });
  });

  it("previews the first limit reached, skipping a date still being typed", () => {
    inspection("demo-206", "recurring");
    const preview = (entries: Record<string, string>) => {
      const form = { entries: Object.entries(entries) };
      hooks.previews[0]({ target: { closest: () => form } });
      return hooks.updates[4].at(-1);
    };
    const readings = { intervalHours: "100", lastHours: "1200" };
    expect(
      preview({ ...readings, intervalMonths: "6", lastDate: "2026-0" }),
    ).toBe("Next due: 1300 aircraft hours (first reached).");
  });
});
