/**
 * Code-behind of `SettingsBlocks.kbcontrol` (converted from `SettingsBlocks.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { SettingItem } from "../moduleSettingSchema"

import { ViewBase } from './SettingsBlocks.kbcontrol'

export type SettingRowsProps = {
  basic:            SettingItem[]
  advanced:         SettingItem[]
  advancedOpen:     boolean
  onToggleAdvanced: () => void
  renderRow:        (item: SettingItem) => ReactNode
}

export class SettingsBlocks extends ViewBase {
  tr!: SettingsBlocksStores['t']

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

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_basic_map_render_row() {
    return this.memo('content_basic_map_render_row', [this.props], () => ({ children: this.props.basic.map(this.props.renderRow) }))
  }

  get show_advanced() {
    return this.props.advanced.length > 0
  }

  get show_not_advanced_open() {
    if (!(this.props.advanced.length > 0)) return undefined as never
    return !(this.props.advancedOpen)
  }

  get text() {
    if (!(this.props.advanced.length > 0)) return undefined as never
    return this.tr('admin.m_advanced', {
              count: this.props.advanced.length,
              defaultValue: `Avancé (${this.props.advanced.length})`,
            })
  }

  get content_advanced_open_advanced_map() {
    return this.memo('content_advanced_open_advanced_map', [this.props], () => {
      if (!(this.props.advanced.length > 0)) return undefined as never
      return ({ children: this.props.advancedOpen && this.props.advanced.map(this.props.renderRow) })
    })
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.advanced.length > 0)) return undefined as never
    this.props.onToggleAdvanced?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingsBlocksStores = ReturnType<SettingsBlocks['useStores']>

export default SettingsBlocks.component()
