/**
 * Responsibility: Pins when the jobs CSV import button is offered and its
 *   label. The dialog, preview and import need a browser:
 *   tests/e2e/task-csv.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/TaskCsvImport.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { TaskCsvImportButton } from "./TaskCsvImport";

const workspace = { snapshot: demoSnapshot(), online: true, connected: true };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));
beforeEach(() => {
  workspace.snapshot = demoSnapshot();
  workspace.online = true;
  workspace.connected = true;
});

const render = (props: ComponentProps<typeof TaskCsvImportButton> = {}) =>
  renderToStaticMarkup(createElement(TaskCsvImportButton, props));

describe("TaskCsvImportButton", () => {
  it("offers the import to a maintainer who is online", () => {
    expect(render()).toBe(
      '<button type="button" class="button">Import Jobs CSV</button>',
    );
  });

  it("uses the label given", () => {
    expect(render({ label: "Import tasks" })).toContain(">Import tasks<");
  });

  it("is disabled offline or while disconnected", () => {
    workspace.online = false;
    expect(render()).toContain("disabled");
    workspace.online = true;
    workspace.connected = false;
    expect(render()).toContain("disabled");
  });

  it("is disabled without maintenance permission", () => {
    workspace.snapshot.user.active = false;
    expect(render()).toContain("disabled");
  });
});
