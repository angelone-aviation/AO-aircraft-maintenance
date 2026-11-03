// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { PreflightMaintenance } from "./PreflightMaintenance";

it("shows only inspections needing review and excludes archived and other-aircraft data", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  s.discrepancies = [];
  s.workOrders = [];
  const base = { aircraftUuid: a.uuid, description: "" };
  s.inspections = [
    { ...base, uuid: "due", reference: "OVERDUE", dueDate: "2000-01-01" },
    { ...base, uuid: "missing", reference: "MISSING-DATA" },
    { ...base, uuid: "ok", reference: "NOT-DUE", dueDate: "2099-01-01" },
    { ...base, uuid: "archived", reference: "ARCHIVED", archived: true },
    {
      ...base,
      uuid: "other",
      reference: "OTHER-AIRCRAFT",
      aircraftUuid: "other",
    },
  ];
  const html = renderToStaticMarkup(
    createElement(PreflightMaintenance, { aircraft: a, snapshot: s }),
  );
  expect(html).toContain("OVERDUE");
  expect(html).toContain("MISSING-DATA");
  expect(html).not.toContain("NOT-DUE");
  expect(html).not.toContain("ARCHIVED");
  expect(html).not.toContain("OTHER-AIRCRAFT");
  expect(html).not.toContain("Open discrepancies");
  expect(html).not.toContain("Open work orders");
});

it("distinguishes no review items from missing inspection schedules", () => {
  const s = demoSnapshot();
  const a = { ...s.aircraft[0], operationalStatus: "airworthy" as const };
  s.discrepancies = [];
  s.workOrders = [];
  s.inspections = [
    {
      uuid: "ok",
      aircraftUuid: a.uuid,
      reference: "CURRENT",
      description: "",
      dueDate: "2099-01-01",
    },
  ];
  const render = () =>
    renderToStaticMarkup(
      createElement(PreflightMaintenance, { aircraft: a, snapshot: s }),
    );
  expect(render()).toContain("No due inspections or items needing review");
  expect(render()).not.toContain("CURRENT");
  s.inspections = [];
  expect(render()).toContain("Not recorded");
  expect(render()).not.toContain("No due inspections or items needing review");
});
