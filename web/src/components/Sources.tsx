/** Source chips: every summary, suggestion and decision links to the evidence it rests on. */
export function Sources({ items, max = 3, onOpen }: { items: string[]; max?: number; onOpen?: (s: string) => void }) {
  if (!items.length) return null
  const shown = items.slice(0, max)
  const more = items.length - shown.length
  return (
    <span className="sources">
      {shown.map((s) => (
        <button key={s} type="button" className="source" onClick={() => onOpen?.(s)}>
          {s}
        </button>
      ))}
      {more > 0 && <span className="source source--more">+{more} {more === 1 ? 'source' : 'sources'}</span>}
    </span>
  )
}
