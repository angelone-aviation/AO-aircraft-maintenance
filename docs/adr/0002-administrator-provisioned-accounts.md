---
status: accepted
date: 2026-11-01
---

# Accounts are provisioned by administrators; no public sign-up or self-service reset

The requirements state "no sign up available (admin can add users)". The Password provider rejects every flow except sign-in, so the public signup and password-reset routes are closed server-side; administrators create users, assign Flight Program memberships and reset passwords, and the first administrator is bootstrapped through an internal function. Every account is a potential signer of maintenance records scoped to Flight Programs, so an unknown self-registered identity has no legitimate place, and a public reset endpoint is needless attack surface for a small, high-value target.

## Consequences

- Adding SSO must keep the "existing account only" gate: an OAuth identity is linked by verified email to an administrator-created user, and unknown identities are rejected rather than auto-created.
- Onboarding a new pilot or mechanic is an administrator task, and the runbooks must say so.
