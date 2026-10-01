import type { Claim } from '../../api/types'
import type { QuickAction } from '../ClaimHeader'

/** Every claim section gets the claim, an optional deep-link target (a requirement or document id) and quick actions. */
export interface SectionProps {
  claim: Claim
  target?: string
  onQuick: (a: QuickAction) => void
}
