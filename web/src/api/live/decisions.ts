/**
 * Decisions, from the backend's records to what the Decision screen shows.
 *
 * `DecisionRecord` (the mock's locked-record view) is filled as far as the backend's Decision carries it. What it cannot carry
 * is listed here so the screen can say so rather than invent it:
 *  - `assistantNote`: the backend has no assistant, so the record shows none.
 *  - `approvals` is one line per approval: 'Monica Reyes · 9 Oct 08:00'. While the decision waits, the line says so.
 *  - `letter` is the template code the decision sends (APR-LIFE-01); the letters themselves are in Communications.
 *  - There is no readiness-check result: the checks on the live screen are derived from the requirements, the intake run and the
 *    claim's own facts, and are labelled as such.
 */
import type { DecisionRecord } from '../types'
import { fmtDate } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import type { ApiBenefitLine, ApiDecision } from './types'
import { awaitingTotal, money, type Bundle } from './present'
import { stamp } from './time'

export { awaitingTotal }

const OUTCOME: Record<ApiDecision['outcome'], DecisionRecord['outcome']> = { approved: 'approved', approved_in_part: 'approvedInPart', denied: 'denied', closed: 'closed' }

export function mapDecision(d: ApiDecision, b: Pick<Bundle, 'claim'>): DecisionRecord {
  const line = b.claim.benefitLines.find((l) => l.id === d.benefitLineId)
  const approvals: string[] = []
  if (d.status === 'awaiting_approval') approvals.push('Waiting for the team lead')
  else if (d.approvedByName) approvals.push(`${d.approvedByName} · ${d.approvedAt ? `${fmtDate(stamp(d.approvedAt).slice(0, 10))} ${stamp(d.approvedAt).slice(11)}` : 'approved'}`)
  return {
    id: d.id,
    claimId: b.claim.claimNumber,
    benefitLineId: d.benefitLineId,
    title: `${d.benefitLineName ?? line?.name ?? 'Benefit'}${line ? ` ${line.policyNumber}` : ''}`,
    version: d.version,
    recordedAt: stamp(d.recordedAt),
    recordedBy: d.recordedByName ?? 'Examiner',
    // The backend's own wording ('above $250,000 authority, awaiting approval', '... approved by Monica Reyes').
    authorityNote: d.authorityNote,
    outcome: OUTCOME[d.outcome],
    outcomeText: d.outcomeText,
    basis: d.basis,
    evidence: d.evidence ?? [],
    provisions: d.provisions ?? [],
    approvals,
    letter: d.letterTemplate ?? undefined,
  }
}

/** The decision versions of a claim as the record view shows them, newest first (a rider's closed decision comes after its base line). */
export function mapDecisions(b: Bundle): DecisionRecord[] {
  return [...b.decisions]
    .sort((x, y) => y.recordedAt.localeCompare(x.recordedAt) || (x.benefitLineId === y.benefitLineId ? 0 : b.claim.benefitLines.findIndex((l) => l.id === x.benefitLineId) - b.claim.benefitLines.findIndex((l) => l.id === y.benefitLineId)))
    .map((d) => mapDecision(d, b))
}

/** The base benefit line still to decide: the claim is in review and no decision covers it yet. */
export function lineToDecide(b: Bundle): ApiBenefitLine | undefined {
  if (b.claim.status !== 'in_review') return undefined
  return b.claim.benefitLines.find((l) => l.kind === 'base' && !b.decisions.some((d) => d.benefitLineId === l.id))
}

/** The decision waiting for a team lead, if any: the base line's (a rider is decided with it). */
export function awaitingDecision(b: Bundle): ApiDecision | undefined {
  const waiting = b.decisions.filter((d) => d.status === 'awaiting_approval')
  return waiting.find((d) => b.claim.benefitLines.find((l) => l.id === d.benefitLineId)?.kind === 'base') ?? waiting[0]
}

/** A readiness check the screen shows. Derived from records the backend holds; there is no `checks` resource. */
export interface LiveCheck { id: string; label: string; detail: string; result: 'pass' | 'fail' }

export function readinessChecks(b: Bundle): LiveCheck[] {
  const out: LiveCheck[] = []
  const reqs = b.requirements
  const open = reqs.filter((r) => r.state === 'requested' || r.state === 'received' || r.state === 'not_enough')
  out.push({
    id: 'proof',
    label: 'Proof of loss is complete',
    detail: b.claim.proofCompleteAt ? `Complete ${fmtDate(stamp(b.claim.proofCompleteAt).slice(0, 10), { year: true })}; the decision clock has been running since` : 'Not yet',
    result: b.claim.proofCompleteAt ? 'pass' : 'fail',
  })
  out.push({
    id: 'reqs',
    label: `Every requirement is met or waived (${reqs.length - open.length} of ${reqs.length})`,
    detail: open.length ? `Waiting on ${open.map((r) => r.name).join(', ')}` : reqs.map((r) => `${r.name}${r.state === 'waived' ? ' (waived)' : ''}`).join(' · '),
    result: open.length ? 'fail' : 'pass',
  })
  const intake = b.runs.find((r) => r.type === 'orchestration')
  if (intake) {
    const step = (re: RegExp) => intake.steps.find((s) => re.test(s.label))
    const inForce = step(/in force/i)
    const screen = step(/screen/i)
    const dup = step(/existing claim/i)
    for (const [id, label, s] of [['force', 'Policy in force on the date of death', inForce], ['screen', 'Beneficiaries screened', screen], ['dup', 'No duplicate claim', dup]] as const) {
      if (s) out.push({ id, label, detail: `${s.detail} · ${intake.name}`, result: intake.status === 'completed' ? 'pass' : 'fail' })
    }
  }
  const rider = b.claim.benefitLines.find((l) => l.kind === 'rider')
  if (rider) {
    const accident = b.claim.details?.mannerOfDeath === 'accident'
    out.push({
      id: 'rider',
      label: accident ? `${rider.name} pays with the base benefit` : `${rider.name} is not payable`,
      detail: accident ? `Accident: ${fmtMoney(money(rider.amount))} added, decided with the base line` : 'It pays only for an accidental death; the backend closes it with its own explanation when the base line is decided',
      result: 'pass',
    })
  }
  return out
}

/** Principal by payee (the parties who are payees, with their shares), before any interest: what the backend will split. */
export function payeeShares(b: Bundle): { partyId: string; name: string; share: number }[] {
  return b.claim.parties
    .filter((p) => p.role === 'beneficiary' && p.payee)
    .map((p) => ({ partyId: p.partyId, name: p.name, share: Number.parseFloat(p.sharePercent ?? '0') }))
}

/** A basis the examiner starts from, drafted from the record. They edit it; nothing about it is a recommendation. */
export function draftBasis(b: Bundle): string {
  const line = b.claim.benefitLines.find((l) => l.kind === 'base')
  const payees = payeeShares(b).map((p) => `${p.name} ${p.share}%`).join(' and ')
  const accident = b.claim.details?.mannerOfDeath === 'accident'
  return [
    `Proof of loss is complete and every requirement is met or waived.`,
    line ? `${line.policyNumber} was in force on the date of death.` : '',
    payees ? `Payable to ${payees} under the designation on file.` : '',
    accident ? 'The death was an accident, so the accidental death rider pays with the base benefit.' : '',
  ].filter(Boolean).join(' ')
}
