/**
 * Live mode: the app talks to the real Claims API instead of the in-memory mock.
 *
 * Switched on by VITE_API_BASE (for example `/api`, which the Vite dev server proxies to the backend and strips,
 * because the API has no CORS). With it unset, nothing in src/api/live runs and the app is exactly the mock.
 */
const raw = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ?? ''

export const LIVE: boolean = raw !== ''

/** No trailing slash. */
export const API_BASE: string = raw.replace(/\/+$/, '')

/** The business zone the backend uses for '08:00 local' deadlines; instants are shown in it. */
export const LIVE_ZONE: string = (import.meta.env.VITE_LIVE_ZONE as string | undefined)?.trim() || 'America/Chicago'
