// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { localDate, type Inspection } from "../domain/model";
import { Dashboard } from "./Dashboard";
let snapshot = demoSnapshot();
vi.mock("../data/store", () => {
  const state = () => ({
    snapshot,
    favorites: [],
    toggleFavorite: () => {},
    online: true,
    connected: true,
  });
  const useWorkspace = (select?: (s: ReturnType<typeof state>) => unknown) =>
    select ? select(state()) : state();
  return { useWorkspace: Object.assign(useWorkspace, { getState: state }) };
});
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: unknown }) =>
    createElement("a", null, children as never),
}));
beforeEach(() => {
  snapshot = demoSnapshot();
});
const shift = (days: number) => {
  const d = new Date(localDate() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
/** N182MA (1,650.4 h on the Hobbs) with only the given inspections. */
function render(...inspections: Partial<Inspection>[]) {
  snapshot.inspections = inspections.map((i, n) => ({
    uuid: `insp-${n}`,
    aircraftUuid: "demo-182",
    reference: `REF-${n}`,
    description: `Inspection ${n}`,
    ...i,
  }));
  const html = renderToStaticMarkup(createElement(Dashboard));
  const card = html.slice(html.indexOf(">N182MA</h3>"));
  const timeline = card.slice(
    card.indexOf("dash-timeline"),
    card.indexOf("</article>"),
  );
  const text = (s: string) =>
    s
      .replace(/<[^>]+aria-label="([^"]*)"[^>]*>/g, " $1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  const outlook = html.slice(
    html.indexOf("Maintenance outlook"),
    html.indexOf("dash-callout"),
  );
  return { card: text(timeline), outlook: text(outlook) };
}
it("shows the overdue calendar limit, not the hours still remaining", () => {
  const due = shift(-5);
  const { card, outlook } = render({
    reference: "Annual + 100 h",
    lastSeconds: 1600 * 3600,
    dueSeconds: 1700 * 3600,
    lastDate: shift(-370),
    dueDate: due,
  });
  expect(card).toContain("Annual + 100 h 5 days overdue");
  expect(card).not.toContain("49.6 h remaining");
  expect(card).toContain("Due " + due.slice(8).replace(/^0/, ""));
  expect(outlook).toMatch(/Annual \+ 100 h .* · overdue/);
  expect(outlook).not.toContain("49.6 h");
});
it("shows the dimension closest to its limit relative to its due-soon allowance", () => {
  // 20 of 30 calendar days left is nearer the limit than 8.6 of 10 hours.
  const calendar = render({
    reference: "Combined",
    dueSeconds: 1659 * 3600,
    dueDate: shift(10),
  });
  expect(calendar.card).toContain("Combined 10 days remaining");
  expect(calendar.outlook).not.toContain("8.6 h");
  // 2.6 of 10 hours left is nearer than 20 of 30 days.
  const hours = render({
    reference: "Combined",
    dueSeconds: 1653 * 3600,
    dueDate: shift(20),
  });
  expect(hours.card).toContain("Combined 2.6 h remaining");
  expect(hours.outlook).toContain("2.6 h");
});
it("shows the most overdue limit when several are overdue", () => {
  const { card, outlook } = render({
    reference: "Combined",
    dueSeconds: 1649 * 3600,
    dueDate: shift(-40),
  });
  expect(card).toContain("Combined 40 days overdue");
  expect(outlook).toMatch(/Combined .* · overdue/);
  const hours = render({
    reference: "Combined",
    dueSeconds: 1600 * 3600,
    dueDate: shift(-2),
  });
  expect(hours.card).toContain("Combined 50.4 h overdue");
  expect(hours.outlook).toContain("50.4 h overdue");
});
it("keeps the progress track on the dimension shown", () => {
  const { card } = render({
    reference: "Combined",
    lastSeconds: 1600 * 3600,
    dueSeconds: 1700 * 3600,
    lastDate: shift(-355),
    dueDate: shift(10),
  });
  expect(card).toContain("Combined 10 days remaining");
  // 355 of 365 days used, not 50.4 of 100 hours.
  expect(card).toContain("Combined: 97% of the interval used");
  expect(card).not.toContain("Last 1,600.0 h");
});
it("picks the most urgent of several inspections with the same status", () => {
  const { card, outlook } = render(
    { reference: "SLIGHTLY-LATE", dueSeconds: 1650 * 3600 },
    { reference: "VERY-LATE", dueSeconds: 1600 * 3600 },
  );
  expect(card).toContain("VERY-LATE 50.4 h overdue");
  expect(outlook.indexOf("VERY-LATE")).toBeLessThan(
    outlook.indexOf("SLIGHTLY-LATE"),
  );
  const scheduled = render(
    { reference: "LATER", dueDate: shift(300) },
    { reference: "SOONER", dueDate: shift(200) },
  );
  expect(scheduled.card).toContain("SOONER 200 days remaining");
});
