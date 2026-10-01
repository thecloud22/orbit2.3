/**
 * External portal API — what claimants, beneficiaries and agents see and do.
 *
 * Reads are derived from the same collections the staff app uses (requirements, documents,
 * decisions, payments, communications), so a change on either side shows on the other.
 * Writes go through the shared collections and always log history. Real endpoints: /portal/*.
 */
import { AGENT_EXTRA_CONSENTS, AGENT_OVERLAY, AGENT_UPDATES, ELENA_FALLBACK_ASKS, HART, PIERCE, UPLOADS } from './fixtures/portal'
import { claims } from './claims'
import { isOpen, markReceived, requirements, type RequirementRecord } from './requirements'
import { documents } from './documents'
import { decisions } from './decisions'
import { payments } from './payments'
import { addCommunication, communications } from './communications'
import { logEvent } from './history'
import { addTask } from './tasks'
import { collection, fail, newId, respond } from './store'
import { fmtDate, nowStamp, TODAY } from '../lib/dates'
import { fmtMoney } from '../lib/money'
import type { Communication, Requirement, Status } from './types'

// ---------------------------------------------------------------- Types

/** One thing the portal asks a claimant to do, derived from open requirements. */
export interface PortalAsk {
  id: string
  kind: 'doctor' | 'upload'
  title: string
  body: string
  /** Requirements this ask satisfies when done. Empty when derived from the fallback. */
  requirementIds: string[]
}

export interface UploadSlot {
  id: string
  label: string
  hint: string
  docTitle: string
  docType: string
  sampleName: string
  pages: number
  pageText?: string[]
}

export interface UploadSpec {
  key: string
  title: string
  why: string
  slots: UploadSlot[]
}

export interface UploadedFile {
  slotId: string
  fileName: string
  pages: number
}

export interface PortalMessage {
  id: string
  at: string
  fromUs: boolean
  title: string
  detail: string
  channel: Communication['channel']
}

export interface BeneficiaryPaymentView {
  decided: boolean
  decidedOn?: string
  decidedBy?: string
  amount: number
  payDate: string
  account: string
  scheduled: boolean
}

export type ElectionOption = 'lump' | 'fiveYear' | 'lifeExpectancy'

export interface AnnuityElection {
  id: string
  claimId: string
  beneficiary: string
  option: ElectionOption
  at: string
}

export interface AnnuityShareView {
  statement: boolean
  w9: boolean
  election?: AnnuityElection
}

export interface ReturnToWorkReport {
  id: string
  claimId: string
  kind: 'sooner' | 'later'
  date: string
  detail: string
  at: string
}

export interface AgentClientOverlay {
  order: number
  client: string
  deceased?: boolean
  ref: string
  product: string
  since: string
  status: Status
  statusNote: string
  needed: string
  action: string
  actionNote?: string
}

export interface AgentClientRow extends AgentClientOverlay {
  claimId: string
  consent: string
  needsHelp?: { title: string; sub: string }
}

// ---------------------------------------------------------------- Portal-owned collections

const elections = collection<AnnuityElection>([])
const rtwReports = collection<ReturnToWorkReport>([])

export const ELECTION_LABELS: Record<ElectionOption, string> = {
  lump: 'All at once',
  fiveYear: 'Over up to 5 years',
  lifeExpectancy: 'Over your life expectancy',
}

// ---------------------------------------------------------------- Claimant asks

const isPhysician = (r: Requirement) => /physician statement|doctor/i.test(r.name)
const isTax2024 = (r: Requirement) => /2024 tax return/i.test(r.name)
const isPandL = (r: Requirement) => /p&l|profit and loss/i.test(r.name)

function financialTitle(tax: boolean, pl: boolean): string {
  if (tax && pl) return 'Upload your 2024 tax return and monthly profit and loss statements since June'
  if (tax) return 'Upload your 2024 tax return'
  return 'Upload your monthly profit and loss statements since June'
}

