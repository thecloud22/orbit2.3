import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { LIVE } from '../api/live/config'
import { useLivePoll } from '../api/live/poll'
import { listClaims } from '../api/claims'
import {
  applyMoves, approve, assignClaims, examinerName, getWorkload, listApprovals, listAtRisk, listRecent, listUnassigned,
  proposeRebalance, returnWithNote, waitingLabel,
  type Approval, type ExaminerLoad, type Move, type UnassignedClaim,
} from '../api/team'
import type { Claim, User } from '../api/types'
import { fmtCountdown, fmtDate, fmtRelativeDay, fmtTime, plural } from '../lib/dates'
import { fmtMoney, fmtMoneyShort } from '../lib/money'
import { cx } from '../lib/cx'
import { Tag, StatusTag, ToneShape } from '../components/Tag'
import { Icon } from '../components/Icon'
import { Avatar } from '../components/Avatar'
import { Drawer } from '../components/Drawer'
import { Loading } from '../components/Planned'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import './TeamBoard.css'

type View = 'overview' | 'approvals' | 'atRisk' | 'unassigned' | 'ooo' | 'contestable' | 'large' | `examiner:${string}`
type DrawerState = null | { kind: 'return'; approval: Approval } | { kind: 'reassign' } | { kind: 'rebalance' } | { kind: 'assign' }

const VIEW_TITLES: Record<string, string> = {
  overview: 'Life & annuity claims',
  approvals: 'Approvals',
  atRisk: 'At risk of breach',
  unassigned: 'Unassigned claims',
  ooo: 'Out of office',
  contestable: 'Contestable claims',
  large: 'Large claims over $500k',
}

