/**
 * Code-behind of `ModuleSidePanel.kbcontrol` (converted from `ModuleSidePanel.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { moduleGlyph } from "../../nav/moduleGlyph"
import type { AdminModule, ModuleSettingGroup } from "../../adminModules"
import { useResolvedModuleSettings } from "../moduleScope"
import { INSTANCE_SCOPE, type ActiveScope } from "../scopeTypes"

import { ViewBase } from './ModuleSidePanel.kbcontrol'
import * as __parts from './ModuleSidePanel.parts.tsx'

export interface ModuleSidePanelProps {
  module: AdminModule
  /** The pages the module declares, in manifest order. Empty is the normal case. */
  groups: ModuleSettingGroup[]
  /** The page on screen — the row that wears the "you are here" pill. */
  activeGroup: string | null
  /** Does the module declare anything a unit may override? */
  scopable: boolean
  scope: ActiveScope
  onScopeChange: (next: ActiveScope) => void
}

export class ModuleSidePanel extends ViewBase {
  @bind accessor openPages = true
  @bind accessor openScope = true
  tr!: ModuleSidePanelStores['t']
  overridingUnits!: Set<string>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const instanceResolved = useResolvedModuleSettings(this.props.module.id, INSTANCE_SCOPE, this.props.scopable)
    const overridingUnits = useMemo(() => {
      const ids = new Set<string>()
      for (const s of instanceResolved.byKey.values()) {
        for (const o of s.overrides) if (o.scope_type === 'org_unit') ids.add(o.scope_id)
      }
      return ids
    }, [instanceResolved.byKey])
    this.publish({ overridingUnits })
    return { instanceResolved, overridingUnits }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ overridingUnits: h.overridingUnits })
  }

  get hasPages(): boolean {
    return this.props.groups.length > 0
  }

  get Glyph() {
    return this.memo('Glyph', [this.props, this.hasPages], () => {
      if (!(!(!this.hasPages && !this.props.scopable))) return undefined as never
      return moduleGlyph(this.props.module)
    })
  }

  get show_case_1() {
    return !!(!this.hasPages && !this.props.scopable)
  }

  get show_main() {
    return !(!this.hasPages && !this.props.scopable)
  }

  get show_glyph() {
    return this.memo('show_glyph', [this.Glyph, this.hasPages, this.props], () => {
      if (!(!(!this.hasPages && !this.props.scopable))) return undefined as never
      return !!(this.Glyph)
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.Glyph, this.hasPages, this.props], () => {
      if (!(!(!this.hasPages && !this.props.scopable)) || !(this.Glyph)) return undefined as never
      return ({ Glyph: this.Glyph })
    })
  }

  /** A part of the screen still written in React (<Glyph> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    if (!(!(!this.hasPages && !this.props.scopable)) || !(this.Glyph)) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.openPages, this.memo, this.props, this.hasPages], () => {
      if (!(!(!this.hasPages && !this.props.scopable)) || !(this.hasPages)) return undefined as never
      return ({ t: this.tr, openPages: this.openPages, setOpenPages: this.memo("setOpenPages:bound", [], () => this.setOpenPages.bind(this)), groups: this.props.groups, activeGroup: this.props.activeGroup, module: this.props.module })
    })
  }

  /** A part of the screen still written in React (<Section> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(!(!this.hasPages && !this.props.scopable)) || !(this.hasPages)) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.openScope, this.memo, this.props, this.overridingUnits, this.hasPages], () => {
      if (!(!(!this.hasPages && !this.props.scopable)) || !(this.props.scopable)) return undefined as never
      return ({ t: this.tr, openScope: this.openScope, setOpenScope: this.memo("setOpenScope:bound", [], () => this.setOpenScope.bind(this)), scope: this.props.scope, onScopeChange: this.props.onScopeChange, overridingUnits: this.overridingUnits })
    })
  }

  /** A part of the screen still written in React (<Section> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    if (!(!(!this.hasPages && !this.props.scopable)) || !(this.props.scopable)) return undefined as never
    return __parts.Part3
  }

  /** `setOpenPages` of the TSX: a value, or an update of the previous one. */
  setOpenPages(value: ModuleSidePanel['openPages'] | ((prev: ModuleSidePanel['openPages']) => ModuleSidePanel['openPages'])) {
    this.openPages = typeof value === 'function' ? (value as (prev: ModuleSidePanel['openPages']) => ModuleSidePanel['openPages'])(this.openPages) : value
  }

  /** `setOpenScope` of the TSX: a value, or an update of the previous one. */
  setOpenScope(value: ModuleSidePanel['openScope'] | ((prev: ModuleSidePanel['openScope']) => ModuleSidePanel['openScope'])) {
    this.openScope = typeof value === 'function' ? (value as (prev: ModuleSidePanel['openScope']) => ModuleSidePanel['openScope'])(this.openScope) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModuleSidePanelStores = ReturnType<ModuleSidePanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ModuleSidePanelHooks = ReturnType<ModuleSidePanel['useHooks']>

export default ModuleSidePanel.component()
