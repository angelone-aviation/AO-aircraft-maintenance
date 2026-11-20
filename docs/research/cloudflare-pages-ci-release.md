# Cloudflare hosting, GitHub Actions CI and Convex release process

_Research as of 2026-11-01. Primary sources only; every claim links its page._

## Summary

Cloudflare now tells new projects to use **Workers Static Assets**, not Pages ("If you are starting a new project, use Workers instead of Pages. Pages continues to work, but new features and optimizations are focused on Workers"). For this plain Vite SPA that means a `wrangler.jsonc` with `assets.directory = "./dist"` and `not_found_handling = "single-page-application"`, a `_headers` file in `public/` for CSP and the other security headers, a custom domain on a Cloudflare-managed zone, **Worker Previews** for per-branch staging, and `wrangler rollback` (last 100 versions) for instant front-end rollback. CI stays in GitHub Actions: a `ci.yml` running `npm ci`, `npm run check` and Playwright, and a `deploy.yml` on `main` that runs `npx convex deploy --cmd 'npm run build'` (production deploy key injects `VITE_CONVEX_URL`) and then `cloudflare/wrangler-action@v4` to publish `dist/`. Convex has no "revert" command: a backend rollback is a redeploy of the previous commit, and schema changes must stay compatible with existing data or the push fails. Static asset requests are free and unlimited; the Workers Free plan and GitHub Free (~2,000 Linux minutes/month) cover this project.

## Facts

| Topic               | Finding                                                                                                                                                  | Source                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Pages vs Workers    | "Use Workers instead of Pages… new features and optimizations are focused on Workers"                                                                    | https://developers.cloudflare.com/workers/best-practices/workers-best-practices/                                                    |
| Pages landing       | "Start new projects with Workers."                                                                                                                       | https://developers.cloudflare.com/pages/                                                                                            |
| Migration guide     | Pages → Workers steps; `_headers`/`_redirects` supported natively                                                                                        | https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/                                        |
| SPA fallback        | `not_found_handling = "single-page-application"` serves `/index.html` with 200                                                                           | https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/                                            |
| `_headers`          | In the asset dir (`public/`); 100 rules, 2,000 chars/line; not applied to Worker-generated responses                                                     | https://developers.cloudflare.com/workers/static-assets/headers/                                                                    |
| Custom domain       | `[[routes]] pattern = "app.example.com" custom_domain = true`; zone must be on Cloudflare                                                                | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/                                                     |
| Previews            | Isolated per-branch env under the same Worker; stable `<preview>-<worker>.<sub>.workers.dev`; public by default; 100 Previews/Worker on Free             | https://developers.cloudflare.com/workers/previews/                                                                                 |
| Rollback            | `wrangler rollback`; "immediately create a new deployment"; only the 100 most recent versions                                                            | https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/                                         |
| Pages rollback      | Dashboard only; production deployments only; "instantly revert"                                                                                          | https://developers.cloudflare.com/pages/configuration/rollbacks/                                                                    |
| Static asset cost   | "Requests to static assets are free and unlimited"                                                                                                       | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/                                                    |
| Workers Free limits | 100k Worker requests/day; 20,000 files, 25 MiB/file per version                                                                                          | https://developers.cloudflare.com/workers/platform/limits/                                                                          |
| wrangler-action     | `cloudflare/wrangler-action@v4`, `apiToken`, `accountId`, `command`                                                                                      | https://github.com/cloudflare/wrangler-action                                                                                       |
| API token           | "Edit Cloudflare Workers" template; secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                                                              | https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/                                                       |
| Convex deploy       | `npx convex deploy --cmd 'npm run build'` sets `VITE_CONVEX_URL` to prod, then pushes `convex/`                                                          | https://docs.convex.dev/production/hosting/custom                                                                                   |
| Deploy key          | "Generate Production Deploy Key" with `deployment:deploy`; store as `CONVEX_DEPLOY_KEY`                                                                  | https://docs.convex.dev/production/hosting/vercel                                                                                   |
| Preview deploys     | Preview Deploy Key; `--preview-create <name>` recreates with fresh data; expire 5 days (Free/Starter) / 14 days (Pro+); beta                             | https://docs.convex.dev/production/hosting/preview-deployments                                                                      |
| Staging             | "For a more permanent staging environment, use a separate Convex project" + its own `CONVEX_DEPLOY_KEY`; previews are a Pro feature                      | https://docs.convex.dev/production                                                                                                  |
| Schema on deploy    | "The first push after a schema is added or modified will validate that all existing documents match"; failure blocks the push                            | https://docs.convex.dev/database/schemas                                                                                            |
| Backups             | Restore "wipes your existing data"; backups exclude code/env vars; Free keeps 2 backups                                                                  | https://docs.convex.dev/database/backup-restore                                                                                     |
| Hostnames           | HTTP actions at `https://<deployment>.convex.site`, "not `.convex.cloud`"                                                                                | https://docs.convex.dev/functions/http-actions                                                                                      |
| Auth callback       | `https://<deployment>.convex.site/api/auth/callback/<provider>`; `SITE_URL` per environment                                                              | https://labs.convex.dev/auth/config/oauth                                                                                           |
| connect-src         | Governs `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`                                                                              | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src                             |
| worker-src          | Governs `ServiceWorker`; falls back child-src → script-src → default-src                                                                                 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src                              |
| Other headers       | HSTS `max-age=63072000; includeSubDomains; preload`, `nosniff`, `strict-origin-when-cross-origin`, Permissions-Policy, prefer `frame-ancestors` over XFO | https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html                                                        |
| vite-plugin-pwa     | `prompt` is default; `autoUpdate` forces `skipWaiting`/`clientsClaim`, can lose form data                                                                | https://vite-pwa-org.netlify.app/guide/auto-update.html                                                                             |
| PWA caching         | Never `immutable`/long cache on `/`, `/sw.js`, `/index.html`, `/manifest.webmanifest`                                                                    | https://vite-pwa-org.netlify.app/deployment/                                                                                        |
| Playwright CI       | Official workflow; `install --with-deps`; report upload `if: ${{ !cancelled() }}`; browser caching **not** recommended                                   | https://playwright.dev/docs/ci                                                                                                      |
| Concurrency         | `group: ${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true`                                                                            | https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs |
| Actions minutes     | GitHub Free private repos: $12 included compute/month ≈ 2,000 Linux 2-core min; public repos free                                                        | https://docs.github.com/en/billing/concepts/product-billing/github-actions                                                          |
| Dependabot          | `.github/dependabot.yml`, `version: 2`, npm + github-actions ecosystems                                                                                  | https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/configuring-dependabot-version-updates               |

