/**
 * The life claim workflow, as the backend design runs it (docs/backend-architecture.md, v2):
 *
 *   - Postgres holds the claim's state, every deadline (a row in the deadlines table) and an outbox.
 *   - Temporal runs short workflows: the intake orchestration, one event workflow per thing that happened,
 *     and one deadline workflow per deadline that comes due (started by the dispatcher every minute).
 *   - Postgres-only work (a call logged, a decision locked, payment items created) needs no workflow.
 *   - The daily payment run is batch, independent of Temporal.
 *
 * GET /claims/{id}/workflow returns this record: service levels, deadline rows, workflow runs and a
 * swimlane of what happened. The mock also scripts what the outside world does next, so the claim can be
 * played forward one happening at a time (POST /mock/claims/{id}/workflow:next — mock only).
 */
import { collection, fail, newId, respond } from './store'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import { patchClaim } from './claims'
import { requirements, isOpen, type PlanStep } from './requirements'
import { documents } from './documents'
import { addCommunication, communications } from './communications'
import { logEvent } from './history'
import { addTask, tasks } from './tasks'
import { completeWork, workItems } from './work'
import { payments, schedulePayment, setPaymentProfile, type PaymentHold } from './payments'
import { addWorkbench, decisions, registerDecisionHandler, removeWorkbenches, type RecordResult } from './decisions'
import { USERS } from './fixtures/users'
import { addBusinessDays, addDays, daysFrom, fmtDate, plural } from '../lib/dates'
import { fmtMoney, sum } from '../lib/money'
import type { LifeRoute, Variation } from './lifeIntake'
import type { ClaimClock, ClaimException, ISODate, StageStep, Tone, User } from './types'

// ---------------------------------------------------------------- Types

/** Interest on death proceeds, a year — an example value; the real rate comes from the state rules table. */
export const INTEREST_RATE = 0.035

export type Milestone = 'notice' | 'checks' | 'evidence' | 'proof' | 'decision' | 'paid' | 'closed'

export const MILESTONES: { key: Milestone; label: string; note: string }[] = [
  { key: 'notice', label: 'Notice of death', note: 'Saved with an outbox event' },
  { key: 'checks', label: 'Intake checks', note: 'Temporal orchestration' },
  { key: 'evidence', label: 'Gathering evidence', note: 'Requirements and follow-ups' },
  { key: 'proof', label: 'Proof of loss complete', note: 'Starts the decision clock' },
  { key: 'decision', label: 'Decision', note: 'Examiner, within authority' },
  { key: 'paid', label: 'Paid', note: 'Daily payment run' },
  { key: 'closed', label: 'Closed', note: 'Closing letter, 1099-INT' },
]

export type FlowStatus = 'gathering' | 'inReview' | 'awaitingApproval' | 'approved' | 'held' | 'reopened' | 'closed' | 'closedIncomplete'

export const STATUS_TEXT: Record<FlowStatus, string> = {
  gathering: 'Gathering evidence',
  inReview: 'In review',
  awaitingApproval: 'Awaiting approval',
  approved: 'Approved · paying',
  held: 'Open · share on hold',
  reopened: 'Reopened · payment returned',
  closed: 'Closed',
  closedIncomplete: 'Closed incomplete',
}

/** The requirement expires this many days after it was asked for, if it never arrives (the 'evidence' variation). */
export const EXPIRY_DAYS = 75

/** The person who says the same proceeds are theirs (the 'competing' variation). */
const CLAIMANT = { name: 'Dana Reyes', via: 'a letter from her attorney', basis: 'a 2024 change-of-beneficiary form' }

export interface FlowReq {
  id: string
  key: 'certificate' | 'statement' | 'primary' | 'report' | 'amended'
  name: string
  from: string
  /** Days until the follow-up deadline fires if it hasn't arrived. */
  followUpDays: number
  onFile: boolean
  beneficiaryId?: string
  /** Requested from the person who called. */
  callerIs: boolean
}

export interface ServiceLevel {
  id: 'contact' | 'ack' | 'forms' | 'status' | 'decide' | 'review' | 'pay' | 'interest' | 'docReview' | 'reissue'
  name: string
  rule: string
  source: 'State rule' | 'Internal'
  /** What starts the clock. */
  starts: string
  start?: ISODate
  due?: ISODate
  kind: 'deadline' | 'recurring' | 'accruing'
  metOn?: string
  /** A recurring clock that stopped because the claim was decided or closed. */
  stopped?: string
  note?: string
  /** Met, but after the due date: the breach stays red. */
  lateDays?: number
  /** Live mode: the row is still open and its due time has passed (the date alone can't say so on the due day). */
  pastDue?: boolean
}

export interface DeadlineRow {
  id: string
  /** The row's kind as the deadlines table stores it. */
  kind: 'acknowledge_by' | 'forms_by' | 'first_contact_by' | 'status_letter' | 'requirement_follow_up' | 'requirement_expiry' | 'decision_due' | 'review_target' | 'payment_due' | 'dispute_response_by' | 'hold_review' | 'document_review_by' | 'bank_details_by'
  what: string
  due: ISODate
  status: 'open' | 'done' | 'skipped'
  /** True when it came due and the dispatcher started a deadline workflow for it. */
  fired?: boolean
  /** True when it fired late: the nightly check found it past due, and the service level was breached. */
  breached?: boolean
  closedAt?: string
  result?: string
  sla?: ServiceLevel['id']
  reqId?: string
  /** Live mode: what the deadlines table itself says. */
  live?: {
    state: 'open' | 'dispatched' | 'done' | 'skipped'
    dueAt: string
    originalDueAt: string
    extensionReason?: string
    attempt: number
    lastOutcome?: string
    lastError?: string
    workflowId?: string
    closedBy?: string
    /** Open and past its due time. */
    pastDue: boolean
    /** True for the kinds a deadline workflow handles today; the others stay open when they come due. */
    hasWorkflow: boolean
    /** For a kind no workflow fires: what closes the row ('the payment run'). */
    closes?: string
  }
}

export interface RunStep {
  label: string
  detail: string
  /** The system the step talks to. */
  system: string
  /** failed = the retries ran out (the run failed). */
  state: 'done' | 'retried' | 'skipped' | 'failed'
  /** Live mode: how many times Temporal ran the step (1 = first time). */
  attempts?: number
  /** Live mode: what Temporal did for this step, in plain words. */
  note?: string
}

export interface WorkflowRun {
  id: string
  type: 'Orchestration' | 'Event workflow' | 'Deadline workflow'
  name: string
  startedBy: string
  at: string
  took: string
  steps: RunStep[]
  /** Written back to Postgres, in one transaction, at the end. */
  saved: string[]
  /** A second run of the same workflow ID (allowed only after the first failed). */
  runNo?: number
  /** Failed after its retries; its last step records the failure. */
  failed?: boolean
  /** What Temporal itself did here, in plain words (the 'bounce' variation explains each run). */
  temporal?: string
  /** Live mode: the backend's run record. */
  live?: {
    status: 'running' | 'completed' | 'skipped' | 'needs_review' | 'failed'
    runId: string
    error?: string
    workflowId: string
    /** The backend's id for this run (what a re-run names). */
    id: string
    canRerun?: boolean
    /** Real time the run took, from its first activity to its end (ms). */
    elapsedMs?: number
    /** For a re-run: the key (see runKey) of the failed run it re-runs. */
    rerunOfKey?: string
    /** For a failed run: the key of the re-run that followed it. */
    rerunKey?: string
  }
}

/** Unique per run: the workflow ID, plus the run number from the second run on. */
export function runKey(r: Pick<WorkflowRun, 'id' | 'runNo'>): string {
  return r.runNo && r.runNo > 1 ? `${r.id}#${r.runNo}` : r.id
}

export type Lane = 'people' | 'outside' | 'postgres' | 'temporal' | 'batch'

export const LANES: { key: Lane; label: string; sub: string }[] = [
  { key: 'people', label: 'People', sub: 'Beneficiaries, examiner, team lead' },
  { key: 'outside', label: 'Outside systems', sub: 'Policy admin, vendors, mail, bank' },
  { key: 'postgres', label: 'Claims API + Postgres', sub: 'State, deadlines, outbox' },
  { key: 'temporal', label: 'Temporal', sub: 'Short workflows' },
  { key: 'batch', label: 'Batch', sub: 'Payment run, nightly check' },
]

export interface LaneRow {
  id: string
  at: string
  title: string
  cells: Partial<Record<Lane, string[]>>
  runId?: string
}

export type HappeningKind = 'call' | 'arrive' | 'followUp' | 'statusLetter' | 'decide' | 'approve' | 'payRun' | 'nightly' | 'expiry' | 'adverse' | 'disputeDue' | 'choose' | 'docReview' | 'opsRerun' | 'bankReturn' | 'newAccount'

/** Something that happens to the claim: a person acts, evidence arrives, a deadline comes due, batch runs. */
export interface Happening {
  id: string
  kind: HappeningKind
  date: ISODate
  time: string
  title: string
  who: string
  reqId?: string
  via?: string
  /** A follow-up that fires: when the next follow-up row falls due (it lengthens after the call task). */
  nextDue?: ISODate
  /** An arrival the rules can't accept ('bounce' variation): a W-9 that fails the TIN match, a photocopied certificate. */
  bounce?: 'tin' | 'photocopy'
  /** The second try at a requirement that bounced: a corrected W-9, the certified copy. */
  again?: boolean
}

/** One way out of a fork: the claim waits for a person to pick it (mock only). */
export interface ForkChoice {
  key: 'waive' | 'closeIncomplete' | 'resolve' | 'interplead'
  label: string
  detail: string
  /** The person must give a reason (waiving a requirement). */
  needsReason?: boolean
}

/** The claim can't go on by itself: the examiner decides. Play next stops here until a choice is made. */
export interface Fork {
  title: string
  text: string
  choices: ForkChoice[]
  /** When the person acts, on the claim's clock. */
  actAt: string
}

/** A share that isn't paid because a second person claims it. */
export interface FlowHold {
  payeeId: string
  payee: string
  claimant: string
  share: number
  /** The share of the proceeds, before interest. */
  amount: number
  since: ISODate
  /** claimed = waiting for proof from the claimant · toResolve = the response window closed · interpleader = the court decides. */
  state: 'claimed' | 'toResolve' | 'interpleader'
  reviewOn?: ISODate
}

export interface FlowStart {
  claimId: string
  insured: string
  noticeAt: string
  dateOfDeath: ISODate
  manner: 'natural' | 'accident' | 'pending'
  /** Mock only: how the outside world behaves (see lifeIntake.ts). */
  variation: Variation
  policyRef: string
  issued: ISODate
  paidTo: ISODate
  face: number
  adb?: { amount: number; payable: boolean }
  /** Face plus the rider when it pays. */
  total: number
  route: LifeRoute
  reqs: FlowReq[]
  payees: { id: string; name: string; share: number; packet: 'portal' | 'mail' }[]
  caller: string
  consent: boolean
  agent: string
  policiesFound: number
  lapsedFound: number
}

export interface LifeFlow extends FlowStart {
  /** Live mode: built from the backend's records (see api/live). There is no script to play. */
  live?: {
    statusLabel: string
    statusTone: Tone
    /** What is still in flight, in words: 'the intake workflow is running', '2 follow-up rows are due'. Empty when idle. */
    inFlight: string[]
    /** Where the clock comes from: the backend's virtual clock, or this browser's. */
    clockSource: 'virtual' | 'browser'
    /** The claim's open work items (GET /work-items): the welcome call, 'Record decision', an approval. `version` is the ETag the completion needs. */
    workItems?: { id: string; action: string; why: string; dueOn: string; waitingOn: string; section: string; ownerId: string; version: number; welcomeCall: boolean }[]
  }
  id: string
  /** The claim's clock in the mock: when the latest happening took place. */
  now: string
  status: FlowStatus
  reached: Partial<Record<Milestone, string>>
  serviceLevels: ServiceLevel[]
  deadlines: DeadlineRow[]
  runs: WorkflowRun[]
  lanes: LaneRow[]
  /** What is still to happen, in order. */
  script: Happening[]
  done: Happening[]
  seq: { event: number; row: number }
  payDate?: ISODate
  /** Interest in the items cleared or paid so far. */
  interest?: number
  letters: number
  fork?: Fork
  hold?: FlowHold
  /** How a competing claim was resolved, once it has been. */
  resolved?: string
  /** The 'bounce' variation: the letter that failed to send, the photocopy, the returned payment. */
  bounced?: { letterId?: string; failedRun?: string; photocopyId?: string; returned?: { payeeId: string; payee: string; amount: number; itemId: string; on: ISODate }; reissued?: boolean }
}

export const flows = collection<LifeFlow>([])

// ---------------------------------------------------------------- Reads

/** GET /claims/{id}/workflow */
export function getFlow(claimId: string): Promise<LifeFlow | null> {
  if (isLiveId(claimId)) return live.getFlow(claimId)
  return respond(flows.get(claimId) ?? null)
}

// ---------------------------------------------------------------- Helpers

const first = (name: string) => name.split(' ')[0]
const day = (iso: string) => fmtDate(iso.slice(0, 10))
const dayTime = (iso: string) => `${fmtDate(iso.slice(0, 10), { weekday: true })} ${iso.slice(11, 16)}`

function nextEvent(f: LifeFlow): string {
  f.seq.event++
  return `E-${9000 + f.seq.event}`
}

function nextRowId(f: LifeFlow): string {
  f.seq.row++
  return `D-${700 + f.seq.row}`
}

function addRow(f: LifeFlow, row: Omit<DeadlineRow, 'id' | 'status'> & { status?: DeadlineRow['status'] }): DeadlineRow {
  const r: DeadlineRow = { id: nextRowId(f), status: 'open', ...row }
  f.deadlines.push(r)
  return r
}

function closeRow(f: LifeFlow, r: DeadlineRow, result: string, status: 'done' | 'skipped' = 'done', fired = false): void {
  r.status = status
  r.closedAt = f.now
  r.result = result
  if (fired) r.fired = true
}

function sl(f: LifeFlow, id: ServiceLevel['id']): ServiceLevel {
  return f.serviceLevels.find((s) => s.id === id)!
}

function lane(f: LifeFlow, title: string, cells: LaneRow['cells'], runId?: string, at = f.now): void {
  f.lanes.push({ id: newId('ln'), at, title, cells, runId })
}

function run(f: LifeFlow, r: Omit<WorkflowRun, 'at'> & { at?: string }): WorkflowRun {
  const full: WorkflowRun = { at: f.now, ...r }
  f.runs.push(full)
  return full
}

export function interestFor(total: number, days: number): number {
  return Math.round(total * INTEREST_RATE * Math.max(0, days) / 365 * 100) / 100
}

/** Splits an amount by share; the last payee takes the rounding. */
function split(amount: number, shares: number[]): number[] {
  const parts = shares.map((s) => Math.floor(amount * s) / 100)
  parts[parts.length - 1] = Math.round((amount - sum(parts.slice(0, -1))) * 100) / 100
  return parts
}

const LIFE_STAGES = ['Intake', 'Evidence', 'Review', 'Decision', 'Payment', 'Closed']

export function lifeStages(current: number): StageStep[] {
  return LIFE_STAGES.map((label, i) => ({ key: label.toLowerCase(), label, state: i < current ? 'done' : i === current ? 'current' : 'todo' }))
}

function examiner(f: LifeFlow): User {
  return USERS.find((u) => u.id === f.route.examinerId) ?? USERS[0]
}

const TEAM_LEAD = USERS.find((u) => u.role === 'teamLead')!

/** The requirement that never arrives in the 'evidence' variation: the second beneficiary's statement. */
function missingReq(f: Pick<LifeFlow, 'variation' | 'reqs'>): FlowReq | undefined {
  return f.variation === 'evidence' ? f.reqs.find((r) => !r.onFile && r.key === 'statement' && !r.callerIs) : undefined
}

/** The beneficiary whose share the competing claimant wants: the one who isn't on the call. */
function heldPayee(f: Pick<LifeFlow, 'payees' | 'caller'>): LifeFlow['payees'][number] {
  return f.payees.find((p) => p.name !== f.caller) ?? f.payees[f.payees.length - 1]
}

/** Header clocks, computed on the claim's own clock. */
function clocksFor(f: LifeFlow): ClaimClock[] {
  const today = f.now.slice(0, 10)
  if (f.status === 'closedIncomplete') return []
  const out: ClaimClock[] = []
  const decisionRow = f.deadlines.find((d) => d.kind === 'decision_due')
  if (f.reached.decision && decisionRow) {
    out.push({ id: 'c1', label: 'Decision · state limit', kind: 'deadline', state: 'met', due: decisionRow.due, progress: 1 })
  } else if (decisionRow && f.reached.proof) {
    const left = daysFrom(today, decisionRow.due)
    out.push({ id: 'c1', label: 'Decision · state limit', kind: 'deadline', state: 'running', due: decisionRow.due, progress: (30 - left) / 30, valueText: `${fmtDate(decisionRow.due)} · ${plural(left, 'day')}` })
  } else {
    const letter = f.deadlines.find((d) => d.kind === 'status_letter' && d.status === 'open')
    if (letter) {
      const left = daysFrom(today, letter.due)
      out.push({ id: 'c1', label: 'Status letter · state', kind: 'deadline', state: 'running', due: letter.due, progress: (30 - left) / 30, valueText: `next ${fmtDate(letter.due)} · ${plural(left, 'day')}` })
    }
  }
  // A held share keeps accruing until it is released; the rest stopped at payment.
  const end = f.hold ? today : f.reached.paid?.slice(0, 10) ?? today
  const days = daysFrom(f.dateOfDeath, end)
  out.push({ id: 'c2', label: `Interest since ${fmtDate(f.dateOfDeath)}`, kind: 'accruing', state: 'running', start: f.dateOfDeath, valueText: f.hold ? `${plural(days, 'day')} · ${fmtMoney(interestFor(f.hold.amount, days))} on the held half` : f.resolved && f.reached.paid ? `${plural(days, 'day')} · ${fmtMoney(f.interest ?? 0)} paid in two runs` : `${plural(days, 'day')} · ${fmtMoney(interestFor(f.total, days))}${f.reached.paid ? ' paid' : ''}` })
  // A missed service level stays red, even once the late work is done.
  const contact = sl(f, 'contact')
  if (contact.due && (contact.lateDays || (!contact.metOn && today > contact.due))) {
    const late = contact.lateDays ?? daysFrom(contact.due, today)
    out.push({ id: 'c3', label: 'First contact · internal', kind: 'deadline', state: 'breached', due: contact.due, progress: 1, valueText: `due ${fmtDate(contact.due)} · ${contact.lateDays ? 'met ' : ''}${plural(late, 'day')} late` })
  }
  return out
}

/** The claim summary in the context panel, rewritten as the claim moves. */
function summarize(f: LifeFlow, text: string): void {
  patchClaim(f.claimId, (c) => ({ summary: { ...c.summary, text, asOf: `${fmtDate(f.now.slice(0, 10))} ${f.now.slice(11, 16)} · workflow` } }))
}

function save(f: LifeFlow): void {
  flows.update(f.id, f)
  patchClaim(f.claimId, { clocks: clocksFor(f) })
}

// ---------------------------------------------------------------- Start (the intake orchestration)

