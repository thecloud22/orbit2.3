import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { getClaim } from '../api/claims'
import {
  ageOn,
  draftFromContext,
  elimination,
  emptyProvider,
  getIntakeContext,
  lookupContracts,
  proposeTriage,
  reasonText,
  runChecks,
  SAMPLE_ANSWERS,
  submitDiIntake,
  waiverStart,
  type CareProvider,
  type ContractMatch,
  type DeathNotice,
  type DiIntakeDraft,
  type IntakeContext,
  type TriageProposal,
} from '../api/intake'
import { addDays, fmtDate, TODAY } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { cx } from '../lib/cx'
import { StatusTag, Tag, ToneShape } from '../components/Tag'
import { Icon } from '../components/Icon'
import { Sources } from '../components/Sources'
import { Drawer } from '../components/Drawer'
import { Loading } from '../components/Planned'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import { CallBar, Check, Choice, Field, SampleButton, Say, Section, StepMark } from './intakeParts'
import { clockTime, isDate, useCallClock, YES_NO, type CallState } from './intakeCall'
import './intake.css'

type Product = 'di' | 'life' | 'annuity'
type StepKey = 'caller' | 'coverage' | 'absence' | 'providers' | 'occupation' | 'payment' | 'review'

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'caller', label: 'Caller & identity' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'absence', label: 'Absence & condition' },
  { key: 'providers', label: 'Care providers' },
  { key: 'occupation', label: 'Occupation & earnings' },
  { key: 'payment', label: 'Payment & tax' },
  { key: 'review', label: 'Review & submit' },
]

const PRODUCTS: { key: Product; label: string; detail: string }[] = [
  { key: 'di', label: 'Disability income', detail: 'The insured can’t work because of illness or injury. Full 7-step intake.' },
  { key: 'life', label: 'Life — death of the insured', detail: 'Notice of death on a term, whole or universal life policy. Opens the life intake as a new call.' },
  { key: 'annuity', label: 'Annuity — death of the owner', detail: 'Notice of death on a deferred or income annuity contract.' },
]

// ---------------------------------------------------------------- Page

/** New claim intake (board 04.2): a phone intake with the call bar, step list, form and the claim so far. */
export function Intake() {
  const { data: ctx } = useQuery(() => getIntakeContext(), [])
  if (!ctx) {
    return (
      <div className="ik">
        <div className="ik-loading"><Loading rows={6} /></div>
      </div>
    )
  }
  return <IntakeCall ctx={ctx} />
}

