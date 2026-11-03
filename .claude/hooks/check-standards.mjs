/**
 * Responsibility: Checks files against the machine-checkable rules in CONSTRAINTS.md: a complete
 *   architectural header block at the top of every code file (§2) and no inline lint or
 *   type-check suppressions (§7).
 * Layer: Tooling. Called per edited file by the Claude Code hook
 *   (.claude/hooks/enforce-robust-standards.sh) and per changed file by CI
 *   (.github/workflows/ci.yml). Never imported by the app; it only reads files and git.
 * Dependencies: Node.js built-ins only (fs, path, child_process), so it runs before `npm ci`.
 *
 * Usage:
 *   node .claude/hooks/check-standards.mjs <file>...            check the named files
 *   node .claude/hooks/check-standards.mjs --changed-since <ref> check files changed since <ref>
 * Exit codes: 0 all clear, 1 at least one violation, 2 usage or git error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Exit code when every checked file meets the standards. */
export const EXIT_OK = 0;
/** Exit code when at least one file breaks a rule. */
export const EXIT_VIOLATIONS = 1;
/** Exit code for bad arguments or a git failure. */
export const EXIT_USAGE = 2;

/** Comment syntax a header may use, by file extension; files with other extensions are not checked. */
const COMMENT_STYLE_BY_EXTENSION = Object.freeze({
  ".ts": "c",
  ".tsx": "c",
  ".js": "c",
  ".jsx": "c",
  ".mjs": "c",
  ".cjs": "c",
  ".css": "css",
  ".scss": "css",
  ".sh": "hash",
  ".bash": "hash",
  ".yml": "hash",
  ".yaml": "hash",
  ".py": "hash",
  ".html": "html",
});

/**
 * Repository paths the rules do not cover: generated code is rewritten by its tool, vendored
 * skills are refreshed with `npx skills`, and the retired PHP system is kept read-only.
 */
const EXEMPT_PATH_PREFIXES = Object.freeze([
  "node_modules/",
  "dist/",
  "coverage/",
  "test-results/",
  "playwright-report/",
  "convex/_generated/",
  ".claude/skills/",
  ".agents/",
  "legecy php_project/",
]);

/** Agent worktrees hold full copies of the repository; their files follow the same rules. */
const WORKTREE_PREFIX = /^\.claude\/worktrees\/[^/]+\//;

/** Labels the header must contain, each followed by a value (CONSTRAINTS.md §2). */
const HEADER_LABELS = Object.freeze(["Responsibility", "Layer", "Dependencies"]);

/**
 * Inline suppressions banned by CONSTRAINTS.md §7. Each pattern is assembled from pieces so this
 * file never contains the literal markers it searches for and cannot flag itself.
 */
const SUPPRESSION_RULES = Object.freeze([
  { name: "TypeScript suppression", pattern: new RegExp("@ts-" + "(ignore|nocheck|expect-error)\\b") },
  { name: "ESLint or oxlint disable", pattern: new RegExp("\\b(es|ox)lint" + "-disable") },
  { name: "Biome ignore", pattern: new RegExp("\\bbiome" + "-ignore") },
  { name: "Python noqa", pattern: new RegExp("#\\s*no" + "qa\\b", "i") },
  { name: "Python type ignore", pattern: new RegExp("#\\s*type:\\s*" + "ignore\\b") },
  { name: "pylint disable", pattern: new RegExp("pylint:\\s*" + "disable") },
]);

/** Example header per comment style, shown in failure messages so the fix is copy-paste. */
const HEADER_EXAMPLES = Object.freeze({
  c: "/**\n * Responsibility: <one sentence: what this module owns>.\n * Layer: <UI | Domain | Data | Server | Script | Test | Config | Tooling>. <Boundary: who calls it; what it must not do>.\n * Dependencies: <key modules and services it relies on, or none>.\n */",
  css: "/*\n * Responsibility: <what these styles own>.\n * Layer: UI. <Boundary: which screens use them>.\n * Dependencies: <tokens or shared styles it relies on>.\n */",
  hash: "# Responsibility: <one sentence: what this file owns>.\n# Layer: <Script | Config | Tooling>. <Boundary>.\n# Dependencies: <tools, secrets and files it relies on>.",
  html: "<!--\n  Responsibility: <what this page owns>.\n  Layer: UI. <Boundary>.\n  Dependencies: <scripts and styles it loads>.\n-->",
});