/** Called by the life intake submit, after the claim is set up. Builds the workflow record and its script. */
export function startLifeFlow(s: FlowStart): void {
  const f: LifeFlow = {
    ...s,
    id: s.claimId,
    now: s.noticeAt,
    status: 'gathering',
    reached: { notice: s.noticeAt, checks: s.noticeAt, evidence: s.noticeAt },
    serviceLevels: [],
    deadlines: [],
    runs: [],
    lanes: [],
    script: [],
    done: [],
    seq: { event: 0, row: 0 },
    letters: 0,
  }
  const n = s.noticeAt.slice(0, 10)
  const ev = nextEvent(f)
  const open = s.reqs.filter((r) => !r.onFile)
  const onFile = s.reqs.filter((r) => r.onFile)
  const payeeNames = s.payees.map((p) => first(p.name)).join(' and ')

  const ack = addRow(f, { kind: 'acknowledge_by', what: `Acknowledge the claim to ${first(s.caller)}`, due: addDays(n, 15), sla: 'ack' })
  closeRow(f, ack, 'Closed by the intake run when the acknowledgement was sent — never had to fire')
  const forms = addRow(f, { kind: 'forms_by', what: `Claim forms to ${payeeNames}`, due: addDays(n, 15), sla: 'forms' })
  closeRow(f, forms, 'Closed by the intake run when the packets were sent — never had to fire')
  const contact = addRow(f, { kind: 'first_contact_by', what: `Examiner calls ${first(s.caller)}`, due: addBusinessDays(n, 1), sla: 'contact' })
  const letter = addRow(f, { kind: 'status_letter', what: 'Status letter 1, if still undecided', due: addDays(n, 30), sla: 'status' })
  open.forEach((r) => addRow(f, { kind: 'requirement_follow_up', what: `Follow up: ${r.name}`, due: addDays(n, r.followUpDays), reqId: r.id }))
  // A request that never arrives also expires. Only the variation that plays it writes the row.
  const missing = missingReq(f)
  if (missing) addRow(f, { kind: 'requirement_expiry', what: `Request expires: ${missing.name}`, due: addDays(n, EXPIRY_DAYS), reqId: missing.id })

  f.serviceLevels = [
    { id: 'contact', name: 'First contact with the claimant', rule: '1 business day from notice', source: 'Internal', starts: 'Notice of death', start: n, due: contact.due, kind: 'deadline' },
    { id: 'ack', name: 'Acknowledge the claim', rule: '15 days from notice', source: 'State rule', starts: 'Notice of death', start: n, due: ack.due, kind: 'deadline', metOn: s.noticeAt },
    { id: 'forms', name: 'Claim forms to each beneficiary', rule: '15 days from notice', source: 'State rule', starts: 'Notice of death', start: n, due: forms.due, kind: 'deadline', metOn: s.noticeAt },
    { id: 'status', name: 'Status letter while undecided', rule: 'Every 30 days until decided', source: 'State rule', starts: 'Notice of death', start: n, due: letter.due, kind: 'recurring' },
    { id: 'decide', name: 'Decide after proof of loss', rule: '30 days from complete proof', source: 'State rule', starts: 'Proof of loss complete', kind: 'deadline' },
    { id: 'review', name: 'Examiner review', rule: '5 business days from complete proof', source: 'Internal', starts: 'Proof of loss complete', kind: 'deadline' },
    { id: 'pay', name: 'Pay after approval', rule: '2 business days from approval', source: 'Internal', starts: 'Approval', kind: 'deadline' },
    { id: 'interest', name: 'Interest on the proceeds', rule: `${(INTEREST_RATE * 100).toFixed(1)}% a year, date of death to payment`, source: 'State rule', starts: 'Date of death', start: s.dateOfDeath, kind: 'accruing' },
  ]
  const bounce = s.variation === 'bounce'
  if (bounce) {
    f.serviceLevels.push(
      { id: 'docReview', name: 'Review a document the rules can’t accept', rule: '1 business day', source: 'Internal', starts: 'Document needs review', kind: 'deadline' },
      { id: 'reissue', name: 'Reissue a returned payment', rule: '2 business days from new bank details', source: 'Internal', starts: 'New bank details', kind: 'deadline' },
    )
  }

  const orch = `orch-${s.claimId}-intake`
  const ends = `${Number(s.issued.slice(0, 4)) + 2}${s.issued.slice(4)}`
  run(f, {
    id: orch,
    type: 'Orchestration',
    name: 'Intake checks and set-up',
    startedBy: `Outbox relay · event ${ev} (notice of death saved)`,
    took: bounce ? '1 min 14 s' : '41 s',
    temporal: bounce ? 'A deploy restarted worker A in the middle of step 9, before it reported back. When the activity timed out, Temporal ran step 9 again on worker B. Worker B first replayed the workflow’s history, so steps 1 to 8 were not run again. The letters carry idempotency keys, so the retry didn’t send anything twice.' : undefined,
    steps: [
      { label: 'Find the insured’s policies', detail: `${s.policiesFound} found by name, date of birth and SSN${s.lapsedFound ? ` · ${s.lapsedFound} lapsed, nothing payable` : ''}`, system: 'Policy administration', state: 'done' },
      { label: 'Confirm in force on the date of death', detail: `${s.policyRef} premium paid to ${fmtDate(s.paidTo, { year: true })}`, system: 'Policy administration', state: 'done' },
      { label: 'Check contestable period and suicide exclusion', detail: `Both ended ${fmtDate(ends, { year: true })}`, system: 'Rules', state: 'done' },
      { label: 'Screen the beneficiaries', detail: 'Timed out once; Temporal retried after 2 s · all clear', system: 'Sanctions screening', state: 'retried' },
      { label: 'Look for an existing claim', detail: 'None for this death', system: 'Postgres', state: 'done' },
      { label: 'Check death records', detail: 'No death master file match yet · the certificate proves it', system: 'Death records service', state: 'done' },
      { label: 'Route the claim', detail: `${s.route.track} → ${s.route.examiner} · rule ${s.route.rule}`, system: 'Rules', state: 'done' },
      { label: 'Pick the requirement set', detail: `${s.reqs.length} requirements${onFile.length ? ` · ${onFile.length} already on file` : ''}`, system: 'Product configuration', state: 'done' },
      bounce
        ? { label: 'Send the acknowledgement and claim packets', detail: 'The worker restarted mid-step; Temporal ran it again on another worker · the letters service saw the same idempotency keys, so nothing went twice', system: 'Letters and notifications', state: 'retried' }
        : { label: 'Send the acknowledgement and claim packets', detail: `${first(s.caller)} by email and text · ${s.payees.filter((p) => p.name !== s.caller).map((p) => `${first(p.name)} by ${p.packet === 'mail' ? 'mail' : 'portal invite'}`).join(' · ') || 'no one else'}`, system: 'Letters and notifications', state: 'done' },
      { label: 'Tell the agent of record', detail: s.consent ? `${s.agent} · status only` : `No consent from ${first(s.caller)}`, system: 'Notifications', state: s.consent ? 'done' : 'skipped' },
    ],
    saved: [
      `Claim ${s.claimId} and ${s.adb ? 2 : 1} benefit line${s.adb ? 's' : ''}`,
      `${s.reqs.length} requirements${onFile.length ? `, ${onFile.length} met from our records` : ''}`,
      `${f.deadlines.length} deadline rows: ${f.deadlines[0].id} to ${f.deadlines[f.deadlines.length - 1].id} (2 closed at once)`,
      'Status → Gathering evidence · owner Rachel Kim',
    ],
  })

  lane(f, `${first(s.caller)} reports the death by phone`, {
    people: [`${first(s.caller)} calls; the intake person takes the notice`],
    postgres: ['Notice saved', `Outbox event ${ev} — same transaction`],
  })
  lane(f, 'Intake checks and set-up', {
    outside: ['Policy admin: policies found', 'Sanctions: clear after 1 retry', ...(bounce ? ['Worker A restarted: step 9 ran again on worker B'] : []), 'Email, text and portal invites sent'],
    temporal: [`${orch}`, bounce ? '10 steps · 1 min 14 s · 2 workers' : '10 steps · 41 s'],
    postgres: [`Claim, ${s.reqs.length} requirements`, `Deadlines ${contact.id}–${f.deadlines[f.deadlines.length - 1].id}`, 'Status: Gathering evidence'],
  }, orch)

  f.script = buildScript(f)
  flows.insert(f)
  patchClaim(f.claimId, { clocks: clocksFor(f), stage: lifeStages(1) })
}

// ---------------------------------------------------------------- Script (what the outside world does next)

/**
 * Mock only: when each open requirement arrives, and which deadlines therefore come due first.
 * One beneficiary's statement is late, so its follow-up deadline fires; a pending cause of death waits
 * weeks for the medical examiner, so the 30-day status letter fires too. The variations change the script:
 *   evidence   — that statement never arrives; follow-ups, a call task, status letters and the expiry row all fire
 *   late       — the dispatcher is paused, so first contact is missed and the nightly check finds it
 *   competing  — a second person claims one beneficiary's share before the decision
 */
function buildScript(f: LifeFlow): Happening[] {
  if (f.variation === 'bounce') return bounceScript(f)
  const n = f.noticeAt.slice(0, 10)
  const ex = examiner(f)
  const contactRow = f.deadlines.find((d) => d.kind === 'first_contact_by')!
  const isLate = f.variation === 'late'
  const callDate = isLate ? addBusinessDays(contactRow.due, 1) : addBusinessDays(n, 1)
  const list: Happening[] = [
    isLate
      ? { id: newId('hp'), kind: 'call', date: callDate, time: '09:15', title: `${ex.name} calls ${first(f.caller)}, a day late`, who: 'Examiner' }
      : { id: newId('hp'), kind: 'call', date: callDate, time: '09:40', title: `${ex.name} calls ${first(f.caller)}`, who: 'Examiner' },
  ]
  if (isLate) list.push({ id: newId('hp'), kind: 'nightly', date: addDays(contactRow.due, 1), time: '02:00', title: `Nightly check: ${contactRow.id} is past due; the dispatcher was paused`, who: 'Batch' })
  const missing = missingReq(f)
  const open = f.reqs.filter((r) => !r.onFile && r !== missing)
  const late = open.find((r) => r.key === 'statement' && !r.callerIs)
  const arrivals = open.map((r) => {
    const payee = f.payees.find((p) => p.id === r.beneficiaryId)
    const viaPayee = payee?.packet === 'mail' ? 'mail' : 'portal'
    if (r === late) return { r, date: addDays(n, r.followUpDays + 2), time: '19:40', via: viaPayee, title: `${first(r.from)} signs his claimant statement and W-9`, who: 'Beneficiary' }
    switch (r.key) {
      case 'statement': return { r, date: addBusinessDays(n, r.callerIs ? 2 : 3), time: '14:10', via: viaPayee, title: `${first(r.from)} e-signs her claimant statement and W-9`, who: 'Beneficiary' }
      case 'certificate': return { r, date: addBusinessDays(n, 4), time: '11:25', via: 'mail', title: 'Certified death certificate arrives by mail', who: 'Mail room' }
      case 'report': return { r, date: addBusinessDays(n, 5), time: '15:05', via: 'fax', title: 'The sheriff’s office faxes the accident report', who: 'Outside' }
      default: return { r, date: addDays(n, 33), time: '10:15', via: 'mail', title: 'Amended certificate arrives: the final cause is natural', who: 'Outside' }
    }
  })
  for (const a of arrivals) {
    list.push({ id: newId('hp'), kind: 'arrive', date: a.date, time: a.time, title: a.title, who: a.who, reqId: a.r.id, via: a.via })
    let due = addDays(n, a.r.followUpDays)
    let k = 1
    while (due < a.date) {
      list.push({ id: newId('hp'), kind: 'followUp', date: due, time: '08:00', title: `Follow-up deadline comes due${k > 1 ? ` again (${k})` : ''}: ${a.r.name}`, who: 'Dispatcher', reqId: a.r.id })
      due = addDays(due, a.r.followUpDays)
      k++
    }
  }
  // A request that never arrives: two 10-day follow-ups (a reminder, then a call task), then monthly, then it expires.
  let expiry: ISODate | undefined
  if (missing) {
    expiry = addDays(n, EXPIRY_DAYS)
    const fires = [addDays(n, missing.followUpDays), addDays(n, missing.followUpDays * 2), addDays(n, missing.followUpDays * 2 + 30)]
    fires.forEach((date, i) => list.push({ id: newId('hp'), kind: 'followUp', date, time: '08:00', title: `Follow-up deadline comes due${i > 0 ? ` again (${i + 1})` : ''}: ${missing.name}`, who: 'Dispatcher', reqId: missing.id, nextDue: fires[i + 1] ?? addDays(date, 30) }))
    list.push({ id: newId('hp'), kind: 'expiry', date: expiry, time: '08:00', title: `The request expires: ${missing.name}`, who: 'Dispatcher', reqId: missing.id })
  }
  if (f.variation === 'competing') {
    list.push({ id: newId('hp'), kind: 'adverse', date: addBusinessDays(n, 5), time: '10:20', title: `${CLAIMANT.name}’s attorney writes: she claims ${first(heldPayee(f).name)}’s half`, who: 'Outside' })
  }
  const proof = expiry ?? arrivals.map((a) => a.date).sort().at(-1) ?? n
  let letterDue = addDays(n, 30)
  let k = 1
  while (letterDue <= proof) {
    list.push({ id: newId('hp'), kind: 'statusLetter', date: letterDue, time: '08:00', title: `Status letter ${k} comes due — the claim is still undecided`, who: 'Dispatcher' })
    letterDue = addDays(letterDue, 30)
    k++
  }
  if (!missing) list.push(...decisionTail(f, proof))
  if (f.variation === 'competing') {
    const adverse = list.find((h) => h.kind === 'adverse')!
    list.push({ id: newId('hp'), kind: 'disputeDue', date: addDays(adverse.date, 30), time: '08:00', title: `${CLAIMANT.name}’s response deadline comes due: no proof has arrived`, who: 'Dispatcher' })
  }
  return list.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
}

/**
 * The 'bounce' variation: nothing is lost, but things come back. The caller's W-9 fails the IRS check and is corrected;
 * the certificate is a photocopy, rejected by the examiner, and the letter asking for a certified copy fails until ops
 * re-runs it; after payment the bank returns the second beneficiary's EFT, the claim reopens and the replacement is paid.
 * Each bounce is a new happening and, where something outside Postgres is called, a new short workflow.
 */
function bounceScript(f: LifeFlow): Happening[] {
  const n = f.noticeAt.slice(0, 10)
  const ex = examiner(f)
  const list: Happening[] = []
  const add = (h: Omit<Happening, 'id'>) => list.push({ id: newId('hp'), ...h })
  const open = f.reqs.filter((r) => !r.onFile)
  const cert = open.find((r) => r.key === 'certificate')
  const own = open.find((r) => r.key === 'statement' && r.callerIs)
  const late = open.find((r) => r.key === 'statement' && !r.callerIs)
  const via = (r: FlowReq) => (f.payees.find((p) => p.id === r.beneficiaryId)?.packet === 'mail' ? 'mail' : 'portal')
  const arrivals: ISODate[] = []
  add({ kind: 'call', date: addBusinessDays(n, 1), time: '09:40', title: `${ex.name} calls ${first(f.caller)}`, who: 'Examiner' })
  if (own) {
    add({ kind: 'arrive', date: addBusinessDays(n, 2), time: '14:10', title: `${first(own.from)} e-signs her statement and W-9; the IRS check fails`, who: 'Beneficiary', reqId: own.id, via: via(own), bounce: 'tin' })
    const fixed = addBusinessDays(n, 5)
    add({ kind: 'arrive', date: fixed, time: '18:05', title: `${first(own.from)} uploads a corrected W-9`, who: 'Beneficiary', reqId: own.id, via: via(own), again: true })
    arrivals.push(fixed)
  }
  if (cert) {
    const d = addBusinessDays(n, 4)
    add({ kind: 'arrive', date: d, time: '11:25', title: 'The death certificate arrives by mail: a photocopy', who: 'Mail room', reqId: cert.id, via: 'mail', bounce: 'photocopy' })
    add({ kind: 'docReview', date: d, time: '15:20', title: `${ex.name} rejects the photocopy; the letter fails to send`, who: 'Examiner', reqId: cert.id })
    add({ kind: 'opsRerun', date: d, time: '16:05', title: 'Claims ops re-runs the failed letter workflow', who: 'Ops' })
    const copy = addBusinessDays(n, 10)
    add({ kind: 'arrive', date: copy, time: '12:10', title: 'The certified copy arrives by mail', who: 'Mail room', reqId: cert.id, via: 'mail', again: true })
    arrivals.push(copy)
  }
  // Everything else arrives as on the designed path. The second beneficiary is late, so a follow-up fires.
  for (const r of open.filter((x) => x !== cert && x !== own)) {
    const date = r === late ? addDays(n, r.followUpDays + 2) : r.key === 'report' ? addBusinessDays(n, 5) : r.key === 'amended' ? addDays(n, 33) : addBusinessDays(n, 3)
    const title = r === late ? `${first(r.from)} signs his claimant statement and W-9` : r.key === 'report' ? 'The sheriff’s office faxes the accident report' : r.key === 'amended' ? 'Amended certificate arrives: the final cause is natural' : `${first(r.from)} signs a claimant statement and W-9`
    add({ kind: 'arrive', date, time: '19:40', title, who: r.key === 'statement' ? 'Beneficiary' : 'Outside', reqId: r.id, via: r.key === 'statement' ? via(r) : r.key === 'report' ? 'fax' : 'mail' })
    arrivals.push(date)
    for (let due = addDays(n, r.followUpDays), k = 1; due < date; due = addDays(due, r.followUpDays), k++) {
      add({ kind: 'followUp', date: due, time: '08:00', title: `Follow-up deadline comes due${k > 1 ? ` again (${k})` : ''}: ${r.name}`, who: 'Dispatcher', reqId: r.id })
    }
  }
  const proof = arrivals.sort().at(-1) ?? n
  for (let due = addDays(n, 30), k = 1; due <= proof; due = addDays(due, 30), k++) {
    add({ kind: 'statusLetter', date: due, time: '08:00', title: `Status letter ${k} comes due — the claim is still undecided`, who: 'Dispatcher' })
  }
  const tail = decisionTail(f, proof)
  list.push(...tail)
  const paid = tail.find((h) => h.kind === 'payRun')!.date
  const payee = heldPayee(f)
  const back = addBusinessDays(paid, 2)
  const acct = addBusinessDays(back, 2)
  add({ kind: 'bankReturn', date: back, time: '06:30', title: `The bank returns ${first(payee.name)}’s payment: account closed`, who: 'Batch' })
  add({ kind: 'newAccount', date: acct, time: '20:15', title: `${first(payee.name)} adds a new bank account in the portal`, who: 'Beneficiary' })
  add({ kind: 'payRun', date: addBusinessDays(acct, 1), time: '02:00', title: `The daily payment run pays ${first(payee.name)}’s replacement`, who: 'Batch' })
  return list.sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
}

/** The decision, the team lead's approval when it's above authority, and the payment run, from proof of loss. */
function decisionTail(f: LifeFlow, proof: ISODate): Happening[] {
  const ex = examiner(f)
  const out: Happening[] = []
  const decide = addBusinessDays(proof, 1)
  out.push({ id: newId('hp'), kind: 'decide', date: decide, time: '11:30', title: `${ex.name} records the decision`, who: 'Examiner' })
  const estimate = f.total + interestFor(f.total, daysFrom(f.dateOfDeath, addBusinessDays(decide, 1)))
  if (estimate > ex.payoutLimit) out.push({ id: newId('hp'), kind: 'approve', date: decide, time: '15:10', title: `${TEAM_LEAD.name} approves above ${first(ex.name)}’s authority`, who: 'Team lead' })
  out.push({ id: newId('hp'), kind: 'payRun', date: addBusinessDays(decide, 1), time: '02:00', title: 'The daily payment run pays the beneficiaries', who: 'Batch' })
  return out
}

// ---------------------------------------------------------------- Play forward

