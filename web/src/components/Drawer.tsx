import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

/** Letters, notes and call logs open as drawers over the claim — never a new page. */
export function Drawer({ title, onClose, children, footer, width }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [onClose])
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div ref={ref} className="drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={width ? { width } : undefined}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <span className="grow" />
          <button type="button" data-close className="btn btn--quiet btn--sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  )
}
