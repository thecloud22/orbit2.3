import { CONTESTABLE } from './fixtures/contestable'
import { collection, fail, respond } from './store'
import { claims, decideSuggestion } from './claims'
import { logEvent } from './history'
import { addTask, tasks } from './tasks'
import { fmtDate, nowStamp, TODAY } from '../lib/dates'
import type { ISODate, Status, User } from './types'

// ---------------------------------------------------------------- Contestable review  GET /claims/{id}/contestable-review

export interface ApplicationAnswer {
  id: string
  /** 'Q4' */
  question: string
  text: string
  answer: string
  /** What the records show, in plain words. */
  evidence: string
  sources: string[]
  /** consistent = records agree so far; question = a difference for Underwriting (never a finding); pending = records not in yet. */
  state: 'consistent' | 'question' | 'pending'
  note?: string
}

export interface RecordRequest {
  id: string
  name: string
  from: string
  requested: ISODate
  status: Status
  followUps: string[]
  due?: ISODate
}

export interface UnderwritingReferral {
  state: 'notReferred' | 'referred' | 'opinionReceived'
  to: string
  due?: ISODate
  referredAt?: ISODate
  by?: string
  question?: string
}

export interface ContestableReview {
  /** Same as the claim id — one review per claim in the mock. */
  id: string
  claimId: string
  benefitLineId: string
  policy: string
  product: string
  face: number
  issued: ISODate
  applicationSigned: ISODate
  death: ISODate
  periodEnds: ISODate
  due: ISODate
  owner: string
  provision: string
  checks: { id: string; label: string; detail: string; status: Status }[]
  answers: ApplicationAnswer[]
  records: RecordRequest[]
  referral: UnderwritingReferral
  rider: { name: string; amount: number; rule: string; evidence: { label: string; status: Status }[] }
}

const REFERRAL_TASK = 'Underwriting referral: application Q4'

export const contestableReviews = collection<ContestableReview>(CONTESTABLE)

/** GET /claims/{id}/contestable-review — undefined when the claim has no contestable policy. */
export function getContestable(claimId: string): Promise<ContestableReview | undefined> {
  const r = contestableReviews.get(claimId)
  if (!r) return respond(undefined)
  // A referral may also have been made from the assistant's suggestion in the context panel.
  const viaTask = tasks.where((t) => t.claimId === claimId && t.title === REFERRAL_TASK)[0]
  if (r.referral.state === 'notReferred' && viaTask) {
    return respond({
      ...r,
      referral: { ...r.referral, state: 'referred', by: viaTask.assignee === 'Underwriting' ? undefined : viaTask.assignee },
      checks: r.checks.map((c) => (c.id === 'c3' ? { ...c, status: { label: 'Referred', tone: 'info' } } : c)),
    })
  }
  return respond(r)
}

/**
 * POST /claims/{id}/contestable-review/referrals — asks Underwriting whether a difference was material.
 * Creates the Underwriting task and logs the referral; the examiner still records the decision.
 */
export function referToUnderwriting(claimId: string, question: string, by: User): Promise<void> {
  const r = contestableReviews.get(claimId)
  if (!r) return fail('No contestable review on this claim')
  if (r.referral.state !== 'notReferred') return fail('Already referred to Underwriting')

  const suggestion = claims.get(claimId)?.suggestions.find((s) => s.creates === REFERRAL_TASK && s.state === 'open')
  const alreadyTasked = tasks.where((t) => t.claimId === claimId && t.title === REFERRAL_TASK).length > 0
  if (suggestion) void decideSuggestion(claimId, suggestion.id, 'accepted', by.name)
  else if (!alreadyTasked) addTask(claimId, REFERRAL_TASK, 'Underwriting', 'Contestable review', r.referral.due)

  contestableReviews.update(claimId, (cur) => ({
    referral: { ...cur.referral, state: 'referred', referredAt: nowStamp(), by: by.name, question },
    checks: cur.checks.map((c) => (c.id === 'c3' ? { ...c, status: { label: 'Referred', tone: 'info' } } : c)),
  }))
  logEvent(claimId, {
    type: 'task',
    title: `Referred to Underwriting — application Q4 on ${r.policy}`,
    actor: `${by.name} · contestable review`,
    detail: question,
    ref: 'Application Q4',
  })
  return respond(undefined)
}

/** Logs a follow-up on an outstanding records request (a call or resend). */
export function followUpRecords(claimId: string, recordId: string, how: string, by: User): Promise<void> {
  const r = contestableReviews.get(claimId)
  const rec = r?.records.find((x) => x.id === recordId)
  if (!r || !rec) return fail('Records request not found')
  const stamp = nowStamp()
  contestableReviews.update(claimId, (cur) => ({
    records: cur.records.map((x) => (x.id === recordId ? { ...x, followUps: [...x.followUps, `${how} ${fmtDate(TODAY)} · ${by.name}`] } : x)),
  }))
  logEvent(claimId, { at: stamp, type: 'communication', title: `${how} — ${rec.name}, ${rec.from.split(' · ')[0]}`, actor: `${by.name} · contestable review`, ref: 'Records request' })
  return respond(undefined)
}
