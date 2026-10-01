import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { followUpRecords, getContestable, referToUnderwriting, type ApplicationAnswer, type ContestableReview } from '../../api/contestable'
import { daysFrom, fmtCountdown, fmtDate, fmtTime } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { cx } from '../../lib/cx'
import { Drawer } from '../../components/Drawer'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Sources } from '../../components/Sources'
import { StatusTag, Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Contestable.css'

const ANSWER_STATE: Record<ApplicationAnswer['state'], { label: string; tone: 'positive' | 'special' | 'neutral' }> = {
  consistent: { label: 'Consistent so far', tone: 'positive' },
  question: { label: 'Question for Underwriting', tone: 'special' },
  pending: { label: 'Waiting on records', tone: 'neutral' },
}

const OUTCOMES: { title: string; body: string }[] = [
  {
    title: 'No action — the policy stands',
    body: 'If the records agree with the application, or Underwriting finds a difference would not have changed the issue decision, the review closes. The term policy is then decided as written and the rider on its own evidence.',
  },
  {
    title: 'Rescission with premium refund',
    body: 'If Underwriting finds the policy would not have been issued as it was, it may be rescinded where state law and §3 allow. The policy is treated as never in force and every premium paid is refunded, with interest where the state requires.',
  },
  {
    title: 'Issued on other terms',
    body: 'If Underwriting would have issued the policy on different terms, what follows depends on the policy form and state law. Legal advises before anything is decided.',
  },
  {
    title: 'More information first',
    body: 'Underwriting may ask for further records before giving an opinion. The review date can move; Adaeze gets a status letter saying why, as state rules require.',
  },
]

/** The contestable review for a policy that was less than two years old at death. Neutral by design: differences are questions for Underwriting. */
export function ContestableSection({ claim }: SectionProps) {
  const { data: review, loading } = useQuery(() => getContestable(claim.id), [claim.id])
  const [referring, setReferring] = useState(false)

  if (loading && !review) return <Loading rows={8} />
  if (!review)
    return (
      <>
        <div className="page-head"><h2>Contestable review</h2></div>
        <div className="empty">No policy on this claim is within its contestable period.</div>
      </>
    )

  const referred = review.referral.state !== 'notReferred'
  return (
    <div className="ct">
      <div className="page-head">
        <h2>Contestable review</h2>
        <span className="aside">{review.product} {review.policy} · {fmtMoney(review.face)} · review due {fmtDate(review.due)}</span>
        <span className="grow" />
        {!referred && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setReferring(true)}>
            Refer to Underwriting
          </button>
        )}
      </div>

      <div className="callout-info ct-frame" role="note">
        <Icon name="help" size={16} color="var(--accent)" />
        <span>
          This review checks whether the 2025 application answers match the records. A difference is a <strong>question for Underwriting</strong>, which
          decides whether it was material. Nothing on this page is a finding, and nothing here reaches Adaeze or the agent of record.
        </span>
      </div>

      <Timeline review={review} />

      <section className="section" aria-labelledby="ct-checks-h">
        <div className="section-head">
          <h3 id="ct-checks-h">What’s being checked</h3>
          <span className="aside">{review.provision}</span>
        </div>
        <ol className="ct-steps">
          {review.checks.map((c, i) => (
            <li key={c.id} className="ct-step">
              <span className="ct-step-n" aria-hidden="true">{i + 1}</span>
              <div className="ct-step-body">
                <div className="ct-step-title">{c.label}</div>
                <div className="sub">{c.detail}</div>
              </div>
              <StatusTag status={c.status} />
            </li>
          ))}
        </ol>
      </section>

      <Answers review={review} onRefer={() => setReferring(true)} />

      <div className="ct-grid">
        <Records review={review} />
        <Referral review={review} onRefer={() => setReferring(true)} />
      </div>

      <section className="section" aria-labelledby="ct-out-h">
        <div className="section-head">
          <h3 id="ct-out-h">Possible outcomes</h3>
          <span className="aside">Explained for context — none is proposed</span>
        </div>
        <div className="ct-outcomes">
          {OUTCOMES.map((o) => (
            <div key={o.title} className="ct-outcome">
              <div className="strong">{o.title}</div>
              <p className="soft">{o.body}</p>
            </div>
          ))}
        </div>
        <p className="sub">
          Any adverse outcome needs a second review and a letter that names the application answer, the evidence and the provision it relies on, and
          explains the right to ask for reconsideration and to contact the state Department of Insurance.
        </p>
      </section>

      <Rider review={review} claimId={claim.id} />

      <p className="sub ct-access">
        <Icon name="lock" size={12} /> Agent of record Paul Hendricks sees status only — nothing from this review. Opening application and pharmacy data is logged in History.
      </p>

      {referring && <ReferDrawer review={review} onClose={() => setReferring(false)} />}
    </div>
  )
}

