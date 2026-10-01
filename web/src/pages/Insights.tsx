import { useCallback, useRef, useState, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { getOps, OPS_LINES, type OpsData, type OpsLine, type ProductFilter } from '../api/team'
import { fmtDate } from '../lib/dates'
import { cx } from '../lib/cx'
import { Tag, ToneShape } from '../components/Tag'
import { Avatar } from '../components/Avatar'
import { useToast } from '../components/Toasts'
import './Insights.css'

const TARGET = 98
const LINE_NAMES: Record<OpsLine, string> = { life: 'Life', di: 'Disability income', annuity: 'Annuities' }
const SHORT: Record<OpsLine, string> = { life: 'Life', di: 'DI', annuity: 'Annuity' }
const PRODUCTS: { key: ProductFilter; label: string; aria: string }[] = [
  { key: 'all', label: 'All', aria: 'all' },
  { key: 'life', label: 'Life', aria: 'life' },
  { key: 'di', label: 'Disability income', aria: 'disability income' },
  { key: 'annuity', label: 'Annuities', aria: 'annuities' },
]
const CLOCK_SHORT: Record<string, string> = { ack: 'Acknowledgments', decision: 'Decisions', letters: 'Status letters', complaints: 'Complaint responses', payment: 'Payments' }

// Chart colours from the canvas board; text always uses ink tokens.
const C = { accent: '#2a78d6', accentLight: '#86b6ef', other: '#8E9197', withdrawn: '#1baf7a', denied: '#eb6834', below: '#C98A1B', above: '#62666D' }

const nf = new Intl.NumberFormat('en-US')
const n0 = (n: number) => nf.format(Math.round(n))
const pct1 = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`
const pct0 = (n: number) => `${Math.round(n)}%`
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n))}%`

function sumBy(lines: OpsLine[], f: (l: OpsLine) => number): number {
  return lines.reduce((a, l) => a + f(l), 0)
}

function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/** Operations dashboard (canvas 06.2): inventory, clocks, ageing, outcomes and fast track, sliced by product. */
export function Insights() {
  const toast = useToast()
  const ops = getOps()
  const [product, setProduct] = useState<ProductFilter>('all')
  const lines = product === 'all' ? OPS_LINES : [product]
  const m = measures(ops, lines)

  const subtitle = product === 'all' ? 'Life, disability income and annuities' : LINE_NAMES[product]
  const notInMock = (what: string) => () => toast(`${what}: the sample data covers 13 weeks, all teams and all states`)

  return (
    <main className="in" aria-labelledby="in-h">
      <div className="in-head">
        <div className="in-head-row">
          <h1 id="in-h">Claims operations</h1>
          <span className="soft ellipsis">{subtitle} · all teams · week to {fmtDate(ops.weeks[ops.weeks.length - 1], { year: true })}</span>
          <Tag>Sample data</Tag>
          <span className="grow" />
          <span className="sub nowrap">Refreshed today 07:00</span>
          <button type="button" className="btn btn--sm" onClick={() => exportCsv(ops, lines, product)}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7" /><path d="M2.75 12.5v1h10.5v-1" /></svg>
            Export
          </button>
        </div>
        <div className="in-filters" role="group" aria-label="Filters">
          <button type="button" className="in-drop" onClick={notInMock('Period')}><span>Period:</span>13 weeks<Chevron /></button>
          <span className="in-filter-label" id="in-prod-l">Product</span>
          <div className="in-seg" role="group" aria-labelledby="in-prod-l">
            {PRODUCTS.map((p) => (
              <button key={p.key} type="button" aria-pressed={product === p.key} aria-label={`Product: ${p.aria}`} onClick={() => setProduct(p.key)}>{p.label}</button>
            ))}
          </div>
          <button type="button" className="in-drop" onClick={notInMock('Team')}><span>Team:</span>All<Chevron /></button>
          <button type="button" className="in-drop" onClick={notInMock('State')}><span>State:</span>All<Chevron /></button>
          <span className="sub in-filter-note">Filters apply to every measure and chart below</span>
        </div>
      </div>

      <section aria-label="Key measures" className="in-kpis">
        <dl>
          <div className="in-kpi">
            <dt>Open inventory</dt>
            <dd className="in-kpi-n">{n0(m.inventoryNow)}</dd>
            <dd className="in-kpi-note">{m.inventoryChange >= 0 ? '+' : '−'}{Math.abs(m.inventoryChange).toFixed(1)}% vs 4 weeks ago</dd>
          </div>
          <PctKpi label="Decisions within state deadlines" value={m.clockPct.decision} />
          <PctKpi label="Status letters on time" value={m.clockPct.letters} />
          <div className="in-kpi">
            <dt>Median days to decision</dt>
            <dd className="in-kpi-n in-kpi-multi">
              {lines.map((l) => <span key={l}><span>{ops.medianDays[l]}</span><span className="in-kpi-unit">{SHORT[l]}</span></span>)}
            </dd>
            <dd className="in-kpi-note">Claim received to decision</dd>
          </div>
          <div className="in-kpi">
            <dt>Reconsiderations overturned</dt>
            <dd className="in-kpi-n">{pct0(m.overturned)}</dd>
            <dd className="in-kpi-note">Rolling 12 months</dd>
          </div>
          <div className="in-kpi">
            <dt>Payment accuracy</dt>
            <dd className="in-kpi-n">{pct1(m.accuracy)}</dd>
            <dd className="in-kpi-note">From quality audit samples</dd>
          </div>
        </dl>
      </section>

      <div className="in-body">
        <div className="in-charts">
          <InventoryFigure ops={ops} lines={lines} />
          <TimelinessFigure ops={ops} lines={lines} />
          <AgeingFigure ops={ops} lines={lines} />
          <OutcomesFigure ops={ops} lines={lines} />
          <FastTrackFigure ops={ops} lines={lines} />
        </div>
        <Attention ops={ops} lines={lines} />
      </div>
    </main>
  )
}

function Chevron() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>
}

