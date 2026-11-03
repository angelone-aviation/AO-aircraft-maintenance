---
status: accepted
date: 2026-11-03
---

# A readable copy of the records in Dropbox, alongside the encrypted backup

> Adds to [ADR-0008](0008-daily-backups-off-site-90-days-monthly-forever.md) without changing it: its "Considered options" turned down Google Drive or OneDrive as _the_ off-site store, and Dropbox here holds only a readable copy. Setup: [Dropbox records copy runbook](../runbooks/dropbox-records-copy.md).

The program asked for logs of everything to be saved in Dropbox as an Excel file, in addition to the Cloudflare R2 backup, formatted so that people can read and understand it. Each night the backup job therefore also turns the same Convex export into one formatted workbook and uploads it to a Dropbox folder. An administrator, an inspector or a board member can open it in Excel, Numbers or Google Sheets without training.

## What the copy is

- **A convenience copy for reading, not the system of record.** The aircraft logbooks and the encrypted R2 backup (ADR-0008) are the records. The workbook's first sheet says so.
- **One workbook per night**: Read me, Aircraft, Due list, Flight log, Discrepancies, Work orders, Airworthiness directives, Components, Inventory, Purchase orders, Maintenance costs, People and access, and the whole Change history, newest first. Tail numbers, names and Flight Program names replace internal IDs. Statuses (overdue, due soon, grounded) are worked out with the app's own rules in `src/domain`, so the workbook and the app agree. Dates are real dates in one named time zone (America/New_York unless set otherwise).
- **Never included**: passwords, sign-in records, saved credentials (FAA, address lookup, Aircraft Spruce), uploaded files and links to them, and request bookkeeping. Only named tables are read from the export, and a test fails if any of this appears.
- **Same export, no extra load**: the workbook is built from the export the job already downloaded for R2, after the R2 copy is uploaded and recorded. Convex is not queried again.

## Where it goes and how long it stays

| Copy    | Path in the Dropbox app folder                                                      | Kept                                          |
| ------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| Daily   | `/Daily/Angel One records YYYY-MM-DD.xlsx`                                          | 90 days; the job removes older daily files    |
| Monthly | `/Monthly/Angel One records YYYY-MM.xlsx`, the first successful night of each month | Forever; the job never removes or replaces it |

- The Dropbox app has **App folder** access only, so its token cannot read or change anything else in the Dropbox account. It needs `files.content.write`, `files.content.read` and `files.metadata.read`.
- The app belongs to an **organization Dropbox account with two-step sign-in**, not a person's account, because the refresh token belongs to that account.
- The step runs only when the Dropbox secrets are set. If it fails, the nightly run fails and the technical owner is emailed; the R2 copy has already been made.

## Consequences

- **Not encrypted.** Anyone with access to the Dropbox folder can read names, email addresses, costs and the full change history. The folder is shared only with people who may see all of that (runbook).
- **Not locked against deletion or change.** Anyone with write access to the folder, or the app's token, can delete or alter a copy. The locked R2 archives remain the tamper evidence (ADR-0005, ADR-0010); a Dropbox copy proves nothing about the records.
- Daily copies cost little; monthly copies grow by one file a month, forever. Review the folder size with the yearly R2 cost review.
- Monthly workbooks keep program members' personal data indefinitely, like the monthly R2 archive. Unlike R2, they can be deleted by hand if a deletion request requires it.
- A change history longer than one Excel sheet allows (1,048,574 rows) is split into "Change history 1 of 2" and further sheets, and Read me says so.
- The workbook is built with `exceljs`, a development dependency used only by the backup job; the app's production dependencies are unchanged.

## Considered options

- **CSV files**: rejected; no formatting, no highlighting, dates and statuses harder to read, and a dozen files instead of one.
- **A password-protected workbook**: rejected for now; Numbers and Google Sheets handle protected files poorly, and the password would have to be shared with every reader anyway. Folder access is the control.
- **The readable copy in R2 next to the encrypted archive**: rejected; the people who need to read it have no R2 access, and an unencrypted copy there would weaken ADR-0008.
- **Google Drive or OneDrive**: workable; Dropbox was chosen because the program asked for it.
