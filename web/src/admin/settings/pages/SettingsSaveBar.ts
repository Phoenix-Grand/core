/**
 * Code-behind of `SettingsSaveBar.kbcontrol` (converted from `SettingsSaveBar.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { ViewBase } from './SettingsSaveBar.kbcontrol'

export interface SettingsSaveBarProps {
  /** Staged changes belonging to THIS section. Zero disables the write. */
  count:    number
  /** Staged changes waiting in another section, tab or page. */
  elsewhere?: number
  /** The way to reach them — a link, or a button that opens their section. */
  elsewhereAction?: ReactNode
  /** Values the module's own declaration refuses. Blocks the write. */
  invalid?:  number
  /** True while this section's write is in flight. */
  saving?:   boolean
  /** Flashes on the action for a moment after a successful write. */
  saved?:    boolean
  /**
   * The staged changes would create the first local value on this scope, so the
   * primary action is "override the inherited value" rather than "save".
   *
   * Writing a value on a scope that has none yet does something different from
   * updating one it already holds: the first REMOVES the unit from its parent's
   * authority for that key, for good, and every unit below it with it. Naming
   * both "Enregistrer" hides that.
   */
  overriding?: boolean
  onSave:   () => void
  onCancel: () => void
}

const ACTION = 'rounded px-3 py-1.5 uppercase transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

export class SettingsSaveBar extends ViewBase {
  tr!: SettingsSaveBarStores['t']

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

  get elsewhere() {
    return this.props.elsewhere ?? 0
  }

  get invalid() {
    return this.props.invalid ?? 0
  }

  get saving() {
    return this.props.saving ?? false
  }

  get saved() {
    return this.props.saved ?? false
  }

  get overriding() {
    return this.props.overriding ?? false
  }

  get blocked(): boolean {
    return this.invalid > 0
  }

  get disabled(): boolean {
    return this.props.count === 0 || this.blocked || this.saving
  }

  get show_blocked_elsewhere() {
    return this.blocked || this.elsewhere > 0
  }

  get span_class() {
    if (!((this.blocked || this.elsewhere > 0))) return undefined as never
    return `min-w-0 flex-1 ${this.blocked ? 'text-danger' : 'text-text-tertiary'}`
  }

  get show_not_blocked() {
    if (!((this.blocked || this.elsewhere > 0))) return undefined as never
    return !(this.blocked)
  }

  get text() {
    if (!((this.blocked || this.elsewhere > 0)) || !(this.blocked)) return undefined as never
    return this.tr('admin.m_invalid_values', {
                count: this.invalid,
                defaultValue: `${this.invalid} valeur(s) hors bornes`,
              })
  }

  get text2() {
    if (!((this.blocked || this.elsewhere > 0)) || !(!(this.blocked))) return undefined as never
    return this.tr('admin.m_pending_elsewhere_count', {
                  count: this.elsewhere,
                  defaultValue: `${this.elsewhere} autre(s) modification(s) non enregistrée(s)`,
                })
  }

  get show_elsewhere_action() {
    return this.memo('show_elsewhere_action', [this.props, this.blocked, this.elsewhere], () => {
      if (!((this.blocked || this.elsewhere > 0)) || !(!(this.blocked))) return undefined as never
      return !!(this.props.elsewhereAction)
    })
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_elsewhere_action() {
    return this.memo('content_elsewhere_action', [this.props, this.blocked, this.elsewhere], () => {
      if (!((this.blocked || this.elsewhere > 0)) || !(!(this.blocked)) || !(this.props.elsewhereAction)) return undefined as never
      return ({ children: this.props.elsewhereAction })
    })
  }

  get visible() {
    return this.memo('visible', [this.show_elsewhere_action, this.show_not_blocked, this.blocked, this.elsewhere], () => {
      if (!((this.blocked || this.elsewhere > 0))) return undefined as never
      return this.show_elsewhere_action && this.show_not_blocked
    })
  }

  get button_class() {
    return `${ACTION} text-text-secondary hover:bg-surface-1 hover:text-text-primary`
  }

  get button_class2() {
    return `${ACTION} ${this.disabled
            ? 'cursor-not-allowed text-text-tertiary'
            : 'text-primary hover:bg-surface-1'}`
  }

  get enabled_unless_disabled() {
    return !(this.disabled)
  }

  get text3() {
    return this.saved
            ? this.tr('admin.m_saved', { defaultValue: 'Enregistré' })
            : this.saving
              ? this.tr('admin.m_saving', { defaultValue: 'Enregistrement…' })
              : this.overriding
                ? this.tr('admin.m_override', { defaultValue: 'Remplacer' })
                : this.tr('common.save', { defaultValue: 'Enregistrer' })
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onCancel?.()
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    this.props.onSave?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingsSaveBarStores = ReturnType<SettingsSaveBar['useStores']>

export default SettingsSaveBar.component()
