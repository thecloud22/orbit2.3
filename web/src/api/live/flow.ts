/**
 * The Workflow & SLA record for a live claim, built from the backend's deadlines, workflow runs, history and letters.
 * The API returns those as plain records; the service-level table, the milestones and the swimlane are derived here.
 */
import type { DeadlineRow, LaneRow, LifeFlow, ServiceLevel, WorkflowRun } from '../lifeFlow'
import { daysFrom } from '../../lib/dates'
import type { ApiDeadline, ApiHistoryEvent, ApiWorkflowRun } from './types'
import { actorLabel, claimStatus, KINDS_WITH_WORKFLOW, learnOwner, money, ownerName, personaOf, standing, type Bundle } from './present'
import { fmtMoney } from '../../lib/money'
import { day, stamp, took } from './time'

const first = (name: string) => name.split(' ')[0]
const shortId = (uuid: string) => `D-${uuid.slice(0, 6)}`

function lateDays(due: string, metAt: string | null): number | undefined {
  if (!metAt) return undefined
  const n = daysFrom(day(due), day(metAt))
  return n > 0 ? n : undefined
}

/** The kinds no workflow fires (the dispatcher polls only follow-ups): what closes each one instead. */
const CLOSED_BY: Record<string, string> = {
  first_contact_by: 'logging the welcome call',
  status_letter: 'recording the decision',
  review_target: 'recording the decision',
  decision_due: 'recording the decision',
  payment_due: 'the payment run',
  document_review_by: 'the examiner’s review of the document',
  bank_details_by: 'the payee’s new bank account',
}

export function mapDeadlines(b: Bundle, now: Date): DeadlineRow[] {
  return [...b.deadlines]
    .sort((x, y) => x.originalDueAt.localeCompare(y.originalDueAt) || x.dueAt.localeCompare(y.dueAt))
    .map((d) => {
      const hasWorkflow = KINDS_WITH_WORKFLOW.has(d.kind)
      const late = day(d.dueAt) < day(now.toISOString())
      return {
        id: shortId(d.id),
        kind: d.kind,
        what: d.what,
        due: day(d.dueAt),
        status: d.state === 'done' ? 'done' : d.state === 'skipped' ? 'skipped' : 'open',
        fired: d.fired,
        closedAt: d.closedAt ? stamp(d.closedAt) : undefined,
        result: d.result ?? d.lastError ?? undefined,
        sla: (d.sla ?? undefined) as DeadlineRow['sla'],
        reqId: d.requirementId ?? undefined,
        breached: d.state === 'done' && d.closedBy !== 'intake' && d.closedBy !== 'requirement' && lateDays(d.dueAt, d.closedAt) !== undefined && d.fired,
        live: {
          state: d.state,
          dueAt: stamp(d.dueAt),
          originalDueAt: stamp(d.originalDueAt),
          extensionReason: d.extensionReason ?? undefined,
          attempt: d.attempt,
          lastOutcome: d.lastOutcome ?? undefined,
          lastError: d.lastError ?? undefined,
          workflowId: d.workflowId ?? undefined,
          closedBy: d.closedBy ?? undefined,
          pastDue: (d.state === 'open') && (new Date(d.dueAt) <= now || late),
          hasWorkflow,
          closes: hasWorkflow ? undefined : CLOSED_BY[d.kind],
        },
      }
    })
}

