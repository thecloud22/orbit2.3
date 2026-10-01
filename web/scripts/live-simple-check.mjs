// Drives the SIMPLE life-claim scenario in the browser against the real backend, end to end, and ASSERTS on it (non-zero exit on failure):
// intake -> welcome call (first contact met) -> accept requirements (one is late: the clock makes its follow-up fire) -> proof of loss ->
// Decision as Rachel -> Payments (items, hold/release with ETags) -> Run payment run now -> claim closed -> letters, Workflow & SLA, History.
// The accident variant records a decision above Rachel's authority: 202, Rachel cannot approve, switch to Monica, approve, then pay and close.
//
// Start first (web/README.md, "Live mode"): Postgres, the .NET API with Claims:Dev:Controls=true and Claims:Temporal:DevServer=true, and the web app
//   VITE_API_BASE=/api DEMO_API_TARGET=http://127.0.0.1:8080 npm run dev -- --port 5174
// The backend must be FRESH (no claims): the intake is the Castellano story and a second claim for the same death is held as a duplicate.
// The daily payment run's own trigger should be off (Claims:PaymentRun:ScheduleEnabled=false) so that the button is what pays; with it on the
// script still passes (it accepts that the daily run got there first; DAILY_RUN_WAIT_MS=8000 makes that the case) but then does not exercise the button.
//
// Usage: node scripts/live-simple-check.mjs <out-dir> [natural|accident]
//   BASE_URL   the web app (default http://localhost:5174/)
import puppeteer from 'puppeteer-core'

const [dir = '.', variant = 'natural'] = process.argv.slice(2)
if (!['natural', 'accident'].includes(variant)) { console.error(`unknown variant "${variant}"; use natural or accident`); process.exit(2) }
const accident = variant === 'accident'
const base = process.env.BASE_URL ?? 'http://localhost:5174/'
const api = (path, init) => fetch(`${base}api${path}`, init)
const json = (path, init) => api(path, init).then((r) => r.json())
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
let passed = 0
const expect = (ok, msg) => { if (ok) { passed++; console.log(`  ok   ${msg}`) } else { fails.push(msg); console.error(`  FAIL ${msg}`) } }
const money = (m) => Number.parseFloat(m.amount)
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)

// ---- preflight
const existing = await json('/claims').catch(() => null)
if (!existing) { console.error(`cannot reach the API through ${base}api. Is the backend up and the web app started with VITE_API_BASE=/api?`); process.exit(2) }
if (existing.items.length > 0 && !process.env.LIVE_ALLOW_EXISTING) { console.error('the backend already has claims; start from a fresh database (or set LIVE_ALLOW_EXISTING=1)'); process.exit(2) }
const clock0 = await api('/dev/clock')
if (clock0.status !== 200) { console.error('the backend has no /dev/clock (start it with Claims:Dev:Controls=true)'); process.exit(2) }
const staff = (await json('/staff')).items
const rachel = staff.find((s) => s.handle === 'rachel')
const monica = staff.find((s) => s.handle === 'monica')
if (!rachel || !monica) { console.error('GET /staff has no rachel and monica'); process.exit(2) }

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 960 })
const errs = []
const posts = []
p.on('pageerror', (e) => errs.push(e.message))
// The browser logs every 4xx answer as a console error; the 412 of the stale-ETag check is expected and asserted below.
p.on('console', (m) => m.type() === 'error' && !/status of 412/.test(m.text()) && errs.push(m.text()))
p.on('request', (r) => { if (r.method() === 'POST') posts.push({ url: r.url().replace(/^.*\/api/, ''), actor: r.headers()['x-actor'], ifMatch: r.headers()['if-match'], key: r.headers()['idempotency-key'] }) })
process.on('exit', (code) => { if (code && errs.length) console.error(`browser errors so far:\n${errs.join('\n')}`) })
const shot = (name) => p.screenshot({ path: `${dir}/${name}.png` })
const text = (sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '')
const bodyText = () => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
const toastText = () => p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '))
const clickText = async (sel, t) => {
  const ok = await p.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t) && !e.disabled)
    if (!el) return false
    el.click()
    return true
  }, sel, t)
  if (!ok) errs.push(`click: no enabled ${sel} with "${t}"`)
  await wait(250)
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
const overflowAt = (label) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth).then((o) => expect(!o, `${label}: no horizontal page scroll`))
const goto = async (path, ms = 1200) => { await p.goto(`${base}#${path}`); await wait(ms) }
const clock = () => json('/dev/clock')
const scrollTo = (sel) => p.evaluate((sel) => {
  const el = document.querySelector(sel)
  const main = el?.closest('.cw-main')
  if (el && main) main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 8
}, sel)
const dcButton = (label) => clickText('[data-demo-controls] .dc-buttons button', label)

