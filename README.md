# Claims platform

A design and working prototype for an **individual** claims administration platform: life, disability income and annuities (long-term care later). No group insurance, no ERISA.

It has three parts that fit together:

- **A clickable mock** of the claims workbench: queue, claim workspace, intake, team board, portal.
- **A backend** (PostgreSQL, Temporal, .NET) that runs one life claim for real, from first notice to payment.
- **Live mode**: the mock's life claim screens driven by that backend, with a virtual clock, so you can watch Temporal workflows run, retry, fail and recover.

The idea the design is built on: **Temporal handles one claim's short, multi-step jobs; anything that waits is a row in a `deadlines` table in Postgres.** No workflow sleeps for days. A dispatcher starts a short workflow when a deadline comes due. Payments are a daily batch that doesn't depend on Temporal.

## Try it

Needs Node 20.19+ or 22.12+. For live mode you also need the .NET 10 SDK and a local Postgres (or Docker).

```
./claims.sh doctor        # what is installed, what is missing
./claims.sh prereqs       # install missing tools (asks first)
./claims.sh setup         # web dependencies and build

./claims.sh web           # the mock only, http://localhost:5173
./claims.sh demo up       # the live demo: Postgres, API with an embedded Temporal dev server, web
./claims.sh demo down
```

`demo up` serves the web app at http://localhost:5173, the API at :8080 and the Temporal UI at :8233. Start from a fresh database each time. Each run recreates the `claims_demo` database on your local Postgres and touches nothing else.

The demo has two scenarios, each walked through click by click in [docs/life-claim/LIVE-DEMO.md](docs/life-claim/LIVE-DEMO.md):

| Scenario | What happens |
|---|---|
| **Simple** | Intake, evidence, the examiner's decision (a team lead approves above her authority), payment items, the payment run, claim closed. |
| **Complex: "things bounce back"** | A worker stalls mid-step. A W-9 fails the IRS check. A photocopied death certificate is rejected while the letters service is down, so the workflow fails and ops re-runs it. The bank returns a payment, the claim reopens and closes a second time. |

## Layout

| Path | What it is |
|---|---|
| [web/](web/) | React 19, TypeScript and Vite. The mock by default; set `VITE_API_BASE=/api` for live mode. See [web/README.md](web/README.md). |
| [backend-dotnet/](backend-dotnet/) | The backend: ASP.NET Core, Dapper, DbUp, Temporalio on .NET 10. OpenAPI contract, migrations, deadline dispatcher, workflows, payment run, tests. See [backend-dotnet/README.md](backend-dotnet/README.md). |
| [backend/](backend/) | The original Java 21 / Spring Boot version of the first slice. Superseded by `backend-dotnet`, and the two cannot share a database. |
| [docs/](docs/) | Architecture, Temporal explainers, failure handling, the life claim walkthrough. |
| [claims.sh](claims.sh) | One script to set up, test, run and pack the project. |

## Read more

- [Backend architecture](docs/backend-architecture.md): components, how a deadline fires, how an event starts a workflow, batch versus Temporal.
- [Life claim, intake to payment](docs/life-claim/README.md): one claim step by step, with the swimlane, service levels, deadline rows and workflow runs.
- [Things bounce back](docs/life-claim/README-back-and-forth.html): the complex scenario, bounce by bounce.
- [How Temporal runs a claim](docs/temporal-explained-v2.html) and [layer by layer](docs/temporal-layers-v2.html): for teams new to Temporal.
- [With and without Temporal](docs/with-without-temporal-v2.html): the same job built both ways.

## Tests

```
./claims.sh test
```

This runs the web typecheck and lint, and the backend tests. The backend suite has 183 tests; the ones that need Postgres are skipped unless you set `TEST_PG_URL` (see the backend README). The web app also has browser check scripts in [web/scripts/](web/scripts/) that drive both scenarios and assert on the result.

## What is real, what is not

- **Real:** PostgreSQL, Temporal (an embedded dev server in the demo), the deadline dispatcher and Schedule, the workflows with their retries and re-runs, idempotency keys, the decision and payment logic.
- **Stubbed:** the IRS check, the letters service and the bank. The demo can make them fail on purpose.
- **Simulated:** time. The demo uses a virtual clock you move forward.
- **Not built yet:** a document store or viewer, denials and partial approvals, authentication, the disability and annuity flows in live mode, and the nightly checks beyond the overdue-deadline check.

Rule values (15- and 30-day limits, 3.5% interest, the $500,000 fast-track limit, retry settings) are examples, and the claims, people and policies are made up. The real values come from product configuration and state rules.

## License

No license has been chosen yet, so by default all rights are reserved.
