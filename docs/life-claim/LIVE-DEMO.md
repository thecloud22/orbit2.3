# Live demo: the life claim on the real backend

For the tech team. The web app in **live mode** runs the same claim as the mock (Robert Castellano, whole life WL-0804419, $200,000, Diane and Mark 50% each), but every screen reads and writes the real .NET API, Postgres and a real Temporal server. Two scenarios, each driven from the browser with no curl:

| Scenario | What it shows | Time |
|---|---|---|
| **Simple** | notice, intake workflow, evidence, a late follow-up that fires, proof of loss, decision, payment run, closed | about 5 minutes |
| **Complex, "things bounce back"** | five things come back: a worker stalls, the IRS says "no match", a photocopied certificate is rejected while the letters service is down (a failed run that ops re-runs), the bank returns a payment. The claim closes, reopens and closes again | about 15 minutes, of which about 1 minute is waiting on real Temporal timeouts |

The story and the design behind it are in [README.md](README.md) (simple) and [README-back-and-forth.html](README-back-and-forth.html) (complex). What the API does for each step is in [`backend-dotnet/README.md`](../../backend-dotnet/README.md).

## Start it

```
./claims.sh demo up        # Postgres, the .NET API with an embedded Temporal dev server, the web app
./claims.sh demo status
./claims.sh demo down      # stops only what "up" started
```

Needs the .NET 10 SDK, Node (20.19+ or 22.12+), and a Postgres on 127.0.0.1:5432 (database `claims_demo` is dropped and created on every `up`) or Docker. The first start downloads the Temporal CLI (about 150 MB) for the embedded server. `./claims.sh doctor` says what is missing.

| What | Where |
|---|---|
| The web app (open this) | http://localhost:5173 |
| The API | http://localhost:8080 (`/claims`, `/dev/clock`, `/dev/faults`) |
| The Temporal UI | http://localhost:8233 (namespace `default`, task queue `claims`) |
| Postgres | 127.0.0.1:5432, database `claims_demo` |

`up` starts the API in Development with the dev controls on, the dispatcher Schedule every 5 s, the daily payment run's trigger and the returns job every 3 s, and the overnight overdue check every 5 s. **Every `up` starts from an empty database, an empty Temporal and the real clock**: that is how you get a second take (see the troubleshooting table).

## What is real, what is simulated

| Real | Simulated |
|---|---|
| ASP.NET Core API, Postgres, the outbox, every transaction and constraint (paid items cannot be edited, decisions are locked) | **The clock.** Business time is real time plus an offset; the panel's buttons move the offset **forward only**, and it lives in memory, so it resets when the API restarts. The Schedule and the polls tick in real seconds but read the virtual date |
| Temporal (a real dev server): workflows, activities, retries and timeouts, the ID-reuse policy, the Schedule that runs the dispatcher every 5 s | **The outside systems are stubs:** letters (in memory), the IRS TIN match (a nine-digit number matches; "no match" is a fault switch), the bank (a payment file, and a returns queue in memory) |
| Workflow code, the retry policy (5 attempts, 2/4/8/16 s), idempotent letters | **The failures are switches** (`POST /dev/faults`): `letters.down`, `tin.no-match`, `bank.down`, and `worker.stall-once:<activity>` (the activity does its work, then hangs 35 s past its 30 s timeout, as a worker killed before it reported back would; there is one worker process, so attempt 2 runs on it) |
| Who did what: the persona (Rachel, Monica) is sent as `X-Actor` on every write | **No authentication.** `X-Actor` is a handle, not a login. Ops is any label (`ops`) |
| Documents: kind, source, who from, status, masked taxpayer number, the workflow that handled them | **No document store, classifier or viewer.** A document is a record with declared facts (`photocopy`, `sealPresent`, `tin`); nothing shows a page |

## The screen

Live mode adds the **Demo controls** at the bottom of the app. They are docked, never floating over the claim:

* **Collapsed** (the default): one slim bar with a pill that carries the **next hint** for the claim on screen, the fault switches that are on, and the backend's clock. Click the pill to open.
* **Open**: a strip along the bottom (*Bottom*) or a column on the right (*Side*; the page narrows to make room). *Collapse* returns to the bar. Left: the clock (*Advance to next deadline*, *+1 day*, *+7 days*, *Go to date* which moves to 11:30 on a date, *Reset clock*), "Switched on" chips, and **Scenario events · by hand** (every button the checklists use, and a few more). Middle: **Next:** the presenter's hint and its buttons. Right: the checklist.
* **Simple | Complex** at the top picks the scenario. Both checklists are worked out from the backend's data on every refresh (documents, runs, requirements, deadline rows, payment items, the fault switches): nothing is stored in the browser, so they are right after a reload or when someone else clicked. A step's button is disabled with its reason when the claim can't take it (hover it).

