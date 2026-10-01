/**
 * Live data: what the screens read and do when the app is in live mode. One claim page needs six resources, so they are
 * fetched together as a Bundle and shared by every section's query (a bundle is reused for a second and a half; a poll
 * replaces it). When a fetch finds that something changed, `invalidate()` tells every open query to read again.
 */
import { invalidate } from '../store'
import type { Claim, Communication, DecisionRecord, HistoryEvent, WorkItem } from '../types'
import type { PaymentRow } from '../payments'
import type { RequirementRecord } from '../requirements'
import type { LifeFlow } from '../lifeFlow'
import { ambientSignal, api, ApiError, etagOf, get, getAll } from './http'
import { clockSource, liveNow } from './clock'
import { inFlight, isWelcomeCall, mapFlow } from './flow'
import { claimStatus, mapClaim, mapHistory, mapLetters, mapRequirements, mapWorkItems, personaOf, stageOf, type Bundle } from './present'
import type {
  ApiClaim, ApiClaimSummary, ApiDeadline, ApiDecision, ApiDocument, ApiHistoryEvent, ApiLetter, ApiPaymentItem, ApiPaymentRun, ApiRecordDecisionResult, ApiRequirement, ApiWorkItem, ApiWorkflowRun, LifeIntakeRequest,
} from './types'
import { awaitingDecision, lineToDecide, mapDecisions } from './decisions'
import { mapPaymentRows } from './payments'
import { mapDocuments } from './documents'
import type { DocumentRecord } from '../documents'
import { ensureStaff, staffById } from './staff'
import { day } from './time'

// ---------------------------------------------------------------- Ids

const idOf = new Map<string, string>()
const numberOf = new Map<string, string>()

function remember(claimNumber: string, id: string): void {
  idOf.set(claimNumber, id)
  numberOf.set(id, claimNumber)
}

/** claimNumber -> UUID. The API filters claims by number (`GET /claims?claimNumber=`), so this is one call, then cached. */
async function resolve(claimNumber: string, signal?: AbortSignal): Promise<string> {
  const known = idOf.get(claimNumber)
  if (known) return known
  const page = await get<{ items: ApiClaimSummary[] }>('/claims', { query: { claimNumber }, signal })
  const hit = page.items.find((c) => c.claimNumber === claimNumber)
  if (!hit) throw new ApiError(404, 'not_found', 'Claim not found', `No claim ${claimNumber} on the backend`)
  remember(claimNumber, hit.id)
  return hit.id
}

// ---------------------------------------------------------------- Bundles

interface Entry { bundle?: Bundle; inflight?: Promise<Bundle>; signature?: string }
const entries = new Map<string, Entry>()
const FRESH_MS = 1500

async function fetchBundle(claimNumber: string): Promise<Bundle> {
  const id = await resolve(claimNumber)
  const base = `/claims/${id}`
  const [claim, requirements, deadlines, runs, letters, history, decisions, paymentItems, documents, openItems] = await Promise.all([
    get<ApiClaim>(base),
    getAll<ApiRequirement>(`${base}/requirements`),
    getAll<ApiDeadline>(`${base}/deadlines`),
    getAll<ApiWorkflowRun>(`${base}/workflow-runs`),
    getAll<ApiLetter>(`${base}/letters`),
    getAll<ApiHistoryEvent>(`${base}/history`, { limit: 200 }),
    getAll<ApiDecision>(`${base}/decisions`),
    getAll<ApiPaymentItem>(`${base}/payment-items`),
    getAll<ApiDocument>(`${base}/documents`),
    // There is no per-claim work item list: read the open ones and keep this claim's.
    getAll<ApiWorkItem>('/work-items', { status: 'open', limit: 500 }, undefined, 1),
    ensureStaff(),
  ])
  return { claim, requirements, deadlines, runs, letters, history, decisions, paymentItems, documents, workItems: openItems.filter((w) => w.claimId === id), fetchedAt: performance.now() }
}

function signatureOf(b: Bundle): string {
  return JSON.stringify([b.claim, b.requirements, b.deadlines, b.runs, b.letters, b.history.length, b.history[0]?.id, b.decisions, b.paymentItems, b.documents, b.workItems])
}

/** Makes a shared promise stop only this caller's wait when its signal aborts. */
function detach<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p
  return new Promise<T>((res, rej) => {
    if (signal.aborted) return rej(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')), { once: true })
    p.then(res, rej)
  })
}

