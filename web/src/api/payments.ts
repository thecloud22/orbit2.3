import { PAYMENTS, PAYMENT_PROFILES } from './fixtures/payments'
import { collection, fail, newId, respond } from './store'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import { claims, patchClaim, setNextStep } from './claims'
import { logEvent } from './history'
import { addTask } from './tasks'
import { completeWork } from './work'
import { addCommunication } from './communications'
import { fmtDate, nowStamp, TODAY } from '../lib/dates'
import { fmtMoney, sum } from '../lib/money'
import type { Payment, SectionKey, Status, Suggestion, Tone } from './types'

// ---------------------------------------------------------------- Types owned by the Payments screen

/** A payment with the optional breakdown the schedule shows (benefit + COLA, gross − withholding). */
export interface PaymentRow extends Payment {
  gross?: number
  cola?: number
  withheld?: number
  /** Small line under the status, e.g. 'valid to 30 Nov'. */
  note?: string
}

export interface PaymentTile {
  label: string
  value: string
  note?: string
  /** Computed from the payment rows instead of the static value. */
  compute?: 'paidToDate' | 'nextPayment'
}

export interface CalcRow {
  op?: '+' | '−' | '=' | '×'
  label: string
  detail?: string
  source?: string
  amount: string
  strong?: boolean
}

export interface ChartPoint {
  /** First day the amount applies, ISO. */
  from: string
  amount: number
  projected?: boolean
}

export interface ReleaseControl {
  label: string
  note?: string
  pass: boolean
}

export interface RelatedLine {
  name: string
  ref: string
  status: Status
  summary: string
  description: string
  ledger: [string, number][]
}

export interface HoldStep {
  label: string
  detail?: string
  state: 'done' | 'current' | 'todo'
}

export interface PaymentHold {
  id: string
  tone: Tone
  title: string
  detail: string
  amount: number
  facts: [string, string][]
  steps: HoldStep[]
  contact?: { name: string; title: string; note: string }
  interest?: string
  /** Link to the section that moves the hold along, e.g. the custodian packet. */
  action?: { label: string; section: SectionKey; target?: string }
  secondary?: { label: string; section: SectionKey; target?: string }
}

/** Static, per-claim content of the Payments screen: what the benefit is and how it is paid. */
export interface PaymentProfile {
  claimId: string
  subtitle: string
  tiles: PaymentTile[]
  calculation?: { title: string; aside: string; rows: CalcRow[] }
  chart?: { title: string; points: ChartPoint[]; note: string; end: string }
  related?: RelatedLine[]
  schedule?: { aside: string; columns: 'di' | 'lump' | 'basic'; recent?: number }
  release?: { controls: ReleaseControl[]; footTitle: string; footNote: string }
  payeeTax?: [string, string][]
  holds?: PaymentHold[]
  taxNotes?: string[]
  suggestion?: Suggestion
  /** Rows that aren't payments yet, e.g. a share waiting on good order. */
  pending?: { payee: string; basis: string; amount: string; status: Status }[]
  /** Which special panel the claim needs. */
  special?: 'survivor' | 'returnToWork' | 'fastTrack'
  survivor?: {
    contract: [string, string][]
    events: [string, string][]
    calc: CalcRow[]
    plans: { id: string; label: string; detail: string }[]
    whenRecorded: string[]
  }
  actions?: ('oneTime' | 'adjust' | 'overpayment')[]
}

/** A change to money that someone has to review before it happens. Nothing changes silently. */
export interface PaymentDraft {
  id: string
  claimId: string
  kind: 'oneTime' | 'adjust' | 'overpayment' | 'survivor' | 'returnToWork'
  title: string
  detail: string
  by: string
  at: string
  status: Status
}

// ---------------------------------------------------------------- Collections

export const payments = collection<PaymentRow>(PAYMENTS)
export const paymentDrafts = collection<PaymentDraft>([])
const profiles = collection<PaymentProfile & { id: string }>(Object.values(PAYMENT_PROFILES).map((p) => ({ ...p, id: p.claimId })))

/** GET /claims/{id}/payments */
export function listPayments(claimId: string): Promise<PaymentRow[]> {
  if (isLiveId(claimId)) return live.listPayments(claimId)
  return respond(payments.where((p) => p.claimId === claimId).sort((a, b) => b.payDate.localeCompare(a.payDate)))
}

