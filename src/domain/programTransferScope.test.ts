/**
 * Responsibility: Pins that an aircraft transfer moves only that aircraft's
 *   checklists and pending component setups, and leaves the fleet's others
 *   in the source program, unversioned and out of the moved set.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/programTransfers.ts, checklists.ts,
 *   componentTemplates.ts, model.ts, src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import { emptyChecklist, type ChecklistRecord } from "./checklists";
import {
  componentTemplateRowSchema,
  type ComponentSetup,
} from "./componentTemplates";
import { transferProgram } from "./programTransfers";

const SOURCE = "demo-program";
const DESTINATION = "other";

it("moves the aircraft's own checklists and component setups, and no other aircraft's", () => {
  const s = demoSnapshot();
  const [moving, staying] = s.aircraft;
  s.programs = [
    ...s.programs!,
    { ...s.programs![0], uuid: DESTINATION, name: "Other" },
  ];
  s.checklists = [
    checklist("list-moving", moving.uuid),
    checklist("list-staying", staying.uuid),
  ];
  s.componentSetups = [
    setup("setup-moving", moving.uuid),
    setup("setup-staying", staying.uuid),
  ];
  const moved = transferProgram(s, {
    kind: "aircraft",
    uuid: moving.uuid,
    destination: DESTINATION,
    reason: "Base move",
  });
  expect(s.checklists.map((c) => [c.uuid, c.programUuid, c.version])).toEqual([
    ["list-moving", DESTINATION, 2],
    ["list-staying", SOURCE, 1],
  ]);
  expect(s.componentSetups.map((d) => [d.uuid, d.programUuid])).toEqual([
    ["setup-moving", DESTINATION],
    ["setup-staying", SOURCE],
  ]);
  expect(moved).toContain("list-moving");
  expect(moved).toContain("setup-moving");
  expect(moved).not.toContain("list-staying");
  expect(moved).not.toContain("setup-staying");
});

function checklist(uuid: string, aircraftUuid: string): ChecklistRecord {
  return {
    uuid,
    version: 1,
    programUuid: SOURCE,
    aircraftUuid,
    sourceName: "",
    updatedAt: 1,
    updatedBy: "",
    document: emptyChecklist(),
  };
}

function setup(uuid: string, aircraftUuid: string): ComponentSetup {
  return {
    uuid,
    programUuid: SOURCE,
    aircraftUuid,
    templateUuid: "template",
    templateName: "C441",
    row: componentTemplateRowSchema.parse({
      id: "engine-left",
      componentType: "Engine",
      partNumber: "PT6A-112",
      model: "PT6A",
    }),
  };
}
