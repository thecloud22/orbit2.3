import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Claim } from '../../api/types'
import { useQuery } from '../../api/useQuery'
import {
  acceptDocument, acceptFields, decideField, editField, getDocument, handOffDocument, listDocuments,
  type DocumentRecord, type FieldRecord,
} from '../../api/documents'
import { fmtDate, fmtRelativeDay, fmtTime } from '../../lib/dates'
import { cx } from '../../lib/cx'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Planned'
import { StatusTag, Tag, ToneShape } from '../../components/Tag'
import { useToast } from '../../components/Toasts'
import { useSession } from '../../shell/session'
import { useWidth } from '../../lib/useWidth'
import type { SectionProps } from './types'
import './Documents.css'

/** Documents on the claim: a filterable list, or one document open in the viewer (the `target`). */
export function DocumentsSection({ claim, target }: SectionProps) {
  return target ? <DocumentViewer key={target} claim={claim} docId={target} /> : <DocumentList claim={claim} />
}

// ---------------------------------------------------------------- list

type Filter = 'all' | 'new' | string

function lineOf(claim: Claim, id?: string) {
  return id ? claim.benefitLines.find((b) => b.id === id) : undefined
}

/** All documents with filters by new and by benefit line; each row opens the viewer. */
function DocumentList({ claim }: { claim: Claim }) {
  const navigate = useNavigate()
  const { data: docs, loading } = useQuery(() => listDocuments(claim.id), [claim.id])
  const [filter, setFilter] = useState<Filter>('all')
  const [type, setType] = useState('')
  const all = useMemo(() => docs ?? [], [docs])
  const lines = claim.benefitLines.length > 1 ? claim.benefitLines : []
  const types = [...new Set(all.map((d) => d.docType))].sort()
  const fresh = all.filter((d) => d.isNew)

  const shown = all.filter((d) => {
    if (filter === 'new' && !d.isNew) return false
    if (filter !== 'all' && filter !== 'new' && d.benefitLineId && d.benefitLineId !== filter) return false
    if (type && d.docType !== type) return false
    return true
  })
  const countFor = (lineId: string) => all.filter((d) => !d.benefitLineId || d.benefitLineId === lineId).length
  const open = (d: DocumentRecord) => navigate(`/claims/${claim.id}/documents/${d.id}`)

  return (
    <div className="dc">
      <div className="page-head">
        <h2>Documents</h2>
        {docs && <span className="aside">{all.length} on file{fresh.length ? ` · ${fresh.length} new` : ''} · newest first</span>}
      </div>

      {loading && !docs && <Loading rows={6} />}

      {docs && (
        <>
          <div className="dc-filters" role="group" aria-label="Filter documents">
            <button type="button" className="chip-filter" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All <span className="count">{all.length}</span></button>
            <button type="button" className="chip-filter" aria-pressed={filter === 'new'} onClick={() => setFilter('new')}>New <span className="count">{fresh.length}</span></button>
            {lines.map((b) => (
              <button key={b.id} type="button" className="chip-filter" aria-pressed={filter === b.id} onClick={() => setFilter(b.id)}>
                {b.name} <span className="count">{countFor(b.id)}</span>
              </button>
            ))}
            <span className="grow" />
            <label htmlFor="dc-type" className="sr-only">Document type</label>
            <select id="dc-type" className="select dc-type" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {types.map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>

          {fresh.length > 0 && filter === 'all' && (
            <div className="dc-newbar">
              <ToneShape tone="info" />
              <span className="grow"><strong>{fresh.length === 1 ? fresh[0].title : `${fresh.length} new documents`}</strong>{fresh.length === 1 && <span className="soft"> · received {fmtRelativeDay(fresh[0].received).toLowerCase()} {fmtTime(fresh[0].received)} · extracted fields wait for you</span>}</span>
              <Link className="btn btn--primary btn--sm" to={`/claims/${claim.id}/documents/${fresh[0].id}`}>Review</Link>
            </div>
          )}

          {shown.length === 0 ? (
            <div className="empty">No documents match these filters.</div>
          ) : (
            <table className="tbl dc-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th className="dc-c-type">Type</th>
                  <th>Received</th>
                  <th className="r dc-c-pages">Pages</th>
                  <th>Status</th>
                  <th>Satisfies</th>
                  <th><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => {
                  const line = lines.length ? lineOf(claim, d.benefitLineId)?.name : undefined
                  return (
                    <tr key={d.id} className={cx('dc-row', d.isNew && 'is-new')} onClick={() => open(d)}>
                      <td>
                        <div className="dc-title">
                          {d.isNew && <Tag tone="info">New</Tag>}
                          <Link to={`/claims/${claim.id}/documents/${d.id}`} className="dc-titlelink" onClick={(e) => e.stopPropagation()}>{d.title}</Link>
                        </div>
                        <div className="sub">
                          {d.from}
                          {lines.length > 0 && ` · ${line ?? 'All lines'}`}
                          <span className="dc-type-inline"> · {d.docType}</span>
                        </div>
                      </td>
                      <td className="dc-c-type">{d.docType}</td>
                      <td className="nowrap">
                        <div>{fmtRelativeDay(d.received)}{fmtTime(d.received) && d.received.slice(0, 10) === '2026-09-25' ? ` ${fmtTime(d.received)}` : ''}</div>
                        <div className="sub">{d.channel}</div>
                      </td>
                      <td className="r dc-c-pages">{d.pages}</td>
                      <td><StatusTag status={d.status} /></td>
                      <td>
                        {d.satisfies && d.requirementId ? (
                          <Link to={`/claims/${claim.id}/requirements/${d.requirementId}`} onClick={(e) => e.stopPropagation()}>{d.satisfies}</Link>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td className="r">
                        <Link to={`/claims/${claim.id}/documents/${d.id}`} className={cx('btn btn--xs', d.isNew ? 'btn--ghost' : 'btn--quiet')} onClick={(e) => e.stopPropagation()}>
                          {d.isNew ? 'Review' : 'Open'}
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <p className="sub">Documents arrive through intake, which classifies them, matches the claim and marks requirements received. Extracted values stay proposed until someone here accepts them.</p>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- page model

type Block =
  | { k: 'head'; cells: string[] }
  | { k: 'meta'; cells: string[] }
  | { k: 'h'; cells: string[] }
  | { k: 'table'; head: string[]; rows: string[][] }
  | { k: 'sig'; cells: string[] }
  | { k: 'cap'; cells: string[] }
  | { k: 'p'; lines: string[]; n?: number }
  | { k: 'bar'; w: number }

const cells = (s: string) => s.split('|').map((c) => c.trim())
const regionOf = (s: string): [number | undefined, string] => {
  const m = /^\{(\d+)\}\s?/.exec(s)
  return m ? [Number(m[1]), s.slice(m[0].length)] : [undefined, s]
}

/** Splits pageText into pages of blocks (see the markup notes in fixtures/documents.ts). */
function parsePages(lines: string[]): Block[][] {
  const pages: Block[][] = []
  let page: Block[] = []
  const push = (b: Block) => {
    const last = page[page.length - 1]
    if (b.k === 'table' && last?.k === 'table' && b.head.length === 0) last.rows.push(...b.rows)
    else if (b.k === 'p' && last?.k === 'p' && b.n != null && last.n === b.n) last.lines.push(...b.lines)
    else page.push(b)
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('===')) {
      if (page.length) pages.push(page)
      page = []
    } else if (line.startsWith('@head ')) push({ k: 'head', cells: cells(line.slice(6)) })
    else if (line.startsWith('@meta ')) push({ k: 'meta', cells: cells(line.slice(6)) })
    else if (line.startsWith('# ')) push({ k: 'h', cells: cells(line.slice(2)) })
    else if (line.startsWith('|| ')) push({ k: 'table', head: cells(line.slice(3)), rows: [] })
    else if (line.startsWith('| ')) push({ k: 'table', head: [], rows: [cells(line.slice(2))] })
    else if (line.startsWith('~ ')) push({ k: 'sig', cells: cells(line.slice(2)) })
    else if (line.startsWith('_ ')) push({ k: 'cap', cells: cells(line.slice(2)) })
    else if (line.startsWith('%bar ')) push({ k: 'bar', w: Number(line.slice(5)) })
    else if (line.trim()) {
      const [n, text] = regionOf(line)
      push({ k: 'p', lines: [text], n })
    }
  }
  if (page.length) pages.push(page)
  return pages
}

/** A stand-in page for documents the mock has no text for — honest placeholder bars. */
function placeholderPages(doc: DocumentRecord, claim: Claim): string[] {
  const out: string[] = []
  const widths = [92, 86, 74, 90, 64, 88, 80, 70, 58]
  for (let p = 1; p <= Math.min(doc.pages, 30); p++) {
    out.push(`=== ${p}`, `@head ${doc.docType} | Page ${p} of ${doc.pages}`, `@meta Claim: ${claim.id} | From: ${doc.from ?? '—'} | Received: ${fmtDate(doc.received)}`)
    if (p === 1) out.push(`# ${doc.title}`)
    widths.forEach((w, i) => out.push(`%bar ${(w + p * 7 + i * 3) % 40 + 55}`))
  }
  return out
}

function fieldPage(f: FieldRecord): number {
  const m = /p\.(\d+)/.exec(f.source)
  return m ? Number(m[1]) - 1 : 0
}

function renderInline(text: string): ReactNode {
  const parts = text.split(/(\[x\]|\[ \])/g)
  return parts.map((p, i) =>
    p === '[x]' ? <span key={i} className="dc-box dc-box--on" aria-label="checked">×</span>
      : p === '[ ]' ? <span key={i} className="dc-box" aria-label="not checked" />
        : p,
  )
}

// ---------------------------------------------------------------- viewer

/** The document viewer: the page on the left with extracted areas tinted, the extracted-fields panel on the right. */
function DocumentViewer({ claim, docId }: { claim: Claim; docId: string }) {
  const toast = useToast()
  const navigate = useNavigate()
  const { user } = useSession()
  const { data: doc, error } = useQuery(() => getDocument(docId), [docId])
  const [ref, width] = useWidth<HTMLDivElement>()
  const wide = width >= 820
  const thumbs = width >= 1100
  const pages = useMemo(() => (doc ? parsePages(doc.pageText?.length ? doc.pageText : placeholderPages(doc, claim)) : []), [doc, claim])
  const [page, setPage] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [active, setActive] = useState<string | null>(null)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [checking, setChecking] = useState<string | null>(null)
  const [scrollTo, setScrollTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const fields = useMemo(() => doc?.extracted ?? [], [doc])
  const lowFirst = fields.find((f) => f.confidence === 'low')

  // Open on the page with the low-confidence field, else the page with the most extracted areas.
  const initialPage = useMemo(() => {
    if (!doc) return 0
    if (lowFirst) return fieldPage(lowFirst)
    let best = 0
    let most = -1
    pages.forEach((_, i) => {
      const n = new Set(fields.filter((f) => fieldPage(f) === i).map((f) => f.id)).size
      if (n > most) { most = n; best = i }
    })
    return best
  }, [doc, pages, fields, lowFirst])
  const current = Math.min(page ?? initialPage, Math.max(pages.length - 1, 0))

  // Bring a field into view when it is picked on the page or checked — not on hover.
  useEffect(() => {
    if (!scrollTo) return
    document.getElementById(`dc-field-${scrollTo}`)?.scrollIntoView({ block: 'nearest' })
  }, [scrollTo, fields])

  if (error) {
    return (
      <div className="dc">
        <Link to={`/claims/${claim.id}/documents`} className="dc-back"><Icon name="chevronLeft" size={13} />All documents</Link>
        <div className="empty">That document isn’t on this claim.</div>
      </div>
    )
  }
  if (!doc) return <div className="dc" ref={ref}><Loading rows={8} /></div>

  const proposed = fields.filter((f) => f.state === 'proposed')
  const bulk = proposed.filter((f) => f.confidence === 'high' && !unchecked.has(f.id))
  const lowOpen = proposed.filter((f) => f.confidence === 'low')
  const done = fields.length > 0 && proposed.length === 0
  const n = (f: FieldRecord) => fields.indexOf(f) + 1
  const received = `Received ${fmtDate(doc.received)}${fmtTime(doc.received) ? ` ${fmtTime(doc.received)}` : ''} via ${doc.channel.toLowerCase()} · ${doc.pages} page${doc.pages > 1 ? 's' : ''}`

  async function act(fn: () => Promise<{ finalized: boolean }>, message: string) {
    setBusy(true)
    try {
      const r = await fn()
      if (r.finalized) finalizedToast()
      else toast(message)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function finalizedToast() {
    if (doc!.id === 'doc-bell-aps')
      toast('APS accepted · proof of loss renewed to 21 Dec', { label: 'Next step', onClick: () => navigate(`/claims/${claim.id}/case-plan`) })
    else toast(`${doc!.title} accepted · requirement satisfied`)
  }

  async function acceptBulk() {
    setBusy(true)
    try {
      const r = await acceptFields(doc!.id, bulk.map((f) => f.id), user.name)
      if (r.finalized) finalizedToast()
      else toast(`${r.accepted} fields accepted · each logged to history${lowOpen.length ? ` · ${lowOpen.length} to check` : ''}`)
      if (!r.finalized && lowOpen[0]) startCheck(lowOpen[0])
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function startCheck(f: FieldRecord) {
    setPage(fieldPage(f))
    setActive(f.id)
    setChecking(f.id)
    setScrollTo(f.id)
    setEditing(null)
  }

  function pick(fieldNo: number) {
    const f = fields[fieldNo - 1]
    if (f) { setActive(f.id); setScrollTo(f.id) }
  }

  const activeNo = active ? fields.findIndex((f) => f.id === active) + 1 : undefined

  return (
    <div ref={ref} className={cx('dc-view', wide && 'dc-view--wide')}>
      <div className="dc-bar">
        <Link to={`/claims/${claim.id}/documents`} className="btn btn--quiet btn--sm dc-backbtn" aria-label="All documents"><Icon name="chevronLeft" size={14} /></Link>
        <Icon name="document" size={18} color="var(--ink-2)" />
        <div className="dc-bar-title">
          <h2>{doc.title}</h2>
          <span className="sub">{received}</span>
        </div>
        <span className="grow" />
        <div className="dc-pagenav" role="group" aria-label="Pages">
          <button type="button" className="btn btn--quiet btn--xs" aria-label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}><Icon name="chevronLeft" size={13} /></button>
          <span className="strong nowrap">Page {current + 1} of {doc.pages}</span>
          <button type="button" className="btn btn--quiet btn--xs" aria-label="Next page" disabled={current >= pages.length - 1} onClick={() => setPage(current + 1)}><Icon name="chevronRight" size={13} /></button>
        </div>
        <div className="dc-zoom" role="group" aria-label="Zoom">
          <button type="button" className="btn btn--quiet btn--xs" aria-label="Zoom out" disabled={zoom <= 0.8} onClick={() => setZoom((z) => Math.round((z - 0.1) * 10) / 10)}>−</button>
          <span className="sub num">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn--quiet btn--xs" aria-label="Zoom in" disabled={zoom >= 1.4} onClick={() => setZoom((z) => Math.round((z + 0.1) * 10) / 10)}>+</button>
        </div>
      </div>

      <div className={cx('dc-stage', thumbs && 'dc-stage--thumbs')}>
        <div className={cx('dc-tabs', thumbs && 'dc-tabs--thumbs')} role="tablist" aria-label="Pages">
          {pages.slice(0, 12).map((_, i) => {
            const hasHits = fields.some((f) => fieldPage(f) === i)
            return (
              <button key={i} type="button" role="tab" aria-selected={i === current} className={cx('dc-tab', i === current && 'is-on')} onClick={() => setPage(i)}>
                {thumbs && (
                  <span className="dc-thumb" aria-hidden="true">
                    {[70, 90, 60, 85, 75, 50].map((w, j) => <i key={j} style={{ width: `${w}%` }} className={hasHits && j > 1 && j < 4 ? 'hit' : undefined} />)}
                  </span>
                )}
                <span>{i + 1}</span>
              </button>
            )
          })}
          {pages.length > 12 && <span className="sub">+{pages.length - 12}</span>}
          {thumbs && fields.length > 0 && <span className="dc-thumbnote">Tinted areas were extracted</span>}
        </div>
        <div className="dc-canvas" role="tabpanel" aria-label={`Page ${current + 1}`}>
          <PaperPage blocks={pages[current] ?? []} fields={fields} activeNo={activeNo} onPick={pick} zoom={zoom} placeholder={!doc.pageText?.length} />
        </div>
      </div>

      <aside className="dc-panel" aria-labelledby="dc-panel-h">
        <div className="dc-panel-head">
          <h3 id="dc-panel-h">Extracted from this document</h3>
          <span className="grow" />
          {doc.readAt && <span className="sub">Read {doc.readAt} · {fields.length} fields</span>}
        </div>
        <dl className="dc-facts">
          <dt>Classified as</dt>
          <dd>{doc.classifiedAs ? `${doc.classifiedAs.label} · ${doc.classifiedAs.confidence}%` : doc.docType}</dd>
          <dt>Matches claim</dt>
          <dd><span className="dc-ok"><ToneShape tone="positive" /></span>{doc.matches ?? claim.id}</dd>
          <dt>Satisfies requirement</dt>
          <dd>
            {doc.satisfies ? (
              <><span className="dc-ok"><ToneShape tone="positive" /></span>{doc.satisfies}{doc.requirementId && <> <Link to={`/claims/${claim.id}/requirements/${doc.requirementId}`} className="strong">linked</Link></>}</>
            ) : <span className="muted">None — filed for reference</span>}
          </dd>
        </dl>

        {fields.length > 0 ? (
          <div className={cx('dc-fields', done ? 'proposed proposed--accepted' : 'proposed')}>
            <div className="dc-fields-head">
              <span className="proposed-kicker" style={done ? { color: 'var(--ink-3)' } : undefined}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.2" /></svg>
                {done ? 'Reviewed' : 'Extracted'} · {fields.length} fields
              </span>
              <span className="grow" />
              <span className="sub">{doc.compareWith ? `Changes compared with ${doc.compareWith}` : 'First of its kind on this claim'}</span>
            </div>
            <ol className="dc-list">
              {fields.map((f) => (
                <FieldRow
                  key={f.id}
                  f={f}
                  no={n(f)}
                  active={active === f.id}
                  checked={f.state === 'proposed' && f.confidence === 'high' && !unchecked.has(f.id)}
                  onToggle={() => setUnchecked((s) => { const x = new Set(s); if (x.has(f.id)) x.delete(f.id); else x.add(f.id); return x })}
                  onHover={() => setActive(f.id)}
                  onSource={() => { setPage(fieldPage(f)); setActive(f.id) }}
                  busy={busy}
                  editing={editing?.id === f.id ? editing.value : null}
                  checking={checking === f.id}
                  onAccept={() => { setChecking(null); void act(() => decideField(doc.id, f.id, 'accepted', user.name), `${f.label} accepted`) }}
                  onDismiss={() => { setChecking(null); void act(() => decideField(doc.id, f.id, 'dismissed', user.name), `${f.label} dismissed`) }}
                  onEdit={() => { setEditing({ id: f.id, value: f.value }); setActive(f.id) }}
                  onDraft={(v) => setEditing({ id: f.id, value: v })}
                  onSave={() => { const v = editing?.value ?? ''; setEditing(null); setChecking(null); void act(() => editField(doc.id, f.id, v, user.name), v.trim() === f.value ? `${f.label} accepted` : `${f.label} corrected to “${v.trim()}”`) }}
                  onCancel={() => setEditing(null)}
                />
              ))}
            </ol>
          </div>
        ) : (
          <div className="well sub">No fields are extracted for this document type. It was classified and matched to the claim{doc.satisfies ? ' and its requirement' : ''} at intake.</div>
        )}

        <div className="dc-foot">
          {done || (!fields.length && !doc.isNew) ? (
            <div className="dc-accepted">
              <StatusTag status={doc.status} />
              <span className="sub grow">{doc.reviewedBy ? `Reviewed by ${doc.reviewedBy}` : 'Reviewed at intake'}</span>
              {doc.id === 'doc-bell-aps' && claim.nextStep.section === 'case-plan' && (
                <Link to={`/claims/${claim.id}/case-plan`} className="btn btn--ghost btn--xs">{claim.nextStep.label}<Icon name="arrowRight" size={12} /></Link>
              )}
            </div>
          ) : (
            <>
              {doc.ifAccepted && (
                <p className="dc-consequence"><strong>If you accept:</strong> {doc.ifAccepted}</p>
              )}
              <div className="dc-buttons">
                {fields.length > 0 ? (
                  <button type="button" className="btn btn--primary" onClick={acceptBulk} disabled={busy || bulk.length === 0}>
                    Accept {bulk.length} field{bulk.length === 1 ? '' : 's'}
                  </button>
                ) : (
                  <button type="button" className="btn btn--primary" onClick={() => { setBusy(true); acceptDocument(doc.id, user.name).then(() => toast(`${doc.title} accepted`)).finally(() => setBusy(false)) }} disabled={busy}>
                    Accept document
                  </button>
                )}
                {lowOpen.length > 0 && (
                  <button type="button" className="btn" onClick={() => startCheck(lowOpen[0])}>Check low-confidence ({lowOpen.length})</button>
                )}
                <span className="grow" />
                {doc.handoff && (
                  <button type="button" className="btn btn--ghost" onClick={() => handOffDocument(doc.id, user.name).then((to) => toast(`Sent to ${to} · task added`))}>{doc.handoff.label}</button>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- page rendering

/** One page drawn as a paper form. Extracted areas are tinted and numbered; hovering a field lights its area. */
function PaperPage({ blocks, fields, activeNo, onPick, zoom, placeholder }: {
  blocks: Block[]
  fields: FieldRecord[]
  activeNo?: number
  onPick: (n: number) => void
  zoom: number
  placeholder: boolean
}) {
  const seen = new Set<number>()
  const region = (n: number | undefined, content: ReactNode, block = false) => {
    if (n == null) return content
    const f = fields[n - 1]
    const first = !seen.has(n)
    seen.add(n)
    const cls = cx(
      'dc-hit',
      block && 'dc-hit--block',
      f?.confidence === 'low' && 'dc-hit--low',
      f?.handwritten && 'dc-hand',
      f && f.state !== 'proposed' && (f.state === 'dismissed' ? 'dc-hit--off' : 'dc-hit--done'),
      activeNo === n && 'is-active',
    )
    return (
      <span className={cls} onClick={() => onPick(n)} title={f ? `${n}. ${f.label}: ${f.value}` : undefined}>
        {first && <span className={cx('dc-pin', f?.confidence === 'low' && 'dc-pin--low')} aria-hidden="true">{n}</span>}
        {content}
      </span>
    )
  }
  const cell = (s: string) => {
    const [n, text] = regionOf(s)
    return region(n, renderInline(text) || ' ', true)
  }

  return (
    <div className="dc-paper" style={{ ['--z' as string]: zoom }}>
      {blocks.map((b, i) => {
        switch (b.k) {
          case 'head':
            return <div key={i} className="dc-p-head"><strong>{b.cells[0]}</strong><span>{b.cells[1]}</span></div>
          case 'meta':
            return (
              <div key={i} className="dc-p-meta">
                {b.cells.map((c) => {
                  const [k, ...v] = c.split(':')
                  return <span key={c}>{v.length ? <>{k}: <strong>{v.join(':').trim()}</strong></> : c}</span>
                })}
              </div>
            )
          case 'h':
            return <div key={i} className="dc-p-h"><strong>{b.cells[0]}</strong>{b.cells[1] && <span>{b.cells[1]}</span>}</div>
          case 'table':
            return (
              <table key={i} className="dc-p-table">
                {b.head.length > 0 && <thead><tr>{b.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>}
                <tbody>
                  {b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{k === 0 ? c : cell(c)}</td>)}</tr>)}
                </tbody>
              </table>
            )
          case 'sig':
            return (
              <div key={i} className="dc-p-sig">
                <span className="dc-p-sigline dc-hand-sig">{cell(b.cells[0])}</span>
                {b.cells[1] && <span className="dc-p-sigdate">{cell(b.cells[1])}</span>}
              </div>
            )
          case 'cap':
            return <div key={i} className="dc-p-cap">{b.cells.map((c) => <span key={c}>{c}</span>)}</div>
          case 'bar':
            return <div key={i} className="dc-p-bar" style={{ width: `${b.w}%` }} aria-hidden="true" />
          case 'p':
            return (
              <div key={i} className="dc-p-line">
                {region(b.n, b.lines.map((l, j) => <div key={j}>{renderInline(l)}</div>), true)}
              </div>
            )
        }
      })}
      {placeholder && <p className="dc-p-note">The mock doesn’t carry this page’s image; the lines are placeholders.</p>}
    </div>
  )
}

// ---------------------------------------------------------------- field row

function Confidence({ f }: { f: FieldRecord }) {
  const high = f.confidence === 'high'
  return (
    <span className={cx('dc-conf', !high && 'dc-conf--low')}>
      {high ? 'High' : `Low${f.handwritten ? ' · handwritten' : ''}`}
      <span className="dc-bars" aria-hidden="true"><i className="on" /><i className={high ? 'on' : undefined} /><i className={high ? 'on' : undefined} /></span>
    </span>
  )
}

function CheckIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4 6.6 11.4 12.5 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

/** One proposed field: dashed until accepted, with Accept / Edit (inline) / Dismiss. */
function FieldRow({ f, no, active, checked, onToggle, onHover, onSource, busy, editing, checking, onAccept, onDismiss, onEdit, onDraft, onSave, onCancel }: {
  f: FieldRecord
  no: number
  active: boolean
  checked: boolean
  onToggle: () => void
  onHover: () => void
  onSource: () => void
  busy: boolean
  editing: string | null
  checking: boolean
  onAccept: () => void
  onDismiss: () => void
  onEdit: () => void
  onDraft: (v: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  const open = f.state === 'proposed'
  const low = f.confidence === 'low'
  const changed = f.change && f.change !== 'No change'
  return (
    <li
      id={`dc-field-${f.id}`}
      className={cx('dc-field', low && open && 'is-low', active && 'is-active', `is-${f.state}`)}
      onMouseEnter={onHover}
      onFocus={onHover}
    >
      <input
        type="checkbox"
        className="dc-check"
        checked={open ? checked : f.state !== 'dismissed'}
        disabled={!open || low}
        onChange={onToggle}
        aria-label={open ? `Include ${f.label} in Accept` : `${f.label} ${f.state}`}
      />
      <span className={cx('dc-num', low && open && 'dc-num--low')} aria-hidden="true">{no}</span>
      <div className="dc-fbody">
        <div className="dc-fline">
          <span className="dc-flabel">{f.label}</span>{' '}
          {editing != null ? null : <strong className={cx('dc-fval', open && 'proposed-inline', f.state === 'dismissed' && 'is-off')}>{f.value}</strong>}
          {low && open && !checking && <span className="dc-checktag"><Tag tone="caution">Check</Tag></span>}
        </div>
        {editing != null && (
          <form className="dc-edit" onSubmit={(e) => { e.preventDefault(); onSave() }}>
            <label htmlFor={`dc-edit-${f.id}`} className="sr-only">{f.label}</label>
            <input id={`dc-edit-${f.id}`} className="input" value={editing} autoFocus onChange={(e) => onDraft(e.target.value)} />
            <button type="submit" className="btn btn--primary btn--xs" disabled={busy || !editing.trim()}>Save</button>
            <button type="button" className="btn btn--quiet btn--xs" onClick={onCancel}>Cancel</button>
          </form>
        )}
        <div className="dc-fmeta">
          <button type="button" className="source" onClick={onSource}>{f.source}</button>
          <Confidence f={f} />
          {f.change && <span className={changed ? 'dc-change' : 'muted'}>{f.change}</span>}
        </div>
        {checking && open && (
          <div className="dc-checking" role="group" aria-label={`Check ${f.label}`}>
            <span>{f.handwritten ? 'Handwritten' : 'Low confidence'} — compare with the tinted area on page {fieldPage(f) + 1}. Does it read “{f.value}”?</span>
            <div className="dc-checking-actions">
              <button type="button" className="btn btn--primary btn--xs" onClick={onAccept} disabled={busy}>Yes, accept {f.value}</button>
              <button type="button" className="btn btn--xs" onClick={onEdit} disabled={busy}>Correct it</button>
            </div>
          </div>
        )}
        {!open && (
          <div className="sub dc-audit">
            {f.state === 'accepted' && `Accepted by ${f.decidedBy ?? 'intake'}`}
            {f.state === 'edited' && `Corrected by ${f.decidedBy} · extraction read “${f.proposedValue}”`}
            {f.state === 'dismissed' && `Dismissed by ${f.decidedBy}`}
            {f.decidedAt && ` · ${fmtTime(f.decidedAt)}`}
          </div>
        )}
      </div>
      {open && editing == null && (
        <div className="dc-factions">
          <button type="button" className="btn btn--quiet btn--xs" aria-label={`Accept ${f.label}`} title="Accept" onClick={onAccept} disabled={busy}><CheckIcon /></button>
          <button type="button" className="btn btn--quiet btn--xs" aria-label={`Edit ${f.label}`} title="Edit" onClick={onEdit} disabled={busy}><Icon name="pencil" size={13} /></button>
          <button type="button" className="btn btn--quiet btn--xs" aria-label={`Dismiss ${f.label}`} title="Dismiss" onClick={onDismiss} disabled={busy}><Icon name="close" size={12} /></button>
        </div>
      )}
    </li>
  )
}
