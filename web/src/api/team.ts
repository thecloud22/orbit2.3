/**
 * Team board and operations dashboard — mock of GET /teams/{id}/board, /approvals and /insights/ops.
 *
 * Approvals are the team lead's open work items (the decision workbench inserts one whenever an examiner
 * goes over authority or proposes a denial), enriched with the display data a real approvals endpoint
 * would join in. Workload starts from the board's numbers and moves with the live claims and work items.
 */
import { AT_RISK_EXTRA, APPROVAL_DETAILS, EXAMINERS, OPS, RECENT, UNASSIGNED } from './fixtures/team'
import { CLAIMS } from './fixtures/claims'
import { WORK_ITEMS } from './fixtures/work'
import { STAFF, USERS } from './fixtures/users'
import { collection, fail, newId, respond } from './store'
import { LIVE } from './live/config'
import { samplesShown } from './live/mode'
import * as live from './live/data'
import { toApproval } from './live/approvals'
import { claims, patchClaim } from './claims'
import { decisions, listWorkbenches } from './decisions'
import { history, logEvent } from './history'
import { schedulePayment } from './payments'
import { workItems } from './work'
import { addDays, daysUntil, fmtDate, fmtTime, nowStamp, TODAY } from '../lib/dates'
import { fmtMoney, fmtMoneyShort, sum } from '../lib/money'
import type { Claim, Family, ISODate, ReadinessCheck, SectionKey, Tone, User, WorkItem } from './types'

// ---------------------------------------------------------------- Types

export type ApprovalKind = 'payout' | 'secondReview' | 'waiver' | 'close' | 'other'

/** Display data joined onto an approval work item. */
export interface ApprovalDetail {
  kind: ApprovalKind
  type: string
  /** Examiner id. */
  requestedBy: string
  waitingHours: number
  amount?: number
  limit?: number
  amountNote?: string
  reason?: string
  /** What the examiner proposes, for second reviews, waivers and closures. */
  proposed?: string
  payee?: string
  payeeMethod?: string
  screening?: string
  checks: string[]
  rationale: string
  evidence?: string[]
  provisions?: string[]
  letter?: string
  payDate?: ISODate
}

export interface ApprovalCheck {
  label: string
  result: ReadinessCheck['result']
}

/** GET /approvals?approver=me — one row of the team lead's approvals table. */
export interface Approval {
  id: string
  claimId: string
  claimName: string
  product: string
  family: Family
  benefitLineId: string
  lineName: string
  ref: string
  kind: ApprovalKind
  type: string
  requester: { id: string; name: string; limit?: number }
  waitingHours: number
  amount?: number
  limit?: number
  amountNote?: string
  reason?: string
  proposed?: string
  payees: string[]
  payeeMethod?: string
  screening?: string
  checks: ApprovalCheck[]
  rationale: string
  evidence: string[]
  provisions: string[]
  letter?: string
  payDate: ISODate
  section: SectionKey
  due: ISODate
  /** Created while the mock was running (not from the board's sample). */
  live: boolean
  /** Live mode: the backend decision this approval is for; approving calls POST /decisions/{id}:approve. */
  backend?: { decisionId: string }
}

export interface ExaminerSeed {
  id: string
  name: string
  initials: string
  open: number
  dueSoon: number
  atRisk: number
  ready: number
  oldestDays: number
  /** Percent of the examiner's target caseload, as on the board. 0 when out of office. */
  capacity: number
  lines: Family[]
  outOfOffice?: { back: ISODate; coveredBy: string }
}

export interface ExaminerLoad extends ExaminerSeed {
  status: { label: string; tone: Tone }
}

export interface UnassignedClaim {
  id: string
  claimId: string
  name: string
  product: string
  family: Family
  received: ISODate
  amount: number
  suggested: string
}

export interface AtRiskExtra {
  id: string
  examinerId: string
  claimId: string
  name: string
  product: string
  action: string
  why: string
  due: ISODate
}

export interface AtRiskItem extends AtRiskExtra {
  /** True when the claim exists in this mock and can be opened. */
  openable: boolean
  section: SectionKey
}

