import { useEffect, useState, useSyncExternalStore } from 'react'
import { getVersion, subscribe } from './store'
import { LIVE } from './live/config'
import { isAbort, withAmbientSignal } from './live/http'

export interface QueryResult<T> {
  data: T | undefined
  loading: boolean
  error: Error | undefined
}

/**
 * Runs an async API call and re-runs it whenever the mock store changes or deps change.
 * Keeps the previous data while refetching so screens don't flicker after an action.
 * In live mode each run also gets an AbortSignal (live http calls pick it up), aborted when the screen goes away
 * or the query runs again, so a stale request never lands.
 */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryResult<T> {
  const version = useSyncExternalStore(subscribe, getVersion)
  const [state, setState] = useState<QueryResult<T>>({ data: undefined, loading: true, error: undefined })
  const key = JSON.stringify(deps)

  useEffect(() => {
    let live = true
    const ctl = new AbortController()
    setState((s) => ({ ...s, loading: true }))
    const run = LIVE ? withAmbientSignal(ctl.signal, fn) : fn()
    run.then(
      (data) => live && setState({ data, loading: false, error: undefined }),
      (error: Error) => live && !isAbort(error) && setState({ data: undefined, loading: false, error }),
    )
    return () => {
      live = false
      ctl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version])

  // When deps change (a different claim), drop stale data from the previous one.
  const [lastKey, setLastKey] = useState(key)
  if (key !== lastKey) {
    setLastKey(key)
    setState({ data: undefined, loading: true, error: undefined })
  }

  return state
}
