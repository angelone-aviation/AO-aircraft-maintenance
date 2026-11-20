# Inspection templates

Open **Inspection templates** in the navigation. The table groups requirements by aircraft type or component model, manufacturer, optional part number, and a named inspection group. Templates belong to the active Flight Program. Maintenance users can create, edit and archive them; program readers can view them. They persist in Convex, or in browser storage for the local demo, and are included in the administrators' partial CSV extracts (Settings).

Templates store descriptions, conditions, hour/cycle/calendar intervals, separate initial thresholds, component requirement type, TSN/TSO/TSR and absolute/recurring bases, optional manual references and checklist tasks. They contain no aircraft assignment, installed-component identity, last-complied readings/dates, due values, results or signatures. The server rejects those operational fields. Saving a template does not create an active inspection or component requirement.

## CSV paths

- **Inspection templates → Import template CSV:** download the interval-only CSV format, choose the aircraft type/component model and inspection group, load the file, review and select rows, then save the batch. The group/model applies to the whole batch.
- The supplied **C441 CSV test.csv** status-export format is also recognized here. Only inspection names, service intervals and notes are read. `SVC LIFE HRS/LAND` is interpreted as hours and `SVC LIFE MONTHS` as months, as stated in the import form. For landing-based requirements, use the canonical format’s `cycles` column. Completion history, due values, projected dates, flags and remaining-time columns are excluded. Rows with NOT USED / NA / not-installed notes start unselected.
- **Reference library → Import maintenance CSV → Save as template:** import the existing inspection/component/task CSV format, then review the template form. Linked tasks in the loaded batch are copied as reusable instructions, with their references and applicability. For component candidates, the component’s model/manufacturer/part number populate the grouping; missing model identity must be supplied. Load parent and task CSVs together to include the checklist. The existing live-schedule actions remain available separately.

The canonical interval CSV columns are:

```csv
name,description,hours,cycles,calendar_value,calendar_unit,initial_hours,initial_cycles,conditions,requirement_type,time_basis,hour_mode,cycle_mode
```

Calendar units are DAYS, MONTHS or YEARS. Requirement types are Inspection Requirement, Overhaul Requirement or Life Limits. Time bases are TSN, TSO or TSR. Limit modes are ABSOLUTE or FROM_LAST_COMPLIED. Blank numeric fields mean unknown; positive hours use at most one decimal place and cycles/calendar values are positive integers. If no numeric interval is provided, conditions must explain the requirement. No due dates are calculated for templates.

CSV preview identifies invalid rows; only selected valid rows are submitted. A batch save is atomic. Duplicate names within the same model/part/group, and repeat imports of a source row within the same model association, are rejected. Edit or unarchive the existing template instead. Version checks reject stale edits. Individual templates with tasks are limited to 800 KB; a save batch is limited to 2 MiB and 2,000 templates.

## Create an operational schedule

Choose **Create inspection** on an aircraft template, select a matching aircraft, enter the requested last-complied values, review the due preview and save. The new record appears in **Inspections**. Aircraft manufacturer/model must match the template, and maintenance permission is required.

For component templates, choose **Create component requirement**, select a matching installed component, and enter compliance using the template’s time basis. The requirement appears under **Components**. Model, manufacturer and any specified part number must match.

Initial and recurring schedules are separate choices when initial thresholds are defined. Initial/absolute limits do not require relative compliance readings. Recurring hour, cycle and calendar limits require their corresponding verified baseline. Aircraft calendar intervals use end-of-month deadlines; component intervals preserve the existing component calendar-unit rules. Day-based aircraft recurrence and aircraft TSO/TSR limits are explicitly blocked rather than converted incorrectly.

The creation is atomic: the schedule and template checklist tasks are saved together, with tasks as unsigned draft cards linked to that schedule. The template remains unchanged. Duplicate creation for the same template, target and schedule mode is blocked, including after template edits; use the existing record to edit it. Model access, current template version, archive status and compliance values are validated again on the server. Templates with conditions but no numeric limits need verified limits entered before activation.

## Add checklist tasks from a separate CSV

Use **Import tasks CSV**, select a template for the entire file, and upload the five-column task format. Tasks append to that template without changing its interval data. See [Task CSV import](task-csv-import.md). For schedules already created, select **Existing inspection** to attach the file directly to that schedule.

The interval-template CSV importer accepts case-insensitive option values (for example, `months` becomes `MONTHS`). Unknown units are still rejected. When a row has no numeric interval or initial threshold and its conditions column is blank, its description is also retained as the requirement's conditions. No numeric interval is extracted from narrative text; event-triggered, bulletin-dependent and environment-dependent requirements remain unscheduled until their intervals are explicitly entered. Descriptions are preserved, not shortened. The preview shows valid/error counts and readable field-level errors.

The supplied `C441_inspections(1).csv` has 59 rows and a maximum description length of 302 characters. Its 35 lowercase calendar-unit values and 11 narrative-only rows are accepted by this importer. Use **Inspection templates → Import template CSV** for this format; it is different from the manual-linked maintenance CSV format containing `id` and `pdf_page` columns.

## Per-aircraft calendar exemption

An aircraft inspection can be marked **Calendar exempt** in its Details form. A reason/reference is required. The saved calendar interval, compliance date and underlying due date remain intact; active calendar deadlines are excluded from remaining-time calculations, overdue/due-soon status, sorting and dashboard/preflight attention counts. Hour and cycle limits continue to apply. Calendar-only exempt inspections have no active deadline and do not generate missing-schedule alerts.

Unchecking the option restores calendar evaluation from the existing compliance date, without restarting the clock. The authenticated actor and server time are stored for exemption/reason changes, and the existing inspection audit retains before/after records. Older clients that omit these fields preserve existing exemptions on unrelated edits. The exemption applies to an individual aircraft inspection; shared templates are unchanged. No C441 phases are exempted automatically.
