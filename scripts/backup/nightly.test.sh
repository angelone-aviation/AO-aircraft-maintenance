#!/usr/bin/env bash
# Responsibility: Tests scripts/backup/nightly.sh and decrypt.sh end to end,
#   including the Dropbox step, without credentials or network.
# Layer: Test. Never shipped; never touches a real bucket or deployment.
# Dependencies: bash, age, age-keygen, zip, unzip, jq, sha256sum, cmp;
#   scripts/backup/nightly.sh, scripts/backup/decrypt.sh.
#
# Fake `npx` (Convex CLI), `aws` (R2) and `node` commands come first on PATH,
# the bucket is a folder, and the age key pair is thrown away afterwards.
# Run: npm run test:backup.

# Single-quoted jq programs and bash -c snippets are expanded by jq or the inner
# shell, on purpose.
# shellcheck disable=SC2016

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/nightly.sh"

for cmd in age age-keygen zip unzip jq sha256sum cmp; do
  command -v "$cmd" >/dev/null || {
    echo "test:backup needs $cmd (Ubuntu: sudo apt-get install age zip unzip jq)" >&2
    exit 1
  }
done

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
bin="$tmp/bin"
mkdir -p "$bin"

# Fake secrets. None of them may ever appear in the script's output.
deploy_key="prod:angelone-test|fake-deploy-key-7f3a9c41"
r2_account="0123456789abcdef0123456789abcdef"
r2_key_id="fake-r2-access-key-id-5d2e"
r2_secret="fake-r2-secret-access-key-4b1e8d2c"
env_secrets=(fake-jwt-private-key-body-91c2 fake-jwks-value-3e7f fake-credentials-key-a8d0 fake-resend-key-6b19 fake-rotated-credentials-key-0c55)

age-keygen -o "$tmp/key.txt" 2>/dev/null
public_key=$(age-keygen -y "$tmp/key.txt")
# The key the operator changes to ("Changing the backup key" in the runbook).
age-keygen -o "$tmp/new-key.txt" 2>/dev/null
new_public_key=$(age-keygen -y "$tmp/new-key.txt")

write_env() { # write_env <credentials key value>
  cat >"$tmp/env.txt" <<EOF
CREDENTIALS_ENCRYPTION_KEY=$1
JWKS='{"keys":[{"kty":"RSA","n":"fake-jwks-value-3e7f"}]}'
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
fake-jwt-private-key-body-91c2
-----END PRIVATE KEY-----"
RESEND_API_KEY=fake-resend-key-6b19
SITE_URL=https://app.example.org
EOF
}

# ---------------------------------------------------------------------------
# Fake Convex CLI.

cat >"$bin/npx" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
die() { echo "fake npx: $*" >&2; exit 99; }
printf '%s\n' "$*" >>"$FAKE_STATE/npx-calls.log"
[[ -z "${R2_SECRET_ACCESS_KEY:-}${AWS_SECRET_ACCESS_KEY:-}${R2_ACCESS_KEY_ID:-}" ]] ||
  die "R2 credentials reached the Convex CLI's environment"
[[ "${1:-}" == convex ]] || die "unexpected call: $*"
shift
if [[ "$*" == "--version" ]]; then
  echo "1.49.0"
  exit 0
