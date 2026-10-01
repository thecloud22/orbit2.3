/**
 * The clock live pages run on. The backend may run a virtual clock (GET /dev/clock, demo controls); if it does not, this
 * browser's clock is used. Pages read `liveNow()`; `setToday` (lib/dates) is kept in step so countdowns are right.
 */
import { setToday } from '../../lib/dates'
import { stamp } from './time'

let offsetMs = 0
let virtual = false
let frozen = false
let syncedAt = 0
let frozenAt = 0

export function liveNow(): Date {
  return new Date(frozen ? frozenAt : Date.now() + offsetMs)
}

export function clockSource(): 'virtual' | 'browser' {
  return virtual ? 'virtual' : 'browser'
}

/** The server told us what time it is. `frozen` means the virtual clock only moves when it is advanced. */
export function syncClock(nowIso: string, opts: { virtual: boolean; frozen?: boolean }): void {
  const t = Date.parse(nowIso)
  if (Number.isNaN(t)) return
  virtual = opts.virtual
  frozen = !!opts.frozen
  frozenAt = t
  offsetMs = t - Date.now()
  syncedAt = Date.now()
  applyToday()
}

export function resetToBrowserClock(): void {
  virtual = false
  frozen = false
  offsetMs = 0
  applyToday()
}

export function lastSyncedAt(): number {
  return syncedAt
}

export function applyToday(): void {
  const s = stamp(liveNow().toISOString())
  setToday(s.slice(0, 10), s.slice(11, 16))
}
