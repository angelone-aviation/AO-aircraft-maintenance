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
it("falls back to applicability when description has no zone", () => {
  expect(
    taskCardZone({ description: "Inspect seals.", applicability: "Zone: 131" }),
  ).toBe("131");
});
it("leaves missing zones unspecified", () => {
  expect(
    taskCardZone({ description: "Inspect seals.", applicability: "" }),
  ).toBe("");
});
