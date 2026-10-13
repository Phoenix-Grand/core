/**
 * Code-behind of `SpeechToTextPanel.kbview` (converted from `SpeechToTextPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"

import { ViewBase } from './SpeechToTextPanel.kbview'
import * as __parts from './SpeechToTextPanel.parts.tsx'

interface VoskModel { id: string; lang: string; label: string; size_mb: number; url: string }

interface WhisperModel { id: string; label: string; size_mb: number; url: string }

interface LangCfg {
  engine: string
  model: string
  enabled: boolean
  initial_prompt: string
  grammar: string
  normalize_numbers: boolean
  punctuation: boolean
  translate: boolean
  beam_size: number
  auto_detect: boolean
}

interface GlobalSettings { silence_ms: number; sound_threshold: number; profanity_filter: boolean }

interface DownloadStatus { state: string; received: number; total: number; error?: string | null }

interface Catalog {
  enabled: boolean
  settings: GlobalSettings
  config: Record<string, Partial<LangCfg>>
  downloads: Record<string, DownloadStatus> // key = "engine/model"
  installed: { vosk: string[]; whisper: string[] }
  languages: { code: string; label: string }[]
  vosk: VoskModel[]
  whisper: WhisperModel[]
}

export class SpeechToTextPanel extends ViewBase {
  @bind accessor expanded: string | null = null
  tr!: SpeechToTextPanelStores['t']
  qc!: SpeechToTextPanelStores['qc']
  cat!: SpeechToTextPanelStores['cat']
  isLoading!: boolean
  isError!: boolean
  setConfig!: SpeechToTextPanelHooks['setConfig']
  download!: SpeechToTextPanelStores['download']
  remove!: SpeechToTextPanelStores['remove']
  setEnabled!: SpeechToTextPanelHooks['setEnabled']
  setSettings!: SpeechToTextPanelHooks['setSettings']
  installedSet!: Set<string>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const { data: cat, isLoading, isError } = useQuery({
      queryKey: ['stt-catalog'],
      queryFn: () => api.get<Catalog>('/stt/admin/catalog').then((r) => r.data),
      // Poll while any download is in flight so progress bars advance live.
      refetchInterval: (q) => {
        const c = q.state.data as Catalog | undefined
        const active = c && Object.values(c.downloads).some((d) => d.state === 'downloading')
        return active ? 1000 : false
      },
    })
    const download = useMutation({
      mutationFn: (v: { engine: string; model: string }) =>
        api.post('/stt/admin/models/download', v).then((r) => r.data),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['stt-catalog'] }),
    })
    const remove = useMutation({
      mutationFn: (v: { engine: string; model: string }) =>
        api.delete(`/stt/admin/models/${v.engine}/${v.model}`).then((r) => r.data),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['stt-catalog'] }),
    })
    const installedSet = useMemo(() => {
      const s = new Set<string>()
      cat?.installed.vosk.forEach((id) => s.add(`vosk/${id}`))
      cat?.installed.whisper.forEach((id) => s.add(`whisper/${id}`))
      return s
    }, [cat])
    return { t, qc, cat, isLoading, isError, download, remove, installedSet }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const qc = this.qc
    const setConfig = useMutation({
      mutationFn: (v: { lang: string } & Partial<LangCfg>) =>
        api.post('/stt/admin/config', v).then((r) => r.data),
      onSuccess: this.memo("invalidateAll:bound", [], () => this.invalidateAll.bind(this)),
    })
    this.publish({ setConfig })
    const setEnabled = useMutation({
      mutationFn: (enabled: boolean) =>
        api.post('/stt/admin/enabled', { enabled }).then((r) => r.data),
      onMutate: async (enabled) => {
        await qc.cancelQueries({ queryKey: ['stt-catalog'] })
        const prev = qc.getQueryData<Catalog>(['stt-catalog'])
        if (prev) qc.setQueryData<Catalog>(['stt-catalog'], { ...prev, enabled })
        return { prev }
      },
      onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['stt-catalog'], ctx.prev) },
      onSettled: this.memo("invalidateAll:bound", [], () => this.invalidateAll.bind(this)),
    })
    this.publish({ setEnabled })
    const setSettings = useMutation({
      mutationFn: (v: Partial<GlobalSettings>) =>
        api.post('/stt/admin/settings', v).then((r) => r.data),
      onSuccess: this.memo("invalidateAll:bound", [], () => this.invalidateAll.bind(this)),
    })
    this.publish({ setSettings })
    return { setConfig, setEnabled, setSettings }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, cat: s.cat, isLoading: s.isLoading, isError: s.isError, download: s.download, remove: s.remove, installedSet: s.installedSet })
    const h = this.useHooks()
    this.publish({ setConfig: h.setConfig, setEnabled: h.setEnabled, setSettings: h.setSettings })
  }

  get enabled(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return this.cat.enabled
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.cat)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.cat)
  }

  get part1_props() {
    return this.memo('part1_props', [this.enabled, this.isLoading, this.isError, this.cat], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
      return ({ enabled: this.enabled })
    })
  }

  /** A part of the screen still written in React (<span> with a computed style). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return __parts.Part1
  }

  get p_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return this.enabled
                ? this.tr('admin.stt_enable_on', { defaultValue: 'Activée — le bouton micro est disponible dans la barre de recherche.' })
                : this.tr('admin.stt_enable_off', { defaultValue: 'Désactivée — le bouton micro est masqué pour tous les utilisateurs.' })
  }

  get enabled_unless_set_enabled_is_pending() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return !(this.setEnabled.isPending)
  }

  /** `<GlobalSettingsCard>`, rendered by a ReactHost. */
  get GlobalSettingsCard() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return __parts.GlobalSettingsCard
  }

  get global_settings_card_props() {
    return this.memo('global_settings_card_props', [this.cat, this.enabled, this.setSettings, this.isLoading, this.isError], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
      return ({ settings: this.cat.settings, disabled: !this.enabled, onSave: (patch) => this.setSettings.mutate(patch) } as React.ComponentProps<typeof __parts.GlobalSettingsCard>)
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.enabled, this.cat, this.memo, this.isLoading, this.isError, this.installedSet, this.expanded, this.setConfig, this.tr, this.remove, this.download], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
      return ({ enabled: this.enabled, cat: this.cat, modelsFor: this.memo("modelsFor:bound", [], () => this.modelsFor.bind(this)), installedSet: this.installedSet, expanded: this.expanded, patchLang: this.memo("patchLang:bound", [], () => this.patchLang.bind(this)), t: this.tr, remove: this.remove, download: this.download, setExpanded: this.memo("setExpanded:bound", [], () => this.setExpanded.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<div aria-disabled>: attribute(s) without a .kbview property). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return __parts.Part2
  }

  invalidateAll() {
    this.qc.invalidateQueries({ queryKey: ['stt-catalog'] })
    this.qc.invalidateQueries({ queryKey: ['stt-status'] })
  }

  patchLang(lang: string, patch: Partial<LangCfg>) {
    return this.setConfig.mutate({ lang, ...patch })
  }

  modelsFor(engine: string, lang: string): { id: string; label: string; size_mb: number }[] {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    return engine === 'whisper' ? this.cat.whisper : this.cat.vosk.filter((m) => m.lang === lang)
  }

  switch_checked_changed(_sender: unknown, args: EventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.cat))) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setEnabled.mutate(e.target.checked)
  }

  /** `setExpanded` of the TSX: a value, or an update of the previous one. */
  setExpanded(value: string | null | ((prev: string | null) => string | null)) {
    this.expanded = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.expanded) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SpeechToTextPanelStores = ReturnType<SpeechToTextPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type SpeechToTextPanelHooks = ReturnType<SpeechToTextPanel['useHooks']>

export default SpeechToTextPanel.component()
