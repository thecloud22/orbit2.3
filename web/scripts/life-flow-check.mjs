// Take the life intake end to end, then play the claim forward to its end. Screenshots, errors, and assertions
// on the outcome: the script exits non-zero if the claim doesn't end where the manner says it should.
// Usage (dev server running): node scripts/life-flow-check.mjs <out-dir> [manner]
//   manner: natural | accident | pending | evidence | evidence-close | late | competing | competing-interpleader
//   evidence           the statement never arrives; the examiner waives it, and the claim is paid
//   evidence-close     the same, but the examiner closes the claim incomplete
//   late               first contact is missed; the breach stays red
//   competing          a second person claims one half; resolved in the beneficiary's favour, then paid
//   competing-interpleader   the same, but an interpleader is filed and the half stays held
//   bounce             things bounce back: worker restart, TIN mismatch, photocopy, letters outage, returned payment
import { writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const [dir = '.', manner = 'natural'] = process.argv.slice(2)
const KNOWN = ['natural', 'accident', 'pending', 'evidence', 'evidence-close', 'late', 'competing', 'competing-interpleader', 'bounce']
if (!KNOWN.includes(manner)) { console.error(`unknown manner "${manner}"; use one of ${KNOWN.join(', ')}`); process.exit(2) }
// What to click in step 2, and which way to go at a fork.
const MANNER_LABEL = { accident: 'Accident', pending: 'Pending' }[manner]
const VARIATION_LABEL = { evidence: 'Evidence never arrives', 'evidence-close': 'Evidence never arrives', late: 'A service level is missed', competing: 'A competing claimant appears', 'competing-interpleader': 'A competing claimant appears', bounce: 'Things bounce back' }[manner]
const FORK_LABEL = { evidence: 'Waive the requirement', 'evidence-close': 'Close the claim incomplete', competing: 'Resolve in', 'competing-interpleader': 'File an interpleader' }[manner]
const base = process.env.BASE_URL ?? 'http://localhost:5173/'
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 960 })
const errs = []
const fails = []
let passed = 0
/** An assertion about the outcome. Failures are collected and make the script exit non-zero. */
const expect = (ok, msg) => { if (ok) passed++; else fails.push(msg) }
const has = (hay, needle, msg) => expect(hay.includes(needle), `${msg ?? 'expected text'}: "${needle}" not found`)
const hasNot = (hay, needle, msg) => expect(!hay.includes(needle), `${msg ?? 'unexpected text'}: "${needle}" found`)
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = (name) => p.screenshot({ path: `${dir}/${name}.png` })
const text = (sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)')

/** Clicks the first element matching `sel` whose text includes `t`. */
async function clickText(sel, t) {
  const ok = await p.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t))
    if (!el) return false
    el.click()
    return true
  }, sel, t)
  if (!ok) errs.push(`click: no ${sel} with "${t}"`)
  await wait(250)
}

await p.goto(`${base}#/intake/life`)
await wait(700)
if (process.env.HIDE_TOASTS) await p.addStyleTag({ content: '.toasts { display: none !important; }' })
const scrollTo = (sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel)
  const main = el?.closest('.cw-main')
  if (el && main) main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 8
}, sel)
const toTabs = () => scrollTo('.wf-tabs')
await shot('li-1-caller')
await clickText('label.ik-check', 'date of birth')
await clickText('label.ik-check', 'policy number')
await clickText('label.radio-card', 'Yes')
await clickText('.ik-foot button', 'Continue')
if (MANNER_LABEL) await clickText('label.radio-card', MANNER_LABEL)
if (VARIATION_LABEL) await clickText('label.radio-card', VARIATION_LABEL)
await shot('li-2-deceased')
await clickText('.ik-foot button', 'Continue')
await clickText('label.ik-check', 'Coverage read back')
await shot('li-3-policies')
await clickText('.ik-foot button', 'Continue')
await clickText('button', 'Fill sample answers')
await p.evaluate(() => {
  const radios = [...document.querySelectorAll('input[name="li-others"]')]
  radios.find((r) => r.value === 'no')?.click()
})
await wait(200)
await shot('li-4-beneficiaries')
await clickText('.ik-foot button', 'Continue')
await clickText('label.ik-check', 'Next steps read back')
await shot('li-5-review')
console.log('missing before submit:', await text('.ik-missing'))
await clickText('.ik-foot button', 'Submit claim')
await clickText('.ik-foot button', 'Submit and watch')
await wait(1200)
console.log('url after submit:', p.url().split('#')[1])
await shot('wf-0-replay')
await wait(4200)
await toTabs()
await shot('wf-0-replay-done')

