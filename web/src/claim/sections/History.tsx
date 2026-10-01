import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HistoryEvent, HistoryType, SectionKey } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import { listHistory, logEvent } from '../../api/history'
import { historyHold, listRecordsAsOf, type RecordAsItStood } from '../../api/replay'
import { addDays, daysFrom, fmtDate, fmtTime, TODAY } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Avatar } from '../../components/Avatar'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './History.css'

type Filter = 'all' | HistoryType

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['decision', 'Decisions'],
  ['data', 'Data changes'],
  ['document', 'Documents'],
  ['communication', 'Communications'],
  ['task', 'Tasks'],
  ['access', 'Access'],
  ['assistant', 'Assistant'],
  ['payment', 'Payments'],
]

const TYPE_WORD: Record<HistoryType, string> = {
  decision: 'Decision', data: 'Data change', document: 'Document', communication: 'Communication',
  task: 'Task', access: 'Access', assistant: 'Assistant', payment: 'Payment',
}

/** Where a ref chip leads: by its label first, then by the event type. */
const REF_SECTION: Record<string, SectionKey[]> = {
  'Case plan': ['case-plan'], Restrictions: ['medical'], Medical: ['medical'], Referral: ['medical'], Requirements: ['requirements'],
  Reconsideration: ['decision'], 'Application Q4': ['contestable'], 'Pharmacy history': ['contestable', 'medical', 'documents'],
  'APS · 22 Sep': ['documents'], '2025 tax return': ['financials', 'documents'], Export: [],
}
const TYPE_SECTION: Partial<Record<HistoryType, SectionKey>> = {
  decision: 'decision', document: 'documents', communication: 'communications', payment: 'payments',
}

/** 'yyyy-mm-ddT23:59' marks a replay to the end of a day rather than to an exact event. */
const endOfDay = (day: string) => `${day}T23:59`

function fmtStamp(at: string): string {
  if (at.endsWith('T23:59')) return `the end of ${fmtDate(at, { year: true })}`
  const t = fmtTime(at)
  return `${fmtDate(at, { year: true })}${t ? `, ${t}` : ''}`
}

/**
 * The claim's append-only audit trail: every decision, data change, document, message, task, access,
 * assistant suggestion and payment, newest first — with a replay that shows the claim as it stood.
 */
