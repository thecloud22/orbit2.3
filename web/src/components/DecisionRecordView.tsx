import type { DecisionRecord } from '../api/types'
import { fmtDate, fmtTime } from '../lib/dates'
import { Sources } from './Sources'

function Seal() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="7.5" stroke="#1C1E21" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="5" stroke="#1C1E21" strokeWidth="1" strokeDasharray="1.5 1.5" />
      <path d="M6.4 9.1 8.2 10.9 11.7 7.2" stroke="#1C1E21" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A recorded decision: double-ruled, locked, citing its evidence. Never edited — a correction is v2. */
export function DecisionRecordView({ d, compact = false }: { d: DecisionRecord; compact?: boolean }) {
  return (
    <section className="record" aria-label={`Decision record: ${d.title}, version ${d.version}`}>
      <div className="record-head">
        <Seal />
        <h3>Decision · {d.title}</h3>
        <span className="record-meta">
          v{d.version} · {fmtDate(d.recordedAt, { year: true })}, {fmtTime(d.recordedAt)} · locked
        </span>
        <span className="grow" />
        <span className="record-meta" style={{ color: 'var(--ink-2)' }}>
          {d.recordedBy} · {d.authorityNote}
        </span>
      </div>
      <div className={compact ? 'record-grid record-grid--compact' : 'record-grid'}>
        <div>
          <div className="record-label">Outcome</div>
          <div>
            <strong>{d.outcomeText.split(' · ')[0]}</strong>
            {d.outcomeText.includes(' · ') ? ` · ${d.outcomeText.split(' · ').slice(1).join(' · ')}` : ''}
          </div>
        </div>
        <div>
          <div className="record-label">Basis</div>
          <div>{d.basis}</div>
        </div>
        <div>
          <div className="record-label" style={{ marginBottom: 4 }}>Evidence cited</div>
          <Sources items={d.evidence} max={4} />
        </div>
      </div>
      {!compact && (d.provisions.length > 0 || d.approvals.length > 0 || d.letter) && (
        <div className="record-foot">
          {d.provisions.length > 0 && <span><span className="muted">Provisions </span>{d.provisions.join(' · ')}</span>}
          {d.approvals.length > 0 && <span><span className="muted">Approvals </span>{d.approvals.join(' · ')}</span>}
          {d.letter && <span><span className="muted">Letter </span>{d.letter}</span>}
        </div>
      )}
    </section>
  )
}