await clickText('.wf-tab', 'Swimlane')
const claimId = p.url().match(/claims\/([^/]+)/)?.[1]
let i = 1
let plays = 0
let forkSeen = false
let slaMid = []
let atFork = null
let exceptionMid = ''
const trail = []
while (true) {
  const fork = await p.$('.wf-fork')
  if (fork) {
    // The claim waits for the examiner: pick the way out this manner takes.
    forkSeen = true
    const title = await text('.wf-play-next strong')
    atFork = { title, clock: await text('.wf-play-clock'), text: await text('.wf-play-next'), exceptions: await text('.xs') }
    console.log(`fork: ${title} → ${FORK_LABEL}`)
    await p.evaluate(() => document.querySelector('.cw-main')?.scrollTo(0, 0))
    await shot(`wf-fork-${i}`)
    await clickText('.wf-play-actions button', FORK_LABEL)
    await wait(500)
    await p.evaluate(() => document.querySelector('.cw-main')?.scrollTo(0, 0))
    await shot(`wf-fork-${i}-chosen`)
    trail.push(`choose ${FORK_LABEL}`)
    i++
    continue
  }
  const next = await text('.wf-next-line')
  const disabled = await p.$eval('.wf-play-actions .btn--primary', (e) => e.disabled).catch(() => true)
  if (disabled) break
  console.log(`play ${i}:`, next)
  trail.push(next)
  await clickText('.wf-play-actions button', 'Play next')
  plays++
  await wait(500)
  if ([1, 4, 6].includes(i)) await shot(`wf-${i}`)
  if (manner === 'late' && i === 1) {
    // Right after the nightly check: the breach is red, and the claim has an exception.
    slaMid = await p.$$eval('.wf-sla tbody tr', (trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()))
    exceptionMid = await text('.xs')
    await scrollTo('.wf-sla')
    await shot('wf-breach-sla')
    await p.evaluate(() => document.querySelector('.cw-main')?.scrollTo(0, 0))
  }
  i++
  if (i > 30) { errs.push('too many steps'); break }
}
const nextText = await text('.ch-next')
console.log('header next step:', nextText)
console.log('clocks:', await text('.ch-bottom'))
const playText = await text('.wf-play')
const exceptionText = await text('.xs')
await shot('wf-end-top')
await scrollTo('.wf-sla')
await shot('wf-end-sla')
const slaText = await text('.wf-sla')
const slaRows = await p.$$eval('.wf-sla tbody tr', (trs) => trs.map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()))
await toTabs()
await shot('wf-end-lanes')
const laneText = await text('.wf-lanes')
await clickText('.wf-tab', 'Deadline rows')
await toTabs()
await shot('wf-end-rows')
/** [id, kind, what, due, status, how it closed] for every deadline row. */
const rows = await p.$$eval('.wf-rows tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim())))
await clickText('.wf-tab', 'Workflow runs')
await toTabs()
await shot('wf-end-runs')
const runIds = await p.$$eval('.wf-run-id', (els) => els.map((e) => e.textContent.trim()))

const id = claimId
const pages = {}
for (const s of ['overview', 'requirements', 'documents', 'decision', 'payments', 'communications', 'history', 'people', 'policies']) {
  await p.goto(`${base}#/claims/${id}/${s}`)
  await wait(500)
  await shot(`claim-${s}`)
  if (s === 'requirements') {
    // Open Mark's requirement, so its plan (and any waiver reason) is on the page.
    await clickText('.cw-main tbody tr', 'W-9 · Mark')
    await wait(300)
    await shot('claim-requirements-mark')
  }
  pages[s] = await text('.cw-main')
  if (s === 'overview') pages.header = await text('.ch')
}
await p.goto(`${base}#/work`)
await wait(400)

// ---------------------------------------------------------------- What the claim looks like at the end
const sla = (name) => slaRows.find((r) => r.startsWith(name)) ?? ''
console.log('\nplays:', plays, '· runs:', runIds.length, '· rows:', rows.length)
console.log('rows:', rows.map((r) => `${r[0]} ${r[1]} ${r[4]}`).join(' | '))
console.log('sla:', slaRows.join('\n     '))
console.log('runs:', runIds.join(', '))
console.log('exceptions:', exceptionText)
console.log('play panel:', playText)

writeFileSync(`${dir}/pages.json`, JSON.stringify({ pages, rows, slaRows, runIds, exceptionText, playText }, null, 1))

// What each manner must end in. Each block asserts the numbers and dates the README's Variations table quotes.
const count = (kind, status) => rows.filter((r) => r[1] === kind && r[4] === status).length
const rowOf = (id) => rows.find((r) => r[0] === id) ?? []
const noException = () => expect(exceptionText === '(none)', `no exception should stay open, found: ${exceptionText}`)
const closedFully = () => {
  has(playText, 'Nothing left to happen', 'the play panel')
  hasNot(playText, 'Closed incomplete', 'a normal close')
  expect(rows.every((r) => r[4] !== 'Open'), 'every deadline row should be closed, fired or skipped')
}
const OUTCOMES = {}
OUTCOMES.natural = () => {
  expect(plays === 7, `natural should take 7 steps, took ${plays}`)
  expect(rows.length === 11, `natural should write 11 deadline rows, wrote ${rows.length}`)
  expect(count('requirement_follow_up', 'Fired · done') === 1 && count('status_letter', 'Skipped') === 1, 'natural: one row fires (D-707) and the status letter is skipped')
  has(nextText, 'Paid 9 Oct · $200,383.56', 'header')
  has(pages.payments, '$200,383.56', 'payments')
  closedFully()
}
OUTCOMES.accident = () => {
  expect(plays === 9, `accident should take 9 steps, took ${plays}`)
  has(nextText, 'Paid 9 Oct · $400,767.12', 'header')
  has(pages.history, 'approved by Monica Reyes', 'history')
  closedFully()
}
OUTCOMES.pending = () => {
  expect(plays === 10, `pending should take 10 steps, took ${plays}`)
  expect(rowOf('D-704')[4] === 'Fired · done' && rowOf('D-711')[4] === 'Skipped', 'pending: status letter 1 fires (D-704), the next is skipped')
  has(pages.history, 'Status letter 1 sent', 'history')
  has(nextText, 'Paid 30 Oct · $200,786.30', 'header')
  closedFully()
}
/** Shared by both evidence outcomes: what the never-arriving statement leaves behind before the examiner chooses. */
const evidenceTrail = () => {
  expect(forkSeen, 'evidence: the claim should stop at the expiry for the examiner')
  has(atFork?.text ?? '', 'Waive the requirement', 'the fork offers waiving')
  has(atFork?.text ?? '', 'Close the claim incomplete', 'the fork offers closing incomplete')
  has(atFork?.exceptions ?? '', 'statement expired', 'exception strip at the fork')
  expect(count('requirement_follow_up', 'Fired · done') === 3, 'evidence: three follow-ups fire (reminder, call task, final notice)')
  expect(count('requirement_expiry', 'Fired · done') === 1, 'evidence: the expiry row fires')
  expect(count('status_letter', 'Fired · done') === 2, 'evidence: two status letters go out (25 Oct, 24 Nov)')
  has(pages.history, 'Call task opened', 'history: the call task')
  has(pages.history, 'Status letter 2 sent', 'history: status letter 2')
  has(pages.history, 'Request expired', 'history: expiry')
  has(pages.communications, 'Final notice', 'letters: final notice')
  has(pages.communications, 'Request expired', 'letters: expiry notice')
  has(pages.communications, 'waiting on Claimant statement and W-9 · Mark', 'a status letter lists what is missing')
  for (const id of ['deadline-D-707', 'deadline-D-709', 'deadline-D-710', 'deadline-D-708']) expect(runIds.includes(id), `evidence: workflow run ${id}`)
}
OUTCOMES.evidence = () => {
  evidenceTrail()
  expect(plays === 11, `evidence (waive) should take 11 steps plus the choice, took ${plays}`)
  expect(rows.length === 16, `evidence (waive) should write 16 deadline rows, wrote ${rows.length}`)
  expect(rowOf('D-712')[4] === 'Skipped' && rowOf('D-713')[4] === 'Skipped', 'waived: the open follow-up and status letter 3 are skipped')
  has(pages.requirements, 'Waived 9 Dec', 'requirements')
  has(pages.requirements, 'Unobtainable — documented attempts', 'the waiver reason on the requirement')
  has(pages.history, 'Requirement waived', 'history: the waiver')
  has(pages.history, 'Proof of loss complete', 'history: proof complete after the waiver')
  has(nextText, 'Paid 11 Dec · $201,591.78', 'header')
  has(pages.payments, '$201,591.78', 'payments')
  expect(!slaText.includes('Breached'), 'no service level should be breached')
  closedFully()
}
OUTCOMES['evidence-close'] = () => {
  evidenceTrail()
  expect(plays === 9, `evidence (close) should take 9 steps plus the choice, took ${plays}`)
  expect(rows.length === 13, `evidence (close) should write 13 deadline rows, wrote ${rows.length}`)
  expect(rowOf('D-712')[4] === 'Skipped' && rowOf('D-713')[4] === 'Skipped', 'closed incomplete: the open follow-up and status letter 3 are skipped')
  has(playText, 'Closed incomplete', 'status')
  has(nextText, 'Claim closed incomplete', 'header')
  has(pages.payments, 'No payments yet', 'nothing paid')
  has(pages.communications, 'Claim closed incomplete', 'letters: closing letters')
  has(pages.history, 'Claim closed incomplete', 'history')
  has(sla('Interest'), 'Not paid — closed incomplete', 'interest service level')
  has(pages.requirements, 'Expired 9 Dec', 'the requirement stays expired')
  expect(rows.every((r) => r[4] !== 'Open'), 'every deadline row should be closed, fired or skipped')
  noException()
}
OUTCOMES.late = () => {
  expect(plays === 8, `late should take 8 steps, took ${plays}`)
  expect(rowOf('D-703')[4] === 'Breached · fired late', 'late: D-703 shows as breached, fired late')
  expect(runIds.includes('deadline-D-703'), 'late: the deadline workflow deadline-D-703 ran')
  has(atFork?.text ?? slaMid[0] ?? '', 'Breached · 1 day late', 'the service level is red right after the nightly check')
  has(exceptionMid, 'First contact missed', 'exception strip after the nightly check')
  has(sla('First contact'), 'Breached · met 29 Sep, 1 day late', 'the breach stays on the service level after the late call')
  expect(slaRows.filter((r) => r.includes('Breached')).length === 1, 'late: only first contact is breached')
  has(laneText, 'Nightly check 02:00', 'swimlane')
  has(pages.history, 'Nightly check: 1 deadline past due, D-703', 'history: nightly check')
  has(pages.history, 'Service level missed: first contact', 'history: the breach')
  has(pages.history, 'first contact met 1 day late', 'history: the late call')
  has(pages.header, '1 day late', 'header clock')
  has(nextText, 'Paid 9 Oct · $200,383.56', 'header')
  expect(exceptionText === '(none)', 'the exception is resolved once the late call is made')
  closedFully()
}
OUTCOMES.competing = () => {
  expect(forkSeen, 'competing: the claim should stop for the examiner')
  expect(plays === 10, `competing (resolve) should take 10 steps plus the choice, took ${plays}`)
  has(atFork?.clock ?? '', 'Open · share on hold', 'status at the fork')
  has(atFork?.exceptions ?? '', 'Competing claim to Mark’s half', 'exception strip at the fork')
  expect(rowOf('D-708')[1] === 'dispute_response_by' && rowOf('D-708')[4] === 'Fired · done', 'competing: the response row D-708 fires on Sun 1 Nov')
  expect(rows.filter((r) => r[1] === 'payment_due').length === 2, 'competing: two payment rows (Diane, then Mark)')
  has(pages.payments, '$100,191.78', 'Diane’s half')
  has(pages.payments, '$100,431.51', 'Mark’s half, released')
  expect(!pages.payments.includes('held for a competing claim'), 'the hold panel is gone once released')
  has(nextText, 'Paid 3 Nov · $100,431.51', 'header')
  has(sla('Interest'), '$623.29 in all', 'interest service level')
  has(pages.history, 'Competing claim opened', 'history: opened')
  has(pages.history, 'Competing claim resolved in Mark’s favour', 'history: resolved')
  has(pages.communications, 'A competing claim was made on your share · Mark', 'letters: to the beneficiary')
  has(pages.communications, 'Claim resolved · Dana', 'letters: resolution')
  has(pages.documents, 'Letter from Dana Reyes’s attorney', 'documents')
  has(pages.people, 'Claim not upheld', 'people')
  has(pages.decision, 'v2', 'a second decision record')
  noException()
  closedFully()
}
OUTCOMES['competing-interpleader'] = () => {
  expect(forkSeen, 'competing: the claim should stop for the examiner')
  expect(plays === 9, `competing (interpleader) should take 9 steps plus the choice, took ${plays}`)
  has(playText, 'Open · share on hold', 'status')
  has(playText, 'reviewed on Thu 17 Dec', 'the review date')
  hasNot(playText, 'The claim closed', 'the claim stays open')
  expect(rowOf('D-713')[1] === 'hold_review' && rowOf('D-713')[4] === 'Open' && rowOf('D-713')[3] === 'Thu 17 Dec', 'interpleader: an open hold_review row D-713 due Thu 17 Dec')
  expect(rows.filter((r) => r[4] === 'Open').length === 1, 'interpleader: the hold row is the only open row')
  has(exceptionText, 'Interpleader filed', 'exception strip')
  has(exceptionText, 'Review 17 Dec', 'exception strip')
  has(pages.payments, 'held for the court', 'payments: hold panel')
  has(pages.payments, '$100,000.00 held', 'payments: the held half')
  has(pages.payments, '$100,191.78', 'Diane’s half was paid')
  has(pages.history, 'Interpleader filed', 'history')
  has(pages.communications, 'Interpleader filed · Mark', 'letters')
  has(sla('Interest'), 'Mark’s half still accruing', 'interest service level')
  has(nextText, 'docket review Thu 17 Dec', 'header')
  expect(!runIds.includes('event-E-9009'), 'the claim did not close: no closing event')
}
OUTCOMES.bounce = () => {
  expect(plays === 14, `bounce should take 14 steps, took ${plays}`)
  expect(rows.length === 16, `bounce should write 16 deadline rows, wrote ${rows.length}`)
  expect(runIds.length === 14, `bounce should run 14 workflows, ran ${runIds.length}`)
  expect(runIds.filter((r) => r === 'event-E-9004').length === 2, 'bounce: event-E-9004 runs twice (failed, then re-run under the same ID)')
  expect(count('requirement_follow_up', 'Fired · done') === 1, 'bounce: only Mark’s follow-up fires')
  expect(rowOf('D-709')[1] === 'document_review_by' && rowOf('D-709')[4] === 'Closed early', 'bounce: the review row D-709 closes when Rachel reviews')
  expect(rowOf('D-715')[1] === 'bank_details_by' && rowOf('D-715')[4] === 'Closed early', 'bounce: the bank-details row D-715 closes when Mark adds an account')
  expect(rowOf('D-716')[1] === 'payment_due', 'bounce: D-716 is the reissue payment row')
  has(sla('Review a document'), 'Met 1 Oct', 'document review service level')
  has(sla('Reissue a returned payment'), 'Met 20 Oct', 'reissue service level')
  has(sla('Interest'), '24 days · $460.27', 'interest service level')
  has(nextText, 'Paid 20 Oct · $100,230.14', 'header')
  has(pages.payments, 'Returned 15 Oct · account closed', 'payments: the returned item stays')
  has(pages.payments, 'Replacement for the returned payment', 'payments: the replacement item')
  has(pages.payments, '$100,230.13', 'payments: Diane’s half')
  has(pages.documents, 'Rejected · not certified', 'documents: the photocopy')
  has(pages.documents, 'Corrected W-9 — Diane', 'documents: the corrected W-9')
  has(pages.history, 'Not enough: Claimant statement and W-9 · Diane — TIN mismatch', 'history: the TIN mismatch')
  has(pages.history, 'Letter workflow failed after 5 attempts', 'history: the failed run')
  has(pages.history, 'Claim reopened — payment returned', 'history: reopened')
  // Communications shows the newest letters first and folds the rest; the earlier ones are checked in the history.
  has(pages.history, 'Letter sent: certified copy needed · Diane', 'history: the letter sent by the re-run')
  has(pages.history, 'event-E-9004 run 2', 'history: the re-run')
  has(pages.communications, 'Your payment was returned · Mark', 'letters: returned payment')
  has(laneText, 'Worker A restarted', 'swimlane: the worker restart')
  expect(!slaText.includes('Breached'), 'no service level should be breached')
  noException()
  closedFully()
}
OUTCOMES[manner]()

if (errs.length) console.log(`ERRORS:\n${errs.join('\n')}`)
else console.log('no errors')
if (fails.length) console.log(`ASSERTIONS FAILED (${fails.length}, ${passed} passed):\n  ${fails.join('\n  ')}`)
else console.log(`assertions: ${passed} passed`)
await b.close()
process.exit(errs.length || fails.length ? 1 : 0)
