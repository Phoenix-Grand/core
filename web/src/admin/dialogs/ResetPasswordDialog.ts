/**
 * Code-behind of `ResetPasswordDialog.kbview` (converted from `ResetPasswordDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useMutation } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { apiErrorDetail } from "../../core/api/errorMessage"

import { ViewBase } from './ResetPasswordDialog.kbview'
import * as __parts from './ResetPasswordDialog.parts.tsx'

export interface ResetPasswordDialogProps {
  userId:     string
  /** Display name or username - shown in the dialog subtitle. */
  userLabel:  string
  /** Account address, used as the placeholder of the "send to" field. */
  userEmail?: string
  onClose:    () => void
  /** Called after a successful reset, for the caller to refresh its data. */
  onDone?:    () => void
}

interface ResetResponse {
  ok:               boolean
  password:         string | null
  generated:        boolean
  must_change:      boolean
  sessions_revoked: number
  email: {
    requested: boolean
    queued?:   boolean
    to?:       string
    reason?:   string
  }
}

const MIN_LENGTH = 8

export class ResetPasswordDialog extends ViewBase {
  @bind accessor mode: 'generate' | 'manual' = 'generate'
  @bind accessor password = ''
  @bind accessor requireChange = true
  @bind accessor sendEmail = false
  @bind accessor emailTo = ''
  @bind accessor error: string | null = null
  @bind accessor outcome: ResetResponse | null = null
  @bind accessor revealed = false
  @bind accessor copied = false
  tr!: ResetPasswordDialogStores['t']
  reset!: ResetPasswordDialogHooks['reset']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const onDone = this.props.onDone
    const reset = useMutation({
      mutationFn: () =>
        api
          .post<ResetResponse>(`/admin/users/${this.props.userId}/reset-password`, {
            mode: this.mode,
            password:       this.mode === 'manual' ? this.password : undefined,
            require_change: this.requireChange,
            send_email:     this.sendEmail,
            email_to:       this.sendEmail && this.emailTo.trim() ? this.emailTo.trim() : undefined,
          })
          .then(r => r.data),
      onSuccess: data => {
        this.outcome = data
        this.error = null
        onDone?.()
      },
      onError: (e: unknown) => {
        const detail = apiErrorDetail(e)
        this.error = detail || t('pwreset.err_generic')
      },
    })
    this.publish({ reset })
    return { reset }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ reset: h.reset })
  }

  get sessions(): number {
    if (!(!!(this.outcome))) return undefined as never
    return this.outcome.sessions_revoked
  }

  get show_case_1() {
    return !!(this.outcome)
  }

  get show_outcome_password() {
    if (!(this.outcome)) return undefined as never
    return !!(this.outcome.password)
  }

  get show_not_outcome_password() {
    if (!(this.outcome)) return undefined as never
    return !(this.outcome.password)
  }

  get code_text() {
    if (!(this.outcome) || !(this.outcome.password)) return undefined as never
    return this.revealed ? this.outcome.password : '•'.repeat(this.outcome.password.length)
  }

  get show_not_revealed() {
    if (!(this.outcome) || !(this.outcome.password)) return undefined as never
    return !(this.revealed)
  }

  get accessible_name() {
    if (!(this.outcome) || !(this.outcome.password)) return undefined as never
    return this.revealed ? this.tr('pwreset.hide') : this.tr('pwreset.show')
  }

  get show_not_copied() {
    if (!(this.outcome) || !(this.outcome.password)) return undefined as never
    return !(this.copied)
  }

  get li_text() {
    if (!(this.outcome)) return undefined as never
    return this.sessions === 1 ? this.tr('pwreset.done_sessions_one') : this.tr('pwreset.done_sessions', { count: this.sessions })
  }

  get show_outcome_must_change() {
    if (!(this.outcome)) return undefined as never
    return this.outcome.must_change
  }

  get show_outcome_email_requested() {
    if (!(this.outcome)) return undefined as never
    return this.outcome.email.requested
  }

  get show_outcome_email_queued() {
    if (!(this.outcome) || !(this.outcome.email.requested)) return undefined as never
    return !!(this.outcome.email.queued)
  }

  get show_not_outcome_email_queued() {
    if (!(this.outcome) || !(this.outcome.email.requested)) return undefined as never
    return !(this.outcome.email.queued)
  }

  get email_queued_to() {
    if (!(this.outcome) || !(this.outcome.email.requested) || !(this.outcome.email.queued)) return undefined as never
    return this.outcome.email.to
  }

  get visible() {
    return this.memo('visible', [this.show_outcome_email_queued, this.show_outcome_email_requested, this.outcome], () => {
      if (!(this.outcome)) return undefined as never
      return this.show_outcome_email_queued && this.show_outcome_email_requested
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_outcome_email_queued, this.show_outcome_email_requested, this.outcome], () => {
      if (!(this.outcome)) return undefined as never
      return this.show_not_outcome_email_queued && this.show_outcome_email_requested
    })
  }

  get show_main() {
    return !(this.outcome)
  }

  get selected_value() {
    if (!(!(this.outcome))) return undefined as never
    return this.mode === 'generate'
  }

  get selected_value2() {
    if (!(!(this.outcome))) return undefined as never
    return this.mode === 'manual'
  }

  get part1_props() {
    return this.memo('part1_props', [this.password, this.memo, this.error, this.tr, this.outcome, this.mode], () => {
      if (!(!(this.outcome)) || !(this.mode === 'manual')) return undefined as never
      return ({ password: this.password, setPassword: this.memo("setPassword:bound", [], () => this.setPassword.bind(this)), setError: this.memo("setError:bound", [], () => this.setError.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    if (!(!(this.outcome)) || !(this.mode === 'manual')) return undefined as never
    return __parts.Part1
  }

  get placeholder() {
    if (!(!(this.outcome)) || !(this.sendEmail)) return undefined as never
    return this.props.userEmail ?? ''
  }

  get show_error() {
    if (!(!(this.outcome))) return undefined as never
    return !!(this.error)
  }

  submit() {
    if (this.mode === 'manual' && this.password.length < MIN_LENGTH) {
      this.error = this.tr('pwreset.err_min')
      return
    }
    this.error = null
    this.reset.mutate()
  }

  copy() {
    if (!this.outcome?.password) return
    navigator.clipboard?.writeText(this.outcome.password).then(() => {
      this.copied = true
      setTimeout(() => this.copied = false, 1600)
    })
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    if (!(this.outcome)) return undefined as never
    this.props.onClose?.()
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.outcome) || !(this.outcome.password)) return undefined as never
    this.revealed = !this.revealed
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.outcome)) return undefined as never
    this.props.onClose?.()
  }

  floating_window_close2(_sender: unknown, _args: EventArgs) {
    if (!(!(this.outcome))) return undefined as never
    this.props.onClose?.()
  }

  radio_button_checked_changed(_sender: unknown, _args: ValueChangedEventArgs) {
    if (!(!(this.outcome))) return undefined as never
    this.mode = 'generate'
  }

  radio_button_checked_changed2(_sender: unknown, _args: ValueChangedEventArgs) {
    if (!(!(this.outcome))) return undefined as never
    this.mode = 'manual'
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(!(this.outcome))) return undefined as never
    this.props.onClose?.()
  }

  /** `setPassword` of the TSX: a value, or an update of the previous one. */
  setPassword(value: ResetPasswordDialog['password'] | ((prev: ResetPasswordDialog['password']) => ResetPasswordDialog['password'])) {
    this.password = typeof value === 'function' ? (value as (prev: ResetPasswordDialog['password']) => ResetPasswordDialog['password'])(this.password) : value
  }

  /** `setError` of the TSX: a value, or an update of the previous one. */
  setError(value: string | null | ((prev: string | null) => string | null)) {
    this.error = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.error) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ResetPasswordDialogStores = ReturnType<ResetPasswordDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ResetPasswordDialogHooks = ReturnType<ResetPasswordDialog['useHooks']>

export default ResetPasswordDialog.component()
