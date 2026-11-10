/**
 * Responsibility: Pins the root error boundary: a render error swaps the
 *   tree for the plain-words fallback page.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ErrorBoundary.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorBoundary, RenderFailure } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  // Server rendering does not run error boundaries, so the boundary's two
  // halves are pinned directly: the state an error sets, and what it renders.
  it("renders the fallback once a child has thrown, the children before", () => {
    const boundary = new ErrorBoundary({ children: "app", fallback: "page" });
    expect(boundary.render()).toBe("app");
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    expect(boundary.render()).toBe("page");
  });
});

describe("RenderFailure", () => {
  it("says records are safe and offers a reload", () => {
    const html = renderToStaticMarkup(h(RenderFailure));
    expect(html).toContain("Something went wrong.");
    expect(html).toContain("Your records are safe");
    expect(html).toContain("Reload</button>");
  });
});
