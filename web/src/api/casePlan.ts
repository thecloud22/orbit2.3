import { CASE_PLANS } from './fixtures/casePlan'
import { collection, fail, respond } from './store'
import { logEvent } from './history'
import { addNote } from './tasks'
import type { ISODate, SectionKey, Status, User } from './types'

// ---------------------------------------------------------------- Case plan  GET /claims/{id}/case-plan

export type MilestoneStatus = 'done' | 'inReview' | 'scheduled' | 'notStarted' | 'optional'

export const MILESTONE_STATUS: Record<MilestoneStatus, Status> = {
  done: { label: 'Done', tone: 'positive' },
  inReview: { label: 'In review', tone: 'info' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  notStarted: { label: 'Not started', tone: 'neutral' },
  optional: { label: 'Optional', tone: 'neutral' },
}

export interface Milestone {
  id: string
  label: string
  /** Display timing: 'APS 22 Sep', '14 Oct · C. Duarte', 'By 1 Dec'. */
  when: string
  due: ISODate
  owner: string
  status: MilestoneStatus
  note?: string
}

export interface CasePlan {
  /** Same as the claim id. */
  id: string
  claimId: string
  version: number
  agreed: ISODate
  agreedWith: string
  goals: string[]
  transition: { date: ISODate; ownOccEnds: ISODate; definition: string }
  milestones: Milestone[]
  workstreams: { name: string; detail?: string; owner: string; cadence: string; last: string; next: string; status: Status; section?: SectionKey }[]
  diary: { date: ISODate; label: string; who: string }[]
  team: { initials: string; name: string; role: string; note?: string }[]
  preferences: [string, string][]
  lastContact: { at: ISODate; channel: string; minutes: number; text: string; next: ISODate }
  versions: { v: number; date: ISODate; by: string; summary: string }[]
}

export const casePlans = collection<CasePlan>(CASE_PLANS)

/** GET /claims/{id}/case-plan — undefined when the claim has no plan. */
export function getCasePlan(claimId: string): Promise<CasePlan | undefined> {
  return respond(casePlans.get(claimId))
}

/** PATCH /claims/{id}/case-plan/milestones/{mid} — status, timing or a note. Logged. */
export function updateMilestone(claimId: string, milestoneId: string, patch: Pick<Milestone, 'status' | 'when'> & { note?: string }, by: User): Promise<void> {
  const plan = casePlans.get(claimId)
  const m = plan?.milestones.find((x) => x.id === milestoneId)
  if (!plan || !m) return fail('Milestone not found')
  const changes: string[] = []
  if (patch.status !== m.status) changes.push(`${MILESTONE_STATUS[m.status].label} → ${MILESTONE_STATUS[patch.status].label}`)
  if (patch.when.trim() && patch.when !== m.when) changes.push(`timing ${m.when} → ${patch.when}`)
  if (!changes.length && !patch.note?.trim()) return respond(undefined)
  casePlans.update(claimId, (p) => ({
    milestones: p.milestones.map((x) => (x.id === milestoneId ? { ...x, status: patch.status, when: patch.when.trim() || x.when, note: patch.note?.trim() || x.note } : x)),
  }))
  logEvent(claimId, {
    type: 'data',
    title: `Case plan milestone updated — ${m.label}${changes.length ? `: ${changes.join(', ')}` : ''}`,
    actor: `${by.name} · case plan v${plan.version}`,
    detail: patch.note?.trim() || undefined,
    ref: 'Case plan',
  })
  return respond(undefined)
}

/** POST /claims/{id}/notes with a case-plan context. The note shows in the claim's notes too. */
export async function addPlanNote(claimId: string, text: string, by: User): Promise<void> {
  const plan = casePlans.get(claimId)
  if (!plan) return fail('No case plan')
  await addNote(claimId, by.name, text)
  logEvent(claimId, { type: 'data', title: 'Case plan note added', actor: `${by.name} · case plan v${plan.version}`, detail: text, ref: 'Case plan' })
}
