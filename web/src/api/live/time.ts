import { LIVE_ZONE } from './config'

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: LIVE_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function parts(iso: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(iso))) out[p.type] = p.value
  return out
}

/** An RFC 3339 instant as the mock's local stamp, '2026-09-25T10:03', in the business zone. */
export function stamp(iso: string): string {
  const p = parts(iso)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** An RFC 3339 instant as a business-zone date, '2026-09-25'. */
export function day(iso: string): string {
  return stamp(iso).slice(0, 10)
}

/** '41 s', '1 min 14 s'; undefined while the run has not finished. */
export function took(startedAt: string, finishedAt: string | null): string | undefined {
  if (!finishedAt) return undefined
  const ms = Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime())
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(1)} s`
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}
