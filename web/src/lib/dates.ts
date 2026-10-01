// The mock runs on a fixed "today" so clocks and due dates match the canvas story.
// Live mode (src/api/live) moves it to the backend's clock with setToday(), so countdowns on live claims are right.
export let TODAY = '2026-09-25'
export let NOW_TIME = '09:30'

/** Live mode only: the date and time the app treats as now. */
export function setToday(date: string, time: string): void {
  TODAY = date
  NOW_TIME = time
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function parse(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** '2026-10-03' → '3 Oct'; adds the year when it differs from today's. */
export function fmtDate(iso: string, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const d = parse(iso)
  const showYear = opts.year ?? d.getUTCFullYear() !== parse(TODAY).getUTCFullYear()
  const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${showYear ? ` ${d.getUTCFullYear()}` : ''}`
  return opts.weekday ? `${DAYS[d.getUTCDay()]} ${base}` : base
}

/** '2026-09-25T09:14' → '09:14' */
export function fmtTime(iso: string): string {
  return iso.length > 10 ? iso.slice(11, 16) : ''
}

/** Today → 'Today', else '3 Oct' */
export function fmtRelativeDay(iso: string): string {
  const n = daysFrom(TODAY, iso)
  if (n === 0) return 'Today'
  if (n === -1) return 'Yesterday'
  if (n === 1) return 'Tomorrow'
  return fmtDate(iso)
}

/** Whole days from a to b (b − a). */
export function daysFrom(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000)
}

export function daysUntil(iso: string): number {
  return daysFrom(TODAY, iso)
}

export function daysSince(iso: string): number {
  return daysFrom(iso, TODAY)
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${Math.abs(n) === 1 ? word : pluralWord}`
}

/** '8 days', '1 day', 'today', '3 days late' */
export function fmtCountdown(iso: string): string {
  const n = daysUntil(iso)
  if (n === 0) return 'today'
  if (n < 0) return `${plural(-n, 'day')} late`
  return plural(n, 'day')
}

export function addDays(iso: string, n: number): string {
  const d = parse(iso)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function nowStamp(): string {
  return `${TODAY}T${NOW_TIME}`
}

/** Adds business days (Mon–Fri); holidays aren't modelled in the mock. */
export function addBusinessDays(iso: string, n: number): string {
  let d = iso.slice(0, 10)
  let left = n
  while (left > 0) {
    d = addDays(d, 1)
    const wd = parse(d).getUTCDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return d
}
