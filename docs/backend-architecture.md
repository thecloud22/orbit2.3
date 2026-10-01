# Backend architecture — v2

v2, 26 September 2026. The earlier version is in [backend-architecture-v1.md](backend-architecture-v1.md).

What changed from v1: deadlines moved out of Temporal timers into a deadlines table in Postgres. Workflows became short, lasting minutes to days instead of years. Payments became a daily batch run that doesn't depend on Temporal.

## Context

- **Front end:** React, built with Vite. Node is only a build tool.
- **Database:** PostgreSQL, the system of record.
- **Workflow:** Temporal. It's an existing platform that other teams already run, and we use our own namespace and task queues.
- **Backend:** Java 21 + Spring Boot, assumed. The shape is the same with ASP.NET Core.
- **Scope:** individual life, disability income and annuities. Long-term care comes later.

## The shape

Postgres holds every fact and every deadline. Temporal runs short workflows that act on them. Each workflow is started either by a deadline coming due or by something that happened, and it writes its result back to Postgres. A daily batch run pays whatever is cleared.

| Thing | Lives in | Why there |
|---|---|---|
| Claim, benefit line, payment item status | Postgres state machines | One place checks every change, whoever makes it |
| Every deadline | Postgres deadlines table | Examiners see it, compliance reports on it, and an extension is a row update with a reason |
| Work to do after a change | Postgres outbox | Saved in the same transaction as the change, so it can't be lost |
| Running the work, with retries | Temporal workflows | Retries, timeouts and a history of every action, on the shared platform |
| Products, rules, letters | Postgres product configuration, versioned | Pinned per benefit line. Most changes need no deploy. |
| Paying money | Daily payment run | Set-based, reconciled as one file, independent of Temporal |
| Documents | Object storage, with metadata in Postgres | Large files stay out of the database; the facts about them stay in |

## Three kinds of workflow

| Kind | Started by | Workflow ID | Lasts | Examples |
|---|---|---|---|---|
| Deadline workflow | The dispatcher, when an deadline comes due | `deadline-<id>` | Minutes | Status letter, reminder, proof due, hold review, open next period |
| Event workflow | The outbox relay, after something is saved | `event-<event id>` | Minutes to hours | Proof arrived, decision recorded, claim closed, payment returned |
| Orchestration | A claim reaching a stage | `orch-<claim>-<stage>` | Hours to days | Intake checks, records vendor request, correction run |

No workflow waits for weeks. Anything that needs to happen later is a deadline.

## How a deadline fires

1. A Temporal Schedule runs the dispatcher every minute. It selects due deadlines and marks them dispatched.
2. It starts one workflow per deadline, with the workflow ID set to the deadline ID. A second start with the same ID is rejected.
3. The workflow re-checks the claim: does this still apply?
4. If not, it marks the deadline skipped and records why. Otherwise it does the work, such as sending a letter, with retries.
5. It saves the state change, the next deadline, and this one as done, all in one transaction.
6. If it fails after retries, it raises an alert and opens an ops task. The deadline stays dispatched, so the nightly check sees it too.

## How an event starts a workflow

1. The API saves the change and an outbox row in one transaction.
2. The outbox relay reads new rows and starts a workflow with the event ID.
3. If the API crashes after saving, the relay still starts the workflow. If the relay retries, the event ID makes the second start a no-op.

Nothing sends a signal to a long-running workflow, so there's no "signal to a finished workflow" failure.

## Intake to decision

1. **First notice** is saved, and the outbox starts the intake checks. These find the policy, confirm it was in force, read riders and issue date, run a sanctions screen, and look for a duplicate claim. Anything doubtful stops the checks and opens a task for a person.
2. **Set-up** creates the claim and its benefit lines. It picks the requirement set (the evidence to request) from product configuration by product, state, occupation and contestability. Then it sends the acknowledgement and claim forms, and writes the first deadlines: acknowledge by, status letters, follow-ups.
3. **Evidence** arrives as documents, and each one starts a short workflow. Each requirement is a row: requested → received → accepted, not enough (requested again), waived, or expired. Its follow-up and expiry deadlines close when it's accepted or waived.
4. **Proof of loss is complete** when every requirement is accepted or waived. That event writes the decision-limit deadline and creates review tasks for medical, vocational and financial consultants.
5. **The examiner decides**: approve, approve with a limit, or deny. Benefit set-up creates payment items from the end of the elimination period and writes the first "period opens" deadline.

A policy issued within the last 2 years adds an application review, which can end in rescission. Tasks for people live in Postgres work queues, and finishing one is an event.

## Payments

