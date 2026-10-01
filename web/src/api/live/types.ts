/**
 * The backend's resources, as api/openapi.yaml defines them (only what the web uses today). Timestamps are RFC 3339 UTC
 * strings, money is a decimal string, enums are snake_case. Keep these in step with the contract, not with the mock's types.
 */
export interface Money { amount: string; currency: string }
export interface Page<T> { items: T[]; nextCursor: string | null }

export type ApiClaimStatus = 'received' | 'gathering_evidence' | 'in_review' | 'awaiting_approval' | 'approved' | 'paying' | 'closed' | 'reopened'

export interface ApiBenefitLine {
  id: string
  policyNumber: string
  kind: 'base' | 'rider'
  parentLineId: string | null
  riderKey: string | null
  name: string
  amount: Money
  status: 'gathering_evidence' | 'cause_pending' | 'not_payable' | 'ready_to_decide' | 'approved' | 'paid' | 'denied' | 'closed'
  waitingOn: string | null
  productConfigVersion: string
  version: number
}

export interface ApiClaimParty {
  partyId: string
  name: string
  role: 'insured' | 'owner' | 'caller' | 'claimant' | 'beneficiary' | 'agent_of_record' | 'funeral_home'
  relationship: string | null
  beneficiaryKind: 'primary' | 'contingent' | null
  sharePercent: string | null
  payee: boolean
  packetChannel: 'portal' | 'mail' | null
  accessNote: string | null
  diedOn: string | null
}

export interface ApiLifeDetails {
  kind: 'life'
  dateOfDeath: string
  placeOfDeath: string | null
  mannerOfDeath: 'natural' | 'accident' | 'pending'
  deathOutsideUs: boolean
  funeralHome: string | null
  callerPartyId: string
  callerRelationship: string | null
  contactBy: string[]
  agentConsent: boolean
  otherClaimantsPossible: boolean
  intakeChannel: string
}

