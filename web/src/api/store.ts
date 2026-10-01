/**
 * In-memory mock server. Each resource is a collection seeded from fixtures; reads return copies
 * after a short delay, like a network call. Every write bumps a version so open screens refetch.
 * Replace the functions in api/*.ts with fetch calls to the real API — the screens don't change.
 */
type Listener = () => void

let version = 0
const listeners = new Set<Listener>()

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getVersion(): number {
  return version
}

function commit(): void {
  version++
  listeners.forEach((l) => l())
}

/** Live mode: the server's data changed, so every open query should refetch. */
export function invalidate(): void {
  commit()
}

const LATENCY_MS = 90

export function respond<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms))
}

export function fail(message: string, ms = LATENCY_MS): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

let seq = 1000
export function newId(prefix: string): string {
  seq++
  return `${prefix}-${seq}`
}

export interface Collection<T extends { id: string }> {
  all(): T[]
  where(pred: (item: T) => boolean): T[]
  get(id: string): T | undefined
  insert(item: T): T
  /** Adds at the front — for newest-first streams like history and communications. */
  prepend(item: T): T
  update(id: string, patch: Partial<T> | ((item: T) => Partial<T>)): T | undefined
  remove(id: string): void
}

export function collection<T extends { id: string }>(seed: T[]): Collection<T> {
  let items: T[] = structuredClone(seed)
  return {
    all: () => items,
    where: (pred) => items.filter(pred),
    get: (id) => items.find((i) => i.id === id),
    insert(item) {
      items = [...items, item]
      commit()
      return item
    },
    prepend(item) {
      items = [item, ...items]
      commit()
      return item
    },
    update(id, patch) {
      let updated: T | undefined
      items = items.map((i) => {
        if (i.id !== id) return i
        const p = typeof patch === 'function' ? patch(i) : patch
        updated = { ...i, ...p }
        return updated
      })
      commit()
      return updated
    },
    remove(id) {
      items = items.filter((i) => i.id !== id)
      commit()
    },
  }
}
