/** Payment items, from the backend's records to what the Payments screen and the counts show. */
import type { Status } from '../types'
import type { PaymentRow } from '../payments'
import { fmtDate } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import type { ApiPaymentItem, ApiPaymentRun } from './types'
import { money, type Bundle } from './present'
import { day } from './time'

export function itemStatus(i: ApiPaymentItem): Status {
  switch (i.status) {
    case 'awaiting_proof': return { label: 'Waiting for proof', tone: 'neutral' }
    case 'cleared': return { label: `Cleared · pays ${fmtDate(i.payOn)}`, tone: 'info' }
    case 'in_run': return { label: 'In a payment run', tone: 'info' }
    case 'paid': return { label: `Paid ${i.paidAt ? fmtDate(day(i.paidAt)) : ''}`.trim(), tone: 'positive' }
    case 'held': return { label: 'Held', tone: 'caution' }
    case 'cancelled': return { label: 'Cancelled', tone: 'neutral' }
    case 'returned': return { label: `Returned${i.returnCode ? ` · ${i.returnCode}` : ''}`, tone: 'critical' }
  }
}

/** The items as the mock's payment rows, so the section counts (paid, scheduled) read the same way for a live claim. */
export function mapPaymentRows(b: Bundle): PaymentRow[] {
  return b.paymentItems.map((i) => ({
    id: i.id,
    claimId: b.claim.claimNumber,
    benefitLineId: i.benefitLineId,
    payDate: i.payOn,
    payee: i.payeeName ?? 'Payee',
    basis: i.basis ?? '',
    amount: money(i.amount),
    method: i.method === 'eft' ? 'EFT' : 'Check',
    status: itemStatus(i),
    note: i.paymentReference ?? i.holdReason ?? undefined,
  }))
}

/** Items a run on `runDate` would take: cleared, and payable on or before that date. */
export function dueItems(items: ApiPaymentItem[], runDate: string): ApiPaymentItem[] {
  return items.filter((i) => i.status === 'cleared' && i.payOn <= runDate)
}

/** 'Run 9 Oct: 2 items, 2 paid, $200,383.56 · reconciled · file PMT-…' */
export function runSentence(r: ApiPaymentRun): string {
  const n = r.itemCount
  return `Run ${fmtDate(r.runDate)}: ${n} ${n === 1 ? 'item' : 'items'}, ${r.paidCount ?? 0} paid${r.returnedCount ? `, ${r.returnedCount} returned` : ''}, ${fmtMoney(money(r.total))} · ${r.status}${r.fileReference ? ` · file ${r.fileReference}` : ''}`
}
