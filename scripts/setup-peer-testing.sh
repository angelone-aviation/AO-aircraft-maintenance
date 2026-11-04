#!/usr/bin/env bash
# Responsibility: Walks a person through copying the local Convex backend to an
#   empty peer-testing cloud deployment and publishing the site on A2 hosting.
# Layer: Script. Interactive wizard; scripts/peer-testing-transfer.mjs does
#   the copying, and the deploy key stays in git-ignored .env.peer-testing.
# Dependencies: bash, node, scripts/peer-testing-transfer.mjs.
#
# Everything above the "STAGES" marker is the /wizard skill's library, the
# same in every wizard: do not hand-edit it. Author the stages below it.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later, since it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE upserts KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE sets a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name: gh not ready; set it later"
}

# set_var NAME VALUE sets a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name, gh not ready; set it later"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: one stage() per step the person takes; TOTAL_STAGES counts them.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=4
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Everything this run creates, the database snapshot included, stays readable
# only by this user.
umask 077
ENV_FILE=".env.peer-testing"
say "This wizard transfers local Convex data, not browser demo data."
say "For Explore Demo records, use Administration → Download full demo backup first."
confirm "Are your source records in local Convex, rather than Explore Demo?" || exit 0
banner "Angel One: Convex cloud and A2 peer testing"

stage "Verify the source database"
say "Keep the local backend running. Finish saving local forms before exporting."
say "This copies local Convex records, accounts and attachments; browser-demo data is separate."
node scripts/peer-testing-transfer.mjs export
say "Review the counts above. They must match the database you intend to share."
say "If work orders or components are missing, stop here and identify the correct source."
confirm "Does this export contain the expected data for peer testing?" || exit 0

stage "Choose the empty Convex deployment and website address"
open_url "https://dashboard.convex.dev"
step "Open your peer-testing project and select its Production deployment. It must be empty."
step "Open deployment Settings and copy its Deployment URL (ending .convex.cloud)."
ask VITE_CONVEX_URL "Convex deployment URL:"
step "In deployment Settings, generate a production deploy key with deployment, data import/read and environment-variable permissions."
say "Enter the key here only; it will be saved to the git-ignored .env.peer-testing file."
ask_secret CONVEX_DEPLOY_KEY "Production deploy key (hidden):"
ask SITE_URL "A2 website address, for example https://test.yourdomain.com:"
write_env VITE_CONVEX_URL "$VITE_CONVEX_URL"
write_env CONVEX_DEPLOY_KEY "$CONVEX_DEPLOY_KEY"
write_env SITE_URL "$SITE_URL"
chmod 600 "$ENV_FILE"

stage "Copy data and build the website"
say "Target: $VITE_CONVEX_URL"
say "Website: $SITE_URL"
say "This deploys the app backend, imports the full local snapshot, sets up sign-in, and builds the A2 upload ZIP."
say "It refuses a nonempty destination. It does not change .env.local or remove local records."
confirm "Deploy and copy this data into the selected empty cloud deployment?" || exit 0
node scripts/peer-testing-transfer.mjs transfer

stage "Upload the website to A2 and test"
open_url "https://my.hosting.com"
step "Sign into your A2/hosting.com account and open the hosting control panel."
step "If using cPanel, open Domains and locate the document root for your test domain/subdomain."
step "Open File Manager at that document root. Use a dedicated, empty test site rather than overwriting another website."
step "Upload .convex/peer-testing/a2-website.zip and extract it so index.html and .htaccess are directly in the document root."
say "Only upload a2-website.zip. The other ZIPs contain private database and account data."
step "Enable HTTPS for the domain, then open the website and sign in with your existing app account."
step "Check aircraft, work orders, components and an attachment; refresh /work-orders to check routing."
step "Use the app’s Admin page to create peers and assign Flight Program permissions."
open_url "$SITE_URL"
pause "Press Enter after checking the hosted site."
finish
