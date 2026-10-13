/**
 * Code-behind of `MailSettingsPanel.kbview` (converted from `MailSettingsPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useToast } from "@ui"
import type { DropdownOption } from "@ui"
import { api } from "../../core/api/client"
import { useAdminAction } from "../adminAction"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './MailSettingsPanel.kbview'
import * as __parts from './MailSettingsPanel.parts.tsx'

interface MailSettings {
  enabled:      boolean
  host:         string
  port:         number
  security:     'none' | 'starttls' | 'tls'
  username:     string
  has_password: boolean
  from_address: string
  from_name:    string
  public_url:   string
  usable:       boolean
}

interface TestResult {
  ok:         boolean
  message:    string
  detail?:    string
  hint?:      string
  to:         string
  host:       string
  port:       number
  security:   string
  elapsed_ms: number
}

interface FormState {
  enabled:      boolean
  host:         string
  port:         string
  security:     string
  username:     string
  password:     string
  from_address: string
  from_name:    string
  public_url:   string
}

const toForm = (s: MailSettings): FormState => ({
  enabled:      s.enabled,
  host:         s.host,
  port:         String(s.port),
  security:     s.security,
  username:     s.username,
  password:     '',
  from_address: s.from_address,
  from_name:    s.from_name,
  public_url:   s.public_url,
})

const DEFAULT_PORT: Record<string, string> = { none: '25', starttls: '587', tls: '465' }

const IS_DEFAULT_PORT = (port: string) => Object.values(DEFAULT_PORT).includes(port)

export class MailSettingsPanel extends ViewBase {
  @bind accessor form: FormState | null = null
  @bind accessor testTo = ''
  @bind accessor result: TestResult | null = null
  @bind accessor wantTest = false
  tr!: MailSettingsPanelStores['t']
  toast!: MailSettingsPanelStores['toast']
  testRef!: MailSettingsPanelStores['testRef']
  settings!: MailSettingsPanelStores['settings']
  isLoading!: boolean
  save!: MailSettingsPanelStores['save']
  sendTest!: MailSettingsPanelHooks['sendTest']
  securityOptions!: DropdownOption[]
  dirty!: boolean

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const qc = useQueryClient()
    const toast = useToast()
    const testRef = useRef<HTMLInputElement>(null)
    const { data: settings, isLoading } = useQuery({
      queryKey: ['admin', 'mail-settings'],
      queryFn: () => api.get<MailSettings>('/admin/mail/settings').then(r => r.data),
    })
    const save = useMutation({
      mutationFn: (payload: Record<string, unknown>) => api.patch('/admin/mail/settings', payload),
      onSuccess: async () => {
        toast.success(t('mailsetup.saved'))
        // Await the refetch before dropping the local edits: dropping them first
        // would flash the pre-save values for the length of a round trip.
        await qc.invalidateQueries({ queryKey: ['admin', 'mail-settings'] })
      },
      onError: (e: unknown) => {
        const detail = apiErrorDetail(e)
        toast.error(detail || t('mailsetup.test_failed'))
      },
    })
    const securityOptions: DropdownOption[] = useMemo(() => ([
      { value: 'starttls', label: t('mailsetup.sec_starttls') },
      { value: 'tls',      label: t('mailsetup.sec_tls') },
      { value: 'none',     label: t('mailsetup.sec_none') },
    ]), [t])
    return { t, qc, toast, testRef, settings, isLoading, save, securityOptions }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const testRef = this.testRef
    const settings = this.settings
    useAdminAction('test', () => this.wantTest = true)
    useEffect(() => {
      if (!this.wantTest || !testRef.current) return
      this.wantTest = false
      testRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
      testRef.current.focus()
      // `form` is in the list on purpose: the card does not exist while the
      // settings are still loading, so the request has to be re-tried once it does.
    }, [this.wantTest, this.form])
    useEffect(() => { if (settings) this.form = toForm(settings) }, [settings])
    const sendTest = useMutation({
      mutationFn: () =>
        api.post<TestResult>('/admin/mail/test', { to: this.testTo.trim() || undefined }).then(r => r.data),
      onSuccess: this.memo("setResult:bound", [], () => this.setResult.bind(this)),
      onError: (e: unknown) => {
        const detail = apiErrorDetail(e)
        toast.error(detail || t('mailsetup.test_failed'))
      },
    })
    this.publish({ sendTest })
    const form = this.form
    const dirty = useMemo(() => {
      if (!settings || !form) return false
      return form.enabled      !== settings.enabled
          || form.host         !== settings.host
          || form.port         !== String(settings.port)
          || form.security     !== settings.security
          || form.username     !== settings.username
          || form.password     !== ''
          || form.from_address !== settings.from_address
          || form.from_name    !== settings.from_name
          || form.public_url   !== settings.public_url
    }, [settings, form])
    this.publish({ dirty })
    return { sendTest, dirty }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, testRef: s.testRef, settings: s.settings, isLoading: s.isLoading, save: s.save, securityOptions: s.securityOptions })
    const h = this.useHooks()
    this.publish({ sendTest: h.sendTest, dirty: h.dirty })
  }

  get show_case_1() {
    return !!(this.isLoading || !this.form || !this.settings)
  }

  get show_main() {
    return !(this.isLoading || !this.form || !this.settings)
  }

  get show_settings_usable() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return !this.settings.usable
  }

  get variant() {
    if (!(!(this.isLoading || !this.form || !this.settings)) || !(!this.settings.usable)) return undefined as never
    return this.settings.enabled ? 'warning' : 'info'
  }

  get callout_text() {
    if (!(!(this.isLoading || !this.form || !this.settings)) || !(!this.settings.usable)) return undefined as never
    return this.settings.enabled ? this.tr('mailsetup.not_configured') : this.tr('mailsetup.disabled')
  }

  get on() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return this.form.enabled
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.form, this.memo, this.isLoading, this.settings], () => {
      if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
      return ({ t: this.tr, form: this.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.form, this.memo, this.isLoading, this.settings, this.securityOptions], () => {
      if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
      return ({ t: this.tr, form: this.form, onSecurityChange: this.memo("onSecurityChange:bound", [], () => this.onSecurityChange.bind(this)), securityOptions: this.securityOptions })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part4() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part4
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.settings, this.form, this.memo, this.isLoading], () => {
      if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
      return ({ t: this.tr, settings: this.settings, form: this.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part5() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part5
  }

  get show_settings_has_password() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return this.settings.has_password
  }

  get enabled_unless_save_is_pending() {
    if (!(!(this.isLoading || !this.form || !this.settings)) || !(this.settings.has_password)) return undefined as never
    return !(this.save.isPending)
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part6() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part6
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part7() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part7
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part8() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part8
  }

  get part9_props() {
    return this.memo('part9_props', [this.tr, this.testRef, this.testTo, this.memo, this.settings, this.isLoading, this.form], () => {
      if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
      return ({ t: this.tr, testRef: this.testRef, testTo: this.testTo, setTestTo: this.memo("setTestTo:bound", [], () => this.setTestTo.bind(this)), settings: this.settings })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part9() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return __parts.Part9
  }

  get enabled_unless_dirty() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return !(this.dirty)
  }

  get show_result() {
    return this.memo('show_result', [this.result, this.isLoading, this.form, this.settings], () => {
      if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
      return !!(this.result)
    })
  }

  get part10_props() {
    return this.memo('part10_props', [this.result, this.tr, this.isLoading, this.form, this.settings], () => {
      if (!(!(this.isLoading || !this.form || !this.settings)) || !(this.result)) return undefined as never
      return ({ result: this.result, t: this.tr, result_detail: this.result?.detail, result_hint: this.result?.hint })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part10() {
    if (!(!(this.isLoading || !this.form || !this.settings)) || !(this.result)) return undefined as never
    return __parts.Part10
  }

  set<K extends keyof FormState>(key: K, value: FormState[K]) {
    this.form = (this.form ? { ...this.form, [key]: value } : this.form)
  }

  submit() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    const payload: Record<string, unknown> = {
      enabled:      this.form.enabled,
      host:         this.form.host.trim(),
      port:         Number(this.form.port) || 587,
      security:     this.form.security,
      username:     this.form.username,
      from_address: this.form.from_address.trim(),
      from_name:    this.form.from_name,
      public_url:   this.form.public_url.trim(),
    }
    // Absent = unchanged. Sending an empty string would CLEAR the stored one,
    // which is what the explicit "clear" control below is for.
    if (this.form.password) payload.password = this.form.password
    this.save.mutate(payload)
  }

  clearPassword() {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    return this.save.mutate({ password: '' })
  }

  onSecurityChange(value: string) {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    this.form = ((prev) => {
      if (!prev) return prev
      const port = IS_DEFAULT_PORT(prev.port) ? DEFAULT_PORT[value] ?? prev.port : prev.port
      return { ...prev, security: value, port }
    })(this.form)
  }

  switch_checked_changed(_sender: unknown, args: EventArgs) {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.set('enabled', e.target.checked)
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading || !this.form || !this.settings)) || !(this.dirty)) return undefined as never
    this.form = toForm(this.settings)
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.isLoading || !this.form || !this.settings))) return undefined as never
 this.result = null; this.sendTest.mutate() }

  /** `setResult` of the TSX: a value, or an update of the previous one. */
  setResult(value: TestResult | null | ((prev: TestResult | null) => TestResult | null)) {
    this.result = typeof value === 'function' ? (value as (prev: TestResult | null) => TestResult | null)(this.result) : value
  }

  /** `setTestTo` of the TSX: a value, or an update of the previous one. */
  setTestTo(value: MailSettingsPanel['testTo'] | ((prev: MailSettingsPanel['testTo']) => MailSettingsPanel['testTo'])) {
    this.testTo = typeof value === 'function' ? (value as (prev: MailSettingsPanel['testTo']) => MailSettingsPanel['testTo'])(this.testTo) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type MailSettingsPanelStores = ReturnType<MailSettingsPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type MailSettingsPanelHooks = ReturnType<MailSettingsPanel['useHooks']>

export default MailSettingsPanel.component()
