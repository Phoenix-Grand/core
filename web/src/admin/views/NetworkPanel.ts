/**
 * Code-behind of `NetworkPanel.kbview` (converted from `NetworkPanel.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { api } from "../../core/api/client"
import { useConfirm } from "../../core/hooks/useConfirm"
import SettingsGroupPanel from "../settings/views/SettingsGroupPanel"

import { ViewBase } from './NetworkPanel.kbview'
import * as __parts from './NetworkPanel.parts.tsx'

interface StoredCert {
  id:         string
  source:     string
  subject:    string | null
  issuer:     string | null
  san:        string[]
  not_before: string | null
  not_after:  string | null
  is_active:  boolean
  created_at: string
}

interface NetworkData {
  config: {
    https_enabled:          boolean
    https_port:             number
    http_redirect_to_https: boolean
    http_redirect_port:     number
    tls_min_version:        string
    cert_mode:              string
    hsts: {
      enabled:            boolean
      max_age_days:       number
      include_subdomains: boolean
      preload:            boolean
    }
  }
  certificate: StoredCert | null
  certificates: StoredCert[]
  runtime: {
    https_live:       boolean
    file_override:    boolean
    restart_required: boolean
  }
  acme: {
    directory_url:      string
    email:             string
    domains:           string[]
    tos_agreed:        boolean
    last_order_status: string | null
    last_order_detail: string | null
    last_attempt_at:   string | null
  }
}

const errorOf = (e: unknown): string | undefined => {
  const any = e as { message?: string; response?: { data?: { message?: string; error?: string } } }
  return any?.message || any?.response?.data?.message || any?.response?.data?.error
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  return Math.floor(ms / 86_400_000)
}

export class NetworkPanel extends ViewBase {
  @bind accessor certPem = ''
  @bind accessor keyPem = ''
  tr!: NetworkPanelStores['t']
  i18n!: NetworkPanelStores['i18n']
  qc!: NetworkPanelStores['qc']
  toast!: NetworkPanelStores['toast']
  confirm!: NetworkPanelStores['confirm']
  confirmState!: NetworkPanelStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: NetworkPanelStores['data']
  isLoading!: boolean
  upload!: NetworkPanelHooks['upload']
  requestAcme!: NetworkPanelStores['requestAcme']
  removeCert!: NetworkPanelStores['removeCert']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const qc = useQueryClient()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const { data, isLoading } = useQuery({
      queryKey: ['admin', 'network'],
      queryFn: () => api.get<NetworkData>('/admin/network').then(r => r.data),
    })
    const requestAcme = useMutation({
      mutationFn: () =>
        api.post<{ message: string }>('/admin/network/acme/request', {}).then(r => r.data),
      onSuccess: res => {
        toast.success(res.message || t('admin.net_acme_ok', 'Certificat obtenu.'))
        qc.invalidateQueries({ queryKey: ['admin', 'network'] })
      },
      onError: e =>
        toast.error(errorOf(e) || t('admin.net_acme_error', "Échec de l'obtention du certificat")),
    })
    const removeCert = useMutation({
      mutationFn: (id: string) =>
        api.delete<{ message: string }>(`/admin/network/certificate/${id}`).then(r => r.data),
      onSuccess: res => {
        toast.success(res.message || t('admin.net_cert_deleted', 'Certificat supprimé.'))
        qc.invalidateQueries({ queryKey: ['admin', 'network'] })
      },
      onError: e =>
        toast.error(errorOf(e) || t('admin.net_cert_delete_error', 'Suppression impossible')),
    })
    return { t, i18n, qc, toast, confirm, confirmState, handleConfirm, handleCancel, data, isLoading, requestAcme, removeCert }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const qc = this.qc
    const toast = this.toast
    const upload = useMutation({
      mutationFn: () =>
        api
          .post<{ message: string }>('/admin/network/certificate', {
            cert_pem: this.certPem,
            key_pem: this.keyPem,
          })
          .then(r => r.data),
      onSuccess: res => {
        toast.success(res.message || t('admin.net_cert_installed', 'Certificat installé.'))
        this.certPem = ''
        this.keyPem = ''
        qc.invalidateQueries({ queryKey: ['admin', 'network'] })
      },
      onError: e =>
        toast.error(errorOf(e) || t('admin.net_cert_error', "Échec de l'installation du certificat")),
    })
    this.publish({ upload })
    return { upload }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, qc: s.qc, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, data: s.data, isLoading: s.isLoading, requestAcme: s.requestAcme, removeCert: s.removeCert })
    const h = this.useHooks()
    this.publish({ upload: h.upload })
  }

  get cert(): StoredCert | null {
    return this.memo('cert', [this.data], () => this.data?.certificate ?? null)
  }

  get history(): StoredCert[] {
    return this.memo('history', [this.data], () => (this.data?.certificates ?? []).filter(c => !c.is_active))
  }

  get acme(): { directory_url: string; email: string; domains: string[]; tos_agreed: boolean; last_order_status: string | null; last_order_detail: string | null; last_attempt_at: string | null; } | undefined {
    return this.memo('acme', [this.data], () => this.data?.acme)
  }

  get acmeMode(): boolean {
    return this.data?.config.cert_mode === 'acme'
  }

  get runtime(): { https_live: boolean; file_override: boolean; restart_required: boolean; } | undefined {
    return this.memo('runtime', [this.data], () => this.data?.runtime)
  }

  get expiresIn(): number | null {
    return this.cert?.not_after ? daysUntil(this.cert.not_after) : null
  }

  get text() {
    return this.tr('admin.nav_network', 'Réseau (HTTP / HTTPS)')
  }

  get p_text() {
    return this.tr(
            'admin.net_intro',
            "Terminaison HTTP/HTTPS du core. Le TLS est assuré par rustls ; installez ici le certificat et réglez le comportement ci-dessous.",
          )
  }

  get show_runtime_file_override() {
    return !!(this.runtime?.file_override)
  }

  get title() {
    if (!(this.runtime?.file_override)) return undefined as never
    return this.tr('admin.net_file_override_title', 'HTTPS géré par fichier')
  }

  get callout_text() {
    if (!(this.runtime?.file_override)) return undefined as never
    return this.tr(
            'admin.net_file_override_body',
            "La section [server.tls] de config.toml est active : elle a la priorité sur ce panneau. Les réglages ci-dessous restent enregistrés mais ne sont pas appliqués tant que le fichier impose sa configuration.",
          )
  }

  get show_runtime_restart_required() {
    return !!(this.runtime?.restart_required)
  }

  get title2() {
    if (!(this.runtime?.restart_required)) return undefined as never
    return this.tr('admin.net_restart_title', 'Redémarrage requis')
  }

  get callout_text2() {
    if (!(this.runtime?.restart_required)) return undefined as never
    return this.tr(
            'admin.net_restart_body',
            "L'activation, la désactivation ou le changement de port du HTTPS lie ou délie une socket : le service doit être redémarré pour appliquer ce changement. Le port HTTP continue d'être servi en parallèle du HTTPS - un mandataire inverse ou une sonde qui l'utilise n'est pas coupé.",
          )
  }

  get show_runtime_https_live() {
    return !!(this.runtime?.https_live)
  }

  get show_not_runtime_https_live() {
    return !(this.runtime?.https_live)
  }

  get div_text() {
    return this.runtime?.https_live
                ? this.tr('admin.net_https_live', 'HTTPS actif (le core sert en TLS)')
                : this.tr('admin.net_https_off', 'HTTPS inactif (le core sert en HTTP nu)')
  }

  get div_text2() {
    return this.isLoading
                ? this.tr('common.loading', 'Chargement…')
                : this.tr('admin.net_min_tls', 'TLS minimum : {{v}}', { v: this.data?.config.tls_min_version })
  }

  get h2_text() {
    return this.tr('admin.net_cert_title', 'Certificat TLS')
  }

  get show_cert() {
    return this.memo('show_cert', [this.cert], () => !!(this.cert))
  }

  get show_not_cert() {
    return this.memo('show_not_cert', [this.cert], () => !(this.cert))
  }

  get span_text() {
    return this.memo('span_text', [this.tr, this.cert], () => {
      if (!(this.cert)) return undefined as never
      return this.tr('admin.net_cert_subject', 'Sujet') + " : "
    })
  }

  get span_text2() {
    if (!(this.cert)) return undefined as never
    return this.cert.subject || '-'
  }

  get show_cert_san() {
    if (!(this.cert)) return undefined as never
    return this.cert.san.length > 0
  }

  get span_text3() {
    return this.memo('span_text3', [this.tr, this.cert], () => {
      if (!(this.cert) || !(this.cert.san.length > 0)) return undefined as never
      return this.tr('admin.net_cert_san', 'Domaines') + " : "
    })
  }

  get span_text4() {
    if (!(this.cert) || !(this.cert.san.length > 0)) return undefined as never
    return this.cert.san.join(', ')
  }

  get span_text5() {
    return this.memo('span_text5', [this.tr, this.cert], () => {
      if (!(this.cert)) return undefined as never
      return this.tr('admin.net_cert_issuer', 'Émetteur') + " : "
    })
  }

  get span_text6() {
    if (!(this.cert)) return undefined as never
    return this.cert.issuer || '-'
  }

  get show_cert_not_after() {
    if (!(this.cert)) return undefined as never
    return !!(this.cert.not_after)
  }

  get span_text7() {
    return this.memo('span_text7', [this.tr, this.cert], () => {
      if (!(this.cert) || !(this.cert.not_after)) return undefined as never
      return this.tr('admin.net_cert_expires', 'Expire le') + " : "
    })
  }

  get span_text8() {
    if (!(this.cert) || !(this.cert.not_after)) return undefined as never
    return new Date(this.cert.not_after).toLocaleDateString(this.i18n.language)
  }

  get show_expires_in() {
    if (!(this.cert) || !(this.cert.not_after)) return undefined as never
    return this.expiresIn !== null
  }

  get span_class() {
    if (!(this.cert) || !(this.cert.not_after) || !(this.expiresIn !== null)) return undefined as never
    return this.expiresIn < 0
                        ? 'text-danger'
                        : this.expiresIn < 30
                          ? 'text-warning'
                          : 'text-text-tertiary'
  }

  get span_text9() {
    if (!(this.cert) || !(this.cert.not_after) || !(this.expiresIn !== null)) return undefined as never
    return this.expiresIn < 0
                      ? this.tr('admin.net_cert_expired', '(expiré)')
                      : this.tr('admin.net_cert_in_days', '(dans {{n}} j)', { n: this.expiresIn })
  }

  get div_text3() {
    return this.memo('div_text3', [this.tr, this.cert], () => {
      if (!(this.cert)) return undefined as never
      return this.tr('admin.net_cert_source', 'Source') + " :" + String(' ') + String(this.cert.source === 'acme'
                ? this.tr('admin.net_cert_source_acme', 'ACME (automatique)')
                : this.tr('admin.net_cert_source_upload', 'importé'))
    })
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.confirm, this.tr, this.removeCert, this.cert], () => {
      if (!(this.cert)) return undefined as never
      return ({ askDelete: this.memo("askDelete:bound", [], () => this.askDelete.bind(this)), cert: this.cert, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(this.cert)) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.cert], () => {
      if (!(!(this.cert))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Callout> icon: a value the property converts (null-when-false)). */
  get Part2() {
    if (!(!(this.cert))) return undefined as never
    return __parts.Part2
  }

  get div_text4() {
    return this.tr('admin.net_cert_upload', 'Importer un certificat')
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.certPem, this.memo], () => ({ t: this.tr, certPem: this.certPem, setCertPem: this.memo("setCertPem:bound", [], () => this.setCertPem.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextArea> spellCheck: no .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.keyPem, this.memo], () => ({ t: this.tr, keyPem: this.keyPem, setKeyPem: this.memo("setKeyPem:bound", [], () => this.setKeyPem.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextArea> spellCheck: no .kbview property). */
  get Part4() {
    return __parts.Part4
  }

  get p_text2() {
    return this.tr(
              'admin.net_cert_key_note',
              'La clé privée est écrite sur le disque du serveur, lisible par le seul service (0600), et n’est jamais renvoyée par l’interface. Le remplacement d’un certificat est appliqué à chaud si le HTTPS est déjà actif.',
            )
  }

  get part5_props() {
    return this.memo('part5_props', [this.upload, this.certPem, this.keyPem, this.tr], () => ({ upload: this.upload, certPem: this.certPem, keyPem: this.keyPem, t: this.tr }))
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part5() {
    return __parts.Part5
  }

  get h2_text2() {
    if (!(this.acmeMode)) return undefined as never
    return this.tr('admin.net_acme_title', 'Certificat automatique (ACME / Let’s Encrypt)')
  }

  get p_text3() {
    if (!(this.acmeMode)) return undefined as never
    return this.tr(
              'admin.net_acme_intro',
              "L'autorité vérifie chaque domaine en récupérant « http://<domaine>/.well-known/acme-challenge/… » servi par le core : chaque domaine doit pointer vers cette instance et être joignable en HTTP (port 80). Renseignez le répertoire, l'adresse de contact, les domaines et acceptez les conditions dans les réglages ci-dessous. Le renouvellement est ensuite automatique (30 jours avant l'expiration).",
            )
  }

  get show_acme() {
    return this.memo('show_acme', [this.acme, this.acmeMode], () => {
      if (!(this.acmeMode)) return undefined as never
      return !!(this.acme)
    })
  }

  get span_text10() {
    return this.memo('span_text10', [this.tr, this.acmeMode, this.acme], () => {
      if (!(this.acmeMode) || !(this.acme)) return undefined as never
      return this.tr('admin.net_acme_domains', 'Domaines') + " : "
    })
  }

  get span_text11() {
    if (!(this.acmeMode) || !(this.acme)) return undefined as never
    return this.acme.domains.length > 0 ? this.acme.domains.join(', ') : '-'
  }

  get show_acme_last_order() {
    if (!(this.acmeMode) || !(this.acme)) return undefined as never
    return !!(this.acme.last_order_status)
  }

  get span_text12() {
    return this.memo('span_text12', [this.tr, this.acmeMode, this.acme], () => {
      if (!(this.acmeMode) || !(this.acme) || !(this.acme.last_order_status)) return undefined as never
      return this.tr('admin.net_acme_last', 'Dernière tentative') + " : "
    })
  }

  get span_class2() {
    if (!(this.acmeMode) || !(this.acme) || !(this.acme.last_order_status)) return undefined as never
    return this.acme.last_order_status === 'ok'
                        ? 'text-success'
                        : this.acme.last_order_status === 'error'
                          ? 'text-danger'
                          : 'text-text-tertiary'
  }

  get span_text13() {
    if (!(this.acmeMode) || !(this.acme) || !(this.acme.last_order_status)) return undefined as never
    return this.acme.last_order_status === 'ok'
                      ? this.tr('admin.net_acme_ok_short', 'Réussie')
                      : this.acme.last_order_status === 'error'
                        ? this.tr('admin.net_acme_err_short', 'Échec')
                        : this.tr('admin.net_acme_pending', 'En cours')
  }

  get show_acme_last_attempt() {
    if (!(this.acmeMode) || !(this.acme) || !(this.acme.last_order_status)) return undefined as never
    return !!(this.acme.last_attempt_at)
  }

  get span_text14() {
    return this.memo('span_text14', [this.acme, this.i18n, this.acmeMode], () => {
      if (!(this.acmeMode) || !(this.acme) || !(this.acme.last_order_status) || !(this.acme.last_attempt_at)) return undefined as never
      return "· " + String(new Date(this.acme.last_attempt_at).toLocaleString(this.i18n.language))
    })
  }

  get show_acme_last_order2() {
    if (!(this.acmeMode) || !(this.acme)) return undefined as never
    return !!(this.acme.last_order_detail)
  }

  get div_text5() {
    if (!(this.acmeMode) || !(this.acme) || !(this.acme.last_order_detail)) return undefined as never
    return this.acme.last_order_detail
  }

  get part6_props() {
    return this.memo('part6_props', [this.requestAcme, this.tr, this.acmeMode], () => {
      if (!(this.acmeMode)) return undefined as never
      return ({ requestAcme: this.requestAcme, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part6() {
    if (!(this.acmeMode)) return undefined as never
    return __parts.Part6
  }

  get show_history() {
    return this.history.length > 0
  }

  get h2_text3() {
    if (!(this.history.length > 0)) return undefined as never
    return this.tr('admin.net_cert_history', 'Certificats précédents')
  }

  get p_text4() {
    if (!(this.history.length > 0)) return undefined as never
    return this.tr(
              'admin.net_cert_history_desc',
              'Conservés pour mémoire uniquement : leur clé privée a été détruite au moment de leur remplacement.',
            )
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part7() {
    if (!(this.history.length > 0)) return undefined as never
    return __parts.Part7
  }

  /** The rows of the Repeater over `history`. */
  get rows_history() {
    return this.memo('rows_history', [this.history, this.tr, this.i18n, this.memo, this.confirm, this.removeCert], () => {
      if (!(this.history.length > 0)) return undefined as never
      return this.history.map((c) => {
      return { c, div_text: ((this.history.length > 0)) ? (c.subject || c.id) : undefined, div_text2: ((this.history.length > 0)) ? (String(c.not_after
                      ? this.tr('admin.net_cert_expired_on', 'Expirait le {{d}}', {
                          d: new Date(c.not_after).toLocaleDateString(this.i18n.language),
                        })
                      : '-') + String(' · ') + String(c.source === 'acme'
                      ? this.tr('admin.net_cert_source_acme', 'ACME (automatique)')
                      : this.tr('admin.net_cert_source_upload', 'importé'))) : undefined, part7_props: ((this.history.length > 0)) ? ({ askDelete: this.memo("askDelete:bound", [], () => this.askDelete.bind(this)), c: c, removeCert: this.removeCert, t: this.tr }) : undefined, key: c.id }
    })
    })
  }

  /** `<SettingsGroupPanel>`, rendered by a ReactHost. */
  get SettingsGroupPanel() {
    return SettingsGroupPanel
  }

  get settings_group_panel_props() {
    return this.memo('settings_group_panel_props', [], () => ({ tab: "network" }))
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

  async askDelete(c: StoredCert) {
    const ok = await this.confirm({
      title: this.tr('admin.net_cert_delete_title', 'Supprimer ce certificat'),
      message: c.is_active
        ? this.tr(
            'admin.net_cert_delete_active_msg',
            'Ce certificat est celui que sert le HTTPS. Sa suppression est refusée tant que le HTTPS est activé.',
          )
        : this.tr('admin.net_cert_delete_msg', 'Supprimer « {{s}} » de l’historique ? Cette action est irréversible.', {
            s: c.subject || c.id,
          }),
      confirmLabel: this.tr('common.delete', 'Supprimer'),
      variant: 'danger',
    })
    if (ok) this.removeCert.mutate(c.id)
  }

  /** `setCertPem` of the TSX: a value, or an update of the previous one. */
  setCertPem(value: NetworkPanel['certPem'] | ((prev: NetworkPanel['certPem']) => NetworkPanel['certPem'])) {
    this.certPem = typeof value === 'function' ? (value as (prev: NetworkPanel['certPem']) => NetworkPanel['certPem'])(this.certPem) : value
  }

  /** `setKeyPem` of the TSX: a value, or an update of the previous one. */
  setKeyPem(value: NetworkPanel['keyPem'] | ((prev: NetworkPanel['keyPem']) => NetworkPanel['keyPem'])) {
    this.keyPem = typeof value === 'function' ? (value as (prev: NetworkPanel['keyPem']) => NetworkPanel['keyPem'])(this.keyPem) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type NetworkPanelStores = ReturnType<NetworkPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type NetworkPanelHooks = ReturnType<NetworkPanel['useHooks']>

export default NetworkPanel.component()
