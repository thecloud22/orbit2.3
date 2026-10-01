/**
 * New claim intake (board 04.2). POST /intake/drafts, POST /intake/{draftId}:submit.
 *
 * The draft is held by the page while the call runs; submitting does inline what the claim's intake
 * workflow will do server-side: turn the draft into a claim, request evidence, acknowledge, route.
 */
import { LINDQVIST_INTAKE } from './fixtures/intake'
import { claims, patchClaim } from './claims'
import { requirements } from './requirements'
import { addCommunication } from './communications'
import { logEvent } from './history'
import { addTask } from './tasks'
import { workItems } from './work'
import { fail, newId, respond } from './store'
import { addDays, daysFrom, fmtDate, TODAY } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import type { BenefitLine, Claim, Family, Party, Requirement, SectionKey, StageStep, Status } from './types'

// ---------------------------------------------------------------- Types

export type YesNo = 'yes' | 'no' | ''

export interface AdminPolicy {
  ref: string
  product: string
  family: Family
  status: Status
  issued: string
  paidTo: string
  monthlyBenefit?: number
  eliminationDays?: number
  definition?: string
  faceAmount?: number
  riders: string[]
  waiverAfterMonths?: number
  summary: string
  source: string
}

/** What policy administration knows about the caller before anything is typed. GET /intake/context */
export interface IntakeContext {
  claimId: string
  call: { inbound: string; started: string; elapsed: number; language: string }
  person: {
    name: string
    dob: string
    zip: string
    ssnLast4: string
    address: string
    phone: string
    email: string
    occupation: string
    roles: string
  }
  agent: { name: string; agency: string; email: string }
  policies: AdminPolicy[]
  premiumPayer: string
  eftOnFile: string
}

export interface CareProvider {
  id: string
  name: string
  practice: string
  specialty: string
  phone: string
  fax: string
  lastVisit: string
  /** The one the physician statement is requested from. */
  primary: boolean
}

export type Reason = 'illness' | 'injury' | 'pregnancy' | 'mental' | 'other'
export type PayMethod = 'eftOnFile' | 'newAccount' | 'check' | ''

export interface DiIntakeDraft {
  // 1 · Caller & identity
  caller: 'insured' | 'other'
  callerName: string
  callerRelationship: string
  verified: { dob: boolean; zip: boolean; ssn: boolean }
  phone: string
  email: string
  address: string
  contactBy: { email: boolean; text: boolean; phone: boolean; mail: boolean }
  agentConsent: YesNo
  // 2 · Coverage
  claimDi: boolean
  coverageReadBack: boolean
  // 3 · Absence & condition
  lastWorked: string
  firstUnable: string
  reason: Reason | ''
  surgery: YesNo
  procedure: string
  surgeryDate: string
  ownWords: string
  reducedHours: YesNo
  residualNote: string
  hospitalized: YesNo
  hospitalName: string
  // 4 · Care providers
  providers: CareProvider[]
  // 5 · Occupation & earnings
  occupation: string
  workType: 'employee' | 'selfEmployed' | 'owner' | ''
  hoursPerWeek: string
  setting: string
  requestDuties: boolean
  requestEarnings: boolean
  otherCoverage: YesNo
  otherCoverageNote: string
  // 6 · Payment & tax
  payMethod: PayMethod
  otherPayer: YesNo
  // 7 · Review & submit
  fraudRead: boolean
  attested: boolean
}

export interface TriageProposal {
  track: string
  team: string
  reason: string
  source: string
  state: 'open' | 'accepted' | 'dismissed'
  edited: boolean
}

export interface Check {
  id: string
  label: string
  note: string
  tone: 'positive' | 'caution' | 'neutral'
}

export interface Elimination {
  days: number
  start: string
  end: string
  accrueFrom: string
  firstPayment: string
  daysIn: number
}

export interface ContractMatch {
  claimId: string
  name: string
  ref: string
  line: string
  product: string
  family: Family
  amount?: number
  claimStatus: Status
}

export interface DeathNotice {
  family: 'life' | 'annuity'
  callerName: string
  relationship: string
  callerPhone: string
  deceasedName: string
  deceasedDob: string
  dateOfDeath: string
  placeOfDeath: string
  manner: string
  match?: ContractMatch
}

