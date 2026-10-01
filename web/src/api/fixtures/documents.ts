import type { DocumentRecord } from '../documents'

// Owned by the Documents screen. Newest first within each claim.
//
// pageText is the mock's stand-in for page images. One line per printed line, pages split by '=== n'.
// Markup the viewer understands:
//   @head left | right        form header          @meta k: v | k: v    patient strip
//   # Heading | aside         section heading      || a | b | c         table header row
//   | a | b | c               table row            ~ signature | date   signature line
//   _ caption | caption       caption under a rule [x] / [ ]           check boxes
//   {n} at the start of a cell or line marks the area extracted as field n (1-based, in list order).

const accepted = { label: 'Accepted', tone: 'positive' as const }
const needsReview = { label: 'Needs review', tone: 'info' as const }

const BELL_APS: string[] = [
  '=== 1',
  '@head [Carrier] · Attending physician statement | Page 1 of 3',
  '@meta Patient: Marcus Bell | Date of birth: 14 Mar 1974 | Claim: D-25-018334',
  '# 1. Patient and occupation',
  'Occupation: Owner-operator, Bell Freight & Logistics — drove, loaded, dispatched',
  'Last worked: 1 Dec 2024',
  '# 2. Physician',
  'Owen Castillo, MD · Orthopedic spine surgery · Castillo Spine & Orthopedics',
  'Treating since 9 Dec 2024 · seen every 3 months',
  '# 3. Diagnosis | ICD-10',
  '{1}Primary: M51.36 Lumbar disc degeneration · Secondary: Z98.1 Arthrodesis (fusion) status',
  'Surgery: L4–L5 posterior lumbar fusion, 11 Feb 2025',
  '# 4. Current treatment',
  'Home exercise program; gabapentin 300 mg three times a day; pain management every 8 weeks',
  'Most recent visit: 22 Sep 2026',
  '=== 2',
  '@head [Carrier] · Attending physician statement | Page 2 of 3',
  '@meta Patient: Marcus Bell | Date of birth: 14 Mar 1974 | Claim: D-25-018334',
  '# 5. Physical capacities | in an 8-hour workday',
  '|| Activity | At one time | Total per day',
  '| Lift / carry | {2}10 lb occasionally | ',
  '| Sit | {3}30 min at a time | {4}4 hrs per day',
  '| Stand | {5}15 min | {5}',
  '| Walk | {5}15 min | {5}Total stand/walk 2 hrs',
  '| Bend / twist / crouch | {6}Never | {6}',
  '| Ladders | {6}Never | {6}',
  '# 6. Prognosis',
  '{7}[x] Permanent restrictions      [ ] Temporary — until ________',
  '{7}Maximum medical improvement reached:   [x] Yes   [ ] No',
  '{8}Next appointment: 12 Dec 2026',
  '~ {9}O. Castillo, MD | {9}22 Sep 2026',
  '_ Physician signature · Owen Castillo, MD | Date',
  '=== 3',
  '@head [Carrier] · Attending physician statement | Page 3 of 3',
  '@meta Patient: Marcus Bell | Date of birth: 14 Mar 1974 | Claim: D-25-018334',
  '# 7. Remarks',
  'Sitting tolerance is better since June with pain management. He should change position every 30 minutes.',
  'He cannot return to driving, loading or dock work. Restrictions are permanent.',
  '# 8. Office contact',
  'Records: Priya Shah · phone (555) 010-3190 · fax (555) 010-3191',
  '[x] I certify the information above is accurate to the best of my knowledge.',
]

