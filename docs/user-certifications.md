# User certifications and license copies

Administrators can use **Administration → Add user** or **Edit access** to select Pilot and Certified mechanic. Airframe, Powerplant and Inspection Authorization (IA) are nested under Certified mechanic and appear when it is selected. Certified mechanic is one record with one license number, one issue date and one set of license copies. Airframe, Powerplant and IA are boolean qualifications on that record and have no separate numbers, issue dates or upload fields. Checking IA shows its optional renewal date. Pilot remains a separate record. The Pilot record keeps a **Medical or certificate expiration** date, which alerts its holder 30 days before it (`CERTIFICATE_WARNING_DAYS`). Dates and numbers may remain blank when not recorded; a renewal date cannot precede its issue date. Unchecking Certified mechanic clears its rating and IA selections.

Users can manage their own records through **My certifications** below the navigation, or **Settings → My account → Edit my certifications**. Certification selections are profile records and do not grant flight, maintenance or administrative permissions. A numbered, approved **Certified mechanic** record is, however, required to record a job card's inspection signoff; a pilot certificate alone is not enough ([Task cards](task-cards.md)).

## Approval

A certificate that is filed or changed, whether by its holder under My certifications or by a system administrator under **Edit access**, is **waiting for approval** until a Flight Program administrator or system administrator approves it. Until then it is not printed on logbook entries, AD compliance or work-order completions, is not offered under **Use saved certification**, and does not allow the inspection signoff; the form says "Waiting for an administrator's approval." and Settings lists it with "Waiting for approval". A certificate saved again unchanged keeps its approval; any change to its number, dates or ratings needs approval again, and blanks count as unchanged (a blank date and an unchecked rating are the same as none).

Approvers find the certificates waiting for them at the top of **Administration → Users**: a system administrator sees every member's, a Flight Program administrator those of the members of their active program. Each shows the holder, the certificate and its number, ratings and dates, with **Approve**. Check it against the holder's certificate first: approving says a second person has looked at it. Nobody approves their own certificate, administrators included, so a system administrator's own certificate needs another administrator. The approval is of the certificate exactly as the approver saw it: if the holder changed it meanwhile, the server refuses with "This certificate changed since you opened it. Review it again." License copies stay private to their holder and system administrators, so a Flight Program administrator approves from the certificate's details.

Every change writes a change-log entry against the member with the certificate before and after: `user.certification_filed`, `user.certification_edited`, `user.certification_removed` and `user.certification_approved`. These entries are account-wide, so system administrators read them in **Unassigned records**.

Certificates recorded before approvals existed count as approved: the deployment held no real records yet, and making every one wait would have stopped each current mechanic signing inspections until an administrator approved them. Only a filing or change made since is held for approval. The older single-license profile fields keep working for profiles that have them, but can no longer be saved from the logbook form; a certificate is now filed under My certifications, where it waits for approval.

Attach PDF, JPEG, PNG, WebP, HEIC or HEIF copies, up to 5 MiB per file. Files selected in the form upload when the form is saved. Existing copies can be viewed or deleted. Only the account owner and global administrators can list, open, upload or delete these documents. Deselecting a certification does not delete its existing documents; reselecting it makes those copies visible again.

Existing single-license profile fields remain supported until the user saves certification selections. Approved certification numbers prefill work-order logbook previews and completion snapshots. The generated logbook form offers **Use saved certification** when numbers are available for the entry's date. Recorded issue dates determine which records are offered. Legacy expiration dates no longer filter the choices. The IA renewal date records renewal information; it is not treated as an expiration date. The mechanic option uses its single number and selected qualifications, such as A&P IA. Earlier separate rating records are folded into the mechanic record when read and saved; the mechanic number takes precedence, falling back to the first recorded rating number if blank. Original rating details are retained as historical data, and their existing uploads remain accessible from the mechanic record. Manual entry remains available. Historical work-order completion snapshots are not rewritten when a profile changes.

## Flight Program access

User creation and access editing list Flight Programs as headings with permission-group checkboxes beneath them. Select Observers for read-only access or another group for its permissions. There is no separate program-access checkbox. Clearing every group under a program removes that user's membership in the program. Saving access does not create permission groups. Existing custom groups and legacy Read access memberships remain available and are preserved unless explicitly changed. Global administrators retain access to all programs.

Older published clients can still send program selections; the backend resolves them to an existing read-only Observers group and never creates a fallback group. If that group is unavailable, an explicit group selection is required.

New accounts are created before profile details and document uploads are saved. If a later step fails, the form retains the new account ID so retrying completes that account instead of creating another. Successful uploads are removed from the pending queue as they finish.

