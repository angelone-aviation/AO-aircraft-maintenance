# Error monitoring, alerting and uptime options

Researched 2026-11-01 against vendor documentation and pricing pages only. Stack: React 19 + Vite PWA (`vite-plugin-pwa`, `registerType: "prompt"`), Convex backend, Resend email already wired in `convex/alerts.ts`, 5-30 users, no ops person.

## Summary

Convex gives you a live Logs page and a Health page on every plan, but anything that pushes failures out of the dashboard (Sentry exception reporting, log streams to Axiom/Datadog/webhook) needs the Professional plan at $25 per developer per month. Front-end errors are a separate problem and Sentry's free Developer tier (5k errors, 1 user, email only) covers a 30-user app comfortably; GlitchTip and Rollbar are the Sentry-compatible fallbacks if you want a smaller vendor or self-hosting. Uptime for a static site plus the Convex deployment URL is free from UptimeRobot (50 monitors, 5-minute checks) or Better Stack (10 monitors, 3-minute checks). The realistic cheap stack is Sentry free + UptimeRobot free + Convex dashboard, routed to two named people by email, for $0; adding Convex Pro so backend exceptions land in the same Sentry project costs $25-50/month.

## Comparison

| Tool | Covers | Free tier | Notifies via | Source |
|---|---|---|---|---|
| Convex dashboard Logs/Health | Backend function logs, failure rate, scheduler lag | All plans; short, unspecified log history | None (pull only) | https://docs.convex.dev/dashboard/deployments/logs, https://docs.convex.dev/dashboard/deployments/health |
| Convex Exception Reporting (Sentry) | Backend function exceptions pushed to Sentry | Pro only, $25/dev/mo | Via Sentry alerts | https://docs.convex.dev/production/integrations/exception-reporting, https://www.convex.dev/pricing |
| Convex Log Streams | Function execution, console, scheduler/concurrency stats to Axiom/Datadog/PostHog/webhook | Pro only | Via destination | https://docs.convex.dev/production/integrations/log-streams/ |
| Sentry (React SDK) | Browser errors, React render errors, replays, offline queue | Developer: 5k errors, 50 replays, 1 user, email alerts, no third-party integrations | Email; Slack/Discord/Teams/PagerDuty on Team ($26-29/mo) | https://sentry.io/pricing/ |
| GlitchTip (hosted) | Sentry-SDK-compatible error tracking | 1,000 events/mo, 30-day retention; $15/mo for 100k; self-host free | Email, webhooks | https://glitchtip.com/pricing |
| Rollbar | Error tracking | 5k occurrences + 1k replays/mo, 30-day retention | Slack, email, webhook, PagerDuty | https://rollbar.com/pricing/ |
| Bugsnag (SmartBear Insight Hub) | Error tracking | 7.5k events + 1M spans/mo | Slack/Teams, daily/weekly email reports, PagerDuty | https://www.bugsnag.com/pricing |
| Highlight.io | (acquired; URL redirects to launchdarkly.com) | Not offered as a standalone product | n/a | https://www.highlight.io/pricing |
| UptimeRobot | HTTP/keyword/ping monitors, status page | 50 monitors, 5-min checks, 1 basic status page | Email, mobile push, Email-to-SMS gateway; SMS/voice credits paid; Slack etc. in paid tiers | https://uptimerobot.com/pricing/, https://uptimerobot.com/integrations/ |
| Better Stack Uptime | HTTP monitors, heartbeats, status page, on-call | 10 monitors + 10 heartbeats, 3-min checks, 1 status page, email + Slack | Email, Slack; SMS/phone/Teams/push on paid add-ons (+50 monitors $25/mo) | https://betterstack.com/uptime/pricing, https://betterstack.com/uptime |
| Cloudflare Health Checks | Origin health from Cloudflare edge | None on Free; Pro 10 checks, Business 50 | Cloudflare Notifications: email, webhook, PagerDuty | https://developers.cloudflare.com/health-checks/, https://developers.cloudflare.com/notifications/notification-available/ |

## 1. Convex-native

