// Visit every claim section, page and portal view; report console errors and horizontal overflow.
// Usage (dev server running): node scripts/sweep.mjs [width] [height]
import puppeteer from 'puppeteer-core'

const [w = '1440', h = '960'] = process.argv.slice(2)
const base = process.env.BASE_URL ?? 'http://localhost:5173/'
const CLAIMS = ['L-26-040112', 'L-26-038907', 'L-26-035120', 'D-26-073390', 'D-25-018334', 'A-26-015530',
  'L-26-036554', 'L-26-031145', 'L-26-042877', 'L-26-041577', 'L-26-039870', 'L-26-037711', 'L-25-022918',
  'L-26-042210', 'L-26-038115', 'L-26-029984', 'A-26-016204', 'A-19-004418', 'D-25-029116', 'D-26-071245',
  'D-26-074021', 'D-26-052218', 'D-26-060751']
const PAGES = ['/work', '/team', '/insights', '/intake', '/intake/life', '/portal', '/claims/D-25-018334/documents/doc-bell-aps',
  '/claims/D-26-073390/requirements/req-vas-aps']

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: Number(w), height: Number(h) })
let current = ''
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(`${current}  console: ${m.text().slice(0, 160)}`))
page.on('pageerror', (e) => problems.push(`${current}  pageerror: ${e.message.slice(0, 160)}`))

async function visit(route) {
  current = route
  await page.goto(`${base}#${route}`)
  await new Promise((r) => setTimeout(r, 350))
  const o = await page.evaluate(() => {
    const out = []
    const d = document.documentElement
    if (d.scrollWidth > d.clientWidth) out.push(`page ${d.scrollWidth}>${d.clientWidth}`)
    const main = document.querySelector('.cw-main')
    if (main && main.scrollWidth > main.clientWidth + 1) out.push(`main ${main.scrollWidth}>${main.clientWidth}`)
    if (document.querySelector('.planned')) out.push('placeholder shown')
    if (/not found/i.test(document.querySelector('h1')?.textContent ?? '')) out.push('not found')
    return out
  })
  o.forEach((x) => problems.push(`${route}  ${x}`))
}

await page.goto(base)
let n = 0
for (const p of PAGES) { await visit(p); n++ }
for (const id of CLAIMS) {
  await visit(`/claims/${id}/overview`); n++
  const links = await page.$$eval('.sn a', (as) => as.map((a) => a.getAttribute('href').replace(/^#/, '')))
  for (const l of links) if (!l.endsWith('/overview')) { await visit(l); n++ }
}
console.log(`${n} routes at ${w}×${h}`)
console.log(problems.length ? problems.join('\n') : 'OK — no errors, overflow or placeholders')
await browser.close()
