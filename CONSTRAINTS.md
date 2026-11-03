# Robust Engineering Standards

These rules apply to every change in this repository, by people and by agents. They sit on top of `AGENTS.md`: Angel One keeps safety-critical FAA maintenance records, so corrections are appended rather than history edited, and no change may weaken an authorization or audit path to make the code smaller.

Rules marked **[enforced]** are checked automatically: by the Claude Code hook on every edit (`.claude/hooks/enforce-robust-standards.sh`) and by CI on every file a push or pull request changes (`.claude/hooks/check-standards.mjs`). The rest are review rules: the skills below and code review hold them.

## 1. Mandatory skill routing

Before editing any file, load and apply these skills (installed in `.claude/skills/`). Once per task is enough when they are already loaded; re-apply them to each file you touch.

| Skill | Use it to |
|---|---|
| `code-simplification` | Remove needless complexity; prefer the plainest code that keeps the behavior. |
| `code-review-and-quality` | Review your own diff before you call it done: correctness, tests, naming, error paths. |
| `api-and-interface-design` | Shape every exported function, type, Convex function and backend method as a deliberate contract. |
| `codebase-design` | Keep modules deep: small interfaces over substantial behavior, one responsibility each. |
| `improve-codebase-architecture` | Notice coupling, duplication and misplaced responsibilities near your change, and fix or record them in `REFACTOR_ROADMAP.md`. |

Skipping a skill is a review finding, the same as skipping a test.

`improve-codebase-architecture` can only be started by a person (`/improve-codebase-architecture`); agents cannot load it. Agents meet that row by applying `codebase-design`'s vocabulary and the deletion test to the code they touch, and by adding what they find to `REFACTOR_ROADMAP.md`.

## 2. File header [enforced]

Every code file starts with a header block that states its single responsibility, its architectural layer and boundary, and its key dependencies. The three labels are required, each with a value.

```ts
/**
 * Responsibility: Computes when inspections, components and ADs fall due.
 * Layer: Domain. Pure functions shared by the browser and Convex; no I/O, no React.
 * Dependencies: src/domain/model.ts (types), src/domain/dates.ts (calendar rules).
 *
 * Optional: why-context a newcomer needs (history, regulation, tradeoffs).
 */
```

Shell, YAML and Python files use `#` lines (after the shebang, if any); HTML uses `<!-- ... -->`.

Layers: **UI** (`src/components`, `src/styles`), **Domain** (`src/domain`), **Data** (`src/data`), **Server** (`convex`), **Script** (`scripts`), **Test** (`*.test.ts`, `tests/`), **Config**, **Tooling** (`.claude/hooks`, `.github`).

Touching a file means bringing its header up to this standard, even if your change is elsewhere in the file.

Exempt, because they cannot hold a comment or are not ours: JSON, Markdown, lockfiles, images and other assets, `convex/_generated/`, `.claude/skills/` and `.agents/` (vendored skills), `node_modules/`, build output, and the retired PHP system in `legecy php_project/`.

## 3. Public API documentation

100% of exported functions, classes, types, interfaces, constants, React components, Convex queries, mutations and actions, and `Backend` methods carry a TSDoc block stating:

- purpose, in terms of the domain (not the implementation);
- each parameter (`@param`) and the return value (`@returns`);
- what it throws (`@throws`), including `ConvexError` messages users see;
- side effects and guarantees: writes, audit entries, transactions, idempotency, offline behavior.

Document throws and side effects only where they exist: no `@throws Never`, no `@returns Nothing` on `void`, and no "Pure: no side effects" on each function when the file header already says the module is pure. See §10 for length and style.

## 4. Comments explain WHY

Write comments for business rules, regulations (cite them, e.g. 14 CFR 91.417), non-obvious edge cases, performance tradeoffs and history. Never narrate what the syntax already says. Delete "what" comments when you touch them.

```ts
// Good: Usage limits ground the aircraft at 0 remaining, but calendar limits stay
// "due soon" through their due date (GLOSSARY "Overdue"), matching FAA practice.
// Bad:  // loop over the items
```

## 5. Structure

