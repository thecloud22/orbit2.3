import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Claim } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import {
  WAIVE_REASONS, addRequirement, getRequirementContext, isOpen, listRequirements, logCallOutcome, markReceived,
  runAlternative, sendReminder, sendReminders, waiveRequirement,
  type PlanStep, type RequirementContext, type RequirementRecord,
} from '../../api/requirements'
import { listDocuments, type DocumentRecord } from '../../api/documents'
import { decideSuggestion } from '../../api/claims'
import { addCommunication } from '../../api/communications'
import { TODAY, addDays, daysSince, daysUntil, fmtCountdown, fmtDate, plural } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Drawer } from '../../components/Drawer'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag, Tag, ToneShape } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import { useWidth } from '../../lib/useWidth'
import type { SectionProps } from './types'
import './Requirements.css'

/** Side-by-side detail needs room for the seven-column table beside it. */
const WIDE = 1040

type DrawerKind = 'call' | 'waive' | 'add' | 'script' | 'letter'

/** The claim's requirements: who has the ball, the table, and a detail panel with the follow-up plan. */
export function RequirementsSection({ claim, target }: SectionProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useSession()
  const { data: reqs, loading } = useQuery(() => listRequirements(claim.id), [claim.id])
  const { data: ctx } = useQuery(() => getRequirementContext(claim.id), [claim.id])
  const { data: docs } = useQuery(() => listDocuments(claim.id), [claim.id])
  const [ref, width] = useWidth<HTMLDivElement>()
  const wide = width >= WIDE
  const [closed, setClosed] = useState(false)
  const [drawer, setDrawer] = useState<{ kind: DrawerKind; reqId?: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const list = useMemo(() => reqs ?? [], [reqs])
  const fallback = list.find((r) => r.state === 'overdue') ?? list.find((r) => r.nextAction) ?? list.find(isOpen)
  const selected = list.find((r) => r.id === target) ?? (closed || target ? undefined : fallback)

  useEffect(() => {
    if (target) setClosed(false)
  }, [target])

  useEffect(() => {
    if (!selected) return
    document.getElementById(`rq-row-${selected.id}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function select(id: string) {
    if (selected?.id === id) return close()
    navigate(`/claims/${claim.id}/requirements/${id}`, { replace: true })
  }
  function close() {
    setClosed(true)
    if (target) navigate(`/claims/${claim.id}/requirements`, { replace: true })
  }

  const open = list.filter(isOpen)
  const remindable = open.filter((r) => r.state === 'open' && !r.followUps.some((f) => f.endsWith(fmtDate(TODAY))))

  async function remindAll() {
    setBusy(true)
    try {
      const n = await sendReminders(remindable.map((r) => r.id), user.name)
      toast(`${plural(n, 'reminder')} sent · logged to history`)
    } finally {
      setBusy(false)
    }
  }

  const drawerReq = drawer?.reqId ? list.find((r) => r.id === drawer.reqId) : undefined

  return (
    <div ref={ref} className="rq">
      <div className="page-head rq-head">
        <h2>Requirements</h2>
        {reqs && <span className="aside">{summaryLine(list)}</span>}
        <div className="rq-head-actions">
          {!claim.live && remindable.length > 0 && (
            <button type="button" className="btn btn--sm" onClick={remindAll} disabled={busy}>
              <Icon name="send" size={13} />Send reminders ({remindable.length})
            </button>
          )}
          {!claim.live && (
            <button type="button" className="btn btn--sm" onClick={() => setDrawer({ kind: 'add' })}>
              <Icon name="plus" size={13} />Add requirement
            </button>
          )}
        </div>
      </div>

      {loading && !reqs && <Loading rows={6} />}

      {claim.live && (
        <div className="callout-info rq-live-note">
          <Icon name="flow" size={14} color="var(--accent)" />
          <span className="grow">Read from the backend. Reminders go out by themselves when a follow-up row comes due (see Workflow &amp; SLA); accepting or waiving here closes that requirement’s follow-up rows, and the last one moves the claim to In review. A document that arrives (Documents) is decided by a workflow: <em>Not enough</em> (the IRS check said no match) keeps the requirement open with a correction follow-up; <em>Under review</em> is with the examiner.</span>
        </div>
      )}

      {reqs && (
        <>
          <WaitingOn reqs={open} ctx={ctx ?? undefined} onPick={select} />

          {list.length === 0 ? (
            <div className="empty">No requirements on this claim yet. Add the first one to start the follow-up plan.</div>
          ) : (
            <div className={cx('rq-layout', wide && selected && 'rq-layout--split')}>
              <RequirementTable
                claim={claim}
                reqs={list}
                selectedId={selected?.id}
                onSelect={select}
                expanded={!wide && selected ? (
                  <RequirementDetail claim={claim} r={selected} docs={docs ?? []} inline onClose={close} onDrawer={(kind) => setDrawer({ kind, reqId: selected.id })} />
                ) : null}
              />
              {wide && selected && (
                <RequirementDetail claim={claim} r={selected} docs={docs ?? []} onClose={close} onDrawer={(kind) => setDrawer({ kind, reqId: selected.id })} />
              )}
            </div>
          )}

          {!claim.live && <StatusLetter claim={claim} open={open} ctx={ctx ?? undefined} onPreview={() => setDrawer({ kind: 'letter' })} />}
        </>
      )}

      {drawer?.kind === 'call' && drawerReq && <CallDrawer r={drawerReq} onClose={() => setDrawer(null)} />}
      {drawer?.kind === 'waive' && drawerReq && <WaiveDrawer r={drawerReq} onClose={() => setDrawer(null)} />}
      {drawer?.kind === 'script' && drawerReq && <ScriptDrawer r={drawerReq} onClose={() => setDrawer(null)} onLog={() => setDrawer({ kind: 'call', reqId: drawerReq.id })} />}
      {drawer?.kind === 'add' && <AddDrawer claim={claim} onClose={() => setDrawer(null)} onAdded={(id) => navigate(`/claims/${claim.id}/requirements/${id}`, { replace: true })} />}
      {drawer?.kind === 'letter' && <LetterDrawer claim={claim} open={open} ctx={ctx ?? undefined} onClose={() => setDrawer(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------- summary & waiting on

function summaryLine(reqs: RequirementRecord[]): string {
  const met = reqs.filter((r) => !isOpen(r)).length
  const parts = [`${met} of ${reqs.length} met`]
  const overdue = reqs.filter((r) => r.state === 'overdue').length
  if (overdue) parts.push(`${overdue} overdue`)
  const byLabel = new Map<string, number>()
  reqs.filter((r) => r.state === 'open').forEach((r) => byLabel.set(r.status.label, (byLabel.get(r.status.label) ?? 0) + 1))
  byLabel.forEach((n, label) => parts.push(`${n} ${/^\d/.test(label) ? `on ${label}` : label.toLowerCase()}`))
  const inProgress = reqs.filter((r) => r.state === 'inProgress').length
  if (inProgress) parts.push(`${inProgress} in progress`)
  return parts.join(' · ')
}

/** Who has the ball, and for how long — one chip per party we are waiting on. */
function WaitingOn({ reqs, ctx, onPick }: { reqs: RequirementRecord[]; ctx?: RequirementContext; onPick: (id: string) => void }) {
  const groups = new Map<string, RequirementRecord[]>()
  reqs.forEach((r) => {
    const k = r.waitingOn ?? r.from
    groups.set(k, [...(groups.get(k) ?? []), r])
  })
  return (
    <div className="rq-waiting">
      <div className="rq-waiting-row">
        <span className="rq-waiting-label">Waiting on</span>
        {groups.size === 0 && <Tag tone="positive">Nobody — everything is in</Tag>}
        {[...groups.entries()].map(([who, rs]) => {
          const eta = rs.find((r) => r.state === 'inProgress' && r.due && r.dueNote?.includes('ETA'))
          const since = rs.map((r) => r.requested).filter(Boolean).sort()[0]
          const text = eta ? `ETA ${fmtDate(eta.due!)}` : since ? plural(daysSince(since), 'day') : 'not yet requested'
          return (
            <button key={who} type="button" className="rq-wait" onClick={() => onPick(rs[0].id)} title={rs.map((r) => r.name).join(', ')}>
              <ToneShape tone="neutral" />
              <span>{who} · {text}</span>
            </button>
          )
        })}
      </div>
      {ctx && (
        <div className="rq-context">
          {ctx.initials ? <span className="rq-initials" aria-hidden="true">{ctx.initials}</span> : <Icon name="help" size={14} color="var(--ink-3)" />}
          <span>{ctx.text}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- table

function lineLabel(claim: Claim, id?: string): string | undefined {
  if (!id || claim.benefitLines.length < 2) return undefined
  return claim.benefitLines.find((b) => b.id === id)?.name
}

function DueCell({ r }: { r: RequirementRecord }) {
  if (!r.due) return <span className="muted">—</span>
  const late = isOpen(r) && daysUntil(r.due) < 0
  return (
    <>
      <div>{fmtDate(r.due)}</div>
      {isOpen(r) && (
        late ? (
          <div className="rq-late"><ToneShape tone="critical" size={8} />{fmtCountdown(r.due)}</div>
        ) : (
          <div className="sub">{r.dueNote ?? fmtCountdown(r.due)}</div>
        )
      )}
    </>
  )
}

/** Requirement · For · From · Status · Requested · Follow-ups · Due. On narrow widths the detail opens under its row. */
function RequirementTable({ claim, reqs, selectedId, onSelect, expanded }: {
  claim: Claim
  reqs: RequirementRecord[]
  selectedId?: string
  onSelect: (id: string) => void
  expanded: ReactNode
}) {
  return (
    <div className="rq-table-wrap">
      <table className="tbl rq-table">
        <thead>
          <tr>
            <th>Requirement</th>
            <th className="rq-c-for">For</th>
            <th>From</th>
            <th>Status</th>
            <th className="rq-c-req">Requested</th>
            <th>Follow-ups</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          {reqs.map((r) => {
            const on = r.id === selectedId
            const line = lineLabel(claim, r.benefitLineId)
            return (
              <Fragment key={r.id}>
                <tr id={`rq-row-${r.id}`} className={cx('rq-row', on && 'is-selected')} onClick={() => onSelect(r.id)}>
                  <td>
                    <button type="button" className="rq-name" aria-expanded={on} onClick={(e) => { e.stopPropagation(); onSelect(r.id) }}>
                      {r.name}
                    </button>
                    {r.note && <div className="sub">{r.note}</div>}
                    <div className="sub rq-for-inline">{r.purpose}{line ? ` · ${line}` : ''}</div>
                  </td>
                  <td className="rq-c-for">
                    <div>{r.purpose}</div>
                    {line && <div className="sub">{line}</div>}
                  </td>
                  <td>
                    <div>{r.from}</div>
                    {r.fromDetail && <div className="sub">{r.fromDetail}</div>}
                  </td>
                  <td><StatusTag status={r.status} /></td>
                  <td className="rq-c-req">
                    {r.requested ? <div>{fmtDate(r.requested)}</div> : <div>{r.requestedVia === 'Automatic' ? 'Automatic' : '—'}</div>}
                    {r.requested && r.requestedVia && isOpen(r) && r.followUps.length > 1 && <div className="sub">{r.requestedVia}</div>}
                  </td>
                  <td>
                    {r.followUps.length ? (
                      <>
                        <div>{r.followUps.length}</div>
                        <div className="sub">{r.followUps.join(', ')}</div>
                      </>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td><DueCell r={r} /></td>
                </tr>
                {on && expanded && (
                  <tr className="rq-expand">
                    <td colSpan={7}>{expanded}</td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------- detail

function PlanMark({ state }: { state: PlanStep['state'] }) {
  if (state === 'done')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="#45494F" /><path d="M4 7.2 6.1 9.2 10 5" fill="none" stroke="#FFFFFF" strokeWidth="1.6" /></svg>
  if (state === 'current')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#1F4E8C" strokeWidth="2" /><circle cx="7" cy="7" r="2.5" fill="#1F4E8C" /></svg>
  if (state === 'skipped')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#A3A098" strokeWidth="1.2" strokeDasharray="2 2" /></svg>
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#A3A098" strokeWidth="1.5" /></svg>
}

const STEP_SR: Record<PlanStep['state'], string> = { done: 'done', current: 'today', todo: 'scheduled', skipped: 'no longer needed' }

/** The selected requirement: who it's from, the follow-up plan, other ways to get it, and the actions. */
function RequirementDetail({ claim, r, docs, inline = false, onClose, onDrawer }: {
  claim: Claim
  r: RequirementRecord
  docs: DocumentRecord[]
  inline?: boolean
  onClose: () => void
  onDrawer: (kind: 'call' | 'waive' | 'script') => void
}) {
  const toast = useToast()
  const { user } = useSession()
  const [busy, setBusy] = useState(false)
  const [receiving, setReceiving] = useState(false)
  const [via, setVia] = useState('fax')
  const openNow = isOpen(r)
  const current = r.plan?.find((s) => s.state === 'current' && s.date === TODAY)
  const late = openNow && r.due && daysUntil(r.due) < 0
  const satisfying = docs.filter((d) => d.requirementId === r.id)
  const primaryIsCall = current?.act === 'call' || r.state === 'overdue'

  useEffect(() => {
    setReceiving(false)
  }, [r.id])

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true)
    try {
      const res = await fn()
      toast((res as RequirementRecord | undefined)?.live?.note ?? message)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function doStep(s: PlanStep) {
    if (s.act === 'call') onDrawer('call')
    else if (s.act === 'reminder') void run(() => sendReminder(r.id, user.name), `Reminder sent to ${r.from}`)
    else if (s.act === 'alternative' && s.alt != null) doAlt(s.alt)
  }

  function doAlt(i: number) {
    const a = r.alternatives?.[i]
    if (!a) return
    if (a.kind === 'script') return onDrawer('script')
    setBusy(true)
    runAlternative(r.id, i, user.name)
      .then((m) => toast(m))
      .catch((e: Error) => toast(e.message))
      .finally(() => setBusy(false))
  }

  const statusText = late ? `${r.status.label} · ${plural(-daysUntil(r.due!), 'day')}` : r.status.label

  return (
    <section className={cx('rq-detail', inline && 'rq-detail--inline')} aria-labelledby={`rqd-${r.id}`}>
      <div className="rq-detail-head">
        <h3 id={`rqd-${r.id}`}>{r.name}</h3>
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--xs" aria-label="Close details" onClick={onClose}><Icon name="close" size={13} /></button>
      </div>
      <div className="rq-detail-status">
        <StatusTag status={{ ...r.status, label: statusText }} />
        <span className="sub">
          {!openNow && r.receivedOn ? `Received ${fmtDate(r.receivedOn)}` : r.due ? `Due ${fmtDate(r.due)}` : 'No due date'} · for {r.purpose.toLowerCase()}
        </span>
      </div>

      <div className="rq-detail-body">
        <div className="rq-detail-col">
          <div className="rq-from">
            {(r.contact ?? [[r.from, r.fromDetail].filter(Boolean).join(' · ')]).map((line, i) => (
              <div key={line} className={i === 0 ? undefined : 'soft'}>{line}</div>
            ))}
          </div>

          {r.plan && r.plan.length > 0 && (
            <div className="rq-block">
              <h4>Follow-up plan</h4>
              <ol className="rq-plan">
                {r.plan.map((s, i) => (
                  <li key={`${s.date}-${i}`} className={`rq-step rq-step--${s.state}`}>
                    <PlanMark state={s.state} />
                    <span className="rq-step-date">{s.date === TODAY ? 'Today' : fmtDate(s.date)}</span>
                    <span className="rq-step-text">
                      {s.state === 'current' && s.act && openNow ? (
                        <button type="button" className="rq-steplink" onClick={() => doStep(s)} disabled={busy}>{s.label}</button>
                      ) : (
                        s.label
                      )}
                      {s.note && <span className="muted"> · {s.note}</span>}
                      <span className="sr-only"> ({STEP_SR[s.state]})</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {r.live?.documents && r.live.documents.length > 0 && (
            <div className="rq-block" data-req-docs>
              <h4>Documents that touched it</h4>
              <ul className="rq-docs rq-docs--live">
                {r.live.documents.map((d) => (
                  <li key={d.id} data-req-doc={d.id}>
                    <Icon name="document" size={14} color="var(--ink-3)" />
                    <span className="grow">
                      <Link to={`/claims/${claim.id}/documents/${d.id}`}>{d.title}</Link>
                      <span className="sub"> · {fmtDate(d.at.slice(0, 10))} {d.at.slice(11)} · {d.source}{d.note ? ` · ${d.note}` : ''}</span>
                    </span>
                    <StatusTag status={d.status} />
                    {d.underReview && <Link className="btn btn--primary btn--xs" to={`/claims/${claim.id}/documents/${d.id}`} data-review-link>Review it</Link>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!openNow && (
            <div className="rq-block">
              <h4>{r.state === 'waived' ? 'Waived' : 'Satisfied by'}</h4>
              {r.state === 'waived' && <p className="soft">{r.waiveReason}</p>}
              {r.live?.documents && r.live.documents.length > 0 && r.state !== 'waived' ? (
                <p className="soft">{r.live.satisfiedBy ?? 'Accepted'}{r.receivedOn ? ` · ${fmtDate(r.receivedOn)}` : ''}</p>
              ) : satisfying.length > 0 ? (
                <ul className="rq-docs">
                  {satisfying.map((d) => (
                    <li key={d.id}>
                      <Icon name="document" size={14} color="var(--ink-3)" />
                      <Link to={`/claims/${claim.id}/documents/${d.id}`} className="ellipsis">{d.title}</Link>
                      <span className="sub nowrap">{fmtDate(d.received)} · {d.channel}</span>
                    </li>
                  ))}
                </ul>
              ) : r.state !== 'waived' && (r.live
                ? <p className="soft">{r.live.satisfiedBy ?? 'Accepted'}{r.receivedOn ? ` · ${fmtDate(r.receivedOn)}` : ''} — accepted by hand, so no document is linked.</p>
                : <p className="soft">{r.requestedVia === 'Automatic' ? 'Received from the automatic data feed' : `Marked received${r.receivedOn ? ` on ${fmtDate(r.receivedOn)}` : ''}`} — no document is linked in the mock.</p>)}
            </div>
          )}
        </div>

        {openNow && (
          <div className="rq-detail-col">
            {r.alternatives && r.alternatives.length > 0 && (
              <div className="rq-block">
                <h4>Other ways to get it</h4>
                <ul className="rq-alts">
                  {r.alternatives.map((a, i) => (
                    <li key={a.title}>
                      <div className="grow">
                        <span className="strong">{a.title}</span>
                        {a.note && <span className="muted"> · {a.note}</span>}
                      </div>
                      {a.done ? (
                        <span className="sub nowrap rq-done"><ToneShape tone="positive" size={9} /> {a.done}</span>
                      ) : a.kind === 'approve' && user.role !== 'teamLead' ? (
                        <span className="sub nowrap">with Monica Reyes</span>
                      ) : (
                        <button type="button" className="btn btn--ghost btn--xs" onClick={() => doAlt(i)} disabled={busy}>{a.action}</button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="rq-block">
              <h4>Actions</h4>
              <div className="rq-actions">
                {claim.live ? (
                  <>
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => setReceiving((v) => !v)} aria-expanded={receiving} disabled={busy}>Accept requirement…</button>
                    <button type="button" className="btn btn--sm" onClick={() => onDrawer('waive')} disabled={busy}>Waive…</button>
                  </>
                ) : primaryIsCall ? (
                  <>
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => onDrawer('call')} disabled={busy}><Icon name="phone" size={13} />Log call outcome</button>
                    <button type="button" className="btn btn--sm" onClick={() => run(() => sendReminder(r.id, user.name), `Reminder sent to ${r.from}`)} disabled={busy}><Icon name="send" size={13} />Send reminder</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => run(() => sendReminder(r.id, user.name), `Reminder sent to ${r.from}`)} disabled={busy}><Icon name="send" size={13} />Send reminder</button>
                    <button type="button" className="btn btn--sm" onClick={() => onDrawer('call')} disabled={busy}><Icon name="phone" size={13} />Log call outcome</button>
                  </>
                )}
                {!claim.live && <button type="button" className="btn btn--sm" onClick={() => setReceiving((v) => !v)} aria-expanded={receiving} disabled={busy}>Mark received</button>}
                {!claim.live && <button type="button" className="btn btn--quiet btn--sm" onClick={() => onDrawer('waive')} disabled={busy}>Waive…</button>}
              </div>
              {receiving && (
                <div className="rq-confirm" role="group" aria-label="Mark received">
                  <label htmlFor={`rcv-${r.id}`} className="sub">Received by</label>
                  <select id={`rcv-${r.id}`} className="select" value={via} onChange={(e) => setVia(e.target.value)}>
                    {['fax', 'portal', 'mail', 'email', 'provider portal'].map((v) => <option key={v}>{v}</option>)}
                  </select>
                  <span className="grow sub">{claim.live ? 'Accepts it on the backend. Its follow-up row closes without firing.' : 'Stops follow-ups; the status letter no longer lists it.'}</span>
                  <button type="button" className="btn btn--sm" onClick={() => setReceiving(false)}>Cancel</button>
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => run(() => markReceived(r.id, via, user.name), `${r.name} marked received`)} disabled={busy}>{claim.live ? 'Accept' : 'Confirm'}</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- status letter

function letterDue(claim: Claim, ctx?: RequirementContext): string | undefined {
  return claim.clocks.find((c) => /status letter/i.test(c.label))?.due ?? ctx?.nextLetterDue
}

/** Who the status letter goes to: the claimant, else the beneficiary we are waiting on, else whoever the evidence is from. */
function recipient(claim: Claim, open: RequirementRecord[]): string {
  const living = claim.parties.filter((p) => !p.note?.startsWith('Died'))
  return (
    living.find((p) => p.roles.includes('Claimant'))?.name ??
    living.find((p) => p.roles.includes('Beneficiary') && open.some((r) => r.from === p.name))?.name ??
    living.find((p) => p.roles.includes('Beneficiary'))?.name ??
    open.find((r) => !r.waitingOn?.includes('office'))?.from ??
    'the claimant'
  )
}

/** State rules require a status letter every 30 days while a claim is pending; it lists what is still needed. */
function StatusLetter({ claim, open, ctx, onPreview }: { claim: Claim; open: RequirementRecord[]; ctx?: RequirementContext; onPreview: () => void }) {
  const toast = useToast()
  const { user } = useSession()
  const due = letterDue(claim, ctx)
  const s = claim.suggestions.find((x) => /status letter/i.test(x.title))
  if (!due || open.length === 0) return null
  const n = ctx?.nextLetter
  const drafted = s?.state === 'open'

  async function schedule() {
    if (!s || !due) return
    await decideSuggestion(claim.id, s.id, 'accepted', user.name)
    addCommunication({
      claimId: claim.id,
      channel: 'letter',
      direction: 'out',
      title: `Status letter${n ? ` ${n}` : ''} — scheduled`,
      party: `${recipient(claim, open)} · mail and portal`,
      detail: `Lists what is still needed: ${open.map((r) => r.name).join('; ')}.`,
      status: { label: `Scheduled ${fmtDate(due)}`, tone: 'info' },
      template: 'ST-DI-30',
    })
    toast(`Status letter scheduled for ${fmtDate(due)}`)
  }

  return (
    <section className={cx('rq-letter', drafted && 'proposed')} aria-labelledby="rq-letter-h">
      <div className="rq-letter-head">
        {drafted && <span className="proposed-kicker">Drafted · {s!.category}</span>}
        <h3 id="rq-letter-h">
          Status letter{n ? ` ${n}` : ''} · due {fmtDate(due)} <span className="sub" style={{ fontWeight: 400 }}>({fmtCountdown(due)})</span>
        </h3>
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--xs" onClick={onPreview}>Preview</button>
        {drafted && <button type="button" className="btn btn--ghost btn--xs" onClick={schedule}>Schedule for {fmtDate(due)}</button>}
        {s?.state === 'accepted' && <Tag tone="info">Scheduled {fmtDate(due)}</Tag>}
      </div>
      <p className="sub">State rules require a letter every 30 days while a claim is pending. If nothing changes, it tells {recipient(claim, open)} these are still needed:</p>
      <ul className="rq-letter-list">
        {open.map((r) => (
          <li key={r.id}>
            <ToneShape tone={r.status.tone} size={8} />
            <span className="strong">{r.name}</span>
            <span className="muted">· {r.waitingOn ?? r.from} · {r.status.label.toLowerCase()}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function LetterDrawer({ claim, open, ctx, onClose }: { claim: Claim; open: RequirementRecord[]; ctx?: RequirementContext; onClose: () => void }) {
  const due = letterDue(claim, ctx)
  const first = recipient(claim, open).split(' ')[0]
  return (
    <Drawer title={`Status letter${ctx?.nextLetter ? ` ${ctx.nextLetter}` : ''} · preview`} onClose={onClose} width={560}
      footer={<><span className="sub grow">Template ST-DI-30 · plain-language review passed</span><button type="button" className="btn" onClick={onClose}>Close</button></>}>
      <div className="rq-paper">
        <p className="sub">{due ? fmtDate(due, { year: true }) : ''} · Claim {claim.id}</p>
        <p>Dear {first},</p>
        <p>We are still working on your claim. We write every 30 days while a claim is open, so you always know where it stands.</p>
        <p>To finish, we still need:</p>
        <ul className="rq-paper-list">
          {open.map((r) => (
            <li key={r.id}><strong>{r.name}</strong> from {r.from}{r.state === 'overdue' ? ' — we have asked several times and called the office' : ''}.</li>
          ))}
        </ul>
        <p>You don’t need to do anything for items we are requesting from others. If you can help speed them up, reply in your portal or call us at (555) 010-2000.</p>
        <p>We will write again by {due ? fmtDate(addDays(due, 30), { year: true }) : 'next month'} if we are still waiting.</p>
      </div>
    </Drawer>
  )
}

// ---------------------------------------------------------------- drawers

const OUTCOMES = [
  { label: 'Office will fax today', days: 1 },
  { label: 'Office will send within 5 days', days: 5 },
  { label: 'Office says it was sent — check intake', days: 1 },
  { label: 'Left a voicemail', days: 1 },
  { label: 'Office needs a new authorization', days: 3 },
  { label: 'Office asks for a copy fee first', days: 3 },
]

/** The next business day after `iso` + n days (skips Sat/Sun). */
function businessDay(iso: string, n: number): string {
  let d = addDays(iso, n)
  for (;;) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
    if (wd !== 0 && wd !== 6) return d
    d = addDays(d, 1)
  }
}

/** Log call outcome: who you spoke with, what they said, when to check again. */
function CallDrawer({ r, onClose }: { r: RequirementRecord; onClose: () => void }) {
  const toast = useToast()
  const { user } = useSession()
  const [spokeWith, setSpokeWith] = useState(r.waitingOn ? `${r.waitingOn} — front desk` : r.from)
  const [outcome, setOutcome] = useState(OUTCOMES[0].label)
  const [note, setNote] = useState('')
  const [followUp, setFollowUp] = useState(businessDay(TODAY, OUTCOMES[0].days))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await logCallOutcome(r.id, { spokeWith: spokeWith.trim() || r.from, outcome, note: note.trim() || undefined, followUp }, user.name)
      toast(`Call logged · next check ${fmtDate(followUp, { weekday: true })}`)
      onClose()
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Drawer title={`Log call outcome · ${r.name}`} onClose={onClose} width={480}
      footer={<><span className="sub grow">Saved to communications and history</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={save} disabled={busy}>Log call</button></>}>
      {r.contact && <div className="well sub">{r.contact.join(' · ')}</div>}
      <div className="field">
        <label htmlFor="call-who">Spoke with</label>
        <input id="call-who" className="input" value={spokeWith} onChange={(e) => setSpokeWith(e.target.value)} />
      </div>
      <fieldset className="rq-fieldset">
        <legend className="label">Outcome</legend>
        <div className="rq-choices">
          {OUTCOMES.map((o) => (
            <label key={o.label} className="radio-card">
              <input type="radio" name="call-outcome" checked={outcome === o.label} onChange={() => { setOutcome(o.label); setFollowUp(businessDay(TODAY, o.days)) }} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="call-note">Note <span className="muted" style={{ fontWeight: 400 }}>· optional</span></label>
        <textarea id="call-note" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Spoke with Tanya; the form is on Dr. Hsu’s desk to sign" />
      </div>
      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor="call-follow">Check again on</label>
        <input id="call-follow" type="date" className="input" value={followUp} min={TODAY} onChange={(e) => setFollowUp(e.target.value || followUp)} />
      </div>
    </Drawer>
  )
}

/** Waive needs a reason — it is audited and the status letter stops listing the item. */
function WaiveDrawer({ r, onClose }: { r: RequirementRecord; onClose: () => void }) {
  const toast = useToast()
  const { user } = useSession()
  const [reason, setReason] = useState<string>(WAIVE_REASONS[0])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      await waiveRequirement(r.id, note.trim() ? `${reason} — ${note.trim()}` : reason, user.name)
      toast(`${r.name} waived · logged with your reason`)
      onClose()
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Drawer title={`Waive · ${r.name}`} onClose={onClose} width={480}
      footer={<><span className="sub grow">Waivers are audited</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={save} disabled={busy || !note.trim()}>Waive requirement</button></>}>
      <p className="soft">The requirement stops blocking the claim and follow-ups stop. Say why, so a reviewer can follow the decision.</p>
      <fieldset className="rq-fieldset">
        <legend className="label">Reason</legend>
        <div className="rq-choices">
          {WAIVE_REASONS.map((w) => (
            <label key={w} className="radio-card">
              <input type="radio" name="waive-reason" checked={reason === w} onChange={() => setReason(w)} />
              {w}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="waive-note">Explain</label>
        <textarea id="waive-note" className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Vendor records include Dr. Hsu’s visit notes with restrictions" />
      </div>
    </Drawer>
  )
}

/** The call script for today's follow-up call. */
function ScriptDrawer({ r, onClose, onLog }: { r: RequirementRecord; onClose: () => void; onLog: () => void }) {
  return (
    <Drawer title={`Call script · ${r.waitingOn ?? r.from}`} onClose={onClose} width={520}
      footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Close</button><button type="button" className="btn btn--primary" onClick={onLog}><Icon name="phone" size={13} />Log call outcome</button></>}>
      {r.contact && <div className="well">{r.contact.map((c) => <div key={c}>{c}</div>)}</div>}
      <ol className="rq-script">
        {(r.script ?? ['Introduce yourself and the claim number.', `Ask about the ${r.name.toLowerCase()} requested on ${r.requested ? fmtDate(r.requested) : 'file'}.`, 'Agree a date and note who you spoke with.']).map((line) => <li key={line}>{line}</li>)}
      </ol>
    </Drawer>
  )
}

const COMMON: Record<Claim['family'], string[]> = {
  life: ['Certified death certificate', 'Claimant statement', 'IRS Form W-9', 'Medical records', 'Police accident report', 'Coroner’s final report', 'Proof of identity', 'Letters testamentary'],
  disability: ['Attending physician statement', 'Medical records', 'Tax return', 'Monthly practice P&L', 'Claimant progress report', 'Occupational duties questionnaire', 'Independent medical exam'],
  annuity: ['Certified death certificate', 'Claimant statement', 'IRS Form W-9', 'Payout election', 'Proof of identity', 'Trust certification'],
}

/** Add requirement: what, from whom, for which benefit line, by when, and whether to send the request now. */
function AddDrawer({ claim, onClose, onAdded }: { claim: Claim; onClose: () => void; onAdded: (id: string) => void }) {
  const toast = useToast()
  const { user } = useSession()
  const people = claim.parties.filter((p) => !(p.roles.includes('Insured') && !p.roles.includes('Claimant')) || claim.family === 'disability').map((p) => p.name)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('Proof of claim')
  const [from, setFrom] = useState(people[0] ?? '')
  const [line, setLine] = useState(claim.benefitLines.length > 1 ? '' : claim.benefitLines[0]?.id ?? '')
  const [due, setDue] = useState(addDays(TODAY, 14))
  const [via, setVia] = useState('portal')
  const [send, setSend] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const r = await addRequirement(claim.id, { name, purpose, from, benefitLineId: line || undefined, due, via, send, note }, user.name)
      toast(send ? `Requirement added · request sent to ${r.from}` : 'Requirement added')
      onAdded(r.id)
      onClose()
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Drawer title="Add requirement" onClose={onClose} width={520}
      footer={<><span className="sub grow">Adds a follow-up plan with a reminder 7 days before it is due</span><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" onClick={save} disabled={busy || !name.trim() || !from.trim()}>{send ? 'Add and send request' : 'Add requirement'}</button></>}>
      <div className="field">
        <label htmlFor="add-name">Requirement</label>
        <input id="add-name" className="input" list="add-name-list" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Medical records" />
        <datalist id="add-name-list">{COMMON[claim.family].map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      <div className="field">
        <label htmlFor="add-note">Detail <span className="muted" style={{ fontWeight: 400 }}>· optional</span></label>
        <input id="add-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Jan 2025–present" />
      </div>
      <div className="rq-form-grid">
        <div className="field">
          <label htmlFor="add-for">For</label>
          <input id="add-for" className="input" list="add-for-list" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          <datalist id="add-for-list">{['Proof of claim', 'Proof of death', 'Medical proof', 'Prior earnings', 'Current earnings', 'Contestable review', 'Tax', 'Payee', 'Good order'].map((c) => <option key={c} value={c} />)}</datalist>
        </div>
        <div className="field">
          <label htmlFor="add-from">From</label>
          <input id="add-from" className="input" list="add-from-list" value={from} onChange={(e) => setFrom(e.target.value)} />
          <datalist id="add-from-list">{people.map((p) => <option key={p} value={p} />)}</datalist>
        </div>
        <div className="field">
          <label htmlFor="add-line">Benefit line</label>
          <select id="add-line" className="select" value={line} onChange={(e) => setLine(e.target.value)}>
            {claim.benefitLines.length > 1 && <option value="">All lines</option>}
            {claim.benefitLines.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="add-due">Due</label>
          <input id="add-due" type="date" className="input" value={due} min={TODAY} onChange={(e) => setDue(e.target.value || due)} />
        </div>
      </div>
      <fieldset className="rq-fieldset">
        <legend className="label">Request by</legend>
        <div className="radio-cards">
          {['portal', 'email', 'fax', 'letter'].map((v) => (
            <label key={v} className="radio-card"><input type="radio" name="add-via" checked={via === v} onChange={() => setVia(v)} />{v[0].toUpperCase() + v.slice(1)}</label>
          ))}
        </div>
      </fieldset>
      <label className="rq-check">
        <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
        Send the request now
      </label>
    </Drawer>
  )
}
