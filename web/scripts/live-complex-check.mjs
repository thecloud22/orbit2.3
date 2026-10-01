// Drives the COMPLEX life-claim scenario, "things bounce back", in the browser against the real backend, using only what a presenter can click,
// and ASSERTS on it (non-zero exit on failure). The five bounces of docs/life-claim/README-back-and-forth.html:
//   1. a worker stalls mid intake (the acknowledgement step times out; Temporal runs it again: attempts 2, the run takes > 30 s)
//   2. Diane's W-9 fails the IRS check (a TIN mismatch is an ANSWER: not enough, one IRS check, no retry, a 7-day correction follow-up); the corrected W-9 is accepted
//   3. a photocopied death certificate goes to Rachel; she rejects it while the letters service is down: the letter workflow retries 5 times and FAILS,
//      an ops task opens; Re-run starts run 2 under the same workflow id and the certified-copy letter goes out once
//   4. Mark is late: his follow-up row fires (the only row that does)
//   5. the bank returns Mark's payment: the claim reopens, Mark's new account makes a replacement item, the next run pays it, the claim closes again
// Clicked: the Demo controls' Complex checklist (fault switches, document arrivals, clock moves, bank), Documents (Rachel's rejection), Workflow & SLA
// (Re-run), Decision (Rachel records it), plus the notice of death on the intake form. The final counts are the mock's: 14 workflow runs (1 failed,
// then run 2), 16 deadline rows (1 fired, 1 skipped, 14 closed early, none open), 19 letters with no duplicates, $200,460.27 = $100,230.13 + $100,230.14
// (24 days of interest, $460.27), the claim closed twice.
//
// Start first (web/README.md "Live mode"; docs/life-claim/LIVE-DEMO.md): Postgres, the .NET API with Claims:Dev:Controls=true and
// Claims:Temporal:DevServer=true (the dispatcher Schedule every 5 s; the daily payment run's own trigger on or off), and the web app
//   VITE_API_BASE=/api DEMO_API_TARGET=http://127.0.0.1:8080 npm run dev -- --port 5174
// The backend must be FRESH (no claims) and its virtual clock not yet moved: the story runs from the real "now" forward (clocks only move forward)
// and needs the real date to be before Fri 2 Oct 2026, so that Mon 12 Oct (decision day) and Tue 13 Oct (the pay day) are still ahead.
// It takes about 3 minutes: the stalled step (about 35 s) and the failed letter run (about 30 s) are real Temporal timeouts and retries.
//
// Usage: node scripts/live-complex-check.mjs <out-dir>     (BASE_URL, default http://localhost:5174/)
import puppeteer from 'puppeteer-core'

const [dir = '.'] = process.argv.slice(2)
const base = process.env.BASE_URL ?? 'http://localhost:5174/'
const api = (path, init) => fetch(`${base}api${path}`, init)
const json = (path, init) => api(path, init).then((r) => r.json())
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)} s] ${m}`)
const fails = []
let passed = 0
const expect = (ok, msg) => { if (ok) { passed++; console.log(`  ok   ${msg}`) } else { fails.push(msg); console.error(`  FAIL ${msg}`) } }
const money = (m) => Number.parseFloat(m.amount)
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

// ---- preflight
const existing = await json('/claims').catch(() => null)
if (!existing) { console.error(`cannot reach the API through ${base}api. Is the backend up and the web app started with VITE_API_BASE=/api?`); process.exit(2) }
if (existing.items.length > 0 && !process.env.LIVE_ALLOW_EXISTING) { console.error('the backend already has claims; start from a fresh database (or set LIVE_ALLOW_EXISTING=1)'); process.exit(2) }
const clock0 = await json('/dev/clock').catch(() => null)
if (!clock0?.now) { console.error('the backend has no /dev/clock (start it with Claims:Dev:Controls=true)'); process.exit(2) }
if (clock0.businessDate >= '2026-10-02') { console.error(`the backend's clock is on ${clock0.businessDate}: the story needs it to be before Fri 2 Oct 2026 (the clock only moves forward). Restart the backend (a fresh database and clock) and run this before that date.`); process.exit(2) }
if ((await api('/dev/faults')).status !== 200) { console.error('the backend has no /dev/faults (Claims:Dev:Controls=true, and a build with the complex-scenario endpoints)'); process.exit(2) }
const staff = (await json('/staff')).items
const rachel = staff.find((s) => s.handle === 'rachel')
if (!rachel) { console.error('GET /staff has no rachel'); process.exit(2) }

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 900 })
const errs = []
const posts = []
p.on('pageerror', (e) => errs.push(e.message))
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
p.on('request', (r) => { if (r.method() === 'POST') posts.push({ url: r.url().replace(/^.*\/api/, ''), actor: r.headers()['x-actor'], ifMatch: r.headers()['if-match'], key: r.headers()['idempotency-key'], body: r.postData() }) })
process.on('exit', (code) => { if (code && errs.length) console.error(`browser errors so far:\n${errs.join('\n')}`) })
const shot = (name) => p.screenshot({ path: `${dir}/${name}.png` })
const text = (sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '')
const bodyText = () => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
const clickText = async (sel, t, ms = 250) => {
  const ok = await p.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t) && !e.disabled)
    if (!el) return false
    el.click()
    return true
  }, sel, t)
  if (!ok) errs.push(`click: no enabled ${sel} with "${t}"`)
  await wait(ms)
  return ok
}
async function until(fn, ms = 20000, every = 400) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return false
    await wait(every)
  }
}
const goto = async (path, ms = 1200) => { await p.goto(`${base}#${path}`); await wait(ms) }
const clock = () => json('/dev/clock')
// Scrolls the claim's main column only (scrollIntoView would also scroll the app's overflow:hidden containers).
const scrollMain = (sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel)
  const main = el?.closest('.cw-main')
  if (el && main) main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 8
}, sel)
const overflowAt = (label) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth).then((o) => expect(!o, `${label}: no horizontal page scroll`))

// The Demo controls panel: expanded, on the Complex tab. What a presenter clicks.
const panelOpen = () => p.evaluate(() => document.querySelector('[data-demo-controls]')?.getAttribute('data-dock') !== 'closed')
async function openPanel() {
  if (!(await panelOpen())) await clickText('.dc-toggle', 'Demo controls', 400)
}
async function closePanel() {
  if (await panelOpen()) await clickText('.dc-toggle', 'Demo controls', 400)
}
/** A button or link in the checklist's "Next:" block (the presenter's hint and its buttons). */
async function guideClick(label) {
  await openPanel()
  const ok = await until(() => p.evaluate((t) => [...document.querySelectorAll('[data-guide] .dc-buttons button, [data-guide] .dc-buttons a')].some((e) => e.textContent.includes(t) && !e.disabled), label), 8000, 250)
  if (!ok) { errs.push(`guide: no enabled "${label}" among ${await text('[data-guide] .dc-buttons')}`); return false }
  return clickText('[data-guide] .dc-buttons button, [data-guide] .dc-buttons a', label, 600)
}
const guideNext = () => text('[data-guide] [data-next]')
const guideSteps = () => p.$$eval('[data-guide] [data-step]', (els) => Object.fromEntries(els.map((e) => [e.dataset.step, e.dataset.done === 'true' ? 'done' : e.classList.contains('dc-step--current') ? 'current' : 'todo'])))

