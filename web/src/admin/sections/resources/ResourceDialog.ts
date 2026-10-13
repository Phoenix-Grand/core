/**
 * Code-behind of `ResourceDialog.kbview` (converted from `ResourceDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { errorMessage, useBuildings, useCreateResource, useResourceFeatures, useUpdateResource, type Resource, type ResourceCategory, type ResourceInput } from "./api"

import { ViewBase } from './ResourceDialog.kbview'
import * as __parts from './ResourceDialog.parts'

const orNull = (v: string) => (v.trim() === '' ? null : v.trim())

export type ResourceDialogProps = {
  resource: Resource | null
  onClose:  () => void
}

export class ResourceDialog extends ViewBase {
  @bind accessor error: string | null = null
  tr!: ResourceDialogStores['t']
  buildings!: ResourceDialogStores['buildings']
  features!: ResourceDialogStores['features']
  name!: ResourceDialogHooks['name']
  setName!: ResourceDialogHooks['setName']
  category!: ResourceCategory
  setCategory!: ResourceDialogHooks['setCategory']
  kind!: ResourceDialogHooks['kind']
  setKind!: ResourceDialogHooks['setKind']
  buildingId!: ResourceDialogHooks['buildingId']
  setBuildingId!: ResourceDialogHooks['setBuildingId']
  floor!: ResourceDialogHooks['floor']
  setFloor!: ResourceDialogHooks['setFloor']
  section!: ResourceDialogHooks['section']
  setSection!: ResourceDialogHooks['setSection']
  capacity!: ResourceDialogHooks['capacity']
  setCapacity!: ResourceDialogHooks['setCapacity']
  releaseExempt!: ResourceDialogHooks['releaseExempt']
  setReleaseExempt!: ResourceDialogHooks['setReleaseExempt']
  visible!: ResourceDialogHooks['visible']
  setVisible!: ResourceDialogHooks['setVisible']
  note!: ResourceDialogHooks['note']
  setNote!: ResourceDialogHooks['setNote']
  chosen!: string[]
  setChosen!: ResourceDialogHooks['setChosen']
  create!: ResourceDialogStores['create']
  update!: ResourceDialogStores['update']
  buildingOptions!: { value: string; label: string; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const buildings = useBuildings()
    const features  = useResourceFeatures()
    const create = useCreateResource()
    const update = useUpdateResource()
    return { t, buildings, features, create, update }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [name,     setName]     = useState<string>(this.props.resource?.name ?? '')
    this.publish({ name, setName })
    const [category, setCategory] = useState<ResourceCategory>(this.props.resource?.category ?? 'meeting_room')
    this.publish({ category, setCategory })
    const [kind,     setKind]     = useState<string>(this.props.resource?.resource_type ?? '')
    this.publish({ kind, setKind })
    const [buildingId, setBuildingId] = useState<string>(this.props.resource?.building.id ?? '')
    this.publish({ buildingId, setBuildingId })
    const [floor,    setFloor]    = useState<string>(this.props.resource?.floor_name ?? '')
    this.publish({ floor, setFloor })
    const [section,  setSection]  = useState<string>(this.props.resource?.floor_section ?? '')
    this.publish({ section, setSection })
    const [capacity, setCapacity] = useState<number>(this.props.resource?.capacity ?? 1)
    this.publish({ capacity, setCapacity })
    const [releaseExempt, setReleaseExempt] = useState<boolean>(this.props.resource?.release_exempt ?? false)
    this.publish({ releaseExempt, setReleaseExempt })
    const [visible,  setVisible]  = useState<string>(this.props.resource?.user_description ?? '')
    this.publish({ visible, setVisible })
    const [note,     setNote]     = useState<string>(this.props.resource?.description ?? '')
    this.publish({ note, setNote })
    const [chosen,   setChosen]   = useState<string[]>(this.props.resource?.feature_ids ?? [])
    this.publish({ chosen, setChosen })
    const buildingOptions = useMemo(
      () => this.buildingList.map(b => ({
        value: b.id,
        label: b.name ? `${b.building_key} — ${b.name}` : b.building_key,
      })),
      [this.buildingList],
    )
    this.publish({ buildingOptions })
    return { name, setName, category, setCategory, kind, setKind, buildingId, setBuildingId, floor, setFloor, section, setSection, capacity, setCapacity, releaseExempt, setReleaseExempt, visible, setVisible, note, setNote, chosen, setChosen, buildingOptions }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, buildings: s.buildings, features: s.features, create: s.create, update: s.update })
    const h = this.useHooks()
    this.publish({ name: h.name, setName: h.setName, category: h.category, setCategory: h.setCategory, kind: h.kind, setKind: h.setKind, buildingId: h.buildingId, setBuildingId: h.setBuildingId, floor: h.floor, setFloor: h.setFloor, section: h.section, setSection: h.setSection, capacity: h.capacity, setCapacity: h.setCapacity, releaseExempt: h.releaseExempt, setReleaseExempt: h.setReleaseExempt, visible: h.visible, setVisible: h.setVisible, note: h.note, setNote: h.setNote, chosen: h.chosen, setChosen: h.setChosen, buildingOptions: h.buildingOptions })
  }

  get busy(): boolean {
    return this.create.isPending || this.update.isPending
  }

  get buildingList() {
    return this.memo('buildingList', [this.buildings], () => this.buildings.data?.buildings ?? [])
  }

  get building() {
    return this.memo('building', [this.buildingList, this.buildingId], () => this.buildingList.find(b => b.id === this.buildingId))
  }

  get floorOptions(): { value: string; label: string; }[] {
    return this.memo('floorOptions', [this.building], () => (this.building?.floors ?? []).map(f => ({ value: f, label: f })))
  }

  get noBuildings(): boolean {
    return !this.buildings.isLoading && this.buildingList.length === 0
  }

  get enabled_unless_busy_no_buildings() {
    return !(this.busy || this.noBuildings)
  }

  get title() {
    return this.props.resource ? this.tr('admin.res_resource_edit') : this.tr('admin.res_resource_new')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (./FieldLabel#default)). */
  get Part1() {
    return __parts.Part1
  }

  get div_text() {
    return this.props.resource?.generated_name ?? this.tr('admin.res_generated_pending')
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (./FieldLabel#default)). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.category, this.setCategory, this.setKind, this.tr], () => ({ category: this.category, setCategory: this.setCategory, setKind: this.setKind, t: this.tr }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  get span_text() {
    return this.category === 'meeting_room'
                ? this.tr('admin.res_category_room_hint')
                : this.tr('admin.res_category_other_hint')
  }

  get show_category_other() {
    return this.category === 'other'
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.name, this.props, this.setName], () => ({ t: this.tr, name: this.name, resource: this.props.resource, setName: this.setName }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part4() {
    return __parts.Part4
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (./FieldLabel#default)). */
  get Part5() {
    return __parts.Part5
  }

  get part6_props() {
    return this.memo('part6_props', [this.buildingId, this.setBuildingId, this.setFloor, this.buildingOptions, this.tr], () => ({ buildingId: this.buildingId, setBuildingId: this.setBuildingId, setFloor: this.setFloor, buildingOptions: this.buildingOptions, t: this.tr }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part6() {
    return __parts.Part6
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (./FieldLabel#default)). */
  get Part7() {
    return __parts.Part7
  }

  get part8_props() {
    return this.memo('part8_props', [this.floor, this.setFloor, this.floorOptions, this.tr, this.building], () => ({ floor: this.floor, setFloor: this.setFloor, floorOptions: this.floorOptions, t: this.tr, building: this.building }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part8() {
    return __parts.Part8
  }

  get show_category_meeting_room() {
    return this.category === 'meeting_room'
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (./FieldLabel#default)). */
  get Part9() {
    return __parts.Part9
  }

  get show_features_data_features() {
    return (this.features.data?.features ?? []).length === 0
  }

  get show_not_features_data_features() {
    return !((this.features.data?.features ?? []).length === 0)
  }

  /** The rows of the Repeater over `(features.data?.features ?? [])`. */
  get rows_items() {
    return this.memo('rows_items', [this.features, this.chosen], () => {
      if (!(!((this.features.data?.features ?? []).length === 0))) return undefined as never
      return (this.features.data?.features ?? []).map((f) => {
      return { f, checked: ((!((this.features.data?.features ?? []).length === 0))) ? (this.chosen.includes(f.id)) : undefined, key: f.id }
    })
    })
  }

  get part10_props() {
    return this.memo('part10_props', [this.tr, this.visible, this.setVisible], () => ({ t: this.tr, visible: this.visible, setVisible: this.setVisible }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part10() {
    return __parts.Part10
  }

  get part11_props() {
    return this.memo('part11_props', [this.tr, this.note, this.setNote], () => ({ t: this.tr, note: this.note, setNote: this.setNote }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part11() {
    return __parts.Part11
  }

  get show_error() {
    return !!(this.error)
  }

  async submit() {
    this.error = null
    const input: ResourceInput = {
      name:             this.name.trim(),
      building_id:      this.buildingId,
      category: this.category,
      resource_type:    this.category === 'other' ? orNull(this.kind) : null,
      floor_name:       this.floor,
      floor_section:    orNull(this.section),
      capacity: this.capacity,
      release_exempt: this.releaseExempt,
      user_description: orNull(this.visible),
      description:      orNull(this.note),
      feature_ids:      this.chosen,
    }
    try {
      if (this.props.resource) await this.update.mutateAsync({ id: this.props.resource.id, input })
      else          await this.create.mutateAsync(input)
      this.props.onClose()
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.res_save_failed'))
    }
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

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    if (!(this.category === 'other')) return undefined as never
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setKind(e.target.value)
  }

  text_field_text_changed2(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setSection(e.target.value)
  }

  numeric_field_value_changed(_sender: unknown, args: ValueChangedEventArgs) {
    this.setCapacity(args.value as never)
  }

  check_box_checked_changed(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(this.category === 'meeting_room')) return undefined as never
    this.setReleaseExempt(args.value as never)
  }

  check_box_checked_changed2(_sender: unknown, args: ValueChangedEventArgs) {
    const { f } = args.row as RowOf_rows_items
    if (!(!((this.features.data?.features ?? []).length === 0))) return undefined as never
    const on = args.value as boolean
    this.setChosen(on
                      ? [...this.chosen, f.id]
                      : this.chosen.filter(id => id !== f.id))
  }

}

type RowOf_rows_items = ResourceDialog['rows_items'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ResourceDialogStores = ReturnType<ResourceDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ResourceDialogHooks = ReturnType<ResourceDialog['useHooks']>

export default ResourceDialog.component()
