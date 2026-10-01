import { EXTRA_RECORDS, HISTORY_HOLDS, RECORD_CONTEXT } from './fixtures/replay'
import { decisions } from './decisions'
import { history } from './history'
import { respond } from './store'
import type { DecisionRecord, ISODate } from './types'

/** One piece of evidence as it stood when the decision was recorded: a fingerprint proves it hasn't changed since. */
export interface EvidenceAsItStood {
  label: string
  /** Shortened SHA-256 of the stored file, e.g. 'a41f…9c'. */
  hash: string
  date?: ISODate
}

export interface RecordContext {
  evidence: EvidenceAsItStood[]
  /** [kind, value] — policy form and provisions, claims guideline, letter template. */
  rules: [string, string][]
  reviews: string[]
}

/** A locked decision record plus the context the replay shows beside it. */
export interface RecordAsItStood extends RecordContext {
  record: DecisionRecord
  assistant: string
}

const GUIDELINE: Record<string, string> = { L: 'CG-L-02 v4.1', D: 'CG-DI-07 v3.2', A: 'CG-A-03 v2.0' }

/** Stand-in for the stored file hash — stable for a given claim and label. */
function fingerprint(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  const hex = (h >>> 0).toString(16).padStart(8, '0')
  return `${hex.slice(0, 4)}…${hex.slice(-2)}`
}

function contextFor(d: DecisionRecord): RecordContext {
  const known = RECORD_CONTEXT[d.id]
  if (known) return known
  const docs = history.where((h) => h.claimId === d.claimId && h.type === 'document' && h.at <= d.recordedAt)
  const template = d.letter?.match(/[A-Z]{2,4}-[A-Z]{1,3}-\d+/)?.[0]
  return {
    evidence: d.evidence.map((label) => {
      const hit = docs.find((h) => h.ref === label || h.title.toLowerCase().includes(label.toLowerCase()))
      return { label, hash: fingerprint(`${d.claimId}/${label}`), date: hit?.at.slice(0, 10) }
    }),
    rules: [
      ['Policy', d.provisions.length ? `${d.title} — ${d.provisions.join('; ')}` : d.title],
      ['Claims guideline', GUIDELINE[d.claimId[0]] ?? '—'],
      ...(template ? ([['Letter template', template]] as [string, string][]) : []),
    ],
    reviews: d.approvals.length ? d.approvals.map((a) => `Approval: ${a}`) : [`None required — ${d.authorityNote}`],
  }
}

function allRecords(claimId: string): DecisionRecord[] {
  return [...decisions.where((d) => d.claimId === claimId), ...EXTRA_RECORDS.filter((d) => d.claimId === claimId)]
}

/**
 * GET /claims/{id}/decisions?asOf= — the locked records as they stood at a moment, newest first.
 * Records are never edited, so "as it stood" means: recorded on or before the moment, latest version per line.
 */
export function listRecordsAsOf(claimId: string, asOf?: string): Promise<RecordAsItStood[]> {
  const inForce = allRecords(claimId).filter((d) => !asOf || d.recordedAt <= asOf)
  const latest = new Map<string, DecisionRecord>()
  inForce
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .forEach((d) => latest.set(d.benefitLineId, d))
  const out = [...latest.values()]
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .map((record) => ({ record, ...contextFor(record), assistant: record.assistantNote ?? 'No AI recommendation on the outcome.' }))
  return respond(out)
}

/** A hold that stops purging or in-place edits on the claim, if any. */
export function historyHold(claimId: string): string | undefined {
  return HISTORY_HOLDS[claimId]
}