// ---- 0. the panel: collapsed by default, docked, Complex tab, the checklist
log('0. Demo controls panel')
await goto('/work', 1500)
{
  const closed = await p.evaluate(() => {
    const a = document.querySelector('[data-demo-controls]')
    if (!a) return null
    const r = a.getBoundingClientRect()
    const body = document.querySelector('.app-body').getBoundingClientRect()
    return { dock: a.getAttribute('data-dock'), height: r.height, top: r.top, bodyBottom: body.bottom, text: a.textContent.replace(/\s+/g, ' ') }
  })
  expect(closed?.dock === 'closed', 'the panel is collapsed by default')
  expect(!!closed && closed.height <= 40, `collapsed it is one slim bar (${Math.round(closed?.height ?? 0)} px high)`)
  expect(!!closed && closed.top >= closed.bodyBottom - 1, 'the collapsed bar is below the page content, not over it')
  expect(!!closed && /Next:/.test(closed.text), `the pill carries the next hint ("${closed?.text.slice(0, 110)}")`)
  await shot('c0-panel-collapsed')
}
await openPanel()
await clickText('[data-scenario-tab="complex"]', 'Complex')
{
  const s = await guideSteps()
  expect(Object.keys(s).length === 20, `the Complex checklist has 20 steps (${Object.keys(s).length})`)
  expect(s.stall === 'current', 'the first step is to stall the worker, and the checklist is worked out from the backend (nothing else is done yet)')
  const geo = await p.evaluate(() => {
    const a = document.querySelector('[data-demo-controls]').getBoundingClientRect()
    const body = document.querySelector('.app-body').getBoundingClientRect()
    return { aTop: a.top, aH: a.height, bodyBottom: body.bottom, vh: window.innerHeight }
  })
  expect(geo.aTop >= geo.bodyBottom - 1, 'the open panel is docked below the page, not over it')
  expect(geo.aH <= geo.vh * 0.4, `and takes at most 40% of the height (${Math.round(geo.aH)} of ${geo.vh})`)
  await shot('c0-panel-expanded-complex')
}
await closePanel()

