#!/usr/bin/env bash
# Responsibility: Opens a file downloaded from the backup bucket for a restore
#   or rehearsal: decrypts an .age file, and checks an export against its
#   manifest, encrypted or not (ADR-0014).
# Layer: Script. Run by hand; never prints an environment file's contents.
# Dependencies: age (encrypted files only), sha256sum or shasum, node.
#
#   scripts/backup/decrypt.sh <private key file> <downloaded .age file>
#   scripts/backup/decrypt.sh <downloaded .unencrypted.zip file>
#
# An .age file is decrypted beside itself, without ".age"; an export with its
# .manifest.json beside it is then checked. An .unencrypted.zip is not changed
# and must have its manifest beside it, since checking it is the whole job.
# Both print the documents per table, to compare after the import, and say
# when a plain copy's sign-in records were removed. Runbook:
# docs/runbooks/backup-restore.md. Tests: npm run test:backup.

set -euo pipefail
# The decrypted file holds production records or secrets: owner-only access.
umask 077

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  fail "usage: $0 <private key file> <downloaded .age file>, or $0 <downloaded .unencrypted.zip file>"
}

# Compares the file's SHA-256 with the manifest's plaintext.sha256 and prints
# the table counts; exits non-zero on a mismatch.
check_manifest() {
  local file=$1 manifest=$2 sum
  # macOS ships shasum; sha256sum may be missing there.
  if command -v sha256sum >/dev/null; then
    sum=$(sha256sum "$file")
  else
    sum=$(shasum -a 256 "$file")
  fi
  node - "$manifest" "${sum%% *}" <<'JS'
const fs = require("node:fs");
const [manifestPath, actual] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.plaintext.sha256 !== actual) {
  console.error(`error: SHA-256 does not match ${manifestPath}. Do not import this file.`);
  process.exit(1);
}
console.log(`SHA-256 matches the manifest (export started ${manifest.exportStartedAt}).`);
const removed = manifest.signInRecordsRemoved;
if (removed) {
  console.log(`Sign-in records were removed from this copy (${removed.tables.join(", ")}):`);
  console.log("after restoring it everyone must sign in again, which is harmless.");
}
console.log("Documents per table in the export:");
for (const [table, count] of Object.entries(manifest.tables)) {
  console.log(`  ${table.padEnd(40)} ${count}`);
}
JS
}

check_plain() {
  local file=$1 manifest=${1%.zip}.manifest.json
  [[ -f "$file" ]] || fail "$file not found."
  [[ -f "$manifest" ]] || fail "$manifest not found. Download the manifest beside the export, then run this again."
  echo "$file is not encrypted (ADR-0014); checking it against its manifest."
  check_manifest "$file" "$manifest"
}

decrypt() {
  local key=$1 encrypted=$2 decrypted manifest
  [[ -f "$key" ]] || fail "$key not found."
  [[ -f "$encrypted" && "$encrypted" == *.age ]] || fail "$encrypted is not a downloaded .age file."
  command -v age >/dev/null || fail "age is not installed (macOS: brew install age; Ubuntu: sudo apt-get install age)."
  decrypted=${encrypted%.age}
  [[ ! -e "$decrypted" ]] || fail "$decrypted already exists; move it away first."
  age -d -i "$key" -o "$decrypted" "$encrypted" || {
    rm -f -- "$decrypted"
    fail "age could not decrypt $encrypted with $key. Check the manifest's encryptedTo against: age-keygen -y $key"
  }
  echo "Decrypted to $decrypted"
  manifest=${encrypted%.zip.age}.manifest.json
  [[ "$encrypted" == *.zip.age && -f "$manifest" ]] || return 0
  check_manifest "$decrypted" "$manifest"
}

case "$#:${1:-}" in
  1:*.unencrypted.zip) check_plain "$1" ;;
  2:*) decrypt "$1" "$2" ;;
  *) usage ;;
esac
