import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { ApiError } from '../../api/live/http'
import * as live from '../../api/live/data'
import { awaitingDecision, awaitingTotal, draftBasis, lineToDecide, mapDecisions, payeeShares, readinessChecks } from '../../api/live/decisions'
import { money, standing, type Bundle } from '../../api/live/present'
import { limitOf, staffById } from '../../api/live/staff'
import type { ApiBenefitLine } from '../../api/live/types'
import { fmtDate } from '../../lib/dates'
import { fmtMoney, sum } from '../../lib/money'
import { day, stamp } from '../../api/live/time'
import { DecisionRecordView } from '../../components/DecisionRecordView'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Sources } from '../../components/Sources'
import { Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import { CheckMark } from './Decision'
import type { SectionProps } from './types'
import './Live.css'

const message = (e: unknown) => (e instanceof ApiError ? (e.detail ?? e.title) : (e as Error).message)

/**
 * The Decision screen for a live claim. Everything on it is read from the backend: the claim, its requirements and intake run
 * (the readiness list), the decisions (locked records) and the work items. Recording is POST /claims/{id}/decisions; above the
 * examiner's authority it is recorded as awaiting approval and a team lead approves it (POST /decisions/{id}:approve).
 */
export function DecisionLive({ claim }: SectionProps) {
  const { data: b, loading, error } = useQuery(() => live.bundleFor(claim.id), [claim.id])
  const totalLine = claim.totalLine
  if (error) return <p className="lv-error" role="alert">{error.message}</p>
  if (!b) return <>{header()}{loading && <Loading rows={6} />}</>

  const toDecide = lineToDecide(b)
  const waiting = awaitingDecision(b)
  const records = mapDecisions(b)

  return (
    <div className="lv">
      {header()}
      {toDecide && <Workbench b={b} line={toDecide} />}
      {!toDecide && !waiting && b.decisions.length === 0 && <NotReady b={b} claimId={claim.id} />}
      {waiting && <Approval b={b} />}
      {!waiting && b.decisions.length > 0 && <Decided b={b} />}
      {records.length > 0 && (
        <section className="section" aria-labelledby="rec-h">
          <div className="section-head">
            <h3 id="rec-h">Recorded decisions</h3>
            <span className="aside">Locked by the backend: it refuses to update or delete a version. A correction would be a new version (not built yet).</span>
          </div>
          <div className="lv-records">
            {records.map((d) => <DecisionRecordView key={d.id} d={d} />)}
          </div>
        </section>
      )}
    </div>
  )

  function header() {
    return (
      <div className="page-head">
        <h2>Decision</h2>
        <span className="aside">One decision per benefit line · read from the claims backend{totalLine && <> · <span data-total-line>{totalLine}</span></>}</span>
        <Tag tone="info">Live</Tag>
      </div>
    )
  }
}

// ---------------------------------------------------------------- Not ready

function NotReady({ b, claimId }: { b: Bundle; claimId: string }) {
  const open = b.requirements.filter((r) => r.state === 'requested' || r.state === 'received' || r.state === 'not_enough')
  return (
    <div className="wb-blocked lv-blocked" role="note">
      <svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }}><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="currentColor" /></svg>
      <div>
        <strong>Can’t be decided yet.</strong>{' '}
        {b.claim.status === 'received'
          ? 'The intake workflow has not finished setting the claim up.'
          : open.length
            ? `Proof of loss is not complete: ${open.map((r) => `${r.name}${r.from.label ? ` (${r.from.label})` : ''}`).join(', ')} still to come.`
            : 'The claim is not in review.'}
        {open.length > 0 && <> <Link to={`/claims/${claimId}/requirements`}>Open Requirements</Link>.</>}
        <div className="sub">The backend only takes a decision on a claim that is In review (proof of loss complete); otherwise it answers 409 claim_not_ready_to_decide.</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- The workbench

function principalOf(b: Bundle, line: ApiBenefitLine): number {
  const rider = b.claim.benefitLines.find((l) => l.kind === 'rider' && l.parentLineId === line.id)
  const pays = b.claim.details?.mannerOfDeath === 'accident' && rider
  return money(line.amount) + (pays && rider ? money(rider.amount) : 0)
}

function Workbench({ b, line }: { b: Bundle; line: ApiBenefitLine }) {
  const { user } = useSession()
  const toast = useToast()
  const navigate = useNavigate()
  const checks = readinessChecks(b)
  const passed = checks.filter((c) => c.result === 'pass').length
  const shares = payeeShares(b)
  const principal = principalOf(b, line)
  const limit = user.payoutLimit
  const over = principal > limit
  const drafted = draftBasis(b)
  const [basis, setBasis] = useState(drafted)
  const [edited, setEdited] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const dod = b.claim.details?.dateOfDeath
  const evidence = b.requirements.filter((r) => r.state === 'accepted' || r.state === 'waived').map((r) => r.name)
  const blocked = checks.some((c) => c.result === 'fail')
  const rider = b.claim.benefitLines.find((l) => l.kind === 'rider')

  async function submit() {
    setBusy(true)
    setErr(undefined)
    try {
      const r = await live.recordDecision(b.claim.claimNumber, { benefitLineId: line.id, basis })
      toast(r.message, r.kind === 'recorded' ? { label: 'Open Payments', onClick: () => navigate(`/claims/${b.claim.claimNumber}/payments`) } : undefined)
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="wb">
      <section className="wb-checks" aria-labelledby="chk-h">
        <div className="wb-checks-head">
          <h3 id="chk-h" style={{ fontSize: 14 }}>Readiness — {passed} of {checks.length} checks pass</h3>
          <span className="grow" />
          <span className="sub">from the claim record</span>
        </div>
        <div className="wb-checks-list">
          {checks.map((c) => (
            <div key={c.id} className={`wb-check wb-check--${c.result}`} data-check={c.id}>
              <CheckMark result={c.result} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span className="wb-check-title">{c.label}</span>
                <span className="soft">{c.detail}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="wb-check" style={{ background: 'var(--sunken)', gridTemplateColumns: '1fr', borderTop: '1px solid var(--line)' }}>
          <span className="sub">These are worked out here from the requirements, the intake run and the claim. The backend has no readiness-check resource; it enforces the one rule that matters (the claim is In review) when you record.</span>
        </div>
      </section>

      <section className="wb-form" aria-labelledby="dec-h">
        <div className="wb-form-head">
          <Icon name="decision" />
          <h3 id="dec-h">Decision · {line.name}</h3>
          <span className="mono sub">{line.policyNumber}</span>
          <span className="grow" />
          <span className="sub">Draft — not recorded</span>
        </div>

        <div className="wb-form-body">
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="wb-label">Outcome</legend>
            <div className="radio-cards">
              <label className="radio-card"><input type="radio" name="outcome" checked readOnly />Approve</label>
              {['Approve in part', 'Deny', 'Pend for information'].map((label) => (
                <label key={label} className="radio-card lv-off" title="Not on the backend yet">
                  <input type="radio" name="outcome" disabled />{label}
                </label>
              ))}
            </div>
            <div className="sub" style={{ marginTop: 6 }}>The backend takes Approve only today (422 outcome_not_supported for the others); approve in part and deny go to a second reviewer with the complex scenario.</div>
          </fieldset>

          <div>
            <span className="wb-label">Payments · one item per payee, cleared when recorded</span>
            <table className="tbl" data-payees>
              <thead><tr><th>Payee</th><th className="r">Share</th><th className="r">Proceeds</th></tr></thead>
              <tbody>
                {shares.map((p) => (
                  <tr key={p.partyId}><td className="strong" style={{ fontWeight: 600 }}>{p.name}</td><td className="r">{p.share}%</td><td className="r">{fmtMoney(Math.round(principal * p.share) / 100)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={2}>Proceeds{rider && b.claim.details?.mannerOfDeath === 'accident' ? ` (with ${rider.name.toLowerCase()})` : ''}</td><td className="r">{fmtMoney(principal)}</td></tr></tfoot>
            </table>
            <div className="sub" style={{ marginTop: 6 }}>
              Interest at 3.5% a year{dod ? ` from ${fmtDate(dod, { year: true })}` : ''} to the pay date (the next business day) is worked out by the backend when you record, and added to each share.
              {' '}The authority check compares proceeds plus interest with your {fmtMoney(limit)} limit.
            </div>
          </div>

          <div className="field">
            <label htmlFor="dec-basis" className="wb-label" style={{ marginBottom: 0 }}>
              Basis {!edited && <span className="sub" style={{ fontWeight: 400 }}>· drafted from the claim record — edit as needed</span>}
            </label>
            <textarea
              id="dec-basis"
              className="textarea"
              rows={4}
              value={basis}
              onChange={(e) => { setBasis(e.target.value); setEdited(true) }}
              style={!edited ? { borderStyle: 'dashed', borderColor: 'var(--proposed-line)', background: 'var(--proposed-bg)' } : undefined}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span className="sub">Evidence cited</span>
              <Sources items={evidence} max={5} />
            </div>
            <div className="sub">The backend files the accepted or waived requirements as the evidence, and the policy’s standard provisions; the locked record below shows what it filed.</div>
          </div>

          {rider && (
            <div className="callout-info">
              <Icon name="help" size={16} color="var(--accent)" />
              <span>{rider.name} follows this decision: {b.claim.details?.mannerOfDeath === 'accident' ? 'it pays, because the death was an accident.' : 'it closes as not payable, with its own explanation letter, because the cause is natural.'}</span>
            </div>
          )}
        </div>

        <div className="wb-form-foot">
          {err && <div className="lv-error grow" role="alert">{err}</div>}
          {confirming ? (
            <div className="wb-confirm grow" role="alert">
              <Icon name="lock" size={16} color="var(--accent)" />
              <span className="grow">
                {over
                  ? <>Send this to the team lead? {fmtMoney(principal)} plus interest is above your {fmtMoney(limit)} authority; nothing is paid and no letter is sent until she approves.</>
                  : <>Record and lock this decision? It can’t be edited. The backend clears the payment items and sends the approval letters.</>}
              </span>
              <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} disabled={busy}>Back</button>
              <button type="button" className="btn btn--primary btn--sm" onClick={submit} disabled={busy}>{busy ? 'Recording…' : 'Confirm'}</button>
            </div>
          ) : (
            <>
              {!err && (
                <span className="sub grow">
                  {blocked ? 'A readiness check has not passed.' : over ? `${fmtMoney(principal)} plus interest is above your ${fmtMoney(limit)} authority — it goes to the team lead.` : 'Recording locks decision v1 and clears the payment items.'}
                </span>
              )}
              <button type="button" className="btn btn--primary" onClick={() => setConfirming(true)} disabled={!basis.trim() || blocked}>{over ? 'Send for approval' : 'Record decision & clear payment'}</button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- Awaiting approval

function Approval({ b }: { b: Bundle }) {
  const { user } = useSession()
  const toast = useToast()
  const navigate = useNavigate()
  const d = awaitingDecision(b)!
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const leadItem = b.workItems.find((w) => w.section === 'decision' && staffById(w.ownerId)?.role === 'team_lead')
  const lead = staffById(leadItem?.ownerId)
  const leadName = lead?.name ?? 'the team lead'
  const recorder = d.recordedByName ?? 'The examiner'
  const canApprove = user.role === 'teamLead' && staffById(d.recordedBy)?.handle !== user.id
  const total = awaitingTotal(b)
  const amount = total > 0 ? total : d.amount ? money(d.amount) : undefined
  const recorderLimit = limitOf(staffById(d.recordedBy))
  const shares = payeeShares(b)

  async function approve() {
    setBusy(true)
    setErr(undefined)
    try {
      const r = await live.approveDecision(b.claim.claimNumber, d.id, note)
      toast(r.message, { label: 'Open Payments', onClick: () => navigate(`/claims/${b.claim.claimNumber}/payments`) })
    } catch (e) {
      setErr(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="wb-form lv-approval" aria-labelledby="ap-h" data-awaiting-approval>
      <div className="wb-form-head">
        <Icon name="lock" />
        <h3 id="ap-h">Sent to {leadName} for approval · {d.benefitLineName ?? 'benefit'}</h3>
        <span className="grow" />
        <Tag tone="info">Awaiting approval</Tag>
      </div>
      <div className="wb-form-body">
        <p className="lv-lead">
          {recorder} recorded this decision{amount != null ? ` for ${fmtMoney(amount)}` : ''}. That is above {recorder.split(' ')[0]}’s {recorderLimit != null ? `${fmtMoney(recorderLimit)} ` : ''}authority, so the backend recorded it as awaiting approval:
          nothing is paid and no letter is sent until {leadName} approves it.
        </p>
        <dl className="dl lv-dl">
          <dt>Recorded</dt><dd>{recorder} · {fmtDate(day(d.recordedAt), { weekday: true })} {stamp(d.recordedAt).slice(11)}</dd>
          {amount != null && (<><dt>Proceeds + interest</dt><dd>{fmtMoney(amount)} <span className="sub">the base benefit{b.decisions.filter((x) => x.status === 'awaiting_approval').length > 1 ? ' and the rider decided with it' : ''}, interest to the pay date. The interest is worked out again to the pay date when it is approved.</span></dd></>)}
          {shares.length > 0 && (<><dt>Payees</dt><dd>{shares.map((p) => `${p.name} ${p.share}%`).join(' · ')}</dd></>)}
          <dt>Approver’s work item</dt>
          <dd>{leadItem ? <span data-approval-item>{leadItem.action} · due {fmtDate(leadItem.dueOn)} · <span className="sub">{leadItem.why}</span></span> : <span className="muted">not open (already handled)</span>}</dd>
        </dl>
        {err && <div className="lv-error" role="alert">{err}</div>}
      </div>
      <div className="wb-form-foot">
        {canApprove ? (
          <>
            <label htmlFor="ap-note" className="sr-only">Note for the history</label>
            <input id="ap-note" className="input grow" placeholder="Note for the history (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn--primary" onClick={approve} disabled={busy}>{busy ? 'Approving…' : `Approve ${amount != null ? fmtMoney(amount) : 'decision'}`}</button>
          </>
        ) : (
          <span className="sub grow" data-cannot-approve>
            {user.role === 'teamLead' ? 'You recorded this decision, so someone else has to approve it.' : `Only a team lead can approve it: sign in as ${leadName} (top right, Sign in as) to approve.`}
          </span>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Decided

function Decided({ b }: { b: Bundle }) {
  const items = standing(b.paymentItems)
  const total = sum(items.map((i) => money(i.amount)))
  const status = b.claim.status
  return (
    <div className="callout-info lv-decided" data-decided>
      <Icon name="decision" size={16} color="var(--accent)" />
      <span>
        {status === 'closed'
          ? <>Decided, paid and closed{total ? ` · ${fmtMoney(total)} paid` : ''}. </>
          : status === 'paying'
            ? <>Decided · the payment run has the payments now. </>
            : <>Decided{items.length ? ` · ${fmtMoney(total)} cleared for ${items.length} ${items.length === 1 ? 'payee' : 'payees'}, paying ${fmtDate(items.map((i) => i.payOn).sort()[0], { weekday: true })}` : ''}. </>}
        <Link to={`/claims/${b.claim.claimNumber}/payments`}>Open Payments</Link>
      </span>
    </div>
  )
}
