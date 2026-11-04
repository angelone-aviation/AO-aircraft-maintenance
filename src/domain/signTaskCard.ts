/**
 * Responsibility: Signs a task card from the app, recording today as its
 *   completion date first when the signoff needs one.
 * Layer: Domain. Command sequencing over an injected submit; no direct I/O.
 * Dependencies: ./taskCards, ./model.
 */
import {
  taskCardFieldsSchema,
  type TaskCard,
  type TaskCardCommand,
} from "./taskCards";
import { localDate } from "./model";

/**
 * Signs a task card. Technician and inspection signoffs need a completion
 * date, so a card without one is first saved with today's local date and the
 * signature expects the next version; step signoffs are sent as they are.
 *
 * @param card - The card as last read.
 * @param kind - The signoff to record.
 * @param submit - Sends one task card command; each is awaited in turn.
 * @param stepUuid - The step to sign, for a step signoff.
 * @param now - The clock that sets today's date.
 * @throws Whatever `submit` rejects with; a failed save sends no signature.
 */
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
