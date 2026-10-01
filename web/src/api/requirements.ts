import { REQUIREMENTS, REQUIREMENT_CONTEXT } from './fixtures/requirements'
import { collection, fail, newId, respond } from './store'
import { claims, resolveException, setNextStep, patchClaim } from './claims'
import { addCommunication } from './communications'
import { logEvent } from './history'
import { addTask } from './tasks'
import { completeWork, workItems } from './work'
import { TODAY, addDays, fmtDate } from '../lib/dates'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import type { Channel, ISODate, Requirement, Status } from './types'

/*
 * Requirements — the evidence a claim waits on, who has the ball, and how it is chased.
 * The extra fields below extend the contract's Requirement; they belong in contracts/openapi.yaml
 * as the requirement detail resource (GET /claims/{id}/requirements/{rid}).
 */

/** What an action on a requirement counts as, for closing the work item it came from. */
export type RequirementAct = 'call' | 'reminder' | 'alternative' | 'met'

/** One step of the follow-up plan: what happened, what happens today, what is scheduled. */
export interface PlanStep {
  date: ISODate
  label: string
  note?: string
  state: 'done' | 'current' | 'todo' | 'skipped'
  /** The action behind a current step — run from the timeline. */
  act?: 'call' | 'reminder' | 'alternative'
  /** Index into alternatives when act is 'alternative'. */
  alt?: number
}

/** Another route to the same evidence. */
export interface AltRoute {
  title: string
  note?: string
  /** Button label: 'Resend', 'Plan review', 'Open script'. */
  action: string
  /** message = something is sent · task = creates a task · script = opens the call script · approve = accept the alternative (team lead). */
  kind: 'message' | 'task' | 'script' | 'approve'
  to?: string
  channel?: Channel
  /** The communication title, or the task title. */
  text?: string
  done?: string
}

export interface RequirementRecord extends Requirement {
  /** Short party label for the Waiting-on strip: 'Dr. Hsu’s office'. */
  waitingOn?: string
  /** Contact lines under From in the detail panel. */
  contact?: string[]
  /** 'fax, portal' or 'Automatic'. */
  requestedVia?: string
  /** Replaces the countdown under the due date: 'vendor ETA'. */
  dueNote?: string
  /** How reminders go: fax, portal, email, letter. */
  reminderVia?: string
  plan?: PlanStep[]
  alternatives?: AltRoute[]
  script?: string[]
  /** What someone should do next on this requirement, if anything today. Drives the claim's next step. */
  nextAction?: { label: string; reason: string }
  /** The claim exception this requirement keeps open. */
  exceptionId?: string
  /** The work item this requirement puts in someone's queue, and which acts complete it. */
  workItem?: { action: string; doneBy: RequirementAct[] }
  receivedOn?: ISODate
  waiveReason?: string
  /** Documents that satisfy it, for the detail panel. */
  documentIds?: string[]
  /** Live mode: the backend's own state and version (the ETag for accept and waive). */
  live?: {
    state: string
    version: number
    key: string
    followUpCount: number
    satisfiedBy?: string
    /** What the last change did, in words, for the toast. */
    note?: string
    /** The backend's own reason for the state: 'TIN mismatch', 'Under review: photocopy', 'Rejected: ...'. */
    stateNote?: string
    /** Every document that arrived for it, oldest first (from GET /claims/{id}/documents). */
    documents?: { id: string; title: string; status: Status; note?: string; at: string; source: string; underReview: boolean }[]
  }
}

/** Claim-level context for the requirements page: who needs the evidence, and the status-letter count. */
export interface RequirementContext {
  initials?: string
  text: string
  /** Number of the next state status letter, when the claim is pending under a 30-day rule. */
  nextLetter?: number
  /** Next letter date when the claim has no status-letter clock. */
  nextLetterDue?: ISODate
}

export const requirements = collection<RequirementRecord>(REQUIREMENTS)

export function isOpen(r: Pick<Requirement, 'state'>): boolean {
  return r.state !== 'met' && r.state !== 'waived'
}

