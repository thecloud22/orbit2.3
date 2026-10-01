/**
 * Life claim intake — a phone notice of death. POST /intake/life/drafts, POST /intake/life/{draftId}:submit.
 *
 * Submitting saves the notice and an outbox event in one transaction; the outbox relay starts the intake
 * orchestration (orch-<claim>-intake) in Temporal. The mock does that orchestration's work inline and
 * records each step on the claim's workflow (see lifeFlow.ts), so the Workflow & SLA section can show it.
 */
import { CASTELLANO_INTAKE } from './fixtures/lifeIntake'
import { claims } from './claims'
import { requirements, type RequirementRecord } from './requirements'
import { addCommunication } from './communications'
import { logEvent } from './history'
import { addTask } from './tasks'
import { workItems } from './work'
import { fail, newId, respond } from './store'
import { INTEREST_RATE, lifeStages, startLifeFlow, type FlowReq } from './lifeFlow'
import { addBusinessDays, addDays, fmtDate, TODAY } from '../lib/dates'
import { fmtMoney, fmtMoneyShort } from '../lib/money'
import type { Check, YesNo } from './intake'
import type { BenefitLine, Claim, ISODate, Party, SectionKey } from './types'

// ---------------------------------------------------------------- Types

export interface LifePolicy {
  ref: string
  product: string
  issued: ISODate
  paidTo: ISODate
  faceAmount: number
  inForce: boolean
  lapsed?: ISODate
  riders: { key: 'adb'; name: string; amount: number }[]
  owner: string
  source: string
}

export interface DesignatedBeneficiary {
  id: string
  name: string
  relationship: string
  kind: 'primary' | 'contingent'
  /** Percent. */
  share: number
  dob?: ISODate
  died?: ISODate
  diedSource?: string
}

/** What policy administration knows once the insured is found. GET /intake/life/context */
export interface LifeIntakeContext {
  claimId: string
  call: { inbound: string; started: string; elapsed: number; language: string }
  caller: { name: string; phone: string; email: string; address: string }
  insured: { name: string; dob: ISODate; ssnLast4: string; address: string; state: string }
  agent: { name: string; agency: string }
  policies: LifePolicy[]
  designation: { date: ISODate; source: string; beneficiaries: DesignatedBeneficiary[] }
}

export type Manner = 'natural' | 'accident' | 'pending' | ''

/**
 * Mock only: how the outside world behaves once the claim is submitted. The real claim doesn't know this
 * in advance; the mock uses it to script the happenings that Play next applies (see lifeFlow.ts).
 * 'evidence' = a requirement never arrives · 'late' = a service level is missed · 'competing' = a second claimant ·
 * 'bounce' = things bounce back: a worker restart, a failed TIN match, a photocopy, a letters outage, a returned payment.
 */
export type Variation = 'none' | 'evidence' | 'late' | 'competing' | 'bounce'

export interface BeneficiaryContact {
  phone: string
  email: string
  address: string
  /** How their claim packet goes: a portal invite by email, or paper by mail. */
  packet: 'portal' | 'mail' | ''
}

export interface LifeDraft {
  // 1 · Caller
  callerName: string
  relationship: string
  phone: string
  email: string
  contactBy: { email: boolean; text: boolean; phone: boolean; mail: boolean }
  verifiedDob: boolean
  verifiedPolicy: boolean
  agentConsent: YesNo
  // 2 · The deceased
  dateOfDeath: string
  placeOfDeath: string
  manner: Manner
  variation: Variation
  outsideUs: YesNo
  funeralHome: string
  // 3 · Policies
  claimRefs: string[]
  readBack: boolean
  // 4 · Beneficiaries
  contacts: Record<string, BeneficiaryContact>
  otherClaimants: YesNo
  // 5 · Review
  nextStepsRead: boolean
}

export interface LifeRoute {
  track: 'Fast track life' | 'Standard life'
  rule: string
  examiner: string
  examinerId: string
  reasons: string[]
}