fi
[[ "${CONVEX_DEPLOY_KEY:-}" == "$FAKE_DEPLOY_KEY" ]] || die "CONVEX_DEPLOY_KEY missing or wrong"
case "$1" in
  export)
    [[ $# -eq 4 && "$2" == --include-file-storage && "$3" == --path ]] || die "unexpected export call: $*"
    path=$4
    [[ "$path" == /* && ! -e "$path" ]] || die "export path must be absolute and unused"
    case "${FAKE_EXPORT:-ok}" in
      fail) echo "Error: export failed (fake)" >&2; exit 1 ;;
      corrupt) echo "not a zip file" >"$path" ;;
      *)
        src=$(mktemp -d)
        echo "# Convex snapshot (fake)" >"$src/README.md"
        mkdir -p "$src/_storage"
        printf '{"_id":"kg2storage%s","sha256":"x","size":5}\n' "$RANDOM" >"$src/_storage/documents.jsonl"
        printf 'hello' >"$src/_storage/kg2storage"
        if [[ "${FAKE_EXPORT:-ok}" == ok ]]; then
          mkdir -p "$src/users" "$src/aircraft"
          printf '{"_id":"u1","name":"Pilot %s"}\n{"_id":"u2","name":"Mechanic"}\n' "$RANDOM" >"$src/users/documents.jsonl"
          printf '{"_id":"a1","tail":"N1"}\n{"_id":"a2","tail":"N2"}\n{"_id":"a3","tail":"N3"}\n' >"$src/aircraft/documents.jsonl"
          echo '{"type":"object"}' >"$src/users/generated_schema.jsonl"
        fi
        (cd "$src" && zip -qrX "$path" .)
        rm -rf "$src"
        ;;
    esac
    cp "$path" "$FAKE_STATE/last-export.zip"
    echo "Downloaded snapshot export to $path (fake)"
    ;;
  env)
    [[ "$*" == "env list --include-values" ]] || die "unexpected env call: $*"
    cat "$FAKE_ENV_FILE"
    ;;
  run)
    [[ $# -eq 3 && "$2" == backups:recordOffsiteCopy ]] || die "unexpected run call: $*"
    if [[ "${FAKE_RECORD:-ok}" == fail ]]; then
      echo "Error: Could not find function backups:recordOffsiteCopy (fake)" >&2
      exit 1
    fi
    printf '%s\n' "$3" >>"$FAKE_STATE/record.log"
    echo "null"
    ;;
  *) die "unexpected call: $*" ;;
esac
FAKE

# ---------------------------------------------------------------------------
# Fake AWS CLI over a folder per bucket. Failures are injected with FAKE_*
# regular expressions matched against object keys.

cat >"$bin/aws" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
die() { echo "fake aws: $*" >&2; exit 99; }
printf '%s\n' "$*" >>"$FAKE_STATE/aws-calls.log"
[[ -z "${CONVEX_DEPLOY_KEY:-}" ]] || die "the Convex deploy key reached the AWS CLI's environment"
[[ "${AWS_ACCESS_KEY_ID:-}" == "$FAKE_R2_KEY_ID" && "${AWS_SECRET_ACCESS_KEY:-}" == "$FAKE_R2_SECRET" ]] ||
  die "R2 credentials missing or wrong"
[[ "${AWS_REQUEST_CHECKSUM_CALCULATION:-}" == when_required && "${AWS_RESPONSE_CHECKSUM_VALIDATION:-}" == when_required ]] ||
  die "checksum settings missing"

endpoint="" region="" no_paginate=0 positional=()
declare -A opt=()
while (($#)); do
  case "$1" in
    --endpoint-url) endpoint=$2; shift 2 ;;
    --region) region=$2; shift 2 ;;
    --no-paginate) no_paginate=1; shift ;;
    --only-show-errors | --no-progress) shift ;;
    --*) opt[${1#--}]=$2; shift 2 ;;
    *) positional+=("$1"); shift ;;
  esac
done
[[ "$endpoint" == "https://$FAKE_R2_ACCOUNT.r2.cloudflarestorage.com" ]] || die "wrong endpoint"
[[ "$region" == auto ]] || die "region must be auto"
set -- "${positional[@]}"
root="$FAKE_STATE/r2"
matches() { [[ -n "${1:-}" && "$2" =~ $1 ]]; }
not_found() { printf '\nAn error occurred (404) when calling the HeadObject operation: Not Found\n' >&2; exit 254; }

case "$1 $2" in
  "s3 cp")
    src=$3 dst=$4
    [[ -f "$src" && "$dst" == s3://* ]] || die "only local-to-bucket copies are supported"
    [[ -n "${opt[content-type]:-}" ]] || die "content type missing"
    rest=${dst#s3://} bucket=${rest%%/*} key=${rest#*/}
    if matches "${FAKE_FAIL_PUT:-}" "$key"; then
      echo "upload failed: $src to $dst An error occurred (AccessDenied) when calling the PutObject operation: Access Denied" >&2
      exit 1
    fi
    if [[ -e "$root/$bucket/$key" && "$key" =~ ^(daily|monthly|env)/ ]]; then
      echo "upload failed: $dst An error occurred (AccessDenied): object is locked" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$root/$bucket/$key")"
    if matches "${FAKE_TRUNCATE_PUT:-}" "$key"; then
      head -c 10 "$src" >"$root/$bucket/$key"
    else
      cp "$src" "$root/$bucket/$key"
    fi
    ;;
  "s3api head-object")
    [[ "${opt[query]:-}" == ContentLength && "${opt[output]:-}" == text ]] || die "unsupported head-object call"
    file="$root/${opt[bucket]}/${opt[key]}"
    if matches "${FAKE_EXISTS:-}" "${opt[key]}"; then echo 1; exit 0; fi
    [[ -f "$file" ]] || not_found
    if matches "${FAKE_FAIL_HEAD_AFTER_PUT:-}" "${opt[key]}"; then
      printf '\nAn error occurred (403) when calling the HeadObject operation: Forbidden\n' >&2
      exit 254
    fi
    wc -c <"$file" | tr -d ' '
    ;;
  "s3api get-object")
    file="$root/${opt[bucket]}/${opt[key]}"
    [[ -f "$file" ]] || { echo "An error occurred (NoSuchKey) when calling the GetObject operation" >&2; exit 254; }
    cp "$file" "$3"
    printf '{"ContentLength": %s}\n' "$(wc -c <"$file" | tr -d ' ')"
    ;;
  "s3api list-objects-v2")
    [[ "${opt[query]:-}" == 'length(Contents || `[]`)' && "${opt[output]:-}" == text ]] || die "unsupported list query"
    [[ "$no_paginate" == 1 && "${opt[max-keys]:-}" == 1 ]] || die "list must ask for one key, unpaginated"
    dir="$root/${opt[bucket]}/${opt[prefix]}"
    if [[ -d "$dir" ]] && [[ -n "$(find "$dir" -type f | head -n 1)" ]]; then echo 1; else echo 0; fi
    ;;
  *) die "unsupported call: $*" ;;