/** Mock only — POST /mock/claims/{id}/workflow:next. Applies the next happening and returns it. */
export function playNext(claimId: string): Promise<Happening | null> {
  const cur = flows.get(claimId)
  if (!cur) return fail('This claim has no workflow record')
  const h = cur.script[0]
  if (!h) return respond(null)
  const f = structuredClone(cur)
  f.script = f.script.slice(1)
  f.now = `${h.date}T${h.time}`
  switch (h.kind) {
    case 'call': onCall(f); break
    case 'arrive': onArrive(f, h); break
    case 'followUp': onFollowUp(f, h); break
    case 'statusLetter': onStatusLetter(f); break
    case 'decide': onDecide(f, examiner(f)); break
    case 'approve': onApprove(f); break
    case 'payRun': onPayRun(f); break
    case 'nightly': onNightly(f); break
    case 'expiry': onExpiry(f, h); break
    case 'adverse': onAdverse(f, h); break
    case 'disputeDue': onDisputeDue(f, h); break
    case 'docReview': onDocReview(f, h); break
    case 'opsRerun': onOpsRerun(f, h); break
    case 'bankReturn': onBankReturn(f, h); break
    case 'newAccount': onNewAccount(f, h); break
  }
  f.done.push(h)
  save(f)
  return respond(h)
}

// ---- A person acts: the examiner's welcome call. Postgres only, so no workflow.
function onCall(f: LifeFlow): void {
  const ex = examiner(f)
  const row = f.deadlines.find((d) => d.kind === 'first_contact_by' && d.status === 'open')
  if (row) closeRow(f, row, `Closed by the call at ${f.now.slice(11, 16)} — never had to fire`)
  const contact = sl(f, 'contact')
  contact.metOn = f.now
  // Made after the due date: the service level stays breached (red) and the exception the breach opened is resolved.
  const lateDays = contact.due ? Math.max(0, daysFrom(contact.due, f.now.slice(0, 10))) : 0
  if (lateDays) {
    contact.lateDays = lateDays
    patchClaim(f.claimId, (c) => ({ exceptions: c.exceptions.map((x) => (x.id === 'x-contact' ? { ...x, status: 'resolved' as const, meta: `Met ${plural(lateDays, 'day')} late` } : x)) }))
  }
  addCommunication({ claimId: f.claimId, at: f.now, channel: 'call', direction: 'out', title: `Welcome call to ${first(f.caller)}`, party: `${f.caller} · phone`, detail: 'Explained what we still need, that a decision follows within 30 days of complete proof, and that interest runs from the date of death.', status: { label: 'Logged', tone: 'neutral' } })
  logEvent(f.claimId, { at: f.now, type: 'communication', title: `Welcome call to ${first(f.caller)} · first contact met${lateDays ? ` ${plural(lateDays, 'day')} late` : ''}`, actor: ex.name, detail: row ? `${row.id} closed` : lateDays ? 'The breach stays on the service level for the compliance report' : undefined })
  tasks.where((t) => t.claimId === f.claimId && t.title.startsWith('Welcome call') && !t.done).forEach((t) => tasks.update(t.id, { done: true }))
  completeWork(f.claimId, 'workflow')
  waitingNextStep(f)
  lane(f, `${first(ex.name)} calls ${first(f.caller)}`, {
    people: [`${first(ex.name)} explains the next steps`],
    postgres: ['Call logged', row ? `${row.id} closed · first contact met` : lateDays ? `First contact met ${plural(lateDays, 'day')} late · breach stays on record` : 'First contact met'],
    temporal: ['No workflow — nothing outside Postgres to call'],
  })
}

function waitingNextStep(f: LifeFlow): void {
  const open = requirements.where((r) => r.claimId === f.claimId && isOpen(r))
  if (!open.length) return
  patchClaim(f.claimId, { nextStep: { label: `Waiting on ${open.length} requirement${open.length > 1 ? 's' : ''}`, reason: open.map((r) => r.name.replace('Claimant statement and W-9 · ', 'Statement · ')).join(' · '), section: 'requirements' } })
}

const DOC: Record<FlowReq['key'], { title: (f: LifeFlow, r: FlowReq) => string; type: string; pages: number }> = {
  certificate: { title: (f) => `Certified death certificate — ${f.insured}`, type: 'Death certificate', pages: 1 },
  statement: { title: (_f, r) => `Claimant statement and W-9 — ${r.from}`, type: 'Claimant statement', pages: 4 },
  primary: { title: () => 'Primary beneficiary’s death — on file', type: 'Death certificate', pages: 1 },
  report: { title: () => 'Lake County Sheriff’s Office — accident report', type: 'Police report', pages: 3 },
  amended: { title: (f) => `Amended death certificate — ${f.insured}`, type: 'Death certificate', pages: 1 },
}

