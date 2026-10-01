import { useEffect, useRef, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ToneShape } from '../components/Tag'
import { cx } from '../lib/cx'
import type { Tone } from '../api/types'

/** Portal icons, drawn on the phone boards' 20px grid. */
const PATHS: Record<string, ReactNode> = {
  home: <><path d="M3.25 9 10 3.5 16.75 9" /><path d="M5 7.75v8.75h3.75v-4.75h2.5v4.75H15V7.75" /></>,
  tasks: <><path d="M7.25 4H5v12.75h10V4h-2.25" /><path d="M7.25 2.75h5.5V5.5h-5.5z" /><path d="M7.25 11l1.9 1.9 3.6-3.8" /></>,
  payments: <><rect x="2.5" y="5" width="15" height="10" rx="1.25" /><circle cx="10" cy="10" r="2.25" /></>,
  messages: <path d="M3 4.25h14v9.5H8.25L5 16.5v-2.75H3z" />,
  arrowRight: <path d="M3.75 10h11.5M10.75 5.5 15.25 10l-4.5 4.5" />,
  arrowLeft: <path d="M16.25 10H4.75M9.25 5.5 4.75 10l4.5 4.5" />,
  chevronRight: <path d="M7.5 4.5 13 10l-5.5 5.5" />,
  chevronLeft: <path d="M12.5 4.5 7 10l5.5 5.5" />,
  check: <path d="M4.5 10.25 8.25 14 15.5 6.5" />,
  upload: <><path d="M10 13V3.5M6 7.5l4-4 4 4" /><path d="M3.5 12.5v4h13v-4" /></>,
  phone: <path d="M5.5 3 7.5 7 6 8.75a10 10 0 0 0 5.25 5.25L13 12.5l4 2-.6 2.5C8.9 17.6 2.4 11.1 3 3.6z" />,
  doc: <><path d="M4.5 2.5h7.25L15.5 6.25V17.5h-11z" /><path d="M11.5 2.5v4h4" /><path d="M7.5 10.5h5M7.5 13.5h5" /></>,
  info: <><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5" /><path d="M10 6.25v.1" /></>,
  close: <path d="M5 5l10 10M15 5 5 15" />,
  camera: <><path d="M2.75 6.25h3l1.5-2h5.5l1.5 2h3v10h-14.5z" /><circle cx="10" cy="11" r="3" /></>,
  lock: <><rect x="4.5" y="8.5" width="11" height="8.5" rx="1.25" /><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5" /></>,
  search: <><circle cx="8.75" cy="8.75" r="5.25" /><path d="M12.75 12.75 17 17" /></>,
  user: <><circle cx="10" cy="7" r="3.25" /><path d="M3.75 17c.75-3.25 3.2-5 6.25-5s5.5 1.75 6.25 5" /></>,
  plus: <path d="M10 4v12M4 10h12" />,
}

export function PtIcon({ name, size = 20, strokeWidth = 1.5 }: { name: string; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {PATHS[name]}
    </svg>
  )
}

/** The "[Carrier]" wordmark — the only place Newsreader is used. */
export function Wordmark({ to }: { to: string }) {
  return (
    <Link to={to} className="pt-wordmark" aria-label="[Carrier] home">
      [Carrier]
    </Link>
  )
}

