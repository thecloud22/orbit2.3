import type { RequirementContext, RequirementRecord } from '../requirements'
import { TODAY } from '../../lib/dates'

// Owned by the Requirements screen. Dates follow the canvas story; today is Fri 25 Sep 2026.

const received = (label: string) => ({ label, tone: 'positive' as const })

export const REQUIREMENTS: RequirementRecord[] = [
  // ---------------------------------------------------------------- Pierce L-26-040112 — all met
  { id: 'req-pierce-1', claimId: 'L-26-040112', name: 'Claimant statement', purpose: 'Proof of claim', from: 'Margaret Pierce', status: received('Received 3 Sep'), state: 'met', requested: '2026-09-03', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-03', documentIds: ['doc-pierce-2'] },
  { id: 'req-pierce-2', claimId: 'L-26-040112', name: 'Certified death certificate', purpose: 'Proof of death', from: 'Margaret Pierce', status: received('Received 3 Sep'), state: 'met', requested: '2026-09-03', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-03', documentIds: ['doc-pierce-1'] },
  { id: 'req-pierce-3', claimId: 'L-26-040112', name: 'Funeral home assignment', purpose: 'Payee', from: 'Linden Grove Funeral Home', status: received('Received 3 Sep'), state: 'met', requested: '2026-09-03', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-03', documentIds: ['doc-pierce-3'] },
  { id: 'req-pierce-4', claimId: 'L-26-040112', name: 'Funeral home invoice', purpose: 'Assignment amount', from: 'Linden Grove Funeral Home', status: received('Received 23 Sep'), state: 'met', requested: '2026-09-04', requestedVia: 'fax', followUps: ['fax 16 Sep'], receivedOn: '2026-09-23', documentIds: ['doc-pierce-4'] },
  { id: 'req-pierce-5', claimId: 'L-26-040112', name: 'IRS Form W-9', purpose: 'Tax', from: 'Margaret Pierce', status: received('Received 3 Sep'), state: 'met', requested: '2026-09-03', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-03', documentIds: ['doc-pierce-5'] },

  // ---------------------------------------------------------------- Okafor L-26-038907 — 9 requirements, 7 met
  { id: 'req-okafor-cs', claimId: 'L-26-038907', name: 'Claimant statement', purpose: 'Proof of claim', from: 'Adaeze Okafor', status: received('Received 24 Jul'), state: 'met', requested: '2026-07-24', requestedVia: 'portal', followUps: [], receivedOn: '2026-07-24', documentIds: ['doc-okafor-cs'] },
  { id: 'req-okafor-dc', claimId: 'L-26-038907', name: 'Certified death certificate', purpose: 'Proof of death', from: 'Adaeze Okafor', status: received('Received 24 Jul'), state: 'met', requested: '2026-07-24', requestedVia: 'portal', followUps: [], receivedOn: '2026-07-24', documentIds: ['doc-okafor-dc'] },
  { id: 'req-okafor-w9', claimId: 'L-26-038907', name: 'IRS Form W-9 — Adaeze Okafor', purpose: 'Tax', from: 'Adaeze Okafor', status: received('Received 24 Jul'), state: 'met', requested: '2026-07-24', requestedVia: 'portal', followUps: [], receivedOn: '2026-07-24', documentIds: ['doc-okafor-w9'] },
  { id: 'req-okafor-auth', claimId: 'L-26-038907', name: 'Authorization to release medical information', note: 'Signed as personal representative', purpose: 'Records access', from: 'Adaeze Okafor', status: received('E-signed 29 Jul'), state: 'met', requested: '2026-07-24', requestedVia: 'portal', followUps: [], receivedOn: '2026-07-29', benefitLineId: 'bl-okafor-term', documentIds: ['doc-okafor-auth'] },
  { id: 'req-okafor-rx', claimId: 'L-26-038907', name: 'Pharmacy history', purpose: 'Contestable review', from: 'Pharmacy data', status: received('Received 30 Jul'), state: 'met', requestedVia: 'Automatic', followUps: [], receivedOn: '2026-07-30', benefitLineId: 'bl-okafor-term', documentIds: ['doc-okafor-rx'] },
  { id: 'req-okafor-police', claimId: 'L-26-038907', name: 'Police accident report', purpose: 'Accidental cause', from: 'Ashford County Sheriff', status: received('Received 6 Aug'), state: 'met', requested: '2026-07-27', requestedVia: 'mail', followUps: [], receivedOn: '2026-08-06', benefitLineId: 'bl-okafor-adb', documentIds: ['doc-okafor-police'] },
  { id: 'req-okafor-tox', claimId: 'L-26-038907', name: 'Toxicology report', purpose: 'Intoxication exclusion', from: 'Ashford County Coroner', status: received('Received today'), state: 'met', requested: '2026-08-12', requestedVia: 'fax', followUps: ['fax 9 Sep'], receivedOn: TODAY, benefitLineId: 'bl-okafor-adb', documentIds: ['doc-okafor-tox'] },
  {
    id: 'req-okafor-patel', claimId: 'L-26-038907', name: 'Medical records — Dr. Anil Patel', note: 'Jan 2020 to date of death', purpose: 'Contestable review',
    from: 'Dr. Anil Patel', fromDetail: 'Northgate Internal Medicine', waitingOn: 'Dr. Patel’s office',
    contact: ['Dr. Anil Patel · Northgate Internal Medicine', 'Fax (555) 010-2290 · Phone (555) 010-2200', 'Records: Lorna Diaz, office manager'],
    status: { label: '2nd request', tone: 'caution' }, state: 'open', requested: '2026-08-12', requestedVia: 'fax', reminderVia: 'fax',
    followUps: ['fax 2 Sep', '16 Sep'], due: '2026-09-30', benefitLineId: 'bl-okafor-term',
    plan: [
      { date: '2026-08-12', label: 'Requested by fax with Adaeze’s authorization', state: 'done' },
      { date: '2026-09-02', label: 'Automatic reminder', state: 'done' },
      { date: '2026-09-16', label: 'Second request; office said the copy service has it', state: 'done' },
      { date: '2026-09-30', label: 'Due — call the copy service if still missing', state: 'todo' },
      { date: '2026-10-03', label: 'Status letter lists it, if it is still missing', state: 'todo' },
      { date: '2026-10-09', label: 'Contestable review due', state: 'todo' },
    ],
    alternatives: [
      { title: 'Order through the records vendor', note: 'Vendor retrieval typically 5–7 business days', action: 'Order', kind: 'task', text: 'Order Dr. Patel’s records through the records vendor' },
      { title: 'Ask Adaeze to request them', note: 'As personal representative she can ask the office directly', action: 'Ask', kind: 'message', to: 'Adaeze Okafor', channel: 'portal', text: 'Portal task: ask Dr. Patel’s office to release Daniel’s records' },
    ],
  },
  {
    id: 'req-okafor-coroner', claimId: 'L-26-038907', name: 'Coroner’s final report', note: 'Cause and manner of death', purpose: 'Accidental cause',
    from: 'Ashford County Coroner', waitingOn: 'County coroner',
    contact: ['Ashford County Office of the Coroner', 'Records unit · (555) 010-7300 · case ACC-26-0714-3', 'Releases the final report after toxicology'],
    status: { label: 'Requested', tone: 'neutral' }, state: 'open', requested: '2026-08-12', requestedVia: 'fax', reminderVia: 'fax',
    followUps: [], due: '2026-10-23', dueNote: 'external', benefitLineId: 'bl-okafor-adb',
    plan: [
      { date: '2026-08-12', label: 'Requested by fax; preliminary report received the same week', state: 'done' },
      { date: '2026-09-25', label: 'Toxicology received — the final report usually follows in 2–4 weeks', state: 'done' },
      { date: '2026-10-09', label: 'Ask the records unit for a release date', state: 'todo' },
      { date: '2026-10-23', label: 'Coroner’s expected release', state: 'todo' },
    ],
    alternatives: [
      { title: 'Decide the rider on toxicology and the police report', note: 'Needs team lead approval if the final report is delayed', action: 'Plan review', kind: 'task', text: 'Consider deciding ADB rider without the coroner’s final report' },
    ],
  },

  // ---------------------------------------------------------------- Whitman L-26-035120 — all met
  { id: 'req-whit-cs', claimId: 'L-26-035120', name: 'Claimant statement', purpose: 'Proof of claim', from: 'Robert Whitman', status: received('Received 28 Aug'), state: 'met', requested: '2026-08-28', requestedVia: 'mail', followUps: [], receivedOn: '2026-08-28', documentIds: ['doc-whit-cs'] },
  { id: 'req-whit-dc', claimId: 'L-26-035120', name: 'Certified death certificate', purpose: 'Proof of death', from: 'Robert Whitman', status: received('Received 28 Aug'), state: 'met', requested: '2026-08-28', requestedVia: 'mail', followUps: [], receivedOn: '2026-08-28', documentIds: ['doc-whit-dc'] },
  { id: 'req-whit-w9', claimId: 'L-26-035120', name: 'IRS Form W-9', purpose: 'Tax', from: 'Robert Whitman', status: received('Received 4 Sep'), state: 'met', requested: '2026-08-28', requestedVia: 'mail', followUps: [], receivedOn: '2026-09-04', documentIds: ['doc-whit-w9'] },
  { id: 'req-whit-id', claimId: 'L-26-035120', name: 'Proof of identity', purpose: 'Payee', from: 'Robert Whitman', status: received('Verified 4 Sep'), state: 'met', requested: '2026-08-28', requestedVia: 'mail', followUps: [], receivedOn: '2026-09-04', documentIds: ['doc-whit-id'] },
  { id: 'req-whit-ul', claimId: 'L-26-035120', name: 'Policy value statement at death', purpose: 'Benefit amount', from: 'Policy administration', status: received('Received 29 Aug'), state: 'met', requestedVia: 'Automatic', followUps: [], receivedOn: '2026-08-29', documentIds: ['doc-whit-ul'] },

  // ---------------------------------------------------------------- Vasquez D-26-073390 — board 04.4
  { id: 'req-vas-cs', claimId: 'D-26-073390', name: 'Claimant statement', purpose: 'Proof of claim', from: 'Elena Vasquez', status: received('Received 25 Aug'), state: 'met', requested: '2026-08-25', requestedVia: 'portal', followUps: [], receivedOn: '2026-08-25', documentIds: ['doc-vas-cs'] },
  { id: 'req-vas-auth', claimId: 'D-26-073390', name: 'Authorization to release information', purpose: 'Records access', from: 'Elena Vasquez', status: received('E-signed 25 Aug'), state: 'met', requested: '2026-08-25', requestedVia: 'portal', followUps: [], receivedOn: '2026-08-25', documentIds: ['doc-vas-auth'] },
  {
    id: 'req-vas-aps', claimId: 'D-26-073390', name: 'Attending physician statement', purpose: 'Medical proof',
    from: 'Dr. Grace Hsu', fromDetail: 'Lakeside Rheumatology', waitingOn: 'Dr. Hsu’s office',
    contact: ['Dr. Grace Hsu · Lakeside Rheumatology Associates', 'Fax (555) 010-4410 · Phone (555) 010-4400'],
    status: { label: 'Overdue', tone: 'critical' }, state: 'overdue', requested: '2026-08-26', requestedVia: 'fax, portal', reminderVia: 'fax',
    followUps: ['fax 5 Sep', '16 Sep'], due: '2026-09-16', benefitLineId: 'bl-vas-di',
    plan: [
      { date: '2026-08-26', label: 'Requested by fax and provider portal', state: 'done' },
      { date: '2026-09-05', label: 'Automatic reminder', state: 'done' },
      { date: '2026-09-16', label: 'Second request; Elena told in her portal', note: 'viewed 17 Sep', state: 'done' },
      { date: '2026-09-24', label: 'Listed as still needed in status letter 1', state: 'done' },
      { date: TODAY, label: 'Phone the office', state: 'current', act: 'call' },
      { date: '2026-10-24', label: 'Status letter 2, if it is still missing', state: 'todo' },
    ],
    alternatives: [
      { title: 'Ask Elena to help', note: 'portal task sent 16 Sep', action: 'Resend', kind: 'message', to: 'Elena Vasquez', channel: 'portal', text: 'Portal task: ask Dr. Hsu’s office to send the physician statement' },
      { title: 'Use records from the vendor instead', note: 'Records may be enough for clinical review', action: 'Plan review', kind: 'task', text: 'Clinical review of vendor records in place of the APS' },
      { title: 'Call script', note: 'for today’s call', action: 'Open script', kind: 'script' },
    ],
    script: [
      'Hello, this is Jordan Ellis calling about a patient of Dr. Grace Hsu, Elena Vasquez, date of birth 9 May 1980.',
      'We faxed an attending physician statement on 26 Aug, with Elena’s signed authorization, and followed up on 5 and 16 Sep.',
      'Can you confirm the office has the request? If it helps, I can fax it again to (555) 010-4410 now.',
      'The form takes about 15 minutes: diagnosis, restrictions, and whether she can do clinical dentistry more than two days a week.',
      'When can we expect it? If there is a copy fee, we pay it — please include an invoice.',
      'Note who you spoke with and the date they promised.',
    ],
    nextAction: { label: 'Call Dr. Hsu’s office', reason: 'Physician statement 30 days outstanding' },
    exceptionId: 'x1',
    workItem: { action: 'Call Dr. Hsu’s office', doneBy: ['call', 'met'] },
  },
  { id: 'req-vas-odq', claimId: 'D-26-073390', name: 'Occupational duties questionnaire', purpose: 'Own occupation', from: 'Elena Vasquez', status: received('Received 2 Sep'), state: 'met', requested: '2026-08-26', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-02', documentIds: ['doc-vas-odq'] },
  { id: 'req-vas-2025', claimId: 'D-26-073390', name: '2025 tax return', purpose: 'Prior earnings', from: 'Elena Vasquez', status: received('Received 3 Sep'), state: 'met', requested: '2026-08-26', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-03', documentIds: ['doc-vas-2025'] },
  {
    id: 'req-vas-2024', claimId: 'D-26-073390', name: '2024 tax return', purpose: 'Prior earnings', from: 'Elena Vasquez', waitingOn: 'Elena Vasquez',
    contact: ['Elena Vasquez · portal, text reminders on', 'Accountant: Maria Chen, CPA · Chen & Alvarez · (555) 010-6120'],
    status: { label: 'Missing', tone: 'caution' }, state: 'open', requested: '2026-08-26', reminderVia: 'portal',
    followUps: ['portal 9 Sep'], due: '2026-09-29', benefitLineId: 'bl-vas-di',
    plan: [
      { date: '2026-08-26', label: 'Requested in Elena’s portal', state: 'done' },
      { date: '2026-09-09', label: 'Portal reminder', state: 'done' },
      { date: '2026-09-24', label: 'Listed as still needed in status letter 1', state: 'done' },
      { date: TODAY, label: 'Request from her accountant', state: 'current', act: 'alternative', alt: 0 },
      { date: '2026-09-29', label: 'Due', state: 'todo' },
      { date: '2026-10-24', label: 'Status letter 2, if it is still missing', state: 'todo' },
    ],
    alternatives: [
      { title: 'Request from her accountant', note: 'Covered by the 25 Aug authorization', action: 'Send request', kind: 'message', to: 'Maria Chen, CPA', channel: 'email', text: 'Request to accountant: 2024 return and practice P&L, Jun–Aug' },
      { title: 'Order an IRS transcript', note: 'Form 4506-C with Elena’s consent · about 10 days', action: 'Plan', kind: 'task', text: 'Order 2024 IRS tax transcript (Form 4506-C)' },
    ],
    nextAction: { label: 'Email the accountant', reason: 'P&L and 2024 return · residual can’t be calculated' },
    exceptionId: 'x2',
    workItem: { action: 'Request P&L and 2024 return from accountant', doneBy: ['alternative', 'met'] },
  },
  {
    id: 'req-vas-pl', claimId: 'D-26-073390', name: 'Monthly practice P&L, Jun–Aug', note: 'Needed for the residual benefit', purpose: 'Current earnings', from: 'Elena Vasquez', waitingOn: 'Elena Vasquez',
    contact: ['Elena Vasquez · portal, text reminders on', 'Accountant: Maria Chen, CPA · Chen & Alvarez · (555) 010-6120'],
    status: { label: 'Missing', tone: 'caution' }, state: 'open', requested: '2026-08-26', reminderVia: 'portal',
    followUps: ['portal 9 Sep'], due: '2026-09-29', benefitLineId: 'bl-vas-di',
    plan: [
      { date: '2026-08-26', label: 'Requested in Elena’s portal', state: 'done' },
      { date: '2026-09-09', label: 'Portal reminder', state: 'done' },
      { date: '2026-09-24', label: 'Listed as still needed in status letter 1', state: 'done' },
      { date: TODAY, label: 'Request from her accountant', state: 'current', act: 'alternative', alt: 0 },
      { date: '2026-09-29', label: 'Due', state: 'todo' },
      { date: '2026-10-24', label: 'Status letter 2, if it is still missing', state: 'todo' },
    ],
    alternatives: [
      { title: 'Request from her accountant', note: 'Covered by the 25 Aug authorization', action: 'Send request', kind: 'message', to: 'Maria Chen, CPA', channel: 'email', text: 'Request to accountant: 2024 return and practice P&L, Jun–Aug' },
      { title: 'Ask Paul Hendricks to help', note: 'Agent of record · status and requirements only', action: 'Ask', kind: 'message', to: 'Paul Hendricks', channel: 'email', text: 'Asked agent Paul Hendricks to help Elena with the P&L' },
      { title: 'Accept bank statements for now', note: 'Hugo Brenner can estimate; P&L still needed to finalise', action: 'Plan review', kind: 'task', text: 'Hugo Brenner: estimate residual share from bank statements' },
    ],
    nextAction: { label: 'Email the accountant', reason: 'P&L and 2024 return · residual can’t be calculated' },
    exceptionId: 'x2',
    workItem: { action: 'Request P&L and 2024 return from accountant', doneBy: ['alternative', 'met'] },
  },
  {
    id: 'req-vas-mr', claimId: 'D-26-073390', name: 'Medical records', note: 'Jan 2025–present', purpose: 'Medical proof', from: 'Records vendor', waitingOn: 'Records vendor',
    contact: ['Recordpoint Retrieval · order RP-448120', 'Lakeside Rheumatology and Harbor Imaging'],
    status: { label: 'In progress', tone: 'info' }, state: 'inProgress', requested: '2026-08-27', reminderVia: 'email',
    followUps: [], due: '2026-10-01', dueNote: 'vendor ETA', benefitLineId: 'bl-vas-di',
    plan: [
      { date: '2026-08-27', label: 'Ordered through the records vendor', state: 'done' },
      { date: '2026-09-18', label: 'Vendor: imaging centre sent; rheumatology pending', state: 'done' },
      { date: '2026-10-01', label: 'Vendor ETA', state: 'todo' },
    ],
  },
  { id: 'req-vas-rx', claimId: 'D-26-073390', name: 'Pharmacy history', purpose: 'Medical proof', from: 'Pharmacy data', status: received('Received 27 Aug'), state: 'met', requestedVia: 'Automatic', followUps: [], receivedOn: '2026-08-27', documentIds: ['doc-vas-rx'] },

  // ---------------------------------------------------------------- Bell D-25-018334 — all met
  { id: 'req-bell-aps', claimId: 'D-25-018334', name: 'Quarterly APS update', note: 'Restrictions and prognosis', purpose: 'Continuing proof of loss', from: 'Dr. Owen Castillo', fromDetail: 'Castillo Spine & Orthopedics', status: received('Received today'), state: 'met', requested: '2026-09-01', requestedVia: 'provider portal', followUps: [], receivedOn: TODAY, benefitLineId: 'bl-bell-di', documentIds: ['doc-bell-aps'] },
  { id: 'req-bell-cps', claimId: 'D-25-018334', name: 'Claimant progress report — September', purpose: 'Continuing proof of loss', from: 'Marcus Bell', status: received('Received 3 Sep'), state: 'met', requested: '2026-08-25', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-03', benefitLineId: 'bl-bell-di', documentIds: ['doc-bell-cps'] },
  { id: 'req-bell-tax', claimId: 'D-25-018334', name: '2025 tax return', purpose: 'Financial review', from: 'Marcus Bell', status: received('Received 20 Aug'), state: 'met', requested: '2026-07-15', requestedVia: 'mail', followUps: ['portal 5 Aug'], receivedOn: '2026-08-20', documentIds: ['doc-bell-tax'] },
  { id: 'req-bell-auth', claimId: 'D-25-018334', name: 'Authorization renewal', purpose: 'Records access', from: 'Marcus Bell', status: received('E-signed 2 Jan'), state: 'met', requested: '2025-12-15', requestedVia: 'portal', followUps: [], receivedOn: '2026-01-02' },
  { id: 'req-bell-rx', claimId: 'D-25-018334', name: 'Pharmacy history refresh', purpose: 'Medical proof', from: 'Pharmacy data', status: received('Received 1 Sep'), state: 'met', requestedVia: 'Automatic', followUps: [], receivedOn: '2026-09-01', documentIds: ['doc-bell-rx'] },
  { id: 'req-bell-voc', claimId: 'D-25-018334', name: 'Vocational questionnaire', note: 'For the 14 Oct skills analysis', purpose: 'Any-occupation review', from: 'Marcus Bell', status: received('Received 18 Sep'), state: 'met', requested: '2026-09-04', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-18', documentIds: ['doc-bell-voc'] },

  // ---------------------------------------------------------------- Hart A-26-015530 — Claire's forms missing
  { id: 'req-hart-dc', claimId: 'A-26-015530', name: 'Certified death certificate', purpose: 'Proof of death', from: 'Nathan Hart', status: received('Received 5 Sep'), state: 'met', requested: '2026-09-05', requestedVia: 'mail', followUps: [], receivedOn: '2026-09-05', documentIds: ['doc-hart-dc'] },
  { id: 'req-hart-nathan-cs', claimId: 'A-26-015530', name: 'Claimant statement — Nathan Hart', purpose: 'Good order', from: 'Nathan Hart', status: received('Received 8 Sep'), state: 'met', requested: '2026-09-05', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-08', documentIds: ['doc-hart-ncs'] },
  { id: 'req-hart-nathan-w9', claimId: 'A-26-015530', name: 'IRS Form W-9 — Nathan Hart', purpose: 'Tax', from: 'Nathan Hart', status: received('Received 8 Sep'), state: 'met', requested: '2026-09-05', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-08', documentIds: ['doc-hart-nw9'] },
  { id: 'req-hart-nathan-el', claimId: 'A-26-015530', name: 'Payout election — Nathan Hart', note: 'Lump sum', purpose: 'Distribution', from: 'Nathan Hart', status: received('Received 15 Sep'), state: 'met', requested: '2026-09-08', requestedVia: 'portal', followUps: [], receivedOn: '2026-09-15', documentIds: ['doc-hart-nel'] },
  {
    id: 'req-hart-claire', claimId: 'A-26-015530', name: 'Claimant statement and W-9 — Claire Hart-Lopez', note: 'Her half stays invested until both arrive', purpose: 'Good order',
    from: 'Claire Hart-Lopez', waitingOn: 'Claire Hart-Lopez',
    contact: ['Claire Hart-Lopez · daughter · phone, afternoons', '(555) 010-8834 · shares status with agent Paul Hendricks (12 Sep)'],
    status: { label: 'Missing', tone: 'caution' }, state: 'open', requested: '2026-09-08', requestedVia: 'mail, email', reminderVia: 'email',
    followUps: ['email 15 Sep'], due: '2026-10-08',
    plan: [
      { date: '2026-09-08', label: 'Forms mailed and emailed with the options guide', state: 'done' },
      { date: '2026-09-12', label: 'Claire called; agreed to share status with Paul Hendricks', state: 'done' },
      { date: '2026-09-15', label: 'Email reminder', note: 'opened 15 Sep', state: 'done' },
      { date: TODAY, label: 'Send a reminder with the options guide', state: 'current', act: 'reminder' },
      { date: '2026-10-08', label: 'Call Claire if still missing', state: 'todo' },
    ],
    alternatives: [
      { title: 'Ask Paul Hendricks to help', note: 'Claire’s consent of 12 Sep covers status', action: 'Ask', kind: 'message', to: 'Paul Hendricks', channel: 'email', text: 'Asked agent Paul Hendricks to help Claire with her forms' },
      { title: 'Offer e-signature', note: 'Both forms in one portal link', action: 'Send link', kind: 'message', to: 'Claire Hart-Lopez', channel: 'email', text: 'E-signature link: claimant statement and W-9' },
    ],
    nextAction: { label: 'Follow up with Claire', reason: 'Her half floats with the market until her forms arrive' },
    exceptionId: 'x1',
    workItem: { action: 'Follow up with Claire', doneBy: ['reminder', 'call', 'alternative', 'met'] },
  },

  // ---------------------------------------------------------------- Light claims the queues point at
  { id: 'req-lang-cs', claimId: 'L-26-039870', name: 'Claimant statement', purpose: 'Proof of claim', from: 'Henrik Lang', status: received('Received 6 Aug'), state: 'met', requested: '2026-08-06', requestedVia: 'portal', followUps: [], receivedOn: '2026-08-06' },
  {
    id: 'req-lang-dc', claimId: 'L-26-039870', name: 'Apostilled death certificate', note: 'Portuguese certificate with apostille and translation', purpose: 'Proof of death',
    from: 'Henrik Lang', waitingOn: 'Henrik Lang', contact: ['Henrik Lang · husband · email', 'Lisbon civil registry issues the apostille'],
    status: { label: 'Second request due', tone: 'caution' }, state: 'open', requested: '2026-09-04', requestedVia: 'email', reminderVia: 'email',
    followUps: [], due: '2026-09-30',
    plan: [
      { date: '2026-09-04', label: 'Requested; foreign certificate received without apostille', state: 'done' },
      { date: '2026-09-22', label: 'Consular report offered instead — sent to Monica Reyes for approval', state: 'done' },
      { date: TODAY, label: 'Send the second request', state: 'current', act: 'reminder' },
      { date: '2026-09-30', label: 'Due', state: 'todo' },
    ],
    alternatives: [
      { title: 'Accept the consular report of death abroad', note: 'Needs team lead approval', action: 'Approve', kind: 'approve' },
    ],
    nextAction: { label: 'Second request: apostilled certificate', reason: 'Death abroad · first request 21 days ago' },
    workItem: { action: 'Second request: apostilled certificate', doneBy: ['reminder', 'met'] },
  },
  {
    id: 'req-farrow-pcd', claimId: 'L-25-022918', name: 'Proof of continued disability', note: 'Annual attending physician statement', purpose: 'Waiver of premium',
    from: 'Denise Farrow', waitingOn: 'Denise Farrow', contact: ['Denise Farrow · insured · mail', 'Physician: Dr. Ruth Okonkwo'],
    status: { label: 'Requested 1 Sep', tone: 'neutral' }, state: 'open', requested: '2026-09-01', requestedVia: 'mail', reminderVia: 'letter',
    followUps: [], due: '2026-10-01',
    plan: [
      { date: '2026-09-01', label: 'Annual request mailed', state: 'done' },
      { date: '2026-10-01', label: 'Due — call if missing', state: 'todo' },
    ],
    workItem: { action: 'Annual waiver-of-premium review', doneBy: ['met'] },
  },
  { id: 'req-mercer-cs', claimId: 'L-26-036554', name: 'Claimant statement', purpose: 'Proof of claim', from: 'Owen Mercer', status: received('Received 12 Aug'), state: 'met', requested: '2026-08-12', requestedVia: 'portal', followUps: [], receivedOn: '2026-08-12' },
  { id: 'req-mercer-dc', claimId: 'L-26-036554', name: 'Certified death certificate', purpose: 'Proof of death', from: 'Owen Mercer', status: received('Received 19 Aug'), state: 'met', requested: '2026-08-12', requestedVia: 'mail', followUps: [], receivedOn: '2026-08-19' },
  { id: 'req-mercer-w9', claimId: 'L-26-036554', name: 'IRS Form W-9', purpose: 'Tax', from: 'Owen Mercer', status: received('Received 12 Aug'), state: 'met', requested: '2026-08-12', requestedVia: 'portal', followUps: [], receivedOn: '2026-08-12' },
]

/** Who needs the evidence, and where the state status-letter count stands. */
export const REQUIREMENT_CONTEXT: Record<string, RequirementContext> = {
  'D-26-073390': {
    initials: 'HB',
    text: 'Hugo Brenner, claims financial analyst, needs the P&L and the 2024 return to work out the residual share of the $12,000 monthly benefit',
    nextLetter: 2,
  },
  'L-26-038907': {
    initials: 'RK',
    text: 'Dr. Patel’s records finish the contestable review due 9 Oct; the accidental death rider follows the term decision and the coroner’s final report',
    nextLetter: 3,
  },
  'A-26-015530': {
    text: 'Claire’s half stays invested and changes daily until her forms arrive; at least $327,500 is guaranteed',
  },
  'L-26-039870': { text: 'The foreign certificate arrived without an apostille. Monica Reyes is considering a consular report instead.', nextLetterDue: '2026-10-06' },
}
