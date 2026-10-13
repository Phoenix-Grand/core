import { useTranslation } from "react-i18next"
import { CornerDownLeft } from "lucide-react"
import { Badge } from "@ui"
import { KIND_ICON } from "./useAdminSearchSources"
import { type RowProps } from './AdminSearchPanel'

/**
 * The result surface of the admin search — presentation only.
 *
 * It paints from the FLAT, keyboard-ordered list and inserts a heading whenever
 * the category changes. Grouping by category and painting separately would let
 * the eye and the arrow keys disagree the moment a result is demoted; here they
 * cannot, because there is only one order.
 */

/** Breadcrumb line ("A › B › C"), last segment emphasised. */
function Breadcrumb({ segments, max }: { segments: string[]; max?: number }) {
  // Mobile keeps only the tail: a three-level path wraps and steals the row.
  const shown = max && segments.length > max ? segments.slice(-max) : segments
  return (
    <p className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
      {shown.map((s, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-1">›</span>}
          <span className={i === shown.length - 1 ? 'text-text-secondary' : ''}>{s}</span>
        </span>
      ))}
    </p>
  )
}

function Avatar({ label, url }: { label: string; url?: string | null }) {
  if (url) return <img src={url} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-light
                     font-medium text-primary" style={{ fontSize: 'var(--kb-text-meta)' }}>
      {(label.trim().charAt(0) || '?').toUpperCase()}
    </span>
  )
}

export function ResultRow({ result, active, optionId, mobile, onPick, onHover }: RowProps) {
  const { t } = useTranslation()
  const Icon = result.Icon ?? KIND_ICON[result.kind]
  return (
    <li
      id={optionId}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onMouseDown={e => { e.preventDefault(); onPick(result) }}
      className={`flex cursor-pointer items-center gap-3 px-4 transition-colors
                  ${mobile ? 'min-h-[52px] py-2' : 'py-2'}
                  ${active ? 'bg-surface-2' : 'hover:bg-surface-1'}`}
    >
      {result.kind === 'user'
        ? <Avatar label={result.label} url={result.avatarUrl} />
        : <Icon size={18} className="shrink-0 text-text-tertiary" />}

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          <span className="truncate">{result.label}</span>
          {result.soon && <Badge size="sm" variant="warning">{t('admin.soon_badge')}</Badge>}
        </p>
        {result.sublabel
          ? <p className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{result.sublabel}</p>
          : result.segments && result.segments.length > 1
            ? <Breadcrumb segments={result.segments} max={mobile ? 2 : undefined} />
            : null}
      </div>

      {active && !mobile && (
        <CornerDownLeft size={14} className="shrink-0 text-text-tertiary" aria-hidden />
      )}
    </li>
  )
}
