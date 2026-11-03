# Angel One — agent instructions

Aircraft maintenance-records PWA for a mission flight program: React 19 + Vite + Zustand + TanStack Router in `src/`, Convex backend in `convex/`, offline demo mode in `src/data/demoBackend.ts` (workspace and outbox in `src/data/store.ts`). Multi-tenant by **Flight Program**. Records are safety-critical FAA maintenance records: prefer appending corrections over editing history, and never weaken an authorization or audit path to make a change smaller.

Verify with `npm run check` (typecheck, lint, vitest, build) and `npm run test:e2e` (Playwright against the production build). See `README.md` for setup and `docs/*.md` for feature behaviour.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `angelone-aviation/AO-aircraft-maintenance` (use the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root and ADRs in `docs/adr/`. See `docs/agents/domain.md`.