// ---- Evidence arrives: saved with an outbox event; an event workflow reads, matches and accepts it.
function onArrive(f: LifeFlow, h: Happening): void {
  const req = f.reqs.find((r) => r.id === h.reqId)!
  if (h.bounce === 'tin') return onTinMismatch(f, h, req)
  if (h.bounce === 'photocopy') return onPhotocopy(f, h, req)
  const ev = nextEvent(f)
  const d = DOC[req.key]
  const title = h.again && req.key === 'statement' ? `Corrected W-9 — ${req.from}` : d.title(f, req)
  const rec = requirements.get(req.id)
  documents.insert({
    id: newId('doc'), claimId: f.claimId, title, docType: d.type, received: h.date, channel: h.via === 'portal' ? 'Portal upload' : h.via === 'fax' ? 'Fax' : 'Mail · scanned',
    pages: d.pages, isNew: false, status: { label: 'Accepted', tone: 'positive' }, satisfies: req.name, requirementId: req.id, from: req.from,
    classifiedAs: { label: d.type, confidence: 0.97 }, readAt: h.time, reviewedBy: 'Rules · matches the notice', benefitLineId: rec?.benefitLineId,
  })
  const rows = f.deadlines.filter((r) => r.reqId === req.id && r.status === 'open')
  rows.forEach((r) => closeRow(f, r, `Closed — arrived ${day(f.now)}`))
  if (rec) {
    const plan: PlanStep[] = [
      ...(rec.plan ?? []).filter((s) => s.state === 'done'),
      { date: h.date, label: `Received by ${h.via} · accepted${h.again ? ' (second try)' : ''}`, note: `event workflow event-${ev}`, state: 'done' },
      ...(rec.plan ?? []).filter((s) => s.state !== 'done').map((s) => ({ ...s, state: 'skipped' as const })),
    ]
    requirements.update(req.id, { state: 'met', status: { label: `Accepted ${fmtDate(h.date)}`, tone: 'positive' }, receivedOn: h.date, waitingOn: undefined, nextAction: undefined, plan })
  }
  if (req.key === 'statement' && req.beneficiaryId) {
    patchClaim(f.claimId, (c) => ({ parties: c.parties.map((p) => (p.id === `p-${req.beneficiaryId}` ? { ...p, status: { label: 'Statement received', tone: 'positive' } } : p)) }))
  }
  if (req.key === 'amended' && f.adb) {
    f.adb = { ...f.adb, payable: false }
    f.manner = 'natural'
    patchClaim(f.claimId, (c) => ({ benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-adb' ? { ...b, status: { label: 'Not payable · natural causes', tone: 'neutral' }, waitingOn: undefined } : b)) }))
  }
  if (req.key === 'report') {
    patchClaim(f.claimId, (c) => ({ benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-adb' ? { ...b, status: { label: 'Report received', tone: 'info' }, waitingOn: 'Decision' } : b)) }))
  }
  logEvent(f.claimId, { at: f.now, type: 'document', title: `Received: ${title}`, actor: `System · event-${ev}`, detail: `By ${h.via} · classified, matched and accepted`, ref: title })
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Requirement met: ${req.name}`, actor: 'System · rules', detail: rows.length ? `${rows.map((r) => r.id).join(', ')} closed` : undefined })

  const left = requirements.where((r) => r.claimId === f.claimId && isOpen(r)).length
  const read: Record<FlowReq['key'], RunStep> = {
    certificate: { label: 'Read the certificate', detail: `Died ${fmtDate(f.dateOfDeath, { year: true })} · ${f.manner === 'pending' ? 'cause pending' : f.manner === 'accident' ? 'accident' : 'natural causes'}`, system: 'Extraction', state: 'done' },
    statement: { label: 'Check the signature and taxpayer ID', detail: 'E-signature valid · IRS TIN match ok', system: 'TIN matching', state: 'done' },
    primary: { label: 'Read the record', detail: 'On file', system: 'Postgres', state: 'done' },
    report: { label: 'Read the report', detail: 'Single-vehicle accident · no other party', system: 'Extraction', state: 'done' },
    amended: { label: 'Read the final cause', detail: 'Natural causes · hypertensive heart disease', system: 'Extraction', state: 'done' },
  }
  if (h.again && req.key === 'statement') read.statement = { label: 'Check the taxpayer ID again', detail: 'Corrected number · IRS TIN match ok', system: 'TIN matching', state: 'done' }
  if (h.again && req.key === 'certificate') read.certificate = { ...read.certificate, detail: `Raised seal found · certified · ${read.certificate.detail}` }
  const steps: RunStep[] = [
    { label: 'Store the file', detail: 'Object storage · metadata in Postgres', system: 'Document store', state: 'done' },
    { label: 'Classify', detail: `${d.type} · 97%`, system: 'Classifier', state: 'done' },
    read[req.key],
    { label: 'Match to the claim and requirement', detail: `${f.claimId} · ${req.name}`, system: 'Postgres', state: 'done' },
    { label: 'Compare with the notice', detail: req.key === 'statement' ? 'Name and share agree with the designation' : 'Name, date of birth and date of death agree', system: 'Rules', state: 'done' },
  ]
  const saved = ['Document and its fields', `Requirement accepted${rows.length ? ` · ${rows.map((r) => r.id).join(', ')} closed` : ''}`]
  const pgCell = [`Document saved + event ${ev}`, `Accepted${rows.length ? ` · ${rows.map((r) => r.id).join(', ')} closed` : ''}`]
  if (left === 0) {
    const { decision, review } = proofComplete(f)
    steps.push({ label: 'Is proof of loss complete?', detail: 'Yes — every requirement is met', system: 'Postgres', state: 'done' })
    saved.push(`Proof of loss complete · ${decision.id} decide by ${day(decision.due)} · ${review.id} review by ${day(review.due)}`, 'Decision workbench built · work item for Rachel Kim', 'Status → In review')
    pgCell.push(`Proof complete · ${decision.id}, ${review.id} written`, 'Status: In review')
  } else {
    steps.push({ label: 'Is proof of loss complete?', detail: `Not yet — ${plural(left, 'requirement')} open`, system: 'Postgres', state: 'done' })
    waitingNextStep(f)
  }
  const id = `event-${ev}`
  const temporal = f.variation !== 'bounce' ? undefined
    : h.again ? `A new event, so a new short workflow. ${id} knows nothing about the first try: it reads the requirement from Postgres, finds it waiting for ${req.key === 'statement' ? 'a corrected W-9' : 'a certified copy'}, and accepts it.${left === 0 ? ' This completes proof of loss. No workflow waits for the decision: the decision clock is a deadline row.' : ''}`
      : left === 0 ? 'The last requirement completes proof of loss. No workflow waits for the decision: the decision clock is a deadline row.' : undefined
  run(f, { id, type: 'Event workflow', name: h.again ? `${d.type} received again` : `${d.type} received`, startedBy: `Outbox relay · event ${ev} (document saved)`, took: req.key === 'statement' ? '6 s' : '14 s', steps, saved, temporal })
  const who: Lane = h.via === 'portal' ? 'people' : 'outside'
  lane(f, h.title, {
    [who]: [h.via === 'portal' ? `${first(req.from)} uploads in the portal` : h.via === 'fax' ? 'Fax arrives' : 'Mail room scans it'],
    postgres: pgCell,
    temporal: [id, 'classify, read, match, accept'],
  }, id)
}

/** Postgres-only follow-on of the last requirement: done in the same transaction, no separate workflow. */
function proofComplete(f: LifeFlow): { decision: DeadlineRow; review: DeadlineRow } {
  const today = f.now.slice(0, 10)
  f.reached.proof = f.now
  f.status = 'inReview'
  const decision = addRow(f, { kind: 'decision_due', what: 'Decide the claim', due: addDays(today, 30), sla: 'decide' })
  const review = addRow(f, { kind: 'review_target', what: 'Examiner review done (alerts the team lead if not)', due: addBusinessDays(today, 5), sla: 'review' })
  Object.assign(sl(f, 'decide'), { start: today, due: decision.due })
  Object.assign(sl(f, 'review'), { start: today, due: review.due })
  const ex = examiner(f)
  const payRun = f.script.find((h) => h.kind === 'payRun')
  const payDate = payRun?.date ?? addBusinessDays(today, 2)
  const days = daysFrom(f.dateOfDeath, payDate)
  const interest = interestFor(f.total, days)
  const shares = split(f.total, f.payees.map((p) => p.share))
  const ints = split(interest, f.payees.map((p) => p.share))
  const waived = f.reqs.filter((r) => requirements.get(r.id)?.state === 'waived')
  const held = f.hold ? f.payees.find((p) => p.id === f.hold!.payeeId) : undefined
  const passing = held ? 8 : 9
  addWorkbench({
    claimId: f.claimId,
    benefitLineId: 'bl-cast-wl',
    title: f.adb?.payable ? 'Whole life and accidental death rider' : 'Whole life',
    ref: f.policyRef,
    checksRunAt: f.now,
    checks: [
      { id: 'k1', label: 'In force on the date of death', detail: `Premium paid to ${fmtDate(f.paidTo, { year: true })}`, sources: ['Policy record'], result: 'pass' },
      { id: 'k2', label: 'Past the contestable period and suicide exclusion', detail: `Issued ${fmtDate(f.issued, { year: true })}`, sources: ['Policy record'], result: 'pass' },
      { id: 'k3', label: 'Death certificate accepted', detail: `Died ${fmtDate(f.dateOfDeath, { year: true })} · ${f.manner === 'accident' ? 'accident' : 'natural causes'}`, sources: ['Death certificate'], result: 'pass' },
      { id: 'k4', label: f.adb?.payable ? 'Accidental death rider: report accepted' : 'Accidental death rider: not payable', detail: f.adb?.payable ? 'Single-vehicle accident · no exclusion applies' : 'Natural causes', sources: [f.adb?.payable ? 'Accident report' : 'Death certificate'], result: 'pass' },
      { id: 'k5', label: 'Payees match the beneficiary designation', detail: 'Primary died first · contingents take their shares', sources: ['Designation 3 Mar 2015'], result: 'pass' },
      { id: 'k6', label: 'Claimant statement and W-9 from every payee', detail: waived.length ? `${f.payees.filter((p) => !waived.some((r) => r.beneficiaryId === p.id)).map((p) => first(p.name)).join(' and ')} · ${waived.map((r) => `${first(r.from)} waived`).join(', ')}` : f.payees.map((p) => first(p.name)).join(' and '), sources: ['Claimant statements'], result: 'pass' },
      { id: 'k7', label: 'Sanctions screening clear', detail: 'Screened at intake', sources: ['Intake run'], result: 'pass' },
      held && f.hold
        ? { id: 'k8', label: `One competing claim on ${first(held.name)}’s share`, detail: `${f.hold.claimant} · ${CLAIMANT.basis} isn’t on file · ${first(held.name)}’s share is held`, sources: ['Adverse claim letter', 'Claims index'], result: 'fail' }
        : { id: 'k8', label: 'No other claimant', detail: 'None on file', sources: ['Claims index'], result: 'pass' },
      { id: 'k9', label: 'Interest from the date of death', detail: `${(INTEREST_RATE * 100).toFixed(1)}% a year · ${plural(days, 'day')} to ${fmtDate(payDate)}`, sources: ['State rules'], result: 'pass' },
    ],
    provisions: ['Death benefit · section 2', 'Beneficiary · section 7', ...(f.adb ? ['Accidental death benefit rider'] : [])],
    effective: `Date of death ${fmtDate(f.dateOfDeath, { year: true })}`,
    payDate,
    payees: f.payees.map((p, i) => ({ payee: p.name, basis: `${p.share}% of ${fmtMoney(f.total)} + ${fmtMoney(ints[i])} interest${p === held ? ' · held for the competing claim' : ''}`, amount: sum([shares[i], ints[i]]), method: p === held ? 'Held' : p.packet === 'mail' ? 'Check' : 'EFT' })),
    payeeNote: `Primary beneficiary died first; the contingent beneficiaries take their shares.${held ? ` ${first(held.name)}’s share is held until the competing claim is resolved.` : ''}`,
    rationale: `In force and past the contestable period. Death on ${fmtDate(f.dateOfDeath, { year: true })} from ${f.adb?.payable ? 'an accident, so the rider pays too' : 'natural causes'}. Pay ${f.payees.filter((p) => p !== held).map((p) => `${first(p.name)} ${p.share}%`).join(' and ')} with interest from the date of death.${held ? ` Hold ${first(held.name)}’s ${held.share}% for the competing claim.` : ''}${waived.length ? ` ${waived.map((r) => `${first(r.from)}’s statement is waived`).join(', ')}; the reason is on file.` : ''}`,
    evidence: ['Death certificate', ...f.payees.map((p) => `Claimant statement · ${first(p.name)}`), 'Beneficiary designation'],
    letters: [{ title: `Approval letters · ${f.payees.map((p) => first(p.name)).join(' and ')}`, template: 'APR-LIFE-01', to: f.payees.map((p) => p.name).join(', ') }, ...(f.adb && !f.adb.payable ? [{ title: 'Why the rider doesn’t pay', template: 'ADB-LIFE-03', to: 'With the approval letters' }] : [])],
    tax: `Interest is reported on a 1099-INT to each payee; the proceeds aren’t taxable.`,
  })
  workItems.insert({
    id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 1, action: `Record decision — ${f.insured}`,
    why: `Proof of loss complete · state limit ${fmtDate(decision.due)}`, due: review.due, waitingOn: 'You', section: 'decision', views: ['readyToDecide'], status: 'open',
  })
  patchClaim(f.claimId, (c) => ({
    stage: lifeStages(2),
    benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-wl' ? { ...b, status: { label: 'Ready to decide', tone: 'info' }, waitingOn: 'You', due: `review by ${fmtDate(review.due)}` } : b)),
    nextStep: { label: 'Record decision', reason: `Proof complete · ${held ? `${passing} of 9 checks pass` : `${plural(9, 'check')} pass`} · state limit ${fmtDate(decision.due)}`, section: 'decision' },
  }))
  const signed = f.payees.filter((p) => !waived.some((r) => r.beneficiaryId === p.id)).map((p) => first(p.name)).join(' and ')
  summarize(f, `${f.insured} died on ${fmtDate(f.dateOfDeath, { year: true })}. ${waived.length ? `Every requirement is settled: the death certificate and a signed statement from ${signed}; ${waived.map((r) => `${first(r.from)}’s statement is waived, with a reason on file`).join(', ')}.` : `Every requirement is in: the death certificate and a signed statement from ${f.payees.map((p) => first(p.name)).join(' and ')}.`} ${held ? `${passing} of 9 readiness checks pass; the ninth is the competing claim on ${first(held.name)}’s half, which is held.` : 'All 9 readiness checks pass.'} The state limit to decide is ${fmtDate(decision.due, { year: true })}; the team aims for ${fmtDate(review.due)}.`)
  logEvent(f.claimId, { at: f.now, type: 'data', title: 'Proof of loss complete — decision clock started', actor: 'System · rules', detail: `${decision.id} decide by ${fmtDate(decision.due)} · ${review.id} review by ${fmtDate(review.due)}` })
  return { decision, review }
}

// ---- A deadline comes due: the dispatcher starts deadline-<id>, which re-checks, acts and writes the next row.
function onFollowUp(f: LifeFlow, h: Happening): void {
  const req = f.reqs.find((r) => r.id === h.reqId)!
  const row = f.deadlines.find((d) => d.reqId === req.id && d.kind === 'requirement_follow_up' && d.status === 'open')
  if (!row) return
  // A request that never arrives escalates: a reminder, then a call task for the examiner, then a final notice.
  const fired = f.deadlines.filter((d) => d.reqId === req.id && d.kind === 'requirement_follow_up' && d.fired).length
  const mode: 'reminder' | 'callTask' | 'finalNotice' = req === missingReq(f) ? (fired === 0 ? 'reminder' : fired === 1 ? 'callTask' : 'finalNotice') : 'reminder'
  const expires = f.deadlines.find((d) => d.kind === 'requirement_expiry' && d.reqId === req.id)?.due
  const ex = examiner(f)
  const today = h.date
  const next = addRow(f, { kind: 'requirement_follow_up', what: `Follow up again: ${req.name}`, due: h.nextDue ?? addDays(h.date, req.followUpDays), reqId: req.id })
  const byFax = req.key === 'report' || req.key === 'amended'
  const via = mode === 'finalNotice' ? 'mail and email' : byFax ? 'fax' : 'email and text'
  const did = mode === 'callTask' ? `call task for ${first(ex.name)}` : `${mode === 'finalNotice' ? 'final notice' : 'reminder'} sent by ${via}`
  closeRow(f, row, `Fired ${dayTime(f.now)} → ${did}`, 'done', true)
  const id = `deadline-${row.id}`
  if (mode === 'callTask') {
    addTask(f.claimId, `Call ${first(req.from)}: ${req.key === 'statement' ? 'claimant statement' : req.name} still missing`, ex.name, `Follow-up deadline · ${id}`, today)
    workItems.insert({ id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 2, action: `Call ${first(req.from)} — statement still missing`, why: `Reminder unanswered since ${fmtDate(addDays(f.noticeAt.slice(0, 10), req.followUpDays))} · the request expires ${expires ? fmtDate(expires) : 'soon'}`, due: today, waitingOn: 'You', section: 'requirements', views: ['dueToday'], status: 'open' })
  } else {
    addCommunication({ claimId: f.claimId, at: f.now, channel: byFax ? 'letter' : 'email', direction: 'out', title: `${mode === 'finalNotice' ? 'Final notice' : 'Reminder'}: ${req.name}`, party: `${req.from} · ${via}`, detail: mode === 'finalNotice' ? `Automatic notice from ${id}. Without it we can’t pay your share; the request expires ${expires ? fmtDate(expires) : 'soon'}.` : `Automatic reminder from ${id}. We still need it to decide the claim.`, status: { label: 'Sent', tone: 'neutral' } })
  }
  const rec = requirements.get(req.id)
  if (rec) {
    requirements.update(req.id, {
      followUps: [...rec.followUps, `${mode === 'callTask' ? 'call task' : byFax ? 'fax' : 'email'} ${fmtDate(h.date)}`],
      plan: [
        ...(rec.plan ?? []).filter((s) => s.state === 'done'),
        { date: h.date, label: mode === 'callTask' ? `Call task opened for ${first(ex.name)}` : `${mode === 'finalNotice' ? 'Final notice' : 'Reminder'} sent by ${via}`, note: id, state: 'done' },
        { date: next.due, label: 'Next follow-up deadline', state: 'todo' },
        ...(expires ? [{ date: expires, label: 'The request expires', state: 'todo' as const }] : []),
        ...(rec.plan ?? []).filter((s) => s.state !== 'done' && s.date > h.date && s.date !== next.due && s.date !== expires),
      ],
    })
  }
  logEvent(f.claimId, { at: f.now, type: mode === 'callTask' ? 'task' : 'communication', title: mode === 'callTask' ? `Call task opened: ${req.name}` : `${mode === 'finalNotice' ? 'Final notice' : 'Reminder'} sent: ${req.name}`, actor: `System · ${id}`, detail: `${row.id} came due · next follow-up ${next.id} on ${fmtDate(next.due)}` })
  run(f, {
    id, type: 'Deadline workflow', name: 'Requirement follow-up', startedBy: `Dispatcher · Temporal Schedule, every minute · ${row.id} due`, took: '3 s',
    steps: [
      { label: 'Re-check: is it still missing?', detail: `Yes — ${req.name}`, system: 'Postgres', state: 'done' },
      mode === 'callTask'
        ? { label: 'Open a call task for the examiner', detail: `${ex.name} · ${fired} reminder${fired === 1 ? '' : 's'} unanswered`, system: 'Postgres', state: 'done' }
        : { label: mode === 'finalNotice' ? 'Send the final notice' : 'Send a reminder', detail: `${req.from} by ${via}`, system: 'Notifications', state: 'done' },
    ],
    saved: [`${row.id} done`, `Next follow-up ${next.id} due ${day(next.due)}`, mode === 'callTask' ? 'Call task and work item for the examiner' : 'Reminder in the history'],
  })
  lane(f, h.title, {
    postgres: [`${row.id} due · dispatcher marks it dispatched`, `${row.id} done · ${next.id} written`],
    temporal: [id, mode === 'callTask' ? 're-check, call task, next row' : 're-check, remind, next row'],
    ...(mode === 'callTask' ? { people: [`${first(ex.name)} gets a call task for ${first(req.from)}`] } : { outside: [`${mode === 'finalNotice' ? 'Final notice' : 'Reminder'} to ${first(req.from)} by ${via}`] }),
  }, id)
}

function onStatusLetter(f: LifeFlow): void {
  const row = f.deadlines.find((d) => d.kind === 'status_letter' && d.status === 'open')
  if (!row) return
  f.letters++
  const next = addRow(f, { kind: 'status_letter', what: `Status letter ${f.letters + 1}, if still undecided`, due: addDays(f.now.slice(0, 10), 30), sla: 'status' })
  closeRow(f, row, `Fired ${dayTime(f.now)} → status letter ${f.letters} sent`, 'done', true)
  const s = sl(f, 'status')
  s.due = next.due
  s.note = `Letter ${f.letters} sent ${day(f.now)}`
  const open = requirements.where((r) => r.claimId === f.claimId && isOpen(r))
  const id = `deadline-${row.id}`
  for (const p of f.payees) {
    addCommunication({ claimId: f.claimId, at: f.now, channel: 'letter', direction: 'out', title: `Status letter ${f.letters}`, party: `${p.name} · ${p.packet === 'mail' ? 'mail' : 'portal and email'}`, detail: `Why the claim is still open: waiting on ${open.map((r) => r.name).join(', ') || 'our review'}. Next update within 30 days.`, status: { label: 'Sent', tone: 'neutral' }, template: 'STS-LIFE-01' })
  }
  logEvent(f.claimId, { at: f.now, type: 'communication', title: `Status letter ${f.letters} sent`, actor: `System · ${id}`, detail: `${row.id} came due · next ${next.id} on ${fmtDate(next.due)}` })
  run(f, {
    id, type: 'Deadline workflow', name: 'State status letter', startedBy: `Dispatcher · Temporal Schedule, every minute · ${row.id} due`, took: '9 s',
    steps: [
      { label: 'Re-check: is the claim still undecided?', detail: `Yes — waiting on ${plural(open.length, 'requirement')}`, system: 'Postgres', state: 'done' },
      { label: 'Build the letter', detail: 'What we have, what we still need, when we expect to decide', system: 'Letters service', state: 'done' },
      { label: 'Send to each beneficiary', detail: f.payees.map((p) => first(p.name)).join(' and '), system: 'Letters service', state: 'done' },
    ],
    saved: [`${row.id} done`, `Next status letter ${next.id} due ${day(next.due)}`, 'Letters in Communications'],
  })
  lane(f, `Status letter ${f.letters} comes due`, {
    postgres: [`${row.id} due · dispatcher marks it dispatched`, `${row.id} done · ${next.id} written`],
    temporal: [id, 're-check, build, send, next row'],
    outside: [`Letters to ${f.payees.map((p) => first(p.name)).join(' and ')}`],
  }, id)
}

// ---------------------------------------------------------------- Variation: things bounce back

/** The W-9 fails the IRS TIN match. That is an answer, not an error: the requirement stays open and a correction is asked for. */
function onTinMismatch(f: LifeFlow, h: Happening, req: FlowReq): void {
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const title = `Claimant statement and W-9 — ${req.from}`
  documents.insert({
    id: newId('doc'), claimId: f.claimId, title, docType: 'Claimant statement', received: h.date, channel: 'Portal upload', pages: 4, isNew: false,
    status: { label: 'Not enough · TIN mismatch', tone: 'caution' }, satisfies: req.name, requirementId: req.id, from: req.from,
    classifiedAs: { label: 'Claimant statement', confidence: 0.98 }, readAt: h.time, reviewedBy: 'Rules · IRS TIN match failed',
  })
  const old = f.deadlines.filter((r) => r.reqId === req.id && r.status === 'open')
  const next = addRow(f, { kind: 'requirement_follow_up', what: `Follow up: corrected W-9 · ${first(req.from)}`, due: addDays(h.date, 7), reqId: req.id })
  old.forEach((r) => closeRow(f, r, `Closed — arrived ${day(f.now)}, but the TIN didn’t match; ${next.id} follows the correction`))
  const oldIds = old.map((r) => r.id).join(', ')
  const rec = requirements.get(req.id)
  if (rec) {
    requirements.update(req.id, {
      state: 'open', status: { label: 'Not enough · TIN mismatch', tone: 'caution' }, waitingOn: req.from, nextAction: undefined,
      plan: [
        ...(rec.plan ?? []).filter((s) => s.state === 'done'),
        { date: h.date, label: 'Received · the IRS TIN match failed', note: id, state: 'done' },
        { date: h.date, label: 'Corrected W-9 asked for by email and a portal task', state: 'done' },
        { date: next.due, label: 'Follow-up deadline if the correction hasn’t arrived', state: 'todo' },
      ],
    })
  }
  patchClaim(f.claimId, (c) => ({ parties: c.parties.map((p) => (p.id === `p-${req.beneficiaryId}` ? { ...p, status: { label: 'W-9 to correct', tone: 'caution' as const } } : p)) }))
  addCommunication({ claimId: f.claimId, at: f.now, channel: 'email', direction: 'out', title: `Please correct your W-9 · ${first(req.from)}`, party: `${req.from} · email and portal task`, detail: 'The name and taxpayer number on your W-9 don’t match IRS records. Please check the number and upload a corrected W-9 in the portal.', status: { label: 'Sent', tone: 'neutral' }, template: 'W9-LIFE-01' })
  logEvent(f.claimId, { at: f.now, type: 'document', title: `Received: ${title}`, actor: `System · ${id}`, detail: 'By portal · the IRS TIN match failed', ref: title })
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Not enough: ${req.name} — TIN mismatch`, actor: 'System · rules', detail: `${oldIds} closed · ${next.id} follows the correction, due ${fmtDate(next.due)}` })
  waitingNextStep(f)
  run(f, {
    id, type: 'Event workflow', name: 'Claimant statement received', startedBy: `Outbox relay · event ${ev} (document saved)`, took: '7 s',
    steps: [
      { label: 'Store the file', detail: 'Object storage · metadata in Postgres', system: 'Document store', state: 'done' },
      { label: 'Classify', detail: 'Claimant statement · 98%', system: 'Classifier', state: 'done' },
      { label: 'Check the signature', detail: 'E-signature valid', system: 'E-signature', state: 'done' },
      { label: 'Check the taxpayer ID', detail: 'IRS TIN match: the name and number don’t match', system: 'TIN matching', state: 'done' },
      { label: 'Ask for a corrected W-9', detail: `${first(req.from)} by email and a portal task`, system: 'Notifications', state: 'done' },
    ],
    saved: ['Document, marked not enough', `${oldIds} closed · ${next.id} follows the correction, due ${day(next.due)}`, 'Correction request in Communications'],
    temporal: 'The IRS said “no match”. That is an answer, not an error, so Temporal doesn’t retry it: the workflow takes the not-enough branch, asks for a correction and ends. Temporal retries only failures, such as a timeout or a 503.',
  })
  lane(f, h.title, {
    people: [`${first(req.from)} uploads in the portal`],
    outside: ['IRS TIN match: no match', 'Email and portal task: correct the W-9'],
    postgres: [`Document saved + event ${ev}`, `Not enough · ${oldIds} closed · ${next.id} written`],
    temporal: [id, 'check TIN → not enough → ask again'],
  }, id)
}

/** A photocopied certificate: the rules can't accept it, so the workflow hands it to the examiner and ends. */
function onPhotocopy(f: LifeFlow, h: Happening, req: FlowReq): void {
  const ex = examiner(f)
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const docId = newId('doc')
  const title = `Death certificate (photocopy) — ${f.insured}`
  documents.insert({
    id: docId, claimId: f.claimId, title, docType: 'Death certificate', received: h.date, channel: 'Mail · scanned', pages: 1, isNew: true,
    status: { label: 'Needs review · not certified', tone: 'caution' }, satisfies: req.name, requirementId: req.id, from: req.from,
    classifiedAs: { label: 'Death certificate · copy', confidence: 0.88 }, readAt: h.time, matches: 'Name, date of birth and date of death',
    ifAccepted: 'The requirement would be met without a certified copy — against the guideline',
  })
  f.bounced = { ...f.bounced, photocopyId: docId }
  const review = addRow(f, { kind: 'document_review_by', what: 'Examiner reviews the certificate the rules couldn’t accept', due: addBusinessDays(h.date, 1), sla: 'docReview' })
  Object.assign(sl(f, 'docReview'), { start: h.date, due: review.due })
  const rec = requirements.get(req.id)
  if (rec) {
    requirements.update(req.id, {
      state: 'inProgress', status: { label: 'Received · needs review', tone: 'info' },
      plan: [
        ...(rec.plan ?? []).filter((s) => s.state === 'done'),
        { date: h.date, label: 'Received by mail · a photocopy, needs review', note: id, state: 'done' },
        { date: review.due, label: `${first(ex.name)} reviews it`, state: 'todo' },
      ],
    })
  }
  workItems.insert({ id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 1, action: `Review the death certificate — it looks like a photocopy`, why: `No raised seal found · review by ${fmtDate(review.due)}`, due: review.due, waitingOn: 'You', section: 'documents', views: ['newDocuments'], status: 'open' })
  patchClaim(f.claimId, { nextStep: { label: 'Review the death certificate', reason: 'The rules couldn’t accept it: no raised seal', section: 'documents' } })
  logEvent(f.claimId, { at: f.now, type: 'document', title: `Received: ${title}`, actor: `System · ${id}`, detail: 'By mail · classified as a copy, not certified · needs review', ref: title })
  run(f, {
    id, type: 'Event workflow', name: 'Death certificate received', startedBy: `Outbox relay · event ${ev} (document saved)`, took: '13 s',
    steps: [
      { label: 'Store the file', detail: 'Object storage · metadata in Postgres', system: 'Document store', state: 'done' },
      { label: 'Classify', detail: 'Death certificate · 88% · no raised seal or certification stamp', system: 'Classifier', state: 'done' },
      { label: 'Read the certificate', detail: 'Name, date of birth and date of death agree with the notice', system: 'Extraction', state: 'done' },
      { label: 'Can the rules accept it?', detail: 'No — a certified copy is required and this one can’t be confirmed', system: 'Rules', state: 'done' },
      { label: 'Ask the examiner', detail: `Work item for ${ex.name} · ${review.id} review by ${day(review.due)}`, system: 'Postgres', state: 'done' },
    ],
    saved: ['Document, needs review', `${review.id} written: review by ${day(review.due)}`, `Work item for ${ex.name}`],
    temporal: `The workflow ends here instead of waiting for ${first(ex.name)}. Waiting on a person is a work item and a deadline row in Postgres, not a sleeping workflow, so nothing is lost if she takes a day or the workers are redeployed.`,
  })
  lane(f, h.title, {
    outside: ['Mail room scans it'],
    postgres: [`Document saved + event ${ev}`, `Needs review · ${review.id} written`],
    temporal: [id, 'classify, read, can’t accept, ask'],
    people: [`${first(ex.name)} gets a review task`],
  }, id)
}

/** The examiner rejects the photocopy. The decision is saved; the letter's workflow then fails when the letters service is down. */
function onDocReview(f: LifeFlow, h: Happening): void {
  const req = f.reqs.find((r) => r.id === h.reqId)!
  const ex = examiner(f)
  const review = f.deadlines.find((d) => d.kind === 'document_review_by' && d.status === 'open')
  if (review) closeRow(f, review, `Closed — ${first(ex.name)} reviewed it at ${f.now.slice(11, 16)}`)
  sl(f, 'docReview').metOn = f.now
  const old = f.deadlines.filter((d) => d.reqId === req.id && d.kind === 'requirement_follow_up' && d.status === 'open')
  const next = addRow(f, { kind: 'requirement_follow_up', what: 'Follow up: certified copy of the death certificate', due: addDays(h.date, 10), reqId: req.id })
  old.forEach((r) => closeRow(f, r, `Closed — the photocopy was rejected; ${next.id} follows the certified copy`))
  const closedIds = [review?.id, ...old.map((r) => r.id)].filter(Boolean).join(', ')
  if (f.bounced?.photocopyId) documents.update(f.bounced.photocopyId, { status: { label: 'Rejected · not certified', tone: 'neutral' }, reviewedBy: ex.name, isNew: false })
  const rec = requirements.get(req.id)
  if (rec) {
    requirements.update(req.id, {
      state: 'open', status: { label: 'Requested again · certified copy', tone: 'info' }, waitingOn: req.from,
      plan: [
        ...(rec.plan ?? []).filter((s) => s.state === 'done'),
        { date: h.date, label: `Photocopy rejected by ${first(ex.name)}`, note: 'not certified', state: 'done' },
        { date: next.due, label: 'Follow-up deadline if the certified copy hasn’t arrived', state: 'todo' },
      ],
    })
  }
  completeWork(f.claimId, 'documents')
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const letter = addCommunication({ claimId: f.claimId, at: f.now, channel: 'letter', direction: 'out', title: `Certified copy needed · ${first(req.from)}`, party: `${req.from} · letter and email`, detail: 'A photocopy can’t be accepted. Please send a certified copy: the funeral home or the county vital records office can order one.', status: { label: 'Not sent · letters service down', tone: 'critical' }, template: 'CRT-LIFE-01' })
  f.bounced = { ...f.bounced, letterId: letter.id, failedRun: id }
  addTask(f.claimId, `Re-run ${id} once the letters service is back`, 'Claims ops on call', `Workflow failed · ${id}`, h.date)
  waitingNextStep(f)
  logEvent(f.claimId, { at: f.now, type: 'document', title: 'Photocopy rejected — a certified copy is needed', actor: ex.name, detail: `${closedIds} closed · ${next.id} written · event ${ev}` })
  logEvent(f.claimId, { at: f.now, type: 'task', title: `Letter workflow failed after 5 attempts — ops task opened`, actor: `System · ${id}`, detail: 'The letters service returned 503 · the decision is saved; only the letter is waiting' })
  run(f, {
    id, type: 'Event workflow', name: 'Certificate rejected', startedBy: `Outbox relay · event ${ev} (review saved)`, took: '34 s', failed: true,
    steps: [
      { label: 'Build the letter', detail: 'Why a photocopy can’t be accepted; how to order a certified copy', system: 'Letter templates', state: 'done' },
      { label: 'Send it', detail: 'The letters service returned 503 · 5 attempts, waiting 2, 4, 8 and 16 s between them · gave up', system: 'Letters service', state: 'failed' },
      { label: 'Record the failure', detail: 'Ops task opened · the run shows as failed in Temporal', system: 'Postgres', state: 'done' },
    ],
    saved: ['Failure recorded on the run', 'Ops task: re-run once the letters service is back'],
    temporal: `Temporal retried the send five times, waiting longer each time, then stopped as the retry policy says. The run is marked failed in Temporal’s UI, and its last step opened an ops task. ${first(ex.name)}’s decision isn’t lost: it was saved in Postgres before the workflow started. Only the letter is waiting.`,
  })
  lane(f, `${first(ex.name)} rejects the photocopy`, {
    people: [`${first(ex.name)} rejects it: not certified`, 'Ops gets a task: letter not sent'],
    postgres: ['Rejected · requested again', `${closedIds} closed · ${next.id} written`, `Event ${ev}`],
    temporal: [id, 'send failed after 5 attempts'],
    outside: ['Letters service down (503)'],
  }, id)
}

/** Ops re-runs the failed workflow under the same ID once the letters service is back. */
function onOpsRerun(f: LifeFlow, h: Happening): void {
  const failedId = f.bounced?.failedRun
  if (!failedId) return
  const req = f.reqs.find((r) => r.key === 'certificate')!
  const runNo = f.runs.filter((r) => r.id === failedId).length + 1
  if (f.bounced?.letterId) communications.update(f.bounced.letterId, { status: { label: 'Sent · second run', tone: 'positive' } })
  tasks.where((t) => t.claimId === f.claimId && t.title.startsWith(`Re-run ${failedId}`) && !t.done).forEach((t) => tasks.update(t.id, { done: true }))
  f.bounced = { ...f.bounced, failedRun: undefined }
  logEvent(f.claimId, { at: f.now, type: 'communication', title: `Letter sent: certified copy needed · ${first(req.from)}`, actor: `Claims ops · ${failedId} run ${runNo}`, detail: 'Re-run from the Temporal UI after the letters service recovered · same workflow ID, same idempotency key' })
  const r = run(f, {
    id: failedId, runNo, type: 'Event workflow', name: 'Certificate rejected · re-run', startedBy: `Claims ops · re-run from the Temporal UI (allowed because run 1 failed)`, took: '3 s',
    steps: [
      { label: 'Build the letter', detail: 'The same letter as run 1', system: 'Letter templates', state: 'done' },
      { label: 'Send it', detail: 'The letters service is back · sent with the same idempotency key', system: 'Letters service', state: 'done' },
      { label: 'Close the ops task', detail: 'Task done', system: 'Postgres', state: 'done' },
    ],
    saved: ['Letter marked sent', 'Ops task closed'],
    temporal: `Workflows start with the ID-reuse policy “allow duplicate, failed only”: an ID can’t start again while a run is open or after it completed. Run 1 failed, so ops can start run ${runNo} under the same ID: still one workflow per event. The letter carries the same idempotency key, so ${first(req.from)} gets exactly one.`,
  })
  lane(f, h.title, {
    people: ['Ops re-runs it from the Temporal UI'],
    temporal: [`${failedId} · run ${runNo}`, 'build, send, close task'],
    outside: [`Letter to ${first(req.from)}: order a certified copy`],
    postgres: ['Letter sent · ops task closed'],
  }, runKey(r))
}

/** The returns job marks the item returned and writes an event; an event workflow reopens the claim. */
function onBankReturn(f: LifeFlow, h: Happening): void {
  const payee = heldPayee(f)
  const item = payments.where((p) => p.claimId === f.claimId && p.payee === payee.name && p.status.tone === 'positive')[0]
  if (!item) return
  const ex = examiner(f)
  const today = h.date
  const firstPaid = (f.reached.paid ?? f.now).slice(0, 10)
  payments.update(item.id, { status: { label: `Returned ${fmtDate(today)} · account closed`, tone: 'critical' }, note: 'bank return code R02' })
  f.bounced = { ...f.bounced, returned: { payeeId: payee.id, payee: payee.name, amount: item.amount, itemId: item.id, on: today } }
  f.status = 'reopened'
  delete f.reached.closed
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const dueBy = addDays(today, 10)
  const row = addRow(f, { kind: 'bank_details_by', what: `${first(payee.name)} gives new bank details (a reminder if not)`, due: dueBy })
  sl(f, 'reissue').note = `Starts when ${first(payee.name)}’s new details arrive`
  const paidSoFar = sum(payments.where((p) => p.claimId === f.claimId && p.status.tone === 'positive').map((p) => p.amount))
  addCommunication({ claimId: f.claimId, at: `${today}T08:10`, channel: 'email', direction: 'out', title: `Your payment was returned · ${first(payee.name)}`, party: `${payee.name} · email, text and portal task`, detail: `Your bank returned the payment of ${fmtMoney(item.amount)} because the account is closed. Please add a new account in the portal; we pay it in the next daily run.`, status: { label: 'Sent', tone: 'neutral' }, template: 'RTN-LIFE-01' })
  workItems.insert({ id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 2, action: `Payment returned — ${first(payee.name)}’s account is closed`, why: `Returned ${fmtDate(today)} · new details asked for by ${fmtDate(dueBy)}`, due: dueBy, waitingOn: payee.name, section: 'payments', views: ['waiting'], status: 'open' })
  const exception: ClaimException = {
    id: 'x-return', title: `${first(payee.name)}’s payment was returned`, detail: `The bank returned ${fmtMoney(item.amount)}: the account is closed. The claim is reopened until it is paid again`,
    meta: `New details by ${fmtDate(dueBy)}`, action: { label: 'Open payments', section: 'payments' }, status: 'open',
  }
  patchClaim(f.claimId, (c) => ({
    stage: lifeStages(4),
    tags: [...c.tags.filter((t) => t.label !== 'Payment returned'), { label: 'Payment returned', tone: 'caution' }],
    exceptions: [...c.exceptions.filter((x) => x.id !== exception.id), exception],
    parties: c.parties.map((p) => (p.id === `p-${payee.id}` ? { ...p, status: { label: 'Payment returned', tone: 'caution' as const } } : p)),
    benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-wl' ? { ...b, status: { label: `Reopened · ${first(payee.name)}’s payment returned`, tone: 'caution' as const }, paid: `${fmtMoney(paidSoFar)} paid`, waitingOn: payee.name, due: `new details by ${fmtDate(dueBy)}` } : b)),
    nextStep: { label: `Waiting on ${first(payee.name)}’s new bank details`, reason: `Payment returned ${fmtDate(today)} · account closed`, section: 'payments' },
  }))
  summarize(f, `Reopened on ${fmtDate(today)}. The bank returned ${first(payee.name)}’s payment of ${fmtMoney(item.amount)} because the account is closed; ${f.payees.filter((p) => p.id !== payee.id).map((p) => first(p.name)).join(' and ')} was paid on ${fmtDate(firstPaid)}. ${first(payee.name)} has been asked to add a new account; the replacement goes in the first daily payment run after it arrives.`)
  logEvent(f.claimId, { at: f.now, type: 'payment', title: `Payment returned: ${payee.name}, account closed`, actor: 'Batch · returns job', detail: `${fmtMoney(item.amount)} · bank return code R02` })
  logEvent(f.claimId, { at: `${today}T08:10`, type: 'data', title: 'Claim reopened — payment returned', actor: `System · ${id}`, detail: `${row.id} new details due ${fmtDate(dueBy)}` })
  run(f, {
    id, at: `${today}T08:10`, type: 'Event workflow', name: 'Payment returned', startedBy: `Outbox relay · event ${ev} (the returns job marked the item returned)`, took: '9 s',
    steps: [
      { label: 'Read the return', detail: `${payee.name} · ${fmtMoney(item.amount)} · R02 account closed`, system: 'Postgres', state: 'done' },
      { label: 'Reopen the claim', detail: 'Closed → Reopened · payment returned', system: 'Postgres', state: 'done' },
      { label: 'Stop paying the closed account', detail: 'The account is marked closed, so no future item uses it', system: 'Postgres', state: 'done' },
      { label: `Ask ${first(payee.name)} for a new account`, detail: 'Email, text and a portal task', system: 'Notifications', state: 'done' },
      { label: 'Tell the examiner', detail: `Work item for ${ex.name}`, system: 'Postgres', state: 'done' },
    ],
    saved: ['Status → Reopened · payment returned', `${row.id} written: new details by ${day(dueBy)}`, 'Exception and work item'],
    temporal: `Batch never changes the claim itself. The returns job only marks the payment item returned and writes an event; a Temporal workflow does the claim side. After that nothing sleeps in Temporal: the deadline row waits for ${first(payee.name)}’s new details.`,
  })
  lane(f, h.title, {
    batch: ['Returns job 06:30', 'Item returned · R02 account closed'],
    outside: ['Bank return file', `Email and text to ${first(payee.name)}`],
    postgres: ['Item returned · event written', 'Claim reopened', `${row.id} written`],
    temporal: [id, 'reopen, ask for account, tell examiner'],
  }, id)
}

/** New bank details arrive. An event workflow verifies the account and clears a replacement item; the returned one isn't edited. */
function onNewAccount(f: LifeFlow, h: Happening): void {
  const r = f.bounced?.returned
  if (!r) return
  const today = h.date
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const row = f.deadlines.find((d) => d.kind === 'bank_details_by' && d.status === 'open')
  if (row) closeRow(f, row, `Closed — new account added ${day(f.now)}; never had to fire`)
  const payDate = f.script.find((x) => x.kind === 'payRun')?.date ?? addBusinessDays(today, 1)
  const pay = addRow(f, { kind: 'payment_due', what: `Pay ${first(r.payee)}’s replacement`, due: addBusinessDays(today, 2), sla: 'reissue' })
  Object.assign(sl(f, 'reissue'), { start: today, due: pay.due, note: undefined })
  schedulePayment({ claimId: f.claimId, benefitLineId: 'bl-cast-wl', payDate, payee: r.payee, basis: 'Replacement for the returned payment', amount: r.amount, method: 'EFT · new account', status: { label: 'Cleared · next run', tone: 'info' }, note: `replaces the ${fmtDate((f.reached.paid ?? f.now).slice(0, 10))} payment` })
  f.bounced = { ...f.bounced, reissued: true }
  completeWork(f.claimId, 'payments')
  patchClaim(f.claimId, (c) => ({
    exceptions: c.exceptions.map((x) => (x.id === 'x-return' ? { ...x, meta: `New account ${fmtDate(today)} · paying ${fmtDate(payDate)}` } : x)),
    parties: c.parties.map((p) => (p.id === `p-${r.payeeId}` ? { ...p, status: { label: `Replacement paying ${fmtDate(payDate)}`, tone: 'info' as const } } : p)),
    nextStep: { label: `Payment run ${fmtDate(payDate, { weekday: true })}`, reason: `${first(r.payee)}’s replacement cleared · ${fmtMoney(r.amount)}`, section: 'payments' },
  }))
  addCommunication({ claimId: f.claimId, at: f.now, channel: 'email', direction: 'out', title: `New account confirmed · ${first(r.payee)}`, party: `${r.payee} · email`, detail: `Thank you. We pay ${fmtMoney(r.amount)} to your new account in the ${fmtDate(payDate)} payment run.`, status: { label: 'Sent', tone: 'positive' }, template: 'RTN-LIFE-02' })
  logEvent(f.claimId, { at: f.now, type: 'payment', title: 'New bank account verified — replacement payment cleared', actor: `System · ${id}`, detail: `${row ? `${row.id} closed · ` : ''}${pay.id} written · paying ${fmtDate(payDate)}` })
  run(f, {
    id, type: 'Event workflow', name: 'New bank account', startedBy: `Outbox relay · event ${ev} (bank details saved)`, took: '12 s',
    steps: [
      { label: 'Verify the account', detail: 'Account open · name matches · instant verification', system: 'Bank verification', state: 'done' },
      { label: 'Create a replacement payment item', detail: `${fmtMoney(r.amount)}, the same amount: interest stopped at the first payment because the return came from the closed account (example rule) · the returned item is kept, never edited`, system: 'Postgres', state: 'done' },
      { label: `Tell ${first(r.payee)}`, detail: `Paid in the ${fmtDate(payDate)} run`, system: 'Notifications', state: 'done' },
    ],
    saved: [`${row ? `${row.id} closed · ` : ''}replacement item cleared`, `${pay.id} written: pay by ${day(pay.due)}`, 'History'],
    temporal: 'Checking the account calls an outside service, so it runs as an activity with retries. The replacement is a new payment item; the returned one stays as it was, because paid items are never edited.',
  })
  lane(f, h.title, {
    people: [`${first(r.payee)} adds a new account in the portal`],
    outside: ['Bank verification: account open'],
    postgres: [`Details saved + event ${ev}`, `Replacement item cleared · ${pay.id} written`, ...(row ? [`${row.id} closed`] : [])],
    temporal: [id, 'verify, create item, tell'],
    batch: [`Item waits for the ${fmtDate(payDate)} run`],
  }, id)
}

// ---------------------------------------------------------------- Variation: a service level is missed

/**
 * The dispatcher's Temporal Schedule was paused, so first contact wasn't chased on its due day. The nightly check
 * (batch, independent of Temporal) lists the row as past due and starts the deadline workflow late. The workflow
 * alerts, the breach is recorded and shows red, and the claim gets an exception until the call is made.
 */
function onNightly(f: LifeFlow): void {
  const row = f.deadlines.find((d) => d.kind === 'first_contact_by' && d.status === 'open')
  if (!row) return
  const today = f.now.slice(0, 10)
  const days = daysFrom(row.due, today)
  const ex = examiner(f)
  const id = `deadline-${row.id}`
  closeRow(f, row, `Fired late ${dayTime(f.now)}: the nightly check found it ${plural(days, 'day')} past due → alert to ${first(ex.name)} and ${first(TEAM_LEAD.name)}`, 'done', true)
  row.breached = true
  sl(f, 'contact').note = `${row.id} fired ${plural(days, 'day')} late · alert sent ${day(f.now)}`
  const exception: ClaimException = {
    id: 'x-contact', title: 'First contact missed', detail: `Due ${fmtDate(row.due, { weekday: true })}, not made. The dispatcher was paused; the nightly check found it`,
    meta: `Breached · ${plural(days, 'day')} late`, action: { label: 'Open workflow', section: 'workflow' }, status: 'open',
  }
  patchClaim(f.claimId, (c) => ({
    exceptions: [...c.exceptions.filter((x) => x.id !== exception.id), exception],
    nextStep: { ...c.nextStep, reason: `First contact was due ${fmtDate(row.due, { weekday: true })} · call today` },
  }))
  workItems.insert({ id: newId('w'), ownerId: TEAM_LEAD.id, claimId: f.claimId, priority: 1, action: `Service level missed — first contact, ${f.insured}`, why: `${row.id} fired ${plural(days, 'day')} late · ${first(ex.name)} hasn’t called ${first(f.caller)} yet`, due: today, waitingOn: ex.name, section: 'workflow', views: ['dueToday'], status: 'open' })
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Nightly check: 1 deadline past due, ${row.id}`, actor: 'Batch · nightly check', detail: `${row.kind} was due ${fmtDate(row.due)} and never dispatched · the dispatcher’s Schedule was paused` })
  logEvent(f.claimId, { at: f.now, type: 'task', title: 'Service level missed: first contact', actor: `System · ${id}`, detail: `${plural(days, 'day')} late · alert to ${ex.name} and ${TEAM_LEAD.name} · exception opened` })
  run(f, {
    id, type: 'Deadline workflow', name: 'First-contact service level', startedBy: `Nightly check · ${row.id} found ${plural(days, 'day')} past due (dispatcher paused)`, took: '4 s',
    steps: [
      { label: 'Re-check: has the examiner called?', detail: `No call logged for ${first(f.caller)}`, system: 'Postgres', state: 'done' },
      { label: 'Alert the examiner and the team lead', detail: `${ex.name} and ${TEAM_LEAD.name}`, system: 'Notifications', state: 'done' },
      { label: 'Record the breach', detail: `First contact · ${plural(days, 'day')} late`, system: 'Postgres', state: 'done' },
    ],
    saved: [`${row.id} done (fired late)`, 'Breach recorded on the service level', 'Exception opened on the claim', 'Work item for the team lead'],
  })
  lane(f, `The nightly check finds ${row.id} past due`, {
    batch: ['Nightly check 02:00', `Lists ${row.id}: ${plural(days, 'day')} past due, never dispatched`],
    postgres: [`${row.id} fired late · done`, 'Breach recorded · exception opened'],
    temporal: [id, 're-check, alert, record breach'],
    outside: [`Alert to ${first(ex.name)} and ${first(TEAM_LEAD.name)}`],
  }, id)
}

// ---------------------------------------------------------------- Variation: evidence never arrives

/** The expiry row fires. The examiner decides what to do about the missing requirement: see chooseFork. */
function onExpiry(f: LifeFlow, h: Happening): void {
  const req = f.reqs.find((r) => r.id === h.reqId)!
  const row = f.deadlines.find((d) => d.kind === 'requirement_expiry' && d.status === 'open')
  if (!row) return
  const ex = examiner(f)
  const id = `deadline-${row.id}`
  const tries = f.deadlines.filter((d) => d.reqId === req.id && d.kind === 'requirement_follow_up' && d.fired).length
  closeRow(f, row, `Fired ${dayTime(f.now)} → the request expired; ${first(ex.name)} decides: waive it or close the claim incomplete`, 'done', true)
  const rec = requirements.get(req.id)
  if (rec) {
    requirements.update(req.id, {
      state: 'overdue',
      status: { label: `Expired ${fmtDate(h.date)}`, tone: 'caution' },
      nextAction: { label: 'Waive it, or close the claim incomplete', reason: `Expired after ${plural(tries, 'follow-up')} and ${plural(f.letters, 'status letter')}` },
      plan: [
        ...(rec.plan ?? []).filter((x) => x.state === 'done'),
        { date: h.date, label: 'The request expired', note: id, state: 'done' },
        { date: h.date, label: `${first(ex.name)} waives it or closes the claim incomplete`, state: 'current' },
      ],
    })
  }
  addCommunication({ claimId: f.claimId, at: f.now, channel: 'letter', direction: 'out', title: `Request expired: ${req.name}`, party: `${req.from} · mail and email`, detail: `Automatic notice from ${id}. We asked for it on ${day(f.noticeAt)} and have heard nothing since. Without it we can’t pay your share.`, status: { label: 'Sent', tone: 'neutral' }, template: 'EXP-LIFE-01' })
  workItems.insert({ id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 1, action: `Waive or close incomplete — ${first(req.from)}’s statement`, why: `The request expired ${fmtDate(h.date)} · ${plural(tries, 'follow-up')}, ${plural(f.letters, 'status letter')}`, due: h.date, waitingOn: 'You', section: 'workflow', views: ['dueToday'], status: 'open' })
  const exception: ClaimException = {
    id: 'x-expired', title: `${first(req.from)}’s statement expired`, detail: 'Never arrived. Waive the requirement with a reason, or close the claim incomplete',
    meta: `Expired ${fmtDate(h.date)}`, action: { label: 'Choose', section: 'workflow' }, status: 'open',
  }
  patchClaim(f.claimId, (c) => ({
    exceptions: [...c.exceptions.filter((x) => x.id !== exception.id), exception],
    nextStep: { label: 'Waive the requirement or close the claim', reason: `${req.name} expired ${fmtDate(h.date)}`, section: 'workflow' },
  }))
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Request expired: ${req.name}`, actor: `System · ${id}`, detail: `${row.id} came due · ${plural(tries, 'follow-up')} and ${plural(f.letters, 'status letter')} sent · waiting on ${first(ex.name)}’s decision` })
  run(f, {
    id, type: 'Deadline workflow', name: 'Requirement expiry', startedBy: `Dispatcher · Temporal Schedule, every minute · ${row.id} due`, took: '5 s',
    steps: [
      { label: 'Re-check: is it still missing?', detail: `Yes — ${req.name}`, system: 'Postgres', state: 'done' },
      { label: 'Expire the request', detail: 'Requirement → expired; open follow-up rows stay until the examiner decides', system: 'Postgres', state: 'done' },
      { label: 'Send the expiry notice', detail: `${req.from} by mail and email`, system: 'Notifications', state: 'done' },
      { label: 'Ask the examiner to decide', detail: 'Work item and exception: waive it, or close the claim incomplete', system: 'Postgres', state: 'done' },
    ],
    saved: [`${row.id} done`, 'Requirement expired', 'Expiry notice in Communications', 'Exception and work item for the examiner'],
  })
  lane(f, h.title, {
    postgres: [`${row.id} due · dispatcher marks it dispatched`, `${row.id} done · requirement expired`, 'Exception opened'],
    temporal: [id, 're-check, expire, notify, ask'],
    outside: [`Expiry notice to ${first(req.from)}`],
    people: [`${first(ex.name)} has to choose`],
  }, id)
  f.fork = {
    title: `${req.name} expired`,
    text: `${first(req.from)}’s claimant statement never arrived: ${plural(tries, 'follow-up')} (a reminder, a call task, a final notice) and ${plural(f.letters, 'status letter')} listing it. Without it the claim can’t be decided.`,
    actAt: `${h.date}T09:30`,
    choices: [
      { key: 'waive', label: 'Waive the requirement', detail: 'Needs a reason. Proof of loss is then complete and the decision clock starts.', needsReason: true },
      { key: 'closeIncomplete', label: 'Close the claim incomplete', detail: 'Rows close, letters go to both beneficiaries, nothing is paid. It reopens if the statement arrives.' },
    ],
  }
}

/** Waived: a reason is recorded, the requirement's rows are skipped, and proof of loss completes. Postgres only, no workflow. */
function onWaive(f: LifeFlow, reason: string): void {
  const req = missingReq(f)!
  const ex = examiner(f)
  const today = f.now.slice(0, 10)
  const tries = f.deadlines.filter((d) => d.reqId === req.id && d.kind === 'requirement_follow_up' && d.fired).length
  const why = `${reason.trim()} · ${plural(tries, 'follow-up')} and ${plural(f.letters, 'status letter')} since ${day(f.noticeAt)}`
  const rec = requirements.get(req.id)
  if (rec) {
    requirements.update(req.id, {
      state: 'waived', status: { label: `Waived ${fmtDate(today)}`, tone: 'neutral' }, waiveReason: why, waitingOn: undefined, nextAction: undefined,
      plan: [...(rec.plan ?? []).filter((x) => x.state === 'done'), { date: today, label: 'Waived', note: why, state: 'done' }],
    })
  }
  const rows = f.deadlines.filter((d) => d.reqId === req.id && d.status === 'open')
  rows.forEach((r) => closeRow(f, r, `Skipped — requirement waived ${day(f.now)}`, 'skipped'))
  tasks.where((t) => t.claimId === f.claimId && t.title.startsWith(`Call ${first(req.from)}`) && !t.done).forEach((t) => tasks.update(t.id, { done: true }))
  completeWork(f.claimId, 'workflow')
  completeWork(f.claimId, 'requirements')
  patchClaim(f.claimId, (c) => ({
    exceptions: c.exceptions.map((x) => (x.id === 'x-expired' ? { ...x, status: 'resolved' as const, meta: `Waived ${fmtDate(today)}` } : x)),
    parties: c.parties.map((p) => (p.id === `p-${req.beneficiaryId}` ? { ...p, status: { label: 'Statement waived', tone: 'neutral' } } : p)),
  }))
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Requirement waived: ${req.name}`, actor: ex.name, detail: why, ref: req.name })
  f.script = decisionTail(f, today)
  const { decision, review } = proofComplete(f)
  lane(f, `${first(ex.name)} waives ${first(req.from)}’s statement`, {
    people: [`${first(ex.name)} waives it, with a reason`],
    postgres: ['Requirement waived · reason recorded', `${rows.map((r) => r.id).join(', ')} skipped`, `Proof complete · ${decision.id}, ${review.id} written`, 'Status: In review'],
    temporal: ['No workflow — nothing outside Postgres to call'],
  })
}

/** Closed incomplete: nothing is paid. Rows close, letters go out through an event workflow, and the claim can reopen. */
function onCloseIncomplete(f: LifeFlow): void {
  const req = missingReq(f)!
  const ex = examiner(f)
  const today = f.now.slice(0, 10)
  const rows = f.deadlines.filter((d) => d.status === 'open')
  rows.forEach((r) => closeRow(f, r, `Skipped — claim closed incomplete ${day(f.now)}`, 'skipped'))
  tasks.where((t) => t.claimId === f.claimId && !t.done && t.title.startsWith('Call')).forEach((t) => tasks.update(t.id, { done: true }))
  completeWork(f.claimId)
  f.status = 'closedIncomplete'
  f.reached.closed = f.now
  const stopped = `Stopped ${day(f.now)} — closed incomplete`
  sl(f, 'status').stopped = stopped
  for (const k of ['decide', 'review', 'pay'] as const) sl(f, k).stopped = 'Not reached — closed incomplete'
  sl(f, 'interest').stopped = 'Not paid — closed incomplete'
  patchClaim(f.claimId, (c) => ({
    stage: LIFE_STAGES.map((label) => ({ key: label.toLowerCase(), label, state: 'done' as const })),
    exceptions: c.exceptions.map((x) => (x.id === 'x-expired' ? { ...x, status: 'resolved' as const, meta: `Closed incomplete ${fmtDate(today)}` } : x)),
    benefitLines: c.benefitLines.map((b) => ({ ...b, status: { label: 'Closed · incomplete', tone: 'neutral' }, waitingOn: undefined, due: undefined })),
    parties: c.parties.map((p) => (p.id === `p-${req.beneficiaryId}` ? { ...p, status: { label: 'Statement never received', tone: 'caution' } } : p)),
    tags: [...c.tags, { label: 'Closed incomplete', tone: 'neutral' }],
    nextStep: { label: 'Claim closed incomplete', reason: `${req.name} never arrived · reopens if it does`, section: 'history' },
  }))
  summarize(f, `Closed incomplete on ${fmtDate(today)}. ${f.insured}’s death is proved and ${f.payees.filter((p) => p.id !== req.beneficiaryId).map((p) => first(p.name)).join(' and ')} sent a statement, but ${first(req.from)}’s claimant statement never arrived after ${plural(f.deadlines.filter((d) => d.reqId === req.id && d.kind === 'requirement_follow_up' && d.fired).length, 'follow-up')} and ${plural(f.letters, 'status letter')}. Nothing was paid. The claim reopens if it arrives.`)
  const ev = nextEvent(f)
  const id = `event-${ev}`
  for (const p of f.payees) {
    addCommunication({ claimId: f.claimId, at: f.now, channel: p.packet === 'mail' ? 'letter' : 'email', direction: 'out', title: `Claim closed incomplete · ${first(p.name)}`, party: `${p.name} · ${p.packet === 'mail' ? 'mail' : 'portal and email'}`, detail: `We couldn’t finish the claim because ${req.name.toLowerCase()} never arrived. Nothing has been paid. It reopens if the missing statement arrives.`, status: { label: 'Sent', tone: 'neutral' }, template: 'CLS-LIFE-02' })
  }
  if (f.consent) addCommunication({ claimId: f.claimId, at: f.now, channel: 'email', direction: 'out', title: 'Agent notification · closed incomplete', party: `${f.agent} · agent of record`, detail: 'The claim is closed incomplete; a statement never arrived. Status only.', status: { label: 'Sent', tone: 'neutral' }, template: 'AGT-NOTE-03' })
  logEvent(f.claimId, { at: f.now, type: 'decision', title: `Claim closed incomplete — ${req.name} never arrived`, actor: `${ex.name} · whole life`, detail: `${rows.map((r) => r.id).join(', ')} skipped · nothing paid · reopens if it arrives` })
  run(f, {
    id, type: 'Event workflow', name: 'Claim closed incomplete', startedBy: `Outbox relay · event ${ev} (claim closed incomplete)`, took: '9 s',
    steps: [
      { label: 'Generate the closing letters', detail: `CLS-LIFE-02 × ${f.payees.length}`, system: 'Letters service', state: 'done' },
      { label: 'Deliver the way each beneficiary chose', detail: f.payees.map((p) => `${first(p.name)} ${p.packet === 'mail' ? 'by mail' : 'in the portal and by email'}`).join(' · '), system: 'Notifications', state: 'done' },
      { label: 'Tell the agent of record', detail: f.consent ? 'Status: closed incomplete' : 'No consent', system: 'Notifications', state: f.consent ? 'done' : 'skipped' },
    ],
    saved: ['Letters in Communications', 'History'],
  })
  lane(f, `${first(ex.name)} closes the claim incomplete`, {
    people: [`${first(ex.name)} closes it; nothing is paid`],
    postgres: ['Status: Closed incomplete', `${rows.map((r) => r.id).join(', ')} skipped`, `Event ${ev} written`],
    temporal: [id, 'closing letters, agent'],
    outside: [`Letters to ${f.payees.map((p) => first(p.name)).join(' and ')}`],
  }, id)
}

// ---------------------------------------------------------------- Variation: a competing claimant

/** A second person claims one beneficiary's share. An event workflow reads the letter, and that share is held. */
function onAdverse(f: LifeFlow, h: Happening): void {
  const ex = examiner(f)
  const held = heldPayee(f)
  const amount = split(f.total, f.payees.map((p) => p.share))[f.payees.indexOf(held)]
  const today = h.date
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const title = `Letter from ${CLAIMANT.name}’s attorney — competing claim`
  const respondBy = addDays(today, 30)
  documents.insert({
    id: newId('doc'), claimId: f.claimId, title, docType: 'Adverse claim', received: today, channel: 'Mail · scanned', pages: 3, isNew: true,
    status: { label: 'Needs review', tone: 'caution' }, from: `${CLAIMANT.name}’s attorney`, classifiedAs: { label: 'Adverse claim', confidence: 0.94 }, readAt: h.time,
    reviewedBy: 'Rules · doesn’t match the designation', matches: 'Name, date of death and policy number',
  })
  const rerouted = f.route.track === 'Fast track life'
  f.route = { ...f.route, track: 'Standard life', rule: 'LF-02', reasons: [`Competing claimant — ${CLAIMANT.name} claims ${first(held.name)}’s share`, ...f.route.reasons.filter((r) => /^(Accidental|Cause)/.test(r))] }
  f.hold = { payeeId: held.id, payee: held.name, claimant: CLAIMANT.name, share: held.share, amount, since: today, state: 'claimed' }
  const resp = addRow(f, { kind: 'dispute_response_by', what: `${CLAIMANT.name} to send ${CLAIMANT.basis} or a court order`, due: respondBy })
  f.script = f.script.map((x) => (x.kind === 'payRun' ? { ...x, title: `The daily payment run pays ${f.payees.filter((p) => p.id !== held.id).map((p) => first(p.name)).join(' and ')}` } : x))
  const exception: ClaimException = {
    id: 'x-dispute', title: `Competing claim to ${first(held.name)}’s half`,
    detail: `${CLAIMANT.name} says ${CLAIMANT.basis} names her. None is on file; the designation names ${first(held.name)}. The half is held`,
    meta: `Response due ${fmtDate(respondBy)}`, action: { label: 'See her letter', section: 'documents' }, status: 'open',
  }
  patchClaim(f.claimId, (c) => ({
    tags: [...c.tags.filter((t) => t.label !== 'Fast track' && t.label !== 'Standard'), { label: 'Standard', tone: 'plain' }, { label: 'Dispute', tone: 'special' }],
    exceptions: [...c.exceptions.filter((x) => x.id !== exception.id), exception],
    parties: [
      ...c.parties.map((p) => (p.id === `p-${held.id}` ? { ...p, status: { label: 'Share on hold', tone: 'caution' as const } } : p)),
      { id: 'p-claimant', name: CLAIMANT.name, roles: ['Competing claimant'], relationship: `Claims ${first(held.name)}’s half`, share: `${held.share}% claimed`, status: { label: 'Competing claim', tone: 'special' as const }, note: `Says ${CLAIMANT.basis} names her · ${CLAIMANT.via}` },
    ],
    benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-wl' ? { ...b, held: `${fmtMoney(amount)} held · competing claim` } : b)),
  }))
  for (const [name, packet, subject, text, template] of [
    [CLAIMANT.name, 'mail', 'Competing claim received', `We received your attorney’s letter. The designation on file names ${first(held.name)}. Please send ${CLAIMANT.basis} or a court order within 30 days, by ${fmtDate(respondBy)}. Until then we hold that share.`, 'ADV-LIFE-01'],
    [held.name, held.packet, 'A competing claim was made on your share', `Someone else has claimed your ${held.share}% share. We hold it while this is resolved. It doesn’t change ${first(f.payees.find((p) => p.id !== held.id)?.name ?? '')}’s share.`, 'ADV-LIFE-02'],
  ] as const) {
    addCommunication({ claimId: f.claimId, at: f.now, channel: packet === 'mail' ? 'letter' : 'email', direction: 'out', title: `${subject} · ${first(name)}`, party: `${name} · ${packet === 'mail' ? 'mail' : 'portal and email'}`, detail: text, status: { label: 'Sent', tone: 'neutral' }, template })
  }
  addTask(f.claimId, `Review ${CLAIMANT.name}’s claim with Legal`, ex.name, 'Competing claim', respondBy)
  workItems.insert({ id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 1, action: `Competing claim — ${first(held.name)}’s half`, why: `${CLAIMANT.name} claims it · response due ${fmtDate(respondBy)}`, due: respondBy, waitingOn: CLAIMANT.name, section: 'documents', views: ['dueToday'], status: 'open' })
  summarize(f, `${f.insured} died on ${fmtDate(f.dateOfDeath, { year: true })}. On ${fmtDate(today)} ${CLAIMANT.name} claimed ${first(held.name)}’s half, saying ${CLAIMANT.basis} names her; none is on file. ${first(held.name)}’s half is held and ${CLAIMANT.name} has until ${fmtDate(respondBy)} to send proof. The other half is paid as usual once the evidence is in.`)
  logEvent(f.claimId, { at: f.now, type: 'document', title: `Received: ${title}`, actor: `System · ${id}`, detail: `By mail · classified as an adverse claim · ${first(held.name)}’s ${held.share}% held`, ref: title })
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Competing claim opened — ${first(held.name)}’s share held`, actor: 'System · rules', detail: `${resp.id} response due ${fmtDate(respondBy)}${rerouted ? ' · re-routed Fast track life → Standard life (LF-02)' : ''}` })
  run(f, {
    id, type: 'Event workflow', name: 'Competing claim received', startedBy: `Outbox relay · event ${ev} (document saved)`, took: '18 s',
    steps: [
      { label: 'Store the file', detail: 'Object storage · metadata in Postgres', system: 'Document store', state: 'done' },
      { label: 'Classify', detail: 'Adverse claim · 94%', system: 'Classifier', state: 'done' },
      { label: 'Read the claim', detail: `${CLAIMANT.name} claims ${held.share}% under ${CLAIMANT.basis}`, system: 'Extraction', state: 'done' },
      { label: 'Compare with the designation on file', detail: `No 2024 form on file · the designation of ${fmtDate('2015-03-03', { year: true })} names ${first(held.name)}`, system: 'Policy administration', state: 'done' },
      { label: 'Hold the affected share', detail: `${first(held.name)}’s ${held.share}% · ${fmtMoney(amount)}`, system: 'Postgres', state: 'done' },
      { label: 'Send the letters', detail: `${first(CLAIMANT.name)} and ${first(held.name)}`, system: 'Letters service', state: 'done' },
    ],
    saved: ['Document and its fields', `Share held · ${resp.id} written, response due ${day(respondBy)}`, 'Exception, tag and party added', ...(rerouted ? ['Route → Standard life (LF-02)'] : [])],
  })
  lane(f, h.title, {
    outside: [`Letter from ${first(CLAIMANT.name)}’s attorney arrives`, 'Mail room scans it'],
    postgres: [`Document saved + event ${ev}`, `${first(held.name)}’s share held · ${resp.id} written`, ...(rerouted ? ['Route: Standard life'] : [])],
    temporal: [id, 'classify, read, compare, hold, notify'],
  }, id)
  syncHold(f)
}

