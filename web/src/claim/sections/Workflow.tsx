import { useEffect, useRef, useState } from 'react'
import { useQuery } from '../../api/useQuery'
import * as liveData from '../../api/live/data'
import {
  chooseFork,
  getFlow,
  interestFor,
  LANES,
  MILESTONES,
  playNext,
  runKey,
  STATUS_TEXT,
  type DeadlineRow,
  type ForkChoice,
  type LifeFlow,
  type RunStep,
  type ServiceLevel,
  type WorkflowRun,
} from '../../api/lifeFlow'
import { WAIVE_REASONS } from '../../api/requirements'
import type { Tone } from '../../api/types'
import { daysFrom, fmtDate, plural } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { cx } from '../../lib/cx'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Tag, ToneShape } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import type { SectionProps } from './types'
import { LiveWork } from './LiveWork'
import './Workflow.css'

type View = 'lanes' | 'rows' | 'runs'

const dayTime = (iso: string) => `${fmtDate(iso.slice(0, 10), { weekday: true })} · ${iso.slice(11, 16)}`

/** Scrolls the claim's main column (only) so the element is near the top. */
function scrollMainTo(el: Element | null) {
  const main = el?.closest('.cw-main')
  if (!el || !main) return
  main.scrollTo({ top: el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 12, behavior: 'smooth' })
}

/** Runs already replayed step by step, so coming back to the tab doesn't replay them again. */
const replayed = new Set<string>()

/**
 * Workflow & SLA: how this claim moves through the backend. Postgres holds the state and every deadline,
 * Temporal runs short workflows, batch pays. Target 'replay' opens the intake run and plays its steps.
 */
