import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { API_BASE, LIVE, LIVE_ZONE } from '../api/live/config'
import { advanceClock, elevenThirty, health, readClock, readDevState, resetClock, type Advance, type ClockState } from '../api/live/demo'
import { boost, bundleFor, startPaymentRun } from '../api/live/data'
import { get } from '../api/live/http'
import { complexGuide, guideWithoutClaim, simpleGuide, type DevState, type Guide, type GuideAction } from '../api/live/guide'
import { isLiveId } from '../api/live/mode'
import { runSentence } from '../api/live/payments'
import { SCENARIO_EVENTS } from '../api/live/scenarios'
import { invalidate } from '../api/store'
import { useQuery } from '../api/useQuery'
import { fmtDate, TODAY } from '../lib/dates'
import { useSession } from '../shell/session'
import { cx } from '../lib/cx'
import { useToast } from './Toasts'
import './DemoControls.css'

const KEY = 'claims.demoOpen'
const DOCK_KEY = 'claims.demoDock'
const SCENARIO_KEY = 'claims.demoScenario'

type Dock = 'bottom' | 'right'
type Scenario = 'simple' | 'complex'

const GROUPS = [...new Set(SCENARIO_EVENTS.map((s) => s.group))]

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return (allowed as readonly string[]).includes(v ?? '') ? (v as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: LIVE_ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

interface NextDeadline { what: string; dueAt: string }

/** The last live claim the presenter had open: the guide keeps following it on pages that are not a claim (My work, Team). */
let lastGuideClaim: string | undefined

const FAULT_LABEL: [RegExp, string][] = [
  [/^letters\.down/, 'Letters service DOWN'],
  [/^bank\.down/, 'Bank DOWN'],
  [/^bank\.reject-next/, 'Bank will return the next payment'],
  [/^tin\.no-match/, 'IRS: next check says no match'],
  [/^tin\.down/, 'IRS DOWN'],
  [/^worker\.stall-once/, 'Worker will stall once'],
]
const faultLabel = (name: string) => FAULT_LABEL.find(([re]) => re.test(name))?.[1] ?? name

/**
 * Live mode only: drives the backend for a demo. It is docked, never floating over the claim: collapsed it is one slim bar at the bottom
 * (a pill with the next hint and the clock), open it is a strip along the bottom or a column on the right, and the page makes room for it.
 *
 * It shows the backend's virtual clock and moves it (to the next deadline, a day, a week, or back), so deadline rows come due and the real
 * dispatcher and workflows react; the fault switches that are on; a guided checklist for the scenario chosen at the top (Simple or Complex),
 * worked out from the backend's own data (api/live/guide.ts) and never stored here; and every scenario event as a button (api/live/scenarios.ts).
 * A backend without the dev endpoints answers 404; the panel then says so.
 */
export function DemoControls() {
  const toast = useToast()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(() => read(KEY, ['0', '1'], '0') === '1')
  const [dock, setDock] = useState<Dock>(() => read(DOCK_KEY, ['bottom', 'right'], 'bottom'))
  const [scenario, setScenario] = useState<Scenario>(() => read(SCENARIO_KEY, ['simple', 'complex'], 'simple'))
  const [clock, setClock] = useState<ClockState | undefined>()
  const [up, setUp] = useState<boolean | undefined>()
  const [next, setNext] = useState<NextDeadline | undefined>()
  const [dev, setDev] = useState<DevState>({ faults: [], returnsQueued: 0 })
  const [busy, setBusy] = useState<string | null>(null)
  const [goDate, setGoDate] = useState('')
  const claimNumber = /^\/claims\/([^/]+)/.exec(pathname)?.[1]
  const intakePage = pathname.startsWith('/intake')
  const { user } = useSession()
  const { data: bundle } = useQuery(async () => {
    if (claimNumber && isLiveId(claimNumber)) lastGuideClaim = claimNumber
    const n = claimNumber ?? (intakePage ? undefined : lastGuideClaim)
    return n && isLiveId(n) ? bundleFor(n).catch(() => undefined) : undefined
  }, [claimNumber, intakePage])

  const refresh = useCallback(async () => {
    const [ok, state] = await Promise.all([health(), readClock().catch(() => undefined)])
    setUp(ok)
    setClock(state)
    if (state?.available) {
      try {
        const [page, d] = await Promise.all([
          get<{ items: { dueAt: string; what: string }[] }>('/deadlines', { query: { state: 'open', limit: 200 } }),
          readDevState(),
        ])
        const after = page.items.filter((x) => Date.parse(x.dueAt) > Date.parse(state.clock.now)).sort((a, b) => a.dueAt.localeCompare(b.dueAt))[0]
        setNext(after)
        setDev((cur) => (cur.returnsQueued === d.returnsQueued && cur.faults.join() === d.faults.join() ? cur : d))
      } catch {
        setNext(undefined)
      }
    } else setNext(undefined)
  }, [])

  useEffect(() => {
    if (!LIVE) return
    const first = window.setTimeout(() => void refresh(), 0)
    const every = window.setInterval(() => void refresh(), 3000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(every)
    }
  }, [refresh])

  // Docked on the right the page gives the panel its width (nothing is covered); docked at the bottom the panel is part of the page's column.
  const sideOn = LIVE && open && dock === 'right'
  useLayoutEffect(() => {
    if (!sideOn) return
    const root = document.documentElement
    root.style.setProperty('--dmc-right', '300px')
    const place = () => root.style.setProperty('--dmc-top', `${Math.round(document.getElementById('main')?.getBoundingClientRect().top ?? 84)}px`)
    place()
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('resize', place)
      root.style.removeProperty('--dmc-right')
      root.style.removeProperty('--dmc-top')
    }
  }, [sideOn])

  if (!LIVE) return null

  const persist = (key: string, value: string) => write(key, value)
  function toggle() {
    const v = !open
    setOpen(v)
    persist(KEY, v ? '1' : '0')
  }
  function pick(s: Scenario) {
    setScenario(s)
    persist(SCENARIO_KEY, s)
  }
  function redock(d: Dock) {
    setDock(d)
    persist(DOCK_KEY, d)
  }

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key)
    try {
      toast(await fn())
      boost()
      invalidate()
      await refresh()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const available = clock?.available === true
  const scenarioCtx = { claimNumber: claimNumber && isLiveId(claimNumber) ? claimNumber : undefined, bundle: claimNumber && isLiveId(claimNumber) ? bundle : undefined }
  const gctx = { today: TODAY, persona: user.id }
  const guide: Guide = scenario === 'complex' ? complexGuide(bundle, gctx, dev) : bundle ? simpleGuide(bundle, gctx) : guideWithoutClaim()
  const actions: GuideAction[] = guide.actions ?? (guide.action ? [guide.action] : [])
  const doneCount = guide.steps.filter((s) => s.done).length
  const clockText = clock?.available ? fmt.format(new Date(clock.clock.now)) : undefined

  const moved = (c: { now: string }) => `Clock moved to ${fmt.format(new Date(c.now))} · the backend reacts on its own`
  const step = (label: string, a: Advance) => (
    <button type="button" className="btn btn--sm" disabled={!available || busy !== null} onClick={() => act(label, async () => moved(await advanceClock(a)))}>{label}</button>
  )

  function renderAction(a: GuideAction, i: number): ReactNode {
    const cls = cx('btn btn--sm', i === 0 && 'btn--primary')
    switch (a.kind) {
      case 'link': return <Link key={`${a.kind}${a.to}`} className={cls} to={a.to}>{a.label}</Link>
      case 'advance':
        return <button key={`adv${a.days}`} type="button" className={cls} data-guide-action disabled={!available || busy !== null} onClick={() => act('guide-advance', async () => moved(await advanceClock({ kind: 'days', days: a.days })))}>{a.label}</button>
      case 'advance-to':
        return <button key={`to${a.iso}`} type="button" className={cls} data-guide-action disabled={!available || busy !== null} onClick={() => act('guide-advance', async () => moved(await advanceClock({ kind: 'toIso', iso: a.iso })))}>{a.label}</button>
      case 'advance-next':
        return <button key="next" type="button" className={cls} data-guide-action disabled={!available || busy !== null} onClick={() => act('guide-next', async () => moved(await advanceClock({ kind: 'nextDeadline' })))}>{a.label}</button>
      case 'payment-run':
        return <button key="run" type="button" className={cls} data-guide-action disabled={!available || busy !== null} onClick={() => act('guide-run', async () => runSentence((await startPaymentRun(TODAY)).run))}>{a.label}</button>
      case 'scenario': {
        const ev = SCENARIO_EVENTS.find((s) => s.key === a.key)
        const why = ev?.unavailable?.(scenarioCtx) ?? (ev ? undefined : 'Unknown event')
        return <button key={a.key + a.label} type="button" className={cls} data-guide-action data-guide-scenario={a.key} title={why ?? ev?.hint} disabled={busy !== null || !!why} onClick={() => ev && act(ev.key, () => ev.run(scenarioCtx))}>{a.label}</button>
      }
    }
  }

  const dot = <span className={cx('dc-dot', up === true ? 'dc-dot--up' : up === false ? 'dc-dot--down' : '')} aria-hidden="true" />
  const scenarioName = scenario === 'complex' ? 'Complex' : 'Simple'
  const progress = `${doneCount}/${guide.steps.length}`

  if (!open) {
    return (
      <aside className="dmc dmc--closed" aria-label="Demo controls" data-demo-controls data-dock="closed">
        <button type="button" className="dc-toggle dmc-pill" aria-expanded={false} onClick={toggle} title={`Open the demo controls. Next: ${guide.next}`}>
          {dot}
          <span className="dmc-name">Demo controls</span>
          <span className="dc-live">live</span>
          <span className="dmc-mode">{scenarioName} {progress}</span>
          <span className="dmc-hint" data-next>{guide.done ? guide.next : <><strong>Next:</strong> {guide.next}</>}</span>
        </button>
        {dev.faults.length > 0 && <span className="dmc-fault" title={dev.faults.join(', ')}>{dev.faults.map(faultLabel).join(' · ')}</span>}
        <span className="dmc-clock" data-clock>{clockText ?? (clock ? 'no demo clock' : '…')}</span>
      </aside>
    )
  }

  return (
    <aside className={cx('dmc dmc--open', `dmc--${dock}`)} aria-label="Demo controls" data-demo-controls data-dock={dock}>
      <div className="dmc-bar">
        <button type="button" className="dc-toggle" aria-expanded onClick={toggle} title={`Collapse to one line. Backend ${up === undefined ? 'checking…' : up ? 'connected' : 'not reachable'} (${API_BASE})`}>
          {dot}
          Demo controls
          <span className="dc-live">live</span>
        </button>
        <div className="dmc-tabs" role="tablist" aria-label="Scenario">
          {(['simple', 'complex'] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={scenario === s} className={cx('dmc-tab', scenario === s && 'dmc-tab--on')} data-scenario-tab={s} onClick={() => pick(s)}>
              {s === 'simple' ? 'Simple' : 'Complex: things bounce back'}
            </button>
          ))}
        </div>
        {up === false && <span className="dmc-chip" role="alert">Backend not reachable</span>}
        <span className="grow" />
        <div className="dmc-dock" role="group" aria-label="Dock the panel">
          <button type="button" className="btn btn--xs btn--quiet" aria-pressed={dock === 'bottom'} onClick={() => redock('bottom')} title="Dock along the bottom">Bottom</button>
          <button type="button" className="btn btn--xs btn--quiet" aria-pressed={dock === 'right'} onClick={() => redock('right')} title="Dock on the right (the page narrows to make room)">Side</button>
          <button type="button" className="btn btn--xs btn--quiet" onClick={toggle} title="Collapse to one line">Collapse</button>
        </div>
      </div>

      <div className="dmc-body">
        <section className="dmc-col dmc-clockcol" aria-label="Backend and clock">
          <div className="dc-row">
            <span className="dc-label">Clock</span>
            {clock?.available ? (
              <span><strong className="dc-now" data-clock>{fmt.format(new Date(clock.clock.now))}</strong> <span className="dc-sub">{clock.clock.virtual ? 'virtual · ticking' : 'real time · not moved yet'}</span></span>
            ) : clock ? (
              <span className="dc-sub" data-demo-disabled>{clock.reason}</span>
            ) : (
              <span className="dc-sub">checking…</span>
            )}
          </div>
          {available && (
            <div className="dc-row">
              <span className="dc-label">Next deadline</span>
              <span className="dc-sub">{next ? `${next.what} · ${fmtDate(next.dueAt.slice(0, 10), { weekday: true })}` : 'none open'}</span>
            </div>
          )}
          <div className="dc-buttons" role="group" aria-label="Move the clock">
            {step('Advance to next deadline', { kind: 'nextDeadline' })}
            {step('+1 day', { kind: 'days', days: 1 })}
            {step('+7 days', { kind: 'days', days: 7 })}
          </div>
          <div className="dc-buttons dmc-goto" role="group" aria-label="Go to a date">
            <label htmlFor="dmc-go-date" className="sr-only">Move the clock to a date (11:30)</label>
            <input id="dmc-go-date" type="date" className="input dmc-date" value={goDate} min={clock?.available ? clock.clock.now.slice(0, 10) : undefined} onChange={(e) => setGoDate(e.target.value)} data-go-date />
            <button type="button" className="btn btn--sm" data-go-to disabled={!available || !goDate || busy !== null} title="Moves the clock forward to 11:30 on that date (the clock never goes back)" onClick={() => act('goto', async () => {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(goDate) || goDate < '2000-01-01' || Number.isNaN(Date.parse(goDate))) throw new Error('Pick a date (a full day, month and year) first')
              const iso = elevenThirty(goDate, LIVE_ZONE)
              if (available && Date.parse(iso) <= Date.parse(clock.clock.now)) throw new Error(`The clock is already past 11:30 on ${fmtDate(goDate, { weekday: true })}; it only moves forward (restart the demo to start again)`)
              return moved(await advanceClock({ kind: 'toIso', iso }))
            })}>Go to date</button>
            <button type="button" className="btn btn--sm btn--quiet" disabled={!available || busy !== null} onClick={() => act('reset', async () => {
              const c = await resetClock()
              return `Clock reset to ${fmt.format(new Date(c.now))}`
            })}>Reset clock</button>
          </div>
          {dev.faults.length > 0 && (
            <div className="dmc-faults" data-faults>
              <span className="dc-label">Switched on</span>
              {dev.faults.map((f) => <span key={f} className="dmc-chip" title={f}>{faultLabel(f)}</span>)}
            </div>
          )}
        </section>

        {/* One wrapper (display: contents) so the hint, its buttons and the checklist are one thing for anyone reading the DOM, and separate grid areas on screen. */}
        <div className="dmc-guide" data-guide>
        <section className="dmc-col dmc-guidecol dc-guide" aria-label={`${scenarioName} scenario`}>
          <span className="dc-label">{scenarioName} scenario <span className="dc-sub" style={{ textTransform: 'none', letterSpacing: 0 }}>· {doneCount} of {guide.steps.length} done</span></span>
          <p className="dc-next" data-next><strong>Next:</strong> {guide.next}</p>
          {actions.length > 0 && <div className="dc-buttons">{actions.map(renderAction)}</div>}
        </section>

        <section className="dmc-col dmc-stepscol" aria-label="Checklist">
          <ol className="dc-steps">
            {guide.steps.map((st) => (
              <li key={st.key} className={cx('dc-step', st.done && 'dc-step--done', st.current && 'dc-step--current')} aria-current={st.current ? 'step' : undefined} data-step={st.key} data-done={st.done ? 'true' : 'false'}>
                <span className="dc-tick" aria-hidden="true">{st.done ? '✓' : st.current ? '→' : '○'}</span>
                <span>{st.label}{st.optional && !st.done ? ' · optional' : ''}{st.note ? <span className="dc-sub"> · {st.note}</span> : null}<span className="sr-only">{st.done ? ' (done)' : st.current ? ' (next)' : ''}</span></span>
              </li>
            ))}
          </ol>
        </section>
        </div>

        <section className="dmc-col dmc-eventscol dc-scenarios" aria-label="Scenario events">
          <details className="dmc-events" data-events>
            <summary className="dc-label">Scenario events · by hand</summary>
            {GROUPS.map((g) => (
              <div key={g} className="dc-group">
                <span className="dc-sub dc-group-name">{g}</span>
                <div className="dc-buttons">
                  {SCENARIO_EVENTS.filter((s) => s.group === g).map((s) => {
                    const why = s.unavailable?.(scenarioCtx)
                    return (
                      <button key={s.key} type="button" className="btn btn--sm" data-scenario={s.key} title={why ?? s.hint} disabled={busy !== null || !!why} onClick={() => act(s.key, () => s.run(scenarioCtx))}>{s.label}</button>
                    )
                  })}
                </div>
              </div>
            ))}
          </details>
        </section>
      </div>
    </aside>
  )
}
