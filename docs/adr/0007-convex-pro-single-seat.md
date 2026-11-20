---
status: accepted
date: 2026-11-02
---

# Convex Pro with one developer seat; one project holding production, previews and restore rehearsals

We stay on Convex (standing recommendation) and move the project to the **Pro plan with one developer seat, about US$25 a month**. Pro is what makes the other hardening decisions possible: scheduled daily backups (ADR-0008), preview deployments for per-change testing (release process), log streams and alerting integrations (monitoring), and 50 GB of monthly egress for the nightly off-site export. A single seat matches the team: Aaron alone deploys and administers; pilots, mechanics and administrators of the app are app users, not Convex members, and cost nothing.

## Topology

- **One Convex project** for Angel One.
- **Production deployment**: the only one holding real records.
- **The seat holder's development deployment** for day-to-day work.
- **Preview deployments** (Pro) created per change by CI and deleted after 14 days. These serve as staging; the release-process decision settles how they are used.
- **Restore rehearsals** import a production backup into a short-lived preview deployment (or, if a preview deployment refuses the import, a second free project used only for rehearsals). Real data must never be imported into a deployment anyone else can sign in to.

## Consequences

- **Tension with ADR-0005** (resolved by [ADR-0010](0010-one-convex-administrator.md): one Convex member, no second dashboard user): that decision limits production dashboard access to _two_ named administrators. One seat gives standing dashboard access to one person. Until resolved, the second administrator holds only break-glass material (the escrowed deploy key and environment variables, ADR-0008) and gets no standing dashboard login. A second seat (about another US$25 a month) would restore the two-person rule; this is an open question for the program, not settled here.
- Which account owns and pays for the Convex team is part of the external-accounts inventory; the transfer must happen before go-live so the program, not an individual, owns production.
- Pro's included egress (50 GB a month) bounds the nightly export: dataset plus files, times 30, must stay under it. Revisit when file storage passes about 1.5 GB.

## Considered options

- **Free/Starter plan**: rejected. No scheduled backups, at most two stored backups per deployment, no preview deployments, no log streams.
- **Pro with two seats**: deferred; see the ADR-0005 tension above.
- **Separate long-lived staging project**: not needed now; preview deployments cover it.
