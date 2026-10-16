/**
 * Code-behind of `OAuthProvidersPanel.kbcontrol` (converted from `OAuthProvidersPanel.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { useConfirm } from "../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useAdminAction } from "../adminAction"

import { ViewBase } from './OAuthProvidersPanel.kbcontrol'
import * as __parts from './OAuthProvidersPanel.parts.tsx'

interface AdminProvider {
  id:           string
  slug:         string
  display_name: string
  issuer_url:   string
  client_id:    string
  has_secret:   boolean
  scopes:       string
  button_color: string | null
  enabled:      boolean
  allow_signup: boolean
  position:     number
  claim_username:     string
  claim_email:        string
  claim_display_name: string
  claim_groups:       string
  sync_groups:        boolean
}

interface DiscoveryProbe {
  ok:                     boolean
  message:                string
  detail?:                string
  hint?:                  string
  issuer_url:             string
  authorization_endpoint?: string
  token_endpoint?:        string
  userinfo_endpoint?:     string
  elapsed_ms:             number
}

interface FormState {
  slug:          string
  display_name:  string
  issuer_url:    string
  client_id:     string
  client_secret: string
  scopes:        string
  button_color:  string
  enabled:       boolean
  allow_signup:  boolean
  claim_username:     string
  claim_email:        string
  claim_display_name: string
  claim_groups:       string
  sync_groups:        boolean
}

const emptyForm: FormState = {
  slug: '', display_name: '', issuer_url: '', client_id: '', client_secret: '',
  scopes: 'openid email profile', button_color: '', enabled: true, allow_signup: true,
  // The OpenID Connect standard names. Configurable because roughly nobody
  // ships them unchanged: Okta puts the handle in `login`, an Azure tenant in
  // `upn`, and a Keycloak client role list lives at
  // `resource_access.<client>.roles` - hence dotted paths are accepted.
  claim_username: 'preferred_username', claim_email: 'email',
  claim_display_name: 'name', claim_groups: 'groups', sync_groups: false,
}

export class OAuthProvidersPanel extends ViewBase {
  @bind accessor editing: string | null = null
  @bind accessor probe: Record<string, DiscoveryProbe> = {}
  qc!: OAuthProvidersPanelStores['qc']
  confirm!: OAuthProvidersPanelStores['confirm']
  confirmState!: OAuthProvidersPanelStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  providers!: OAuthProvidersPanelStores['providers']
  isLoading!: boolean
  createM!: OAuthProvidersPanelHooks['createM']
  updateM!: OAuthProvidersPanelHooks['updateM']
  deleteM!: OAuthProvidersPanelHooks['deleteM']
  testM!: OAuthProvidersPanelHooks['testM']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const qc = useQueryClient()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const { data: providers, isLoading } = useQuery({
      queryKey: ['admin', 'oauth-providers'],
      queryFn: () => api.get<{ providers: AdminProvider[] }>('/admin/oauth-providers').then((r) => r.data.providers),
    })
    return { qc, confirm, confirmState, handleConfirm, handleCancel, providers, isLoading }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    useAdminAction('add', () => this.editing = 'new')
    const createM = useMutation({
      mutationFn: (data: FormState) => api.post('/admin/oauth-providers', data),
      onSuccess: () => { this.invalidate_(); this.editing = null },
    })
    this.publish({ createM })
    const updateM = useMutation({
      mutationFn: ({ id, data }: { id: string; data: Partial<FormState> }) =>
        api.patch(`/admin/oauth-providers/${id}`, data),
      onSuccess: () => { this.invalidate_(); this.editing = null },
    })
    this.publish({ updateM })
    const deleteM = useMutation({
      mutationFn: (id: string) => api.delete(`/admin/oauth-providers/${id}`),
      onSuccess: this.memo("invalidate_:bound", [], () => this.invalidate_.bind(this)),
    })
    this.publish({ deleteM })
    const testM = useMutation({
      mutationFn: (id: string) =>
        api.post<DiscoveryProbe>(`/admin/oauth-providers/${id}/test`).then((r) => r.data),
      onSuccess: (data, id) => this.probe = ({ ...this.probe, [id]: data }),
    })
    this.publish({ testM })
    return { createM, updateM, deleteM, testM }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ qc: s.qc, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, providers: s.providers, isLoading: s.isLoading })
    const h = this.useHooks()
    this.publish({ createM: h.createM, updateM: h.updateM, deleteM: h.deleteM, testM: h.testM })
  }

  get show_editing() {
    return this.editing === null
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.editing], () => {
      if (!(this.editing === null)) return undefined as never
      return ({ setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(this.editing === null)) return undefined as never
    return __parts.Part1
  }

  get show_editing_new() {
    return this.editing === 'new'
  }

  /** `<ProviderForm>`, rendered by a ReactHost. */
  get ProviderForm() {
    if (!(this.editing === 'new')) return undefined as never
    return __parts.ProviderForm
  }

  get provider_form_props() {
    return this.memo('provider_form_props', [this.memo, this.editing, this.createM, this.updateM], () => {
      if (!(this.editing === 'new')) return undefined as never
      return ({ initial: emptyForm, isEdit: false, onSave: this.memo("submit:bound", [], () => this.submit.bind(this)), onCancel: () => this.editing = null } as React.ComponentProps<typeof __parts.ProviderForm>)
    })
  }

  get show_not_is_loading() {
    return !(this.isLoading)
  }

  get show_providers_editing_new() {
    if (!(!(this.isLoading))) return undefined as never
    return (this.providers?.length ?? 0) === 0 && this.editing !== 'new'
  }

  get show_not_providers_editing_new() {
    if (!(!(this.isLoading))) return undefined as never
    return !((this.providers?.length ?? 0) === 0 && this.editing !== 'new')
  }

  get part2_props() {
    return this.memo('part2_props', [this.providers, this.editing, this.memo, this.createM, this.updateM, this.testM, this.confirm, this.deleteM, this.isLoading], () => {
      if (!(!(this.isLoading)) || !(!((this.providers?.length ?? 0) === 0 && this.editing !== 'new'))) return undefined as never
      return ({ providers: this.providers, editing: this.editing, toFormState: this.memo("toFormState:bound", [], () => this.toFormState.bind(this)), submit: this.memo("submit:bound", [], () => this.submit.bind(this)), setEditing: this.memo("setEditing:bound", [], () => this.setEditing.bind(this)), testM: this.testM, updateM: this.updateM, onDelete: this.memo("onDelete:bound", [], () => this.onDelete.bind(this)) })
    })
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part2() {
    if (!(!(this.isLoading)) || !(!((this.providers?.length ?? 0) === 0 && this.editing !== 'new'))) return undefined as never
    return __parts.Part2
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part3() {
    if (!(!(this.isLoading)) || !(!((this.providers?.length ?? 0) === 0 && this.editing !== 'new'))) return undefined as never
    return __parts.Part3
  }

  /** The rows of the Repeater over `providers?.filter((p) => probe[p.id])`. */
  get rows_items() {
    return this.memo('rows_items', [this.providers, this.probe, this.isLoading, this.editing], () => {
      if (!(!(this.isLoading)) || !(!((this.providers?.length ?? 0) === 0 && this.editing !== 'new'))) return undefined as never
      return this.providers?.filter((p) => this.probe[p.id]).map((p) => {
      const r = this.probe[p.id]
      return { p, r, part3_props: ((!(this.isLoading)) && (!((this.providers?.length ?? 0) === 0 && this.editing !== 'new'))) ? ({ p: p, r: r, r_authorization_endpoint: r?.authorization_endpoint, r_detail: r?.detail, r_hint: r?.hint }) : undefined, key: `probe-${p.id}` }
    })
    })
  }

  get visible() {
    return this.memo('visible', [this.show_providers_editing_new, this.show_not_is_loading], () => this.show_providers_editing_new && this.show_not_is_loading)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_providers_editing_new, this.show_not_is_loading], () => this.show_not_providers_editing_new && this.show_not_is_loading)
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState], () => !!(this.confirmState))
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel], () => {
      if (!(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  invalidate_() {
    this.qc.invalidateQueries({ queryKey: ['admin', 'oauth-providers'] })
    this.qc.invalidateQueries({ queryKey: ['oauth-providers'] })  // public list on the login page
  }

  toFormState(p: AdminProvider): FormState {
    return ({
    slug: p.slug, display_name: p.display_name, issuer_url: p.issuer_url, client_id: p.client_id,
    client_secret: '', scopes: p.scopes, button_color: p.button_color ?? '',
    enabled: p.enabled, allow_signup: p.allow_signup,
    claim_username: p.claim_username, claim_email: p.claim_email,
    claim_display_name: p.claim_display_name, claim_groups: p.claim_groups,
    sync_groups: p.sync_groups,
  })
  }

  submit(data: FormState) {
    if (this.editing === 'new') {
      this.createM.mutate(data)
    } else if (this.editing) {
      // Omit the secret when left blank so the stored one is kept.
      const payload: Partial<FormState> = { ...data }
      if (!data.client_secret) delete payload.client_secret
      this.updateM.mutate({ id: this.editing, data: payload })
    }
  }

  async onDelete(p: AdminProvider) {
    const ok = await this.confirm({
      title: 'Supprimer le fournisseur',
      message: `Supprimer « ${p.display_name} » ? Les utilisateurs liés conservent leur compte mais ne pourront plus se connecter via ce fournisseur.`,
      confirmLabel: 'Supprimer',
      variant: 'danger',
    })
    if (ok) this.deleteM.mutate(p.id)
  }

  /** `setEditing` of the TSX: a value, or an update of the previous one. */
  setEditing(value: string | null | ((prev: string | null) => string | null)) {
    this.editing = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.editing) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type OAuthProvidersPanelStores = ReturnType<OAuthProvidersPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type OAuthProvidersPanelHooks = ReturnType<OAuthProvidersPanel['useHooks']>

export default OAuthProvidersPanel.component()
