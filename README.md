# Angel One

Aircraft operations and maintenance tracker built with **React, Vite, TanStack Router, Zustand, and Convex**. It holds the maintenance and status records a 14 CFR Part 91 operator must keep, scoped by **Flight Program** with permission groups. Features include:

- accounts, programs and aircraft permissions;
- a Set up an aircraft wizard that loads an aircraft's history from CSV templates after a dry run ([aircraft setup](docs/aircraft-setup.md));
- flight logging and discrepancies, with offline sync;
- aircraft status, a dispatch gate and MEL deferrals;
- inspections, task cards, work orders and generated logbook-entry wording;
- component life tracking and airworthiness directives with FAA DRS monitoring;
- forecasting, alerts and a daily email digest;
- inventory with QR labels, shelf life and core returns;
- purchase orders, parts requests and Aircraft Spruce ordering;
- engine trends, cost tracking and an owner portal;
- an audited change log with History.

See [the agreed scope](docs/first-delivery.md), [original requirements](requirements.md) and the vocabulary in [GLOSSARY.md](GLOSSARY.md).

[Desktop preview](docs/previews/desktop.png) · [Mobile preview](docs/previews/mobile.png)

## Project status

**Not yet in production use.** The app is going through a pre-launch hardening program, with the remaining work in the [go-live checklist](docs/go-live-checklist.md).

- **Standing decisions** are in [`docs/adr/`](docs/adr/), for example administrator-provisioned accounts, the app as a status-record system and not the signed maintenance record, change-log protection, the Convex plan, backups and sign-in methods.
- **Security**: an [in-house review](docs/security/review-2026-11-02.md) was completed on 2026-11-02. Its critical finding (an auth-library flaw that let anyone delete records) and its Medium and Low fixes are merged. The old test deployment that predated it has been deleted; production starts fresh on the fixed code. A [second review](docs/security/review-2026-11-04.md) on 2026-11-04 found nothing Critical or High; its fixes are merged and its open items are listed there. To report a vulnerability, see [SECURITY.md](SECURITY.md).
- **Operations**: the runbooks are [release and rollback](docs/runbooks/release.md), [accounts](docs/runbooks/accounts.md), [production database access](docs/runbooks/database-access.md), [backup and restore](docs/runbooks/backup-restore.md), [Dropbox records copy](docs/runbooks/dropbox-records-copy.md), the [credential encryption key](docs/runbooks/credentials-key.md), [monitoring](docs/runbooks/monitoring.md), [incident response](docs/runbooks/incident-response.md) and [break-glass administrator access](docs/runbooks/break-glass-admin.md).
- **Architecture**: see the [architecture report](docs/architecture/README.md).

## Start the app

Requires Node.js 22.12+ and npm.

```sh
npm ci
npm run dev
```

Open <http://localhost:5173>. Choose **Explore the local demo** to use fictional aircraft with persistent browser storage. The demo is explicitly labeled and isolated from live Convex data. You can also run `npm run dev:demo`. Demo accounts do not authenticate real users.

## Connect Convex and create accounts

In a separate terminal:

```sh
npm run dev:backend
```

Choose a local or cloud development project. For an account-free local backend, run `npm run dev:local`. Convex writes `.env.local` with `VITE_CONVEX_URL`; restart Vite if necessary. Keep the backend terminal running. The `dev:local` command pins the backend version compatible with this Debian Bookworm container; newer backend binaries may require newer system libraries. If your container filesystem does not report file-change events, restart this command after backend edits to push the current functions.

Configure authentication, then create the first administrator:

```sh
npm run setup:auth
npm run setup:admin
```

