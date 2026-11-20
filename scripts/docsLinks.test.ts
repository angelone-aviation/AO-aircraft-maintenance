/**
 * Responsibility: Fails when a relative link or #anchor in tracked Markdown
 *   does not resolve.
 * Layer: Test. Lists Markdown through git and reads it; never writes a file.
 * Dependencies: vitest, git, node:fs, node:path.
 *
 * Anchors follow GitHub's heading slugs, so renaming a heading breaks every
 * link to it here rather than silently on GitHub.
 *
 * @vitest-environment node
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");

// Vendored or retired content we do not maintain.
const EXCLUDED_PREFIXES = [
  ".claude/skills/",
  ".agents/",
  "node_modules/",
  "legecy php_project/",
];

/** Read access to the files a Markdown link can point at. */
interface FileTree {
  exists(absolutePath: string): boolean;
  read(absolutePath: string): string;
}

const DISK: FileTree = {
  exists: existsSync,
  read: (absolutePath) => readFileSync(absolutePath, "utf8"),
};

describe("findBrokenLinks", () => {
  const tree = fakeTree({
    "/r/a.md": "# Top\n\n## Same\n\n## Same\n\n## `Code` and **bold**\n",
    "/r/img.png": "",
  });
  const check = (text: string) =>
    findBrokenLinks("/r/b.md", text, tree, "/r").broken;

  it("accepts files, heading anchors, duplicate and formatted headings", () => {
    const text =
      "[a](a.md) [b](./a.md#top) [c](a.md#same-1) [d](a.md#code-and-bold)" +
      ' [e](a.md "Title") <img src="img.png"> [f](/a.md) [g](https://x.y/z)';
    expect(check(text)).toEqual([]);
  });

  it("reports missing files and anchors, including reference links", () => {
    const text = "[a](gone.md) [b](a.md#nope)\n\n[ref]: a.md#also-nope\n";
    expect(check(text)).toEqual([
      "missing: gone.md",
      "no anchor: a.md#nope",
      "no anchor: a.md#also-nope",
    ]);
  });

  it("ignores links inside code", () => {
    expect(check("`[a](gone.md)`\n\n```\n[b](gone.md)\n```\n")).toEqual([]);
  });
});

it("resolves every relative link and anchor in tracked Markdown", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const file of listTrackedMarkdown()) {
    const absolute = path.join(REPO_ROOT, file);
    const result = findBrokenLinks(
      absolute,
      DISK.read(absolute),
      DISK,
      REPO_ROOT,
    );
    checked += result.checked;
    failures.push(...result.broken.map((problem) => `${file}: ${problem}`));
  }
  expect(checked).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

/**
 * Checks the relative links in one Markdown file: the target must exist and,
 * for a Markdown target, any #anchor must name one of its headings.
 */
function findBrokenLinks(
  file: string,
  text: string,
  tree: FileTree,
  repoRoot: string,
): { checked: number; broken: string[] } {
  const hrefs = extractHrefs(text).filter((href) => !isExternal(href));
  const broken: string[] = [];
  for (const href of hrefs) {
    const problem = checkHref(file, href, tree, repoRoot);
    if (problem) broken.push(`${problem}: ${href}`);
  }
  return { checked: hrefs.length, broken };
}

function checkHref(
  file: string,
  href: string,
  tree: FileTree,
  repoRoot: string,
): "missing" | "no anchor" | undefined {
  const [target, anchor] = href.split("#");
  const decoded = decodeURIComponent(target);
  const base = decoded.startsWith("/") ? repoRoot : path.dirname(file);
  const resolved = target ? path.join(base, decoded) : file;
  if (!tree.exists(resolved)) return "missing";
  if (!anchor || !resolved.endsWith(".md")) return undefined;
  return headingSlugs(tree.read(resolved)).has(anchor)
    ? undefined
    : "no anchor";
}

function extractHrefs(markdown: string): string[] {
  const text = stripFencedCode(markdown).replace(/`[^`\n]*`/g, "");
  const inline = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const reference = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
  const html = /<(?:a|img)\s[^>]*?(?:href|src)="([^"]+)"/g;
  return [inline, reference, html].flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1]),
  );
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

// GitHub numbers repeated headings: the second "Notes" is #notes-1.
function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const line of stripFencedCode(markdown).split("\n")) {
    const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!heading) continue;
    const base = slugify(heading[1]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const match of markdown.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) {
    slugs.add(match[1]);
  }
  return slugs;
}

// GitHub slugs the rendered text: link targets and markup are dropped.
function slugify(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function stripFencedCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function listTrackedMarkdown(): string[] {
  const result = spawnSync("git", ["ls-files", "-z", "*.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => !EXCLUDED_PREFIXES.some((p) => file.startsWith(p)));
}

function fakeTree(files: Record<string, string>): FileTree {
  return {
    exists: (absolutePath) => absolutePath in files,
    read: (absolutePath) => files[absolutePath],
  };
}