/** The response deadline passes with no proof. The examiner resolves the claim or files an interpleader: see chooseFork. */
function onDisputeDue(f: LifeFlow, h: Happening): void {
  const row = f.deadlines.find((d) => d.kind === 'dispute_response_by' && d.status === 'open')
  const hold = f.hold
  if (!row || !hold) return
  const ex = examiner(f)
  const id = `deadline-${row.id}`
  closeRow(f, row, `Fired ${dayTime(f.now)} → no proof arrived; ${first(ex.name)} resolves the claim or files an interpleader`, 'done', true)
  hold.state = 'toResolve'
  addTask(f.claimId, `Resolve the competing claim or file an interpleader`, ex.name, `Deadline · ${id}`, h.date)
  workItems.insert({ id: newId('w'), ownerId: ex.id, claimId: f.claimId, priority: 1, action: `Resolve or interplead — ${first(hold.payee)}’s half`, why: `${hold.claimant} sent no proof in 30 days`, due: h.date, waitingOn: 'You', section: 'workflow', views: ['dueToday'], status: 'open' })
  patchClaim(f.claimId, (c) => ({
    exceptions: c.exceptions.map((x) => (x.id === 'x-dispute' ? { ...x, meta: 'Response overdue · decide' } : x)),
    nextStep: { label: 'Resolve the competing claim or file an interpleader', reason: `${hold.claimant} sent no proof by ${fmtDate(row.due)}`, section: 'workflow' },
  }))
  logEvent(f.claimId, { at: f.now, type: 'data', title: `Competing claim: no proof by ${fmtDate(row.due)}`, actor: `System · ${id}`, detail: `${row.id} came due · work item for ${ex.name}` })
  run(f, {
    id, type: 'Deadline workflow', name: 'Competing-claim response', startedBy: `Dispatcher · Temporal Schedule, every minute · ${row.id} due`, took: '4 s',
    steps: [
      { label: 'Re-check: has the claimant sent proof?', detail: `No 2024 form or court order from ${hold.claimant}`, system: 'Postgres', state: 'done' },
      { label: 'Alert the examiner', detail: `${ex.name} · resolve or interplead`, system: 'Notifications', state: 'done' },
      { label: 'Open the decision', detail: 'Work item and task', system: 'Postgres', state: 'done' },
    ],
    saved: [`${row.id} done`, 'Work item and task for the examiner', 'History'],
  })
  lane(f, h.title, {
    postgres: [`${row.id} due · dispatcher marks it dispatched`, `${row.id} done · decision opened`],
    temporal: [id, 're-check, alert, open decision'],
    outside: [`Alert to ${first(ex.name)}`],
    people: [`${first(ex.name)} has to resolve it or file an interpleader`],
  }, id)
  f.fork = {
    title: `Competing claim to ${first(hold.payee)}’s half`,
    text: `${hold.claimant} has sent no ${CLAIMANT.basis} or court order in 30 days, and nothing on file supports her claim. ${first(hold.payee)}’s ${fmtMoney(hold.amount)} is still held.`,
    actAt: `${addBusinessDays(h.date, 1)}T10:00`,
    choices: [
      { key: 'resolve', label: `Resolve in ${first(hold.payee)}’s favour`, detail: `The designation stands and ${first(hold.claimant)} signs a release. ${first(hold.payee)}’s half is paid in the next run, with interest.` },
      { key: 'interplead', label: 'File an interpleader', detail: `The court decides who is paid. The half stays held and the claim stays open, with a hold row and a review date.` },
    ],
  }
  syncHold(f)
}

