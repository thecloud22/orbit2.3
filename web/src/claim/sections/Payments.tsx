import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Claim } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import {
  askPaymentsForUpdate, closeClaim, confirmReturnToWork, decidePaymentSuggestion, draftBenefitAdjustment, draftOneTimePayment,
  flagReturnDateChange, getPaymentProfile, listPaymentDrafts, listPayments, markReleased, recordOverpayment, setUpSurvivor,
  type CalcRow, type PaymentDraft, type PaymentHold, type PaymentProfile, type PaymentRow, type RelatedLine,
} from '../../api/payments'
import { listDecisions, listWorkbenches } from '../../api/decisions'
import { addDays, daysFrom, fmtDate, TODAY } from '../../lib/dates'
import { fmtMoney, sum } from '../../lib/money'
import { cx } from '../../lib/cx'
import { Drawer } from '../../components/Drawer'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { ProposedCard } from '../../components/Proposed'
import { Sources } from '../../components/Sources'
import { StatusTag, Tag, ToneShape } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Payments.css'

type ActionKey = 'oneTime' | 'adjust' | 'overpayment'

/** Benefits & payments: what the benefit is, how it is worked out, what has been paid and what releases next. */
export function PaymentsSection({ claim }: SectionProps) {
  const { data: profile, loading } = useQuery(() => getPaymentProfile(claim.id), [claim.id])
  const { data: rows } = useQuery(() => listPayments(claim.id), [claim.id])
  const { data: drafts } = useQuery(() => listPaymentDrafts(claim.id), [claim.id])
  const { data: benches } = useQuery(() => listWorkbenches(claim.id), [claim.id])
  const [drawer, setDrawer] = useState<ActionKey | null>(null)

  const title = claim.family === 'disability' ? 'Benefits & payments' : 'Payments'
  const ready = !loading && rows && profile !== undefined
  const actions = profile?.actions ?? []

  const head = (
    <div className="page-head pm-head">
      <h2>{title}</h2>
      {profile && <span className="aside">{profile.subtitle}</span>}
      <span className="grow" />
      {rows && rows.length > 0 && actions.includes('oneTime') && (
        <button type="button" className="btn btn--sm" onClick={() => setDrawer('oneTime')}><Icon name="plus" size={13} />One-time payment</button>
      )}
      {rows && rows.length > 0 && actions.includes('adjust') && (
        <button type="button" className="btn btn--sm" onClick={() => setDrawer('adjust')}><Icon name="pencil" size={13} />Adjust benefit</button>
      )}
      {rows && rows.length > 0 && actions.includes('overpayment') && (
        <button type="button" className="btn btn--sm" onClick={() => setDrawer('overpayment')}><Icon name="undo" size={13} />Record overpayment</button>
      )}
    </div>
  )

  if (!ready) return <>{head}<Loading rows={6} /></>

  // Nothing paid or scheduled yet.
  if (rows.length === 0) {
    return (
      <>
        {head}
        <div className="empty pm-empty">
          <Icon name="payments" size={20} />
          <strong>No payments yet</strong>
          {benches && benches.length > 0 ? (
            <>
              <span>Payments are scheduled when the decision is recorded. {benches.map((b) => `${b.title} ${b.ref}`).join(', ')} is ready to decide.</span>
              <Link className="btn btn--sm" to={`/claims/${claim.id}/decision`}>Open Decision<Icon name="arrowRight" size={12} /></Link>
            </>
          ) : (
            <span>Payments are scheduled when a benefit line is approved. {claim.benefitLines.map((b) => `${b.name}: ${b.status.label.toLowerCase()}`).join(' · ')}.</span>
          )}
        </div>
      </>
    )
  }

  const p = profile ?? fallbackProfile(claim)
  return (
    <div className="pm">
      {head}
      {p.holds?.map((h) => <HoldPanel key={h.id} hold={h} claim={claim} />)}
      <Tiles profile={p} rows={rows} />
      {p.special === 'fastTrack' && <FastTrackClose claim={claim} rows={rows} />}
      {p.special === 'survivor' && p.survivor && <SurvivorPanel claim={claim} profile={p} drafts={drafts ?? []} />}
      {p.special === 'returnToWork' && <ReturnToWork claim={claim} drafts={drafts ?? []} />}

      {(p.calculation || p.chart) && (
        <div className={cx('pm-pair', !(p.calculation && p.chart) && 'pm-pair--single')}>
          {p.calculation && <Calculation calc={p.calculation} />}
          {p.chart && <BenefitChart chart={p.chart} />}
        </div>
      )}
      {p.related?.map((r) => <RelatedLineRow key={r.ref} line={r} />)}
      {drafts && drafts.length > 0 && <Drafts drafts={drafts} />}
      <Schedule profile={p} rows={rows} />
      {(p.release || p.payeeTax) && (
        <div className="pm-pair">
          {p.release && <Release profile={p} rows={rows} drafts={drafts ?? []} />}
          {p.payeeTax && <PayeeTax profile={p} />}
        </div>
      )}
      {p.suggestion && <PaymentSuggestion claim={claim} profile={p} />}

      {drawer === 'oneTime' && <OneTimeDrawer claim={claim} rows={rows} onClose={() => setDrawer(null)} />}
      {drawer === 'adjust' && <AdjustDrawer claim={claim} profile={p} onClose={() => setDrawer(null)} />}
      {drawer === 'overpayment' && <OverpaymentDrawer claim={claim} onClose={() => setDrawer(null)} />}
    </div>
  )
}

function fallbackProfile(claim: Claim): PaymentProfile {
  return {
    claimId: claim.id,
    subtitle: claim.product,
    tiles: [{ label: 'Next payment', value: '', compute: 'nextPayment' }, { label: 'Paid to date', value: '', compute: 'paidToDate' }],
    schedule: { aside: 'All payments on this claim', columns: 'basic' },
    actions: ['oneTime', 'overpayment'],
  }
}

