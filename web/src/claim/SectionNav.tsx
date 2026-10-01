import { NavLink } from 'react-router-dom'
import type { Claim, SectionKey } from '../api/types'
import { sectionLabel } from '../api/claims'
import { Icon } from '../components/Icon'
import type { ClaimCounts } from './useCounts'

const ICONS: Record<SectionKey, string> = {
  overview: 'overview', workflow: 'flow', policies: 'shield', people: 'people', requirements: 'checklist', documents: 'document',
  contestable: 'pulse', medical: 'medical', financials: 'chart', decision: 'decision', payments: 'payments',
  distributions: 'split', 'case-plan': 'plan', communications: 'message', history: 'history',
}

function badge(key: SectionKey, claim: Claim, n?: ClaimCounts) {
  if (!n) return null
  switch (key) {
    case 'policies': return <span className="sn-count">{claim.benefitLines.length}</span>
    case 'people': return <span className="sn-count">{claim.parties.length}</span>
    case 'requirements':
      if (n.reqLate) return <span className="count-badge count-badge--critical">{n.reqLate} late</span>
      if (n.reqOpen) return <span className="count-badge count-badge--caution">{n.reqOpen} open</span>
      return n.reqTotal ? <span className="sn-count">all met</span> : null
    case 'documents': return n.docsNew ? <span className="count-badge count-badge--info">{n.docsNew} {claim.live ? 'to review' : 'new'}</span> : n.docsTotal ? <span className="sn-count">{n.docsTotal}</span> : null
    case 'decision': {
      const lines = claim.benefitLines.length
      if (n.toDecide && !n.decided) return <span className="sn-count">to decide</span>
      return n.decided ? <span className="sn-count">{Math.min(n.decided, lines)} of {lines}</span> : null
    }
    case 'payments': return n.paid ? <span className="sn-count">{n.paid} paid</span> : n.scheduled ? <span className="sn-count">{n.scheduled} scheduled</span> : null
    case 'communications': return n.comms ? <span className="sn-count">{n.comms}</span> : null
    default: return null
  }
}

export function SectionNav({ claim, counts, onTasks }: { claim: Claim; counts?: ClaimCounts; onTasks: () => void }) {
  return (
    <nav aria-label="Claim sections" className="sn">
      {claim.sections.map((key) => (
        <NavLink key={key} to={`/claims/${claim.id}/${key}`} className={({ isActive }) => `sn-item${isActive ? ' active' : ''}`}>
          <Icon name={ICONS[key]} color="currentColor" />
          <span className="grow">{sectionLabel(claim, key)}</span>
          {badge(key, claim, counts)}
        </NavLink>
      ))}
      {!claim.live && (
        <button type="button" className="sn-item" onClick={onTasks}>
          <Icon name="tasks" />
          <span className="grow">Tasks</span>
          {counts && counts.tasksOpen > 0 && <span className="sn-count">{counts.tasksOpen}</span>}
        </button>
      )}
      <div className="sn-note">
        {claim.family === 'disability' && !claim.sections.includes('payments')
          ? 'Payments and Case plan appear once a decision is recorded.'
          : 'Reconsideration and Investigation appear when one is opened.'}
      </div>
      {claim.linked.length > 0 && (
        <div className="sn-note sn-linked">
          <span className="strong" style={{ color: 'var(--ink-3)' }}>Linked records</span>
          {claim.linked.map((l) => <span key={l} className="sn-link">{l}</span>)}
        </div>
      )}
    </nav>
  )
}
