import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { getFlow } from '../api/lifeFlow'
import { LIVE } from '../api/live/config'
import { ApiError } from '../api/live/http'
import { intakeIssues, type IntakeIssue } from '../api/live/data'
import { submitLifeIntake as submitLive } from '../api/live/intake'
import {
  ageOnDate,
  getLifeIntakeContext,
  inPlay,
  lifeChecks,
  lifeDraftFromContext,
  payable,
  requirementSet,
  routeLife,
  slaPreview,
  submitLifeIntake,
  twoYearsFrom,
  type BeneficiaryContact,
  type LifeDraft,
  type LifeIntakeContext,
  type Variation,
} from '../api/lifeIntake'
import { MARK_CONTACT } from '../api/fixtures/lifeIntake'
import { addBusinessDays, fmtDate, TODAY } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { cx } from '../lib/cx'
import { StatusTag, Tag, ToneShape } from '../components/Tag'
import { Icon } from '../components/Icon'
import { Sources } from '../components/Sources'
import { Loading } from '../components/Planned'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import { CallBar, Check, Choice, Field, SampleButton, Say, Section, StepMark } from './intakeParts'
import { clockTime, isDate, useCallClock, YES_NO, type CallState } from './intakeCall'
import './intake.css'

type StepKey = 'caller' | 'deceased' | 'policies' | 'beneficiaries' | 'review'

const STEPS: { key: StepKey; label: string }[] = [
  { key: 'caller', label: 'Caller' },
  { key: 'deceased', label: 'The deceased' },
  { key: 'policies', label: 'Policies' },
  { key: 'beneficiaries', label: 'Beneficiaries' },
  { key: 'review', label: 'Review & submit' },
]

const RELATIONSHIPS = ['Spouse or partner', 'Child', 'Parent', 'Sibling', 'Other family', 'Executor or administrator', 'Funeral home', 'Agent of record', 'Other']

const MANNER_TEXT = { natural: 'Natural causes', accident: 'Accident', pending: 'Pending or unknown', '': '—' }

/** Mock only: how the outside world behaves once the claim is submitted. */
const VARIATIONS: { value: Variation; label: string; hint: string }[] = [
  { value: 'none', label: 'As designed', hint: 'Evidence arrives, every service level is met, one beneficiary’s statement is a little late.' },
  { value: 'evidence', label: 'Evidence never arrives', hint: 'One beneficiary never sends a statement. Reminders, a call task and status letters follow, then the request expires: waive it, or close the claim incomplete.' },
  { value: 'late', label: 'A service level is missed', hint: 'The dispatcher is paused, so first contact is missed. The nightly check finds it, the deadline workflow alerts, and the breach shows red.' },
  { value: 'competing', label: 'A competing claimant appears', hint: 'A second person claims one beneficiary’s half. That half is held: resolve it, or file an interpleader.' },
  { value: 'bounce', label: 'Things bounce back', hint: 'A worker restarts mid-run, a W-9 fails the IRS check, the certificate is a photocopy, the letters service goes down, and the bank returns a payment. Each bounce is a new short workflow; the claim closes, reopens and closes again.' },
]

// ---------------------------------------------------------------- Page

/** Life claim intake: a phone notice of death that creates the claim and starts its workflow. */
export function LifeIntake() {
  const { data: ctx } = useQuery(() => getLifeIntakeContext(), [])
  if (!ctx) {
    return (
      <div className="ik">
        <div className="ik-loading"><Loading rows={6} /></div>
      </div>
    )
  }
  return <LifeCall ctx={ctx} />
}