export interface ApiClaim {
  id: string
  claimNumber: string
  family: 'life' | 'disability' | 'annuity'
  productCode: string
  status: ApiClaimStatus
  track: 'fast_track_life' | 'standard_life' | null
  routeRule: string | null
  routeReasons: string[]
  ownerId: string | null
  team: string
  noticedAt: string
  proofCompleteAt: string | null
  closedAt: string | null
  insured: { id: string; name: string }
  details?: ApiLifeDetails
  benefitLines: ApiBenefitLine[]
  parties: ApiClaimParty[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface ApiClaimSummary {
  id: string
  claimNumber: string
  family: 'life' | 'disability' | 'annuity'
  productCode: string
  status: ApiClaimStatus
  track: string | null
  ownerId: string | null
  insuredName: string
  noticedAt: string
  version: number
}

export type ApiRequirementState = 'requested' | 'received' | 'accepted' | 'not_enough' | 'waived' | 'expired'

export interface ApiRequirement {
  id: string
  claimId: string
  benefitLineId: string | null
  key: 'certificate' | 'statement' | 'primary_died_first' | 'report' | 'amended_certificate'
  name: string
  purpose: string
  from: { partyId: string | null; label: string; detail: string | null }
  state: ApiRequirementState
  requestedAt: string
  followUpDays: number
  followUpCount: number
  lastReminderAt: string | null
  receivedAt: string | null
  acceptedAt: string | null
  satisfiedBy: string | null
  waivedAt: string | null
  waiveReason: string | null
  /** Why it is in this state when that is not obvious: 'TIN mismatch' (not_enough), 'Under review: photocopy' (received). */
  stateNote?: string | null
  version: number
}

export type ApiDeadlineKind = 'acknowledge_by' | 'forms_by' | 'first_contact_by' | 'status_letter' | 'requirement_follow_up' | 'decision_due' | 'review_target' | 'payment_due' | 'document_review_by' | 'bank_details_by'

export interface ApiDeadline {
  id: string
  claimId: string
  kind: ApiDeadlineKind
  requirementId: string | null
  what: string
  sla: string | null
  dueAt: string
  originalDueAt: string
  extensionReason: string | null
  state: 'open' | 'dispatched' | 'done' | 'skipped'
  attempt: number
  dispatchedAt: string | null
  fired: boolean
  lastOutcome: 'started' | 'already_started' | 'start_failed' | 'completed' | 'skipped' | 'closed_early' | null
  lastError: string | null
  workflowId: string | null
  closedAt: string | null
  closedBy: 'workflow' | 'intake' | 'requirement' | 'decision' | 'payment' | 'user' | null
  result: string | null
  /** The document a review row waits for (document_review_by). */
  documentId?: string | null
  /** The party a row waits on (bank_details_by: the payee). */
  partyId?: string | null
  version: number
}

export interface ApiLetter {
  id: string
  claimId: string
  benefitLineId: string | null
  templateCode: string
  channel: 'letter' | 'email' | 'sms' | 'portal' | 'fax'
  recipientPartyId: string | null
  recipientLabel: string
  subject: string
  summary: string | null
  status: 'draft' | 'queued' | 'sent' | 'failed'
  sentAt: string | null
  workflowId: string | null
  createdAt: string
}

export interface ApiHistoryEvent {
  id: string
  claimId: string
  occurredAt: string
  recordedAt: string
  type: 'decision' | 'data' | 'document' | 'communication' | 'task' | 'access' | 'assistant' | 'payment'
  title: string
  actorKind: 'user' | 'system' | 'workflow' | 'batch' | 'portal'
  actor: string
  detail: string | null
  ref: string | null
  workflowId: string | null
}

export interface ApiWorkItem {
  id: string
  ownerId: string | null
  claimId: string
  priority: 1 | 2 | 3
  action: string
  why: string
  dueOn: string
  waitingOn: string
  flag: string | null
  section: string
  status: 'open' | 'done' | 'snoozed'
  version: number
}

export interface ApiRunStep {
  label: string
  detail: string
  system: string
  /** retried = Temporal ran the step again and it then succeeded; failed = the retries ran out (the run failed). */
  state: 'done' | 'retried' | 'skipped' | 'failed'
  /** How many times Temporal ran the step (1 = first time). */
  attempts?: number
  /** What Temporal did for this step, in plain words. */
  note?: string | null
}

export type ApiDocumentStatus = 'received' | 'accepted' | 'not_enough' | 'under_review' | 'rejected'

/** GET /claims/{id}/documents */
export interface ApiDocument {
  id: string
  claimId: string
  requirementId?: string | null
  requirementName?: string | null
  partyId?: string | null
  partyName?: string | null
  kind: 'claimant_statement_w9' | 'death_certificate' | 'police_report' | 'other'
  source: 'portal' | 'mail_room' | 'upload'
  attributes: { tinMasked?: string | null; photocopy?: boolean | null; sealPresent?: boolean | null }
  status: ApiDocumentStatus
  statusNote?: string | null
  receivedAt: string
  receivedBy?: string
  reviewedBy?: string | null
  reviewedAt?: string | null
  reviewReason?: string | null
  /** The event workflow that handled it, once the outbox relay has started it. */
  workflowId?: string | null
  version: number
}

export interface ApiWorkflowRun {
  id: string
  workflowId: string
  runId: string
  type: 'orchestration' | 'event' | 'deadline'
  name: string
  claimId: string | null
  startedBy: string
  triggerKind: 'outbox_event' | 'deadline' | null
  triggerId: string | null
  status: 'running' | 'completed' | 'skipped' | 'needs_review' | 'failed'
  startedAt: string
  finishedAt: string | null
  steps: ApiRunStep[]
  saved: string[]
  error: string | null
  /** 1 for the first run of a workflow id; 2 for an ops re-run after it failed. */
  runNo?: number
  rerunOfId?: string | null
  /** 'What Temporal did', in plain words. */
  note?: string | null
  elapsedMs?: number | null
  /** True for a failed run that is the latest of its workflow id: POST /workflow-runs/{id}:rerun. */
  canRerun?: boolean
}

/** GET /staff */
export interface ApiStaff {
  id: string
  handle: string
  name: string
  title: string | null
  team: string
  role: 'life_examiner' | 'di_case_manager' | 'annuity_specialist' | 'team_lead'
  payoutLimit: Money
}

export interface ApiDecision {
  id: string
  claimId: string
  benefitLineId: string
  benefitLineName?: string
  version: number
  supersedesId?: string | null
  outcome: 'approved' | 'approved_in_part' | 'denied' | 'closed'
  outcomeText: string
  basis: string
  evidence?: string[]
  provisions?: string[]
  amount?: Money | null
  recordedAt: string
  recordedBy: string
  recordedByName?: string
  authorityNote: string
  requiresApproval: boolean
  status: 'awaiting_approval' | 'in_effect'
  approvedBy?: string | null
  approvedByName?: string | null
  approvedAt?: string | null
  letterTemplate?: string | null
}

export interface ApiPaymentItem {
  id: string
  claimId: string
  benefitLineId: string
  decisionId?: string | null
  kind: 'benefit' | 'adjustment'
  adjustsItemId?: string | null
  replacementOfId?: string | null
  payeePartyId: string
  payeeName?: string
  basis?: string
  principal: Money
  interest: Money
  amount: Money
  method: 'eft' | 'check'
  payOn: string
  status: 'awaiting_proof' | 'cleared' | 'in_run' | 'paid' | 'held' | 'cancelled' | 'returned'
  holdReason?: string | null
  runId?: string | null
  paidAt?: string | null
  paymentReference?: string | null
  returnCode?: string | null
  returnReason?: string | null
  /** The replacement item made when the payee gave a new account (set on a returned item). */
  replacedById?: string | null
  paymentMethodId?: string | null
  version: number
}

export interface ApiPaymentRun {
  id: string
  runDate: string
  status: 'building' | 'sent' | 'reconciled' | 'failed'
  trigger: 'schedule' | 'manual'
  itemCount: number
  paidCount?: number
  returnedCount?: number
  total: Money
  fileReference?: string | null
  error?: string | null
  startedAt: string
  finishedAt?: string | null
}

/** POST /claims/{id}/decisions and POST /decisions/{id}:approve */
export interface ApiRecordDecisionResult {
  kind: 'recorded' | 'awaiting_approval'
  message: string
  decision: ApiDecision
  relatedDecisions: ApiDecision[]
  paymentItems: ApiPaymentItem[]
  approvalWorkItemId?: string | null
}

/** POST /claims/life-intake */
export interface LifeIntakeRequest {
  noticeReceivedAt?: string
  caller: {
    name: string
    relationship?: string
    phone?: string
    email?: string
    contactBy: ('email' | 'text' | 'phone' | 'mail')[]
    verifiedDateOfBirth: boolean
    verifiedPolicyNumber: boolean
    agentConsent?: boolean
    beneficiaryRef?: string
  }
  insured: { name: string; dateOfBirth: string; ssnLast4?: string }
  death: { dateOfDeath: string; placeOfDeath?: string; manner: 'natural' | 'accident' | 'pending'; outsideUs?: boolean; funeralHome?: string }
  policies: {
    policyNumber: string
    productCode: string
    productName: string
    issueDate: string
    paidToDate: string
    inForce: boolean
    lapsedOn?: string | null
    faceAmount: Money
    riders?: { key: string; name: string; amount: Money }[]
  }[]
  designation: {
    date: string
    source?: string
    beneficiaries: {
      ref: string
      name: string
      relationship?: string
      kind: 'primary' | 'contingent'
      sharePercent: number
      dateOfBirth?: string
      diedOn?: string
      diedSource?: string
      contact?: { phone?: string; email?: string; address?: string; packet?: 'portal' | 'mail' }
    }[]
  }
  agent?: { name: string; agency?: string }
  otherClaimantsPossible?: boolean
}