// ---- 0. Demo controls: +1 day, +7 days and Reset move the backend's clock
console.log('0. Demo controls')
await goto('/work', 1500)
if (!(await text('[data-demo-controls]')).includes('Advance to next deadline')) await clickText('.dc-toggle', 'Demo controls')
let c0 = await clock()
await dcButton('+1 day')
await wait(700)
let c1 = await clock()
expect(Math.abs((Date.parse(c1.now) - Date.parse(c0.now)) - 86_400_000) < 5000, `+1 day moved the backend clock by one day (${c0.businessDate} -> ${c1.businessDate})`)
expect(c1.virtual === true && c1.offsetSeconds >= 86_399, 'the clock is virtual after +1 day')
await dcButton('+7 days')
await wait(700)
let c2 = await clock()
expect(Math.abs((Date.parse(c2.now) - Date.parse(c1.now)) - 7 * 86_400_000) < 5000, `+7 days moved the clock by seven days (-> ${c2.businessDate})`)
expect((await text('[data-clock]')).length > 0, 'the panel shows the clock')
await shot('s0-demo-controls-moved')
await dcButton('Reset clock')
await wait(700)
let c3 = await clock()
expect(c3.offsetSeconds === 0 && c3.virtual === false, 'Reset clock puts the backend clock back to real time')

