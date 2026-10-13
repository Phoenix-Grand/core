/**
 * Code-behind of `ScopeHeadline.kbcontrol` (converted from `ScopeHeadline.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../core/api/client"
import type { OrgUnit } from "../../../core/types"
import { orgUnitPath, type ActiveScope } from "../scopeTypes"

import { ViewBase } from './ScopeHeadline.kbcontrol'

export type ScopeHeadlineProps = { scope: ActiveScope }

export class ScopeHeadline extends ViewBase {
  tr!: ScopeHeadlineStores['t']
  data!: ScopeHeadlineHooks['data']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data } = useQuery({
      enabled: this.props.scope.type === 'org_unit',
      queryKey: ['admin-org-units'],
      queryFn: () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
    })
    this.publish({ data })
    return { data }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ data: h.data })
  }

  get units() {
    return this.memo('units', [this.data], () => this.data ?? [])
  }

  get path(): OrgUnit[] {
    return this.memo('path', [this.units, this.props], () => orgUnitPath(this.units, this.props.scope.type === 'org_unit' ? this.props.scope.id : null))
  }

  get self(): OrgUnit {
    return this.memo('self', [this.path], () => this.path[this.path.length - 1])
  }

  get parent(): OrgUnit | null {
    return this.memo('parent', [this.path], () => this.path.length >= 2 ? this.path[this.path.length - 2] : null)
  }

  get isInstance(): boolean {
    return this.props.scope.type === 'instance' || !this.self
  }

  get span_text() {
    return this.isInstance
          ? this.tr('admin.m_scope_instance', { defaultValue: "Toute l'instance" })
          : this.self.name
  }

  get show_is_instance() {
    return !this.isInstance
  }

  get m_scope_inherits_from_parent() {
    if (!(!this.isInstance)) return undefined as never
    return this.parent
              ? this.parent.name
              : this.tr('admin.m_scope_instance', { defaultValue: "Toute l'instance" })
  }

  get span_text2() {
    if (!(!this.isInstance)) return undefined as never
    return this.tr('admin.m_scope_inherits_from', {
            parent: this.parent
              ? this.parent.name
              : this.tr('admin.m_scope_instance', { defaultValue: "Toute l'instance" }),
            defaultValue: `— un réglage non remplacé suit ${this.parent ? this.parent.name : "toute l'instance"}`,
          })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ScopeHeadlineStores = ReturnType<ScopeHeadline['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ScopeHeadlineHooks = ReturnType<ScopeHeadline['useHooks']>

export default ScopeHeadline.component()
