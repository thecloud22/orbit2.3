# Claims — mock application

A clickable mock of the individual life, disability income and annuity claims platform designed on the
[UX canvas](https://claude.ai/artifact/Sq2qYawSAUtucA1qjVfyXM). It runs entirely in the browser on sample
data; there is no backend yet.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # static files in dist/ — serve from any web server or file share
```

The mock's "today" is **Fri 25 Sep 2026** (`src/lib/dates.ts`), so clocks and due dates match the canvas.

## Try it

- **Fast track (Rachel Kim).** My work → *Decide term life — fast track* (Pierce) → review the 9 readiness checks →
  *Record decision & schedule payment* → confirm. The decision locks as v1, payments and letters are scheduled,
  the history is written and the queue moves on.
- **Complex life.** Okafor: three benefit lines moving independently, a contestable review, minors' shares held.
  Send the custodian packet from Communications and watch the next step move on.
- **Missing information (Jordan Ellis).** Vasquez: requirements with follow-up plans. Then open the claimant portal
  (account menu → Claimant portal), upload Elena's tax return as Elena, and return to Requirements: it's met.
- **Document review.** Bell: accept the fields extracted from the physician's statement; proof of loss renews.
- **Team lead (Monica Reyes).** Approvals above an examiner's authority, and denials sent for second review from
  the workbench, arrive on the Team board. Insights has the operations dashboard.
- **Intake.** A phone intake of a new disability claim that creates the claim on submit.
- **Life claim, intake to payment.** Intake → *Start a different claim* → Life (or ⌘K → *New life claim intake*, or
  `#/intake/life`). Take Diane Castellano-Reyes's notice of her father's death in five steps and submit. The claim opens
  on **Workflow & SLA**: the intake run plays step by step, then *Play next* moves the claim forward — follow-up
  deadlines fire, evidence arrives, the decision is recorded, the daily payment run pays, the claim closes. The steps,
  service levels, deadline rows, Temporal runs and swimlane are explained in
  [docs/life-claim/README.md](../docs/life-claim/README.md). For the back and forth with Temporal, choose *Things bounce
  back* in step 2 and read [docs/life-claim/README-back-and-forth.html](../docs/life-claim/README-back-and-forth.html).
- **Portal.** Claimant, beneficiary, annuity beneficiary and agent-of-record views, all reading the same live data.
- **Ask about this claim (staff only).** Bottom of the Assistant tab on any claim. Starter questions are scripted for
  Pierce, Okafor, Whitman, Vasquez, Bell and Hart; questions about what's outstanding, deadlines, payments, people or
  recent activity are answered from live data on every claim. Answers cite sources; asking for a recommendation is
  declined; every question is logged in History. The mock's answers are scripted, not a live model.
- **Switch persona** from the account menu (top right): Jordan Ellis (DI case manager), Irene Walsh (annuities),
  Monica Reyes (team lead). **⌘K** searches claims, people, policies and actions.
- **Reset demo data** in the account menu — the data lives in memory, so a reload resets it.

## How it is built

| Layer | Where | Notes |
|---|---|---|
| Contract types | `src/api/types.ts` | The JSON shapes the real API (Spring Boot or ASP.NET Core) will return. |
| Mock API | `src/api/*.ts` | One module per REST resource. Async functions over in-memory collections. |
| Fixtures | `src/api/fixtures/*.ts` | Sample data from the canvas story. |
| Data hook | `src/api/useQuery.ts` | Re-runs a query whenever the mock store changes. |
| Tokens & shared CSS | `src/styles/` | The canvas "ledger" design language. |
| Shared components | `src/components/` | Tag, Clock, StageTracker, DecisionRecordView, ProposedCard, Drawer, Toasts. |
| Shell | `src/shell/` | Global bar, workspace tabs, ⌘K palette, session (persona, open tabs, density). |
| Claim workspace | `src/claim/` | Header, exceptions strip, section nav, context panel, one file per section. |
| Pages | `src/pages/` | My work, Team board, Insights, Intake (disability), LifeIntake. Shared call bar and form parts in `intakeParts.tsx`. |
| Portal | `src/portal/` | The claimant's phone experience. |

**Swapping in the real backend.** Replace the bodies of the functions in `src/api/*.ts` with `fetch` calls
(or a client generated from `contracts/openapi.yaml`). Screens only call these functions, so they don't change.
Mutations in the mock (for example `recordDecision`) do inline what the claim's Temporal workflow will do
server-side: lock the record, schedule payment and letters, advance the stage, write history.

## Live mode (the real backend)

With `VITE_API_BASE` set, the app reads and writes the real Claims API (`../backend-dotnet`, contract in `../backend-dotnet/api/openapi.yaml`)
for the **life claim flow**, instead of the in-memory mock. Unset, nothing changes: the app is the mock described above.

```
# 1. Postgres, a Temporal dev server and the API (see ../backend-dotnet/README.md; ./claims.sh demo does it in one go when it exists)
# 2. the web app, proxying /api to the API (the API has no CORS, so the browser never calls it directly)
VITE_API_BASE=/api DEMO_API_TARGET=http://127.0.0.1:8080 npm run dev
```

| Variable | Meaning |
|---|---|
| `VITE_API_BASE` | Turns live mode on. `/api` uses the Vite proxy (dev and `vite preview`), which strips `/api` and forwards to `DEMO_API_TARGET`. |
| `DEMO_API_TARGET` | Where the API is. Default `http://127.0.0.1:8080`. |
| `VITE_LIVE_ZONE` | The business zone instants are shown in. Default `America/Chicago`, the backend's default. |

What works live: the **simple life claim, end to end**, and the **complex one, "things bounce back"** (a worker stall, a TIN mismatch, a photocopied certificate and a failed letter run that ops re-runs, a bank return, a replacement payment; the claim closes twice), from the browser, with no curl. **New life claim** (`#/intake/life`) submits `POST /claims/life-intake` (with an `Idempotency-Key`;
a 422 lists the fields the API refused); the claim opens on **Workflow & SLA** and refreshes itself (every 2 s while something is in flight, slower when
idle). **Work on this claim** (on Workflow & SLA, or *Log call* in the claim header, or *Log the welcome call* on a My work item) completes the welcome-call work item
(`POST /work-items/{id}:complete` with its ETag), which meets the first-contact service level. **Requirements** accepts and waives with the requirement's ETag.
**Decision** shows the readiness list (worked out from the requirements, the intake run and the claim: the backend has no check resource), the payees and their
shares, and records the decision (`POST /claims/{id}/decisions`, `Idempotency-Key`, `X-Actor` = the signed-in persona's handle). Above the examiner's authority it
is recorded as *awaiting approval* (202) and the screen says it went to the team lead; **Monica Reyes** (Sign in as) approves it on the same screen or on the
**Team board** (`POST /decisions/{id}:approve`); Rachel gets a 403 and no button. The locked decision versions (base line and rider) are shown read-only.
**Payments** shows the backend's payment items per payee (proceeds, interest, amount, status, bank reference), holds and releases with the item's ETag
(a change since the screen was drawn is a 412 and says so), and **Run payment run now**, the daily batch started by hand (`POST /payment-runs`), with the run's
result and the recent runs. A `returned` item shows the bank's code and reason and links to its replacement (`replacementOfId`) and back. **Communications**
lists every letter the workflows sent, **History** the audit trail (actors named from the staff directory), **Workflow & SLA** the event runs
(`event-<decisionId>`, `event-<outbox event id>`) with their steps, the swimlane, the seven milestones and the service levels (interest comes from the payment items).
**My work** shows the backend's work items and claims; **Team** lists the decisions awaiting approval first. Sample (mock) claims are hidden unless you tick
*Show sample claims* and are marked *Sample*. Claim ids in the URL are the backend's claim numbers.

**Personas.** `GET /staff` is read once: it maps `ownerId` and `recordedBy` UUIDs to `rachel` (examiner, $250,000) and `monica` (team lead, $1,000,000); in live
mode *Sign in as* lists only people the backend knows, shows the backend's name and limit, and sets `X-Actor` to the handle for every write.

**Documents** lists what arrived for the claim (`GET /claims/{id}/documents`): kind, who it is from and how it came (portal, mail room, upload), when, status
(`received`, `accepted`, `not_enough`, `under_review`, `rejected`) with the backend's note, the taxpayer number's last four digits, and the event workflow that handled it
as a link to the run on Workflow & SLA. A document **under review** (a photocopied certificate) has the examiner's review panel: *Accept document* or *Reject document* with a
reason (required to reject); it is `POST /documents/{id}:review` with the document's ETag and the signed-in persona's `X-Actor`, and only the examiner persona (Rachel) can use it:
anyone else sees the buttons off and why. After a rejection the row says what it set in motion: the requirement is requested again, and the letter workflow's run (with its status:
running, **failed in red**, completed, and a *Re-run* button). There is no document store on the backend, so nothing shows a page image.
**Requirements** shows the state the backend gives: *Not enough · TIN mismatch* (with the 7-day correction follow-up in the plan), *Under review · examiner* (with a link to review it),
*Asked again · rejected*; the detail lists every document that touched the requirement.
**Workflow & SLA** shows what Temporal did: each run's steps carry their attempts ("2 attempts · retried", "5 attempts · gave up") and the backend's note per step, the run's
"What Temporal did" note, its real elapsed time, *run 2* with links to and from run 1, a failed run in red with its ops task and the *Re-run* button, and the swimlane's Batch lane
(payment runs, the returns job, the overnight check).

**Demo controls** (live mode only) are docked, never floating over the claim. Collapsed (the default) they are one slim bar at the bottom with a pill that carries the next hint, and
the backend's clock; open they are a strip along the bottom (or a column on the right: *Bottom* | *Side*), and the page makes room for them. They show the backend's virtual clock and move it: *Advance to next deadline*, *+1 day*, *+7 days*, *Reset clock*
(`/dev/clock`, served only when the backend runs with `Claims:Dev:Controls=true`; otherwise the panel says *Demo controls not enabled on this backend*), and the fault switches that are on
(*Letters service DOWN*). At the top, the scenario chooser: **Simple** or **Complex: things bounce back**. Each is a checklist and a *Next:* hint for the claim on screen (or the last one
you had open), with the buttons for the next step (*+1 day* to the pay date, *Run payment run now*, and for the complex one the fault switches, the documents that arrive, the bank, the re-run).
Nothing about either is stored: every tick is worked out from the backend's data (`src/api/live/guide.ts`; the fault switches and the bank's queue come from `GET /dev/faults` and
`GET /dev/bank/returns`), so it is right after a reload, in another browser, or when someone else clicked. **Scenario events** (under *Scenario events · by hand*) are buttons for
each thing the complex story needs (`src/api/live/scenarios.ts`): *Run payment run now*, a document arriving (certified, photocopy, W-9, W-9 with a TIN mismatch), the examiner
accepting or rejecting the document under review, the letters service or the bank going down, the worker stalling in the next intake, the bank returning a payment (its file, then the returns batch),
the payee giving a new account, ops re-running a failed run, the overnight overdue check. Each is one or two calls to an endpoint that is in the contract; an event that can't run
for the claim on screen is disabled with its reason. The presenter's guide is [docs/life-claim/LIVE-DEMO.md](../docs/life-claim/LIVE-DEMO.md).

