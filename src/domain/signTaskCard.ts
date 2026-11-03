import {
  taskCardFieldsSchema,
  type TaskCard,
  type TaskCardCommand,
} from "./taskCards";
import { localDate } from "./model";

export async function signTaskCard(
  card: TaskCard,
  kind: "technician" | "inspection" | "step",
  submit: (command: TaskCardCommand) => Promise<unknown>,
  stepUuid?: string,
  now = Date.now(),
) {
  let version = card.version;
  if (kind !== "step" && !card.completionDate) {
    await submit({
      action: "save",
      uuid: card.uuid,
      version,
      fields: {
        ...taskCardFieldsSchema.parse(card),
        completionDate: localDate(now),
      },
    });
    version++;
  }
  await submit({ action: "sign", uuid: card.uuid, version, kind, stepUuid });
}
