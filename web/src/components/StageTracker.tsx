import type { StageStep } from '../api/types'

function Mark({ state }: { state: StageStep['state'] }) {
  if (state === 'done')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="7" fill="#45494F" /><path d="M4 7.2 6.1 9.2 10 5" fill="none" stroke="#FFFFFF" strokeWidth="1.6" /></svg>
  if (state === 'current')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#1F4E8C" strokeWidth="2" /><circle cx="7" cy="7" r="2.5" fill="#1F4E8C" /></svg>
  if (state === 'partial')
    return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#45494F" strokeWidth="1.5" /><path d="M7 1a6 6 0 0 1 0 12Z" fill="#45494F" /></svg>
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="#FFFFFF" stroke="#A3A098" strokeWidth="1.5" /></svg>
}

/** Claim stage, rolled up from benefit lines. Partial = some lines have reached this stage. */
export function StageTracker({ steps }: { steps: StageStep[] }) {
  return (
    <ol className="stages" aria-label="Claim stage, rolled up from benefit lines">
      {steps.map((s, i) => (
        <li key={s.key} aria-current={s.state === 'current' ? 'step' : undefined} className={`stage stage--${s.state}`}>
          {i > 0 && <span aria-hidden="true" className="stage-link" />}
          <Mark state={s.state} />
          {s.label}
          {s.note && <span className="muted">{s.note}</span>}
          <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current)' : s.state === 'partial' ? ' (partly done)' : ''}</span>
        </li>
      ))}
    </ol>
  )
}
