// Render a swimlane diagram to a PNG.
//   node render.mjs <spec.json> <out.png> [--scale 2] [--bare] [--dark]
// Needs Chrome (set CHROME_PATH if it is not in the usual place) and `npm install` once in the skill folder.
// Exit code: 0 = PNG written, 1 = spec error, 2 = usage or setup problem.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const CHROME = [process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p))

let puppeteer
try { puppeteer = (await import('puppeteer-core')).default } catch {
  console.error(`puppeteer-core is not installed. Run once:  cd "${resolve(here, '..')}" && npm install`); process.exit(2)
}
if (!CHROME) { console.error('Chrome not found. Install Google Chrome, or set CHROME_PATH to the browser executable.'); process.exit(2) }

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value }
const bool = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true }
const scale = Number(flag('--scale') ?? 2)
const bare = bool('--bare'), dark = bool('--dark')
const [specFile, outFile] = args
if (!specFile || !outFile) { console.error('usage: render.mjs <spec.json> <out.png> [--scale 2] [--bare] [--dark]'); process.exit(2) }

const KINDS = ['chip', 'bad', 'timer', 'void', 'run', 'runT', 'fail', 'track', 'span']

/** Checks a spec before drawing, so mistakes come back as plain sentences. Returns a list of problems. */
function validate(spec) {
  const bad = []
  if (!spec.aria) bad.push('spec.aria is missing: add one sentence describing the diagram (used as alt text)')
  if (!Array.isArray(spec.lanes) || spec.lanes.length < 2) bad.push('spec.lanes needs at least 2 lanes: [{ "id": "customer", "name": "Customer" }, ...]')
  if (!Array.isArray(spec.phases) || spec.phases.length < 2) bad.push('spec.phases needs at least 2 columns')
  if (!Array.isArray(spec.items) || !spec.items.length) bad.push('spec.items is empty')
  if (bad.length) return bad
  const laneIds = spec.lanes.map((l) => l.id)
  spec.lanes.forEach((l, n) => {
    if (!l.id || !l.name) bad.push(`lane #${n + 1}: needs "id" and "name"`)
    if (l.name && l.name.length > 18) bad.push(`lane "${l.name}": name is longer than 18 characters and will be cut off; shorten it`)
    if (l.sub && l.sub.length > 26) bad.push(`lane "${l.name}": sub is longer than 26 characters and will be cut off; shorten it`)
    if (l.tint && !['grey', 'blue'].includes(l.tint)) bad.push(`lane "${l.name}": tint must be "grey" or "blue"`)
  })
  if (new Set(laneIds).size !== laneIds.length) bad.push('lane ids must be unique')
  const items = spec.items.map((it, n) => Array.isArray(it)
    ? { lane: it[0], p: it[1], x: it[2], r: it[3], k: it[4], t: it[5], id: it[6], by: it[7], n }
    : { ...it, n })
  const byId = new Map(items.filter((it) => it.id).map((it) => [it.id, it]))
  const seen = new Set()
  for (const it of items) {
    const at = `item #${it.n + 1} (${JSON.stringify(it.t ?? '')})`
    const kind = it.k ?? 'chip'
    if (!laneIds.includes(it.lane)) bad.push(`${at}: lane "${it.lane}" is not one of ${laneIds.join(', ')}`)
    if (!Number.isInteger(it.p) || it.p < 0 || it.p >= spec.phases.length) bad.push(`${at}: phase index ${it.p} is outside 0..${spec.phases.length - 1}`)
    if (it.to !== undefined && (!Number.isInteger(it.to) || it.to < it.p || it.to >= spec.phases.length)) bad.push(`${at}: "to" must be a phase at or after "p"`)
    if (!KINDS.includes(kind)) bad.push(`${at}: kind "${kind}" is not one of ${KINDS.join(', ')}`)
    if (!it.t) bad.push(`${at}: text is empty`)
    if (it.x !== undefined && (it.x < 0 || it.x > 1)) bad.push(`${at}: x must be between 0 and 1`)
    if (it.r !== undefined && (!Number.isInteger(it.r) || it.r < 0)) bad.push(`${at}: row must be 0 or a positive whole number`)
    if (it.by && !byId.has(it.by)) bad.push(`${at}: started-by id "${it.by}" matches no item id`)
    if (it.id) { if (seen.has(it.id)) bad.push(`${at}: id "${it.id}" is used twice`); seen.add(it.id) }
    const src = it.by && byId.get(it.by)
    if (src && kind === 'run' && src.k === 'timer') bad.push(`${at}: "run" is started by an event, but "${it.by}" is a timer; use "runT"`)
    if (src && kind === 'runT' && src.k !== 'timer') bad.push(`${at}: "runT" is started by a timer, but "${it.by}" is not a "timer" item; use "run"`)
  }
  for (const l of spec.links ?? []) for (const e of [l.a, l.b]) if (!byId.has(e)) bad.push(`link ${l.a} -> ${l.b}: id "${e}" matches no item`)
  for (const m of spec.marks ?? []) if (!byId.has(m.on)) bad.push(`mark ${m.n}: id "${m.on}" matches no item`)
  return bad
}

