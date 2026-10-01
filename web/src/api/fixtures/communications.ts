import type { Channel, Communication, Status } from '../types'

// Owned by the Communications screen. Newest first.

const S = {
  delivered: { label: 'Delivered', tone: 'positive' },
  received: { label: 'Received', tone: 'positive' },
  logged: { label: 'Logged', tone: 'positive' },
  filed: { label: 'Filed', tone: 'positive' },
  sent: { label: 'Sent', tone: 'positive' },
  answered: { label: 'Answered', tone: 'positive' },
  internal: { label: 'Internal', tone: 'neutral' },
} satisfies Record<string, Status>

function c(
  id: string, claimId: string, at: string, channel: Channel, direction: Communication['direction'],
  title: string, party: string, detail: string, status: Status, extra: Partial<Communication> = {},
): Communication {
  return { id, claimId, at, channel, direction, title, party, detail, status, ...extra }
}

// ---------------------------------------------------------------- Pierce (the 3 original seeds + history)
const PIERCE = 'L-26-040112'
const PIERCE_COMMS: Communication[] = [
  { id: 'com-pierce-3', claimId: PIERCE, at: '2026-09-22T16:40', channel: 'portal', direction: 'in', title: 'When will I hear?', party: 'Margaret Pierce · portal message', detail: '“I sent everything last week. When will I hear about the claim?”', status: { label: 'Unanswered', tone: 'caution' } },
  { id: 'com-pierce-2', claimId: PIERCE, at: '2026-09-23T10:05', channel: 'document', direction: 'in', title: 'Funeral home invoice', party: 'Linden Grove Funeral Home · fax', detail: 'Invoice of $9,850 matching the assignment', status: { label: 'Filed', tone: 'neutral' } },
  { id: 'com-pierce-1', claimId: PIERCE, at: '2026-09-03T11:20', channel: 'portal', direction: 'in', title: 'Claimant statement submitted', party: 'Margaret Pierce · portal', detail: 'Statement, certified death certificate and assignment', status: { label: 'Received', tone: 'neutral' } },
  c('com-pierce-4', PIERCE, '2026-09-04T09:15', 'letter', 'out', 'Acknowledgment — what happens next', 'Margaret Pierce · portal and email', 'Confirms everything needed has arrived except the funeral home invoice', S.delivered, { template: 'LTR-L-100' }),
  c('com-pierce-5', PIERCE, '2026-09-03T11:40', 'call', 'out', 'Confirmed bank details and the assignment', 'Call with Margaret Pierce · 11 min', 'Verified EFT account ending 4471; she signed the funeral home assignment in the portal', S.logged),
  c('com-pierce-6', PIERCE, '2026-09-03T09:10', 'call', 'in', 'Agent Paul Hendricks reported the death', 'Agent of record · phone · with Margaret’s consent', 'Margaret agreed he may see status and requirements', S.logged),
  c('com-pierce-7', PIERCE, '2026-09-04T09:20', 'email', 'out', 'Status shared with agent', 'Paul Hendricks · email', 'Claim received; requirements listed. No medical or payment detail', S.sent),
]