Not live yet (each shows a plain "not on the backend yet" note or is hidden, never made-up data): notes, tasks, the assistant, calls other than the welcome call, composing letters,
reminders by hand, adding requirements, snoozing work, returning a decision to the examiner from the Team board (*Return to examiner* is not supported), approve in part / deny / corrections
(the backend answers 422), a document viewer or upload (the backend has no document store), and the payee's new bank account as a form (a scenario event makes it).

How it is built: `src/api/live/` holds a small HTTP client (`http.ts`: ETags, `If-Match`, `Idempotency-Key`, `X-Actor`, problem+json as `ApiError`), the backend types
(`types.ts`), mappers from backend records to the mock's UI types (`present.ts`, `flow.ts`, `decisions.ts`, `payments.ts`, `approvals.ts`: status, stage, clocks, next step,
requirement plan, service levels, swimlane), the staff directory (`staff.ts`), a per-claim bundle cache and poller (`data.ts`, `poll.ts`), the demo clock (`demo.ts`),
the guided scenarios (`guide.ts`), the scenario events (`scenarios.ts`) and the documents (`documents.ts`). Each mock API function starts with `if (isLiveId(id)) return live...`, so adding an endpoint is
one function in `data.ts`, one mapper, and one branch. The live Decision, Payments and Documents screens are their own components (`claim/sections/DecisionLive.tsx`,
`PaymentsLive.tsx`, `DocumentsLive.tsx`); `claim/liveSections.ts` says which sections a live claim swaps.