`setup:auth` generates signing keys on the selected deployment without printing them, preserves an existing key, and sets `SITE_URL` (default `http://localhost:5173`; override with the `SITE_URL` environment variable). It also creates `CREDENTIALS_ENCRYPTION_KEY` (32 random bytes, base64) if the deployment has none. That key encrypts saved Aircraft Spruce, FAA and Geoapify credentials with AES-GCM; saving those credentials fails until it is set. To set it by hand: `openssl rand -base64 32 | npx convex env set CREDENTIALS_ENCRYPTION_KEY`. Never change or delete it in place on a deployment with saved credentials, or administrators must re-enter them; to rotate it, follow [the credential key runbook](docs/runbooks/credentials-key.md). Unencrypted values are refused. `setup:admin` prompts for name, email, and a hidden password (15–128 characters, not a common password). It passes the password to the deployment through a temporary `BOOTSTRAP_ADMIN_PASSWORD` environment variable (over stdin, never in process arguments) and removes it afterward. It only works with an empty user database and invokes an internal function, never a public signup endpoint. Keep credentials private.

Maintenance alerts appear under the bell in the header for everyone, including demo mode. To also email a daily digest (13:00 UTC) of new alerts, set a [Resend](https://resend.com) API key and a verified sender on the deployment: `npx convex env set RESEND_API_KEY re_...` and `npx convex env set RESEND_FROM "Angel One <alerts@your-domain>"`. Without both, email is skipped and in-app alerts keep working. Digests link back to `SITE_URL`. Program administrators receive digests by default; anyone can change this under Settings → My account (or My certifications). Urgent alerts (a grounded aircraft, an overdue inspection or AD, a component past its limit, an expired date) also go out at once: by email to program administrators and maintenance members (switch under Settings → My account; at most 60 a day so the digest fits Resend's free 100), and to devices members switch on under Settings → This device once the deployment has Web Push keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; see the [monitoring runbook](docs/runbooks/monitoring.md#alerts-by-email-and-on-devices) and [docs/alerts.md](docs/alerts.md)). System administrators whose alert email is on also get an "Off-site backups" warning, at the top of their digest or on its own, while the newest nightly off-site backup is more than 36 hours old or none has been recorded; Settings → System shows the newest copy.

In the app, system administrators create Flight Programs, permission groups, and users. Assign each user to program-specific groups to grant access. Select the active Flight Program in the header; aircraft and locations inherit it automatically. See [Flight Program access](docs/flight-program-access.md) for setup, roles, transfers, and offline isolation. Administrators can reset passwords; a reset also ends the user's sessions and clears a sign-in lockout (10 failed attempts per hour). Disabling a user ends their sessions. Public password signup and password-reset registration paths are disabled server-side. Passwords that administrators set need 15–128 characters and must not be common; existing shorter passwords keep working until their next reset. Once their sign-in clients are configured, users can also sign in with a Google or Microsoft account whose verified email matches their account; this never creates an account ([ADR-0009](docs/adr/0009-password-for-everyone-plus-google-and-microsoft.md)). See the [accounts runbook](docs/runbooks/accounts.md).

The local smoke test creates a development-only administrator if needed and saves its credentials to ignored `.env.local-admin.json`. If that file exists in this workspace, use that account for the existing local database instead of rerunning the empty-database bootstrap. Test aircraft are clearly named `TEST-*`. Create a separate Convex project for operational use.

## Offline and installation

```sh
npm run build
npm run preview
```

Open the preview URL online, sign in, and allow the app to cache before testing offline. The service worker is enabled in production builds, not the Vite development server. On iOS use Safari → Share → **Add to Home Screen**; on Android/desktop use the browser's install action. Production requires HTTPS. Native app-store packages are outside this PWA delivery.

Only flight and discrepancy additions are available offline; a photo of the paper logbook line taken for a flight that has not synced waits on the device and uploads after it ([logbook page photos](docs/logbook-photos.md)). Reference manuals a user keeps on the device (**Keep on this device** in the Reference library) also open offline; see [reference library](docs/reference-library.md#keep-on-this-device). Pending entries appear in **Sync center** and sync automatically when connected. Conflicting flights go to administrator review without changing aircraft totals. Access expires seven days after login; pending entries remain saved. Sign in with the original account to sync them. Administrators and maintenance users must be online for access changes, corrections, and resolutions. What happens to a refused entry, a held flight, or a record two people changed at once is in [offline entries and colliding changes](docs/offline.md).

## Fresh-data setup and next steps

There is no legacy operational data to import. Create aircraft with verified opening Hobbs/tach readings, total-time adjustments, cycles, and landings; then create users and permission groups. The PHP source remains a reference for business behavior.

The flight form shows read-only **Starting Hobbs** and **Starting tach** for pilot verification, with separate ending-reading inputs. Starting readings stay paired with the aircraft version when the form opens. Historical flights display their recorded starting readings, not today's counters. The flight log includes all four start/end values. Offline starting readings use the cached record; conflicts still require review.

Aircraft and Flight Programs are available from the sidebar. Aircraft total time uses the selected Hobbs or tach meter plus **Total time adjustment**. Flight Programs have an editable directory with name, address, email, contact name, and website. See [aircraft and program workflows](docs/aircraft-programs.md).

Inspection, component, and inventory management are available from the sidebar. No real aircraft or users were added for this phase. See [maintenance workflows](docs/maintenance-workflows.md) for permissions, calculations, and operating boundaries. While paper logbooks run beside the app, the monthly [paper check](docs/reconciliation.md) lists each aircraft's flights and sign-offs to tick against the paper.

The remaining rollout steps are in the [go-live checklist](docs/go-live-checklist.md):

- moving the operational Convex project to the program's ownership on the Pro plan;
- automated off-site backups;
- a release process with CI and Cloudflare hosting;
- error monitoring;
- testing installation and offline sync on actual pilot and mechanic devices.

## Verification

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

Reference manuals are not stored in the repository; upload them to the app's Reference library. The manual-upload browser test uses a small sample PDF, or the full Cessna 441 manual when a local copy named `16802162-Cessna_441_Maintenance_Manual_D2518-15-13_Mm.pdf` sits in the repository root (it is git-ignored).

The Dev Container includes Chromium runtime libraries after a rebuild. On a Linux host, install Playwright system dependencies with `npx playwright install-deps chromium` using administrator privileges.

Browser tests run against the production build, served with the production security headers (`scripts/serve-dist.mjs`); any Content-Security-Policy violation fails the run. Run `npm run build` after changes. They cover offline reload/sync, conflict review, expiry, mobile navigation, administration, read-only starting meter verification, inspection completion, component service, and inventory movements. The optional live-browser test runs when `.env.local-admin.json` exists and a local Convex backend is running.

With `npm run dev:local` running, test actual authentication and database behavior:

```sh
npm run test:local
```

This refuses non-local URLs. It provisions development-only records and tests login, aircraft creation, idempotent sync, discrepancy resolution, review, and blocked public writes. `npm run format:check` checks formatting of application-owned files.

iOS Add to Home Screen still needs verification on a physical device.

## Deployment

The website runs on Cloudflare (Workers Static Assets, configured in `wrangler.jsonc`, with the security headers in `public/_headers`) and the backend on Convex. Releases go through the manual **Deploy** workflow in GitHub Actions: it deploys the Convex functions, builds the site against that deployment with demo mode off, and publishes it to Cloudflare. First-time setup (Cloudflare account and API token, domain, Convex deploy key, GitHub secrets and the `production` environment), releasing and rollback are in the [release runbook](docs/runbooks/release.md). Never upload `.env.*`, local backend state, or test credentials. No production deployment is performed by the setup scripts.

Without a terminal, set up a new, empty production deployment with the manual **First-time setup** workflow, once, before the first Deploy: see [First-time setup (no terminal)](docs/runbooks/release.md#first-time-setup-no-terminal).

Some settings are set on the deployment, not in the app's **Settings** page: alert email sending (`RESEND_API_KEY`, `RESEND_FROM`), the Web Push keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), `SITE_URL` and `CREDENTIALS_ENCRYPTION_KEY` (see [Connect Convex and create accounts](#connect-convex-and-create-accounts)), and the optional Google and Microsoft sign-in clients (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`; each button appears only when all of its provider's variables are set, see the [accounts runbook](docs/runbooks/accounts.md#google-and-microsoft-sign-in)). Settings → System holds the FAA and Geoapify keys and data backups; Settings → Flight Program holds each program's details, labor rate and Aircraft Spruce account.

Before deploying, take a Convex backup (dashboard > Backups) and save the deployment's environment variables as described in the [backup runbook](docs/runbooks/backup-restore.md).

Production is also copied off-site every night by the **Nightly backup** workflow (encrypted, to Cloudflare R2, plus an optional readable Excel workbook in Dropbox); running it by hand, checking it and restoring are in the [backup runbook](docs/runbooks/backup-restore.md), and `npm run test:backup` tests it without credentials.

**Fresh deployments skip this section.** The production deployment started empty on 2026-11-03 (no data was migrated; the old test deployment was deleted), so the one-off steps below have nothing to do there. They repair data written by earlier versions and stay documented for any deployment that holds such data.

**After every deploy of a deployment with older data, run these one-off steps.** Each is safe to rerun and does nothing once complete:

```bash
npx convex run memberships:backfill
```

It is explained below.

After deploying a version that adds the `memberships` table, populate it once from existing accounts (safe to rerun; it batches itself until every user is processed):

```bash
npx convex run memberships:backfill
```

Until it runs, Flight Program member lists (pilot pickers, group-deletion reviews) show only accounts changed after the deploy. Permissions are unaffected: they still come from each user's group list.

The Docker and dev-container workflow is described below. Compose publishes Vite port 5173 and local Convex ports 3210/3211 on the host loopback interface. Cloud Convex development also works.

## Develop in a dev container

Prerequisites: Docker Desktop (or Docker Engine with Compose) running on your
computer, and an editor that supports the [Dev Container specification](https://containers.dev/),
such as VS Code with the **Dev Containers** extension.

1. Open this repository in your editor.
2. Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Linux/Windows).
3. Run **Dev Containers: Reopen in Container**.

The editor builds the image and opens `/workspace` inside the container. Its terminals
run as the non-root `node` user with Node.js 22, npm, Git, and native build tools.
The configuration follows the [Dev Container specification](https://containers.dev/implementors/json_reference/).

After pulling a changed configuration into an existing environment, run
**Dev Containers: Rebuild Container** to apply it.

## Start with Docker Compose

From the repository root:

```sh
docker compose up -d --build
```

In your editor, run **Dev Containers: Attach to Running Container**, select this
project's `app` container, and open `/workspace`.

To apply this repository's extension configuration, use **Dev Containers: Reopen
in Container** from the repository folder. Attaching directly to a running
container can use separate editor configuration.

For a terminal without an editor:

```sh
docker compose exec app bash
```

The repository is bind-mounted at `/workspace`: edits made on your computer or
inside the container are reflected in both places. Linux dependencies live in a
separate `node_modules` Docker volume, and npm's download cache has its own volume.
Install dependencies inside the container so native packages match Linux.

## Run the application

Use a terminal inside the container:

```sh
npm install
npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
```

Use `npm ci` instead of `npm install` when installing from an existing lockfile.
Open <http://localhost:5173> on your computer. Port 5173 is published only on your
computer's loopback interface. Configure the application's Convex environment
variables in `.env.local` as needed; environment files are ignored by Git.

## Stop or rebuild

```sh
docker compose down
docker compose up -d --build
```

Stopping with `down` preserves the dependency and npm cache volumes. After changing
the Dockerfile while using a dev container, run **Dev Containers: Rebuild Container**.
