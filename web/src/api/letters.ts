import { claims, patchClaim, setNextStep } from './claims'
import { logEvent } from './history'
import { tasks } from './tasks'
import { completeWork } from './work'
import { fmtDate, TODAY } from '../lib/dates'
import type { Claim, Family } from './types'
import type { PaymentRow } from './payments'

/**
 * Letter and message templates. GET /letter-templates?claim= in the real API; the body is rendered
 * server-side from the same merge fields and clauses. Tokens look like {{key}} or {{key|first}}.
 */
export interface MergeField {
  key: string
  label: string
  value: string
}

export interface ClauseDef {
  id: string
  label: string
  on: boolean
}

export interface LetterContext {
  claim: Claim
  payments: PaymentRow[]
  sender: { name: string; title: string }
}

export interface LetterTemplate {
  id: string
  title: string
  /** 'letter' is posted/emailed as a letter; 'portal' is a portal message. */
  kind: 'letter' | 'portal'
  /** Only offered on these claims; undefined = any claim of these families (or all). */
  claimIds?: string[]
  families?: Family[]
  to: (c: Claim) => string
  channels: string[]
  defaultChannels: string[]
  fields: (ctx: LetterContext) => MergeField[]
  clauses: ClauseDef[]
  body: (f: Record<string, string>, on: (id: string) => boolean, ctx: LetterContext) => string[]
  attachments: string[]
  answers?: { commId: string; label: string }
  copyAgent?: { name: string; label: string }
  benefitLine?: string
  /** What the claim's workflow does once this letter is sent. */
  onSent?: (claimId: string, by: string) => void
}

const firstName = (s: string) => s.split(' ')[0]

function signOff(ctx: LetterContext): string[] {
  return ['With best wishes,', `${ctx.sender.name}, ${ctx.sender.title}`]
}

function primaryParty(c: Claim): string {
  return c.parties.find((p) => p.roles.includes('Claimant'))?.name ?? c.parties.find((p) => p.roles.includes('Beneficiary'))?.name ?? c.parties[0]?.name ?? c.name
}

function markTaskDone(claimId: string, match: (title: string) => boolean): void {
  tasks.where((t) => t.claimId === claimId && !t.done && match(t.title)).forEach((t) => tasks.update(t.id, { done: true }))
}

