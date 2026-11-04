/**
 * Responsibility: Pins which fuel and oil fields each flight phase asks for,
 *   the default oil readings, and when the summary shows a burn rate.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/FlightFluids.tsx, src/data/demo.ts
 *   (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Flight } from "../domain/model";
import { FlightFluidFields, FlightFluidSummary } from "./FlightFluids";

const snapshot = demoSnapshot();
vi.mock("../data/store", () => ({ useWorkspace: () => ({ snapshot }) }));

type FieldsProps = ComponentProps<typeof FlightFluidFields>;
const labels = (props: Partial<FieldsProps>) =>
  [
    ...renderToStaticMarkup(
      createElement(FlightFluidFields, {
        fluids: {},
        onChange: () => {},
        ...props,
      }),
    ).matchAll(/<label[^>]*>([^<]*)</g),
  ].map((m) => m[1]);

const ACCEPTED: Flight = {
  ...snapshot.flights[0],
  status: "accepted",
  fuel: { unit: "US gal", start: 80, added: 0, end: 50 },
  hobbsOff: 0,
  hobbsOn: 7200,
};
const summary = (flight: Flight, withAircraft = true) =>
  renderToStaticMarkup(
    createElement(FlightFluidSummary, {
      flight,
      aircraft: withAircraft
        ? { ...snapshot.aircraft[0], meter: "hobbs", counterEvents: [] }
        : undefined,
    }),
  );

describe("FlightFluidFields", () => {
  it("asks for every fuel level and the oil's start and additions", () => {
    expect(labels({})).toEqual([
      "Fuel unit",
      "Fuel starting level (US gal)",
      "Fuel quantity added (US gal)",
      "Fuel shutdown level (US gal)",
      "Engine oil unit",
      "Engine oil starting level (US qt)",
      "Engine oil quantity added (US qt)",
    ]);
  });

  it("starts a twin with left and right engine oil", () => {
    const oil = labels({ twin: true }).filter((l) => l.endsWith(" oil unit"));
    expect(oil).toEqual(["Left engine oil unit", "Right engine oil unit"]);
  });

  it("asks for starting levels and additions before flight", () => {
    expect(labels({ phase: "preflight" })).not.toContain(
      "Fuel shutdown level (US gal)",
    );
  });

  it("asks for the fuel's shutdown level alone at shutdown", () => {
    expect(labels({ phase: "shutdown", twin: true })).toEqual([
      "Fuel unit",
      "Fuel shutdown level (US gal)",
    ]);
  });

  it("labels range oil levels as ranges and additions in their unit", () => {
    const fluids = {
      oil: [{ engine: "single" as const, unit: "range" as const }],
    };
    expect(labels({ fluids })).toEqual(
      expect.arrayContaining([
        "Engine oil quantity added unit",
        "Engine oil starting level (range)",
        "Engine oil quantity added (US qt)",
      ]),
    );
  });
});

describe("FlightFluidSummary", () => {
  it("shows the fuel burn per meter hour once accepted", () => {
    expect(summary(ACCEPTED)).toContain("15.00 US gal/hr (Hobbs)");
    expect(summary({ ...ACCEPTED, status: "review" })).not.toContain("/hr");
  });

  it("shows no burn rate without the aircraft", () => {
    expect(summary(ACCEPTED, false)).not.toContain("/hr");
  });

  it("shows a dash when no fluids were recorded", () => {
    const flight = { ...ACCEPTED, fuel: undefined, oil: undefined };
    expect(summary({ ...flight, checklistRun: undefined })).toBe("—");
  });
});
