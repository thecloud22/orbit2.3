import { useCallback, useState } from 'react'
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import {
  ELECTION_LABELS, getAnnuityShare, recordAnnuityElection, sendPortalMessage, submitAnnuityForm,
  type AnnuityForm, type AnnuityShareView, type ElectionOption,
} from '../api/portal'
import { HART } from '../api/fixtures/portal'
import { addDays, fmtDate, TODAY } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { cx } from '../lib/cx'
import { BackLink, ContactRow, Done, PhoneApp, PtIcon, PtLoading, Sheet, Tracker } from './parts'
import { Messages } from './Messages'

const NAME = HART.beneficiary
const BASE = '/portal/claire'
const CLAIM = HART.claimId

const OPTIONS: { key: ElectionOption; body: string }[] = [
  { key: 'lump', body: `Paid within 7 days of your forms. The gain (about ${fmtMoney(HART.gain).replace('.00', '')}) is taxable this year.` },
  { key: 'fiveYear', body: `Take amounts when you like until ${fmtDate(HART.fiveYearBy)}. Tax is due on the gain as you take it.` },
  { key: 'lifeExpectancy', body: `Regular payments that spread the tax. Must start by ${fmtDate(HART.lifeExpectancyBy)}.` },
]

/** Claire Hart-Lopez, annuity beneficiary (board 07.8): send forms, then choose how to receive her share. */
export function ClaireApp() {
  const { data } = useQuery(() => getAnnuityShare(CLAIM, NAME), [])
  const left = data ? [!data.statement, !data.w9].filter(Boolean).length + (data.election ? 0 : 1) : undefined
  return (
    <PhoneApp base={BASE} account={NAME} taskCount={data ? [!data.statement, !data.w9].filter(Boolean).length || (data.election ? 0 : 1) : undefined}>
      <Routes>
        <Route index element={<ClaireHome share={data} left={left} />} />
        <Route path="tasks" element={<AnnuityElection share={data} />} />
        <Route path="tasks/statement" element={<FormScreen form="statement" />} />
        <Route path="tasks/w9" element={<FormScreen form="w9" />} />
        <Route path="payments" element={<ClairePayments share={data} />} />
        <Route path="messages" element={<Messages claimId={CLAIM} from={NAME} team="Irene Walsh, your annuity specialist" />} />
      </Routes>
    </PhoneApp>
  )
}

function ClaireHome({ share, left }: { share?: AnnuityShareView; left?: number }) {
  if (!share) return <div className="pt-page"><PtLoading /></div>
  const formsIn = share.statement && share.w9
  const formsLeft = [!share.statement, !share.w9].filter(Boolean).length
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Hi Claire</h1>
      <section className="pt-card pt-stack-10" aria-labelledby="pt-claim-h">
        <div className="pt-card-head">
          <h2 id="pt-claim-h" className="pt-h2">Your mother’s annuity</h2>
          <span className="pt-mono">{CLAIM}</span>
        </div>
        <Tracker
          steps={[
            { label: 'We were told', state: 'done', meta: fmtDate(HART.notified) },
            formsIn ? { label: 'Your forms', state: 'done', meta: 'Received' } : { label: 'Your forms', state: 'current', detail: `${formsLeft} form${formsLeft > 1 ? 's' : ''} still needed from you` },
            share.election
              ? { label: 'Your choice', state: 'done', meta: ELECTION_LABELS[share.election.option] }
              : { label: 'Your choice', state: formsIn ? 'current' : 'todo', detail: 'All at once, over 5 years, or over your life expectancy' },
            { label: 'Payment', state: share.election ? 'current' : 'todo', meta: share.election?.option === 'lump' ? `By ${fmtDate(addDays(TODAY, 7))}` : 'After your choice' },
          ]}
        />
      </section>
      {left ? (
        <section className="pt-need" aria-labelledby="pt-need-h">
          <h2 id="pt-need-h" className="pt-need-h">
            <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1 9.4 8.8H.6Z" fill="currentColor" /></svg>
            What we need from you
          </h2>
          <div className="pt-stack-10">
            <div>
              <h3 className="pt-h3">{formsIn ? 'Choose how to receive your share' : 'Send two forms, then choose how to receive your share'}</h3>
              <p className="pt-soft">Your share is at least {fmtMoney(HART.guaranteed)}. It stays invested until your forms arrive.</p>
            </div>
            <Link to={`${BASE}/tasks`} className="pt-btn pt-btn--primary">
              {formsIn ? 'Choose now' : 'Get started'}
              <PtIcon name="arrowRight" size={16} strokeWidth={1.6} />
            </Link>
          </div>
        </section>
      ) : (
        <Done title="Nothing needed from you right now">
          <span className="pt-soft">You chose: {ELECTION_LABELS[share.election!.option].toLowerCase()}.</span>
        </Done>
      )}
      <ContactRow initials="IW" role="Your annuity specialist" name="Irene Walsh" messagesTo={`${BASE}/messages`} />
    </div>
  )
}