/** One requirement the set-up will request, before it has an id. */
export interface PlannedRequirement {
  key: FlowReq['key']
  name: string
  purpose: string
  from: string
  fromDetail: string
  /** Days until the follow-up deadline fires if it hasn't arrived. */
  followUpDays: number
  beneficiaryId?: string
  /** Already satisfied from our own records at set-up. */
  onFile?: string
  forRider?: boolean
}

/** A service level the claim will run on, as the intake page previews it. */
export interface SlaPreview {
  name: string
  rule: string
  source: 'State rule' | 'Internal'
  when: string
}

// ---------------------------------------------------------------- Reads

/** GET /intake/life/context — the insured, policies and beneficiary designation from policy administration. */
export function getLifeIntakeContext(): Promise<LifeIntakeContext> {
  return respond(CASTELLANO_INTAKE)
}

/** Where the call is when the page opens: Diane has given her name and her father's details. */
export function lifeDraftFromContext(ctx: LifeIntakeContext): LifeDraft {
  const living = ctx.designation.beneficiaries.filter((b) => !b.died)
  const contacts: Record<string, BeneficiaryContact> = {}
  for (const b of living) {
    contacts[b.id] = b.name === ctx.caller.name
      ? { phone: ctx.caller.phone, email: ctx.caller.email, address: ctx.caller.address, packet: 'portal' }
      : { phone: '', email: '', address: '', packet: '' }
  }
  return {
    callerName: ctx.caller.name,
    relationship: 'Child',
    phone: ctx.caller.phone,
    email: ctx.caller.email,
    contactBy: { email: true, text: true, phone: false, mail: false },
    verifiedDob: false,
    verifiedPolicy: false,
    agentConsent: '',
    dateOfDeath: '2026-09-19',
    placeOfDeath: 'At home, Two Harbors, MN',
    manner: 'natural',
    variation: 'none',
    outsideUs: 'no',
    funeralHome: 'Lakeshore Funeral Chapel, Two Harbors',
    claimRefs: ctx.policies.filter((p) => p.inForce).map((p) => p.ref),
    readBack: false,
    contacts,
    otherClaimants: '',
    nextStepsRead: false,
  }
}

// ---------------------------------------------------------------- Rules

/** Policies and beneficiaries in play for this draft. */
export function inPlay(ctx: LifeIntakeContext, draft: LifeDraft) {
  const claimed = ctx.policies.filter((p) => p.inForce && draft.claimRefs.includes(p.ref))
  const living = ctx.designation.beneficiaries.filter((b) => !b.died)
  const primaryGone = ctx.designation.beneficiaries.filter((b) => b.kind === 'primary').every((b) => b.died)
  const payees = primaryGone ? living.filter((b) => b.kind === 'contingent') : living.filter((b) => b.kind === 'primary')
  return { claimed, living, primaryGone, payees }
}

/** Two years from issue: the contestable period and the suicide exclusion both end then. */
export function twoYearsFrom(iso: ISODate): ISODate {
  return `${Number(iso.slice(0, 4)) + 2}${iso.slice(4, 10)}`
}

export function ageOnDate(dob: ISODate, on: ISODate): number {
  const [y1, m1, d1] = dob.split('-').map(Number)
  const [y2, m2, d2] = on.split('-').map(Number)
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0)
}

/** What could be payable: the face amounts, plus the accidental death rider when the death was an accident. */
export function payable(ctx: LifeIntakeContext, draft: LifeDraft): { face: number; adb: number; total: number } {
  const { claimed } = inPlay(ctx, draft)
  const face = claimed.reduce((a, p) => a + p.faceAmount, 0)
  const adb = draft.manner === 'accident' ? claimed.reduce((a, p) => a + p.riders.reduce((r, x) => r + x.amount, 0), 0) : 0
  return { face, adb, total: face + adb }
}

