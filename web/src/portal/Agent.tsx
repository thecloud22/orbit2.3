import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import {
  getAnnuityShare, listAgentClients, listAgentUpdates, listClaimantAsks, logAgentAction, uploadClaimantDocuments, uploadSpec,
  type AgentClientRow, type UploadedFile,
} from '../api/portal'
import { HART } from '../api/fixtures/portal'
import { Tag } from '../components/Tag'
import { Icon } from '../components/Icon'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toasts'
import { daysUntil, fmtDate } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import { cx } from '../lib/cx'

const AGENT = 'Paul Hendricks'
const ACTOR = `${AGENT} · agent portal`

/** Board 07.7 — the agent-of-record portal: client claims, consent-scoped, status and what's needed only. */
export function AgentPortal() {
  const toast = useToast()
  const { data: rows } = useQuery(() => listAgentClients(AGENT), [])
  const { data: updates } = useQuery(() => listAgentUpdates(), [])
  const [selected, setSelected] = useState<string | null>('A-26-015530')
  const [q, setQ] = useState('')
  const [consentOpen, setConsentOpen] = useState(false)

  const shown = (rows ?? []).filter((r) => `${r.client} ${r.claimId} ${r.ref}`.toLowerCase().includes(q.trim().toLowerCase()))
  const help = (rows ?? []).filter((r) => r.needsHelp)
  const sel = rows?.find((r) => r.claimId === selected)
  const notInMock = (what: string) => toast(`${what} isn’t part of this mock.`)

  return (
    <div className="pt-agent">
      <header className="pt-ag-top">
        <div className="pt-ag-brand">
          <span className="pt-wordmark">[Carrier]</span>
          <span className="pt-ag-for">for financial professionals</span>
        </div>
        <nav className="pt-ag-nav" aria-label="Agent portal">
          <button type="button" onClick={() => notInMock('Home')}>Home</button>
          <Link to="/portal/agent" aria-current="page">Client claims</Link>
          <Link to="/portal/new/death">Report a claim</Link>
          <button type="button" onClick={() => notInMock('Documents')}>Documents</button>
          <button type="button" onClick={() => notInMock('Resources')}>Resources</button>
        </nav>
        <div className="pt-ag-who">
          <span className="soft">Hendricks Financial Group</span>
          <span className="pt-ag-user">
            <Avatar initials="PH" size={28} />
            <strong>{AGENT}</strong>
          </span>
        </div>
      </header>

      <div className="pt-ag-body">
        <main className="pt-ag-main">
          <div className="pt-ag-head">
            <div>
              <h1>Client claims</h1>
              <p className="soft">Claims on policies you service, shown with each client’s consent · updated 09:14</p>
            </div>
            <label className="pt-ag-search">
              <Icon name="search" />
              <input type="search" aria-label="Find a client or claim" placeholder="Find a client or claim" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
          </div>

          <div className="pt-ag-consent">
            <Icon name="lock" />
            <span className="grow">You see what your clients have allowed: status, dates and what’s needed. Never medical records or diagnoses.</span>
            <button type="button" className="btn btn--ghost btn--sm" aria-expanded={consentOpen} onClick={() => setConsentOpen(!consentOpen)}>How consent works</button>
          </div>
          {consentOpen && (
            <p className="pt-ag-consent-more">
              A client (or, after a death, the claimant) chooses what you can see — usually status and requirements. They can change it any time by calling us or in their portal.
              Claims appear here only while consent is on file. Medical records, diagnoses and tax IDs are never shared.
            </p>
          )}

          {help.length > 0 && (
            <section className="section" aria-labelledby="pt-help-h">
              <div className="pt-ag-h2">
                <h2 id="pt-help-h">Needs your help</h2>
                <span className="count-badge count-badge--caution">{help.length}</span>
              </div>
              <div className="pt-ag-help">
                {help.map((r) => (
                  <div key={r.claimId} className="pt-ag-helpcard">
                    <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true" className="pt-ag-tri"><path d="M5 1 9.4 8.8H.6Z" fill="currentColor" /></svg>
                    <div className="grow">
                      <strong>{r.needsHelp!.title}</strong>
                      <span className="pt-ag-sub">{r.needsHelp!.sub}</span>
                    </div>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSelected(r.claimId)}>{r.action}</button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="section" aria-labelledby="pt-all-h">
            <div className="pt-ag-h2">
              <h2 id="pt-all-h">All client claims</h2>
              <span className="muted">{rows?.length ?? ''}</span>
              <span className="grow" />
              <span className="sub">Since = date of death, or when the disability began</span>
            </div>
            <table className="tbl pt-ag-table">
              <thead>
                <tr>
                  <th>Client</th><th>Claim</th><th>Product</th><th>Status</th><th>Since</th><th>What’s needed</th><th>Your action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.claimId} className={cx(selected === r.claimId && 'pt-ag-row--on')} onClick={() => setSelected(r.claimId)}>
                    <td>
                      <button type="button" className="pt-ag-client" onClick={() => setSelected(r.claimId)} aria-pressed={selected === r.claimId}>{r.client}</button>
                      {r.deceased && <span className="sub pt-block">Deceased</span>}
                    </td>
                    <td><span className="mono">{r.claimId}</span><span className="sub-mono pt-block">{r.ref}</span></td>
                    <td>{r.product}</td>
                    <td>
                      <Tag tone={r.status.tone}>{r.status.label}</Tag>
                      {r.statusNote && <span className="sub pt-block">{r.statusNote}</span>}
                    </td>
                    <td className="nowrap">{fmtDate(r.since)}</td>
                    <td className={cx(/^(nothing|none)/i.test(r.needed) && 'muted')}>{r.needed}</td>
                    <td>
                      {r.action === 'None' || !r.needsHelp ? (
                        <span className={cx(r.action === 'None' ? 'muted' : 'soft', 'pt-ag-plain')}>{r.action}</span>
                      ) : (
                        <>
                          <button type="button" className={cx('btn btn--sm', r.claimId === 'A-26-015530' ? '' : 'btn--ghost')} onClick={(e) => { e.stopPropagation(); setSelected(r.claimId) }}>{r.action}</button>
                          {r.actionNote && <span className="sub pt-block">{r.actionNote}</span>}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="section" aria-labelledby="pt-upd-h">
            <div className="pt-ag-h2"><h2 id="pt-upd-h">Recent updates</h2></div>
            <table className="tbl pt-ag-updates">
              <tbody>
                {(updates ?? []).map((u, i) => (
                  <tr key={`${u.at}-${i}`}>
                    <td className="nowrap">{fmtDate(u.at)}</td>
                    <td className="strong nowrap">{u.client}</td>
                    <td>{u.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </main>

        {sel && (
          <aside className="pt-ag-panel" aria-label={`${sel.client} details`}>
            {sel.claimId === 'A-26-015530' ? <ClairePanel row={sel} onClose={() => setSelected(null)} /> : sel.claimId === 'D-26-073390' ? <ElenaPanel row={sel} onClose={() => setSelected(null)} /> : <GenericPanel row={sel} onClose={() => setSelected(null)} />}
          </aside>
        )}
      </div>
    </div>
  )
}

function PanelHead({ kicker, title, onClose, children }: { kicker: string; title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="pt-ag-phead">
      <div className="pt-ag-kicker">
        <span className="grow">{kicker}</span>
        <button type="button" className="btn btn--quiet btn--xs" aria-label="Close details" onClick={onClose}><Icon name="close" /></button>
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  )
}

/** Claire's options — what the agent can help her with, never her tax ID. */
function ClairePanel({ row, onClose }: { row: AgentClientRow; onClose: () => void }) {
  const { data: share } = useQuery(() => getAnnuityShare(HART.claimId, HART.beneficiary), [])
  const [done, setDone] = useState<string>()
  const days = daysUntil(HART.lifeExpectancyBy)
  const forms = share
    ? [
        { label: 'Claimant statement', ok: share.statement },
        { label: 'W-9 (taxpayer ID)', ok: share.w9 },
        { label: 'Election form (her chosen option)', ok: !!share.election },
      ]
    : []
  const inOrder = share?.statement && share.w9
  async function act(title: string, detail: string, msg: string) {
    await logAgentAction(HART.claimId, AGENT, title, detail, `${AGENT} → Claire Hart-Lopez · agent portal`)
    setDone(msg)
  }
  return (
    <>
      <div className="pt-ag-pbody">
        <PanelHead kicker={`Evelyn Hart’s annuity · VA-2201946 · ${row.claimId}`} title="Claire Hart-Lopez — options for her share" onClose={onClose}>
          <div className="pt-ag-tags">
            <Tag tone={inOrder ? 'positive' : 'caution'}>{inOrder ? 'In good order' : 'Not in good order'}</Tag>
            <span className="soft">Daughter · 50% beneficiary</span>
          </div>
        </PanelHead>
        <section className="pt-ag-psec">
          <h3>What’s protected</h3>
          <p className="pt-ag-big">At least <strong className="num">{fmtMoney(HART.guaranteed)}</strong></p>
          <dl className="pt-ag-dl">
            <dt>Guaranteed death benefit</dt><dd className="num">{fmtMoney(HART.total)} in total</dd>
            <dt>Market value of her half</dt><dd className="num">{fmtMoney(HART.marketOn22Sep)} on 22 Sep</dd>
          </dl>
          <p>Today’s market value of her half is lower, so the guarantee applies if her forms arrive now. Until they do, her share stays invested and its value changes daily.</p>
        </section>
        <section className="pt-ag-psec">
          <h3>Her options</h3>
          <ol className="pt-ag-opts">
            <li><span className="pt-ag-n">1</span><div><strong>Lump sum</strong><span className="pt-block">One payment once her claim is in good order.</span></div></li>
            <li><span className="pt-ag-n">2</span><div><strong>Within 5 years</strong><span className="pt-block">Paid on the schedule she chooses, all of it by 3 Sep 2031.</span></div></li>
            <li><span className="pt-ag-n">3</span><div><strong>Over her life expectancy</strong><span className="pt-block">Payments spread over her expected lifetime.</span>
              <span className="pt-ag-must"><span className="muted">Must start by</span><strong>3 Sep 2027 · {days} days</strong></span>
              <span className="meter pt-ag-meter"><span style={{ width: `${Math.round((1 - days / 365) * 100)}%` }} /></span>
            </div></li>
          </ol>
          <p className="sub">Continuing the contract as the new owner is open only to a spouse.</p>
        </section>
        <section className="pt-ag-psec">
          <h3>Forms still needed from Claire</h3>
          <ul className="pt-ag-forms">
            {forms.map((f) => (
              <li key={f.label}>
                <span className="grow">{f.label}</span>
                {f.ok ? <Tag tone="positive">Received</Tag> : <Tag tone="caution">Not received</Tag>}
              </li>
            ))}
          </ul>
          <p className="callout-info"><Icon name="help" /><span>We can’t give tax advice. Claire may want to talk with a tax professional before she chooses.</span></p>
          <Link to="/portal/claire/tasks" className="pt-ag-link">Preview what Claire sees</Link>
        </section>
        {done && <p className="pt-ag-done" role="status"><Icon name="decision" />{done}</p>}
      </div>
      <div className="pt-ag-pfoot">
        <button type="button" className="btn btn--primary btn--lg" onClick={() => void act('Options guide shared with Claire', 'Annuity death benefit options guide (plain language), sent by her agent', 'Options guide sent to Claire. It’s logged on the claim.')}>Share the options guide with Claire</button>
        <button type="button" className="btn btn--lg" onClick={() => void act('Call with Claire requested', 'Paul Hendricks asked to schedule a call with Claire about her options', 'Call request sent. Claire picks a time in her portal.')}>Schedule a call</button>
      </div>
    </>
  )
}

/** Elena's needed documents — Paul can send them with her consent. */
function ElenaPanel({ row, onClose }: { row: AgentClientRow; onClose: () => void }) {
  const { data: asks } = useQuery(() => listClaimantAsks(row.claimId), [])
  const spec = uploadSpec('financials')!
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [sent, setSent] = useState<string[]>()
  const fin = asks?.find((a) => a.id === 'financials')
  async function send() {
    const r = await uploadClaimantDocuments({ claimId: row.claimId, uploadKey: 'financials', files, by: ACTOR, party: `${AGENT} · agent portal, with Elena’s consent` })
    setSent(r.met.length ? r.met : files.map((f) => spec.slots.find((s) => s.id === f.slotId)!.docTitle))
    setFiles([])
  }
  return (
    <div className="pt-ag-pbody">
      <PanelHead kicker={`Disability income · DI-1507791 · ${row.claimId}`} title="Elena Vasquez — documents" onClose={onClose}>
        <div className="pt-ag-tags"><Tag tone={row.status.tone}>{row.status.label}</Tag><span className="soft">Consent 25 Aug · status and requirements</span></div>
      </PanelHead>
      <section className="pt-ag-psec">
        <h3>What’s needed from Elena</h3>
        {fin ? <p>{fin.title.replace('Upload your', 'Her')}.</p> : <p className="muted">Nothing you can send. Her claim is waiting on her doctor’s office.</p>}
        <p className="sub">You can’t see medical records, diagnoses or the doctor’s statement.</p>
      </section>
      {sent && <p className="pt-ag-done" role="status"><Icon name="decision" />Sent: {sent.join(', ')}. Jordan Ellis sees them now.</p>}
      {fin && (
        <section className="pt-ag-psec">
          <h3>Send on her behalf</h3>
          {spec.slots.map((s) => {
            const f = files.find((x) => x.slotId === s.id)
            return (
              <div key={s.id} className="pt-ag-slot">
                <div className="grow"><strong>{s.label}</strong><span className="sub pt-block">{f ? f.fileName : s.hint}</span></div>
                {f ? (
                  <button type="button" className="btn btn--quiet btn--sm" onClick={() => setFiles(files.filter((x) => x !== f))}>Remove</button>
                ) : (
                  <label className="btn btn--sm">
                    <Icon name="upload" />Choose file
                    <input type="file" className="sr-only" onChange={(e) => { const x = e.target.files?.[0]; if (x) setFiles([...files, { slotId: s.id, fileName: x.name, pages: 1 }]) }} />
                  </label>
                )}
              </div>
            )
          })}
          <div className="pt-ag-row">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setFiles(spec.slots.map((s) => ({ slotId: s.id, fileName: s.sampleName, pages: s.pages })))}>Demo: attach sample files</button>
            <span className="grow" />
            <button type="button" className="btn btn--primary" disabled={!files.length} onClick={() => void send()}>Send to Jordan Ellis</button>
          </div>
        </section>
      )}
    </div>
  )
}

function GenericPanel({ row, onClose }: { row: AgentClientRow; onClose: () => void }) {
  return (
    <div className="pt-ag-pbody">
      <PanelHead kicker={`${row.product} · ${row.ref} · ${row.claimId}`} title={row.client} onClose={onClose}>
        <div className="pt-ag-tags"><Tag tone={row.status.tone}>{row.status.label}</Tag>{row.deceased && <span className="soft">Deceased</span>}</div>
      </PanelHead>
      <section className="pt-ag-psec">
        <dl className="pt-ag-dl">
          <dt>Status</dt><dd>{row.statusNote || row.status.label}</dd>
          <dt>Since</dt><dd>{fmtDate(row.since, { year: true })}</dd>
          <dt>What’s needed</dt><dd>{row.needed}</dd>
          <dt>Your action</dt><dd>{row.action}</dd>
          <dt>What you can see</dt><dd>{row.consent}</dd>
        </dl>
      </section>
    </div>
  )
}