/** Board 07.8 — choose how to receive the share; forms first. */
function AnnuityElection({ share }: { share?: AnnuityShareView }) {
  const [option, setOption] = useState<ElectionOption>()
  const [step, setStep] = useState<'choose' | 'review'>('choose')
  const [error, setError] = useState<string>()
  const [paul, setPaul] = useState(false)
  const [saved, setSaved] = useState(false)
  const closePaul = useCallback(() => setPaul(false), [])
  const sent = (useLocation().state as { sent?: string } | null)?.sent

  if (!share) return <div className="pt-page"><PtLoading /></div>
  const formsIn = share.statement && share.w9

  if (share.election)
    return (
      <div className="pt-page">
        <h1 className="pt-h1">Your choice is recorded</h1>
        <Done title={ELECTION_LABELS[share.election.option]}>
          <span className="pt-soft">
            {share.election.option === 'lump'
              ? `We’ll pay at least ${fmtMoney(HART.guaranteed)} to your account by ${fmtDate(addDays(TODAY, 7))}.`
              : share.election.option === 'fiveYear'
                ? `Your share stays with us and you can take amounts when you like until ${fmtDate(HART.fiveYearBy)}. Irene Walsh will send you the withdrawal form.`
                : `Irene Walsh will send your payment schedule. Payments must start by ${fmtDate(HART.lifeExpectancyBy)}.`}
          </span>
        </Done>
        <p className="pt-soft">We’ll send a letter confirming your choice. Questions? Message Irene Walsh, your annuity specialist.</p>
        <Link to={BASE} className="pt-btn">Back to home</Link>
      </div>
    )

  if (step === 'review' && option)
    return (
      <div className="pt-page">
        <button type="button" className="pt-back" onClick={() => setStep('choose')}>
          <PtIcon name="chevronLeft" />
          Change my choice
        </button>
        <h1 className="pt-h1">Confirm your choice</h1>
        <section className="pt-card pt-card--pad pt-stack-8">
          <span className="pt-kicker">You chose</span>
          <span className="pt-h2">{ELECTION_LABELS[option]}</span>
          <p className="pt-soft">{OPTIONS.find((o) => o.key === option)!.body}</p>
          <p>Your share: at least <strong>{fmtMoney(HART.guaranteed)}</strong>, valued today because your forms are in.</p>
        </section>
        <p className="pt-soft pt-small">Once confirmed, this choice can’t be changed. We can’t give tax advice; a tax professional can.</p>
        <button
          type="button"
          className="pt-btn pt-btn--primary"
          onClick={() => void recordAnnuityElection(CLAIM, NAME, option).catch((e: Error) => { setError(e.message); setStep('choose') })}
        >
          Confirm my choice
        </button>
      </div>
    )

  function next() {
    if (!formsIn) return setError('Send your claimant statement and W-9 first. Then you can confirm your choice.')
    if (!option) return setError('Choose how you’d like to receive your share.')
    setError(undefined)
    setStep('review')
  }

  return (
    <div className="pt-page">
      {sent && (
        <Done title={`${sent} received`}>
          <span className="pt-soft">{formsIn ? 'Your share is in good order. Now choose how to receive it.' : 'One more form to go.'}</span>
        </Done>
      )}
      <section className="pt-card pt-share" aria-labelledby="pt-share-h">
        <h1 id="pt-share-h" className="pt-h2">Your share of your mother’s annuity</h1>
        <p className="pt-share-amt">At least <span className="pt-amount pt-num">{fmtMoney(HART.guaranteed)}</span></p>
        <p className="pt-soft">guaranteed by the death benefit</p>
      </section>
      <p>
        Today your half is worth {fmtMoney(HART.marketToday)} in the market. With your forms in now, you’d receive the guaranteed {fmtMoney(HART.guaranteed)}. The value changes daily.
      </p>

      <fieldset className="pt-fieldset pt-stack-8">
        <legend className="pt-h2">Choose how to receive it</legend>
        <div className="pt-options">
          {OPTIONS.map((o) => (
            <label key={o.key} className={cx('pt-option', option === o.key && 'pt-option--on')}>
              <input type="radio" name="pt-election" checked={option === o.key} onChange={() => { setOption(o.key); setError(undefined) }} />
              <span className="pt-stack-2">
                <strong>{ELECTION_LABELS[o.key]}</strong>
                <span className="pt-soft">{o.body}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="pt-well">
        Not sure? Paul Hendricks, your mother’s financial professional, can help. We can’t give tax advice; a tax professional can.{' '}
        <button type="button" className="pt-link pt-link--inline" onClick={() => setPaul(true)}>Message Paul</button>
      </p>

      <section className="pt-stack-8" aria-labelledby="pt-still-h">
        <h2 id="pt-still-h" className="pt-h2">{formsIn ? 'Your forms' : 'Still needed from you'}</h2>
        <div className="pt-two">
          <FormTile label="Claimant statement" done={share.statement} to={`${BASE}/tasks/statement`} />
          <FormTile label="W-9 (taxpayer ID)" done={share.w9} to={`${BASE}/tasks/w9`} />
        </div>
      </section>

      {error && <p className="pt-error" role="alert">{error}</p>}
      <button type="button" className="pt-btn pt-btn--primary" onClick={next}>Continue</button>
      <button type="button" className="pt-link pt-link--center" onClick={() => setSaved(true)}>Save and decide later</button>
      {saved && (
        <Done title="Saved">
          <span className="pt-soft">Come back any time. To spread payments over your life expectancy, they must start by {fmtDate(HART.lifeExpectancyBy)}.</span>
        </Done>
      )}

      {paul && <MessagePaulSheet onClose={closePaul} />}
    </div>
  )
}

function FormTile({ label, done, to }: { label: string; done: boolean; to: string }) {
  if (done)
    return (
      <div className="pt-tile pt-tile--done">
        <span>{label}</span>
        <span className="pt-ok"><PtIcon name="check" size={16} strokeWidth={1.8} />Received</span>
      </div>
    )
  return (
    <Link to={to} className="pt-tile">
      <span>{label}</span>
      <span className="pt-tile-go">Start<PtIcon name="chevronRight" size={16} strokeWidth={1.8} /></span>
    </Link>
  )
}

function MessagePaulSheet({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('Could you help me compare the three options for my share?')
  const [done, setDone] = useState(false)
  return (
    <Sheet
      title={done ? 'Message sent' : 'Message Paul Hendricks'}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--block" onClick={onClose}>Done</button>
        ) : (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--block" disabled={!text.trim()} onClick={() => void sendPortalMessage(CLAIM, NAME, text.trim(), 'Paul Hendricks').then(() => setDone(true))}>
            Send to Paul
          </button>
        )
      }
    >
      {done ? (
        <Done title="Paul Hendricks will get back to you">
          <span className="pt-soft">You agreed on 12 Sep that Paul can see your claim status. He can’t see your tax ID.</span>
        </Done>
      ) : (
        <div className="pt-field">
          <label className="pt-label" htmlFor="pt-paul-msg">Your message</label>
          <textarea id="pt-paul-msg" className="pt-input pt-textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      )}
    </Sheet>
  )
}

/** Claimant statement or W-9, completed and e-signed in the portal. */
function FormScreen({ form }: { form: AnnuityForm }) {
  const navigate = useNavigate()
  const [agree, setAgree] = useState(false)
  const [sending, setSending] = useState(false)
  const statement = form === 'statement'

  async function submit() {
    setSending(true)
    await submitAnnuityForm(CLAIM, NAME, form)
    navigate(`${BASE}/tasks`, { state: { sent: statement ? 'Claimant statement' : 'W-9' } })
  }

  return (
    <div className="pt-page">
      <BackLink to={`${BASE}/tasks`} label="Back" />
      <h1 className="pt-h1 pt-h1--lg">{statement ? 'Claimant statement' : 'W-9 (taxpayer ID)'}</h1>
      <p className="pt-soft">
        {statement
          ? 'Tells us who you are and how you’re related to your mother. We’ve filled in what we know — check it and sign.'
          : 'We need your taxpayer ID to report the taxable part of your share to the IRS.'}
      </p>
      <form className="pt-stack-12" onSubmit={(e) => { e.preventDefault(); if (agree) void submit() }}>
        <Field id="pt-f-name" label="Your full name" defaultValue={NAME} />
        {statement ? (
          <>
            <Field id="pt-f-rel" label="Relationship to Evelyn Hart" defaultValue="Daughter" />
            <Field id="pt-f-dob" label="Your date of birth" defaultValue="1979-04-18" type="date" />
            <Field id="pt-f-addr" label="Home address" defaultValue="41 Orchard Lane, Maple Falls" />
          </>
        ) : (
          <>
            <Field id="pt-f-tin" label="Social Security number" defaultValue="123-45-2209" inputMode="numeric" />
            <Field id="pt-f-addr" label="Address" defaultValue="41 Orchard Lane, Maple Falls" />
          </>
        )}
        <label className="pt-check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{statement ? 'What I’ve told you is true, and I’m signing this electronically.' : 'I certify, under penalties of perjury, that this number is correct and I am a U.S. person.'}</span>
        </label>
        <button type="submit" className="pt-btn pt-btn--primary" disabled={!agree || sending}>Sign and send</button>
      </form>
    </div>
  )
}

function Field({ id, label, defaultValue, type = 'text', inputMode }: { id: string; label: string; defaultValue: string; type?: string; inputMode?: 'numeric' }) {
  return (
    <div className="pt-field">
      <label className="pt-label" htmlFor={id}>{label}</label>
      <input id={id} className="pt-input" type={type} defaultValue={defaultValue} inputMode={inputMode} />
    </div>
  )
}

function ClairePayments({ share }: { share?: AnnuityShareView }) {
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Payments</h1>
      <section className="pt-card pt-card--pad pt-stack-8">
        <span className="pt-kicker">Your share</span>
        <p>At least <span className="pt-amount pt-num">{fmtMoney(HART.guaranteed)}</span></p>
        {share?.election ? (
          <p>You chose <strong>{ELECTION_LABELS[share.election.option].toLowerCase()}</strong>. {share.election.option === 'lump' ? `Payment by ${fmtDate(addDays(TODAY, 7))}.` : 'Irene Walsh will send your schedule.'}</p>
        ) : (
          <p className="pt-soft">Nothing is paid until your forms are in and you’ve chosen how to receive it.</p>
        )}
      </section>
      <section className="pt-well pt-stack-4">
        <h2 className="pt-h3">Tax, in plain words</h2>
        <p className="pt-soft">Only the gain — what your share is worth above what your mother paid in — is taxable. We’ll send you a 1099-R for the year you receive it. We can’t give tax advice; a tax professional can.</p>
      </section>
    </div>
  )
}