/** Checks against policy administration and the claims index, before anything is created. */
export function lifeChecks(ctx: LifeIntakeContext, draft: LifeDraft): Check[] {
  const dod = /^\d{4}-\d{2}-\d{2}$/.test(draft.dateOfDeath) ? draft.dateOfDeath : TODAY
  const { claimed, primaryGone, payees } = inPlay(ctx, draft)
  const out: Check[] = []
  for (const p of claimed) {
    const graceEnd = addDays(p.paidTo, 31)
    out.push({ id: `force-${p.ref}`, label: `${p.ref} in force on the date of death`, note: `premium paid to ${fmtDate(p.paidTo, { year: true })}`, tone: dod <= graceEnd ? 'positive' : 'caution' })
    const ends = twoYearsFrom(p.issued)
    out.push(dod >= ends
      ? { id: `contest-${p.ref}`, label: 'Past the contestable period and suicide exclusion', note: `both ended ${fmtDate(ends, { year: true })}`, tone: 'positive' }
      : { id: `contest-${p.ref}`, label: 'Within 2 years of issue — contestable', note: `ends ${fmtDate(ends, { year: true })}`, tone: 'caution' })
  }
  for (const p of ctx.policies.filter((x) => !x.inForce)) {
    out.push({ id: `lapsed-${p.ref}`, label: `${p.ref} lapsed ${fmtDate(p.lapsed ?? p.paidTo, { year: true })}`, note: 'nothing payable', tone: 'neutral' })
  }
  out.push(primaryGone
    ? { id: 'bene', label: 'Primary beneficiary died first', note: `${payees.map((b) => `${b.name.split(' ')[0]} ${b.share}%`).join(' · ')} as contingents`, tone: 'neutral' }
    : { id: 'bene', label: 'Primary beneficiary living', note: '', tone: 'positive' })
  const existing = claims.where((c) => c.id !== ctx.claimId && c.family === 'life' && c.name === ctx.insured.name)
  out.push(existing.length
    ? { id: 'dup', label: 'Possible duplicate claim', note: existing.map((c) => c.id).join(', '), tone: 'caution' }
    : { id: 'dup', label: 'No other claim for this death', note: '', tone: 'positive' })
  out.push({ id: 'dmf', label: 'Not on the death master file yet', note: 'the certified certificate proves the death', tone: 'neutral' })
  return out
}

/** The routing rules. Rules, not a suggestion: the reasons are listed and logged. */
export function routeLife(ctx: LifeIntakeContext, draft: LifeDraft): LifeRoute {
  const { claimed, payees } = inPlay(ctx, draft)
  const dod = draft.dateOfDeath || TODAY
  const reasons: string[] = []
  const blockers: string[] = []
  if (draft.manner === 'natural') reasons.push('Natural causes')
  else blockers.push(draft.manner === 'accident' ? 'Accidental death — the rider needs a report' : 'Cause of death pending')
  if (claimed.every((p) => dod >= twoYearsFrom(p.issued))) reasons.push('Past the contestable period')
  else blockers.push('Contestable policy')
  const { total } = payable(ctx, draft)
  if (total <= 500_000) reasons.push(`${fmtMoneyShort(total)} is within the $500,000 fast-track limit`)
  else blockers.push(`${fmtMoneyShort(total)} is above the $500,000 fast-track limit`)
  if (payees.every((b) => !b.dob || ageOnDate(b.dob, TODAY) >= 18)) reasons.push('Beneficiaries are adults')
  else blockers.push('A beneficiary is a minor')
  if (draft.otherClaimants === 'yes') blockers.push('Someone else may claim')
  if (draft.outsideUs === 'yes') blockers.push('Death outside the US')
  return blockers.length
    ? { track: 'Standard life', rule: 'LF-02', examiner: 'Rachel Kim', examinerId: 'rachel', reasons: blockers }
    : { track: 'Fast track life', rule: 'LF-01', examiner: 'Rachel Kim', examinerId: 'rachel', reasons }
}