export function schedulePayment(p: Omit<PaymentRow, 'id'>): PaymentRow {
  return payments.insert({ id: newId('pay'), ...p })
}

/** Internal: the life claim workflow writes a payment profile when a share is held (competing claimant). */
export function setPaymentProfile(p: PaymentProfile): void {
  if (profiles.get(p.claimId)) profiles.update(p.claimId, { ...p, id: p.claimId })
  else profiles.insert({ ...p, id: p.claimId })
}

/** GET /claims/{id}/payment-profile — undefined when the claim has no payment setup yet. */
export function getPaymentProfile(claimId: string): Promise<PaymentProfile | null> {
  if (isLiveId(claimId)) return respond(null)
  return respond(profiles.get(claimId) ?? null)
}

/** GET /claims/{id}/payment-drafts */
export function listPaymentDrafts(claimId: string): Promise<PaymentDraft[]> {
  if (isLiveId(claimId)) return respond([])
  return respond(paymentDrafts.where((d) => d.claimId === claimId).sort((a, b) => b.at.localeCompare(a.at)))
}

/** Accept or dismiss the payments suggestion. Accepting creates a task — the change itself stays with a person. */
export function decidePaymentSuggestion(claimId: string, choice: 'accepted' | 'dismissed', by: string): Promise<void> {
  const p = profiles.get(claimId)
  if (!p?.suggestion) return fail('No suggestion')
  const s = p.suggestion
  profiles.update(claimId, { suggestion: { ...s, state: choice } })
  logEvent(claimId, { type: 'assistant', title: `Suggestion ${choice}: ${s.title}`, actor: `${by} · assistant suggestion`, detail: choice === 'accepted' && s.creates ? `Created: ${s.creates}` : undefined })
  if (choice === 'accepted' && s.creates) addTask(claimId, s.creates, by, 'Assistant suggestion')
  return respond(undefined)
}

// ---------------------------------------------------------------- Drafts: one-time payment, adjust benefit, overpayment

export function draftOneTimePayment(args: { claimId: string; payee: string; amount: number; reason: string; payDate: string; method: string; by: string }): Promise<void> {
  const { claimId, payee, amount, reason, payDate, method, by } = args
  schedulePayment({ claimId, payDate, payee, basis: `One-time · ${reason}`, amount, method, status: { label: 'Awaiting approval', tone: 'neutral' }, note: 'second approver' })
  paymentDrafts.prepend({ id: newId('pd'), claimId, kind: 'oneTime', title: `One-time payment ${fmtMoney(amount)} to ${payee}`, detail: `${reason} · pays ${fmtDate(payDate)} by ${method} once a second person approves`, by, at: nowStamp(), status: { label: 'Awaiting approval', tone: 'neutral' } })
  addTask(claimId, `Approve one-time payment of ${fmtMoney(amount)} to ${payee}`, 'Monica Reyes', 'Payments · one-time payment')
  logEvent(claimId, { type: 'payment', title: `One-time payment requested — ${fmtMoney(amount)} to ${payee}`, actor: by, detail: `${reason}. Held for a second approver before release.` })
  return respond(undefined)
}

export function draftBenefitAdjustment(args: { claimId: string; amount: number; effective: string; reason: string; by: string }): Promise<void> {
  const { claimId, amount, effective, reason, by } = args
  paymentDrafts.prepend({ id: newId('pd'), claimId, kind: 'adjust', title: `Adjust monthly benefit to ${fmtMoney(amount)} from ${fmtDate(effective, { year: true })}`, detail: reason, by, at: nowStamp(), status: { label: 'Draft · needs review', tone: 'neutral' } })
  addTask(claimId, `Review benefit adjustment to ${fmtMoney(amount)} (${fmtDate(effective, { year: true })})`, 'Monica Reyes', 'Payments · adjust benefit')
  logEvent(claimId, { type: 'payment', title: `Benefit adjustment drafted — ${fmtMoney(amount)} from ${fmtDate(effective, { year: true })}`, actor: by, detail: `${reason}. Scheduled payments are unchanged until the draft is reviewed.` })
  return respond(undefined)
}