// ---- 1. the notice of death, in the browser
console.log('1. Intake')
await goto('/intake/life', 900)
await clickText('label.ik-check', 'date of birth')
await clickText('label.ik-check', 'policy number')
await clickText('label.radio-card', 'Yes')
await clickText('.ik-foot button', 'Continue')
if (accident) await clickText('label.radio-card', 'Accident')
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
const landed = await until(() => /#\/claims\/L-\d\d-\d{6}\/workflow/.test(p.url()), 10000)
expect(landed, 'submitting the notice lands on the claim (Workflow & SLA)')
const claimNo = p.url().match(/claims\/([^/]+)/)?.[1]
if (!claimNo) { await shot('s1-fail'); console.error(errs.join('\n')); process.exit(1) }
console.log('   claim', claimNo, accident ? '(accident)' : '(natural causes)')
const claimId = (await json(`/claims?claimNumber=${claimNo}`)).items[0]?.id
expect(!!claimId, 'the claim exists on the backend')
const getClaim = () => json(`/claims/${claimId}`)
const list = async (what) => (await json(`/claims/${claimId}/${what}${what === 'history' ? '?limit=200' : ''}`)).items
const deadlines = () => list('deadlines')
expect(await until(async () => (await getClaim()).status === 'gathering_evidence', 30000), 'the intake workflow ran: the claim is gathering evidence')
await until(async () => (await text('.wf-play-clock')).includes('Gathering evidence'), 15000)
await wait(500)

// ---- 2. the welcome call: first contact is met, not breached
console.log('2. Welcome call')
await shot('s2-workflow-before-call')
expect((await bodyText()).includes('Work on this claim') && (await bodyText()).includes('welcome call'), 'Workflow & SLA lists the welcome call work item')
expect((await deadlines()).find((d) => d.kind === 'first_contact_by')?.state === 'open', 'first_contact_by is open before the call')
if (accident) {
  // The accident variant logs the call from My work (the work item's own action) instead of from the claim.
  await goto('/work', 1500)
  expect((await bodyText()).includes('welcome call to'), 'My work lists the welcome-call item')
  await shot('s2-my-work-welcome-call')
  await clickText('[data-log-welcome-call]', 'Log the welcome call')
} else {
  await clickText('[data-log-welcome-call]', 'Log the welcome call')
}
expect(await until(async () => (await deadlines()).find((d) => d.kind === 'first_contact_by')?.state === 'done', 8000), 'logging the call closes first_contact_by on the backend')
if (accident) await goto(`/claims/${claimNo}/workflow`, 1500)
const fc = (await deadlines()).find((d) => d.kind === 'first_contact_by')
expect(fc.closedBy === 'user' && Date.parse(fc.closedAt) <= Date.parse(fc.dueAt), `first contact met on time (closed by ${fc.closedBy} at ${fc.closedAt}, due ${fc.dueAt})`)
expect((await toastText()).includes('Welcome call logged'), 'a toast confirms the call was logged')
await until(async () => !(await text('[data-claim-work]')).includes('Log the welcome call'), 8000)
expect(!(await text('[data-claim-work]')).includes('Log the welcome call'), 'the welcome call item is gone from the screen')
const slaRow = await p.evaluate(() => [...document.querySelectorAll('.wf-sla tbody tr')].find((r) => r.textContent.includes('First contact'))?.textContent.replace(/\s+/g, ' ') ?? '')
expect(/Met/.test(slaRow) && !/Breach/.test(slaRow), `the First contact service level reads Met, not Breached ("${slaRow.slice(0, 90)}")`)
expect(!(await bodyText()).includes('First contact overdue'), 'no first-contact-overdue exception')
await shot('s2-workflow-after-call')

// ---- 3. evidence: accept two requirements now, leave Mark's late; the clock makes his follow-up fire
console.log('3. Evidence')
/** Opens the requirement (by its route, as a link from a work item would) and accepts it from the screen. `who` matches its name or who it is from. */
async function acceptOne(who) {
  const reqs = (await list('requirements')).filter((r) => ['requested', 'received', 'not_enough'].includes(r.state))
  const r = reqs.find((x) => `${x.name} ${x.from.label}`.includes(who))
  if (!r) return false
  await goto(`/claims/${claimNo}/requirements/${r.id}`, 900)
  if (!(await until(() => p.evaluate(() => [...document.querySelectorAll('button')].some((x) => x.textContent.includes('Accept requirement'))), 5000, 200))) return false
  await clickText('button', 'Accept requirement…')
  await wait(200)
  await clickText('.rq-confirm button', 'Accept')
  return !!(await until(async () => (await list('requirements')).find((x) => x.id === r.id)?.state === 'accepted', 10000, 300))
}
const acceptedCount = () => p.$$eval('tr.rq-row', (rs) => rs.filter((r) => /Accepted|On file/.test(r.textContent)).length)
await goto(`/claims/${claimNo}/requirements`)
const rowsBefore = await p.$$eval('tr.rq-row', (rs) => rs.length)
expect(rowsBefore === (accident ? 5 : 4), `${accident ? 5 : 4} requirements on screen (got ${rowsBefore})`)
const before = await acceptedCount()
expect(await acceptOne('Certified death certificate'), 'accepted the death certificate from the screen (POST :accept with its ETag)')
expect(await until(async () => (await acceptedCount()) > before, 10000), 'the death certificate shows Accepted')
expect(await acceptOne('Diane Castellano'), 'accepted Diane’s statement')
expect(await until(async () => (await acceptedCount()) >= before + 2, 10000), 'Diane’s statement shows Accepted')
if (accident) expect(await acceptOne('Police or accident report'), 'accepted the accident report (an accidental death needs one)')
await shot('s3-requirements-two-accepted')
// Mark's statement is late: move the clock to the next deadline (his follow-up row) and let the real dispatcher fire it.
const lettersBeforeReminder = (await list('letters')).length
await goto(`/claims/${claimNo}/workflow`)
await dcButton('Advance to next deadline')
const markRow = () => deadlines().then((r) => r.filter((d) => d.kind === 'requirement_follow_up' && d.what.includes('Mark')))
expect(await until(async () => (await markRow()).some((d) => d.fired && d.state === 'done'), 40000, 800), 'the dispatcher fired Mark’s follow-up (a reminder went out)')
expect(await until(async () => (await markRow()).some((d) => d.state === 'open' && d.what.startsWith('Follow up again')), 10000), 'it wrote a "Follow up again" row')
expect((await list('letters')).length > lettersBeforeReminder, 'the reminder is a new letter')
await clickText('.wf-tab', 'Deadline rows')
expect(await until(async () => (await text('.wf-rows')).includes('Fired'), 15000), 'the Deadline rows tab shows the fired follow-up')
await shot('s3-follow-up-fired')

// Put the clock on Thursday 8 October so that the pay date is Friday 9 October (20 days of interest, the mock's figures), when it is still ahead.
const target = '2026-10-08T15:00:00Z'
const now1 = await clock()
if (Date.parse(now1.now) < Date.parse(target)) {
  const r = await api('/dev/clock:advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toIso: target }) })
  expect(r.status === 200, 'the clock is on Thu 8 Oct 10:00 (Chicago)')
}
const clockNow = await clock()
console.log('   business date', clockNow.businessDate)
await wait(1500)
expect(await acceptOne('Mark Castellano'), 'accepted Mark’s late statement')
expect(await until(async () => (await getClaim()).status === 'in_review', 15000), 'accepting the last requirement moves the claim to In review (proof of loss complete)')
await until(async () => (await text('.ch-bottom')).includes('Record decision') || (await bodyText()).includes('Record decision'), 8000)
await shot('s3-in-review')
expect((await deadlines()).some((d) => d.kind === 'decision_due' && d.state === 'open'), 'decision_due row written')
const guideSteps = async () => p.$$eval('[data-guide] [data-step]', (els) => Object.fromEntries(els.map((e) => [e.dataset.step, e.dataset.done])))
{
  const g = await guideSteps()
  expect(g.intake === 'true' && g.welcome === 'true' && g.followup === 'true' && g.evidence === 'true' && g.proof === 'true' && g.decision === 'false', `the Simple scenario checklist ticks from the data (${JSON.stringify(g)})`)
  expect((await text('[data-guide] [data-next]')).includes('Record the decision'), `the hint says Record the decision ("${await text('[data-guide] [data-next]')}")`)
}
await shot('s3-demo-controls-checklist')

// ---- 4. the decision, as Rachel
console.log('4. Decision')
await goto(`/claims/${claimNo}/decision`)
const decisionBefore = await bodyText()
expect(!decisionBefore.includes('not on the backend yet'), 'Decision is a live screen, not a "not on the backend yet" note')
expect(decisionBefore.includes('Readiness') && decisionBefore.includes('Proof of loss is complete'), 'the readiness list is derived from the claim record')
const principal = accident ? 400000 : 200000
const payeeRows = await p.$$eval('[data-payees] tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')))
expect(payeeRows.length === 2 && payeeRows.every((r) => r.includes('50%') && r.includes(usd(principal / 2))), `the payees are shown with their share of ${usd(principal)} (${payeeRows.join(' / ')})`)
expect(decisionBefore.includes(accident ? 'above your $250,000.00 authority' : 'Record decision & clear payment') || decisionBefore.includes('above your'), 'the screen tells Rachel whether it is within her authority')
await shot(accident ? 's4-decision-before-accident' : 's4-decision-before')
await clickText('.wb-form-foot button', accident ? 'Send for approval' : 'Record decision & clear payment')
await wait(300)
await shot('s4-decision-confirm')
await clickText('.wb-confirm button', 'Confirm')
const decisions = async () => (await json(`/claims/${claimId}/decisions`)).items
expect(await until(async () => (await decisions()).length >= 2, 15000), 'the backend holds the base decision and the rider decision')
await wait(1200)
const decPost = posts.filter((x) => x.url.endsWith('/decisions')).at(-1)
expect(decPost?.actor === 'rachel', `the decision POST carried X-Actor: rachel (${decPost?.actor})`)
expect(!!decPost?.key && decPost.key.length >= 8, 'the decision POST carried an Idempotency-Key')
const decs = await decisions()
const baseDec = decs.find((d) => !/accidental/i.test(d.benefitLineName ?? ''))
const rider = decs.find((d) => /accidental/i.test(d.benefitLineName ?? ''))
expect(!!baseDec && !!rider, 'a base decision and a rider decision exist')
expect(await until(async () => (await p.$$('.record')).length === 2, 8000), 'the locked decision records (v1) are shown read-only: base line and rider')
const recTxt = await text('.lv-records')
expect(recTxt.includes('v1') && recTxt.includes('locked'), 'the record view says v1 · locked')

