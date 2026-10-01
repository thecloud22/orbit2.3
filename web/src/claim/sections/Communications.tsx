import { useEffect, useMemo, useState } from 'react'
import type { Claim, Communication } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import { getPartyPreference, listCommunications, markAnswered, saveLetterDraft, sendLetter } from '../../api/communications'
import { listPayments } from '../../api/payments'
import { defaultTemplateFor, plainText, readingGrade, segments, templateById, templatesFor, TEMPLATES, type LetterTemplate } from '../../api/letters'
import { fmtDate, fmtRelativeDay, fmtTime, NOW_TIME } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Drawer } from '../../components/Drawer'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag, Tag } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import type { SectionProps } from './types'
import './Communications.css'

type Filter = 'all' | 'letters' | 'calls' | 'portal' | 'email'
const FILTERS: { key: Filter; label: string; match: (c: Communication) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'letters', label: 'Letters', match: (c) => c.channel === 'letter' || c.channel === 'document' },
  { key: 'calls', label: 'Calls', match: (c) => c.channel === 'call' },
  { key: 'portal', label: 'Portal', match: (c) => c.channel === 'portal' },
  { key: 'email', label: 'Email', match: (c) => c.channel === 'email' },
]
const PAGE = 10

function partyOf(c: Communication): string {
  return c.party.split(' · ')[0].replace(/^Call (with|from) /, '').replace(/’s office$/, '')
}

/** Which template (if any) replies to an inbound message. */
function replyTemplate(c: Communication): LetterTemplate | undefined {
  return TEMPLATES.find((t) => t.answers?.commId === c.id)
}

