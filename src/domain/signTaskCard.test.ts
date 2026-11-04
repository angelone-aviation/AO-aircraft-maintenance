/**
 * Responsibility: Pins signing a task card: the recorded completion date, the
 *   version the signature expects, and what is sent for steps and failures.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/signTaskCard.ts, ./taskCards, src/data/demo.ts,
 *   tests/fixtures/taskCards.ts.
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import {
  saveTaskCard,
  taskCardFieldsSchema,
  type TaskCardCommand,
} from "./taskCards";
import { signTaskCard } from "./signTaskCard";

const now = Date.parse("2026-10-01T12:00:00Z");
for (const date of ["", "2026-09-30"]) {
  it(`signs with ${date || "an automatically recorded date"}`, async () => {
    const state = demoSnapshot();
    const command = taskCardCommand();
    let card = saveTaskCard(state, command, now);
    card = saveTaskCard(
      state,
      {
        ...command,
        version: card.version,
        fields: {
          ...taskCardFieldsSchema.parse(card),
          status: "in-progress",
          completionDate: date,
          actualLabor: null,
          steps: [],
        },
      },
      now,
    );
    await signTaskCard(
      card,
      "technician",
      async (next) => {
        card = saveTaskCard(state, next, now);
      },
      undefined,
      now,
    );
    expect(card.completionDate).toBe(date || "2026-10-01");
    expect(card.actualLabor).toBeNull();
    expect(card.technicianSignoff?.at).toBe(now);
    const version = card.version;
    // Inspection signoff must come from someone other than the technician,
    // with a certificate on file.
    state.user = {
      ...state.user,
      id: "inspector",
      name: "Inspector",
      licenseNumber: "3456789",
      certificateType: "A&P IA",
    };
    await signTaskCard(
      card,
      "inspection",
      async (next) => {
        card = saveTaskCard(state, next, now + 1000);
      },
      undefined,
      now + 1000,
    );
    expect(card.version).toBe(version + 1);
    expect(card.technicianSignoff?.at).toBe(now);
    expect(card.inspectionSignoff?.at).toBe(now + 1000);
  });
}

it("sends a step signoff without a completion date as it is", async () => {
  const card = saveTaskCard(demoSnapshot(), taskCardCommand(), now);
  const sent: TaskCardCommand[] = [];
  const stepUuid = crypto.randomUUID();
  await signTaskCard(card, "step", async (c) => void sent.push(c), stepUuid);
  expect(sent).toEqual([
    {
      action: "sign",
      uuid: card.uuid,
      version: card.version,
      kind: "step",
      stepUuid,
    },
  ]);
});

it("sends no signature when saving the completion date fails", async () => {
  const card = saveTaskCard(demoSnapshot(), taskCardCommand(), now);
  const sent: TaskCardCommand[] = [];
  const failing = async (c: TaskCardCommand) => {
    sent.push(c);
    throw new Error("Offline.");
  };
  await expect(
    signTaskCard(card, "inspection", failing, undefined, now),
  ).rejects.toThrow("Offline.");
  expect(sent.map((c) => c.action)).toEqual(["save"]);
});