let approvalWorkItem
if (accident) {
  console.log('4b. Above Rachel’s authority: approval by Monica')
  expect(baseDec.status === 'awaiting_approval' && baseDec.requiresApproval === true, 'the decision is recorded as awaiting_approval (202)')
  expect((await getClaim()).status === 'awaiting_approval', 'the claim is awaiting_approval')
  expect(await until(async () => (await p.$('[data-awaiting-approval]')) !== null, 8000), 'the screen shows the "Sent to Monica Reyes for approval" state')
  const t = await text('[data-awaiting-approval]')
  expect(t.includes('Sent to Monica Reyes for approval') && t.includes('Awaiting approval'), `the awaiting-approval panel names Monica (${t.slice(0, 80)})`)
  expect(t.includes('Approve payout above authority') || (await bodyText()).includes('Approve payout above authority'), 'the approver’s work item is shown')
  expect((await toastText()).includes('Monica'), `a toast says it was sent to Monica (${(await toastText()).slice(0, 100)})`)
  expect((await p.$('[data-cannot-approve]')) !== null && !(await p.evaluate(() => [...document.querySelectorAll('button')].some((x) => /^Approve /.test(x.textContent.trim())))), 'as Rachel there is no Approve button, only "sign in as Monica"')
  await shot('s4-awaiting-approval-rachel')
  expect((await deadlines()).find((d) => d.kind === 'decision_due')?.state === 'open', 'nothing is paid or closed yet: decision_due is still open')
  expect((await json(`/claims/${claimId}/payment-items`)).items.length === 0, 'no payment items exist yet')
  // Rachel cannot approve, straight against the API (X-Actor: rachel).
  const denied = await api(`/decisions/${baseDec.id}:approve`, { method: 'POST', headers: { 'X-Actor': 'rachel', 'Content-Type': 'application/json' }, body: '{}' })
  expect(denied.status === 403, `the API refuses Rachel's approval (${denied.status} ${(await denied.json()).code})`)
  approvalWorkItem = (await json('/work-items?status=open')).items.find((w) => w.claimId === claimId && w.ownerId === monica.id)
  expect(!!approvalWorkItem, 'Monica has an open work item for it')
  // Switch persona in the UI to Monica.
  await clickText('.gbar-account', 'Rachel')
  await clickText('.menu-item', 'Monica Reyes')
  await wait(900)
  expect(p.url().includes('/team'), 'signing in as Monica lands on the Team board')
  expect(await until(async () => (await bodyText()).includes('Robert Castellano'), 15000), 'the Team board lists the live approval (Robert Castellano)')
  const team = await bodyText()
  expect(team.includes('Payout above authority') && team.includes(usd(400000 + 767.12).replace('.12', '.12')) || team.includes('$400,'), 'the approval shows the amount above Rachel’s limit')
  await shot('s4-team-board-approval')
  await goto('/work', 1500)
  expect((await bodyText()).includes('Approve payout above authority'), 'Monica’s My work lists the approval work item')
  await shot('s4-monica-my-work')
  await goto(`/claims/${claimNo}/decision`)
  await shot('s4-awaiting-approval-monica')
  expect((await p.evaluate(() => [...document.querySelectorAll('button')].some((x) => /^Approve \$/.test(x.textContent.trim())))), 'as Monica the Approve button is there')
  await clickText('button', 'Approve $')
  expect(await until(async () => (await getClaim()).status === 'approved', 15000), 'Monica’s approval moves the claim to approved')
  const apPost = posts.filter((x) => x.url.includes(':approve')).at(-1)
  expect(apPost?.actor === 'monica', `the approval POST carried X-Actor: monica (${apPost?.actor})`)
  await wait(1500)
  const after = await decisions()
  const approved = after.find((d) => d.id === baseDec.id)
  expect(approved?.status === 'in_effect' && approved?.approvedByName === 'Monica Reyes', `the decision is in effect, approved by ${approved?.approvedByName}`)
  expect(await until(async () => (await text('.lv-records')).includes('Monica Reyes'), 8000), 'the locked record shows the approver')
  await shot('s4-decision-after-approval')
} else {
  expect(baseDec.status === 'in_effect' && !baseDec.requiresApproval, 'the decision is in effect within Rachel’s authority (201)')
  expect((await getClaim()).status === 'approved', 'the claim is approved')
  await shot('s4-decision-after')
}

