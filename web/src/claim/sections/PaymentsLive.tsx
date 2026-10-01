import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { ApiError } from '../../api/live/http'
import * as live from '../../api/live/data'
import { dueItems, itemStatus, runSentence } from '../../api/live/payments'
import { money, standing, type Bundle } from '../../api/live/present'
import { stamp } from '../../api/live/time'
import type { ApiPaymentRun } from '../../api/live/types'
import { fmtDate, TODAY } from '../../lib/dates'
import { fmtMoney, sum } from '../../lib/money'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag, Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import type { SectionProps } from './types'
import './Payments.css'
import './Live.css'

const message = (e: unknown) => (e instanceof ApiError ? (e.detail ?? e.title) : (e as Error).message)

/**
 * The Payments screen for a live claim: the backend's payment items (principal, interest, amount, pay date, status) per payee, holds
 * and releases (with the item's ETag), and the payment run. The real batch is daily; "Run payment run now" starts it by hand.
 * Shapes for the complex scenario are already here: a `returned` item shows the bank's code and reason, and `replacementOfId`
 * links a replacement to the item it replaces (nothing triggers a return yet).
 */
export function PaymentsLive({ claim }: SectionProps) {
  const { data: b, error } = useQuery(() => live.bundleFor(claim.id), [claim.id])
  const { data: runs } = useQuery(() => live.listPaymentRuns(), [claim.id])
  if (error) return <p className="lv-error" role="alert">{error.message}</p>
  const head = (
    <div className="page-head pm-head">
      <h2>Payments</h2>
      <span className="aside">{claim.product} · paid by the daily payment run</span>
      <Tag tone="info">Live</Tag>
    </div>
  )
  if (!b) return <>{head}<Loading rows={5} /></>
  if (b.paymentItems.length === 0) return <>{head}<Empty b={b} /></>

  return (
    <div className="pm lv-pay">
      {head}
      <Tiles b={b} />
      <Items b={b} />
      <RunPanel b={b} runs={runs ?? []} />
    </div>
  )
}

