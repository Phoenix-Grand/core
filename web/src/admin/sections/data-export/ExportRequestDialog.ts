/**
 * Code-behind of `ExportRequestDialog.kbview` (converted from `ExportRequestDialog.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../core/api/client"
import { errorMessage, useRequestExport, type DataExportOverview, type ExportScope } from "./api"

import { ViewBase } from './ExportRequestDialog.kbview'
import * as __parts from './ExportRequestDialog.parts'

interface PickableUser {
  id:           string
  email:        string
  username:     string
  display_name: string | null
  is_active:    boolean
}

const PICKER_LIMIT = 500

export type ExportRequestDialogProps = {
  overview:    DataExportOverview
  onClose:     () => void
  onRequested: (exportId: string) => void
}

export class ExportRequestDialog extends ViewBase {
  @bind accessor scope: ExportScope = 'instance'
  @bind accessor picked: string[] = []
  @bind accessor query = ''
  @bind accessor withInstance = true
  @bind accessor error: string | null = null
  tr!: ExportRequestDialogStores['t']
  i18n!: ExportRequestDialogStores['i18n']
  request!: ExportRequestDialogStores['request']
  services!: string[]
  setServices!: ExportRequestDialogHooks['setServices']
  loadingUsers!: boolean
  shown!: PickableUser[]
  pickedLabels!: { id: string; label: string; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const request = useRequestExport()
    return { t, i18n, request }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [services, setServices] = useState<string[]>(
      // Everything the instance can produce, ticked. An export whose default is
      // "nothing" would be a form an operator fills in twice.
      () => this.props.overview.services.map(s => s.id),
    )
    this.publish({ services, setServices })
    const { data: users, isLoading: loadingUsers } = useQuery({
      queryKey: ['admin-data-export-users'],
      enabled:  this.scope === 'accounts',
      queryFn:  async () =>
        (await api.get<{ users: PickableUser[] }>('/admin/users', { params: { limit: PICKER_LIMIT } }))
          .data.users,
      staleTime: 60_000,
    })
    this.publish({ loadingUsers })
    const shown = useMemo(() => {
      const needle = this.query.trim().toLowerCase()
      const all = users ?? []
      if (!needle) return all.slice(0, 200)
      return all
        .filter(u =>
          u.email.toLowerCase().includes(needle)
          || u.username.toLowerCase().includes(needle)
          || (u.display_name ?? '').toLowerCase().includes(needle))
        .slice(0, 200)
    }, [users, this.query])
    this.publish({ shown })
    const pickedLabels = useMemo(() => {
      const index = new Map((users ?? []).map(u => [u.id, u.display_name?.trim() || u.email]))
      return this.picked.map(id => ({ id, label: index.get(id) ?? id }))
    }, [users, this.picked])
    this.publish({ pickedLabels })
    return { services, setServices, users, loadingUsers, shown, pickedLabels }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, request: s.request })
    const h = this.useHooks()
    this.publish({ services: h.services, setServices: h.setServices, loadingUsers: h.loadingUsers, shown: h.shown, pickedLabels: h.pickedLabels })
  }

  get accounts(): number {
    return this.scope === 'instance' ? this.props.overview.active_accounts : this.picked.length
  }

  get canSubmit(): boolean {
    return this.accounts > 0 && !this.request.isPending
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props, this.memo, this.error, this.request, this.scope, this.picked, this.services, this.withInstance, this.canSubmit, this.query, this.pickedLabels, this.loadingUsers, this.shown, this.setServices, this.accounts, this.i18n], () => ({ t: this.tr, onClose: this.props.onClose, submit: this.memo("submit:bound", [], () => this.submit.bind(this)), canSubmit: this.canSubmit, request: this.request, scope: this.scope, setScope: this.memo("setScope:bound", [], () => this.setScope.bind(this)), overview: this.props.overview, query: this.query, setQuery: this.memo("setQuery:bound", [], () => this.setQuery.bind(this)), pickedLabels: this.pickedLabels, setPicked: this.memo("setPicked:bound", [], () => this.setPicked.bind(this)), loadingUsers: this.loadingUsers, shown: this.shown, picked: this.picked, services: this.services, toggleService: this.memo("toggleService:bound", [], () => this.toggleService.bind(this)), withInstance: this.withInstance, setWithInstance: this.memo("setWithInstance:bound", [], () => this.setWithInstance.bind(this)), accounts: this.accounts, i18n: this.i18n, error: this.error }))
  }

  /** A part of the screen still written in React (<FloatingWindow> padding: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  toggleService(id: string, on: boolean) {
    return this.setServices(list => (on ? [...new Set([...list, id])] : list.filter(s => s !== id)))
  }

  submit() {
    this.error = null
    this.request.mutate(
      {
        scope: this.scope,
        user_ids: this.scope === 'accounts' ? this.picked : undefined,
        services: this.services,
        with_instance: this.withInstance,
      },
      {
        onSuccess: response => {
          const id = (response as { data?: { export_id?: string } })?.data?.export_id
          this.props.onRequested(id ?? '')
        },
        onError: e => this.error = errorMessage(e, this.tr('admin.dx_request_failed')),
      },
    )
  }

  /** `setScope` of the TSX: a value, or an update of the previous one. */
  setScope(value: ExportScope | ((prev: ExportScope) => ExportScope)) {
    this.scope = typeof value === 'function' ? (value as (prev: ExportScope) => ExportScope)(this.scope) : value
  }

  /** `setQuery` of the TSX: a value, or an update of the previous one. */
  setQuery(value: ExportRequestDialog['query'] | ((prev: ExportRequestDialog['query']) => ExportRequestDialog['query'])) {
    this.query = typeof value === 'function' ? (value as (prev: ExportRequestDialog['query']) => ExportRequestDialog['query'])(this.query) : value
  }

  /** `setPicked` of the TSX: a value, or an update of the previous one. */
  setPicked(value: string[] | ((prev: string[]) => string[])) {
    this.picked = typeof value === 'function' ? (value as (prev: string[]) => string[])(this.picked) : value
  }

  /** `setWithInstance` of the TSX: a value, or an update of the previous one. */
  setWithInstance(value: ExportRequestDialog['withInstance'] | ((prev: ExportRequestDialog['withInstance']) => ExportRequestDialog['withInstance'])) {
    this.withInstance = typeof value === 'function' ? (value as (prev: ExportRequestDialog['withInstance']) => ExportRequestDialog['withInstance'])(this.withInstance) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ExportRequestDialogStores = ReturnType<ExportRequestDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ExportRequestDialogHooks = ReturnType<ExportRequestDialog['useHooks']>

export default ExportRequestDialog.component()
