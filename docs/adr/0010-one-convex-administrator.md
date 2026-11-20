---
status: accepted
date: 2026-11-03
---

# One Convex administrator; no second dashboard user

> Note, 2026-11-20: while backups are stored unencrypted ([ADR-0014](0014-backups-stored-unencrypted.md)) there is no backup key, so the "sealed copy held by the organization" below does not exist today. To recover without Aaron, the organization instead needs the Cloudflare login (it opens the R2 backups and the website), the Convex account's recovery, and owner rights on the GitHub organization. Who holds each is still blank in the [accounts](../runbooks/accounts.md) and [break-glass](../runbooks/break-glass-admin.md) runbooks. The sealed-key rule applies again if encryption is turned on.

The Convex Pro account has exactly **one member**: Aaron. There is no second dashboard user and no second break-glass holder with Convex access. This settles the tension recorded in ADR-0007 and replaces ADR-0005's "two named administrators" with one.

The change log stays protected the way ADR-0005 intends, through controls that do not depend on a second dashboard user:

- **No direct production edits**, except the restore or agreed repair in `docs/runbooks/database-access.md`, each followed by a hand-written audit entry.
- **Locked off-site backups** (ADR-0008): daily copies kept 90 days and monthly copies kept forever, in R2 with deletion locks, so a later edit can be detected by comparing against a copy nobody can alter.
- **Append-only audit entries** in the app (no code path edits or deletes one).

## Consequences

- A single person can reach production data. Tamper evidence relies on the locked backups and on the rule that every direct edit is recorded, not on a second person watching.
- The backup decryption key (ADR-0008) must not depend on that one person alone: keep a **sealed copy held by the organization** (for example its board or executive director), never by a Convex user. Losing every copy makes every archive unreadable.
- If Aaron leaves or is unavailable, the organization uses the sealed key and the Convex account's recovery to appoint a successor; record the handover in `docs/runbooks/accounts.md`.

## Considered options

- **Two seats (about US$50 a month)**: rejected; the organization will have one technical maintainer.
- **One seat plus a break-glass holder with a deploy key**: not adopted; the organization keeps only the sealed backup key, not production credentials.
