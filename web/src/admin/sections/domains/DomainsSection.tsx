/**
 * Code-behind of `DomainsSection.kbview` (converted from `DomainsSection.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"
import { AlertTriangle, ShieldCheck } from "lucide-react"
import { Badge, Button, type DataTableColumn, type DataTableRowAction } from "@ui"
import { usePrivileges } from "../../../core/authz/usePrivileges"
import type { AdminSectionProps } from "../registry"
import { adminUrl, adminUrlWith } from "../../adminAction"
import { DOMAINS_MANAGE } from "./privileges"
import AddDomainDialog from "./AddDomainDialog"
import { errorMessage, useDomains, useVerifyDomain, type Domain } from "./api"

import { ViewBase } from './DomainsSection.kbview'
import * as __parts from './DomainsSection.parts'

export type { AdminSectionProps }

export class DomainsSection extends ViewBase {
  @bind accessor adding = false
  @bind accessor error: string | null = null
  tr!: DomainsSectionStores['t']
  can!: DomainsSectionStores['can']
  routerNavigate!: DomainsSectionStores['routerNavigate']
  data!: DomainsSectionStores['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: DomainsSectionStores['refetch']
  verify!: DomainsSectionStores['verify']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t }   = useTranslation()
    const { can } = usePrivileges()
    const routerNavigate = useNavigate()
    const { data, isLoading, isError, refetch } = useDomains()
    const verify = useVerifyDomain()
    return { t, can, routerNavigate, data, isLoading, isError, refetch, verify }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, routerNavigate: s.routerNavigate, data: s.data, isLoading: s.isLoading, isError: s.isError, refetch: s.refetch, verify: s.verify })
  }

  get canManage(): boolean {
    return this.can(DOMAINS_MANAGE)
  }

  get selected(): string | null {
    return this.props.params.get('domain')
  }

  get domains(): Domain[] {
    return this.memo('domains', [this.data, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return this.data?.domains ?? []
    })
  }

  get overview(): { total: number; verified: number; pending: number; aliases: number; primary_name: string | null; } | undefined {
    return this.memo('overview', [this.data, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return this.data?.overview
    })
  }

  get columns(): DataTableColumn<Domain>[] {
    return this.memo('columns', [this.tr, this.canManage, this.verify, this.error, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return [
    {
      id: 'name',
      header: this.tr('admin.dom_col_domain'),
      primary: true,
      minWidth: 220,
      sortValue: r => r.name,
      cell: r => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-text-primary">{r.name}</span>
          {r.kind === 'alias' && (
            <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
              {this.tr('admin.dom_alias_of', { name: r.parent_name })}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'kind',
      header: this.tr('admin.dom_col_kind'),
      sortValue: r => r.kind,
      cell: r => (
        r.kind === 'primary'
          ? <Badge variant="primary">{this.tr('admin.dom_kind_primary')}</Badge>
          : <Badge variant="neutral">{this.tr(`admin.dom_kind_${r.kind}`)}</Badge>
      ),
    },
    {
      id: 'status',
      header: this.tr('admin.dom_col_status'),
      minWidth: 220,
      sortValue: r => (r.verified ? 1 : 0),
      // The pipeline, as a control: what remains to do is what you can press.
      cell: r => (
        r.verified
          ? (
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 text-text-primary">
                <ShieldCheck size={14} className="text-success" /> {this.tr('admin.dom_verified')}
              </span>
              <span className="truncate text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
                {r.mx_hosts.length > 0
                  ? this.tr('admin.dom_mail_mx_count', { count: r.mx_hosts.length })
                  : r.mail_checked_at ? this.tr('admin.dom_mail_none') : this.tr('admin.dom_mail_unchecked')}
              </span>
            </span>
          )
          : this.canManage
            ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={this.verify.isPending}
                onClick={e => {
                  e.stopPropagation()
                  this.error = null
                  this.verify.mutate(r.id, { onError: err => this.error = errorMessage(err, this.tr('admin.dom_save_failed')) })
                }}
              >
                {this.tr('admin.dom_verify')}
              </Button>
            )
            : <span className="flex items-center gap-1.5 text-text-tertiary">
                <AlertTriangle size={14} /> {this.tr('admin.dom_unverified')}
              </span>
      ),
    },
    {
      id: 'accounts',
      header: this.tr('admin.dom_col_accounts'),
      align: 'right',
      sortValue: r => r.account_count,
      cell: r => (
        <span className={r.account_count === 0 ? 'text-text-tertiary' : 'text-text-secondary'}>
          {r.account_count || '—'}
        </span>
      ),
    },
  ]
    })
  }

  get rowActions(): DataTableRowAction<Domain>[] {
    return this.memo('rowActions', [this.tr, this.props, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return [
    { id: 'open', label: this.tr('admin.dom_action_open'), onClick: r => this.open(r.id) },
  ]
    })
  }

  get fromMismatch(): boolean | "" | null | undefined {
    if (!(!(this.selected))) return undefined as never
    const data = this.data
    return data?.from_domain && this.domains.length > 0 && !this.domains.some(d => d.name === data.from_domain && d.verified)
  }

  get show_case_1() {
    return !!(this.selected)
  }

  /** `<DomainDetail DomainId>`: the id of the domain being shown. */
  get domainId() {
    if (!(this.selected)) return undefined as never
    return this.selected
  }

  get show_main() {
    return !(this.selected)
  }

  get show_overview() {
    return this.memo('show_overview', [this.overview, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return !!(this.overview)
    })
  }

  /** `<Figure>`, rendered by a ReactHost. */
  get Figure() {
    if (!(!(this.selected)) || !(this.overview)) return undefined as never
    return __parts.Figure
  }

  get figure_props() {
    return this.memo('figure_props', [this.overview, this.tr, this.selected], () => {
      if (!(!(this.selected)) || !(this.overview)) return undefined as never
      return ({ value: this.overview.total, label: this.tr('admin.dom_stat_total') })
    })
  }

  get figure_props2() {
    return this.memo('figure_props2', [this.overview, this.tr, this.selected], () => {
      if (!(!(this.selected)) || !(this.overview)) return undefined as never
      return ({ value: this.overview.verified, label: this.tr('admin.dom_stat_verified') })
    })
  }

  get figure_props3() {
    return this.memo('figure_props3', [this.overview, this.tr, this.selected], () => {
      if (!(!(this.selected)) || !(this.overview)) return undefined as never
      return ({ value: this.overview.pending, label: this.tr('admin.dom_stat_pending') })
    })
  }

  get show_overview_primary_name() {
    if (!(!(this.selected)) || !(this.overview)) return undefined as never
    return !!(this.overview.primary_name)
  }

  get dom_primary_is_name() {
    if (!(!(this.selected)) || !(this.overview) || !(this.overview.primary_name)) return undefined as never
    return this.overview.primary_name
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.adding, this.tr, this.selected, this.overview, this.canManage], () => {
      if (!(!(this.selected)) || !(this.overview) || !(this.canManage)) return undefined as never
      return ({ setAdding: this.memo("setAdding:bound", [], () => this.setAdding.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(!(this.selected)) || !(this.overview) || !(this.canManage)) return undefined as never
    return __parts.Part1
  }

  get show_from_mismatch() {
    if (!(!(this.selected))) return undefined as never
    return !!(this.fromMismatch)
  }

  get dom_from_mismatch_address() {
    if (!(!(this.selected)) || !(this.fromMismatch)) return undefined as never
    return this.data?.from_address
  }

  get dom_from_mismatch_domain() {
    if (!(!(this.selected)) || !(this.fromMismatch)) return undefined as never
    return this.data?.from_domain
  }

  get show_error() {
    if (!(!(this.selected))) return undefined as never
    return !!(this.error)
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.domains, this.columns, this.isLoading, this.rowActions, this.memo, this.props, this.isError, this.refetch, this.canManage, this.adding, this.selected], () => {
      if (!(!(this.selected))) return undefined as never
      return ({ t: this.tr, domains: this.domains, columns: this.columns, isLoading: this.isLoading, rowActions: this.rowActions, open: this.memo("open:bound", [], () => this.open.bind(this)), isError: this.isError, refetch: this.refetch, canManage: this.canManage, setAdding: this.memo("setAdding:bound", [], () => this.setAdding.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<DataTable> t, columns, rowKey, rowActions, onRowClick, onRetry, emptyState: no .kbview property). */
  get Part2() {
    if (!(!(this.selected))) return undefined as never
    return __parts.Part2
  }

  /** `<AddDomainDialog>`, rendered by a ReactHost. */
  get AddDomainDialog() {
    if (!(!(this.selected)) || !(this.adding)) return undefined as never
    return AddDomainDialog
  }

  get add_domain_dialog_props() {
    return this.memo('add_domain_dialog_props', [this.domains, this.adding, this.routerNavigate, this.selected], () => {
      if (!(!(this.selected)) || !(this.adding)) return undefined as never
      return ({ domains: this.domains, onClose: () => this.adding = false, onAdded: d => this.routerNavigate(adminUrl({ tab: 'domains', params: { domain: d.id } })) } as React.ComponentProps<typeof AddDomainDialog>)
    })
  }

  /** `<DomainDetail OnGone>`: the shown domain is gone, return to the list. */
  handleGone(_sender: unknown, _e: EventArgs) {
    this.open(null)
  }

  open(id: string | null) {
    return this.props.navigate(adminUrlWith('domains', this.props.params, { domain: id }))
  }

  /** `setAdding` of the TSX: a value, or an update of the previous one. */
  setAdding(value: DomainsSection['adding'] | ((prev: DomainsSection['adding']) => DomainsSection['adding'])) {
    this.adding = typeof value === 'function' ? (value as (prev: DomainsSection['adding']) => DomainsSection['adding'])(this.adding) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DomainsSectionStores = ReturnType<DomainsSection['useStores']>

export default DomainsSection.component()
