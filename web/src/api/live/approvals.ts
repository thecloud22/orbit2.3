/** The team lead's approvals for a live claim: a decision that is awaiting approval, shaped as the Team board's `Approval` row. */
import type { Approval } from '../team'
import { fmtMoney } from '../../lib/money'
import { TODAY } from '../../lib/dates'
import type { AwaitingApproval } from './data'
import { liveNow } from './clock'
import { money } from './present'
import { limitOf, staffById } from './staff'
import { day } from './time'

export function toApproval(a: AwaitingApproval): Approval {
  const d = a.decision
  const line = a.claim.benefitLines.find((l) => l.id === d.benefitLineId)
  const recorder = staffById(d.recordedBy)
  const limit = limitOf(recorder)
  // The base line and the riders decided with it are approved together: the amount is all of them.
  const parts = [d, ...a.related].filter((x) => x.amount)
  const amount = parts.length ? Math.round(parts.reduce((t, x) => t + money(x.amount!), 0) * 100) / 100 : undefined
  const waited = Math.max(0, Math.round((liveNow().getTime() - Date.parse(d.recordedAt)) / 3_600_000))
  return {
    id: a.workItem?.id ?? d.id,
    claimId: a.claimNumber,
    claimName: a.claim.insured.name,
    product: line?.name ?? a.claim.productCode,
    family: 'life',
    benefitLineId: d.benefitLineId,
    lineName: d.benefitLineName ?? line?.name ?? 'Benefit',
    ref: line?.policyNumber ?? '',
    kind: 'payout',
    type: 'Payout above authority',
    requester: { id: recorder?.handle ?? d.recordedBy, name: d.recordedByName ?? recorder?.name ?? 'Examiner', limit },
    waitingHours: waited,
    amount,
    limit,
    amountNote: `Proceeds plus interest to the pay date${a.related.length ? ', base benefit and rider' : ''} · the backend works the interest out again when it is approved`,
    payees: a.claim.parties.filter((p) => p.role === 'beneficiary' && p.payee).map((p) => `${p.name} · ${Number.parseFloat(p.sharePercent ?? '0')}%${amount != null ? ` · ${fmtMoney(Math.round(amount * Number.parseFloat(p.sharePercent ?? '0')) / 100)}` : ''}`),
    payeeMethod: 'EFT',
    checks: [],
    rationale: d.basis,
    evidence: d.evidence ?? [],
    provisions: d.provisions ?? [],
    letter: d.letterTemplate ?? undefined,
    payDate: TODAY,
    section: 'decision',
    due: a.workItem?.dueOn ?? day(d.recordedAt),
    live: true,
    backend: { decisionId: d.id },
  }
}