const OKAFOR_TOX: string[] = [
  '=== 1',
  '@head Ashford County Office of the Coroner · Toxicology report | Page 1 of 3',
  '@meta Decedent: Daniel Okafor | Date of death: 14 Jul 2026 | Case: ACC-26-0714-3',
  '# Specimens received',
  '|| Specimen | Collected | Condition',
  '| Femoral blood | {3}15 Jul 2026 · autopsy | Sealed, intact',
  '| Vitreous humor | {3}15 Jul 2026 · autopsy | Sealed, intact',
  '| Urine | {3}15 Jul 2026 · autopsy | Sealed, intact',
  '# Testing laboratory',
  '{4}Midstate Forensic Toxicology Laboratory · ANAB accredited, certificate FT-2231',
  'Requested by: Dr. L. Mensah, deputy coroner · received at lab 17 Jul 2026',
  '=== 2',
  '@head Ashford County Office of the Coroner · Toxicology report | Page 2 of 3',
  '@meta Decedent: Daniel Okafor | Date of death: 14 Jul 2026 | Case: ACC-26-0714-3',
  '# Results',
  '|| Analyte | Specimen | Result',
  '| Ethanol | Femoral blood | {1}None detected (< 0.010 g/dL)',
  '| Ethanol | Vitreous humor | {1}None detected',
  '| Comprehensive drug screen, LC-MS/MS | Femoral blood | {2}None detected',
  '| Immunoassay panel, 9 classes | Urine | {2}Negative',
  '| Carbon monoxide | Femoral blood | < 5% saturation',
  '# Interpretation',
  'No ethanol or drugs of abuse were detected at or above the reporting limits on page 3.',
  '~ {5}H. Osei, PhD, F-ABFT | {5}21 Sep 2026',
  '_ Forensic toxicologist · Helen Osei, PhD | Date',
  '=== 3',
  '@head Ashford County Office of the Coroner · Toxicology report | Page 3 of 3',
  '@meta Decedent: Daniel Okafor | Date of death: 14 Jul 2026 | Case: ACC-26-0714-3',
  '# Methods and reporting limits',
  '|| Method | Scope | Limit',
  '| Headspace GC-FID | Ethanol, volatiles | 0.010 g/dL',
  '| LC-MS/MS | 300+ drugs and metabolites | Varies by compound',
  '| Immunoassay | 9 drug classes | Screening cut-offs',
  'Results relate only to the specimens received. Chain of custody on file.',
]

const LANG_FOREIGN: string[] = [
  '=== 1',
  '@head República Portuguesa · Certidão de óbito | Page 1 of 2',
  '@meta Name: Beatrice Lang | Date of death: 20 Jul 2026 | Registry: Lisboa 3',
  '# Registo de óbito',
  'Place of death: Hospital de Santa Maria, Lisboa',
  'Cause: as certified by the attending physician',
  '# Apostille',
  '[ ] Apostille (Hague Convention of 5 Oct 1961) — not attached',
]

