import { useCallback, useState } from 'react'
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '../api/useQuery'
import { getClaim } from '../api/claims'
import { listDocuments } from '../api/documents'
import { personName } from '../api/users'
import {
  addTreatingDoctor, listClaimantAsks, logPortalEvent, textPhysicianNote, uploadClaimantDocuments, uploadSpec,
  type PortalAsk, type UploadedFile,
} from '../api/portal'
import { fmtDate, fmtTime, nowStamp, TODAY } from '../lib/dates'
import { BackLink, ContactRow, Done, PhoneApp, PtIcon, PtLoading, Sheet, Tracker } from './parts'
import { Messages } from './Messages'

const CLAIM = 'D-26-073390'
const NAME = 'Elena Vasquez'
const BASE = '/portal/elena'
const ACTOR = `${NAME} · portal`

/** Elena Vasquez, DI claimant (boards 07.2 and 07.3): status, the doctor's statement, and uploads. */
export function ElenaApp() {
  const { data: asks } = useQuery(() => listClaimantAsks(CLAIM), [])
  return (
    <PhoneApp base={BASE} account={NAME} taskCount={asks?.length}>
      <Routes>
        <Route index element={<ElenaHome asks={asks} />} />
        <Route path="tasks" element={<ElenaTasks asks={asks} />} />
        <Route path="tasks/doctor" element={<DoctorTask />} />
        <Route path="tasks/upload/:key" element={<UploadTask />} />
        <Route path="payments" element={<ElenaPayments />} />
        <Route path="messages" element={<Messages claimId={CLAIM} from={NAME} team="Jordan Ellis, your case manager" />} />
      </Routes>
    </PhoneApp>
  )
}

/** Board 07.2 — claim tracker, what we need, and the case manager. */
function ElenaHome({ asks }: { asks?: PortalAsk[] }) {
  const { data: claim } = useQuery(() => getClaim(CLAIM), [])
  if (!claim || !asks) return <div className="pt-page"><PtLoading /></div>
  const cm = personName(claim.ownerId)
  const n = asks.length
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Hi Elena</h1>
      <section className="pt-card pt-stack-10" aria-labelledby="pt-claim-h">
        <div className="pt-card-head">
          <h2 id="pt-claim-h" className="pt-h2">
            Disability income
          </h2>
          <span className="pt-mono">{claim.id}</span>
        </div>
        <Tracker
          steps={[
            { label: 'Submitted', state: 'done', meta: fmtDate(claim.filed) },
            {
              label: 'Gathering information',
              state: 'current',
              detail: n === 0 ? 'We have what we need from you. We’ll tell you when we hear from your doctor.' : `We’re waiting on the ${n === 1 ? 'thing' : `${n} things`} below`,
            },
            { label: 'Decision', state: 'todo', detail: 'We’ll decide within 30 days of receiving everything; we’ll write to you every 30 days until then.' },
            { label: 'Payments', state: 'todo', meta: 'Start after approval' },
          ]}
        />
      </section>

      <AsksCard asks={asks} />
      <RecentlyReceived />

      <ContactRow initials={cm.initials} role="Your case manager" name={cm.name} messagesTo={`${BASE}/messages`} />
    </div>
  )
}

/** "What we need from you" — live from the claim's open requirements. */
function AsksCard({ asks }: { asks: PortalAsk[] }) {
  if (asks.length === 0)
    return (
      <Done title="Nothing needed from you right now">
        <span className="pt-soft">We’ll write to you by 24 Oct, or sooner if anything changes.</span>
      </Done>
    )
  return (
    <section className="pt-need" aria-labelledby="pt-need-h">
      <h2 id="pt-need-h" className="pt-need-h">
        <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1 9.4 8.8H.6Z" fill="currentColor" />
        </svg>
        What we need from you
      </h2>
      <ul className="pt-need-list">
        {asks.map((a) =>
          a.kind === 'doctor' ? (
            <li key={a.id} className="pt-need-item pt-stack-10">
              <div>
                <h3 className="pt-h3">{a.title}</h3>
                <p className="pt-soft">{a.body}</p>
              </div>
              <Link to={`${BASE}/tasks/doctor`} className="pt-btn pt-btn--primary">
                See how you can help
                <PtIcon name="arrowRight" size={16} strokeWidth={1.6} />
              </Link>
            </li>
          ) : (
            <li key={a.id} className="pt-need-item">
              <h3 className="pt-h3">
                <Link to={`${BASE}/tasks/upload/${a.id}`} className="pt-need-link">
                  {a.title}
                  <span className="pt-chev">
                    <PtIcon name="chevronRight" size={16} strokeWidth={1.8} />
                  </span>
                </Link>
              </h3>
              <p className="pt-soft">{a.body}</p>
            </li>
          ),
        )}
      </ul>
    </section>
  )
}

