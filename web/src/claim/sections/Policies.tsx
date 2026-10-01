import { sectionLabel } from '../../api/claims'
import { fmtMoney } from '../../lib/money'
import { StatusTag } from '../../components/Tag'
import type { SectionProps } from './types'

/** Policies, riders or annuity contracts — each benefit line with where it comes from. */
export function PoliciesSection({ claim }: SectionProps) {
  return (
    <>
      <div className="page-head">
        <h2>{sectionLabel(claim, 'policies')}</h2>
        <span className="aside">From policy administration · read only here</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
        {claim.benefitLines.map((b) => (
          <section key={b.id} className="ov-card" aria-label={b.name}>
            <h3>
              <span>{b.name}</span>
              <StatusTag status={b.status} />
            </h3>
            <dl className="dl">
              <dt>Number</dt><dd className="mono">{b.ref}</dd>
              {b.refNote && (<><dt>Detail</dt><dd>{b.refNote}</dd></>)}
              <dt>Amount</dt><dd>{b.amount != null ? fmtMoney(b.amount) : '—'}{b.amountNote ? ` · ${b.amountNote}` : ''}</dd>
              {b.waitingOn && (<><dt>Waiting on</dt><dd>{b.waitingOn}</dd></>)}
              {b.due && (<><dt>Due</dt><dd>{b.due}</dd></>)}
            </dl>
          </section>
        ))}
      </div>
      <p className="sub">Policy provisions, premium history and the application open from the source system in the full product.</p>
    </>
  )
}
