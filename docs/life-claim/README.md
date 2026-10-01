# Life claim: from intake to payment

This page follows one individual life death claim from the phone call to the closed claim. It covers:

- the steps the claim goes through
- who acts at each step
- the service levels (SLAs) and the deadline rows that enforce them
- which Temporal workflows run

The same claim runs live in the mock app, so you can click through it while you read.

For a harder path, where things come back and the claim goes back and forth with Temporal, see [Things bounce back](README-back-and-forth.html), an HTML page with a swimlane and a sequence diagram per bounce.

The design behind it is in [backend-architecture.md](../backend-architecture.md):

- Postgres holds the claim's state and every deadline.
- Temporal runs short workflows.
- A daily batch run pays.

## See it in the mock

```
cd web
npm run dev          # http://localhost:5173
```

1. Open **http://localhost:5173/#/intake/life**. You can also use ⌘K → *New life claim intake*, or *Start a different claim* on the disability intake.
2. Walk the five steps: Caller → The deceased → Policies → Beneficiaries → Review & submit.
   - Tick the two identity checks and answer the agent-consent question.
   - On Beneficiaries, *Fill sample answers* adds Mark's details.
3. **Submit.** You land on the claim's **Workflow & SLA** section, where the intake run plays step by step.
4. Press **Play next** to move the claim forward one event at a time, or **Play to the end**.
   - Each step writes what the backend would: deadline rows, workflow runs, letters, history.
   - At Proof of loss complete, you can instead record the decision yourself on the claim's **Decision** section.
