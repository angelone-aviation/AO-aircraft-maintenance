/**
 * Responsibility: Pins the history pager's states: what the list covers and
 *   Load older, loading, all records loaded, offline and a failed load.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/HistoryPager.tsx, react-dom/server.
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HistoryPager, windowSummary, type PagerState } from "./HistoryPager";

const SUMMARY = "Showing the last 3 months";

describe("HistoryPager", () => {
  it("says what the list covers and offers Load older", () => {
    const html = pager({});
    expect(text(html)).toBe("Showing the last 3 months·Load older");
    expect(html).toContain('<button type="button" class="history-pager-load"');
    expect(html).not.toContain("disabled");
  });

  it("is disabled offline, saying older records need a connection", () => {
    const html = pager({ offline: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby=/);
    expect(text(html)).toContain("Older records need a connection");
  });

  it("disables the button while a page loads", () => {
    const html = pager({ loading: true });
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(text(html)).toContain("Loading older records…");
  });

  it("says all records are loaded once the list is done, online or not", () => {
    for (const offline of [false, true]) {
      const html = pager({ isDone: true, offline });
      expect(text(html)).toBe("Showing the last 3 months·All records loaded");
      expect(html).not.toContain("<button");
    }
  });

  it("shows a failed load as an alert and still offers Load older", () => {
    const html = pager({ error: "History not found." });
    expect(html).toContain('<p role="alert" class="error">History not found.');
    expect(html).toContain("Load older");
  });
});

describe("windowSummary", () => {
  it("names each list's window, and the older rows loaded", () => {
    expect(windowSummary("flights", 0, "flight")).toBe(
      "Showing the last 6 months",
    );
    expect(windowSummary("workOrders", 1, "work order")).toBe(
      "Showing the last 3 months and 1 older work order",
    );
    expect(windowSummary("discrepancies", 50, "report")).toBe(
      "Showing the last 3 months and 50 older reports",
    );
  });
});

function pager(state: Partial<PagerState>) {
  const pages: PagerState = {
    isDone: false,
    loading: false,
    error: "",
    offline: false,
    loadOlder: () => {},
    ...state,
  };
  return renderToStaticMarkup(h(HistoryPager, { pages, summary: SUMMARY }));
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, "");
}
