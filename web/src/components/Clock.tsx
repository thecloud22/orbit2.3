import type { ClaimClock } from '../api/types'
import { daysSince, fmtCountdown, fmtDate, plural } from '../lib/dates'

const STATE_TEXT: Record<ClaimClock['state'], string> = {
  running: '',
  paused: 'paused',
  extended: 'extended',
  breached: 'breached',
  met: 'met',
}

/** A regulatory clock: label, value and a thin bar. Deadline bars fill; accruing clocks are dashed. */
export function Clock({ clock, width = 200 }: { clock: ClaimClock; width?: number }) {
  const value =
    clock.valueText ??
    (clock.kind === 'accruing' && clock.start
      ? plural(daysSince(clock.start), 'day')
      : clock.due
        ? `${fmtDate(clock.due)} · ${fmtCountdown(clock.due)}`
        : '')
  const state = STATE_TEXT[clock.state]
  const barColor = clock.state === 'breached' ? 'var(--critical-ink)' : clock.state === 'met' ? 'var(--positive-bar)' : 'var(--ink-3)'
  return (
    <div className="clock" style={{ minWidth: width }}>
      <div className="clock-row">
        <span className="muted nowrap">{clock.label}</span>
        <span className="strong nowrap" style={{ color: clock.state === 'breached' ? 'var(--critical-ink)' : undefined }}>
          {clock.state === 'met' ? 'Met' : value}
          {state && clock.state !== 'met' ? ` · ${state}` : ''}
        </span>
      </div>
      {clock.kind === 'accruing' ? (
        <div aria-hidden="true" className="clock-bar clock-bar--accruing" />
      ) : (
        <div aria-hidden="true" className="clock-bar">
          <div style={{ width: `${Math.round((clock.state === 'met' ? 1 : (clock.progress ?? 0)) * 100)}%`, backgroundColor: barColor, height: 4, backgroundImage: clock.state === 'paused' ? 'repeating-linear-gradient(90deg, transparent 0 4px, #FDFCFA 4px 6px)' : undefined }} />
        </div>
      )}
    </div>
  )
}
