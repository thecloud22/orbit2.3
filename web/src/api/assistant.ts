/**
 * "Ask about this claim" — the staff assistant's question-and-answer endpoint.
 *
 * POST /claims/{id}/assistant/questions   GET /claims/{id}/assistant/questions
 *
 * The real service answers with a model grounded in this claim's record only, and returns the sources it used.
 * The mock answers from scripted replies for the main sample claims and, for everything else, builds the answer
 * from the live mock data — so answers change as the claim changes. Either way the rules are the same:
 * answers cite sources, the assistant can draft but never decides, and every question is logged.
 */
import { SCRIPTED } from './fixtures/assistant'
import { claims } from './claims'
import { requirements, type RequirementRecord } from './requirements'
import { documents, type DocumentRecord } from './documents'
import { payments, type PaymentRow } from './payments'
import { decisions, listWorkbenches } from './decisions'
import { history, logEvent } from './history'
import { collection, fail, newId, respond } from './store'
import { daysSince, fmtCountdown, fmtDate, nowStamp, plural } from '../lib/dates'
import { fmtMoney, sum } from '../lib/money'
import type { Claim, DecisionRecord, HistoryEvent, SectionKey, Workbench } from './types'

export interface AssistantSource {
  label: string
  section?: SectionKey
  target?: string
}

/** Something the assistant offers to do. Clicking it is the person's choice; nothing happens on its own. */
export interface AssistantAction {
  label: string
  kind: 'open' | 'task' | 'note'
  section?: SectionKey
  target?: string
  /** Task title or note text. */
  text?: string
}

export interface AnswerBody {
  paragraphs: string[]
  bullets?: string[]
  after?: string[]
  sources: AssistantSource[]
  actions?: AssistantAction[]
  followUps?: string[]
  /** declined = asked for a recommendation on the outcome; unknown = not in the record. */
  kind?: 'answer' | 'declined' | 'unknown'
}

export interface AssistantTurn extends AnswerBody {
  id: string
  claimId: string
  question: string
  askedAt: string
  askedBy: string
  kind: 'answer' | 'declined' | 'unknown'
  /** What the answer was read from, e.g. '9 requirements · 26 documents'. */
  basedOn: string
}

/** Everything an answer may read — the claim record, never other claims. */
export interface AskContext {
  claim: Claim
  requirements: RequirementRecord[]
  documents: DocumentRecord[]
  payments: PaymentRow[]
  decisions: DecisionRecord[]
  workbenches: Workbench[]
  history: HistoryEvent[]
}

const turns = collection<AssistantTurn>([])

/** GET — this claim's conversation, oldest first. */
export function listTurns(claimId: string): Promise<AssistantTurn[]> {
  return respond(turns.where((t) => t.claimId === claimId), 0)
}

/** Suggested first questions: the claim's scripted ones, then the ones every claim can answer. */
export function starterQuestions(claimId: string): string[] {
  const own = (SCRIPTED[claimId] ?? []).filter((s) => s.starter).map((s) => s.starter!)
  return [...own, 'What’s still outstanding?', 'What happened in the last 30 days?'].slice(0, 4)
}

export function clearTurns(claimId: string, by: string): void {
  turns.where((t) => t.claimId === claimId).forEach((t) => turns.remove(t.id))
  logEvent(claimId, { type: 'assistant', title: 'Assistant conversation cleared', actor: by })
}

/** POST — answer a question about one claim. Slow on purpose: the real call reads the record first. */
export async function askAssistant(claimId: string, question: string, by: string): Promise<AssistantTurn> {
  const claim = claims.get(claimId)
  const q = question.trim()
  if (!claim) return fail('Claim not found')
  if (!q) return fail('Ask a question about this claim')

  const ctx: AskContext = {
    claim,
    requirements: requirements.where((r) => r.claimId === claimId),
    documents: documents.where((d) => d.claimId === claimId),
    payments: payments.where((p) => p.claimId === claimId),
    decisions: decisions.where((d) => d.claimId === claimId),
    workbenches: await listWorkbenches(claimId),
    history: history.where((h) => h.claimId === claimId).sort((a, b) => b.at.localeCompare(a.at)),
  }
  const body = answer(q.toLowerCase(), ctx)
  const turn: AssistantTurn = {
    ...body,
    kind: body.kind ?? 'answer',
    id: newId('ask'),
    claimId,
    question: q,
    askedAt: nowStamp(),
    askedBy: by,
    basedOn: [plural(ctx.requirements.length, 'requirement'), plural(ctx.documents.length, 'document'), plural(ctx.history.length, 'history event')].join(' · '),
  }
  turns.insert(turn)
  logEvent(claimId, {
    type: 'assistant',
    title: turn.kind === 'declined' ? `Assistant declined: “${q}”` : `Assistant answered: “${q}”`,
    actor: `${by} · asked the assistant`,
    detail: turn.kind === 'declined' ? 'Asked for an outcome recommendation; none given' : `Sources: ${turn.sources.map((s) => s.label).join(', ') || 'none'}`,
  })
  return respond(turn, 650)
}