/**
 * Turns an absolute path into the repository-relative path the rules are written against.
 *
 * @param {string} absolutePath - File that was edited or changed.
 * @param {string} repoRoot - Absolute path of the repository root.
 * @returns {string | null} Forward-slash relative path, or null when the file is outside the repo.
 */
export function toRepoPath(absolutePath, repoRoot) {
  const relative = path.relative(repoRoot, path.resolve(absolutePath)).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.replace(WORKTREE_PREFIX, "");
}

/**
 * Decides whether the rules apply to a repository path, and with which comment syntax.
 *
 * @param {string} repoPath - Path relative to the repository root.
 * @returns {string | null} Comment style key, or null when the file is exempt or not code.
 */
export function commentStyleFor(repoPath) {
  if (EXEMPT_PATH_PREFIXES.some((prefix) => repoPath.startsWith(prefix))) return null;
  return COMMENT_STYLE_BY_EXTENSION[path.extname(repoPath).toLowerCase()] ?? null;
}

/**
 * Index of the first line a header may start on: after a shebang, an HTML doctype and blank lines.
 *
 * @param {string[]} lines - File contents split into lines.
 * @returns {number} Index of the first meaningful line (may equal lines.length).
 */
function firstContentLine(lines) {
  let index = lines[0]?.startsWith("#!") ? 1 : 0;
  if (/^<!doctype/i.test(lines[index]?.trim() ?? "")) index += 1;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  return index;
}

/**
 * Collects consecutive lines from `start` while `isPart` holds.
 *
 * @param {string[]} lines - File contents split into lines.
 * @param {number} start - First line to consider.
 * @param {(line: string) => boolean} isPart - Whether a trimmed line belongs to the block.
 * @returns {string} The block's text, or an empty string when the first line does not match.
 */
function collectLineComments(lines, start, isPart) {
  const block = [];
  for (let index = start; index < lines.length && isPart(lines[index].trim()); index += 1) {
    block.push(lines[index]);
  }
  return block.join("\n");
}

/**
 * Collects a delimited comment (`/* … *\/` or `<!-- … -->`) that opens on line `start`.
 *
 * @param {string[]} lines - File contents split into lines.
 * @param {number} start - Line the comment must open on.
 * @param {string} open - Opening delimiter.
 * @param {string} close - Closing delimiter.
 * @returns {string} The comment's text, or an empty string when none opens there or it never closes.
 */
function collectDelimitedComment(lines, start, open, close) {
  if (!lines[start]?.trim().startsWith(open)) return "";
  const end = lines.findIndex((line, index) => index >= start && line.includes(close));
  return end === -1 ? "" : lines.slice(start, end + 1).join("\n");
}

/**
 * Extracts the header block at the top of a file, in the comment syntax of its type.
 *
 * @param {string} text - File contents.
 * @param {string} style - Comment style key from {@link commentStyleFor}.
 * @returns {string} The header text, or an empty string when the file does not start with one.
 */
export function extractHeader(text, style) {
  const lines = text.split(/\r?\n/);
  const start = firstContentLine(lines);
  if (style === "hash") return collectLineComments(lines, start, (line) => line.startsWith("#"));
  if (style === "html") return collectDelimitedComment(lines, start, "<!--", "-->");
  const block = collectDelimitedComment(lines, start, "/*", "*/");
  if (block || style === "css") return block;
  return collectLineComments(lines, start, (line) => line.startsWith("//"));
}

/**
 * Lists what is missing from a file's header.
 *
 * @param {string} text - File contents.
 * @param {string} style - Comment style key.
 * @returns {string[]} Human-readable problems; empty when the header is complete.
 */
export function headerProblems(text, style) {
  const header = extractHeader(text, style);
  if (!header) return ["missing the architectural header block at the top of the file"];
  const missing = HEADER_LABELS.filter((label) => !new RegExp(`\\b${label}\\s*:\\s*\\S`, "i").test(header));
  if (missing.length === 0) return [];
  return [`header block is missing ${missing.map((label) => `"${label}:"`).join(", ")} (each with a value)`];
}

/**
 * Lists every banned suppression comment in a file, with its line number.
 *
 * @param {string} text - File contents.
 * @returns {string[]} Human-readable problems; empty when there are none.
 */
