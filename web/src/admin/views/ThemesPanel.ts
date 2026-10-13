/**
 * Code-behind of `ThemesPanel.kbview` (converted from `ThemesPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useThemeStore, type ThemeDef } from "../../core/store/themeStore"
import { api } from "../../core/api/client"
import ThemeDevicePreview from "../pages/ThemeDevicePreview"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './ThemesPanel.kbview'
import * as __parts from './ThemesPanel.parts.tsx'

export class ThemesPanel extends ViewBase {
  @bind accessor importError: string | null = null
  @bind accessor deleteConfirmId: string | null = null
  @bind accessor selectedId: string | null = null
  tr!: ThemesPanelStores['t']
  themes!: ThemeDef[]
  activeThemeId!: string
  applyTheme!: (id: string) => void
  fetchThemes!: () => Promise<void>
  loadThemePreview!: (theme: ThemeDef) => void
  clearThemePreview!: () => void
  fileInputRef!: ThemesPanelStores['fileInputRef']
  zipInputRef!: ThemesPanelStores['zipInputRef']
  saveMut!: ThemesPanelStores['saveMut']
  importMut!: ThemesPanelHooks['importMut']
  importZipMut!: ThemesPanelHooks['importZipMut']
  trustMut!: ThemesPanelStores['trustMut']
  deleteMut!: ThemesPanelHooks['deleteMut']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { themes, activeThemeId, applyTheme, fetchThemes, loadThemePreview, clearThemePreview } = useThemeStore()
    const qc = useQueryClient()
    const fileInputRef = useRef<HTMLInputElement>(null)
    const zipInputRef = useRef<HTMLInputElement>(null)
    const saveMut = useMutation({
      mutationFn: (id: string) => api.patch('/admin/settings', { 'appearance.theme': id }),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-settings'] }),
    })
    const trustMut = useMutation({
      mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
        api.patch(`/admin/themes/${id}/trust`, { scripts_enabled: enabled }),
      onSuccess: () => fetchThemes(),
    })
    return { t, themes, activeThemeId, applyTheme, fetchThemes, loadThemePreview, clearThemePreview, qc, fileInputRef, zipInputRef, saveMut, trustMut }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const activeThemeId = this.activeThemeId
    const applyTheme = this.applyTheme
    const fetchThemes = this.fetchThemes
    const loadThemePreview = this.loadThemePreview
    const clearThemePreview = this.clearThemePreview
    const saveMut = this.saveMut
    useEffect(() => {
      if (this.selected) loadThemePreview(this.selected)
      return () => clearThemePreview()
      // Reload when the previewed theme — or its trust state — changes.
    }, [this.selected?.id, this.selected?.scripts_enabled])
    const importMut = useMutation({
      mutationFn: (theme: ThemeDef) => api.post('/admin/themes', theme),
      onSuccess: () => { this.importError = null; fetchThemes() },
      onError: (err: unknown) => {
        const msg = apiErrorDetail(err)
        this.importError = msg ?? t('admin.t_import_error')
      },
    })
    this.publish({ importMut })
    const importZipMut = useMutation({
      mutationFn: (file: File) => {
        const fd = new FormData()
        fd.append('file', file)
        return api.post('/admin/themes/import', fd)
      },
      onSuccess: (res: { data?: { theme?: { id?: string } } }) => {
        this.importError = null
        const newId = res?.data?.theme?.id
        if (newId) this.selectedId = newId
        fetchThemes()
      },
      onError: (err: unknown) => {
        const msg = apiErrorDetail(err)
        this.importError = msg ?? t('admin.t_import_error')
      },
    })
    this.publish({ importZipMut })
    const selectedId = this.selectedId
    const deleteMut = useMutation({
      mutationFn: (id: string) => api.delete(`/admin/themes/${id}`),
      onSuccess: (_data, id) => {
        this.deleteConfirmId = null
        if (activeThemeId === id) { applyTheme('kubuno-reference'); saveMut.mutate('kubuno-reference') }
        if (selectedId === id) this.selectedId = 'kubuno-reference'
        fetchThemes()
      },
      onError: () => this.deleteConfirmId = null,
    })
    this.publish({ deleteMut })
    return { importMut, importZipMut, deleteMut }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, themes: s.themes, activeThemeId: s.activeThemeId, applyTheme: s.applyTheme, fetchThemes: s.fetchThemes, loadThemePreview: s.loadThemePreview, clearThemePreview: s.clearThemePreview, fileInputRef: s.fileInputRef, zipInputRef: s.zipInputRef, saveMut: s.saveMut, trustMut: s.trustMut })
    const h = this.useHooks()
    this.publish({ importMut: h.importMut, importZipMut: h.importZipMut, deleteMut: h.deleteMut })
  }

  get selected(): ThemeDef {
    return this.memo('selected', [this.themes, this.activeThemeId, this.selectedId], () => {
      const selectedId = this.selectedId
      return this.themes.find((th) => th.id === (selectedId ?? this.activeThemeId)) ?? this.themes[0] ?? null
    })
  }

  get isActive(): boolean {
    return this.selected?.id === this.activeThemeId
  }

  get isBuiltin(): boolean {
    return this.selected?.builtin === true
  }

  get enabled_unless_import_mut_is_pending() {
    return !(this.importMut.isPending)
  }

  get enabled_unless_import_zip_mut_is_pending() {
    return !(this.importZipMut.isPending)
  }

  get part1_props() {
    return this.memo('part1_props', [this.fileInputRef, this.memo, this.importError, this.tr, this.importMut], () => ({ fileInputRef: this.fileInputRef, handleFileChange: this.memo("handleFileChange:bound", [], () => this.handleFileChange.bind(this)) }))
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.zipInputRef, this.memo, this.importError, this.importZipMut], () => ({ zipInputRef: this.zipInputRef, handleZipChange: this.memo("handleZipChange:bound", [], () => this.handleZipChange.bind(this)) }))
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part2() {
    return __parts.Part2
  }

  get show_import_error() {
    return !!(this.importError)
  }

  get show_import_mut_is_pending_import_zip_mut() {
    return this.importMut.isPending || this.importZipMut.isPending
  }

  get show_themes() {
    return this.themes.length === 0
  }

  /** `<ThemeChip>`, rendered by a ReactHost. */
  get ThemeChip() {
    return __parts.ThemeChip
  }

  /** The rows of the Repeater over `themes`. */
  get rows_themes() {
    return this.memo('rows_themes', [this.themes, this.selected, this.activeThemeId, this.tr], () => this.themes.map((theme) => {
      const sel = theme.id === this.selected?.id
      const active = theme.id === this.activeThemeId
      return { theme, sel, active, button_class: `w-full flex items-center gap-3 p-2 rounded-lg border text-left transition-all
                  ${sel ? 'border-primary bg-primary-light/40' : 'border-border hover:border-border-strong hover:bg-surface-1'}`, theme_chip_props: { theme: theme }, span_text: theme.color_scheme === 'dark' ? this.tr('admin.t_dark') : this.tr('admin.t_light'), show_theme_builtin: !!(theme.builtin), show_theme_has_scripts: !!(theme.has_scripts), key: theme.id }
    }))
  }

  get show_selected() {
    return this.memo('show_selected', [this.selected], () => !!(this.selected))
  }

  get show_not_selected() {
    return this.memo('show_not_selected', [this.selected], () => !(this.selected))
  }

  get show_is_builtin() {
    if (!(this.selected)) return undefined as never
    return !this.isBuiltin
  }

  get show_delete_confirm_id_selected_id() {
    if (!(this.selected) || !(!this.isBuiltin)) return undefined as never
    return this.deleteConfirmId === this.selected.id
  }

  get show_not_delete_confirm_id_selected_id() {
    if (!(this.selected) || !(!this.isBuiltin)) return undefined as never
    return !(this.deleteConfirmId === this.selected.id)
  }

  get visible() {
    return this.memo('visible', [this.show_delete_confirm_id_selected_id, this.show_is_builtin, this.selected], () => {
      if (!(this.selected)) return undefined as never
      return this.show_delete_confirm_id_selected_id && this.show_is_builtin
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_delete_confirm_id_selected_id, this.show_is_builtin, this.selected], () => {
      if (!(this.selected)) return undefined as never
      return this.show_not_delete_confirm_id_selected_id && this.show_is_builtin
    })
  }

  get enabled_unless_is_active() {
    if (!(this.selected)) return undefined as never
    return !(this.isActive)
  }

  get button_text() {
    if (!(this.selected)) return undefined as never
    return this.isActive
                      ? this.tr('admin.t_active', { defaultValue: 'Thème actif' })
                      : this.tr('admin.t_apply', { defaultValue: 'Appliquer' })
  }

  get show_selected_has_scripts() {
    if (!(this.selected)) return undefined as never
    return !!(this.selected.has_scripts)
  }

  get on() {
    if (!(this.selected) || !(this.selected.has_scripts)) return undefined as never
    return this.selected.scripts_enabled === true
  }

  get enabled_unless_trust_mut_is_pending() {
    if (!(this.selected) || !(this.selected.has_scripts)) return undefined as never
    return !(this.trustMut.isPending)
  }

  get text() {
    if (!(this.selected) || !(this.selected.has_scripts)) return undefined as never
    return this.selected.scripts_enabled
                      ? this.tr('admin.t_scripts_warning', { defaultValue: 'Exécute le JS du thème chez tous les utilisateurs' })
                      : this.tr('admin.t_scripts_preview_hint', { defaultValue: 'Activez les scripts pour prévisualiser les composants surchargés du thème' })
  }

  /** `<ThemeDevicePreview>`, rendered by a ReactHost. */
  get ThemeDevicePreview() {
    if (!(this.selected)) return undefined as never
    return ThemeDevicePreview
  }

  get theme_device_preview_props() {
    return this.memo('theme_device_preview_props', [this.selected], () => {
      if (!(this.selected)) return undefined as never
      return ({ theme: this.selected })
    })
  }

  get visible3() {
    return this.memo('visible3', [this.show_selected_has_scripts, this.show_selected], () => this.show_selected_has_scripts && this.show_selected)
  }

  /** A part of the screen still written in React (<pre> has no .kbview element yet). */
  get Part3() {
    return __parts.Part3
  }

  handleApply(theme: ThemeDef) {
    this.applyTheme(theme.id)
    this.saveMut.mutate(theme.id)
  }

  handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    this.importError = null
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as ThemeDef
        if (!parsed.id || !parsed.name || !parsed.vars || typeof parsed.vars !== 'object') {
          this.importError = this.tr('admin.t_format_invalid'); return
        }
        this.importMut.mutate(parsed)
      } catch {
        this.importError = this.tr('admin.t_not_json')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  handleZipChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    this.importError = null
    this.importZipMut.mutate(file)
    e.target.value = ''
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.fileInputRef.current?.click()
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    this.zipInputRef.current?.click()
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { theme } = args.row as RowOf_rows_themes
    this.selectedId = theme.id
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.selected) || !(!this.isBuiltin) || !(this.deleteConfirmId === this.selected.id)) return undefined as never
    this.deleteMut.mutate(this.selected.id)
  }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.selected) || !(!this.isBuiltin) || !(this.deleteConfirmId === this.selected.id)) return undefined as never
    this.deleteConfirmId = null
  }

  button_click5(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.selected) || !(!this.isBuiltin) || !(!(this.deleteConfirmId === this.selected.id))) return undefined as never
    this.deleteConfirmId = this.selected.id
  }

  button_click6(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.selected)) return undefined as never
    this.handleApply(this.selected)
  }

  switch_checked_changed(_sender: unknown, args: EventArgs) {
    if (!(this.selected) || !(this.selected.has_scripts)) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.trustMut.mutate({ id: this.selected.id, enabled: e.target.checked })
  }

}

type RowOf_rows_themes = ThemesPanel['rows_themes'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ThemesPanelStores = ReturnType<ThemesPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ThemesPanelHooks = ReturnType<ThemesPanel['useHooks']>

export default ThemesPanel.component()