- **Logs page** (all plans): realtime list of executions with request ID, success/failure, function name, `console.*` output and exceptions, filterable by status and severity. Docs call it "a short history of recent function logs" and "not a complete historical view"; retention period is not stated. For history, "configure a log stream." https://docs.convex.dev/dashboard/deployments/logs
- **Health page** (all plans): failure rate and cache hit rate by minute over the last hour, scheduler lag, last deploy, Insights (bytes/documents read, write conflicts). No alerting or email is documented. The Integrations panel on this page is Pro only. https://docs.convex.dev/dashboard/deployments/health
- **Exception Reporting**: Deployment Settings > Integrations > Sentry; needs a Sentry DSN (create the Sentry project as platform Node.js), optional custom tags. Auto-tags `func`, `func_type`, `request_id`, `environment`, `user` (tokenIdentifier). "Currently, exception reporting is only available to Pro users." Events take a minute or two to arrive. https://docs.convex.dev/production/integrations/exception-reporting
- **Log Streams**: Axiom, Datadog, PostHog, or signed webhook (HMAC-SHA256 `x-webhook-signature`). Topics include `function_execution` (status, errors, timing) and `scheduler_stats`. Best-effort delivery. "Log streams require a Convex Pro plan." https://docs.convex.dev/production/integrations/log-streams/
- **Pricing**: Free/Starter $0; Professional "$25 per developer/month" and the only tier listing log streaming and exception reporting below Business ($2,500/mo minimum). https://www.convex.dev/pricing
- **Alerting Convex sends**: none documented for deployment health. The limits page describes free-plan writes failing after quota, not an email. https://docs.convex.dev/production/state/limits
- **Error semantics**: in prod, non-`ConvexError` errors reach the client as a generic "Server Error" with no stack; full traces are only in the Logs page or Exception Reporting. Query errors throw at `useQuery` (catch with an error boundary); mutation rejections do not hit error boundaries and must be `.catch`-ed or they surface as unhandled rejections, which Sentry captures. Actions are not retried. https://docs.convex.dev/functions/error-handling/

## 2. Front-end error monitoring

- **Sentry React**: `npm install @sentry/react`; `Sentry.init({ dsn, integrations: [...] })` imported before `App`; React 19 uses `Sentry.reactErrorHandler` in `createRoot` options rather than the older `<Sentry.ErrorBoundary>`. https://docs.sentry.io/platforms/javascript/guides/react/
- **Source maps from Vite**: `npm install @sentry/bundler-plugins --save-dev`, `build.sourcemap: "hidden"`, `sentryVitePlugin({ org, project, authToken: process.env.SENTRY_AUTH_TOKEN, sourcemaps: { filesToDeleteAfterUpload: ["./**/*.map"] } })` placed last in `plugins`. Token via `SENTRY_AUTH_TOKEN` or git-ignored `.env.sentry-build-plugin`. Uploads only in production builds. https://docs.sentry.io/platforms/javascript/guides/react/sourcemaps/uploading/vite/
- **Session Replay privacy**: defaults are `maskAllText: true`, `maskAllInputs: true`, `blockAllMedia: true`; request/response body capture is opt-in; `.sentry-block`/`.sentry-mask` classes for element control. For a records app, keep defaults and consider not enabling replay at all (50 replays/mo on free anyway). https://docs.sentry.io/platforms/javascript/session-replay/privacy/
- **Free tier**: Developer plan, 5k errors, 50 replays, 1 user, email alerts, no third-party integrations. Team $29/mo ($26 annual) for 50k errors, unlimited users and integrations. https://sentry.io/pricing/
- **Alert rules**: issue alerts trigger on new issue, escalation, regression, etc.; actions notify a member/team (delivered per their notification settings, email or Slack), or Slack/Discord/Teams/PagerDuty/webhook; action interval throttles repeats from "every trigger" up to 30 days. https://docs.sentry.io/product/alerts/create-alerts/issue-alert-config/
- **Alternatives**: GlitchTip (Sentry-SDK compatible, 1,000 events/mo free, $15/mo for 100k, self-hostable) https://glitchtip.com/pricing; Rollbar (5k occurrences/mo free) https://rollbar.com/pricing/; Bugsnag (7.5k events/mo free, daily/weekly email reports) https://www.bugsnag.com/pricing. Highlight.io now redirects to LaunchDarkly and is not a standalone option.

## 3. Uptime / synthetic checks

Monitor two URLs: the static site (expect 200 and a keyword in `index.html`) and the Convex deployment URL (`https://<deployment>.convex.cloud`, expect a 2xx/4xx from the root, which proves the deployment is reachable).

- **UptimeRobot Free**: 50 monitors, 5-minute interval, 1 basic status page. Email and the free mobile app push are included; SMS/voice are paid credits; Slack and other integrations are listed for Solo ($9/mo annual) and Team ($30/mo annual). https://uptimerobot.com/pricing/, https://uptimerobot.com/integrations/
- **Better Stack Free**: "10 monitors, 10 heartbeats and a status page with 3-minute checks totally free", Slack and email alerts. Phone call/SMS alerts, escalation policies and extra monitors are paid (50 monitors $25/mo). https://betterstack.com/uptime/pricing, https://betterstack.com/uptime
- **Cloudflare Health Checks**: 0 on Free, 10 on Pro, 50 on Business; notifications through Cloudflare Notifications (email, webhook, PagerDuty) and the Health Checks notification type is "Professional plans or higher". Only worth it if the domain is already on a paid Cloudflare zone. https://developers.cloudflare.com/health-checks/, https://developers.cloudflare.com/notifications/notification-available/

