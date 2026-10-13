/**
 * Code-behind of `ActionsEditor.kbcontrol` (converted from `ActionsEditor.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useMenuDropdown, type MenuItem } from "@ui"
import type { ActionRow, ActionSpec } from "./types"

import { ViewBase } from './ActionsEditor.kbcontrol'
import * as __parts from './ActionsEditor.parts'

interface Props {
  value:     ActionSpec[]
  onChange:  (next: ActionSpec[]) => void
  catalogue: ActionRow[]
  maxActions: number
  disabled?: boolean
}

export type { Props }

export class ActionsEditor extends ViewBase {
  tr!: ActionsEditorStores['t']
  menu!: ActionsEditorStores['menu']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const menu = useMenuDropdown()
    return { t, menu }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, menu: s.menu })
  }

  get available(): ActionRow[] {
    return this.memo('available', [this.props], () => this.props.catalogue.filter(a => !a.is_orphan))
  }

  get full(): boolean {
    return this.props.value.length >= this.props.maxActions
  }

  get addItems(): MenuItem[] {
    return this.memo('addItems', [this.available, this.props], () => {
      const value = this.props.value
      const full = value.length >= this.props.maxActions
      return this.available.map((a): MenuItem => ({
    type: 'action',
    label: a.label,
    disabled: full,
    onClick: () => this.props.onChange([...value, { action: a.key, params: {} }]),
  }))
    })
  }

  get show_value() {
    return this.props.value.length === 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<Badge> with element children). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Badge> with element children). */
  get Part2() {
    return __parts.Part2
  }

  get show_disabled() {
    return !this.props.disabled
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part3() {
    return __parts.Part3
  }

  /** The rows of the Repeater over `value`. */
  get rows_value() {
    return this.memo('rows_value', [this.props, this.memo], () => this.props.value.map((spec, index) => {
      const def = this.props.catalogue.find(a => a.key === spec.action)
      const schema = def?.params_schema ?? []
      return { spec, index, def, schema, span_text: def?.label ?? spec.action, badge_text: def?.module_id ?? '?', show_def_is_reversible: !!(def?.is_reversible), show_not_def_is_reversible: !(def?.is_reversible), show_def_is_blocking: !!(def?.is_blocking), show_def_is_orphan: !!(def?.is_orphan), show_def_description: !!(def?.description), p_text: ((def?.description)) ? (def.description) : undefined, show_schema: schema.length > 0, part3_props: ((schema.length > 0)) ? ({ schema: schema, spec: spec, setParam: this.memo("setParam:bound", [], () => this.setParam.bind(this)), index: index, disabled: this.props.disabled }) : undefined, key: `${spec.action}-${index}` }
    }))
  }

  get enabled_unless_full_available() {
    if (!(!this.props.disabled)) return undefined as never
    return !(this.full || this.available.length === 0)
  }

  get show_menu_pos() {
    return this.memo('show_menu_pos', [this.menu], () => !!(this.menu.pos))
  }

  get part4_props() {
    return this.memo('part4_props', [this.menu, this.addItems], () => {
      if (!(this.menu.pos)) return undefined as never
      return ({ menu_pos: this.menu?.pos, addItems: this.addItems, menu: this.menu })
    })
  }

  /** A part of the screen still written in React (<ContextMenu> pos, onClose: no .kbview property). */
  get Part4() {
    if (!(this.menu.pos)) return undefined as never
    return __parts.Part4
  }

  setParam(index: number, name: string, v: unknown) {
    this.props.onChange(this.props.value.map((spec, i) => {
      if (i !== index) return spec
      const params = { ...spec.params }
      // A cleared optional parameter is removed, not sent as an empty string:
      // the server checks the declared domain and "" is in nobody's domain.
      if (v === null || v === undefined || v === '') delete params[name]
      else params[name] = v
      return { ...spec, params }
    }))
  }

  button_click(_sender: unknown, args: MouseEventArgs) {
    const { index } = args.row as RowOf_rows_value
    if (!(!this.props.disabled)) return undefined as never
    this.props.onChange(this.props.value.filter((_, i) => i !== index))
  }

  button_click2(_sender: unknown, args: MouseEventArgs) {
    if (!(!this.props.disabled)) return undefined as never
    const e = args.native as React.MouseEvent<HTMLButtonElement, MouseEvent>
    this.menu.open(e)
  }

}

type RowOf_rows_value = ActionsEditor['rows_value'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ActionsEditorStores = ReturnType<ActionsEditor['useStores']>

export default ActionsEditor.component()
