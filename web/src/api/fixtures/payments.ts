import type { PaymentProfile, PaymentRow } from '../payments'

// Owned by the Payments screen. Seeded with what other screens reference.

// ---------------------------------------------------------------- Bell — monthly DI, 3% simple COLA from 1 Jun 2026
// Jun 2025 – Dec 2026: 16 paid, Oct and Nov scheduled, Dec waits on proof of loss.
const BELL_MONTHS: string[] = Array.from({ length: 19 }, (_, i) => {
  const m = 5 + i // months since Jan 2025, zero-based
  return `${2025 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`
})
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const period = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

const BELL: PaymentRow[] = BELL_MONTHS.map((d) => {
  const cola = d >= '2026-06-01' ? 195 : 0
  const paid = d <= '2026-09-01'
  const status: PaymentRow['status'] = paid
    ? { label: 'Cleared', tone: 'positive' }
    : d === '2026-12-01'
      ? { label: 'Needs proof of loss', tone: 'caution' }
      : { label: 'Scheduled', tone: 'info' }
  return {
    id: `pay-bell-${d.slice(0, 7)}`, claimId: 'D-25-018334', benefitLineId: 'bl-bell-di', period: period(d), payDate: d,
    payee: 'Marcus Bell', basis: cola ? 'Monthly benefit + COLA' : 'Monthly benefit', amount: 6_500 + cola, gross: 6_500, cola,
    method: 'EFT ••2290', status, note: d === '2026-12-01' ? 'valid to 30 Nov' : undefined,
  }
})

// BOE reimbursements, Jan 2025 – Jun 2026, capped at $8,000 a month.
const BOE_AMOUNTS = [6_980, 7_420, 7_150, 7_010, 7_390, 6_875, 7_240, 7_115, 7_060, 7_305, 6_990, 7_180, 7_275, 7_040, 7_210, 6_955, 7_340]
const BOE_LEDGER: [string, number][] = [...BOE_AMOUNTS, 128_640 - BOE_AMOUNTS.reduce((a, b) => a + b, 0)].map((amt, i) => {
  const y = 2025 + Math.floor(i / 12)
  return [`${MON[i % 12]} ${y}`, amt]
})

