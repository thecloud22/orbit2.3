/**
 * The API contract for the mock.
 *
 * These are the resource shapes the real backend (Spring Boot or ASP.NET Core) will return as JSON.
 * Field names are camelCase, dates are ISO strings ('2026-10-03' or '2026-09-25T09:14'), money is a
 * number in dollars. Each collection maps to a REST resource, noted above it — keep them in step with
 * contracts/openapi.yaml once it exists.
 */

export type ISODate = string
export type Family = 'life' | 'disability' | 'annuity'

/** plain = a label chip with no status meaning (e.g. the product). */
export type Tone = 'plain' | 'neutral' | 'info' | 'positive' | 'caution' | 'critical' | 'special'

export interface Status {
  label: string
  tone: Tone
}

// ---------------------------------------------------------------- Users  GET /me, GET /users

export type RoleKey = 'lifeExaminer' | 'diCaseManager' | 'annuitySpecialist' | 'teamLead'

export interface User {
  id: string
  name: string
  initials: string
  title: string
  team: string
  role: RoleKey
  /** Largest single payout this person can approve alone. */
  payoutLimit: number
  authorityNotes: string[]
}

// ---------------------------------------------------------------- Claims  GET /claims/{id}

export type SectionKey =
  | 'overview'
  | 'workflow'
  | 'policies'
  | 'people'
  | 'requirements'
  | 'documents'
  | 'contestable'
  | 'medical'
  | 'financials'
  | 'decision'
  | 'payments'
  | 'distributions'
  | 'case-plan'
  | 'communications'
  | 'history'

export interface StageStep {
  key: string
  label: string
  state: 'done' | 'current' | 'partial' | 'todo'
  /** e.g. '1 of 3', 'partial' */
  note?: string
}

export type ClockState = 'running' | 'paused' | 'extended' | 'breached' | 'met'

/**
 * A regulatory or contractual clock. Deadline clocks count down to `due`; accruing clocks
 * (interest on death proceeds, waiting on others) count up from `start`.
 */
export interface ClaimClock {
  id: string
  label: string
  kind: 'deadline' | 'accruing'
  state: ClockState
  due?: ISODate
  start?: ISODate
  /** 0–1 share of the window used, for the bar. */
  progress?: number
  /** Overrides the computed value text, e.g. 'start by 3 Sep 2027'. */
  valueText?: string
}

export interface NextStep {
  label: string
  reason: string
  section: SectionKey
  /** Target inside the section, e.g. a requirement or document id. */
  target?: string
}

export interface ClaimException {
  id: string
  title: string
  detail: string
  /** 'Review due 9 Oct', 'Waiting on Adaeze Okafor' */
  meta: string
  action: { label: string; section: SectionKey; target?: string }
  status: 'open' | 'resolved'
}

export interface BenefitLine {
  id: string
  name: string
  /** Policy or contract number, or the parent policy for a rider. */
  ref: string
  refNote?: string
  amount?: number
  amountNote?: string
  status: Status
  paid?: string
  held?: string
  waitingOn?: string
  due?: string
}

export interface Party {
  id: string
  name: string
  /** Beneficiary, Claimant, Insured, Owner, Payee, Agent of record, Treating physician… */
  roles: string[]
  relationship?: string
  share?: string
  status?: Status
  contact?: string
  note?: string
  /** Agent of record, attorney: what they may see. */
  access?: string
}

export interface Suggestion {
  id: string
  /** 'next' = Also suggested; 'check' = Worth checking (never a finding). */
  group: 'next' | 'check'
  category: string
  title: string
  body: string
  sources: string[]
  /** Label of the accept action: 'Open', 'Accept', 'Send', 'Create draft'. */
  primary: string
  /** What accepting creates, e.g. a task title. Shown in the history. */
  creates?: string
  section?: SectionKey
  state: 'open' | 'accepted' | 'dismissed'
}

export interface Claim {
  id: string
  family: Family
  product: string
  name: string
  /** Header tags after the product chip: Contestable, Fast track, Premium waived… */
  tags: Status[]
  /** Summary line under the name, separated by bars. */
  facts: string[]
  ownerId: string
  team: string
  filed: ISODate
  stage: StageStep[]
  clocks: ClaimClock[]
  nextStep: NextStep
  exceptions: ClaimException[]
  benefitLines: BenefitLine[]
  parties: Party[]
  summary: { text: string; asOf: string; sources: string[] }
  suggestions: Suggestion[]
  linked: string[]
  /** Sections shown in this claim's navigation, in order. */
  sections: SectionKey[]
  /** Product-specific overview blocks. */
  detail?: ClaimDetail
  /** True for claims carried only as queue context in the mock. */
  light?: boolean
  /** Live mode: this claim is read from the real backend (the id is its claim number). Sample claims never set it. */
  live?: boolean
  /** Live mode: what the claim pays, base line and rider together: 'Paid $200,460.27 = $200,000.00 proceeds + $460.27 interest'. */
  totalLine?: string
}

