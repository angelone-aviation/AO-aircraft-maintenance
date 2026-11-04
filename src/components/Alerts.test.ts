/**
 * Responsibility: Pins the alert bell's label and badge cap, the order of the
 *   severity groups and when "Mark all read" is offered. Marking read needs a
 *   browser: tests/e2e/alerts.spec.ts covers it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/Alerts.tsx, src/domain/alerts.ts (Alert type),
 *   react-dom/server.
 */
// @vitest-environment node
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Alert } from "../domain/alerts";
import { AlertBell, AlertsPage } from "./Alerts";

let alerts: Partial<Alert>[] = [];
const reads = { keys: [] as string[], error: "", load: vi.fn() };
vi.mock("../data/store", () => ({
  useWorkspace: (select?: (s: object) => unknown) => {
    const state = { snapshot: { user: { id: "u1" } } };
    return select ? select(state) : state;
  },
}));
vi.mock("../data/alerts", () => ({
  useAlertReads: (select?: (s: typeof reads) => unknown) =>
    select ? select(reads) : reads,
}));
vi.mock("../domain/alerts", async (original) => ({
  ...(await original<object>()),
  computeAlerts: () => alerts,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: { to: string; children: ReactNode }) =>
    createElement("a", { href: to, ...props }),
}));
beforeEach(() => {
  reads.keys = [];
});

const alert = (key: string, severity: Alert["severity"]) => ({
  key,
  severity,
  title: key,
  link: "/" as const,
});
const render = (component: () => ReactNode) =>
  renderToStaticMarkup(createElement(component));

describe("AlertBell", () => {
  it("caps the badge at 99+ and names the unread count", () => {
    alerts = Array.from({ length: 100 }, (_, i) => alert(`a${i}`, "info"));
    const html = render(AlertBell);
    expect(html).toContain('aria-label="Alerts, 100 unread"');
    expect(html).toContain(">99+</span>");
  });

  it("drops the badge once every alert is read", () => {
    alerts = [alert("a", "info")];
    reads.keys = ["a"];
    const html = render(AlertBell);
    expect(html).toContain('aria-label="Alerts"');
    expect(html).not.toContain("alert-count");
  });
});

describe("AlertsPage", () => {
  it("lists the groups most urgent first", () => {
    alerts = [alert("i", "info"), alert("w", "warning"), alert("d", "danger")];
    const headings = [...render(AlertsPage).matchAll(/<h2 id="([^"]+)"/g)];
    expect(headings.map((m) => m[1])).toEqual([
      "mx-alerts-danger",
      "mx-alerts-warning",
      "mx-alerts-info",
    ]);
  });

  it("offers Mark all read only while an alert is unread", () => {
    alerts = [alert("a", "warning")];
    const markAll = () => render(AlertsPage).match(/<button[^>]*>/)?.[0];
    expect(markAll()).not.toContain("disabled");
    reads.keys = ["a"];
    expect(markAll()).toContain("disabled");
  });
});