/** '32 s', '1 min 14 s', '23 ms': the run's real elapsed time. */
export function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)} s`
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export function mapRuns(runs: ApiWorkflowRun[]): WorkflowRun[] {
  const sorted = [...runs].sort((x, y) => x.startedAt.localeCompare(y.startedAt))
  const seen = new Map<string, number>()
  const noOf = new Map<string, number>()
  const keyOf = (r: ApiWorkflowRun) => (noOf.get(r.id) ?? 1) > 1 ? `${r.workflowId}#${noOf.get(r.id)}` : r.workflowId
  for (const r of sorted) {
    const n = r.runNo ?? (seen.get(r.workflowId) ?? 0) + 1
    seen.set(r.workflowId, n)
    noOf.set(r.id, n)
  }
  return sorted.map((r) => {
    const rerun = sorted.find((x) => x.rerunOfId === r.id)
    return {
      id: r.workflowId,
      type: r.type === 'orchestration' ? 'Orchestration' : r.type === 'event' ? 'Event workflow' : 'Deadline workflow',
      name: r.name,
      startedBy: r.startedBy,
      at: stamp(r.startedAt),
      // The backend's elapsed time is real time from the first activity to the end; the timestamps follow the virtual clock.
      took: r.elapsedMs != null ? fmtElapsed(r.elapsedMs) : took(r.startedAt, r.finishedAt) ?? (r.status === 'running' ? 'running' : '—'),
      steps: r.steps.map((s) => ({ label: s.label, detail: s.detail, system: s.system, state: s.state, attempts: s.attempts ?? 1, note: s.note ?? undefined })),
      saved: r.saved,
      runNo: noOf.get(r.id) ?? 1,
      failed: r.status === 'failed',
      temporal: r.note ?? undefined,
      live: {
        status: r.status,
        runId: r.runId,
        error: r.error ?? undefined,
        workflowId: r.workflowId,
        id: r.id,
        canRerun: r.canRerun,
        elapsedMs: r.elapsedMs ?? undefined,
        rerunOfKey: r.rerunOfId ? (() => { const prev = sorted.find((x) => x.id === r.rerunOfId); return prev ? keyOf(prev) : undefined })() : undefined,
        rerunKey: rerun ? keyOf(rerun) : undefined,
      },
    }
  })
}

// ---------------------------------------------------------------- Service levels

function rowOf(rows: ApiDeadline[], sla: string): ApiDeadline | undefined {
  const mine = rows.filter((r) => r.sla === sla).sort((x, y) => x.dueAt.localeCompare(y.dueAt))
  return mine.find((r) => r.state === 'open' || r.state === 'dispatched') ?? mine[mine.length - 1]
}

function serviceLevels(b: Bundle, now: Date): ServiceLevel[] {
  const notice = day(b.claim.noticedAt)
  const dod = b.claim.details?.dateOfDeath
  const proof = b.claim.proofCompleteAt ? day(b.claim.proofCompleteAt) : undefined
  const mk = (
    id: ServiceLevel['id'], name: string, rule: string, source: ServiceLevel['source'], starts: string, kind: ServiceLevel['kind'], start: string | undefined,
  ): ServiceLevel => {
    const r = rowOf(b.deadlines, id)
    const sl: ServiceLevel = { id, name, rule, source, starts, kind, start, due: r ? day(r.dueAt) : undefined }
    if (r?.state === 'done' && r.closedAt) {
      sl.metOn = stamp(r.closedAt)
      sl.lateDays = lateDays(r.dueAt, r.closedAt)
    }
    if (r?.state === 'skipped') sl.stopped = 'Stopped · not needed'
    if (r && r.state === 'open' && new Date(r.dueAt) <= now) sl.pastDue = true
    return sl
  }
  const out: ServiceLevel[] = [
    mk('contact', 'First contact with the claimant', '1 business day from notice', 'Internal', 'Notice of death', 'deadline', notice),
    mk('ack', 'Acknowledge the claim', '15 days from notice', 'State rule', 'Notice of death', 'deadline', notice),
    mk('forms', 'Claim forms to each beneficiary', '15 days from notice', 'State rule', 'Notice of death', 'deadline', notice),
    mk('status', 'Status letter while undecided', 'Every 30 days until decided', 'State rule', 'Notice of death', 'recurring', notice),
    mk('decide', 'Decide after proof of loss', '30 days from complete proof', 'State rule', 'Proof of loss complete', 'deadline', proof),
    mk('review', 'Examiner review', '5 business days from complete proof', 'Internal', 'Proof of loss complete', 'deadline', proof),
    mk('pay', 'Pay after approval', '2 business days from approval', 'Internal', 'Approval', 'deadline', payStart(b)),
  ]
  // Two exist only on the complex path: they appear when a row for them was written (a document went to a person, a payment came back).
  if (b.deadlines.some((d) => d.sla === 'docReview')) out.push(mk('docReview', 'Review a document the rules can’t accept', '1 business day', 'Internal', 'Document needs review', 'deadline', docReviewStart(b)))
  if (b.deadlines.some((d) => d.sla === 'reissue')) out.push(mk('reissue', 'Reissue a returned payment', '2 business days from new bank details', 'Internal', 'New bank details', 'deadline', reissueStart(b)))
  // A recurring clock is not "met" by one letter: show the next one.
  const status = out.find((s) => s.id === 'status')!
  if (status.metOn && !status.stopped) delete status.metOn
  if (dod) {
    const items = standing(b.paymentItems)
    const interest = Math.round(items.reduce((a, i) => a + money(i.interest), 0) * 100) / 100
    const paidAt = items.length && items.every((i) => i.status === 'paid') ? items.map((i) => i.paidAt).filter((x): x is string => !!x).sort().at(-1) : undefined
    out.push({
      id: 'interest', name: 'Interest on the proceeds', rule: '3.5% a year, date of death to payment', source: 'State rule', starts: 'Date of death', start: dod, kind: 'accruing',
      note: items.length ? `${fmtMoney(interest)} interest, fixed when the payment items were made${paidAt ? '' : ` (to ${items.map((i) => i.payOn).sort()[0]})`}` : 'computed when the decision is recorded',
      metOn: paidAt ? stamp(paidAt) : undefined,
    })
  }
  return out
}

