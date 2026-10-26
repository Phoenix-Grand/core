/**
 * Code-behind of `ServicePicker.kbcontrol` (converted from `ServicePicker.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { MyExportService } from "./api"
import { exportServiceLabel, exportServiceDescription } from "../../../dataExport/labels"

import { ViewBase } from './ServicePicker.kbcontrol'
import * as __parts from './ServicePicker.parts'

export interface ServicePickerProps {
  services: MyExportService[]
  /** Ids currently kept. Required services are always in it. */
  selected: Set<string>
  onChange: (next: Set<string>) => void
}

interface Group {
  moduleId: string
  /** The label shown for the group: the module's single service, or its id. */
  label:    string
  items:    MyExportService[]
}

function moduleName(moduleId: string): string {
  return moduleId.charAt(0).toUpperCase() + moduleId.slice(1)
}

function groupByModule(services: MyExportService[]): Group[] {
  const out: Group[] = []
  for (const service of services) {
    const existing = out.find(g => g.moduleId === service.module_id)
    if (existing) existing.items.push(service)
    else out.push({ moduleId: service.module_id, label: service.label, items: [service] })
  }
  return out
}

export class ServicePicker extends ViewBase {
  tr!: ServicePickerStores['t']
  groups!: Group[]
  unfolded!: Set<string>
  setUnfolded!: ServicePickerStores['setUnfolded']
  required!: string[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
    return { t, unfolded, setUnfolded }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const groups = useMemo(() => groupByModule(this.props.services.map(service => ({
      ...service,
      label: exportServiceLabel(this.tr, service, 'self'),
      description: exportServiceDescription(this.tr, service, 'self'),
    }))), [this.props.services, this.tr])
    this.publish({ groups })
    const required = useMemo(
      () => this.props.services.filter(s => s.required).map(s => s.id),
      [this.props.services],
    )
    this.publish({ required })
    return { groups, required }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, unfolded: s.unfolded, setUnfolded: s.setUnfolded })
    const h = this.useHooks()
    this.publish({ groups: h.groups, required: h.required })
  }

  /** A part of the screen still written in React (<button aria-expanded>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part2() {
    return __parts.Part2
  }

  /** The rows of the Repeater over `groups`. */
  get rows_groups() {
    return this.memo('rows_groups', [this.groups, this.props, this.unfolded, this.memo, this.setUnfolded, this.tr, this.required], () => this.groups.map((group) => {
      const ids = group.items.map(s => s.id)
      const kept = ids.filter(id => this.props.selected.has(id))
      const all = kept.length === ids.length
      const some = kept.length > 0 && !all
      const splittable = group.items.length > 1
      const open = this.unfolded.has(group.moduleId)
      const head = group.items[0]
      return { group, ids, kept, all, some, splittable, open, head, check_state: ({"true":"Indeterminate","false":"Unchecked"} as Record<string, string>)[String(some)], enabled_unless_group_items_every: !(group.items.every(s => s.required)), p_text: splittable ? moduleName(group.moduleId) : head.label, show_splittable_head_description: !!(!splittable && (head.description || head.format)), p_text2: ((!splittable && (head.description || head.format))) ? (String(head.description ?? '') + String(head.description && head.format ? ' · ' : '') + String(head.format ?? '')) : undefined, part1_props: ((splittable)) ? ({ toggleFold: this.memo("toggleFold:bound", [], () => this.toggleFold.bind(this)), group: group, open: open, t: this.tr }) : undefined, show_splittable_open: splittable && open, part2_props: ((splittable && open)) ? ({ group: group, selected: this.props.selected, toggle: this.memo("toggle:bound", [], () => this.toggle.bind(this)) }) : undefined, key: group.moduleId }
    }))
  }

  setAll(keepAll: boolean) {
    this.props.onChange(new Set(keepAll ? this.props.services.map(s => s.id) : this.required))
  }

  toggle(ids: string[], keep: boolean) {
    const next = new Set(this.props.selected)
    for (const id of ids) {
      if (keep) next.add(id)
      else if (!this.required.includes(id)) next.delete(id)
    }
    this.props.onChange(next)
  }

  toggleFold(moduleId: string) {
    this.setUnfolded(prev => {
      const next = new Set(prev)
      if (next.has(moduleId)) next.delete(moduleId)
      else next.add(moduleId)
      return next
    })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.setAll(true)
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    this.setAll(false)
  }

  check_box_checked_changed(_sender: unknown, args: ValueChangedEventArgs) {
    const { ids } = args.row as RowOf_rows_groups
    const next = args.value as boolean
    this.toggle(ids, next)
  }

}

type RowOf_rows_groups = ServicePicker['rows_groups'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ServicePickerStores = ReturnType<ServicePicker['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ServicePickerHooks = ReturnType<ServicePicker['useHooks']>

export default ServicePicker.component()