// ---------------------------------------------------------------- Okafor (19 — matches the Communications board)
const OKAFOR = 'L-26-038907'
const OKAFOR_COMMS: Communication[] = [
  c('com-okafor-q', OKAFOR, '2026-09-25T09:20', 'portal', 'in', 'Question about the children’s share', 'Adaeze Okafor · portal message', '“Do I need a lawyer to be the custodian for Chidi and Amara?”', { label: 'Unanswered', tone: 'caution' }),
  c('com-okafor-tox', OKAFOR, '2026-09-25T08:05', 'document', 'in', 'Toxicology report', 'County coroner’s office', 'Negative for alcohol and drugs', S.filed, { benefitLine: 'ADB rider' }),
  c('com-okafor-17', OKAFOR, '2026-09-19T10:15', 'letter', 'out', 'Whole life approval — your share', 'Adaeze Okafor · portal and email', 'Her half paid; the children’s shares are held', { label: 'Opened 19 Sep', tone: 'positive' }, { template: 'LTR-L-101', benefitLine: 'Whole life' }),
  c('com-okafor-16', OKAFOR, '2026-09-18T16:05', 'call', 'out', 'Told Adaeze the whole life claim is approved', 'Call with Adaeze Okafor · 9 min', 'Explained the children’s shares are held until a custodian is named; packet to follow', S.logged, { benefitLine: 'Whole life' }),
  c('com-okafor-15', OKAFOR, '2026-09-16T11:30', 'letter', 'out', 'Second request for medical records', 'Dr. Anil Patel’s office · fax', 'Records due 30 Sep', S.delivered, { benefitLine: 'Term life', template: 'LTR-L-122' }),
  c('com-okafor-14', OKAFOR, '2026-09-15T14:10', 'email', 'in', 'Agent asked for a status update', 'Paul Hendricks · email', 'Answered with status only, with the family’s permission', S.answered),
  c('com-okafor-13', OKAFOR, '2026-09-11T15:05', 'call', 'out', 'Explained the contestable review of the term policy', 'Call with Adaeze Okafor · 14 min', 'Notes · Recording', S.logged, { benefitLine: 'Term life' }),
  c('com-okafor-12', OKAFOR, '2026-09-09T12:40', 'portal', 'in', 'When will the whole life be paid?', 'Adaeze Okafor · portal message', 'Answered the same day: the loan statement was the last item', S.answered),
  c('com-okafor-11', OKAFOR, '2026-09-03T10:00', 'letter', 'out', 'Status letter — term life under review (state rule)', 'Adaeze Okafor · portal and first-class mail', 'What we are waiting for and when she will next hear', S.delivered, { template: 'ST-L-30', benefitLine: 'Term life' }),
  c('com-okafor-10', OKAFOR, '2026-09-02T09:45', 'letter', 'out', 'Request for medical records', 'Dr. Anil Patel · fax', 'First request for the contestable review', S.delivered, { benefitLine: 'Term life', template: 'LTR-L-121' }),
  c('com-okafor-9', OKAFOR, '2026-08-28T13:20', 'call', 'in', 'Dr. Patel’s office asked for the HIPAA authorization', 'Call from Dr. Anil Patel’s office · 4 min', 'Re-sent the signed authorization by fax', S.logged, { benefitLine: 'Term life' }),
  c('com-okafor-8', OKAFOR, '2026-08-27T08:10', 'document', 'in', 'Pharmacy history report', 'Pharmacy data vendor', 'Prescription history since 2021', S.filed, { benefitLine: 'Term life' }),
  c('com-okafor-7', OKAFOR, '2026-08-20T16:30', 'email', 'out', 'Status shared with agent', 'Paul Hendricks · email', 'Status only, with the family’s permission', S.sent),
  c('com-okafor-6', OKAFOR, '2026-08-04T10:10', 'letter', 'out', 'Acknowledgment and requirements', 'Adaeze Okafor · portal and first-class mail', 'Three benefit lines, what each needs, and who we will contact', S.delivered, { template: 'LTR-L-100' }),
  c('com-okafor-5', OKAFOR, '2026-08-03T15:00', 'portal', 'out', 'Requirements list posted', 'Adaeze Okafor · portal', 'Loan statement and W-9 requested', { label: 'Viewed', tone: 'positive' }),
  c('com-okafor-4', OKAFOR, '2026-07-29T11:25', 'document', 'in', 'Police accident report', 'State highway patrol · mail', 'Single-vehicle accident, 14 Jul', S.filed, { benefitLine: 'ADB rider' }),
  c('com-okafor-3', OKAFOR, '2026-07-27T14:00', 'call', 'out', 'Welcome call — explained the three benefit lines', 'Call with Adaeze Okafor · 22 min', 'She prefers phone in the afternoons; agreed the agent may see status', S.logged),
  c('com-okafor-2', OKAFOR, '2026-07-24T10:40', 'portal', 'in', 'Claimant statement submitted', 'Adaeze Okafor', 'Statement and certified death certificate', S.received),
  c('com-okafor-1', OKAFOR, '2026-07-22T09:05', 'call', 'in', 'Agent Paul Hendricks reported the death', 'Agent of record · phone', 'With the family’s permission', S.logged),
]