// ---- 1. bounce 1: a worker stalls in the next intake
log('1. Bounce 1: stall the worker, file the notice')
await openPanel()
expect(await guideClick('Stall the worker'), 'clicked: Stall the worker (checklist)')
{
  const f = await json('/dev/faults')
  expect(f.active.some((x) => x.name === 'worker.stall-once:LifeIntake_SendAcknowledgementAndPackets'), 'the backend has the worker stall armed for the next intake')
  await until(async () => (await guideSteps()).stall === 'done', 6000)
  expect((await guideSteps()).stall === 'done' && (await guideSteps()).intake === 'current', 'the checklist moves on to filing the notice')
}
await closePanel()
await goto('/intake/life', 900)
await clickText('label.ik-check', 'date of birth')
await clickText('label.ik-check', 'policy number')
await clickText('label.radio-card', 'Yes')
await clickText('.ik-foot button', 'Continue')
await clickText('.ik-foot button', 'Continue')
await clickText('label.ik-check', 'Coverage read back')
await clickText('.ik-foot button', 'Continue')
await clickText('button', 'Fill sample answers')
await p.evaluate(() => [...document.querySelectorAll('input[name="li-others"]')].find((r) => r.value === 'no')?.click())
await wait(200)
await clickText('.ik-foot button', 'Continue')
await clickText('label.ik-check', 'Next steps read back')
await clickText('.ik-foot button', 'Submit claim')
await clickText('.ik-foot button', 'Submit and watch')
expect(await until(() => /#\/claims\/L-\d\d-\d{6}\/workflow/.test(p.url()), 10000), 'submitting the notice lands on the claim (Workflow & SLA)')
const claimNo = p.url().match(/claims\/([^/]+)/)?.[1]
if (!claimNo) { await shot('c1-fail'); console.error(errs.join('\n')); process.exit(1) }
const claimId = (await json(`/claims?claimNumber=${claimNo}`)).items[0]?.id
log(`   claim ${claimNo}`)
const getClaim = () => json(`/claims/${claimId}`)
const list = async (what) => (await json(`/claims/${claimId}/${what}${what === 'history' ? '?limit=200' : ''}`)).items
const runs = () => list('workflow-runs')
const docs = () => list('documents')
const reqs = () => list('requirements')
const rows = () => list('deadlines')
const items = () => list('payment-items')
await wait(2500)
await openPanel()
expect((await guideNext()).includes('Wait about 35 s'), `while the intake runs the hint says what to say ("${(await guideNext()).slice(0, 90)}…")`)
await shot('c1-intake-running')
await closePanel()
expect(await until(async () => (await getClaim()).status === 'gathering_evidence', 100000, 1000), 'the intake workflow finished: gathering evidence')
log('   intake finished')
{
  const intake = (await runs()).find((r) => r.type === 'orchestration')
  const step = intake?.steps.find((s) => s.state === 'retried')
  expect(!!step && step.attempts === 2 && /Send the acknowledgement/.test(step.label), `the acknowledgement step was retried: attempts ${step?.attempts} (${step?.label})`)
  expect(intake.elapsedMs > 30000, `the run took ${(intake.elapsedMs / 1000).toFixed(1)} s (more than the step's 30 s timeout)`)
  expect(/scheduled it again|did not (report back|finish)|timed out/i.test(`${intake.note} ${step?.note}`), 'the run carries a note saying what Temporal did')
  expect(intake.steps.filter((s) => s.state === 'retried').length === 1 && intake.status === 'completed', 'only that step was retried; the run completed')
  const letters = (await list('letters')).filter((l) => /^(ACK|PKT)/.test(l.templateCode))
  expect(new Set(letters.map((l) => `${l.templateCode}|${l.recipientLabel}`)).size === letters.length, `no letter went twice after the retry (${letters.length} acknowledgement and packet letters, all different)`)
}
await goto(`/claims/${claimNo}/workflow`, 1500)
await clickText('.wf-tab', 'Workflow runs')
await wait(800)
{
  const t = await text('.wf-runs')
  expect(await p.$('[data-attempts="2"]') !== null, 'Workflow runs shows an attempt badge on the retried step (2 attempts)')
  expect(/What Temporal did/.test(t) && /ran 2 times/.test(t), 'the intake run shows the “What Temporal did” callout (ran 2 times)')
  expect(/Retried · 2 attempts/.test(t), 'and a “Retried” tag on the run itself')
  expect(/took 3\d(\.\d)? s/.test(t), 'and the elapsed time (about 32 s)')
  await scrollMain('.wf-tabs')
  await shot('c1-intake-retried-run')
}

// ---- welcome call
log('2. Welcome call')
await goto(`/claims/${claimNo}/workflow`, 1200)
await clickText('[data-log-welcome-call]', 'Log the welcome call')
expect(await until(async () => (await rows()).find((d) => d.kind === 'first_contact_by')?.state === 'done', 8000), 'logging the welcome call closes first_contact_by')

// ---- bounce 2: Diane's W-9 with a TIN typo
log('3. Bounce 2: Diane’s W-9, a TIN mismatch')
await openPanel()
expect((await guideNext()).includes('W-9'), `the checklist points at Diane’s W-9 ("${(await guideNext()).slice(0, 80)}…")`)
expect(await guideClick('Diane’s W-9 · TIN typo'), 'clicked: Diane’s W-9 · TIN typo (checklist)')
expect(await until(async () => (await docs()).some((d) => d.status === 'not_enough'), 40000), 'the document workflow decided: the W-9 is not enough')
await closePanel()
{
  const d = (await docs()).find((x) => x.status === 'not_enough')
  expect(d.statusNote === 'TIN mismatch' && d.attributes.tinMasked === '***-**-6798' && /^Diane Castellano/.test(d.partyName), `the document: ${d.partyName}, "${d.statusNote}", taxpayer number ${d.attributes.tinMasked} (last four only)`)
  const req = (await reqs()).find((r) => r.id === d.requirementId)
  expect(req.state === 'not_enough' && req.stateNote === 'TIN mismatch', `Diane's requirement is not_enough with the note "${req.stateNote}"`)
  const run = (await runs()).find((r) => r.workflowId === d.workflowId)
  const check = run?.steps.find((s) => /taxpayer/i.test(s.label))
  expect(run?.status === 'completed' && check?.state === 'done' && check.attempts === 1, `one IRS check, no retry: "${check?.label}" attempts ${check?.attempts}, the run ${run?.status} (a "no match" is an answer, not an error)`)
  expect(/not an error|answer/i.test(run.note ?? ''), 'the run says why Temporal did not retry')
  const chase = (await rows()).find((r) => r.kind === 'requirement_follow_up' && /corrected/i.test(r.what) && r.requirementId === req.id)
  // Due 08:00 local, seven calendar days after today (the row says "7-day correction follow-up").
  const chicago = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso))
  const days = Math.round((Date.parse(chicago(chase?.dueAt)) - Date.parse((await clock()).businessDate)) / 86_400_000)
  expect(!!chase && chase.state === 'open' && days === 7, `a correction follow-up row is due ${chicago(chase?.dueAt)}: ${days} days from the business date ${(await clock()).businessDate} (7)`)
  expect((await rows()).filter((r) => r.requirementId === req.id && r.what.startsWith('Follow up:') && !/corrected/i.test(r.what))[0]?.state === 'done', 'and the first follow-up row was closed')
  expect((await list('letters')).some((l) => l.templateCode === 'W9-LIFE-01'), 'the claimant is asked for a corrected W-9 (W9-LIFE-01)')
  const tinLog = (await json('/dev/faults')).log.filter((x) => x.name === 'tin.no-match')
  console.log(`   IRS fault log: ${tinLog.map((x) => x.detail).join(' | ')}`)
}
{
  const d = (await docs()).find((x) => x.status === 'not_enough')
  await goto(`/claims/${claimNo}/requirements/${d.requirementId}`, 1500)
  const t = await bodyText()
  expect(/Not enough · TIN mismatch/.test(t), 'Requirements shows the state "Not enough · TIN mismatch"')
  expect(/correction follow-up fires/i.test(t), 'the follow-up plan shows the correction follow-up row')
  expect(/Documents that touched it/.test(t) && /Claimant statement and W-9/.test(await text('[data-req-docs]')) && /Not enough/.test(await text('[data-req-docs]')), 'the requirement detail lists the document that touched it, with its status')
  await shot('c3-requirements-tin-mismatch')
}
await goto(`/claims/${claimNo}/documents`, 1500)
{
  const row = await text('[data-doc-row][data-doc-status="not_enough"]')
  expect(/Claimant statement and W-9/.test(row) && /Diane Castellano/.test(row) && /Portal/.test(row) && /TIN mismatch/.test(row) && /\*\*\*-\*\*-6798/.test(row), `Documents lists it: kind, from whom, source, status note, masked TIN ("${row.slice(0, 150)}")`)
  const d = (await docs()).find((x) => x.status === 'not_enough')
  const link = await p.$eval('[data-doc-row][data-doc-status="not_enough"] [data-doc-workflow]', (e) => e.textContent.trim()).catch(() => '')
  expect(link === d.workflowId, `the workflow id that handled it is a link (${link.slice(0, 26)}…)`)
  await shot('c3-documents-tin-mismatch')
}

// ---- the corrected W-9
log('4. The corrected W-9')
await openPanel()
expect(await guideClick('Corrected W-9 arrives'), 'clicked: Corrected W-9 arrives')
expect(await until(async () => (await reqs()).some((r) => r.key === 'statement' && r.state === 'accepted'), 40000), 'a statement is accepted')
await closePanel()
{
  const w9 = (await docs()).filter((d) => d.kind === 'claimant_statement_w9')
  expect(w9.length === 2 && w9[0].status === 'not_enough' && w9[1].status === 'accepted' && w9[0].workflowId !== w9[1].workflowId, `two W-9 documents: not_enough, then accepted, each handled by its own workflow (${w9.map((d) => d.workflowId?.slice(0, 14)).join(', ')})`)
  const chase = (await rows()).find((r) => r.kind === 'requirement_follow_up' && /corrected/i.test(r.what))
  expect(chase.state === 'done' && chase.fired === false && chase.closedBy === 'requirement', 'the correction follow-up closed early (never fired)')
  const run2 = (await runs()).find((r) => r.workflowId === w9[1].workflowId)
  expect(run2.steps.find((s) => /taxpayer/i.test(s.label))?.detail.includes('match: ok'), 'the corrected number matched at the IRS check')
}

