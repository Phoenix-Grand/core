/**
 * The parts of `BuildingDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input, Textarea } from "@ui"
import type { BuildingDialog } from './BuildingDialog'

export function Part1({ t, key, building, setKey }: { t: NonNullable<BuildingDialog['tr']>; key: NonNullable<BuildingDialog['key']>; building: BuildingDialog['props']['building']; setKey: NonNullable<BuildingDialog['setKey']> }) {
  return (
    <Input
                label={t('admin.res_building_key')}
                value={key}
                required
                maxLength={100}
                autoFocus={!building}
                onChange={e => setKey(e.target.value)}
                hint={t('admin.res_building_key_hint')}
              />
  )
}

export function Part2({ t, address, setAddress }: { t: NonNullable<BuildingDialog['tr']>; address: NonNullable<BuildingDialog['address']>; setAddress: NonNullable<BuildingDialog['setAddress']> }) {
  return (
    <Textarea
                label={t('admin.res_address')}
                value={address}
                required
                rows={2}
                className="h-20 min-h-20"
                maxLength={500}
                onChange={e => setAddress(e.target.value)}
              />
  )
}

export function Part3({ GeoPoint, lat, lon, address, busy, setLat, setLon }: { GeoPoint: NonNullable<BuildingDialog['GeoPoint']>; lat: NonNullable<BuildingDialog['lat']>; lon: NonNullable<BuildingDialog['lon']>; address: NonNullable<BuildingDialog['address']>; busy: NonNullable<BuildingDialog['busy']>; setLat: NonNullable<BuildingDialog['setLat']>; setLon: NonNullable<BuildingDialog['setLon']> }) {
  return (
    <GeoPoint
                  latitude={lat}
                  longitude={lon}
                  address={address}
                  disabled={busy}
                  onChange={(la, lo) => { setLat(la); setLon(lo) }}
                />
  )
}

export function Part4({ t, lat, setLat }: { t: NonNullable<BuildingDialog['tr']>; lat: NonNullable<BuildingDialog['lat']>; setLat: NonNullable<BuildingDialog['setLat']> }) {
  return (
    <Input
                    label={t('admin.res_latitude')}
                    value={lat}
                    inputMode="decimal"
                    onChange={e => setLat(e.target.value)}
                  />
  )
}

export function Part5({ t, lon, setLon }: { t: NonNullable<BuildingDialog['tr']>; lon: NonNullable<BuildingDialog['lon']>; setLon: NonNullable<BuildingDialog['setLon']> }) {
  return (
    <Input
                    label={t('admin.res_longitude')}
                    value={lon}
                    inputMode="decimal"
                    onChange={e => setLon(e.target.value)}
                  />
  )
}

export function Part6({ t, note, setNote }: { t: NonNullable<BuildingDialog['tr']>; note: NonNullable<BuildingDialog['note']>; setNote: NonNullable<BuildingDialog['setNote']> }) {
  return (
    <Textarea
                  label={t('admin.res_admin_note')}
                  value={note}
                  rows={2}
                  className="h-20 min-h-20"
                  maxLength={256}
                  onChange={e => setNote(e.target.value)}
                  hint={t('admin.res_admin_note_hint')}
                />
  )
}
