/**
 * Code-behind of `LoginPage.kbview` (converted from `LoginPage.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useState, useEffect } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { Eye, EyeOff } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import axios from "axios"
import { useAuthStore } from "../store/authStore"
import { authApi, type CaptchaChallenge } from "../api/auth"
import { OutlinedField } from "@ui"
import LoginAnimation from "./LoginAnimationGL"
import { animTuning, parseAnimParams } from "./animTuning"
import { InstanceLogo } from "../shell/controls/InstanceLogo"
import { getPublicConfig } from "../api/publicConfig"

import { ViewBase } from './LoginPage.kbview'
import * as __parts from './LoginPage.parts'

const PRIMARY = '#1a73e8'

function usePublicConfig() {
  return useQuery({
    queryKey: ['public-config'],
    queryFn: getPublicConfig,
    staleTime: 60_000,
  })
}

function useRegistrationOpen(): boolean {
  const { data } = usePublicConfig()
  const value = data?.['auth.registration_open']
  return value === undefined ? true : Boolean(value)
}

function useDefaultModulePath(): string | null {
  const { data } = usePublicConfig()
  const value = data?.['navigation.default_module']
  return typeof value === 'string' && value.length > 0 ? value : null
}

interface OAuthProviderInfo {
  slug:         string
  display_name: string
  button_color: string | null
}

function useAuthMethods() {
  return useQuery({
    queryKey: ['auth-methods'],
    queryFn: () =>
      axios
        .get<{ methods: { local: boolean; directory: boolean; sso: boolean }; password_form: boolean }>(
          '/api/v1/auth/methods',
        )
        .then((r) => r.data),
    staleTime: 60_000,
  })
}

function useOAuthProviders() {
  return useQuery({
    queryKey: ['oauth-providers'],
    queryFn: () =>
      axios
        .get<{ providers: OAuthProviderInfo[] }>('/api/v1/auth/providers')
        .then((r) => r.data.providers),
    staleTime: 60_000,
  })
}

export type LoginPageProps = { initialStep?: 'credentials' | 'forgot' }

export class LoginPage extends ViewBase {
  @bind accessor login = ''
  @bind accessor password = ''
  @bind accessor showPassword = false
  @bind accessor error = ''
  @bind accessor captchaRequired = false
  @bind accessor captcha: CaptchaChallenge | null = null
  @bind accessor captchaAnswer = ''
  @bind accessor sliderX = 0
  @bind accessor captchaLoading = false
  @bind accessor totpCode = ''
  @bind accessor useBackupCode = false
  @bind accessor forgotEmail = ''
  @bind accessor forgotSubmitted = false
  @bind accessor forgotLoading = false
  step!: 'credentials' | 'totp' | 'forgot'
  setStep!: LoginPageHooks['setStep']
  doLogin!: (email: string, password: string, captcha?: { id: string; answer: string; }) => Promise<{ requiresTotp: boolean; }>
  verifyTotp!: (code: string, kind?: "totp" | "backup") => Promise<void>
  isLoading!: boolean
  tr!: LoginPageStores['t']
  navigate!: LoginPageStores['navigate']
  location!: LoginPageStores['location']
  registrationOpen!: boolean
  defaultModulePath!: string | null
  oauthProviders!: LoginPageStores['oauthProviders']
  authMethods!: LoginPageStores['authMethods']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { login: doLogin, verifyTotp, isLoading } = useAuthStore()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const location = useLocation()
    const registrationOpen = useRegistrationOpen()
    const defaultModulePath = useDefaultModulePath()
    const { data: oauthProviders } = useOAuthProviders()
    const { data: authMethods } = useAuthMethods()
    const { data: publicConfig } = usePublicConfig()
    useEffect(() => {
      const raw = publicConfig?.['appearance.login_animation']
      if (raw !== undefined) animTuning.set(parseAnimParams(raw))
    }, [publicConfig])
    return { doLogin, verifyTotp, isLoading, t, navigate, location, registrationOpen, defaultModulePath, oauthProviders, authMethods, publicConfig }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [step, setStep] = useState<'credentials' | 'totp' | 'forgot'>(this.initialStep)
    this.publish({ step, setStep })
    useEffect(() => {
      setStep(this.initialStep)
      this.error = ''
      if (this.initialStep === 'forgot') {
        this.forgotSubmitted = false
        this.forgotEmail = ''
      }
    }, [this.initialStep])
    return { step, setStep }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ doLogin: s.doLogin, verifyTotp: s.verifyTotp, isLoading: s.isLoading, tr: s.t, navigate: s.navigate, location: s.location, registrationOpen: s.registrationOpen, defaultModulePath: s.defaultModulePath, oauthProviders: s.oauthProviders, authMethods: s.authMethods })
    const h = this.useHooks()
    this.publish({ step: h.step, setStep: h.setStep })
  }

  get initialStep() {
    return this.props.initialStep ?? 'credentials'
  }

  get showPasswordForm(): boolean {
    return this.authMethods?.password_form ?? true
  }

  get showProviders(): boolean {
    return (this.authMethods?.methods.sso ?? true) && (this.oauthProviders?.length ?? 0) > 0
  }

  get from(): string | undefined {
    return (this.location.state as { from?: string } | null)?.from
  }

  /** `<LoginAnimation>`, rendered by a ReactHost. */
  get LoginAnimation() {
    return LoginAnimation
  }

  get login_animation_props() {
    return this.memo('login_animation_props', [], () => ({ yShift: 0.06 }))
  }

  /** `<InstanceLogo>`, rendered by a ReactHost. */
  get InstanceLogo() {
    return InstanceLogo
  }

  get instance_logo_props() {
    return this.memo('instance_logo_props', [], () => ({ size: 40, className: "text-white" }))
  }

  get span_text() {
    return this.memo('span_text', [], () => "Kubuno v" + String(__APP_VERSION__ ?? ''))
  }

  get tooltip() {
    return `Kubuno ${__APP_BUILD__}`
  }

  get instance_logo_props2() {
    return this.memo('instance_logo_props2', [], () => ({ size: 26, className: "text-primary" }))
  }

  get show_step_totp() {
    return this.step === 'totp'
  }

  get show_not_step_totp() {
    return !(this.step === 'totp')
  }

  get p_text() {
    if (!(this.step === 'totp')) return undefined as never
    return this.useBackupCode ? this.tr('login.backup_subtitle') : this.tr('login.tfa_subtitle')
  }

  get part1_props() {
    return this.memo('part1_props', [this.useBackupCode, this.totpCode, this.memo, this.tr, this.step], () => {
      if (!(this.step === 'totp')) return undefined as never
      return ({ useBackupCode: this.useBackupCode, totpCode: this.totpCode, setTotpCode: this.memo("setTotpCode:bound", [], () => this.setTotpCode.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<div onFocusCapture onBlurCapture>: attribute(s) without a .kbview property). */
  get Part1() {
    if (!(this.step === 'totp')) return undefined as never
    return __parts.Part1
  }

  get show_error() {
    if (!(this.step === 'totp')) return undefined as never
    return !!(this.error)
  }

  get text() {
    if (!(this.step === 'totp')) return undefined as never
    return this.useBackupCode ? this.tr('login.use_app_code') : this.tr('login.use_backup_code')
  }

  get enabled_unless_use_backup_code_totp_code_replace() {
    if (!(this.step === 'totp')) return undefined as never
    return !(this.useBackupCode
                      ? this.totpCode.replace(/[^A-Za-z0-9]/g, '').length !== 10
                      : this.totpCode.length !== 6)
  }

  get button_text() {
    if (!(this.step === 'totp')) return undefined as never
    return this.isLoading ? this.tr('login.verifying') : this.tr('login.verify')
  }

  get show_step_forgot() {
    if (!(!(this.step === 'totp'))) return undefined as never
    return this.step === 'forgot'
  }

  get show_not_step_forgot() {
    if (!(!(this.step === 'totp'))) return undefined as never
    return !(this.step === 'forgot')
  }

  get show_not_forgot_submitted() {
    if (!(!(this.step === 'totp')) || !(this.step === 'forgot')) return undefined as never
    return !(this.forgotSubmitted)
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.step, this.forgotSubmitted], () => {
      if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(this.forgotSubmitted)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part2() {
    if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(this.forgotSubmitted)) return undefined as never
    return __parts.Part2
  }

  /** `<OutlinedField>`, rendered by a ReactHost. */
  get OutlinedField() {
    if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(!(this.forgotSubmitted))) return undefined as never
    return OutlinedField
  }

  get outlined_field_props() {
    return this.memo('outlined_field_props', [this.tr, this.forgotEmail, this.memo, this.step, this.forgotSubmitted], () => {
      if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(!(this.forgotSubmitted))) return undefined as never
      return ({ label: this.tr('forgot.email_label'), value: this.forgotEmail, onChange: this.memo("setForgotEmail:bound", [], () => this.setForgotEmail.bind(this)), type: "email", inputMode: "email", autoComplete: "email", autoFocus: true, primaryColor: PRIMARY })
    })
  }

  get enabled_unless_forgot_email_trim() {
    if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(!(this.forgotSubmitted))) return undefined as never
    return !(!this.forgotEmail.trim())
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.step, this.forgotSubmitted], () => {
      if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(!(this.forgotSubmitted))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part3() {
    if (!(!(this.step === 'totp')) || !(this.step === 'forgot') || !(!(this.forgotSubmitted))) return undefined as never
    return __parts.Part3
  }

  get visible() {
    return this.memo('visible', [this.forgotSubmitted, this.show_step_forgot, this.step], () => {
      if (!(!(this.step === 'totp'))) return undefined as never
      return this.forgotSubmitted && this.show_step_forgot
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_forgot_submitted, this.show_step_forgot, this.step], () => {
      if (!(!(this.step === 'totp'))) return undefined as never
      return this.show_not_forgot_submitted && this.show_step_forgot
    })
  }

  /** A part of the screen still written in React (<a> with a computed style). */
  get Part4() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showProviders)) return undefined as never
    return __parts.Part4
  }

  /** The rows of the Repeater over `oauthProviders!`. */
  get rows_oauth_providers() {
    return this.memo('rows_oauth_providers', [this.oauthProviders, this.step, this.showProviders, this.tr], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showProviders)) return undefined as never
      return this.oauthProviders!.map((p) => {
      return { p, part4_props: ((!(this.step === 'totp')) && (!(this.step === 'forgot')) && (this.showProviders)) ? ({ p: p, t: this.tr }) : undefined, key: p.slug }
    })
    })
  }

  get visible3() {
    return this.memo('visible3', [this.showPasswordForm, this.showProviders, this.step], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot'))) return undefined as never
      return this.showPasswordForm && this.showProviders
    })
  }

  get show_show_password_form_show_providers() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot'))) return undefined as never
    return !this.showPasswordForm && !this.showProviders
  }

  /** `<OutlinedField>`, rendered by a ReactHost. */
  get OutlinedField2() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
    return OutlinedField
  }

  get outlined_field_props2() {
    return this.memo('outlined_field_props2', [this.tr, this.login, this.memo, this.step, this.showPasswordForm], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
      return ({ label: this.tr('login.email'), value: this.login, onChange: this.memo("setLogin:bound", [], () => this.setLogin.bind(this)), autoComplete: "username", primaryColor: PRIMARY })
    })
  }

  get outlined_field_props3() {
    return this.memo('outlined_field_props3', [this.tr, this.password, this.memo, this.showPassword, this.step, this.showPasswordForm], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
      return ({ label: this.tr('login.password'), value: this.password, onChange: this.memo("setPassword:bound", [], () => this.setPassword.bind(this)), type: this.showPassword ? 'text' : 'password', autoComplete: "current-password", primaryColor: PRIMARY, trailing: <button
                    type="button"
                    onClick={() => this.showPassword = !this.showPassword}
                    className="text-text-tertiary hover:text-text-secondary transition-colors"
                    style={{ pointerEvents: 'auto', display: 'flex' }}
                  >
                    {this.showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button> })
    })
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.step, this.showPasswordForm], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part5() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
    return __parts.Part5
  }

  get show_captcha_required_captcha() {
    return this.memo('show_captcha_required_captcha', [this.captchaRequired, this.captcha, this.step, this.showPasswordForm], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
      return !!(this.captchaRequired && this.captcha)
    })
  }

  get label_text() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
    return this.captcha.type === 'slider'
                      ? this.tr('login.captcha_slider_label')
                      : this.captcha.type === 'math'
                      ? this.tr('login.captcha_math_label')
                      : this.tr('login.captcha_label')
  }

  get enabled_unless_captcha_loading() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
    return !(this.captchaLoading)
  }

  get part6_props() {
    return this.memo('part6_props', [this.captchaLoading, this.step, this.showPasswordForm, this.captchaRequired, this.captcha], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
      return ({ captchaLoading: this.captchaLoading })
    })
  }

  /** A part of the screen still written in React (an icon with a computed className). */
  get Part6() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
    return __parts.Part6
  }

  get show_captcha_type_text() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
    return this.captcha.type === 'text'
  }

  get part7_props() {
    return this.memo('part7_props', [this.captcha, this.tr, this.step, this.showPasswordForm, this.captchaRequired], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'text')) return undefined as never
      return ({ captcha: this.captcha, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<img> has no .kbview element yet). */
  get Part7() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'text')) return undefined as never
    return __parts.Part7
  }

  get part8_props() {
    return this.memo('part8_props', [this.captchaAnswer, this.memo, this.tr, this.step, this.showPasswordForm, this.captchaRequired, this.captcha], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'text')) return undefined as never
      return ({ captchaAnswer: this.captchaAnswer, setCaptchaAnswer: this.memo("setCaptchaAnswer:bound", [], () => this.setCaptchaAnswer.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<div onFocusCapture onBlurCapture>: attribute(s) without a .kbview property). */
  get Part8() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'text')) return undefined as never
    return __parts.Part8
  }

  get show_captcha_type_math() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
    return this.captcha.type === 'math'
  }

  get part9_props() {
    return this.memo('part9_props', [this.captcha, this.captchaAnswer, this.memo, this.step, this.showPasswordForm, this.captchaRequired], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'math')) return undefined as never
      return ({ captcha: this.captcha, captchaAnswer: this.captchaAnswer, setCaptchaAnswer: this.memo("setCaptchaAnswer:bound", [], () => this.setCaptchaAnswer.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<div onFocusCapture onBlurCapture>: attribute(s) without a .kbview property). */
  get Part9() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'math')) return undefined as never
    return __parts.Part9
  }

  get show_captcha_type_slider() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha)) return undefined as never
    return this.captcha.type === 'slider'
  }

  get part10_props() {
    return this.memo('part10_props', [this.captcha, this.sliderX, this.step, this.showPasswordForm, this.captchaRequired], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'slider')) return undefined as never
      return ({ captcha: this.captcha, sliderX: this.sliderX })
    })
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part10() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'slider')) return undefined as never
    return __parts.Part10
  }

  get part11_props() {
    return this.memo('part11_props', [this.captcha, this.sliderX, this.memo, this.tr, this.step, this.showPasswordForm, this.captchaRequired], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'slider')) return undefined as never
      return ({ captcha: this.captcha, sliderX: this.sliderX, setSliderX: this.memo("setSliderX:bound", [], () => this.setSliderX.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part11() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.captchaRequired && this.captcha) || !(this.captcha.type === 'slider')) return undefined as never
    return __parts.Part11
  }

  get show_error2() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
    return !!(this.error)
  }

  get part12_props() {
    return this.memo('part12_props', [this.tr, this.step, this.showPasswordForm, this.registrationOpen], () => {
      if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.registrationOpen)) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Link style>). */
  get Part12() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm) || !(this.registrationOpen)) return undefined as never
    return __parts.Part12
  }

  get enabled_unless_login_trim_password() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
    return !(!this.login.trim() || !this.password)
  }

  get button_text2() {
    if (!(!(this.step === 'totp')) || !(!(this.step === 'forgot')) || !(this.showPasswordForm)) return undefined as never
    return this.isLoading ? this.tr('common.loading') : this.tr('login.submit')
  }

  get visible4() {
    return this.memo('visible4', [this.showProviders, this.show_not_step_forgot, this.step], () => {
      if (!(!(this.step === 'totp'))) return undefined as never
      return this.showProviders && this.show_not_step_forgot
    })
  }

  get visible5() {
    return this.memo('visible5', [this.visible3, this.show_not_step_forgot, this.step], () => {
      if (!(!(this.step === 'totp'))) return undefined as never
      return this.visible3 && this.show_not_step_forgot
    })
  }

  get visible6() {
    return this.memo('visible6', [this.show_show_password_form_show_providers, this.show_not_step_forgot, this.step], () => {
      if (!(!(this.step === 'totp'))) return undefined as never
      return this.show_show_password_form_show_providers && this.show_not_step_forgot
    })
  }

  get visible7() {
    return this.memo('visible7', [this.showPasswordForm, this.show_not_step_forgot, this.step], () => {
      if (!(!(this.step === 'totp'))) return undefined as never
      return this.showPasswordForm && this.show_not_step_forgot
    })
  }

  get visible8() {
    return this.memo('visible8', [this.show_step_forgot, this.show_not_step_totp], () => this.show_step_forgot && this.show_not_step_totp)
  }

  get visible9() {
    return this.memo('visible9', [this.visible, this.show_not_step_totp], () => this.visible && this.show_not_step_totp)
  }

  get visible10() {
    return this.memo('visible10', [this.visible2, this.show_not_step_totp], () => this.visible2 && this.show_not_step_totp)
  }

  get visible11() {
    return this.memo('visible11', [this.show_not_step_forgot, this.show_not_step_totp], () => this.show_not_step_forgot && this.show_not_step_totp)
  }

  get visible12() {
    return this.memo('visible12', [this.visible4, this.show_not_step_totp], () => this.visible4 && this.show_not_step_totp)
  }

  get visible13() {
    return this.memo('visible13', [this.visible5, this.show_not_step_totp], () => this.visible5 && this.show_not_step_totp)
  }

  get visible14() {
    return this.memo('visible14', [this.visible6, this.show_not_step_totp], () => this.visible6 && this.show_not_step_totp)
  }

  get visible15() {
    return this.memo('visible15', [this.visible7, this.show_not_step_totp], () => this.visible7 && this.show_not_step_totp)
  }

  postLoginPath() {
    return this.from ?? this.defaultModulePath ?? '/'
  }

  async loadCaptcha() {
    this.captchaLoading = true
    this.captchaAnswer = ''
    this.sliderX = 0
    try {
      const { data } = await authApi.getCaptcha()
      this.captcha = data
    } catch {
      // Best-effort: the widget stays and the person can retry with the button.
    } finally {
      this.captchaLoading = false
    }
  }

  async handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.error = ''
    try {
      // The answer is the typed text/number, or - for the slider - the pixel
      // position the piece was dropped at.
      const answer = this.captcha?.type === 'slider' ? String(this.sliderX) : this.captchaAnswer
      const cap = this.captchaRequired && this.captcha ? { id: this.captcha.challenge_id, answer } : undefined
      const { requiresTotp } = await this.doLogin(this.login, this.password, cap)
      if (requiresTotp) {
        this.setStep('totp')
      } else {
        this.navigate(this.postLoginPath())
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code
      const msg = (err as { message?: string })?.message
      // The server demands a CAPTCHA from now on: reveal the field and load a
      // fresh challenge. A spent or wrong challenge comes back here too, so we
      // always refresh - a challenge is single-use.
      if (code === 'CAPTCHA_REQUIRED') {
        this.captchaRequired = true
        await this.loadCaptcha()
      }
      this.error = msg ?? 'Identifiants invalides'
    }
  }

  async handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.error = ''
    try {
      await this.verifyTotp(this.totpCode, this.useBackupCode ? 'backup' : 'totp')
      this.navigate(this.postLoginPath())
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message
      this.error = msg ?? 'Code incorrect'
    }
  }

  async handleForgotSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.forgotLoading = true
    try {
      await authApi.forgotPassword(this.forgotEmail)
    } catch {
      // Toujours afficher le succès (pas d'énumération d'email).
    } finally {
      this.forgotLoading = false
      this.forgotSubmitted = true
    }
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.handleTotpSubmit(args.native as never)
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'totp')) return undefined as never
 this.useBackupCode = !this.useBackupCode; this.totpCode = ''; this.error = '' }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'totp')) return undefined as never
 this.setStep('credentials'); this.totpCode = ''; this.useBackupCode = false; this.error = '' }

  panel_submit2(_sender: unknown, args: EventArgs) {
    return this.handleForgotSubmit(args.native as never)
  }

  panel_submit3(_sender: unknown, args: EventArgs) {
    return this.handleSubmit(args.native as never)
  }

  /** `setTotpCode` of the TSX: a value, or an update of the previous one. */
  setTotpCode(value: LoginPage['totpCode'] | ((prev: LoginPage['totpCode']) => LoginPage['totpCode'])) {
    this.totpCode = typeof value === 'function' ? (value as (prev: LoginPage['totpCode']) => LoginPage['totpCode'])(this.totpCode) : value
  }

  /** `setForgotEmail` of the TSX: a value, or an update of the previous one. */
  setForgotEmail(value: LoginPage['forgotEmail'] | ((prev: LoginPage['forgotEmail']) => LoginPage['forgotEmail'])) {
    this.forgotEmail = typeof value === 'function' ? (value as (prev: LoginPage['forgotEmail']) => LoginPage['forgotEmail'])(this.forgotEmail) : value
  }

  /** `setLogin` of the TSX: a value, or an update of the previous one. */
  setLogin(value: LoginPage['login'] | ((prev: LoginPage['login']) => LoginPage['login'])) {
    this.login = typeof value === 'function' ? (value as (prev: LoginPage['login']) => LoginPage['login'])(this.login) : value
  }

  /** `setPassword` of the TSX: a value, or an update of the previous one. */
  setPassword(value: LoginPage['password'] | ((prev: LoginPage['password']) => LoginPage['password'])) {
    this.password = typeof value === 'function' ? (value as (prev: LoginPage['password']) => LoginPage['password'])(this.password) : value
  }

  /** `setCaptchaAnswer` of the TSX: a value, or an update of the previous one. */
  setCaptchaAnswer(value: LoginPage['captchaAnswer'] | ((prev: LoginPage['captchaAnswer']) => LoginPage['captchaAnswer'])) {
    this.captchaAnswer = typeof value === 'function' ? (value as (prev: LoginPage['captchaAnswer']) => LoginPage['captchaAnswer'])(this.captchaAnswer) : value
  }

  /** `setSliderX` of the TSX: a value, or an update of the previous one. */
  setSliderX(value: LoginPage['sliderX'] | ((prev: LoginPage['sliderX']) => LoginPage['sliderX'])) {
    this.sliderX = typeof value === 'function' ? (value as (prev: LoginPage['sliderX']) => LoginPage['sliderX'])(this.sliderX) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type LoginPageStores = ReturnType<LoginPage['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type LoginPageHooks = ReturnType<LoginPage['useHooks']>

export default LoginPage.component()