esac
FAKE
chmod +x "$bin/npx" "$bin/aws"

# ---------------------------------------------------------------------------
# Test helpers.

failures=0
pass() { printf 'ok - %s\n' "$1"; }
flunk() {
  printf 'not ok - %s\n' "$1"
  failures=$((failures + 1))
}
check() { # check <description> <command...>
  local description=$1
  shift
  if "$@"; then pass "$description"; else flunk "$description"; fi
}

state=""
fresh_bucket() {
  state="$tmp/state-$1"
  mkdir -p "$state/r2/angelone-backups"
  : >"$state/aws-calls.log"
  : >"$state/npx-calls.log"
  : >"$state/record.log"
}

# Object keys are stamped to the second; start each run in a new second.
last_second=""
next_second() {
  while [[ "$(date -u +%s)" == "$last_second" ]]; do sleep 0.1; done
  last_second=$(date -u +%s)
}

status=0
out=""
run_backup() { # run_backup <name> [VAR=value...]
  local name=$1
  shift
  next_second
  out="$tmp/out-$name.txt"
  mkdir -p "$tmp/runtmp-$name"
  status=0
  env -i PATH="$bin:$PATH" HOME="$HOME" LANG=C.UTF-8 TMPDIR="$tmp/runtmp-$name" \
    GITHUB_SHA=0123456789abcdef0123456789abcdef01234567 GITHUB_STEP_SUMMARY="$tmp/summary-$name.md" \
    FAKE_STATE="$state" FAKE_ENV_FILE="$tmp/env.txt" FAKE_DEPLOY_KEY="$deploy_key" \
    FAKE_R2_ACCOUNT="$r2_account" FAKE_R2_KEY_ID="$r2_key_id" FAKE_R2_SECRET="$r2_secret" \
    CONVEX_DEPLOY_KEY="$deploy_key" BACKUP_AGE_PUBLIC_KEY="$public_key" \
    R2_ACCOUNT_ID="$r2_account" R2_ACCESS_KEY_ID="$r2_key_id" R2_SECRET_ACCESS_KEY="$r2_secret" \
    "$@" bash "$script" >"$out" 2>&1 || status=$?
  # Object names carry the export's second, so the next run must start in a
  # later second than this one finished in, even on a slow, busy machine.
  last_second=$(date -u +%s)
}

bucket_dir() { echo "$state/r2/angelone-backups"; }
objects() { (cd "$(bucket_dir)" && find . -type f | sed 's|^\./||' | LC_ALL=C sort); }
object_count() { objects | grep -cE "$1" || true; }
records() { wc -l <"$state/record.log" | tr -d ' '; }
last_record() { tail -n 1 "$state/record.log"; }

