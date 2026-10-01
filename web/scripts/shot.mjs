// Screenshot a route of the running dev server and report layout problems.
// Usage: node scripts/shot.mjs <route> <out.png> [width] [height] [--click "selector"]...
//   e.g. node scripts/shot.mjs /claims/L-26-040112/decision /tmp/decision.png 1440 960
// Reports: console errors, page errors, and elements that overflow horizontally.
import puppeteer from 'puppeteer-core'

const [route = '/', out = 'shot.png', w = '1440', h = '960', ...rest] = process.argv.slice(2)
const clicks = []
for (let i = 0; i < rest.length; i++) if (rest[i] === '--click') clicks.push(rest[++i])
const base = process.env.BASE_URL ?? 'http://localhost:5173/'
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--hide-scrollbars'],
})
const page = await browser.newPage()
await page.setViewport({ width: Number(w), height: Number(h), deviceScaleFactor: 1 })
const problems = []
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
await page.goto(`${base}#${route}`, { waitUntil: 'networkidle0' })
await page.evaluate(() => document.fonts.ready)
await new Promise((r) => setTimeout(r, 400))
for (const sel of clicks) {
  const el = await page.$(sel)
  if (!el) problems.push(`click: no element for ${sel}`)
  else { await el.click(); await new Promise((r) => setTimeout(r, 400)) }
}
const overflow = await page.evaluate(() => {
  const res = []
  const vw = document.documentElement.clientWidth
  if (document.documentElement.scrollWidth > vw) res.push(`page scrolls horizontally: ${document.documentElement.scrollWidth} > ${vw}`)
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (el.scrollWidth > el.clientWidth + 1 && ['visible', 'hidden'].includes(cs.overflowX) && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0 && !['svg', 'path'].includes(el.tagName.toLowerCase()) && !el.closest('.sr-only')) {
      const t = (el.textContent || '').trim().slice(0, 50)
      if (cs.overflowX === 'visible' || cs.whiteSpace === 'nowrap') res.push(`overflow ${el.tagName.toLowerCase()}.${el.className} (${el.scrollWidth}>${el.clientWidth}): "${t}"`)
    }
  }
  return res.slice(0, 15)
})
await page.screenshot({ path: out })
console.log(problems.concat(overflow).join('\n') || 'OK — no errors or overflow')
await browser.close()