/** Team board (canvas 06.1): the team lead's approvals, workload and risk, in one place. */
export function TeamBoard() {
  const { user } = useSession()
  useLivePoll(undefined, LIVE)
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const view = (params.get('view') ?? 'overview') as View
  const setView = (v: View) => setParams(v === 'overview' ? {} : { view: v }, { replace: true })

  const { data: approvals, loading } = useQuery(() => listApprovals('monica'), [])
  const { data: loads } = useQuery(() => getWorkload(), [])
  const { data: unassigned } = useQuery(() => listUnassigned(), [])
  const { data: atRisk } = useQuery(() => listAtRisk(), [])
  const { data: recent } = useQuery(() => listRecent(), [])
  const { data: allClaims } = useQuery(() => listClaims(), [])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<DrawerState>(null)
  const [busy, setBusy] = useState(false)

  const list = approvals ?? []
  const selected = list.find((a) => a.id === selectedId) ?? list[0]
  const rows = loads ?? []
  const totalOpen = rows.reduce((n, r) => n + r.open, 0)
  const ooo = rows.filter((r) => r.outOfOffice)
  const atRiskCount = rows.reduce((n, r) => n + r.atRisk, 0)
  const dueSoon = rows.reduce((n, r) => n + r.dueSoon, 0)
  const examinerId = view.startsWith('examiner:') ? view.slice(9) : undefined

  async function run(p: Promise<string>, after?: () => void) {
    setBusy(true)
    try {
      toast(await p)
      after?.()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onApprove(a: Approval) {
    const next = list[list.indexOf(a) + 1] ?? list[list.indexOf(a) - 1]
    run(approve(a, user), () => setSelectedId(next?.id ?? null))
  }

  const title = examinerId ? examinerName(examinerId) : VIEW_TITLES[view] ?? VIEW_TITLES.overview

  return (
    <div className="tb">
      <TeamViews
        view={view}
        setView={setView}
        counts={{ approvals: list.length, atRisk: atRiskCount, unassigned: unassigned?.length ?? 0, ooo: ooo.length }}
        rows={rows}
        user={user}
      />

      <main className="tb-main" aria-labelledby="tb-h">
        <div className="tb-head">
          <div className="tb-head-text">
            <div className="tb-title">
              <h1 id="tb-h">{title}</h1>
              {view === 'overview' && <Tag>Sample data</Tag>}
            </div>
            <span className="soft">{rows.length} examiners · {totalOpen} open claims</span>
          </div>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => setDrawer({ kind: 'rebalance' })}>
            <Icon name="split" size={14} />Rebalance workload
          </button>
          <button type="button" className="btn" disabled={!unassigned?.length} onClick={() => setDrawer({ kind: 'assign' })}>
            <Icon name="user" size={14} />Assign unassigned ({unassigned?.length ?? 0})
          </button>
        </div>

        <section aria-label="Team summary" className="tb-kpis">
          <button type="button" className="tb-kpi" onClick={() => setView('approvals')}>
            <span className="tb-kpi-n">{list.length}</span>
            <span className="tb-kpi-l"><ToneShape tone="caution" />Awaiting my approval</span>
          </button>
          <button type="button" className="tb-kpi" onClick={() => setView('atRisk')}>
            <span className="tb-kpi-n">{atRiskCount}</span>
            <span className="tb-kpi-l tb-kpi-l--critical"><ToneShape tone="critical" /><span className="soft">At risk of breach</span></span>
          </button>
          <button type="button" className="tb-kpi" onClick={() => setView('unassigned')}>
            <span className="tb-kpi-n">{unassigned?.length ?? '–'}</span>
            <span className="tb-kpi-l">Unassigned</span>
          </button>
          <div className="tb-kpi">
            <span className="tb-kpi-n">{dueSoon}</span>
            <span className="tb-kpi-l">Due in 2 days</span>
          </div>
          <button type="button" className="tb-kpi tb-kpi--wide" onClick={() => setView('ooo')}>
            <span className="tb-kpi-row"><span className="tb-kpi-n">{ooo.length}</span><span className="tb-kpi-l">Out of office</span></span>
            {ooo.map((r) => (
              <span key={r.id} className="tb-kpi-l ellipsis">
                {r.name}, back {fmtDate(r.outOfOffice!.back)} — {r.open} claims covered
              </span>
            ))}
          </button>
        </section>

        <div className="tb-scroll">
          {(view === 'overview' || view === 'approvals' || examinerId) && (
            <ApprovalsSection
              approvals={examinerId ? list.filter((a) => a.requester.id === examinerId) : list}
              loading={loading && !approvals}
              selected={selected}
              onSelect={(a) => setSelectedId(a.id)}
              recent={examinerId ? [] : recent ?? []}
            />
          )}

          {(view === 'overview' || view === 'ooo' || examinerId) && (
            <WorkloadSection
              rows={examinerId ? rows.filter((r) => r.id === examinerId) : view === 'ooo' ? ooo : rows}
              checked={checked}
              setChecked={setChecked}
              onOpenExaminer={(id) => setView(`examiner:${id}`)}
              onReassign={() => setDrawer({ kind: 'reassign' })}
            />
          )}

          {view === 'ooo' && ooo.map((r) => <OutOfOffice key={r.id} row={r} />)}

          {(view === 'atRisk' || examinerId) && (
            <AtRiskSection items={(atRisk ?? []).filter((x) => !examinerId || x.examinerId === examinerId)} />
          )}

          {view === 'unassigned' && <UnassignedSection items={unassigned ?? []} onAssign={() => setDrawer({ kind: 'assign' })} />}

          {(view === 'contestable' || view === 'large') && <ClaimsSection claims={savedView(view, allClaims ?? [])} />}
        </div>
      </main>

      <ApprovalPanel
        approval={selected}
        index={selected ? list.indexOf(selected) : -1}
        total={list.length}
        user={user}
        busy={busy}
        onApprove={onApprove}
        onReturn={(a) => setDrawer({ kind: 'return', approval: a })}
        recent={recent?.[0]}
      />

      {drawer?.kind === 'return' && (
        <ReturnDrawer
          approval={drawer.approval}
          busy={busy}
          onClose={() => setDrawer(null)}
          onSubmit={(note) => run(returnWithNote(drawer.approval, note, user), () => setDrawer(null))}
        />
      )}
      {drawer?.kind === 'reassign' && (
        <ReassignDrawer
          rows={rows}
          from={rows.filter((r) => checked.has(r.id))}
          onClose={() => setDrawer(null)}
          onApply={(moves, toName) =>
            run(applyMoves(moves, user).then((n) => `Moved ${plural(n, 'claim')} to ${toName}`), () => {
              setDrawer(null)
              setChecked(new Set())
            })
          }
        />
      )}
      {drawer?.kind === 'rebalance' && (
        <RebalanceDrawer
          rows={rows}
          onClose={() => setDrawer(null)}
          onApply={(moves) => run(applyMoves(moves, user).then((n) => `Rebalanced · ${plural(n, 'claim')} moved`), () => setDrawer(null))}
        />
      )}
      {drawer?.kind === 'assign' && (
        <AssignDrawer
          items={unassigned ?? []}
          rows={rows}
          onClose={() => setDrawer(null)}
          onApply={(a) => run(assignClaims(a, user).then((n) => `Assigned ${plural(n, 'new claim')}`), () => setDrawer(null))}
        />
      )}
    </div>
  )
}

function savedView(view: 'contestable' | 'large', claims: Claim[]): Claim[] {
  if (view === 'contestable') {
    return claims.filter((c) => c.sections.includes('contestable') || c.tags.some((t) => /contestable/i.test(t.label)) || c.exceptions.some((x) => /contestable/i.test(x.title)))
  }
  return claims.filter((c) => c.family !== 'disability' && c.benefitLines.reduce((n, b) => n + (b.amount ?? 0), 0) > 500_000)
}

// ---------------------------------------------------------------- Left navigation

/** Team views, examiners with open-claim counts, saved views and the lead's authority. */
function TeamViews({ view, setView, counts, rows, user }: {
  view: View
  setView: (v: View) => void
  counts: { approvals: number; atRisk: number; unassigned: number; ooo: number }
  rows: ExaminerLoad[]
  user: User
}) {
  const item = (v: View, label: string, count?: ReactNode) => (
    <button key={v} type="button" className="tb-view" aria-current={view === v ? 'true' : undefined} onClick={() => setView(v)}>
      <span className="grow ellipsis">{label}</span>
      {count}
    </button>
  )
  const byName = [...rows].sort((a, b) => ['rachel', 'irene', 'leon', 'sofia', 'hannah', 'tom', 'priyanka', 'ben'].indexOf(a.id) - ['rachel', 'irene', 'leon', 'sofia', 'hannah', 'tom', 'priyanka', 'ben'].indexOf(b.id))
  const lead = user.role === 'teamLead' ? user : undefined
  return (
    <nav aria-label="Team views" className="tb-views">
      <div className="tb-group">
        <span className="tb-group-label">Team views</span>
        {item('overview', 'Overview')}
        {item('approvals', 'Approvals', counts.approvals > 0 && <span className="count-badge count-badge--caution">{counts.approvals}</span>)}
        {item('atRisk', 'At risk', counts.atRisk > 0 && <span className="count-badge count-badge--critical">{counts.atRisk}</span>)}
        {item('unassigned', 'Unassigned', <span className="tb-count">{counts.unassigned}</span>)}
        {item('ooo', 'Out of office', <span className="tb-count">{counts.ooo}</span>)}
      </div>
      <div className="tb-group">
        <span className="tb-group-label tb-group-label--split"><span>Examiners</span><span className="tb-group-aside">open claims</span></span>
        {byName.map((r) => item(`examiner:${r.id}`, r.name, <span className="tb-count">{r.open}{r.outOfOffice ? ' · OOO' : ''}</span>))}
      </div>
      <div className="tb-group">
        <span className="tb-group-label">Saved</span>
        {item('contestable', 'Contestable claims')}
        {item('large', 'Large claims over $500k')}
      </div>
      <div className="tb-authority">
        <span className="strong">Your authority</span>
        {lead ? lead.authorityNotes.map((n) => <span key={n}>{n}</span>) : (
          <>
            <span>Viewing Monica Reyes’s team</span>
            <span>Approvals need a team lead</span>
          </>
        )}
      </div>
    </nav>
  )
}

// ---------------------------------------------------------------- Approvals

/** Approvals waiting on the lead, plus what was decided recently. */
function ApprovalsSection({ approvals, loading, selected, onSelect, recent }: {
  approvals: Approval[]
  loading: boolean
  selected?: Approval
  onSelect: (a: Approval) => void
  recent: { id: string; at: string; claimId: string; text: string; detail: string; link?: { label: string; section: string } }[]
}) {
  const oldest = Math.max(0, ...approvals.map((a) => a.waitingHours))
  const oldestText = oldest >= 24 ? plural(Math.floor(oldest / 24), 'day') : oldest > 0 ? `${oldest} h` : 'just now'
  return (
    <section aria-labelledby="tb-ap-h" className="section">
      <div className="tb-section-head">
        <h2 id="tb-ap-h">Approvals</h2>
        <span className="aside">{approvals.length} waiting on you{approvals.length ? ` · oldest ${oldestText}` : ''}</span>
      </div>
      {loading ? (
        <Loading rows={4} />
      ) : approvals.length === 0 ? (
        <div className="empty">Nothing is waiting on your approval.</div>
      ) : (
        <div className="tb-table-wrap">
          <table className="tbl tb-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Claim</th>
                <th scope="col">Requested by</th>
                <th scope="col">Amount or reason</th>
                <th scope="col">Waiting</th>
                <th scope="col" className="r"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((a) => {
                const isSel = selected?.id === a.id
                return (
                  <tr key={a.id} className={cx('tb-row', isSel && 'is-selected')} aria-current={isSel ? 'true' : undefined} onClick={() => onSelect(a)}>
                    <td>
                      <div className="strong nowrap">{a.type}</div>
                      {a.kind !== 'close' && <div className="sub">{a.product}</div>}
                      {a.live && <div className="sub">New · sent from the workbench</div>}
                    </td>
                    <td>
                      <div className="nowrap" style={{ fontWeight: 600 }}>{a.claimName}</div>
                      <div className="sub-mono">{a.claimId}</div>
                    </td>
                    <td className="nowrap">{a.requester.name}</td>
                    <td>
                      {a.kind === 'payout' && a.amount ? (
                        <span className="nowrap"><span style={{ fontWeight: 600 }}>{fmtMoney(a.amount)}</span> {a.limit ? <span className="soft">(limit {fmtMoneyShort(a.limit)})</span> : null}</span>
                      ) : (
                        a.reason
                      )}
                    </td>
                    <td className="nowrap">{waitingLabel(a.waitingHours)}</td>
                    <td className="r">
                      <button type="button" className="btn btn--ghost btn--xs" aria-label={`Review ${a.type}, ${a.claimName}`} onClick={(e) => { e.stopPropagation(); onSelect(a); document.getElementById('tb-detail')?.focus() }}>
                        Review
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {recent.length > 0 && (
        <div className="tb-recent">
          <span className="tb-recent-label">Recently decided:</span>
          <ul>
            {recent.slice(0, 3).map((r) => (
              <li key={r.id}>
                {fmtTime(r.at)} {r.text} <Link to={`/claims/${r.claimId}/overview`} className="mono tb-recent-id">{r.claimId}</Link> {r.detail}
                {r.link && <> — <Link to={`/claims/${r.claimId}/${r.link.section}`} className="tb-recent-link">{r.link.label}</Link></>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** The selected approval: amount, authority, payee, readiness, rationale and the decision buttons. */
function ApprovalPanel({ approval: a, index, total, user, busy, onApprove, onReturn, recent }: {
  approval?: Approval
  index: number
  total: number
  user: User
  busy: boolean
  onApprove: (a: Approval) => void
  onReturn: (a: Approval) => void
  recent?: { at: string; claimId: string; text: string; detail: string }
}) {
  const { openTab } = useSession()
  if (!a) {
    return (
      <aside id="tb-detail" tabIndex={-1} className="tb-detail" aria-label="Selected approval">
        <span className="sub">Approvals</span>
        <h2 className="tb-detail-title">All caught up</h2>
        <p className="soft">Nothing is waiting on your approval. New requests from the decision workbench appear here as soon as they are sent.</p>
        {recent && <p className="sub">Last: {fmtTime(recent.at)} {recent.text} · {recent.claimId} {recent.detail}</p>}
      </aside>
    )
  }
  const passed = a.checks.filter((c) => c.result === 'pass').length
  const allPass = passed === a.checks.length
  const lead = user.role === 'teamLead'
  const overMine = lead && a.kind === 'payout' && !!a.amount && a.amount > user.payoutLimit
  const blocked = !lead
    ? `Only a team lead can decide approvals. You’re signed in as ${user.name}.`
    : overMine
      ? `${fmtMoney(a.amount!)} is above your ${fmtMoneyShort(user.payoutLimit)} authority.`
      : a.kind === 'payout' && !allPass
        ? 'A readiness check has not passed. Return it to the examiner.'
        : undefined
  const primary = a.kind === 'secondReview' ? 'Agree with denial' : a.kind === 'close' ? 'Approve closure' : 'Approve'
  const footnote =
    a.kind === 'payout'
      ? 'Approving adds your approval to the decision record; payment releases automatically.'
      : a.kind === 'secondReview'
        ? 'Agreeing lets the examiner send the letter with appeal rights. Returning keeps it from the claimant.'
        : a.kind === 'close'
          ? 'Approving locks a closure record; the proceeds go on the next unclaimed property report.'
          : 'Approving is logged on the claim and the examiner’s work moves on.'
  return (
    <aside id="tb-detail" tabIndex={-1} className="tb-detail" aria-label="Selected approval">
      <div className="tb-detail-top">
        <span className="sub">Approval {index + 1} of {total} · waiting {waitingLabel(a.waitingHours)}</span>
        <h2 className="tb-detail-title">{a.type}</h2>
        <div className="tb-detail-claim">
          <span className="mono soft" style={{ fontSize: 12 }}>{a.claimId}</span>
          <Link to={`/claims/${a.claimId}/${a.section}`} className="tb-detail-name" onClick={() => openTab(a.claimId)}>{a.claimName}</Link>
          <span className="grow" />
          <Tag>{a.product}</Tag>
        </div>
      </div>

      <section className="well tb-amount" aria-labelledby="tb-am-h">
        <h3 id="tb-am-h">{a.kind === 'payout' ? 'Amount to approve' : a.kind === 'secondReview' ? 'Proposed outcome' : a.kind === 'close' ? 'Proposed closure' : 'Proposed'}</h3>
        <span className={cx('tb-amount-n', a.kind !== 'payout' && 'tb-amount-n--text')}>
          {a.kind === 'payout' && a.amount ? fmtMoney(a.amount) : a.proposed ?? a.reason}
        </span>
        {a.amountNote && <span className="sub soft">{a.amountNote}</span>}
      </section>

      <dl className="dl tb-dl">
        <dt>Examiner</dt>
        <dd>{a.requester.name}{a.requester.limit ? ` · limit ${fmtMoneyShort(a.requester.limit)}` : ''}</dd>
        <dt>{lead ? 'Your authority' : 'Authority'}</dt>
        <dd>
          {a.kind === 'payout'
            ? lead ? `to ${fmtMoneyShort(user.payoutLimit)} · ${overMine ? 'above limit' : 'within limit'}` : 'Team lead · to $2,000,000'
            : a.kind === 'secondReview'
              ? 'Second reviews for the team'
              : 'Team lead approval'}
        </dd>
        {a.kind !== 'payout' && a.reason && (<><dt>Reason</dt><dd>{a.reason}</dd></>)}
        {a.payees.length > 0 && (
          <>
            <dt>Payee</dt>
            <dd className="tb-payee">
              {a.payees.map((p) => <span key={p}>{p}</span>)}
              {a.screening && <span className="tb-clear"><ToneShape tone="positive" />{a.screening}</span>}
            </dd>
          </>
        )}
      </dl>

      {a.checks.length > 0 && (
        <section className="tb-block" aria-labelledby="tb-rd-h">
          <div className="tb-block-head">
            <h3 id="tb-rd-h">Readiness</h3>
            <span className={cx('tb-checks-sum', allPass ? 'is-pass' : 'is-fail')}>{passed} of {a.checks.length} checks pass</span>
          </div>
          <ul className="tb-checks">
            {a.checks.map((c) => (
              <li key={c.label} className={`tb-check tb-check--${c.result}`}>
                <ToneShape tone={c.result === 'pass' ? 'positive' : c.result === 'blocked' ? 'critical' : 'caution'} />
                <span>{c.label}{c.result !== 'pass' && <span className="sr-only"> — {c.result === 'blocked' ? 'blocked' : 'not passed'}</span>}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="tb-block" aria-labelledby="tb-ra-h">
        <div className="tb-block-head">
          <h3 id="tb-ra-h">Examiner’s rationale</h3>
          <span className="sub">{a.requester.name}</span>
        </div>
        <p className="tb-rationale">{a.rationale}</p>
      </section>

      <div className="tb-block tb-actions">
        <div className="tb-actions-row">
          <button type="button" className="btn btn--primary btn--lg" disabled={busy || !!blocked} onClick={() => onApprove(a)}>{primary}</button>
          <button type="button" className="btn btn--lg" disabled={busy || !lead} onClick={() => onReturn(a)}>Return with note</button>
        </div>
        <p className="sub">{blocked ?? footnote}</p>
      </div>
    </aside>
  )
}

/** Asks for the note that goes back to the examiner. */
function ReturnDrawer({ approval: a, busy, onClose, onSubmit }: { approval: Approval; busy: boolean; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState('')
  return (
    <Drawer
      title={`Return to ${a.requester.name}`}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button type="button" className="btn btn--primary" disabled={busy || !note.trim()} onClick={() => onSubmit(note)}>Return with note</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <span className="grow" />
          <span className="sub">Logged on the claim</span>
        </>
      }
    >
      <div className="well tb-return-sum">
        <span className="strong">{a.type}</span>
        <span className="soft">{a.claimName} · <span className="mono">{a.claimId}</span> · {a.kind === 'payout' && a.amount ? fmtMoney(a.amount) : a.reason}</span>
      </div>
      <div className="field">
        <label htmlFor="tb-note">Note to {a.requester.name}</label>
        <textarea id="tb-note" className="textarea" rows={6} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to change before you can approve?" />
      </div>
      <p className="sub">{a.requester.name} gets a work item due today with your note. Nothing is sent to the claimant, and the request leaves your approvals.</p>
    </Drawer>
  )
}

// ---------------------------------------------------------------- Workload

/** Capacity bar and percentage; amber from 90%. */
function Capacity({ row }: { row: ExaminerLoad }) {
  if (row.outOfOffice) return <span className="muted">back {fmtDate(row.outOfOffice.back)}</span>
  const high = row.capacity >= 90
  return (
    <span className="tb-cap">
      <span className="tb-cap-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, row.capacity)}%` }} className={high ? 'is-high' : undefined} /></span>
      <span className={high ? 'tb-cap-high' : undefined}>{row.capacity}%</span>
    </span>
  )
}

/** Examiners by capacity, with selection for reassigning. */
function WorkloadSection({ rows, checked, setChecked, onOpenExaminer, onReassign }: {
  rows: ExaminerLoad[]
  checked: Set<string>
  setChecked: (s: Set<string>) => void
  onOpenExaminer: (id: string) => void
  onReassign: () => void
}) {
  const toggle = (id: string) => {
    const n = new Set(checked)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setChecked(n)
  }
  const selectable = rows.filter((r) => !r.outOfOffice)
  const shownChecked = rows.filter((r) => checked.has(r.id))
  return (
    <section aria-labelledby="tb-wl-h" className="section">
      <div className="tb-section-head">
        <h2 id="tb-wl-h">Workload</h2>
        <span className="aside">{plural(rows.length, 'examiner')} · sorted by capacity</span>
        <span className="grow" />
        {shownChecked.length > 0 ? (
          <span className="tb-selbar">
            {shownChecked.length} selected
            <button type="button" className="btn btn--sm btn--primary" onClick={onReassign}>Reassign claims</button>
            <button type="button" className="btn btn--sm btn--quiet" onClick={() => setChecked(new Set())}>Clear</button>
          </span>
        ) : (
          <span className="aside">Select rows to reassign or rebalance</span>
        )}
      </div>
      <div className="tb-table-wrap">
        <table className="tbl tbl--middle tb-table tb-wl">
          <thead>
            <tr>
              <th scope="col" className="tb-cb">
                <input
                  type="checkbox"
                  aria-label="Select all examiners"
                  checked={selectable.length > 0 && selectable.every((r) => checked.has(r.id))}
                  onChange={(e) => setChecked(e.target.checked ? new Set(selectable.map((r) => r.id)) : new Set())}
                />
              </th>
              <th scope="col">Examiner</th>
              <th scope="col" className="r">Open</th>
              <th scope="col" className="r">Due ≤2d</th>
              <th scope="col">At risk</th>
              <th scope="col" className="r">Ready to decide</th>
              <th scope="col" className="r">Oldest item</th>
              <th scope="col">Capacity</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={cx('tb-wl-row', checked.has(r.id) && 'is-checked')}>
                <td className="tb-cb">
                  <input type="checkbox" aria-label={`Select ${r.name}`} checked={checked.has(r.id)} disabled={!!r.outOfOffice} onChange={() => toggle(r.id)} />
                </td>
                <td className="nowrap">
                  <button type="button" className="tb-person" onClick={() => onOpenExaminer(r.id)}>
                    <Avatar initials={r.initials} />
                    <span>{r.name}</span>
                  </button>
                </td>
                <td className="r">{r.open}</td>
                <td className="r">{r.dueSoon}</td>
                <td>{r.atRisk > 0 ? <span className="tb-risk"><ToneShape tone="critical" size={10} />{r.atRisk}</span> : <span className="muted">—</span>}</td>
                <td className="r">{r.ready}</td>
                <td className="r nowrap">{plural(r.oldestDays, 'day')}</td>
                <td className="nowrap"><Capacity row={r} /></td>
                <td><StatusTag status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Out-of-office note: who is away, until when, and who covers. */
function OutOfOffice({ row }: { row: ExaminerLoad }) {
  return (
    <section className="well tb-ooo" aria-label={`${row.name} out of office`}>
      <div className="tb-ooo-head"><Avatar initials={row.initials} size={26} /><span className="strong">{row.name}</span><Tag tone="neutral">Out of office — covered</Tag></div>
      <p>Back {fmtDate(row.outOfOffice!.back, { weekday: true })}. {row.open} open claims are covered by {examinerName(row.outOfOffice!.coveredBy)}; nothing is due before the return and the oldest item is {plural(row.oldestDays, 'day')} old.</p>
    </section>
  )
}

/** Claims whose clocks are close to breach, across the team. */
function AtRiskSection({ items }: { items: Awaited<ReturnType<typeof listAtRisk>> }) {
  const { openTab } = useSession()
  return (
    <section aria-labelledby="tb-ar-h" className="section">
      <div className="tb-section-head">
        <h2 id="tb-ar-h">At risk of breach</h2>
        <span className="aside">{plural(items.length, 'item')} · a clock is due within 2 days</span>
      </div>
      {items.length === 0 ? (
        <div className="empty">No claims are at risk.</div>
      ) : (
        <div className="tb-table-wrap">
          <table className="tbl tb-table">
            <thead>
              <tr><th scope="col">Next action · why</th><th scope="col">Claim</th><th scope="col">Examiner</th><th scope="col">Due</th></tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.openable ? <Link to={`/claims/${x.claimId}/${x.section}`} className="strong" onClick={() => openTab(x.claimId)}>{x.action}</Link> : <span className="strong">{x.action}</span>}
                    <div className="sub">{x.why}</div>
                  </td>
                  <td><div style={{ fontWeight: 600 }}>{x.name}</div><div className="sub-mono">{x.claimId}</div></td>
                  <td className="nowrap">{examinerName(x.examinerId)}</td>
                  <td className="nowrap"><div>{fmtRelativeDay(x.due)}</div><div className="sub tb-late"><ToneShape tone="critical" size={8} />{fmtCountdown(x.due)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** New claims no one owns yet. */
function UnassignedSection({ items, onAssign }: { items: UnassignedClaim[]; onAssign: () => void }) {
  return (
    <section aria-labelledby="tb-un-h" className="section">
      <div className="tb-section-head">
        <h2 id="tb-un-h">Unassigned</h2>
        <span className="aside">{plural(items.length, 'new claim')} · oldest first</span>
        <span className="grow" />
        {items.length > 0 && <button type="button" className="btn btn--sm btn--primary" onClick={onAssign}>Assign all</button>}
      </div>
      {items.length === 0 ? (
        <div className="empty">Every claim has an owner.</div>
      ) : (
        <div className="tb-table-wrap">
          <table className="tbl tbl--middle tb-table">
            <thead><tr><th scope="col">Claim</th><th scope="col">Product</th><th scope="col" className="r">Amount</th><th scope="col">Received</th><th scope="col">Suggested by routing rules</th></tr></thead>
            <tbody>
              {[...items].sort((a, b) => a.received.localeCompare(b.received)).map((u) => (
                <tr key={u.id}>
                  <td><div style={{ fontWeight: 600 }}>{u.name}</div><div className="sub-mono">{u.claimId}</div></td>
                  <td>{u.product}</td>
                  <td className="r">{fmtMoneyShort(u.amount)}</td>
                  <td>{fmtRelativeDay(u.received)}</td>
                  <td>{examinerName(u.suggested)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** A saved view: a plain list of claims across the team. */
function ClaimsSection({ claims }: { claims: Claim[] }) {
  const { openTab } = useSession()
  const navigate = useNavigate()
  return (
    <section aria-labelledby="tb-cl-h" className="section">
      <div className="tb-section-head">
        <h2 id="tb-cl-h">Claims</h2>
        <span className="aside">{plural(claims.length, 'claim')} in this mock</span>
      </div>
      {claims.length === 0 ? (
        <div className="empty">No claims match.</div>
      ) : (
        <div className="tb-table-wrap">
          <table className="tbl tb-table">
            <thead><tr><th scope="col">Claim</th><th scope="col">Product</th><th scope="col">Examiner</th><th scope="col" className="r">Amount</th><th scope="col">Status</th><th scope="col">Next step</th></tr></thead>
            <tbody>
              {claims.map((c) => {
                const amount = c.benefitLines.reduce((n, b) => n + (b.amount ?? 0), 0)
                return (
                  <tr key={c.id} className="tb-row" onClick={() => { openTab(c.id); navigate(`/claims/${c.id}/overview`) }}>
                    <td><Link to={`/claims/${c.id}/overview`} className="strong" onClick={(e) => { e.stopPropagation(); openTab(c.id) }}>{c.name}</Link><div className="sub-mono">{c.id}</div></td>
                    <td>{c.product}</td>
                    <td className="nowrap">{examinerName(c.ownerId)}</td>
                    <td className="r">{amount ? fmtMoneyShort(amount) : '—'}</td>
                    <td><StatusTag status={c.benefitLines[0].status} /></td>
                    <td className="sub">{c.nextStep.label}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- Drawers

/** Pick where the selected examiners' claims go, and how many. */
function ReassignDrawer({ rows, from, onClose, onApply }: { rows: ExaminerLoad[]; from: ExaminerLoad[]; onClose: () => void; onApply: (moves: Move[], toName: string) => void }) {
  const targets = rows
    .filter((r) => !r.outOfOffice && !from.some((f) => f.id === r.id) && from.every((f) => f.lines.some((l) => r.lines.includes(l))))
    .sort((a, b) => a.capacity - b.capacity)
  const [to, setTo] = useState(targets[0]?.id ?? '')
  const [counts, setCounts] = useState<Record<string, number>>(() => Object.fromEntries(from.map((f) => [f.id, Math.min(5, f.open)])))
  const moves = from.map((f) => ({ from: f.id, to, count: counts[f.id] ?? 0 })).filter((m) => m.count > 0)
  const total = moves.reduce((n, m) => n + m.count, 0)
  const target = rows.find((r) => r.id === to)
  return (
    <Drawer
      title="Reassign claims"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn btn--primary" disabled={!to || total === 0} onClick={() => onApply(moves, target?.name ?? '')}>
            Move {plural(total, 'claim')}{target ? ` to ${target.name}` : ''}
          </button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="soft">The newest unstarted claims move first. Claims with a clock due in the next 5 days stay with their examiner.</p>
      <div className="section">
        <h3 className="tb-drawer-h">From</h3>
        {from.map((f) => (
          <div key={f.id} className="tb-move-row">
            <Avatar initials={f.initials} />
            <span className="grow"><span className="strong">{f.name}</span> <span className="sub">{f.open} open · {f.capacity}%</span></span>
            <label className="sub" htmlFor={`tb-n-${f.id}`}>Claims to move</label>
            <input
              id={`tb-n-${f.id}`}
              className="input tb-num"
              type="number"
              min={0}
              max={f.open}
              value={counts[f.id] ?? 0}
              onChange={(e) => setCounts((c) => ({ ...c, [f.id]: Math.max(0, Math.min(f.open, Number(e.target.value) || 0)) }))}
            />
          </div>
        ))}
      </div>
      <fieldset className="section tb-fieldset">
        <legend className="tb-drawer-h">To</legend>
        {targets.length === 0 && <div className="empty">No one available shares these examiners’ product lines.</div>}
        {targets.map((r) => (
          <label key={r.id} className={cx('tb-pick', to === r.id && 'is-picked')}>
            <input type="radio" name="tb-to" value={r.id} checked={to === r.id} onChange={() => setTo(r.id)} />
            <Avatar initials={r.initials} />
            <span className="grow"><span className="strong">{r.name}</span> <span className="sub">{r.lines.map((l) => (l === 'life' ? 'Life' : 'Annuities')).join(', ')}</span></span>
            <span className="sub">{r.open} open</span>
            <Capacity row={r} />
          </label>
        ))}
      </fieldset>
    </Drawer>
  )
}

/** Rules-based rebalance proposal, applied only when the lead confirms. */
function RebalanceDrawer({ rows, onClose, onApply }: { rows: ExaminerLoad[]; onClose: () => void; onApply: (moves: Move[]) => void }) {
  const moves = useMemo(() => proposeRebalance(rows), [rows])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const after = (id: string) => {
    const r = byId.get(id)!
    const delta = moves.reduce((n, m) => n + (m.to === id ? m.count : m.from === id ? -m.count : 0), 0)
    return Math.round(((r.open + delta) / r.open) * r.capacity)
  }
  const total = moves.reduce((n, m) => n + m.count, 0)
  return (
    <Drawer
      title="Rebalance workload"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn--primary" disabled={total === 0} onClick={() => onApply(moves)}>Move {plural(total, 'claim')}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="soft">
        Examiners over 100% give claims down to 95%; examiners on the same product lines take them up to 95%. Newest unstarted claims move first and nothing with a clock due in 5 days moves. This is a routing rule, not an assistant suggestion.
      </p>
      {moves.length === 0 ? (
        <div className="empty">Everyone is within capacity. Nothing to move.</div>
      ) : (
        <table className="tbl tbl--middle">
          <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col" className="r">Claims</th><th scope="col" className="r">Capacity after</th></tr></thead>
          <tbody>
            {moves.map((m) => (
              <tr key={`${m.from}-${m.to}`}>
                <td className="nowrap">{byId.get(m.from)?.name}</td>
                <td className="nowrap">{byId.get(m.to)?.name}</td>
                <td className="r">{m.count}</td>
                <td className="r nowrap">{byId.get(m.from)?.capacity}% → {after(m.from)}% · {byId.get(m.to)?.capacity}% → {after(m.to)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Drawer>
  )
}

/** Assign each new claim to an examiner; routing rules pre-fill a suggestion. */
function AssignDrawer({ items, rows, onClose, onApply }: { items: UnassignedClaim[]; rows: ExaminerLoad[]; onClose: () => void; onApply: (a: { id: string; to: string }[]) => void }) {
  const [picks, setPicks] = useState<Record<string, string>>(() => Object.fromEntries(items.map((u) => [u.id, u.suggested])))
  const available = rows.filter((r) => !r.outOfOffice)
  return (
    <Drawer
      title={`Assign unassigned (${items.length})`}
      onClose={onClose}
      width={600}
      footer={
        <>
          <button type="button" className="btn btn--primary" onClick={() => onApply(items.map((u) => ({ id: u.id, to: picks[u.id] })))}>Assign {plural(items.length, 'claim')}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </>
      }
    >
      <p className="soft">Suggestions come from the routing rules: product line first, then the lowest capacity. Change any before assigning.</p>
      <table className="tbl tbl--middle">
        <thead><tr><th scope="col">Claim</th><th scope="col" className="r">Amount</th><th scope="col">Examiner</th></tr></thead>
        <tbody>
          {items.map((u) => (
            <tr key={u.id}>
              <td><div style={{ fontWeight: 600 }}>{u.name}</div><div className="sub">{u.product} · <span className="mono">{u.claimId}</span></div></td>
              <td className="r">{fmtMoneyShort(u.amount)}</td>
              <td>
                <select className="select" aria-label={`Examiner for ${u.name}`} value={picks[u.id]} onChange={(e) => setPicks((p) => ({ ...p, [u.id]: e.target.value }))}>
                  {available.filter((r) => r.lines.includes(u.family)).map((r) => (
                    <option key={r.id} value={r.id}>{r.name} · {r.capacity}%</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Drawer>
  )
}
