/**
 * Responsibility: Pins which statements the release statement picker offers,
 *   what picking one does, and how the statement editor saves.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ReleaseStatements.tsx, react-dom/server,
 *   src/data/demo.ts (seed), convex/values (ConvexError).
 *
 * Server rendering keeps no state and runs no handlers, so mocks keep
 * useState values in call order and record each element's handlers from the
 * JSX runtime: a test presses a button, then renders again.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexError } from "convex/values";
import { beforeEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  defaultReleaseStatements,
  type ReleaseStatement,
} from "../domain/releaseStatements";
import type { Snapshot } from "../domain/model";
import { ReleaseStatements } from "./ReleaseStatements";

type Handlers = { children?: unknown; onClick?: () => unknown };
type Picker = { onChange?: (event: { target: { value: string } }) => void };

const ui = vi.hoisted(() => ({
  states: [] as unknown[],
  next: 0,
  buttons: new Map<string, () => unknown>(),
  picker: undefined as Picker["onChange"],
  workspace: {} as Record<string, unknown>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const slot = ui.next++;
      if (!(slot in ui.states)) ui.states[slot] = initial;
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
      const props = element as Handlers & Picker;
      if (type === "button" && props.onClick)
        ui.buttons.set([props.children].flat().join(""), props.onClick);
      if (type === "select") ui.picker = props.onChange;
      return runtime.jsxDEV(...args);
    },
  };
});
vi.mock("../data/store", () => ({ useWorkspace: () => ui.workspace }));

let s: Snapshot;
let saved: ReleaseStatement[][];
let picked: string[];

beforeEach(() => {
  s = demoSnapshot();
  saved = [];
  picked = [];
  ui.states = [];
  ui.workspace = {
    snapshot: s,
    online: true,
    connected: true,
    backend: {
      saveReleaseStatements: async (list: ReleaseStatement[]) => {
        saved.push(list);
      },
    },
  };
});

function render(value = "", editable = true) {
  ui.next = 0;
  ui.buttons.clear();
  const onChange = (text: string) => picked.push(text);
  return renderToStaticMarkup(
    h(ReleaseStatements, { value, onChange, editable }),
  );
}

async function press(text: string) {
  const handler = ui.buttons.get(text);
  if (!handler) throw new Error(`No "${text}" button.`);
  await handler();
}

it("shows only the release outcome when the order is not editable", () => {
  const html = render("Returned to service.", false);
  expect(html).toContain('name="releaseOutcome"');
  expect(html).toContain(">Returned to service.</textarea>");
  expect(html).not.toContain("<select");
});

it("offers the starter statements until the user saves their own", () => {
  const starter = defaultReleaseStatements[1];
  expect(render()).toContain(">Select a release statement</option>");
  expect(render(starter.text)).toContain(
    `<option value="1" selected="">${starter.label}</option>`,
  );
  expect(render("Edited words")).toContain(">Custom / edited statement<");
  s.user.releaseStatements = [{ label: "Mine", text: "My text" }];
  expect(render()).toContain('<option value="0">Mine</option>');
});

it("replaces the outcome with the statement picked", () => {
  render();
  ui.picker!({ target: { value: "-1" } });
  ui.picker!({ target: { value: "2" } });
  expect(picked).toEqual([defaultReleaseStatements[2].text]);
});

it("saves the list to the account without its draft ids, then closes", async () => {
  render();
  await press("Manage release statements");
  expect(render()).toContain("<h4>My release statements</h4>");
  await press("Save release statements");
  expect(saved).toEqual([defaultReleaseStatements]);
  expect(render()).not.toContain("My release statements");
});

it("shows the server's refusal and keeps the editor open", async () => {
  ui.workspace.backend = {
    saveReleaseStatements: async () => {
      throw new ConvexError("Release statements changed. Reload.");
    },
  };
  render();
  await press("Manage release statements");
  render();
  await press("Save release statements");
  const html = render();
  expect(html).toContain(
    '<p role="alert">Release statements changed. Reload.</p>',
  );
  expect(html).toContain("My release statements");
});

it("allows 100 statements, and saving only with a connection", async () => {
  s.user.releaseStatements = Array.from({ length: 100 }, (_, i) => ({
    label: `Statement ${i}`,
    text: "Text",
  }));
  ui.workspace.connected = false;
  render();
  await press("Manage release statements");
  const html = render();
  expect(html).toContain('disabled="">Add release statement</button>');
  expect(html).toContain('disabled="">Save release statements</button>');
});
