# Change history

**Change history** (`/history`) is the append-only change log of the active Flight Program: every submission, correction and administrative change, newest first, with who made it, when, the reason where one was required, and the recorded values before and after. Anyone who can read the program can open it; what each person sees follows the same visibility rules as their snapshot, so inventory, cost and expiring-date entries stay with program administrators and aircraft entries with those who can read the aircraft. Entries about the program's permission groups, its members' access and its saved addresses are also for its administrators only; account-wide entries (password resets, sessions ended, refused sign-ins) are for system administrators in **Unassigned records**. The log is protected by access and off-site backups, not by edits: no code path changes or deletes an entry ([ADR-0005](adr/0005-audit-log-protection-by-access-and-backups.md)). Paging, the aircraft filter and how history follows a record after a Flight Program transfer are described in [Flight Program access](flight-program-access.md).

## Weekly summary

Flight Program administrators get a second tab, **Weekly summary**, for the periodic review of the log without reading it entry by entry.

- **Period**: the last 7 days by default, the last 30 days, or a custom range of dates (inclusive). Days are the server's dates of each entry.
- **Changes by person**: one row per person with the number of entries they made in each action family, and a total; most active first. The families group the stored actions by their type: flights and discrepancies (`flight.*`, `discrepancy.*`, `plan.*`); inspections and components; ADs; work orders and job cards; parts and purchasing (`stock.*`, `partsRequest.*`, `po.*`, inventory, locations, vendors); users and access (`user.*`, `group.*`, `program.*`); FAA; and other.
- **Notable events**, newest first, each with a link to its screen where one exists: dispatch overrides; permission changes (groups saved or deleted, memberships and program access changed); account changes (users created, disabled, password reset, sessions ended); archives and deletions; and corrections, meaning any other entry that carries a reason, shown with the reason.
- **Refused sign-ins** are counted only. Their entries record the email a stranger typed, and the summary never repeats it.
- **Export CSV** saves the table (`change-summary-<from>-to-<to>.csv`) with a column per family and a final refused sign-ins row.

The server builds the summary from the same entries the change log pages, under the same visibility rules, and reads at most 4,000 entries per request. When a period holds more, the summary says so and counts only the newest entries it read; choose a shorter period. In the demo the summary covers the changes made during the session, since the demo starts with an empty log. The summary needs a connection.
