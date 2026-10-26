/**
 * Code-behind of `GroupsPanel.kbview` (converted from `GroupsPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useSearchParams } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { foldIncludes } from "@ui"
import { api } from "../../core/api/client"
import { useAdminAction } from "../adminAction"
import type { UserGroup } from "../../core/types"
import { groupName, groupDescription } from "../../core/directory/labels"

import { ViewBase } from './GroupsPanel.kbview'
import * as __parts from './GroupsPanel.parts.tsx'

export class GroupsPanel extends ViewBase {
  @bind accessor showCreate = false
  queryClient!: GroupsPanelStores['queryClient']
  tr!: GroupsPanelStores['t']
  params!: URLSearchParams
  data!: GroupsPanelStores['data']
  isLoading!: boolean
  createGroup!: GroupsPanelHooks['createGroup']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [params] = useSearchParams()
    const { data, isLoading } = useQuery({
      queryKey: ['admin-groups'],
      queryFn: () =>
        api.get<{ groups: (UserGroup & { member_count: number })[] }>('/admin/groups')
          .then((r) => r.data.groups),
    })
    return { t, queryClient, params, data, isLoading }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const queryClient = this.queryClient
    useAdminAction('create', () => this.showCreate = true)
    const createGroup = useMutation({
      mutationFn: (body: object) => api.post('/admin/groups', body),
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-groups'] }); this.showCreate = false },
    })
    this.publish({ createGroup })
    return { createGroup }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, queryClient: s.queryClient, params: s.params, data: s.data, isLoading: s.isLoading })
    const h = this.useHooks()
    this.publish({ createGroup: h.createGroup })
  }

  get filter(): string {
    return this.params.get('q')?.trim() ?? ''
  }

  get rows(): (UserGroup & { member_count: number; })[] | undefined {
    return this.memo('rows', [this.filter, this.data, this.tr], () => this.filter
    ? this.data?.filter(g => foldIncludes(`${groupName(this.tr, g)} ${groupDescription(this.tr, g) ?? ''} ${g.name} ${g.description ?? ''}`, this.filter))
    : this.data)
  }

  /** `<GroupForm>`, rendered by a ReactHost. */
  get GroupForm() {
    if (!(this.showCreate)) return undefined as never
    return __parts.GroupForm
  }

  get group_form_props() {
    return this.memo('group_form_props', [this.createGroup, this.showCreate], () => {
      if (!(this.showCreate)) return undefined as never
      return ({ onSave: (data) => this.createGroup.mutate(data), onCancel: () => this.showCreate = false } as React.ComponentProps<typeof __parts.GroupForm>)
    })
  }

  get show_rows_rows() {
    return !!(this.rows && this.rows.length === 0)
  }

  /** `<GroupRow>`, rendered by a ReactHost. */
  get GroupRow() {
    return __parts.GroupRow
  }

  /** The rows of the Repeater over `rows`. */
  get rows_rows() {
    return this.memo('rows_rows', [this.rows, this.queryClient], () => (this.rows ?? []).map((g) => {
      return { g, group_row_props: { group: g, onDeleted: () => this.queryClient.invalidateQueries({ queryKey: ['admin-groups'] }) } as React.ComponentProps<typeof __parts.GroupRow>, key: g.id }
    }))
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.showCreate = !this.showCreate
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type GroupsPanelStores = ReturnType<GroupsPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type GroupsPanelHooks = ReturnType<GroupsPanel['useHooks']>

export default GroupsPanel.component()
