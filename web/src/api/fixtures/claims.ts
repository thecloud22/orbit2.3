import type { Claim, Family, NextStep, SectionKey, StageStep, Status } from '../types'

/*
 * Sample claims from the canvas (board 01.1). Six are carried in full; the rest are light records
 * so every queue row opens something real. People, businesses and amounts are fictional.
 * The mock's today is Fri 25 Sep 2026.
 */

const STAGES: Record<Family, string[]> = {
  life: ['Intake', 'Evidence', 'Review', 'Decision', 'Payment', 'Closed'],
  disability: ['Intake', 'Evidence', 'Decision', 'Payment', 'Managing', 'Closed'],
  annuity: ['Notice', 'Good order', 'Valuation', 'Election', 'Payment', 'Closed'],
}

function stages(family: Family, current: number, notes: Record<number, string> = {}, partial: number[] = []): StageStep[] {
  return STAGES[family].map((label, i) => ({
    key: label.toLowerCase().replace(/\s+/g, '-'),
    label,
    state: partial.includes(i) ? 'partial' : i < current ? 'done' : i === current ? 'current' : 'todo',
    note: notes[i],
  }))
}

const plain = (label: string): Status => ({ label, tone: 'plain' })

const LIFE_SECTIONS: SectionKey[] = ['overview', 'policies', 'people', 'requirements', 'documents', 'decision', 'payments', 'communications', 'history']
const DI_SECTIONS: SectionKey[] = ['overview', 'policies', 'people', 'requirements', 'documents', 'medical', 'decision', 'payments', 'case-plan', 'communications', 'history']
const ANNUITY_SECTIONS: SectionKey[] = ['overview', 'policies', 'people', 'requirements', 'documents', 'distributions', 'payments', 'communications', 'history']