export function WorkflowSection({ claim, target }: SectionProps) {
  const { data: flow, loading } = useQuery(() => getFlow(claim.id), [claim.id])
  const runTarget = target?.startsWith('run:') ? decodeURIComponent(target.slice(4)) : undefined
  const [view, setView] = useState<View>(target === 'replay' || target === 'runs' || runTarget ? 'runs' : 'lanes')
  const [openRuns, setOpenRuns] = useState<Set<string>>(() => new Set([`orch-${claim.id}-intake`, ...(runTarget ? [runTarget] : [])]))
  // Live: a run Temporal had to retry, or gave up on, is the interesting one: it is open until the presenter closes it.
  const [shut, setShut] = useState<Set<string>>(() => new Set())
  const [fresh, setFresh] = useState<{ lanes: number; runs: number } | null>(null)

  // A link to one run (from Documents, or the other run of the same workflow id) opens it. State follows the target while rendering; the scroll is an effect.
  const [seenTarget, setSeenTarget] = useState(runTarget)
  if (runTarget !== seenTarget) {
    setSeenTarget(runTarget)
    if (runTarget) {
      setOpenRuns((s) => new Set(s).add(runTarget))
      setShut((s) => { const n = new Set(s); n.delete(runTarget); return n })
      setView('runs')
    }
  }
  const haveFlow = !!flow
  useEffect(() => {
    if (!runTarget || !haveFlow || view !== 'runs') return
    const t = window.setTimeout(() => scrollMainTo(document.getElementById(`run-${runTarget}`)), 150)
    return () => window.clearTimeout(t)
  }, [runTarget, haveFlow, view])

  if (loading && !flow) return <Loading rows={8} />
  if (!flow) {
    return (
      <>
        <div className="page-head"><h2>Workflow & SLA</h2></div>
        <div className="empty">This claim has no workflow record in the mock. Claims taken through the life intake have one.</div>
      </>
    )
  }

  const worthOpening = (r: WorkflowRun) => !!r.live && (r.failed || !!r.live.rerunOfKey || r.steps.some((x) => x.state === 'retried' || x.state === 'failed'))
  const isOpen = (r: WorkflowRun) => (openRuns.has(runKey(r)) || worthOpening(r)) && !shut.has(runKey(r))

  function openRun(id: string) {
    setShut((s) => { const n = new Set(s); n.delete(id); return n })
    setOpenRuns((s) => new Set(s).add(id))
    setView('runs')
    requestAnimationFrame(() => scrollMainTo(document.getElementById(`run-${id}`)))
  }

  return (
    <div className="wf">
      <div className="page-head">
        <h2>Workflow & SLA</h2>
        <span className="aside">Postgres holds the state and every deadline · Temporal runs short workflows · batch pays</span>
        {flow.live && <Tag tone="info">Live</Tag>}
      </div>

      {flow.live ? (
        <LivePanel flow={flow} />
      ) : (
        <PlayPanel
          flow={flow}
          onPlayed={(before, played) => {
            setFresh(before)
            const latest = played.at(-1)
            if (latest) setOpenRuns((s) => new Set(s).add(latest))
          }}
        />
      )}

      {flow.live && <LiveWork flow={flow} />}
      <Milestones flow={flow} />
      <ServiceLevels flow={flow} />

      <div className="wf-tabs" role="tablist" aria-label="Workflow detail">
        {([
          ['lanes', 'Swimlane', flow.lanes.length],
          ['rows', 'Deadline rows', flow.deadlines.length],
          ['runs', 'Workflow runs', flow.runs.length],
        ] as const).map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={cx('wf-tab', view === k && 'active')} onClick={() => setView(k)}>
            {label} <span className="sn-count">{n}</span>
          </button>
        ))}
      </div>

      {view === 'lanes' && <Swimlane flow={flow} freshFrom={fresh?.lanes} onRun={openRun} />}
      {view === 'rows' && <DeadlineRows flow={flow} />}
      {view === 'runs' && (
        <Runs
          flow={flow}
          isOpen={isOpen}
          freshFrom={fresh?.runs}
          replay={target === 'replay' ? `orch-${claim.id}-intake` : undefined}
          onOpenRun={openRun}
          onToggle={(id, on) => {
            setOpenRuns((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
            setShut((s) => { const n = new Set(s); if (on) n.delete(id); else n.add(id); return n })
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- Play forward (mock)

/** What the panel says when nothing is left to play. */
function endText(flow: LifeFlow): string {
  const date = fmtDate(flow.now.slice(0, 10), { weekday: true })
  const reset = 'Reload the page to reset the demo data and take the intake again.'
  if (flow.status === 'closedIncomplete') return `The claim closed incomplete on ${date}. Nothing was paid; it reopens if the missing statement arrives. ${reset}`
  if (flow.status === 'held' && flow.hold) return `The claim stays open. ${flow.hold.payee.split(' ')[0]}’s half is held ${flow.hold.state === 'interpleader' ? 'for the court' : 'for the competing claim'}${flow.hold.reviewOn ? `; the hold row is reviewed on ${fmtDate(flow.hold.reviewOn, { weekday: true })}` : ''}. ${reset}`
  return `The claim closed on ${date}. ${reset}`
}

const STATUS_TONE: Record<LifeFlow['status'], Tone> = { gathering: 'info', inReview: 'info', awaitingApproval: 'info', approved: 'info', held: 'caution', reopened: 'caution', closed: 'positive', closedIncomplete: 'neutral' }

function PlayPanel({ flow, onPlayed }: { flow: LifeFlow; onPlayed: (before: { lanes: number; runs: number }, runIds: string[]) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<string>(WAIVE_REASONS[3])
  const next = flow.script[0]
  const then = flow.script.slice(1, 4)
  const dayN = daysFrom(flow.noticeAt.slice(0, 10), flow.now.slice(0, 10))
  const fork = flow.fork

  async function play(all: boolean) {
    setBusy(true)
    const before = { lanes: flow.lanes.length, runs: flow.runs.length }
    let last: Awaited<ReturnType<typeof playNext>> = null
    let count = 0
    do {
      last = await playNext(flow.claimId)
      if (last) count++
    } while (all && last)
    const after = await getFlow(flow.claimId)
    onPlayed(before, after ? after.runs.slice(before.runs).map(runKey) : [])
    setBusy(false)
    if (all) toast(after?.fork ? `Played ${plural(count, 'step')} · ${after.fork.title}: your choice` : `Played ${plural(count, 'step')} · the claim is ${after ? STATUS_TEXT[after.status].toLowerCase() : 'up to date'}`)
    else if (next) toast(`${fmtDate(next.date)} · ${next.title}`)
  }

  async function choose(c: ForkChoice) {
    setBusy(true)
    const before = { lanes: flow.lanes.length, runs: flow.runs.length }
    try {
      const h = await chooseFork(flow.claimId, c.key, c.needsReason ? reason : undefined)
      const after = await getFlow(flow.claimId)
      onPlayed(before, after ? after.runs.slice(before.runs).map(runKey) : [])
      toast(`${fmtDate(h.date)} · ${h.title}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That didn’t work')
    }
    setBusy(false)
  }

  return (
    <section className="wf-play" aria-labelledby="wf-play-h">
      <div className="wf-play-clock">
        <span className="wf-label" id="wf-play-h">Claim clock <span className="wf-mock">mock</span></span>
        <strong className="wf-now">{dayTime(flow.now)}</strong>
        <span className="muted">{dayN === 0 ? 'Day of notice' : `Day ${dayN} since notice`} · <Tag tone={STATUS_TONE[flow.status]}>{STATUS_TEXT[flow.status]}</Tag></span>
      </div>
      <div className="wf-play-next">
        {fork ? (
          <>
            <span className="wf-label">Waiting on the examiner</span>
            <strong>{fork.title}</strong>
            <span>{fork.text}</span>
            <ul className="wf-fork">
              {fork.choices.map((c) => <li key={c.key}><strong>{c.label}.</strong> {c.detail}</li>)}
            </ul>
            {fork.choices.some((c) => c.needsReason) && (
              <label className="wf-reason">
                <span className="wf-label">Reason to waive</span>
                <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {WAIVE_REASONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </label>
            )}
          </>
        ) : next ? (
          <>
            <span className="wf-label">Next to happen</span>
            <span className="wf-next-line">
              <span className="mono nowrap">{dayTime(`${next.date}T${next.time}`)}</span>
              <strong>{next.title}</strong>
              <span className="wf-who">{next.who}</span>
            </span>
            {then.length > 0 && (
              <ol className="wf-then">
                {then.map((h) => <li key={h.id}><span className="mono">{fmtDate(h.date)}</span> {h.title}</li>)}
                {flow.script.length > 4 && <li className="muted">and {plural(flow.script.length - 4, 'more step')}</li>}
              </ol>
            )}
          </>
        ) : (
          <>
            <span className="wf-label">Nothing left to happen</span>
            <span>{endText(flow)}</span>
          </>
        )}
      </div>
      <div className="wf-play-actions">
        {fork ? (
          <>
            {fork.choices.map((c, i) => (
              <button key={c.key} type="button" className={cx('btn', i === 0 && 'btn--primary')} disabled={busy} onClick={() => choose(c)}>{c.label}</button>
            ))}
            <p className="sub">The examiner’s choice. Play next waits for it.</p>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--primary" disabled={!next || busy} onClick={() => play(false)}>
              Play next<Icon name="arrowRight" size={12} />
            </button>
            <button type="button" className="btn" disabled={!next || busy} onClick={() => play(true)}>Play to the end</button>
            <p className="sub">Plays what the outside world does next. Each step writes what the backend would: rows, runs, letters, history.</p>
          </>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Live (the real backend)

/** The live counterpart of the play panel: the backend's clock, the claim's status, and what is still in flight. There is nothing to play. */
function LivePanel({ flow }: { flow: LifeFlow }) {
  const live = flow.live!
  const dayN = daysFrom(flow.noticeAt.slice(0, 10), flow.now.slice(0, 10))
  const busy = live.inFlight.length > 0
  return (
    <section className="wf-play wf-play--live" aria-labelledby="wf-play-h">
      <div className="wf-play-clock">
        <span className="wf-label" id="wf-play-h">Clock <span className="wf-mock wf-live">live · {live.clockSource === 'virtual' ? 'backend clock' : 'this browser’s clock'}</span></span>
        <strong className="wf-now">{dayTime(flow.now)}</strong>
        <span className="muted">{dayN === 0 ? 'Day of notice' : `Day ${dayN} since notice`} · <Tag tone={live.statusTone}>{live.statusLabel}</Tag></span>
      </div>
      <div className="wf-play-next">
        <span className="wf-label">{busy ? 'In flight' : 'Idle'}</span>
        {busy ? (
          <ul className="wf-then">
            {live.inFlight.map((t) => <li key={t}>{t}</li>)}
          </ul>
        ) : (
          <span>Nothing is running. Deadline rows fire when their time comes; move the clock with Demo controls (the bar at the bottom of the screen) to make them come due.</span>
        )}
      </div>
      <div className="wf-play-actions">
        <span className="wf-label"><span className={cx('wf-pulse', busy && 'wf-pulse--on')} aria-hidden="true" />{busy ? 'Refreshing every 2 s' : 'Watching for changes'}</span>
        <p className="sub">This page reads the backend, not a script. It refreshes every 2 s while something is in flight, and less often when idle.</p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Milestones

function Milestones({ flow }: { flow: LifeFlow }) {
  const last = MILESTONES.map((m) => !!flow.reached[m.key]).lastIndexOf(true)
  return (
    <section aria-labelledby="wf-steps-h" className="wf-block">
      <div className="section-head">
        <h3 id="wf-steps-h">Steps</h3>
        <span className="aside">From notice of death to a closed claim</span>
      </div>
      <ol className="wf-steps" style={{ ['--n' as string]: MILESTONES.length }}>
        {MILESTONES.map((m, i) => {
          const at = flow.reached[m.key]
          const state = !at ? 'todo' : i < last || m.key === 'closed' ? 'done' : 'current'
          return (
            <li key={m.key} className={cx('wf-step', `wf-step--${state}`)} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="wf-step-mark"><StepDot state={state} /></span>
              <span className="wf-step-label">{m.label}</span>
              <span className="wf-step-note">{at ? `${state === 'current' ? 'Since ' : ''}${dayTime(at)}` : m.note}</span>
              <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current)' : ''}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function StepDot({ state }: { state: 'done' | 'current' | 'todo' }) {
  if (state === 'done')
    return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#45494F" /><path d="M4.6 8.2 7 10.4l4.4-4.8" fill="none" stroke="#FFFFFF" strokeWidth="1.7" /></svg>
  if (state === 'current')
    return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#FFFFFF" stroke="#1F4E8C" strokeWidth="2" /><circle cx="8" cy="8" r="3" fill="#1F4E8C" /></svg>
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#FFFFFF" stroke="#A3A098" strokeWidth="1.5" /></svg>
}

// ---------------------------------------------------------------- Service levels

function slStatus(s: ServiceLevel, flow: LifeFlow): { tone: Tone; label: string } {
  const today = flow.now.slice(0, 10)
  if (s.kind === 'accruing') {
    if (s.stopped) return { tone: 'neutral', label: s.stopped }
    if (s.metOn) return { tone: 'positive', label: `Paid ${fmtDate(s.metOn.slice(0, 10))} · ${s.note ?? ''}` }
    if (s.note) return { tone: 'info', label: `Accruing · ${s.note}` }
    const days = daysFrom(flow.dateOfDeath, today)
    return { tone: 'info', label: `Accruing · ${plural(days, 'day')} · ${fmtMoney(interestFor(flow.total, days))}` }
  }
  if (s.stopped) return { tone: 'neutral', label: s.stopped }
  // Met after the due date: the breach stays red.
  if (s.lateDays && s.metOn) return { tone: 'critical', label: `Breached · met ${fmtDate(s.metOn.slice(0, 10))}, ${plural(s.lateDays, 'day')} late` }
  if (s.metOn) return { tone: 'positive', label: `Met ${fmtDate(s.metOn.slice(0, 10))}${s.metOn.slice(0, 10) === s.start ? ' · same day' : ''}` }
  if (!s.due) return { tone: 'neutral', label: 'Not started' }
  const left = daysFrom(today, s.due)
  if (s.pastDue && left >= 0) return { tone: 'critical', label: left === 0 ? 'Breached · past due today' : `Breached · past due` }
  if (left < 0) return { tone: 'critical', label: `Breached · ${plural(-left, 'day')} late` }
  if (left <= 1) return { tone: 'caution', label: left === 0 ? 'Due today' : 'Due tomorrow' }
  return { tone: 'info', label: `Running · ${plural(left, 'day')} left` }
}

function ServiceLevels({ flow }: { flow: LifeFlow }) {
  return (
    <section aria-labelledby="wf-sla-h" className="wf-block">
      <div className="section-head">
        <h3 id="wf-sla-h">Service levels</h3>
        <span className="aside">Each is enforced by a row in the deadlines table · state values are examples until the rules table exists</span>
      </div>
      <div className="wf-scroll">
        <table className="tbl tbl--middle wf-sla">
          <thead>
            <tr><th>Service level</th><th>Source</th><th>Clock starts</th><th>Due</th><th>Status</th></tr>
          </thead>
          <tbody>
            {flow.serviceLevels.map((s) => {
              const st = slStatus(s, flow)
              const rows = flow.deadlines.filter((d) => d.sla === s.id)
              return (
                <tr key={s.id}>
                  <td>
                    <span className="strong">{s.name}</span>
                    <span className="sub wf-block-line">{s.rule}</span>
                  </td>
                  <td><Tag>{s.source}</Tag></td>
                  <td>
                    {s.starts}
                    {s.start && <span className="sub wf-block-line">{fmtDate(s.start, { weekday: true })}</span>}
                  </td>
                  <td className="nowrap">
                    {s.kind === 'accruing' ? 'At payment' : s.due ? fmtDate(s.due, { weekday: true }) : '—'}
                    {rows.length > 0 && <span className="sub-mono wf-block-line">{rows.map((r) => r.id).join(', ')}</span>}
                  </td>
                  <td>
                    <Tag tone={st.tone}>{st.label}</Tag>
                    {s.note && s.kind !== 'accruing' && <span className="sub wf-block-line">{s.note}</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Swimlane

function Swimlane({ flow, freshFrom, onRun }: { flow: LifeFlow; freshFrom?: number; onRun: (id: string) => void }) {
  return (
    <section aria-label="Swimlane" className="wf-block">
      <p className="wf-legend">
        One row per thing that happened, oldest first. Read across: who acted, what Postgres saved, which Temporal workflow ran. Workflow names open the run.
      </p>
      <div className="wf-scroll">
        <div className="wf-lanes" role="table" aria-label="What happened, by lane">
          <div className="wf-lanes-head" role="row">
            <div role="columnheader" className="wf-lh">When</div>
            {LANES.map((l) => (
              <div key={l.key} role="columnheader" className="wf-lh">
                <strong>{l.label}</strong>
                <span>{l.sub}</span>
              </div>
            ))}
          </div>
          {flow.lanes.map((r, i) => (
            <div key={r.id} role="row" className={cx('wf-lane-row', freshFrom !== undefined && i >= freshFrom && 'wf-fresh')}>
              <div role="cell" className="wf-when">
                <span className="mono">{dayTime(r.at)}</span>
                <span className="wf-when-title">{r.title}</span>
              </div>
              {LANES.map((l) => {
                const lines = r.cells[l.key]
                return (
                  <div key={l.key} role="cell" className={cx('wf-cell', lines && 'wf-cell--on')}>
                    {lines?.map((t, j) =>
                      l.key === 'temporal' && j === 0 && r.runId ? (
                        <button key={t} type="button" className="wf-chip wf-chip--run mono" onClick={() => onRun(r.runId!)} title="Open this workflow run">{t}</button>
                      ) : (
                        <span key={t} className={cx('wf-chip', j === 0 && 'wf-chip--lead')}>{t}</span>
                      ),
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Deadline rows

function rowStatus(d: DeadlineRow): { tone: Tone; label: string } {
  if (d.live) {
    const l = d.live
    if (l.state === 'dispatched') return { tone: 'info', label: 'Dispatched · workflow running' }
    if (l.lastOutcome === 'start_failed' && d.status === 'open') return { tone: 'critical', label: 'Start failed · will retry' }
    if (l.state === 'open' && l.pastDue) return l.hasWorkflow ? { tone: 'caution', label: 'Due · waiting for the dispatcher' } : { tone: 'critical', label: 'Past due · the overdue check raises it' }
  }
  if (d.status === 'open') return { tone: 'neutral', label: 'Open' }
  if (d.status === 'skipped') return { tone: 'plain', label: 'Skipped' }
  if (d.breached) return { tone: 'critical', label: 'Breached · fired late' }
  return d.fired ? { tone: 'info', label: 'Fired · done' } : { tone: 'positive', label: 'Closed early' }
}

/** What each kind of row is for, in plain words, under the kind the table stores. */
const KIND_LABEL: Record<DeadlineRow['kind'], string> = {
  acknowledge_by: 'Acknowledge',
  forms_by: 'Claim forms',
  first_contact_by: 'First contact',
  status_letter: 'Status letter',
  requirement_follow_up: 'Follow-up on a requirement',
  requirement_expiry: 'Requirement expiry',
  decision_due: 'Decision due',
  review_target: 'Examiner review target',
  payment_due: 'Payment due',
  dispute_response_by: 'Dispute response',
  hold_review: 'Hold review',
  document_review_by: 'Examiner reviews a document',
  bank_details_by: 'Payee gives new bank details',
}

function DeadlineRows({ flow }: { flow: LifeFlow }) {
  const open = flow.deadlines.filter((d) => d.status === 'open').length
  const fired = flow.deadlines.filter((d) => d.fired).length
  const skipped = flow.deadlines.filter((d) => d.status === 'skipped' && !d.fired).length
  return (
    <section aria-label="Deadline rows" className="wf-block">
      <p className="wf-legend">
        Every deadline is a row in Postgres. A Temporal Schedule runs the dispatcher every minute; when a row comes due it starts <span className="mono">deadline-&lt;row&gt;</span>, which re-checks the claim and acts. Most rows close early because the thing happened first.
        {' '}<strong data-row-counts>{open} open · {fired} fired · {skipped} skipped · {flow.deadlines.length - open - fired - skipped} closed early.</strong>
      </p>
      <div className="wf-scroll">
        <table className="tbl tbl--middle wf-rows">
          <thead>
            <tr><th>Row</th><th>Kind</th><th>What</th><th>Due</th><th>Status</th><th>How it closed</th></tr>
          </thead>
          <tbody>
            {flow.deadlines.map((d) => {
              const st = rowStatus(d)
              return (
                <tr key={d.id} className={d.status === 'open' ? 'wf-row-open' : undefined}>
                  <td className="mono nowrap">{d.id}</td>
                  <td className={cx('wf-kind', d.live && 'wf-kind--live')}>{d.live ? <><span className="mono">{d.kind}</span><span className="sub wf-block-line">{KIND_LABEL[d.kind] ?? ''}</span></> : d.kind}</td>
                  <td>{d.what}</td>
                  <td className="nowrap">{fmtDate(d.due, { weekday: true })}</td>
                  <td><Tag tone={st.tone}>{st.label}</Tag></td>
                  <td className="wf-result">{d.result ?? (d.status === 'open' ? (d.live && !d.live.hasWorkflow ? (d.live.closes ? `No workflow fires this row (${fmtDate(d.due)}); ${d.live.closes} closes it` : `Nothing fires this kind yet (${fmtDate(d.due)}); it stays open until something closes it`) : `Fires ${fmtDate(d.due)} if nothing closes it first`) : '')}{d.live?.extensionReason ? ` · extended: ${d.live.extensionReason}` : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- Workflow runs

function Runs({ flow, isOpen, freshFrom, replay, onToggle, onOpenRun }: {
  flow: LifeFlow
  isOpen: (r: WorkflowRun) => boolean
  freshFrom?: number
  replay?: string
  onToggle: (id: string, open: boolean) => void
  onOpenRun: (id: string) => void
}) {
  return (
    <section aria-label="Workflow runs" className="wf-block">
      <p className="wf-legend">
        Every run is short and has a key, so starting it twice does nothing. Each step calls one system and is retried by Temporal if it fails; the run ends by saving its results to Postgres in one transaction. Things that only touch Postgres, like logging a call or locking a decision, don’t need a workflow.
      </p>
      <div className="wf-runs">
        {flow.runs.map((r, i) => (
          <RunView key={runKey(r)} run={r} claimId={flow.claimId} opsTask={flow.live?.workItems?.find((w) => r.failed && w.action.includes(r.id))} open={isOpen(r)} fresh={freshFrom !== undefined && i >= freshFrom} replay={replay === runKey(r)} onToggle={(o) => onToggle(runKey(r), o)} onOpenRun={onOpenRun} />
        ))}
      </div>
    </section>
  )
}

const TYPE_TONE: Record<WorkflowRun['type'], Tone> = { Orchestration: 'special', 'Event workflow': 'neutral', 'Deadline workflow': 'neutral' }

type OpsTask = NonNullable<NonNullable<LifeFlow['live']>['workItems']>[number]

function RunView({ run, claimId, opsTask, open, fresh, replay, onToggle, onOpenRun }: {
  run: WorkflowRun
  claimId?: string
  opsTask?: OpsTask
  open: boolean
  fresh: boolean
  replay: boolean
  onToggle: (open: boolean) => void
  onOpenRun: (key: string) => void
}) {
  const [animate] = useState(() => replay && !replayed.has(run.id))
  const [replayShown, setShown] = useState(animate ? 0 : run.steps.length)
  // A live run is what the backend recorded: all its steps, and more of them when the poll finds them.
  const shown = run.live ? run.steps.length : replayShown
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!animate) return
    replayed.add(run.id)
    timer.current = window.setInterval(() => setShown((n) => {
      if (n >= run.steps.length) { window.clearInterval(timer.current); return n }
      return n + 1
    }), 380)
    return () => window.clearInterval(timer.current)
  }, [animate, run.id, run.steps.length])
  const running = !run.live && shown < run.steps.length
  const retriedStep = run.steps.find((s) => s.state === 'retried' || (s.state !== 'failed' && (s.attempts ?? 1) > 1))
  const failedStep = run.steps.find((s) => s.state === 'failed')

  return (
    <details id={`run-${runKey(run)}`} className={cx('wf-run', fresh && 'wf-fresh', run.failed && 'wf-run--failed')} open={open} onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)} data-run={runKey(run)} data-run-status={run.live?.status}>
      <summary>
        <Icon name="chevronRight" size={12} />
        <span className="mono wf-run-id">{run.id}</span>
        {run.runNo && run.runNo > 1 && <span className="wf-run-no" data-run-no>run {run.runNo}</span>}
        <Tag tone={TYPE_TONE[run.type]}>{run.type}</Tag>
        <span className="wf-run-name">{run.name}</span>
        <span className="grow" />
        {retriedStep && <Tag tone="caution" title={`Temporal ran “${retriedStep.label}” ${retriedStep.attempts} times`}>Retried · {retriedStep.attempts} attempts</Tag>}
        {failedStep && <Tag tone="critical">{failedStep.attempts} attempts</Tag>}
        {run.live ? <LiveRunTag status={run.live.status} /> : running ? <Tag tone="info">Running · step {shown + 1} of {run.steps.length}</Tag> : run.failed ? <Tag tone="critical">Failed after retries</Tag> : <Tag tone="positive">Completed</Tag>}
        <span className="muted nowrap">{dayTime(run.at)} · took {run.took}</span>
      </summary>
      <div className="wf-run-body">
        <p className="sub">Started by {run.startedBy} · workflow ID <span className="mono">{run.id}</span>{run.live && <> · run <span className="mono">{run.live.runId}</span></>}</p>
        {run.live?.rerunOfKey && (
          <p className="wf-runlink" data-rerun-of>
            Run {run.runNo} of this workflow id: ops started it again after <button type="button" className="lv-link" onClick={() => onOpenRun(run.live!.rerunOfKey!)}>run {(run.runNo ?? 2) - 1}</button> failed. Same id, so still one workflow per event.
          </p>
        )}
        {run.live?.rerunKey && (
          <p className="wf-runlink" data-rerun-next>
            Ops started this workflow id again: <button type="button" className="lv-link" onClick={() => onOpenRun(run.live!.rerunKey!)}>run {(run.runNo ?? 1) + 1}</button>.
          </p>
        )}
        <ol className="wf-run-steps">
          {run.steps.map((s, i) => <RunStepView key={s.label} step={s} n={i + 1} pending={i >= shown} active={i === shown} />)}
        </ol>
        {run.live?.error && <p className="wf-error" data-run-error>Error: {run.live.error}</p>}
        {run.failed && opsTask && (
          <div className="wf-ops" data-ops-task>
            <span className="wf-label">Ops task</span>
            <span className="strong">{opsTask.action}</span>
            <span className="sub">{opsTask.why} · due {fmtDate(opsTask.dueOn)} · waiting on {opsTask.waitingOn}</span>
          </div>
        )}
        {run.live?.canRerun && claimId && <RerunAction claimId={claimId} run={run} />}
        {run.live?.status === 'running' && run.steps.length === 0 && <p className="sub">Running. The steps are recorded when the run finishes.</p>}
        {!running && run.temporal && (
          <div className="wf-temporal">
            <span className="wf-label">What Temporal did</span>
            <p>{run.temporal}</p>
          </div>
        )}
        {!running && run.saved.length > 0 && (
          <div className="wf-saved">
            <span className="wf-label">Saved to Postgres in one transaction</span>
            <ul>{run.saved.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  )
}

/** Live: a failed run that is the latest of its workflow id can be started again (POST /workflow-runs/{id}:rerun), the ops action. */
function RerunAction({ claimId, run }: { claimId: string; run: WorkflowRun }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <p className="wf-rerun">
      <button type="button" className="btn btn--sm" data-rerun={run.live!.id} disabled={busy} onClick={() => {
        setBusy(true)
        liveData.rerunWorkflow(claimId, run.live!.id).then((m) => toast(m), (e: Error) => toast(e.message)).finally(() => setBusy(false))
      }}>{busy ? 'Starting…' : 'Re-run this workflow'}</button>
      <span className="sub"> Same workflow id; every letter it sends carries the same key, so nothing goes out twice.</span>
    </p>
  )
}

function LiveRunTag({ status }: { status: NonNullable<WorkflowRun['live']>['status'] }) {
  if (status === 'running') return <Tag tone="info">Running</Tag>
  if (status === 'failed') return <Tag tone="critical">Failed after retries</Tag>
  if (status === 'needs_review') return <Tag tone="caution">Needs a person</Tag>
  if (status === 'skipped') return <Tag tone="neutral">Skipped</Tag>
  return <Tag tone="positive">Completed</Tag>
}

function RunStepView({ step, n, pending, active }: { step: RunStep; n: number; pending: boolean; active: boolean }) {
  const attempts = step.attempts ?? 1
  return (
    <li className={cx('wf-rs', pending && 'wf-rs--pending', active && 'wf-rs--active', !pending && step.state !== 'done' && `wf-rs--${step.state}`)}>
      <span className="wf-rs-mark" aria-hidden="true">
        {pending ? <span className="wf-rs-num">{n}</span> : step.state === 'skipped' ? <ToneShape tone="neutral" /> : step.state === 'retried' ? <ToneShape tone="caution" /> : step.state === 'failed' ? <ToneShape tone="critical" /> : <ToneShape tone="positive" />}
      </span>
      <span className="wf-rs-text">
        <span className="wf-rs-label">
          {step.label}
          {!pending && attempts > 1 && <span className={cx('wf-attempts', step.state === 'failed' && 'wf-attempts--failed')} data-attempts={attempts}>{attempts} attempts{step.state === 'retried' ? ' · retried' : step.state === 'failed' ? ' · gave up' : ''}</span>}
        </span>
        <span className="wf-rs-detail">{pending ? (active ? 'Running…' : 'Waiting') : step.detail}</span>
        {!pending && step.note && <span className="wf-rs-note">{step.note}</span>}
      </span>
      <span className="wf-rs-system">{step.system}</span>
      <span className="sr-only">{pending ? ' (not yet)' : step.state === 'retried' ? ' (retried, then done)' : step.state === 'skipped' ? ' (skipped)' : step.state === 'failed' ? ' (failed after retries)' : ' (done)'}</span>
    </li>
  )
}
