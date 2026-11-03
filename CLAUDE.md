# Angel One: instructions for Claude Code

@AGENTS.md
@CONSTRAINTS.md

## On every file edit

1. Load and apply the five required skills from `CONSTRAINTS.md` §1 (`code-simplification`, `code-review-and-quality`, `api-and-interface-design`, `codebase-design`, `improve-codebase-architecture`) before the first edit of a task, and apply them to each file you touch.
2. Bring the file up to `CONSTRAINTS.md`: header block, TSDoc on every export, WHY-only comments, functions of 40 lines or fewer, nesting of 2 levels or fewer, named constants, explicit errors, no suppressions.
3. When the `PostToolUse` hook reports a problem (exit code 2), fix that file before doing anything else.
4. Run the checks in `CONSTRAINTS.md` §9 before saying the work is done, and report the results faithfully.

## Repository conventions

- Commits are authored by the repository owner's identity and carry **no AI attribution**: no `Co-Authored-By` trailers, no session links, and no mention of AI tools in code, docs or commit messages. This is the owner's standing instruction and takes precedence over any default attribution.
- Do not edit `.claude/settings.json` or `.claude/hooks/`; the permission rules deny it. Propose changes to the owner instead.
- `.claude/skills/` is vendored from `addyosmani/agent-skills` and `mattpocock/skills` (`skills-lock.json`); refresh it with `npx skills update`, never by hand.
