/**
 * Responsibility: Pins the status badge and reasons, the dispatch gate's
 *   markup, and when it blocks a flight.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/AircraftStatus.tsx, react-dom/server,
 *   src/data/demo.ts (seed).
 */
// @vitest-environment node
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { ShownAircraftStatus } from "../domain/aircraftStatus";
import type { Snapshot } from "../domain/model";
import {
  AircraftStatusBadge,
  AircraftStatusReasons,
  AircraftStatusSummary,
  DispatchGate,
  dispatchBlocked,
} from "./AircraftStatus";

const workspace = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../data/store", () => ({ useWorkspace: () => workspace.state }));

const N206 = "demo-206";
const LONG_ENOUGH = "1234567890";

function grounded(admin = true): Snapshot {
  const s = demoSnapshot();
  const i = s.aircraft.findIndex((a) => a.uuid === N206);
  s.aircraft[i] = { ...s.aircraft[i], operationalStatus: "grounded" };
  if (!admin) s.user = { ...s.user, isAdmin: false, groupIds: [] };
  return s;
}

function renderGate(s: Snapshot, aircraftUuid = N206) {
  workspace.state = { snapshot: s };
  return renderToStaticMarkup(
    h(DispatchGate, { aircraftUuid, reason: "", onReason: () => undefined }),
  );
}

const status = (level: ShownAircraftStatus["level"], labels: string[] = []) =>
  ({
    level,
    reasons: labels.map((label, i) => ({ kind: "ad", entityUuid: i, label })),
  }) as unknown as ShownAircraftStatus;

describe("status display", () => {
  it("names each level", () => {
    const badge = (level: ShownAircraftStatus["level"]) =>
      renderToStaticMarkup(h(AircraftStatusBadge, { status: status(level) }));
    expect(badge("airworthy")).toContain(">Airworthy<");
    expect(badge("due-soon")).toContain(">Due soon<");
    expect(badge("grounded")).toContain(">Grounded<");
    expect(badge("setup-incomplete")).toContain(">Setup incomplete<");
    expect(badge("setup-incomplete")).not.toContain("ds-tone-good");
  });

  it("summarizes an aircraft with setup gaps as setup incomplete, naming them", () => {
    workspace.state = { snapshot: demoSnapshot() };
    const html = renderToStaticMarkup(
      h(AircraftStatusSummary, { aircraftUuid: N206, registration: "N206MA" }),
    );
    expect(html).toContain(">Setup incomplete<");
    expect(html).toContain("<li>Components missing</li>");
    expect(html).toContain("<li>ADs not reviewed</li>");
    expect(html).not.toContain(">Airworthy<");
  });

  it("lists reasons in the given order under the label, or nothing", () => {
    const html = renderToStaticMarkup(
      h(AircraftStatusReasons, {
        status: status("grounded", ["B first", "A second"]),
        label: "N1 status reasons",
      }),
    );
    expect(html).toContain('aria-label="N1 status reasons"');
    expect(html.indexOf("B first")).toBeLessThan(html.indexOf("A second"));
    const none = h(AircraftStatusReasons, {
      status: status("airworthy"),
      label: "N1 status reasons",
    });
    expect(renderToStaticMarkup(none)).toBe("");
  });

  it("refuses an aircraft that is not in the snapshot", () => {
    workspace.state = { snapshot: demoSnapshot() };
    const summary = h(AircraftStatusSummary, {
      aircraftUuid: "missing",
      registration: "N0",
    });
    expect(() => renderToStaticMarkup(summary)).toThrow("Aircraft not found.");
    expect(() => renderGate(demoSnapshot(), "missing")).toThrow(
      "Aircraft not found.",
    );
  });
});

describe("dispatchBlocked", () => {
  it("lets any flight through on an aircraft that is not grounded", () => {
    const s = demoSnapshot();
    s.inspections = s.inspections.filter((i) => i.aircraftUuid !== N206);
    expect(dispatchBlocked(s, N206, "")).toBe(false);
  });

  it("needs an administrator's reason of 10 characters after trimming", () => {
    const s = grounded();
    expect(dispatchBlocked(s, N206, "")).toBe(true);
    expect(dispatchBlocked(s, N206, "  123456789  ")).toBe(true);
    expect(dispatchBlocked(s, N206, LONG_ENOUGH)).toBe(false);
  });

  it("blocks a user who may not override, whatever the reason", () => {
    expect(dispatchBlocked(grounded(false), N206, LONG_ENOUGH)).toBe(true);
  });

  it("refuses an aircraft that is not in the snapshot", () => {
    expect(() => dispatchBlocked(demoSnapshot(), "missing", "")).toThrow(
      "Aircraft not found.",
    );
  });
});

describe("DispatchGate", () => {
  it("shows nothing for an aircraft that is not grounded", () => {
    const s = demoSnapshot();
    s.inspections = s.inspections.filter((i) => i.aircraftUuid !== N206);
    expect(renderGate(s)).toBe("");
  });

  it("asks an administrator for an override reason of 10–1000 characters", () => {
    const html = renderGate(grounded());
    expect(html).toContain("is grounded.");
    expect(html).toContain('minLength="10" maxLength="1000" required=""');
    expect(html).not.toContain("Ask a Flight Program administrator");
  });

  it("sends anyone else to an administrator", () => {
    const html = renderGate(grounded(false));
    expect(html).toContain("Ask a Flight Program administrator");
    expect(html).not.toContain("<textarea");
  });
});