/** Resolved in the designated beneficiary's favour: the hold ends, the share is cleared and paid in the next run. */
function onResolve(f: LifeFlow): void {
  const hold = f.hold!
  const ex = examiner(f)
  const held = f.payees.find((p) => p.id === hold.payeeId)!
  const today = f.now.slice(0, 10)
  const payDate = addBusinessDays(today, 1)
  const days = daysFrom(f.dateOfDeath, payDate)
  const interest = interestFor(hold.amount, days)
  const amount = sum([hold.amount, interest])
  f.hold = undefined
  f.status = 'approved'
  f.resolved = `${first(hold.payee)} · ${hold.claimant} signed a release`
  f.interest = sum([f.interest ?? 0, interest])
  f.script = [...f.script, { id: newId('hp'), kind: 'payRun', date: payDate, time: '02:00', title: `The daily payment run pays ${first(hold.payee)}’s half`, who: 'Batch' }]
  schedulePayment({ claimId: f.claimId, benefitLineId: 'bl-cast-wl', payDate, payee: hold.payee, basis: `${hold.share}% of proceeds + interest · released after the competing claim`, amount, method: held.packet === 'mail' ? 'Check' : 'EFT', status: { label: 'Cleared · next run', tone: 'info' }, gross: hold.amount, note: `interest ${fmtMoney(interest)}` })
  decisions.insert({
    id: newId('d'), claimId: f.claimId, benefitLineId: 'bl-cast-wl', title: `Whole life ${f.policyRef} · ${first(hold.payee)}’s half`, version: 2, recordedAt: f.now, recordedBy: ex.name,
    authorityNote: `within ${fmtMoney(ex.payoutLimit).replace('.00', '')} authority`, outcome: 'approved', outcomeText: `Approved · ${fmtMoney(hold.amount)} + ${fmtMoney(interest)} interest to ${first(hold.payee)}`,
    basis: `The designation of ${fmtDate('2015-03-03', { year: true })} stands; no ${CLAIMANT.basis} is on file. ${hold.claimant} signed a release. Interest from ${fmtDate(f.dateOfDeath)} to ${fmtDate(payDate)}.`,
    evidence: ['Beneficiary designation', `Claimant statement · ${first(hold.payee)}`, `Release · ${hold.claimant}`], provisions: ['Beneficiary · section 7'], approvals: [],
    letter: 'Resolution letters ADV-LIFE-03 and ADV-LIFE-04', assistantNote: 'No AI recommendation on the outcome. Readiness checks are rules, not suggestions.',
  })
  const closedRows = f.deadlines.filter((d) => d.kind === 'dispute_response_by' && d.status === 'open')
  closedRows.forEach((r) => closeRow(f, r, `Closed — resolved ${day(f.now)}`))
  const pay = addRow(f, { kind: 'payment_due', what: `Pay ${first(hold.payee)}’s half`, due: addBusinessDays(today, 2), sla: 'pay' })
  Object.assign(sl(f, 'pay'), { start: today, due: pay.due, metOn: undefined, note: 'Released after the competing claim' })
  sl(f, 'interest').note = `${first(f.payees.find((p) => p.id !== hold.payeeId)?.name ?? '')}’s half paid ${day(f.reached.paid ?? f.now)} · ${first(hold.payee)}’s half accruing`
  completeWork(f.claimId, 'workflow')
  completeWork(f.claimId, 'documents')
  patchClaim(f.claimId, (c) => ({
    stage: lifeStages(4),
    tags: c.tags.filter((t) => t.label !== 'Dispute'),
    exceptions: c.exceptions.map((x) => (x.id === 'x-dispute' ? { ...x, status: 'resolved' as const, meta: `Resolved ${fmtDate(today)}` } : x)),
    parties: c.parties.map((p) => (p.id === `p-${hold.payeeId}` ? { ...p, status: { label: `Cleared · paying ${fmtDate(payDate)}`, tone: 'info' as const } } : p.id === 'p-claimant' ? { ...p, status: { label: 'Claim not upheld', tone: 'neutral' as const } } : p)),
    benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-wl' ? { ...b, status: { label: `${first(hold.payee)}’s half approved ${fmtDate(today)}`, tone: 'positive' as const }, held: undefined, waitingOn: 'Payment run', due: fmtDate(payDate) } : b)),
    nextStep: { label: `Payment run ${fmtDate(payDate, { weekday: true })}`, reason: `${first(hold.payee)}’s half cleared · ${fmtMoney(amount)}`, section: 'payments' },
  }))
  summarize(f, `The competing claim is resolved in ${first(hold.payee)}’s favour on ${fmtDate(today)}: the designation stands and ${hold.claimant} signed a release. ${first(hold.payee)}’s half, ${fmtMoney(amount)} with interest, is cleared for the ${fmtDate(payDate)} payment run.`)
  const ev = nextEvent(f)
  const id = `event-${ev}`
  addCommunication({ claimId: f.claimId, at: f.now, channel: 'letter', direction: 'out', title: `Claim resolved · ${first(hold.claimant)}`, party: `${hold.claimant} · mail`, detail: `Your claim is not upheld: the designation on file stands, and you signed a release.`, status: { label: 'Sent', tone: 'neutral' }, template: 'ADV-LIFE-03' })
  addCommunication({ claimId: f.claimId, at: f.now, channel: held.packet === 'mail' ? 'letter' : 'email', direction: 'out', title: `Your share is released · ${first(hold.payee)}`, party: `${hold.payee} · ${held.packet === 'mail' ? 'mail' : 'portal and email'}`, detail: `The competing claim is resolved. Your ${hold.share}% is paid ${fmtDate(payDate)} with interest.`, status: { label: 'Sent', tone: 'positive' }, template: 'ADV-LIFE-04' })
  logEvent(f.claimId, { at: f.now, type: 'decision', title: `Competing claim resolved in ${first(hold.payee)}’s favour (decision v2)`, actor: `${ex.name} · whole life`, detail: `${fmtMoney(amount)} cleared for the ${fmtDate(payDate)} run · ${pay.id} written` })
  run(f, {
    id, type: 'Event workflow', name: 'Competing claim resolved', startedBy: `Outbox relay · event ${ev} (resolution saved)`, took: '10 s',
    steps: [
      { label: 'Generate the resolution letters', detail: 'ADV-LIFE-03 · ADV-LIFE-04', system: 'Letters service', state: 'done' },
      { label: 'Deliver', detail: `${first(hold.claimant)} by mail · ${first(hold.payee)} ${held.packet === 'mail' ? 'by mail' : 'in the portal and by email'}`, system: 'Notifications', state: 'done' },
      { label: 'Tell the agent of record', detail: f.consent ? 'Status: resolved, payment follows' : 'No consent', system: 'Notifications', state: f.consent ? 'done' : 'skipped' },
    ],
    saved: ['Letters in Communications', 'History'],
  })
  lane(f, `${first(ex.name)} resolves the claim in ${first(hold.payee)}’s favour`, {
    people: [`${first(ex.name)} and Legal resolve it`, `${first(hold.claimant)} signs a release`],
    postgres: ['Hold released · decision v2 locked', '1 payment item cleared', `${closedRows.map((r) => r.id).join(', ') || 'Rows'} closed · ${pay.id} written`],
    temporal: [id, 'resolution letters, agent'],
    batch: [`Item waits for the ${fmtDate(payDate)} run`],
  }, id)
  syncHold(f)
}

