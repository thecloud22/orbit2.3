/**
 * Scenario events for the Demo controls panel: buttons that make something happen on the real backend so a demo can follow one
 * story (a document arrives, the examiner reviews it, the letters service goes down, the bank returns a payment, the payment run pays).
 * The panel lists whatever is registered here, grouped, and disables an event with its reason when the claim on screen can't take it.
 *
 * An event is one or two calls through `api()` (http.ts) and a sentence for the toast. Only events whose endpoint is in api/openapi.yaml
 * and marked implemented are registered; nothing here calls an endpoint the contract does not have:
 *
 *  - payment-run          POST /payment-runs {runDate}                          the daily batch, by hand
 *  - doc-*                POST /claims/{id}/documents                           a document arrives (the event workflow decides)
 *  - review-*             POST /documents/{id}:review {decision}                the examiner accepts or rejects what the rules could not accept
 *  - fault-*              POST /dev/faults {name, enabled | count}              letters.down, tin.no-match, bank.down, worker.stall-once:<activity>
 *  - bank-return          POST /dev/bank/returns then POST /payment-runs/returns:process     the bank returns a paid item (R02), both steps
 *  - bank-return-queue    POST /dev/bank/returns                                the bank's returns file lists the item (nothing else changes yet)
 *  - returns-process      POST /payment-runs/returns:process                    the returns batch reads the file: item returned, claim reopens (by a workflow)
 *  - new-account          POST /claims/{id}/payees/{partyId}:update-payment-method           the payee gives a new account: replacement item
 *  - rerun-failed         POST /workflow-runs/{id}:rerun                        ops starts the failed run again
 *  - overdue-check        POST /deadlines:check-overdue                         the overnight overdue check
 *
 * The screens that show what these do: Documents (list and review), Requirements (not enough, under review), Workflow & SLA (runs, attempts,
 * Re-run), Payments (returned and replacement). The buttons here are the presenter's shortcuts; the review and the re-run also exist on those screens.
 * The Complex scenario checklist in the panel (guide.ts) names these events by key.
 */
import { TODAY } from '../../lib/dates'
import { fmtMoney } from '../../lib/money'
import { api, ApiError, get } from './http'
import { boost, bundleFor, startPaymentRun } from './data'
import { runSentence } from './payments'
import { money, type Bundle } from './present'
import type { ApiDocument, ApiPaymentItem, ApiRequirement, ApiWorkflowRun } from './types'

export interface ScenarioContext {
  /** The live claim on screen (a claim number), or none. */
  claimNumber: string | undefined
  /** What we hold about it (may be a second or two old). */
  bundle: Bundle | undefined
}

export type ScenarioGroup = 'Payment' | 'Documents' | 'Letters, bank and workers' | 'Ops'

export interface ScenarioEvent {
  key: string
  label: string
  /** What it does, one line. */
  hint: string
  group: ScenarioGroup
  /** Why it cannot run now, given the claim on screen; undefined when it can. */
  unavailable?: (ctx: ScenarioContext) => string | undefined
  run: (ctx: ScenarioContext) => Promise<string>
}

// ---------------------------------------------------------------- Helpers

const NEEDS_CLAIM = 'Open a live claim first'
const uuid = () => crypto.randomUUID()
const post = <T>(path: string, body?: unknown, extra: { ifMatch?: string; key?: string } = {}) =>
  api<T>('POST', path, { body: body ?? {}, ifMatch: extra.ifMatch, idempotencyKey: extra.key }).then((r) => r.data)

async function fresh(ctx: ScenarioContext): Promise<Bundle> {
  if (!ctx.claimNumber) throw new ApiError(0, 'no_claim', NEEDS_CLAIM, NEEDS_CLAIM)
  return bundleFor(ctx.claimNumber, { force: true })
}

const openReq = (b: Bundle | undefined, key: string) => b?.requirements.find((r) => r.key === key && (r.state === 'requested' || r.state === 'not_enough'))
const needClaim = (ctx: ScenarioContext) => (ctx.bundle ? undefined : NEEDS_CLAIM)

const documentsOf = (claimId: string) => get<{ items: ApiDocument[] }>(`/claims/${claimId}/documents`).then((r) => r.items)

async function fault(name: string, body: { enabled?: boolean; count?: number }): Promise<void> {
  await post('/dev/faults', { name, ...body })
}