function doctorName(r: Requirement): string {
  return r.from.split(/[·,]/)[0].trim()
}

/** GET /portal/claims/{id}/asks — what we need from the claimant, in plain words. */
export function listClaimantAsks(claimId: string): Promise<PortalAsk[]> {
  const all = requirements.where((r) => r.claimId === claimId)
  if (all.length === 0) return respond(claimId === 'D-26-073390' ? ELENA_FALLBACK_ASKS : [])
  const open = all.filter(isOpen)
  const asks: PortalAsk[] = []
  const doctor = open.filter(isPhysician)
  if (doctor.length)
    asks.push({
      id: 'doctor',
      kind: 'doctor',
      title: 'Help us get your doctor’s statement',
      body: `${doctorName(doctor[0])}’s office hasn’t sent it yet.`,
      requirementIds: doctor.map((r) => r.id),
    })
  const fin = open.filter((r) => isTax2024(r) || isPandL(r))
  if (fin.length)
    asks.push({
      id: 'financials',
      kind: 'upload',
      title: financialTitle(fin.some(isTax2024), fin.some(isPandL)),
      body: 'Your accountant or your agent, Paul Hendricks, can send them with your permission.',
      requirementIds: fin.map((r) => r.id),
    })
  return respond(asks)
}

/** The open or met requirement an upload slot answers: 'tax' → 2024 tax return, 'pl' → P&L. */
function matchingRequirement(claimId: string, slotId: string): RequirementRecord | undefined {
  const test = slotId === 'tax' ? isTax2024 : slotId === 'pl' ? isPandL : null
  if (!test) return undefined
  const all = requirements.where((r) => r.claimId === claimId && test(r))
  return all.find(isOpen) ?? all[0]
}

export function uploadSpec(key: string): UploadSpec | undefined {
  return UPLOADS[key]
}

/**
 * POST /portal/claims/{id}/documents
 * Files the documents, satisfies the matching requirements, tells the claim team and logs it.
 * `by` is who sent them ("Elena Vasquez · portal" or "Paul Hendricks · agent portal").
 */
export function uploadClaimantDocuments(args: { claimId: string; uploadKey: string; files: UploadedFile[]; by: string; party: string }): Promise<{ met: string[] }> {
  const { claimId, uploadKey, files, by, party } = args
  const spec = UPLOADS[uploadKey]
  if (!spec || files.length === 0) return fail('Nothing to upload')

  // File the documents first so each requirement can point at the one that satisfies it.
  const docIds: Record<string, string> = {}
  files.forEach((f) => {
    const slot = spec.slots.find((s) => s.id === f.slotId)!
    const id = newId('doc')
    docIds[f.slotId] = id
    documents.insert({
      id, claimId, title: slot.docTitle, docType: slot.docType, received: TODAY, channel: 'Portal',
      pages: f.pages, isNew: true, status: { label: 'New', tone: 'info' },
      satisfies: uploadKey === 'financials' ? matchingRequirement(claimId, slot.id)?.name : undefined,
      pageText: [...(slot.pageText ?? []), `Uploaded by ${by} · ${f.fileName}`],
    })
  })

  const what = files.map((f) => spec.slots.find((s) => s.id === f.slotId)!.docTitle).filter((t, i, a) => a.indexOf(t) === i).join(' and ')
  addCommunication({
    claimId, channel: 'portal', direction: 'in', title: `Documents uploaded: ${what}`, party,
    detail: `${files.length} file${files.length > 1 ? 's' : ''} · ${files.map((f) => f.fileName).join(', ')}`,
    status: { label: 'Received', tone: 'neutral' },
  })
  logEvent(claimId, { type: 'document', title: `${what} received`, actor: by, ref: files.length > 1 ? `${files.length} documents` : 'Document' })

  // Satisfy the matching requirements: 'met', "Received 25 Sep", plus the requirement workflow
  // (plan, exception, work item, next step) — the examiner's screens update live.
  const met: string[] = []
  if (uploadKey === 'financials')
    Object.keys(docIds).forEach((slotId) => {
      const r = matchingRequirement(claimId, slotId)
      if (!r || !isOpen(r)) return
      void markReceived(r.id, 'portal upload', by)
      requirements.update(r.id, (x) => ({ documentIds: [...(x.documentIds ?? []), docIds[slotId]] }))
      met.push(r.name)
    })

  return respond({ met })
}

