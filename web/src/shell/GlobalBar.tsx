import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { ClaimsMark, Icon } from '../components/Icon'
import { Avatar } from '../components/Avatar'
import { homeFor, useSession } from './session'

export function GlobalBar({ onSearch }: { onSearch: () => void }) {
  const { user, personas, switchUser } = useSession()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  const nav =
    user.role === 'teamLead'
      ? [['/team', 'Team'], ['/work', 'My work'], ['/insights', 'Insights']]
      : [['/work', 'My work'], ['/intake', 'Intake'], ['/insights', 'Insights']]

  return (
    <header className="gbar">
      <NavLink to={homeFor(user)} className="gbar-brand" aria-label="Claims home">
        <ClaimsMark />
        <span>Claims</span>
      </NavLink>
      <nav aria-label="Primary" className="gbar-nav">
        {nav.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive || (to === '/work' && pathname.startsWith('/claims/')) ? 'active' : undefined)}>
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="grow" />
      <button type="button" className="gbar-search" onClick={onSearch} aria-label="Search claims, people, policies and documents (⌘K)">
        <Icon name="search" size={14} />
        <span className="grow">Search claims, people, policies, documents</span>
        <kbd>⌘K</kbd>
      </button>
      <div style={{ display: 'flex', gap: 2 }}>
        <button type="button" className="gbar-icon" aria-label="Notifications, 3 new">
          <Icon name="bell" />
          <span className="gbar-badge">3</span>
        </button>
        <button type="button" className="gbar-icon" aria-label="Help and keyboard shortcuts">
          <Icon name="help" />
        </button>
      </div>
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button type="button" className="gbar-account" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} aria-label={`Account: ${user.name}, ${user.title}. Switch demo persona`}>
          <Avatar initials={user.initials} size={26} dark />
          <span className="gbar-account-text">
            <span>{user.name}</span>
            <span>{user.title}</span>
          </span>
          <Icon name="chevronDown" size={12} color="#A9ADB3" />
        </button>
        {menu && (
          <div className="menu" role="menu" style={{ right: 0, top: 40, width: 280 }}>
            <div className="menu-label">Sign in as (demo)</div>
            {personas.map((u) => (
              <button
                key={u.id}
                type="button"
                role="menuitemradio"
                aria-checked={u.id === user.id}
                className="menu-item"
                onClick={() => {
                  switchUser(u.id)
                  setMenu(false)
                  navigate(homeFor(u))
                }}
              >
                <Avatar initials={u.initials} />
                <span className="grow" style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="strong">{u.name}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{u.title}</span>
                </span>
                {u.id === user.id && <Icon name="decision" size={14} color="var(--accent)" />}
              </button>
            ))}
            <div className="menu-sep" />
            <div className="menu-label">Outside the company</div>
            <a className="menu-item" role="menuitem" href="#/portal" onClick={() => setMenu(false)}>
              <Icon name="external" size={14} />
              Claimant portal (phone)
            </a>
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="menu-item" onClick={() => window.location.reload()}>
              <Icon name="undo" size={14} />
              Reset demo data
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