// ---- bounce 3: a photocopy
log('5. Bounce 3: the photocopied death certificate')
await openPanel()
expect(await guideClick('Photocopied certificate arrives'), 'clicked: Photocopied certificate arrives')
expect(await until(async () => (await docs()).some((d) => d.status === 'under_review'), 40000), 'the rules could not accept it: the document is under review')
await closePanel()
{
  const cert = (await reqs()).find((r) => r.key === 'certificate')
  expect(cert.state === 'received' && /Under review/.test(cert.stateNote ?? ''), `the requirement is received, "${cert.stateNote}"`)
  const wi = (await json('/work-items?status=open&limit=200')).items.find((w) => w.claimId === claimId && /Review the death certificate/.test(w.action))
  expect(wi?.ownerId === rachel.id, 'Rachel has the work item "Review the death certificate"')
  const row = (await rows()).find((r) => r.kind === 'document_review_by')
  expect(row?.state === 'open' && !!row.documentId && row.sla === 'docReview', 'a document_review_by row waits for her review (1 business day)')
  const d = (await docs()).find((x) => x.status === 'under_review')
  const run = (await runs()).find((r) => r.workflowId === d.workflowId)
  expect(run.status === 'completed' && run.steps.some((s) => /Ask the examiner/.test(s.label)), 'the document workflow handed it to the examiner and ended')
}
await goto(`/claims/${claimNo}/documents`, 1500)
{
  expect(await p.$('[data-review-panel]') !== null, 'Documents shows the examiner’s review panel for the document under review')
  const en = await p.evaluate(() => ({ accept: !document.querySelector('[data-review-accept]').disabled, reject: !document.querySelector('[data-review-reject]').disabled }))
  expect(en.accept && !en.reject, 'as Rachel Accept is enabled and Reject waits for a reason')
  const t = await text('[data-review-panel]')
  expect(/Photocopy|photocopy/.test(t) && /review by/i.test(t) && /Review the death certificate/.test(t), 'the panel says why the rules could not accept it, the review deadline and the work item')
  await shot('c5-documents-review-panel')
  await goto(`/claims/${claimNo}/requirements`, 1200)
  const t2 = await bodyText()
  expect(/Under review · examiner/.test(t2), 'Requirements shows the certificate as Under review')
  const cert = (await reqs()).find((r) => r.key === 'certificate')
  await goto(`/claims/${claimNo}/requirements/${cert.id}`, 1200)
  expect(await p.$('[data-review-link]') !== null, 'and its detail has a link to review it')
  await shot('c5-requirements-under-review')
}
// Only the examiner can review: as the team lead the buttons are off, with the reason.
await clickText('.gbar-account', 'Rachel')
await clickText('.menu-item', 'Monica Reyes')
await wait(900)
await goto(`/claims/${claimNo}/documents`, 1200)
{
  const state = await p.evaluate(() => ({ accept: document.querySelector('[data-review-accept]').disabled, reject: document.querySelector('[data-review-reject]').disabled, why: document.querySelector('[data-cannot-review]')?.textContent ?? '' }))
  expect(state.accept && state.reject && /Only the examiner/.test(state.why), `as Monica (team lead) both buttons are disabled and the screen says why ("${state.why.slice(0, 70)}…")`)
  await shot('c5-documents-review-monica')
}
await clickText('.gbar-account', 'Monica')
await clickText('.menu-item', 'Rachel Kim')
await wait(900)
await goto(`/claims/${claimNo}/documents`, 1200)

// ---- Rachel rejects it while the letters service is down
log('6. Rachel rejects it with the letters service down')
await openPanel()
expect(await guideClick('Letters service down'), 'clicked: Letters service down')
await wait(1500)
{
  expect((await json('/dev/faults')).active.some((x) => x.name === 'letters.down'), 'letters.down is on at the backend')
  expect((await text('[data-faults]')).includes('Letters service DOWN'), 'the panel shows “Letters service DOWN” while it is on')
  await shot('c6-panel-letters-down')
}
await closePanel()
await p.type('[data-review-reason]', 'A photocopy is not enough: we need a certified copy with a raised seal')
await wait(300)
expect(await p.$eval('[data-review-reject]', (e) => !e.disabled), 'with a reason typed, Reject is enabled')
posts.length = 0
await clickText('[data-review-reject]', 'Reject document', 500)
expect(await until(async () => (await docs()).some((d) => d.status === 'rejected'), 15000), 'the document is rejected')
{
  const post = posts.find((x) => /:review$/.test(x.url))
  const body = JSON.parse(post?.body ?? '{}')
  expect(post?.actor === 'rachel' && /^"\d+"$/.test(post?.ifMatch ?? '') && body.decision === 'reject' && /certified copy/.test(body.reason ?? ''), `POST :review carried X-Actor rachel, If-Match ${post?.ifMatch} and the reason`)
  const d = (await docs()).find((x) => x.status === 'rejected')
  expect(d.reviewedBy === 'rachel' || d.reviewedBy === 'Rachel Kim', `the document records who reviewed it (${d.reviewedBy})`)
  const cert = (await reqs()).find((r) => r.key === 'certificate')
  expect(cert.state === 'requested' && /Rejected/.test(cert.stateNote ?? ''), `the requirement is requested again ("${cert.stateNote}")`)
  const rs = await rows()
  expect(rs.find((r) => r.kind === 'document_review_by')?.state === 'done', 'the review row is closed')
  expect(rs.some((r) => r.kind === 'requirement_follow_up' && /certified copy/i.test(r.what) && r.state === 'open'), 'a new follow-up row is open for the certified copy')
  expect(!(await json('/work-items?status=open&limit=200')).items.some((w) => w.claimId === claimId && /Review the death certificate/.test(w.action)), 'Rachel’s review work item is done')
}
await wait(1500)
{
  const t = await text('[data-doc-after]')
  expect(/rejected it/.test(t) && /requested again/.test(t) && /letter workflow/i.test(t), `Documents says what the rejection set in motion ("${t.slice(0, 120)}…")`)
  expect(await until(async () => (await p.$('[data-rejection-run]')) !== null, 12000), 'and links to the letter workflow’s run')
}
log('   waiting for the letter workflow to fail (5 attempts, about 30 s)')
const failed = await until(async () => (await runs()).find((r) => r.status === 'failed'), 120000, 1500)
expect(!!failed, 'the letter workflow FAILED after its retries')
log('   the run failed')
{
  const step = failed.steps.find((s) => s.state === 'failed')
  expect(step?.attempts === 5 && /Send it/.test(step.label), `the "${step?.label}" step gave up after ${step?.attempts} attempts`)
  expect(failed.elapsedMs >= 29000 && failed.elapsedMs < 60000, `the run took ${(failed.elapsedMs / 1000).toFixed(1)} s (2 + 4 + 8 + 16 s of waiting)`)
  expect(/503/.test(failed.error ?? '') && /5 times/.test(failed.note ?? ''), 'the run carries the error and the note (Temporal ran the step 5 times)')
  expect(failed.canRerun === true && failed.workflowId.startsWith('event-'), `it can be re-run (${failed.workflowId.slice(0, 26)}…)`)
  const task = (await json('/work-items?status=open&limit=200')).items.find((w) => w.claimId === claimId && w.action.includes(failed.workflowId))
  expect(!!task, `an ops task is open: "${task?.action.slice(0, 70)}"`)
  expect((await getClaim()).status === 'gathering_evidence', 'nothing was lost: the claim is as the rejection saved it')
}
// The failed run on Workflow & SLA: red, with its ops task and the Re-run button; and from Documents by link.
await goto(`/claims/${claimNo}/documents`, 1500)
expect(await until(async () => (await text('[data-doc-after]')).includes('Failed after retries'), 15000), 'Documents shows the letter run as Failed after retries (red) with the reason')
expect(await p.$('[data-doc-after] [data-rerun]') !== null, 'and a Re-run button')
await clickText('[data-rejection-run]', 'event-', 1500)
expect(p.url().includes('/workflow/run:') && (await p.$('details.wf-run--failed[open]')) !== null, 'the run link opens the failed run on Workflow & SLA')
{
  expect(await p.$('.wf-run--failed [data-ops-task]') !== null && /Re-run event-/.test(await text('.wf-run--failed [data-ops-task]')), 'the failed run shows its ops task')
  expect(await p.$(`.wf-run--failed [data-rerun="${failed.id}"]`) !== null, 'and the Re-run button')
  const t = await text('.wf-run--failed')
  expect(/5 attempts/.test(t) && /gave up/.test(t) && /What Temporal did/.test(t) && /Failed after retries/.test(t), 'with 5 attempts on the step, “gave up”, the run tagged Failed, and “What Temporal did”')
  const red = await p.$eval('.wf-run--failed', (e) => getComputedStyle(e).borderTopColor)
  expect(red !== '' && await p.evaluate(() => document.body.innerText.includes('Workflow failed')), 'the failed run is in red and the exception strip says Workflow failed')
  await scrollMain('.wf-run--failed')
  await shot('c6-failed-run')
}