export const TEMPLATES: LetterTemplate[] = [
  // ---------------------------------------------------------------- Okafor: custodian packet
  {
    id: 'LTR-L-131',
    title: 'Custodian election for minor beneficiaries',
    kind: 'letter',
    claimIds: ['L-26-038907'],
    to: () => 'Adaeze Okafor',
    channels: ['Portal', 'First-class mail'],
    defaultChannels: ['Portal', 'First-class mail'],
    fields: () => [
      { key: 'name', label: 'Beneficiary name', value: 'Adaeze Okafor' },
      { key: 'minors', label: 'Minors', value: 'Chidi, Amara' },
      { key: 'share', label: 'Share each', value: '$36,045' },
      { key: 'policy', label: 'Policy', value: 'LP-1219044' },
    ],
    clauses: [
      { id: 'utma', label: 'UTMA custodian option', on: true },
      { id: 'guardian', label: 'Court-appointed guardian option', on: true },
      { id: 'interest', label: 'Held funds earn interest', on: true },
    ],
    body: (_f, on, ctx) => {
      const both = on('utma') && on('guardian')
      const utma = 'Name a custodian under your state’s Uniform Transfers to Minors Act. You can be the custodian, and no court is needed for amounts up to your state’s limit. Sign the enclosed form.'
      const guardian = 'If a court appoints a guardian of the estate, send us the court order.'
      return [
        'Dear {{name|first}},',
        `{{minors|possessive}} shares of Daniel’s whole life policy {{policy}} — {{share}} each — are held safely${on('interest') ? ' and earn interest' : ''} until we know who will manage the money for them.`,
        ...(both
          ? ['There are two ways to do this:', `1. ${utma}`, `2. ${guardian}`, 'You don’t need a lawyer for the first option.']
          : on('utma')
            ? [utma, 'You don’t need a lawyer to do this.']
            : on('guardian')
              ? [`A court needs to appoint a guardian of the estate for each child. ${guardian}`]
              : []),
        ...(on('interest') ? ['Interest is added from 19 Sep until the day we pay, so the children lose nothing while you decide.'] : []),
        'If you have questions, call me on (555) 010-3100 — afternoons are fine.',
        ...signOff(ctx),
      ]
    },
    attachments: ['UTMA custodian form (prefilled)', 'IRS Form W-9'],
    answers: { commId: 'com-okafor-q', label: 'Also answer Adaeze’s portal question from 09:20 with this letter' },
    copyAgent: { name: 'Paul Hendricks', label: 'Copy agent Paul Hendricks, who can help with the custodian form' },
    benefitLine: 'Whole life',
    onSent: (claimId, by) => {
      const c = claims.get(claimId)
      if (c) patchClaim(claimId, { exceptions: c.exceptions.map((x) => (x.id === 'x2' ? { ...x, meta: `Custodian form sent ${fmtDate(TODAY)}` } : x)) })
      markTaskDone(claimId, (t) => t.toLowerCase().includes('custodian packet'))
      completeWork(claimId, 'communications')
      setNextStep(claimId, { label: 'Review toxicology report', reason: 'New document · accidental death rider', section: 'documents' })
      logEvent(claimId, { type: 'task', title: 'Next step: review toxicology report', actor: `${by} · after custodian packet` })
    },
  },

  // ---------------------------------------------------------------- Whitman: payment timing
  {
    id: 'LTR-L-140',
    title: 'Update on payment timing',
    kind: 'letter',
    claimIds: ['L-26-035120'],
    to: () => 'Robert Whitman',
    channels: ['First-class mail', 'Email'],
    defaultChannels: ['First-class mail', 'Email'],
    fields: () => [
      { key: 'name', label: 'Beneficiary name', value: 'Robert Whitman' },
      { key: 'amount', label: 'Benefit', value: '$436,000.00' },
      { key: 'rate', label: 'Interest rate', value: '3.25%' },
      { key: 'daily', label: 'Interest a day', value: '$38.82' },
    ],
    clauses: [
      { id: 'timing', label: 'Expected timing', on: true },
      { id: 'interest', label: 'Interest keeps accruing', on: true },
      { id: 'call', label: 'I’ll call you', on: true },
    ],
    body: (_f, on, ctx) => [
      'Dear {{name|first}},',
      'I approved your claim on Grace’s policy this morning for {{amount}}. Before any large payment leaves us it goes through a standard identity check, and yours needs a second look by our Payments team. This is routine and doesn’t mean anything is wrong.',
      ...(on('timing') ? ['We expect the check to finish today. If it runs past mid-afternoon, the payment goes out on Monday 28 Sep instead.'] : []),
      ...(on('interest') ? ['Interest of {{rate}} a year is added from 21 Aug until the day we pay — about {{daily}} a day — so the short wait costs you nothing.'] : []),
      ...(on('call') ? ['I’ll call you in the morning to tell you when the money is on its way. If you’d like to talk sooner, call me on (555) 010-3100.'] : []),
      ...signOff(ctx),
    ],
    attachments: [],
    benefitLine: 'Universal life',
    onSent: (claimId, by) => {
      completeWork(claimId, 'communications')
      setNextStep(claimId, { label: 'Watch for screening to clear', reason: 'Payments · Lauren Pike confirms by 15:30 for the 16:00 run', section: 'payments' })
      logEvent(claimId, { type: 'task', title: 'Next step: watch for screening to clear', actor: `${by} · after timing update` })
    },
  },

  // ---------------------------------------------------------------- Pierce: portal reply
  {
    id: 'PRT-L-022',
    title: 'Portal reply — when you’ll hear',
    kind: 'portal',
    claimIds: ['L-26-040112'],
    to: () => 'Margaret Pierce',
    channels: ['Portal', 'Email'],
    defaultChannels: ['Portal'],
    fields: (ctx) => {
      const mine = ctx.payments.filter((p) => p.payee === 'Margaret Pierce')
      const base = [{ key: 'name', label: 'Claimant', value: 'Margaret Pierce' }]
      if (!mine.length) return [...base, { key: 'due', label: 'Decision by', value: '3 Oct' }]
      return [
        ...base,
        { key: 'amount', label: 'Amount', value: mine.map((p) => p.amount).reduce((a, b) => a + b, 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) },
        { key: 'date', label: 'Pay date', value: fmtDate(mine[0].payDate) },
        { key: 'account', label: 'Account', value: mine[0].method.replace('EFT ', '') },
      ]
    },
    clauses: [
      { id: 'interest', label: 'Interest is added', on: true },
      { id: 'agent', label: 'Agent can see status', on: false },
    ],
    body: (f, on, ctx) => [
      'Hi {{name|first}},',
      'Thank you for your patience, and I’m so sorry for your loss.',
      ...(f.amount
        ? ['Your claim has been approved. {{amount}} will reach your account ending {{account}} on {{date}}, and we have paid Linden Grove Funeral Home directly under your assignment. A letter with the details is on its way.']
        : ['Everything you sent is complete, and your claim is with me for a decision now. You’ll hear from me by {{due}} at the latest, and I’ll message you here as soon as it’s done.']),
      ...(on('interest') ? ['Interest is added from the date of Harold’s death until the day we pay.'] : []),
      ...(on('agent') ? ['Paul Hendricks, your agent, can also see where things stand.'] : []),
      firstName(ctx.sender.name),
    ],
    attachments: [],
    answers: { commId: 'com-pierce-3', label: 'Mark Margaret’s 22 Sep portal question as answered' },
    onSent: (claimId) => markTaskDone(claimId, (t) => t.includes('Margaret') && t.toLowerCase().includes('portal')),
  },

  // ---------------------------------------------------------------- Hart: reminder with the options guide
  {
    id: 'LTR-A-210',
    title: 'Reminder with beneficiary options guide',
    kind: 'letter',
    claimIds: ['A-26-015530'],
    to: () => 'Claire Hart-Lopez',
    channels: ['First-class mail', 'Email'],
    defaultChannels: ['First-class mail', 'Email'],
    fields: () => [
      { key: 'name', label: 'Beneficiary', value: 'Claire Hart-Lopez' },
      { key: 'contract', label: 'Contract', value: 'VA-2201946' },
      { key: 'minimum', label: 'Guaranteed minimum', value: '$327,500.00' },
      { key: 'deadline', label: 'Life-expectancy start', value: '3 Sep 2027' },
    ],
    clauses: [
      { id: 'agent', label: 'Agent can help', on: true },
      { id: 'call', label: 'Offer a call', on: true },
    ],
    body: (_f, on, ctx) => [
      'Dear {{name|first}},',
      'I’m writing again about your half of your mother’s annuity, contract {{contract}}. To pay it, we still need your claimant statement and a Form W-9. Both are enclosed, with a return envelope.',
      'Until they arrive, your half stays invested and its value changes with the market each day. It will never be less than {{minimum}}.',
      'The enclosed guide explains your choices in plain words: take it all now, take it over up to five years, or take it over your life expectancy. Payments over your life expectancy must start by {{deadline}}.',
      ...(on('agent') ? ['You told us Paul Hendricks may see your claim. He can help you fill in the forms and compare the choices.'] : []),
      ...(on('call') ? ['If you’d rather talk it through, call me on (555) 010-4200.'] : []),
      ...signOff(ctx),
    ],
    attachments: ['Beneficiary options guide', 'Claimant statement (prefilled)', 'IRS Form W-9', 'IRS Form W-4R'],
    copyAgent: { name: 'Paul Hendricks', label: 'Copy agent Paul Hendricks, whom Claire allowed to see her status' },
    onSent: (claimId, by) => {
      const c = claims.get(claimId)
      if (c) patchClaim(claimId, { exceptions: c.exceptions.map((x) => (x.id === 'x1' ? { ...x, meta: `Reminder sent ${fmtDate(TODAY)}` } : x)) })
      markTaskDone(claimId, (t) => t.includes('Follow up with Claire'))
      completeWork(claimId, 'requirements')
      setNextStep(claimId, { label: 'Wait for Claire’s forms', reason: `Reminder and options guide sent ${fmtDate(TODAY)}`, section: 'requirements', target: 'req-hart-claire' })
      logEvent(claimId, { type: 'task', title: 'Follow-up with Claire done — reminder sent', actor: by })
    },
  },

  // ---------------------------------------------------------------- Ellison: survivor letter
  {
    id: 'LTR-A-305',
    title: 'Survivor benefit and payments after death',
    kind: 'letter',
    claimIds: ['A-19-004418'],
    to: () => 'Ruth Ellison',
    channels: ['First-class mail', 'Email'],
    defaultChannels: ['First-class mail'],
    fields: () => [
      { key: 'name', label: 'Survivor', value: 'Ruth Ellison' },
      { key: 'survivor', label: 'Survivor benefit', value: '$1,420.00' },
      { key: 'overpaid', label: 'Overpaid', value: '$2,840.00' },
      { key: 'contract', label: 'Contract', value: 'IA-1904418' },
    ],
    clauses: [
      { id: 'offset', label: 'Offer the $710 offset', on: true },
      { id: 'other', label: 'Other ways to settle', on: true },
    ],
    body: (_f, on, ctx) => [
      'Dear {{name|first}},',
      'I am very sorry about George. Thank you for sending his death certificate at such a hard time.',
      'Your payments continue. As the survivor on contract {{contract}}, you receive {{survivor}} a month for the rest of your life, starting on 1 Oct.',
      'Two of George’s payments, on 1 Aug and 1 Sep, went out after he died. After taking off the survivor payments you were owed for those months, {{overpaid}} was paid that we need to settle. There is no rush, and no interest or fees.',
      ...(on('offset') ? ['The simplest way is for us to take $710.00 from each of your next four payments. If you agree, just sign and return the enclosed form.'] : []),
      ...(on('other') ? ['If you would rather repay by check, or would like to talk about another way, please call me on (555) 010-4200.'] : []),
      ...signOff(ctx),
    ],
    attachments: ['Recovery agreement', 'Survivor payment confirmation'],
    onSent: (claimId, by) => {
      completeWork(claimId, 'communications')
      setNextStep(claimId, { label: 'Agree recovery with Ruth', reason: `Survivor letter sent ${fmtDate(TODAY)} · offset needs her agreement`, section: 'payments' })
      logEvent(claimId, { type: 'task', title: 'Next step: agree recovery with Ruth', actor: by })
    },
  },

  // ---------------------------------------------------------------- Vasquez: status letter
  {
    id: 'ST-DI-30',
    title: 'Status letter — what we still need (state rule)',
    kind: 'letter',
    claimIds: ['D-26-073390'],
    to: () => 'Elena Vasquez',
    channels: ['Portal', 'Text alert', 'First-class mail'],
    defaultChannels: ['Portal', 'Text alert'],
    fields: () => [
      { key: 'name', label: 'Claimant', value: 'Elena Vasquez' },
      { key: 'next', label: 'Next letter', value: '24 Oct' },
    ],
    clauses: [
      { id: 'aps', label: 'Physician statement', on: true },
      { id: 'fin', label: 'Financial records', on: true },
    ],
    body: (_f, on, ctx) => [
      'Dear {{name|first}},',
      'This is an update on your disability claim. We can’t make a decision yet because we are still waiting for:',
      ...(on('aps') ? ['• Dr. Hsu’s attending physician statement. We have asked her office three times and will call them this week.'] : []),
      ...(on('fin') ? ['• Your 2024 tax return and the practice P&L since June. We need them to work out your residual benefit.'] : []),
      'You will hear from us again by {{next}}, or sooner if everything arrives.',
      ...signOff(ctx),
    ],
    attachments: [],
  },

  // ---------------------------------------------------------------- Bell: doctor's update received
  {
    id: 'LTR-DI-140',
    title: 'We received your doctor’s update',
    kind: 'letter',
    claimIds: ['D-25-018334'],
    to: () => 'Marcus Bell',
    channels: ['Email', 'First-class mail'],
    defaultChannels: ['Email'],
    fields: () => [
      { key: 'name', label: 'Claimant', value: 'Marcus Bell' },
      { key: 'amount', label: 'Monthly benefit', value: '$6,695.00' },
      { key: 'proof', label: 'Proof of loss to', value: '21 Dec' },
    ],
    clauses: [
      { id: 'skills', label: 'Skills analysis on 14 Oct', on: true },
    ],
    body: (_f, on, ctx) => [
      'Dear {{name|first}},',
      'Dr. Castillo’s latest statement has arrived, so your proof of loss is now current to {{proof}}. Your benefit of {{amount}} continues on the 1st of each month.',
      ...(on('skills') ? ['As we discussed, Chris Duarte will meet you on 14 Oct for the skills analysis. It helps us plan for June 2027, when the policy’s definition of disability changes.'] : []),
      ...signOff(ctx),
    ],
    attachments: [],
  },

  // ---------------------------------------------------------------- Any claim
  {
    id: 'GEN-100',
    title: 'General letter',
    kind: 'letter',
    to: primaryParty,
    channels: ['Portal', 'Email', 'First-class mail'],
    defaultChannels: ['First-class mail'],
    fields: (ctx) => [{ key: 'name', label: 'Recipient', value: primaryParty(ctx.claim) }],
    clauses: [],
    body: (_f, _on, ctx) => ['Dear {{name|first}},', ...signOff(ctx)],
    attachments: [],
  },
]

