import { useQuery } from '../api/useQuery'
import { listRequirements } from '../api/requirements'
import { listDocuments } from '../api/documents'
import { listDecisions, listWorkbenches } from '../api/decisions'
import { listPayments } from '../api/payments'
import { listCommunications } from '../api/communications'
import { listTasks, listNotes } from '../api/tasks'
import { respond } from '../api/store'
import { isLiveId } from '../api/live/mode'
import * as live from '../api/live/data'

export interface ClaimCounts {
  reqOpen: number
  reqLate: number
  reqTotal: number
  docsNew: number
  docsTotal: number
  decided: number
  toDecide: number
  paid: number
  scheduled: number
  comms: number
  tasksOpen: number
  notes: number
}

/** Badge counts for the section nav and context tabs, from each sub-resource. */
export function useClaimCounts(claimId: string): ClaimCounts | undefined {
  const { data } = useQuery(async () => {
    // A live claim has no workbench resource; what is left to decide is worked out from its records.
    const liveCounts = isLiveId(claimId) ? await live.sectionCounts(claimId) : undefined
    const [req, docs, dec, wbs, pays, comms, tasks, notes] = await Promise.all([
      listRequirements(claimId), listDocuments(claimId), listDecisions(claimId), listWorkbenches(claimId),
      listPayments(claimId), listCommunications(claimId), listTasks(claimId), listNotes(claimId),
    ])
    return respond<ClaimCounts>({
      reqOpen: req.filter((r) => r.state !== 'met' && r.state !== 'waived').length,
      reqLate: req.filter((r) => r.state === 'overdue').length,
      reqTotal: req.length,
      docsNew: docs.filter((d) => d.isNew).length,
      docsTotal: docs.length,
      decided: liveCounts?.decided ?? new Set(dec.map((d) => d.benefitLineId)).size,
      toDecide: liveCounts?.toDecide ?? wbs.length,
      paid: liveCounts?.paid ?? pays.filter((p) => p.status.tone === 'positive').length,
      scheduled: liveCounts?.scheduled ?? pays.filter((p) => p.status.tone === 'info').length,
      comms: comms.length,
      tasksOpen: tasks.filter((t) => !t.done).length,
      notes: notes.length,
    }, 0)
  }, [claimId])
  return data
}