/** GET /claims/{id}/requirements */
export function listRequirements(claimId: string): Promise<RequirementRecord[]> {
  if (isLiveId(claimId)) return live.getRequirements(claimId)
  return respond(requirements.where((r) => r.claimId === claimId))
}

/** GET /claims/{id}/requirements/context */
export function getRequirementContext(claimId: string): Promise<RequirementContext | null> {
  if (isLiveId(claimId)) return respond(null)
  return respond(REQUIREMENT_CONTEXT[claimId] ?? null)
}

const day = (iso: string = TODAY) => fmtDate(iso)
const CHANNEL: Record<string, Channel> = { portal: 'portal', email: 'email', fax: 'letter', letter: 'letter', phone: 'call' }

// ---------------------------------------------------------------- ripple effects

/** Closes the work item a requirement put in the queue, when this act is the one it was waiting for. */
function closeWork(r: RequirementRecord, act: RequirementAct): void {
  if (!r.workItem || !r.workItem.doneBy.includes(act)) return
  // A shared item (one request covering two requirements) closes on 'met' only when all of them are in.
  if (act === 'met') {
    const siblings = requirements.where((x) => x.claimId === r.claimId && x.workItem?.action === r.workItem?.action)
    if (siblings.some(isOpen)) return
  }
  const open = workItems.where((w) => w.claimId === r.claimId && w.status === 'open' && w.section === 'requirements')
  const mine = open.filter((w) => w.action === r.workItem?.action)
  if (mine.length === 0) return
  if (mine.length === open.length) completeWork(r.claimId, 'requirements')
  else mine.forEach((w) => workItems.update(w.id, { status: 'done' }))
}

const RANK: Record<Requirement['state'], number> = { overdue: 0, open: 1, inProgress: 2, met: 9, waived: 9 }

/** Re-points the claim's next step when it pointed at requirements. Leaves other next steps alone. */
function refreshNextStep(claimId: string): void {
  const c = claims.get(claimId)
  if (!c || c.nextStep.section !== 'requirements') return
  const open = requirements
    .where((r) => r.claimId === claimId && isOpen(r))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || (a.due ?? '9').localeCompare(b.due ?? '9'))
  const actionable = open.find((r) => r.nextAction)
  if (actionable?.nextAction) {
    setNextStep(claimId, { ...actionable.nextAction, section: 'requirements', target: actionable.id })
    return
  }
  const waiting = open[0]
  if (waiting) {
    const next = waiting.plan?.find((s) => s.state === 'todo' || s.state === 'current')
    setNextStep(claimId, {
      label: next ? `Check back ${day(next.date)}` : 'Check requirements',
      reason: `Waiting on ${waiting.waitingOn ?? waiting.from} · ${waiting.name}`,
      section: 'requirements',
      target: waiting.id,
    })
    return
  }
  setNextStep(claimId, {
    label: c.family === 'disability' ? 'Decide benefit' : 'Record decision',
    reason: 'All requirements met',
    section: 'decision',
  })
}

/** After a requirement is met or waived: resolve its exception once nothing else holds it open. */
function afterClosed(r: RequirementRecord, by: string): void {
  if (r.exceptionId) {
    const c = claims.get(r.claimId)
    const x = c?.exceptions.find((e) => e.id === r.exceptionId && e.status === 'open')
    const holders = requirements.where((o) => o.claimId === r.claimId && o.exceptionId === r.exceptionId && isOpen(o))
    if (x && holders.length === 0) void resolveException(r.claimId, x.id, by)
  }
  closeWork(r, 'met')
  refreshNextStep(r.claimId)
}

/** Replaces today's current step with what was done, and appends the next scheduled step. */
function advancePlan(plan: PlanStep[] | undefined, done: PlanStep, next?: PlanStep): PlanStep[] {
  const steps = (plan ?? []).filter((s) => !(s.state === 'current' && s.date === TODAY))
  const out = [...steps, done, ...(next ? [next] : [])]
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.state === 'done' ? -1 : 1))
}

/** Closes the plan: what happened stays, the closing step follows, and anything still scheduled is marked not needed. */
function closePlan(plan: PlanStep[] | undefined, step: PlanStep): PlanStep[] {
  const steps = plan ?? []
  return [
    ...steps.filter((s) => s.state === 'done'),
    step,
    ...steps.filter((s) => s.state !== 'done').map((s) => ({ ...s, state: 'skipped' as const })),
  ]
}

