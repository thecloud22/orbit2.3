import type { HistoryEvent } from '../types'

// Owned by the History screen. Append-only; the API returns it newest first.
// Actor lines read "Who · in what capacity or how". Access events record who opened
// medical, financial or personal data — regulators ask for them.

type Seed = Omit<HistoryEvent, 'claimId'>
const on = (claimId: string, seeds: Seed[]): HistoryEvent[] => seeds.map((s) => ({ claimId, ...s }))

// ------------------------------------------------------------------ Pierce — fast track
const PIERCE: HistoryEvent[] = [
  { id: 'h-pierce-4', claimId: 'L-26-040112', at: '2026-09-25T07:02', type: 'data', title: 'Readiness checks run — 9 of 9 pass', actor: 'System · fast-track rules FT-L v4' },
  { id: 'h-pierce-3', claimId: 'L-26-040112', at: '2026-09-23T10:05', type: 'document', title: 'Funeral home invoice received', actor: 'Document intake · fax', ref: 'Invoice' },
  { id: 'h-pierce-2', claimId: 'L-26-040112', at: '2026-09-03T11:20', type: 'document', title: 'Claimant statement and death certificate received', actor: 'Margaret Pierce · portal', ref: 'Death certificate' },
  { id: 'h-pierce-1', claimId: 'L-26-040112', at: '2026-09-03T11:21', type: 'task', title: 'Claim created and assigned to Rachel Kim', actor: 'System · routing rule LIFE-01' },
  ...on('L-26-040112', [
    { id: 'h-pierce-5', at: '2026-09-03T11:20', type: 'document', title: 'Funeral home assignment received — $9,850.00', actor: 'Margaret Pierce · portal', ref: 'Assignment' },
    { id: 'h-pierce-6', at: '2026-09-04T09:10', type: 'communication', title: 'Invoice requested from Linden Grove Funeral Home', actor: 'Rachel Kim · fax', ref: 'Request' },
    { id: 'h-pierce-7', at: '2026-09-08T14:30', type: 'access', title: 'Claim status viewed by the agent of record', actor: 'Paul Hendricks · agent portal · status only, consent 3 Sep', ref: 'Agent portal' },
    { id: 'h-pierce-8', at: '2026-09-25T07:02', type: 'data', title: 'Payee screening — both payees clear', actor: 'System · screening service', ref: 'Screening result' },
  ]),
]