export function HistorySection({ claim }: SectionProps) {
  const { user } = useSession()
  const toast = useToast()
  const { data: events } = useQuery(() => listHistory(claim.id), [claim.id])
  const [filter, setFilter] = useState<Filter>('all')
  const [asOf, setAsOf] = useState<string | undefined>()
  const [openId, setOpenId] = useState<string | undefined>()
  const { data: records } = useQuery(() => listRecordsAsOf(claim.id, asOf), [claim.id, asOf])
  const hold = historyHold(claim.id)

  const all = useMemo(() => events ?? [], [events])
  const visible = useMemo(() => (asOf ? all.filter((e) => e.at <= asOf) : all), [all, asOf])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: visible.length }
    visible.forEach((e) => (c[e.type] = (c[e.type] ?? 0) + 1))
    return c
  }, [visible])
  const shown = filter === 'all' ? visible : visible.filter((e) => e.type === filter)
  const first = all.length ? all[all.length - 1].at.slice(0, 10) : TODAY

  // Ticks mark decisions: one per day, at the last decision event that day.
  const ticks = useMemo(() => {
    const byDay = new Map<string, string>()
    all.filter((e) => e.type === 'decision').forEach((e) => {
      const day = e.at.slice(0, 10)
      if (!byDay.has(day) || byDay.get(day)! < e.at) byDay.set(day, e.at)
    })
    return [...byDay.values()].sort()
  }, [all])

  const later = asOf ? all.filter((e) => e.at > asOf && (e.type === 'decision' || e.ref === 'Complaint')).reverse() : []

  function exportFile() {
    logEvent(claim.id, { type: 'access', title: 'Claim file exported — Bates-numbered, redaction applied', actor: `${user.name} · ${user.title}`, ref: 'Export' })
    toast('Bates-numbered export queued')
  }

  return (
    <div className="hi">
      <div className="page-head">
        <h2>History</h2>
        <span className="aside">
          Append-only record of this claim{events && all.length > 0 ? ` · ${all.length} ${all.length === 1 ? 'event' : 'events'} since ${fmtDate(first)}` : ''}
        </span>
        <span className="grow" />
        {!claim.live && <span className="aside hi-hide-narrow">Bates-numbered, redaction applied</span>}
        {!claim.live && (
          <button type="button" className="btn btn--sm" onClick={exportFile}>
            <Icon name="upload" size={13} />Export claim file
          </button>
        )}
      </div>

      {hold && (
        <div className="hi-hold" role="note">
          <Tag tone="special">Litigation hold</Tag>
          <span className="soft">{hold}</span>
        </div>
      )}

      {!events ? (
        <Loading rows={8} />
      ) : all.length === 0 ? (
        <div className="empty">{claim.live ? 'The backend has recorded no events for this claim yet.' : 'No events recorded for this claim in the mock yet. Actions taken on it from now on are logged here.'}</div>
      ) : (
        <>
          <Replay start={first} ticks={ticks} asOf={asOf} onChange={(a) => { setAsOf(a); setOpenId(undefined) }} />

          <div className="hi-filters" role="group" aria-label="Filter events by type">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className="chip-filter" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
                <span className="count">{counts[key] ?? 0}</span>
              </button>
            ))}
            <span className="grow" />
            <span className="sub nowrap">Newest first</span>
          </div>

          <div className={cx('hi-body', asOf && 'hi-body--replay')}>
            <section className="hi-list" aria-label="Events">
              {filter === 'access' && (
                <p className="hi-access-note">
                  <Icon name="lock" size={13} />
                  Who opened this claim’s medical, financial or personal data, and in what role. Kept for regulators and audits.
                </p>
              )}
              {shown.length === 0 ? (
                <div className="empty">
                  {all.length === 0 ? 'No events recorded for this claim in the mock yet.' : `No ${filter === 'all' ? '' : FILTERS.find((f) => f[0] === filter)![1].toLowerCase() + ' '}events${asOf ? ' as of this date' : ''}.`}
                </div>
              ) : (
                <EventList
                  events={shown}
                  claimSections={claim.sections}
                  claimId={claim.id}
                  openId={openId}
                  onToggle={(id) => setOpenId((cur) => (cur === id ? undefined : id))}
                  asOf={asOf}
                />
              )}
            </section>

            <aside className="hi-side" aria-label={asOf ? `Decision record as it stood on ${fmtStamp(asOf)}` : 'Decision records'}>
              <RecordPanel items={records} asOf={asOf} later={later} onToday={() => setAsOf(undefined)} />
            </aside>
          </div>
        </>
      )}
    </div>
  )
}

