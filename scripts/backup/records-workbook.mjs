#!/usr/bin/env node
/**
 * Responsibility: Command-line launcher that builds the readable records
 *   workbook (ADR-0011) from a Convex export ZIP.
 * Layer: Script. A launcher only; the workbook is built in recordsWorkbook.ts.
 * Dependencies: esbuild (installed with convex),
 *   scripts/backup/recordsWorkbook.ts.
 *
 *   node scripts/backup/records-workbook.mjs --zip <convex export zip> \
 *     --out <file.xlsx> [--tz America/New_York] [--deployment <name>]
 *
 * The workbook applies the app's own rules from src/domain, which is
 * TypeScript, so each run bundles recordsWorkbook.ts with esbuild before
 * importing it. Run `npm ci` first.
 */
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Under node_modules so the bundle's imports (exceljs, zod, fflate) resolve.
const cache = path.resolve(
  here,
  "../../node_modules/.cache/angel-one-records-workbook",
);
// Named per process, so concurrent runs never import each other's bundle.
const bundle = path.join(cache, `records-workbook-${process.pid}.mjs`);
try {
  const result = await build({
    entryPoints: [path.join(here, "recordsWorkbook.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "external",
    write: false,
    logLevel: "silent",
  });
  await mkdir(cache, { recursive: true });
  await writeFile(bundle, result.outputFiles[0].contents);
  const { main } = await import(pathToFileURL(bundle).href);
  await main(process.argv.slice(2));
} catch (error) {
  // The CLI's error boundary: one line on stderr and exit code 1, which
  // nightly.sh turns into its own failure message.
  console.error(
    `records-workbook: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await rm(bundle, { force: true });
}