no_secrets_in() { # no_secrets_in <file...>
  local secret
  for secret in "$deploy_key" "${deploy_key#prod:}" "$r2_secret" "$r2_key_id" "${env_secrets[@]}" "AGE-SECRET-KEY"; do
    if grep -qF -- "$secret" "$@" 2>/dev/null; then
      echo "    found a secret value in: $*" >&2
      return 1
    fi
  done
}
no_plaintext_left() { [[ -z "$(find "$tmp/runtmp-$1" -mindepth 1 -print -quit)" ]]; }
exited_ok() { [[ "$status" == 0 ]] || { sed 's/^/    /' "$out" >&2; return 1; }; }
exited_failed() { [[ "$status" != 0 ]]; }
output_says() { grep -qF -- "$1" "$out"; }
nothing_recorded() { [[ "$(records)" == 0 ]]; }
decrypts_to() { age -d -i "$tmp/key.txt" "$1" | cmp -s - "$2"; }
opens_with_new_key() { age -d -i "$tmp/new-key.txt" "$1" 2>/dev/null | cmp -s - "$2"; }
stored_fingerprint() { tr -d '[:space:]' <"$(bucket_dir)/state/env-fingerprint.txt"; }
sha_of() { sha256sum "$1" | cut -d ' ' -f 1; }
jq_true() { jq -e "$@" >/dev/null; }

record_matches_contract() { # record_matches_contract <json> <expect monthly: yes|no> <envUploaded>
  local json=$1 monthly=$2 env_flag=$3 now_ms
  now_ms=$(($(date -u +%s) * 1000))
  jq -e --argjson now "$now_ms" --arg monthly "$monthly" --argjson env "$env_flag" '
    (keys - ["completedAt","objectKey","bytes","sha256","monthlyKey","envUploaded"] | length == 0)
    and (.completedAt | type == "number" and . == floor and . <= $now and . > $now - 300000)
    and (.objectKey | test("^daily/[0-9]{4}/[0-9]{2}/[0-9]{2}/angelone-[0-9]{8}T[0-9]{6}Z\\.zip\\.age$"))
    and (.objectKey as $k | ($k | capture("^daily/(?<y>[0-9]{4})/(?<m>[0-9]{2})/(?<d>[0-9]{2})/angelone-(?<s>[0-9]{8})T")) | .s == .y + .m + .d)
    and (.bytes | type == "number" and . == floor and . > 0)
    and (.sha256 | test("^[0-9a-f]{64}$"))
    and (.envUploaded == $env)
    and (if $monthly == "yes"
         then (.monthlyKey | type == "string" and test("^monthly/[0-9]{4}-[0-9]{2}/angelone-[0-9]{8}T[0-9]{6}Z\\.zip\\.age$"))
              and (.monthlyKey | split("/") | .[2]) == (.objectKey | split("/") | .[4])
              and (.monthlyKey | split("/") | .[1]) == (.objectKey | split("/") | "\(.[1])-\(.[2])")
         else has("monthlyKey") | not end)
  ' <<<"$json" >/dev/null
}

# ---------------------------------------------------------------------------
echo "# first night: daily, monthly and environment copies"
write_env fake-credentials-key-a8d0
fresh_bucket main
run_backup first
check "exits 0" exited_ok
check "records the copy once" test "$(records)" = 1
rec=$(last_record)
check "record is valid JSON matching the contract, with monthlyKey and envUploaded true" \
  record_matches_contract "$rec" yes true
daily_key=$(jq -r .objectKey <<<"$rec")
monthly_key=$(jq -r .monthlyKey <<<"$rec")
daily_file="$(bucket_dir)/$daily_key"
check "daily object exists" test -f "$daily_file"
check "recorded bytes equal the encrypted object's size" test "$(jq .bytes <<<"$rec")" = "$(wc -c <"$daily_file" | tr -d ' ')"
check "daily object decrypts to a byte-identical copy of the export" decrypts_to "$daily_file" "$state/last-export.zip"
check "recorded sha256 is the plaintext ZIP's" test "$(jq -r .sha256 <<<"$rec")" = "$(sha_of "$state/last-export.zip")"
check "monthly copy is the same encrypted file" cmp -s "$daily_file" "$(bucket_dir)/$monthly_key"
manifest="${daily_file%.zip.age}.manifest.json"
check "manifest sits beside the daily object" test -f "$manifest"
check "manifest sits beside the monthly object" test -f "$(bucket_dir)/${monthly_key%.zip.age}.manifest.json"
check "manifest records hashes, sizes, commit, CLI version and table counts" jq_true \
  --arg sha "$(jq -r .sha256 <<<"$rec")" --argjson bytes "$(jq .bytes <<<"$rec")" \
  --argjson plainBytes "$(wc -c <"$state/last-export.zip" | tr -d ' ')" --arg encSha "$(sha_of "$daily_file")" '
    .plaintext.sha256 == $sha and .plaintext.bytes == $plainBytes
    and .encrypted.sha256 == $encSha and .encrypted.bytes == $bytes
    and .gitCommit == "0123456789abcdef0123456789abcdef01234567" and .convexCliVersion == "1.49.0"
    and .tables == {"_storage": 1, "aircraft": 3, "users": 2}
    and (.exportStartedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))' "$manifest"