/** POST /portal/claims/{id}/physician-note — texts the claimant a note to forward to the doctor's office. */
export function textPhysicianNote(claimId: string, claimant: string, doctor: string): Promise<void> {
  addCommunication({
    claimId, channel: 'portal', direction: 'out', title: `Note for ${doctor}’s office texted to ${claimant.split(' ')[0]}`,
    party: `${claimant} · text message`,
    detail: `Asks ${doctor}’s office to send the attending physician statement by fax to (555) 010-2090 or through the provider portal.`,
    status: { label: 'Sent', tone: 'neutral' },
  })
  logEvent(claimId, { type: 'communication', title: `Asked for a note to forward to ${doctor}’s office`, actor: `${claimant} · portal`, detail: 'Texted from the portal task “Help us get your doctor’s statement”' })
  return respond(undefined)
}

/** POST /portal/claims/{id}/providers — the claimant names another treating doctor. */
export function addTreatingDoctor(claimId: string, claimant: string, doctor: { name: string; practice: string; phone: string }): Promise<void> {
  const who = [doctor.name, doctor.practice].filter(Boolean).join(' · ')
  addCommunication({
    claimId, channel: 'portal', direction: 'in', title: `New treating doctor: ${doctor.name}`, party: `${claimant} · portal`,
    detail: [who, doctor.phone].filter(Boolean).join(' · '), status: { label: 'Needs follow-up', tone: 'caution' },
  })
  addTask(claimId, `Request statement from ${doctor.name}`, 'Jordan Ellis', `${claimant} · portal`)
  logEvent(claimId, { type: 'data', title: `Treating doctor added: ${doctor.name}`, actor: `${claimant} · portal`, detail: [doctor.practice, doctor.phone].filter(Boolean).join(' · ') || undefined })
  return respond(undefined)
}

/** POST /portal/claims/{id}/messages */
export function sendPortalMessage(claimId: string, from: string, text: string, to = 'your claim team'): Promise<void> {
  addCommunication({
    claimId, channel: 'portal', direction: 'in', title: to === 'your claim team' ? 'Portal message' : `Message to ${to}`,
    party: `${from} · portal message`, detail: `“${text}”`, status: { label: 'Unanswered', tone: 'caution' },
  })
  logEvent(claimId, { type: 'communication', title: to === 'your claim team' ? 'Portal message received' : `Portal message to ${to}`, actor: `${from} · portal`, detail: text })
  return respond(undefined)
}

/** GET /portal/claims/{id}/messages — what this person can see: their letters, messages and calls, never internal notes or mail to others. */
export function listPortalMessages(claimId: string, person: string): Promise<PortalMessage[]> {
  const theirs = (c: Communication) => c.party.includes(person) || (c.direction === 'out' && /^portal\b/i.test(c.party))
  return respond(
    communications
      .where((c) => c.claimId === claimId && c.direction !== 'internal' && c.channel !== 'note' && c.channel !== 'document' && theirs(c) && c.status.label !== 'Draft')
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((c) => ({ id: c.id, at: c.at, fromUs: c.direction === 'out', title: c.title, detail: c.detail, channel: c.channel })),
  )
}

// ---------------------------------------------------------------- DI payments & return to work

