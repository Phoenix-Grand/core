/**
 * Code-behind of `AudienceDialog.kbview` (converted from `AudienceDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"

import { ViewBase } from './AudienceDialog.kbview'
import * as __parts from './AudienceDialog.parts'

const NAME_MAX = 40

const DESC_MAX = 150

export type AudienceDialogProps = {
  busy:     boolean
  error?:   string
  onSave:   (v: { name: string; description: string | null }) => void
  onCancel: () => void
}

export class AudienceDialog extends ViewBase {
  @bind accessor name = ''
  @bind accessor desc = ''
  tr!: AudienceDialogStores['t']

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

  get nameLen(): number {
    return [...this.name].length
  }

  get descLen(): number {
    return [...this.desc].length
  }

  get canSave(): boolean {
    return this.name.trim().length > 0 && this.nameLen <= NAME_MAX && this.descLen <= DESC_MAX && !this.props.busy
  }

  get enabled_unless_can_save() {
    return !(!this.canSave)
  }

  get enabled_unless_busy() {
    return !(this.props.busy)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.memo, this.nameLen], () => ({ t: this.tr, name: this.name, setName: this.memo("setName:bound", [], () => this.setName.bind(this)), nameLen: this.nameLen }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get error_text() {
    return this.descLen > DESC_MAX
              ? this.tr('admin.aud_desc_too_long', {
                  defaultValue_one: 'Trop long de {{count}} caractère.',
                  defaultValue: 'Trop long de {{count}} caractères.',
                  count: this.descLen - DESC_MAX,
                })
              : undefined
  }

  get aud_desc_hint_max() {
    return DESC_MAX
  }

  get show_error() {
    return !!(this.props.error)
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    this.props.onSave({ name: this.name.trim(), description: this.desc.trim() || null })
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onCancel?.()
  }

  /** `setName` of the TSX: a value, or an update of the previous one. */
  setName(value: AudienceDialog['name'] | ((prev: AudienceDialog['name']) => AudienceDialog['name'])) {
    this.name = typeof value === 'function' ? (value as (prev: AudienceDialog['name']) => AudienceDialog['name'])(this.name) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AudienceDialogStores = ReturnType<AudienceDialog['useStores']>

export default AudienceDialog.component()
