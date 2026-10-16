/**
 * Code-behind of `KnownConnectionsCard.kbcontrol` (converted from `KnownConnectionsCard.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { Fragment } from 'react'
import { useTranslation } from "react-i18next"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, TriangleAlert, ArrowRightLeft, Copy, Trash2, RefreshCw } from "lucide-react"
import { Button, Callout, Spinner, useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { api } from "../../core/api/client"
import { apiErrorMessage } from "../../core/api/errorMessage"
import { useConfirm } from "../../core/hooks/useConfirm"
import { usePrivileges } from "../../core/authz/usePrivileges"

import { ViewBase } from './KnownConnectionsCard.kbcontrol'

interface Conn {
  id: string
  engine: string
  host: string
  port: number | null
  user: string
  database: string
  path: string
  schema_prefix: string | null
  label: string
  has_password: boolean
  is_current: boolean
  created_at: string
  last_used_at: string
  last_synced_at: string | null
}

interface ConnectionsResponse {
  scope: string
  connections: Conn[]
}

function fmtDate(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString()
}

export type KnownConnectionsCardProps = {
  basePath: string
  queryKey: (string | undefined)[]
  onChanged?: () => void
  /** Render the list as a section (no Card chrome), to sit inside a parent card. */
  embedded?: boolean
  /** Section heading, used in embedded mode. */
  heading?: string
}