const FULL: Claim[] = [
  // ------------------------------------------------------------------ Pierce — fast track
  {
    id: 'L-26-040112',
    family: 'life',
    product: 'Term life',
    name: 'Harold Pierce',
    tags: [plain('Fast track')],
    facts: ['Insured and owner · died 29 Aug 2026, age 64', '20-year term · LP-1107752 · issued 1 Apr 2011', 'Filed 3 Sep by Margaret Pierce, spouse'],
    ownerId: 'rachel',
    team: 'Life & annuity team',
    filed: '2026-09-03',
    stage: stages('life', 3),
    clocks: [
      { id: 'c1', label: 'State decision', kind: 'deadline', state: 'running', due: '2026-10-03', progress: 0.73 },
      { id: 'c2', label: 'Interest since 29 Aug', kind: 'accruing', state: 'running', start: '2026-08-29' },
    ],
    nextStep: { label: 'Record decision', reason: 'All 9 checks pass · due 3 Oct', section: 'decision' },
    exceptions: [],
    benefitLines: [
      {
        id: 'bl-pierce-term',
        name: 'Term life, 20-year',
        ref: 'LP-1107752',
        refNote: 'issued 1 Apr 2011',
        amount: 150_000,
        status: { label: 'Ready to decide', tone: 'info' },
        waitingOn: 'You',
        due: '3 Oct',
      },
    ],
    parties: [
      { id: 'p1', name: 'Harold Pierce', roles: ['Insured', 'Owner'], note: 'Died 29 Aug 2026, age 64' },
      { id: 'p2', name: 'Margaret Pierce', roles: ['Beneficiary', 'Claimant'], relationship: 'Spouse', share: '100%', status: { label: 'Identity verified', tone: 'positive' }, contact: 'Portal · prefers email' },
      { id: 'p3', name: 'Linden Grove Funeral Home', roles: ['Assignee', 'Payee'], share: '$9,850.00', status: { label: 'Invoice matches', tone: 'positive' } },
      { id: 'p4', name: 'Paul Hendricks', roles: ['Agent of record'], access: 'Status and requirements only, with consent', status: { label: 'Consent 3 Sep', tone: 'neutral' } },
    ],
    summary: {
      text: 'Harold Pierce died on 29 Aug. His 2011 term policy is in force and past its contestable period. Margaret, his wife, is the sole beneficiary and assigned $9,850 to Linden Grove Funeral Home. Every requirement arrived by 23 Sep and all fast-track rules pass.',
      asOf: '07:02 · 7 documents',
      sources: ['Death certificate', 'Policy record', 'Assignment'],
    },
    suggestions: [
      {
        id: 's-pierce-1',
        group: 'next',
        category: 'Communication',
        title: 'Tell Margaret when the money arrives',
        body: 'She asked in the portal on 22 Sep when she would hear. The approval letter answers it; a short portal message can go today.',
        sources: ['Portal message · 22 Sep'],
        primary: 'Create draft',
        creates: 'Reply to Margaret’s portal message',
        state: 'open',
      },
    ],
    linked: ['Margaret Pierce — person', 'Linden Grove — payee', 'Agent Paul Hendricks'],
    sections: LIFE_SECTIONS,
    detail: { kind: 'life', beneficiaryNote: 'Designation of 10 Jun 2019' },
  },

  // ------------------------------------------------------------------ Okafor — complex life
  {
    id: 'L-26-038907',
    family: 'life',
    product: 'Individual life',
    name: 'Daniel Okafor',
    tags: [{ label: 'Contestable', tone: 'special' }],
    facts: ['Insured and owner · died 14 Jul 2026, age 44', '2 policies · 3 benefit lines · $894,180', 'Filed 24 Jul by Adaeze Okafor, spouse'],
    ownerId: 'rachel',
    team: 'Life & annuity team',
    filed: '2026-07-24',
    stage: stages('life', 2, { 3: '1 of 3', 4: 'partial' }, [3, 4]),
    clocks: [
      { id: 'c1', label: 'Status letter · state', kind: 'deadline', state: 'running', due: '2026-10-03', progress: 0.73 },
      { id: 'c2', label: 'Interest since 14 Jul', kind: 'accruing', state: 'running', start: '2026-07-14' },
    ],
    nextStep: { label: 'Send custodian packet', reason: 'Releases $72,090 held for two minor beneficiaries', section: 'communications' },
    exceptions: [
      {
        id: 'x1',
        title: 'Term life is contestable',
        detail: 'Issued 1 Nov 2025, 8 months before death — the review must finish before this policy or its rider is decided',
        meta: 'Review due 9 Oct',
        action: { label: 'Open review', section: 'contestable' },
        status: 'open',
      },
      {
        id: 'x2',
        title: 'Two beneficiaries are minors',
        detail: '$72,090 of whole life proceeds is held until a custodian or guardian is documented',
        meta: 'Waiting on Adaeze Okafor',
        action: { label: 'Resolve', section: 'communications' },
        status: 'open',
      },
    ],
    benefitLines: [
      {
        id: 'bl-okafor-wl',
        name: 'Whole life',
        ref: 'LP-1219044',
        refNote: 'since 2012',
        amount: 144_180,
        amountNote: 'after loan',
        status: { label: 'Approved 18 Sep', tone: 'positive' },
        paid: '$72,090.00 paid',
        held: '$72,090.00 held · minors',
        waitingOn: 'Custodian papers',
      },
      {
        id: 'bl-okafor-term',
        name: 'Term life, 20-year',
        ref: 'LP-2511086',
        refNote: 'issued 1 Nov 2025',
        amount: 500_000,
        status: { label: 'Contestable review', tone: 'special' },
        waitingOn: 'Dr. Anil Patel · records',
        due: '9 Oct',
      },
      {
        id: 'bl-okafor-adb',
        name: 'Accidental death rider',
        ref: 'LP-2511086',
        refNote: 'On LP-2511086 · follows its outcome',
        amount: 250_000,
        status: { label: 'Pending evidence', tone: 'caution' },
        waitingOn: 'Coroner · final report',
        due: 'after review',
      },
    ],
    parties: [
      { id: 'p1', name: 'Daniel Okafor', roles: ['Insured', 'Owner'], note: 'Died 14 Jul 2026, age 44 · single-vehicle accident' },
      { id: 'p2', name: 'Adaeze Okafor', roles: ['Beneficiary', 'Claimant'], relationship: 'Spouse', share: '50%', status: { label: 'Paid 19 Sep', tone: 'positive' }, contact: 'Prefers phone, afternoons · portal active' },
      { id: 'p3', name: 'Chidi Okafor', roles: ['Beneficiary'], relationship: 'Son · 12', share: '25%', status: { label: 'Custodian needed', tone: 'caution' } },
      { id: 'p4', name: 'Amara Okafor', roles: ['Beneficiary'], relationship: 'Daughter · 9', share: '25%', status: { label: 'Custodian needed', tone: 'caution' } },
      { id: 'p5', name: 'Dr. Anil Patel', roles: ['Treating physician'], note: 'Records for the contestable review', status: { label: '2nd request', tone: 'caution' } },
      { id: 'p6', name: 'Paul Hendricks', roles: ['Agent of record'], access: 'Status only, with the family’s permission', status: { label: 'Reported the death', tone: 'neutral' } },
    ],
    summary: {
      text: 'Daniel Okafor died on 14 Jul in a single-vehicle accident. His 2012 whole life policy is approved; the children’s half is held for a custodian. His term policy began 1 Nov 2025, so it is being reviewed; its accidental death rider waits on that review and the coroner.',
      asOf: '09:14 · 26 documents',
      sources: ['Death certificate', 'Application 2025', 'Policy record', 'Loan statement'],
    },
    suggestions: [
      {
        id: 's-okafor-1',
        group: 'next',
        category: 'rider',
        title: 'Review today’s toxicology report',
        body: 'No alcohol or drugs detected, so the intoxication exclusion would not apply if the coroner agrees.',
        sources: ['Toxicology · p.2'],
        primary: 'Open',
        section: 'documents',
        state: 'open',
      },
      {
        id: 's-okafor-2',
        group: 'check',
        category: 'Contestable',
        title: 'Application answer vs pharmacy history',
        body: 'The 2025 application answered No to blood-pressure treatment; pharmacy history shows an antihypertensive since 2022. Materiality is Underwriting’s call — not a finding.',
        sources: ['Application Q4', 'Pharmacy history'],
        primary: 'Refer to Underwriting',
        creates: 'Underwriting referral: application Q4',
        state: 'open',
      },
    ],
    linked: ['Adaeze Okafor — person', 'Agent Paul Hendricks'],
    sections: ['overview', 'policies', 'people', 'requirements', 'documents', 'contestable', 'decision', 'payments', 'communications', 'history'],
    detail: { kind: 'life', beneficiaryNote: 'Same designation on both policies' },
  },

  // ------------------------------------------------------------------ Whitman — above authority, payment held
  {
    id: 'L-26-035120',
    family: 'life',
    product: 'Universal life',
    name: 'Grace Whitman',
    tags: [{ label: 'Payment held', tone: 'critical' }],
    facts: ['Insured and owner · died 21 Aug 2026, age 71', 'UL-0988214 · issued 2003', 'Filed 28 Aug by Robert Whitman, husband'],
    ownerId: 'rachel',
    team: 'Life & annuity team',
    filed: '2026-08-28',
    stage: stages('life', 4),
    clocks: [
      { id: 'c1', label: 'Payment · state limit', kind: 'deadline', state: 'running', due: '2026-10-27', progress: 0.1 },
      { id: 'c2', label: 'Interest since 21 Aug', kind: 'accruing', state: 'running', start: '2026-08-21' },
    ],
    nextStep: { label: 'Update Robert on timing', reason: 'Approved 08:52 · held for sanctions screening', section: 'communications' },
    exceptions: [
      {
        id: 'x1',
        title: 'Payment held — possible sanctions match',
        detail: 'Robert Whitman’s name partly matches a listed person; Payments is confirming identity before release',
        meta: 'Waiting on Payments · Lauren Pike',
        action: { label: 'See hold', section: 'payments' },
        status: 'open',
      },
    ],
    benefitLines: [
      {
        id: 'bl-whitman-ul',
        name: 'Universal life, option A',
        ref: 'UL-0988214',
        refNote: 'since 2003',
        amount: 436_000,
        status: { label: 'Approved 25 Sep', tone: 'positive' },
        held: '$436,000.00 held · screening',
        waitingOn: 'Payments',
        due: 'today',
      },
    ],
    parties: [
      { id: 'p1', name: 'Grace Whitman', roles: ['Insured', 'Owner'], note: 'Died 21 Aug 2026, age 71' },
      { id: 'p2', name: 'Robert Whitman', roles: ['Beneficiary', 'Claimant'], relationship: 'Husband', share: '100%', status: { label: 'Screening hold', tone: 'critical' }, contact: 'Phone · mornings' },
    ],
    summary: {
      text: 'Grace Whitman’s universal life policy pays its level face of $436,000. Rachel approved it this morning with Monica Reyes’s approval, as it is above Rachel’s $250,000 authority. Payments is holding the payout while it clears a partial sanctions-list name match on Robert.',
      asOf: '08:55 · 9 documents',
      sources: ['Decision record v1', 'Screening result'],
    },
    suggestions: [],
    linked: ['Robert Whitman — person'],
    sections: LIFE_SECTIONS,
    detail: { kind: 'life', beneficiaryNote: 'Designation of 2 May 2016' },
  },

  // ------------------------------------------------------------------ Vasquez — DI, missing information
  {
    id: 'D-26-073390',
    family: 'disability',
    product: 'Disability income',
    name: 'Elena Vasquez',
    tags: [plain('Residual claim')],
    facts: ['Claimant · age 46 · 2 clinical days a week since 12 Jun', 'Vasquez Family Dentistry (owner) · DI-1507791', 'General dentist · own occupation'],
    ownerId: 'jordan',
    team: 'DI Team 2',
    filed: '2026-08-25',
    stage: stages('disability', 1),
    clocks: [
      { id: 'c1', label: 'Status letter', kind: 'deadline', state: 'running', due: '2026-10-24', progress: 0.03, valueText: 'next due 24 Oct' },
      { id: 'c2', label: 'Waiting on others', kind: 'accruing', state: 'running', start: '2026-08-26' },
    ],
    nextStep: { label: 'Call Dr. Hsu’s office', reason: 'Physician statement 30 days outstanding', section: 'requirements', target: 'req-vas-aps' },
    exceptions: [
      {
        id: 'x1',
        title: 'Physician statement overdue',
        detail: 'Requested 26 Aug from Dr. Grace Hsu; reminders 5 and 16 Sep',
        meta: '9 days late',
        action: { label: 'Call office', section: 'requirements', target: 'req-vas-aps' },
        status: 'open',
      },
      {
        id: 'x2',
        title: 'Financial records incomplete',
        detail: '2024 tax return and monthly practice P&L since June are missing; the residual benefit can’t be calculated',
        meta: 'Waiting on Elena',
        action: { label: 'Request from her accountant', section: 'requirements', target: 'req-vas-pl' },
        status: 'open',
      },
    ],
    benefitLines: [
      {
        id: 'bl-vas-di',
        name: 'Disability income · residual',
        ref: 'DI-1507791',
        refNote: 'own occupation · $12,000 / month',
        amount: 12_000,
        amountNote: 'per month, before residual share',
        status: { label: 'Gathering evidence', tone: 'caution' },
        waitingOn: 'Dr. Hsu · Elena',
        due: 'after evidence',
      },
    ],
    parties: [
      { id: 'p1', name: 'Elena Vasquez', roles: ['Claimant', 'Insured', 'Owner'], note: 'Age 46 · owner of Vasquez Family Dentistry', contact: 'Portal · text reminders on' },
      { id: 'p2', name: 'Dr. Grace Hsu', roles: ['Treating physician'], note: 'Lakeside Rheumatology Associates · (555) 010-4400', status: { label: 'Statement overdue', tone: 'critical' } },
      { id: 'p3', name: 'Vasquez Family Dentistry', roles: ['Business'], note: 'Elena is the sole owner' },
      { id: 'p4', name: 'Hugo Brenner', roles: ['Claims financial analyst'], note: 'Works out the residual share from the P&L and returns' },
      { id: 'p5', name: 'Paul Hendricks', roles: ['Agent of record'], access: 'Status and requirements only, never medical detail', status: { label: 'Consent 25 Aug', tone: 'neutral' } },
    ],
    summary: {
      text: 'Elena Vasquez, a general dentist who owns her practice, cut back to two clinical days a week on 12 Jun and claims a residual benefit. Five of nine requirements are met. The decision waits on Dr. Hsu’s statement and on the 2024 tax return and practice P&L that Hugo Brenner needs to work out the residual share of the $12,000 monthly benefit.',
      asOf: '08:10 · 8 documents',
      sources: ['Claimant statement', 'Duties questionnaire', '2025 tax return'],
    },
    suggestions: [
      {
        id: 's-vas-1',
        group: 'next',
        category: 'State status-letter rule',
        title: 'Status letter — drafted',
        body: 'From template ST-DI-30: tells Elena what is still needed and why. The next one is due 24 Oct because state rules require one every 30 days while a claim is pending.',
        sources: ['ST-DI-30'],
        primary: 'Schedule for 24 Oct',
        creates: 'Status letter 2 scheduled for 24 Oct',
        state: 'open',
      },
    ],
    linked: ['Elena Vasquez — person', 'Vasquez Family Dentistry', 'Agent Paul Hendricks'],
    sections: ['overview', 'policies', 'people', 'requirements', 'documents', 'medical', 'financials', 'decision', 'communications', 'history'],
    detail: {
      kind: 'disability',
      medical: [
        ['Condition', 'To be coded from Dr. Hsu’s statement'],
        ['Treating', 'Dr. Grace Hsu · Lakeside Rheumatology'],
        ['Records', 'Vendor · ETA 1 Oct'],
        ['Pharmacy', 'Received 27 Aug'],
      ],
      work: [
        ['Own occupation', 'General dentist; owns and runs the practice'],
        ['Since 12 Jun', 'Two clinical days a week'],
        ['Financial review', 'Hugo Brenner · needs 2024 return and P&L'],
      ],
      money: [
        ['Monthly benefit', '$12,000.00 · residual share to be calculated'],
        ['Elimination', '90 days · satisfied 10 Sep'],
        ['Tax', 'Not taxable · premiums paid personally'],
      ],
    },
  },

  // ------------------------------------------------------------------ Bell — DI, ongoing management
  {
    id: 'D-25-018334',
    family: 'disability',
    product: 'Disability income',
    name: 'Marcus Bell',
    tags: [plain('Premium waived')],
    facts: ['Claimant · age 52 · disabled since 2 Dec 2024', 'DI-1310776 · own occupation', 'Owner-operator · Bell Freight & Logistics', '$6,695.00 / month'],
    ownerId: 'jordan',
    team: 'DI Team 2',
    filed: '2025-01-06',
    stage: stages('disability', 4),
    clocks: [
      { id: 'c1', label: 'Proof of loss valid', kind: 'deadline', state: 'running', due: '2026-11-30', progress: 0.3 },
      { id: 'c2', label: 'Any-occupation change', kind: 'deadline', state: 'running', due: '2027-06-01', progress: 0.55 },
    ],
    nextStep: { label: 'Review APS update', reason: 'Received today · feeds the 14 Oct skills analysis', section: 'documents', target: 'doc-bell-aps' },
    exceptions: [],
    benefitLines: [
      { id: 'bl-bell-di', name: 'Disability income', ref: 'DI-1310776', refNote: 'own occupation to 31 May 2027', amount: 6_695, amountNote: 'per month · 3% COLA', status: { label: 'Active · own occupation', tone: 'positive' }, waitingOn: 'You · APS review', due: 'Transition review 1 Dec' },
      { id: 'bl-bell-boe', name: 'Business overhead expense', ref: 'BE-1310777', refNote: 'Jan 2025 – Jun 2026', amount: 128_640, amountNote: 'reimbursed', status: { label: 'Closed · maximum 18 months', tone: 'neutral' } },
      { id: 'bl-bell-wop', name: 'Waiver of premium on life', ref: 'LP-1310775', refNote: 'from 1 Jun 2025', status: { label: 'Approved', tone: 'positive' }, waitingOn: 'With DI claim' },
    ],
    parties: [
      { id: 'p1', name: 'Marcus Bell', roles: ['Claimant', 'Insured', 'Owner'], note: 'Age 52 · owner of Bell Freight & Logistics', contact: 'Phone · prefers mornings' },
      { id: 'p2', name: 'Dr. Owen Castillo', roles: ['Treating physician'], note: 'Orthopedic spine · next visit 12 Dec' },
      { id: 'p3', name: 'Sam Whitaker, RN', roles: ['Nurse case manager'], note: 'Open referral · restrictions review' },
      { id: 'p4', name: 'Chris Duarte, CRC', roles: ['Vocational consultant'], note: 'Transferable skills analysis 14 Oct' },
      { id: 'p5', name: 'Hugo Brenner, CPA', roles: ['Claims financial analyst'], note: 'Financial review 12 Sep' },
      { id: 'p6', name: 'Paul Hendricks', roles: ['Agent of record'], access: 'Status only, never medical detail' },
    ],
    summary: {
      text: 'Marcus Bell, 52, has received disability income since 1 Jun 2025 after an L4–L5 fusion. Today’s APS reports permanent restrictions, with slightly better sitting tolerance than in June. His own-occupation period ends 31 May 2027; the transition review opens 1 Dec, after a skills analysis on 14 Oct. Business overhead expense closed at its 18-month maximum on 30 Jun 2026.',
      asOf: '08:40 · 46 documents',
      sources: ['APS · 22 Sep', 'Policy DI-1310776', 'Financial review · 12 Sep'],
    },
    suggestions: [
      {
        id: 's-bell-1',
        group: 'next',
        category: 'Vocational',
        title: 'Share the new restrictions with Chris Duarte before the 14 Oct skills analysis',
        body: 'Sitting tolerance rose from 20 to 30 minutes at a time and from 3 to 4 hours a day. That can change which occupations the analysis finds.',
        sources: ['APS · 22 Sep, p.2'],
        primary: 'Send',
        creates: 'Restrictions sent to Chris Duarte, CRC',
        state: 'open',
      },
      {
        id: 's-bell-2',
        group: 'next',
        category: 'Transition',
        title: 'Start the any-occupation notice for 1 Dec',
        body: 'The notice explains the new definition and what Marcus can send. The 14 Oct skills analysis feeds it.',
        sources: ['Policy · definitions'],
        primary: 'Create draft',
        creates: 'Draft any-occupation transition notice',
        state: 'open',
      },
    ],
    linked: ['DI policy DI-1310776', 'BOE policy BE-1310777', 'Life policy LP-1310775'],
    sections: DI_SECTIONS,
    detail: {
      kind: 'disability',
      medical: [
        ['Condition', 'Lumbar disc disease; L4–L5 fusion Feb 2025'],
        ['Restrictions', 'Permanent · sit 30 min at a time, 4 h/day'],
        ['Treating', 'Dr. Castillo · visit 12 Dec'],
        ['Nurse', 'Sam Whitaker, RN'],
      ],
      work: [
        ['Own occupation', 'Owner-operator: drove, loaded and ran the company'],
        ['The business', 'An operations manager runs it since Mar 2025; Marcus does no work in it'],
        ['Financial review', '12 Sep · Hugo Brenner, CPA'],
        ['Skills analysis', '14 Oct · Chris Duarte, CRC'],
      ],
      money: [
        ['Monthly', '$6,695.00 · tax-free'],
        ['Paid to date', '$104,780.00'],
        ['BOE', 'Closed after 18 months'],
        ['Premiums', 'DI and life waived'],
      ],
    },
  },

  // ------------------------------------------------------------------ Hart — annuity death claim, two beneficiaries
  {
    id: 'A-26-015530',
    family: 'annuity',
    product: 'Variable annuity',
    name: 'Evelyn Hart',
    tags: [plain('Non-qualified')],
    facts: ['Owner and annuitant · died 3 Sep 2026, age 78', 'VA-2201946 · issued 14 Feb 2015', 'Agent Paul Hendricks', '2 beneficiaries · death benefit $655,000'],
    ownerId: 'irene',
    team: 'Life & annuity team',
    filed: '2026-09-05',
    stage: stages('annuity', 1, { 1: '1 of 2', 4: '1 of 2' }, [1, 2, 3, 4]),
    clocks: [
      { id: 'c1', label: 'Life-expectancy option', kind: 'deadline', state: 'running', due: '2027-09-03', progress: 0.06, valueText: 'start by 3 Sep 2027' },
      { id: 'c2', label: 'Claire’s good order', kind: 'accruing', state: 'running', start: '2026-09-08' },
    ],
    nextStep: { label: 'Follow up with Claire', reason: 'Her half floats with the market until her forms arrive', section: 'requirements', target: 'req-hart-claire' },
    exceptions: [
      {
        id: 'x1',
        title: 'Claire’s share isn’t in good order',
        detail: 'Claimant statement and W-9 missing. Her half stays invested and changes daily; at least $327,500 is guaranteed.',
        meta: 'Waiting on Claire Hart-Lopez',
        action: { label: 'Send reminder', section: 'requirements', target: 'req-hart-claire' },
        status: 'open',
      },
    ],
    benefitLines: [
      {
        id: 'bl-hart-db',
        name: 'Death benefit',
        ref: 'VA-2201946',
        refNote: 'greater of contract value and GMDB',
        amount: 655_000,
        status: { label: 'Approved 22 Sep', tone: 'positive' },
        paid: 'Nathan · paying 26 Sep',
        held: 'Claire · waiting on good order',
        waitingOn: 'Claire Hart-Lopez',
      },
    ],
    parties: [
      { id: 'p1', name: 'Evelyn Hart', roles: ['Owner', 'Annuitant'], note: 'Died 3 Sep 2026, age 78' },
      { id: 'p2', name: 'Nathan Hart', roles: ['Beneficiary'], relationship: 'Son', share: '50%', status: { label: 'Paying 26 Sep', tone: 'info' }, contact: 'Portal · email' },
      { id: 'p3', name: 'Claire Hart-Lopez', roles: ['Beneficiary'], relationship: 'Daughter', share: '50%', status: { label: 'Forms missing', tone: 'caution' }, contact: 'Phone · shares status with agent (12 Sep)' },
      { id: 'p4', name: 'Paul Hendricks', roles: ['Agent of record'], access: 'Claire’s status, with her consent of 12 Sep', status: { label: 'Consent 12 Sep', tone: 'neutral' } },
    ],
    summary: {
      text: 'Evelyn Hart’s variable annuity pays the greater of contract value and the highest-anniversary guarantee. Nathan chose a lump sum; he is paid on 26 Sep. Claire hasn’t sent her claimant statement or W-9; her half stays invested until then and is protected at $327,500.',
      asOf: '09:14 · 9 documents',
      sources: ['GMDB rider', 'Unit values · 22 Sep', 'Beneficiary designation'],
    },
    suggestions: [
      {
        id: 's-hart-1',
        group: 'next',
        category: 'Good order',
        title: 'Send Claire a reminder with the options guide',
        body: 'Her forms were requested 8 Sep. The guide explains the three choices and the 3 Sep 2027 start date in plain words.',
        sources: ['Requirements'],
        primary: 'Create draft',
        creates: 'Draft reminder to Claire with options guide',
        state: 'open',
      },
      {
        id: 's-hart-2',
        group: 'next',
        category: 'Agent of record',
        title: 'Ask Paul Hendricks to help Claire',
        body: 'She agreed on 12 Sep to share her claim status with him. He can help her gather the forms and compare options.',
        sources: ['Consent · 12 Sep'],
        primary: 'Send',
        creates: 'Asked Paul Hendricks to help Claire',
        state: 'open',
      },
    ],
    linked: ['Contract VA-2201946', 'Claire Hart-Lopez — person', 'Paul Hendricks — agent'],
    sections: ANNUITY_SECTIONS,
    detail: {
      kind: 'annuity',
      deathBenefit: [
        { label: 'Contract value on 22 Sep', source: 'Unit values · 22 Sep', amount: 612_400 },
        { label: 'GMDB — highest anniversary (14 Feb 2026)', source: 'GMDB rider', amount: 655_000, greater: true },
      ],
      shareNote: 'Each share is valued on the day that beneficiary’s claim is in good order; Claire’s will be at least $327,500.00.',
    },
  },
]