// ------------------------------------------------------------------------------------------------ answering

const DECIDE = /should (i|we) (approve|deny|pay|decline|reject|close)|recommend|approve or deny|is (this|it|he|she) (fraud|lying)|what would you decide|make the decision|decide for me/
const OUTSTANDING = /outstanding|missing|still need|waiting|what.*(need|left)|open requirement|pending|chase/
const NEXT = /next|what should i do|to.?do|priorit|where do i start/
const CLOCKS = /deadline|due|clock|sla|how long|breach|late|timeline|when/
const PAYMENTS = /paid|payment|money|eft|cheque|check|how much/
const PEOPLE = /who|beneficiar|people|contact|agent|doctor|physician/
const DECISION = /decision|decided|approved|denied|outcome|ready|block|fast.?track/
const RECENT = /recent|last (30|thirty) days|history|happened|so far|lately|this week/
const DOCS = /document|new doc|received|upload/
const DRAFT = /draft|write|letter|email|reply|respond/
const SUMMARY = /summar|overview|brief|tell me about|what is this|explain the claim/

function answer(q: string, ctx: AskContext): AnswerBody {
  if (DECIDE.test(q)) return declined(ctx)
  const scripted = (SCRIPTED[ctx.claim.id] ?? []).find((s) => s.match.test(q))
  if (scripted) return scripted.answer(ctx)
  if (OUTSTANDING.test(q)) return outstanding(ctx)
  if (DECISION.test(q)) return decisionStatus(ctx)
  if (CLOCKS.test(q)) return clocks(ctx)
  if (PAYMENTS.test(q)) return money(ctx)
  if (RECENT.test(q)) return recent(ctx)
  if (DOCS.test(q)) return docs(ctx)
  if (DRAFT.test(q)) return draft(ctx)
  if (NEXT.test(q)) return next(ctx)
  if (PEOPLE.test(q)) return people(ctx)
  if (SUMMARY.test(q)) return summary(ctx)
  return unknown(ctx)
}

function declined(ctx: AskContext): AnswerBody {
  const wb = ctx.workbenches[0]
  const passed = wb ? wb.checks.filter((c) => c.result === 'pass').length : 0
  return {
    kind: 'declined',
    paragraphs: ['I don’t recommend outcomes. The decision stays with you, based on the readiness checks, the policy provisions and your authority.'],
    bullets: wb
      ? [`${wb.title} ${wb.ref}: ${passed} of ${wb.checks.length} readiness checks pass.`, ...wb.checks.filter((c) => c.result !== 'pass').map((c) => `${c.label} — ${c.detail}`)]
      : ctx.decisions.length
        ? [`Already decided: ${ctx.decisions.map((d) => `${d.title} (${d.outcomeText.split(' · ')[0].toLowerCase()})`).join('; ')}.`]
        : [],
    sources: [{ label: 'Decision workbench', section: 'decision' }],
    actions: [{ kind: 'open', label: 'Open Decision', section: 'decision' }],
    followUps: ['What’s still outstanding?'],
  }
}