export interface RecentDecision {
  id: string
  at: string
  claimId: string
  text: string
  detail: string
  link?: { label: string; section: SectionKey }
}

export interface Move {
  from: string
  to: string
  count: number
}

// ---------------------------------------------------------------- Collections

const loads = collection<ExaminerSeed>(EXAMINERS)
const unassigned = collection<UnassignedClaim>(UNASSIGNED)
const recent = collection<RecentDecision>(RECENT)

/** Examiner name → id, across signed-in users, staff and the team. */
function examinerId(name: string): string | undefined {
  return (
    EXAMINERS.find((e) => e.name === name)?.id ??
    USERS.find((u) => u.name === name)?.id ??
    Object.entries(STAFF).find(([, s]) => s.name === name)?.[0]
  )
}

export function examinerName(id: string): string {
  return EXAMINERS.find((e) => e.id === id)?.name ?? USERS.find((u) => u.id === id)?.name ?? STAFF[id]?.name ?? id
}

function examinerLimit(id: string): number | undefined {
  return USERS.find((u) => u.id === id)?.payoutLimit ?? (STAFF[id] ? 250_000 : undefined)
}

// ---------------------------------------------------------------- Workload

interface Live {
  open: number
  dueSoon: number
  atRisk: number
  ready: number
}

function isClosed(c: Claim): boolean {
  const last = c.stage[c.stage.length - 1]
  return last?.state === 'done' || last?.state === 'current'
}

/** At risk of breach: flagged at risk and a clock due within 2 days. */
function atRiskItem(w: WorkItem): boolean {
  return w.views.includes('atRisk') && daysUntil(w.due) <= 2
}

function liveStats(id: string, cs: Claim[], ws: WorkItem[]): Live {
  const items = ws.filter((w) => w.ownerId === id && w.status === 'open')
  return {
    open: cs.filter((c) => c.ownerId === id && !isClosed(c)).length,
    dueSoon: new Set(items.filter((w) => daysUntil(w.due) <= 2).map((w) => w.claimId)).size,
    atRisk: items.filter(atRiskItem).length,
    ready: items.filter((w) => w.views.includes('readyToDecide')).length,
  }
}

/** What the mock's own data contributed when the board's numbers were taken. */
const SEED_LIVE = new Map(EXAMINERS.map((e) => [e.id, liveStats(e.id, CLAIMS, WORK_ITEMS)]))
/** Target caseload per examiner, so capacity moves with the open count. */
const TARGET = new Map(EXAMINERS.map((e) => [e.id, e.capacity ? e.open / (e.capacity / 100) : 0]))

function currentLoads(): ExaminerLoad[] {
  const cs = claims.all()
  const ws = workItems.all()
  return loads
    .all()
    .map((row) => {
      const now = liveStats(row.id, cs, ws)
      const seed = SEED_LIVE.get(row.id)!
      const open = row.open + now.open - seed.open
      const target = TARGET.get(row.id) ?? 0
      const capacity = row.outOfOffice || !target ? 0 : Math.round((open / target) * 100)
      const status: ExaminerLoad['status'] = row.outOfOffice
        ? { label: 'Out of office — covered', tone: 'neutral' }
        : capacity > 100
          ? { label: 'Over capacity', tone: 'caution' }
          : { label: 'Available', tone: 'info' }
      return {
        ...row,
        open,
        dueSoon: Math.max(0, row.dueSoon + now.dueSoon - seed.dueSoon),
        atRisk: Math.max(0, row.atRisk + now.atRisk - seed.atRisk),
        ready: Math.max(0, row.ready + now.ready - seed.ready),
        capacity,
        status,
      }
    })
    .sort((a, b) => (a.outOfOffice ? 1 : 0) - (b.outOfOffice ? 1 : 0) || b.capacity - a.capacity)
}

/** GET /teams/{id}/workload — sorted by capacity, people out of office last. */
export function getWorkload(): Promise<ExaminerLoad[]> {
  return respond(currentLoads())
}

/**
 * Rules-based rebalance: examiners over 100% give claims down to 95%; examiners who share a product line
 * take them up to 95%. Nothing with a clock due in 5 days moves. Not a suggestion from the assistant.
 */
