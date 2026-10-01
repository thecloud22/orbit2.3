import { useEffect } from 'react'
import { LIVE } from './config'
import { bundleFor, nextDelay, onNudge, queueSnapshot } from './data'
import { readClock } from './demo'
import { applyToday } from './clock'
import type { Bundle } from './present'

/**
 * Keeps a live screen current. While a claim page is open (`claimNumber`) or the queue is (undefined), it reads the server again:
 * every 2 s while something is in flight (a status of `received`, a workflow run that has not finished, a deadline row due and
 * waiting for the dispatcher, or right after an action or a demo control), and less and less often while nothing is. A read
 * that finds a change refreshes every open query. Stops when the screen goes away.
 */
export function useLivePoll(claimNumber: string | undefined, enabled = true): void {
  useEffect(() => {
    if (!LIVE || !enabled) return
    let stop = false
    let running = false
    let again = false
    let idle = 0
    let timer: number | undefined

    const tick = async () => {
      if (running) { again = true; return }
      running = true
      let bundle: Bundle | undefined
      try {
        await readClock().catch(() => undefined)
        applyToday()
        if (claimNumber) bundle = await bundleFor(claimNumber, { force: true })
        else await queueSnapshot({ force: true })
      } catch {
        /* the API may be restarting; keep trying */
      }
      running = false
      if (stop) return
      const delay = nextDelay(bundle, idle)
      idle = delay === 2000 ? 0 : idle + 1
      timer = window.setTimeout(tick, again ? 0 : delay)
      again = false
    }

    timer = window.setTimeout(tick, 1500)
    const off = onNudge(() => {
      window.clearTimeout(timer)
      void tick()
    })
    return () => {
      stop = true
      window.clearTimeout(timer)
      off()
    }
  }, [claimNumber, enabled])
}
