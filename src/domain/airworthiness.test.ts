import { describe, it, expect, vi } from "vitest";
import { demoSnapshot } from "../data/demo";
import { parseADTables } from "../data/adImport";
import tables from "../../tests/fixtures/ad-report-tables.json";
import {
  adAuditRecord,
  adSchema,
  adStatus,
  adTaskStatus,
  applyADCommand,
  blankAD,
  blankADTask,
  type ADCompliance,
} from "./airworthiness";
import { fetchDrsCandidates, mergeCandidates } from "./faa";
import { aircraftStatus } from "./aircraftStatus";
import { localDate } from "./model";
import { scopedSnapshot } from "./programs";
import { workSources } from "./workOrders";
function setup() {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-01-01";
  r.source.subject = "Inspection";
  r.source.recurring = "Yes";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect",
      intervalHours: 100,
      dueHours: 2400,
      recurrence: "Recurring",
    },
  ];
  applyADCommand(s, { kind: "save", record: r });
  return { s, r: s.airworthiness![0] };
}
const entry = (taskUuid: string): ADCompliance => ({
  uuid: crypto.randomUUID(),
  taskUuid,
  date: "2026-01-01",
  hours: 2340,
  cycles: 1890,
  method: "Inspected per paragraph (g)",
  serviceBulletin: "SB 1",
  terminatedBy: "",
  workOrderUuid: "",
  mechanic: "Test mechanic",
  certificate: "12345",
  evidence: "Logbook page 42",
  recordedAt: 0,
  recordedBy: "",
});
describe("AD report import and compliance", () => {
  it("parses all 51 actual report entries and flags circular references without inventing compliance", () => {
    const p = parseADTables(tables);
    expect(p.registration).toBe("N626KB");
    expect(p.entries).toHaveLength(51);
    expect(p.entries.filter((e) => e.section === "Engine")).toHaveLength(20);
    expect(p.entries.filter((e) => e.section === "Propeller")).toHaveLength(2);
    expect(p.warnings.some((w) => w.includes("circular"))).toBe(true);
  });
  it("reimports idempotently, flags changed source, and preserves compliance and due limits", () => {
    const { s, r } = setup();
    applyADCommand(s, {
      kind: "comply",
      uuid: r.uuid,
      version: r.version,
      entry: entry(r.tasks[0].uuid),
    });
    const current = s.airworthiness![0];
    expect(current.tasks[0].dueHours).toBe(2440);
    expect(current.history[0].recordedBy).toBe(s.user.id);
    const cmd = {
      kind: "import" as const,
      aircraftUuid: r.aircraftUuid,
      entries: [{ source: current.source, componentUuid: "" }],
    };
    expect(applyADCommand(s, cmd)).toHaveLength(0);
    applyADCommand(s, {
      ...cmd,
      entries: [
        { source: { ...r.source, subject: "Changed" }, componentUuid: "" },
      ],
    });
    expect(s.airworthiness![0].history).toHaveLength(1);
    expect(s.airworthiness![0].sourceHistory).toHaveLength(1);
    expect(s.airworthiness![0].tasks[0].dueHours).toBe(2440);
    expect(adStatus(s, s.airworthiness![0])).toBe("Needs review");
  });
  it("rejects stale, unauthorized, cross-aircraft and forged history changes", () => {
    const { s, r } = setup();
    expect(() =>
      applyADCommand(s, { kind: "save", record: { ...r, version: 0 } }),
    ).toThrow("changed");
    applyADCommand(s, {
      kind: "save",
      record: { ...r, history: [entry(r.tasks[0].uuid)] },
      reason: "Corrected from the AD paragraph",
    });
    expect(s.airworthiness![0].history).toHaveLength(0);
    s.user.isAdmin = false;
    s.user.groupIds = [];
    expect(() =>
      applyADCommand(s, { kind: "save", record: s.airworthiness![0] }),
    ).toThrow("permission");
    expect(scopedSnapshot(s).airworthiness).toEqual([]);
  });
  it("requires reason for not applicable and prevents unknown recurrence from becoming complied", () => {
    const { s, r } = setup();
    expect(() =>
      applyADCommand(s, {
        kind: "save",
        record: { ...r, applicability: "Not applicable" },
        reason: "Corrected from the AD paragraph",
      }),
    ).toThrow("reason this AD is not applicable");
    r.tasks[0].intervalHours = null;
    applyADCommand(s, {
      kind: "save",
      record: r,
      reason: "Corrected from the AD paragraph",
    });
    applyADCommand(s, {
      kind: "comply",
      uuid: r.uuid,
      version: s.airworthiness![0].version,
      entry: entry(r.tasks[0].uuid),
    });
    expect(adStatus(s, s.airworthiness![0])).toBe("Due not set");
  });
  it("exposes reviewed AD actions to aircraft work orders and evaluates overdue thresholds", () => {
    const { s, r } = setup();
    expect(
      workSources(s, r.aircraftUuid).some(
        (x) => x.source.kind === "airworthiness",
      ),
    ).toBe(true);
    expect(
      workSources(s, s.aircraft[1].uuid).some(
        (x) => x.source.kind === "airworthiness",
      ),
    ).toBe(false);
    r.tasks[0].dueHours = 2000;
    expect(adStatus(s, r)).toBe("Overdue");
    r.reviewRequired = true;
    expect(adStatus(s, r)).toBe("Needs review");
  });
  it("does not mutate history on invalid compliance and requires counters for recurrence", () => {
    const { s, r } = setup();
    expect(() =>
      applyADCommand(s, {
        kind: "comply",
        uuid: r.uuid,
        version: r.version,
        entry: { ...entry(r.tasks[0].uuid), hours: null },
      }),
    ).toThrow("counter");
    expect(r.history).toHaveLength(0);
    expect(() =>
      adSchema.parse({ ...r, tasks: [{ ...r.tasks[0], intervalDays: -1 }] }),
    ).toThrow();
  });
});
const doc = (id: string, modified = "2026-01-01") => ({
  documentGuid: id,
  "drs:documentNumber": "2026-01-01",
  "drs:status": "Current",
  docLastModifiedDate: modified,
  documentURL: "https://drs.faa.gov/browse/test",
  "drs:adfrawdSubject": "Inspect",
  "drs:adfrawdMake": ["Textron"],
  "drs:adfrawdModel": ["441"],
});
it("checks both final and emergency ADs, paginates, and preserves review only for unchanged candidates", async () => {
  const request = vi.fn<typeof fetch>();
  request
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          summary: { hasMoreItems: true },
          documents: [doc("1")],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          summary: { hasMoreItems: false },
          documents: [doc("2")],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ summary: { hasMoreItems: false }, documents: [] }),
      ),
    );
  const result = await fetchDrsCandidates("test-key", ["441"], request);
  expect(result).toHaveLength(2);
  expect(JSON.parse(request.mock.calls[1][1]!.body as string).offset).toBe(1);
  expect(request.mock.calls[2][0]).toContain("ADFREAD");
  const reviewed = { ...result[0], reviewReason: "Checked applicability" };
  expect(mergeCandidates([reviewed], result)[0].reviewReason).toBe(
    "Checked applicability",
  );
  expect(
    mergeCandidates([reviewed], [{ ...result[0], modified: "2026-02-01" }])[0]
      .reviewReason,
  ).toBe("");
});
it("fails closed on authentication and malformed FAA responses", async () => {
  await expect(
    fetchDrsCandidates(
      "bad",
      ["441"],
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 403 })),
    ),
  ).rejects.toThrow("API key");
  await expect(
    fetchDrsCandidates(
      "key",
      ["441"],
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ errorMessage: "error" })),
        ),
    ),
  ).rejects.toThrow("Unexpected");
});
it("keeps component AD history with the installed component and flags unavailable counters", () => {
  const { s } = setup();
  const component: import("./components").Component = {
    uuid: "engine-1",
    version: 1,
    kind: "component",
    aircraftUuid: s.aircraft[0].uuid,
    componentType: "Engine",
    partNumber: "PN1",
    serial: "SN1",
    manufacturer: "Example",
    notes: "",
    trackTime: true,
    trackCycles: true,
    trackCalendar: false,
    installed: true,
    installedSeconds: s.aircraft[0].currentHobbs,
    installedCycles: s.aircraft[0].cycles,
    timeSinceNew: 360000,
    timeSinceOverhaul: null,
    timeSinceRepair: null,
    cyclesSinceNew: 10,
    serviceDaysBase: 0,
  };
  s.management = [component];
  const r = blankAD(s.aircraft[0].uuid, "Engine");
  r.source.number = "2026-02-01";
  r.componentUuid = component.uuid;
  r.source.recurring = "Yes";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    { ...blankADTask(), description: "Inspect engine", dueHours: 200 },
  ];
  applyADCommand(s, { kind: "save", record: r });
  component.aircraftUuid = s.aircraft[1].uuid;
  component.installedSeconds = s.aircraft[1].currentHobbs;
  component.installedCycles = s.aircraft[1].cycles;
  expect(
    workSources(s, s.aircraft[1].uuid).some(
      (x) => x.source.uuid === r.tasks[0].uuid,
    ),
  ).toBe(true);
  component.trackTime = false;
  expect(
    adStatus(
      s,
      s.airworthiness!.find((x) => x.uuid === r.uuid)!,
    ),
  ).toBe("Counter unavailable");
  component.installed = false;
  expect(
    adStatus(
      s,
      s.airworthiness!.find((x) => x.uuid === r.uuid)!,
    ),
  ).toBe("Removed component");
});