/** The claimant statement that is open: `caller` prefers the caller's own (Diane's); `next` prefers one that is waiting for a correction. */
function pickStatement(b: Bundle | undefined, prefer: 'caller' | 'next' | 'correction'): ApiRequirement | undefined {
  const open = (b?.requirements ?? []).filter((r) => r.key === 'statement' && (r.state === 'requested' || r.state === 'not_enough'))
  const caller = b?.claim.details?.callerPartyId
  if (prefer === 'correction') return open.find((r) => r.state === 'not_enough')
  if (prefer === 'caller') return open.find((r) => r.from.partyId === caller && r.state === 'requested') ?? open.find((r) => r.from.partyId === caller) ?? open[0]
  return open.find((r) => r.state === 'not_enough') ?? open[0]
}

async function sendDocument(ctx: ScenarioContext, key: 'certificate' | 'statement' | 'report', kind: string, attributes: Record<string, unknown>, choose?: (b: Bundle) => ApiRequirement | undefined): Promise<string> {
  const b = await fresh(ctx)
  const r = choose ? choose(b) : openReq(b, key)
  if (!r) throw new ApiError(0, 'nothing_to_do', 'Nothing to send', `No open ${key} requirement on this claim.`)
  const body: Record<string, unknown> = { requirementId: r.id, kind, source: kind === 'death_certificate' ? 'mail_room' : 'portal', attributes }
  if (r.from.partyId) body.partyId = r.from.partyId
  await post(`/claims/${b.claim.id}/documents`, body, { key: uuid() })
  boost()
  return `${r.name} received${r.from.label && !r.name.includes(r.from.label.split(' ')[0]) ? ` from ${r.from.label}` : ''} · the document workflow decides`
}

/** The item the bank returns: the last payee's (Mark's, who is paid the odd cent). */
const returnTarget = (b: Bundle): ApiPaymentItem | undefined => b.paymentItems.filter((i) => i.status === 'paid').at(-1)

async function queueReturn(ctx: ScenarioContext): Promise<ApiPaymentItem> {
  const b = await fresh(ctx)
  const item = returnTarget(b)
  if (!item) throw new ApiError(0, 'nothing_to_do', 'Nothing to return', 'No paid payment on this claim.')
  await post('/dev/bank/returns', { paymentItemId: item.id, reasonCode: 'R02', reasonText: 'Account closed' })
  return item
}

async function processReturns(): Promise<number> {
  const done = await post<{ processed: unknown[] }>('/payment-runs/returns:process')
  boost()
  return done.processed.length
}

const returnedWithoutReplacement = (b: Bundle | undefined): ApiPaymentItem[] =>
  (b?.paymentItems ?? []).filter((i) => i.status === 'returned' && !b!.paymentItems.some((x) => x.replacementOfId === i.id))

// ---------------------------------------------------------------- The registry

