/**
 * Responsibility: Pins the request id field: optional, and a UUID when sent.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/commandRequest.ts, ./checklists, ./engineTrends,
 *   ./airworthiness, ./costs, ./taskCards, ./deferrals, zod.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestUuidField } from "./commandRequest";
import { checklistCommandSchema, emptyChecklist } from "./checklists";
import { engineTrendCommandSchema } from "./engineTrends";
import { adCommandSchema, blankAD } from "./airworthiness";
import { costCommandSchema } from "./costs";
import { taskCardCommandSchema } from "./taskCards";
import { deferCommandSchema } from "./deferrals";

const REQUEST_UUID = "6b0a9d1e-2c3f-4a5b-8c7d-9e0f1a2b3c4d";
const schema = z.object(requestUuidField);

describe("requestUuidField", () => {
  it("keeps a UUID and allows none, while clients without ids remain", () => {
    expect(schema.parse({ requestUuid: REQUEST_UUID })).toEqual({
      requestUuid: REQUEST_UUID,
    });
    expect(schema.parse({})).toEqual({});
  });

  it.each(["", "request-1", 42])("refuses %j as a request id", (id) => {
    expect(schema.safeParse({ requestUuid: id }).success).toBe(false);
  });

  it("is part of the checklist, engine trend and AD commands", () => {
    const checklist = {
      record: {
        uuid: crypto.randomUUID(),
        version: 0,
        programUuid: "demo-program",
        aircraftUuid: "",
        sourceName: "test.fmd",
        updatedAt: 0,
        updatedBy: "",
        document: emptyChecklist(),
      },
      baseVersion: 0,
      requestUuid: REQUEST_UUID,
    };
    const trend = {
      action: "remove",
      uuid: crypto.randomUUID(),
      requestUuid: REQUEST_UUID,
    };
    const ad = {
      kind: "import",
      aircraftUuid: "aircraft-1",
      entries: [
        {
          source: { ...blankAD("aircraft-1").source, number: "2026-01-01" },
          componentUuid: "",
        },
      ],
      requestUuid: REQUEST_UUID,
    };
    expect(checklistCommandSchema.parse(checklist).requestUuid).toBe(
      REQUEST_UUID,
    );
    expect(engineTrendCommandSchema.parse(trend).requestUuid).toBe(
      REQUEST_UUID,
    );
    expect(adCommandSchema.parse(ad).requestUuid).toBe(REQUEST_UUID);
  });

  it("is part of the cost, job-card and deferral commands", () => {
    const cost = {
      action: "settings.laborRate",
      laborRateCents: 9500,
      requestUuid: REQUEST_UUID,
    };
    const card = {
      action: "sign",
      uuid: crypto.randomUUID(),
      version: 0,
      kind: "technician",
      requestUuid: REQUEST_UUID,
    };
    const deferral = {
      uuid: "report-1",
      deferredOn: "2026-01-01",
      deferral: { type: "91.213d", placard: "INOP", notHazard: true },
      requestUuid: REQUEST_UUID,
    };
    expect(costCommandSchema.parse(cost).requestUuid).toBe(REQUEST_UUID);
    expect(taskCardCommandSchema.parse(card).requestUuid).toBe(REQUEST_UUID);
    expect(deferCommandSchema.parse(deferral).requestUuid).toBe(REQUEST_UUID);
  });
});
