---
status: accepted
date: 2026-11-09
---

# Urgent alerts reach people by Web Push and an immediate email

Until now an alert reached a person only when they opened the app or read the next morning's digest (13:00 UTC). A grounded aircraft, an overdue inspection or AD, a component past its limit or an expired insurance policy can wait a day that way. The program asked for alerts that reach people, and for the dates it must renew to be tracked and alerted like everything else.

## Decision

- **Urgent alerts** are a fixed set of alert kinds (`URGENT_ALERT_KINDS` in `src/domain/alerts.ts`): `aircraft-grounded`, `inspection-overdue`, `ad-overdue`, `component-past-due`, `date-expired`. Everything else stays in the bell and the daily digest.
- **Two channels, the same message.** After a mutation that can create an urgent state, a scheduled check (`convex/urgentAlerts.ts`) recomputes the program's alerts per member and sends what is new to them: one email through Resend to members opted in (default on for program administrators and maintenance members), and one Web Push message to each device a member switched on under Settings → Alerts → **Alert this device** (screen name corrected 2026-11-20). The daily digest keeps running and lists everything, so nothing depends on a push arriving.
- **No second send.** Deliveries are recorded per channel in `alertDeliveries` (`digest`, `immediate`, `push`) and claimed before a send, so two checks running at once cannot both send, and a failed send releases its claim. An alert the digest already emailed is not emailed again at once.
- **A daily cap of 60 immediate emails** across the deployment (`consume()` in `convex/rateLimits.ts`), so the digest always fits under Resend's 100 emails a day on the free tier. Capped alerts wait for the digest.
- **Web Push is implemented from the RFCs** (8291 message encryption, 8292 VAPID) with Web Crypto in `convex/webPushProtocol.ts`, run from a Node action, rather than through the `web-push` npm package. The VAPID key pair lives in the Convex environment (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), never in the repository; the browser gets the public key from a query. Dormant until all three are set.
- **The service worker is ours.** `vite-plugin-pwa` builds `src/sw.ts` (`injectManifest`) with the same precache, runtime cache and navigation fallback the generated worker had, plus the `push` and `notificationclick` handlers. The content-security policy did not change: the worker and the push service's origin are not web content.
- **Expiring dates** are a record (`expiringItems`) with their own alert kinds, per program for its administrators and system-wide for system administrators, with the FAA key's renewal date joining the system list as a computed row.

## Consequences

- People get the four urgent kinds within a minute of the change, on the device and by email, and the digest once a day as before. An opted-in administrator can receive a few emails on a busy day; the cap, not the digest, bounds them.
- A push subscription is tied to a browser profile on a device. Signing in as someone else on the same device moves the subscription to that account once they switch alerts on. Signing out releases the device, and disabling an account or resetting its password forgets its devices, so no device keeps showing a member's alerts without a session (amended 2026-11-10). iOS delivers push only to an app added to the Home Screen (iOS 16.4+); the Settings block says so.
- Push services (Google, Apple, Mozilla) see the encrypted message, its size and the VAPID subject, never the text. Convex, not the browser, calls them, so `connect-src` is unchanged.
- The deployment carries no new runtime dependency. The cost is about 250 lines of protocol code, pinned to the RFC 8291 test vector in `convex/webPushProtocol.test.ts`; if the `web-push` package is ever preferred, only `convex/push.ts` changes.
- Operators record the deployment's renewals (Cloudflare token, Entra secret, security.txt, the VAPID keys) under Settings → System → Deployment expiring dates instead of a calendar; the [accounts runbook](../runbooks/accounts.md) points there.

## Considered options

- **Digest only, more often** (every few hours): rejected. It still misses a grounding by hours, and more digests means more email for everyone, not only the urgent cases.
- **SMS**: rejected for now. It needs a paid provider and phone numbers the app does not verify (`users.phone` is written only by Convex Auth and unused), costs per message, and gives less than a push message that opens the app. Can be added later as a third channel on the same claim mechanism.
- **The `web-push` npm package in a Node action**: workable and well known, but it adds a dependency (MPL-2.0) whose only job this deployment needs is covered by Web Crypto. The RFC implementation is smaller to audit and is pinned to the standard's own test vector.
- **A third-party push service (OneSignal, Firebase Cloud Messaging)**: rejected. It would hold the member list and the alert text outside the app's data boundary (CONTEXT.md §5), for no gain over Web Push.
