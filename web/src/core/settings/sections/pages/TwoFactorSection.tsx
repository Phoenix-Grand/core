/**
 * Code-behind of `TwoFactorSection.kbcontrol` (converted from `TwoFactorSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { Fragment } from 'react'
import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Callout } from "@ui"
import { useAuthStore } from "../../../store/authStore"
import { api } from "../../../api/client"
import { BackupCodesPanel } from "../controls/BackupCodesPanel"

import { ViewBase } from './TwoFactorSection.kbcontrol'
import * as __parts from './TwoFactorSection.parts.tsx'

type TotpSetupStep = 'idle' | 'qr' | 'verify' | 'codes' | 'done'

interface Admin2faStatus {
  required: boolean
  satisfied: boolean
  grace_until: string | null
  days_left: number | null
  locked_out: boolean
}

export class TwoFactorSection extends ViewBase {
  @bind accessor step: TotpSetupStep = 'idle'
  @bind accessor uri = ''
  @bind accessor secret = ''
  @bind accessor code = ''
  @bind accessor error = ''
  @bind accessor disableCode = ''
  @bind accessor disableError = ''
  @bind accessor showDisableForm = false
  @bind accessor freshCodes: string[] = []
  @bind accessor requirement: Admin2faStatus | null = null
  tr!: TwoFactorSectionStores['t']
  user!: TwoFactorSectionStores['user']
  updateUser!: TwoFactorSectionStores['updateUser']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { user, updateUser } = useAuthStore()
    return { t, user, updateUser }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    useEffect(() => {
      let cancelled = false
      api
        .get<{ admin_2fa: Admin2faStatus }>('/me/security')
        .then(({ data }) => { if (!cancelled) this.requirement = data.admin_2fa })
        .catch(() => { /* purely informational: a failure must not break the tab */ })
      return () => { cancelled = true }
    }, [this.enabled])
    return {  }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, user: s.user, updateUser: s.updateUser })
    this.useHooks()
  }

  get enabled(): boolean {
    return this.user?.totp_enabled ?? false
  }

  get requirementBanner() {
    return this.memo('requirementBanner', [this.requirement, this.tr], () => this.requirement && this.requirement.required && !this.requirement.satisfied ? (
      <Callout
        variant={this.requirement.locked_out ? 'danger' : 'warning'}
        title={this.tr(this.requirement.locked_out ? 'settings.tfa_req_locked_title' : 'settings.tfa_req_title')}
        className="mb-4"
        t={this.tr}
      >
        {this.requirement.locked_out
          ? this.tr('settings.tfa_req_locked_desc')
          : this.tr('settings.tfa_req_desc', { count: this.requirement.days_left ?? 0 })}
      </Callout>
    ) : null)
  }

  get show_case_1() {
    return !!(this.step === 'codes')
  }

  /** `<BackupCodesPanel>`, rendered by a ReactHost. */
  get BackupCodesPanel() {
    if (!(this.step === 'codes')) return undefined as never
    return BackupCodesPanel
  }

  get backup_codes_panel_props() {
    return this.memo('backup_codes_panel_props', [this.freshCodes, this.step], () => {
      if (!(this.step === 'codes')) return undefined as never
      return ({ codes: this.freshCodes, onDone: () => this.step = 'done' } as React.ComponentProps<typeof BackupCodesPanel>)
    })
  }

  get show_case_2() {
    return !(this.step === 'codes') && !!(this.enabled)
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_requirement_banner() {
    return this.memo('content_requirement_banner', [this.requirementBanner, this.step, this.enabled], () => {
      if (!(!(this.step === 'codes')) || !(this.enabled)) return undefined as never
      return ({ children: this.requirementBanner })
    })
  }

  get show_show_disable_form() {
    if (!(!(this.step === 'codes')) || !(this.enabled)) return undefined as never
    return !this.showDisableForm
  }

  get show_not_show_disable_form() {
    if (!(!(this.step === 'codes')) || !(this.enabled)) return undefined as never
    return !(!this.showDisableForm)
  }

  get part1_props() {
    return this.memo('part1_props', [this.disableCode, this.memo, this.tr, this.step, this.enabled, this.showDisableForm], () => {
      if (!(!(this.step === 'codes')) || !(this.enabled) || !(!(!this.showDisableForm))) return undefined as never
      return ({ disableCode: this.disableCode, setDisableCode: this.memo("setDisableCode:bound", [], () => this.setDisableCode.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<TextField> inputMode, autoFocus: no .kbview property). */
  get Part1() {
    if (!(!(this.step === 'codes')) || !(this.enabled) || !(!(!this.showDisableForm))) return undefined as never
    return __parts.Part1
  }

  get show_disable_error() {
    if (!(!(this.step === 'codes')) || !(this.enabled) || !(!(!this.showDisableForm))) return undefined as never
    return !!(this.disableError)
  }

  get enabled_unless_disable_code() {
    if (!(!(this.step === 'codes')) || !(this.enabled) || !(!(!this.showDisableForm))) return undefined as never
    return !(this.disableCode.length !== 6)
  }

  get show_case_3() {
    return !(this.step === 'codes') && !(this.enabled) && !!(this.step === 'done')
  }

  get show_case_4() {
    return !(this.step === 'codes') && !(this.enabled) && !(this.step === 'done') && !!(this.step === 'qr')
  }

  get part2_props() {
    return this.memo('part2_props', [this.uri, this.step, this.enabled], () => {
      if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
      return ({ uri: this.uri })
    })
  }

  /** A part of the screen still written in React (<QRCode> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.secret, this.step, this.enabled], () => {
      if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
      return ({ t: this.tr, secret: this.secret })
    })
  }

  /** A part of the screen still written in React (<details> has no .kbview element yet). */
  get Part3() {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.code, this.memo, this.tr, this.step, this.enabled], () => {
      if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
      return ({ code: this.code, setCode: this.memo("setCode:bound", [], () => this.setCode.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<TextField> inputMode, autoFocus: no .kbview property). */
  get Part4() {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
    return __parts.Part4
  }

  get show_error() {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
    return !!(this.error)
  }

  get enabled_unless_code() {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
    return !(this.code.length !== 6)
  }

  get show_main() {
    return !(this.step === 'codes') && !(this.enabled) && !(this.step === 'done') && !(this.step === 'qr')
  }

  get content_requirement_banner2() {
    return this.memo('content_requirement_banner2', [this.requirementBanner, this.step, this.enabled], () => {
      if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(!(this.step === 'qr'))) return undefined as never
      return ({ children: this.requirementBanner })
    })
  }

  get show_error2() {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(!(this.step === 'qr'))) return undefined as never
    return !!(this.error)
  }

  async startSetup() {
    this.error = ''
    try {
      const { data } = await api.post<{ uri: string; secret: string }>('/me/2fa/setup')
      this.uri = data.uri
      this.secret = data.secret
      this.step = 'qr'
    } catch (err: unknown) {
      this.error = (err as { message?: string })?.message ?? this.tr('settings.error')
    }
  }

  async enableTotp(e: React.FormEvent) {
    e.preventDefault()
    this.error = ''
    try {
      const { data } = await api.post<{ backup_codes: string[] }>('/me/2fa/enable', { code: this.code })
      this.updateUser({ totp_enabled: true })
      // The codes arrive with the enrolment and are readable exactly here. The
      // step exists so the sheet cannot be skipped past by the same click that
      // turned the second factor on.
      this.freshCodes = data.backup_codes ?? []
      this.step = 'codes'
      this.code = ''
    } catch (err: unknown) {
      this.error = (err as { message?: string })?.message ?? this.tr('settings.tfa_code_wrong')
    }
  }

  async disableTotp(e: React.FormEvent) {
    e.preventDefault()
    this.disableError = ''
    try {
      await api.delete('/me/2fa', { data: { code: this.disableCode } })
      this.updateUser({ totp_enabled: false })
      this.showDisableForm = false
      this.disableCode = ''
    } catch (err: unknown) {
      this.disableError = (err as { message?: string })?.message ?? this.tr('settings.tfa_code_wrong')
    }
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.step === 'codes')) || !(this.enabled) || !(!this.showDisableForm)) return undefined as never
    this.showDisableForm = true
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.disableTotp(args.native as never)
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.step === 'codes')) || !(this.enabled) || !(!(!this.showDisableForm))) return undefined as never
 this.showDisableForm = false; this.disableCode = ''; this.disableError = '' }

  panel_submit2(_sender: unknown, args: EventArgs) {
    return this.enableTotp(args.native as never)
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.step === 'codes')) || !(!(this.enabled)) || !(!(this.step === 'done')) || !(this.step === 'qr')) return undefined as never
 this.step = 'idle'; this.code = ''; this.error = '' }

  /** `setDisableCode` of the TSX: a value, or an update of the previous one. */
  setDisableCode(value: TwoFactorSection['disableCode'] | ((prev: TwoFactorSection['disableCode']) => TwoFactorSection['disableCode'])) {
    this.disableCode = typeof value === 'function' ? (value as (prev: TwoFactorSection['disableCode']) => TwoFactorSection['disableCode'])(this.disableCode) : value
  }

  /** `setCode` of the TSX: a value, or an update of the previous one. */
  setCode(value: TwoFactorSection['code'] | ((prev: TwoFactorSection['code']) => TwoFactorSection['code'])) {
    this.code = typeof value === 'function' ? (value as (prev: TwoFactorSection['code']) => TwoFactorSection['code'])(this.code) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type TwoFactorSectionStores = ReturnType<TwoFactorSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type TwoFactorSectionHooks = ReturnType<TwoFactorSection['useHooks']>

export default TwoFactorSection.component()