// ---- 3c. ops re-runs it
log('7. Letters back, ops re-runs the failed run')
await openPanel()
expect(await guideClick('Letters service back'), 'clicked: Letters service back')
await wait(800)
expect(!(await json('/dev/faults')).active.some((x) => x.name === 'letters.down'), 'letters.down is off')
await closePanel()
expect(await clickText(`[data-rerun="${failed.id}"]`, 'Re-run this workflow', 500), 'clicked: Re-run this workflow (on the failed run)')
expect(await until(async () => (await runs()).some((r) => r.workflowId === failed.workflowId && r.runNo === 2 && r.status === 'completed'), 60000, 1000), 'run 2 completed under the same workflow id')
{
  const all = await runs()
  const r2 = all.find((r) => r.workflowId === failed.workflowId && r.runNo === 2)
  expect(r2.rerunOfId === failed.id, 'run 2 is linked to run 1 (rerunOfId)')
  expect(all.filter((r) => r.workflowId === failed.workflowId).length === 2, 'still one workflow id for the event')
  const req3 = (await list('letters')).filter((l) => l.templateCode === 'REQ-LIFE-03')
  expect(req3.length === 1 && req3[0].status === 'sent', `ONE certified-copy letter (REQ-LIFE-03), sent (${req3.length})`)
  expect(!(await json('/work-items?status=open&limit=200')).items.some((w) => w.claimId === claimId && w.action.includes(failed.workflowId)), 'the ops task closed')
  const hist = (await list('history')).find((h) => /Ops re-run requested/.test(h.title))
  expect(!!hist, `the history records who re-ran it (${hist?.actor})`)
}
await wait(2500)
{
  expect(await p.$('[data-rerun-of]') !== null && /run 1/.test(await text('[data-rerun-of]')), 'run 2 has a link back to run 1')
  expect(await p.$('[data-rerun-next]') !== null, 'run 1 links forward to run 2')
  expect(await p.$('[data-run-no]') !== null && (await text('[data-run-no]')) === 'run 2', 'run 2 carries the “run 2” chip')
  expect(await p.$('.wf-run--failed') !== null, 'run 1 is still shown red: the failure is part of the record')
  expect(!(await bodyText()).includes('Workflow failed'), 'the exception strip is gone: only the latest run of an id is a problem')
  await scrollMain(`[data-run="${failed.workflowId}#2"]`)
  await wait(300)
  const t = await text(`[data-run="${failed.workflowId}#2"]`)
  expect(/What Temporal did/.test(t) && /run 2 of|ALLOW_DUPLICATE_FAILED_ONLY|same idempotency key/.test(t) && /took \d+ ms/.test(t), `run 2 shows “What Temporal did” and its elapsed time (${(t.match(/took [^ ]+ [^ ]+/) ?? [''])[0]})`)
  await shot('c7-run-2')
}
await goto(`/claims/${claimNo}/documents`, 1500)
expect(/Completed/.test(await text('[data-doc-after]')) && /ops re-ran it/.test(await text('[data-doc-after]')), 'Documents now shows the letter run completed (run 2)')

// ---- the certified copy
log('8. The certified copy')
await openPanel()
expect(await guideClick('Certified copy arrives'), 'clicked: Certified copy arrives')
expect(await until(async () => (await reqs()).find((r) => r.key === 'certificate')?.state === 'accepted', 40000), 'the certified copy was accepted')
await closePanel()
{
  const cert = (await docs()).filter((d) => d.kind === 'death_certificate')
  expect(cert.length === 2 && cert[0].status === 'rejected' && cert[1].status === 'accepted', 'two certificates on file: the photocopy rejected, the certified original accepted')
  expect((await getClaim()).status === 'gathering_evidence', 'Mark’s statement is still outstanding: the claim is not in review yet')
  expect((await rows()).filter((r) => r.kind === 'requirement_follow_up' && /certified copy/i.test(r.what))[0]?.state === 'done', 'the certified-copy follow-up closed early')
}

