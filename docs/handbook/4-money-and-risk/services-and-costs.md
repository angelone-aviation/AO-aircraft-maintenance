# Services and costs

Every outside service Angel One uses: what it does, which plan, what it costs, what breaks without it, and who owns the account.

- **Prices are as of November 2026**, from each vendor's own pricing page (linked), in US dollars, before tax.
- **Who owns each account** is recorded in the [accounts runbook](../../runbooks/accounts.md). Most rows there are still blank; filling them in is on the [go-live checklist](../../go-live-checklist.md).
- Numbers marked **estimate** are worked out here, not measured or billed.

## At a glance

| Service | Plan | Cost today | Needed? |
| --- | --- | --- | --- |
| Convex | Professional, 1 seat | $25 a month | Yes: the whole backend |
| Cloudflare Workers (website) | Free | $0 | Yes |
| Cloudflare R2 (backups) | Free tier | $0 | Yes, for off-site backups |
| Cloudflare DNS | Zone on Cloudflare | $0 (no paid plan in use) | Yes |
| GitHub (code, CI, Deploy, backups) | Free, public repository | $0 | Yes |
| Resend (email) | Free | $0 | For alert emails |
| Web Push (Google, Apple, Mozilla) | No account | $0 | For device alerts |
| Better Stack (uptime, backup heartbeat) | Free | $0 | Recommended |
| Domain registrar (`angeloneaviation.org`) | Not known | Not known; about $11 a year (estimate) | Yes |
| FAA DRS API key | Key from the FAA | Not known | For AD monitoring |
| Geoapify (address lookup) | Free | $0 | Optional feature |
| Aircraft Spruce | The program's customer account | Not known | Optional feature |
| Google Workspace | Organisation email | Not part of the app's cost | No (Google sign-in is off) |
| Dropbox | Optional readable copy | $0 if on Basic | No |
| Sentry | Not used | $0 | No |

## Totals

| Size | Monthly | Yearly | Notes |
| --- | --- | --- | --- |
| **Today** (production holds no real records yet) | **$25** | **about $311** | Convex $25 × 12 = $300, plus the domain, about $11 (estimate). Everything else is on a free plan |
| **Load-test size** (6 aircraft, 20 years) | **$25 to about $40** (estimate) | **about $311 to $490** (estimate) | Records alone stay inside Convex Pro's included amounts. The upper figure allows for heavy use and a few GB of uploaded files; see below |

