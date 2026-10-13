/**
 * Code-behind of `CheckboxRow.kbcontrol` (converted from `CheckboxRow.tsx` by @kubuno/views-migrate).
 */
import { type ValueChangedEventArgs } from '@kubuno/views'
import ProvenanceLine from "../../settings/controls/ProvenanceLine"
import { type RowProps, useRow } from "./PolicyRow"

import { ViewBase } from './CheckboxRow.kbcontrol'

export type CheckboxRowProps = RowProps & {
  /** Marks a field carrying personal data (`gender`, `birthday`). */
  personal?: boolean
}

export class CheckboxRow extends ViewBase {
  row!: CheckboxRowHooks['row']

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const row = useRow(this.props.setting, this.props.readOnly)
    this.publish({ row })
    return { row }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const h = this.useHooks()
    this.publish({ row: h.row })
  }

  get show_case_1() {
    return !!(!this.props.setting || !this.row)
  }

  get show_main() {
    return !(!this.props.setting || !this.row)
  }

  get checked() {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    return Boolean(this.props.setting.value)
  }

  get enabled_unless_row_disabled() {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    return !(this.row.disabled)
  }

  get text() {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    return this.row.label
  }

  get description() {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    return this.row.desc
  }

  get show_personal() {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    return !!(this.props.personal)
  }

  get span_text() {
    if (!(!(!this.props.setting || !this.row)) || !(this.props.personal)) return undefined as never
    return this.row.t('admin.dirset_field_personal')
  }

  /** `<ProvenanceLine>`, rendered by a ReactHost. */
  get ProvenanceLine() {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    return ProvenanceLine
  }

  get provenance_line_props() {
    return this.memo('provenance_line_props', [this.props, this.row], () => {
      if (!(!(!this.props.setting || !this.row))) return undefined as never
      const setting = this.props.setting
      return ({ setting: setting, onRevert: () => this.props.policy.revert(setting.key), onLock: locked => this.props.policy.lock(setting.key, locked), onShowChain: () => this.props.onShowChain(setting.key) } as React.ComponentProps<typeof ProvenanceLine>)
    })
  }

  check_box_checked_changed(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(!(!this.props.setting || !this.row))) return undefined as never
    const v = args.value as boolean
    this.props.policy.write(this.props.setting.key, v)
  }

}

/** What `useHooks()` gives (the types of the fields it fills). */
export type CheckboxRowHooks = ReturnType<CheckboxRow['useHooks']>

export default CheckboxRow.component()
