import type { ReactNode } from 'react'

/** Stroke icons drawn on a 16px grid, matching the canvas. */
const PATHS: Record<string, ReactNode> = {
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3.5 3.5" /></>,
  bell: <><path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.25 1.25H2.75z" /><path d="M6.5 14.25h3" /></>,
  help: <><circle cx="8" cy="8" r="6.25" /><path d="M6.25 6.25a1.8 1.8 0 1 1 2.4 1.7c-.45.2-.65.5-.65 1v.4" /><path d="M8 11.4v.1" /></>,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  chevronRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  chevronLeft: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  arrowRight: <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
  queue: <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />,
  overview: <><rect x="2.5" y="2.5" width="4.5" height="4.5" /><rect x="9" y="2.5" width="4.5" height="4.5" /><rect x="2.5" y="9" width="4.5" height="4.5" /><rect x="9" y="9" width="4.5" height="4.5" /></>,
  shield: <path d="M8 1.75l5 2v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z" />,
  people: <><circle cx="6" cy="5.5" r="2.25" /><path d="M2 13c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5" /><path d="M10.5 3.5a2.2 2.2 0 0 1 0 4.2M11.5 9.6c1.4.3 2.3 1.4 2.6 3.4" /></>,
  checklist: <><path d="M6.5 4h7M6.5 8h7M6.5 12h7" /><path d="M2.25 4l1 1 1.6-2M2.25 8l1 1 1.6-2" /><circle cx="3.5" cy="12" r="1" /></>,
  document: <><path d="M3.5 1.75h6l3 3v9.5h-9z" /><path d="M9.5 1.75v3h3" /></>,
  pulse: <path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4" />,
  medical: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M8 5.25v5.5M5.25 8h5.5" /></>,
  chart: <><path d="M2.5 13.5h11" /><path d="M4.5 11V8M8 11V4.5M11.5 11V6.5" /></>,
  decision: <><circle cx="8" cy="8" r="6.25" /><path d="M5.25 8.2l1.9 1.9 3.6-3.9" /></>,
  payments: <><rect x="1.75" y="4" width="12.5" height="8" rx="1" /><circle cx="8" cy="8" r="1.75" /></>,
  split: <><path d="M8 2v4M8 6 4 10v4M8 6l4 4v4" /></>,
  flow: <><circle cx="3.5" cy="4" r="1.75" /><circle cx="12.5" cy="4" r="1.75" /><circle cx="8" cy="12.25" r="1.75" /><path d="M5.25 4h5.5M4.4 5.6l2.7 5M11.6 5.6l-2.7 5" /></>,
  plan: <><path d="M2.5 3.5h11M2.5 8h7M2.5 12.5h9" /><circle cx="12.5" cy="8" r="1.25" /></>,
  message: <path d="M2 3.25h12v8.25H6.5L3.5 14v-2.5H2z" />,
  tasks: <><rect x="3" y="2.75" width="10" height="11.5" rx="1" /><path d="M6 2.75h4v1.5H6z" /><path d="M5.5 9l1.7 1.7 3.3-3.4" /></>,
  history: <><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.25 2.5v2.25h2.25" /><path d="M8 5v3.25l2.25 1.5" /></>,
  phone: <path d="M4.5 2.5 6 5.5 4.75 7a8 8 0 0 0 4.25 4.25L10.5 10l3 1.5-.5 2c-6 .5-11-4.5-10.5-10.5z" />,
  pencil: <path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z" />,
  filter: <path d="M2 4h12M4.5 8h7M7 12h2" />,
  collapse: <path d="M6 3.5 10.5 8 6 12.5" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  upload: <><path d="M8 10.5V2.75M4.75 6 8 2.75 11.25 6" /><path d="M2.75 10v3.25h10.5V10" /></>,
  send: <path d="M2.5 8 13.5 2.5 10 13.5 7.5 8.5z" />,
  external: <><path d="M9 2.5h4.5V7" /><path d="M13.5 2.5 7 9" /><path d="M11.5 9.5v4h-9v-9h4" /></>,
  user: <><circle cx="8" cy="5.5" r="2.75" /><path d="M2.75 14c.6-2.8 2.7-4.25 5.25-4.25S12.65 11.2 13.25 14" /></>,
  team: <><circle cx="5.5" cy="6" r="2" /><circle cx="10.5" cy="6" r="2" /><path d="M1.75 13c.35-2 1.8-3.25 3.75-3.25S8.9 11 9.25 13M8.5 10.1c.6-.25 1.25-.35 2-.35 1.95 0 3.4 1.25 3.75 3.25" /></>,
  insights: <><path d="M2.5 13.5h11" /><path d="M3.5 10.5 6.5 7l2.5 2.5 4-5" /></>,
  intake: <><path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25" /><path d="M2.75 11v2.25h10.5V11" /></>,
  sparkle: <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M4.2 11.8l1.6-1.6M10.2 5.8l1.6-1.6" />,
  undo: <><path d="M5 5.5H10a3.25 3.25 0 0 1 0 6.5H6" /><path d="M7 3 4.5 5.5 7 8" /></>,
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, color = 'currentColor', strokeWidth = 1.5, label }: {
  name: IconName | string
  size?: number
  color?: string
  strokeWidth?: number
  label?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ flexShrink: 0 }}
    >
      {PATHS[name] ?? null}
    </svg>
  )
}

/** The Claims product mark. */
export function ClaimsMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M4.5 2.75h9l4 4v12.5h-13z" stroke="#ECEAE4" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M13.5 2.75v4h4" stroke="#ECEAE4" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8 11.5h6M8 14.75h4" stroke="#8FB0DC" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
