/**
 * Code-behind of `CreateTokenForm.kbcontrol` (converted from `CreateTokenForm.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../api/client"
import type { TokenScope } from "../../../types"

import { ViewBase } from './CreateTokenForm.kbcontrol'
import * as __parts from './CreateTokenForm.parts.tsx'

export type CreateTokenFormProps = { onCreated: (raw: string) => void }

export class CreateTokenForm extends ViewBase {
  @bind accessor name = ''
  @bind accessor expiresInDays: string = ''
  @bind accessor scopes: string[] = []
  @bind accessor error = ''
  tr!: CreateTokenFormStores['t']
  queryClient!: CreateTokenFormStores['queryClient']
  data!: CreateTokenFormStores['data']
  available!: TokenScope[]
  expiryMandatory!: boolean
  create!: CreateTokenFormHooks['create']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { data } = useQuery({
      queryKey: ['api-token-scopes'],
      queryFn: () =>
        api
          .get<{ scopes: TokenScope[]; max_ttl_days: number }>('/me/api-tokens/scopes')
          .then((r) => r.data),
    })
    const available = useMemo(() => data?.scopes ?? [], [data])
    return { t, queryClient, data, available }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const queryClient = this.queryClient
    const available = this.available
    const expiryMandatory = useMemo(
      () => available.some((s) => this.scopes.includes(s.key) && s.requires_expiry),
      [available, this.scopes]
    )
    this.publish({ expiryMandatory })
    const create = useMutation({
      mutationFn: () =>
        api.post<{ token: string; id: string; name: string; scopes: string[]; expires_at: string | null; created_at: string }>(
          '/me/api-tokens',
          {
            name: this.name.trim(),
            scopes: this.scopes,
            expires_in_days: this.expiresInDays ? parseInt(this.expiresInDays, 10) : null,
          }
        ).then((r) => r.data),
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ['api-tokens'] })
        this.props.onCreated(data.token)
        this.name = ''
        this.expiresInDays = ''
        this.scopes = []
        this.error = ''
      },
      onError: (err: unknown) => {
        this.error = (err as { message?: string })?.message ?? t('settings.tok_create_error')
      },
    })
    this.publish({ create })
    return { expiryMandatory, create }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, queryClient: s.queryClient, data: s.data, available: s.available })
    const h = this.useHooks()
    this.publish({ expiryMandatory: h.expiryMandatory, create: h.create })
  }

  get maxTtlDays(): number {
    return this.data?.max_ttl_days ?? 365
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.expiresInDays, this.memo, this.expiryMandatory, this.maxTtlDays], () => ({ t: this.tr, expiresInDays: this.expiresInDays, setExpiresInDays: this.memo("setExpiresInDays:bound", [], () => this.setExpiresInDays.bind(this)), expiryMandatory: this.expiryMandatory, maxTtlDays: this.maxTtlDays }))
  }

  /** A part of the screen still written in React (<TextField> min, max: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_scopes() {
    return this.scopes.length > 0
  }

  get show_error() {
    return !!(this.error)
  }

  handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!this.name.trim()) { this.error = this.tr('settings.tok_name_required'); return }
    if (this.scopes.length === 0) { this.error = this.tr('settings.tok_scopes_required'); return }
    if (this.expiryMandatory && !this.expiresInDays) {
      this.error = this.tr('settings.tok_expiry_required_desc'); return
    }
    this.create.mutate()
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.handleSubmit(args.native as never)
  }

  /** `<ApiTokenScopePicker OnChange>`: the selected scopes changed. */
  scopePickerChanged(_sender: unknown, args: ValueChangedEventArgs) {
    this.setScopes(args.value as string[])
  }

  /** `setExpiresInDays` of the TSX: a value, or an update of the previous one. */
  setExpiresInDays(value: string | ((prev: string) => string)) {
    this.expiresInDays = typeof value === 'function' ? (value as (prev: string) => string)(this.expiresInDays) : value
  }

  /** `setScopes` of the TSX: a value, or an update of the previous one. */
  setScopes(value: string[] | ((prev: string[]) => string[])) {
    this.scopes = typeof value === 'function' ? (value as (prev: string[]) => string[])(this.scopes) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CreateTokenFormStores = ReturnType<CreateTokenForm['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type CreateTokenFormHooks = ReturnType<CreateTokenForm['useHooks']>

export default CreateTokenForm.component()