// ---- 5. payment items
console.log('5. Payments')
const items = async () => (await json(`/claims/${claimId}/payment-items`)).items
const its = await items()
const payOn = its[0]?.payOn
const dod = (await getClaim()).details.dateOfDeath
const days = Math.round((Date.parse(payOn) - Date.parse(dod)) / 86_400_000)
// One item per payee per line: two payees, and two lines when the rider pays (an accident). Each is half of a $200,000 line plus its interest.
const nItems = accident ? 4 : 2
const each = 100000
const expInterest = Math.round(each * 0.035 * days / 365 * 100) / 100
const itemAmount = each + expInterest
console.log(`   pay date ${payOn}, ${days} days from ${dod}: interest each ${expInterest}`)
expect(its.length === nItems && its.every((i) => i.status === 'cleared' && money(i.principal) === each && money(i.interest) === expInterest && money(i.amount) === itemAmount), `${nItems} payment items: ${usd(each)} + ${usd(expInterest)} interest each, cleared`)
const totalAmount = Math.round(its.reduce((a, i) => a + money(i.amount), 0) * 100) / 100
if (payOn === '2026-10-09') {
  expect(money(its[0].amount) === 100191.78, `the mock's figure: ${usd(money(its[0].amount))} per item (Diane and Mark ${accident ? 'twice, once per line' : 'once each'})`)
  expect(totalAmount === (accident ? 400767.12 : 200383.56), `total ${usd(totalAmount)}`)
}
await goto(`/claims/${claimNo}/payments`)
const payBefore = await bodyText()
expect(!payBefore.includes('not on the backend yet'), 'Payments is a live screen')
const cells = await p.$$eval('[data-items] tbody tr', (rs) => rs.map((r) => ({ payee: r.children[0].textContent, amount: r.querySelector('[data-cell=amount]').textContent, interest: r.querySelector('[data-cell=interest]').textContent, status: r.dataset.itemStatus })))
expect(cells.length === nItems && cells.every((c) => c.amount === usd(itemAmount) && c.interest === usd(expInterest) && c.status === 'cleared'), `the screen shows ${nItems} items with ${usd(itemAmount)} each (${cells.map((c) => `${c.payee.slice(0, 5)} ${c.amount}`).join(', ')})`)
expect((await text('[data-tile=total]')) === usd(totalAmount), `the To pay tile shows ${await text('[data-tile=total]')}`)
expect((await text('[data-tile=paid]')) === '$0.00', 'nothing paid yet')
const runBtnDisabled = await p.$eval('[data-run-now]', (e) => e.disabled)
expect(runBtnDisabled === (payOn > clockNow.businessDate), `Run payment run now is ${runBtnDisabled ? 'disabled (nothing due yet)' : 'enabled'}`)
await shot('s5-payments-before-run')
await overflowAt('payments')