// ------------------------------------------------------------------ Okafor — complex life, contestable
const OKAFOR = on('L-26-038907', [
  { id: 'h-okafor-01', at: '2026-07-22T10:14', type: 'communication', title: 'Death reported by the agent of record', actor: 'Paul Hendricks · agent of record · phone', ref: 'Call log' },
  { id: 'h-okafor-02', at: '2026-07-22T10:31', type: 'data', title: 'Policies located — whole life LP-1219044, term LP-2511086 with accidental death rider', actor: 'System · policy administration lookup', ref: 'Policy record' },
  { id: 'h-okafor-03', at: '2026-07-22T10:40', type: 'communication', title: 'Claim kit sent to Adaeze Okafor', actor: 'Rachel Kim · portal invitation and mail', ref: 'Claim kit' },
  { id: 'h-okafor-04', at: '2026-07-24T14:02', type: 'document', title: 'Claimant statement and certified death certificate received', actor: 'Adaeze Okafor · portal', ref: 'Death certificate' },
  { id: 'h-okafor-05', at: '2026-07-24T14:03', type: 'task', title: 'Claim created and assigned to Rachel Kim', actor: 'System · routing rule LIFE-01' },
  { id: 'h-okafor-06', at: '2026-07-24T14:03', type: 'data', title: 'Contestable flag set on LP-2511086 — issued 1 Nov 2025, 8 months before death', actor: 'System · rule CONT-2Y', ref: 'Policy record' },
  { id: 'h-okafor-07', at: '2026-07-27T09:40', type: 'access', title: 'Application 2025 opened', actor: 'Rachel Kim · Life claims examiner · contestable review', ref: 'Application 2025' },
  { id: 'h-okafor-08', at: '2026-07-28T11:00', type: 'communication', title: 'Records requested from Dr. Anil Patel', actor: 'Rachel Kim · fax, with Adaeze’s authorization', ref: 'Records request' },
  { id: 'h-okafor-09', at: '2026-08-03T08:15', type: 'document', title: 'Pharmacy history received', actor: 'Pharmacy data · automatic', ref: 'Pharmacy history' },
  { id: 'h-okafor-10', at: '2026-08-03T08:16', type: 'assistant', title: 'Worth checking: application Q4 compared with pharmacy history', actor: 'Assistant · flagged for review, not a finding', ref: 'Application Q4' },
  { id: 'h-okafor-11', at: '2026-08-04T10:20', type: 'access', title: 'Pharmacy history opened', actor: 'Rachel Kim · Life claims examiner · contestable review', ref: 'Pharmacy history' },
  { id: 'h-okafor-12', at: '2026-08-04T09:00', type: 'communication', title: 'Status letter sent', actor: 'System · state rule, every 30 days', ref: 'Mail + portal' },
  { id: 'h-okafor-13', at: '2026-08-12T13:30', type: 'document', title: 'Police accident report received', actor: 'Document intake · mail', ref: 'Police report' },
  { id: 'h-okafor-14', at: '2026-08-25T10:05', type: 'communication', title: 'Follow-up call to Dr. Patel’s office — records not yet sent', actor: 'Rachel Kim · phone · 6 min', ref: 'Call log' },
  { id: 'h-okafor-15', at: '2026-09-03T09:00', type: 'communication', title: 'Status letter sent', actor: 'System · state rule, every 30 days', ref: 'Mail + portal' },
  { id: 'h-okafor-16', at: '2026-09-08T11:40', type: 'document', title: 'Loan statement received for LP-1219044', actor: 'Policy administration · on request', ref: 'Loan statement' },
  { id: 'h-okafor-17', at: '2026-09-11T15:20', type: 'communication', title: 'Call with Adaeze — contestable review explained', actor: 'Rachel Kim · phone · 14 min', ref: 'Call notes' },
  { id: 'h-okafor-18', at: '2026-09-16T09:30', type: 'communication', title: 'Second request to Dr. Patel — due 30 Sep', actor: 'Rachel Kim · fax and provider portal', ref: 'Records request' },
  { id: 'h-okafor-19', at: '2026-09-18T15:42', type: 'decision', title: 'Decision recorded — whole life approved (v1)', actor: 'Rachel Kim · within $250,000 authority', ref: 'Decision record', detail: 'In force since 2012, past the contestable period. $150,000 face + $12,480 additions − $18,300 loan.' },
  { id: 'h-okafor-20', at: '2026-09-18T15:44', type: 'communication', title: 'Approval letter sent — LTR-L-101', actor: 'System · on decision', ref: 'Letter' },
  { id: 'h-okafor-21', at: '2026-09-18T15:45', type: 'data', title: 'Children’s shares held — $72,090.00 until a custodian is documented', actor: 'Rachel Kim · minors’ rule', ref: 'Hold' },
  { id: 'h-okafor-22', at: '2026-09-19T06:00', type: 'payment', title: 'EFT released to Adaeze Okafor — $72,090.00', actor: 'Payments · EFT ••1180', ref: 'Payment' },
  { id: 'h-okafor-23', at: '2026-09-21T10:00', type: 'access', title: 'Claim status viewed by the agent of record', actor: 'Paul Hendricks · agent portal · status only', ref: 'Agent portal' },
  { id: 'h-okafor-24', at: '2026-09-22T14:00', type: 'access', title: 'Claim file opened for weekly review', actor: 'Monica Reyes · team lead', ref: 'Claim file' },
  { id: 'h-okafor-25', at: '2026-09-25T08:02', type: 'document', title: 'Toxicology report received', actor: 'Document intake · coroner’s office', ref: 'Toxicology' },
  { id: 'h-okafor-26', at: '2026-09-25T08:03', type: 'assistant', title: 'Suggested: review today’s toxicology report', actor: 'Assistant · rider', ref: 'Toxicology · p.2' },
  { id: 'h-okafor-27', at: '2026-09-25T09:14', type: 'assistant', title: 'Claim summary refreshed from 26 documents', actor: 'Assistant · summary', ref: 'Summary' },
])