const spec = JSON.parse(readFileSync(specFile, 'utf8'))
const problems = validate(spec)
if (problems.length) { console.error('Spec problems:\n- ' + problems.join('\n- ')); process.exit(1) }

const FONT = spec.font ?? 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const colors = spec.colors ?? {}
const overrides = { accent: '--accent', accentTint: '--accent-tint', risk: '--risk' }
const vars = Object.entries(overrides).filter(([k]) => colors[k]).map(([k, v]) => `${v}:${colors[k]}`).join(';')
const html = `<!doctype html><html lang="en" data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8">
<style>:root{--font:${FONT}}${vars ? `:root,:root[data-theme]{${vars}}` : ''}</style>
<style>${readFileSync(join(here, 'swimlane.css'), 'utf8')}</style>
<script>window.SWIMLANE_FONT = ${JSON.stringify(FONT)}</script>
<script>${readFileSync(join(here, 'swimlane.js'), 'utf8')}</script></head>
<body><div class="canvas" id="diagram"></div>
<script>document.getElementById('diagram').appendChild(Swimlane.render(${JSON.stringify(spec).replace(/</g, '\\u003c')}))</script></body></html>`
const page = join(mkdtempSync(join(tmpdir(), 'swimlane-')), 'diagram.html')
writeFileSync(page, html)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] })
try {
  const p = await browser.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }])
  await p.setViewport({ width: 1312, height: 900, deviceScaleFactor: scale })
  await p.goto(pathToFileURL(page).href, { waitUntil: 'load' })
  await p.evaluate(() => document.fonts.ready)
  if (!(await p.$('#diagram svg'))) { console.error(`Nothing was drawn${errs.length ? ': ' + errs.join('; ') : ''}`); process.exit(1) }

  // Layout check: chips must stay inside the drawing, must not overlap, and must not cross a column line.
  const warnings = await p.evaluate(() => {
    const svg = document.querySelector('#diagram svg')
    const vb = svg.viewBox.baseVal
    const out = []
    const boxes = [...svg.querySelectorAll('rect.it, rect.track, rect.span')].map((r) => {
      const b = r.getBBox(); let t = r.nextElementSibling
      while (t && t.tagName !== 'text') t = t.nextElementSibling // an icon can sit between the box and its text
      return { x: b.x, y: b.y, w: b.width, tw: t ? t.getBBox().width : 0, label: t ? t.textContent : '?', cls: r.getAttribute('class') }
    })
    const lines = [...svg.querySelectorAll('line.phase')]
    const cuts = lines.map((l) => +l.getAttribute('x1'))
    const laneBottom = lines.length ? Math.max(...lines.map((l) => +l.getAttribute('y2'))) : vb.height
    for (const b of boxes) {
      if (/^(track|span)/.test(b.cls) && b.tw > b.w - 16) out.push(`status text "${b.label}" does not fit its bar; shorten it or give the bar more columns or a wider column`)
      if (b.x + b.w > vb.width - 6) out.push(`"${b.label}" runs past the right edge`)
      if (b.x < 10) out.push(`"${b.label}" runs past the left edge`)
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j]
      if (Math.abs(a.y - c.y) < 1 && a.x < c.x + c.w && c.x < a.x + a.w) out.push(`"${a.label}" overlaps "${c.label}"`)
    }
    for (const b of boxes) {
      if (/^(track|span)/.test(b.cls) || b.y > laneBottom) continue // status bars span columns; the legend sits below the lanes
      if (cuts.some((x) => x > b.x + 2 && x < b.x + b.w - 2)) out.push(`"${b.label}" crosses a column line; shorten its text, change x, or use another row`)
    }
    return out
  })

  const el = await p.$(bare ? '#diagram svg' : '#diagram')
  mkdirSync(dirname(resolve(outFile)), { recursive: true })
  await el.screenshot({ path: outFile })
  const box = await el.boundingBox()
  console.log(`wrote ${outFile} (${Math.round(box.width * scale)}x${Math.round(box.height * scale)} px)`)
  if (errs.length) console.log('page errors: ' + errs.join('; '))
  if (warnings.length) console.log('Layout warnings (fix these, then render again):\n- ' + [...new Set(warnings)].join('\n- '))
  else console.log('Layout check: ok')
} finally {
  await browser.close()
}