check "exactly one env/ object, named by the run's time" test "$(object_count '^env/angelone-env-[0-9]{8}T[0-9]{6}Z\.txt\.age$')" = 1
env_object="$(bucket_dir)/$(objects | grep '^env/')"
check "env/ object decrypts to the environment variables" decrypts_to "$env_object" "$tmp/env.txt"
first_fingerprint=$(stored_fingerprint)
check "fingerprint stored in state/, outside the locked prefixes" \
  grep -qE '^[0-9a-f]{64}$' <<<"$first_fingerprint"
check "every stored .age object is encrypted" bash -c \
  'for f in "$1"/daily/*/*/*/*.age "$1"/monthly/*/*.age "$1"/env/*.age; do [[ "$(head -c 21 "$f")" == age-encryption.org/v1 ]] || exit 1; done' _ "$(bucket_dir)"
check "no plaintext left after exit" no_plaintext_left first
check "no secret in the output, the step summary or any command line" \
  no_secrets_in "$out" "$tmp/summary-first.md" "$state/aws-calls.log" "$state/npx-calls.log"
check "no environment value in any manifest" no_secrets_in "$manifest"
check "summary lists the daily object" output_says "$daily_key"

echo "# decrypt helper (restore rehearsal)"
mkdir -p "$tmp/restore"
cp "$daily_file" "$manifest" "$tmp/restore/"
restore_age="$tmp/restore/${daily_file##*/}"
check "decrypt.sh decrypts and checks the manifest" \
  bash -c '"$1" "$2" "$3" >"$4" 2>&1' _ "$here/decrypt.sh" "$tmp/key.txt" "$restore_age" "$tmp/out-decrypt.txt"
check "decrypt.sh writes a byte-identical export" cmp -s "${restore_age%.age}" "$state/last-export.zip"
check "decrypt.sh prints the table counts" grep -qE '^  aircraft +3$' "$tmp/out-decrypt.txt"
rm -f -- "${restore_age%.age}"
jq --arg zero "$(printf '0%.0s' {1..64})" '.plaintext.sha256 = $zero' "$manifest" >"$tmp/restore/${manifest##*/}"
check "decrypt.sh refuses a file that does not match its manifest" \
  bash -c '! "$1" "$2" "$3" >/dev/null 2>&1' _ "$here/decrypt.sh" "$tmp/key.txt" "$restore_age"

echo "# second night, same month, same environment"
run_backup second
check "exits 0" exited_ok
rec=$(last_record)
check "record has no monthlyKey and envUploaded false" record_matches_contract "$rec" no false
check "a new daily object, the first one kept" test "$(object_count '^daily/.*\.zip\.age$')" = 2
check "no second monthly copy" test "$(object_count '^monthly/')" = 2
check "environment not uploaded again" test "$(object_count '^env/')" = 1
check "output says the environment is unchanged" output_says "unchanged"
check "no plaintext left after exit" no_plaintext_left second
check "no secret in the output" no_secrets_in "$out" "$tmp/summary-second.md"

echo "# third night, an environment variable changed"
write_env fake-rotated-credentials-key-0c55
run_backup third
check "exits 0" exited_ok
rec=$(last_record)
check "record says envUploaded true" record_matches_contract "$rec" no true
check "a second env/ object" test "$(object_count '^env/')" = 2
newest_env="$(bucket_dir)/$(objects | grep '^env/' | tail -n 1)"
check "the newest env/ object holds the new values" decrypts_to "$newest_env" "$tmp/env.txt"
third_fingerprint=$(stored_fingerprint)
check "fingerprint updated" test "$third_fingerprint" != "$first_fingerprint"
check "no secret in the output" no_secrets_in "$out" "$tmp/summary-third.md"

