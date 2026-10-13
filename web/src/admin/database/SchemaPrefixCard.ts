/**
 * Code-behind of `SchemaPrefixCard.kbcontrol` (converted from `SchemaPrefixCard.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { OutlinedField, useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { api } from "../../core/api/client"
import { apiErrorMessage } from "../../core/api/errorMessage"
import { useConfirm } from "../../core/hooks/useConfirm"
import { usePrivileges } from "../../core/authz/usePrivileges"

import { ViewBase } from './SchemaPrefixCard.kbcontrol'
import * as __parts from './SchemaPrefixCard.parts'

const PRIMARY = 'var(--color-primary)'

interface PrefixResponse {
  prefix: string
  engine: string
  applicable: boolean
}

export class SchemaPrefixCard extends ViewBase {
  @bind accessor prefix = ''
  @bind accessor error: string | null = null
  @bind accessor done: string[] | null = null
  tr!: SchemaPrefixCardStores['t']
  isSuperuser!: boolean
  toast!: SchemaPrefixCardStores['toast']
  qc!: SchemaPrefixCardStores['qc']
  confirm!: SchemaPrefixCardStores['confirm']
  confirmState!: SchemaPrefixCardStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  cfg!: SchemaPrefixCardStores['cfg']
  saveMut!: SchemaPrefixCardHooks['saveMut']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { isSuperuser } = usePrivileges()
    const toast = useToast()
    const qc = useQueryClient()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const cfg = useQuery({
      queryKey: ['schema-prefix'],
      queryFn: () => api.get<PrefixResponse>('/admin/database/schema-prefix').then(r => r.data),
      enabled: isSuperuser,
      staleTime: 30_000,
    })
    return { t, isSuperuser, toast, qc, confirm, confirmState, handleConfirm, handleCancel, cfg }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const qc = this.qc
    const cfg = this.cfg
    useEffect(() => {
      if (cfg.data) this.prefix = cfg.data.prefix
    }, [cfg.data])
    const saveMut = useMutation({
      mutationFn: () => api.put('/admin/database/schema-prefix', { prefix: this.prefix.trim() }).then(r => r.data),
      onSuccess: (data: { changed: boolean; renamed?: string[] }) => {
        this.error = null
        if (!data.changed) {
          toast.success(t('admin.dbprefix_unchanged'))
          return
        }
        this.done = data.renamed ?? []
        toast.success(t('admin.dbprefix_saved'))
        void qc.invalidateQueries({ queryKey: ['schema-prefix'] })
      },
      onError: (e: unknown) => this.error = apiErrorMessage(e, t('admin.dbprefix_failed')),
    })
    this.publish({ saveMut })
    return { saveMut }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, isSuperuser: s.isSuperuser, toast: s.toast, qc: s.qc, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, cfg: s.cfg })
    const h = this.useHooks()
    this.publish({ saveMut: h.saveMut })
  }

  get applicable(): boolean {
    return this.cfg.data?.applicable ?? true
  }

  get show_case_1() {
    return !!(!this.isSuperuser)
  }

  get show_main() {
    return !(!this.isSuperuser)
  }

  get show_not_cfg_is_loading() {
    if (!(!(!this.isSuperuser))) return undefined as never
    return !(this.cfg.isLoading)
  }

  get show_not_cfg_is_error() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading))) return undefined as never
    return !(this.cfg.isError)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(this.cfg.isError)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part1() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(this.cfg.isError)) return undefined as never
    return __parts.Part1
  }

  get show_applicable() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return !this.applicable
  }

  get show_error() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return !!(this.error)
  }

  get show_done() {
    return this.memo('show_done', [this.done, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
      return !!(this.done)
    })
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.done, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError)) || !(this.done)) return undefined as never
      return ({ t: this.tr, done: this.done })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part2() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError)) || !(this.done)) return undefined as never
    return __parts.Part2
  }

  /** `<OutlinedField>`, rendered by a ReactHost. */
  get OutlinedField() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return OutlinedField
  }

  get outlined_field_props() {
    return this.memo('outlined_field_props', [this.tr, this.prefix, this.error, this.applicable, this.isSuperuser, this.cfg], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
      return ({ label: this.tr('admin.dbprefix_field'), value: this.prefix, onChange: (v) => { this.prefix = v; this.error = null }, readOnly: !this.applicable, placeholder: "kub_", primaryColor: PRIMARY } as React.ComponentProps<typeof OutlinedField>)
    })
  }

  get enabled_unless_applicable_save_mut_is_pending() {
    if (!(!(!this.isSuperuser)) || !(!(this.cfg.isLoading)) || !(!(this.cfg.isError))) return undefined as never
    return !(!this.applicable || this.saveMut.isPending || this.prefix.trim() === (this.cfg.data?.prefix ?? ''))
  }

  get visible() {
    return this.memo('visible', [this.cfg, this.show_not_cfg_is_loading, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.cfg.isError && this.show_not_cfg_is_loading
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_cfg_is_error, this.show_not_cfg_is_loading, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.show_not_cfg_is_error && this.show_not_cfg_is_loading
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(!this.isSuperuser)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  async onSave() {
    if (!(!(!this.isSuperuser))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.dbprefix_confirm_title'),
      message: this.tr('admin.dbprefix_confirm_body', { prefix: this.prefix.trim() || this.tr('admin.dbprefix_none') }),
      confirmLabel: this.tr('admin.dbprefix_confirm_ok'),
      variant: 'danger',
    })
    if (ok) this.saveMut.mutate()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SchemaPrefixCardStores = ReturnType<SchemaPrefixCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type SchemaPrefixCardHooks = ReturnType<SchemaPrefixCard['useHooks']>

export default SchemaPrefixCard.component()
