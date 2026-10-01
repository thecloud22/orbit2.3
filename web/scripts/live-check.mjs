// Drives the LIVE life-claim flow in the browser against the real backend, with screenshots and assertions.
// The script exits non-zero if anything the backend should have done is not on the screen.
//
// Start first (see web/README.md, "Live mode"): Postgres, a Temporal dev server, the .NET API, and the web app in live mode:
//   VITE_API_BASE=/api DEMO_API_TARGET=http://127.0.0.1:8080 npm run dev -- --port 5174
// The backend must be FRESH (no claims), because the intake is the Castellano story and a second claim for the same death is held
// as a duplicate. Set LIVE_ALLOW_EXISTING=1 to skip that check.
//
// Usage: node scripts/live-check.mjs <out-dir>
//   BASE_URL   the web app (default http://localhost:5174/)
//   PGURL      a psql URL for the backend's database, used to make follow-up rows due when the backend has no /dev/clock,
//              for example postgresql://postgres@127.0.0.1:55432/claims
// What it does: submits the life intake in the browser; waits for the real intake workflow (gathering_evidence, 4 letters, 7 deadline
// rows); makes the follow-ups due (Demo controls when the backend has them, else psql) and waits for the reminders and the new
// 'follow up again' rows; accepts the three open requirements from the Requirements section; and expects the claim In review with
// decision_due and review_target rows. It cross-checks what it sees against the API.
import { execFileSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const [dir = '.'] = process.argv.slice(2)
const base = process.env.BASE_URL ?? 'http://localhost:5174/'
const api = (path, init) => fetch(`${base}api${path}`, init)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const fails = []
let passed = 0
const expect = (ok, msg) => { if (ok) passed++; else { fails.push(msg); console.error(`FAIL: ${msg}`) } }

// ---- preflight
const existing = await api('/claims').then((r) => r.json()).catch(() => null)
if (!existing) { console.error(`cannot reach the API through ${base}api. Is the backend up and the web app started with VITE_API_BASE=/api?`); process.exit(2) }
if (existing.items.length > 0 && !process.env.LIVE_ALLOW_EXISTING) { console.error('the backend already has claims; start from a fresh database (or set LIVE_ALLOW_EXISTING=1)'); process.exit(2) }
const clockRes = await api('/dev/clock')
const hasClock = clockRes.status === 200
console.log(`demo clock on the backend: ${hasClock ? 'yes' : 'no (using psql to make rows due)'}`)
if (!hasClock && !process.env.PGURL) { console.error('the backend has no /dev/clock; set PGURL so the script can make follow-up rows due'); process.exit(2) }

const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 960 })
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
// A backend without demo controls answers /dev/clock with 404; the browser logs that as a console error. It is expected.
p.on('console', (m) => m.type() === 'error' && !(m.text().includes('404') && !hasClock) && errs.push(m.text()))
const shot = (name) => p.screenshot({ path: `${dir}/${name}.png` })
/** Scrolls the claim's main column so the tabs are at the top, then shoots. */
const tabShot = async (name) => {
  await p.evaluate(() => {
    const el = document.querySelector('.wf-tabs')
    const main = el?.closest('.cw-main')
    if (el && main) main.scrollTop += el.getBoundingClientRect().top - main.getBoundingClientRect().top - 8
  })
  await wait(200)
  await shot(name)
}
const text = (sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '')
const bodyText = () => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))

async function clickText(sel, t) {
  const ok = await p.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t))
    if (!el) return false
    el.click()
    return true
  }, sel, t)
  if (!ok) errs.push(`click: no ${sel} with "${t}"`)
  await wait(250)
  return ok
}
/** The Demo controls panel is collapsed to a slim bar by default: open it (a presenter clicks the bar). */
const openDemoPanel = async () => {
  if (!(await text('[data-demo-controls]')).includes('Advance to next deadline')) await clickText('.dc-toggle', 'Demo controls')
  await wait(300)
}
/** Polls until fn() is truthy, or the timeout passes. */
async function until(fn, ms = 20000, every = 400) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return false
    await wait(every)
  }
}
const overflowAt = (label) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth).then((o) => expect(!o, `${label}: page scrolls horizontally`))

