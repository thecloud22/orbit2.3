import type { ReactNode } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { cx } from '../lib/cx'
import { ElenaApp } from './Elena'
import { PriyaApp } from './Priya'
import { MargaretApp } from './Margaret'
import { ClaireApp } from './Claire'
import { NewApp } from './NewClaim'
import { AgentPortal } from './Agent'
import './portal.css'

const PERSONAS = [
  { key: 'elena', name: 'Elena Vasquez', role: 'DI claimant', tip: 'Upload her 2024 tax return and P&L, then open D-26-073390 → Requirements in the staff app.' },
  { key: 'priya', name: 'Priya Raman', role: 'DI claimant, payments', tip: 'Tell us she’s going back sooner or needs more time — it lands on Jordan’s claim.' },
  { key: 'margaret', name: 'Margaret Pierce', role: 'Life beneficiary', tip: 'Record Rachel’s decision on L-26-040112 in the staff app and this screen shows the approval.' },
  { key: 'claire', name: 'Claire Hart-Lopez', role: 'Annuity beneficiary', tip: 'Send her claimant statement and W-9, then choose how to receive her share.' },
  { key: 'new', name: 'Someone new', role: 'File a claim or report a death', tip: 'Short flows that end in a confirmation. Nothing is saved.' },
  { key: 'agent', name: 'Paul Hendricks', role: 'Agent of record · desktop', tip: 'Status and what’s needed only, for clients who consented. Never medical detail.' },
]

/** The external portal at /portal: a phone-sized app on a demo stage, plus the agent's desktop portal. */
export function Portal() {
  return (
    <Routes>
      <Route index element={<Navigate to="elena" replace />} />
      <Route path="elena/*" element={<Stage><ElenaApp /></Stage>} />
      <Route path="priya/*" element={<Stage><PriyaApp /></Stage>} />
      <Route path="margaret/*" element={<Stage><MargaretApp /></Stage>} />
      <Route path="claire/*" element={<Stage><ClaireApp /></Stage>} />
      <Route path="new/*" element={<Stage><NewApp /></Stage>} />
      <Route path="agent" element={<Stage wide><AgentPortal /></Stage>} />
      <Route path="*" element={<Navigate to="elena" replace />} />
    </Routes>
  )
}

/** Neutral backdrop with the app in a 390×844 phone frame (or full width for the agent), and the demo switcher. */
function Stage({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx('pt-stage', wide && 'pt-stage--wide')}>
      {wide ? (
        <>
          <DemoSwitcher bar />
          <div className="pt-wide">{children}</div>
        </>
      ) : (
        <>
          <div className="pt-frame">{children}</div>
          <DemoSwitcher />
        </>
      )}
    </div>
  )
}

/** "Demo: view as" — switch between portal personas, and back to the staff app. */
function DemoSwitcher({ bar = false }: { bar?: boolean }) {
  const { pathname } = useLocation()
  const current = pathname.split('/')[2] ?? ''
  const tip = PERSONAS.find((p) => p.key === current)?.tip
  return (
    <aside className={cx('pt-demo', bar && 'pt-demo--bar')} aria-label="Demo controls">
      <Link to="/work" className="pt-demo-back">
        ← Back to staff app
      </Link>
      <h2 className="pt-demo-h">Demo: view as</h2>
      <ul className="pt-demo-list">
        {PERSONAS.map((p) => (
          <li key={p.key}>
            <Link to={`/portal/${p.key}`} className={cx('pt-demo-item', current === p.key && 'pt-demo-item--on')} title={p.role} aria-current={current === p.key ? 'true' : undefined}>
              <span className="pt-demo-name">{p.name}</span>
              <span className="pt-demo-role">{p.role}</span>
            </Link>
          </li>
        ))}
      </ul>
      {tip && !bar && <p className="pt-demo-tip">{tip}</p>}
    </aside>
  )
}
