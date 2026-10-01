import type { ReactNode } from 'react'
import type { Suggestion } from '../api/types'
import { Sources } from './Sources'

function DashedDiamond() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" />
    </svg>
  )
}

/** Proposed content from the assistant or extraction: dashed until a person accepts it. */
export function ProposedCard({ s, onAccept, onDismiss, busy }: { s: Suggestion; onAccept: () => void; onDismiss: () => void; busy?: boolean }) {
  if (s.state !== 'open') {
    return (
      <div className="proposed proposed--accepted" aria-live="polite">
        <div className="proposed-kicker" style={{ color: 'var(--ink-3)' }}>
          {s.state === 'accepted' ? 'Accepted' : 'Dismissed'} · logged
        </div>
        <div className="proposed-title" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{s.title}</div>
        {s.state === 'accepted' && s.creates && <div className="proposed-body">Created: {s.creates}</div>}
      </div>
    )
  }
  return (
    <div className="proposed">
      {s.group === 'next' && (
        <div className="proposed-kicker">
          <DashedDiamond />
          Suggested · {s.category}
        </div>
      )}
      <div className="proposed-title">{s.title}</div>
      <div className="proposed-body">{s.body}</div>
      <Sources items={s.sources} max={2} />
      <div className="proposed-actions">
        <span className="grow" />
        <button type="button" className="btn btn--ghost btn--xs" onClick={onAccept} disabled={busy}>
          {s.primary}
        </button>
        <button type="button" className="btn btn--quiet btn--xs" onClick={onDismiss} disabled={busy}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

export function ProposedValue({ children }: { children: ReactNode }) {
  return <span className="proposed-inline">{children}</span>
}