5. To see other paths, choose **Accident** or **Pending** as the manner of death in step 2. Below it, *How the mock plays this claim* offers four more: **Evidence never arrives**, **A service level is missed**, **A competing claimant appears** and **Things bounce back** (see [Variations](#variations)). Where a person has to decide, Play next stops and the panel offers the choices.

Reload the page to reset the demo data.

## The story

Robert Castellano, 71, died at home on **Sat 19 Sep 2026** of natural causes.

- **Policy:** whole life policy WL-0804419, $200,000, issued 2008, with an accidental death rider.
- **Lapsed policy:** a 2011 term policy lapsed in 2019, so nothing is payable on it.
- **Beneficiaries:** his wife Linda was the primary beneficiary but died in 2021. The contingent beneficiaries, his children Diane and Mark, take 50% each.
- **Notice:** Diane calls on **Fri 25 Sep** to report the death.

## The flow at a glance

```
 Notice of death ─► Intake checks ─► Gathering evidence ─► Proof of loss ─► Decision ─► Paid ─► Closed
  phone call         Temporal          requirements +       complete          examiner     daily    event
  25 Sep             orchestration     follow-up deadlines  7 Oct             8 Oct        batch    workflow
                     25 Sep            25 Sep – 7 Oct       starts the                     9 Oct    9 Oct
                                                            decision clock
```

Every change follows the same four steps:

1. Something asks for the change: a person, a document, a deadline or batch.
2. The claim's state machine checks it.
3. **One Postgres transaction** saves the new state, the audit entry, the deadline rows and an outbox event.
4. If there is follow-on work that calls anything outside Postgres, the outbox relay starts a short Temporal workflow to do it.

## Swimlane: who does what

Read each row across. Times are the claim's own clock in the mock.

| When | People | Outside systems | Claims API + Postgres | Temporal | Batch |
|---|---|---|---|---|---|
| Fri 25 Sep 10:03 | Diane calls; intake takes the notice | | Notice saved + outbox event **E-9001**, one transaction | | |
| Fri 25 Sep 10:03 | | Policy admin, sanctions screening (one retry), email / text / portal invites | Claim, 4 requirements, deadline rows **D-701–D-707**, status *Gathering evidence* | **orch-L-26-043310-intake**, 10 steps, 41 s | |
| Mon 28 Sep 09:40 | Rachel (examiner) calls Diane | | Call logged · **D-703** closed · first contact met | *No workflow: nothing outside Postgres* | |
| Tue 29 Sep 14:10 | Diane e-signs her statement and W-9 | Portal | Document + event **E-9002** · requirement accepted · **D-706** closed | **event-E-9002**: classify, check TIN, match, accept | |
| Thu 1 Oct 11:25 | | Mail room scans the death certificate | Document + event **E-9003** · accepted · **D-705** closed | **event-E-9003**: classify, read, compare, accept | |
| Mon 5 Oct 08:00 | | Reminder to Mark by email and text | **D-707** comes due · dispatcher marks it dispatched · **D-708** written | **deadline-D-707**: re-check, remind, next row | |
| Wed 7 Oct 19:40 | Mark signs his statement and W-9 | Portal | Accepted · **D-708** closed · **proof of loss complete** · **D-709** and **D-710** written · status *In review* | **event-E-9004**: classify, check TIN, match, accept | |
| Thu 8 Oct 11:30 | Rachel records the decision: approve | | Decision locked (v1) · 2 payment items cleared · **D-709**, **D-710** met · **D-704** skipped · **D-711** written | **event-E-9005**: approval letters, rider explanation, agent | Items wait for the next run |
| Fri 9 Oct 02:00 | | Bank accepts the file | Items paid · event **E-9006** | *Not involved* | Daily payment run: 2 EFTs, $200,383.56 |
| Fri 9 Oct 02:06 | | Emails to Diane and Mark | Status *Closed* · interest flagged for the 1099-INT | **event-E-9006**: confirmations, closing letter | January tax-form batch picks up the 1099-INT |

## The steps

| # | Step | Claim status | Header stage | Who or what moves it | What gets written |
|---|---|---|---|---|---|
| 1 | Notice of death | Received | Intake | Intake person submits the phone notice | Notice, outbox event |
| 2 | Intake checks and set-up | Gathering evidence | Evidence | Intake orchestration (Temporal) | Claim, benefit lines, requirements, deadline rows, letters |
| 3 | Gathering evidence | Gathering evidence | Evidence | Each document starts an event workflow; missing items trigger follow-up deadlines | Documents, accepted requirements, closed or new follow-up rows |
| 4 | Proof of loss complete | In review | Review | The last requirement accepted, in the same transaction | Decision-due and review-target rows, decision workbench, examiner's work item |
| 5 | Decision | Approved · paying | Payment | Examiner, within authority; team lead above it | Locked decision record per benefit line, payment items, rows closed, letters |
| 6 | Paid | Approved · paying | Payment | Daily payment run (batch) | Items paid, outbox event |
| 7 | Closed | Closed | Closed | Payment-confirmed event workflow | Closed status, closing letter, 1099-INT flag |

## Service levels

Each service level is enforced by a row in the deadlines table. A Temporal Schedule runs the dispatcher every minute. When a row comes due, the dispatcher starts `deadline-<row>`, which re-checks the claim and acts. Most rows close early because the thing already happened.

State values are **examples** until the state rules table exists. Confirm them with compliance.

| Service level | Rule | Source | Clock starts | Row kind | If it comes due | In the clean run |
|---|---|---|---|---|---|---|
| First contact with the claimant | 1 business day | Internal | Notice | `first_contact_by` | Alert to the examiner and team lead | Met Mon 28 Sep (D-703) |
| Acknowledge the claim | 15 days | State rule | Notice | `acknowledge_by` | Sends the acknowledgement if the intake run didn't | Met the same day; D-701 never fired |
| Claim forms to each beneficiary | 15 days | State rule | Notice | `forms_by` | Sends the packets | Met the same day; D-702 never fired |
| Status letter while undecided | Every 30 days | State rule | Notice, then each letter | `status_letter` | Sends a letter saying what is outstanding, then writes the next row | Stopped 8 Oct (decided); D-704 skipped |
| Requirement follow-up | 10 days (30 for a medical examiner) | Internal | Request | `requirement_follow_up` | Reminder, then the next follow-up row | D-707 fired 5 Oct for Mark's statement |
| Decide after proof of loss | 30 days | State rule | Proof of loss complete | `decision_due` | Alert, then escalation to the team lead | Met 8 Oct; due 6 Nov (D-709) |
| Examiner review | 5 business days | Internal | Proof of loss complete | `review_target` | Alerts the team lead | Met 8 Oct; due 14 Oct (D-710) |
| Pay after approval | 2 business days | Internal | Approval | `payment_due` | Alert to payments operations | Met 9 Oct; due 12 Oct (D-711) |
| Interest on the proceeds | 3.5% a year, date of death to payment | State rule | Date of death | Computed on the payment item | n/a | 20 days, $383.56 |

## Deadline rows in the clean run

| Row | Kind | Due | What happened |
|---|---|---|---|
| D-701 | `acknowledge_by` | Sat 10 Oct | Closed by the intake run when the acknowledgement was sent |
| D-702 | `forms_by` | Sat 10 Oct | Closed by the intake run when the packets were sent |
| D-703 | `first_contact_by` | Mon 28 Sep | Closed by Rachel's call |
| D-704 | `status_letter` | Sun 25 Oct | Skipped: the claim was decided first |
| D-705 | `requirement_follow_up` (certificate) | Mon 5 Oct | Closed: arrived 1 Oct |
| D-706 | `requirement_follow_up` (Diane's statement) | Mon 5 Oct | Closed: arrived 29 Sep |
| D-707 | `requirement_follow_up` (Mark's statement) | Mon 5 Oct | **Fired** 5 Oct 08:00: reminder sent, D-708 written |
| D-708 | `requirement_follow_up` (Mark, again) | Thu 15 Oct | Closed: arrived 7 Oct |
| D-709 | `decision_due` | Fri 6 Nov | Met: decided 8 Oct |
| D-710 | `review_target` | Wed 14 Oct | Met: decided 8 Oct |
| D-711 | `payment_due` | Mon 12 Oct | Met: paid in the 9 Oct run |

That's 11 rows. One fired, one was skipped, and nine closed without firing.

The [variations](#variations) add three row kinds:

- `requirement_expiry`: written at set-up, 75 days after the request. When it fires, the examiner waives the requirement or closes the claim incomplete.
- `dispute_response_by`: 30 days for a competing claimant to give proof.
- `hold_review`: the review date on a share held under an interpleader.
- `document_review_by` and `bank_details_by`: the examiner reviews a document the rules can't accept (1 business day), and a beneficiary gives new bank details after a returned payment (10 days). Only *Things bounce back* writes them.

A row that fires late shows *Breached · fired late*, and its service level stays red even after the late work is done.

## Workflow runs

Every run is short and keyed by its ID, so a second start with the same ID is rejected. Each step calls one system and is retried by Temporal if it fails. The run ends by saving its results to Postgres in one transaction.

| Run | Type | Started by | Steps |
|---|---|---|---|
| `orch-L-26-043310-intake` | Orchestration | Outbox relay, event E-9001 | Find policies · confirm in force · contestable and suicide periods · screen beneficiaries (retried once) · existing claim · death records · route · pick the requirement set · send acknowledgement and packets · tell the agent |
| `event-E-9002` | Event workflow | Outbox relay, document saved | Store · classify · check signature and TIN · match · compare · proof complete? (no) |
| `event-E-9003` | Event workflow | Outbox relay, document saved | Store · classify · read the certificate · match · compare · proof complete? (no) |
| `deadline-D-707` | Deadline workflow | Dispatcher, D-707 due | Re-check it's still missing · send the reminder |
| `event-E-9004` | Event workflow | Outbox relay, document saved | Store · classify · check TIN · match · compare · proof complete? (yes) |
| `event-E-9005` | Event workflow | Outbox relay, decision saved | Approval letters · rider explanation · deliver · tell the agent |
| `event-E-9006` | Event workflow | Outbox relay, items paid | Payment confirmations · all lines settled? · closing letter · tell the agent |

**No workflow is needed for Postgres-only work:**

- logging the welcome call
- proof of loss complete
- locking the decision and creating payment items

Each of these happens inside the API's transaction.

## What the intake decides

**Checks**, shown on the right of the intake page:

- The policy is in force on the date of death, allowing a 31-day grace period.
- The policy is past its 2-year contestable period and suicide exclusion.
- Lapsed policies are listed as having nothing payable.
- If the primary beneficiary died first, the contingent beneficiaries take their shares.
- There is no other claim for the same death.
- The death master file has no match yet, so the certified certificate is the proof.

**Route** (rules, not suggestions):

| Rule | Track | When |
|---|---|---|
| LF-01 | Fast track life | Natural causes, past the contestable period, payable ≤ $500,000, adult beneficiaries, no competing claimant, death in the US |
| LF-02 | Standard life | Anything else. The route lists every reason. |

**Requirement set**, picked by product, manner of death and payees:

- Certified death certificate
- Claimant statement and W-9 from each payee
- Proof that the primary beneficiary died first. In this story it is **already on file** from her own claim, so it's met at set-up.
- An accident adds the police or accident report, for the rider.
- A pending cause adds the amended certificate from the medical examiner.

## Variations

Choose them in step 2 of the mock, or read what changes:

| Variation | What changes | In the mock |
|---|---|---|
| **Accident** | Police report required; the rider becomes payable; route LF-02. $400,000 plus interest is above Rachel's $250,000 authority, so the decision waits for the team lead's approval. | Yes: 9 steps, Monica approves, $400,767.12 paid |
| **Cause pending** | Amended certificate required from the medical examiner, with a 30-day follow-up; route LF-02. Status letter 1 fires on day 30 because proof isn't complete; the rider closes once the cause is final (natural). | Yes: 10 steps, letter 1 sent 25 Oct, paid 30 Oct |
| **Evidence never arrives** | Follow-up rows keep firing (reminder, then a call task). Status letters every 30 days list what's missing. After the expiry row, the requirement can be waived with a reason or the claim closed incomplete. | Yes: Mark's statement never comes. Follow-ups fire 5 Oct (reminder), 15 Oct (call task for Rachel) and 14 Nov (final notice, monthly by then); status letters go 25 Oct and 24 Nov; the expiry row D-708 (75 days) fires Wed 9 Dec and the claim stops for Rachel's choice. **Waive** (with a reason): proof complete 9 Dec, decided 10 Dec, paid 11 Dec, $201,591.78, 11 steps plus the choice, 16 rows. **Close incomplete**: 9 steps plus the choice, 13 rows, letters to both, nothing paid, reopens if it arrives |
| Contestable policy (under 2 years) | Adds a contestable review (application and medical records) before any decision; can end in rescission and a premium refund. | Not in this story; see the Okafor claim |
| Minor beneficiary | Share held until a custodian or guardian is documented. The hold is its own row with a review date. | See the Okafor claim |
| **Competing claimant** | Standard track; payment waits for resolution or interpleader. The affected share is held; the rest pays. | Yes, as in the Greaves claim (tag *Dispute*): on Fri 2 Oct Dana Reyes's attorney claims Mark's half, saying a 2024 form names her; none is on file. The claim moves to LF-02, Mark's $100,000 is held, and D-708 gives her until Sun 1 Nov. Diane's half is decided 8 Oct and paid 9 Oct, $100,191.78. On 1 Nov the claim stops for Rachel's choice. **Resolve** in Mark's favour: decision v2, Mark paid Tue 3 Nov, $100,431.51, 10 steps plus the choice, then closed. **Interpleader**: filed Mon 2 Nov, 9 steps plus the choice, the $100,000 stays held (about $9.59 a day interest), the claim stays open on a `hold_review` row D-713 due Thu 17 Dec |
| Death abroad | Apostilled certificate; standard track. | See the Lang claim |
| **Things bounce back** | Five things come back: a worker restarts mid-run, a W-9 fails the IRS check, the certificate is a photocopy, the letters service goes down, and the bank returns a payment. Each bounce is saved in Postgres first and followed by a new short workflow; nothing waits in Temporal. | Yes: 14 steps, 14 runs (`event-E-9004` fails after 5 attempts and ops re-runs it as run 2), 16 rows (only D-707 fires). Paid 13 Oct; Mark's EFT is returned 15 Oct (R02) and the claim reopens; his replacement is paid Tue 20 Oct, $100,230.14, and the claim closes again. Explained in [README-back-and-forth.html](README-back-and-forth.html) |
| **A service level is missed** | The row fires, the deadline workflow alerts, and the nightly check lists it; the breach shows red on the Workflow & SLA page. | Yes: the dispatcher's Schedule is paused, so first contact (D-703, due Mon 28 Sep) isn't chased. The nightly check lists it Tue 29 Sep 02:00 and starts `deadline-D-703` a day late: alert to Rachel and Monica, breach recorded, exception *First contact missed* in the strip, red header clock. Rachel calls at 09:15. The service level stays red (*Breached · met 29 Sep, 1 day late*); 8 steps, paid 9 Oct, $200,383.56 |

## Where it lives in the code

| What | File |
|---|---|
| Intake page (5 steps, call bar, Claim so far) | [web/src/pages/LifeIntake.tsx](../../web/src/pages/LifeIntake.tsx) |
| Intake rules, requirement set, submit | [web/src/api/lifeIntake.ts](../../web/src/api/lifeIntake.ts) |
| The story's policy-admin data | [web/src/api/fixtures/lifeIntake.ts](../../web/src/api/fixtures/lifeIntake.ts) |
| Workflow record: service levels, deadline rows, runs, swimlane, play forward | [web/src/api/lifeFlow.ts](../../web/src/api/lifeFlow.ts) |
| Workflow & SLA section | [web/src/claim/sections/Workflow.tsx](../../web/src/claim/sections/Workflow.tsx) |
| End-to-end check with screenshots and assertions | [web/scripts/life-flow-check.mjs](../../web/scripts/life-flow-check.mjs): `node scripts/life-flow-check.mjs <dir> [natural\|accident\|pending\|evidence\|evidence-close\|late\|competing\|competing-interpleader\|bounce]`. Exits non-zero if the claim doesn't end where the manner says |

## What the mock simplifies

- **Nothing runs in the background.** The mock does the workflows' work inline when you submit or press *Play next*. The real API returns as soon as its transaction commits, and the workflows follow.
- **The claim has its own clock.** Playing forward moves it; the rest of the mock stays on Fri 25 Sep 2026. History entries carry the claim's dates.
- **Business days skip weekends only.** Holidays aren't modelled.
- **A person's choice is a button.** Where a real examiner would act, the mock stops Play next and offers the choices on the Workflow page: waive with a reason or close incomplete, resolve or file an interpleader. The choice is applied on the claim's clock.
- **The variations are scripted.** Dana Reyes, her 2024 form, the paused dispatcher and the 75-day expiry are invented to make the demo run. The real claim doesn't know them in advance.
- **Rule values are examples:** 15 and 30 days, 3.5% interest, the $500,000 fast-track limit. The real values come from product configuration and the state rules table, by effective date.
