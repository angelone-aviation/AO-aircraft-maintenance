# Aircraft setup

Open **Aircraft → Set up an aircraft** (Flight Program administrators only). The wizard loads one aircraft's history in the order the records depend on each other, and runs a dry run before anything from its templates is saved. Resume an aircraft later from the **Setup** chips on its row of the Aircraft page ("Baseline readings missing", "Components missing", "Inspections missing", "ADs not reviewed"); each chip opens the wizard at the step that fills it. The chips disappear once every step holds data.

Until every step holds data, the aircraft's status reads **Setup incomplete** (not Airworthy or Due soon) on every screen that shows it: the Overview card and aircraft detail, the Aircraft page, the status sheet, the owner portal and the board view. The missing steps are listed as the reasons, followed by anything due soon. An aircraft that is grounded still reads Grounded. Setup incomplete does not ground the aircraft: the dispatch gate and alerts judge only recorded limits, discrepancies and the profile status, so flights can still be logged. Missing information never implies readiness, so a fully set-up aircraft is the only one that can read Airworthy. This is Aaron's decision D5 (2026-11-10); the stricter option, creating the aircraft as Grounded until setup is finished, was considered and not chosen.

## Steps

1. **Aircraft.** The normal aircraft form: registration, make and model, serial number, options, the time source and the verified baseline readings from the logbooks. Saving creates the aircraft in the active Flight Program through the usual aircraft save, with its change-log entry; the wizard then reopens at the aircraft's own address (`/aircraft/setup/<aircraft>`), which is the address to return to. With an existing aircraft the step shows its identity and totals, with **Edit aircraft** for corrections. A total time of 0.0 h is flagged: every last-done value would be above it.
2. **Components installed.** Record the engines, propellers and life-tracked parts already on the aircraft: **Add installed component** opens the component form for one verified part, **New template / import CSV** and **Apply template: …** use [component templates](component-templates.md) to add the rest as **Setup incomplete** entries, listed on this step for this aircraft with **Complete setup** on each. These forms save as soon as they are submitted; there is nothing to commit later. Only templates whose make and model match the aircraft are offered.
3. **Inspections.** Download the CSV template, then paste the file's text or upload it. The rows parse as you type, and the first error names its row. Nothing is saved yet.
4. **AD compliance.** The same for airworthiness directives. ADs the FAA lists for the type can be imported afterwards from Airworthiness directives (FAA search import); they open as Needs review.
5. **Review (dry run).** One sentence on what Save will write and how many rows it will leave out, then the counts per step, what each row will save, the rows to fix first, the values to confirm, the rows worth a look, and every row that will not be saved with its reason. Nothing from steps 3 and 4 has been saved.
6. **Save.** Sends one command per row, in order (inspections, then ADs), each with its own request id and change-log entry: the same `inspection.save` and AD save the Inspections and Airworthiness screens send, so every rule those screens enforce applies. A failure stops the run at its row and shows the message; the rows before it stay saved. **Retry from the failed row** resends from there with the same request ids; **Fix the file** returns to the step. Once everything is saved, follow the links to Inspections and Airworthiness directives and **forget this draft**.

An aircraft has one save at a time. It keeps running when you open another step or another screen, every step shows "Saving the setup: N of M rows done", the two files cannot be changed until it finishes, and the Save step shows the running save instead of a second Save button. Just before each row is sent it is checked against the aircraft again; a row that is there by then is marked "Already there" and not sent. Closing or reloading the page stops the save after the row in flight: the rows saved so far stay saved, and the review shows what is left.

Both template texts and the rows already saved are kept in this browser per aircraft (cleared on sign-out). Leaving the page, reloading or coming back from the chips resumes where you were. Saved rows are remembered by inspection name and AD number (ignoring case and spacing), not by their position in the file, so a corrected, reordered or replaced file is checked row by row: a resumed review lists the rows this setup saved as "This setup saved it earlier", and rows of a new file are planned as new. If the draft is lost, the review still leaves out rows whose inspection name or AD number is already on the aircraft, so a second run cannot duplicate them. A row that is left out is never applied to the existing record: correct that record on Inspections or Airworthiness directives.

## Inspection template

```csv
name,interval_hours,interval_months,interval_cycles,interval_landings,last_done_date,last_done_hours,last_done_cycles,last_done_landings,manual_reference
```

| Column               | Meaning                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | The inspection's name, shown as its description. Required; unique within the file. A name already on the aircraft (ignoring case and spacing) is skipped.                                      |
| `interval_hours`     | Repeat interval in aircraft total time, in tenths of an hour (`100` or `100.0`).                                                                                                               |
| `interval_months`    | Repeat interval in calendar months; the due date falls at the end of the due month, as 14 CFR 91.409 counts "calendar months". Day-based intervals are not supported for aircraft inspections. |
| `interval_cycles`    | Repeat interval in aircraft cycles.                                                                                                                                                            |
| `interval_landings`  | Repeat interval in aircraft landings.                                                                                                                                                          |
| `last_done_date`     | Date last done, `YYYY-MM-DD`; required with `interval_months`, and never in the future.                                                                                                        |
| `last_done_hours`    | Aircraft total time when last done, in tenths; required with `interval_hours`.                                                                                                                 |
| `last_done_cycles`   | Aircraft cycles when last done; required with `interval_cycles`.                                                                                                                               |
| `last_done_landings` | Aircraft landings when last done; required with `interval_landings`.                                                                                                                           |
| `manual_reference`   | The regulation or manual section the inspection comes from, saved as the record's reference and shown as its title on Inspections.                                                             |

