/**
 * Code-behind of `SettingsGroupPanel.kbview` (converted from `SettingsGroupPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../core/api/client"
import { PRIV } from "../../../core/authz/types"
import { usePrivileges } from "../../../core/authz/usePrivileges"
import SettingScopeBar from "../controls/SettingScopeBar"
import InheritanceChainWindow from "./InheritanceChainWindow"
import { settingLabel } from "../pages/SettingControl"
import { DEDICATED_EDITOR, ENUM_OPTIONS, FALLBACK_TAB, TIMEZONE_KEYS, VISIBLE_WHEN, isClaimed, specForTab } from "../settingsMap"
import { apiErrorDetail } from "../../../core/api/errorMessage"
import { INSTANCE_SCOPE, type ActiveScope, type ResolvedSetting, type ResolvedSettingsResponse } from "../scopeTypes"

import { ViewBase } from './SettingsGroupPanel.kbview'
import * as __parts from './SettingsGroupPanel.parts.tsx'

interface Props {
  /** Nav leaf id whose keys this block paints. */
  tab: string
  /**
   * How the block sits in its page.
   *   • `standalone` — the block IS the page (a pure-settings leaf). One
   *     readable column, whatever the count.
   *   • `tab` — the block is the "Réglages" tab beside a subsystem's content.
   *     It takes the full width the content established, and flows its
   *     categories into two columns once there are enough to fill them.
   * The block never wears a heading of its own: the page title or the tab
   * already names it, and a second "Réglages" heading only repeated that.
   */
  layout?: 'standalone' | 'tab'
}

export type { Props }

