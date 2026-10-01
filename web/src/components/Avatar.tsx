export function Avatar({ initials, size = 22, dark = false }: { initials: string; size?: number; dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: dark ? '#3A3E44' : '#E3E1DA',
        color: dark ? '#ECEAE4' : '#45494F',
        fontSize: size <= 22 ? 10 : 11,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {initials}
    </span>
  )
}