// hold / release with ETags
const first = its.find((i) => i.payeeName.startsWith('Mark')) ?? its[0]
await clickText(`[data-hold="${first.id}"]`, 'Hold')
await p.type(`#hold-${first.id}`, 'Bank account to be confirmed')
// A stale ETag is refused: change the item behind the screen's back (hold, release: its version moves on), then submit the form.
const stale = await p.evaluate(async (id, url) => {
  const h = { 'Content-Type': 'application/json', 'If-Match': '"0"' }
  const r1 = await fetch(`${url}/payment-items/${id}:hold`, { method: 'POST', headers: h, body: JSON.stringify({ reason: 'other desk' }) })
  const r2 = await fetch(`${url}/payment-items/${id}:release`, { method: 'POST', headers: { 'If-Match': '"1"' } })
  ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Hold payment')?.click()
  return [r1.status, r2.status]
}, first.id, `${base}api`)
expect(stale[0] === 200 && stale[1] === 200, `(setup) the item was held and released elsewhere (${stale.join(',')})`)
expect(await until(async () => (await bodyText()).includes('changed since you opened it'), 6000), 'the stale hold is refused with 412 and the screen says the payment changed')
const held412 = posts.filter((x) => x.url.endsWith(':hold')).at(-1)
expect(held412?.ifMatch === '"0"', `the hold was sent with the ETag the screen held (${held412?.ifMatch})`)
await shot('s5-hold-412')
// The form stays open with the reason typed; the item behind it has the latest version now, so submitting again works.
await wait(2500)
await clickText('button', 'Hold payment')
expect(await until(async () => (await items()).find((i) => i.id === first.id)?.status === 'held', 8000), 'hold with the current ETag succeeds: the item is held')
expect(await until(async () => (await bodyText()).includes('Held: Bank account to be confirmed'), 8000), 'the screen shows the hold and its reason')
const st = (await json(`/claims/${claimId}`)).status
expect(st === 'approved', 'a held item keeps the claim open')
await shot('s5-payments-held')
const noMatch = await api(`/payment-items/${first.id}:release`, { method: 'POST' })
expect(noMatch.status === 428, `release without If-Match is refused (${noMatch.status} ${(await noMatch.json()).code})`)
await clickText(`[data-release="${first.id}"]`, 'Release')
expect(await until(async () => (await items()).find((i) => i.id === first.id)?.status === 'cleared', 8000), 'release puts it back to cleared')
const rel = posts.filter((x) => x.url.endsWith(':release')).at(-1)
expect(!!rel?.ifMatch, `the release carried If-Match (${rel?.ifMatch})`)