/** Communications: every letter, call, portal message, email and document for the claim, newest first. */
export function CommunicationsSection({ claim, target, onQuick }: SectionProps) {
  const { data: comms, loading } = useQuery(() => listCommunications(claim.id), [claim.id])
  const { data: pref } = useQuery(() => getPartyPreference(claim.id), [claim.id])
  const [filter, setFilter] = useState<Filter>('all')
  const [party, setParty] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [composer, setComposer] = useState<string | null>(null)
  const { user } = useSession()
  const toast = useToast()

  const claimTemplate = templatesFor(claim).find((t) => t.claimIds)
  const nextHere = claim.nextStep.section === 'communications'

  // Open the composer when routed to a template, asked for a new letter, or when the claim's next step is a letter.
  useEffect(() => {
    if (target && templateById(target)) setComposer(target)
    else if (target === 'new') setComposer(defaultTemplateFor(claim).id)
    else if (!target && nextHere && claimTemplate) setComposer(templateById(claim.nextStep.target)?.id ?? claimTemplate.id)
    // Only on arrival — not every time the claim changes underneath.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim.id, target])

  useEffect(() => { setVisible(PAGE); setFilter('all'); setParty('') }, [claim.id])

  const parties = useMemo(() => Array.from(new Set((comms ?? []).map(partyOf))), [comms])
  const byParty = (comms ?? []).filter((c) => !party || partyOf(c) === party)
  const current = FILTERS.find((f) => f.key === filter)!
  const list = byParty.filter(current.match)
  const shown = list.slice(0, visible)
  const earlier = list.length - shown.length

  async function answer(c: Communication) {
    await markAnswered(c.id, user.name)
    toast('Marked answered · logged')
  }

  return (
    <div className="cm">
      <div className="page-head cm-head">
        <h2>Communications</h2>
        <span className="aside">Newest first · all policies</span>
        <span className="grow" />
        <label className="sr-only" htmlFor="cm-party">Party</label>
        <select id="cm-party" className="select cm-party" value={party} onChange={(e) => { setParty(e.target.value); setVisible(PAGE) }}>
          <option value="">All parties</option>
          {parties.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {!claim.live && <button type="button" className="btn btn--sm" onClick={() => onQuick('call')}><Icon name="phone" size={13} />Log call</button>}
        {!claim.live && <button type="button" className="btn btn--primary btn--sm" onClick={() => setComposer(defaultTemplateFor(claim).id)}><Icon name="plus" size={13} />New letter</button>}
      </div>

      {claim.live && (
        <div className="callout-info">
          <Icon name="message" size={14} color="var(--accent)" />
          <span className="grow">These are the letters the backend has sent (acknowledgement, claim packets, agent notice, reminders). Calls, inbound mail and composing a letter are not on the backend yet.</span>
        </div>
      )}

      <div className="cm-filters" role="group" aria-label="Filter by channel">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className="chip-filter" aria-pressed={filter === f.key} onClick={() => { setFilter(f.key); setVisible(PAGE) }}>
            {f.label}<span className="count">{byParty.filter(f.match).length}</span>
          </button>
        ))}
      </div>

      {pref && (
        <div className="cm-pref">
          <Icon name="user" size={14} />
          <span><strong>{pref.party}</strong> — {pref.text}</span>
        </div>
      )}

      {nextHere && !claimTemplate && (
        <div className="callout-info">
          <Icon name="phone" size={16} color="var(--accent)" />
          <span className="grow"><strong>{claim.nextStep.label}.</strong> {claim.nextStep.reason}</span>
          <button type="button" className="btn btn--sm" onClick={() => onQuick('call')}>Log call</button>
        </div>
      )}

      {loading && !comms && <Loading rows={8} />}
      {comms && list.length === 0 && <div className="empty">Nothing here{party ? ` for ${party}` : ''} yet.</div>}

      <ol className="cm-list" aria-label="Communications timeline">
        {shown.map((c) => {
          const reply = c.direction === 'in' && c.status.tone === 'caution' ? replyTemplate(c) : undefined
          const isDraft = c.status.label === 'Draft'
          return (
            <li key={c.id} className={cx('cm-item', c.status.tone === 'caution' && c.direction === 'in' && 'cm-item--open', target === c.id && 'cm-item--target')}>
              <div className="cm-when">
                <span>{fmtRelativeDay(c.at)}</span>
                {fmtRelativeDay(c.at) === 'Today' || fmtRelativeDay(c.at) === 'Yesterday' ? <span className="sub">{fmtTime(c.at)}</span> : c.at.slice(0, 4) !== '2026' ? <span className="sub">{c.at.slice(0, 4)}</span> : null}
              </div>
              <div className="cm-icons" aria-hidden="true">
                <DirectionMark dir={c.direction} />
                <ChannelMark c={c} />
              </div>
              <div className="cm-body">
                <div className="cm-title">
                  <strong>{c.title}</strong>
                  {c.benefitLine && <Tag>{c.benefitLine}</Tag>}
                  {c.template && <span className="sub-mono">{c.template}</span>}
                  <span className="sr-only"> · {c.direction === 'in' ? 'inbound' : c.direction === 'out' ? 'outbound' : 'internal'} {c.channel}</span>
                </div>
                <div className="sub">{c.party}</div>
                {c.detail && c.detail !== 'Notes · Recording' && <div className="cm-detail">{c.detail}</div>}
              </div>
              <div className="cm-side">
                {c.detail === 'Notes · Recording' ? (
                  <span className="cm-links">
                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => toast('Call notes open from the call record (mock)')}>Notes</button>
                    <button type="button" className="btn btn--ghost btn--xs" onClick={() => toast('Recording plays from the call archive (mock)')}>Recording</button>
                  </span>
                ) : (
                  <StatusTag status={c.status} />
                )}
                {reply && <button type="button" className="btn btn--ghost btn--xs" onClick={() => setComposer(reply.id)}>Reply</button>}
                {!reply && c.direction === 'in' && c.status.label === 'Unanswered' && <button type="button" className="btn btn--quiet btn--xs" onClick={() => answer(c)}>Mark answered</button>}
                {isDraft && c.template && <button type="button" className="btn btn--ghost btn--xs" onClick={() => setComposer(c.template!)}>Open draft</button>}
              </div>
            </li>
          )
        })}
      </ol>
      {earlier > 0 && (
        <button type="button" className="btn btn--ghost btn--sm cm-more" onClick={() => setVisible((v) => v + PAGE)}>
          Show {Math.min(PAGE, earlier)} earlier <Icon name="chevronDown" size={12} />
        </button>
      )}

      {composer && <Composer claim={claim} templateId={composer} comms={comms ?? []} onClose={() => setComposer(null)} onTemplate={setComposer} />}
    </div>
  )
}

