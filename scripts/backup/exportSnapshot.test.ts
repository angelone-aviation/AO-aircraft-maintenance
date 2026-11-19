/**
 * Responsibility: Pins how an export is decoded for the records copy: damaged
 *   payload rows are left out of the snapshot and listed in order, and a
 *   damaged label row still gets its label.
 * Layer: Test. Vitest suite (Node); never shipped in the build.
 * Dependencies: scripts/backup/exportSnapshot.ts, ./exportFixture, fflate.
 */
// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixtureExport } from "./exportFixture";
import { readExportSnapshot } from "./exportSnapshot";

const now = Date.now();
const files = unzipSync(fixtureExport(now).zip);
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "export-snapshot-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function documents(table: string): Record<string, unknown>[] {
  return strFromU8(files[`${table}/documents.jsonl`])
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function read(tables: Record<string, Record<string, unknown>[]>) {
  const zip = path.join(dir, `${crypto.randomUUID()}.zip`);
  const edited = { ...files };
  for (const [table, docs] of Object.entries(tables))
    edited[`${table}/documents.jsonl`] = strToU8(
      docs.map((d) => JSON.stringify(d)).join("\n") + "\n",
    );
  await writeFile(zip, zipSync(edited));
  return readExportSnapshot(zip, now);
}

it("leaves damaged rows out and lists them in collection, then row, order", async () => {
  const stock = documents("management");
  const ads = documents("airworthiness");
  const uuid = (d: Record<string, unknown>) =>
    (JSON.parse(String(d.payload)) as { uuid: string }).uuid;
  const lost = [uuid(stock[1]), uuid(stock[2])];
  stock[1].payload = "{";
  stock[2].payload = JSON.stringify({ kind: "stock" });
  delete ads[0].payload;
  const { snapshot, damaged } = await read({
    airworthiness: ads,
    management: stock,
  });
  expect(damaged).toEqual([
    {
      collection: "management",
      payload: { kind: "text", text: "{" },
      issues: [],
    },
    {
      collection: "management",
      payload: { kind: "json", value: { kind: "stock" } },
      issues: expect.arrayContaining([
        { path: ["uuid"], message: expect.any(String) },
      ]),
    },
    { collection: "airworthiness", payload: { kind: "missing" }, issues: [] },
  ]);
  expect(snapshot.management).toHaveLength(stock.length - 2);
  expect(snapshot.management!.map((r) => r.uuid)).not.toContain(lost[0]);
  expect(snapshot.management!.map((r) => r.uuid)).not.toContain(lost[1]);
  expect(snapshot.airworthiness).toHaveLength(ads.length - 1);
});

it("names a checklist whose payload is not JSON without its name", async () => {
  const { labels, damaged } = await read({
    checklists: [{ uuid: "list-1", payload: "{" }],
  });
  expect(labels).toContainEqual(["list-1", "Checklist: "]);
  expect(damaged).toEqual([]);
});
