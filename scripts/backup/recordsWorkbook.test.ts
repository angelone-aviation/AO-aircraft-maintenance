/**
 * Responsibility: Pins the records workbook built from the fixture export:
 *   sheets, labels, dates, statuses, layout, what it never shows, the change
 *   history split, damaged records and the command line.
 * Layer: Test. Vitest suite (Node); never shipped in the build.
 * Dependencies: scripts/backup/recordsWorkbook.ts, ./exportFixture, exceljs,
 *   fflate, src/domain/auditHistory.
 */
// @vitest-environment node
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditActionLabel } from "../../src/domain/auditHistory";
import { fixtureExport } from "./exportFixture";
import { buildRecordsWorkbook, zoneClock } from "./recordsWorkbook";

const TZ = "America/New_York";
process.env.TZ = TZ;
const now = Date.now();
const fixture = fixtureExport(now);
let dir: string, zipPath: string, outPath: string;
let wb: ExcelJS.Workbook;

const HEADERS: Record<string, string[]> = {
  Aircraft: [
    "Tail number",
    "Make and model",
    "Serial number",
    "Flight Program",
    "Total time (h)",
    "Hobbs (h)",
    "Tach (h)",
    "Cycles",
    "Landings",
    "Status",
    "Why",
    "Next item due",
    "Last flight",
  ],
  "Due list": [
    "Status",
    "Aircraft",
    "Type",
    "Item",
    "Detail",
    "Due date",
    "Due at",
    "Days left",
    "Hours left",
    "Cycles left",
    "Landings left",
  ],
  "Flight log": [
    "Date and time",
    "Aircraft",
    "Pilot",
    "Copilot",
    "Route",
    "Hobbs start",
    "Hobbs end",
    "Tach start",
    "Tach end",
    "Hours",
    "Landings",
    "Cycles",
    "Oil added",
    "Review status",
    "Notes",
  ],
  Discrepancies: [
    "Reported",
    "Reported by",
    "Aircraft",
    "Description",
    "Grounding",
    "Deferral",
    "Deferral expires",
    "Status",
    "Resolved by",
    "Resolved",
    "Resolution",
  ],
  "Work orders": [
    "Work order",
    "Aircraft",
    "Opened",
    "Closed",
    "Status",
    "Priority",
    "Summary",
    "Requested work",
    "Job cards and sign-offs",
    "Performed by",
    "Parts used",
    "Labour hours",
  ],
  "Airworthiness directives": [
    "AD number",
    "Aircraft",
    "Applies to",
    "Subject",
    "Applicability",
    "Status",
    "Method of compliance",
    "Last complied",
    "Last complied at (h)",
    "Complied by",
    "Next due",
    "Next due at (h)",
    "Recurring",
  ],
  Components: [
    "Aircraft or location",
    "Component",
    "Part number",
    "Serial number",
    "Position",
    "Time since new (h)",
    "Time since overhaul (h)",
    "Cycles since new",
    "Limit",
    "Due at",
    "Hours left",
    "Cycles left",
    "Days left",
    "Status",
  ],
  Inventory: [
    "Part number",
    "Description",
    "Category",
    "Condition",
    "Location",
    "Quantity",
    "Reserved",
    "Minimum",
    "Expires",
    "Shelf life",
    "Unit cost (USD)",
    "Value (USD)",
    "Vendor",
    "Invoice or PO",
    "Flight Program",
  ],
  "Purchase orders": [
    "Number",
    "Vendor",
    "Status",
    "Created",
    "Issued",
    "Expected",
    "Items",
    "Total",
    "Currency",
    "For aircraft",
    "Flight Program",
  ],
  "Maintenance costs": [
    "Work order",
    "Aircraft",
    "Status",
    "Opened",
    "Labour hours",
    "Labour (USD)",
    "Parts (USD)",
    "Other (USD)",
    "Total (USD)",
    "Notes",
  ],
  "People and access": [
    "Name",
    "Email",
    "Account",
    "System administrator",
    "Flight Programs",
    "Groups, permissions and aircraft",
  ],
  "Change history": [
    "When",
    "Who",
    "Flight Program",
    "Aircraft",
    "Record",
    "Action",
    "Reason",
    "What changed",
    "Full before and after",
  ],
};
const RED = "FFF8D7DA",
  AMBER = "FFFFF3CD",
  GREEN = "FFD1E7DD";

