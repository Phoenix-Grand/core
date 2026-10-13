/**
 * Code-behind of `ModuleAdminSettings.kbcontrol` (converted from `ModuleAdminSettings.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { ConfirmDialog } from "@ui"
import { useConfirm } from "../../core/hooks/useConfirm"
import { adminPath } from "../adminRoute"
import type { ModuleSettingGroup } from "../adminModules"
import type { ModuleAdminSection } from "../../core/slots/SlotRegistry"
import { findIcon } from "../../core/utils/iconMap"
import ModuleSettingRow from "../settings/pages/ModuleSettingRow"
import SettingRows from "../settings/pages/SettingsBlocks"
import SettingSectionCard from "../settings/pages/SettingSectionCard"
import SettingsSaveBar from "../settings/pages/SettingsSaveBar"
import ScopeStatusPill from "../settings/pages/ScopeStatusPill"
import ProvenanceLine from "../settings/controls/ProvenanceLine"
import InheritanceChainWindow from "../settings/views/InheritanceChainWindow"
import { hasScopableSettings, prefixedKey, useResolvedModuleSettings } from "../settings/moduleScope"
import { INSTANCE_SCOPE, type ActiveScope, type ResolvedSetting } from "../settings/scopeTypes"
import { isVisible, outOfRange, sameValue, type SettingItem } from "../settings/moduleSettingSchema"
import { apiErrorDetail } from "../../core/api/errorMessage"
import ScopeHeadline from "../settings/pages/ScopeHeadline"

import { ViewBase } from './ModuleAdminSettings.kbcontrol'
import * as __parts from './ModuleAdminSettings.parts.tsx'

export function useModuleInstanceSettings(moduleId: string, enabled = true) {
  const query = useQuery({
    queryKey: ['module-config', moduleId],
    queryFn:  () => api.get<{ settings: SettingItem[] }>(`/modules/${moduleId}/config`).then(r => r.data),
    enabled,
  })
  const items = useMemo(
    () => (query.data?.settings ?? []).filter(s => s.scope === 'global' || s.scope === 'overridable'),
    [query.data],
  )
  return { items, isLoading: query.isLoading, isError: query.isError, refetch: query.refetch }
}

function pageOf(item: SettingItem, known: Set<string>, fallback: string): string {
  const declared = item.group ?? ''
  return known.has(declared) ? declared : fallback
}

export interface ModuleAdminSettingsProps {
  moduleId: string
  /** The page being shown. `null` = the module declares none (single stack). */
  group?:   string | null
  /** Every page the module declares — what the filter names its hits by. */
  groups?:  ModuleSettingGroup[]
  /** The module's own views that asked for a tab on THIS page. */
  extraTabs?: ModuleAdminSection[]
  /** WHO the values on screen belong to — chosen in the page's side card. */
  scope?:   ActiveScope
}

