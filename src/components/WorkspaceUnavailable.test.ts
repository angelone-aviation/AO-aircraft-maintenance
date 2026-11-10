/**
 * Responsibility: Pins the workspace-unavailable page: its plain-words
 *   message and which choices it offers.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/WorkspaceUnavailable.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  WorkspaceUnavailable,
  type WorkspaceUnavailableProps,
} from "./WorkspaceUnavailable";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({ useWorkspace: () => workspace.state }));

const SYNCED_AT = Date.UTC(2026, 10, 9, 15, 30);
const entry = (authorId: string) => ({ operation: { authorId } });

function render(
  props: Partial<WorkspaceUnavailableProps>,
  queue = [entry("u1")],
) {
  workspace.state = { queue };
  return renderToStaticMarkup(
    h(WorkspaceUnavailable, {
      onRetry: () => undefined,
      onOpenKeptCopy: () => undefined,
      onSignOut: () => undefined,
      ...props,
    }),
  );
}

describe("WorkspaceUnavailable", () => {
  it("says what happened, that records are safe and whom to contact", () => {
    const html = render({});
    expect(html).toContain("Your workspace could not be opened.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Your records are safe");
    expect(html).toContain("contact your Flight Program administrator");
    expect(html).toContain("Try again</button>");
    expect(html).toContain("Sign out</button>");
  });

  it("offers the copy on this device only when the root allows it", () => {
    expect(render({})).not.toContain("View the copy on this device");
    const html = render({ keptCopySyncedAt: SYNCED_AT });
    expect(html).toContain("View the copy on this device</button>");
    expect(html).toContain("Last synced Nov 9, 2026");
  });

  it("offers the signed-in account's pending entries, and nobody else's", () => {
    expect(render({ userId: "u1" })).toContain("Export my pending entries");
    expect(render({ userId: "u2" })).not.toContain("Export my pending entries");
    expect(render({})).not.toContain("Export my pending entries");
  });
});