// ---- 6. the payment run
console.log('6. Payment run')
const cNow = await clock()
if (payOn > cNow.businessDate) {
  await goto(`/claims/${claimNo}/payments`, 1500)
  expect((await text('[data-guide] [data-next]')).includes('Advance the clock'), `the hint says to advance the clock ("${await text('[data-guide] [data-next]')}")`)
  // The checklist's own button moves the clock to the pay date, however many days that is (the follow-up row's date depends on the day the notice was taken).
  expect(await p.evaluate(() => { const b = document.querySelector('[data-guide] [data-guide-action]'); if (b && !b.disabled) b.click(); return !!b }), 'the checklist offers a button that moves the clock to the pay date')
  await wait(800)
  const c9 = await clock()
  expect(c9.businessDate === payOn, `the clock is on the pay date ${c9.businessDate}`)
}
// With the backend's own daily trigger on (Claims:PaymentRun:ScheduleEnabled), it may pay the items the moment the clock reaches the pay date;
// then the button has nothing to do and the check falls back to what the screen shows. With it off, the button is what pays.
if (process.env.DAILY_RUN_WAIT_MS) await wait(Number(process.env.DAILY_RUN_WAIT_MS)) // give the backend's own daily trigger time to get there first
const ready = await until(async () => (await items()).every((i) => i.status === 'paid') || !(await p.$eval('[data-run-now]', (e) => e.disabled)), 15000)
const dailyRunGotThere = (await items()).every((i) => i.status === 'paid')
if (dailyRunGotThere) console.log('   note: the daily run (schedule) paid the items before the button was clicked; button assertions skipped')
else expect(ready, 'Run payment run now is enabled once the items are due')
const runsBefore = (await json('/payment-runs')).items.length
await shot('s6-run-ready')
if (!dailyRunGotThere) await clickText('[data-run-now]', 'Run payment run now')
const paidByRun = await until(async () => (await items()).every((i) => i.status === 'paid'), 20000, 500)
expect(paidByRun, dailyRunGotThere ? 'the daily run paid the items' : 'the run paid the items')
expect(await until(async () => (await getClaim()).status === 'closed', 20000, 500), 'the claim is closed')
const runs = (await json('/payment-runs')).items
if (!dailyRunGotThere) {
  expect(runs.length === runsBefore + 1 && runs[0].status === 'reconciled' && runs[0].itemCount === nItems && runs[0].paidCount === nItems, `a run exists: ${runs[0].status}, ${runs[0].itemCount} items, ${runs[0].paidCount} paid, file ${runs[0].fileReference}`)
  expect(runs[0].trigger === 'manual', 'it was started by hand (trigger: manual)')
  await wait(1500)
  const runText = await text('[data-run-result]')
  expect(runText.includes(`${nItems} items`) && runText.includes(`${nItems} paid`) && runText.includes('reconciled') && !!runs[0].fileReference && runText.includes(runs[0].fileReference), `the screen shows the run result (${runText.slice(0, 140)})`)
} else {
  expect(runs.some((r) => r.itemCount === nItems && r.paidCount === nItems && r.trigger === 'schedule'), 'the scheduled run paid all items')
}
await wait(1500)
const finalItems = await items()
expect(finalItems.every((i) => i.status === 'paid' && !!i.paymentReference && !!i.paidAt), 'every item is paid with a bank reference')
expect(await until(async () => (await text('[data-tile=paid]')) === usd(finalItems.reduce((a, i) => a + money(i.amount), 0)), 8000), `the Paid to date tile shows ${await text('[data-tile=paid]')}`)
expect((await bodyText()).includes(finalItems[0].paymentReference), 'the payment reference is on the screen')
await shot('s6-payments-after-run')
await overflowAt('payments after run')

// ---- 7. closed: letters, Workflow & SLA, History, Overview
console.log('7. Closed')
await wait(2500)
const claimEnd = await getClaim()
expect(claimEnd.status === 'closed' && !!claimEnd.closedAt, 'the claim is closed on the backend')
await goto(`/claims/${claimNo}/overview`, 1500)
await shot('s7-overview-closed')
expect((await text('.ch-bottom')).includes('Closed') || (await bodyText()).includes('Claim closed') || (await bodyText()).includes('Closed'), 'the header shows the claim closed')
const ov = await bodyText()
expect(ov.includes('Paid') && ov.includes(usd(finalItems.reduce((a, i) => a + money(i.amount), 0))), 'Overview shows the amount paid on the benefit line')
expect(!ov.includes('Record decision') || ov.includes('Closed'), 'the next step is no longer "Record decision"')

const letters = await list('letters')
const templates = letters.map((l) => l.templateCode)
await goto(`/claims/${claimNo}/communications`, 1500)
while (await p.evaluate(() => { const m = document.querySelector('.cm-more'); if (m) m.click(); return !!m })) await wait(200)
const shownLetters = (await p.$$('.cm-item')).length
expect(shownLetters === letters.length, `Communications lists all ${letters.length} letters (shows ${shownLetters})`)
for (const t of ['APR-LIFE-01', 'PAY-LIFE-01', 'CLS-LIFE-01']) expect(templates.includes(t), `letter ${t} was sent by a workflow`)
expect(templates.filter((t) => t === 'APR-LIFE-01').length === 2 && templates.filter((t) => t === 'PAY-LIFE-01').length === 2, 'each beneficiary got an approval letter and a payment confirmation')
expect(letters.every((l) => l.status === 'sent'), 'every letter was sent')
const cmText = await bodyText()
expect(cmText.includes('APR-LIFE-01') && cmText.includes('CLS-LIFE-01'), 'the decision letters and the closing letter show on the screen')
await shot('s7-communications')

