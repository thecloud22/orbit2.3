import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../../api/useQuery'
import { listDecisions } from '../../api/decisions'
import { listRequirements } from '../../api/requirements'
import { ELECTION_LABELS, listShares, recordElection, type DistributionShare, type ElectionOption } from '../../api/distributions'
import { fmtDate } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { cx } from '../../lib/cx'
import { DecisionRecordView } from '../../components/DecisionRecordView'
import { Drawer } from '../../components/Drawer'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag, Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Distributions.css'

/** Options for a non-qualified annuity death benefit. Deadlines run from the date of death. */
const OPTIONS: { key: ElectionOption; title: string; line: string; detail: string; spouseOnly?: boolean }[] = [
  { key: 'lump', title: 'Lump sum', line: 'Whole gain taxed in one year', detail: 'Paid in one payment once the share is valued. The whole $127,500.00 gain is ordinary income for the year it is paid. 10% federal withholding applies unless a W-4R elects otherwise.' },
  { key: 'fiveYear', title: 'Within 5 years', line: 'Fully paid by 3 Sep 2031', detail: 'Any schedule of withdrawals, as long as the share is fully paid by 3 Sep 2031. The share stays invested meanwhile; gain is taxed as it is withdrawn.' },
  { key: 'lifeExpectancy', title: 'Over her life expectancy', line: 'Must start by 3 Sep 2027', detail: 'Payments at least once a year over her life expectancy, using the IRS single-life table. The first must be paid by 3 Sep 2027 — one year after the death. Part of each payment is a tax-free return of basis.' },
  { key: 'continue', title: 'Continue as owner', line: 'Spouse only · not available', detail: 'Only a surviving spouse can keep the contract going as the new owner. Claire is Evelyn’s daughter, so this option does not apply.', spouseOnly: true },
]