Checks, each needing a fresh backend with `Claims:Dev:Controls=true` (and `Claims:PaymentRun:ScheduleEnabled=false` so the button is what pays):

```
node scripts/live-check.mjs <dir>                         # stage 1: intake, follow-ups, requirements, up to a claim In review
node scripts/live-simple-check.mjs <dir> [natural|accident]  # the simple scenario end to end, ~100 assertions; accident: 202, Rachel can't approve, Monica does
node scripts/live-events-check.mjs <dir>                  # the scenario-event buttons: photocopy, letters down and re-run, TIN mismatch, bank return, replacement
node scripts/live-complex-check.mjs <dir>                 # the whole complex scenario by clicking only what a presenter clicks, ~190 assertions, ~3 minutes (real Temporal timeouts)
```

## Conventions

- **Four treatments that never mix:** information (plain text on quiet surfaces), actions (cobalt, fixed places),
  decisions (`DecisionRecordView`, double-ruled, locked), exceptions (the strip under the claim header).
  Proposed AI or extracted content uses `.proposed` (dashed) until someone accepts it.
- **Status is shape + word + tint:** use `<Tag tone>` / `<StatusTag>`, never colour alone.
  Tones: `neutral` ring, `info` dot, `positive` check, `caution` triangle, `critical` square, `special` diamond, `plain` none.
