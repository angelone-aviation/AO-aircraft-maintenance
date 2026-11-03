#!/usr/bin/env bash
#
# Decrypts a file downloaded from the backup bucket, for a restore or the
# quarterly rehearsal (docs/runbooks/backup-restore.md).
#
#   scripts/backup/decrypt.sh <private key file> <downloaded .age file>
#
# Writes the decrypted file beside the encrypted one, without ".age". For an
# export whose .manifest.json sits beside it, also checks the SHA-256 and
# prints the document count per table, to compare after the import. Never
# prints the contents of an environment file.

set -euo pipefail
umask 077

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail "usage: $0 <private key file> <downloaded .age file>"
key=$1
encrypted=$2
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
[[ "$encrypted" == *.zip.age && -f "$manifest" ]] || exit 0

if command -v sha256sum >/dev/null; then
  sum=$(sha256sum "$decrypted")
else
  sum=$(shasum -a 256 "$decrypted")
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
console.log("Documents per table in the export:");
for (const [table, count] of Object.entries(manifest.tables)) {
  console.log(`  ${table.padEnd(40)} ${count}`);
}
JS
