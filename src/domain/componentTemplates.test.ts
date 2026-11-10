/**
 * Responsibility: Pins template CSV parsing, row checks, saving, duplicate
 *   detection, applying a template to an aircraft as setups, and when a
 *   setup is pending or its parent ready.
 * Layer: Test. Vitest suite; never shipped in the build.
 * Dependencies: src/domain/componentTemplates.ts, ./maintenanceCsv,
 *   ./programs, ./rejection, src/data/demo.ts (seed).
 */
import { expect, it } from "vitest";
import { demoSnapshot } from "../data/demo";
import {
  parseComponentTemplateCsv,
  saveComponentTemplate,
  applyComponentTemplate,
  componentDuplicate,
  matchesComponentTemplate,
  pendingComponentSetups,
  setupParentReady,
  validateRows,
} from "./componentTemplates";
import { CSV_MAX_BYTES } from "./maintenanceCsv";
import { scopedSnapshot } from "./programs";
import { Rejection, STALE_RECORD_MESSAGE } from "./rejection";
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
it("reads columns in any order and case, gives rows without an ID one made from their content, and names the failing row", () => {
  const rows = parseComponentTemplateCsv(
    '\uFEFF"component  NAME",Part Number,COMPONENT TYPE,ata chapter\nPump,P-1,Appliance,\nFan,F-1,Appliance,',
  );
  expect(rows.map((r) => [r.id, r.model, r.partNumber])).toEqual([
    ["auto-767a0c41b5426ee8", "Pump", "P-1"],
    ["auto-7a4b9f2aad39253b", "Fan", "F-1"],
  ]);
  const refused = () =>
    parseComponentTemplateCsv(csv.replace("Appliance,72", "Gizmo,72"));
  expect(refused).toThrow(Rejection);
  expect(refused).toThrow(/^CSV row 3: /);
  expect(() => parseComponentTemplateCsv(csv + ",extra")).toThrow(
    "CSV row 3: Column count does not match header.",
  );
  expect(() => parseComponentTemplateCsv(csv.split("\n")[0])).toThrow(
    "Use 1–500 component rows.",
  );
  expect(() =>
    parseComponentTemplateCsv(csv.replace("Position", "Model")),
  ).toThrow(/^Use columns: Component type, .*The first four are required\.$/);
  expect(() =>
    parseComponentTemplateCsv(
      "Component type,ATA chapter,Part number\nEngine,72,E",
    ),
  ).toThrow("The first four are required.");
  expect(() =>
    parseComponentTemplateCsv(csv + "x".repeat(2 * 1024 * 1024)),
  ).toThrow("CSV must be under 2 MB.");
});
it("measures the CSV limit in UTF-8 bytes, up to and including it", () => {
  const atLimit = "é".repeat(CSV_MAX_BYTES / 2);
  const size = "CSV must be under 2 MB.";
  expect(() => parseComponentTemplateCsv(atLimit)).not.toThrow(size);
  expect(() => parseComponentTemplateCsv(atLimit + "x")).toThrow(size);
});
it("refuses duplicate row IDs and unknown parents", () => {
  const [engine, blade] = parseComponentTemplateCsv(csv);
  expect(() => validateRows([engine, { ...blade, id: "engine" }])).toThrow(
    new Rejection("Each row ID must be unique."),
  );
  expect(() => validateRows([engine, { ...blade, parentId: "hub" }])).toThrow(
    "Unknown parent ID: hub",
  );
  expect(() => validateRows([engine, { ...blade, parentId: "hub" }])).toThrow(
    Rejection,
  );
});
it("saves a template with a new version and refuses a stale one", () => {
  const { s, t } = fixture();
  expect(t.version).toBe(1);
  expect(t.programUuid).toBe("demo-program");
  const saved = saveComponentTemplate(s, { ...t, name: "Renamed" });
  expect(saved.version).toBe(2);
  expect(s.componentTemplates).toEqual([saved]);
  const stale = () => saveComponentTemplate(s, t);
  expect(stale).toThrow(Rejection);
  expect(stale).toThrow(STALE_RECORD_MESSAGE);
});
it("records a save with the template before and after, and each setup added", () => {
  const { s, a, t, input } = fixture();
  const logged = s.audit.length;
  const saved = saveComponentTemplate(s, { ...t, name: "Renamed" });
  const added = applyComponentTemplate(s, { ...input, version: 2 });
  const entry = (fields: object) => ({
    uuid: expect.any(String),
    programUuid: "demo-program",
    actorId: s.user.id,
    at: expect.any(Number),
    ...fields,
  });
  expect(s.audit).toHaveLength(logged + 3);
  expect(s.audit.slice(0, 3)).toEqual([
    ...[...added].reverse().map((d) =>
      entry({
        action: "component.setupImported",
        entityUuid: d.uuid,
        aircraftUuid: a.uuid,
        after: JSON.stringify(d),
      }),
    ),
    entry({
      action: "componentTemplate.save",
      entityUuid: t.uuid,
      before: JSON.stringify(t),
      after: JSON.stringify(saved),
    }),
  ]);
});
it("matches make, model and duplicates ignoring case and spaces, but not position", () => {
  const { s, a, t } = fixture();
  expect(
    matchesComponentTemplate(t, {
      make: ` ${a.make.toUpperCase()} `,
      model: a.model.replace(/^/, " "),
    }),
  ).toBe(true);
  const [engine] = t.rows;
  s.management = [
    {
      kind: "component",
      uuid: "installed",
      version: 1,
      aircraftUuid: a.uuid,
      componentType: "engine",
      partNumber: " engine ",
      model: "ENGINE",
      installPosition: "MAIN",
      serial: "1",
      manufacturer: "",
      notes: "",
      installed: true,
      installedDate: "2026-01-01",
      installedSeconds: 0,
      installedCycles: 0,
      timeSinceNew: 0,
      timeSinceOverhaul: null,
      timeSinceRepair: null,
      cyclesSinceNew: 0,
      serviceDaysBase: 0,
      trackTime: true,
      trackCycles: true,
      trackCalendar: true,
    },
  ];
  expect(componentDuplicate(s, a.uuid, engine)).toBe(true);
  expect(
    componentDuplicate(s, a.uuid, { ...engine, installPosition: undefined }),
  ).toBe(false);
});
it("refuses an unknown row and a rotor on an airplane, adding nothing", () => {
  const { s, a, t, input } = fixture();
  expect(() =>
    applyComponentTemplate(s, { ...input, rowIds: ["engine", "hub"] }),
  ).toThrow(new Rejection("Unknown template row."));
  t.rows[0] = { ...t.rows[0], componentType: "Main Rotor" };
  a.helicopter = false;
  const rotor = () => applyComponentTemplate(s, input);
  expect(rotor).toThrow(Rejection);
  expect(rotor).toThrow(
    "Component type does not match this aircraft category.",
  );
  expect(s.componentSetups).toBeUndefined();
});
it("links to the first setup when a row was applied twice (characterizes current behaviour)", () => {
  const { s, input } = fixture();
  const [first] = applyComponentTemplate(s, { ...input, rowIds: ["engine"] });
  s.componentSetups!.push({ ...first, uuid: crypto.randomUUID() });
  const [blade] = applyComponentTemplate(s, { ...input, rowIds: ["blade"] });
  expect(blade.parentComponentUuid).toBe(first.uuid);
});
it("keeps a setup pending until a component has its uuid, and a child until its parent is installed on its aircraft", () => {
  const { s, a, input } = fixture();
  const [engine, blade] = applyComponentTemplate(s, input);
  expect(pendingComponentSetups(s)).toEqual([engine, blade]);
  expect(setupParentReady(s, engine)).toBe(true);
  expect(setupParentReady(s, blade)).toBe(false);
  const installed = (aircraftUuid: string, ready: boolean) =>
    ({
      kind: "component",
      uuid: engine.uuid,
      aircraftUuid,
      installed: ready,
    }) as NonNullable<typeof s.management>[number];
  for (const [aircraftUuid, ready, expected] of [
    [s.aircraft[1].uuid, true, false],
    [a.uuid, false, false],
    [a.uuid, true, true],
  ] as const) {
    s.management = [installed(aircraftUuid, ready)];
    expect(setupParentReady(s, blade)).toBe(expected);
  }
  expect(pendingComponentSetups(s)).toEqual([blade]);
});

