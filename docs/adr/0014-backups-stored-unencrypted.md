---
status: accepted
date: 2026-11-20
---

# Off-site backups are stored unencrypted

> Changes [ADR-0008](0008-daily-backups-off-site-90-days-monthly-forever.md) ("Encryption" and the environment-variables row). Everything else in ADR-0008 stands: the nightly schedule, 90 days daily, monthly forever, the lock rules, the freshness alarm and the rehearsals.

**Backups are not encrypted, by Aaron's decision on 20 Nov 2026. Anyone holding the R2 keys or the Cloudflare login can read every record, user, password hash and file in them, but cannot sign in with a copied session.**

The nightly job refused to run without the age public key `BACKUP_AGE_PUBLIC_KEY`, so no off-site backup was being made at all. Aaron decided that the copies are stored without encryption. He was told what a copy holds and accepted it.

## What a copy holds

The whole Convex export with its uploaded files: every aircraft record and the change log; users' names, emails and certificate numbers; licence and certificate copies and other attachments; sign-in password hashes (`authAccounts`); users' Web Push subscriptions (`pushSubscriptions`), which cannot be used to send alerts without the VAPID private key, an environment variable that is not in the export; and the saved FAA, Geoapify and Aircraft Spruce credentials, which stay sealed with `CREDENTIALS_ENCRYPTION_KEY` (that key is not in the export).

**Left out of an unencrypted copy**: the rows of the Convex Auth tables that let someone sign in with a copy. `authSessions` (live sessions), `authRefreshTokens` (a refresh token is its row id joined to its session id, so a copied row is a working token), `authVerificationCodes` (sign-in and password-reset codes) and `authVerifiers` (OAuth sign-in verifiers) are kept in the ZIP but emptied, `documents.jsonl` and `generated_schema.jsonl` alike, before it is hashed and uploaded. A plain run fails, uploading nothing, if one of those four is missing from the export or if it holds any other `auth*` table (at the top level or in a component) than those four, `authAccounts` and `authRateLimits`: a new auth table must be judged before a plain copy carries it. `users` and `authAccounts` stay: a restore needs them, and a password hash lets nobody sign in without cracking it. `authRateLimits` stays too; it holds no credential. After restoring an unencrypted copy everyone must sign in again, which is harmless. An encrypted copy keeps the full export.

## How it works

- With `BACKUP_AGE_PUBLIC_KEY` **unset or empty**, the job uploads the ZIP as it is. The names say so: `angelone-<time>.unencrypted.zip` and `angelone-<time>.unencrypted.manifest.json`. The manifest has `"encrypted": false`, a `notice` starting `NOT ENCRYPTED` and `signInRecordsRemoved` naming the emptied tables and why, and the job summary's heading ends `NOT ENCRYPTED` and names them too. The SHA-256 check, lock rules, prefixes, heartbeat and failure behaviour are unchanged.
- **The environment variables are not saved** without a key. They hold `CREDENTIALS_ENCRYPTION_KEY`, `JWT_PRIVATE_KEY` and `JWKS`, and were only ever stored encrypted; nothing that was encrypted before is now stored in plain text. `env/` and `state/` are not touched.
- **To turn encryption back on**, add the secret again ([runbook](../runbooks/backup-restore.md#to-turn-encryption-on)). The next run encrypts its copy and saves `env/` at once. A value that is set but is not an age public key fails the run; it is never read as "unencrypted".

## Consequences

- Anyone holding the R2 API token or the Cloudflare login can read every record, user, email, certificate number, licence copy, password hash and file in every copy, but cannot sign in with a copied session: the session and token rows are emptied. Before this decision the R2 token gave them only encrypted files.
- Password hashes can be attacked offline; the 15-character minimum slows that, it does not stop it. A cracked password signs that person in.
- Copies are locked: `daily/` for 90 days and `monthly/` forever. Turning encryption on later does not encrypt or remove copies already made, so every unencrypted monthly copy stays readable for good.
- After losing the Convex account, a restore has no saved environment variables: administrators re-enter the saved FAA, Geoapify and Aircraft Spruce credentials, and new sign-in keys are made with `npm run setup:auth`. Keeping `CREDENTIALS_ENCRYPTION_KEY` in Aaron's password manager avoids the first.
- The bucket must stay private: no public access, no `r2.dev` address and no custom domain on it. The job only reads and writes objects with the R2 token; it never changes the bucket's access.
- Leaking the R2 token or the Cloudflare login is now exposure of all records to date (SEV1 in the [incident response runbook](../runbooks/incident-response.md)).
- If a key is later added and then removed, copies silently go back to unencrypted, as Aaron asked: no separate switch is needed. The summary heading (`NOT ENCRYPTED`), a warning in the run, the object names and the manifest say so.
- No age key pair to make, store, escrow or rehearse while encryption is off.

## Considered options

- **Keep encryption required**: no backup runs until a key pair exists and is escrowed. Aaron chose a working backup now, with encryption one secret away.