export const PAYMENTS: PaymentRow[] = [
  { id: 'pay-okafor-1', claimId: 'L-26-038907', benefitLineId: 'bl-okafor-wl', payDate: '2026-09-19', payee: 'Adaeze Okafor', basis: 'Beneficiary 50% + interest', amount: 72_090, method: 'EFT ••1180', status: { label: 'Paid 19 Sep', tone: 'positive' } },
  { id: 'pay-okafor-2', claimId: 'L-26-038907', benefitLineId: 'bl-okafor-wl', payDate: '2026-09-19', payee: 'Chidi and Amara Okafor', basis: 'Beneficiaries 25% each · held for custodian', amount: 72_090, method: '—', status: { label: 'Held · minors', tone: 'caution' }, note: 'interest accruing' },
  { id: 'pay-whitman-1', claimId: 'L-26-035120', benefitLineId: 'bl-whitman-ul', payDate: '2026-09-25', payee: 'Robert Whitman', basis: 'Beneficiary 100%', amount: 436_000, method: 'EFT ••6620', status: { label: 'Held · sanctions screening', tone: 'critical' } },
  { id: 'pay-whitman-2', claimId: 'L-26-035120', benefitLineId: 'bl-whitman-ul', payDate: '2026-09-25', payee: 'Robert Whitman', basis: 'Interest 3.25% · 21 Aug–25 Sep', amount: 1_358.83, method: 'EFT ••6620', status: { label: 'Held · sanctions screening', tone: 'critical' }, note: 'grows $38.82 a day' },
  { id: 'pay-hart-1', claimId: 'A-26-015530', benefitLineId: 'bl-hart-db', payDate: '2026-09-26', payee: 'Nathan Hart', basis: 'Lump sum · 50% share, less 10% federal withholding on the gain', amount: 314_750, gross: 327_500, withheld: 12_750, method: 'EFT ••0931', status: { label: 'Scheduled', tone: 'info' } },
  ...BELL,
  // Priya Raman — approved through 4 Oct; one final payment, prorated
  { id: 'pay-raman-1', claimId: 'D-26-071245', benefitLineId: 'bl-D-26-071245', period: '7 Sep – 4 Oct', payDate: '2026-10-06', payee: 'Priya Raman', basis: 'Final payment · prorated 28 of 30 days', amount: 8_400, gross: 9_000, method: 'EFT ••5512', status: { label: 'Scheduled', tone: 'info' }, note: 'final' },
  // George Ellison — joint & survivor income annuity; two payments after death
  { id: 'pay-ellison-jun', claimId: 'A-19-004418', benefitLineId: 'bl-A-19-004418', period: 'Jun 2026', payDate: '2026-06-01', payee: 'George Ellison', basis: 'Joint & survivor · 100%', amount: 2_840, method: 'EFT ••3318', status: { label: 'Cleared', tone: 'positive' } },
  { id: 'pay-ellison-jul', claimId: 'A-19-004418', benefitLineId: 'bl-A-19-004418', period: 'Jul 2026', payDate: '2026-07-01', payee: 'George Ellison', basis: 'Joint & survivor · 100%', amount: 2_840, method: 'EFT ••3318', status: { label: 'Cleared', tone: 'positive' } },
  { id: 'pay-ellison-aug', claimId: 'A-19-004418', benefitLineId: 'bl-A-19-004418', period: 'Aug 2026', payDate: '2026-08-01', payee: 'George Ellison', basis: 'Paid after death · $1,420.00 owed to Ruth', amount: 2_840, method: 'EFT ••3318', status: { label: 'Paid after death', tone: 'caution' } },
  { id: 'pay-ellison-sep', claimId: 'A-19-004418', benefitLineId: 'bl-A-19-004418', period: 'Sep 2026', payDate: '2026-09-01', payee: 'George Ellison', basis: 'Paid after death · $1,420.00 owed to Ruth', amount: 2_840, method: 'EFT ••3318', status: { label: 'Paid after death', tone: 'caution' } },
  { id: 'pay-ellison-oct', claimId: 'A-19-004418', benefitLineId: 'bl-A-19-004418', period: 'Oct 2026', payDate: '2026-10-01', payee: 'George Ellison', basis: 'Joint & survivor · 100%', amount: 2_840, method: 'EFT ••3318', status: { label: 'Stopped 20 Sep', tone: 'neutral' }, note: 'death-record match' },
]

// ---------------------------------------------------------------- Per-claim payment profiles

const pass = (label: string, note?: string) => ({ label, note, pass: true })

