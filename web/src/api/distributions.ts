import { collection, fail, respond } from './store'
import { logEvent } from './history'
import { addTask } from './tasks'
import { patchClaim } from './claims'
import { fmtDate, TODAY } from '../lib/dates'
import type { Status } from './types'

/**
 * Annuity death-benefit shares: each beneficiary is valued, elects and is paid separately.
 * GET /claims/{id}/distributions · POST /claims/{id}/distributions/{shareId}:elect
 */
export interface DistributionShare {
  id: string
  claimId: string
  beneficiary: string
  relationship: string
  share: string
  /** ISO date the claim was in good order, or null. */
  goodOrder: string | null
  missing?: string
  election: string | null
  amount: string
  amountNote?: string
  tax: string
  taxNote?: string
  status: Status
  statusNote?: string
  spouse: boolean
}

export type ElectionOption = 'lump' | 'fiveYear' | 'lifeExpectancy' | 'continue'

export const ELECTION_LABELS: Record<ElectionOption, string> = {
  lump: 'Lump sum',
  fiveYear: 'Within 5 years',
  lifeExpectancy: 'Over her life expectancy',
  continue: 'Continue as owner',
}

const SHARES: DistributionShare[] = [
  {
    id: 'sh-hart-nathan', claimId: 'A-26-015530', beneficiary: 'Nathan Hart', relationship: 'Son', share: '50%', goodOrder: '2026-09-22',
    election: 'Lump sum', amount: '$327,500.00', tax: 'Gain $127,500.00', taxNote: 'Federal withholding 10% · $12,750.00',
    status: { label: 'Paying 26 Sep', tone: 'positive' }, statusNote: 'net $314,750.00', spouse: false,
  },
  {
    id: 'sh-hart-claire', claimId: 'A-26-015530', beneficiary: 'Claire Hart-Lopez', relationship: 'Daughter', share: '50%', goodOrder: null,
    missing: 'Claimant statement, W-9 missing', election: null, amount: '$327,500.00', amountNote: 'at least', tax: '—',
    status: { label: 'Waiting', tone: 'caution' }, spouse: false,
  },
]

export const shares = collection<DistributionShare>(SHARES)

export function listShares(claimId: string): Promise<DistributionShare[]> {
  return respond(shares.where((s) => s.claimId === claimId))
}

/** Records a beneficiary's election. Only allowed once that share is in good order. */
export function recordElection(args: { claimId: string; shareId: string; option: ElectionOption; by: string; goodOrder: boolean }): Promise<void> {
  const { claimId, shareId, option, by, goodOrder } = args
  const s = shares.get(shareId)
  if (!s) return fail('Share not found')
  if (!goodOrder && !s.goodOrder) return fail(`${s.beneficiary}’s claim isn’t in good order yet`)
  if (option === 'continue' && !s.spouse) return fail('Only a spouse can continue the contract as owner')
  const label = ELECTION_LABELS[option]
  shares.update(shareId, {
    goodOrder: s.goodOrder ?? TODAY,
    missing: undefined,
    election: label,
    status: option === 'lump' ? { label: 'Valuing share', tone: 'info' } : { label: 'Election recorded', tone: 'positive' },
    statusNote: option === 'lump' ? 'pays after valuation' : option === 'fiveYear' ? 'fully paid by 3 Sep 2031' : 'first payment by 3 Sep 2027',
  })
  patchClaim(claimId, (c) => ({
    parties: c.parties.map((p) => (p.name === s.beneficiary ? { ...p, status: { label: `Elected: ${label.toLowerCase()}`, tone: 'positive' } } : p)),
  }))
  addTask(claimId, `Value ${s.beneficiary}’s share at ${fmtDate(TODAY)} unit values and set up ${label.toLowerCase()}`, by, 'Distributions · election')
  logEvent(claimId, { type: 'decision', title: `Election recorded — ${s.beneficiary}: ${label}`, actor: by, detail: 'Share valued at the unit values on her good-order date; at least $327,500.00 under the GMDB.' })
  return respond(undefined)
}