export const DOCUMENTS: DocumentRecord[] = [
  // ---------------------------------------------------------------- Pierce L-26-040112 — 7, all accepted
  { id: 'doc-pierce-4', claimId: 'L-26-040112', title: 'Funeral home invoice', docType: 'Invoice', from: 'Linden Grove Funeral Home', received: '2026-09-23T10:05', channel: 'Fax', pages: 1, isNew: false, status: accepted, satisfies: 'Funeral home invoice', requirementId: 'req-pierce-4', classifiedAs: { label: 'Invoice', confidence: 97 }, matches: 'Insured’s name and date of death' },
  { id: 'doc-pierce-1', claimId: 'L-26-040112', title: 'Certified death certificate', docType: 'Death certificate', from: 'Margaret Pierce', received: '2026-09-03T11:20', channel: 'Portal', pages: 1, isNew: false, status: accepted, satisfies: 'Certified death certificate', requirementId: 'req-pierce-2', classifiedAs: { label: 'Death certificate', confidence: 99 }, matches: 'Name, date of birth and SSN' },
  { id: 'doc-pierce-2', claimId: 'L-26-040112', title: 'Claimant statement — Margaret Pierce', docType: 'Claimant statement', from: 'Margaret Pierce', received: '2026-09-03T11:20', channel: 'Portal', pages: 3, isNew: false, status: accepted, satisfies: 'Claimant statement', requirementId: 'req-pierce-1', classifiedAs: { label: 'Claimant statement', confidence: 99 }, matches: 'Policy number and insured’s name' },
  { id: 'doc-pierce-3', claimId: 'L-26-040112', title: 'Assignment to Linden Grove Funeral Home', docType: 'Assignment', from: 'Linden Grove Funeral Home', received: '2026-09-03T11:20', channel: 'Portal', pages: 2, isNew: false, status: accepted, satisfies: 'Funeral home assignment', requirementId: 'req-pierce-3', classifiedAs: { label: 'Funeral assignment', confidence: 96 }, matches: 'Policy number and beneficiary signature' },
  { id: 'doc-pierce-5', claimId: 'L-26-040112', title: 'IRS Form W-9 — Margaret Pierce', docType: 'Tax form', from: 'Margaret Pierce', received: '2026-09-03T11:20', channel: 'Portal', pages: 1, isNew: false, status: accepted, satisfies: 'IRS Form W-9', requirementId: 'req-pierce-5', classifiedAs: { label: 'W-9', confidence: 99 }, matches: 'Beneficiary name and TIN' },
  { id: 'doc-pierce-6', claimId: 'L-26-040112', title: 'Policy record LP-1107752', docType: 'Policy record', from: 'Policy administration', received: '2026-09-03T09:02', channel: 'Internal', pages: 14, isNew: false, status: accepted, classifiedAs: { label: 'Policy record', confidence: 100 }, matches: 'Policy number' },
  { id: 'doc-pierce-7', claimId: 'L-26-040112', title: 'Premium history 2011–2026', docType: 'Premium history', from: 'Policy administration', received: '2026-09-03T09:02', channel: 'Internal', pages: 2, isNew: false, status: accepted, classifiedAs: { label: 'Premium history', confidence: 100 }, matches: 'Policy number' },

  // ---------------------------------------------------------------- Okafor L-26-038907
  {
    id: 'doc-okafor-tox', claimId: 'L-26-038907', title: 'Toxicology report — Ashford County Coroner', docType: 'Toxicology report', from: 'Ashford County Coroner',
    received: '2026-09-25T08:05', channel: 'Fax', pages: 3, isNew: true, status: needsReview, benefitLineId: 'bl-okafor-adb',
    satisfies: 'Toxicology report', requirementId: 'req-okafor-tox',
    classifiedAs: { label: 'Toxicology report', confidence: 98 }, matches: 'Name, date of death and coroner case number', readAt: '08:06',
    ifAccepted: 'Accidental death rider → toxicology is on file: no alcohol or drugs, so the intoxication exclusion is not supported · the rider still waits on the coroner’s final report · this review leaves your queue.',
    extracted: [
      { id: 'f1', label: 'Alcohol', value: 'None detected · blood < 0.010 g/dL', source: 'p.2 · results 1–2', confidence: 'high', change: 'Bears on the intoxication exclusion', state: 'proposed' },
      { id: 'f2', label: 'Drugs', value: 'None detected · comprehensive screen', source: 'p.2 · results 3–4', confidence: 'high', change: 'Bears on the intoxication exclusion', state: 'proposed' },
      { id: 'f3', label: 'Specimens collected', value: '15 Jul 2026 · at autopsy', source: 'p.1 · specimens', confidence: 'high', state: 'proposed' },
      { id: 'f4', label: 'Laboratory', value: 'Midstate Forensic Toxicology Laboratory', source: 'p.1 · laboratory', confidence: 'high', state: 'proposed' },
      { id: 'f5', label: 'Signed', value: 'H. Osei, PhD, forensic toxicologist · 21 Sep 2026', source: 'p.2 · signature', confidence: 'high', state: 'proposed' },
    ],
    pageText: OKAFOR_TOX,
  },
  { id: 'doc-okafor-prelim', claimId: 'L-26-038907', title: 'Preliminary coroner’s report', docType: 'Coroner’s report', from: 'Ashford County Coroner', received: '2026-08-14T13:40', channel: 'Fax', pages: 4, isNew: false, status: accepted, benefitLineId: 'bl-okafor-adb', classifiedAs: { label: 'Coroner’s report', confidence: 95 }, matches: 'Name, date of death and coroner case number' },
  { id: 'doc-okafor-police', claimId: 'L-26-038907', title: 'Police accident report', docType: 'Police report', from: 'Ashford County Sheriff', received: '2026-08-06T10:12', channel: 'Mail scan', pages: 7, isNew: false, status: accepted, benefitLineId: 'bl-okafor-adb', satisfies: 'Police accident report', requirementId: 'req-okafor-police', classifiedAs: { label: 'Police report', confidence: 97 }, matches: 'Name and date of the accident' },
  { id: 'doc-okafor-rx', claimId: 'L-26-038907', title: 'Pharmacy history 2019–2026', docType: 'Pharmacy history', from: 'Pharmacy data', received: '2026-07-30T06:00', channel: 'Pharmacy data', pages: 3, isNew: false, status: accepted, benefitLineId: 'bl-okafor-term', satisfies: 'Pharmacy history', requirementId: 'req-okafor-rx', classifiedAs: { label: 'Pharmacy history', confidence: 100 }, matches: 'Name and date of birth' },
  { id: 'doc-okafor-auth', claimId: 'L-26-038907', title: 'Authorization to release medical information', docType: 'Authorization', from: 'Adaeze Okafor', received: '2026-07-29T19:22', channel: 'E-signature', pages: 2, isNew: false, status: accepted, benefitLineId: 'bl-okafor-term', satisfies: 'Authorization to release medical information', requirementId: 'req-okafor-auth', classifiedAs: { label: 'HIPAA authorization', confidence: 99 }, matches: 'Claim number and signer' },
  { id: 'doc-okafor-app', claimId: 'L-26-038907', title: 'Application and underwriting file, 2025', docType: 'Application', from: 'Underwriting', received: '2026-07-28T09:15', channel: 'Internal', pages: 12, isNew: false, status: accepted, benefitLineId: 'bl-okafor-term', classifiedAs: { label: 'Application', confidence: 100 }, matches: 'Policy number' },
  { id: 'doc-okafor-cs', claimId: 'L-26-038907', title: 'Claimant statement — Adaeze Okafor', docType: 'Claimant statement', from: 'Adaeze Okafor', received: '2026-07-24T16:48', channel: 'Portal', pages: 4, isNew: false, status: accepted, satisfies: 'Claimant statement', requirementId: 'req-okafor-cs', classifiedAs: { label: 'Claimant statement', confidence: 99 }, matches: 'Both policy numbers and insured’s name' },
  { id: 'doc-okafor-dc', claimId: 'L-26-038907', title: 'Certified death certificate', docType: 'Death certificate', from: 'Adaeze Okafor', received: '2026-07-24T16:48', channel: 'Portal', pages: 1, isNew: false, status: accepted, satisfies: 'Certified death certificate', requirementId: 'req-okafor-dc', classifiedAs: { label: 'Death certificate', confidence: 99 }, matches: 'Name, date of birth and SSN' },
  { id: 'doc-okafor-w9', claimId: 'L-26-038907', title: 'IRS Form W-9 — Adaeze Okafor', docType: 'Tax form', from: 'Adaeze Okafor', received: '2026-07-24T16:48', channel: 'Portal', pages: 1, isNew: false, status: accepted, satisfies: 'IRS Form W-9 — Adaeze Okafor', requirementId: 'req-okafor-w9', classifiedAs: { label: 'W-9', confidence: 99 }, matches: 'Beneficiary name and TIN' },

  // ---------------------------------------------------------------- Whitman L-26-035120
  { id: 'doc-whit-id', claimId: 'L-26-035120', title: 'Driver’s licence — Robert Whitman', docType: 'Identity document', from: 'Robert Whitman', received: '2026-09-04T12:30', channel: 'Mail scan', pages: 1, isNew: false, status: accepted, satisfies: 'Proof of identity', requirementId: 'req-whit-id', classifiedAs: { label: 'Identity document', confidence: 94 }, matches: 'Beneficiary name and address' },
  { id: 'doc-whit-w9', claimId: 'L-26-035120', title: 'IRS Form W-9 — Robert Whitman', docType: 'Tax form', from: 'Robert Whitman', received: '2026-09-04T12:30', channel: 'Mail scan', pages: 1, isNew: false, status: accepted, satisfies: 'IRS Form W-9', requirementId: 'req-whit-w9', classifiedAs: { label: 'W-9', confidence: 98 }, matches: 'Beneficiary name and TIN' },
  { id: 'doc-whit-ul', claimId: 'L-26-035120', title: 'Policy value statement at 21 Aug', docType: 'Policy record', from: 'Policy administration', received: '2026-08-29T07:00', channel: 'Internal', pages: 3, isNew: false, status: accepted, satisfies: 'Policy value statement at death', requirementId: 'req-whit-ul', classifiedAs: { label: 'Policy value statement', confidence: 100 }, matches: 'Policy number' },
  { id: 'doc-whit-cs', claimId: 'L-26-035120', title: 'Claimant statement — Robert Whitman', docType: 'Claimant statement', from: 'Robert Whitman', received: '2026-08-28T15:10', channel: 'Mail scan', pages: 3, isNew: false, status: accepted, satisfies: 'Claimant statement', requirementId: 'req-whit-cs', classifiedAs: { label: 'Claimant statement', confidence: 97 }, matches: 'Policy number and insured’s name' },
  { id: 'doc-whit-dc', claimId: 'L-26-035120', title: 'Certified death certificate', docType: 'Death certificate', from: 'Robert Whitman', received: '2026-08-28T15:10', channel: 'Mail scan', pages: 1, isNew: false, status: accepted, satisfies: 'Certified death certificate', requirementId: 'req-whit-dc', classifiedAs: { label: 'Death certificate', confidence: 99 }, matches: 'Name, date of birth and SSN' },

  // ---------------------------------------------------------------- Vasquez D-26-073390 — 8
  { id: 'doc-vas-2025', claimId: 'D-26-073390', title: '2025 tax return — Form 1040 and 1120-S', docType: 'Tax return', from: 'Elena Vasquez', received: '2026-09-03T21:14', channel: 'Portal', pages: 22, isNew: false, status: accepted, satisfies: '2025 tax return', requirementId: 'req-vas-2025', classifiedAs: { label: 'Tax return', confidence: 98 }, matches: 'Name and SSN' },
  { id: 'doc-vas-odq', claimId: 'D-26-073390', title: 'Occupational duties questionnaire', docType: 'Questionnaire', from: 'Elena Vasquez', received: '2026-09-02T18:40', channel: 'Portal', pages: 4, isNew: false, status: accepted, satisfies: 'Occupational duties questionnaire', requirementId: 'req-vas-odq', classifiedAs: { label: 'Duties questionnaire', confidence: 99 }, matches: 'Claim number' },
  { id: 'doc-vas-sched', claimId: 'D-26-073390', title: 'Practice appointment schedule, Jun–Aug', docType: 'Business record', from: 'Elena Vasquez', received: '2026-09-02T18:40', channel: 'Portal', pages: 3, isNew: false, status: accepted, classifiedAs: { label: 'Business record', confidence: 88 }, matches: 'Claim number' },
  { id: 'doc-vas-rx', claimId: 'D-26-073390', title: 'Pharmacy history 2021–2026', docType: 'Pharmacy history', from: 'Pharmacy data', received: '2026-08-27T06:00', channel: 'Pharmacy data', pages: 2, isNew: false, status: accepted, satisfies: 'Pharmacy history', requirementId: 'req-vas-rx', classifiedAs: { label: 'Pharmacy history', confidence: 100 }, matches: 'Name and date of birth' },
  { id: 'doc-vas-cs', claimId: 'D-26-073390', title: 'Claimant statement — Elena Vasquez', docType: 'Claimant statement', from: 'Elena Vasquez', received: '2026-08-25T14:02', channel: 'Portal', pages: 6, isNew: false, status: accepted, satisfies: 'Claimant statement', requirementId: 'req-vas-cs', classifiedAs: { label: 'Claimant statement', confidence: 99 }, matches: 'Policy number and date of birth' },
  { id: 'doc-vas-auth', claimId: 'D-26-073390', title: 'Authorization to release information', docType: 'Authorization', from: 'Elena Vasquez', received: '2026-08-25T14:05', channel: 'E-signature', pages: 2, isNew: false, status: accepted, satisfies: 'Authorization to release information', requirementId: 'req-vas-auth', classifiedAs: { label: 'HIPAA and financial authorization', confidence: 99 }, matches: 'Claim number and signer' },
  { id: 'doc-vas-policy', claimId: 'D-26-073390', title: 'Policy record DI-1507791', docType: 'Policy record', from: 'Policy administration', received: '2026-08-25T09:00', channel: 'Internal', pages: 16, isNew: false, status: accepted, classifiedAs: { label: 'Policy record', confidence: 100 }, matches: 'Policy number' },
  { id: 'doc-vas-notice', claimId: 'D-26-073390', title: 'Notice of claim — agent Paul Hendricks', docType: 'Notice of claim', from: 'Paul Hendricks', received: '2026-08-24T16:30', channel: 'Agent portal', pages: 1, isNew: false, status: accepted, classifiedAs: { label: 'Notice of claim', confidence: 95 }, matches: 'Policy number' },

  // ---------------------------------------------------------------- Bell D-25-018334 — 8
  {
    id: 'doc-bell-aps', claimId: 'D-25-018334', title: 'Attending physician statement — Dr. Owen Castillo', docType: 'Attending physician statement', from: 'Dr. Owen Castillo',
    received: '2026-09-25T08:31', channel: 'Provider portal', pages: 3, isNew: true, status: needsReview, benefitLineId: 'bl-bell-di',
    satisfies: 'Quarterly APS update', requirementId: 'req-bell-aps',
    classifiedAs: { label: 'Attending physician statement', confidence: 99 }, matches: 'Name, date of birth and claim number', readAt: '08:32', compareWith: 'the June APS',
    ifAccepted: 'Medical → restrictions update to version 7 · proof of loss is renewed to 21 Dec · Sam Whitaker, RN (open referral) and Chris Duarte, CRC (skills analysis 14 Oct) are notified.',
    handoff: { label: 'Send to nurse', to: 'Sam Whitaker, RN', task: 'Nurse review: APS of 22 Sep — sitting tolerance and prognosis' },
    extracted: [
      { id: 'f1', label: 'Diagnosis', value: 'M51.36 lumbar disc degeneration; Z98.1 fusion status', source: 'p.1 · box 3', confidence: 'high', change: 'No change', state: 'proposed' },
      { id: 'f2', label: 'Lift / carry', value: '10 lb occasionally', source: 'p.2 · box 5a', confidence: 'high', change: 'No change', state: 'proposed' },
      { id: 'f3', label: 'Sit at a time', value: '30 min', source: 'p.2 · box 5b', confidence: 'high', change: 'Was 20 min ↑', state: 'proposed' },
      { id: 'f4', label: 'Sit per day', value: '4 h', source: 'p.2 · box 5b', confidence: 'low', handwritten: true, change: 'Was 3 h ↑', state: 'proposed' },
      { id: 'f5', label: 'Stand / walk', value: '15 min each, 2 h total', source: 'p.2 · box 5c–d', confidence: 'high', change: 'No change', state: 'proposed' },
      { id: 'f6', label: 'Postural', value: 'Never bend, twist, crouch; no ladders', source: 'p.2 · box 5e–f', confidence: 'high', change: 'No change', state: 'proposed' },
      { id: 'f7', label: 'Prognosis', value: 'Permanent restrictions, MMI reached', source: 'p.2 · box 6a', confidence: 'high', change: 'Was: re-evaluate in 3 months', state: 'proposed' },
      { id: 'f8', label: 'Next visit', value: '12 Dec 2026', source: 'p.2 · box 6c', confidence: 'high', state: 'proposed' },
      { id: 'f9', label: 'Signed', value: 'O. Castillo, MD · 22 Sep 2026', source: 'p.2 · signature', confidence: 'high', change: 'Dates the proof of loss', state: 'proposed' },
    ],
    pageText: BELL_APS,
  },
  { id: 'doc-bell-voc', claimId: 'D-25-018334', title: 'Vocational questionnaire', docType: 'Questionnaire', from: 'Marcus Bell', received: '2026-09-18T20:11', channel: 'Portal', pages: 5, isNew: false, status: accepted, benefitLineId: 'bl-bell-di', satisfies: 'Vocational questionnaire', requirementId: 'req-bell-voc', classifiedAs: { label: 'Vocational questionnaire', confidence: 99 }, matches: 'Claim number' },
  { id: 'doc-bell-fin', claimId: 'D-25-018334', title: 'Financial review — Hugo Brenner, CPA', docType: 'Internal review', from: 'Hugo Brenner, CPA', received: '2026-09-12T15:45', channel: 'Internal', pages: 6, isNew: false, status: accepted, benefitLineId: 'bl-bell-di', classifiedAs: { label: 'Financial review', confidence: 100 }, matches: 'Claim number' },
  { id: 'doc-bell-cps', claimId: 'D-25-018334', title: 'Claimant progress report — September', docType: 'Progress report', from: 'Marcus Bell', received: '2026-09-03T08:20', channel: 'Portal', pages: 2, isNew: false, status: accepted, benefitLineId: 'bl-bell-di', satisfies: 'Claimant progress report — September', requirementId: 'req-bell-cps', classifiedAs: { label: 'Progress report', confidence: 99 }, matches: 'Claim number' },
  { id: 'doc-bell-nurse', claimId: 'D-25-018334', title: 'Nurse case review — Sam Whitaker, RN', docType: 'Internal review', from: 'Sam Whitaker, RN', received: '2026-09-02T11:05', channel: 'Internal', pages: 3, isNew: false, status: accepted, benefitLineId: 'bl-bell-di', classifiedAs: { label: 'Clinical review', confidence: 100 }, matches: 'Claim number' },
  { id: 'doc-bell-rx', claimId: 'D-25-018334', title: 'Pharmacy history refresh', docType: 'Pharmacy history', from: 'Pharmacy data', received: '2026-09-01T06:00', channel: 'Pharmacy data', pages: 2, isNew: false, status: accepted, satisfies: 'Pharmacy history refresh', requirementId: 'req-bell-rx', classifiedAs: { label: 'Pharmacy history', confidence: 100 }, matches: 'Name and date of birth' },
  { id: 'doc-bell-tax', claimId: 'D-25-018334', title: '2025 tax return — Form 1040', docType: 'Tax return', from: 'Marcus Bell', received: '2026-08-20T10:30', channel: 'Mail scan', pages: 14, isNew: false, status: accepted, satisfies: '2025 tax return', requirementId: 'req-bell-tax', classifiedAs: { label: 'Tax return', confidence: 97 }, matches: 'Name and SSN' },
  { id: 'doc-bell-aps-jun', claimId: 'D-25-018334', title: 'Attending physician statement — June', docType: 'Attending physician statement', from: 'Dr. Owen Castillo', received: '2026-06-24T09:12', channel: 'Provider portal', pages: 3, isNew: false, status: accepted, benefitLineId: 'bl-bell-di', classifiedAs: { label: 'Attending physician statement', confidence: 99 }, matches: 'Name, date of birth and claim number' },

  // ---------------------------------------------------------------- Hart A-26-015530 — 9
  { id: 'doc-hart-units', claimId: 'A-26-015530', title: 'Unit values at 22 Sep', docType: 'Valuation', from: 'Separate account administration', received: '2026-09-22T18:00', channel: 'Internal', pages: 1, isNew: false, status: accepted, classifiedAs: { label: 'Valuation statement', confidence: 100 }, matches: 'Contract number' },
  { id: 'doc-hart-nel', claimId: 'A-26-015530', title: 'Payout election — Nathan Hart (lump sum)', docType: 'Election form', from: 'Nathan Hart', received: '2026-09-15T09:48', channel: 'Portal', pages: 2, isNew: false, status: accepted, satisfies: 'Payout election — Nathan Hart', requirementId: 'req-hart-nathan-el', classifiedAs: { label: 'Payout election', confidence: 99 }, matches: 'Contract number and beneficiary' },
  { id: 'doc-hart-consent', claimId: 'A-26-015530', title: 'Consent to share status with agent — Claire Hart-Lopez', docType: 'Consent', from: 'Claire Hart-Lopez', received: '2026-09-12T14:20', channel: 'Recorded call', pages: 1, isNew: false, status: accepted, classifiedAs: { label: 'Consent', confidence: 93 }, matches: 'Claim number and caller verification' },
  { id: 'doc-hart-ncs', claimId: 'A-26-015530', title: 'Claimant statement — Nathan Hart', docType: 'Claimant statement', from: 'Nathan Hart', received: '2026-09-08T19:02', channel: 'Portal', pages: 3, isNew: false, status: accepted, satisfies: 'Claimant statement — Nathan Hart', requirementId: 'req-hart-nathan-cs', classifiedAs: { label: 'Claimant statement', confidence: 99 }, matches: 'Contract number and beneficiary' },
  { id: 'doc-hart-nw9', claimId: 'A-26-015530', title: 'IRS Form W-9 — Nathan Hart', docType: 'Tax form', from: 'Nathan Hart', received: '2026-09-08T19:02', channel: 'Portal', pages: 1, isNew: false, status: accepted, satisfies: 'IRS Form W-9 — Nathan Hart', requirementId: 'req-hart-nathan-w9', classifiedAs: { label: 'W-9', confidence: 99 }, matches: 'Beneficiary name and TIN' },
  { id: 'doc-hart-dc', claimId: 'A-26-015530', title: 'Certified death certificate', docType: 'Death certificate', from: 'Nathan Hart', received: '2026-09-05T11:30', channel: 'Mail scan', pages: 1, isNew: false, status: accepted, satisfies: 'Certified death certificate', requirementId: 'req-hart-dc', classifiedAs: { label: 'Death certificate', confidence: 99 }, matches: 'Name, date of birth and SSN' },
  { id: 'doc-hart-notice', claimId: 'A-26-015530', title: 'Notice of death — agent Paul Hendricks', docType: 'Notice of claim', from: 'Paul Hendricks', received: '2026-09-04T10:15', channel: 'Agent portal', pages: 1, isNew: false, status: accepted, classifiedAs: { label: 'Notice of death', confidence: 96 }, matches: 'Contract number' },
  { id: 'doc-hart-bene', claimId: 'A-26-015530', title: 'Beneficiary designation of 14 Feb 2015', docType: 'Contract record', from: 'Contract administration', received: '2026-09-04T09:00', channel: 'Internal', pages: 2, isNew: false, status: accepted, classifiedAs: { label: 'Beneficiary designation', confidence: 100 }, matches: 'Contract number' },
  { id: 'doc-hart-gmdb', claimId: 'A-26-015530', title: 'GMDB rider — highest anniversary value', docType: 'Contract record', from: 'Contract administration', received: '2026-09-04T09:00', channel: 'Internal', pages: 4, isNew: false, status: accepted, classifiedAs: { label: 'Rider', confidence: 100 }, matches: 'Contract number' },

  // ---------------------------------------------------------------- Lang L-26-039870
  { id: 'doc-lang-foreign', claimId: 'L-26-039870', title: 'Portuguese death certificate (no apostille)', docType: 'Death certificate', from: 'Henrik Lang', received: '2026-09-04T08:50', channel: 'Email', pages: 2, isNew: false, status: { label: 'Not sufficient', tone: 'caution' }, classifiedAs: { label: 'Foreign death certificate', confidence: 91 }, matches: 'Name and date of death', pageText: LANG_FOREIGN },
]
