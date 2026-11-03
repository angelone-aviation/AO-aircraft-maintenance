import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  parseComponentTemplateCsv,
  saveComponentTemplate,
  applyComponentTemplate,
} from "./componentTemplates";
import { scopedSnapshot } from "./programs";
const csv =
  'Component type,ATA chapter,Part number,Component Name,Manufacturer,Position,ID,Parent ID\nEngine,72,ENGINE,Engine,Maker,MAIN,engine,\nAppliance,72,BLADE,"Blade, assembly",Maker,,blade,engine';
function fixture() {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const t = saveComponentTemplate(s, {
    uuid: crypto.randomUUID(),
    version: 0,
    name: "Recommended components",
    make: a.make,
    model: a.model,
    rows: parseComponentTemplateCsv(csv),
  });
  return {
    s,
    a,
    t,
    input: {
      templateUuid: t.uuid,
      version: t.version,
      aircraftUuid: a.uuid,
      rowIds: ["engine", "blade"],
    },
  };
}
it("parses quoted rows and rejects malformed columns, invalid ATA and cyclic parent links", () => {
  expect(parseComponentTemplateCsv(csv)[1].model).toBe("Blade, assembly");
  expect(() =>
    parseComponentTemplateCsv(csv.replace("Component Name", "Serial")),
  ).toThrow();
  expect(() =>
    parseComponentTemplateCsv(csv.replace("Engine,72", "Engine,ZZ")),
  ).toThrow();
  expect(() =>
    parseComponentTemplateCsv(csv.replace("MAIN,engine,", "MAIN,engine,blade")),
  ).toThrow("cycle");
});
it("creates blank setup entries, preserves parent links, and repeated application is idempotent", () => {
  const { s, input } = fixture();
  const before = structuredClone(s.management);
  const added = applyComponentTemplate(s, input);
  expect(added).toHaveLength(2);
  expect(added[1].parentComponentUuid).toBe(added[0].uuid);
  expect(s.management).toEqual(before);
  expect(added[0]).not.toHaveProperty("serial");
  expect(added[0]).not.toHaveProperty("timeSinceNew");
  expect(applyComponentTemplate(s, input)).toEqual([]);
});
it("rejects stale templates, wrong aircraft models, missing parents, duplicate rows and unauthorized users without partial imports", () => {
  const { s, a, t, input } = fixture();
  expect(() => applyComponentTemplate(s, { ...input, version: 0 })).toThrow(
    "changed",
  );
  expect(() =>
    applyComponentTemplate(s, { ...input, rowIds: ["blade"] }),
  ).toThrow("parent");
  expect(s.componentSetups).toBeUndefined();
  a.model = "Other";
  expect(() => applyComponentTemplate(s, input)).toThrow("match");
  a.model = t.model;
  t.rows[1] = { ...t.rows[0], id: "blade" };
  expect(() => applyComponentTemplate(s, input)).toThrow("duplicate");
  expect(s.componentSetups).toBeUndefined();
  s.user.isAdmin = false;
  s.user.groupIds = [];
  expect(() => applyComponentTemplate(s, input)).toThrow();
});
it("scopes templates and setup recommendations to the active program and aircraft access", () => {
  const { s, t, input } = fixture();
  applyComponentTemplate(s, input);
  s.componentTemplates!.push({
    ...t,
    uuid: crypto.randomUUID(),
    programUuid: "other",
  });
  s.componentSetups!.push({
    ...s.componentSetups![0],
    uuid: crypto.randomUUID(),
    programUuid: "other",
  });
  const scoped = scopedSnapshot(s);
  expect(scoped.componentTemplates).toHaveLength(1);
  expect(scoped.componentSetups).toHaveLength(2);
});
