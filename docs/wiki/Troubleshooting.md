# Troubleshooting

Find the message you see, then follow the fix. Messages are quoted as the app
shows them.

## Signing in

| Message                                                                                                                                | Fix                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Email or password is incorrect. After too many wrong tries, sign-in pauses for a while; your administrator can reset your password."  | Check both. After 10 wrong tries in an hour, sign-in pauses: one more try is allowed every 6 minutes. A system administrator's password reset clears it at once. |
| "Connect to sign in for the first time on this device."                                                                                | Connect, then sign in                                                                                                                                            |
| "Accounts are managed by your administrator." with "No active Angel One account uses the email of that Google account." (or Microsoft) | Sign in with your password, or ask your administrator to use that email                                                                                          |
| "Google did not confirm that email address." (or Microsoft)                                                                            | Sign in with your password                                                                                                                                       |
| "Sign-in with Google did not finish." (or Microsoft)                                                                                   | Try again, or sign in with your password                                                                                                                         |
| **Time to reconnect.** "Your seven-day offline access has expired. Pending entries are preserved. Sign in again to continue."          | Connect and **Return to sign in**. Use the same account so your entries sync.                                                                                    |
| "This device's clock is behind the time you signed in. Set the date and time to update automatically, then reopen the app."            | Turn on automatic date and time                                                                                                                                  |

## The app will not open

| Message                                                                                                                                                | Fix                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your workspace could not be opened.**                                                                                                                | **Try again**. Or **View the copy on this device** to work as if offline. Your records and pending entries are safe. If it keeps happening, tell your Flight Program administrator. |
| **Something went wrong.**                                                                                                                              | Reload the page                                                                                                                                                                     |
| "This part of the app could not be loaded on this device. Connect to the internet and try again; once it has been used online, it also works offline." | Connect once, open that screen, then it works offline too                                                                                                                           |
| "A new version is ready. Save any open form first."                                                                                                    | Save your form, then **Reload now**                                                                                                                                                 |

## Logging a flight

| Message                                                                                        | Fix                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| "N206MA is grounded: … Resolve these items or ask a Flight Program administrator to override." | The aircraft may not fly. Resolve or defer the items, or an administrator records an override ([dispatch gate](Flight-Log.md#the-dispatch-gate)). |
| "Only a Flight Program administrator can override a grounded aircraft."                        | Ask an administrator                                                                                                                              |
| "Explain the dispatch override in 10–1000 characters."                                         | Write a longer reason                                                                                                                             |
| "Use a point for decimals, as in 2342.5, and leave out thousands commas."                      | Type `2342.5`, not `2342,5` or `2,342.5`                                                                                                          |
| "Select an active pilot." or "Pilot must belong to this Flight Program."                       | Pick a current member of the program                                                                                                              |
| "Aircraft readings changed. Go back and verify the latest readings."                           | Someone logged a flight on the aircraft. Go back and check the new starting readings.                                                             |
| "Aircraft access has changed. Reopen Start flight."                                            | Your access changed. Reopen **Start flight**.                                                                                                     |
| The flight shows **Needs review**                                                              | Nothing is lost. An administrator reviews it ([why](Flight-Log.md#flights-held-for-review)).                                                      |

## Pending entries

| Message or status                                                                                                                                      | Fix                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Needs attention** in Sync center                                                                                                                     | Read the reason. **Edit and retry**, or **Discard entry**.                        |
| "This entry was already received with different readings, which were not saved. Check the flight log, then discard this copy or log the flight again." | The flight is already on the server. Check the Flight log, then discard the copy. |
| "This report was already received with different details, which were not saved. Check Discrepancies, then discard this copy or report it again."       | The same, for a problem report                                                    |
| "You have too many open problem reports. Ask an administrator to resolve or defer some of your open reports, then send this one again."                | An administrator resolves or defers some reports; then **Sync now**               |
| "Could not discard the entry. Try again."                                                                                                              | Try again                                                                         |
| An entry never sends                                                                                                                                   | Check it was made in the Flight Program now active; switch back if not            |

## This record was changed by someone else

"This record was changed by someone else. Review the differences."

Someone saved the record after you opened it. Nothing was overwritten. On
inspections, components, ADs, work orders and purchase orders, a review opens
and lists every field either of you changed:

| Choice         | Does                                                       |
| -------------- | ---------------------------------------------------------- |
| **Keep mine**  | Saves only the fields you changed, on top of their save    |
| **Use theirs** | Reloads the form from their save; your changes are dropped |
| **Cancel**     | Returns to your form, so you can copy a value first        |

**Keep mine** is not offered when the two saves describe one fact differently
(for example, both recorded a completion). Then **Use theirs** and make your
change again. Other forms show the message only: close and reopen the record.

## A photo is refused

| Message                                                                                                         | Fix                                                         |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| "HEIC photos are not accepted. Choose JPEG, PNG or WebP; on an iPhone set Camera > Formats to Most Compatible." | Change the iPhone camera setting, then take the photo again |
| "This file's contents do not match its type. Choose a PDF, JPEG, PNG or WebP file."                             | The file was renamed; export it in a real accepted format   |
| "This aircraft already has the maximum of 500 current logbook page photos."                                     | Ask an administrator to archive old photos                  |
| "Too many aircraft document uploads. Wait an hour and try again."                                               | Wait an hour; **Sync now** sends a queued photo again       |
| "Uploaded file is not a PDF."                                                                                   | Choose a real PDF manual                                    |

Files are limited to 7 MiB (manuals 200 MiB, certificate copies 5 MiB).

## Signing a job card

The inspection signoff messages are listed in
[Job cards](Job-Cards.md#who-can-sign).

## Access

| Message                                                                       | Fix                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| "You do not have permission for this aircraft."                               | Ask your Flight Program administrator for the right group |
| "Aircraft owner access is read-only." / "Board access is read-only."          | These views cannot change records                         |
| "Records packages are for users with maintenance permission on the aircraft." | Ask a mechanic or administrator for the package           |
| "Administration requires a connection."                                       | Connect                                                   |
| "Older records need a connection"                                             | Connect, then **Load older**                              |
| "The cost report needs a connection."                                         | Connect                                                   |
| "Cached work orders are available. Reconnect to make changes."                | Connect                                                   |
| A screen is missing from your menu                                            | Your groups decide what you see ([roles](Home.md#roles))  |

## Administration

| Message                                                                               | Fix                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| "This certificate changed since you opened it. Review it again."                      | Reopen and check the certificate before approving         |
| "This expiring date changed. Refresh and try again."                                  | Reload, then edit again                                   |
| "An inspection with this name is already on the aircraft."                            | The setup row is already saved; correct it on Inspections |
| "This browser's alert service is not supported. Use Chrome, Edge, Firefox or Safari." | Use a supported browser for device alerts                 |

Still stuck? Choose **Export pending entries** in Sync center before trying
anything that might lose data, and contact your Flight Program administrator.