export function recordOverpayment(args: { claimId: string; amount: number; cause: string; recovery: string; by: string }): Promise<void> {
  const { claimId, amount, cause, recovery, by } = args
  paymentDrafts.prepend({ id: newId('pd'), claimId, kind: 'overpayment', title: `Overpayment ${fmtMoney(amount)} · ${cause}`, detail: `Proposed recovery: ${recovery}`, by, at: nowStamp(), status: { label: 'Recovery draft', tone: 'caution' } })
  addTask(claimId, `Agree recovery of ${fmtMoney(amount)} overpayment with the payee`, by, 'Payments · overpayment')
  logEvent(claimId, { type: 'payment', title: `Overpayment recorded — ${fmtMoney(amount)}`, actor: by, detail: `${cause}. Recovery proposed: ${recovery}. No offset is taken until it is agreed.` })
  return respond(undefined)
}

// ---------------------------------------------------------------- Fast track: release and close (Pierce)

/** Demo only: in the real system the bank file confirms release. Marks this claim's scheduled EFTs paid. */
export function markReleased(claimId: string, by: string): Promise<number> {
  const due = payments.where((p) => p.claimId === claimId && p.status.label === 'Scheduled')
  if (!due.length) return fail('Nothing scheduled to release')
  due.forEach((p) => payments.update(p.id, { status: { label: `Paid ${fmtDate(p.payDate)}`, tone: 'positive' }, note: 'EFT confirmed' }))
  const total = sum(due.map((p) => p.amount))
  logEvent(claimId, { type: 'payment', title: `${due.length} EFT${due.length > 1 ? 's' : ''} released — ${fmtMoney(total)}`, actor: `${by} · marked released (demo)` })
  patchClaim(claimId, (c) => ({ nextStep: { ...c.nextStep, reason: `${due.length} EFTs paid · ${fmtMoney(total)} · ready to close` } }))
  return respond(due.length)
}

export function closeClaim(claimId: string, by: string): Promise<void> {
  const c = claims.get(claimId)
  if (!c) return fail('Claim not found')
  const open = payments.where((p) => p.claimId === claimId && p.status.tone !== 'positive')
  if (open.length) return fail('Every payment must be paid before the claim closes')
  const total = sum(payments.where((p) => p.claimId === claimId).map((p) => p.amount))
  patchClaim(claimId, (cl) => ({
    stage: cl.stage.map((s) => ({ ...s, state: 'done', note: undefined })),
    clocks: cl.clocks.map((k) => ({ ...k, state: 'met' })),
    benefitLines: cl.benefitLines.map((b) => ({ ...b, status: { label: `Paid · closed ${fmtDate(TODAY)}`, tone: 'positive' }, paid: `${fmtMoney(total)} paid`, waitingOn: undefined, due: undefined })),
    tags: [...cl.tags.filter((t) => t.label !== 'Closed'), { label: 'Closed', tone: 'neutral' }],
    nextStep: { label: 'Claim closed', reason: `Closed ${fmtDate(TODAY)} · ${fmtMoney(total)} paid`, section: 'history' },
  }))
  completeWork(claimId)
  addCommunication({ claimId, channel: 'letter', direction: 'out', title: 'Claim closed — thank you', party: 'Margaret Pierce · portal and first-class mail · LTR-L-190', detail: 'Confirms both payments, the interest and the 1099-INT to follow by 31 Jan 2027', status: { label: 'Queued', tone: 'info' }, template: 'LTR-L-190' })
  logEvent(claimId, { type: 'decision', title: 'Claim closed — all benefit lines paid', actor: by, detail: `${fmtMoney(total)} paid. Closing letter LTR-L-190 queued.` })
  logEvent(claimId, { type: 'communication', title: 'Closing letter queued: LTR-L-190', actor: 'System · on close' })
  return respond(undefined)
}

// ---------------------------------------------------------------- Survivor payments & recovery (Ellison)

