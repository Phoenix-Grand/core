/**
 * Code-behind of `LdapSection.kbview` (converted from `LdapSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useToast } from "@ui"
import { api } from "../../core/api/client"
import { useConfirm } from "../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useAdminAction } from "../adminAction"
import { apiErrorDetail } from "../../core/api/errorMessage"
import { emptyForm, type AuthProbe, type ConnectionProbe, type DirectoryForm, type LdapDirectory, type SyncReport } from "./types"

import { ViewBase } from './LdapSection.kbview'
import * as __parts from './LdapSection.parts'

export class LdapSection extends ViewBase {
  @bind accessor editing: string | null = null
  @bind accessor probing: string | null = null
  @bind accessor probe: Record<string, ConnectionProbe> = {}
  @bind accessor authProbe: Record<string, AuthProbe> = {}
  @bind accessor report: Record<string, SyncReport> = {}
  @bind accessor trial: { login: string; password: string } = { login: '', password: '' }
  tr!: LdapSectionStores['t']
  qc!: LdapSectionStores['qc']
  toast!: LdapSectionStores['toast']
  confirm!: LdapSectionStores['confirm']
  confirmState!: LdapSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  form!: DirectoryForm
  setForm!: LdapSectionStores['setForm']
  directories!: LdapSectionStores['directories']
  isLoading!: boolean
  createM!: LdapSectionHooks['createM']
  updateM!: LdapSectionHooks['updateM']
  deleteM!: LdapSectionHooks['deleteM']
  testM!: LdapSectionHooks['testM']
  testAuthM!: LdapSectionHooks['testAuthM']
  syncM!: LdapSectionHooks['syncM']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const [form, setForm] = useState<DirectoryForm>(emptyForm())
    const { data: directories, isLoading } = useQuery({
      queryKey: ['admin', 'ldap-directories'],
      queryFn: () =>
        api.get<{ directories: LdapDirectory[] }>('/admin/ldap/directories').then(r => r.data.directories),
    })
    return { t, qc, toast, confirm, confirmState, handleConfirm, handleCancel, form, setForm, directories, isLoading }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const setForm = this.setForm
    useAdminAction('add', () => { setForm(emptyForm()); this.editing = 'new' })
    const createM = useMutation({
      mutationFn: (payload: Record<string, unknown>) => api.post('/admin/ldap/directories', payload),
      onSuccess: () => { this.invalidate_(); this.editing = null; toast.success(t('ldap.saved')) },
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('ldap.save_failed')),
    })
    this.publish({ createM })
    const updateM = useMutation({
      mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
        api.patch(`/admin/ldap/directories/${id}`, payload),
      onSuccess: () => { this.invalidate_(); toast.success(t('ldap.saved')) },
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('ldap.save_failed')),
    })
    this.publish({ updateM })
    const deleteM = useMutation({
      mutationFn: (id: string) => api.delete<{ deactivated_accounts: number }>(`/admin/ldap/directories/${id}`),
      onSuccess: r => {
        this.invalidate_()
        toast.success(t('ldap.deleted', { count: r.data?.deactivated_accounts ?? 0 }))
      },
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('ldap.save_failed')),
    })
    this.publish({ deleteM })
    const testM = useMutation({
      mutationFn: (id: string) => api.post<ConnectionProbe>(`/admin/ldap/directories/${id}/test`).then(r => r.data),
      onMutate: (id: string) => this.probing = id,
      onSettled: () => this.probing = null,
      onSuccess: (data, id) => this.probe = ({ ...this.probe, [id]: data }),
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('ldap.test_failed')),
    })
    this.publish({ testM })
    const testAuthM = useMutation({
      mutationFn: ({ id, login, password }: { id: string; login: string; password: string }) =>
        api.post<AuthProbe>(`/admin/ldap/directories/${id}/test-auth`, { login, password }).then(r => r.data),
      onSuccess: (data, vars) => {
        this.authProbe = ({ ...this.authProbe, [vars.id]: data })
        // The password is used once and dropped here too: nothing keeps it in the
        // page after the round trip.
        this.trial = ({ ...this.trial, password: '' })
      },
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('ldap.test_failed')),
    })
    this.publish({ testAuthM })
    const syncM = useMutation({
      mutationFn: (id: string) =>
        api.post<{ report: SyncReport }>(`/admin/ldap/directories/${id}/sync`).then(r => r.data.report),
      onSuccess: (data, id) => { this.report = ({ ...this.report, [id]: data }); this.invalidate_() },
      onError: (e: unknown) => toast.error(this.errorOf(e) || t('ldap.sync_failed')),
    })
    this.publish({ syncM })
    return { createM, updateM, deleteM, testM, testAuthM, syncM }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, qc: s.qc, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, form: s.form, setForm: s.setForm, directories: s.directories, isLoading: s.isLoading })
    const h = this.useHooks()
    this.publish({ createM: h.createM, updateM: h.updateM, deleteM: h.deleteM, testM: h.testM, testAuthM: h.testAuthM, syncM: h.syncM })
  }

  get list() {
    return this.memo('list', [this.directories, this.isLoading], () => {
      if (!(!(this.isLoading))) return undefined as never
      return this.directories ?? []
    })
  }

  get show_case_1() {
    return !!(this.isLoading)
  }

  get show_main() {
    return !(this.isLoading)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.isLoading], () => {
      if (!(!(this.isLoading))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part1() {
    if (!(!(this.isLoading))) return undefined as never
    return __parts.Part1
  }

  get show_editing_new() {
    if (!(!(this.isLoading))) return undefined as never
    return this.editing === 'new'
  }

  get show_list_editing_new() {
    if (!(!(this.isLoading))) return undefined as never
    return this.list.length === 0 && this.editing !== 'new'
  }

  get show_not_list_editing_new() {
    if (!(!(this.isLoading))) return undefined as never
    return !(this.list.length === 0 && this.editing !== 'new')
  }

  get part2_props() {
    return this.memo('part2_props', [this.list, this.probe, this.authProbe, this.report, this.editing, this.form, this.setForm, this.memo, this.createM, this.updateM, this.tr, this.confirm, this.deleteM, this.probing, this.testM, this.syncM, this.trial, this.testAuthM, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!(this.list.length === 0 && this.editing !== 'new'))) return undefined as never
      return ({ list: this.list, probe: this.probe, authProbe: this.authProbe, report: this.report, editing: this.editing, form: this.form, setForm: this.setForm, submit: this.memo("submit:bound", [], () => this.submit.bind(this)), setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)), updateM: this.updateM, t: this.tr, onDelete: this.memo("onDelete:bound", [], () => this.onDelete.bind(this)), probing: this.probing, setProbe: this.memo("setProbe:bound", [], () => this.setProbe.bind(this)), testM: this.testM, syncM: this.syncM, trial: this.trial, setTrial: this.memo("setTrial:bound", [], () => this.setTrial.bind(this)), testAuthM: this.testAuthM })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!(this.list.length === 0 && this.editing !== 'new'))) return undefined as never
    return __parts.Part2
  }

  get show_editing_list() {
    if (!(!(this.isLoading))) return undefined as never
    return this.editing === null && this.list.length > 0
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading], () => {
      if (!(!(this.isLoading))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  invalidate_() {
    return this.qc.invalidateQueries({ queryKey: ['admin', 'ldap-directories'] })
  }

  errorOf(e: unknown) {
    return apiErrorDetail(e)
  }

  submit() {
    const payload: Record<string, unknown> = {
      ...this.form,
      port: Number(this.form.port) || 389,
      connect_timeout_s: Number(this.form.connect_timeout_s) || 10,
      sync_interval_min: Number(this.form.sync_interval_min) || 60,
      // Absent and null are the same JSON, so "no unit" needs a word of its own
      // on an update - otherwise a unit could be chosen and never un-chosen.
      clear_default_org_unit: this.form.default_org_unit_id === null,
    }
    // Absent = unchanged. Sending an empty string would CLEAR the stored one,
    // which is what the explicit control is for.
    if (!this.form.bind_password) delete payload.bind_password
    if (this.editing === 'new') {
      this.createM.mutate(payload)
    } else if (this.editing) {
      delete payload.slug
      this.updateM.mutate({ id: this.editing, payload }, { onSuccess: () => this.editing = null })
    }
  }

  async onDelete(d: LdapDirectory) {
    const ok = await this.confirm({
      title: this.tr('ldap.delete_title'),
      message: this.tr('ldap.delete_message', { name: d.display_name, count: d.governed_accounts }),
      confirmLabel: this.tr('common.delete'),
      variant: 'danger',
    })
    if (ok) this.deleteM.mutate(d.id)
  }

  empty_state_action(_sender: unknown, _args: EventArgs) {
    if (!(!(this.isLoading)) || !(this.list.length === 0 && this.editing !== 'new')) return undefined as never
 this.setForm(emptyForm()); this.editing = 'new' }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading)) || !(this.editing === null && this.list.length > 0)) return undefined as never
 this.setForm(emptyForm()); this.editing = 'new' }

  /** `<LdapDirectoryForm SetForm>`: the form changed. */
  ldap_directory_form_set_form(_sender: unknown, args: ValueChangedEventArgs) {
    this.setForm(args.value as DirectoryForm)
  }

  /** `<LdapDirectoryForm OnSave>`: save the directory. */
  ldap_directory_form_save(_sender: unknown, _e: EventArgs) {
    this.submit()
  }

  /** `<LdapDirectoryForm OnCancel>`: leave the editor. */
  ldap_directory_form_cancel(_sender: unknown, _e: EventArgs) {
    this.editing = null
  }

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: string | null | ((prev: string | null) => string | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.editing) : value
  }

  /** `setProbe` of the TSX: a value, or an update of the previous one. */
  setProbe(value: Record<string, ConnectionProbe> | ((prev: Record<string, ConnectionProbe>) => Record<string, ConnectionProbe>)) {
    this.probe = typeof value === 'function' ? (value as (prev: Record<string, ConnectionProbe>) => Record<string, ConnectionProbe>)(this.probe) : value
  }

  /** `setTrial` of the TSX: a value, or an update of the previous one. */
  setTrial(value: { login: string; password: string } | ((prev: { login: string; password: string }) => { login: string; password: string })) {
    this.trial = typeof value === 'function' ? (value as (prev: { login: string; password: string }) => { login: string; password: string })(this.trial) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type LdapSectionStores = ReturnType<LdapSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type LdapSectionHooks = ReturnType<LdapSection['useHooks']>

export default LdapSection.component()
