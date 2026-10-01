import type { CasePlan } from '../casePlan'

// Owned by the Case plan screen. Marcus Bell — DI, ongoing management and the any-occupation transition.

export const CASE_PLANS: CasePlan[] = [
  {
    id: 'D-25-018334',
    claimId: 'D-25-018334',
    version: 4,
    agreed: '2026-09-12',
    agreedWith: 'Marcus',
    goals: ['Support a return to suitable work', 'Complete the any-occupation assessment before 1 Jun 2027', 'Keep benefits and premium waivers accurate'],
    transition: {
      date: '2027-06-01',
      ownOccEnds: '2027-05-31',
      definition: 'Definition changes from own occupation to any occupation suited to his education, training and experience',
    },
    milestones: [
      { id: 'ms-1', label: 'Updated restrictions', when: 'APS 22 Sep', due: '2026-09-22', owner: 'Sam Whitaker, RN', status: 'inReview' },
      { id: 'ms-2', label: 'Skills analysis', when: '14 Oct · C. Duarte', due: '2026-10-14', owner: 'Chris Duarte, CRC', status: 'scheduled' },
      { id: 'ms-3', label: 'Transition review & notice', when: 'By 1 Dec', due: '2026-12-01', owner: 'Jordan Ellis', status: 'notStarted' },
      { id: 'ms-4', label: 'Labor market survey', when: 'Dec', due: '2026-12-15', owner: 'Chris Duarte, CRC', status: 'notStarted' },
      { id: 'ms-5', label: 'Peer review if tolerances change', when: 'Jan 2027', due: '2027-01-15', owner: 'Dr. Leah Morgan, MD', status: 'optional' },
      { id: 'ms-6', label: 'Employability analysis', when: 'Feb 2027', due: '2027-02-15', owner: 'Chris Duarte, CRC', status: 'notStarted' },
      { id: 'ms-7', label: 'Decision with 30 days’ notice', when: 'By 1 May 2027', due: '2027-05-01', owner: 'Jordan Ellis', status: 'notStarted' },
    ],
    workstreams: [
      { name: 'Medical', owner: 'Sam Whitaker, RN', cadence: 'Every 90 days', last: 'APS 22 Sep', next: 'Visit 12 Dec', status: { label: 'On track', tone: 'info' }, section: 'medical' },
      { name: 'Vocational', detail: 'Transferable skills analysis', owner: 'Chris Duarte, CRC', cadence: 'Per plan', last: '—', next: '14 Oct', status: { label: 'Scheduled', tone: 'info' } },
      { name: 'Financial', detail: 'Owner distributions are not earnings from work', owner: 'Hugo Brenner, CPA', cadence: 'Annual', last: '12 Sep', next: 'Sep 2027', status: { label: 'Current', tone: 'positive' } },
      { name: 'Return to work', detail: 'Part-time office or dispatch role in his own company', owner: 'Chris Duarte, CRC', cadence: 'Per plan', last: '—', next: 'After 14 Oct', status: { label: 'Planned', tone: 'neutral' } },
      { name: 'Money', detail: 'Next COLA 1 Jun 2027', owner: 'Jordan Ellis', cadence: 'Monthly', last: '1 Sep', next: '1 Oct', status: { label: 'Current', tone: 'positive' }, section: 'payments' },
      { name: 'Claimant contact', owner: 'Jordan Ellis', cadence: 'Monthly call', last: '12 Sep', next: '12 Oct', status: { label: 'Current', tone: 'positive' }, section: 'communications' },
    ],
    diary: [
      { date: '2026-10-01', label: 'Payment', who: 'J. Ellis' },
      { date: '2026-10-12', label: 'Monthly call', who: 'J. Ellis' },
      { date: '2026-10-14', label: 'Skills analysis', who: 'C. Duarte' },
      { date: '2026-11-30', label: 'Proof of loss expires', who: 'J. Ellis' },
      { date: '2026-12-01', label: 'Transition review, notice', who: 'J. Ellis' },
      { date: '2026-12-12', label: 'Orthopaedic visit', who: 'Dr. Castillo' },
    ],
    team: [
      { initials: 'JE', name: 'Jordan Ellis', role: 'DI case manager', note: 'Owner' },
      { initials: 'SW', name: 'Sam Whitaker, RN', role: 'Nurse case manager' },
      { initials: 'CD', name: 'Chris Duarte, CRC', role: 'Vocational consultant' },
      { initials: 'LM', name: 'Dr. Leah Morgan, MD', role: 'Physician consultant · on request' },
      { initials: 'HB', name: 'Hugo Brenner, CPA', role: 'Claims financial analyst' },
      { initials: 'MK', name: 'Marta Koenig', role: 'DI team lead' },
    ],
    preferences: [
      ['Contact', 'Phone, afternoons'],
      ['Letters', 'Plain language'],
      ['Interpreter', 'Not needed'],
    ],
    lastContact: {
      at: '2026-09-12', channel: 'phone', minutes: 18, next: '2026-10-12',
      text: 'Reports progress in physical therapy and better sleep; asked how the any-occupation review works.',
    },
    versions: [
      { v: 4, date: '2026-09-12', by: 'Jordan Ellis', summary: 'Transition to any occupation: skills analysis 14 Oct, labor market survey, notice by 1 Dec. Financial review moves to annual.' },
      { v: 3, date: '2026-03-18', by: 'Jordan Ellis', summary: 'Return-to-work workstream added: a part-time office or dispatch role in his own company.' },
      { v: 2, date: '2025-10-15', by: 'Jordan Ellis', summary: 'Pain management added after injections; business overhead expense reviewed monthly.' },
      { v: 1, date: '2025-06-12', by: 'Jordan Ellis', summary: 'First plan after approval: recovery from fusion, physical therapy, monthly contact.' },
    ],
  },
]
