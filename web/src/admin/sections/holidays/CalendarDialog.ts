/**
 * Code-behind of `CalendarDialog.kbview` (converted from `CalendarDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { errorMessage, useCreateCalendar } from "./api"

import { ViewBase } from './CalendarDialog.kbview'
import * as __parts from './CalendarDialog.parts'

export type CalendarDialogProps = {
  onClose: () => void
  onCreated: (id: string) => void
}

export class CalendarDialog extends ViewBase {
  @bind accessor name = ''
  @bind accessor country = ''
  @bind accessor error: string | null = null
  tr!: CalendarDialogStores['t']
  create!: CalendarDialogStores['create']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const create = useCreateCalendar()
    return { t, create }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, create: s.create })
  }

  get enabled_unless_create_is_pending_name() {
    return !(this.create.isPending || this.name.trim() === '')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.memo], () => ({ t: this.tr, name: this.name, setName: this.memo("setName:bound", [], () => this.setName.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_error() {
    return !!(this.error)
  }

  async submit() {
    this.error = null
    try {
      const created = await this.create.mutateAsync({
        name: this.name.trim(),
        country_code: this.country.trim() === '' ? undefined : this.country.trim().toUpperCase(),
      })
      this.props.onClose()
      this.props.onCreated(created.id)
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.hol_save_failed'))
    }
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    void this.submit()
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.country = e.target.value.toUpperCase()
  }

  /** `setName` of the TSX: a value, or an update of the previous one. */
  setName(value: CalendarDialog['name'] | ((prev: CalendarDialog['name']) => CalendarDialog['name'])) {
    this.name = typeof value === 'function' ? (value as (prev: CalendarDialog['name']) => CalendarDialog['name'])(this.name) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CalendarDialogStores = ReturnType<CalendarDialog['useStores']>

export default CalendarDialog.component()