Not included: Google Workspace (the organisation's email, paid or not whatever the app does), parts bought through Aircraft Spruce, and anyone's time.

### How the load-test figure is estimated

| Item | Basis | Result |
| --- | --- | --- |
| Database storage | Full export of 20 years of the model: 68 MB ([size test](../../qa/bug-hunt-2026-11-10/README.md#size-test)) | Far inside Convex Pro's 50 GB: $0 extra |
| Database bandwidth | A workspace load reads 4.5–8.8 MiB at 20 years ([capacity](../2-how-it-works/capacity-and-limits.md)). 17 people opening it about 4 times a day: about 14 GB a month. Live updates re-read it on changes, so allow 2–3 times that | **Estimate:** 15–45 GB a month, inside the 50 GB included. Each GB over costs $0.20 |
| Data egress | The nightly export: 68 MB × 30 nights = about 2 GB a month, plus uploaded files × 30 | Inside 50 GB while files stay under about 1.5 GB ([ADR-0007](../../adr/0007-convex-pro-single-seat.md)). Each GB over costs $0.12 |
| R2 storage | 90 daily copies (about 6 GB) plus monthly copies kept forever (240 by year 20, about 8 GB) | **Estimate:** about 14 GB for records: about $0.06 a month over the 10 GB free tier. Uploaded files are copied into every export, so 2 GB of files adds about 180 GB of daily copies: about $2.50 a month |
| Resend | A daily digest per opted-in member plus at most 60 urgent emails a day | Inside 100 a day while fewer than 40 people take the digest ([monitoring runbook](../../runbooks/monitoring.md#alerts-by-email-and-on-devices)) |
| GitHub Actions | Free while the repository is public | $0 |

Not known: how many files the program will upload, and Convex's cloud bandwidth for this app. Check Convex's usage page after the first months of real records.

## Each service

### Convex (backend)

| | |
| --- | --- |
| Does | Database, file storage, every server function, sign-in, scheduled jobs |
| Plan | **Professional, one developer seat** ([ADR-0007](../../adr/0007-convex-pro-single-seat.md), [ADR-0010](../../adr/0010-one-convex-administrator.md)). App users are not seats |
| Price | $25 per developer a month. Includes 50 GB database storage, 50 GB database bandwidth, 100 GB file storage, 25M function calls, 250 GB-hours of action compute, 50 GB egress. Over that: $0.20/GB storage and bandwidth, $0.03/GB files, $2 per million calls, $0.12/GB egress ([pricing](https://www.convex.dev/pricing)) |
| Why Pro | Daily scheduled backups, more egress for the nightly export, log streams and the Sentry integration. The free plan has none of these |
| If it goes away | The app stops: no sign-in, no data, no sync. Pending entries wait on devices. Recovery: restore the latest R2 backup into a new Convex deployment ([backup runbook](../../runbooks/backup-restore.md)). There is no other backend |
| Owner | Aaron, the one Convex member. The account should belong to the program before real records ([ADR-0007](../../adr/0007-convex-pro-single-seat.md)) |

### Cloudflare (website, backups, DNS)

| | |
| --- | --- |
| Does | Hosts the website (Workers Static Assets, plus a tiny Worker that answers a missing file with 404); holds the nightly backups in R2; serves the `angeloneaviation.org` DNS zone |
| Plan | Workers Free. R2 within its free tier |
| Price | Static asset requests are free and unlimited; Workers Free allows 100,000 Worker requests a day; Workers Paid is $5 a month ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). R2: $0.015 per GB-month, 10 GB free each month, no egress fees ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)) |
| If it goes away | Website: the site is unreachable; installed apps still open from their cache and log offline. Any static host can serve `dist/` ([release runbook](../../runbooks/release.md)). R2: no new off-site backups; any S3-compatible store can replace it ([ADR-0008](../../adr/0008-daily-backups-off-site-90-days-monthly-forever.md)) |
| Owner | Not recorded yet ([accounts](../../runbooks/accounts.md)). The API token in GitHub expires and must be rotated yearly |

### GitHub

| | |
| --- | --- |
| Does | Code, issues, CI, Deploy, the nightly backup job, Dependabot, secret scan, CodeQL |
| Plan | Free, with a **public** repository `angelone-aviation/AO-aircraft-maintenance` |
| Price | Actions on standard runners are free for public repositories. A private repository on Free gets $12 of minutes a month (Linux at $0.006 a minute), and needs a paid plan (Team, $4 per user a month) for branch rules and required reviewers ([pricing](https://github.com/pricing), [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) |
| Watch | In a public repository, scheduled workflows stop after 60 days without activity, which would stop the nightly backup ([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow)) |
| If it goes away | No CI, no deploys, no nightly backups. The live site and Convex keep running. Deploy by hand from a computer ([release runbook](../../runbooks/release.md)) |
| Owner | The Angel One organisation |

### Resend (email)

| | |
| --- | --- |
| Does | The daily alert digest (13:00 UTC) and immediate urgent-alert emails |
| Plan | Free |
| Price | Free: 3,000 emails a month, **100 a day**, 3 domains. Pro: $20 a month for 50,000, no daily cap ([pricing](https://resend.com/pricing)). The app caps urgent emails at 60 a day so the digest fits |
| If it goes away | No alert emails. The bell, the Alerts page and device push keep working. The backup-age warning is email only |
| Owner | Not recorded yet |

### Web Push

| | |
| --- | --- |
| Does | Urgent alerts on members' devices, sent by Convex through each browser's push service |
| Plan, price | None. The VAPID key pair lives in Convex's environment ([ADR-0012](../../adr/0012-urgent-alerts-by-web-push-and-immediate-email.md)) |
| If it goes away | No device alerts; email and the bell continue. Rotating the key pair signs every device out of alerts |
| Owner | Aaron (the keys are Convex variables) |

### Better Stack (monitoring)

| | |
| --- | --- |
| Does | Two uptime monitors (the site, and Convex's sign-in service) and a heartbeat the nightly backup pings ([monitoring runbook](../../runbooks/monitoring.md#better-stack-uptime-and-the-backup-heartbeat)). Set up 20 Nov 2026 |
| Plan | Free. Aaron chose Better Stack only, no Sentry, on 20 Nov |
| Price | Free: 10 monitors and heartbeats, 1 status page, Slack and email alerts ([pricing](https://betterstack.com/pricing)) |
| If it goes away | Nobody is told the site is down or a backup was missed until a user or the daily digest says so |
| Owner | Not recorded yet |

### Domain registrar

| | |
| --- | --- |
| Does | Owns `angeloneaviation.org`. Its DNS zone is on Cloudflare |
| Plan, price | **Not known**: which registrar holds it is still to find out ([accounts](../../runbooks/accounts.md)). For scale, .org renews for about $11 a year at Cloudflare Registrar's at-cost price (**estimate**, from a third-party price list: [cfdomainpricing.com](https://cfdomainpricing.com/); Cloudflare states it adds no markup: [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/)) |
| If it goes away | A lapsed domain takes the site and email down, and lets someone else buy the name. Keep auto-renew on |
| Owner | Not recorded yet |

### FAA DRS API key

| | |
| --- | --- |
| Does | The daily AD check against the FAA's Dynamic Regulatory System ([airworthiness](../../airworthiness.md)) |
| Plan, price | A key requested at <https://drs.faa.gov/drs-api>. Cost **not known**: no official price was found |
| Expires | **14 October 2027**. Settings → System warns from 60 days before |
| If it goes away | No automatic AD monitoring. ADs can still be entered and tracked by hand |
| Owner | Not recorded yet |

### Geoapify (address lookup)

| | |
| --- | --- |
| Does | Checks shipping addresses on purchase orders and requests |
| Plan | Free |
| Price | Free: 3,000 credits a day. Cheapest paid plan $59 a month ([pricing](https://www.geoapify.com/pricing/)). The app spends at most 2,900 a day ([addresses](../../address-verification.md)) |
| If it goes away | Addresses are typed and saved without the check |
| Owner | Not recorded yet. The key is stored encrypted in the app |

### Aircraft Spruce

| | |
| --- | --- |
| Does | Catalogue and order downloads for a linked account, per Flight Program ([Aircraft Spruce](../../aircraft-spruce.md)) |
| Plan, price | The program's own customer and API account. Price **not known** |
| If it goes away | Order parts the usual way; purchase orders still work |
| Owner | Not recorded yet. The login is stored encrypted in the app |

### Google Workspace

| | |
| --- | --- |
| Does | The organisation's email (`angeloneaviation.org` mail is Google). Could provide Google sign-in, which is built but off |
| Price | Business Starter $7 per user a month (annual) or $8.40 (flexible); Business Standard $14 or $16.80 ([Google](https://knowledge.workspace.google.com/admin/billing/compare-flexible-and-annual-fixed-term-payment-plans)). A nonprofit edition is $0 ([Google for Nonprofits](https://www.google.com/nonprofits/offerings/workspace/)). Which one the program has is not known |
| If it goes away | Nothing in the app depends on it today |
| Owner | Not recorded yet |

### Dropbox (optional)

| | |
| --- | --- |
| Does | Holds the readable Excel copy of the records, if switched on ([ADR-0011](../../adr/0011-readable-records-copy-in-dropbox.md), [runbook](../../runbooks/dropbox-records-copy.md)). Not switched on yet |
| Price | Basic is free with 2 GB; Plus is $9.99 a month for 2 TB ([plans](https://www.dropbox.com/plans)). A workbook is about 1 MB at the sample's size, so Basic likely fits for years (**estimate**) |
| If it goes away | Only the convenience copy is lost. R2 holds the backups |
| Owner | Should be an organisation account with two-step sign-in |

### Sentry (optional, not used)

| | |
| --- | --- |
| Does | Would report browser and server errors. The code is in place and dormant ([monitoring runbook](../../runbooks/monitoring.md)) |
| Price | Developer plan free: 1 user, 5,000 errors. Team $26 a month (annual) or $29 ([pricing](https://sentry.io/pricing/)) |
| Status | Not used: Aaron chose Better Stack only (20 Nov 2026) |

## Accounts that cost nothing but must be kept

| Account | Why it matters | Where |
| --- | --- | --- |
| Microsoft Entra app registration, Google Cloud sign-in client | Only if single sign-on is switched on; Entra's secret expires | [Accounts runbook](../../runbooks/accounts.md#google-and-microsoft-sign-in) |
| The `accounts@angeloneonline.org` mailbox | Security reports arrive there | [SECURITY.md](../../../SECURITY.md) |
| A2 Hosting cPanel | Published the old test website. It is Jeff's, not Angel One's | [Accounts](../../runbooks/accounts.md) |
