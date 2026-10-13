/**
 * Code-behind of `ScopeEditor.kbcontrol` (converted from `ScopeEditor.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { Plus } from "lucide-react"
import { Button, Combobox, MenuDropdown, useMenuDropdown, type MenuItem } from "@ui"
import type { Scope, ScopeRef } from "./types"
import type { Directory } from "./useDirectory"

import { ViewBase } from './ScopeEditor.kbcontrol'
import * as __parts from './ScopeEditor.parts'
import { RefRow } from './ScopeEditor.parts'

interface Props {
  value:     Scope
  onChange:  (next: Scope) => void
  dir:       Directory
  maxRefs:   number
  disabled?: boolean
}

type Bucket = 'include' | 'exclude'

function refKey(r: ScopeRef): string {
  return `${r.type}:${r.id}`
}

export type { Props }

export class ScopeEditor extends ViewBase {
  tr!: ScopeEditorStores['t']
  includeMenu!: ScopeEditorStores['includeMenu']
  excludeMenu!: ScopeEditorStores['excludeMenu']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const includeMenu = useMenuDropdown()
    const excludeMenu = useMenuDropdown()
    return { t, includeMenu, excludeMenu }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, includeMenu: s.includeMenu, excludeMenu: s.excludeMenu })
  }

  get total(): number {
    return (this.props.value.include?.length ?? 0) + (this.props.value.exclude?.length ?? 0)
  }

  get full(): boolean {
    return this.total >= this.props.maxRefs
  }

  get userOptions(): { value: string; label: string; description: string; keywords: string; }[] {
    return this.memo('userOptions', [this.props], () => this.props.dir.users.map(u => ({
    value: u.id,
    label: u.display_name || u.username,
    description: u.email,
    keywords: `${u.username} ${u.email}`,
  })))
  }

  get show_value_include() {
    return (this.props.value.include?.length ?? 0) === 0
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.props, this.tr, this.full, this.userOptions, this.includeMenu], () => ({ Bucket: this.memo("Bucket:bound", [], () => this.Bucket.bind(this)), includeMenu: this.includeMenu }))
  }

  /** A part of the screen still written in React (<Bucket> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.memo, this.props, this.tr, this.full, this.userOptions, this.excludeMenu], () => ({ Bucket: this.memo("Bucket:bound", [], () => this.Bucket.bind(this)), excludeMenu: this.excludeMenu }))
  }

  /** A part of the screen still written in React (<Bucket> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    return __parts.Part2
  }

  get p_text() {
    return this.memo('p_text', [this.tr, this.total, this.props], () => this.tr('admin.rl_scope_counter', { used: this.total, max: this.props.maxRefs }) + " · " + this.tr('admin.rl_scope_exclusion_wins'))
  }

  add(bucket: Bucket, ref: ScopeRef) {
    const list = this.props.value[bucket] ?? []
    if (list.some(r => refKey(r) === refKey(ref))) return
    this.props.onChange({ ...this.props.value, [bucket]: [...list, ref] })
  }

  remove(bucket: Bucket, key: string) {
    return this.props.onChange({ ...this.props.value, [bucket]: (this.props.value[bucket] ?? []).filter(r => refKey(r) !== key) })
  }

  buildMenu(bucket: Bucket): MenuItem[] {
    const used = new Set([...(this.props.value[bucket] ?? [])].map(refKey))
    const units = this.props.dir.units.filter(u => !used.has(`org_unit:${u.id}`))
    const groups = this.props.dir.groups.filter(g => !used.has(`group:${g.id}`))
    const items: MenuItem[] = []
    if (units.length) {
      items.push({ type: 'label', text: this.tr('admin.rl_ref_kind_org_unit') })
      for (const u of units.slice(0, 40)) {
        items.push({
          type: 'action', label: u.name, disabled: this.full,
          onClick: () => this.add(bucket, { type: 'org_unit', id: u.id, descendants: true }),
        })
      }
    }
    if (groups.length) {
      items.push({ type: 'separator' })
      items.push({ type: 'label', text: this.tr('admin.rl_ref_kind_group') })
      for (const g of groups.slice(0, 40)) {
        items.push({
          type: 'action', label: g.name, disabled: this.full,
          onClick: () => this.add(bucket, { type: 'group', id: g.id }),
        })
      }
    }
    if (items.length === 0) items.push({ type: 'label', text: this.tr('admin.rl_scope_nothing_to_add') })
    return items
  }

  Bucket({ bucket, menu }: { bucket: Bucket; menu: ReturnType<typeof useMenuDropdown> }) {
    const disabled = this.props.disabled
    return (
    <div className="min-w-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <h4 className="text-text-primary">{this.tr(`admin.rl_scope_${bucket}`)}</h4>
        <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {this.tr(`admin.rl_scope_${bucket}_hint`)}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {(this.props.value[bucket] ?? []).map(r => (
          <RefRow key={refKey(r)} r={r} dir={this.props.dir} disabled={disabled}
            onRemove={() => this.remove(bucket, refKey(r))}
            onToggleDescendants={r.type === 'org_unit'
              ? (v => this.props.onChange({
                ...this.props.value,
                [bucket]: (this.props.value[bucket] ?? []).map(x =>
                  refKey(x) === refKey(r) && x.type === 'org_unit' ? { ...x, descendants: v } : x),
              }))
              : undefined} />
        ))}
      </div>
      {!disabled && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" icon={<Plus size={14} />} disabled={this.full}
            onClick={e => menu.open(e)}>
            {this.tr('admin.rl_scope_add_unit_group')}
          </Button>
          <Combobox
            value={null}
            onChange={id => this.add(bucket, { type: 'user', id })}
            options={this.userOptions}
            placeholder={this.tr('admin.rl_scope_add_user')}
            disabled={this.full || this.userOptions.length === 0}
            width={240}
            aria-label={this.tr('admin.rl_scope_add_user')}
          />
        </div>
      )}
      {menu.pos && <MenuDropdown pos={menu.pos} items={this.buildMenu(bucket)} onClose={menu.close} />}
    </div>
  )
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ScopeEditorStores = ReturnType<ScopeEditor['useStores']>

export default ScopeEditor.component()
