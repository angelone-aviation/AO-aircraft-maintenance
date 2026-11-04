/**
 * Responsibility: Pins when the checklist editor refuses to save or close,
 *   which categories it offers to add, and how an entry's type is stored.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ChecklistEditor.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { ChecklistRecord } from "../domain/checklists";
import { ChecklistEditor } from "./ChecklistEditor";

// The editor's first two states (the draft record and its dirty flag) are
// seeded, and the record's updates are applied to `draft`.
let seeds: unknown[] = [];
let draft: ChecklistRecord;
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) => {
    if (!seeds.length) return react.useState(init);
    const isRecord = seeds.length === 2;
    const update = (next: (r: ChecklistRecord) => ChecklistRecord) => {
      if (isRecord) draft = next(draft);
    };
    return [seeds.shift(), update];
  };
  return { ...react, useState };
});
// The entry type selects, in order, captured as they are created.
let typeSelects: { onChange: (e: object) => void }[] = [];
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, ...rest) => {
    const { value } = props as { value?: string };
    if (type === "select" && (value === "check" || value === "comment"))
      typeSelects.push(props as (typeof typeSelects)[number]);
    return runtime.jsxDEV(type, props, ...rest);
  };
  return { ...runtime, jsxDEV };
});
let form: { onSubmit: () => Promise<void> };
let modal: { onClose: () => void };
vi.mock("./ui", async (original) => ({
  ...(await original<typeof import("./ui")>()),
  AsyncForm: (props: typeof form & { children: ReactNode }) => {
    form = props;
    return createElement("form", null, props.children);
  },
  Modal: (props: typeof modal & { children: ReactNode }) => {
    modal = props;
    return createElement("section", null, props.children);
  },
}));
const workspace = {
  snapshot: demoSnapshot(),
  online: true,
  connected: true,
  backend: { saveChecklist: vi.fn(async () => {}) },
};
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const list = {
  objectId: "cabin",
  title: "Cabin",
  items: [{ objectId: "note", type: "comment" as const, title: "Doors" }],
};
const record = (name: string): ChecklistRecord =>
  ({
    uuid: "set",
    version: 2,
    programUuid: "demo-program",
    aircraftUuid: workspace.snapshot.aircraft[0].uuid,
    sourceName: "c182.fmd",
    document: {
      type: "checklist",
      payload: {
        objectId: "doc",
        schemaVersion: "1.0",
        metadata: { name },
        groups: [
          {
            objectId: "normal",
            groupType: "normal",
            items: [
              { objectId: "preflight", title: "Preflight", items: [list] },
            ],
          },
          { objectId: "emergency", groupType: "emergency", items: [] },
        ],
      },
    },
  }) as ChecklistRecord;
const render = (initial: ChecklistRecord, dirty = false) => {
  draft = initial;
  seeds = [initial, dirty];
  typeSelects = [];
  const onClose = vi.fn();
  const html = renderToStaticMarkup(
    createElement(ChecklistEditor, { initial, onClose, onSaved: () => {} }),
  );
  return { html, onClose };
};

describe("ChecklistEditor", () => {
  it("refuses to save a set without a name", async () => {
    render(record("  "));
    await expect(form.onSubmit()).rejects.toThrow("Enter a checklist name.");
    expect(workspace.backend.saveChecklist).not.toHaveBeenCalled();
  });

  it("asks before discarding a changed draft", () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    const changed = render(record("C182"), true);
    modal.onClose();
    expect(confirm).toHaveBeenCalledWith("Discard unsaved checklist changes?");
    expect(changed.onClose).not.toHaveBeenCalled();
    const saved = render(record("C182"));
    modal.onClose();
    expect(confirm).toHaveBeenCalledOnce();
    expect(saved.onClose).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("offers to add only the categories the set lacks", () => {
    const { html } = render(record("C182"));
    const offered = html.replaceAll("<!-- -->", "").match(/Add \w+ category/g);
    expect(offered).toEqual(["Add abnormal category"]);
  });

  it("stores a check item without a type key", () => {
    render(record("C182"));
    typeSelects[0].onChange({ target: { value: "check" } });
    const entry = draft.document.payload.groups[0].items[0].items[0].items[0];
    expect(entry).not.toHaveProperty("type");
    expect(entry.title).toBe("Doors");
  });
});
