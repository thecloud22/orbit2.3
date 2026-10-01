/**
 * The staff directory (GET /staff): who the `ownerId` and `recordedBy` UUIDs are, which handle `X-Actor` takes, and how much
 * each person may approve. Read once (it does not change during a demo) and then looked up synchronously by the mappers.
 * The mock's personas that share a handle with a staff user (rachel, monica) are the same people; the others (jordan, irene)
 * are not on the backend.
 */
import { getAll } from './http'
import type { ApiStaff } from './types'

let list: ApiStaff[] = []
let version = 0
let loading: Promise<ApiStaff[]> | undefined
const subs = new Set<() => void>()

/** Reads the directory once. A failure is not fatal (the screens fall back to what they know); the next call tries again. */
export function ensureStaff(): Promise<ApiStaff[]> {
  if (!loading) {
    loading = getAll<ApiStaff>('/staff').then(
      (s) => {
        list = s
        version++
        subs.forEach((f) => f())
        return s
      },
      () => {
        loading = undefined
        return list
      },
    )
  }
  return loading
}

export const staffList = (): ApiStaff[] => list
export const staffById = (id: string | null | undefined): ApiStaff | undefined => (id ? list.find((s) => s.id === id) : undefined)
export const staffByHandle = (handle: string): ApiStaff | undefined => list.find((s) => s.handle === handle)
export const staffLoaded = (): boolean => list.length > 0

/** For useSyncExternalStore: a number that changes when the directory arrives. */
export const staffVersion = (): number => version
export function subscribeStaff(f: () => void): () => void {
  subs.add(f)
  return () => subs.delete(f)
}

/** The persona id a staff UUID stands for: the handle (`rachel`, `monica`), which the mock's personas share. */
export function personaFor(ownerId: string | null | undefined): string {
  if (!ownerId) return 'Unassigned'
  return staffById(ownerId)?.handle ?? 'Unassigned'
}

export function staffName(ownerId: string | null | undefined): string {
  return staffById(ownerId)?.name ?? 'Unassigned'
}

/** The payout limit of a staff user, in dollars. */
export function limitOf(s: ApiStaff | undefined): number | undefined {
  return s ? Number.parseFloat(s.payoutLimit.amount) : undefined
}
