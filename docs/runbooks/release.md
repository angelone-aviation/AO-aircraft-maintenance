# Release, rollback and website hosting

The website is a static build served by **Cloudflare Workers Static Assets** (no Worker script); the backend, database and files stay on **Convex**. Releases are started by hand from GitHub Actions; nothing deploys automatically yet. Background and sources: [Cloudflare hosting, CI and release research](../research/cloudflare-pages-ci-release.md). Only the technical owner holds the production deploy key ([ADR-0010](../adr/0010-one-convex-administrator.md)).

## What runs where

| Piece | File | When | Secrets |
|---|---|---|---|
| CI | `.github/workflows/ci.yml` | Every pull request and every push to `main` | None |
| Deploy | `.github/workflows/deploy.yml` | By hand, from `main` only | `production` environment |
| Dependency updates | `.github/dependabot.yml` | Weekly, grouped minor/patch pull requests | None |
| Website hosting | `wrangler.jsonc`, `public/_headers`, `public/.assetsignore` | On deploy | — |

**CI** runs `npm ci`, `npm run check` and the Playwright suite. The browser tests serve the production build with the production headers (`scripts/serve-dist.mjs` applies `public/_headers` the way Cloudflare does) and fail on any Content-Security-Policy violation. On failure, the run keeps the Playwright report and traces as the `playwright-report` artifact for 14 days.

**Deploy** refuses to run unless you confirm a backup, then:

1. runs `npm run check`;
2. checks `CONVEX_DEPLOY_KEY` is a production key;
3. runs `npx convex deploy`, which builds the site with the production `VITE_CONVEX_URL` (demo mode off) and then pushes the functions and schema. It stops before the push if the build fails or the Convex URL is not allowed by the Content-Security-Policy (`scripts/check-csp-origin.mjs`);
4. checks the build points at that Convex URL;
5. publishes `dist/` with `npx wrangler@4.151.3 deploy`, tagging the Cloudflare version with the commit;
6. if `PRODUCTION_URL` is set, checks the live site answers with the security headers.

The backend goes live a few seconds before the website, so Convex functions must keep working for the previous website version (and for installed apps that have not reloaded yet).

## First-time setup

Record each owner in [the accounts runbook](accounts.md) as you go.

### Cloudflare

1. Use the organization's Cloudflare account, not a personal one, with two-factor sign-in on. Copy its **Account ID** (Workers & Pages overview, right-hand column).
2. Create an API token from the **Edit Cloudflare Workers** template. Prefer an account-owned token (Manage Account → Account API Tokens) so it does not depend on one person's login. Limit **Account Resources** to this account and **Zone Resources** to the app's zone. Give it an expiry date and note the renewal date in `accounts.md`.
3. **Domain and DNS.** The app's DNS zone must be on Cloudflare (add the site and switch the nameservers at the registrar). Pick the hostname, for example `app.example.org`, and make sure no DNS record exists for it yet. In `wrangler.jsonc`, uncomment `routes` with that hostname (`"custom_domain": true`). Cloudflare creates the DNS record and certificate on the next deploy. Once the site works there, set `"workers_dev": false` so the `*.workers.dev` address stops serving it.
4. HSTS: the site sends `Strict-Transport-Security: max-age=63072000; includeSubDomains`. If the app is on the bare domain, every subdomain of it must then be HTTPS. Adding `preload` is a separate decision for the domain owner and is hard to undo.

### Convex production deployment

1. In the Convex dashboard, open the project's **Production** deployment → Settings → **Generate Production Deploy Key**. It starts with `prod:`.
2. Configure the deployment once, from the technical owner's computer, with the key in the shell only (never in a file or the shell history):

   ```sh
   read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY
   SITE_URL=https://app.example.org npm run setup:auth
   npx convex env set RESEND_API_KEY re_...            # optional: alert emails
   npx convex env set RESEND_FROM "Angel One <alerts@your-domain>"
   unset CONVEX_DEPLOY_KEY
   ```

   `SITE_URL` must be the website's address exactly (no trailing slash): sign-in redirects and email links use it. Create the first administrator with `npm run setup:admin` the same way, only on an empty database. See [Connect Convex and create accounts](../../README.md#connect-convex-and-create-accounts).
3. If you give the Convex deployment a custom domain, add it to `connect-src` (and `img-src`) in `public/_headers` first; the deploy refuses a Convex URL the policy does not allow.

### GitHub

1. Settings → Environments → **New environment** `production`:
   - **Deployment branches and tags**: selected branches, `main` only.
   - **Required reviewers**: the technical owner. (On GitHub Free this rule is only available for public repositories; then keep write access to the repository limited.)
   - **Environment secrets**: `CONVEX_DEPLOY_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Do not add them as repository secrets.
   - **Environment variable** `PRODUCTION_URL` = `https://app.example.org` (turns on the smoke check).
2. Protect `main`: require a pull request and the **Check and browser tests** status check.
3. Settings → Code security: turn on Dependabot alerts and security updates. Version updates come from `.github/dependabot.yml`.

## Release

Before you start:

- [ ] CI is green on the `main` commit you are releasing.
- [ ] You read what changed. Schema changes must accept the documents already stored (widen, migrate, then tighten in a later release); otherwise the Convex push fails.
- [ ] You took a Convex backup (dashboard → Backups → **Backup now**, including file storage) and saved the environment variables ([backup and restore](backup-restore.md)).

Then: GitHub → Actions → **Deploy** → **Run workflow** → branch `main`, tick the backup box → **Run workflow**. Approve it if reviewers are required. The run summary shows the commit, the Convex URL and the Cloudflare version tag.

