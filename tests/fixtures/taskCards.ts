import { demoSnapshot } from "../../src/data/demo";
import {
  taskCardDefaults,
  type TaskCardCommand,
} from "../../src/domain/taskCards";
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
