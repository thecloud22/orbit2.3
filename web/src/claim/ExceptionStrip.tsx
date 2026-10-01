import { Link } from 'react-router-dom'
import type { Claim } from '../api/types'
import { ToneShape } from '../components/Tag'

/** Exceptions sit in their own tinted strip under the header, each with its own resolve action. */
export function ExceptionStrip({ claim }: { claim: Claim }) {
  const open = claim.exceptions.filter((x) => x.status === 'open')
  if (open.length === 0) return null
  return (
    <section aria-label="Exceptions" className="xs">
      <div className="xs-count">
        <ToneShape tone="caution" size={12} />
        {open.length} exception{open.length > 1 ? 's' : ''}
      </div>
      <ul className="xs-list">
        {open.map((x) => (
          <li key={x.id}>
            <strong className="nowrap">{x.title}</strong>
            <span className="soft ellipsis">{x.detail}</span>
            <span className="grow" />
            <span className="xs-meta">{x.meta}</span>
            <Link className="btn btn--ghost btn--xs" to={`/claims/${claim.id}/${x.action.section}${x.action.target ? `/${x.action.target}` : ''}`}>
              {x.action.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