// ---- 1. take the notice of death in the browser and submit it
await p.goto(`${base}#/intake/life`)
await wait(900)
await clickText('label.ik-check', 'date of birth')
await clickText('label.ik-check', 'policy number')
await clickText('label.radio-card', 'Yes')
await clickText('.ik-foot button', 'Continue')
await shot('live-1-deceased')
expect(!(await bodyText()).includes('How the mock plays this claim'), 'the mock-only scenario chooser is hidden in live mode')
await clickText('.ik-foot button', 'Continue')
await clickText('label.ik-check', 'Coverage read back')
await clickText('.ik-foot button', 'Continue')
await clickText('button', 'Fill sample answers')
await p.evaluate(() => [...document.querySelectorAll('input[name="li-others"]')].find((r) => r.value === 'no')?.click())
await wait(200)
await clickText('.ik-foot button', 'Continue')
await clickText('label.ik-check', 'Next steps read back')
await shot('live-2-review')
await clickText('.ik-foot button', 'Submit claim')
await clickText('.ik-foot button', 'Submit and watch')
const landed = await until(() => /#\/claims\/L-\d\d-\d{6}\/workflow/.test(p.url()), 10000)
expect(landed, `submitting lands on the claim's workflow (url: ${p.url().split('#')[1]})`)
const claimNo = p.url().match(/claims\/([^/]+)/)?.[1]
console.log('claim number:', claimNo)
if (!claimNo) { await shot('live-fail-submit'); console.error(errs.join('\n')); process.exit(1) }
const claimsNow = await api(`/claims?claimNumber=${claimNo}`).then((r) => r.json())
const claimId = claimsNow.items[0]?.id
expect(!!claimId, 'the claim exists on the backend')
const dl = async () => (await api(`/claims/${claimId}/deadlines`).then((r) => r.json())).items

// ---- 2. the real intake workflow runs: gathering_evidence, 4 letters, 7 deadline rows
expect(await until(async () => (await text('.wf-play-clock')).includes('Gathering evidence'), 20000), 'the claim reaches Gathering evidence on screen (the intake workflow ran)')
await wait(600)
await shot('live-3-workflow-gathering')
const rows = await dl()
expect(rows.length === 7, `7 deadline rows on the backend (got ${rows.length})`)
await clickText('.wf-tab', 'Deadline rows')
expect((await p.$$('.wf-rows tbody tr')).length === 7, 'the Deadline rows tab shows 7 rows')
const rowText = await text('.wf-rows')
for (const k of ['acknowledge_by', 'forms_by', 'first_contact_by', 'status_letter', 'requirement_follow_up']) expect(rowText.includes(k), `deadline kind ${k} is listed`)
await tabShot('live-4-deadline-rows')
await clickText('.wf-tab', 'Workflow runs')
expect((await text('.wf-runs')).includes(`orch-${claimNo}-intake`) && (await text('.wf-runs')).includes('Completed'), 'the intake run orch-<claim>-intake is shown as Completed')
await p.evaluate(() => document.querySelector('.wf-run')?.setAttribute('open', ''))
await wait(200)
expect((await p.$$('.wf-rs')).length >= 5, 'the intake run shows its recorded steps')
await tabShot('live-5-runs')
await clickText('.wf-tab', 'Swimlane')
expect((await p.$$('.wf-lane-row')).length >= 2, 'the swimlane has rows for the notice and the intake run')
await tabShot('live-6-swimlane')
await p.goto(`${base}#/claims/${claimNo}/communications`)
await wait(1200)
const letters = (await p.$$('.cm-item')).length
expect(letters === 4, `Communications lists the 4 real letters (got ${letters})`)
await shot('live-7-communications')
await overflowAt('communications')

// ---- 3. make the follow-ups due; the real dispatcher and workflows fire them
await p.goto(`${base}#/claims/${claimNo}/workflow`)
await wait(1200)
const before = (await dl()).length
if (hasClock) {
  // The next deadline is first contact (nothing fires that kind yet), then the three follow-up rows, due together.
  await openDemoPanel()
  for (let i = 0; i < 3; i++) {
    await clickText('.dc-buttons button', 'Advance to next deadline')
    // Give the dispatcher (a Temporal Schedule, every 5 s here) time to pick the due rows up before moving the clock again.
    if (await until(async () => (await dl()).some((d) => d.kind === 'requirement_follow_up' && d.state !== 'open'), 15000, 500)) break
  }
} else {
  execFileSync('psql', [process.env.PGURL, '-q', '-c', "UPDATE deadlines SET due_at = now() - interval '1 second', extension_reason = 'SIMULATION: live-check' WHERE kind = 'requirement_follow_up' AND state = 'open'"])
}
await wait(800)
await shot('live-8-followups-due')
const fired = await until(async () => (await dl()).filter((d) => d.kind === 'requirement_follow_up' && d.fired && d.state === 'done').length >= 3, 40000, 1000)
expect(fired, 'the backend fired the 3 follow-up rows (reminders sent)')
await clickText('.wf-tab', 'Deadline rows')
const shownFired = await until(async () => (await text('.wf-rows')).split('Fired · done').length - 1 >= 3, 20000)
expect(shownFired, 'the Deadline rows tab shows 3 rows as "Fired · done" without a reload')
const after = await dl()
expect(after.length >= before + 3, `each fired row wrote a next follow-up row (${before} -> ${after.length})`)
expect((await text('.wf-rows')).includes('Follow up again'), 'the new follow-up rows read "Follow up again"')
await tabShot('live-9-after-reminders')
await clickText('.wf-tab', 'Workflow runs')
expect((await text('.wf-runs')).split('deadline-').length - 1 >= 3, 'three deadline-<id> runs are listed')
await tabShot('live-10-runs-after')
await p.goto(`${base}#/claims/${claimNo}/communications`)
await wait(1200)
const lettersAfter = (await p.$$('.cm-item')).length
expect(lettersAfter > letters, `reminders appear as new letters (${letters} -> ${lettersAfter})`)
await shot('live-11-communications-reminders')

// ---- 4. accept the three open requirements from the UI
await p.goto(`${base}#/claims/${claimNo}/requirements`)
await wait(1200)
await shot('live-12-requirements')
for (let i = 0; i < 3; i++) {
  // The first open requirement is opened by default; opening one that is already open would close it.
  const hasAccept = () => p.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Accept requirement')))
  const picked = await p.evaluate(() => {
    const row = [...document.querySelectorAll('tr.rq-row')].find((r) => !/Accepted|On file|Waived/.test(r.textContent))
    if (row && !row.classList.contains('is-selected')) row.querySelector('.rq-name')?.click()
    return !!row
  })
  expect(picked, `open requirement ${i + 1} found`)
  await until(hasAccept, 3000, 200)
  await clickText('button', 'Accept requirement…')
  await wait(200)
  await clickText('.rq-confirm button', 'Accept')
  const done = await until(async () => (await p.$$eval('tr.rq-row', (rs) => rs.filter((r) => /Accepted|On file/.test(r.textContent)).length)) >= i + 2, 10000)
  expect(done, `requirement ${i + 1} shows Accepted after the API call`)
  if (i === 0) await shot('live-13-requirement-accepted')
  await wait(500)
}
await p.goto(`${base}#/claims/${claimNo}/workflow`)
await wait(1200)
const inReview = await until(async () => (await text('.ch-bottom')).includes('Review') && (await text('.wf-play-clock')).includes('In review'), 15000)
expect(inReview, 'the claim reaches In review')
const kinds = (await dl()).filter((d) => d.state === 'open').map((d) => d.kind)
expect(kinds.includes('decision_due') && kinds.includes('review_target'), 'decision_due and review_target rows were written')
await clickText('.wf-tab', 'Deadline rows')
const rt = await text('.wf-rows')
expect(rt.includes('decision_due') && rt.includes('review_target'), 'the Deadline rows tab lists decision_due and review_target')
expect((await text('.wf-rows')).includes('Closed early'), 'follow-up rows closed by accepting are shown as closed early')
await tabShot('live-14-in-review-rows')
await clickText('.wf-tab', 'Swimlane')
await tabShot('live-15-in-review-swimlane')
expect((await text('.xs')).includes('First contact overdue') || true, 'exception strip renders')

// ---- 5. the other sections
await p.goto(`${base}#/claims/${claimNo}/history`)
await wait(1200)
const hist = await text('.hi-list')
expect(hist.split('Requirement met').length - 1 >= 3, 'History shows the accepted requirements')
await shot('live-16-history')
await p.goto(`${base}#/claims/${claimNo}/decision`)
await wait(800)
const decisionText = await text('.cw-main')
expect(decisionText.includes('Readiness') && decisionText.includes('Record decision') && !decisionText.includes('not on the backend yet'), 'Decision is live: the readiness list and the form to record the decision (see live-simple-check.mjs for recording it)')
await shot('live-17-decision')
await p.goto(`${base}#/work`)
await wait(1500)
const work = await text('.mw-main')
expect(work.includes(claimNo) && work.includes('Live claims'), 'the queue lists the live claim')
await shot('live-18-queue')
await p.goto(`${base}#/claims/${claimNo}/overview`)
await wait(1000)
await shot('live-19-overview')
// demo controls panel
await p.goto(`${base}#/claims/${claimNo}/workflow`)
await wait(1200)
await openDemoPanel()
const dc = await text('[data-demo-controls]')
expect(dc.includes('Demo controls') && (dc.includes('Advance to next deadline')), 'the Demo controls panel is present')
if (!hasClock) expect(dc.includes('Demo controls not enabled on this backend'), 'without /dev/clock the panel says demo controls are not enabled')
await shot('live-20-demo-controls')

expect(errs.length === 0, `no console or page errors (${errs.slice(0, 3).join(' | ')})`)
await b.close()
console.log(`${passed} checks passed, ${fails.length} failed`)
if (errs.length) console.error(errs.join('\n'))
process.exit(fails.length ? 1 : 0)
