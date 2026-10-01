import { DECISIONS, WORKBENCHES } from './fixtures/decisions'
import { collection, fail, newId, respond } from './store'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import { claims, patchClaim } from './claims'
import { logEvent } from './history'
import { schedulePayment } from './payments'
import { addCommunication } from './communications'
import { completeWork, workItems } from './work'
import { fmtDate, nowStamp, TODAY } from '../lib/dates'
import { fmtMoney, sum } from '../lib/money'
import type { DecisionRecord, User, Workbench } from './types'

export const decisions = collection<DecisionRecord>(DECISIONS)
const workbenches = collection<Workbench & { id: string }>(WORKBENCHES.map((w) => ({ ...w, id: `${w.claimId}/${w.benefitLineId}` })))

/** GET /claims/{id}/decisions — recorded, locked records. */
export function listDecisions(claimId: string): Promise<DecisionRecord[]> {
  if (isLiveId(claimId)) return live.listDecisions(claimId)
  return respond(decisions.where((d) => d.claimId === claimId).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)))
}

/** GET /claims/{id}/workbench — one per benefit line that still needs a decision. */
export function listWorkbenches(claimId: string): Promise<Workbench[]> {
  // A live claim has no workbench resource: its Decision screen is built from the claim's own records (see claim/sections/DecisionLive.tsx).
  if (isLiveId(claimId)) return respond([])
  return respond(workbenches.where((w) => w.claimId === claimId))
}

/** Internal: a workbench built when proof of loss completes (the life claim workflow does this). */
export function addWorkbench(wb: Workbench): void {
  const id = `${wb.claimId}/${wb.benefitLineId}`
  if (workbenches.get(id)) workbenches.remove(id)
  workbenches.insert({ ...wb, id })
}

export function removeWorkbenches(claimId: string): void {
  workbenches.where((w) => w.claimId === claimId).forEach((w) => workbenches.remove(w.id))
}

type RecordArgs = Parameters<typeof recordDecision>[0]
type DecisionHandler = (args: RecordArgs) => Promise<RecordResult> | undefined
const handlers: DecisionHandler[] = []

/** Lets a claim's workflow take over recording (the life claim flow keeps its deadlines and SLAs in step). */
export function registerDecisionHandler(h: DecisionHandler): void {
  if (!handlers.includes(h)) handlers.push(h)
}

export type Outcome = 'approve' | 'approveInPart' | 'deny' | 'pend'

export interface RecordResult {
  kind: 'recorded' | 'sentForApproval' | 'sentForReview' | 'pended'
  message: string
}

/**
 * POST /claims/{id}/decisions
 * In the real system this signals the claim's Temporal workflow; the workflow schedules payment,
 * letters and the next clock. The mock does the same steps inline.
 */
