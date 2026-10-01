import { useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { getBeneficiaryPayment, type BeneficiaryPaymentView } from '../api/portal'
import { PIERCE } from '../api/fixtures/portal'
import { fmtDate } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { ContactRow, Done, MoneyRows, PhoneApp, PtIcon, PtLoading, PtTag, Sheet, Tracker } from './parts'
import { Messages } from './Messages'

const NAME = 'Margaret Pierce'
const BASE = '/portal/margaret'
const signed = (n: number) => `${n < 0 ? '−' : '+'}${fmtMoney(Math.abs(n))}`

/** Margaret Pierce, life beneficiary (board 07.6). Reacts live to the examiner recording the decision. */
export function MargaretApp() {
  const { data } = useQuery(() => getBeneficiaryPayment(PIERCE.claimId, NAME), [])
  return (
    <PhoneApp base={BASE} account={NAME}>
      <Routes>
        <Route index element={<MargaretHome view={data} />} />
        <Route path="tasks" element={<MargaretTasks />} />
        <Route path="payments" element={<BeneficiaryPayment view={data} />} />
        <Route path="messages" element={<Messages claimId={PIERCE.claimId} from={NAME} team="Rachel Kim, your claims examiner" />} />
      </Routes>
    </PhoneApp>
  )
}

function MargaretHome({ view }: { view?: BeneficiaryPaymentView }) {
  if (!view) return <div className="pt-page"><PtLoading /></div>
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Hi Margaret</h1>
      <section className="pt-card pt-stack-10" aria-labelledby="pt-claim-h">
        <div className="pt-card-head">
          <h2 id="pt-claim-h" className="pt-h2">Harold’s life insurance</h2>
          <span className="pt-mono">{PIERCE.claimId}</span>
        </div>
        <Tracker
          steps={[
            { label: 'Submitted', state: 'done', meta: fmtDate(PIERCE.submitted) },
            { label: 'We have everything', state: 'done', meta: fmtDate(PIERCE.allReceived) },
            view.decided
              ? { label: 'Approved', state: 'done', meta: fmtDate(view.decidedOn!) }
              : { label: 'Decision', state: 'current', detail: `We’re reviewing your claim — decision by ${fmtDate(PIERCE.decideBy)}` },
            view.decided
              ? { label: 'Payment', state: 'current', detail: `${fmtMoney(view.amount)} arrives by direct deposit on ${fmtDate(view.payDate)}` }
              : { label: 'Payment', state: 'todo', meta: 'After the decision' },
          ]}
        />
        <Link to={`${BASE}/payments`} className={view.decided ? 'pt-btn pt-btn--primary' : 'pt-btn'}>
          {view.decided ? 'See your payment' : 'What happens next'}
          <PtIcon name="arrowRight" size={16} strokeWidth={1.6} />
        </Link>
      </section>
      <Done title="Nothing needed from you">
        <span className="pt-soft">You sent everything we need. Thank you.</span>
      </Done>
      <ContactRow initials="RK" role="Your claims examiner" name="Rachel Kim" messagesTo={`${BASE}/messages`} />
    </div>
  )
}

function MargaretTasks() {
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Tasks</h1>
      <Done title="Nothing needed from you">
        <span className="pt-soft">You sent everything we need. We’ll tell you here as soon as there’s news.</span>
      </Done>
    </div>
  )
}