/** The review clock starts when the row is written: a business day before it is due, which is when the document went to the examiner. */
function docReviewStart(b: Bundle): string | undefined {
  const d = b.documents.filter((x) => x.status === 'under_review' || x.reviewedAt).sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))[0]
  return d ? day(d.receivedAt) : undefined
}

/** The reissue clock starts with the payee's new bank details: the replacement item's own row is written in that transaction. */
function reissueStart(b: Bundle): string | undefined {
  const r = b.deadlines.find((d) => d.sla === 'reissue')
  const wrote = b.history.find((h) => /New bank account added/i.test(h.title))
  return wrote ? day(wrote.occurredAt) : r ? day(r.originalDueAt) : undefined
}

/** The pay clock starts at approval: the decision's own time when it is in effect, the team lead's when it needed one. */
function payStart(b: Bundle): string | undefined {
  const d = b.decisions.filter((x) => x.status === 'in_effect' && x.outcome !== 'closed').sort((x, y) => x.recordedAt.localeCompare(y.recordedAt))[0]
  if (!d) return undefined
  return day(d.approvedAt ?? d.recordedAt)
}

// ---------------------------------------------------------------- Swimlane

/** Steps that talk to a system outside our own store show in the 'Outside systems' lane. */
const INSIDE = new Set(['Postgres', 'Rules', 'Product configuration', 'Temporal'])

