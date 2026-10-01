import { useEffect, useMemo, useRef } from 'react'
import type { YesNo } from '../api/intake'

/** A phone call as the intake page shows it. */
export interface CallInfo {
  inbound: string
  /** 'HH:MM' the call started. */
  started: string
  /** Seconds already on the call when the page opens. */
  elapsed: number
  language: string
}

export type CallState = 'live' | 'hold' | 'ended'

export const YES_NO: { value: YesNo; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
]

export const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

// ---------------------------------------------------------------- Call clock

/** The call's running time, kept outside render so saves and history can stamp the call clock. */
export function useCallClock(initialElapsed: number) {
  const base = useRef(0)
  const ended = useRef<number | null>(null)
  useEffect(() => {
    base.current = Date.now() - initialElapsed * 1000
  }, [initialElapsed])
  return useMemo(
    () => ({
      elapsed: () => (base.current ? Math.floor(((ended.current ?? Date.now()) - base.current) / 1000) : initialElapsed),
      end: () => {
        ended.current = Date.now()
      },
    }),
    [initialElapsed],
  )
}

export type CallClock = ReturnType<typeof useCallClock>

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtElapsed(s: number): string {
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/** Wall-clock time on the call: calls start 18 seconds past the minute. */
export function clockTime(started: string, elapsedSec: number): string {
  const [h, m] = started.split(':').map(Number)
  const total = h * 3600 + m * 60 + 18 + elapsedSec
  return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}`
}