function DirectionMark({ dir }: { dir: Communication['direction'] }) {
  if (dir === 'internal') return <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {dir === 'in' ? <><path d="M12 4 4.5 11.5" /><path d="M4.5 6.5v5h5" /></> : <><path d="M4 12l7.5-7.5" /><path d="M6.5 4.5h5v5" /></>}
    </svg>
  )
}

function ChannelMark({ c }: { c: Communication }) {
  const fax = c.party.includes('fax')
  const s = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }
  if (c.channel === 'call') return <Icon name="phone" size={16} />
  if (c.channel === 'portal') return <Icon name="message" size={16} />
  if (c.channel === 'document') return <Icon name="document" size={16} />
  if (c.channel === 'note') return <Icon name="pencil" size={16} />
  if (fax) return <svg {...s}><path d="M4.5 6V2.5h7V6" /><rect x="2" y="6" width="12" height="5.5" rx="1" /><path d="M4.5 9.5h7v4h-7z" /></svg>
  if (c.channel === 'email') return <svg {...s}><circle cx="8" cy="8" r="2.5" /><path d="M10.5 8v1a1.75 1.75 0 0 0 3.5 0V8a6 6 0 1 0-2.4 4.8" /></svg>
  return <svg {...s}><rect x="2" y="3.5" width="12" height="9" rx="1" /><path d="m2.5 4.5 5.5 4 5.5-4" /></svg>
}

// ---------------------------------------------------------------- Composer

const EXTRA_ATTACHMENTS = ['Claim status summary', 'IRS Form W-9', 'IRS Form W-4R', 'Beneficiary options guide', 'HIPAA authorization']

/**
 * Letter composer: recipient and channels, template, merge fields, optional clauses, a live preview with
 * merge fields highlighted, attachments, reading level. Sending logs, answers the linked question and moves the claim on.
 */
