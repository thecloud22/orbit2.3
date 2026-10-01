import { Link } from 'react-router-dom'
import type { Claim } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import { listDecisions } from '../../api/decisions'
import { listRequirements } from '../../api/requirements'
import { listDocuments } from '../../api/documents'
import { fmtDate } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { DecisionRecordView } from '../../components/DecisionRecordView'
import { Icon } from '../../components/Icon'
import { StatusTag, Tag } from '../../components/Tag'
import type { SectionProps } from './types'

export function OverviewSection({ claim, onQuick }: SectionProps) {
  const { data: decisions } = useQuery(() => listDecisions(claim.id), [claim.id])
  return (
    <>
      <div className="page-head">
        <h2>Overview</h2>
        <span className="aside">
          Rolled up from {claim.benefitLines.length} benefit line{claim.benefitLines.length > 1 ? 's' : ''} · updated {claim.summary.asOf.split(' · ')[0]}
          {claim.totalLine && <> · <span data-total-line>{claim.totalLine}</span></>}
        </span>
        <span className="grow" />
        <button type="button" className="btn btn--sm" onClick={() => onQuick('call')}><Icon name="phone" size={13} />Log call</button>
        <button type="button" className="btn btn--sm" onClick={() => onQuick('note')}><Icon name="pencil" size={13} />Add note</button>
        <button type="button" className="btn btn--sm" onClick={() => onQuick('task')}><Icon name="plus" size={13} />New task</button>
      </div>

      {claim.light && (
        <div className="ov-light">
          <Icon name="help" size={14} />
          This claim is a light record in the mock — it carries the header, next step and one benefit line so queue links work.
        </div>
      )}

      {claim.detail?.kind === 'annuity' ? <AnnuityBlocks claim={claim} /> : <BenefitLines claim={claim} />}

      {claim.detail?.kind === 'life' && <LifeBlocks claim={claim} />}
      {claim.detail?.kind === 'disability' && <DisabilityBlocks claim={claim} />}
      {claim.light && <p style={{ maxWidth: 720, lineHeight: 1.5 }}>{claim.summary.text}</p>}

      {decisions && decisions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {decisions.map((d) => <DecisionRecordView key={d.id} d={d} />)}
        </div>
      )}
    </>
  )
}

