/**
 * Responsibility: Pins the engine trends window: loading, flagged imports,
 *   charts and table, importing a log through a preview, removing an import
 *   and saving limits.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/EngineTrends.tsx, react-dom/server,
 *   src/data/demo.ts (seed), src/domain/engineTrends.ts, tests/fixtures
 *   (JPI and Garmin exports).
 *
 * Server rendering keeps no state, runs no effects and calls no handlers, so
 * mocks keep each component's useState values by name and key (dropped once
 * it stops rendering, as on unmount), record each render's effects, and
 * capture buttons and forms: a test mounts, acts, and renders again.
 */
// @vitest-environment node
import { readFileSync } from "node:fs";
import { createElement as h, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  parseEngineLog,
  type EngineTrend,
  type EngineTrendData,
} from "../domain/engineTrends";
import { AircraftEngineTrends } from "./EngineTrends";

type Frame = { key: string; next: number };
type Props = Record<string, unknown>;

const ui = vi.hoisted(() => ({
  states: new Map<string, unknown[]>(),
  frames: [] as Frame[],
  rendered: new Set<string>(),
  wrappers: new Map<unknown, Map<unknown, unknown>>(),
  effects: [] as (() => unknown)[],
  buttons: [] as { text: string; props: Props }[],
  forms: new Map<string, Props>(),
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
    if (node == null || typeof node === "boolean") return "";
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && "children" in node)
      return textOf(node.children);
    return typeof node === "object" ? "" : String(node);
  }
});
// Modal is a plain element: the real dialog's effects need a DOM.
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Modal: (props: Parameters<typeof actual.Modal>[0]) =>
      createElement("dialog", { "aria-label": props.title }, props.children),
    AsyncForm: (props: Parameters<typeof actual.AsyncForm>[0]) => {
      ui.forms.set(props.submitLabel ?? "Save", props as never);
      return actual.AsyncForm(props);
    },
  };
});
vi.mock("../data/store", () => ({
  useWorkspace: Object.assign(() => ui.workspace, {
    getState: () => ui.workspace,
  }),
}));

const fixture = (name: string) =>
  readFileSync(`tests/fixtures/${name}`, "utf8");
const JPI = fixture("engine-jpi-edm830.csv");
const G1000 = fixture("engine-g1000.csv");
const trend = (text: string, file: string, uuid: string): EngineTrend => ({
  ...parseEngineLog(text, file),
  uuid,
  aircraftUuid: "demo-206",
  importedAt: 1,
  importedBy: "demo-admin",
});
const UUID_1 = "00000000-0000-4000-8000-000000000001";
const UUID_2 = "00000000-0000-4000-8000-000000000002";
let data: EngineTrendData;
let calls: unknown[][];
let element: Parameters<typeof renderToStaticMarkup>[0];

beforeEach(() => {
  ui.states.clear();
  calls = [];
  data = {
    trends: [trend(G1000, "g.csv", UUID_2), trend(JPI, "j.csv", UUID_1)],
    limits: { chtMaxF: 435, oilPressureMinPsi: 25 },
  };
  ui.workspace = {
    snapshot: demoSnapshot(),
    online: true,
    connected: true,
    backend: {
      engineTrends: async (aircraftUuid: string) => {
        calls.push(["load", aircraftUuid]);
        return structuredClone(data);
      },
      engineTrend: async (aircraftUuid: string, command: unknown) => {
        calls.push(["command", aircraftUuid, command]);
      },
    },
  };
  element = h(AircraftEngineTrends, {
    aircraftUuid: "demo-206",
    registration: "N206MA",
  });
});

function render() {
  ui.buttons = [];
  ui.effects = [];
  ui.forms.clear();
  ui.rendered.clear();
  ui.frames = [{ key: "root", next: 0 }];
  const html = renderToStaticMarkup(element);
  for (const key of ui.states.keys())
    if (key !== "root" && !ui.rendered.has(key)) ui.states.delete(key);
  return html;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Opens the window, runs its load, and renders again.
async function open() {
  render();
  click("Engine trends");
  for (const effect of ui.effects) effect();
  await settle();
  return render();
}

function click(text: string) {
  const found = ui.buttons.find((b) => b.text === text);
  if (!found) throw Error(`No button "${text}"`);
  (found.props.onClick as () => unknown)();
  return render();
}

async function submit(label: string, fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, field] of Object.entries(fields)) form.set(key, field);
  await (ui.forms.get(label)!.onSubmit as (d: FormData) => unknown)(form);
  await settle();
  return render();
}

const backend = () => ui.workspace.backend as Props;

