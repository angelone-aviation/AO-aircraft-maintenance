/**
 * Responsibility: Pins which components the movement panel offers and when
 *   it lets a movement be added. Adding and saving need a browser:
 *   tests/e2e/requested-component-movement.spec.ts covers them.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/components/RequestedComponentMovement.tsx,
 *   src/data/demo.ts (demoSnapshot), react-dom/server.
 */
// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import type { Snapshot } from "../domain/model";
import type { ComponentWork } from "../domain/workOrderComponentWork";
import { RequestedComponentMovement } from "./RequestedComponentMovement";

// The panel opens on a click, so the component's first two states (the open
// flag and the draft) are seeded; every other useState is React's own.
let seeds: unknown[] = [];
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const useState = (init: unknown) =>
    seeds.length ? [seeds.shift(), () => {}] : react.useState(init);
  return { ...react, useState };
});

const base = demoSnapshot();
const program = base.aircraft[0].programUuid;
const onAircraft = {
  kind: "component",
  uuid: "on",
  version: 1,
  programUuid: program,
  installed: true,
  aircraftUuid: base.aircraft[0].uuid,
  componentType: "Starter",
  serial: "S1",
  partNumber: "P-ON",
};
const location = {
  kind: "location",
  uuid: "loc",
  name: "Hangar",
  programUuid: program,
};
const snapshot = (withLocation: boolean) =>
  ({
    ...base,
    management: withLocation ? [onAircraft, location] : [onAircraft],
  }) as Snapshot;
const draft = (extra: object) => ({
  selected: "on",
  position: "MAIN",
  location: "",
  shelf: "",
  description: "Worn",
  ...extra,
});
const render = (
  s: Snapshot,
  choices: object[],
  draftState: object = draft({}),
) => {
  seeds = [true, draftState];
  return renderToStaticMarkup(
    createElement(RequestedComponentMovement, {
      s,
      aircraftUuid: base.aircraft[0].uuid,
      choices: choices as ComponentWork[],
      onAdd: () => {},
    }),
  );
};
const addDisabled = (s: Snapshot, draftState: object) =>
  /<button type="button" class="button" disabled="">Add component/.test(
    render(s, [], draftState),
  );

describe("RequestedComponentMovement", () => {
  it("does not offer a component already given non-service work", () => {
    const work = (action: string) => [{ componentUuid: "on", action }];
    expect(render(snapshot(true), work("repair"))).not.toContain("P-ON");
    expect(render(snapshot(true), work("service"))).toContain("P-ON");
  });

  it("needs a reason before a movement can be added", () => {
    const s = snapshot(false);
    expect(addDisabled(s, draft({ shelf: "B1", description: " " }))).toBe(true);
    expect(addDisabled(s, draft({ shelf: "B1" }))).toBe(false);
  });

  it("needs a known location for a removal, or a shelf without locations", () => {
    expect(addDisabled(snapshot(true), draft({ shelf: "B1" }))).toBe(true);
    expect(addDisabled(snapshot(true), draft({ location: "loc" }))).toBe(false);
    expect(addDisabled(snapshot(false), draft({ shelf: " " }))).toBe(true);
  });
});