/** Distributions: each annuity beneficiary is valued, elects and is paid separately. */
export function DistributionsSection({ claim, onQuick }: SectionProps) {
  const { data: shares, loading } = useQuery(() => listShares(claim.id), [claim.id])
  const { data: reqs } = useQuery(() => listRequirements(claim.id), [claim.id])
  const { data: records } = useQuery(() => listDecisions(claim.id), [claim.id])
  const [drawer, setDrawer] = useState<DistributionShare | null>(null)

  const head = (
    <div className="page-head ds-head">
      <h2>Distributions</h2>
      <span className="aside">Each beneficiary is valued, elects and is paid separately</span>
      <span className="grow" />
      <button type="button" className="btn btn--sm" onClick={() => onQuick('call')}><Icon name="phone" size={13} />Log call</button>
      <button type="button" className="btn btn--sm" onClick={() => onQuick('note')}><Icon name="pencil" size={13} />Add note</button>
      <button type="button" className="btn btn--sm" onClick={() => onQuick('task')}><Icon name="plus" size={13} />New task</button>
    </div>
  )

  if (loading && !shares) return <>{head}<Loading rows={6} /></>
  if (claim.detail?.kind !== 'annuity' || !shares?.length) {
    return (
      <>
        {head}
        <div className="empty">No beneficiary distributions on this claim. Distributions appear once an annuity death benefit is approved and shared between beneficiaries.</div>
      </>
    )
  }

  const d = claim.detail
  const benefit = Math.max(...d.deathBenefit.map((r) => r.amount))
  const basis = 400_000
  const n = shares.length
  const reqMet = (name: string) => (reqs ?? []).some((r) => r.from.includes(name.split(' ')[0]) && r.id.includes('claire') && (r.state === 'met' || r.state === 'waived'))
  const inGoodOrder = (s: DistributionShare) => !!s.goodOrder || reqMet(s.beneficiary)
  const open = shares.filter((s) => !s.election)
  const decision = records?.[0]

  return (
    <div className="ds">
      {head}

      <section className="section" aria-labelledby="ds-db-h">
        <div className="section-head">
          <h3 id="ds-db-h">Death benefit</h3>
          <span className="aside">Greater of contract value and the guaranteed minimum death benefit (GMDB)</span>
        </div>
        <div className="ds-pair">
          <table className="tbl tbl--middle">
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
          <table className="tbl tbl--middle">
            <thead><tr><th /><th className="r">Contract</th><th className="r">Per {Math.round(100 / n)}% share</th></tr></thead>
            <tbody>
              <tr><td>Death benefit</td><td className="r">{fmtMoney(benefit)}</td><td className="r">{fmtMoney(benefit / n)}</td></tr>
              <tr><td>Cost basis</td><td className="r">{fmtMoney(basis)}</td><td className="r">{fmtMoney(basis / n)}</td></tr>
            </tbody>
            <tfoot><tr><td>Taxable gain</td><td className="r">{fmtMoney(benefit - basis)}</td><td className="r">{fmtMoney((benefit - basis) / n)}</td></tr></tfoot>
          </table>
        </div>
        <p className="sub">{d.shareNote}</p>
      </section>

      <section className="section" aria-labelledby="ds-bn-h">
        <div className="section-head">
          <h3 id="ds-bn-h">Beneficiaries</h3>
          <span className="aside">Designation on file · 50% each</span>
        </div>
        <div className="ds-scroll">
          <table className="tbl ds-bn">
            <thead><tr><th>Beneficiary</th><th className="r">Share</th><th>Good order</th><th>Election</th><th className="r">Amount</th><th>Tax</th><th>Status</th></tr></thead>
            <tbody>
              {shares.map((s) => (
                <tr key={s.id}>
                  <td><div style={{ fontWeight: 700 }}>{s.beneficiary}</div><div className="sub">{s.relationship}</div></td>
                  <td className="r">{s.share}</td>
                  <td>{inGoodOrder(s) ? <Tag tone="positive">{s.goodOrder ? fmtDate(s.goodOrder) : 'Forms received'}</Tag> : <span className="ds-missing"><Tag tone="caution">Not in good order</Tag><span className="sub">{s.missing}</span></span>}</td>
                  <td>{s.election ?? <span className="muted">Not chosen</span>}</td>
                  <td className="r nowrap">{s.amountNote && <div className="sub">{s.amountNote}</div>}{s.amount}</td>
                  <td>{s.tax}{s.taxNote && <div className="sub">{s.taxNote}</div>}</td>
                  <td><StatusTag status={s.status} />{s.statusNote && <div className="sub" style={{ marginTop: 3 }}>{s.statusNote}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {open.map((s) => {
        const ok = inGoodOrder(s)
        const first = s.beneficiary.split(' ')[0]
        return (
          <section key={s.id} className="section" aria-labelledby={`ds-opt-${s.id}`}>
            <div className="section-head">
              <h3 id={`ds-opt-${s.id}`}>Options open to {first}</h3>
              <span className="aside">Non-qualified contract · deadlines run from the date of death, 3 Sep 2026</span>
            </div>
            <ul className="ds-options">
              {OPTIONS.map((o) => {
                const na = o.spouseOnly && !s.spouse
                return (
                  <li key={o.key} className={cx('ds-option', na && 'ds-option--na')}>
                    <strong>{o.title}</strong>
                    <span className="sub">{o.line}</span>
                  </li>
                )
              })}
            </ul>
            <div className="ds-elect">
              <button type="button" className="btn btn--primary btn--sm" disabled={!ok} onClick={() => setDrawer(s)} aria-describedby={`ds-why-${s.id}`}>
                Record {first}’s election
              </button>
              <span id={`ds-why-${s.id}`} className="sub grow">
                {ok ? `${first}’s claim is in good order. Record the option she chose on her signed election form.` : `Available once ${first} is in good order — ${s.missing ? s.missing.charAt(0).toLowerCase() + s.missing.slice(1) : 'forms missing'}. Her share stays invested until then.`}
              </span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDrawer(s)}>How the options work</button>
              {!ok && <Link className="btn btn--sm" to={`/claims/${claim.id}/communications/LTR-A-210`}>Send reminder with options guide</Link>}
            </div>
          </section>
        )
      })}

      <section className="section" aria-labelledby="ds-tax-h">
        <div className="section-head">
          <h3 id="ds-tax-h">Tax reporting</h3>
          <span className="aside">Each beneficiary gets their own forms</span>
        </div>
        <div className="ds-pair">
          <div className="ds-note">
            <strong>1099-R</strong>
            <p className="soft">Issued to each beneficiary for the year they are paid, under their own taxpayer ID. Nathan’s 2026 form shows a gross distribution of $327,500.00, taxable amount $127,500.00, federal tax withheld $12,750.00, distribution code 4 (death). No 10% early-distribution penalty applies.</p>
          </div>
          <div className="ds-note">
            <strong>W-4R</strong>
            <p className="soft">Lump sums and other non-periodic payments default to 10% federal withholding on the taxable gain. A beneficiary can choose any rate from 0% to 100% on Form W-4R. Claire’s W-9 is still missing, so without it backup withholding would apply to her gain.</p>
          </div>
        </div>
      </section>

      {decision && <DecisionRecordView d={decision} />}

      {drawer && <ElectionDrawer share={drawer} goodOrder={inGoodOrder(drawer)} claimId={claim.id} onClose={() => setDrawer(null)} />}
    </div>
  )
}

/** Explains each option and, once the beneficiary is in good order, records her election. */
function ElectionDrawer({ share, goodOrder, claimId, onClose }: { share: DistributionShare; goodOrder: boolean; claimId: string; onClose: () => void }) {
  const { user } = useSession()
  const toast = useToast()
  const [choice, setChoice] = useState<ElectionOption | null>(null)
  const [signed, setSigned] = useState(false)
  const [busy, setBusy] = useState(false)
  const first = share.beneficiary.split(' ')[0]

  async function submit() {
    if (!choice) return
    setBusy(true)
    try {
      await recordElection({ claimId, shareId: share.id, option: choice, by: user.name, goodOrder })
      toast(`${first}’s election recorded: ${ELECTION_LABELS[choice].toLowerCase()} · logged`)
      onClose()
    } catch (e) {
      toast((e as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <Drawer title={goodOrder ? `Record ${first}’s election` : `${first}’s options`} onClose={onClose} width={560} footer={
      goodOrder ? (
        <>
          <span className="sub grow">Logged with your name. Her share is valued on her good-order date.</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={!choice || !signed || busy}>{busy ? 'Recording…' : 'Record election'}</button>
        </>
      ) : (
        <>
          <span className="sub grow">Recording opens once {first} is in good order.</span>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </>
      )
    }>
      {!goodOrder && (
        <div className="ds-blocked" role="note">
          <Tag tone="caution">Not in good order</Tag>
          <span>{share.missing}. Until they arrive, {first}’s half stays invested and is guaranteed at least {fmtMoney(327_500)}.</span>
        </div>
      )}
      <p className="soft">A non-qualified annuity’s death benefit must be paid out under federal rules. Deadlines run from Evelyn’s date of death, 3 Sep 2026.</p>
      <fieldset className="ds-fieldset" disabled={!goodOrder}>
        <legend className="sr-only">Election</legend>
        {OPTIONS.map((o) => {
          const na = o.spouseOnly && !share.spouse
          return (
            <label key={o.key} className={cx('ds-choice', choice === o.key && 'ds-choice--on', na && 'ds-choice--na')}>
              <input type="radio" name="election" disabled={na || !goodOrder} checked={choice === o.key} onChange={() => setChoice(o.key)} />
              <span>
                <strong>{o.title}</strong> <span className="sub">· {o.line}</span>
                <span className="ds-choice-detail">{o.detail}</span>
              </span>
            </label>
          )
        })}
      </fieldset>
      {goodOrder && (
        <label className="ds-check">
          <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} />
          {first}’s signed election form is on file
        </label>
      )}
    </Drawer>
  )
}
