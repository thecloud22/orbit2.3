import type { IntakeContext } from '../intake'

/*
 * What policy administration returns for the phone intake on board 04.2: Nora Lindqvist, a nurse
 * anesthetist, age 38, calling about her disability income policy. People and numbers are fictional.
 */
export const LINDQVIST_INTAKE: IntakeContext = {
  claimId: 'D-26-074021',
  call: {
    inbound: '(555) 014-2291',
    started: '09:41',
    /** Seconds already on the call when the page opens — the board shows 06:42. */
    elapsed: 402,
    language: 'English',
  },
  person: {
    name: 'Nora Lindqvist',
    dob: '1988-03-14',
    zip: '55408',
    ssnLast4: '6038',
    address: '14 Linden Court, Minneapolis, MN 55408',
    phone: '(555) 014-2291',
    email: 'nora.lindqvist@example.com',
    occupation: 'Nurse anesthetist (CRNA)',
    roles: 'Insured and owner',
  },
  agent: { name: 'Paul Hendricks', agency: 'Hendricks Financial Group', email: 'paul@hendricksfinancial.example' },
  policies: [
    {
      ref: 'DI-1904417',
      product: 'Disability income',
      family: 'disability',
      status: { label: 'In force', tone: 'positive' },
      issued: '2019-06-01',
      paidTo: '2026-10-01',
      monthlyBenefit: 7_500,
      eliminationDays: 90,
      definition: 'Own occupation to 65',
      riders: ['Residual disability', 'Cost-of-living adjustment'],
      summary: '$7,500/month · 90-day elimination · own occupation to 65 · residual and COLA riders · premium paid to 1 Oct',
      source: 'Policy record DI-1904417',
    },
    {
      ref: 'LP-1904418',
      product: 'Term life',
      family: 'life',
      status: { label: 'Not triggered', tone: 'neutral' },
      issued: '2019-06-01',
      paidTo: '2026-10-01',
      faceAmount: 1_000_000,
      riders: ['Waiver of premium'],
      waiverAfterMonths: 6,
      summary: '$1,000,000 · waiver of premium rider starts after 6 months of disability',
      source: 'Policy record LP-1904418',
    },
  ],
  premiumPayer: 'Nora, personally, with after-tax money',
  eftOnFile: 'First Lakes Credit Union · checking ending 0917',
}
