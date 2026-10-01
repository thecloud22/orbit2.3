import type { AgentClientOverlay, PortalAsk, UploadSpec } from '../portal'

/*
 * Portal-only data: plain-language copy and figures the external portal shows that the staff
 * fixtures don't carry. Owned by the portal. The mock's today is Fri 25 Sep 2026.
 */

/** Used only if the requirements collection has nothing for Elena's claim yet. */
export const ELENA_FALLBACK_ASKS: PortalAsk[] = [
  {
    id: 'doctor',
    kind: 'doctor',
    title: 'Help us get your doctor’s statement',
    body: 'Dr. Grace Hsu’s office hasn’t sent it yet.',
    requirementIds: [],
  },
  {
    id: 'financials',
    kind: 'upload',
    title: 'Upload your 2024 tax return and monthly profit and loss statements since June',
    body: 'Your accountant or your agent, Paul Hendricks, can send them with your permission.',
    requirementIds: [],
  },
]

/** What each upload screen asks for. Keyed by the ask id. */
export const UPLOADS: Record<string, UploadSpec> = {
  financials: {
    key: 'financials',
    title: 'Upload your 2024 tax return and profit and loss statements',
    why: 'Hugo Brenner, our financial analyst, uses them to work out your partial benefit while you work two days a week. We can’t calculate it without them.',
    slots: [
      {
        id: 'tax',
        label: '2024 tax return',
        hint: 'Your full federal return, with all schedules',
        docTitle: '2024 federal tax return',
        docType: 'Tax return',
        sampleName: '2024-Form-1040-Vasquez.pdf',
        pages: 14,
        pageText: ['Form 1040 · 2024', 'Elena M. Vasquez', 'Schedule C — Vasquez Family Dentistry', 'Net profit from business'],
      },
      {
        id: 'pl',
        label: 'Monthly profit and loss, June to August',
        hint: 'One file per month is fine, or one for all three',
        docTitle: 'Practice P&L, Jun–Aug 2026',
        docType: 'Profit and loss statement',
        sampleName: 'Vasquez-Family-Dentistry-PL-Jun-Aug-2026.pdf',
        pages: 3,
        pageText: ['Vasquez Family Dentistry', 'Profit and loss · June, July, August 2026', 'Production · Collections · Expenses · Net'],
      },
    ],
  },
  'visit-notes': {
    key: 'visit-notes',
    title: 'Upload visit notes you already have',
    why: 'Notes from your visits with Dr. Hsu can help our clinical team while we wait for her statement. Photos are fine.',
    slots: [
      {
        id: 'notes',
        label: 'Visit notes',
        hint: 'After-visit summaries, letters or test results',
        docTitle: 'Visit notes from Elena Vasquez',
        docType: 'Medical records',
        sampleName: 'After-visit-summary-Lakeside-Rheumatology.jpg',
        pages: 2,
        pageText: ['Lakeside Rheumatology Associates', 'After-visit summary'],
      },
    ],
  },
}

/** Priya Raman's DI payments as she sees them (board 07.4). */
export const PRIYA = {
  claimId: 'D-26-071245',
  account: '7788',
  monthly: 9_000,
  approvedThrough: '2026-10-04',
  returnDate: '2026-10-05',
  submitted: '2026-08-10',
  approved: '2026-08-21',
  next: { amount: 8_400, payDate: '2026-10-06', period: '7 Sep–4 Oct', days: '28 of 30 days', tax: 0 },
  paid: [{ id: 'p1', payDate: '2026-09-08', amount: 9_000, period: '7 Aug–6 Sep' }],
}

/** Margaret Pierce's payment breakdown (board 07.6). The total and account come from the live payment once scheduled. */
export const PIERCE = {
  claimId: 'L-26-040112',
  decideBy: '2026-10-03',
  submitted: '2026-09-03',
  allReceived: '2026-09-23',
  payDate: '2026-09-26',
  account: '4471',
  total: 140_592.37,
  lines: [
    { label: 'Life insurance benefit', amount: 150_000 },
    { label: 'Paid to Linden Grove Funeral Home (your assignment)', amount: -9_850 },
    { label: 'Interest from 29 Aug', amount: 373.97 },
    { label: 'Refund of September’s premium', amount: 68.4 },
  ],
  interest: 373.97,
}

/** Claire Hart-Lopez's share of her mother's annuity (board 07.8). */
export const HART = {
  claimId: 'A-26-015530',
  beneficiary: 'Claire Hart-Lopez',
  guaranteed: 327_500,
  marketToday: 306_950,
  gain: 127_500,
  total: 655_000,
  marketOn22Sep: 306_200,
  notified: '2026-09-05',
  lifeExpectancyBy: '2027-09-03',
  fiveYearBy: '2031-09-03',
}

/** Claims shared with the agent outside the claim's party list (e.g. by phone at intake). */
export const AGENT_EXTRA_CONSENTS: { claimId: string; client: string; consent: string }[] = [
  { claimId: 'D-26-074021', client: 'Nora Lindqvist', consent: 'By phone · she shared it with you' },
]

/** Plain-language rows for the agent portal (board 07.7). Live data overrides these where it exists. */
export const AGENT_OVERLAY: Record<string, AgentClientOverlay> = {
  'A-26-015530': {
    order: 1, client: 'Evelyn Hart', deceased: true, ref: 'VA-2201946', product: 'Variable annuity death benefit', since: '2026-09-03',
    status: { label: 'Claire’s share not in good order', tone: 'caution' }, statusNote: 'Nathan’s payment goes out 26 Sep',
    needed: '3 forms from Claire', action: 'Help Claire choose',
  },
  'D-26-073390': {
    order: 2, client: 'Elena Vasquez', ref: 'DI-1507791', product: 'Disability income', since: '2026-06-12',
    status: { label: 'Waiting on documents', tone: 'caution' }, statusNote: 'Next status letter by 24 Oct',
    needed: '2024 tax return and monthly P&L', action: 'Send documents', actionNote: 'with her consent',
  },
  'D-26-074021': {
    order: 3, client: 'Nora Lindqvist', ref: 'DI-1904417', product: 'Disability income', since: '2026-09-21',
    status: { label: 'Filed 25 Sep', tone: 'info' }, statusNote: 'By phone · she shared it with you',
    needed: 'Nothing from you', action: 'None',
  },
  'L-26-038907': {
    order: 4, client: 'Daniel Okafor', deceased: true, ref: '2 policies', product: 'Individual life', since: '2026-07-14',
    status: { label: '1 of 3 benefits paid', tone: 'info' }, statusNote: 'Others still in review',
    needed: 'A custodian for the children’s shares', action: 'Family may ask about custodian forms',
  },
  'L-26-040112': {
    order: 5, client: 'Harold Pierce', deceased: true, ref: 'LP-1107752', product: 'Term life', since: '2026-08-29',
    status: { label: 'In review', tone: 'neutral' }, statusNote: 'Decision by 3 Oct',
    needed: 'Nothing', action: 'None',
  },
}

export const AGENT_UPDATES: { at: string; client: string; text: string }[] = [
  { at: '2026-09-25', client: 'Nora Lindqvist', text: 'Filed a disability income claim by phone and shared it with you.' },
  { at: '2026-09-24', client: 'Elena Vasquez', text: 'Status letter sent to Elena. The next one is due by 24 Oct.' },
  { at: '2026-09-22', client: 'Evelyn Hart', text: 'Nathan Hart’s claim is in good order. Claire’s is still open.' },
]