function Empty({ b }: { b: Bundle }) {
  const s = b.claim.status
  return (
    <div className="empty pm-empty" data-no-payments>
      <Icon name="payments" size={20} />
      <strong>No payment items yet</strong>
      {s === 'awaiting_approval' ? (
        <>
          <span>The decision is waiting for the team lead. The backend writes the payment items when it is approved.</span>
          <Link className="btn btn--sm" to={`/claims/${b.claim.claimNumber}/decision`}>Open Decision<Icon name="arrowRight" size={12} /></Link>
        </>
      ) : s === 'in_review' ? (
        <>
          <span>The backend writes one payment item per payee when the decision is recorded.</span>
          <Link className="btn btn--sm" to={`/claims/${b.claim.claimNumber}/decision`}>Open Decision<Icon name="arrowRight" size={12} /></Link>
        </>
      ) : (
        <span>Payment items are made when the decision is recorded. The claim is {s.replace('_', ' ')}.</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Tiles

function Tiles({ b }: { b: Bundle }) {
  const items = standing(b.paymentItems)
  const paid = items.filter((i) => i.status === 'paid')
  const waiting = items.filter((i) => i.status === 'cleared' || i.status === 'in_run')
  const trouble = b.paymentItems.filter((i) => i.status === 'held' || i.status === 'returned')
  const next = waiting.map((i) => i.payOn).sort()[0]
  const principal = sum(items.map((i) => money(i.principal)))
  const interest = sum(items.map((i) => money(i.interest)))
  return (
    <dl className="pm-tiles" data-tiles>
      <div className="pm-tile">
        <dt>To pay</dt>
        <dd className="pm-tile-value" data-tile="total">{fmtMoney(sum(items.map((i) => money(i.amount))))}</dd>
        <dd className="sub">{fmtMoney(principal)} proceeds + {fmtMoney(interest)} interest</dd>
      </div>
      <div className="pm-tile">
        <dt>Paid to date</dt>
        <dd className="pm-tile-value" data-tile="paid">{fmtMoney(sum(paid.map((i) => money(i.amount))))}</dd>
        <dd className="sub">{paid.length ? `${paid.length} ${paid.length === 1 ? 'payment' : 'payments'}` : 'Nothing paid yet'}</dd>
      </div>
      <div className="pm-tile">
        <dt>Next payment run</dt>
        <dd className="pm-tile-value">{next ? fmtDate(next, { weekday: true }) : '—'}</dd>
        <dd className="sub">{waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'item' : 'items'} · ${fmtMoney(sum(waiting.map((i) => money(i.amount))))}` : 'Nothing waiting'}</dd>
      </div>
      {trouble.length > 0 && (
        <div className="pm-tile">
          <dt>Needs attention</dt>
          <dd className="pm-tile-value">{trouble.length}</dd>
          <dd className="sub">{trouble.filter((i) => i.status === 'held').length} held · {trouble.filter((i) => i.status === 'returned').length} returned</dd>
        </div>
      )}
    </dl>
  )
}

// ---------------------------------------------------------------- Items

function Items({ b }: { b: Bundle }) {
  const toast = useToast()
  const [holding, setHolding] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | undefined>()
  const items = [...b.paymentItems].sort((x, y) => (x.payeeName ?? '').localeCompare(y.payeeName ?? '') || x.payOn.localeCompare(y.payOn))
  const byId = new Map(b.paymentItems.map((i) => [i.id, i]))
  const replacedBy = new Map(b.paymentItems.filter((i) => i.replacementOfId).map((i) => [i.replacementOfId!, i]))
  const payees = [...new Set(items.map((i) => i.payeeName ?? ''))]

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id)
    setErr(undefined)
    try {
      await fn()
      toast(ok)
      setHolding(null)
      setReason('')
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 412 ? 'This payment changed since you opened it, so nothing was changed. It is shown again with the latest version; try once more.' : message(e))
    } finally {
      setBusy(null)
    }
  }

  function jump(id: string) {
    const el = document.getElementById(`pi-${id}`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.classList.add('lv-flash')
    window.setTimeout(() => el?.classList.remove('lv-flash'), 1800)
  }

  return (
    <section className="section" aria-labelledby="pm-items-h">
      <div className="section-head">
        <h3 id="pm-items-h">Payment items <span className="aside" style={{ fontWeight: 400, marginLeft: 6 }}>{payees.length} {payees.length === 1 ? 'payee' : 'payees'} · the backend’s payment items, oldest first per payee</span></h3>
      </div>
      {err && <div className="lv-error" role="alert" style={{ marginBottom: 8 }}>{err}</div>}
      <div className="pm-scroll">
        <table className="tbl tbl--middle lv-pay-table" data-items>
          <thead>
            <tr><th>Payee</th><th>Basis</th><th className="r">Proceeds</th><th className="r">Interest</th><th className="r">Amount</th><th>Status</th><th>Action</th></tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const replacement = replacedBy.get(i.id)
              const replaces = i.replacementOfId ? byId.get(i.replacementOfId) : undefined
              const canHold = i.status === 'cleared' || i.status === 'awaiting_proof'
              return (
                <Fragment key={i.id}>
                <tr id={`pi-${i.id}`} data-item-status={i.status}>
                  <td className="lv-wrap"><div className="strong" style={{ fontWeight: 600 }}>{i.payeeName}</div><div className="sub"><span className="mono">{i.method === 'eft' ? 'EFT' : 'Check'}</span> · pays {fmtDate(i.payOn)}</div></td>
                  <td className="lv-wrap soft">{i.basis}{i.kind === 'adjustment' && <div className="sub">Adjustment{i.adjustsItemId ? ' to an earlier item' : ''}</div>}</td>
                  <td className="r">{fmtMoney(money(i.principal))}</td>
                  <td className="r" data-cell="interest">{fmtMoney(money(i.interest))}</td>
                  <td className="r strong" data-cell="amount">{fmtMoney(money(i.amount))}</td>
                  <td className="lv-wrap">
                    <span className="pm-status"><StatusTag status={itemStatus(i)} /></span>
                    {i.status === 'paid' && <div className="sub lv-ref">{i.paymentReference ? <>ref <span className="mono">{i.paymentReference}</span></> : 'paid'}</div>}
                    {i.status === 'held' && i.holdReason && <div className="sub">Held: {i.holdReason}</div>}
                    {i.status === 'in_run' && <div className="sub">With the bank; marked paid when the run finishes</div>}
                    {i.status === 'returned' && (
                      <div className="sub" data-returned>
                        Returned by the bank{i.returnCode ? ` · ${i.returnCode}` : ''}{i.returnReason ? ` ${i.returnReason}` : ''}.{' '}
                        {replacement ? <button type="button" className="lv-link" onClick={() => jump(replacement.id)}>Replaced by a new item →</button> : 'No replacement yet.'}
                      </div>
                    )}
                    {replaces && (
                      <div className="sub" data-replacement>Replaces the returned payment of {fmtMoney(money(replaces.amount))}{' '}
                        <button type="button" className="lv-link" onClick={() => jump(replaces.id)}>← see it</button>
                      </div>
                    )}
                    {i.replacementOfId && !replaces && <div className="sub">Replaces a returned payment</div>}
                  </td>
                  <td>
                    {canHold && holding !== i.id && <button type="button" className="btn btn--xs" data-hold={i.id} onClick={() => { setHolding(i.id); setReason(''); setErr(undefined) }}>Hold</button>}
                    {canHold && holding === i.id && <span className="muted">Holding…</span>}
                    {i.status === 'held' && <button type="button" className="btn btn--xs" data-release={i.id} disabled={busy === i.id} onClick={() => run(i.id, () => live.releasePaymentItem(b.claim.claimNumber, i), `Released: ${i.payeeName}`)}>Release</button>}
                    {!canHold && i.status !== 'held' && <span className="muted">—</span>}
                  </td>
                </tr>
                {canHold && holding === i.id && (
                  <tr className="lv-hold-row">
                    <td colSpan={7}>
                      <span className="lv-hold-form">
                        <label htmlFor={`hold-${i.id}`} className="lv-hold-label">Hold {i.payeeName}’s {fmtMoney(money(i.amount))}: reason</label>
                        <input id={`hold-${i.id}`} className="input" placeholder="For example: bank account to be confirmed" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                        <button type="button" className="btn btn--primary btn--xs" disabled={!reason.trim() || busy === i.id} onClick={() => run(i.id, () => live.holdPaymentItem(b.claim.claimNumber, i, reason.trim()), `Held: ${i.payeeName} · ${fmtMoney(money(i.amount))}`)}>Hold payment</button>
                        <button type="button" className="btn btn--xs" onClick={() => setHolding(null)}>Cancel</button>
                      </span>
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total (items that stand)</td>
              <td className="r">{fmtMoney(sum(standing(items).map((i) => money(i.principal))))}</td>
              <td className="r">{fmtMoney(sum(standing(items).map((i) => money(i.interest))))}</td>
              <td className="r strong">{fmtMoney(sum(standing(items).map((i) => money(i.amount))))}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="lv-note" style={{ marginTop: 8 }}>
        A held item is skipped by every run and keeps the claim open until it is released and paid. Once an item is in a run only the run touches it: a hold then is refused (409 item_in_run).
        Paid items never change; if the bank returns one, a new replacement item is made.
      </p>
    </section>
  )
}

// ---------------------------------------------------------------- The payment run

function RunPanel({ b, runs }: { b: Bundle; runs: ApiPaymentRun[] }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const [last, setLast] = useState<{ run: ApiPaymentRun; replayed: boolean } | undefined>()
  const due = dueItems(b.paymentItems, TODAY)
  const nextPay = standing(b.paymentItems).filter((i) => i.status === 'cleared').map((i) => i.payOn).sort()[0]
  const mine = new Set(b.paymentItems.map((i) => i.runId).filter((x): x is string => !!x))
  const shown = runs.slice(0, 6)

  async function start() {
    setBusy(true)
    setErr(undefined)
    try {
      const r = await live.startPaymentRun(TODAY, due.map((i) => i.id))
      setLast(r)
      toast(runSentence(r.run))
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="lv-run" aria-labelledby="run-h" data-payment-run>
      <div className="lv-run-head">
        <h3 id="run-h">Payment run</h3>
        <span className="lv-run-tag">ops · demo</span>
      </div>
      <div className="lv-run-body">
        <p>
          The real payment run is a daily batch: it takes every cleared item due on or before its date, sends the file to the bank, marks the items paid and closes every claim whose items are all paid.
          {' '}This button starts it by hand for today’s business date, <strong>{fmtDate(TODAY, { weekday: true })}</strong>, on all claims. {nextPay && due.length === 0 ? `This claim’s items pay on ${fmtDate(nextPay, { weekday: true })}: move the clock there with Demo controls first.` : ''}
        </p>
        <button type="button" className="btn btn--primary" data-run-now disabled={busy || due.length === 0} title={due.length === 0 ? 'No cleared item on this claim is due today' : undefined} onClick={start}>
          {busy ? 'Running…' : 'Run payment run now'}
        </button>
      </div>
      {err && <div className="lv-error" role="alert">{err}</div>}
      {last && (
        <div className="lv-run-result" data-run-result>
          <strong>{last.replayed ? 'Same run as before' : 'Run finished'}</strong> · {runSentence(last.run)}
        </div>
      )}
      {shown.length > 0 && (
        <div className="pm-scroll">
          <table className="tbl tbl--middle lv-runs" data-runs>
            <thead><tr><th>Run date</th><th>Started by</th><th>Status</th><th className="r">Items</th><th className="r">Paid</th><th className="r">Returned</th><th className="r">Total</th><th>File reference</th><th>This claim</th></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtDate(r.runDate)} <span className="sub">{stamp(r.startedAt).slice(11)}</span></td>
                  <td>{r.trigger === 'manual' ? 'By hand' : 'Daily schedule'}</td>
                  <td><Tag tone={r.status === 'reconciled' ? 'positive' : r.status === 'failed' ? 'critical' : 'info'}>{r.status}</Tag>{r.error && <div className="sub">{r.error}</div>}</td>
                  <td className="r">{r.itemCount}</td>
                  <td className="r">{r.paidCount ?? 0}</td>
                  <td className="r">{r.returnedCount ?? 0}</td>
                  <td className="r">{fmtMoney(money(r.total))}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.fileReference ?? '—'}</td>
                  <td>{mine.has(r.id) ? 'Included' : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
