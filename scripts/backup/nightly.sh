#!/usr/bin/env bash
# Responsibility: Nightly off-site backup of the production Convex deployment
#   to R2 (ADR-0008), then the readable Dropbox copy when set up (ADR-0011).
# Layer: Script. Never deletes or overwrites a backup in the bucket, and never
#   prints a secret or the environment variables.
# Dependencies: npx convex, aws, age or zip, unzip, jq, sha256sum, node;
#   scripts/backup/records-workbook.mjs, scripts/backup/dropbox-upload.mjs.
#
# Runbook: docs/runbooks/backup-restore.md. Tests: npm run test:backup.

# Steps:
#   a. `npx convex export --include-file-storage`, checked: a valid ZIP that
#      includes file storage and at least one user account;
#   b. encrypted with age to BACKUP_AGE_PUBLIC_KEY when it is set; without it
#      the ZIP is stored unencrypted, named .unencrypted.zip, with its sign-in
#      tables emptied (ADR-0014);
#   c. uploaded to R2 under daily/YYYY/MM/DD/ with a manifest, then checked;
#   d. also uploaded to monthly/YYYY-MM/ when that month has no copy yet;
#   e. environment variables, encrypted, uploaded to env/ when they or the
#      backup key changed; never without a key, as they hold the secrets;
#   f. recorded in the app with `npx convex run backups:recordOffsiteCopy`;
#   g. turned into the records workbook and uploaded to Dropbox, when set up.
#
# Environment:
#   CONVEX_DEPLOY_KEY      production deploy key (prod:...)
#   BACKUP_AGE_PUBLIC_KEY  optional age public key (age1...); unset or empty
#                          stores the copies unencrypted (ADR-0014)
#   R2_ACCOUNT_ID          Cloudflare account ID
#   R2_ACCESS_KEY_ID       R2 API token: object read and write on the bucket
#   R2_SECRET_ACCESS_KEY
#   R2_BUCKET              optional, default angelone-backups
#   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN
#                          optional; step g runs only when the token is set
#   RECORDS_TIME_ZONE      optional, default America/New_York
#
# The plaintext export is kept in this script's temp dir (mode 700) until it
# exits, then removed with it; without a key, R2 holds it unencrypted too.
# The only bucket object it replaces is state/env-fingerprint.txt. It prints
# object keys and sizes.

set -euo pipefail
shopt -s inherit_errexit
umask 077

fail() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::error::%s\n' "$*" >&2
  else
    printf 'error: %s\n' "$*" >&2
  fi
  exit 1
}

warn() {
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    printf '::warning::%s\n' "$*" >&2
  else
    printf 'warning: %s\n' "$*" >&2
  fi
}

file_size() {
  local bytes
  bytes=$(wc -c <"$1")
  printf '%s\n' "$((bytes))"
}

sha256_of() {
  local line
  line=$(sha256sum "$1")
  printf '%s\n' "${line%% *}"
}

# ---------------------------------------------------------------------------
# Inputs. Checked before anything runs.

deploy_key=${CONVEX_DEPLOY_KEY:-}
case "$deploy_key" in
  prod:*) ;;
  *) fail "CONVEX_DEPLOY_KEY must be a production deploy key (prod:...)." ;;
esac

recipient=${BACKUP_AGE_PUBLIC_KEY:-}
case "$recipient" in
  AGE-SECRET-KEY-*)
    fail "BACKUP_AGE_PUBLIC_KEY holds an age private key. Delete that secret now, then make a new key pair (docs/runbooks/backup-restore.md); the private key must never be in GitHub."
    ;;
