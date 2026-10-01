import type { ContestableReview } from '../contestable'

// Owned by the Contestable review screen. Neutral wording throughout: differences are questions for
// Underwriting, never findings. Materiality is Underwriting's call.

export const CONTESTABLE: ContestableReview[] = [
  {
    id: 'L-26-038907',
    claimId: 'L-26-038907',
    benefitLineId: 'bl-okafor-term',
    policy: 'LP-2511086',
    product: 'Term life, 20-year',
    face: 500_000,
    issued: '2025-11-01',
    applicationSigned: '2025-09-18',
    death: '2026-07-14',
    periodEnds: '2027-11-01',
    due: '2026-10-09',
    owner: 'Rachel Kim',
    provision: 'Policy §3 Incontestability — contestable for two years from the issue date',
    checks: [
      { id: 'c1', label: 'Gather the records the application answers can be compared with', detail: 'Pharmacy history, the Medical Information Bureau check and the police report are in. Dr. Patel’s records are outstanding.', status: { label: 'In progress', tone: 'caution' } },
      { id: 'c2', label: 'Compare each application answer with the records', detail: '5 answers compared so far; 1 raises a question for Underwriting; 1 waits on Dr. Patel’s records.', status: { label: '1 question', tone: 'special' } },
      { id: 'c3', label: 'Underwriting opinion on any difference', detail: 'Whether the difference would have changed the issue decision. Underwriting decides materiality.', status: { label: 'Not referred', tone: 'neutral' } },
      { id: 'c4', label: 'Examiner decision on the term policy, then the rider', detail: 'Recorded on the Decision screen once the opinion is in, with a second review if adverse.', status: { label: 'After opinion', tone: 'neutral' } },
    ],
    answers: [
      {
        id: 'q4', question: 'Q4', text: 'In the past 5 years, have you been treated for or taken medication for high blood pressure?', answer: 'No',
        evidence: 'Pharmacy history lists an antihypertensive (amlodipine 5 mg), filled about every 90 days since March 2022, most recently June 2026.',
        sources: ['Application Q4', 'Pharmacy history'], state: 'question',
        note: 'A question for Underwriting, not a finding. The fills may have another explanation; Dr. Patel’s records may show why it was prescribed.',
      },
      {
        id: 'q2', question: 'Q2', text: 'In the past 12 months, have you used tobacco or nicotine products?', answer: 'No',
        evidence: 'No nicotine products in pharmacy history; no nicotine noted on the toxicology report.',
        sources: ['Pharmacy history', 'Toxicology · p.2'], state: 'consistent',
      },
      {
        id: 'q6', question: 'Q6', text: 'In the past 5 years, have you been hospitalized or advised to have surgery?', answer: 'No',
        evidence: 'Nothing in the records received so far. Dr. Patel’s records will cover this.',
        sources: ['Application 2025'], state: 'pending',
      },
      {
        id: 'q9', question: 'Q9', text: 'In the past 3 years, have you had a driving-under-the-influence conviction or license suspension?', answer: 'No',
        evidence: 'Motor vehicle report at issue was clear; the police report of 14 Jul notes no prior incidents.',
        sources: ['Police report', 'Application 2025'], state: 'consistent',
      },
      {
        id: 'q11', question: 'Q11', text: 'Do you have other life insurance in force?', answer: 'Yes · whole life LP-1219044',
        evidence: 'Matches our own record of LP-1219044, in force since 2012.',
        sources: ['Policy record'], state: 'consistent',
      },
    ],
    records: [
      { id: 'r1', name: 'Pharmacy history', from: 'Pharmacy data · automatic', requested: '2026-07-24', status: { label: 'Received 3 Aug', tone: 'positive' }, followUps: [] },
      { id: 'r2', name: 'Medical Information Bureau check', from: 'MIB · automatic', requested: '2026-07-24', status: { label: 'Received 3 Aug', tone: 'positive' }, followUps: [] },
      { id: 'r3', name: 'Police accident report', from: 'County sheriff’s office', requested: '2026-07-28', status: { label: 'Received 12 Aug', tone: 'positive' }, followUps: [] },
      {
        id: 'r4', name: 'Medical records, Nov 2020 – Jul 2026', from: 'Dr. Anil Patel · primary care', requested: '2026-07-28',
        status: { label: '2nd request', tone: 'caution' }, followUps: ['Call 25 Aug · not yet sent', 'Second request 16 Sep · fax and provider portal'], due: '2026-09-30',
      },
    ],
    referral: { state: 'notReferred', to: 'Underwriting · individual life', due: '2026-10-06' },
    rider: {
      name: 'Accidental death rider', amount: 250_000,
      rule: 'The rider is part of LP-2511086. If the term policy stands, the rider is decided on its own accident evidence. If the term policy is rescinded, the rider ends with it and nothing is payable under it.',
      evidence: [
        { label: 'Toxicology report', status: { label: 'Received today', tone: 'info' } },
        { label: 'Police accident report', status: { label: 'Received 12 Aug', tone: 'positive' } },
        { label: 'Coroner’s final report', status: { label: 'Requested · external', tone: 'caution' } },
      ],
    },
  },
]