export function proposeRebalance(rows: ExaminerLoad[]): Move[] {
  const room = new Map(
    rows.filter((r) => !r.outOfOffice).map((r) => [r.id, Math.floor((TARGET.get(r.id) ?? 0) * 0.95) - r.open]),
  )
  const moves: Move[] = []
  rows
    .filter((r) => !r.outOfOffice && r.capacity > 100)
    .forEach((giver) => {
      let excess = -(room.get(giver.id) ?? 0)
      rows
        .filter((r) => r.id !== giver.id && !r.outOfOffice && r.capacity < 95 && r.lines.some((l) => giver.lines.includes(l)))
        .sort((a, b) => a.capacity - b.capacity)
        .forEach((taker) => {
          const space = room.get(taker.id) ?? 0
          const n = Math.min(excess, space)
          if (n <= 0) return
          moves.push({ from: giver.id, to: taker.id, count: n })
          room.set(taker.id, space - n)
          excess -= n
        })
    })
  return moves
}

/** POST /teams/{id}/workload:move — moves counts of unstarted claims between examiners. */
export function applyMoves(moves: Move[], by: User): Promise<number> {
  const total = sum(moves.map((m) => m.count))
  if (!total) return fail('Nothing to move')
  moves.forEach((m) => {
    loads.update(m.from, (r) => ({ open: r.open - m.count }))
    loads.update(m.to, (r) => ({ open: r.open + m.count }))
  })
  void by
  return respond(total)
}

// ---------------------------------------------------------------- Unassigned, at risk, recent

export function listUnassigned(): Promise<UnassignedClaim[]> {
  return respond(unassigned.all())
}

/** POST /claims:assign — each new claim goes to the chosen examiner. */
export function assignClaims(assignments: { id: string; to: string }[], by: User): Promise<number> {
  assignments.forEach((a) => {
    unassigned.remove(a.id)
    loads.update(a.to, (r) => ({ open: r.open + 1 }))
  })
  void by
  return respond(assignments.length)
}

export function listAtRisk(): Promise<AtRiskItem[]> {
  const ids = new Set(EXAMINERS.map((e) => e.id))
  const live: AtRiskItem[] = workItems
    .where((w) => w.status === 'open' && ids.has(w.ownerId) && atRiskItem(w))
    .map((w) => {
      const c = claims.get(w.claimId)
      return { id: w.id, examinerId: w.ownerId, claimId: w.claimId, name: c?.name ?? w.claimId, product: c?.product ?? '', action: w.action, why: w.why, due: w.due, openable: !!c, section: w.section }
    })
  const extra = AT_RISK_EXTRA.map((x) => ({ ...x, openable: !!claims.get(x.claimId), section: 'overview' as SectionKey }))
  return respond([...live, ...extra].sort((a, b) => a.due.localeCompare(b.due)))
}

export function listRecent(): Promise<RecentDecision[]> {
  return respond([...recent.all()].sort((a, b) => b.at.localeCompare(a.at)))
}

// ---------------------------------------------------------------- Approvals

function kindOf(action: string): ApprovalKind {
  if (/above authority/i.test(action)) return 'payout'
  if (/second review/i.test(action)) return 'secondReview'
  if (/close without payment/i.test(action)) return 'close'
  if (/instead of|waive/i.test(action)) return 'waiver'
  return 'other'
}

function typeLabel(kind: ApprovalKind, action: string): string {
  if (kind === 'secondReview') return /partial/i.test(action) ? 'Partial approval — second review' : 'Denial — second review'
  return action.replace(/^Approve /, '').replace(/^./, (s) => s.toUpperCase())
}

