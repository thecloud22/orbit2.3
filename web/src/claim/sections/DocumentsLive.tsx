import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { ApiError } from '../../api/live/http'
import * as live from '../../api/live/data'
import { DOC_KIND, DOC_SOURCE, docFacts, docStatus, docTitle, reviewerName, runPath } from '../../api/live/documents'
import type { Bundle } from '../../api/live/present'
import { day, stamp } from '../../api/live/time'
import type { ApiDocument, ApiWorkflowRun } from '../../api/live/types'
import { fmtDate } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag, Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Live.css'

const message = (e: unknown) => (e instanceof ApiError ? (e.detail ?? e.title) : (e as Error).message)
const when = (iso: string) => `${fmtDate(day(iso))} ${stamp(iso).slice(11)}`

/** The latest run of a workflow id, and its number. */
function latestRun(runs: ApiWorkflowRun[], workflowId: string): { run: ApiWorkflowRun; key: string } | undefined {
  const mine = runs.filter((r) => r.workflowId === workflowId).sort((x, y) => x.startedAt.localeCompare(y.startedAt))
  const run = mine.at(-1)
  return run ? { run, key: mine.length > 1 ? `${workflowId}#${run.runNo ?? mine.length}` : workflowId } : undefined
}

/**
 * The workflow that followed a rejection: the event workflow the outbox relay started from the review ("review saved"), the first one
 * after the examiner's decision. The document itself carries only the workflow that received it.
 */
function rejectionRun(runs: ApiWorkflowRun[], d: ApiDocument): ApiWorkflowRun | undefined {
  if (d.status !== 'rejected' || !d.reviewedAt) return undefined
  return runs
    .filter((r) => /review saved/i.test(r.startedBy) && r.startedAt >= d.reviewedAt!)
    .sort((x, y) => x.startedAt.localeCompare(y.startedAt))[0]
}

const RUN_TAG: Record<ApiWorkflowRun['status'], { tone: 'info' | 'critical' | 'positive' | 'caution' | 'neutral'; label: string }> = {
  running: { tone: 'info', label: 'Running' },
  failed: { tone: 'critical', label: 'Failed after retries' },
  completed: { tone: 'positive', label: 'Completed' },
  needs_review: { tone: 'caution', label: 'Needs a person' },
  skipped: { tone: 'neutral', label: 'Skipped' },
}

/**
 * Documents for a live claim: what the backend recorded about each one that arrived (kind, source, from whom, when, status and why, the
 * taxpayer number's last four digits, the event workflow that handled it), and the examiner's review of a document the rules could not accept
 * (POST /documents/{id}:review). There is no document store or viewer on the backend: nothing here shows a page image.
 */
