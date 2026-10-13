// The administration console's mark — a blue hexagonal badge holding a gear.
// A raster image supplied by the user, served statically by the host from
// `public/admin-logo.png`. It is only ever rendered inside the core shell (the
// console sidebar and the app-launcher tile), so the absolute `/admin-logo.png`
// path resolves directly and needs no bundling or data URI. Signature
// compatible with the icon slots (size + className).
interface AdminLogoProps {
  /** Height AND width in px — the artwork is square. */
  size?:      number
  className?: string
  title?:     string
}

export function AdminLogo({ size = 24, className, title = 'Administration' }: AdminLogoProps) {
  return (
    <img
      src="/admin-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      draggable={false}
      style={{ objectFit: 'contain' }}
    />
  )
}