/** A percentage KPI measured against the 98% target, with shape + word. */
function PctKpi({ label, value }: { label: string; value: number }) {
  const meets = value >= TARGET
  return (
    <div className="in-kpi">
      <dt>{label}</dt>
      <dd className="in-kpi-n">{pct1(value)}</dd>
      <dd className={cx('in-kpi-note', 'in-kpi-status', meets ? 'is-meets' : 'is-below')}>
        <ToneShape tone={meets ? 'positive' : 'caution'} />{meets ? 'Meets' : 'Below'} {TARGET}% target
      </dd>
    </div>
  )
}

function measures(ops: OpsData, lines: OpsLine[]) {
  const last = ops.weeks.length - 1
  const inventoryNow = sumBy(lines, (l) => ops.inventory[l][last])
  const inventoryThen = sumBy(lines, (l) => ops.inventory[l][last - 4])
  const clockPct: Record<string, number> = {}
  ops.clocks.forEach((c) => {
    clockPct[c.key] = (sumBy(lines, (l) => c.counts[l][0]) / sumBy(lines, (l) => c.counts[l][1])) * 100
  })
  return {
    inventoryNow,
    inventoryChange: ((inventoryNow - inventoryThen) / inventoryThen) * 100,
    clockPct,
    overturned: (sumBy(lines, (l) => ops.reconsiderations[l][0]) / sumBy(lines, (l) => ops.reconsiderations[l][1])) * 100,
    accuracy: (1 - sumBy(lines, (l) => ops.paymentAudit[l][0]) / sumBy(lines, (l) => ops.paymentAudit[l][1])) * 100,
  }
}

// ---------------------------------------------------------------- Figure scaffolding

/** Tracks an element's width so charts draw at their real size instead of scaling text. */
function useWidth<T extends HTMLElement>(fallback = 520): [(el: T | null) => void, number] {
  const [w, setW] = useState(fallback)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    if (!el) return
    if (el.clientWidth) setW(el.clientWidth)
    observer.current = new ResizeObserver(() => el.clientWidth && setW(el.clientWidth))
    observer.current.observe(el)
  }, [])
  return [ref, w]
}

interface Tip {
  x: number
  y: number
  lines: ReactNode[]
}

/** One hover/focus readout per chart. Values lead; labels follow. */
function useTip() {
  const [tip, setTip] = useState<Tip | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const at = (e: ReactPointerEvent | { clientX: number; clientY: number }, lines: ReactNode[]) => {
    const r = boxRef.current?.getBoundingClientRect()
    if (!r) return
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, lines })
  }
  const atEl = (el: Element, lines: ReactNode[]) => {
    const r = el.getBoundingClientRect()
    at({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, lines)
  }
  const node = tip && (
    <div className="in-tip" role="presentation" style={{ left: tip.x, top: tip.y }}>
      {tip.lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  )
  return { boxRef, at, atEl, clear: () => setTip(null), node }
}

/** Hover and keyboard focus on a mark show the same readout. */
function hit(tip: ReturnType<typeof useTip>, lines: ReactNode[], label: string) {
  return {
    tabIndex: 0,
    role: 'img' as const,
    'aria-label': label,
    onPointerMove: (e: ReactPointerEvent) => tip.at(e, lines),
    onPointerLeave: tip.clear,
    onFocus: (e: ReactFocusEvent<SVGElement>) => tip.atEl(e.currentTarget, lines),
    onBlur: tip.clear,
  }
}

function TableIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2.25" y="3" width="11.5" height="10" rx="1" /><path d="M2.25 6.5h11.5M2.25 10h11.5M6.5 6.5V13" /></svg>
}

/** A chart with its takeaway as the title, a table-view toggle and an optional drill-down. */
function Figure({ id, kicker, title, legend, table, children, drill, wide, className }: {
  id: string
  kicker: string
  title: string
  legend?: ReactNode
  table: ReactNode
  children: ReactNode
  drill?: ReactNode
  wide?: boolean
  className?: string
}) {
  const [showTable, setShowTable] = useState(false)
  return (
    <figure className={cx('in-fig', wide && 'in-fig--wide', className)} aria-labelledby={`${id}-t`}>
      <figcaption className="in-fig-cap">
        <div className="in-fig-titles">
          <span className="sub">{kicker}</span>
          <h2 id={`${id}-t`}>{title}</h2>
        </div>
        <button type="button" className="btn btn--ghost btn--xs in-table-btn" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
          <TableIcon />{showTable ? 'Chart' : 'Table'}
        </button>
      </figcaption>
      {!showTable && legend && <div className="in-legend">{legend}</div>}
      {showTable ? <div className="in-fig-table">{table}</div> : children}
      {drill && <div className="in-drill">{drill}</div>}
    </figure>
  )
}