// ---------------------------------------------------------------- Reads

/** GET /intake/context?phone= — the caller's person record, agent and policies from policy administration. */
export function getIntakeContext(): Promise<IntakeContext> {
  return respond(LINDQVIST_INTAKE)
}

/** The draft as the board shows it: identity and coverage done, absence in progress. */
export function draftFromContext(ctx: IntakeContext): DiIntakeDraft {
  return {
    caller: 'insured',
    callerName: ctx.person.name,
    callerRelationship: '',
    verified: { dob: true, zip: true, ssn: true },
    phone: ctx.person.phone,
    email: ctx.person.email,
    address: ctx.person.address,
    contactBy: { email: true, text: true, phone: false, mail: false },
    agentConsent: 'yes',
    claimDi: true,
    coverageReadBack: true,
    lastWorked: '2026-09-19',
    firstUnable: '2026-09-21',
    reason: 'illness',
    surgery: 'yes',
    procedure: 'Microdiscectomy',
    surgeryDate: '2026-10-02',
    ownWords:
      'Pain from my lower back down my left leg since 19 Sep. I can’t stand for long or lift patients. The MRI showed a herniated disc and surgery is booked for 2 October.',
    reducedHours: 'no',
    residualNote: '',
    hospitalized: 'no',
    hospitalName: '',
    providers: [],
    occupation: ctx.person.occupation,
    workType: '',
    hoursPerWeek: '',
    setting: '',
    requestDuties: true,
    requestEarnings: true,
    otherCoverage: '',
    otherCoverageNote: '',
    payMethod: '',
    otherPayer: '',
    fraudRead: false,
    attested: false,
  }
}

/** Nora's answers for the steps not yet taken on the board — the mock's "fill sample answers". */
export const SAMPLE_ANSWERS: Partial<Record<'providers' | 'occupation' | 'payment', Partial<DiIntakeDraft>>> = {
  providers: {
    providers: [
      { id: 'cp-1', name: 'Dr. Mei Chen', practice: 'Northgate Spine Institute', specialty: 'Orthopedic spine surgery', phone: '(555) 013-8870', fax: '(555) 013-8871', lastVisit: '2026-09-23', primary: true },
      { id: 'cp-2', name: 'Dr. Aaron Fields', practice: 'Lakeview Family Practice', specialty: 'Family medicine', phone: '(555) 012-4410', fax: '', lastVisit: '2026-09-20', primary: false },
    ],
  },
  occupation: { workType: 'employee', hoursPerWeek: '40', setting: 'Hospital operating rooms · four 10-hour shifts, on call one weekend a month' },
  payment: { payMethod: 'eftOnFile', otherPayer: 'no' },
}

export function emptyProvider(): CareProvider {
  return { id: newId('cp'), name: '', practice: '', specialty: '', phone: '', fax: '', lastVisit: '', primary: false }
}

// ---------------------------------------------------------------- Rules

/** Whole years between two ISO dates. */
export function ageOn(dob: string, on: string): number {
  const [y1, m1, d1] = dob.split('-').map(Number)
  const [y2, m2, d2] = on.split('-').map(Number)
  return y2 - y1 - (m2 < m1 || (m2 === m1 && d2 < d1) ? 1 : 0)
}

/** The elimination period counts from the first day unable to work. Benefits are paid monthly in arrears. */
export function elimination(firstUnable: string, days = 90): Elimination | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstUnable)) return undefined
  const end = addDays(firstUnable, days)
  const accrueFrom = addDays(end, 1)
  return { days, start: firstUnable, end, accrueFrom, firstPayment: addDays(accrueFrom, 30), daysIn: Math.max(0, Math.min(days, daysFrom(firstUnable, TODAY))) }
}

/** When the waiver of premium on the life policy would start, after N months of disability. */
export function waiverStart(firstUnable: string, months: number): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstUnable)) return undefined
  const [y, m, d] = firstUnable.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + months, d))
  return t.toISOString().slice(0, 10)
}