export function DocumentsLive({ claim, target }: SectionProps) {
  const { data: b, loading, error } = useQuery(() => live.bundleFor(claim.id), [claim.id])
  if (error) return <p className="lv-error" role="alert">{error.message}</p>
  if (!b) return <>{header(0, 0)}{loading && <Loading rows={5} />}</>

  const docs = [...b.documents].sort((x, y) => y.receivedAt.localeCompare(x.receivedAt))
  const waiting = docs.filter((d) => d.status === 'under_review')

  return (
    <div className="lv" data-documents>
      {header(docs.length, waiting.length)}
      <div className="callout-info lv-docnote">
        <Icon name="flow" size={14} color="var(--accent)" />
        <span className="grow">
          Each document is saved in Postgres with an event; a short workflow then decides. A W-9 gets an IRS check (“no match” is an answer, not an error);
          a certified death certificate is accepted; a photocopy goes to the examiner. The backend has no document store, so there is no page to view: this is what it recorded.
        </span>
      </div>

      {waiting.map((d) => <ReviewPanel key={d.id} b={b} d={d} highlight={target === d.id} />)}

      {docs.length === 0 ? (
        <div className="empty" data-documents-empty>
          No documents have arrived for this claim yet. They arrive from the portal, the mail room or an upload (in this demo, from the Demo controls: <em>Documents</em> events), and each one starts a workflow.
          {b.requirements.some((r) => r.state !== 'accepted' && r.state !== 'waived') && <> <Link to={`/claims/${claim.id}/requirements`}>See what is still needed</Link>.</>}
        </div>
      ) : (
        <div className="lv-scroll">
          <table className="tbl tbl--middle lv-docs" data-docs>
            <thead>
              <tr><th>Document</th><th>From</th><th>Received</th><th>Status</th><th>Taxpayer no.</th><th>Handled by</th></tr>
            </thead>
            <tbody>
              {docs.map((d) => <DocRow key={d.id} b={b} d={d} selected={target === d.id} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  function header(n: number, review: number) {
    return (
      <div className="page-head">
        <h2>Documents</h2>
        <span className="aside">{n} on file{review ? ` · ${review} under review` : ''} · newest first</span>
        <Tag tone="info">Live</Tag>
      </div>
    )
  }
}

// ---------------------------------------------------------------- One row

function RunLink({ b, run, label }: { b: Bundle; run: { run: ApiWorkflowRun; key: string }; label: string }) {
  const t = RUN_TAG[run.run.status]
  return (
    <div className="lv-runline">
      <span className="sub">{label}</span>
      <Link className="mono lv-ref" to={runPath(b.claim.claimNumber, run.key)} data-doc-workflow={run.run.workflowId} title="Open the run on Workflow & SLA">{run.run.workflowId}{(run.run.runNo ?? 1) > 1 ? ` · run ${run.run.runNo}` : ''}</Link>
      <Tag tone={t.tone}>{t.label}</Tag>
    </div>
  )
}

function DocRow({ b, d, selected }: { b: Bundle; d: ApiDocument; selected: boolean }) {
  const claim = b.claim.claimNumber
  const received = d.workflowId ? latestRun(b.runs, d.workflowId) : undefined
  const after = rejectionRun(b.runs, d)
  const afterRun = after ? latestRun(b.runs, after.workflowId) : undefined
  const facts = docFacts(d).filter((f) => !f.startsWith('Taxpayer'))
  const by = reviewerName(d.reviewedBy)
  useEffect(() => {
    if (selected) document.getElementById(`doc-${d.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, d.id])
  return (
    <>
      <tr id={`doc-${d.id}`} className={cx(d.status === 'under_review' && 'lv-doc-review', selected && 'lv-flash')} data-doc-row={d.id} data-doc-kind={d.kind} data-doc-status={d.status}>
        <td className="lv-wrap">
          <div className="strong">{DOC_KIND[d.kind]}</div>
          <div className="sub">for {d.requirementName ?? 'no requirement'}</div>
          {facts.length > 0 && <div className="sub">{facts.join(' · ')}</div>}
        </td>
        <td className="lv-wrap">
          <div>{d.partyName ?? '—'}</div>
          <div className="sub">{DOC_SOURCE[d.source]}</div>
        </td>
        <td className="nowrap">{when(d.receivedAt)}</td>
        <td className="lv-wrap">
          <StatusTag status={docStatus(d)} />
          {d.statusNote && <div className="sub" data-doc-note>{d.statusNote}</div>}
          {by && d.status !== 'under_review' && d.reviewedAt && <div className="sub">by {by} · {when(d.reviewedAt)}</div>}
        </td>
        <td className="mono" data-doc-tin>{d.attributes.tinMasked ?? <span className="muted">—</span>}</td>
        <td className="lv-wrap">
          {received ? <RunLink b={b} run={received} label="Received:" /> : <span className="sub">{d.workflowId ? 'workflow started' : 'waiting for the outbox relay'}</span>}
        </td>
      </tr>
      {d.status === 'rejected' && (
        <tr className="lv-hold-row" data-doc-after={d.id}>
          <td colSpan={6}>
            <Rejected b={b} d={d} run={afterRun} claim={claim} />
          </td>
        </tr>
      )}
    </>
  )
}

/** What a rejection set in motion: the requirement is asked for again, and the letter workflow runs (or fails, and ops re-runs it). */
function Rejected({ b, d, run, claim }: { b: Bundle; d: ApiDocument; run: { run: ApiWorkflowRun; key: string } | undefined; claim: string }) {
  const req = b.requirements.find((r) => r.id === d.requirementId)
  const failed = run?.run.status === 'failed'
  const first = run ? b.runs.filter((r) => r.workflowId === run.run.workflowId).sort((x, y) => x.startedAt.localeCompare(y.startedAt))[0] : undefined
  return (
    <div className="lv-after" role="note">
      <div>
        <strong>{reviewerName(d.reviewedBy) ?? 'The examiner'} rejected it</strong>: “{d.reviewReason ?? d.statusNote}”. Saved in Postgres first: the requirement went back to <strong>requested again</strong>{req ? <> <Link to={`/claims/${claim}/requirements/${req.id}`}>(now {req.state.replace('_', ' ')})</Link></> : null}, the review and old follow-up rows were closed and a new follow-up row was written.
      </div>
      {run ? (
        <div className="lv-runline">
          <span>Then the letter workflow ran:</span>
          <Link className="mono lv-ref" to={runPath(claim, run.key)} data-rejection-run={run.run.workflowId}>{run.run.workflowId}{(run.run.runNo ?? 1) > 1 ? ` · run ${run.run.runNo}` : ''}</Link>
          <Tag tone={RUN_TAG[run.run.status].tone}>{RUN_TAG[run.run.status].label}</Tag>
          {failed && <span className="lv-red">the letters service was down: Temporal retried {run.run.steps.find((s) => s.state === 'failed')?.attempts ?? 5} times, then stopped and opened an ops task</span>}
          {(run.run.runNo ?? 1) > 1 && first && <span className="sub">(run 1 failed; ops re-ran it)</span>}
          {failed && run.run.canRerun && <RerunButton claim={claim} run={run.run} />}
        </div>
      ) : (
        <div className="sub">The letter workflow has not started yet (the outbox relay starts it within a few seconds).</div>
      )}
    </div>
  )
}

function RerunButton({ claim, run }: { claim: string; run: ApiWorkflowRun }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <button type="button" className="btn btn--sm" data-rerun={run.id} disabled={busy} onClick={() => {
      setBusy(true)
      live.rerunWorkflow(claim, run.id).then((m) => toast(m), (e: Error) => toast(e.message)).finally(() => setBusy(false))
    }}>{busy ? 'Starting…' : 'Re-run this workflow'}</button>
  )
}

// ---------------------------------------------------------------- The review

/**
 * The examiner's decision on a document the rules could not accept. Only the examiner persona can take it (POST :review is sent with the
 * signed-in persona's X-Actor and the document's ETag); anyone else sees why the buttons are off.
 */
function ReviewPanel({ b, d, highlight }: { b: Bundle; d: ApiDocument; highlight: boolean }) {
  const { user } = useSession()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [err, setErr] = useState<string | undefined>()
  const isExaminer = user.role === 'lifeExaminer'
  const row = b.deadlines.find((x) => x.documentId === d.id && x.state === 'open')
  const item = b.workItems.find((w) => /review/i.test(w.action) && /certificate|document/i.test(w.action))
  const why = isExaminer ? undefined : `Only the examiner reviews a document (you are ${user.name}, ${user.title}). Sign in as Rachel Kim (top right, Sign in as).`
  const needReason = reason.trim().length < 3

  async function act(decision: 'accept' | 'reject') {
    setBusy(decision)
    setErr(undefined)
    try {
      toast(await live.reviewDocument(b.claim.claimNumber, d, decision, reason))
      setReason('')
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 412 ? 'This document changed since you opened it. It is shown again with the latest; try once more.' : message(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className={cx('wb-form lv-approval', highlight && 'lv-flash')} aria-labelledby={`rv-${d.id}`} data-review-panel={d.id}>
      <div className="wb-form-head">
        <Icon name="document" />
        <h3 id={`rv-${d.id}`}>Needs the examiner’s review · {docTitle(d)}</h3>
        <span className="grow" />
        <Tag tone="special">Under review</Tag>
      </div>
      <div className="wb-form-body">
        <p className="lv-lead">
          The document workflow could not accept this one{d.statusNote ? `: ${d.statusNote}` : ''}. It handed it to the examiner and <strong>ended</strong>: waiting for a person is a work item and a deadline row in Postgres, not a workflow asleep.
        </p>
        <dl className="dl lv-dl">
          <dt>Received</dt><dd>{when(d.receivedAt)} · {DOC_SOURCE[d.source]}{d.partyName ? ` · from ${d.partyName}` : ''}</dd>
          <dt>What it declares</dt><dd>{docFacts(d).join(' · ') || '—'}</dd>
          <dt>For</dt><dd>{d.requirementName ?? '—'}</dd>
          <dt>Review by</dt><dd>{row ? <span data-review-row>{fmtDate(day(row.dueAt), { weekday: true })} <span className="sub">(document_review_by, the “review a document” service level: 1 business day)</span></span> : <span className="muted">no open review row</span>}</dd>
          {item && (<><dt>Work item</dt><dd data-review-item>{item.action} <span className="sub">· due {fmtDate(item.dueOn)}</span></dd></>)}
        </dl>
        <div className="field">
          <label htmlFor={`rv-reason-${d.id}`} className="wb-label" style={{ marginBottom: 0 }}>Reason <span className="sub" style={{ fontWeight: 400 }}>· required to reject, optional to accept</span></label>
          <textarea id={`rv-reason-${d.id}`} className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={!isExaminer} data-review-reason
            placeholder="e.g. A photocopy is not enough: a certified copy with a raised seal is needed" />
        </div>
        {err && <div className="lv-error" role="alert">{err}</div>}
      </div>
      <div className="wb-form-foot">
        {why ? <span className="sub grow" data-cannot-review>{why}</span> : <span className="sub grow">Accept: the requirement is accepted. Reject: it is asked for again and the “certified copy needed” letter goes out.</span>}
        <button type="button" className="btn" data-review-accept disabled={!isExaminer || busy !== null} title={why} onClick={() => act('accept')}>{busy === 'accept' ? 'Accepting…' : 'Accept document'}</button>
        <button type="button" className="btn btn--primary" data-review-reject disabled={!isExaminer || busy !== null || needReason} title={why ?? (needReason ? 'Give a reason to reject' : undefined)} onClick={() => act('reject')}>{busy === 'reject' ? 'Rejecting…' : 'Reject document'}</button>
      </div>
    </section>
  )
}
