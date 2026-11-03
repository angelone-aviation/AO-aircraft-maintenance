import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { taskCardCommand } from "../../tests/fixtures/taskCards";
import { saveTaskCard, taskCardFieldsSchema } from "./taskCards";
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
