/**
 * Responsibility: Pins who sees the Geoapify key panel and when its form is
 *   disabled. Loading and saving the key need a backend:
 *   tests/e2e/addresses.spec.ts covers the panel in demo mode.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AddressVerificationSettings.tsx,
 *   src/data/demo.ts (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { AddressVerificationSettings } from "./AddressVerificationSettings";

const workspace = {
  snapshot: demoSnapshot(),
  backend: null,
  online: true,
  connected: true,
  demo: false,
};
vi.mock("../data/store", () => {
  const useWorkspace = () => workspace;
  useWorkspace.getState = () => workspace;
  return { useWorkspace };
});
beforeEach(() => {
  workspace.snapshot = demoSnapshot();
  workspace.snapshot.user.isAdmin = true;
  workspace.demo = false;
});

const render = () =>
  renderToStaticMarkup(createElement(AddressVerificationSettings));

describe("AddressVerificationSettings", () => {
  it("shows nothing to anyone but a system administrator", () => {
    workspace.snapshot.user.isAdmin = false;
    expect(render()).toBe("");
  });

  it("asks a system administrator for a key of 16 or more characters", () => {
    const html = render();
    expect(html).toContain("<h3>Address verification</h3>");
    expect(html).toContain('minLength="16"');
  });

  it("disables saving until the key's status has loaded", () => {
    expect(render()).toMatch(/<fieldset disabled=""/);
  });

  it("says the key is saved only on a live deployment in demo mode", () => {
    workspace.demo = true;
    expect(render()).toContain(
      "Not available in the demo: keys and accounts are saved only on a live deployment.",
    );
  });
});