function updateExceptionMeta(r: RequirementRecord, meta: string): void {
  if (!r.exceptionId) return
  patchClaim(r.claimId, (c) => ({ exceptions: c.exceptions.map((x) => (x.id === r.exceptionId && x.status === 'open' ? { ...x, meta } : x)) }))
}

// ---------------------------------------------------------------- actions

/** POST /requirements/{id}:remind — sends a reminder the way the requirement was requested. */
export function sendReminder(id: string, by: string): Promise<RequirementRecord> {
  const r = requirements.get(id)
  if (!r) return fail('Requirement not found')
  if (!isOpen(r)) return fail('This requirement is already closed')
  const via = r.reminderVia ?? 'portal'
  addCommunication({
    claimId: r.claimId,
    channel: CHANNEL[via] ?? 'letter',
    direction: 'out',
    title: `Reminder: ${r.name}`,
    party: `${r.from} · ${via}`,
    detail: `Reminder ${r.followUps.length + 1} — ${r.name}${r.due ? `, due ${day(r.due)}` : ''}. Sent by ${by}.`,
    status: { label: 'Sent', tone: 'neutral' },
  })
  logEvent(r.claimId, { type: 'communication', title: `Reminder sent: ${r.name}`, actor: by, detail: `To ${r.from} by ${via}`, ref: r.name })
  const follow = addDays(TODAY, 7)
  const updated = requirements.update(id, (x) => ({
    followUps: [...x.followUps, `${via} ${day()}`],
    nextAction: x.plan?.some((s) => s.state === 'current' && s.act === 'reminder') ? undefined : x.nextAction,
    plan: advancePlan(
      x.plan,
      { date: TODAY, label: `Reminder sent by ${via}`, note: by, state: 'done' },
      x.plan?.some((s) => s.date === follow) ? undefined : { date: follow, label: 'Check it arrived; call if not', state: 'todo' },
    ),
  }))!
  closeWork(updated, 'reminder')
  refreshNextStep(r.claimId)
  return respond(updated)
}

/** Bulk reminders — one communication per requirement, each logged. */
export async function sendReminders(ids: string[], by: string): Promise<number> {
  for (const id of ids) await sendReminder(id, by)
  return ids.length
}

export interface CallOutcome {
  spokeWith: string
  outcome: string
  note?: string
  followUp: ISODate
}

/** POST /requirements/{id}/calls — logs a follow-up call and schedules the next check. */
export function logCallOutcome(id: string, call: CallOutcome, by: string): Promise<RequirementRecord> {
  const r = requirements.get(id)
  if (!r) return fail('Requirement not found')
  const detail = `${call.outcome}${call.note ? ` — ${call.note}` : ''}`
  addCommunication({
    claimId: r.claimId,
    channel: 'call',
    direction: 'out',
    title: `Call to ${r.waitingOn ?? r.from}`,
    party: `${call.spokeWith} · phone`,
    detail: `${r.name}: ${detail}`,
    status: { label: 'Logged', tone: 'neutral' },
  })
  logEvent(r.claimId, { type: 'communication', title: `Call logged: ${r.name}`, actor: by, detail: `Spoke with ${call.spokeWith}. ${detail}`, ref: r.name })
  const updated = requirements.update(id, (x) => ({
    followUps: [...x.followUps, `call ${day()}`],
    nextAction: undefined,
    plan: advancePlan(
      x.plan,
      { date: TODAY, label: `Phoned ${x.waitingOn ?? x.from}`, note: call.outcome, state: 'done' },
      { date: call.followUp, label: 'Check it arrived; call again if not', state: 'todo' },
    ),
  }))!
  updateExceptionMeta(updated, call.outcome)
  closeWork(updated, 'call')
  refreshNextStep(r.claimId)
  return respond(updated)
}

