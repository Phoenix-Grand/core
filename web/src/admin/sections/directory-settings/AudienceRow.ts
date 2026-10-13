/**
 * Code-behind of `AudienceRow.kbcontrol` (converted from `AudienceRow.tsx` by @kubuno/views-migrate).
 */
import { type ValueChangedEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import ProvenanceLine from "../../settings/controls/ProvenanceLine"
import { AUDIENCE_OPTIONS } from "./keys"
import { type RowProps } from "./PolicyRow"

import { ViewBase } from './AudienceRow.kbcontrol'

export type { RowProps }

export class AudienceRow extends ViewBase {
  tr!: AudienceRowStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get current(): string {
    if (!(!(!this.props.setting))) return undefined as never
    return typeof this.props.setting.value === 'string' ? this.props.setting.value : AUDIENCE_OPTIONS[0]
  }

  get disabled(): boolean {
    if (!(!(!this.props.setting))) return undefined as never
    return this.props.readOnly || this.props.setting.locked_above
  }

  get show_case_1() {
    return !!(!this.props.setting)
  }

  get show_main() {
    return !(!this.props.setting)
  }

  get enabled_unless_disabled() {
    if (!(!(!this.props.setting))) return undefined as never
    return !(this.disabled)
  }

  /** The rows of the Repeater over `AUDIENCE_OPTIONS`. */
  get rows_audience_options() {
    return this.memo('rows_audience_options', [this.props, this.current, this.tr], () => {
      if (!(!(!this.props.setting))) return undefined as never
      return AUDIENCE_OPTIONS.map((option) => {
      return { option, selected_value: ((!(!this.props.setting))) ? (this.current === option) : undefined, text: ((!(!this.props.setting))) ? (this.tr(`admin.dirset_audience_${option}`)) : undefined, description: ((!(!this.props.setting))) ? (this.tr(`admin.dirset_audience_${option}_desc`)) : undefined, key: option }
    })
    })
  }

  /** `<ProvenanceLine>`, rendered by a ReactHost. */
  get ProvenanceLine() {
    if (!(!(!this.props.setting))) return undefined as never
    return ProvenanceLine
  }

  get provenance_line_props() {
    return this.memo('provenance_line_props', [this.props], () => {
      if (!(!(!this.props.setting))) return undefined as never
      const setting = this.props.setting
      return ({ setting: setting, onRevert: () => this.props.policy.revert(setting.key), onLock: locked => this.props.policy.lock(setting.key, locked), onShowChain: () => this.props.onShowChain(setting.key) } as React.ComponentProps<typeof ProvenanceLine>)
    })
  }

  radio_button_checked_changed(_sender: unknown, args: ValueChangedEventArgs) {
    const { option } = args.row as RowOf_rows_audience_options
    if (!(!(!this.props.setting))) return undefined as never
    this.props.policy.write(this.props.setting.key, option)
  }

}

type RowOf_rows_audience_options = AudienceRow['rows_audience_options'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type AudienceRowStores = ReturnType<AudienceRow['useStores']>

export default AudienceRow.component()
