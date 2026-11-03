#!/usr/bin/env bash
#
# Nightly off-site backup of the production Convex deployment (ADR-0008).
# Run by .github/workflows/backup.yml. Runbook: docs/runbooks/backup-restore.md.
#
#   a. `npx convex export --include-file-storage`, checked with `unzip -t`;
#   b. encrypted with age to BACKUP_AGE_PUBLIC_KEY;
#   c. uploaded to R2 under daily/YYYY/MM/DD/ with a manifest, then checked;
#   d. also uploaded to monthly/YYYY-MM/ when that month has no copy yet;
#   e. environment variables, encrypted, uploaded to env/ when they changed;
#   f. recorded in the app with `npx convex run backups:recordOffsiteCopy`.
#
# Environment:
#   CONVEX_DEPLOY_KEY      production deploy key (prod:...)
#   BACKUP_AGE_PUBLIC_KEY  age public key (age1...)
#   R2_ACCOUNT_ID          Cloudflare account ID
#   R2_ACCESS_KEY_ID       R2 API token: object read and write on the bucket
#   R2_SECRET_ACCESS_KEY
#   R2_BUCKET              optional, default angelone-backups
#
# The plaintext export is kept in this script's temp dir (mode 700) until it
# exits, then removed with it. The script never deletes or overwrites a backup
# in the bucket; the only object it replaces is state/env-fingerprint.txt.
# It prints object keys and sizes, never a secret or the environment variables.
# Tests: npm run test:backup.

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
[[ "$recipient" =~ ^age1[0-9a-z]+$ ]] || fail "BACKUP_AGE_PUBLIC_KEY must be an age public key (age1...)."

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

for cmd in npx aws age unzip jq sha256sum; do
  command -v "$cmd" >/dev/null || fail "$cmd is not installed."
done

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
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Off-site backup ${stamp}"
      echo ""
      echo "| Object in \`$bucket\` | Bytes |"
      echo "|---|---|"
      for line in "${uploaded[@]}"; do
        # shellcheck disable=SC2016 # Markdown backticks, not a command.
        printf '| `%s` | %s |\n' "${line% *}" "${line##* }"
      done
      [[ "$env_uploaded" == true ]] || echo "| env/: unchanged, not uploaded | |"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
}

uploaded=()
env_uploaded=false
read -r year month day stamp iso < <(date -u '+%Y %m %d %Y%m%dT%H%M%SZ %Y-%m-%dT%H:%M:%SZ')
base="angelone-${stamp}"
daily_key="daily/${year}/${month}/${day}/${base}.zip.age"
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

# Document count per table: one JSON document per line of <table>/documents.jsonl
# (components are under _components/<name>/). Uploaded files are not read.
unzip -Z1 "$EXPORT_ZIP" >"$work/entries.txt"
: >"$work/tables.tsv"
while IFS= read -r entry; do
  count=$(unzip -p "$EXPORT_ZIP" "$entry" | awk 'END { print NR }')
  printf '%s\t%s\n' "${entry%/documents.jsonl}" "$count" >>"$work/tables.tsv"
done < <(grep -E '^[A-Za-z0-9_./-]+/documents\.jsonl$' "$work/entries.txt" | LC_ALL=C sort || true)
app_documents=$(awk -F '\t' '$1 !~ /^_/ { n += $2 } END { print n + 0 }' "$work/tables.tsv")
((app_documents > 0)) || fail "The export has no documents in any table; refusing to store it as a backup."
tables_json=$(jq -R -n '[inputs | split("\t") | {key: .[0], value: (.[1] | tonumber)}] | from_entries' <"$work/tables.tsv")

# ---------------------------------------------------------------------------
# b. Hash and encrypt.

plain_sha=$(sha256_of "$EXPORT_ZIP")
plain_bytes=$(file_size "$EXPORT_ZIP")
enc_file="$work/${base}.zip.age"
age -r "$recipient" -o "$enc_file" "$EXPORT_ZIP" || fail "age could not encrypt the export."
[[ "$(head -c 21 "$enc_file")" == "age-encryption.org/v1" ]] || fail "The encrypted file is not an age file."
enc_sha=$(sha256_of "$enc_file")
enc_bytes=$(file_size "$enc_file")

# ---------------------------------------------------------------------------
# c. Upload with a manifest (no personal data, no secrets), then check.

