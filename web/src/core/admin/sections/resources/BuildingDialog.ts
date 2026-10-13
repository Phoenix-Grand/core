/**
 * Code-behind of `BuildingDialog.kbview` (converted from `BuildingDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { SlotRegistry } from "../../../slots/SlotRegistry"
import { useModulesStore } from "../../../store/modulesStore"
import { GEO_POINT_FIELD, type GeoPointFieldProps } from "../../geoPointField"
import { errorMessage, useCreateBuilding, useUpdateBuilding, type Building, type BuildingInput } from "./api"

import { ViewBase } from './BuildingDialog.kbview'
import * as __parts from './BuildingDialog.parts'

const orNull = (v: string) => {
  const s = v.trim()
  return s === '' ? null : s
}

function coordinate(v: string): number | null {
  const s = v.trim().replace(',', '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export type BuildingDialogProps = {
  /** `null` opens an empty sheet. */
  building:  Building | null
  floorMax:  number
  onClose:   () => void
}

export class BuildingDialog extends ViewBase {
  @bind accessor error: string | null = null
  tr!: BuildingDialogStores['t']
  key!: BuildingDialogHooks['key']
  setKey!: BuildingDialogHooks['setKey']
  name!: BuildingDialogHooks['name']
  setName!: BuildingDialogHooks['setName']
  address!: BuildingDialogHooks['address']
  setAddress!: BuildingDialogHooks['setAddress']
  note!: BuildingDialogHooks['note']
  setNote!: BuildingDialogHooks['setNote']
  lat!: BuildingDialogHooks['lat']
  setLat!: BuildingDialogHooks['setLat']
  lon!: BuildingDialogHooks['lon']
  setLon!: BuildingDialogHooks['setLon']
  floors!: string[]
  setFloors!: BuildingDialogHooks['setFloors']
  create!: BuildingDialogStores['create']
  update!: BuildingDialogStores['update']
  GeoPoint!: BuildingDialogStores['GeoPoint']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const create = useCreateBuilding()
    const update = useUpdateBuilding()
    const { activeModules, loadedVersion } = useModulesStore()
    const GeoPoint = useMemo(
      () => SlotRegistry.getActiveOverride<GeoPointFieldProps>(
        GEO_POINT_FIELD,
        new Set(activeModules.map(m => m.module_id)),
      ),
      [activeModules, loadedVersion],
    )
    return { t, create, update, activeModules, loadedVersion, GeoPoint }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [key,     setKey]     = useState<string>(this.props.building?.building_key ?? '')
    this.publish({ key, setKey })
    const [name,    setName]    = useState<string>(this.props.building?.name ?? '')
    this.publish({ name, setName })
    const [address, setAddress] = useState<string>(this.props.building?.address ?? '')
    this.publish({ address, setAddress })
    const [note,    setNote]    = useState<string>(this.props.building?.description ?? '')
    this.publish({ note, setNote })
    const [lat,     setLat]     = useState<string>(this.props.building?.latitude?.toString() ?? '')
    this.publish({ lat, setLat })
    const [lon,     setLon]     = useState<string>(this.props.building?.longitude?.toString() ?? '')
    this.publish({ lon, setLon })
    const [floors,  setFloors]  = useState<string[]>(this.props.building?.floors ?? [''])
    this.publish({ floors, setFloors })
    return { key, setKey, name, setName, address, setAddress, note, setNote, lat, setLat, lon, setLon, floors, setFloors }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, create: s.create, update: s.update, GeoPoint: s.GeoPoint })
    const h = this.useHooks()
    this.publish({ key: h.key, setKey: h.setKey, name: h.name, setName: h.setName, address: h.address, setAddress: h.setAddress, note: h.note, setNote: h.setNote, lat: h.lat, setLat: h.setLat, lon: h.lon, setLon: h.setLon, floors: h.floors, setFloors: h.setFloors })
  }

  get busy(): boolean {
    return this.create.isPending || this.update.isPending
  }

  get enabled_unless_busy() {
    return !(this.busy)
  }

  get show_error() {
    return !!(this.error)
  }

  get show_not_error() {
    return !(this.error)
  }

  get title() {
    return this.props.building ? this.tr('admin.res_building_edit') : this.tr('admin.res_building_new')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.key, this.props, this.setKey], () => ({ t: this.tr, key: this.key, building: this.props.building, setKey: this.setKey }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.address, this.setAddress], () => ({ t: this.tr, address: this.address, setAddress: this.setAddress }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get show_building_building_resource() {
    return !!(this.props.building && this.props.building.resource_count > 0)
  }

  get res_building_rename_warning_count() {
    if (!(this.props.building && this.props.building.resource_count > 0)) return undefined as never
    return this.props.building.resource_count
  }

  get show_geo_point() {
    return this.memo('show_geo_point', [this.GeoPoint], () => !!(this.GeoPoint))
  }

  get show_not_geo_point() {
    return this.memo('show_not_geo_point', [this.GeoPoint], () => !(this.GeoPoint))
  }

  get part3_props() {
    return this.memo('part3_props', [this.GeoPoint, this.lat, this.lon, this.address, this.busy, this.setLat, this.setLon], () => {
      if (!(this.GeoPoint)) return undefined as never
      return ({ GeoPoint: this.GeoPoint, lat: this.lat, lon: this.lon, address: this.address, busy: this.busy, setLat: this.setLat, setLon: this.setLon })
    })
  }

  /** A part of the screen still written in React (<GeoPoint> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    if (!(this.GeoPoint)) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.tr, this.lat, this.setLat, this.GeoPoint], () => {
      if (!(!(this.GeoPoint))) return undefined as never
      return ({ t: this.tr, lat: this.lat, setLat: this.setLat })
    })
  }

  /** A part of the screen still written in React (<TextField> inputMode: no .kbview property). */
  get Part4() {
    if (!(!(this.GeoPoint))) return undefined as never
    return __parts.Part4
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.lon, this.setLon, this.GeoPoint], () => {
      if (!(!(this.GeoPoint))) return undefined as never
      return ({ t: this.tr, lon: this.lon, setLon: this.setLon })
    })
  }

  /** A part of the screen still written in React (<TextField> inputMode: no .kbview property). */
  get Part5() {
    if (!(!(this.GeoPoint))) return undefined as never
    return __parts.Part5
  }

  get part6_props() {
    return this.memo('part6_props', [this.tr, this.note, this.setNote], () => ({ t: this.tr, note: this.note, setNote: this.setNote }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part6() {
    return __parts.Part6
  }

  async submit() {
    this.error = null
    const input: BuildingInput = {
      building_key: this.key.trim(),
      name:         orNull(this.name),
      address:      this.address.trim(),
      description:  orNull(this.note),
      latitude:     coordinate(this.lat),
      longitude:    coordinate(this.lon),
      // Blank rows are dropped here rather than refused: an empty field is
      // somebody who added a row and changed their mind, not an error.
      floors:       this.floors.map(f => f.trim()).filter(Boolean),
    }
    try {
      if (this.props.building) await this.update.mutateAsync({ id: this.props.building.id, input })
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
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setName(e.target.value)
  }

  /** `<FloorsField OnChange>`: the floors list changed. */
  floors_field_change(_sender: unknown, args: ValueChangedEventArgs) {
    this.setFloors(args.value as string[])
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type BuildingDialogStores = ReturnType<BuildingDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type BuildingDialogHooks = ReturnType<BuildingDialog['useHooks']>

export default BuildingDialog.component()
