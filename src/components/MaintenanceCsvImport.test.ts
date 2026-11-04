/**
 * Responsibility: Pins the maintenance CSV import: header templates and
 *   instructions, file refusals, the error list, the paged preview, row
 *   forms, and job cards made from imported tasks.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/MaintenanceCsvImport.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain (manuals, maintenanceCsv,
 *   taskCards).
 *
 * Server rendering keeps no state and calls no handlers, so mocks keep each
 * component's useState values by name and key and capture buttons, fields,
 * forms and stubs: a test renders, acts, and renders again.
 */
// @vitest-environment node
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Manual } from "../domain/manuals";
import { CSV_MAX_BYTES, csvSourceKey } from "../domain/maintenanceCsv";
import {
  TASK_TEXT_MAX_LENGTH,
  taskCardFieldsSchema,
} from "../domain/taskCards";
import type { Snapshot } from "../domain/model";
import { MaintenanceCsvImportButton } from "./MaintenanceCsvImport";

type Props = Record<string, unknown>;
type Control = { onChange: (event: { target: Props }) => void } & Props;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as { key: string; next: number }[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  effects: [] as (() => unknown)[],
  buttons: [] as { text: string; props: Props }[],
  fields: new Map<string, Control>(),
  forms: new Map<string, Props>(),
  stubs: new Map<string, Props>(),
  stubList: [] as { name: string; props: Props }[],
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
      const control = props as Control;
      if (type === "button")
        ui.buttons.push({ text: textOf(props).trim(), props: control });
      if (
        typeof type === "string" &&
        control["aria-label"] &&
        typeof control.onChange === "function"
      )
        ui.fields.set(control["aria-label"] as string, control);
      if (typeof type === "function")
        args[0] = tracked(type as FunctionComponent, args[2]) as never;
      return runtime.jsxDEV(...args);
    },
  };
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number")
      return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object" && "children" in node)
      return textOf(node.children);
    if (node && typeof node === "object" && "props" in node)
      return textOf(node.props);
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
      const [control] = [props.children].flat() as { props: Control }[];
      ui.fields.set(props.label, control.props);
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
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));
vi.mock("./TaskCsvImport", () => ({
  TaskCsvImportButton: stub("TaskCsvImportButton"),
}));
vi.mock("./InspectionTemplates", () => ({
  TemplateEditor: stub("TemplateEditor"),
}));
vi.mock("./ManualDiscovery", () => ({
  ApplicabilityEditor: stub("ApplicabilityEditor"),
  CandidateForm: stub("CandidateForm"),
  ReviewConfirmation: stub("ReviewConfirmation"),
}));
vi.mock("./Manuals", () => ({ ManualLink: stub("ManualLink") }));

// A stub records its props, so a test can read them and call callbacks.
function stub(name: string) {
  return (props: Props) => {
    ui.stubs.set(name, props);
    ui.stubList.push({ name, props });
    return `[${name}]`;
  };
}

const MANUAL = {
  uuid: "m1",
  version: 1,
  programUuid: "demo-program",
  aircraftUuid: "demo-206",
  title: "206 Maintenance Manual",
  documentNumber: "D2518",
  revision: "Rev 15",
  revisionDate: "2024-01-02",
  filename: "206.pdf",
  size: 1,
  pageCount: 40,
  storageId: "s1",
  uploadedAt: 1,
  uploadedBy: "demo-admin",
} as unknown as Manual;
const INSPECTIONS =
  "id,name,description,initial_hours,initial_cycles,repeat_hours,repeat_cycles,repeat_months,conditions,section,printed_page,pdf_page";
const TASKS =
  "id,parent_type,parent_id,item_code,instruction,applicability,section,printed_page,pdf_page";
let s: Snapshot;
let calls: unknown[][];
let element: Parameters<typeof renderToStaticMarkup>[0];

beforeEach(() => {
  ui.states.clear();
  ui.stubs.clear();
  calls = [];
  s = { ...demoSnapshot(), manuals: [MANUAL] };
  s.user.isAdmin = true;
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: {
      taskCard: async (command: unknown) =>
        void calls.push(["taskCard", command]),
    },
  };
  vi.stubGlobal("document", {
    body: {},
    createElement: () => ({
      click(this: { download: string; href: string }) {
        calls.push(["download", this.download, files.get(this.href)]);
      },
    }),
  });
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      const url = `blob:${files.size}`;
      files.set(url, blob);
      return url;
    },
    revokeObjectURL: () => undefined,
  });
});