export function recordDecision(args: {
  claimId: string
  benefitLineId: string
  outcome: Outcome
  rationale: string
  by: User
}): Promise<RecordResult> {
  for (const h of handlers) {
    const handled = h(args)
    if (handled) return handled
  }
  const { claimId, benefitLineId, outcome, rationale, by } = args
  const claim = claims.get(claimId)
  const wb = workbenches.get(`${claimId}/${benefitLineId}`)
  if (!claim || !wb) return fail('Nothing to decide on this benefit line')
  if (wb.checks.some((c) => c.result === 'blocked')) return fail(wb.blockedReason ?? 'A readiness check is blocked')

  const total = sum(wb.payees.map((p) => p.amount))
  const line = claim.benefitLines.find((b) => b.id === benefitLineId)!

  if (outcome === 'pend') {
    patchClaim(claimId, {
      nextStep: { label: 'Request information', reason: 'Decision pended by you', section: 'requirements' },
    })
    logEvent(claimId, { type: 'decision', title: `Decision pended — ${wb.title}`, actor: by.name, detail: rationale })
    return respond({ kind: 'pended', message: 'Pended. Add the requirement you need on Requirements.' })
  }

  if (outcome === 'deny' || outcome === 'approveInPart') {
    // Close the examiner's item first, so the new reviewer item isn't swept up with it.
    completeWork(claimId, 'decision')
    workItems.insert({
      id: newId('w'), ownerId: 'monica', claimId, priority: 1,
      action: outcome === 'deny' ? 'Second review of denial' : 'Second review of partial approval',
      why: `${by.name} · ${wb.title} ${wb.ref}`, due: TODAY, waitingOn: 'You', section: 'decision', views: ['dueToday'], status: 'open',
    })
    patchClaim(claimId, {
      nextStep: { label: 'Waiting on second review', reason: 'Monica Reyes · adverse decisions need a second reviewer', section: 'decision' },
    })
    logEvent(claimId, { type: 'decision', title: `Sent for second review — ${outcome === 'deny' ? 'denial' : 'partial approval'} of ${wb.title}`, actor: by.name, detail: rationale })
    return respond({ kind: 'sentForReview', message: 'Sent to Monica Reyes for second review. Nothing is sent to the claimant until she agrees.' })
  }

  if (total > by.payoutLimit) {
    completeWork(claimId, 'decision')
    workItems.insert({
      id: newId('w'), ownerId: 'monica', claimId, priority: 1, action: 'Approve payout above authority',
      why: `${by.name} · ${fmtMoney(total)} · limit ${fmtMoney(by.payoutLimit)}`, due: TODAY, waitingOn: 'You', section: 'decision', views: ['dueToday'], status: 'open',
    })
    patchClaim(claimId, { nextStep: { label: 'Waiting on approval', reason: `Monica Reyes · ${fmtMoney(total)} is above your authority`, section: 'decision' } })
    logEvent(claimId, { type: 'decision', title: `Approval requested — ${wb.title}`, actor: by.name, detail: `${fmtMoney(total)} above ${fmtMoney(by.payoutLimit)} authority` })
    return respond({ kind: 'sentForApproval', message: 'Sent to Monica Reyes for approval.' })
  }

  // ---- Approve within authority: lock the record, schedule payment and letters, advance the claim.
  const version = decisions.where((d) => d.claimId === claimId && d.benefitLineId === benefitLineId).length + 1
  const stamp = nowStamp()
  decisions.insert({
    id: newId('d'), claimId, benefitLineId, title: `${wb.title} ${wb.ref}`, version,
    recordedAt: stamp, recordedBy: by.name, authorityNote: `within ${fmtMoney(by.payoutLimit).replace('.00', '')} authority`,
    outcome: 'approved', outcomeText: `Approved · ${fmtMoney(total)}`, basis: rationale,
    evidence: wb.evidence, provisions: wb.provisions, approvals: [],
    letter: wb.letters.map((l) => `${l.title} · ${l.template}`).join('; '),
    assistantNote: 'No AI recommendation on the outcome. Readiness checks are rules, not suggestions.',
  })
  workbenches.remove(wb.id)

  const payDay = fmtDate(wb.payDate)
  // One EFT per payee: combine lines to the same person and account.
  const byPayee = new Map<string, { amount: number; method: string; bases: string[] }>()
  wb.payees.forEach((p) => {
    const cur = byPayee.get(p.payee) ?? { amount: 0, method: p.method, bases: [] }
    cur.amount = sum([cur.amount, p.amount])
    cur.bases.push(p.basis)
    byPayee.set(p.payee, cur)
  })
  byPayee.forEach((v, payee) =>
    schedulePayment({ claimId, benefitLineId, payDate: wb.payDate, payee, basis: v.bases.join(' + '), amount: v.amount, method: v.method, status: { label: 'Scheduled', tone: 'info' } }),
  )

  wb.letters.forEach((l) =>
    addCommunication({ claimId, channel: 'letter', direction: 'out', title: l.title, party: `${l.to} · ${l.template}`, detail: `Generated from ${l.template}; sends with the payment on ${payDay}`, status: { label: 'Queued', tone: 'info' }, template: l.template }),
  )

  patchClaim(claimId, (c) => ({
    benefitLines: c.benefitLines.map((b) =>
      b.id === benefitLineId
        ? { ...b, status: { label: `Approved ${fmtDate(TODAY)}`, tone: 'positive' }, paid: `${fmtMoney(total)} paying ${payDay}`, waitingOn: 'Payments', due: payDay }
        : b,
    ),
    stage: c.stage.map((s) =>
      s.key === 'decision' ? { ...s, state: 'done' } : s.key === 'payment' ? { ...s, state: 'current' } : s,
    ),
    clocks: c.clocks.map((k) => (k.kind === 'deadline' ? { ...k, state: 'met' } : k)),
    nextStep: { label: 'Confirm payment and close', reason: `${byPayee.size} EFTs release ${payDay} · ${fmtMoney(total)}`, section: 'payments' },
  }))

  logEvent(claimId, { type: 'decision', title: `Decision recorded — ${wb.title} approved (v${version})`, actor: `${by.name} · ${line.name}`, detail: rationale, ref: 'Decision record' })
  logEvent(claimId, { type: 'payment', title: `Payment scheduled for ${payDay} — ${fmtMoney(total)}`, actor: 'System · on decision' })
  logEvent(claimId, { type: 'communication', title: `Letters generated: ${wb.letters.map((l) => l.template).join(', ')}`, actor: 'System · on decision' })
  completeWork(claimId, 'decision')

  return respond({ kind: 'recorded', message: `Decision recorded · ${fmtMoney(total)} scheduled for ${payDay}` })
}