/** The replay slider: drag to any day, or jump to a decision tick. Later events are hidden while replaying. */
function Replay({ start, ticks, asOf, onChange }: { start: string; ticks: string[]; asOf?: string; onChange: (asOf?: string) => void }) {
  const total = Math.max(1, daysFrom(start, TODAY))
  const value = asOf ? Math.min(total, Math.max(0, daysFrom(start, asOf))) : total
  const pct = (d: number) => (d / total) * 100

  function onSlide(v: number) {
    if (v >= total) return onChange(undefined)
    const day = addDays(start, v)
    onChange(ticks.find((t) => t.startsWith(day)) ?? endOfDay(day))
  }

  // Measure the track so labels can be staggered or pulled in when they would collide.
  const trackRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const lastRight = [-Infinity, -Infinity]
  const placed = ticks
    .filter((t) => t.slice(0, 10) >= start)
    .map((t) => {
      const p = pct(daysFrom(start, t))
      const label = fmtDate(t)
      const w = label.length * 7 + 8
      const x = (p / 100) * width
      const align: 'center' | 'left' | 'right' = x - w / 2 < 0 ? 'left' : x + w / 2 > width ? 'right' : 'center'
      const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2
      const row = left < lastRight[0] + 6 ? 1 : 0
      lastRight[row] = left + w
      return { at: t, p, row, align, label }
    })

  return (
    <div className={cx('hi-replay', asOf && 'hi-replay--on')}>
      <label htmlFor="hi-range" className="hi-replay-label">Replay as of</label>
      <div className="hi-track-wrap">
        <button type="button" className="hi-end" onClick={() => onChange(endOfDay(start))}>{fmtDate(start)}</button>
        <div className="hi-track" ref={trackRef}>
          <input
            id="hi-range"
            type="range"
            className="hi-range"
            min={0}
            max={total}
            step={1}
            value={value}
            style={{ ['--pct' as string]: `${pct(value)}%` }}
            aria-valuetext={asOf ? `As of ${fmtStamp(asOf)}` : 'Today'}
            onChange={(e) => onSlide(Number(e.target.value))}
          />
          {placed.map((t) => (
            <span key={t.at} aria-hidden="true" className="hi-tick" style={{ left: `${t.p}%` }} />
          ))}
          {placed.map((t) => (
            <button
              key={`l-${t.at}`}
              type="button"
              className={cx('hi-tick-label', `hi-tick-label--${t.align}`, asOf === t.at && 'is-on', t.row === 1 && 'is-low')}
              style={{ left: `${t.p}%` }}
              onClick={() => onChange(t.at)}
              aria-label={`Replay as of the decision on ${fmtStamp(t.at)}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className={cx('hi-end', !asOf && 'is-on')} onClick={() => onChange(undefined)}>Today</button>
      </div>
      <div className="hi-replay-state" aria-live="polite">
        {asOf ? (
          <>
            <div>
              <div className="strong">Showing the claim as it stood on {fmtStamp(asOf)}</div>
              <div className="sub">Ticks mark decisions · later events are hidden</div>
            </div>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(undefined)}>Back to today</button>
          </>
        ) : (
          <div className="sub">Drag, or pick a tick, to see the claim as it stood on that date. Ticks mark decisions.</div>
        )}
      </div>
    </div>
  )
}

function groupByDay(events: HistoryEvent[]): [string, HistoryEvent[]][] {
  const groups = new Map<string, HistoryEvent[]>()
  events.forEach((e) => {
    const day = e.at.slice(0, 10)
    groups.set(day, [...(groups.get(day) ?? []), e])
  })
  return [...groups.entries()]
}

/** Events grouped by day. Rows expand to show the full entry; the ref chip opens the related section. */
function EventList({ events, claimId, claimSections, openId, onToggle, asOf }: {
  events: HistoryEvent[]
  claimId: string
  claimSections: SectionKey[]
  openId?: string
  onToggle: (id: string) => void
  asOf?: string
}) {
  const navigate = useNavigate()
  return (
    <div className="hi-days">
      {groupByDay(events).map(([day, list]) => (
        <section key={day} aria-label={fmtDate(day, { year: true })}>
          <h3 className="hi-day">{fmtDate(day, { year: true })}</h3>
          <ul>
            {list.map((e) => {
              const [who, ...rest] = e.actor.split(' · ')
              const open = openId === e.id
              const candidates = (e.ref && REF_SECTION[e.ref]) || [TYPE_SECTION[e.type]]
              const target = candidates.find((k): k is SectionKey => !!k && claimSections.includes(k))
              const canOpen = !!target
              return (
                <li key={e.id} className={cx('hi-ev', open && 'is-open', asOf === e.at && e.type === 'decision' && 'is-asof')}>
                  <button type="button" className="hi-ev-main" aria-expanded={open} onClick={() => onToggle(e.id)}>
                    <span className="hi-time mono">{fmtTime(e.at) || '—'}</span>
                    <ActorMark actor={who} />
                    <span className="hi-ev-text">
                      <span className="hi-ev-title">{e.title}</span>
                      <span className="hi-ev-actor">
                        <strong>{who}</strong>
                        {rest.length > 0 && ` · ${rest.join(' · ')}`}
                      </span>
                    </span>
                  </button>
                  {e.ref && (canOpen ? (
                    <button type="button" className="source hi-ref" onClick={() => navigate(`/claims/${claimId}/${target}`)} title={`Open ${target!.replace('-', ' ')}`}>
                      {e.ref}
                    </button>
                  ) : (
                    <span className="source hi-ref hi-ref--static">{e.ref}</span>
                  ))}
                  {open && (
                    <div className="hi-ev-detail">
                      {e.detail && <p>{e.detail}</p>}
                      <dl className="hi-ev-meta">
                        <div><dt>Type</dt><dd>{TYPE_WORD[e.type]}</dd></div>
                        <div><dt>Recorded</dt><dd>{fmtStamp(e.at)}</dd></div>
                        <div><dt>By</dt><dd>{e.actor}</dd></div>
                        <div><dt>Entry</dt><dd className="mono">{e.id}</dd></div>
                      </dl>
                      <p className="sub">Append-only: this entry can’t be edited or deleted. A correction is a new entry that refers to it.</p>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Gear() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" strokeLinecap="round" />
    </svg>
  )
}

/** Who acted: initials for people, a mark for the system, the assistant, intake and outside reviewers. */
function ActorMark({ actor }: { actor: string }) {
  if (/^(System|Payments|Legal|Policy administration|Pharmacy data|State Department)/.test(actor))
    return <span className="hi-mark" aria-hidden="true"><Gear /></span>
  if (actor.startsWith('Assistant'))
    return <span className="hi-mark hi-mark--assistant" aria-hidden="true"><Icon name="sparkle" size={11} /></span>
  if (actor.startsWith('Document'))
    return <span className="hi-mark" aria-hidden="true"><Icon name="document" size={11} /></span>
  if (actor.startsWith('External'))
    return <span className="hi-mark" aria-hidden="true"><Icon name="user" size={11} /></span>
  const words = actor.split(',')[0].split(' ').filter((w) => w && w !== 'Dr.')
  const initials = (words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')
  return <Avatar initials={initials.toUpperCase()} />
}

/** 'Decision recorded — BOE closed at maximum (v2)' → 'BOE closed at maximum (v2)'; otherwise the part before the dash. */
function laterLabel(title: string): string {
  const t = title.startsWith('Decision recorded — ') ? title.slice('Decision recorded — '.length) : title.split(' — ')[0]
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * The decision record as it stood: locked outcome, the evidence with its fingerprints, the rules and
 * guidelines in force, reviews and what the assistant did. Rendered in the double-ruled record treatment.
 */
function RecordPanel({ items, asOf, later, onToday }: { items?: RecordAsItStood[]; asOf?: string; later: HistoryEvent[]; onToday: () => void }) {
  const [pick, setPick] = useState(0)
  if (!items) return <Loading rows={5} />
  if (items.length === 0)
    return (
      <div className="empty hi-norecord">
        {asOf ? <>No decision had been recorded on this claim by {fmtStamp(asOf)}.</> : <>No decision recorded on this claim yet.</>}
      </div>
    )
  const cur = items[Math.min(pick, items.length - 1)]
  const d = cur.record
  return (
    <div className="hi-rec-wrap">
      {items.length > 1 && (
        <div className="segmented hi-rec-pick" role="group" aria-label="Benefit line">
          {items.map((it, i) => (
            <button key={it.record.id} type="button" aria-pressed={it === cur} onClick={() => setPick(i)}>
              {it.record.title.split(' ').slice(0, 3).join(' ')}
            </button>
          ))}
        </div>
      )}
      <section className="record hi-rec" aria-label={`Decision record: ${d.title}, version ${d.version}`}>
        <div className="hi-rec-head">
          <Icon name="decision" size={18} color="var(--ink)" />
          <div>
            <h3>
              Decision · {d.title} <span className="record-meta">v{d.version} · recorded {fmtDate(d.recordedAt, { year: true })}, {fmtTime(d.recordedAt)} · locked</span>
            </h3>
            <div className="record-meta" style={{ color: 'var(--ink-2)' }}>{d.recordedBy} · {d.authorityNote}</div>
          </div>
        </div>
        <dl className="hi-rec-grid">
          <dt>Outcome</dt>
          <dd className="strong">{d.outcomeText}</dd>
          <dt>Evidence as it stood</dt>
          <dd>
            <ul className="hi-evidence">
              {cur.evidence.map((ev) => (
                <li key={ev.label}>
                  <span className="hi-ev-link">{ev.label}</span>
                  <span className="mono sub nowrap">sha {ev.hash}</span>
                  <span className="sub nowrap">{ev.date ? fmtDate(ev.date) : '—'}</span>
                </li>
              ))}
            </ul>
          </dd>
          <dt>Rules &amp; guidelines in force</dt>
          <dd>
            <ul className="hi-rules">
              {cur.rules.map(([k, v]) => <li key={k}><span className="muted">{k} </span>{v}</li>)}
            </ul>
          </dd>
          <dt>Reviews</dt>
          <dd>{cur.reviews.join('; ')}</dd>
          <dt>Assistant involvement</dt>
          <dd>{cur.assistant}</dd>
          {d.letter && (
            <>
              <dt>Letter</dt>
              <dd>{d.letter}</dd>
            </>
          )}
        </dl>
        {later.length > 0 && (
          <div className="hi-later">
            <span className="strong">Later:</span>
            <button type="button" className="btn btn--ghost btn--xs hi-later-link" onClick={onToday}>
              {later.map((e) => `${laterLabel(e.title)} ${fmtDate(e.at)}`).join('; ')}
              <Icon name="arrowRight" size={12} />
            </button>
          </div>
        )}
      </section>
      <p className="sub">A recorded decision never changes. A correction creates v{d.version + 1} with a reason; v{d.version} stays readable here.</p>
    </div>
  )
}