function LifeCall({ ctx }: { ctx: LifeIntakeContext }) {
  const { user, openTab } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const clock = useCallClock(ctx.call.elapsed)
  // The mock remembers a submitted claim in its flows; a live submit is remembered here (the backend numbers its own claims).
  const { data: flow } = useQuery(() => (LIVE ? Promise.resolve(null) : getFlow(ctx.claimId)), [ctx.claimId])
  const [liveNumber, setLiveNumber] = useState<string | null>(null)
  const [issues, setIssues] = useState<IntakeIssue[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [callState, setCallState] = useState<CallState>('live')
  const [draft, setDraft] = useState<LifeDraft>(() => lifeDraftFromContext(ctx))
  const [step, setStep] = useState(0)
  const [visited, setVisited] = useState<Set<number>>(() => new Set([0]))
  const [savedAt, setSavedAt] = useState(ctx.call.started)
  const [updatedAt, setUpdatedAt] = useState(ctx.call.started)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const headRef = useRef<HTMLHeadingElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shownStep = useRef(step)
  const now = () => clockTime(ctx.call.started, clock.elapsed())

  useEffect(() => {
    if (shownStep.current === step) return
    shownStep.current = step
    scrollRef.current?.scrollTo({ top: 0 })
    headRef.current?.focus()
  }, [step])

  const set = (patch: Partial<LifeDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setUpdatedAt(now())
  }

  const missing = STEPS.map((s) => missingFor(s.key, draft, ctx))
  const earlier = STEPS.slice(0, -1).filter((_, i) => missing[i].length > 0).map((s) => s.label)
  const current = STEPS[step]
  const curMissing = current.key === 'review' ? [...earlier.map((l) => `${l} step`), ...missing[step]] : missing[step]
  const submitted = !!flow || liveNumber !== null
  const shownClaimId = liveNumber ?? ctx.claimId
  const verified = draft.verifiedDob && draft.verifiedPolicy
  const callerFirst = draft.callerName.split(' ')[0] || 'the caller'

  function go(i: number) {
    setConfirming(false)
    setVisited((v) => new Set(v).add(i))
    setStep(i)
    setSavedAt(now())
  }

  async function submit() {
    setBusy(true)
    setIssues([])
    setFailure(null)
    if (LIVE) {
      try {
        const number = await submitLive(ctx, draft)
        setLiveNumber(number)
        openTab(number)
        navigate(`/claims/${number}/workflow`)
        toast(`Claim ${number} created · the intake workflow is running on the backend`)
      } catch (e) {
        // A 422 lists the fields the API rejected; anything else (unreachable, 409, 400) is shown with its code and detail.
        if (e instanceof ApiError && e.errors.length > 0) setIssues(intakeIssues(e))
        setFailure(e instanceof ApiError ? `${e.title} (${e.code})${e.detail ? `: ${e.detail}` : ''}` : (e as Error).message)
        toast((e as Error).message)
        setBusy(false)
      }
      return
    }
    try {
      const id = await submitLifeIntake(ctx, draft, user.name, now())
      openTab(id)
      navigate(`/claims/${id}/workflow/replay`)
      toast(`Claim ${id} created · intake run finished · ${routeLife(ctx, draft).track} → ${routeLife(ctx, draft).examiner}`)
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
      setConfirming(false)
    }
  }

  const stepProps = { ctx, draft, set, first: callerFirst }

  return (
    <div className="ik">
      <CallBar
        call={ctx.call}
        user={user}
        clock={clock}
        state={callState}
        caller={verified ? { tone: 'positive', label: `Caller verified — ${draft.callerName}`, detail: ' (DOB, policy number)' } : { tone: 'caution', label: `Caller not verified yet · ${draft.callerName || 'unnamed'}`, detail: ' · notice of death' }}
        onHold={() => setCallState((s) => (s === 'hold' ? 'live' : 'hold'))}
        onTransfer={(to) => toast(`Warm transfer to ${to} requested · the draft goes with the call`)}
        onEnd={() => { clock.end(); setCallState('ended'); toast(`Call ended at ${now()} · draft saved — any intake user can resume it`) }}
        transferTo={['Life & annuity claims', 'Bereavement support line', 'Spanish-language line', 'Supervisor']}
      />
      <div className="ik-body">
        <nav className="ik-nav" aria-label="Intake steps">
          <div className="ik-nav-head">
            <h1>New life claim</h1>
            <span className="soft">Notice of death · phone · started {ctx.call.started}</span>
            <button type="button" className="btn btn--ghost btn--xs ik-switch" onClick={() => navigate('/intake')}>Disability intake</button>
          </div>
          <ol className="ik-steps">
            {STEPS.map((s, i) => {
              const isCur = i === step
              const done = !isCur && visited.has(i) && missing[i].length === 0
              const attention = !isCur && visited.has(i) && missing[i].length > 0
              const state = isCur ? 'current' : done ? 'done' : attention ? 'attention' : 'todo'
              const sum = isCur ? 'In progress' : done ? stepSummary(s.key, draft, ctx) : attention ? `Needs: ${missing[i][0]}` : ''
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

        <main className="ik-main" aria-labelledby="li-step-h">
          <div className="ik-scroll" ref={scrollRef}>
            <div className="ik-form">
              {submitted && (
                <div className="callout-info ik-submitted">
                  <ToneShape tone="info" />
                  <span className="grow">{shownClaimId} has already been submitted from this call.</span>
                  <button type="button" className="btn btn--ghost btn--xs" onClick={() => { openTab(shownClaimId); navigate(`/claims/${shownClaimId}/workflow`) }}>Open its workflow</button>
                </div>
              )}
              <span className="ik-kicker">Step {step + 1} of {STEPS.length}</span>
              <h2 id="li-step-h" ref={headRef} tabIndex={-1} className="ik-h">{current.label}</h2>
              {current.key === 'caller' && <CallerStep {...stepProps} />}
              {current.key === 'deceased' && <DeceasedStep {...stepProps} />}
              {current.key === 'policies' && <PoliciesStep {...stepProps} />}
              {current.key === 'beneficiaries' && <BeneficiariesStep {...stepProps} />}
              {current.key === 'review' && <ReviewStep {...stepProps} onEdit={go} />}
            </div>
          </div>

          <div className="ik-foot">
            {confirming && current.key === 'review' ? (
              <div className="ik-confirm" role="alertdialog" aria-labelledby="li-confirm-h" aria-describedby="li-confirm-d">
                <div>
                  <h3 id="li-confirm-h">Submit the claim for {ctx.insured.name}?</h3>
                  <p id="li-confirm-d" className="soft">{LIVE ? 'Sends the notice to the claims API. It saves the claim, its requirements and the first deadline rows in one transaction; the intake workflow then runs on Temporal, checks the claim and sends the acknowledgement and packets.' : `Saves the notice and starts the intake run: checks, claim ${ctx.claimId}, ${requirementSet(ctx, draft).length} requirements, the acknowledgement and claim packets, and the deadlines.`} The draft can’t be edited after this — changes go on the claim.</p>
                  {failure && (
                    <div className="ik-fail" role="alert">
                      <ToneShape tone="critical" />
                      <div>
                        <strong>The backend did not accept it.</strong> <span className="soft">{failure}</span>
                        {issues.length > 0 && (
                          <ul>
                            {issues.map((i) => <li key={`${i.field}:${i.message}`}><strong>{i.step}</strong> · <span className="mono">{i.field}</span> {i.message}</li>)}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="ik-foot-row">
                  <button type="button" className="btn" onClick={() => setConfirming(false)} disabled={busy}>Keep editing</button>
                  <span className="grow" />
                  <button type="button" className="btn btn--primary" onClick={submit} disabled={busy} autoFocus>
                    {busy ? 'Submitting…' : 'Submit and watch the workflow'}
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
                  <button type="button" className="btn" onClick={() => { setSavedAt(now()); toast(`Draft saved ${now()} — any intake user can resume it`) }}>Save draft</button>
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

        <ClaimSoFar ctx={ctx} draft={draft} updatedAt={updatedAt} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Validation & summaries

function missingFor(step: StepKey, d: LifeDraft, ctx: LifeIntakeContext): string[] {
  const m: string[] = []
  switch (step) {
    case 'caller':
      if (!d.callerName.trim()) m.push('caller’s name')
      if (!d.relationship) m.push('relationship')
      if (!d.phone.trim() && !d.email.trim()) m.push('a phone number or email')
      if (!Object.values(d.contactBy).some(Boolean)) m.push('how to keep in touch')
      if (!(d.verifiedDob && d.verifiedPolicy)) m.push('both identity checks')
      if (!d.agentConsent) m.push('agent consent')
      break
    case 'deceased':
      if (!isDate(d.dateOfDeath)) m.push('date of death')
      else if (d.dateOfDeath > TODAY) m.push('a date of death that isn’t in the future')
      else if (d.dateOfDeath < ctx.insured.dob) m.push('a date of death after the date of birth')
      if (!d.placeOfDeath.trim()) m.push('place of death')
      if (!d.manner) m.push('manner of death')
      if (!d.outsideUs) m.push('died outside the US?')
      break
    case 'policies':
      if (d.claimRefs.length === 0) m.push('a policy to claim')
      if (!d.readBack) m.push('coverage read back')
      break
    case 'beneficiaries':
      for (const b of inPlay(ctx, d).payees) {
        const c = d.contacts[b.id]
        if (!c?.phone.trim() && !c?.email.trim()) m.push(`${b.name.split(' ')[0]}’s phone or email`)
        if (!c?.packet) m.push(`how ${b.name.split(' ')[0]} gets the packet`)
      }
      if (!d.otherClaimants) m.push('anyone else claiming?')
      break
    case 'review':
      if (!d.nextStepsRead) m.push('next steps read back')
      break
  }
  return m
}

function stepSummary(step: StepKey, d: LifeDraft, ctx: LifeIntakeContext): string {
  switch (step) {
    case 'caller':
      return `${d.callerName} · ${d.relationship.toLowerCase()} · verified`
    case 'deceased':
      return `Died ${fmtDate(d.dateOfDeath)} · ${MANNER_TEXT[d.manner].toLowerCase()}`
    case 'policies':
      return `${d.claimRefs.join(', ')} claimed · ${ctx.policies.length - d.claimRefs.length} not`
    case 'beneficiaries':
      return inPlay(ctx, d).payees.map((b) => `${b.name.split(' ')[0]} ${b.share}%`).join(' · ')
    default:
      return ''
  }
}

// ---------------------------------------------------------------- Steps

interface StepProps {
  ctx: LifeIntakeContext
  draft: LifeDraft
  set: (patch: Partial<LifeDraft>) => void
  first: string
}

function CallerStep({ ctx, draft, set, first }: StepProps) {
  const insured = ctx.insured.name.split(' ')[0]
  return (
    <>
      <p className="ik-lede">Take the notice with care. Confirm the caller knows {insured}’s details before discussing his policies.</p>
      <Say>‘I’m so sorry for your loss. I’ll take a few details now and we’ll send you a short checklist — you won’t need everything today.’</Say>
      <Section title="Who’s calling">
        <div className="ik-grid">
          <Field id="li-name" label="Caller’s name">
            <input id="li-name" className="input" value={draft.callerName} onChange={(e) => set({ callerName: e.target.value })} />
          </Field>
          <Field id="li-rel" label={`Relationship to ${insured}`}>
            <select id="li-rel" className="select" value={draft.relationship} onChange={(e) => set({ relationship: e.target.value })}>
              <option value="">Choose…</option>
              {RELATIONSHIPS.map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          <Field id="li-phone" label="Phone">
            <input id="li-phone" className="input" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field id="li-email" label="Email">
            <input id="li-email" className="input" type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} />
          </Field>
        </div>
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

      <Section title="Identity" aside="Compared with the policy record">
        <div className="ik-checks-list">
          <Check checked={draft.verifiedDob} onChange={(x) => set({ verifiedDob: x })}>Caller gave {insured}’s date of birth <span className="muted">· on file {fmtDate(ctx.insured.dob, { year: true })}</span></Check>
          <Check checked={draft.verifiedPolicy} onChange={(x) => set({ verifiedPolicy: x })}>Caller gave the policy number or the last 4 of his SSN <span className="muted">· on file {ctx.policies[0].ref} · ••{ctx.insured.ssnLast4}</span></Check>
        </div>
        <p className="ik-hint">Enough to take the notice and send forms. Each beneficiary proves who they are on their own claimant statement.</p>
      </Section>

      <Section title="Agent of record">
        <p>{ctx.agent.name}, {ctx.agent.agency}. With consent he sees the claim’s status — never personal or medical details.</p>
        <Choice legend={`May we tell ${ctx.agent.name} how the claim is going?`} name="li-consent" value={draft.agentConsent} options={YES_NO} onChange={(x) => set({ agentConsent: x })} />
        <Say>‘{insured}’s agent, {ctx.agent.name}, can be told how the claim is going. Is that all right with you, {first}?’</Say>
      </Section>
    </>
  )
}

function DeceasedStep({ ctx, draft, set }: StepProps) {
  const age = isDate(draft.dateOfDeath) ? ageOnDate(ctx.insured.dob, draft.dateOfDeath) : undefined
  return (
    <>
      <p className="ik-lede">{ctx.insured.name}, born {fmtDate(ctx.insured.dob, { year: true })}, of {ctx.insured.address}. Ask only what the claim needs; the certificate confirms the rest.</p>
      <Section title="The death">
        <div className="ik-grid">
          <Field id="li-dod" label="Date of death" hint={age !== undefined ? `Age ${age} · interest on the proceeds runs from this date` : 'Interest on the proceeds runs from this date'}>
            <input id="li-dod" className="input ik-date" type="date" max={TODAY} value={draft.dateOfDeath} onChange={(e) => set({ dateOfDeath: e.target.value })} />
          </Field>
          <Field id="li-place" label="Place of death">
            <input id="li-place" className="input" value={draft.placeOfDeath} onChange={(e) => set({ placeOfDeath: e.target.value })} placeholder="Home, hospital, city and state" />
          </Field>
        </div>
        <Choice
          legend="Manner of death, as the caller understands it"
          name="li-manner"
          value={draft.manner}
          options={[{ value: 'natural', label: 'Natural causes' }, { value: 'accident', label: 'Accident' }, { value: 'pending', label: 'Pending or unknown' }]}
          onChange={(x) => set({ manner: x })}
          hint="Decides whether the accidental death rider could pay, and which evidence is asked for. The certificate is what counts."
        />
        <Choice legend="Did the death happen outside the US?" name="li-abroad" value={draft.outsideUs} options={YES_NO} onChange={(x) => set({ outsideUs: x })} hint="A foreign death needs an apostilled certificate and goes to the standard track." />
      </Section>
      {LIVE ? (
        <Section title="After you submit" aside="Live">
          <p className="soft">The claim goes to the real backend. Nothing is scripted: the intake workflow runs on Temporal, deadline rows fire when their time comes (move time with Demo controls), and requirements are accepted from the claim’s Requirements section.</p>
        </Section>
      ) : (
      <Section title="How the mock plays this claim" aside="Mock only">
        <Choice
          legend="What the outside world does after submit"
          name="li-variation"
          value={draft.variation}
          options={VARIATIONS.map((v) => ({ value: v.value, label: v.label }))}
          onChange={(x) => set({ variation: x })}
          hint={`${VARIATIONS.find((v) => v.value === draft.variation)?.hint} You play it step by step on the claim’s Workflow & SLA page.`}
        />
      </Section>
      )}
      <Section title="Funeral home" aside="Optional">
        <Field id="li-fh" label="Funeral home" hint="No assignment is on file. If the family assigns part of the proceeds to the funeral home, it files the assignment with us.">
          <input id="li-fh" className="input" value={draft.funeralHome} onChange={(e) => set({ funeralHome: e.target.value })} />
        </Field>
      </Section>
      <Say>‘Thank you. Do you know if the funeral home has ordered certified copies of the death certificate? We’ll need one — it can be mailed or uploaded.’</Say>
    </>
  )
}

function PoliciesStep({ ctx, draft, set, first }: StepProps) {
  const dod = isDate(draft.dateOfDeath) ? draft.dateOfDeath : TODAY
  const riderNote = {
    natural: 'Natural causes, so this rider won’t pay. It is still decided, and the letter explains why.',
    accident: 'It may pay another benefit. We’ll ask for the police or accident report.',
    pending: 'Decided when the final cause is known. We’ll ask the medical examiner for the amended certificate.',
    '': 'Pays only for an accidental death.',
  }[draft.manner]
  return (
    <>
      <p className="ik-lede">Found automatically in policy administration by name, date of birth and SSN. Read-only here.</p>
      <Section title="Policies found" aside="From policy administration">
        {ctx.policies.map((p) => {
          const ends = twoYearsFrom(p.issued)
          return (
            <article key={p.ref} className="ik-policy-card" aria-label={`${p.product} ${p.ref}`}>
              <div className="ik-policy-head">
                <strong>{p.product}</strong>
                <span className="mono soft">{p.ref}</span>
                <span className="grow" />
                <StatusTag status={p.inForce ? { label: 'In force', tone: 'positive' } : { label: `Lapsed ${fmtDate(p.lapsed ?? p.paidTo, { year: true })}`, tone: 'neutral' }} />
              </div>
              <dl className="dl ik-dl">
                <dt>Face amount</dt><dd>{fmtMoney(p.faceAmount)}</dd>
                <dt>Issued</dt><dd>{fmtDate(p.issued, { year: true })} · contestable period and suicide exclusion {dod >= ends ? 'ended' : 'end'} {fmtDate(ends, { year: true })}</dd>
                <dt>Premium</dt><dd>Paid to {fmtDate(p.paidTo, { year: true })}{!p.inForce ? ' · not paid since' : ''}</dd>
                <dt>Owner</dt><dd>{p.owner}</dd>
                {p.riders.map((r) => (
                  <Fragment key={r.key}>
                    <dt>Rider</dt>
                    <dd>{r.name} · {fmtMoney(r.amount)}<span className="ik-card-note">{riderNote}</span></dd>
                  </Fragment>
                ))}
              </dl>
              <div className="ik-policy-foot"><Sources items={[p.source]} /></div>
              {p.inForce ? (
                <Check checked={draft.claimRefs.includes(p.ref)} onChange={(x) => set({ claimRefs: x ? [...draft.claimRefs, p.ref] : draft.claimRefs.filter((r) => r !== p.ref) })}>Claim the death benefit under {p.ref}</Check>
              ) : (
                <p className="ik-hint">Lapsed for non-payment in {p.lapsed?.slice(0, 4)}. Nothing is payable — say so gently if {first} asks about it.</p>
              )}
            </article>
          )
        })}
      </Section>
      <Say>‘Your father had a whole life policy with us for {fmtMoney(ctx.policies[0].faceAmount).replace('.00', '')}. There was also a term policy, but it ended in {ctx.policies[1]?.lapsed?.slice(0, 4)}, so it doesn’t pay.’</Say>
      <Check checked={draft.readBack} onChange={(x) => set({ readBack: x })}>Coverage read back to {first}</Check>
    </>
  )
}

function BeneficiariesStep({ ctx, draft, set, first }: StepProps) {
  const { payees, primaryGone } = inPlay(ctx, draft)
  const setContact = (id: string, patch: Partial<BeneficiaryContact>) => set({ contacts: { ...draft.contacts, [id]: { ...draft.contacts[id], ...patch } } })
  const mark = payees.find((b) => b.name !== draft.callerName)
  return (
    <>
      <div className="ik-lede-row">
        <p className="ik-lede">The designation on file decides who is paid, not the call. Take contact details so each beneficiary gets their own claim packet.</p>
        {mark && <SampleButton onClick={() => setContact(mark.id, { ...MARK_CONTACT, packet: 'portal' })} />}
      </div>
      <Section title="Beneficiary designation" aside={<Sources items={[ctx.designation.source]} />}>
        <table className="tbl tbl--middle ik-bene">
          <thead><tr><th>Name</th><th>Relationship</th><th>Type</th><th className="r">Share</th><th>Status</th></tr></thead>
          <tbody>
            {ctx.designation.beneficiaries.map((b) => (
              <tr key={b.id}>
                <td className="strong">{b.name}{b.name === draft.callerName && <span className="muted"> · caller</span>}</td>
                <td>{b.relationship}</td>
                <td>{b.kind === 'primary' ? 'Primary' : 'Contingent'}</td>
                <td className="r">{b.share}%</td>
                <td>{b.died ? <Tag tone="neutral">Died {fmtDate(b.died, { year: true })}</Tag> : payees.includes(b) ? <Tag tone="info">Will be paid</Tag> : <Tag>Not paid</Tag>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {primaryGone && (
          <p className="ik-hint">
            {ctx.designation.beneficiaries.find((b) => b.kind === 'primary')?.name} died first, so the contingent beneficiaries take their shares. Her death is already proved by our records ({ctx.designation.beneficiaries.find((b) => b.kind === 'primary')?.diedSource}) — nothing to ask for.
          </p>
        )}
      </Section>
      {payees.map((b) => {
        const c = draft.contacts[b.id]
        const isCaller = b.name === draft.callerName
        return (
          <fieldset key={b.id} className="ik-provider">
            <legend className="ik-legend">{b.name} · {b.share}%{isCaller ? ' · on the call' : ''}</legend>
            <div className="ik-grid">
              <Field id={`${b.id}-phone`} label="Phone">
                <input id={`${b.id}-phone`} className="input" value={c?.phone ?? ''} onChange={(e) => setContact(b.id, { phone: e.target.value })} />
              </Field>
              <Field id={`${b.id}-email`} label="Email">
                <input id={`${b.id}-email`} className="input" type="email" value={c?.email ?? ''} onChange={(e) => setContact(b.id, { email: e.target.value })} />
              </Field>
            </div>
            <Field id={`${b.id}-addr`} label="Mailing address">
              <input id={`${b.id}-addr`} className="input" value={c?.address ?? ''} onChange={(e) => setContact(b.id, { address: e.target.value })} />
            </Field>
            <Choice
              legend="How should the claim packet go?"
              name={`${b.id}-packet`}
              value={c?.packet ?? ''}
              options={[{ value: 'portal', label: 'Portal invite by email' }, { value: 'mail', label: 'Paper packet by mail' }]}
              onChange={(x) => setContact(b.id, { packet: x })}
              hint={isCaller ? undefined : `${first} gives what she knows; ${b.name.split(' ')[0]} confirms it on his own statement.`}
            />
          </fieldset>
        )
      })}
      <Section title="Anyone else">
        <Choice legend="Is anyone else likely to claim?" name="li-others" value={draft.otherClaimants} options={YES_NO} onChange={(x) => set({ otherClaimants: x })} hint="A former spouse, a creditor, the estate — anything that could compete sends the claim to the standard track." />
      </Section>
      <Say>‘{mark ? `${mark.name.split(' ')[0]} and you` : 'You'} will each get a claim packet. Each of you signs your own statement — that’s how we pay you directly.’</Say>
    </>
  )
}

function ReviewStep({ ctx, draft, set, first, onEdit }: StepProps & { onEdit: (i: number) => void }) {
  const { payees } = inPlay(ctx, draft)
  const route = routeLife(ctx, draft)
  const rows: [number, string, ReactNode][] = [
    [0, 'Caller', <>{draft.callerName} · {draft.relationship.toLowerCase() || '—'} · {draft.verifiedDob && draft.verifiedPolicy ? 'verified' : 'not verified'} · agent consent {draft.agentConsent || '—'}</>],
    [1, 'The deceased', <>{ctx.insured.name} · died {isDate(draft.dateOfDeath) ? fmtDate(draft.dateOfDeath, { year: true }) : '—'} · {draft.placeOfDeath || '—'} · {MANNER_TEXT[draft.manner]}{draft.variation !== 'none' && <> · mock path: {VARIATIONS.find((v) => v.value === draft.variation)?.label.toLowerCase()}</>}</>],
    [2, 'Policies', <>{draft.claimRefs.join(', ') || 'none'} claimed · {fmtMoney(payable(ctx, draft).total)} could be payable, plus interest</>],
    [3, 'Beneficiaries', <>{payees.map((b) => `${b.name} ${b.share}% · ${draft.contacts[b.id]?.packet === 'mail' ? 'mail' : 'portal'}`).join(' · ')}</>],
  ]
  return (
    <>
      <p className="ik-lede">Check the notice with {first} before it is submitted. Anything changed after this goes on the claim, with history.</p>
      <Section title="Summary">
        <dl className="ik-review">
          {rows.map(([i, label, value]) => {
            const miss = missingFor(STEPS[i].key, draft, ctx)
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
            <dt>Route</dt>
            <dd>{route.track} → {route.examiner} <span className="muted">· rule {route.rule}</span></dd>
            <span />
          </div>
        </dl>
      </Section>
      <Section title="Before you submit">
        <Say verb="Read back">‘You’ll get an email and a text in a few minutes with your claim number{LIVE ? '' : ` ${ctx.claimId}`}. {route.examiner}, your examiner, will call you by {fmtDate(addBusinessDays(TODAY, 1), { weekday: true })}. We need a certified death certificate, and a signed statement from {payees.map((b) => (b.name === draft.callerName ? 'you' : b.name.split(' ')[0])).join(' and ')}. We decide within 30 days of having everything, and interest is paid from the date of death.’</Say>
        <Check checked={draft.nextStepsRead} onChange={(x) => set({ nextStepsRead: x })}>Next steps read back to {first}</Check>
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- Right panel

/** Claim so far: the insured, coverage, checks, the route, the service levels and what submitting starts. */
function ClaimSoFar({ ctx, draft, updatedAt }: { ctx: LifeIntakeContext; draft: LifeDraft; updatedAt: string }) {
  const checks = lifeChecks(ctx, draft)
  const route = routeLife(ctx, draft)
  const reqs = requirementSet(ctx, draft)
  const slas = slaPreview(draft)
  const { total } = payable(ctx, draft)
  const age = isDate(draft.dateOfDeath) ? ageOnDate(ctx.insured.dob, draft.dateOfDeath) : undefined
  return (
    <aside className="ik-side" aria-label="Claim so far">
      <div className="ik-side-head">
        <h2>Claim so far</h2>
        <Tag tone="neutral">Draft</Tag>
        <span className="grow" />
        <span className="muted">Updated {updatedAt}</span>
      </div>

      <div className="ik-who">
        <strong className="ik-who-name">{ctx.insured.name}{age !== undefined ? ` · ${age}` : ''}</strong>
        <span>{isDate(draft.dateOfDeath) ? `Died ${fmtDate(draft.dateOfDeath, { year: true })}` : 'Date of death not given'}{draft.placeOfDeath ? ` · ${draft.placeOfDeath}` : ''}</span>
        <span className="muted">Reported by {draft.callerName || 'the caller'}{draft.relationship ? `, ${draft.relationship.toLowerCase()}` : ''} · {fmtMoney(total)} could be payable</span>
      </div>

      <section className="ik-block" aria-labelledby="li-checks-h">
        <div className="ik-block-head"><h3 id="li-checks-h">Checks</h3><span className="muted">Policy admin and claims index</span></div>
        <ul className="ik-checks">
          {checks.map((c) => (
            <li key={c.id} className={`ik-checks-${c.tone}`}>
              <ToneShape tone={c.tone} />
              <span>{c.label}{c.note && <span className="muted"> · {c.note}</span>}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="ik-block" aria-labelledby="li-route-h">
        <div className="ik-block-head"><h3 id="li-route-h">Route</h3><span className="muted">Rule {route.rule} · not a suggestion</span></div>
        <div className="ik-route">
          <strong>{route.track} <Icon name="arrowRight" size={12} /> {route.examiner}</strong>
          <ul>{route.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </section>

      <section className="ik-block" aria-labelledby="li-req-h">
        <div className="ik-block-head"><h3 id="li-req-h">Evidence to request</h3><span className="muted">{reqs.length} requirements</span></div>
        <ul className="ik-checks">
          {reqs.map((r) => (
            <li key={r.name} className={r.onFile ? 'ik-checks-positive' : 'ik-checks-neutral'}>
              <ToneShape tone={r.onFile ? 'positive' : 'neutral'} />
              <span>{r.name}<span className="muted"> · {r.onFile ? 'already on file' : `from ${r.from}`}</span></span>
            </li>
          ))}
        </ul>
      </section>

      <section className="ik-block" aria-labelledby="li-sla-h">
        <div className="ik-block-head"><h3 id="li-sla-h">Service levels</h3><span className="muted">Clocks start on submit</span></div>
        <table className="ik-sla">
          <tbody>
            {slas.map((s) => (
              <tr key={s.name}>
                <th scope="row">{s.name}<span>{s.rule} · {s.source.toLowerCase()}</span></th>
                <td>{s.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ik-block" aria-labelledby="li-next-h">
        <div className="ik-block-head"><h3 id="li-next-h">What happens when you submit</h3></div>
        <ol className="ik-next">
          <li><span className="ik-num-badge">1</span><span>The notice and an outbox event are saved in <strong>one transaction</strong> — nothing is lost if a system is down.</span></li>
          <li><span className="ik-num-badge">2</span><span>The outbox relay starts the intake run <span className="mono">orch-{LIVE ? '<claim number>' : ctx.claimId}-intake</span> in Temporal: policy, contestability, sanctions, duplicates, death records, route.</span></li>
          <li><span className="ik-num-badge">3</span><span>{LIVE ? 'The claim' : `Claim ${ctx.claimId}`} is set up with {reqs.length} requirements; {reqs.filter((r) => r.onFile).length} is met from our records.</span></li>
          <li><span className="ik-num-badge">4</span><span>Acknowledgement and claim packets go out{draft.agentConsent === 'yes' ? `; ${ctx.agent.name} is told the status` : ''}.</span></li>
          <li><span className="ik-num-badge">5</span><span>Deadline rows are written for first contact, the status letter and each follow-up. The dispatcher fires them if nothing closes them first.</span></li>
        </ol>
      </section>
    </aside>
  )
}
