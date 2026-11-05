# Monitoring: errors, uptime and the backup heartbeat

How to switch on error reporting (Sentry) and outside monitoring (Better Stack). The code is in place and stays dormant until these keys exist: without `VITE_SENTRY_DSN` the build contains no Sentry code, and without `BACKUP_HEARTBEAT_URL` the nightly backup skips its ping. Browser reporting lives in `src/data/errorReporting.ts`; the deploy wiring in `.github/workflows/deploy.yml`.

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
8. Cloudflare Bot Fight Mode blocks uptime monitors. Turn it off (Cloudflare → Security → Bots), or allowlist the monitor.

## Privacy rules

9. Keep error reports free of personal data:
   - No session replay: never add Sentry's replay or feedback integrations.
   - No user identity: never call `Sentry.setUser`. `errorReporting.ts` turns off Sentry's user, IP address, cookie, header and query string collection.
   - No query strings: `beforeSend` strips them, with fragments, from the page URL and from breadcrumb URLs, because a sign-in redirect carries a one-time code. It also drops cookies and headers. `src/data/errorReporting.test.ts` pins this.
   - In Sentry → Project Settings → Security & Privacy, keep **Data Scrubber** on and turn on **Prevent Storing of IP Addresses** for both projects.
