import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { getFinancials, priorMonthly, requestFigures, residualBenefit, type EarningsInput, type ResidualWorkup } from '../../api/financials'
import { listTasks } from '../../api/tasks'
import { fmtCountdown, fmtDate, fmtTime } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { Avatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Financials.css'

/** 'Jun 2026', 'Jul 2026', 'Aug 2026' → 'Jun–Aug' */
const monthSpan = (ms: EarningsInput[]) => {
  const names = ms.map((m) => m.period.split(' ')[0])
  return names.length > 1 ? `${names[0]}–${names[names.length - 1]}` : names[0] ?? ''
}

const pctText = (n: number) => `${(n * 100).toFixed(1).replace(/\.0$/, '')}%`

/** The residual benefit worksheet: prior and current earnings, loss share and benefit — with the missing inputs left visibly empty. */
export function FinancialsSection({ claim }: SectionProps) {
  const { user } = useSession()
  const toast = useToast()
  const { data: w, loading } = useQuery(() => getFinancials(claim.id), [claim.id])
  const { data: tasks } = useQuery(() => listTasks(claim.id), [claim.id])

  if (loading && !w) return <Loading rows={8} />
  if (!w)
    return (
      <>
        <div className="page-head"><h2>Financials</h2></div>
        <div className="empty">No financial review on this claim in the mock.</div>
      </>
    )

  const missing = [...w.prior, ...w.current].filter((i) => i.status === 'missing')
  const analystTask = tasks?.find((t) => t.assignee === w.analyst)
  const reqTarget = missing.find((m) => m.requirementId)?.requirementId

  async function request() {
    try {
      await requestFigures(claim.id, 'Elena’s accountant', user)
      toast('Request sent to Elena’s accountant · logged')
    } catch (e) {
      toast((e as Error).message)
    }
  }

  return (
    <div className="fi">
      <div className="page-head">
        <h2>Financials</h2>
        <span className="aside">Residual disability · {w.policy} · {fmtMoney(w.monthlyBenefit)} monthly benefit</span>
        <span className="grow" />
        {missing.length > 0 && (
          <button type="button" className="btn btn--primary btn--sm" onClick={request}>
            <Icon name="send" size={13} />Request from her accountant
          </button>
        )}
      </div>

      <div className="fi-owner">
        <Avatar initials="HB" size={28} />
        <div className="grow">
          <div><span className="strong">{w.analyst}</span> · {w.analystTitle}</div>
          <div className="sub">Owns the residual calculation. Works from the tax returns and the monthly practice P&L.</div>
        </div>
        {analystTask && (
          <div className="fi-task">
            <Tag tone={analystTask.done ? 'positive' : 'neutral'}>{analystTask.done ? 'Done' : 'Open task'}</Tag>
            <span className="sub">{analystTask.title}</span>
          </div>
        )}
      </div>

      {missing.length > 0 && (
        <div className="fi-blocked" role="status">
          <Tag tone="caution">Can’t be calculated yet</Tag>
          <span>
            Waiting on {missing.filter((m) => w.prior.includes(m)).map((m) => `the ${m.label}`).join(', ')}
            {missing.some((m) => w.current.includes(m)) && ` and the practice P&L for ${monthSpan(w.current.filter((m) => m.status === 'missing'))}`}.
          </span>
          <span className="grow" />
          {reqTarget && <Link to={`/claims/${claim.id}/requirements/${reqTarget}`} className="strong nowrap" style={{ fontSize: 12 }}>See requirements</Link>}
        </div>
      )}

      <div className="fi-cols">
        <Worksheet w={w} />
        <div className="fi-side">
          <Example w={w} />
          <section className="section" aria-labelledby="fi-def-h">
            <h3 id="fi-def-h" className="fi-h">Policy definitions</h3>
            <dl className="fi-defs">
              {w.definitions.map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          </section>
          <section className="section" aria-labelledby="fi-money-h">
            <h3 id="fi-money-h" className="fi-h">Benefit facts</h3>
            <dl className="dl">
              <dt>Monthly benefit</dt><dd>{fmtMoney(w.monthlyBenefit)} before the residual share</dd>
              <dt>Disabled since</dt><dd>{fmtDate(w.disabledSince, { year: true })} · two clinical days a week</dd>
              <dt>Elimination</dt><dd>90 days · satisfied {fmtDate(w.eliminationMet)}</dd>
              <dt>Tax</dt><dd>Not taxable · premiums paid personally</dd>
            </dl>
          </section>
          {w.requests.length > 0 && (
            <section className="section" aria-labelledby="fi-req-h">
              <h3 id="fi-req-h" className="fi-h">Requests from this screen</h3>
              <ul className="fi-requests">
                {w.requests.map((r) => (
                  <li key={r.at + r.items} className="sub">
                    <span className="strong" style={{ color: 'var(--ink)' }}>{fmtDate(r.at)} {fmtTime(r.at)}</span> · {r.to} · {r.items} · {r.by}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

/** An input that hasn't arrived: an empty, dashed slot that says what fills it. */
function Slot({ children }: { children: ReactNode }) {
  return <span className="fi-slot">{children}</span>
}

function InputStatus({ i }: { i: EarningsInput }) {
  if (i.status === 'received') return <Tag tone="positive">Received {i.received ? fmtDate(i.received) : ''}</Tag>
  return <Tag tone="caution">Missing{i.due ? ` · due ${fmtDate(i.due)}` : ''}</Tag>
}

function Worksheet({ w }: { w: ResidualWorkup }) {
  const prior = priorMonthly(w)
  const [y2025, y2024] = w.prior
  const lateYear = w.prior.find((p) => p.status === 'missing')
  const pctMin = pctText(w.minimumLoss)

  return (
    <section className="fi-sheet" aria-labelledby="fi-sheet-h">
      <div className="fi-sheet-head">
        <h3 id="fi-sheet-h">Residual benefit calculation</h3>
        <span className="sub">loss of earnings % × {fmtMoney(w.monthlyBenefit)} · minimum loss {pctMin}</span>
      </div>

      <div className="fi-step">
        <div className="fi-step-h"><span className="fi-n">1</span>Prior monthly earnings</div>
        <table className="tbl fi-tbl">
          <thead><tr><th>Source</th><th className="r">Year</th><th className="r">Monthly</th><th>Status</th></tr></thead>
          <tbody>
            {[y2025, y2024].map((p) => (
              <tr key={p.id}>
                <td>
                  <div className="strong">{p.label}</div>
                  {p.note && <div className="sub">{p.note}</div>}
                  {p.status === 'missing' && <div className="sub">Requested {fmtDate(p.requested!)}{p.followUps?.length ? ` · ${p.followUps.join(' · ')}` : ''}</div>}
                </td>
                <td className="r">{p.amount != null ? fmtMoney(p.amount) : <Slot>2024 return</Slot>}</td>
                <td className="r">{p.amount != null ? fmtMoney(p.amount / 12) : <Slot>—</Slot>}</td>
                <td><InputStatus i={p} /></td>
              </tr>
            ))}
            <tr className="fi-sum">
              <td colSpan={2}>Prior earnings · the higher of 2025 and the 2024–2025 average</td>
              <td className="r">{prior != null ? fmtMoney(prior) : <Slot>Can’t be calculated until the {lateYear?.label} arrives</Slot>}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="fi-step">
        <div className="fi-step-h"><span className="fi-n">2</span>Current earnings, loss and benefit by month</div>
        <table className="tbl fi-tbl">
          <thead>
            <tr><th>Month</th><th className="r">Current earnings</th><th className="r">Loss of earnings</th><th className="r">Residual benefit</th><th>P&L</th></tr>
          </thead>
          <tbody>
            {w.current.map((m) => {
              const r = prior != null && m.amount != null ? residualBenefit(prior, m.amount, w.monthlyBenefit, w.minimumLoss) : undefined
              return (
                <tr key={m.id}>
                  <td className="strong nowrap">{m.period}</td>
                  <td className="r">{m.amount != null ? fmtMoney(m.amount) : <Slot>P&L missing</Slot>}</td>
                  <td className="r">{r ? pctText(r.loss) : <Slot>—</Slot>}</td>
                  <td className="r">{r ? fmtMoney(r.benefit) : <Slot>—</Slot>}</td>
                  <td><InputStatus i={m} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="sub">
          Loss of earnings = (prior − current) ÷ prior. Residual benefit = loss of earnings × {fmtMoney(w.monthlyBenefit)}. A loss under {pctMin} pays nothing that month.
        </p>
      </div>

      <div className="fi-step fi-cant">
        <Icon name="lock" size={14} />
        <span>
          <strong>Can’t be calculated until</strong> the {w.prior.filter((p) => p.status === 'missing').map((p) => p.label).join(' and ')}
          {w.current.some((m) => m.status === 'missing') && ' and the Jun–Aug practice P&L'} arrive. Nothing is estimated from partial figures
          {w.current[0]?.due && <> · due {fmtDate(w.current[0].due)} ({fmtCountdown(w.current[0].due)})</>}.
        </span>
      </div>
    </section>
  )
}

/** A worked example with made-up figures, clearly labelled — never Elena's numbers. */
function Example({ w }: { w: ResidualWorkup }) {
  const [prior, setPrior] = useState(30_000)
  const [current, setCurrent] = useState(12_000)
  const r = residualBenefit(prior, current, w.monthlyBenefit, w.minimumLoss)
  const below = r.loss < w.minimumLoss
  return (
    <section className="fi-example" aria-labelledby="fi-ex-h">
      <div className="fi-ex-kicker">Example · not Elena’s figures</div>
      <h3 id="fi-ex-h" className="fi-h">How the formula works</h3>
      <div className="fi-ex-inputs">
        <div className="field">
          <label htmlFor="fi-ex-prior">Prior monthly earnings</label>
          <input id="fi-ex-prior" className="input" type="number" min={0} step={500} value={prior} onChange={(e) => setPrior(Math.max(0, Number(e.target.value)))} />
        </div>
        <div className="field">
          <label htmlFor="fi-ex-cur">Current monthly earnings</label>
          <input id="fi-ex-cur" className="input" type="number" min={0} step={500} value={current} onChange={(e) => setCurrent(Math.max(0, Number(e.target.value)))} />
        </div>
      </div>
      <ol className="fi-ex-steps">
        <li><span>Loss of earnings</span><span className="mono">({fmtMoney(prior)} − {fmtMoney(current)}) ÷ {fmtMoney(prior)}</span><strong>{pctText(r.loss)}</strong></li>
        <li><span>Residual benefit</span><span className="mono">{pctText(r.loss)} × {fmtMoney(w.monthlyBenefit)}</span><strong>{below ? '$0.00' : fmtMoney(r.benefit)}</strong></li>
      </ol>
      {below && <p className="fi-ex-note">Below the {pctText(w.minimumLoss)} minimum loss — no residual benefit for this month.</p>}
    </section>
  )
}
