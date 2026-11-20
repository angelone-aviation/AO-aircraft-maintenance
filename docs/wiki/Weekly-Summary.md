# Weekly summary

The **Summary** tab of [Change history](Change-History.md) lets a Flight
Program administrator review a period of the change log without reading it
entry by entry. It needs a connection.

![The Summary tab of Change history](images/weekly-summary.png)

## Review a week

1. Open **Change history → Summary**.
2. Choose **Last 7 days** (the default), **Last 30 days** or **Custom** dates.
   Days are your own device's days.
3. Read **Changes by person** and **Notable events**.
4. Follow a notable event's link to its screen to check it.
5. **Export CSV** saves the table as `change-summary-<from>-to-<to>.csv`.

## What it shows

| Section           | Shows                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changes by person | One row per person: entries in each family (flights and discrepancies, inspections and components, ADs, work orders and job cards, parts and purchasing, users and access, FAA, other) and a total. Most active first. |
| Notable events    | Dispatch overrides, permission changes, account changes, archives and deletions, and corrections (any other entry with a reason, shown with it). Newest first.                                                         |
| Refused sign-ins  | A count only, never the email typed                                                                                                                                                                                    |

Refused sign-ins, password resets, ended sessions and permissions set by a
system administrator belong to no Flight Program. Inside a program the summary
says so; system administrators review them under **Unassigned records**, the
only place the refused sign-ins are counted.

## Limits

A very busy period may be cut short; the summary then says so and counts only
the newest entries it read. Choose a shorter period.

In the demo, the summary covers only the changes made during the session.
