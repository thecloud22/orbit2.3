# Backend architecture — first thoughts

Context: a React front end, PostgreSQL as the database, Temporal for workflow, and a team strong in Java and .NET.

## Node.js

Only as developer tooling. Vite and npm need Node to run the React dev server and build the static files. Nothing runs on Node in production; the built front end is plain files served by a web server or the backend.

## Backend

Use what the team knows. Java or .NET are both good fits with Postgres and Temporal. If the team is equally strong in both, lean slightly to **Java 21 + Spring Boot**:

- Temporal's Java SDK is its oldest and most battle-tested. The .NET SDK is production-ready too, just younger.
- Many insurance platforms and integration tools are Java-first.

If the team is stronger in .NET, **ASP.NET Core + Temporal .NET SDK** is a perfectly sound choice. Pick one, not both.

## PostgreSQL

A good fit. Claims are relational at the core (claim → benefit lines → decisions → payments), and JSONB covers the product-specific detail, like disability riders or annuity guarantees, without a table per product. That also helps when long-term care arrives.

## Temporal

A strong fit. Claims are long-running processes full of deadlines, and Temporal's strength is durable timers and waiting.

## How the pieces map

| Claims concept (from the canvas) | Where it lives |
|---|---|
| Claim, benefit lines, people and roles, decisions, payments | Postgres, the system of record |
| Lifecycle per claim or benefit line (intake → evidence → decision → payment → ongoing management) | Temporal workflow |
| Regulatory clocks: status letters every 30 days, decision limits, annuity election deadlines, proof of loss, recurrence windows | Temporal durable timers |
| Document arrives, decision recorded, beneficiary in good order | Signals into the workflow |
| Letters, payments, sanctions screening, policy-admin lookups | Temporal activities, with retries |
| My work queue, Team board, dashboards | Postgres tables and read models, not Temporal's visibility store |
| Locked decision records, history replay | Append-only event and audit tables in Postgres |
| Documents (statements, certificates, tax returns) | Object storage (S3 or Azure Blob), with metadata in Postgres |
| Configuration studio rules | Versioned in Postgres and evaluated inside activities, which keeps workflows deterministic |

## Things to decide early

- **Temporal is not the system of record or the task inbox.** It orchestrates; Postgres owns the data and queues. Teams that blur this regret it.
- **Disability claims run for years.** Plan for Temporal's continue-as-new and workflow versioning from day one, because rules and forms change during a claim's life.
- **Temporal's own database.** Self-hosted Temporal can use Postgres, but in a separate database or cluster from the claims data. Temporal Cloud is the alternative.
- **Security.** Corporate SSO (OIDC), role-based access that matches the access matrix on the canvas, and field-level protection for medical data.
- **API contract.** REST with OpenAPI, and generate the TypeScript client from it.

## Long-running claims: continue-as-new and versioning

Disability claims can run for 10 to 20 years. That causes two separate problems.

1. **History grows.** Temporal records every event of a run. Monthly payments, proof-of-loss requests, letters and signals add up to more than Temporal allows: a warning around 10K events, and a hard stop at 50K events or 50 MB. Long histories also replay slowly.
2. **Code changes under running claims.** Temporal rebuilds a workflow by replaying its history against the current code. Changing the order of steps, timers or activities breaks runs already in progress with a non-determinism error.

### Continue-as-new

Continue-as-new ends the current run and starts a fresh one with the same workflow ID.

- **Roll over at a natural boundary.** For disability, that's each benefit period, such as after a monthly payment cycle. Also check `isContinueAsNewSuggested()` as a safety net.
- **Carry a small state record.** It holds IDs, the current stage, and deadlines as absolute dates (`nextStatusLetterAt`, `recurrenceWindowEndsAt`). Timers don't carry over, so the new run rebuilds them from those dates.
- **Keep claims data out of workflow state.** Activities read it from Postgres. This also keeps medical data out of Temporal's history.
- **Handle pending signals before rolling over.** Wait until the signal inbox is empty and every handler has finished, or a signal that arrives during the handoff can be lost.
- **Store the workflow ID in Postgres, not the run ID.** The run ID changes at each rollover. Signals sent by workflow ID reach the latest run.

### Versioning

Most changes should never touch workflow code:

| What changes | Where it lives | Versioning cost |
|---|---|---|
| Benefit calculations, deadline lengths, state rules | Versioned rules in Postgres, read inside activities | None. Activity code can change freely. |
| Forms, letters, document requirements | Versioned templates, rendered by activities | None |
| Shape of the process (a new step, signal or timer, or a new order) | Workflow code | This is the real versioning work |

