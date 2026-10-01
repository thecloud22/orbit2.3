import { LIVE } from './config'

/**
 * Which claims are live. In live mode a claim id is a backend claim number unless the mock holds a claim with that id (the
 * sample claims, and anything the mock's own intakes create). `claims.ts` registers that check when it loads.
 */
let isSample: (id: string) => boolean = () => false

export function registerSampleCheck(f: (id: string) => boolean): void {
  isSample = f
}

export function isLiveId(id: string): boolean {
  return LIVE && !isSample(id)
}

// ---------------------------------------------------------------- Sample claims beside live ones

const KEY = 'claims.showSamples'
let showSamples = false
try {
  showSamples = localStorage.getItem(KEY) === '1'
} catch {
  /* storage unavailable; the choice lasts for this page load */
}

/** Live mode: also list the mock's sample claims in the queue and search, marked as samples. Off by default. */
export function samplesShown(): boolean {
  return LIVE && showSamples
}

export function setSamplesShown(on: boolean): void {
  showSamples = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}
