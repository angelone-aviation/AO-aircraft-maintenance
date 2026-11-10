/**
 * Responsibility: Pins the waiting-to-send line: its wording, that it counts
 *   only the signed-in user's entries, and that it stays an empty live region
 *   when nothing waits.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/OutboxLine.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OutboxLine, waitingText } from "./OutboxLine";

const workspace = {
  snapshot: { user: { id: "me" } },
  online: false,
  connected: false,
  queue: [] as { operation: { authorId: string } }[],
};
vi.mock("../data/store", () => ({
  useWorkspace: (select: (w: typeof workspace) => unknown) => select(workspace),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; children: ReactNode }) =>
    createElement("a", { href: props.to }, props.children),
}));
const entry = (authorId: string) => ({ operation: { authorId } });
const render = () => renderToStaticMarkup(createElement(OutboxLine));

describe("waitingText", () => {
  it("counts entries in the singular and plural, adding Offline when offline", () => {
    expect(waitingText(1, false)).toBe("1 entry waiting to send");
    expect(waitingText(3, true)).toBe("3 entries waiting to send · Offline");
    expect(waitingText(0, true)).toBe("");
  });
});

describe("OutboxLine", () => {
  it("shows the user's own entries only, with a link to the Sync center", () => {
    workspace.queue = [entry("me"), entry("someone else"), entry("me")];
    const html = render();
    expect(html).toContain("2 entries waiting to send · Offline");
    expect(html).toContain('href="/sync"');
  });

  it("keeps an empty live region when nothing waits", () => {
    workspace.queue = [entry("someone else")];
    expect(render()).toBe(
      '<div class="outbox-line empty"><span aria-live="polite" aria-atomic="true" class="outbox-line-text"></span></div>',
    );
  });

  it("drops Offline once connected", () => {
    workspace.queue = [entry("me")];
    Object.assign(workspace, { online: true, connected: true });
    expect(render()).toContain("1 entry waiting to send<");
  });
});