/** Documents Elena sent through the portal, as a receipt. */
function RecentlyReceived() {
  const { data } = useQuery(() => listDocuments(CLAIM), [])
  const mine = (data ?? []).filter((d) => d.channel === 'Portal' && d.received === TODAY)
  if (mine.length === 0) return null
  return (
    <section className="pt-stack-4" aria-labelledby="pt-got-h">
      <h2 id="pt-got-h" className="pt-h3">
        We received
      </h2>
      <ul className="pt-list">
        {mine.map((d) => (
          <li key={d.id} className="pt-got">
            <PtIcon name="check" />
            <span className="grow">{d.title}</span>
            <span className="pt-soft">{fmtDate(d.received)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ElenaTasks({ asks }: { asks?: PortalAsk[] }) {
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Tasks</h1>
      {asks ? <AsksCard asks={asks} /> : <PtLoading />}
      <RecentlyReceived />
    </div>
  )
}

/** Board 07.3 — help with a missing doctor's statement: three ways to help. */
function DoctorTask() {
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<'note' | 'doctor' | null>(null)
  const [texted, setTexted] = useState<string>()
  const [added, setAdded] = useState<string>()
  const close = useCallback(() => setSheet(null), [])

  return (
    <div className="pt-page">
      <BackLink to={BASE} label="Home" />
      <h1 className="pt-h1 pt-h1--lg">Help us get your doctor’s statement</h1>
      <section className="pt-stack-2">
        <h2 className="pt-h3">Why we need it</h2>
        <p>It tells us how your condition affects your work. We can’t make a decision without it.</p>
      </section>
      <section className="pt-stack-2">
        <h2 className="pt-h3">What we’ve done</h2>
        <ul className="pt-checks">
          <li><PtIcon name="check" size={16} strokeWidth={1.8} />Asked Dr. Hsu’s office on 26 Aug</li>
          <li><PtIcon name="check" size={16} strokeWidth={1.8} />Asked again on 5 Sep and 16 Sep</li>
        </ul>
      </section>

      <section className="pt-stack-8" aria-labelledby="pt-ways-h">
        <h2 id="pt-ways-h" className="pt-h2">
          Three ways you can help
        </h2>
        <ol className="pt-ways">
          <li className="pt-way pt-stack-10">
            <div>
              <h3 className="pt-way-h"><span className="pt-num-dot">1</span>Ask the office to send it</h3>
              <p className="pt-soft">We’ll text you a short note to forward to Dr. Hsu’s office.</p>
            </div>
            <button type="button" className="pt-btn pt-btn--primary" onClick={() => setSheet('note')}>
              Text me the note
            </button>
            {texted && <p className="pt-ok"><PtIcon name="check" size={16} strokeWidth={1.8} />Texted to your phone at {texted}</p>}
          </li>
          <li className="pt-way">
            <h3 className="pt-way-h"><span className="pt-num-dot">2</span>Upload visit notes you already have</h3>
            <div className="pt-way-row">
              <p className="pt-soft">Photos are fine.</p>
              <button type="button" className="pt-btn" onClick={() => navigate(`${BASE}/tasks/upload/visit-notes`)}>
                <PtIcon name="upload" />
                Upload files
              </button>
            </div>
          </li>
          <li className="pt-way">
            <h3 className="pt-way-h"><span className="pt-num-dot">3</span>Add another doctor</h3>
            <div className="pt-way-row">
              <p className="pt-soft">If someone else is treating you.</p>
              <button type="button" className="pt-btn" onClick={() => setSheet('doctor')}>
                Add a doctor
              </button>
            </div>
            {added && <p className="pt-ok"><PtIcon name="check" size={16} strokeWidth={1.8} />Added {added}. We’ll contact them.</p>}
          </li>
        </ol>
      </section>

      <p className="pt-callout">
        <PtIcon name="info" />
        We’ll keep your claim open and write to you every 30 days while we wait.
      </p>

      {sheet === 'note' && <TextNoteSheet onClose={close} onSent={() => setTexted(fmtTime(nowStamp()))} />}
      {sheet === 'doctor' && <AddDoctorSheet onClose={close} onAdded={setAdded} />}
    </div>
  )
}

function TextNoteSheet({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [done, setDone] = useState(false)
  async function send() {
    await textPhysicianNote(CLAIM, NAME, 'Dr. Hsu')
    setDone(true)
    onSent()
  }
  return (
    <Sheet
      title={done ? 'Note sent' : 'Text me the note'}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--block" onClick={onClose}>Done</button>
        ) : (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--block" onClick={() => void send()}>Text it to ••• 0192</button>
        )
      }
    >
      {done ? (
        <Done title="We texted the note to your phone ending 0192">
          <span className="pt-soft">Forward it to Dr. Hsu’s office, or show it at the front desk at your next visit.</span>
        </Done>
      ) : (
        <p className="pt-soft">We’ll send this to your phone ending 0192. You can forward it to the office or show it at the front desk.</p>
      )}
      <blockquote className="pt-quote">
        Hello, I’m Dr. Hsu’s patient Elena Vasquez. My insurer, [Carrier], needs the attending physician statement they sent on 26 Aug. Please fax it to (555) 010-2090 or send it through their provider portal, reference D-26-073390. Thank you.
      </blockquote>
    </Sheet>
  )
}

function AddDoctorSheet({ onClose, onAdded }: { onClose: () => void; onAdded: (name: string) => void }) {
  const [name, setName] = useState('')
  const [practice, setPractice] = useState('')
  const [phone, setPhone] = useState('')
  const [done, setDone] = useState(false)
  async function add() {
    await addTreatingDoctor(CLAIM, NAME, { name: name.trim(), practice: practice.trim(), phone: phone.trim() })
    setDone(true)
    onAdded(name.trim())
  }
  return (
    <Sheet
      title={done ? 'Doctor added' : 'Add a doctor'}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="pt-btn pt-btn--primary pt-btn--block" onClick={onClose}>Done</button>
        ) : (
          <button type="submit" form="pt-doc-form" className="pt-btn pt-btn--primary pt-btn--block" disabled={!name.trim()}>Add this doctor</button>
        )
      }
    >
      {done ? (
        <Done title={`We’ll contact ${name.trim()}`}>
          <span className="pt-soft">Jordan Ellis will ask their office for a statement within 2 business days. You don’t need to get any forms.</span>
        </Done>
      ) : (
        <form id="pt-doc-form" className="pt-stack-12" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void add() }}>
          <div className="pt-field">
            <label className="pt-label" htmlFor="pt-doc-name">Doctor’s name</label>
            <input id="pt-doc-name" className="pt-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="pt-field">
            <label className="pt-label" htmlFor="pt-doc-practice">Practice or clinic <span className="pt-soft">(optional)</span></label>
            <input id="pt-doc-practice" className="pt-input" value={practice} onChange={(e) => setPractice(e.target.value)} />
          </div>
          <div className="pt-field">
            <label className="pt-label" htmlFor="pt-doc-phone">Office phone <span className="pt-soft">(optional)</span></label>
            <input id="pt-doc-phone" className="pt-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </form>
      )}
    </Sheet>
  )
}

