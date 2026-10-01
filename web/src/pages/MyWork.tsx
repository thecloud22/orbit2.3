import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { getQueue, snoozeWork } from '../api/work'
import { listClaims, sectionLabel } from '../api/claims'
import { LIVE } from '../api/live/config'
import { samplesShown, setSamplesShown } from '../api/live/mode'
import { useLivePoll } from '../api/live/poll'
import { completeQueueItem } from '../api/live/data'
import { invalidate } from '../api/store'
import type { Claim, WorkItem, WorkView } from '../api/types'
import { daysUntil, fmtCountdown, fmtRelativeDay } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { cx } from '../lib/cx'
import { Tag, StatusTag, ToneShape } from '../components/Tag'
import { Icon } from '../components/Icon'
import { Loading } from '../components/Planned'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import './MyWork.css'

const VIEWS: { key: 'all' | WorkView; label: string }[] = [
  { key: 'all', label: 'All work' },
  { key: 'dueToday', label: 'Due today' },
  { key: 'atRisk', label: 'At risk' },
  { key: 'readyToDecide', label: 'Ready to decide' },
  { key: 'newDocuments', label: 'New documents' },
  { key: 'statusLetters', label: 'Status letters due' },
  { key: 'waiting', label: 'Waiting on others' },
]

const PRIORITY_TONE = { 1: 'critical', 2: 'info', 3: 'neutral' } as const

function openLabel(section: string) {
  switch (section) {
    case 'decision': return 'Open decision workbench'
    case 'requirements': return 'Open requirements'
    case 'documents': return 'Review document'
    case 'communications': return 'Open communications'
    case 'payments': return 'Open payments'
    default: return 'Open claim'
  }
}