// ---------------------------------------------------------------- Whitman
const WHITMAN = 'L-26-035120'
const WHITMAN_COMMS: Communication[] = [
  c('com-whitman-9', WHITMAN, '2026-09-25T09:05', 'note', 'internal', 'Payment held for screening', 'Payments · Tessa Lin', 'Possible name match; a second person must confirm before release', S.internal),
  c('com-whitman-8', WHITMAN, '2026-09-25T08:55', 'letter', 'out', 'Approval — beneficiary', 'Robert Whitman · first-class mail', 'Held with the payment until screening clears', { label: 'Held', tone: 'caution' }, { template: 'LTR-L-101' }),
  c('com-whitman-7', WHITMAN, '2026-09-24T10:10', 'call', 'in', 'Robert asked when the decision would be made', 'Call from Robert Whitman · 6 min', 'Told him the approval needed a second signature and would be done Friday', S.logged),
  c('com-whitman-6', WHITMAN, '2026-09-16T09:30', 'call', 'out', 'Confirmed bank details', 'Call with Robert Whitman · 9 min', 'EFT account ending 6620 verified by call-back', S.logged),
  c('com-whitman-5', WHITMAN, '2026-09-10T13:15', 'document', 'in', 'Certified death certificate', 'Robert Whitman · first-class mail', 'Matches the federal death record', S.filed),
  c('com-whitman-4', WHITMAN, '2026-09-04T11:00', 'document', 'in', 'Claimant statement and W-9', 'Robert Whitman · first-class mail', 'Signed 1 Sep', S.received),
  c('com-whitman-3', WHITMAN, '2026-08-31T10:20', 'letter', 'out', 'Claim forms and what we need', 'Robert Whitman · first-class mail', 'Claimant statement, certified death certificate, W-9', S.delivered, { template: 'LTR-L-100' }),
  c('com-whitman-2', WHITMAN, '2026-08-28T09:55', 'letter', 'out', 'Acknowledgment', 'Robert Whitman · first-class mail', 'Claim number and who to call', S.delivered),
  c('com-whitman-1', WHITMAN, '2026-08-28T09:40', 'call', 'in', 'Robert reported Grace’s death', 'Call from Robert Whitman · 12 min', 'Prefers phone in the mornings; no portal', S.logged),
]

