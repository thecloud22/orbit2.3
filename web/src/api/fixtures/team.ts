import type { ApprovalDetail, AtRiskExtra, ExaminerSeed, OpsData, RecentDecision, UnassignedClaim } from '../team'

/*
 * Team board (canvas 06.1) and operations dashboard (06.2) sample data.
 * Workload numbers are the board's; the page adds live changes from claims and work items on top.
 */

/** The 8 examiners on Monica Reyes's life & annuity team, as the board shows them on Fri 25 Sep. */
export const EXAMINERS: ExaminerSeed[] = [
  { id: 'rachel', name: 'Rachel Kim', initials: 'RK', open: 84, dueSoon: 8, atRisk: 2, ready: 4, oldestDays: 21, capacity: 106, lines: ['life'] },
  { id: 'hannah', name: 'Hannah Cho', initials: 'HC', open: 80, dueSoon: 2, atRisk: 0, ready: 3, oldestDays: 9, capacity: 104, lines: ['life'] },
  { id: 'tom', name: 'Tom Reeve', initials: 'TR', open: 79, dueSoon: 1, atRisk: 0, ready: 2, oldestDays: 12, capacity: 93, lines: ['life', 'annuity'] },
  { id: 'sofia', name: 'Sofia Marin', initials: 'SM', open: 77, dueSoon: 1, atRisk: 0, ready: 1, oldestDays: 30, capacity: 88, lines: ['life'] },
  { id: 'priyanka', name: 'Priyanka Das', initials: 'PD', open: 74, dueSoon: 1, atRisk: 0, ready: 2, oldestDays: 15, capacity: 86, lines: ['life', 'annuity'] },
  { id: 'leon', name: 'Leon Park', initials: 'LP', open: 71, dueSoon: 1, atRisk: 1, ready: 3, oldestDays: 11, capacity: 84, lines: ['life'] },
  { id: 'irene', name: 'Irene Walsh', initials: 'IW', open: 58, dueSoon: 0, atRisk: 0, ready: 2, oldestDays: 16, capacity: 81, lines: ['annuity'] },
  { id: 'ben', name: 'Ben Adler', initials: 'BA', open: 12, dueSoon: 0, atRisk: 0, ready: 0, oldestDays: 6, capacity: 0, lines: ['life'], outOfOffice: { back: '2026-09-29', coveredBy: 'tom' } },
]

