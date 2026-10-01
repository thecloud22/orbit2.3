import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { userById } from '../api/users'
import { USERS } from '../api/fixtures/users'
import { LIVE } from '../api/live/config'
import { setActor } from '../api/live/http'
import { ensureStaff, limitOf, staffByHandle, staffLoaded, staffVersion, subscribeStaff } from '../api/live/staff'
import type { User } from '../api/types'

type Density = 'comfortable' | 'compact'

interface Session {
  user: User
  /** Who can be signed in as: the mock's four personas, or in live mode the ones the backend's staff directory knows. */
  personas: User[]
  switchUser: (id: string) => void
  tabs: string[]
  openTab: (claimId: string) => void
  closeTab: (claimId: string) => void
  density: Density
  setDensity: (d: Density) => void
}

const DEFAULT_TABS: Record<string, string[]> = {
  rachel: ['L-26-038907', 'L-26-040112', 'L-26-035120'],
  jordan: ['D-25-018334', 'D-26-073390', 'D-25-029116'],
  irene: ['A-26-015530', 'A-19-004418'],
  monica: ['L-26-035120'],
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — the session still works in memory */
  }
}

const NO_TABS: string[] = []

/** Live mode: the backend's staff directory is the truth for name, title and authority (its limit, not the mock's). */
function withStaff(u: User): User {
  const row = staffByHandle(u.id)
  if (!row) return u
  const limit = limitOf(row) ?? u.payoutLimit
  // The mock's notes quote its own limits ('Payouts to $2,000,000'); say the backend's.
  const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(limit)
  return { ...u, name: row.name, title: row.title ?? u.title, team: row.team, payoutLimit: limit, authorityNotes: u.authorityNotes.map((n) => n.replace(/\$[\d,]+/, dollars)) }
}
const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string>(() => read('claims.user', 'rachel'))
  const [tabsByUser, setTabsByUser] = useState<Record<string, string[]>>(LIVE ? {} : DEFAULT_TABS)
  const [density, setDensityState] = useState<Density>(() => read('claims.density', 'comfortable'))

  const staffV = useSyncExternalStore(subscribeStaff, staffVersion)
  useEffect(() => {
    if (LIVE) void ensureStaff()
  }, [])
  // Live mode: only people the backend knows can sign in (a persona that is not staff has no X-Actor the API accepts).
  const personas = useMemo(
    () => (LIVE && staffLoaded() ? USERS.filter((u) => staffByHandle(u.id)).map(withStaff) : USERS),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [staffV],
  )
  const user = personas.find((u) => u.id === userId) ?? personas.find((u) => u.id === 'rachel') ?? userById('rachel')!
  const tabs = tabsByUser[user.id] ?? NO_TABS

  // Live mode: the API has no sign-in yet; it takes the acting person's handle from X-Actor (`rachel`, `monica`), which is what the
  // authority check and the approval rules look at.
  useEffect(() => {
    if (LIVE) setActor(user.id)
  }, [user.id])

  const switchUser = useCallback((id: string) => {
    setUserId(id)
    write('claims.user', id)
  }, [])

  const openTab = useCallback(
    (claimId: string) =>
      setTabsByUser((t) => {
        const cur = t[user.id] ?? []
        return cur.includes(claimId) ? t : { ...t, [user.id]: [...cur, claimId].slice(-6) }
      }),
    [user.id],
  )

  const closeTab = useCallback(
    (claimId: string) => setTabsByUser((t) => ({ ...t, [user.id]: (t[user.id] ?? []).filter((c) => c !== claimId) })),
    [user.id],
  )

  const setDensity = useCallback((d: Density) => {
    setDensityState(d)
    write('claims.density', d)
  }, [])

  const value = useMemo(
    () => ({ user, personas, switchUser, tabs, openTab, closeTab, density, setDensity }),
    [user, personas, switchUser, tabs, openTab, closeTab, density, setDensity],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

/** Where each role lands. */
export function homeFor(user: User): string {
  return user.role === 'teamLead' ? '/team' : '/work'
}
