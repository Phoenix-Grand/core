/**
 * Code-behind of `CalendarsTab.kbcontrol` (converted from `CalendarsTab.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { Toggle, type DataTableColumn, type DataTableRowAction } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import CalendarDialog from "./CalendarDialog"
import { errorMessage, useDeleteCalendar, useHolidayCalendars, useSetCalendarEnabled, type CalendarSummary } from "./api"

import { ViewBase } from './CalendarsTab.kbcontrol'
import * as __parts from './CalendarsTab.parts'

export type CalendarsTabProps = {
  canManage: boolean
  onOpen: (id: string) => void
}

export class CalendarsTab extends ViewBase {
  @bind accessor search = ''
  @bind accessor countriesOnly = true
  @bind accessor creating = false
  @bind accessor error: string | null = null
  tr!: CalendarsTabStores['t']
  confirm!: CalendarsTabStores['confirm']
  confirmState!: CalendarsTabStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: CalendarsTabHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: CalendarsTabHooks['refetch']
  setEnabled!: CalendarsTabStores['setEnabled']
  remove!: CalendarsTabStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const setEnabled = useSetCalendarEnabled()
    const remove     = useDeleteCalendar()
    return { t, confirm, confirmState, handleConfirm, handleCancel, setEnabled, remove }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading, isError, refetch } = useHolidayCalendars(this.search, this.countriesOnly)
    this.publish({ data, isLoading, isError, refetch })
    return { data, isLoading, isError, refetch }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, setEnabled: s.setEnabled, remove: s.remove })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch })
  }

  get columns(): DataTableColumn<CalendarSummary>[] {
    return this.memo('columns', [this.tr, this.props, this.setEnabled, this.error], () => [
    {
      id: 'name',
      header: this.tr('admin.hol_col_territory'),
      primary: true,
      minWidth: 220,
      sortValue: r => r.display_name.toLowerCase(),
      cell: r => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-text-primary">{r.display_name}</span>
          {/* The code is what the setting is written with, so it belongs next
              to the name rather than in a column nobody would connect to it. */}
          <span className="shrink-0 text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
            {r.code}
          </span>
          {!r.is_builtin && (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 text-text-secondary"
                  style={{ fontSize: 'var(--kb-text-small)' }}>
              {this.tr('admin.hol_badge_custom')}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'holidays',
      header: this.tr('admin.hol_col_days'),
      align: 'right',
      sortValue: r => r.holiday_count + r.inherited_count,
      cell: r => (
        <span className="text-text-secondary">
          {r.parent_id
            // A subdivision's own count means nothing on its own: "2" is two
            // days only if the reader also knows it inherits eleven.
            ? this.tr('admin.hol_days_with_inherited', { own: r.holiday_count, inherited: r.inherited_count })
            : r.holiday_count}
        </span>
      ),
    },
    {
      id: 'subdivisions',
      header: this.tr('admin.hol_col_regions'),
      align: 'right',
      sortValue: r => r.subdivision_count,
      cell: r => (
        <span className={r.subdivision_count === 0 ? 'text-text-tertiary' : 'text-text-secondary'}>
          {r.subdivision_count || '-'}
        </span>
      ),
    },
    {
      id: 'overridden',
      header: this.tr('admin.hol_col_corrected'),
      align: 'right',
      sortValue: r => r.overridden_count,
      cell: r => (
        <span className={r.overridden_count === 0 ? 'text-text-tertiary' : 'text-primary'}>
          {r.overridden_count || '-'}
        </span>
      ),
    },
    {
      id: 'enabled',
      header: this.tr('admin.hol_col_offered'),
      align: 'right',
      sortValue: r => (r.enabled ? 1 : 0),
      cell: r => (
        <Toggle
          checked={r.enabled}
          disabled={!this.props.canManage || this.setEnabled.isPending}
          aria-label={this.tr('admin.hol_col_offered')}
          onChange={e => {
            this.error = null
            this.setEnabled.mutate({ id: r.id, enabled: e.target.checked }, {
              onError: e => this.error = errorMessage(e, this.tr('admin.hol_save_failed')),
            })
          }}
        />
      ),
    },
  ])
  }

  get rowActions(): DataTableRowAction<CalendarSummary>[] {
    return this.memo('rowActions', [this.tr, this.props, this.confirm, this.error, this.remove], () => [
    { id: 'open', label: this.tr('admin.hol_action_open'), onClick: r => this.props.onOpen(r.id) },
    ...(this.props.canManage
      ? [{
          id: 'delete',
          label: this.tr('admin.hol_action_delete'),
          danger: true,
          // A shipped territory cannot be deleted - the seeder would bring it
          // back - so the action is simply absent rather than offered and refused.
          hidden: (r: CalendarSummary) => r.is_builtin,
          onClick: async (r: CalendarSummary) => {
            const ok = await this.confirm({
              title: this.tr('admin.hol_delete_calendar_title'),
              message: this.tr('admin.hol_delete_calendar_message', { name: r.display_name }),
              confirmLabel: this.tr('admin.hol_action_delete'),
              variant: 'danger',
            })
            if (!ok) return
            this.error = null
            this.remove.mutate(r.id, { onError: e => this.error = errorMessage(e, this.tr('admin.hol_save_failed')) })
          },
        } as DataTableRowAction<CalendarSummary>]
      : []),
  ])
  }

  get part1_props() {
    return this.memo('part1_props', [this.search, this.memo, this.tr], () => ({ search: this.search, setSearch: this.memo("setSearch:bound", [], () => this.setSearch.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<TextField LeftIcon>: an icon size the element cannot take). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.memo, this.creating, this.tr, this.props], () => {
      if (!(this.props.canManage)) return undefined as never
      return ({ setCreating: this.memo("setCreating:bound", [], () => this.setCreating.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part2() {
    if (!(this.props.canManage)) return undefined as never
    return __parts.Part2
  }

  get show_error() {
    return !!(this.error)
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.data, this.columns, this.isLoading, this.rowActions, this.props, this.isError, this.refetch, this.search, this.countriesOnly, this.memo], () => ({ t: this.tr, data: this.data, columns: this.columns, isLoading: this.isLoading, rowActions: this.rowActions, onOpen: this.props.onOpen, isError: this.isError, refetch: this.refetch, search: this.search, countriesOnly: this.countriesOnly, setSearch: this.memo("setSearch:bound", [], () => this.setSearch.bind(this)), setCountriesOnly: this.memo("setCountriesOnly:bound", [], () => this.setCountriesOnly.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, rowActions, onRowClick, onRetry, filtered, onClearFilters, emptyState: no .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  /** `<CalendarDialog>`, rendered by a ReactHost. */
  get CalendarDialog() {
    if (!(this.creating)) return undefined as never
    return CalendarDialog
  }

  get calendar_dialog_props() {
    return this.memo('calendar_dialog_props', [this.creating, this.props], () => {
      if (!(this.creating)) return undefined as never
      return ({ onClose: () => this.creating = false, onCreated: this.props.onOpen } as React.ComponentProps<typeof CalendarDialog>)
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

  /** `setSearch` of the TSX: a value, or an update of the previous one. */
  setSearch(value: CalendarsTab['search'] | ((prev: CalendarsTab['search']) => CalendarsTab['search'])) {
    this.search = typeof value === 'function' ? (value as (prev: CalendarsTab['search']) => CalendarsTab['search'])(this.search) : value
  }

  /** `setCreating` of the TSX: a value, or an update of the previous one. */
  setCreating(value: CalendarsTab['creating'] | ((prev: CalendarsTab['creating']) => CalendarsTab['creating'])) {
    this.creating = typeof value === 'function' ? (value as (prev: CalendarsTab['creating']) => CalendarsTab['creating'])(this.creating) : value
  }

  /** `setCountriesOnly` of the TSX: a value, or an update of the previous one. */
  setCountriesOnly(value: CalendarsTab['countriesOnly'] | ((prev: CalendarsTab['countriesOnly']) => CalendarsTab['countriesOnly'])) {
    this.countriesOnly = typeof value === 'function' ? (value as (prev: CalendarsTab['countriesOnly']) => CalendarsTab['countriesOnly'])(this.countriesOnly) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CalendarsTabStores = ReturnType<CalendarsTab['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type CalendarsTabHooks = ReturnType<CalendarsTab['useHooks']>

export default CalendarsTab.component()
