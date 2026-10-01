import type { LifeIntakeContext } from '../lifeIntake'

/*
 * What policy administration returns for the life phone intake: Diane Castellano-Reyes calls to report
 * that her father, Robert Castellano, died at home on 19 Sep 2026. People and numbers are fictional.
 */
export const CASTELLANO_INTAKE: LifeIntakeContext = {
  claimId: 'L-26-043310',
  call: { inbound: '(555) 017-3308', started: '10:02', elapsed: 95, language: 'English' },
  caller: {
    name: 'Diane Castellano-Reyes',
    phone: '(555) 017-3308',
    email: 'diane.reyes@example.com',
    address: '2217 Ridgeview Drive, Duluth, MN 55803',
  },
  insured: {
    name: 'Robert Castellano',
    dob: '1955-02-11',
    ssnLast4: '4417',
    address: '88 Harbor Lane, Two Harbors, MN 55616',
    state: 'MN',
  },
  agent: { name: 'Paul Hendricks', agency: 'Hendricks Financial Group' },
  policies: [
    {
      ref: 'WL-0804419',
      product: 'Whole life',
      issued: '2008-05-12',
      paidTo: '2026-11-12',
      faceAmount: 200_000,
      inForce: true,
      riders: [{ key: 'adb', name: 'Accidental death benefit', amount: 200_000 }],
      owner: 'Robert Castellano',
      source: 'Policy record WL-0804419',
    },
    {
      ref: 'TL-1105530',
      product: 'Term life, 10-year',
      issued: '2011-03-14',
      paidTo: '2019-03-14',
      faceAmount: 150_000,
      inForce: false,
      lapsed: '2019-03-14',
      riders: [],
      owner: 'Robert Castellano',
      source: 'Policy record TL-1105530',
    },
  ],
  designation: {
    date: '2015-03-03',
    source: 'Beneficiary designation · 3 Mar 2015',
    beneficiaries: [
      {
        id: 'b-linda',
        name: 'Linda Castellano',
        relationship: 'Spouse',
        kind: 'primary',
        share: 100,
        died: '2021-06-02',
        diedSource: 'On file · her claim L-21-011872',
      },
      { id: 'b-diane', name: 'Diane Castellano-Reyes', relationship: 'Daughter', kind: 'contingent', share: 50, dob: '1982-07-30' },
      { id: 'b-mark', name: 'Mark Castellano', relationship: 'Son', kind: 'contingent', share: 50, dob: '1985-11-04' },
    ],
  },
}

/** Mark's details, which Diane gives on the call — the mock's "fill sample answers". */
export const MARK_CONTACT = { phone: '(555) 019-2201', email: 'mark.castellano@example.com', address: '410 Pine Street, Apt 3, Saint Paul, MN 55102' }
