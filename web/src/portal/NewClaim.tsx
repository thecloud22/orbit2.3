import { useState, type ReactNode } from 'react'
import { Link, Route, Routes, useNavigate } from 'react-router-dom'
import { cx } from '../lib/cx'
import { fmtDate } from '../lib/dates'
import { Done, PtIcon, ScrollMain, TopBar } from './parts'

const BASE = '/portal/new'

/** "Someone new": file a disability claim (board 07.1) or report a death (board 07.5). */
export function NewApp() {
  return (
    <Routes>
      <Route index element={<Start />} />
      <Route path="disability" element={<FileClaim />} />
      <Route path="death" element={<ReportDeath />} />
    </Routes>
  )
}

function Start() {
  return (
    <>
      <TopBar home={BASE} right={<a className="pt-toplink" href="tel:+15550102000">Help</a>} />
      <ScrollMain>
        <div className="pt-page">
          <h1 className="pt-h1 pt-h1--lg">How can we help?</h1>
          <Link to={`${BASE}/disability`} className="pt-bigchoice">
            <span className="pt-stack-2">
              <strong>Start a disability claim</strong>
              <span className="pt-soft">If an illness or injury keeps you from working.</span>
            </span>
            <PtIcon name="chevronRight" />
          </Link>
          <Link to={`${BASE}/death`} className="pt-bigchoice">
            <span className="pt-stack-2">
              <strong>Tell us about a death</strong>
              <span className="pt-soft">For life insurance or an annuity. We’ll find what they had with us.</span>
            </span>
            <PtIcon name="chevronRight" />
          </Link>
          <p className="pt-well">
            Prefer to talk? Call <a href="tel:+15550102000" className="pt-link--inline">(555) 010-2000</a>, Mon–Fri 8am–8pm.
          </p>
        </div>
      </ScrollMain>
    </>
  )
}

/** Step header with a segmented progress bar. */
function Steps({ n, of, label }: { n: number; of: number; label: string }) {
  return (
    <div className="pt-stack-8">
      <p>
        <strong>Step {n} of {of}</strong> <span className="pt-soft">· {label}</span>
      </p>
      <div className="pt-progress" role="progressbar" aria-valuemin={1} aria-valuemax={of} aria-valuenow={n} aria-label={`Step ${n} of ${of}`}>
        {Array.from({ length: of }, (_, i) => <span key={i} className={cx(i < n && 'pt-progress-on')} />)}
      </div>
    </div>
  )
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="pt-field">
      <label className="pt-label" htmlFor={id}>{label}</label>
      {hint && <span className="pt-soft pt-hint">{hint}</span>}
      {children}
    </div>
  )
}

const WHAT = ['Injury', 'Illness', 'Surgery', 'Pregnancy complications', 'Mental health', 'Something else']
const FILE_STEPS = ['About you', 'Find your policy', 'About your disability', 'Your doctors', 'Your work', 'Review and send']