export function templatesFor(claim: Claim): LetterTemplate[] {
  return TEMPLATES.filter((t) => (t.claimIds ? t.claimIds.includes(claim.id) : !t.families || t.families.includes(claim.family)))
}

/** The template the claim's next step calls for, if any. */
export function defaultTemplateFor(claim: Claim): LetterTemplate {
  const list = templatesFor(claim)
  return list.find((t) => t.claimIds) ?? list[list.length - 1]
}

export function templateById(id: string | undefined): LetterTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id)
}

// ---------------------------------------------------------------- Rendering

export interface Segment {
  text: string
  field?: string
}

function transform(value: string, fn?: string): string {
  if (fn === 'first') return firstName(value)
  if (fn === 'possessive') {
    const names = value.split(',').map((s) => `${s.trim()}’s`)
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  }
  return value
}

/** Splits a paragraph into text and merge-field segments so the preview can highlight fields. */
export function segments(paragraph: string, fields: Record<string, string>): Segment[] {
  const out: Segment[] = []
  const re = /\{\{(\w+)(?:\|(\w+))?\}\}/g
  let last = 0
  for (let m = re.exec(paragraph); m; m = re.exec(paragraph)) {
    if (m.index > last) out.push({ text: paragraph.slice(last, m.index) })
    const v = fields[m[1]]
    out.push({ text: v ? transform(v, m[2]) : `«${m[1]}»`, field: m[1] })
    last = m.index + m[0].length
  }
  if (last < paragraph.length) out.push({ text: paragraph.slice(last) })
  return out
}

export function plainText(paragraphs: string[], fields: Record<string, string>): string {
  return paragraphs.map((p) => segments(p, fields).map((s) => s.text).join('')).join('\n\n')
}

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (w.length <= 3) return 1
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups?.length ?? 1)
}

/** Flesch–Kincaid grade level, rounded — shown so letters stay in plain language. */
export function readingGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) ?? []).length)
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w))
  if (!words.length) return 0
  const syl = words.reduce((n, w) => n + syllables(w), 0)
  return Math.max(1, Math.round(0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59))
}