function outstanding(ctx: AskContext): AnswerBody {
  const open = ctx.requirements.filter((r) => r.state !== 'met' && r.state !== 'waived')
  if (!ctx.requirements.length) return unknown(ctx, 'No requirements are recorded for this claim in the mock.')
  if (!open.length)
    return {
      paragraphs: [`Nothing is outstanding: all ${ctx.requirements.length} requirements are met or waived.`],
      sources: [{ label: 'Requirements', section: 'requirements' }],
      followUps: ['What happens next?'],
    }
  return {
    paragraphs: [`${plural(open.length, 'requirement')} of ${ctx.requirements.length} still open:`],
    bullets: open.map((r) => `${r.name} — from ${r.from} · ${r.status.label.toLowerCase()}${r.due ? ` · due ${fmtDate(r.due)} (${fmtCountdown(r.due)})` : ''}`),
    sources: open.slice(0, 3).map((r) => ({ label: r.name, section: 'requirements' as const, target: r.id })),
    actions: [{ kind: 'open', label: 'Open Requirements', section: 'requirements', target: open[0].id }],
    followUps: ['What are the deadlines?'],
  }
}

function clocks(ctx: AskContext): AnswerBody {
  const c = ctx.claim
  const lines = c.clocks.map((k) => {
    if (k.state === 'met') return `${k.label} — met`
    if (k.kind === 'accruing' && k.start) return `${k.label} — running ${plural(daysSince(k.start), 'day')}`
    return `${k.label} — ${k.valueText ?? (k.due ? `${fmtDate(k.due)}, ${fmtCountdown(k.due)}` : '')}${k.state !== 'running' ? ` (${k.state})` : ''}`
  })
  const late = ctx.requirements.filter((r) => r.state === 'overdue')
  return {
    paragraphs: [lines.length ? 'The clocks on this claim:' : 'No regulatory clocks are running on this claim.'],
    bullets: [...lines, ...late.map((r) => `${r.name} is overdue${r.due ? ` — was due ${fmtDate(r.due)}` : ''}`)],
    after: c.exceptions.some((x) => x.status === 'open') ? [`Open exceptions: ${c.exceptions.filter((x) => x.status === 'open').map((x) => x.title.toLowerCase()).join('; ')}.`] : undefined,
    sources: [{ label: 'Claim clocks', section: 'overview' }, ...(late.length ? [{ label: 'Requirements', section: 'requirements' as const }] : [])],
    followUps: ['What’s still outstanding?'],
  }
}

function money(ctx: AskContext): AnswerBody {
  const paid = ctx.payments.filter((p) => p.status.tone === 'positive')
  const other = ctx.payments.filter((p) => p.status.tone !== 'positive')
  if (!ctx.payments.length)
    return {
      paragraphs: ['Nothing has been paid or scheduled. Payments are scheduled when a decision is recorded.'],
      sources: [{ label: 'Payments', section: 'payments' }],
      actions: ctx.workbenches.length ? [{ kind: 'open', label: 'Open Decision', section: 'decision' }] : undefined,
    }
  return {
    paragraphs: [paid.length ? `${fmtMoney(sum(paid.map((p) => p.amount)))} paid in ${plural(paid.length, 'payment')}.` : 'Nothing has been paid yet.'],
    bullets: other.slice(0, 5).map((p) => `${p.payee} — ${fmtMoney(p.amount)} · ${p.status.label.toLowerCase()} · ${fmtDate(p.payDate)}`),
    sources: [{ label: 'Payments', section: 'payments' }],
    actions: [{ kind: 'open', label: 'Open Payments', section: 'payments' }],
  }
}

function decisionStatus(ctx: AskContext): AnswerBody {
  const bullets = [
    ...ctx.decisions.map((d) => `${d.title}: ${d.outcomeText} — v${d.version}, ${fmtDate(d.recordedAt)}, ${d.recordedBy}`),
    ...ctx.workbenches.map((w) => {
      const blocked = w.checks.find((c) => c.result === 'blocked')
      const passed = w.checks.filter((c) => c.result === 'pass').length
      return blocked ? `${w.title} ${w.ref}: can’t be decided yet — ${blocked.detail}` : `${w.title} ${w.ref}: ready to decide, ${passed} of ${w.checks.length} checks pass`
    }),
  ]
  return {
    paragraphs: [bullets.length ? 'Where each benefit line stands:' : 'No benefit line on this claim is ready for a decision yet.'],
    bullets: bullets.length ? bullets : ctx.claim.benefitLines.map((b) => `${b.name}: ${b.status.label.toLowerCase()}`),
    sources: [{ label: 'Decision', section: 'decision' }],
    actions: [{ kind: 'open', label: 'Open Decision', section: 'decision' }],
  }
}

