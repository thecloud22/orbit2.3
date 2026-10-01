import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { addPlanNote, getCasePlan, MILESTONE_STATUS, updateMilestone, type CasePlan, type Milestone, type MilestoneStatus } from '../../api/casePlan'
import { listNotes, listTasks, toggleTask } from '../../api/tasks'
import { logEvent } from '../../api/history'
import { daysUntil, fmtDate, plural } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Avatar } from '../../components/Avatar'
import { Drawer } from '../../components/Drawer'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './CasePlan.css'

/** The DI case plan: goals, the transition to the any-occupation definition, workstreams, the team and the next 90 days. */
export function CasePlanSection({ claim }: SectionProps) {
  const { data: plan, loading } = useQuery(() => getCasePlan(claim.id), [claim.id])
  const [editing, setEditing] = useState<Milestone | null>(null)
  const [noting, setNoting] = useState(false)

  if (loading && !plan) return <Loading rows={8} />
  if (!plan)
    return (
      <>
        <div className="page-head"><h2>Case plan</h2></div>
        <div className="empty">No case plan on this claim yet. Plans start once a DI claim is approved and managed.</div>
      </>
    )

  return (
    <div className="cpl">
      <div className="page-head">
        <h2>Case plan</h2>
        <span className="aside">Version {plan.version} · agreed with {plan.agreedWith} {fmtDate(plan.agreed, { year: true })}</span>
        <span className="grow" />
        <button type="button" className="btn btn--sm" onClick={() => setNoting(true)}><Icon name="pencil" size={13} />Add note</button>
      </div>

      <section className="cpl-goals" aria-labelledby="cpl-goals-h">
        <h3 id="cpl-goals-h">Goals</h3>
        <ol>
          {plan.goals.map((g, i) => (
            <li key={g}><span className="cpl-n" aria-hidden="true">{i + 1}</span>{g}</li>
          ))}
        </ol>
      </section>

      <Transition plan={plan} onEdit={setEditing} />
      <Workstreams plan={plan} claimId={claim.id} />

      <div className="cpl-pair">
        <Diary plan={plan} />
        <Team plan={plan} />
      </div>

      <div className="cpl-pair">
        <Tasks claimId={claim.id} />
        <Notes claimId={claim.id} onAdd={() => setNoting(true)} />
      </div>

      <Versions plan={plan} />

      {editing && <MilestoneDrawer claimId={claim.id} m={editing} onClose={() => setEditing(null)} />}
      {noting && <NoteDrawer claimId={claim.id} onClose={() => setNoting(false)} />}
    </div>
  )
}

function Mark({ status, current }: { status: MilestoneStatus; current: boolean }) {
  if (status === 'done')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="#45494F" /><path d="M4 7.2 6.1 9.2 10 5" fill="none" stroke="#FFFFFF" strokeWidth="1.6" /></svg>
  if (current)
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#1F4E8C" strokeWidth="2" /><circle cx="7" cy="7" r="2.5" fill="#1F4E8C" /></svg>
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke={status === 'optional' ? '#A3A098' : '#62666D'} strokeWidth="1.5" strokeDasharray={status === 'optional' ? '2 2' : undefined} /></svg>
}

/** The own-occupation period ends; the milestones that lead to the any-occupation decision. Each opens to update. */
function Transition({ plan, onEdit }: { plan: CasePlan; onEdit: (m: Milestone) => void }) {
  const days = daysUntil(plan.transition.date)
  const current = plan.milestones.find((m) => m.status !== 'done')
  return (
    <section className="cpl-transition" aria-labelledby="cpl-tr-h">
      <div className="cpl-tr-head">
        <h3 id="cpl-tr-h">Transition to any occupation</h3>
        <span className="cpl-tr-date">{fmtDate(plan.transition.date, { year: true })} · {plural(days, 'day')}</span>
      </div>
      <p className="soft">{plan.transition.definition}</p>
      <ol className="cpl-steps" style={{ ['--n' as string]: plan.milestones.length }}>
        {plan.milestones.map((m) => {
          const st = MILESTONE_STATUS[m.status]
          const isCur = m === current
          return (
            <li key={m.id} className={cx('cpl-step', isCur && 'is-current', m.status === 'done' && 'is-done')}>
              <button type="button" className="cpl-step-btn" onClick={() => onEdit(m)} aria-label={`${m.label}, ${m.when}, ${st.label}. Update milestone`}>
                <span className="cpl-step-mark"><Mark status={m.status} current={isCur} /></span>
                <span className="cpl-step-label">{m.label}</span>
                <span className="sub">{m.when}</span>
                <span className={cx('cpl-step-status', `cpl-step-status--${st.tone}`)}>
                  <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
                    {st.tone === 'positive' ? <path d="M1.5 5.2 4 7.6 8.6 2.4" fill="none" stroke="currentColor" strokeWidth="2" />
                      : st.tone === 'info' ? <circle cx="5" cy="5" r="4" fill="currentColor" />
                        : <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />}
                  </svg>
                  {st.label}
                </span>
                {m.note && <span className="cpl-step-note">{m.note}</span>}
              </button>
            </li>
          )
        })}
      </ol>
      <div className="cpl-tr-foot">
        <span className="cpl-tr-note"><Icon name="shield" size={13} /> Own-occupation period ends <strong>{fmtDate(plan.transition.ownOccEnds, { year: true })}</strong>. The any-occupation decision is made with at least 30 days’ written notice.</span>
        <span className="grow" />
        <span className="sub">Select a milestone to update it</span>
      </div>
    </section>
  )
}