/** The requirement set: picked by product, manner of death and who the payees are. */
export function requirementSet(ctx: LifeIntakeContext, draft: LifeDraft): PlannedRequirement[] {
  const { payees, primaryGone } = inPlay(ctx, draft)
  const set: PlannedRequirement[] = [
    { key: 'certificate', name: 'Certified death certificate', purpose: 'Proof of death', from: draft.callerName || ctx.caller.name, fromDetail: `Mail or upload · ${draft.funeralHome ? 'the funeral home orders copies' : 'from the county'}`, followUpDays: 10 },
  ]
  for (const b of payees) {
    const c = draft.contacts[b.id]
    set.push({ key: 'statement', name: `Claimant statement and W-9 · ${b.name.split(' ')[0]}`, purpose: 'Proof of claim', from: b.name, fromDetail: c?.packet === 'mail' ? 'Paper packet by mail' : 'Portal · e-sign', followUpDays: 10, beneficiaryId: b.id })
  }
  if (primaryGone) {
    const gone = ctx.designation.beneficiaries.find((b) => b.kind === 'primary')!
    set.push({ key: 'primary', name: `Proof ${gone.name} died first`, purpose: 'Beneficiary', from: 'Our records', fromDetail: gone.diedSource ?? '', followUpDays: 0, onFile: gone.diedSource })
  }
  if (draft.manner === 'accident') {
    set.push({ key: 'report', name: 'Police or accident report', purpose: 'Accidental death rider', from: 'Lake County Sheriff’s Office', fromDetail: 'Records request by fax', followUpDays: 10, forRider: true })
  }
  if (draft.manner === 'pending') {
    set.push({ key: 'amended', name: 'Amended certificate with final cause', purpose: 'Cause of death', from: 'Lake County Medical Examiner', fromDetail: 'Issued when the cause is final', followUpDays: 30, forRider: true })
  }
  return set
}

/** The service levels this claim will run on. Rule values are examples until the state rules table exists. */
export function slaPreview(draft: LifeDraft): SlaPreview[] {
  const ack = addDays(TODAY, 15)
  return [
    { name: 'First contact', rule: '1 business day', source: 'Internal', when: `by ${fmtDate(addBusinessDays(TODAY, 1), { weekday: true })}` },
    { name: 'Acknowledge the claim', rule: '15 days from notice', source: 'State rule', when: `by ${fmtDate(ack)} · sent on submit` },
    { name: 'Claim forms to each beneficiary', rule: '15 days from notice', source: 'State rule', when: `by ${fmtDate(ack)} · sent on submit` },
    { name: 'Status letter while undecided', rule: 'Every 30 days', source: 'State rule', when: `first ${fmtDate(addDays(TODAY, 30))}` },
    { name: 'Decide after proof of loss', rule: '30 days', source: 'State rule', when: 'starts when proof is complete' },
    { name: 'Pay after approval', rule: '2 business days', source: 'Internal', when: 'next daily payment run' },
    { name: 'Interest on proceeds', rule: `${(INTEREST_RATE * 100).toFixed(1)}% a year`, source: 'State rule', when: /^\d{4}-\d{2}-\d{2}$/.test(draft.dateOfDeath) ? `from ${fmtDate(draft.dateOfDeath)} to payment` : 'from the date of death' },
  ]
}

// ---------------------------------------------------------------- Submit

const LIFE_SECTIONS: SectionKey[] = ['overview', 'workflow', 'policies', 'people', 'requirements', 'documents', 'decision', 'payments', 'communications', 'history']

/**
 * POST /intake/life/{draftId}:submit — one transaction saves the notice and outbox event E-9001; the relay
 * starts orch-L-26-043310-intake, which checks, sets up the claim, requests evidence and writes the deadlines.
 * `at` is the call clock ('10:09') so the history reads in call order.
 */
