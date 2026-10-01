import { HISTORY } from './fixtures/history'
import { collection, newId, respond } from './store'
import { nowStamp } from '../lib/dates'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import type { HistoryEvent } from './types'

export const history = collection<HistoryEvent>(HISTORY)

/** GET /claims/{id}/history — newest first. */
export function listHistory(claimId: string): Promise<HistoryEvent[]> {
  if (isLiveId(claimId)) return live.getHistory(claimId)
  return respond(history.where((h) => h.claimId === claimId).sort((a, b) => b.at.localeCompare(a.at)))
}

/** Append-only. Every action in the mock writes here, as the backend's audit table would. */
export function logEvent(claimId: string, e: Omit<HistoryEvent, 'id' | 'claimId' | 'at'> & { at?: string }): void {
  history.prepend({ id: newId('h'), claimId, at: e.at ?? nowStamp(), ...e })
}
