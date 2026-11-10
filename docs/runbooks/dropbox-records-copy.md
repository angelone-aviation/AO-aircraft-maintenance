# Dropbox records copy

Policy: [ADR-0011](../adr/0011-readable-records-copy-in-dropbox.md). The nightly backup job ([backup and restore](backup-restore.md)) turns the Convex export into one formatted Excel workbook and adds it to a Dropbox folder. It is a copy for reading; the aircraft logbooks and the encrypted R2 backup are the records. A sample built from the demo program is in [`docs/samples/angel-one-records-sample.xlsx`](../samples/angel-one-records-sample.xlsx).

| File in the app folder                    | Made                                 | Kept                             |
| ----------------------------------------- | ------------------------------------ | -------------------------------- |
| `Daily/Angel One records YYYY-MM-DD.xlsx` | Every night                          | 90 days, then the job removes it |
| `Monthly/Angel One records YYYY-MM.xlsx`  | First successful night of each month | Forever                          |

The scripts are `scripts/backup/records-workbook.mjs` (builds the workbook) and `scripts/backup/dropbox-upload.mjs` (uploads it and removes old daily copies). The step is skipped while `DROPBOX_REFRESH_TOKEN` is not set.

## Which Dropbox account owns the app

Use an **organization account**, for example the program's operations or IT account, **not a person's own Dropbox**. The app and its refresh token belong to that account: if it is a person's and they leave, the copies and the token leave with them. Turn on **two-step verification** for the account. Record the account in [external accounts](accounts.md).

## 1. Create the Dropbox app

1. Sign in to the [Dropbox App Console](https://www.dropbox.com/developers/apps) as the organization account and choose **Create app**.
2. Choose **Scoped access**, then **App folder**, and name it, for example `Angel One records`. Dropbox creates the folder `Apps/Angel One records` in that account. The app can see nothing outside it.
3. On the **Permissions** tab, tick `files.metadata.read`, `files.content.write` and `files.content.read`, then **Submit**. Do this before step 2: a token keeps the permissions the app had when it was issued.
4. On the **Settings** tab, note the **App key** and **App secret**. The app can stay in Development status; only the owning account uses it.

## 2. Get a refresh token

1. In a browser signed in as the organization account, open (with your app key):

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline
   ```

2. Choose **Allow**. Dropbox shows an access code; it works once, for a few minutes.
3. Exchange the code for a refresh token. Typing the secret at the prompt keeps it out of your shell history:

   ```sh
   read -rs DROPBOX_APP_SECRET   # paste the app secret, press Enter
   curl -sS https://api.dropbox.com/oauth2/token \
     -u "<APP_KEY>:$DROPBOX_APP_SECRET" \
     -d grant_type=authorization_code \
     -d code=<ACCESS_CODE>
   unset DROPBOX_APP_SECRET
   ```

4. The answer contains `"refresh_token": "..."`. Copy that value straight into the GitHub secret below, then clear the terminal. Do not save it in a file, an email or a chat. The refresh token does not expire, but it stops working if the app is deleted, the app secret is regenerated, or someone disconnects the app under the account's **Settings > Connected apps**.

## 3. Add the GitHub secrets

In the repository: **Settings > Environments > `backups` > Environment secrets**, add:

| Secret                  | Value                     |
| ----------------------- | ------------------------- |
| `DROPBOX_APP_KEY`       | App key from step 1       |
| `DROPBOX_APP_SECRET`    | App secret from step 1    |
| `DROPBOX_REFRESH_TOKEN` | Refresh token from step 2 |

Optional: an environment **variable** `RECORDS_TIME_ZONE` (an IANA name such as `America/Chicago`) changes the time zone the workbook uses. The default is `America/New_York`. The Convex deployment has its own `RECORDS_TIME_ZONE`, for the calendar day of alerts ([monitoring](monitoring.md#alerts-by-email-and-on-devices)); give both the same zone.

## 4. Check it works

Run the nightly backup workflow by hand (**Actions**, the backup workflow, **Run workflow**). Its log should end the Dropbox step with lines like:

```
Uploaded /Daily/Angel One records 2026-11-04.xlsx (1.2 MB).
Uploaded /Monthly/Angel One records 2026-11.xlsx, this month's copy to keep.
No daily copies older than 90 days.
```

Then open the file from the Dropbox folder and read its **Read me** sheet.

## Who may have access to the folder

The workbook holds everything the app holds except passwords, credentials and uploaded files: names, email addresses, costs, and the full change history. It is **not encrypted**.

- Share the `Apps/Angel One records` folder **view-only**, with **named people**: system and Flight Program administrators, a board member who needs it, and an inspector or auditor for the time of an inspection. Do not create "anyone with the link" links.
- Remove people when they leave or the inspection ends. Review the list at each quarterly restore rehearsal.
- Nobody needs edit access. Changes made in the folder are not saved in Angel One and do not carry into the next night's file. Deleting a file there loses only that convenience copy; the R2 archive is unaffected.

## If the job reports a Dropbox error

The Dropbox step runs after the R2 copy is uploaded and recorded, so a Dropbox error never means the backup is missing. Each night's workbook is complete, so a missed night needs no catching up.

| Message                                                | Cause                                                                 | What to do                                                                                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DROPBOX_... is not set`                               | A secret is missing from the `backups` environment                    | Add it (step 3), or remove all three to turn the copy off                                                           |
| `Dropbox refused the app key, secret or refresh token` | The token was revoked, the app secret regenerated, or the app deleted | Repeat step 2 and replace `DROPBOX_REFRESH_TOKEN` (and the other secrets if they changed)                           |
| `Dropbox refused the access token ... missing_scope`   | A permission is missing                                               | Tick the permissions in step 1, then repeat step 2: an old token keeps its old permissions                          |
| `Dropbox kept answering 429` or `5xx`                  | Dropbox is busy or down (the job already retried with back-off)       | Nothing; the next night tries again. Check [Dropbox status](https://status.dropbox.com) or rerun the workflow later |
| `... insufficient_space`                               | The Dropbox account is full                                           | Free space or upgrade the plan                                                                                      |
| `... already exists; left it unchanged`                | Not an error: the workflow ran twice that day or month                | Nothing. Files are added, never replaced                                                                            |
| `records-workbook: ...`                                | The workbook could not be built from the export                       | Open an issue with the message. The export is untouched in R2                                                       |

## Making a workbook from an older backup

To see the records as they were on a given night, decrypt that night's R2 archive ([backup and restore](backup-restore.md)) and build the workbook on your computer:

```sh
npm ci
npm run backup:workbook -- --zip snapshot.zip --out "Angel One records 2026-11-04.xlsx"
```

Delete the decrypted ZIP afterwards. Add `--tz America/Chicago` for another time zone.

## Turning it off

Delete the three secrets; the step is skipped. To stop for good, also delete the app in the Dropbox App Console, which revokes its token.
