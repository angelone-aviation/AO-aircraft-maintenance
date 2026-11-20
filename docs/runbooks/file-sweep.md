# Unreferenced file sweep

An hourly job, `fileSweep:sweepFiles` (cron "Unreferenced file sweep", at 45 minutes past the hour), looks for stored files that no record refers to: an upload whose bytes matched no manual ticket, or an upload that stopped between storing the file and filing it. It checks 100 files a run, oldest first, and only files more than a day old, so an upload in progress is never touched. It never deletes a file that a record, attachment, manual, photo, Form 337 copy or upload ticket refers to (`convex/storageReferences.ts`).

It starts safe. Until someone has read its report and chosen otherwise, it deletes nothing.

## Modes

The Convex environment variable `FILE_SWEEP` decides what it does.

| Value             | What a run does                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset or `report` | Deletes nothing. Logs `fileSweep would delete` for each file nothing refers to, with its storage id, size, content type and creation time (`_creationTime`, epoch ms). |
| `delete`          | Deletes each file nothing refers to and logs `fileSweep deleted` with the same fields.                                                                                 |
| `off`             | Nothing: no reads, no writes, no log lines.                                                                                                                            |
| anything else     | Reports, as unset, and logs a warning that the value is not `off`, `report` or `delete`.                                                                               |

Every run in `report` or `delete` mode also logs `fileSweep run` with the mode, how many files it checked and how many nothing refers to, so a quiet run still shows it ran. No log line holds a file's name or anyone's details.

## The start day

The first run in `report` or `delete` mode records the midnight (UTC) of that day in the `fileSweep` row, as `notBefore`, and the sweep never reads a file created before it. Files already in storage before the sweep first ran, production's included, are never swept, however the variable is later set. The first run of a fresh deployment happens within the hour after deploy; with `FILE_SWEEP=off` it does not run, and the start day is set by the first run after it is turned on.

## Review the first pass, then switch to delete

1. Leave `FILE_SWEEP` unset after the release that adds the sweep. Each hour it reports up to 100 files.
2. Read the report in the Convex dashboard: **Logs**, filtered on `fileSweep`. Copy the lines you need at once: the log is not kept for long ([incident response](incident-response.md)).
3. Check a few reported storage ids in the dashboard's **Data** view: none should appear in `aircraftFiles`, `aircraftPhotos`, `certificationFiles`, `inventoryFiles`, `manualUploads`, `manuals`, `poFiles`, `spruceAccounts` (`catalogId`), `taskEvidence` or `workOrderFiles`. A reported file that a record does refer to is a bug: set `FILE_SWEEP=off` and report it before going on.
4. When the report looks right, switch to delete:
   ```sh
   npx convex env set FILE_SWEEP delete --prod
   ```
   A change of mode walks again from the start day, so every file the report listed is checked again and deleted in the following runs, each logged as `fileSweep deleted`.
5. To stop it at any time: `npx convex env set FILE_SWEEP off --prod` (or `report` to go back to listing only).

## Recovering a file

A deleted file is gone from file storage. The nightly off-site export includes file storage ([backup and restore](backup-restore.md)), so a file deleted by mistake can be taken from the last export made before its `fileSweep deleted` line, for 90 days, or from a monthly copy after that.