export function suppressionProblems(text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const rule = SUPPRESSION_RULES.find(({ pattern }) => pattern.test(line));
    if (rule) problems.push(`line ${index + 1}: ${rule.name} comment is not allowed; fix the code instead`);
  });
  return problems;
}

/**
 * Reads a file as text if it exists, is a regular file and is not binary.
 *
 * @param {string} absolutePath - File to read.
 * @returns {string | null} The contents, or null when there is nothing to check.
 */
function readCheckableText(absolutePath) {
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
  const text = readFileSync(absolutePath, "utf8");
  return text.includes("\u0000") ? null : text;
}

/**
 * Checks one file against the header and suppression rules.
 *
 * @param {string} absolutePath - File to check.
 * @param {string} repoRoot - Absolute path of the repository root.
 * @returns {{ file: string, problems: string[], example: string } | null} Violations, or null when
 *   the file passes, is exempt, is outside the repository, or no longer exists. Never throws for
 *   missing files; read errors on existing files propagate.
 */
export function checkFile(absolutePath, repoRoot) {
  const repoPath = toRepoPath(absolutePath, repoRoot);
  const style = repoPath === null ? null : commentStyleFor(repoPath);
  if (!style) return null;
  const text = readCheckableText(absolutePath);
  if (text === null) return null;
  const problems = [...headerProblems(text, style), ...suppressionProblems(text)];
  return problems.length ? { file: repoPath, problems, example: HEADER_EXAMPLES[style] } : null;
}

/**
 * Lists files added, copied, modified or renamed since a git revision.
 *
 * @param {string} baseRef - Revision to compare with. An empty or all-zero value (a new branch
 *   push) falls back to the files changed by the latest commit.
 * @param {string} repoRoot - Absolute path of the repository root.
 * @returns {string[]} Absolute paths.
 * @throws {Error} When git cannot resolve the revision.
 */
export function changedFiles(baseRef, repoRoot) {
  const hasBase = baseRef && !/^0+$/.test(baseRef);
  const args = hasBase
    ? ["diff", "--name-only", "--diff-filter=ACMR", baseRef, "HEAD"]
    : ["diff-tree", "--no-commit-id", "--name-only", "--diff-filter=ACMR", "-r", "HEAD"];
  const output = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return output.split("\n").filter(Boolean).map((file) => path.join(repoRoot, file));
}

/**
 * Formats violations as a report a person or an agent can act on directly.
 *
 * @param {Array<{ file: string, problems: string[], example: string }>} violations - Failed files.
 * @returns {string} Multi-line report ending with a pointer to CONSTRAINTS.md.
 */
export function formatReport(violations) {
  const sections = violations.map(({ file, problems, example }) =>
    [`✗ ${file}`, ...problems.map((problem) => `    - ${problem}`), "    Header format:", example.replace(/^/gm, "      ")].join("\n"),
  );
  return [...sections, "", "Fix these now. Rules: CONSTRAINTS.md §2 (header) and §7 (no suppressions)."].join("\n");
}

/**
 * Command-line entry point. Prints a report and returns the process exit code.
 *
 * @param {string[]} args - Arguments after the script name.
 * @param {string} repoRoot - Absolute path of the repository root.
 * @returns {number} {@link EXIT_OK}, {@link EXIT_VIOLATIONS} or {@link EXIT_USAGE}.
 */
export function main(args, repoRoot) {
  const sinceIndex = args.indexOf("--changed-since");
  if (args.length === 0 || (sinceIndex !== -1 && args.length !== 2)) {
    console.error("Usage: check-standards.mjs <file>... | --changed-since <git-ref>");
    return EXIT_USAGE;
  }
  const files = sinceIndex === -1 ? args.map((file) => path.resolve(file)) : changedFiles(args[1], repoRoot);
  const violations = files.map((file) => checkFile(file, repoRoot)).filter(Boolean);
  if (violations.length === 0) {
    console.log(`Engineering standards: ${files.length} file(s) checked, all clear.`);
    return EXIT_OK;
  }
  console.error(formatReport(violations));
  return EXIT_VIOLATIONS;
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  try {
    process.exitCode = main(process.argv.slice(2), repoRoot);
  } catch (error) {
    // A git or file-system failure must fail loudly: a silent pass would let violations through.
    console.error(`check-standards: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_USAGE;
  }
}