/** GET /portal/claims/{id}/return-to-work */
export function listReturnToWork(claimId: string): Promise<ReturnToWorkReport[]> {
  return respond(rtwReports.where((r) => r.claimId === claimId).sort((a, b) => b.at.localeCompare(a.at)))
}

/** POST /portal/claims/{id}/return-to-work */
export function reportReturnToWork(args: { claimId: string; claimant: string; kind: 'sooner' | 'later'; date: string; detail: string }): Promise<void> {
  const { claimId, claimant, kind, date, detail } = args
  const day = fmtDate(date, { weekday: true })
  rtwReports.insert({ id: newId('rtw'), claimId, kind, date, detail, at: nowStamp() })
  const title = kind === 'sooner' ? `Going back to work sooner: ${day}` : `Needs more time off: now expects ${day}`
  addCommunication({ claimId, channel: 'portal', direction: 'in', title, party: `${claimant} · portal`, detail: detail || '—', status: { label: 'Needs review', tone: 'caution' } })
  logEvent(claimId, { type: 'data', title: `Return to work reported — ${kind === 'sooner' ? 'earlier' : 'later'} date ${day}`, actor: `${claimant} · portal`, detail: detail || undefined })
  if (kind === 'later') addTask(claimId, 'Request updated doctor’s note for new return date', 'Jordan Ellis', `${claimant} · portal`)
  return respond(undefined)
}

// ---------------------------------------------------------------- Life beneficiary

/** GET /portal/claims/{id}/decision — whether a decision is recorded, and the beneficiary's payment. */
export function getBeneficiaryPayment(claimId: string, payee: string): Promise<BeneficiaryPaymentView> {
  const d = decisions.where((x) => x.claimId === claimId && x.outcome === 'approved').sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
  const p = payments.where((x) => x.claimId === claimId && x.payee === payee)[0]
  return respond({
    decided: !!d,
    decidedOn: d?.recordedAt.slice(0, 10),
    decidedBy: d?.recordedBy,
    amount: p?.amount ?? PIERCE.total,
    payDate: p?.payDate ?? PIERCE.payDate,
    account: p?.method.match(/(\d{4})/)?.[1] ?? PIERCE.account,
    scheduled: !!p,
  })
}

// ---------------------------------------------------------------- Annuity beneficiary

const HART_FORMS = {
  statement: { title: 'Claimant statement — Claire Hart-Lopez', docType: 'Claimant statement', match: /statement/i },
  w9: { title: 'IRS Form W-9 — Claire Hart-Lopez', docType: 'W-9', match: /w-?9/i },
} as const

export type AnnuityForm = keyof typeof HART_FORMS

/** GET /portal/claims/{id}/share */
export function getAnnuityShare(claimId: string, beneficiary: string): Promise<AnnuityShareView> {
  const has = (f: AnnuityForm) => documents.where((d) => d.claimId === claimId && d.title === HART_FORMS[f].title).length > 0
  return respond({
    statement: has('statement'),
    w9: has('w9'),
    election: elections.where((e) => e.claimId === claimId && e.beneficiary === beneficiary).slice(-1)[0],
  })
}