Sign in as **Rachel Kim** (the examiner, $250,000 authority) for everything except approvals. The complex scenario never needs Monica, but the Documents screen shows what happens if you try to review as her.

## The simple scenario, click by click (about 5 minutes)

Open the panel, tab **Simple**. Follow *Next:* — it is the same list.

| # | Click | What appears | What happened, and what to say |
|---|---|---|---|
| 1 | **New life claim** (Intake tab, or the button). Caller: tick "date of birth" and "policy number", answer Yes to "May we tell Tom Bright how the claim is going?", Continue. The deceased: Continue. Policies: tick the read-back, Continue. Beneficiaries: *Fill sample answers*, "anyone else": No, Continue. Review: tick the read-back, *Submit claim*, *Submit and watch* | The claim opens on **Workflow & SLA**. Status "Received · intake running", then "Gathering evidence" in about 2 s. The run `orch-<claim>-intake` with 6 steps, 4 letters in Communications | One transaction saved the notice, parties, lines, four requirements, seven deadline rows and an outbox event, and returned. **Then** Temporal ran the intake: policies in force, sanctions, duplicate check, routing (LF-01, Rachel), acknowledgement, packets, agent notice. Every letter has an idempotency key |
| 2 | **Log the welcome call** (Work on this claim) | The item disappears; the *First contact* service level reads Met | No workflow: a Postgres transaction closed the `first_contact_by` row |
| 3 | **Requirements**: open the death certificate, *Accept requirement…*, *Accept*. Then Diane's statement | *Accepted*; each follow-up row closes without firing | Accepting closes the requirement's waiting row in the same transaction |
| 4 | **Advance to next deadline** | Mark's follow-up row fires: a `deadline-<row>` run appears, a reminder letter, a new "Follow up again" row | The Temporal Schedule's dispatcher (every 5 s) found the due row (`FOR UPDATE SKIP LOCKED`) and started one short workflow with the row's id. This is the only row that fires |
| 5 | For the mock's figures, **Go to date** Thu 8 Oct first (see below). Then accept Mark's statement | The claim moves to **In review**; `decision_due` and `review_target` rows appear | The last requirement completing proof of loss is in the accept transaction: no workflow waits for it |
| 6 | **Decision** → *Record decision & clear payment* → *Confirm* | Two locked records (base line, rider closed as not payable). The claim is Approved; Payments shows two cleared items | One transaction: decision locked, items cleared, rows closed, outbox event. Then `event-<decisionId>` sent the approval letters (APR-LIFE-01 ×2, the rider explanation, the agent) |
| 7 | (Optional) **Payments**: hold an item with a reason, release it | The 412 if the item changed under you | ETags on every write |
| 8 | **+1 day** (or the checklist's button) to the pay day | The daily run pays within seconds in the demo (its trigger is on); else *Run payment run now* | The payment run is a batch, **no Temporal**. It pays, closes the claim, and writes an event; `event-<outbox id>` sends the confirmations and the closing letter |
| 9 | **Workflow & SLA**, **History**, **Communications** | Closed; all seven steps done; the service levels Met | Look at the runs, the swimlane and the deadline rows |

**The figures depend on the day you decide.** The mock decides on Thu 8 Oct and pays Fri 9 Oct: 20 days of interest, **$100,191.78** each, **$200,383.56**. The clock starts at the machine's real date, so use *Go to date* (pick 8 Oct 2026, click it) before step 5 if you want those. On the day I ran it (Tue 29 Sep, no *Go to date*), Mark's follow-up fired on Fri 9 Oct, the pay date was Mon 12 Oct, 23 days, **$100,220.55** each. The API computes the interest; the screens never do.

The end state of a natural-causes run (Workflow & SLA): **4 workflow runs** (the intake, Mark's `deadline-<row>`, the decision's `event-<id>` and the payment's `event-<id>`), **12 letters**, **11 deadline rows**, $200,441.10 paid in that run (see below).

The accident variant (manner "Accident" on the deceased step) needs a police report and records $400,000 plus interest, above Rachel's authority: the decision goes *awaiting approval*, Rachel cannot approve (403), and **Monica Reyes** (Sign in as) approves it on the same screen or on the Team board.

## The complex scenario, click by click (about 15 minutes)

Open the panel, tab **Complex: things bounce back**. It has 20 steps; each hint below is what the checklist says, and the right-hand column is what to say. Dates are the mock's (decision Mon 12 Oct, pay Tue 13 Oct) and work while the machine's date is before Fri 2 Oct 2026.

**Bounce 1: a worker stalls mid intake**

| Click | What appears | Say |
|---|---|---|
| **Stall the worker** (checklist) | A chip "Worker will stall once" | The next intake's acknowledgement step will do its work and then hang, as a worker killed in a deploy would |
| **New life claim** … *Submit and watch* (as in the simple scenario) | "Received · intake running" for about 35 s | **While you wait (about 32 s): "Steps 1 to 4 ran. Step 5 sent the letters and never reported back. Temporal times an activity out after 30 s and schedules it again. The workflow's history has the results of steps 1 to 4, so they do not run again. And the letters carry idempotency keys, so nobody gets two."** |
| Workflow & SLA → **Workflow runs** | The intake run is open: "Retried · 2 attempts", the step with a badge "2 attempts · retried", the note, "took 32.1 s" | "One step, two attempts, nothing sent twice: 3 letters, once each" |
| **Log the welcome call** | First contact Met | (Keeps the overdue check quiet.) |

**Bounce 2: Diane's W-9 fails the IRS check**

| Click | What appears | Say |
|---|---|---|
| **Diane's W-9 · TIN typo** (checklist) | The W-9 is **Not enough · TIN mismatch** on Requirements; the correction follow-up (due in 7 days) is in the plan; Documents has the row (taxpayer number `***-**-6798`) and a link to `event-<uuid>` | **"'No match' is an answer, not an error. The activity returned normally, so Temporal did not retry. One IRS check. Postgres kept the requirement open and wrote the correction chase."** Open the run: steps Check the taxpayer ID (1 attempt), Mark not enough, Ask for a corrected W-9 |
| **Corrected W-9 arrives** | The statement is Accepted; two W-9 documents (not enough, accepted), each with its own workflow; the correction row closed early | "A new event, a new workflow that knows nothing about the first try" |

**Bounce 3: a photocopy, a rejection, a letter that will not send**

| Click | What appears | Say |
|---|---|---|
| **Photocopied certificate arrives** | Requirements: "Under review · examiner" with a *Review it* link. Documents: the review panel (why, review-by date, Rachel's work item) | "The rules cannot accept a photocopy, so the workflow gave it to Rachel and **ended**. Waiting for a person is a work item and a deadline row, not a sleeping workflow" |
| (Optional) sign in as **Monica** and open Documents | Accept and Reject disabled: "Only the examiner reviews a document" | Then sign in as Rachel again |
| **Letters service down** | Chip "Letters service DOWN" | |
| Documents → type a reason → **Reject document** | The document is Rejected; below it, "Rachel Kim rejected it… Then the letter workflow ran: `event-…` (Running)" | "Her decision is in Postgres already: the requirement is requested again, a new 10-day follow-up is written" |
| Wait about 30 s | The run turns **Failed after retries** (red) on Documents and on Workflow & SLA: step "Send it · 5 attempts · gave up", the error, an **Ops task**, the exception strip "Workflow failed" | **While you wait (about 30 s): "Temporal retries the send at 2, 4, 8 and 16 seconds, then stops as the retry policy says. The run is marked failed and its last step opens an ops task. Nothing was lost: only the letter is waiting."** |
| **Letters service back**; then **Re-run this workflow** on the failed run | Run 2 appears with a "run 2" chip and links to and from run 1; the ops task closes; the exception clears. Run 1 stays red | "Same workflow id, so still one workflow per event: ID-reuse policy `ALLOW_DUPLICATE_FAILED_ONLY` allows it only because run 1 failed. Same idempotency key: **one** certified-copy letter" |
| **Certified copy arrives** | Two certificates: the photocopy Rejected, the original Accepted | |

**Bounce 4: Mark is late**

| Click | What appears | Say |
|---|---|---|
| **Advance to next deadline** | Mark's follow-up fires (a `deadline-<row id>` run, a reminder, "Follow up again") | "The only row that fires. Every other row closed early because the thing happened first" |
| **Mark's statement + W-9 arrives** | The claim is **In review** | "The last requirement: proof of loss completes in that transaction" |

**Decision and payment**

| Click | What appears | Say |
|---|---|---|
| **Move the clock to Mon 12 Oct**, then Decision → *Record decision & clear payment* → *Confirm* | Two items cleared: **$100,230.13 + $100,230.14**, pay date Tue 13 Oct; the header says "Cleared $200,460.27 = $200,000.00 proceeds + $460.27 interest" | 24 days at 3.5%: $460.27; the odd cent goes to the last payee |
| **Move the clock to the pay day** | The daily run pays both and closes the claim (Closed, first time) | The payment run is a batch |

**Bounce 5: the bank returns Mark's payment**

| Click | What appears | Say |
|---|---|---|
| **Bank returns Mark's payment** | Nothing changes yet (the panel's clock chip is the only sign) | The bank's returns file now lists Mark's EFT: R02, account closed |
| **Process the bank returns** | Mark's item is **Returned · R02**; a few seconds later the claim is **Reopened · payment returned** (tag, exception strip) | "The returns batch changes the payment item and writes an event. It never touches the claim. A workflow reopens it, asks Mark, tells Rachel and writes the row that waits for his details" |
| **Mark gives a new account** | Payments: the returned item links to a new **Cleared** replacement of $100,230.14 ($100,000.00 + $230.14) | "Paid items are never edited: the replacement is a new item" |
| **Move the clock to the pay day** | The replacement is paid; the claim is **Closed** again | |

**The end state** (Workflow & SLA, and the Overview header "Paid $200,460.27 = $200,000.00 proceeds + $460.27 interest"):

| | Mock | Live run |
|---|---|---|
| Workflow runs | 14 (1 failed, then run 2 under the same id) | **14**: 1 intake, 1 deadline, 12 event; 13 completed, 1 failed, run 2 of it completed |
| Deadline rows | 16: 1 fired, 1 skipped, 14 closed early | **16**: 1 fired, 1 skipped (the status letter), 14 closed early, none open |
| Letters | 19, none twice | **19**, every one sent, none twice |
| Paid | $200,460.27 | **$200,460.27** = $100,230.13 + $100,230.14 |
| Closes | 2 | **2** ("Claim closed" twice, "Claim reopened" once) |

The Deadline rows tab labels the new kinds (`document_review_by` "Examiner reviews a document", `bank_details_by` "Payee gives new bank details"), and the service-level table has the two that exist only on this path (review a document, reissue a payment). The swimlane has a **Batch** lane: the payment runs, the returns job, the overdue check.

## What to point at in the Temporal UI (http://localhost:8233)

Temporal holds only what needs an outside system; the claim is in Postgres. In the namespace `default`:

* **Workflows.** The dispatcher Schedule adds a `deadline-dispatcher-<time>` workflow every 5 s, which buries the list. Paste this into the filter box: `WorkflowType != "DeadlineDispatcherWorkflow"`. After the complex scenario it says **14 Workflows, 13 completed, 1 failed**: the mock's number.
* **`orch-<claim number>-intake`** (`LifeIntakeWorkflow`): the intake. In its history the `LifeIntake_SendAcknowledgementAndPackets` activity is scheduled once, and its **ActivityTaskStarted event shows attempt 2** about 32 s later, with the last failure "activity StartToClose timeout".
* **`event-<uuid>`**: one per thing that happened (`DocumentReceivedWorkflow`, `DocumentRejectedWorkflow`, `DecisionRecordedWorkflow`, `PaymentConfirmedWorkflow`, `PaymentReturnedWorkflow`, `PaymentMethodUpdatedWorkflow`). The uuid is the outbox event's id; the web app's run list shows what each one is.
* **The failed run and run 2.** `DocumentRejectedWorkflow` `event-<uuid>` appears **twice**: one **Failed** (the send activity's five attempts) and one **Completed** (run 2), same workflow id, different run ids. Open the failed one to see the activity's retries.
* **`deadline-<uuid>`** (`RequirementFollowUpWorkflow`): Mark's reminder; the uuid is the deadline row's id, so starting it twice does nothing.
* **Schedules** → `claims-deadline-dispatcher`: the Schedule (every 5 s here, every minute by default) that finds due rows and starts one workflow each.
* What is **not** there: no workflow for the payment run (a batch) or for waiting on Rachel, Diane or the bank: those are deadline rows and work items. No workflow is open between events.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `demo up` refuses to start, naming a port | 5173, 8080, 7233 or 8233 is taken by something else. Stop it, or set `DEMO_WEB_PORT`, `DEMO_API_PORT`, `DEMO_TEMPORAL_PORT`, `DEMO_TEMPORAL_UI_PORT`. It never touches a server it did not start |
| "no Postgres answers on 127.0.0.1:5432" | Start Postgres, or Docker (it falls back to a compose Postgres), or set `DEMO_PG_HOST/PORT/USER/PASSWORD` |
| The panel says "Demo controls not enabled on this backend" | The API was not started with `Claims:Dev:Controls=true` (`demo up` does it) |
| A clock button says the clock is already past a date | **The clock only moves forward.** For a second take, `./claims.sh demo down && ./claims.sh demo up` (new database, new clock, empty Temporal) |
| "Could not open the claim", or the queue is empty after a restart | The database is recreated on every `up`; the old claim number is gone. Take a new notice |
| A second intake for Castellano holds at "needs review" | The duplicate-claim check found the first one. Restart for a fresh database (the presenter's take is one claim per database) |
| A step seems stuck after moving the clock | The dispatcher Schedule ticks every 5 s and the payment run's trigger every 3 s; wait 10 s. The checklist says when it is waiting |
| The complex checks say the backend's clock is past 2 Oct | The story's dates (decision Mon 12 Oct) need a clock before Fri 2 Oct 2026. After that it still runs, but the pay date and figures differ, and the checklist stops offering *Move the clock to Mon 12 Oct* |
| A button is disabled | Hover it: the reason is the tooltip (no open requirement, no paid payment, not the examiner) |
| "Letters service DOWN" is still on | Click *Letters service back* (or the by-hand event). The chip is the reminder |
| The Temporal UI is empty | It is in memory and starts empty on every `up`; take a claim first |
| A wrong click | Nothing is undone: the backend never edits a locked decision or a paid item. Restart the demo |

## Honest limits

* **Stubs, not integrations:** letters, the IRS, the bank, and the document intake are simulated (see above). The bank's account check says "closed" for an account ending 0000; the IRS stub matches any nine-digit number.
* **The stall is simulated in-process.** One worker: attempt 2 ran on the same worker while attempt 1 was still hanging. A worker process really killed, or attempt 2 landing on a *different* worker, was **not** exercised.
* **Time is virtual and in memory.** Only forward. Some audit columns (`createdAt`, `recordedAt`) still show real time; everything a business rule compares or the screens show as "when it happened" uses the virtual clock.
* **Not built** (the panel or the screen says so, it never makes data up): approve in part, deny and corrections to a decision (422); **Return to examiner**; notes, tasks and the assistant on a live claim; calls other than the welcome call; composing letters; adding requirements; a document store, viewer or upload; a payee-facing form for new bank details (a scenario event stands in); a workflow that reminds a payee about `bank_details_by` (the overnight check raises it to the owner); reopening for any reason but a returned payment; authentication; the competing-claimant, interpleader and evidence-never-arrives variations of the mock.
* **History actor names.** The backend records some events with a raw handle (`rachel`) and newer ones with the name; the web app shows staff names either way, and labels the dev logins (`ops` is "Claims operations", `portal.dev` "Claimant portal").
* **Verified against a copy of the backend** on a throwaway Postgres and Temporal on other ports; `./claims.sh demo up` itself was not run for this guide.

## Checks

From `web/`, each against a fresh backend with `Claims:Dev:Controls=true` and the web app started with `VITE_API_BASE=/api`:

```
node scripts/live-simple-check.mjs <dir> [natural|accident]   # the simple scenario
node scripts/live-events-check.mjs <dir>                     # every scenario-event button
node scripts/live-complex-check.mjs <dir>                    # this guide's complex scenario, by clicking, about 3 minutes
```

`live-complex-check.mjs` follows the table above with about 190 assertions (the retried step's 2 attempts and 32 s, one IRS check and no retry, the failed run's 5 attempts and ops task, run 2 and one certified-copy letter, the mock's figures and counts, and that the panel never covers the claim at 1440x900 and 1280x800).