export function setUpSurvivor(args: { claimId: string; plan: string; by: string }): Promise<void> {
  const { claimId, plan, by } = args
  const george = payments.where((p) => p.claimId === claimId && p.payDate > TODAY && p.payee === 'George Ellison' && p.status.tone !== 'neutral')
  george.forEach((p) => payments.update(p.id, { status: { label: 'Stopped', tone: 'neutral' }, note: 'annuitant died 18 Jul' }))
  const offset = plan === 'offset'
  ;['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01'].forEach((d, i) => {
    const reduced = offset && i < 4
    schedulePayment({
      claimId, benefitLineId: `bl-${claimId}`, period: fmtDate(d, { year: true }).replace(/^1 /, ''), payDate: d, payee: 'Ruth Ellison',
      basis: reduced ? 'Survivor 50% · less $710.00 recovery' : 'Survivor 50%', amount: reduced ? 710 : 1_420, gross: 1_420, withheld: reduced ? 710 : 0,
      method: 'EFT ••3318', status: offset && i < 4 ? { label: 'Needs Ruth’s agreement', tone: 'caution' } : { label: 'Scheduled', tone: 'info' },
    })
  })
  const planText = plan === 'offset' ? 'Offset $710.00 from Ruth’s next 4 payments' : plan === 'bank' ? 'Bank asked to return the two payments' : 'Ruth repays $2,840.00 by check'
  paymentDrafts.prepend({ id: newId('pd'), claimId, kind: 'survivor', title: 'Recovery plan · $2,840.00 overpaid after death', detail: `${planText}${offset ? ' — needs her agreement before the first reduced payment' : ''}`, by, at: nowStamp(), status: offset ? { label: 'Waiting on Ruth', tone: 'caution' } : { label: 'Recorded', tone: 'positive' } })
  patchClaim(claimId, (c) => ({
    benefitLines: c.benefitLines.map((b) => ({ ...b, status: { label: 'Survivor payments set up', tone: 'positive' }, waitingOn: offset ? 'Ruth · agree recovery' : undefined })),
    tags: c.tags.filter((t) => t.label !== 'Paid after death'),
  }))
  setNextStep(claimId, { label: 'Send Ruth the survivor letter', reason: 'Condolences, her $1,420.00 a month from 1 Oct, and the recovery plan', section: 'communications', target: 'LTR-A-305' })
  completeWork(claimId, 'payments')
  logEvent(claimId, { type: 'payment', title: 'Survivor payments set up — Ruth Ellison $1,420.00 a month from 1 Oct', actor: by, detail: `George’s payments stopped. Recovery plan: ${planText}. Corrected 2026 1099-R to follow.` })
  return respond(undefined)
}

// ---------------------------------------------------------------- Return to work (Priya Raman)

export function confirmReturnToWork(args: { claimId: string; date: string; by: string }): Promise<void> {
  const { claimId, date, by } = args
  paymentDrafts.prepend({ id: newId('pd'), claimId, kind: 'returnToWork', title: `Return to work confirmed · ${fmtDate(date, { weekday: true })}`, detail: 'Final prorated payment of $8,400.00 stays on 6 Oct; the claim closes after it clears', by, at: nowStamp(), status: { label: 'Confirmed', tone: 'positive' } })
  completeWork(claimId, 'payments')
  setNextStep(claimId, { label: 'Close after final payment', reason: `Back ${fmtDate(date)} · $8,400.00 pays 6 Oct`, section: 'payments' })
  logEvent(claimId, { type: 'data', title: `Return-to-work date confirmed — ${fmtDate(date, { weekday: true })}`, actor: by, detail: 'Benefit ends 4 Oct; final payment prorated 28 of 30 days.' })
  return respond(undefined)
}

export function flagReturnDateChange(args: { claimId: string; date: string; by: string }): Promise<void> {
  const { claimId, date, by } = args
  addTask(claimId, `Extend approval past 4 Oct? Claimant now back ${fmtDate(date)}`, by, 'Payments · return to work')
  logEvent(claimId, { type: 'task', title: `Return-to-work date changed to ${fmtDate(date)} — approval review requested`, actor: by, detail: 'Approved only through 4 Oct. Extra days need a decision before they are paid.' })
  return respond(undefined)
}

/** Log a follow-up with Payments on a hold (Whitman) — the examiner can't release a screening hold. */
export function askPaymentsForUpdate(claimId: string, contact: string, by: string): Promise<void> {
  logEvent(claimId, { type: 'payment', title: `Asked ${contact} for an update on the payment hold`, actor: by })
  return respond(undefined)
}