// ---- bounce 4: Mark is late
log('9. Bounce 4: Mark is late, his follow-up fires')
await goto(`/claims/${claimNo}/workflow`, 1200)
await openPanel()
expect(await guideClick('Advance to next deadline'), 'clicked: Advance to next deadline (checklist)')
const markRow = () => rows().then((r) => r.filter((d) => d.kind === 'requirement_follow_up' && d.what.includes('Mark')))
expect(await until(async () => (await markRow()).some((d) => d.fired && d.state === 'done'), 60000, 800), 'the dispatcher fired Mark’s follow-up (a reminder went out)')
expect(await until(async () => (await markRow()).some((d) => d.state === 'open' && d.what.startsWith('Follow up again')), 10000), 'it wrote a “Follow up again” row')
await closePanel()
{
  const fired = (await rows()).filter((d) => d.fired)
  expect(fired.length === 1, `it is the only row that fired (${fired.length})`)
  const run = (await runs()).find((r) => r.type === 'deadline')
  expect(run?.workflowId.startsWith('deadline-') && run.status === 'completed', `the run is ${run?.workflowId.slice(0, 24)}… (deadline-<row id>), completed`)
}

// ---- Mark's statement: the last requirement
log('10. Mark’s statement: proof of loss complete')
await openPanel()
expect(await guideClick('Mark’s statement + W-9 arrives'), 'clicked: Mark’s statement + W-9 arrives')
expect(await until(async () => (await getClaim()).status === 'in_review', 40000), 'the last requirement was accepted: the claim is in review (proof of loss complete)')
await closePanel()
{
  const rs = await rows()
  expect(rs.some((d) => d.kind === 'decision_due' && d.state === 'open') && rs.some((d) => d.kind === 'review_target' && d.state === 'open'), 'decision_due and review_target rows were written')
  await goto(`/claims/${claimNo}/documents`, 1500)
  const t = await text('[data-docs]')
  expect(((await docs()).length === 5), `Documents lists all 5 documents (${(await docs()).map((d) => `${d.kind.split('_')[0]}:${d.status}`).join(', ')})`)
  expect(/Rejected/.test(t) && /Accepted/.test(t) && /Not enough/.test(t), 'with rejected, accepted and not-enough statuses')
  await shot('c10-documents-all')
}

// ---- decision day: 12 Oct
log('11. The decision, as Rachel, on Mon 12 Oct')
await goto(`/claims/${claimNo}/decision`, 1200)
await openPanel()
expect((await guideNext()).includes('Move the clock to Mon 12 Oct'), `the hint says to move the clock to Mon 12 Oct ("${(await guideNext()).slice(0, 80)}…")`)
expect(await guideClick('Move the clock to Mon 12 Oct'), 'clicked: Move the clock to Mon 12 Oct')
await wait(800)
expect((await clock()).businessDate === '2026-10-12', `the clock is on Mon 12 Oct (${(await clock()).businessDate})`)
await closePanel()
await goto(`/claims/${claimNo}/decision`, 1500)
await clickText('.wb-form-foot button', 'Record decision & clear payment')
await wait(300)
await clickText('.wb-confirm button', 'Confirm')
const decisions = async () => (await json(`/claims/${claimId}/decisions`)).items
expect(await until(async () => (await decisions()).length >= 2, 15000), 'the backend holds the base decision and the rider decision')
await wait(1500)
{
  const post = posts.filter((x) => x.url.endsWith('/decisions')).at(-1)
  expect(post?.actor === 'rachel' && !!post?.key, 'the decision POST carried X-Actor rachel and an Idempotency-Key')
  const its = await items()
  const dod = (await getClaim()).details.dateOfDeath
  const days = Math.round((Date.parse(its[0].payOn) - Date.parse(dod)) / 86_400_000)
  expect(its[0].payOn === '2026-10-13' && days === 24, `the pay date is Tue 13 Oct, ${days} days after the date of death`)
  const amounts = its.map((i) => money(i.amount)).sort()
  expect(its.length === 2 && its.every((i) => i.status === 'cleared') && amounts[0] === 100230.13 && amounts[1] === 100230.14, `two items cleared: ${amounts.map(usd).join(' + ')} (the mock’s figures)`)
  expect(Math.round(its.reduce((a, i) => a + money(i.interest), 0) * 100) / 100 === 460.27, 'interest $460.27 for 24 days')
  const t = await text('[data-total-line]')
  expect(/\$200,460\.27/.test(t), `the Decision header shows the claim total as one sum ("${t}")`)
  await shot('c11-decision-recorded')
}

// ---- pay
log('12. Pay day')
await openPanel()
expect((await guideNext()).includes('pay day'), `the hint says to move the clock to the pay day ("${(await guideNext()).slice(0, 70)}…")`)
expect(await guideClick('Move the clock to the pay day'), 'clicked: Move the clock to the pay day')
// With the backend's own daily trigger on it pays within seconds; with it off the button is what pays.
if (!(await until(async () => (await items()).every((i) => i.status === 'paid'), 10000, 500))) {
  await goto(`/claims/${claimNo}/payments`, 1200)
  await clickText('[data-run-now]', 'Run payment run now', 500)
  log('   (the daily trigger is off: paid with the Run payment run now button)')
}
expect(await until(async () => (await items()).every((i) => i.status === 'paid'), 20000, 500), 'the payment run paid both payees')
expect(await until(async () => (await getClaim()).status === 'closed', 20000, 500), 'the claim is closed (first time)')
await closePanel()
const paid1 = await items()
expect(Math.round(paid1.reduce((a, i) => a + money(i.amount), 0) * 100) / 100 === 200460.27, `paid ${usd(paid1.reduce((a, i) => a + money(i.amount), 0))} in all`)
await goto(`/claims/${claimNo}/payments`, 1500)
await shot('c12-payments-paid')

