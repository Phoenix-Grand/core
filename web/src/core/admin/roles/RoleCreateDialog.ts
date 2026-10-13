/**
 * Code-behind of `RoleCreateDialog.kbview` (converted from `RoleCreateDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "@ui"
import type { Privilege } from "../../authz/types"
import { errorMessage, useCreateRole } from "./api"

import { ViewBase } from './RoleCreateDialog.kbview'
import * as __parts from './RoleCreateDialog.parts'

function slugify(value: string): string {
  return value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

export type RoleCreateDialogProps = {
  catalogue: Privilege[]
  onClose:   () => void
}

export class RoleCreateDialog extends ViewBase {
  @bind accessor name = ''
  @bind accessor slug = ''
  @bind accessor slugTouched = false
  @bind accessor description = ''
  @bind accessor error = ''
  tr!: RoleCreateDialogStores['t']
  toast!: RoleCreateDialogStores['toast']
  selected!: Set<string>
  setSelected!: RoleCreateDialogStores['setSelected']
  keys!: string[]
  blockers!: string[]
  create!: RoleCreateDialogHooks['create']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const [selected, setSelected] = useState<Set<string>>(() => new Set())
    return { t, toast, selected, setSelected }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const toast = this.toast
    const selected = this.selected
    const keys = useMemo(() => this.props.catalogue.map(p => p.key), [this.props.catalogue])
    this.publish({ keys })
    const byKey = useMemo(() => new Map(this.props.catalogue.map(p => [p.key, p])), [this.props.catalogue])
    const blockers = useMemo(
      () => [...selected].filter(k => byKey.get(k) && !byKey.get(k)!.is_ou_scopable),
      [selected, byKey],
    )
    this.publish({ blockers })
    const create = useCreateRole(() => { toast.success(t('admin.role_created')); this.props.onClose() })
    this.publish({ create })
    return { keys, byKey, blockers, create }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, selected: s.selected, setSelected: s.setSelected })
    const h = this.useHooks()
    this.publish({ keys: h.keys, blockers: h.blockers, create: h.create })
  }

  get enabled_unless_name_trim() {
    return !(!this.name.trim())
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.memo, this.slugTouched, this.slug], () => ({ t: this.tr, name: this.name, setName: this.memo("setName:bound", [], () => this.setName.bind(this)), slugTouched: this.slugTouched, setSlug: this.memo("setSlug:bound", [], () => this.setSlug.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextField> label: an object value for a text property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.description, this.memo], () => ({ t: this.tr, description: this.description, setDescription: this.memo("setDescription:bound", [], () => this.setDescription.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../sections/resources/FieldLabel#default)). */
  get Part3() {
    return __parts.Part3
  }

  get show_blockers() {
    return this.blockers.length > 0
  }

  get show_not_blockers() {
    return !(this.blockers.length > 0)
  }

  get show_selected_size() {
    if (!(!(this.blockers.length > 0))) return undefined as never
    return this.selected.size > 0
  }

  get visible() {
    return this.memo('visible', [this.show_selected_size, this.show_not_blockers], () => this.show_selected_size && this.show_not_blockers)
  }

  get show_error() {
    return !!(this.error)
  }

  toggle(key: string) {
    return this.setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  /** `<PrivilegeList OnToggle>`: a privilege was toggled. */
  privilege_list_toggle(_sender: unknown, args: ValueChangedEventArgs) {
    this.toggle(args.value as string)
  }

  submit(e?: React.FormEvent) {
    e?.preventDefault()
    this.error = ''
    this.create.mutate(
      {
        name:        this.name.trim(),
        description: this.description.trim() || null,
        privileges:  [...this.selected],
        slug:        this.slug.trim() || slugify(this.name),
      },
      { onError: err => this.error = errorMessage(err, this.tr('admin.role_create_error')) },
    )
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    this.submit()
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.submit(args.native as never)
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
 this.slugTouched = true; this.slug = slugify(e.target.value) }

  /** `setName` of the TSX: a value, or an update of the previous one. */
  setName(value: RoleCreateDialog['name'] | ((prev: RoleCreateDialog['name']) => RoleCreateDialog['name'])) {
    this.name = typeof value === 'function' ? (value as (prev: RoleCreateDialog['name']) => RoleCreateDialog['name'])(this.name) : value
  }

  /** `setSlug` of the TSX: a value, or an update of the previous one. */
  setSlug(value: RoleCreateDialog['slug'] | ((prev: RoleCreateDialog['slug']) => RoleCreateDialog['slug'])) {
    this.slug = typeof value === 'function' ? (value as (prev: RoleCreateDialog['slug']) => RoleCreateDialog['slug'])(this.slug) : value
  }

  /** `setDescription` of the TSX: a value, or an update of the previous one. */
  setDescription(value: RoleCreateDialog['description'] | ((prev: RoleCreateDialog['description']) => RoleCreateDialog['description'])) {
    this.description = typeof value === 'function' ? (value as (prev: RoleCreateDialog['description']) => RoleCreateDialog['description'])(this.description) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type RoleCreateDialogStores = ReturnType<RoleCreateDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type RoleCreateDialogHooks = ReturnType<RoleCreateDialog['useHooks']>

export default RoleCreateDialog.component()