export class ModuleAdminSettings extends ViewBase {
  @bind accessor edits: Record<string, unknown> = {}
  @bind accessor busySection: string | null = null
  @bind accessor savedSection: string | null = null
  @bind accessor error: string | null = null
  @bind accessor filter = ''
  @bind accessor opened: Record<string, boolean> = {}
  @bind accessor advOpen: Record<string, boolean> = {}
  @bind accessor tab: string | null = null
  @bind accessor chainKey: string | null = null
  tr!: ModuleAdminSettingsStores['t']
  qc!: ModuleAdminSettingsStores['qc']
  items!: SettingItem[]
  isLoading!: boolean
  confirm!: ModuleAdminSettingsStores['confirm']
  confirmState!: ModuleAdminSettingsStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  instanceResolved!: { byKey: Map<string, ResolvedSetting>; isLoading: boolean; isError: boolean; }
  unitResolved!: { byKey: Map<string, ResolvedSetting>; isLoading: boolean; isError: boolean; }
  byKey!: Map<string, SettingItem>
  invalidKeys!: Set<string>
  save!: ModuleAdminSettingsHooks['save']
  revert!: ModuleAdminSettingsHooks['revert']
  lock!: ModuleAdminSettingsHooks['lock']
  groupIds!: Set<string>
  matches!: SettingItem[] | null
  pageCategories!: { category: string; basic: SettingItem[]; advanced: SettingItem[]; all: SettingItem[]; }[]
  tabs!: { id: string; label: string; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, qc, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const { items, isLoading } = useModuleInstanceSettings(this.props.moduleId)
    this.publish({ items, isLoading })
    const instanceResolved = useResolvedModuleSettings(this.props.moduleId, INSTANCE_SCOPE, this.scopable)
    this.publish({ instanceResolved })
    const unitResolved     = useResolvedModuleSettings(this.props.moduleId, this.scope, this.scoped)
    this.publish({ unitResolved })
    useEffect(() => { this.edits = {}; this.error = null }, [this.scope.type, this.scope.id])
    const byKey = useMemo(() => new Map(items.map(s => [s.key, s])), [items])
    this.publish({ byKey })
    const invalidKeys = useMemo(() => {
      const bad = new Set<string>()
      for (const key of Object.keys(this.edits)) {
        const item = byKey.get(key)
        if (item && outOfRange(item, this.edits[key])) bad.add(key)
      }
      return bad
    }, [this.edits, byKey])
    this.publish({ invalidKeys })
    const save = useMutation({
      mutationFn: async (changes: Record<string, unknown>) => {
        if (this.scope.type === 'instance') {
          const payload: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(changes)) payload[prefixedKey(this.props.moduleId, k)] = v
          await api.patch('/admin/settings', payload)
          return
        }
        for (const [k, v] of Object.entries(changes)) {
          await api.put(`/admin/settings/scoped/${encodeURIComponent(prefixedKey(this.props.moduleId, k))}`, {
            scope_type: this.scope.type,
            scope_id:   this.scope.id,
            value:      v,
          })
        }
      },
      onSuccess: (_data, changes) => this.afterWrite(Object.keys(changes)),
      onError:   this.memo("reportError:bound", [], () => this.reportError.bind(this)),
    })
    this.publish({ save })
    const revert = useMutation({
      mutationFn: (key: string) =>
        api.delete(`/admin/settings/scoped/${encodeURIComponent(prefixedKey(this.props.moduleId, key))}`, {
          params: { scope_type: this.scope.type, scope_id: this.scope.id ?? undefined },
        }),
      onSuccess: (_data, key) => this.afterWrite([key]),
      onError:   this.memo("reportError:bound", [], () => this.reportError.bind(this)),
    })
    this.publish({ revert })
    const lock = useMutation({
      mutationFn: (p: { key: string; locked: boolean }) =>
        api.post(`/admin/settings/lock/${encodeURIComponent(prefixedKey(this.props.moduleId, p.key))}`, {
          scope_type: this.scope.type,
          scope_id:   this.scope.id,
          locked:     p.locked,
        }),
      onSuccess: (_data, p) => this.afterWrite([p.key]),
      onError:   this.memo("reportError:bound", [], () => this.reportError.bind(this)),
    })
    this.publish({ lock })
    const groupIds   = useMemo(() => new Set(this.groups.map(g => g.id)), [this.groups])
    this.publish({ groupIds })
    const groupLabel = useMemo(() => new Map(this.groups.map(g => [g.id, g.label])), [this.groups])
    const matches = useMemo(() => {
      const needle = this.filter.trim().toLowerCase()
      if (!needle) return null
      const hit = (s: SettingItem) =>
        (s.label ?? '').toLowerCase().includes(needle) ||
        (s.description ?? '').toLowerCase().includes(needle) ||
        s.key.toLowerCase().includes(needle) ||
        s.category.toLowerCase().includes(needle) ||
        (groupLabel.get(s.group ?? '') ?? '').toLowerCase().includes(needle)
      return items.filter(s => this.visible(s) && hit(s))
      // `edits` matters: switching a gate off must re-run the visibility pass.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [items, this.filter, this.edits, byKey, groupLabel])
    this.publish({ matches })
    const pageItems = useMemo(
      () => (this.paged ? items.filter(s => pageOf(s, groupIds, this.firstGroup) === this.page) : items),
      [items, this.paged, groupIds, this.firstGroup, this.page],
    )
    const pageCategories = useMemo(
      () => this.splitByCategory(pageItems.filter(this.memo("visible:bound", [], () => this.visible.bind(this)))),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [pageItems, this.edits, byKey, t],
    )
    this.publish({ pageCategories })
    const tabs = useMemo(() => [
      ...pageCategories.map(c => ({ id: `${this.CATEGORY_TAB}${c.category}`, label: c.category })),
      ...this.extraTabs.map(s => ({
        id:    `sec:${s.id}`,
        label: s.labelKey ? t(s.labelKey, { defaultValue: s.label ?? s.id }) : (s.label ?? s.id),
        icon:  findIcon(s.icon) ?? undefined,
      })),
    ], [pageCategories, this.extraTabs, t])
    this.publish({ tabs })
    return { items, isLoading, instanceResolved, unitResolved, byKey, invalidKeys, save, revert, lock, groupIds, groupLabel, matches, pageItems, pageCategories, tabs }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ items: h.items, isLoading: h.isLoading, instanceResolved: h.instanceResolved, unitResolved: h.unitResolved, byKey: h.byKey, invalidKeys: h.invalidKeys, save: h.save, revert: h.revert, lock: h.lock, groupIds: h.groupIds, matches: h.matches, pageCategories: h.pageCategories, tabs: h.tabs })
  }

  get group() {
    return this.props.group ?? null
  }

  get groups() {
    return this.props.groups ?? []
  }

  get extraTabs() {
    return this.props.extraTabs ?? []
  }

  get scope() {
    return this.props.scope ?? INSTANCE_SCOPE
  }

  get scopable(): boolean {
    return hasScopableSettings(this.items)
  }

  get scoped(): boolean {
    return this.scopable && this.scope.type === 'org_unit'
  }

  get resolvedByKey(): Map<string, ResolvedSetting> {
    return this.memo('resolvedByKey', [this.scoped, this.unitResolved, this.instanceResolved], () => this.scoped ? this.unitResolved.byKey : this.instanceResolved.byKey)
  }

  get paged(): boolean {
    return this.groups.length > 0
  }

  get firstGroup(): string {
    return this.groups[0]?.id ?? ''
  }

  get page(): string {
    return this.paged ? (this.groupIds.has(this.group ?? '') ? (this.group as string) : this.firstGroup) : ''
  }

  get filtering(): boolean {
    return this.filter.trim().length > 0
  }

  get CATEGORY_TAB(): "cat:" {
    return 'cat:'
  }

  get activeTab(): string {
    const tab = this.tab
    return this.tabs.some(x => x.id === tab) ? (tab as string) : (this.tabs[0]?.id ?? '')
  }

  get dirtyCount(): number {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return Object.keys(this.edits).length
  }

  get scopeAside() {
    return this.memo('scopeAside', [this.scope, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return (
    <div className="[&>div]:mb-0 [&>div]:border-0 [&>div]:pb-0">
      <ScopeHeadline scope={this.scope} />
    </div>
  )
    })
  }

  get ExtraTab() {
    return this.memo('ExtraTab', [this.activeTab, this.extraTabs, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.activeTab.startsWith('sec:')
    ? this.extraTabs.find(s => `sec:${s.id}` === this.activeTab)?.Component ?? null
    : null
    })
  }

  get activeCategory(): { category: string; basic: SettingItem[]; advanced: SettingItem[]; all: SettingItem[]; } | null {
    return this.memo('activeCategory', [this.activeTab, this.CATEGORY_TAB, this.pageCategories, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.activeTab.startsWith(this.CATEGORY_TAB)
    ? this.pageCategories.find(c => `${this.CATEGORY_TAB}${c.category}` === this.activeTab) ?? null
    : null
    })
  }

  get showsSections(): boolean {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return this.filtering
    ? (this.matches?.length ?? 0) > 0
    : this.paged
      ? !this.ExtraTab && !!this.activeCategory
      : this.pageCategories.length > 0
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.items.length === 0)
  }

  get show_main() {
    return !(this.isLoading) && !(this.items.length === 0)
  }

  get placeholder() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return this.paged
                ? this.tr('admin.m_filter_all_settings', { defaultValue: 'Filtrer tous les réglages du module…' })
                : this.tr('admin.m_filter_settings', { defaultValue: 'Filtrer les réglages…' })
  }

  get show_filtering_matches() {
    return this.memo('show_filtering_matches', [this.filtering, this.matches, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return !!(this.filtering && this.matches)
    })
  }

  get m_filter_scope_count() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.filtering && this.matches)) return undefined as never
    return this.matches.length
  }

  get p_text() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.filtering && this.matches)) return undefined as never
    return this.tr('admin.m_filter_scope', {
                count: this.matches.length,
                defaultValue: `${this.matches.length} réglage(s) trouvé(s) dans tout le module`,
              })
  }

  get show_error() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return !!(this.error)
  }

  get show_not_filtering() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return !(this.filtering)
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_render_matches_matches() {
    return this.memo('content_render_matches_matches', [this.isLoading, this.items, this.tr, this.paged, this.props, this.scoped, this.resolvedByKey, this.edits, this.filtering, this.opened, this.scopeAside, this.byKey, this.groupIds, this.firstGroup, this.page, this.tab, this.CATEGORY_TAB, this.invalidKeys, this.busySection, this.savedSection, this.confirm, this.save, this.advOpen, this.memo, this.scopable, this.revert, this.lock, this.chainKey, this.groups, this.matches], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.filtering)) return undefined as never
      return ({ children: this.renderMatches(this.matches ?? []) })
    })
  }

  get show_not_paged() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering))) return undefined as never
    return !(this.paged)
  }

  get show_tabs() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged)) return undefined as never
    return this.tabs.length > 1
  }

  get part1_props() {
    return this.memo('part1_props', [this.tabs, this.activeTab, this.memo, this.tab, this.tr, this.isLoading, this.items, this.filtering, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(this.tabs.length > 1)) return undefined as never
      return ({ tabs: this.tabs, activeTab: this.activeTab, setTab: this.memo("setTab:bound", [], () => this.setTab.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Tabs> tabs: no .kbview property). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(this.tabs.length > 1)) return undefined as never
    return __parts.Part1
  }

  get show_extra_tab() {
    return this.memo('show_extra_tab', [this.ExtraTab, this.isLoading, this.items, this.filtering, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged)) return undefined as never
      return !!(this.ExtraTab)
    })
  }

  get show_not_extra_tab() {
    return this.memo('show_not_extra_tab', [this.ExtraTab, this.isLoading, this.items, this.filtering, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged)) return undefined as never
      return !(this.ExtraTab)
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.ExtraTab, this.isLoading, this.items, this.filtering, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(this.ExtraTab)) return undefined as never
      return ({ ExtraTab: this.ExtraTab })
    })
  }

  /** A part of the screen still written in React (<ExtraTab> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(this.ExtraTab)) return undefined as never
    return __parts.Part2
  }

  get show_active_category() {
    return this.memo('show_active_category', [this.activeCategory, this.isLoading, this.items, this.filtering, this.paged, this.ExtraTab], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(!(this.ExtraTab))) return undefined as never
      return !!(this.activeCategory)
    })
  }

  get show_not_active_category() {
    return this.memo('show_not_active_category', [this.activeCategory, this.isLoading, this.items, this.filtering, this.paged, this.ExtraTab], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(!(this.ExtraTab))) return undefined as never
      return !(this.activeCategory)
    })
  }

  get content_category_section_active_tab_active_categ() {
    return this.memo('content_category_section_active_tab_active_categ', [this.isLoading, this.items, this.scoped, this.resolvedByKey, this.edits, this.tr, this.filtering, this.opened, this.scopeAside, this.byKey, this.paged, this.groupIds, this.firstGroup, this.page, this.props, this.tab, this.CATEGORY_TAB, this.invalidKeys, this.busySection, this.savedSection, this.confirm, this.save, this.advOpen, this.memo, this.scopable, this.revert, this.lock, this.chainKey, this.activeTab, this.activeCategory, this.ExtraTab], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(!(this.ExtraTab)) || !(this.activeCategory)) return undefined as never
      return ({ children: this.categorySection(
                this.activeTab, this.activeCategory.category,
                this.activeCategory.basic, this.activeCategory.advanced, true,
              ) })
    })
  }

  get p_text2() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged) || !(!(this.ExtraTab)) || !(!(this.activeCategory))) return undefined as never
    return this.tr('admin.m_group_empty', {
                  count: this.items.length,
                  defaultValue: `Cette page ne contient aucun réglage. Le filtre ci-dessus cherche dans les ${this.items.length} réglages du module.`,
                })
  }

  get visible2() {
    return this.memo('visible2', [this.show_active_category, this.show_not_extra_tab, this.isLoading, this.items, this.filtering, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged)) return undefined as never
      return this.show_active_category && this.show_not_extra_tab
    })
  }

  get visible3() {
    return this.memo('visible3', [this.show_not_active_category, this.show_not_extra_tab, this.isLoading, this.items, this.filtering, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(this.paged)) return undefined as never
      return this.show_not_active_category && this.show_not_extra_tab
    })
  }

  get visible4() {
    return this.memo('visible4', [this.show_tabs, this.paged, this.isLoading, this.items, this.filtering], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering))) return undefined as never
      return this.show_tabs && this.paged
    })
  }

  get visible5() {
    return this.memo('visible5', [this.show_extra_tab, this.paged, this.isLoading, this.items, this.filtering], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering))) return undefined as never
      return this.show_extra_tab && this.paged
    })
  }

  get visible6() {
    return this.memo('visible6', [this.visible2, this.paged, this.isLoading, this.items, this.filtering], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering))) return undefined as never
      return this.visible2 && this.paged
    })
  }

  get visible7() {
    return this.memo('visible7', [this.visible3, this.paged, this.isLoading, this.items, this.filtering], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering))) return undefined as never
      return this.visible3 && this.paged
    })
  }

  get part3_props() {
    return this.memo('part3_props', [this.pageCategories, this.memo, this.isLoading, this.items, this.scoped, this.resolvedByKey, this.edits, this.tr, this.filtering, this.opened, this.scopeAside, this.byKey, this.paged, this.groupIds, this.firstGroup, this.page, this.props, this.tab, this.CATEGORY_TAB, this.invalidKeys, this.busySection, this.savedSection, this.confirm, this.save, this.advOpen, this.scopable, this.revert, this.lock, this.chainKey], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(!(this.paged))) return undefined as never
      return ({ pageCategories: this.pageCategories, categorySection: this.memo("categorySection:bound", [], () => this.categorySection.bind(this)) })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part3() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!(this.filtering)) || !(!(this.paged))) return undefined as never
    return __parts.Part3
  }

  get visible8() {
    return this.memo('visible8', [this.visible4, this.show_not_filtering, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.visible4 && this.show_not_filtering
    })
  }

  get visible9() {
    return this.memo('visible9', [this.visible5, this.show_not_filtering, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.visible5 && this.show_not_filtering
    })
  }

  get visible10() {
    return this.memo('visible10', [this.visible6, this.show_not_filtering, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.visible6 && this.show_not_filtering
    })
  }

  get visible11() {
    return this.memo('visible11', [this.visible7, this.show_not_filtering, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.visible7 && this.show_not_filtering
    })
  }

  get visible12() {
    return this.memo('visible12', [this.show_not_paged, this.show_not_filtering, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return this.show_not_paged && this.show_not_filtering
    })
  }

  get show_shows_sections_dirty_count() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return !this.showsSections && this.dirtyCount > 0
  }

  get text() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!this.showsSections && this.dirtyCount > 0)) return undefined as never
    return this.tr('admin.m_pending_elsewhere_count', {
              count: this.dirtyCount,
              defaultValue: `${this.dirtyCount} autre(s) modification(s) non enregistrée(s)`,
            })
  }

  get content_elsewhere_action_object_keys() {
    return this.memo('content_elsewhere_action_object_keys', [this.isLoading, this.items, this.byKey, this.tr, this.paged, this.groupIds, this.firstGroup, this.page, this.props, this.tab, this.CATEGORY_TAB, this.opened, this.edits, this.showsSections, this.dirtyCount], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(!this.showsSections && this.dirtyCount > 0)) return undefined as never
      return ({ children: this.elsewhereAction(Object.keys(this.edits)) })
    })
  }

  get show_chain_key() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return !!(this.chainKey)
  }

  /** `<InheritanceChainWindow>`, rendered by a ReactHost. */
  get InheritanceChainWindow() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.chainKey)) return undefined as never
    return InheritanceChainWindow
  }

  get inheritance_chain_window_props() {
    return this.memo('inheritance_chain_window_props', [this.props, this.chainKey, this.scope, this.byKey, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.chainKey)) return undefined as never
      return ({ settingKey: prefixedKey(this.props.moduleId, this.chainKey), scope: this.scope, title: this.byKey.get(this.chainKey)?.label ?? this.chainKey, onClose: () => this.chainKey = null } as React.ComponentProps<typeof InheritanceChainWindow>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading, this.items], () => {
      if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  get visible13() {
    return this.memo('visible13', [this.show_chain_key, this.show_main], () => this.show_chain_key && this.show_main)
  }

  get visible14() {
    return this.memo('visible14', [this.show_confirm_state, this.show_main], () => this.show_confirm_state && this.show_main)
  }

  storedValue(s: SettingItem) {
    const resolved = this.resolvedByKey.get(s.key)
    if (this.scoped && resolved) return resolved.value
    return s.global ?? s.default
  }

  shown(s: SettingItem) {
    return (s.key in this.edits ? this.edits[s.key] : this.storedValue(s))
  }

  valueOf(key: string) {
    const parent = this.byKey.get(key)
    return parent ? this.shown(parent) : undefined
  }

  instanceOnly(s: SettingItem) {
    return s.scope !== 'overridable'
  }

  isReadOnly(s: SettingItem) {
    if (this.scoped && this.instanceOnly(s)) return true
    return !!this.resolvedByKey.get(s.key)?.locked_above
  }

  setValue(item: SettingItem, v: unknown) {
    this.edits = ((prev) => {
      const next = { ...prev, [item.key]: v }
      if (item.type === 'bool' && !v) {
        for (const child of this.items) {
          if (child.depends_on === item.key) delete next[child.key]
        }
      }
      return next
    })(this.edits)
  }

  reportError(e: unknown) {
    const detail = apiErrorDetail(e)
    this.error = detail ?? this.tr('admin.setting_write_failed', {
      defaultValue: "L'enregistrement a échoué.",
    })
  }

  async afterWrite(written: string[]) {
    this.error = null
    await this.qc.invalidateQueries({ queryKey: ['module-config', this.props.moduleId] })
    await this.qc.invalidateQueries({ queryKey: ['module-settings-resolved', this.props.moduleId] })
    await this.qc.invalidateQueries({ queryKey: ['setting-chain'] })
    this.edits = ((prev) => {
      const next = { ...prev }
      for (const key of written) delete next[key]
      return next
    })(this.edits)
  }

  visible(s: SettingItem) {
    return isVisible(s, this.memo("valueOf:bound", [], () => this.valueOf.bind(this)), key => this.byKey.has(key))
  }

  categoryOf(s: SettingItem) {
    const declared = s.category && s.category !== this.props.moduleId ? s.category : ''
    return declared || this.tr('admin.m_other_settings', { defaultValue: 'Autres' })
  }

  splitByCategory(list: SettingItem[]) {
    const byCategory = new Map<string, SettingItem[]>()
    for (const s of list) {
      const key = this.categoryOf(s)
      const acc = byCategory.get(key) ?? []
      acc.push(s)
      byCategory.set(key, acc)
    }
    return [...byCategory.entries()].map(([category, all]) => ({
      category,
      basic:    all.filter(s => !s.advanced),
      advanced: all.filter(s => s.advanced),
      all,
    }))
  }

  async submitSection(sectionKey: string, keys: string[]) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    const changes: Record<string, unknown> = {}
    for (const key of keys) if (key in this.edits) changes[key] = this.edits[key]
    const staged = Object.keys(changes)
    // Out-of-bounds values are refused per section too: a bad number in another
    // section is that section's problem, and must not hold this one hostage.
    if (staged.length === 0 || staged.some(k => this.invalidKeys.has(k))) return

    // A setting flagged `danger` can make the server unreachable or lose mail.
    // The panel says so once, plainly, before the value leaves the browser.
    const risky = staged
      .map(k => this.byKey.get(k))
      .filter((s): s is SettingItem => !!s && s.risk === 'danger')
    if (risky.length > 0) {
      const names = risky.map(s => `• ${s.label ?? s.key}`).join('\n')
      const ok = await this.confirm({
        title:   this.tr('admin.m_confirm_danger_title', { defaultValue: 'Réglage sensible' }),
        message: this.tr('admin.m_confirm_danger_message', {
          count: risky.length,
          names,
          defaultValue: `Vous modifiez ${risky.length} réglage(s) sensible(s) :\n${names}\n\nUne valeur erronée peut rendre le service injoignable ou faire perdre des messages. Confirmer l'enregistrement ?`,
        }),
        variant: 'danger',
        confirmLabel: this.tr('common.save', { defaultValue: 'Enregistrer' }),
      })
      if (!ok) return
    }

    this.busySection = sectionKey
    try {
      await this.save.mutateAsync(changes)
      this.savedSection = sectionKey
      // Guarded: another section may have written in the meantime, and clearing
      // the flag blind would take the flash off the wrong bar.
      setTimeout(() => this.savedSection = (this.savedSection === sectionKey ? null : this.savedSection), 2500)
    } catch {
      // Already surfaced by the mutation's `onError`; caught so the rejection of
      // `mutateAsync` does not escape as an unhandled one.
    } finally {
      this.busySection = null
    }
  }

  cancelSection(keys: string[]) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    this.edits = ((prev) => {
      const next = { ...prev }
      for (const key of keys) delete next[key]
      return next
    })(this.edits)
  }

  elsewhereAction(keys: string[]) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    const item = keys.map(k => this.byKey.get(k)).find((s): s is SettingItem => !!s)
    if (!item) return null
    const label = this.tr('admin.m_pending_elsewhere_goto', { defaultValue: 'Voir' })
    const itemPage = this.paged ? pageOf(item, this.groupIds, this.firstGroup) : ''
    if (this.paged && itemPage !== this.page) {
      // A real href: the operator must be able to see where it goes, and to open
      // it in another tab.
      return (
        <Link to={adminPath('modules', this.props.moduleId, itemPage)} className="text-primary hover:underline">
          {label}
        </Link>
      )
    }
    const category = this.categoryOf(item)
    return (
      <button
        type="button"
        // Both at once, because the two shapes of the panel name their sections
        // differently: a tab id when the module declares pages, the bare
        // category when it declares none.
        onClick={() => {
          this.tab = `${this.CATEGORY_TAB}${category}`
          this.opened = ({ ...this.opened, [category]: true })
        }}
        className="text-primary hover:underline"
      >
        {label}
      </button>
    )
  }

  renderRow(s: SettingItem) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    const current  = this.shown(s)
    const resolved = this.resolvedByKey.get(s.key)
    const readOnly = this.isReadOnly(s)
    return (
      <ModuleSettingRow
        key={s.key}
        item={s}
        value={current}
        modified={!sameValue(current, s.default)}
        pending={s.key in this.edits}
        invalid={this.invalidKeys.has(s.key)}
        readOnly={readOnly}
        showFactoryReset={!this.scoped}
        statusPill={this.scopable
          ? <ScopeStatusPill resolved={resolved} scoped={this.scoped} instanceOnly={this.instanceOnly(s)} />
          : undefined}
        // Only where there IS something above to inherit from. At instance level
        // the "rétablir la valeur par défaut" link on the row already says the
        // one thing reverting can mean.
        provenance={this.scoped && resolved && !this.instanceOnly(s)
          ? (
            <>
              <ProvenanceLine
                setting={resolved}
                onRevert={() => this.revert.mutate(s.key)}
                onLock={locked => this.lock.mutate({ key: s.key, locked })}
                onShowChain={() => this.chainKey = s.key}
              />
              {/* Going back to following the parent is one of the three things
                  this page can do to a value, so it is a button under the
                  sentence that states the value's origin — not an entry of a
                  menu the operator has to go looking for. */}
              {resolved.has_own_value && !resolved.locked_above && (
                <button
                  type="button"
                  onClick={() => this.revert.mutate(s.key)}
                  disabled={this.revert.isPending}
                  className="block text-left text-primary transition-colors hover:underline disabled:opacity-50"
                  style={{ fontSize: 'var(--kb-text-meta)' }}
                >
                  {this.tr('admin.m_inherit', { defaultValue: 'Hériter la valeur du parent' })}
                </button>
              )}
            </>
          )
          : undefined}
        onChange={v => this.setValue(s, v)}
        onReset={() => this.setValue(s, s.default)}
      />
    )
  }

  changedCount(list: SettingItem[]) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    return list.filter(s => {
    if (this.scoped) return this.resolvedByKey.get(s.key)?.has_own_value ?? false
    return !sameValue(s.global ?? s.default, s.default)
  }).length
  }

  categorySection(key: string, category: string, basic: SettingItem[], advanced: SettingItem[], onlyOne: boolean) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    const all = [...basic, ...advanced]
    const changed = this.changedCount(all)
    // What this section's bar commits, and what it must NOT commit.
    const keys      = all.map(s => s.key)
    const here      = keys.filter(k => k in this.edits)
    const outside   = Object.keys(this.edits).filter(k => !keys.includes(k))
    // Writing on a scope that holds no value yet REMOVES it from its parent's
    // authority for that key. The action says which of the two it is about to do.
    const overriding = this.scoped && here.some(k => !this.resolvedByKey.get(k)?.has_own_value)
    // "Autres" is a name given RELATIVE to other sections. When the page holds a
    // single unnamed run of settings there is nothing to be other than, and the
    // page heading above already says what they are — so it carries no title.
    const synthetic = category === this.tr('admin.m_other_settings', { defaultValue: 'Autres' })
    return (
      <SettingSectionCard
        key={key}
        title={onlyOne && synthetic ? '' : category}
        status={
          <>
            {this.tr('admin.m_settings_count', {
              count: all.length,
              defaultValue: `${all.length} réglages`,
            })}
            {changed > 0 && ' · '}
            {changed > 0 && (
              <span className="text-primary">
                {this.scoped
                  ? this.tr('admin.m_section_overridden', {
                      count: changed,
                      defaultValue: `${changed} remplacé(s) ici`,
                    })
                  : this.tr('admin.m_section_modified', {
                      count: changed,
                      defaultValue: `${changed} modifié(s)`,
                    })}
              </span>
            )}
          </>
        }
        // While filtering, everything is open: a hit hidden behind a fold the
        // operator has to guess at is not a hit. A page made of ONE section has
        // nothing to choose between, so folding it only adds a click.
        open={this.filtering || (this.opened[key] ?? onlyOne)}
        onToggle={() => this.opened = ({ ...this.opened, [key]: !(this.opened[key] ?? onlyOne) })}
        aside={this.scopeAside}
        footer={
          <SettingsSaveBar
            count={here.length}
            elsewhere={outside.length}
            elsewhereAction={this.elsewhereAction(outside)}
            invalid={here.filter(k => this.invalidKeys.has(k)).length}
            saving={this.busySection === key}
            saved={this.savedSection === key}
            overriding={overriding}
            onSave={() => void this.submitSection(key, keys)}
            onCancel={() => this.cancelSection(keys)}
          />
        }
      >
        <SettingRows
          basic={basic}
          advanced={advanced}
          advancedOpen={this.filtering || (this.advOpen[key] ?? false)}
          onToggleAdvanced={() => this.advOpen = ({ ...this.advOpen, [key]: !(this.advOpen[key] ?? false) })}
          renderRow={this.memo("renderRow:bound", [], () => this.renderRow.bind(this))}
        />
      </SettingSectionCard>
    )
  }

  renderMatches(list: SettingItem[]) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0))) return undefined as never
    if (list.length === 0) {
      return (
        <p className="py-6 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.m_no_match', { defaultValue: 'Aucun réglage ne correspond.' })}
        </p>
      )
    }
    if (!this.paged) {
      return (
        <div className="space-y-3">
          {this.splitByCategory(list).map(c =>
            this.categorySection(c.category, c.category, c.basic, c.advanced, false))}
        </div>
      )
    }
    // Grouped by page, pages in menu order, so a result reads as an address:
    // "Filtrage ▸ Politique anti-spam".
    return this.groups.map(g => {
      const inPage = list.filter(s => pageOf(s, this.groupIds, this.firstGroup) === g.id)
      if (inPage.length === 0) return null
      const here = g.id === this.page
      return (
        <div key={g.id} className="mb-4">
          <div className="flex flex-wrap items-center gap-2 pb-2">
            <span className="text-sm font-bold text-text-primary">{g.label}</span>
            {here ? (
              <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro)' }}>
                {this.tr('admin.m_group_current', { defaultValue: 'page courante' })}
              </span>
            ) : (
              // A real href: the result has to be openable in its own tab, and
              // the operator has to be able to see where it goes.
              <Link
                to={adminPath('modules', this.props.moduleId, g.id)}
                className="text-primary hover:underline"
                style={{ fontSize: 'var(--kb-text-micro)' }}
              >
                {this.tr('admin.m_group_open', { defaultValue: 'ouvrir cette page' })}
              </Link>
            )}
          </div>
          <div className="space-y-3">
            {this.splitByCategory(inPage).map(c =>
              this.categorySection(`${g.id}::${c.category}`, c.category, c.basic, c.advanced, false))}
          </div>
        </div>
      )
    })
  }

  callout_dismiss(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(!(this.items.length === 0)) || !(this.error)) return undefined as never
    this.error = null
  }

  /** `setTab` of the TSX: a value, or an update of the previous one. */
  setTab(value: string | null | ((prev: string | null) => string | null)) {
    this.tab = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.tab) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModuleAdminSettingsStores = ReturnType<ModuleAdminSettings['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ModuleAdminSettingsHooks = ReturnType<ModuleAdminSettings['useHooks']>

export default ModuleAdminSettings.component()

export type { SettingItem } from '../settings/moduleSettingSchema'

export type { ResolvedSetting }