export class KnownConnectionsCard extends ViewBase {
  @bind accessor error: string | null = null
  @bind accessor busyId: string | null = null
  tr!: KnownConnectionsCardStores['t']
  isSuperuser!: boolean
  toast!: KnownConnectionsCardStores['toast']
  qc!: KnownConnectionsCardStores['qc']
  confirm!: KnownConnectionsCardStores['confirm']
  confirmState!: KnownConnectionsCardStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  q!: KnownConnectionsCardHooks['q']
  switchMut!: KnownConnectionsCardHooks['switchMut']
  syncMut!: KnownConnectionsCardHooks['syncMut']
  forgetMut!: KnownConnectionsCardHooks['forgetMut']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { isSuperuser } = usePrivileges()
    const toast = useToast()
    const qc = useQueryClient()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, isSuperuser, toast, qc, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const isSuperuser = this.isSuperuser
    const toast = this.toast
    const q = useQuery<ConnectionsResponse>({
      queryKey: ['db-connections', ...this.props.queryKey],
      queryFn: () => api.get<ConnectionsResponse>(`${this.props.basePath}/connections`).then(r => r.data),
      enabled: isSuperuser,
      staleTime: 15_000,
    })
    this.publish({ q })
    const switchMut = useMutation({
      mutationFn: (v: { id: string; overwrite: boolean }) =>
        api.post(`${this.props.basePath}/connections/${v.id}/switch`, { overwrite: v.overwrite }).then(r => r.data),
      onMutate: (v) => { this.busyId = v.id; this.error = null },
      onSuccess: (data: { restart_required?: boolean }) => {
        toast.success(data?.restart_required ? t('admin.dbconn_switched_restart') : t('admin.dbconn_switched'))
        this.refresh()
      },
      onError: (e: unknown) => this.error = apiErrorMessage(e, t('admin.dbconn_switch_failed')),
      onSettled: () => this.busyId = null,
    })
    this.publish({ switchMut })
    const syncMut = useMutation({
      mutationFn: (id: string) => api.post(`${this.props.basePath}/connections/${id}/sync`).then(r => r.data),
      onMutate: (id) => { this.busyId = id; this.error = null },
      onSuccess: () => { toast.success(t('admin.dbconn_synced')); this.refresh() },
      onError: (e: unknown) => this.error = apiErrorMessage(e, t('admin.dbconn_sync_failed')),
      onSettled: () => this.busyId = null,
    })
    this.publish({ syncMut })
    const forgetMut = useMutation({
      mutationFn: (id: string) => api.delete(`${this.props.basePath}/connections/${id}`).then(r => r.data),
      onMutate: (id) => { this.busyId = id; this.error = null },
      onSuccess: () => { toast.success(t('admin.dbconn_forgotten')); this.refresh() },
      onError: (e: unknown) => this.error = apiErrorMessage(e, t('admin.dbconn_forget_failed')),
      onSettled: () => this.busyId = null,
    })
    this.publish({ forgetMut })
    return { q, switchMut, syncMut, forgetMut }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, isSuperuser: s.isSuperuser, toast: s.toast, qc: s.qc, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ q: h.q, switchMut: h.switchMut, syncMut: h.syncMut, forgetMut: h.forgetMut })
  }

  get embedded() {
    return this.props.embedded ?? false
  }

  get conns(): Conn[] {
    return this.memo('conns', [this.q, this.isSuperuser], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      return this.q.data?.connections ?? []
    })
  }

  get body() {
    return this.memo('body', [this.q, this.tr, this.conns, this.error, this.isSuperuser, this.confirm, this.switchMut, this.syncMut, this.forgetMut, this.confirmState, this.handleConfirm, this.handleCancel, this.busyId], () => {
      if (!(!(!this.isSuperuser))) return undefined as never
      const busyId = this.busyId
      return (
    <>
      {this.q.isLoading ? (
        <div className="py-6 flex justify-center"><Spinner /></div>
      ) : this.q.isError ? (
        <Callout variant="danger" icon={<TriangleAlert size={16} />}>{this.tr('admin.dbconn_load_error')}</Callout>
      ) : this.conns.length === 0 ? (
        <p className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr('admin.dbconn_empty')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {this.error && <Callout variant="danger" title={this.tr('admin.dbconn_error')}>{this.error}</Callout>}
          {this.conns.map((c) => {
            const rowBusy = busyId === c.id
            return (
              <div key={c.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{c.label}</span>
                      {c.is_current && (
                        <span className="inline-flex items-center gap-1 text-success"
                          style={{ fontSize: 'var(--kb-text-meta)' }}>
                          <Check size={13} />{this.tr('admin.dbconn_current')}
                        </span>
                      )}
                    </div>
                    <div className="text-text-secondary truncate" style={{ fontSize: 'var(--kb-text-meta)' }}>
                      {this.meta(c)}
                    </div>
                    <div className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                      {this.tr('admin.dbconn_last_used', { when: fmtDate(c.last_used_at) })}
                      {c.last_synced_at && ` · ${this.tr('admin.dbconn_last_synced', { when: fmtDate(c.last_synced_at) })}`}
                    </div>
                  </div>
                </div>

                {!c.is_current && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" icon={<ArrowRightLeft size={14} />}
                      onClick={() => this.onSwitchExisting(c)}
                      disabled={rowBusy} loading={rowBusy && this.switchMut.isPending}>
                      {this.tr('admin.dbconn_switch_existing')}
                    </Button>
                    <Button variant="secondary" size="sm" icon={<Copy size={14} />}
                      onClick={() => this.onSwitchOverwrite(c)} disabled={rowBusy}>
                      {this.tr('admin.dbconn_switch_overwrite')}
                    </Button>
                    <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />}
                      onClick={() => this.onSync(c)} disabled={rowBusy}>
                      {this.tr('admin.dbconn_sync')}
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Trash2 size={14} />}
                      onClick={() => this.onForget(c)} disabled={rowBusy}>
                      {this.tr('admin.dbconn_forget')}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {this.confirmState && (
        <ConfirmDialog {...this.confirmState} onConfirm={this.handleConfirm} onCancel={this.handleCancel} />
      )}
    </>
  )
    })
  }

  get show_case_1() {
    return !!(!this.isSuperuser)
  }

  get show_case_2() {
    return !(!this.isSuperuser) && !!(this.embedded)
  }

  get show_heading() {
    if (!(!(!this.isSuperuser)) || !(this.embedded)) return undefined as never
    return !!(this.props.heading)
  }

  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_body() {
    return this.memo('content_body', [this.body, this.isSuperuser, this.embedded], () => {
      if (!(!(!this.isSuperuser)) || !(this.embedded)) return undefined as never
      return ({ children: this.body })
    })
  }

  get show_main() {
    return !(!this.isSuperuser) && !(this.embedded)
  }

  get content_body2() {
    return this.memo('content_body2', [this.body, this.isSuperuser, this.embedded], () => {
      if (!(!(!this.isSuperuser)) || !(!(this.embedded))) return undefined as never
      return ({ children: this.body })
    })
  }

  refresh() {
    void this.qc.invalidateQueries({ queryKey: ['db-connections', ...this.props.queryKey] })
    this.props.onChanged?.()
  }

  async onSwitchExisting(c: Conn) {
    if (!(!(!this.isSuperuser))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.dbconn_switch_existing'),
      message: this.tr('admin.dbconn_switch_existing_confirm', { label: c.label }),
      confirmLabel: this.tr('admin.dbconn_switch_existing'),
    })
    if (ok) this.switchMut.mutate({ id: c.id, overwrite: false })
  }

  async onSwitchOverwrite(c: Conn) {
    if (!(!(!this.isSuperuser))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.dbconn_switch_overwrite'),
      message: this.tr('admin.dbconn_switch_overwrite_confirm', { label: c.label }),
      confirmLabel: this.tr('admin.dbconn_switch_overwrite'),
      variant: 'danger',
    })
    if (ok) this.switchMut.mutate({ id: c.id, overwrite: true })
  }

  async onSync(c: Conn) {
    if (!(!(!this.isSuperuser))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.dbconn_sync'),
      message: this.tr('admin.dbconn_sync_confirm', { label: c.label }),
      confirmLabel: this.tr('admin.dbconn_sync'),
      variant: 'danger',
    })
    if (ok) this.syncMut.mutate(c.id)
  }

  async onForget(c: Conn) {
    if (!(!(!this.isSuperuser))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.dbconn_forget'),
      message: this.tr('admin.dbconn_forget_confirm', { label: c.label }),
      confirmLabel: this.tr('admin.dbconn_forget'),
      variant: 'danger',
    })
    if (ok) this.forgetMut.mutate(c.id)
  }

  meta(c: Conn) {
    if (!(!(!this.isSuperuser))) return undefined as never
    const parts: string[] = [this.tr(`admin.mdb_engine_${c.engine}`, c.engine)]
    if (c.engine === 'sqlite') {
      if (c.path) parts.push(c.path)
    } else {
      const hostPart = c.port ? `${c.host}:${c.port}` : c.host
      if (hostPart) parts.push(hostPart)
      if (c.database) parts.push(c.database)
    }
    return parts.join(' · ')
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type KnownConnectionsCardStores = ReturnType<KnownConnectionsCard['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type KnownConnectionsCardHooks = ReturnType<KnownConnectionsCard['useHooks']>

export default KnownConnectionsCard.component()
