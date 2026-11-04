# Credential encryption keys

Saved third-party credentials (the FAA DRS key, the Geoapify key and each Flight Program's Aircraft Spruce login) are encrypted with AES-256-GCM in `convex/secrets.ts` before they are stored. This runbook covers the format and rotating the key.

## Format

- `enc:v2:<keyId>:<iv>:<ciphertext>` is the only format. The key id names the key that sealed the value. The encryption also binds the value to its table, Flight Program and field, so a value copied to another row or field does not decrypt.
- Any other value is refused: plaintext, and the earlier `enc:v1:` format, which only deployments older than production's fresh start on 2026-11-03 could hold. An administrator must enter that credential again.

## Environment variables

| Variable                        | Meaning                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CREDENTIALS_ENCRYPTION_KEY`    | Key `k1`, 32 random bytes in base64. Every existing deployment already has it.                        |
| `CREDENTIALS_ENCRYPTION_KEYS`   | Optional additional keys, as `k2=<base64>,k3=<base64>`. Key ids are 1–16 lowercase letters or digits. |
| `CREDENTIALS_ENCRYPTION_KEY_ID` | The key id used to seal new values. It defaults to `k1`.                                              |

Back up every key before changing anything (see [Backup and restore](backup-restore.md)). Without its key, a value cannot be decrypted and administrators must enter that credential again.

## Rotating the key

1. Generate the new key and add it with a new id, keeping the old one:
   ```sh
   openssl rand -base64 32   # copy the output
   npx convex env set CREDENTIALS_ENCRYPTION_KEYS 'k2=<new key>' --prod
   ```
   If `CREDENTIALS_ENCRYPTION_KEYS` already lists keys, keep them in the new value, separated by commas.
2. Make the new key active: `npx convex env set CREDENTIALS_ENCRYPTION_KEY_ID k2 --prod`. New saves now use `k2`; values under `k1` still open.
3. Re-seal the existing values: `npx convex run secretsMigration:reseal --prod`. It returns `{ resealed, remaining, complete }`; a credential an administrator saves while it runs is left as saved, so repeat until it returns `remaining: 0`. Running it again is always safe.
4. Check that FAA search, address lookup and the Aircraft Spruce catalog search still work.
5. Retire the old key. For `k1`, run `npx convex env remove CREDENTIALS_ENCRYPTION_KEY --prod`; for a key in `CREDENTIALS_ENCRYPTION_KEYS`, set the variable again without it. Keep a backed-up copy of the old key until the next backup no longer contains any value sealed with it.

If a step fails, set `CREDENTIALS_ENCRYPTION_KEY_ID` back to the old id. Nothing is lost while every key is still configured.

When a key may have leaked, rotate it as above and also replace the credentials themselves with each provider: the old key opens any copy of the data taken before the rotation.