/** Issue → death → end of the contestable period, on one line. */
function Timeline({ review }: { review: ContestableReview }) {
  const span = daysFrom(review.issued, review.periodEnds)
  const at = (d: string) => `${(daysFrom(review.issued, d) / span) * 100}%`
  const months = Math.round(daysFrom(review.issued, review.death) / 30.4)
  return (
    <section className="ct-timeline" aria-label="Contestable period">
      <div className="ct-tl-head">
        <span className="strong">Contestable period</span>
        <span className="sub">Two years from issue</span>
        <span className="grow" />
        <span className="muted">Review due</span>
        <span className="strong">{fmtDate(review.due)} · {fmtCountdown(review.due)}</span>
      </div>
      <div className="ct-tl-bar" aria-hidden="true">
        <span className="ct-tl-elapsed" style={{ width: at(review.death) }} />
        <span className="ct-tl-dot" style={{ left: 0 }} />
        <span className="ct-tl-dot ct-tl-dot--death" style={{ left: at(review.death) }} />
        <span className="ct-tl-dot" style={{ left: '100%' }} />
      </div>
      <ol className="ct-tl-labels">
        <li className="is-start">
          <span className="strong">Issued {fmtDate(review.issued, { year: true })}</span>
          <span className="sub">Applied {fmtDate(review.applicationSigned, { year: true })}</span>
        </li>
        <li className="is-death" style={{ left: at(review.death) }}>
          <span className="strong">Death {fmtDate(review.death, { year: true })}</span>
          <span className="sub">{months} months after issue — within the period</span>
        </li>
        <li className="is-end">
          <span className="strong">Ends {fmtDate(review.periodEnds, { year: true })}</span>
          <span className="sub">Incontestable after this date</span>
        </li>
      </ol>
    </section>
  )
}

