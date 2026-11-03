---
status: accepted
date: 2026-11-01
---

# Which architecture cleanups happen before launch

The 2026-11-01 architecture review (`docs/architecture/README.md`) listed seven deepening candidates. We decided: **before launch**, the server command-transaction module (ADR-0003, candidates A and B) first, then **flight submission as one domain module** shared by the Convex and demo adapters (candidate C), because logging a flight is the most safety-relevant write, exists twice today, and the two copies have already drifted. Moving the demo adapter out of `src/data/store.ts` (candidate D, the move only) rides along with A. **After launch**: form-to-command shaping (candidate E) limited to the work-order close-out readings, the numbers that reset component life. **Not pursued**: narrowing the `Backend` interface (candidate F); two adapters make it a real seam and its width is honest, so a generic `execute(kind, payload)` would trade compile-time typing for fewer lines. Deriving both adapters from a shared command table (the second half of D) waits until A has proven the table shape.

Alongside: a small set of browser tests (sign-in, log a flight, close a work order) runs against a real local Convex backend in the automated checks, because today all 59 browser tests exercise the demo adapter only. The release-process decision owns how those checks run.
