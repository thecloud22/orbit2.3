import { COMMUNICATIONS, PARTY_PREFERENCES } from './fixtures/communications'
import { collection, fail, newId, respond } from './store'
import { logEvent } from './history'
import { templateById } from './letters'
import { fmtDate, nowStamp, TODAY } from '../lib/dates'
import { isLiveId } from './live/mode'
import * as live from './live/data'
import type { Communication } from './types'

export const communications = collection<Communication>(COMMUNICATIONS)

/** GET /claims/{id}/communications — newest first. */
export function listCommunications(claimId: string): Promise<Communication[]> {
  if (isLiveId(claimId)) return live.getCommunications(claimId)
  return respond(communications.where((c) => c.claimId === claimId).sort((a, b) => b.at.localeCompare(a.at)))
}

export function addCommunication(c: Omit<Communication, 'id' | 'at'> & { at?: string }): Communication {
  return communications.prepend({ id: newId('com'), at: c.at ?? nowStamp(), ...c })
}

/** GET /claims/{id}/contact-preference — how the main party wants to hear from us. */
export function getPartyPreference(claimId: string): Promise<{ party: string; text: string } | null> {
  if (isLiveId(claimId)) return respond(null, 0)
  return respond(PARTY_PREFERENCES[claimId] ?? null, 0)
}

function summarize(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, s.lastIndexOf(' ', max))}…`
}

function draftId(claimId: string, templateId: string): string {
  return `draft-${claimId}-${templateId}`
}

export interface LetterArgs {
  claimId: string
  templateId: string
  title: string
  to: string
  channels: string[]
  text: string
  attachments: string[]
  answer: boolean
  copyAgent: boolean
  by: string
}

/** PUT /claims/{id}/letters/drafts/{template} — one draft per template, shown in the timeline. */
export function saveLetterDraft(a: LetterArgs): Promise<Communication> {
  const id = draftId(a.claimId, a.templateId)
  const body: Communication = {
    id, claimId: a.claimId, at: nowStamp(), channel: 'letter', direction: 'out', title: a.title,
    party: `${a.to} · ${a.channels.join(' and ').toLowerCase() || 'no channel yet'}`, detail: summarize(a.text.split('\n\n')[1] ?? '') || 'Draft',
    status: { label: 'Draft', tone: 'neutral' }, template: a.templateId,
  }
  if (communications.get(id)) communications.update(id, body)
  else communications.prepend(body)
  logEvent(a.claimId, { type: 'communication', title: `Draft saved: ${a.templateId} ${a.title}`, actor: a.by })
  return respond(body)
}

/** POST /claims/{id}/letters — sends, answers the linked portal message, copies the agent, and moves the claim on. */
export function sendLetter(a: LetterArgs): Promise<Communication> {
  const tpl = templateById(a.templateId)
  if (!tpl) return fail('Template not found')
  if (!a.channels.length) return fail('Choose at least one channel')
  const draft = communications.get(draftId(a.claimId, a.templateId))
  if (draft) communications.remove(draft.id)

  const channelText = a.channels.join(' and ').toLowerCase()
  const sent = addCommunication({
    claimId: a.claimId, channel: tpl.kind === 'portal' ? 'portal' : 'letter', direction: 'out', title: a.title,
    party: `${a.to} · ${channelText}`,
    detail: a.attachments.length ? `Enclosed: ${a.attachments.join(', ')}` : summarize(a.text.split('\n\n')[1] ?? ''),
    status: { label: 'Sent', tone: 'positive' }, template: a.templateId, benefitLine: tpl.benefitLine,
  })

  if (a.answer && tpl.answers) {
    const q = communications.get(tpl.answers.commId)
    if (q) {
      communications.update(q.id, { status: { label: `Answered ${fmtDate(TODAY)}`, tone: 'positive' } })
      logEvent(a.claimId, { type: 'communication', title: `Portal question answered: ${q.title}`, actor: a.by, detail: `Answered by ${a.templateId}` })
    }
  }
  if (a.copyAgent && tpl.copyAgent) {
    addCommunication({
      claimId: a.claimId, channel: 'email', direction: 'out', title: `Copy: ${a.title}`, party: `${tpl.copyAgent.name} · agent of record · email`,
      detail: 'Copy with the family’s permission', status: { label: 'Sent', tone: 'positive' }, template: a.templateId,
    })
  }
  logEvent(a.claimId, {
    type: 'communication', title: `${tpl.kind === 'portal' ? 'Portal message' : 'Letter'} sent: ${a.templateId} ${a.title}`, actor: a.by,
    detail: `To ${a.to} by ${channelText}${a.copyAgent && tpl.copyAgent ? `; copy to ${tpl.copyAgent.name}` : ''}`, ref: a.templateId,
  })
  tpl.onSent?.(a.claimId, a.by)
  return respond(sent)
}

/** Marks an inbound message answered without a letter (e.g. answered on a call). */
export function markAnswered(id: string, by: string): Promise<void> {
  const c = communications.get(id)
  if (!c) return fail('Message not found')
  communications.update(id, { status: { label: `Answered ${fmtDate(TODAY)}`, tone: 'positive' } })
  logEvent(c.claimId, { type: 'communication', title: `Marked answered: ${c.title}`, actor: by })
  return respond(undefined)
}
