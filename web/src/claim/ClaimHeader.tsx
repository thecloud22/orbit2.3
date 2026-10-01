import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Claim, SectionKey } from '../api/types'
import { personName } from '../api/users'
import { sectionLabel } from '../api/claims'
import { Avatar } from '../components/Avatar'
import { Clock } from '../components/Clock'
import { Icon } from '../components/Icon'
import { StageTracker } from '../components/StageTracker'
import { StatusTag, Tag } from '../components/Tag'

export type QuickAction = 'call' | 'note' | 'task'

/** Status · Owner · Due · Exceptions — the same four facts, in the same order, on every claim. */
export function ClaimHeader({ claim, section, onQuick }: { claim: Claim; section: SectionKey; onQuick: (a: QuickAction) => void }) {
  const owner = personName(claim.ownerId)
  const next = claim.nextStep
  const doingIt = next.section === section
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  return (
    <header className="ch">
      <div className="ch-top">
        <div className="ch-id">
          <div className="ch-title">
            <h1>{claim.name}</h1>
            <span className="mono ch-num">{claim.id}</span>
            <Tag>{claim.product}</Tag>
            {claim.tags.map((t) => <StatusTag key={t.label} status={t} />)}
          </div>
          <div className="ch-facts">
            {claim.facts.map((f, i) => (
              <span key={f}>
                {i > 0 && <span aria-hidden="true" className="ch-bar">|</span>}
                {f}
              </span>
            ))}
          </div>
        </div>
        <div className="ch-owner">
          <span className="sub">Owner</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Avatar initials={owner.initials} />
            <span style={{ fontWeight: 600 }}>{owner.name}</span>
          </span>
          <span className="sub">{claim.team}</span>
        </div>
        <div className="ch-next">
          <span className="sub">Next step</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {doingIt ? (
              <span className="ch-inprogress" title={`In progress: ${next.label}`}>
                <span className="ch-pulse" aria-hidden="true" />
                <span className="ellipsis">In progress: {next.label.charAt(0).toLowerCase() + next.label.slice(1)}</span>
              </span>
            ) : (
              <Link className="btn btn--primary ch-next-btn" title={next.label} to={`/claims/${claim.id}/${next.section}${next.target ? `/${next.target}` : ''}`}>
                <span className="ellipsis">{next.label}</span>
                <Icon name="arrowRight" size={12} strokeWidth={1.6} />
              </Link>
            )}
            <div ref={menuRef} style={{ position: 'relative' }}>
              <button type="button" className="btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                More actions <Icon name="chevronDown" size={12} />
              </button>
              {menu && (
                <div className="menu" role="menu" style={{ right: 0, top: 36, width: 230 }}>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); onQuick('call') }}><Icon name="phone" size={14} />Log call</button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); onQuick('note') }}><Icon name="pencil" size={14} />Add note</button>
                  <button type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); onQuick('task') }}><Icon name="plus" size={14} />New task</button>
                  <div className="menu-sep" />
                  <span className="menu-item" aria-disabled="true" style={{ color: 'var(--ink-4)' }}>Open reconsideration · after a decision</span>
                  <span className="menu-item" aria-disabled="true" style={{ color: 'var(--ink-4)' }}>Refer to SIU · needs a reason</span>
                </div>
              )}
            </div>
          </div>
          <span className="sub" style={{ color: 'var(--ink-2)' }}>
            {doingIt ? next.reason : next.reason}
            {!doingIt && <span className="sr-only"> · opens {sectionLabel(claim, next.section)}</span>}
          </span>
        </div>
      </div>
      <div className="ch-bottom">
        <StageTracker steps={claim.stage} />
        <span className="grow" />
        <div style={{ display: 'flex', gap: 28 }}>
          {claim.clocks.map((c) => <Clock key={c.id} clock={c} />)}
        </div>
      </div>
    </header>
  )
}
