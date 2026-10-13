/**
 * Code-behind of `SessionsCard.kbcontrol` (converted from `SessionsCard.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { MonitorSmartphone, Smartphone, Terminal, Laptop } from "lucide-react"
import { ConfirmDialog, useToast, type DataTableColumn } from "@ui"
import { api } from "../../../core/api/client"
import { useConfirm } from "../../../core/hooks/useConfirm"
import type { Session, User } from "../../../core/types"
import { formatAgo, formatWhen } from "../format"

import { ViewBase } from './SessionsCard.kbcontrol'
import * as __parts from './SessionsCard.parts'

const DEVICE_ICON: Record<string, typeof MonitorSmartphone> = {
  web:     MonitorSmartphone,
  mobile:  Smartphone,
  desktop: Laptop,
  api:     Terminal,
}

export type SessionsCardProps = { user: User }

export class SessionsCard extends ViewBase {
  tr!: SessionsCardStores['t']
  i18n!: SessionsCardStores['i18n']
  qc!: SessionsCardStores['qc']
  toast!: SessionsCardStores['toast']
  confirm!: SessionsCardStores['confirm']
  confirmState!: SessionsCardStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: SessionsCardHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: SessionsCardHooks['refetch']
  revoke!: SessionsCardHooks['revoke']
  revokeAll!: SessionsCardHooks['revokeAll']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const qc = useQueryClient()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, i18n, qc, toast, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const { data, isLoading, isError, refetch } = useQuery({
      queryKey: ['admin-user-sessions', this.props.user.id],
      queryFn:  () => api.get<{ sessions: Session[] }>(`/admin/users/${this.props.user.id}/sessions`).then(r => r.data.sessions),
    })
    this.publish({ data, isLoading, isError, refetch })
    const revoke = useMutation({
      mutationFn: (id: string) => api.delete(`/admin/users/${this.props.user.id}/sessions/${id}`),
      onSuccess: () => { this.invalidate_(); toast.success(t('admin.ud_ses_revoked')) },
      onError:   () => toast.error(t('admin.ud_ses_revoke_error')),
    })
    this.publish({ revoke })
    const revokeAll = useMutation({
      mutationFn: () => api.delete<{ revoked: number }>(`/admin/users/${this.props.user.id}/sessions`).then(r => r.data),
      onSuccess: (res) => { this.invalidate_(); toast.success(t('admin.ud_ses_revoked_all', { count: res?.revoked ?? 0 })) },
      onError:   () => toast.error(t('admin.ud_ses_revoke_error')),
    })
    this.publish({ revokeAll })
    return { data, isLoading, isError, refetch, revoke, revokeAll }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, qc: s.qc, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, revoke: h.revoke, revokeAll: h.revokeAll })
  }

  get sessions() {
    return this.memo('sessions', [this.data], () => this.data ?? [])
  }

  get columns(): DataTableColumn<Session>[] {
    return this.memo('columns', [this.tr, this.i18n], () => [
    {
      id: 'device',
      header: this.tr('admin.ud_ses_device'),
      headerText: this.tr('admin.ud_ses_device'),
      primary: true,
      minWidth: 200,
      sortValue: s => s.device_name ?? '',
      cell: (s) => {
        const Icon = DEVICE_ICON[s.device_type ?? ''] ?? MonitorSmartphone
        return (
          <span className="flex items-center gap-2">
            <Icon size={15} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 truncate">{s.device_name ?? this.tr('settings.ses_unknown')}</span>
          </span>
        )
      },
    },
    {
      id: 'ip',
      header: this.tr('admin.ud_ses_ip'),
      headerText: this.tr('admin.ud_ses_ip'),
      minWidth: 120,
      sortValue: s => s.ip_address ?? '',
      cell: s => <span className="font-mono text-text-secondary">{s.ip_address ?? '—'}</span>,
    },
    {
      id: 'last_used',
      header: this.tr('admin.ud_ses_last_used'),
      headerText: this.tr('admin.ud_ses_last_used'),
      minWidth: 160,
      sortValue: s => new Date(s.last_used_at),
      cell: s => (
        <span className="text-text-secondary" title={formatWhen(s.last_used_at, this.i18n.language)}>
          {formatAgo(s.last_used_at)}
        </span>
      ),
    },
    {
      id: 'created',
      header: this.tr('admin.ud_ses_created'),
      headerText: this.tr('admin.ud_ses_created'),
      minWidth: 160,
      defaultHidden: true,
      sortValue: s => new Date(s.created_at),
      cell: s => <span className="text-text-secondary">{formatWhen(s.created_at, this.i18n.language)}</span>,
    },
  ])
  }

  get show_sessions() {
    return this.sessions.length > 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.sessions, this.columns, this.isLoading, this.isError, this.refetch, this.memo, this.confirm, this.revoke], () => ({ t: this.tr, sessions: this.sessions, columns: this.columns, isLoading: this.isLoading, isError: this.isError, refetch: this.refetch, askRevoke: this.memo("askRevoke:bound", [], () => this.askRevoke.bind(this)) }))
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, skeletonRows, onRetry, configurableColumns, minTableWidth, rowActions, emptyState: no .kbview property). */
  get Part1() {
    return __parts.Part1
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
    void this.qc.invalidateQueries({ queryKey: ['admin-user-sessions', this.props.user.id] })
    void this.qc.invalidateQueries({ queryKey: ['admin-stats'] })
  }

  async askRevoke(s: Session) {
    const ok = await this.confirm({
      title:        this.tr('admin.ud_ses_confirm_title'),
      message:      this.tr('admin.ud_ses_confirm_msg', { device: s.device_name ?? this.tr('settings.ses_unknown') }),
      confirmLabel: this.tr('admin.ud_ses_revoke'),
      variant:      'danger',
    })
    if (ok) this.revoke.mutate(s.id)
  }

  async askRevokeAll() {
    const ok = await this.confirm({
      title:        this.tr('admin.ud_ses_confirm_all_title'),
      message:      this.tr('admin.ud_ses_confirm_all_msg', { name: this.props.user.display_name || this.props.user.username }),
      confirmLabel: this.tr('admin.ud_ses_revoke_all'),
      variant:      'danger',
    })
    if (ok) this.revokeAll.mutate()
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.sessions.length > 0)) return undefined as never
    void this.askRevokeAll()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SessionsCardStores = ReturnType<SessionsCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type SessionsCardHooks = ReturnType<SessionsCard['useHooks']>

export default SessionsCard.component()
