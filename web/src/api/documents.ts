import { DOCUMENTS } from './fixtures/documents'
import { collection, fail, respond } from './store'
import { claims, patchClaim, setNextStep } from './claims'
import { addCommunication } from './communications'
import { logEvent } from './history'
import { satisfyRequirement } from './requirements'
import { addTask } from './tasks'
import { completeWork } from './work'
import { TODAY, addDays, nowStamp } from '../lib/dates'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import type { ClaimDocument, ExtractedField } from './types'

/*
 * Documents on a claim and what extraction read from them. The extra fields below extend the
 * contract's ClaimDocument and belong in contracts/openapi.yaml as the document detail resource.
 */

/** An extracted field with its audit trail: who decided, and what extraction proposed before an edit. */
export interface FieldRecord extends ExtractedField {
  handwritten?: boolean
  /** What extraction proposed, kept when a person edits the value. */
  proposedValue?: string
  decidedBy?: string
  decidedAt?: string
}

export interface DocumentRecord extends ClaimDocument {
  extracted?: FieldRecord[]
  /** Sender: 'Dr. Owen Castillo', 'Ashford County Coroner'. */
  from?: string
  classifiedAs?: { label: string; confidence: number }
  /** What the claim match used: 'Name, date of birth and claim number'. */
  matches?: string
  /** When extraction read it, 'HH:MM'. */
  readAt?: string
  /** 'the June APS' — what the change column compares with. */
  compareWith?: string
  /** The "If you accept:" consequences line. */
  ifAccepted?: string
  requirementId?: string
  /** A hand-off offered beside Accept, e.g. Send to nurse. */
  handoff?: { label: string; to: string; task: string }
  reviewedBy?: string
}

export const documents = collection<DocumentRecord>(DOCUMENTS)

/** GET /claims/{id}/documents — newest first. */
export function listDocuments(claimId: string): Promise<DocumentRecord[]> {
  if (isLiveId(claimId)) return live.listDocuments(claimId)
  return respond(documents.where((d) => d.claimId === claimId).sort((a, b) => b.received.localeCompare(a.received)))
}

/** GET /documents/{id} */
export function getDocument(id: string): Promise<DocumentRecord> {
  const d = documents.get(id)
  return d ? respond(d) : fail(`Document ${id} not found`)
}

// ---------------------------------------------------------------- consequences of acceptance

/** What the claim's workflow does when a reviewed document is accepted. Keyed by document. */
const ON_ACCEPT: Record<string, (d: DocumentRecord, by: string) => void> = {
  'doc-bell-aps': (d, by) => {
    patchClaim(d.claimId, (c) => ({
      clocks: c.clocks.map((k) => (k.id === 'c1' ? { ...k, due: '2026-12-21', progress: 0.02, state: 'running' as const } : k)),
      benefitLines: c.benefitLines.map((b) => (b.id === 'bl-bell-di' ? { ...b, waitingOn: 'You · share restrictions' } : b)),
    }))
    setNextStep(d.claimId, { label: 'Share restrictions with Chris Duarte', reason: 'Restrictions v7 · skills analysis 14 Oct', section: 'case-plan' })
    logEvent(d.claimId, { type: 'data', title: 'Proof of loss renewed to 21 Dec 2026', actor: `System · from ${d.title}`, detail: 'Dated by the physician signature of 22 Sep', ref: d.title })
    logEvent(d.claimId, { type: 'data', title: 'Medical restrictions updated to version 7', actor: `${by} · accepted APS fields`, detail: 'Sit 30 min at a time, 4 h per day; permanent restrictions, MMI reached', ref: d.title })
    addCommunication({
      claimId: d.claimId,
      channel: 'note',
      direction: 'internal',
      title: 'Restrictions updated from the APS of 22 Sep',
      party: 'Sam Whitaker, RN · Chris Duarte, CRC',
      detail: 'Restrictions version 7: sitting 30 min at a time (was 20) and 4 h a day (was 3); permanent, MMI reached. For the open nurse referral and the 14 Oct skills analysis.',
      status: { label: 'Notified', tone: 'neutral' },
    })
  },
  'doc-okafor-tox': (d, by) => {
    patchClaim(d.claimId, (c) => ({
      benefitLines: c.benefitLines.map((b) => (b.id === 'bl-okafor-adb' ? { ...b, waitingOn: 'Coroner · final report' } : b)),
    }))
    logEvent(d.claimId, { type: 'data', title: 'Intoxication exclusion: toxicology on file', actor: `${by} · accepted toxicology fields`, detail: 'No alcohol or drugs detected. The accidental death rider still waits on the coroner’s final report.', ref: d.title })
  },
}

/** When no field is left proposed, the document is accepted, satisfies its requirement and leaves the queue. */
function maybeFinalize(id: string, by: string): boolean {
  const d = documents.get(id)
  if (!d || !d.extracted || d.extracted.some((f) => f.state === 'proposed') || d.status.label === 'Accepted') return false
  const counts = d.extracted.reduce<Record<string, number>>((m, f) => ({ ...m, [f.state]: (m[f.state] ?? 0) + 1 }), {})
  documents.update(id, { isNew: false, status: { label: 'Accepted', tone: 'positive' }, reviewedBy: `${by} · ${nowStamp().slice(11)}` })
  logEvent(d.claimId, {
    type: 'document',
    title: `Document accepted: ${d.title}`,
    actor: by,
    detail: [`${counts.accepted ?? 0} accepted`, counts.edited ? `${counts.edited} corrected` : '', counts.dismissed ? `${counts.dismissed} dismissed` : ''].filter(Boolean).join(' · '),
    ref: d.title,
  })
  if (d.requirementId) satisfyRequirement(d.requirementId, d.title, by)
  completeWork(d.claimId, 'documents')
  ON_ACCEPT[id]?.(d, by)
  return true
}