/** POST /requirements/{id}:receive — marks it met by hand (paper that came in outside intake). */
export function markReceived(id: string, via: string, by: string): Promise<RequirementRecord> {
  const r = requirements.get(id)
  // Live mode: the backend calls it accepting the requirement (POST /requirements/{id}:accept).
  if (!r && live.claimOfRequirement(id)) return live.acceptRequirement(live.claimOfRequirement(id)!, id, `Received by ${via} · accepted by ${by}`)
  if (!r) return fail('Requirement not found')
  const updated = requirements.update(id, (x) => ({
    state: 'met',
    status: { label: `Received ${day()}`, tone: 'positive' } satisfies Status,
    receivedOn: TODAY,
    nextAction: undefined,
    plan: closePlan(x.plan, { date: TODAY, label: `Received by ${via}`, note: `marked by ${by}`, state: 'done' }),
  }))!
  logEvent(r.claimId, { type: 'data', title: `Requirement met: ${r.name}`, actor: by, detail: `Received by ${via}`, ref: r.name })
  afterClosed(updated, by)
  return respond(updated)
}

/** Used by document review: the accepted document satisfies the requirement. */
export function satisfyRequirement(id: string, docTitle: string, by: string): void {
  const r = requirements.get(id)
  if (!r) return
  const wasOpen = isOpen(r)
  const updated = requirements.update(id, (x) => ({
    state: 'met',
    status: { label: `Accepted ${day()}`, tone: 'positive' } satisfies Status,
    receivedOn: x.receivedOn ?? TODAY,
    nextAction: undefined,
    plan: wasOpen
      ? closePlan(x.plan, { date: TODAY, label: `Satisfied by ${docTitle}`, state: 'done' })
      : x.plan,
  }))!
  logEvent(r.claimId, { type: 'data', title: `Requirement satisfied: ${r.name}`, actor: by, detail: `By accepted document: ${docTitle}`, ref: docTitle })
  if (wasOpen) afterClosed(updated, by)
}

export const WAIVE_REASONS = [
  'Evidence already on file covers it',
  'Not needed for this benefit',
  'Alternative evidence accepted',
  'Unobtainable — documented attempts',
] as const

/** POST /requirements/{id}:waive — needs a reason; the status letter stops listing it. */
export function waiveRequirement(id: string, reason: string, by: string): Promise<RequirementRecord> {
  const r = requirements.get(id)
  if (!r && live.claimOfRequirement(id)) return live.waiveRequirement(live.claimOfRequirement(id)!, id, `${reason} (${by})`)
  if (!r) return fail('Requirement not found')
  if (!reason.trim()) return fail('A reason is required to waive a requirement')
  const updated = requirements.update(id, (x) => ({
    state: 'waived',
    status: { label: `Waived ${day()}`, tone: 'neutral' } satisfies Status,
    waiveReason: reason,
    nextAction: undefined,
    plan: closePlan(x.plan, { date: TODAY, label: 'Waived', note: reason, state: 'done' }),
  }))!
  logEvent(r.claimId, { type: 'data', title: `Requirement waived: ${r.name}`, actor: by, detail: reason, ref: r.name })
  afterClosed(updated, by)
  return respond(updated)
}