function Composer({ claim, templateId, comms, onClose, onTemplate }: {
  claim: Claim
  templateId: string
  comms: Communication[]
  onClose: () => void
  onTemplate: (id: string) => void
}) {
  const { user } = useSession()
  const toast = useToast()
  const { data: payments } = useQuery(() => listPayments(claim.id), [claim.id])
  const tpl = templateById(templateId) ?? defaultTemplateFor(claim)
  const ctx = useMemo(() => ({ claim, payments: payments ?? [], sender: { name: user.name, title: user.title } }), [claim, payments, user])
  const options = templatesFor(claim)

  const recipients = Array.from(new Set([tpl.to(claim), ...claim.parties.filter((p) => !p.roles.includes('Insured') || p.roles.includes('Claimant')).map((p) => p.name)]))
  const [to, setTo] = useState(tpl.to(claim))
  const [channels, setChannels] = useState<string[]>(tpl.defaultChannels)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [clauses, setClauses] = useState<Record<string, boolean>>({})
  const [attachments, setAttachments] = useState<string[]>(tpl.attachments)
  const [adding, setAdding] = useState(false)
  const [note, setNote] = useState('')
  const question = tpl.answers ? comms.find((c) => c.id === tpl.answers!.commId) : undefined
  const canAnswer = !!question && !question.status.label.startsWith('Answered')
  const [answer, setAnswer] = useState(true)
  const [copyAgent, setCopyAgent] = useState(false)
  const [saved, setSaved] = useState<string | null>(comms.some((c) => c.id === `draft-${claim.id}-${tpl.id}`) ? 'earlier' : null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)

  // Reset when the template changes.
  const tplFields = tpl.fields(ctx)
  const fieldKey = `${tpl.id}:${tplFields.map((f) => f.value).join('|')}`
  useEffect(() => {
    setTo(tpl.to(claim))
    setChannels(tpl.defaultChannels)
    setFields(Object.fromEntries(tplFields.map((f) => [f.key, f.value])))
    setClauses(Object.fromEntries(tpl.clauses.map((c) => [c.id, c.on])))
    setAttachments(tpl.attachments)
    setNote('')
    setPreview(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey])

  const on = (id: string) => clauses[id] ?? tpl.clauses.find((c) => c.id === id)?.on ?? false
  const values = { ...Object.fromEntries(tplFields.map((f) => [f.key, f.value])), ...fields }
  let paragraphs = tpl.body(values, on, ctx)
  if (note.trim()) {
    const sign = paragraphs.findIndex((p) => p === 'With best wishes,')
    const at = sign >= 0 ? sign : paragraphs.length - 1
    paragraphs = [...paragraphs.slice(0, at), note.trim(), ...paragraphs.slice(at)]
  }
  const text = plainText(paragraphs, values)
  const grade = readingGrade(paragraphs.slice(1, -2).length ? plainText(paragraphs.slice(1, -2), values) : text)
  const filled = tplFields.filter((f) => (values[f.key] ?? '').trim()).length
  const allFilled = filled === tplFields.length
  const generic = !tpl.claimIds
  const canSend = allFilled && channels.length > 0 && to && (!generic || note.trim())
  const title = generic ? `Letter to ${to}` : tpl.title

  const args = () => ({ claimId: claim.id, templateId: tpl.id, title, to, channels, text, attachments, answer: canAnswer && answer, copyAgent: !!tpl.copyAgent && copyAgent, by: user.name })

  async function save() {
    await saveLetterDraft(args())
    setSaved(NOW_TIME)
    toast('Draft saved · shown in the timeline')
  }
  async function send() {
    setBusy(true)
    try {
      await sendLetter(args())
      toast(`Sent to ${to} by ${channels.join(' and ').toLowerCase()}${canAnswer && answer ? ' · portal question answered' : ''}`)
      onClose()
    } catch (e) {
      toast((e as Error).message)
    } finally { setBusy(false) }
  }

  const toggleChannel = (ch: string) => setChannels((cs) => (cs.includes(ch) ? cs.filter((x) => x !== ch) : [...cs, ch]))

  return (
    <Drawer
      width={620}
      onClose={onClose}
      title={<span className="cm-drawer-title">{tpl.kind === 'portal' ? 'New portal message' : 'New letter'} <Tag tone="neutral">Draft</Tag>{saved && <span className="sub">Saved {saved}</span>}</span>}
      footer={
        <>
          <span className="sub grow">Reading level grade {grade} · English</span>
          <button type="button" className="btn" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>{preview ? 'Edit' : 'Preview'}</button>
          <button type="button" className="btn" onClick={save}>Save draft</button>
          <button type="button" className="btn btn--primary" onClick={send} disabled={!canSend || busy}>{busy ? 'Sending…' : 'Send'}<Icon name="arrowRight" size={12} /></button>
        </>
      }
    >
      {preview ? (
        <LetterPreview claim={claim} tpl={tpl} to={to} channels={channels} paragraphs={paragraphs} values={values} attachments={attachments} />
      ) : (
        <>
          <div className="cm-row">
            <label className="cm-row-label" htmlFor="cm-to">To</label>
            <div className="cm-row-body cm-to">
              <select id="cm-to" className="select" value={to} onChange={(e) => setTo(e.target.value)}>
                {recipients.map((r) => <option key={r}>{r}</option>)}
              </select>
              <span className="cm-channels" role="group" aria-label="Channels">
                {tpl.channels.map((ch) => (
                  <label key={ch} className={cx('cm-channel', channels.includes(ch) && 'cm-channel--on')}>
                    <input type="checkbox" checked={channels.includes(ch)} onChange={() => toggleChannel(ch)} />
                    {ch}
                  </label>
                ))}
              </span>
            </div>
          </div>
          <div className="cm-row">
            <label className="cm-row-label" htmlFor="cm-tpl">Template</label>
            <div className="cm-row-body">
              <select id="cm-tpl" className="select cm-tpl" value={tpl.id} onChange={(e) => onTemplate(e.target.value)}>
                {options.map((t) => <option key={t.id} value={t.id}>{t.title} · {t.id}</option>)}
              </select>
            </div>
          </div>
          {tplFields.length > 0 && (
            <div className="cm-row">
              <span className="cm-row-label">Merge fields</span>
              <div className="cm-row-body">
                <div className={cx('cm-filled', allFilled ? 'cm-filled--ok' : 'cm-filled--missing')}>
                  {allFilled ? '✓' : '▲'} {filled} of {tplFields.length} filled
                </div>
                <div className="cm-fields">
                  {tplFields.map((f) => (
                    <label key={f.key} className="cm-field-input">
                      <span className="sub">«{f.label}»</span>
                      <input className={cx('input', !(values[f.key] ?? '').trim() && 'cm-missing')} value={values[f.key] ?? ''} onChange={(e) => setFields((v) => ({ ...v, [f.key]: e.target.value }))} />
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
          {tpl.clauses.length > 0 && (
            <div className="cm-row">
              <span className="cm-row-label">Clauses</span>
              <div className="cm-row-body cm-clauses" role="group" aria-label="Optional clauses">
                {tpl.clauses.map((c) => (
                  <label key={c.id} className={cx('cm-clause', on(c.id) && 'cm-clause--on')}>
                    <input type="checkbox" checked={on(c.id)} onChange={(e) => setClauses((v) => ({ ...v, [c.id]: e.target.checked }))} />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="cm-letter" aria-label="Letter preview" aria-live="polite">
            {paragraphs.map((p, i) => (
              <p key={i}>
                {segments(p, values).map((s, j) => (s.field ? <mark key={j} className="cm-merge" title={`Merge field: ${tplFields.find((f) => f.key === s.field)?.label ?? s.field}`}>{s.text}</mark> : <span key={j}>{s.text}</span>))}
              </p>
            ))}
          </div>

          <div className="field">
            <label htmlFor="cm-note">{generic ? 'Message' : 'Add a personal line (optional)'}</label>
            <textarea id="cm-note" className="textarea" rows={generic ? 4 : 2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>

          <div className="cm-row">
            <span className="cm-row-label">Attachments</span>
            <div className="cm-row-body cm-attach">
              {attachments.map((a) => (
                <span key={a} className="cm-file">
                  <Icon name="document" size={13} />{a}
                  <button type="button" className="btn btn--quiet btn--xs" aria-label={`Remove ${a}`} onClick={() => setAttachments((xs) => xs.filter((x) => x !== a))}><Icon name="close" size={10} /></button>
                </span>
              ))}
              {adding ? (
                <select className="select" autoFocus aria-label="Add attachment" defaultValue="" onChange={(e) => { if (e.target.value) setAttachments((xs) => [...xs, e.target.value]); setAdding(false) }} onBlur={() => setAdding(false)}>
                  <option value="" disabled>Choose a document…</option>
                  {EXTRA_ATTACHMENTS.filter((a) => !attachments.includes(a)).map((a) => <option key={a}>{a}</option>)}
                </select>
              ) : (
                <button type="button" className="btn btn--ghost btn--xs" onClick={() => setAdding(true)}>Add</button>
              )}
              {attachments.length === 0 && !adding && <span className="sub">None</span>}
            </div>
          </div>

          {canAnswer && (
            <label className="cm-check">
              <input type="checkbox" checked={answer} onChange={(e) => setAnswer(e.target.checked)} />
              {tpl.answers!.label}
            </label>
          )}
          {tpl.copyAgent && (
            <label className="cm-check">
              <input type="checkbox" checked={copyAgent} onChange={(e) => setCopyAgent(e.target.checked)} />
              {tpl.copyAgent.label}
            </label>
          )}
          {!canSend && (
            <p className="sub" role="note">
              {!channels.length ? 'Choose at least one channel. ' : ''}{!allFilled ? 'Fill every merge field. ' : ''}{generic && !note.trim() ? 'Write the message. ' : ''}
            </p>
          )}
        </>
      )}
    </Drawer>
  )
}

/** The letter as the recipient will see it. */
function LetterPreview({ claim, tpl, to, channels, paragraphs, values, attachments }: {
  claim: Claim
  tpl: LetterTemplate
  to: string
  channels: string[]
  paragraphs: string[]
  values: Record<string, string>
  attachments: string[]
}) {
  return (
    <div className="cm-page">
      <div className="cm-page-head">
        <strong>Claims · Life, disability &amp; annuities</strong>
        <span className="sub">{fmtDate('2026-09-25', { year: true })} · Claim {claim.id} · {tpl.id}</span>
      </div>
      <div className="sub">To {to} · by {channels.join(' and ').toLowerCase() || '—'}</div>
      <div className="cm-letter cm-letter--page">
        {paragraphs.map((p, i) => <p key={i}>{segments(p, values).map((s) => s.text).join('')}</p>)}
      </div>
      {attachments.length > 0 && <div className="sub">Enclosed: {attachments.join(' · ')}</div>}
    </div>
  )
}
