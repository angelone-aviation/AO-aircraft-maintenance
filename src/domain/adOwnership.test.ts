/**
 * Responsibility: Pins which aircraft a component AD applies to.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/adOwnership.ts, airworthiness.ts;
 *   tests/fixtures/workOrders.ts (fixture).
 */
import { expect, it } from "vitest";
import { workOrderComponent } from "../../tests/fixtures/workOrders";
import { adAircraftUuid } from "./adOwnership";
import { blankAD } from "./airworthiness";

it("follows the component while it is installed, and otherwise keeps the AD's aircraft", () => {
  const engine = workOrderComponent();
  const ad = { ...blankAD("demo-208"), componentUuid: engine.uuid };
  expect(engine.aircraftUuid).toBe("demo-206");
  expect(adAircraftUuid({ management: [engine] }, ad)).toBe("demo-206");
  for (const management of [
    [{ ...engine, installed: false }],
    [{ ...engine, aircraftUuid: "" }],
    [{ ...engine, uuid: "other-engine" }],
    undefined,
  ])
    expect(adAircraftUuid({ management }, ad)).toBe("demo-208");
});