/** The claim's bundle. Reused if young and shared by concurrent readers; `signal` only stops this caller waiting. */
export function bundleFor(claimNumber: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<Bundle> {
  const e = entries.get(claimNumber) ?? {}
  entries.set(claimNumber, e)
  let p: Promise<Bundle>
  if (!opts.force && e.bundle && performance.now() - e.bundle.fetchedAt < FRESH_MS) p = Promise.resolve(e.bundle)
  else if (e.inflight) p = e.inflight
  else {
    e.inflight = fetchBundle(claimNumber).then(
      (b) => {
        e.bundle = b
        e.inflight = undefined
        const sig = signatureOf(b)
        const changed = e.signature !== undefined && e.signature !== sig
        e.signature = sig
        if (changed) queueMicrotask(invalidate)
        return b
      },
      (err) => {
        e.inflight = undefined
        throw err
      },
    )
    p = e.inflight
  }
  return detach(p, opts.signal ?? ambientSignal())
}

/** The claim number a requirement belongs to, from the bundles we hold. */
export function claimOfRequirement(requirementId: string): string | undefined {
  for (const [number, e] of entries) if (e.bundle?.requirements.some((r) => r.id === requirementId)) return number
  return undefined
}

export function cachedBundle(claimNumber: string): Bundle | undefined {
  return entries.get(claimNumber)?.bundle
}

// ---------------------------------------------------------------- Reads behind the mock's API functions

export async function getClaim(claimNumber: string): Promise<Claim> {
  return mapClaim(await bundleFor(claimNumber), liveNow())
}

/** Synchronous read for the workspace tabs: what we already hold about a claim. */
export function claimSummary(claimNumber: string): Pick<Claim, 'id' | 'name' | 'exceptions' | 'family'> | undefined {
  const b = cachedBundle(claimNumber)
  if (!b) return undefined
  return { id: claimNumber, name: b.claim.insured.name, family: b.claim.family, exceptions: mapClaim(b, liveNow()).exceptions }
}

export async function getRequirements(claimNumber: string): Promise<RequirementRecord[]> {
  return mapRequirements(await bundleFor(claimNumber), liveNow())
}

export async function getCommunications(claimNumber: string): Promise<Communication[]> {
  return mapLetters(await bundleFor(claimNumber))
}

export async function getHistory(claimNumber: string): Promise<HistoryEvent[]> {
  return mapHistory(await bundleFor(claimNumber))
}

export async function listDocuments(claimNumber: string): Promise<DocumentRecord[]> {
  return mapDocuments(await bundleFor(claimNumber))
}

export async function getFlow(claimNumber: string): Promise<LifeFlow> {
  return mapFlow(await bundleFor(claimNumber), liveNow(), clockSource())
}

// ---------------------------------------------------------------- The queue

interface QueueSnapshot { claims: ApiClaimSummary[]; items: ApiWorkItem[] }
let queue: { at: number; snapshot: QueueSnapshot; signature: string } | undefined
let queueInflight: Promise<QueueSnapshot> | undefined

async function fetchQueue(): Promise<QueueSnapshot> {
  const [claims, items] = await Promise.all([
    getAll<ApiClaimSummary>('/claims', { limit: 100 }),
    getAll<ApiWorkItem>('/work-items', { status: 'open', limit: 500 }, undefined, 1),
    ensureStaff(),
  ])
  claims.forEach((c) => remember(c.claimNumber, c.id))
  return { claims, items }
}

/** The claims list and open work items, shared by the queue, the tabs and the palette. */
export function queueSnapshot(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<QueueSnapshot> {
  let p: Promise<QueueSnapshot>
  if (!opts.force && queue && Date.now() - queue.at < FRESH_MS) p = Promise.resolve(queue.snapshot)
  else if (queueInflight) p = queueInflight
  else {
    queueInflight = fetchQueue().then(
      (s) => {
        const sig = JSON.stringify(s)
        const changed = queue !== undefined && queue.signature !== sig
        queue = { at: Date.now(), snapshot: s, signature: sig }
        queueInflight = undefined
        if (changed) queueMicrotask(invalidate)
        return s
      },
      (err) => {
        queueInflight = undefined
        throw err
      },
    )
    p = queueInflight
  }
  return detach(p, opts.signal ?? ambientSignal())
}

/** A claim list row, as the queue and the palette show it. Only what the summary carries; the workspace reads the full claim. */
function summaryToClaim(s: ApiClaimSummary): Claim {
  const st = claimStatus(s.status)
  return {
    id: s.claimNumber,
    live: true,
    family: s.family,
    product: s.productCode,
    name: s.insuredName,
    tags: [{ label: 'Live', tone: 'info' }, ...(s.track ? [{ label: s.track === 'fast_track_life' ? 'Fast track' : 'Standard', tone: 'plain' as const }] : [])],
    facts: [`Insured · ${s.insuredName}`, `${st.label} · ${s.productCode} · ${s.claimNumber}`],
    ownerId: personaOf(s.ownerId),
    team: 'Life & annuity team',
    filed: day(s.noticedAt),
    stage: stageOf(s.status),
    clocks: [],
    nextStep: { label: 'Open the claim', reason: st.label, section: 'workflow' },
    exceptions: [],
    benefitLines: [],
    parties: [],
    summary: { text: `${s.insuredName} · ${st.label}`, asOf: 'from the claims API', sources: [] },
    suggestions: [],
    linked: [],
    sections: ['overview', 'workflow', 'requirements', 'communications', 'history'],
  }
}

export async function listClaims(ownerId?: string): Promise<Claim[]> {
  const { claims } = await queueSnapshot()
  return claims.map(summaryToClaim).filter((c) => !ownerId || c.ownerId === ownerId || c.ownerId === 'Unassigned')
}

export async function searchClaims(q: string): Promise<Claim[]> {
  const s = q.trim().toLowerCase()
  const all = await listClaims()
  return (s ? all.filter((c) => `${c.name} ${c.id} ${c.product}`.toLowerCase().includes(s)) : all).slice(0, 12)
}

/** The current persona's open work. The team lead sees everything; the examiner sees what is theirs or unassigned. */
export async function getQueue(persona: string): Promise<WorkItem[]> {
  const { items } = await queueSnapshot()
  const all = mapWorkItems(items, (id) => numberOf.get(id), liveNow())
  // Staff are mapped to personas by the directory (GET /staff): a person sees what is theirs or nobody's; the team lead sees the team's.
  if (persona === 'monica') return all
  return all.filter((w) => w.ownerId === persona || w.ownerId === 'Unassigned')
}

// ---------------------------------------------------------------- Actions

async function afterChange(claimNumber: string): Promise<Bundle> {
  const b = await bundleFor(claimNumber, { force: true })
  invalidate()
  boost()
  return b
}

const openState = (s: string) => s === 'requested' || s === 'received' || s === 'not_enough'

/** What a requirement change did elsewhere, in words: rows it closed, a status it moved. */
function effectOf(before: Bundle, after: Bundle, verb: string, name: string): string {
  const closed = after.deadlines.filter((d) => d.state === 'done' && before.deadlines.find((x) => x.id === d.id)?.state !== 'done').length
  const parts = [`${name} ${verb}`]
  if (closed) parts.push(`${closed} follow-up ${closed === 1 ? 'row' : 'rows'} closed`)
  if (before.claim.status !== after.claim.status) {
    const written = after.deadlines.filter((d) => !before.deadlines.some((x) => x.id === d.id)).map((d) => d.kind)
    parts.push(`claim is now ${claimStatus(after.claim.status).label.toLowerCase()}${written.length ? ` · ${written.join(' and ')} rows written` : ''}`)
  }
  return parts.join(' · ')
}

async function changeRequirement(claimNumber: string, requirementId: string, action: 'accept' | 'waive', body: unknown, verb: string): Promise<RequirementRecord> {
  const before = await bundleFor(claimNumber, { force: true })
  const name = before.requirements.find((r) => r.id === requirementId)?.name ?? 'Requirement'
  // The ETag of the requirement as the server has it right now.
  const current = await api<ApiRequirement>('GET', `/requirements/${requirementId}`)
  const etag = current.etag ?? etagOf(current.data.version)
  if (!openState(current.data.state)) throw new ApiError(409, 'invalid_state', 'Already closed', `${name} is already ${current.data.state}`)
  await api<ApiRequirement>('POST', `/requirements/${requirementId}:${action}`, { ifMatch: etag, body })
  const after = await afterChange(claimNumber)
  const rec = mapRequirements(after, liveNow()).find((r) => r.id === requirementId)!
  rec.live = { ...rec.live!, note: effectOf(before, after, verb, name) }
  return rec
}

/** POST /requirements/{id}:accept with the requirement's ETag. */
export function acceptRequirement(claimNumber: string, requirementId: string, satisfiedBy: string): Promise<RequirementRecord> {
  return changeRequirement(claimNumber, requirementId, 'accept', { satisfiedBy }, 'accepted')
}

/** POST /requirements/{id}:waive with the requirement's ETag and a reason. */
export function waiveRequirement(claimNumber: string, requirementId: string, reason: string): Promise<RequirementRecord> {
  return changeRequirement(claimNumber, requirementId, 'waive', { reason }, 'waived')
}

// ---------------------------------------------------------------- Decisions, payments, work items

export async function listDecisions(claimNumber: string): Promise<DecisionRecord[]> {
  return mapDecisions(await bundleFor(claimNumber))
}

export async function listPayments(claimNumber: string): Promise<PaymentRow[]> {
  return mapPaymentRows(await bundleFor(claimNumber))
}

/** The decision, payment and evidence counts the section badges show. */
export async function sectionCounts(claimNumber: string): Promise<{ decided: number; toDecide: number; paid: number; scheduled: number }> {
  const b = await bundleFor(claimNumber)
  const items = b.paymentItems.filter((i) => i.status !== 'cancelled')
  return {
    decided: new Set(b.decisions.map((d) => d.benefitLineId)).size,
    toDecide: lineToDecide(b) ? 1 : 0,
    paid: items.filter((i) => i.status === 'paid').length,
    scheduled: items.filter((i) => i.status === 'cleared' || i.status === 'in_run').length,
  }
}

export interface DecisionOutcome {
  /** 'recorded' (in effect) or 'awaiting_approval' (above the recorder's authority). */
  kind: ApiRecordDecisionResult['kind']
  message: string
  result: ApiRecordDecisionResult
  /** True when the Idempotency-Key was replayed (the same decision was already recorded). */
  replayed: boolean
}

let lastDecisionAttempt: { fingerprint: string; key: string } | undefined

/**
 * POST /claims/{id}/decisions with an Idempotency-Key. X-Actor (the signed-in persona's handle) is the examiner. The same decision
 * sent again (a retry after a lost response) reuses its key, so it cannot be recorded twice; a changed basis is a new attempt.
 * 201 recorded, 202 awaiting approval, 200 replay.
 */
export async function recordDecision(claimNumber: string, args: { benefitLineId: string; basis: string }): Promise<DecisionOutcome> {
  const id = await resolve(claimNumber)
  const body = { benefitLineId: args.benefitLineId, outcome: 'approve', basis: args.basis }
  const fingerprint = `${id}|${JSON.stringify(body)}`
  if (lastDecisionAttempt?.fingerprint !== fingerprint) lastDecisionAttempt = { fingerprint, key: crypto.randomUUID() }
  const res = await api<ApiRecordDecisionResult>('POST', `/claims/${id}/decisions`, { body, idempotencyKey: lastDecisionAttempt.key })
  await afterChange(claimNumber)
  return { kind: res.data.kind, message: res.data.message, result: res.data, replayed: res.replayed }
}

/** POST /decisions/{id}:approve. X-Actor must be a team lead who did not record it. */
export async function approveDecision(claimNumber: string, decisionId: string, note?: string): Promise<ApiRecordDecisionResult> {
  const res = await api<ApiRecordDecisionResult>('POST', `/decisions/${decisionId}:approve`, { body: note?.trim() ? { note: note.trim() } : {} })
  await afterChange(claimNumber)
  return res.data
}

/** The claims waiting for a team lead, with the decision and the approver's work item. For the Team board's approvals. */
export interface AwaitingApproval { claimNumber: string; claim: ApiClaim; decision: ApiDecision; workItem: ApiWorkItem | undefined; related: ApiDecision[] }

export async function awaitingApprovals(): Promise<AwaitingApproval[]> {
  const { claims } = await queueSnapshot()
  const out: AwaitingApproval[] = []
  for (const c of claims.filter((x) => x.status === 'awaiting_approval')) {
    const b = await bundleFor(c.claimNumber)
    const decision = awaitingDecision(b)
    if (!decision) continue
    const lead = b.workItems.find((w) => w.section === 'decision' && staffById(w.ownerId)?.role === 'team_lead')
    out.push({ claimNumber: c.claimNumber, claim: b.claim, decision, workItem: lead, related: b.decisions.filter((d) => d.status === 'awaiting_approval' && d.id !== decision.id) })
  }
  return out
}

/** POST /payment-items/{id}:hold with the ETag of the item as the screen shows it (a change since then is 412). */
export async function holdPaymentItem(claimNumber: string, item: ApiPaymentItem, reason: string): Promise<ApiPaymentItem> {
  try {
    const res = await api<ApiPaymentItem>('POST', `/payment-items/${item.id}:hold`, { ifMatch: etagOf(item.version), body: { reason } })
    await afterChange(claimNumber)
    return res.data
  } catch (e) {
    if (e instanceof ApiError && (e.status === 412 || e.status === 409)) await afterChange(claimNumber)
    throw e
  }
}

/** POST /payment-items/{id}:release with the item's ETag. */
export async function releasePaymentItem(claimNumber: string, item: ApiPaymentItem): Promise<ApiPaymentItem> {
  try {
    const res = await api<ApiPaymentItem>('POST', `/payment-items/${item.id}:release`, { ifMatch: etagOf(item.version) })
    await afterChange(claimNumber)
    return res.data
  } catch (e) {
    if (e instanceof ApiError && (e.status === 412 || e.status === 409)) await afterChange(claimNumber)
    throw e
  }
}

/**
 * POST /documents/{id}:review with the document's ETag (its version) and the acting examiner's X-Actor (the signed-in persona, set for every write).
 * Accept: the requirement is accepted through the normal path. Reject (a reason is required): the requirement is asked for again and the
 * letter workflow runs. Resolves to a sentence saying what it did elsewhere.
 */
export async function reviewDocument(claimNumber: string, doc: ApiDocument, decision: 'accept' | 'reject', reason: string): Promise<string> {
  const before = await bundleFor(claimNumber, { force: true })
  try {
    // The ETag of the document as the server has it right now (the screen's copy may be a poll old).
    const now = await api<ApiDocument>('GET', `/documents/${doc.id}`)
    await api<ApiDocument>('POST', `/documents/${doc.id}:review`, { ifMatch: now.etag ?? etagOf(now.data.version), body: { decision, reason: reason.trim() || undefined } })
  } catch (e) {
    if (e instanceof ApiError && (e.status === 412 || e.status === 409)) await afterChange(claimNumber)
    throw e
  }
  const after = await afterChange(claimNumber)
  const req = doc.requirementName ?? 'The requirement'
  if (decision === 'accept') return effectOf(before, after, 'accepted after review', req)
  return `${req} rejected · asked for again · the "certified copy needed" letter workflow is running`
}

/** POST /workflow-runs/{id}:rerun: ops starts a FAILED run again under the same workflow id (202; the run itself is asynchronous). */
export async function rerunWorkflow(claimNumber: string, runId: string): Promise<string> {
  const res = await api<{ workflowId: string; outcome: 'started' | 'already_started' }>('POST', `/workflow-runs/${runId}:rerun`, { body: {} })
  await afterChange(claimNumber)
  return res.data.outcome === 'started' ? `Started again: ${res.data.workflowId.slice(0, 26)}…` : 'That workflow is already running'
}

/** GET /payment-runs, newest first. */
export async function listPaymentRuns(limit = 20): Promise<ApiPaymentRun[]> {
  return (await get<{ items: ApiPaymentRun[] }>('/payment-runs', { query: { limit } })).items
}

export interface PaymentRunOutcome { run: ApiPaymentRun; replayed: boolean }

/**
 * POST /payment-runs: the daily batch, started by hand for `runDate`. Synchronous: the reply is the finished run. The key names the run
 * date and the items it would take, so a second click for the same items returns the same run, and new items (a released hold, a
 * replacement) get a run of their own.
 */
export async function startPaymentRun(runDate: string, itemIds?: string[]): Promise<PaymentRunOutcome> {
  // From a claim's screen the key names the items (a second click for them returns the same run); the panel's shortcut is a new run each time.
  const key = itemIds ? `web-${runDate}-${[...itemIds].sort().map((x) => x.slice(0, 8)).join('')}`.slice(0, 120).padEnd(8, '-') : `web-${runDate}-${crypto.randomUUID()}`
  const res = await api<ApiPaymentRun>('POST', '/payment-runs', { body: { runDate }, idempotencyKey: key })
  boost()
  invalidate()
  for (const [n, e] of entries) if (e.bundle) void bundleFor(n, { force: true }).catch(() => undefined)
  return { run: res.data, replayed: res.replayed }
}

/** POST /work-items/{id}:complete with the ETag of the item as the screen shows it. Completing the welcome call also meets first_contact_by. */
export async function completeWorkItem(claimNumber: string | undefined, item: { id: string; version: number }): Promise<ApiWorkItem> {
  try {
    const res = await api<ApiWorkItem>('POST', `/work-items/${item.id}:complete`, { ifMatch: etagOf(item.version), body: {} })
    if (claimNumber) await afterChange(claimNumber)
    else { invalidate(); boost() }
    return res.data
  } catch (e) {
    if (e instanceof ApiError && (e.status === 412 || e.status === 409)) { if (claimNumber) await afterChange(claimNumber); else invalidate() }
    throw e
  }
}

/** 'Log call' on a live claim: the welcome call is the one call the backend tracks (as a work item); completing it meets first_contact_by. */
export async function logWelcomeCall(claimNumber: string): Promise<string> {
  const b = await bundleFor(claimNumber, { force: true })
  const item = b.workItems.find((w) => isWelcomeCall(w.action))
  if (!item) throw new ApiError(0, 'nothing_to_log', 'No welcome call to log', 'This claim has no open welcome call. The backend has no call log for other calls yet.')
  await completeWorkItem(claimNumber, item)
  return `Welcome call logged · first contact is met`
}

/** Completes a queue row (My work): reads the item as the server has it, then completes it with that ETag. */
export async function completeQueueItem(id: string): Promise<string> {
  const item = (await queueSnapshot({ force: true })).items.find((w) => w.id === id)
  if (!item) throw new ApiError(404, 'not_found', 'Work item not found', 'That work item is no longer open.')
  await completeWorkItem(numberOf.get(item.claimId), item)
  return isWelcomeCall(item.action) ? 'Welcome call logged · first contact is met' : `Done: ${item.action}`
}

// ---------------------------------------------------------------- Intake

export interface IntakeIssue { field: string; message: string; step: string }

const STEP_OF: [RegExp, string][] = [
  [/^caller/, 'Caller'], [/^(insured|death)/, 'The deceased'], [/^policies/, 'Policies'], [/^(designation|agent)/, 'Beneficiaries'],
]

/** The 422 `validation_failed` field errors, each with the step of the form it belongs to. */
export function intakeIssues(e: ApiError): IntakeIssue[] {
  return e.errors.map((x) => ({ field: x.field, message: x.message, step: STEP_OF.find(([re]) => re.test(x.field))?.[1] ?? 'Review' }))
}

let lastAttempt: { body: string; key: string } | undefined

/**
 * POST /claims/life-intake with an Idempotency-Key. A retry of the same body reuses its key, so a lost response can't make a
 * second claim; a changed body is a new attempt. Resolves to the claim number.
 */
export async function postLifeIntake(request: LifeIntakeRequest): Promise<string> {
  const body = JSON.stringify(request)
  if (lastAttempt?.body !== body) lastAttempt = { body, key: crypto.randomUUID() }
  const res = await api<ApiClaim>('POST', '/claims/life-intake', { body: request, idempotencyKey: lastAttempt.key })
  remember(res.data.claimNumber, res.data.id)
  entries.delete(res.data.claimNumber)
  invalidate()
  boost()
  return res.data.claimNumber
}

// ---------------------------------------------------------------- Polling

let boostUntil = 0
const nudges = new Set<() => void>()

/** Something was just done on the server: poll fast for a while, and poll now. */
export function boost(ms = 20_000): void {
  boostUntil = Date.now() + ms
  nudges.forEach((f) => f())
}

export function onNudge(f: () => void): () => void {
  nudges.add(f)
  return () => nudges.delete(f)
}

/** How soon to look again: fast while something is in flight (or was just done), slower and slower while idle. */
export function nextDelay(b: Bundle | undefined, idleTicks: number): number {
  if (Date.now() < boostUntil || (b && inFlight(b, liveNow()))) return 2000
  return Math.min(15_000, 4000 * 2 ** Math.min(2, Math.floor(idleTicks / 3)))
}