/** Runs one of the "other ways to get it". Scripts open in the screen; the rest are sent or tasked here. */
export function runAlternative(id: string, index: number, by: string): Promise<string> {
  const r = requirements.get(id)
  const a = r?.alternatives?.[index]
  if (!r || !a) return fail('Option not found')
  let message = ''
  if (a.kind === 'message') {
    addCommunication({
      claimId: r.claimId,
      channel: a.channel ?? 'portal',
      direction: 'out',
      title: a.text ?? `${a.title}: ${r.name}`,
      party: `${a.to ?? r.from} · ${a.channel ?? 'portal'}`,
      detail: `${r.name}${r.due ? ` · due ${day(r.due)}` : ''}. Sent by ${by}.`,
      status: { label: 'Sent', tone: 'neutral' },
    })
    logEvent(r.claimId, { type: 'communication', title: a.text ?? `${a.title}: ${r.name}`, actor: by, detail: `To ${a.to ?? r.from}`, ref: r.name })
    message = `Sent to ${a.to ?? r.from}`
  } else if (a.kind === 'task') {
    addTask(r.claimId, a.text ?? a.title, by, `Requirement: ${r.name}`, addDays(TODAY, 3))
    logEvent(r.claimId, { type: 'task', title: `Task created: ${a.text ?? a.title}`, actor: by, ref: r.name })
    message = 'Task added'
  } else if (a.kind === 'approve') {
    logEvent(r.claimId, { type: 'decision', title: `Alternative approved: ${a.title}`, actor: by, detail: r.name, ref: r.name })
    requirements.update(id, { state: 'met', status: { label: `Met · alternative ${day()}`, tone: 'positive' }, nextAction: undefined })
    afterClosed(requirements.get(id)!, by)
    message = 'Alternative approved; requirement met'
  }
  if (a.kind === 'script') return respond('')
  const done = `${a.kind === 'task' ? 'task added' : a.kind === 'approve' ? 'approved' : 'sent'} ${day()}`
  // One request can cover several requirements (the accountant sends the return and the P&L together).
  const covered = a.text
    ? requirements.where((x) => x.claimId === r.claimId && isOpen(x) && !!x.alternatives?.some((o) => o.text === a.text))
    : [r]
  let updated = r
  for (const target of covered.length ? covered : [r]) {
    const idx = target.id === id ? index : target.alternatives!.findIndex((o) => o.text === a.text)
    const isToday = !!target.plan?.some((s) => s.state === 'current' && s.act === 'alternative' && s.alt === idx)
    const u = requirements.update(target.id, (x) => ({
      alternatives: x.alternatives?.map((o, i) => (i === idx ? { ...o, done } : o)),
      nextAction: isToday ? undefined : x.nextAction,
      plan: a.kind === 'approve' || !isToday ? x.plan : advancePlan(x.plan, { date: TODAY, label: a.title, note: `${done} · ${by}`, state: 'done' }),
    }))!
    if (target.id === id) updated = u
    if (a.kind !== 'approve') closeWork(u, 'alternative')
  }
  if (covered.length > 1) message += ` · covers ${covered.length} requirements`
  refreshNextStep(r.claimId)
  return respond(message ? message : updated.name)
}

export interface NewRequirement {
  name: string
  purpose: string
  from: string
  benefitLineId?: string
  due: ISODate
  via: string
  send: boolean
  note?: string
}

/** POST /claims/{id}/requirements — adds a requirement and, if asked, sends the request now. */
export function addRequirement(claimId: string, input: NewRequirement, by: string): Promise<RequirementRecord> {
  if (!input.name.trim() || !input.from.trim()) return fail('Name and source are required')
  const r: RequirementRecord = {
    id: newId('req'),
    claimId,
    name: input.name.trim(),
    note: input.note?.trim() || undefined,
    purpose: input.purpose.trim() || 'Proof of claim',
    from: input.from.trim(),
    status: input.send ? { label: 'Requested', tone: 'neutral' } : { label: 'Not yet requested', tone: 'neutral' },
    state: 'open',
    requested: input.send ? TODAY : undefined,
    requestedVia: input.send ? input.via : undefined,
    reminderVia: input.via,
    followUps: [],
    due: input.due,
    benefitLineId: input.benefitLineId || undefined,
    plan: [
      ...(input.send ? [{ date: TODAY, label: `Requested by ${input.via}`, note: by, state: 'done' as const }] : []),
      { date: addDays(input.due, -7), label: 'Automatic reminder', state: 'todo' },
      { date: input.due, label: 'Due — call if still missing', state: 'todo' },
    ],
  }
  requirements.insert(r)
  logEvent(claimId, { type: 'data', title: `Requirement added: ${r.name}`, actor: by, detail: `From ${r.from} · due ${day(r.due!)}`, ref: r.name })
  if (input.send) {
    addCommunication({
      claimId,
      channel: CHANNEL[input.via] ?? 'letter',
      direction: 'out',
      title: `Request: ${r.name}`,
      party: `${r.from} · ${input.via}`,
      detail: `${r.name} requested, due ${day(r.due!)}.`,
      status: { label: 'Sent', tone: 'neutral' },
    })
  }
  return respond(r)
}
