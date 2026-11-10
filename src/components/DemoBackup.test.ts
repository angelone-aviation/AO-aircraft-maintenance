/**
 * Responsibility: Pins when the demo data download panel shows.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/DemoBackup.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DemoBackup } from "./DemoBackup";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({ useWorkspace: () => workspace.state }));

const render = (demo: boolean, snapshot: object | null) => {
  workspace.state = { demo, snapshot, namespace: "ns" };
  return renderToStaticMarkup(h(DemoBackup));
};

describe("DemoBackup", () => {
  it("offers the download in demo mode", () => {
    expect(render(true, {})).toContain(
      '<button type="button" class="button small">Download demo data</button>',
    );
  });

  it("renders nothing outside demo mode or before a snapshot loads", () => {
    expect(render(false, {})).toBe("");
    expect(render(true, null)).toBe("");
  });
});
