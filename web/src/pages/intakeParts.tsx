import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Tone, User } from '../api/types'
import { cx } from '../lib/cx'
import { Tag, ToneShape } from '../components/Tag'
import { Icon } from '../components/Icon'
import { fmtElapsed, type CallClock, type CallInfo, type CallState } from './intakeCall'

/*
 * Parts shared by the phone intakes (disability, life): the call bar, the step marks and the form helpers.
 */

const TRANSFER_TO = ['DI claims · Team 1', 'Life & annuity claims', 'Spanish-language line', 'Supervisor']

// ---------------------------------------------------------------- Call bar

/** The live call: timer, number, verification, language, recording, and call controls. */
export function CallBar({ call, user, clock, state, caller, onHold, onTransfer, onEnd, transferTo = TRANSFER_TO }: {
  call: CallInfo
  user: User
  clock: CallClock
  state: CallState
  caller: { tone: Tone; label: string; detail?: string }
  onHold: () => void
  onTransfer: (to: string) => void
  onEnd: () => void
  transferTo?: string[]
}) {
  const [secs, setSecs] = useState(call.elapsed)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state === 'ended') {
      setSecs(clock.elapsed())
      return
    }
    const t = setInterval(() => setSecs(clock.elapsed()), 1000)
    return () => clearInterval(t)
  }, [state, clock])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  return (
    <div className={cx('ik-call', state === 'hold' && 'ik-call--hold', state === 'ended' && 'ik-call--ended')} role="region" aria-label="Call">
      <span className="ik-call-state">
        <Icon name="phone" size={15} />
        <strong>{state === 'hold' ? 'On hold' : state === 'ended' ? 'Call ended' : 'On call'}</strong>
        <span className="mono ik-call-timer" aria-label={`Call time ${fmtElapsed(secs)}`}>{fmtElapsed(secs)}</span>
      </span>
      <span className="ik-call-sep" aria-hidden="true" />
      <span className="nowrap">Inbound <span className="mono">{call.inbound}</span></span>
      <span className="ik-call-sep" aria-hidden="true" />
      <Tag tone={caller.tone}>{caller.label}{caller.detail && <span className="ik-call-detail">{caller.detail}</span>}</Tag>
      <span className="ik-call-sep" aria-hidden="true" />
      <span>{call.language}</span>
      <span className="ik-call-sep" aria-hidden="true" />
      <span className="ik-rec nowrap"><span aria-hidden="true" className="ik-rec-dot" />Recording {state === 'ended' ? 'saved' : 'on'}</span>
      <span className="grow" />
      <span className="ik-call-who nowrap" title={user.title}>Intake · <strong>{user.name}</strong></span>
      <button type="button" className="btn btn--sm" onClick={onHold} disabled={state === 'ended'} aria-pressed={state === 'hold'}>
        {state === 'hold' ? 'Resume' : <><span aria-hidden="true" className="ik-pause" />Hold</>}
      </button>
      <div className="ik-menu-wrap" ref={menuRef}>
        <button type="button" className="btn btn--sm" onClick={() => setMenu((m) => !m)} disabled={state === 'ended'} aria-expanded={menu} aria-haspopup="menu">
          <Icon name="split" size={13} />Transfer
        </button>
        {menu && (
          <div className="menu ik-menu" role="menu">
            <span className="menu-label">Warm transfer to</span>
            {transferTo.map((t) => (
              <button key={t} type="button" role="menuitem" className="menu-item" onClick={() => { setMenu(false); onTransfer(t) }}>{t}</button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="btn btn--sm" onClick={onEnd} disabled={state === 'ended'}>
        <Icon name="phone" size={13} />{state === 'ended' ? 'Wrapped up' : 'End & wrap up'}
      </button>
    </div>
  )
}

export function StepMark({ state, n }: { state: 'done' | 'current' | 'attention' | 'todo'; n: number }) {
  if (state === 'done')
    return <svg className="ik-step-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="9" fill="#45494F" /><path d="M5.2 9.2 7.8 11.6 12.8 6.4" fill="none" stroke="#FFFFFF" strokeWidth="1.8" /></svg>
  if (state === 'current')
    return <svg className="ik-step-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="8" fill="#FFFFFF" stroke="#1F4E8C" strokeWidth="2" /><circle cx="9" cy="9" r="3.5" fill="#1F4E8C" /></svg>
  if (state === 'attention')
    return <span className="ik-step-mark ik-step-mark--attention" aria-hidden="true"><ToneShape tone="caution" size={11} /></span>
  return <span className="ik-step-mark ik-step-mark--num" aria-hidden="true">{n}</span>
}

/** A radio group drawn as cards. */
export function Choice<T extends string>({ legend, name, value, options, onChange, hint, vertical }: {
  legend: string
  name: string
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  hint?: ReactNode
  vertical?: boolean
}) {
  return (
    <fieldset className="ik-fieldset">
      <legend className="ik-legend">{legend}</legend>
      <div className={cx('radio-cards', vertical && 'ik-cards-v')}>
        {options.map((o) => (
          <label key={o.value} className="radio-card">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      {hint && <p className="ik-hint">{hint}</p>}
    </fieldset>
  )
}

export function Field({ id, label, aside, hint, children, className }: { id: string; label: string; aside?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('field ik-field', className)}>
      <div className="ik-label-row">
        <label htmlFor={id}>{label}</label>
        {aside && <span className="ik-hint">{aside}</span>}
      </div>
      {children}
      {hint && <p className="ik-hint">{hint}</p>}
    </div>
  )
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="ik-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  )
}

/** A scripted line for the intake person to read. */
export function Say({ children, verb = 'Say' }: { children: ReactNode; verb?: string }) {
  return (
    <div className="ik-say">
      <Icon name="message" size={16} />
      <p><strong>{verb}:</strong> {children}</p>
    </div>
  )
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="ik-section" aria-label={title}>
      <div className="ik-section-head">
        <h3>{title}</h3>
        {aside && <span className="ik-hint">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

/** Mock-only shortcut so the walkthrough doesn't need typing. */
export function SampleButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="btn btn--quiet btn--xs ik-sample" onClick={onClick}>
      <Icon name="pencil" size={12} />Fill sample answers <span className="ik-sample-tag">mock</span>
    </button>
  )
}