/** Board 07.6 — decision and payment. Shows the review state until a decision is recorded. */
function BeneficiaryPayment({ view }: { view?: BeneficiaryPaymentView }) {
  const [letter, setLetter] = useState(false)
  if (!view) return <div className="pt-page"><PtLoading /></div>
  return (
    <div className="pt-page">
      <div className="pt-stack-4">
        <h1 className="pt-h1">Harold’s life insurance claim</h1>
        <div className="pt-row-wrap">
          <span className="pt-mono">{PIERCE.claimId}</span>
          {view.decided ? <PtTag tone="positive">Approved {fmtDate(view.decidedOn!)}</PtTag> : <PtTag tone="info">In review</PtTag>}
        </div>
      </div>

      {view.decided ? (
        <>
          <section className="pt-card pt-card--pad pt-stack-8" aria-labelledby="pt-pay-h">
            <h2 id="pt-pay-h" className="pt-kicker">Your payment</h2>
            <span className="pt-amount pt-num">{fmtMoney(view.amount)}</span>
            <p className="pt-soft">
              Arrives by direct deposit on <strong className="pt-ink">{fmtDate(view.payDate)}</strong> to account ending {view.account}
            </p>
            <MoneyRows rows={PIERCE.lines.map((l, i) => ({ label: l.label, value: i === 0 ? fmtMoney(l.amount) : signed(l.amount) }))} total={{ label: 'Total to you', value: fmtMoney(view.amount) }} />
          </section>

          <button type="button" className="pt-rowlink" onClick={() => setLetter(true)}>
            <PtIcon name="doc" />
            <span className="grow">Approval letter (PDF)</span>
            <PtIcon name="chevronRight" />
          </button>

          <section className="pt-well pt-stack-4" aria-labelledby="pt-tax-h">
            <h2 id="pt-tax-h" className="pt-h3">Tax information</h2>
            <p>The interest ({fmtMoney(PIERCE.interest)}) is taxable; we’ll send you a 1099-INT by 31 Jan 2027. The insurance benefit itself is generally not taxable income.</p>
          </section>
          <section className="pt-stack-4" aria-labelledby="pt-why-h">
            <h2 id="pt-why-h" className="pt-h3">About the amounts</h2>
            <p className="pt-soft">Interest is added from the day Harold died until the day we pay. Harold’s premium was paid through 30 Sep, so we’re refunding the part of September after his death.</p>
          </section>
        </>
      ) : (
        <section className="pt-card pt-card--pad pt-stack-8" aria-labelledby="pt-rev-h">
          <h2 id="pt-rev-h" className="pt-h2">We’re reviewing your claim — decision by {fmtDate(PIERCE.decideBy)}</h2>
          <p>You sent everything we need. Rachel Kim, your claims examiner, is checking the policy and the paperwork now.</p>
          <ul className="pt-checks">
            <li><PtIcon name="check" size={16} strokeWidth={1.8} />Claim, death certificate and W-9 received 3 Sep</li>
            <li><PtIcon name="check" size={16} strokeWidth={1.8} />Funeral home invoice received 23 Sep</li>
          </ul>
          <p className="pt-soft">Interest is added to the benefit from 29 Aug until the day we pay, so waiting doesn’t cost you.</p>
        </section>
      )}

      <section className="pt-stack-8" aria-labelledby="pt-q-h">
        <div>
          <h2 id="pt-q-h" className="pt-h3">Questions?</h2>
          <p>Rachel Kim, your claims examiner</p>
        </div>
        <div className="pt-two">
          <a href="tel:+15550103000" className="pt-btn"><PtIcon name="phone" />Call</a>
          <Link to={`${BASE}/messages`} className="pt-btn"><PtIcon name="messages" />Message</Link>
        </div>
      </section>

      {letter && (
        <Sheet title="Approval letter" onClose={() => setLetter(false)} footer={<button type="button" className="pt-btn pt-btn--primary pt-btn--block" onClick={() => setLetter(false)}>Close</button>}>
          <div className="pt-letter">
            <p>Dear Mrs. Pierce,</p>
            <p>We’re sorry for the loss of your husband, Harold. We have approved your claim under his term life policy LP-1107752.</p>
            <p>We’ll pay {fmtMoney(view.amount)} to your account ending {view.account} on {fmtDate(view.payDate)}. This includes interest from 29 Aug and a refund of September’s premium, after paying $9,850.00 to Linden Grove Funeral Home as you asked.</p>
            <p>Rachel Kim · Claims examiner</p>
          </div>
        </Sheet>
      )}
    </div>
  )
}