- **One responsibility** per function and per module.
- **Functions stay at or under 40 lines.** Extract private helpers with verb-first names (`computeRemainingHours`, `assertSameProgram`).
- **At most 2 levels of nesting.** Validate preconditions with early-return guard clauses at the top; no arrow-shaped `if`/`else` pyramids.
- **Strict types.** No `any`, no implicit `any`, no loose `Record<string, unknown>` where a real type exists. Define interfaces, DTOs and domain types (zod schemas in `src/domain` are the source of truth for stored payloads).
- **No magic values.** Strings, limits, timeouts and numeric literals go into named `SCREAMING_SNAKE_CASE` constants, or a central enum or configuration module when shared. `0`, `1` and `-1` in obvious arithmetic are fine.

## 6. Errors

- Never swallow an error silently. A `catch` either handles a specific, expected failure (and says why in a comment) or rethrows with context.
- Throw domain-specific errors (`ConvexError` with the user-facing message on the server, `FlightRejection` and similar in the domain).
- Attach context that helps diagnosis: record type, ids, operation. Never put personal data, passwords, tokens or keys in errors or logs.

## 7. No suppressions [enforced]

No inline lint or type-check suppressions of any kind: TypeScript ignore, no-check and expect-error comments; ESLint or oxlint disable comments; Biome ignore comments; Python noqa, type-ignore and pylint-disable comments. Fix the code, or change the rule in the linter configuration with a written reason.

## 8. Changing code safely

- **Zero behavior change** in a refactor, unless the change is an explicit, tested bug fix. Exported names, signatures and API contracts stay as they are.
- Work in small batches (1–3 files), leaf modules first.
- After each file, run the type checker and that file's tests. After each batch, run the full checks below. Commit after each passing module.
- If a module you need to change has thin tests, write characterization tests for its current behavior first.

## 9. Checks before you finish

```sh
npm run check            # typecheck, lint, unit and server tests, build
npm run check:standards  # headers and suppressions in files changed since origin/main
npm run test:e2e         # browser tests against the production build
npm run test:backup      # when scripts/backup changes
```

## 10. House style

Set by the review of the first refactor batch (2026-11-03). The goal is high signal, not more words.

- **Header:** the three labels, about one line each; at most about 7 lines with an optional WHY paragraph. `Layer:` is the layer and its boundary only, never a list of consumers. `Dependencies:` lists imported modules only.
- **Say each fact once.** A module-wide WHY goes in the header; don't repeat it in type, function and constant docs.
- **TSDoc:** a one-sentence purpose in domain terms, then tags. Aim for 2–6 lines for a simple function and at most 10 for a complex one. Never list callers: they go stale, and `rg` finds them.
- **`@returns` and `@throws` state the contract** (order, uniqueness, exact user-facing messages, error class), not a prose replay of the body.
- **Extract a constant only when it earns it:** a domain limit or rule, a value used more than once, or a name that explains what the literal doesn't. Single-use defaults, idiomatic regexes (`/\D/g`) and one-off messages stay inline. Never create a module-level regex with the `g` flag.
- **A constant's comment adds a WHY its name lacks** (the source of the number, the regulation, the consequence), or it doesn't exist. `US_ZIP_CODE` needs no comment.
- **Verify every comment against the code.** Run an example for any regex or parser you describe. A wrong comment is a defect.
- **Wrap comments at 80 columns,** the same as Prettier wraps the code.
- **Helpers:** extract only to meet the 40-line or 2-level limits, or to name a real concept. Use verb-first names, place them below the exports, and inline single-use temporaries.
- **Tests pin what the docs promise.** If a docstring states an order, limit or quirk, a test fails when it changes; check by flipping it once. Label quirks "Characterizes current behaviour". No comments that restate the next assertion, and no assertions that cannot fail.
- **Size budget:** a standards pass rarely grows a file by more than about 50%, and comment lines stay well under code lines.

## 11. Enforcement and its limits

- **On every edit** (Claude Code): the `PostToolUse` hook checks the edited file. A missing or incomplete header, or a suppression comment, exits with code 2: the agent sees the problem at once and must fix it. `UserPromptSubmit` and `SessionStart` (after compaction) hooks restate these rules.
- **On every push and pull request** (CI): the same check runs on every changed file, however it was written. A failure blocks a green build.
- Agents may not edit `.claude/settings.json` or `.claude/hooks/` (permission deny rules). Changing the enforcement itself is a human decision, made in a reviewed commit.
- Known gaps, closed by CI: Claude Code does not run edit hooks when a file is written through the shell, and a person can turn hooks off in their own local settings.
