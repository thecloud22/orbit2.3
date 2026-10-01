/**
 * Backend resources -> the mock's UI types. The API returns facts and state only; everything the screens show as
 * presentation (status label and tone, tags, stage, clocks, next step, summary, exceptions, requirement plan) is derived
 * here from those facts, so the screens don't change and nothing is invented: where the backend has nothing, the field is empty.
 */
import { daysFrom, fmtDate, plural } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import type {
  BenefitLine, Claim, ClaimClock, ClaimException, Communication, HistoryEvent, NextStep, Party, SectionKey, StageStep, Status, WorkItem, WorkView,
} from '../types'
import type { RequirementRecord, PlanStep } from '../requirements'
import type {
  ApiBenefitLine, ApiClaim, ApiClaimParty, ApiDeadline, ApiDecision, ApiDocument, ApiHistoryEvent, ApiLetter, ApiPaymentItem, ApiRequirement, ApiWorkItem, ApiWorkflowRun, Money,
} from './types'
import { day, stamp } from './time'
import { personaFor, staffByHandle, staffName } from './staff'
import { DOC_KIND, DOC_SOURCE, docStatus, docTitle } from './documents'

/** Everything one claim page needs, fetched together. */
export interface Bundle {
  claim: ApiClaim
  requirements: ApiRequirement[]
  deadlines: ApiDeadline[]
  runs: ApiWorkflowRun[]
  letters: ApiLetter[]
  history: ApiHistoryEvent[]
  /** Every version of every decision, newest first (GET /claims/{id}/decisions). */
  decisions: ApiDecision[]
  /** GET /claims/{id}/payment-items, oldest first. */
  paymentItems: ApiPaymentItem[]
  /** The open work items of this claim (from GET /work-items?status=open). */
  workItems: ApiWorkItem[]
  /** GET /claims/{id}/documents, oldest first. */
  documents: ApiDocument[]
  /** performance.now() when it was fetched. */
  fetchedAt: number
}

export const money = (m: Money): number => Number.parseFloat(m.amount)
const first = (name: string) => name.split(' ')[0]
const plain = (label: string): Status => ({ label, tone: 'plain' })

/** Deadline kinds a workflow handles today (DeadlineDispatcher polls only these). */
export const KINDS_WITH_WORKFLOW = new Set(['requirement_follow_up'])

// ---------------------------------------------------------------- Owners

/** The persona id of the claim's owner (`rachel`), from the staff directory (GET /staff); 'Unassigned' when it has none. */
export function learnOwner(b: Pick<Bundle, 'claim'>): string {
  return personaFor(b.claim.ownerId)
}

/** The owner's name for text ('Rachel Kim'). */
export function ownerName(b: Pick<Bundle, 'claim'>): string {
  return staffName(b.claim.ownerId)
}

/** Which persona owns this UUID. */
export const personaOf = personaFor

// ---------------------------------------------------------------- Status vocabulary

const CLAIM_STATUS: Record<ApiClaim['status'], { label: string; tone: Status['tone'] }> = {
  received: { label: 'Received · intake running', tone: 'info' },
  gathering_evidence: { label: 'Gathering evidence', tone: 'info' },
  in_review: { label: 'In review', tone: 'info' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'info' },
  approved: { label: 'Approved · payment cleared', tone: 'info' },
  paying: { label: 'Paying · in a payment run', tone: 'info' },
  closed: { label: 'Closed', tone: 'positive' },
  reopened: { label: 'Reopened · payment returned', tone: 'caution' },
}
export const claimStatus = (s: ApiClaim['status']) => CLAIM_STATUS[s]

const LINE_STATUS: Record<ApiBenefitLine['status'], Status> = {
  gathering_evidence: { label: 'Gathering evidence', tone: 'info' },
  cause_pending: { label: 'Cause pending', tone: 'caution' },
  not_payable: { label: 'Not payable', tone: 'neutral' },
  ready_to_decide: { label: 'Ready to decide', tone: 'info' },
  approved: { label: 'Approved', tone: 'positive' },
  paid: { label: 'Paid', tone: 'positive' },
  denied: { label: 'Denied', tone: 'critical' },
  closed: { label: 'Closed', tone: 'neutral' },
}

const STAGE_LABELS = ['Intake', 'Evidence', 'Review', 'Decision', 'Payment', 'Closed']
const STAGE_INDEX: Record<ApiClaim['status'], number> = { received: 0, gathering_evidence: 1, in_review: 2, awaiting_approval: 3, approved: 4, paying: 4, reopened: 4, closed: 5 }

export function stageOf(status: ApiClaim['status']): StageStep[] {
  const cur = STAGE_INDEX[status]
  return STAGE_LABELS.map((label, i) => ({ key: label.toLowerCase(), label, state: i < cur || status === 'closed' ? 'done' : i === cur ? 'current' : 'todo' }))
}