/** Display data for the approvals already waiting on Monica (work items w-m1…w-m5). */
export const APPROVAL_DETAILS: Record<string, ApprovalDetail> = {
  'w-m1': {
    kind: 'payout',
    type: 'Payout above authority',
    requestedBy: 'leon',
    waitingHours: 3,
    amount: 512_500,
    limit: 250_000,
    amountNote: 'LP-0712290 · option A (level) face $512,500',
    payee: 'Karin Nyberg · spouse · 100%',
    payeeMethod: 'EFT ••3308',
    screening: 'Sanctions screening clear',
    checks: ['Policy in force', 'Death verified', 'Past contestable period', 'No exclusions apply', 'Beneficiary verified', 'Payee screened', 'Calculation checked', 'Interest calculated', 'Evidence complete'],
    rationale: 'In force at death and past the contestable period. Option A pays the level face amount. Death verified by certified certificate; spouse is sole beneficiary.',
    evidence: ['Death certificate', 'Policy record', 'Designation'],
    provisions: ['Policy §6 Death benefit option A', '§9 Payment of proceeds'],
    letter: 'Approval — beneficiary · LTR-L-101',
    payDate: '2026-09-28',
  },
  'w-m2': {
    kind: 'payout',
    type: 'Death benefit above authority',
    requestedBy: 'irene',
    waitingHours: 2,
    amount: 860_000,
    limit: 750_000,
    amountNote: 'FA-1503378 · contract value at death, surrender charges waived',
    payee: 'Martin Fitch · son · 100%',
    payeeMethod: 'EFT ••6120',
    screening: 'Sanctions screening clear',
    checks: ['Contract in force', 'Death verified', 'Beneficiary verified', 'Payee screened', 'Contract value confirmed', 'Surrender charges waived', 'Interest calculated', 'Tax withholding elected', 'Evidence complete'],
    rationale: 'Owner and annuitant died 1 Sep 2026. The death benefit is the contract value of $860,000 with surrender charges waived on death. Martin Fitch, the only named beneficiary, elected a lump sum and returned his W-9.',
    evidence: ['Death certificate', 'Contract FA-1503378', 'Beneficiary designation', 'Claimant statement', 'W-9'],
    provisions: ['Contract §7 Death benefit', '§9 Surrender charges'],
    letter: 'Death benefit approval · LTR-A-204',
    payDate: '2026-09-28',
  },
  'w-m3': {
    kind: 'secondReview',
    type: 'Denial — second review',
    requestedBy: 'leon',
    waitingHours: 5,
    reason: 'Suicide exclusion within 2 years',
    amount: 400_000,
    amountNote: 'Face amount at stake · refund of premiums $2,316.40',
    proposed: 'Deny · refund premiums paid',
    checks: ['Policy in force', 'Death verified', 'Issued within 2 years', 'Manner of death confirmed', 'Exclusion wording applies', 'State notice language', 'Premium refund calculated', 'Appeal rights in letter', 'Evidence complete'],
    rationale: 'Policy issued 14 Feb 2025; death on 11 Aug 2026 is within the two-year suicide exclusion. The death certificate and medical examiner’s report record the manner of death as suicide. Under §7 the benefit is limited to a refund of premiums paid, $2,316.40.',
  },
  'w-m4': {
    kind: 'waiver',
    type: 'Waive second request',
    requestedBy: 'rachel',
    waitingHours: 4,
    reason: 'Accept consular report instead of apostille',
    proposed: 'Consular report of death abroad replaces the apostilled certificate',
    checks: ['Death abroad confirmed', 'Consular report is certified', 'Identity matches policy', 'No contestable issues'],
    rationale: 'Beatrice Lang died in Portugal. Henrik Lang has asked twice for the apostille without success. The U.S. consulate’s report of death abroad is a certified federal record and proves the same facts.',
  },
  'w-m5': {
    kind: 'close',
    type: 'Close without payment',
    requestedBy: 'sofia',
    waitingHours: 26,
    reason: 'Beneficiary unlocatable — unclaimed property',
    amount: 22_400,
    amountNote: 'Reported and remitted to the state as unclaimed property',
    proposed: 'Close · remit $22,400 to the state',
    checks: ['Dormancy period met', 'Three searches completed', 'Letters returned undeliverable', 'State report prepared'],
    rationale: 'Three database searches and two letters to the last known address found no trace of the beneficiary. The state’s dormancy period has passed, so the proceeds are reported and remitted as unclaimed property.',
    evidence: ['Search reports', 'Returned mail'],
    provisions: ['Policy §9 Payment of proceeds', 'State unclaimed property law'],
  },
}

/** New claims that no one owns yet. */
export const UNASSIGNED: UnassignedClaim[] = [
  { id: 'u1', claimId: 'L-26-043018', name: 'Harriet Okonkwo', product: 'Term life', family: 'life', received: '2026-09-25', amount: 250_000, suggested: 'tom' },
  { id: 'u2', claimId: 'L-26-043006', name: 'Gordon Pratt', product: 'Whole life', family: 'life', received: '2026-09-25', amount: 48_000, suggested: 'leon' },
  { id: 'u3', claimId: 'A-26-016377', name: 'Vivian Castle', product: 'Variable annuity', family: 'annuity', received: '2026-09-24', amount: 318_000, suggested: 'irene' },
  { id: 'u4', claimId: 'L-26-042991', name: 'Ernest Yoon', product: 'Universal life', family: 'life', received: '2026-09-24', amount: 600_000, suggested: 'priyanka' },
  { id: 'u5', claimId: 'L-26-042980', name: 'Lucia Brandt', product: 'Term life', family: 'life', received: '2026-09-24', amount: 100_000, suggested: 'leon' },
  { id: 'u6', claimId: 'A-26-016369', name: 'Walter Ames', product: 'Fixed annuity', family: 'annuity', received: '2026-09-23', amount: 142_500, suggested: 'priyanka' },
  { id: 'u7', claimId: 'L-26-042955', name: 'Nadia Farouk', product: 'Term life', family: 'life', received: '2026-09-23', amount: 175_000, suggested: 'sofia' },
]

/** At-risk items on claims this mock doesn't carry. */
export const AT_RISK_EXTRA: AtRiskExtra[] = [
  { id: 'ar1', examinerId: 'leon', claimId: 'L-26-036980', name: 'Doris Kline', product: 'Term life', action: 'Send 30-day status letter', why: 'State status-letter deadline tomorrow', due: '2026-09-26' },
]

export const RECENT: RecentDecision[] = [
  { id: 'rd-whitman', at: '2026-09-25T08:52', claimId: 'L-26-035120', text: 'approved', detail: 'Whitman · universal life · $436,000', link: { label: 'held by Payments for sanctions review', section: 'payments' } },
]