## 4. Notification routing for a tiny team

- **Email to two named roles** (for example "Maintenance lead" and "App maintainer" as a shared alias) is the only channel every free tier supports. Sentry alerts route through each recipient's notification settings; UptimeRobot and Better Stack send to configured contacts.
- **Slack** is free on Better Stack; on Sentry it needs the Team plan (Developer excludes third-party integrations). https://sentry.io/pricing/
- **SMS/phone**: Better Stack paid add-ons, UptimeRobot paid credits. Without PagerDuty, the practical escalation is UptimeRobot/Better Stack phone call for "site down" only, and email for everything else.
- **Digests**: Sentry sends a weekly report email every Saturday and throttles repeat alerts per issue via the action interval. https://docs.sentry.io/product/notifications/, https://docs.sentry.io/product/alerts/create-alerts/issue-alert-config/. Bugsnag offers daily/weekly email reports. A zero-cost alternative that reuses existing code: a Convex mutation `reportClientError` that stores caught errors, and the existing Resend digest pattern in `convex/alerts.ts` emails them daily.

## 5. PWA / offline specifics

- **Offline error capture**: `transport: Sentry.makeBrowserOfflineTransport(Sentry.makeFetchTransport)` queues envelopes in IndexedDB (`sentry-offline`/`queue`), `maxQueueSize` default 30, `flushAtStartup` default false (set true for a PWA that reopens online). https://docs.sentry.io/platforms/javascript/best-practices/offline-caching/
- **Service worker failures**: `registerSW`/`useRegisterSW` from `virtual:pwa-register` accept `onRegisterError(error)` alongside the `onNeedRefresh`/`onOfflineReady` already used in `src/main.tsx`; forward that error to `Sentry.captureException`. https://vite-pwa-org.netlify.app/frameworks/react.html
- Uptime monitors cannot see offline-mode failures; only the client SDK can.

## 6. Privacy and compliance

- **Client-side**: `beforeSend` to delete fields (docs example removes `event.user.email`); set only an opaque user ID via `Sentry.setUser`; `dataCollection: { userInfo: false, httpBodies..., urlQueryParams: false }` (SDK 10.57+) replaces the deprecated `sendDefaultPii`. Keys matching the built-in denylist (`auth`, `token`, `password`) are always `[Filtered]`. https://docs.sentry.io/platforms/javascript/guides/react/data-management/sensitive-data/, https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/
- **Server-side scrubbing** is on by default (credit cards, password/secret/token key names), configurable per org/project with Additional Sensitive Fields and Advanced Data Scrubbing; it stops storage, not transmission. https://docs.sentry.io/security-legal-pii/scrubbing/server-side-scrubbing/
- **Data residency**: choose US (Iowa) or EU (Frankfurt) at organization creation; cannot be changed later. https://docs.sentry.io/organization/data-storage-location/
- Convex Exception Reporting sends the user `tokenIdentifier` as a tag; Log Streams send `console.*` output verbatim, so never log record contents.

## Decision inputs

| Stack | Who gets what | Monthly cost |
|---|---|---|
| **A. Minimal**: Sentry Developer (browser) + UptimeRobot Free (site + Convex URL) + Convex dashboard checked weekly | Email to two role aliases from Sentry and UptimeRobot; weekly Sentry report | $0 |
| **B. Backend visibility**: A + Convex Professional with Exception Reporting into the same Sentry org | Backend exceptions alert by email like front-end ones | $25-50 (1-2 Convex developers) |
| **C. Slack + phone**: B + Sentry Team + Better Stack paid monitors for phone call on site-down | Slack channel for errors, phone call for outage, email for the rest | ~$80-105 |

Recommendation: start with A, add B when the first backend bug costs more than $25 to find in the Logs page.

## Open questions

- Which hosting serves the static site (no Netlify/Vercel/Cloudflare config found)? Determines whether Cloudflare Health Checks are even applicable.
- Are maintenance records regulated such that EU residency or a no-third-party policy is required? If so, GlitchTip self-hosted or stack A with replay disabled.
- Who are the two named recipients, and should the Convex Pro seat count be 1 or 2?
- Is a Convex mutation plus the existing Resend digest preferable to Sentry for a team that may not log into another dashboard?
