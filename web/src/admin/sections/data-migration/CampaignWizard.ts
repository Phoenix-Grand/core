/**
 * Code-behind of `CampaignWizard.kbview` (converted from `CampaignWizard.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { type StepDef } from "@ui"
import { api } from "../../../core/api/client"
import type { User } from "../../../core/types"
import { errorMessage, useCreateCampaign, useProbeSource, type Campaign, type MigrationService, type SourceFolder } from "./api"

import { ViewBase } from './CampaignWizard.kbview'
import * as __parts from './CampaignWizard.parts'

interface Draft {
  key:      string
  login:    string
  password: string
  targetId: string
}

let draftSeq = 0

const newDraft = (login = '', password = '', targetId = ''): Draft =>
  ({ key: `d${draftSeq++}`, login, password, targetId })

function parseLine(line: string): { login: string; password: string; target: string } | null {
  const parts = line.split(/[,;\t]/).map(p => p.trim())
  if (parts.length < 2 || parts[0] === '') return null
  return { login: parts[0], password: parts[1] ?? '', target: parts[2] ?? '' }
}

export type CampaignWizardProps = {
  services: MigrationService[]
  onClose: () => void
  onCreated: (campaign: Campaign) => void
}

export class CampaignWizard extends ViewBase {
  @bind accessor step = 'service'
  @bind accessor name = ''
  @bind accessor host = ''
  @bind accessor port = '993'
  @bind accessor security = 'ssl'
  @bind accessor bulk = ''
  @bind accessor drafts: Draft[] = []
  @bind accessor since = ''
  @bind accessor folders: SourceFolder[] | null = null
  @bind accessor excluded: string[] = []
  @bind accessor startNow = true
  @bind accessor error: string | null = null
  @bind accessor probeMsg: string | null = null
  tr!: CampaignWizardStores['t']
  service!: CampaignWizardHooks['service']
  setService!: CampaignWizardHooks['setService']
  probe!: CampaignWizardStores['probe']
  create!: CampaignWizardStores['create']
  userOptions!: { value: string; label: string; description: string; keywords: string; }[]
  resolve!: (raw: string) => string

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const probe  = useProbeSource()
    const create = useCreateCampaign()
    const { data: users } = useQuery({
      queryKey: ['admin-data-migration-users'],
      queryFn:  async () =>
        (await api.get<{ users: User[] }>('/admin/users', { params: { limit: 500 } })).data.users,
    })
    const userOptions = useMemo(
      () => (users ?? []).map(u => ({
        value:       u.id,
        label:       u.display_name?.trim() || u.email,
        description: u.email,
        keywords:    `${u.email} ${u.username}`,
      })),
      [users],
    )
    const resolve = useMemo(() => {
      const index = new Map<string, string>()
      for (const u of users ?? []) {
        index.set(u.email.toLowerCase(), u.id)
        index.set(u.username.toLowerCase(), u.id)
      }
      return (raw: string) => index.get(raw.trim().toLowerCase()) ?? ''
    }, [users])
    return { t, probe, create, users, userOptions, resolve }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [service, setService] = useState<string>(this.usable[0]?.id ?? '')
    this.publish({ service, setService })
    return { service, setService }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, probe: s.probe, create: s.create, userOptions: s.userOptions, resolve: s.resolve })
    const h = this.useHooks()
    this.publish({ service: h.service, setService: h.setService })
  }

  get usable(): MigrationService[] {
    return this.memo('usable', [this.props], () => this.props.services.filter(s => s.available))
  }

  get ready(): Draft[] {
    return this.memo('ready', [this.drafts], () => this.drafts.filter(d => d.targetId !== '' && d.password !== ''))
  }

  get unresolved(): number {
    return this.drafts.length - this.ready.length
  }

  get steps(): StepDef[] {
    return this.memo('steps', [this.tr], () => [
    { id: 'service', label: this.tr('admin.migr_step_service') },
    { id: 'source',  label: this.tr('admin.migr_step_source') },
    { id: 'mapping', label: this.tr('admin.migr_step_mapping') },
    { id: 'range',   label: this.tr('admin.migr_step_range') },
  ])
  }

  get canLeaveService(): boolean {
    return this.service !== ''
  }

  get canLeaveSource(): boolean {
    return this.host.trim() !== '' && Number(this.port) > 0 && this.name.trim() !== ''
  }

  get canSubmit(): boolean {
    return this.ready.length > 0 && !this.create.isPending
  }

  get last(): boolean {
    return this.step === 'range'
  }

  get order(): string[] {
    return this.memo('order', [this.steps], () => this.steps.map(s => s.id))
  }

  get index(): number {
    return Math.max(0, this.order.indexOf(this.step))
  }

  get nextDisabled(): boolean {
    return (this.step === 'service' && !this.canLeaveService) || (this.step === 'source' && !this.canLeaveSource)
  }

  get confirm_text() {
    return this.last ? this.tr('admin.migr_create') : this.tr('admin.migr_next')
  }

  get enabled_unless_last_can_submit_next_disabled() {
    return !(this.last ? !this.canSubmit : this.nextDisabled)
  }

  get confirm_busy() {
    return this.last && this.create.isPending
  }

  get part1_props() {
    return this.memo('part1_props', [this.steps, this.step, this.memo, this.tr], () => ({ steps: this.steps, step: this.step, setStep: this.memo("setStep:bound", [], () => this.setStep.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<Stepper> steps: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_step_service() {
    return this.step === 'service'
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part2() {
    if (!(this.step === 'service')) return undefined as never
    return __parts.Part2
  }

  /** The rows of the Repeater over `services`. */
  get rows_services() {
    return this.memo('rows_services', [this.props, this.step, this.service, this.setService, this.tr], () => {
      if (!(this.step === 'service')) return undefined as never
      return this.props.services.map((s) => {
      return { s, label_class: ((this.step === 'service')) ? (`flex gap-3 rounded border p-3 transition-colors ${
                    !s.available
                      ? 'cursor-not-allowed border-border bg-surface-1'
                      : this.service === s.id
                        ? 'cursor-pointer border-primary bg-primary-light'
                        : 'cursor-pointer border-border hover:bg-surface-1'
                  }`) : undefined, part2_props: ((this.step === 'service')) ? ({ service: this.service, s: s, setService: this.setService }) : undefined, span_text: ((this.step === 'service')) ? (this.tr(`admin.migr_service_${s.id}`)) : undefined, span_text2: ((this.step === 'service')) ? (s.available
                        ? this.tr(`admin.migr_service_${s.id}_desc`)
                        : this.tr('admin.migr_service_unavailable', { module: s.module_id })) : undefined, key: s.id }
    })
    })
  }

  get show_usable() {
    if (!(this.step === 'service')) return undefined as never
    return this.usable.length === 0
  }

  get show_step_source() {
    return this.step === 'source'
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.name, this.memo, this.step], () => {
      if (!(this.step === 'source')) return undefined as never
      return ({ t: this.tr, name: this.name, setName: this.memo("setName:bound", [], () => this.setName.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part3() {
    if (!(this.step === 'source')) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.port, this.memo, this.step], () => {
      if (!(this.step === 'source')) return undefined as never
      return ({ t: this.tr, port: this.port, setPort: this.memo("setPort:bound", [], () => this.setPort.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<TextField> inputMode: no .kbview property). */
  get Part4() {
    if (!(this.step === 'source')) return undefined as never
    return __parts.Part4
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.step], () => {
      if (!(this.step === 'source')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (a local or dynamic component)). */
  get Part5() {
    if (!(this.step === 'source')) return undefined as never
    return __parts.Part5
  }

  get items_source() {
    return this.memo('items_source', [this.tr, this.step], () => {
      if (!(this.step === 'source')) return undefined as never
      return [
                      { value: 'ssl',  label: this.tr('admin.migr_security_ssl') },
                      { value: 'none', label: this.tr('admin.migr_security_none') },
                    ]
    })
  }

  get show_security_none() {
    if (!(this.step === 'source')) return undefined as never
    return this.security === 'none'
  }

  get show_step_mapping() {
    return this.step === 'mapping'
  }

  get part6_props() {
    return this.memo('part6_props', [this.tr, this.step], () => {
      if (!(this.step === 'mapping')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (a local or dynamic component)). */
  get Part6() {
    if (!(this.step === 'mapping')) return undefined as never
    return __parts.Part6
  }

  get part7_props() {
    return this.memo('part7_props', [this.bulk, this.memo, this.step], () => {
      if (!(this.step === 'mapping')) return undefined as never
      return ({ bulk: this.bulk, setBulk: this.memo("setBulk:bound", [], () => this.setBulk.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<textarea> has no .kbview element yet). */
  get Part7() {
    if (!(this.step === 'mapping')) return undefined as never
    return __parts.Part7
  }

  get enabled_unless_bulk_trim() {
    if (!(this.step === 'mapping')) return undefined as never
    return !(this.bulk.trim() === '')
  }

  get show_drafts() {
    if (!(this.step === 'mapping')) return undefined as never
    return this.drafts.length > 0
  }

  get part8_props() {
    return this.memo('part8_props', [this.tr, this.step, this.drafts], () => {
      if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (a local or dynamic component)). */
  get Part8() {
    if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
    return __parts.Part8
  }

  /** The rows of the Repeater over `drafts`. */
  get rows_drafts() {
    return this.memo('rows_drafts', [this.drafts, this.step], () => {
      if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
      return this.drafts.map((d) => {
      const complete = d.targetId !== '' && d.password !== ''
      return { d, complete, selected_value: ((this.step === 'mapping') && (this.drafts.length > 0)) ? (d.targetId === '' ? null : d.targetId) : undefined, show_not_complete: ((this.step === 'mapping') && (this.drafts.length > 0)) ? (!(complete)) : undefined, key: d.key }
    })
    })
  }

  get variant() {
    if (!(this.step === 'mapping')) return undefined as never
    return this.ready.length > 0 ? 'primary' : 'neutral'
  }

  get show_unresolved() {
    if (!(this.step === 'mapping')) return undefined as never
    return this.unresolved > 0
  }

  get text() {
    return this.memo('text', [this.tr, this.unresolved, this.step], () => {
      if (!(this.step === 'mapping') || !(this.unresolved > 0)) return undefined as never
      return " " + this.tr('admin.migr_unresolved_count', { count: this.unresolved })
    })
  }

  get show_step_range() {
    return this.step === 'range'
  }

  get part9_props() {
    return this.memo('part9_props', [this.tr, this.since, this.memo, this.step], () => {
      if (!(this.step === 'range')) return undefined as never
      return ({ t: this.tr, since: this.since, setSince: this.memo("setSince:bound", [], () => this.setSince.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<TextField type="date">: no .kbview value). */
  get Part9() {
    if (!(this.step === 'range')) return undefined as never
    return __parts.Part9
  }

  get enabled_unless_probe_is_pending() {
    if (!(this.step === 'range')) return undefined as never
    return !(this.probe.isPending)
  }

  get button_text() {
    if (!(this.step === 'range')) return undefined as never
    return this.probe.isPending ? this.tr('admin.migr_probe_running') : this.tr('admin.migr_probe')
  }

  get show_probe_msg() {
    if (!(this.step === 'range')) return undefined as never
    return !!(this.probeMsg)
  }

  get show_folders_folders() {
    if (!(this.step === 'range')) return undefined as never
    return !!(this.folders && this.folders.length > 0)
  }

  get part10_props() {
    return this.memo('part10_props', [this.tr, this.step, this.folders], () => {
      if (!(this.step === 'range') || !(this.folders && this.folders.length > 0)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (a local or dynamic component)). */
  get Part10() {
    if (!(this.step === 'range') || !(this.folders && this.folders.length > 0)) return undefined as never
    return __parts.Part10
  }

  /** The rows of the Repeater over `folders`. */
  get rows_folders() {
    return this.memo('rows_folders', [this.folders, this.excluded, this.step], () => {
      if (!(this.step === 'range') || !(this.folders && this.folders.length > 0)) return undefined as never
      return this.folders.map((f) => {
      const off = this.excluded.includes(f.name)
      return { f, off, button_class: ((this.step === 'range') && (this.folders && this.folders.length > 0)) ? (`flex items-center gap-1.5 rounded border px-2 py-1 transition-colors ${
                            off
                              ? 'border-border bg-surface-2 text-text-tertiary line-through'
                              : 'border-border bg-surface-0 text-text-primary hover:bg-surface-1'
                          }`) : undefined, text: ((this.step === 'range') && (this.folders && this.folders.length > 0)) ? (f.display_name || f.name) : undefined, key: f.name }
    })
    })
  }

  get show_folders() {
    if (!(this.step === 'range')) return undefined as never
    return this.folders === null
  }

  get migr_summary_host() {
    if (!(this.step === 'range')) return undefined as never
    return this.host.trim()
  }

  get show_error() {
    return !!(this.error)
  }

  get show_index() {
    return this.index > 0
  }

  applyBulk() {
    const lines = this.bulk.split('\n').map(l => l.trim()).filter(l => l !== '')
    const parsed = lines
      .map(parseLine)
      .filter((p): p is { login: string; password: string; target: string } => p !== null)
      // A destination left blank falls back to the source login: migrating
      // "jean@ancien.fr" to the account whose address is the same is the common
      // case, and making an operator retype it two hundred times is not a
      // safeguard, it is friction.
      .map(p => newDraft(p.login, p.password, this.resolve(p.target || p.login)))
    if (parsed.length === 0) {
      this.error = this.tr('admin.migr_bulk_none')
      return
    }
    this.error = null
    this.drafts = [...this.drafts, ...parsed]
    this.bulk = ''
  }

  async runProbe() {
    const first = this.drafts.find(d => d.password !== '')
    if (!first) {
      this.probeMsg = this.tr('admin.migr_probe_needs_account')
      return
    }
    this.probeMsg = null
    try {
      const result = await this.probe.mutateAsync({
        service: this.service,
        source: { kind: 'imap', host: this.host.trim(), port: Number(this.port) || 0, security: this.security },
        login:  first.login,
        password: first.password,
      })
      if (result.ok) {
        this.folders = result.folders ?? []
        this.probeMsg = null
      } else {
        this.folders = null
        this.probeMsg = result.error ?? this.tr('admin.migr_probe_failed')
      }
    } catch (e) {
      this.folders = null
      this.probeMsg = errorMessage(e, this.tr('admin.migr_probe_failed'))
    }
  }

  async submit() {
    this.error = null
    try {
      const campaign = await this.create.mutateAsync({
        name:    this.name.trim(),
        service: this.service,
        source:  { kind: 'imap', host: this.host.trim(), port: Number(this.port) || 0, security: this.security },
        since:   this.since === '' ? null : this.since,
        exclude_folders: this.excluded,
        accounts: this.ready.map(d => ({
          source_login:   d.login,
          password:       d.password,
          target_user_id: d.targetId,
        })),
        start: this.startNow,
      })
      this.props.onCreated(campaign)
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.migr_save_failed'))
    }
  }

  forward() {
    this.step = this.order[Math.min(this.index + 1, this.order.length - 1)]
  }

  back() {
    this.step = this.order[Math.max(this.index - 1, 0)]
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
 if (this.last) void this.submit(); else this.forward() }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  combo_box_selected_value_changed(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(this.step === 'source')) return undefined as never
    const value = args.value as string
 this.security = value; this.port = value === 'ssl' ? '993' : '143' }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'mapping')) return undefined as never
    this.drafts = [...this.drafts, newDraft()]
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const { d } = args.row as RowOf_rows_drafts
    if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.drafts = this.drafts.map(x => (x.key === d.key ? { ...x, login: e.target.value } : x))
  }

  text_field_text_changed2(_sender: unknown, args: EventArgs) {
    const { d } = args.row as RowOf_rows_drafts
    if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.drafts = this.drafts.map(x => (x.key === d.key ? { ...x, password: e.target.value } : x))
  }

  combo_box_selected_value_changed2(_sender: unknown, args: ValueChangedEventArgs) {
    const { d } = args.row as RowOf_rows_drafts
    if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
    const value = args.value as string
    this.drafts = this.drafts.map(x => (x.key === d.key ? { ...x, targetId: value } : x))
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { d } = args.row as RowOf_rows_drafts
    if (!(this.step === 'mapping') || !(this.drafts.length > 0)) return undefined as never
    this.drafts = this.drafts.filter(x => x.key !== d.key)
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'range')) return undefined as never
    void this.runProbe()
  }

  panel_click2(_sender: unknown, args: MouseEventArgs) {
    const { f, off } = args.row as RowOf_rows_folders
    if (!(this.step === 'range') || !(this.folders && this.folders.length > 0)) return undefined as never
    this.excluded = off ? this.excluded.filter(n => n !== f.name) : [...this.excluded, f.name]
  }

  /** `setStep` of the TSX: a value, or an update of the previous one. */
  setStep(value: CampaignWizard['step'] | ((prev: CampaignWizard['step']) => CampaignWizard['step'])) {
    this.step = typeof value === 'function' ? (value as (prev: CampaignWizard['step']) => CampaignWizard['step'])(this.step) : value
  }

  /** `setName` of the TSX: a value, or an update of the previous one. */
  setName(value: CampaignWizard['name'] | ((prev: CampaignWizard['name']) => CampaignWizard['name'])) {
    this.name = typeof value === 'function' ? (value as (prev: CampaignWizard['name']) => CampaignWizard['name'])(this.name) : value
  }

  /** `setPort` of the TSX: a value, or an update of the previous one. */
  setPort(value: CampaignWizard['port'] | ((prev: CampaignWizard['port']) => CampaignWizard['port'])) {
    this.port = typeof value === 'function' ? (value as (prev: CampaignWizard['port']) => CampaignWizard['port'])(this.port) : value
  }

  /** `setBulk` of the TSX: a value, or an update of the previous one. */
  setBulk(value: CampaignWizard['bulk'] | ((prev: CampaignWizard['bulk']) => CampaignWizard['bulk'])) {
    this.bulk = typeof value === 'function' ? (value as (prev: CampaignWizard['bulk']) => CampaignWizard['bulk'])(this.bulk) : value
  }

  /** `setSince` of the TSX: a value, or an update of the previous one. */
  setSince(value: CampaignWizard['since'] | ((prev: CampaignWizard['since']) => CampaignWizard['since'])) {
    this.since = typeof value === 'function' ? (value as (prev: CampaignWizard['since']) => CampaignWizard['since'])(this.since) : value
  }

}

type RowOf_rows_drafts = CampaignWizard['rows_drafts'][number]
type RowOf_rows_folders = CampaignWizard['rows_folders'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type CampaignWizardStores = ReturnType<CampaignWizard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type CampaignWizardHooks = ReturnType<CampaignWizard['useHooks']>

export default CampaignWizard.component()
