# Production database access

Policy: [ADR-0005](../adr/0005-audit-log-protection-by-access-and-backups.md) protects the change log by limiting who can reach production data, by banning direct edits, and by off-site backups ([ADR-0008](../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)). These rules come from issue #21.

## Who holds production dashboard access

Only **the named administrators recorded in [accounts.md](accounts.md#production-dashboard-administrators)** may hold access to the production deployment in the Convex dashboard, or its deploy key. Nobody else is invited to the Convex team. Pilots, mechanics and Flight Program administrators use the app, never the dashboard.

There is exactly one named administrator ([ADR-0010](../adr/0010-one-convex-administrator.md)): the technical owner, who is the only member of the Convex account. Nobody else holds dashboard access or a production deploy key.

When an administrator changes, update the table in `accounts.md` in the same change that adds or removes their Convex access, then rotate the deploy key if the person leaving held it.

## Direct edits to production data are banned

A direct edit is any change to production data that does not go through the app: editing, adding or deleting a document in the dashboard's Data page, `npx convex import` into production, or running an internal function that changes data other than the documented ones.

They are banned, with two exceptions:

1. **A restore** from a backup, following [Backup and restore](backup-restore.md#real-restore-production).
2. **A repair the app cannot make**, when a record blocks the app or is wrong in a way no correction command can fix. Raise it as an issue first, with what is wrong and the exact change, and have the second administrator agree to it in writing (the issue is enough).

Never edit or delete a change-log (`audit`) row, for any reason. A wrong entry is answered with a new entry, not by changing the old one.

The commands documented in the README's Deployment checklist and in these runbooks (for example `secretsMigration:reseal` and `setup:admin`) are reviewed code, not direct edits. Run them as documented.

## Doing a sanctioned edit

1. Take a Convex backup first (dashboard > Backups) and note its time.
2. Copy the document as it is before the edit (the dashboard's JSON view), so the entry below can record it.
3. Make the edit. Change only what the issue or the restore needs.
4. Record the hand-written change-log entry below, straight away.

## Recording the hand-written change-log entry

Every sanctioned edit is followed by one change-log entry, written with the internal `audit:recordManualEntry` function. It only appends: it never changes or deletes an existing entry. Run it with the deployment's admin key, as the administrator who made the edit:

```sh
npx convex run --prod audit:recordManualEntry '{
  "actorEmail": "you@example.org",
  "reason": "Issue #NN: AD 2026-01-01 due hours saved against the wrong aircraft",
  "description": "Moved the airworthiness document for AD 2026-01-01 from N206MA to N441MA in the dashboard.",
  "entityUuid": "<uuid of the record changed>",
  "aircraftUuid": "<aircraft uuid, if any>",
  "before": { "aircraftUuid": "<old value>" },
  "after": { "aircraftUuid": "<new value>" }
}'
```

- `actorEmail` must be your own active **system administrator** account in Angel One; the entry is recorded as yours. The function refuses any other account.
- `reason` (why) and `description` (what was changed) are required.
- `entityUuid` is the `uuid` of the record changed, so the entry appears in that record's history; `aircraftUuid` and `programUuid` let Flight Program users see it in their Change history. For a whole-deployment event such as a restore, leave them out: the entry is then visible to system administrators with **Unassigned records** selected in the Flight Program switcher.
- `before` and `after` are optional and take any JSON: the values you copied in step 2 and the values after the edit.

The entry appears in **Change history** as "Audit · manual entry", with the reason shown and the description under **View recorded values**. Check that it is there.

## Checks

At each quarterly restore rehearsal ([Backup and restore](backup-restore.md#quarterly-restore-rehearsal)), compare the Convex team's member list and deploy keys with `accounts.md`, and list the "Audit · manual entry" rows since the last rehearsal: each should match an issue or a restore.