/** Pre-submit checks against policy administration and the claims index. */
export function runChecks(ctx: IntakeContext, draft: DiIntakeDraft): Check[] {
  const di = ctx.policies.find((p) => p.family === 'disability')!
  const onDate = draft.firstUnable || TODAY
  const inForce = di.paidTo >= onDate
  const contestableEnds = addDays(di.issued, 730)
  const prior = claims.where((c) => c.id !== ctx.claimId && (c.name === ctx.person.name || c.parties.some((p) => p.name === ctx.person.name)))
  const dup = prior.filter((c) => c.family === 'disability' && !c.stage.some((s) => s.label === 'Closed' && s.state === 'current'))
  const consent = draft.agentConsent
  return [
    { id: 'force', label: 'Policy in force', note: `premium paid to ${fmtDate(di.paidTo)}`, tone: inForce ? 'positive' : 'caution' },
    { id: 'contest', label: onDate >= contestableEnds ? 'Past contestable period' : 'Within contestable period', note: `issued ${di.issued.slice(0, 4)}`, tone: onDate >= contestableEnds ? 'positive' : 'caution' },
    { id: 'prior', label: prior.length ? `${prior.length} other claim${prior.length > 1 ? 's' : ''} on file` : 'No open or prior claims', note: '', tone: prior.length ? 'caution' : 'positive' },
    { id: 'dup', label: dup.length ? 'Possible duplicate' : 'Not a duplicate', note: dup.map((c) => c.id).join(', '), tone: dup.length ? 'caution' : 'positive' },
    {
      id: 'agent',
      label: consent === 'no' ? `Agent of record ${ctx.agent.name} not notified` : `Agent of record ${ctx.agent.name} to be notified`,
      note: consent === 'yes' ? 'Nora consented on this call' : consent === 'no' ? 'Nora declined on this call' : 'ask for consent in step 1',
      tone: consent === 'yes' ? 'positive' : consent === 'no' ? 'neutral' : 'caution',
    },
  ]
}

/** The triage the rules engine proposes from what has been said so far. Advisory until accepted. */
export function proposeTriage(draft: DiIntakeDraft): Omit<TriageProposal, 'state' | 'edited'> {
  const ep = elimination(draft.firstUnable)
  const epText = ep ? ` before the elimination period ends on ${fmtDate(ep.end)}` : ' before the elimination period ends'
  if (draft.reason === 'mental')
    return { track: 'Complex DI', team: 'DI Team 2', reason: 'Mental health conditions follow the complex-claim guideline with an early clinical review.', source: 'Duration guideline' }
  if (draft.surgery === 'yes')
    return { track: 'Standard DI', team: 'DI Team 1', reason: `Expected recovery of 8–12 weeks may come${epText} — confirm after surgery.`, source: 'Duration guideline' }
  return { track: 'Standard DI', team: 'DI Team 1', reason: `Recovery time depends on the physician statement; review${epText}.`, source: 'Duration guideline' }
}

// ---------------------------------------------------------------- Death notices

/** GET /policies?q=&family= — policies and contracts by insured name or number, from the claims index. */
export function lookupContracts(q: string, family: 'life' | 'annuity'): ContractMatch[] {
  const s = q.trim().toLowerCase()
  if (s.length < 2) return []
  const out: ContractMatch[] = []
  for (const c of claims.where((c) => c.family === family)) {
    for (const b of c.benefitLines) {
      if ([c.name, b.ref, c.id].join(' ').toLowerCase().includes(s) && !out.some((o) => o.ref === b.ref)) {
        out.push({ claimId: c.id, name: c.name, ref: b.ref, line: b.name, product: c.product, family: c.family, amount: b.amount, claimStatus: b.status })
      }
    }
  }
  return out.slice(0, 6)
}

// ---------------------------------------------------------------- Submit

const DI_SECTIONS: SectionKey[] = ['overview', 'policies', 'people', 'requirements', 'documents', 'medical', 'decision', 'payments', 'case-plan', 'communications', 'history']
const DI_STAGES = ['Intake', 'Evidence', 'Decision', 'Payment', 'Managing', 'Closed']

function stagesAt(current: number): StageStep[] {
  return DI_STAGES.map((label, i) => ({ key: label.toLowerCase(), label, state: i < current ? 'done' : i === current ? 'current' : 'todo' }))
}