// ---------------------------------------------------------------- Inventory (line)

/** Open inventory by product: % change since the first week, story series in blue, direct labels at line ends. */
function InventoryFigure({ ops, lines }: { ops: OpsData; lines: OpsLine[] }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const [hover, setHover] = useState<number | null>(null)
  const weeks = ops.weeks
  const change = (l: OpsLine, i: number) => (ops.inventory[l][i] / ops.inventory[l][0] - 1) * 100
  const lastI = weeks.length - 1
  const story = [...lines].sort((a, b) => change(b, lastI) - change(a, lastI))[0]
  const storyChange = change(story, lastI)

  const H = 214
  const padL = 44
  const labelW = 150
  const top = 10
  const bottom = 190
  const plotR = Math.max(padL + 120, W - labelW)
  const all = lines.flatMap((l) => weeks.map((_, i) => change(l, i)))
  let lo = Math.floor(Math.min(0, ...all) / 5) * 5
  let hi = Math.ceil(Math.max(0, ...all) / 5) * 5
  if (hi - lo < 10) {
    if (hi > 0) hi = lo + 10
    else lo = hi - 10
  }
  if (hi === lo + 10 && lo === 0) lo = -5
  const x = (i: number) => padL + (i / lastI) * (plotR - padL)
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * (bottom - top)
  const ticks: number[] = []
  for (let v = hi; v >= lo; v -= 5) ticks.push(v)
  const path = (l: OpsLine) => weeks.map((_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(change(l, i)).toFixed(1)}`).join(' ')
  const colour = (l: OpsLine) => (l === story ? C.accent : C.other)

  // End labels: keep at least 16px apart.
  const ends = lines.map((l) => ({ l, y: y(change(l, lastI)) })).sort((a, b) => a.y - b.y)
  ends.forEach((e, i) => { if (i && e.y - ends[i - 1].y < 16) e.y = ends[i - 1].y + 16 })

  const title = lines.length > 1
    ? `Growth is in ${LINE_NAMES[story].toLowerCase()}: ${storyChange >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(storyChange))}% since ${fmtDate(weeks[0])}`
    : `${LINE_NAMES[story]}: ${Math.round(storyChange) === 0 ? 'flat' : `${storyChange > 0 ? 'up' : 'down'} ${Math.abs(Math.round(storyChange))}%`} since ${fmtDate(weeks[0])}`
  const others = lines.filter((l) => l !== story)

  function onMove(e: ReactPointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.max(0, Math.min(lastI, Math.round(((e.clientX - r.left) / r.width) * lastI)))
    setHover(i)
    tip.at(e, readout(i))
  }
  const readout = (i: number) => [
    <span key="w" className="in-tip-head">Week to {fmtDate(weeks[i])}</span>,
    ...lines.map((l) => (
      <span key={l} className="in-tip-row"><span className="in-key" style={{ background: colour(l) }} /><strong>{n0(ops.inventory[l][i])}</strong> {LINE_NAMES[l]} · {signed(change(l, i))}</span>
    )),
    ...(lines.length > 1 ? [<span key="t" className="in-tip-row"><strong>{n0(sumBy(lines, (l) => ops.inventory[l][i]))}</strong> total</span>] : []),
  ]
  function onKey(e: ReactKeyboardEvent<SVGRectElement>) {
    const cur = hover ?? lastI
    const next = e.key === 'ArrowRight' ? Math.min(lastI, cur + 1) : e.key === 'ArrowLeft' ? Math.max(0, cur - 1) : null
    if (next === null) return
    e.preventDefault()
    setHover(next)
    const r = e.currentTarget.getBoundingClientRect()
    tip.at({ clientX: r.left + (next / lastI) * r.width, clientY: r.top + 20 }, readout(next))
  }

  const label = `Line chart of change in open claims since the week of ${fmtDate(weeks[0])}, by product. ${lines.map((l) => `${LINE_NAMES[l]} ${change(l, lastI) >= 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(change(l, lastI)))}% to ${n0(ops.inventory[l][lastI])}`).join('. ')}.`

  return (
    <Figure
      id="in-inv"
      kicker={`Open inventory by product, ${weeks.length} weeks · change since ${fmtDate(weeks[0])}`}
      title={title}
      legend={
        <>
          <span className="in-leg"><svg width="16" height="4" aria-hidden="true"><path d="M1 2h14" stroke={C.accent} strokeWidth="2" strokeLinecap="round" /></svg>{LINE_NAMES[story]}{story === 'di' ? ' (DI)' : ''}</span>
          {others.length > 0 && <span className="in-leg"><svg width="16" height="4" aria-hidden="true"><path d="M1 2h14" stroke={C.other} strokeWidth="2" strokeLinecap="round" /></svg>{joinAnd(others.map((l) => LINE_NAMES[l].toLowerCase())).replace(/^./, (s) => s.toUpperCase())}</span>}
          <span className="grow" />
          <span className="sub">Line ends: open claims today</span>
        </>
      }
      table={
        <table className="tbl in-tbl">
          <thead><tr><th scope="col">Week to</th>{lines.map((l) => <th key={l} scope="col" className="r">{LINE_NAMES[l]}</th>)}{lines.length > 1 && <th scope="col" className="r">Total</th>}</tr></thead>
          <tbody>
            {weeks.map((w, i) => (
              <tr key={w}><td>{fmtDate(w)}</td>{lines.map((l) => <td key={l} className="r">{n0(ops.inventory[l][i])}</td>)}{lines.length > 1 && <td className="r">{n0(sumBy(lines, (l) => ops.inventory[l][i]))}</td>}</tr>
            ))}
          </tbody>
        </table>
      }
    >
      <div ref={tip.boxRef} className="in-chart">
        <div ref={ref}>
          <svg width={W} height={H} role="img" aria-label={label} className="in-svg">
            {ticks.map((v) => (
              <g key={v}>
                <path d={`M${padL} ${Math.round(y(v)) + 0.5}H${plotR}`} className={v === 0 ? 'in-base' : 'in-grid'} />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="in-ax">{v > 0 ? `+${v}%` : v < 0 ? `−${-v}%` : '0%'}</text>
              </g>
            ))}
            {[0, 4, 8, 12].filter((i) => i <= lastI).map((i) => (
              <text key={i} x={x(i)} y={H - 5} textAnchor="middle" className="in-ax">{fmtDate(weeks[i])}</text>
            ))}
            {hover !== null && <path d={`M${x(hover)} ${top}V${bottom}`} className="in-cross" />}
            {others.map((l) => <path key={l} d={path(l)} fill="none" stroke={colour(l)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
            <path d={`${path(story)} L${x(lastI)} ${y(0)} L${x(0)} ${y(0)} Z`} fill={C.accent} fillOpacity="0.1" />
            <path d={path(story)} fill="none" stroke={C.accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {lines.map((l) => <circle key={l} cx={x(lastI)} cy={y(change(l, lastI))} r="5" fill={colour(l)} className="in-ring" />)}
            {hover !== null && lines.map((l) => <circle key={`h-${l}`} cx={x(hover)} cy={y(change(l, hover))} r="4" fill={colour(l)} className="in-ring" />)}
            {ends.map((e) => (
              <text key={e.l} x={plotR + 12} y={e.y + 4} className="in-lbl-sm">
                <tspan fontWeight="700" className="in-lbl">{l2short(e.l)}</tspan>
                <tspan dx="6" className="in-lbl-2">{n0(ops.inventory[e.l][lastI])}</tspan>
                <tspan dx="6" className="in-lbl-2">{signed(change(e.l, lastI))}</tspan>
              </text>
            ))}
            <rect
              x={padL - 12}
              y={top - 6}
              width={plotR - padL + 24}
              height={bottom - top + 12}
              fill="transparent"
              tabIndex={0}
              aria-label="Weekly values. Use left and right arrow keys to move between weeks."
              onPointerMove={onMove}
              onPointerLeave={() => { setHover(null); tip.clear() }}
              onFocus={(e) => { setHover(lastI); const r = e.currentTarget.getBoundingClientRect(); tip.at({ clientX: r.right - 10, clientY: r.top + 20 }, readout(lastI)) }}
              onBlur={() => { setHover(null); tip.clear() }}
              onKeyDown={onKey}
              className="in-hit"
            />
          </svg>
        </div>
        {tip.node}
      </div>
    </Figure>
  )
}

function l2short(l: OpsLine) {
  return l === 'di' ? 'DI' : LINE_NAMES[l]
}

// ---------------------------------------------------------------- Timeliness (deviation bars)

/** Each clock as points above or below the 98% target. */
function TimelinessFigure({ ops, lines }: { ops: OpsData; lines: OpsLine[] }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const rows = ops.clocks.map((c) => {
    const met = sumBy(lines, (l) => c.counts[l][0])
    const total = sumBy(lines, (l) => c.counts[l][1])
    const pct = (met / total) * 100
    return { ...c, met, total, pct, delta: pct - TARGET }
  })
  const below = rows.filter((r) => r.delta < 0)
  const title = below.length === 0
    ? `Every clock meets the ${TARGET}% target`
    : `${joinAnd(below.map((r, i) => (i ? CLOCK_SHORT[r.key].toLowerCase() : CLOCK_SHORT[r.key])))} ${below.length === 1 ? 'is' : 'are'} below target`

  const H = 212
  const labelW = Math.min(200, Math.max(170, W * 0.36))
  const statusW = 58
  const valueW = 56
  const plotL = labelW + 8
  const plotR = W - statusW - valueW - 8
  const mid = (plotL + plotR) / 2
  const span = Math.max(2, Math.ceil(Math.max(...rows.map((r) => Math.abs(r.delta)))))
  const sx = (d: number) => mid + (d / span) * ((plotR - plotL) / 2)
  const rowY = (i: number) => 14 + i * 32
  const ticks = [-span, -span / 2, 0, span / 2, span]
  const label = `Bar chart of work completed within its clock, shown as points above or below the ${TARGET}% target. ${rows.map((r) => `${r.label} ${pct1(r.pct)}, ${r.delta >= 0 ? 'meets' : 'below'} target`).join('. ')}.`

  return (
    <Figure
      id="in-time"
      kicker={`Timeliness by clock vs ${TARGET}% target, 13 weeks`}
      title={title}
      table={
        <table className="tbl in-tbl">
          <thead><tr><th scope="col">Clock</th><th scope="col" className="r">Within clock</th><th scope="col" className="r">vs target</th><th scope="col" className="r">Met / total</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}><td>{r.label}</td><td className="r">{pct1(r.pct)}</td><td className="r">{r.delta >= 0 ? '+' : '−'}{Math.abs(r.delta).toFixed(1)} pts</td><td className="r">{n0(r.met)} / {n0(r.total)}</td><td><Tag tone={r.delta >= 0 ? 'positive' : 'caution'}>{r.delta >= 0 ? 'Meets' : 'Below'}</Tag></td></tr>
            ))}
          </tbody>
        </table>
      }
      drill={<Link to="/team?view=atRisk">Claims at risk of breach on the team board</Link>}
    >
      <div ref={tip.boxRef} className="in-chart">
        <div ref={ref}>
          <svg width={W} height={H} role="img" aria-label={label} className="in-svg">
            {ticks.filter((t) => t !== 0).map((t) => <path key={t} d={`M${Math.round(sx(t)) + 0.5} 14V172`} className="in-grid" />)}
            {rows.map((r, i) => {
              const yy = rowY(i)
              const x0 = sx(0)
              const x1 = sx(Math.max(-span, Math.min(span, r.delta)))
              const w = Math.abs(x1 - x0)
              const rad = Math.min(4, w)
              const d = r.delta >= 0
                ? `M${x0} ${yy + 9} H${x1 - rad} A${rad} ${rad} 0 0 1 ${x1} ${yy + 9 + rad} V${yy + 23 - rad} A${rad} ${rad} 0 0 1 ${x1 - rad} ${yy + 23} H${x0} Z`
                : `M${x0} ${yy + 9} H${x1 + rad} A${rad} ${rad} 0 0 0 ${x1} ${yy + 9 + rad} V${yy + 23 - rad} A${rad} ${rad} 0 0 0 ${x1 + rad} ${yy + 23} H${x0} Z`
              const readout = [<span key="v"><strong>{pct1(r.pct)}</strong> {r.verb}</span>, <span key="l" className="in-tip-sub">{r.label} · {Math.abs(r.delta).toFixed(1)} points {r.delta >= 0 ? 'above' : 'below'} target</span>]
              return (
                <g key={r.key}>
                  <text x={0} y={yy + 20.5} className="in-lbl">{r.label}</text>
                  {w > 0.5 && <path d={d} fill={r.delta >= 0 ? C.above : C.below} />}
                  <text x={W - statusW - 8} y={yy + 20.5} textAnchor="end" className="in-val">{r.pct >= 99.95 ? '100%' : pct1(r.pct)}</text>
                  <g transform={`translate(${W - statusW + 2} ${yy + 12})`} className={r.delta >= 0 ? 'in-meets' : 'in-below'}>
                    {r.delta >= 0 ? <path d="M.5 5.2 3 7.6 7.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.8" /> : <path d="M4 1 8.4 8.8H-.4Z" fill="currentColor" />}
                    <text x={13} y={8.5} fill="currentColor" className="in-status">{r.delta >= 0 ? 'Meets' : 'Below'}</text>
                  </g>
                  <rect x={0} y={yy} width={W} height={32} fill="transparent" className="in-hit" {...hit(tip, readout, `${r.label}: ${pct1(r.pct)} ${r.verb}, ${r.delta >= 0 ? 'meets' : 'below'} target`)} />
                </g>
              )
            })}
            <path d={`M${mid} 13V172`} className="in-target" />
            <text x={mid} y={9} textAnchor="middle" className="in-lbl" fontWeight="700">{TARGET}% target</text>
            {ticks.map((t) => <text key={t} x={sx(t)} y={188} textAnchor="middle" className="in-ax">{t === 0 ? '0' : `${t > 0 ? '+' : '−'}${Math.abs(t)}`}</text>)}
            <text x={mid} y={206} textAnchor="middle" className="in-ax">Points below or above target</text>
          </svg>
        </div>
        {tip.node}
      </div>
    </Figure>
  )
}

// ---------------------------------------------------------------- Ageing (columns)

/** Claims awaiting a decision after proof of loss, by days waiting, against the typical 30-day limit. */
function AgeingFigure({ ops, lines }: { ops: OpsData; lines: OpsLine[] }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const counts = ops.ageing.buckets.map((_, i) => sumBy(lines, (l) => ops.ageing[l][i]))
  const total = counts.reduce((a, b) => a + b, 0)
  const past = counts.slice(2).reduce((a, b) => a + b, 0)
  const H = 214
  const padL = 48
  const base = 170
  const top = 16
  const maxV = Math.max(...counts)
  const step = maxV > 400 ? 200 : maxV > 200 ? 100 : 50
  const yMax = Math.ceil((maxV * 1.1) / step) * step
  const y = (v: number) => base - (v / yMax) * (base - top)
  const bw = (W - padL) / counts.length
  const barW = Math.min(28, bw * 0.4)
  const limitX = padL + bw * 2
  const yt: number[] = []
  for (let v = 0; v <= yMax; v += step) yt.push(v)
  const label = `Column chart of ${n0(total)} claims awaiting a decision after proof of loss was complete, by days waiting. ${ops.ageing.buckets.map((b, i) => `${b} days ${n0(counts[i])}`).join('. ')}. ${n0(past)} claims are past the typical 30-day state limit.`

  return (
    <Figure
      id="in-age"
      className="in-fig--rule"
      kicker="Claims awaiting decision by age, after proof of loss"
      title={`${n0(past)} claims are past the typical 30-day limit`}
      table={
        <table className="tbl in-tbl">
          <thead><tr><th scope="col">Days since proof of loss</th><th scope="col" className="r">Claims</th><th scope="col" className="r">Share</th></tr></thead>
          <tbody>
            {ops.ageing.buckets.map((b, i) => <tr key={b}><td>{b}{i >= 2 ? ' · past limit' : ''}</td><td className="r">{n0(counts[i])}</td><td className="r">{pct0((counts[i] / total) * 100)}</td></tr>)}
          </tbody>
          <tfoot><tr><td>Total</td><td className="r">{n0(total)}</td><td className="r">100%</td></tr></tfoot>
        </table>
      }
      drill={<Link to="/team?view=atRisk">Open at-risk claims on the team board</Link>}
    >
      <div ref={tip.boxRef} className="in-chart">
        <div ref={ref}>
          <svg width={W} height={H} role="img" aria-label={label} className="in-svg">
            {yt.map((v) => (
              <g key={v}>
                <path d={`M${padL} ${Math.round(y(v)) + 0.5}H${W}`} className={v === 0 ? 'in-base' : 'in-grid'} />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end" className="in-ax">{n0(v)}</text>
              </g>
            ))}
            {counts.map((c, i) => {
              const cx0 = padL + bw * i + bw / 2
              const h = base - y(c)
              const r = Math.min(4, h, barW / 2)
              const x0 = cx0 - barW / 2
              const d = h <= 0 ? '' : `M${x0} ${base} V${base - h + r} A${r} ${r} 0 0 1 ${x0 + r} ${base - h} H${x0 + barW - r} A${r} ${r} 0 0 1 ${x0 + barW} ${base - h + r} V${base} Z`
              const readout = [<span key="v"><strong>{n0(c)}</strong> claims · {pct0((c / total) * 100)} of those waiting</span>, <span key="l" className="in-tip-sub">{ops.ageing.buckets[i]} days since proof of loss</span>]
              return (
                <g key={i}>
                  {d && <path d={d} fill={i < 2 ? C.accentLight : C.accent} />}
                  <text x={cx0} y={base - h - 6} textAnchor="middle" className="in-val-sm">{n0(c)}</text>
                  <text x={cx0} y={189} textAnchor="middle" className="in-ax">{ops.ageing.buckets[i]}</text>
                  <rect x={padL + bw * i} y={8} width={bw} height={base - 2} fill="transparent" className="in-hit" {...hit(tip, readout, `${ops.ageing.buckets[i]} days: ${n0(c)} claims`)} />
                </g>
              )
            })}
            <path d={`M${limitX} 8V${base}`} className="in-target" />
            <text x={limitX + 8} y={28} className="in-lbl" fontWeight="700">Typical state limit · 30 days</text>
            <text x={limitX + 8} y={44} className="in-lbl-2">after proof of loss is complete</text>
            <path d={`M${limitX + 10} ${base - 42}V${base - 48}H${W - 6}V${base - 42}`} className="in-bracket" />
            <text x={(limitX + W) / 2} y={base - 55} textAnchor="middle" className="in-lbl-2"><tspan fontWeight="700" className="in-lbl">{n0(past)}</tspan> claims · {pct0((past / total) * 100)} of those waiting</text>
            <text x={(padL + W) / 2} y={208} textAnchor="middle" className="in-ax">Days since proof of loss was complete</text>
          </svg>
        </div>
        {tip.node}
      </div>
    </Figure>
  )
}

// ---------------------------------------------------------------- Outcomes (100% stacked bars)

/** Share of each product's decisions that were approved, withdrawn or denied. */
function OutcomesFigure({ ops, lines }: { ops: OpsData; lines: OpsLine[] }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const rows = ops.outcomes.filter((o) => lines.includes(o.family)).map((o) => {
    const total = o.approved + o.withdrawn + o.denied
    return { ...o, total, share: { approved: o.approved / total, withdrawn: o.withdrawn / total, denied: o.denied / total } }
  })
  const worst = [...rows].sort((a, b) => b.share.denied - a.share.denied)[0]
  const title = rows.length > 1
    ? `${worst.label} has the highest denial share: ${pct0(worst.share.denied * 100)}`
    : `${worst.label}: ${pct0(worst.share.denied * 100)} of decisions denied`
  const labelW = 148
  const noteW = 88
  const plotL = labelW
  const plotR = W - noteW
  const pw = plotR - plotL
  const H = 20 + rows.length * 40 + 10
  const segs = [
    { key: 'approved' as const, label: 'Approved', colour: C.accent },
    { key: 'withdrawn' as const, label: 'Withdrawn', colour: C.withdrawn },
    { key: 'denied' as const, label: 'Denied', colour: C.denied },
  ]
  const label = `Stacked bar chart of decision outcomes by product in the last 90 days. ${rows.map((r) => `${r.label}, ${n0(r.total)} decisions: ${segs.map((s) => `${pct0(r.share[s.key] * 100)} ${s.label.toLowerCase()}`).join(', ')}`).join('. ')}.`

  return (
    <Figure
      id="in-out"
      className="in-fig--rule"
      kicker="Outcomes by product, last 90 days"
      title={title}
      legend={
        <>
          {segs.map((s) => <span key={s.key} className="in-leg"><svg width="10" height="10" aria-hidden="true"><rect width="10" height="10" rx="2" fill={s.colour} /></svg>{s.label}</span>)}
          <span className="grow" />
          <span className="sub">Share of each product’s decisions</span>
        </>
      }
      table={
        <table className="tbl in-tbl">
          <thead><tr><th scope="col">Product</th><th scope="col" className="r">Decisions</th>{segs.map((s) => <th key={s.key} scope="col" className="r">{s.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="r">{n0(r.total)}</td>{segs.map((s) => <td key={s.key} className="r">{pct0(r.share[s.key] * 100)} ({n0(r[s.key])})</td>)}</tr>)}
          </tbody>
        </table>
      }
    >
      <div ref={tip.boxRef} className="in-chart">
        <div ref={ref}>
          <svg width={W} height={H} role="img" aria-label={label} className="in-svg">
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <g key={t}>
                <path d={`M${Math.round(plotL + t * pw) + 0.5} 2V${H - 30}`} className="in-grid" />
                <text x={plotL + t * pw} y={H - 12} textAnchor="middle" className="in-ax">{t * 100}%</text>
              </g>
            ))}
            {rows.map((r, i) => {
              const yy = 11 + i * 40
              let acc = plotL
              return (
                <g key={r.label}>
                  <text x={0} y={yy + 8} className="in-lbl" fontWeight="700" fontSize="13">{r.label}</text>
                  <text x={0} y={yy + 23} className="in-ax">{n0(r.total)} decisions</text>
                  {segs.map((s, si) => {
                    const w = r.share[s.key] * pw
                    const x0 = acc
                    acc += w
                    const gap = si < segs.length - 1 ? 2 : 0
                    const ww = Math.max(0.8, w - gap)
                    const last = si === segs.length - 1
                    const rad = last ? Math.min(4, ww / 2) : 0
                    const d = last
                      ? `M${x0} ${yy} H${x0 + ww - rad} A${rad} ${rad} 0 0 1 ${x0 + ww} ${yy + rad} V${yy + 18 - rad} A${rad} ${rad} 0 0 1 ${x0 + ww - rad} ${yy + 18} H${x0} Z`
                      : `M${x0} ${yy} H${x0 + ww} V${yy + 18} H${x0} Z`
                    const readout = [<span key="v"><strong>{pct0(r.share[s.key] * 100)}</strong> {s.label.toLowerCase()} · {n0(r[s.key])}</span>, <span key="l" className="in-tip-sub">{r.label} · {n0(r.total)} decisions</span>]
                    return <path key={s.key} d={d} fill={s.colour} className="in-hit" {...hit(tip, readout, `${r.label}: ${pct0(r.share[s.key] * 100)} ${s.label.toLowerCase()}, ${n0(r[s.key])} decisions`)} />
                  })}
                  <text x={plotR + 10} y={yy + 13.5} className="in-lbl-2"><tspan fontWeight="700" className="in-lbl">{pct0(r.share.denied * 100)}</tspan> denied</text>
                </g>
              )
            })}
          </svg>
        </div>
        {tip.node}
      </div>
    </Figure>
  )
}

// ---------------------------------------------------------------- Fast track (bars)

/** Share of new claims routed to fast track, and how much sooner they are decided. */
function FastTrackFigure({ ops, lines }: { ops: OpsData; lines: OpsLine[] }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const tip = useTip()
  const rows = lines.map((l) => {
    const f = ops.fastTrack[l]
    return { l, ...f, share: f.fastTracked / f.newClaims }
  })
  const newClaims = rows.reduce((a, r) => a + r.newClaims, 0)
  const fast = rows.reduce((a, r) => a + r.fastTracked, 0)
  const share = fast / newClaims
  const days = lines.length > 1 ? ops.fastTrack.all : rows[0]
  const title = `${pct0(share * 100)} of new claims went fast track, decided in a median ${days.fastDays} days instead of ${days.standardDays}`
  const labelW = 150
  const noteW = Math.min(300, W * 0.42)
  const plotL = labelW
  const plotR = W - noteW
  const pw = plotR - plotL
  const H = 12 + rows.length * 30 + 22
  const label = `Bar chart of the share of new claims routed to fast track in 13 weeks. ${rows.map((r) => `${LINE_NAMES[r.l]} ${pct0(r.share * 100)} of ${n0(r.newClaims)}, decided in ${r.fastDays} days versus ${r.standardDays} on the standard path`).join('. ')}.`

  return (
    <Figure
      id="in-ft"
      wide
      className="in-fig--rule"
      kicker="Fast-track rate by product, 13 weeks · rules route clean, low-risk claims"
      title={title}
      table={
        <table className="tbl in-tbl">
          <thead><tr><th scope="col">Product</th><th scope="col" className="r">New claims</th><th scope="col" className="r">Fast-tracked</th><th scope="col" className="r">Rate</th><th scope="col" className="r">Median days, fast track</th><th scope="col" className="r">Median days, standard</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.l}><td>{LINE_NAMES[r.l]}</td><td className="r">{n0(r.newClaims)}</td><td className="r">{n0(r.fastTracked)}</td><td className="r">{pct0(r.share * 100)}</td><td className="r">{r.fastDays}</td><td className="r">{r.standardDays}</td></tr>)}
          </tbody>
        </table>
      }
      drill={<Link to="/work">Fast-track claims ready to decide in My work</Link>}
    >
      <div ref={tip.boxRef} className="in-chart">
        <div ref={ref}>
          <svg width={W} height={H} role="img" aria-label={label} className="in-svg">
            {[0, 0.25, 0.5].map((t) => (
              <g key={t}>
                <path d={`M${Math.round(plotL + (t / 0.5) * pw) + 0.5} 4V${H - 20}`} className={t === 0 ? 'in-base' : 'in-grid'} />
                <text x={plotL + (t / 0.5) * pw} y={H - 5} textAnchor="middle" className="in-ax">{t * 100}%</text>
              </g>
            ))}
            {rows.map((r, i) => {
              const yy = 8 + i * 30
              const w = (Math.min(0.5, r.share) / 0.5) * pw
              const rad = Math.min(4, w / 2)
              const d = `M${plotL} ${yy} H${plotL + w - rad} A${rad} ${rad} 0 0 1 ${plotL + w} ${yy + rad} V${yy + 16 - rad} A${rad} ${rad} 0 0 1 ${plotL + w - rad} ${yy + 16} H${plotL} Z`
              const readout = [<span key="v"><strong>{pct0(r.share * 100)}</strong> fast-tracked · {n0(r.fastTracked)} of {n0(r.newClaims)}</span>, <span key="l" className="in-tip-sub">{LINE_NAMES[r.l]} · {r.fastDays} days vs {r.standardDays} standard</span>]
              return (
                <g key={r.l}>
                  <text x={0} y={yy + 12.5} className="in-lbl" fontWeight="700">{LINE_NAMES[r.l]}</text>
                  <path d={d} fill={C.accent} className="in-hit" {...hit(tip, readout, `${LINE_NAMES[r.l]}: ${pct0(r.share * 100)} fast-tracked`)} />
                  <text x={plotL + w + 8} y={yy + 12.5} className="in-lbl" fontWeight="700">{pct0(r.share * 100)}</text>
                  <text x={plotR + 16} y={yy + 12.5} className="in-lbl-2">decided in <tspan fontWeight="700" className="in-lbl">{r.fastDays} days</tspan> vs {r.standardDays} standard</text>
                </g>
              )
            })}
          </svg>
        </div>
        {tip.node}
      </div>
    </Figure>
  )
}

// ---------------------------------------------------------------- Needs leadership attention

/** Items shown when a threshold is crossed, filtered to the selected products. */
function Attention({ ops, lines }: { ops: OpsData; lines: OpsLine[] }) {
  const toast = useToast()
  const items = ops.attention.filter((a) => a.lines.some((l) => lines.includes(l)))
  return (
    <section aria-labelledby="in-attn-h" className="in-rail">
      <div className="in-rail-head">
        <h2 id="in-attn-h">Needs leadership attention</h2>
        <span className="sub">{items.length} item{items.length === 1 ? '' : 's'}</span>
      </div>
      <ul className="in-attn">
        {items.map((a) => (
          <li key={a.id}>
            <div className="in-attn-top"><Tag tone={a.tone}>{a.tag}</Tag><span className="grow" /><span className="sub soft">{a.meta}</span></div>
            <span className="strong">{a.title}</span>
            <span className="in-attn-detail">{a.detail}</span>
            <div className="in-attn-owner">
              <Avatar initials={a.owner.initials} />
              <span style={{ fontWeight: 600 }}>{a.owner.name}</span>
              <span className="grow" />
              {a.to ? (
                <Link to={a.to} className="in-attn-link">{a.action}</Link>
              ) : (
                <button type="button" className="btn btn--ghost btn--xs" onClick={() => toast(`${a.title}: opens in the ${a.owner.name === 'Claims legal' ? 'legal matter system' : 'DI team’s board'}, outside this mock`)}>{a.action}</button>
              )}
            </div>
          </li>
        ))}
        {items.length === 0 && <li className="sub">Nothing crosses a threshold for this product.</li>}
      </ul>
      <p className="sub in-rail-foot">Shown when a threshold is crossed · <button type="button" className="in-linkbtn" onClick={() => toast('Thresholds are set in the configuration studio')}>Set thresholds</button></p>
    </section>
  )
}

// ---------------------------------------------------------------- Export

function exportCsv(ops: OpsData, lines: OpsLine[], product: ProductFilter) {
  const m = measures(ops, lines)
  const rows: (string | number)[][] = [
    ['Claims operations', `Product: ${product === 'all' ? 'All' : LINE_NAMES[product]}`, `Week to ${ops.weeks[ops.weeks.length - 1]}`],
    [],
    ['Measure', 'Value'],
    ['Open inventory', m.inventoryNow],
    ['Change vs 4 weeks ago %', m.inventoryChange.toFixed(1)],
    ...ops.clocks.map((c) => [`${c.label} % ${c.verb}`, m.clockPct[c.key].toFixed(1)]),
    ...lines.map((l) => [`Median days to decision · ${LINE_NAMES[l]}`, ops.medianDays[l]]),
    ['Reconsiderations overturned %', m.overturned.toFixed(1)],
    ['Payment accuracy %', m.accuracy.toFixed(1)],
    [],
    ['Week to', ...lines.map((l) => LINE_NAMES[l])],
    ...ops.weeks.map((w, i) => [w, ...lines.map((l) => ops.inventory[l][i])]),
  ]
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `claims-operations-${product}-${ops.weeks[ops.weeks.length - 1]}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

