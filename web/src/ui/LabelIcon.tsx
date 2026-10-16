// Label (étiquette) icon - traced shape provided by the user: a horizontal tag with a round eyelet.
// Colored through `currentColor`: `className="text-primary"`, `style={{ color: label.color }}`, etc.
// The eyelet is a hole thanks to fill-rule="evenodd" (outline + circle in a single path).
interface LabelIconProps {
  /** Icon height in px (width follows the 596.432:363.452 ratio). */
  size?:      number
  className?: string
  style?:     React.CSSProperties
  /** Accessible label; omit to render the icon as decorative. */
  title?:     string
}

const RATIO = 596.432 / 363.452

export function LabelIcon({ size = 24, className, style, title }: LabelIconProps) {
  return (
    <svg
      width={Math.round(size * RATIO * 100) / 100}
      height={size}
      viewBox="767.938 486.862 596.432 363.452"
      fill="currentColor"
      fillRule="evenodd"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={className}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      <path d="M 768.043 532.379 C 768.038 531.247 768.032 530.114 768.022 528.982 C 768.092 516.215 773.502 503.855 782.953 495.248 C 790.446 490.278 799.172 486.948 808.246 486.943 C 933.616 486.943 1058.987 487.154 1184.356 486.862 C 1204.994 486.939 1226 494.556 1239.253 510.908 C 1278.229 553.311 1313.462 599.023 1353.231 640.714 C 1362.194 650.714 1366.005 664.389 1363.723 677.601 C 1361.66 684.459 1358.251 690.999 1353.193 696.128 C 1316.095 738.242 1277.805 779.332 1242.223 822.758 C 1227.039 841.321 1203.692 850.288 1180.063 850.239 C 1057.966 850.239 935.868 850.03 813.771 850.315 C 799.369 850.259 784.332 845.812 775.393 833.828 C 771.05 826.781 768.313 818.676 768.303 810.349 C 767.818 717.693 767.914 625.036 768.043 532.379 Z M 1276.456 668.588 A 41.516 41.516 0 1 1 1193.425 668.588 A 41.516 41.516 0 1 1 1276.456 668.588 Z" />
    </svg>
  )
}
