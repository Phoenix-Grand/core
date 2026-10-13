/**
 * Code-behind of `ApiTokensTab.kbcontrol` (converted from `ApiTokensTab.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { formatDate, formatRelative } from "../../../intl/datetime"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../api/client"
import type { ApiToken } from "../../../types"

import { ViewBase } from './ApiTokensTab.kbcontrol'
import * as __parts from './ApiTokensTab.parts.tsx'

export class ApiTokensTab extends ViewBase {
  @bind accessor newToken: string | null = null
  tr!: ApiTokensTabStores['t']
  tokens!: ApiTokensTabStores['tokens']
  isLoading!: boolean
  revoke!: ApiTokensTabStores['revoke']
  legacy!: ApiToken[]
  soonest!: string

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const { data: tokens, isLoading } = useQuery({
      queryKey: ['api-tokens'],
      queryFn: () =>
        api.get<{ tokens: ApiToken[] }>('/me/api-tokens').then((r) => r.data.tokens),
    })
    const revoke = useMutation({
      mutationFn: (id: string) => api.delete(`/me/api-tokens/${id}`),
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-tokens'] }),
    })
    const legacy = useMemo(() => (tokens ?? []).filter((tok) => tok.is_legacy), [tokens])
    const soonest = useMemo(() => {
      const dates = legacy
        .map((tok) => tok.legacy_grace_until)
        .filter((d): d is string => Boolean(d))
        .sort()
      return dates[0] ?? null
    }, [legacy])
    return { t, queryClient, tokens, isLoading, revoke, legacy, soonest }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, tokens: s.tokens, isLoading: s.isLoading, revoke: s.revoke, legacy: s.legacy, soonest: s.soonest })
  }

  get show_new_token() {
    return !!(this.newToken)
  }

  /** `<NewTokenBanner Token>`: the raw token being shown. */
  get bannerToken() {
    if (!(this.newToken)) return undefined as never
    return this.newToken
  }

  /** `<NewTokenBanner OnClose>`: dismiss the banner. */
  new_token_banner_close(_sender: unknown, _e: EventArgs) {
    this.newToken = null
  }

  get show_legacy() {
    return this.legacy.length > 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.soonest, this.legacy], () => {
      if (!(this.legacy.length > 0)) return undefined as never
      return ({ t: this.tr, soonest: this.soonest })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part1() {
    if (!(this.legacy.length > 0)) return undefined as never
    return __parts.Part1
  }

  /** `<CreateTokenForm OnCreated>`: a new token was created; show it. */
  create_token_form_created(_sender: unknown, args: ValueChangedEventArgs) {
    this.setNewToken(args.value as string)
  }

  get show_tokens_tokens() {
    return !!(this.tokens && this.tokens.length === 0)
  }

  get show_tokens_tokens2() {
    return !!(this.tokens && this.tokens.length > 0)
  }

  /** A part of the screen still written in React (an icon with a computed className). */
  get Part2() {
    if (!(this.tokens && this.tokens.length > 0)) return undefined as never
    return __parts.Part2
  }

  /** The rows of the Repeater over `tokens`. */
  get rows_tokens() {
    return this.memo('rows_tokens', [this.tokens, this.tr], () => {
      if (!(this.tokens && this.tokens.length > 0)) return undefined as never
      return this.tokens.map((tok) => {
      const isExpired = tok.expires_at ? new Date(tok.expires_at) < new Date() : false
      const graceOver = tok.is_legacy && tok.legacy_grace_until
                ? new Date(tok.legacy_grace_until) < new Date()
                : false
      return { tok, isExpired, graceOver, div_class: ((this.tokens && this.tokens.length > 0)) ? (`px-4 py-3 rounded-lg border bg-white
                  ${isExpired || graceOver ? 'border-warning-light opacity-60' : 'border-border'}`) : undefined, part2_props: ((this.tokens && this.tokens.length > 0)) ? ({ isExpired: isExpired, graceOver: graceOver }) : undefined, text: ((this.tokens && this.tokens.length > 0)) ? (formatDate(new Date(tok.created_at), 'date')) : undefined, show_tok_last_used: ((this.tokens && this.tokens.length > 0)) ? (!!(tok.last_used_at)) : undefined, text2: ((this.tokens && this.tokens.length > 0) && (tok.last_used_at)) ? (formatRelative(new Date(tok.last_used_at))) : undefined, show_tok_last_used2: ((this.tokens && this.tokens.length > 0)) ? (!tok.last_used_at) : undefined, show_tok_expires_at: ((this.tokens && this.tokens.length > 0)) ? (!!(tok.expires_at)) : undefined, show_not_tok_expires_at: ((this.tokens && this.tokens.length > 0)) ? (!(tok.expires_at)) : undefined, span_class: ((this.tokens && this.tokens.length > 0) && (tok.expires_at)) ? (`text-xs px-2 py-0.5 rounded-full ${
                        isExpired
                          ? 'bg-warning-light text-warning'
                          : 'bg-surface-2 text-text-secondary'
                      }`) : undefined, span_text: ((this.tokens && this.tokens.length > 0) && (tok.expires_at)) ? (isExpired
                          ? this.tr('settings.tok_expired')
                          : `${this.tr('settings.tok_expires_prefix')} ${formatRelative(new Date(tok.expires_at))}`) : undefined, show_tok_is_legacy: ((this.tokens && this.tokens.length > 0)) ? (!!(tok.is_legacy && tok.legacy_grace_until)) : undefined, p_text: ((this.tokens && this.tokens.length > 0) && (tok.is_legacy && tok.legacy_grace_until)) ? (graceOver
                        ? this.tr('settings.tok_legacy_over')
                        : this.tr('settings.tok_legacy_until', {
                            date: formatDate(new Date(tok.legacy_grace_until), 'dateLong'),
                          })) : undefined, key: tok.id }
    })
    })
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { tok } = args.row as RowOf_rows_tokens
    if (!(this.tokens && this.tokens.length > 0)) return undefined as never
    this.revoke.mutate(tok.id)
  }

  /** `setNewToken` of the TSX: a value, or an update of the previous one. */
  setNewToken(value: string | null | ((prev: string | null) => string | null)) {
    this.newToken = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.newToken) : value
  }

}

type RowOf_rows_tokens = ApiTokensTab['rows_tokens'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ApiTokensTabStores = ReturnType<ApiTokensTab['useStores']>

export default ApiTokensTab.component()