echo "# fourth night, the backup key changed and no variable did"
run_backup fourth BACKUP_AGE_PUBLIC_KEY="$new_public_key"
check "exits 0" exited_ok
rec=$(last_record)
check "record says envUploaded true" record_matches_contract "$rec" no true
check "a third env/ object" test "$(object_count '^env/')" = 3
newest_env="$(bucket_dir)/$(objects | grep '^env/' | tail -n 1)"
check "the new key opens the newest env/ object" opens_with_new_key "$newest_env" "$tmp/env.txt"
check "the new key opens the night's export" \
  opens_with_new_key "$(bucket_dir)/$(jq -r .objectKey <<<"$rec")" "$state/last-export.zip"
check "fingerprint updated" test "$(stored_fingerprint)" != "$third_fingerprint"
check "no secret in the output" no_secrets_in "$out" "$tmp/summary-fourth.md"

echo "# fifth night, same new key, same environment"
run_backup fifth BACKUP_AGE_PUBLIC_KEY="$new_public_key"
check "exits 0" exited_ok
check "record says envUploaded false" record_matches_contract "$(last_record)" no false
check "environment not uploaded again" test "$(object_count '^env/')" = 3

echo "# monthly copy when only an earlier month has one"
fresh_bucket earlier-month
mkdir -p "$(bucket_dir)/monthly/1999-12"
echo old >"$(bucket_dir)/monthly/1999-12/angelone-19991201T084100Z.zip.age"
run_backup earlier-month
check "exits 0" exited_ok
check "makes this month's copy" record_matches_contract "$(last_record)" yes true

echo "# refusals before anything runs"
fresh_bucket refusals
run_backup dev-key CONVEX_DEPLOY_KEY="dev:angelone-test|fake-deploy-key-7f3a9c41"
check "a dev: deploy key is refused" exited_failed
check "and says a production key is needed" output_says "production deploy key"
check "and does not print the key" no_secrets_in "$out"
run_backup no-key CONVEX_DEPLOY_KEY=
check "a missing deploy key is refused" exited_failed
run_backup private-age-key BACKUP_AGE_PUBLIC_KEY="$(grep '^AGE-SECRET-KEY-' "$tmp/key.txt")"
check "an age private key in BACKUP_AGE_PUBLIC_KEY is refused" exited_failed
check "and is not printed" no_secrets_in "$out"
run_backup no-r2-secret R2_SECRET_ACCESS_KEY=
check "a missing R2 secret is refused" exited_failed
check "no Convex or R2 call was made" test ! -s "$state/npx-calls.log" -a ! -s "$state/aws-calls.log"
check "nothing recorded" nothing_recorded

failure_case() { # failure_case <name> <what> [VAR=value...]
  local name=$1 what=$2
  shift 2
  fresh_bucket "$name"
  run_backup "$name" "$@"
  check "$what: exits non-zero" exited_failed
  check "$what: nothing recorded" nothing_recorded
  check "$what: no plaintext left after exit" no_plaintext_left "$name"
  check "$what: no secret in the output" no_secrets_in "$out"
}

echo "# failures stop before recording"
failure_case export-fails "failed export" FAKE_EXPORT=fail
check "failed export: nothing uploaded" test -z "$(objects)"
failure_case export-corrupt "export that is not a ZIP" FAKE_EXPORT=corrupt
check "export that is not a ZIP: nothing uploaded" test -z "$(objects)"
failure_case export-empty "export with no table documents" FAKE_EXPORT=empty
check "export with no table documents: says so" output_says "no documents"
failure_case upload-fails "failed upload" FAKE_FAIL_PUT='^daily/.*\.zip\.age$'
failure_case upload-short "object smaller than the file after upload" FAKE_TRUNCATE_PUT='^daily/.*\.zip\.age$'
check "object smaller than the file after upload: says so" output_says "after upload"
failure_case head-fails "failed head-object check" FAKE_FAIL_HEAD_AFTER_PUT='^daily/.*\.zip\.age$'
failure_case monthly-upload-fails "failed monthly upload" FAKE_FAIL_PUT='^monthly/'
failure_case env-upload-fails "failed env/ upload" FAKE_FAIL_PUT='^env/'
failure_case existing-object "daily object already there" FAKE_EXISTS='^daily/.*\.zip\.age$'
check "daily object already there: never overwritten" bash -c '! grep -q " s3 cp .* s3://angelone-backups/daily/" "$1"' _ "$state/aws-calls.log"