function laneRows(b: Bundle): LaneRow[] {
  const rows: LaneRow[] = []
  const noticeAt = b.claim.noticedAt
  const caller = b.claim.parties.find((p) => p.role === 'caller')?.name ?? 'The caller'
  const intakeEvents = b.history.filter((h) => !h.workflowId && h.actorKind === 'user' && h.occurredAt === noticeAt)
  rows.push({
    id: 'notice',
    at: stamp(noticeAt),
    title: `${first(caller)} reports the death by phone`,
    cells: {
      people: [`${caller} calls; the intake person takes the notice`, ...intakeEvents.filter((e) => e.type === 'access').map((e) => e.title)],
      postgres: intakeEvents.filter((e) => e.type !== 'access').map((e) => e.title),
    },
  })

  const seen = new Map<string, number>()
  for (const r of [...b.runs].sort((x, y) => x.startedAt.localeCompare(y.startedAt))) {
    const n = (seen.get(r.workflowId) ?? 0) + 1
    seen.set(r.workflowId, n)
    const key = n > 1 ? `${r.workflowId}#${n}` : r.workflowId
    const deadline = b.deadlines.find((d) => d.workflowId === r.workflowId)
    const letters = b.letters.filter((l) => l.workflowId === r.workflowId)
    const outside = [
      ...new Set(r.steps.filter((s) => !INSIDE.has(s.system) && !s.system.startsWith('Letters') && s.system !== 'Notifications').map((s) => `${s.system}${r.steps.some((x) => x.system === s.system && x.state === 'retried') ? ' (retried)' : ''}`)),
      ...letters.map((l) => `${l.templateCode} → ${l.recipientLabel} (${l.channel === 'portal' ? 'portal invite' : l.channel})`),
    ]
    const postgres = [
      ...(deadline ? [`${shortId(deadline.id)} ${deadline.kind} came due`, 'Dispatcher marked it dispatched'] : []),
      ...r.saved,
    ]
    // What Temporal did that is worth a line: a step it ran more than once, and how it ended.
    const again = r.steps.filter((x) => (x.attempts ?? 1) > 1).map((x) => `${x.label}: ${x.attempts} attempts${x.state === 'failed' ? ', failed' : ', then done'}`)
    const wall = r.elapsedMs != null ? fmtElapsed(r.elapsedMs) : took(r.startedAt, r.finishedAt) ?? '—'
    rows.push({
      id: `run-${r.id}`,
      at: stamp(r.startedAt),
      title: deadline ? `Deadline comes due: ${deadline.what}` : `${r.name}${n > 1 ? ` (run ${n})` : ''}`,
      cells: {
        ...(outside.length ? { outside } : {}),
        ...(postgres.length ? { postgres } : {}),
        temporal: [r.workflowId, r.status === 'running' ? 'running…' : `${r.steps.length} steps · ${wall}${r.status === 'completed' ? '' : ` · ${r.status.replace('_', ' ')}`}`, ...again],
      },
      runId: key,
    })
  }

  // Batch is not a workflow: the payment run, the returns job and the nightly overdue check change payment items or write work items and events,
  // and never a claim's own state; a workflow does the claim side. They get the Batch lane (and the bank, in the Outside systems lane).
  const isBatch = (h: ApiHistoryEvent) =>
    h.actorKind === 'batch' || (!h.workflowId && h.type === 'payment' && /payment run|payment returned/i.test(h.title)) || (!h.workflowId && /^Claim closed/.test(h.title) && h.actorKind === 'system')
  const batch = b.history.filter((h) => !h.workflowId && isBatch(h))
  for (const e of batch) {
    const bank = e.type === 'payment' && /paid|payment run|returned/i.test(e.title)
    rows.push({
      id: `batch-${e.id}`,
      at: stamp(e.occurredAt),
      title: e.title,
      cells: {
        ...(bank ? { outside: [/returned/i.test(e.title) ? 'Bank (returns file)' : 'Bank (payment file)'] } : {}),
        batch: [/returned/i.test(e.title) ? 'Returns job' : /overdue/i.test(e.title) ? 'Nightly overdue check' : /^Claim closed/.test(e.title) ? 'Payment run closes the claim' : e.actor.includes('run') || /payment run/i.test(e.title) ? 'Payment run' : e.actor],
        postgres: [e.detail ? `${e.title}: ${e.detail}` : e.title],
      },
    })
  }

  // What people did: accepting or waiving a requirement writes a user event. Show what that closed in the same transaction.
  // A document arriving from the portal or the mail room is a person's act too; the workflow it starts has its own row.
  const userEvents = b.history.filter((h) => (h.actorKind === 'user' || h.actorKind === 'portal') && !h.workflowId && h.occurredAt !== noticeAt && !batch.includes(h))
  for (const e of userEvents) {
    const t = new Date(e.occurredAt).getTime()
    const near = (iso: string | null | undefined) => !!iso && Math.abs(new Date(iso).getTime() - t) < 3000
    const closed = b.deadlines.filter((d) => (d.closedBy === 'requirement' || d.closedBy === 'decision' || d.closedBy === 'user') && near(d.closedAt))
    const items = e.type === 'decision' ? b.paymentItems.filter((i) => i.decisionId && b.decisions.some((d) => d.id === i.decisionId && (near(d.recordedAt) || near(d.approvedAt)))) : []
    const proof = near(b.claim.proofCompleteAt)
    const rowsWritten = proof ? b.deadlines.filter((d) => d.kind === 'decision_due' || d.kind === 'review_target') : []
    rows.push({
      id: `user-${e.id}`,
      at: stamp(e.occurredAt),
      title: e.title,
      cells: {
        people: [`${actorLabel(e)}: ${e.title}`],
        postgres: [
          ...(e.detail ? [e.detail] : []),
          ...closed.map((d) => `${shortId(d.id)} closed without firing`),
          ...(items.length ? [`${items.length} payment items cleared · ${fmtMoney(items.reduce((a, i) => a + money(i.amount), 0))}`] : []),
          ...(proof ? ['Proof of loss complete → In review', ...rowsWritten.map((d) => `${shortId(d.id)} ${d.kind} written`)] : []),
        ],
      },
    })
  }
  // What the system wrote on its own when a decision cleared items (no workflow, no batch).
  for (const e of b.history.filter((h) => h.actorKind === 'system' && !h.workflowId && h.type === 'payment' && !batch.includes(h))) {
    rows.push({ id: `sys-${e.id}`, at: stamp(e.occurredAt), title: e.title, cells: { postgres: [e.detail ? `${e.title}: ${e.detail}` : e.title] } })
  }
  return rows.sort((x, y) => x.at.localeCompare(y.at))
}