// ------------------------------------------------------------------ Light claims

interface LightSpec {
  id: string
  family: Family
  product: string
  name: string
  ownerId: string
  team?: string
  facts: string[]
  stageAt: number
  status: Status
  lineName: string
  ref: string
  amount?: number
  next: NextStep
  due?: string
  tags?: Status[]
  summary: string
}

function light(s: LightSpec): Claim {
  return {
    id: s.id,
    family: s.family,
    product: s.product,
    name: s.name,
    tags: s.tags ?? [],
    facts: s.facts,
    ownerId: s.ownerId,
    team: s.team ?? (s.family === 'disability' ? 'DI Team 2' : 'Life & annuity team'),
    filed: '2026-09-01',
    stage: stages(s.family, s.stageAt),
    clocks: s.due ? [{ id: 'c1', label: s.family === 'annuity' ? 'Next deadline' : 'State decision', kind: 'deadline', state: 'running', due: s.due, progress: 0.5 }] : [],
    nextStep: s.next,
    exceptions: [],
    benefitLines: [{ id: `bl-${s.id}`, name: s.lineName, ref: s.ref, amount: s.amount, status: s.status }],
    parties: [{ id: 'p1', name: s.name, roles: s.family === 'disability' ? ['Claimant', 'Insured'] : ['Insured'] }],
    summary: { text: s.summary, asOf: 'today', sources: [] },
    suggestions: [],
    linked: [],
    sections: ['overview', 'people', 'requirements', 'documents', 'decision', 'communications', 'history'],
    light: true,
  }
}

