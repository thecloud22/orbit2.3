import { CLINICAL } from './fixtures/clinical'
import { collection, fail, respond } from './store'
import { logEvent } from './history'
import { tasks } from './tasks'
import { fmtDate, nowStamp } from '../lib/dates'
import type { ISODate, SectionKey, Status, User } from './types'

// ---------------------------------------------------------------- Clinical file  GET /claims/{id}/clinical

/** One set of restrictions and limitations, from one APS. Versions are never edited; a new APS proposes the next. */
export interface RestrictionVersion {
  v: number
  date: ISODate
  source: string
  /** proposed = extracted from a new APS and pending review in Documents. */
  state: 'superseded' | 'current' | 'proposed'
  values: Record<string, string>
  docId?: string
}

export interface OccupationalDemand {
  demand: string
  current: string
  proposed: string
  /** Compared by the clinician; 'unknown' until restrictions are on file. */
  fit: 'within' | 'partly' | 'beyond' | 'unknown'
  /** A reference demand for the any-occupation definition rather than his own occupation. */
  anyOcc?: boolean
}

export interface ClinicalOpinion {
  supported: 'supported' | 'partially' | 'notSupported'
  consistent: string[]
  ownOcc: 'prevented' | 'partly' | 'notPrevented'
  sedentary: 'notSupported' | 'supported' | 'unclear'
  recommendation: string
  peerReview: 'yes' | 'no'
  nextReview: ISODate
  savedAt?: ISODate
  signedAt?: ISODate
  signedBy?: string
}

export interface ClinicalReferral {
  nurse: string
  from: string
  opened: ISODate
  due: ISODate
  question: string
  state: 'open' | 'returned'
  opinion: ClinicalOpinion
  /** Proposed wording for the recommendation, dashed until accepted. */
  suggestion?: { text: string; sources: string[]; state: 'open' | 'accepted' | 'dismissed' }
  contacts: { at: ISODate; text: string }[]
}

export interface ClinicalFile {
  /** Same as the claim id. */
  id: string
  claimId: string
  condition: string
  treating: string
  diagnoses: { code: string; label: string; since?: string; primary?: boolean }[]
  providers: { name: string; specialty: string; role: string; since?: string; last?: string; next?: ISODate; contact?: string; status?: Status }[]
  /** Row order for the restrictions table. */
  functions: string[]
  versions: RestrictionVersion[]
  demands: OccupationalDemand[]
  timeline: { date: string; label: string; current?: boolean }[]
  guideline?: string
  nextVisit?: ISODate
  referral?: ClinicalReferral
  /** For a claim still gathering evidence: what is known and what is missing. */
  known?: { label: string; value: string; source: string; date: ISODate }[]
  missing?: { label: string; detail: string; from: string; status: Status; action?: { label: string; section: SectionKey; target?: string } }[]
}

export const clinicalFiles = collection<ClinicalFile>(CLINICAL)

/** GET /claims/{id}/clinical — undefined when there is no clinical file in the mock. */
export function getClinical(claimId: string): Promise<ClinicalFile | undefined> {
  return respond(clinicalFiles.get(claimId))
}

/** Minimum necessary: opening medical detail is an access event. Logged once per person per claim per session. */
const viewed = new Set<string>()
export function logMedicalView(claimId: string, user: User): void {
  const key = `${claimId}/${user.id}`
  if (viewed.has(key)) return
  viewed.add(key)
  logEvent(claimId, { type: 'access', title: 'Medical section opened — restrictions, diagnoses and providers', actor: `${user.name} · ${user.title}`, ref: 'Medical' })
}

/** PUT /claims/{id}/clinical/referral/opinion — a draft; not part of the claim file until signed. */
export function saveOpinionDraft(claimId: string, opinion: ClinicalOpinion): Promise<void> {
  const f = clinicalFiles.get(claimId)
  if (!f?.referral) return fail('No open referral')
  clinicalFiles.update(claimId, { referral: { ...f.referral, opinion: { ...opinion, savedAt: nowStamp() } } })
  return respond(undefined)
}

/** Accept or dismiss the proposed wording. Accepting appends it to the recommendation draft. */
export function decideWording(claimId: string, choice: 'accepted' | 'dismissed', by: string): Promise<void> {
  const f = clinicalFiles.get(claimId)
  const r = f?.referral
  if (!r?.suggestion) return fail('No suggested wording')
  const opinion = choice === 'accepted' ? { ...r.opinion, recommendation: `${r.opinion.recommendation.trim()} ${r.suggestion.text}`.trim() } : r.opinion
  clinicalFiles.update(claimId, { referral: { ...r, opinion, suggestion: { ...r.suggestion, state: choice } } })
  logEvent(claimId, { type: 'assistant', title: `Suggested wording ${choice} — clinical opinion`, actor: `${by} · assistant suggestion`, ref: r.suggestion.sources[0] })
  return respond(undefined)
}

/**
 * POST /claims/{id}/clinical/referral:sign — records the opinion in the claim file and returns the referral
 * to the case manager. The nurse's review task closes.
 */
export function signOpinion(claimId: string, opinion: ClinicalOpinion): Promise<void> {
  const f = clinicalFiles.get(claimId)
  const r = f?.referral
  if (!r) return fail('No open referral')
  const stamp = nowStamp()
  clinicalFiles.update(claimId, { referral: { ...r, state: 'returned', opinion: { ...opinion, signedAt: stamp, signedBy: r.nurse } } })
  tasks.where((t) => t.claimId === claimId && t.assignee === r.nurse && !t.done).forEach((t) => tasks.update(t.id, { done: true }))
  logEvent(claimId, {
    type: 'data',
    title: `Clinical opinion signed and returned to ${r.from}`,
    actor: `${r.nurse} · nurse case manager`,
    detail: opinion.recommendation,
    ref: 'Medical',
  })
  logEvent(claimId, { type: 'task', title: `Next clinical review set for ${fmtDate(opinion.nextReview, { year: true })}`, actor: `${r.nurse} · nurse case manager`, ref: 'Medical' })
  return respond(undefined)
}

/** Logs a contact with the treating provider's office. */
export function logProviderContact(claimId: string, text: string, by: string): Promise<void> {
  const f = clinicalFiles.get(claimId)
  if (!f?.referral) return fail('No open referral')
  const at = nowStamp()
  clinicalFiles.update(claimId, { referral: { ...f.referral, contacts: [{ at, text }, ...f.referral.contacts] } })
  logEvent(claimId, { at, type: 'communication', title: `Contact with treating provider — ${text}`, actor: by, ref: 'Medical' })
  return respond(undefined)
}
