import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { getQueue } from '../api/work'
import { claimSummary } from '../api/claims'
import { Icon } from '../components/Icon'
import { useSession } from './session'

function surname(name: string) {
  return name.split(' ').slice(-1)[0]
}

/** Open claims stay here beside the queue, so switching is one click and nothing is lost. */
export function WorkspaceTabs() {
  const { user, tabs, closeTab } = useSession()
  const { data: queue } = useQuery(() => getQueue(user.id), [user.id])
  const { pathname } = useLocation()
  const navigate = useNavigate()

  return (
    <nav aria-label="Open work" className="wtabs">
      <NavLink to="/work" className={({ isActive }) => `wtab wtab--queue${isActive ? ' active' : ''}`}>
        <Icon name="queue" size={14} />
        Queue
        <span className="count-badge count-badge--pill">{queue?.length ?? '–'}</span>
      </NavLink>
      {tabs.map((id) => {
        const c = claimSummary(id)
        if (!c) return null
        const active = pathname.startsWith(`/claims/${id}`)
        const openExceptions = c.exceptions.filter((x) => x.status === 'open').length
        return (
          <div key={id} className={`wtab${active ? ' active' : ''}`}>
            <NavLink to={`/claims/${id}`} aria-current={active ? 'page' : undefined}>
              {openExceptions > 0 && (
                <svg width="11" height="11" viewBox="0 0 10 10" role="img" aria-label="Has exceptions">
                  <path d="M5 1 9.4 8.8H.6Z" fill="#B7781A" />
                </svg>
              )}
              {surname(c.name)} <span className="mono wtab-id">{id}</span>
            </NavLink>
            <button
              type="button"
              aria-label={`Close ${surname(c.name)} claim`}
              className="wtab-close"
              onClick={() => {
                closeTab(id)
                if (active) navigate('/work')
              }}
            >
              <Icon name="close" size={10} />
            </button>
          </div>
        )
      })}
    </nav>
  )
}
