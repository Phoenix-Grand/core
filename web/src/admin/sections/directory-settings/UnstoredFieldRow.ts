/**
 * Code-behind of `UnstoredFieldRow.kbcontrol` (converted from `UnstoredFieldRow.tsx` by @kubuno/views-migrate).
 */
import { type ValueChangedEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"

import { ViewBase } from './UnstoredFieldRow.kbcontrol'

export type UnstoredFieldRowProps = { field: string }

export class UnstoredFieldRow extends ViewBase {
  tr!: UnstoredFieldRowStores['t']

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

  get text() {
    return this.tr(`admin.dirset_field_${this.props.field}`)
  }

  check_box_checked_changed(_sender: unknown, _args: ValueChangedEventArgs) {
}

}

/** What `useStores()` gives (the types of the fields it fills). */
export type UnstoredFieldRowStores = ReturnType<UnstoredFieldRow['useStores']>

export default UnstoredFieldRow.component()
