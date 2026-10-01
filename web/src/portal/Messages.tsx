import { useState } from 'react'
import { useQuery } from '../api/useQuery'
import { listPortalMessages, sendPortalMessage } from '../api/portal'
import { fmtDate, fmtTime } from '../lib/dates'
import { Done, PtLoading } from './parts'

/** Messages tab: letters and messages on the claim, newest first, with a box to write to the claim team. */
export function Messages({ claimId, from, team }: { claimId: string; from: string; team: string }) {
  const { data } = useQuery(() => listPortalMessages(claimId, from), [claimId, from])
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)

  async function send() {
    if (!text.trim()) return
    await sendPortalMessage(claimId, from, text.trim())
    setText('')
    setSent(true)
  }

  return (
    <div className="pt-page">
      <h1 className="pt-h1">Messages</h1>
      <form
        className="pt-card pt-stack-8"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <label className="pt-label" htmlFor="pt-msg">
          Write to {team}
        </label>
        <textarea id="pt-msg" className="pt-input pt-textarea" rows={3} value={text} onChange={(e) => { setText(e.target.value); setSent(false) }} placeholder="Ask a question or tell us what’s changed" />
        <button type="submit" className="pt-btn pt-btn--primary" disabled={!text.trim()}>
          Send message
        </button>
        {sent && (
          <Done title="Message sent">
            <span className="pt-soft">We usually reply within 1 business day.</span>
          </Done>
        )}
      </form>

      <section className="pt-stack-8" aria-labelledby="pt-msgs-h">
        <h2 id="pt-msgs-h" className="pt-h2">
          Your messages and letters
        </h2>
        {!data ? (
          <PtLoading />
        ) : data.length === 0 ? (
          <p className="pt-soft">Nothing yet.</p>
        ) : (
          <ul className="pt-list">
            {data.map((m) => (
              <li key={m.id} className="pt-msg">
                <div className="pt-msg-meta">
                  <span className="pt-strong">{m.fromUs ? 'From us' : 'You sent'}</span>
                  <span className="pt-soft">
                    {m.channel === 'letter' ? 'Letter · ' : ''}
                    {fmtDate(m.at)} {fmtTime(m.at)}
                  </span>
                </div>
                <span>{m.title}</span>
                {m.detail && <span className="pt-soft pt-small">{m.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