const BARE_HEADER = "Component type,ATA chapter,Part number,Component Name";
const BARE_ROWS = [
  "Engine,72,IO-520-F,Engine",
  "Propeller,61,D3A34C401,Propeller",
];
const idsOf = (lines: string[]) =>
  Object.fromEntries(
    parseComponentTemplateCsv([BARE_HEADER, ...lines].join("\n")).map((r) => [
      r.model,
      r.id,
    ]),
  );

it("keeps a row's generated ID when rows are added above it, reordered, or respaced", () => {
  const first = idsOf(BARE_ROWS);
  const edited = idsOf([
    "Appliance,74,10-500556-101,Left magneto",
    BARE_ROWS[1],
    "Engine , 72 ,io-520-f,  ENGINE ",
  ]);
  expect(edited.Propeller).toBe(first.Propeller);
  expect(edited["ENGINE"]).toBe(first.Engine);
  expect(new Set(Object.values(edited)).size).toBe(3);
  // An explicit ID always wins, and rows of the same content stay distinct.
  const twins = parseComponentTemplateCsv(
    `${BARE_HEADER},ID\n${BARE_ROWS[0]},\n${BARE_ROWS[0]},\n${BARE_ROWS[0]},mine`,
  ).map((r) => r.id);
  expect(twins).toEqual([first.Engine, `${first.Engine}-2`, "mine"]);
});
it("recommends a row added to a template without IDs when it is applied again", () => {
  const s = demoSnapshot();
  const a = s.aircraft[0];
  const save = (version: number, uuid: string, lines: string[]) =>
    saveComponentTemplate(s, {
      uuid,
      version,
      name: "C206 components",
      make: a.make,
      model: a.model,
      rows: parseComponentTemplateCsv([BARE_HEADER, ...lines].join("\n")),
    });
  const apply = (t: { uuid: string; version: number }, rowIds: string[]) =>
    applyComponentTemplate(s, {
      templateUuid: t.uuid,
      version: t.version,
      aircraftUuid: a.uuid,
      rowIds,
    });
  const t = save(0, crypto.randomUUID(), BARE_ROWS);
  expect(
    apply(
      t,
      t.rows.map((r) => r.id),
    ),
  ).toHaveLength(2);
  const edited = save(t.version, t.uuid, [
    "Appliance,74,10-500556-101,Left magneto",
    ...BARE_ROWS,
  ]);
  const added = apply(
    edited,
    edited.rows.map((r) => r.id),
  );
  expect(added.map((d) => d.row.model)).toEqual(["Left magneto"]);
});