it("validates PCW historical time/date, preserves it on FAA changes, and retains recurring scheduling", () => {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid);
  r.source.number = "2026-02-02";
  r.source.subject = "Historical compliance";
  r.applicability = "Previously Complied With (PCW)";
  r.reviewRequired = false;
  expect(() => applyADCommand(s, { kind: "save", record: r })).toThrow(
    "previous compliance date",
  );
  r.priorCompliance = {
    date: "2025-01-01",
    aircraftHours: null,
    componentHours: null,
  };
  expect(() => applyADCommand(s, { kind: "save", record: r })).toThrow(
    "total time",
  );
  r.priorCompliance.aircraftHours = 1234.5;
  applyADCommand(s, { kind: "save", record: r });
  expect(adStatus(s, s.airworthiness![0])).toBe("Due not set");
  const saved = s.airworthiness![0];
  saved.source.recurring = "No";
  expect(adStatus(s, saved)).toBe("Previously Complied With (PCW)");
  saved.source.recurring = "Yes";
  saved.tasks = [
    {
      ...blankADTask(),
      description: "Repeat inspection",
      recurrence: "Recurring",
      dueHours: 1,
    },
  ];
  expect(adStatus(s, saved)).toBe("Overdue");
  expect(
    workSources(s, saved.aircraftUuid).some(
      (x) => x.source.kind === "airworthiness",
    ),
  ).toBe(true);
  applyADCommand(s, {
    kind: "import",
    aircraftUuid: saved.aircraftUuid,
    entries: [
      {
        source: { ...saved.source, subject: "Updated source" },
        componentUuid: "",
      },
    ],
  });
  expect(s.airworthiness![0].priorCompliance?.aircraftHours).toBe(1234.5);
  expect(adStatus(s, s.airworthiness![0])).toBe("Needs review");
});

