/**
 * Code-behind of `AuthMethodsPanel.kbcontrol` (converted from `AuthMethodsPanel.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Network, ShieldCheck } from "lucide-react"
import { useToast } from "@ui"
import { api } from "../../core/api/client"
import { useConfirm } from "../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
import SettingScopeBar from "../settings/controls/SettingScopeBar"
import { INSTANCE_SCOPE, type ActiveScope, type ResolvedSetting } from "../settings/scopeTypes"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './AuthMethodsPanel.kbcontrol'
import * as __parts from './AuthMethodsPanel.parts.tsx'

const KEY_METHODS = 'auth.methods'

const KEY_FALLBACK = 'auth.local_admin_fallback'

type MethodId = 'local' | 'directory' | 'sso'

const ALL: MethodId[] = ['local', 'directory', 'sso']

interface ScopedResponse {
  settings: ResolvedSetting[]
}

const asMethods = (value: unknown): MethodId[] =>
  Array.isArray(value) ? ALL.filter(m => (value as unknown[]).includes(m)) : []

export class AuthMethodsPanel extends ViewBase {
  tr!: AuthMethodsPanelStores['t']
  qc!: AuthMethodsPanelStores['qc']
  toast!: AuthMethodsPanelStores['toast']
  confirm!: AuthMethodsPanelStores['confirm']
  confirmState!: AuthMethodsPanelStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  scope!: ActiveScope
  setScope!: AuthMethodsPanelStores['setScope']
  data!: AuthMethodsPanelHooks['data']
  isLoading!: boolean
  isError!: boolean
  methods!: MethodId[]
  write!: AuthMethodsPanelHooks['write']
  revert!: AuthMethodsPanelHooks['revert']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const [scope, setScope] = useState<ActiveScope>(INSTANCE_SCOPE)
    return { t, qc, toast, confirm, confirmState, handleConfirm, handleCancel, scope, setScope }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const qc = this.qc
    const toast = this.toast
    const scope = this.scope
    const { data, isLoading, isError } = useQuery({
      retry: false,
      queryKey: ['admin-auth-methods', scope.type, scope.id] as const,
      queryFn: () =>
        api
          .get<ScopedResponse>('/admin/settings/resolved', { params: this.scopeParams })
          .then(r => r.data.settings),
    })
    this.publish({ data, isLoading, isError })
    const methodsSetting = this.methodsSetting
    const methods = useMemo(() => asMethods(methodsSetting?.value), [methodsSetting])
    this.publish({ methods })
    const write = useMutation({
      mutationFn: ({ key, value }: { key: string; value: unknown }) =>
        api.put(`/admin/settings/scoped/${encodeURIComponent(key)}`, { ...this.scopeParams, value }),
      onSuccess: () => {
        toast.success(t('authmethods.saved'))
        qc.invalidateQueries({ queryKey: ['admin-auth-methods'] })
        qc.invalidateQueries({ queryKey: ['admin-settings-resolved'] })
      },
      // The server's refusal is the interesting part: it names the administrators
      // who would be shut out and how to get back in. Shown verbatim.
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('authmethods.refused')),
    })
    this.publish({ write })
    const revert = useMutation({
      mutationFn: (key: string) =>
        api.delete(`/admin/settings/scoped/${encodeURIComponent(key)}`, { params: this.scopeParams }),
      onSuccess: () => {
        toast.success(t('authmethods.reverted'))
        qc.invalidateQueries({ queryKey: ['admin-auth-methods'] })
      },
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('authmethods.refused')),
    })
    this.publish({ revert })
    return { data, isLoading, isError, methods, write, revert }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, scope: s.scope, setScope: s.setScope })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, methods: h.methods, write: h.write, revert: h.revert })
  }

  get scopeParams(): { scope_type: "instance" | "org_unit"; scope_id: string | undefined; } {
    return this.memo('scopeParams', [this.scope], () => ({ scope_type: this.scope.type, scope_id: this.scope.id ?? undefined }))
  }

  get methodsSetting(): ResolvedSetting | undefined {
    return this.memo('methodsSetting', [this.data], () => this.data?.find(s => s.key === KEY_METHODS))
  }

  get fallbackSetting(): ResolvedSetting | undefined {
    return this.memo('fallbackSetting', [this.data], () => this.data?.find(s => s.key === KEY_FALLBACK))
  }

  get fallback(): boolean {
    return this.fallbackSetting?.value === true
  }

  get lockedAbove(): boolean {
    return this.methodsSetting?.locked_above ?? false
  }

  get inheritedFrom(): string | null | undefined {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.methodsSetting?.source?.scope_name
  }

  get hasOwn(): boolean {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.methodsSetting?.has_own_value ?? false
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_case_2() {
    return !(this.isLoading) && !!(this.isError || !this.data)
  }

  get show_main() {
    return !(this.isLoading) && !(this.isError || !this.data)
  }

  /** `<SettingScopeBar>`, rendered by a ReactHost. */
  get SettingScopeBar() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return SettingScopeBar
  }

  get setting_scope_bar_props() {
    return this.memo('setting_scope_bar_props', [this.scope, this.setScope, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ scope: this.scope, onChange: this.setScope, sticky: false })
    })
  }

  get show_scope_type_org() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.scope.type === 'org_unit'
  }

  get callout_text() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.scope.type === 'org_unit')) return undefined as never
    return this.hasOwn
                ? this.tr('authmethods.own_value')
                : this.tr('authmethods.inherited', { from: this.inheritedFrom ?? this.tr('admin.scope_instance') })
  }

  /** `<MethodRow>`, rendered by a ReactHost. */
  get MethodRow() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.MethodRow
  }

  get method_row_props() {
    return this.memo('method_row_props', [this.methods, this.lockedAbove, this.write, this.toast, this.tr, this.confirm, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ id: "local", icon: <KeyRound size={17} />, checked: this.methods.includes('local'), disabled: this.lockedAbove || this.write.isPending, onChange: v => this.toggleMethod('local', v), t: this.tr } as React.ComponentProps<typeof __parts.MethodRow>)
    })
  }

  get method_row_props2() {
    return this.memo('method_row_props2', [this.methods, this.lockedAbove, this.write, this.toast, this.tr, this.confirm, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ id: "directory", icon: <Network size={17} />, checked: this.methods.includes('directory'), disabled: this.lockedAbove || this.write.isPending, onChange: v => this.toggleMethod('directory', v), t: this.tr } as React.ComponentProps<typeof __parts.MethodRow>)
    })
  }

  get method_row_props3() {
    return this.memo('method_row_props3', [this.methods, this.lockedAbove, this.write, this.toast, this.tr, this.confirm, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ id: "sso", icon: <ShieldCheck size={17} />, checked: this.methods.includes('sso'), disabled: this.lockedAbove || this.write.isPending, onChange: v => this.toggleMethod('sso', v), t: this.tr } as React.ComponentProps<typeof __parts.MethodRow>)
    })
  }

  get show_scope_type_org2() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return this.scope.type === 'org_unit' && this.hasOwn
  }

  get enabled_unless_fallback_setting_locked_above() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !((this.fallbackSetting?.locked_above ?? false) || this.write.isPending)
  }

  get show_fallback() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return !this.fallback
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part1() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    return __parts.Part1
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading, this.isError, this.data], () => {
      if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  errorOf(e: unknown) {
    return apiErrorDetail(e)
  }

  async toggleMethod(id: MethodId, on: boolean) {
    const next = on ? [...new Set([...this.methods, id])] : this.methods.filter(m => m !== id)
    if (next.length === 0) {
      this.toast.error(this.tr('authmethods.err_empty'))
      return
    }
    if (!on) {
      const ok = await this.confirm({
        title: this.tr('authmethods.confirm_title'),
        message: this.tr(`authmethods.confirm_off_${id}`),
        confirmLabel: this.tr('authmethods.confirm_apply'),
        variant: 'danger',
      })
      if (!ok) return
    }
    this.write.mutate({ key: KEY_METHODS, value: next })
  }

  async toggleFallback(on: boolean) {
    if (!on) {
      const ok = await this.confirm({
        title: this.tr('authmethods.confirm_title'),
        message: this.tr('authmethods.confirm_off_fallback'),
        confirmLabel: this.tr('authmethods.confirm_apply'),
        variant: 'danger',
      })
      if (!ok) return
    }
    this.write.mutate({ key: KEY_FALLBACK, value: on })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data)) || !(this.scope.type === 'org_unit' && this.hasOwn)) return undefined as never
    this.revert.mutate(KEY_METHODS)
  }

  switch_checked_changed(_sender: unknown, args: EventArgs) {
    if (!(!(this.isLoading)) || !(!(this.isError || !this.data))) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.toggleFallback(e.target.checked)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AuthMethodsPanelStores = ReturnType<AuthMethodsPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AuthMethodsPanelHooks = ReturnType<AuthMethodsPanel['useHooks']>

export default AuthMethodsPanel.component()