## 1. Pages vs Workers Static Assets

Pick **Workers Static Assets**. Cloudflare's best-practices and Pages landing pages both say to start new projects on Workers. The migration guide confirms `_headers`, previews, rollbacks and custom domains all exist on Workers; the one gap is "branch deploy controls" (workaround available). No Worker script is needed for a static SPA.

```jsonc
// wrangler.jsonc
{
  "name": "angel-one",
  "compatibility_date": "2026-11-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application",
  },
  "routes": [{ "pattern": "app.example.com", "custom_domain": true }],
  "preview_urls": true,
  "previews": {},
}
```

## 2. Hosting mechanics (Workers)

- **SPA fallback**: `not_found_handling: "single-page-application"` returns `/index.html` with `200` for any unmatched path (Pages did this implicitly when no `404.html` existed).
- **Headers**: `public/_headers` (Vite copies it into `dist/`). Rules apply to static responses only; up to 100 rules.
- **Custom domain**: `routes[].custom_domain = true`; Cloudflare creates DNS record and certificate. Zone must be on Cloudflare.
- **Preview per branch**: `npx wrangler preview --name <branch>` creates/updates a Preview with a stable URL plus an immutable per-deployment URL. Previews "do not inherit production settings" (configure in the `previews` block) and are **public by default**; gate with Cloudflare Access. Limits: 100 Previews per Worker, 100 deployments per Preview (oldest evicted).
- **Production**: `npx wrangler deploy` creates a version and deploys it "to 100% of traffic in a single step".
- **Rollback**: `npx wrangler rollback [version-id]` or dashboard → Deployments → Rollback. Immediate; last 100 versions. A version "captures the complete state of your Worker" including static assets, so rollback is a whole-site switch to one version (Cloudflare does not say "atomic"). Pages does not document deployment retention.

