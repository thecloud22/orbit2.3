# Claims backend: life claim slice

The first real backend for the individual life, disability income and annuity claims platform. It is a **bounded vertical slice**:
one life claim from intake to the first follow-up deadlines, built the way [the architecture](../docs/backend-architecture.md) says the
whole platform should be built. The React mock in `../web` is the reference for behaviour; nothing here edits it.

- PostgreSQL is the system of record: every fact, every deadline, the outbox.
- Temporal (the organisation's, not ours to run) executes short workflows against those rows.
- A **deadlines table** plus a **dispatcher** replace long sleeping workflows. Each deadline is a row; the dispatcher fires it.
- Scope is individual products only. No group or ERISA.

Java 21, Spring Boot 3.5, Temporal Java SDK 1.39, Flyway, plain Spring JDBC (`JdbcClient`). Package `com.example.claims`.

> **Java or .NET?** You have not formally chosen; this slice leans Java 21 + Spring Boot, as recommended earlier. The design does not
> depend on it. With ASP.NET Core the schema, the OpenAPI contract, the workflow shapes and the tests' intent carry over unchanged. What
> changes: Flyway becomes DbUp or EF Core migrations (the SQL files are reusable as they are); `JdbcClient` becomes Dapper or EF; the
> workflow and activity interfaces become the Temporal .NET SDK's attribute-based classes (same names, same idempotency keys); and
> `TestWorkflowEnvironment` has a .NET equivalent for the time-skipping tests. Nothing in the design leans on Spring.

## Layout

```
backend/
  api/openapi.yaml                 OpenAPI 3.1 contract (lint: npx @redocly/cli lint api/openapi.yaml)
  redocly.yaml                     lint config (turns off only the "localhost server" warning)
  docs/schema.md                   ER sketch (mermaid) and the reasoning behind the non-obvious schema choices
  docker/docker-compose.yml        Postgres + a dev Temporal server (not verified: no Docker daemon was available)
  pom.xml
  src/main/resources/
    application.yml, application-dev.yml
    db/migration/V1..V5            Flyway: staff/parties/policies, claims core, deadlines+outbox+runs, decisions/payments/letters, history/work
    db/dev/R__dev_staff.sql        two development staff users (dev profile only)
  src/main/java/com/example/claims/
    web/          controllers, problem+json error handler, ETag / If-Match
    intake/       LifeIntakeService (one transaction), LifeIntakeRules (pure), IntakeSetupService (the activities' DB work)
    requirement/  accept / waive, proof-of-loss-complete
    deadline/     DeadlineDispatcher, FollowUpService, DeadlineService (extend), optional local poller
    outbox/       OutboxRelay + poller
    temporal/     the two workflows + dispatcher workflow, activities, launcher (the only place that starts workflows), Schedule registrar
    gateway/      policy admin, sanctions, notifications: interfaces and STUBS
    store/        SQL: read side (ClaimQueries) and one repository per write concern
  src/test/java/...                47 tests, see "Tests"
```

## Build and run

Prerequisites: **JDK 21** and Maven 3.6+. (This repo was built with Temurin 21 on a machine whose default `java` is 11; set
`JAVA_HOME` for your shell only.)

```
export JAVA_HOME=/path/to/jdk-21
mvn verify              # compiles, runs all tests; Postgres tests skip themselves with a reason if there is no Postgres
```

### Tests

| Kind | Classes | Needs |
|---|---|---|
| Pure unit | `LifeIntakeRulesTest` | nothing |
| Workflow, Temporal `TestWorkflowEnvironment` with **time skipping**, fake activities | `LifeIntakeWorkflowTest`, `RequirementFollowUpWorkflowTest`, `DeadlineDispatcherWorkflowTest` | nothing |
| **Real PostgreSQL** | `*PostgresTest`: `DeadlineDispatcherPostgresTest` (SKIP LOCKED), `SchemaConstraintsPostgresTest`, `LifeIntakeApiPostgresTest`, `LifeClaimFlowPostgresTest` (whole slice on Temporal's test server) | Postgres |

H2 is not used anywhere: `SKIP LOCKED`, partial indexes, triggers and `jsonb` must behave as in production. The Postgres tests find a
server in this order, and are **skipped with the reason** (`REQUIRES POSTGRES/DOCKER: ...`) if neither exists:

1. `TEST_PG_URL` (plus optional `TEST_PG_USER`, default `postgres`, and `TEST_PG_PASSWORD`). Each test class creates its own database on it.
2. Testcontainers (`postgres:16-alpine`), when a Docker daemon is running.

A throwaway local cluster, if you have Postgres binaries but no Docker (Homebrew paths shown; the `LC_ALL` is needed on macOS):

```
export LC_ALL=en_US.UTF-8
initdb -D /tmp/claims-pg -U postgres --auth=trust -E UTF8
pg_ctl -D /tmp/claims-pg -o "-p 55432 -c unix_socket_directories= -c listen_addresses=127.0.0.1" -l /tmp/claims-pg.log -w start
TEST_PG_URL=jdbc:postgresql://127.0.0.1:55432/postgres mvn verify
```

### Run locally

```
docker compose -f docker/docker-compose.yml up -d        # Postgres on 5432, a dev Temporal on 7233 (UI on 8233)
SPRING_PROFILES_ACTIVE=dev mvn spring-boot:run           # Flyway migrates; dev profile adds two staff users
```

**In real life we do not run Temporal.** The organisation's platform team does, and we own a *namespace* and *task queues* on it. The
compose file's dev server (`temporal server start-dev`) exists only so the slice runs on a laptop. Point the app at the real cluster with
`TEMPORAL_TARGET`, `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE`, and add its TLS or API-key settings in `temporal/TemporalConfig.java`.

Useful properties (`application.yml`): `claims.temporal.enabled=false` runs the API without any Temporal (workflow starts then fail
loudly; the Postgres tests use this), `claims.dispatcher.schedule-enabled` (the Temporal Schedule), `claims.dispatcher.local-poll-enabled`
(an in-process alternative to the Schedule, on in the `dev` profile), `claims.outbox.poll-enabled`, `claims.business.zone` and `fire-time`.

Try it (needs the app running; the body is the mock's Castellano story, see `src/test/.../TestData.java`):

```
curl -i -X POST localhost:8080/claims/life-intake -H 'Content-Type: application/json' \
     -H "Idempotency-Key: $(uuidgen)" -d @intake.json        # 201, status "received"; workflows run afterwards
curl localhost:8080/claims                                    # then poll: status becomes gathering_evidence
curl localhost:8080/claims/<id>/deadlines
curl localhost:8080/claims/<id>/workflow-runs
```

## How the slice works

**Intake** (`POST /claims/life-intake`): one transaction saves parties, a policy snapshot, the claim (`received`), benefit lines, four
requirements (one already met from our records), the first seven deadline rows (the mock's D-701 to D-707), history and an **outbox
event**, then returns `201`. No workflow has run. It also stores an `Idempotency-Key`, so a retry cannot create a second claim.

**Outbox relay** starts `orch-<claimNumber>-intake`. The workflow id is the idempotency key: if the relay crashes and retries, the second
start is a no-op (`ALREADY_STARTED`).

**Intake orchestration** (`LifeIntakeWorkflow`): checks policies in force, screens sanctions (Temporal retries a timeout, and the run
shows the step as *retried*), looks for a duplicate claim. Anything doubtful stops and opens a task for a person (claim stays `received`).
Otherwise it routes (LF-01 fast track or LF-02 standard), picks the least-loaded examiner, sends the acknowledgement, packets and agent
notice (each letter is sent at most once per dedupe key), then **one final transaction** sets the claim to `gathering_evidence`, closes the
acknowledge and forms rows (they never had to fire), adds the examiner's welcome-call work item, writes history and saves the run record.

**Dispatcher** (`DeadlineDispatcher`): a Temporal Schedule runs a dispatcher workflow every minute, which calls `dispatchDue()`. One poll is one
transaction: select due `open` rows `FOR UPDATE SKIP LOCKED`, start `deadline-<id>` for each, mark them `dispatched` (attempt, workflow id,
outcome), append a `deadline_attempts` line. A failed start leaves the row `open` with a backoff (`retry_after`) and the error recorded.
Only kinds that have a workflow are polled (today: `requirement_follow_up`); the rest stay `open`, not lost.

> Trade-off, deliberately chosen: workflows are started *inside* the poll's transaction, so row locks are held for the (fast, batch-limited)
> starts. The alternative, commit first and start afterwards, can leave a row `dispatched` with no workflow. Idempotent starts make the
> chosen order safe: a crash before the commit only costs an `already_started` next time.

**Requirement follow-up** (`RequirementFollowUpWorkflow`, `deadline-<id>`): re-check the deadline still applies; if the requirement is
already accepted or waived (or the claim is decided), mark it `skipped` and say why; otherwise send the reminder, then **one transaction**
marks this row `done` and `fired`, writes the next follow-up row (10 days on, 08:00 local), bumps the requirement's reminder count and saves the
run. The workflow has no timer and never waits. "Stop when met" means nothing is left scheduled: accepting or waiving a requirement
closes its waiting row, and a partial unique index allows only one live follow-up per requirement.

**Proof of loss**: accepting the last requirement moves the claim to `in_review` and writes `decision_due` (30 days) and `review_target`
(5 business days) rows and a work item, in the same transaction. No workflow needed (Postgres only), as the life claim doc says.

## Mock to backend

| Mock function (`web/src/api`) | Endpoint / workflow / table |
|---|---|
| `submitLifeIntake` (`POST /intake/life/{draftId}:submit`) | `POST /claims/life-intake` → `LifeIntakeService.submit`; tables `claims`, `life_claim_details`, `claim_parties`, `parties`, `policies`, `benefit_lines`, `requirements`, `deadlines`, `history_events`, `outbox_events`, `idempotency_keys` |
| `requirementSet`, `slaPreview` (rules) | `LifeIntakeRules.requirementSet` / `firstDeadlines` (pure, unit-tested) |
| `routeLife` (rules LF-01, LF-02) | `LifeIntakeRules.route`, run by the intake workflow's `route` step |
| `lifeChecks`, the orchestration's steps in `startLifeFlow` | `LifeIntakeWorkflow` (`orch-<claimNumber>-intake`); rows in `workflow_runs`, `letters`, `work_items` |
| `getLifeIntakeContext`, `lifeDraftFromContext` (`GET /intake/life/context`, drafts) | Not built. The request carries the policy and designation snapshot; drafts stay in the client |
| `getClaim`, `listClaims`, `searchClaims` | `GET /claims/{id}`, `GET /claims` (filters, keyset pagination); free-text search not built |
| `getFlow` (`GET /claims/{id}/workflow`) | Split: `GET /claims/{id}/deadlines`, `/workflow-runs`, `/history`. Service-level and swimlane projections not built |
| `listRequirements` | `GET /claims/{id}/requirements`, `GET /requirements/{id}` |
| `markReceived`, `satisfyRequirement`, `waiveRequirement` | `POST /requirements/{id}:accept`, `:waive` → `RequirementService` |
| `onFollowUp` (`deadline-D-707`) | dispatcher + `RequirementFollowUpWorkflow` + `FollowUpService` |
| `proofComplete` | `RequirementService.afterMet` (Postgres only) |
| `getQueue` (`GET /work-items?owner=&status=open`) | `GET /work-items` |
| `listHistory`, `logEvent` | `GET /claims/{id}/history`; `HistoryRepository.append` (append-only table) |
| `listCommunications`, `addCommunication` (outbound) | `GET /claims/{id}/letters`; `LetterService.sendOnce` |
| deadline extension (a row update in the docs) | `POST /deadlines/{id}:extend` |
| `playNext`, `startLifeFlow`'s scripted "happenings" | None. Mock only: replaced by the real dispatcher, outbox relay and the clock |
| `recordDecision`, `onDecide`, `approve` | Contract only (`POST /claims/{id}/decisions`); table `decisions` exists |
| `schedulePayment`, `onPayRun` | Contract only (`/payment-items`, `/payment-runs`); tables `payment_items`, `payment_runs` exist |
| `onArrive` (event workflow), `onCall`, `onStatusLetter`, `sendReminder`, `logCallOutcome` | Not built |

## Deviations from the mock's shapes

The mock says its `types.ts` "keeps in step with contracts/openapi.yaml once it exists". These are the places the mock's shape is
unsuitable for a real API, and what was chosen instead:

- **Ids.** Mock: readable strings (`L-26-043310`, `D-701`, `req-…`). Real: UUIDs in paths and bodies, plus a unique `claimNumber` for display and filtering (`GET /claims?claimNumber=`). Guessable sequential ids leak volume and collide across environments; deadlines and workflows need a stable, unique key.
- **Money.** Mock: JS numbers in dollars (floating point). Real: `{"amount": "200000.00", "currency": "USD"}`, a decimal string, backed by `numeric(15,2)`. Chosen over integer minor units because interest is computed to the cent and the amounts are read by people and finance tools, and a string cannot lose precision in JSON. Percentages are decimal strings on the way out.
- **Timestamps.** Mock: `2026-09-25T09:14` with no zone, and "the claim's own clock". Real: RFC 3339 UTC instants (`timestamptz`); business dates stay dates. Date-based deadlines fall due at 08:00 in a configured business zone (`America/Chicago`, an example).
- **Enums.** Mock: camelCase (`approvedInPart`, `inProgress`). Real: snake_case, identical to the database strings and to the deadline kinds in the architecture doc.
- **Presentation dropped from resources.** `Status {label, tone}`, claim `tags`, `facts`, `stage`, `clocks`, `nextStep`, `summary`, `sections`, `exceptions`, `suggestions`, work-item `views`: projections or view models, not stored facts. They are derived by the client or a later BFF from `status`, `deadlines` and history.
- **Requirement states.** Mock: `met | open | overdue | inProgress | waived`. Real, per the architecture: `requested | received | accepted | not_enough | waived | expired`. "Overdue" is derived from the follow-up row.
- **Claim status** adds `received` (notice saved, set-up not finished), which the mock never shows because it does everything inline.
- **Intake is one call.** Mock: `POST /intake/life/drafts` then `POST /intake/life/{draftId}:submit`. Real: a single `POST /claims/life-intake` that commits and returns before any workflow runs. Server-side drafts are not built.
- **Actor.** Mock: a free-text `actor` ("System · Temporal"). Real: `actorKind` (`user | system | workflow | batch | portal`) and `actor`.
- **Optimistic concurrency.** New: every mutable resource has `version`, exposed as `ETag`; state-changing calls need `If-Match` (412 stale, 428 missing).
- **Idempotency.** New: `Idempotency-Key` on creating POSTs; the workflow id is the key for anything that starts a workflow.
- **Errors.** New: `application/problem+json` with a stable `code` and field-level `errors`. 422 for a well-formed but invalid request, 400 for an unreadable one, 409 for a state or key conflict.
- **Collections.** New: `{items, nextCursor}` everywhere; keyset (cursor) pagination is implemented on claims and history, other lists return `nextCursor: null`.
- **Communications become letters.** Outbound items are `letters` (with a dedupe key). Calls and inbound items are history events and (later) documents.

## Not built yet

- **Decisions with authority** (`POST .../decisions`, versioning, second review, approval above payout limit). Table and immutability triggers exist; nothing writes decisions.
- **Payment items and the payment run** (clearing on decision, the daily batch, bank file, returns, reconciliation, holds, interest). Tables and the paid-item guard trigger exist; no code and no scheduler.
- **Letters service.** `LoggingNotificationGateway` only logs. No templates, rendering, mail-house or delivery status. Letters other than the acknowledgement, packets, agent notice and reminder do not exist (approval, status, closing).
- **Event workflows** (`event-<id>`): document received (classify, read, match, accept), decision recorded, items paid, claim closed. The outbox only knows `notice_of_death_received`.
- **Deadline workflows for the other kinds**: `status_letter`, `first_contact_by`, `acknowledge_by`/`forms_by` (fallback send), `decision_due`, `review_target`, `payment_due`. Rows are written and stay `open`; the dispatcher only polls kinds that have a workflow. A logged welcome call closing `first_contact_by` is not built either.
- **Documents and object storage**, extraction, TIN matching, death master file, real policy administration and sanctions clients (interfaces plus stubs today).
- **Contestable review**, minor beneficiary hold and custodian, competing claimants and interpleader, death abroad, rescission, requirement expiry, waive-and-close-incomplete.
- **Portal and authentication.** No authn or authz (`X-Actor` is a placeholder; the contract declares a bearer scheme it does not enforce), no portal endpoints, no agent access.
- **State rules table and product configuration** by effective date. Rule values (15 and 30 days, 10-day follow-up, 3.5% interest, the $500,000 fast-track limit, 31-day grace) are the mock's examples, hard-coded in `LifeIntakeRules` and `SnapshotPolicyAdminGateway`.
- **Assignment** is "fewest open claims among active life examiners"; no skills, capacity or out-of-office. **Party matching** is not built (intake always creates new party rows).
- **Operational hardening**: the nightly checks (dispatched-but-unclosed rows, overdue alerts), metrics, alerting, Temporal Worker Versioning, replay tests in CI, load and soak testing, grants for the application database role.
- **Verified against a real Temporal server**: not done. See "Verification".

## Verification

Run with JDK 21.0.12 (Temurin) and PostgreSQL 18.6 (a throwaway cluster, not the machine's existing database):

- `mvn verify` with `TEST_PG_URL` set: 47 tests, 0 failures, 0 skipped. Without it: 18 run, 29 skipped with a reason.
- Removing `SKIP LOCKED` from the dispatcher makes the locked-rows test hang (a negative control), so that test does exercise it.
- The packaged jar booted against Postgres; Flyway applied all migrations; `POST /claims/life-intake` (201, then 200 on a repeat), `GET /claims`, `GET /deadlines` and a 400 error were exercised with curl.
- Both `@redocly/cli lint` and `@stoplight/spectral-cli lint` (`spectral:oas`) report no errors or warnings on `api/openapi.yaml`.

Not verified: the Testcontainers path (no Docker daemon), `docker/docker-compose.yml`, a real Temporal server (so also the Schedule
created by `DispatcherScheduleRegistrar`, which Temporal's in-process test server does not implement), and that live responses conform to the OpenAPI schemas (no contract test yet).