/** Interpleader: the court decides. The half stays held, the claim stays open, and a hold-review row carries the date. */
function onInterplead(f: LifeFlow): void {
  const hold = f.hold!
  const ex = examiner(f)
  const held = f.payees.find((p) => p.id === hold.payeeId)!
  const today = f.now.slice(0, 10)
  const reviewOn = addDays(today, 45)
  hold.state = 'interpleader'
  hold.reviewOn = reviewOn
  f.status = 'held'
  const review = addRow(f, { kind: 'hold_review', what: `Review the interpleader: court docket and ${first(hold.payee)}’s held half`, due: reviewOn })
  completeWork(f.claimId, 'workflow')
  patchClaim(f.claimId, (c) => ({
    exceptions: c.exceptions.map((x) => (x.id === 'x-dispute' ? { ...x, title: `Interpleader filed · ${first(hold.payee)}’s half held`, detail: `The court decides between ${first(hold.payee)} and ${hold.claimant}. The ${fmtMoney(hold.amount)} stays held; the claim stays open`, meta: `Review ${fmtDate(reviewOn)}`, action: { label: 'Open workflow', section: 'workflow' as const } } : x)),
    parties: c.parties.map((p) => (p.id === `p-${hold.payeeId}` ? { ...p, status: { label: 'Held · interpleader', tone: 'special' as const } } : p.id === 'p-claimant' ? { ...p, status: { label: 'Interpleader', tone: 'special' as const } } : p)),
    benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-wl' ? { ...b, held: `${fmtMoney(hold.amount)} held · interpleader`, waitingOn: 'The court', due: `review ${fmtDate(reviewOn)}` } : b)),
    nextStep: { label: 'Review the interpleader', reason: `The court decides ${first(hold.payee)}’s half · docket review ${fmtDate(reviewOn, { weekday: true })}`, section: 'workflow' },
  }))
  summarize(f, `The competing claim went to court. On ${fmtDate(today)} an interpleader was filed asking the court to decide between ${first(hold.payee)} and ${hold.claimant}. ${first(hold.payee)}’s half, ${fmtMoney(hold.amount)} plus interest, stays held and the claim stays open. ${first(f.payees.find((p) => p.id !== hold.payeeId)?.name ?? '')}’s half was paid ${fmtDate((f.reached.paid ?? f.now).slice(0, 10))}. The docket is reviewed on ${fmtDate(reviewOn)}.`)
  const ev = nextEvent(f)
  const id = `event-${ev}`
  for (const [name, packet] of [[held.name, held.packet], [hold.claimant, 'mail']] as const) {
    addCommunication({ claimId: f.claimId, at: f.now, channel: packet === 'mail' ? 'letter' : 'email', direction: 'out', title: `Interpleader filed · ${first(name)}`, party: `${name} · ${packet === 'mail' ? 'mail' : 'portal and email'}`, detail: `The company has asked the court to decide who is paid ${first(hold.payee)}’s ${hold.share}%. It stays held until the court orders otherwise.`, status: { label: 'Sent', tone: 'neutral' }, template: 'ITP-LIFE-01' })
  }
  logEvent(f.claimId, { at: f.now, type: 'decision', title: `Interpleader filed — ${first(hold.payee)}’s half held for the court`, actor: `${ex.name} · whole life`, detail: `${fmtMoney(hold.amount)} plus interest held · ${review.id} review on ${fmtDate(reviewOn)} · claim stays open` })
  run(f, {
    id, type: 'Event workflow', name: 'Interpleader filed', startedBy: `Outbox relay · event ${ev} (interpleader recorded)`, took: '12 s',
    steps: [
      { label: 'Hand the filing to outside counsel', detail: 'Complaint in interpleader · the file, designation and both claims', system: 'Legal matters', state: 'done' },
      { label: 'Generate the notices', detail: 'ITP-LIFE-01 × 2', system: 'Letters service', state: 'done' },
      { label: 'Deliver', detail: `${first(hold.payee)} ${held.packet === 'mail' ? 'by mail' : 'in the portal and by email'} · ${first(hold.claimant)} by mail`, system: 'Notifications', state: 'done' },
      { label: 'Tell the agent of record', detail: f.consent ? 'Status: one share with the court' : 'No consent', system: 'Notifications', state: f.consent ? 'done' : 'skipped' },
    ],
    saved: ['Letters in Communications', `${review.id} hold review written, due ${day(reviewOn)}`, 'History'],
  })
  lane(f, `${first(ex.name)} files an interpleader`, {
    people: [`${first(ex.name)} and Legal file it`],
    outside: ['Outside counsel gets the filing', `Notices to ${first(hold.payee)} and ${first(hold.claimant)}`],
    postgres: ['Share stays held · claim stays open', `${review.id} hold review written · due ${fmtDate(reviewOn)}`],
    temporal: [id, 'file, notify, agent'],
  }, id)
  syncHold(f)
}

/** The payment screen's hold panel for the held share, kept in step with the flow. */
function syncHold(f: LifeFlow): void {
  const h = f.hold
  const done = (ok: boolean, current = false): 'done' | 'current' | 'todo' => (ok ? 'done' : current ? 'current' : 'todo')
  const rate = (h?.amount ?? 0) * INTEREST_RATE / 365
  const holds: PaymentHold[] = h ? [{
    id: `hold-${f.claimId}-competing`,
    tone: h.state === 'interpleader' ? 'special' : 'caution',
    title: h.state === 'interpleader' ? `${first(h.payee)}’s half held for the court` : `${first(h.payee)}’s half held for a competing claim`,
    detail: `${h.claimant} says ${CLAIMANT.basis} names her for ${first(h.payee)}’s share. None is on file, and the designation names ${first(h.payee)}. A share two people claim can’t be paid, so it waits until the claim is resolved or a court decides. The other half is paid as usual.`,
    amount: h.amount,
    facts: [
      [h.payee, `${h.share}% · ${fmtMoney(h.amount)} before interest`],
      ['Competing claimant', `${h.claimant} · ${CLAIMANT.via} on ${fmtDate(h.since)}`],
      ['Held since', fmtDate(h.since)],
      ['Releases on', h.state === 'interpleader' ? `The court’s order · docket review ${fmtDate(h.reviewOn!)}` : 'The claim resolved in writing, or a court order'],
    ],
    steps: [
      { label: 'Competing claim received', detail: `${fmtDate(h.since)} · share held`, state: 'done' },
      { label: `${first(h.claimant)} asked for ${CLAIMANT.basis} or a court order`, detail: '30 days', state: done(h.state !== 'claimed', true) },
      h.state === 'interpleader'
        ? { label: 'Interpleader filed', detail: 'The court decides who is paid', state: 'done' }
        : { label: 'Resolve the claim or file an interpleader', state: done(false, h.state === 'toResolve') },
      h.state === 'interpleader'
        ? { label: 'Court decides', detail: `Docket review ${fmtDate(h.reviewOn!)}`, state: 'current' }
        : { label: `Payments releases ${first(h.payee)}’s half`, detail: 'With interest to the release date', state: 'todo' },
      ...(h.state === 'interpleader' ? [{ label: 'Payments releases to the person the court names', detail: 'With interest to the release date', state: 'todo' as const }] : []),
    ],
    interest: `Interest at ${(INTEREST_RATE * 100).toFixed(1)}% a year keeps accruing on the held ${fmtMoney(h.amount)}, about ${fmtMoney(Math.round(rate * 100) / 100)} a day, and is paid with the release.`,
    action: { label: 'Open the workflow', section: 'workflow' },
  }] : []
  setPaymentProfile({
    claimId: f.claimId,
    subtitle: 'Whole life death benefit · each share paid separately',
    tiles: [
      { label: 'Next payment', value: '', compute: 'nextPayment' },
      { label: 'Paid to date', value: '', compute: 'paidToDate' },
      ...(h ? [{ label: 'Held', value: fmtMoney(h.amount), note: `${first(h.payee)} · ${h.state === 'interpleader' ? 'interpleader' : 'competing claim'}` }] : []),
    ],
    schedule: { aside: `Whole life ${f.policyRef} · ${f.payees.map((p) => `${p.share}%`).join(' / ')}`, columns: 'basic' },
    holds,
    actions: ['oneTime', 'overpayment'],
  })
}

// ---------------------------------------------------------------- Forks: a person picks the way out (mock only)

/**
 * Mock only — POST /mock/claims/{id}/workflow:choose. Where a happening needs a person's decision (waive or close
 * incomplete, resolve or interplead), Play next stops and the examiner picks. The choice is applied on the claim's clock.
 */
export function chooseFork(claimId: string, key: ForkChoice['key'], reason?: string): Promise<Happening> {
  const cur = flows.get(claimId)
  const choice = cur?.fork?.choices.find((c) => c.key === key)
  if (!cur || !cur.fork || !choice) return fail('There is nothing to choose on this claim right now')
  if (choice.needsReason && !reason?.trim()) return fail('A reason is required to waive a requirement')
  const f = structuredClone(cur)
  f.now = cur.fork.actAt
  f.fork = undefined
  switch (key) {
    case 'waive': onWaive(f, reason ?? ''); break
    case 'closeIncomplete': onCloseIncomplete(f); break
    case 'resolve': onResolve(f); break
    case 'interplead': onInterplead(f); break
  }
  const h: Happening = { id: newId('hp'), kind: 'choose', date: f.now.slice(0, 10), time: f.now.slice(11, 16), title: `${first(examiner(f).name)}: ${choice.label.charAt(0).toLowerCase()}${choice.label.slice(1)}`, who: 'Examiner' }
  f.done.push(h)
  save(f)
  return respond(h)
}

// ---- The decision. Locking it and creating payment items is Postgres only; letters go through a workflow.
function onDecide(f: LifeFlow, by: User): RecordResult {
  const total = f.total + interestFor(f.total, daysFrom(f.dateOfDeath, payDateFor(f)))
  if (total > by.payoutLimit) {
    f.status = 'awaitingApproval'
    completeWork(f.claimId, 'decision')
    workItems.insert({ id: newId('w'), ownerId: TEAM_LEAD.id, claimId: f.claimId, priority: 1, action: 'Approve payout above authority', why: `${by.name} · ${fmtMoney(total)} · limit ${fmtMoney(by.payoutLimit)}`, due: f.now.slice(0, 10), waitingOn: 'You', section: 'decision', views: ['dueToday'], status: 'open' })
    patchClaim(f.claimId, { stage: lifeStages(3), nextStep: { label: 'Waiting on approval', reason: `${TEAM_LEAD.name} · ${fmtMoney(total)} is above ${by.name}’s authority`, section: 'decision' } })
    logEvent(f.claimId, { at: f.now, type: 'decision', title: 'Approval requested — above the examiner’s authority', actor: by.name, detail: `${fmtMoney(total)} above ${fmtMoney(by.payoutLimit)}` })
    lane(f, `${first(by.name)} recommends approval`, {
      people: [`${first(by.name)}: approve ${fmtMoney(total)}`],
      postgres: ['Recommendation saved', `Work item for ${first(TEAM_LEAD.name)}`],
      temporal: ['No workflow — Postgres only'],
    })
    if (!f.script.some((h) => h.kind === 'approve')) {
      f.script.unshift({ id: newId('hp'), kind: 'approve', date: f.now.slice(0, 10), time: '15:10', title: `${TEAM_LEAD.name} approves above ${first(by.name)}’s authority`, who: 'Team lead' })
    }
    return { kind: 'sentForApproval', message: `Sent to ${TEAM_LEAD.name} for approval.` }
  }
  f.script = f.script.filter((h) => h.kind !== 'approve')
  return approve(f, by, by)
}

function onApprove(f: LifeFlow): void {
  approve(f, TEAM_LEAD, examiner(f))
}

function payDateFor(f: LifeFlow): ISODate {
  return f.script.find((h) => h.kind === 'payRun')?.date ?? addBusinessDays(f.now.slice(0, 10), 1)
}