// ---------------------------------------------------------------- Vasquez
const VAS = 'D-26-073390'
const VASQUEZ_COMMS: Communication[] = [
  c('com-vas-11', VAS, '2026-09-24T08:00', 'letter', 'out', 'Status letter — what we still need (state rule)', 'Elena Vasquez · portal and text alert', 'Dr. Hsu’s statement, 2024 return and practice P&L. Next letter by 24 Oct', S.delivered, { template: 'ST-DI-30' }),
  c('com-vas-10', VAS, '2026-09-23T17:20', 'portal', 'out', 'Reply: accountant timing', 'Elena Vasquez · portal', 'Thanked her; we will ask the accountant directly with her permission', S.sent),
  c('com-vas-9', VAS, '2026-09-23T12:05', 'portal', 'in', 'My accountant is away until Monday', 'Elena Vasquez · portal message', '“He can send the P&L when he’s back on the 28th.”', S.answered),
  c('com-vas-8', VAS, '2026-09-16T10:00', 'letter', 'out', 'Second reminder — attending physician statement', 'Dr. Grace Hsu · fax', 'Requested 26 Aug; now 21 days outstanding', S.delivered, { template: 'LTR-DI-121' }),
  c('com-vas-7', VAS, '2026-09-10T14:30', 'call', 'out', 'Explained how the residual benefit is worked out', 'Call with Elena Vasquez · 18 min', 'Loss of income compared with her pre-disability average; Hugo Brenner needs the P&L', S.logged),
  c('com-vas-6', VAS, '2026-09-05T10:00', 'letter', 'out', 'Reminder — attending physician statement', 'Dr. Grace Hsu · fax', 'First reminder', S.delivered, { template: 'LTR-DI-121' }),
  c('com-vas-5', VAS, '2026-08-27T08:40', 'document', 'in', 'Pharmacy history report', 'Pharmacy data vendor', 'Received 27 Aug', S.filed),
  c('com-vas-4', VAS, '2026-08-26T11:15', 'letter', 'out', 'Request — attending physician statement', 'Dr. Grace Hsu · fax', 'With Elena’s signed authorization', S.delivered, { template: 'LTR-DI-120' }),
  c('com-vas-3', VAS, '2026-08-26T10:30', 'letter', 'out', 'Acknowledgment and requirements', 'Elena Vasquez · portal', 'Nine requirements, who provides each, and why', { label: 'Opened 26 Aug', tone: 'positive' }, { template: 'LTR-DI-100' }),
  c('com-vas-2', VAS, '2026-08-25T16:45', 'portal', 'in', 'Claim filed', 'Elena Vasquez · portal', 'Claimant statement, duties questionnaire, 2025 tax return', S.received),
  c('com-vas-1', VAS, '2026-08-25T16:50', 'email', 'in', 'Agent consent recorded', 'Paul Hendricks · email', 'Status and requirements only, never medical detail', S.logged),
]

