import type { ReactNode } from 'react'

/** Honest placeholder for a section designed on the canvas but not built in this mock yet. */
export function Planned({ title, board, children }: { title: string; board?: string; children?: ReactNode }) {
  return (
    <div className="planned">
      <h3>{title}</h3>
      <p className="soft">
        {children ?? 'This section is designed on the UX canvas but not built in the mock yet.'}
        {board && <> See canvas board <strong>{board}</strong>.</>}
      </p>
    </div>
  )
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  )
}