function fieldEvent(d: DocumentRecord, f: FieldRecord, choice: 'accepted' | 'edited' | 'dismissed', by: string, value?: string): void {
  const proposed = `“${f.value}” (${f.source}, ${f.confidence} confidence${f.handwritten ? ', handwritten' : ''})`
  logEvent(d.claimId, {
    type: 'data',
    title:
      choice === 'accepted' ? `Extracted field accepted: ${f.label} — ${f.value}`
        : choice === 'edited' ? `Extracted field corrected: ${f.label} — ${value}`
          : `Extracted field dismissed: ${f.label}`,
    actor: `${by} · reviewed the value proposed by document extraction`,
    detail:
      choice === 'accepted' ? `Accepted the proposed value ${proposed}.`
        : choice === 'edited' ? `Extraction proposed ${proposed}; ${by} entered “${value}”.`
          : `Dismissed the proposed value ${proposed}; not used on the claim.`,
    ref: d.title,
  })
}

// ---------------------------------------------------------------- actions

export type FieldChoice = 'accepted' | 'dismissed'

/** POST /documents/{id}/fields/{fid}:accept | :dismiss */
export function decideField(docId: string, fieldId: string, choice: FieldChoice, by: string): Promise<{ finalized: boolean }> {
  const d = documents.get(docId)
  const f = d?.extracted?.find((x) => x.id === fieldId)
  if (!d || !f) return fail('Field not found')
  if (f.state !== 'proposed') return fail('This field was already reviewed')
  documents.update(docId, {
    extracted: d.extracted!.map((x) => (x.id === fieldId ? { ...x, state: choice, decidedBy: by, decidedAt: nowStamp() } : x)),
  })
  fieldEvent(d, f, choice, by)
  return respond({ finalized: maybeFinalize(docId, by) })
}

/** PATCH /documents/{id}/fields/{fid} — a person corrects the proposed value. The proposal is kept for audit. */
export function editField(docId: string, fieldId: string, value: string, by: string): Promise<{ finalized: boolean }> {
  const d = documents.get(docId)
  const f = d?.extracted?.find((x) => x.id === fieldId)
  if (!d || !f) return fail('Field not found')
  const v = value.trim()
  if (!v) return fail('Enter a value, or dismiss the field')
  if (v === f.value) return decideField(docId, fieldId, 'accepted', by)
  documents.update(docId, {
    extracted: d.extracted!.map((x) =>
      x.id === fieldId ? { ...x, state: 'edited', proposedValue: x.proposedValue ?? x.value, value: v, decidedBy: by, decidedAt: nowStamp() } : x,
    ),
  })
  fieldEvent(d, f, 'edited', by, v)
  return respond({ finalized: maybeFinalize(docId, by) })
}

/** POST /documents/{id}/fields:accept — bulk accept; still one history event per field. */
export function acceptFields(docId: string, fieldIds: string[], by: string): Promise<{ accepted: number; finalized: boolean }> {
  const d = documents.get(docId)
  if (!d?.extracted) return fail('Document not found')
  const chosen = d.extracted.filter((f) => fieldIds.includes(f.id) && f.state === 'proposed')
  const stamp = nowStamp()
  documents.update(docId, {
    extracted: d.extracted.map((x) => (chosen.some((c) => c.id === x.id) ? { ...x, state: 'accepted', decidedBy: by, decidedAt: stamp } : x)),
  })
  chosen.forEach((f) => fieldEvent(d, f, 'accepted', by))
  return respond({ accepted: chosen.length, finalized: maybeFinalize(docId, by) })
}

/** Accepts a document with nothing to extract (classification only). */
export function acceptDocument(docId: string, by: string): Promise<void> {
  const d = documents.get(docId)
  if (!d) return fail('Document not found')
  documents.update(docId, { isNew: false, status: { label: 'Accepted', tone: 'positive' }, reviewedBy: by })
  logEvent(d.claimId, { type: 'document', title: `Document accepted: ${d.title}`, actor: by, ref: d.title })
  if (d.requirementId) satisfyRequirement(d.requirementId, d.title, by)
  if (!documents.where((x) => x.claimId === d.claimId && x.isNew).length) completeWork(d.claimId, 'documents')
  return respond(undefined)
}

/** Hands the document to someone else for a look (nurse, underwriting) as a task. */
export function handOffDocument(docId: string, by: string): Promise<string> {
  const d = documents.get(docId)
  if (!d?.handoff) return fail('No hand-off for this document')
  addTask(d.claimId, d.handoff.task, d.handoff.to, `Document: ${d.title}`, addDays(TODAY, 2))
  logEvent(d.claimId, { type: 'task', title: `Sent for review: ${d.title}`, actor: by, detail: `To ${d.handoff.to}`, ref: d.title })
  return respond(d.handoff.to)
}

/** Benefit line name for display; claim-wide documents have none. */
export function lineName(claimId: string, lineId?: string): string | undefined {
  return lineId ? claims.get(claimId)?.benefitLines.find((b) => b.id === lineId)?.name : undefined
}