export const SCENARIO_EVENTS: ScenarioEvent[] = [
  {
    key: 'payment-run',
    group: 'Payment',
    label: 'Run payment run now',
    hint: 'The daily batch, started by hand for today’s business date: pays every cleared item due on or before it, on all claims',
    run: async () => runSentence((await startPaymentRun(TODAY)).run),
  },
  {
    key: 'bank-down',
    group: 'Payment',
    label: 'Bank unreachable',
    hint: 'bank.down: the next payment run fails and hands its items back (cleared). Switch it off with "Bank back"',
    run: async () => { await fault('bank.down', { enabled: true }); return 'The bank is unreachable: the next payment run will fail and release its items' },
  },
  {
    key: 'bank-up',
    group: 'Payment',
    label: 'Bank back',
    hint: 'Clears bank.down',
    run: async () => { await fault('bank.down', { enabled: false }); return 'The bank is reachable again' },
  },
  {
    key: 'bank-return',
    group: 'Payment',
    label: 'Bank returns a payment, batch processes it',
    hint: 'The bank returns the last payee’s paid item (R02, account closed) and the returns batch processes it: the claim reopens and the payee is written to',
    unavailable: (ctx) => needClaim(ctx) ?? (ctx.bundle!.paymentItems.some((i) => i.status === 'paid') ? undefined : 'No paid payment on this claim'),
    run: async (ctx) => {
      const item = await queueReturn(ctx)
      const n = await processReturns()
      return `${item.payeeName ?? 'Payee'}’s ${fmtMoney(money(item.amount))} came back (R02 account closed) · ${n} return processed · the claim reopens`
    },
  },
  {
    key: 'bank-return-queue',
    group: 'Payment',
    label: 'Bank returns a payment (its file)',
    hint: 'Step 1 of 2: the stub bank’s returns file now lists the last payee’s paid item (R02). Nothing else changes until the returns batch reads it',
    unavailable: (ctx) => needClaim(ctx) ?? (ctx.bundle!.paymentItems.some((i) => i.status === 'paid') ? undefined : 'No paid payment on this claim'),
    run: async (ctx) => {
      const item = await queueReturn(ctx)
      boost()
      return `${item.payeeName ?? 'Payee'}’s ${fmtMoney(money(item.amount))} is in the bank’s returns file (R02 account closed) · the returns batch has not read it yet`
    },
  },
  {
    key: 'returns-process',
    group: 'Payment',
    label: 'Process the bank returns',
    hint: 'Step 2 of 2: POST /payment-runs/returns:process, the returns batch: it marks each returned item and writes an event; a workflow then reopens the claim',
    run: async () => {
      const n = await processReturns()
      return n ? `${n} ${n === 1 ? 'return' : 'returns'} processed · the returned-payment workflow reopens the claim` : 'The bank’s returns file is empty: nothing to process'
    },
  },
  {
    key: 'new-account',
    group: 'Payment',
    label: 'Payee gives a new bank account',
    hint: 'For a payee whose payment came back: stores the new account and makes the replacement payment item',
    unavailable: (ctx) => needClaim(ctx) ?? (returnedWithoutReplacement(ctx.bundle).length ? undefined : 'No returned payment waiting for a new account'),
    run: async (ctx) => {
      const b = await fresh(ctx)
      const item = returnedWithoutReplacement(b)[0]
      if (!item) throw new ApiError(0, 'nothing_to_do', 'Nothing to replace', 'No returned payment is waiting for a new account.')
      const r = await post<{ replacementItems: ApiPaymentItem[] }>(
        `/claims/${b.claim.id}/payees/${item.payeePartyId}:update-payment-method`,
        { kind: 'eft', routingNumber: '021000021', accountNumber: '000123456789', holderName: item.payeeName },
        { key: uuid() },
      )
      boost()
      return `${item.payeeName ?? 'Payee'} gave a new account · ${r.replacementItems.length} replacement ${r.replacementItems.length === 1 ? 'item' : 'items'} cleared for the next run`
    },
  },
  {
    key: 'doc-certificate',
    group: 'Documents',
    label: 'Certified death certificate arrives',
    hint: 'A certified original: the document workflow accepts the requirement',
    unavailable: (ctx) => needClaim(ctx) ?? (openReq(ctx.bundle, 'certificate') ? undefined : 'The certificate requirement is not open'),
    run: (ctx) => sendDocument(ctx, 'certificate', 'death_certificate', { photocopy: false, sealPresent: true }),
  },
  {
    key: 'doc-certificate-photocopy',
    group: 'Documents',
    label: 'Death certificate arrives as a photocopy',
    hint: 'No raised seal: the requirement goes under review and the examiner gets a work item; a person decides',
    unavailable: (ctx) => needClaim(ctx) ?? (openReq(ctx.bundle, 'certificate') ? undefined : 'The certificate requirement is not open'),
    run: (ctx) => sendDocument(ctx, 'certificate', 'death_certificate', { photocopy: true, sealPresent: false }),
  },
  {
    key: 'doc-statement',
    group: 'Documents',
    label: 'Next claimant statement + W-9 arrives',
    hint: 'The taxpayer number checks out with the IRS (stub): the workflow accepts the requirement. A statement waiting for a correction goes first, else the next open one',
    unavailable: (ctx) => needClaim(ctx) ?? (pickStatement(ctx.bundle, 'next') ? undefined : 'No claimant statement is open'),
    run: (ctx) => sendDocument(ctx, 'statement', 'claimant_statement_w9', { tin: '123-45-6789' }, (b) => pickStatement(b, 'next')),
  },
  {
    key: 'doc-statement-mismatch',
    group: 'Documents',
    label: 'W-9 arrives with a TIN mismatch',
    hint: 'The caller’s (Diane’s) W-9, two digits swapped: tin.no-match for one check, so “no match”, an answer, not an error: the requirement is not enough and a 7-day correction follow-up is written',
    unavailable: (ctx) => needClaim(ctx) ?? (pickStatement(ctx.bundle, 'caller') ? undefined : 'No claimant statement is open'),
    run: async (ctx) => {
      await fault('tin.no-match', { count: 1 })
      return sendDocument(ctx, 'statement', 'claimant_statement_w9', { tin: '123-45-6798' }, (b) => pickStatement(b, 'caller'))
    },
  },
  {
    key: 'review-accept',
    group: 'Documents',
    label: 'Examiner accepts the document under review',
    hint: 'POST :review accept on a document the rules could not accept (a photocopy): accepts the requirement',
    unavailable: needClaim,
    run: async (ctx) => {
      const b = await fresh(ctx)
      const doc = (await documentsOf(b.claim.id)).find((d) => d.status === 'under_review')
      if (!doc) throw new ApiError(0, 'nothing_to_do', 'Nothing to review', 'No document is under review on this claim.')
      await post(`/documents/${doc.id}:review`, { decision: 'accept', reason: 'Accepted for demo' }, { ifMatch: `"${doc.version}"` })
      boost()
      return `${doc.requirementName ?? 'The document'} accepted by the examiner`
    },
  },
  {
    key: 'review-reject',
    group: 'Documents',
    label: 'Examiner rejects the document under review',
    hint: 'POST :review reject: the requirement is asked for again and a "certified copy needed" letter goes out (it fails when the letters service is down)',
    unavailable: needClaim,
    run: async (ctx) => {
      const b = await fresh(ctx)
      const doc = (await documentsOf(b.claim.id)).find((d) => d.status === 'under_review')
      if (!doc) throw new ApiError(0, 'nothing_to_do', 'Nothing to review', 'No document is under review on this claim.')
      await post(`/documents/${doc.id}:review`, { decision: 'reject', reason: 'A photocopy is not enough: a certified copy with a raised seal is needed' }, { ifMatch: `"${doc.version}"` })
      boost()
      return `${doc.requirementName ?? 'The document'} rejected · the claimant is asked for a certified copy`
    },
  },
  {
    key: 'letters-down',
    group: 'Letters, bank and workers',
    label: 'Letters service down',
    hint: 'letters.down: every send fails, so a workflow’s retries run out and its run is marked failed. Switch it off with "Letters back"',
    run: async () => { await fault('letters.down', { enabled: true }); return 'The letters service is down: the next letter workflow will retry and then fail' },
  },
  {
    key: 'letters-up',
    group: 'Letters, bank and workers',
    label: 'Letters back',
    hint: 'Clears letters.down',
    run: async () => { await fault('letters.down', { enabled: false }); return 'The letters service is back' },
  },
  {
    key: 'worker-stall',
    group: 'Letters, bank and workers',
    label: 'Stall the worker in the next intake',
    hint: 'worker.stall-once:LifeIntake_SendAcknowledgementAndPackets: the first run of that step hangs past its timeout; Temporal times it out and runs it again. Applies to the next new claim',
    run: async () => { await fault('worker.stall-once:LifeIntake_SendAcknowledgementAndPackets', { count: 1 }); return 'The worker will stall once in the next intake’s acknowledgement step; Temporal retries it' },
  },
  {
    key: 'rerun-failed',
    group: 'Ops',
    label: 'Re-run the failed workflow',
    hint: 'POST /workflow-runs/{id}:rerun on this claim’s latest failed run: same workflow id, letters carry the same key so nothing is sent twice',
    unavailable: (ctx) => needClaim(ctx) ?? (ctx.bundle!.runs.some((r) => r.status === 'failed') ? undefined : 'No failed run on this claim'),
    run: async (ctx) => {
      const b = await fresh(ctx)
      const failed = b.runs.filter((r): r is ApiWorkflowRun => r.status === 'failed').sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0]
      if (!failed) throw new ApiError(0, 'nothing_to_do', 'Nothing to re-run', 'No failed run on this claim.')
      const r = await post<{ outcome: string }>(`/workflow-runs/${failed.id}:rerun`)
      boost()
      return `${failed.name}: ${r.outcome === 'started' ? 'started again' : 'already running'} (${failed.workflowId.slice(0, 22)}…)`
    },
  },
  {
    key: 'overdue-check',
    group: 'Ops',
    label: 'Run the overnight overdue check',
    hint: 'POST /deadlines:check-overdue: work items for rows past due that no workflow fires (once per row)',
    run: async () => {
      const r = await post<{ raised: number; alreadyRaised: number }>('/deadlines:check-overdue')
      boost()
      return `Overdue check: ${r.raised} new work ${r.raised === 1 ? 'item' : 'items'}, ${r.alreadyRaised} already raised`
    },
  },
]
