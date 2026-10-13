/**
 * The parts of `CategoryRows.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Badge } from "@ui"
import { formatBytes } from "../sections/format"
import { NEUTRAL_SERIES } from "./charts"
import type { CategoryUsage } from "./api"
import { formatCount } from "./CategoryBreakdown"

function CategoryRow({
  label, color, billable, row, showSwatch,
}: {
  label:      string
  color:      string | null
  billable:   boolean
  row:        CategoryUsage
  showSwatch: boolean
}) {
  const { t } = useTranslation()
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
      {showSwatch && (
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{
            backgroundColor: color ?? NEUTRAL_SERIES,
            boxShadow: color ? undefined : 'inset 0 0 0 1px var(--color-border-strong)',
          }}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {label}
      </span>

      {/* The rule, spelled out on every row. "Billable" is the whole reason the
          vocabulary exists, and a legend the reader has to remember is a legend
          they will get wrong. */}
      <Badge size="sm" variant={billable ? 'primary' : 'default'}>
        {billable ? t('admin.sto_cat_billable') : t('admin.sto_cat_not_billable')}
      </Badge>

      {row.object_count != null && (
        <span className="shrink-0 tabular-nums text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.sto_cat_objects', { n: formatCount(row.object_count), count: row.object_count })}
        </span>
      )}

      <span className="shrink-0 tabular-nums text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {formatBytes(row.used_bytes)}
      </span>
    </li>
  )
}
export { CategoryRow }
