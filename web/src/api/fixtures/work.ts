import type { WorkItem } from '../types'

/** Work items, ordered by clock risk then impact — the same logic that picks each claim's next step. */
export const WORK_ITEMS: WorkItem[] = [
  // ---------------------------------------------------------------- Rachel Kim — life examiner
  { id: 'w-r1', ownerId: 'rachel', claimId: 'L-26-036554', priority: 1, action: 'Decide term life — evidence complete', why: 'State decision deadline in 2 days', due: '2026-09-27', waitingOn: 'You', section: 'decision', views: ['atRisk', 'readyToDecide'], status: 'open',
    whyNext: 'Every requirement is in and the state decision deadline is Sunday. Deciding today keeps the claim inside the limit and stops interest growing.' },
  { id: 'w-r2', ownerId: 'rachel', claimId: 'L-26-035120', priority: 1, action: 'Update beneficiary on payment timing', why: 'Approved 08:52 · held for sanctions screening', due: '2026-09-25', dueNote: 'by 17:00', flag: { label: 'Held', tone: 'critical' }, waitingOn: 'Payments', section: 'communications', views: ['dueToday', 'atRisk'], status: 'open',
    whyNext: 'Robert Whitman expects payment after this morning’s approval. Payments is holding it for a screening check, so he should hear from you today why it will take a little longer.' },
  { id: 'w-r3', ownerId: 'rachel', claimId: 'L-26-038907', priority: 2, action: 'Send custodian packet', why: '$72,090 held for two minor beneficiaries', due: '2026-09-25', dueNote: 'interest', flag: { label: '2', tone: 'caution' }, waitingOn: 'You', section: 'communications', views: ['dueToday'], status: 'open',
    whyNext: 'Adaeze asked this morning whether she needs a lawyer to be the custodian. The packet answers her and starts the release of the children’s $72,090, which earns interest while held.' },
  { id: 'w-r4', ownerId: 'rachel', claimId: 'L-26-040112', priority: 2, action: 'Decide term life — fast track', why: 'All requirements met · no exceptions', due: '2026-10-03', waitingOn: 'You', section: 'decision', views: ['readyToDecide'], status: 'open',
    whyNext: 'Every requirement arrived by 23 Sep and all fast-track rules passed. Deciding now pays Margaret before the state deadline of 3 Oct and stops interest growing.' },
  { id: 'w-r5', ownerId: 'rachel', claimId: 'L-26-038907', priority: 2, action: 'Review toxicology report', why: 'New document · accidental death rider', due: '2026-10-09', flag: { label: '2', tone: 'caution' }, waitingOn: 'You', section: 'documents', views: ['newDocuments'], status: 'open',
    whyNext: 'The coroner’s toxicology arrived at 08:05. It bears on the intoxication exclusion of the accidental death rider.' },
  { id: 'w-r6', ownerId: 'rachel', claimId: 'L-26-031145', priority: 2, action: 'Evaluate competing beneficiary claim', why: 'Former spouse cites a 2019 divorce decree', due: '2026-10-14', flag: { label: 'Dispute', tone: 'special' }, waitingOn: 'You', section: 'documents', views: [], status: 'open',
    whyNext: 'Two people claim the same proceeds. Legal may need to file an interpleader if the decree governs.' },
  { id: 'w-r7', ownerId: 'rachel', claimId: 'L-26-042877', priority: 3, action: 'Find beneficiaries — death-record match', why: 'Matched 12 Sep · no claim filed yet', due: '2026-10-12', dueNote: 'outreach', waitingOn: 'You', section: 'people', views: [], status: 'open',
    whyNext: 'State unclaimed-property rules require outreach to beneficiaries after a death-record match.' },
  { id: 'w-r8', ownerId: 'rachel', claimId: 'L-26-041577', priority: 3, action: 'Review terminal-illness certification', why: 'Accelerated benefit rider · form received', due: '2026-10-02', waitingOn: 'You', section: 'documents', views: ['newDocuments'], status: 'open' },
  { id: 'w-r9', ownerId: 'rachel', claimId: 'L-26-039870', priority: 3, action: 'Second request: apostilled certificate', why: 'Death abroad · first request 21 days ago', due: '2026-09-30', waitingOn: 'Beneficiary', section: 'requirements', views: ['waiting'], status: 'open' },
  { id: 'w-r10', ownerId: 'rachel', claimId: 'L-26-037711', priority: 3, action: 'Return beneficiary’s call', why: 'Voicemail 09:12 · asks about the 1099-INT', due: '2026-09-25', dueNote: '1 day', waitingOn: 'You', section: 'communications', views: ['dueToday'], status: 'open' },
  { id: 'w-r11', ownerId: 'rachel', claimId: 'L-25-022918', priority: 3, action: 'Annual waiver-of-premium review', why: 'Proof of continued disability requested 1 Sep', due: '2026-10-01', waitingOn: 'Insured', section: 'requirements', views: ['waiting'], status: 'open' },

  // ---------------------------------------------------------------- Jordan Ellis — DI case manager
  { id: 'w-j1', ownerId: 'jordan', claimId: 'D-26-073390', priority: 1, action: 'Call Dr. Hsu’s office', why: 'Physician statement 9 days late · 2 reminders sent', due: '2026-09-25', flag: { label: '2', tone: 'caution' }, waitingOn: 'You', section: 'requirements', views: ['dueToday', 'atRisk'], status: 'open',
    whyNext: 'The attending physician statement is 30 days outstanding and the decision can’t be made without it. A call today can be noted in the 24 Oct status letter if it is still missing.' },
  { id: 'w-j2', ownerId: 'jordan', claimId: 'D-25-018334', priority: 2, action: 'Review APS update', why: 'Received today · feeds the 14 Oct skills analysis', due: '2026-09-30', waitingOn: 'You', section: 'documents', views: ['newDocuments'], status: 'open',
    whyNext: 'Dr. Castillo’s quarterly statement arrived at 08:31 with changed sitting tolerance and a permanent prognosis. Accepting it renews proof of loss to 21 Dec and updates the restrictions Chris Duarte uses on 14 Oct.' },
  { id: 'w-j3', ownerId: 'jordan', claimId: 'D-26-073390', priority: 2, action: 'Request P&L and 2024 return from accountant', why: 'Residual benefit can’t be calculated without them', due: '2026-09-29', waitingOn: 'Elena', section: 'requirements', views: ['waiting'], status: 'open' },
  { id: 'w-j4', ownerId: 'jordan', claimId: 'D-25-029116', priority: 2, action: 'Review recurrent disability', why: 'Same condition within 6 months of return to work', due: '2026-10-02', waitingOn: 'You', section: 'overview', views: [], status: 'open' },
  { id: 'w-j5', ownerId: 'jordan', claimId: 'D-26-071245', priority: 3, action: 'Confirm return-to-work date', why: 'Expected back Mon 5 Oct · last payment prorated', due: '2026-10-05', waitingOn: 'Claimant', section: 'payments', views: ['waiting'], status: 'open' },
  { id: 'w-j6', ownerId: 'jordan', claimId: 'D-25-018334', priority: 3, action: 'Draft any-occupation transition notice', why: 'Transition review opens 1 Dec', due: '2026-11-01', waitingOn: 'You', section: 'case-plan', views: [], status: 'open' },

  // ---------------------------------------------------------------- Irene Walsh — annuity specialist
  { id: 'w-i1', ownerId: 'irene', claimId: 'A-26-015530', priority: 2, action: 'Follow up with Claire', why: 'Claimant statement and W-9 missing 17 days', due: '2026-09-28', flag: { label: '1', tone: 'caution' }, waitingOn: 'Claire', section: 'requirements', views: ['waiting'], status: 'open',
    whyNext: 'Claire’s half stays invested and moves with the market until her forms arrive. A reminder with the options guide, or help from her agent, can close the gap.' },
  { id: 'w-i2', ownerId: 'irene', claimId: 'A-19-004418', priority: 2, action: 'Set up survivor payments and recover', why: '2 payments after death · $2,840 net to recover', due: '2026-09-30', flag: { label: 'Recovery', tone: 'caution' }, waitingOn: 'You', section: 'payments', views: ['atRisk'], status: 'open',
    whyNext: 'Ruth Ellison is owed survivor payments from 1 Aug. Offsetting the two full payments made after George’s death leaves $2,840 to recover — kindly, from future payments rather than a demand.' },
  { id: 'w-i3', ownerId: 'irene', claimId: 'A-26-016204', priority: 3, action: 'Waiting on team lead approval', why: '$860,000 · above your $750,000 authority', due: '2026-10-01', waitingOn: 'Monica Reyes', section: 'decision', views: ['waiting'], status: 'open' },

  // ---------------------------------------------------------------- Monica Reyes — team lead
  { id: 'w-m1', ownerId: 'monica', claimId: 'L-26-042210', priority: 1, action: 'Approve payout above authority', why: 'Leon Park · $512,500 · limit $250,000', due: '2026-09-25', waitingOn: 'You', section: 'decision', views: ['dueToday'], status: 'open' },
  { id: 'w-m2', ownerId: 'monica', claimId: 'A-26-016204', priority: 1, action: 'Approve death benefit above authority', why: 'Irene Walsh · $860,000 · limit $750,000', due: '2026-09-25', waitingOn: 'You', section: 'decision', views: ['dueToday'], status: 'open' },
  { id: 'w-m3', ownerId: 'monica', claimId: 'L-26-038115', priority: 2, action: 'Second review of denial', why: 'Suicide exclusion within 2 years', due: '2026-09-28', waitingOn: 'You', section: 'decision', views: [], status: 'open' },
  { id: 'w-m4', ownerId: 'monica', claimId: 'L-26-039870', priority: 3, action: 'Approve consular report instead of apostille', why: 'Rachel Kim · death abroad', due: '2026-09-29', waitingOn: 'You', section: 'requirements', views: [], status: 'open' },
  { id: 'w-m5', ownerId: 'monica', claimId: 'L-26-029984', priority: 3, action: 'Approve close without payment', why: 'Sofia Marin · beneficiary unlocatable', due: '2026-10-02', waitingOn: 'You', section: 'decision', views: [], status: 'open' },
]
