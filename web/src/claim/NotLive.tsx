import type { SectionKey } from '../api/types'

/**
 * A section the backend has no data for yet. In live mode it takes the place of the mock's version, so nothing on the
 * screen is invented: it says what is missing and what the backend needs to provide.
 */
export function NotLive({ title, needs, section }: { title: string; needs: string[]; section: SectionKey }) {
  return (
    <div className="nl" data-not-live={section}>
      <div className="page-head">
        <h2>{title}</h2>
        <span className="aside">Live mode · not available yet</span>
      </div>
      <div className="planned">
        <h3>{title} is not on the backend yet</h3>
        <p className="soft">This claim is read from the real backend, and it has no {title.toLowerCase()} data to show. Nothing here is made up in its place.</p>
        <ul className="nl-list">
          {needs.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </div>
    </div>
  )
}