const files = new Map<string, Blob>();

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(next = element) {
  element = next;
  ui.buttons = [];
  ui.stubList = [];
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

function click(text: string, index = 0) {
  const found = ui.buttons.filter((b) => b.text === text)[index];
  if (!found) throw Error(`No button "${text}"`);
  (found.props.onClick as () => unknown)();
  return render();
}

function change(label: string, value: unknown) {
  const field = ui.fields.get(label);
  if (!field) throw Error(`No field "${label}"`);
  field.onChange({ target: { value } });
  return render();
}

async function submit(label: string, data = new FormData()) {
  const form = ui.forms.get(label);
  if (!form) throw Error(`No form "${label}"`);
  try {
    await (form.onSubmit as (data: FormData) => Promise<void>)(data);
    return "done";
  } catch (e) {
    return (e as Error).message;
  } finally {
    render();
  }
}

function csvFiles(texts: Record<string, string | Uint8Array>) {
  const data = new FormData();
  for (const [kind, text] of Object.entries(texts))
    data.set(kind, new File([text as BlobPart], `${kind}.csv`));
  return data;
}

function open() {
  render(h(MaintenanceCsvImportButton, { manual: MANUAL }));
  return click("Import maintenance CSV");
}

function inspectionRows(count: number) {
  return Array.from(
    { length: count },
    (_, i) => `phase-${i + 1},Phase ${i + 1},Inspect,,,100,,12,,5-1,3,7`,
  );
}

describe("maintenance CSV import", () => {
  it("needs a connection and maintenance access to the manual's aircraft", () => {
    ui.workspace.online = false;
    expect(render(h(MaintenanceCsvImportButton, { manual: MANUAL }))).toContain(
      "disabled",
    );
    ui.workspace.online = true;
    expect(open()).toContain('aria-label="Import maintenance CSV"');
  });

  it("downloads a header-only template per file and the instructions", async () => {
    open();
    click("Download tasks template");
    click("Download AI instructions");
    const [csv, text] = calls as [string, string, Blob][];
    expect(csv[1]).toBe("tasks.csv");
    expect(csv[2].type).toBe("text/csv;charset=utf-8");
    // Characterizes current behaviour: toCsv quotes every header.
    expect(await csv[2].text()).toBe(
      `${TASKS.split(",")
        .map((header) => `"${header}"`)
        .join(",")}\r\n`,
    );
    expect(text[1]).toBe("maintenance-csv-ai-instructions.txt");
    expect(text[2].type).toBe("text/plain;charset=utf-8");
    expect(await text[2].text()).toContain(
      "Source manual: 206 Maintenance Manual\nDocument: D2518\nRevision: Rev 15",
    );
  });

  it("refuses no files, a file over 2 MB and one not in UTF-8", async () => {
    open();
    const label = "Validate and preview CSVs";
    expect(await submit(label)).toBe("Choose at least one CSV file.");
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    expect(await submit(label, csvFiles({ components: big }))).toBe(
      "components: use a CSV file up to 2 MB.",
    );
    const largest = "x".repeat(CSV_MAX_BYTES);
    expect(await submit(label, csvFiles({ components: largest }))).not.toBe(
      "components: use a CSV file up to 2 MB.",
    );
    const latin1 = new Uint8Array([0x69, 0x64, 0xe9]);
    expect(await submit(label, csvFiles({ tasks: latin1 }))).toBe(
      "tasks: save the CSV as UTF-8.",
    );
  });

  it("loads no rows when any task's parent is missing", async () => {
    open();
    const tasks = [TASKS, "t1,inspection,gone,A1,Check tire,,5-1,3,7"];
    await submit(
      "Validate and preview CSVs",
      csvFiles({ tasks: tasks.join("\n") }),
    );
    const html = render();
    expect(html).toContain("1 errors. No rows were loaded.");
    expect(html).toContain(
      "Task t1: parent gone was not found. Include its parent CSV or first save that parent from this manual.",
    );
    expect(html).not.toContain("Ready for review");
  });

  it("previews 100 rows at a time and filters them", async () => {
    open();
    const inspections = [INSPECTIONS, ...inspectionRows(101)].join("\n");
    await submit("Validate and preview CSVs", csvFiles({ inspections }));
    const names = () =>
      [...render().matchAll(/<strong>(Phase \d+)<\/strong>/g)].length;
    expect(render()).toContain(
      "Ready for review: 101 inspections, 0 component requirements, 0 tasks.",
    );
    expect(names()).toBe(100);
    click("Show more imported rows");
    expect(names()).toBe(101);
    change("Filter imported rows", "phase 10");
    expect(names()).toBe(3);
  });

  it("opens a row's record form and reports a save", async () => {
    open();
    const inspections = [INSPECTIONS, ...inspectionRows(2)].join("\n");
    await submit("Validate and preview CSVs", csvFiles({ inspections }));
    click("Create inspection", 1);
    expect(ui.stubs.get("CandidateForm")).toMatchObject({
      action: "inspection",
      row: { name: "Phase 2" },
    });
    (ui.stubs.get("CandidateForm")!.onDone as () => void)();
    expect(render()).toContain(
      "Saved. You can continue with the other rows; tasks become available after their parent is saved.",
    );
    expect(render()).not.toContain("[CandidateForm]");
  });

  it("makes a job card from a task once its parent is saved", async () => {
    const key = csvSourceKey("m1", "inspection", "phase-1");
    s.inspections[0] = { ...s.inspections[0], sourceKey: `${key}:initial` };
    open();
    const tasks = [TASKS, "t1,inspection,phase-1,A1,Check tire,All,5-1,3,7"];
    await submit(
      "Validate and preview CSVs",
      csvFiles({ tasks: tasks.join("\n") }),
    );
    click("Create job card template");
    expect(render()).toContain(`(initial)`);
    expect(await submit("Save draft task")).toBe(
      "Choose the saved parent record.",
    );
    change("Saved parent record", s.inspections[0].uuid);
    const data = new FormData();
    data.set("title", "A1: Check tire");
    data.set("instruction", " Check tire ");
    expect(await submit("Save draft task", data)).toBe("done");
    expect(calls[0]).toMatchObject([
      "taskCard",
      {
        action: "save",
        version: 0,
        fields: {
          title: "A1: Check tire",
          description: "Check tire",
          inspectionUuid: s.inspections[0].uuid,
          requirementUuid: "",
          maintenanceReference: "A1 · 5-1",
          referenceRevision: "Rev 15",
          steps: [],
        },
      },
    ]);
  });

  it("suggests a task title from its item code and instruction", async () => {
    open();
    const long = "x".repeat(300);
    const tasks = [TASKS, `t1,inspection,phase-1,,${long},,5-1,3,7`];
    const inspections = [INSPECTIONS, ...inspectionRows(1)].join("\n");
    await submit(
      "Validate and preview CSVs",
      csvFiles({ inspections, tasks: tasks.join("\n") }),
    );
    click("Create job card template");
    expect(ui.fields.get("Task title")!.defaultValue).toBe("x".repeat(200));
  });

  it("limits task text to what a job card's fields hold", async () => {
    open();
    const tasks = [TASKS, "t1,inspection,phase-1,A1,Check tire,All,5-1,3,7"];
    const inspections = [INSPECTIONS, ...inspectionRows(1)].join("\n");
    await submit(
      "Validate and preview CSVs",
      csvFiles({ inspections, tasks: tasks.join("\n") }),
    );
    click("Create job card template");
    for (const label of [
      "Task title",
      "Task instruction",
      "Task applicability",
    ])
      expect(ui.fields.get(label)!.maxLength).toBe(TASK_TEXT_MAX_LENGTH);
    const { title, description, applicability } = taskCardFieldsSchema.shape;
    for (const field of [title, description, applicability]) {
      const fits = (length: number) =>
        field.safeParse("x".repeat(length)).success;
      expect([
        fits(TASK_TEXT_MAX_LENGTH),
        fits(TASK_TEXT_MAX_LENGTH + 1),
      ]).toEqual([true, false]);
    }
  });
});
