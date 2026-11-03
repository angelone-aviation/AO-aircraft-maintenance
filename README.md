# Angel One

Aircraft operations and maintenance tracker built with **React, Vite, TanStack Router, Zustand, and Convex**. It holds the maintenance and status records a 14 CFR Part 91 operator must keep, scoped by **Flight Program** with permission groups. Features include:

- accounts, programs and aircraft permissions;
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
- **Security**: an [in-house review](docs/security/review-2026-11-02.md) was completed on 2026-11-02. Its critical finding (an auth-library flaw that let anyone delete records) and its Medium and Low fixes are merged. Any deployment built before then must be redeployed; see [Deployment](#deployment).
- **Operations**: the runbooks are [accounts](docs/runbooks/accounts.md), [production database access](docs/runbooks/database-access.md), [backup and restore](docs/runbooks/backup-restore.md) (policy decided, automation not yet built) and the [credential encryption key](docs/runbooks/credentials-key.md).
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

`setup:auth` generates signing keys on the selected deployment without printing them, preserves an existing key, and sets `SITE_URL` (default `http://localhost:5173`; override with the `SITE_URL` environment variable). It also creates `CREDENTIALS_ENCRYPTION_KEY` (32 random bytes, base64) if the deployment has none. That key encrypts saved Aircraft Spruce, FAA and Geoapify credentials with AES-GCM; saving those credentials fails until it is set. To set it by hand: `openssl rand -base64 32 | npx convex env set CREDENTIALS_ENCRYPTION_KEY`. Never change or delete it in place on a deployment with saved credentials, or administrators must re-enter them; to rotate it, follow [the credential key runbook](docs/runbooks/credentials-key.md). After deploying, run `npx convex run secretsMigration:reseal` once per deployment (see [Deployment](#deployment)). It encrypts credentials saved before encryption and re-seals older values in the current format. After that, unencrypted values are refused. `setup:admin` prompts for name, email, and a hidden password (15–128 characters, not a common password). It passes the password to the deployment through a temporary `BOOTSTRAP_ADMIN_PASSWORD` environment variable (over stdin, never in process arguments) and removes it afterward. It only works with an empty user database and invokes an internal function, never a public signup endpoint. Keep credentials private.

Maintenance alerts appear under the bell in the header for everyone, including demo mode. To also email a daily digest (13:00 UTC) of new alerts, set a [Resend](https://resend.com) API key and a verified sender on the deployment: `npx convex env set RESEND_API_KEY re_...` and `npx convex env set RESEND_FROM "Angel One <alerts@your-domain>"`. Without both, email is skipped and in-app alerts keep working. Digests link back to `SITE_URL`. Program administrators receive digests by default; anyone can change this under Settings → My account (or My certifications).

In the app, system administrators create Flight Programs, permission groups, and users. Assign each user to program-specific groups to grant access. Select the active Flight Program in the header; aircraft and locations inherit it automatically. See [Flight Program access](docs/flight-program-access.md) for setup, roles, transfers, and offline isolation. Administrators can reset passwords; a reset also ends the user's sessions and clears a sign-in lockout (10 failed attempts per hour). Disabling a user ends their sessions. Public password signup and password-reset registration paths are disabled server-side. Passwords that administrators set need 15–128 characters and must not be common; existing shorter passwords keep working until their next reset. Once their sign-in clients are configured, users can also sign in with a Google or Microsoft account whose verified email matches their account; this never creates an account ([ADR-0009](docs/adr/0009-password-for-everyone-plus-google-and-microsoft.md)). See the [accounts runbook](docs/runbooks/accounts.md).

The local smoke test creates a development-only administrator if needed and saves its credentials to ignored `.env.local-admin.json`. If that file exists in this workspace, use that account for the existing local database instead of rerunning the empty-database bootstrap. Test aircraft are clearly named `TEST-*`. Create a separate Convex project for operational use.

## Offline and installation

```sh
npm run build
npm run preview
```

Open the preview URL online, sign in, and allow the app to cache before testing offline. The service worker is enabled in production builds, not the Vite development server. On iOS use Safari → Share → **Add to Home Screen**; on Android/desktop use the browser's install action. Production requires HTTPS. Native app-store packages are outside this PWA delivery.

Only flight and discrepancy additions are available offline. Reference manuals a user keeps on the device (**Keep on this device** in the Reference library) also open offline; see [reference library](docs/reference-library.md#keep-on-this-device). Pending entries appear in **Sync center** and sync automatically when connected. Conflicting flights go to administrator review without changing aircraft totals. Access expires seven days after login; pending entries remain saved. Sign in with the original account to sync them. Administrators and maintenance users must be online for access changes, corrections, and resolutions.

## Fresh-data setup and next steps

There is no legacy operational data to import. Create aircraft with verified opening Hobbs/tach readings, total-time adjustments, cycles, and landings; then create users and permission groups. The PHP source remains a reference for business behavior.

The flight form shows read-only **Starting Hobbs** and **Starting tach** for pilot verification, with separate ending-reading inputs. Starting readings stay paired with the aircraft version when the form opens. Historical flights display their recorded starting readings, not today's counters. The flight log includes all four start/end values. Offline starting readings use the cached record; conflicts still require review.

Aircraft and Flight Programs are available from the sidebar. Aircraft total time uses the selected Hobbs or tach meter plus **Total time adjustment**. Flight Programs have an editable directory with name, address, email, contact name, and website. See [aircraft and program workflows](docs/aircraft-programs.md).

Inspection, component, and inventory management are available from the sidebar. No real aircraft or users were added for this phase. See [maintenance workflows](docs/maintenance-workflows.md) for permissions, calculations, and operating boundaries.

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

Browser tests run against the production build; run `npm run build` after changes. They cover offline reload/sync, conflict review, expiry, mobile navigation, administration, read-only starting meter verification, inspection completion, component service, and inventory movements. The optional live-browser test runs when `.env.local-admin.json` exists and a local Convex backend is running.

With `npm run dev:local` running, test actual authentication and database behavior:

```sh
npm run test:local
```

This refuses non-local URLs. It provisions development-only records and tests login, aircraft creation, idempotent sync, discrepancy resolution, review, and blocked public writes. `npm run format:check` checks formatting of application-owned files.

iOS Add to Home Screen still needs verification on a physical device.

## Deployment

Set `VITE_CONVEX_URL` to your production deployment, configure Convex Auth signing keys and `SITE_URL` there, deploy Convex functions, and publish `dist/` on an HTTPS host with SPA fallback to `index.html`. Keep demo mode off (`VITE_DEMO_MODE=false`) and never upload `.env.*`, local backend state, or test credentials. No production deployment is performed by the setup scripts.

Some settings are set on the deployment, not in the app's **Settings** page: alert email sending (`RESEND_API_KEY`, `RESEND_FROM`), `SITE_URL` and `CREDENTIALS_ENCRYPTION_KEY` (see [Connect Convex and create accounts](#connect-convex-and-create-accounts)), and the optional Google and Microsoft sign-in clients (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER`; each button appears only when all of its provider's variables are set, see the [accounts runbook](docs/runbooks/accounts.md#google-and-microsoft-sign-in)). Settings → System holds the FAA and Geoapify keys and data backups; Settings → Flight Program holds each program's details, labor rate and Aircraft Spruce account.

Before deploying, take a Convex backup (dashboard > Backups) and save the deployment's environment variables as described in the [backup runbook](docs/runbooks/backup-restore.md).

**After every deploy, run these one-off steps.** Each is safe to rerun and does nothing once complete:

```bash
npx convex run memberships:backfill
npx convex run management:backfillOilMarker
npx convex run counterEvents:recordChanges
npx convex run secretsMigration:reseal   # repeat until it reports complete: true
```

**Once, after the deploy that adds the permission-group check, run this read-only CHECK** (it changes nothing; run it after `memberships:backfill`):

```bash
npx convex run groupAudit:findWidenedGroups   # READ-ONLY; repeat with '{"cursor":"<continueCursor>"}' until isDone: true
```

Each is explained below.

After deploying a version that adds the `memberships` table, populate it once from existing accounts (safe to rerun; it batches itself until every user is processed):

```bash
npx convex run memberships:backfill
```

Until it runs, Flight Program member lists (pilot pickers, group-deletion reviews) show only accounts changed after the deploy. Permissions are unaffected: they still come from each user's group list.

After deploying the version that restricts flight-line oil usage to stock marked **Engine oil**, mark the stock already used that way (safe to rerun; it batches itself through the change log):

```bash
npx convex run management:backfillOilMarker
```

It marks every stock item that has a `stock.oil_used` change-log entry and appends one `stock.oil_marker_backfill` entry per item it changes; existing entries are not modified. Until it runs, pilots cannot draw down oil from items that are not yet marked. Administrators can mark other oil items on the inventory item.

After deploying the version in which a counter change overrides only the counters an administrator changed (issue #35), record that for counter changes saved earlier and repair the totals they hid (safe to rerun; it skips aircraft already recorded):

```bash
npx convex run counterEvents:recordChanges
```

Earlier versions replayed each counter change as a snapshot of every counter, so a correction, an accepted backdated flight or a rejection before it never reached the totals. For each such counter change it reads the aircraft's values from the `aircraft.updated` change-log entry that saved it, then rebuilds the totals from the flight log. It appends `aircraft.counters_recalculated` (or `aircraft.counter_changes_recorded` when the totals were already right) and one `flight.resequenced` entry per flight whose starting readings moved; existing entries are not modified. Changed totals raise the aircraft version, so pending entries started against the old totals are held for review. Aircraft it cannot rebuild are left untouched and listed under `needsReview` with the reason; review their counter history with a Flight Program administrator. Until it runs, the first flight review on each aircraft works this out from the flight log instead; that is exact unless an earlier review's change had already been lost.

`groupAudit:findWidenedGroups` is a read-only check, not a migration. Until the fix for #34, editing a permission group whose selected aircraft had all moved to another Flight Program saved it with no aircraft, which opens it to every aircraft in the program. The check reads each group's `group.saved` change-log entries and lists, under `widened`, groups an edit emptied that way and, under `review`, groups covering all aircraft whose log cannot show that this was chosen. It never changes a group: a system administrator reviews each in Administration → Permission groups, where the same groups are listed, and saves an explicit aircraft choice. Follow the [accounts runbook](docs/runbooks/accounts.md#permission-groups-opened-to-all-aircraft-before-the-34-fix).

`secretsMigration:reseal` re-encrypts saved Aircraft Spruce, FAA and Geoapify credentials in the current format, which ties each value to its table, Flight Program and field. Until it reports `complete: true`, credentials saved before encryption still work. If it reports remaining rows, run it again. Key rotation is in the [credential key runbook](docs/runbooks/credentials-key.md).

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
