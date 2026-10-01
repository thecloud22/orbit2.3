import { FINANCIALS } from './fixtures/financials'
import { collection, fail, respond } from './store'
import { logEvent } from './history'
import { nowStamp } from '../lib/dates'
import type { ISODate, User } from './types'

// ---------------------------------------------------------------- Financial review  GET /claims/{id}/financials

/** One earnings figure the residual calculation needs: a tax year or a month of the practice P&L. */
export interface EarningsInput {
  id: string
  label: string
  period: string
  status: 'received' | 'missing'
  /** Dollars. Absent until the document arrives and the analyst records it. */
  amount?: number
  received?: ISODate
  requested?: ISODate
  due?: ISODate
  followUps?: string[]
  note?: string
  requirementId?: string
}

export interface ResidualWorkup {
  /** Same as the claim id. */
  id: string
  claimId: string
  analyst: string
  analystTitle: string
  policy: string
  monthlyBenefit: number
  /** 0.2 = a loss below 20% of prior earnings pays nothing. */
  minimumLoss: number
  disabledSince: ISODate
  eliminationMet: ISODate
  definitions: [string, string][]
  prior: EarningsInput[]
  current: EarningsInput[]
  /** Requests for the missing figures sent from this screen. */
  requests: { at: ISODate; to: string; items: string; by: string }[]
}

const monthRange = (ms: EarningsInput[]) => {
  const n = ms.map((m) => m.period.split(' ')[0])
  return n.length > 1 ? `${n[0]}–${n[n.length - 1]}` : n[0] ?? ''
}

export const financials = collection<ResidualWorkup>(FINANCIALS)

/** GET /claims/{id}/financials — undefined when there is no financial review on the claim. */
export function getFinancials(claimId: string): Promise<ResidualWorkup | undefined> {
  return respond(financials.get(claimId))
}

/** Prior monthly earnings — the higher of the latest year and the two-year average — or undefined if a year is missing. */
export function priorMonthly(w: ResidualWorkup): number | undefined {
  const years = w.prior.map((p) => p.amount)
  if (years.some((a) => a == null)) return undefined
  const latest = years[0]! / 12
  const average = years.reduce<number>((s, a) => s + a!, 0) / (12 * years.length)
  return Math.max(latest, average)
}

/** Residual benefit for one month: loss share × monthly benefit, or zero below the minimum loss. */
export function residualBenefit(prior: number, current: number, monthlyBenefit: number, minimumLoss: number): { loss: number; benefit: number } {
  const loss = prior > 0 ? Math.max(0, (prior - current) / prior) : 0
  const benefit = loss < minimumLoss ? 0 : Math.round(loss * monthlyBenefit * 100) / 100
  return { loss, benefit }
}

/** POST /claims/{id}/financials/requests — asks for the missing figures and logs it. */
export function requestFigures(claimId: string, to: string, by: User): Promise<void> {
  const w = financials.get(claimId)
  if (!w) return fail('No financial review on this claim')
  const missing = [...w.prior, ...w.current].filter((i) => i.status === 'missing')
  if (!missing.length) return fail('Nothing is missing')
  const items = [
    ...w.prior.filter((i) => i.status === 'missing').map((i) => i.label),
    w.current.some((i) => i.status === 'missing') ? `practice P&L ${monthRange(w.current.filter((i) => i.status === 'missing'))}` : '',
  ].filter(Boolean).join(' and ')
  const at = nowStamp()
  financials.update(claimId, (cur) => ({ requests: [{ at, to, items, by: by.name }, ...cur.requests] }))
  logEvent(claimId, { at, type: 'communication', title: `Financial records requested from ${to} — ${items}`, actor: `${by.name} · for ${w.analyst}`, ref: 'Requirements' })
  return respond(undefined)
}
