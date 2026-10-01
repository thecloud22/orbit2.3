/**
 * Demo controls: the backend's development endpoints (a virtual clock, `/dev/...`), used only in live mode. They exist only on
 * a backend started for demos; on any other a 404 means "not enabled" and the panel says so instead of failing.
 */
import { api, ApiError, get } from './http'
import { applyToday, resetToBrowserClock, syncClock } from './clock'
import type { DevState } from './guide'

export interface ClockInfo {
  /** The backend's virtual "now", RFC 3339. */
  now: string
  /** False when the backend runs on the real clock. */
  virtual: boolean
  frozen: boolean
}

export type ClockState = { available: true; clock: ClockInfo } | { available: false; reason: string }

/** GET /dev/clock (api/openapi.yaml, DevClock): `now` is the virtual time, `offsetSeconds` its distance from real time. */
function parseClock(raw: unknown): ClockInfo {
  const o = (raw ?? {}) as Record<string, unknown>
  if (typeof o.now !== 'string' || Number.isNaN(Date.parse(o.now))) throw new ApiError(0, 'unexpected_response', 'Unexpected clock response', 'GET /dev/clock did not return a time')
  // The endpoint exists, so the backend's clock is the one to use, even while its offset is zero. It ticks in real time.
  return { now: o.now, virtual: o.virtual === true, frozen: false }
}

let unavailable: string | undefined
let last: { at: number; state: ClockState } | undefined

function adopt(c: ClockInfo): ClockInfo {
  syncClock(c.now, { virtual: true, frozen: c.frozen })
  return c
}

/** GET /dev/clock (at most about once a second unless forced). A 404 or 405 means the backend has no demo controls. */
export async function readClock(force = false): Promise<ClockState> {
  if (unavailable && !force) return { available: false, reason: unavailable }
  if (!force && last && Date.now() - last.at < 800) return last.state
  try {
    const clock = adopt(parseClock(await get<unknown>('/dev/clock')))
    unavailable = undefined
    last = { at: Date.now(), state: { available: true, clock } }
    return last.state
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) {
      unavailable = 'Demo controls not enabled on this backend'
      resetToBrowserClock()
      last = { at: Date.now(), state: { available: false, reason: unavailable } }
      return last.state
    }
    applyToday()
    throw e
  }
}

export type Advance = { kind: 'days'; days: number } | { kind: 'nextDeadline' } | { kind: 'toIso'; iso: string }

/** POST /dev/clock:advance with exactly one of `days`, `until: next_deadline` or `toIso` (forward only). Resolves to the clock afterwards. */
export async function advanceClock(step: Advance): Promise<ClockInfo> {
  const body = step.kind === 'days' ? { days: step.days } : step.kind === 'toIso' ? { toIso: step.iso } : { until: 'next_deadline' }
  const res = await api<unknown>('POST', '/dev/clock:advance', { body })
  return adopt(parseClock(res.data))
}

/** POST /dev/clock:reset. */
export async function resetClock(): Promise<ClockInfo> {
  const res = await api<unknown>('POST', '/dev/clock:reset', { body: {} })
  return adopt(parseClock(res.data))
}

/** GET /actuator/health: is the API up at all. */
export async function health(): Promise<boolean> {
  try {
    await get('/actuator/health')
    return true
  } catch {
    return false
  }
}

/** What the dev switches are doing: the fault switches that are on (GET /dev/faults) and returns waiting in the stub bank's file (GET /dev/bank/returns). */
export async function readDevState(): Promise<DevState> {
  const [f, r] = await Promise.all([
    get<{ active?: { name: string }[] }>('/dev/faults').catch(() => undefined),
    get<{ items?: unknown[] }>('/dev/bank/returns').catch(() => undefined),
  ])
  return { faults: (f?.active ?? []).map((x) => x.name), returnsQueued: r?.items?.length ?? 0 }
}

/**
 * 11:30 in the business zone on `date` (YYYY-MM-DD), as an instant: what the panel's "Go to" sends to POST /dev/clock:advance {toIso}.
 * Tried at the two UTC offsets Chicago uses (UTC-5 in summer, UTC-6 in winter), whichever reads 11:30 there.
 */
export function elevenThirty(date: string, zone: string): string {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  for (const utc of ['16:30', '17:30']) {
    const t = new Date(`${date}T${utc}:00Z`)
    if (hm.format(t) === '11:30') return t.toISOString()
  }
  return new Date(`${date}T17:30:00Z`).toISOString()
}
