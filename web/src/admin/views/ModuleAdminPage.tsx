/**
 * Code-behind of `ModuleAdminPage.kbview` (converted from `ModuleAdminPage.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { SlidersHorizontal } from "lucide-react"
import { Button, Callout, Card, EmptyState, Spinner, type Crumb } from "@ui"
import { formatDay } from "../sections/format"
import type { AdminSectionProps } from "../sections/registry"
import { adminUrl } from "../adminAction"
import { adminPath } from "../adminRoute"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"
import { Slot, moduleAdminSlot, useHasSlot, useModuleAdminSections, type ModuleAdminSection } from "../../core/slots/SlotRegistry"
import { groupsOf, useAdminModules, useModuleLiveState, type AdminModule, type ModuleLiveState, type ModuleSettingGroup } from "../adminModules"
import ModuleAdminSettings, { useModuleInstanceSettings } from "../pages/ModuleAdminSettings"
import ModuleDatabaseCard from "../pages/ModuleDatabaseCard"
import ModuleSidePanel from "../settings/pages/ModuleSidePanel"
import { INSTANCE_SCOPE, type ActiveScope } from "../settings/scopeTypes"

import { ViewBase } from './ModuleAdminPage.kbview'
import * as __parts from './ModuleAdminPage.parts.tsx'
import { ModuleStateCard, GroupHeading } from './ModuleAdminPage.parts.tsx'

export type { AdminSectionProps }

export class ModuleAdminPage extends ViewBase {
  tr!: ModuleAdminPageStores['t']
  i18n!: ModuleAdminPageStores['i18n']
  data!: ModuleAdminPageStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: ModuleAdminPageStores['refetch']
  liveState!: (module: AdminModule) => ModuleLiveState
  settings!: ModuleAdminPageHooks['settings']
  hasOwnAdmin!: boolean
  ownSections!: ModuleAdminSection[]
  scope!: ActiveScope
  setScope!: ModuleAdminPageStores['setScope']
  groups!: ModuleSettingGroup[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { data, isLoading, isError, refetch } = useAdminModules()
    const liveState = useModuleLiveState()
    const [scope, setScope] = useState<ActiveScope>(INSTANCE_SCOPE)
    return { t, i18n, data, isLoading, isError, refetch, liveState, scope, setScope }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const setScope = this.setScope
    const settings = useModuleInstanceSettings(this.id, !!this.module)
    this.publish({ settings })
    const hasOwnAdmin = useHasSlot(this.ownSlot)
    this.publish({ hasOwnAdmin })
    const ownSections = useModuleAdminSections(this.id)
    this.publish({ ownSections })
    useEffect(() => { setScope(INSTANCE_SCOPE) }, [this.id])
    const module = this.module
    const groups   = useMemo(() => groupsOf(module), [module])
    this.publish({ groups })
    useAdminCrumbs(useMemo(
      () => {
        if (!module) return []
        const crumbs: Crumb[] = [{
          label: module.display_name,
          title: module.display_name,
          // The module's own address, so the trail leads back to the page the
          // menu lands on rather than being dead text next to a live segment.
          href:  this.active ? adminPath('modules', module.id) : undefined,
        }]
        if (this.active) crumbs.push({ label: this.active.label, title: this.active.label })
        return crumbs
      },
      [module?.id, module?.display_name, this.active?.id, this.active?.label], // eslint-disable-line react-hooks/exhaustive-deps
    ))
    useEffect(() => {
      if (!module || !this.active || this.wanted === this.active.id) return
      this.props.navigate(adminPath('modules', module.id, this.active.id), { replace: true })
    }, [module?.id, this.active?.id, this.wanted])
    return { settings, hasOwnAdmin, ownSections, groups }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, liveState: s.liveState, scope: s.scope, setScope: s.setScope })
    const h = this.useHooks()
    this.publish({ settings: h.settings, hasOwnAdmin: h.hasOwnAdmin, ownSections: h.ownSections, groups: h.groups })
  }

  get id(): string {
    return this.props.params.get('module') ?? ''
  }

  get module(): AdminModule | null {
    return this.memo('module', [this.data, this.id], () => this.data?.find(m => m.id === this.id) ?? null)
  }

  get ownSlot() {
    return this.memo('ownSlot', [this.id], () => moduleAdminSlot(this.id))
  }

  get wanted(): string {
    return this.props.params.get('pane') ?? ''
  }

  get active(): ModuleSettingGroup {
    return this.memo('active', [this.groups, this.wanted], () => this.groups.find(g => g.id === this.wanted) ?? this.groups[0] ?? null)
  }

  get isFirst(): boolean {
    return !!this.active && this.active.id === this.groups[0]?.id
  }

  get here(): ModuleAdminSection[] {
    return this.memo('here', [this.ownSections, this.active, this.groups], () => this.ownSections.filter(s => !this.active || this.placed(s) === this.active.id))
  }

  get inline(): ModuleAdminSection[] {
    return this.memo('inline', [this.here], () => this.here.filter(s => !s.label && !s.labelKey))
  }

  get asTabs(): ModuleAdminSection[] {
    return this.memo('asTabs', [this.here], () => this.here.filter(s => !!s.label || !!s.labelKey))
  }

  get state(): ModuleLiveState {
    if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
    return this.liveState(this.module)
  }

  get paged(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
    return this.groups.length > 0
  }

  get hasAdmin(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
    return this.hasOwnAdmin || this.ownSections.length > 0
  }

  get header() {
    return this.memo('header', [this.module, this.tr, this.i18n, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
      return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="min-w-0 text-text-primary" style={{ fontSize: 'var(--kb-text-page)' }}>
        {this.module.display_name}
      </h1>
      <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
        v{this.module.version} · {this.tr('admin.m_installed_on', { date: formatDay(this.module.installed_at, this.i18n.language) })}
      </span>
    </div>
  )
    })
  }

  get perUnit(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
    return this.settings.items.some(s => s.scope === 'overridable')
  }

  get scopeCallout() {
    return this.memo('scopeCallout', [this.perUnit, this.tr, this.isLoading, this.isError, this.module], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
      return this.perUnit ? null : (
    <Callout variant="info" className="mb-4" title={this.tr('admin.m_scope_title')}>
      {this.tr('admin.m_scope_body')}
    </Callout>
  )
    })
  }

  get configError() {
    return this.memo('configError', [this.tr, this.settings, this.isLoading, this.isError, this.module], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
      return (
    <Card>
      <EmptyState
        compact
        variant="error"
        icon={<SlidersHorizontal size={22} />}
        title={this.tr('admin.m_config_error_title')}
        description={this.tr('admin.m_config_error_desc')}
        action={{ label: this.tr('admin.m_retry'), onClick: () => void this.settings.refetch() }}
        t={this.tr}
      />
    </Card>
  )
    })
  }

  get backLink() {
    return this.memo('backLink', [this.memo, this.props, this.tr, this.isLoading, this.isError, this.module], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
      return (
    <div className="mt-4">
      <Button variant="ghost" size="sm" onClick={this.memo("backToList:bound", [], () => this.backToList.bind(this))}>{this.tr('admin.m_back_to_list')}</Button>
    </div>
  )
    })
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError)
  }

  get show_case_3() {
    return !(this.isLoading) && !(this.isError) && !!(!this.module)
  }

  get show_case_4() {
    return !(this.isLoading) && !(this.isError) && !(!this.module) && !!(this.paged && this.active)
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_header() {
    return this.memo('content_header', [this.header, this.isLoading, this.isError, this.module, this.paged, this.active], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module)) || !(this.paged && this.active)) return undefined as never
      return ({ children: this.header })
    })
  }

  get content_columns_group_heading_group() {
    return this.memo('content_columns_group_heading_group', [this.isLoading, this.isError, this.module, this.groups, this.active, this.perUnit, this.scope, this.setScope, this.isFirst, this.scopeCallout, this.state, this.inline, this.ownSlot, this.settings, this.configError, this.asTabs, this.backLink, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module)) || !(this.paged && this.active)) return undefined as never
      return ({ children: this.columns(
          <>
            <GroupHeading group={this.active} />

            {/* Both belong to the module, not to any one of its pages — so they
                sit on the FIRST one, which is where the menu lands, instead of
                being repeated five times over. */}
            {this.isFirst && this.scopeCallout}
            {this.isFirst && <ModuleStateCard module={this.module} state={this.state} />}
            {this.isFirst && <ModuleDatabaseCard moduleId={this.module.id} />}

            {/* The module's own views for this page, above the form: a
                diagnostic is read before a setting is changed, and it is what
                tells the operator WHICH setting to change. */}
            {this.inline.map(({ id: sectionId, Component }) => <Component key={sectionId} />)}
            {/* A module that contributes through the plain slot said nothing
                about pages; its views belong to the module as a whole, so they
                show where the menu lands rather than on every page. */}
            {this.isFirst && <Slot name={this.ownSlot} />}

            {this.settings.isLoading ? (
              <div className="py-10 flex justify-center"><Spinner /></div>
            ) : this.settings.isError ? (
              this.configError
            ) : this.settings.items.length > 0 ? (
              // Mounted on EVERY page, including one with no setting of its
              // own: it holds the pending edits and the module-wide filter, and
              // unmounting it while moving between pages would throw away
              // staged changes the footer had just promised to save.
              <ModuleAdminSettings
                key={this.module.id}
                moduleId={this.module.id}
                group={this.active.id}
                groups={this.groups}
                extraTabs={this.asTabs}
                scope={this.scope}
              />
            ) : (
              // No setting anywhere in the module, but it does administer
              // itself: the contributed sections above are the page.
              this.asTabs.map(({ id: sectionId, Component }) => <Component key={sectionId} />)
            )}

            {this.backLink}
          </>,
        ) })
    })
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError) && !(!this.module) && !(this.paged && this.active)
  }

  get content_header2() {
    return this.memo('content_header2', [this.header, this.isLoading, this.isError, this.module, this.paged, this.active], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module)) || !(!(this.paged && this.active))) return undefined as never
      return ({ children: this.header })
    })
  }

  get content_columns_scope_callout_module_state_card() {
    return this.memo('content_columns_scope_callout_module_state_card', [this.isLoading, this.isError, this.module, this.groups, this.active, this.perUnit, this.scope, this.setScope, this.scopeCallout, this.state, this.ownSections, this.ownSlot, this.settings, this.configError, this.hasAdmin, this.backLink, this.tr, this.memo, this.props, this.paged], () => {
      if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module)) || !(!(this.paged && this.active))) return undefined as never
      return ({ children: this.columns(
        <>
          {this.scopeCallout}

          <ModuleStateCard module={this.module} state={this.state} />
          <ModuleDatabaseCard moduleId={this.module.id} />

          {/* The module's own sections, above the generated form. */}
          {this.ownSections.map(({ id: sectionId, Component }) => <Component key={sectionId} />)}
          <Slot name={this.ownSlot} />

          {this.settings.isLoading ? (
            <div className="py-10 flex justify-center"><Spinner /></div>
          ) : this.settings.isError ? (
            this.configError
          ) : this.settings.items.length === 0 ? (
            this.hasAdmin ? (
              // The module declares no setting but administers itself above.
              // Saying "not configurable" here would contradict the panel the
              // operator is looking at; only the way back is still owed.
              this.backLink
            ) : (
              // Declares nothing at all: an empty form would claim it is
              // configurable.
              <Card>
                <EmptyState
                  compact
                  variant="unavailable"
                  icon={<SlidersHorizontal size={22} />}
                  title={this.tr('admin.m_no_settings_title')}
                  description={this.tr('admin.m_no_settings_desc')}
                  action={{ label: this.tr('admin.m_back_to_list'), onClick: this.memo("backToList:bound", [], () => this.backToList.bind(this)) }}
                  t={this.tr}
                />
              </Card>
            )
          ) : (
            <>
              <ModuleAdminSettings key={this.module.id} moduleId={this.module.id} scope={this.scope} />
              {/* Only here: the two states above already offer the way back
                  inside their own empty state, and a second identical button
                  reads as a different destination. */}
              {this.backLink}
            </>
          )}
        </>,
      ) })
    })
  }

  placed(section: ModuleAdminSection) {
    return this.groups.some(g => g.id === section.group) ? section.group : this.groups[0]?.id
  }

  backToList() {
    return this.props.navigate(adminUrl({ tab: 'modules' }))
  }

  columns(content: ReactNode) {
    if (!(!(this.isLoading)) || !(!(this.isError)) || !(!(!this.module))) return undefined as never
    return (
    <div className="flex min-w-0 flex-col gap-5 md:flex-row md:items-start">
      <ModuleSidePanel
        module={this.module}
        groups={this.groups}
        activeGroup={this.active?.id ?? null}
        scopable={this.perUnit}
        scope={this.scope}
        onScopeChange={this.setScope}
      />
      <div className="min-w-0 flex-1">{content}</div>
    </div>
  )
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.isError)) return undefined as never
    void this.refetch()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModuleAdminPageStores = ReturnType<ModuleAdminPage['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ModuleAdminPageHooks = ReturnType<ModuleAdminPage['useHooks']>

export default ModuleAdminPage.component()