// ---------------------------------------------------------------- Tiles

function nextScheduled(rows: PaymentRow[]): PaymentRow | undefined {
  return [...rows].filter((r) => r.status.tone === 'info').sort((a, b) => a.payDate.localeCompare(b.payDate))[0]
}

/** Summary tiles — a few headline numbers, each with the line that explains it. */
function Tiles({ profile, rows }: { profile: PaymentProfile; rows: PaymentRow[] }) {
  const paid = rows.filter((r) => r.status.tone === 'positive')
  const next = nextScheduled(rows)
  return (
    <dl className="pm-tiles">
      {profile.tiles.map((t) => {
        let value = t.value
        let note = t.note
        if (t.compute === 'paidToDate') {
          value = fmtMoney(sum(paid.map((r) => r.amount)))
          note = paid.length ? `${paid.length} payment${paid.length > 1 ? 's' : ''}` : 'Nothing paid yet'
        }
        if (t.compute === 'nextPayment') {
          const same = next ? rows.filter((r) => r.payDate === next.payDate && r.status.tone === 'info') : []
          value = next ? fmtDate(next.payDate) : '—'
          note = !next ? 'Nothing scheduled' : same.length > 1 ? `${same.length} EFTs · ${fmtMoney(sum(same.map((r) => r.amount)))}` : `${next.method} · ${fmtMoney(next.amount)}`
        }
        return (
          <div key={t.label} className="pm-tile">
            <dt>{t.label}</dt>
            <dd className="pm-tile-value">{value}</dd>
            {note && <dd className="sub">{note}</dd>}
          </div>
        )
      })}
    </dl>
  )
}

// ---------------------------------------------------------------- Holds