esac
# Only an absent or empty secret means "unencrypted" (ADR-0014). Anything else
# must be a public key, so a mangled key fails the run instead of quietly
# storing plain copies.
encrypted=false
if [[ -n "$recipient" ]]; then
  [[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || fail "BACKUP_AGE_PUBLIC_KEY must be an age public key (age1...)."
  encrypted=true
fi

for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [[ -n "${!name:-}" ]] || fail "$name is not set."
done
[[ "$R2_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || fail "R2_ACCOUNT_ID must be the 32-character Cloudflare account ID."
bucket=${R2_BUCKET:-angelone-backups}
[[ "$bucket" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || fail "R2_BUCKET is not a valid bucket name."

# Keep each credential away from the programs that do not need it: the Convex
# CLI never sees the R2 keys, and the AWS CLI never sees the deploy key.
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
r2_key_id=$R2_ACCESS_KEY_ID
r2_secret=$R2_SECRET_ACCESS_KEY
unset CONVEX_DEPLOY_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
# The optional Dropbox copy (ADR-0011): only its upload step sees these.
dropbox_app_key=${DROPBOX_APP_KEY:-}
dropbox_app_secret=${DROPBOX_APP_SECRET:-}
dropbox_refresh_token=${DROPBOX_REFRESH_TOKEN:-}
unset DROPBOX_APP_KEY DROPBOX_APP_SECRET DROPBOX_REFRESH_TOKEN

for cmd in npx aws unzip jq sha256sum; do
  command -v "$cmd" >/dev/null || fail "$cmd is not installed."
done
if [[ "$encrypted" == true ]]; then
  command -v age >/dev/null || fail "age is not installed."
else
  command -v zip >/dev/null || fail "zip is not installed."
fi

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
[[ -x node_modules/.bin/convex ]] || fail "Run npm ci first: the Convex CLI must come from package-lock.json."

convex() {
  CONVEX_DEPLOY_KEY="$deploy_key" npx convex "$@"
}

# R2 through its S3-compatible API. Newer AWS CLI versions add checksums that
# S3-compatible stores can reject, so send them only when an operation needs one.
r2() {
  AWS_ACCESS_KEY_ID="$r2_key_id" AWS_SECRET_ACCESS_KEY="$r2_secret" \
    AWS_DEFAULT_REGION=auto AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    AWS_RESPONSE_CHECKSUM_VALIDATION=when_required AWS_PAGER="" \
    AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    aws --endpoint-url "$endpoint" --region auto "$@"
}

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/angelone-backup.XXXXXX")
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT
# 128 + the signal number: the status a shell reports for a killed command.
trap 'exit 130' INT
trap 'exit 143' TERM

# Prints the object's size in bytes, or nothing when it does not exist.
object_size() {
  local key=$1 size
  if size=$(r2 s3api head-object --bucket "$bucket" --key "$key" \
    --query ContentLength --output text 2>"$work/aws-error"); then
    printf '%s\n' "$size"
  elif grep -qE '\((404|NoSuchKey|NotFound)\)|Not Found' "$work/aws-error"; then
    return 0
  else
    cat "$work/aws-error" >&2
    fail "Could not check s3://$bucket/$key."
  fi
}

verify_size() {
  local key=$1 want=$2 got
  got=$(object_size "$key")
  [[ "$got" == "$want" ]] || fail "s3://$bucket/$key is ${got:-missing}${got:+ bytes} after upload, expected $want bytes."
}

upload() {
  local file=$1 key=$2 type=$3
  r2 s3 cp "$file" "s3://$bucket/$key" --content-type "$type" --only-show-errors --no-progress ||
    fail "Upload to s3://$bucket/$key failed."
  verify_size "$key" "$(file_size "$file")"
  uploaded+=("$key $(file_size "$file")")
}

# Uploads a new object. Refuses to replace one that already exists.
upload_new() {
  local existing
  existing=$(object_size "$2")
  [[ -z "$existing" ]] || fail "s3://$bucket/$2 already exists; refusing to overwrite it."
  upload "$@"
}

summary() {
  local line
  echo "Off-site backup objects in s3://$bucket:"
  for line in "${uploaded[@]}"; do
    printf '  %s  %s bytes\n' "${line% *}" "${line##* }"
  done
  [[ "$encrypted" == true ]] || warn "$PLAIN_WARNING"
  [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || step_summary >>"$GITHUB_STEP_SUMMARY"
}

join_tables() {
  local joined
  joined=$(printf '%s, ' "${SIGN_IN_TABLES[@]}")
  printf '%s\n' "${joined%, }"
}

step_summary() {
  local line
  if [[ "$encrypted" == true ]]; then
    printf '### Off-site backup %s\n\n' "$stamp"
  else
    printf '### Off-site backup %s: NOT ENCRYPTED\n\n**%s**\n\n' "$stamp" "$PLAIN_WARNING"
    printf 'Sign-in records removed: %s. %s\n\n' "$(join_tables)" "$SIGN_IN_REASON"
  fi
  echo "| Object in \`$bucket\` | Bytes |"
  echo "|---|---|"
  for line in "${uploaded[@]}"; do
    printf "| \`%s\` | %s |\n" "${line% *}" "${line##* }"
  done
  if [[ "$encrypted" == false ]]; then
    echo "| env/: skipped, never stored unencrypted (no BACKUP_AGE_PUBLIC_KEY) | |"
  elif [[ "$env_uploaded" == false ]]; then
    echo "| env/: unchanged, not uploaded | |"
  fi
}

# Saves the environment variables, encrypted, to env/ when they or the
# recipient changed since the copy state/env-fingerprint.txt describes.
save_environment() {
  local env_file="$work/env.txt" env_fingerprint previous_fingerprint=""
  convex env list --include-values >"$env_file" || fail "npx convex env list failed."
  [[ -s "$env_file" ]] || fail "npx convex env list returned no variables."
  # The fingerprint covers the recipient too. After the backup key changes,
  # the newest env/ copy must open with the new key even when no variable
  # changed: the old private key may be the one that was lost.
  env_fingerprint=$(printf '%s\n' "$recipient" | cat - "$env_file" | sha256sum)
  env_fingerprint=${env_fingerprint%% *}
  if [[ -n "$(object_size "$fingerprint_key")" ]]; then
    r2 s3api get-object --bucket "$bucket" --key "$fingerprint_key" "$work/previous-fingerprint.txt" >/dev/null ||
      fail "Could not read s3://$bucket/$fingerprint_key."
    previous_fingerprint=$(tr -d '[:space:]' <"$work/previous-fingerprint.txt")
  fi
  if [[ "$previous_fingerprint" == "$env_fingerprint" ]]; then
    echo "Environment variables and the backup key are unchanged since the last copy; not uploaded."
    rm -f -- "$env_file"
    return 0
  fi
  age -r "$recipient" -o "$work/env.txt.age" "$env_file" || fail "age could not encrypt the environment variables."
  rm -f -- "$env_file"
  upload_new "$work/env.txt.age" "$env_key" application/octet-stream
  printf '%s\n' "$env_fingerprint" >"$work/env-fingerprint.txt"
  upload "$work/env-fingerprint.txt" "$fingerprint_key" text/plain
  env_uploaded=true
}

# Refuses an export whose auth tables differ from what the strip list was
# written for: a missing sign-in table, or an auth* table (at the top level or
# in a component) that is neither stripped nor known to hold no credential.
check_auth_tables() {
  local table
  for table in "${SIGN_IN_TABLES[@]}"; do
    grep -qxF "$table/documents.jsonl" "$work/entries.txt" ||
      fail "The export has no $table table, so the list of sign-in tables to remove (ADR-0014) is out of date. Nothing was uploaded; update SIGN_IN_TABLES in scripts/backup/nightly.sh."
  done
  while IFS= read -r table; do
    is_known_auth_table "$table" ||
      fail "The export has an auth table that is not on the sign-in allowlist: $table. Nothing was uploaded. Check whether it lets someone sign in, then add it to SIGN_IN_TABLES or KEPT_AUTH_TABLES in scripts/backup/nightly.sh (ADR-0014)."
  done < <(sed -n 's|/documents\.jsonl$||p' "$work/entries.txt" | grep -E '(^|/)auth[^/]*$' || true)
}

is_known_auth_table() {
  local known
  for known in "${SIGN_IN_TABLES[@]}" "${KEPT_AUTH_TABLES[@]}"; do
    [[ "$1" != "$known" ]] || return 0
  done
  return 1
}

# Replaces each sign-in table's documents.jsonl, and its generated_schema.jsonl
# when there is one, with an empty file. The table stays in the ZIP, so an
# import still creates it.
empty_sign_in_tables() {
  local blank="$work/blank" table file entries=()
  for table in "${SIGN_IN_TABLES[@]}"; do
    mkdir -p "$blank/$table"
    for file in documents.jsonl generated_schema.jsonl; do
      grep -qxF "$table/$file" "$work/entries.txt" || continue
      : >"$blank/$table/$file"
      entries+=("$table/$file")
    done
  done
  (cd "$blank" && zip -qXD "$EXPORT_ZIP" "${entries[@]}") ||
    fail "Could not remove the sign-in records from the export."
  rm -rf -- "$blank"
  unzip -tq "$EXPORT_ZIP" >/dev/null 2>&1 ||
    fail "The export is not a valid ZIP file after removing the sign-in records."
  echo "Sign-in records removed from the unencrypted copy: ${SIGN_IN_TABLES[*]}."
}

uploaded=()
env_uploaded=false
read -r year month day stamp iso < <(date -u '+%Y %m %d %Y%m%dT%H%M%SZ %Y-%m-%dT%H:%M:%SZ')
# The name says when a copy is not encrypted, so a listing cannot mislead.
if [[ "$encrypted" == true ]]; then
  base="angelone-${stamp}"
  stored_ext=".zip.age"
else
  base="angelone-${stamp}.unencrypted"
  stored_ext=".zip"
fi
PLAIN_WARNING="NOT ENCRYPTED: this backup is stored unencrypted in R2 (ADR-0014). Anyone with the R2 keys or the Cloudflare login can read every record, user, password hash and file in it."
# The Convex Auth tables that let a copy be used to sign in: live sessions,
# refresh tokens (the token is its row id and the session id), sign-in and
# password-reset codes, and OAuth verifiers. A plain copy keeps them, empty.
# users and authAccounts stay: a restore needs them, and a password hash
# signs nobody in without being cracked.
SIGN_IN_TABLES=(authSessions authRefreshTokens authVerificationCodes authVerifiers)
# The other Convex Auth tables, which hold no way to sign in: password hashes
# and sign-in attempt counts. Any other auth* table fails a plain run.
KEPT_AUTH_TABLES=(authAccounts authRateLimits)
SIGN_IN_REASON="Emptied so that a copy cannot be used to sign in. After a restore everyone must sign in again."
daily_key="daily/${year}/${month}/${day}/${base}${stored_ext}"
daily_manifest_key="daily/${year}/${month}/${day}/${base}.manifest.json"
monthly_prefix="monthly/${year}-${month}/"
env_key="env/angelone-env-${stamp}.txt.age"
fingerprint_key="state/env-fingerprint.txt"

# ---------------------------------------------------------------------------
# a. Export, with file storage, and check the ZIP.

# The plaintext export. It stays in the temp dir until the script exits (the
# EXIT trap removes it), so a later step can still read it.
EXPORT_ZIP="$work/backup.zip"
echo "Exporting the production deployment with file storage..."
convex export --include-file-storage --path "$EXPORT_ZIP" || fail "npx convex export failed."
[[ -s "$EXPORT_ZIP" ]] || fail "npx convex export produced no file."
unzip -tq "$EXPORT_ZIP" >/dev/null 2>&1 || fail "The export is not a valid ZIP file (unzip -t failed)."
unzip -Z1 "$EXPORT_ZIP" >"$work/entries.txt"
# Before counting and hashing, so the manifest describes the uploaded ZIP.
# Emptying replaces entries in place, so the listing stays right.
if [[ "$encrypted" == false ]]; then
  check_auth_tables
  empty_sign_in_tables
fi

# Document count per table: one JSON document per line of <table>/documents.jsonl
# (components are under _components/<name>/). Uploaded files are not read.
: >"$work/tables.tsv"
while IFS= read -r entry; do
  count=$(unzip -p "$EXPORT_ZIP" "$entry" | awk 'END { print NR }')
  printf '%s\t%s\n' "${entry%/documents.jsonl}" "$count" >>"$work/tables.tsv"
done < <(grep -E '^[A-Za-z0-9_./-]+/documents\.jsonl$' "$work/entries.txt" | LC_ALL=C sort || true)
app_documents=$(awk -F '\t' '$1 !~ /^_/ { n += $2 } END { print n + 0 }' "$work/tables.tsv")
((app_documents > 0)) || fail "The export has no documents in any table; refusing to store it as a backup."
# A copy that cannot bring back the uploaded files or any account is not a
# backup. Convex writes _storage/documents.jsonl whenever file storage is
# included, even with no files, so its absence means the files were left out;
# and with no user nobody could sign in after a restore. Nothing compares the
# table counts with earlier nights.
grep -qxF '_storage/documents.jsonl' "$work/entries.txt" ||
  fail "The export has no file storage (_storage/documents.jsonl is missing); refusing to store it as a backup."
user_accounts=$(awk -F '\t' '$1 == "users" { n = $2 } END { print n + 0 }' "$work/tables.tsv")
((user_accounts > 0)) || fail "The export has no user accounts (users table); refusing to store it as a backup."
tables_json=$(jq -R -n '[inputs | split("\t") | {key: .[0], value: (.[1] | tonumber)}] | from_entries' <"$work/tables.tsv")

# ---------------------------------------------------------------------------
# b. Hash, and encrypt when there is a key. stored_file is what goes to R2.

plain_sha=$(sha256_of "$EXPORT_ZIP")
plain_bytes=$(file_size "$EXPORT_ZIP")
stored_file=$EXPORT_ZIP
if [[ "$encrypted" == true ]]; then
  stored_file="$work/${base}.zip.age"
  age -r "$recipient" -o "$stored_file" "$EXPORT_ZIP" || fail "age could not encrypt the export."
  AGE_HEADER="age-encryption.org/v1"
  [[ "$(head -c "${#AGE_HEADER}" "$stored_file")" == "$AGE_HEADER" ]] || fail "The encrypted file is not an age file."
fi
stored_sha=$(sha256_of "$stored_file")
stored_bytes=$(file_size "$stored_file")
stored_type=application/octet-stream
[[ "$encrypted" == true ]] || stored_type=application/zip

# ---------------------------------------------------------------------------
# c. Upload with a manifest (no personal data, no secrets), then check.

convex_version=$(npx convex --version 2>/dev/null | head -n 1) || convex_version=unknown
commit=${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}
manifest="$work/${base}.manifest.json"
# Without a key, "encrypted" is false, "notice" says so in plain words and
# "signInRecordsRemoved" names the emptied tables; with one, the manifest is
# the same as before ADR-0014.
jq -n \
  --arg file "${base}${stored_ext}" \
  --arg exportStartedAt "$iso" \
  --arg gitCommit "$commit" \
  --arg convexCliVersion "$convex_version" \
  --argjson isEncrypted "$encrypted" --arg recipient "$recipient" \
  --arg notice "$PLAIN_WARNING" \
  --argjson signInTables "$(printf '%s\n' "${SIGN_IN_TABLES[@]}" | jq -R . | jq -s .)" \
  --arg signInReason "$SIGN_IN_REASON" \
  --arg plainSha "$plain_sha" --argjson plainBytes "$plain_bytes" \
  --arg encSha "$stored_sha" --argjson encBytes "$stored_bytes" \
  --argjson tables "$tables_json" \
  '{format: 1, file: $file}
   + (if $isEncrypted then {} else {encrypted: false, notice: $notice,
      signInRecordsRemoved: {tables: $signInTables, reason: $signInReason}} end)
   + {exportStartedAt: $exportStartedAt, gitCommit: $gitCommit,
      convexCliVersion: $convexCliVersion}
   + (if $isEncrypted then {encryptedTo: $recipient} else {} end)
   + {plaintext: {sha256: $plainSha, bytes: $plainBytes}}
   + (if $isEncrypted then {encrypted: {sha256: $encSha, bytes: $encBytes}} else {} end)
   + {tables: $tables}' >"$manifest"

echo "Uploading to R2..."
upload_new "$stored_file" "$daily_key" "$stored_type"
upload_new "$manifest" "$daily_manifest_key" application/json

# ---------------------------------------------------------------------------
# d. The first successful night of each month is also the monthly copy.

monthly_key=""
# An empty prefix lists no Contents at all; the JMESPath literal `[]` makes
# that a count of 0.
monthly_count=$(r2 s3api list-objects-v2 --bucket "$bucket" --prefix "$monthly_prefix" \
  --max-keys 1 --no-paginate --query "length(Contents || \`[]\`)" --output text) ||
  fail "Could not list s3://$bucket/$monthly_prefix."
[[ "$monthly_count" =~ ^[0-9]+$ ]] || fail "Unexpected answer listing s3://$bucket/$monthly_prefix."
if ((monthly_count == 0)); then
  monthly_key="${monthly_prefix}${base}${stored_ext}"
  upload_new "$stored_file" "$monthly_key" "$stored_type"
  upload_new "$manifest" "${monthly_prefix}${base}.manifest.json" application/json
fi

# ---------------------------------------------------------------------------
# e. Environment variables, only when they or the backup key changed. The
# fingerprint lives in state/, which is not locked; env/ is locked forever.
# They hold the credential and sign-in keys and were only ever stored
# encrypted, so without a key they are neither read nor uploaded (ADR-0014).

if [[ "$encrypted" == true ]]; then
  save_environment
else
  echo "Environment variables not saved: they are stored only encrypted, and BACKUP_AGE_PUBLIC_KEY is not set."
fi

# ---------------------------------------------------------------------------
# f. Record the copy in the app (Settings > System and the 26-hour warning).
# bytes and sha256 describe the stored object, the one a person can check in
# the bucket (the plain ZIP without a key); the manifest also holds the ZIP's.

completed_at=$(($(date -u +%s) * 1000))
record=$(jq -cn \
  --argjson completedAt "$completed_at" \
  --arg objectKey "$daily_key" \
  --argjson bytes "$stored_bytes" \
  --arg sha256 "$stored_sha" \
  --arg monthlyKey "$monthly_key" \
  --argjson envUploaded "$env_uploaded" \
  '{completedAt: $completedAt, objectKey: $objectKey, bytes: $bytes, sha256: $sha256}
   + (if $monthlyKey == "" then {} else {monthlyKey: $monthlyKey} end)
   + {envUploaded: $envUploaded}')

summary
echo "Recording the copy in the app..."
if ! CONVEX_DEPLOY_KEY="$deploy_key" npx convex run backups:recordOffsiteCopy "$record"; then
  fail "The backup itself succeeded and is in R2 (listed above), but recording it in the app failed (backups:recordOffsiteCopy). The app will not know about this copy and will warn after 26 hours. Check that the function is deployed and the deploy key works, then run the workflow again."
fi

# ---------------------------------------------------------------------------
# g. Readable copy in Dropbox (ADR-0011), only when it is set up. It runs after
# the R2 copy is recorded, so a Dropbox failure fails the run (and sends
# GitHub's failure email) without hiding a good off-site copy. It reads the plaintext export,
# which stays in the temp dir until the trap removes it.

if [[ -n "$dropbox_refresh_token" ]]; then
  echo "Making the readable records workbook for Dropbox..."
  records_tz=${RECORDS_TIME_ZONE:-America/New_York}
  records_xlsx="$work/angel-one-records.xlsx"
  node scripts/backup/records-workbook.mjs --zip "$EXPORT_ZIP" --out "$records_xlsx" --tz "$records_tz" ||
    fail "The R2 backup succeeded and is recorded, but the readable workbook could not be made (scripts/backup/records-workbook.mjs). See docs/runbooks/dropbox-records-copy.md."
  DROPBOX_APP_KEY="$dropbox_app_key" DROPBOX_APP_SECRET="$dropbox_app_secret" \
    DROPBOX_REFRESH_TOKEN="$dropbox_refresh_token" \
    node scripts/backup/dropbox-upload.mjs --file "$records_xlsx" --tz "$records_tz" ||
    fail "The R2 backup succeeded and is recorded, but the Dropbox copy failed (scripts/backup/dropbox-upload.mjs). See docs/runbooks/dropbox-records-copy.md."
  rm -f "$records_xlsx"
else
  echo "Dropbox copy skipped: DROPBOX_REFRESH_TOKEN is not set (docs/runbooks/dropbox-records-copy.md)."
fi
echo "Done."