/** POST /portal/claims/{id}/forms — the beneficiary completes a form in the portal. */
export function submitAnnuityForm(claimId: string, beneficiary: string, form: AnnuityForm): Promise<void> {
  const f = HART_FORMS[form]
  documents.insert({
    id: newId('doc'), claimId, title: f.title, docType: f.docType, received: TODAY, channel: 'Portal', pages: form === 'w9' ? 1 : 3,
    isNew: true, status: { label: 'New', tone: 'info' }, satisfies: 'Claire’s good order',
    pageText: [f.title, `Completed and e-signed in the portal by ${beneficiary}`],
  })
  addCommunication({ claimId, channel: 'portal', direction: 'in', title: `${f.docType} completed`, party: `${beneficiary} · portal`, detail: 'Completed and e-signed in the portal', status: { label: 'Received', tone: 'neutral' } })
  logEvent(claimId, { type: 'document', title: `${f.docType} received from ${beneficiary}`, actor: `${beneficiary} · portal`, ref: f.docType })

  const both = (['statement', 'w9'] as AnnuityForm[]).every((k) => documents.where((d) => d.claimId === claimId && d.title === HART_FORMS[k].title).length > 0)
  // Tolerant of how Requirements models it: one combined requirement, or one per form.
  requirements
    .where((r) => r.claimId === claimId && isOpen(r) && r.id.startsWith('req-hart-claire'))
    .forEach((r) => {
      const single = r.id !== 'req-hart-claire' && (HART_FORMS.statement.match.test(r.name) || HART_FORMS.w9.match.test(r.name)) && !/and/i.test(r.name)
      if (single ? f.match.test(r.name) : both) void markReceived(r.id, 'portal e-signature', `${beneficiary} · portal`)
    })
  if (both) logEvent(claimId, { type: 'data', title: `${beneficiary}’s share is in good order`, actor: 'System · on portal forms', detail: `Valued ${fmtDate(TODAY)}: guaranteed ${fmtMoney(HART.guaranteed)} applies` })
  return respond(undefined)
}

/** POST /portal/claims/{id}/election — how the beneficiary chooses to receive her share. */
export function recordAnnuityElection(claimId: string, beneficiary: string, option: ElectionOption): Promise<AnnuityElection> {
  const share = getShareSync(claimId)
  if (!share.statement || !share.w9) return fail('Send your claimant statement and W-9 first')
  const e = elections.insert({ id: newId('el'), claimId, beneficiary, option, at: nowStamp() })
  const label = ELECTION_LABELS[option]
  addCommunication({
    claimId, channel: 'portal', direction: 'in', title: `Payout choice: ${label}`, party: `${beneficiary} · portal`,
    detail: `Election form completed in the portal · share at least ${fmtMoney(HART.guaranteed)}`, status: { label: 'Needs processing', tone: 'caution' },
  })
  logEvent(claimId, { type: 'decision', title: `${beneficiary} chose how to receive her share — ${label.toLowerCase()}`, actor: `${beneficiary} · portal`, ref: 'Election form' })
  return respond(e)
}

function getShareSync(claimId: string) {
  const has = (f: AnnuityForm) => documents.where((d) => d.claimId === claimId && d.title === HART_FORMS[f].title).length > 0
  return { statement: has('statement'), w9: has('w9') }
}

// ---------------------------------------------------------------- Agent of record

const AGENT_ROLE = 'Agent of record'

/**
 * GET /portal/agent/claims — claims where this person is agent of record and the client consented.
 * Status and what's needed only — never medical detail.
 */
export function listAgentClients(agent: string): Promise<AgentClientRow[]> {
  const rows: AgentClientRow[] = []
  claims.all().forEach((c) => {
    const p = c.parties.find((x) => x.name === agent && x.roles.includes(AGENT_ROLE))
    const extra = AGENT_EXTRA_CONSENTS.find((x) => x.claimId === c.id)
    // Consent-scoped: a recorded consent on the party, or a consent given elsewhere (e.g. at phone intake).
    if (!(p?.status || extra)) return
    const base = AGENT_OVERLAY[c.id]
    const row: AgentClientRow = base
      ? { ...base, claimId: c.id, consent: extra?.consent ?? p?.access ?? '' }
      : {
          order: 99, client: c.name, ref: c.benefitLines[0]?.ref ?? '', product: c.product, since: c.filed,
          status: { label: c.benefitLines[0]?.status.label ?? 'Open', tone: 'neutral' }, statusNote: '', needed: '—', action: 'None',
          claimId: c.id, consent: p?.access ?? '',
        }
    rows.push(liveAgentRow(row))
  })
  return respond(rows.sort((a, b) => a.order - b.order))
}

