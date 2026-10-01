/**
 * The guided "Simple scenario" for the Demo controls panel: a checklist and a "Next:" hint for the claim on screen.
 *
 * Nothing is stored. Every tick and the hint are worked out from what the backend holds about the claim (its status, requirements,
 * deadline rows, decisions, payment items, work items), so a refresh, another browser, or someone else's click gives the same answer.
 */
import { daysFrom, fmtDate } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { money, standing, type Bundle } from './present'

export interface GuideStep {
  key: string
  label: string
  /** A short reading of where it stands ('2 of 4', 'due Fri 9 Oct'). */
  note?: string
  done: boolean
  /** Does not hold the scenario up; only ticked when it happened. */
  optional?: boolean
  /** The first step that is not done and not optional. */
  current: boolean
}

export type GuideAction =
  | { kind: 'link'; to: string; label: string }
  | { kind: 'advance'; days: number; label: string }
  | { kind: 'advance-to'; iso: string; label: string }
  | { kind: 'advance-next'; label: string }
  | { kind: 'payment-run'; label: string }
  /** One of the registered scenario events (api/live/scenarios.ts): it is disabled with its reason when the claim can't take it. */
  | { kind: 'scenario'; key: string; label: string }

export interface Guide {
  steps: GuideStep[]
  /** What to do next, in a sentence. */
  next: string
  /** The one thing to click (the simple scenario). */
  action?: GuideAction
  /** Several things to click, in order (the complex scenario). */
  actions?: GuideAction[]
  done: boolean
}

export interface Ctx {
  /** The business date the clock shows (YYYY-MM-DD). */
  today: string
  /** The signed-in persona (`rachel`, `monica`). */
  persona: string
}

/** What the panel knows about the dev switches (GET /dev/faults, GET /dev/bank/returns): not part of the claim, but part of the story. */
export interface DevState {
  /** Names of the fault switches that are on now. */
  faults: string[]
  /** Returns waiting in the stub bank's queue. */
  returnsQueued: number
}

const openReq = (s: string) => s === 'requested' || s === 'received' || s === 'not_enough'

/** Before there is a claim: the first step. */
export function guideWithoutClaim(): Guide {
  return {
    steps: [{ key: 'notice', label: 'Take the notice of death', done: false, current: true }],
    next: 'Take the notice of death: New life claim',
    action: { kind: 'link', to: '/intake/life', label: 'New life claim' },
    done: false,
  }
}

