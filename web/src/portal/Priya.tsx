import { useCallback, useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { listReturnToWork, reportReturnToWork } from '../api/portal'
import { PRIYA } from '../api/fixtures/portal'
import { fmtDate } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { cx } from '../lib/cx'
import { ContactRow, Done, MoneyRows, PhoneApp, PtIcon, PtTag, Sheet, Tracker } from './parts'
import { Messages } from './Messages'

const NAME = 'Priya Raman'
const BASE = '/portal/priya'

/** Priya Raman, DI claimant on payments (board 07.4): next payment, history and return to work. */
export function PriyaApp() {
  return (
    <PhoneApp base={BASE} account={NAME}>
      <Routes>
        <Route index element={<PriyaHome />} />
        <Route path="tasks" element={<PriyaTasks />} />
        <Route path="payments" element={<PriyaPayments />} />
        <Route path="messages" element={<Messages claimId={PRIYA.claimId} from={NAME} team="Jordan Ellis, your case manager" />} />
      </Routes>
    </PhoneApp>
  )
}

function PriyaHome() {
  const n = PRIYA.next
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Hi Priya</h1>
      <section className="pt-card pt-stack-10" aria-labelledby="pt-claim-h">
        <div className="pt-card-head">
          <h2 id="pt-claim-h" className="pt-h2">Disability income</h2>
          <span className="pt-mono">{PRIYA.claimId}</span>
        </div>
        <Tracker
          steps={[
            { label: 'Submitted', state: 'done', meta: fmtDate(PRIYA.submitted) },
            { label: 'Approved', state: 'done', meta: fmtDate(PRIYA.approved) },
            { label: 'Payments', state: 'current', detail: `Next: ${fmtMoney(n.amount)} on ${fmtDate(n.payDate, { weekday: true })}` },
            { label: 'Back to work', state: 'todo', meta: `Expected ${fmtDate(PRIYA.returnDate, { weekday: true })}` },
          ]}
        />
        <Link to={`${BASE}/payments`} className="pt-btn">
          See payments and return to work
          <PtIcon name="arrowRight" size={16} strokeWidth={1.6} />
        </Link>
      </section>
      <Done title="Nothing needed from you right now">
        <span className="pt-soft">Tell us if your return date changes.</span>
      </Done>
      <ContactRow initials="JE" role="Your case manager" name="Jordan Ellis" messagesTo={`${BASE}/messages`} />
    </div>
  )
}

function PriyaTasks() {
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Tasks</h1>
      <Done title="Nothing needed from you right now">
        <span className="pt-soft">If your return date changes, tell us on <Link to={`${BASE}/payments`}>Payments</Link>.</span>
      </Done>
    </div>
  )
}

/** Board 07.4 — payments and return to work. */
function PriyaPayments() {
  const [form, setForm] = useState<'sooner' | 'later' | null>(null)
  const close = useCallback(() => setForm(null), [])
  const { data: reports } = useQuery(() => listReturnToWork(PRIYA.claimId), [])
  const latest = reports?.[0]
  const n = PRIYA.next
  return (
    <div className="pt-page">
      <div className="pt-stack-4">
        <h1 className="pt-h1">Payments</h1>
        <div className="pt-row-wrap">
          <span className="pt-soft">Disability income</span>
          <PtTag tone="positive">Approved through {fmtDate(PRIYA.approvedThrough)}</PtTag>
        </div>
      </div>

      <section className="pt-card pt-card--pad pt-stack-8" aria-labelledby="pt-next-h">
        <h2 id="pt-next-h" className="pt-kicker">Next payment</h2>
        <div className="pt-amount-row">
          <span className="pt-amount pt-num">{fmtMoney(n.amount)}</span>
          <span className="pt-strong">{fmtDate(n.payDate, { weekday: true })}</span>
        </div>
        <p className="pt-soft">To account ending {PRIYA.account} · for {n.period}</p>
        <MoneyRows
          rows={[
            { label: 'Monthly benefit', value: fmtMoney(PRIYA.monthly) },
            { label: n.days, value: fmtMoney(n.amount) },
            { label: 'Tax withheld', value: fmtMoney(n.tax) },
          ]}
          total={{ label: 'You receive', value: fmtMoney(n.amount - n.tax) }}
        />
        <p className="pt-soft pt-small">Benefits are generally not taxable when you pay the premiums yourself.</p>
      </section>

      <section className="pt-stack-4" aria-labelledby="pt-paid-h">
        <h2 id="pt-paid-h" className="pt-h2">Paid so far</h2>
        <ul className="pt-list pt-list--ruled">
          {PRIYA.paid.map((p) => (
            <li key={p.id} className="pt-paid">
              <span>
                <strong>{fmtDate(p.payDate)}</strong> · <span className="pt-num">{fmtMoney(p.amount)}</span> · <span className="pt-soft">for {p.period}</span>
              </span>
              <PtTag tone="positive">Paid</PtTag>
            </li>
          ))}
        </ul>
      </section>

      <section className="pt-stack-8" aria-labelledby="pt-rtw-h">
        <div>
          <h2 id="pt-rtw-h" className="pt-h2">Return to work</h2>
          <p className="pt-soft">
            Expected back: <strong className="pt-ink">{fmtDate(PRIYA.returnDate, { weekday: true })}</strong>
          </p>
        </div>
        {latest && (
          <Done title={latest.kind === 'sooner' ? `You told us you’re going back ${fmtDate(latest.date, { weekday: true })}` : `You asked for more time, to ${fmtDate(latest.date, { weekday: true })}`}>
            <span className="pt-soft">Jordan Ellis will confirm {latest.kind === 'sooner' ? 'your last payment' : 'with your doctor'} by Tue 29 Sep.</span>
          </Done>
        )}
        <div className="pt-btnrow">
          <button type="button" className="pt-btn" onClick={() => setForm('sooner')}>I’m going back sooner</button>
          <button type="button" className="pt-btn" onClick={() => setForm('later')}>I need more time</button>
        </div>
        <p><strong>Going back part-time first?</strong> <span className="pt-soft">You may get a partial benefit.</span></p>
      </section>

      {form && <ReturnSheet kind={form} onClose={close} />}
    </div>
  )
}

