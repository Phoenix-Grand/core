/**
 * Code-behind of `MarketplacePanel.kbview` (converted from `MarketplacePanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { useModulesStore } from "../../core/store/modulesStore"
import { categoryKey, categoryLabel, failureLabel, localizeModule, marketplaceFailure, relatedModules,
  type MarketModule, type InstallProgress, type InstallReport, type MarketplaceFailure } from './marketplaceLocale'

import { ViewBase } from './MarketplacePanel.kbview'
import * as __parts from './MarketplacePanel.parts.tsx'

export type MarketplacePanelProps = { onBack: () => void; related?: string | null }

export class MarketplacePanel extends ViewBase {
  @bind accessor showAll = false
  @bind accessor result: { kind: 'installed'; report: InstallReport } | { kind: 'uninstalled' } | null = null
  @bind accessor failure: MarketplaceFailure | null = null
  @bind accessor busy: string | null = null
  @bind accessor phase: Record<string, InstallProgress> = {}
  locale!: string
  tr!: MarketplacePanelStores['t']
  qc!: MarketplacePanelStores['qc']
  data!: MarketplacePanelStores['data']
  isLoading!: boolean
  isError!: boolean
  install!: MarketplacePanelHooks['install']
  uninstall!: MarketplacePanelHooks['uninstall']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const qc = useQueryClient()
    const { data, isLoading, isError } = useQuery({
      queryKey: ['admin-marketplace'],
      queryFn: () => api.get<{ modules: MarketModule[] }>('/admin/marketplace').then((r) => r.data.modules),
    })
    return { t, locale: i18n.language, qc, data, isLoading, isError }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const qc = this.qc
    const install = useMutation({
      mutationFn: async (id: string): Promise<InstallReport> => {
        await api.post(`/admin/marketplace/${id}/install`)
        for (let i = 0; i < 600; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const { data } = await api.get<{ progress: InstallProgress | null }>(
            `/admin/marketplace/${id}/status`,
          )
          const p = data.progress
          if (!p) continue
          this.phase = ({ ...this.phase, [id]: p })
          if (p.phase === 'done' && p.report) return p.report
          if (p.phase === 'error') throw { code: p.error_code || 'INSTALL_FAILED', message: p.error }
        }
        throw { code: 'INSTALL_TIMEOUT' }
      },
      onMutate: (id) => { this.busy = id; this.result = null; this.failure = null; this.phase = ({ ...this.phase, [id]: { phase: 'queued' } }) },
      onSuccess: (report) => {
        this.result = { kind: 'installed', report }
        qc.invalidateQueries({ queryKey: ['admin-marketplace'] })
        qc.invalidateQueries({ queryKey: ['admin-modules'] })
        useModulesStore.getState().fetchModules()
      },
      onError: (e: unknown) => {
        this.failure = marketplaceFailure(e, 'INSTALL_FAILED')
      },
      onSettled: (_d, _e, id) => { this.busy = null; this.phase = ((p) => { const n = { ...p }; delete n[id]; return n })(this.phase) },
    })
    this.publish({ install })
    const uninstall = useMutation({
      mutationFn: (id: string) => api.delete(`/admin/marketplace/${id}`).then((r) => r.data),
      onMutate: (id) => { this.busy = id; this.result = null; this.failure = null },
      onSuccess: () => {
        this.result = { kind: 'uninstalled' }
        qc.invalidateQueries({ queryKey: ['admin-marketplace'] })
        qc.invalidateQueries({ queryKey: ['admin-modules'] })
        useModulesStore.getState().fetchModules()
      },
      onError: (e: unknown) => {
        this.failure = marketplaceFailure(e, 'UNINSTALL_FAILED')
      },
      onSettled: () => this.busy = null,
    })
    this.publish({ uninstall })
    return { install, uninstall }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, locale: s.locale, qc: s.qc, data: s.data, isLoading: s.isLoading, isError: s.isError })
    const h = this.useHooks()
    this.publish({ install: h.install, uninstall: h.uninstall })
  }

  get localizedData(): MarketModule[] {
    return this.memo('localizedData', [this.data, this.locale], () => (this.data ?? []).map(m => localizeModule(m, this.locale)))
  }

  get self(): MarketModule | undefined {
    return this.memo('self', [this.localizedData, this.props], () => {
      const related = this.props.related
      return related ? this.localizedData.find((m) => m.id === related) : undefined
    })
  }

  get relatedActive(): boolean {
    return !!this.self && !this.showAll
  }

  get visible(): MarketModule[] {
    return this.memo('visible', [this.relatedActive, this.localizedData, this.self], () => this.relatedActive ? this.localizedData.filter(m => relatedModules(m, this.self!)) : this.localizedData)
  }

  get categories(): string[] {
    return this.memo('categories', [this.visible], () => [...new Set(this.visible.map(categoryKey))])
  }

  get okMsg() {
    if (!this.result) return null
    if (this.result.kind === 'uninstalled') return this.tr('admin.mk_uninstalled')
    const report = this.result.report
    return report.started
      ? this.tr('admin.mk_installed_started', { name: report.name, version: report.version })
      : this.tr('admin.mk_installed', { name: report.name, version: report.version })
  }

  get ErrorNotice() { return __parts.ErrorNotice }
  get error_notice_props() {
    return this.memo('error_notice_props', [this.failure, this.tr], () => ({
      message: this.failure ? failureLabel(this.failure, this.tr) : '',
      detail: this.failure?.detail, detailsLabel: this.tr('admin.mk_error_details'),
    }))
  }

  get show_ok_msg() {
    return !!(this.okMsg)
  }

  get show_err_msg() {
    return !!this.failure
  }

  get show_self() {
    return this.memo('show_self', [this.self], () => !!(this.self))
  }

  get span_text() {
    if (!(this.self)) return undefined as never
    return this.relatedActive
              ? this.tr('admin.mk_related_on', { defaultValue: 'Modules complémentaires à « {{name}} »', name: this.self.name })
              : this.tr('admin.mk_related_off', { defaultValue: 'Tout le catalogue' })
  }

  get text() {
    if (!(this.self)) return undefined as never
    return this.relatedActive
              ? this.tr('admin.mk_related_showall', { defaultValue: 'Voir tout le catalogue' })
              : this.tr('admin.mk_related_only', { defaultValue: 'Voir les complémentaires' })
  }

  get show_related_active_visible() {
    return this.relatedActive && this.visible.length === 0
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `categories`. */
  get rows_categories() {
    return this.memo('rows_categories', [this.categories, this.visible, this.locale, this.busy, this.tr, this.uninstall, this.install, this.phase], () => this.categories.map((key) => {
      const module = this.visible.find(m => categoryKey(m) === key)!
      return { cat: categoryLabel(module, this.locale, this.tr), part1_props: { visible: this.visible, cat: key, busy: this.busy, t: this.tr, uninstall: this.uninstall, install: this.install, phase: this.phase }, key }
    }))
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onBack?.()
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.okMsg)) return undefined as never
    this.result = null
  }

  panel_click3(_sender: unknown, _args: MouseEventArgs) {
    this.failure = null
  }

  panel_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.self)) return undefined as never
    this.showAll = !this.showAll
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type MarketplacePanelStores = ReturnType<MarketplacePanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type MarketplacePanelHooks = ReturnType<MarketplacePanel['useHooks']>

export default MarketplacePanel.component()