const text = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "richText" in v)
    return v.richText.map((r) => r.text).join("");
  return String(v);
};
const sheet = (name: string) => {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`Missing sheet ${name}`);
  return ws;
};
const header = (ws: ExcelJS.Worksheet) =>
  (ws.getRow(2).values as ExcelJS.CellValue[]).slice(1).map(text);
// Data rows as objects keyed by header.
function rows(name: string) {
  const ws = sheet(name);
  const keys = header(ws);
  const out: { cells: Record<string, ExcelJS.Cell>; row: ExcelJS.Row }[] = [];
  ws.eachRow((row, n) => {
    if (n < 3) return;
    out.push({
      row,
      cells: Object.fromEntries(keys.map((k, i) => [k, row.getCell(i + 1)])),
    });
  });
  return out;
}
const fill = (c: ExcelJS.Cell) =>
  (c.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;
// Changes a document of an export table in place: the first, or the first
// that `pick` matches.
function editFirst(
  files: Record<string, Uint8Array>,
  table: string,
  change: (d: Record<string, unknown>) => void,
  pick: (d: Record<string, unknown>) => boolean = () => true,
) {
  const name = `${table}/documents.jsonl`;
  const docs: Record<string, unknown>[] = strFromU8(files[name])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  change(docs.find(pick)!);
  files[name] = strToU8(docs.map((d) => JSON.stringify(d)).join("\n") + "\n");
}
async function buildFrom(files: Record<string, Uint8Array>, name: string) {
  const zip = path.join(dir, `${name}.zip`);
  const out = path.join(dir, `${name}.xlsx`);
  await writeFile(zip, zipSync(files));
  const summary = await buildRecordsWorkbook(zip, {
    out,
    timeZone: TZ,
    deployment: "fixture",
    now,
  });
  const read = new ExcelJS.Workbook();
  await read.xlsx.readFile(out);
  return { summary, read, out };
}

function allCells() {
  const cells: { sheet: string; column: string; value: string }[] = [];
  wb.eachSheet((ws) => {
    const keys = header(ws);
    ws.eachRow((row) =>
      row.eachCell((c, col) =>
        cells.push({
          sheet: ws.name,
          column: keys[col - 1] ?? "",
          value: text(c.value),
        }),
      ),
    );
  });
  return cells;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "records-workbook-"));
  zipPath = path.join(dir, "export.zip");
  outPath = path.join(dir, "records.xlsx");
  await writeFile(zipPath, fixture.zip);
  await buildRecordsWorkbook(zipPath, {
    out: outPath,
    timeZone: TZ,
    deployment: "fixture deployment",
    now,
  });
  wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outPath);
  // WRITE_SAMPLE=1 npx vitest run scripts/backup/recordsWorkbook.test.ts
  if (process.env.WRITE_SAMPLE)
    await copyFile(
      outPath,
      path.resolve(
        __dirname,
        "../../docs/samples/angel-one-records-sample.xlsx",
      ),
    );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("records workbook", () => {
  it("has every sheet in order, each with a title and its headers", () => {
    expect(wb.worksheets.map((ws) => ws.name)).toEqual([
      "Read me",
      ...Object.keys(HEADERS),
    ]);
    for (const [name, headers] of Object.entries(HEADERS)) {
      const ws = sheet(name);
      expect(text(ws.getCell("A1").value)).toContain(name);
      expect(text(ws.getCell("A1").value)).toContain("Eastern Time");
      expect(header(ws)).toEqual(headers);
    }
  });

  it("explains itself on Read me", () => {
    const readMe = allCells()
      .filter((c) => c.sheet === "Read me")
      .map((c) => c.value)
      .join("\n");
    expect(readMe).toContain("aircraft logbooks and the encrypted backup");
    expect(readMe).toContain("for reading only");
    expect(readMe).toContain("fixture deployment");
    expect(readMe).toContain("Eastern Time (America/New_York)");
    expect(readMe).toContain("3 uploaded files");
    const ws = sheet("Read me");
    const counts = new Map<string, number>();
    ws.eachRow((row) => {
      const name = text(row.getCell(1).value);
      if (HEADERS[name]) counts.set(name, Number(row.getCell(3).value));
    });
    expect(counts.get("Flight log")).toBe(rows("Flight log").length);
    expect(counts.get("Change history")).toBe(rows("Change history").length);
    expect(counts.get("Aircraft")).toBe(3);
  });

  it("shows tail numbers, names and programs instead of IDs", () => {
    const aircraft = rows("Aircraft");
    expect(aircraft.map((r) => text(r.cells["Tail number"].value))).toEqual([
      "N182MA",
      "N206MA",
      "N208MA",
    ]);
    expect(text(aircraft[0].cells["Flight Program"].value)).toBe(
      "Coastal outreach",
    );
    const flights = rows("Flight log");
    expect(flights.map((r) => text(r.cells.Pilot.value))).toContain(
      "Jordan Lee",
    );
    const people = rows("People and access");
    const sam = people.find((p) => text(p.cells.Name.value) === "Sam Rivera")!;
    expect(text(sam.cells["Groups, permissions and aircraft"].value)).toBe(
      "Mission operations: Aircraft owners (aircraft owner) · read · N206MA",
    );
    const morgan = people.find(
      (p) => text(p.cells.Name.value) === "Morgan Patel",
    )!;
    expect(text(morgan.cells.Account.value)).toBe("Disabled");
    const history = rows("Change history");
    const who = history.map((r) => text(r.cells.Who.value));
    expect(who).toContain("Casey Nguyen");
    expect(who).toContain("The system (automatic)");
    expect(history.map((r) => text(r.cells.Record.value))).toContain(
      "(unknown record)",
    );
    const parts = rows("Work orders").find(
      (r) => text(r.cells["Work order"].value) === "WO-2026-0007",
    )!;
    expect(text(parts.cells["Performed by"].value)).toBe("Casey Nguyen");
    expect(text(parts.cells["Job cards and sign-offs"].value)).toContain(
      "Inspection signed by Riley Chen",
    );
    expect(text(parts.cells["Parts used"].value)).toContain(
      "1 × CH48110-1 Oil filter",
    );
    expect(parts.cells["Labour hours"].value).toBe(7.5);
    // No ID of a known record appears anywhere, and no UUID outside the
    // full before-and-after detail.
    const ids = Object.values(fixture.ids).flat();
    for (const c of allCells()) {
      for (const id of ids) expect(c.value).not.toContain(id);
      if (c.column !== "Full before and after")
        expect(c.value).not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
    }
  });

  it("writes real Excel dates and numbers in the chosen time zone", () => {
    const clock = zoneClock(TZ);
    const flights = rows("Flight log");
    for (const f of flights)
      expect(f.cells["Date and time"].value).toBeInstanceOf(Date);
    const held = flights.find(
      (f) => text(f.cells["Review status"].value) === "Needs review",
    )!;
    const startTime = Date.parse(
      new Date(
        Math.floor((now - 86_400_000) / 86_400_000) * 86_400_000 +
          9 * 3_600_000,
      ).toISOString(),
    );
    expect(held.cells["Date and time"].value).toEqual(
      clock.dateTime(startTime),
    );
    expect(held.cells["Date and time"].numFmt).toBe("mmm d, yyyy hh:mm");
    expect(held.cells.Hours.value).toBeNull();
    const accepted = flights.find(
      (f) => text(f.cells["Review status"].value) === "Accepted",
    )!;
    expect(typeof accepted.cells["Hobbs end"].value).toBe("number");
    expect(accepted.cells["Hobbs end"].numFmt).toBe("#,##0.0");
    for (const r of rows("Change history"))
      expect(r.cells.When.value).toBeInstanceOf(Date);
    const due = rows("Due list").filter((r) => r.cells["Due date"].value);
    expect(due.length).toBeGreaterThan(0);
    for (const r of due) expect(r.cells["Due date"].value).toBeInstanceOf(Date);
  });

  it("uses the app's status rules and highlights overdue and due-soon rows", () => {
    const aircraft = Object.fromEntries(
      rows("Aircraft").map((r) => [text(r.cells["Tail number"].value), r]),
    );
    expect(text(aircraft.N208MA.cells.Status.value)).toBe("Grounded");
    expect(fill(aircraft.N208MA.cells.Status)).toBe(RED);
    expect(text(aircraft.N208MA.cells.Why.value)).toContain("overdue");
    expect(text(aircraft.N206MA.cells.Status.value)).toBe("Due soon");
    expect(fill(aircraft.N206MA.cells["Tail number"])).toBe(AMBER);
    expect(text(aircraft.N182MA.cells.Status.value)).toBe("Airworthy");
    expect(fill(aircraft.N182MA.cells.Status)).toBe(GREEN);
    expect(fill(aircraft.N182MA.cells["Tail number"])).toBeUndefined();

    const due = rows("Due list");
    const levels = due.map((r) => fill(r.cells.Status));
    // Most urgent first: every red row before every amber row.
    expect(levels.lastIndexOf(RED)).toBeLessThan(levels.indexOf(AMBER));
    const overdue = due.filter((r) =>
      ["Overdue", "Past due", "Due now"].includes(text(r.cells.Status.value)),
    );
    expect(overdue.map((r) => text(r.cells.Item.value))).toEqual(
      expect.arrayContaining([
        "Altimeter, static and transponder checks (91.411, 91.413)",
        "ELT battery P/N 452-0133 S/N EB-20231",
      ]),
    );
    for (const r of overdue)
      for (const c of Object.values(r.cells)) expect(fill(c)).toBe(RED);
    const hundred = due.find(
      (r) =>
        text(r.cells.Aircraft.value) === "N206MA" &&
        text(r.cells.Item.value) === "100-hour inspection",
    )!;
    expect(text(hundred.cells.Status.value)).toBe("Due soon");
    expect(fill(hundred.cells.Detail)).toBe(AMBER);
    expect(hundred.cells["Hours left"].value).toBeCloseTo(8.8, 5);

    const stock = rows("Inventory");
    const sealant = stock.find(
      (r) => text(r.cells["Part number"].value) === "PR-1422-B2",
    )!;
    expect(text(sealant.cells["Shelf life"].value)).toBe("Expired");
    expect(fill(sealant.cells.Description)).toBe(RED);
    expect(sealant.cells["Unit cost (USD)"].value).toBe(68);

    const history = rows("Change history");
    expect(history.map((r) => text(r.cells.Action.value))).toContain(
      auditActionLabel("discrepancy.created"),
    );
    const when = history.map((r) => (r.cells.When.value as Date).getTime());
    expect(when).toEqual([...when].sort((a, b) => b - a));
    const transferred = history.find(
      (r) =>
        text(r.cells.Reason.value) === "Annual completed; next due recorded.",
    )!;
    expect(text(transferred.cells["Flight Program"].value)).toBe(
      "Mission operations\nAlso listed in Coastal outreach after a transfer",
    );
    expect(text(transferred.cells["What changed"].value)).toMatch(
      /^Due date: [A-Z][a-z]{2} \d{1,2}, \d{4} → [A-Z][a-z]{2} \d{1,2}, \d{4}$/,
    );
  });

  it("is set up to read and print", () => {
    for (const name of Object.keys(HEADERS)) {
      const ws = sheet(name);
      expect(ws.autoFilter).toBeTruthy();
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
      expect(ws.pageSetup).toMatchObject({
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: "1:2",
      });
      expect(ws.headerFooter.oddFooter).toContain("Page &P of &N");
      ws.eachRow((row) =>
        row.eachCell((c) => expect(c.formula).toBeUndefined()),
      );
    }
    expect(sheet("Read me").autoFilter).toBeTruthy();
  });

  it("never includes sign-in data, credentials, stored files or links", async () => {
    // The raw XML, not only cell values: nothing may hide in the file.
    const xml = Object.values(unzipSync(await readFile(outPath)))
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    for (const secret of fixture.forbidden) expect(xml).not.toContain(secret);
    expect(xml).not.toContain("enc:");
    expect(xml).not.toContain("$argon2");
    const people = rows("People and access");
    expect(people.map((r) => text(r.cells.Name.value)).sort()).toEqual([
      "Alex Morgan",
      "Casey Nguyen",
      "Jordan Lee",
      "Morgan Patel",
      "Riley Chen",
      "Sam Rivera",
      "Taylor Brooks",
    ]);
    const linked = rows("Change history").find(
      (r) => text(r.cells.Action.value) === "Spruce · account · linked",
    )!;
    expect(text(linked.cells["What changed"].value)).toBe("Notes: [hidden]");
    const upload = rows("Change history").find(
      (r) => text(r.cells.Action.value) === "Manual · upload",
    )!;
    expect(text(upload.cells["What changed"].value)).toBe(
      "Title: Model 206 service manual\nFile: [file]\nLink: [link removed]",
    );
  });

  it("splits the change history across sheets when it exceeds the row limit", async () => {
    const out = path.join(dir, "split.xlsx");
    const summary = await buildRecordsWorkbook(zipPath, {
      out,
      timeZone: TZ,
      deployment: "fixture",
      now,
      maxRowsPerSheet: 5,
    });
    const parts = summary.sheets.filter((s) =>
      s.name.startsWith("Change history"),
    );
    const total = rows("Change history").length;
    expect(parts.length).toBe(Math.ceil(total / 5));
    expect(parts[0].name).toBe(`Change history 1 of ${parts.length}`);
    expect(parts.reduce((n, s) => n + s.rows, 0)).toBe(total);
    const split = new ExcelJS.Workbook();
    await split.xlsx.readFile(out);
    let readMe = "";
    split
      .getWorksheet("Read me")!
      .eachRow((row) => row.eachCell((c) => (readMe += text(c.value) + "\n")));
    expect(readMe).toContain(`split across ${parts.length} sheets`);
  });

  it("shows a record that no longer matches the app as stored, with a note, and drops characters XML cannot hold", async () => {
    const files = unzipSync(fixture.zip);
    const edit = (
      table: string,
      change: (d: Record<string, unknown>) => void,
    ) => editFirst(files, table, change);
    edit("management", (d) => {
      d.payload = JSON.stringify({
        ...JSON.parse(String(d.payload)),
        name: "",
      });
    });
    edit("discrepancies", (d) => {
      d.description = "Tab\tkept\u0001, \ud83d\ude00 kept, lone \ud83d dropped";
    });
    const damaged = path.join(dir, "damaged.zip");
    const out = path.join(dir, "damaged.xlsx");
    await writeFile(damaged, zipSync(files));
    const summary = await buildRecordsWorkbook(damaged, {
      out,
      timeZone: TZ,
      deployment: "fixture",
      now,
    });
    expect(summary.warnings).toEqual([
      "1 inventory and component record did not match the app's current format; shown as stored on the Damaged records sheet.",
    ]);
    const read = new ExcelJS.Workbook();
    await read.xlsx.readFile(out);
    const descriptions: string[] = [];
    read
      .getWorksheet("Discrepancies")!
      .eachRow((row) => row.eachCell((c) => descriptions.push(text(c.value))));
    expect(descriptions).toContain(
      "Tab\tkept, \ud83d\ude00 kept, lone  dropped",
    );
  });

  it("lists each damaged record as stored, with its note, and builds every other sheet", async () => {
    const files = unzipSync(fixture.zip);
    const storageId = Object.keys(files)
      .find((f) => /^_storage\/[^/]+$/.test(f) && !f.endsWith(".jsonl"))!
      .slice("_storage/".length);
    const payload = (
      table: string,
      change: (p: Record<string, unknown>) => void,
    ) =>
      editFirst(files, table, (d) => {
        const p = JSON.parse(String(d.payload));
        change(p);
        d.payload = JSON.stringify(p);
      });
    // Each crashed the build before (finding 48).
    editFirst(files, "management", (d) => {
      d.payload = `{"kind":"stock","file":"${storageId}","link":"https://x.convex.cloud/a`;
    });
    editFirst(
      files,
      "management",
      (d) =>
        (d.payload = JSON.stringify({
          ...JSON.parse(String(d.payload)),
          name: {},
        })),
      (d) => String(d.payload).includes("FIXTURE-ACCOUNT"),
    );
    payload("airworthiness", (p) => delete p.tasks);
    payload("workOrders", (p) => (p.dateOpened = {}));
    editFirst(files, "taskCards", (d) => delete d.payload);
    payload("purchaseOrders", (p) => {
      delete p.lines;
      p.url = `https://x.convex.cloud/api/storage/${storageId}`;
    });
    const { summary, read, out } = await buildFrom(files, "damaged-each");
    const format = (n: string) =>
      `${n} did not match the app's current format; shown as stored on the Damaged records sheet.`;
    expect(summary.warnings).toEqual(
      [
        "2 inventory and component records",
        "1 AD record",
        "1 work order record",
        "1 job card record",
        "1 purchase order record",
      ].map(format),
    );
    expect(summary.sheets.map((s) => s.name)).toEqual([
      ...wb.worksheets.map((ws) => ws.name),
      "Damaged records",
    ]);
    const ws = read.getWorksheet("Damaged records")!;
    expect(header(ws)).toEqual(["Record type", "Note", "As stored"]);
    const listed: string[][] = [];
    ws.eachRow((row, n) => {
      if (n > 2) listed.push([1, 2, 3].map((c) => text(row.getCell(c).value)));
    });
    const MISMATCH = "Does not match the app's current format.";
    expect(listed.map(([type, note]) => [type, note])).toEqual([
      ["Inventory and component", "Not JSON; shown as the stored text."],
      ["Inventory and component", MISMATCH],
      ["AD", MISMATCH],
      ["Work order", MISMATCH],
      ["Job card", "The row has no payload."],
      ["Purchase order", MISMATCH],
    ]);
    expect(listed[0][2]).toBe(
      '{"kind":"stock","file":"[file]","link":"[link removed]',
    );
    expect(listed[1][2]).toContain("\nName:\n");
    expect(listed[1][2]).not.toContain("Account number");
    expect(listed[2][2]).toContain("\nAircraft: N206MA\n");
    expect(listed[2][2]).toContain("\n  Number: 2024-DEMO-03\n");
    expect(listed[2][2]).not.toContain("Tasks");
    expect(listed[3][2]).toMatch(/^Number: WO-2026-0007\n.*\nDate opened:\n/s);
    expect(listed[3][2]).not.toContain("License number");
    expect(listed[4][2]).toBe("(no payload)");
    expect(listed[5][2]).not.toContain("Url");
    const xml = Object.values(unzipSync(await readFile(out)))
      .map((bytes) => strFromU8(bytes))
      .join("\n");
    for (const secret of fixture.forbidden) expect(xml).not.toContain(secret);
  });

  it("runs from the command line and fails clearly on a bad export", async () => {
    const script = path.resolve(__dirname, "records-workbook.mjs");
    const out = path.join(dir, "cli.xlsx");
    const ok = spawnSync(
      process.execPath,
      [script, "--zip", zipPath, "--out", out, "--tz", TZ],
      { encoding: "utf8" },
    );
    expect(ok.stderr).toBe("");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("Change history");
    const check = new ExcelJS.Workbook();
    await check.xlsx.readFile(out);
    expect(check.worksheets.length).toBe(wb.worksheets.length);

    const bad = path.join(dir, "bad.zip");
    await writeFile(bad, "not a zip");
    const failed = spawnSync(
      process.execPath,
      [script, "--zip", bad, "--out", path.join(dir, "bad.xlsx")],
      { encoding: "utf8" },
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("The export is not a ZIP file.");
    // Spawns node and bundles the workbook with esbuild: seconds of work that
    // pass vitest's 5 s default only on an idle machine.
  }, 30_000);
});