const runsApi = await list('workflow-runs')
const events = runsApi.filter((r) => r.type === 'event')
expect(events.length === 2 && events.every((r) => r.status === 'completed' && r.steps.length >= 3), `two event workflow runs completed (${events.map((r) => `${r.workflowId.slice(0, 14)}… ${r.name}`).join('; ')})`)
const decisionRun = events.find((r) => decs.some((d) => r.workflowId === `event-${d.id}`))
expect(!!decisionRun, 'the decision letters run is event-<decisionId>')
await goto(`/claims/${claimNo}/workflow`, 1500)
await clickText('.wf-tab', 'Workflow runs')
await p.evaluate(() => document.querySelectorAll('.wf-run').forEach((d) => d.setAttribute('open', '')))
await wait(300)
const runsTxt = await text('.wf-runs')
expect(runsTxt.includes(decisionRun.workflowId) && runsTxt.includes('Decision recorded') && runsTxt.includes('Generate the approval letters'), 'Workflow & SLA lists the decision event run with its steps')
expect(events.filter((r) => r !== decisionRun).every((r) => runsTxt.includes(r.workflowId)) && runsTxt.includes('Event workflow'), 'and the payment confirmation event run')
await p.evaluate((id) => document.getElementById(`run-${id}`)?.scrollIntoView({ block: 'start' }), decisionRun.workflowId)
await wait(300)
await shot('s7-workflow-run-decision-event')
const payRun = events.find((r) => r !== decisionRun)
await p.evaluate((id) => document.getElementById(`run-${id}`)?.scrollIntoView({ block: 'start' }), payRun.workflowId)
await wait(300)
await shot('s7-workflow-run-payment-event')
await tabShotRuns()
async function tabShotRuns() { await scrollTo('.wf-tabs'); await wait(200); await shot('s7-workflow-runs') }
await clickText('.wf-tab', 'Swimlane')
await scrollTo('.wf-tabs')
await shot('s7-workflow-swimlane')
const lane = await text('.wf-lanes')
expect(lane.includes('Bank') || lane.includes('payment'), 'the swimlane shows the payment run and the bank')
await scrollTo('.wf-steps')
await p.evaluate(() => document.querySelector('.cw-main')?.scrollTo(0, 0))
await wait(300)
const steps = await p.$$eval('.wf-step', (els) => els.map((e) => ({ label: e.querySelector('.wf-step-label')?.textContent, cls: e.className })))
expect(steps.length === 7 && steps.every((s) => s.cls.includes('wf-step--done')), `all seven milestones are done (${steps.map((s) => `${s.label}:${s.cls.includes('done') ? 'done' : 'todo'}`).join(', ')})`)
const sla = await p.$$eval('.wf-sla tbody tr', (rs) => rs.map((r) => r.textContent.replace(/\s+/g, ' ')))
const slaOf = (name) => sla.find((s) => s.includes(name)) ?? ''
for (const n of ['First contact with the claimant', 'Decide after proof of loss', 'Examiner review', 'Pay after approval']) expect(/Met/.test(slaOf(n)) && !/Breach/.test(slaOf(n)), `service level "${n}" is met (${slaOf(n).slice(-70)})`)
expect(/Paid/.test(slaOf('Interest')) && slaOf('Interest').includes(usd(nItems * expInterest)), `the interest service level shows the interest from the payment items (${slaOf('Interest').slice(-90)})`)
await shot('s7-workflow-top')

await goto(`/claims/${claimNo}/history`, 1500)
const hist = await text('.hi-list')
expect(hist.includes('Decision recorded') && hist.includes('Rachel Kim'), 'History shows the decision, by Rachel Kim')
if (accident) expect(hist.includes('Monica Reyes'), 'History shows Monica’s approval')
expect(/payment/i.test(hist) && /closed/i.test(hist), 'History shows the payment and the close')
await shot('s7-history')

// ---- the mock's own behaviour is untouched: sample claims stay hidden
await goto('/work', 1500)
expect((await bodyText()).includes(claimNo), 'the queue still lists the claim')

expect(errs.length === 0, `no console or page errors (${errs.slice(0, 3).join(' | ')})`)
await b.close()
console.log(`\n${passed} checks passed, ${fails.length} failed`)
if (errs.length) console.error(errs.join('\n'))
if (fails.length) console.error(`FAILED:\n - ${fails.join('\n - ')}`)
process.exit(fails.length ? 1 : 0)