## Adding users as a Flight Program administrator

A member of a group marked **Flight Program administrator** can open **Administration → Add user** in that program. The form fixes the account's access to the active Flight Program and offers only that program's permission groups. With no groups selected, the account is assigned the existing read-only Observers group. If that group is unavailable or has been customized beyond read-only access, an explicit group selection is required. Program administrators can create and edit their program’s groups, assign program administrators, add aircraft, edit program aircraft, and change or remove users’ program access. They can add an existing active account by email and assign groups without changing its password or other program memberships. They cannot create global administrators, assign other programs, reset other users’ passwords, or change global account settings. Existing global administrator controls remain unchanged.

The backend checks the active program and administrator permission before provisioning and again before activating the account. New accounts remain inactive until their program membership is saved. If permission is revoked during provisioning, a global administrator can review the inactive account. An existing email cannot be used to replace an account or its password; use **Add existing user** to grant program membership to an active account. Removing access removes only memberships in the current program, without disabling the shared account.

Program administrators can see names, emails and program group memberships for active members of their current program. They see a member's certificate only while it waits for their approval; certifications and license copies otherwise remain private to their owners and global administrators.

## Flight Program administrator scope

The program administrator role grants all operational permissions throughout its Flight Program, independent of aircraft selections on the group. This includes flight entry and review; discrepancies; inspections, AD compliance and recurring maintenance; work orders and job cards; components and life tracking; parts requests; inventory and storage locations; vendors, purchasing, repairs and receiving; manuals and attachments; program settings, reports, exports and audit history. Existing operational validation, document history and work-order closeout rules still apply.

**Administration** includes Users, Permission groups and Aircraft. Program details, the default labor rate, the program's expiring dates, the Aircraft Spruce account, saved addresses and a partial CSV extract are in **Settings → Flight Program**. New aircraft and permission groups must belong to the current program. Group edits cannot move a group between programs or include aircraft from another program. Cross-program transfers, creation of additional Flight Programs, shared API credentials, global account status and password resets remain global administrator functions. Personal certification records remain private to the account owner and global administrators, except that a program administrator reviews and approves a member's certificate while it waits for approval.

## Default permission groups

Each new Flight Program automatically receives four groups covering all of its aircraft:

| Group                   | Permissions                                                           |
| ----------------------- | --------------------------------------------------------------------- |
| Observers               | Read                                                                  |
| Pilots                  | Read, add flights, report discrepancies                               |
| Maintenance technicians | Read, report discrepancies, resolve discrepancies, manage maintenance |
| Program managers        | Flight Program administrator; all program permissions                 |

Creating these groups does not enroll users. Administrators assign them through user access. Groups remain editable. Editing a program does not reset its groups or recreate renamed groups. The one-time initialization for existing programs adds missing group names only, preserves custom groups and current memberships, and can be retried without duplicates.

## Deleting permission groups

Use **Administration → Permission groups → Delete group**. Global administrators can delete any group; program administrators can delete groups only in their active Flight Program. The confirmation lists affected users and identifies users who will lose program access. Confirming removes the group from every assigned account and records an audit event; accounts and other group memberships remain intact. If the group or affected access changes after review, reopen the confirmation before deleting. Deleting a default group does not recreate it on ordinary program edits.

## Simplified pilot view

Users with flight permission and no maintenance, discrepancy-resolution or administrator permission in their active program receive a simplified view. It is based on permissions rather than group names. Navigation includes Overview, Flight plans, Checklists, Flight log, Discrepancies, Reference library and Sync center.

The pilot dashboard keeps aircraft photos, recorded aircraft status, flight entry, problem reporting, inspection warnings, component service-limit notices and AD notices. It shows the aircraft cards (status and **Log flight**) first, then AD alerts, then the counts. It hides purchasing, parts-planning, FAA credential renewal, flight-review totals and the maintenance outlook. Aircraft details retain inspection schedules while omitting parts planning. Discrepancy reports omit parts requests, linked job cards and work-order controls. Users with combined pilot and maintenance/admin roles retain the full interface. This is a presentation change; backend access checks remain in effect.

The Overview orders the same sections by role ([src/domain/overview.ts](../src/domain/overview.ts)). Administrators, and members with neither a pilot nor a maintenance role, see the fleet summary first: inventory and service-limit notice, counts, aircraft, AD alerts, FAA renewal, maintenance outlook. A mechanic (maintenance permission, not an administrator) sees what is overdue and due soon first: maintenance outlook, AD alerts, inventory and service-limit notice, counts, then the aircraft. No role loses a section it saw before.