describe("AircraftEngineTrends", () => {
  it("opens the aircraft's trends, or asks to reconnect", async () => {
    expect(render()).toBe(
      '<button type="button" class="button">Engine trends</button>',
    );
    const html = await open();
    expect(html).toContain("Engine trends · N206MA");
    expect(calls).toEqual([["load", "demo-206"]]);
    ui.states.clear();
    ui.workspace.online = false;
    expect(await open()).toContain(
      "Reconnect to view and import engine trends.",
    );
  });

  it("shows loading, then a load failure", async () => {
    render();
    expect(click("Engine trends")).toContain("Loading engine trends…");
    ui.states.clear();
    backend().engineTrends = async () => {
      throw Error("[CONVEX Q(engineTrends:list)] Server Error");
    };
    expect(await open()).toContain(
      '<p role="alert" class="error">Engine trends could not be loaded.</p>',
    );
  });

  it("explains the limits, lists flagged imports and charts each series", async () => {
    data.limits = { chtMaxF: 300, oilPressureMinPsi: 25 };
    const html = await open();
    expect(html).toContain(
      "Flags: hottest CHT above 300 °F, CHT spread above 50 °F, or cruise oil pressure below 25 psi.",
    );
    expect(html.match(/<li><strong>/g)!.length).toBe(2);
    expect(html).toMatch(
      /<strong>\d{4}-\d\d-\d\d · j\.csv<\/strong>: Hottest CHT/,
    );
    expect(
      html.match(/<figure class="engine-chart">/g)!.length,
    ).toBeGreaterThan(3);
    expect(html).toMatch(
      /<desc[^>]*>CHT \(hottest cylinder\) across 2 imports from .* Latest max: \d+ °F\. Limit 300 °F\.<\/desc>/,
    );
    expect(html).toMatch(/r="4" class="engine-point-flag"/);
    expect(html).toMatch(/r="2.5" class="engine-point-1"/);
    const secondLines = html
      .split("<g>")
      .filter((g) => g.includes('class="engine-line engine-line-1"'));
    expect(secondLines.length).toBeGreaterThan(0);
    for (const g of secondLines)
      expect(g.split("</g>")[0]).not.toContain("engine-point-flag");
    expect(html).not.toContain("<table>");
  });

  it("shows the data table in date order and removes an import", async () => {
    await open();
    const html = click("Show data table");
    expect(html).toContain("Hide data table");
    const files = [...html.matchAll(/<td>([gj])\.csv<\/td>/g)].map((m) => m[1]);
    expect(files).toHaveLength(2);
    const dated = [...data.trends].sort((a, b) =>
      (a.start ?? a.date).localeCompare(b.start ?? b.date),
    );
    expect(files).toEqual(dated.map((t) => t.fileName[0]));
    (
      ui.buttons.filter((b) => b.text === "Remove")[0].props
        .onClick as () => void
    )();
    await settle();
    expect(calls.at(-2)).toEqual([
      "command",
      "demo-206",
      { action: "remove", uuid: dated[0].uuid },
    ]);
    expect(calls.at(-1)).toEqual(["load", "demo-206"]);
    backend().engineTrend = async () => {
      throw Error("Import not found.");
    };
    render();
    (
      ui.buttons.filter((b) => b.text === "Remove")[0].props
        .onClick as () => void
    )();
    await settle();
    expect(render()).toContain(
      '<p role="alert" class="error">Import not found.</p>',
    );
  });

  it("offers imports, removal and limits only with maintenance access", async () => {
    const s = demoSnapshot();
    s.user = { ...s.user, isAdmin: false, groupIds: [] };
    ui.workspace.snapshot = s;
    await open();
    expect(click("Show data table")).not.toContain("Remove");
    expect(ui.forms.size).toBe(0);
  });

  it("saves limits, then reloads", async () => {
    const html = await open();
    expect(html).toContain("Default 435 °F.");
    expect(html).toMatch(/min="200" max="700"[^>]*name="cht"/);
    expect(html).toMatch(/min="0" max="200"[^>]*name="oil"/);
    await submit("Save limits", { cht: " 440 ", oil: "30" });
    expect(calls.slice(1)).toEqual([
      [
        "command",
        "demo-206",
        { action: "limits", limits: { chtMaxF: 440, oilPressureMinPsi: 30 } },
      ],
      ["load", "demo-206"],
    ]);
  });

  it("previews an engine log before saving it", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(UUID_1);
    await open();
    await expect(
      submit("Preview summary", { engineLog: new File([], "x.csv") }),
    ).rejects.toThrow("Choose an engine monitor CSV up to 7 MiB.");
    const html = await submit("Preview summary", {
      engineLog: new File([JPI], "jpi.csv"),
    });
    expect(html).toMatch(
      /<strong>jpi\.csv<\/strong>: JPI EDM log, \d{4}-\d\d-\d\d, \d+\.\d h, \d+ engine-running samples\./,
    );
    (ui.forms.get("Preview summary")!.onChange as () => void)();
    expect(render()).not.toContain("Save engine summary");
    await submit("Preview summary", { engineLog: new File([JPI], "jpi.csv") });
    await submit("Save engine summary", {});
    expect(calls.at(-2)).toEqual([
      "command",
      "demo-206",
      {
        action: "import",
        uuid: UUID_1,
        summary: parseEngineLog(JPI, "jpi.csv"),
      },
    ]);
    expect(render()).not.toContain("Save engine summary");
  });

  it("asks for the first import", async () => {
    data.trends = [];
    const html = await open();
    expect(html).toContain("No engine data imported");
    expect(html).toContain("No imports exceed the limits.");
  });
});