The workflow decides *when* things happen. Activities and versioned rules decide *what* happens.

Compliance needs to decide whether a claim keeps the rules in force at the date of loss or moves to the current ones. Either way, record the rules version on the claim or benefit line.

For changes to the process itself:

- **Patching** (`Workflow.getVersion` in Java): an if/else between the old and new path. You can only remove the old branch once no run still needs it.
- **Continue-as-new as the upgrade point.** A new run starts on current code. If every claim rolls over each benefit period, no run needs the old branch one period after a deploy, and you can delete it. This is why continue-as-new and versioning have to be planned together.
- **A new workflow type** (`ClaimLifecycleV2`) for large rewrites. New claims start on V2. Existing claims continue-as-new into V2 at a safe point, carrying their state record.

Don't pin long claims to a worker build with Worker Versioning, because that means running old workers for years. Pinning suits short workflows.

### Replay tests in CI

Export histories of real in-flight workflows and run them against new code with `WorkflowReplayer` on every build. Any non-determinism fails the build before it reaches production. Because histories hold only IDs, the exports contain no protected health data.

### Starting rules

1. Workflows hold IDs, stage and absolute deadlines only. Rules and templates are versioned data read by activities.
2. Continue-as-new at every benefit period close, plus the suggested-limit check.
3. Use patches for process changes, and delete them once every run has rolled over.
4. Replay tests against real histories are a required CI gate.

## Batch or Temporal

**Temporal handles one claim at a time, over time. Batch handles many rows at once, on a schedule.** If the work is about one claim and its next step depends on what happened before or on waiting for something, it belongs in Temporal. If the work does the same thing to a set of records and produces a file, a report or a total, it's batch.

The two meet through Postgres and the Claims API. A workflow hands work to batch by writing a row. Batch hands news to a workflow by sending a signal.

**Temporal:**

- The claim lifecycle: intake → evidence → decision → payment → ongoing management
- Regulatory clocks for each claim: status letters, decision limits, election deadlines, recurrence windows
- Chasing evidence: request, remind, escalate
- Good order for each beneficiary on life and annuity death claims
- Multi-step changes across systems, such as lock policy → value → pay → close, with compensation if a step fails
- Payment approval and holds for each claim
- Disability ongoing management: periodic proof of loss, and anniversary events such as a cost-of-living rider increase
- Processing each document: classify, extract, attach to the claim

**Batch:**

- Payment files (ACH/NACHA, check print, positive pay) built from approved instructions
- Bank reconciliation and returns files
- Accounting feeds, and the reserve extract of open disability claims for actuarial valuation
- Year-end tax forms, for example 1099-R, and 1099-INT for state-required interest on death proceeds
- Regulatory reports and Department of Insurance data calls
- Death Master File matching
- Re-screening all payees when the sanctions list updates
- Data warehouse feeds, read-model rebuilds, archival and purging

**Where they meet:**

| Case | Batch does | Temporal does |
|---|---|---|
| Recurring disability payments | Collects approved instructions, builds and sends the bank file, processes returns | Each claim approves its own payment before the due date. A returned payment arrives as a signal. |
| Death Master File match | Finds the matches | One claim workflow starts per match |
| Sanctions list update | Re-screens every payee | A hit sends a signal to that claim's workflow, which holds payment |
| A state rule changes on a set date | Finds the affected claims | Each affected claim gets a signal and applies the change |
| Status letter deadlines | A nightly audit checks that letters actually went out | The timer on each claim sends the letter |

**Avoid:**

- A nightly job that scans every claim to find what's due. Durable timers replace that. Use batch to audit the clocks, not to run them.
- Batch jobs changing claim state behind the workflow's back. They signal the workflow instead.

**Where batch jobs run.** Spring Batch in the same codebase does the row-processing. A Temporal Schedule can run each job end to end (extract → build file → transmit → wait for the bank's acknowledgement), with the heavy work inside a few activities. That gives retries, the ability to pause, and a record of each run without adding another scheduler. Check early whether finance jobs have to run in an existing enterprise scheduler such as Control-M.

## Diagrams

- [Backend architecture v1](backend-architecture-v1.html): the components, and one claim's workflow over time
- [Disability claim flow v1](disability-claim-flow-v1.html): what goes where over a disability claim's life, and one month of benefits step by step
- [Continuation break points v1](continuation-break-points-v1.html): where disability continuation can break, the payment item state machine, and the nightly checks
