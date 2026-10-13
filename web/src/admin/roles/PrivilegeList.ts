/**
 * Code-behind of `PrivilegeList.kbcontrol` (converted from `PrivilegeList.tsx` by @kubuno/views-migrate).
 */
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { Privilege } from "../../core/authz/types"
import { useAuthzLabels } from "../../core/authz/labels"

import { ViewBase } from './PrivilegeList.kbcontrol'
import * as __parts from './PrivilegeList.parts'

function unknownPrivilege(key: string): Privilege {
  const [namespace = key, domain = '?', verb = '?'] = key.split('.')
  return {
    key, namespace, domain, verb,
    label: key, description: null,
    is_ou_scopable: false, is_orphan: true,
  }
}

export interface PrivilegeGroup { domain: string; items: Privilege[] }

export function groupPrivileges(keys: string[], catalogue: Privilege[]): PrivilegeGroup[] {
  const byKey = new Map(catalogue.map(p => [p.key, p]))
  const groups = new Map<string, Privilege[]>()
  for (const key of keys) {
    const priv = byKey.get(key) ?? unknownPrivilege(key)
    const bucket = groups.get(priv.domain)
    if (bucket) bucket.push(priv)
    else groups.set(priv.domain, [priv])
  }
  return [...groups.entries()].map(([domain, items]) => ({ domain, items }))
}

export interface PrivilegeListProps {
  /** Keys to render. In the editor this is the whole catalogue. */
  keys:      string[]
  catalogue: Privilege[]
  /** Present → checkable editor; absent → read-only display. */
  selected?: Set<string>
  onToggle?: (key: string) => void
  /** Bleed the bands to a `px-5` parent's edges, like the surrounding cards. */
  bleed?:    boolean
}

export class PrivilegeList extends ViewBase {
  domainLabel!: (domain: string) => string
  privilegeLabel!: PrivilegeListStores['privilegeLabel']
  groups!: PrivilegeGroup[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { domainLabel, privilegeLabel } = useAuthzLabels()
    return { t, domainLabel, privilegeLabel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const groups = useMemo(() => groupPrivileges(this.props.keys, this.props.catalogue), [this.props.keys, this.props.catalogue])
    this.publish({ groups })
    return { groups }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ domainLabel: s.domainLabel, privilegeLabel: s.privilegeLabel })
    const h = this.useHooks()
    this.publish({ groups: h.groups })
  }

  get bleed() {
    return this.props.bleed ?? false
  }

  get editing(): boolean {
    return !!this.props.selected && !!this.props.onToggle
  }

  get pad(): "px-5" | "px-3" {
    if (!(!(this.groups.length === 0))) return undefined as never
    return this.bleed ? 'px-5' : 'px-3'
  }

  get show_case_1() {
    return !!(this.groups.length === 0)
  }

  get show_main() {
    return !(this.groups.length === 0)
  }

  get div_class() {
    if (!(!(this.groups.length === 0))) return undefined as never
    return this.bleed ? '-mx-5' : ''
  }

  get p_class() {
    if (!(!(this.groups.length === 0))) return undefined as never
    return `${this.pad} py-2 bg-surface-1 text-sm font-semibold text-text-primary`
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part1() {
    if (!(!(this.groups.length === 0))) return undefined as never
    return __parts.Part1
  }

  /** The rows of the Repeater over `groups`. */
  get rows_groups() {
    return this.memo('rows_groups', [this.groups, this.domainLabel, this.privilegeLabel, this.editing, this.props, this.pad], () => {
      if (!(!(this.groups.length === 0))) return undefined as never
      return this.groups.map((g) => {
      return { g, p_text: ((!(this.groups.length === 0))) ? (this.domainLabel(g.domain)) : undefined, part1_props: ((!(this.groups.length === 0))) ? ({ g: g, privilegeLabel: this.privilegeLabel, editing: this.editing, onToggle: this.props.onToggle, pad: this.pad, selected: this.props.selected }) : undefined, key: g.domain }
    })
    })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type PrivilegeListStores = ReturnType<PrivilegeList['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type PrivilegeListHooks = ReturnType<PrivilegeList['useHooks']>

export default PrivilegeList.component()
