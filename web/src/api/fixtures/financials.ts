import type { ResidualWorkup } from '../financials'

// Owned by the Financials screen. Elena Vasquez's residual disability claim.

export const FINANCIALS: ResidualWorkup[] = [
  {
    id: 'D-26-073390',
    claimId: 'D-26-073390',
    analyst: 'Hugo Brenner',
    analystTitle: 'Claims financial analyst',
    policy: 'DI-1507791',
    monthlyBenefit: 12_000,
    minimumLoss: 0.2,
    disabledSince: '2026-06-12',
    eliminationMet: '2026-09-10',
    definitions: [
      ['Residual disability', 'Policy §6 — working, but losing at least 20% of prior earnings because of the same sickness or injury.'],
      ['Prior earnings', 'Policy §1 — the higher of 2025 earnings, or the 2024–2025 average, as a monthly figure.'],
      ['Current earnings', 'Policy §1 — earnings from work in each month of the claim, from the practice P&L.'],
      ['Earnings', 'Net income from the practice before income tax, after ordinary business expenses.'],
    ],
    prior: [
      { id: 'y2025', label: '2025 tax return', period: '2025', status: 'received', amount: 402_600, received: '2026-09-03', note: 'Net earnings from the practice, Schedule C' },
      { id: 'y2024', label: '2024 tax return', period: '2024', status: 'missing', requested: '2026-08-26', due: '2026-09-29', followUps: ['Portal reminder 9 Sep'], requirementId: 'req-vas-pl' },
    ],
    current: [
      { id: 'm06', label: 'Practice P&L', period: 'Jun 2026', status: 'missing', requested: '2026-08-26', due: '2026-09-29', requirementId: 'req-vas-pl' },
      { id: 'm07', label: 'Practice P&L', period: 'Jul 2026', status: 'missing', requested: '2026-08-26', due: '2026-09-29', requirementId: 'req-vas-pl' },
      { id: 'm08', label: 'Practice P&L', period: 'Aug 2026', status: 'missing', requested: '2026-08-26', due: '2026-09-29', requirementId: 'req-vas-pl' },
    ],
    requests: [],
  },
]
