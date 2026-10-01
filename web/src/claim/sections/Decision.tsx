import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReadinessCheck, Workbench } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import { listDecisions, listWorkbenches, recordDecision, type Outcome } from '../../api/decisions'
import { getQueue } from '../../api/work'
import { fmtDate, fmtTime } from '../../lib/dates'
import { fmtMoney, sum } from '../../lib/money'
import { DecisionRecordView } from '../../components/DecisionRecordView'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Sources } from '../../components/Sources'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'

export function DecisionSection({ claim }: SectionProps) {
  const { data: benches, loading } = useQuery(() => listWorkbenches(claim.id), [claim.id])
  const { data: records } = useQuery(() => listDecisions(claim.id), [claim.id])
  const undecided = claim.benefitLines.filter(
    (b) => !benches?.some((w) => w.benefitLineId === b.id) && !records?.some((r) => r.benefitLineId === b.id),
  )

  return (
    <>
      <div className="page-head">
        <h2>Decision</h2>
        <span className="aside">One decision per benefit line · context first, then the outcome</span>
      </div>

      {loading && !benches && <Loading rows={6} />}
      {benches?.map((wb) => <WorkbenchView key={wb.benefitLineId} wb={wb} />)}

      {undecided.length > 0 && benches && (
        <div className="empty" style={{ textAlign: 'left' }}>
          {undecided.map((b) => b.name).join(', ')} {undecided.length > 1 ? 'have' : 'has'} no workbench in the mock yet
          {claim.light ? ' — this is a light record.' : ' — it waits on evidence or another line’s outcome.'}
        </div>
      )}

      {records && records.length > 0 && (
        <section className="section" aria-labelledby="rec-h">
          <div className="section-head">
            <h3 id="rec-h">Recorded decisions</h3>
            <span className="aside">Locked. A correction creates a new version with a reason.</span>
          </div>
          {records.map((d) => <DecisionRecordView key={d.id} d={d} />)}
        </section>
      )}
    </>
  )
}

export function CheckMark({ result }: { result: ReadinessCheck['result'] }) {
  if (result === 'pass')
    return <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Pass"><circle cx="8" cy="8" r="7" fill="#E4F0E8" /><path d="M4.8 8.2 7 10.3l4.2-4.6" fill="none" stroke="#1D6340" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
  if (result === 'blocked')
    return <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Blocked"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill="#5A3B8C" /></svg>
  return <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Not met"><rect x="2" y="2" width="12" height="12" rx="2" fill="#A0281D" /><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#FFF" strokeWidth="1.6" strokeLinecap="round" /></svg>
}

