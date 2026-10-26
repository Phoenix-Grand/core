import { useTranslation } from 'react-i18next'
/**
 * Code-behind of `LabelsPage.kbview` (converted from `LabelsPage.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { LabelIcon } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../hooks/useConfirm"
import { labelsApi, type CoreLabel, type LabelBrowseItem } from "../api/labels"
import { DataCardView } from "../registry/DataCardView"
import LabelShareDialog from "../components/LabelShareDialog"

import { ViewBase } from './LabelsPage.kbview'
import * as __parts from './LabelsPage.parts.tsx'

const PALETTE = ['#1a73e8', '#1e8e3e', '#d93025', '#f9ab00', '#9334e6', '#e8710a', '#12805c', '#5f6368']

export class LabelsPage extends ViewBase {
  tr!: ReturnType<typeof useTranslation>['t']

  @bind accessor labels: CoreLabel[] = []
  @bind accessor items: LabelBrowseItem[] = []
  @bind accessor query = ''
  @bind accessor moduleFilter = ''
  @bind accessor newName = ''
  @bind accessor loading = true
  @bind accessor sharing: CoreLabel | null = null
  navigate!: LabelsPageStores['navigate']
  selected!: Set<string>
  setSelected!: LabelsPageStores['setSelected']
  confirm!: LabelsPageStores['confirm']
  confirmState!: LabelsPageStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  refreshLabels!: () => void
  modules!: string[]
  byId!: Map<string, CoreLabel>
  moduleOptions!: { value: string; label: string; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const navigate = useNavigate()
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { navigate, selected, setSelected, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const selected = this.selected
    const refreshLabels = useCallback(() => { labelsApi.list().then(this.memo("setLabels:bound", [], () => this.setLabels.bind(this))).catch(() => {}) }, [])
    this.publish({ refreshLabels })
    useEffect(() => { refreshLabels() }, [refreshLabels])
    useEffect(() => {
      this.loading = true
      const t = setTimeout(() => {
        labelsApi.browse({ labels: [...selected], q: this.query, module: this.moduleFilter })
          .then(this.memo("setItems:bound", [], () => this.setItems.bind(this)))
          .catch(() => this.items = [])
          .finally(() => this.loading = false)
      }, 200)
      return () => clearTimeout(t)
    }, [selected, this.query, this.moduleFilter])
    const modules = useMemo(() => [...new Set(this.items.map(i => i.module))].sort(), [this.items])
    this.publish({ modules })
    const byId = useMemo(() => new Map(this.labels.map(l => [l.id, l])), [this.labels])
    this.publish({ byId })
    const moduleOptions = useMemo(
      () => [{ value: '', label: this.tr('labels.all_modules') }, ...modules.map(m => ({ value: m, label: m }))],
      [modules, this.tr],
    )
    this.publish({ moduleOptions })
    return { refreshLabels, modules, byId, moduleOptions }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.publish({ tr: useTranslation().t })
    const s = this.useStores()
    this.publish({ navigate: s.navigate, selected: s.selected, setSelected: s.setSelected, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ refreshLabels: h.refreshLabels, modules: h.modules, byId: h.byId, moduleOptions: h.moduleOptions })
  }

  /** `<LabelIcon>`, rendered by a ReactHost. */
  get LabelIcon() {
    return LabelIcon
  }

  get label_icon_props() {
    return this.memo('label_icon_props', [], () => ({ size: 15, className: "text-primary" }))
  }

  get enabled_unless_new_name_trim() {
    return !(!this.newName.trim())
  }

  /** `<LabelRow>`, rendered by a ReactHost. */
  get LabelRow() {
    return __parts.LabelRow
  }

  /** The rows of the Repeater over `labels`. */
  get rows_labels() {
    return this.memo('rows_labels', [this.labels, this.selected, this.setSelected, this.refreshLabels, this.sharing, this.confirm], () => this.labels.map((l) => {
      return { l, label_row_props: { label: l, active: this.selected.has(l.id), onToggle: () => this.toggle(l.id), onChanged: this.refreshLabels, onShare: () => this.sharing = l, confirm: this.confirm } as React.ComponentProps<typeof __parts.LabelRow>, key: l.id }
    }))
  }

  get show_labels() {
    return !this.labels.length
  }

  get part1_props() {
    return this.memo('part1_props', [this.query, this.memo], () => ({ query: this.query, setQuery: this.memo("setQuery:bound", [], () => this.setQuery.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextField LeftIcon>: an icon size the element cannot take). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.moduleFilter, this.memo, this.moduleOptions], () => ({ moduleFilter: this.moduleFilter, setModuleFilter: this.memo("setModuleFilter:bound", [], () => this.setModuleFilter.bind(this)), moduleOptions: this.moduleOptions }))
  }

  /** A part of the screen still written in React (<Dropdown> height, width: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.selected, this.byId, this.memo, this.setSelected], () => ({ selected: this.selected, byId: this.byId, toggle: this.memo("toggle:bound", [], () => this.toggle.bind(this)) }))
  }

  /** A part of the screen still written in React (a list whose item is not a single element). */
  get Part3() {
    return __parts.Part3
  }

  get show_not_loading() {
    return !(this.loading)
  }

  get show_items() {
    if (!(!(this.loading))) return undefined as never
    return !this.items.length
  }

  get show_not_items() {
    if (!(!(this.loading))) return undefined as never
    return !(!this.items.length)
  }

  /** `<DataCardView>`, rendered by a ReactHost. */
  get DataCardView() {
    if (!(!(this.loading)) || !(!(!this.items.length))) return undefined as never
    return DataCardView
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part4() {
    if (!(!(this.loading)) || !(!(!this.items.length))) return undefined as never
    return __parts.Part4
  }

  /** The rows of the Repeater over `items`. */
  get rows_items() {
    return this.memo('rows_items', [this.items, this.loading, this.byId, this.memo, this.setSelected, this.tr], () => {
      if (!(!(this.loading)) || !(!(!this.items.length))) return undefined as never
      return this.items.map((item) => {
      return { item, show_item_envelope: ((!(this.loading)) && (!(!this.items.length))) ? (!!(item.envelope)) : undefined, show_not_item_envelope: ((!(this.loading)) && (!(!this.items.length))) ? (!(item.envelope)) : undefined, data_card_view_props: ((!(this.loading)) && (!(!this.items.length)) && (item.envelope)) ? ({ envelope: item.envelope }) : undefined, p_text: ((!(this.loading)) && (!(!this.items.length)) && (!(item.envelope))) ? (item.title ?? item.resource_id) : undefined, p_text2: ((!(this.loading)) && (!(!this.items.length)) && (!(item.envelope))) ? (String(item.module) + " · " + String(item.resource_type)) : undefined, part4_props: ((!(this.loading)) && (!(!this.items.length))) ? ({ item: item, byId: this.byId, toggle: this.memo("toggle:bound", [], () => this.toggle.bind(this)) }) : undefined, show_item_other_owners: ((!(this.loading)) && (!(!this.items.length))) ? (!!item.other_owners.length) : undefined, p_text3: ((!(this.loading)) && (!(!this.items.length)) && (!!item.other_owners.length)) ? (this.tr('labels.labeled_by', { names: item.other_owners.join(', ') })) : undefined, key: `${item.resource_type}:${item.resource_id}` }
    })
    })
  }

  get visible() {
    return this.memo('visible', [this.show_items, this.show_not_loading], () => this.show_items && this.show_not_loading)
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_items, this.show_not_loading], () => this.show_not_items && this.show_not_loading)
  }

  get show_sharing() {
    return this.memo('show_sharing', [this.sharing], () => !!(this.sharing))
  }

  /** `<LabelShareDialog>`, rendered by a ReactHost. */
  get LabelShareDialog() {
    if (!(this.sharing)) return undefined as never
    return LabelShareDialog
  }

  get label_share_dialog_props() {
    return this.memo('label_share_dialog_props', [this.sharing, this.refreshLabels], () => {
      if (!(this.sharing)) return undefined as never
      return ({ label: this.sharing, onClose: () => this.sharing = null, onSaved: this.refreshLabels } as React.ComponentProps<typeof LabelShareDialog>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState], () => !!(this.confirmState))
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel], () => {
      if (!(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  toggle(id: string) {
    return this.setSelected(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  }

  async createLabel() {
    const name = this.newName.trim()
    if (!name) return
    try {
      await labelsApi.create(name, PALETTE[this.labels.length % PALETTE.length])
      this.newName = ''
      this.refreshLabels()
    } catch { /* conflict: keep input */ }
  }

  text_field_key_down(_sender: unknown, args: EventArgs) {
    const e = args.native as React.KeyboardEvent<HTMLInputElement>
 if (e.key === 'Enter') this.createLabel() }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { item } = args.row as RowOf_rows_items
    if (!(!(this.loading)) || !(!(!this.items.length)) || !(!((args.row as RowOf_rows_items).item.envelope))) return undefined as never
 if (item.href) this.navigate(item.href) }

  /** `setLabels` of the TSX: a value, or an update of the previous one. */
  setLabels(value: CoreLabel[] | ((prev: CoreLabel[]) => CoreLabel[])) {
    this.labels = typeof value === 'function' ? (value as (prev: CoreLabel[]) => CoreLabel[])(this.labels) : value
  }

  /** `setItems` of the TSX: a value, or an update of the previous one. */
  setItems(value: LabelBrowseItem[] | ((prev: LabelBrowseItem[]) => LabelBrowseItem[])) {
    this.items = typeof value === 'function' ? (value as (prev: LabelBrowseItem[]) => LabelBrowseItem[])(this.items) : value
  }

  /** `setQuery` of the TSX: a value, or an update of the previous one. */
  setQuery(value: LabelsPage['query'] | ((prev: LabelsPage['query']) => LabelsPage['query'])) {
    this.query = typeof value === 'function' ? (value as (prev: LabelsPage['query']) => LabelsPage['query'])(this.query) : value
  }

  /** `setModuleFilter` of the TSX: a value, or an update of the previous one. */
  setModuleFilter(value: LabelsPage['moduleFilter'] | ((prev: LabelsPage['moduleFilter']) => LabelsPage['moduleFilter'])) {
    this.moduleFilter = typeof value === 'function' ? (value as (prev: LabelsPage['moduleFilter']) => LabelsPage['moduleFilter'])(this.moduleFilter) : value
  }

}

type RowOf_rows_items = LabelsPage['rows_items'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type LabelsPageStores = ReturnType<LabelsPage['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type LabelsPageHooks = ReturnType<LabelsPage['useHooks']>

export default LabelsPage.component()
