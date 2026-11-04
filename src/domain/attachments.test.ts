/**
 * Responsibility: Pins the attachment rules: the 25-attachment cap and its
 *   refusal, and what new evidence does to a signed job card.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/attachments.ts, ./taskCards, ./rejection,
 *   src/data/demo.ts.
 */
import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  assertAttachmentRoom,
  MAX_ATTACHMENTS,
  withNewEvidence,
} from "./attachments";
import { Rejection } from "./rejection";
import { taskCardDefaults, taskCardSchema, type TaskCard } from "./taskCards";

const SIGNED_AT = Date.parse("2026-11-03T15:00:00Z");
const NOW = Date.parse("2026-11-04T12:00:00Z");
const STEP = "0f8b6f3e-5c1d-4a7e-9b2a-3c4d5e6f7a8b";
const FULL = "This record already has the maximum of 25 attachments.";

describe("assertAttachmentRoom", () => {
  it("allows up to 25 attachments on one record", () => {
    expect(MAX_ATTACHMENTS).toBe(25);
    expect(() => assertAttachmentRoom(0)).not.toThrow();
    expect(() => assertAttachmentRoom(MAX_ATTACHMENTS - 1)).not.toThrow();
  });

  it.each([MAX_ATTACHMENTS, MAX_ATTACHMENTS + 1])(
    "refuses another on a record holding %i, as a Rejection",
    (count) => {
      const refuse = () => assertAttachmentRoom(count);
      expect(refuse).toThrow(Rejection);
      expect(refuse).toThrow(FULL);
    },
  );
});

describe("withNewEvidence", () => {
  it("clears every signoff and takes a new version", () => {
    const card = signedCard();
    const original = structuredClone(card);
    expect(withNewEvidence(card, NOW)).toStrictEqual({
      ...original,
      technicianSignoff: null,
      inspectionSignoff: null,
      stepSignoffs: {},
      version: original.version + 1,
      updatedAt: NOW,
    });
    expect(card).toStrictEqual(original);
  });

  it("keeps the stored key order, so the saved payload is unchanged", () => {
    // convex/taskCards.ts clears the stored card in place today; when it
    // adopts this rule (T3 b2), the JSON it saves must stay the same.
    const card = signedCard();
    const inPlace = structuredClone(card);
    inPlace.technicianSignoff = null;
    inPlace.inspectionSignoff = null;
    inPlace.stepSignoffs = {};
    inPlace.version++;
    inPlace.updatedAt = NOW;
    expect(JSON.stringify(withNewEvidence(card, NOW))).toBe(
      JSON.stringify(inPlace),
    );
  });
});

// A job card as stored, signed by a technician, an inspector and on a step.
function signedCard(): TaskCard {
  const signature = { userId: "technician", name: "Tech", at: SIGNED_AT };
  return taskCardSchema.parse({
    ...taskCardDefaults(demoSnapshot().aircraft[0].uuid),
    title: "Check pressure",
    status: "awaiting-inspection",
    uuid: crypto.randomUUID(),
    version: 3,
    createdAt: SIGNED_AT,
    createdBy: "technician",
    updatedAt: SIGNED_AT,
    technicianSignoff: signature,
    inspectionSignoff: { ...signature, userId: "inspector", name: "Insp" },
    stepSignoffs: { [STEP]: signature },
  });
}
