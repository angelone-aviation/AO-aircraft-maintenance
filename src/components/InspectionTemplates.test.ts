/**
 * Responsibility: Pins the inspection templates screen: grouping and filters,
 *   the editor's saved template, interval lines, deletion, CSV import and the
 *   blank CSV download.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/InspectionTemplates.tsx, react-dom/server,
 *   src/domain/inspectionTemplates.ts, src/data/demo.ts (seed).
 *
 * Server rendering keeps no state, so the mocks keep the screen's own state
 * (its first thirteen useState calls) between renders and capture each
 * button's click handler by its text and each form's submit by its label.
 */
// @vitest-environment node
import { createElement as h, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  emptyTemplate,
  templateCsvHeaders,
  templateLandingCsvHeaders,
  type InspectionTemplate,
} from "../domain/inspectionTemplates";
import type { Snapshot } from "../domain/model";
import {
  InspectionTemplates,
  TemplateEditor,
  TemplateIntervals,
} from "./InspectionTemplates";

type Props = Record<string, unknown>;
type Handler = (event?: unknown) => unknown;
const ui = vi.hoisted(() => ({
  screenStates: 13,
  slots: [] as unknown[],
  next: 0,
  clicks: new Map<string, Handler[]>(),
  forms: new Map<string, (data: FormData) => Promise<void>>(),
  workspace: {} as Props,
  downloads: [] as { name: string; parts: unknown[] }[],
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = ui.next++;
      if (slot >= ui.screenStates) return react.useState(initial);
      if (!(slot in ui.slots)) ui.slots[slot] = initial;
      const set = (update: unknown) => {
        ui.slots[slot] =
          typeof update === "function" ? update(ui.slots[slot]) : update;
      };
      return [ui.slots[slot], set];
    },
  };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const runtime =
    await importOriginal<typeof import("react/jsx-dev-runtime")>();
  const textOf = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number")
      return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    return "";
  };
  // A label's handler is its control's, as a user reaches it by the label.
  const handlerOf = (type: unknown, props: Props): unknown => {
    if (type !== "label") return props.onClick ?? props.onChange;
    const controls = [props.children].flat() as { props?: Props }[];
    return controls.find((c) => c?.props?.onChange)?.props?.onChange;
  };
  return {
    ...runtime,
    jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
      const [type, props] = [args[0], args[1] as Props];
      const handler = handlerOf(type, props) as Handler | undefined;
      const name = String(props["aria-label"] ?? textOf(props.children).trim());
      if (typeof type === "string" && handler && name)
        ui.clicks.set(name, [...(ui.clicks.get(name) ?? []), handler]);
      return runtime.jsxDEV(...args);
    },
  };
});
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  return {
    ...actual,
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props.onSubmit);
      return actual.AsyncForm(props);
    },
    Field: (props: Parameters<typeof actual.Field>[0]) => {
      const control = (props.children as { props: Props }).props;
      if (control.onChange)
        ui.clicks.set(props.label, [control.onChange as Handler]);
      return actual.Field(props);
    },
  };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    h("a", { href: to }, children),
}));
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
vi.mock("./ActivateTemplate", () => ({
  ActivateTemplate: (props: { onDone: () => void }) => {
    ui.clicks.set("activation done", [props.onDone]);
    return null;
  },
}));
vi.mock("./TaskCsvImport", () => ({ TaskCsvImportButton: () => null }));
vi.mock("./Manuals", () => ({ ManualLink: () => null }));

const backend = {
  saveInspectionTemplates: vi.fn(),
  deleteInspectionTemplates: vi.fn(),
};
let s: Snapshot;

beforeEach(() => {
  s = demoSnapshot();
  s.inspectionTemplates = [
    template("Prop overhaul", { calendarValue: 6, kind: "component" }),
    template("Phase 1", { hours: 100, group: "Phase", version: 3 }),
    template("Old annual", { calendarValue: 12, archived: true }),
  ];
  for (const fn of Object.values(backend)) fn.mockReset();
  ui.workspace = { snapshot: s, backend, online: true, connected: true };
  ui.slots = [];
});

function template(
  name: string,
  {
    kind = "aircraft",
    ...overrides
  }: Partial<InspectionTemplate> & { kind?: "aircraft" | "component" } = {},
): InspectionTemplate {
  const applicability = {
    kind,
    manufacturer: "Cessna",
    model: "206",
    partNumber: "",
  };
  const programUuid = s.activeProgramUuid;
  return { ...emptyTemplate(), name, applicability, programUuid, ...overrides };
}