export function simpleGuide(b: Bundle, ctx: Ctx): Guide {
  const c = b.claim
  const reqs = b.requirements
  const open = reqs.filter((r) => openReq(r.state))
  const contact = b.deadlines.find((d) => d.kind === 'first_contact_by')
  const followUpFired = b.deadlines.some((d) => d.kind === 'requirement_follow_up' && d.fired)
  const followUpDue = b.deadlines.some((d) => d.kind === 'requirement_follow_up' && d.state === 'dispatched')
  const awaiting = b.decisions.some((d) => d.status === 'awaiting_approval')
  const needsApproval = awaiting || b.decisions.some((d) => d.requiresApproval)
  const items = standing(b.paymentItems)
  const allPaid = items.length > 0 && items.every((i) => i.status === 'paid')
  const inEffect = b.decisions.some((d) => d.status === 'in_effect' && d.outcome !== 'closed')
  const payOn = items.filter((i) => i.status === 'cleared').map((i) => i.payOn).sort()[0]

  const raw: Omit<GuideStep, 'current'>[] = [
    { key: 'notice', label: 'Take the notice of death', done: true },
    { key: 'intake', label: 'Intake workflow sets the claim up', done: c.status !== 'received' },
    { key: 'welcome', label: 'Log the welcome call', note: contact?.state === 'done' ? 'first contact met' : contact ? `due ${fmtDate(contact.dueAt.slice(0, 10))}` : undefined, done: !contact || contact.state === 'done' || contact.state === 'skipped' },
    { key: 'followup', label: 'A late statement’s follow-up fires (move the clock)', done: followUpFired, optional: true },
    { key: 'evidence', label: 'Accept every requirement', note: `${reqs.length - open.length} of ${reqs.length}`, done: reqs.length > 0 && open.length === 0 },
    { key: 'proof', label: 'Proof of loss complete · In review', done: !!c.proofCompleteAt },
    { key: 'decision', label: 'Record the decision', done: b.decisions.length > 0 },
    ...(needsApproval ? [{ key: 'approval', label: 'Team lead approves (above the examiner’s authority)', done: inEffect && !awaiting }] : []),
    { key: 'items', label: 'Payment items cleared', note: items.length ? `${items.length} · ${fmtMoney(items.reduce((a, i) => a + money(i.amount), 0))}` : undefined, done: items.length > 0 },
    { key: 'paid', label: 'Payment run pays them', done: allPaid },
    { key: 'closed', label: 'Claim closed · closing letter', done: c.status === 'closed' },
  ]
  let currentSet = false
  const steps: GuideStep[] = raw.map((s) => {
    const current = !currentSet && !s.done && !s.optional
    if (current) currentSet = true
    return { ...s, current }
  })

  const base = { steps, done: c.status === 'closed' }
  const at = (section: string) => `/claims/${c.claimNumber}/${section}`
  const first = steps.find((s) => s.current)

  if (c.status === 'closed') return { ...base, next: 'Done: the claim is closed. Look at Workflow & SLA, History and Communications.', action: { kind: 'link', to: at('workflow'), label: 'Open Workflow & SLA' } }
  if (c.status === 'received') return { ...base, next: 'Wait: the intake workflow is checking the claim and setting it up.' }
  if (first?.key === 'welcome' && c.status === 'gathering_evidence') return { ...base, next: 'Log the welcome call (it meets the first-contact service level).', action: { kind: 'link', to: at('workflow'), label: 'Open Workflow & SLA' } }
  if (first?.key === 'evidence') {
    const r = open[0]
    const last = open.length === 1
    return {
      ...base,
      next: followUpDue ? 'Wait: a follow-up workflow is running.' : `${last ? 'Accept the last requirement' : 'Accept a requirement'}: ${r.name}${r.from.label ? ` (${r.from.label})` : ''}.`,
      action: { kind: 'link', to: at('requirements'), label: 'Open Requirements' },
    }
  }
  if (c.status === 'in_review') return { ...base, next: 'Record the decision (as Rachel, the examiner).', action: { kind: 'link', to: at('decision'), label: 'Open Decision' } }
  if (c.status === 'awaiting_approval') {
    return ctx.persona === 'monica'
      ? { ...base, next: 'Approve the decision (you are the team lead).', action: { kind: 'link', to: at('decision'), label: 'Open Decision' } }
      : { ...base, next: 'Switch to Monica Reyes (Sign in as) and approve the decision.', action: { kind: 'link', to: at('decision'), label: 'Open Decision' } }
  }
  if (c.status === 'reopened') {
    const waiting = b.paymentItems.filter((i) => i.status === 'returned' && !b.paymentItems.some((x) => x.replacementOfId === i.id))
    if (waiting.length) return { ...base, next: `The bank returned ${waiting[0].payeeName ?? 'a payment'}: use "Payee gives a new bank account" below (or the payee’s new details).`, action: { kind: 'link', to: at('payments'), label: 'Open Payments' } }
    return { ...base, next: 'Run the payment run: it pays the replacement and closes the claim again.', action: { kind: 'payment-run', label: 'Run payment run now' } }
  }
  if (c.status === 'paying') return { ...base, next: 'Wait: the payment run is with the bank; the claim closes when every payment is paid.' }
  if (c.status === 'approved') {
    if (b.paymentItems.some((i) => i.status === 'held')) return { ...base, next: 'Release the held payment on Payments; the run skips it until then.', action: { kind: 'link', to: at('payments'), label: 'Open Payments' } }
    if (payOn && payOn > ctx.today) {
      const days = daysFrom(ctx.today, payOn)
      return { ...base, next: `Advance the clock to the next business day (${fmtDate(payOn, { weekday: true })}); the items pay then.`, action: { kind: 'advance', days, label: days === 1 ? '+1 day' : `+${days} days` } }
    }
    return { ...base, next: 'Run the payment run. (In a demo the daily run may do it on its own within seconds.)', action: { kind: 'payment-run', label: 'Run payment run now' } }
  }
  return { ...base, next: first ? first.label : 'Check the workflow.' }
}

// ---------------------------------------------------------------- The complex scenario

/** Mon 12 Oct 11:30 in Chicago: the decision day of the mock's story, so the items pay on Tue 13 Oct (24 days' interest, $460.27). */
export const DECISION_DAY_ISO = '2026-10-12T16:30:00Z'
const DECISION_DAY = '2026-10-12'

interface Raw extends Omit<GuideStep, 'current'> {
  /** What to say or do when this is the step (the presenter's hint). */
  hint: string
  /** What to say while the backend is working on it. */
  waiting?: string
  actions?: GuideAction[]
}

const isWaiting = (r: Raw): boolean => r.waiting !== undefined

