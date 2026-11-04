/**
 * Responsibility: Pins when the calendar exemption reason is required and
 *   how the last change is credited.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/CalendarExemptionFields.tsx,
 *   react-dom/server, src/data/demo.ts (seed).
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Inspection } from "../domain/model";
import { CalendarExemptionFields } from "./CalendarExemptionFields";

const s = demoSnapshot();
const CHANGED_AT = Date.parse("2026-10-02T12:00:00Z");

function render(record?: Partial<Inspection>) {
  const inspection = record && { ...s.inspections[0], ...record };
  return renderToStaticMarkup(
    h(CalendarExemptionFields, { record: inspection, members: s.members }),
  );
}

it("requires a reason only while the inspection is exempt", () => {
  const fresh = render();
  expect(fresh).not.toContain("checked");
  expect(fresh).toContain(
    '<textarea name="calendarExemptReason" maxLength="5000"',
  );
  const exempt = render({ calendarExempt: true, calendarExemptReason: "Ref" });
  expect(exempt).toContain('checked=""');
  expect(exempt).toContain('required="" maxLength="5000"');
  expect(exempt).toContain(">Ref</textarea>");
});

it("credits the last change to the member, or to an unknown id as is", () => {
  const changed = { calendarExemptChangedAt: CHANGED_AT };
  const by = (id: string) =>
    render({ ...changed, calendarExemptChangedBy: id });
  expect(by(s.members[0].id)).toContain(`by ${s.members[0].name}</p>`);
  expect(by("gone")).toContain("by gone</p>");
  expect(render({ calendarExemptChangedBy: "gone" })).not.toContain(
    "Last changed",
  );
});