export type ClaimDetail =
  | { kind: 'life'; beneficiaryNote: string }
  | {
      kind: 'disability'
      medical: [string, string][]
      work: [string, string][]
      money: [string, string][]
    }
  | {
      kind: 'annuity'
      deathBenefit: { label: string; source: string; amount: number; greater?: boolean }[]
      shareNote: string
    }

// ---------------------------------------------------------------- Work  GET /work-items?owner=

export interface WorkItem {
  id: string
  ownerId: string
  claimId: string
  priority: 1 | 2 | 3
  action: string
  why: string
  due: ISODate
  /** Small line under the date: 'by 17:00', 'interest', '2 days'. Computed if absent. */
  dueNote?: string
  flag?: Status
  waitingOn: string
  section: SectionKey
  /** Long-form reason shown in the preview panel. */
  whyNext?: string
  views: WorkView[]
  status: 'open' | 'done' | 'snoozed'
  /** Live mode: this item is read from the real backend. */
  live?: boolean
}

export type WorkView = 'dueToday' | 'atRisk' | 'readyToDecide' | 'newDocuments' | 'statusLetters' | 'waiting'

// ---------------------------------------------------------------- Requirements  GET /claims/{id}/requirements

export interface Requirement {
  id: string
  claimId: string
  name: string
  note?: string
  /** What it proves: 'Medical proof', 'Proof of claim'. */
  purpose: string
  from: string
  fromDetail?: string
  status: Status
  state: 'met' | 'open' | 'overdue' | 'inProgress' | 'waived'
  requested?: ISODate
  followUps: string[]
  due?: ISODate
  benefitLineId?: string
}

// ---------------------------------------------------------------- Documents  GET /claims/{id}/documents

export interface ExtractedField {
  id: string
  label: string
  value: string
  source: string
  confidence: 'high' | 'low'
  /** Compared with the previous version of this document type. */
  change?: string
  state: 'proposed' | 'accepted' | 'edited' | 'dismissed'
}

export interface ClaimDocument {
  id: string
  claimId: string
  title: string
  docType: string
  received: ISODate
  channel: string
  pages: number
  isNew: boolean
  status: Status
  benefitLineId?: string
  satisfies?: string
  extracted?: ExtractedField[]
  /** Plain text lines to render as the page image in the mock viewer. */
  pageText?: string[]
}

// ---------------------------------------------------------------- Decisions  GET /claims/{id}/decisions

export interface DecisionRecord {
  id: string
  claimId: string
  benefitLineId: string
  title: string
  version: number
  recordedAt: ISODate
  recordedBy: string
  authorityNote: string
  outcome: 'approved' | 'approvedInPart' | 'denied' | 'closed'
  outcomeText: string
  basis: string
  evidence: string[]
  provisions: string[]
  approvals: string[]
  letter?: string
  assistantNote?: string
}

export interface ReadinessCheck {
  id: string
  label: string
  detail: string
  sources: string[]
  result: 'pass' | 'fail' | 'blocked'
}

export interface PayeeLine {
  payee: string
  basis: string
  amount: number
  method: string
}

/** What the decision workbench needs for one benefit line. GET /claims/{id}/workbench/{lineId} */
export interface Workbench {
  claimId: string
  benefitLineId: string
  title: string
  ref: string
  checksRunAt: ISODate
  checks: ReadinessCheck[]
  provisions: string[]
  effective: string
  payDate: ISODate
  payees: PayeeLine[]
  payeeNote?: string
  rationale: string
  evidence: string[]
  letters: { title: string; template: string; to: string }[]
  tax?: string
  /** Why the outcome cannot be recorded yet, when a check is blocked. */
  blockedReason?: string
}

// ---------------------------------------------------------------- Payments  GET /claims/{id}/payments

export interface Payment {
  id: string
  claimId: string
  benefitLineId?: string
  period?: string
  payDate: ISODate
  payee: string
  basis: string
  amount: number
  method: string
  status: Status
}

// ---------------------------------------------------------------- Communications  GET /claims/{id}/communications

export type Channel = 'letter' | 'call' | 'portal' | 'email' | 'document' | 'note'

export interface Communication {
  id: string
  claimId: string
  at: ISODate
  channel: Channel
  direction: 'in' | 'out' | 'internal'
  title: string
  party: string
  detail: string
  status: Status
  benefitLine?: string
  template?: string
}

// ---------------------------------------------------------------- History  GET /claims/{id}/history

export type HistoryType = 'decision' | 'data' | 'document' | 'communication' | 'task' | 'access' | 'assistant' | 'payment'

export interface HistoryEvent {
  id: string
  claimId: string
  at: ISODate
  type: HistoryType
  title: string
  actor: string
  detail?: string
  ref?: string
}

// ---------------------------------------------------------------- Tasks & notes  GET /claims/{id}/tasks, /notes

export interface Task {
  id: string
  claimId: string
  title: string
  due?: ISODate
  assignee: string
  done: boolean
  source?: string
}

export interface Note {
  id: string
  claimId: string
  at: ISODate
  author: string
  text: string
}