const REASON_TEXT: Record<Reason, string> = {
  illness: 'Illness or condition',
  injury: 'Injury',
  pregnancy: 'Pregnancy',
  mental: 'Mental health',
  other: 'Other',
}

export function reasonText(r: Reason | ''): string {
  return r ? REASON_TEXT[r] : '—'
}

/**
 * POST /intake/{draftId}:submit — turns the phone draft into claim D-26-074021: moves it to Evidence,
 * requests the evidence, acknowledges Nora, tells the agent (status only) and routes it to the triage team.
 * `at` is the call clock ('09:55') so the history reads in call order.
 */
export function submitDiIntake(ctx: IntakeContext, draft: DiIntakeDraft, triage: TriageProposal, actor: string, at: string): Promise<string> {
  const id = ctx.claimId
  const existing = claims.get(id)
  if (!existing) return fail(`Claim ${id} not found`)
  if (!existing.light) return fail(`${id} has already been submitted`)

  const stamp = `${TODAY}T${at}`
  const di = ctx.policies.find((p) => p.family === 'disability')!
  const life = ctx.policies.find((p) => p.family === 'life')
  const ep = elimination(draft.firstUnable, di.eliminationDays)!
  const wop = life?.waiverAfterMonths ? waiverStart(draft.firstUnable, life.waiverAfterMonths) : undefined
  const age = ageOn(ctx.person.dob, TODAY)
  const aps = draft.providers.find((p) => p.primary) ?? draft.providers[0]
  const team = triage.state === 'dismissed' ? 'DI Team 1' : triage.team
  const consent = draft.agentConsent === 'yes'
  const firstLetter = addDays(TODAY, 30)
  const who = `${actor} · phone intake`
  const statement = `${ctx.person.name} (${age}) last worked on ${fmtDate(draft.lastWorked)} and has been unable to work since ${fmtDate(draft.firstUnable)}`
  const surgeryText = draft.surgery === 'yes' ? `; ${draft.procedure.toLowerCase()} is booked for ${fmtDate(draft.surgeryDate)}` : ''

  const benefitLines: BenefitLine[] = [
    {
      id: 'bl-lind-di',
      name: 'Disability income',
      ref: di.ref,
      refNote: `${di.definition?.toLowerCase()} · issued ${fmtDate(di.issued, { year: true })}`,
      amount: di.monthlyBenefit,
      amountNote: `per month · ${di.eliminationDays}-day elimination`,
      status: { label: 'Elimination period', tone: 'info' },
      waitingOn: aps ? `${aps.name} · ${ctx.person.name.split(' ')[0]}` : ctx.person.name,
      due: `EP ends ${fmtDate(ep.end)}`,
    },
    {
      id: 'bl-lind-res',
      name: 'Residual disability rider',
      ref: di.ref,
      refNote: 'rider · partial return to work',
      status: draft.reducedHours === 'yes' ? { label: 'To assess', tone: 'caution' } : { label: 'Not claimed', tone: 'neutral' },
      waitingOn: draft.reducedHours === 'yes' ? 'Earnings records' : undefined,
    },
    {
      id: 'bl-lind-cola',
      name: 'Cost-of-living rider',
      ref: di.ref,
      refNote: 'rider · adjusts after 12 months of benefits',
      status: { label: 'Not yet applicable', tone: 'neutral' },
    },
  ]
  if (life) {
    benefitLines.push({
      id: 'bl-lind-wop',
      name: 'Waiver of premium on life',
      ref: life.ref,
      refNote: `${fmtMoney(life.faceAmount ?? 0).replace('.00', '')} term life`,
      status: { label: 'Not triggered', tone: 'neutral' },
      due: wop ? `after 6 months · ${fmtDate(wop, { year: true })}` : undefined,
    })
  }

  const parties: Party[] = [
    {
      id: 'p1',
      name: ctx.person.name,
      roles: ['Claimant', 'Insured', 'Owner'],
      note: `Age ${age} · ${draft.occupation.replace(/ \(.*\)$/, '').toLowerCase()}`,
      status: { label: 'Identity verified', tone: 'positive' },
      contact: `Portal · ${[draft.contactBy.email && 'email', draft.contactBy.text && 'text', draft.contactBy.phone && 'phone', draft.contactBy.mail && 'mail'].filter(Boolean).join(' and ')}`,
    },
    ...draft.providers.map((p, i) => ({
      id: `p-prov-${i}`,
      name: p.name,
      roles: ['Treating physician'],
      note: [p.practice, p.specialty, p.phone].filter(Boolean).join(' · '),
      status: p === aps ? ({ label: 'Statement requested', tone: 'info' } as Status) : undefined,
    })),
    {
      id: 'p-agent',
      name: ctx.agent.name,
      roles: ['Agent of record'],
      note: ctx.agent.agency,
      access: consent ? 'Status only, never medical detail' : 'None · Nora declined',
      status: consent ? { label: `Consent ${fmtDate(TODAY)}`, tone: 'neutral' } : { label: 'No consent', tone: 'neutral' },
    },
  ]

  const patch: Partial<Claim> = {
    stage: stagesAt(1),
    tags: draft.reducedHours === 'yes' ? [{ label: 'Residual claim', tone: 'plain' }] : [],
    facts: [
      `Claimant · age ${age} · unable to work since ${fmtDate(draft.firstUnable, { year: true })}`,
      `${draft.occupation.replace(/ \(.*\)$/, '')} · ${di.ref} · ${fmtMoney(di.monthlyBenefit ?? 0)} / month`,
      `${di.definition} · filed by phone ${fmtDate(TODAY)}`,
    ],
    ownerId: 'priya',
    team,
    filed: TODAY,
    clocks: [
      { id: 'c1', label: 'Elimination period', kind: 'deadline', state: 'running', due: ep.end, progress: ep.daysIn / ep.days, valueText: `ends ${fmtDate(ep.end)}` },
      { id: 'c2', label: 'Status letter', kind: 'deadline', state: 'running', due: firstLetter, progress: 0, valueText: `first due ${fmtDate(firstLetter)}` },
    ],
    nextStep: {
      label: `Welcome call to ${ctx.person.name.split(' ')[0]}`,
      reason: `New from phone intake · ${draft.surgery === 'yes' ? `surgery ${fmtDate(draft.surgeryDate)} · ` : ''}physician statement requested`,
      section: 'communications',
    },
    exceptions: [],
    benefitLines,
    parties,
    summary: {
      text: `${statement}${surgeryText}. She claims total disability under ${di.ref} (${di.definition?.toLowerCase()}, ${fmtMoney(di.monthlyBenefit ?? 0)} a month). The ${ep.days}-day elimination period runs to ${fmtDate(ep.end)}.${aps ? ` The physician statement has been requested from ${aps.name}.` : ''} Duties and earnings records are requested from her portal, not prefilled.`,
      asOf: `${at} · phone intake`,
      sources: ['Intake call 25 Sep', `Policy record ${di.ref}`],
    },
    suggestions: [
      {
        id: 's-lind-1',
        group: 'next',
        category: 'Duration guideline',
        title: draft.surgery === 'yes' ? `Check in after surgery on ${fmtDate(draft.surgeryDate)}` : 'Check in when the physician statement arrives',
        body: triage.reason,
        sources: ['Duration guideline', 'Intake call 25 Sep'],
        primary: 'Create task',
        creates: draft.surgery === 'yes' ? `Call Nora after surgery — ${fmtDate(addDays(draft.surgeryDate, 3))}` : 'Review APS and call Nora',
        state: 'open',
      },
    ],
    linked: [`${ctx.person.name} — person`, `${life ? `${life.ref} · term life` : ''}`, consent ? `Agent ${ctx.agent.name}` : ''].filter(Boolean),
    sections: DI_SECTIONS,
    detail: {
      kind: 'disability',
      medical: [
        ['Condition', 'To be coded from the physician statement'],
        ['Reason given', reasonText(draft.reason)],
        ['Treating', aps ? `${aps.name} · ${aps.practice}` : 'Not given yet'],
        ['Surgery', draft.surgery === 'yes' ? `${draft.procedure} · ${fmtDate(draft.surgeryDate)}` : 'None planned'],
        ['Hospitalized', draft.hospitalized === 'yes' ? draft.hospitalName || 'Yes' : 'No'],
      ],
      work: [
        ['Own occupation', `${draft.occupation}${draft.hoursPerWeek ? ` · ${draft.hoursPerWeek} h a week` : ''}`],
        ['Last worked', fmtDate(draft.lastWorked, { year: true })],
        ['Reduced hours', draft.reducedHours === 'yes' ? draft.residualNote : 'No — not working'],
      ],
      money: [
        ['Monthly benefit', `${fmtMoney(di.monthlyBenefit ?? 0)} · ${di.definition?.toLowerCase()}`],
        ['Elimination', `${ep.days} days · ends ${fmtDate(ep.end)}`],
        ['Tax', draft.otherPayer === 'yes' ? 'May be partly taxable · tax review' : 'Not taxable · premiums paid personally'],
      ],
    },
    light: false,
  }
  patchClaim(id, patch)

  // Requirements — the physician statement is requested directly; the rest are portal tasks for Nora.
  const reqs: Requirement[] = [
    { id: newId('req'), claimId: id, name: 'Claimant statement', note: 'Taken by phone', purpose: 'Proof of claim', from: ctx.person.name, fromDetail: 'Phone intake', status: { label: `Received ${fmtDate(TODAY)}`, tone: 'positive' }, state: 'met', requested: TODAY, followUps: [], benefitLineId: 'bl-lind-di' },
  ]
  if (aps) {
    reqs.push({ id: newId('req'), claimId: id, name: 'Attending physician statement', purpose: 'Medical proof', from: aps.name, fromDetail: [aps.practice, aps.fax ? `fax ${aps.fax}` : aps.phone].filter(Boolean).join(' · '), status: { label: `Requested ${fmtDate(TODAY)}`, tone: 'info' }, state: 'open', requested: TODAY, followUps: [], due: addDays(TODAY, 21), benefitLineId: 'bl-lind-di' })
  }
  reqs.push({ id: newId('req'), claimId: id, name: 'Authorization to release information', note: 'E-sign in the portal', purpose: 'Authorization', from: ctx.person.name, fromDetail: 'Portal task', status: { label: 'Sent to portal', tone: 'info' }, state: 'open', requested: TODAY, followUps: [], due: addDays(TODAY, 14) })
  if (draft.requestDuties) reqs.push({ id: newId('req'), claimId: id, name: 'Occupational duties questionnaire', purpose: 'Own occupation', from: ctx.person.name, fromDetail: 'Portal task', status: { label: 'Sent to portal', tone: 'info' }, state: 'open', requested: TODAY, followUps: [], due: addDays(TODAY, 21), benefitLineId: 'bl-lind-di' })
  if (draft.requestEarnings) reqs.push({ id: newId('req'), claimId: id, name: 'W-2s or tax returns, 2024–2025', note: 'Upload in the portal', purpose: 'Earnings', from: ctx.person.name, fromDetail: 'Portal task', status: { label: 'Sent to portal', tone: 'info' }, state: 'open', requested: TODAY, followUps: [], due: addDays(TODAY, 21), benefitLineId: draft.reducedHours === 'yes' ? 'bl-lind-res' : 'bl-lind-di' })
  reqs.forEach((r) => requirements.insert(r))

  // Communications
  addCommunication({ claimId: id, at: `${TODAY}T${ctx.call.started}`, channel: 'call', direction: 'in', title: 'Claim reported by phone', party: `${ctx.person.name} · ${ctx.call.inbound}`, detail: `Phone intake taken by ${actor}; identity verified (DOB, ZIP, last 4 SSN); call recorded`, status: { label: 'Logged', tone: 'neutral' } })
  if (draft.contactBy.email) addCommunication({ claimId: id, at: stamp, channel: 'email', direction: 'out', title: 'Claim acknowledgement', party: `${ctx.person.name} · email`, detail: `Claim ${id} received; what we have asked for and what happens next`, status: { label: 'Sent', tone: 'positive' }, template: 'ACK-DI-01' })
  if (draft.contactBy.text) addCommunication({ claimId: id, at: stamp, channel: 'portal', direction: 'out', title: 'Text: claim received', party: `${ctx.person.name} · text message`, detail: `“We have your claim ${id}. Three tasks are waiting in your portal.”`, status: { label: 'Delivered', tone: 'positive' }, template: 'SMS-ACK-01' })
  if (aps) addCommunication({ claimId: id, at: stamp, channel: 'letter', direction: 'out', title: 'Attending physician statement request', party: `${aps.name} · ${aps.practice}${aps.fax ? ' · fax' : ''}`, detail: 'Request with the signed authorization to follow from the portal', status: { label: 'Sent', tone: 'positive' }, template: 'APS-DI-02' })
  if (consent) addCommunication({ claimId: id, at: stamp, channel: 'email', direction: 'out', title: 'Agent notification · status only', party: `${ctx.agent.name} · agent of record`, detail: 'A claim was filed for your client today. You will see its status, never medical details.', status: { label: 'Sent', tone: 'positive' }, template: 'AGT-NOTE-01' })

  // Tasks and the triage team's work item
  addTask(id, `Welcome call to ${ctx.person.name.split(' ')[0]}`, 'Priya Nair', 'Phone intake', addDays(TODAY, 4))
  if (aps) addTask(id, `Chase ${aps.name}’s statement if not in`, 'Priya Nair', 'Phone intake', addDays(TODAY, 21))
  if (draft.surgery === 'yes') addTask(id, `Check in after surgery on ${fmtDate(draft.surgeryDate)}`, 'Priya Nair', 'Duration guideline', addDays(draft.surgeryDate, 3))
  if (wop) addTask(id, `Review waiver of premium on ${life!.ref}`, 'Priya Nair', 'Phone intake', wop)
  workItems.insert({
    id: newId('w'),
    ownerId: 'priya',
    claimId: id,
    priority: 2,
    action: `Triage new claim — welcome call to ${ctx.person.name.split(' ')[0]}`,
    why: `Phone intake today · ${triage.state === 'dismissed' ? 'triage to confirm' : `${triage.track} → ${team}`}`,
    due: addDays(TODAY, 4),
    waitingOn: 'You',
    section: 'overview',
    whyNext: `${statement}${surgeryText}. Confirm the plan with her, and watch for ${aps ? `${aps.name}’s statement` : 'the physician statement'} before the elimination period ends on ${fmtDate(ep.end)}.`,
    views: [],
    status: 'open',
  })

  // History, in call order
  logEvent(id, { at: `${TODAY}T${ctx.call.started}`, type: 'access', title: 'Caller verified — DOB, ZIP and last 4 SSN', actor: who })
  logEvent(id, { at: stamp, type: 'data', title: `Coverage matched from policy administration: ${ctx.policies.map((p) => p.ref).join(', ')}`, actor: 'System · policy administration' })
  logEvent(id, { at: stamp, type: 'data', title: 'Claim created from phone intake', actor: who, detail: `Unable to work from ${fmtDate(draft.firstUnable)} · elimination period ends ${fmtDate(ep.end)}` })
  if (consent) logEvent(id, { at: stamp, type: 'access', title: `Agent ${ctx.agent.name} given status-only access`, actor: who, detail: 'Consent given on the intake call' })
  logEvent(id, {
    at: stamp,
    type: 'assistant',
    title: triage.state === 'accepted' ? `Triage accepted: ${triage.track} → ${team}` : triage.state === 'dismissed' ? 'Triage suggestion dismissed' : `Triage by rule: ${triage.track} → ${team}`,
    actor: `${actor} · triage suggestion${triage.edited ? ' (edited)' : ''}`,
    detail: triage.reason,
  })
  logEvent(id, { at: stamp, type: 'document', title: `${reqs.length - 1} requirements requested`, actor: who, detail: reqs.slice(1).map((r) => r.name).join(' · ') })
  logEvent(id, { at: stamp, type: 'communication', title: `Acknowledgement sent by ${[draft.contactBy.email && 'email', draft.contactBy.text && 'text'].filter(Boolean).join(' and ') || 'letter'}`, actor: 'System · ACK-DI-01' })
  logEvent(id, { at: stamp, type: 'task', title: `Assigned to Priya Nair, ${team}`, actor: 'System · routing rule DI-02' })

  return respond(id)
}
