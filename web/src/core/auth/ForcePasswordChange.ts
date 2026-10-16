/**
 * Code-behind of `ForcePasswordChange.kbview` (converted from `ForcePasswordChange.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { api } from "../api/client"
import { useAuthStore } from "../store/authStore"
import { passwordStrength } from "./passwordStrength"
import { InstanceLogo } from "../shell/controls/InstanceLogo"

import { ViewBase } from './ForcePasswordChange.kbview'
import * as __parts from './ForcePasswordChange.parts'

export class ForcePasswordChange extends ViewBase {
  @bind accessor form = { current: '', next: '', confirm: '' }
  @bind accessor showPassword = false
  @bind accessor error = ''
  @bind accessor isLoading = false
  tr!: ForcePasswordChangeStores['t']
  email!: string
  login!: (email: string, password: string, captcha?: { id: string; answer: string; }) => Promise<{ requiresTotp: boolean; }>
  updateUser!: ForcePasswordChangeStores['updateUser']
  logout!: () => Promise<void>

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const email = useAuthStore((s) => s.user?.email ?? '')
    const login = useAuthStore((s) => s.login)
    const updateUser = useAuthStore((s) => s.updateUser)
    const logout = useAuthStore((s) => s.logout)
    return { t, email, login, updateUser, logout }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, email: s.email, login: s.login, updateUser: s.updateUser, logout: s.logout })
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

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.form, this.memo], () => ({ t: this.tr, form: this.form, setForm: this.memo("setForm:bound", [], () => this.setForm.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.showPassword, this.form, this.memo], () => ({ t: this.tr, showPassword: this.showPassword, form: this.form, setForm: this.memo("setForm:bound", [], () => this.setForm.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextField> minLength: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get show_not_show_password() {
    return !(this.showPassword)
  }

  get show_form_next() {
    return !!(this.form.next)
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part3() {
    if (!(this.form.next)) return undefined as never
    return __parts.Part3
  }

  /** The rows of the Repeater over `Array.from({ length: 5 })`. */
  get rows_items() {
    return this.memo('rows_items', [this.form, this.strength], () => {
      if (!(this.form.next)) return undefined as never
      return Array.from({ length: 5 }).map((_, i) => {
      return { _, i, part3_props: ((this.form.next)) ? ({ i: i, strength: this.strength }) : undefined, key: i }
    })
    })
  }

  get part4_props() {
    return this.memo('part4_props', [this.strength, this.tr, this.form], () => {
      if (!(this.form.next)) return undefined as never
      return ({ strength: this.strength, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<span> with a computed style). */
  get Part4() {
    if (!(this.form.next)) return undefined as never
    return __parts.Part4
  }

  get show_error() {
    return !!(this.error)
  }

  async handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.error = ''

    if (this.form.next.length < 8) {
      this.error = this.tr('register.err_min')
      return
    }
    if (this.form.next !== this.form.confirm) {
      this.error = this.tr('register.err_mismatch')
      return
    }
    if (this.form.next === this.form.current) {
      this.error = this.tr('forcepw.err_same')
      return
    }

    this.isLoading = true
    try {
      await api.patch('/me/password', {
        old_password: this.form.current,
        new_password: this.form.next,
      })
      // Changing the password revokes every refresh token, including the one
      // backing this tab: a reload would bounce to /login. Sign in again with
      // the brand-new password so the user lands on a fully valid session. The
      // fresh `user` payload also carries the cleared flag, which lifts this
      // screen. If anything gets in the way (2FA, network), fall back to a
      // clean sign-out - the password change itself already went through.
      try {
        const { requiresTotp } = await this.login(this.email, this.form.next)
        if (requiresTotp) await this.logout()
      } catch {
        await this.logout()
      }
      this.updateUser({ must_change_password: false })
    } catch (err: unknown) {
      this.error = (err as { message?: string })?.message ?? this.tr('forcepw.err_generic')
    } finally {
      this.isLoading = false
    }
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.handleSubmit(args.native as never)
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.showPassword = !this.showPassword
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.form = ({ ...this.form, confirm: e.target.value })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    void this.logout()
  }

  /** `setForm` of the TSX: a value, or an update of the previous one. */
  setForm(value: ForcePasswordChange['form'] | ((prev: ForcePasswordChange['form']) => ForcePasswordChange['form'])) {
    this.form = typeof value === 'function' ? (value as (prev: ForcePasswordChange['form']) => ForcePasswordChange['form'])(this.form) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ForcePasswordChangeStores = ReturnType<ForcePasswordChange['useStores']>

export default ForcePasswordChange.component()
