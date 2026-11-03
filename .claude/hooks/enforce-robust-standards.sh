#!/usr/bin/env bash
# Responsibility: Claude Code hook that enforces CONSTRAINTS.md during agent sessions.
# Layer: Tooling. Wired in .claude/settings.json; runs outside the app and never changes files.
# Dependencies: bash, node (already required by this repository), .claude/hooks/check-standards.mjs.
#
# One script serves three events, read from the hook's JSON on stdin:
#   UserPromptSubmit          prints the standards reminder; Claude Code adds stdout to context.
#   SessionStart (compact)    re-states the standards after the conversation is compacted.
#   PostToolUse (Edit|Write)  checks the edited file. A missing or incomplete header, or a lint or
#                             type-check suppression, prints the problems to stderr and exits 2,
#                             which Claude Code feeds straight back to the agent to fix.
# Anything it cannot read exits 2 as well: a hook that silently passes enforces nothing.
set -euo pipefail

readonly EXIT_BLOCK=2
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HOOK_DIR
REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"
readonly REPO_ROOT
readonly CHECKER="$HOOK_DIR/check-standards.mjs"

readonly REMINDER="Robust Engineering Standards are in force (CONSTRAINTS.md, CLAUDE.md).
- Before editing files, load and apply the skills: code-simplification, code-review-and-quality, api-and-interface-design, codebase-design, improve-codebase-architecture.
- Every code file touched needs the header block (Responsibility / Layer / Dependencies), TSDoc on every export, and WHY-only comments.
- Functions of 40 lines or fewer, nesting of 2 levels or fewer (guard clauses), SCREAMING_SNAKE_CASE constants for magic values, explicit errors.
- No inline lint or type-check suppressions. Refactors change no behavior.
- Each edit is checked; a hook report (exit 2) must be fixed before anything else."

# Prints one field of the hook's JSON input; empty when the field is absent.
# Node is used because jq is not guaranteed on every machine that runs this repository.
read_field() {
  HOOK_INPUT="$1" node -e '
    const value = String(process.argv[1]).split(".").reduce((node, key) => node?.[key], JSON.parse(process.env.HOOK_INPUT));
    process.stdout.write(typeof value === "string" ? value : "");
  ' "$2"
}

fail() {
  printf 'enforce-robust-standards: %s\n' "$1" >&2
  exit "$EXIT_BLOCK"
}

check_edited_file() {
  local file_path
  file_path="$(read_field "$1" tool_input.file_path)" || fail "could not read the hook input."
  [[ -n "$file_path" ]] || exit 0
  local report
  if report="$(node "$CHECKER" "$file_path" 2>&1)"; then
    exit 0
  fi
  printf '%s\n' "$report" >&2
  exit "$EXIT_BLOCK"
}

main() {
  local input event
  input="$(cat)"
  event="$(read_field "$input" hook_event_name)" || fail "could not read the hook input as JSON."
  cd "$REPO_ROOT"
  case "$event" in
    UserPromptSubmit) printf '%s\n' "$REMINDER" ;;
    SessionStart) printf 'The conversation was compacted; re-read CONSTRAINTS.md before the next edit.\n%s\n' "$REMINDER" ;;
    PostToolUse) check_edited_file "$input" ;;
    *) exit 0 ;;
  esac
}

main
