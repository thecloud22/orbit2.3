# Claims backend: life claim slice (.NET)

A port of the Java slice in `../backend` to .NET, for the same individual life, disability income and annuity claims platform. It is a
**bounded vertical slice**: one life claim, built the way [the architecture](../docs/backend-architecture.md) says the whole platform should be built.
It began as intake to the first follow-up deadlines (the port of the Java slice), then ran **the simple natural-causes claim end to end**:
intake, evidence, proof of loss, the examiner's decision (and a team lead's approval above her authority), payment items, the daily payment run, the
closed claim. See [The simple life claim, end to end](#the-simple-life-claim-end-to-end), and `./claims.sh demo up` to watch it live in the web app. It now also runs **the complex claim, "things bounce back"**: a worker that
stalls mid-step, a W-9 that fails the IRS check, a photocopied certificate, a letters service that is down, and a payment the bank returns, so the claim reopens and closes a second time. See
[The complex life claim: things bounce back](#the-complex-life-claim-things-bounce-back). The React mock in `../web` is the reference for
behaviour; nothing here edits it, and nothing here edits `../backend`.

- PostgreSQL is the system of record: every fact, every deadline, the outbox.
- Temporal (the organisation's, not ours to run) executes short workflows against those rows.
- A **deadlines table** plus a **dispatcher** replace long sleeping workflows. Each deadline is a row; the dispatcher fires it.
- Scope is individual products only. No group or ERISA.

**.NET 10 (LTS)**, ASP.NET Core minimal APIs, Dapper + Npgsql with the same hand-written SQL, DbUp (the Flyway SQL files, unchanged),
Temporalio 1.20.0 (the Temporal .NET SDK), xUnit v3, Testcontainers. Namespace `Claims.*`.

Why .NET 10 and not 8: it is the current LTS (supported to November 2028; .NET 8 goes out of support in November 2026), and the whole
stack runs on it. Temporalio 1.20.0 ships `netstandard2.0` and `netcoreapp3.1` assets, so it has no `net10.0`-specific build, but that is not
a limitation: the workflow tests, the replay test and an end-to-end run against a real Temporal dev server (see "Verification") all ran on
`net10.0`.

The database schema (V1 to V5 unchanged; V6 and V7 are new), the workflow shapes, the activity and workflow names and the idempotency keys of the intake slice
are the Java version's. The OpenAPI contract started as the Java copy and has grown: decisions, payments, work-item completion, staff and the dev
endpoints are only here, so the Java backend can no longer stand in for this one behind the same web client (see "Java to .NET differences").

## Layout

```
backend-dotnet/
  Claims.sln
  global.json, Directory.Build.props        SDK pin (10.0.100, roll forward), nullable + warnings as errors for everything
  BannedSymbols.txt                         determinism guard for workflow code (see "Workflow code is replayed")
  api/openapi.yaml                          OpenAPI 3.1 contract, grown from ../backend's (lint: npx @redocly/cli lint api/openapi.yaml)
  redocly.yaml                              lint config (turns off only the "localhost server" warning)
  docs/schema.md                            ER sketch (mermaid) and the reasoning behind the non-obvious schema choices
  docker/docker-compose.yml                 Postgres + a dev Temporal server (not verified: no Docker daemon was available)
  src/Claims.Api/
    Program.cs, appsettings.json, appsettings.Development.json
    Migrations/   Migrator (DbUp) and Scripts/V1..V5 (the Flyway files, unchanged), V6 (decision approvals, payment run columns), V7 (documents, reopen, returns, run records), V8 (a letter can be `skipped`) and Scripts/Dev/R__dev_staff.sql
    Web/          minimal-API endpoint groups, problem+json middleware, ETag / If-Match
    Intake/       LifeIntakeService (one transaction), LifeIntakeRules (pure), LifeIntakeValidator, IntakeSetupService (the activities' DB work)
    Requirement/  accept / waive, proof-of-loss-complete
    Decision/     DecisionService: record (within authority: one transaction) and approve (above it)
    Payment/      PaymentRules (interest, split: pure), DecisionPlan, PaymentRunService (the batch), PaymentReturnsService (the returns batch), PaymentMethodService (a payee's new account and the
                  replacement item), PaymentItemService (hold, release), PaymentRunPoller, PaymentReturnsPoller
    Documents/    DocumentService: a document arriving and the examiner's review of one (Postgres only)
    Requirement/  accept / waive, proof-of-loss-complete, DocumentRules (what the rules do with a document: pure)
    Events/       the database work of the event workflows (decision letters, payment confirmations, documents, returned payments, new accounts) and WorkflowFailureRecorder (the ops task and the failed run)
    Clock/        IClock and VirtualClock: business time, with a Development-only offset (its endpoints: Web/DevEndpoints.cs)
    Deadline/     DeadlineDispatcher, FollowUpService, DeadlineService (extend), optional local poller, OverdueCheckService (the nightly overdue check) and its poller
    Outbox/       OutboxRelay + poller
    Temporal/     the workflows (intake, follow-up, dispatcher, and the event workflows DecisionRecorded / PaymentConfirmed / DocumentReceived / DocumentRejected / PaymentReturned / PaymentMethodUpdated),
                  activities, launcher (the only place that starts workflows; one generic entry point for `event-<id>`), WorkflowRerunService (ops re-run), WorkerFaultInterceptor (the worker stall fault),
                  Schedule registrar, worker, the embedded dev server
    Gateway/      policy admin, sanctions, IRS TIN match, notifications, bank (payment files, the returns queue, account verification): interfaces and STUBS, and the fault registry (Dev:Faults, POST /dev/faults)
    Store/        SQL: read side (ClaimQueries) and one repository per write concern
    Domain/, Common/, Config/, View/
  tests/Claims.Tests/                       183 tests, see "Tests"
```

## Build and run

Prerequisite: the **.NET 10 SDK**. On macOS `brew install dotnet-sdk`; on Debian/Ubuntu `sudo apt-get install dotnet-sdk-10.0` (from
Microsoft's package feed if your distribution does not have it yet); or `dotnet-install.sh --channel 10.0` into a directory of your choice
(that is how this port was built: `DOTNET_ROOT` and `PATH` for one shell, nothing installed system-wide). `./claims.sh doctor` checks it.

```
dotnet build                   # zero warnings; warnings are errors
dotnet test                    # all tests; the Postgres ones skip themselves with a reason if there is no Postgres
```

### Tests

| Kind | Classes | Needs |
|---|---|---|
| Pure unit | `LifeIntakeRulesTests`, `PaymentRulesTests` (interest and split, checked against the docs page's figures and the mock's own `interestFor`), `DevSafetyTests` (the clock class; the host refuses Dev controls in Production) | nothing |
| Workflow, Temporal `WorkflowEnvironment` with **time skipping**, fake activities | `LifeIntakeWorkflowTests`, `RequirementFollowUpWorkflowTests`, `DeadlineDispatcherWorkflowTests`, `EventWorkflowTests` (the decision letters workflow incl. retry and exhausted retries, the payment confirmation workflow, a replay) | nothing (the SDK downloads Temporal's test server binary on first use) |
| **Real PostgreSQL** | `*PostgresTests`: `DeadlineDispatcherPostgresTests` (SKIP LOCKED), `SchemaConstraintsPostgresTests`, `LifeIntakeApiPostgresTests` (the API hosted in-process), `LifeClaimFlowPostgresTests` (intake slice on Temporal's time-skipping server), and the simple-scenario tests below | Postgres |
| Simple scenario, real Postgres | `DecisionPostgresTests` (one transaction, authority, approval, atomicity by fault injection, idempotency, immutability, guards, work-item completion, staff), `PaymentRunPostgresTests` (the run, concurrency, SKIP LOCKED with its negative control, immutable paid items, holds, bank down, bank returns an item), `VirtualClockPostgresTests` (the clock drives the dispatcher; the dev endpoints exist only when enabled), **`SimpleLifeScenarioPostgresTests`: the whole story, intake to closed, on real Postgres and Temporal's in-process server** | Postgres |
| Extra (not Java ports) | `WireNamesTests`, `WorkflowReplayTests`, `PgConnectionTests`, and one conditional-GET test in `LifeIntakeApiPostgresTests` | nothing / Postgres |
| Complex scenario, pure | `BounceRulesTests` (what the rules do with a document, the fault switchboard: counted, atomic under 200 threads, logged; the run step's shape and its backward-compatible reading) | nothing |
| Complex scenario, workflow (time-skipping server, fake activities) | `BounceWorkflowTests`: **an IRS "no match" is an answer, not an error (one check, no retry)** and a 503 is retried and shown as `retried` with its attempts; retries exhausted give a `failed` step with 5 attempts and the failure is recorded; a recorded run (with a retry) and a recorded failed run replay against the current code; the letter is retried 5 times with waits of 2, 4, 8 and 16 s (30 s of workflow time) and then the run fails; **rerun idempotency**: the same workflow id starts again after a failure and is refused after it completed; photocopy: the workflow ends after handing over; returned payment, new account (verified / not verified) | nothing |
| Complex scenario, real PostgreSQL | `DocumentPostgresTests` (each new transaction: receive with its outbox event and key, atomicity by fault injection, the accept path, not-enough with its chase, the hand-off, review accept and reject saved before any workflow, the guards, the letter exactly once, a failed run and its run 2), `BankReturnPostgresTests` (the returns batch, immutability of a returned item, skip reasons, **SKIP LOCKED with a second connection, a negative control and 6 concurrent batches**, reopen, the payee's new account and its replacement, the run that leaves held items alone and pays the replacement, the second close, an account that cannot be verified), `OverdueCheckPostgresTests` (once per row, never edits a row, ignores closed claims and dispatcher kinds, two checks at once, the work item closes with its row), `WorkflowRerunPostgresTests`, `DevControlsPostgresTests` (the fault switches and the stub bank's queue), `BatchPollersPostgresTests` (the two hosted daily jobs) | Postgres |
| **Complex scenario, end to end** | **`ComplexLifeScenarioPostgresTests`: the whole story on real Postgres and Temporal's in-process server, HTTP calls, the virtual clock and the fault switches only** (about 65 s: the test server does not skip the stalled attempt's 30 s timeout, nor, after it, the retry waits) | Postgres |

The 47 Java tests are all ported, one for one, with the same names (in C# casing) and the same intent and assertions, adapted to the .NET APIs (18 without Postgres, 29 with). Seven more are
new (the "Extra" row), the simple-scenario work added 50 (104), and the complex scenario added 70 (174), and the follow-up fixes below added 9 (183 in all: 84 run without Postgres, 99 need it). The Java `@RequiresPostgres` is `[PostgresFact]`. Tests that need business time to be a particular day
use a `SettableClock` (a test double for `IClock`), so the mock's dates and figures come out the same whenever the suite runs.

No in-memory stand-in is used anywhere: `SKIP LOCKED`, partial indexes, triggers and `jsonb` must behave as in production. The Postgres
tests find a server in this order, and are **skipped with the reason** (`REQUIRES POSTGRES/DOCKER: ...`) if neither exists:

1. `TEST_PG_URL` (plus optional `TEST_PG_USER`, default `postgres`, and `TEST_PG_PASSWORD`). Each test class creates its own database on it.
   The URL is the JDBC form the Java tests used (`jdbc:postgresql://127.0.0.1:55432/postgres`) or an Npgsql connection string
   (`Host=127.0.0.1;Port=55432;Database=postgres`); both work.
2. Testcontainers (`postgres:16-alpine`), when a Docker daemon is running (`docker info` succeeds).

A throwaway local cluster, if you have Postgres binaries but no Docker (Homebrew paths shown; the `LC_ALL` is needed on macOS):

```
export LC_ALL=en_US.UTF-8
initdb -D /tmp/claims-pg -U postgres --auth=trust -E UTF8
pg_ctl -D /tmp/claims-pg -o "-p 55432 -c unix_socket_directories= -c listen_addresses=127.0.0.1" -l /tmp/claims-pg.log -w start
TEST_PG_URL=jdbc:postgresql://127.0.0.1:55432/postgres dotnet test
```

### Run locally

```
docker compose -f docker/docker-compose.yml up -d                 # Postgres on 5432 (PG_PORT=5433 to change), a dev Temporal on 7233 (UI on 8233)
cd src/Claims.Api && ASPNETCORE_ENVIRONMENT=Development dotnet run    # DbUp migrates; Development adds two staff users and the local dispatcher poll
```

or `./claims.sh infra up && ./claims.sh backend` from the repository root (`BACKEND=dotnet` is the default there; `BACKEND=java` runs `../backend`).
Run it from `src/Claims.Api` (or with `dotnet run --project`): `appsettings*.json` are found relative to the working directory.

**In real life we do not run Temporal.** The organisation's platform team does, and we own a *namespace* and *task queues* on it. The compose
file's dev server exists only so the slice runs on a laptop. Point the app at the real cluster with `TEMPORAL_TARGET`, `TEMPORAL_NAMESPACE`
and `TEMPORAL_TASK_QUEUE`, and add its TLS or API-key settings in `Temporal/TemporalSetup.cs`.

**Configuration.** The variables operations already know are unchanged: `CLAIMS_DB_URL` (a JDBC URL as before, a `postgres://` URI or an Npgsql
connection string), `CLAIMS_DB_USER`, `CLAIMS_DB_PASSWORD`, `TEMPORAL_TARGET`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE`, `TEST_PG_URL/USER/PASSWORD`.
Everything else that was `claims.*` in `application.yml` is `Claims:*` in `appsettings.json`, and can be set as an environment variable with
double underscores (`claims.dispatcher.batch-size` is `Claims__Dispatcher__BatchSize`). Durations are TimeSpan text (`00:01:00`, not `1m`).
`Claims:Temporal:Enabled=false` runs the API without any Temporal (workflow starts then fail loudly; the Postgres tests use this),
`Claims:Dispatcher:ScheduleEnabled` (the Temporal Schedule), `Claims:Dispatcher:LocalPollEnabled` (an in-process alternative to the Schedule, on in
`Development`), `Claims:Outbox:PollEnabled`, `Claims:Business:Zone` and `FireTime`. `ASPNETCORE_URLS` sets the address (default `http://*:8080`).
New with the simple scenario, all off unless said (details in the sections below): `Claims:PaymentRun:ScheduleEnabled` / `PollInterval` / `RunTime` (the daily payment run's
in-process trigger; on in `Development`), `Claims:Dev:Controls` (the `/dev/clock` endpoints and the virtual clock), `Claims:Dev:Faults` (named fault switches for the stub gateways),
`Claims:Temporal:DevServer` / `DevServerPort` / `DevServerUiPort` / `DevServerPath` (or `TEMPORAL_DEV_SERVER_PATH`) / `DevServerDbFile` (an embedded Temporal dev server).
New with the complex scenario: `Claims:PaymentRun:ReturnsRunTime` (the daily returns batch runs from that local time, 06:30, from the payment run's in-process trigger), `Claims:OverdueCheck:ScheduleEnabled` / `PollInterval` / `RunTime`
(the nightly overdue check's in-process trigger, off by default, 02:30 local; `claims.sh demo` turns it on) and `Claims:Dev:StallFor` (how long the `worker.stall-once` fault hangs: 35 s, longer than the activities' 30 s StartToClose timeout).
**`Dev:Controls` and `Temporal:DevServer` refuse to start in the `Production` environment**, which is also what ASP.NET Core assumes when `ASPNETCORE_ENVIRONMENT` is not set.
Run with `dotnet run --no-launch-profile` (as `claims.sh` does) if you set `ASPNETCORE_URLS` yourself: `launchSettings.json` would otherwise override it.

Try it (needs the app running; the body is the mock's Castellano story, see `tests/Claims.Tests/Support/TestData.cs`):

```
curl -i -X POST localhost:8080/claims/life-intake -H 'Content-Type: application/json' \
     -H "Idempotency-Key: $(uuidgen)" -d @intake.json        # 201, status "received"; workflows run afterwards
curl localhost:8080/claims                                    # then poll: status becomes gathering_evidence
curl localhost:8080/claims/<id>/deadlines
curl localhost:8080/claims/<id>/workflow-runs
```

## How the slice works

Unchanged from the Java version; the short form (the long form is in `../backend/README.md`):

**Intake** (`POST /claims/life-intake`): one transaction saves parties, a policy snapshot, the claim (`received`), benefit lines, four
requirements (one already met from our records), the first seven deadline rows (the mock's D-701 to D-707), history and an **outbox event**,
then returns `201`. No workflow has run. It stores an `Idempotency-Key`, so a retry cannot create a second claim.

**Outbox relay** starts `orch-<claimNumber>-intake`. The workflow id is the idempotency key: a second start is a no-op (`AlreadyStarted`).

**Intake orchestration** (`LifeIntakeWorkflow`): policies in force, sanctions (a timeout is retried and the run shows the step as *retried*),
duplicate claim; anything doubtful opens a task for a person. Otherwise route (LF-01 / LF-02), least-loaded examiner, acknowledgement, packets and
agent notice (each letter at most once per dedupe key), then **one final transaction** sets the claim to `gathering_evidence`.

**Dispatcher** (`DeadlineDispatcher`): a Temporal Schedule runs the dispatcher workflow every minute, which calls `DispatchDueAsync()`. One poll
is one transaction: select due `open` rows `FOR UPDATE SKIP LOCKED`, start `deadline-<id>` for each **inside that transaction**, mark them
`dispatched`, append a `deadline_attempts` line. A failed start leaves the row `open` with a backoff (`retry_after`) and the error recorded. Only
kinds that have a workflow are polled (today: `requirement_follow_up`).

**Requirement follow-up** (`RequirementFollowUpWorkflow`, `deadline-<id>`): re-check; skip if the requirement is already met; otherwise remind,
and **one transaction** marks this row `done` and `fired` and writes the next follow-up row. No timers, no waiting. Accepting or waiving a requirement
closes its waiting row.

**Proof of loss**: accepting the last requirement moves the claim to `in_review` and writes `decision_due` and `review_target` rows and a work
item, in the same transaction. Postgres only.

## The simple life claim, end to end

The natural-causes story of [`../docs/life-claim/README.md`](../docs/life-claim/README.md) (Robert Castellano, WL-0804419, $200,000, Diane and Mark 50% each, interest at 3.5% a
year from the date of death, decided by Rachel Kim within her $250,000 authority, above that approved by the team lead Monica Reyes, paid by the daily payment run, closed) runs on the
real stack. `SimpleLifeScenarioPostgresTests` plays it in one test; `./claims.sh demo up` lets you play it in the web app.

| Step | What happens | Where |
|---|---|---|
| Notice | one transaction: claim, parties, lines, requirements, deadline rows, history, outbox event | `POST /claims/life-intake` |
| Intake orchestration | checks, routing, letters, `gathering_evidence` | workflow `orch-<claim>-intake` |
| Evidence | each requirement accepted (or waived); a due follow-up sends a reminder; the welcome call is ticked off | `POST /requirements/{id}:accept`, dispatcher, `POST /work-items/{id}:complete` |
| Proof of loss complete | in the accept transaction: `in_review`, `decision_due` and `review_target` rows, the examiner's work item | `RequirementService` |
| **Decision** | one transaction: decision locked, payment items `cleared`, rows closed, `approved`, history, outbox | `POST /claims/{id}/decisions` |
| Approval (only above authority) | a team lead completes it; then the same transaction as above | `POST /decisions/{id}:approve` |
| Letters | approval letters (APR-LIFE-01 each), the rider explanation (ADB-LIFE-03), the agent (AGT-NOTE-02) | workflow `event-<decisionId>` |
| **Payment run** | claim cleared items (`in_run`), send the bank file, mark paid, close the claim | batch: `POST /payment-runs` or the daily trigger; **no Temporal** |
| Confirmations | payment confirmations (PAY-LIFE-01), the closing letter (CLS-LIFE-01), the agent (AGT-NOTE-03) | workflow `event-<outbox event id>` |

Claim status: `received`, `gathering_evidence`, `in_review`, (`awaiting_approval`), `approved`, `paying`, `closed` (`paying` and the V6 constraint are new).

By curl, against a running demo (`intake.json` is the Castellano body; `moves` are virtual-clock calls; `$LINE` is the base line's id from `GET /claims/$C`):

```
curl -X POST :8080/claims/life-intake -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d @intake.json     # 201, then poll until gathering_evidence
curl -X POST :8080/requirements/$R:accept -H "If-Match: \"$VERSION\"" -H 'X-Actor: rachel'                                    # for each open requirement; the last one completes proof of loss
curl -X POST :8080/dev/clock:advance -H 'Content-Type: application/json' -d '{"days":1}'                                        # or {"until":"next_deadline"}
curl -X POST :8080/claims/$C/decisions -H 'Content-Type: application/json' -H 'X-Actor: rachel' -H "Idempotency-Key: $(uuidgen)" \
     -d "{\"benefitLineId\":\"$LINE\",\"outcome\":\"approve\",\"basis\":\"In force, past contestable\"}"                   # 201; 202 above $250,000, then POST /decisions/$D:approve with X-Actor: monica
curl -X POST :8080/dev/clock:advance -d '{"days":1}' -H 'Content-Type: application/json'                                        # advance to the items' payOn date (the next business day): the daily run pays and closes the claim
curl :8080/claims/$C ; curl :8080/claims/$C/payment-items ; curl :8080/claims/$C/letters ; curl :8080/claims/$C/workflow-runs   # what happened
```

### Decisions and authority

`DecisionService` (Postgres only; no workflow runs inside the request). The examiner is the staff user named by `X-Actor` (`rachel`, `monica`; `GET /staff` lists them with their ids and limits).
The amount the authority check uses is proceeds plus interest to the pay date (the next business day after the decision, as the mock's `addBusinessDays(decide, 1)`); the rider
follows the base line: the accidental death rider that does not pay on a natural death is closed with its own `closed` decision and ADB-LIFE-03, one that pays is approved with it.

* **Within authority**: ONE transaction (the claim row is locked first, so two acts on a claim queue up). It locks the decisions (v1, immutable), writes one payment item per payee per line
  (`cleared`, `pay_on` the next business day), sets the benefit lines, closes `decision_due` and `review_target` (`done`, closed by `decision`) and skips `status_letter`, writes
  `payment_due` (2 business days), moves the claim to `approved`, completes the examiner's work item, writes the history, and writes the `decision_recorded` outbox event. If any statement
  fails, none of it happens: a test makes the outbox insert fail and asserts nothing survived, not even the idempotency key.
* **Above authority**: the decisions are recorded and locked as `awaiting_approval` (`requires_approval`), the claim becomes `awaiting_approval`, the team lead gets a work item, and nothing else
  happens: no items, no rows closed, no event, no letters. `POST /decisions/{id}:approve` by a team lead (not the recorder, whose own limit must cover the amount) then inserts an approval row
  per decision (a separate append-only table: the decision itself is never updated) and does exactly the within-authority transaction. Interest is recomputed to the pay date after the approval.
  Codes: `403 unknown_actor | approver_not_authorized | self_approval`, `409 claim_not_ready_to_decide | not_awaiting_approval`.
* **Immutable versions.** The database refuses `UPDATE` and `DELETE` on `decisions` and `decision_approvals`. `UNIQUE (benefit_line_id, version)` and `payment_items_once` stop a second decision or
  a second set of items. Idempotency: the same `Idempotency-Key` and body returns the same result (200, `Idempotent-Replayed`), the same key with another body is `409 idempotency_key_reuse`.
* Built: `approve`. Not built: `approve_in_part` and `deny` (`422 outcome_not_supported`: in the mock they go to a second reviewer) and corrections that supersede an earlier version
  (`422 correction_not_supported`); the schema (versions, `supersedes_id`) is ready for both.

### Payment items and the payment run

`PaymentRunService` is a plain batch. A run (`POST /payment-runs {runDate}` by hand, or the in-process daily trigger, `Claims:PaymentRun:*`; cron would call the same service in production) is:

1. **One transaction**: create the run and claim the items in one statement, `cleared` to `in_run` stamped with the run id, `FOR UPDATE SKIP LOCKED` (`PaymentRepository.ClaimClearedSql`); claims to `paying`.
2. Send the file to the bank (`IBankGateway`; the stub records a payment reference and can be told to fail or return an item). The payment item id is the bank idempotency key.
3. **One transaction**: items `paid` (with reference and business time) or `returned`; lines `paid`; every claim whose items are all paid is `closed` (`closed_at`, the `payment_due` row met, open work items done, history) and
   gets an `items_paid` outbox event for the confirmation workflow. If the bank cannot be reached the items go back to `cleared` and the run is `failed`.

Nothing here depends on Temporal (the tests run the payment run with no Temporal at all). **Paid items are never edited**: a trigger freezes money, payee, dates, links, run and reference of an
`in_run`/`paid`/`returned` item, lets a paid item only become `returned`, and makes `returned` final; a correction is a new item. The manual trigger is idempotent per run date by default (the key
defaults to `manual-<runDate>`; send an `Idempotency-Key` to force another run), and the scheduled run is unique per date (a partial unique index). A run's date cannot be in the future.
Holds: `POST /payment-items/{id}:hold` (only before a run; after it, `409 item_in_run` plus a recovery work item) and `:release`.

**The closing race, found by the concurrency test.** Two runs at once can each take one of a claim's two items. Each then looked at the claim after its own items were paid and saw the other's item still
`in_run`, so neither closed it. Now every transaction that touches several claims locks the claim rows first, in id order (`PaymentRepository.LockClaimsAsync`), so the later run sees the earlier run's paid item.
The test that caught it (12 claims, 6 simultaneous runs) failed 5 of 8 runs with the lock taken out and passed 12 of 12 with it.

### Event workflows

`DecisionRecordedWorkflow` (`event-<decisionId>`) and `PaymentConfirmedWorkflow` (`event-<outbox event id>`) are short: no timers, no signals. Execution timeout 1 hour, `AllowDuplicateFailedOnly`, the same activity
retry policy as the others (2 s initial, doubling, 30 s cap, 5 attempts). Every letter goes through `LetterService.SendOnceAsync` with a dedupe key per letter (`decision:<id>:approval:<party>`, ...), so a retried
activity or a second start sends nothing twice. Each records a `workflow_runs` row with the mock's steps ("Generate the approval letters", "Explain the rider outcome", "Deliver the way each beneficiary chose", "Tell the
agent of record"). When retries run out the run is `failed`, a work item is opened, and the workflow id can be started again. The launcher has one generic entry point, `StartEventAsync(EventStart)`, and
the outbox relay uses it for every event type that has a workflow (`EventWorkflows`), so the next event workflow is one more case (the four of the complex scenario, `document_received`, `document_rejected`,
`payment_returned` and `payment_method_updated`, are exactly that).

### Work items

Intake writes the welcome call; proof of loss complete writes "Record decision: <insured>" (the mock's queue item); an above-authority decision completes that item and writes "Approve payout above
authority" for the team lead; recording or approving completes what became obsolete; a returned payment and a refused hold write recovery items; closing the claim completes what is left. A person can
also complete one: `POST /work-items/{id}:complete` (`If-Match`; `409` when already done). Completing the welcome call meets the `first_contact_by` row, as the mock's "call logged".
The complex scenario adds: "Review the death certificate" (a photocopy went to a person), "Corrected W-9 needed" (a TIN mismatch), "Payment returned: Mark" (until his new account arrives), "Re-run <workflow id> once the cause is fixed" (a failed run: the last step opens it, a successful re-run closes it) and "Overdue: ..." (the nightly check; done when its row closes).

### The virtual clock

`IClock` is business time, and every business-time decision reads it: the dispatcher's due checks, deadline arithmetic, follow-up scheduling, interest, the payment run's cutoff and its scheduled date, and the timestamps
on letters, history, work items and workflow runs. In production it is real time. `VirtualClock` is real time plus an in-memory offset; it is also the `TimeProvider` (timers and delays stay real, so a 3 s poller still
waits 3 real seconds and then reads business time). Only the endpoints below move it, and only when `Claims:Dev:Controls=true` (Development or a demo; they are not mapped otherwise, and the host refuses to start with
them on in Production):

```
GET  /dev/clock                                          now, realNow, offsetSeconds, virtual, businessDate, zone
POST /dev/clock:advance {"days": 1} | {"until": "next_deadline"} | {"toIso": "2026-10-08T16:30:00Z"}     forward only; returns the new time and the deadlines due at it
POST /dev/clock:reset                                    back to real time
```

`due_at` rows are never edited: the dispatcher finds them due because the clock passed them (a test compares every row before and after). The Temporal Schedule ticks in real time, but its activity calls the dispatcher,
which reads the virtual now, so the Schedule fires exactly the rows the virtual date makes due. **Postgres `now()` column defaults still use real time** (`created_at`, `updated_at` on rows the app does not stamp
itself, `history_events.recorded_at`, the `touch_row` trigger). That is acceptable for the demo because those are audit columns, never compared with a business date; everything that is compared, shown as
"when it happened", or used to decide something is stamped from `IClock` explicitly (`history_events.occurred_at`, `letters.sent_at` and `created_at`, `workflow_runs`, `deadlines.closed_at`, `payment_items.paid_at`).
Two consequences to know: the offset lives in memory, so it resets when the API restarts (the demo starts from a fresh database every time), and a claim's `createdAt`/`updatedAt` show real time.

### Embedded Temporal for local runs

`Claims:Temporal:DevServer=true` starts a real Temporal dev server inside the API process before anything else (`WorkflowEnvironment.StartLocalAsync`; the SDK downloads the Temporal CLI on first use and
caches it, or use `DevServerPath` / `TEMPORAL_DEV_SERVER_PATH`), points the client, the worker and the dispatcher Schedule at it, and serves its UI on `DevServerUiPort` (default 8233). In memory unless
`DevServerDbFile` is set. It stops with the API. No Docker or Homebrew needed for Temporal. It is a local convenience only; a real environment uses the organisation's Temporal.

### The one-command demo

```
./claims.sh demo up      # Postgres (local 127.0.0.1:5432 with database claims_demo (re)created, else docker compose), the API, the web app
./claims.sh demo status
./claims.sh demo down    # stops only what demo up started (pid files in .demo/); the claims_demo database is kept until the next up
```

`demo up` starts the API in Development on port 8080 with `Dev:Controls`, the embedded Temporal dev server (gRPC 7233, UI http://localhost:8233), the dispatcher Schedule every 5 s (always on) and the nightly overdue check, waits
for `/actuator/health` and `/claims`, then starts the web dev server on http://localhost:5173 with `VITE_API_BASE=/api` and `DEMO_API_TARGET=http://127.0.0.1:8080` (the web's Vite proxy forwards `/api` to the API: no CORS).
It refuses to start if one of its ports is taken by something else and never touches a server it did not start. Ports and the database login are `DEMO_API_PORT`, `DEMO_WEB_PORT`, `DEMO_TEMPORAL_PORT`,
`DEMO_TEMPORAL_UI_PORT`, `DEMO_PG_HOST`, `DEMO_PG_PORT`, `DEMO_PG_USER`, `DEMO_PG_PASSWORD`. If no Postgres is reachable and Docker is off, it says exactly what is missing and starts nothing.

**The daily payment run and the bank-returns poller are OFF in the demo by default** (`Claims__PaymentRun__ScheduleEnabled=false`, which overrides Development's `true`), so the presenter decides when the batch runs: with the trigger on, the run pays
within seconds of the virtual clock reaching the pay date, before anyone can click "Run payment run now". Run the batch by hand with `POST /payment-runs` (`{"runDate":"2026-10-09"}`) and `POST /payment-runs/returns:process`. `DEMO_DAILY_RUN=true ./claims.sh demo up`
turns both triggers on (polling every 3 s). The dispatcher's Temporal Schedule stays on either way, and so does the overdue check (`DEMO_OVERDUE_CHECK=false` turns it off).

## The complex life claim: things bounce back

The same claim (Robert Castellano, WL-0804419, $200,000, Diane and Mark 50% each) as [`../docs/life-claim/README-back-and-forth.html`](../docs/life-claim/README-back-and-forth.html), where five things come back instead of going straight through. Every bounce is real:
driven through domain calls plus fault switches, with no scripted "play next". `ComplexLifeScenarioPostgresTests` plays all of it on real Postgres and Temporal's in-process server; the section "Verification" has the same story by curl against a running API.

The rules that hold on every bounce (they are the architecture's, checked by tests):

* **Every state change is saved in Postgres first**, in ONE transaction with its outbox event, and only then does a **short event workflow** (`event-<outbox event id>`, no timers, no signals, nothing waiting for a person) do the outside-system work. Waiting is a deadline row or a work item.
* **ID reuse policy `ALLOW_DUPLICATE_FAILED_ONLY`**: a completed or running id can never start again (a repeated outbox start is a no-op); a FAILED one can (an ops re-run).
* **Every letter goes through `LetterService.SendOnceAsync`** with an idempotency key, so a retried activity, a timed-out attempt and a re-run all send once.
* **Paid items are immutable.** A return is a NEW replacement item linked by `replacement_of_id`. **Batch jobs never change a claim**: the returns batch changes payment items and writes an event; a workflow does the claim side.
* **One retry policy**: 5 attempts, 2 s initial interval, x2, maximum 30 s (waits of 2, 4, 8, 16 s), StartToClose 30 s, as every other activity here.

### How each bounce maps

| | What happens | You call | Saved first (one transaction) | Workflow (`event-<outbox id>`) | Tables |
|---|---|---|---|---|---|
| **1** Fri 25 Sep · a worker stalls mid intake run | Step 9 (acknowledgement and packets) does its work and the worker never reports back; Temporal times it out and runs it again; nothing goes twice | `POST /dev/faults {"name":"worker.stall-once:LifeIntake_SendAcknowledgementAndPackets","count":1}`, then the notice as usual | the notice and its event (as before) | `orch-<claim>-intake`: attempt 2 of the step, `retried`, `attempts: 2`, a note | `workflow_runs` (`steps[].attempts`, `note`, `elapsed_ms`), `letters` (dedupe keys) |
| **2** 29 Sep · Diane's W-9 fails the IRS check | "No match" is an ANSWER: not enough, "TIN mismatch", a 7-day correction chase, a work item, a letter (W9-LIFE-01). The corrected W-9 (2 Oct) is just another document | `POST /dev/faults {"name":"tin.no-match","count":1}`; `POST /claims/{id}/documents` (`claimant_statement_w9`, `attributes.tin`) twice | the document, `document_received`, history, the idempotency key | `DocumentReceivedWorkflow`: Begin, `CheckTin` (returns data), then `MarkNotEnough` + `AskForCorrection`, or `Accept` (the normal accept path: follow-up rows close, proof of loss completes when it was the last one) | `documents`, `requirements.state_note`, `deadlines` (a `requirement_follow_up` chase: the unique index allows it because the row that waited is closed first), `work_items`, `letters` |
| **3** 1 Oct · a photocopied certificate | The rules cannot accept it: the requirement is `received` (under review), Rachel gets "Review the death certificate" and a `document_review_by` row (1 business day), and the workflow **ends** | `POST /claims/{id}/documents` (`death_certificate`, `attributes.photocopy: true` or `sealPresent: false`) | as above | `DocumentReceivedWorkflow` → `HandToPerson` (a certified original is accepted instead) | `documents` (`under_review`), `deadlines` (`document_review_by`), `work_items` |
| **3b** 1 Oct 15:20 · she rejects it, the letters service is down | Her decision is saved before any workflow. The letter workflow retries 5 times, fails, the run is recorded FAILED and its last step opens an ops task | `POST /dev/faults {"name":"letters.down","enabled":true}`; `POST /documents/{id}:review {"decision":"reject","reason":"..."}` (`If-Match`, `X-Actor: rachel`) | document `rejected`, requirement `requested` again, the old follow-up row and the review row closed, a new follow-up row (10 days), the work item done, `document_rejected` | `DocumentRejectedWorkflow` (REQ-LIFE-03, idempotency key `document:<id>:rejected`) | `workflow_runs` (`failed`, `error`, `note`), `work_items` (`workflow-failed:<workflow id>`) |
| **3c** 1 Oct 16:05 · ops re-runs it | Run 2 under the SAME workflow id; the letter goes exactly once; the ops task closes | `POST /dev/faults {"name":"letters.down","enabled":false}`; `POST /workflow-runs/{id}:rerun` (`X-Actor`) | nothing new: it re-reads Postgres | the same workflow again: `runNo: 2`, `rerunOfId` = run 1 | `workflow_runs` (`run_no`, `rerun_of_id`) |
| **4** 5 Oct · Mark is late | The dispatcher fires his follow-up: the only row that fires | the virtual clock reaches 08:00; the Schedule does the rest | (the dispatcher's transaction) | `deadline-<id>` (as before) | `deadlines` |
| **5** 13 to 20 Oct · the bank returns Mark's EFT | The payment run pays and closes the claim (13 Oct). The bank's returns file lists Mark's item (R02); the batch marks it returned and records a hold; a workflow reopens the claim, asks Mark, tells Rachel and writes the row waiting for his details; Mark's new account (19 Oct) creates the replacement item; the next run (20 Oct) pays it and the claim closes again | `POST /dev/bank/returns {paymentItemId, reasonCode:"R02", reasonText}`; `POST /payment-runs/returns:process`; `POST /claims/{id}/payees/{partyId}:update-payment-method`; `POST /payment-runs` (or the daily trigger) | batch: item `returned`, hold, `payment_returned`. New account: method, replacement item `cleared`, details row closed, reissue row, `payment_method_updated` | `PaymentReturnedWorkflow`, `PaymentMethodUpdatedWorkflow` (verifies the account, tells Mark), then `PaymentConfirmedWorkflow` (as before; its closing letter has its own key per close) | `payment_items` (`replacement_of_id`, `payment_method_id`), `payment_method_holds`, `payment_methods`, `claims.status = reopened` |

### New and changed endpoints

The contract is `api/openapi.yaml` (lint clean); a summary, with each one's transaction:

| Endpoint | What it does |
|---|---|
| `POST /claims/{id}/documents` | `Idempotency-Key`; body `{requirementId or requirementKey (+partyId), kind, source, receivedAt?, attributes:{tin?, photocopy?, sealPresent?}}`. 201 with the document (`received`) and `ETag`; a repeat returns it again (200, `Idempotent-Replayed`); the same key with another body is 409. Writes the document, `document_received`, history, the key. 422 `requirement_not_found`/`requirement_ambiguous`, 409 `requirement_already_met`/`claim_closed` |
| `GET /claims/{id}/documents`, `GET /documents/{id}` | the documents; `status`: `received`, `accepted`, `not_enough`, `under_review`, `rejected`; `statusNote`; `attributes.tinMasked` (the last 4 digits only); `workflowId` once the relay has started it |
| `POST /documents/{id}:review` | `{decision: accept|reject, reason}`, `If-Match`, `X-Actor` (a staff handle: `rachel`). Only a document `under_review` (else 409 `invalid_state`). Accept: requirement accepted through the normal path, no workflow. Reject: as in bounce 3b |
| `GET /workflow-runs?status=failed`, `POST /workflow-runs/{id}:rerun` | the operations view (`canRerun`), and the re-run: 202 `{workflowId, outcome: started|already_started, previousRunId}`; 409 `run_not_failed` / `run_not_latest`. Works for event, intake and deadline runs |
| `POST /payment-runs/returns:process` | the returns batch: `{readAt, read, processed:[{paymentItemId, claimId, payeeName, amount, returnCode, returnReason, outboxEventId}], skipped:[{paymentItemId, reason: not_found|not_paid|locked_by_another_batch}]}` |
| `POST /claims/{id}/payees/{partyId}:update-payment-method`, `GET /claims/{id}/payment-methods` | `Idempotency-Key`; `{kind:"eft", routingNumber, accountNumber, holderName?}`; 201 `{paymentMethod, replacementItems, reissueDeadline}`; 409 `no_returned_payment`. The methods and the holds |
| `POST /deadlines:check-overdue` | the nightly overdue check by hand: `{checkedAt, raised, alreadyRaised, items}` |
| `GET/POST /dev/faults`, `GET/POST /dev/bank/returns` | dev only (`Claims:Dev:Controls`): the switches and their log, and the stub bank's returns queue |
| changed | `GET /claims/{id}/workflow-runs` (and `/workflow-runs`): runs carry `runNo`, `rerunOfId`, `note`, `elapsedMs`, `canRerun`, and steps `attempts`, `note`, state `failed`. `Requirement.stateNote`; `Deadline.documentId`/`partyId`; `PaymentItem.replacedById`/`paymentMethodId`; `ClaimStatus` gains `reopened`; `DeadlineKind` gains `document_review_by` and `bank_details_by` |

### Fault switches (Development only)

`POST /dev/faults {"name": ..., "enabled": true|false}` or `{"name": ..., "count": N}`; `GET /dev/faults` lists what is on, what each fault did (`log`, in memory) and the known names. A fault is read and used up atomically (one lock: two
threads never both use the last unit), and unknown names are 422. Also settable at start-up with `Claims:Dev:Faults`.

| Name | What it does |
|---|---|
| `letters.down` | the letters gateway throws on every send attempt (with a count, each attempt is a use) |
| `tin.no-match` | the IRS check answers "no match" (data, not an exception); each check is a use with a count |
| `tin.down` | the IRS check fails like a 503, which Temporal retries |
| `worker.stall-once:<activity type>` | the first execution of that activity does its work and then hangs for `Claims:Dev:StallFor` (35 s), past its 30 s StartToClose timeout, exactly what a worker killed before it reported back looks like; Temporal times the attempt out and runs it again, and the run record gets a note. Implemented as a Temporal activity interceptor, so it works for any activity (`LifeIntake_SendAcknowledgementAndPackets`, `DocumentRejected_SendLetter`, ...) |
| `bank.down`, `bank.reject-next` | as before: the payment run fails and releases its items; the bank returns the next payment it is sent |

### The pieces

* **`DocumentReceivedWorkflow`** (`DocumentRules` picks the route: pure, unit-tested). W-9: the IRS check, then accept, or "not enough" with the correction chase, work item and letter. Certificate: a certified original is accepted; a photocopy (or no raised seal) goes to a person. Police report: accepted.
  Anything else goes to a person. Every branch ends the workflow. The stub IRS says "match" for nine digits and "no match" otherwise.
* **`DocumentRejectedWorkflow`**: the "certified copy needed" letter (REQ-LIFE-03). **`WorkflowFailureRecorder`** is what every one of these workflows does when its retries run out: one transaction that opens (or, for a re-run that fails again, re-opens) the ops work item, writes the
  history and finishes the run as `failed` with the steps so far and the "what Temporal did" note.
* **The re-run** (`WorkflowRerunService`) starts the same workflow through the launcher's normal entry points, from the same outbox event, under the same workflow id. The new run's `Begin` gives it the next `run_no` and links it to the failed run; when it succeeds it closes the ops task.
* **The returns batch** (`PaymentReturnsService`): reads the stub bank's returns queue, locks the paid items `FOR UPDATE SKIP LOCKED` (`PaymentRepository.LockPaidForReturnSql`), marks each `returned` (a trigger guarantees nothing else about it changes), records the hold, appends the history and writes `payment_returned`, all in one
  transaction; acknowledges to the bank only after the commit. A return for an unknown item is acknowledged and skipped; for an item that is not yet paid it is skipped and stays in the queue; for one already returned it is acknowledged and skipped. Also run daily by `PaymentReturnsPoller` (from 06:30 local).
* **`PaymentReturnedWorkflow`**: reopens the claim (`closed` to `reopened`, only while a returned payment still has no paid replacement; the benefit line goes back to `approved`), writes the `bank_details_by` row (10 days), a work item for the examiner and the letter to the payee (RTN-LIFE-01).
* **The new account** (`PaymentMethodService`): see the table. **`PaymentMethodUpdatedWorkflow`** asks the bank whether the account is open ("not verified" is an answer: the replacement is held and the examiner gets a work item) and tells the payee (RTN-LIFE-02).
* **Closing again.** The payment run closes the claim through the statement that closed it the first time (`reopened` is a status it may close from; a returned item that has a replacement is settled, one without still keeps the claim open). The confirmation workflow sends the closing letter; the second close has its own idempotency key.
* **Deadline kinds.** `document_review_by` and `bank_details_by` have no workflow, on purpose: a person's review and a payee's answer are not something a workflow can do for them. They are target rows that are closed by what they wait for, and **the nightly overdue check** (`OverdueCheckService`, a batch; hosted
  service `OverdueCheckPoller`, or `POST /deadlines:check-overdue`) raises them, and every other open row past due whose kind no workflow fires, to the claim's owner with a work item and a history line, **once per row** (`FOR UPDATE OF d SKIP LOCKED`; the work item's dedupe key is the row id; a trigger marks it done when the row closes).
  It ignores closed claims and the kind the dispatcher fires. The welcome call already closes `first_contact_by` (`POST /work-items/{id}:complete`), which is tested to keep the check quiet. The reissue row is a `payment_due` row (`sla: reissue`) that the payment run closes.

### The figures and the counts, against the mock

| | Mock (`lifeFlow.ts`, the scenario page) | Here |
|---|---|---|
| Interest | `interestFor(200000, 24 days)` = $460.27 (19 Sep to 13 Oct); `split` gives the last payee the rounding | $460.27: Diane $230.13, Mark $230.14 (`PaymentRules`, the same functions; a test checks the mock's own formula) |
| Paid 13 Oct | Diane $100,230.13, Mark $100,230.14, 2 EFTs, claim closed | the same |
| Mark's payment returned 15 Oct (R02) | item returned, the replacement for the same amount | returned, kept as it was; replacement `100000.00 + 230.14 = 100230.14`, `replacement_of_id` |
| Replacement paid | Tue 20 Oct, $100,230.14 | Tue 20 Oct, $100,230.14 |
| **Final total** | $200,460.27 (the mock sums the payments not marked returned) | **$200,460.27** = $100,230.13 + $100,230.14; no difference |
| Workflow runs | 14: 1 failed, run 2 under the same id | **14** (13 completed, 1 failed, run 2 of it completed): 1 intake, 1 deadline, 12 event runs (11 event workflow ids) |
| Deadline rows | 16: 1 fired, 1 skipped, 14 closed without firing | **16**: the same split (D-707 fires; the status letter is skipped at the decision) |
| Closes | 2 (13 Oct, 20 Oct) | **2** (one "Claim closed" history line per close, one "Claim reopened") |
| Letters | one per idempotency key; none twice | 19 letters for the whole claim, every dedupe key once, none queued or failed at the end |

### Deviations from the mock, and choices

* **The payee's window for new bank details is 10 days** (row due Sun 25 Oct, the mock's D-715), not 4. The mock's code (`addDays(today, 10)`), its deadline table and `docs/life-claim/README.md` say 10; the scenario page's prose says Mark "waited four days" (15 to 19 Oct), which is how long he took, not the limit. With a 4-day limit the row would be 12 hours late
  when he answers and the nightly check would flag it. It is one constant (`PaymentReturnEventService.PayeeDetailsDays`).
* **The reissue target row (2 business days, Wed 21 Oct) is written by the transaction that saves the new account**, not by `PaymentReturnedWorkflow`: the service level runs "from new bank details", which are not known when the claim reopens.
* **The payment run, a batch, still closes the claim** in its own transaction (as in the simple scenario, which is tested that way); the confirmation workflow sends the closing letter, the confirmations and the agent notice. The mock has the confirmation event close it. Reopening is the workflow's job, as the design says.
* **The replacement item is created when the new account is saved** (one transaction: saved first), and `PaymentMethodUpdatedWorkflow` then verifies the account and can hold the item; in the mock the workflow creates the item after verifying.
* **Fewer, real steps.** There is no document store, classifier or e-signature service, so the runs do not show "Store the file", "Classify" or "Check the signature"; the first step is "Read the document" (the kind the sender declared). Run steps describe what really happened.
* **Letter codes**: REQ-LIFE-03 (certified copy needed; the mock's CRT-LIFE-01), W9-LIFE-01, RTN-LIFE-01 and RTN-LIFE-02 (the mock's), CLS-LIFE-01 and PAY-LIFE-01 as before.
* **Workflow ids are `event-<outbox event uuid>`**, not `event-E-9004`; the run list says what each one is. The stub IRS answers "match" for a nine-digit number; the stub bank's account check says "closed" for an account ending 0000.
* **The wire type of one activity changed**: `LifeIntake_SendAcknowledgementAndPackets` returns `{sent, attempts, elapsedMs}` instead of an int, so it can show the retry. The Java workers return an int: the two backends can no longer serve the same task queue for the intake workflow (the schema had already diverged since V6).
* **"Ops" is any `X-Actor` label** (authentication is not built); it is written to the history.
* **The bank's returns queue is the stub's, in memory** (lost when the API restarts, like the virtual clock's offset). A real bank's returns file is read through `IBankGateway.ReadReturnsAsync`.
* **Only the last four digits of a routing or account number are kept**, so the stub bank verifies from those (a real client would pass a vault token). The TIN is kept for the check and shown masked.

### What is not built

`approve_in_part` and `deny`; correcting a decision; a real letters service, IRS client, bank client and document store; a service-level and swimlane projection (`getFlow`); a workflow for `bank_details_by` (a reminder to the payee) or any other row kind that has none, beyond the nightly check; more than one returned item per payee
processed in one go is supported but only the one-payee case is exercised end to end; a payee's default account for future decisions (a new account applies to the replacement, not to later claims); reopening a claim for any reason other than a returned payment; portal accounts and authentication; a Temporal Schedule around the overdue check; the competing-claimant,
interpleader, evidence-never-arrives and late variations of the mock (the overdue check is the piece of "late" that exists).

## Mock to backend

| Mock function (`web/src/api`) | Endpoint / workflow / table |
|---|---|
| `submitLifeIntake` (`POST /intake/life/{draftId}:submit`) | `POST /claims/life-intake` → `LifeIntakeService.SubmitAsync`; tables `claims`, `life_claim_details`, `claim_parties`, `parties`, `policies`, `benefit_lines`, `requirements`, `deadlines`, `history_events`, `outbox_events`, `idempotency_keys` |
| `requirementSet`, `slaPreview` (rules) | `LifeIntakeRules.RequirementSet` / `FirstDeadlines` (pure, unit-tested) |
| `routeLife` (rules LF-01, LF-02) | `LifeIntakeRules.RouteFor`, run by the intake workflow's `route` step |
| `lifeChecks`, the orchestration's steps in `startLifeFlow` | `LifeIntakeWorkflow` (`orch-<claimNumber>-intake`); rows in `workflow_runs`, `letters`, `work_items` |
| `getLifeIntakeContext`, `lifeDraftFromContext` (`GET /intake/life/context`, drafts) | Not built. The request carries the policy and designation snapshot; drafts stay in the client |
| `getClaim`, `listClaims`, `searchClaims` | `GET /claims/{id}`, `GET /claims` (filters, keyset pagination); free-text search not built |
| `getFlow` (`GET /claims/{id}/workflow`) | Split: `GET /claims/{id}/deadlines`, `/workflow-runs`, `/history`. Service-level and swimlane projections not built |
| `listRequirements` | `GET /claims/{id}/requirements`, `GET /requirements/{id}` |
| `markReceived`, `satisfyRequirement`, `waiveRequirement` | `POST /requirements/{id}:accept`, `:waive` → `RequirementService` |
| `onFollowUp` (`deadline-D-707`) | dispatcher + `RequirementFollowUpWorkflow` + `FollowUpService` |
| `proofComplete` | `RequirementService.AfterMetAsync` (Postgres only) |
| `getQueue` (`GET /work-items?owner=&status=open`) | `GET /work-items` |
| `listHistory`, `logEvent` | `GET /claims/{id}/history`; `HistoryRepository.AppendAsync` (append-only table) |
| `listCommunications`, `addCommunication` (outbound) | `GET /claims/{id}/letters`; `LetterService.SendOnceAsync` |
| deadline extension (a row update in the docs) | `POST /deadlines/{id}:extend` |
| `playNext`, `startLifeFlow`'s scripted "happenings" | None. Mock only: replaced by the real dispatcher, outbox relay and the clock |
| `recordDecision`, `onDecide`, `approve` | `POST /claims/{id}/decisions` (approve; 201, or 202 above authority), `POST /decisions/{id}:approve` → `DecisionService`; tables `decisions`, `decision_approvals` |
| `schedulePayment`, `onPayRun` | items written by the decision transaction (`cleared`); `GET /claims/{id}/payment-items`, `:hold`, `:release`; `POST /payment-runs` and the daily trigger → `PaymentRunService` (a batch, not Temporal) |
| `markReleased`, `closeClaim` (the mock's demo buttons) | Not needed: the payment run marks items paid and closes the claim itself |
| `completeWork` | `POST /work-items/{id}:complete`, and as a side effect of decisions, approvals and closing |
| the mock's clock (`TODAY`, `f.now`) | `IClock` and the `/dev/clock` endpoints |
| `interestFor`, `split`, the approve step's letters (APR-LIFE-01, ADB-LIFE-03, AGT-NOTE-02), payment confirmations (PAY-LIFE-01, CLS-LIFE-01) | `PaymentRules`, `DecisionPlan`, `DecisionRecordedWorkflow`, `PaymentConfirmedWorkflow` |
| `onCall` | Partly: completing the welcome-call work item meets `first_contact_by`; no call log |
| `onArrive` (document event workflow), `onTinMismatch`, `onPhotocopy` | `POST /claims/{id}/documents` + `DocumentReceivedWorkflow` (`DocumentService`, `DocumentEventService`, `DocumentRules`); tables `documents`, `deadlines`, `work_items`, `letters` |
| `onDocReview` (the examiner rejects the photocopy, the letter fails) | `POST /documents/{id}:review` + `DocumentRejectedWorkflow`; `WorkflowFailureRecorder` |
| `onOpsRerun` (run 2 under the same id) | `POST /workflow-runs/{id}:rerun` → `WorkflowRerunService`; `workflow_runs.run_no`, `rerun_of_id` |
| `onBankReturn` | `POST /dev/bank/returns` (the stub bank's returns file) + `POST /payment-runs/returns:process` (`PaymentReturnsService`, a batch) + `PaymentReturnedWorkflow` |
| `onNewAccount` | `POST /claims/{id}/payees/{partyId}:update-payment-method` (`PaymentMethodService`) + `PaymentMethodUpdatedWorkflow`; the payment run and `PaymentConfirmedWorkflow` close the claim again |
| `RunStep` with `state: 'failed'`, `WorkflowRun.temporal` ("What Temporal did"), `took` | `RunStep.Attempts`/`Note`, `workflow_runs.note`/`elapsed_ms`/`run_no`/`rerun_of_id` on `GET /claims/{id}/workflow-runs` |
| the bounce script's fixed order (`bounceScript`, Play next) | None: each bounce is a call, a fault switch and the virtual clock |
| `onStatusLetter`, `logCallOutcome` | Not built |

The operations marked `x-slice-status: implemented` in the contract: the original 15 (`createLifeClaim`, `listClaims`, `getClaim`, `listClaimRequirements`, `getRequirement`, `acceptRequirement`, `waiveRequirement`,
`listClaimDeadlines`, `listDeadlines`, `getDeadline`, `extendDeadline`, `listClaimLetters`, `listClaimHistory`, `listWorkItems`, `listClaimWorkflowRuns`) and, new: `listClaimDecisions`, `recordDecision`, `getDecision`,
`approveDecision`, `listClaimPaymentItems`, `holdPaymentItem`, `releasePaymentItem` (added to the contract), `listPaymentRuns`, `startPaymentRun`, `getPaymentRun`, `completeWorkItem`, `listStaff` (added), and the
`dev` tag's `getDevClock`, `advanceDevClock`, `resetDevClock` (`x-dev-only`); and, for the complex scenario, `listClaimDocuments`, `receiveDocument`, `getDocument`, `reviewDocument`, `listWorkflowRuns`, `rerunWorkflowRun`, `processBankReturns`,
`listClaimPaymentMethods`, `updatePayeePaymentMethod`, `checkOverdueDeadlines` and the `dev` tag's `getDevFaults`, `setDevFault`, `getDevBankReturns`, `enqueueDevBankReturn`. No operation is `contract-only` any more. (`GET /actuator/health` is also served, as Spring Boot's actuator did.)

## Deviations from the mock's shapes

Identical to the Java version, because the contract is: UUID ids plus a display `claimNumber`; money as decimal strings; RFC 3339 UTC timestamps and
08:00-local deadlines in a configured business zone; snake_case enums; presentation fields dropped from resources; requirement states
`requested | received | accepted | not_enough | waived | expired`; `received` claim status; intake as one call; `actorKind` + `actor`; `ETag` /
`If-Match` (412 stale, 428 missing); `Idempotency-Key`; `application/problem+json` with a stable `code` (422 well formed but invalid, 400 unreadable,
409 state or key conflict); `{items, nextCursor}` collections with keyset pagination on claims and history; outbound communications become letters.
The reasoning for each is in `../backend/README.md`.

Where the simple-scenario engine differs from the mock's (`web/src/api/lifeFlow.ts`, `payments.ts`, `decisions.ts`):

- **Interest** is `decimal` (the mock's floating point agrees except within a float's error of half a cent) and, for a claim with a payable rider, is computed per line and split by share; the mock computes it once on the
  total and splits it. The two agree unless line rounding differs by a cent. For the natural-causes story the figures are identical ($383.56, $191.78 each).
- **The pay date** is the next business day after the decision, computed at the time of the decision (or of the approval, when a team lead approves later). The mock fixes it from a script.
- **An approval above authority is a decision row from the start** (`awaiting_approval`, locked) and the approval is a separate append-only row, so the decision is never updated. The mock only creates the decision
  when the team lead approves. There is one decision per benefit line, in one group; the rider's closed decision is written with the base's.
- **`approve_in_part` and `deny`** are not built (the mock sends them to a second reviewer); corrections are not built. The mock's `pend` outcome does not exist.
- **The payment run pays per item** (one per payee per line, `payment_items_once`), where the mock combines lines to one EFT per payee. A bank file could still combine them.
- **The mock's demo buttons** (`markReleased`, `closeClaim`) do not exist: the payment run marks items paid and closes the claim.
- **Claim status** has `paying` (items in a run) between `approved` and `closed`; the mock keeps "Approved · paying" as one state.
- **Two letter codes are new**: AGT-NOTE-03 (the agent, when paid or closed) and REM-LIFE-01 (already in the intake slice); APR-LIFE-01, ADB-LIFE-03, AGT-NOTE-02, PAY-LIFE-01 and CLS-LIFE-01 are the mock's. The mock's APR-LIFE-02 (a held share) is for the competing-claimant path, not built.
- **Work item text** uses ":" where the mock uses a dash ("Record decision: Robert Castellano"), as the rest of this slice does.
- **`POST /payment-runs` is synchronous** (201 with the finished run), where the contract had sketched 202 "building"; a real bank file would make it asynchronous.

## Java to .NET differences

Things that behave differently, or that a reader of the Java code would look for and not find:

- **Transactions.** Spring's `@Transactional` and `TransactionTemplate` become one explicit call, `Db.InTransactionAsync(...)`. Inside it every repository
  call, from any class, uses the same connection and transaction (an `AsyncLocal` carries it); a nested call joins the outer one, which is Spring's
  REQUIRED; any exception rolls back. Outside it each call takes a pooled connection and autocommits, as `JdbcClient` did. There is no annotation to forget:
  a service that must be atomic says so in code. Everything is `async`/`await`, so a transaction does not pin a thread while it waits on Temporal.
- **Data access.** Dapper runs the statements (parameters are `@name`, not `:name`; the SQL is otherwise the Java text, including `FOR UPDATE SKIP LOCKED`,
  the partial-index queries, `ON CONFLICT`, `cast(@x as text[])` with the same array-literal trick, and `pg_advisory_xact_lock`). Rows are read with small
  explicit mappers (`DbRow`), the equivalent of the Java `(rs, n) -> new View(...)` lambdas, because Npgsql hands back `DateTime` for `date` and `timestamptz`
  columns and Dapper's constructor mapping does not bridge that to `DateOnly` and `DateTimeOffset`. Single-column results (`Guid`, `string`, `int`) use Dapper's own mapping.
  `SELECT c.*, d.*` in `ClaimQueries.claim` became explicit columns.
- **Migrations.** DbUp instead of Flyway. **No SQL had to change**: `V1` to `V5` and the dev seed are byte-for-byte the Flyway files (verified with `cmp`). `V6` is new in this port (decision approvals and grouping,
  the `paying` claim status, payment item and run columns, a stricter payment item guard), so a database is no longer interchangeable with the Java backend's.
  What is different: DbUp's journal table is `schemaversions` (Flyway's was `flyway_schema_history`), so a database Flyway already migrated is not adopted; use a fresh
  database, or insert the five names into `schemaversions` by hand (not tried). DbUp does not validate checksums of applied scripts, as Flyway did, so an edited
  old script goes unnoticed. DbUp orders scripts by name, ordinally: `V10` would sort before `V2`, so keep zero-padded names (or add a comparer) from the tenth script on.
  DbUp variable substitution is switched off because the scripts hold `$$` function bodies. Each script runs in its own transaction, as with Flyway. The dev seed
  (Flyway's repeatable `R__` file) runs on every start when `Claims:Db:DevSeed` is true; it is idempotent, so that is equivalent. Its header comment still mentions
  Spring's `spring.flyway.locations`, because the file is unchanged.
- **JSON.** System.Text.Json instead of Jackson, configured to write the same thing: camelCase, nulls written, timestamps as `2026-09-25T15:03:00Z`
  (a converter reproduces `Instant`'s 0, 3, 6 or 9 fraction digits), `&` not escaped. **Enums never cross JSON in either version** (the views and Temporal payloads carry
  the snake_case strings), so there is no enum casing to differ; the C# enums are PascalCase and `EnumText` maps them to the database strings.
  On input System.Text.Json is case-insensitive for property names (`{"Caller": ...}` is accepted; Jackson ignored it). Temporal payloads use the same camelCase JSON, so
  histories written by either backend deserialize in the other.
- **Validation.** Bean Validation annotations became one hand-written `LifeIntakeValidator`: the same rules, the same `422 validation_failed` and field paths
  (`policies[0].faceAmount.amount`), messages modelled on Hibernate's and not identical, a deterministic error order (Hibernate's was unspecified), and a `null` list
  element is a 422 instead of a `NullPointerException`. A missing required date or share is a validation error, not a parse error, so the DTOs use `DateOnly?` and `decimal?`.
- **ETag and If-Match.** Same format (`"3"`), same rules (428 missing, 412 stale, `W/` accepted). Set by hand instead of `ResponseEntity.eTag()`. Spring also answered a
  `GET` whose `If-None-Match` matched with `304`; that is reproduced (and tested) here, but from Spring's documented behaviour: the Java app was not run to compare.
- **Request idempotency hash.** SHA-256 of the canonical JSON of the request, as before, but the serialization differs from Jackson's, so `idempotency_keys.request_hash`
  values written by the Java backend do not match .NET's for the same body. If both backends ever share a database, a replayed key created by the other one is `409 idempotency_key_reuse`.
- **Errors Spring turned into 500s.** Spring's catch-all `@ExceptionHandler(Exception.class)` also caught framework exceptions, so a non-UUID in a path, a non-numeric `limit`, an
  unknown route or a wrong method looked like an `internal_error` (by reading; the Java app was not run). Here they are `404 not_found`, `400 malformed_request`,
  `404 not_found` and `405 method_not_allowed`, always problem+json. A cursor with a valid timestamp and a bad tie-breaker is `400 invalid_cursor` (a 500 in Java).
- **Startup order and resilience.** The Java `ApplicationRunner` that created the Schedule failed startup when Temporal was unreachable, and the Java worker did not; here
  both retry in the background (10 s) and the API, the outbox poller and the dispatcher poller stay up. Migrations run before the host starts listening, as Flyway did
  during context start. The Temporal client is created lazily and the worker connects itself (a lazy client is refused by the SDK for workers).
- **Background work.** Spring `@Scheduled(fixedDelay)` became `BackgroundService` loops with a fixed delay after each pass (the first pass runs at once, as in Spring).
  They are always registered and switch themselves off from their `Enabled` options, so a test host can change the options after the container is built.
- **Configuration.** `claims.*` is `Claims:*`; durations are `TimeSpan` text; the six operational environment variables are aliases onto it (`Config/ClaimsOptions.cs`).
  `MaxBatchesPerRun` exists, like the Java property, and, like it, is not read (see the next section).
- **Domain time.** `Clock` became `TimeProvider`; `ZoneId` became `TimeZoneInfo` (IANA ids work on macOS and Linux, and on Windows with ICU); the DST rules for "08:00 local" are
  written to match `java.time` (a time in a spring-forward gap moves forward, an ambiguous one takes the earlier offset). The reminder timestamp in `deadlines.result` is
  formatted with the invariant culture (Java used the JVM's default locale).
- **Testing.** xUnit v3 instead of JUnit 5 (`[PostgresFact]` instead of `@RequiresPostgres`); `WebApplicationFactory` hosts the API instead of `MockMvc`/`@SpringBootTest`, so the HTTP
  tests go over the real pipeline (routing, middleware, JSON); `WorkflowEnvironment.StartTimeSkippingAsync` instead of `TestWorkflowEnvironment`; the flow test's steps run in order through
  a small `[Order]` orderer. The Schema test checks `schemaversions` where Java checked `flyway_schema_history`. Fake activities are separate classes registered under the real
  activity names (the .NET SDK has no activity interfaces to implement).

## Issues found in the Java code while porting

Found by reading it, then either carried over faithfully (parity was the brief) or fixed in this port as listed under "Java to .NET differences". Nothing in `../backend` was changed.

- **Carried over.** `claims.dispatcher.max-batches-per-run` is declared and never read: the dispatcher workflow hard-codes 20 polls per run (here too).
- **Carried over.** A designation with only contingent beneficiaries (no primary at all) makes `LifeIntakeRules.requirementSet` throw (`findFirst().orElseThrow()`; `First` here), so the API answers
  `500 internal_error` instead of a 422. Reproduced in this port; the transaction rolls back, so nothing is saved.
- **Carried over.** If every requirement is accepted while the claim is still `received` (before the intake workflow's final step), proof of loss is never completed: `afterMet` does nothing for a
  `received` claim and `completeSetup` does not look again, so the claim ends up `gathering_evidence` with nothing left to chase and no decision clock.
- **Not carried over.** Framework errors (bad path id, bad query value, unknown route, wrong method) and a cursor with a bad tie-breaker were `500`s; the reminder text used the JVM's default locale.
- **Behaviour changed.** The Java Schedule registrar failed application startup when Temporal was unreachable (the Java worker did not); here the registrar and the worker both retry in the background.

## Workflow code is replayed

Workflows use only Temporal workflow APIs (`Workflow.ExecuteActivityAsync`), no `ConfigureAwait(false)`, and everything with a side effect is an activity. The Temporalio
package has **no workflow analyzer** (its nupkg ships none), so determinism is guarded two ways: `BannedSymbols.txt` (Microsoft.CodeAnalysis.BannedApiAnalyzers, an error
in every build) bans `DateTime.Now/UtcNow`, `DateTimeOffset.Now/UtcNow`, `Guid.NewGuid`, `Random`, `Task.Run`, `Task.Delay`, `Task.WhenAny`, `Task.Yield`, `Thread.Sleep` and `ConfigureAwait(bool)`
for the whole assembly (the only exception is the sanctions stub's `Guid.NewGuid`, with a `#pragma` and a reason); and `WorkflowReplayTests` replays a recorded run of the intake
workflow against the current code. The guard was checked by putting each banned call into a workflow file and confirming the build failed, then removing it.

Wire names are the Java ones and are pinned by `WireNamesTests`: workflow types `LifeIntakeWorkflow`, `RequirementFollowUpWorkflow`, `DeadlineDispatcherWorkflow`; activity types
`LifeIntake_Begin`, `LifeIntake_CheckPolicies`, `LifeIntake_ScreenParties`, `LifeIntake_FindDuplicateClaims`, `LifeIntake_Route`, `LifeIntake_SendAcknowledgementAndPackets`,
`LifeIntake_TellAgent`, `LifeIntake_CompleteSetup`, `LifeIntake_HoldForReview`, `LifeIntake_RecordFailure`, `RequirementFollowUp_Begin`, `_SendReminder`, `_CompleteFollowUp`, `_Skip`,
`_RecordFailure`, `Dispatcher_DispatchDue` (the prefixes are the fix for the colliding `Begin` / `RecordFailure` method names). The event workflows added since (they are ours, not the Java version's) are pinned too:
`DecisionRecordedWorkflow`, `PaymentConfirmedWorkflow`, `DocumentReceivedWorkflow` (`DocumentReceived_Begin`, `_CheckTin`, `_Accept`, `_MarkNotEnough`, `_AskForCorrection`, `_CompleteNotEnough`, `_HandToPerson`, `_RecordFailure`), `DocumentRejectedWorkflow`
(`DocumentRejected_Begin`, `_SendLetter`, `_Complete`, `_RecordFailure`), `PaymentReturnedWorkflow` (`PaymentReturned_Begin`, `_Reopen`, `_AskForNewAccount`, `_Complete`, `_RecordFailure`) and `PaymentMethodUpdatedWorkflow`
(`PaymentMethodUpdated_Begin`, `_VerifyAccount`, `_Confirm`, `_Reject`, `_Complete`, `_RecordFailure`). Workflow ids `orch-<claimNumber>-intake` and
`deadline-<id>`, the Schedule id `claims-deadline-dispatcher` and its workflow id `deadline-dispatcher`, and the letter and work-item dedupe keys are the same as well.

## Not built yet

What `../backend/README.md` lists, minus what the simple and the complex scenarios built (decisions with authority, payment items and the payment run, the decision and payment event workflows, documents and their review, the IRS check, ops re-runs, bank returns, replacement items, reopening, the nightly overdue check).
Still not built: approving in part, denying, correcting a decision; a real letters service; deadline workflows for the kinds that have none (`status_letter`, `first_contact_by`, `acknowledge_by`/`forms_by` fallback, `decision_due`, `review_target`, `payment_due`, `document_review_by`, `bank_details_by`: their rows are written and stay `open`
until something closes them, as the decision, the welcome call, the payment run, a review and the payee's new account do, and the nightly check raises the late ones to a person); finding and finishing a payment run that died between sending the file and recording the answer (items stay `in_run`, the run `building`); a persisted virtual clock
and a persisted stub returns queue; the files themselves (documents are rows with attributes: no object storage) and real policy administration, sanctions, IRS and bank clients (interfaces plus stubs); contestable review, minor beneficiary hold, competing claimants, death abroad, rescission,
requirement expiry, waive-and-close-incomplete; portal and authentication (`X-Actor` is a placeholder); the state rules table and product configuration by effective date; assignment beyond
"fewest open claims"; party matching; and operational hardening (metrics, alerting, Temporal Worker Versioning, replay tests over real histories in CI, load testing, database grants).
Also not built here: Temporal TLS / API-key options (a place is marked in `TemporalSetup.cs`), and a contract test that live responses conform to the OpenAPI schemas (a script that does it was run by hand: see Verification).

## Verification

### Follow-up fixes: letters, actors, demo defaults, decision totals

* **A queued letter is never left behind by a re-run.** Run 1 of `DocumentReceivedWorkflow` can queue the W9-LIFE-01 letter ("please correct your W-9") and fail before it is sent (the letters service is down). A later re-run under the same workflow id reaches the same end state a first run would
  have reached: if the IRS still says "no match" it SENDS that same letter (same row, same key `document:<id>:correction`); if the number matches now it accepts the W-9 and marks the queued letter `skipped` (`letters.status = 'skipped'`, `status_reason` says why, one history line "Letter skipped: W9-LIFE-01",
  a line in the run's `saved`). The skip is one guarded UPDATE (`status IN draft/queued/failed`), so it is idempotent and never touches a letter that was sent, and `SendOnceAsync` never sends a skipped letter. New migration `V8__letters_skipped.sql` (widens `letters_status_ck`, adds `letters.status_reason`; it rewrites no row).
  API: `Letter.status` gains `skipped`, and `Letter.statusReason` is new (null otherwise).
* **History actors are named one way.** `HistoryRepository` is the only writer of `history_events.actor`: for `actorKind: user` a handle that is an active staff user of `/staff` (any case) is written as the display name ("Rachel Kim"), any other handle as typed ("examiner.dev" when `X-Actor` is absent, "ops.dev"),
  and system / workflow / batch / portal labels are untouched. `actorKind` is unchanged. Existing rows are not rewritten (history is append-only); events written before this change may still carry a raw handle.
* **Decision totals.** Each `Decision.amount` covers only its own line (the rider is a decision of its own). `GET /claims/{id}/decisions` (already an object `{items, nextCursor}`) gains `claimTotal`: the Money sum of the counting decisions (`in_effect` or `awaiting_approval`, not a superseded version), null when none has an amount; it follows `asOf`.
* Tests added: `DocumentPostgresTests` (2: the letter is skipped with a reason and stays skipped; a sent letter is never skipped and a re-run that still gets "no match" sends the queued one), `DocumentRerunLetterPostgresTests` (2, real activities on Temporal's time-skipping server: run 1 fails with the letter queued, run 2 skips it / sends it),
  `BounceWorkflowTests` (1: run 2 goes down the accept path and asks for nothing), `HistoryActorPostgresTests` (3), `DecisionPostgresTests` (1: `claimTotal`).

### The complex scenario, "things bounce back" (this task)

Run with the .NET SDK 10.0.401 on macOS (arm64), against a throwaway PostgreSQL 18.6 cluster on port 55434 (the machine's own server was not touched) and, for the live run, the embedded Temporal dev server (CLI 1.9.1, server 1.32.0) on port 27234.

- `dotnet build`: 0 warnings, 0 errors, Debug and Release, from a clean tree (`bin` and `obj` removed).
- `dotnet test` with `TEST_PG_URL=jdbc:postgresql://127.0.0.1:55434/postgres`: **174 run, 174 passed, 0 failed, 0 skipped** (repeated: every run green; the end-to-end test alone takes about 65 s, the rest of the suite about 5 s). Without `TEST_PG_URL` and with no Docker daemon:
  **174 run, 83 passed, 0 failed, 91 skipped** (all `REQUIRES POSTGRES/DOCKER`). The 104 tests that existed are unchanged and green (two edits to old files: `FakeLifeIntakeActivities` returns the new `SendOutcome`, and `DevSafetyTests` got a tolerance for two reads of the machine clock
  that made it fail about one run in twenty on its own; the dev-endpoints-off test now also asks for the new dev routes).
- **Negative controls** (each one edit, the named tests fail, the edit is reverted):
  the returns batch's `FOR UPDATE OF pi SKIP LOCKED` without `SKIP LOCKED` (`ARowAnotherBatchHoldsIsSkipped...` fails after Npgsql's 30 s command timeout; the in-test control shows the same statement blocking with `55P03`);
  the payment run's claim statement without the hold check (`TheRunLeavesItemsThatPayToTheClosedAccountAlone...` fails: the stray item is paid);
  the close statement without "a returned item that has a replacement is settled" (`ThePaidReplacementClosesTheClaimAgain...` and the run test fail: the claim never closes again);
  letters without their idempotency key (three tests fail: duplicates); the worker without the fault interceptor (the end-to-end test fails at step 9: `done`/1 attempt where `retried`/2 was expected).
  The pairs of workflow tests are the control for "a no-match is an answer": the IRS check that answers "no match" is called once, the one that fails with a 503 is called three times.
- `npx @redocly/cli lint api/openapi.yaml` (2.55.0): valid, no warnings. The contract was written first, before any code. A script (not part of the suite: `ajv` over the bundled contract) checked the bodies of the live run below, 131 of them (claims, documents, requirements, deadlines, payment items and methods and holds, workflow runs incl. the failed
  list, letters, history, work items, fault switches, the returns batch, the new-account result, a bank return): **0 differences**.
- **The API run for real** (Development, `Claims:Dev:Controls`, the embedded Temporal dev server, the dispatcher's Schedule every 5 s, the daily triggers every 3 s, the overdue check every 5 s), the whole story by curl against the virtual clock and the fault switches, from an empty database:
  the intake run took 32.1 s with step 9 `retried` (attempts 2, "the first attempt did not report back ... after 32 s"), the four letters once each; Diane's W-9 got "TIN mismatch" (one IRS check, no retry) and the corrected one was accepted; the photocopy went to Rachel; her rejection with `letters.down` on failed the run
  after 30.1 s (5 attempts), opened the ops task, and `POST /workflow-runs/{id}:rerun` ran run 2 under the same workflow id (REQ-LIFE-03 sent once, task closed); Mark's follow-up was fired by the Schedule (the only row); proof of loss completed on Fri 9 Oct; decided Mon 12 Oct; the daily trigger paid Tue 13 Oct ($100,230.13 and $100,230.14, closed);
  the bank return (R02) was processed by `returns:process` (the claim stayed closed until `PaymentReturnedWorkflow` ran, then `reopened`), Mark's new account created the replacement ($100,230.14, cleared), the run of Tue 20 Oct paid it and the claim closed again.
  End state: **14 workflow runs** (13 completed, run 1 of `event-d0d6...` failed then run 2 completed), **16 deadline rows** (1 fired, 1 skipped, 14 closed without firing, none open), **19 letters** with 19 distinct idempotency keys (none queued or failed), payment items Diane paid $100,230.13, Mark returned $100,230.14 (replaced), Mark paid $100,230.14 (`replacement_of_id`),
  **$200,460.27** paid of which **$460.27** interest, two "Claim closed" lines and one "Claim reopened" in the history, no open work item. (On this run the first steps happened at the machine's real time, Tue 29 Sep, because the virtual clock cannot go back to the notice's Fri 25 Sep; the deadlines, and everything from the second bounce on, carry the mock's dates. The overdue check
  raised "Examiner calls Diane" when the clock crossed into Tue 29 Sep, and it closed with the row when Rachel's welcome call was ticked off.)

**Not verified:** a stall that Temporal retries on a DIFFERENT worker (there is one in-process worker: attempt 2 ran on it, while attempt 1 was still hanging); a worker process really killed (the fault simulates it: the activity works and then does not answer); `./claims.sh demo up` was not re-run end to end (it needs ports 8080, 5173, 7233 and 8233; only its two new
environment exports were added and `bash -n` is clean; the API ran with the same environment in the live run above); the Temporal Schedule at its default one-minute cadence (5 s was used); the `docker compose` path; any real letters provider, IRS or bank; the web app against this contract (the other agent's); a run of the returns batch across two API instances (two concurrent batches in one process, and
a second connection holding a row lock, were tested). About the test server: Temporal's time-skipping test server skipped the letters retry back-off in the workflow tests (fake activities), but in the end-to-end test it did not skip the stalled attempt's 30 s timeout, nor the 2+4+8+16 s of retries after it (about 30 s each in real time); I did not find out why, and the end-to-end test simply takes about 65 s.

### The simple scenario (the previous task)

Run with the .NET SDK 10.0.401 on macOS (arm64), against a throwaway PostgreSQL 18.6 cluster on port 55433 (the machine's own server and its databases were not touched; `claims.sh demo` used only the database `claims_demo` on it):

- `dotnet build`: 0 warnings, 0 errors, Debug and Release, from a clean tree (`bin` and `obj` removed).
- `dotnet test` with `TEST_PG_URL=jdbc:postgresql://127.0.0.1:55433/postgres`: **104 run, 104 passed, 0 failed, 0 skipped** (repeated 8 times in a row, all green; one earlier run failed on a wrong assertion of mine, fixed). Without
  `TEST_PG_URL` and with no Docker daemon: **104 run, 49 passed, 0 failed, 55 skipped** (all `REQUIRES POSTGRES/DOCKER: TEST_PG_URL is not set and no Docker daemon is running`). The original 54 tests are unchanged and green
  (two assertions on the work item's action text were updated for "Record decision: <insured>").
- **SKIP LOCKED negative control for the payment run**: the test `ARowAnotherTransactionHoldsIsSkippedNotWaitedOnAndWithoutSkipLockedTheSameStatementBlocks` holds a row lock on one cleared item in one connection, runs the claim
  statement in another and gets the other item at once; then runs the same statement with `SKIP LOCKED` removed and gets `55P03 lock_not_available` after 500 ms (an in-test control). By hand: editing `PaymentRepository.ClaimClearedSql`
  to plain `FOR UPDATE` makes the test fail after Npgsql's 30 s command timeout ("Timeout during reading attempt"); restored afterwards.
- Second negative control: taking `LockClaimsAsync` out of the run's reconcile step makes `ConcurrentRunsNeverTakeTheSameItemAndEveryItemIsPaidOnce` fail 5 runs in 8 (claims left `paying` with every item paid); with it, 12 of 12 (and 15 of 15 for the earlier, smaller variant).
- `npx @redocly/cli lint api/openapi.yaml` (2.55.0): valid, no warnings. A script (not part of the suite) bundled the contract and checked live responses against the schemas for the operations it called (decision 201/202/approve, payment items,
  hold, release, runs, staff, work items, workflow runs, letters, history, deadlines, requirements, the dev clock, a problem body): 0 differences.
- **The API run for real** (Development, `Claims:Dev:Controls`, the embedded Temporal dev server, CLI 1.9.1 / server 1.32.0, Schedule every 5 s): the whole simple scenario by HTTP against the virtual clock (advance a day, accept, `until: next_deadline`, the Schedule fires
  Mark's follow-up at the virtual 5 Oct, accept the rest, decide at Thu 8 Oct 11:30, advance to Fri 9 Oct 02:00, the scheduled run pays), and the accident variant (202, Rachel refused as approver, Monica approves): both end `closed`, with the payment items
  (`100000.00 + 191.78 = 100191.78` each for the natural-causes claim; `200383.56` in all), 13 letters, 12 deadline rows (in that run both open follow-ups fired; the automated test has the docs' 11), 5 workflow runs and the history as the docs page describes.
- `./claims.sh demo up`, `status` and `down` ran for real (local Postgres on 5432, database `claims_demo`; API on 8080; embedded Temporal on 7233 with its UI on 8233; the web dev server on 5173, and its `/api` proxy answered 200 from the API). The Temporal CLI was
  downloaded by the SDK on the first start (a 150 MB file appeared in `$TMPDIR` within 4 s; deleted and downloaded again to check). `down` left nothing running that `up` had started and did not touch other servers. The refusal messages (port in use, no login, no Postgres and
  no Docker, no .NET SDK) were exercised. `bash -n claims.sh` is clean under bash 3.2.57.

**Not verified:** the `docker compose` Postgres path of `demo up` (no Docker daemon here; only the "Docker is not running" branch ran), `demo up` on Linux, a real bank, a real letters provider, a run that dies between sending the file and recording the answer (documented, not built),
the Temporal Schedule at its default one-minute cadence (5 s was used), and any Windows use of `claims.sh`. Once, during the first `demo up` run, the API process received a graceful shutdown a few seconds into the scenario (the log shows "Application is shutting down"
with no exception); it did not repeat in the later runs, and I could not identify the sender (another process on this machine is the most likely: nothing in the API stops itself).

### Verification of the port (the earlier task)

Run with the .NET SDK 10.0.401 (runtime 10.0.12) installed by `dotnet-install.sh` into a scratch directory, on macOS (arm64), against a throwaway PostgreSQL 18.6 cluster on port 55432
(not the machine's existing database, which was not touched):

- `dotnet build`: 0 warnings, 0 errors, Debug and Release, from a clean tree.
- `dotnet test` with `TEST_PG_URL=jdbc:postgresql://127.0.0.1:55432/postgres`: **54 run, 54 passed, 0 failed, 0 skipped**. Without `TEST_PG_URL` (and no Docker daemon): 54 run, 24 passed,
  **30 skipped** (the 29 Postgres ports and the conditional-GET test) with `REQUIRES POSTGRES/DOCKER: TEST_PG_URL is not set and no Docker daemon is running`. Of the 54, 47 are the Java tests (Java: 47 run with Postgres, 18 run and 29 skipped without), and
  seven are new: `WireNamesTests` (2), `WorkflowReplayTests` (1), `PgConnectionTests` (3) and a conditional-GET test (1, needs Postgres). The Java test results are the Java README's; they were not re-run.
- Negative control: replacing `FOR UPDATE SKIP LOCKED` with `FOR UPDATE` in `DeadlineRepository.LockDueAsync` makes `RowsLockedByAnotherTransactionAreSkippedNotWaitedOnAndPickedUpLater` fail
  (the poll blocks on the held rows until Npgsql's 30 s command timeout); restored afterwards.
- Migrations: DbUp applied V1 to V5 and the dev seed to empty databases (through the tests and through a booted app); the `V*.sql` files are `cmp`-identical to `../backend`.
- The API was booted against the throwaway Postgres and exercised with curl: `POST /claims/life-intake` with the Castellano body 201 (`ETag: "0"`, `Location`), the same `Idempotency-Key` 200 with
  `Idempotent-Replayed: true`, `GET /claims`, `GET /claims/{id}/deadlines` (7 rows, first contact due `2026-09-28T13:00:00Z`), a missing `Idempotency-Key` 400 `missing_header`, bad path, query and route
  errors as problem+json.
- **Against a real Temporal server.** The SDK downloaded the Temporal CLI dev server (CLI 1.9.1, server 1.32.0) into a scratch directory and it ran in memory. The API booted with
  `Claims:Dispatcher:ScheduleInterval` set to 5 s: the Schedule `claims-deadline-dispatcher` was created (and a second boot logged "already exists"); the outbox relay started
  `orch-L-26-043310-intake`; the worker ran it to `completed` (claim `gathering_evidence`, `fast_track_life`, owner Rachel, four letters sent, `acknowledge_by` and `forms_by` closed);
  after a follow-up row was made due, the **Schedule** started the dispatcher workflow, which started `deadline-<id>`, which sent the reminder and wrote the next row. This was one manual run, not an automated test.
  With no Temporal reachable the API started, and the worker, the Schedule registrar and the outbox relay logged warnings and retried, without stopping the host.
- `npx @redocly/cli lint api/openapi.yaml` (2.55.0) on the copied contract: valid. (The Java README also reports `spectral:oas`; not re-run here.)
- `../claims.sh`: `bash -n` clean under bash 3.2.57; `doctor` (with and without a .NET SDK, and with `BACKEND=java`), the usage text, `setup` (with `npm` stubbed so `web/` was not touched),
  `test` (with and without Postgres, with `CLAIMS_SKIP_WEB=1`) and `backend` were run.

**Not verified:** the Testcontainers path (no Docker daemon; only the "no daemon, skip with a message" branch ran), `docker/docker-compose.yml` and `./claims.sh infra`, recovery after a Temporal outage
once the server returns (only the "down at startup" case was run), the default one-minute Schedule cadence (5 s was used), TLS or API-key connections, Worker Versioning, the Java backend and the
`BACKEND=java` branches of `claims.sh` (no JDK 21 here), the Java-side claims in "Java to .NET differences" that say "by reading", and that live responses conform to the OpenAPI schemas (no contract test).