function IntakeCall({ ctx }: { ctx: IntakeContext }) {
  const { user } = useSession()
  const toast = useToast()
  const navigate = useNavigate()
  const clock = useCallClock(ctx.call.elapsed)
  const [callState, setCallState] = useState<CallState>('live')
  const [product, setProduct] = useState<Product>('di')
  const [picker, setPicker] = useState(false)
  const [verified, setVerified] = useState(true)
  const [deathCaller, setDeathCaller] = useState('')
  const now = () => clockTime(ctx.call.started, clock.elapsed())

  function endCall() {
    clock.end()
    setCallState('ended')
    toast(`Call ended at ${now()} · draft saved — any intake user can resume it`)
  }

  return (
    <div className="ik">
      <CallBar
        call={ctx.call}
        user={user}
        clock={clock}
        state={callState}
        caller={
          product === 'di'
            ? verified
              ? { tone: 'positive', label: `Caller verified — ${ctx.person.name}`, detail: ' (DOB, ZIP, last 4 SSN)' }
              : { tone: 'caution', label: 'Caller not verified' }
            : { tone: 'neutral', label: deathCaller ? `Caller: ${deathCaller}` : 'Caller not yet named', detail: ' · notice of death' }
        }
        onHold={() => setCallState((s) => (s === 'hold' ? 'live' : 'hold'))}
        onTransfer={(to) => toast(`Warm transfer to ${to} requested · the draft goes with the call`)}
        onEnd={endCall}
      />
      <DiIntake ctx={ctx} hidden={product !== 'di'} now={now} onPickProduct={() => setPicker(true)} onVerified={setVerified} />
      {product !== 'di' && (
        <DeathNoticeIntake key={product} family={product} now={now} onPickProduct={() => setPicker(true)} onBack={() => setProduct('di')} onCaller={setDeathCaller} />
      )}
      {picker && (
        <ProductPicker
          current={product}
          onClose={() => setPicker(false)}
          onPick={(p) => {
            setPicker(false)
            if (p === 'life') {
              navigate('/intake/life')
              toast(`Disability draft saved at ${now()} · life claim intake opened`)
              return
            }
            setProduct(p)
            setDeathCaller('')
            if (p !== product) toast(p === 'di' ? 'Back to the disability claim — the draft was kept' : `Started a notice of death · the disability draft is saved at ${now()}`)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Disability intake

interface TriageState {
  state: TriageProposal['state']
  edited: boolean
  track?: string
  team?: string
}

/** The seven-step disability income intake. Starts where the board is: identity and coverage done, absence in progress. */
function DiIntake({ ctx, hidden, now, onPickProduct, onVerified }: {
  ctx: IntakeContext
  hidden: boolean
  now: () => string
  onPickProduct: () => void
  onVerified: (v: boolean) => void
}) {
  const { user, openTab } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: claim } = useQuery(() => getClaim(ctx.claimId), [ctx.claimId])
  const [draft, setDraft] = useState<DiIntakeDraft>(() => draftFromContext(ctx))
  const [step, setStep] = useState(2)
  const [visited, setVisited] = useState<Set<number>>(() => new Set([0, 1, 2]))
  const [savedAt, setSavedAt] = useState('09:48')
  const [updatedAt, setUpdatedAt] = useState('09:48')
  const [triage, setTriage] = useState<TriageState>({ state: 'open', edited: false })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const headRef = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shownStep = useRef(step)

  const allVerified = draft.verified.dob && draft.verified.zip && draft.verified.ssn
  useEffect(() => onVerified(allVerified), [allVerified, onVerified])

  useEffect(() => {
    if (shownStep.current === step) return
    shownStep.current = step
    scrollRef.current?.scrollTo({ top: 0 })
    headRef.current?.focus()
  }, [step])

  const set = (patch: Partial<DiIntakeDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setUpdatedAt(now())
  }

  const missing = STEPS.map((s) => missingFor(s.key, draft))
  const earlierIncomplete = STEPS.slice(0, 6).filter((_, i) => missing[i].length > 0).map((s) => s.label)
  const current = STEPS[step]
  const curMissing = current.key === 'review' ? [...earlierIncomplete.map((l) => `${l} step`), ...missing[6]] : missing[step]
  const proposal = proposeTriage(draft)
  const triageFinal: TriageProposal = { ...proposal, track: triage.track ?? proposal.track, team: triage.team ?? proposal.team, state: triage.state, edited: triage.edited }
  const submitted = claim ? !claim.light : false

  function save(quiet = false) {
    const t = now()
    setSavedAt(t)
    if (!quiet) toast(`Draft saved ${t} — any intake user can resume it`)
  }

  function go(i: number) {
    setConfirming(false)
    setVisited((v) => new Set(v).add(i))
    setStep(i)
    save(true)
  }

  function fillSample(key: 'providers' | 'occupation' | 'payment') {
    const s = SAMPLE_ANSWERS[key]
    if (s) set(s)
  }

  async function submit() {
    setBusy(true)
    try {
      const id = await submitDiIntake(ctx, draft, triageFinal, user.name, now())
      openTab(id)
      navigate(`/claims/${id}/overview`)
      toast(`Claim ${id} created · acknowledged by email and text · assigned to Priya Nair, ${triageFinal.state === 'dismissed' ? 'DI Team 1' : triageFinal.team}`)
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
      setConfirming(false)
    }
  }

  const first = ctx.person.name.split(' ')[0]
  const stepProps = { ctx, draft, set, first }

  return (
    <div className="ik-body" hidden={hidden}>
      <nav className="ik-nav" aria-label="Intake steps">
        <div className="ik-nav-head">
          <h1>New disability claim</h1>
          <span className="soft">Phone intake · started {ctx.call.started}</span>
          <button type="button" className="btn btn--ghost btn--xs ik-switch" onClick={onPickProduct}>Start a different claim</button>
        </div>
        <ol className="ik-steps">
          {STEPS.map((s, i) => {
            const isCur = i === step
            const done = !isCur && visited.has(i) && missing[i].length === 0
            const attention = !isCur && visited.has(i) && missing[i].length > 0
            const state = isCur ? 'current' : done ? 'done' : attention ? 'attention' : 'todo'
            const sum = isCur ? 'In progress' : done ? stepSummary(s.key, draft, ctx) : attention ? `Needs: ${missing[i][0]}` : s.key === 'occupation' ? 'Duties, 2024–2025 W-2s or tax returns · requested, not prefilled' : ''
            const clickable = visited.has(i) && !isCur
            return (
              <li key={s.key}>
                <button type="button" className={cx('ik-step', `ik-step--${state}`)} aria-current={isCur ? 'step' : undefined} disabled={!clickable && !isCur} onClick={() => clickable && go(i)}>
                  <StepMark state={state} n={i + 1} />
                  <span className="ik-step-text">
                    <span className="ik-step-label">{s.label}</span>
                    {sum && <span className="ik-step-sum">{sum}</span>}
                    <span className="sr-only">{state === 'done' ? ' (done)' : state === 'attention' ? ' (needs attention)' : state === 'todo' ? ' (not started)' : ''}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        <p className="ik-saved"><Icon name="upload" size={13} />Draft saved {savedAt} — can be resumed by any intake user</p>
      </nav>

      <main className="ik-main" aria-labelledby="ik-step-h">
        <div className="ik-scroll" ref={scrollRef}>
          <div className="ik-form">
            {submitted && (
              <div className="callout-info ik-submitted">
                <ToneShape tone="info" />
                <span className="grow">{ctx.claimId} has already been submitted from this intake.</span>
                <button type="button" className="btn btn--ghost btn--xs" onClick={() => { openTab(ctx.claimId); navigate(`/claims/${ctx.claimId}/overview`) }}>Open claim</button>
              </div>
            )}
            <span className="ik-kicker">Step {step + 1} of {STEPS.length}</span>
            <h2 id="ik-step-h" ref={headRef} tabIndex={-1} className="ik-h">{current.label}</h2>
            {current.key === 'caller' && <CallerStep {...stepProps} />}
            {current.key === 'coverage' && <CoverageStep {...stepProps} />}
            {current.key === 'absence' && <AbsenceStep {...stepProps} />}
            {current.key === 'providers' && <ProvidersStep {...stepProps} onSample={() => fillSample('providers')} />}
            {current.key === 'occupation' && <OccupationStep {...stepProps} onSample={() => fillSample('occupation')} />}
            {current.key === 'payment' && <PaymentStep {...stepProps} onSample={() => fillSample('payment')} />}
            {current.key === 'review' && <ReviewStep {...stepProps} onEdit={go} triage={triageFinal} />}
          </div>
        </div>

        <div className="ik-foot">
          {confirming && current.key === 'review' ? (
            <div className="ik-confirm" role="alertdialog" aria-labelledby="ik-confirm-h" aria-describedby="ik-confirm-d">
              <div>
                <h3 id="ik-confirm-h">Submit {first}’s claim?</h3>
                <p id="ik-confirm-d" className="soft">Creates {ctx.claimId}, requests the evidence, sends the acknowledgement{draft.agentConsent === 'yes' ? ` and tells ${ctx.agent.name} (status only)` : ''}. The draft can’t be edited after this — changes go on the claim.</p>
              </div>
              <div className="ik-foot-row">
                <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Keep editing</button>
                <span className="grow" />
                <button type="button" className="btn btn--primary" onClick={submit} disabled={busy} autoFocus>
                  {busy ? 'Submitting…' : `Submit and open ${ctx.claimId}`}
                </button>
              </div>
            </div>
          ) : (
            <>
              {curMissing.length > 0 && (
                <p className="ik-missing" role="status">
                  <ToneShape tone="caution" />
                  <span>To continue, add: {curMissing.join(' · ')}</span>
                </p>
              )}
              <div className="ik-foot-row">
                <button type="button" className="btn" onClick={() => go(step - 1)} disabled={step === 0}>
                  <Icon name="chevronLeft" size={12} />Back
                </button>
                <span className="grow" />
                <button type="button" className="btn" onClick={() => save()}>Save draft</button>
                {current.key === 'review' ? (
                  <button type="button" className="btn btn--primary" disabled={curMissing.length > 0 || submitted} onClick={() => setConfirming(true)}>
                    Submit claim<Icon name="arrowRight" size={12} />
                  </button>
                ) : (
                  <button type="button" className="btn btn--primary" disabled={curMissing.length > 0} onClick={() => go(step + 1)}>
                    Continue to {STEPS[step + 1].label.toLowerCase()}<Icon name="arrowRight" size={12} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </main>

      <ClaimSoFar ctx={ctx} draft={draft} updatedAt={updatedAt} triage={triageFinal} proposal={proposal} onTriage={setTriage} />
    </div>
  )
}


// ---------------------------------------------------------------- Validation & summaries


function missingFor(step: StepKey, d: DiIntakeDraft): string[] {
  const m: string[] = []
  switch (step) {
    case 'caller':
      if (d.caller === 'other' && !d.callerName.trim()) m.push('caller’s name')
      if (d.caller === 'other' && !d.callerRelationship.trim()) m.push('relationship to the insured')
      if (!(d.verified.dob && d.verified.zip && d.verified.ssn)) m.push('all three identity checks')
      if (!d.phone.trim() && !d.email.trim()) m.push('a phone number or email')
      if (!Object.values(d.contactBy).some(Boolean)) m.push('how to keep in touch')
      if (!d.agentConsent) m.push('agent consent')
      break
    case 'coverage':
      if (!d.claimDi) m.push('the policy being claimed')
      if (!d.coverageReadBack) m.push('coverage read back')
      break
    case 'absence':
      if (!isDate(d.lastWorked)) m.push('last day worked')
      if (!isDate(d.firstUnable)) m.push('first day unable to work')
      if (isDate(d.lastWorked) && isDate(d.firstUnable) && d.firstUnable <= d.lastWorked) m.push('a first day unable after the last day worked')
      if (isDate(d.firstUnable) && d.firstUnable > TODAY) m.push('a first day unable that isn’t in the future')
      if (!d.reason) m.push('reason')
      if (!d.surgery) m.push('surgery planned?')
      if (d.surgery === 'yes' && !d.procedure.trim()) m.push('procedure')
      if (d.surgery === 'yes' && !isDate(d.surgeryDate)) m.push('surgery date')
      if (d.ownWords.trim().length < 20) m.push('the condition in her own words')
      if (!d.reducedHours) m.push('working reduced hours?')
      if (d.reducedHours === 'yes' && !d.residualNote.trim()) m.push('what she is still doing')
      if (!d.hospitalized) m.push('hospitalized?')
      if (d.hospitalized === 'yes' && !d.hospitalName.trim()) m.push('hospital')
      break
    case 'providers':
      if (d.providers.length === 0) m.push('at least one care provider')
      d.providers.forEach((p, i) => {
        if (!p.name.trim() || !p.practice.trim() || !p.phone.trim()) m.push(`provider ${i + 1}: name, practice and phone`)
      })
      if (d.providers.length > 0 && !d.providers.some((p) => p.primary)) m.push('who to request the statement from')
      break
    case 'occupation':
      if (!d.occupation.trim()) m.push('occupation')
      if (!d.workType) m.push('how she works')
      if (!(Number(d.hoursPerWeek) > 0)) m.push('usual hours a week')
      if (!d.requestDuties && !d.requestEarnings) m.push('at least one document to request')
      if (!d.otherCoverage) m.push('other disability coverage?')
      if (d.otherCoverage === 'yes' && !d.otherCoverageNote.trim()) m.push('the other coverage')
      break
    case 'payment':
      if (!d.payMethod) m.push('how to pay benefits')
      if (!d.otherPayer) m.push('who pays the premium')
      break
    case 'review':
      if (!d.fraudRead) m.push('fraud warning read')
      if (!d.attested) m.push('her confirmation')
      break
  }
  return m
}

const PAY_TEXT = { eftOnFile: 'Direct deposit ··0917', newAccount: 'New account via portal', check: 'Check by mail', '': '' }

function stepSummary(step: StepKey, d: DiIntakeDraft, ctx: IntakeContext): string {
  switch (step) {
    case 'caller':
      return d.caller === 'insured' ? `${ctx.person.name}, ${ctx.person.roles.toLowerCase()}` : `${d.callerName} for ${ctx.person.name} · ${d.callerRelationship}`
    case 'coverage':
      return `${ctx.policies.length} policies found automatically`
    case 'absence':
      return `Unable to work from ${fmtDate(d.firstUnable)}${d.surgery === 'yes' && isDate(d.surgeryDate) ? ` · surgery ${fmtDate(d.surgeryDate)}` : ''}`
    case 'providers': {
      const p = d.providers.find((x) => x.primary) ?? d.providers[0]
      return `${p.name}, ${p.practice}${d.providers.length > 1 ? ` +${d.providers.length - 1}` : ''}`
    }
    case 'occupation':
      return `${d.hoursPerWeek} h a week · ${[d.requestDuties && 'duties', d.requestEarnings && 'W-2s or returns'].filter(Boolean).join(' and ')} requested`
    case 'payment':
      return `${PAY_TEXT[d.payMethod]} · ${d.otherPayer === 'yes' ? 'tax review' : 'not taxable'}`
    default:
      return ''
  }
}

// ---------------------------------------------------------------- Form helpers

interface StepProps {
  ctx: IntakeContext
  draft: DiIntakeDraft
  set: (patch: Partial<DiIntakeDraft>) => void
  first: string
}


// ---------------------------------------------------------------- Step 1 · Caller & identity

function CallerStep({ ctx, draft, set, first }: StepProps) {
  const v = draft.verified
  return (
    <>
      <p className="ik-lede">Confirm who is calling before anything about the policies is discussed.</p>
      <Section title="Caller">
        <Choice
          legend="Who is calling?"
          name="caller"
          value={draft.caller}
          options={[{ value: 'insured', label: `${first}, the insured` }, { value: 'other', label: `Someone for ${first}` }]}
          onChange={(c) => set({ caller: c, callerName: c === 'insured' ? ctx.person.name : '', callerRelationship: '' })}
        />
        {draft.caller === 'other' && (
          <div className="ik-grid">
            <Field id="ik-caller-name" label="Caller’s name">
              <input id="ik-caller-name" className="input" value={draft.callerName} onChange={(e) => set({ callerName: e.target.value })} />
            </Field>
            <Field id="ik-caller-rel" label="Relationship to the insured" hint={`We need ${first}’s authorization before discussing the claim with them.`}>
              <input id="ik-caller-rel" className="input" value={draft.callerRelationship} onChange={(e) => set({ callerRelationship: e.target.value })} placeholder="Spouse, attorney, power of attorney…" />
            </Field>
          </div>
        )}
      </Section>

      <Section title="Identity" aside="Compared with the policy record">
        <div className="ik-checks-list">
          <Check checked={v.dob} onChange={(x) => set({ verified: { ...v, dob: x } })}>Date of birth matches <span className="muted">· on file {fmtDate(ctx.person.dob, { year: true })}</span></Check>
          <Check checked={v.zip} onChange={(x) => set({ verified: { ...v, zip: x } })}>ZIP code matches <span className="muted">· on file {ctx.person.zip}</span></Check>
          <Check checked={v.ssn} onChange={(x) => set({ verified: { ...v, ssn: x } })}>Last 4 of SSN match <span className="muted">· on file ••{ctx.person.ssnLast4}</span></Check>
        </div>
        <Say>‘So I can talk with you about your policies, please tell me your date of birth, your ZIP code and the last four digits of your Social Security number.’</Say>
      </Section>

      <Section title="Contact" aside={<Sources items={['Policy record']} />}>
        <div className="ik-grid">
          <Field id="ik-phone" label="Mobile phone">
            <input id="ik-phone" className="input" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field id="ik-email" label="Email">
            <input id="ik-email" className="input" type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
        </div>
        <Field id="ik-address" label="Mailing address">
          <input id="ik-address" className="input" value={draft.address} onChange={(e) => set({ address: e.target.value })} />
        </Field>
        <fieldset className="ik-fieldset">
          <legend className="ik-legend">How should we keep in touch?</legend>
          <div className="ik-inline-checks">
            {(['email', 'text', 'phone', 'mail'] as const).map((k) => (
              <Check key={k} checked={draft.contactBy[k]} onChange={(x) => set({ contactBy: { ...draft.contactBy, [k]: x } })}>
                {{ email: 'Email', text: 'Text message', phone: 'Phone call', mail: 'Letters by mail' }[k]}
              </Check>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Agent of record">
        <p>{ctx.agent.name}, {ctx.agent.agency}. With consent he sees the claim’s status and what is still needed — never medical details.</p>
        <Choice legend={`May we tell ${ctx.agent.name} the status of this claim?`} name="consent" value={draft.agentConsent} options={YES_NO} onChange={(x) => set({ agentConsent: x })} />
        <Say>‘Your agent, {ctx.agent.name}, can be told how your claim is going — never anything medical. Is that all right with you?’</Say>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Step 2 · Coverage

function CoverageStep({ ctx, draft, set, first }: StepProps) {
  const life = ctx.policies.find((p) => p.family === 'life')
  const wop = life?.waiverAfterMonths ? waiverStart(draft.firstUnable, life.waiverAfterMonths) : undefined
  return (
    <>
      <p className="ik-lede">Found automatically from policy administration once the caller was verified. Read-only here — changes go through policy service.</p>
      <Section title="Coverage found" aside="From policy administration">
        {ctx.policies.map((p) => (
          <article key={p.ref} className="ik-policy-card" aria-label={`${p.product} ${p.ref}`}>
            <div className="ik-policy-head">
              <strong>{p.product}</strong>
              <span className="mono soft">{p.ref}</span>
              <span className="grow" />
              <StatusTag status={p.family === 'disability' ? { label: 'In force', tone: 'positive' } : p.status} />
            </div>
            <dl className="dl ik-dl">
              <dt>Issued</dt><dd>{fmtDate(p.issued, { year: true })} · contestable period ended {fmtDate(addDays(p.issued, 730), { year: true })}</dd>
              <dt>Premium</dt><dd>Paid to {fmtDate(p.paidTo, { year: true })}</dd>
              {p.monthlyBenefit != null && (<><dt>Benefit</dt><dd>{fmtMoney(p.monthlyBenefit)} a month · {p.eliminationDays}-day elimination</dd></>)}
              {p.definition && (<><dt>Definition</dt><dd>{p.definition}</dd></>)}
              {p.faceAmount != null && (<><dt>Face amount</dt><dd>{fmtMoney(p.faceAmount)}</dd></>)}
              <dt>Riders</dt><dd>{p.riders.join(' · ')}</dd>
            </dl>
            <div className="ik-policy-foot">
              <Sources items={[p.source, 'Billing · paid to ' + fmtDate(p.paidTo)]} />
            </div>
            {p.family === 'disability' ? (
              <Check checked={draft.claimDi} onChange={(x) => set({ claimDi: x })}>Claim disability income under {p.ref}</Check>
            ) : (
              <p className="ik-hint">Waiver of premium isn’t triggered yet — it starts after {p.waiverAfterMonths} months of disability{wop ? `, on ${fmtDate(wop, { year: true })}` : ''}. It is tracked with this claim; nothing for {first} to do.</p>
            )}
          </article>
        ))}
      </Section>
      <Say>‘I can see two policies with us: your disability income policy, which pays {fmtMoney(ctx.policies[0].monthlyBenefit ?? 0).replace('.00', '')} a month while you can’t work as a nurse anesthetist, and your term life policy. If you’re disabled for six months, we’ll stop charging the life premium — we check that for you.’</Say>
      <Check checked={draft.coverageReadBack} onChange={(x) => set({ coverageReadBack: x })}>Coverage read back to {first} and confirmed</Check>
    </>
  )
}

// ---------------------------------------------------------------- Step 3 · Absence & condition

function AbsenceStep({ ctx, draft, set, first }: StepProps) {
  const di = ctx.policies.find((p) => p.family === 'disability')!
  const ep = elimination(draft.firstUnable, di.eliminationDays)
  return (
    <>
      <p className="ik-lede">Dates first, then the condition in {first}’s own words. Her agent sees claim status only, never medical details.</p>
      <Section title="Dates">
        <div className="ik-grid">
          <Field id="ik-last" label="Last day worked" hint={<span className="ik-source-row">Source <span className="source">Stated on this call</span></span>}>
            <input id="ik-last" className="input ik-date" type="date" max={TODAY} value={draft.lastWorked} onChange={(e) => set({ lastWorked: e.target.value })} />
          </Field>
          <Field id="ik-first" label="First day unable to work" hint={ep ? `The ${ep.days}-day elimination period counts from here · ends ${fmtDate(ep.end)}` : `The ${di.eliminationDays}-day elimination period counts from here`}>
            <input id="ik-first" className="input ik-date" type="date" max={TODAY} value={draft.firstUnable} onChange={(e) => set({ firstUnable: e.target.value })} />
          </Field>
        </div>
      </Section>

      <Section title="Condition">
        <Choice
          legend="Reason"
          name="reason"
          value={draft.reason}
          options={[
            { value: 'illness', label: 'Illness or condition' },
            { value: 'injury', label: 'Injury' },
            { value: 'pregnancy', label: 'Pregnancy' },
            { value: 'mental', label: 'Mental health' },
            { value: 'other', label: 'Other' },
          ]}
          onChange={(x) => set({ reason: x })}
        />
        <div className="ik-surgery">
          <Choice legend="Surgery planned?" name="surgery" value={draft.surgery} options={YES_NO} onChange={(x) => set({ surgery: x })} />
          {draft.surgery === 'yes' && (
            <>
              <Field id="ik-proc" label="Procedure">
                <input id="ik-proc" className="input" value={draft.procedure} onChange={(e) => set({ procedure: e.target.value })} />
              </Field>
              <Field id="ik-sdate" label="Date">
                <input id="ik-sdate" className="input ik-date" type="date" value={draft.surgeryDate} onChange={(e) => set({ surgeryDate: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <Field id="ik-words" label={`In ${first}’s words`} aside="Her words, not a diagnosis — the claim team codes the condition from the doctor’s statement">
          <textarea id="ik-words" className="textarea" rows={3} value={draft.ownWords} onChange={(e) => set({ ownWords: e.target.value })} />
        </Field>
      </Section>

      <Section title="Circumstances">
        <div className="ik-grid">
          <Choice legend="Working reduced hours now?" name="reduced" value={draft.reducedHours} options={YES_NO} onChange={(x) => set({ reducedHours: x })} hint="If yes, the residual benefit may apply — we’ll ask for earnings" />
          <Choice legend="Hospitalized?" name="hosp" value={draft.hospitalized} options={YES_NO} onChange={(x) => set({ hospitalized: x })} />
        </div>
        {draft.reducedHours === 'yes' && (
          <Field id="ik-residual" label="What is she still doing, and how many hours?" hint="Goes to the residual benefit review with her earnings records">
            <textarea id="ik-residual" className="textarea" rows={2} value={draft.residualNote} onChange={(e) => set({ residualNote: e.target.value })} placeholder="e.g. Pre-op assessments only, about 12 hours a week since 21 Sep" />
          </Field>
        )}
        {draft.hospitalized === 'yes' && (
          <Field id="ik-hospital" label="Hospital and dates">
            <input id="ik-hospital" className="input" value={draft.hospitalName} onChange={(e) => set({ hospitalName: e.target.value })} />
          </Field>
        )}
      </Section>
      <Say>‘Thanks, {first}. Next I’ll take your doctors’ details so we can request their statement directly — you won’t need to chase any forms.’</Say>
    </>
  )
}

// ---------------------------------------------------------------- Step 4 · Care providers

function ProvidersStep({ draft, set, first, onSample }: StepProps & { onSample: () => void }) {
  const update = (id: string, patch: Partial<CareProvider>) =>
    set({ providers: draft.providers.map((p) => (p.id === id ? { ...p, ...patch } : patch.primary ? { ...p, primary: false } : p)) })
  const add = () => set({ providers: [...draft.providers, { ...emptyProvider(), primary: draft.providers.length === 0 }] })
  return (
    <>
      <div className="ik-lede-row">
        <p className="ik-lede">Who is treating {first} for this? We request the attending physician statement directly from the doctor marked below.</p>
        <SampleButton onClick={onSample} />
      </div>
      {draft.providers.length === 0 && (
        <div className="empty ik-empty">
          No providers yet.
          <button type="button" className="btn btn--sm" onClick={add}><Icon name="plus" size={13} />Add a provider</button>
        </div>
      )}
      {draft.providers.map((p, i) => (
        <fieldset key={p.id} className="ik-provider">
          <legend className="ik-legend">Provider {i + 1}{p.name ? ` · ${p.name}` : ''}</legend>
          <div className="ik-grid">
            <Field id={`${p.id}-name`} label="Name">
              <input id={`${p.id}-name`} className="input" value={p.name} onChange={(e) => update(p.id, { name: e.target.value })} placeholder="Dr. …" />
            </Field>
            <Field id={`${p.id}-practice`} label="Practice or hospital">
              <input id={`${p.id}-practice`} className="input" value={p.practice} onChange={(e) => update(p.id, { practice: e.target.value })} />
            </Field>
            <Field id={`${p.id}-spec`} label="Specialty">
              <input id={`${p.id}-spec`} className="input" value={p.specialty} onChange={(e) => update(p.id, { specialty: e.target.value })} />
            </Field>
            <Field id={`${p.id}-last`} label="Last visit">
              <input id={`${p.id}-last`} className="input ik-date" type="date" max={TODAY} value={p.lastVisit} onChange={(e) => update(p.id, { lastVisit: e.target.value })} />
            </Field>
            <Field id={`${p.id}-phone`} label="Phone">
              <input id={`${p.id}-phone`} className="input" value={p.phone} onChange={(e) => update(p.id, { phone: e.target.value })} />
            </Field>
            <Field id={`${p.id}-fax`} label="Fax (optional)">
              <input id={`${p.id}-fax`} className="input" value={p.fax} onChange={(e) => update(p.id, { fax: e.target.value })} />
            </Field>
          </div>
          <div className="ik-provider-foot">
            <label className="ik-check">
              <input type="radio" name="aps-from" checked={p.primary} onChange={() => update(p.id, { primary: true })} />
              <span>Request the physician statement from this doctor</span>
            </label>
            <span className="grow" />
            <button type="button" className="btn btn--quiet btn--xs" onClick={() => set({ providers: draft.providers.filter((x) => x.id !== p.id) })}>Remove</button>
          </div>
        </fieldset>
      ))}
      {draft.providers.length > 0 && (
        <div><button type="button" className="btn btn--sm" onClick={add}><Icon name="plus" size={13} />Add another provider</button></div>
      )}
      <Say>‘We’ll ask {draft.providers.find((p) => p.primary)?.name || 'your doctor'}’s office for the statement ourselves. You’ll get a text when it arrives.’</Say>
    </>
  )
}

// ---------------------------------------------------------------- Step 5 · Occupation & earnings

function OccupationStep({ draft, set, first, onSample }: StepProps & { onSample: () => void }) {
  return (
    <>
      <div className="ik-lede-row">
        <p className="ik-lede">What {first} does and earns is requested as documents, not prefilled — the duties questionnaire and earnings records set the own-occupation baseline.</p>
        <SampleButton onClick={onSample} />
      </div>
      <Section title="Occupation">
        <div className="ik-grid">
          <Field id="ik-occ" label="Occupation" hint={<span className="ik-source-row">Source <span className="source">Application 2019</span></span>}>
            <input id="ik-occ" className="input" value={draft.occupation} onChange={(e) => set({ occupation: e.target.value })} />
          </Field>
          <Field id="ik-hours" label="Usual hours a week">
            <input id="ik-hours" className="input ik-num" type="number" min={1} max={100} value={draft.hoursPerWeek} onChange={(e) => set({ hoursPerWeek: e.target.value })} />
          </Field>
        </div>
        <Choice
          legend="How does she work?"
          name="worktype"
          value={draft.workType}
          options={[{ value: 'employee', label: 'Employed' }, { value: 'selfEmployed', label: 'Self-employed or contract' }, { value: 'owner', label: 'Owns a practice' }]}
          onChange={(x) => set({ workType: x })}
        />
        <Field id="ik-setting" label="Where and how she works (optional)">
          <input id="ik-setting" className="input" value={draft.setting} onChange={(e) => set({ setting: e.target.value })} placeholder="Setting, shift pattern, on-call" />
        </Field>
      </Section>
      <Section title="Documents to request" aside="Portal tasks for Nora · requested, not prefilled">
        <div className="ik-checks-list">
          <Check checked={draft.requestDuties} onChange={(x) => set({ requestDuties: x })}>Occupational duties questionnaire <span className="muted">· what her work involves day to day</span></Check>
          <Check checked={draft.requestEarnings} onChange={(x) => set({ requestEarnings: x })}>W-2s or tax returns, 2024–2025 <span className="muted">· {draft.reducedHours === 'yes' ? 'needed for the residual calculation' : 'pre-disability earnings'}</span></Check>
        </div>
      </Section>
      <Section title="Other coverage">
        <Choice legend="Any other disability income coverage?" name="othercov" value={draft.otherCoverage} options={YES_NO} onChange={(x) => set({ otherCoverage: x })} hint="Individual policies with other insurers, or a Social Security disability application" />
        {draft.otherCoverage === 'yes' && (
          <Field id="ik-othercov" label="Insurer and monthly amount">
            <input id="ik-othercov" className="input" value={draft.otherCoverageNote} onChange={(e) => set({ otherCoverageNote: e.target.value })} />
          </Field>
        )}
      </Section>
      <Say>‘I’ll send a short questionnaire about what your work involves day to day, and a place to upload your W-2s or tax returns for 2024 and 2025. They’ll be in your portal today.’</Say>
    </>
  )
}

// ---------------------------------------------------------------- Step 6 · Payment & tax

function PaymentStep({ ctx, draft, set, first, onSample }: StepProps & { onSample: () => void }) {
  return (
    <>
      <div className="ik-lede-row">
        <p className="ik-lede">Benefits start after the elimination period. Set up how they are paid now so the first payment isn’t held up.</p>
        <SampleButton onClick={onSample} />
      </div>
      <Section title="Payment">
        <Choice
          legend="How should benefits be paid?"
          name="pay"
          vertical
          value={draft.payMethod}
          options={[
            { value: 'eftOnFile', label: <span>Direct deposit to {ctx.eftOnFile} <span className="ik-card-note">premium draft account · from policy administration</span></span> },
            { value: 'newAccount', label: <span>A different account <span className="ik-card-note">{first} adds it securely in her portal — never read out on the call</span></span> },
            { value: 'check', label: <span>Check by mail <span className="ik-card-note">{draft.address}</span></span> },
          ]}
          onChange={(x) => set({ payMethod: x })}
        />
      </Section>
      <Section title="Tax" aside={<Sources items={['Billing record', `Policy record ${ctx.policies[0].ref}`]} />}>
        <dl className="dl ik-dl">
          <dt>Premiums paid by</dt><dd>{ctx.premiumPayer}</dd>
          <dt>Benefits</dt><dd>{draft.otherPayer === 'yes' ? 'May be partly taxable — a tax review follows' : 'Not taxable income · no W-2 or 1099 for benefits'}</dd>
        </dl>
        <Choice legend="Does anyone else, such as a business, pay any of the premium?" name="otherpayer" value={draft.otherPayer} options={YES_NO} onChange={(x) => set({ otherPayer: x })} />
      </Section>
      <Say>‘Because you pay the premiums yourself with after-tax money, the benefits aren’t taxable income.’</Say>
    </>
  )
}

// ---------------------------------------------------------------- Step 7 · Review & submit

function ReviewStep({ ctx, draft, set, first, onEdit, triage }: StepProps & { onEdit: (i: number) => void; triage: TriageProposal }) {
  const ep = elimination(draft.firstUnable)
  const aps = draft.providers.find((p) => p.primary)
  const rows: [number, string, ReactNode][] = [
    [0, 'Caller', <>{draft.caller === 'insured' ? `${ctx.person.name}, insured and owner` : `${draft.callerName} (${draft.callerRelationship})`} · verified · {[draft.contactBy.email && 'email', draft.contactBy.text && 'text', draft.contactBy.phone && 'phone', draft.contactBy.mail && 'mail'].filter(Boolean).join(', ')} · agent consent {draft.agentConsent || '—'}</>],
    [1, 'Coverage', <>{ctx.policies.map((p) => `${p.product} ${p.ref}`).join(' · ')} {draft.claimDi ? '' : '· nothing claimed'}</>],
    [2, 'Absence', <>Last worked {isDate(draft.lastWorked) ? fmtDate(draft.lastWorked) : '—'} · unable from {isDate(draft.firstUnable) ? fmtDate(draft.firstUnable) : '—'}{ep ? ` · EP ends ${fmtDate(ep.end)}` : ''} · {reasonText(draft.reason)}{draft.surgery === 'yes' ? ` · ${draft.procedure} ${isDate(draft.surgeryDate) ? fmtDate(draft.surgeryDate) : ''}` : ''}{draft.reducedHours === 'yes' ? ' · working reduced hours' : ''}</>],
    [3, 'Care providers', draft.providers.length ? draft.providers.map((p) => `${p.name}${p.primary ? ' (statement)' : ''}`).join(' · ') : <span className="muted">None yet</span>],
    [4, 'Occupation', <>{draft.occupation}{draft.hoursPerWeek ? ` · ${draft.hoursPerWeek} h a week` : ''} · {[draft.requestDuties && 'duties questionnaire', draft.requestEarnings && 'W-2s or returns'].filter(Boolean).join(' and ') || 'nothing'} requested</>],
    [5, 'Payment & tax', <>{PAY_TEXT[draft.payMethod] || <span className="muted">Not chosen</span>} · {draft.otherPayer === 'yes' ? 'tax review' : draft.otherPayer === 'no' ? 'not taxable' : '—'}</>],
  ]
  return (
    <>
      <p className="ik-lede">Check the claim with {first} before it is submitted. Anything changed after this goes on the claim, with history.</p>
      <Section title="Summary">
        <dl className="ik-review">
          {rows.map(([i, label, value]) => {
            const miss = missingFor(STEPS[i].key, draft)
            return (
              <div key={label} className="ik-review-row">
                <dt>{label}</dt>
                <dd>
                  {value}
                  {miss.length > 0 && <span className="ik-review-miss"><ToneShape tone="caution" size={9} /> Needs {miss.join(', ')}</span>}
                </dd>
                <button type="button" className="btn btn--ghost btn--xs" onClick={() => onEdit(i)} aria-label={`Edit ${label}`}>Edit</button>
              </div>
            )
          })}
          <div className="ik-review-row">
            <dt>Triage</dt>
            <dd>{triage.state === 'dismissed' ? 'Dismissed — the team lead routes it' : `${triage.track} → ${triage.team}`} <span className="muted">· {triage.state === 'accepted' ? `accepted${triage.edited ? ', edited' : ''}` : triage.state === 'dismissed' ? 'dismissed' : 'suggested, not yet accepted'}</span></dd>
            <span />
          </div>
        </dl>
      </Section>
      <Section title="Before you submit">
        <div className="ik-fraud">
          <strong>Fraud warning</strong>
          <p>Any person who knowingly and with intent to defraud files a statement of claim containing any materially false information, or conceals information about any material fact, commits a fraudulent insurance act, which is a crime.</p>
        </div>
        <div className="ik-checks-list">
          <Check checked={draft.fraudRead} onChange={(x) => set({ fraudRead: x })}>Fraud warning read to {first}</Check>
          <Check checked={draft.attested} onChange={(x) => set({ attested: x })}>{first} confirms what she told us is true and complete to the best of her knowledge</Check>
        </div>
        <p className="ik-hint">The authorization to release medical information is sent to her portal for e-signature{aps ? `; ${aps.name}’s office gets the request now and the signed authorization when it’s back` : ''}.</p>
      </Section>
      <Say>‘You’ll get an email and a text in the next few minutes with your claim number, {ctx.claimId}. Priya Nair, your case manager, will call you by {fmtDate(addDays(TODAY, 4), { weekday: true })}.’</Say>
    </>
  )
}

// ---------------------------------------------------------------- Right panel

/** Claim so far: who, coverage, checks, the elimination period, triage and what submitting does. */
function ClaimSoFar({ ctx, draft, updatedAt, triage, proposal, onTriage }: {
  ctx: IntakeContext
  draft: DiIntakeDraft
  updatedAt: string
  triage: TriageProposal
  proposal: ReturnType<typeof proposeTriage>
  onTriage: (t: TriageState) => void
}) {
  const di = ctx.policies.find((p) => p.family === 'disability')!
  const life = ctx.policies.find((p) => p.family === 'life')
  const ep = elimination(draft.firstUnable, di.eliminationDays)
  const wop = life?.waiverAfterMonths ? waiverStart(draft.firstUnable, life.waiverAfterMonths) : undefined
  const checks = runChecks(ctx, draft)
  const aps = draft.providers.find((p) => p.primary)
  const portal = ['e-sign the authorization', draft.requestDuties && 'complete the occupational duties questionnaire', draft.requestEarnings && 'upload W-2s or tax returns'].filter(Boolean).join(', ')
  const occ = draft.occupation.replace(/ \(.*\)$/, '')
  return (
    <aside className="ik-side" aria-label="Claim so far">
      <div className="ik-side-head">
        <h2>Claim so far</h2>
        <Tag tone="neutral">Draft</Tag>
        <span className="grow" />
        <span className="muted">Updated {updatedAt}</span>
      </div>

      <div className="ik-who">
        <strong className="ik-who-name">{ctx.person.name} · {ageOn(ctx.person.dob, TODAY)}</strong>
        <span>{occ}</span>
        <span className="muted">{ctx.person.roles} · agent of record {ctx.agent.name}</span>
      </div>

      <section className="ik-block" aria-labelledby="ik-cov-h">
        <div className="ik-block-head"><h3 id="ik-cov-h">Coverage found</h3><span className="muted">From policy administration</span></div>
        {ctx.policies.map((p) => (
          <div key={p.ref} className="ik-policy">
            <div className="ik-policy-head">
              <strong>{p.product}</strong>
              <span className="mono soft ik-ref">{p.ref}</span>
              <span className="grow" />
              <StatusTag status={p.status} />
            </div>
            <p className="soft">{p.summary}</p>
          </div>
        ))}
      </section>

      <section className="ik-block" aria-labelledby="ik-ep-h">
        <div className="ik-block-head"><h3 id="ik-ep-h">Elimination period</h3><span className="muted">{di.eliminationDays} days</span></div>
        {ep ? (
          <>
            <div className="ik-ep-row">
              <span>From <strong>{fmtDate(ep.start)}</strong></span>
              <span>ends <strong>{fmtDate(ep.end)}</strong></span>
            </div>
            <div className="meter ik-ep-meter" role="img" aria-label={`${ep.daysIn} of ${ep.days} days served`}><span style={{ width: `${(ep.daysIn / ep.days) * 100}%`, background: 'var(--ink-3)' }} /></div>
            <p className="muted">{ep.daysIn} of {ep.days} days served · benefits accrue from {fmtDate(ep.accrueFrom)} · first payment about {fmtDate(ep.firstPayment, { year: true })}</p>
            {wop && life && <p className="muted">Life waiver of premium on {life.ref} would start {fmtDate(wop, { year: true })}</p>}
          </>
        ) : (
          <p className="muted">Enter the first day unable to work to count the elimination period.</p>
        )}
      </section>

      <section className="ik-block" aria-labelledby="ik-checks-h">
        <div className="ik-block-head"><h3 id="ik-checks-h">Checks</h3></div>
        <ul className="ik-checks">
          {checks.map((c) => (
            <li key={c.id} className={`ik-checks-${c.tone}`}>
              <ToneShape tone={c.tone} />
              <span>{c.label}{c.note && <span className="muted"> · {c.note}</span>}</span>
            </li>
          ))}
        </ul>
      </section>

      <TriageCard triage={triage} proposal={proposal} onTriage={onTriage} />

      <section className="ik-block" aria-labelledby="ik-next-h">
        <div className="ik-block-head"><h3 id="ik-next-h">What happens when you submit</h3></div>
        <ol className="ik-next">
          <li><span className="ik-num-badge">1</span><span>Claim <span className="mono">{ctx.claimId}</span> created and acknowledged today by {[draft.contactBy.email && 'email', draft.contactBy.text && 'text'].filter(Boolean).join(' and ') || 'letter'}</span></li>
          <li><span className="ik-num-badge">2</span><span>{aps ? <>Physician statement requested from {aps.name}, {aps.practice}</> : <>Physician statement requested from the treating doctor <span className="muted">(step 4)</span></>}</span></li>
          <li><span className="ik-num-badge">3</span><span>Portal tasks for {ctx.person.name.split(' ')[0]}: {portal}</span></li>
          <li><span className="ik-num-badge">4</span><span>{draft.agentConsent === 'no' ? <>{ctx.agent.name} not notified — {ctx.person.name.split(' ')[0]} declined</> : <>{ctx.agent.name} notified — status only, never medical details</>}</span></li>
        </ol>
      </section>
    </aside>
  )
}

const TRACKS = ['Standard DI', 'Fast track DI', 'Complex DI']
const TEAMS = ['DI Team 1', 'DI Team 2']

/** The rules engine's triage preview. Dashed until accepted; editing or dismissing is logged at submit. */
function TriageCard({ triage, proposal, onTriage }: { triage: TriageProposal; proposal: ReturnType<typeof proposeTriage>; onTriage: (t: TriageState) => void }) {
  const [editing, setEditing] = useState(false)
  const [track, setTrack] = useState(triage.track)
  const [team, setTeam] = useState(triage.team)

  if (editing) {
    return (
      <div className="proposed ik-triage">
        <div className="proposed-kicker">Edit triage</div>
        <div className="ik-grid ik-grid--tight">
          <div className="field">
            <label htmlFor="ik-tr-track">Track</label>
            <select id="ik-tr-track" className="select" value={track} onChange={(e) => setTrack(e.target.value)}>
              {TRACKS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ik-tr-team">Team</label>
            <select id="ik-tr-team" className="select" value={team} onChange={(e) => setTeam(e.target.value)}>
              {TEAMS.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="proposed-actions">
          <span className="grow" />
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => { onTriage({ state: 'accepted', edited: track !== proposal.track || team !== proposal.team, track, team }); setEditing(false) }}>Save</button>
          <button type="button" className="btn btn--quiet btn--xs" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    )
  }

  if (triage.state !== 'open') {
    return (
      <div className="proposed proposed--accepted ik-triage" aria-live="polite">
        <div className="proposed-kicker" style={{ color: 'var(--ink-3)' }}>
          Triage {triage.state === 'accepted' ? (triage.edited ? 'edited and accepted' : 'accepted') : 'dismissed'} · logged when submitted
        </div>
        <div className="proposed-title">{triage.state === 'accepted' ? <>{triage.track} <Icon name="arrowRight" size={12} /> {triage.team}</> : 'The team lead routes this claim'}</div>
        <div className="proposed-actions">
          <span className="grow" />
          <button type="button" className="btn btn--quiet btn--xs" onClick={() => onTriage({ state: 'open', edited: false })}>Undo</button>
        </div>
      </div>
    )
  }

  return (
    <div className="proposed ik-triage">
      <div className="proposed-kicker">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" /></svg>
        Suggested · triage preview
      </div>
      <div className="proposed-title">{triage.track} <Icon name="arrowRight" size={12} /> {triage.team}</div>
      <div className="proposed-body">{triage.reason}</div>
      <div className="proposed-actions">
        <Sources items={[triage.source]} />
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--xs" onClick={() => onTriage({ state: 'accepted', edited: false })}>Accept</button>
        <button type="button" className="btn btn--ghost btn--xs" onClick={() => { setTrack(triage.track); setTeam(triage.team); setEditing(true) }}>Edit</button>
        <button type="button" className="btn btn--quiet btn--xs" onClick={() => onTriage({ state: 'dismissed', edited: false })}>Dismiss</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Product picker

/** Start a different claim: pick the product, which decides the intake form. */
function ProductPicker({ current, onClose, onPick }: { current: Product; onClose: () => void; onPick: (p: Product) => void }) {
  const [choice, setChoice] = useState<Product>(current === 'di' ? 'life' : current)
  return (
    <Drawer
      title="Start a different claim"
      onClose={onClose}
      width={480}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={() => onPick(choice)}>
            {choice === 'di' ? (current === 'di' ? 'Keep going' : 'Back to disability claim') : choice === 'life' ? 'Open life claim intake' : 'Start notice of death'}
          </button>
        </>
      }
    >
      <p className="soft">What is the caller reporting? The current disability draft stays saved and can be resumed.</p>
      <fieldset className="ik-fieldset">
        <legend className="ik-legend">Product</legend>
        <div className="radio-cards ik-cards-v">
          {PRODUCTS.map((p) => (
            <label key={p.key} className="radio-card">
              <input type="radio" name="product" checked={choice === p.key} onChange={() => setChoice(p.key)} />
              <span>{p.label}<span className="ik-card-note">{p.detail}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
    </Drawer>
  )
}

// ---------------------------------------------------------------- Notice of death (life / annuity)

const RELATIONSHIPS = ['Spouse or partner', 'Child', 'Parent', 'Other family', 'Executor or administrator', 'Funeral home', 'Agent of record', 'Other']

/** Short notice-of-death form for life and annuity claims, with a policy or contract lookup. Not wired to create a claim. */
function DeathNoticeIntake({ family, now, onPickProduct, onBack, onCaller }: {
  family: 'life' | 'annuity'
  now: () => string
  onPickProduct: () => void
  onBack: () => void
  onCaller: (name: string) => void
}) {
  const [n, setN] = useState<DeathNotice>({ family, callerName: '', relationship: '', callerPhone: '(555) 014-2291', deceasedName: '', deceasedDob: '', dateOfDeath: '', placeOfDeath: '', manner: '' })
  const [q, setQ] = useState('')
  const [qTouched, setQTouched] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const isLife = family === 'life'
  const query = qTouched ? q : n.deceasedName
  const matches = useMemo(() => lookupContracts(query, family), [query, family])
  const setF = (p: Partial<DeathNotice>) => setN((x) => ({ ...x, ...p }))

  useEffect(() => onCaller(n.callerName.trim()), [n.callerName, onCaller])

  const missing = [
    !n.callerName.trim() && 'caller’s name',
    !n.relationship && 'relationship',
    !n.deceasedName.trim() && 'name of the deceased',
    !isDate(n.dateOfDeath) && 'date of death',
    isDate(n.dateOfDeath) && n.dateOfDeath > TODAY && 'a date of death that isn’t in the future',
    !n.manner && (isLife ? 'manner of death' : 'role on the contract'),
  ].filter(Boolean) as string[]

  const title = isLife ? 'Life — death of the insured' : 'Annuity — death of the owner'
  const reqs = isLife
    ? ['Claimant statement', 'Certified death certificate', n.manner === 'accident' || n.manner === 'pending' ? 'Police or coroner report (accidental death rider)' : null]
    : ['Claimant statement', 'Certified death certificate', 'Beneficiary election of payout options', 'IRS Form W-9']

  return (
    <div className="ik-body">
      <nav className="ik-nav" aria-label="Notice of death">
        <div className="ik-nav-head">
          <h1>Notice of death</h1>
          <span className="soft">{title}</span>
          <button type="button" className="btn btn--ghost btn--xs ik-switch" onClick={onPickProduct}>Start a different claim</button>
        </div>
        <ol className="ik-steps">
          {['Caller', 'The deceased', isLife ? 'Policy' : 'Contract'].map((s, i) => (
            <li key={s}>
              <span className="ik-step ik-step--todo ik-step--static">
                <StepMark state="todo" n={i + 1} />
                <span className="ik-step-text"><span className="ik-step-label">{s}</span></span>
              </span>
            </li>
          ))}
        </ol>
        <div className="ik-nav-foot">
          <button type="button" className="btn btn--sm btn--block" onClick={onBack}>Back to disability intake</button>
          <p className="ik-saved"><Icon name="upload" size={13} />Disability draft saved — resume any time</p>
        </div>
      </nav>

      <main className="ik-main" aria-labelledby="ik-dn-h">
        <div className="ik-scroll">
          <div className="ik-form">
            <span className="ik-kicker">{title}</span>
            <h2 id="ik-dn-h" className="ik-h">Take the notice of death</h2>
            {done ? (
              <div className="ik-dn-done" role="status">
                <h3><ToneShape tone="positive" /> Notice recorded at {done}</h3>
                <p>This would create a {isLife ? 'life' : 'annuity'} claim for <strong>{n.deceasedName}</strong>{n.match ? <> on <span className="mono">{n.match.ref}</span> ({n.match.line})</> : ' with the policy to be located'}, reported by {n.callerName} ({n.relationship.toLowerCase()}).</p>
                {n.match && <p className="soft">A claim is already open for this {isLife ? 'policy' : 'contract'} — <span className="mono">{n.match.claimId}</span>. The notice would be linked to it rather than starting a duplicate.</p>}
                <p className="muted">Not wired in the mock — no claim, requirement or letter was created.</p>
                <div className="ik-foot-row">
                  <button type="button" className="btn" onClick={() => { setDone(null); setN({ family, callerName: '', relationship: '', callerPhone: '', deceasedName: '', deceasedDob: '', dateOfDeath: '', placeOfDeath: '', manner: '' }); setQ(''); setQTouched(false) }}>Start another notice</button>
                  <button type="button" className="btn btn--primary" onClick={onBack}>Back to disability intake</button>
                </div>
              </div>
            ) : (
              <>
                <Say>‘I’m so sorry for your loss. I’ll take a few details now, and we’ll send you a short checklist — you won’t need everything today.’</Say>
                <Section title="Who’s calling">
                  <div className="ik-grid">
                    <Field id="dn-caller" label="Caller’s name">
                      <input id="dn-caller" className="input" value={n.callerName} onChange={(e) => setF({ callerName: e.target.value })} />
                    </Field>
                    <Field id="dn-rel" label="Relationship to the deceased">
                      <select id="dn-rel" className="select" value={n.relationship} onChange={(e) => setF({ relationship: e.target.value })}>
                        <option value="">Choose…</option>
                        {RELATIONSHIPS.map((r) => <option key={r}>{r}</option>)}
                      </select>
                    </Field>
                    <Field id="dn-phone" label="Call-back number">
                      <input id="dn-phone" className="input" value={n.callerPhone} onChange={(e) => setF({ callerPhone: e.target.value })} />
                    </Field>
                  </div>
                </Section>
                <Section title="The deceased">
                  <div className="ik-grid">
                    <Field id="dn-name" label="Full name">
                      <input id="dn-name" className="input" value={n.deceasedName} onChange={(e) => setF({ deceasedName: e.target.value, match: undefined })} />
                    </Field>
                    <Field id="dn-dob" label="Date of birth (optional)">
                      <input id="dn-dob" className="input ik-date" type="date" max={TODAY} value={n.deceasedDob} onChange={(e) => setF({ deceasedDob: e.target.value })} />
                    </Field>
                    <Field id="dn-dod" label="Date of death">
                      <input id="dn-dod" className="input ik-date" type="date" max={TODAY} value={n.dateOfDeath} onChange={(e) => setF({ dateOfDeath: e.target.value })} />
                    </Field>
                    <Field id="dn-place" label="Place of death (optional)">
                      <input id="dn-place" className="input" value={n.placeOfDeath} onChange={(e) => setF({ placeOfDeath: e.target.value })} placeholder="City, state or country" />
                    </Field>
                  </div>
                  {isLife ? (
                    <Choice legend="Manner of death, as the caller understands it" name="manner" value={n.manner} options={[{ value: 'natural', label: 'Natural causes' }, { value: 'accident', label: 'Accident' }, { value: 'pending', label: 'Pending or unknown' }]} onChange={(x) => setF({ manner: x })} hint="Only used to see whether an accidental death rider might apply" />
                  ) : (
                    <Choice legend="The deceased was the" name="role" value={n.manner} options={[{ value: 'ownerAnnuitant', label: 'Owner and annuitant' }, { value: 'owner', label: 'Owner only' }, { value: 'annuitant', label: 'Annuitant only' }]} onChange={(x) => setF({ manner: x })} hint="Decides whether a death benefit is payable or ownership passes" />
                  )}
                </Section>
                <Section title={isLife ? 'Policy lookup' : 'Contract lookup'} aside="Searches policy administration by name or number">
                  <Field id="dn-q" label={isLife ? 'Insured’s name or policy number' : 'Owner’s name or contract number'}>
                    <input id="dn-q" className="input" value={query} onChange={(e) => { setQTouched(true); setQ(e.target.value) }} placeholder={isLife ? 'e.g. Pierce or LP-1107752' : 'e.g. Hart or FA-1503378'} />
                  </Field>
                  {query.trim().length >= 2 && (
                    matches.length ? (
                      <fieldset className="ik-fieldset">
                        <legend className="ik-legend">{matches.length} found</legend>
                        <div className="radio-cards ik-cards-v">
                          {matches.map((m: ContractMatch) => (
                            <label key={m.ref} className="radio-card">
                              <input type="radio" name="match" checked={n.match?.ref === m.ref} onChange={() => setF({ match: m })} />
                              <span>
                                {m.name} · <span className="mono">{m.ref}</span> · {m.line}{m.amount ? ` · ${fmtMoney(m.amount)}` : ''}
                                <span className="ik-card-note">Claim <span className="mono">{m.claimId}</span> already open · {m.claimStatus.label}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : (
                      <p className="ik-hint">No {isLife ? 'policy' : 'contract'} found for “{query.trim()}”. Take the notice anyway — a policy locator search starts with it.</p>
                    )
                  )}
                </Section>
              </>
            )}
          </div>
        </div>
        {!done && (
          <div className="ik-foot">
            {missing.length > 0 && (
              <p className="ik-missing" role="status"><ToneShape tone="caution" /><span>To submit, add: {missing.join(' · ')}</span></p>
            )}
            <div className="ik-foot-row">
              <button type="button" className="btn" onClick={onBack}><Icon name="chevronLeft" size={12} />Back</button>
              <span className="grow" />
              <button type="button" className="btn btn--primary" disabled={missing.length > 0} onClick={() => setDone(now())}>Record notice of death<Icon name="arrowRight" size={12} /></button>
            </div>
          </div>
        )}
      </main>

      <aside className="ik-side" aria-label="What happens next">
        <div className="ik-side-head"><h2>Notice so far</h2><Tag tone="neutral">Draft</Tag></div>
        <div className="ik-who">
          <strong className="ik-who-name">{n.deceasedName || 'The deceased'}</strong>
          <span className="muted">{isDate(n.dateOfDeath) ? `Died ${fmtDate(n.dateOfDeath, { year: true })}` : 'Date of death not given'}{n.placeOfDeath ? ` · ${n.placeOfDeath}` : ''}</span>
          <span className="muted">{n.callerName ? `Reported by ${n.callerName}${n.relationship ? `, ${n.relationship.toLowerCase()}` : ''}` : 'Caller not named yet'}</span>
        </div>
        <section className="ik-block" aria-labelledby="ik-dn-match-h">
          <div className="ik-block-head"><h3 id="ik-dn-match-h">{isLife ? 'Policy' : 'Contract'}</h3></div>
          {n.match ? (
            <div className="ik-policy">
              <div className="ik-policy-head"><strong>{n.match.line}</strong><span className="mono soft ik-ref">{n.match.ref}</span><span className="grow" /><StatusTag status={n.match.claimStatus} /></div>
              <p className="soft">Existing claim {n.match.claimId} · the notice links to it</p>
            </div>
          ) : (
            <p className="muted">Not matched yet — search by name or number.</p>
          )}
        </section>
        <section className="ik-block" aria-labelledby="ik-dn-next-h">
          <div className="ik-block-head"><h3 id="ik-dn-next-h">What happens when you submit</h3></div>
          <ol className="ik-next">
            <li><span className="ik-num-badge">1</span><span>{isLife ? 'Life' : 'Annuity'} claim created and acknowledged to the caller</span></li>
            <li><span className="ik-num-badge">2</span><span>Requested: {reqs.filter(Boolean).join(' · ')}</span></li>
            <li><span className="ik-num-badge">3</span><span>{isLife ? 'Interest on the proceeds starts accruing from the date of death' : 'The contract value is watched for market movement until good order'}</span></li>
            <li><span className="ik-num-badge">4</span><span>Agent of record notified with the beneficiary’s consent — status only</span></li>
          </ol>
          <p className="muted">Mock: recording shows a confirmation; it doesn’t create a claim.</p>
        </section>
      </aside>
    </div>
  )
}