function render(element: ReactElement = h(InspectionTemplates)) {
  ui.next = 0;
  ui.clicks.clear();
  ui.forms.clear();
  return renderToStaticMarkup(element).replace(/<!-- -->/g, "");
}

function act(name: string, event?: unknown) {
  render();
  ui.clicks.get(name)![0](event);
  return render();
}

function formData(fields: [string, string | Blob][]) {
  const data = new FormData();
  for (const [name, value] of fields) data.append(name, value);
  return data;
}

const headings = (html: string) =>
  [...html.matchAll(/<h3>([^<]*)<\/h3>/g)].map((m) => m[1]);

describe("listing", () => {
  it("groups templates by model and inspection group, hiding archived ones", () => {
    expect(headings(render())).toEqual([
      "Aircraft type: Cessna 206 / Phase",
      "Component model: Cessna 206 / General",
    ]);
    expect(act("Show archived", { target: { checked: true } })).toContain(
      "Old annual (archived)",
    );
  });

  it("filters by text and template type", () => {
    act("Search templates", { target: { value: "PROP" } });
    expect(headings(render())).toEqual([
      "Component model: Cessna 206 / General",
    ]);
    act("Search templates", { target: { value: "" } });
    act("Template type", { target: { value: "aircraft" } });
    expect(headings(render())).toEqual(["Aircraft type: Cessna 206 / Phase"]);
  });

  it("offers viewing only without a connection", () => {
    ui.workspace = { ...ui.workspace, connected: false };
    const html = render();
    expect(html).toContain("View template");
    expect(html).not.toContain("Edit template");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>New template/);
  });
});

describe("intervals", () => {
  it("lists each limit in a fixed order, absolute or recurring", () => {
    const t = template("All", {
      hours: 100,
      hourMode: "ABSOLUTE",
      timeBasis: "TSO",
      cycles: 20,
      landings: 30,
      landingMode: "ABSOLUTE",
      initialLandings: 5,
      calendarValue: 12,
      calendarUnit: "MONTHS",
      initialHours: 50,
      initialCycles: 10,
    });
    const lines = render(h(TemplateIntervals, { record: t })).match(
      /<div>[^<]*<\/div>/g,
    );
    expect(lines).toEqual([
      "<div>100 hours · absolute (TSO)</div>",
      "<div>20 cycles · recurring</div>",
      "<div>30 landings · absolute</div>",
      "<div>Initial: 5 landings</div>",
      "<div>12 months</div>",
      "<div>Initial: 50 hours</div>",
      "<div>Initial: 10 cycles</div>",
    ]);
  });
});

