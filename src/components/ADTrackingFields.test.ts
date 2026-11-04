/**
 * Responsibility: Pins which AD tracking limits start checked and the fields
 *   each checked limit shows. Toggling needs a browser:
 *   tests/e2e/airworthiness.spec.ts covers it.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/ADTrackingFields.tsx,
 *   src/domain/airworthiness.ts (ADTask type), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ADTask } from "../domain/airworthiness";
import { ADTrackingFields } from "./ADTrackingFields";

const render = (task: Partial<ADTask>) =>
  renderToStaticMarkup(
    createElement(ADTrackingFields, {
      task: task as ADTask,
      onChange: () => {},
    }),
  );
const legends = (task: Partial<ADTask>) =>
  [...render(task).matchAll(/<legend>([^<]*)</g)].map((m) => m[1]);

describe("ADTrackingFields", () => {
  it("checks a limit that has a due point or an interval", () => {
    expect(legends({ dueHours: 0, intervalDays: 365, dueLandings: 5 })).toEqual(
      ["Hours", "Calendar", "Landings"],
    );
  });

  it("leaves a limit unchecked for a blank date or a zero interval", () => {
    expect(legends({ dueDate: "", intervalCycles: 0 })).toEqual([]);
  });

  it("asks for a calendar date and days, and hours in tenths", () => {
    const html = render({ dueDate: "2027-01-01", dueHours: 1 });
    expect(html).toContain("Next due date");
    expect(html).toContain("Repeat every days");
    expect(html).toContain('type="date"');
    expect(html).toContain('min="0.1" step="0.1"');
  });
});