// ---------------------------------------------------------------- Claim

const LIVE_SECTIONS: SectionKey[] = ['overview', 'workflow', 'policies', 'people', 'requirements', 'documents', 'decision', 'payments', 'communications', 'history']

const ROLE_LABEL: Record<ApiClaimParty['role'], string> = {
  insured: 'Insured', owner: 'Owner', caller: 'Caller', claimant: 'Claimant', beneficiary: 'Beneficiary', agent_of_record: 'Agent of record', funeral_home: 'Funeral home',
}
const ROLE_ORDER: ApiClaimParty['role'][] = ['insured', 'owner', 'beneficiary', 'caller', 'claimant', 'agent_of_record', 'funeral_home']

function mapParties(parties: ApiClaimParty[]): Party[] {
  const byId = new Map<string, ApiClaimParty[]>()
  for (const p of parties) byId.set(p.partyId, [...(byId.get(p.partyId) ?? []), p])
  const out: Party[] = []
  for (const [id, rows] of byId) {
    const roles = ROLE_ORDER.filter((r) => rows.some((x) => x.role === r))
    const bene = rows.find((x) => x.role === 'beneficiary')
    const any = rows[0]
    const share = bene?.sharePercent ? `${Number.parseFloat(bene.sharePercent)}%` : undefined
    const died = rows.find((x) => x.diedOn)?.diedOn
    const kind = bene?.beneficiaryKind
    out.push({
      id,
      name: any.name,
      roles: roles.map((r) => ROLE_LABEL[r]),
      relationship: [bene?.relationship ?? rows.find((x) => x.relationship)?.relationship, kind].filter(Boolean).join(' · ') || undefined,
      share,
      status: died ? { label: `Died ${fmtDate(died, { year: true })}`, tone: 'neutral' } : bene?.payee ? { label: 'Payee', tone: 'plain' } : undefined,
      contact: bene?.packetChannel ? `Claim packet by ${bene.packetChannel}` : undefined,
      note: rows.find((x) => x.accessNote && !x.role.startsWith('agent'))?.accessNote ?? undefined,
      access: rows.find((x) => x.role === 'agent_of_record')?.accessNote ?? undefined,
    })
  }
  const rank = (p: Party) => Math.min(...p.roles.map((r) => ROLE_ORDER.findIndex((k) => ROLE_LABEL[k] === r)))
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

const sum2 = (ns: number[]) => Math.round(ns.reduce((x, y) => x + y, 0) * 100) / 100

/** Proceeds plus interest of everything waiting for approval: the base line and the riders decided with it. */
export function awaitingTotal(b: Pick<Bundle, 'decisions'>): number {
  return sum2(b.decisions.filter((d) => d.status === 'awaiting_approval').map((d) => (d.amount ? money(d.amount) : 0)))
}

/** The items that still stand: a cancelled item is gone, and a returned one did not reach the payee (its replacement stands in for it). */
export const standing = (items: ApiPaymentItem[]): ApiPaymentItem[] => items.filter((i) => i.status !== 'cancelled' && i.status !== 'returned')

function mapLines(b: Bundle): BenefitLine[] {
  return b.claim.benefitLines.map((l) => {
    const awaiting = b.decisions.some((d) => d.benefitLineId === l.id && d.status === 'awaiting_approval')
    const items = standing(b.paymentItems.filter((i) => i.benefitLineId === l.id))
    const paid = items.filter((i) => i.status === 'paid')
    const pending = items.filter((i) => i.status !== 'paid')
    const held = items.filter((i) => i.status === 'held')
    const paidAt = paid.map((i) => i.paidAt).filter((x): x is string => !!x).sort().at(-1)
    const nextDay = pending.map((i) => i.payOn).sort()[0]
    return {
      id: l.id,
      name: l.name,
      ref: l.policyNumber,
      refNote: l.kind === 'rider' ? 'rider · pays only for an accidental death' : undefined,
      amount: money(l.amount),
      amountNote: l.kind === 'base' ? 'face amount' : undefined,
      status: awaiting ? { label: 'Awaiting approval', tone: 'info' as const } : LINE_STATUS[l.status],
      paid: paid.length && !pending.length ? `${fmtMoney(sum2(paid.map((i) => money(i.amount))))} paid${paidAt ? ` ${fmtDate(day(paidAt))}` : ''}` : pending.length ? `${fmtMoney(sum2(pending.map((i) => money(i.amount))))} ${held.length ? 'not yet paid' : 'pays'}${nextDay && !held.length ? ` ${fmtDate(nextDay)}` : ''}` : undefined,
      held: held.length ? `${plural(held.length, 'payment')} held` : undefined,
      waitingOn: awaiting ? 'Team lead approval' : pending.length ? (held.length ? 'Release of the hold' : 'Payment run') : l.waitingOn ?? undefined,
      due: nextDay && !held.length ? fmtDate(nextDay) : undefined,
    }
  })
}

/** A failed run stays in the list, but once the same workflow id ran again it is history: only the latest run of an id is a problem. */
export function currentProblems(runs: ApiWorkflowRun[]): ApiWorkflowRun[] {
  return runs.filter((r) => (r.status === 'failed' || r.status === 'needs_review') && !runs.some((x) => x.workflowId === r.workflowId && x.startedAt > r.startedAt))
}

const openReq = (r: ApiRequirement) => r.state === 'requested' || r.state === 'received' || r.state === 'not_enough'

function callerOf(c: ApiClaim) {
  return c.parties.find((p) => p.role === 'caller')
}

export function mapClaim(b: Bundle, now: Date): Claim {
  const c = b.claim
  const owner = learnOwner(b)
  const ownerLabel = ownerName(b)
  const base = c.benefitLines.filter((l) => l.kind === 'base')
  const policies = [...new Set(c.benefitLines.map((l) => l.policyNumber))]
  const product = base[0]?.name ?? c.productCode
  const total = base.reduce((a, l) => a + money(l.amount), 0)
  const caller = callerOf(c)
  const d = c.details
  const filed = day(c.noticedAt)
  const open = b.requirements.filter(openReq)
  const track = c.track === 'fast_track_life' ? 'Fast track' : c.track === 'standard_life' ? 'Standard' : undefined
  const tags: Status[] = [{ label: 'Live', tone: 'info' }]
  if (track) tags.push(plain(track))
  else tags.push({ label: 'Not routed yet', tone: 'neutral' })
  // A claim that came back is worth a tag of its own: the stage tracker alone would show it as Payment.
  if (c.status === 'reopened') tags.push({ label: 'Reopened · payment returned', tone: 'caution' })

  const facts = [
    d ? `Insured and owner · died ${fmtDate(d.dateOfDeath, { year: true })}${d.placeOfDeath ? ` · ${d.placeOfDeath}` : ''}` : `Insured · ${c.insured.name}`,
    `${product} · ${policies.join(', ')} · ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(total)}`,
    `Filed ${fmtDate(filed, { year: true })} by ${d?.intakeChannel ?? 'phone'}${caller ? ` · ${caller.name}, ${(d?.callerRelationship ?? caller.relationship ?? 'caller').toLowerCase()}` : ''}`,
  ]

  const summaryParts = [
    d ? `${c.insured.name} died on ${fmtDate(d.dateOfDeath, { year: true })} (${d.mannerOfDeath === 'natural' ? 'natural causes' : d.mannerOfDeath === 'accident' ? 'an accident' : 'cause pending'}).` : '',
    c.track ? `${track} life, routed by ${c.routeRule ?? 'the routing rules'} to ${ownerLabel}.` : 'The intake checks have not finished routing it yet.',
    b.requirements.length ? `${b.requirements.length - open.length} of ${b.requirements.length} requirements are in${open.length ? `; waiting on ${[...new Set(open.map((r) => first(r.from.label)))].join(' and ')}` : ''}.` : '',
    c.status === 'in_review' ? 'Proof of loss is complete; the decision clock is running.' : '',
    ...decisionSummary(b),
  ].filter(Boolean)

  return {
    id: c.claimNumber,
    live: true,
    family: c.family,
    product,
    name: c.insured.name,
    tags,
    facts,
    ownerId: owner,
    team: c.team,
    filed,
    stage: stageOf(c.status),
    clocks: clocksOf(b, now),
    nextStep: nextStepOf(b, now),
    exceptions: exceptionsOf(b, now),
    benefitLines: mapLines(b),
    parties: mapParties(c.parties),
    summary: { text: summaryParts.join(' '), asOf: `${stamp(now.toISOString()).slice(11)} · claims API`, sources: [`Claims API · claim ${c.claimNumber}`, 'Deadlines, workflow runs and history'] },
    suggestions: [],
    linked: [],
    sections: LIVE_SECTIONS,
    totalLine: totalLine(b),
    detail: { kind: 'life', beneficiaryNote: `${c.parties.filter((p) => p.role === 'beneficiary' && p.payee).length} payees${c.parties.some((p) => p.diedOn && p.role === 'beneficiary') ? ' · primary died first' : ''}` },
  }
}

/**
 * What the claim pays as one figure: the payment items (base line and rider together, replacements standing in for returned items) once
 * they exist, else the decisions' amounts summed. Each decision carries only its own line's amount, so a total is always a sum.
 */
export function totalLine(b: Bundle): string | undefined {
  const items = standing(b.paymentItems)
  if (items.length) {
    const allPaid = items.every((i) => i.status === 'paid')
    const principal = sum2(items.map((i) => money(i.principal)))
    const interest = sum2(items.map((i) => money(i.interest)))
    // A payment that came back and has no replacement yet is still owed: say so instead of showing the smaller sum as the whole.
    const owed = b.paymentItems.filter((i) => i.status === 'returned' && !b.paymentItems.some((x) => x.replacementOfId === i.id))
    if (owed.length) {
      const back = sum2(owed.map((i) => money(i.amount)))
      return `Paid ${fmtMoney(sum2(items.map((i) => money(i.amount))))} · ${fmtMoney(back)} came back from the bank and is still owed (${fmtMoney(sum2(items.map((i) => money(i.amount))) + back)} in all)`
    }
    return `${allPaid ? 'Paid' : 'Cleared'} ${fmtMoney(sum2(items.map((i) => money(i.amount))))} = ${fmtMoney(principal)} proceeds + ${fmtMoney(interest)} interest`
  }
  const decided = b.decisions.filter((d) => d.outcome !== 'closed' && d.amount)
  if (!decided.length) return undefined
  return `${decided.some((d) => d.status === 'awaiting_approval') ? 'Awaiting approval' : 'Decided'} ${fmtMoney(sum2(decided.map((d) => money(d.amount!))))} (proceeds + interest, base line and rider)`
}

function decisionSummary(b: Bundle): string[] {
  const c = b.claim
  const dec = b.decisions.filter((d) => d.outcome !== 'closed').sort((x, y) => x.recordedAt.localeCompare(y.recordedAt))[0]
  const items = standing(b.paymentItems)
  const total = sum2(items.map((i) => money(i.amount)))
  if (c.status === 'awaiting_approval' && dec) return [`${dec.recordedByName ?? 'The examiner'} recorded the decision (${fmtMoney(awaitingTotal(b))}); it is above their authority and waits for the team lead.`]
  if ((c.status === 'approved' || c.status === 'paying') && items.length) return [`Approved. ${fmtMoney(total)} is cleared and pays on ${fmtDate(items.map((i) => i.payOn).sort()[0])}.`]
  if (c.status === 'closed' && items.length) return [`Closed. ${fmtMoney(total)} paid, interest included.`]
  return []
}

function clocksOf(b: Bundle, now: Date): ClaimClock[] {
  const c = b.claim
  const today = day(now.toISOString())
  const out: ClaimClock[] = []
  const rows = b.deadlines
  const decision = rows.find((r) => r.kind === 'decision_due')
  if (decision && decision.state === 'done') {
    out.push({ id: 'c1', label: 'Decision · state limit', kind: 'deadline', state: 'met', due: day(decision.dueAt), progress: 1 })
  } else if (decision && c.proofCompleteAt) {
    const left = daysFrom(today, day(decision.dueAt))
    out.push({ id: 'c1', label: 'Decision · state limit', kind: 'deadline', state: left < 0 ? 'breached' : 'running', due: day(decision.dueAt), progress: Math.min(1, (30 - left) / 30), valueText: `${fmtDate(day(decision.dueAt))} · ${left < 0 ? `${plural(-left, 'day')} late` : plural(left, 'day')}` })
  } else {
    const letter = rows.filter((r) => r.kind === 'status_letter' && r.state === 'open').sort((x, y) => x.dueAt.localeCompare(y.dueAt))[0]
    if (letter) {
      const due = day(letter.dueAt)
      const left = daysFrom(today, due)
      out.push({ id: 'c1', label: 'Status letter · state', kind: 'deadline', state: 'running', due, progress: Math.min(1, Math.max(0, (30 - left) / 30)), valueText: `next ${fmtDate(due)} · ${plural(left, 'day')}` })
    }
  }
  if (c.details) {
    const items = standing(b.paymentItems)
    if (items.length) {
      // The backend has fixed the interest when it made the payment items; show its figure, not a running estimate.
      const interest = sum2(items.map((i) => money(i.interest)))
      const paid = items.every((i) => i.status === 'paid')
      const at = paid ? items.map((i) => i.paidAt).filter((x): x is string => !!x).sort().at(-1) : undefined
      const until = at ? day(at) : items.map((i) => i.payOn).sort()[0]
      out.push({ id: 'c2', label: `Interest since ${fmtDate(c.details.dateOfDeath)}`, kind: 'accruing', state: 'running', start: c.details.dateOfDeath, valueText: `${fmtMoney(interest)} · ${paid ? 'paid' : 'to'} ${fmtDate(until)}` })
    } else {
      const days = daysFrom(c.details.dateOfDeath, today)
      out.push({ id: 'c2', label: `Interest since ${fmtDate(c.details.dateOfDeath)}`, kind: 'accruing', state: 'running', start: c.details.dateOfDeath, valueText: plural(days, 'day') })
    }
  }
  const contact = rows.find((r) => r.kind === 'first_contact_by')
  if (contact) {
    const due = day(contact.dueAt)
    const lateAt = contact.state === 'done' && contact.closedAt ? day(contact.closedAt) : today
    if (lateAt > due) out.push({ id: 'c3', label: 'First contact · internal', kind: 'deadline', state: 'breached', due, progress: 1, valueText: `due ${fmtDate(due)} · ${contact.state === 'done' ? 'met ' : ''}${plural(daysFrom(due, lateAt), 'day')} late` })
    else if (contact.state === 'done') out.push({ id: 'c3', label: 'First contact · internal', kind: 'deadline', state: 'met', due, progress: 1 })
  }
  return out
}

function nextStepOf(b: Bundle, now: Date): NextStep {
  const c = b.claim
  const bad = currentProblems(b.runs)[0]
  if (bad) return { label: bad.status === 'failed' ? 'Look at the failed run' : 'Review the intake checks', reason: bad.error ?? `${bad.name} needs a person`, section: 'workflow', target: 'runs' }
  switch (c.status) {
    case 'received':
      return { label: 'Intake checks running', reason: 'The intake workflow is checking the claim and setting it up', section: 'workflow' }
    case 'in_review': {
      const due = b.deadlines.find((r) => r.kind === 'decision_due')
      return { label: 'Record decision', reason: `Proof of loss complete${due ? ` · decision due ${fmtDate(day(due.dueAt))}` : ''}`, section: 'decision' }
    }
    case 'awaiting_approval': {
      const dec = b.decisions.find((d) => d.status === 'awaiting_approval')
      return { label: 'Waiting on the team lead', reason: `${dec?.recordedByName ?? 'The examiner'}’s decision for ${fmtMoney(awaitingTotal(b))} is above their authority · the team lead approves it`, section: 'decision' }
    }
    case 'approved': {
      const items = standing(b.paymentItems)
      const day1 = items.map((i) => i.payOn).sort()[0]
      const held = items.filter((i) => i.status === 'held').length
      return held
        ? { label: 'Release the held payment', reason: `${plural(held, 'payment')} held · the claim stays open until it is released and paid`, section: 'payments' }
        : { label: 'Payment run pays it', reason: `${fmtMoney(sum2(items.map((i) => money(i.amount))))} cleared${day1 ? ` · pays ${fmtDate(day1)}` : ''}`, section: 'payments' }
    }
    case 'reopened': {
      const returned = b.paymentItems.filter((i) => i.status === 'returned')
      const replaced = returned.filter((i) => b.paymentItems.some((x) => x.replacementOfId === i.id))
      const waiting = returned.filter((i) => !replaced.includes(i))
      return waiting.length
        ? { label: 'Get the payee’s new bank details', reason: `${waiting.map((i) => `${i.payeeName ?? 'A payee'} ${fmtMoney(money(i.amount))}`).join(', ')} came back from the bank${waiting[0].returnCode ? ` (${waiting[0].returnCode})` : ''}`, section: 'payments' }
        : { label: 'Payment run pays the replacement', reason: `${plural(replaced.length, 'replacement payment')} cleared · the claim closes again when paid`, section: 'payments' }
    }
    case 'paying': return { label: 'Payment run in progress', reason: 'The file is with the bank; the claim closes when every payment is paid', section: 'payments' }
    case 'closed': return { label: 'Closed', reason: 'Nothing left to do', section: 'history' }
    default: break
  }
  const open = b.requirements.filter(openReq)
  if (open.length) {
    const r = open[0]
    const contact = b.deadlines.find((d) => d.kind === 'first_contact_by' && d.state === 'open')
    return {
      label: 'Follow up on evidence',
      reason: `Waiting on ${r.from.label} · ${r.name}${open.length > 1 ? ` and ${open.length - 1} more` : ''}${contact ? ` · first contact due ${fmtDate(day(contact.dueAt))}` : ''}`,
      section: 'requirements',
      target: r.id,
    }
  }
  return { label: 'Check the workflow', reason: `As of ${stamp(now.toISOString()).slice(11)}`, section: 'workflow' }
}

function exceptionsOf(b: Bundle, now: Date): ClaimException[] {
  const out: ClaimException[] = []
  for (const r of currentProblems(b.runs)) {
    if (r.status === 'failed') out.push({ id: `run-${r.id}`, title: 'Workflow failed', detail: r.error ?? r.name, meta: r.workflowId, action: { label: 'Open runs', section: 'workflow', target: 'runs' }, status: 'open' })
    if (r.status === 'needs_review') out.push({ id: `run-${r.id}`, title: 'Intake checks need a person', detail: r.saved.join(' · ') || r.name, meta: r.workflowId, action: { label: 'Open runs', section: 'workflow', target: 'runs' }, status: 'open' })
  }
  for (const d of b.deadlines) {
    if (d.lastOutcome === 'start_failed' && d.state === 'open') out.push({ id: `dl-${d.id}`, title: 'Deadline workflow could not start', detail: d.lastError ?? d.what, meta: `attempt ${d.attempt}`, action: { label: 'Deadline rows', section: 'workflow' }, status: 'open' })
    if (d.kind === 'first_contact_by' && d.state === 'open' && new Date(d.dueAt) < now) out.push({ id: `dl-${d.id}`, title: 'First contact overdue', detail: d.what, meta: `due ${fmtDate(day(d.dueAt), { weekday: true })}`, action: { label: 'Deadline rows', section: 'workflow' }, status: 'open' })
  }
  for (const i of b.paymentItems) {
    // A returned payment is an exception until the payee's new account has produced its replacement item.
    if (i.status === 'returned' && !b.paymentItems.some((x) => x.replacementOfId === i.id)) out.push({ id: `pay-${i.id}`, title: 'Payment returned by the bank', detail: `${i.payeeName ?? 'Payee'} · ${fmtMoney(money(i.amount))}${i.returnCode ? ` · ${i.returnCode}` : ''}${i.returnReason ? ` ${i.returnReason}` : ''}`, meta: i.paymentReference ?? `run ${i.runId?.slice(0, 8) ?? ''}`.trim(), action: { label: 'Open payments', section: 'payments' }, status: 'open' })
    if (i.status === 'held') out.push({ id: `pay-${i.id}`, title: 'Payment held', detail: `${i.payeeName ?? 'Payee'} · ${fmtMoney(money(i.amount))}${i.holdReason ? ` · ${i.holdReason}` : ''}`, meta: `payable ${fmtDate(i.payOn)}`, action: { label: 'Open payments', section: 'payments' }, status: 'open' })
  }
  return out
}

// ---------------------------------------------------------------- Requirements

const dateOnly = (iso: string) => day(iso)

export function mapRequirements(b: Bundle, now: Date): RequirementRecord[] {
  const claimId = b.claim.claimNumber
  return b.requirements.map((r) => {
    const rows = b.deadlines.filter((d) => d.requirementId === r.id).sort((x, y) => x.originalDueAt.localeCompare(y.originalDueAt) || x.dueAt.localeCompare(y.dueAt))
    const docs = b.documents.filter((d) => d.requirementId === r.id).sort((x, y) => x.receivedAt.localeCompare(y.receivedAt))
    const underReview = docs.find((d) => d.status === 'under_review')
    const pending = rows.find((d) => d.state === 'open' || d.state === 'dispatched')
    const late = !!pending && pending.state === 'open' && new Date(pending.dueAt) <= now
    const note = r.stateNote ?? undefined
    let state: RequirementRecord['state']
    let status: Status
    switch (r.state) {
      case 'accepted':
        state = 'met'
        status = r.acceptedAt && r.acceptedAt === r.requestedAt ? { label: 'On file', tone: 'positive' } : { label: `Accepted ${fmtDate(dateOnly(r.acceptedAt ?? r.requestedAt))}`, tone: 'positive' }
        break
      case 'waived': state = 'waived'; status = { label: `Waived ${fmtDate(dateOnly(r.waivedAt ?? r.requestedAt))}`, tone: 'neutral' }; break
      // A document the rules could not accept is with the examiner: the requirement is `received`, and says so.
      case 'received': state = 'inProgress'; status = underReview ? { label: 'Under review · examiner', tone: 'special' } : { label: 'Received · awaiting review', tone: 'info' }; break
      // "No match" is an answer, not an error: not enough, and the backend says why ('TIN mismatch').
      case 'not_enough': state = 'open'; status = { label: `Not enough${note && !/^not enough/i.test(note) ? ` · ${note}` : ''}`, tone: 'caution' }; break
      case 'expired': state = 'overdue'; status = { label: 'Expired', tone: 'critical' }; break
      default:
        if (late) { state = 'overdue'; status = { label: 'Follow-up due', tone: 'critical' } }
        else if (note && /^rejected/i.test(note)) { state = 'open'; status = { label: 'Asked again · rejected', tone: 'caution' } }
        else if (r.followUpCount > 0) { state = 'open'; status = { label: `Reminded ${r.followUpCount}×`, tone: 'caution' } }
        else { state = 'open'; status = { label: `Requested ${fmtDate(dateOnly(r.requestedAt))}`, tone: 'info' } }
    }
    const plan: PlanStep[] = [{ date: dateOnly(r.requestedAt), label: r.from.label === 'Our records' ? 'Satisfied from our records at set-up' : 'Requested', note: r.from.detail ?? undefined, state: 'done' }]
    // What arrived, and what became of it, before the follow-up rows (the sort below keeps this order within a day).
    for (const d of docs) {
      const what = `${DOC_KIND[d.kind]} received by ${DOC_SOURCE[d.source].toLowerCase()}`
      const notes = [d.attributes.tinMasked ? `taxpayer number ${d.attributes.tinMasked}` : '', d.attributes.photocopy ? 'photocopy' : ''].filter(Boolean).join(' · ')
      plan.push({ date: dateOnly(d.receivedAt), label: what, note: notes || undefined, state: 'done' })
      if (d.status === 'accepted') plan.push({ date: dateOnly(d.reviewedAt ?? d.receivedAt), label: d.reviewedBy ? `Accepted by ${staffByHandle(d.reviewedBy)?.name ?? d.reviewedBy}` : 'Accepted by the rules', note: d.reviewReason ?? undefined, state: 'done' })
      if (d.status === 'not_enough') plan.push({ date: dateOnly(d.receivedAt), label: `Not enough: ${d.statusNote ?? 'the check failed'}`, note: 'the requirement stays open; a correction is asked for', state: 'done' })
      if (d.status === 'under_review') plan.push({ date: dateOnly(d.receivedAt), label: 'Under review: with the examiner', note: d.statusNote ?? undefined, state: 'current' })
      if (d.status === 'rejected') plan.push({ date: dateOnly(d.reviewedAt ?? d.receivedAt), label: `Rejected by ${reviewer(d.reviewedBy)}`, note: d.reviewReason ?? d.statusNote ?? undefined, state: 'done' })
    }
    for (const d of rows) {
      if (d.state === 'done' && d.fired) plan.push({ date: dateOnly(d.closedAt ?? d.dueAt), label: 'Follow-up fired: reminder sent', note: d.result ?? undefined, state: 'done' })
      else if (d.state === 'done' || d.state === 'skipped') plan.push({ date: dateOnly(d.closedAt ?? d.dueAt), label: 'Follow-up no longer needed', note: d.result ?? undefined, state: 'skipped' })
      else if (d.state === 'dispatched') plan.push({ date: dateOnly(d.dispatchedAt ?? d.dueAt), label: 'Follow-up workflow running', note: d.workflowId ?? undefined, state: 'current' })
      else plan.push({ date: dateOnly(d.dueAt), label: `${followUp(d.what).plan} if it hasn’t arrived`, state: 'todo' })
    }
    if (r.state === 'accepted' && r.acceptedAt && r.acceptedAt !== r.requestedAt && !docs.some((d) => d.status === 'accepted')) plan.push({ date: dateOnly(r.acceptedAt), label: 'Accepted', note: r.satisfiedBy ?? undefined, state: 'done' })
    if (r.state === 'waived' && r.waivedAt) plan.push({ date: dateOnly(r.waivedAt), label: 'Waived', note: r.waiveReason ?? undefined, state: 'done' })
    plan.sort((x, y) => x.date.localeCompare(y.date))
    const reminders = rows.filter((d) => d.state === 'done' && d.fired).map((d) => `reminder ${fmtDate(dateOnly(d.closedAt ?? d.dueAt))}`)
    return {
      id: r.id,
      claimId,
      name: r.name,
      note,
      purpose: r.purpose,
      from: r.from.label,
      fromDetail: r.from.detail ?? undefined,
      status,
      state,
      requested: dateOnly(r.requestedAt),
      requestedVia: r.from.detail ?? undefined,
      followUps: reminders,
      due: pending ? dateOnly(pending.dueAt) : undefined,
      dueNote: pending ? (late ? 'follow-up due' : followUp(pending.what).due) : undefined,
      benefitLineId: r.benefitLineId ?? undefined,
      waitingOn: openReq(r) ? (underReview ? 'The examiner' : r.from.label) : undefined,
      contact: [r.from.label, r.from.detail].filter((x): x is string => !!x),
      plan,
      receivedOn: r.receivedAt ? dateOnly(r.receivedAt) : r.acceptedAt ? dateOnly(r.acceptedAt) : undefined,
      waiveReason: r.waiveReason ?? undefined,
      live: {
        state: r.state,
        version: r.version,
        key: r.key,
        followUpCount: r.followUpCount,
        satisfiedBy: r.satisfiedBy ?? undefined,
        stateNote: note,
        documents: docs.map((d) => ({ id: d.id, title: docTitle(d), status: docStatus(d), note: d.statusNote ?? undefined, at: stamp(d.receivedAt), source: DOC_SOURCE[d.source], underReview: d.status === 'under_review' })),
      },
    }
  })
}

/** What a follow-up row is, from the backend's wording of it ('Follow up again: ...', 'Follow up: corrected W-9 · Diane'). */
function followUp(what: string): { plan: string; due: string } {
  if (what.startsWith('Follow up again')) return { plan: 'Follow up again', due: 'follow-up fires' }
  if (/corrected/i.test(what)) return { plan: 'The correction follow-up fires', due: 'correction follow-up fires' }
  if (/certified copy/i.test(what)) return { plan: 'The certified-copy follow-up fires', due: 'certified-copy follow-up fires' }
  return { plan: 'Follow-up deadline fires', due: 'follow-up fires' }
}

/** Rachel Kim for `rachel`; a name the backend already recorded stays as it is. */
const reviewer = (handle: string | null | undefined): string => (handle ? staffByHandle(handle)?.name ?? handle : 'the examiner')

// ---------------------------------------------------------------- Letters, history, work items

export function mapLetters(b: Bundle): Communication[] {
  const channel = (c: ApiLetter['channel']): Communication['channel'] => (c === 'sms' ? 'email' : c === 'fax' ? 'letter' : c)
  const statusOf = (l: ApiLetter): Status =>
    l.status === 'sent' ? { label: 'Sent', tone: 'positive' } : l.status === 'failed' ? { label: 'Failed', tone: 'critical' } : l.status === 'queued' ? { label: 'Queued', tone: 'info' } : { label: 'Draft', tone: 'neutral' }
  return b.letters
    .map((l) => ({
      id: l.id,
      claimId: b.claim.claimNumber,
      at: stamp(l.sentAt ?? l.createdAt),
      channel: channel(l.channel),
      direction: 'out' as const,
      title: l.subject,
      party: `${l.recipientLabel} · ${l.channel === 'portal' ? 'portal invite' : l.channel}`,
      detail: l.summary ?? '',
      status: statusOf(l),
      template: l.templateCode,
    }))
    .sort((x, y) => y.at.localeCompare(x.at))
}

/**
 * People who are not in the staff directory but write history: the backend labels ops re-runs `ops` (any X-Actor is accepted) and records
 * the dev intake and portal by their login. Some events still carry the raw staff handle and newer ones the staff name: both render as the name.
 */
const ACTOR_NAMES: Record<string, string> = { ops: 'Claims operations', 'intake.dev': 'Intake', 'portal.dev': 'Claimant portal' }

export function personName(actor: string): string {
  return staffByHandle(actor)?.name ?? ACTOR_NAMES[actor] ?? actor
}

export function actorLabel(e: Pick<ApiHistoryEvent, 'actorKind' | 'actor'>): string {
  switch (e.actorKind) {
    case 'workflow': return `Workflow · ${e.actor}`
    case 'system': return `System · ${e.actor}`
    case 'batch': return `Batch · ${e.actor}`
    case 'portal': return `Portal · ${ACTOR_NAMES[e.actor] ? ACTOR_NAMES[e.actor].replace('Claimant portal', 'claimant') : e.actor}`
    default: return personName(e.actor)
  }
}

export function mapHistory(b: Bundle): HistoryEvent[] {
  return b.history
    .map((e) => ({ id: e.id, claimId: b.claim.claimNumber, at: stamp(e.occurredAt), type: e.type, title: e.title, actor: actorLabel(e), detail: e.detail ?? undefined, ref: e.ref ?? undefined }))
    .sort((x, y) => y.at.localeCompare(x.at))
}

const SECTIONS_OK: SectionKey[] = ['overview', 'workflow', 'policies', 'people', 'requirements', 'documents', 'decision', 'payments', 'communications', 'history']

export function mapWorkItems(items: ApiWorkItem[], numberOf: (claimId: string) => string | undefined, now: Date): WorkItem[] {
  const today = day(now.toISOString())
  return items.map((w) => {
    const views: WorkView[] = []
    if (w.dueOn <= today) views.push('dueToday')
    if (w.priority === 1) views.push('atRisk')
    if (w.section === 'decision') views.push('readyToDecide')
    if (w.waitingOn !== 'You') views.push('waiting')
    const section = (SECTIONS_OK as string[]).includes(w.section) ? (w.section as SectionKey) : 'overview'
    return {
      id: w.id,
      ownerId: personaOf(w.ownerId),
      claimId: numberOf(w.claimId) ?? w.claimId,
      priority: w.priority,
      action: w.action,
      why: w.why,
      due: w.dueOn,
      flag: w.flag ? { label: w.flag, tone: 'caution' } : undefined,
      waitingOn: w.waitingOn,
      section,
      views,
      status: w.status,
      live: true,
    }
  })
}
