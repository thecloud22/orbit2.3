import { useRef, useState } from 'react'
import type { Claim } from '../api/types'
import { useQuery } from '../api/useQuery'
import { decideSuggestion } from '../api/claims'
import { addNote, addTask, listNotes, listTasks, toggleTask } from '../api/tasks'
import { fmtDate, fmtTime } from '../lib/dates'
import { Icon } from '../components/Icon'
import { ProposedCard } from '../components/Proposed'
import { Sources } from '../components/Sources'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import type { ClaimCounts } from './useCounts'
import { ChatComposer, ChatThread, useAssistantChat } from './AssistantChat'

export type PanelTab = 'assistant' | 'tasks' | 'notes'

/** The context panel keeps the assistant, tasks or notes beside whatever you are doing. */
export function ContextPanel({ claim, tab, setTab, counts, collapsed, setCollapsed }: {
  claim: Claim
  tab: PanelTab
  setTab: (t: PanelTab) => void
  counts?: ClaimCounts
  collapsed: boolean
  setCollapsed: (c: boolean) => void
}) {
  if (collapsed) {
    return (
      <aside className="cp cp--collapsed" aria-label="Context panel (collapsed)">
        <button type="button" className="btn btn--quiet btn--sm" aria-label="Expand context panel" onClick={() => setCollapsed(false)}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button type="button" className="cp-rail" onClick={() => { setTab('assistant'); setCollapsed(false) }}>Assistant</button>
        <button type="button" className="cp-rail" onClick={() => { setTab('tasks'); setCollapsed(false) }}>Tasks</button>
        <button type="button" className="cp-rail" onClick={() => { setTab('notes'); setCollapsed(false) }}>Notes</button>
      </aside>
    )
  }
  if (claim.live) {
    // A live claim has a summary derived from the backend's records. The assistant, tasks and notes are the mock's and stay out of it.
    return (
      <aside className="cp" aria-label="Context panel">
        <div className="cp-tabs">
          <span className="cp-tab" aria-current="true" style={{ fontWeight: 700, boxShadow: 'inset 0 -2px 0 var(--accent)' }}>Summary</span>
          <span className="grow" />
          <button type="button" className="btn btn--quiet btn--sm" aria-label="Collapse context panel" onClick={() => setCollapsed(true)}>
            <Icon name="collapse" size={14} />
          </button>
        </div>
        <div className="cp-body">
          <section className="cp-section" aria-labelledby="sum-h">
            <div className="section-head">
              <h2 id="sum-h" className="cp-h">Claim summary</h2>
              <span className="sub">{claim.summary.asOf}</span>
            </div>
            <p style={{ lineHeight: 1.5 }}>{claim.summary.text}</p>
            <Sources items={claim.summary.sources} max={2} />
          </section>
          <p className="sub">Live mode. The summary is worked out from the backend’s records. The assistant, tasks and notes are not connected to the backend yet.</p>
        </div>
      </aside>
    )
  }
  return (
    <aside className="cp" aria-label="Context panel">
      <div className="cp-tabs" role="tablist">
        {(['assistant', 'tasks', 'notes'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="cp-tab" onClick={() => setTab(t)}>
            {t === 'assistant' ? 'Assistant' : t === 'tasks' ? 'Tasks' : 'Notes'}
            {t === 'tasks' && counts && counts.tasksOpen > 0 && <span className="count-badge count-badge--pill">{counts.tasksOpen}</span>}
            {t === 'notes' && counts && counts.notes > 0 && <span className="count-badge count-badge--pill">{counts.notes}</span>}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className="btn btn--quiet btn--sm" aria-label="Collapse context panel" onClick={() => setCollapsed(true)}>
          <Icon name="collapse" size={14} />
        </button>
      </div>
      {tab === 'assistant' ? (
        <Assistant claim={claim} />
      ) : (
        <div className="cp-body" role="tabpanel">
          {tab === 'tasks' && <Tasks claimId={claim.id} />}
          {tab === 'notes' && <Notes claimId={claim.id} />}
        </div>
      )}
    </aside>
  )
}

function Assistant({ claim }: { claim: Claim }) {
  const { user } = useSession()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const chat = useAssistantChat(claim.id)
  const scrollRef = useRef<HTMLDivElement>(null)
  const next = claim.suggestions.filter((s) => s.group === 'next')
  const check = claim.suggestions.filter((s) => s.group === 'check')

  async function decide(id: string, choice: 'accepted' | 'dismissed') {
    setBusy(id)
    await decideSuggestion(claim.id, id, choice, user.name)
    setBusy(null)
    const s = claim.suggestions.find((x) => x.id === id)
    toast(choice === 'accepted' ? (s?.creates ? `Created: ${s.creates}` : 'Accepted · logged') : 'Dismissed · logged')
  }

  return (
    <div className="ac" role="tabpanel">
      <div className="cp-body" ref={scrollRef}>
      <section className="cp-section" aria-labelledby="sum-h">
        <div className="section-head">
          <h2 id="sum-h" className="cp-h">Claim summary</h2>
          <span className="sub">{claim.summary.asOf}</span>
        </div>
        <p style={{ lineHeight: 1.5 }}>{claim.summary.text}</p>
        <Sources items={claim.summary.sources} max={2} />
      </section>
      {next.length > 0 && (
        <section className="cp-section" aria-labelledby="sug-h">
          <h2 id="sug-h" className="cp-h">Also suggested</h2>
          {next.map((s) => <ProposedCard key={s.id} s={s} busy={busy === s.id} onAccept={() => decide(s.id, 'accepted')} onDismiss={() => decide(s.id, 'dismissed')} />)}
        </section>
      )}
      {check.length > 0 && (
        <section className="cp-section" aria-labelledby="chk-h">
          <h2 id="chk-h" className="cp-h">Worth checking</h2>
          {check.map((s) => <ProposedCard key={s.id} s={s} busy={busy === s.id} onAccept={() => decide(s.id, 'accepted')} onDismiss={() => decide(s.id, 'dismissed')} />)}
        </section>
      )}
      {next.length + check.length === 0 && <p className="muted">No suggestions for this claim right now.</p>}
      <p className="sub">Suggestions are advisory and logged. Accepting one creates a task or a draft; the decision stays with you.</p>
      <ChatThread claim={claim} chat={chat} scrollRef={scrollRef} />
      </div>
      <ChatComposer claim={claim} chat={chat} />
    </div>
  )
}

function Tasks({ claimId }: { claimId: string }) {
  const { user } = useSession()
  const { data } = useQuery(() => listTasks(claimId), [claimId])
  const [title, setTitle] = useState('')
  const open = (data ?? []).filter((t) => !t.done)
  const done = (data ?? []).filter((t) => t.done)
  return (
    <>
      <form
        className="cp-add"
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim()) addTask(claimId, title.trim(), user.name)
          setTitle('')
        }}
      >
        <input className="input grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task for this claim" aria-label="New task" />
        <button type="submit" className="btn btn--sm">Add</button>
      </form>
      <ul className="cp-list">
        {[...open, ...done].map((t) => (
          <li key={t.id} className={t.done ? 'is-done' : undefined}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input type="checkbox" checked={t.done} onChange={() => toggleTask(t.id)} style={{ marginTop: 3 }} />
              <span style={{ display: 'flex', flexDirection: 'column' }}>
                <span className="cp-task-title">{t.title}</span>
                <span className="sub">{t.assignee}{t.due ? ` · due ${fmtDate(t.due)}` : ''}{t.source ? ` · from ${t.source.toLowerCase()}` : ''}</span>
              </span>
            </label>
          </li>
        ))}
        {data && data.length === 0 && <li className="muted">No tasks yet.</li>}
      </ul>
    </>
  )
}

function Notes({ claimId }: { claimId: string }) {
  const { user } = useSession()
  const { data } = useQuery(() => listNotes(claimId), [claimId])
  const [text, setText] = useState('')
  return (
    <>
      <form
        className="cp-add"
        style={{ flexDirection: 'column', alignItems: 'stretch' }}
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim()) addNote(claimId, user.name, text.trim())
          setText('')
        }}
      >
        <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note — it’s part of the claim file" aria-label="New note" />
        <button type="submit" className="btn btn--sm" style={{ alignSelf: 'flex-end' }}>Save note</button>
      </form>
      <ul className="cp-list">
        {(data ?? []).map((n) => (
          <li key={n.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="sub">{n.author} · {fmtDate(n.at)} {fmtTime(n.at)}</span>
            <span style={{ lineHeight: 1.5 }}>{n.text}</span>
          </li>
        ))}
        {data && data.length === 0 && <li className="muted">No notes yet.</li>}
      </ul>
    </>
  )
}
