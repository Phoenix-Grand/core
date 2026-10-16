/**
 * Code-behind of `MarketplacePanel.kbview` (converted from `MarketplacePanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { useModulesStore } from "../../core/store/modulesStore"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './MarketplacePanel.kbview'
import * as __parts from './MarketplacePanel.parts.tsx'

interface MarketModule {
  id:                string
  name:              string
  version:           string
  author?:           string | null
  official:          boolean
  category?:         string | null
  accent?:           string | null
  summary?:          string | null
  description?:      string | null
  license?:          string | null
  tags:              string[]
  rating?:           number | null
  updated?:          string | null
  links?:            { repo?: string | null; html?: string | null }
  installed:         boolean
  installed_version: string | null
  enabled?:          boolean | null
  removable:         boolean
}

interface Report { name: string; version: string; started: boolean }

export type MarketplacePanelProps = { onBack: () => void; related?: string | null }

export class MarketplacePanel extends ViewBase {
  @bind accessor showAll = false
  @bind accessor okMsg: string | null = null
  @bind accessor errMsg: string | null = null
  @bind accessor busy: string | null = null
  @bind accessor phase: Record<string, string> = {}
  tr!: MarketplacePanelStores['t']
  qc!: MarketplacePanelStores['qc']
  data!: MarketplacePanelStores['data']
  isLoading!: boolean
  isError!: boolean
  install!: MarketplacePanelHooks['install']
  uninstall!: MarketplacePanelHooks['uninstall']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const { data, isLoading, isError } = useQuery({
      queryKey: ['admin-marketplace'],
      queryFn: () => api.get<{ modules: MarketModule[] }>('/admin/marketplace').then((r) => r.data.modules),
    })
    return { t, qc, data, isLoading, isError }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const qc = this.qc
    const install = useMutation({
      mutationFn: async (id: string): Promise<Report> => {
        await api.post(`/admin/marketplace/${id}/install`)
        for (let i = 0; i < 600; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          const { data } = await api.get<{ progress: { phase: string; message: string; report?: Report; error?: string } | null }>(
            `/admin/marketplace/${id}/status`,
          )
          const p = data.progress
          if (!p) continue
          this.phase = ({ ...this.phase, [id]: p.message || p.phase })
          if (p.phase === 'done') return p.report as Report
          if (p.phase === 'error') throw new Error(p.error || t('admin.mk_install_failed', { defaultValue: "L'installation a échoué." }))
        }
        throw new Error(t('admin.mk_timeout', { defaultValue: 'Délai d’installation dépassé.' }))
      },
      onMutate: (id) => { this.busy = id; this.okMsg = null; this.errMsg = null; this.phase = ({ ...this.phase, [id]: '…' }) },
      onSuccess: (report) => {
        // Two whole sentences rather than one assembled with `+`: a concatenated
        // default cannot be translated - a locale would only ever carry the first
        // half, silently dropping the "and started" ending in every language.
        this.okMsg = report.started
          ? t('admin.mk_installed_started', {
              defaultValue: '« {{name}} » v{{version}} installé et démarré.',
              name: report.name, version: report.version,
            })
          : t('admin.mk_installed', {
              defaultValue: '« {{name}} » v{{version}} installé.',
              name: report.name, version: report.version,
            })
        qc.invalidateQueries({ queryKey: ['admin-marketplace'] })
        qc.invalidateQueries({ queryKey: ['admin-modules'] })
        useModulesStore.getState().fetchModules()
      },
      onError: (e: unknown) => {
        const msg = apiErrorDetail(e)
        this.errMsg = msg || t('admin.mk_install_failed', { defaultValue: "L'installation a échoué." })
      },
      onSettled: (_d, _e, id) => { this.busy = null; this.phase = ((p) => { const n = { ...p }; delete n[id]; return n })(this.phase) },
    })
    this.publish({ install })
    const uninstall = useMutation({
      mutationFn: (id: string) => api.delete(`/admin/marketplace/${id}`).then((r) => r.data),
      onMutate: (id) => { this.busy = id; this.okMsg = null; this.errMsg = null },
      onSuccess: () => {
        this.okMsg = t('admin.mk_uninstalled', { defaultValue: 'Module désinstallé.' })
        qc.invalidateQueries({ queryKey: ['admin-marketplace'] })
        qc.invalidateQueries({ queryKey: ['admin-modules'] })
        useModulesStore.getState().fetchModules()
      },
      onError: (e: unknown) => {
        const msg = apiErrorDetail(e)
        this.errMsg = msg || t('admin.mk_uninstall_failed', { defaultValue: 'La désinstallation a échoué.' })
      },
      onSettled: () => this.busy = null,
    })
    this.publish({ uninstall })
    return { install, uninstall }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, data: s.data, isLoading: s.isLoading, isError: s.isError })
    const h = this.useHooks()
    this.publish({ install: h.install, uninstall: h.uninstall })
  }

  get self(): MarketModule | undefined {
    return this.memo('self', [this.data, this.props], () => {
      const related = this.props.related
      return related ? (this.data ?? []).find((m) => m.id === related) : undefined
    })
  }

  get relatedActive(): boolean {
    return !!this.self && !this.showAll
  }

  get visible(): MarketModule[] {
    return this.memo('visible', [this.relatedActive, this.data, this.memo, this.self], () => this.relatedActive ? (this.data ?? []).filter(this.memo("isRelated:bound", [], () => this.isRelated.bind(this))) : (this.data ?? []))
  }

  get categories(): string[] {
    return this.memo('categories', [this.visible], () => [...new Set(this.visible.map((m) => m.category || 'Autres'))])
  }

  get show_ok_msg() {
    return !!(this.okMsg)
  }

  get show_err_msg() {
    return !!(this.errMsg)
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
    return this.memo('rows_categories', [this.categories, this.visible, this.busy, this.tr, this.uninstall, this.install, this.phase], () => this.categories.map((cat) => {
      return { cat, part1_props: { visible: this.visible, cat: cat, busy: this.busy, t: this.tr, uninstall: this.uninstall, install: this.install, phase: this.phase }, key: cat }
    }))
  }

  isRelated(m: MarketModule) {
    const self = this.self
    return m.id !== self!.id && ((!!self!.category && m.category === self!.category)
      || m.tags.some((tg) => self!.tags.includes(tg)))
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onBack?.()
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.okMsg)) return undefined as never
    this.okMsg = null
  }

  panel_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.errMsg)) return undefined as never
    this.errMsg = null
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