convex_version=$(npx convex --version 2>/dev/null | head -n 1) || convex_version=unknown
commit=${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}
manifest="$work/${base}.manifest.json"
jq -n \
  --arg file "${base}.zip.age" \
  --arg exportStartedAt "$iso" \
  --arg gitCommit "$commit" \
  --arg convexCliVersion "$convex_version" \
  --arg recipient "$recipient" \
  --arg plainSha "$plain_sha" --argjson plainBytes "$plain_bytes" \
  --arg encSha "$enc_sha" --argjson encBytes "$enc_bytes" \
  --argjson tables "$tables_json" \
  '{
    format: 1,
    file: $file,
    exportStartedAt: $exportStartedAt,
    gitCommit: $gitCommit,
    convexCliVersion: $convexCliVersion,
    encryptedTo: $recipient,
    plaintext: {sha256: $plainSha, bytes: $plainBytes},
    encrypted: {sha256: $encSha, bytes: $encBytes},
    tables: $tables
  }' >"$manifest"

echo "Uploading to R2..."
upload_new "$enc_file" "$daily_key" application/octet-stream
upload_new "$manifest" "$daily_manifest_key" application/json

# ---------------------------------------------------------------------------
# d. The first successful night of each month is also the monthly copy.

monthly_key=""
# shellcheck disable=SC2016 # JMESPath literal, not a command.
monthly_count=$(r2 s3api list-objects-v2 --bucket "$bucket" --prefix "$monthly_prefix" \
  --max-keys 1 --no-paginate --query 'length(Contents || `[]`)' --output text) ||
  fail "Could not list s3://$bucket/$monthly_prefix."
[[ "$monthly_count" =~ ^[0-9]+$ ]] || fail "Unexpected answer listing s3://$bucket/$monthly_prefix."
if ((monthly_count == 0)); then
  monthly_key="${monthly_prefix}${base}.zip.age"
  upload_new "$enc_file" "$monthly_key" application/octet-stream
  upload_new "$manifest" "${monthly_prefix}${base}.manifest.json" application/json
fi

# ---------------------------------------------------------------------------
# e. Environment variables, only when they changed. The fingerprint lives in
# state/, which is not locked; env/ is locked forever.

env_file="$work/env.txt"
convex env list --include-values >"$env_file" || fail "npx convex env list failed."
[[ -s "$env_file" ]] || fail "npx convex env list returned no variables."
env_fingerprint=$(sha256_of "$env_file")
previous_fingerprint=""
fingerprint_size=$(object_size "$fingerprint_key")
if [[ -n "$fingerprint_size" ]]; then
  r2 s3api get-object --bucket "$bucket" --key "$fingerprint_key" "$work/previous-fingerprint.txt" >/dev/null ||
    fail "Could not read s3://$bucket/$fingerprint_key."
  previous_fingerprint=$(tr -d '[:space:]' <"$work/previous-fingerprint.txt")
fi
if [[ "$previous_fingerprint" == "$env_fingerprint" ]]; then
  echo "Environment variables are unchanged since the last copy; not uploaded."
  rm -f -- "$env_file"
else
  age -r "$recipient" -o "$work/env.txt.age" "$env_file" || fail "age could not encrypt the environment variables."
  rm -f -- "$env_file"
  upload_new "$work/env.txt.age" "$env_key" application/octet-stream
  printf '%s\n' "$env_fingerprint" >"$work/env-fingerprint.txt"
  upload "$work/env-fingerprint.txt" "$fingerprint_key" text/plain
  env_uploaded=true
fi

# ---------------------------------------------------------------------------
# f. Record the copy in the app (Settings > System and the 36-hour warning).

completed_at=$(($(date -u +%s) * 1000))
record=$(jq -cn \
  --argjson completedAt "$completed_at" \
  --arg objectKey "$daily_key" \
  --argjson bytes "$enc_bytes" \
  --arg sha256 "$plain_sha" \
  --arg monthlyKey "$monthly_key" \
  --argjson envUploaded "$env_uploaded" \
  '{completedAt: $completedAt, objectKey: $objectKey, bytes: $bytes, sha256: $sha256}
   + (if $monthlyKey == "" then {} else {monthlyKey: $monthlyKey} end)
   + {envUploaded: $envUploaded}')

summary
echo "Recording the copy in the app..."
if ! CONVEX_DEPLOY_KEY="$deploy_key" npx convex run backups:recordOffsiteCopy "$record"; then
  fail "The backup itself succeeded and is in R2 (listed above), but recording it in the app failed (backups:recordOffsiteCopy). The app will not know about this copy and will warn after 36 hours. Check that the function is deployed and the deploy key works, then run the workflow again."
fi

# ---------------------------------------------------------------------------
# g. Readable copy in Dropbox (ADR-0011), only when it is set up. It runs after
# the R2 copy is recorded, so a Dropbox failure fails the run (and emails the
# owner) without hiding a good off-site copy. It reads the plaintext export,
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