// ---- bounce 5: the bank returns Mark's payment
log('13. Bounce 5: the bank returns Mark’s payment')
await openPanel()
expect((await guideNext()).includes('returns file'), `the hint: ${(await guideNext()).slice(0, 80)}…`)
expect(await guideClick('Bank returns Mark’s payment'), 'clicked: Bank returns Mark’s payment (its returns file)')
await wait(1500)
{
  expect((await json('/dev/bank/returns')).items.length === 1, 'the stub bank’s returns file lists it')
  expect((await items()).every((i) => i.status === 'paid') && (await getClaim()).status === 'closed', 'nothing has changed yet: the claim is closed and the item is paid until the returns batch reads the file')
}
expect(await guideClick('Process the bank returns'), 'clicked: Process the bank returns (the returns batch)')
expect(await until(async () => (await items()).some((i) => i.status === 'returned'), 15000), 'Mark’s item is returned (R02)')
expect(await until(async () => (await getClaim()).status === 'reopened', 40000, 800), 'the claim reopened (status reopened): the returned-payment workflow did the claim side')
await closePanel()
{
  const its = await items()
  const returned = its.find((i) => i.status === 'returned')
  expect(returned.payeeName.startsWith('Mark') && returned.returnCode === 'R02' && money(returned.amount) === 100230.14, `${returned.payeeName}’s ${usd(money(returned.amount))} came back, ${returned.returnCode} ${returned.returnReason}`)
  expect(its.find((i) => i.payeeName.startsWith('Diane')).status === 'paid', 'Diane’s payment is untouched')
  const row = (await rows()).find((r) => r.kind === 'bank_details_by')
  expect(row?.state === 'open' && !!row.partyId, 'a bank_details_by row waits for Mark’s new account')
  const run = (await runs()).filter((r) => r.type === 'event').find((r) => /returned/i.test(r.name))
  expect(!!run && run.status === 'completed', `a workflow ran (${run?.name})`)
}
await goto(`/claims/${claimNo}/overview`, 1500)
{
  expect(/Reopened · payment returned/.test(await text('.ch')), 'the claim header shows the tag Reopened · payment returned')
  expect(/Payment returned by the bank/.test(await bodyText()), 'and the exception strip says the bank returned a payment')
  await shot('c13-reopened-overview')
  await goto(`/claims/${claimNo}/payments`, 1500)
  const t = await bodyText()
  expect(t.includes('Returned by the bank') && t.includes('R02') && t.includes('No replacement yet'), 'Payments shows the returned item with the bank’s code and “No replacement yet”')
  await shot('c13-payments-returned')
}

// ---- new account
log('14. Mark gives a new bank account')
await openPanel()
expect(await guideClick('Mark gives a new account'), 'clicked: Mark gives a new account')
expect(await until(async () => (await items()).some((i) => i.replacementOfId), 20000), 'a replacement item exists')
await closePanel()
await wait(3000)
{
  const its = await items()
  const returned = its.find((i) => i.status === 'returned')
  const repl = its.find((i) => i.replacementOfId === returned.id)
  expect(money(repl.amount) === 100230.14 && money(repl.principal) === 100000 && money(repl.interest) === 230.14 && repl.status === 'cleared', `the replacement is ${usd(money(repl.amount))} (${usd(money(repl.principal))} + ${usd(money(repl.interest))}), cleared`)
  expect(returned.status === 'returned' && money(returned.amount) === 100230.14, 'the returned item is untouched (paid items are never edited)')
  const rs = await rows()
  expect(rs.find((r) => r.kind === 'bank_details_by')?.state === 'done' && rs.some((r) => r.sla === 'reissue' && r.state === 'open'), 'the bank-details row closed and the 2-business-day reissue row is open')
}
await goto(`/claims/${claimNo}/payments`, 1500)
{
  const t = await bodyText()
  expect(t.includes('Replaced by a new item') && t.includes('Replaces the returned payment'), 'Payments links the returned item and its replacement')
  await shot('c14-payments-replacement')
}

// ---- the next run
log('15. The next payment run pays the replacement')
await openPanel()
expect(await guideClick('Move the clock to the pay day'), 'clicked: Move the clock to the pay day (for the replacement)')
if (!(await until(async () => (await items()).find((i) => i.replacementOfId)?.status === 'paid', 10000, 500))) {
  await goto(`/claims/${claimNo}/payments`, 1200)
  await clickText('[data-run-now]', 'Run payment run now', 500)
}
expect(await until(async () => (await items()).find((i) => i.replacementOfId)?.status === 'paid', 20000, 500), 'the run paid the replacement')
expect(await until(async () => { const c = await getClaim(); return c.status === 'closed' && !!c.closedAt }, 20000, 500), 'the claim closed a second time')
await closePanel()
await wait(4000)
{
  const its = await items()
  const paid = its.filter((i) => i.status === 'paid')
  const total = Math.round(paid.reduce((a, i) => a + money(i.amount), 0) * 100) / 100
  expect(total === 200460.27 && paid.length === 2, `paid in the end: ${paid.map((i) => usd(money(i.amount))).join(' + ')} = ${usd(total)} (the mock's $200,460.27)`)
  const hist = await list('history')
  expect(hist.filter((h) => /^Claim closed/.test(h.title)).length === 2 && hist.filter((h) => /Claim reopened/.test(h.title)).length === 1, 'the history has two “Claim closed” lines and one “Claim reopened”')
  expect(await until(async () => (await json('/work-items?status=open&limit=200')).items.filter((w) => w.claimId === claimId).length === 0, 8000), 'no open work item is left')
}
await goto(`/claims/${claimNo}/payments`, 1500)
await shot('c15-payments-final')
await goto(`/claims/${claimNo}/overview`, 1500)
{
  expect(/\$200,460\.27/.test(await text('[data-total-line]')), `the Overview header shows the claim total ("${await text('[data-total-line]')}")`)
  await shot('c15-overview-closed-again')
}

// ---- the checklist is done, from data alone
log('16. The final counts')
await openPanel()
{
  const s = await guideSteps()
  expect(Object.values(s).every((v) => v === 'done'), `every step of the Complex checklist is ticked from the data (${Object.entries(s).filter(([, v]) => v !== 'done').map(([k]) => k).join(', ') || 'all'})`)
  expect(/Done/.test(await guideNext()), `and it says so ("${(await guideNext()).slice(0, 80)}…")`)
  await shot('c16-panel-done')
}
await closePanel()