// ------------------------------------------------------------------ Whitman — above authority, payment held
const WHITMAN = on('L-26-035120', [
  { id: 'h-whitman-01', at: '2026-08-28T09:30', type: 'document', title: 'Claimant statement and death certificate received', actor: 'Robert Whitman · mail', ref: 'Death certificate' },
  { id: 'h-whitman-02', at: '2026-08-28T09:31', type: 'task', title: 'Claim created and assigned to Rachel Kim', actor: 'System · routing rule LIFE-01' },
  { id: 'h-whitman-03', at: '2026-09-02T10:15', type: 'data', title: 'Policy value confirmed — option A level face $436,000.00', actor: 'System · policy administration', ref: 'Policy record' },
  { id: 'h-whitman-04', at: '2026-09-10T11:00', type: 'communication', title: 'Call with Robert — approval steps explained', actor: 'Rachel Kim · phone · 11 min', ref: 'Call notes' },
  { id: 'h-whitman-05', at: '2026-09-24T16:20', type: 'decision', title: 'Approval requested — universal life above authority', actor: 'Rachel Kim · $436,000 above $250,000 authority', ref: 'Approval task' },
  { id: 'h-whitman-06', at: '2026-09-25T08:50', type: 'decision', title: 'Payout approved', actor: 'Monica Reyes · team lead · within $2,000,000 authority', ref: 'Approval', detail: 'Approved as recommended. Designation and policy values checked.' },
  { id: 'h-whitman-07', at: '2026-09-25T08:52', type: 'decision', title: 'Decision recorded — universal life approved (v1)', actor: 'Rachel Kim · approved by Monica Reyes', ref: 'Decision record' },
  { id: 'h-whitman-08', at: '2026-09-25T08:53', type: 'data', title: 'Payee screening — partial sanctions-list name match on Robert Whitman', actor: 'System · screening service', ref: 'Screening result' },
  { id: 'h-whitman-09', at: '2026-09-25T08:54', type: 'payment', title: 'Payment held — $436,000.00 while identity is confirmed', actor: 'Payments · Lauren Pike', ref: 'Hold' },
  { id: 'h-whitman-10', at: '2026-09-25T09:05', type: 'access', title: 'Screening result and identity documents opened', actor: 'Lauren Pike · Payments · screening review', ref: 'Screening result' },
])

// ------------------------------------------------------------------ Vasquez — DI, missing information
const VASQUEZ = on('D-26-073390', [
  { id: 'h-vas-01', at: '2026-08-25T16:40', type: 'document', title: 'Claim filed — claimant statement and authorization', actor: 'Elena Vasquez · portal', ref: 'Claimant statement' },
  { id: 'h-vas-02', at: '2026-08-25T16:41', type: 'task', title: 'Claim created and assigned to Jordan Ellis', actor: 'System · routing rule DI-02' },
  { id: 'h-vas-03', at: '2026-08-26T09:10', type: 'communication', title: 'Physician statement requested from Dr. Grace Hsu', actor: 'Jordan Ellis · fax and provider portal', ref: 'Request' },
  { id: 'h-vas-04', at: '2026-08-26T09:20', type: 'task', title: 'Requirements set — 9 items, 2024 and 2025 returns and practice P&L included', actor: 'Jordan Ellis · residual claim checklist', ref: 'Requirements' },
  { id: 'h-vas-05', at: '2026-08-27T07:30', type: 'document', title: 'Pharmacy history received', actor: 'Pharmacy data · automatic', ref: 'Pharmacy history' },
  { id: 'h-vas-06', at: '2026-08-27T08:00', type: 'task', title: 'Medical records ordered — Jan 2025 to present, ETA 1 Oct', actor: 'Jordan Ellis · records vendor', ref: 'Vendor order' },
  { id: 'h-vas-07', at: '2026-09-02T12:15', type: 'document', title: 'Occupational duties questionnaire received', actor: 'Elena Vasquez · portal', ref: 'Duties questionnaire' },
  { id: 'h-vas-08', at: '2026-09-03T10:05', type: 'document', title: '2025 tax return received', actor: 'Elena Vasquez · portal', ref: '2025 tax return' },
  { id: 'h-vas-09', at: '2026-09-05T07:00', type: 'communication', title: 'Automatic reminder to Dr. Hsu', actor: 'System · follow-up rule', ref: 'Fax' },
  { id: 'h-vas-10', at: '2026-09-09T08:00', type: 'communication', title: 'Reminder: 2024 tax return and monthly practice P&L', actor: 'System · portal task', ref: 'Portal' },
  { id: 'h-vas-11', at: '2026-09-10', type: 'data', title: 'Elimination period satisfied — 90 days from 12 Jun', actor: 'System · policy rule DI-1507791 §4' },
  { id: 'h-vas-12', at: '2026-09-12T15:30', type: 'access', title: '2025 tax return opened', actor: 'Hugo Brenner · claims financial analyst', ref: '2025 tax return' },
  { id: 'h-vas-13', at: '2026-09-16T10:00', type: 'communication', title: 'Second request to Dr. Hsu; Elena told in her portal', actor: 'Jordan Ellis · fax and portal', ref: 'Request' },
  { id: 'h-vas-14', at: '2026-09-17T12:40', type: 'access', title: 'Claim status viewed by the agent of record', actor: 'Paul Hendricks · agent portal · status and requirements only', ref: 'Agent portal' },
  { id: 'h-vas-15', at: '2026-09-18T09:05', type: 'access', title: 'Pharmacy history opened', actor: 'Jordan Ellis · DI case manager', ref: 'Pharmacy history' },
  { id: 'h-vas-16', at: '2026-09-24T09:00', type: 'communication', title: 'Status letter 1 sent', actor: 'System · state rule ST-DI-30', ref: 'Mail + portal' },
])