it("records superseded ADs without losing history and reopens review on source changes", () => {
  const { s, r } = setup();
  applyADCommand(s, {
    kind: "comply",
    uuid: r.uuid,
    version: r.version,
    entry: entry(r.tasks[0].uuid),
  });
  const draft = structuredClone(s.airworthiness![0]);
  draft.applicability = "Superseded";
  expect(() =>
    applyADCommand(s, {
      kind: "save",
      record: draft,
      reason: "Corrected from the AD paragraph",
    }),
  ).toThrow("superseding AD");
  draft.source.supersededBy = "2026-03-01";
  applyADCommand(s, {
    kind: "save",
    record: draft,
    reason: "Corrected from the AD paragraph",
  });
  expect(adStatus(s, s.airworthiness![0])).toBe("Superseded");
  expect(s.airworthiness![0].history).toHaveLength(1);
  expect(
    workSources(s, r.aircraftUuid).some(
      (x) => x.source.kind === "airworthiness",
    ),
  ).toBe(false);
  applyADCommand(s, {
    kind: "import",
    aircraftUuid: r.aircraftUuid,
    entries: [
      {
        source: { ...draft.source, subject: "Changed FAA source" },
        componentUuid: "",
      },
    ],
  });
  expect(adStatus(s, s.airworthiness![0])).toBe("Needs review");
  expect(s.airworthiness![0].history).toHaveLength(1);
});
it("rejects AD compliance hours or cycles beyond the current totals", () => {
  const { s, r } = setup();
  const comply = (patch: Partial<ADCompliance>) =>
    applyADCommand(s, {
      kind: "comply",
      uuid: r.uuid,
      version: r.version,
      entry: { ...entry(r.tasks[0].uuid), ...patch },
    });
  // Demo aircraft totals: 2341.2 h and 1894 cycles.
  expect(() => comply({ hours: 2400 })).toThrow("cannot exceed");
  expect(() => comply({ cycles: 1895 })).toThrow("cannot exceed");
  expect(s.airworthiness![0].history).toHaveLength(0);
  comply({ hours: 2341.2, cycles: 1894 });
  expect(s.airworthiness![0].tasks[0].dueHours).toBeCloseTo(2441.2);
});
it("reports a passed due date as overdue before an unavailable component counter", () => {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid, "Engine");
  r.componentUuid = "missing-component";
  r.tasks = [
    {
      ...blankADTask(),
      description: "Inspect engine",
      dueHours: 200,
      dueDate: "2026-01-01",
    },
  ];
  expect(adTaskStatus(s, r, r.tasks[0], "2026-06-01")).toBe("Overdue");
  expect(adTaskStatus(s, r, r.tasks[0], "2025-06-01")).toBe(
    "Counter unavailable",
  );
});
it("requires an http(s) AD source link on save and import but still reads stored links", () => {
  const { s, r } = setup();
  const record = { ...r, source: { ...r.source, url: "javascript:alert(1)" } };
  expect(() => applyADCommand(s, { kind: "save", record })).toThrow(
    "http:// or https://",
  );
  expect(() =>
    applyADCommand(s, {
      kind: "import",
      aircraftUuid: r.aircraftUuid,
      entries: [{ source: record.source, componentUuid: "" }],
    }),
  ).toThrow("http:// or https://");
  expect(adSchema.parse(record).source.url).toBe("javascript:alert(1)");
  applyADCommand(s, {
    kind: "save",
    record: { ...r, source: { ...r.source, url: "https://drs.faa.gov/x" } },
    reason: "Corrected from the AD paragraph",
  });
  expect(s.airworthiness![0].source.url).toBe("https://drs.faa.gov/x");
});
it("clears one-time initial limits when a recurring action is complied with", () => {
  const { s, r } = setup();
  const today = localDate();
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
    .toISOString()
    .slice(0, 10);
  // Initial limits: a date, a cycle count and landings, none of them repeating.
  const draft = structuredClone(r);
  Object.assign(draft.tasks[0], {
    dueDate: yesterday,
    dueCycles: 1900,
    dueLandings: 2300,
  });
  applyADCommand(s, {
    kind: "save",
    record: draft,
    reason: "Corrected from the AD paragraph",
  });
  const saved = s.airworthiness![0];
  expect(adStatus(s, saved)).toBe("Overdue");
  applyADCommand(s, {
    kind: "comply",
    uuid: r.uuid,
    version: saved.version,
    entry: {
      ...entry(r.tasks[0].uuid),
      date: today,
      hours: 2341.2,
      cycles: 1894,
    },
  });
  const done = s.airworthiness![0];
  // The repeating hours limit advances from the completion.
  expect(done.tasks[0]).toMatchObject({
    dueDate: "",
    dueCycles: null,
    dueLandings: null,
  });
  expect(done.tasks[0].dueHours).toBeCloseTo(2441.2);
  expect(adTaskStatus(s, done, done.tasks[0], today)).toBe("Scheduled");
  expect(adStatus(s, done)).toBe("Scheduled");
  expect(
    aircraftStatus(s, done.aircraftUuid, today).reasons,
  ).not.toContainEqual(expect.objectContaining({ kind: "ad" }));
});
it("advances a repeating calendar limit and keeps it alongside repeating hours", () => {
  const { s, r } = setup();
  const draft = structuredClone(r);
  Object.assign(draft.tasks[0], { dueDate: "2026-01-15", intervalDays: 30 });
  applyADCommand(s, {
    kind: "save",
    record: draft,
    reason: "Corrected from the AD paragraph",
  });
  applyADCommand(s, {
    kind: "comply",
    uuid: r.uuid,
    version: s.airworthiness![0].version,
    entry: { ...entry(r.tasks[0].uuid), date: "2026-01-10", hours: 2340 },
  });
  expect(s.airworthiness![0].tasks[0]).toMatchObject({
    dueDate: "2026-02-09",
    dueHours: 2440,
    dueCycles: null,
  });
});
it("audits an AD's due limits and latest compliance without its full history", () => {
  const { s, r } = setup();
  const e = entry(r.tasks[0].uuid);
  applyADCommand(s, {
    kind: "comply",
    uuid: r.uuid,
    version: r.version,
    entry: e,
  });
  const done = s.airworthiness![0];
  const audited = adAuditRecord(done);
  expect(audited).not.toHaveProperty("history");
  expect(audited).not.toHaveProperty("sourceHistory");
  expect(audited).toMatchObject({
    applicability: "Applicable",
    reviewRequired: false,
    tasks: [{ dueHours: 2440, intervalHours: 100 }],
    complianceEntries: 1,
    latestCompliance: { uuid: e.uuid, method: e.method },
    priorSourceVersions: 0,
  });
});
it("ranks an overdue action above an unavailable counter on the AD", () => {
  const s = demoSnapshot();
  const r = blankAD(s.aircraft[0].uuid, "Engine");
  r.componentUuid = "missing-component";
  r.applicability = "Applicable";
  r.reviewRequired = false;
  r.tasks = [
    { ...blankADTask(), description: "Inspect engine", dueHours: 200 },
    { ...blankADTask(), description: "Replace seal", dueDate: "2026-01-01" },
  ];
  expect(adTaskStatus(s, r, r.tasks[0])).toBe("Counter unavailable");
  expect(adTaskStatus(s, r, r.tasks[1])).toBe("Overdue");
  expect(adStatus(s, r)).toBe("Overdue");
});
