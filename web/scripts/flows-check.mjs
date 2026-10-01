import puppeteer from 'puppeteer-core'
const S = process.argv[2]
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const p = await b.newPage(); await p.setViewport({ width: 1440, height: 960 })
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
const go = async (r) => { await p.goto(`http://localhost:5173/#${r}`); await new Promise((x) => setTimeout(x, 500)) }
const click = async (sel) => { await p.click(sel); await new Promise((x) => setTimeout(x, 600)) }
const text = (sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)')

await go('/claims/D-26-073390/requirements')
console.log('BEFORE  vasquez exceptions:', await text('.xs-count'), '| docs badge:', await text('.sn a[href$="/documents"]'))
await go('/portal/elena/tasks/upload/financials')
await click('.pt-demo-link'); await click('.pt-btn--primary')
await go('/claims/D-26-073390/requirements')
console.log('AFTER   vasquez exceptions:', await text('.xs-count'), '| docs badge:', await text('.sn a[href$="/documents"]'), '| summary:', await text('.cw-main .page-head'))
await p.screenshot({ path: `${S}/flow-vasquez.png` })

await go('/claims/L-26-038907/communications')
console.log('BEFORE  okafor next step:', await text('.ch-next'))
await click('.drawer-foot .btn--primary')
console.log('AFTER   okafor next step:', await text('.ch-next'), '| exceptions:', await text('.xs-list'))
await go('/work'); console.log('rachel queue:', await text('.wtab--queue'))
await p.screenshot({ path: `${S}/flow-okafor.png` })
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') : 'no errors')
await b.close()
