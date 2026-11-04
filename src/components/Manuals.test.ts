/**
 * Responsibility: Pins the reference-manual views: manual references on
 *   records, the library's search, upload and reference edit, and the viewer's
 *   states and fallback from a kept copy to the online file.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Manuals.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/manuals.ts (types).
 *
 * Server rendering keeps no state, runs no effects and calls no handlers, so
 * mocks keep each component's useState values by name and key (dropped once
 * it stops rendering, as on unmount), record each render's effects, and
 * capture buttons, fields and forms: a test renders, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Manual } from "../domain/manuals";
import type { Snapshot } from "../domain/model";
import {
  ManualLink,
  ManualReferenceFields,
  ManualViewer,
  ReferenceLibrary,
  manualReferenceFromForm,
} from "./Manuals";

type Frame = { key: string; next: number };
type Props = Record<string, unknown>;
type Control = { onChange: (event: { target: Props }) => void } & Props;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as Frame[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  effects: [] as (() => unknown)[],
  buttons: [] as { text: string; props: Props }[],
  fields: new Map<string, Control>(),
  forms: new Map<string, Props>(),
  stubs: new Map<string, Props>(),
  opened: [] as unknown[],
  workspace: {} as Props,
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
    useEffect: (effect: () => unknown) => {
      ui.effects.push(effect);
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
      if (type === "button")
        ui.buttons.push({ text: textOf(props).trim(), props: props as Props });
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, args[2]) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object" && "children" in node)
      return textOf(node.children);
    return "";
  }
});
// Modal is a plain element: the real dialog's effects need a DOM.
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Modal: (props: Parameters<typeof actual.Modal>[0]) => {
      ui.stubs.set(`Modal ${props.title}`, props as never);
      return createElement(
        "dialog",
        { "aria-label": props.title },
        props.children,
      );
    },
    Field: (props: Parameters<typeof actual.Field>[0]) => {
      ui.fields.set(props.label, (props.children as { props: Control }).props);
      return actual.Field(props);
    },
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props as never);
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => children,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: Props) => {
      ui.stubs.set("Link", props);
      return createElement(
        "a",
        { "data-to": props.to },
        props.children as never,
      );
    },
  };
});
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
vi.mock("./PdfReader", () => ({ PdfReader: stub("PdfReader") }));
vi.mock("./MaintenanceCsvImport", () => ({
  MaintenanceCsvImportButton: stub("MaintenanceCsvImportButton"),
}));
vi.mock("./ManualDiscovery", () => ({
  ManualDiscoveryButton: stub("ManualDiscoveryButton"),
}));
vi.mock("./KeepOnDevice", () => ({
  DeviceCopyNotice: stub("DeviceCopyNotice"),
  KeepManualButton: stub("KeepManualButton"),
  KeepManualError: stub("KeepManualError"),
  KeepManualPanel: stub("KeepManualPanel"),
  KeepManualStatus: stub("KeepManualStatus"),
  KeptManualsSummary: stub("KeptManualsSummary"),
  useKeptManualsRefresh: () => undefined,
  openManualFile: async (uuid: string, options: unknown) => {
    ui.opened.push([uuid, options]);
    const next = ui.workspace.file as { url: string; fromDevice: boolean };
    if (!next) throw Error("Manual file is unavailable.");
    return next;
  },
}));
vi.mock("../data/deviceManuals", () => ({
  keptManualsSupported: () => ui.workspace.keeping === true,
}));
vi.mock("../data/manualPdf", () => ({ inspectManualPdf: async () => 12 }));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(
    (select?: (state: Props) => unknown) =>
      select ? select(ui.workspace) : ui.workspace,
    { getState: () => ui.workspace },
  ),
}));

// A stub records its props, so a test can read them and call callbacks.
function stub(name: string) {
  return (props: Props) => {
    ui.stubs.set(name, props);
    return `[${name}]`;
  };
}

const MANUAL: Manual = {
  uuid: "m1",
  version: 1,
  programUuid: "demo-program",
  aircraftUuid: "demo-206",
  title: "206 Maintenance Manual",
  documentNumber: "D2518",
  revision: "Rev 15",
  revisionDate: "2024-01-02",
  filename: "206.pdf",
  size: 3 * 1024 * 1024,
  pageCount: 40,
  storageId: "s1",
  uploadedAt: 1,
  uploadedBy: "demo-admin",
} as unknown as Manual;
let s: Snapshot;
let calls: unknown[][];
let element: Parameters<typeof renderToStaticMarkup>[0];

beforeEach(() => {
  ui.states.clear();
  ui.stubs.clear();
  ui.opened = [];
  calls = [];
  s = { ...demoSnapshot(), manuals: [MANUAL] };
  ui.workspace = {
    snapshot: s,
    namespace: "demo",
    online: true,
    connected: true,
    demo: false,
    keeping: false,
    file: { url: "blob:m1", fromDevice: true },
    backend: {
      editManual: async (...args: unknown[]) =>
        void calls.push(["edit", ...args]),
      uploadManual: async (...args: unknown[]) =>
        void calls.push(["upload", ...args]),
    },
  };
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("URL", {
    revokeObjectURL: (u: string) => calls.push(["revoke", u]),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(next = element) {
  element = next;
  ui.buttons = [];
  ui.effects = [];
  ui.fields.clear();
  ui.forms.clear();
  ui.rendered.clear();
  ui.frames = [{ key: "root", next: 0 }];
  const html = renderToStaticMarkup(element);
  for (const key of ui.states.keys())
    if (key !== "root" && !ui.rendered.has(key)) ui.states.delete(key);
  return html;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runEffects() {
  const cleanups = ui.effects.map((effect) => effect());
  await settle();
  return { html: render(), cleanups };
}

function click(text: string) {
  const found = ui.buttons.find((b) => b.text === text);
  if (!found) throw Error(`No button "${text}"`);
  (found.props.onClick as () => unknown)();
  return render();
}

function form(fields: Record<string, string | File>) {
  const data = new FormData();
  for (const [key, field] of Object.entries(fields)) data.set(key, field);
  return data;
}

const REFERENCE = {
  manualUuid: "m1",
  section: "5-12",
  printedPage: "3",
  pdfPage: 7,
};

describe("manual references", () => {
  it("links to the referenced page, or says the manual is unavailable", () => {
    expect(render(h(ManualLink, { reference: REFERENCE }))).toBe(
      '<a data-to="/manuals/$manualUuid">206 Maintenance Manual · Rev 15 · § 5-12 · printed page 3 · PDF page 7</a>',
    );
    expect(ui.stubs.get("Link")).toMatchObject({
      params: { manualUuid: "m1" },
      search: { page: 7 },
    });
    (ui.stubs.get("Link")!.onClick as (e: object) => void)({
      preventDefault: () => calls.push(["prevented"]),
    });
    expect(render()).toContain('aria-label="Manual reference"');
    expect(calls).toEqual([["prevented"]]);
    expect(
      render(h(ManualLink, { reference: { ...REFERENCE, manualUuid: "x" } })),
    ).toContain("Referenced manual is unavailable in this workspace.");
    expect(render(h(ManualLink, { reference: null }))).toBe("");
  });

  it("edits a reference, reporting none until a manual is chosen", () => {
    const changes: unknown[] = [];
    render(
      h(ManualReferenceFields, { onChange: (r: unknown) => changes.push(r) }),
    );
    ui.fields.get("Manual section")!.onChange({ target: { value: "5-1" } });
    render();
    ui.fields
      .get("Reference library manual")!
      .onChange({ target: { value: "m1" } });
    render();
    ui.fields.get("PDF page number")!.onChange({ target: { value: "9" } });
    expect(changes).toEqual([
      null,
      { manualUuid: "m1", section: "5-1", printedPage: "", pdfPage: 1 },
      { manualUuid: "m1", section: "5-1", printedPage: "", pdfPage: 9 },
    ]);
    const html = render();
    expect(html).toMatch(/max="40"[^>]*required=""[^>]*name="manualPdfPage"/);
  });

  it("keeps a reference to a manual no longer available", () => {
    const html = render(
      h(ManualReferenceFields, {
        initial: { ...REFERENCE, manualUuid: "gone" },
      }),
    );
    expect(html).toContain(
      '<option value="gone" selected="">Previously linked manual (unavailable)</option>',
    );
  });

  it("reads a reference from form data", () => {
    expect(manualReferenceFromForm(form({}))).toBeNull();
    expect(
      manualReferenceFromForm(
        form({
          manualUuid: " m1 ",
          manualSection: " 5 ",
          manualPrintedPage: "",
          manualPdfPage: "4",
        }),
      ),
    ).toEqual({ manualUuid: "m1", section: "5", printedPage: "", pdfPage: 4 });
  });
});

describe("ReferenceLibrary", () => {
  it("searches manuals and lists their size and actions", () => {
    s.manuals = [
      MANUAL,
      { ...MANUAL, uuid: "m2", title: "Caravan IPC", aircraftUuid: "demo-208" },
    ];
    const html = render(h(ReferenceLibrary, {}));
    expect(html).toContain("40 pages · 3.0 MB");
    expect(html).toContain("D2518 · Rev 15 · 2024-01-02");
    expect(html.match(/Edit reference/g)).toHaveLength(2);
    (
      ui.stubs.get("SearchField")?.onChange as ((v: string) => void) | undefined
    )?.("caravan");
    expect(
      render(h(ReferenceLibrary, { aircraftUuid: "demo-206" })),
    ).not.toContain("Caravan IPC");
  });

  it("uploads a manual for the chosen aircraft with its applicability", async () => {
    render(h(ReferenceLibrary, {}));
    const html = click("Upload manual");
    expect(html).toContain("PDF up to 200 MB.");
    const save = ui.forms.get("Save manual")!.onSubmit as (
      d: FormData,
    ) => Promise<void>;
    await expect(save(form({}))).rejects.toThrow("Choose a PDF manual.");
    const pdf = new File(["%PDF"], "manual.pdf");
    await save(
      form({
        pdf,
        aircraft: "demo-208",
        title: " Caravan ",
        revision: "R1",
        documentNumber: "",
        revisionDate: "",
      }),
    );
    expect(calls).toEqual([
      [
        "upload",
        expect.objectContaining({
          aircraftUuid: "demo-208",
          title: "Caravan",
          filename: "manual.pdf",
          size: 4,
          pageCount: 12,
          applicability: {
            kind: "aircraft",
            manufacturer: "Cessna",
            model: "208 Caravan",
            partNumber: "",
          },
        }),
        pdf,
      ],
    ]);
    expect(render()).not.toContain("Upload reference manual");
  });

  it("edits a manual's reference, without applicability when unset", async () => {
    render(h(ReferenceLibrary, {}));
    const html = click("Edit reference");
    expect(html).toContain(
      '<option value="demo-206" selected="">N206MA</option>',
    );
    expect(html).toContain("PDF: 206.pdf · 40 pages.");
    const save = ui.forms.get("Save reference")!.onSubmit as (
      d: FormData,
    ) => Promise<void>;
    await save(
      form({ title: "T", revision: "R", aircraft: "demo-206", kind: "" }),
    );
    await save(
      form({
        title: "T",
        revision: "R",
        aircraft: "demo-206",
        kind: "component",
        model: "M",
      }),
    );
    expect(calls).toEqual([
      [
        "edit",
        "m1",
        expect.objectContaining({ title: "T", applicability: undefined }),
      ],
      [
        "edit",
        "m1",
        expect.objectContaining({
          applicability: {
            kind: "component",
            manufacturer: "",
            model: "M",
            partNumber: "",
          },
        }),
      ],
    ]);
  });

  it("needs a connection and an aircraft with maintenance access", () => {
    ui.workspace.connected = false;
    render(h(ReferenceLibrary, {}));
    expect(
      ui.buttons.find((b) => b.text === "Upload manual")!.props.disabled,
    ).toBe(true);
    s.manuals = [];
    expect(render()).toContain("No manuals found");
  });
});

describe("ManualViewer", () => {
  it("opens a kept copy first, then the online file if it fails", async () => {
    render(h(ManualViewer, { uuid: "m1", page: 3 }));
    expect(render()).toContain("Opening manual…");
    const { html } = await runEffects();
    expect(ui.opened).toEqual([["m1", { useDevice: true }]]);
    expect(html).toContain('href="blob:m1#page=3"');
    expect(html).toContain('download="206.pdf"');
    expect(ui.stubs.get("KeepManualPanel")).toMatchObject({ fromDevice: true });
    (ui.stubs.get("PdfReader")!.onLoadError as () => void)();
    ui.workspace.file = { url: "https://files/m1", fromDevice: false };
    const retried = render();
    expect(retried).toContain("[DeviceCopyNotice]");
    await runEffects();
    expect(ui.opened[1]).toEqual(["m1", { useDevice: false }]);
    expect(ui.stubs.get("PdfReader")!.onLoadError).toBeUndefined();
  });

  it("says when the file cannot open, the manual is missing or the page is out of range", async () => {
    ui.workspace.file = undefined;
    render(h(ManualViewer, { uuid: "m1", page: 1 }));
    expect((await runEffects()).html).toContain("Manual file is unavailable.");
    expect(render(h(ManualViewer, { uuid: "x", page: 1 }))).toContain(
      "Manual is unavailable in the active Flight Program.",
    );
    expect(render(h(ManualViewer, { uuid: "m1", page: 41 }))).toContain(
      "This manual has 40 pages. The reference page is out of range.",
    );
  });

  it("revokes a blob url when the viewer closes", async () => {
    render(h(ManualViewer, { uuid: "m1", page: 1 }));
    const { cleanups } = await runEffects();
    for (const cleanup of cleanups)
      if (typeof cleanup === "function") cleanup();
    expect(calls).toContainEqual(["revoke", "blob:m1"]);
  });
});