export const PAYMENT_PROFILES: Record<string, PaymentProfile> = {
  'D-25-018334': {
    claimId: 'D-25-018334',
    subtitle: 'Disability income · paid on the 1st',
    tiles: [
      { label: 'Monthly benefit', value: '$6,695.00', note: '3% COLA from 1 Jun 2026' },
      { label: 'Tax withheld', value: '$0.00', note: 'Tax-free · premiums paid personally' },
      { label: 'Next payment', value: '', compute: 'nextPayment' },
      { label: 'Paid to date', value: '', compute: 'paidToDate' },
      { label: 'Premiums waived', value: 'DI and life', note: 'Since 1 Jun 2025' },
    ],
    calculation: {
      title: 'Benefit calculation',
      aside: 'Per month · from 1 Jun 2026',
      rows: [
        { label: 'Policy monthly benefit', source: 'Policy schedule', amount: '$6,500.00' },
        { op: '+', label: 'COLA 3% simple, from 1 Jun 2026', source: 'COLA rider', amount: '$195.00' },
        { op: '=', label: 'Monthly benefit', amount: '$6,695.00', strong: true },
        { op: '−', label: 'Offsets', detail: '— none: individual policy, no Social Security offset', amount: '$0.00' },
        { op: '−', label: 'Deductions', detail: '— none', amount: '$0.00' },
        { op: '=', label: 'Net payment', source: 'No tax withheld', amount: '$6,695.00', strong: true },
      ],
    },
    chart: {
      title: 'Monthly benefit over time',
      points: [
        { from: '2025-06-01', amount: 6_500 },
        { from: '2026-06-01', amount: 6_695 },
        { from: '2027-06-01', amount: 6_890, projected: true },
      ],
      end: '2027-09-01',
      note: 'Assumes benefits continue after 1 Jun 2027.',
    },
    related: [
      {
        name: 'Business overhead expense',
        ref: 'BE-1310777',
        status: { label: 'Closed · maximum reached', tone: 'positive' },
        summary: '18 of 18 months paid · Jan 2025 – Jun 2026 · $128,640.00 reimbursed · closed at maximum 30 Jun 2026',
        description: 'Reimbursed covered business expenses such as rent, staff wages and utilities, up to $8,000.00 a month.',
        ledger: BOE_LEDGER,
      },
    ],
    schedule: { aside: 'First payment at risk, the next payment and the last 5 paid', columns: 'di', recent: 5 },
    release: {
      controls: [
        pass('Recurring payment within authority'),
        pass('Payee screening', 'monthly re-screen 24 Sep'),
        pass('Proof of loss current to 30 Nov'),
        pass('No open investigation or reconsideration'),
        pass('Bank details unchanged for 90+ days'),
      ],
      footTitle: 'Releases automatically on 1 Oct',
      footNote: '$6,695.00 by EFT · held if a control fails',
    },
    payeeTax: [
      ['Payee', 'Marcus Bell'],
      ['Method', 'EFT ••2290 · verified 12 Jun 2025'],
      ['Withholding', 'None'],
      ['Tax form', 'None — benefits from personally paid premiums are generally not taxable'],
    ],
    suggestion: {
      id: 's-bell-cola', group: 'next', category: 'COLA',
      title: 'Confirm the 1 Jun 2027 COLA increase to $6,890.00',
      body: 'The rider adds 3% of the original $6,500.00 each 1 June while benefits continue.',
      sources: ['COLA rider · DI-1310776'], primary: 'Accept', creates: 'Confirm 1 Jun 2027 COLA increase to $6,890.00', state: 'open',
    },
    actions: ['oneTime', 'adjust', 'overpayment'],
  },

  'L-26-035120': {
    claimId: 'L-26-035120',
    subtitle: 'Universal life · one-time proceeds with interest',
    tiles: [
      { label: 'Death benefit', value: '$436,000.00', note: 'Approved 25 Sep · with Monica Reyes' },
      { label: 'Interest to date', value: '$1,358.83', note: '3.25% from 21 Aug · $38.82 a day' },
      { label: 'Held', value: '$437,358.83', note: 'Since 09:01 · sanctions screening' },
      { label: 'Payee', value: 'Robert Whitman', note: 'Husband · 100% · EFT ••6620' },
      { label: 'State payment limit', value: '27 Oct', note: 'Interest keeps running until paid' },
    ],
    holds: [
      {
        id: 'hold-whitman', tone: 'critical',
        title: 'Payment held — possible sanctions-list name match',
        detail: 'Robert Whitman’s name is similar to an entry on a sanctions list. Payments is confirming his identity before release. Date of birth and country don’t match the entry, so it looks like a false positive — but that is Payments’ call, and a second person must agree.',
        amount: 437_358.83,
        facts: [
          ['Screening case', 'SCR-26-09417 · detected 09:01'],
          ['Match', 'Name only · 86% similar · date of birth and country differ'],
          ['Reviewer', 'Tessa Lin, Payments specialist'],
          ['Needed by', 'Today’s 16:00 run · clears after 15:30 go Mon 28 Sep'],
        ],
        steps: [
          { label: 'Approved', detail: 'Rachel Kim with Monica Reyes · 08:52', state: 'done' },
          { label: 'Screening flagged a name match', detail: '09:01 · payment held automatically', state: 'done' },
          { label: 'Tessa Lin compares identity details', detail: 'Date of birth, country, address', state: 'current' },
          { label: 'Lauren Pike confirms as second person', detail: 'Sanctions clears need a second person', state: 'todo' },
          { label: 'Released in the next payment run', detail: 'Today 16:00 if cleared by 15:30', state: 'todo' },
        ],
        contact: { name: 'Lauren Pike', title: 'Payments lead', note: 'Confirms the clear; can say when the EFT will go' },
        interest: 'Interest at 3.25% a year keeps adding to Robert’s payment — $38.82 a day — until it is paid. Nothing is lost by the hold.',
        action: { label: 'Tell Robert', section: 'communications', target: 'LTR-L-140' },
      },
    ],
    schedule: { aside: 'Death benefit and interest go out as one EFT', columns: 'basic' },
    release: {
      controls: [
        pass('Above examiner authority — approved by Monica Reyes', '08:50'),
        { label: 'Payee screening', note: 'possible name match · held', pass: false },
        pass('Proof of death verified'),
        pass('No open investigation or reconsideration'),
        pass('Bank details verified by call-back', '28 Aug'),
      ],
      footTitle: 'Held until screening clears',
      footNote: '$437,358.83 by EFT · interest added to the release date',
    },
    payeeTax: [
      ['Payee', 'Robert Whitman · husband · 100%'],
      ['Method', 'EFT ••6620 · verified 28 Aug'],
      ['Withholding', 'None'],
      ['Tax form', '1099-INT for the interest by 31 Jan 2027; the death benefit itself is not taxable'],
    ],
    actions: ['oneTime'],
  },

  'L-26-038907': {
    claimId: 'L-26-038907',
    subtitle: 'Individual life · each benefit line pays on its own decision',
    tiles: [
      { label: 'Whole life', value: '$144,180.00', note: 'After $18,300 loan · approved 18 Sep' },
      { label: 'Paid', value: '$72,090.00', note: 'Adaeze · 19 Sep · EFT ••1180' },
      { label: 'Held for minors', value: '$72,090.00', note: 'Chidi and Amara · interest accruing' },
      { label: 'Not decided', value: '$750,000.00', note: 'Term life and rider · contestable review' },
    ],
    holds: [
      {
        id: 'hold-okafor-minors', tone: 'caution',
        title: 'Children’s shares held for a custodian',
        detail: 'Chidi and Amara are minors, so their whole life shares can’t be paid to them directly. The money is released to a custodian named under the state’s Uniform Transfers to Minors Act, or to a court-appointed guardian of the estate.',
        amount: 72_090,
        facts: [
          ['Chidi Okafor', 'Son · 12 · 25% · $36,045.00'],
          ['Amara Okafor', 'Daughter · 9 · 25% · $36,045.00'],
          ['Held since', '19 Sep, when Adaeze’s half was paid'],
          ['Releases on', 'Signed UTMA custodian form, or a court order'],
        ],
        steps: [
          { label: 'Shares held', detail: '19 Sep · with interest', state: 'done' },
          { label: 'Custodian packet sent to Adaeze', detail: 'LTR-L-131 · UTMA form prefilled', state: 'current' },
          { label: 'Adaeze returns the form or a court order', state: 'todo' },
          { label: 'Payments releases to the custodian', detail: 'With interest to the release date', state: 'todo' },
        ],
        interest: 'Interest at 3.25% a year accrues on the held $72,090.00 from 19 Sep — about $6.42 a day — and is paid with the release.',
        action: { label: 'Send custodian packet', section: 'communications', target: 'LTR-L-131' },
      },
    ],
    pending: [
      { payee: 'Term life, 20-year · LP-2511086', basis: 'Waits on the contestable review, due 9 Oct', amount: '$500,000.00', status: { label: 'Not decided', tone: 'neutral' } },
      { payee: 'Accidental death rider', basis: 'Follows the term life outcome and the coroner', amount: '$250,000.00', status: { label: 'Not decided', tone: 'neutral' } },
    ],
    schedule: { aside: 'Whole life LP-1219044 · 50% / 25% / 25%', columns: 'basic' },
    payeeTax: [
      ['Adaeze', 'EFT ••1180 · verified 18 Sep'],
      ['Children', 'Payee is the custodian, once named'],
      ['Withholding', 'None'],
      ['Tax form', '1099-INT for interest to each payee by 31 Jan 2027'],
    ],
    actions: ['oneTime', 'overpayment'],
  },

  'A-26-015530': {
    claimId: 'A-26-015530',
    subtitle: 'Variable annuity death benefit · each share paid separately',
    tiles: [
      { label: 'Death benefit', value: '$655,000.00', note: 'GMDB · two shares of 50%' },
      { label: 'Nathan · net', value: '$314,750.00', note: 'Lump sum · pays 26 Sep' },
      { label: 'Federal withholding', value: '$12,750.00', note: '10% of Nathan’s $127,500.00 gain' },
      { label: 'Claire’s share', value: 'at least $327,500.00', note: 'Valued when in good order' },
    ],
    pending: [
      { payee: 'Claire Hart-Lopez', basis: '50% share · election not made · claimant statement and W-9 missing', amount: 'at least $327,500.00', status: { label: 'Waiting on good order', tone: 'caution' } },
    ],
    schedule: { aside: 'Nathan’s lump sum · Claire’s share pays after she elects', columns: 'lump' },
    release: {
      controls: [
        pass('Within authority', 'Irene Walsh · $750,000'),
        pass('Payee screening', 'clear 22 Sep'),
        pass('Nathan’s claim in good order', '22 Sep'),
        pass('W-9 and W-4R on file'),
        pass('Bank details verified by call-back', '22 Sep'),
      ],
      footTitle: 'Releases on 26 Sep',
      footNote: '$314,750.00 to Nathan by EFT · held if a control fails',
    },
    payeeTax: [
      ['Payee', 'Nathan Hart · son · 50%'],
      ['Method', 'EFT ••0931 · verified 22 Sep'],
      ['Withholding', '10% federal on the gain · W-4R default'],
      ['Tax form', '1099-R for 2026 · distribution code 4 (death)'],
    ],
    taxNotes: [
      'Only the gain is taxable: each share’s $127,500.00 over its $200,000.00 cost basis, as ordinary income.',
      'No 10% early-distribution penalty applies to payments made because of the owner’s death.',
    ],
    actions: ['oneTime', 'overpayment'],
  },

  'L-26-040112': {
    claimId: 'L-26-040112',
    subtitle: 'Term life · one-time proceeds',
    special: 'fastTrack',
    tiles: [
      { label: 'Death benefit', value: '$150,000.00', note: 'LP-1107752 · 20-year term' },
      { label: 'Interest', value: '$373.97', note: '3.25% · 29 Aug–26 Sep' },
      { label: 'Next payment', value: '', compute: 'nextPayment' },
      { label: 'Paid to date', value: '', compute: 'paidToDate' },
    ],
    schedule: { aside: 'One EFT per payee · Margaret’s three lines combined', columns: 'basic' },
    release: {
      controls: [
        pass('Within authority', '$250,000'),
        pass('Payee screening', 'both clear 25 Sep 07:02'),
        pass('Assignment matches the invoice', '$9,850.00'),
        pass('W-9 on file for Margaret'),
        pass('Bank details confirmed on the call', '3 Sep'),
      ],
      footTitle: 'Releases on 26 Sep',
      footNote: 'Two EFTs · held if a control fails',
    },
    payeeTax: [
      ['Margaret', 'EFT ••4471 · beneficiary remainder, interest and premium refund'],
      ['Linden Grove', 'EFT ••2210 · assignment $9,850.00'],
      ['Withholding', 'None'],
      ['Tax form', '1099-INT for $373.97 interest to Margaret by 31 Jan 2027'],
    ],
    actions: ['oneTime', 'overpayment'],
  },

  'D-26-071245': {
    claimId: 'D-26-071245',
    subtitle: 'Disability income · paid monthly in arrears on the 6th',
    special: 'returnToWork',
    tiles: [
      { label: 'Monthly benefit', value: '$9,000.00', note: 'Own occupation · DI-2004117' },
      { label: 'Approved through', value: '4 Oct', note: 'Expected back Mon 5 Oct' },
      { label: 'Final payment', value: '$8,400.00', note: '6 Oct · 28 of 30 days' },
      { label: 'Paid to date', value: '', compute: 'paidToDate' },
    ],
    calculation: {
      title: 'Final payment',
      aside: 'Period 7 Sep – 4 Oct',
      rows: [
        { label: 'Monthly benefit', source: 'Policy schedule', amount: '$9,000.00' },
        { op: '×', label: 'Days disabled in the period', detail: '— 7 Sep to 4 Oct', amount: '28 / 30' },
        { op: '=', label: 'Prorated benefit', amount: '$8,400.00', strong: true },
        { op: '−', label: 'Offsets and deductions', detail: '— none', amount: '$0.00' },
        { op: '=', label: 'Net payment', source: 'No tax withheld', amount: '$8,400.00', strong: true },
      ],
    },
    schedule: { aside: 'Elimination period satisfied 6 Sep · one prorated payment', columns: 'basic' },
    release: {
      controls: [
        pass('Within authority'),
        pass('Payee screening', 'clear 3 Sep'),
        pass('Proof of loss current', 'APS 2 Sep'),
        { label: 'Return-to-work date confirmed', note: 'needed for the final amount', pass: false },
        pass('Bank details verified', '3 Sep'),
      ],
      footTitle: 'Releases on 6 Oct',
      footNote: '$8,400.00 by EFT · held if a control fails',
    },
    payeeTax: [
      ['Payee', 'Priya Raman'],
      ['Method', 'EFT ••5512 · verified 3 Sep'],
      ['Withholding', 'None'],
      ['Tax form', 'None — premiums paid personally'],
    ],
    actions: ['oneTime', 'adjust', 'overpayment'],
  },

  'A-19-004418': {
    claimId: 'A-19-004418',
    subtitle: 'Income annuity · joint & survivor 100% / 50% · paid on the 1st',
    special: 'survivor',
    tiles: [
      { label: 'Joint payment', value: '$2,840.00', note: 'To George · since 1 Mar 2019' },
      { label: 'Survivor benefit', value: '$1,420.00', note: 'Ruth · 50% from 1 Aug' },
      { label: 'Paid after death', value: '$5,680.00', note: '1 Aug and 1 Sep' },
      { label: 'Net to recover', value: '$2,840.00', note: 'After the $2,840.00 owed to Ruth' },
    ],
    survivor: {
      contract: [
        ['Contract', 'IA-1904418 · joint & survivor 100% / 50%'],
        ['Payment', '$2,840.00 a month since 1 Mar 2019'],
        ['Survivor', 'Ruth Ellison, spouse · joint annuitant · 50% survivor benefit'],
      ],
      events: [
        ['18 Jul', 'George died'],
        ['1 Aug, 1 Sep', '$2,840.00 paid on each date'],
        ['20 Sep', 'Found by a death-record match; October payment stopped'],
        ['22 Sep', 'Ruth sent his death certificate'],
      ],
      calc: [
        { label: 'Paid after death', detail: '· 2 × $2,840.00', amount: '$5,680.00' },
        { op: '−', label: 'Owed to Ruth', detail: '· 2 × $1,420.00', amount: '$2,840.00' },
        { op: '=', label: 'Overpaid', amount: '$2,840.00', strong: true },
      ],
      plans: [
        { id: 'offset', label: 'Offset $710.00 from Ruth’s next 4 payments — needs her agreement', detail: 'She would receive $710.00 a month from October to January, then $1,420.00.' },
        { id: 'bank', label: 'Ask the bank to return the two payments', detail: 'Reclaims $5,680.00 from George’s account; Ruth is then paid the $2,840.00 she is owed.' },
        { id: 'check', label: 'Ruth repays by check', detail: 'She sends $2,840.00; her $1,420.00 a month starts in full.' },
      ],
      whenRecorded: ['George’s payments stop', 'Ruth’s $1,420.00 a month starts 1 Oct', 'A corrected 1099-R goes out for 2026'],
    },
    schedule: { aside: 'George’s payments, then Ruth’s survivor payments once set up', columns: 'basic' },
    payeeTax: [
      ['Payee', 'Ruth Ellison, from 1 Oct'],
      ['Method', 'EFT ••3318 · joint account, confirmed 22 Sep'],
      ['Withholding', 'Per Ruth’s W-4P on file · none elected'],
      ['Tax form', 'Corrected 2026 1099-R for George; Ruth’s own 1099-R from 2026'],
    ],
    actions: ['oneTime', 'overpayment'],
  },
}