// ------------------------------------------------------------------ Bell — DI, ongoing management
const BELL = on('D-25-018334', [
  { id: 'h-bell-01', at: '2025-01-06T10:00', type: 'document', title: 'Claim filed — claimant statement, APS and duties questionnaire', actor: 'Marcus Bell · mail', ref: 'Claimant statement' },
  { id: 'h-bell-02', at: '2025-01-06T10:02', type: 'task', title: 'Claim created and assigned to Jordan Ellis', actor: 'System · routing rule DI-02' },
  { id: 'h-bell-03', at: '2025-02-24T13:10', type: 'document', title: 'Operative report — L4–L5 fusion 18 Feb 2025', actor: 'Document intake · fax', ref: 'Operative report' },
  { id: 'h-bell-04', at: '2025-03-14T11:00', type: 'decision', title: 'Decision recorded — business overhead expense approved (v1)', actor: 'Jordan Ellis · within DI authority', ref: 'Decision record' },
  { id: 'h-bell-05', at: '2025-05-20T15:30', type: 'document', title: 'Financial review — owner earnings before disability', actor: 'Hugo Brenner, CPA · claims financial analyst', ref: 'Financial review' },
  { id: 'h-bell-06', at: '2025-05-28T11:20', type: 'decision', title: 'Decision recorded — disability income approved (v1)', actor: 'Jordan Ellis · within DI authority', ref: 'Decision record', detail: 'Own occupation from 1 Jun 2025; elimination period satisfied.' },
  { id: 'h-bell-07', at: '2025-05-28T11:25', type: 'data', title: 'Premiums waived on DI-1310776 and LP-1310775 from 1 Jun 2025', actor: 'System · on decision', ref: 'Waiver' },
  { id: 'h-bell-08', at: '2025-06-01T06:00', type: 'payment', title: 'First monthly benefit paid — $6,500.00', actor: 'Payments · EFT ••5528', ref: 'Payment' },
  { id: 'h-bell-09', at: '2025-06-12T10:00', type: 'data', title: 'Case plan v1 agreed with Marcus', actor: 'Jordan Ellis · DI case manager', ref: 'Case plan' },
  { id: 'h-bell-10', at: '2025-06-16T14:20', type: 'data', title: 'Restrictions v3 recorded from the APS of 10 Jun 2025', actor: 'Sam Whitaker, RN · nurse case manager', ref: 'Restrictions' },
  { id: 'h-bell-11', at: '2025-10-15T09:30', type: 'data', title: 'Case plan v2 — pain management added', actor: 'Jordan Ellis · DI case manager', ref: 'Case plan' },
  { id: 'h-bell-12', at: '2026-03-18T11:15', type: 'data', title: 'Case plan v3 — return-to-work workstream added', actor: 'Jordan Ellis · DI case manager', ref: 'Case plan' },
  { id: 'h-bell-13', at: '2026-06-01T06:00', type: 'payment', title: 'Cost-of-living increase applied — $6,500.00 → $6,695.00 a month', actor: 'System · 3% COLA rider', ref: 'Payment' },
  { id: 'h-bell-14', at: '2026-06-12T13:45', type: 'data', title: 'Restrictions v6 recorded from the APS of 10 Jun 2026', actor: 'Sam Whitaker, RN · nurse case manager', ref: 'Restrictions' },
  { id: 'h-bell-15', at: '2026-06-30T10:05', type: 'decision', title: 'Decision recorded — business overhead expense closed at maximum (v2)', actor: 'Jordan Ellis · within DI authority', ref: 'Decision record' },
  { id: 'h-bell-16', at: '2026-09-01T06:00', type: 'payment', title: 'Monthly benefit paid — $6,695.00', actor: 'Payments · EFT ••5528', ref: 'Payment' },
  { id: 'h-bell-17', at: '2026-09-12T11:00', type: 'communication', title: 'Monthly call with Marcus', actor: 'Jordan Ellis · phone · 18 min', ref: 'Call notes', detail: 'Reports progress in physical therapy and better sleep; asked how the any-occupation review works.' },
  { id: 'h-bell-18', at: '2026-09-12T11:30', type: 'data', title: 'Case plan v4 agreed with Marcus', actor: 'Jordan Ellis · DI case manager', ref: 'Case plan' },
  { id: 'h-bell-19', at: '2026-09-12T14:00', type: 'document', title: 'Financial review — owner distributions are not earnings from work', actor: 'Hugo Brenner, CPA · claims financial analyst', ref: 'Financial review' },
  { id: 'h-bell-20', at: '2026-09-15T10:20', type: 'task', title: 'Transferable skills analysis scheduled for 14 Oct', actor: 'Chris Duarte, CRC · vocational consultant', ref: 'Case plan' },
  { id: 'h-bell-21', at: '2026-09-20T17:05', type: 'access', title: 'Claim status viewed by the agent of record', actor: 'Paul Hendricks · agent portal · status only', ref: 'Agent portal' },
  { id: 'h-bell-22', at: '2026-09-25T08:05', type: 'document', title: 'APS update received — Dr. Castillo, 22 Sep', actor: 'Document intake · fax', ref: 'APS · 22 Sep' },
  { id: 'h-bell-23', at: '2026-09-25T08:40', type: 'assistant', title: 'Claim summary refreshed from 46 documents', actor: 'Assistant · summary', ref: 'Summary' },
  { id: 'h-bell-24', at: '2026-09-25T08:41', type: 'assistant', title: 'Suggested: share the new restrictions with Chris Duarte', actor: 'Assistant · vocational', ref: 'APS · 22 Sep, p.2' },
  { id: 'h-bell-25', at: '2026-09-25T09:02', type: 'task', title: 'Nurse referral — restrictions review, to Sam Whitaker, RN', actor: 'Jordan Ellis · DI case manager', ref: 'Referral' },
  { id: 'h-bell-26', at: '2026-09-25T09:10', type: 'access', title: 'APS of 22 Sep opened', actor: 'Sam Whitaker, RN · nurse case manager · referral', ref: 'APS · 22 Sep' },
])

