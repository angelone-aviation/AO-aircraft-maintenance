/**
 * Responsibility: Pins the required-parts views: availability lines and
 *   badge, the Parts requests section of a work form, and reading the parts a
 *   form carries.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/RequiredParts.tsx, react-dom/server,
 *   tests/fixtures/requiredParts.ts.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { neededPart, partsFixture } from "../../tests/fixtures/requiredParts";
import type { Snapshot } from "../domain/model";
import {
  DiscrepancyParts,
  PartsAvailability,
  RequiredPartsFields,
  requiredPartsFromForm,
} from "./RequiredParts";

const ui = vi.hoisted(() => ({ workspace: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({ useWorkspace: () => ui.workspace }));
vi.mock("./PartsRequests", () => ({
  RequestPartsButton: () => "[RequestPartsButton]",
}));

let s: Snapshot;

beforeEach(() => {
  s = partsFixture();
  ui.workspace = { snapshot: s, online: true, connected: true };
});

describe("PartsAvailability", () => {
  it("lists each part's need, stock and purchasing against the lot", () => {
    s.partsOnOrder = [
      { stockUuid: "parts-stock", quantity: 4, shipped: 1 },
      { stockUuid: "parts-stock", quantity: 2, shipped: 2 },
      { stockUuid: "remote-stock", quantity: 9, shipped: 9 },
    ];
    const html = renderToStaticMarkup(
      h(PartsAvailability, { parts: [neededPart] }),
    );
    expect(html).toBe(
      '<div class="parts-availability"><span class="badge warning">Parts shortage</span>' +
        '<small class="block">FILTER-1 · Main hangar · Need 3 / Available 2 · Short 1 · On order 6 · Shipped 3</small></div>',
    );
  });

  it("prefers the part's own purchasing, and marks expired stock", () => {
    const stock = s.management!.find((r) => r.uuid === "parts-stock")!;
    if (stock.kind === "stock") stock.expirationDate = "2000-01-01";
    s.partsOnOrder = [{ stockUuid: "parts-stock", quantity: 4, shipped: 3 }];
    const part = { ...neededPart, quantity: 1, onOrder: 5, shipped: 0 };
    expect(
      renderToStaticMarkup(h(PartsAvailability, { parts: [part] })),
    ).toContain(
      "Need 1 / Available 0 · Short 1 · Expired 2 · On order 5 · Shipped 0",
    );
  });

  it("says available, unknown or cached", () => {
    const enough = { ...neededPart, quantity: 2 };
    const missing = { ...neededPart, stockUuid: "missing" };
    const render = (parts: (typeof neededPart)[]) =>
      renderToStaticMarkup(h(PartsAvailability, { parts }));
    expect(render([enough])).toContain(">Parts available<");
    expect(render([enough])).not.toContain("Cached stock");
    expect(render([enough, missing])).toContain(
      '<span class="badge warning">Parts availability unknown</span>',
    );
    expect(render([missing])).toContain(
      "Unavailable part · Main hangar · Need 3 / Available unknown · On order 0",
    );
    ui.workspace.connected = false;
    expect(render([enough])).toContain(
      "Cached stock quantities — reconnect to verify.",
    );
  });

  it("renders nothing without parts or a snapshot", () => {
    expect(renderToStaticMarkup(h(PartsAvailability, {}))).toBe("");
    ui.workspace.snapshot = undefined;
    expect(
      renderToStaticMarkup(h(PartsAvailability, { parts: [neededPart] })),
    ).toBe("");
  });
});

describe("RequiredPartsFields", () => {
  it("carries the saved parts and asks to save before requesting", () => {
    const html = renderToStaticMarkup(
      h(RequiredPartsFields, { initial: [neededPart] }),
    );
    expect(html).toContain(
      `name="requiredParts" value="${JSON.stringify([neededPart]).replaceAll('"', "&quot;")}"`,
    );
    expect(html).toContain("Your saved parts list prefills a new request.");
    expect(html).toContain("Save this work first, then add its parts request.");
    expect(html).toContain("Parts shortage");
  });

  it("offers the request button once the work has a source", () => {
    const source = {
      kind: "discrepancy",
      uuid: "parts-report",
      workOrderUuid: "",
    } as const;
    const html = renderToStaticMarkup(h(RequiredPartsFields, { source }));
    expect(html).toContain('value="[]"');
    expect(html).not.toContain("prefills");
    expect(html).not.toContain("Save this work first");
  });
});

describe("DiscrepancyParts", () => {
  it("shows a report's parts", () => {
    const report = { ...s.discrepancies[0], requiredParts: [neededPart] };
    expect(renderToStaticMarkup(h(DiscrepancyParts, { report }))).toContain(
      "FILTER-1 · Main hangar · Need 3",
    );
  });
});

describe("requiredPartsFromForm", () => {
  it("reads the hidden list, or none", () => {
    const data = new FormData();
    expect(requiredPartsFromForm(data)).toEqual([]);
    data.set("requiredParts", JSON.stringify([neededPart]));
    expect(requiredPartsFromForm(data)).toEqual([neededPart]);
    data.set("requiredParts", JSON.stringify([{ ...neededPart, quantity: 0 }]));
    expect(() => requiredPartsFromForm(data)).toThrow();
  });
});
