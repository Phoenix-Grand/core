/**
 * Code-behind of `SecurityTab.kbcontrol` (converted from `SecurityTab.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { api } from "../../../api/client"

import { ViewBase } from './SecurityTab.kbcontrol'

export class SecurityTab extends ViewBase {
  @bind accessor form = { old_password: '', new_password: '', confirm: '' }
  @bind accessor error = ''
  @bind accessor success = false
  tr!: SecurityTabStores['t']

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

  /** The rows of the Repeater over `(['old_password', 'new_password', 'confirm'] as const)`. */
  get rows_items() {
    return this.memo('rows_items', [this.tr, this.form], () => (['old_password', 'new_password', 'confirm'] as const).map((field) => {
      return { field, label: field === 'old_password' ? this.tr('settings.sec_old')
                : field === 'new_password' ? this.tr('settings.sec_new')
                : this.tr('settings.sec_confirm'), text: this.form[field], auto_complete: field === 'old_password' ? 'current-password' : 'new-password', key: field }
    }))
  }

  get show_error() {
    return !!(this.error)
  }

  async handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.error = ''
    if (this.form.new_password !== this.form.confirm) {
      this.error = this.tr('register.err_mismatch')
      return
    }
    try {
      await api.patch('/me/password', {
        old_password: this.form.old_password,
        new_password: this.form.new_password,
      })
      this.success = true
      this.form = { old_password: '', new_password: '', confirm: '' }
    } catch (err: unknown) {
      this.error = (err as { message?: string })?.message ?? this.tr('settings.error')
    }
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.handleSubmit(args.native as never)
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const { field } = args.row as RowOf_rows_items
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.form = ({ ...this.form, [field]: e.target.value })
  }

}

type RowOf_rows_items = SecurityTab['rows_items'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type SecurityTabStores = ReturnType<SecurityTab['useStores']>

export default SecurityTab.component()
