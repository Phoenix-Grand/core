/**
 * Code-behind of `ProvenanceLine.kbcontrol` (converted from `ProvenanceLine.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { CornerDownRight, Lock } from "lucide-react"
import { useMenuDropdown, type MenuItem } from "@ui"
import { useUiTheme } from "../../../core/hooks/useUiTheme"
import type { ResolvedSetting, ScopeType } from "../scopeTypes"

import { ViewBase } from './ProvenanceLine.kbcontrol'
import * as __parts from './ProvenanceLine.parts.tsx'

export function scopeLabel(
  t: (k: string, o?: Record<string, unknown>) => string,
  scopeType: ScopeType | undefined,
  name: string | null | undefined,
): string {
  if (name) return name
  switch (scopeType) {
    case 'instance': return t('admin.scope_instance')
    case 'default':  return t('admin.scope_factory')
    case 'org_unit': return t('admin.scope_org_unit')
    case 'group':    return t('admin.scope_group')
    case 'user':     return t('admin.scope_user')
    default:         return t('admin.scope_factory')
  }
}

export type ProvenanceLineProps = {
  setting:     ResolvedSetting
  onRevert:    () => void
  onLock:      (locked: boolean) => void
  onShowChain: () => void
}

export class ProvenanceLine extends ViewBase {
  tr!: ProvenanceLineStores['t']
  menu!: ProvenanceLineStores['menu']
  theme!: ProvenanceLineStores['theme']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const menu = useMenuDropdown()
    const theme = useUiTheme()
    return { t, menu, theme }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, menu: s.menu, theme: s.theme })
  }

  get locked(): boolean {
    return this.props.setting.locked_above
  }

  get own(): boolean {
    const setting = this.props.setting
    const locked = setting.locked_above
    return setting.has_own_value && !locked
  }

  get fromName(): string {
    return scopeLabel(this.tr, this.props.setting.source?.scope_type, this.props.setting.source?.scope_name)
  }

  get lockName(): string {
    return scopeLabel(this.tr, this.props.setting.lock_source?.scope_type, this.props.setting.lock_source?.scope_name)
  }

  get items(): MenuItem[] {
    return this.memo('items', [this.tr, this.props], () => {
      const setting = this.props.setting
      const locked = setting.locked_above
      return [
    {
      type: 'action',
      label: this.tr('admin.setting_revert'),
      icon: <CornerDownRight size={15} />,
      // Nothing to revert when the value is already inherited, and a lock above
      // forbids touching this level at all.
      disabled: !setting.has_own_value || locked,
      onClick: this.props.onRevert,
    },
    {
      type: 'action',
      label: setting.locked_here ? this.tr('admin.setting_unlock') : this.tr('admin.setting_lock'),
      icon: <Lock size={15} />,
      // Locking pins a value for the levels below, so there must be one here.
      disabled: locked || (!setting.locked_here && !setting.has_own_value),
      onClick: () => this.props.onLock(!setting.locked_here),
    },
    { type: 'separator' },
    { type: 'action', label: this.tr('admin.setting_chain'), onClick: this.props.onShowChain },
  ]
    })
  }

  get show_not_locked() {
    return !(this.locked)
  }

  get show_not_own() {
    if (!(!(this.locked))) return undefined as never
    return !(this.own)
  }

  get visible() {
    return this.memo('visible', [this.own, this.show_not_locked], () => this.own && this.show_not_locked)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_own, this.show_not_locked], () => this.show_not_own && this.show_not_locked)
  }

  get show_setting_overrides() {
    return this.props.setting.overrides.length > 0
  }

  get show_menu_pos() {
    return this.memo('show_menu_pos', [this.menu], () => !!(this.menu.pos))
  }

  get part1_props() {
    return this.memo('part1_props', [this.items, this.menu, this.theme], () => {
      if (!(this.menu.pos)) return undefined as never
      return ({ items: this.items, menu_pos: this.menu?.pos, menu: this.menu, theme: this.theme })
    })
  }

  /** A part of the screen still written in React (<ContextMenu> pos, onClose, theme: no .kbview property). */
  get Part1() {
    if (!(this.menu.pos)) return undefined as never
    return __parts.Part1
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.setting.overrides.length > 0)) return undefined as never
    this.props.onShowChain?.()
  }

  panel_click2(_sender: unknown, args: MouseEventArgs) {
    return (this.menu.open)?.(args.native as never)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ProvenanceLineStores = ReturnType<ProvenanceLine['useStores']>

export default ProvenanceLine.component()
