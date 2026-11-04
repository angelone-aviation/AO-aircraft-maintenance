/**
 * Responsibility: Pins the checklist reader (personal checkmarks and skips,
 *   their storage, resets and navigation) and the checklists screen (library
 *   search, new and imported drafts, import refusals).
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Checklists.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/checklists.ts.
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep each
 * component's useState values by name and key (dropped once it stops
 * rendering, as on unmount) and capture buttons: a test renders, acts, and
 * renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { ChecklistDocument, ChecklistRecord } from "../domain/checklists";
import type { Snapshot } from "../domain/model";
import { ChecklistReader, Checklists, type Progress } from "./Checklists";

type Frame = { key: string; next: number };
type Props = Record<string, unknown>;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as Frame[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  buttons: [] as { text: string; props: Props }[],
  inputs: [] as Props[],
  stubs: new Map<string, Props>(),
  workspace: {} as Props,
  imported: undefined as unknown,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const frame = ui.frames[ui.frames.length - 1];
      const slots = ui.states.get(frame.key) ?? [];
      ui.states.set(frame.key, slots);
      const slot = frame.next++;
      if (!(slot in slots))
        slots[slot] = typeof initial === "function" ? initial() : initial;
      const set = (update: unknown) => {
        slots[slot] =
          typeof update === "function" ? update(slots[slot]) : update;
      };
      return [slots[slot], set];
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const tracked = (type: FunctionComponent, key: unknown) => {
    const byKey = ui.wrappers.get(type) ?? new Map<unknown, unknown>();
    ui.wrappers.set(type, byKey);
    if (!byKey.has(key))
      byKey.set(key, (props: object) => {
        const id = `${type.name}:${String(key)}`;
        ui.rendered.add(id);
        ui.frames.push({ key: id, next: 0 });
        try {
          return type(props);
        } finally {
          ui.frames.pop();
        }
      });
    return byKey.get(key);
  };
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = args;
      const p = props as Props;
      if (type === "button")
        ui.buttons.push({
          text: ((p["aria-label"] as string) ?? textOf(p.children)).trim(),
          props: p,
        });
      if (type === "input") ui.inputs.push(p);
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, args[2]) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number")
      return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object" && "props" in node)
      return textOf((node.props as Props).children);
    return "";
  }
});
vi.mock("./GuidedFlight", () => ({ GuidedFlight: stub("GuidedFlight") }));
vi.mock("./ChecklistEditor", () => ({
  ChecklistEditor: stub("ChecklistEditor"),
}));
vi.mock("./design", async (importOriginal) => {
  const design = await importOriginal<typeof import("./design")>();
  return {
    ...design,
    SearchField: (props: Parameters<typeof design.SearchField>[0]) => {
      ui.stubs.set("SearchField", props as never);
      return design.SearchField(props);
    },
  };
});
vi.mock("./OpsList", () => ({ OpsSelect: stub("OpsSelect") }));
vi.mock("../data/fmd", () => ({
  importFmd: async () => {
    if (ui.imported instanceof Error) throw ui.imported;
    return structuredClone(ui.imported);
  },
  exportFmd: async () => new Blob(["fmd"]),
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));

// A stub records its props, so a test can read them and call callbacks.
function stub(name: string) {
  return (props: Props) => {
    ui.stubs.set(name, props);
    return `[${name}]`;
  };
}

const KEY = "angel-one-checks:demo:demo-admin:c1:2";
let s: Snapshot;
let storage: Map<string, string>;
let failWrites: boolean;
let confirmAnswer: boolean;

function documentFixture(): ChecklistDocument {
  return {
    type: "checklist",
    payload: {
      objectId: "doc",
      schemaVersion: "1.0",
      metadata: { name: "Cessna 206", detail: "Normal", tailNumber: "" },
      groups: [
        { objectId: "abnormal", groupType: "abnormal", items: [] },
        {
          objectId: "normal",
          groupType: "normal",
          items: [
            {
              objectId: "g1",
              title: "Preflight",
              items: [
                {
                  objectId: "l1",
                  title: "Cabin",
                  items: [
                    { objectId: "c0", type: "comment", title: "Before" },
                    { objectId: "i1", title: "Fuel", detail: "On" },
                    {
                      objectId: "i2",
                      title: "Mags",
                      note: "Both",
                      actions: [1],
                    },
                  ],
                },
                { objectId: "l2", title: "", items: [{ objectId: "i3" }] },
              ],
            },
          ],
        },
      ],
    },
  };
}

function record(fields: Partial<ChecklistRecord> = {}): ChecklistRecord {
  return {
    uuid: "c1",
    version: 2,
    programUuid: "demo-program",
    aircraftUuid: "",
    sourceName: "c206.fmd",
    updatedAt: 1,
    updatedBy: "demo-admin",
    document: documentFixture(),
    ...fields,
  };
}

beforeEach(() => {
  ui.states.clear();
  ui.stubs.clear();
  ui.imported = documentFixture();
  storage = new Map();
  failWrites = false;
  confirmAnswer = true;
  s = { ...demoSnapshot(), checklists: [record()] };
  ui.workspace = {
    snapshot: s,
    namespace: "demo",
    online: true,
    connected: true,
  };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw Error("quota");
      storage.set(k, v);
    },
  });
  vi.stubGlobal("window", { confirm: () => confirmAnswer });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let element: Parameters<typeof renderToStaticMarkup>[0];

function render(next = element) {
  element = next;
  ui.buttons = [];
  ui.inputs = [];
  ui.rendered.clear();
  ui.frames = [{ key: "root", next: 0 }];
  const html = renderToStaticMarkup(element);
  for (const key of ui.states.keys())
    if (key !== "root" && !ui.rendered.has(key)) ui.states.delete(key);
  return html;
}

function click(text: string, index = 0) {
  const found = ui.buttons.filter((b) => b.text === text)[index];
  if (!found) throw Error(`No button "${text}"`);
  (found.props.onClick as () => unknown)();
  return render();
}

// The check buttons, in entry order; they carry no accessible name of their own.
function check(index: number) {
  const found = ui.buttons.filter((b) => b.props.role === "checkbox")[index];
  (found.props.onClick as () => unknown)();
  return render();
}

const reader = (props: Partial<Parameters<typeof ChecklistReader>[0]> = {}) =>
  h(ChecklistReader, { record: record(), ...props });

describe("ChecklistReader", () => {
  it("opens the first category and list with checks, from stored progress", () => {
    storage.set(KEY, JSON.stringify({ i1: "checked", i9: "maybe" }));
    const html = render(reader());
    expect(html).toContain("<h3>Cabin</h3>");
    expect(html).toContain('<p role="status">1 of 2 checked</p>');
    expect(html).toContain("Next: Mags");
    expect(html).toContain("Flight Program library");
    expect(html).toContain("This entry contains additional source actions");
    expect(html).toContain("<small>1/2 </small>");
  });

  it("checks, skips and completes the list, storing each change", () => {
    render(reader());
    click("Check next item");
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ i1: "checked" });
    click("Skip next item");
    const html = render();
    expect(html).toContain("1 of 2 checked · 1 skipped");
    expect(html).toContain("Review skipped items before completing");
    click("Unskip Mags");
    check(1);
    expect(render()).toContain("2 of 2 checked · Checklist complete");
    expect(render()).toContain("All items checked");
    check(0);
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ i2: "checked" });
  });

  it("says when checkmarks cannot be stored, and starts empty on bad data", () => {
    storage.set(KEY, "{not json");
    expect(render(reader())).toContain("0 of 2 checked");
    failWrites = true;
    expect(click("Check next item")).toContain(
      "Browser storage is unavailable. These checkmarks will not survive a reload.",
    );
    expect(render()).toContain("1 of 2 checked");
  });

  it("resets one list or all after a confirm", () => {
    storage.set(KEY, JSON.stringify({ i1: "checked", i3: "skipped" }));
    render(reader());
    confirmAnswer = false;
    click("Reset checklist");
    expect(render()).toContain("1 of 2 checked");
    confirmAnswer = true;
    click("Reset checklist");
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ i3: "skipped" });
    click("Reset all checklists");
    expect(JSON.parse(storage.get(KEY)!)).toEqual({});
  });

  it("moves between lists and categories", () => {
    render(reader());
    expect(click("Next checklist")).toContain("<h3>Untitled checklist</h3>");
    expect(render()).toContain("<span>2 / 2</span>");
    expect(
      ui.buttons.find((b) => b.text === "Next checklist")!.props.disabled,
    ).toBe(true);
    expect(click("abnormal0")).toContain("No checklists in this category");
    expect(render()).toContain("Choose another category.");
    ui.states.clear();
    expect(render(reader({ initialList: "l2", onEdit: () => {} }))).toContain(
      "<span>2 / 2</span>",
    );
  });

  it("reports progress to its owner instead of storing it", () => {
    const reported: Progress[] = [];
    render(
      reader({
        progress: { i1: "checked" },
        onProgress: (p) => reported.push(p),
      }),
    );
    click("Check next item");
    expect(reported).toEqual([{ i1: "checked", i2: "checked" }]);
    expect(storage.size).toBe(0);
  });
});

describe("Checklists", () => {
  it("searches the library and opens a choice", () => {
    s.checklists = [
      record(),
      record({ uuid: "c2", aircraftUuid: "demo-208", sourceName: "x.fmd" }),
    ];
    s.checklists[1].document.payload.metadata.name = "";
    const html = render(h(Checklists));
    expect(html).toContain("N208MA · 2 sections");
    expect(html).toContain("<strong>x.fmd</strong>");
    (ui.stubs.get("SearchField")!.onChange as (v: string) => void)(" n208 ");
    expect(render()).not.toContain("Cessna 206</strong>");
    (ui.stubs.get("SearchField")!.onChange as (v: string) => void)("zz");
    expect(render()).toContain("No matching checklists.");
    (ui.stubs.get("SearchField")!.onChange as (v: string) => void)("");
    (ui.stubs.get("OpsSelect")!.onChange as (v: string) => void)("demo-206");
    const filtered = render();
    expect(filtered).toContain("Flight Program library ·");
    expect(filtered).not.toContain("N208MA ·");
  });

  it("drafts a new checklist for the program library or a matching aircraft", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );
    render(h(Checklists));
    click("New checklist");
    expect(ui.stubs.get("ChecklistEditor")!.initial).toMatchObject({
      uuid: "00000000-0000-4000-8000-000000000001",
      version: 0,
      programUuid: "demo-program",
      aircraftUuid: "",
      sourceName: "",
      updatedBy: "demo-admin",
    });
  });

  it("imports an .fmd file, naming it after the file when unnamed", async () => {
    render(h(Checklists));
    const input = ui.inputs.find((i) => i.type === "file")!;
    const doc = documentFixture();
    doc.payload.metadata = { name: "", tailNumber: "n208ma" };
    ui.imported = doc;
    const target = {
      value: "C:\\fakepath\\Caravan.FMD",
      files: [new File(["x"], "Caravan.FMD")],
    };
    await (input.onChange as (e: object) => Promise<void>)({ target });
    render();
    expect(target.value).toBe("");
    expect(ui.stubs.get("ChecklistEditor")!.initial).toMatchObject({
      aircraftUuid: "demo-208",
      sourceName: "Caravan.FMD",
      document: { payload: { metadata: { name: "Caravan" } } },
    });
  });

  it("refuses other files and shows import failures", async () => {
    render(h(Checklists));
    const input = ui.inputs.find((i) => i.type === "file")!;
    const change = (file: File) =>
      (input.onChange as (e: object) => Promise<void>)({
        target: { value: "", files: [file] },
      });
    await change(new File(["x"], "notes.txt"));
    expect(render()).toContain(
      '<p class="error" role="alert">Choose a ForeFlight .fmd checklist under 2 MB.</p>',
    );
    ui.imported = Error("Unable to read this FMD file.");
    await change(new File(["x"], "a.fmd"));
    expect(render()).toContain("Unable to read this FMD file.");
  });

  it("needs a connection and edit access to change checklists", () => {
    ui.workspace.online = false;
    render(h(Checklists));
    expect(
      ui.buttons.find((b) => b.text === "New checklist")!.props.disabled,
    ).toBe(true);
    expect(ui.buttons.some((b) => b.text === "Edit checklist")).toBe(false);
    s.checklists = [];
    expect(render()).toContain("Your checklist library is ready");
  });
});