// ---------------------------------------------------------------- Bell (38: monthly payment advices, quarterly APS, and the rest)
const BELL = 'D-25-018334'
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BELL_ADVICES: Communication[] = Array.from({ length: 16 }, (_, i) => {
  const m = 5 + i
  const y = 2025 + Math.floor(m / 12)
  const mm = String((m % 12) + 1).padStart(2, '0')
  const amt = `${y}-${mm}` >= '2026-06' ? '$6,695.00' : '$6,500.00'
  return c(`com-bell-adv-${y}${mm}`, BELL, `${y}-${mm}-01T06:00`, 'email', 'out', `Payment advice — ${amt}`, 'Marcus Bell · email', `${MON[m % 12]} ${y} benefit sent to EFT ••2290`, S.sent)
})
const BELL_APS: Communication[] = [
  ['2025-09', '2025-09-22'], ['2025-12', '2025-12-19'], ['2026-03', '2026-03-24'], ['2026-06', '2026-06-23'], ['2026-09', '2026-09-25'],
].flatMap(([req, got], i) => [
  c(`com-bell-apsreq-${i}`, BELL, `${req}-02T09:00`, 'letter', 'out', 'Request — quarterly attending physician statement', 'Dr. Owen Castillo · fax', 'Keeps proof of loss current', S.delivered, { template: 'LTR-DI-125', benefitLine: 'DI' }),
  c(`com-bell-aps-${i}`, BELL, `${got}T08:31`, 'document', 'in', i === 4 ? 'APS update — permanent restrictions' : 'Attending physician statement', 'Dr. Owen Castillo · fax', i === 4 ? 'Sitting tolerance 30 min at a time, 4 h a day; prognosis permanent' : 'Restrictions unchanged', i === 4 ? { label: 'To review', tone: 'info' } : S.filed, { benefitLine: 'DI' }),
])
const BELL_COMMS: Communication[] = [
  ...BELL_ADVICES,
  ...BELL_APS,
  c('com-bell-12', BELL, '2026-09-12T11:30', 'call', 'out', 'Financial review follow-up', 'Call with Marcus Bell and Hugo Brenner, CPA · 25 min', 'Business runs without him; he draws no salary. No offset applies', S.logged),
  c('com-bell-11', BELL, '2026-08-14T10:00', 'letter', 'out', 'Transferable skills analysis on 14 Oct', 'Marcus Bell · email and first-class mail', 'What it is, who Chris Duarte is, and why it matters for 1 Jun 2027', S.delivered),
  c('com-bell-10', BELL, '2026-07-01T09:00', 'letter', 'out', 'Business overhead expense closed at maximum', 'Marcus Bell · first-class mail', '18 of 18 months paid · $128,640.00 reimbursed', S.delivered, { benefitLine: 'BOE' }),
  c('com-bell-9', BELL, '2026-06-03T09:40', 'call', 'in', 'Marcus asked about the COLA increase', 'Call from Marcus Bell · 5 min', 'Explained 3% simple of the original benefit each June', S.logged),
  c('com-bell-8', BELL, '2026-05-26T09:00', 'letter', 'out', 'Cost-of-living increase from 1 Jun', 'Marcus Bell · email', 'Monthly benefit rises to $6,695.00', S.delivered, { benefitLine: 'DI' }),
  c('com-bell-7', BELL, '2026-03-20T15:10', 'email', 'in', 'Agent asked for a status update', 'Paul Hendricks · email', 'Answered: benefits continue; no medical detail shared', S.answered),
  c('com-bell-6', BELL, '2025-06-12T10:20', 'call', 'out', 'Bank details verified by call-back', 'Call with Marcus Bell · 4 min', 'EFT account ending 2290', S.logged),
  c('com-bell-5', BELL, '2025-05-28T11:40', 'letter', 'out', 'Waiver of premium approved — DI and life', 'Marcus Bell · first-class mail', 'Premiums waived from 1 Jun 2025 while disabled', S.delivered, { benefitLine: 'WOP' }),
  c('com-bell-4', BELL, '2025-05-28T11:30', 'letter', 'out', 'Approval — own occupation', 'Marcus Bell · first-class mail', '$6,500.00 a month from 1 Jun 2025', S.delivered, { template: 'LTR-DI-101', benefitLine: 'DI' }),
  c('com-bell-3', BELL, '2025-01-07T10:00', 'letter', 'out', 'Acknowledgment and requirements', 'Marcus Bell · first-class mail', 'DI, BOE and waiver of premium claims opened', S.delivered, { template: 'LTR-DI-100' }),
  c('com-bell-2', BELL, '2025-01-06T15:30', 'portal', 'in', 'Claim filed', 'Marcus Bell · portal', 'Claimant statement and operative report', S.received),
  c('com-bell-1', BELL, '2025-01-06T15:45', 'call', 'out', 'Welcome call', 'Call with Marcus Bell · 20 min', 'Prefers phone in the mornings', S.logged),
]

// ---------------------------------------------------------------- Hart (7)
const HART = 'A-26-015530'
const HART_COMMS: Communication[] = [
  c('com-hart-7', HART, '2026-09-22T15:00', 'letter', 'out', 'Your share of the death benefit — lump sum', 'Nathan Hart · portal and email', '$327,500.00 less $12,750.00 withheld; pays 26 Sep', S.delivered, { template: 'LTR-A-201' }),
  c('com-hart-6', HART, '2026-09-22T09:30', 'portal', 'in', 'Election form and W-4R submitted', 'Nathan Hart · portal', 'Lump sum; default 10% federal withholding', S.received),
  c('com-hart-5', HART, '2026-09-12T10:15', 'call', 'in', 'Claire unsure whether to take a lump sum', 'Call from Claire Hart-Lopez · 14 min', 'Agreed Paul Hendricks may see her status', S.logged),
  c('com-hart-4', HART, '2026-09-08T11:00', 'letter', 'out', 'Claim forms and your options', 'Claire Hart-Lopez · first-class mail', 'Claimant statement and W-9 requested', S.delivered, { template: 'LTR-A-200' }),
  c('com-hart-3', HART, '2026-09-08T10:55', 'letter', 'out', 'Claim forms and your options', 'Nathan Hart · portal and email', 'Claimant statement and W-9 requested', { label: 'Opened 8 Sep', tone: 'positive' }, { template: 'LTR-A-200' }),
  c('com-hart-2', HART, '2026-09-07T16:20', 'document', 'in', 'Certified death certificate', 'Nathan Hart · portal', 'Matches the federal death record', S.filed),
  c('com-hart-1', HART, '2026-09-05T09:30', 'call', 'in', 'Agent Paul Hendricks reported the death', 'Agent of record · phone', 'Two beneficiaries, 50% each', S.logged),
]