function approve(f: LifeFlow, approver: User, ex: User): RecordResult {
  const today = f.now.slice(0, 10)
  const payDate = payDateFor(f)
  const days = daysFrom(f.dateOfDeath, payDate)
  const interest = interestFor(f.total, days)
  const shares = split(f.total, f.payees.map((p) => p.share))
  const ints = split(interest, f.payees.map((p) => p.share))
  // A share a second person claims isn't cleared: it waits for the resolution or an interpleader.
  const held = f.hold ? f.payees.find((p) => p.id === f.hold!.payeeId) : undefined
  const paying = f.payees.filter((p) => p !== held)
  const payIdx = paying.map((p) => f.payees.indexOf(p))
  const cleared = sum(payIdx.map((i) => shares[i]))
  const clearedInterest = sum(payIdx.map((i) => ints[i]))
  f.reached.decision = f.now
  f.status = 'approved'
  f.payDate = payDate
  f.interest = clearedInterest
  const above = approver.id !== ex.id
  const names = paying.map((p) => first(p.name)).join(' and ')

  decisions.insert({
    id: newId('d'), claimId: f.claimId, benefitLineId: 'bl-cast-wl', title: `Whole life ${f.policyRef}`, version: 1, recordedAt: f.now, recordedBy: ex.name,
    authorityNote: above ? `approved by ${approver.name} above ${fmtMoney(ex.payoutLimit).replace('.00', '')} authority` : `within ${fmtMoney(ex.payoutLimit).replace('.00', '')} authority`,
    outcome: held ? 'approvedInPart' : 'approved', outcomeText: held ? `Approved in part · ${names} ${fmtMoney(sum([cleared, clearedInterest]))} with interest · ${first(held.name)}’s ${held.share}% held` : `Approved · ${fmtMoney(f.face)} + ${fmtMoney(interestFor(f.face, days))} interest`,
    basis: `In force and past the contestable period. ${f.payees.map((p) => `${first(p.name)} ${p.share}%`).join(' and ')} as contingent beneficiaries; interest from ${fmtDate(f.dateOfDeath)} to ${fmtDate(payDate)}.${held ? ` ${first(held.name)}’s share is held: ${f.hold!.claimant} claims it and the file has no ${CLAIMANT.basis}.` : ''}`,
    evidence: ['Death certificate', ...f.payees.map((p) => `Claimant statement · ${first(p.name)}`), 'Beneficiary designation'],
    provisions: ['Death benefit · section 2', 'Beneficiary · section 7'], approvals: above ? [`${approver.name} · ${f.now.slice(11, 16)}`] : [],
    letter: 'Approval letter APR-LIFE-01 to each beneficiary', assistantNote: 'No AI recommendation on the outcome. Readiness checks are rules, not suggestions.',
  })
  if (f.adb) {
    decisions.insert({
      id: newId('d'), claimId: f.claimId, benefitLineId: 'bl-cast-adb', title: `Accidental death rider ${f.policyRef}`, version: 1, recordedAt: f.now, recordedBy: ex.name,
      authorityNote: above ? `approved by ${approver.name}` : 'rider follows the base decision',
      outcome: f.adb.payable ? 'approved' : 'closed', outcomeText: f.adb.payable ? `Approved · ${fmtMoney(f.adb.amount)} + ${fmtMoney(interestFor(f.adb.amount, days))} interest` : 'Closed · not payable',
      basis: f.adb.payable ? 'The accident report and certificate show an accidental death; no exclusion applies.' : 'The certificate gives natural causes. The rider pays only for an accidental death.',
      evidence: f.adb.payable ? ['Death certificate', 'Accident report'] : ['Death certificate'], provisions: ['Accidental death benefit rider'], approvals: [],
      letter: f.adb.payable ? 'Included in the approval letters' : 'Rider explanation ADB-LIFE-03 with the approval letters',
    })
  }
  removeWorkbenches(f.claimId)
  f.payees.forEach((p, i) => p !== held && schedulePayment({
    claimId: f.claimId, benefitLineId: 'bl-cast-wl', payDate, payee: p.name, basis: `${p.share}% of proceeds + interest`,
    amount: sum([shares[i], ints[i]]), method: p.packet === 'mail' ? 'Check' : 'EFT', status: { label: 'Cleared · next run', tone: 'info' }, gross: shares[i], note: `interest ${fmtMoney(ints[i])}`,
  }))

  const closed: string[] = []
  for (const r of f.deadlines.filter((d) => d.status === 'open')) {
    if (r.kind === 'decision_due' || r.kind === 'review_target') { closeRow(f, r, `Met — decided ${day(f.now)}`); closed.push(r.id) }
    if (r.kind === 'status_letter') { closeRow(f, r, 'Skipped — the claim was decided first', 'skipped'); closed.push(r.id) }
  }
  sl(f, 'decide').metOn = f.now
  sl(f, 'review').metOn = f.now
  sl(f, 'status').stopped = `Stopped ${day(f.now)} — decided`
  const pay = addRow(f, { kind: 'payment_due', what: `Pay ${names}`, due: addBusinessDays(today, 2), sla: 'pay' })
  Object.assign(sl(f, 'pay'), { start: today, due: pay.due })

  const grand = sum([cleared, clearedInterest])
  patchClaim(f.claimId, (c) => ({
    stage: lifeStages(4),
    benefitLines: c.benefitLines.map((b) =>
      b.id === 'bl-cast-wl' ? { ...b, status: { label: held ? `Approved ${fmtDate(today)} · ${first(held.name)}’s half held` : `Approved ${fmtDate(today)}`, tone: 'positive' }, paid: `${fmtMoney(held ? grand : sum([f.face, interestFor(f.face, days)]))} paying ${fmtDate(payDate)}`, waitingOn: held ? 'Payment run · competing claim' : 'Payment run', due: fmtDate(payDate) }
        : b.id === 'bl-cast-adb' ? { ...b, status: f.adb?.payable ? { label: `Approved ${fmtDate(today)}`, tone: 'positive' } : { label: 'Closed · not payable', tone: 'neutral' }, waitingOn: f.adb?.payable ? 'Payment run' : undefined }
          : b),
    nextStep: { label: `Payment run ${fmtDate(payDate, { weekday: true })}`, reason: `${plural(paying.length, 'item')} cleared · ${fmtMoney(grand)}${held ? ` · ${first(held.name)}’s half held` : ''}`, section: 'payments' },
  }))
  completeWork(f.claimId, 'decision')
  summarize(f, `Approved on ${fmtDate(today)}${above ? ` by ${approver.name}` : ''}: ${fmtMoney(f.total)} plus ${fmtMoney(interest)} interest, split ${f.payees.map((p) => `${first(p.name)} ${p.share}%`).join(' and ')}. ${f.adb && !f.adb.payable ? 'The accidental death rider doesn’t pay; the letters explain why. ' : ''}${held ? `${names}’s payment item is cleared for the ${fmtDate(payDate)} payment run; ${first(held.name)}’s half is held for the competing claim.` : `Both payment items are cleared for the ${fmtDate(payDate)} payment run.`}`)

  const ev = nextEvent(f)
  const id = `event-${ev}`
  for (const p of f.payees) {
    addCommunication({ claimId: f.claimId, at: f.now, channel: p.packet === 'mail' ? 'letter' : 'email', direction: 'out', title: `Approval letter · ${first(p.name)}`, party: `${p.name} · ${p.packet === 'mail' ? 'mail' : 'portal and email'}`, detail: p === held ? `Approved, but your ${p.share}% is held while a competing claim is resolved. We will write when it is.` : `Approved. ${p.share}% of the proceeds with interest, paid ${fmtDate(payDate)}.${f.adb && !f.adb.payable ? ' Includes why the accidental death rider doesn’t pay.' : ''}`, status: { label: 'Sent', tone: p === held ? 'neutral' : 'positive' }, template: p === held ? 'APR-LIFE-02' : 'APR-LIFE-01' })
  }
  if (f.consent) addCommunication({ claimId: f.claimId, at: f.now, channel: 'email', direction: 'out', title: 'Agent notification · approved', party: `${f.agent} · agent of record`, detail: 'The claim is approved; payment follows. Status only.', status: { label: 'Sent', tone: 'positive' }, template: 'AGT-NOTE-02' })
  logEvent(f.claimId, { at: f.now, type: 'decision', title: `Decision recorded — ${held ? 'approved in part' : 'approved'} (v1)${above ? `, approved by ${approver.name}` : ''}`, actor: `${ex.name} · whole life`, detail: `${fmtMoney(grand)} to ${names}${held ? ` · ${first(held.name)}’s ${held.share}% held for the competing claim` : ''}`, ref: 'Decision record' })
  logEvent(f.claimId, { at: f.now, type: 'payment', title: `${plural(paying.length, 'payment item')} cleared for the ${fmtDate(payDate)} run`, actor: 'System · on decision', detail: `${closed.join(', ')} closed · ${pay.id} written` })
  run(f, {
    id, type: 'Event workflow', name: 'Decision recorded', startedBy: `Outbox relay · event ${ev} (decision saved)`, took: '11 s',
    steps: [
      { label: 'Generate the approval letters', detail: `APR-LIFE-01 × ${f.payees.length}`, system: 'Letters service', state: 'done' },
      ...(f.adb && !f.adb.payable ? [{ label: 'Explain the rider outcome', detail: 'ADB-LIFE-03 · natural causes', system: 'Letters service', state: 'done' as const }] : []),
      { label: 'Deliver the way each beneficiary chose', detail: f.payees.map((p) => `${first(p.name)} ${p.packet === 'mail' ? 'by mail' : 'in the portal and by email'}`).join(' · '), system: 'Notifications', state: 'done' },
      { label: 'Tell the agent of record', detail: f.consent ? 'Status: approved' : 'No consent', system: 'Notifications', state: f.consent ? 'done' : 'skipped' },
    ],
    saved: ['Letters in Communications', 'History'],
  })
  lane(f, above ? `${approver.name.split(' ')[0]} approves` : `${first(ex.name)} records the decision`, {
    people: [above ? `${first(approver.name)} approves above authority` : `${first(ex.name)}: approve ${fmtMoney(grand)}${held ? ` (${first(held.name)}’s half held)` : ''}`],
    postgres: ['Decision locked (v1)', `${plural(paying.length, 'payment item')} cleared${held ? ` · ${first(held.name)}’s half held` : ''}`, `${closed.join(', ')} closed · ${pay.id} written`],
    temporal: [id, 'approval letters, agent'],
    batch: [`Items wait for the ${fmtDate(payDate)} run`],
  }, id)
  if (held) syncHold(f)
  return { kind: 'recorded', message: `Decision recorded · ${fmtMoney(grand)} cleared for the ${fmtDate(payDate)} payment run${held ? `; ${first(held.name)}’s half is held` : ''}` }
}

// ---- Batch pays; the confirmation event closes the claim (or, with a share on hold, leaves it open).
function onPayRun(f: LifeFlow): void {
  const today = f.now.slice(0, 10)
  const items = payments.where((p) => p.claimId === f.claimId && p.status.tone === 'info')
  items.forEach((p) => payments.update(p.id, { status: { label: `Paid ${fmtDate(today)}`, tone: 'positive' } }))
  const paid = sum(items.map((p) => p.amount))
  // A replacement for a returned payment: the first payment date stays the claim's paid date.
  const reissue = f.bounced?.reissued ? f.bounced.returned : undefined
  if (!reissue) f.reached.paid = f.now
  const row = f.deadlines.find((d) => d.kind === 'payment_due' && d.status === 'open')
  if (row) closeRow(f, row, `Met — paid in the ${f.now.slice(11, 16)} run`)
  sl(f, reissue ? 'reissue' : 'pay').metOn = f.now
  const holding = f.hold
  if (reissue) {
    // Interest was settled with the first payment.
  } else if (holding) {
    sl(f, 'interest').note = `${plural(daysFrom(f.dateOfDeath, today), 'day')} · ${fmtMoney(f.interest ?? 0)} paid · ${first(holding.payee)}’s half still accruing`
  } else {
    sl(f, 'interest').metOn = f.now
    sl(f, 'interest').note = f.resolved ? `${fmtMoney(f.interest ?? 0)} in all · paid in two runs` : `${plural(daysFrom(f.dateOfDeath, today), 'day')} · ${fmtMoney(f.interest ?? 0)}`
  }
  logEvent(f.claimId, { at: f.now, type: 'payment', title: `Paid ${fmtMoney(paid)} in the daily payment run`, actor: 'Batch · payment run', detail: items.map((p) => `${p.payee} ${fmtMoney(p.amount)} by ${p.method}`).join(' · ') })
  lane(f, reissue ? `The daily payment run pays ${first(reissue.payee)}’s replacement` : 'The daily payment run', {
    batch: ['Payment run 02:00', `${plural(items.length, 'item')} · ${fmtMoney(paid)}`, 'Bank file sent'],
    outside: ['Bank accepts the file'],
    postgres: ['Items paid · event written'],
    temporal: ['Not involved — batch runs on its own scheduler'],
  })

  // The confirmation event follows a few minutes later; it closes the claim only when every share is settled.
  f.now = `${today}T02:06`
  const ev = nextEvent(f)
  const id = `event-${ev}`
  const paidPayees = f.payees.filter((p) => items.some((x) => x.payee === p.name))
  const paidNames = paidPayees.map((p) => first(p.name)).join(' and ')
  const total = sum(payments.where((p) => p.claimId === f.claimId && p.status.tone === 'positive').map((p) => p.amount))
  const runInterest = sum(items.map((p) => p.amount - (p.gross ?? 0)))
  f.status = holding ? 'held' : 'closed'
  if (!holding) f.reached.closed = f.now
  for (const p of paidPayees) {
    addCommunication({ claimId: f.claimId, at: f.now, channel: 'email', direction: 'out', title: `Payment sent · ${first(p.name)}`, party: `${p.name} · email`, detail: `${fmtMoney(items.find((x) => x.payee === p.name)?.amount ?? 0)} sent today. A 1099-INT for the interest follows in January.${holding ? ` The rest of the proceeds are on hold for a competing claim; we will write when it is resolved.` : ''}`, status: { label: 'Sent', tone: 'positive' }, template: 'PAY-LIFE-01' })
  }
  if (!holding) addCommunication({ claimId: f.claimId, at: f.now, channel: 'letter', direction: 'out', title: 'Claim closed', party: `${f.payees.map((p) => p.name).join(', ')} · closing letter`, detail: 'Every benefit line is paid or closed.', status: { label: 'Sent', tone: 'positive' }, template: 'CLS-LIFE-01' })
  patchClaim(f.claimId, (c) => ({
    stage: holding ? lifeStages(4) : LIFE_STAGES.map((label) => ({ key: label.toLowerCase(), label, state: 'done' as const })),
    benefitLines: c.benefitLines.map((b) => (b.id === 'bl-cast-wl' || (b.id === 'bl-cast-adb' && f.adb?.payable)
      ? holding
        ? { ...b, status: { label: `${paidNames} paid ${fmtDate(today)} · ${first(holding.payee)}’s half held`, tone: 'info' as const }, paid: `${fmtMoney(total)} paid ${fmtDate(today)}`, held: `${fmtMoney(holding.amount)} held · competing claim`, waitingOn: 'Competing claim', due: undefined }
        : { ...b, status: { label: `Paid ${fmtDate(today)}`, tone: 'positive' as const }, paid: `${fmtMoney(total)} paid${f.resolved ? '' : ` ${fmtDate(today)}`}`, held: undefined, waitingOn: undefined, due: undefined }
      : b)),
    parties: c.parties.map((p) => (paidPayees.some((x) => `p-${x.id}` === p.id) ? { ...p, status: { label: `Paid ${fmtDate(today)}`, tone: 'positive' as const } } : p)),
    tags: c.tags.filter((t) => t.label !== 'Payment returned'),
    exceptions: c.exceptions.map((x) => (x.id === 'x-return' ? { ...x, status: 'resolved' as const, meta: `Paid again ${fmtDate(today)}` } : x)),
    nextStep: holding
      ? { label: 'Wait for the competing claim', reason: `${holding.claimant} has until ${fmtDate(f.deadlines.find((d) => d.kind === 'dispute_response_by' && d.status === 'open')?.due ?? today)} to send proof`, section: 'workflow' }
      : { label: 'Claim closed', reason: `Paid ${fmtDate(today)} · ${fmtMoney(paid)}`, section: 'history' },
  }))
  const late = f.serviceLevels.filter((s) => s.lateDays)
  const levels = late.length ? `${late.map((s) => `${s.name} was ${plural(s.lateDays!, 'day')} late`).join('; ')}; every other service level was met` : 'Every service level was met'
  summarize(f, reissue
    ? `Closed again on ${fmtDate(today)}. ${first(reissue.payee)}’s replacement, ${fmtMoney(paid)}, went to his new account in the daily payment run; the first payment was returned on ${fmtDate(reissue.on)} because the account was closed. In all ${fmtMoney(total)} was paid, including ${fmtMoney(f.interest ?? 0)} interest. ${levels}; the interest goes on a 1099-INT in January.`
    : holding
    ? `${paidNames}’s half was paid on ${fmtDate(today)}: ${fmtMoney(paid)}, including ${fmtMoney(runInterest)} interest for ${plural(daysFrom(f.dateOfDeath, today), 'day')}. ${first(holding.payee)}’s half, ${fmtMoney(holding.amount)} plus interest, stays held while ${holding.claimant}’s claim is open, so the claim stays open.`
    : f.resolved
      ? `Closed ${fmtDate(today)}. The competing claim was resolved in ${first(paidPayees[0].name)}’s favour, so the held half was paid in this run: ${fmtMoney(paid)} with ${fmtMoney(runInterest)} interest. In all ${fmtMoney(total)} was paid to ${f.payees.map((p) => first(p.name)).join(' and ')}, including ${fmtMoney(f.interest ?? 0)} interest. ${levels}; the interest goes on a 1099-INT in January.`
      : `Closed ${fmtDate(today)}. ${fmtMoney(paid)} paid in the daily payment run to ${f.payees.map((p) => first(p.name)).join(' and ')}, including ${fmtMoney(f.interest ?? 0)} interest for ${plural(daysFrom(f.dateOfDeath, today), 'day')}. ${levels}; the interest goes on a 1099-INT in January.`)
  logEvent(f.claimId, holding
    ? { at: f.now, type: 'data', title: `${paidNames}’s half paid — claim stays open`, actor: `System · ${id}`, detail: `${first(holding.payee)}’s ${fmtMoney(holding.amount)} held · interest so far ${fmtMoney(f.interest ?? 0)} flagged for the 1099-INT` }
    : { at: f.now, type: 'data', title: 'Claim closed — every benefit line paid or closed', actor: `System · ${id}`, detail: `Interest ${fmtMoney(f.interest ?? 0)} flagged for 1099-INT` })
  run(f, {
    id, type: 'Event workflow', name: 'Payment confirmed', startedBy: `Outbox relay · event ${ev} (items paid)`, took: '8 s',
    steps: [
      { label: 'Send payment confirmations', detail: paidNames, system: 'Notifications', state: 'done' },
      { label: 'Are all benefit lines settled?', detail: holding ? `No — ${first(holding.payee)}’s half is on hold` : 'Yes — close the claim', system: 'Postgres', state: 'done' },
      { label: 'Send the closing letter', detail: holding ? 'Not yet — the claim stays open' : 'CLS-LIFE-01', system: 'Letters service', state: holding ? 'skipped' : 'done' },
      { label: 'Tell the agent of record', detail: f.consent ? (holding ? 'Status: half paid, half on hold' : 'Status: closed') : 'No consent', system: 'Notifications', state: f.consent ? 'done' : 'skipped' },
    ],
    saved: holding
      ? ['Status → Open · share on hold', `Interest ${fmtMoney(f.interest ?? 0)} so far flagged for the January 1099-INT batch`, 'History']
      : ['Status → Closed', `Interest ${fmtMoney(f.interest ?? 0)} flagged for the January 1099-INT batch`, 'History'],
    temporal: reissue ? 'The same workflow type as the first close, started by a new event. Every benefit line is settled again, so it closes the claim a second time. No workflow was open while the claim waited for the new account.' : undefined,
  })
  lane(f, holding ? 'Payment confirmed — the claim stays open' : 'Payment confirmed — the claim closes', {
    postgres: holding ? ['Status: Open · share on hold', `${first(holding.payee)}’s half still held`] : ['Status: Closed', '1099-INT flag for January'],
    temporal: [id, holding ? 'confirmations, agent' : 'confirmations, closing letter'],
    outside: [`Emails to ${paidNames}`],
    ...(holding ? {} : { batch: ['January tax-form batch picks up the 1099-INT'] }),
  }, id)
  if (holding) syncHold(f)
}

// ---------------------------------------------------------------- Decisions from the Decision section

/** Approvals recorded on the workbench go through the flow, so its deadlines and service levels stay in step. */
registerDecisionHandler(({ claimId, outcome, by }) => {
  const cur = flows.get(claimId)
  if (!cur || cur.status !== 'inReview' || outcome !== 'approve') return undefined
  const f = structuredClone(cur)
  const h = f.script.find((x) => x.kind === 'decide')
  f.script = f.script.filter((x) => x !== h)
  if (h) {
    f.now = `${h.date}T${h.time}`
    f.done.push({ ...h, title: `${by.name} records the decision`, who: by.role === 'teamLead' ? 'Team lead' : 'Examiner' })
  }
  const result = onDecide(f, by)
  save(f)
  return respond(result)
})