/** Phone top bar: wordmark and the account button, or a custom right-hand slot. */
export function TopBar({ home, account, right }: { home: string; account?: string; right?: ReactNode }) {
  return (
    <header className="pt-top">
      <Wordmark to={home} />
      {right ??
        (account && (
          <button type="button" className="pt-iconbtn" aria-label={`Account and settings for ${account}`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9.25" />
              <circle cx="12" cy="9.75" r="3.25" />
              <path d="M6.4 18.4c1.3-2 3.3-3.15 5.6-3.15s4.3 1.15 5.6 3.15" />
            </svg>
          </button>
        ))}
    </header>
  )
}

/** Bottom tab bar: Home, Tasks, Payments, Messages. Tasks carries a count badge. */
export function TabBar({ base, taskCount = 0 }: { base: string; taskCount?: number }) {
  const { pathname } = useLocation()
  const tabs = [
    { key: 'home', label: 'Home', to: base, active: pathname === base || pathname === `${base}/` },
    { key: 'tasks', label: 'Tasks', to: `${base}/tasks`, active: pathname.startsWith(`${base}/tasks`) },
    { key: 'payments', label: 'Payments', to: `${base}/payments`, active: pathname.startsWith(`${base}/payments`) },
    { key: 'messages', label: 'Messages', to: `${base}/messages`, active: pathname.startsWith(`${base}/messages`) },
  ]
  return (
    <nav className="pt-tabs" aria-label="Portal">
      {tabs.map((t) => (
        <Link
          key={t.key}
          to={t.to}
          className={cx('pt-tab', t.active && 'pt-tab--on')}
          aria-current={t.active ? 'page' : undefined}
          aria-label={t.key === 'tasks' && taskCount ? `Tasks, ${taskCount} to do` : undefined}
        >
          <span className="pt-tab-icon">
            <PtIcon name={t.key} />
            {t.key === 'tasks' && taskCount > 0 && (
              <span className="pt-badge" aria-hidden="true">
                {taskCount}
              </span>
            )}
          </span>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/** Phone app chrome for a signed-in person: top bar, scrolling main, bottom tabs. */
export function PhoneApp({ base, account, taskCount, children }: { base: string; account: string; taskCount?: number; children: ReactNode }) {
  return (
    <>
      <TopBar home={base} account={account} />
      <ScrollMain>{children}</ScrollMain>
      <TabBar base={base} taskCount={taskCount} />
    </>
  )
}

/** Scrolling content area that returns to the top on every route change. */
export function ScrollMain({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 })
  }, [pathname])
  return (
    <main ref={ref} className={cx('pt-main', className)}>
      {children}
    </main>
  )
}

export interface TrackStep {
  label: string
  state: 'done' | 'current' | 'todo'
  /** Right-aligned short value, e.g. a date. */
  meta?: string
  detail?: string
}

function TrackMark({ state }: { state: TrackStep['state'] }) {
  if (state === 'done')
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" role="img" aria-label="Done">
        <circle cx="10" cy="10" r="10" fill="#45494F" />
        <path d="M5.75 10.25 8.5 13 14.25 7" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  if (state === 'current')
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" role="img" aria-label="Happening now">
        <circle cx="10" cy="10" r="8.75" fill="#FDFCFA" stroke="#1F4E8C" strokeWidth="2.5" />
        <circle cx="10" cy="10" r="3.75" fill="#1F4E8C" />
      </svg>
    )
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" role="img" aria-label="Not started">
      <circle cx="10" cy="10" r="8.75" fill="#FDFCFA" stroke="#8E9197" strokeWidth="1.5" />
    </svg>
  )
}

/** Vertical claim tracker — where the claim is, in plain words. */
export function Tracker({ steps, label = 'Where your claim is' }: { steps: TrackStep[]; label?: string }) {
  return (
    <ol className="pt-track" aria-label={label}>
      {steps.map((s, i) => (
        <li key={s.label} className={cx('pt-track-step', `pt-track-step--${s.state}`)} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className="pt-track-rail">
            <TrackMark state={s.state} />
            {i < steps.length - 1 && <span aria-hidden="true" className={cx('pt-track-line', s.state === 'done' && 'pt-track-line--done')} />}
          </span>
          <div className={cx('pt-track-body', !s.detail && 'pt-track-body--row')}>
            <span className="pt-track-label">{s.label}</span>
            {s.meta && <span className="pt-soft">{s.meta}</span>}
            {s.detail && <span className={s.state === 'current' ? undefined : 'pt-soft'}>{s.detail}</span>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/** Status chip sized for the phone — shape + word + tint. */
export function PtTag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pt-tag pt-tag--${tone}`}>
      <ToneShape tone={tone} size={11} />
      {children}
    </span>
  )
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="pt-back">
      <PtIcon name="chevronLeft" />
      {label}
    </Link>
  )
}

/** Bottom sheet inside the phone frame, for short forms and confirmations. */
export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('input, textarea, select, button:not(.pt-sheet-close)')
    ;(first ?? el)?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="pt-sheet-wrap">
      <div className="pt-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="pt-sheet" role="dialog" aria-modal="true" aria-labelledby="pt-sheet-title" tabIndex={-1}>
        <div className="pt-sheet-head">
          <h2 id="pt-sheet-title">{title}</h2>
          <button type="button" className="pt-iconbtn pt-sheet-close" aria-label="Close" onClick={onClose}>
            <PtIcon name="close" />
          </button>
        </div>
        <div className="pt-sheet-body">{children}</div>
        {footer && <div className="pt-sheet-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** A plain-language confirmation: what happened and what happens next. */
export function Done({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="pt-done" role="status">
      <span className="pt-done-mark" aria-hidden="true">
        <PtIcon name="check" size={20} strokeWidth={2} />
      </span>
      <div className="pt-stack-4">
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  )
}

/** "Your case manager" row with Call and Message. */
export function ContactRow({ initials, role, name, messagesTo, phone = '+15550102000' }: { initials: string; role: string; name: string; messagesTo: string; phone?: string }) {
  return (
    <section className="pt-contact" aria-label={role}>
      <span className="pt-avatar" aria-hidden="true">
        {initials}
      </span>
      <div className="pt-contact-who">
        <h2>{role}</h2>
        <span className="pt-strong">{name}</span>
      </div>
      <a href={`tel:${phone}`} className="pt-btn pt-btn--sm">
        Call
      </a>
      <Link to={messagesTo} className="pt-btn pt-btn--sm">
        Message
      </Link>
    </section>
  )
}

/** Label/amount rows for a payment breakdown. */
export function MoneyRows({ rows, total }: { rows: { label: string; value: string }[]; total?: { label: string; value: string } }) {
  return (
    <dl className="pt-money">
      {rows.map((r) => (
        <div key={r.label} className="pt-money-row">
          <dt>{r.label}</dt>
          <dd className="pt-num">{r.value}</dd>
        </div>
      ))}
      {total && (
        <div className="pt-money-row pt-money-row--total">
          <dt>{total.label}</dt>
          <dd className="pt-num">{total.value}</dd>
        </div>
      )}
    </dl>
  )
}

/** Skeleton lines while a portal query loads. */
export function PtLoading() {
  return (
    <div className="pt-stack-8" aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ height: 28, width: '50%' }} />
      <div className="skeleton" style={{ height: 120 }} />
      <div className="skeleton" style={{ height: 80 }} />
    </div>
  )
}