// ---------------------------------------------------------------- Operations dashboard (06.2)

export const OPS: OpsData = {
  weeks: ['2026-07-03', '2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31', '2026-08-07', '2026-08-14', '2026-08-21', '2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18', '2026-09-25'],
  inventory: {
    life: [3020, 3025, 3015, 3030, 3040, 3035, 3045, 3050, 3060, 3065, 3070, 3075, 3080],
    di: [5530, 5555, 5590, 5610, 5660, 5700, 5745, 5800, 5890, 5930, 5975, 6010, 6050],
    annuity: [720, 722, 718, 721, 719, 716, 718, 715, 716, 714, 712, 711, 710],
  },
  clocks: [
    { key: 'ack', label: 'Acknowledgment', verb: 'within clock', counts: { life: [4185, 4200], di: [2568, 2600], annuity: [1398, 1400] } },
    { key: 'decision', label: 'Decision after proof of loss', verb: 'within clock', counts: { life: [3322, 3380], di: [776, 840], annuity: [1068, 1100] } },
    { key: 'letters', label: 'Status letters', verb: 'on time', counts: { life: [2830, 2900], di: [3920, 4100], annuity: [578, 600] } },
    { key: 'complaints', label: 'Complaint responses', verb: 'within deadline', counts: { life: [14, 14], di: [22, 22], annuity: [4, 4] } },
    { key: 'payment', label: 'Payment after approval', verb: 'within clock', counts: { life: [3197, 3230], di: [5728, 5800], annuity: [1066, 1080] } },
  ],
  medianDays: { life: 11, di: 34, annuity: 9 },
  reconsiderations: { life: [4, 44], di: [20, 118], annuity: [1, 18] },
  paymentAudit: { life: [5, 1500], di: [5, 900], annuity: [2, 600] },
  ageing: {
    buckets: ['0–15', '16–30', '31–45', '46–60', '61–90', '90+'],
    life: [300, 210, 30, 10, 5, 2],
    di: [250, 190, 50, 20, 11, 5],
    annuity: [90, 52, 8, 4, 2, 1],
  },
  outcomes: [
    { label: 'Term life', family: 'life', approved: 1335, withdrawn: 28, denied: 57 },
    { label: 'Permanent life', family: 'life', approved: 1901, withdrawn: 39, denied: 20 },
    { label: 'Disability income', family: 'di', approved: 571, withdrawn: 67, denied: 202 },
    { label: 'Annuities', family: 'annuity', approved: 1078, withdrawn: 11, denied: 11 },
  ],
  fastTrack: {
    life: { newClaims: 1140, fastTracked: 433, fastDays: 4, standardDays: 14 },
    di: { newClaims: 610, fastTracked: 73, fastDays: 6, standardDays: 41 },
    annuity: { newClaims: 380, fastTracked: 167, fastDays: 3, standardDays: 12 },
    all: { fastDays: 4, standardDays: 17 },
  },
  attention: [
    { id: 'at1', tone: 'caution', tag: 'Due soon', meta: '3 · earliest 30 Sep', title: 'Department of Insurance complaints', detail: 'Written responses owed to the state', owner: { name: 'Owen Brandt', initials: 'OB' }, action: 'Review', to: '/claims/D-26-052218/history', lines: ['di', 'life'] },
    { id: 'at2', tone: 'special', tag: 'Litigation', meta: 'Served 24 Sep', title: 'New litigation — 1', detail: 'Alleges bad faith · litigation hold applied', owner: { name: 'Claims legal', initials: 'CL' }, action: 'Open case', lines: ['life'] },
    { id: 'at3', tone: 'info', tag: 'In review', meta: 'Oldest 6 days', title: 'Claims over $1M pending — 4', detail: 'Life and annuity · large-claim oversight', owner: { name: 'Monica Reyes', initials: 'MR' }, action: 'Review claims', to: '/team?view=large', lines: ['life', 'annuity'] },
    { id: 'at4', tone: 'caution', tag: 'Outreach due', meta: 'Since 1 Sep', title: 'Death-record matches — 126', detail: 'No claim filed · unclaimed property outreach', owner: { name: 'Irene Walsh', initials: 'IW' }, action: 'Open list', to: '/work', lines: ['life', 'annuity'] },
    { id: 'at5', tone: 'critical', tag: 'Below target', meta: '13 weeks', title: 'DI team below timeliness target', detail: 'DI Team 1 at 94.2%, target 98%', owner: { name: 'Anita Brooks', initials: 'AB' }, action: 'Open team', lines: ['di'] },
  ],
}
