/**
 * Responsibility: A save command for a new job card with one measured step.
 * Layer: Test. Fixture over the demo seed.
 * Dependencies: src/data/demo (demoSnapshot), src/domain/taskCards
 *   (taskCardDefaults, TaskCardCommand).
 */
import { demoSnapshot } from "../../src/data/demo";
import {
  taskCardDefaults,
  type TaskCardCommand,
} from "../../src/domain/taskCards";

/**
 * A save for a new card, "Check pressure", on the demo's first aircraft, with
 * one step that needs a signoff and a measurement of 10 to 20 psi.
 * @returns A fresh command with new card and step ids on each call.
 */
export function taskCardCommand(): Extract<
  TaskCardCommand,
  { action: "save" }
> {
  return {
    action: "save",
    uuid: crypto.randomUUID(),
    version: 0,
    fields: {
      ...taskCardDefaults(demoSnapshot().aircraft[0].uuid),
      title: "Check pressure",
      steps: [
        {
          uuid: crypto.randomUUID(),
          instruction: "Measure pressure",
          requiredResult: "Within specified range",
          result: "",
          measurementRequired: true,
          measurement: null,
          units: "psi",
          lowerLimit: 10,
          upperLimit: 20,
          signoffRequired: true,
        },
      ],
    },
  };
}
