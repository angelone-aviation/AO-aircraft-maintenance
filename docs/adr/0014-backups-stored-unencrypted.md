---
status: accepted
date: 2026-11-20
---

# Off-site backups are stored unencrypted

> Changes [ADR-0008](0008-daily-backups-off-site-90-days-monthly-forever.md) ("Encryption" and the environment-variables row). Everything else in ADR-0008 stands: the nightly schedule, 90 days daily, monthly forever, the lock rules, the freshness alarm and the rehearsals.

**Backups are not encrypted, by Aaron's decision on 20 Nov 2026. Anyone holding the R2 keys or the Cloudflare login can read every record, user and password hash in them.**

The nightly job refused to run without the age public key `BACKUP_AGE_PUBLIC_KEY`, so no off-site backup was being made at all. Aaron decided that the copies are stored without encryption. He was told what a copy holds and accepted it.

## What a copy holds

The whole Convex export with its uploaded files: every aircraft record and the change log; users' names, emails and certificate numbers; licence and certificate copies and other attachments; sign-in password hashes, sessions and refresh tokens; and the saved FAA, Geoapify and Aircraft Spruce credentials, which stay sealed with `CREDENTIALS_ENCRYPTION_KEY` (that key is not in the export).

## How it works

- With `BACKUP_AGE_PUBLIC_KEY` **unset or empty**, the job uploads the ZIP as it is. The names say so: `angelone-<time>.unencrypted.zip` and `angelone-<time>.unencrypted.manifest.json`. The manifest has `"encrypted": false` and a `notice` starting `NOT ENCRYPTED`, and the job summary's heading ends `NOT ENCRYPTED`. The SHA-256 check, lock rules, prefixes, heartbeat and failure behaviour are unchanged.
- **The environment variables are not saved** without a key. They hold `CREDENTIALS_ENCRYPTION_KEY`, `JWT_PRIVATE_KEY` and `JWKS`, and were only ever stored encrypted; nothing that was encrypted before is now stored in plain text. `env/` and `state/` are not touched.
- **To turn encryption back on**, add the secret again ([runbook](../runbooks/backup-restore.md#to-turn-encryption-on)). The next run encrypts its copy and saves `env/` at once. A value that is set but is not an age public key fails the run; it is never read as "unencrypted".

## Consequences

- Anyone who holds the R2 API token, or can sign in to the Cloudflare account, can read every record, user, email, certificate number, licence copy and password hash in every copy. Before this decision the R2 token gave them only encrypted files.
- A copy less than a week old can also let someone sign in to the app as a person who was signed in when it was taken, administrators included, until that session ends (sessions last a week). Password hashes can be attacked offline; the 15-character minimum slows that, it does not stop it.
- Copies are locked: `daily/` for 90 days and `monthly/` forever. Turning encryption on later does not encrypt or remove copies already made, so every unencrypted monthly copy stays readable for good.
- After losing the Convex account, a restore has no saved environment variables: administrators re-enter the saved FAA, Geoapify and Aircraft Spruce credentials, and new sign-in keys are made with `npm run setup:auth`. Keeping `CREDENTIALS_ENCRYPTION_KEY` in Aaron's password manager avoids the first.
- The bucket must stay private: no public access, no `r2.dev` address and no custom domain on it. The job only reads and writes objects with the R2 token; it never changes the bucket's access.
- Leaking the R2 token or the Cloudflare login is now exposure of all records to date (SEV1 in the [incident response runbook](../runbooks/incident-response.md)).
- No age key pair to make, store, escrow or rehearse while encryption is off.

## Considered options

- **Keep encryption required**: no backup runs until a key pair exists and is escrowed. Aaron chose a working backup now, with encryption one secret away.