export class SettingsGroupPanel extends ViewBase {
  @bind accessor edits: Record<string, unknown> = {}
  @bind accessor saved = false
  @bind accessor error: string | null = null
  @bind accessor chainKey: string | null = null
  tr!: SettingsGroupPanelStores['t']
  queryClient!: SettingsGroupPanelStores['queryClient']
  can!: SettingsGroupPanelStores['can']
  scope!: ActiveScope
  setScope!: SettingsGroupPanelStores['setScope']
  params!: URLSearchParams
  highlightRef!: SettingsGroupPanelStores['highlightRef']
  settings!: SettingsGroupPanelHooks['settings']
  update!: SettingsGroupPanelHooks['update']
  revert!: SettingsGroupPanelHooks['revert']
  lock!: SettingsGroupPanelHooks['lock']
  sections!: { id: string; title: string; desc: string; items: ResolvedSetting[]; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { can } = usePrivileges()
    const [scope, setScope]   = useState<ActiveScope>(INSTANCE_SCOPE)
    const [params] = useSearchParams()
    const highlightRef = useRef<HTMLDivElement>(null)
    return { t, queryClient, can, scope, setScope, params, highlightRef }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const scope = this.scope
    const highlightRef = this.highlightRef
    const { data: settings } = useQuery({
      queryKey: ['admin-settings-resolved', scope.type, scope.id] as const,
      queryFn: () =>
        api
          .get<ResolvedSettingsResponse>('/admin/settings/resolved', { params: this.scopeParams })
          .then(r => r.data.settings),
      enabled: this.canRead,
    })
    this.publish({ settings })
    const update = useMutation({
      mutationFn: async (updates: Record<string, unknown>) => {
        // One request per key: a scoped write names its scope, and refusing one
        // key (a lock upstream) must not silently drop the others.
        for (const [key, value] of Object.entries(updates)) {
          await api.put(`/admin/settings/scoped/${encodeURIComponent(key)}`, {
            scope_type: scope.type,
            scope_id:   scope.id,
            value,
          })
        }
      },
      onSuccess: this.memo("afterWrite:bound", [], () => this.afterWrite.bind(this)),
      onError:   this.memo("reportError:bound", [], () => this.reportError.bind(this)),
    })
    this.publish({ update })
    const revert = useMutation({
      mutationFn: (key: string) =>
        api.delete(`/admin/settings/scoped/${encodeURIComponent(key)}`, { params: this.scopeParams }),
      onSuccess: this.memo("afterWrite:bound", [], () => this.afterWrite.bind(this)),
      onError:   this.memo("reportError:bound", [], () => this.reportError.bind(this)),
    })
    this.publish({ revert })
    const lock = useMutation({
      mutationFn: (p: { key: string; locked: boolean }) =>
        api.post(`/admin/settings/lock/${encodeURIComponent(p.key)}`, {
          scope_type: scope.type,
          scope_id:   scope.id,
          locked:     p.locked,
        }),
      onSuccess: this.memo("afterWrite:bound", [], () => this.afterWrite.bind(this)),
      onError:   this.memo("reportError:bound", [], () => this.reportError.bind(this)),
    })
    this.publish({ lock })
    useEffect(() => { this.edits = {}; this.error = null }, [scope.type, scope.id])
    const highlight = this.highlight
    useEffect(() => {
      if (!highlight || !highlightRef.current) return
      highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
      // `settings` is a dependency because the row does not exist before the list
      // has loaded, which is exactly when the deep link arrives.
    }, [highlight, settings])
    const sections = useMemo(() => {
      if (!settings) return []
      const byKey = new Map(settings.map(s => [s.key, s]))
      const out: { id: string; title: string; desc: string; items: ResolvedSetting[] }[] = []
    
      for (const group of specForTab(this.props.tab)?.groups ?? []) {
        const items = group.keys
          .map(k => byKey.get(k))
          .filter((s): s is ResolvedSetting => !!s && !(s.key in DEDICATED_EDITOR))
        if (items.length) {
          out.push({
            id:    group.id,
            title: t(`admin.sgrp_${group.id}`),
            desc:  t(`admin.sgrp_${group.id}_desc`, { defaultValue: '' }),
            items,
          })
        }
      }
    
      // The page of last resort collects whatever no page claims — a key added to
      // the core, or declared by a module, without an entry in the cartography.
      // Grouped by its declared category, which is all that is known about it.
      if (this.props.tab === FALLBACK_TAB) {
        const orphans = settings.filter(s => !isClaimed(s.key))
        const cats = [...new Set(orphans.map(s => s.category))].sort()
        for (const cat of cats) {
          out.push({
            id:    `cat:${cat}`,
            title: t(`admin.cat_${cat}`, { defaultValue: cat }),
            desc:  t('admin.sgrp_unfiled_desc'),
            items: orphans.filter(s => s.category === cat),
          })
        }
      }
      return out
    }, [settings, this.props.tab, t])
    this.publish({ sections })
    return { settings, update, revert, lock, sections }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, queryClient: s.queryClient, can: s.can, scope: s.scope, setScope: s.setScope, params: s.params, highlightRef: s.highlightRef })
    const h = this.useHooks()
    this.publish({ settings: h.settings, update: h.update, revert: h.revert, lock: h.lock, sections: h.sections })
  }

  get layout() {
    return this.props.layout ?? 'standalone'
  }

  get canRead(): boolean {
    return this.can(PRIV.SETTINGS_READ)
  }

  get canManage(): boolean {
    return this.can(PRIV.SETTINGS_MANAGE)
  }

  get highlight(): string | null {
    return this.params.get('highlight')
  }

  get scopeParams(): { scope_type: "instance" | "org_unit"; scope_id: string | undefined; } {
    return this.memo('scopeParams', [this.scope], () => ({ scope_type: this.scope.type, scope_id: this.scope.id ?? undefined }))
  }

  get pendingKeys(): string[] {
    return this.memo('pendingKeys', [this.edits, this.settings], () => {
      const settings = this.settings
      return Object.keys(this.edits).filter(k => {
    const s = settings?.find(x => x.key === k)
    return s ? this.isBuffered(s) : false
  })
    })
  }

  get chainSetting(): ResolvedSetting | undefined {
    return this.memo('chainSetting', [this.settings, this.canRead, this.sections, this.chainKey], () => {
      if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
      const chainKey = this.chainKey
      return chainKey ? this.settings.find(s => s.key === chainKey) : undefined
    })
  }

  get twoColumn(): boolean {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return this.layout === 'tab' && this.sections.length >= 2
  }

  get containerClass(): "w-full" | "max-w-2xl" {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return this.twoColumn ? 'w-full' : 'max-w-2xl'
  }

  get show_case_1() {
    return !!(!this.canRead || !this.settings || this.sections.length === 0)
  }

  get show_main() {
    return !(!this.canRead || !this.settings || this.sections.length === 0)
  }

  /** `<SettingScopeBar>`, rendered by a ReactHost. */
  get SettingScopeBar() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return SettingScopeBar
  }

  get setting_scope_bar_props() {
    return this.memo('setting_scope_bar_props', [this.scope, this.setScope, this.canRead, this.settings, this.sections], () => {
      if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
      return ({ scope: this.scope, onChange: this.setScope, sticky: true })
    })
  }

  get show_can_manage() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return !this.canManage
  }

  get show_error() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return !!(this.error)
  }

  get div_class() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return this.twoColumn ? 'lg:columns-2 lg:gap-x-10' : ''
  }

  get section_class() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return `mb-8 ${this.twoColumn ? 'break-inside-avoid' : ''}`
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part1() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return __parts.Part1
  }

  /** The rows of the Repeater over `sections`. */
  get rows_sections() {
    return this.memo('rows_sections', [this.sections, this.canRead, this.settings, this.memo, this.edits, this.canManage, this.update, this.highlight, this.highlightRef, this.revert, this.lock, this.chainKey], () => {
      if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
      return this.sections.map((section) => {
      return { section, show_section_desc: ((!(!this.canRead || !this.settings || this.sections.length === 0))) ? (!!(section.desc)) : undefined, part1_props: ((!(!this.canRead || !this.settings || this.sections.length === 0))) ? ({ section: section, visibleForBranch: this.memo("visibleForBranch:bound", [], () => this.visibleForBranch.bind(this)), currentValue: this.memo("currentValue:bound", [], () => this.currentValue.bind(this)), canManage: this.canManage, setEdits: this.memo("setEdits:bound", [], () => this.setEdits.bind(this)), update: this.update, highlight: this.highlight, highlightRef: this.highlightRef, revert: this.revert, lock: this.lock, setChainKey: this.memo("setChainKey:bound", [], () => this.setChainKey.bind(this)) }) : undefined, key: section.id }
    })
    })
  }

  get show_pending_keys() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return this.pendingKeys.length > 0
  }

  get button_text() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0)) || !(this.pendingKeys.length > 0)) return undefined as never
    return this.saved ? this.tr('settings.profile_saved') : this.tr('admin.save_changes')
  }

  get show_chain_key() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return !!(this.chainKey)
  }

  /** `<InheritanceChainWindow>`, rendered by a ReactHost. */
  get InheritanceChainWindow() {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0)) || !(this.chainKey)) return undefined as never
    return InheritanceChainWindow
  }

  get inheritance_chain_window_props() {
    return this.memo('inheritance_chain_window_props', [this.chainKey, this.scope, this.chainSetting, this.tr, this.canRead, this.settings, this.sections], () => {
      if (!(!(!this.canRead || !this.settings || this.sections.length === 0)) || !(this.chainKey)) return undefined as never
      return ({ settingKey: this.chainKey, scope: this.scope, title: this.chainSetting ? settingLabel(this.tr, this.chainSetting) : undefined, onClose: () => this.chainKey = null } as React.ComponentProps<typeof InheritanceChainWindow>)
    })
  }

  async afterWrite() {
    this.saved = true
    this.error = null
    setTimeout(() => this.saved = false, 2000)
    await this.queryClient.invalidateQueries({ queryKey: ['admin-settings-resolved'] })
    await this.queryClient.invalidateQueries({ queryKey: ['setting-chain'] })
    // The CAPTCHA preview reads the SAVED configuration; refresh it once a write
    // has landed, so switching the type — or tuning it — updates the example.
    await this.queryClient.invalidateQueries({ queryKey: ['captcha-preview'] })
    this.edits = {}
  }

  reportError(e: unknown) {
    const detail = apiErrorDetail(e)
    this.error = detail ?? this.tr('admin.setting_write_failed')
  }

  isBuffered(s: ResolvedSetting) {
    return typeof s.value !== 'boolean'
    && s.key !== 'auth.api_token_allowed_roles'
    && !(s.key in ENUM_OPTIONS)
    && !TIMEZONE_KEYS.has(s.key)
  }

  currentValue(s: ResolvedSetting) {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    return (s.key in this.edits ? this.edits[s.key] : s.value)
  }

  visibleForBranch(s: ResolvedSetting): boolean {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0))) return undefined as never
    const rule = VISIBLE_WHEN[s.key]
    if (!rule) return true
    const controller = this.settings.find(x => x.key === rule.key)
    if (!controller) return true
    return rule.in.includes(String(this.currentValue(controller)))
  }

  callout_dismiss(_sender: unknown, _args: EventArgs) {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0)) || !(this.error)) return undefined as never
    this.error = null
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0)) || !(this.pendingKeys.length > 0)) return undefined as never
    this.update.mutate(
              Object.fromEntries(this.pendingKeys.map(k => [k, this.edits[k]]))
            )
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(!this.canRead || !this.settings || this.sections.length === 0)) || !(this.pendingKeys.length > 0)) return undefined as never
    this.edits = {}
  }

  /** `setEdits` of the TSX: a value, or an update of the previous one. */
  setEdits(value: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>)) {
    this.edits = typeof value === 'function' ? (value as (prev: Record<string, unknown>) => Record<string, unknown>)(this.edits) : value
  }

  /** `setChainKey` of the TSX: a value, or an update of the previous one. */
  setChainKey(value: string | null | ((prev: string | null) => string | null)) {
    this.chainKey = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.chainKey) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingsGroupPanelStores = ReturnType<SettingsGroupPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type SettingsGroupPanelHooks = ReturnType<SettingsGroupPanel['useHooks']>

export default SettingsGroupPanel.component()