function WorkbenchView({ wb }: { wb: Workbench }) {
  const { user } = useSession()
  const toast = useToast()
  const navigate = useNavigate()
  const [outcome, setOutcome] = useState<Outcome>('approve')
  const [rationale, setRationale] = useState(wb.rationale)
  const [edited, setEdited] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const passed = wb.checks.filter((c) => c.result === 'pass').length
  const blocked = wb.checks.some((c) => c.result === 'blocked')
  const total = sum(wb.payees.map((p) => p.amount))
  const overAuthority = total > user.payoutLimit
  const payDay = fmtDate(wb.payDate)

  const submitLabel =
    outcome === 'pend' ? 'Pend for information'
      : outcome === 'deny' || outcome === 'approveInPart' ? 'Send for second review'
        : overAuthority ? 'Send for approval'
          : 'Record decision & schedule payment'

  async function submit() {
    setBusy(true)
    try {
      const r = await recordDecision({ claimId: wb.claimId, benefitLineId: wb.benefitLineId, outcome, rationale, by: user })
      const queue = await getQueue(user.id)
      const next = queue[0]
      toast(r.message, next ? { label: 'Start next', onClick: () => navigate(`/claims/${next.claimId}/${next.section}`) } : undefined)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="wb">
      <section className="wb-checks" aria-labelledby={`chk-${wb.benefitLineId}`}>
        <div className="wb-checks-head">
          <h3 id={`chk-${wb.benefitLineId}`} style={{ fontSize: 14 }}>
            Readiness — {passed} of {wb.checks.length} checks pass
          </h3>
          <span className="grow" />
          <span className="sub">Run {fmtDate(wb.checksRunAt)} {fmtTime(wb.checksRunAt)}</span>
          <button type="button" className="btn btn--ghost btn--xs" onClick={() => toast('Checks re-run · no change')}>Re-run</button>
        </div>
        <div className="wb-checks-list">
        {wb.checks.map((c) => (
          <div key={c.id} className={`wb-check wb-check--${c.result}`}>
            <CheckMark result={c.result} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="wb-check-title">{c.label}</span>
              <span className="soft">{c.detail}</span>
              {c.sources.length > 0 && <Sources items={c.sources} />}
            </div>
          </div>
        ))}
        </div>
        <div className="wb-check" style={{ background: 'var(--sunken)', gridTemplateColumns: '1fr', borderTop: '1px solid var(--line)' }}>
          <span className="sub">Policy provisions applied · {wb.provisions.join(' · ')}</span>
        </div>
      </section>

      <section className="wb-form" aria-labelledby={`dec-${wb.benefitLineId}`}>
        <div className="wb-form-head">
          <Icon name="decision" />
          <h3 id={`dec-${wb.benefitLineId}`}>Decision · {wb.title}</h3>
          <span className="mono sub">{wb.ref}</span>
          <span className="grow" />
          <span className="sub">Draft — not recorded</span>
        </div>

        <div className="wb-form-body">
          {blocked ? (
            <div className="wb-blocked" role="note">
              <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }}><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="currentColor" /></svg>
              <div><strong>Can’t be decided yet.</strong> {wb.blockedReason}</div>
            </div>
          ) : (
            <>
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="wb-label">Outcome</legend>
                <div className="radio-cards">
                  {([['approve', 'Approve'], ['approveInPart', 'Approve in part'], ['deny', 'Deny'], ['pend', 'Pend for information']] as const).map(([k, label]) => (
                    <label key={k} className="radio-card">
                      <input type="radio" name={`outcome-${wb.benefitLineId}`} checked={outcome === k} onChange={() => { setOutcome(k); setConfirming(false) }} />
                      {label}
                    </label>
                  ))}
                </div>
                <div className="sub" style={{ marginTop: 6 }}>Effective · {wb.effective}</div>
              </fieldset>

              {outcome === 'approve' && wb.payees.length > 0 && (
                <div>
                  <span className="wb-label">Payments · paid {payDay} once recorded</span>
                  <table className="tbl">
                    <thead><tr><th>Payee</th><th>Basis</th><th className="r">Amount</th><th>Method</th></tr></thead>
                    <tbody>
                      {wb.payees.map((p, i) => (
                        <tr key={i}><td className="strong" style={{ fontWeight: 600 }}>{p.payee}</td><td>{p.basis}</td><td className="r">{fmtMoney(p.amount)}</td><td className="mono nowrap" style={{ fontSize: 12 }}>{p.method}</td></tr>
                      ))}
                    </tbody>
                    <tfoot><tr><td colSpan={2}>Total</td><td className="r">{fmtMoney(total)}</td><td /></tr></tfoot>
                  </table>
                  {wb.payeeNote && <div className="sub" style={{ marginTop: 6 }}>{wb.payeeNote}</div>}
                </div>
              )}

              {(outcome === 'deny' || outcome === 'approveInPart') && (
                <div className="callout-info">
                  <Icon name="help" size={16} color="var(--accent)" />
                  <span>Adverse decisions need a second review. The letter must name the provision and evidence each reason relies on — it opens after the reviewer agrees.</span>
                </div>
              )}

              <div className="field">
                <label htmlFor={`rat-${wb.benefitLineId}`} className="wb-label" style={{ marginBottom: 0 }}>
                  Rationale {!edited && wb.rationale && <span className="sub" style={{ fontWeight: 400 }}>· drafted from the checks — edit as needed</span>}
                </label>
                <textarea
                  id={`rat-${wb.benefitLineId}`}
                  className="textarea"
                  rows={4}
                  value={rationale}
                  onChange={(e) => { setRationale(e.target.value); setEdited(true) }}
                  style={!edited && wb.rationale ? { borderStyle: 'dashed', borderColor: 'var(--proposed-line)', background: 'var(--proposed-bg)' } : undefined}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <span className="sub">Evidence cited</span>
                  <Sources items={wb.evidence} max={5} />
                </div>
              </div>

              {outcome === 'approve' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <span className="wb-label">Letters</span>
                    <ul style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {wb.letters.map((l) => (
                        <li key={l.template}>{l.title} <span className="mono sub">{l.template}</span> <span className="sub">· {l.to}</span></li>
                      ))}
                    </ul>
                  </div>
                  {wb.tax && (
                    <div>
                      <span className="wb-label">Tax</span>
                      <span>{wb.tax}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {!blocked && (
          <div className="wb-form-foot">
            {confirming ? (
              <div className="wb-confirm grow" role="alert">
                <Icon name="lock" size={16} color="var(--accent)" />
                <span className="grow">
                  {outcome === 'approve' && !overAuthority
                    ? <>Record and lock this decision? It can’t be edited — a correction creates v2. {fmtMoney(total)} pays on {payDay}.</>
                    : <>Send this to Monica Reyes? Nothing reaches the claimant until she agrees.</>}
                </span>
                <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
                <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={busy}>{busy ? 'Recording…' : 'Confirm'}</button>
              </div>
            ) : (
              <>
                <span className="sub grow">
                  {outcome === 'approve' && !overAuthority && `Recording creates decision record v1 (locked) and schedules payment for ${payDay}.`}
                  {outcome === 'approve' && overAuthority && `${fmtMoney(total)} is above your ${fmtMoney(user.payoutLimit)} authority — it goes to Monica Reyes.`}
                  {outcome === 'pend' && 'The claim stays open; add the requirement you need next.'}
                </span>
                <button type="button" className="btn" onClick={() => toast('Draft saved')}>Save draft</button>
                <button type="button" className="btn btn--primary" onClick={() => setConfirming(true)} disabled={!rationale.trim()}>{submitLabel}</button>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
