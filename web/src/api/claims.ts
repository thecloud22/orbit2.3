import { CLAIMS } from './fixtures/claims'
import { collection, fail, respond } from './store'
import { logEvent } from './history'
import { addTask } from './tasks'
import { LIVE } from './live/config'
import { isLiveId, registerSampleCheck, samplesShown } from './live/mode'
import * as live from './live/data'
import type { Claim, NextStep, SectionKey } from './types'

export const claims = collection<Claim>(CLAIMS)
registerSampleCheck((id) => !!claims.get(id))

/** Sample claims are marked, in live mode, so they can never be mistaken for the backend's. */
const asSample = (c: Claim): Claim => (LIVE ? { ...c, tags: [{ label: 'Sample', tone: 'special' }, ...c.tags] } : c)

/** GET /claims/{id} */
export function getClaim(id: string): Promise<Claim> {
  if (isLiveId(id)) return live.getClaim(id)
  const c = claims.get(id)
  return c ? respond(asSample(c)) : fail(`Claim ${id} not found`)
}

/** GET /claims?owner= */
export function listClaims(ownerId?: string): Promise<Claim[]> {
  const mock = () => (ownerId ? claims.where((c) => c.ownerId === ownerId) : claims.all()).map(asSample)
  if (!LIVE) return respond(mock())
  return live.listClaims(ownerId).then((l) => [...l, ...(samplesShown() ? mock() : [])])
}

/** GET /search?q= — claims by name, number or policy. */
export function searchClaims(q: string): Promise<Claim[]> {
  if (LIVE) {
    return live.searchClaims(q).then(async (l) => (samplesShown() ? [...l, ...(await searchSamples(q))].slice(0, 12) : l))
  }
  return searchSamples(q)
}

function searchSamples(q: string): Promise<Claim[]> {
  const s = q.trim().toLowerCase()
  if (!s) return respond(claims.all().slice(0, 8))
  return respond(
    claims
      .all()
      .filter((c) =>
        [c.name, c.id, c.product, ...c.benefitLines.map((b) => b.ref), ...c.parties.map((p) => p.name)]
          .join(' ')
          .toLowerCase()
          .includes(s),
      )
      .slice(0, 12),
    40,
  )
}

/** Synchronous read for places that already hold the claim list (tabs, palette). */
export function claimSummary(id: string): Pick<Claim, 'id' | 'name' | 'exceptions' | 'family'> | undefined {
  return isLiveId(id) ? live.claimSummary(id) : claims.get(id)
}

/** POST /claims/{id}/suggestions/{sid}:accept | :dismiss — every choice is logged. */
export function decideSuggestion(claimId: string, suggestionId: string, choice: 'accepted' | 'dismissed', by: string): Promise<void> {
  const c = claims.get(claimId)
  const s = c?.suggestions.find((x) => x.id === suggestionId)
  if (!c || !s) return fail('Suggestion not found')
  claims.update(claimId, {
    suggestions: c.suggestions.map((x) => (x.id === suggestionId ? { ...x, state: choice } : x)),
  })
  logEvent(claimId, {
    type: 'assistant',
    title: `Suggestion ${choice}: ${s.title}`,
    actor: `${by} · assistant suggestion`,
    detail: choice === 'accepted' && s.creates ? `Created: ${s.creates}` : undefined,
  })
  if (choice === 'accepted' && s.creates) addTask(claimId, s.creates, by, 'Assistant suggestion')
  return respond(undefined)
}

/** Internal: move the claim along after an action (the backend's workflow would do this). */
export function patchClaim(id: string, patch: Partial<Claim> | ((c: Claim) => Partial<Claim>)): void {
  claims.update(id, patch)
}

export function setNextStep(id: string, next: NextStep): void {
  claims.update(id, { nextStep: next })
}

export function resolveException(claimId: string, exceptionId: string, by: string): Promise<void> {
  const c = claims.get(claimId)
  const x = c?.exceptions.find((e) => e.id === exceptionId)
  if (!c || !x) return fail('Exception not found')
  claims.update(claimId, { exceptions: c.exceptions.map((e) => (e.id === exceptionId ? { ...e, status: 'resolved' } : e)) })
  logEvent(claimId, { type: 'data', title: `Exception resolved: ${x.title}`, actor: by })
  return respond(undefined)
}

export const SECTION_LABELS: Record<SectionKey, string> = {
  overview: 'Overview',
  workflow: 'Workflow & SLA',
  policies: 'Policies & riders',
  people: 'People & roles',
  requirements: 'Requirements',
  documents: 'Documents',
  contestable: 'Contestable review',
  medical: 'Medical',
  financials: 'Financials',
  decision: 'Decision',
  payments: 'Payments',
  distributions: 'Distributions',
  'case-plan': 'Case plan',
  communications: 'Communications',
  history: 'History',
}

export function sectionLabel(claim: Pick<Claim, 'family'>, key: SectionKey): string {
  if (key === 'policies' && claim.family === 'annuity') return 'Contract & riders'
  return SECTION_LABELS[key]
}
