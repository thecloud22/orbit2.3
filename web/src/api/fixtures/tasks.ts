import type { Note, Task } from '../types'

export const TASKS: Task[] = [
  { id: 't-pierce-1', claimId: 'L-26-040112', title: 'Confirm Margaret’s bank details on the call', assignee: 'Rachel Kim', done: true },
  { id: 't-okafor-1', claimId: 'L-26-038907', title: 'Send custodian packet to Adaeze', due: '2026-09-25', assignee: 'Rachel Kim', done: false },
  { id: 't-okafor-2', claimId: 'L-26-038907', title: 'Chase Dr. Patel’s records', due: '2026-09-30', assignee: 'Rachel Kim', done: false },
  { id: 't-okafor-3', claimId: 'L-26-038907', title: 'Review toxicology report', due: '2026-10-09', assignee: 'Rachel Kim', done: false },
  { id: 't-okafor-4', claimId: 'L-26-038907', title: 'Underwriting opinion on application Q4', due: '2026-10-06', assignee: 'Underwriting', done: false },
  { id: 't-vas-1', claimId: 'D-26-073390', title: 'Call Dr. Hsu’s office', due: '2026-09-25', assignee: 'Jordan Ellis', done: false },
  { id: 't-vas-2', claimId: 'D-26-073390', title: 'Request P&L from Elena’s accountant', due: '2026-09-29', assignee: 'Jordan Ellis', done: false },
  { id: 't-vas-3', claimId: 'D-26-073390', title: 'Residual calculation once financials arrive', assignee: 'Hugo Brenner', done: false },
  { id: 't-bell-1', claimId: 'D-25-018334', title: 'Review APS update', due: '2026-09-30', assignee: 'Jordan Ellis', done: false },
  { id: 't-bell-2', claimId: 'D-25-018334', title: 'Transferable skills analysis', due: '2026-10-14', assignee: 'Chris Duarte, CRC', done: false },
  { id: 't-bell-3', claimId: 'D-25-018334', title: 'Nurse review of restrictions', due: '2026-10-07', assignee: 'Sam Whitaker, RN', done: false },
  { id: 't-bell-4', claimId: 'D-25-018334', title: 'Any-occupation notice draft', due: '2026-11-01', assignee: 'Jordan Ellis', done: false },
  { id: 't-hart-1', claimId: 'A-26-015530', title: 'Follow up with Claire', due: '2026-09-28', assignee: 'Irene Walsh', done: false },
  { id: 't-hart-2', claimId: 'A-26-015530', title: 'Confirm Nathan’s EFT released', due: '2026-09-26', assignee: 'Irene Walsh', done: false },
]

export const NOTES: Note[] = [
  { id: 'n-okafor-1', claimId: 'L-26-038907', at: '2026-09-11T15:20', author: 'Rachel Kim', text: 'Explained the contestable review to Adaeze. She understood the whole life payment is separate and was relieved it had been paid.' },
  { id: 'n-okafor-2', claimId: 'L-26-038907', at: '2026-09-18T15:45', author: 'Rachel Kim', text: 'Whole life approved. Children’s shares held; custodian packet to follow once LTR-L-131 template is updated.' },
  { id: 'n-bell-1', claimId: 'D-25-018334', at: '2026-09-12T11:00', author: 'Hugo Brenner', text: 'Business is profitable under the operations manager; Marcus draws no salary and does no work in it. No offset applies under the individual policy.' },
  { id: 'n-hart-1', claimId: 'A-26-015530', at: '2026-09-12T10:30', author: 'Irene Walsh', text: 'Claire called; she is unsure whether to take a lump sum. Agreed to let Paul Hendricks see her status.' },
]
