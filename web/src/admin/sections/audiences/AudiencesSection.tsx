/**
 * Code-behind of `AudiencesSection.kbview` (converted from `AudiencesSection.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Globe, Plus, Search, Trash2 } from "lucide-react"
import { Button, Input, foldIncludes, type DataTableColumn, type DataTableRowAction } from "@ui"
import { usePrivileges } from "../../../core/authz/usePrivileges"
import { useConfirm } from "../../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
import type { AdminSectionProps } from "../registry"
import { adminUrlWith } from "../../adminAction"
import { AUDIENCES_MANAGE } from "./privileges"
import { useAudiences, useAudienceMutations, type Audience } from "./api"
import AudienceDialog from "./AudienceDialog"

import { ViewBase } from './AudiencesSection.kbview'
import * as __parts from './AudiencesSection.parts'

function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

export type { AdminSectionProps }

export class AudiencesSection extends ViewBase {
  @bind accessor creating = false
  @bind accessor q = ''
  tr!: AudiencesSectionStores['t']
  can!: AudiencesSectionStores['can']
  data!: AudiencesSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: AudiencesSectionStores['refetch']
  create!: AudiencesSectionStores['create']
  remove!: AudiencesSectionStores['remove']
  confirm!: AudiencesSectionStores['confirm']
  confirmState!: AudiencesSectionStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  rows!: Audience[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t }   = useTranslation()
    const { can } = usePrivileges()
    const { data, isLoading, isError, refetch } = useAudiences()
    const { create, remove } = useAudienceMutations(null)
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, can, data, isLoading, isError, refetch, create, remove, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const data = this.data
    const rows = useMemo(() => {
      const all = data?.audiences ?? []
      if (!this.q.trim()) return all
      return all.filter(a => foldIncludes(a.name, this.q) || (a.description ? foldIncludes(a.description, this.q) : false))
    }, [data, this.q])
    this.publish({ rows })
    return { rows }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, create: s.create, remove: s.remove, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ rows: h.rows })
  }

  get canManage(): boolean {
    return this.can(AUDIENCES_MANAGE)
  }

  get open(): string | null {
    return this.props.params.get('audience')
  }

  get columns(): DataTableColumn<Audience>[] {
    return this.memo('columns', [this.tr, this.open], () => {
      if (!(!(this.open))) return undefined as never
      return [
    {
      id: 'name',
      header: this.tr('admin.aud_name', { defaultValue: 'Nom' }),
      sortValue: a => a.name,
      cell: (a: Audience) => (
        <span className="flex min-w-0 items-center gap-2">
          {a.is_everyone && <Globe size={13} className="shrink-0 text-text-tertiary" />}
          <span className="truncate text-text-primary">{a.name}</span>
        </span>
      ),
    },
    {
      id: 'description',
      header: this.tr('admin.aud_description', { defaultValue: 'Description' }),
      cell: (a: Audience) => <span className="truncate text-text-secondary">{a.description ?? '—'}</span>,
    },
    {
      id: 'members',
      header: this.tr('admin.aud_members', { defaultValue: 'Membres' }),
      align: 'right',
      sortValue: a => a.member_count,
      cell: (a: Audience) => (a.is_everyone ? '—' : a.member_count),
    },
    {
      id: 'reach',
      header: this.tr('admin.aud_reach', { defaultValue: 'Comptes atteints' }),
      align: 'right',
      sortValue: a => a.reach,
      cell: (a: Audience) => a.reach,
    },
    {
      id: 'applied',
      header: this.tr('admin.aud_applied', { defaultValue: 'Proposée' }),
      align: 'right',
      sortValue: a => a.applied_to,
      cell: (a: Audience) => (a.applied_to === 0
        ? <span className="text-text-tertiary">
            {this.tr('admin.aud_not_applied', { defaultValue: 'nulle part' })}
          </span>
        : this.tr('admin.aud_applied_n', {
            defaultValue_one: '{{count}} endroit',
            defaultValue: '{{count}} endroits',
            count: a.applied_to,
          })),
    },
  ]
    })
  }

  get rowActions(): DataTableRowAction<Audience>[] {
    return this.memo('rowActions', [this.canManage, this.tr, this.open, this.confirm, this.remove], () => {
      if (!(!(this.open))) return undefined as never
      return this.canManage
    ? [{
        id: 'delete',
        label: this.tr('common.delete', { defaultValue: 'Supprimer' }),
        icon: <Trash2 size={14} />,
        danger: true,
        // The seeded audience is refused server-side; hiding the action avoids
        // offering a button whose only outcome is an error.
        hidden: a => a.is_everyone,
        onClick: a => void this.askRemove(a),
      }]
    : []
    })
  }

  get toolbar() {
    return this.memo('toolbar', [this.q, this.tr, this.canManage, this.creating, this.open], () => {
      if (!(!(this.open))) return undefined as never
      return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Input value={this.q} onChange={e => this.q = e.target.value}
             placeholder={this.tr('admin.aud_filter_ph', { defaultValue: 'Rechercher une audience…' })}
             leftIcon={<Search size={15} />} className="w-52 pl-9" />
      {this.canManage && (
        <Button size="sm" icon={<Plus size={14} />} onClick={() => this.creating = true}>
          {this.tr('admin.aud_new', { defaultValue: 'Nouvelle audience' })}
        </Button>
      )}
    </div>
  )
    })
  }

  get show_case_1() {
    return !!(this.open)
  }

  /** `<AudienceSheet Id>`: the audience id being viewed, narrowed non-null. */
  get audienceSheetId() {
    if (!(this.open)) return undefined as never
    return this.open
  }

  get show_main() {
    return !(this.open)
  }

  get show_data() {
    return this.memo('show_data', [this.data, this.open], () => {
      if (!(!(this.open))) return undefined as never
      return !!(this.data)
    })
  }

  get span_text() {
    if (!(!(this.open)) || !(this.data)) return undefined as never
    return this.tr('admin.aud_count', {
              defaultValue_one: '{{count}} audience',
              defaultValue: '{{count}} audiences',
              count: this.data.audiences.length,
            })
  }

  get part1_props() {
    return this.memo('part1_props', [this.rows, this.columns, this.isLoading, this.isError, this.tr, this.refetch, this.q, this.memo, this.toolbar, this.rowActions, this.props, this.open], () => {
      if (!(!(this.open))) return undefined as never
      return ({ rows: this.rows, columns: this.columns, isLoading: this.isLoading, isError: this.isError, t: this.tr, refetch: this.refetch, q: this.q, setQ: this.memo("setQ:bound", [], () => this.setQ.bind(this)), toolbar: this.toolbar, rowActions: this.rowActions, go: this.memo("go:bound", [], () => this.go.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, onRetry, filtered, onClearFilters, toolbar, rowActions, onRowClick, t, emptyState: no .kbview property). */
  get Part1() {
    if (!(!(this.open))) return undefined as never
    return __parts.Part1
  }

  /** `<AudienceDialog>`, rendered by a ReactHost. */
  get AudienceDialog() {
    if (!(!(this.open)) || !(this.creating)) return undefined as never
    return AudienceDialog
  }

  get audience_dialog_props() {
    return this.memo('audience_dialog_props', [this.create, this.creating, this.props, this.open], () => {
      if (!(!(this.open)) || !(this.creating)) return undefined as never
      return ({ busy: this.create.isPending, error: errMessage(this.create.error), onCancel: () => this.creating = false, onSave: v => this.create.mutate(v, {
            onSuccess: r => { this.creating = false; this.go(r.audience.id) },
          }) } as React.ComponentProps<typeof AudienceDialog>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.open], () => {
      if (!(!(this.open))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.open)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.open], () => {
      if (!(!(this.open)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  go(id: string | null) {
    return this.props.navigate(adminUrlWith('audiences', this.props.params, { audience: id }))
  }

  async askRemove(a: Audience) {
    if (!(!(this.open))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.aud_delete_q', { defaultValue: 'Supprimer « {{name}} » ?', name: a.name }),
      // The count of places it is offered is the part nobody has in mind: the
      // same click removes a list and changes what several units are shown.
      message: a.applied_to > 0
        ? this.tr('admin.aud_delete_applied', {
            defaultValue_one: 'Cette audience est proposée à {{count}} endroit. Elle cessera d’y apparaître. Les partages déjà effectués ne sont pas retirés.',
            defaultValue: 'Cette audience est proposée à {{count}} endroits. Elle cessera d’y apparaître. Les partages déjà effectués ne sont pas retirés.',
            count: a.applied_to,
          })
        : this.tr('admin.aud_delete_msg', {
            defaultValue: 'Elle n’est proposée nulle part. Les partages déjà effectués ne sont pas retirés.',
          }),
      confirmLabel: this.tr('common.delete', { defaultValue: 'Supprimer' }),
      variant: 'danger',
    })
    if (ok) this.remove.mutate(a.id)
  }

  /** `setQ` of the TSX: a value, or an update of the previous one. */
  setQ(value: AudiencesSection['q'] | ((prev: AudiencesSection['q']) => AudiencesSection['q'])) {
    this.q = typeof value === 'function' ? (value as (prev: AudiencesSection['q']) => AudiencesSection['q'])(this.q) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AudiencesSectionStores = ReturnType<AudiencesSection['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AudiencesSectionHooks = ReturnType<AudiencesSection['useHooks']>

export default AudiencesSection.component()