### After every deploy

Run the one-off commands from the README [Deployment](../../README.md#deployment) section against production. Each is safe to rerun and does nothing once complete:

```sh
read -rs CONVEX_DEPLOY_KEY && export CONVEX_DEPLOY_KEY
npx convex run memberships:backfill
npx convex run management:backfillOilMarker
npx convex run counterEvents:recordChanges
npx convex run secretsMigration:reseal   # repeat until it reports complete: true
unset CONVEX_DEPLOY_KEY
```

Once, after the deploy that adds the permission-group check, also run the read-only `npx convex run groupAudit:findWidenedGroups` (repeat with `'{"cursor":"<continueCursor>"}'` until `isDone: true`) and follow the [accounts runbook](accounts.md#permission-groups-opened-to-all-aircraft-before-the-34-fix). Check the README for commands added since this list was written.

Then check the live site:

- [ ] Sign in, open the aircraft list, a work order and an uploaded attachment.
- [ ] Reload a deep link such as `/work-orders`.
- [ ] An installed app shows the update prompt and works after **Reload**.
- [ ] Print a purchase order preview and the AD compliance report in Safari (iPad or Mac) and Chrome. If the PDF tab stays blank and the browser console reports `object-src`, change `object-src 'none'` to `object-src 'self' blob:` in `public/_headers`.
- [ ] The browser console shows no "Content Security Policy" errors.

## Rollback

### Website: instant

Cloudflare keeps the last 100 versions. Dashboard → Workers & Pages → **angel-one** → **Deployments** → choose the version (its tag is the commit) → **Rollback**. Or, with the API token in the shell:

```sh
npx wrangler@4.151.3 deployments list
npx wrangler@4.151.3 rollback <version-id> --message "Reason"
```

It takes effect at once. Installed apps see it as an update: the update prompt appears and **Reload** loads the older version. A rollback changes only the website, never Convex, so the older website must still work with the current functions (it normally does, because functions stay compatible with older clients). Run the Deploy workflow again from `main` to go forward.

Rare edge case: a browser that asked for a script of the old version while it was missing (after a deploy, before the rollback) may have cached the app shell under that script's address and show a broken screen after the rollback. Clearing the site's data in that browser fixes it.

### Backend: no rollback, fix forward

Convex has no rollback command. To undo a backend change, revert the commit on `main` (pull request, CI) and run **Deploy** again. If the reverted schema no longer matches documents the newer code wrote, the push fails; write a forward fix instead. If data was damaged, restore from a backup as described in [backup and restore](backup-restore.md#real-restore-production). A restore replaces everything written since the backup and must be recorded in the change log by hand.

Roll the website back first when the problem is in the screens; fix the backend forward when the problem is in the data or functions.

## Security headers

`public/_headers` sets the headers for every response (Vite copies it into `dist/`; wrangler reads it and does not publish it, nor files listed in `public/.assetsignore`).

| Header | Value and reason |
|---|---|
| Content-Security-Policy | `default-src 'self'`. `script-src 'self' 'wasm-unsafe-eval'`: only the app's own files; WebAssembly for the PDF.js image decoders and PostScript functions. No inline scripts and no `eval`. `style-src 'self' 'unsafe-inline'`: inline styles in the print labels. `connect-src` adds `blob:` (offline manuals and downloads) and the Convex hosts (`https://*.convex.cloud`, `wss://*.convex.cloud`, `https://*.convex.site`); Geoapify, FAA and Aircraft Spruce calls run on Convex, not in the browser. `img-src` adds `data:`, `blob:` and Convex file storage. `worker-src 'self' blob:` for the service worker and the PDF.js worker. `frame-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. |
| Strict-Transport-Security | Two years, subdomains included (see above about `preload`). |
| X-Content-Type-Options | `nosniff`. |
| Referrer-Policy | `strict-origin-when-cross-origin`. |
| Permissions-Policy | Camera for the app itself (QR scanner); microphone, location, payment and other device access off. |
| Cross-Origin-Opener-Policy | `same-origin`. |
| Cache-Control | `no-cache` for `/`, `/index.html`, `/sw.js` and `/manifest.webmanifest`, so releases and rollbacks reach installed apps; one year, `immutable`, for the content-hashed files in `/assets/`. Everything else gets Cloudflare's default (revalidate every time). |

Two code changes keep the app inside this policy: PDF.js 6 no longer uses `eval` (its `isEvalSupported` option was removed), and the browser build loads zod in "jitless" mode (`src/cspSafeZod.ts`, wired in `vite.config.ts`) so it does not probe `new Function`.

To change the policy, edit `public/_headers`, update `tests/e2e/security-headers.spec.ts` if a rule there changes, and run `npm run test:e2e`. To look at the build with the production headers locally:

```sh
npm run build
node scripts/serve-dist.mjs            # http://127.0.0.1:4173, Cloudflare-like
npx wrangler@4.151.3 dev               # Cloudflare's own runtime, on this computer
```

`npx wrangler@4.151.3 deploy --dry-run` checks `wrangler.jsonc` without credentials.

## Not set up yet

- **Previews per change** ([ADR-0007](../adr/0007-convex-pro-single-seat.md)): Convex preview deployments plus Cloudflare Worker Previews. `preview_urls` is off in `wrangler.jsonc` until then. Previews are public by default.
- **Automatic deploys** from `main`: the Deploy workflow is manual on purpose.
- **Wrangler version**: the workflows run a pinned `wrangler` through `npx`, which Dependabot does not update. Raise `WRANGLER_VERSION` in `deploy.yml` and the version in this runbook together.
