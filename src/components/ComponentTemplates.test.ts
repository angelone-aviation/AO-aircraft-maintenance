/**
 * Responsibility: Pins the component-template panel: the Setup incomplete
 *   list, the template editor and its CSV import, and the preview that
 *   applies a template to an aircraft.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ComponentTemplates.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/componentTemplates.ts.
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep each
 * component's useState values by name and key (dropped once it stops
 * rendering, as on unmount) and capture buttons, fields and forms: a test
 * renders, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import type {
  ComponentSetup,
  ComponentTemplate,
} from "../domain/componentTemplates";
import { ComponentTemplatesPanel } from "./ComponentTemplates";

type Control = {
  onChange: (event: { target: Record<string, unknown> }) => unknown;
};
type Frame = { key: string; next: number };

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as Frame[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  buttons: [] as { text: string; props: Record<string, unknown> }[],
  boxes: new Map<string, Control & Record<string, unknown>>(),
  fields: new Map<string, Control & Record<string, unknown>>(),
  forms: new Map<string, (data: FormData) => Promise<void>>(),
  form: {} as Record<string, unknown>,
  downloads: [] as string[][],
  workspace: {} as Record<string, unknown>,
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
      const [type, props, key] = args;
      const named = props as { "aria-label"?: string };
      if (type === "button")
        ui.buttons.push({ text: textOf(props), props: props as never });
      if (type === "input" && named["aria-label"])
        ui.boxes.set(named["aria-label"], props as never);
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, key) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (node == null || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && "children" in node)
      return textOf(node.children);
    if (typeof node === "object" && "props" in node) return textOf(node.props);
    return String(node);
  }
});
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    download: (...args: string[]) => ui.downloads.push(args),
    Field: (props: Parameters<typeof actual.Field>[0]) => {
      const control = (props.children as { props: Control }).props;
      ui.fields.set(props.label, control as never);
      return actual.Field(props);
    },
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props.onSubmit);
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("./Components", () => ({
  ComponentForm: (props: Record<string, unknown>) => {
    ui.form = props;
    return null;
  },
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));

const ENGINE = {
  id: "engine",
  parentId: "",
  componentType: "Engine",
  ataChapter: "72",
  partNumber: "E123",
  model: "Template engine",
  manufacturer: "Maker",
  installPosition: "MAIN",
} as const;
const CHILD = {
  ...ENGINE,
  id: "child",
  parentId: "engine",
  componentType: "Appliance",
  partNumber: "A123",
  model: "Attached part",
  installPosition: undefined,
} as const;
const TEMPLATE: ComponentTemplate = {
  uuid: "00000000-0000-4000-8000-000000000001",
  version: 3,
  name: "206 Equipment",
  make: "Cessna",
  model: "206 Stationair",
  rows: [ENGINE, CHILD],
};
const HEADER =
  "Component type,ATA chapter,Part number,Component Name,Manufacturer,Position,ID,Parent ID";
let s: Snapshot;
let saved: unknown[];
let applied: unknown[];

beforeEach(() => {
  ui.states.clear();
  ui.downloads = [];
  saved = [];
  applied = [];
  s = { ...demoSnapshot(), componentTemplates: [TEMPLATE] };
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: {
      saveComponentTemplate: async (t: unknown) => void saved.push(t),
      applyComponentTemplate: async (a: unknown) => void applied.push(a),
    },
  };
});

function render() {
  ui.buttons = [];
  ui.boxes.clear();
  ui.fields.clear();
  ui.forms.clear();
  ui.rendered.clear();
  ui.frames = [{ key: "root", next: 0 }];
  const html = renderToStaticMarkup(h(ComponentTemplatesPanel));
  for (const key of ui.states.keys())
    if (key !== "root" && !ui.rendered.has(key)) ui.states.delete(key);
  return html;
}

function button(text: string) {
  const found = ui.buttons.filter((b) => b.text.trim() === text);
  if (!found.length) throw Error(`No button "${text}"`);
  return found[found.length - 1].props;
}

function disabled(text: string) {
  return ui.buttons.filter((b) => b.text === text).map((b) => b.props.disabled);
}

function click(text: string) {
  (button(text).onClick as () => void)();
  return render();
}

function openLibrary() {
  render();
  return click("Component templates");
}

function checkbox(model: string) {
  return ui.boxes.get(`Select ${model}`)!;
}

function change(label: string, target: Record<string, unknown>) {
  const result = ui.fields.get(label)!.onChange({ target });
  return Promise.resolve(result).then(render);
}

function submit(label: string, data: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, text] of Object.entries(data)) form.set(key, text);
  return ui.forms.get(label)!(form);
}

function setup(row: ComponentSetup["row"], extra = {}): ComponentSetup {
  return {
    uuid: `setup-${row.id}`,
    programUuid: s.activeProgramUuid!,
    aircraftUuid: "demo-206",
    templateUuid: TEMPLATE.uuid,
    templateName: TEMPLATE.name,
    row,
    ...extra,
  };
}

function component(uuid: string, aircraftUuid: string, installed: boolean) {
  return {
    kind: "component",
    uuid,
    aircraftUuid,
    installed,
  } as unknown as NonNullable<Snapshot["management"]>[number];
}

describe("Setup incomplete", () => {
  it("lists setups with no component yet, a child waiting for its parent", () => {
    const parent = setup(ENGINE);
    const child = setup(CHILD, { parentComponentUuid: parent.uuid });
    const done = setup({ ...ENGINE, id: "done" });
    s.componentSetups = [parent, child, done];
    s.management = [component(done.uuid, "demo-206", true)];
    const html = render();
    expect(html).toContain("Setup incomplete — 2 recommended components");
    expect(html).toContain("<td>E123 · MAIN</td>");
    expect(html).toContain("<td>A123 · Not specified</td>");
    expect(html).toContain("<td>Template engine</td>");
    expect(disabled("Complete setup")).toEqual([false, true]);
    expect(html.match(/Complete parent first/g)).toHaveLength(1);
    ui.workspace.online = false;
    render();
    expect(disabled("Complete setup")).toEqual([true, true]);
  });

  it("needs the parent installed on the same aircraft", () => {
    const parent = setup(ENGINE);
    const child = setup(CHILD, { parentComponentUuid: parent.uuid });
    s.componentSetups = [child];
    for (const [aircraft, installed, waits] of [
      ["demo-208", true, true],
      ["demo-206", false, true],
      ["demo-206", true, false],
    ] as const) {
      s.management = [component(parent.uuid, aircraft, installed)];
      expect(render().includes("Complete parent first")).toBe(waits);
    }
  });

  it("completes a setup in the component form with its row and parent", () => {
    const parent = component("installed-engine", "demo-206", true);
    const child = setup(CHILD, { parentComponentUuid: parent.uuid });
    s.componentSetups = [child];
    s.management = [parent];
    render();
    expect(click("Complete setup")).toContain("Complete setup — Attached part");
    expect(ui.form).toMatchObject({
      initialAircraftUuid: "demo-206",
      parentComponent: parent,
      defaults: { ...CHILD, uuid: child.uuid },
    });
    (ui.form.onDone as () => void)();
    expect(render()).not.toContain("Complete setup — Attached part");
  });

  it("shows nothing while there is no setup", () => {
    expect(render()).not.toContain("Setup incomplete");
  });
});

describe("template library", () => {
  it("downloads the CSV columns and needs maintenance access to edit", () => {
    const html = openLibrary();
    expect(html).toContain("Cessna · 206 Stationair · 2 components");
    click("Download CSV columns");
    expect(ui.downloads).toEqual([
      ["component-template.csv", HEADER + "\n", "text/csv"],
    ]);
    expect(button("New template / import CSV").disabled).toBe(false);
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    render();
    expect(button("New template / import CSV").disabled).toBe(true);
    expect(button("Edit template").disabled).toBe(true);
    expect(button("Preview / apply to aircraft").disabled).toBe(false);
    ui.workspace.connected = false;
    render();
    expect(button("Preview / apply to aircraft").disabled).toBe(true);
  });

  it("saves a new template from the form and the CSV rows", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-0000000000aa",
    );
    openLibrary();
    const html = click("New template / import CSV");
    expect(html).toContain("New component template");
    expect(html).toContain(`>${HEADER}\n</textarea>`);
    expect(html).toContain('<option value="206 Stationair">');
    const csv = `${HEADER}\nEngine,72,E9,New engine,,MAIN,,`;
    await change("Component rows (CSV)", { value: csv });
    const fields = { name: " Kit ", make: "Cessna", aircraftModel: "206" };
    await submit("Save template", fields);
    expect(saved).toEqual([
      {
        uuid: "00000000-0000-4000-8000-0000000000aa",
        version: 0,
        name: "Kit",
        make: "Cessna",
        model: "206",
        rows: [
          expect.objectContaining({
            id: expect.stringMatching(/^auto-[0-9a-f]{16}$/),
            model: "New engine",
          }),
        ],
      },
    ]);
    expect(render()).not.toContain("New component template");
  });

  it("edits a template from its rows, in column order, refusing bad CSV", async () => {
    openLibrary();
    const html = click("Edit template");
    expect(html).toContain("Edit component template");
    expect(html).toContain('value="206 Equipment"');
    expect(html).toContain(
      "&quot;Engine&quot;,&quot;72&quot;,&quot;E123&quot;,&quot;Template engine&quot;,&quot;Maker&quot;,&quot;MAIN&quot;,&quot;engine&quot;,&quot;&quot;",
    );
    await submit("Save template", {
      name: "Kit",
      make: "C",
      aircraftModel: "M",
    });
    expect(saved).toEqual([
      expect.objectContaining({ uuid: TEMPLATE.uuid, version: 3 }),
    ]);
    click("Edit template");
    await change("Component rows (CSV)", { value: "Name\nx" });
    await expect(submit("Save template")).rejects.toThrow("Use columns:");
    expect(saved).toHaveLength(1);
  });

  it("imports a CSV file once it parses, and shows why it does not", async () => {
    openLibrary();
    click("New template / import CSV");
    const bytes = (content: Uint8Array, size = content.length) => ({
      files: [{ size, arrayBuffer: async () => content.buffer }],
    });
    const file = (text: string, size?: number) =>
      bytes(new TextEncoder().encode(text), size);
    const big = await change(
      "Import component CSV",
      file("", 2 * 1024 ** 2 + 1),
    );
    expect(big).toContain('<p role="alert">CSV must be under 2 MB.</p>');
    const bad = await change("Import component CSV", file("Name\nx"));
    expect(bad).toMatch(/<p role="alert">Use columns:/);
    expect(bad).toContain(`>${HEADER}\n</textarea>`);
    const good = `${HEADER}\nEngine,,,Imported,,,,`;
    const html = await change("Import component CSV", file(good));
    expect(html).not.toContain('role="alert"');
    expect(html).toContain(`>${good}</textarea>`);
    expect(await change("Import component CSV", { files: [] })).toBe(html);
    // "Bougie café" as a spreadsheet's plain CSV (Windows-1252) writes it.
    const cp1252 = Uint8Array.from([
      ...new TextEncoder().encode(`${HEADER}\nAppliance,,,Bougie caf`),
      0xe9,
    ]);
    const refused = await change("Import component CSV", bytes(cp1252));
    expect(refused).toContain('<p role="alert">This file is not UTF-8 text.');
    expect(refused).toContain(`>${good}</textarea>`);
  });
});

describe("preview", () => {
  it("offers matching aircraft with maintenance access", () => {
    openLibrary();
    const html = click("Preview / apply to aircraft");
    expect(html).toContain('<option value="demo-206">N206MA</option>');
    expect(html).not.toContain("N208MA");
    expect(html).not.toContain("No aircraft with maintenance access");
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    expect(render()).toContain(
      "No aircraft with maintenance access matches this template’s make/model.",
    );
  });

  it("selects new entries, skips possible duplicates and applies them", async () => {
    s.componentSetups = [setup(ENGINE)];
    openLibrary();
    click("Preview / apply to aircraft");
    await expect(submit("Import selected as setup incomplete")).rejects.toThrow(
      "Choose an aircraft and at least one component.",
    );
    expect(button("Select new entries").disabled).toBe(true);
    const html = await change("Target aircraft", { value: "demo-206" });
    expect(html).toContain("Already imported / possible duplicate");
    expect(html).toContain("Serial and readings left blank");
    expect(html).toMatch(/aria-label="Select Template engine"[^>]*disabled/);
    click("Select new entries");
    expect(checkbox("Template engine").checked).toBe(false);
    expect(checkbox("Attached part").checked).toBe(true);
    await submit("Import selected as setup incomplete");
    expect(applied).toEqual([
      {
        templateUuid: TEMPLATE.uuid,
        version: 3,
        aircraftUuid: "demo-206",
        rowIds: ["child"],
      },
    ]);
    const after = render();
    expect(after).not.toContain("Preview component import");
    expect(after).not.toContain("Download CSV columns");
  });

  it("toggles rows, clears the selection and resets it on a new aircraft", async () => {
    openLibrary();
    click("Preview / apply to aircraft");
    await change("Target aircraft", { value: "demo-206" });
    const toggle = (model: string, checked: boolean) =>
      checkbox(model).onChange({ target: { checked } });
    toggle("Template engine", true);
    render();
    toggle("Attached part", true);
    render();
    expect(checkbox("Template engine").checked).toBe(true);
    toggle("Template engine", false);
    render();
    expect(checkbox("Template engine").checked).toBe(false);
    expect(checkbox("Attached part").checked).toBe(true);
    click("Clear selection");
    expect(checkbox("Attached part").checked).toBe(false);
    toggle("Attached part", true);
    await change("Target aircraft", { value: "demo-206" });
    expect(checkbox("Attached part").checked).toBe(false);
  });
});