/** Board 07.1 — file a disability claim, six short steps. */
function FileClaim() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [what, setWhat] = useState('Injury')
  const [surgery, setSurgery] = useState(true)
  const [f, setF] = useState({ name: 'Sam Rivera', dob: '1984-02-11', phone: '(555) 010-7781', injury: '2026-07-08', lastDay: '2026-07-07', surgeryDate: '2026-07-10', doctor: '', doctorPhone: '', job: 'Physical therapist', employer: 'Rivera Therapy Group' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const done = step > FILE_STEPS.length

  return (
    <>
      <header className="pt-top pt-top--flow">
        <button type="button" className="pt-iconbtn" aria-label={step > 1 && !done ? 'Previous step' : 'Back to start'} onClick={() => (step > 1 && !done ? setStep(step - 1) : navigate(BASE))}>
          <PtIcon name="arrowLeft" size={22} />
        </button>
        <span className="pt-top-title">Start a disability claim</span>
        {!done && <Link to={BASE} className="pt-toplink">Save &amp; exit</Link>}
      </header>
      <ScrollMain key={step}>
        {done ? (
          <div className="pt-page">
            <h1 className="pt-h1 pt-h1--lg">We’ve got your claim</h1>
            <Done title="Claim D-26-074188 submitted">
              <span className="pt-soft">We sent a copy to your email and a text to {f.phone}.</span>
            </Done>
            <section className="pt-stack-4">
              <h2 className="pt-h3">What happens next</h2>
              <ol className="pt-next">
                <li>A case manager calls you within 1 business day.</li>
                <li>We contact {f.doctor || 'your doctor'} for you. You don’t need to get forms.</li>
                <li>Your 30-day waiting period started on {fmtDate(f.lastDay)}.</li>
              </ol>
            </section>
            <Link to={BASE} className="pt-btn pt-btn--primary">Done</Link>
          </div>
        ) : (
          <form className="pt-page" onSubmit={(e) => { e.preventDefault(); setStep(step + 1) }}>
            <Steps n={step} of={FILE_STEPS.length} label={FILE_STEPS[step - 1]} />
            {step === 1 && (
              <>
                <Field id="pt-n-name" label="Your full name"><input id="pt-n-name" className="pt-input" value={f.name} onChange={set('name')} autoComplete="name" /></Field>
                <Field id="pt-n-dob" label="Date of birth"><input id="pt-n-dob" type="date" className="pt-input" value={f.dob} onChange={set('dob')} /></Field>
                <Field id="pt-n-phone" label="Mobile phone" hint="We’ll text you updates"><input id="pt-n-phone" type="tel" className="pt-input" value={f.phone} onChange={set('phone')} autoComplete="tel" /></Field>
              </>
            )}
            {step === 2 && (
              <>
                <p className="pt-found">
                  <span className="pt-found-mark"><PtIcon name="check" size={16} strokeWidth={2} /></span>
                  <span>
                    We found your policy:<br />
                    <strong>Disability income</strong> · <span className="pt-mono">DI-2208417</span><br />
                    Own occupation · 30-day waiting period
                  </span>
                </p>
                <p className="pt-soft">Matched on your name and date of birth. Not yours? Call us and we’ll help.</p>
              </>
            )}
            {step === 3 && (
              <>
                <p className="pt-found">
                  <span className="pt-found-mark"><PtIcon name="check" size={16} strokeWidth={2} /></span>
                  <span>
                    We found your policy:<br />
                    <strong>Disability income</strong> · <span className="pt-mono">DI-2208417</span><br />
                    Own occupation · 30-day waiting period
                  </span>
                </p>
                <fieldset className="pt-fieldset pt-stack-8">
                  <legend className="pt-label">What happened?</legend>
                  <div className="pt-grid2">
                    {WHAT.map((w) => (
                      <label key={w} className={cx('pt-choice', what === w && 'pt-choice--on')}>
                        <input type="radio" name="pt-what" checked={what === w} onChange={() => setWhat(w)} />
                        {w}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="pt-two">
                  <Field id="pt-n-inj" label={what === 'Injury' ? 'Date of the injury' : 'When it started'}><input id="pt-n-inj" type="date" className="pt-input" value={f.injury} onChange={set('injury')} /></Field>
                  <Field id="pt-n-last" label="Last day you worked"><input id="pt-n-last" type="date" className="pt-input" value={f.lastDay} onChange={set('lastDay')} /></Field>
                </div>
                <fieldset className="pt-fieldset">
                  <legend className="pt-label">Did you have surgery?</legend>
                  <div className="pt-surgery">
                    <div className="pt-pills">
                      {[true, false].map((v) => (
                        <label key={String(v)} className={cx('pt-pill', surgery === v && 'pt-pill--on')}>
                          <input type="radio" name="pt-surg" checked={surgery === v} onChange={() => setSurgery(v)} />
                          {v ? 'Yes' : 'No'}
                        </label>
                      ))}
                    </div>
                    {surgery && (
                      <Field id="pt-n-surg" label="Date of surgery"><input id="pt-n-surg" type="date" className="pt-input" value={f.surgeryDate} onChange={set('surgeryDate')} /></Field>
                    )}
                  </div>
                </fieldset>
                <p className="pt-well"><strong>You don’t need to get forms from your doctor.</strong> Tell us who they are on the next step and we’ll contact them.</p>
              </>
            )}
            {step === 4 && (
              <>
                <Field id="pt-n-doc" label="Your doctor’s name"><input id="pt-n-doc" className="pt-input" value={f.doctor} onChange={set('doctor')} placeholder="e.g. Dr. Maya Chen" /></Field>
                <Field id="pt-n-docph" label="Their office phone" hint="Optional — we can look it up"><input id="pt-n-docph" type="tel" className="pt-input" value={f.doctorPhone} onChange={set('doctorPhone')} /></Field>
                <p className="pt-soft">We’ll ask them for a statement. You can add more doctors later.</p>
              </>
            )}
            {step === 5 && (
              <>
                <Field id="pt-n-job" label="Your job"><input id="pt-n-job" className="pt-input" value={f.job} onChange={set('job')} /></Field>
                <Field id="pt-n-emp" label="Where you work"><input id="pt-n-emp" className="pt-input" value={f.employer} onChange={set('employer')} /></Field>
              </>
            )}
            {step === 6 && (
              <dl className="pt-review">
                <div><dt>Name</dt><dd>{f.name}</dd></div>
                <div><dt>Policy</dt><dd>Disability income · DI-2208417</dd></div>
                <div><dt>What happened</dt><dd>{what}{surgery ? ` · surgery ${fmtDate(f.surgeryDate)}` : ''}</dd></div>
                <div><dt>Last day worked</dt><dd>{fmtDate(f.lastDay)}</dd></div>
                <div><dt>Doctor</dt><dd>{f.doctor || 'Not given yet'}</dd></div>
                <div><dt>Work</dt><dd>{f.job} · {f.employer}</dd></div>
              </dl>
            )}
            <div className="pt-flow-foot">
              <button type="submit" className="pt-btn pt-btn--primary">{step === FILE_STEPS.length ? 'Send my claim' : 'Continue'}</button>
              <p className="pt-center pt-soft">
                Questions? <a href="tel:+15550102000" className="pt-link--inline">Call (555) 010-2000</a><br />Mon–Fri 8am–8pm
              </p>
            </div>
          </form>
        )}
      </ScrollMain>
    </>
  )
}

const DEATH_STEPS = ['About the person who died', 'About you', 'The death certificate', 'How you’d like to be paid']

/** Board 07.5 — report a death, four short steps. */
function ReportDeath() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [f, setF] = useState({ name: '', dod: '', policy: '', you: '', relation: '', phone: '', cert: '', pay: 'deposit' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const done = step >= DEATH_STEPS.length
  const first = f.name.trim().split(' ')[0]

  return (
    <>
      <TopBar home={BASE} right={step === 0 ? <a className="pt-toplink" href="tel:+15550103000">Help</a> : (
        <button type="button" className="pt-toplink" onClick={() => (done ? navigate(BASE) : setStep(step - 1))}>{done ? 'Close' : 'Back'}</button>
      )} />
      <ScrollMain key={step}>
        {done ? (
          <div className="pt-page">
            <h1 className="pt-h1 pt-h1--lg">Thank you. We’ve started your claim.</h1>
            <Done title="Reference L-26-043021">
              <span className="pt-soft">We sent a copy to you by text.</span>
            </Done>
            <section className="pt-stack-4">
              <h2 className="pt-h3">What happens next</h2>
              <ol className="pt-next">
                <li>We search for any life insurance or annuities in {first || 'their'}{first ? '’s' : ''} name.</li>
                <li>A claims examiner contacts you within 2 business days.</li>
                <li>If there’s more than one policy, you’ll see each one here.</li>
              </ol>
            </section>
            <Link to={BASE} className="pt-btn pt-btn--primary">Done</Link>
          </div>
        ) : (
          <form className="pt-page" onSubmit={(e) => { e.preventDefault(); setStep(step + 1) }}>
            {step === 0 ? (
              <>
                <h1 className="pt-h1 pt-h1--lg">We’re sorry for your loss.</h1>
                <p>Tell us about the person who died. We’ll find any life insurance or annuities they had with us, and guide you step by step. You can stop and come back any time.</p>
                <section className="pt-stack-8" aria-labelledby="pt-need-list">
                  <h2 id="pt-need-list" className="pt-h3">What you’ll need</h2>
                  <ol className="pt-steps-list">
                    {DEATH_STEPS.map((s, i) => (
                      <li key={s} className={cx(i === 0 && 'pt-steps-list--on')}>
                        <span className="pt-num-dot">{i + 1}</span>
                        <span>
                          {i === 0 ? <><strong>{s}</strong> <span className="pt-soft">· now</span></> : s}
                          {i === 2 && <span className="pt-soft pt-block">A photo is fine to start</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              </>
            ) : (
              <Steps n={step + 1} of={DEATH_STEPS.length} label={DEATH_STEPS[step]} />
            )}
            {step === 0 && (
              <>
                <Field id="pt-d-name" label="Their full name"><input id="pt-d-name" className="pt-input" value={f.name} onChange={set('name')} required /></Field>
                <Field id="pt-d-dod" label="Date of death"><input id="pt-d-dod" type="date" className="pt-input" value={f.dod} onChange={set('dod')} max="2026-09-25" required /></Field>
                <Field id="pt-d-pol" label="Policy or contract number" hint="Optional — we can search for you"><input id="pt-d-pol" className="pt-input" value={f.policy} onChange={set('policy')} /></Field>
              </>
            )}
            {step === 1 && (
              <>
                <p>Thank you. Now a little about you.</p>
                <Field id="pt-d-you" label="Your full name"><input id="pt-d-you" className="pt-input" value={f.you} onChange={set('you')} required autoComplete="name" /></Field>
                <Field id="pt-d-rel" label={`How you’re related to ${first || 'them'}`}><input id="pt-d-rel" className="pt-input" value={f.relation} onChange={set('relation')} placeholder="e.g. Spouse, son, friend" /></Field>
                <Field id="pt-d-ph" label="Mobile phone"><input id="pt-d-ph" type="tel" className="pt-input" value={f.phone} onChange={set('phone')} autoComplete="tel" /></Field>
              </>
            )}
            {step === 2 && (
              <>
                <p>A photo of the death certificate is fine to start. We may ask for a certified copy later.</p>
                {f.cert ? (
                  <p className="pt-file"><PtIcon name="doc" /><span className="grow pt-file-name">{f.cert}</span><button type="button" className="pt-link" onClick={() => setF({ ...f, cert: '' })}>Remove</button></p>
                ) : (
                  <label className="pt-btn pt-file-pick">
                    <PtIcon name="camera" />
                    Take a photo or choose a file
                    <input type="file" accept=".pdf,image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && setF({ ...f, cert: e.target.files[0].name })} />
                  </label>
                )}
                {!f.cert && <button type="button" className="pt-link pt-demo-link" onClick={() => setF({ ...f, cert: 'death-certificate.jpg' })}>Demo: attach a sample photo</button>}
                <p className="pt-soft">Don’t have it yet? Continue — you can add it later.</p>
              </>
            )}
            {step === 3 && (
              <fieldset className="pt-fieldset pt-stack-8">
                <legend className="pt-label">How you’d like to be paid</legend>
                {[['deposit', 'Direct deposit', 'Usually arrives the day after we approve'], ['check', 'Check by mail', 'Takes 5–7 days to arrive']].map(([k, t, d]) => (
                  <label key={k} className={cx('pt-option', f.pay === k && 'pt-option--on')}>
                    <input type="radio" name="pt-pay" checked={f.pay === k} onChange={() => setF({ ...f, pay: k })} />
                    <span className="pt-stack-2"><strong>{t}</strong><span className="pt-soft">{d}</span></span>
                  </label>
                ))}
                <p className="pt-soft pt-small">We only ask for account details once we know what’s payable.</p>
              </fieldset>
            )}
            <button type="submit" className="pt-btn pt-btn--primary">{step === DEATH_STEPS.length - 1 ? 'Send' : 'Continue'}</button>
            {step === 0 && (
              <>
                <p className="pt-well">Prefer to talk it through? Call <a href="tel:+15550103000" className="pt-link--inline">(555) 010-3000</a> — we can fill this in with you.</p>
                <p className="pt-soft">Filing for a funeral home?<br /><a href="tel:+15550103000" className="pt-link--inline">Use the assignment form</a></p>
              </>
            )}
          </form>
        )}
      </ScrollMain>
    </>
  )
}
