import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import {
  decideWording, getClinical, logMedicalView, logProviderContact, saveOpinionDraft, signOpinion,
  type ClinicalFile, type ClinicalOpinion, type ClinicalReferral, type OccupationalDemand,
} from '../../api/clinical'
import { logEvent } from '../../api/history'
import { addTask, tasks } from '../../api/tasks'
import { fmtCountdown, fmtDate, fmtTime } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Sources } from '../../components/Sources'
import { StatusTag, Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Medical.css'

const FIT: Record<OccupationalDemand['fit'], { label: string; tone: 'positive' | 'neutral' | 'caution' }> = {
  within: { label: 'Within restrictions', tone: 'positive' },
  partly: { label: 'Partly within', tone: 'neutral' },
  beyond: { label: 'Beyond restrictions', tone: 'caution' },
  unknown: { label: 'Not known yet', tone: 'neutral' },
}

/** Medical detail for a DI claim: restrictions by version, occupational demands, clinical review, providers and codes. */
export function MedicalSection({ claim }: SectionProps) {
  const { user } = useSession()
  const { data: file, loading } = useQuery(() => getClinical(claim.id), [claim.id])

  useEffect(() => {
    if (file) logMedicalView(claim.id, user)
  }, [file, claim.id, user])

  if (loading && !file) return <Loading rows={8} />
  if (!file)
    return (
      <>
        <div className="page-head"><h2>Medical</h2></div>
        <AccessNote />
        <div className="empty">No clinical file for this claim in the mock.</div>
      </>
    )

  return (
    <div className="md">
      <div className="page-head">
        <h2>Medical</h2>
        <span className="aside">{file.condition} · treating: {file.treating}</span>
        <span className="grow" />
        {file.versions.some((v) => v.docId) && (
          <Link className="btn btn--sm" to={`/claims/${claim.id}/documents/${file.versions.find((v) => v.docId)!.docId}`}>
            <Icon name="document" size={13} />Open APS · 22 Sep
          </Link>
        )}
      </div>
      <AccessNote />
      {file.known ? <GatheringView file={file} /> : <ReviewView file={file} />}
    </div>
  )
}

function AccessNote() {
  return (
    <p className="md-access" role="note">
      <Icon name="lock" size={13} />
      <span>
        <strong>Minimum necessary.</strong> Visible to the claim team and assigned clinical staff only — agents of record never see this section.
        Opening it is logged in History.
      </span>
    </p>
  )
}

// ------------------------------------------------------------------ Bell: clinical review

function ReviewView({ file }: { file: ClinicalFile }) {
  return (
    <>
      {file.referral && <ReferralBar r={file.referral} />}
      <div className="md-cols">
        <div className="md-col">
          <Restrictions file={file} />
          <Demands demands={file.demands} />
        </div>
        {file.referral && <OpinionPanel claimId={file.claimId} r={file.referral} />}
      </div>
      <div className="md-pair">
        <Diagnoses file={file} />
        <Providers file={file} />
      </div>
      <Timeline file={file} />
      {file.guideline && (
        <section className="section" aria-labelledby="md-gl-h">
          <h3 id="md-gl-h" className="md-h4">Guideline context</h3>
          <p className="soft md-text">{file.guideline}</p>
        </section>
      )}
    </>
  )
}

function ReferralBar({ r }: { r: ClinicalReferral }) {
  return (
    <div className="md-referral">
      <Icon name="message" size={15} color="var(--ink-2)" />
      <div className="md-referral-meta">
        <span className="strong">Referral from {r.from}</span>
        <span className="sub">to {r.nurse} · {fmtDate(r.opened)} · due {fmtDate(r.due)}</span>
        {r.state === 'returned' ? <Tag tone="positive">Returned</Tag> : <Tag tone="info">Open · {fmtCountdown(r.due)}</Tag>}
      </div>
      <blockquote>“{r.question}”</blockquote>
    </div>
  )
}

function changeWord(a = '', b = ''): { label: string; tone: 'info' | 'plain' } {
  if (a === b) return { label: 'No change', tone: 'plain' }
  const na = parseFloat(a)
  const nb = parseFloat(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return { label: nb > na ? 'Improved' : 'Reduced', tone: 'info' }
  return { label: 'Changed', tone: 'info' }
}

/** Restrictions and limitations by version: an earlier version to compare, the current one and the one a new APS proposes. */
function Restrictions({ file }: { file: ClinicalFile }) {
  const current = file.versions.find((v) => v.state === 'current')!
  const proposed = file.versions.find((v) => v.state === 'proposed')
  const earlier = file.versions.filter((v) => v.state === 'superseded')
  const [cmpV, setCmpV] = useState(earlier.find((v) => v.v === 3)?.v ?? earlier[earlier.length - 1]?.v)
  const cmp = file.versions.find((v) => v.v === cmpV)
  return (
    <section className="section" aria-labelledby="md-r-h">
      <div className="section-head">
        <h3 id="md-r-h">Restrictions and limitations</h3>
        <span className="aside">v{current.v} current since {fmtDate(current.date)} · {file.versions.length} versions from APS forms</span>
      </div>
      <div className="md-vers" role="group" aria-label="Compare with an earlier version">
        <span className="sub">Compare with</span>
        {earlier.map((v) => (
          <button key={v.v} type="button" className="md-ver" aria-pressed={v.v === cmpV} onClick={() => setCmpV(v.v)} title={v.source}>
            v{v.v} · {fmtDate(v.date, { year: true }).replace(/^\d+ /, '')}
          </button>
        ))}
      </div>
      <div className="md-scroll">
        <table className="tbl md-rtable">
          <thead>
            <tr>
              <th>Function</th>
              {cmp && <th>v{cmp.v} · {fmtDate(cmp.date, { year: true }).replace(/^\d+ /, '')}</th>}
              <th>v{current.v} · {fmtDate(current.date, { year: true }).replace(/^\d+ /, '')} <span className="md-cur">current</span></th>
              {proposed && <th className="md-prop-h">v{proposed.v} · {fmtDate(proposed.date)} <span className="md-new">proposed</span></th>}
              {proposed && <th>Change</th>}
            </tr>
          </thead>
          <tbody>
            {file.functions.map((f) => {
              const ch = proposed ? changeWord(current.values[f], proposed.values[f]) : undefined
              return (
                <tr key={f}>
                  <td>{f}</td>
                  {cmp && <td className="soft">{cmp.values[f]}</td>}
                  <td>{current.values[f]}</td>
                  {proposed && <td className="md-prop"><span className="proposed-inline">{proposed.values[f]}</span></td>}
                  {ch && <td>{ch.tone === 'plain' ? <span className="muted">{ch.label}</span> : <Tag tone="info">{ch.label}</Tag>}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {proposed && (
        <div className="md-pending">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" /></svg>
          <span className="grow">
            v{proposed.v} is extracted from the {proposed.source} and pending review in Documents. It becomes current only when someone accepts it there.
          </span>
          <Link to={`/claims/${file.claimId}/documents/${proposed.docId}`} className="strong nowrap">Review in Documents</Link>
        </div>
      )}
    </section>
  )
}

function Demands({ demands }: { demands: OccupationalDemand[] }) {
  const own = demands.filter((d) => !d.anyOcc)
  const any = demands.filter((d) => d.anyOcc)
  const unknown = demands.every((d) => d.fit === 'unknown')
  const rows = (list: OccupationalDemand[]) =>
    list.map((d) => (
      <tr key={d.demand}>
        <td>{d.demand}</td>
        {!unknown && <td className="soft">{d.current}</td>}
        {unknown ? <td className="md-slot-cell"><span className="md-slot">Awaiting restrictions from the physician statement</span></td> : <td>{d.proposed}</td>}
        <td><Tag tone={FIT[d.fit].tone}>{FIT[d.fit].label}</Tag></td>
      </tr>
    ))
  return (
    <section className="section" aria-labelledby="md-d-h">
      <div className="section-head">
        <h3 id="md-d-h">Restrictions compared with occupational demands</h3>
        <span className="aside">From the duties questionnaire</span>
      </div>
      <div className="md-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th>Demand</th>
              {!unknown && <th>Current</th>}
              <th>{unknown ? 'Restriction' : 'Proposed'}</th>
              <th>Compared</th>
            </tr>
          </thead>
          <tbody>
            <tr className="md-group"><td colSpan={4}>Own occupation</td></tr>
            {rows(own)}
            {any.length > 0 && <tr className="md-group"><td colSpan={4}>For reference · any-occupation definition from 1 Jun 2027</td></tr>}
            {rows(any)}
          </tbody>
        </table>
      </div>
      <p className="sub">The comparison informs the clinical opinion; it is not a decision on the claim.</p>
    </section>
  )
}

type RadioOpt<T extends string> = [T, string][]

function Radios<T extends string>({ name, legend, value, options, onChange, disabled }: {
  name: string; legend: string; value: T; options: RadioOpt<T>; onChange: (v: T) => void; disabled?: boolean
}) {
  return (
    <fieldset className="md-field">
      <legend>{legend}</legend>
      <div className="md-opts">
        {options.map(([k, label]) => (
          <label key={k} className="md-opt">
            <input type="radio" name={name} checked={value === k} onChange={() => onChange(k)} disabled={disabled} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

const CONSISTENT = ['Imaging and surgery', 'Treatment intensity', 'Reported activities']

/** The clinician's answer to the referral question. A draft until signed; signing returns it to the case manager. */
function OpinionPanel({ claimId, r }: { claimId: string; r: ClinicalReferral }) {
  const { user } = useSession()
  const toast = useToast()
  const [op, setOp] = useState<ClinicalOpinion>(r.opinion)
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const signed = r.state === 'returned'
  const set = <K extends keyof ClinicalOpinion>(k: K, v: ClinicalOpinion[K]) => setOp((o) => ({ ...o, [k]: v }))

  // Pick up the recommendation when wording is accepted.
  useEffect(() => setOp((o) => ({ ...o, recommendation: r.opinion.recommendation })), [r.opinion.recommendation])

  async function wording(choice: 'accepted' | 'dismissed', edit = false) {
    await decideWording(claimId, choice, user.name)
    if (edit) setTimeout(() => document.getElementById('md-rec')?.focus(), 150)
  }

  async function sign() {
    setBusy(true)
    await signOpinion(claimId, op)
    toast(`Opinion signed and returned to ${r.from}`)
    setBusy(false)
  }

  return (
    <section className={cx('md-opinion', signed && 'md-opinion--signed')} aria-labelledby="md-op-h">
      <div className="md-op-head">
        <h3 id="md-op-h">Clinical opinion</h3>
        {signed ? <Tag tone="positive">Signed</Tag> : <Tag tone="neutral">Draft — not recorded</Tag>}
        <span className="grow" />
        <span className="sub">
          {signed && r.opinion.signedAt ? `${r.nurse} · ${fmtDate(r.opinion.signedAt!)} ${fmtTime(r.opinion.signedAt!)}` : r.opinion.savedAt ? `Saved ${fmtTime(r.opinion.savedAt)}` : ''}
        </span>
      </div>

      <div className="md-op-body">
        <Radios name="sup" legend="Restrictions supported by the evidence?" value={op.supported} disabled={signed}
          options={[['supported', 'Supported'], ['partially', 'Partially'], ['notSupported', 'Not supported']]} onChange={(v) => set('supported', v)} />
        <fieldset className="md-field">
          <legend>Consistent with</legend>
          <div className="md-opts">
            {CONSISTENT.map((c) => (
              <label key={c} className="md-opt">
                <input type="checkbox" checked={op.consistent.includes(c)} disabled={signed}
                  onChange={(e) => set('consistent', e.target.checked ? [...op.consistent, c] : op.consistent.filter((x) => x !== c))} />
                {c}
              </label>
            ))}
          </div>
        </fieldset>
        <Radios name="own" legend="Own occupation — driving, loading, operations" value={op.ownOcc} disabled={signed}
          options={[['prevented', 'Prevented'], ['partly', 'Partly'], ['notPrevented', 'Not prevented']]} onChange={(v) => set('ownOcc', v)} />
        <Radios name="sed" legend="Full-time sedentary work (any occupation)" value={op.sedentary} disabled={signed}
          options={[['notSupported', 'Not supported'], ['supported', 'Supported'], ['unclear', 'Unclear — needs a functional capacity evaluation']]} onChange={(v) => set('sedentary', v)} />

        {r.suggestion?.state === 'open' && !signed && (
          <div className="proposed">
            <div className="proposed-kicker">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" /></svg>
              Suggested wording
              <span className="grow" />
              <Sources items={r.suggestion.sources} />
            </div>
            <div className="proposed-body">“{r.suggestion.text}”</div>
            <div className="proposed-actions">
              <span className="grow" />
              <button type="button" className="btn btn--ghost btn--xs" onClick={() => wording('accepted')}>Accept</button>
              <button type="button" className="btn btn--ghost btn--xs" onClick={() => wording('accepted', true)}>Edit</button>
              <button type="button" className="btn btn--quiet btn--xs" onClick={() => wording('dismissed')}>Dismiss</button>
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="md-rec">Recommendation</label>
          <textarea id="md-rec" className="textarea" rows={5} value={op.recommendation} readOnly={signed} onChange={(e) => set('recommendation', e.target.value)} />
        </div>

        <div className="md-two">
          <div>
            <Radios name="peer" legend="Peer review needed?" value={op.peerReview} disabled={signed}
              options={[['yes', 'Yes'], ['no', 'No']]} onChange={(v) => set('peerReview', v)} />
            <span className="sub">Reconsider in Jan 2027 if tolerances change</span>
          </div>
          <div className="field">
            <label htmlFor="md-next">Next clinical review</label>
            <input id="md-next" type="date" className="input" value={op.nextReview} readOnly={signed} onChange={(e) => set('nextReview', e.target.value)} />
          </div>
        </div>

        <div className="md-contacts">
          <div className="md-field-legend">Contact with treating provider</div>
          {r.contacts.map((c) => (
            <div key={c.at + c.text} className="md-contact">
              <Icon name="phone" size={13} />
              <span><span className="strong">{fmtDate(c.at)} {fmtTime(c.at)}</span> · {c.text}</span>
            </div>
          ))}
          {!signed && (
            <form
              className="md-contact-add"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!contact.trim()) return
                await logProviderContact(claimId, contact.trim(), `${user.name} · ${user.title}`)
                setContact('')
                toast('Contact logged')
              }}
            >
              <input className="input grow" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="e.g. Fax to Dr. Castillo’s office asking for PT notes" aria-label="Log a contact with the treating provider" />
              <button type="submit" className="btn btn--sm" disabled={!contact.trim()}>Log contact</button>
            </form>
          )}
        </div>
      </div>

      {!signed ? (
        <div className="md-op-foot">
          <span className="sub grow">Signing records the opinion in the claim file and returns the referral to {r.from}.</span>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={async () => { await saveOpinionDraft(claimId, op); toast('Draft saved') }}>Save draft</button>
          <button type="button" className="btn btn--primary btn--sm" disabled={busy || !op.recommendation.trim()} onClick={sign}>
            Sign &amp; return to {r.from}<Icon name="arrowRight" size={13} />
          </button>
        </div>
      ) : (
        <div className="md-op-foot">
          <Icon name="lock" size={14} />
          <span className="sub">Recorded in the claim file and returned to {r.from}. A change needs a new signed opinion.</span>
        </div>
      )}
    </section>
  )
}

function Diagnoses({ file }: { file: ClinicalFile }) {
  return (
    <section className="section" aria-labelledby="md-dx-h">
      <div className="section-head">
        <h3 id="md-dx-h">Diagnosis codes</h3>
        <span className="aside">ICD-10-CM</span>
      </div>
      {file.diagnoses.length === 0 ? (
        <div className="md-slot md-slot--block">Not coded yet — coded from the physician statement or records, never from pharmacy fills.</div>
      ) : (
        <ul className="md-dx">
          {file.diagnoses.map((d) => (
            <li key={d.code}>
              <span className="mono strong">{d.code}</span>
              <span className="grow">{d.label}</span>
              {d.primary && <Tag>Primary</Tag>}
              {d.since && <span className="sub nowrap">since {d.since}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Providers({ file }: { file: ClinicalFile }) {
  return (
    <section className="section" aria-labelledby="md-pr-h">
      <div className="section-head">
        <h3 id="md-pr-h">Treating providers</h3>
        {file.nextVisit && <span className="aside">Next visit {fmtDate(file.nextVisit)}</span>}
      </div>
      <ul className="md-providers">
        {file.providers.map((p) => (
          <li key={p.name}>
            <div className="md-pv-top">
              <span className="strong grow">{p.name}</span>
              {p.status && <StatusTag status={p.status} />}
            </div>
            <div className="sub">{p.specialty} · {p.role}{p.since ? ` · since ${p.since}` : ''}</div>
            {(p.last || p.next) && (
              <div className="sub">{[p.last, p.next && `next ${fmtDate(p.next)}`].filter(Boolean).join(' · ')}</div>
            )}
            {p.contact && <div className="sub mono">{p.contact}</div>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Timeline({ file }: { file: ClinicalFile }) {
  return (
    <section className="section" aria-labelledby="md-tl-h">
      <div className="section-head">
        <h3 id="md-tl-h">Clinical timeline</h3>
        <span className="aside">From records, APS forms and exam notes</span>
      </div>
      <ol className="md-tl">
        {file.timeline.map((t) => (
          <li key={t.date + t.label} className={cx(t.current && 'is-current')}>
            <span className="md-tl-dot" aria-hidden="true" />
            <span className="strong">{t.date}</span>
            <span className="sub">{t.label}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ------------------------------------------------------------------ Vasquez: gathering evidence

/** What is known and what is missing, for a claim whose physician statement hasn't arrived. */
function GatheringView({ file }: { file: ClinicalFile }) {
  const { user } = useSession()
  const toast = useToast()
  const planTitle = 'Nurse review once the statement or vendor records arrive'
  const { data: planned } = useQuery(async () => tasks.where((t) => t.claimId === file.claimId && t.title === planTitle).length > 0, [file.claimId])

  function plan() {
    addTask(file.claimId, planTitle, 'Clinical team', 'Medical', '2026-10-02')
    logEvent(file.claimId, { type: 'task', title: `Clinical review planned — ${planTitle.toLowerCase()}`, actor: `${user.name} · ${user.title}`, ref: 'Medical' })
    toast('Task created for the clinical team')
  }

  return (
    <>
      <div className="md-status" role="status">
        <Tag tone="caution">Gathering evidence</Tag>
        <span>Waiting on Dr. Hsu’s statement · records vendor ETA 1 Oct · pharmacy history received 27 Aug</span>
        <span className="grow" />
        <button type="button" className="btn btn--sm" onClick={plan} disabled={planned}>
          {planned ? 'Clinical review planned' : 'Plan clinical review'}
        </button>
      </div>
      <div className="md-pair">
        <section className="section" aria-labelledby="md-kn-h">
          <div className="section-head">
            <h3 id="md-kn-h">What we know</h3>
            <span className="aside">{file.known!.length} items</span>
          </div>
          <ul className="md-known">
            {file.known!.map((k) => (
              <li key={k.label}>
                <div className="md-field-legend">{k.label}</div>
                <div>{k.value}</div>
                <div className="md-known-src"><Sources items={[k.source]} /><span className="sub">{fmtDate(k.date)}</span></div>
              </li>
            ))}
          </ul>
        </section>
        <section className="section" aria-labelledby="md-mi-h">
          <div className="section-head">
            <h3 id="md-mi-h">What’s missing</h3>
            <span className="aside">{file.missing!.length} items</span>
          </div>
          <ul className="md-missing">
            {file.missing!.map((m) => (
              <li key={m.label}>
                <div className="md-pv-top">
                  <span className="strong grow">{m.label}</span>
                  <StatusTag status={m.status} />
                </div>
                <div className="sub">{m.from} · {m.detail}</div>
                {m.action && (
                  <Link to={`/claims/${file.claimId}/${m.action.section}${m.action.target ? `/${m.action.target}` : ''}`} className="strong md-link">{m.action.label}</Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <Demands demands={file.demands} />
      <div className="md-pair">
        <Diagnoses file={file} />
        <Providers file={file} />
      </div>
      <Timeline file={file} />
    </>
  )
}