Any subset of the intervals may be given, but at least one is required, and each needs its own last-done value. No last-done value may be above the aircraft's current totals. The next due point is computed from the interval and the last-done value, as the inspection form does.

## AD compliance template

```csv
ad_number,title,applies,compliance_date,compliance_hours,method,next_due_hours,next_due_date,recurring,notes
```

| Column             | Meaning                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ad_number`        | The FAA AD number, such as `2011-10-09`, `98-05-14` or `2011-10-09R1`. Required; unique within the file. An AD already tracked on the airframe (ignoring case and spacing) is skipped. Any other form must be confirmed before saving (see below). |
| `title`            | The AD's subject; also the description of its required action.                                                                                                                                                                                     |
| `applies`          | `yes` or `no` (also `y`/`n`, `true`/`false`, `1`/`0`). Required.                                                                                                                                                                                   |
| `compliance_date`  | The date the AD was complied with, `YYYY-MM-DD`, never in the future. With it the AD is saved as **Previously Complied With (PCW)**, the date and hours as its prior compliance. Without it an applicable AD is saved as **Applicable**.           |
| `compliance_hours` | Aircraft total time at compliance, decimal hours. Required with `compliance_date` when the AD applies.                                                                                                                                             |
| `method`           | How it was complied with; kept in the AD's source notes as "Method: …".                                                                                                                                                                            |
| `next_due_hours`   | Aircraft total time the next action is due at, decimal hours.                                                                                                                                                                                      |
| `next_due_date`    | The date the next action is due, `YYYY-MM-DD`.                                                                                                                                                                                                     |
| `recurring`        | `yes`, `no` or blank (unknown). Sets the source's recurrence and the required action's recurrence (Recurring, One-time, Unknown).                                                                                                                  |
| `notes`            | Kept in the source notes; for an AD that does not apply, saved as the reason it is not applicable. Without notes the reason reads "Recorded as not applicable during aircraft setup."                                                              |

An AD that applies gets one required action carrying the next due limits; a complied AD gets one only when something is still due or it repeats. Every AD saved here is reviewed (not "Needs review"), because the administrator decided its applicability in the file. Compliance entered here is prior compliance, not a compliance record with mechanic and certificate: record later compliance on the Airworthiness directives screen.

## Format rules

Column names match ignoring case, spaces and hyphens, in any order; every listed column is required and unknown or repeated columns are rejected. Use comma-delimited UTF-8 with conventional quoting; a leading byte-order mark is ignored. An uploaded file that is not UTF-8 is refused: Excel's plain "CSV (Comma delimited)" is Windows-1252, so save as **CSV UTF-8 (Comma delimited)**. Spreadsheets also rewrite date-shaped cells: format the `ad_number` and date columns as Text before typing, or check them in the dry run. Each file is limited to 2 MiB and 2,000 rows. Blank cells mean unknown. Hours for inspections use at most one decimal place (meter readings read in tenths); AD hours accept any decimal. Months, cycles and landings are whole numbers.

## What the dry run checks

**Fix before saving** (the commit is disabled until these are gone): a file that does not parse; an inspection without an interval, or with an interval lacking its last-done value; a last-done date or compliance date in the future; a last-done value above the aircraft's current totals; an applicable AD with a compliance date but no compliance hours; a name or AD number repeated within the file.

**Confirm before saving** (the Save step holds the commit until its box is ticked): an AD number that is not in the FAA form, such as `10/9/2011` where a spreadsheet rewrote `2011-10-09` as a date. The number is saved exactly as written and is never corrected by guessing, because every later duplicate check and FAA match goes by it; correct the file instead where it is wrong.

**Check** (saved anyway): the aircraft's total time is 0.0 h; an hours interval that has already run out; an AD whose next due hours or date have already passed; an applicable AD with no next due limit, which shows as "Due not set" until one is entered.

**Not saved**: rows whose inspection name or AD number is already on the aircraft, and rows this setup already saved. Each is listed with its reason.

The dry run predicts the appliers' refusals; the appliers still run on commit, so a rule the dry run does not know (for example a permission change) fails the row with its own message.

## Setup incomplete

Components added from a template are recommendations, not installed components: their serials, installation dates and opening readings are unknown until verified from the records. They are listed as **Setup incomplete** on the components step (for this aircraft) and on Components → Imported components (for every aircraft), and count on the Fleet page's "Components missing" chip until at least one component is installed. Complete each entry through its form; a child part waits until its parent is installed. See [Component templates](component-templates.md).
