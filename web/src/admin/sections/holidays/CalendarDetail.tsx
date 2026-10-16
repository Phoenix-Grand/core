/**
 * Code-behind of `CalendarDetail.kbcontrol` (converted from `CalendarDetail.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { RotateCcw } from "lucide-react"
import { Badge, Toggle, type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import HolidayDialog from "./HolidayDialog"
import { formatDate, observanceText, ruleText } from "./ruleText"
import { errorMessage, useCalendarDetail, useDeleteHoliday, useResetHoliday, useSetExclusions, useSetHolidayEnabled, type Holiday } from "./api"
import { useAdminCrumbs } from "../../pages/AdminBreadcrumb"

import { ViewBase } from './CalendarDetail.kbcontrol'
import * as __parts from './CalendarDetail.parts'

export type CalendarDetailProps = {
  calendarId: string
  canManage: boolean
  onOpenCalendar: (id: string) => void
}

export class CalendarDetail extends ViewBase {
  @bind accessor editing: Holiday | 'new' | null = null
  @bind accessor error: string | null = null
  tr!: CalendarDetailStores['t']
  i18n!: CalendarDetailStores['i18n']
  confirm!: CalendarDetailStores['confirm']
  confirmState!: CalendarDetailStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  year!: CalendarDetailStores['year']
  setYear!: CalendarDetailStores['setYear']
  data!: CalendarDetailHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: CalendarDetailHooks['refetch']
  setEnabled!: CalendarDetailStores['setEnabled']
  remove!: CalendarDetailStores['remove']
  reset!: CalendarDetailStores['reset']
  setExclusions!: CalendarDetailHooks['setExclusions']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const [year, setYear]       = useState<number>(new Date().getFullYear())
    const setEnabled    = useSetHolidayEnabled()
    const remove        = useDeleteHoliday()
    const reset         = useResetHoliday()
    return { t, i18n, confirm, confirmState, handleConfirm, handleCancel, year, setYear, setEnabled, remove, reset }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const year = this.year
    const { data, isLoading, isError, refetch } = useCalendarDetail(this.props.calendarId, year)
    this.publish({ data, isLoading, isError, refetch })
    const setExclusions = useSetExclusions(this.props.calendarId)
    this.publish({ setExclusions })
    const calendar = this.calendar
    useAdminCrumbs(useMemo(
      () => (calendar ? [{ label: calendar.name, title: calendar.name }] : []),
      [calendar],
    ))
    return { data, isLoading, isError, refetch, setExclusions }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, year: s.year, setYear: s.setYear, setEnabled: s.setEnabled, remove: s.remove, reset: s.reset })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, setExclusions: h.setExclusions })
  }

  get locale(): string {
    return this.i18n.language || 'fr'
  }

  get columns(): DataTableColumn<Holiday>[] {
    return this.memo('columns', [this.tr, this.locale, this.year, this.props, this.setEnabled, this.setExclusions, this.error, this.data, this.memo], () => [
    {
      id: 'name',
      header: this.tr('admin.hol_col_day'),
      primary: true,
      minWidth: 220,
      sortValue: r => r.display_name.toLowerCase(),
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className={`truncate ${r.enabled && !r.excluded ? 'text-text-primary' : 'text-text-tertiary line-through'}`}>
            {r.display_name}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {r.inherited && (
              <Badge variant="neutral">{this.tr('admin.hol_badge_inherited')}</Badge>
            )}
            {r.is_overridden && <Badge variant="primary">{this.tr('admin.hol_badge_corrected')}</Badge>}
            {!r.is_builtin && <Badge variant="neutral">{this.tr('admin.hol_badge_custom')}</Badge>}
            {/* A row the newest dataset dropped, kept because it was edited.
                Naming it is the whole point of the flag. */}
            {r.is_orphan && <Badge variant="warning">{this.tr('admin.hol_badge_orphan')}</Badge>}
          </span>
        </span>
      ),
    },
    {
      id: 'rule',
      header: this.tr('admin.hol_col_rule'),
      minWidth: 220,
      sortValue: r => r.kind,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-text-secondary">{ruleText(this.tr, this.locale, r.kind, r.rule)}</span>
          {r.observance !== 'none' && (
            <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
              {observanceText(this.tr, r.observance)}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'dates',
      header: this.tr('admin.hol_col_dates', { year: this.year }),
      minWidth: 220,
      sortValue: r => r.dates[0]?.date ?? null,
      cell: r => (
        r.dates.length === 0
          // Not an error: a rule bounded by its years, or a date list that has
          // run out, legitimately produces nothing this year - and saying so is
          // more useful than an empty cell.
          ? <span className="text-text-tertiary">{this.tr('admin.hol_no_date_this_year')}</span>
          : (
            <span className="flex flex-col">
              {r.dates.slice(0, 3).map(d => (
                <span key={d.date} className="text-text-primary">
                  {formatDate(this.locale, d.date)}
                  {d.observed_from && (
                    <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>
                      {' '}{this.tr('admin.hol_preview_moved', { from: formatDate(this.locale, d.observed_from) })}
                    </span>
                  )}
                </span>
              ))}
              {r.dates.length > 3 && (
                <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
                  {this.tr('admin.hol_more_dates', { count: r.dates.length - 3 })}
                </span>
              )}
            </span>
          )
      ),
    },
    {
      id: 'category',
      header: this.tr('admin.hol_col_category'),
      sortValue: r => r.category,
      cell: r => <span className="text-text-secondary">{this.tr(`admin.hol_cat_${r.category}`)}</span>,
    },
    {
      id: 'enabled',
      header: this.tr('admin.hol_col_observed'),
      align: 'right',
      sortValue: r => (r.enabled && !r.excluded ? 1 : 0),
      cell: r => (
        <Toggle
          checked={r.inherited ? !r.excluded : r.enabled}
          disabled={!this.props.canManage || this.setEnabled.isPending || this.setExclusions.isPending}
          aria-label={this.tr('admin.hol_col_observed')}
          onChange={e => {
            this.error = null
            // The same switch, two different writes: a day of this calendar is
            // disabled, an inherited one is excluded. One control because the
            // question the operator is answering is identical.
            if (r.inherited) this.toggleExclusion(r.key, !e.target.checked)
            else this.setEnabled.mutate({ id: r.id, enabled: e.target.checked }, { onError: this.memo("fail:bound", [], () => this.fail.bind(this)) })
          }}
        />
      ),
    },
  ])
  }

  get rowActions(): DataTableRowAction<Holiday>[] {
    return this.memo('rowActions', [this.props, this.tr, this.editing, this.error, this.reset, this.memo, this.confirm, this.remove], () => this.props.canManage
    ? [
        {
          id: 'edit',
          label: this.tr('admin.hol_action_edit'),
          hidden: r => r.inherited,
          onClick: r => this.editing = r,
        },
        {
          id: 'reset',
          label: this.tr('admin.hol_action_reset'),
          icon: <RotateCcw size={14} />,
          // Only a shipped row that was edited has an original to go back to.
          hidden: r => !r.is_overridden || r.inherited,
          onClick: r => {
            this.error = null
            this.reset.mutate(r.id, { onError: this.memo("fail:bound", [], () => this.fail.bind(this)) })
          },
        },
        {
          id: 'delete',
          label: this.tr('admin.hol_action_delete'),
          danger: true,
          hidden: r => r.is_builtin || r.inherited,
          onClick: async r => {
            const ok = await this.confirm({
              title: this.tr('admin.hol_delete_day_title'),
              message: this.tr('admin.hol_delete_day_message', { name: r.display_name }),
              confirmLabel: this.tr('admin.hol_action_delete'),
              variant: 'danger',
            })
            if (!ok) return
            this.error = null
            this.remove.mutate(r.id, { onError: this.memo("fail:bound", [], () => this.fail.bind(this)) })
          },
        },
      ]
    : [])
  }

  get calendar() {
    return this.memo('calendar', [this.data], () => this.data?.calendar)
  }

  get coverage(): string | null {
    return this.calendar?.coverage_from && this.calendar?.coverage_to
    ? this.tr('admin.hol_coverage', { from: this.calendar.coverage_from, to: this.calendar.coverage_to })
    : null
  }

  get show_data_parent() {
    return this.memo('show_data_parent', [this.data], () => !!(this.data?.parent))
  }

  get hol_open_parent_name() {
    if (!(this.data?.parent)) return undefined as never
    return this.data.parent.name
  }

  get text() {
    return this.data?.display_name ?? '…'
  }

  get span_text() {
    return this.calendar?.code
  }

  get show_coverage() {
    return !!(this.coverage)
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.editing, this.tr, this.props], () => {
      if (!(this.props.canManage)) return undefined as never
      return ({ setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(this.props.canManage)) return undefined as never
    return __parts.Part1
  }

  get show_error() {
    return !!(this.error)
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.data, this.columns, this.isLoading, this.rowActions, this.isError, this.refetch], () => ({ t: this.tr, data: this.data, columns: this.columns, isLoading: this.isLoading, rowActions: this.rowActions, isError: this.isError, refetch: this.refetch }))
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, rowActions, onRetry, emptyState: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get show_editing() {
    return this.memo('show_editing', [this.editing], () => !!(this.editing))
  }

  /** `<HolidayDialog>`, rendered by a ReactHost. */
  get HolidayDialog() {
    if (!(this.editing)) return undefined as never
    return HolidayDialog
  }

  get holiday_dialog_props() {
    return this.memo('holiday_dialog_props', [this.props, this.editing], () => {
      if (!(this.editing)) return undefined as never
      return ({ calendarId: this.props.calendarId, holiday: this.editing === 'new' ? null : this.editing, onClose: () => this.editing = null } as React.ComponentProps<typeof HolidayDialog>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState], () => !!(this.confirmState))
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel], () => {
      if (!(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  fail(e: unknown) {
    this.error = errorMessage(e, this.tr('admin.hol_save_failed'))
  }

  toggleExclusion(key: string, excluded: boolean) {
    const current = this.data?.exclusions ?? []
    const next = excluded ? [...current, key] : current.filter(k => k !== key)
    this.error = null
    this.setExclusions.mutate(next, { onError: this.memo("fail:bound", [], () => this.fail.bind(this)) })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.data?.parent)) return undefined as never
    this.props.onOpenCalendar(this.data.parent!.id)
  }

  numeric_field_value_changed(_sender: unknown, args: ValueChangedEventArgs) {
    this.setYear(args.value as never)
  }

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: Holiday | 'new' | null | ((prev: Holiday | 'new' | null) => Holiday | 'new' | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: Holiday | 'new' | null) => Holiday | 'new' | null)(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CalendarDetailStores = ReturnType<CalendarDetail['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type CalendarDetailHooks = ReturnType<CalendarDetail['useHooks']>

export default CalendarDetail.component()
