import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchClaims } from '../api/claims'
import { useQuery } from '../api/useQuery'
import { Icon } from '../components/Icon'
import { homeFor, useSession } from './session'

interface Item {
  id: string
  label: string
  hint: string
  icon: string
  run: () => void
}

/** ⌘K reaches any claim, person, policy or action. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const navigate = useNavigate()
  const { user, personas, switchUser, openTab } = useSession()
  const { data: claims } = useQuery(() => searchClaims(q), [q])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      navigate(to)
      onClose()
    }
    const claimItems: Item[] = (claims ?? []).map((c) => ({
      id: c.id,
      label: `${c.name}`,
      hint: `${c.id} · ${c.product}${c.benefitLines[0] ? ` · ${c.benefitLines[0].ref}` : ''}`,
      icon: 'document',
      run: () => {
        openTab(c.id)
        go(`/claims/${c.id}`)()
      },
    }))
    const s = q.trim().toLowerCase()
    const actions: Item[] = [
      { id: 'a-work', label: 'My work', hint: 'Go to your queue', icon: 'queue', run: go('/work') },
      { id: 'a-team', label: 'Team board', hint: 'Approvals, workload, at risk', icon: 'team', run: go('/team') },
      { id: 'a-intake', label: 'New claim intake', hint: 'Disability income, by phone', icon: 'intake', run: go('/intake') },
      { id: 'a-intake-life', label: 'New life claim intake', hint: 'Notice of death, by phone · shows the workflow and SLAs', icon: 'intake', run: go('/intake/life') },
      { id: 'a-insights', label: 'Insights', hint: 'Operations dashboard', icon: 'insights', run: go('/insights') },
      { id: 'a-portal', label: 'Claimant portal', hint: 'What Elena Vasquez sees on her phone', icon: 'external', run: go('/portal') },
      ...personas.filter((u) => u.id !== user.id).map((u) => ({
        id: `u-${u.id}`,
        label: `Switch to ${u.name}`,
        hint: u.title,
        icon: 'user',
        run: () => {
          switchUser(u.id)
          go(homeFor(u))()
        },
      })),
    ].filter((a) => !s || `${a.label} ${a.hint}`.toLowerCase().includes(s))
    return [...claimItems, ...actions]
  }, [claims, q, navigate, onClose, openTab, switchUser, user.id, personas])

  useEffect(() => setActive(0), [q])

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      items[active]?.run()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const claimCount = claims?.length ?? 0
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Claim number, person, policy or contract, or an action"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `pi-${items[active].id}` : undefined}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul id="palette-list" role="listbox" className="palette-list">
          {items.map((it, i) => (
            <li key={it.id}>
              {(i === 0 && claimCount > 0) && <div className="palette-group">Claims</div>}
              {i === claimCount && <div className="palette-group">Go to</div>}
              <div
                id={`pi-${it.id}`}
                role="option"
                aria-selected={i === active}
                className="palette-item"
                onMouseEnter={() => setActive(i)}
                onClick={it.run}
              >
                <Icon name={it.icon} size={14} color="var(--ink-3)" />
                <span className="strong">{it.label}</span>
                <span className="muted ellipsis">{it.hint}</span>
              </div>
            </li>
          ))}
          {items.length === 0 && <li className="muted" style={{ padding: 16 }}>Nothing matches “{q}”.</li>}
        </ul>
      </div>
    </>
  )
}
