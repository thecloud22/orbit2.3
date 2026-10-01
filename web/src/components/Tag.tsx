import type { ReactNode } from 'react'
import type { Status, Tone } from '../api/types'

/** The shape that goes with each tone — status is never colour alone. */
export function ToneShape({ tone, size = 10 }: { tone: Tone; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 10 10', 'aria-hidden': true } as const
  switch (tone) {
    case 'positive':
      return <svg {...common}><path d="M1.5 5.2 4 7.6 8.6 2.4" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
    case 'caution':
      return <svg {...common}><path d="M5 1 9.4 8.8H.6Z" fill="currentColor" /></svg>
    case 'critical':
      return <svg {...common}><rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1" fill="currentColor" /></svg>
    case 'special':
      return <svg {...common}><path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="currentColor" /></svg>
    case 'info':
      return <svg {...common}><circle cx="5" cy="5" r="3.5" fill="currentColor" /></svg>
    case 'neutral':
      return <svg {...common}><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    default:
      return null
  }
}

export function Tag({ tone = 'plain', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`tag tag--${tone}`} title={title}>
      <ToneShape tone={tone} />
      {children}
    </span>
  )
}

export function StatusTag({ status }: { status: Status }) {
  return <Tag tone={status.tone}>{status.label}</Tag>
}