const LIGHT: Claim[] = [
  light({ id: 'L-26-036554', family: 'life', product: 'Term life', name: 'Julia Mercer', ownerId: 'rachel', facts: ['Insured · died 30 Jul 2026, age 58', 'LP-1402217 · 15-year term', 'Filed 12 Aug by Owen Mercer, son'], stageAt: 3, status: { label: 'Ready to decide', tone: 'info' }, lineName: 'Term life, 15-year', ref: 'LP-1402217', amount: 200_000, next: { label: 'Record decision', reason: 'Evidence complete · state deadline 27 Sep', section: 'decision' }, due: '2026-09-27', summary: 'All evidence is in. The state decision deadline is Sunday 27 Sep.' }),
  light({ id: 'L-26-031145', family: 'life', product: 'Whole life', name: 'Walter Greaves', ownerId: 'rachel', facts: ['Insured · died 2 Jul 2026, age 80', 'LP-0611893 · whole life', 'Competing claims from spouse and former spouse'], stageAt: 2, status: { label: 'Dispute', tone: 'special' }, lineName: 'Whole life', ref: 'LP-0611893', amount: 95_000, next: { label: 'Evaluate competing claim', reason: 'Former spouse cites a 2019 divorce decree', section: 'documents' }, due: '2026-10-14', tags: [{ label: 'Dispute', tone: 'special' }], summary: 'A former spouse says a 2019 divorce decree required her to stay the beneficiary. The current designation names the spouse.' }),
  light({ id: 'L-26-042877', family: 'life', product: 'Term life', name: 'Frank Delaney', ownerId: 'rachel', facts: ['Death-record match 12 Sep', 'LP-1711354 · 20-year term', 'No claim filed yet'], stageAt: 0, status: { label: 'Outreach', tone: 'neutral' }, lineName: 'Term life, 20-year', ref: 'LP-1711354', amount: 250_000, next: { label: 'Find beneficiaries', reason: 'Matched 12 Sep · no claim filed yet', section: 'people' }, due: '2026-10-12', summary: 'A death-master-file match found Frank Delaney’s death. No one has claimed; the beneficiaries on file need to be located.' }),
  light({ id: 'L-26-041577', family: 'life', product: 'Term life', name: 'Samuel Ortiz', ownerId: 'rachel', facts: ['Insured and owner · living', 'LP-1506640 · accelerated benefit rider', 'Filed 18 Sep by Samuel Ortiz'], stageAt: 1, status: { label: 'Certification received', tone: 'info' }, lineName: 'Accelerated benefit rider', ref: 'LP-1506640', amount: 150_000, next: { label: 'Review terminal-illness certification', reason: 'Form received · rider pays up to 50% of face', section: 'documents' }, due: '2026-10-02', summary: 'Samuel Ortiz asks for an accelerated benefit. His physician’s terminal-illness certification arrived today.' }),
  light({ id: 'L-26-039870', family: 'life', product: 'Term life', name: 'Beatrice Lang', ownerId: 'rachel', facts: ['Insured · died abroad 20 Jul 2026', 'LP-1308817 · 20-year term', 'Filed 6 Aug by Henrik Lang, husband'], stageAt: 1, status: { label: 'Waiting on beneficiary', tone: 'caution' }, lineName: 'Term life, 20-year', ref: 'LP-1308817', amount: 300_000, next: { label: 'Second request: apostilled certificate', reason: 'Death abroad · first request 21 days ago', section: 'requirements' }, due: '2026-09-30', summary: 'Beatrice Lang died in Portugal. The foreign death certificate needs an apostille; a consular report may be accepted with approval.' }),
  light({ id: 'L-26-037711', family: 'life', product: 'Whole life', name: 'Ruth Adeyemi', ownerId: 'rachel', facts: ['Insured · died 4 Jun 2026', 'LP-0817724 · whole life', 'Paid 2 Sep to Tunde Adeyemi, son'], stageAt: 4, status: { label: 'Paid 2 Sep', tone: 'positive' }, lineName: 'Whole life', ref: 'LP-0817724', amount: 60_000, next: { label: 'Return beneficiary’s call', reason: 'Voicemail 09:12 · asks about the 1099-INT', section: 'communications' }, summary: 'Paid in full on 2 Sep with interest. Tunde Adeyemi left a voicemail about the 1099-INT for the interest.' }),
  light({ id: 'L-25-022918', family: 'life', product: 'Whole life', name: 'Denise Farrow', ownerId: 'rachel', facts: ['Insured and owner · disabled since 2024', 'LP-1102345 · waiver of premium rider', 'Premiums waived since Jan 2025'], stageAt: 4, status: { label: 'Waiver active', tone: 'positive' }, lineName: 'Waiver of premium', ref: 'LP-1102345', next: { label: 'Annual waiver-of-premium review', reason: 'Proof of continued disability requested 1 Sep', section: 'requirements' }, summary: 'Premiums have been waived since January 2025. The annual proof of continued disability was requested on 1 Sep.' }),
  light({ id: 'L-26-042210', family: 'life', product: 'Universal life', name: 'Arthur Nyberg', ownerId: 'leon', facts: ['Insured · died 5 Sep 2026', 'LP-0712290 · option A (level)', 'Filed 10 Sep by Karin Nyberg, spouse'], stageAt: 3, status: { label: 'Awaiting approval', tone: 'info' }, lineName: 'Universal life, option A', ref: 'LP-0712290', amount: 512_500, next: { label: 'Approve payout', reason: 'Above Leon Park’s $250,000 authority', section: 'decision' }, due: '2026-10-10', summary: 'In force at death and past the contestable period. Option A pays the level face amount of $512,500 to Karin Nyberg.' }),
  light({ id: 'L-26-038115', family: 'life', product: 'Term life', name: 'Paul Imber', ownerId: 'leon', facts: ['Insured · died 11 Aug 2026', 'LP-2406611 · issued Feb 2025', 'Suicide exclusion within 2 years'], stageAt: 3, status: { label: 'Denial proposed', tone: 'critical' }, lineName: 'Term life', ref: 'LP-2406611', amount: 400_000, next: { label: 'Second review of denial', reason: 'Denials need a second review', section: 'decision' }, due: '2026-10-08', summary: 'The death occurred within the two-year suicide exclusion. Premiums paid would be refunded.' }),
  light({ id: 'L-26-029984', family: 'life', product: 'Whole life', name: 'Elaine Ruiz', ownerId: 'sofia', facts: ['Insured · died Mar 2026', 'LP-0402117 · whole life', 'Beneficiary not located'], stageAt: 4, status: { label: 'Unclaimed', tone: 'caution' }, lineName: 'Whole life', ref: 'LP-0402117', amount: 22_400, next: { label: 'Close without payment', reason: 'Beneficiary unlocatable — unclaimed property', section: 'decision' }, summary: 'Searches have not found the beneficiary. Proceeds go to the state as unclaimed property.' }),
  light({ id: 'A-26-016204', family: 'annuity', product: 'Fixed annuity', name: 'Lorraine Fitch', ownerId: 'irene', facts: ['Owner and annuitant · died 1 Sep 2026', 'FA-1503378 · fixed deferred', '1 beneficiary'], stageAt: 2, status: { label: 'Awaiting approval', tone: 'info' }, lineName: 'Death benefit', ref: 'FA-1503378', amount: 860_000, next: { label: 'Approve death benefit', reason: 'Above Irene Walsh’s $750,000 authority', section: 'decision' }, summary: 'Death benefit of $860,000 to the named beneficiary, above Irene’s authority.' }),
  light({ id: 'A-19-004418', family: 'annuity', product: 'Income annuity', name: 'George Ellison', ownerId: 'irene', facts: ['Annuitant · died 18 Jul 2026', 'IA-1904418 · joint & survivor 100% / 50%', 'Survivor: Ruth Ellison, spouse'], stageAt: 4, status: { label: 'Paid after death', tone: 'caution' }, lineName: 'Income annuity · survivor benefit', ref: 'IA-1904418', amount: 1_420, next: { label: 'Set up survivor payments and recover', reason: '2 payments of $2,840 after death · $2,840 net to recover', section: 'payments' }, tags: [plain('Payout event')], summary: 'George died on 18 Jul; a death-record match found it on 20 Sep. $5,680 was paid after death; $2,840 is owed to Ruth as survivor, so $2,840 is recovered from the next payments.' }),
  light({ id: 'D-25-029116', family: 'disability', product: 'Disability income', name: 'Aisha Coleman', ownerId: 'jordan', facts: ['Returned to work 3 Jun 2026', 'DI-1405521 · own occupation', 'Same condition within 6 months'], stageAt: 1, status: { label: 'Reopened · recurrent', tone: 'info' }, lineName: 'Disability income', ref: 'DI-1405521', amount: 5_200, next: { label: 'Review recurrent disability', reason: 'Same condition within 6 months · no new elimination period', section: 'overview' }, due: '2026-10-02', summary: 'Aisha returned to work on 3 Jun and stopped again on 14 Sep for the same condition. Under the recurrent disability provision the claim reopens without a new elimination period.' }),
  light({ id: 'D-26-071245', family: 'disability', product: 'Disability income', name: 'Priya Raman', ownerId: 'jordan', facts: ['Fractured wrist · 7 Aug 2026', 'DI-2004117 · own occupation', 'Expected back 5 Oct'], stageAt: 3, status: { label: 'Approved through 4 Oct', tone: 'positive' }, lineName: 'Disability income', ref: 'DI-2004117', amount: 9_000, next: { label: 'Confirm return-to-work date', reason: 'Expected back Mon 5 Oct · last payment prorated', section: 'payments' }, summary: 'A clear injury with a defined recovery, approved on the fast track. Payments run through 4 Oct.' }),
  light({ id: 'D-26-074021', family: 'disability', product: 'Disability income', name: 'Nora Lindqvist', ownerId: 'priya', team: 'DI Team 1', facts: ['Last worked 19 Sep 2026', 'DI-1904417 · $7,500 / month', 'Phone intake today'], stageAt: 0, status: { label: 'New', tone: 'info' }, lineName: 'Disability income', ref: 'DI-1904417', amount: 7_500, next: { label: 'Triage new claim', reason: 'Filed by phone today', section: 'overview' }, summary: 'Filed by phone today. Surgery booked for 2 Oct; the 90-day elimination period ends 20 Dec.' }),
  light({ id: 'D-26-052218', family: 'disability', product: 'Disability income', name: 'Thomas Reilly', ownerId: 'dmitri', facts: ['Denied 17 Jun 2026', 'DI-1908855 · own occupation', 'Reconsideration and DOI complaint open'], stageAt: 2, status: { label: 'Reconsideration', tone: 'special' }, lineName: 'Disability income', ref: 'DI-1908855', amount: 7_150, next: { label: 'Send complaint response', reason: 'Due to the Department of Insurance by 30 Sep', section: 'history' }, due: '2026-09-30', tags: [{ label: 'DOI complaint', tone: 'critical' }], summary: 'Denied in June. His attorney asked for reconsideration on 20 Aug and a Department of Insurance complaint arrived on 9 Sep.' }),
  light({ id: 'D-26-060751', family: 'disability', product: 'Disability income', name: 'Kevin Marsh', ownerId: 'dmitri', facts: ['Claims total disability since Apr 2026', 'DI-2101983', 'SIU referral open'], stageAt: 2, status: { label: 'Investigation', tone: 'critical' }, lineName: 'Disability income', ref: 'DI-2101983', amount: 4_800, next: { label: 'Restricted', reason: 'Special investigations has this claim', section: 'overview' }, tags: [{ label: 'Restricted', tone: 'critical' }], summary: 'Access is restricted while special investigations reviews a report of work during the claim.' }),
]

export const CLAIMS: Claim[] = [...FULL, ...LIGHT]