function BenefitLines({ claim }: { claim: Claim }) {
  return (
    <section className="section" aria-labelledby="bl-h">
      <div className="section-head">
        <h3 id="bl-h">Benefit lines</h3>
        <span className="aside">Each policy and rider has its own status, decision and clock</span>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Benefit</th>
            <th className="r">Amount</th>
            <th>Status</th>
            <th>Paid / held</th>
            <th>Waiting on</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          {claim.benefitLines.map((b) => (
            <tr key={b.id}>
              <td>
                <div className="strong">{b.name}</div>
                <div className="sub-mono">{b.ref}{b.refNote ? ` · ${b.refNote}` : ''}</div>
              </td>
              <td className="r">
                <div>{b.amount != null ? fmtMoney(b.amount) : '—'}</div>
                {b.amountNote && <div className="sub">{b.amountNote}</div>}
              </td>
              <td><StatusTag status={b.status} /></td>
              <td>
                {b.paid && <div>{b.paid}</div>}
                {b.held && <div className="sub" style={{ color: 'var(--caution-ink)', fontWeight: 600 }}>{b.held}</div>}
                {!b.paid && !b.held && <span className="muted">—</span>}
              </td>
              <td>{b.waitingOn ?? <span className="muted">—</span>}</td>
              <td>{b.due ?? <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function LifeBlocks({ claim }: { claim: Claim }) {
  const beneficiaries = claim.parties.filter((p) => p.roles.includes('Beneficiary') || p.roles.includes('Assignee'))
  const note = claim.detail?.kind === 'life' ? claim.detail.beneficiaryNote : ''
  return (
    <div className="ov-grid">
      <section className="section" aria-labelledby="bn-h">
        <div className="section-head">
          <h3 id="bn-h">Beneficiaries</h3>
          <span className="aside">{note}</span>
        </div>
        <table className="tbl tbl--middle">
          <thead><tr><th>Name</th><th>Relationship</th><th className="r">Share</th><th>Status</th></tr></thead>
          <tbody>
            {beneficiaries.map((p) => (
              <tr key={p.id}>
                <td className="strong" style={{ fontWeight: 600 }}>{p.name}</td>
                <td>{p.relationship ?? p.roles.join(', ')}</td>
                <td className="r">{p.share ?? '—'}</td>
                <td>{p.status ? <StatusTag status={p.status} /> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <Evidence claim={claim} />
    </div>
  )
}

function Evidence({ claim }: { claim: Claim }) {
  const { data: reqs } = useQuery(() => listRequirements(claim.id), [claim.id])
  const { data: docs } = useQuery(() => listDocuments(claim.id), [claim.id])
  const met = (reqs ?? []).filter((r) => r.state === 'met' || r.state === 'waived').length
  const total = reqs?.length ?? 0
  const open = (reqs ?? []).filter((r) => r.state !== 'met' && r.state !== 'waived').slice(0, 3)
  const fresh = (docs ?? []).filter((d) => d.isNew).slice(0, 2)
  return (
    <section className="section" aria-labelledby="ev-h">
      <div className="section-head">
        <h3 id="ev-h">Evidence</h3>
        <Link to={`/claims/${claim.id}/requirements`} style={{ fontSize: 12, fontWeight: 600 }}>All requirements</Link>
      </div>
      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 28 }}>
          <span className="strong nowrap">{met} of {total} met</span>
          <div className="meter grow" aria-hidden="true"><span style={{ width: `${(met / total) * 100}%` }} /></div>
        </div>
      )}
      <ul className="ov-evidence" style={{ borderTop: '1px solid var(--line)' }}>
        {fresh.map((d) => (
          <li key={d.id}>
            <Tag tone="info">{claim.live ? 'Under review' : 'New today'}</Tag>
            <span className="grow ellipsis">{d.title}</span>
            <Link to={`/claims/${claim.id}/documents/${d.id}`} className="strong" style={{ fontSize: 12 }}>Review</Link>
          </li>
        ))}
        {open.map((r) => (
          <li key={r.id}>
            <StatusTag status={r.status} />
            <span className="grow ellipsis">{r.name} <span className="muted">· {r.from}</span></span>
            {r.due && <span className="sub nowrap">due {fmtDate(r.due)}</span>}
          </li>
        ))}
        {fresh.length + open.length === 0 && total > 0 && (
          <li><Tag tone="positive">All met</Tag><span className="soft">Nothing outstanding</span></li>
        )}
        {total === 0 && <li className="muted">No requirements recorded in the mock for this claim.</li>}
      </ul>
    </section>
  )
}

function DisabilityBlocks({ claim }: { claim: Claim }) {
  if (claim.detail?.kind !== 'disability') return null
  const d = claim.detail
  const blocks: [string, [string, string][], string][] = [
    ['Medical', d.medical, 'medical'],
    ['Work & the business', d.work, 'people'],
    ['Money', d.money, claim.sections.includes('payments') ? 'payments' : 'policies'],
  ]
  return (
    <div className="ov-cards">
      {blocks.map(([title, rows, to]) => (
        <section key={title} className="ov-card" aria-label={title}>
          <h3>
            {title}
            <Link to={`/claims/${claim.id}/${to}`} style={{ fontSize: 12, fontWeight: 600 }}>Open</Link>
          </h3>
          <dl className="dl">
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

function AnnuityBlocks({ claim }: { claim: Claim }) {
  if (claim.detail?.kind !== 'annuity') return null
  const d = claim.detail
  const benefit = Math.max(...d.deathBenefit.map((r) => r.amount))
  const beneficiaries = claim.parties.filter((p) => p.roles.includes('Beneficiary'))
  return (
    <>
      <section className="section" aria-labelledby="db-h">
        <div className="section-head">
          <h3 id="db-h">Death benefit</h3>
          <span className="aside">Greater of contract value and the guaranteed minimum death benefit (GMDB)</span>
        </div>
        <table className="tbl">
          <thead><tr><th>Greater of</th><th>Source</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {d.deathBenefit.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td><span className="source">{r.source}</span></td>
                <td className="r" style={{ fontWeight: r.greater ? 700 : 400 }}>{fmtMoney(r.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={2}>Death benefit — the greater</td><td className="r">{fmtMoney(benefit)}</td></tr></tfoot>
        </table>
      </section>
      <section className="section" aria-labelledby="sh-h">
        <div className="section-head">
          <h3 id="sh-h">Beneficiaries</h3>
          <Link to={`/claims/${claim.id}/distributions`} style={{ fontSize: 12, fontWeight: 600 }}>Distributions</Link>
        </div>
        <table className="tbl tbl--middle">
          <thead><tr><th>Beneficiary</th><th className="r">Share</th><th className="r">Amount</th><th>Status</th></tr></thead>
          <tbody>
            {beneficiaries.map((p) => (
              <tr key={p.id}>
                <td><div className="strong" style={{ fontWeight: 600 }}>{p.name}</div><div className="sub">{p.relationship}</div></td>
                <td className="r">{p.share}</td>
                <td className="r">{p.status?.tone === 'caution' ? `at least ${fmtMoney(benefit / 2)}` : fmtMoney(benefit / 2)}</td>
                <td>{p.status && <StatusTag status={p.status} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sub">{d.shareNote}</p>
      </section>
    </>
  )
}