function liveAgentRow(row: AgentClientRow): AgentClientRow {
  if (row.claimId === 'L-26-040112') {
    const d = decisions.where((x) => x.claimId === row.claimId && x.outcome === 'approved')[0]
    if (d) return { ...row, status: { label: `Approved ${fmtDate(d.recordedAt)}`, tone: 'positive' }, statusNote: `Payment goes out ${fmtDate(PIERCE.payDate)}` }
  }
  if (row.claimId === 'D-26-073390') {
    const open = requirements.where((r) => r.claimId === row.claimId && isOpen(r))
    const fin = open.filter((r) => isTax2024(r) || isPandL(r))
    const all = requirements.where((r) => r.claimId === row.claimId)
    if (all.length && !fin.length)
      return {
        ...row, status: { label: 'Waiting on her doctor', tone: 'caution' }, needed: 'Nothing from you', action: 'None', actionNote: undefined,
      }
    return { ...row, needsHelp: { title: `Elena Vasquez: ${fin.length === 1 ? fin[0].name : '2024 tax return and monthly P&L'} still needed`, sub: 'Disability income · D-26-073390 · with her consent' } }
  }
  if (row.claimId === 'A-26-015530') {
    const s = getShareSync(row.claimId)
    const chosen = elections.where((e) => e.claimId === row.claimId).length > 0
    const left = [!s.statement, !s.w9, !chosen].filter(Boolean).length
    if (left === 0) return { ...row, status: { label: 'Claire’s share in good order', tone: 'positive' }, needed: 'Nothing', action: 'None' }
    return {
      ...row, needed: `${left} form${left > 1 ? 's' : ''} from Claire`,
      status: s.statement && s.w9 ? { label: 'Waiting on Claire’s choice', tone: 'caution' } : row.status,
      needsHelp: { title: 'Claire Hart-Lopez asked for help choosing how to receive her share', sub: 'Evelyn Hart’s annuity · A-26-015530' },
    }
  }
  return row
}

/** GET /portal/agent/updates — recent client updates, newest first. */
export function listAgentUpdates(): Promise<{ at: string; client: string; text: string }[]> {
  const live: { at: string; client: string; text: string }[] = []
  const pierce = decisions.where((x) => x.claimId === 'L-26-040112' && x.outcome === 'approved')[0]
  if (pierce) live.push({ at: pierce.recordedAt, client: 'Harold Pierce', text: `Claim approved. Margaret Pierce’s payment goes out ${fmtDate(PIERCE.payDate)}.` })
  const vas = requirements.where((r) => r.claimId === 'D-26-073390' && (isTax2024(r) || isPandL(r)))
  if (vas.length && vas.every((r) => !isOpen(r))) live.push({ at: `${TODAY}T09:30`, client: 'Elena Vasquez', text: 'Her 2024 tax return and P&L were received.' })
  const el = elections.where((e) => e.claimId === 'A-26-015530')[0]
  if (el) live.push({ at: el.at, client: 'Evelyn Hart', text: `Claire chose how to receive her share: ${ELECTION_LABELS[el.option].toLowerCase()}.` })
  return respond([...live.sort((a, b) => b.at.localeCompare(a.at)), ...AGENT_UPDATES])
}

/** POST /portal/agent/claims/{id}/actions — an agent action on a client's claim (share a guide, book a call). */
export function logAgentAction(claimId: string, agent: string, title: string, detail: string, party: string): Promise<void> {
  addCommunication({ claimId, channel: 'portal', direction: 'out', title, party, detail, status: { label: 'Sent', tone: 'neutral' } })
  logEvent(claimId, { type: 'communication', title, actor: `${agent} · agent portal`, detail })
  return respond(undefined)
}

/** Log-only portal event, e.g. a claimant granting document consent. */
export function logPortalEvent(claimId: string, actor: string, title: string, detail?: string): Promise<void> {
  logEvent(claimId, { type: 'access', title, actor, detail })
  return respond(undefined)
}
