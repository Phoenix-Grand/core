/**
 * Code-behind of `UnitsTab.kbcontrol` (converted from `UnitsTab.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../core/api/client"
import OrgUnitPicker from "../../dialogs/OrgUnitPicker"
import { errorMessage, useHolidayCalendars, useSetUnitPref, useUnitOverlay } from "./api"

import { ViewBase } from './UnitsTab.kbcontrol'
import * as __parts from './UnitsTab.parts'

export type UnitsTabProps = { canManage: boolean }

export class UnitsTab extends ViewBase {
  @bind accessor unitId: string | null = null
  @bind accessor picking = false
  @bind accessor adding = ''
  @bind accessor error: string | null = null
  tr!: UnitsTabStores['t']
  units!: UnitsTabStores['units']
  calendars!: UnitsTabStores['calendars']
  prefs!: UnitsTabHooks['prefs']
  isLoading!: boolean
  setPref!: UnitsTabHooks['setPref']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data: units } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn: async () => (await api.get<{ org_units: { id: string; name: string }[] }>(
        '/admin/org-units')).data.org_units,
      staleTime: 30_000,
    })
    const { data: calendars } = useHolidayCalendars('', true)
    return { t, units, calendars }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data: prefs, isLoading } = useUnitOverlay(this.unitId)
    this.publish({ prefs, isLoading })
    const setPref = useSetUnitPref(this.unitId ?? '')
    this.publish({ setPref })
    return { prefs, isLoading, setPref }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, units: s.units, calendars: s.calendars })
    const h = this.useHooks()
    this.publish({ prefs: h.prefs, isLoading: h.isLoading, setPref: h.setPref })
  }

  get unitName(): string {
    const unitId = this.unitId
    return this.units?.find(u => u.id === unitId)?.name ?? ''
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.memo, this.picking, this.unitName, this.tr], () => ({ setPicking: this.memo("setPicking:bound", [], () => this.setPicking.bind(this)), unitName: this.unitName, t: this.tr }))
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part2() {
    return __parts.Part2
  }

  get show_unit_id_can_manage() {
    return !!(this.unitId && this.props.canManage)
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.unitId, this.props], () => {
      if (!(this.unitId && this.props.canManage)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part3() {
    if (!(this.unitId && this.props.canManage)) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.adding, this.tr, this.calendars, this.memo, this.unitId, this.props], () => {
      if (!(this.unitId && this.props.canManage)) return undefined as never
      return ({ adding: this.adding, t: this.tr, calendars: this.calendars, setAdding: this.memo("setAdding:bound", [], () => this.setAdding.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part4() {
    if (!(this.unitId && this.props.canManage)) return undefined as never
    return __parts.Part4
  }

  get part5_props() {
    return this.memo('part5_props', [this.adding, this.setPref, this.memo, this.error, this.tr, this.unitId, this.props], () => {
      if (!(this.unitId && this.props.canManage)) return undefined as never
      return ({ adding: this.adding, setPref: this.setPref, setError: this.memo("setError:bound", [], () => this.setError.bind(this)), setAdding: this.memo("setAdding:bound", [], () => this.setAdding.bind(this)), fail: this.memo("fail:bound", [], () => this.fail.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part5() {
    if (!(this.unitId && this.props.canManage)) return undefined as never
    return __parts.Part5
  }

  get show_error() {
    return !!(this.error)
  }

  get show_unit_id() {
    return !this.unitId
  }

  get show_not_unit_id() {
    return !(!this.unitId)
  }

  get show_not_is_loading() {
    if (!(!(!this.unitId))) return undefined as never
    return !(this.isLoading)
  }

  get show_prefs() {
    if (!(!(!this.unitId)) || !(!(this.isLoading))) return undefined as never
    return (this.prefs ?? []).length === 0
  }

  get show_not_prefs() {
    if (!(!(!this.unitId)) || !(!(this.isLoading))) return undefined as never
    return !((this.prefs ?? []).length === 0)
  }

  get enabled_unless_can_manage_set_pref_is_pending() {
    if (!(!(!this.unitId)) || !(!(this.isLoading)) || !(!((this.prefs ?? []).length === 0))) return undefined as never
    return !(!this.props.canManage || this.setPref.isPending)
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part6() {
    if (!(!(!this.unitId)) || !(!(this.isLoading)) || !(!((this.prefs ?? []).length === 0)) || !(this.props.canManage)) return undefined as never
    return __parts.Part6
  }

  /** The rows of the Repeater over `(prefs ?? [])`. */
  get rows_items() {
    return this.memo('rows_items', [this.prefs, this.unitId, this.isLoading, this.props, this.tr, this.memo, this.error, this.setPref], () => {
      if (!(!(!this.unitId)) || !(!(this.isLoading)) || !(!((this.prefs ?? []).length === 0))) return undefined as never
      return (this.prefs ?? []).map((pref) => {
      return { pref, span_text: ((!(!this.unitId)) && (!(this.isLoading)) && (!((this.prefs ?? []).length === 0))) ? (pref.calendar_id
                  ? `${pref.calendar_name} (${pref.calendar_code})`
                  : `${pref.holiday_name} - ${pref.holiday_calendar_code}`) : undefined, part6_props: ((!(!this.unitId)) && (!(this.isLoading)) && (!((this.prefs ?? []).length === 0)) && (this.props.canManage)) ? ({ t: this.tr, setError: this.memo("setError:bound", [], () => this.setError.bind(this)), setPref: this.setPref, pref: pref, fail: this.memo("fail:bound", [], () => this.fail.bind(this)) }) : undefined, key: pref.id }
    })
    })
  }

  get visible() {
    return this.memo('visible', [this.show_prefs, this.show_not_is_loading, this.unitId], () => {
      if (!(!(!this.unitId))) return undefined as never
      return this.show_prefs && this.show_not_is_loading
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_prefs, this.show_not_is_loading, this.unitId], () => {
      if (!(!(!this.unitId))) return undefined as never
      return this.show_not_prefs && this.show_not_is_loading
    })
  }

  get visible3() {
    return this.memo('visible3', [this.isLoading, this.show_not_unit_id], () => this.isLoading && this.show_not_unit_id)
  }

  get visible4() {
    return this.memo('visible4', [this.visible, this.show_not_unit_id], () => this.visible && this.show_not_unit_id)
  }

  get visible5() {
    return this.memo('visible5', [this.visible2, this.show_not_unit_id], () => this.visible2 && this.show_not_unit_id)
  }

  /** `<OrgUnitPicker>`, rendered by a ReactHost. */
  get OrgUnitPicker() {
    if (!(this.picking)) return undefined as never
    return OrgUnitPicker
  }

  get org_unit_picker_props() {
    return this.memo('org_unit_picker_props', [this.tr, this.unitId, this.picking], () => {
      if (!(this.picking)) return undefined as never
      return ({ title: this.tr('admin.hol_units_pick'), currentId: this.unitId, onSelect: id => { this.unitId = id; this.picking = false }, onClose: () => this.picking = false } as React.ComponentProps<typeof OrgUnitPicker>)
    })
  }

  fail(e: unknown) {
    this.error = errorMessage(e, this.tr('admin.hol_save_failed'))
  }

  switch_checked_changed(_sender: unknown, args: EventArgs) {
    const { pref } = args.row as RowOf_rows_items
    if (!(!(!this.unitId)) || !(!(this.isLoading)) || !(!((this.prefs ?? []).length === 0))) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
                  this.error = null
                  this.setPref.mutate({
                    calendar_id: pref.calendar_id ?? undefined,
                    holiday_id:  pref.holiday_id ?? undefined,
                    enabled: e.target.checked,
                  }, { onError: this.memo("fail:bound", [], () => this.fail.bind(this)) })
                }

  /** `setPicking` of the TSX: a value, or an update of the previous one. */
  setPicking(value: UnitsTab['picking'] | ((prev: UnitsTab['picking']) => UnitsTab['picking'])) {
    this.picking = typeof value === 'function' ? (value as (prev: UnitsTab['picking']) => UnitsTab['picking'])(this.picking) : value
  }

  /** `setAdding` of the TSX: a value, or an update of the previous one. */
  setAdding(value: UnitsTab['adding'] | ((prev: UnitsTab['adding']) => UnitsTab['adding'])) {
    this.adding = typeof value === 'function' ? (value as (prev: UnitsTab['adding']) => UnitsTab['adding'])(this.adding) : value
  }

  /** `setError` of the TSX: a value, or an update of the previous one. */
  setError(value: string | null | ((prev: string | null) => string | null)) {
    this.error = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.error) : value
  }

}

type RowOf_rows_items = UnitsTab['rows_items'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type UnitsTabStores = ReturnType<UnitsTab['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type UnitsTabHooks = ReturnType<UnitsTab['useHooks']>

export default UnitsTab.component()