// ------------------------------------------------------------------ Hart — annuity death claim
const HART = on('A-26-015530', [
  { id: 'h-hart-01', at: '2026-09-05T10:12', type: 'communication', title: 'Death reported by Nathan Hart', actor: 'Nathan Hart · portal', ref: 'Notice' },
  { id: 'h-hart-02', at: '2026-09-05T10:13', type: 'task', title: 'Claim created and assigned to Irene Walsh', actor: 'System · routing rule ANN-01' },
  { id: 'h-hart-03', at: '2026-09-08T09:00', type: 'communication', title: 'Claim forms and options guide sent to both beneficiaries', actor: 'Irene Walsh · portal and mail', ref: 'Claim kit' },
  { id: 'h-hart-04', at: '2026-09-09T11:25', type: 'document', title: 'Certified death certificate received', actor: 'Nathan Hart · portal', ref: 'Death certificate' },
  { id: 'h-hart-05', at: '2026-09-10T14:20', type: 'document', title: 'Nathan’s claimant statement, W-9 and lump-sum election received', actor: 'Nathan Hart · portal', ref: 'Claimant statement' },
  { id: 'h-hart-06', at: '2026-09-12T10:30', type: 'communication', title: 'Call with Claire — unsure whether to take a lump sum', actor: 'Irene Walsh · phone · 22 min', ref: 'Call notes' },
  { id: 'h-hart-07', at: '2026-09-12T10:40', type: 'data', title: 'Consent recorded — Claire shares her status with Paul Hendricks', actor: 'Irene Walsh · Claire’s consent on the call', ref: 'Consent' },
  { id: 'h-hart-08', at: '2026-09-22T14:10', type: 'decision', title: 'Decision recorded — death benefit approved (v1)', actor: 'Irene Walsh · within $750,000 authority', ref: 'Decision record' },
  { id: 'h-hart-09', at: '2026-09-22T14:12', type: 'payment', title: 'Nathan’s share valued — lump sum scheduled for 26 Sep', actor: 'System · on decision', ref: 'Payment' },
  { id: 'h-hart-10', at: '2026-09-23T11:05', type: 'access', title: 'Claire’s claim status viewed by the agent of record', actor: 'Paul Hendricks · agent portal · consent 12 Sep', ref: 'Agent portal' },
  { id: 'h-hart-11', at: '2026-09-25T09:14', type: 'assistant', title: 'Suggested: reminder to Claire with the options guide', actor: 'Assistant · good order', ref: 'Requirements' },
])

