import { STAFF, USERS } from './fixtures/users'
import type { User } from './types'

/** Synchronous lookup for display — names don't change during a session. */
export function userById(id: string): User | undefined {
  return USERS.find((u) => u.id === id)
}

export function personName(id: string): { name: string; initials: string; title: string } {
  const u = userById(id)
  if (u) return { name: u.name, initials: u.initials, title: u.title }
  return STAFF[id] ?? { name: id, initials: id.slice(0, 2).toUpperCase(), title: '' }
}