- **Payment items are the contract between claims and payments.** Their statuses are: awaiting proof → cleared → in run → paid. An item can also be held, cancelled or returned.
- **Every change goes through one state machine**, which checks the current status first.
- **Only the payment run touches an item that's in a run.** A hold that arrives too late becomes a recovery task.
- **Paid items are never edited.** Corrections are new adjustment items.
- **The payment run has its own scheduler and can be run by hand.** It doesn't use Temporal, so an outage on the shared platform can't stop payments.

## Versioning

- **Workflows are short, so each run stays pinned to the build it started on** (Temporal Worker Versioning). There's no continue-as-new, and no patches that live for years. Keep replay tests in CI as a cheap safety net.
- **Product and rules versions follow three rules:**
  - Contract terms come from the policy form and never change for a running claim.
  - Regulation applies by effective date to every open claim.
  - Internal handling, such as letter wording, applies from its release.

## Batch or Temporal

Temporal handles one claim at a time. Batch handles many rows at once. They meet in two ways: a workflow writes a row that batch picks up, or batch starts a workflow through the outbox.

- **Temporal:** deadline workflows, event workflows, orchestrations. That covers intake checks, evidence chasing, decisions, holds, proof, closing, corrections.
- **Batch:**
  - Payment run and bank files, on their own scheduler
  - Returns and reconciliation
  - Reserve extracts for actuarial
  - Tax forms
  - Regulatory reports
  - Death Master File matching
  - Sanctions re-screening
  - Warehouse feeds

  Jobs other than the payment run can be started by Temporal Schedules.
- **Avoid:**
  - A nightly job that scans every claim to find what's due. The deadlines table does that.
  - Batch jobs changing claim state directly. They start a workflow instead.

## Failure handling

There are five layers, each slower than the last:
1. Automatic retry
2. Workflow fails, with an alert
3. Overdue alert within the hour
4. Nightly checks
5. Month-end reconciliation and audit

Every repair is safe to repeat, because every workflow, deadline and item has a key. The full list of 21 failures, and the checks that catch them, is on the failure handling page.

## Product changes

The change ladder:

| Level | Example | What changes |
|---|---|---|
| 1 · New parameter | A 180-day elimination period | Configuration only |
| 2 · New rule or formula | A new residual formula | New rules version |
| 3 · New rider with new events | A catastrophic disability rider | Adds deadline kinds and workflows |
| 4 · New product shape | A disability buy-out, and long-term care later | Adds state machines |

Levels 1 and 2 need no deploy. Code added for levels 3 and 4 is switched on by product configuration.

## Open questions

- Which disability products and variations are real in the book, and their actual parameters? The pages use labelled examples.
- Does the Temporal version the platform team runs support Schedules and Worker Versioning? What support and limits come with our namespace?
- Must finance jobs, including the payment run, use an existing company scheduler?
- How do we convert claims already in progress (open items, deadlines, holds) at go-live?

## Diagrams

v2:
- [Life claim, intake to payment](life-claim/README.md): one life death claim step by step — the swimlane, service levels, deadline rows and workflow runs; runs live in the mock under *Workflow & SLA*
- [Life claim, things bounce back](life-claim/README-back-and-forth.html): the same claim when a worker restarts, a W-9 fails the IRS check, a photocopy is rejected, a letter workflow fails and is re-run, and a payment is returned — a sequence diagram per bounce
- [Temporal, explained](temporal-explained-v2.html): one clean disability claim followed from Temporal's point of view — start here if Temporal is new to you
- [Temporal, layer by layer](temporal-layers-v2.html): what starts Temporal, what the dispatcher is, who fires the 30- and 60-day letters, and what Temporal adds
- [With and without Temporal](with-without-temporal-v2.html): the same approval job built both ways, side by side, for the tech team
- [Architecture v2](backend-architecture-v2.html): components, how a deadline fires, how an event starts a workflow
- [Intake to decision v2](intake-to-decision-v2.html): the path from first notice to decision, intake checks, one requirement's life, the clocks, three branches, who works on the claim
- [Disability scenarios v2](disability-scenarios-v2.html): nine swimlanes, five good outcomes and four bad
- [Failure handling v2](failure-handling-v2.html): layers of defence, three failure swimlanes, all 21 failures, nightly checks
- [Product changes v2](product-change-v2.html): the three kinds of change, the change ladder, the rollout swimlane

v1, superseded:
- [Backend architecture v1](backend-architecture-v1.html)
- [Disability claim flow v1](disability-claim-flow-v1.html)
- [Continuation break points v1](continuation-break-points-v1.html)