/** A payment hold: why the money is held, who is working on it and what happens next. */
function HoldPanel({ hold, claim }: { hold: PaymentHold; claim: Claim }) {
  const toast = useToast()
  const { user } = useSession()
  // The custodian packet moves the minors' hold along once it has been sent.
  const packetSent = hold.id === 'hold-okafor-minors' && claim.exceptions.some((x) => x.id === 'x2' && x.meta.startsWith('Custodian form sent'))
  const steps = packetSent
    ? hold.steps.map((s, i) => ({ ...s, state: i <= 1 ? 'done' : i === 2 ? 'current' : 'todo' }) as typeof s)
    : hold.steps
  const actionLabel = packetSent ? 'See the packet' : hold.action?.label

  return (
    <section className={`pm-hold pm-hold--${hold.tone}`} aria-labelledby={`${hold.id}-h`}>
      <div className="pm-hold-head">
        <ToneShape tone={hold.tone} size={12} />
        <h3 id={`${hold.id}-h`}>{hold.title}</h3>
        <span className="grow" />
        <span className="pm-hold-amount">{fmtMoney(hold.amount)} held</span>
      </div>
      <p className="pm-hold-detail">{hold.detail}</p>
      <div className="pm-hold-grid">
        <dl className="dl pm-hold-facts">
          {hold.facts.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <div>
          <div className="pm-label">What happens next</div>
          <ol className="pm-steps">
            {steps.map((s) => (
              <li key={s.label} className={`pm-step pm-step--${s.state}`}>
                <StepMark state={s.state} />
                <div>
                  <div className="pm-step-label">{s.label}<span className="sr-only"> ({s.state === 'done' ? 'done' : s.state === 'current' ? 'in progress' : 'to do'})</span></div>
                  {s.detail && <div className="sub">{s.detail}</div>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      {hold.interest && (
        <p className="pm-hold-interest"><Icon name="history" size={14} />{hold.interest}</p>
      )}
      <div className="pm-hold-foot">
        {hold.contact && (
          <span className="pm-contact">
            <span className="pm-avatar" aria-hidden="true">{hold.contact.name.split(' ').map((w) => w[0]).join('')}</span>
            <span><strong>{hold.contact.name}</strong>, {hold.contact.title} <span className="sub">· {hold.contact.note}</span></span>
          </span>
        )}
        {!hold.contact && packetSent && <span className="sub">Custodian form sent {fmtDate(TODAY)} · waiting on Adaeze</span>}
        <span className="grow" />
        {hold.contact && (
          <button type="button" className="btn btn--sm" onClick={async () => { await askPaymentsForUpdate(claim.id, hold.contact!.name, user.name); toast(`Asked ${hold.contact!.name} for an update · logged`) }}>
            Ask Payments for an update
          </button>
        )}
        {hold.action && (
          <Link className={cx('btn btn--sm', !packetSent && 'btn--primary')} to={`/claims/${claim.id}/${hold.action.section}${hold.action.target && !packetSent ? `/${hold.action.target}` : ''}`}>
            {actionLabel}<Icon name="arrowRight" size={12} />
          </Link>
        )}
      </div>
    </section>
  )
}

function StepMark({ state }: { state: 'done' | 'current' | 'todo' }) {
  if (state === 'done') return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="#45494F" /><path d="M4 7.2 6.1 9.2 10 5" fill="none" stroke="#FFF" strokeWidth="1.6" /></svg>
  if (state === 'current') return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFF" stroke="#45494F" strokeWidth="2" /><circle cx="7" cy="7" r="2.5" fill="#45494F" /></svg>
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFF" stroke="#A3A098" strokeWidth="1.5" /></svg>
}

// ---------------------------------------------------------------- Calculation

/** The benefit worked out line by line, each amount citing where it comes from. */
function Calculation({ calc }: { calc: NonNullable<PaymentProfile['calculation']> }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="section" aria-labelledby="pm-calc-h">
      <div className="section-head">
        <h3 id="pm-calc-h">{calc.title} <span className="aside" style={{ fontWeight: 400, marginLeft: 6 }}>{calc.aside}</span></h3>
        <button type="button" className="btn btn--ghost btn--xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide calculation' : 'Show calculation'}
          <span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined }}><Icon name="chevronDown" size={12} /></span>
        </button>
      </div>
      {open ? <CalcTable rows={calc.rows} /> : (
        <div className="pm-calc-closed">
          <span>{calc.rows.filter((r) => r.strong).map((r) => r.label).slice(-1)[0]}</span>
          <strong>{calc.rows.filter((r) => r.strong).slice(-1)[0]?.amount}</strong>
        </div>
      )}
    </section>
  )
}

function CalcTable({ rows }: { rows: CalcRow[] }) {
  return (
    <table className="tbl tbl--middle pm-calc">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={r.strong ? 'pm-calc-strong' : undefined}>
            <td className="pm-op" aria-hidden={!r.op}>{r.op ?? ''}</td>
            <td>
              <span className={r.strong ? 'strong' : undefined}>{r.label}</span>
              {r.detail && <span className="soft"> {r.detail}</span>}
            </td>
            <td className="pm-calc-src">{r.source && (r.strong ? <span className="sub">{r.source}</span> : <Sources items={[r.source]} />)}</td>
            <td className={cx('r nowrap', r.strong && 'strong')}>{r.amount}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------- Chart

function monthsBetween(a: string, b: string): number {
  return daysFrom(a, b) / 30.4375
}

/** Step chart of the monthly benefit: paid and scheduled solid, projected dashed, with a table view. */
function BenefitChart({ chart }: { chart: NonNullable<PaymentProfile['chart']> }) {
  const [table, setTable] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(400)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [table])

  const pts = chart.points
  const start = pts[0].from
  const span = monthsBetween(start, chart.end)
  const amounts = pts.map((p) => p.amount)
  const lo = Math.floor((Math.min(...amounts) - 100) / 200) * 200
  const hi = Math.ceil((Math.max(...amounts) + 100) / 200) * 200
  const ticks: number[] = []
  for (let v = lo; v <= hi; v += 200) ticks.push(v)
  const h = 170
  const pad = { l: 50, r: 12, t: 16, b: 26 }
  const x = (iso: string) => pad.l + (monthsBetween(start, iso) / span) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (h - pad.t - pad.b)
  const years = Array.from(new Set(pts.map((p) => p.from.slice(0, 4))))
  const segs = pts.map((p, i) => ({ ...p, to: pts[i + 1]?.from ?? chart.end }))
  const fmtK = (v: number) => `$${v.toLocaleString('en-US')}`

  return (
    <section className="section" aria-labelledby="pm-chart-h">
      <div className="section-head">
        <h3 id="pm-chart-h">{chart.title}</h3>
        <button type="button" className="btn btn--ghost btn--xs" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? 'Chart view' : 'Table view'}</button>
      </div>
      {table ? (
        <table className="tbl">
          <thead><tr><th>From</th><th className="r">Monthly benefit</th><th>Basis</th></tr></thead>
          <tbody>
            {pts.map((p, i) => (
              <tr key={p.from}>
                <td>{fmtDate(p.from, { year: true })}</td>
                <td className="r">{fmtMoney(p.amount)}</td>
                <td>{i === 0 ? 'Policy monthly benefit' : `COLA +3% of the original`}{p.projected ? ' · projected' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div ref={ref} className="pm-chart">
          <svg width={w} height={h} role="img" aria-label={`${chart.title}: ${pts.map((p) => `${fmtMoney(p.amount)} from ${fmtDate(p.from, { year: true })}${p.projected ? ' (projected)' : ''}`).join('; ')}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
                <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="pm-axis">{fmtK(t)}</text>
              </g>
            ))}
            {years.map((yr) => {
              const d = `${yr}-06-01`
              return <text key={yr} x={x(d)} y={h - 6} textAnchor="middle" className="pm-axis">Jun {yr}</text>
            })}
            {TODAY > start && TODAY < chart.end && (
              <g>
                <line x1={x(TODAY)} x2={x(TODAY)} y1={pad.t - 6} y2={h - pad.b} stroke="var(--ink-2)" strokeWidth="1.5" />
                <text x={x(TODAY) + 4} y={pad.t - 4} className="pm-axis pm-axis--strong">Today</text>
              </g>
            )}
            {segs.map((s, i) => {
              const prev = segs[i - 1]
              return (
                <g key={s.from} tabIndex={0} className="pm-seg">
                  <title>{`${fmtMoney(s.amount)} a month from ${fmtDate(s.from, { year: true })}${s.projected ? ' · projected' : ''}`}</title>
                  {prev && <line x1={x(s.from)} x2={x(s.from)} y1={y(prev.amount)} y2={y(s.amount)} stroke={s.projected ? 'var(--ink-4)' : 'var(--ink-2)'} strokeWidth="2" strokeDasharray={s.projected ? '4 3' : undefined} />}
                  <line x1={x(s.from)} x2={x(s.to)} y1={y(s.amount)} y2={y(s.amount)} stroke={s.projected ? 'var(--ink-4)' : 'var(--ink-2)'} strokeWidth="2" strokeDasharray={s.projected ? '4 3' : undefined} />
                  <rect x={x(s.from)} width={Math.max(1, x(s.to) - x(s.from))} y={y(s.amount) - 12} height={24} fill="transparent" />
                  <circle cx={x(s.from)} cy={y(s.amount)} r={4} fill={s.projected ? 'var(--surface)' : 'var(--ink-2)'} stroke={s.projected ? 'var(--ink-4)' : 'var(--surface)'} strokeWidth="2" />
                  <text x={Math.min(x(s.from) + 6, w - pad.r - 50)} y={y(s.amount) - 7} className="pm-axis pm-axis--strong">{fmtMoney(s.amount).replace('.00', '')}</text>
                </g>
              )
            })}
          </svg>
          <div className="pm-legend">
            <span><span className="pm-key" aria-hidden="true" />Paid and scheduled</span>
            <span><span className="pm-key pm-key--proj" aria-hidden="true" />Projected</span>
          </div>
          <p className="sub">{chart.note}</p>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Related benefit lines (BOE)

/** A related benefit line on the same claim, e.g. business overhead expense, with its ledger on demand. */
function RelatedLineRow({ line }: { line: RelatedLine }) {
  const [open, setOpen] = useState(false)
  const total = sum(line.ledger.map(([, v]) => v))
  return (
    <section className="pm-related" aria-label={line.name}>
      <div className="pm-related-head">
        <button type="button" className="btn btn--quiet btn--xs" aria-expanded={open} aria-label={open ? 'Hide payments' : 'Show payments'} onClick={() => setOpen((o) => !o)}>
          <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : undefined }}><Icon name="chevronRight" size={12} /></span>
        </button>
        <strong>{line.name}</strong>
        <span className="mono sub">{line.ref}</span>
        <StatusTag status={line.status} />
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--xs" onClick={() => setOpen((o) => !o)}>{open ? 'Hide payments' : 'Show payments'}</button>
      </div>
      <div className="soft pm-related-sum">{line.summary}</div>
      <div className="sub pm-related-sum">{line.description}</div>
      {open && (
        <div className="pm-ledger">
          <table className="tbl">
            <thead><tr><th>Month</th><th className="r">Reimbursed</th><th>Month</th><th className="r">Reimbursed</th><th>Month</th><th className="r">Reimbursed</th></tr></thead>
            <tbody>
              {Array.from({ length: Math.ceil(line.ledger.length / 3) }, (_, r) => (
                <tr key={r}>
                  {[0, 1, 2].map((c) => {
                    const e = line.ledger[r + c * Math.ceil(line.ledger.length / 3)]
                    return e ? [<td key={`m${c}`}>{e[0]}</td>, <td key={`a${c}`} className="r">{fmtMoney(e[1])}</td>] : [<td key={`m${c}`} />, <td key={`a${c}`} />]
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={4}>{line.ledger.length} months</td><td colSpan={2} className="r">{fmtMoney(total)}</td></tr></tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Drafts

/** Proposed changes to money, waiting on a person — dashed until reviewed. */
function Drafts({ drafts }: { drafts: PaymentDraft[] }) {
  return (
    <section className="section" aria-labelledby="pm-drafts-h">
      <div className="section-head">
        <h3 id="pm-drafts-h">Changes waiting on review</h3>
        <span className="aside">Nothing here changes a payment until someone reviews it</span>
      </div>
      <ul className="pm-drafts">
        {drafts.map((d) => (
          <li key={d.id} className={cx('proposed', d.status.tone === 'positive' && 'proposed--accepted')}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="proposed-title grow">{d.title}</span>
              <StatusTag status={d.status} />
            </div>
            <div className="proposed-body">{d.detail}</div>
            <div className="sub">{d.by} · {fmtDate(d.at)} · logged</div>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------- Schedule

/** Payment schedule: by default the first payment at risk, the next one and the last few paid. */
function Schedule({ profile, rows }: { profile: PaymentProfile; rows: PaymentRow[] }) {
  const [all, setAll] = useState(false)
  const cfg = profile.schedule ?? { aside: '', columns: 'basic' as const }
  const sorted = [...rows].sort((a, b) => b.payDate.localeCompare(a.payDate) || a.payee.localeCompare(b.payee))
  const paid = sorted.filter((r) => r.status.tone === 'positive')
  let shown = sorted
  if (cfg.recent && !all) {
    const future = [...sorted].reverse().filter((r) => r.status.tone !== 'positive')
    const atRisk = future.find((r) => r.status.tone === 'caution' || r.status.tone === 'critical')
    const next = future.find((r) => r.status.tone === 'info')
    shown = [atRisk, next, ...paid.slice(0, cfg.recent)].filter((r): r is PaymentRow => !!r)
    shown = sorted.filter((r) => shown.includes(r))
  }
  const cols = cfg.columns
  return (
    <section className="section" aria-labelledby="pm-sched-h">
      <div className="section-head">
        <h3 id="pm-sched-h">Payment schedule <span className="aside" style={{ fontWeight: 400, marginLeft: 6 }}>{all ? 'Every payment on this claim' : cfg.aside}</span></h3>
        {cfg.recent && (
          <button type="button" className="btn btn--ghost btn--xs" aria-pressed={all} onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer' : `All ${paid.length} payments`}
          </button>
        )}
      </div>
      <div className="pm-scroll">
        <table className="tbl tbl--middle pm-sched">
          <thead>
            {cols === 'di' ? (
              <tr><th>Period</th><th>Pay date</th><th className="r">Benefit</th><th className="r">COLA</th><th className="r">Amount</th><th>Method</th><th>Status</th></tr>
            ) : cols === 'lump' ? (
              <tr><th>Payee</th><th>Pay date</th><th className="r">Gross</th><th className="r">Withheld</th><th className="r">Net</th><th>Method</th><th>Status</th></tr>
            ) : (
              <tr><th>Pay date</th><th>Payee</th><th>Basis</th><th className="r">Amount</th><th>Method</th><th>Status</th></tr>
            )}
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                {cols === 'di' ? (
                  <>
                    <td className="nowrap">{r.period ?? '—'}</td>
                    <td className="nowrap">{fmtDate(r.payDate)}</td>
                    <td className="r">{fmtMoney(r.gross ?? r.amount)}</td>
                    <td className="r">{fmtMoney(r.cola ?? 0)}</td>
                    <td className="r">{fmtMoney(r.amount)}</td>
                  </>
                ) : cols === 'lump' ? (
                  <>
                    <td className="pm-wrap"><div className="strong" style={{ fontWeight: 600 }}>{r.payee}</div><div className="sub">{r.basis}</div></td>
                    <td className="nowrap">{fmtDate(r.payDate)}</td>
                    <td className="r">{fmtMoney(r.gross ?? r.amount)}</td>
                    <td className="r">{r.withheld ? `− ${fmtMoney(r.withheld)}` : '—'}</td>
                    <td className="r strong">{fmtMoney(r.amount)}</td>
                  </>
                ) : (
                  <>
                    <td className="nowrap">{fmtDate(r.payDate)}{r.period && <div className="sub">{r.period}</div>}</td>
                    <td style={{ fontWeight: 600 }}>{r.payee}</td>
                    <td className="soft">{r.basis}</td>
                    <td className="r">{fmtMoney(r.amount)}</td>
                  </>
                )}
                <td className="mono nowrap" style={{ fontSize: 12 }}>{r.method}</td>
                <td>
                  <span className="pm-status"><StatusTag status={r.status} />{r.note && <span className="sub">{r.note}</span>}</span>
                </td>
              </tr>
            ))}
            {profile.pending?.map((p) => (
              <tr key={p.payee} className="pm-pending">
                {cols === 'lump' ? (
                  <>
                    <td className="pm-wrap"><div style={{ fontWeight: 600 }}>{p.payee}</div><div className="sub">{p.basis}</div></td>
                    <td className="muted">—</td>
                    <td className="r">{p.amount}</td>
                    <td className="r muted">—</td>
                    <td className="r muted">—</td>
                  </>
                ) : cols === 'di' ? (
                  <><td colSpan={4}>{p.payee} <span className="sub">{p.basis}</span></td><td className="r">{p.amount}</td></>
                ) : (
                  <>
                    <td className="muted">—</td>
                    <td style={{ fontWeight: 600 }}>{p.payee}</td>
                    <td className="soft">{p.basis}</td>
                    <td className="r">{p.amount}</td>
                  </>
                )}
                <td className="muted">—</td>
                <td><StatusTag status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Release controls, payee & tax

/** Release controls for the next payment: every control must pass or the payment is held. */
function Release({ profile, rows, drafts }: { profile: PaymentProfile; rows: PaymentRow[]; drafts: PaymentDraft[] }) {
  const rel = profile.release!
  const target = [...rows].filter((r) => r.status.tone !== 'positive' && r.status.tone !== 'neutral').sort((a, b) => a.payDate.localeCompare(b.payDate))[0]
  const rtwDone = drafts.some((d) => d.kind === 'returnToWork')
  const controls = rel.controls.map((c) => (c.label.startsWith('Return-to-work') && rtwDone ? { ...c, pass: true, note: 'confirmed' } : c))
  const passed = controls.filter((c) => c.pass).length
  if (!target) {
    return (
      <section className="pm-card" aria-labelledby="pm-rel-h">
        <div className="pm-card-head"><h3 id="pm-rel-h">Release controls</h3><span className="grow" /><Tag tone="positive">All released</Tag></div>
        <p className="soft">Every payment on this claim has been released.</p>
      </section>
    )
  }
  return (
    <section className="pm-card" aria-labelledby="pm-rel-h">
      <div className="pm-card-head">
        <h3 id="pm-rel-h">Next payment · {fmtDate(target.payDate)}</h3>
        <span className="grow" />
        <StatusTag status={target.status} />
      </div>
      <div className="pm-card-sub">
        <span className="pm-label" style={{ margin: 0 }}>Release controls</span>
        <span className={cx('strong', passed === controls.length ? 'pm-pass' : 'pm-fail')}>{passed} of {controls.length} pass</span>
      </div>
      <ul className="pm-controls">
        {controls.map((c) => (
          <li key={c.label}>
            {c.pass
              ? <svg width="14" height="14" viewBox="0 0 16 16" role="img" aria-label="Pass"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" fill="none" stroke="#1D6340" strokeWidth="1.8" strokeLinecap="round" /></svg>
              : <svg width="14" height="14" viewBox="0 0 16 16" role="img" aria-label="Not met"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="#A0281D" /></svg>}
            <span>{c.label}{c.note && <span className="sub"> · {c.note}</span>}</span>
          </li>
        ))}
      </ul>
      <div className="pm-release-foot">
        <Icon name="history" size={16} />
        <div>
          <div className="strong">{passed === controls.length ? rel.footTitle : target.status.tone === 'critical' ? rel.footTitle : `Held until every control passes`}</div>
          <div className="sub">{rel.footNote}</div>
        </div>
      </div>
    </section>
  )
}

function PayeeTax({ profile }: { profile: PaymentProfile }) {
  return (
    <section className="pm-card" aria-labelledby="pm-tax-h">
      <div className="pm-card-head"><h3 id="pm-tax-h">Payee &amp; tax</h3></div>
      <dl className="dl">
        {profile.payeeTax!.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {profile.taxNotes && (
        <ul className="pm-notes">
          {profile.taxNotes.map((n) => <li key={n} className="sub">{n}</li>)}
        </ul>
      )}
    </section>
  )
}

function PaymentSuggestion({ claim, profile }: { claim: Claim; profile: PaymentProfile }) {
  const { user } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const s = profile.suggestion!
  async function decide(choice: 'accepted' | 'dismissed') {
    setBusy(true)
    await decidePaymentSuggestion(claim.id, choice, user.name)
    setBusy(false)
    toast(choice === 'accepted' ? `Task created: ${s.creates}` : 'Suggestion dismissed · logged')
  }
  return (
    <section className="section pm-suggest" aria-label="Also suggested">
      <div className="section-head"><h3>Also suggested</h3><span className="aside">Advisory and logged · accepting creates a task; the change stays with you</span></div>
      <ProposedCard s={s} busy={busy} onAccept={() => decide('accepted')} onDismiss={() => decide('dismissed')} />
    </section>
  )
}

// ---------------------------------------------------------------- Fast track: confirm payment and close (Pierce)

/** After a fast-track approval: watch the EFTs release, then close the claim with its closing letter. */
function FastTrackClose({ claim, rows }: { claim: Claim; rows: PaymentRow[] }) {
  const { user } = useSession()
  const toast = useToast()
  const { data: records } = useQuery(() => listDecisions(claim.id), [claim.id])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const closed = claim.tags.some((t) => t.label === 'Closed')
  const scheduled = rows.filter((r) => r.status.label === 'Scheduled')
  const allPaid = rows.every((r) => r.status.tone === 'positive')
  const total = sum(rows.map((r) => r.amount))
  const rec = records?.[0]

  async function release() {
    setBusy(true)
    try {
      const n = await markReleased(claim.id, user.name)
      toast(`${n} EFTs marked paid (demo) · logged`)
    } finally { setBusy(false) }
  }
  async function close() {
    setBusy(true)
    try {
      await closeClaim(claim.id, user.name)
      toast('Claim closed · closing letter LTR-L-190 queued')
    } catch (e) { toast((e as Error).message) } finally { setBusy(false); setConfirming(false) }
  }

  if (closed) {
    return (
      <div className="pm-closed" role="status">
        <ToneShape tone="positive" size={12} />
        <div className="grow"><strong>Claim closed {fmtDate(TODAY)}.</strong> {fmtMoney(total)} paid in {rows.length} EFTs. The closing letter is queued and the history is complete.</div>
        <Link className="btn btn--sm" to={`/claims/${claim.id}/history`}>History</Link>
      </div>
    )
  }

  const items: { label: string; detail: string; done: boolean }[] = [
    { label: 'Decision recorded', detail: rec ? `v${rec.version} · ${rec.recordedBy} · ${rec.outcomeText}` : 'Locked record', done: true },
    { label: `EFTs release ${fmtDate(rows[0]?.payDate ?? TODAY)}`, detail: allPaid ? `${rows.length} paid · ${fmtMoney(total)}` : `${scheduled.length} scheduled · ${fmtMoney(sum(scheduled.map((r) => r.amount)))}`, done: allPaid },
    { label: 'Letters go with the payment', detail: 'Approval LTR-L-101 to Margaret · assignment notice LTR-L-118 to Linden Grove', done: true },
    { label: '1099-INT noted for January', detail: '$373.97 interest to Margaret by 31 Jan 2027', done: true },
  ]
  return (
    <section className="pm-card pm-close" aria-labelledby="pm-close-h">
      <div className="pm-card-head">
        <h3 id="pm-close-h">Confirm payment and close</h3>
        <span className="grow" />
        <span className="sub">{items.filter((i) => i.done).length} of {items.length} done</span>
      </div>
      <ol className="pm-steps pm-steps--row">
        {items.map((i) => (
          <li key={i.label} className={`pm-step pm-step--${i.done ? 'done' : 'current'}`}>
            <StepMark state={i.done ? 'done' : 'current'} />
            <div><div className="pm-step-label">{i.label}</div><div className="sub">{i.detail}</div></div>
          </li>
        ))}
      </ol>
      {confirming ? (
        <div className="wb-confirm" role="alert">
          <Icon name="lock" size={16} color="var(--accent)" />
          <span className="grow">Close this claim? Open work items are completed, the history is written and the closing letter LTR-L-190 is queued to Margaret. It can be reopened later with a reason.</span>
          <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
          <button type="button" className="btn btn--primary btn--sm" onClick={close} disabled={busy}>{busy ? 'Closing…' : 'Confirm close'}</button>
        </div>
      ) : (
        <div className="pm-close-foot">
          <span className="sub grow">
            {allPaid ? 'Both EFTs are paid. Closing sends the thank-you letter and finishes the claim.' : `Payments release on ${fmtDate(rows[0]?.payDate ?? TODAY)}; the bank file confirms them. In the demo you can mark them released now.`}
          </span>
          {!allPaid && <button type="button" className="btn btn--sm" onClick={release} disabled={busy || !scheduled.length}>Mark released (demo)</button>}
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setConfirming(true)} disabled={!allPaid} title={allPaid ? undefined : 'Every payment must be paid first'}>Close claim</button>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Survivor payments & recovery (Ellison)

/** A death during payout: what happened, the overpayment worked out, and a kind recovery plan. */
function SurvivorPanel({ claim, profile, drafts }: { claim: Claim; profile: PaymentProfile; drafts: PaymentDraft[] }) {
  const { user } = useSession()
  const toast = useToast()
  const sv = profile.survivor!
  const [plan, setPlan] = useState(sv.plans[0].id)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const done = drafts.some((d) => d.kind === 'survivor')

  async function record() {
    setBusy(true)
    try {
      await setUpSurvivor({ claimId: claim.id, plan, by: user.name })
      toast('Survivor payments set up · recovery plan recorded')
      setOpen(false)
    } finally { setBusy(false) }
  }

  return (
    <section className="pm-card" aria-labelledby="pm-surv-h">
      <div className="pm-card-head">
        <h3 id="pm-surv-h">Paid after death · survivor continues</h3>
        <span className="grow" />
        {done ? <Tag tone="positive">Survivor payments set up</Tag> : <Tag tone="caution">$2,840.00 to recover</Tag>}
      </div>
      <div className="pm-surv">
        <div>
          <dl className="dl">{sv.contract.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          <div className="pm-label" style={{ marginTop: 12 }}>What happened</div>
          <dl className="dl">{sv.events.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </div>
        <div>
          <div className="pm-label">Calculation</div>
          <CalcTable rows={sv.calc} />
          <div className="pm-label" style={{ marginTop: 12 }}>When the plan is recorded</div>
          <ul className="pm-bullets">{sv.whenRecorded.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      </div>
      <div className="pm-close-foot">
        <span className="sub grow">{done ? 'Next: send Ruth the survivor letter. It opens with condolences and asks how she would like to settle.' : 'Nothing is taken from Ruth until she agrees to a plan.'}</span>
        {done
          ? <Link className="btn btn--primary btn--sm" to={`/claims/${claim.id}/communications/LTR-A-305`}>Send Ruth the survivor letter<Icon name="arrowRight" size={12} /></Link>
          : <button type="button" className="btn btn--primary btn--sm" onClick={() => setOpen(true)}>Set up survivor payments</button>}
      </div>
      {open && (
        <Drawer title="Set up survivor payments" onClose={() => setOpen(false)} width={520} footer={
          <>
            <span className="sub grow">Logged with your name. The offset waits on Ruth’s agreement.</span>
            <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={record} disabled={busy}>{busy ? 'Recording…' : 'Record recovery plan'}</button>
          </>
        }>
          <p className="soft">George’s payments stop and Ruth’s survivor benefit of $1,420.00 a month starts on 1 Oct. Choose how the {fmtMoney(2840)} overpaid is recovered.</p>
          <fieldset className="pm-fieldset">
            <legend className="pm-label">Recovery plan</legend>
            {sv.plans.map((p) => (
              <label key={p.id} className={cx('pm-option', plan === p.id && 'pm-option--on')}>
                <input type="radio" name="plan" checked={plan === p.id} onChange={() => setPlan(p.id)} />
                <span><strong>{p.label}</strong><span className="sub" style={{ display: 'block' }}>{p.detail}</span></span>
              </label>
            ))}
          </fieldset>
          <div>
            <div className="pm-label">When the plan is recorded</div>
            <ul className="pm-bullets">{sv.whenRecorded.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        </Drawer>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Return to work (Priya Raman)

/** Confirms the return-to-work date that ends the benefit and fixes the final prorated payment. */
function ReturnToWork({ claim, drafts }: { claim: Claim; drafts: PaymentDraft[] }) {
  const { user } = useSession()
  const toast = useToast()
  const [date, setDate] = useState('2026-10-05')
  const [busy, setBusy] = useState(false)
  const done = drafts.find((d) => d.kind === 'returnToWork')
  const planned = '2026-10-05'
  const changed = date !== planned
  const lastDay = addDays(date, -1)
  const days = daysFrom('2026-09-07', lastDay) + 1

  async function confirm() {
    setBusy(true)
    try {
      if (changed) {
        await flagReturnDateChange({ claimId: claim.id, date, by: user.name })
        toast('Task created to review the approval · logged')
      } else {
        await confirmReturnToWork({ claimId: claim.id, date, by: user.name })
        toast('Return to work confirmed · final payment stays $8,400.00 on 6 Oct')
      }
    } finally { setBusy(false) }
  }

  return (
    <section className="pm-card" aria-labelledby="pm-rtw-h">
      <div className="pm-card-head">
        <h3 id="pm-rtw-h">Return to work</h3>
        <span className="grow" />
        {done ? <Tag tone="positive">Confirmed {fmtDate(planned, { weekday: true })}</Tag> : <Tag tone="info">Expected Mon 5 Oct</Tag>}
      </div>
      {done ? (
        <p className="soft">Benefit ends 4 Oct. The final payment of $8,400.00 (28 of 30 days) releases on 6 Oct; the claim can close after it clears.</p>
      ) : (
        <>
          <p className="soft">Priya wrote in the portal on 24 Sep: “My surgeon signed me off for Monday the 5th.” Confirm the date so the final payment is right.</p>
          <div className="pm-rtw">
            <div className="field" style={{ width: 180 }}>
              <label htmlFor="pm-rtw-date">Back at work on</label>
              <input id="pm-rtw-date" type="date" className="input" value={date} min="2026-09-08" onChange={(e) => setDate(e.target.value || planned)} />
            </div>
            <div className="sub grow">
              {changed
                ? date > planned
                  ? `Approved only through 4 Oct. ${fmtDate(date)} would need the approval extended — this creates a review task; nothing is paid for extra days until then.`
                  : `Ends benefits on ${fmtDate(lastDay)} · final payment ${fmtMoney(Math.round((9000 * Math.max(0, days)) / 30 * 100) / 100)} (${Math.max(0, days)} of 30 days). This creates a review task; the scheduled $8,400.00 is unchanged until then.`
                : 'Benefit ends 4 Oct · final payment $8,400.00 (28 of 30 days) on 6 Oct.'}
            </div>
            <button type="button" className={cx('btn btn--sm', !changed && 'btn--primary')} onClick={confirm} disabled={busy}>
              {changed ? 'Flag for review' : 'Confirm return to work'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Action drawers

function payeesOf(claim: Claim, rows: PaymentRow[]): { name: string; method: string }[] {
  const out = new Map<string, string>()
  rows.forEach((r) => r.method !== '—' && !out.has(r.payee) && out.set(r.payee, r.method))
  claim.parties.filter((p) => p.roles.some((r) => ['Beneficiary', 'Claimant', 'Payee', 'Assignee'].includes(r))).forEach((p) => !out.has(p.name) && out.set(p.name, 'Check'))
  return [...out].map(([name, method]) => ({ name, method }))
}

/** One-time payment: requested here, released only after a second person approves. */
function OneTimeDrawer({ claim, rows, onClose }: { claim: Claim; rows: PaymentRow[]; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const payees = payeesOf(claim, rows)
  const [payee, setPayee] = useState(payees[0]?.name ?? '')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('Retroactive benefit')
  const [note, setNote] = useState('')
  const [payDate, setPayDate] = useState(addDays(TODAY, 3))
  const method = payees.find((p) => p.name === payee)?.method ?? 'Check'
  const n = Number(amount.replace(/[$,]/g, ''))
  const valid = payee && n > 0 && note.trim()

  async function submit() {
    await draftOneTimePayment({ claimId: claim.id, payee, amount: n, reason: `${reason} — ${note.trim()}`, payDate, method, by: user.name })
    toast(`One-time payment of ${fmtMoney(n)} sent for approval · logged`)
    onClose()
  }
  return (
    <Drawer title="One-time payment" onClose={onClose} width={520} footer={
      <><span className="sub grow">Released only after a second person approves.</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={submit} disabled={!valid}>Request payment</button></>
    }>
      <div className="field"><label htmlFor="ot-payee">Payee</label>
        <select id="ot-payee" className="select" value={payee} onChange={(e) => setPayee(e.target.value)}>{payees.map((p) => <option key={p.name}>{p.name}</option>)}</select>
        <span className="sub">Paid by {method}</span>
      </div>
      <div className="pm-form-row">
        <div className="field"><label htmlFor="ot-amt">Amount</label><input id="ot-amt" className="input" inputMode="decimal" placeholder="$0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label htmlFor="ot-date">Pay date</label><input id="ot-date" type="date" className="input" value={payDate} min={TODAY} onChange={(e) => setPayDate(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="ot-reason">Reason</label>
        <select id="ot-reason" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
          {['Retroactive benefit', 'Interest correction', 'Reimbursement', 'Reissue of a returned payment', 'Other'].map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="ot-note">Why this payment is owed</label><textarea id="ot-note" className="textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)} /><span className="sub">Kept on the payment record and in the history.</span></div>
    </Drawer>
  )
}

/** Adjust benefit: creates a draft for review. Scheduled payments don't change until it is approved. */
function AdjustDrawer({ claim, profile, onClose }: { claim: Claim; profile: PaymentProfile; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const current = profile.tiles.find((t) => t.label === 'Monthly benefit')?.value ?? ''
  const [amount, setAmount] = useState('')
  const [effective, setEffective] = useState('2026-11-01')
  const [basis, setBasis] = useState('COLA rider')
  const [reason, setReason] = useState('')
  const n = Number(amount.replace(/[$,]/g, ''))
  const cur = Number(current.replace(/[$,]/g, ''))
  const valid = n > 0 && reason.trim()
  async function submit() {
    await draftBenefitAdjustment({ claimId: claim.id, amount: n, effective, reason: `${basis}: ${reason.trim()}`, by: user.name })
    toast('Adjustment drafted · sent for review · logged')
    onClose()
  }
  return (
    <Drawer title="Adjust benefit" onClose={onClose} width={520} footer={
      <><span className="sub grow">Creates a draft and a review task.</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={submit} disabled={!valid}>Create draft</button></>
    }>
      <div className="callout-info"><Icon name="help" size={16} color="var(--accent)" /><span>Nothing changes money silently: the scheduled payments stay as they are until a reviewer approves this draft.</span></div>
      <dl className="dl"><dt>Current</dt><dd>{current || '—'} a month</dd></dl>
      <div className="pm-form-row">
        <div className="field"><label htmlFor="ad-amt">New monthly benefit</label><input id="ad-amt" className="input" inputMode="decimal" placeholder="$0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label htmlFor="ad-eff">Effective</label><input id="ad-eff" type="date" className="input" value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
      </div>
      {n > 0 && cur > 0 && <p className="sub">{n >= cur ? 'Increase' : 'Decrease'} of {fmtMoney(Math.abs(n - cur))} a month.</p>}
      <div className="field"><label htmlFor="ad-basis">Provision</label>
        <select id="ad-basis" className="select" value={basis} onChange={(e) => setBasis(e.target.value)}>
          {['COLA rider', 'Residual disability', 'Partial disability', 'Benefit schedule correction', 'Other'].map((r) => <option key={r}>{r}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="ad-reason">Reason and evidence</label><textarea id="ad-reason" className="textarea" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Drawer>
  )
}

/** Record overpayment: works out the amount and a proposed recovery; nothing is offset until agreed. */
function OverpaymentDrawer({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const [amount, setAmount] = useState('')
  const [cause, setCause] = useState('Paid after return to work')
  const [recovery, setRecovery] = useState('Offset from future payments, with the payee’s agreement')
  const n = Number(amount.replace(/[$,]/g, ''))
  async function submit() {
    await recordOverpayment({ claimId: claim.id, amount: n, cause, recovery, by: user.name })
    toast(`Overpayment of ${fmtMoney(n)} recorded · recovery drafted · logged`)
    onClose()
  }
  return (
    <Drawer title="Record overpayment" onClose={onClose} width={520} footer={
      <><span className="sub grow">Creates a recovery draft and a task.</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={submit} disabled={!(n > 0)}>Record overpayment</button></>
    }>
      <div className="pm-form-row">
        <div className="field"><label htmlFor="op-amt">Amount overpaid</label><input id="op-amt" className="input" inputMode="decimal" placeholder="$0.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div className="field"><label htmlFor="op-cause">Cause</label>
          <select id="op-cause" className="select" value={cause} onChange={(e) => setCause(e.target.value)}>
            {['Paid after return to work', 'Paid after death', 'Offset not applied', 'Duplicate payment', 'Other'].map((r) => <option key={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <fieldset className="pm-fieldset">
        <legend className="pm-label">Proposed recovery</legend>
        {['Offset from future payments, with the payee’s agreement', 'Repay by check', 'Refer for waiver review (hardship)'].map((r) => (
          <label key={r} className={cx('pm-option', recovery === r && 'pm-option--on')}>
            <input type="radio" name="recovery" checked={recovery === r} onChange={() => setRecovery(r)} />
            <span>{r}</span>
          </label>
        ))}
      </fieldset>
      <p className="sub">State rules limit how much can be offset from each payment. The recovery letter explains the amount, why, and the payee’s options.</p>
    </Drawer>
  )
}