function Answers({ review, onRefer }: { review: ContestableReview; onRefer: () => void }) {
  const referred = review.referral.state !== 'notReferred'
  return (
    <section className="section" aria-labelledby="ct-ans-h">
      <div className="section-head">
        <h3 id="ct-ans-h">Application answers compared with the records</h3>
        <span className="aside">Application signed {fmtDate(review.applicationSigned, { year: true })}</span>
      </div>
      <div className="ct-scroll">
      <table className="tbl ct-answers">
        <thead>
          <tr><th style={{ width: '30%' }}>Application question</th><th>Answered</th><th>What the records show</th><th>Status</th></tr>
        </thead>
        <tbody>
          {review.answers.map((a) => {
            const st = ANSWER_STATE[a.state]
            return (
              <tr key={a.id} className={cx(a.state === 'question' && 'ct-q')}>
                <td>
                  <div className="strong">{a.question}</div>
                  <div className="sub">{a.text}</div>
                </td>
                <td className="ct-answer">{a.answer}</td>
                <td>
                  <div>{a.evidence}</div>
                  <div style={{ marginTop: 5 }}><Sources items={a.sources} /></div>
                  {a.note && <div className="ct-note">{a.note}</div>}
                  {a.state === 'question' && !referred && (
                    <button type="button" className="btn btn--ghost btn--xs" style={{ marginTop: 6, marginLeft: -8 }} onClick={onRefer}>
                      Refer this question to Underwriting
                    </button>
                  )}
                </td>
                <td><Tag tone={st.tone}>{st.label}</Tag></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
    </section>
  )
}

function Records({ review }: { review: ContestableReview }) {
  const { user } = useSession()
  const toast = useToast()
  return (
    <section className="section" aria-labelledby="ct-rec-h">
      <div className="section-head">
        <h3 id="ct-rec-h">Records</h3>
        <span className="aside">Requested with Adaeze’s authorization</span>
      </div>
      <ul className="ct-records">
        {review.records.map((r) => (
          <li key={r.id}>
            <div className="ct-rec-top">
              <span className="strong grow">{r.name}</span>
              <StatusTag status={r.status} />
            </div>
            <div className="sub">
              {r.from} · requested {fmtDate(r.requested)}
              {r.due && <> · <span className="ct-due">due {fmtDate(r.due)} ({fmtCountdown(r.due)})</span></>}
            </div>
            {r.followUps.length > 0 && (
              <ul className="ct-follow">
                {r.followUps.map((f) => <li key={f} className="sub">{f}</li>)}
              </ul>
            )}
            {r.due && (
              <div className="ct-rec-actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={async () => {
                    await followUpRecords(review.claimId, r.id, 'Follow-up call', user)
                    toast('Follow-up call logged')
                  }}
                >
                  <Icon name="phone" size={13} />Log follow-up call
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Referral({ review, onRefer }: { review: ContestableReview; onRefer: () => void }) {
  const r = review.referral
  return (
    <section className="section" aria-labelledby="ct-ref-h">
      <div className="section-head">
        <h3 id="ct-ref-h">Underwriting referral</h3>
        <span className="aside">{r.to}</span>
      </div>
      <div className="ct-referral">
        {r.state === 'notReferred' ? (
          <>
            <Tag tone="neutral">Not referred yet</Tag>
            <p className="soft">
              Underwriting gives an opinion on whether the Q4 difference would have changed the issue decision. Refer now so the opinion can arrive by{' '}
              {r.due ? fmtDate(r.due) : 'the review date'}, ahead of the {fmtDate(review.due)} review date. Dr. Patel’s records follow when they arrive.
            </p>
            <div><button type="button" className="btn btn--primary btn--sm" onClick={onRefer}>Refer to Underwriting</button></div>
          </>
        ) : (
          <>
            <div className="ct-rec-top">
              <Tag tone="info">Referred</Tag>
              <span className="sub">
                {r.referredAt ? `${fmtDate(r.referredAt)} ${fmtTime(r.referredAt)}` : 'From the assistant’s suggestion'}
                {r.by && ` · ${r.by}`}
              </span>
            </div>
            {r.question && <blockquote className="ct-quote">“{r.question}”</blockquote>}
            <dl className="dl">
              <dt>Opinion due</dt><dd>{r.due ? `${fmtDate(r.due)} · ${fmtCountdown(r.due)}` : '—'}</dd>
              <dt>Task</dt><dd>Underwriting referral: application Q4 · assigned to Underwriting</dd>
              <dt>Then</dt><dd>You record the term decision; adverse outcomes go to second review</dd>
            </dl>
          </>
        )}
      </div>
    </section>
  )
}

function Rider({ review, claimId }: { review: ContestableReview; claimId: string }) {
  return (
    <section className="section" aria-labelledby="ct-rider-h">
      <div className="section-head">
        <h3 id="ct-rider-h">{review.rider.name} · {fmtMoney(review.rider.amount)}</h3>
        <span className="aside">Follows the term outcome</span>
      </div>
      <div className="ct-rider">
        <p>{review.rider.rule}</p>
        <ul className="ct-rider-ev">
          {review.rider.evidence.map((e) => (
            <li key={e.label}>
              <span className="grow">{e.label}</span>
              <StatusTag status={e.status} />
            </li>
          ))}
        </ul>
        <Link to={`/claims/${claimId}/documents`} className="strong" style={{ fontSize: 12 }}>Open rider evidence in Documents</Link>
      </div>
    </section>
  )
}

const DEFAULT_QUESTION =
  'Application Q4 (signed 18 Sep 2025) answered No to treatment or medication for high blood pressure in the past 5 years. Pharmacy history lists an antihypertensive filled about every 90 days since March 2022. Would this have changed the issue decision on LP-2511086? Dr. Patel’s records are due 30 Sep and will follow.'

/** The referral form: the question goes to Underwriting as written, and the referral is logged. */
function ReferDrawer({ review, onClose }: { review: ContestableReview; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [busy, setBusy] = useState(false)

  async function send() {
    setBusy(true)
    try {
      await referToUnderwriting(review.claimId, question.trim(), user)
      toast(`Referred to Underwriting · opinion due ${review.referral.due ? fmtDate(review.referral.due) : 'before the review date'}`)
      onClose()
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="Refer to Underwriting"
      onClose={onClose}
      footer={
        <>
          <span className="sub grow">Creates a task for Underwriting and logs the referral.</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={send} disabled={busy || !question.trim()}>{busy ? 'Sending…' : 'Send referral'}</button>
        </>
      }
    >
      <dl className="dl">
        <dt>Policy</dt><dd>{review.product} {review.policy} · issued {fmtDate(review.issued, { year: true })}</dd>
        <dt>To</dt><dd>{review.referral.to}</dd>
        <dt>Opinion due</dt><dd>{review.referral.due ? fmtDate(review.referral.due) : '—'} · review due {fmtDate(review.due)}</dd>
        <dt>Attached</dt><dd><Sources items={['Application 2025', 'Pharmacy history', 'Policy record']} /></dd>
      </dl>
      <div className="field">
        <label htmlFor="ct-q">Question for Underwriting</label>
        <textarea id="ct-q" className="textarea" rows={7} value={question} onChange={(e) => setQuestion(e.target.value)} />
        <span className="sub">Ask a question; don’t state a conclusion. Materiality is Underwriting’s call.</span>
      </div>
    </Drawer>
  )
}
