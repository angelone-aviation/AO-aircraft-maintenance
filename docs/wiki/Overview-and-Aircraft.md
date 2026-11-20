# Overview and aircraft

The **Overview** is the first screen: fleet counts, each aircraft's status and
what comes due. The **Aircraft** page (under Manage) lists the aircraft with
their meters and profile.

![The Overview: fleet counts and aircraft cards](images/overview.png)

## The Overview

| Part                     | Shows                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Counts                   | Aircraft in your fleet, inspections approaching (within 10 hours or cycles, or 30 days), open discrepancies, flights awaiting review |
| Aircraft cards           | Status, **OK to fly** line, totals, Hobbs, tach, landings, hours this week, next inspection                                          |
| Hours flown              | Accepted flights over the last 8 weeks                                                                                               |
| Fleet readiness          | How many aircraft are Airworthy, Due soon, Setup incomplete or Grounded                                                              |
| Airworthiness directives | AD alerts                                                                                                                            |
| Maintenance outlook      | Inspections, component limits, ADs and open problems by urgency                                                                      |

The order changes by role: pilots see their aircraft first, mechanics the
maintenance outlook first, administrators the fleet summary first.

Use the star on a card to make an aircraft a favorite. Favorites are kept on
this device.

## Aircraft status

| Status           | Means                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Airworthy        | Nothing due soon or overdue, and setup is complete                                                           |
| Due soon         | An inspection, component limit or AD comes due soon                                                          |
| Setup incomplete | A setup step has no data yet; it shows the missing steps. It does not ground the aircraft                    |
| Grounded         | Something is overdue, a grounding problem is open, a deferral has expired, or the profile is marked grounded |

"Missing information never implies aircraft readiness." Only a fully set-up
aircraft can read Airworthy.

### OK to fly

Each card and the aircraft detail open with one line:

- **Not OK to fly** exactly when the aircraft is grounded. You cannot log a
  flight on it ([the dispatch gate](Flight-Log.md#the-dispatch-gate)).
- **OK to fly** otherwise, with an amber note when something is due soon.

It names one reason, chosen in this order: grounded in the aircraft profile,
an open grounding problem, an expired deferral, then inspections, ADs and
component limits. "+N more" counts the rest.

### When a limit is overdue

| Limit                     | Due soon                  | Overdue (grounds the aircraft)                  |
| ------------------------- | ------------------------- | ----------------------------------------------- |
| Hours, cycles or landings | Inside the warning window | At 0 remaining: the next flight would exceed it |
| Calendar date             | Up to and on the due date | From the day after the due date                 |

Component screens label a usage limit at exactly 0 **Due now** and beyond it
**Past due**. Both are overdue.

## View aircraft

**View aircraft** on a card opens the aircraft's detail.

![The aircraft detail dialog](images/view-aircraft.png)

| Section                        | What you can do                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Status notes                   | Read every reason behind the status                                                                              |
| Hours flown                    | Accepted flights, last 6 months                                                                                  |
| Inspection schedules           | Sort by name or what remains; **Manage** opens Inspections                                                       |
| Airworthiness directives       | AD alerts; **Manage ADs and compliance reports**                                                                 |
| Form 337 copies                | **Upload Form 337 copy** (PDF, JPEG, PNG or WebP, up to 7 MiB)                                                   |
| Maintenance parts availability | Shortages for open maintenance                                                                                   |
| Buttons                        | **Export status sheet**, **Export records package**, **Paper check (month)**, **Flight history**, **Log flight** |

The exports are described in
[Records package and exports](Records-Package-and-Exports.md).

## The Aircraft page

Each aircraft row shows total time source, Hobbs and tach, landings, profile
status and its status. Actions:

| Button                 | Does                                                                                   | Who                   |
| ---------------------- | -------------------------------------------------------------------------------------- | --------------------- |
| **Add aircraft**       | Adds an aircraft to the active Flight Program                                          | Administrators        |
| **Set up an aircraft** | Loads an aircraft's history step by step ([how](Administration.md#set-up-an-aircraft)) | Administrators        |
| **Edit aircraft**      | Changes identity, options, readings and the time source                                | Maintenance           |
| **Add component**      | Adds an installed component                                                            | Maintenance           |
| **Manuals**            | Opens the aircraft's manuals ([Reference library](Reference-Library.md))               | Everyone who reads it |
| **Engine trends**      | Shows engine-monitor file summaries against limits; maintenance imports them           | Everyone who reads it |

Administrators see setup chips such as "Components missing" or "ADs not
reviewed"; each opens the setup step that fills it.

### Time source and total time

Total time is the chosen meter (Hobbs, tach or flight time log) plus the
**Total time adjustment**. Switching the source keeps total time unchanged.

A correction to total time, cycles or landings is refused if it would fall
below the last compliance recorded on an inspection or AD. Correct that
record first.
