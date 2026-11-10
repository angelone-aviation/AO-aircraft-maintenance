/**
 * Responsibility: Pins that the restore and key-change work files the backup
 *   runbook creates in the repository's top folder cannot be committed.
 * Layer: Test. Asks git which paths .gitignore covers; never writes a file.
 * Dependencies: vitest, git, .gitignore, docs/runbooks/backup-restore.md.
 *
 * These files hold the backup's age private key and the decrypted production
 * environment (JWT signing and credentials keys); the CI secret scan would
 * only see one after it was pushed.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");

// The names docs/runbooks/backup-restore.md tells the operator to use.
const RUNBOOK_FILES = [
  "key.txt",
  "new-key.txt",
  "env.txt",
  "angelone-env-20261101T084109Z.txt",
  "angelone-20261104T084112Z.zip.age",
  "angelone-20261104T084112Z.manifest.json",
  "angelone-20261104T084112Z.zip",
];

it("ignores every work file the backup runbook names in the top folder", () => {
  expect(RUNBOOK_FILES.filter((file) => !ignored(file))).toEqual([]);
});

it("covers the top folder only, as the runbook warns", () => {
  expect(ignored("docs/key.txt")).toBe(false);
  expect(ignored("scripts/backup/env.txt")).toBe(false);
});

// --no-index answers for the name alone, whether or not such a file exists.
function ignored(file: string): boolean {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", file], {
    cwd: REPO_ROOT,
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git check-ignore failed for ${file}: ${result.stderr}`);
}