echo "# recording fails after a good backup"
fresh_bucket record-fails
run_backup record-fails FAKE_RECORD=fail
check "exits non-zero" exited_failed
check "says the backup itself succeeded" output_says "backup itself succeeded"
check "the backup is in the bucket" test "$(object_count '^daily/.*\.zip\.age$')" = 1
check "no plaintext left after exit" no_plaintext_left record-fails
check "no secret in the output" no_secrets_in "$out"

echo "# readable copy in Dropbox (ADR-0011)"
nodebin="$tmp/nodebin"
mkdir -p "$nodebin"
cat >"$nodebin/node" <<'FAKE'
#!/usr/bin/env bash
# Fake node for the Dropbox step: records which script ran and whether it could
# see the Dropbox credentials, and never contacts Dropbox.
echo "$1 key=${DROPBOX_APP_KEY:+set} secret=${DROPBOX_APP_SECRET:+set} token=${DROPBOX_REFRESH_TOKEN:+set} args=${*:2}" >>"$FAKE_STATE/node-calls.log"
case "$1" in
  scripts/backup/records-workbook.mjs)
    [[ "${FAKE_WORKBOOK:-ok}" == fail ]] && { echo "workbook failed" >&2; exit 1; }
    while (($#)); do [[ "$1" == --out ]] && { : >"$2"; break; }; shift; done ;;
  scripts/backup/dropbox-upload.mjs)
    [[ "${FAKE_DROPBOX:-ok}" == fail ]] && { echo "Dropbox refused the upload" >&2; exit 1; } ;;
esac
exit 0
FAKE
chmod +x "$nodebin/node"
dropbox_token="dbx-refresh-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
dropbox_secret="dbx-secret-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
no_dropbox_secrets_in() { ! grep -qF -e "$dropbox_token" -e "$dropbox_secret" "$@"; }

fresh_bucket dropbox-unset
: >"$state/node-calls.log"
run_backup dropbox-unset PATH="$nodebin:$bin:$PATH"
check "without Dropbox settings: succeeds" exited_ok
check "without Dropbox settings: says the copy was skipped" output_says "Dropbox copy skipped"
check "without Dropbox settings: no workbook or upload ran" test ! -s "$state/node-calls.log"

fresh_bucket dropbox-ok
: >"$state/node-calls.log"
run_backup dropbox-ok PATH="$nodebin:$bin:$PATH" DROPBOX_APP_KEY=dbx-app DROPBOX_APP_SECRET="$dropbox_secret" DROPBOX_REFRESH_TOKEN="$dropbox_token" RECORDS_TIME_ZONE=America/Chicago
check "with Dropbox set up: succeeds" exited_ok
check "the workbook is built from the export, in the chosen time zone" grep -qE '^scripts/backup/records-workbook\.mjs .*--zip .*backup\.zip .*--tz America/Chicago' "$state/node-calls.log"
check "the workbook step cannot see the Dropbox credentials" grep -qE '^scripts/backup/records-workbook\.mjs key= secret= token= ' "$state/node-calls.log"
check "only the upload step gets the Dropbox credentials" grep -qE '^scripts/backup/dropbox-upload\.mjs key=set secret=set token=set ' "$state/node-calls.log"
check "the copy was recorded in the app before the Dropbox step" test "$(records)" -ge 1
check "no plaintext left after exit" no_plaintext_left dropbox-ok
check "no Dropbox secret in the output" no_dropbox_secrets_in "$out" "$tmp/summary-dropbox-ok.md"
check "no Dropbox secret on any Convex or R2 command line" no_dropbox_secrets_in "$state/npx-calls.log" "$state/aws-calls.log"

fresh_bucket dropbox-fails
before=$(records)
run_backup dropbox-fails PATH="$nodebin:$bin:$PATH" DROPBOX_APP_KEY=dbx-app DROPBOX_APP_SECRET="$dropbox_secret" DROPBOX_REFRESH_TOKEN="$dropbox_token" FAKE_DROPBOX=fail
check "a failed Dropbox upload fails the run" exited_failed
check "and says the R2 backup succeeded and is recorded" output_says "R2 backup succeeded and is recorded"
check "and the R2 copy was still recorded" test "$(records)" -gt "$before"
check "no plaintext left after exit" no_plaintext_left dropbox-fails
check "no Dropbox secret in the output" no_dropbox_secrets_in "$out"

echo
if ((failures > 0)); then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All backup job checks passed."
