import type { DecisionRecord } from '../types'
import type { RecordContext } from '../replay'

// Owned by the History screen.

/**
 * Decision records kept outside the decisions collection. Thomas Reilly's claim is a light record in
 * the mock, but its history is the key screen, so its locked denial lives here.
 */
export const EXTRA_RECORDS: DecisionRecord[] = [
  {
    id: 'd-bell-boe-1', claimId: 'D-25-018334', benefitLineId: 'bl-bell-boe', title: 'Business overhead expense BE-1310777', version: 1,
    recordedAt: '2025-03-14T11:00', recordedBy: 'Jordan Ellis', authorityNote: 'within DI authority',
    outcome: 'approved', outcomeText: 'Approved · covered business expenses from Jan 2025, up to 18 months',
    basis: 'Totally disabled from his own occupation since 2 Dec 2024; the business stays open and has covered fixed expenses. Superseded by v2 at the 18-month maximum.',
    evidence: ['BOE claim form', 'Business expense schedule', 'APS · Dr. Castillo'],
    provisions: ['BOE §2 Covered expenses', '§3 Maximum benefit period'], approvals: [],
    letter: 'Approval · 14 Mar 2025',
  },
  {
    id: 'd-reilly-1', claimId: 'D-26-052218', benefitLineId: 'bl-D-26-052218', title: 'Disability income', version: 1,
    recordedAt: '2026-06-17T16:05', recordedBy: 'Dmitri Novak', authorityNote: 'within DI examiner authority',
    outcome: 'denied', outcomeText: 'Denied — does not meet the policy’s definition of total disability in his own occupation',
    basis: 'The APS and the occupational-medicine peer review support restrictions that still allow the material duties of his sedentary, high-cognitive-demand occupation.',
    evidence: ['Peer review · occupational medicine', 'APS · Dr. Farah Nasser', 'Occupational duties questionnaire', 'Claimant statement', 'Symptom diary'],
    provisions: ['DI-1908855 §1 Total disability — own occupation'],
    approvals: ['Second review: Anita Brooks, 17 Jun 15:48 · approved'],
    letter: 'Sent 17 Jun 16:30 by mail and portal · opened 18 Jun',
    assistantNote: 'Drafted letter summary v2, edited by examiner. No AI recommendation on the outcome.',
  },
]

/** What the replay shows beside each record: evidence fingerprints and the rules in force when it was recorded. */
export const RECORD_CONTEXT: Record<string, RecordContext> = {
  'd-reilly-1': {
    evidence: [
      { label: 'Peer review · occupational medicine', hash: 'a41f…9c', date: '2026-06-11' },
      { label: 'APS · Dr. Farah Nasser', hash: '7d20…e4', date: '2026-05-30' },
      { label: 'Occupational duties questionnaire', hash: '3b9e…01', date: '2026-04-12' },
      { label: 'Claimant statement', hash: 'c58a…7f', date: '2026-04-03' },
      { label: 'Symptom diary', hash: '90d1…b2', date: '2026-05-20' },
    ],
    rules: [
      ['Policy', 'DI-1908855 (form DI-19, state variation) — definition of total disability, own occupation'],
      ['Claims guideline', 'CG-DI-07 v3.2'],
      ['Letter template', 'ADV-DI-01 v5'],
    ],
    reviews: ['Second review: Anita Brooks, 17 Jun 15:48 · approved'],
  },
  'd-okafor-wl-1': {
    evidence: [
      { label: 'Death certificate', hash: 'e2c7…41', date: '2026-07-24' },
      { label: 'Policy record', hash: '5a0b…d3', date: '2026-07-22' },
      { label: 'Loan statement', hash: 'b916…0e', date: '2026-09-08' },
    ],
    rules: [
      ['Policy', 'LP-1219044 (form WL-11) — §4 Death benefit, §8 Policy loans'],
      ['Claims guideline', 'CG-L-02 v4.1 · minors’ shares held for a custodian'],
      ['Letter template', 'LTR-L-101 v3'],
    ],
    reviews: ['None required — within $250,000 authority'],
  },
  'd-whitman-1': {
    evidence: [
      { label: 'Death certificate', hash: '17fe…a8', date: '2026-08-28' },
      { label: 'Policy record', hash: 'c03d…52', date: '2026-09-02' },
      { label: 'Designation', hash: '8e44…9b', date: '2016-05-02' },
    ],
    rules: [
      ['Policy', 'UL-0988214 (form UL-03) — §6 Death benefit option A'],
      ['Claims guideline', 'CG-L-02 v4.1 · authority table AT-7'],
      ['Letter template', 'LTR-L-101 v3'],
    ],
    reviews: ['Approval above authority: Monica Reyes, 25 Sep 08:50 · approved'],
  },
  'd-bell-di-1': {
    evidence: [
      { label: 'APS · Dr. Castillo', hash: '4c19…f0', date: '2025-05-12' },
      { label: 'Operative report', hash: 'd8a2…37', date: '2025-02-24' },
      { label: 'Duties questionnaire', hash: '61b5…ce', date: '2025-01-06' },
      { label: 'Financial review', hash: '0f7e…22', date: '2025-05-20' },
    ],
    rules: [
      ['Policy', 'DI-1310776 (form DI-13) — §2 Total disability, own occupation; §5 Elimination period'],
      ['Claims guideline', 'CG-DI-07 v3.0'],
      ['Letter template', 'APR-DI-01 v4'],
    ],
    reviews: ['None required — approval within DI authority'],
  },
  'd-bell-boe-1': {
    evidence: [
      { label: 'BOE claim form', hash: '3e71…a0', date: '2025-01-06' },
      { label: 'Business expense schedule', hash: 'c4d2…19', date: '2025-02-10' },
      { label: 'APS · Dr. Castillo', hash: '8b06…f4', date: '2025-01-06' },
    ],
    rules: [
      ['Policy', 'BE-1310777 (form BE-13) — BOE §2 Covered expenses, §3 Maximum benefit period'],
      ['Claims guideline', 'CG-DI-11 v2.0'],
      ['Letter template', 'APR-DI-05 v2'],
    ],
    reviews: ['None required — approval within DI authority'],
  },
  'd-bell-boe-2': {
    evidence: [{ label: 'BOE ledger', hash: '9a3c…6d', date: '2026-06-30' }],
    rules: [
      ['Policy', 'BE-1310777 — BOE §3 Maximum benefit period (18 months)'],
      ['Claims guideline', 'CG-DI-11 v2.1'],
      ['Letter template', 'CLS-DI-04 v2'],
    ],
    reviews: ['None required — closure at contractual maximum'],
  },
  'd-hart-1': {
    evidence: [
      { label: 'Death certificate', hash: '2b8d…e9', date: '2026-09-09' },
      { label: 'Contract VA-2201946', hash: 'f510…3a', date: '2026-09-05' },
      { label: 'GMDB rider', hash: '7ce2…14', date: '2026-09-05' },
      { label: 'Beneficiary designation', hash: 'a0d9…c7', date: '2015-02-14' },
    ],
    rules: [
      ['Contract', 'VA-2201946 — §7 Death benefit; GMDB rider §2 highest anniversary'],
      ['Claims guideline', 'CG-A-03 v2.0 · each share valued on its good-order date'],
      ['Letter template', 'LTR-A-201 v2'],
    ],
    reviews: ['None required — within $750,000 authority'],
  },
}

/** Claim-level notes shown with the history: holds that stop purging or in-place edits. */
export const HISTORY_HOLDS: Record<string, string> = {
  'D-26-052218': 'Litigation hold since 21 Aug. Nothing on this claim can be purged or edited in place.',
}
