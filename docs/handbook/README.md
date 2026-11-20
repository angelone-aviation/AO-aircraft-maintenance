# Angel One handbook

Everything about Angel One in one place: what it is, how it works, how to run it, what it costs, what could go wrong, and what changed. Written for the people who run the program and the app, not only developers.

## Where do I start?

| You are                             | Start with                                                                         | Then                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pilot                             | [Using the app](../wiki/Home.md)                                                   | [What everyone must know: pilots](1-start-here/must-know.md#pilots)                                                                                  |
| A mechanic or inspector             | [Using the app](../wiki/Home.md)                                                   | [Must know: mechanics](1-start-here/must-know.md#mechanics-and-inspectors), [How it works](2-how-it-works/how-it-works.md)                           |
| A Flight Program administrator      | [Must know: administrators](1-start-here/must-know.md#administrators)              | [Checklists](3-running-it/checklists.md), [Features](2-how-it-works/features.md)                                                                     |
| An owner or board member            | [Must know: owners and board](1-start-here/must-know.md#owners-and-board-members)  | [System overview](1-start-here/system-overview.md), [Services and costs](4-money-and-risk/services-and-costs.md), [Risks](4-money-and-risk/risks.md) |
| Aaron, or whoever maintains the app | [Must know: maintainer](1-start-here/must-know.md#whoever-maintains-the-app-aaron) | [Operations](3-running-it/operations.md), [Checklists](3-running-it/checklists.md), [Risks](4-money-and-risk/risks.md)                               |
| A developer new to the code         | [System overview](1-start-here/system-overview.md)                                 | [Code structure](6-for-developers/code-structure.md), [CONTEXT.md](../../CONTEXT.md), [CONSTRAINTS.md](../../CONSTRAINTS.md)                         |
| Setting it up from nothing          | [Set up from scratch](3-running-it/setup-from-scratch.md)                          | [Operations](3-running-it/operations.md)                                                                                                             |

## The pages

### Using the app

| Page                          | For      | What's in it                                                                                        |
| ----------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| [User guide](../wiki/Home.md) | Everyone | One page per role and per screen; tasks step by step; offline use; the user FAQ and troubleshooting |

### 1. Start here

| Page                                                 | For                  | What's in it                                                                              |
| ---------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| [What everyone must know](1-start-here/must-know.md) | Everyone             | The few rules that matter most, by role; what to do if the app is down                    |
| [System overview](1-start-here/system-overview.md)   | Everyone             | What the app is, who uses it, the parts (diagram), Flight Programs, roles, the data model |
| [FAQ](1-start-here/faq.md)                           | Aaron, owners, board | Technical and owner questions: editing records, deploys, outages, cost, lifespan          |
| [Glossary](1-start-here/glossary.md)                 | Everyone             | A pointer to [GLOSSARY.md](../../GLOSSARY.md), plus handbook shorthand                    |

### 2. How it works

| Page                                                         | For                              | What's in it                                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [How it works](2-how-it-works/how-it-works.md)               | Administrators, mechanics, Aaron | The life of a flight, problem report, work order and parts request; the change log; offline; history paging; file links; alerts; sign-in; sign-out |
| [Features](2-how-it-works/features.md)                       | Everyone                         | Every feature, one line each, linked to its rules                                                                                                  |
| [Capacity and limits](2-how-it-works/capacity-and-limits.md) | Aaron, board                     | The 20-year measurements, Convex's limits, what still grows, when to look again                                                                    |

### 3. Running it

| Page                                                      | For                   | What's in it                                                                              |
| --------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| [Set up from scratch](3-running-it/setup-from-scratch.md) | Aaron                 | Accounts, every secret and variable, step-by-step set-up from nothing                     |
| [Operations](3-running-it/operations.md)                  | Aaron                 | Releases, migrations, backups and restore, monitoring, incidents; each runbook summarised |
| [Checklists](3-running-it/checklists.md)                  | Administrators, Aaron | Daily, weekly, monthly, quarterly, twice-yearly, yearly and dated checks                  |

### 4. Money and risk

| Page                                                         | For          | What's in it                                                                |
| ------------------------------------------------------------ | ------------ | --------------------------------------------------------------------------- |
| [Services and costs](4-money-and-risk/services-and-costs.md) | Aaron, board | Every outside service, its plan, price and owner; monthly and yearly totals |
| [Risks](4-money-and-risk/risks.md)                           | Aaron, board | The risk register: likelihood, impact, what reduces it, owner, status       |

### 5. History

| Page                                | For          | What's in it                                                      |
| ----------------------------------- | ------------ | ----------------------------------------------------------------- |
| [Changelog](5-history/changelog.md) | Everyone     | Every release and every fix, with its commit                      |
| [Decisions](5-history/decisions.md) | Aaron, board | Every decision with its date; ADRs, D1–D25, H1–H7, 20 Nov choices |

### 6. For developers

| Page                                                 | For        | What's in it               |
| ---------------------------------------------------- | ---------- | -------------------------- |
| [Code structure](6-for-developers/code-structure.md) | Developers | How the code is structured |

## Elsewhere in the repository

| Looking for                      | Go to                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Rules of each feature            | [`docs/*.md`](../), listed in [Features](2-how-it-works/features.md)                                                   |
| Why something was decided        | [`docs/adr/`](../adr/)                                                                                                 |
| Step-by-step procedures          | [`docs/runbooks/`](../runbooks/)                                                                                       |
| What is left before real records | [Go-live checklist](../go-live-checklist.md)                                                                           |
| Security reviews and reporting   | [2 Nov](../security/review-2026-11-02.md), [4 Nov](../security/review-2026-11-04.md), [SECURITY.md](../../SECURITY.md) |
| Bug hunts                        | [3 Nov](../qa/bug-hunt-2026-11-03/README.md), [10 Nov](../qa/bug-hunt-2026-11-10/README.md)                            |
| Code follow-ups                  | [REFACTOR_ROADMAP.md](../../REFACTOR_ROADMAP.md)                                                                       |
| The developer's map              | [README](../../README.md), [CONTEXT.md](../../CONTEXT.md), [CONSTRAINTS.md](../../CONSTRAINTS.md)                      |