// ------------------------------------------------------------------ Reilly — denied, reconsideration and DOI complaint
const REILLY = on('D-26-052218', [
  { id: 'h-reilly-01', at: '2026-04-03T09:12', type: 'document', title: 'Claim filed — claimant statement', actor: 'Thomas Reilly · portal', ref: 'Claimant statement' },
  { id: 'h-reilly-02', at: '2026-04-03T09:13', type: 'task', title: 'Claim created and assigned to Dmitri Novak', actor: 'System · routing rule DI-02' },
  { id: 'h-reilly-03', at: '2026-04-12T15:40', type: 'document', title: 'Occupational duties questionnaire received', actor: 'Thomas Reilly · portal', ref: 'Duties questionnaire' },
  { id: 'h-reilly-04', at: '2026-04-14T10:05', type: 'access', title: 'Claimant statement and duties questionnaire opened', actor: 'Dmitri Novak · DI examiner', ref: 'Claimant statement' },
  { id: 'h-reilly-05', at: '2026-05-04T10:00', type: 'communication', title: 'Status letter sent', actor: 'System · state rule, every 30 days', ref: 'Mail + portal' },
  { id: 'h-reilly-06', at: '2026-05-20T18:22', type: 'document', title: 'Symptom diary received', actor: 'Thomas Reilly · portal', ref: 'Symptom diary' },
  { id: 'h-reilly-07', at: '2026-05-30', type: 'document', title: 'Attending physician statement received', actor: 'Document · Dr. Farah Nasser, internal medicine', ref: 'Fax intake' },
  { id: 'h-reilly-08', at: '2026-06-01T10:30', type: 'task', title: 'Peer review referred — occupational medicine', actor: 'Dmitri Novak · review vendor', ref: 'Referral' },
  { id: 'h-reilly-09', at: '2026-06-03T10:00', type: 'communication', title: 'Status letter sent', actor: 'System · state rule, every 30 days', ref: 'Mail + portal' },
  { id: 'h-reilly-10', at: '2026-06-11T17:30', type: 'document', title: 'Peer review received', actor: 'External reviewer · occupational medicine', ref: 'Vendor portal' },
  { id: 'h-reilly-11', at: '2026-06-12T08:55', type: 'access', title: 'Peer review and APS opened', actor: 'Dmitri Novak · DI examiner', ref: 'Peer review' },
  { id: 'h-reilly-12', at: '2026-06-12T09:15', type: 'data', title: 'Data change — occupation demand', actor: 'Dmitri Novak · Sedentary → Sedentary, high cognitive demand', ref: 'Duties questionnaire' },
  { id: 'h-reilly-13', at: '2026-06-16T14:02', type: 'communication', title: 'Letter drafted from template ADV-DI-01 v5', actor: 'Dmitri Novak · denial letter, not yet sent', ref: 'Letter composer' },
  { id: 'h-reilly-14', at: '2026-06-17T11:20', type: 'assistant', title: 'Letter summary suggested (v2)', actor: 'Assistant · edited by D. Novak · 38% changed', ref: 'Letter draft' },
  { id: 'h-reilly-15', at: '2026-06-17T14:30', type: 'access', title: 'Medical file opened for second review', actor: 'Anita Brooks · second reviewer', ref: 'Medical' },
  { id: 'h-reilly-16', at: '2026-06-17T15:48', type: 'decision', title: 'Second review approved', actor: 'Anita Brooks · “Reasons specific; letter complete”', ref: 'Review task' },
  { id: 'h-reilly-17', at: '2026-06-17T16:05', type: 'decision', title: 'Decision recorded — DI claim denied (v1)', actor: 'Dmitri Novak · within DI examiner authority', ref: 'Decision record' },
  { id: 'h-reilly-18', at: '2026-06-17T16:30', type: 'communication', title: 'Denial letter sent — reconsideration and Department of Insurance rights included', actor: 'System · on decision · mail and portal', ref: 'Letter' },
  { id: 'h-reilly-19', at: '2026-06-18T08:12', type: 'access', title: 'Denial letter opened in the portal', actor: 'Thomas Reilly · portal', ref: 'Letter' },
  { id: 'h-reilly-20', at: '2026-08-20T11:00', type: 'decision', title: 'Reconsideration opened — requested by Maya Grant, Hollis & Grant LLP', actor: 'Owen Brandt · reconsideration specialist', ref: 'Reconsideration', detail: 'Letter of representation and authorization on file. Voluntary reconsideration under the policy; decision due 4 Oct.' },
  { id: 'h-reilly-21', at: '2026-08-21T09:30', type: 'data', title: 'Litigation hold applied — nothing can be purged or edited in place', actor: 'Legal · on attorney representation', ref: 'Hold' },
  { id: 'h-reilly-22', at: '2026-08-24T16:15', type: 'access', title: 'Claim file released to Maya Grant — Bates RL-000001 to RL-000412, redaction applied', actor: 'Owen Brandt · with Thomas Reilly’s authorization', ref: 'Export' },
  { id: 'h-reilly-23', at: '2026-09-02T12:10', type: 'document', title: 'Claimant comments and new records received', actor: 'Maya Grant · attorney · mail', ref: 'Comments' },
  { id: 'h-reilly-24', at: '2026-09-09T13:40', type: 'communication', title: 'Department of Insurance complaint received — response due 30 Sep', actor: 'State Department of Insurance · complaint', ref: 'Complaint' },
  { id: 'h-reilly-25', at: '2026-09-09T14:00', type: 'task', title: 'Complaint response task created — due 30 Sep', actor: 'System · complaint rule', ref: 'Task' },
  { id: 'h-reilly-26', at: '2026-09-14T11:50', type: 'document', title: 'Independent review received — physical medicine and rehabilitation', actor: 'External reviewer · independent of the first review', ref: 'Vendor portal' },
  { id: 'h-reilly-27', at: '2026-09-15T09:25', type: 'access', title: 'Medical records and independent review opened', actor: 'Owen Brandt · reconsideration specialist', ref: 'Medical' },
  { id: 'h-reilly-28', at: '2026-09-22T10:00', type: 'communication', title: 'Independent review shared with Maya Grant for comment — 10 days', actor: 'Owen Brandt · mail and email', ref: 'Letter' },
  { id: 'h-reilly-29', at: '2026-09-24T15:10', type: 'assistant', title: 'Complaint response outline suggested', actor: 'Assistant · edited by O. Brandt · 52% changed', ref: 'Draft' },
  { id: 'h-reilly-30', at: '2026-09-25T08:45', type: 'access', title: 'Claim file opened', actor: 'Owen Brandt · reconsideration specialist', ref: 'Claim file' },
])

export const HISTORY: HistoryEvent[] = [...PIERCE, ...OKAFOR, ...WHITMAN, ...VASQUEZ, ...BELL, ...HART, ...REILLY]