function recent(ctx: AskContext): AnswerBody {
  const events = ctx.history.filter((h) => daysSince(h.at) <= 30).slice(0, 7)
  if (!events.length) return unknown(ctx, 'Nothing has been recorded on this claim in the last 30 days.')
  return {
    paragraphs: [`${plural(ctx.history.filter((h) => daysSince(h.at) <= 30).length, 'event')} in the last 30 days. The most recent:`],
    bullets: events.map((h) => `${fmtDate(h.at)} — ${h.title}`),
    sources: [{ label: 'History', section: 'history' }],
    actions: [{ kind: 'open', label: 'Open History', section: 'history' }],
  }
}

function docs(ctx: AskContext): AnswerBody {
  const fresh = ctx.documents.filter((d) => d.isNew)
  const latest = [...ctx.documents].sort((a, b) => b.received.localeCompare(a.received)).slice(0, 5)
  return {
    paragraphs: [`${plural(ctx.documents.length, 'document')} on file${fresh.length ? `, ${fresh.length} new and not yet reviewed` : ''}. The latest:`],
    bullets: latest.map((d) => `${d.title} — ${fmtDate(d.received)} · ${d.status.label.toLowerCase()}`),
    sources: [{ label: 'Documents', section: 'documents' }],
    actions: fresh.length ? [{ kind: 'open', label: `Review ${fresh[0].title}`, section: 'documents', target: fresh[0].id }] : [{ kind: 'open', label: 'Open Documents', section: 'documents' }],
  }
}

function draft(ctx: AskContext): AnswerBody {
  return {
    paragraphs: ['Letters are drafted from approved templates in Communications, so the wording, merge fields and required notices stay right. I can open the composer; you edit and send.'],
    sources: [{ label: 'Communications', section: 'communications' }],
    actions: [{ kind: 'open', label: `Open the composer — letter to ${firstContact(ctx)}`, section: 'communications' }],
  }
}

function next(ctx: AskContext): AnswerBody {
  const n = ctx.claim.nextStep
  const open = ctx.claim.exceptions.filter((x) => x.status === 'open')
  return {
    paragraphs: [`Next step: ${n.label.toLowerCase()} — ${n.reason.charAt(0).toLowerCase()}${n.reason.slice(1)}.`],
    bullets: open.map((x) => `Exception: ${x.title} — ${x.meta}`),
    after: ['It’s chosen from the clocks, open requirements, new evidence and rules — the same logic that orders your queue.'],
    sources: [{ label: 'Claim header', section: 'overview' }],
    actions: [{ kind: 'open', label: n.label, section: n.section, target: n.target }],
  }
}

function people(ctx: AskContext): AnswerBody {
  return {
    paragraphs: [`${plural(ctx.claim.parties.length, 'person', 'people')} and organisations on this claim:`],
    bullets: ctx.claim.parties.map((p) => `${p.name} — ${p.roles.join(', ').toLowerCase()}${p.relationship ? `, ${p.relationship.toLowerCase()}` : ''}${p.share ? `, ${p.share}` : ''}${p.status ? ` · ${p.status.label.toLowerCase()}` : ''}`),
    sources: [{ label: 'People & roles', section: 'people' }],
  }
}

function summary(ctx: AskContext): AnswerBody {
  return {
    paragraphs: [ctx.claim.summary.text],
    bullets: ctx.claim.benefitLines.map((b) => `${b.name} ${b.ref}: ${b.status.label.toLowerCase()}`),
    sources: ctx.claim.summary.sources.map((s) => ({ label: s, section: 'documents' as const })),
    followUps: ['What’s still outstanding?', 'What are the deadlines?'],
  }
}

function unknown(ctx: AskContext, why?: string): AnswerBody {
  return {
    kind: 'unknown',
    paragraphs: [why ?? 'I couldn’t find that in this claim’s record. I answer only from this claim — its requirements, documents, decisions, payments, clocks, people and history.'],
    sources: [],
    followUps: starterQuestions(ctx.claim.id).slice(0, 2),
  }
}

function firstContact(ctx: AskContext): string {
  const p = ctx.claim.parties.find((x) => x.roles.includes('Claimant')) ?? ctx.claim.parties.find((x) => x.roles.includes('Beneficiary'))
  return p ? p.name.split(' ')[0] : 'the claimant'
}
