/**
 * Code-behind of `ResetPasswordPage.kbview` (converted from `ResetPasswordPage.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs, type EventArgs } from '@kubuno/views'
import { useNavigate } from 'react-router-dom'
import { useSearchParams } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { api } from "../api/client"
import { passwordStrength } from "./passwordStrength"
import { InstanceLogo } from "../shell/controls/InstanceLogo"
import { apiErrorDetail } from "../api/errorMessage"

import { ViewBase } from './ResetPasswordPage.kbview'
import * as __parts from './ResetPasswordPage.parts'

export class ResetPasswordPage extends ViewBase {
  @bind accessor form = { next: '', confirm: '' }
  @bind accessor showPassword = false
  @bind accessor error = ''
  @bind accessor isLoading = false
  @bind accessor done = false
  tr!: ResetPasswordPageStores['t']
  params!: URLSearchParams
  navigate!: ReturnType<typeof useNavigate>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const [params] = useSearchParams()
    return { t, params }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, params: s.params })
    this.navigate = useNavigate()
  }

  get token(): string {
    return this.params.get('token') ?? ''
  }

  get strength() {
    return this.memo('strength', [this.form], () => passwordStrength(this.form.next))
  }

  /** `<InstanceLogo>`, rendered by a ReactHost. */
  get InstanceLogo() {
    return InstanceLogo
  }

  get instance_logo_props() {
    return this.memo('instance_logo_props', [], () => ({ size: 26, className: "text-primary" }))
  }

  get show_not_done() {
    return !(this.done)
  }

  get show_token() {
    if (!(!(this.done))) return undefined as never
    return !this.token
  }

  get show_not_token() {
    if (!(!(this.done))) return undefined as never
    return !(!this.token)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.showPassword, this.form, this.memo, this.done, this.token], () => {
      if (!(!(this.done)) || !(!(!this.token))) return undefined as never
      return ({ t: this.tr, showPassword: this.showPassword, form: this.form, setForm: this.memo("setForm:bound", [], () => this.setForm.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<TextField> minLength, autoFocus: no .kbview property). */
  get Part1() {
    if (!(!(this.done)) || !(!(!this.token))) return undefined as never
    return __parts.Part1
  }

  get show_not_show_password() {
    if (!(!(this.done)) || !(!(!this.token))) return undefined as never
    return !(this.showPassword)
  }

  get show_form_next() {
    if (!(!(this.done)) || !(!(!this.token))) return undefined as never
    return !!(this.form.next)
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part2() {
    if (!(!(this.done)) || !(!(!this.token)) || !(this.form.next)) return undefined as never
    return __parts.Part2
  }

  /** The rows of the Repeater over `Array.from({ length: 5 })`. */
  get rows_items() {
    return this.memo('rows_items', [this.done, this.token, this.form, this.strength], () => {
      if (!(!(this.done)) || !(!(!this.token)) || !(this.form.next)) return undefined as never
      return Array.from({ length: 5 }).map((_, i) => {
      return { _, i, part2_props: ((!(this.done)) && (!(!this.token)) && (this.form.next)) ? ({ i: i, strength: this.strength }) : undefined, key: i }
    })
    })
  }

  get part3_props() {
    return this.memo('part3_props', [this.strength, this.tr, this.done, this.token, this.form], () => {
      if (!(!(this.done)) || !(!(!this.token)) || !(this.form.next)) return undefined as never
      return ({ strength: this.strength, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<span> with a computed style). */
  get Part3() {
    if (!(!(this.done)) || !(!(!this.token)) || !(this.form.next)) return undefined as never
    return __parts.Part3
  }

  get show_error() {
    if (!(!(this.done)) || !(!(!this.token))) return undefined as never
    return !!(this.error)
  }

  get visible() {
    return this.memo('visible', [this.show_token, this.show_not_done], () => this.show_token && this.show_not_done)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_token, this.show_not_done], () => this.show_not_token && this.show_not_done)
  }

  async handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.error = ''

    if (this.form.next.length < 8) {
      this.error = this.tr('resetpw.err_min')
      return
    }
    if (this.form.next !== this.form.confirm) {
      this.error = this.tr('resetpw.err_mismatch')
      return
    }

    this.isLoading = true
    try {
      await api.post('/auth/reset-password', { token: this.token, new_password: this.form.next })
      this.done = true
    } catch (err: unknown) {
      // The server answers the same way for an unknown, used and expired token -
      // deliberately, so this page says the same thing for all three.
      const message = apiErrorDetail(err)
      this.error = message || this.tr('resetpw.err_invalid')
    } finally {
      this.isLoading = false
    }
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.navigate("/login")
  }

  panel_click2(_sender: unknown, _args: MouseEventArgs) {
    this.navigate("/forgot-password")
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.handleSubmit(args.native as never)
  }

  panel_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.done)) || !(!(!this.token))) return undefined as never
    this.showPassword = !this.showPassword
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    if (!(!(this.done)) || !(!(!this.token))) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.form = ({ ...this.form, confirm: e.target.value })
  }

  link_label_click(_sender: unknown, _args: MouseEventArgs) {
    this.navigate("/login")
  }

  /** `setForm` of the TSX: a value, or an update of the previous one. */
  setForm(value: ResetPasswordPage['form'] | ((prev: ResetPasswordPage['form']) => ResetPasswordPage['form'])) {
    this.form = typeof value === 'function' ? (value as (prev: ResetPasswordPage['form']) => ResetPasswordPage['form'])(this.form) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ResetPasswordPageStores = ReturnType<ResetPasswordPage['useStores']>

export default ResetPasswordPage.component()
