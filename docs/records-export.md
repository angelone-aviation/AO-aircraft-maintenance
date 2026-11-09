# Records package

**Export records package** gives a mechanic or administrator the complete record set Angel One holds for one aircraft, as one ZIP file, for an FAA inspector (14 CFR 91.417(c)), a buyer at transfer of the aircraft (91.419) or an insurer. It is the on-demand per-aircraft export that [ADR-0004](adr/0004-logbook-generator-and-status-record-system.md) decided on. The button is in the aircraft dialog on the Dashboard (**View aircraft**, beside **Export status sheet**) and on the **Change history** screen once an aircraft is chosen in the filter. It works in demo mode.

## Who can export

Users with **maintenance** permission on the aircraft, Flight Program administrators and system administrators. Aircraft owners keep the status sheet PDF only: the package holds flights, work detail and the change log, which the owner portal leaves out. The server scopes what each user's workspace holds, so a package never contains more than its exporter could see on screen.

## What the package holds

The file is named `<registration>-records-<YYYY-MM-DD>.zip` and contains:

- `README.txt`: the aircraft, the Flight Program, when the package was generated and by whom, what each file is, and any files left out with the reason.
- `records.pdf`: every table below, printed in the same style as the status sheet, in DejaVu Sans so any character prints. Wide tables are landscape; the Form 337 list is portrait. The footer of every page says that the signed logbook entries remain the maintenance record.
- One CSV per table (UTF-8 with a byte-order mark, every cell quoted; a dash on paper is an empty cell in the CSV): the six status sheet tables (`status-overview.csv`, `status-components.csv`, `status-inspections.csv`, `status-airworthiness.csv`, `status-form-337.csv`, `status-discrepancies.csv`), then `flights.csv`, `discrepancies.csv`, `work-orders.csv`, `ad-compliance.csv`, `components.csv`, `component-requirements.csv`, `form-337.csv` and `change-log.csv`.
- `form-337/`: every Form 337 copy on the aircraft record, named `<upload date>-<file name>`; archived copies are under `form-337/archived/`. A second upload of the same name on the same day gets ` (2)`.
- `files/`: the attachments of the aircraft's work orders, named the same way.

The tables:

| Table                     | Rows                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status sheet (six tables) | The same content as **Export status sheet**.                                                                                                                                                                                                                                                                                                                        |
| Flights                   | This aircraft's flights, oldest first: date and time, pilot and co-pilot, route, Hobbs and tach start and end, other meters, landings, cycles, oil added, status (a held flight shows its review reason) and remarks.                                                                                                                                               |
| Discrepancies             | Open and resolved, oldest first, with grounding, the deferral (MEL item and category or 91.213(d), who deferred it and when, expiry, placard), who resolved it and the resolution text.                                                                                                                                                                             |
| Work orders               | By date opened: number, dates, status, priority, scope, supervisor, release outcome and, for completed orders, the logbook entry text frozen at close-out, without its certification and signature lines.                                                                                                                                                           |
| AD compliance history     | Every compliance entry of every AD on the aircraft, by AD number in history order, with method, counters, mechanic and certificate, service bulletin, work order, and whether the entry is an original, a correction (naming the entry it replaces and the reason) or superseded by one. Current AD status is in the status sheet's Airworthiness directives table. |
| Components                | Every component ever on the aircraft, installed ones first, with installation and removal dates, TSN, TSO, TSR, cycles and what it tracks. Usage that cannot be computed reads "Review".                                                                                                                                                                            |
| Component requirements    | Each requirement's type, basis, interval, last done, next due and status.                                                                                                                                                                                                                                                                                           |
| Form 337 copies on file   | Every copy, archived ones too, with its status and its path in the package.                                                                                                                                                                                                                                                                                         |
| Change log                | Every change-log entry for the aircraft, oldest first: when, action, who, record, reason, before and after. The log is paged from the server until exhausted; offline, only the recent entries on the device are included and the README says so.                                                                                                                   |

## Size guard

A package copies at most **150 MB** of stored files. Files are taken in order (Form 337 copies, then work-order attachments, oldest upload first); one that would exceed the limit is skipped and smaller later ones may still be taken. A file that cannot be downloaded is skipped too. Skipped files are listed in `README.txt` with the reason and counted in the message under the button, so the exporter can fetch them separately from the record. The tables are never cut.

## What the package is not

Angel One generates unsigned logbook entries and is the system of record for the six 91.417(a)(2) status records; it is not the signed maintenance record ([ADR-0004](adr/0004-logbook-generator-and-status-record-system.md)). The signed pages in the aircraft's logbooks remain the legal record, and the package says so in its README and on every page of `records.pdf`. Values are as recorded when the package was generated; corrections are appended in Angel One with a reason, so the change log shows every change.
