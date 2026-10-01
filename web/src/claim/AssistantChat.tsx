import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Claim } from '../api/types'
import { useQuery } from '../api/useQuery'
import { askAssistant, clearTurns, listTurns, starterQuestions, type AssistantAction, type AssistantSource, type AssistantTurn } from '../api/assistant'
import { addNote, addTask } from '../api/tasks'
import { logEvent } from '../api/history'
import { fmtTime } from '../lib/dates'
import { cx } from '../lib/cx'
import { Icon } from '../components/Icon'
import { useToast } from '../components/Toasts'
import { useSession } from '../shell/session'
import './assistant.css'

function AssistantMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" />
    </svg>
  )
}

/** Conversation state for one claim. The thread lives in the mock API, so it survives moving between sections. */
export function useAssistantChat(claimId: string) {
  const { user } = useSession()
  const toast = useToast()
  const { data: turns } = useQuery(() => listTurns(claimId), [claimId])
  const [pending, setPending] = useState<string | null>(null)

  async function ask(question: string) {
    const q = question.trim()
    if (!q || pending) return
    setPending(q)
    try {
      await askAssistant(claimId, q, user.name)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  return { turns: turns ?? [], pending, ask, clear: () => clearTurns(claimId, user.name) }
}

export type AssistantChatState = ReturnType<typeof useAssistantChat>

/** The question-and-answer thread, shown under the summary and suggestions in the Assistant tab. */
export function ChatThread({ claim, chat, scrollRef }: { claim: Claim; chat: AssistantChatState; scrollRef: RefObject<HTMLDivElement | null> }) {
  const { turns, pending } = chat

  useEffect(() => {
    const el = scrollRef.current
    if (el && (turns.length || pending)) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [turns.length, pending, scrollRef])

  if (!turns.length && !pending) return null
  return (
    <section className="ac-thread" aria-labelledby="ac-h">
      <div className="section-head">
        <h2 id="ac-h" className="cp-h">Asked about this claim</h2>
        <button type="button" className="btn btn--quiet btn--xs" onClick={chat.clear} disabled={!!pending}>New conversation</button>
      </div>
      <div aria-live="polite" className="ac-turns">
        {turns.map((t, i) => (
          <Turn key={t.id} claim={claim} t={t} last={i === turns.length - 1 && !pending} onAsk={chat.ask} />
        ))}
        {pending && (
          <div className="ac-turn">
            <Question text={pending} />
            <div className="ac-a ac-a--pending" aria-busy="true">
              <div className="ac-kicker"><AssistantMark />Assistant</div>
              <span className="ac-reading">Reading this claim’s record<span className="ac-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function Question({ text, at }: { text: string; at?: string }) {
  return (
    <div className="ac-q">
      <span className="ac-who">You{at ? ` · ${fmtTime(at)}` : ''}</span>
      <p>{text}</p>
    </div>
  )
}

function Turn({ claim, t, last, onAsk }: { claim: Claim; t: AssistantTurn; last: boolean; onAsk: (q: string) => void }) {
  const { user } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  const [saved, setSaved] = useState(false)

  const open = (s: { section?: string; target?: string }) => s.section && navigate(`/claims/${claim.id}/${s.section}${s.target ? `/${s.target}` : ''}`)

  function run(a: AssistantAction) {
    if (a.kind === 'open') return open(a)
    if (a.kind === 'task' && a.text) {
      addTask(claim.id, a.text, user.name, 'Assistant answer')
      logEvent(claim.id, { type: 'task', title: `Task created from an assistant answer: ${a.text}`, actor: user.name })
      toast(`Task added: ${a.text}`)
    }
    if (a.kind === 'note' && a.text) {
      addNote(claim.id, user.name, a.text)
      toast('Note saved to the claim file')
    }
  }

  function saveAsNote() {
    const body = [...t.paragraphs, ...(t.bullets ?? []).map((b) => `• ${b}`), ...(t.after ?? [])].join('\n')
    addNote(claim.id, user.name, `Assistant answer to “${t.question}”\n${body}\nSources: ${t.sources.map((s) => s.label).join(', ') || 'none'}`)
    logEvent(claim.id, { type: 'assistant', title: `Assistant answer saved as a note: “${t.question}”`, actor: user.name })
    setSaved(true)
    toast('Saved to Notes, with its sources')
  }

  return (
    <div className="ac-turn">
      <Question text={t.question} at={t.askedAt} />
      <div className={cx('ac-a', `ac-a--${t.kind}`)}>
        <div className="ac-kicker" title={`Read ${t.basedOn}`}>
          <AssistantMark />
          {t.kind === 'declined' ? 'Assistant · no recommendation' : t.kind === 'unknown' ? 'Assistant · not in the record' : 'Assistant · from this claim’s record'}
        </div>
        {t.paragraphs.map((p) => <p key={p}>{p}</p>)}
        {t.bullets && t.bullets.length > 0 && (
          <ul className="ac-bullets">{t.bullets.map((b) => <li key={b}>{b}</li>)}</ul>
        )}
        {t.after?.map((p) => <p key={p}>{p}</p>)}
        {t.sources.length > 0 && (
          <div className="ac-sources">
            <span className="sub">Sources</span>
            {t.sources.map((s: AssistantSource) => (
              <button key={s.label} type="button" className="source" onClick={() => open(s)} title={s.section ? `Open ${s.label}` : undefined}>{s.label}</button>
            ))}
          </div>
        )}
        <div className="ac-actions">
          {(t.actions ?? []).map((a) => (
            <button key={a.label} type="button" className="btn btn--ghost btn--xs" onClick={() => run(a)}>
              {a.kind === 'task' && <Icon name="plus" size={12} />}
              {a.label}
            </button>
          ))}
          <span className="grow" />
          {t.kind === 'answer' && (
            <button type="button" className="btn btn--quiet btn--xs" onClick={saveAsNote} disabled={saved}>{saved ? 'Saved' : 'Save as note'}</button>
          )}
        </div>
      </div>
      {last && t.followUps && t.followUps.length > 0 && (
        <div className="ac-follow" aria-label="Follow-up questions">
          {t.followUps.map((f) => (
            <button key={f} type="button" className="ac-chip" onClick={() => onAsk(f)}>{f}</button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Pinned under the Assistant tab: suggested first questions, the input and the rules it works by. */
export function ChatComposer({ claim, chat }: { claim: Claim; chat: AssistantChatState }) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const starters = starterQuestions(claim.id)

  function submit() {
    if (!text.trim() || chat.pending) return
    chat.ask(text)
    setText('')
    if (ref.current) ref.current.style.height = ''
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form className="ac-composer" onSubmit={(e) => { e.preventDefault(); submit() }}>
      {chat.turns.length === 0 && !chat.pending && (
        <div className="ac-starters" aria-label="Suggested questions">
          {starters.map((s) => (
            <button key={s} type="button" className="ac-chip" onClick={() => chat.ask(s)}>{s}</button>
          ))}
        </div>
      )}
      <div className="ac-input">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = ''
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
          }}
          onKeyDown={onKey}
          placeholder="Ask about this claim"
          aria-label={`Ask the assistant about ${claim.name}’s claim`}
          disabled={!!chat.pending}
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={!text.trim() || !!chat.pending} aria-label="Ask">
          <Icon name="send" size={13} />
        </button>
      </div>
      <p className="ac-hint">Answers come only from this claim’s record and cite their sources. The assistant drafts; it never decides. Every question is logged.</p>
    </form>
  )
}
