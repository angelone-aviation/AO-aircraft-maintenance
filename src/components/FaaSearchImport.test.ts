/**
 * Responsibility: Pins who is offered the FAA AD search. The window needs a
 *   browser: tests/e2e/airworthiness.spec.ts covers its demo-mode refusal.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FaaSearchImport.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { FaaSearchImport } from "./FaaSearchImport";

const workspace = { snapshot: demoSnapshot() };
vi.mock("../data/store", () => ({ useWorkspace: () => workspace }));

const render = () =>
  renderToStaticMarkup(
    createElement(FaaSearchImport, { aircraftUuid: "demo-206" }),
  );

describe("FaaSearchImport", () => {
  it("offers the search to a user with maintenance permission", () => {
    expect(render()).toBe(
      '<button class="button primary">Search FAA ADs &amp; Import</button>',
    );
  });

  it("disables it for a pilot who can read the aircraft", () => {
    const snapshot = demoSnapshot();
    workspace.snapshot = {
      ...snapshot,
      user: { ...snapshot.user, isAdmin: false, groupIds: ["demo-pilots"] },
    };
    expect(render()).toContain("disabled");
  });
});
