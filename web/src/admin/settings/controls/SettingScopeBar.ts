/**
 * Code-behind of `SettingScopeBar.kbcontrol` (converted from `SettingScopeBar.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../core/api/client"
import OrgUnitPicker from "../../dialogs/OrgUnitPicker"
import type { OrgUnit } from "../../../core/types"
import { orgUnitPath, type ActiveScope } from "../scopeTypes"

import { ViewBase } from './SettingScopeBar.kbcontrol'

export type SettingScopeBarProps = {
  scope:    ActiveScope
  onChange: (next: ActiveScope) => void
  /**
   * False when the bar heads a settings BLOCK inside a page that is about
   * something else: pinning it to the viewport there would park it over the
   * inventory the operator is scrolling through, far from what it qualifies.
   */
  sticky?:  boolean
}

export class SettingScopeBar extends ViewBase {
  @bind accessor picking = false
  tr!: SettingScopeBarStores['t']
  units!: SettingScopeBarStores['units']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data: units } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn: () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
    })
    return { t, units }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, units: s.units })
  }

  get sticky() {
    return this.props.sticky ?? true
  }

  get path(): OrgUnit[] {
    return this.memo('path', [this.units, this.props], () => orgUnitPath(this.units ?? [], this.props.scope.type === 'org_unit' ? this.props.scope.id : null))
  }

  get isInstance(): boolean {
    return this.props.scope.type === 'instance'
  }

  get div_class() {
    return `${this.sticky ? 'sticky top-0 z-10 ' : ''}-mx-1 mb-5 px-1 py-2 bg-surface-0`
  }

  get button_class() {
    return `rounded px-1.5 py-0.5 text-sm ${
              this.isInstance ? 'bg-primary-light text-primary' : 'text-text-secondary hover:bg-surface-2'
            }`
  }

  /** The rows of the Repeater over `path`. */
  get rows_path() {
    return this.memo('rows_path', [this.path], () => this.path.map((u, i) => {
      return { u, i, button_class: `truncate rounded px-1.5 py-0.5 text-sm ${
                  i === this.path.length - 1
                    ? 'bg-primary-light text-primary'
                    : 'text-text-secondary hover:bg-surface-2'
                }`, key: u.id }
    }))
  }

  get p_text() {
    return this.isInstance ? this.tr('admin.scope_hint_instance') : this.tr('admin.scope_hint_unit')
  }

  /** `<OrgUnitPicker>`, rendered by a ReactHost. */
  get OrgUnitPicker() {
    if (!(this.picking)) return undefined as never
    return OrgUnitPicker
  }

  get org_unit_picker_props() {
    return this.memo('org_unit_picker_props', [this.tr, this.props, this.picking], () => {
      if (!(this.picking)) return undefined as never
      return ({ title: this.tr('admin.scope_pick_title'), currentId: this.props.scope.type === 'org_unit' ? this.props.scope.id : null, onSelect: id => this.props.onChange({ type: 'org_unit', id }), onClose: () => this.picking = false } as React.ComponentProps<typeof OrgUnitPicker>)
    })
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onChange({ type: 'instance', id: null })
  }

  panel_click2(_sender: unknown, args: MouseEventArgs) {
    const { u } = args.row as RowOf_rows_path
    this.props.onChange({ type: 'org_unit', id: u.id })
  }

  panel_click3(_sender: unknown, _args: MouseEventArgs) {
    this.picking = true
  }

}

type RowOf_rows_path = SettingScopeBar['rows_path'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingScopeBarStores = ReturnType<SettingScopeBar['useStores']>

export default SettingScopeBar.component()