// ---- counts
{
  const all = await runs()
  const failedRuns = all.filter((r) => r.status === 'failed')
  expect(all.length === 14, `14 workflow runs (${all.length}: ${all.filter((r) => r.type === 'orchestration').length} intake, ${all.filter((r) => r.type === 'deadline').length} deadline, ${all.filter((r) => r.type === 'event').length} event)`)
  expect(failedRuns.length === 1 && all.filter((r) => r.status === 'completed').length === 13, `1 failed and 13 completed (${failedRuns.length} failed)`)
  expect(all.filter((r) => r.runNo === 2).length === 1 && all.find((r) => r.runNo === 2).workflowId === failedRuns[0].workflowId, 'the failed run was followed by run 2 under the same id')
  const rs = await rows()
  const fired = rs.filter((r) => r.fired)
  const skipped = rs.filter((r) => r.state === 'skipped')
  const early = rs.filter((r) => r.state === 'done' && !r.fired)
  const open = rs.filter((r) => r.state === 'open' || r.state === 'dispatched')
  expect(rs.length === 16, `16 deadline rows (${rs.length})`)
  expect(fired.length === 1 && skipped.length === 1 && early.length === 14 && open.length === 0, `1 fired, 1 skipped, 14 closed early, none open (${fired.length} / ${skipped.length} / ${early.length} / ${open.length})`)
  expect(skipped[0]?.kind === 'status_letter' && fired[0]?.what.includes('Mark'), 'the skipped row is the status letter; the fired one is Mark’s follow-up')
  const ls = await list('letters')
  const dupKeys = Object.entries(ls.reduce((m, l) => { const k = `${l.templateCode}|${l.recipientLabel}|${l.workflowId ?? ''}`; m[k] = (m[k] ?? 0) + 1; return m }, {})).filter(([, n]) => n > 1)
  expect(ls.length === 19, `19 letters (${ls.length})`)
  expect(dupKeys.length === 0 && ls.every((l) => l.status === 'sent'), `no duplicates (the same template to the same person from the same workflow), and every letter sent${dupKeys.length ? `: ${dupKeys.map(([k]) => k).join('; ')}` : ''}`)
  console.log(`   letters: ${Object.entries(ls.reduce((m, l) => { m[l.templateCode] = (m[l.templateCode] ?? 0) + 1; return m }, {})).map(([k, n]) => `${k}×${n}`).join(' ')}`)
}
await goto(`/claims/${claimNo}/workflow`, 1500)
{
  const tabs = await p.$$eval('.wf-tab', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))
  expect(tabs.some((t) => /Deadline rows 16/.test(t)) && tabs.some((t) => /Workflow runs 14/.test(t)), `Workflow & SLA shows the counts (${tabs.join(' | ')})`)
  await clickText('.wf-tab', 'Deadline rows', 500)
  const counts = await text('[data-row-counts]')
  expect(/0 open · 1 fired · 1 skipped · 14 closed early/.test(counts), `the Deadline rows tab says: ${counts}`)
  const kinds = await text('.wf-rows')
  expect(/document_review_by/.test(kinds) && /bank_details_by/.test(kinds) && /Payee gives new bank details/.test(kinds) && /Examiner reviews a document/.test(kinds), 'the new row kinds (document_review_by, bank_details_by) are labelled')
  await scrollMain('.wf-tabs')
  await shot('c16-deadline-rows')
  await clickText('.wf-tab', 'Swimlane', 500)
  const lane = await text('.wf-lanes')
  expect(/Payment run/.test(lane) && /Returns job/.test(lane) && /Bank \(returns file\)/.test(lane) && /Nightly overdue check|Payment run closes the claim/.test(lane), 'the swimlane has Batch lane rows: the payment runs, the returns job, the bank')
  expect(/attempts, failed/.test(lane) && /2 attempts, then done/.test(lane), 'and shows the retried step and the failed one on the Temporal lane')
  await scrollMain('.wf-tabs')
  await shot('c16-swimlane')
  const sla = await p.$$eval('.wf-sla tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')))
  expect(sla.some((s) => /Review a document the rules can/.test(s) && /Met/.test(s)) && sla.some((s) => /Reissue a returned payment/.test(s) && /Met/.test(s)), 'the two service levels that exist only on this path (document review, reissue) are shown, met')
  await p.evaluate(() => document.querySelector('.cw-main')?.scrollTo(0, 0))
  await shot('c16-workflow-top')
}
await goto(`/claims/${claimNo}/history`, 1500)
{
  const hist = await text('.hi-list')
  expect(/Ops re-run requested/.test(hist) && /Claims operations|ops/.test(hist), 'History shows the ops re-run')
  expect(/Rachel Kim/.test(hist), 'History shows Rachel by name')
  await shot('c16-history')
}

// ---- the panel at two viewport sizes: collapsed, expanded at the bottom, expanded on the side; nothing covers the claim
log('17. The panel at 1440x900 and 1280x800')
await goto(`/claims/${claimNo}/requirements`, 1200)
for (const [w, h] of [[1440, 900], [1280, 800]]) {
  await p.setViewport({ width: w, height: h })
  await wait(400)
  await closePanel()
  await wait(300)
  {
    const g = await p.evaluate(() => {
      const a = document.querySelector('[data-demo-controls]').getBoundingClientRect()
      const body = document.querySelector('.app-body').getBoundingClientRect()
      return { aTop: a.top, bodyBottom: body.bottom }
    })
    expect(g.aTop >= g.bodyBottom - 1, `${w}x${h}: collapsed, the bar sits under the page (no overlap)`)
    await overflowAt(`${w}x${h} collapsed`)
    await shot(`c17-${w}-collapsed`)
  }
  await openPanel()
  {
    const g = await p.evaluate(() => {
      const a = document.querySelector('[data-demo-controls]').getBoundingClientRect()
      const body = document.querySelector('.app-body').getBoundingClientRect()
      const panel = document.querySelector('.cp')?.getBoundingClientRect()
      return { aTop: a.top, aH: a.height, bodyBottom: body.bottom, panelBottom: panel?.bottom, vh: innerHeight }
    })
    expect(g.aTop >= g.bodyBottom - 1 && (g.panelBottom ?? 0) <= g.aTop + 1, `${w}x${h}: expanded at the bottom, the claim’s right-hand panel ends above it (${Math.round(g.panelBottom ?? 0)} <= ${Math.round(g.aTop)})`)
    expect(g.aH <= g.vh * 0.4, `${w}x${h}: the strip is ${Math.round(g.aH)} px of ${g.vh}`)
    await overflowAt(`${w}x${h} expanded at the bottom`)
    await shot(`c17-${w}-expanded-bottom`)
  }
  await clickText('[data-demo-controls] .dmc-dock button', 'Side', 600)
  {
    const g = await p.evaluate(() => {
      const a = document.querySelector('[data-demo-controls]').getBoundingClientRect()
      const panel = document.querySelector('.cp')?.getBoundingClientRect()
      return { aLeft: a.left, aTop: a.top, panelRight: panel?.right, panelLeft: panel?.left, dock: document.querySelector('[data-demo-controls]').getAttribute('data-dock') }
    })
    expect(g.dock === 'right' && (g.panelRight ?? 0) <= g.aLeft + 1, `${w}x${h}: docked on the side, the page narrows: the claim’s right-hand panel ends at ${Math.round(g.panelRight ?? 0)}, the panel starts at ${Math.round(g.aLeft)}`)
    await overflowAt(`${w}x${h} docked on the side`)
    await shot(`c17-${w}-expanded-side`)
  }
  await clickText('[data-demo-controls] .dmc-dock button', 'Bottom', 400)
}
await p.setViewport({ width: 1440, height: 900 })
await closePanel()

expect(errs.length === 0, `no console or page errors (${errs.slice(0, 4).join(' | ')})`)
await b.close()
log('done')
console.log(`\n${passed} checks passed, ${fails.length} failed`)
if (errs.length) console.error(errs.join('\n'))
if (fails.length) console.error(`FAILED:\n - ${fails.join('\n - ')}`)
process.exit(fails.length ? 1 : 0)