export function MyWork() {
  const { user, openTab, density, setDensity } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: queue, loading } = useQuery(() => getQueue(user.id), [user.id])
  const { data: allClaims } = useQuery(() => listClaims(), [])
  useLivePoll(undefined, LIVE)
  const [view, setView] = useState<'all' | WorkView>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const claimById = useMemo(() => new Map((allClaims ?? []).map((c) => [c.id, c])), [allClaims])
  const items = useMemo(() => (queue ?? []).filter((w) => view === 'all' || w.views.includes(view)), [queue, view])
  const selected = items.find((w) => w.id === selectedId) ?? items[0]
  const count = (v: 'all' | WorkView) => (queue ?? []).filter((w) => v === 'all' || w.views.includes(v)).length
  const ownClaims = (allClaims ?? []).filter((c) => c.ownerId === user.id).length
  const liveClaims = (allClaims ?? []).filter((c) => c.live)

  function open(w: WorkItem) {
    openTab(w.claimId)
    navigate(`/claims/${w.claimId}/${w.section}`)
  }

  // Keyboard: J/K move, Enter opens, X selects, N starts the top item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [role=dialog]') || e.metaKey || e.ctrlKey || e.altKey) return
      const i = selected ? items.indexOf(selected) : -1
      if (e.key === 'j' && i < items.length - 1) setSelectedId(items[i + 1].id)
      else if (e.key === 'k' && i > 0) setSelectedId(items[i - 1].id)
      else if (e.key === 'Enter' && selected && !t.closest('button, a')) open(selected)
      else if (e.key === 'x' && selected) toggle(selected.id)
      else if (e.key === 'n' && items[0]) open(items[0])
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function toggle(id: string) {
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  return (
    <div className={cx('mw', density === 'compact' && 'mw--compact')}>
      <nav aria-label="Views" className="mw-views">
        <div className="mw-group">
          <span className="mw-group-label">Work items</span>
          {VIEWS.map((v) => (
            <button key={v.key} type="button" aria-current={view === v.key ? 'true' : undefined} className="mw-view" onClick={() => setView(v.key)}>
              <span className="grow">{v.label}</span>
              {v.key === 'atRisk' && count(v.key) > 0 ? (
                <span className="count-badge count-badge--critical">{count(v.key)}</span>
              ) : (
                <span className="mw-count">{count(v.key)}</span>
              )}
            </button>
          ))}
        </div>
        <div className="mw-group">
          <span className="mw-group-label">Caseload</span>
          <span className="mw-view mw-view--static"><span className="grow">My open claims</span><span className="mw-count">{ownClaims}</span></span>
          <span className="mw-view mw-view--static"><span className="grow">Diary</span><span className="mw-count">14 days</span></span>
        </div>
        <div className="mw-authority">
          <span className="strong">Your authority</span>
          {user.authorityNotes.map((n) => <span key={n}>{n}</span>)}
        </div>
      </nav>

      <main className="mw-main" aria-labelledby="mw-h">
        <div className="mw-head">
          <div style={{ minWidth: 0 }}>
            <h1 id="mw-h">My work</h1>
            <span className="soft nowrap">
              {queue?.length ?? '–'} items · {ownClaims} open claims · ordered by clock risk, then impact
            </span>
          </div>
          <span className="grow" />
          <div className="segmented" role="group" aria-label="Density">
            <button type="button" aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>Comfortable</button>
            <button type="button" aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>Compact</button>
          </div>
          <button type="button" className="btn btn--primary" disabled={!items[0]} onClick={() => items[0] && open(items[0])}>
            Start next <span className="kbd">N</span>
          </button>
        </div>

        <div className="mw-filters">
          {(['all', 'atRisk', 'dueToday', 'readyToDecide'] as const).map((k) => (
            <button key={k} type="button" className="chip-filter" aria-pressed={view === k} onClick={() => setView(k)}>
              {k === 'atRisk' && <ToneShape tone="critical" size={9} />}
              {VIEWS.find((v) => v.key === k)!.label} <span className="count">{count(k)}</span>
            </button>
          ))}
          <span className="grow" />
          {checked.size > 0 && (
            <span className="soft" style={{ fontSize: 12 }}>
              {checked.size} selected ·{' '}
              <button type="button" className="btn btn--ghost btn--xs" onClick={() => { const ids = [...checked].filter((id) => !(queue ?? []).find((q) => q.id === id)?.live); ids.forEach((id) => snoozeWork(id)); toast(ids.length < checked.size ? `${ids.length} sample items snoozed until Monday · live items can’t be snoozed yet` : `${checked.size} items snoozed until Monday`); setChecked(new Set()) }}>Snooze</button>
            </span>
          )}
        </div>

        {LIVE && (
          <section className="mw-live" aria-labelledby="mw-live-h">
            <div className="mw-live-head">
              <h2 id="mw-live-h">Live claims <span className="mw-live-tag">from the backend</span></h2>
              <span className="grow" />
              <label className="mw-samples">
                <input type="checkbox" checked={samplesShown()} onChange={(e) => { setSamplesShown(e.target.checked); invalidate() }} />
                Show sample claims (mock)
              </label>
            </div>
            {liveClaims.length === 0 ? (
              <p className="soft">No claims on the backend yet. Take a notice of death: <Link to="/intake/life">New life claim</Link>.</p>
            ) : (
              <ul className="mw-live-list">
                {liveClaims.map((c) => (
                  <li key={c.id}>
                    <Link to={`/claims/${c.id}/workflow`} className="mono" onClick={() => openTab(c.id)}>{c.id}</Link>
                    <span className="strong">{c.name}</span>
                    <span className="soft">{c.nextStep.reason}</span>
                    {c.tags.filter((t) => t.label !== 'Live').map((t) => <StatusTag key={t.label} status={t} />)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <div className="mw-table-wrap">
          {loading && !queue ? (
            <Loading rows={6} />
          ) : items.length === 0 ? (
            <div className="empty">Nothing here. {view !== 'all' && <button type="button" className="btn btn--ghost btn--xs" onClick={() => setView('all')}>Show all work</button>}</div>
          ) : (
            <table className="tbl mw-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}><input type="checkbox" aria-label="Select all work items" checked={checked.size === items.length} onChange={(e) => setChecked(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} /></th>
                  <th style={{ width: 30 }}><span aria-label="Priority">P</span></th>
                  <th>Next action · why</th>
                  <th style={{ width: 170 }}>Claim</th>
                  <th style={{ width: 90 }}>Due</th>
                  <th style={{ width: 96 }}>Flags</th>
                  <th style={{ width: 110 }}>Waiting on</th>
                </tr>
              </thead>
              <tbody>
                {items.map((w) => {
                  const c = claimById.get(w.claimId)
                  const isSel = selected?.id === w.id
                  const late = daysUntil(w.due) <= 2 && w.priority === 1
                  return (
                    <tr key={w.id} className={cx('mw-row', isSel && 'is-selected')} onClick={() => setSelectedId(w.id)} onDoubleClick={() => open(w)} aria-selected={isSel}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select: ${w.action}, ${c?.name ?? w.claimId}`} checked={checked.has(w.id)} onChange={() => toggle(w.id)} /></td>
                      <td><span className={`mw-prio mw-prio--${PRIORITY_TONE[w.priority]}`}>{w.priority}</span></td>
                      <td>
                        <Link to={`/claims/${w.claimId}/${w.section}`} className="mw-action ellipsis" onClick={() => openTab(w.claimId)}>{w.action}</Link>
                        <div className="mw-why ellipsis">{w.why}</div>
                      </td>
                      <td>
                        <div className="strong ellipsis" style={{ fontWeight: 600 }}>{c?.name ?? '—'}</div>
                        <div className="sub-mono">{w.claimId}{LIVE && (w.live ? ' · live' : ' · sample')}</div>
                      </td>
                      <td>
                        <div>{fmtRelativeDay(w.due)}</div>
                        <div className={cx('sub', late && 'mw-late')}>
                          {late && <ToneShape tone="critical" size={8} />} {w.dueNote ?? fmtCountdown(w.due)}
                        </div>
                      </td>
                      <td>{w.flag ? <StatusTag status={w.flag} /> : <span className="muted">—</span>}</td>
                      <td className={w.waitingOn === 'You' ? 'strong' : undefined}>{w.waitingOn}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="mw-keys">
          <span>Showing {items.length} of {queue?.length ?? 0}</span>
          <span className="grow" />
          <span><span className="kbd">J</span> <span className="kbd">K</span> move</span>
          <span><span className="kbd">Enter</span> open</span>
          <span><span className="kbd">X</span> select</span>
          <span><span className="kbd">N</span> start next</span>
          <span><span className="kbd">⌘K</span> search</span>
        </div>
      </main>

      {selected && <Preview w={selected} claim={claimById.get(selected.claimId)} index={items.indexOf(selected)} total={items.length} onOpen={() => open(selected)} />}
    </div>
  )
}

function Preview({ w, claim, index, total, onOpen }: { w: WorkItem; claim?: Claim; index: number; total: number; onOpen: () => void }) {
  const { openTab } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  if (!claim) return <aside className="mw-preview" />
  const openEx = claim.exceptions.filter((x) => x.status === 'open')
  const line = claim.benefitLines[0]
  const total$ = claim.benefitLines.reduce((a, b) => a + (b.amount ?? 0), 0)
  return (
    <aside className="mw-preview" aria-label="Preview of selected work item">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="sub">Selected · {index + 1} of {total}</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h2 style={{ fontSize: 18 }}>{claim.name}</h2>
          <span className="mono soft" style={{ fontSize: 12 }}>{claim.id}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Tag>{claim.product}</Tag>
          {line && <StatusTag status={line.status} />}
          {claim.tags.map((t) => <StatusTag key={t.label} status={t} />)}
        </div>
      </div>

      <section className="well" aria-labelledby="why-h" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h3 id="why-h" style={{ fontSize: 13 }}>Why this is next</h3>
        <p style={{ lineHeight: 1.5 }}>{w.whyNext ?? w.why}</p>
      </section>

      <dl className="dl" style={{ gridTemplateColumns: '96px minmax(0,1fr)' }}>
        {claim.facts.slice(0, 2).map((f, i) => (
          <div key={f} style={{ display: 'contents' }}>
            <dt>{i === 0 ? (claim.family === 'disability' ? 'Claimant' : 'Insured') : 'Coverage'}</dt>
            <dd>{f}</dd>
          </div>
        ))}
        {total$ > 0 && (<><dt>{claim.family === 'disability' ? 'Benefit' : 'Amount'}</dt><dd>{fmtMoney(total$)}{claim.family === 'disability' ? ' / month' : ''}</dd></>)}
        <dt>Due</dt><dd>{fmtRelativeDay(w.due)} · {fmtCountdown(w.due)}</dd>
        <dt>Waiting on</dt><dd>{w.waitingOn}</dd>
      </dl>

      {openEx.length > 0 && (
        <section className="mw-preview-ex" aria-label="Exceptions">
          <div className="strong" style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--caution-ink)' }}><ToneShape tone="caution" />{openEx.length} exception{openEx.length > 1 ? 's' : ''}</div>
          {openEx.map((x) => <div key={x.id}><strong>{x.title}</strong> <span className="soft">— {x.meta}</span></div>)}
        </section>
      )}

      <div className="mw-preview-actions">
        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={onOpen}>
          {openLabel(w.section)}
          <Icon name="arrowRight" size={12} />
        </button>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8 }}>
          <button type="button" className="btn" onClick={() => { openTab(claim.id); navigate(`/claims/${claim.id}`) }}>Open claim</button>
          <button type="button" className="btn" disabled={w.live} title={w.live ? 'The backend has no snooze yet' : undefined} onClick={() => { snoozeWork(w.id); toast('Snoozed until Monday') }}>Snooze</button>
        </div>
        {w.live && /welcome call/i.test(w.action) && (
          <button type="button" className="btn btn--block" data-log-welcome-call onClick={() => completeQueueItem(w.id).then((m) => toast(m), (e: Error) => toast(e.message))}>Log the welcome call</button>
        )}
        <span className="sub">Opens {sectionLabel(claim, w.section)} on the claim.</span>
      </div>
    </aside>
  )
}