/** Upload flow — the 2024 tax return and P&L, or visit notes. Satisfies the matching requirements. */
function UploadTask() {
  const { key = '' } = useParams()
  const spec = uploadSpec(key)
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ titles: string[]; met: string[] }>()
  const [paulCan, setPaulCan] = useState(false)

  if (!spec) return <div className="pt-page"><BackLink to={BASE} label="Home" /><p>That task isn’t available.</p></div>

  const add = (slotId: string, list: FileList | null) => {
    if (!list) return
    setFiles((f) => [...f, ...Array.from(list).map((x) => ({ slotId, fileName: x.name, pages: Math.max(1, Math.round(x.size / 90_000)) }))])
  }
  const addSamples = () =>
    setFiles((f) => [...f, ...spec.slots.filter((s) => !f.some((x) => x.slotId === s.id)).map((s) => ({ slotId: s.id, fileName: s.sampleName, pages: s.pages }))])

  async function send() {
    setSending(true)
    const r = await uploadClaimantDocuments({ claimId: CLAIM, uploadKey: key, files, by: ACTOR, party: `${NAME} · portal upload` })
    const titles = spec!.slots.filter((s) => files.some((f) => f.slotId === s.id)).map((s) => s.docTitle)
    setResult({ titles, met: r.met })
    setSending(false)
  }

  async function letPaul() {
    await logPortalEvent(CLAIM, ACTOR, 'Consent given: Paul Hendricks may send financial documents', 'Agent of record · 2024 tax return and monthly P&L')
    setPaulCan(true)
  }

  if (result)
    return (
      <div className="pt-page">
        <h1 className="pt-h1">Thank you, Elena</h1>
        <Done title="We received your documents">
          <ul className="pt-got-list">
            {result.titles.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </Done>
        <section className="pt-stack-4">
          <h2 className="pt-h3">What happens next</h2>
          {key === 'financials' ? (
            <p>Hugo Brenner, our financial analyst, will use them to work out your partial benefit. Jordan Ellis will tell you if anything else is needed.</p>
          ) : (
            <p>Our clinical team will read them with the rest of your file. We’ll still ask Dr. Hsu’s office for her statement.</p>
          )}
        </section>
        <Link to={BASE} className="pt-btn pt-btn--primary">Back to home</Link>
      </div>
    )

  return (
    <div className="pt-page">
      <BackLink to={BASE} label="Home" />
      <h1 className="pt-h1 pt-h1--lg">{spec.title}</h1>
      <p className="pt-soft">{spec.why}</p>

      {spec.slots.map((s) => {
        const mine = files.filter((f) => f.slotId === s.id)
        return (
          <section key={s.id} className="pt-card pt-stack-8" aria-labelledby={`pt-slot-${s.id}`}>
            <div>
              <h2 id={`pt-slot-${s.id}`} className="pt-h3">{s.label}</h2>
              <p className="pt-soft pt-small">{s.hint}</p>
            </div>
            {mine.length > 0 && (
              <ul className="pt-list">
                {mine.map((f, i) => (
                  <li key={`${f.fileName}-${i}`} className="pt-file">
                    <PtIcon name="doc" />
                    <span className="grow pt-file-name">{f.fileName}</span>
                    <button type="button" className="pt-link" onClick={() => setFiles((all) => all.filter((x) => x !== f))} aria-label={`Remove ${f.fileName}`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="pt-btn pt-file-pick">
              <PtIcon name="upload" />
              {mine.length ? 'Add another file' : 'Choose a file or take a photo'}
              <input type="file" accept=".pdf,image/*" multiple className="sr-only" onChange={(e) => { add(s.id, e.target.files); e.target.value = '' }} />
            </label>
          </section>
        )
      })}

      <button type="button" className="pt-link pt-demo-link" onClick={addSamples}>
        Demo: attach sample files
      </button>

      {key === 'financials' && (
        <section className="pt-well pt-stack-8" aria-labelledby="pt-someone-h">
          <h2 id="pt-someone-h" className="pt-h3">Someone else can send them</h2>
          <p className="pt-soft">Your accountant, or your agent Paul Hendricks, can upload them for you.</p>
          {paulCan ? (
            <p className="pt-ok"><PtIcon name="check" size={16} strokeWidth={1.8} />Paul Hendricks can now send them. We’ve let him know.</p>
          ) : (
            <button type="button" className="pt-btn" onClick={() => void letPaul()}>Let Paul Hendricks send them</button>
          )}
        </section>
      )}

      <button type="button" className="pt-btn pt-btn--primary" disabled={files.length === 0 || sending} onClick={() => void send()}>
        {files.length ? `Send ${files.length} file${files.length > 1 ? 's' : ''}` : 'Send'}
      </button>
    </div>
  )
}

/** Payments before a decision: what to expect. */
function ElenaPayments() {
  return (
    <div className="pt-page">
      <h1 className="pt-h1">Payments</h1>
      <section className="pt-card pt-stack-8">
        <h2 className="pt-h2">Payments start after approval</h2>
        <p>Your policy pays up to <strong>$12,000.00 a month</strong>. Because you’re working two days a week, we’ll pay part of it. Hugo Brenner works out how much from your profit and loss statements.</p>
        <p className="pt-soft">Your waiting period ended on 10 Sep, so once we approve, the first payment covers from then.</p>
      </section>
      <section className="pt-well pt-stack-4">
        <h2 className="pt-h3">Tax</h2>
        <p className="pt-soft">Benefits are generally not taxable when you pay the premiums yourself.</p>
      </section>
    </div>
  )
}