function Workstreams({ plan, claimId }: { plan: CasePlan; claimId: string }) {
  return (
    <section className="section" aria-labelledby="cpl-ws-h">
      <div className="section-head">
        <h3 id="cpl-ws-h">Workstreams</h3>
        <span className="aside">Status · owner · cadence · next date</span>
      </div>
      <div className="cpl-scroll">
        <table className="tbl tbl--middle">
          <thead><tr><th>Workstream</th><th>Owner</th><th>Cadence</th><th>Last</th><th>Next</th><th>Status</th></tr></thead>
          <tbody>
            {plan.workstreams.map((w) => (
              <tr key={w.name}>
                <td>
                  <div className="strong">{w.section ? <Link to={`/claims/${claimId}/${w.section}`}>{w.name}</Link> : w.name}</div>
                  {w.detail && <div className="sub">{w.detail}</div>}
                </td>
                <td className="nowrap">{w.owner}</td>
                <td>{w.cadence}</td>
                <td className="nowrap">{w.last}</td>
                <td className="nowrap">{w.next}</td>
                <td><StatusTag status={w.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Diary({ plan }: { plan: CasePlan }) {
  return (
    <section className="section" aria-labelledby="cpl-d-h">
      <div className="section-head">
        <h3 id="cpl-d-h">Next 90 days</h3>
        <span className="aside">From the claim diary</span>
      </div>
      <ul className="cpl-diary">
        {plan.diary.map((d) => (
          <li key={d.date + d.label}>
            <span className="strong cpl-diary-date">{fmtDate(d.date)}</span>
            <span className="grow">{d.label}</span>
            <span className="sub nowrap">{d.who}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Team({ plan }: { plan: CasePlan }) {
  const c = plan.lastContact
  return (
    <section className="section" aria-labelledby="cpl-t-h">
      <div className="section-head">
        <h3 id="cpl-t-h">Specialist team</h3>
        <span className="aside">{plan.team.length} people</span>
      </div>
      <ul className="cpl-team">
        {plan.team.map((p) => (
          <li key={p.name}>
            <Avatar initials={p.initials} size={26} />
            <div className="grow">
              <div className="strong">{p.name}</div>
              <div className="sub">{p.role}</div>
            </div>
            {p.note && <span className="tag tag--neutral">{p.note}</span>}
          </li>
        ))}
      </ul>
      <div className="cpl-prefs">
        <div className="cpl-sub-h">Marcus’s preferences</div>
        <dl className="dl">
          {plan.preferences.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <div className="cpl-sub-h" style={{ marginTop: 8 }}>
          Last contact <span className="sub" style={{ fontWeight: 400 }}>· {fmtDate(c.at)} · {c.channel} · {c.minutes} min</span>
        </div>
        <p>{c.text}</p>
        <span className="sub">Next call {fmtDate(c.next)}</span>
      </div>
    </section>
  )
}

function Tasks({ claimId }: { claimId: string }) {
  const { user } = useSession()
  const { data: tasks } = useQuery(() => listTasks(claimId), [claimId])
  return (
    <section className="section" aria-labelledby="cpl-tk-h">
      <div className="section-head">
        <h3 id="cpl-tk-h">Tasks</h3>
        <span className="aside">{tasks ? `${tasks.filter((t) => !t.done).length} open` : ''}</span>
      </div>
      {!tasks ? <Loading rows={3} /> : (
        <ul className="cpl-tasks">
          {tasks.map((t) => (
            <li key={t.id} className={cx(t.done && 'is-done')}>
              <label>
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={async () => {
                    await toggleTask(t.id)
                    logEvent(claimId, { type: 'task', title: `Task ${t.done ? 'reopened' : 'completed'}: ${t.title}`, actor: `${user.name} · case plan` })
                  }}
                />
                <span className="grow">
                  <span className="cpl-task-title">{t.title}</span>
                  <span className="sub"> · {t.assignee}{t.due ? ` · due ${fmtDate(t.due)}` : ''}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Notes({ claimId, onAdd }: { claimId: string; onAdd: () => void }) {
  const { data: notes } = useQuery(() => listNotes(claimId), [claimId])
  return (
    <section className="section" aria-labelledby="cpl-nt-h">
      <div className="section-head">
        <h3 id="cpl-nt-h">Notes</h3>
        <button type="button" className="btn btn--ghost btn--xs" onClick={onAdd}><Icon name="plus" size={12} />Add note</button>
      </div>
      {!notes ? <Loading rows={2} /> : notes.length === 0 ? <p className="muted">No notes yet.</p> : (
        <ul className="cpl-notes">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="sub"><span className="strong" style={{ color: 'var(--ink)' }}>{n.author}</span> · {fmtDate(n.at)}</div>
              <p>{n.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Versions({ plan }: { plan: CasePlan }) {
  return (
    <section className="section" aria-labelledby="cpl-v-h">
      <div className="section-head">
        <h3 id="cpl-v-h">Plan versions</h3>
        <span className="aside">Each version is agreed with Marcus and kept</span>
      </div>
      <ol className="cpl-versions">
        {plan.versions.map((v) => (
          <li key={v.v} className={cx(v.v === plan.version && 'is-current')}>
            <span className="cpl-v">v{v.v}</span>
            <span className="nowrap sub">{fmtDate(v.date, { year: true })} · {v.by}</span>
            <span>{v.summary}</span>
            {v.v === plan.version && <span className="tag tag--info">Current</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Update one milestone: status, timing and a note. The change is logged to History. */
function MilestoneDrawer({ claimId, m, onClose }: { claimId: string; m: Milestone; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const [status, setStatus] = useState<MilestoneStatus>(m.status)
  const [when, setWhen] = useState(m.when)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const changed = status !== m.status || when.trim() !== m.when || note.trim() !== ''

  async function save() {
    setBusy(true)
    await updateMilestone(claimId, m.id, { status, when, note }, user)
    toast(`Milestone updated · ${m.label}`)
    onClose()
  }

  return (
    <Drawer
      title={`Update milestone · ${m.label}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="sub grow">Logged to History with the case plan version.</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={busy || !changed}>Save</button>
        </>
      }
    >
      <dl className="dl">
        <dt>Owner</dt><dd>{m.owner}</dd>
        <dt>Due</dt><dd>{fmtDate(m.due, { year: true })}</dd>
        {m.note && <><dt>Last note</dt><dd>{m.note}</dd></>}
      </dl>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="wb-label">Status</legend>
        <div className="radio-cards">
          {(Object.keys(MILESTONE_STATUS) as MilestoneStatus[]).map((k) => (
            <label key={k} className="radio-card">
              <input type="radio" name="ms-status" checked={status === k} onChange={() => setStatus(k)} />
              {MILESTONE_STATUS[k].label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="ms-when">Timing</label>
        <input id="ms-when" className="input" value={when} onChange={(e) => setWhen(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ms-note">Note <span className="sub" style={{ fontWeight: 400 }}>· optional</span></label>
        <textarea id="ms-note" className="textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" />
      </div>
    </Drawer>
  )
}

function NoteDrawer({ claimId, onClose }: { claimId: string; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Drawer
      title="Add a case plan note"
      onClose={onClose}
      width={520}
      footer={
        <>
          <span className="sub grow">Shows in the claim’s notes and is logged to History.</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !text.trim()}
            onClick={async () => {
              setBusy(true)
              await addPlanNote(claimId, text.trim(), user)
              toast('Note added')
              onClose()
            }}
          >
            Add note
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="cpl-note">Note</label>
        <textarea id="cpl-note" className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Marcus asked for the skills analysis questions in advance" />
      </div>
    </Drawer>
  )
}
