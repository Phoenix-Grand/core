/**
 * The parts of `ResourceDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Dropdown, Input, Textarea } from "@ui"
import FieldLabel from "./FieldLabel"
import { RequiredMark } from "@ui/RequiredMark"
import { type ResourceCategory } from "./api"
import type { ResourceDialog } from './ResourceDialog'

export function Part1({ t }: { t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.res_generated_name')}</FieldLabel>
  )
}

export function Part2({ t }: { t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.res_category')}</FieldLabel>
  )
}

export function Part3({ category, setCategory, setKind, t }: { category: NonNullable<ResourceDialog['category']>; setCategory: NonNullable<ResourceDialog['setCategory']>; setKind: NonNullable<ResourceDialog['setKind']>; t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <Dropdown
                  value={category}
                  onChange={v => {
                    const next = v as ResourceCategory
                    setCategory(next)
                    // A room has no type; keeping the old value would submit a
                    // combination the column refuses.
                    if (next === 'meeting_room') setKind('')
                  }}
                  options={[
                    { value: 'meeting_room', label: t('admin.res_category_room') },
                    { value: 'other',        label: t('admin.res_category_other') },
                  ]}
                  width="100%"
                  height={36}
                  focusable
                />
  )
}

export function Part4({ t, name, resource, setName }: { t: NonNullable<ResourceDialog['tr']>; name: NonNullable<ResourceDialog['name']>; resource: ResourceDialog['props']['resource']; setName: NonNullable<ResourceDialog['setName']> }) {
  return (
    <Input
                label={t('admin.res_resource_name')}
                value={name}
                required
                maxLength={45}
                autoFocus={!resource}
                onChange={e => setName(e.target.value)}
              />
  )
}

export function Part5({ t }: { t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.res_building')}<RequiredMark /></FieldLabel>
  )
}

export function Part6({ buildingId, setBuildingId, setFloor, buildingOptions, t }: { buildingId: NonNullable<ResourceDialog['buildingId']>; setBuildingId: NonNullable<ResourceDialog['setBuildingId']>; setFloor: NonNullable<ResourceDialog['setFloor']>; buildingOptions: NonNullable<ResourceDialog['buildingOptions']>; t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <Dropdown
                  value={buildingId}
                  onChange={v => { setBuildingId(v); setFloor('') }}
                  options={buildingOptions}
                  placeholder={t('admin.res_building_pick')}
                  width="100%"
                  height={36}
                  focusable
                />
  )
}

export function Part7({ t }: { t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.res_floor')}<RequiredMark /></FieldLabel>
  )
}

export function Part8({ floor, setFloor, floorOptions, t, building }: { floor: NonNullable<ResourceDialog['floor']>; setFloor: NonNullable<ResourceDialog['setFloor']>; floorOptions: NonNullable<ResourceDialog['floorOptions']>; t: NonNullable<ResourceDialog['tr']>; building: ResourceDialog['building'] }) {
  return (
    <Dropdown
                    value={floor}
                    onChange={setFloor}
                    options={floorOptions}
                    placeholder={t('admin.res_floor_pick')}
                    disabled={!building}
                    width="100%"
                    height={36}
                    focusable
                  />
  )
}

export function Part9({ t }: { t: NonNullable<ResourceDialog['tr']> }) {
  return (
    <FieldLabel>{t('admin.res_features')}</FieldLabel>
  )
}

export function Part10({ t, visible, setVisible }: { t: NonNullable<ResourceDialog['tr']>; visible: NonNullable<ResourceDialog['visible']>; setVisible: NonNullable<ResourceDialog['setVisible']> }) {
  return (
    <Textarea
                label={t('admin.res_visible_note')}
                value={visible}
                rows={2}
                className="h-20 min-h-20"
                maxLength={1000}
                onChange={e => setVisible(e.target.value)}
                hint={t('admin.res_visible_note_hint')}
              />
  )
}

export function Part11({ t, note, setNote }: { t: NonNullable<ResourceDialog['tr']>; note: NonNullable<ResourceDialog['note']>; setNote: NonNullable<ResourceDialog['setNote']> }) {
  return (
    <Textarea
                label={t('admin.res_admin_note')}
                value={note}
                rows={2}
                className="h-20 min-h-20"
                maxLength={1000}
                onChange={e => setNote(e.target.value)}
                hint={t('admin.res_admin_note_hint')}
              />
  )
}