/** Short form for a changed return-to-work date. Logs and tells the case manager. */
function ReturnSheet({ kind, onClose }: { kind: 'sooner' | 'later'; onClose: () => void }) {
  const sooner = kind === 'sooner'
  const [date, setDate] = useState(sooner ? '2026-10-01' : '2026-10-19')
  const [hours, setHours] = useState<'full' | 'part'>('full')
  const [note, setNote] = useState('')
  const [done, setDone] = useState(false)

  async function submit() {
    const detail = sooner ? `${hours === 'full' ? 'Full time' : 'Part time first'}${note ? ` · “${note}”` : ''}` : note ? `“${note}”` : ''
    await reportReturnToWork({ claimId: PRIYA.claimId, claimant: NAME, kind, date, detail })
    setDone(true)
  }

  return (
    <Sheet
      title={done ? 'Thanks, Priya' : sooner ? 'I’m going back sooner' : 'I need more time'}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--block" onClick={onClose}>Done</button>
        ) : (
          <button type="submit" form="pt-rtw-form" className="pt-btn pt-btn--primary pt-btn--block" disabled={!date}>Send to Jordan Ellis</button>
        )
      }
    >
      {done ? (
        sooner ? (
          <Done title={`We’ve noted you’re going back ${fmtDate(date, { weekday: true })}`}>
            <span className="pt-soft">Your last payment will cover up to the day before. Jordan Ellis will confirm the amount by Tue 29 Sep.{hours === 'part' ? ' Because you’re starting part time, you may get a partial benefit — Jordan will explain.' : ''}</span>
          </Done>
        ) : (
          <Done title="We’ve asked for more time for you">
            <span className="pt-soft">We’ll ask your doctor to confirm the new date. Your payments continue while we check.</span>
          </Done>
        )
      ) : (
        <form id="pt-rtw-form" className="pt-stack-12" onSubmit={(e) => { e.preventDefault(); void submit() }}>
          <div className="pt-field">
            <label className="pt-label" htmlFor="pt-rtw-date">{sooner ? 'Your first day back' : 'When you now expect to go back'}</label>
            <input id="pt-rtw-date" type="date" className="pt-input" value={date} min={sooner ? '2026-09-26' : '2026-10-06'} max={sooner ? '2026-10-04' : undefined} onChange={(e) => setDate(e.target.value)} />
          </div>
          {sooner && (
            <fieldset className="pt-fieldset">
              <legend className="pt-label">Going back</legend>
              <div className="pt-two">
                {(['full', 'part'] as const).map((h) => (
                  <label key={h} className={cx('pt-choice', hours === h && 'pt-choice--on')}>
                    <input type="radio" name="pt-hours" checked={hours === h} onChange={() => setHours(h)} />
                    {h === 'full' ? 'Full time' : 'Part time first'}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="pt-field">
            <label className="pt-label" htmlFor="pt-rtw-note">{sooner ? 'Anything else we should know?' : 'What’s changed?'} <span className="pt-soft">(optional)</span></label>
            <textarea id="pt-rtw-note" className="pt-input pt-textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {!sooner && <p className="pt-soft pt-small">We’ll ask your doctor to confirm. You don’t need to get a form.</p>}
        </form>
      )}
    </Sheet>
  )
}
