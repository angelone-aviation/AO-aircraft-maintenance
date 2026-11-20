# Administrator guide

There are two kinds of administrator.

| Kind                         | Scope                                | Only they can                                                                                                                              |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Flight Program administrator | One Flight Program, all its aircraft | Review held flights, override the dispatch gate, correct AD compliance, run inventory and purchasing, see costs, read the Weekly summary   |
| System administrator         | Every Flight Program                 | Create Flight Programs, transfer records between programs, reset passwords, disable accounts, edit system settings, see unassigned records |

A Flight Program administrator holds every operational permission in the
program, as a pilot and a mechanic do. See the [Pilot](Pilot.md) and
[Mechanic](Mechanic.md) guides for that work.

## What you see

Everything a mechanic sees, plus **Inventory**, **Purchase orders**,
**Vendors**, **Administration**, **Costs** and **Board view**. Your Overview
opens with the fleet summary.

## Daily work

| Task                                  | Where                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Review held flights                   | **Flight log**, status **Needs review** → **Review** ([how](Flight-Log.md#review-a-held-flight)) |
| Approve certificates                  | Top of **Administration → Users** ([how](Administration.md#approve-a-certificate))               |
| Read alerts                           | The bell, or **Alerts** ([Alerts](Alerts.md))                                                    |
| Resolve or defer problem reports      | **Discrepancies** ([how](Discrepancies.md))                                                      |
| Override the dispatch gate, if needed | The flight form, with a reason ([how](Flight-Log.md#the-dispatch-gate))                          |
| Reserve, issue and order parts        | **Parts & repair requests**, **Purchase orders** ([how](Inventory-and-Parts-Requests.md))        |

## Weekly and monthly work

| Task                                  | Where                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Review the change log                 | **Change history → Summary** ([Weekly summary](Weekly-Summary.md))                          |
| Check due items across the fleet      | **Planning** ([Planning and due items](Planning-and-Due-Items.md))                          |
| Paper check against the paper logbook | **Flight log → Paper check (month)** ([how](Records-Package-and-Exports.md#paper-check))    |
| Check costs against the budget        | **Costs** ([how](Records-Package-and-Exports.md#costs))                                     |
| Check expiring dates                  | **Settings → Flight Program → Program expiring dates** ([Alerts](Alerts.md#expiring-dates)) |

## People and access

- Add users, edit their access and manage permission groups in
  [Administration](Administration.md).
- Add aircraft and load their history with **Set up an aircraft**
  ([Administration](Administration.md#set-up-an-aircraft)).
- Program details, the labor rate and the program's expiring dates are in
  [Settings](Settings.md#flight-program).

## System administrators only

- **Unassigned records** at the top of the Flight Program selector shows
  records no program owns, and account-wide change-log entries.
- **Flight Programs** creates programs and transfers aircraft, components and
  locations between them ([how](Administration.md#transfer-records-between-programs)).
- **Settings → System** holds the FAA API key, address lookup, deployment
  expiring dates and the off-site backup status ([Settings](Settings.md#system)).
- How the system runs, its costs and its backups are in the
  [handbook](../handbook/README.md).

## Your regular checks

See the ["Daily"](../handbook/3-running-it/checklists.md#daily),
["Weekly"](../handbook/3-running-it/checklists.md#weekly) and
["Monthly"](../handbook/3-running-it/checklists.md#monthly) sections of the
checklists.

1. Daily: **Flight log** filtered to **Needs review**; review each held
   flight.
2. Daily: certificates waiting at the top of **Administration → Users**.
3. Daily: alerts under the bell, especially grounded aircraft and a member's
   problem reports piling up.
4. Weekly: **Change history → Summary** for dispatch overrides, permission
   changes and corrections.
5. Monthly: the paper check for each aircraft, the expiring dates, and
   **Costs** against the budget.