// ---------------------------------------------------------------- Light claims with payment stories
const ELLISON = 'A-19-004418'
const RAMAN = 'D-26-071245'
const LIGHT_COMMS: Communication[] = [
  c('com-ellison-3', ELLISON, '2026-09-22T14:05', 'document', 'in', 'Death certificate for George', 'Ruth Ellison · first-class mail', 'Died 18 Jul 2026', S.filed),
  c('com-ellison-2', ELLISON, '2026-09-21T10:30', 'call', 'out', 'Condolence call — survivor benefit explained', 'Call with Ruth Ellison · 16 min', 'Her 50% continues; we will write about the two payments after George’s death', S.logged),
  c('com-ellison-1', ELLISON, '2026-09-20T07:10', 'note', 'internal', 'Death-record match', 'System · death master file', 'George Ellison, died 18 Jul; October payment stopped', S.internal),
  c('com-raman-4', RAMAN, '2026-09-24T18:10', 'portal', 'in', 'Cleared to go back on 5 Oct', 'Priya Raman · portal message', '“My surgeon signed me off for Monday the 5th.”', S.received),
  c('com-raman-3', RAMAN, '2026-09-03T14:00', 'letter', 'out', 'Approval — benefits through 4 Oct', 'Priya Raman · portal and email', '$9,000.00 a month; final payment prorated', S.delivered, { template: 'LTR-DI-101' }),
  c('com-raman-2', RAMAN, '2026-09-03T13:40', 'call', 'out', 'Fast-track approval call', 'Call with Priya Raman · 7 min', 'Bank details verified', S.logged),
  c('com-raman-1', RAMAN, '2026-08-10T12:00', 'portal', 'in', 'Claim filed', 'Priya Raman · portal', 'Claimant statement and ER report', S.received),
]

export const COMMUNICATIONS: Communication[] = [
  ...PIERCE_COMMS, ...OKAFOR_COMMS, ...WHITMAN_COMMS, ...VASQUEZ_COMMS, ...BELL_COMMS, ...HART_COMMS, ...LIGHT_COMMS,
]

/** How the main party prefers to be contacted — shown above the timeline. */
export const PARTY_PREFERENCES: Record<string, { party: string; text: string }> = {
  [OKAFOR]: { party: 'Adaeze Okafor', text: 'prefers phone, afternoons · English · portal active · may copy agent Paul Hendricks' },
  [PIERCE]: { party: 'Margaret Pierce', text: 'portal · prefers email · English · agent Paul Hendricks may see status and requirements' },
  [WHITMAN]: { party: 'Robert Whitman', text: 'prefers phone, mornings · English · first-class mail · no portal' },
  [VAS]: { party: 'Elena Vasquez', text: 'portal · text reminders on · English · agent sees status and requirements only' },
  [BELL]: { party: 'Marcus Bell', text: 'prefers phone, mornings · English · email for payment advices · agent sees status only' },
  [HART]: { party: 'Claire Hart-Lopez', text: 'phone · shares status with agent Paul Hendricks (12 Sep) · Nathan uses the portal and email' },
  [ELLISON]: { party: 'Ruth Ellison', text: 'phone and first-class mail · English · recently bereaved' },
  [RAMAN]: { party: 'Priya Raman', text: 'portal and email · English' },
}
