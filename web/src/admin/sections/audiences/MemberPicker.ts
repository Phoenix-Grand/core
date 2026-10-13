/**
 * Code-behind of `MemberPicker.kbview` (converted from `MemberPicker.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { foldIncludes } from "@ui"
import { api } from "../../../core/api/client"
import type { AudienceMember } from "./api"

import { ViewBase } from './MemberPicker.kbview'
import * as __parts from './MemberPicker.parts'

interface Candidate {
  member_type: 'user' | 'group'
  member_id:   string
  label:       string
  sub:         string | null
  /** Active accounts a group brings in. Null for an individual account. */
  reach:       number | null
}

export type MemberPickerProps = {
  already:  AudienceMember[]
  busy:     boolean
  error?:   string
  onAdd:    (members: { member_type: string; member_id: string }[]) => void
  onCancel: () => void
}

export class MemberPicker extends ViewBase {
  @bind accessor q = ''
  @bind accessor picked: Record<string, Candidate> = {}
  tr!: MemberPickerStores['t']
  groups!: MemberPickerStores['groups']
  users!: MemberPickerStores['users']
  shown!: Candidate[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const groups = useQuery({
      queryKey: ['admin', 'groups'],
      queryFn: async () => (await api.get<{ groups: { id: string; name: string; member_count: number }[] }>('/admin/groups')).data.groups,
    })
    const users = useQuery({
      queryKey: ['admin', 'users', 'picker'],
      queryFn: async () => (await api.get<{ users: { id: string; email: string; display_name: string | null; username: string; is_active: boolean }[] }>('/admin/users?limit=500')).data.users,
    })
    return { t, groups, users }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const groups = this.groups
    const users = this.users
    const taken = useMemo(
      () => new Set(this.props.already.map(m => `${m.member_type}:${m.member_id}`)),
      [this.props.already],
    )
    const candidates = useMemo<Candidate[]>(() => {
      const g: Candidate[] = (groups.data ?? []).map(x => ({
        member_type: 'group', member_id: x.id, label: x.name, sub: null, reach: x.member_count,
      }))
      const u: Candidate[] = (users.data ?? [])
        .filter(x => x.is_active)
        .map(x => ({
          member_type: 'user', member_id: x.id,
          label: x.display_name || x.username, sub: x.email, reach: null,
        }))
      return [...g, ...u].filter(c => !taken.has(`${c.member_type}:${c.member_id}`))
    }, [groups.data, users.data, taken])
    const shown = useMemo(
      () => (this.q.trim()
        ? candidates.filter(c => foldIncludes(c.label, this.q) || (c.sub ? foldIncludes(c.sub, this.q) : false))
        : candidates),
      [candidates, this.q],
    )
    this.publish({ shown })
    return { taken, candidates, shown }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, groups: s.groups, users: s.users })
    const h = this.useHooks()
    this.publish({ shown: h.shown })
  }

  get chosen(): Candidate[] {
    return this.memo('chosen', [this.picked], () => Object.values(this.picked))
  }

  get addedReach(): number {
    return this.chosen.reduce((n, c) => n + (c.reach ?? 1), 0)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props, this.chosen, this.addedReach, this.q, this.memo, this.shown, this.picked], () => ({ t: this.tr, onCancel: this.props.onCancel, chosen: this.chosen, addedReach: this.addedReach, onAdd: this.props.onAdd, busy: this.props.busy, q: this.q, setQ: this.memo("setQ:bound", [], () => this.setQ.bind(this)), shown: this.shown, picked: this.picked, toggle: this.memo("toggle:bound", [], () => this.toggle.bind(this)), error: this.props.error }))
  }

  /** A part of the screen still written in React (<FloatingWindow> actions.extra: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  toggle(c: Candidate) {
    this.picked = ((p) => {
    const k = `${c.member_type}:${c.member_id}`
    const next = { ...p }
    if (next[k]) delete next[k]; else next[k] = c
    return next
  })(this.picked)
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  /** `setQ` of the TSX: a value, or an update of the previous one. */
  setQ(value: MemberPicker['q'] | ((prev: MemberPicker['q']) => MemberPicker['q'])) {
    this.q = typeof value === 'function' ? (value as (prev: MemberPicker['q']) => MemberPicker['q'])(this.q) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type MemberPickerStores = ReturnType<MemberPicker['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type MemberPickerHooks = ReturnType<MemberPicker['useHooks']>

export default MemberPicker.component()