## 3. Security headers for a Convex-backed PWA

Browser → `wss://<deployment>.convex.cloud` (ConvexReactClient) and `https://<deployment>.convex.site` (Convex Auth HTTP routes); file-storage URLs are also on `.convex.cloud`. Fonts are self-hosted. The build emits only same-origin script files (the app's module and the early theme script `public/theme-init.js`) and no inline `<script>`, so `script-src 'self'` works; React inline `style={{…}}` attributes need `style-src 'unsafe-inline'`; PDF.js WASM needs `'wasm-unsafe-eval'`; blob URLs serve downloads/print previews.

```txt
# public/_headers
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.convex.cloud; font-src 'self'; connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), geolocation=(), microphone=(), payment=()
  Cross-Origin-Opener-Policy: same-origin
/sw.js
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/assets/*
  Cache-Control: public, max-age=31556952, immutable
```

`camera=(self)` for QR scanning (jsQR) — confirm. Pin `connect-src` to exact deployment hostnames once known. Resend runs in Convex actions, so it never appears here. `frame-ancestors` is ignored in `<meta>`, which is why `_headers` matters.

**Service worker interaction.** `registerType: "prompt"` (repo setting, plugin default): a new `sw.js` installs in the background and the user chooses when to reload; `autoUpdate` forces `skipWaiting`/`clientsClaim` and can drop unsaved form input. `navigateFallback: "/index.html"` mirrors Cloudflare's SPA fallback offline. Cloudflare's default `Cache-Control: public, max-age=0, must-revalidate` + `ETag` already meets vite-pwa's "no long caching for `/sw.js`, `/index.html`" rule; the `no-cache` lines make it explicit, hashed `assets/*` can be `immutable`. On **rollback** the older `sw.js` has a different precache manifest, so browsers treat it as a new SW and prompt — a rollback is just another update to clients; `cleanupOutdatedCaches` drops the newer cache. Clients that ignore the prompt cannot be force-reloaded.

## 4. GitHub Actions

Secrets: `CONVEX_DEPLOY_KEY` (Production Deploy Key, `deployment:deploy`), `CLOUDFLARE_API_TOKEN` ("Edit Cloudflare Workers" template, scoped to one account), `CLOUDFLARE_ACCOUNT_ID`.

```yaml
# .github/workflows/ci.yml
name: CI
on: { pull_request: {}, push: { branches: [main] } }
concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run check
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with: { name: playwright-report, path: playwright-report/, retention-days: 14 }
```

Playwright does not recommend caching browsers ("the amount of time it takes to restore the cache is comparable to the time it takes to download the binaries"); skip it. `test:e2e` builds and serves the production bundle with `VITE_ALLOW_DEMO=true`, so CI needs no Convex credentials.

```yaml
# .github/workflows/deploy.yml
name: Deploy
on: { push: { branches: [main] } }
concurrency: { group: deploy-production, cancel-in-progress: false }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx convex deploy --cmd 'npm run build'
        env: { CONVEX_DEPLOY_KEY: ${{ secrets.CONVEX_DEPLOY_KEY }} }
      - uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

Order: `convex deploy` builds (`VITE_CONVEX_URL` → prod), pushes functions + schema, then Cloudflare publishes `dist/`. The backend is live seconds before the new UI, so functions must stay backward compatible (Convex requires this anyway for old clients).

**Staging.** Convex documents two options: (a) **preview deployments** (Pro, beta): a Preview Deploy Key as `CONVEX_DEPLOY_KEY` on PR runs, `npx convex deploy --cmd 'npm run build' --preview-create "$GITHUB_HEAD_REF"` (fresh data each run, deleted after 5/14 days), then `npx wrangler preview --name "$GITHUB_HEAD_REF"`; (b) a **separate Convex project** for a long-lived staging with its own deploy key, deployed from a `staging` branch to a Wrangler `[env.staging]` Worker or a second Worker. In both cases the staging front end points at staging Convex simply because `VITE_CONVEX_URL` is baked in at build time by the key used for that build. Each Convex deployment needs its own `SITE_URL`, `JWT_PRIVATE_KEY`/`JWKS`, `CREDENTIALS_ENCRYPTION_KEY` and OAuth callback (`https://<deployment>.convex.site/api/auth/callback/<provider>`).

## 5. Rollback end to end

1. **Front end**: `npx wrangler rollback` (or dashboard). Immediate; clients get a SW update prompt.
2. **Convex functions**: no revert command exists. Check out the previous commit and run `npx convex deploy` (or re-run the deploy workflow from that SHA). Functions are replaced immediately; scheduled functions run the newly deployed code.
3. **Schema**: not reverted automatically. A redeploy whose schema no longer matches documents written by the newer code **fails validation**. Convex's guidance: widen → migrate → tighten, update writers first, keep changes backward compatible; or use `.staged()` validators. Practically: never ship a tightening schema change in the same release as the code that depends on it.
4. **Data**: Backup/Restore is the only data rollback and it "wipes your existing data"; take a backup before risky deploys (Free keeps two).
5. **Order**: roll Convex back first if the old UI cannot talk to new functions; otherwise roll the UI back first.

## 6. Dependabot

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
    groups: { npm-minor-patch: { update-types: [minor, patch] } }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

Renovate is a third-party app and not covered by the allowed sources; Dependabot is built in and sufficient here.

## 7. Cost

- Cloudflare Workers Free: static asset requests free and unlimited, no bandwidth metering; 100k Worker-script requests/day (unused here); 20k files, 25 MiB each; 100 Previews/Worker; Workers Builds 3,000 min/month ([limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)). Pages Free: 500 builds/month, 1 concurrent ([limits](https://developers.cloudflare.com/pages/platform/limits/)).
- GitHub Free, private repo: $12/month included compute ≈ 2,000 Linux 2-core minutes, 500 MB artifacts. A CI run here is roughly 8–12 min, so ~150 runs/month fit. Environment protection rules (required reviewers) need Pro/Team ([docs](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
- Convex: preview deployments require Pro; backups beyond two per deployment require Pro.

## Decision inputs

- **Pages vs Workers**: Workers recommended by Cloudflare; Pages only if the team wants dashboard-only git integration with zero wrangler config.
- **Staging**: Convex preview deployments (Pro, ephemeral, fresh data, pairs with Worker Previews per PR) vs a separate long-lived Convex staging project (Free-compatible, needs its own secrets/OAuth app, deployed from a `staging` branch).
- **Deploy runner**: GitHub Actions (this doc) vs Workers Builds (Cloudflare-hosted, free minutes, but Convex deploy would then also run inside Cloudflare's build).
- **Who owns the Cloudflare account and zone**: custom domains require the DNS zone on Cloudflare; the API token should be an account-scoped token owned by the organisation, not a personal login.
- **CSP strictness**: `style-src 'unsafe-inline'` is needed today for React inline styles; `'wasm-unsafe-eval'` for PDF.js. Tightening either means code changes. Also confirm whether Geoapify/FAA calls are browser-side (would widen `connect-src`) or Convex-side only.
- **Preview URL exposure**: Previews are public by default; decide whether to put Cloudflare Access in front.

## Open questions

- Does the demo/E2E build need a different CSP (e.g. `VITE_ALLOW_DEMO`), and should CI assert the headers?
- Is any part of the app fetching third-party APIs from the browser (Geoapify address lookup, FAA DRS)? If so, `connect-src` must list them.
- Does the team want `autoUpdate` for faster rollback propagation despite form-data loss, or keep `prompt`?
- Which Convex plan will the project be on (gates preview deployments and backups)?
- Should the deploy workflow gate on the CI workflow (`workflow_run`) or rely on branch protection requiring CI before merge?
