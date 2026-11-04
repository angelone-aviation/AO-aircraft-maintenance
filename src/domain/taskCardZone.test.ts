/**
 * Responsibility: Pins where a task card's zone is read from and where it ends.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/taskCardZone.ts.
 */
import { expect, it } from "vitest";
import { taskCardZone } from "./taskCardZone";

it("reads bracketed zones from the description before applicability", () => {
  expect(
    taskCardZone({
      description: "Inspect door seals. [Zone: 211A, 211A.]",
      applicability: "Zone: 131",
    }),
  ).toBe("211A, 211A");
});
it("reads a zone on its own description line, ignoring case", () => {
  expect(
    taskCardZone({
      description: "Inspect seals.\nzone: 211A\nCheck for wear.",
      applicability: "",
    }),
  ).toBe("211A");
});
it("reads plural zones and stops at a semicolon or closing bracket", () => {
  const zone = (description: string) =>
    taskCardZone({ description, applicability: "" });
  expect(zone("Panels removed; Zones: 211, 212; reinstall")).toBe("211, 212");
  expect(zone("[Zones: 311 ] Check")).toBe("311");
});
it("falls back to applicability when description has no zone", () => {
  expect(
    taskCardZone({ description: "Inspect seals.", applicability: "Zone: 131" }),
  ).toBe("131");
});
it("reads applicability only from a line that starts with Zone", () => {
  const zone = (applicability: string) =>
    taskCardZone({ description: "Inspect seals.", applicability });
  expect(zone("Model: C208\n  zone: 131 \nSerial: all")).toBe("131");
  expect(zone("Access via Zone: 131")).toBe("");
});
it("leaves missing zones unspecified", () => {
  expect(
    taskCardZone({ description: "Inspect seals.", applicability: "" }),
  ).toBe("");
});