- **Cobalt is for actions only.** Use `.btn--primary` for the one main action in a region; `.btn` otherwise.
- **Every action is logged:** call `logEvent()` from `src/api/history.ts` when something changes.
- **AI is advisory:** suggestions and assistant answers cite sources, are accepted or dismissed by a person, and never decide.
  Assistant answers use the dashed proposed treatment; the assistant can draft or create a task, never record a decision.
- **Accessibility:** WCAG 2.2 AA, visible focus, keyboard reachable, labels on every control, no colour-only meaning.
- Page-specific CSS lives next to the page and is prefixed with the page name (`.mw-…`, `.wb-…`).
- Dates are ISO strings in data and formatted with `src/lib/dates.ts`; money with `src/lib/money.ts`.

## Checking a screen

With the dev server running:

```
node scripts/shot.mjs /claims/L-26-040112/decision out.png 1440 960
node scripts/shot.mjs /work out.png 1440 960 --click '.mw-row:nth-child(2)'
```

It saves a screenshot and prints console errors and horizontal overflow. Two more checks:

```
node scripts/sweep.mjs 1440 960      # every claim section, page and portal view: errors, overflow, placeholders
node scripts/flows-check.mjs <dir>   # cross-screen flows: portal upload → requirements; custodian letter → next step
node scripts/life-flow-check.mjs <dir> [natural|accident|pending]   # life intake → play the claim to closed, with screenshots
```
