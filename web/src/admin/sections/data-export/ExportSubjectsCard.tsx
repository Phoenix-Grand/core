/**
 * Code-behind of `ExportSubjectsCard.kbcontrol` (converted from `ExportSubjectsCard.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { Badge, type DataTableColumn } from "@ui"
import { formatBytes } from "../format"
import { useExportSubjects, type ExportSubject } from "./api"

import { ViewBase } from './ExportSubjectsCard.kbcontrol'
import * as __parts from './ExportSubjectsCard.parts'

const STATUS_SKIN: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  pending: 'neutral',
  done:    'success',
  partial: 'warning',
  failed:  'danger',
}

export type ExportSubjectsCardProps = {
  exportId: string
  onClose:  () => void
}

export class ExportSubjectsCard extends ViewBase {
  tr!: ExportSubjectsCardStores['t']
  data!: ExportSubjectsCardHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: ExportSubjectsCardHooks['refetch']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading, isError, refetch } = useExportSubjects(this.props.exportId)
    this.publish({ data, isLoading, isError, refetch })
    return { data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch })
  }

  get columns(): DataTableColumn<ExportSubject>[] {
    return this.memo('columns', [this.tr], () => [
    {
      id: 'account',
      header: this.tr('admin.dx_sub_col_account'),
      primary: true,
      minWidth: 220,
      sortValue: r => r.user_label,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-text-primary">{r.user_label}</span>
          <span className="truncate font-mono text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            comptes/{r.folder}
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: this.tr('admin.dx_sub_col_status'),
      minWidth: 120,
      sortValue: r => r.status,
      cell: r => (
        <Badge variant={STATUS_SKIN[r.status] ?? 'neutral'}>
          {this.tr(`admin.dx_sub_status_${r.status}`, { defaultValue: r.status })}
        </Badge>
      ),
    },
    {
      id: 'services',
      header: this.tr('admin.dx_sub_col_services'),
      minWidth: 240,
      cell: r => (
        <span className="flex min-w-0 flex-wrap gap-1">
          {r.services_ok.map(s => (
            <Badge key={`ok-${s}`} variant="success" size="sm">{s}</Badge>
          ))}
          {r.services_ko.map(s => (
            // Absent, not failed: the archive simply has no folder for it, and
            // saying which one is the whole point of showing this column.
            <Badge key={`ko-${s}`} variant="warning" size="sm">{s}</Badge>
          ))}
          {r.services_ok.length === 0 && r.services_ko.length === 0 && (
            <span className="text-text-tertiary">—</span>
          )}
        </span>
      ),
    },
    {
      id: 'size',
      header: this.tr('admin.dx_sub_col_size'),
      align: 'right',
      minWidth: 100,
      sortValue: r => r.size_bytes ?? -1,
      cell: r => (r.size_bytes == null ? '—' : formatBytes(r.size_bytes)),
    },
    {
      id: 'error',
      header: this.tr('admin.dx_sub_col_notes'),
      minWidth: 260,
      defaultHidden: true,
      cell: r => (
        <span className="min-w-0 break-words text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {r.error ?? '—'}
        </span>
      ),
    },
  ])
  }

  get show_is_loading_is_error_data() {
    return !this.isLoading && (this.isError || !this.data)
  }

  get show_is_loading_data() {
    return this.memo('show_is_loading_data', [this.isLoading, this.data], () => !!(!this.isLoading && this.data))
  }

  get part1_props() {
    return this.memo('part1_props', [this.data, this.columns, this.tr, this.isLoading], () => {
      if (!(!this.isLoading && this.data)) return undefined as never
      return ({ data: this.data, columns: this.columns, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, defaultSort, minTableWidth, configurableColumns, t, emptyState: no .kbview property). */
  get Part1() {
    if (!(!this.isLoading && this.data)) return undefined as never
    return __parts.Part1
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onClose?.()
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!this.isLoading && (this.isError || !this.data))) return undefined as never
    void this.refetch()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ExportSubjectsCardStores = ReturnType<ExportSubjectsCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ExportSubjectsCardHooks = ReturnType<ExportSubjectsCard['useHooks']>

export default ExportSubjectsCard.component()
