import { StatusTag } from '../../components/Tag'
import type { SectionProps } from './types'

/** Everyone on the claim and what they may see. Agents of record see status, never medical detail. */
export function PeopleSection({ claim }: SectionProps) {
  return (
    <>
      <div className="page-head">
        <h2>People &amp; roles</h2>
        <span className="aside">{claim.parties.length} people and organizations</span>
      </div>
      <table className="tbl">
        <thead>
          <tr><th>Name</th><th>Roles</th><th>Relationship · share</th><th>Status</th><th>Contact or access</th></tr>
        </thead>
        <tbody>
          {claim.parties.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="strong">{p.name}</div>
                {p.note && <div className="sub">{p.note}</div>}
              </td>
              <td>{p.roles.join(' · ')}</td>
              <td>{[p.relationship, p.share].filter(Boolean).join(' · ') || <span className="muted">—</span>}</td>
              <td>{p.status ? <StatusTag status={p.status} /> : <span className="muted">—</span>}</td>
              <td>{p.access ? <span><span className="muted">Can see: </span>{p.access}</span> : p.contact ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