function parseMoney(s?: string): number | undefined {
  if (!s || !s.includes('$')) return undefined
  const n = Number(s.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

async function buildApproval(w: WorkItem): Promise<Approval | undefined> {
  const claim = claims.get(w.claimId)
  if (!claim) return undefined
  const fixture = APPROVAL_DETAILS[w.id]
  const line = claim.benefitLines[0]

  if (fixture) {
    const requesterId = fixture.requestedBy
    return {
      id: w.id, claimId: claim.id, claimName: claim.name, product: claim.product, family: claim.family,
      benefitLineId: line.id, lineName: line.name, ref: line.ref,
      kind: fixture.kind, type: fixture.type,
      requester: { id: requesterId, name: examinerName(requesterId), limit: fixture.limit ?? examinerLimit(requesterId) },
      waitingHours: fixture.waitingHours, amount: fixture.amount, limit: fixture.limit, amountNote: fixture.amountNote,
      reason: fixture.reason, proposed: fixture.proposed, payees: fixture.payee ? [fixture.payee] : [], payeeMethod: fixture.payeeMethod,
      screening: fixture.screening, checks: fixture.checks.map((label) => ({ label, result: 'pass' })),
      rationale: fixture.rationale, evidence: fixture.evidence ?? [], provisions: fixture.provisions ?? [], letter: fixture.letter,
      payDate: fixture.payDate ?? '2026-09-28', section: w.section, due: w.due, live: false,
    }
  }

  // Created at runtime by the decision workbench: '<name> · $X · limit $Y' or '<name> · <title> <ref>'.
  const kind = kindOf(w.action)
  const parts = w.why.split(' · ')
  const requesterName = parts[0]
  const requesterId = examinerId(requesterName) ?? requesterName
  const wbs = await listWorkbenches(claim.id)
  const wb = wbs.find((b) => w.why.includes(b.ref)) ?? wbs[0]
  const bl = claim.benefitLines.find((b) => b.id === wb?.benefitLineId) ?? line
  const amount = parseMoney(parts[1]) ?? (wb ? sum(wb.payees.map((p) => p.amount)) || undefined : undefined) ?? bl.amount
  const limit = parseMoney(parts[2]) ?? examinerLimit(requesterId)
  const sent = history
    .where((h) => h.claimId === claim.id && h.type === 'decision' && h.actor === requesterName)
    .sort((a, b) => b.at.localeCompare(a.at))[0]
  const payees = new Map<string, number>()
  wb?.payees.forEach((p) => payees.set(p.payee, sum([payees.get(p.payee) ?? 0, p.amount])))
  return {
    id: w.id, claimId: claim.id, claimName: claim.name, product: claim.product, family: claim.family,
    benefitLineId: bl.id, lineName: wb?.title ?? bl.name, ref: wb?.ref ?? bl.ref,
    kind, type: typeLabel(kind, w.action),
    requester: { id: requesterId, name: requesterName, limit },
    waitingHours: 0, amount, limit: kind === 'payout' ? limit : undefined,
    amountNote: wb ? `${wb.ref} · ${wb.effective}` : bl.ref,
    reason: kind === 'payout' ? undefined : parts.slice(1).join(' · ') || w.action,
    proposed: kind === 'secondReview' ? (/partial/i.test(w.action) ? 'Approve in part' : 'Deny') : undefined,
    payees: kind === 'payout' ? [...payees].map(([p, a]) => `${p} · ${fmtMoney(a)}`) : [],
    payeeMethod: wb?.payees[0]?.method,
    screening: kind === 'payout' && wb?.checks.find((c) => /screen/i.test(c.label))?.result === 'pass' ? 'Payee screening clear' : undefined,
    checks: (wb?.checks ?? []).map((c) => ({ label: c.label, result: /authority/i.test(c.label) && c.result === 'fail' ? 'pass' : c.result })),
    rationale: (kind === 'secondReview' ? sent?.detail : wb?.rationale) || sent?.detail || wb?.rationale || 'No rationale recorded.',
    evidence: wb?.evidence ?? [], provisions: wb?.provisions ?? [],
    letter: wb?.letters.map((l) => `${l.title} · ${l.template}`).join('; '),
    payDate: wb?.payDate && daysUntil(wb.payDate) > 0 ? wb.payDate : addDays(TODAY, 3),
    section: w.section, due: w.due, live: true,
  }
}

/** Approvals this board has already decided or returned. */
const handled = new Set<string>()

/** An approval is pending while its work item is open and this board hasn't acted on it. */
function isPending(w: WorkItem): boolean {
  return !handled.has(w.id) && w.status === 'open'
}

function markHandled(id: string) {
  handled.add(id)
  workItems.update(id, { status: 'done' })
}

/** GET /approvals?approver={id} — the lead's open approvals, most urgent first. */
export async function listApprovals(approverId = 'monica'): Promise<Approval[]> {
  // Live mode: the decisions the backend holds as awaiting approval come first; the mock's sample approvals only when samples are shown.
  const fromBackend = LIVE ? (await live.awaitingApprovals().catch(() => [])).map(toApproval) : []
  if (LIVE && !samplesShown()) return fromBackend
  const items = workItems.where((w) => w.ownerId === approverId && isPending(w))
  const built = (await Promise.all(items.map(buildApproval))).filter((a): a is Approval => !!a)
  const order = new Map(items.map((w, i) => [w.id, w.priority * 100 + i]))
  return [...fromBackend, ...built.sort((a, b) => order.get(a.id)! - order.get(b.id)!)]
}

export function waitingLabel(hours: number): string {
  if (hours <= 0) return 'Just now'
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** The examiner's own 'waiting on team lead' items for this claim. */
function completeWaiting(a: Approval) {
  workItems
    .where((w) => w.claimId === a.claimId && w.status === 'open' && w.ownerId !== 'monica' && (w.waitingOn.includes('Monica') || /^Waiting on team lead/i.test(w.action)))
    .forEach((w) => workItems.update(w.id, { status: 'done' }))
}

function stamp(by: User): string {
  return `${by.name} · ${fmtDate(TODAY)} ${fmtTime(nowStamp())}`
}

function noteRecent(a: Approval, text: string, detail: string, link?: RecentDecision['link']) {
  recent.insert({ id: newId('rd'), at: nowStamp(), claimId: a.claimId, text, detail, link })
}

function guard(a: Approval, by: User): string | undefined {
  const w = workItems.get(a.id)
  if (!w || !isPending(w)) return 'This approval has already been handled'
  if (by.role !== 'teamLead') return 'Only a team lead can decide approvals'
  if (a.amount && a.kind === 'payout' && a.amount > by.payoutLimit) return `${fmtMoney(a.amount)} is above your ${fmtMoneyShort(by.payoutLimit)} authority`
  if (a.kind === 'payout' && a.checks.some((c) => c.result !== 'pass')) return 'A readiness check has not passed'
  return undefined
}

/**
 * POST /approvals/{id}:approve
 * Payouts: the examiner's decision is recorded with the lead's approval, payment is scheduled and the
 * claim moves to payment. Second reviews: the lead agrees and the letter can go. Waivers and closures:
 * the lead's approval is logged and the examiner's work moves on.
 */
export function approve(a: Approval, by: User): Promise<string> {
  // A backend approval: the API checks the approver (a team lead, not the recorder, within their limit). X-Actor is the signed-in persona.
  if (a.backend) return live.approveDecision(a.claimId, a.backend.decisionId).then((r) => r.message)
  const blocked = guard(a, by)
  if (blocked) return fail(blocked)
  const lower = a.product.toLowerCase()

  if (a.kind === 'payout' && a.amount) {
    const amount = a.amount
    const version = decisions.where((d) => d.claimId === a.claimId && d.benefitLineId === a.benefitLineId).length + 1
    decisions.insert({
      id: newId('d'), claimId: a.claimId, benefitLineId: a.benefitLineId, title: `${a.lineName} ${a.ref}`, version,
      recordedAt: nowStamp(), recordedBy: a.requester.name,
      authorityNote: `above ${fmtMoneyShort(a.limit ?? 0)} authority · approved by ${by.name}`,
      outcome: 'approved', outcomeText: `Approved · ${fmtMoney(amount)}`, basis: a.rationale,
      evidence: a.evidence, provisions: a.provisions, approvals: [stamp(by)],
      letter: a.letter ? `${a.letter} · sends with the payment` : undefined,
      assistantNote: 'No AI recommendation on the outcome. Readiness checks are rules, not suggestions.',
    })
    const payDay = fmtDate(a.payDate)
    patchClaim(a.claimId, (c) => {
      const pay = c.stage.findIndex((s) => s.key === 'payment')
      return {
        benefitLines: c.benefitLines.map((b) =>
          b.id === a.benefitLineId ? { ...b, status: { label: `Approved ${fmtDate(TODAY)}`, tone: 'positive' }, paid: `${fmtMoney(amount)} paying ${payDay}`, waitingOn: 'Payments', due: payDay } : b,
        ),
        stage: pay < 0 ? c.stage : c.stage.map((s, i) => ({ ...s, state: i < pay ? 'done' : i === pay ? 'current' : s.state === 'done' ? 'done' : 'todo' })),
        clocks: c.clocks.map((k) => (k.kind === 'deadline' ? { ...k, state: 'met' } : k)),
        nextStep: { label: 'Confirm payment and close', reason: `Approved by ${by.name} · ${fmtMoney(amount)} releases ${payDay}`, section: 'payments' },
      }
    })
    if (!a.live && a.payees[0]) {
      schedulePayment({ claimId: a.claimId, benefitLineId: a.benefitLineId, payDate: a.payDate, payee: a.payees[0].split(' · ')[0], basis: `${a.lineName} · death benefit`, amount, method: a.payeeMethod ?? 'EFT', status: { label: 'Scheduled', tone: 'info' } })
    }
    markHandled(a.id)
    completeWaiting(a)
    logEvent(a.claimId, { type: 'decision', title: `Approved above authority — ${a.lineName} ${fmtMoney(amount)} (v${version})`, actor: `${by.name} · team lead`, detail: `Requested by ${a.requester.name}, limit ${fmtMoneyShort(a.limit ?? 0)}. ${a.rationale}`, ref: 'Decision record' })
    logEvent(a.claimId, { type: 'payment', title: `Payment released for ${payDay} — ${fmtMoney(amount)}`, actor: 'System · on approval' })
    noteRecent(a, 'approved', `${a.claimName.split(' ').slice(-1)[0]} · ${lower} · ${fmtMoneyShort(amount)}`, { label: `paying ${payDay}`, section: 'payments' })
    return respond(`Approved · ${fmtMoney(amount)} for ${a.claimName} releases ${payDay}`)
  }

  if (a.kind === 'secondReview') {
    markHandled(a.id)
    completeWaiting(a)
    patchClaim(a.claimId, (c) => ({
      benefitLines: c.benefitLines.map((b) => (b.id === a.benefitLineId ? { ...b, status: { label: 'Denied · second review agreed', tone: 'critical' } } : b)),
      nextStep: { label: 'Send denial letter', reason: `${by.name} agreed with the denial · letter includes appeal rights`, section: 'communications' },
    }))
    logEvent(a.claimId, { type: 'decision', title: `Second review agreed — ${a.proposed ?? 'denial'} of ${a.lineName} ${a.ref}`, actor: `${by.name} · second reviewer`, detail: a.reason })
    noteRecent(a, 'denial agreed', `${a.claimName.split(' ').slice(-1)[0]} · ${lower} · ${a.reason ?? ''}`)
    return respond(`Agreed with the denial · ${a.requester.name} can send the letter`)
  }

  if (a.kind === 'close') {
    const version = decisions.where((d) => d.claimId === a.claimId && d.benefitLineId === a.benefitLineId).length + 1
    decisions.insert({
      id: newId('d'), claimId: a.claimId, benefitLineId: a.benefitLineId, title: `${a.lineName} ${a.ref}`, version,
      recordedAt: nowStamp(), recordedBy: a.requester.name, authorityNote: `closure approved by ${by.name}`,
      outcome: 'closed', outcomeText: `Closed without payment · ${a.amount ? fmtMoney(a.amount) : 'proceeds'} to the state`, basis: a.rationale,
      evidence: a.evidence, provisions: a.provisions, approvals: [stamp(by)],
    })
    patchClaim(a.claimId, (c) => ({
      benefitLines: c.benefitLines.map((b) => (b.id === a.benefitLineId ? { ...b, status: { label: 'Closed · unclaimed property', tone: 'neutral' } } : b)),
      nextStep: { label: 'Report to the state', reason: `Closure approved by ${by.name} · remit with the next unclaimed property report`, section: 'history' },
    }))
    markHandled(a.id)
    completeWaiting(a)
    logEvent(a.claimId, { type: 'decision', title: `Closure without payment approved — ${a.lineName}`, actor: `${by.name} · team lead`, detail: a.rationale, ref: 'Decision record' })
    noteRecent(a, 'closed', `${a.claimName.split(' ').slice(-1)[0]} · ${lower} · unclaimed property`)
    return respond(`Closure approved · ${a.claimName}`)
  }

  // Waivers and anything else: log the approval and let the examiner carry on.
  markHandled(a.id)
  completeWaiting(a)
  if (a.kind === 'waiver') {
    workItems
      .where((w) => w.claimId === a.claimId && w.ownerId === a.requester.id && w.status === 'open' && w.section === 'requirements')
      .forEach((w) => workItems.update(w.id, { action: 'Request consular report of death', why: `${by.name} approved it instead of the apostille`, waitingOn: 'You', views: [...new Set([...w.views.filter((v) => v !== 'waiting'), 'dueToday' as const])] }))
  }
  logEvent(a.claimId, { type: 'decision', title: `Approved — ${a.reason ?? a.type}`, actor: `${by.name} · team lead`, detail: a.rationale })
  noteRecent(a, 'approved', `${a.claimName.split(' ').slice(-1)[0]} · ${a.reason ?? a.type}`)
  return respond(`Approved · ${a.requester.name} can go ahead`)
}

/** POST /approvals/{id}:return — back to the examiner with a note; nothing reaches the claimant. */
export function returnWithNote(a: Approval, note: string, by: User): Promise<string> {
  if (a.backend) return fail('Returning a decision to the examiner is not on the backend yet')
  const w = workItems.get(a.id)
  if (!w || !isPending(w)) return fail('This approval has already been handled')
  if (!note.trim()) return fail('Add a note for the examiner')
  markHandled(a.id)
  completeWaiting(a)
  workItems.insert({
    id: newId('w'), ownerId: a.requester.id, claimId: a.claimId, priority: 1,
    action: `Returned: ${a.type.toLowerCase()}`, why: `${by.name} · ${note.trim()}`, whyNext: note.trim(),
    due: TODAY, flag: { label: 'Returned', tone: 'caution' }, waitingOn: 'You', section: a.section, views: ['dueToday'], status: 'open',
  })
  patchClaim(a.claimId, { nextStep: { label: 'Answer the team lead’s note', reason: `Returned by ${by.name} · ${note.trim()}`, section: a.section } })
  logEvent(a.claimId, { type: 'decision', title: `Returned to ${a.requester.name} — ${a.type}`, actor: `${by.name} · team lead`, detail: note.trim() })
  return respond(`Returned to ${a.requester.name} with your note`)
}

// ---------------------------------------------------------------- Operations dashboard

export type ProductFilter = 'all' | 'life' | 'di' | 'annuity'
export type OpsLine = 'life' | 'di' | 'annuity'

export interface OpsData {
  weeks: ISODate[]
  inventory: Record<OpsLine, number[]>
  clocks: { key: string; label: string; verb: string; counts: Record<OpsLine, [number, number]> }[]
  medianDays: Record<OpsLine, number>
  reconsiderations: Record<OpsLine, [number, number]>
  paymentAudit: Record<OpsLine, [number, number]>
  ageing: { buckets: string[] } & Record<OpsLine, number[]>
  outcomes: { label: string; family: OpsLine; approved: number; withdrawn: number; denied: number }[]
  fastTrack: Record<OpsLine, { newClaims: number; fastTracked: number; fastDays: number; standardDays: number }> & { all: { fastDays: number; standardDays: number } }
  attention: { id: string; tone: Tone; tag: string; meta: string; title: string; detail: string; owner: { name: string; initials: string }; action: string; to?: string; lines: OpsLine[] }[]
}

export const OPS_LINES: OpsLine[] = ['life', 'di', 'annuity']

/** GET /insights/ops — the raw measures; the dashboard slices them by product. */
export function getOps(): OpsData {
  return OPS
}