describe("editor", () => {
  it("saves the fields as a template, with default modes and units for untracked groups", async () => {
    const onDone = vi.fn();
    const record = template("Before", { hours: 100 });
    render(h(TemplateEditor, { record, onDone }));
    await ui.forms.get("Save template")!(
      formData([
        ["name", "After"],
        ["group", "Phase"],
        ["kind", "component"],
        ["manufacturer", "Lycoming"],
        ["model", "IO-540"],
        ["requirementType", "Overhaul Requirement"],
        ["hours", "2000"],
        ["description", ""],
        ["conditions", ""],
      ]),
    );
    expect(backend.saveInspectionTemplates).toHaveBeenCalledWith([
      expect.objectContaining({
        uuid: record.uuid,
        name: "After",
        applicability: {
          kind: "component",
          manufacturer: "Lycoming",
          model: "IO-540",
          partNumber: "",
        },
        hours: 2000,
        hourMode: "FROM_LAST_COMPLIED",
        cycleMode: "FROM_LAST_COMPLIED",
        landingMode: "FROM_LAST_COMPLIED",
        calendarUnit: "MONTHS",
        timeBasis: "TSN",
        archived: false,
      }),
    ]);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("saves nothing when the template does not parse", async () => {
    const onDone = vi.fn();
    render(h(TemplateEditor, { record: template("X"), onDone }));
    await expect(
      ui.forms.get("Save template")!(formData([])),
    ).rejects.toThrow();
    expect(backend.saveInspectionTemplates).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("names the created schedule's screen after an activation", () => {
    act("Create component requirement");
    expect(act("activation done")).toContain(
      'Schedule and linked job card templates created. The template is unchanged. <a href="/components">Open Components</a>',
    );
  });
});

describe("deletion", () => {
  it("selects at most 100 visible templates", () => {
    s.inspectionTemplates = Array.from({ length: 101 }, (_, i) =>
      template(`T${i}`, { hours: 10 }),
    );
    act("Delete templates");
    const html = act("Select first 100 visible");
    expect(html).toContain("100 selected (maximum 100).");
    expect(html).toMatch(/aria-label="Select template T100"[^>]*disabled=""/);
  });

  it("shows why a selection cannot be reviewed", () => {
    s.inspectionTemplates![0].programUuid = "other-program";
    act("Delete templates");
    act("Select all visible");
    expect(act("Review deletion (2)")).toContain(
      '<p class="error" role="alert">A selected template is unavailable in this Flight Program. Refresh the list.</p>',
    );
  });

  it("deletes the reviewed templates by version, then reports the count", async () => {
    act("Delete templates");
    act("Select all visible");
    expect(act("Review deletion (2)")).toContain(
      "Delete 2 templates and 0 job cards",
    );
    await ui.forms.get("Delete 2 templates and 0 job cards")!(formData([]));
    const [a, b] = s.inspectionTemplates!;
    expect(backend.deleteInspectionTemplates).toHaveBeenCalledWith({
      templates: [
        { uuid: a.uuid, version: a.version },
        { uuid: b.uuid, version: b.version },
      ],
      taskCards: [],
    });
    const html = render();
    expect(html).toContain("Deleted 2 templates and 0 associated job cards.");
    expect(html).not.toContain("Select templates to delete.");
  });
});

describe("CSV import", () => {
  const columns = [...templateCsvHeaders, ...templateLandingCsvHeaders];
  const csv = (rows: Record<string, string>[]) =>
    new File(
      [
        [columns, ...rows.map((row) => columns.map((c) => row[c] ?? ""))]
          .map((cells) => cells.join(","))
          .join("\n"),
      ],
      "templates.csv",
    );
  const scope: [string, string][] = [
    ["kind", "aircraft"],
    ["manufacturer", "Cessna"],
    ["model", "206"],
    ["group", "Imported"],
  ];

  it("refuses an empty or oversized file", async () => {
    act("Import template CSV");
    const preview = ui.forms.get("Preview templates")!;
    const message = "Choose a UTF-8 CSV up to 2 MB.";
    await expect(preview(formData([]))).rejects.toThrow(message);
    const empty = new File([], "empty.csv");
    await expect(preview(formData([["csv", empty]]))).rejects.toThrow(message);
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.csv");
    await expect(preview(formData([["csv", big]]))).rejects.toThrow(message);
  });

  it("previews rows and saves only the selected templates", async () => {
    act("Import template CSV");
    await ui.forms.get("Preview templates")!(
      formData([
        [
          "csv",
          csv([
            { name: "Oil change", hours: "50" },
            { name: "Annual", calendar_value: "12", calendar_unit: "months" },
          ]),
        ],
        ...scope,
      ]),
    );
    expect(render()).toContain("2 rows · 2 valid · 0 errors.");
    // Rows are numbered from the header line, so the first data row is 2.
    act("Include row 3", { target: { checked: false } });
    await ui.forms.get("Save selected templates")!(formData([]));
    expect(backend.saveInspectionTemplates).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "Oil change",
        hours: 50,
        group: "Imported",
      }),
    ]);
    const html = render();
    expect(html).toContain("Selected templates saved with interval data only.");
    expect(html).not.toContain("Import interval templates");
  });

  it("downloads a blank CSV with the importer's header row", async () => {
    const parts: unknown[] = [];
    const link = { href: "", download: "", click: vi.fn() };
    vi.stubGlobal("document", { createElement: () => link });
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      parts.push(blob);
      return "blob:csv";
    });
    act("Import template CSV");
    ui.clicks.get("Download template CSV")![0]();
    const headers = [...templateCsvHeaders, ...templateLandingCsvHeaders];
    const row = headers.map((name) => `"${name}"`).join(",") + "\r\n";
    const blob = parts[0] as Blob;
    expect(await blob.text()).toBe(row);
    expect(blob.type).toBe("text/csv");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new TextEncoder().encode(`\uFEFF${row}`),
    );
    expect(link).toMatchObject({ download: "inspection-templates.csv" });
    expect(link.click).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
