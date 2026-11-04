/**
 * Responsibility: Pins when the Delete group button is offered. The preview
 *   and deletion need a browser: tests/e2e/program-users.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/DeleteGroupButton.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { DeleteGroupButton } from "./DeleteGroupButton";

const workspace = { backend: null, online: true, connected: true };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const render = () =>
  renderToStaticMarkup(
    createElement(DeleteGroupButton, { group: demoSnapshot().groups[0] }),
  );

describe("DeleteGroupButton", () => {
  it("is offered while connected", () => {
    expect(render()).toBe(
      '<button type="button" class="text-button">Delete group</button>',
    );
  });

  it("is disabled offline or while disconnected", () => {
    workspace.connected = false;
    expect(render()).toContain("disabled");
    workspace.connected = true;
    workspace.online = false;
    expect(render()).toContain("disabled");
  });
});