// ---------------------------------------------------------------- The flow

const FLOW_STATUS: Record<string, LifeFlow['status']> = { received: 'gathering', gathering_evidence: 'gathering', in_review: 'inReview', awaiting_approval: 'awaitingApproval', approved: 'approved', paying: 'approved', closed: 'closed', reopened: 'reopened' }

/** The intake workflow writes 'New life claim: welcome call to <caller>'; completing it meets first_contact_by. */
export const isWelcomeCall = (action: string): boolean => /welcome call/i.test(action)

function decidedAt(b: Bundle): string | undefined {
  const d = b.decisions.filter((x) => x.status === 'in_effect' && x.outcome !== 'closed').sort((x, y) => (x.approvedAt ?? x.recordedAt).localeCompare(y.approvedAt ?? y.recordedAt))[0]
  return d ? stamp(d.approvedAt ?? d.recordedAt) : undefined
}

function paidAt(b: Bundle): string | undefined {
  const t = b.paymentItems.map((i) => i.paidAt).filter((x): x is string => !!x).sort()[0]
  return t ? stamp(t) : undefined
}

export function mapFlow(b: Bundle, now: Date, clockSource: 'virtual' | 'browser'): LifeFlow {
  const c = b.claim
  const d = c.details
  const caller = c.parties.find((p) => p.role === 'caller')?.name ?? ''
  const agent = c.parties.find((p) => p.role === 'agent_of_record')
  const base = c.benefitLines.filter((l) => l.kind === 'base')
  const rider = c.benefitLines.find((l) => l.kind === 'rider')
  const face = base.reduce((a, l) => a + money(l.amount), 0)
  const accident = d?.mannerOfDeath === 'accident'
  const deadlines = mapDeadlines(b, now)
  const runs = mapRuns(b.runs)
  const intake = b.runs.find((r) => r.type === 'orchestration' && r.status === 'completed')
  const owner = learnOwner(b)
  const st = claimStatus(c.status)
  const inFlight: string[] = []
  if (c.status === 'received') inFlight.push('The intake workflow has not finished setting the claim up')
  for (const r of b.runs.filter((x) => x.status === 'running')) inFlight.push(`${r.name} is running (${r.workflowId})`)
  for (const x of b.deadlines.filter((y) => y.state === 'dispatched')) inFlight.push(`${x.what}: ${x.workflowId ?? 'workflow'} started, not finished`)
  const due = b.deadlines.filter((x) => x.state === 'open' && KINDS_WITH_WORKFLOW.has(x.kind) && new Date(x.dueAt) <= now)
  if (due.length) inFlight.push(`${due.length} follow-up ${due.length === 1 ? 'row is' : 'rows are'} due; the dispatcher picks ${due.length === 1 ? 'it' : 'them'} up on its next tick`)

  return {
    claimId: c.claimNumber,
    insured: c.insured.name,
    noticeAt: stamp(c.noticedAt),
    dateOfDeath: d?.dateOfDeath ?? '',
    manner: d?.mannerOfDeath ?? 'natural',
    variation: 'none',
    policyRef: base[0]?.policyNumber ?? '',
    issued: '',
    paidTo: '',
    face,
    adb: rider ? { amount: money(rider.amount), payable: accident } : undefined,
    total: face + (accident && rider ? money(rider.amount) : 0),
    route: { track: c.track === 'fast_track_life' ? 'Fast track life' : 'Standard life', rule: c.routeRule ?? '', examiner: ownerName(b), examinerId: owner, reasons: c.routeReasons },
    reqs: [],
    payees: c.parties.filter((p) => p.role === 'beneficiary' && p.payee).map((p) => ({ id: p.partyId, name: p.name, share: Number.parseFloat(p.sharePercent ?? '0'), packet: p.packetChannel ?? 'portal' })),
    caller,
    consent: !!d?.agentConsent,
    agent: agent?.name ?? '',
    policiesFound: new Set(c.benefitLines.map((l) => l.policyNumber)).size,
    lapsedFound: 0,

    id: c.claimNumber,
    now: stamp(now.toISOString()),
    status: FLOW_STATUS[c.status] ?? 'gathering',
    reached: {
      notice: stamp(c.noticedAt),
      checks: intake?.finishedAt ? stamp(intake.finishedAt) : undefined,
      evidence: intake?.finishedAt ? stamp(intake.finishedAt) : undefined,
      proof: c.proofCompleteAt ? stamp(c.proofCompleteAt) : undefined,
      // Decided means in effect: a decision waiting for a team lead has not been made yet.
      decision: decidedAt(b),
      paid: paidAt(b),
      closed: c.closedAt ? stamp(c.closedAt) : undefined,
    },
    serviceLevels: serviceLevels(b, now),
    deadlines,
    runs,
    lanes: laneRows(b),
    script: [],
    done: [],
    seq: { event: 0, row: 0 },
    letters: b.letters.length,
    payDate: b.paymentItems.length ? standing(b.paymentItems).map((i) => i.payOn).sort()[0] : undefined,
    interest: b.paymentItems.length ? Math.round(standing(b.paymentItems).reduce((a, i) => a + money(i.interest), 0) * 100) / 100 : undefined,
    live: {
      statusLabel: st.label,
      statusTone: st.tone,
      inFlight,
      clockSource,
      workItems: b.workItems.map((w) => ({ id: w.id, action: w.action, why: w.why, dueOn: w.dueOn, waitingOn: w.waitingOn, section: w.section, ownerId: personaOf(w.ownerId), version: w.version, welcomeCall: isWelcomeCall(w.action) })),
    },
  }
}

/** True while something is in flight on the server, so the page should poll quickly. */
export function inFlight(b: Bundle, now: Date): boolean {
  return (
    b.claim.status === 'received' ||
    b.claim.status === 'paying' ||
    b.paymentItems.some((i) => i.status === 'in_run') ||
    b.runs.some((r) => r.status === 'running') ||
    b.deadlines.some((d) => d.state === 'dispatched' || (d.state === 'open' && KINDS_WITH_WORKFLOW.has(d.kind) && new Date(d.dueAt) <= now))
  )
}
