import { WORK_ITEMS } from './fixtures/work'
import { collection, respond } from './store'
import { LIVE } from './live/config'
import { samplesShown } from './live/mode'
import * as live from './live/data'
import type { WorkItem } from './types'

export const workItems = collection<WorkItem>(WORK_ITEMS)

/** GET /work-items?owner={id}&status=open */
export function getQueue(ownerId: string): Promise<WorkItem[]> {
  const mock = () => workItems.where((w) => w.ownerId === ownerId && w.status === 'open')
  if (!LIVE) return respond(mock())
  // Live mode: the backend's open work items for this persona; the mock's sample items only when asked for.
  return live.getQueue(ownerId).then((l) => [...l, ...(samplesShown() ? mock() : [])])
}

/** Marks the open work items for a claim + section done — called when the action they point to is taken. */
export function completeWork(claimId: string, section?: string): void {
  workItems
    .where((w) => w.claimId === claimId && w.status === 'open' && (!section || w.section === section))
    .forEach((w) => workItems.update(w.id, { status: 'done' }))
}

export function snoozeWork(id: string): Promise<void> {
  workItems.update(id, { status: 'snoozed' })
  return respond(undefined)
}
