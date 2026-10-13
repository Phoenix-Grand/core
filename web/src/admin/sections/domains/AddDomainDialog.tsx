/**
 * Code-behind of `AddDomainDialog.kbview` (converted from `AddDomainDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { errorMessage, useAddDomain, type Domain, type DomainKind } from "./api"

import { ViewBase } from './AddDomainDialog.kbview'
import * as __parts from './AddDomainDialog.parts'

export type AddDomainDialogProps = {
  /** Candidates an alias can hang off: verified, non-alias. */
  domains: Domain[]
  onClose: () => void
  /** Called with the new domain, so the page can open its verification screen. */
  onAdded: (domain: Domain) => void
}

export class AddDomainDialog extends ViewBase {
  @bind accessor name = ''
  @bind accessor kind: DomainKind = 'secondary'
  @bind accessor parent = ''
  @bind accessor error: string | null = null
  tr!: AddDomainDialogStores['t']
  add!: AddDomainDialogStores['add']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const add = useAddDomain()
    return { t, add }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, add: s.add })
  }

  get parents(): Domain[] {
    return this.memo('parents', [this.props], () => this.props.domains.filter(d => d.kind !== 'alias' && d.verified))
  }

  get enabled_unless_add_is_pending_name() {
    return !(this.add.isPending || this.name.trim() === '' || (this.kind === 'alias' && this.parent === ''))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.memo], () => ({ t: this.tr, name: this.name, setName: this.memo("setName:bound", [], () => this.setName.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.memo, this.kind, this.tr], () => ({ Choice: this.memo("Choice:bound", [], () => this.Choice.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<Choice> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Choice> is no .kbview element (a local or dynamic component)). */
  get Part4() {
    return __parts.Part4
  }

  get show_kind_alias() {
    return this.kind === 'alias'
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.kind], () => {
      if (!(this.kind === 'alias')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part5() {
    if (!(this.kind === 'alias')) return undefined as never
    return __parts.Part5
  }

  get show_parents() {
    if (!(this.kind === 'alias')) return undefined as never
    return this.parents.length === 0
  }

  get show_not_parents() {
    if (!(this.kind === 'alias')) return undefined as never
    return !(this.parents.length === 0)
  }

  get part6_props() {
    return this.memo('part6_props', [this.parent, this.tr, this.parents, this.memo, this.kind], () => {
      if (!(this.kind === 'alias') || !(!(this.parents.length === 0))) return undefined as never
      return ({ parent: this.parent, t: this.tr, parents: this.parents, setParent: this.memo("setParent:bound", [], () => this.setParent.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part6() {
    if (!(this.kind === 'alias') || !(!(this.parents.length === 0))) return undefined as never
    return __parts.Part6
  }

  get show_error() {
    return !!(this.error)
  }

  async submit() {
    this.error = null
    try {
      const created = await this.add.mutateAsync({
        name: this.name.trim(),
        kind: this.kind,
        parent_id: this.kind === 'alias' ? (this.parent || undefined) : undefined,
      })
      this.props.onClose()
      this.props.onAdded(created)
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.dom_save_failed'))
    }
  }

  Choice({ value, title, description }: { value: DomainKind; title: string; description: string }) {
    return (
    <label
      className={`flex cursor-pointer gap-3 rounded border p-3 transition-colors ${
        this.kind === value ? 'border-primary bg-primary-light' : 'border-border hover:bg-surface-1'
      }`}
    >
      <input
        type="radio"
        name="domain-kind"
        className="mt-1 accent-[var(--color-primary)]"
        checked={this.kind === value}
        onChange={() => this.kind = value}
      />
      <span className="min-w-0">
        <span className="block font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>{title}</span>
        <span className="block text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>{description}</span>
      </span>
    </label>
  )
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    void this.submit()
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  /** `setName` of the TSX: a value, or an update of the previous one. */
  setName(value: AddDomainDialog['name'] | ((prev: AddDomainDialog['name']) => AddDomainDialog['name'])) {
    this.name = typeof value === 'function' ? (value as (prev: AddDomainDialog['name']) => AddDomainDialog['name'])(this.name) : value
  }

  /** `setParent` of the TSX: a value, or an update of the previous one. */
  setParent(value: AddDomainDialog['parent'] | ((prev: AddDomainDialog['parent']) => AddDomainDialog['parent'])) {
    this.parent = typeof value === 'function' ? (value as (prev: AddDomainDialog['parent']) => AddDomainDialog['parent'])(this.parent) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AddDomainDialogStores = ReturnType<AddDomainDialog['useStores']>

export default AddDomainDialog.component()
