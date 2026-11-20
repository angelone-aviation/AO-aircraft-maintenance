# Monitoring: errors, uptime, the backup heartbeat, and alerts that reach people

How to switch on error reporting (Sentry), outside monitoring (Better Stack), and the alert email and push channels.

**Status, 20 Nov 2026:** Better Stack is set up: the two uptime monitors and the backup heartbeat (steps 6 to 8). The heartbeat's URL is the `backups` secret `BACKUP_HEARTBEAT_URL`, and the first nightly backup pinged it. Device push (step 10) waits for its VAPID keys. Sentry (steps 1 to 5) is supported by the code but not used.

The code is in place and stays dormant until these keys exist: without `VITE_SENTRY_DSN` the build contains no Sentry code, without `BACKUP_HEARTBEAT_URL` the nightly backup skips its ping, without the Resend variables no email goes out, and without the VAPID variables no device can be alerted. Browser reporting lives in `src/data/errorReporting.ts`; the deploy wiring in `.github/workflows/deploy.yml`.

## Sentry: browser errors

1. Create a Sentry organization and a **React** project. Copy the project's DSN (Project Settings → Client Keys). A DSN is public: it only lets a browser send events. In GitHub → Settings → Secrets and variables → Actions → **Variables**, add `VITE_SENTRY_DSN` with that value, on the repository or the `production` environment. Not a secret.
2. Add the DSN's ingest host to `connect-src` in `public/_headers`, exactly, without a wildcard: for `https://<key>@o123456.ingest.us.sentry.io/789` add `https://o123456.ingest.us.sentry.io`. Add it to the `connect-src` list in `tests/e2e/security-headers.spec.ts` too, run `npm run test:e2e` and merge. Until the policy allows the host, every deploy stops at `scripts/check-csp-origin.mjs --sentry-dsn`, before Convex or the website changes.
3. Optional, for readable stack traces: in Sentry → Settings → Auth Tokens, create an organization token (scope `org:ci`). Add `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` (the organization slug) and `SENTRY_PROJECT` (the project slug) as secrets on the `production` environment. The build then uploads hidden source maps and deletes them; the deploy fails if any `.map` file is left in `dist/`. A failed upload does not stop a release. If the token leaks, revoke it in Sentry, create a new one and replace the secret.
4. Deploy, open the site, and in the browser console run `setTimeout(() => { throw new Error("Sentry test") })`. Check that the event reaches Sentry with the deployed commit as its release. Events recorded offline are sent at the next start-up. To switch browser reporting off, delete the variable and deploy.

## Sentry: server errors

5. Create a second Sentry project for **Node.js** and copy its DSN. In the Convex dashboard, on the production deployment, open Settings → Integrations → **Sentry** and paste it. This needs Convex Pro. Check the first server event for personal data.

## Better Stack: uptime and the backup heartbeat

6. Create two HTTP monitors: `https://ops.angeloneaviation.org/`, and the Convex deployment's `https://<deployment>.convex.site/.well-known/openid-configuration` (the sign-in service).
7. Create a heartbeat with a 24-hour period and a grace period of a few hours, since GitHub can start scheduled runs late. In GitHub → Settings → Environments → `backups`, add its URL as the secret `BACKUP_HEARTBEAT_URL`. The next successful **Nightly backup** pings it; a failed or skipped run sends no ping, so Better Stack alerts.
8. Cloudflare Bot Fight Mode blocks uptime monitors. Keep it off (Cloudflare → Security → Settings → **Bot traffic**; Aaron turned it off on 19 Nov 2026), or allowlist the monitor.

## Alerts by email and on devices

The rules are in [docs/alerts.md](../alerts.md); this is the operator's part.

**Records time zone.** Set the deployment's records time zone first if the program is not on US Eastern time: `npx convex env set RECORDS_TIME_ZONE America/Chicago --prod` (an IANA name; the default is `America/New_York`). The server judges "overdue", "expired" and "grounded" by the date in that zone, so the emails and push messages agree with what members see on the due date; left on the default, a program further west gets them up to three hours before its own midnight. Use the same value for the `RECORDS_TIME_ZONE` variable of the `backups` environment in GitHub, which sets the readable workbook's time zone ([Dropbox records copy](dropbox-records-copy.md)).

9. **Email (Resend).** `RESEND_API_KEY` and `RESEND_FROM` on the Convex deployment turn on the daily digest (13:00 UTC) and the immediate emails for urgent alerts. Resend's free tier sends **100 emails a day**. The app spends at most **60 a day on immediate emails** for the whole deployment (`IMMEDIATE_EMAILS_PER_DAY` in `src/domain/alerts.ts`, counted in the `rateLimits` table under `alerts:immediate`, reset at 00:00 UTC; an email Resend refuses is not counted), leaving at least 40 for the digest. Count the members with **Email me a daily alert digest** on: above 40, lower the cap or move Resend to a paid plan, or the digest run logs "Email provider rejected the request (429)" for the rest. The check's result in the Convex logs (`sendImmediate`) reports `sent`, `failed` and `capped`. Each Flight Program may spend only its share of the 60 (`immediateEmailShare`: an equal split between the programs with an active member, at least 10 each), counted under `alerts:immediate:<program uuid>`, so one program's flood of urgent alerts cannot hold back another's. When a program's share first holds an email back in a day, the log shows "A Flight Program reached its share of immediate alert emails" with its uuid, and the system administrators with urgent emails on get "System: <program> reached its share of urgent alert emails". If that recurs for a program, look at how many of its members get urgent emails before raising `IMMEDIATE_EMAILS_PER_DAY`.
10. **Push (Web Push).** Generate one VAPID key pair for the deployment on a trusted computer: `npx web-push generate-vapid-keys` (nothing is installed in the repository; the command prints a public and a private key in base64url). Set them on the Convex deployment, never in the repository or `.env` files:

    ```sh
    npx convex env set VAPID_PUBLIC_KEY <public key> --prod
    npx convex env set VAPID_PRIVATE_KEY <private key> --prod
    npx convex env set VAPID_SUBJECT mailto:accounts@angeloneonline.org --prod
    ```

    All three must be set before **Settings → Alerts → Alert this device** appears; until then that block, and Settings → System → Deployment status, say that alerts on devices are not turned on. Record the pair under **Settings → System → Deployment expiring dates** with a yearly review date, and in the [accounts inventory](accounts.md). Rotating the pair invalidates every device's subscription: each device's switch then reads off, and members switch it on again on each device. The server removes the old subscriptions after their push services refuse them on three checks in a row. If the private key leaks, rotate it the same way.

11. **Checking delivery.** Turn **Alert this device** on in a browser, then save an expiring date with yesterday's date under Settings → Flight Program: within a minute the device shows "<program>: 1 urgent alert" and the opted-in members receive the email. The Convex logs show `sendImmediate` with `pushed: 1` and `sendUrgent` with `sent: 1`. A push service that answers 404 or 410 has that device's subscription removed; the member switches alerts on again.

## Privacy rules

12. Keep error reports free of personal data:

- No session replay: never add Sentry's replay or feedback integrations.
- No user identity: never call `Sentry.setUser`. `errorReporting.ts` turns off Sentry's user, IP address, cookie, header and query string collection.
- No query strings: `beforeSend` strips them, with fragments, from the page URL and from breadcrumb URLs, so nothing a URL carries leaves the device. It also drops cookies and headers. `src/data/errorReporting.test.ts` pins this.
- In Sentry → Project Settings → Security & Privacy, keep **Data Scrubber** on and turn on **Prevent Storing of IP Addresses** for both projects.