export function submitLifeIntake(ctx: LifeIntakeContext, draft: LifeDraft, actor: string, at: string): Promise<string> {
  const id = ctx.claimId
  if (claims.get(id)) return fail(`${id} has already been submitted`)
  const stamp = `${TODAY}T${at}`
  const { claimed, payees, primaryGone } = inPlay(ctx, draft)
  const policy = claimed[0]
  if (!policy) return fail('No policy is being claimed')
  const route = routeLife(ctx, draft)
  const set = requirementSet(ctx, draft)
  const amounts = payable(ctx, draft)
  const age = ageOnDate(ctx.insured.dob, draft.dateOfDeath)
  const consent = draft.agentConsent === 'yes'
  const caller = draft.callerName
  const callerFirst = caller.split(' ')[0]
  const rider = policy.riders.find((r) => r.key === 'adb')
  const primary = ctx.designation.beneficiaries.find((b) => b.kind === 'primary')

  const benefitLines: BenefitLine[] = [
    {
      id: 'bl-cast-wl',
      name: policy.product,
      ref: policy.ref,
      refNote: `issued ${fmtDate(policy.issued, { year: true })}`,
      amount: policy.faceAmount,
      amountNote: 'face amount · plus interest from the date of death',
      status: { label: 'Gathering evidence', tone: 'info' },
      waitingOn: 'Death certificate · claimant statements',
    },
  ]
  if (rider) {
    benefitLines.push({
      id: 'bl-cast-adb',
      name: rider.name,
      ref: policy.ref,
      refNote: 'rider · pays only for an accidental death',
      amount: rider.amount,
      status: draft.manner === 'accident' ? { label: 'Gathering evidence', tone: 'info' } : draft.manner === 'pending' ? { label: 'Cause pending', tone: 'caution' } : { label: 'Not payable · natural causes', tone: 'neutral' },
      waitingOn: draft.manner === 'accident' ? 'Police report' : draft.manner === 'pending' ? 'Medical examiner' : undefined,
    })
  }

  const parties: Party[] = [
    { id: 'p1', name: ctx.insured.name, roles: ['Insured', 'Owner'], note: `Died ${fmtDate(draft.dateOfDeath, { year: true })}, age ${age} · ${draft.placeOfDeath}` },
  ]
  if (primary) {
    parties.push({ id: 'p-primary', name: primary.name, roles: ['Beneficiary'], relationship: `${primary.relationship} · primary`, share: `${primary.share}%`, status: primary.died ? { label: `Died ${fmtDate(primary.died, { year: true })}`, tone: 'neutral' } : undefined, note: primary.diedSource })
  }
  for (const b of payees) {
    const c = draft.contacts[b.id]
    parties.push({
      id: `p-${b.id}`,
      name: b.name,
      roles: b.name === caller ? ['Beneficiary', 'Claimant'] : ['Beneficiary'],
      relationship: `${b.relationship}${primaryGone ? ' · contingent' : ''}`,
      share: `${b.share}%`,
      status: { label: 'Packet sent', tone: 'info' },
      contact: [c?.packet === 'mail' ? 'Mail' : 'Portal', c?.email, c?.phone].filter(Boolean).join(' · '),
    })
  }
  if (draft.funeralHome.trim()) parties.push({ id: 'p-fh', name: draft.funeralHome.split(',')[0], roles: ['Funeral home'], note: 'No assignment filed' })
  parties.push({
    id: 'p-agent',
    name: ctx.agent.name,
    roles: ['Agent of record'],
    note: ctx.agent.agency,
    access: consent ? 'Status only, with Diane’s consent' : 'None · Diane declined',
    status: consent ? { label: `Consent ${fmtDate(TODAY)}`, tone: 'neutral' } : { label: 'No consent', tone: 'neutral' },
  })

  const claim: Claim = {
    id,
    family: 'life',
    product: policy.product,
    name: ctx.insured.name,
    tags: [{ label: route.track === 'Fast track life' ? 'Fast track' : 'Standard', tone: 'plain' }],
    facts: [
      `Insured and owner · died ${fmtDate(draft.dateOfDeath, { year: true })}, age ${age}`,
      `${policy.product} · ${policy.ref} · ${fmtMoney(policy.faceAmount)}`,
      `Filed ${fmtDate(TODAY)} by phone · ${caller}, ${(payees.find((b) => b.name === caller)?.relationship ?? draft.relationship).toLowerCase()}`,
    ],
    ownerId: route.examinerId,
    team: 'Life & annuity team',
    filed: TODAY,
    stage: lifeStages(1),
    clocks: [],
    nextStep: { label: `Welcome call to ${callerFirst}`, reason: `New today · first contact due ${fmtDate(addBusinessDays(TODAY, 1), { weekday: true })}`, section: 'workflow' },
    exceptions: [],
    benefitLines,
    parties,
    summary: {
      text: `${ctx.insured.name} died on ${fmtDate(draft.dateOfDeath, { year: true })} (${draft.manner === 'natural' ? 'natural causes' : draft.manner === 'accident' ? 'an accident' : 'cause pending'}). His ${policy.product.toLowerCase()} policy ${policy.ref} was in force and is past its contestable period. ${primaryGone && primary ? `${primary.name.split(' ')[0]}, the primary beneficiary, died in ${primary.died?.slice(0, 4)}, so ${payees.map((b) => b.name.split(' ')[0]).join(' and ')} take ${payees.map((b) => `${b.share}%`).join(' and ')} as contingents.` : ''} ${route.track} — the claim waits on the death certificate and each beneficiary’s statement.`.replace(/\s+/g, ' ').trim(),
      asOf: `${at} · phone intake`,
      sources: ['Intake call 25 Sep', `Policy record ${policy.ref}`, 'Beneficiary designation'],
    },
    suggestions: [],
    linked: [`${caller} — person`, ...payees.filter((b) => b.name !== caller).map((b) => `${b.name} — person`), ...(consent ? [`Agent ${ctx.agent.name}`] : [])],
    sections: LIFE_SECTIONS,
    detail: { kind: 'life', beneficiaryNote: `Designation of ${fmtDate(ctx.designation.date, { year: true })}${primaryGone ? ' · primary died first' : ''}` },
  }
  claims.insert(claim)

  // Requirements — one row each; the follow-up deadline for each is written by the flow.
  const reqs: FlowReq[] = []
  for (const p of set) {
    const r: RequirementRecord = {
      id: newId('req'),
      claimId: id,
      name: p.name,
      purpose: p.purpose,
      from: p.from,
      fromDetail: p.fromDetail,
      status: p.onFile ? { label: 'On file', tone: 'positive' } : { label: `Requested ${fmtDate(TODAY)}`, tone: 'info' },
      state: p.onFile ? 'met' : 'open',
      requested: TODAY,
      requestedVia: p.onFile ? 'Automatic · our records' : p.fromDetail,
      reminderVia: p.key === 'report' || p.key === 'amended' ? 'fax' : 'email',
      followUps: [],
      due: p.onFile ? undefined : addDays(TODAY, 30),
      receivedOn: p.onFile ? TODAY : undefined,
      waitingOn: p.onFile ? undefined : p.from,
      benefitLineId: p.forRider ? 'bl-cast-adb' : 'bl-cast-wl',
      plan: p.onFile
        ? [{ date: TODAY, label: 'Satisfied from our records at set-up', note: p.onFile, state: 'done' }]
        : [
            { date: TODAY, label: `Requested · ${p.fromDetail}`, note: 'intake run', state: 'done' },
            { date: addDays(TODAY, p.followUpDays), label: 'Follow-up deadline fires if it hasn’t arrived', state: 'todo' },
            { date: addDays(TODAY, 30), label: 'Listed in the status letter if still missing', state: 'todo' },
          ],
    }
    requirements.insert(r)
    reqs.push({ id: r.id, key: p.key, name: p.name, from: p.from, followUpDays: p.followUpDays, onFile: !!p.onFile, beneficiaryId: p.beneficiaryId, callerIs: p.from === caller })
  }

  // Communications the intake run sends
  const callStart = `${TODAY}T${ctx.call.started}`
  addCommunication({ claimId: id, at: callStart, channel: 'call', direction: 'in', title: 'Death reported by phone', party: `${caller} · ${ctx.call.inbound}`, detail: `Notice of death taken by ${actor}; caller confirmed ${ctx.insured.name.split(' ')[0]}’s date of birth and policy number; call recorded`, status: { label: 'Logged', tone: 'neutral' } })
  addCommunication({ claimId: id, at: stamp, channel: draft.contactBy.email ? 'email' : 'letter', direction: 'out', title: 'Claim acknowledgement', party: `${caller} · ${draft.contactBy.email ? 'email' : 'letter'}`, detail: `Claim ${id} received; our condolences; what we need and what happens next`, status: { label: 'Sent', tone: 'positive' }, template: 'ACK-LIFE-01' })
  for (const b of payees) {
    const c = draft.contacts[b.id]
    addCommunication({ claimId: id, at: stamp, channel: c?.packet === 'mail' ? 'letter' : 'portal', direction: 'out', title: `Claim packet · ${b.name.split(' ')[0]}`, party: `${b.name} · ${c?.packet === 'mail' ? 'mail' : 'portal invite by email'}`, detail: 'Claimant statement with W-9, how the proceeds are paid, and the death certificate we need', status: { label: 'Sent', tone: 'positive' }, template: 'PKT-LIFE-02' })
  }
  if (consent) addCommunication({ claimId: id, at: stamp, channel: 'email', direction: 'out', title: 'Agent notification · status only', party: `${ctx.agent.name} · agent of record`, detail: `A claim was filed today on ${policy.ref}. You will see its status only.`, status: { label: 'Sent', tone: 'positive' }, template: 'AGT-NOTE-01' })

  // The examiner's queue
  addTask(id, `Welcome call to ${callerFirst}`, route.examiner, 'Intake · first contact', addBusinessDays(TODAY, 1))
  workItems.insert({
    id: newId('w'),
    ownerId: route.examinerId,
    claimId: id,
    priority: 2,
    action: `New life claim — welcome call to ${callerFirst}`,
    why: `Phone intake today · ${route.track} · first contact due ${fmtDate(addBusinessDays(TODAY, 1))}`,
    due: addBusinessDays(TODAY, 1),
    waitingOn: 'You',
    section: 'workflow',
    whyNext: `${ctx.insured.name} died on ${fmtDate(draft.dateOfDeath)}. ${payees.map((b) => b.name.split(' ')[0]).join(' and ')} are the beneficiaries. Call ${callerFirst} to explain what happens next.`,
    views: ['dueToday'],
    status: 'open',
  })

  // History, in call order
  const who = `${actor} · phone intake`
  logEvent(id, { at: callStart, type: 'access', title: `Caller confirmed ${ctx.insured.name.split(' ')[0]}’s date of birth and policy number`, actor: who })
  logEvent(id, { at: stamp, type: 'data', title: 'Notice of death saved · event E-9001 to the outbox', actor: who, detail: `Died ${fmtDate(draft.dateOfDeath)} · ${draft.manner === 'natural' ? 'natural causes' : draft.manner === 'accident' ? 'accident' : 'cause pending'}` })
  logEvent(id, { at: stamp, type: 'data', title: `Intake run orch-${id}-intake: checks passed, claim set up`, actor: 'System · Temporal', detail: `${set.length} requirements, ${reqs.filter((r) => r.onFile).length} already on file` })
  logEvent(id, { at: stamp, type: 'task', title: `Routed ${route.track} → ${route.examiner}`, actor: `System · routing rule ${route.rule}`, detail: route.reasons.join(' · ') })
  logEvent(id, { at: stamp, type: 'communication', title: 'Acknowledgement and claim packets sent', actor: 'System · ACK-LIFE-01, PKT-LIFE-02' })
  if (consent) logEvent(id, { at: stamp, type: 'access', title: `Agent ${ctx.agent.name} given status-only access`, actor: who, detail: 'Consent given on the intake call' })

  startLifeFlow({
    claimId: id,
    insured: ctx.insured.name,
    noticeAt: stamp,
    dateOfDeath: draft.dateOfDeath,
    manner: draft.manner || 'natural',
    variation: draft.variation,
    policyRef: policy.ref,
    issued: policy.issued,
    paidTo: policy.paidTo,
    face: policy.faceAmount,
    adb: rider ? { amount: rider.amount, payable: draft.manner === 'accident' } : undefined,
    total: amounts.total,
    route,
    reqs,
    payees: payees.map((b) => ({ id: b.id, name: b.name, share: b.share, packet: draft.contacts[b.id]?.packet === 'mail' ? 'mail' : 'portal' })),
    caller,
    consent,
    agent: ctx.agent.name,
    policiesFound: ctx.policies.length,
    lapsedFound: ctx.policies.filter((p) => !p.inForce).length,
  })

  return respond(id)
}