/**
 * The complex scenario, "things bounce back": five things come back. Like the simple guide, nothing is stored: every tick is
 * worked out from the claim's data (documents, runs, requirements, deadline rows, payment items) and the dev switches.
 * Before there is a claim it is the first two steps.
 */
export function complexGuide(b: Bundle | undefined, ctx: Ctx, dev: DevState): Guide {
  const stallArmed = dev.faults.some((f) => f.startsWith('worker.stall-once'))
  const lettersDown = dev.faults.includes('letters.down')
  const c = b?.claim
  const at = (section: string) => (c ? `/claims/${c.claimNumber}/${section}` : '/work')
  const runs = b?.runs ?? []
  const docs = b?.documents ?? []
  const reqs = b?.requirements ?? []
  const items = b?.paymentItems ?? []
  const caller = c?.details?.callerPartyId
  const intake = runs.find((r) => r.type === 'orchestration')
  const retried = intake?.steps.find((s) => s.state === 'retried' && (s.attempts ?? 1) >= 2)
  const contact = b?.deadlines.find((d) => d.kind === 'first_contact_by')
  const w9s = docs.filter((d) => d.kind === 'claimant_statement_w9')
  const mismatch = w9s.find((d) => d.status === 'not_enough')
  const corrected = !!mismatch && w9s.some((d) => d.partyId === mismatch.partyId && d.status === 'accepted')
  const copy = docs.find((d) => d.kind === 'death_certificate' && (d.attributes.photocopy === true || d.attributes.sealPresent === false))
  const rejected = copy?.status === 'rejected'
  const failedRun = runs.find((r) => r.status === 'failed')
  const rerunDone = runs.some((r) => (r.runNo ?? 1) > 1 && r.status === 'completed')
  const rerunRunning = runs.some((r) => (r.runNo ?? 1) > 1 && r.status === 'running')
  const certReq = reqs.find((r) => r.key === 'certificate')
  const markReq = reqs.find((r) => r.key === 'statement' && r.from.partyId !== caller)
  const late = !!b?.deadlines.some((d) => d.kind === 'requirement_follow_up' && d.fired)
  const decided = (b?.decisions.length ?? 0) > 0
  const standingItems = items.filter((i) => i.status !== 'cancelled' && i.status !== 'returned')
  const paidOnce = items.some((i) => i.status === 'paid' || i.status === 'returned')
  const returned = items.filter((i) => i.status === 'returned')
  const replacement = items.find((i) => i.replacementOfId)
  const payOn = items.filter((i) => i.status === 'cleared').map((i) => i.payOn).sort()[0]
  const first = (name?: string) => (name ?? 'the payee').split(' ')[0]
  const returnedName = first(returned[0]?.payeeName)
  const onDecisionDay = ctx.today >= DECISION_DAY

  const payActions = (): GuideAction[] => {
    if (!payOn || payOn <= ctx.today) return [{ kind: 'payment-run', label: 'Run payment run now' }]
    const days = Math.max(1, daysFrom(ctx.today, payOn))
    return [{ kind: 'advance', days, label: `Move the clock to the pay day (+${days} ${days === 1 ? 'day' : 'days'})` }]
  }

  const raw: Raw[] = [
    {
      key: 'stall', label: 'Stall the worker in the next intake', done: !!retried || !!c || stallArmed,
      note: retried ? `step retried, ${retried.attempts} attempts` : stallArmed ? 'armed' : undefined,
      hint: 'Arm the worker stall: the acknowledgement step will hang past its 30 s timeout once, as a worker killed in a deploy would.',
      actions: [{ kind: 'scenario', key: 'worker-stall', label: 'Stall the worker' }],
    },
    {
      key: 'intake', label: 'File the notice of death (intake takes about 35 s)', done: !!c && c.status !== 'received',
      hint: 'File the notice of death: New life claim. The intake run will take about 35 s because one step times out and Temporal runs it again.',
      waiting: c?.status === 'received' ? 'Wait about 35 s: the stalled step times out at 30 s and Temporal runs it again on a worker that is free. Open Workflow & SLA and watch the run.' : undefined,
      actions: c ? [{ kind: 'link', to: at('workflow'), label: 'Open Workflow & SLA' }] : [{ kind: 'link', to: '/intake/life', label: 'New life claim' }],
    },
    {
      key: 'welcome', label: 'Log the welcome call', done: !contact || contact.state === 'done' || contact.state === 'skipped',
      hint: 'Log the welcome call (Work on this claim, on Workflow & SLA): it meets the first-contact service level and keeps the overdue check quiet.',
      actions: [{ kind: 'link', to: at('workflow'), label: 'Open Workflow & SLA' }],
    },
    {
      key: 'tin', label: 'Bounce 2 · Diane’s W-9 arrives with a typo in the taxpayer number', done: !!mismatch,
      note: mismatch ? `${mismatch.attributes.tinMasked ?? ''} · ${mismatch.statusNote ?? mismatch.status}`.replace(/^ · /, '') : undefined,
      hint: 'Diane’s W-9 arrives with two digits swapped. The IRS check says “no match”: that is an answer, not an error, so Temporal must not retry it.',
      waiting: w9s.some((d) => d.status === 'received') && !mismatch ? 'Wait a few seconds: the document workflow is checking the taxpayer number.' : undefined,
      actions: [{ kind: 'scenario', key: 'doc-statement-mismatch', label: 'Diane’s W-9 · TIN typo' }, { kind: 'link', to: at('requirements'), label: 'Open Requirements' }],
    },
    {
      key: 'corrected', label: 'Diane sends a corrected W-9', done: corrected,
      hint: 'The corrected W-9 is a new document: a new event and a new workflow that knows nothing about the first try. It matches and the requirement is accepted.',
      actions: [{ kind: 'scenario', key: 'doc-statement', label: 'Corrected W-9 arrives' }],
    },
    {
      key: 'photocopy', label: 'Bounce 3 · The death certificate arrives as a photocopy', done: !!copy,
      note: copy ? (copy.status === 'under_review' ? 'under review' : copy.status.replace('_', ' ')) : undefined,
      hint: 'A photocopy with no raised seal: the rules can’t accept it, so the workflow hands it to Rachel and ends. Waiting for a person is a work item, not a sleeping workflow.',
      waiting: docs.some((d) => d.kind === 'death_certificate' && d.status === 'received') ? 'Wait a few seconds: the document workflow is deciding.' : undefined,
      actions: [{ kind: 'scenario', key: 'doc-certificate-photocopy', label: 'Photocopied certificate arrives' }, { kind: 'link', to: at('documents'), label: 'Open Documents' }],
    },
    {
      key: 'letters-down', label: 'The letters service goes down', done: lettersDown || !!failedRun || rerunDone || rejected,
      note: lettersDown ? 'down now' : undefined,
      hint: 'Before Rachel rejects it, take the letters service down. The “certified copy needed” letter will fail to send.',
      actions: [{ kind: 'scenario', key: 'letters-down', label: 'Letters service down' }],
    },
    {
      key: 'reject', label: 'Rachel rejects the photocopy (sign in as Rachel)', done: rejected,
      hint: 'Rachel rejects the photocopy on Documents with a reason. Her decision is saved in Postgres first; only the letter has to wait for the letters service.',
      actions: [{ kind: 'link', to: copy ? at(`documents/${copy.id}`) : at('documents'), label: 'Review it on Documents' }, { kind: 'scenario', key: 'review-reject', label: 'Reject it now' }],
    },
    {
      key: 'failed', label: 'The letter workflow fails after 5 attempts (about 30 s)', done: !!failedRun || rerunDone,
      hint: 'Wait for the failed run.',
      waiting: rejected && !failedRun && !rerunDone ? 'Wait about 30 s: Temporal retries the send at 2, 4, 8 and 16 s, then stops. Open the run on Workflow & SLA: the step shows 5 attempts, the run is red, and an ops task is open.' : undefined,
      actions: [{ kind: 'link', to: at('workflow'), label: 'Open Workflow & SLA' }],
    },
    {
      key: 'rerun', label: 'Ops re-runs it once the letters service is back', done: rerunDone,
      note: rerunDone ? 'run 2 completed' : undefined,
      hint: 'Bring the letters service back and re-run the failed run. It starts as run 2 under the same workflow id, and the letter goes out exactly once.',
      waiting: rerunRunning ? 'Run 2 is running.' : undefined,
      actions: [{ kind: 'scenario', key: 'letters-up', label: 'Letters service back' }, { kind: 'scenario', key: 'rerun-failed', label: 'Re-run the failed run' }],
    },
    {
      key: 'certified', label: 'The certified copy arrives', done: certReq?.state === 'accepted',
      hint: 'The certified copy arrives and the document workflow accepts it. Mark’s statement is still outstanding, so the claim is not in review yet.',
      actions: [{ kind: 'scenario', key: 'doc-certificate', label: 'Certified copy arrives' }],
    },
    {
      key: 'late', label: 'Bounce 4 · Mark is late: his follow-up fires (move the clock)', done: late,
      hint: 'Mark’s statement is late. Move the clock to his follow-up row: the Temporal Schedule’s dispatcher starts deadline-<row>, the only row that fires.',
      waiting: b?.deadlines.some((d) => d.kind === 'requirement_follow_up' && d.state === 'dispatched') ? 'Wait a few seconds: the dispatcher started the deadline workflow.' : undefined,
      actions: [{ kind: 'advance-next', label: 'Advance to next deadline' }],
    },
    {
      key: 'mark', label: 'Mark’s statement + W-9 arrives · proof of loss complete', done: markReq?.state === 'accepted' && !!c?.proofCompleteAt,
      hint: 'Mark signs. His W-9 checks out; his is the last requirement, so accepting it completes proof of loss and starts the decision clock, all in one transaction.',
      actions: [{ kind: 'scenario', key: 'doc-statement', label: 'Mark’s statement + W-9 arrives' }],
    },
    {
      key: 'decision', label: 'Rachel records the decision (Mon 12 Oct)', done: decided,
      hint: onDecisionDay ? 'Record the decision as Rachel. It is within her $250,000 authority.' : 'Move the clock to Mon 12 Oct, then record the decision as Rachel. It is within her $250,000 authority, and the pay date is Tue 13 Oct (24 days of interest).',
      actions: [...(onDecisionDay ? [] : [{ kind: 'advance-to' as const, iso: DECISION_DAY_ISO, label: 'Move the clock to Mon 12 Oct' }]), { kind: 'link', to: at('decision'), label: 'Open Decision' }],
    },
    {
      key: 'pay', label: 'Pay day: the payment run pays both and closes the claim', done: paidOnce,
      hint: 'Move the clock to the pay day. The daily payment run (a batch, no Temporal) pays Diane and Mark and closes the claim.',
      waiting: c?.status === 'paying' ? 'Wait a few seconds: the payment run has the file.' : undefined,
      actions: payActions(),
    },
    {
      key: 'bank', label: 'Bounce 5 · The bank returns Mark’s payment (R02)', done: returned.length > 0 || dev.returnsQueued > 0,
      note: dev.returnsQueued > 0 && !returned.length ? 'queued at the bank' : undefined,
      hint: 'A few days later the bank’s returns file lists Mark’s EFT: the account is closed (R02).',
      actions: [{ kind: 'scenario', key: 'bank-return-queue', label: 'Bank returns Mark’s payment' }],
    },
    {
      key: 'returns', label: 'The returns batch processes it: the claim reopens', done: returned.length > 0 && (c?.status === 'reopened' || !!replacement),
      hint: 'Run the returns batch. It marks the item returned and never touches the claim; a workflow reopens the claim and writes to Mark.',
      waiting: returned.length > 0 && c?.status !== 'reopened' && !replacement ? 'Wait a few seconds: the returned-payment workflow is reopening the claim.' : undefined,
      actions: [{ kind: 'scenario', key: 'returns-process', label: 'Process the bank returns' }],
    },
    {
      key: 'account', label: 'Mark gives a new bank account', done: !!replacement,
      hint: `${returnedName} gives new bank details. The replacement is a new item for the same amount: the returned one is never edited.`,
      actions: [{ kind: 'scenario', key: 'new-account', label: `${returnedName} gives a new account` }],
    },
    {
      key: 'replaced', label: 'The next payment run pays the replacement', done: replacement?.status === 'paid',
      hint: 'Move the clock to the next pay day; the run pays the replacement and closes the claim again.',
      actions: payActions(),
    },
    { key: 'closed', label: 'Claim closed again', done: c?.status === 'closed' && returned.length > 0 && replacement?.status === 'paid', hint: 'Done.' },
  ]

  let currentSet = false
  const steps: GuideStep[] = raw.map((r) => {
    const current = !currentSet && !r.done && !r.optional
    if (current) currentSet = true
    return { key: r.key, label: r.label, note: r.note, done: r.done, optional: r.optional, current }
  })
  const cur = raw.find((_, i) => steps[i].current)
  const done = !cur
  const total = fmtMoney(standingItems.reduce((a, i) => a + money(i.amount), 0))
  if (done) {
    return { steps, done, next: `Done: the claim closed twice and ${total} was paid. Look at Workflow & SLA (14 runs, 16 deadline rows), Payments and History, then the Temporal UI.`, actions: [{ kind: 'link', to: at('workflow'), label: 'Open Workflow & SLA' }] }
  }
  return { steps, done, next: isWaiting(cur!) ? cur!.waiting! : cur!.hint, actions: cur!.actions }
}
